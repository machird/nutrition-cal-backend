export default {
  async fetch(request, env, ctx) {
    // 1. 全すべての応答に付与する CORS ヘッダー
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
      'Access-Control-Max-Age': '86400',
    };

    // 2. プリフライト（OPTIONS）リクエストへの即時許可応答（204）
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
    }

    // 3. 安全な JSON 応答ヘッダー作成関数（エラー時も確実にCORSを維持）
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
        return sendJson({ error: 'Method not allowed' }, 405);
      }

      // 送信データの安全な読み込み
      let body;
      try {
        body = await request.json();
      } catch (e) {
        return sendJson({ error: 'リクエストデータ(JSON)の形式が正しくありません。' }, 400);
      }

      const mode = body.mode || 'general';

      // 4. 回数制限（KVが設定されていなくても絶対にエラーで落ちない安全設計）
      const today = new Date().toISOString().split('T')[0];
      const clientIp = request.headers.get('CF-Connecting-IP') || 'anonymous';
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

      // 5. 栄養計算ロジック
      let resultData = {};

      if (mode === 'general') {
        const gender = Number(body.gender);   // 1: 男性, 2: 女性
        const age = Number(body.age);
        const height = Number(body.height);
        const weight = Number(body.weight);
        const activity = Number(body.activity); // 1.2, 1.3, 1.5, 1.7 など
        const stress = Number(body.stress);

        const heightM = height / 100;
        const bmi = weight / (heightM * heightM);
        const isUnderweight = bmi < 20.0;

        // 基準体重 (IBW)
        const ibw = Math.pow(heightM, 2) * 22;
        // BMI < 20 の場合は IBW で計算、それ以外は現在体重を採用
        const calcWeight = isUnderweight ? ibw : weight;

        // Ganpule（厳プレ）式（2018年）基礎代謝量 (kcal/日)
        const bmrFormula = 0.1238 + (0.0481 * calcWeight) + (0.0234 * height) - (0.0138 * age) - (0.5473 * gender);
        const bmr = Math.max(0, (bmrFormula * 1000) / 4.186);

        // 総エネルギー消費量 (TEE)
        const energy = bmr * activity * stress;

        // 【ご指定のタンパク質必要量条件】
        // 1.5g / kg: 活動レベル「高い（1.7以上）」
        // 1.1g / kg: 活動レベル「低い〜普通（1.2超 〜 1.7未満）」
        // 1.0g / kg: 活動レベル「寝たきり（1.2以下）」
        let proteinFactor = 1.1;
        if (activity >= 1.7) {
          proteinFactor = 1.5;
        } else if (activity <= 1.2) {
          proteinFactor = 1.0;
        }

        // 一般モードでも BMI < 20 に関しては自動調整（低栄養保護のため最低 1.2g/kg IBW 以上）
        if (isUnderweight) {
          proteinFactor = Math.max(proteinFactor, 1.2);
        }

        const protein = calcWeight * proteinFactor;

        // 必要水分量目安 (65歳以上: 30ml/kg, 65歳未満: 35ml/kg)
        const waterFactor = age >= 65 ? 30 : 35;
        const water = calcWeight * waterFactor;

        let waterNote = `※年齢(${age}歳)に応じた標準水分補給目安です。`;
        if (isUnderweight) {
          waterNote += ` (BMI ${bmi.toFixed(1)}: 低栄養保護のため基準体重${ibw.toFixed(1)}kg・タンパク質${proteinFactor}g/kgで算出)`;
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
        const gender = body.gender;
        const age = Number(body.age);
        const height = Number(body.height);
        const weight = Number(body.weight);
        const stage = Number(body.stage); // 1: G1-G2, 2: G3a, 3: G3b-G5
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

        // CKD タンパク質指定係数の自動調整 (BMI < 20 優先)
        let pFactor = 1.0;
        if (bmi < 18.0) {
          pFactor = 1.2;
        } else if (bmi >= 18.0 && bmi < 19.0) {
          pFactor = 1.0;
        } else if (bmi >= 19.0 && bmi < 20.0) {
          pFactor = 0.9;
        } else {
          if (stage === 3) pFactor = 0.7;
          else if (stage === 2) pFactor = 0.9;
          else pFactor = 1.1;
        }

        const energy = targetCalcWeight * kcalPerKg * stress;
        const protein = targetCalcWeight * pFactor;

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

      // KV への回数保存
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
      // どのような内部エラーが起きてもCORSヘッダーを維持してエラー内容をJSONで返す
      return sendJson({
        error: `Worker内部処理エラー: ${globalErr.message}`
      }, 500);
    }
  }
};
