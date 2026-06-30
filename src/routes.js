// مسارات وصلني REST API
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
// مجلّد تخزين الصور (على الـVolume الدائم في الإنتاج: بجانب قاعدة البيانات)
const UPLOAD_DIR = path.join(path.dirname(process.env.DB_PATH || path.join(__dirname, '..', 'wasalni.db')), 'uploads');
try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch (e) {}
const { db, now, round2, insertReturningId, addTxn, addNotif, COMMISSION_RATE, SERVICE_COUNTRIES, commissionRate, serviceCountries, platformProfit, seatPriceForDistance, countrySetting } = require('./db');
const { sendOtp, verifyOtp, checkOtp, publicUser, authRequired } = require('./auth');
const { paymentsEnabled, verifyPayment } = require('./payments');

const r = express.Router();
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });

// رموز عملات الدول (للإشعارات والإيصالات) — الافتراضي د.أ (سوق الإطلاق: الأردن)
const CURRENCY = { SA: 'ر.س', JO: 'د.أ', EG: 'ج.م', AE: 'د.إ', KW: 'د.ك', QA: 'ر.ق', BH: 'د.ب', OM: 'ر.ع', PS: '₪', IQ: 'د.ع', LB: 'ل.ل', SY: 'ل.س' };
const curSym = (code) => CURRENCY[code] || 'د.أ';
async function userCur(userId) {
  const u = await db.queryOne('SELECT country_code FROM users WHERE id=?', [userId]);
  return curSym(u && u.country_code);
}

// طبّق تقييمًا جديدًا على مستخدم (متوسّط متحرّك مع عدّاد)
async function applyRating(userId, stars) {
  const s = Math.max(1, Math.min(5, Math.round(Number(stars) || 0)));
  if (!s) return;
  const u = await db.queryOne('SELECT rating, rating_count FROM users WHERE id=?', [userId]);
  if (!u) return;
  const cnt = Number(u.rating_count) || 0;
  const avg = cnt > 0 ? Number(u.rating) : 0;
  const newAvg = round2((avg * cnt + s) / (cnt + 1));
  await db.execute('UPDATE users SET rating=?, rating_count=? WHERE id=?', [newAvg, cnt + 1, userId]);
}

// ===== هندسة المطابقة على المسار (corridor matching) =====
const validPt = (p) => Array.isArray(p) && p[0] != null && p[1] != null && Number.isFinite(+p[0]) && Number.isFinite(+p[1]);
function haversineKm(a, b) {
  if (!validPt(a) || !validPt(b)) return Infinity;
  const R = 6371, toR = (d) => (d * Math.PI) / 180;
  const dLat = toR(b[0] - a[0]), dLng = toR(b[1] - a[1]);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a[0])) * Math.cos(toR(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
// مسافة نقطة P إلى القطعة AB بالكيلومتر + نسبة الإسقاط t (0=البداية,1=النهاية)
function pointToSegment(P, A, B) {
  if (!validPt(P) || !validPt(A) || !validPt(B)) return { dist: Infinity, t: 0 };
  const latRef = (A[0] * Math.PI) / 180;
  const proj = (p) => [p[1] * 111.32 * Math.cos(latRef), p[0] * 110.57];
  const [px, py] = proj(P), [ax, ay] = proj(A), [bx, by] = proj(B);
  const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + dx * t, cy = ay + dy * t;
  return { dist: Math.hypot(px - cx, py - cy), t };
}

// ============ الصحة ============
r.get('/health', (_req, res) => res.json({ ok: true, service: 'wasalni-api', time: now() }));

// ============ المصادقة ============
r.post('/auth/otp/send', async (req, res) => {
  const { phone, dial } = req.body || {};
  if (!phone || String(phone).replace(/\D/g, '').length < 7) return bad(res, 'رقم الجوال غير صالح');
  const out = await sendOtp(String(phone), dial);
  if (out.error) return bad(res, out.error, 429);
  res.json({ sent: true, ...(out.devCode ? { devCode: out.devCode } : {}) });
});

r.post('/auth/otp/verify', async (req, res) => {
  const { phone, dial, countryCode, code } = req.body || {};
  if (!phone || !code) return bad(res, 'الرقم والرمز مطلوبان');
  const out = await verifyOtp(String(phone), dial, countryCode, String(code));
  if (out.error) return bad(res, out.error, 401);
  res.json(out);
});

// تتبّع عام برابط المشاركة (بلا تسجيل دخول) — بيانات محدودة فقط
r.get('/live/:token', async (req, res) => {
  const token = String(req.params.token || '');
  if (!token || token.length < 6) return res.status(404).json({ error: 'رابط غير صالح' });
  const b = await db.queryOne('SELECT * FROM bookings WHERE share_token=?', [token]);
  if (!b) return res.status(404).json({ error: 'رابط غير صالح' });
  let trip = null;
  if (b.request_id) trip = await db.queryOne('SELECT t.* FROM trips t JOIN requests r ON r.trip_id=t.id WHERE r.id=?', [b.request_id]);
  const hasLoc = trip && trip.driver_lat != null && trip.driver_lng != null;
  const firstName = String(b.driver || 'السائق').split(' ')[0];
  res.json({
    status: trip ? trip.status : b.status,
    bookingStatus: b.status,
    driverName: firstName,
    from: b.from_label, to: b.to_label,
    fromCoord: trip ? [trip.from_lat, trip.from_lng] : null,
    toCoord: trip ? [trip.to_lat, trip.to_lng] : null,
    driver: hasLoc ? [trip.driver_lat, trip.driver_lng] : null,
  });
});

// كل ما يلي محمي
r.use(authRequired);

// ============ الملف الشخصي ============
r.get('/me', async (req, res) => {
  const cs = await countrySetting(req.user.country_code);
  // نصوص يضبطها الأدمن من الإعدادات العامة (ترحيب السائق + تحية الرئيسية)
  let driverWelcome = null, homeGreeting = null;
  try {
    const rows = await db.query("SELECT key,value FROM app_settings WHERE key IN ('driverWelcomeTitle','driverWelcomeMsg','homeGreeting')", []);
    const m = Object.fromEntries(rows.map(x => [x.key, x.value]));
    if (m.driverWelcomeTitle || m.driverWelcomeMsg) driverWelcome = { title: m.driverWelcomeTitle || '', msg: m.driverWelcomeMsg || '' };
    if (m.homeGreeting) homeGreeting = m.homeGreeting;
  } catch (e) { /* تجاهل */ }
  res.json({
    user: await publicUser(req.user),
    taxRate: cs && cs.tax_rate != null ? Number(cs.tax_rate) : 0,
    exchangeRate: cs && cs.exchange_rate != null ? Number(cs.exchange_rate) : 1,
    currency: curSym(req.user.country_code),
    driverWelcome,
    homeGreeting,
  });
});

r.patch('/me', async (req, res) => {
  const { name, email, role, countryCode, dial, gender, avatar, birthDate } = req.body || {};
  if (role && !['passenger', 'driver'].includes(role)) return bad(res, 'دور غير صالح');
  if (gender && !['male', 'female'].includes(gender)) return bad(res, 'قيمة الجنس غير صالحة');
  await db.execute(`UPDATE users SET
      name = COALESCE(?, name), email = COALESCE(?, email),
      role = COALESCE(?, role), country_code = COALESCE(?, country_code), dial = COALESCE(?, dial),
      gender = COALESCE(?, gender), avatar = COALESCE(?, avatar), birth_date = COALESCE(?, birth_date)
    WHERE id=?`, [name ?? null, email ?? null, role ?? null, countryCode ?? null, dial ?? null, gender ?? null, avatar ?? null, birthDate ?? null, req.user.id]);
  const u = await db.queryOne('SELECT * FROM users WHERE id=?', [req.user.id]);
  res.json({ user: await publicUser(u) });
});

// تغيير رقم الجوال — يتطلّب تحقّقًا برمز على الرقم الجديد
r.post('/me/phone/otp', async (req, res) => {
  const phone = String(req.body?.phone || '').replace(/\D/g, '');
  const dial = String(req.body?.dial || req.user.dial || '+962');
  if (phone.length < 7) return bad(res, 'رقم جوال غير صالح');
  const taken = await db.queryOne('SELECT id FROM users WHERE phone=? OR phone LIKE ?', [phone, '%' + phone.slice(-9)]);
  if (taken && taken.id !== req.user.id) return bad(res, 'هذا الرقم مستخدم بحساب آخر');
  const r2 = await sendOtp(phone, dial);
  if (r2.error) return bad(res, r2.error);
  res.json({ sent: true, devCode: r2.devCode || undefined });
});
r.post('/me/phone/verify', async (req, res) => {
  const phone = String(req.body?.phone || '').replace(/\D/g, '');
  const dial = String(req.body?.dial || req.user.dial || '+962');
  const code = String(req.body?.code || '');
  if (phone.length < 7) return bad(res, 'رقم جوال غير صالح');
  const taken = await db.queryOne('SELECT id FROM users WHERE phone=? OR phone LIKE ?', [phone, '%' + phone.slice(-9)]);
  if (taken && taken.id !== req.user.id) return bad(res, 'هذا الرقم مستخدم بحساب آخر');
  const v = await checkOtp(phone, code);
  if (v.error) return bad(res, v.error);
  await db.execute('UPDATE users SET phone=?, dial=? WHERE id=?', [phone, dial, req.user.id]);
  const u = await db.queryOne('SELECT * FROM users WHERE id=?', [req.user.id]);
  res.json({ user: await publicUser(u) });
});

// ---- توثيق البريد الإلكتروني برمز يصل للبريد (devCode في وضع التجربة) ----
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
r.post('/me/email/otp', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return bad(res, 'بريد إلكتروني غير صالح');
  const taken = await db.queryOne('SELECT id FROM users WHERE LOWER(email)=? AND email_verified=1', [email]);
  if (taken && taken.id !== req.user.id) return bad(res, 'هذا البريد موثّق بحساب آخر');
  const code = String(Math.floor(100000 + Math.random() * 900000));
  await db.execute('UPDATE users SET email_otp=?, email_otp_exp=? WHERE id=?', [code, now() + 10 * 60 * 1000, req.user.id]);
  const { sendEmailOtp } = require('./email');
  const r2 = await sendEmailOtp(email, code);
  res.json({ sent: true, devCode: r2.devCode || undefined });
});
r.post('/me/email/verify', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const code = String(req.body?.code || '').trim();
  if (!EMAIL_RE.test(email)) return bad(res, 'بريد إلكتروني غير صالح');
  const u = await db.queryOne('SELECT email_otp, email_otp_exp FROM users WHERE id=?', [req.user.id]);
  if (!u || !u.email_otp) return bad(res, 'اطلب رمز التحقّق أولًا');
  if (Number(u.email_otp_exp) < now()) return bad(res, 'انتهت صلاحية الرمز — اطلب رمزًا جديدًا');
  if (String(u.email_otp) !== code) return bad(res, 'الرمز غير صحيح');
  await db.execute("UPDATE users SET email=?, email_verified=1, email_otp='', email_otp_exp=NULL WHERE id=?", [email, req.user.id]);
  const fresh = await db.queryOne('SELECT * FROM users WHERE id=?', [req.user.id]);
  res.json({ user: await publicUser(fresh) });
});

