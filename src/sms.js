// ============================================================
// طبقة إرسال SMS لوصلني — تدعم عدّة مزوّدين، تختار تلقائيًّا حسب المفاتيح
// المزوّدون: Unifonic (موصى به سعوديًّا)، Twilio (عالمي)
// لتفعيل أيٍّ منها: ضع متغيّرات البيئة الخاصة به (انظر .env.example)
// ============================================================

// يكتشف المزوّد المتاح حسب متغيّرات البيئة
function detectProvider() {
  if (process.env.UNIFONIC_APPSID) return 'unifonic';
  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) return 'twilio';
  return null;
}

// ---------- Unifonic (سعودي) ----------
async function sendViaUnifonic(to, body) {
  const appSid = process.env.UNIFONIC_APPSID;
  const senderId = process.env.UNIFONIC_SENDER_ID || 'Wasalni';
  // واجهة Unifonic REST — إرسال رسالة واحدة
  const res = await fetch('https://el.cloud.unifonic.com/rest/SMS/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      AppSid: appSid,
      SenderID: senderId,
      Body: body,
      Recipient: to.replace('+', ''), // Unifonic يقبل الرقم بلا +
      responseType: 'JSON',
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === 'false' || data.success === false) {
    throw new Error('Unifonic: ' + (data.message || data.errorCode || res.status));
  }
  return { provider: 'unifonic', id: data.data?.MessageID || null };
}

// ---------- Twilio (عالمي) ----------
async function sendViaTwilio(to, body) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM; // رقم المرسِل أو Messaging Service SID
  const auth = Buffer.from(`${sid}:${token}`).toString('base64');
  const params = new URLSearchParams({ To: to, Body: body });
  if (from && from.startsWith('MG')) params.set('MessagingServiceSid', from);
  else params.set('From', from);
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('Twilio: ' + (data.message || res.status));
  return { provider: 'twilio', id: data.sid || null };
}

// ---------- الواجهة الموحّدة ----------
// to: رقم دولي مثل +9665XXXXXXXX
async function sendSms(to, body) {
  const provider = detectProvider();
  if (!provider) {
    // لا مزوّد مُهيّأ — في الإنتاج هذا خطأ، نسجّله بوضوح
    throw new Error('لا يوجد مزوّد SMS مُهيّأ. اضبط UNIFONIC_APPSID أو TWILIO_* في متغيّرات البيئة.');
  }
  if (provider === 'unifonic') return sendViaUnifonic(to, body);
  if (provider === 'twilio') return sendViaTwilio(to, body);
}

module.exports = { sendSms, detectProvider };
