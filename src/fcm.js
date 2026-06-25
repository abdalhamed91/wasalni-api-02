// ============================================================
// إرسال إشعارات الجهاز مباشرةً عبر FCM HTTP v1 (بلا مكتبات خارجية)
// يحتاج متغيّر البيئة FCM_SERVICE_ACCOUNT = محتوى ملف حساب الخدمة (JSON).
// يُولّده المالك من: Firebase Console ← Project settings ← Service accounts ← Generate new private key
// ============================================================
const crypto = require('crypto');

let sa = null;            // حساب الخدمة المُحلّل
try {
  const raw = process.env.FCM_SERVICE_ACCOUNT;
  if (raw) sa = JSON.parse(raw);
} catch (e) { console.error('FCM: تعذّر تحليل FCM_SERVICE_ACCOUNT:', e.message); }

const fcmEnabled = () => !!(sa && sa.private_key && sa.client_email && sa.project_id);

// ذاكرة مؤقتة لتوكن الوصول (صالح ساعة)
let cachedToken = null, cachedExp = 0;

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function getAccessToken() {
  if (cachedToken && Date.now() < cachedExp - 60000) return cachedToken;
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = base64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
  }));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${claim}`);
  const signature = signer.sign(sa.private_key).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const jwt = `${header}.${claim}.${signature}`;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.access_token) throw new Error('FCM: تعذّر الحصول على توكن الوصول');
  cachedToken = data.access_token;
  cachedExp = Date.now() + (Number(data.expires_in || 3600) * 1000);
  return cachedToken;
}

// يُرسل إشعارًا لجهاز عبر توكن FCM — مع صوت وقناة عالية الأولوية وبيانات الوجهة
async function sendFcm(token, title, body, data) {
  if (!fcmEnabled() || !token) return false;
  try {
    const access = await getAccessToken();
    // بيانات FCM يجب أن تكون نصوصًا
    const strData = {};
    if (data && typeof data === 'object') for (const k of Object.keys(data)) strData[k] = String(data[k]);
    const message = {
      token,
      notification: { title, body },
      android: {
        priority: 'HIGH',
        notification: {
          sound: 'default',
          channel_id: 'wasalni-alerts',
          default_vibrate_timings: true,
          notification_priority: 'PRIORITY_MAX',
        },
      },
      ...(Object.keys(strData).length ? { data: strData } : {}),
    };
    const res = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    });
    if (!res.ok) { const t = await res.text().catch(() => ''); console.error('FCM send فشل:', res.status, t.slice(0, 200)); return false; }
    return true;
  } catch (e) { console.error('FCM send خطأ:', e.message); return false; }
}

module.exports = { sendFcm, fcmEnabled };