// ============ رفع صورة (Base64 → ملف على التخزين الدائم) ============
r.post('/uploads', async (req, res) => {
  let { data, ext } = req.body || {};
  if (!data || typeof data !== 'string') return bad(res, 'لا توجد بيانات صورة');
  const m = /^data:(image\/(png|jpe?g|webp));base64,(.+)$/i.exec(data);
  let b64 = data, e = String(ext || 'jpg').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'jpg';
  if (m) { e = m[2].toLowerCase().replace('jpeg', 'jpg'); b64 = m[3]; }
  if (!['jpg', 'png', 'webp'].includes(e)) e = 'jpg';
  let buf;
  try { buf = Buffer.from(b64, 'base64'); } catch { return bad(res, 'بيانات صورة غير صالحة'); }
  if (!buf.length) return bad(res, 'صورة فارغة');
  if (buf.length > 6 * 1024 * 1024) return bad(res, 'حجم الصورة كبير جدًا (الحد 6 ميجابايت)');
  const name = `${req.user.id}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${e}`;
  try { fs.writeFileSync(path.join(UPLOAD_DIR, name), buf); }
  catch (err) { return bad(res, 'تعذّر حفظ الصورة', 500); }
  res.status(201).json({ url: `/uploads/${name}` });
});

// ============ تقديم طلب توثيق السائق ============
r.post('/me/verify-request', async (req, res) => {
  const { idNumber, birthDate, city, docs, serviceType } = req.body || {};
  const docsJson = docs && typeof docs === 'object' ? JSON.stringify(docs) : null;
  const st = ['carpool', 'public_bus', 'school_bus'].includes(serviceType) ? serviceType : null;
  await db.execute(`UPDATE users SET
      id_number = COALESCE(?, id_number), birth_date = COALESCE(?, birth_date),
      city = COALESCE(?, city), docs = COALESCE(?, docs), service_type = COALESCE(?, service_type), role = 'driver',
      verify_status = 'submitted', verify_submitted_at = ?
    WHERE id=?`, [idNumber ?? null, birthDate ?? null, city ?? null, docsJson, st, now(), req.user.id]);
  // أبلغ السائق أن طلبه قيد المراجعة
  await addNotif(req.user.id, 'clock', 'amber', 'طلب التوثيق قيد المراجعة', 'سنراجع بياناتك ونعلمك بالنتيجة قريبًا');
  const u = await db.queryOne('SELECT * FROM users WHERE id=?', [req.user.id]);
  res.json({ user: await publicUser(u), verifyStatus: 'submitted' });
});

// السائق يحفظ/يحدّث تواريخ انتهاء وثائقه (رخصة/استمارة/تأمين) — YYYY-MM-DD
r.post('/me/doc-expiry', async (req, res) => {
  const { license, vehicleReg, insurance } = req.body || {};
  const clean = (v) => { const s = String(v || '').trim(); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : (s === '' ? '' : null); };
  const L = clean(license), V = clean(vehicleReg), I = clean(insurance);
  if (L === null || V === null || I === null) return bad(res, 'صيغة التاريخ يجب أن تكون YYYY-MM-DD');
  await db.execute(
    "UPDATE users SET license_expiry=?, vehicle_reg_expiry=?, insurance_expiry=?, doc_expiry_notified='' WHERE id=?",
    [L, V, I, req.user.id]);
  const u = await db.queryOne('SELECT * FROM users WHERE id=?', [req.user.id]);
  res.json({ user: await publicUser(u) });
});

// حفظ توكن الإشعارات الفورية للجهاز
r.post('/me/push-token', async (req, res) => {
  const token = String(req.body?.token || '').slice(0, 200).trim();
  await db.execute('UPDATE users SET push_token=? WHERE id=?', [token || null, req.user.id]);
  res.json({ ok: true });
});

r.put('/me/vehicle', async (req, res) => {
  const { make, model, year, color, plate, capacity } = req.body || {};
  await db.execute(`INSERT INTO vehicles (user_id,make,model,year,color,plate,capacity) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET make=excluded.make,model=excluded.model,year=excluded.year,
      color=excluded.color,plate=excluded.plate,capacity=excluded.capacity`, [req.user.id, make || '', model || '', year || '', color || '', plate || '', capacity || 4]);
  const u = await db.queryOne('SELECT * FROM users WHERE id=?', [req.user.id]);
  res.json({ user: await publicUser(u) });
});

// ============ المحفظة (راكب) ============
r.get('/wallet', async (req, res) => {
  const u = await db.queryOne('SELECT wallet FROM users WHERE id=?', [req.user.id]);
  const txns = await db.query("SELECT id,title,amount,kind,created_at at FROM transactions WHERE user_id=? AND scope='passenger' ORDER BY created_at DESC LIMIT 50", [req.user.id]);
  res.json({ balance: round2(u.wallet), txns });
});

r.post('/wallet/topup', async (req, res) => {
  const { paymentId } = req.body || {};
  let amount = Number(req.body?.amount);

  if (paymentsEnabled()) {
    // الإنتاج: لا شحن بلا دفع مؤكّد عبر البوّابة
    if (!paymentId) return bad(res, 'الدفع مطلوب لإتمام الشحن');
    let pay;
    try { pay = await verifyPayment(String(paymentId)); }
    catch (e) { return bad(res, e.message || 'تعذّر التحقّق من الدفع'); }
    // منع استخدام نفس عملية الدفع مرتين
    const dup = await db.queryOne('SELECT id FROM payments WHERE ref=?', [pay.id]);
    if (dup) return bad(res, 'عملية الدفع مستخدمة مسبقًا');
    amount = round2(pay.amount);
    await db.execute('INSERT INTO payments (user_id,provider,ref,amount,created_at) VALUES (?,?,?,?,?)',
      [req.user.id, 'moyasar', pay.id, amount, now()]);
  } else {
    // وضع التطوير (بلا بوّابة): شحن مباشر للاختبار فقط
    if (!Number.isFinite(amount) || amount <= 0 || amount > 5000) return bad(res, 'مبلغ شحن غير صالح');
    amount = round2(amount);
  }

  await db.execute('UPDATE users SET wallet = wallet + ? WHERE id=?', [amount, req.user.id]);
  await addTxn(req.user.id, 'passenger', 'شحن المحفظة', amount, 'in');
  const u = await db.queryOne('SELECT wallet FROM users WHERE id=?', [req.user.id]);
  res.json({ balance: round2(u.wallet) });
});

// ============ أرباح السائق ============
r.get('/earnings', async (req, res) => {
  const u = await db.queryOne('SELECT earnings FROM users WHERE id=?', [req.user.id]);
  const txns = await db.query("SELECT id,title,amount,kind,created_at at FROM transactions WHERE user_id=? AND scope='driver' ORDER BY created_at DESC LIMIT 50", [req.user.id]);
  res.json({ balance: round2(u.earnings), txns });
});

// الحساب البنكي للسحب
r.get('/me/bank', async (req, res) => {
  const b = await db.queryOne('SELECT holder,bank,iban FROM bank_accounts WHERE user_id=?', [req.user.id]);
  res.json({ bank: b || null });
});
r.put('/me/bank', async (req, res) => {
  const holder = String(req.body?.holder || '').trim();
  const bank = String(req.body?.bank || '').trim();
  let iban = String(req.body?.iban || '').trim().replace(/\s+/g, '').toUpperCase();
  if (!holder || !bank) return bad(res, 'اسم صاحب الحساب واسم البنك مطلوبان');
  // آيبان دولي عام (الأردن JO، السعودية SA، إلخ): حرفان + رقمان + 10–30 خانة
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) return bad(res, 'رقم الآيبان غير صالح');
  const ex = db.kind === 'postgres' ? 'EXCLUDED' : 'excluded';
  await db.execute(
    `INSERT INTO bank_accounts (user_id,holder,bank,iban,updated_at) VALUES (?,?,?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET holder=${ex}.holder, bank=${ex}.bank, iban=${ex}.iban, updated_at=${ex}.updated_at`,
    [req.user.id, holder, bank, iban, now()]);
  res.json({ bank: { holder, bank, iban } });
});

// طلب سحب الأرباح إلى الحساب البنكي (يُعتمد من الإدارة)
r.post('/earnings/withdraw', async (req, res) => {
  const bank = await db.queryOne('SELECT holder,bank,iban FROM bank_accounts WHERE user_id=?', [req.user.id]);
  if (!bank) return bad(res, 'أضف حسابك البنكي أولاً قبل السحب');
  const u = await db.queryOne('SELECT earnings FROM users WHERE id=?', [req.user.id]);
  const reqAmount = req.body?.amount != null ? Number(req.body.amount) : round2(u.earnings);
  if (!Number.isFinite(reqAmount) || reqAmount <= 0) return bad(res, 'مبلغ سحب غير صالح');
  if (reqAmount > round2(u.earnings) + 0.001) return bad(res, 'المبلغ يتجاوز رصيد الأرباح');
  const amount = round2(reqAmount);
  // اخصم من الأرباح (حجز) وأنشئ طلب سحب معلّق
  const payRes = await db.execute('UPDATE users SET earnings = earnings - ? WHERE id=? AND earnings >= ?', [amount, req.user.id, amount]);
  if (!payRes.rowCount) return bad(res, 'الرصيد غير كافٍ للسحب');
  const id = await insertReturningId('withdrawals',
    ['user_id','amount','holder','bank','iban','status','created_at'],
    [req.user.id, amount, bank.holder, bank.bank, bank.iban, 'pending', now()]);
  await addTxn(req.user.id, 'driver', 'طلب سحب إلى الحساب البنكي', amount, 'out');
  await addNotif(req.user.id, 'wallet', 'amber', 'تم استلام طلب السحب', `${amount} ${await userCur(req.user.id)} — قيد المعالجة`, '/(driver)/dwallet');
  const balance = round2((await db.queryOne('SELECT earnings FROM users WHERE id=?', [req.user.id])).earnings);
  res.status(201).json({ withdrawal: { id, amount, status: 'pending' }, balance });
});
r.get('/withdrawals', async (req, res) => {
  const rows = await db.query('SELECT id,amount,status,admin_note,created_at,paid_at FROM withdrawals WHERE user_id=? ORDER BY created_at DESC LIMIT 50', [req.user.id]);
  res.json({ withdrawals: rows });
});

