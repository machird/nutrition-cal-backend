export default {
  async fetch(request, env, ctx) {
    // 1. すべての応答に付与する CORS ヘッダー
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

    // 3. 安全な JSON 応答ヘッダー作成関数
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

      let body;
      try {
        body = await request.json();
      } catch (e) {
        return sendJson({ error: 'リクエストデータ(JSON)の形式が正しくありません。' }, 400);
      }

      const mode = body.mode || 'general';

      // 4. 回数制限（安全設計）
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

      // 5. 栄養計算ロジック（★フロントエンドの最新ルールと完全同期）
      let resultData = {};

      // 共通計算（BMI, 基準体重, 肥満補正）
      const gender = Number(body.gender);
      const age = Number(body.age);
      const height = Number(body.height);
      const weight = Number(body.weight);
      
      const heightM = height / 100;
      const bmi = weight / (heightM * heightM);
      const ibw = heightM * heightM * 22; // 基準体重(BMI22)

      // 年齢による低栄養判定基準 (70歳以上はBMI20未満、未満は18.5未満)
      let yaseThreshold = age >= 70 ? 20.0 : 18.5;
      let isYase = bmi < yaseThreshold;

      // 肥満補正による計算用体重の決定
      let calcWeight = weight;
      if (bmi >= 30.0) {
        calcWeight = ibw + 0.25 * (weight - ibw); // 補正体重
      } else if (bmi >= 25.0) {
        calcWeight = ibw; // BMI25～29.9は標準体重
      }

      // 基礎代謝量計算 (Ganpule式)
      let bmrFormula = 0;
      if (gender === 1) { // 男性
        bmrFormula = (0.0481 * calcWeight) + (0.0234 * height) - (0.0138 * age) - 0.4235;
      } else { // 女性
        bmrFormula = (0.0357 * calcWeight) + (0.0225 * height) - (0.0138 * age) - 0.3933;
      }
      const bmr = Math.round((bmrFormula * 1000) / 4.184);


      if (mode === 'general') {
        const activity = Number(body.activity);
        const stress = Number(body.stress);
        const targetWeight = body.targetWeight ? Number(body.targetWeight) : null;
        const months = body.months ? Number(body.months) : 3;

        // エネルギー計算
        let energy = bmr * activity * stress;
        if (targetWeight && targetWeight !== weight) {
          const dailyAdjust = Math.round(((targetWeight - weight) * 7200) / (months * 30));
          energy += dailyAdjust;
        }

        // タンパク質係数
        let pFactor = 1.0;
        if (activity >= 1.7) pFactor = 1.5;
        else if (activity >= 1.3) pFactor = 1.1;

        // 低栄養保護引き上げ
        if (isYase && pFactor < 1.2) {
          pFactor = 1.2;
        }
        const protein = calcWeight * pFactor;

        // 水分量
        const waterFactor = age >= 75 ? 25 : (age >= 65 ? 30 : 35);
        const water = Math.round(weight * waterFactor); // 水分量は現体重ベース

        resultData = {
          energy: Math.round(energy),
          protein: protein.toFixed(1),
          water: water,
          bmrWarning: energy < bmr
        };

      } else { // CKD (慢性腎臓病) モード
        const stage = Number(body.stage); // 1: G1-G2, 2: G3a, 3: G3b-G5
        const hasEdema = Boolean(body.hasEdema);
        const kcalPerKg = Number(body.kcalPerKg);
        const stress = Number(body.stress);

        const energy = Math.round(calcWeight * kcalPerKg * stress);

        // CKDタンパク質係数（通常時と低栄養時）
        let pFactor = stage === 3 ? 0.7 : (stage === 2 ? 0.9 : 1.0);
        if (isYase) {
          if (stage === 3) pFactor = 0.9;
          else if (stage === 2) pFactor = 1.0;
          else pFactor = 1.2;
        }
        const protein = calcWeight * pFactor;

        // 水分量（高度浮腫時は現体重×20、それ以外は現体重×25）
        const water = Math.round(hasEdema ? weight * 20 : weight * 25);

        resultData = {
          energy: energy,
          protein: protein.toFixed(1),
          water: water
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
      return sendJson({
        error: `Worker内部処理エラー: ${globalErr.message}`
      }, 500);
    }
  }
};
