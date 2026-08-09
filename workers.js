export default {
  async fetch(request, env, ctx) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Max-Age': '86400',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const responseJson = (data, status = 200) => {
      return new Response(JSON.stringify(data), {
        status,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json; charset=utf-8',
        },
      });
    };

    try {
      if (request.method !== 'POST') {
        return responseJson({ message: 'Nutritional Cal API is running' }, 200);
      }

      let body;
      try {
        body = await request.json();
      } catch (e) {
        return responseJson({ error: '無効なJSONデータです。' }, 400);
      }

      const mode = body.mode || 'general';

      const today = new Date().toISOString().split('T')[0];
      const clientIp = request.headers.get('CF-Connecting-IP') || 'global';
      const kvKey = `quota_${today}_${clientIp}`;

      let currentCount = 0;
      let remaining = 20;

      if (env && env.LIMIT_KV && typeof env.LIMIT_KV.get === 'function') {
        try {
          const stored = await env.LIMIT_KV.get(kvKey);
          currentCount = stored ? parseInt(stored, 10) : 0;
          if (currentCount >= 20) {
            return responseJson({
              error: '本日の計算枠（20回）に達しました。明日またご利用ください。',
              remaining: 0
            }, 429);
          }
        } catch (kvErr) {
          console.error('KV Read Error:', kvErr);
        }
      }

      let resultData = {};

      if (mode === 'general') {
        const gender = Number(body.gender);
        const age = Number(body.age);
        const height = Number(body.height);
        const weight = Number(body.weight);
        const activity = Number(body.activity);
        const stress = Number(body.stress);

        const heightM = height / 100;
        const bmi = weight / (heightM * heightM);
        const isUnderweight = bmi < 20.0;

        const ibw = Math.pow(heightM, 2) * 22;
        const calcWeight = isUnderweight ? ibw : weight;

        const bmrFormula = 0.1238 + (0.0481 * calcWeight) + (0.0234 * height) - (0.0138 * age) - (0.5473 * gender);
        const bmr = Math.max(0, (bmrFormula * 1000) / 4.186);

        const energy = bmr * activity * stress;

        // 活動レベルの名称判定
        let activityName = "普通";
        if (activity <= 1.2) activityName = "寝たきり";
        else if (activity === 1.3) activityName = "低い";
        else if (activity >= 1.7) activityName = "高い";

        let proteinFactor = 1.1; 
        if (activity >= 1.7) proteinFactor = 1.5;  
        else if (activity <= 1.2) proteinFactor = 1.0;  

        let isProteinAdjusted = false;
        if (isUnderweight && proteinFactor < 1.2) {
          proteinFactor = 1.2;
          isProteinAdjusted = true;
        }

        const protein = calcWeight * proteinFactor;
        const waterFactor = age >= 65 ? 30 : 35;
        const water = calcWeight * waterFactor;

        // 根拠テキストの生成
        const reasonEnergy = `基礎代謝量(${Math.round(bmr)}kcal) × 活動係数(${activity}) × ストレス係数(${stress})`;
        
        let reasonProtein = "";
        if (isProteinAdjusted) {
          reasonProtein = `活動レベルは「${activityName}」ですが、BMI20未満の低栄養保護のため、基準体重1kgあたり${proteinFactor.toFixed(1)}gへ引き上げて算出しています。`;
        } else {
          reasonProtein = `活動レベル「${activityName}」のため、採用体重1kgあたり${proteinFactor.toFixed(1)}gで算出しています。`;
        }

        const reasonWater = `採用体重(${calcWeight.toFixed(1)}kg) × 年齢別基準(${waterFactor}ml/kg)`;

        resultData = {
          energy: Math.round(energy),
          protein: protein.toFixed(1),
          water: Math.round(water),
          reasonEnergy: reasonEnergy,
          reasonProtein: reasonProtein,
          reasonWater: reasonWater,
          bmrWarning: energy < (bmr * 0.9)
        };

      } else {
        // CKD モード
        const age = Number(body.age);
        const height = Number(body.height);
        const weight = Number(body.weight);
        const stage = Number(body.stage);
        const hasEdema = Boolean(body.hasEdema);
        const kcalPerKg = Number(body.kcalPerKg);
        const stress = Number(body.stress);

        const heightM = height / 100;
        const bmi = weight / (heightM * heightM);
        const ibw = Math.pow(heightM, 2) * 22;

        const isSenior = age >= 65;
        const minBmi = isSenior ? 21.5 : 20.0;
        const maxBmi = 24.9;
        const useIbw = (bmi < minBmi || bmi > maxBmi);
        const targetCalcWeight = useIbw ? ibw : weight;

        // ステージ名称の判定
        let stageName = "G1〜G2";
        if (stage === 2) stageName = "G3a";
        else if (stage === 3) stageName = "G3b〜G5";

        let pFactor = 1.0;
        let isProteinAdjusted = false;
        
        if (bmi < 18.0) { pFactor = 1.2; isProteinAdjusted = true; } 
        else if (bmi >= 18.0 && bmi < 19.0) { pFactor = 1.0; isProteinAdjusted = true; } 
        else if (bmi >= 19.0 && bmi < 20.0) { pFactor = 0.9; isProteinAdjusted = true; } 
        else {
          if (stage === 3) pFactor = 0.7;
          else if (stage === 2) pFactor = 0.9;
          else pFactor = 1.1;
        }

        const energy = targetCalcWeight * kcalPerKg * stress;
        const protein = targetCalcWeight * pFactor;

        let waterFactor = isSenior ? 30 : 35;
        let reasonWater = "";
        
        if (hasEdema) {
          waterFactor = 25;
          reasonWater = `採用体重(${targetCalcWeight.toFixed(1)}kg) × 浮腫制限(${waterFactor}ml/kg)`;
        } else {
          reasonWater = `採用体重(${targetCalcWeight.toFixed(1)}kg) × 年齢別基準(${waterFactor}ml/kg)`;
        }
        
        const water = targetCalcWeight * waterFactor;

        // 根拠テキストの生成
        const reasonEnergy = `採用体重(${targetCalcWeight.toFixed(1)}kg) × 指定カロリー(${kcalPerKg}kcal/kg) × ストレス係数(${stress})`;
        
        let reasonProtein = "";
        if (isProteinAdjusted) {
          reasonProtein = `CKD病期は「${stageName}」ですが、BMI20未満の低栄養リスクを考慮し、基準体重1kgあたり${pFactor.toFixed(1)}gへ係数を引き上げて保護しています。`;
        } else {
          reasonProtein = `CKD病期「${stageName}」の基準に基づき、採用体重1kgあたり${pFactor.toFixed(1)}gを上限に設定しています。`;
        }

        resultData = {
          ibwText: targetCalcWeight.toFixed(1),
          pFactorText: pFactor.toFixed(1),
          energy: Math.round(energy),
          protein: protein.toFixed(1),
          water: Math.round(water),
          reasonEnergy: reasonEnergy,
          reasonProtein: reasonProtein,
          reasonWater: reasonWater
        };
      }

      if (env && env.LIMIT_KV && typeof env.LIMIT_KV.put === 'function') {
        try {
          const newCount = currentCount + 1;
          await env.LIMIT_KV.put(kvKey, newCount.toString(), { expirationTtl: 86400 });
          remaining = Math.max(0, 20 - newCount);
        } catch (kvWriteErr) {
          console.error('KV Write Error:', kvWriteErr);
        }
      } else {
        remaining = Math.max(0, 20 - (currentCount + 1));
      }

      return responseJson({
        success: true,
        remaining: remaining,
        data: resultData
      });

    } catch (err) {
      return responseJson({
        error: `Worker内部エラー: ${err.message}`
      }, 500);
    }
  }
};