// تحويل رصيد المحفظة إلى مستخدم آخر برقم جواله
r.post('/wallet/transfer', async (req, res) => {
  const toPhone = String(req.body?.phone || '').replace(/\D/g, '');
  const amount = round2(Number(req.body?.amount));
  if (!toPhone || toPhone.length < 7) return bad(res, 'رقم جوال المستلم غير صالح');
  if (!Number.isFinite(amount) || amount <= 0) return bad(res, 'مبلغ التحويل غير صالح');
  // مطابقة مرنة للهاتف: نتجاهل الصفر البادئ ورمز الدولة بمطابقة آخر 9 خانات
  const key9 = toPhone.slice(-9);
  let recipient = await db.queryOne('SELECT id, name FROM users WHERE phone=?', [toPhone]);
  if (!recipient) recipient = await db.queryOne("SELECT id, name FROM users WHERE phone LIKE ?", ['%' + key9]);
  if (!recipient) return bad(res, 'لا يوجد مستخدم بهذا الرقم');
  if (recipient.id === req.user.id) return bad(res, 'لا يمكنك التحويل لنفسك');
  // اخصم من المُرسِل ذرّيًّا ثم أضف للمستلم
  const debit = await db.execute('UPDATE users SET wallet = wallet - ? WHERE id=? AND wallet >= ?', [amount, req.user.id, amount]);
  if (!debit.rowCount) return bad(res, 'الرصيد غير كافٍ');
  await db.execute('UPDATE users SET wallet = wallet + ? WHERE id=?', [amount, recipient.id]);
  await addTxn(req.user.id, 'passenger', `تحويل إلى ${recipient.name || toPhone}`, amount, 'out');
  await addTxn(recipient.id, 'passenger', `تحويل وارد من ${req.user.name || 'مستخدم'}`, amount, 'in');
  await addNotif(recipient.id, 'wallet', 'green', 'وصلك تحويل', `${amount} ${await userCur(recipient.id)} إلى محفظتك`, '/(passenger)/wallet');
  const balance = round2((await db.queryOne('SELECT wallet FROM users WHERE id=?', [req.user.id])).wallet);
  res.json({ balance, to: recipient.name || toPhone, amount });
});

// استبدال كود عرض → رصيد محفظة (للأكواد ذات المبلغ المقطوع)
r.post('/promos/redeem', async (req, res) => {
  const code = String(req.body?.code || '').trim().toUpperCase();
  if (!code) return bad(res, 'أدخل كود العرض');
  const p = await db.queryOne('SELECT * FROM promos WHERE UPPER(code)=?', [code]);
  if (!p || !Number(p.active)) return bad(res, 'كود غير صالح أو غير مفعّل');
  if (p.expires_at && Number(p.expires_at) < Date.now()) return bad(res, 'انتهت صلاحية هذا الكود');
  // تقييد الدولة (إن حُدّدت)
  const u = await db.queryOne('SELECT country_code FROM users WHERE id=?', [req.user.id]);
  if (p.country && p.country !== (u && u.country_code)) return bad(res, 'هذا الكود غير متاح في بلدك');
  // حدّ الاستخدام الكلّي
  if (Number(p.max_uses) > 0 && Number(p.used_count) >= Number(p.max_uses)) return bad(res, 'انتهت مرّات استخدام هذا الكود');
  // مرّة واحدة لكل مستخدم
  const prev = await db.queryOne('SELECT id FROM promo_redemptions WHERE promo_id=? AND user_id=?', [p.id, req.user.id]);
  if (prev) return bad(res, 'سبق أن استخدمت هذا الكود');
  if (p.discount_type !== 'flat') return bad(res, 'هذا الكود يُطبَّق تلقائيًا عند الحجز، لا يُستبدل رصيدًا');
  const amount = round2(Number(p.discount_value));
  if (!Number.isFinite(amount) || amount <= 0) return bad(res, 'قيمة الكود غير صالحة');
  // أضِف الرصيد وسجّل الاستبدال ذرّيًّا قدر الإمكان
  await db.execute('UPDATE users SET wallet = wallet + ? WHERE id=?', [amount, req.user.id]);
  await db.execute('UPDATE promos SET used_count = used_count + 1 WHERE id=?', [p.id]);
  await insertReturningId('promo_redemptions', ['promo_id', 'user_id', 'amount', 'created_at'], [p.id, req.user.id, amount, now()]);
  await addTxn(req.user.id, 'passenger', `كود عرض: ${p.title || code}`, amount, 'in');
  await addNotif(req.user.id, 'wallet', 'green', 'تم تطبيق كود العرض 🎁', `${amount} ${await userCur(req.user.id)} أُضيفت لمحفظتك`, '/(passenger)/wallet');
  const balance = round2((await db.queryOne('SELECT wallet FROM users WHERE id=?', [req.user.id])).wallet);
  res.json({ balance, amount, title: p.title || code });
});

// ============ مسارات السائق ============
r.get('/trips', async (req, res) => {
  const trips = await db.query('SELECT * FROM trips WHERE driver_id=? ORDER BY created_at DESC', [req.user.id]);
  for (const t of trips) t.requests = await db.query('SELECT * FROM requests WHERE trip_id=?', [t.id]);
  res.json({ trips });
});

r.post('/trips', async (req, res) => {
  const { from, to, fromCoord, toCoord, date, time, price, seats, genderPref } = req.body || {};
  if (!from || !to || !time) return bad(res, 'الانطلاق والوجهة والوقت مطلوبة');
  const KINDS = ['city', 'intercity', 'public_bus', 'school_bus'];
  const kind = KINDS.includes(req.body?.kind) ? req.body.kind : 'city';
  const isBus = kind === 'public_bus' || kind === 'school_bus';
  const p = Number(price), s = Number(seats);
  // الباصات: السعر من 0 (المدرسية مجانية للأهالي عادةً)؛ الكاربول 5–500
  if (!Number.isFinite(p) || p < (isBus ? 0 : 5) || p > 500) return bad(res, isBus ? 'سعر غير صالح (0–500)' : 'سعر المقعد غير صالح (5–500)');
  const cap = isBus ? 60 : ((await db.queryOne('SELECT capacity FROM vehicles WHERE user_id=?', [req.user.id]) || {}).capacity || 4);
  if (!Number.isInteger(s) || s < 1 || s > cap) return bad(res, `عدد المقاعد يجب أن يكون 1–${cap}`);

  const gp = genderPref === 'female' ? 'female' : 'any';
  const tripId = await insertReturningId('trips',
    ['driver_id', 'from_label', 'to_label', 'from_lat', 'from_lng', 'to_lat', 'to_lng', 'date', 'time', 'price_per_seat', 'total_seats', 'gender_pref', 'kind', 'status', 'created_at'],
    [req.user.id, from, to, fromCoord?.[0] ?? null, fromCoord?.[1] ?? null, toCoord?.[0] ?? null, toCoord?.[1] ?? null, date || 'اليوم', time, p, s, gp, kind, 'scheduled', now()]);

  const trip = await db.queryOne('SELECT * FROM trips WHERE id=?', [tripId]);
  trip.requests = [];
  res.status(201).json({ trip });
});

async function ownTrip(req, res) {
  const trip = await db.queryOne('SELECT * FROM trips WHERE id=?', [Number(req.params.id)]);
  if (!trip) { bad(res, 'الرحلة غير موجودة', 404); return null; }
  if (trip.driver_id !== req.user.id) { bad(res, 'غير مصرّح', 403); return null; }
  return trip;
}

r.post('/trips/:id/cancel', async (req, res) => {
  const trip = await ownTrip(req, res); if (!trip) return;
  if (['completed', 'cancelled'].includes(trip.status)) return bad(res, 'لا يمكن إلغاء هذه الرحلة');
  const reason = (req.body && req.body.reason) ? String(req.body.reason).slice(0, 300) : null;
  // استرجاع الركّاب الذين حجزوا وأُعيد المبلغ لهم + إشعارهم
  const active = await db.query("SELECT * FROM requests WHERE trip_id=? AND status IN ('pending','accepted','onboard')", [trip.id]);
  for (const rq of active) {
    if (rq.passenger_id) {
      const bk = await db.queryOne("SELECT * FROM bookings WHERE request_id=? AND status NOT IN ('cancelled','completed')", [rq.id]);
      if (bk) {
        await db.execute("UPDATE bookings SET status='cancelled' WHERE id=?", [bk.id]);
        // استرجاع المحفظة فقط للحجوزات المدفوعة محفظةً (النقدي لم يُخصم أصلًا)
        if (bk.payment !== 'cash') {
          await db.execute('UPDATE users SET wallet = wallet + ? WHERE id=?', [bk.fare, bk.passenger_id]);
          await addTxn(bk.passenger_id, 'passenger', 'استرجاع رحلة ملغاة من السائق', bk.fare, 'in');
        }
      }
      await addNotif(rq.passenger_id, 'x', 'red', 'أُلغيت رحلتك من السائق', `${trip.from_label} ← ${trip.to_label}`, '/(passenger)/wallet');
    }
  }
  await db.execute("UPDATE requests SET status='cancelled' WHERE trip_id=? AND status IN ('pending','accepted','onboard')", [trip.id]);
  await db.execute("UPDATE trips SET status='cancelled', cancel_reason=? WHERE id=?", [reason, trip.id]);
  res.json({ ok: true });
});

// تعديل رحلة منشورة (السعر/الوقت/التاريخ/المقاعد/تفضيل الجنس) — قبل بدئها فقط
r.patch('/trips/:id', async (req, res) => {
  const trip = await ownTrip(req, res); if (!trip) return;
  if (trip.status !== 'scheduled') return bad(res, 'يمكن تعديل الرحلات المجدولة فقط');
  const { price, time, date, genderPref, seats } = req.body || {};
  const sets = [], vals = [];
  if (price !== undefined) {
    const p = Number(price);
    if (!Number.isFinite(p) || p < 5 || p > 500) return bad(res, 'سعر المقعد غير صالح (5–500)');
    sets.push('price_per_seat=?'); vals.push(p);
  }
  if (time !== undefined && String(time).trim()) { sets.push('time=?'); vals.push(String(time).trim()); }
  if (date !== undefined) { sets.push('date=?'); vals.push(String(date).trim() || 'اليوم'); }
  if (genderPref !== undefined) { sets.push('gender_pref=?'); vals.push(genderPref === 'female' ? 'female' : 'any'); }
  if (seats !== undefined) {
    const cap = (await db.queryOne('SELECT capacity FROM vehicles WHERE user_id=?', [req.user.id]) || {}).capacity || 4;
    const booked = (await db.queryOne("SELECT COALESCE(SUM(seats),0) s FROM requests WHERE trip_id=? AND status IN ('pending','accepted','onboard')", [trip.id])).s;
    const total = Number(seats);
    if (!Number.isInteger(total) || total < booked || total > cap) return bad(res, `عدد المقاعد يجب أن يكون بين ${booked} و ${cap}`);
    sets.push('total_seats=?'); vals.push(total - booked);
  }
  if (!sets.length) return bad(res, 'لا توجد تغييرات');
  vals.push(trip.id);
  await db.execute(`UPDATE trips SET ${sets.join(', ')} WHERE id=?`, vals);
  const updated = await db.queryOne('SELECT * FROM trips WHERE id=?', [trip.id]);
  updated.requests = await db.query('SELECT * FROM requests WHERE trip_id=?', [trip.id]);
  res.json({ trip: updated });
});

