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

    // IPアドレスと本日の日付でキーを作成
    const clientIP = request.headers.get('CF-Connecting-IP') || 'anonymous';
    const today = new Date().toISOString().split('T')[0];
    const kvKey = `quota:${clientIP}:${today}`;

    // KVから現在の実行回数を取得
    let currentCount = parseInt(await env.NUTRITION_KV.get(kvKey) || '0', 10);

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

      // カウントを1増やしてKVに保存（有効期限24時間）
      currentCount += 1;
      await env.NUTRITION_KV.put(kvKey, currentCount.toString(), { expirationTtl: 86400 });
    }

    // 残り回数を計算して返却
    const remaining = Math.max(0, 20 - currentCount);

    return new Response(JSON.stringify({ remaining }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
};
