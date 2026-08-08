export default {
  async fetch(request, env, ctx) {
    // 1. ブラウザからのCORS制限を解除するヘッダー設定
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    // 2. ブラウザの事前確認（Preflight / OPTIONSリクエスト）への即時応答
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
    }

    try {
      if (request.method !== 'POST') {
        return new Response(JSON.stringify({ error: 'Method not allowed' }), {
          status: 405,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const body = await request.json();
      const mode = body.mode;

      let resultData = {};

      if (mode === 'general') {
        const { weight, height, age, gender, activity, stress } = body;
        let bmrFormula = 0.1238 + (0.0481 * weight) + (0.0234 * height) - (0.0138 * age) - (0.5473 * gender);
        let bmr = Math.max(0, (bmrFormula * 1000) / 4.186);
        let energy = bmr * activity * stress;
        let protein = weight * (activity >= 1.5 ? 1.5 : 1.2);
        let water = weight * (age >= 75 ? 25 : (age >= 65 ? 30 : 35));

        resultData = {
          energy: Math.round(energy),
          protein: protein.toFixed(1),
          water: Math.round(water),
          waterNote: `※年齢(${age}歳)に応じた標準水分補給目安です。`,
          bmrWarning: energy < bmr
        };
      } else {
        const { weight, height, stage, hasEdema, kcalPerKg, stress } = body;
        let ibw = Math.pow(height / 100, 2) * 22;
        let energy = ibw * kcalPerKg * stress;
        let pFactor = stage === 3 ? 0.7 : (stage === 2 ? 0.8 : 1.0);
        let protein = ibw * pFactor;
        let water = hasEdema ? ibw * 20 : ibw * 25;

        resultData = {
          ibwText: ibw.toFixed(1),
          pFactorText: pFactor,
          energy: Math.round(energy),
          protein: protein.toFixed(1),
          water: Math.round(water),
          waterNote: hasEdema ? "※高度浮腫考慮の水分制限適用中" : "※CKD標準水分目安です"
        };
      }

      // 3. CORSヘッダーを付けてレスポンス（残り回数 19, 18 ... を返却）
      return new Response(JSON.stringify({
        success: true,
        remaining: 18, // ※KV等で回数管理している場合はその変数を指定
        data: resultData
      }), {
        status: 200,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
        },
      });

    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
        },
      });
    }
  },
};
