// CORSヘッダー定義（Pagesドメインからの通信を許可）
const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
    async fetch(request, env) {
        // Preflight (OPTIONS) リクエストへの対応
        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: corsHeaders });
        }

        // POST以外のメソッドは拒否
        if (request.method !== 'POST') {
            return new Response(JSON.stringify({ error: 'Method Not Allowed' }), {
                status: 405,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }

        try {
            // クライアントのIPアドレスを取得（Cloudflareが自動付与）
            const clientIP = request.headers.get('CF-Connecting-IP') || '127.0.0.1';
            
            // 日本時間の今日の日付文字列を作成 (YYYY-MM-DD)
            const now = new Date();
            const jstOffset = 9 * 60 * 60 * 1000;
            const jstDate = new Date(now.getTime() + jstOffset);
            const todayStr = jstDate.toISOString().split('T')[0];
            
            // KVデータベース用のキーを作成
            const kvKey = `limit:${clientIP}:${todayStr}`;

            // Workers KVから本日の利用回数を取得
            let currentCount = 0;
            if (env.LIMIT_KV) {
                const storedValue = await env.LIMIT_KV.get(kvKey);
                currentCount = storedValue ? parseInt(storedValue, 10) : 0;
            }

            // 1日20回を超えているか判定
            const MAX_DAILY_LIMIT = 20;
            if (currentCount >= MAX_DAILY_LIMIT) {
                return new Response(JSON.stringify({
                    error: '本日（24時間以内）の計算上限（20回）に達しました。明日またご利用ください。',
                    remaining: 0
                }), {
                    status: 429,
                    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
                });
            }

            const data = await request.json();
            const { mode } = data;
            let result = {};

            if (mode === 'general') {
                result = calculateGeneral(data);
            } else if (mode === 'ckd') {
                result = calculateCKD(data);
            } else {
                return new Response(JSON.stringify({ error: '無効な計算モードです。' }), {
                    status: 400,
                    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
                });
            }

            // 利用回数を＋1してKVに保存（有効期限24時間 = 86400秒）
            const newCount = currentCount + 1;
            if (env.LIMIT_KV) {
                await env.LIMIT_KV.put(kvKey, newCount.toString(), { expirationTtl: 86400 });
            }

            // 残り計算可能回数
            const remaining = Math.max(0, MAX_DAILY_LIMIT - newCount);

            return new Response(JSON.stringify({
                success: true,
                data: result,
                remaining: remaining
            }), {
                status: 200,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });

        } catch (err) {
            return new Response(JSON.stringify({ error: '計算処理中にエラーが発生しました。' }), {
                status: 500,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }
    }
};

function calculateGeneral(data) {
    const { gender, age, height, weight, targetWeight, months, activity, stress } = data;
    const finalTargetWeight = targetWeight || weight;
    const finalMonths = months || 3;

    // BMR (Ganpule 2018)
    const bmr = ((0.1238 + 0.0481 * weight + 0.0234 * height - 0.0138 * age - 0.5473 * gender) * 1000) / 4.186;
    const tee = bmr * activity * stress;

    // 体重調整 (7,200 kcal/kg)
    const totalAdjustKcal = (finalTargetWeight - weight) * 7200;
    const dailyAdjustKcal = totalAdjustKcal / (finalMonths * 30);
    const goalEnergy = tee + dailyAdjustKcal;

    // タンパク質計算
    const pFactor = (activity <= 1.2) ? 1.0 : (activity >= 1.7 ? 1.5 : 1.1);
    const protein = weight * pFactor;

    // 必要水分量と注意書き（Worker側で計算）
    const waterFactor = age >= 65 ? 30 : 35;
    const water = weight * waterFactor;
    const waterNote = age >= 65 
        ? "💡 高齢者基準（30 ml/kg/日）で算定しています。" 
        : "💡 成人基準（35 ml/kg/日）で算定しています。";

    return {
        energy: Math.round(goalEnergy),
        protein: (Math.round(protein * 10) / 10).toFixed(1),
        water: Math.round(water),
        waterNote: waterNote,
        bmrWarning: goalEnergy < bmr * 0.9
    };
}

function calculateCKD(data) {
    const { gender, age, height, weight, stage, kcalPerKg, hasEdema, stress = 1.0 } = data;

    const heightM = height / 100;
    const currentBmi = weight / (heightM * heightM);
    const bmiLower = (age >= 65) ? 21.5 : 20.0;
    const bmiUpper = 24.9;

    let ibw = weight;
    let ibwNote = "";

    if (currentBmi >= bmiLower && currentBmi <= bmiUpper) {
        ibw = weight;
        ibwNote = `現在体重を採用 (BMI ${currentBmi.toFixed(1)}: 適正範囲内)`;
    } else {
        ibw = heightM * heightM * 22;
        ibwNote = `標準体重 BMI 22 を採用 (現在BMI ${currentBmi.toFixed(1)}: 補正)`;
    }

    let pFactor = 0.7;
    let stageLabel = "";

    // BMIに応じたタンパク質指定係数の優先判定
    if (currentBmi < 18.0) {
        pFactor = 1.2;
        stageLabel = `低体重補正 (BMI ${currentBmi.toFixed(1)} < 18: 1.2g/kg)`;
    } else if (currentBmi >= 18.0 && currentBmi < 19.0) {
        pFactor = 1.0;
        stageLabel = `低体重補正 (BMI ${currentBmi.toFixed(1)}: 1.0g/kg)`;
    } else if (currentBmi >= 19.0 && currentBmi < 20.0) {
        pFactor = 0.9;
        stageLabel = `低体重補正 (BMI ${currentBmi.toFixed(1)}: 0.9g/kg)`;
    } else {
        // BMI 20以上は病期（ステージ）に応じた標準制限を適用
        if (stage === 3) {
            pFactor = 0.7;
            stageLabel = "G3b-G5 [標準: 0.7g/kg]";
        } else if (stage === 2) {
            pFactor = 0.9;
            stageLabel = "G3a [標準: 0.9g/kg]";
        } else if (stage === 1) {
            pFactor = 1.1;
            stageLabel = "G1-G2 [制限: 1.1g/kg]";
        }
    }

    // 目標エネルギー計算にストレス係数を掛け合わせる
    const goalEnergy = ibw * kcalPerKg * stress;
    const goalProtein = ibw * pFactor;

    // 水分計算
    let waterFactor = 35;
    let waterNote = "";

    if (hasEdema) {
        waterFactor = 25;
        waterNote = "⚠️ 浮腫（むくみ）・心不全傾向があるため、制限基準（25 ml/kg）で算出しています。";
    } else {
        waterFactor = age >= 65 ? 30 : 35;
        waterNote = age >= 65 
            ? "💡 高齢者基準（30 ml/kg/日）で算定しています。 ※保存期CKDでは脱水（腎機能悪化）防止のため原則過度な制限は行いません。" 
            : "💡 成人基準（35 ml/kg/日）で算定しています。 ※保存期CKDでは脱水（腎機能悪化）防止のため原則過度な制限は行いません。";
    }
    
    const goalWater = weight * waterFactor; 

    return {
        ibwText: `${(Math.round(ibw * 10) / 10).toFixed(1)} (${ibwNote})`,
        pFactorText: `${pFactor} (${stageLabel})`,
        energy: Math.round(goalEnergy),
        protein: (Math.round(goalProtein * 10) / 10).toFixed(1),
        water: Math.round(goalWater),
        waterNote: waterNote
    };
}
