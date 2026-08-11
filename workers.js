export default {
  async fetch(request, env, ctx) {
    // 1. CORSヘッダー定義
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Max-Age': '86400',
    };

    // 2. ブラウザからの事前確認（OPTIONS）にヘッダー付きで即答
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
    }

    const sendJson = (data, status = 200) => {
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
        return sendJson({ message: 'Nutritional Cal API is running' }, 200);
      }

      let body;
      try {
        body = await request.json();
      } catch (e) {
        return sendJson({ error: '無効なJSONです。' }, 400);
      }

      const mode = body.mode || 'general';

      // 3. 回数制限（KV）処理
      const today = new Date().toISOString().split('T')[0];
      const clientIp = request.headers.get('cf-connecting-ip') || 'anonymous';
      const kvKey = `quota_${today}_${clientIp}`;

      let currentCount = 0;
      let remaining = 20;

      if (env && env.LIMIT_KV && typeof env.LIMIT_KV.get === 'function') {
        try {
          const stored = await env.LIMIT_KV.get(kvKey);
          currentCount = stored ? parseInt(stored, 10) : 0;
          if (currentCount >= 20) {
            return sendJson({
              error: '本日の計算枠（20回）に達しました。明日またご利用ください。',
              remaining: 0
            }, 429);
          }
        } catch (kvError) {
          console.error('KV Read error:', kvError);
        }
      }

      // 4. 計算ロジック
      let resultData = {};
      const gender = Number(body.gender);
      const age = Number(body.age);
      const height = Number(body.height);
      const weight = Number(body.weight);
      
      const heightM = height / 100;
      const bmi = weight / (heightM * heightM);
      const ibw = heightM * heightM * 22;

      let yaseThreshold = age >= 70 ? 20.0 : 18.5;
      let isYase = bmi < yaseThreshold;

      let calcWeight = weight;
      if (bmi >= 30.0) {
        calcWeight = ibw + 0.25 * (weight - ibw);
      } else if (bmi >= 25.0) {
        calcWeight = ibw;
      }

      let bmrFormula = 0;
      if (gender === 1) {
        bmrFormula = (0.0481 * calcWeight) + (0.0234 * height) - (0.0138 * age) - 0.4235;
      } else {
        bmrFormula = (0.0357 * calcWeight) + (0.0225 * height) - (0.0138 * age) - 0.3933;
      }
      const bmr = Math.round((bmrFormula * 1000) / 4.184);

      if (mode === 'general') {
        const activity = Number(body.activity);
        const stress = Number(body.stress);
        const targetWeight = body.targetWeight ? Number(body.targetWeight) : null;
        const months = body.months ? Number(body.months) : 3;

        let energy = bmr * activity * stress;
        if (targetWeight && targetWeight !== weight) {
          const dailyAdjust = Math.round(((targetWeight - weight) * 7200) / (months * 30));
          energy += dailyAdjust;
        }

        let pFactor = 1.0;
        if (activity >= 1.7) pFactor = 1.5;
        else if (activity >= 1.3) pFactor = 1.1;

        if (isYase && pFactor < 1.2) {
          pFactor = 1.2;
        }
        const protein = calcWeight * pFactor;
        const waterFactor = age >= 75 ? 25 : (age >= 65 ? 30 : 35);
        const water = Math.round(weight * waterFactor);

        resultData = {
          energy: Math.round(energy),
          protein: protein.toFixed(1),
          water: water,
          bmrWarning: energy < bmr
        };

      } else {
        const stage = Number(body.stage);
        const hasEdema = Boolean(body.hasEdema);
        const kcalPerKg = Number(body.kcalPerKg);
        const stress = Number(body.stress);

        const energy = Math.round(calcWeight * kcalPerKg * stress);

        let pFactor = stage === 3 ? 0.7 : (stage === 2 ? 0.9 : 1.0);
        if (isYase) {
          if (stage === 3) pFactor = 0.9;
          else if (stage === 2) pFactor = 1.0;
          else pFactor = 1.2;
        }
        const protein = calcWeight * pFactor;
        const water = Math.round(hasEdema ? weight * 20 : weight * 25);

        resultData = {
          energy: energy,
          protein: protein.toFixed(1),
          water: water
        };
      }

      // 5. カウント保存 (KV)
      if (env && env.LIMIT_KV && typeof env.LIMIT_KV.put === 'function') {
        try {
          const newCount = currentCount + 1;
          await env.LIMIT_KV.put(kvKey, newCount.toString(), { expirationTtl: 86400 });
          remaining = Math.max(0, 20 - newCount);
        } catch (kvWriteErr) {
          console.error('KV Write error:', kvWriteErr);
        }
      } else {
        remaining = Math.max(0, 20 - (currentCount + 1));
      }

      return sendJson({
        success: true,
        remaining: remaining,
        data: resultData
      });

    } catch (globalErr) {
      return sendJson({
        error: `Worker内部エラー: ${globalErr.message}`
      }, 500);
    }
  }
};