async function handleRequestAction(req, res) {
  const q = await db.queryOne('SELECT r.*, t.driver_id, t.total_seats, t.from_label, t.to_label FROM requests r JOIN trips t ON t.id=r.trip_id WHERE r.id=?', [Number(req.params.id)]);
  if (!q) return bad(res, 'الطلب غير موجود', 404);
  if (q.driver_id !== req.user.id) return bad(res, 'غير مصرّح', 403);
  if (q.status !== 'pending') return bad(res, 'الطلب لم يعد معلّقاً');
  if (req.params.action === 'accept') {
    // المقاعد والمبلغ محجوزان مسبقًا — القبول يؤكّد الحجز المرتبط
    await db.execute("UPDATE requests SET status='accepted' WHERE id=?", [q.id]);
    await db.execute("UPDATE bookings SET status='confirmed' WHERE request_id=? AND status='pending_driver'", [q.id]);
    await addNotif(req.user.id, 'check', 'green', 'قبلت طلب حجز', `${q.from_label} ← ${q.to_label}`);
    // أبلغ الراكب بقبول طلبه
    if (q.passenger_id) await addNotif(q.passenger_id, 'check', 'green', 'تم قبول حجزك ✓', `${q.from_label} ← ${q.to_label}`, '/(passenger)/tracking');
  } else {
    await db.execute("UPDATE requests SET status='rejected' WHERE id=?", [q.id]);
    // أعد المقاعد المحجوزة إلى الرحلة
    await db.execute('UPDATE trips SET total_seats = total_seats + ? WHERE id=?', [q.seats, q.trip_id]);
    // استرجاع تلقائي للراكب وإلغاء الحجز المرتبط
    const booking = await db.queryOne("SELECT * FROM bookings WHERE request_id=? AND status NOT IN ('cancelled','completed')", [q.id]);
    if (booking) {
      await db.execute("UPDATE bookings SET status='cancelled' WHERE id=?", [booking.id]);
      if (booking.payment !== 'cash') {
        await db.execute('UPDATE users SET wallet = wallet + ? WHERE id=?', [booking.fare, booking.passenger_id]);
        await addTxn(booking.passenger_id, 'passenger', 'استرجاع حجز مرفوض', booking.fare, 'in');
        await addNotif(booking.passenger_id, 'wallet', 'amber', 'اعتذر السائق عن طلبك وأُعيد المبلغ', `${booking.fare} ${await userCur(booking.passenger_id)} إلى محفظتك`, '/(passenger)/wallet');
      } else {
        await addNotif(booking.passenger_id, 'x', 'red', 'اعتذر السائق عن طلبك', `${q.from_label} ← ${q.to_label}`);
      }
    } else if (q.passenger_id) {
      await addNotif(q.passenger_id, 'x', 'red', 'لم يُقبل طلب حجزك', `${q.from_label} ← ${q.to_label}`);
    }
  }
  res.json({ request: await db.queryOne('SELECT * FROM requests WHERE id=?', [q.id]) });
}
r.post('/requests/:id/accept', async (req, res) => { req.params.action = 'accept'; await handleRequestAction(req, res); });
r.post('/requests/:id/reject', async (req, res) => { req.params.action = 'reject'; await handleRequestAction(req, res); });

r.post('/trips/:id/start', async (req, res) => {
  const trip = await ownTrip(req, res); if (!trip) return;
  if (trip.status === 'completed' || trip.status === 'cancelled') return bad(res, 'الرحلة منتهية');
  // يُسمح ببدء الانطلاق حتى بلا ركّاب — تبقى الرحلة «جارية» وقابلة للحجز على المسار
  const pax = await db.query("SELECT passenger_id FROM requests WHERE trip_id=? AND status='accepted' AND passenger_id IS NOT NULL", [trip.id]);
  await db.execute("UPDATE requests SET status='onboard' WHERE trip_id=? AND status='accepted'", [trip.id]);
  await db.execute("UPDATE trips SET status='live', started_at=? WHERE id=?", [now(), trip.id]);
  for (const p of pax) await addNotif(p.passenger_id, 'car', 'green', 'انطلقت رحلتك 🚗', 'السائق في الطريق — تابع موقعه مباشرة', '/(passenger)/tracking');
  res.json({ ok: true, passengers: pax.length });
});

