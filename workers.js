// 全オリジン許可 CORS ヘッダーの定義
const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export default {
    async fetch(request, env, ctx) {
        // 1. プリフライト（OPTIONS）リクエストへの即時応答 (ステータス 204)
        if (request.method === 'OPTIONS') {
            return new Response(null, {
                status: 204,
                headers: corsHeaders
            });
        }

        // POST 以外のメソッドは 405 エラー
        if (request.method !== 'POST') {
            return new Response(JSON.stringify({ error: 'Method Not Allowed' }), {
                status: 405,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }

        try {
            // 2. アクセス回数制限（IP × 日本時間日付で1日20回制限）
            const clientIP = request.headers.get('CF-Connecting-IP') || '127.0.0.1';
            const now = new Date();
            const jstOffset = 9 * 60 * 60 * 1000;
            const jstDate = new Date(now.getTime() + jstOffset);
            const todayStr = jstDate.toISOString().split('T')[0];
            
            const kvKey = `limit:${clientIP}:${todayStr}`;

            let currentCount = 0;
            if (env.LIMIT_KV) {
                const storedValue = await env.LIMIT_KV.get(kvKey);
                currentCount = storedValue ? parseInt(storedValue, 10) : 0;
            }

            const MAX_DAILY_LIMIT = 20;
            if (currentCount >= MAX_DAILY_LIMIT) {
                return new Response(JSON.stringify({
                    error: '本日（24時間以内）の計算枠上限（20回）に達しました。明日またご利用ください。',
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

            // KV カウントインクリメント
            const newCount = currentCount + 1;
            if (env.LIMIT_KV) {
                await env.LIMIT_KV.put(kvKey, newCount.toString(), { expirationTtl: 86400 });
            }

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
            return new Response(JSON.stringify({ error: `計算処理中にエラーが発生しました: ${err.message}` }), {
                status: 500,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }
    }
};

/**
 * 一般・リハビリモードの目標栄養素計算
 */
function calculateGeneral(data) {
    const { gender, age, height, weight, targetWeight, months, activity, stress } = data;
    
    const heightM = height / 100;
    const bmi = weight / (heightM * heightM);
    const ibw = heightM * heightM * 22;

    const finalTargetWeight = targetWeight || weight;
    const finalMonths = months || 3;

    // 基礎代謝量 (Ganpule 2018 厳プレ式)
    // BMR (kcal/日) = (0.1238 + 0.0481*W + 0.0234*H - 0.0138*A - 0.5473*G) * 1000 / 4.186
    const bmr = ((0.1238 + 0.0481 * weight + 0.0234 * height - 0.0138 * age - 0.5473 * gender) * 1000) / 4.186;
    const tee = bmr * activity * stress;

    // 目標体重調整（1kg = 7200kcal換算）
    const totalAdjustKcal = (finalTargetWeight - weight) * 7200;
    const dailyAdjustKcal = totalAdjustKcal / (finalMonths * 30);
    const goalEnergy = tee + dailyAdjustKcal;

    // タンパク質必要量規定
    // 1.5g / kg: 活動レベル「高い（1.7以上）」
    // 1.1g / kg: 活動レベル「低い〜普通（1.2超 〜 1.7未満）」
    // 1.0g / kg: 活動レベル「寝たきり（1.2以下）」
    let pFactor = 1.1;
    if (activity >= 1.7) {
        pFactor = 1.5;
    } else if (activity <= 1.2) {
        pFactor = 1.0;
    } else {
        pFactor = 1.1;
    }

    // 一般モードでの BMI < 20 未満の自動補正（低栄養・フレイル保護）
    let proteinNote = "";
    let baseWeightForProtein = weight;

    if (bmi < 18.0) {
        pFactor = Math.max(pFactor, 1.2); // 低栄養防止のため1.2g/kg以上に引き上げ
        baseWeightForProtein = ibw; // 標準体重ベースに補正
        proteinNote = ` (※BMI ${bmi.toFixed(1)}: 低体重保護で1.2g/kg IBW適用)`;
    } else if (bmi < 20.0) {
        baseWeightForProtein = ibw; // 低栄養リスクを考慮し基準体重(IBW)採用
        proteinNote = ` (※BMI ${bmi.toFixed(1)}: 低栄養リスク防止のため基準体重IBW適用)`;
    }

    const protein = baseWeightForProtein * pFactor;

    // 水分量（高齢者:30ml/kg, 成人:35ml/kg）
    const waterFactor = age >= 65 ? 30 : 35;
    const water = weight * waterFactor;
    let waterNote = age >= 65 
        ? "💡 高齢者基準（30 ml/kg/日）で算定しています。" 
        : "💡 成人基準（35 ml/kg/日）で算定しています。";

    if (bmi < 20.0) {
        waterNote += proteinNote;
    }

    return {
        energy: Math.round(goalEnergy),
        protein: (Math.round(protein * 10) / 10).toFixed(1),
        water: Math.round(water),
        waterNote: waterNote,
        bmrWarning: goalEnergy < bmr * 0.9
    };
}

/**
 * CKD（慢性腎臓病）モードの目標栄養素計算
 */
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

    // BMI 20未満（低体重・フレイルリスク）の優先自動補正
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
        // BMI 20以上は病期（ステージ）に応じた標準制限
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

    const goalEnergy = ibw * kcalPerKg * stress;
    const goalProtein = ibw * pFactor;

    // 水分計算
    let waterFactor = 35;
    let waterNote = "";

    if (hasEdema) {
        waterFactor = 25;
        waterNote = "⚠️ 浮腫（むくみ）・心負荷があるため、制限基準（25 ml/kg）で算出しています。";
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
