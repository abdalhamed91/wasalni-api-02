// ============================================================
// إرسال رمز توثيق البريد. إن ضُبطت بيئة SMTP (SMTP_HOST...) يُرسل بريدًا فعليًا
// عبر nodemailer (إن وُجد)، وإلا يعيد devCode ليُعرض في التطبيق (وضع التجربة) —
// نفس نهج رمز الجوال الذي يعمل بلا مزوّد رسائل.
// ============================================================
async function sendEmailOtp(email, code) {
  const host = process.env.SMTP_HOST;
  if (!host) return { devCode: code, sent: true };       // لا مزوّد → رمز تجريبي
  try {
    const nodemailer = require('nodemailer');             // اختياري
    const t = nodemailer.createTransport({
      host,
      port: Number(process.env.SMTP_PORT || 587),
      secure: String(process.env.SMTP_SECURE || '') === '1',
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    });
    await t.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER || 'no-reply@wasalni.app',
      to: email,
      subject: 'رمز تحقّق وصلني',
      text: `رمز تحقّق بريدك في وصلني هو: ${code}\nصالح لمدة 10 دقائق.`,
    });
    return { sent: true };
  } catch (e) {
    // تعذّر الإرسال (مكتبة غير مثبّتة أو خطأ SMTP) → ارجع للرمز التجريبي حتى لا تتعطّل التجربة
    return { devCode: code, sent: true };
  }
}

module.exports = { sendEmailOtp };
