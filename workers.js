export default {
  async fetch(request, env) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      const clientIP = request.headers.get('CF-Connecting-IP') || 'anonymous';
      const today = new Date().toISOString().split('T')[0];
      const kvKey = `quota:${clientIP}:${today}`;

      // KVから現在の実行回数を取得
      let currentCount = 0;
      if (env.NUTRITION_KV) {
        const val = await env.NUTRITION_KV.get(kvKey);
        currentCount = parseInt(val || '0', 10);
      }

      // POST（計算実行）の処理
      if (request.method === 'POST') {
        if (currentCount >= 20) {
          return new Response(JSON.stringify({ 
            error: '本日の計算上限（20回）に達しました。明日再度お試しください。',
            remaining: 0 
          }), {
            status: 429,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        currentCount += 1;
        if (env.NUTRITION_KV) {
          await env.NUTRITION_KV.put(kvKey, currentCount.toString(), { expirationTtl: 86400 });
        }
      }

      const remaining = Math.max(0, 20 - currentCount);

      return new Response(JSON.stringify({ remaining }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });

    } catch (err) {
      // 予期せぬエラー時も落ちずにレスポンスを返す安全装置
      return new Response(JSON.stringify({ remaining: 20, error: err.message }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
  }
};