// السائق يبثّ موقعه اللحظي أثناء الرحلة
r.post('/trips/:id/location', async (req, res) => {
  const trip = await ownTrip(req, res); if (!trip) return;
  const lat = Number(req.body?.lat), lng = Number(req.body?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return bad(res, 'إحداثيات غير صالحة');
  await db.execute('UPDATE trips SET driver_lat=?, driver_lng=?, driver_loc_at=? WHERE id=?', [lat, lng, now(), trip.id]);
  res.json({ ok: true });
});

// الراكب يتتبّع موقع سائق رحلته المحجوزة
r.get('/bookings/:id/track', async (req, res) => {
  const b = await db.queryOne('SELECT * FROM bookings WHERE id=?', [Number(req.params.id)]);
  if (!b) return bad(res, 'الحجز غير موجود', 404);
  if (b.passenger_id !== req.user.id) return bad(res, 'غير مصرّح', 403);
  let trip = null, request = null;
  if (b.request_id) {
    request = await db.queryOne('SELECT status, pickup FROM requests WHERE id=?', [b.request_id]);
    trip = await db.queryOne('SELECT t.* FROM trips t JOIN requests r ON r.trip_id=t.id WHERE r.id=?', [b.request_id]);
  }
  const hasLoc = trip && trip.driver_lat != null && trip.driver_lng != null;
  res.json({
    bookingStatus: b.status,                       // pending_driver | confirmed | completed | cancelled
    requestStatus: request ? request.status : null, // pending | accepted | onboard | dropped | rejected
    tripStatus: trip ? trip.status : null,          // scheduled | live | completed
    status: trip ? trip.status : b.status,
    rated: db.kind === 'postgres' ? !!b.rated : !!Number(b.rated),
    driver: hasLoc ? [trip.driver_lat, trip.driver_lng] : null,
    locAt: trip ? trip.driver_loc_at : null,
    fromLabel: trip ? trip.from_label : b.from_label,
    toLabel: trip ? trip.to_label : b.to_label,
    fromCoord: trip ? [trip.from_lat, trip.from_lng] : null,
    toCoord: trip ? [trip.to_lat, trip.to_lng] : null,
  });
});

// تفاصيل حجز كاملة (لصفحة تفاصيل الرحلة عند الراكب) — إحداثيات حقيقية + توقيتات
r.get('/bookings/:id/detail', async (req, res) => {
  const b = await db.queryOne('SELECT * FROM bookings WHERE id=?', [Number(req.params.id)]);
  if (!b) return bad(res, 'الحجز غير موجود', 404);
  if (b.passenger_id !== req.user.id) return bad(res, 'غير مصرّح', 403);
  let trip = null, driver = null;
  if (b.request_id) {
    trip = await db.queryOne('SELECT t.* FROM trips t JOIN requests r ON r.trip_id=t.id WHERE r.id=?', [b.request_id]);
    if (trip) driver = await db.queryOne('SELECT name, rating, rating_count FROM users WHERE id=?', [trip.driver_id]);
  }
  res.json({
    id: b.id, status: b.status, from: b.from_label, to: b.to_label,
    fromCoord: trip ? [trip.from_lat, trip.from_lng] : null,
    toCoord: trip ? [trip.to_lat, trip.to_lng] : null,
    driver: b.driver, driverRating: driver ? driver.rating : b.driver_rating,
    car: b.car, plate: b.plate, seats: b.seats, fare: b.fare,
    payment: b.payment || 'wallet',
    scheduledTime: b.time, bookedAt: b.created_at,
    startedAt: trip ? trip.started_at : null,
    completedAt: trip ? trip.completed_at : null,
    kind: trip ? trip.kind : 'city',
  });
});

// ينشئ/يعيد رابط تتبّع عام لمشاركته مع العائلة
r.post('/bookings/:id/share', async (req, res) => {
  const b = await db.queryOne('SELECT * FROM bookings WHERE id=?', [Number(req.params.id)]);
  if (!b) return bad(res, 'الحجز غير موجود', 404);
  if (b.passenger_id !== req.user.id) return bad(res, 'غير مصرّح', 403);
  let token = b.share_token;
  if (!token) { token = crypto.randomBytes(7).toString('hex'); await db.execute('UPDATE bookings SET share_token=? WHERE id=?', [token, b.id]); }
  const host = req.get('host');
  const url = `https://${host}/live/${token}`;
  res.json({ url, token });
});

// السائق وصل لنقطة الالتقاط → إشعار للركّاب المؤكّدين
r.post('/trips/:id/arrived', async (req, res) => {
  const trip = await ownTrip(req, res); if (!trip) return;
  const pax = await db.query("SELECT passenger_id FROM requests WHERE trip_id=? AND status IN ('accepted','onboard') AND passenger_id IS NOT NULL", [trip.id]);
  for (const p of pax) await addNotif(p.passenger_id, 'pin', 'green', 'وصل السائق لنقطة الالتقاط 📍', 'سائقك في انتظارك الآن — توجّه إليه', '/(passenger)/tracking');
  res.json({ ok: true, notified: pax.length });
});

r.post('/trips/:id/complete', async (req, res) => {
  const trip = await ownTrip(req, res); if (!trip) return;
  if (trip.status !== 'live' && trip.status !== 'scheduled') return bad(res, 'الرحلة ليست جارية');
  // التسوية المالية للمحفظة تشمل المدفوع محفظةً فقط — النقدي يُحصّله السائق مباشرةً
  const gross = round2((await db.queryOne("SELECT COALESCE(SUM(fare),0) s FROM requests WHERE trip_id=? AND status IN ('onboard','accepted') AND payment <> 'cash'", [trip.id])).s);
  const cashCollected = round2((await db.queryOne("SELECT COALESCE(SUM(fare),0) s FROM requests WHERE trip_id=? AND status IN ('onboard','accepted') AND payment = 'cash'", [trip.id])).s);
  const driverCountry = (await db.queryOne('SELECT country_code FROM users WHERE id=?', [req.user.id]) || {}).country_code || 'SA';
  const commission = await platformProfit(driverCountry, gross);
  const net = round2(gross - commission);
  // أكمل حجوزات الركّاب المرتبطة ونبّههم للتقييم قبل تغيير حالة الطلبات
  const doneReqs = await db.query("SELECT id, passenger_id FROM requests WHERE trip_id=? AND status IN ('onboard','accepted')", [trip.id]);
  for (const rq of doneReqs) {
    await db.execute("UPDATE bookings SET status='completed' WHERE request_id=? AND status NOT IN ('cancelled','completed')", [rq.id]);
    if (rq.passenger_id) await addNotif(rq.passenger_id, 'star', 'blue', 'وصلت إلى وجهتك ✓', 'قيّم رحلتك مع السائق', '/(passenger)/trips');
  }
  await db.execute("UPDATE requests SET status='dropped' WHERE trip_id=? AND status IN ('onboard','accepted')", [trip.id]);
  await db.execute("UPDATE trips SET status='completed', completed_at=? WHERE id=?", [now(), trip.id]);
  if (net > 0) {
    await db.execute('UPDATE users SET earnings = earnings + ? WHERE id=?', [net, req.user.id]);
    await addTxn(req.user.id, 'driver', 'أرباح رحلة (صافي)', net, 'in');
  }
  // سجّل عمولة المنصة الفعلية (حسب دولة السائق) كمعاملة قابلة للتدقيق
  if (commission > 0) await addTxn(req.user.id, 'platform', 'عمولة المنصة', commission, 'in');
  // سجّل المبلغ النقدي المُحصّل كمعلومة (لا يدخل المحفظة — بيد السائق)
  if (cashCollected > 0) await addTxn(req.user.id, 'driver', 'تحصيل نقدي (بيد السائق)', cashCollected, 'in');
  const earnings = round2((await db.queryOne('SELECT earnings FROM users WHERE id=?', [req.user.id])).earnings);
  res.json({ gross, commission, net, cashCollected, earnings });
});

// ============ البلاغات ============
r.post('/reports', async (req, res) => {
  const { category, note, against, tripId } = req.body || {};
  if (!category) return bad(res, 'نوع البلاغ مطلوب');
  const u = await db.queryOne('SELECT role FROM users WHERE id=?', [req.user.id]) || {};
  const reportId = await insertReturningId('reports',
    ['reporter_id','reporter_role','against','trip_id','category','note','status','created_at'],
    [req.user.id, u.role || 'passenger', against || null, tripId || null, String(category).slice(0,80), note ? String(note).slice(0,500) : null, 'open', Date.now()]);
  res.status(201).json({ ok: true, id: reportId });
});

// ============ تذاكر الدعم (من التطبيق → قسم الدعم بالإدارة، لا الرسائل) ============
r.post('/support', async (req, res) => {
  const subject = String(req.body?.subject || '').trim().slice(0, 120);
  const message = String(req.body?.message || '').trim().slice(0, 2000);
  if (!message) return bad(res, 'اكتب رسالتك للدعم');
  const id = await insertReturningId('support_tickets',
    ['user_id','user_name','subject','message','status','created_at'],
    [req.user.id, req.user.name || 'مستخدم', subject || 'استفسار عام', message, 'open', now()]);
  res.status(201).json({ ok: true, id });
});
r.get('/support', async (req, res) => {
  const rows = await db.query('SELECT id,subject,message,status,reply,created_at FROM support_tickets WHERE user_id=? ORDER BY created_at DESC LIMIT 50', [req.user.id]);
  res.json({ tickets: rows });
});

// ============ التسعير حسب المسافة ============
r.get('/pricing/quote', async (req, res) => {
  const km = Number(req.query.km);
  if (!Number.isFinite(km) || km < 0) return bad(res, 'مسافة غير صالحة');
  const code = (await db.queryOne('SELECT country_code FROM users WHERE id=?', [req.user.id]) || {}).country_code || 'SA';
  const c = await countrySetting(code);
  const seatPrice = await seatPriceForDistance(code, km);
  res.json({ country: code, km: round2(km), pricePerKm: c.price_per_km, kmCap: c.km_cap, seatPrice });
});

// ============ بحث الركّاب وحجوزاتهم ============
r.get('/rides/search', async (req, res) => {
  const dec = (v) => { let s = (v || '').toString().trim(); if (/%[0-9A-Fa-f]{2}/.test(s)) { try { s = decodeURIComponent(s); } catch {} } return s; };
  const to = dec(req.query.to);
  const city = dec(req.query.city);
  const country = dec(req.query.country).toUpperCase();
  const femaleOnly = String(req.query.femaleOnly || '') === '1';
  const kindParam = dec(req.query.kind); // city|intercity|public_bus|school_bus
  // إحداثيات الراكب لمطابقة المسار (board near O, drop near D)
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
  const O = (num(req.query.fromLat) != null && num(req.query.fromLng) != null) ? [num(req.query.fromLat), num(req.query.fromLng)] : null;
  const D = (num(req.query.toLat) != null && num(req.query.toLng) != null) ? [num(req.query.toLat), num(req.query.toLng)] : null;
  const corridorKm = Math.min(20, Math.max(2, num(req.query.radiusKm) || 6));   // نصف قطر الممرّ (افتراضي 6كم)

  const sql = `SELECT t.*, d.name AS driver_name, d.rating AS driver_rating, d.rating_count AS driver_rating_count, d.gender AS driver_gender, d.country_code AS driver_country,
            v.make, v.model, v.color, v.plate
     FROM trips t
     JOIN users d ON d.id = t.driver_id
     LEFT JOIN vehicles v ON v.user_id = t.driver_id
     WHERE t.status IN ('scheduled','live') AND t.total_seats > 0 AND t.driver_id != ?
     ORDER BY t.created_at DESC`;
  let trips = await db.query(sql, [req.user.id]);

  // النوع: عند التحديد فلتر مطابق؛ افتراضيًّا الكاربول فقط (city+intercity) — الباصات تُجلب صراحةً
  if (kindParam) trips = trips.filter(t => (t.kind || 'city') === kindParam);
  else trips = trips.filter(t => (t.kind || 'city') === 'city' || (t.kind || 'city') === 'intercity');

  // تطبيع: إزالة التشكيل العربي (عمّان=عمان) والمسافات والتطويل
  const norm = (x) => (x || '').toString().trim().replace(/[ً-ْٰـ]/g, '').replace(/\s+/g, '');
  const matchLabel = (term) => { const q = norm(term); return (t) => { const a = norm(t.to_label), b = norm(t.from_label); return (!!a && (a.includes(q) || q.includes(a))) || (!!b && (b.includes(q) || q.includes(b))); }; };
  if (country) trips = trips.filter(t => (t.driver_country || '').toUpperCase() === country);
  if (femaleOnly) trips = trips.filter(t => t.driver_gender === 'female' || t.gender_pref === 'female');

  // مطابقة ذكية هجينة: يَظهر المسار إن مرّ ممرّه قرب نقطتي الراكب (دائرة بنصف قطر corridorKm)
  // بنفس الاتجاه، أو إن طابق النص (الوجهة/المدينة). الأقرب للممرّ يظهر أولًا.
  let matchInfo = new Map();
  const hasGeo = !!(O || D);
  const hasText = !!(to || city);
  if (hasGeo || hasText) {
    trips = trips.filter(t => {
      const A = [t.from_lat, t.from_lng], B = [t.to_lat, t.to_lng];
      // 1) مطابقة الممرّ (إن توفّرت إحداثيات للرحلة وللراكب)
      if (hasGeo && validPt(A) && validPt(B)) {
        if (O && D) {
          const iO = pointToSegment(O, A, B), iD = pointToSegment(D, A, B);
          if (iO.dist <= corridorKm && iD.dist <= corridorKm && iO.t < iD.t) {
            matchInfo.set(t.id, { iO, iD, detourKm: Math.round((iO.dist + iD.dist) * 10) / 10 });
            return true;
          }
        } else {
          const P = O || D; const iP = pointToSegment(P, A, B);
          if (iP.dist <= corridorKm) { matchInfo.set(t.id, { iO: iP, iD: iP, detourKm: Math.round(iP.dist * 10) / 10 }); return true; }
        }
      }
      // 2) مطابقة قرب الوجهة/الانطلاق نقطةً لنقطة (إن للرحلة إحداثيات والوجهة محدّدة)
      if (D && validPt(B) && haversineKm(D, B) <= corridorKm) { matchInfo.set(t.id, { detourKm: Math.round(haversineKm(D, B) * 10) / 10 }); return true; }
      if (O && validPt(A) && haversineKm(O, A) <= corridorKm) { matchInfo.set(t.id, { detourKm: Math.round(haversineKm(O, A) * 10) / 10 }); return true; }
      // 3) مطابقة نصية (الوجهة أو المدينة) كحل احتياطي
      if (hasText && (matchLabel(to || '')(t) || matchLabel(city || '')(t))) return true;
      return false;
    });
    // الأقرب للممرّ أولًا، ثم مطابقات النص
    trips.sort((a, b) => (matchInfo.get(a.id)?.detourKm ?? 999) - (matchInfo.get(b.id)?.detourKm ?? 999));
  }

  const rides = trips.map(t => {
    const mi = matchInfo.get(t.id);
    return {
      id: t.id,
      driver: t.driver_name || 'سائق',
      rating: t.driver_rating || 5,
      ratingCount: Number(t.driver_rating_count) || 0,
      car: [t.make, t.model, t.color].filter(Boolean).join(' ') || 'مركبة',
      plate: t.plate || '',
      time: t.time || '', date: t.date || '',
      price: t.price_per_seat, seats: t.total_seats,
      from: t.from_label, to: t.to_label,
      fromCoord: [t.from_lat, t.from_lng], toCoord: [t.to_lat, t.to_lng],
      kind: t.kind || 'city',
      driverGender: t.driver_gender || 'male',
      femaleOnly: t.gender_pref === 'female',
      // معلومات المطابقة على المسار (نزول مبكر)
      ...(mi ? {
        alongRoute: true,
        boardNear: mi.iO.t < 0.08 ? t.from_label : 'على المسار قرب موقعك',
        dropNear: mi.iD.t > 0.92 ? t.to_label : 'قبل وجهة السائق — على مسارك',
        detourKm: mi.detourKm,
      } : {}),
    };
  });
  res.json({ rides });
});

// ============ خدمة «اطلب توصيلة» (الراكب يبثّ طلبه، السائق القريب يقبله) ============
// الراكب ينشئ طلب توصيلة (من ← إلى) — تُحسب الأجرة التقديرية بالمسافة وتُتحقّق المحفظة
r.post('/ride-requests', async (req, res) => {
  const { fromLabel, fromCoord, toLabel, toCoord, seats, note, time } = req.body || {};
  const A = Array.isArray(fromCoord) ? fromCoord : null, B = Array.isArray(toCoord) ? toCoord : null;
  if (!validPt(A) || !validPt(B)) return bad(res, 'حدّد نقطة الانطلاق والوجهة على الخريطة');
  const s = Math.max(1, Math.min(6, parseInt(seats, 10) || 1));
  const rideTime = (time && String(time).trim()) ? String(time).trim().slice(0, 20) : 'الآن';
  const u = await db.queryOne('SELECT name, wallet, country_code FROM users WHERE id=?', [req.user.id]);
  const km = haversineKm(A, B);
  const seatPrice = await seatPriceForDistance(u.country_code || 'JO', km);
  const fare = round2(seatPrice * s);   // سعر تقديري فقط — السعر النهائي يُتّفق عليه مع السائق
  // طلب نشط واحد: ألغِ أي طلب قيد التفاوض سابق
  await db.execute("UPDATE ride_requests SET status='cancelled' WHERE passenger_id=? AND status IN ('open','offered','countered')", [req.user.id]);
  const id = await insertReturningId('ride_requests',
    ['passenger_id','passenger_name','country_code','from_label','from_lat','from_lng','to_label','to_lat','to_lng','seats','fare','note','ride_time','status','created_at'],
    [req.user.id, u.name || 'راكب', u.country_code || 'JO', String(fromLabel || 'موقعي'), A[0], A[1], String(toLabel || 'الوجهة'), B[0], B[1], s, fare, note ? String(note).slice(0, 200) : null, rideTime, 'open', now()]);
  // إعلام السائقين الموثّقين في نفس البلد بطلب جديد (إشعار داخلي + دفع للجهاز)
  try {
    const cc = u.country_code || 'JO';
    const drivers = await db.query(
      "SELECT id FROM users WHERE role='driver' AND verified=1 AND id != ? AND (country_code=? OR country_code IS NULL) LIMIT 200",
      [req.user.id, cc]);
    for (const d of drivers) {
      await addNotif(d.id, 'pin', 'amber', 'طلب توصيلة جديد قربك 🚕',
        `${String(fromLabel || 'موقع')} ← ${String(toLabel || 'الوجهة')} · ${rideTime}`, '/(driver)/driderequests');
    }
  } catch (e) { /* لا يوقف نشر الطلب */ }
  res.status(201).json({ request: await db.queryOne('SELECT * FROM ride_requests WHERE id=?', [id]), fare });
});

r.get('/ride-requests/mine', async (req, res) => {
  const rows = await db.query(
    `SELECT rr.*, d.name driver_name FROM ride_requests rr
     LEFT JOIN users d ON d.id=rr.driver_id
     WHERE rr.passenger_id=? ORDER BY rr.created_at DESC LIMIT 5`, [req.user.id]);
  res.json({ requests: rows });
});

r.post('/ride-requests/:id/cancel', async (req, res) => {
  const r0 = await db.queryOne('SELECT * FROM ride_requests WHERE id=?', [Number(req.params.id)]);
  if (!r0 || r0.passenger_id !== req.user.id) return bad(res, 'الطلب غير موجود', 404);
  if (!['open', 'offered', 'countered'].includes(r0.status)) return bad(res, 'لا يمكن إلغاء هذا الطلب');
  await db.execute("UPDATE ride_requests SET status='cancelled' WHERE id=?", [r0.id]);
  if (r0.driver_id) await addNotif(r0.driver_id, 'x', 'red', 'ألغى الراكب طلب التوصيلة', `${r0.from_label} ← ${r0.to_label}`, '/(driver)/driderequests');
  res.json({ ok: true });
});

// للسائق: طلبات الركّاب المفتوحة (كلّ الطلبات في بلده، مرتّبة حسب القرب من موقعه)
r.get('/driver/ride-requests', async (req, res) => {
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
  const lat = num(req.query.lat), lng = num(req.query.lng);
  // radiusKm اختياري: عند تمريره نقصر النتائج على الدائرة، وإلا نعرض كل الطلبات مرتّبةً حسب القرب
  const radiusKm = num(req.query.radiusKm);
  const country = (await db.queryOne('SELECT country_code FROM users WHERE id=?', [req.user.id]) || {}).country_code;
  // طلبات مفتوحة متاحة للعرض + مفاوضاتي النشطة (عرضتُ عليها أو قابلني الراكب بسعر)
  let rows = await db.query(
    `SELECT rr.*, p.name passenger_name2 FROM ride_requests rr LEFT JOIN users p ON p.id=rr.passenger_id
     WHERE (rr.status='open' AND rr.passenger_id != ?) OR (rr.driver_id=? AND rr.status IN ('offered','countered'))
     ORDER BY rr.created_at DESC LIMIT 100`, [req.user.id, req.user.id]);
  if (country) rows = rows.filter(r => !r.country_code || r.country_code === country);
  if (lat != null && lng != null) {
    rows = rows.map(r => ({ r, d: haversineKm([lat, lng], [r.from_lat, r.from_lng]) }))
      .filter(x => radiusKm == null || (Number.isFinite(x.d) && x.d <= radiusKm))
      .sort((a, b) => (a.d ?? 1e9) - (b.d ?? 1e9))
      .map(x => ({ ...x.r, distanceKm: Number.isFinite(x.d) ? Math.round(x.d * 10) / 10 : null }));
  }
  res.json({ requests: rows });
});

// يُتمّ الاتفاق: يخصم الأجرة المتّفق عليها، وينشئ رحلة + حجزًا مؤكّدًا (ذرّيًّا)
async function finalizeRideRequest(rr, driverId, finalFare) {
  const fare = round2(finalFare);
  // 1) اطلب الطلب ذرّيًا (يمنع الإتمام المزدوج إن ضُغط مرّتين أو من جهازين)
  const claim = await db.execute("UPDATE ride_requests SET status='accepted', driver_id=? WHERE id=? AND status IN ('offered','countered')", [driverId, rr.id]);
  if (!claim.rowCount) return { error: 'لم يعد هذا الطلب متاحًا' };
  // 2) اخصم الأجرة ذرّيًا — وأعِد الطلب لحالته السابقة إن فشل الدفع
  const pay = await db.execute('UPDATE users SET wallet = wallet - ? WHERE id=? AND wallet >= ?', [fare, rr.passenger_id, fare]);
  if (!pay.rowCount) {
    await db.execute('UPDATE ride_requests SET status=? WHERE id=?', [rr.status, rr.id]);
    return { error: 'رصيد الراكب غير كافٍ لإتمام الطلب' };
  }
  const drv = await db.queryOne('SELECT name FROM users WHERE id=?', [driverId]);
  const veh = await db.queryOne('SELECT make,model,color,plate FROM vehicles WHERE user_id=?', [driverId]) || {};
  const tTime = rr.ride_time || 'الآن';
  const tripId = await insertReturningId('trips',
    ['driver_id','from_label','to_label','from_lat','from_lng','to_lat','to_lng','date','time','price_per_seat','total_seats','gender_pref','kind','status','created_at'],
    [driverId, rr.from_label, rr.to_label, rr.from_lat, rr.from_lng, rr.to_lat, rr.to_lng, 'اليوم', tTime, round2(fare / rr.seats), 0, 'any', 'city', 'scheduled', now()]);
  const reqId = await insertReturningId('requests',
    ['trip_id','passenger_id','passenger_name','rating','seats','pickup','pickup_lat','pickup_lng','fare','status'],
    [tripId, rr.passenger_id, rr.passenger_name || 'راكب', 5, rr.seats, rr.from_label, rr.from_lat, rr.from_lng, fare, 'accepted']);
  const car = [veh.make, veh.model, veh.color].filter(Boolean).join(' ') || 'مركبة';
  const bookingId = await insertReturningId('bookings',
    ['passenger_id','request_id','driver','driver_rating','car','plate','from_label','to_label','time','seats','fare','status','created_at'],
    [rr.passenger_id, reqId, drv.name || 'سائق', 5, car, veh.plate || '', rr.from_label, rr.to_label, '', rr.seats, fare, 'confirmed', now()]);
  await db.execute("UPDATE ride_requests SET trip_id=?, fare=? WHERE id=?", [tripId, fare, rr.id]);
  await addTxn(rr.passenger_id, 'passenger', `توصيلة · ${rr.from_label} ← ${rr.to_label}`, fare, 'out');
  await addNotif(rr.passenger_id, 'check', 'green', 'تم الاتفاق على رحلتك ✓', `${drv.name || 'سائق'} في طريقه إليك — تابع موقعه`, '/(passenger)/tracking');
  await addNotif(driverId, 'car', 'blue', 'تم الاتفاق على توصيلة', `${rr.from_label} ← ${rr.to_label} · ${fare}`, '/(driver)/dmytrips');
  return { tripId, bookingId, fare };
}

// السائق يعرض سعرًا على الراكب (أو يعيد العرض بعد سعر مقابل) → status='offered'
r.post('/ride-requests/:id/offer', async (req, res) => {
  const rr = await db.queryOne('SELECT * FROM ride_requests WHERE id=?', [Number(req.params.id)]);
  if (!rr) return bad(res, 'الطلب غير موجود', 404);
  if (rr.passenger_id === req.user.id) return bad(res, 'لا يمكنك العرض على طلبك');
  if (!['open', 'countered'].includes(rr.status)) return bad(res, 'هذا الطلب لم يعد متاحًا');
  if (rr.status === 'countered' && rr.driver_id && rr.driver_id !== req.user.id) return bad(res, 'الطلب قيد التفاوض مع سائق آخر');
  const fare = round2(Number(req.body?.fare) || rr.fare);
  if (!(fare > 0)) return bad(res, 'سعر غير صالح');
  // ذرّيًا: لا يعرض إلا على طلب ما زال مفتوحًا أو مُقابلًا لنفس السائق (يمنع سباق سائقَين)
  const upd = await db.execute(
    "UPDATE ride_requests SET status='offered', driver_id=?, offered_fare=?, offer_by='driver' WHERE id=? AND (status='open' OR (status='countered' AND driver_id=?))",
    [req.user.id, fare, rr.id, req.user.id]);
  if (!upd.rowCount) return bad(res, 'هذا الطلب لم يعد متاحًا');
  const drv = await db.queryOne('SELECT name FROM users WHERE id=?', [req.user.id]);
  await addNotif(rr.passenger_id, 'wallet', 'amber', 'عرض سعر لتوصيلتك 🚕', `${drv ? drv.name : 'سائق'} عرض ${fare} — وافق أو اقترح سعرًا`, '/(passenger)/myrequests');
  res.json({ ok: true, status: 'offered', offeredFare: fare });
});

// الراكب يقترح سعرًا مقابلًا → status='countered'
r.post('/ride-requests/:id/counter', async (req, res) => {
  const rr = await db.queryOne('SELECT * FROM ride_requests WHERE id=?', [Number(req.params.id)]);
  if (!rr || rr.passenger_id !== req.user.id) return bad(res, 'الطلب غير موجود', 404);
  if (rr.status !== 'offered') return bad(res, 'لا يوجد عرض للردّ عليه');
  const fare = round2(Number(req.body?.fare) || 0);
  if (!(fare > 0)) return bad(res, 'سعر غير صالح');
  await db.execute("UPDATE ride_requests SET status='countered', offered_fare=?, offer_by='passenger' WHERE id=?", [fare, rr.id]);
  if (rr.driver_id) await addNotif(rr.driver_id, 'wallet', 'amber', 'سعر مقابل من الراكب', `اقترح الراكب ${fare} لِـ ${rr.from_label} ← ${rr.to_label} — وافق أو ارفض`, '/(driver)/driderequests');
  res.json({ ok: true, status: 'countered', offeredFare: fare });
});

// موافقة نهائية على السعر المعروض حاليًا → يُتمّ الاتفاق
r.post('/ride-requests/:id/agree', async (req, res) => {
  const rr = await db.queryOne('SELECT * FROM ride_requests WHERE id=?', [Number(req.params.id)]);
  if (!rr) return bad(res, 'الطلب غير موجود', 404);
  const fare = round2(rr.offered_fare != null ? rr.offered_fare : rr.fare);
  let driverId = rr.driver_id;
  if (rr.status === 'offered') {
    // عرض السائق بانتظار موافقة الراكب
    if (rr.passenger_id !== req.user.id) return bad(res, 'غير مصرّح', 403);
  } else if (rr.status === 'countered') {
    // سعر الراكب المقابل بانتظار موافقة السائق
    if (rr.driver_id !== req.user.id) return bad(res, 'غير مصرّح', 403);
    driverId = req.user.id;
  } else return bad(res, 'لا يوجد عرض ساري للموافقة');
  if (!driverId) return bad(res, 'تعذّر تحديد السائق');
  const r2 = await finalizeRideRequest(rr, driverId, fare);
  if (r2.error) return bad(res, r2.error);
  res.status(201).json({ ok: true, ...r2 });
});

// رفض السعر المقابل (من السائق) → يُلغى الطلب
r.post('/ride-requests/:id/decline', async (req, res) => {
  const rr = await db.queryOne('SELECT * FROM ride_requests WHERE id=?', [Number(req.params.id)]);
  if (!rr) return bad(res, 'الطلب غير موجود', 404);
  if (rr.driver_id !== req.user.id) return bad(res, 'غير مصرّح', 403);
  if (!['offered', 'countered'].includes(rr.status)) return bad(res, 'لا شيء لرفضه');
  await db.execute("UPDATE ride_requests SET status='cancelled' WHERE id=?", [rr.id]);
  await addNotif(rr.passenger_id, 'x', 'red', 'اعتذر السائق عن طلبك', `${rr.from_label} ← ${rr.to_label} — يمكنك نشر طلب جديد`, '/(passenger)/requestride');
  res.json({ ok: true, status: 'cancelled' });
});

// ===== تتبّع الباصات الحيّ (حافلة عامة/مدرسية) =====
r.get('/buses', async (req, res) => {
  const kindParam = (req.query.kind || '').toString();
  const kinds = ['public_bus', 'school_bus'].includes(kindParam) ? [kindParam] : ['public_bus', 'school_bus'];
  const ph = kinds.map(() => '?').join(',');
  const rows = await db.query(
    `SELECT t.id, t.from_label, t.to_label, t.from_lat, t.from_lng, t.to_lat, t.to_lng, t.time, t.kind, t.driver_lat, t.driver_lng, t.driver_loc_at, t.status,
            d.name driver_name, v.plate
     FROM trips t JOIN users d ON d.id=t.driver_id LEFT JOIN vehicles v ON v.user_id=t.driver_id
     WHERE t.kind IN (${ph}) AND t.status IN ('scheduled','live') ORDER BY t.created_at DESC LIMIT 100`, kinds);
  res.json({ buses: rows.map(t => ({
    id: t.id, name: t.driver_name || 'حافلة', plate: t.plate || '', kind: t.kind,
    from: t.from_label, to: t.to_label, time: t.time, status: t.status,
    fromCoord: [t.from_lat, t.from_lng], toCoord: [t.to_lat, t.to_lng],
    driver: (t.driver_lat != null && t.driver_lng != null) ? [t.driver_lat, t.driver_lng] : null,
    locAt: t.driver_loc_at,
  })) });
});
// موقع باص محدّد (للتتبّع المباشر)
r.get('/buses/:id/live', async (req, res) => {
  const t = await db.queryOne('SELECT id,from_lat,from_lng,to_lat,to_lng,driver_lat,driver_lng,driver_loc_at,status,kind FROM trips WHERE id=?', [Number(req.params.id)]);
  if (!t) return bad(res, 'الحافلة غير موجودة', 404);
  res.json({
    status: t.status,
    driver: (t.driver_lat != null && t.driver_lng != null) ? [t.driver_lat, t.driver_lng] : null,
    locAt: t.driver_loc_at, fromCoord: [t.from_lat, t.from_lng], toCoord: [t.to_lat, t.to_lng],
  });
});

r.post('/bookings', async (req, res) => {
  const { rideId, seats, to, preferences, note, promoCode, payment, pickupCoord } = req.body || {};
  const trip = await db.queryOne(
    `SELECT t.*, d.name AS driver_name, d.rating AS driver_rating,
            v.make, v.model, v.color, v.plate
     FROM trips t JOIN users d ON d.id = t.driver_id
     LEFT JOIN vehicles v ON v.user_id = t.driver_id
     WHERE t.id = ?`, [Number(rideId)]);
  if (!trip) return bad(res, 'الرحلة غير موجودة', 404);
  if (!['scheduled', 'live'].includes(trip.status)) return bad(res, 'هذه الرحلة لم تعد متاحة');
  if (trip.driver_id === req.user.id) return bad(res, 'لا يمكنك حجز رحلتك');
  const s = Number(seats);
  if (!Number.isInteger(s) || s < 1 || s > trip.total_seats) return bad(res, `المقاعد المتاحة: ${trip.total_seats}`);
  const cash = payment === 'cash';
  const P = Array.isArray(pickupCoord) && validPt(pickupCoord) ? pickupCoord : null;
  // §8: الحجز أثناء رحلة جارية — يُمنع إن تجاوز السائق نقطة الراكب (الأقرب للوجهة)
  if (trip.status === 'live' && trip.driver_lat != null && trip.driver_lng != null) {
    const dest = [trip.to_lat, trip.to_lng];
    const pick = P || [trip.from_lat, trip.from_lng];
    if (haversineKm([trip.driver_lat, trip.driver_lng], dest) <= haversineKm(pick, dest) + 0.3) {
      return bad(res, 'السائق تجاوز نقطتك — لم يعد بالإمكان الانضمام لهذه الرحلة');
    }
  }
  const baseFare = round2(trip.price_per_seat * s);
  const u = await db.queryOne('SELECT wallet, name, rating, gender, country_code FROM users WHERE id=?', [req.user.id]);
  // تطبيق تفضيل الجنس: رحلة «نساء فقط» تُحجز فقط من راكبة
  if (trip.gender_pref === 'female' && u.gender !== 'female') return bad(res, 'هذه الرحلة مخصّصة للنساء فقط');

  // كود خصم بنسبة مئوية يُطبَّق تلقائيًا على الأجرة (إن كان صالحًا)
  let appliedPromo = null, discount = 0;
  if (promoCode) {
    const code = String(promoCode).trim().toUpperCase();
    const p = await db.queryOne('SELECT * FROM promos WHERE UPPER(code)=?', [code]);
    if (!p || !Number(p.active)) return bad(res, 'كود الخصم غير صالح');
    if (p.discount_type !== 'percent') return bad(res, 'هذا الكود يُضاف رصيدًا من المحفظة، لا يُطبَّق على الحجز');
    if (p.expires_at && Number(p.expires_at) < Date.now()) return bad(res, 'انتهت صلاحية كود الخصم');
    if (p.country && p.country !== u.country_code) return bad(res, 'كود الخصم غير متاح في بلدك');
    if (Number(p.max_uses) > 0 && Number(p.used_count) >= Number(p.max_uses)) return bad(res, 'انتهت مرّات استخدام الكود');
    const used = await db.queryOne('SELECT id FROM promo_redemptions WHERE promo_id=? AND user_id=?', [p.id, req.user.id]);
    if (used) return bad(res, 'سبق أن استخدمت هذا الكود');
    discount = round2(baseFare * Number(p.discount_value));
    appliedPromo = p;
  }
  const fare = round2(baseFare - discount);
  if (!cash && u.wallet < fare) return bad(res, 'الرصيد غير كافٍ — اشحن محفظتك أو اختر الدفع نقدًا');

  // 1) حجز المقاعد ذرّيًا (يمنع البيع الزائد عند الحجز المتزامن)
  const seatRes = await db.execute(
    "UPDATE trips SET total_seats = total_seats - ? WHERE id=? AND status IN ('scheduled','live') AND total_seats >= ?",
    [s, trip.id, s]);
  if (!seatRes.rowCount) return bad(res, `المقاعد المتاحة لم تعد كافية`);
  // 2) الدفع: نقدًا = بلا خصم محفظة (يُحصّل من السائق)؛ محفظة = خصم ذرّي وإلا أعد المقاعد
  if (!cash) {
    const payRes = await db.execute('UPDATE users SET wallet = wallet - ? WHERE id=? AND wallet >= ?', [fare, req.user.id, fare]);
    if (!payRes.rowCount) {
      await db.execute('UPDATE trips SET total_seats = total_seats + ? WHERE id=?', [s, trip.id]);
      return bad(res, 'الرصيد غير كافٍ — اشحن محفظتك أو اختر الدفع نقدًا');
    }
    await addTxn(req.user.id, 'passenger', `رحلة · ${trip.from_label} ← ${trip.to_label}`, fare, 'out');
  }

  const car = [trip.make, trip.model, trip.color].filter(Boolean).join(' ') || 'مركبة';
  const pm = cash ? 'cash' : 'wallet';
  const pickLat = P ? P[0] : trip.from_lat, pickLng = P ? P[1] : trip.from_lng;
  const prefsJson = Array.isArray(preferences) ? JSON.stringify(preferences.slice(0, 12)) : null;
  const paxNote = note ? String(note).slice(0, 300) : null;
  const requestId = await insertReturningId('requests',
    ['trip_id','passenger_id','passenger_name','rating','seats','pickup','pickup_lat','pickup_lng','fare','status','payment'],
    [trip.id, req.user.id, u.name || 'راكب', u.rating || 5, s, trip.from_label, pickLat, pickLng, fare, 'pending', pm]);
  const bookingId = await insertReturningId('bookings',
    ['passenger_id','request_id','driver','driver_rating','car','plate','from_label','to_label','time','seats','fare','preferences','pax_note','status','payment','created_at'],
    [req.user.id, requestId, trip.driver_name, trip.driver_rating, car, trip.plate || '', trip.from_label, trip.to_label, trip.time, s, fare, prefsJson, paxNote, 'pending_driver', pm, now()]);
  // سجّل استخدام كود الخصم (مرّة واحدة لكل مستخدم)
  if (appliedPromo && discount > 0) {
    await db.execute('UPDATE promos SET used_count = used_count + 1 WHERE id=?', [appliedPromo.id]);
    await insertReturningId('promo_redemptions', ['promo_id', 'user_id', 'amount', 'created_at'], [appliedPromo.id, req.user.id, discount, now()]);
    await addNotif(req.user.id, 'wallet', 'green', 'طُبّق كود الخصم 🎁', `وفّرت ${discount} ${await userCur(req.user.id)} على رحلتك`);
  }
  // المبلغ محجوز (مخصوم) بانتظار موافقة السائق — يُسترجع تلقائيًا عند الرفض
  await addNotif(req.user.id, 'time', 'amber', 'تم إرسال طلبك', `بانتظار موافقة السائق · ${trip.from_label} ← ${trip.to_label}`, `/(passenger)/tracking?bookingId=${bookingId}`);
  await addNotif(trip.driver_id, 'user', 'blue', 'طلب حجز جديد', `${u.name || 'راكب'} · ${s} مقعد`, `/(driver)/requests?tripId=${trip.id}`);

  const booking = await db.queryOne('SELECT * FROM bookings WHERE id=?', [bookingId]);
  const walletRow = await db.queryOne('SELECT wallet FROM users WHERE id=?', [req.user.id]);
  res.status(201).json({ booking, wallet: round2(walletRow.wallet) });
});

r.get('/bookings', async (req, res) => {
  res.json({ bookings: await db.query('SELECT * FROM bookings WHERE passenger_id=? ORDER BY created_at DESC', [req.user.id]) });
});

r.post('/bookings/:id/status', async (req, res) => {
  const b = await db.queryOne('SELECT * FROM bookings WHERE id=?', [Number(req.params.id)]);
  if (!b) return bad(res, 'الحجز غير موجود', 404);
  if (b.passenger_id !== req.user.id) return bad(res, 'غير مصرّح', 403);
  const status = String(req.body?.status || '');
  const allowed = ['enroute', 'intrip', 'completed', 'cancelled'];
  if (!allowed.includes(status)) return bad(res, 'حالة غير صالحة');
  if (['completed', 'cancelled'].includes(b.status)) return bad(res, 'الحجز منتهٍ');
  await db.execute('UPDATE bookings SET status=? WHERE id=?', [status, b.id]);
  let wallet;
  if (status === 'cancelled') {
    // استرجاع المحفظة فقط للحجوزات المدفوعة محفظةً (النقدي لم يُخصم)
    if (b.payment !== 'cash') {
      await db.execute('UPDATE users SET wallet = wallet + ? WHERE id=?', [b.fare, req.user.id]);
      await addTxn(req.user.id, 'passenger', 'استرجاع رحلة ملغاة', b.fare, 'in');
      await addNotif(req.user.id, 'wallet', 'amber', 'أُلغيت الرحلة وأُعيد المبلغ', `${b.fare} ${await userCur(req.user.id)} إلى محفظتك`);
    }
    // أعد المقاعد للرحلة وحدّث الطلب المرتبط وأبلغ السائق
    if (b.request_id) {
      const rq = await db.queryOne('SELECT r.*, t.driver_id, t.from_label, t.to_label FROM requests r JOIN trips t ON t.id=r.trip_id WHERE r.id=?', [b.request_id]);
      if (rq && ['pending', 'accepted'].includes(rq.status)) {
        await db.execute('UPDATE trips SET total_seats = total_seats + ? WHERE id=?', [rq.seats, rq.trip_id]);
        await db.execute("UPDATE requests SET status='cancelled' WHERE id=?", [rq.id]);
        await addNotif(rq.driver_id, 'x', 'amber', 'ألغى راكب حجزه', `${rq.from_label} ← ${rq.to_label}`, '/(driver)/requests');
      }
    }
    wallet = round2((await db.queryOne('SELECT wallet FROM users WHERE id=?', [req.user.id])).wallet);
  }
  res.json({ booking: await db.queryOne('SELECT * FROM bookings WHERE id=?', [b.id]), ...(wallet !== undefined ? { wallet } : {}) });
});

// ============ التقييمات (حقيقية — تبدأ بدون تقييم) ============
// الراكب يقيّم سائق رحلته
r.post('/bookings/:id/rate', async (req, res) => {
  const b = await db.queryOne('SELECT * FROM bookings WHERE id=?', [Number(req.params.id)]);
  if (!b) return bad(res, 'الحجز غير موجود', 404);
  if (b.passenger_id !== req.user.id) return bad(res, 'غير مصرّح', 403);
  if (Number(b.rated)) return bad(res, 'سبق تقييم هذه الرحلة');
  // أوجد سائق الرحلة عبر الطلب المرتبط
  let driverId = null;
  if (b.request_id) {
    const rq = await db.queryOne('SELECT t.driver_id FROM requests r JOIN trips t ON t.id=r.trip_id WHERE r.id=?', [b.request_id]);
    driverId = rq ? rq.driver_id : null;
  }
  if (!driverId) return bad(res, 'تعذّر تحديد السائق');
  await applyRating(driverId, req.body?.stars);
  await db.execute('UPDATE bookings SET rated=1 WHERE id=?', [b.id]);
  // خزّن المراجعة (وسوم + تعليق) للأرشفة والإشراف
  const stars = Math.max(1, Math.min(5, Math.round(Number(req.body?.stars) || 0)));
  const tags = Array.isArray(req.body?.tags) ? JSON.stringify(req.body.tags.slice(0, 8)) : null;
  const comment = req.body?.comment ? String(req.body.comment).slice(0, 400) : null;
  if (stars) await insertReturningId('reviews',
    ['target_id','reviewer_id','booking_id','stars','tags','comment','created_at'],
    [driverId, req.user.id, b.id, stars, tags, comment, now()]);
  res.json({ ok: true });
});
// السائق يقيّم راكبًا (عبر طلب الحجز) — مع وسوم وتعليق
r.post('/requests/:id/rate', async (req, res) => {
  const q = await db.queryOne('SELECT r.*, t.driver_id FROM requests r JOIN trips t ON t.id=r.trip_id WHERE r.id=?', [Number(req.params.id)]);
  if (!q) return bad(res, 'الطلب غير موجود', 404);
  if (q.driver_id !== req.user.id) return bad(res, 'غير مصرّح', 403);
  if (Number(q.rated)) return bad(res, 'سبق التقييم');
  if (!q.passenger_id) return bad(res, 'لا يمكن تقييم هذا الراكب');
  await applyRating(q.passenger_id, req.body?.stars);
  await db.execute('UPDATE requests SET rated=1 WHERE id=?', [q.id]);
  // خزّن المراجعة (وسوم + تعليق) — الهدف الراكب، المُقيِّم السائق
  const stars = Math.max(1, Math.min(5, Math.round(Number(req.body?.stars) || 0)));
  const tags = Array.isArray(req.body?.tags) ? JSON.stringify(req.body.tags.slice(0, 8)) : null;
  const comment = req.body?.comment ? String(req.body.comment).slice(0, 400) : null;
  if (stars) await insertReturningId('reviews',
    ['target_id','reviewer_id','booking_id','stars','tags','comment','created_at'],
    [q.passenger_id, req.user.id, null, stars, tags, comment, now()]);
  res.json({ ok: true });
});

// ============ الرسائل ============
r.get('/threads', async (req, res) => {
  const threads = await db.query('SELECT * FROM threads WHERE user_id=?', [req.user.id]);
  for (const t of threads) t.messages = await db.query('SELECT id,text,mine,created_at at FROM messages WHERE thread_id=? ORDER BY created_at ASC', [t.id]);
  res.json({ threads });
});

// يجد محادثة المالك مع الطرف الآخر أو يُنشئها
async function getOrCreateThread(ownerId, peerId, peerName) {
  let th = await db.queryOne('SELECT * FROM threads WHERE user_id=? AND peer_id=?', [ownerId, peerId]);
  if (th) return th;
  const initial = (String(peerName || '؟').trim()[0]) || '؟';
  const id = await insertReturningId('threads', ['user_id', 'peer_name', 'initial', 'peer_id'], [ownerId, peerName || 'مستخدم', initial, peerId]);
  return await db.queryOne('SELECT * FROM threads WHERE id=?', [id]);
}

// يفتح محادثة بين الراكب والسائق عبر حجز (bookingId) أو طلب (requestId) — ويجهّز محادثة الطرفين
r.post('/threads/open', async (req, res) => {
  const { bookingId, requestId } = req.body || {};
  let passengerId = null, driverId = null;
  if (bookingId) {
    const b = await db.queryOne('SELECT * FROM bookings WHERE id=?', [Number(bookingId)]);
    if (!b) return bad(res, 'الحجز غير موجود', 404);
    passengerId = b.passenger_id;
    if (b.request_id) { const rq = await db.queryOne('SELECT t.driver_id FROM requests r JOIN trips t ON t.id=r.trip_id WHERE r.id=?', [b.request_id]); driverId = rq && rq.driver_id; }
  } else if (requestId) {
    const rq = await db.queryOne('SELECT r.passenger_id, t.driver_id FROM requests r JOIN trips t ON t.id=r.trip_id WHERE r.id=?', [Number(requestId)]);
    if (!rq) return bad(res, 'الطلب غير موجود', 404);
    passengerId = rq.passenger_id; driverId = rq.driver_id;
  } else return bad(res, 'بيانات غير كافية لفتح المحادثة');
  if (!passengerId || !driverId) return bad(res, 'تعذّر تحديد طرفَي المحادثة');
  if (req.user.id !== passengerId && req.user.id !== driverId) return bad(res, 'غير مصرّح', 403);
  const peerId = req.user.id === passengerId ? driverId : passengerId;
  const me = await db.queryOne('SELECT name FROM users WHERE id=?', [req.user.id]);
  const peer = await db.queryOne('SELECT name FROM users WHERE id=?', [peerId]);
  const mineThread = await getOrCreateThread(req.user.id, peerId, peer ? peer.name : 'مستخدم');
  await getOrCreateThread(peerId, req.user.id, me ? me.name : 'مستخدم'); // جهّز محادثة الطرف الآخر مسبقًا
  const messages = await db.query('SELECT id,text,mine,created_at at FROM messages WHERE thread_id=? ORDER BY created_at ASC', [mineThread.id]);
  res.status(201).json({ thread: { ...mineThread, messages } });
});

r.post('/threads/:id/messages', async (req, res) => {
  const t = await db.queryOne('SELECT * FROM threads WHERE id=?', [Number(req.params.id)]);
  if (!t) return bad(res, 'المحادثة غير موجودة', 404);
  if (t.user_id !== req.user.id) return bad(res, 'غير مصرّح', 403);
  const text = String(req.body?.text || '').trim();
  if (!text || text.length > 1000) return bad(res, 'نص الرسالة غير صالح');
  await db.execute('INSERT INTO messages (thread_id,text,mine,created_at) VALUES (?,?,1,?)', [t.id, text, now()]);
  // مرّر الرسالة لمحادثة الطرف الآخر (mine=0) مع إشعار فوري — لمحادثات الراكب↔السائق
  if (t.peer_id) {
    const me = await db.queryOne('SELECT name FROM users WHERE id=?', [req.user.id]);
    const peer = await db.queryOne('SELECT role FROM users WHERE id=?', [t.peer_id]);
    const peerThread = await getOrCreateThread(t.peer_id, req.user.id, me ? me.name : 'مستخدم');
    await db.execute('INSERT INTO messages (thread_id,text,mine,created_at) VALUES (?,?,0,?)', [peerThread.id, text, now()]);
    const route = peer && peer.role === 'driver' ? '/(driver)/dchat' : '/(passenger)/messages';
    await addNotif(t.peer_id, 'messages', 'blue', `رسالة من ${me ? me.name : 'مستخدم'}`, text.slice(0, 80), route);
  }
  const messages = await db.query('SELECT id,text,mine,created_at at FROM messages WHERE thread_id=? ORDER BY created_at ASC', [t.id]);
  res.status(201).json({ messages });
});

// ============ الإشعارات ============
r.get('/notifications', async (req, res) => {
  res.json({ notifications: await db.query('SELECT id,icon,tone,title,sub,to_route,created_at at FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 50', [req.user.id]) });
});

// ============ الأماكن ============
r.get('/places', async (req, res) => res.json({ places: await db.query('SELECT * FROM places WHERE user_id=?', [req.user.id]) }));
r.post('/places', async (req, res) => {
  const { label, sub, lat, lng } = req.body || {};
  if (!label) return bad(res, 'اسم المكان مطلوب');
  const placeId = await insertReturningId('places', ['user_id','label','sub','lat','lng'], [req.user.id, label, sub || '', lat ?? null, lng ?? null]);
  res.status(201).json({ place: await db.queryOne('SELECT * FROM places WHERE id=?', [placeId]) });
});

// ============ البطاقات ============
r.get('/cards', async (req, res) => res.json({ cards: await db.query('SELECT id,brand,last4,exp,holder FROM cards WHERE user_id=?', [req.user.id]) }));
r.post('/cards', async (req, res) => {
  const { last4, exp, holder, brand } = req.body || {};
  if (!last4 || !/^\d{4}$/.test(String(last4))) return bad(res, 'آخر 4 أرقام مطلوبة');
  const cardId = await insertReturningId('cards', ['user_id','brand','last4','exp','holder'], [req.user.id, brand || 'mada', String(last4), exp || '••/••', holder || 'صاحب البطاقة']);
  res.status(201).json({ card: await db.queryOne('SELECT id,brand,last4,exp,holder FROM cards WHERE id=?', [cardId]) });
});
r.delete('/cards/:id', async (req, res) => {
  await db.execute('DELETE FROM cards WHERE id=? AND user_id=?', [Number(req.params.id), req.user.id]);
  res.json({ ok: true });
});

module.exports = r;
