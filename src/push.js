// ============================================================
// إشعارات فورية لوصلني عبر Expo Push API — بلا مفاتيح خارجية
// يُرسَل تلقائيًّا مع كل إشعار داخلي (addNotif) إن كان للمستخدم توكن جهاز.
// ============================================================
const db = require('./database');

async function sendExpoPush(token, title, body, data) {
  if (!token || !/^Expo(nent)?PushToken\[/.test(token)) return;
  try {
    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ to: token, title, body, sound: 'default', priority: 'high', ...(data ? { data } : {}) }),
    });
  } catch (e) { /* تجاهل أخطاء الإرسال */ }
}

// يبحث عن توكن المستخدم ويُرسل له (fire-and-forget — لا يوقف الطلب)
async function pushToUser(userId, title, body, data) {
  try {
    const u = await db.queryOne('SELECT push_token FROM users WHERE id=?', [userId]);
    if (u && u.push_token) await sendExpoPush(u.push_token, title, body, data);
  } catch (e) { /* تجاهل */ }
}

module.exports = { sendExpoPush, pushToUser };
