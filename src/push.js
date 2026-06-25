// ============================================================
// إشعارات فورية لوصلني: توكن FCM أصلي → FCM v1 مباشرةً؛ توكن Expo → Expo Push API.
// يُرسَل تلقائيًّا مع كل إشعار داخلي (addNotif) إن كان للمستخدم توكن جهاز.
// ============================================================
const db = require('./database');
let sendFcm = async () => false, fcmEnabled = () => false;
try { const f = require('./fcm'); sendFcm = f.sendFcm; fcmEnabled = f.fcmEnabled; } catch (e) {}

const isExpoToken = (t) => /^Expo(nent)?PushToken\[/.test(t);

async function sendExpoPush(token, title, body, data) {
  if (!token || !/^Expo(nent)?PushToken\[/.test(token)) return;
  try {
    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ to: token, title, body, sound: 'default', priority: 'high', channelId: 'wasalni-alerts', ...(data ? { data } : {}) }),
    });
  } catch (e) { /* تجاهل أخطاء الإرسال */ }
}

// يبحث عن توكن المستخدم ويُرسل له بالقناة المناسبة (fire-and-forget — لا يوقف الطلب)
async function pushToUser(userId, title, body, data) {
  try {
    const u = await db.queryOne('SELECT push_token FROM users WHERE id=?', [userId]);
    if (!u || !u.push_token) return;
    if (isExpoToken(u.push_token)) await sendExpoPush(u.push_token, title, body, data);
    else await sendFcm(u.push_token, title, body, data);   // توكن FCM أصلي
  } catch (e) { /* تجاهل */ }
}

module.exports = { sendExpoPush, pushToUser, fcmEnabled };
