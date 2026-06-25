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
    console.warn('⚠️ ADMIN_SECRET غير مضبوط — كلمة مرور الإدارة الافتراضية (wasalni-admin). اضبط كلمة قوية في Railway.');
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

// تحديد معدّل على النقاط الحسّاسة (مكافحة إساءة الاستخدام وتخمين كلمات المرور)
app.use('/api/auth/otp/send', rateLimit({ windowMs: 60000, max: 5, message: 'طلبات رمز كثيرة، انتظر قليلاً' }));
app.use('/api/auth/otp/verify', rateLimit({ windowMs: 60000, max: 10, message: 'محاولات تحقّق كثيرة، انتظر قليلاً' }));
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
function listen() {
  app.listen(PORT, () => console.log(`✅ وصلني API يعمل على http://localhost:${PORT}/api`));
  try { startDocExpiryJob(); } catch (e) { console.error('docExpiry job:', e && e.message); }
}
initDb()
  .then(listen)
  .catch((e) => {
    console.error('❌ فشل تهيئة قاعدة البيانات:', (e && e.stack) || e);
    listen(); // ابقَ حيًّا ليظهر الخطأ بدل إعادة التشغيل المتكرّرة
  });
