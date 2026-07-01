// مصادقة وصلني — OTP + JWT (async موحّد)
const jwt = require('jsonwebtoken');
const { db, now, ensureSeedForUser } = require('./db');

const SECRET = process.env.JWT_SECRET || 'wasalni-dev-secret-change-in-production';
const OTP_TTL_MS = 5 * 60 * 1000;
const OTP_RESEND_MS = 60 * 1000;        // لا تسمح بإعادة إرسال قبل دقيقة
const OTP_MAX_ATTEMPTS = 5;             // محاولات تحقّق قبل الإبطال
const DEV_MODE = process.env.NODE_ENV !== 'production';

// إرسال SMS فعلي (يُفعّل في الإنتاج عبر مزوّد). انظر sms.js
let sendSms = null;
let detectProvider = () => null;
try { const sms = require('./sms'); sendSms = sms.sendSms; if (sms.detectProvider) detectProvider = sms.detectProvider; } catch { sendSms = null; }

async function sendOtp(phone, dial) {
  // منع إعادة الإرسال المتكرّر
  const existing = await db.queryOne('SELECT sent_at FROM otps WHERE phone=?', [phone]);
  if (existing && existing.sent_at && (now() - Number(existing.sent_at)) < OTP_RESEND_MS) {
    const wait = Math.ceil((OTP_RESEND_MS - (now() - Number(existing.sent_at))) / 1000);
    return { error: `انتظر ${wait} ثانية قبل إعادة الإرسال`, retryAfter: wait };
  }
  const code = String(Math.floor(1000 + Math.random() * 9000));
  const ex = db.kind === 'postgres' ? 'EXCLUDED' : 'excluded';
  await db.execute(
    `INSERT INTO otps (phone,code,expires_at,attempts,sent_at) VALUES (?,?,?,0,?)
     ON CONFLICT(phone) DO UPDATE SET code=${ex}.code, expires_at=${ex}.expires_at, attempts=0, sent_at=${ex}.sent_at`,
    [phone, code, now() + OTP_TTL_MS, now()]
  );
  // أرسل SMS حقيقي فقط عند تهيئة مزوّد فعلي (Unifonic/Twilio عبر متغيّرات البيئة)
  const smsReady = !!(sendSms && detectProvider());
  if (smsReady) {
    const message = `رمز التحقق في وصلني: ${code}\nصالح لمدة 5 دقائق. لا تشاركه مع أحد.`;
    try {
      await sendSms((dial || '+966') + phone, message);
    } catch (e) {
      console.error('فشل إرسال SMS:', e.message);
      await db.execute('DELETE FROM otps WHERE phone=?', [phone]);
      return { error: 'تعذّر إرسال رمز التحقق، حاول لاحقًا' };
    }
    return { sent: true };
  }
  // لا مزوّد SMS مُهيّأ → أعِد الرمز ليُعرض داخل التطبيق (تجربة/إطلاق مبكر بلا SMS)
  // بمجرّد ضبط متغيّرات مزوّد SMS، يتحوّل تلقائيًا لإرسال حقيقي ويتوقّف إظهار الرمز.
  return { devCode: code, sent: true };
}

// تحقّق خفيف من الرمز (لتغيير الهاتف/التحقّق دون تسجيل دخول) — يستهلك الرمز عند النجاح
async function checkOtp(phone, code) {
  const row = await db.queryOne('SELECT code, expires_at, attempts FROM otps WHERE phone=?', [phone]);
  const master = DEV_MODE && code === '0000';
  if (!master) {
    if (!row) return { error: 'لم يُرسل رمز لهذا الرقم' };
    if (Number(row.attempts) >= OTP_MAX_ATTEMPTS) { await db.execute('DELETE FROM otps WHERE phone=?', [phone]); return { error: 'تجاوزت عدد المحاولات، أعد الإرسال' }; }
    if (Number(row.expires_at) < now()) return { error: 'انتهت صلاحية الرمز، أعد الإرسال' };
    if (row.code !== code) { await db.execute('UPDATE otps SET attempts=attempts+1 WHERE phone=?', [phone]); return { error: 'الرمز غير صحيح' }; }
  }
  await db.execute('DELETE FROM otps WHERE phone=?', [phone]);
  return { ok: true };
}

