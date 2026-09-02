// خادم وصلني — Express 5 + SQLite/PostgreSQL مدمج (Node 22)
// التشغيل: node server.js   (المنفذ الافتراضي 4000)
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');

const IS_PROD = process.env.NODE_ENV === 'production';

// لا تُسقِط الخادم على أي خطأ غير متوقّع — سجّله وابقَ حيًّا (تفادي Crashed)
process.on('unhandledRejection', (e) => console.error('⚠️ unhandledRejection:', (e && e.message) || e));
process.on('uncaughtException', (e) => console.error('⚠️ uncaughtException:', (e && e.message) || e));

// اضبط الأسرار قبل تحميل الوحدات التي تقرؤها (auth/admin) — بلا إسقاط للخادم
if (IS_PROD) {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'wasalni-dev-secret-change-in-production') {
    process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
    console.warn('⚠️ JWT_SECRET غير مضبوط — وُلّد سرّ مؤقّت (ستُعاد جلسات الدخول عند كل إعادة تشغيل). اضبط JWT_SECRET ثابتًا في Railway.');
  }
  if (!process.env.ADMIN_SECRET || process.env.ADMIN_SECRET === 'wasalni-admin') {
    process.env.ADMIN_SECRET = crypto.randomBytes(16).toString('hex');
    console.warn('⚠️ ADMIN_SECRET غير مضبوط — وُلّدت كلمة مرور مؤقّتة (لن تستطيع الدخول للوحة الإدارة حتى تضبط ADMIN_SECRET ثابتًا في Railway). هذا أأمن من ترك كلمة المرور الافتراضية معروفة.');
  }
}

const routes = require('./src/routes');
const adminRoutes = require('./src/admin');
const { securityHeaders, rateLimit } = require('./src/security');

const app = express();
app.set('trust proxy', 1); // خلف وكيل Railway — ليقرأ IP العميل الحقيقي

// CORS: قيّد المصادر عبر CORS_ORIGIN (قائمة مفصولة بفواصل) — فارغ = مسموح للجميع (تطوير)
const allowed = (process.env.CORS_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors(allowed.length ? {
  origin(origin, cb) {
    // اسمح لطلبات الجوال/نفس الأصل (بلا Origin) وللمصادر المسموح بها فقط
    if (!origin || allowed.includes(origin)) return cb(null, true);
    cb(new Error('CORS: مصدر غير مسموح'));
  },
} : {}));

app.use(securityHeaders);
// حدّ أكبر لرفع الصور (Base64) على هذا المسار فقط؛ وحدّ صغير للباقي
app.use('/api/uploads', express.json({ limit: '9mb' }));
app.use(express.json({ limit: '1mb' }));

// خدمة الصور المرفوعة من التخزين الدائم
const DATA_DIR = path.dirname(process.env.DB_PATH || path.join(__dirname, 'wasalni.db'));
app.use('/uploads', express.static(path.join(DATA_DIR, 'uploads'), { maxAge: '7d' }));

// سجلّ مختصر في التطوير فقط (يُكتم في الإنتاج لتجنّب الضجيج وتسريب المسارات)
if (!IS_PROD) app.use((req, _res, next) => { console.log(`${req.method} ${req.url}`); next(); });

// نقطة فحص الصحة (يستخدمها Railway للتأكد أن الخادم حيّ)
app.get('/health', (_req, res) => res.json({ ok: true, service: 'wasalni-api', time: Date.now() }));

