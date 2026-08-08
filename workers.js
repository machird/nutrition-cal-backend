export default {
  async fetch(request, env, ctx) {
    // 1. 共通 CORS ヘッダーの定義
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
    };

    // 2. プリフライト（OPTIONS）リクエストへの即時応答
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
    }

    // 3. すべての処理を try-catch で囲み、エラー時も確実に CORS ヘッダーを返却
    try {
      if (request.method !== 'POST') {
        return new Response(JSON.stringify({ error: 'Method not allowed' }), {
          status: 405,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // JSON パースの安全処理
      let body;
      try {
        body = await request.json();
      } catch (e) {
        return new Response(JSON.stringify({ error: 'リクエストデータ(JSON)が不正です。' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const mode = body.mode;

      // 4. KVによる回数制限管理 (env.LIMIT_KV が未バインドでもクラッシュさせない安全設計)
      const today = new Date().toISOString().split('T')[0];
      const clientIp = request.headers.get('CF-Connecting-IP') || 'global';
      const kvKey = `quota_${today}_${clientIp}`;
      
      let currentCount = 0;
      let remaining = 20;

      if (env && env.LIMIT_KV) {
        try {
          const val = await env.LIMIT_KV.get(kvKey);
          currentCount = val ? parseInt(val, 10) : 0;
          
          if (currentCount >= 20) {
            return new Response(JSON.stringify({
              error: '本日の計算上限（20回）に達しました。明日またご利用ください。',
              remaining: 0
            }), {
              status: 429,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }
        } catch (kvErr) {
          console.error('KV Read Error:', kvErr);
        }
      }

      // 5. 栄養計算ロジック
      let resultData = {};

      if (mode === 'general') {
        const { weight, height, age, gender, activity, stress } = body;
        
        // BMI計算と20未満の判定
        const heightM = height / 100;
        const bmi = weight / (heightM * heightM);
        const isUnderweight = bmi < 20.0;
        
        // 基準体重（IBW） calculation if BMI < 20
        const ibw = Math.pow(heightM, 2) * 22;
        const calcWeight = isUnderweight ? ibw : weight;

        // Ganpule（厳プレ）式（2018年）基礎代謝量計算
        const bmrFormula = 0.1238 + (0.0481 * calcWeight) + (0.0234 * height) - (0.0138 * age) - (0.5473 * gender);
        const bmr = Math.max(0, (bmrFormula * 1000) / 4.186);

        // 総エネルギー（TEE）
        const energy = bmr * activity * stress;

        // タンパク質目標量 (指定条件に従った分岐)
        let proteinFactor = 1.1; // 低い〜普通 (1.2超 〜 1.7未満)
        if (activity >= 1.7) {
          proteinFactor = 1.5;  // 高い (1.7以上)
        } else if (activity <= 1.2) {
          proteinFactor = 1.0;  // 寝たきり (1.2以下)
        }

        // BMI 20未満の場合は低栄養保護のためタンパク質1.2g/kg(IBW)以上に自動調整
        if (isUnderweight) {
          proteinFactor = Math.max(proteinFactor, 1.2);
        }

        const protein = calcWeight * proteinFactor;

        // 水分補給目安 (65歳以上: 30ml/kg, 65歳未満: 35ml/kg)
        const waterFactor = age >= 65 ? 30 : 35;
        const water = calcWeight * waterFactor;

        // メモ書き作成
        let waterNote = `※年齢(${age}歳)に応じた標準水分補給目安です。`;
        if (isUnderweight) {
          waterNote += ` (BMI ${bmi.toFixed(1)}: 低栄養保護のため基準体重${ibw.toFixed(1)}kgで算定)`;
        }

        resultData = {
          energy: Math.round(energy),
          protein: protein.toFixed(1),
          water: Math.round(water),
          waterNote: waterNote,
          bmrWarning: energy < (bmr * 0.9)
        };

      } else {
        // CKD (慢性腎臓病) モード
        const { weight, height, age, stage, hasEdema, kcalPerKg, stress } = body;
        
        const heightM = height / 100;
        const bmi = weight / (heightM * heightM);
        const ibw = Math.pow(heightM, 2) * 22;

        // 適正BMI範囲判定
        const isSenior = age >= 65;
        const minBmi = isSenior ? 21.5 : 20.0;
        const maxBmi = 24.9;
        
        // BMI適正範囲外の場合はIBW、適正内は現在体重採用
        const useIbw = (bmi < minBmi || bmi > maxBmi);
        const targetCalcWeight = useIbw ? ibw : weight;

        // CKD タンパク質指定係数の決定 (BMI < 20 自動調整優先)
        let pFactor = 1.0;
        if (bmi < 18.0) {
          pFactor = 1.2;
        } else if (bmi >= 18.0 && bmi < 19.0) {
          pFactor = 1.0;
        } else if (bmi >= 19.0 && bmi < 20.0) {
          pFactor = 0.9;
        } else {
          // BMI 20以上は病期（ステージ）依存
          if (stage === 3) pFactor = 0.7;      // G3b 〜 G5
          else if (stage === 2) pFactor = 0.9; // G3a
          else pFactor = 1.1;                  // G1 〜 G2
        }

        const energy = targetCalcWeight * kcalPerKg * stress;
        const protein = targetCalcWeight * pFactor;

        // 水分算出 (高度浮腫・心負荷あり: 25ml/kg IBW, なし: 年齢別標準)
        let waterFactor = isSenior ? 30 : 35;
        if (hasEdema) {
          waterFactor = 25;
        }
        const water = targetCalcWeight * waterFactor;

        let waterNote = hasEdema 
          ? "※高度浮腫・心負荷考慮の制限適用（25ml/kg）" 
          : "※CKD標準水分目安（過度な脱水防止）";

        resultData = {
          ibwText: targetCalcWeight.toFixed(1),
          pFactorText: pFactor.toFixed(1),
          energy: Math.round(energy),
          protein: protein.toFixed(1),
          water: Math.round(water),
          waterNote: waterNote
        };
      }

      // 6. カウントインクリメント処理
      if (env && env.LIMIT_KV) {
        try {
          const newCount = currentCount + 1;
          await env.LIMIT_KV.put(kvKey, newCount.toString(), {
            expirationTtl: 86400 // 24時間で自動消去
          });
          remaining = Math.max(0, 20 - newCount);
        } catch (kvErr) {
          console.error('KV Write Error:', kvErr);
        }
      } else {
        remaining = Math.max(0, 20 - (currentCount + 1));
      }

      // 7. 正常レスポンス (必ず CORS ヘッダーを付与)
      return new Response(JSON.stringify({
        success: true,
        remaining: remaining,
        data: resultData
      }), {
        status: 200,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
        },
      });

    } catch (err) {
      // 8. 予期せぬエラー発生時でも CORS ヘッダーを付けて JSON 応答を返す
      return new Response(JSON.stringify({ 
        error: `Worker内部エラー: ${err.message}` 
      }), {
        status: 500,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
        },
      });
    }
  }
};