const CC_RE = /^[A-Z]{2}$/;
async function verifyOtp(phone, dial, countryCode, code) {
  // كود بلد بصيغة ISO 3166-1 alpha-2 فقط (حرفان) — أي شيء آخر يُتجاهل بدل تخزينه كما هو
  const cc = CC_RE.test(String(countryCode || '').toUpperCase()) ? String(countryCode).toUpperCase() : null;
  const row = await db.queryOne('SELECT code, expires_at, attempts FROM otps WHERE phone=?', [phone]);
  const master = DEV_MODE && code === '0000';
  if (!master) {
    if (!row) return { error: 'لم يُرسل رمز لهذا الرقم' };
    if (Number(row.attempts) >= OTP_MAX_ATTEMPTS) { await db.execute('DELETE FROM otps WHERE phone=?', [phone]); return { error: 'تجاوزت عدد المحاولات، أعد الإرسال' }; }
    if (Number(row.expires_at) < now()) return { error: 'انتهت صلاحية الرمز، أعد الإرسال' };
    if (row.code !== code) {
      await db.execute('UPDATE otps SET attempts=attempts+1 WHERE phone=?', [phone]);
      return { error: 'الرمز غير صحيح' };
    }
  }
  await db.execute('DELETE FROM otps WHERE phone=?', [phone]);

  let user = await db.queryOne('SELECT * FROM users WHERE phone=?', [phone]);
  if (!user) {
    const { insertReturningId } = require('./db');
    const id = await insertReturningId('users', ['phone', 'dial', 'country_code', 'created_at'], [phone, dial || '+962', cc || 'JO', now()]);
    user = await db.queryOne('SELECT * FROM users WHERE id=?', [id]);
  } else if (cc) {
    await db.execute('UPDATE users SET dial=?, country_code=? WHERE id=?', [dial || user.dial, cc, user.id]);
    user = await db.queryOne('SELECT * FROM users WHERE id=?', [user.id]);
  }
  await ensureSeedForUser(user.id, user.name);
  const token = jwt.sign({ uid: user.id }, SECRET, { expiresIn: '30d' });
  return { token, user: await publicUser(user) };
}

async function publicUser(u) {
  const v = await db.queryOne('SELECT make,model,year,color,plate,capacity FROM vehicles WHERE user_id=?', [u.id]) || {};
  return {
    id: u.id, phone: u.phone, dial: u.dial, countryCode: u.country_code,
    role: u.role, gender: u.gender, name: u.name, email: u.email,
    emailVerified: db.kind === 'postgres' ? !!u.email_verified : !!Number(u.email_verified),
    rating: u.rating,
    ratingCount: Number(u.rating_count) || 0, serviceType: u.service_type || 'carpool',
    avatar: u.avatar || '',
    wallet: u.wallet, earnings: u.earnings, vehicle: v,
    verified: db.kind === 'postgres' ? !!u.verified : !!Number(u.verified),
    verifyStatus: u.verify_status || 'none',
    docExpiry: {
      license: u.license_expiry || '',
      vehicleReg: u.vehicle_reg_expiry || '',
      insurance: u.insurance_expiry || '',
    },
  };
}

async function authRequired(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'مطلوب تسجيل الدخول' });
  try {
    const { uid } = jwt.verify(token, SECRET);
    const user = await db.queryOne('SELECT * FROM users WHERE id=?', [uid]);
    if (!user) return res.status(401).json({ error: 'حساب غير موجود' });
    // الإيقاف من الإدارة يُطبَّق فورًا: يُمنع الموقوف من استخدام التطبيق
    if (user.status === 'suspended') return res.status(403).json({ error: 'تم إيقاف حسابك. تواصل مع الدعم.', suspended: true });
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: 'جلسة غير صالحة' });
  }
}

module.exports = { sendOtp, verifyOtp, checkOtp, publicUser, authRequired };