// خدمة لوحة الإدارة من نفس الخادم على /admin
app.get('/admin', (_req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
// تطبيق الويب (للمستخدمين) — مربوط تلقائيًّا بهذا الخادم
app.get('/app', (_req, res) => res.sendFile(path.join(__dirname, 'webapp.html')));
// سياسة الخصوصية والشروط (روابط عامة مطلوبة لمتجر Google Play)
app.get('/privacy', (_req, res) => res.sendFile(path.join(__dirname, 'privacy.html')));
app.get('/terms', (_req, res) => res.sendFile(path.join(__dirname, 'terms.html')));
// صفحة تتبّع عامة عبر رابط المشاركة (تقرأ الرمز من المسار وتستعلم /api/live/:token)
app.get('/live/:token', (_req, res) => res.sendFile(path.join(__dirname, 'live.html')));

// تنزيل أحدث نسخة APK (يُستبدل الملف يدويًا مع كل إصدار جديد ويُرفع مع الكود — يبقى ثابتًا عبر إعادة النشر
// خلافًا لمجلد /uploads المؤقّت). يُستخدم من زر «تنزيل التحديث» بإشعار لوحة الإدارة.
app.get('/download/apk', (_req, res) => {
  const file = path.join(__dirname, 'public', 'downloads', 'wasalni-latest.apk');
  res.download(file, 'wasalni.apk', (err) => { if (err && !res.headersSent) res.status(404).json({ error: 'لا يوجد إصدار متاح للتنزيل بعد' }); });
});

// صفحة الدفع بالبطاقة (نموذج Moyasar) — تعمل فقط عند ضبط MOYASAR_PUBLISHABLE_KEY
// التطبيق يفتحها بمبلغ محدّد، وعند اكتمال الدفع يعود Moyasar إلى /pay/done?id=<paymentId>
// فيلتقط التطبيق المعرّف ويستدعي /api/wallet/topup {paymentId} الذي يتحقّق من المبلغ ويشحن المحفظة.
app.get('/pay', (req, res) => {
  const pk = process.env.MOYASAR_PUBLISHABLE_KEY;
  if (!pk) return res.status(503).send('<html dir="rtl"><body style="font-family:sans-serif;text-align:center;padding:40px">بوابة الدفع غير مفعّلة حاليًا.</body></html>');
  const amount = Math.round(Number(req.query.amount) * 100); // بالهللات/القروش
  const currency = String(req.query.currency || 'SAR').replace(/[^A-Z]/g, '').slice(0, 3) || 'SAR';
  if (!Number.isInteger(amount) || amount <= 0 || amount > 500000) return res.status(400).send('مبلغ غير صالح');
  const base = `${req.protocol}://${req.get('host')}`;
  res.send(`<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>الدفع بالبطاقة — وصلني</title>
<link rel="stylesheet" href="https://cdn.moyasar.com/mpf/1.14.0/moyasar.css"/>
<style>body{font-family:system-ui,Tahoma,sans-serif;background:#F4F7FC;margin:0;padding:24px}
.box{max-width:420px;margin:0 auto;background:#fff;border-radius:16px;padding:20px;box-shadow:0 4px 18px rgba(15,47,114,.08)}
h3{color:#0F2F72;margin:0 0 14px}</style></head><body>
<div class="box"><h3>💳 الدفع الآمن بالبطاقة</h3><div class="mysr-form"></div></div>
<script src="https://cdn.moyasar.com/mpf/1.14.0/moyasar.js"></script>
<script>
Moyasar.init({
  element: '.mysr-form',
  amount: ${amount},
  currency: '${currency}',
  description: 'شحن محفظة وصلني',
  publishable_api_key: '${pk}',
  callback_url: '${base}/pay/done',
  methods: ['creditcard'],
});
</script></body></html>`);
});
app.get('/pay/done', (req, res) => {
  const ok = String(req.query.status || '') === 'paid';
  res.send(`<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><title>نتيجة الدفع</title></head>
<body style="font-family:system-ui,Tahoma,sans-serif;text-align:center;padding:60px 20px;background:#F4F7FC">
<div style="font-size:44px">${ok ? '✅' : '❌'}</div>
<h3 style="color:#0F2F72">${ok ? 'تم الدفع بنجاح' : 'لم يكتمل الدفع'}</h3>
<p style="color:#6B7280">${ok ? 'ارجع للتطبيق لإتمام العملية.' : 'يمكنك المحاولة مرة أخرى من التطبيق.'}</p>
</body></html>`);
});

// تحديد معدّل على النقاط الحسّاسة (مكافحة إساءة الاستخدام وتخمين كلمات المرور)
app.use('/api/auth/otp/send', rateLimit({ windowMs: 60000, max: 5, message: 'طلبات رمز كثيرة، انتظر قليلاً' }));
app.use('/api/auth/otp/verify', rateLimit({ windowMs: 60000, max: 10, message: 'محاولات تحقّق كثيرة، انتظر قليلاً' }));
app.use('/api/auth/email/send', rateLimit({ windowMs: 60000, max: 5, message: 'طلبات رمز كثيرة، انتظر قليلاً' }));
app.use('/api/auth/email/verify', rateLimit({ windowMs: 60000, max: 10, message: 'محاولات تحقّق كثيرة، انتظر قليلاً' }));
app.use('/api/admin/login', rateLimit({ windowMs: 300000, max: 10, message: 'محاولات دخول كثيرة، انتظر قليلاً' }));

app.use('/api/admin', adminRoutes);
app.use('/api', routes);

// 404 موحّد
app.use((_req, res) => res.status(404).json({ error: 'المسار غير موجود' }));

// معالج أخطاء موحّد
app.use((err, _req, res, _next) => {
  console.error('خطأ غير متوقع:', (err && err.stack) || err);
  res.status(500).json({ error: 'خطأ داخلي في الخادم' });
});

const PORT = process.env.PORT || 4000;

// هيّئ قاعدة البيانات ثم ابدأ الاستماع. وإن فشلت التهيئة، ابقَ حيًّا واعرض الخطأ
// (تفادي حلقة الانهيار على Railway — يبقى /health يعمل ويظهر السبب في السجلّ)
const { initDb } = require('./src/db');
const { startDocExpiryJob } = require('./src/docexpiry');
const { startRecurringJob } = require('./src/recurring');
function listen() {
  app.listen(PORT, () => console.log(`✅ وصلني API يعمل على http://localhost:${PORT}/api`));
  try { startDocExpiryJob(); } catch (e) { console.error('docExpiry job:', e && e.message); }
  try { startRecurringJob(); } catch (e) { console.error('recurring job:', e && e.message); }
}
initDb()
  .then(listen)
  .catch((e) => {
    console.error('❌ فشل تهيئة قاعدة البيانات:', (e && e.stack) || e);
    listen(); // ابقَ حيًّا ليظهر الخطأ بدل إعادة التشغيل المتكرّرة
  });
