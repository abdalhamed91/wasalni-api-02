// وحدة إدارة وصلني — مصادقة المسؤول + تجميع البيانات + إجراءات التشغيل
const express = require('express');
const jwt = require('jsonwebtoken');
const PG_BOOL = require('./database').kind === 'postgres';
const { db, now, round2, insertReturningId, COMMISSION_RATE, SERVICE_COUNTRIES, addNotif, getConfig, setConfig, commissionRate, serviceCountries, allCountrySettings, setCountrySetting, countrySetting } = require('./db');

const SECRET = process.env.JWT_SECRET || 'wasalni-dev-secret-change-in-production';
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'wasalni-admin';   // كلمة مرور لوحة الإدارة (غيّرها في الإنتاج)

const r = express.Router();
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });

// ---------- مصادقة المسؤول ----------
r.post('/login', async (req, res) => {
  const { passcode } = req.body || {};
  if (String(passcode || '') !== ADMIN_SECRET) return bad(res, 'كلمة مرور الإدارة غير صحيحة', 401);
  const token = jwt.sign({ admin: true }, SECRET, { expiresIn: '7d' });
  res.json({ token });
});

function adminRequired(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return bad(res, 'مطلوب تسجيل دخول الإدارة', 401);
  try {
    const p = jwt.verify(token, SECRET);
    if (!p.admin) return bad(res, 'صلاحيات غير كافية', 403);
    next();
  } catch { return bad(res, 'جلسة إدارة غير صالحة', 401); }
}
r.use(adminRequired);

// ---------- لوحة المعلومات: إحصاءات حيّة ----------
r.get('/stats', async (_req, res) => {
  const users = (await db.queryOne('SELECT COUNT(*) c FROM users', [])).c;
  const drivers = (await db.queryOne("SELECT COUNT(*) c FROM users WHERE role='driver'", [])).c;
  const passengers = users - drivers;
  const verified = (await db.queryOne(`SELECT COUNT(*) c FROM users WHERE role='driver' AND verified=${PG_BOOL ? 'true' : '1'}`, [])).c;
  const pendingVerify = drivers - verified;
  const tripsTotal = (await db.queryOne('SELECT COUNT(*) c FROM trips', [])).c;
  const tripsCompleted = (await db.queryOne("SELECT COUNT(*) c FROM trips WHERE status='completed'", [])).c;
  const tripsLive = (await db.queryOne("SELECT COUNT(*) c FROM trips WHERE status='live'", [])).c;
  const bookings = (await db.queryOne('SELECT COUNT(*) c FROM bookings', [])).c;
  const bookingsCompleted = (await db.queryOne("SELECT COUNT(*) c FROM bookings WHERE status='completed'", [])).c;
  // الإيراد = مجموع أجور الحجوزات غير الملغاة ؛ العمولة = صافي دخل المنصة
  const gross = round2((await db.queryOne("SELECT COALESCE(SUM(fare),0) s FROM bookings WHERE status!='cancelled'", [])).s);
  const commission = round2(gross * await commissionRate());
  const walletsTotal = round2((await db.queryOne('SELECT COALESCE(SUM(wallet),0) s FROM users', [])).s);
  const earningsOwed = round2((await db.queryOne('SELECT COALESCE(SUM(earnings),0) s FROM users', [])).s);
  const openReports = (await db.queryOne("SELECT COUNT(*) c FROM reports WHERE status='open'", [])).c;
  res.json({
    users, drivers, passengers, verified, pendingVerify, openReports,
    tripsTotal, tripsCompleted, tripsLive, bookings, bookingsCompleted,
    gross, commission, walletsTotal, earningsOwed,
    commissionRate: await commissionRate(), serviceCountries: await serviceCountries(),
  });
});

// ---------- المستخدمون ----------
r.get('/users', async (req, res) => {
  const role = req.query.role;
  const rows = await db.query(
    `SELECT u.id,u.name,u.phone,u.dial,u.country_code,u.role,u.rating,u.wallet,u.earnings,u.status,u.verified,u.created_at
     FROM users u ${role ? 'WHERE u.role=?' : ''} ORDER BY u.created_at DESC`
  , [...(role ? [role] : [])]);
  const out = [];
  for (const u of rows) {
    out.push({
      ...u,
      trips: (await db.queryOne('SELECT COUNT(*) c FROM trips WHERE driver_id=?', [u.id])).c,
      bookings: (await db.queryOne('SELECT COUNT(*) c FROM bookings WHERE passenger_id=?', [u.id])).c,
      vehicle: await db.queryOne('SELECT make,model,year,color,plate FROM vehicles WHERE user_id=?', [u.id]) || null,
    });
  }
  res.json({ users: out });
});

// إيقaف/تفعيل مستخدم
r.patch('/users/:id/status', async (req, res) => {
  const status = String(req.body?.status || '');
  if (!['active', 'suspended'].includes(status)) return bad(res, 'حالة غير صالحة');
  const u = await db.queryOne('SELECT id FROM users WHERE id=?', [Number(req.params.id)]);
  if (!u) return bad(res, 'المستخدم غير موجود', 404);
  await db.execute('UPDATE users SET status=? WHERE id=?', [status, u.id]);
  res.json({ id: u.id, status });
});

// تفاصيل مستخدم كاملة (مع المركبة والإحصاءات)
r.get('/users/:id', async (req, res) => {
  const id = Number(req.params.id);
  const u = await db.queryOne('SELECT * FROM users WHERE id=?', [id]);
  if (!u) return bad(res, 'المستخدم غير موجود', 404);
  const vehicle = await db.queryOne('SELECT make,model,year,color,plate,capacity FROM vehicles WHERE user_id=?', [id]) || null;
  const tripsCount = (await db.queryOne('SELECT COUNT(*) c FROM trips WHERE driver_id=?', [id])).c;
  const bookingsCount = (await db.queryOne('SELECT COUNT(*) c FROM bookings WHERE passenger_id=?', [id])).c;
  const recentBookings = await db.query('SELECT from_label,to_label,fare,status,created_at FROM bookings WHERE passenger_id=? ORDER BY created_at DESC LIMIT 5', [id]);
  const recentTrips = await db.query('SELECT from_label,to_label,price_per_seat,status,created_at FROM trips WHERE driver_id=? ORDER BY created_at DESC LIMIT 5', [id]);
  let docs = null; try { docs = u.docs ? JSON.parse(u.docs) : null; } catch {}
  delete u.verify_submitted_at;
  res.json({ user: u, vehicle, docs, stats: { tripsCount, bookingsCount }, recentBookings, recentTrips });
});

// تعديل بيانات مستخدم من الإدارة
r.patch('/users/:id', async (req, res) => {
  const id = Number(req.params.id);
  const u = await db.queryOne('SELECT id FROM users WHERE id=?', [id]);
  if (!u) return bad(res, 'المستخدم غير موجود', 404);
  const { name, email, city, wallet, rating, role, gender, verified } = req.body || {};
  await db.execute(`UPDATE users SET
      name=COALESCE(?,name), email=COALESCE(?,email), city=COALESCE(?,city),
      wallet=COALESCE(?,wallet), rating=COALESCE(?,rating), role=COALESCE(?,role),
      gender=COALESCE(?,gender), verified=COALESCE(?,verified)
    WHERE id=?`,
    [name ?? null, email ?? null, city ?? null,
     wallet != null ? Number(wallet) : null, rating != null ? Number(rating) : null,
     role ?? null, gender ?? null,
     verified != null ? (PG_BOOL ? !!verified : (verified ? 1 : 0)) : null, id]);
  const updated = await db.queryOne('SELECT * FROM users WHERE id=?', [id]);
  res.json({ user: updated });
});

// صندوق وارد كل محادثات الدعم (آخر رسالة + هل تحتاج ردًّا)
r.get('/conversations', async (_req, res) => {
  const threads = await db.query(
    "SELECT th.id, th.user_id, u.name user_name, u.phone, u.dial FROM threads th JOIN users u ON u.id=th.user_id WHERE th.peer_name='دعم وصلني' ORDER BY th.id DESC LIMIT 300", []);
  const out = [];
  for (const t of threads) {
    const last = await db.queryOne('SELECT text, mine, created_at FROM messages WHERE thread_id=? ORDER BY created_at DESC LIMIT 1', [t.id]);
    out.push({
      userId: t.user_id, userName: t.user_name, phone: (t.dial || '') + (t.phone || ''),
      lastText: last ? last.text : '', lastAt: last ? last.created_at : null,
      needsReply: last ? !!Number(last.mine) : false, // mine=1 = رسالة من المستخدم
    });
  }
  out.sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
  res.json({ conversations: out, needsReply: out.filter(c => c.needsReply).length });
});

// قراءة محادثة الدعم مع مستخدم (لرؤية ردوده)
r.get('/users/:id/thread', async (req, res) => {
  const id = Number(req.params.id);
  const thread = await db.queryOne("SELECT id FROM threads WHERE user_id=? AND peer_name='دعم وصلني'", [id]);
  if (!thread) return res.json({ messages: [] });
  // mine=1 يعني رسالة من المستخدم؛ mine=0 يعني من الإدارة (الدعم)
  const messages = await db.query('SELECT id,text,mine,created_at at FROM messages WHERE thread_id=? ORDER BY created_at ASC', [thread.id]);
  res.json({ messages: messages.map(m => ({ id: m.id, text: m.text, fromUser: !!Number(m.mine), at: m.at })) });
});

// إرسال رسالة مباشرة من الإدارة لمستخدم (تصل لحسابه فعليًّا)
r.post('/users/:id/message', async (req, res) => {
  const id = Number(req.params.id);
  const u = await db.queryOne('SELECT id,name FROM users WHERE id=?', [id]);
  if (!u) return bad(res, 'المستخدم غير موجود', 404);
  const text = String(req.body?.text || '').trim();
  if (!text) return bad(res, 'نص الرسالة مطلوب');
  // أنشئ/جد محادثة «دعم وصلني» لهذا المستخدم
  let thread = await db.queryOne("SELECT id FROM threads WHERE user_id=? AND peer_name='دعم وصلني'", [id]);
  let threadId = thread ? thread.id : await insertReturningId('threads', ['user_id', 'peer_name', 'initial'], [id, 'دعم وصلني', 'و']);
  await db.execute('INSERT INTO messages (thread_id,text,mine,created_at) VALUES (?,?,?,?)', [threadId, text, 0, now()]);
  // إشعار يفتح المحادثة
  await addNotif(id, 'messages', 'blue', 'رسالة من دعم وصلني', text.slice(0, 60), '/(passenger)/messages');
  res.json({ ok: true, threadId });
});

// ---------- توثيق السائقين ----------
r.get('/drivers/pending', async (_req, res) => {
  const rows = await db.query(
    `SELECT u.id,u.name,u.phone,u.dial,u.country_code,u.gender,u.id_number,u.birth_date,u.city,
            u.verify_status,u.verify_submitted_at,u.docs,u.created_at,
            v.make,v.model,v.year,v.color,v.plate,v.capacity
     FROM users u LEFT JOIN vehicles v ON v.user_id=u.id
     WHERE u.role='driver' AND u.verified=${PG_BOOL ? 'false' : '0'}
     ORDER BY (CASE WHEN u.verify_status='submitted' THEN 0 ELSE 1 END), u.created_at DESC`
  , []);
  for (const r of rows) { try { r.docs = r.docs ? JSON.parse(r.docs) : null; } catch { r.docs = null; } }
  res.json({ drivers: rows });
});

r.post('/drivers/:id/verify', async (req, res) => {
  const approve = req.body?.approve !== false;
  const reason = req.body?.reason ? String(req.body.reason).slice(0, 200) : '';
  const u = await db.queryOne("SELECT id,name FROM users WHERE id=? AND role='driver'", [Number(req.params.id)]);
  if (!u) return bad(res, 'السائق غير موجود', 404);
  await db.execute('UPDATE users SET verified=?, verify_status=? WHERE id=?',
    [PG_BOOL ? !!approve : (approve ? 1 : 0), approve ? 'approved' : 'rejected', u.id]);
  await addNotif(u.id, approve ? 'check' : 'x', approve ? 'green' : 'red',
    approve ? 'تم اعتماد حسابك كسائق ✓' : 'لم يُعتمد طلبك',
    approve ? 'يمكنك الآن نشر المسارات واستقبال الركّاب' : (reason || 'يرجى مراجعة مستنداتك وإعادة التقديم'));
  res.json({ id: u.id, verified: approve ? 1 : 0 });
});

// ---------- الرحلات ----------
r.get('/trips', async (_req, res) => {
  const rows = await db.query(
    `SELECT t.*, u.name driver_name, u.phone driver_phone,
            (SELECT COUNT(*) FROM requests WHERE trip_id=t.id) req_count,
            (SELECT COUNT(*) FROM requests WHERE trip_id=t.id AND status IN ('accepted','onboard','dropped')) accepted_count
     FROM trips t JOIN users u ON u.id=t.driver_id ORDER BY t.created_at DESC LIMIT 200`
  , []);
  res.json({ trips: rows });
});

// ---------- الحجوزات ----------
r.get('/bookings', async (_req, res) => {
  const rows = await db.query(
    `SELECT b.*, u.name passenger_name, u.phone passenger_phone
     FROM bookings b JOIN users u ON u.id=b.passenger_id ORDER BY b.created_at DESC LIMIT 200`
  , []);
  res.json({ bookings: rows });
});

// ---------- السحوبات (طلبات سحب الأرباح للحساب البنكي) ----------
r.get('/withdrawals', async (req, res) => {
  const status = req.query.status;
  const rows = await db.query(
    `SELECT w.*, u.name user_name, u.phone user_phone, u.dial
     FROM withdrawals w JOIN users u ON u.id=w.user_id
     ${status ? 'WHERE w.status=?' : ''} ORDER BY w.created_at DESC LIMIT 300`,
    [...(status ? [status] : [])]);
  res.json({ withdrawals: rows });
});
r.patch('/withdrawals/:id', async (req, res) => {
  const id = Number(req.params.id);
  const action = String(req.body?.action || ''); // paid | reject
  const note = req.body?.note ? String(req.body.note).slice(0, 300) : null;
  const w = await db.queryOne('SELECT * FROM withdrawals WHERE id=?', [id]);
  if (!w) return bad(res, 'طلب السحب غير موجود', 404);
  if (w.status !== 'pending') return bad(res, 'تمت معالجة هذا الطلب مسبقًا');
  if (action === 'paid') {
    await db.execute('UPDATE withdrawals SET status=?, admin_note=?, paid_at=? WHERE id=?', ['paid', note, now(), id]);
    await addNotif(w.user_id, 'wallet', 'green', 'تم تحويل أرباحك ✓', `${round2(w.amount)} ر.س إلى حسابك البنكي`, '/(driver)/dwallet');
  } else if (action === 'reject') {
    // أعد المبلغ إلى أرباح السائق
    await db.execute('UPDATE users SET earnings = earnings + ? WHERE id=?', [w.amount, w.user_id]);
    await db.execute('UPDATE withdrawals SET status=?, admin_note=? WHERE id=?', ['rejected', note, id]);
    await addNotif(w.user_id, 'x', 'red', 'لم يُعتمد طلب السحب', (note || 'تواصل مع الدعم') + ` — أُعيد ${round2(w.amount)} ر.س لرصيدك`, '/(driver)/dwallet');
  } else return bad(res, 'إجراء غير صالح (paid|reject)');
  res.json({ ok: true });
});

// ---------- المالية: دفتر العمولات والمعاملات ----------
r.get('/finance', async (_req, res) => {
  const gross = round2((await db.queryOne("SELECT COALESCE(SUM(fare),0) s FROM bookings WHERE status!='cancelled'", [])).s);
  const rate = await commissionRate();
  // العمولة الفعلية = مجموع عمولات المنصة المسجّلة عند إتمام الرحلات (حسب دولة كل سائق)
  const commission = round2((await db.queryOne("SELECT COALESCE(SUM(amount),0) s FROM transactions WHERE scope='platform'", [])).s);
  const driverPayouts = round2((await db.queryOne("SELECT COALESCE(SUM(amount),0) s FROM withdrawals WHERE status='paid'", [])).s);
  const pendingWithdrawals = round2((await db.queryOne("SELECT COALESCE(SUM(amount),0) s FROM withdrawals WHERE status='pending'", [])).s);
  const refunds = round2((await db.queryOne("SELECT COALESCE(SUM(amount),0) s FROM transactions WHERE title LIKE 'استرجاع%'", [])).s);
  const recent = await db.query(
    `SELECT t.id,t.title,t.amount,t.kind,t.scope,t.created_at, u.name user_name
     FROM transactions t JOIN users u ON u.id=t.user_id ORDER BY t.created_at DESC LIMIT 60`
  , []);
  res.json({ gross, rate, commission, driverPayouts, pendingWithdrawals, refunds, transactions: recent });
});

// ---------- الإعدادات ----------
r.get('/settings', async (_req, res) => {
  res.json({ commissionRate: await commissionRate(), serviceCountries: await serviceCountries(), adminProtected: true });
});
r.patch('/settings', async (req, res) => {
  const { commissionRate: cr, serviceCountries: sc } = req.body || {};
  if (cr !== undefined) {
    const v = Number(cr);
    if (!Number.isFinite(v) || v < 0 || v > 0.5) return bad(res, 'نسبة العمولة يجب أن تكون بين 0 و 0.5');
    await setConfig('commission_rate', v);
  }
  if (Array.isArray(sc)) await setConfig('service_countries', sc.join(','));
  res.json({ commissionRate: await commissionRate(), serviceCountries: await serviceCountries() });
});


// ---------- إعدادات الدول (ربح + تسعير الكيلومتر) ----------
r.get('/countries', async (_req, res) => {
  const known = { SA:'السعودية', JO:'الأردن', EG:'مصر', AE:'الإمارات', KW:'الكويت', QA:'قطر', BH:'البحرين', OM:'عُمان' };
  const rows = await allCountrySettings();
  const map = Object.fromEntries(rows.map(r => [r.code, r]));
  const active = await serviceCountries();
  const defRate = await commissionRate();
  const out = Object.entries(known).map(([code, name]) => {
    const c = map[code] || { profit_type:'percent', profit_value: defRate, price_per_km:1.5, km_cap:2.5, tax_rate:0, exchange_rate:1 };
    return { code, name, enabled: active.includes(code),
      profitType: c.profit_type, profitValue: c.profit_value,
      pricePerKm: c.price_per_km, kmCap: c.km_cap,
      taxRate: c.tax_rate != null ? c.tax_rate : 0, exchangeRate: c.exchange_rate != null ? c.exchange_rate : 1 };
  });
  res.json({ countries: out });
});

r.patch('/countries/:code', async (req, res) => {
  const code = String(req.params.code).toUpperCase();
  const { profitType, profitValue, pricePerKm, kmCap, enabled, taxRate, exchangeRate } = req.body || {};
  if (profitType && !['percent','flat'].includes(profitType)) return bad(res, 'نوع الربح غير صالح (percent|flat)');
  if (taxRate !== undefined && (!Number.isFinite(Number(taxRate)) || Number(taxRate) < 0 || Number(taxRate) > 0.5)) return bad(res, 'الضريبة يجب أن تكون بين 0 و 50%');
  if (exchangeRate !== undefined && (!Number.isFinite(Number(exchangeRate)) || Number(exchangeRate) <= 0)) return bad(res, 'سعر الصرف غير صالح');
  const pv = Number(profitValue);
  if (profitValue !== undefined) {
    if (!Number.isFinite(pv) || pv < 0) return bad(res, 'قيمة الربح غير صالحة');
    if (profitType === 'percent' && pv > 0.5) return bad(res, 'النسبة يجب ألا تتجاوز 50%');
    if (profitType === 'flat' && pv > 1000) return bad(res, 'المبلغ المقطوع كبير جدًا');
  }
  if (pricePerKm !== undefined && (!Number.isFinite(Number(pricePerKm)) || Number(pricePerKm) < 0)) return bad(res, 'سعر الكيلومتر غير صالح');
  if (kmCap !== undefined && (!Number.isFinite(Number(kmCap)) || Number(kmCap) < 0)) return bad(res, 'سقف الكيلومتر غير صالح');
  const patch = {};
  if (profitType !== undefined) patch.profit_type = profitType;
  if (profitValue !== undefined) patch.profit_value = pv;
  if (pricePerKm !== undefined) patch.price_per_km = Number(pricePerKm);
  if (kmCap !== undefined) patch.km_cap = Number(kmCap);
  if (taxRate !== undefined) patch.tax_rate = Number(taxRate);
  if (exchangeRate !== undefined) patch.exchange_rate = Number(exchangeRate);
  if (enabled !== undefined) patch.enabled = enabled ? 1 : 0;
  const updated = await setCountrySetting(code, patch);
  // مزامنة قائمة الدول المخدومة مع علم enabled
  if (enabled !== undefined) {
    const active = new Set(await serviceCountries());
    if (enabled) active.add(code); else active.delete(code);
    await setConfig('service_countries', [...active].join(','));
  }
  res.json({ country: { code, profitType: updated.profit_type, profitValue: updated.profit_value, pricePerKm: updated.price_per_km, kmCap: updated.km_cap, enabled: !!updated.enabled } });
});

// ---------- البلاغات ----------
r.get('/reports', async (req, res) => {
  const rows = await db.query(`SELECT rp.*, u.name reporter_name, u.dial, u.phone
    FROM reports rp JOIN users u ON u.id=rp.reporter_id ORDER BY rp.created_at DESC LIMIT 300`, []);
  res.json({ reports: rows.map(r => ({
    id: r.id, reporter: r.reporter_name, reporterPhone: (r.dial||'')+r.phone, reporterRole: r.reporter_role,
    against: r.against, tripId: r.trip_id, category: r.category, note: r.note, reply: r.reply, status: r.status, at: r.created_at
  })) });
});
r.patch('/reports/:id', async (req, res) => {
  const st = req.body && req.body.status;
  const reply = req.body && req.body.reply ? String(req.body.reply).slice(0, 500) : null;
  if (st && !['open','resolved'].includes(st)) return bad(res, 'حالة غير صالحة');
  const rep = await db.queryOne('SELECT * FROM reports WHERE id=?', [Number(req.params.id)]);
  if (!rep) return bad(res, 'البلاغ غير موجود', 404);
  await db.execute('UPDATE reports SET status=COALESCE(?,status), reply=COALESCE(?,reply) WHERE id=?',
    [st || null, reply, req.params.id]);
  // أبلغ المُبلِّغ بالرد
  if (reply) await addNotif(rep.reporter_id, 'messages', 'blue', 'رد على بلاغك', reply.slice(0, 60), '/(passenger)/notifications');
  res.json({ ok: true });
});

// ---------- الرسوم البيانية ----------
r.get('/charts', async (_req, res) => {
  // آخر 7 أيام: حجوزات وإيراد
  const days = [];
  const dayMs = 86400000; const today = new Date(); today.setHours(0,0,0,0);
  for (let i = 6; i >= 0; i--) {
    const start = today.getTime() - i * dayMs, end = start + dayMs;
    const dayBookings = await db.queryOne("SELECT COUNT(*) c, COALESCE(SUM(fare),0) s FROM bookings WHERE status!='cancelled' AND created_at>=? AND created_at<?", [start, end]);
    const label = new Date(start).toLocaleDateString('ar', { weekday: 'short' });
    days.push({ label, bookings: dayBookings.c, revenue: round2(dayBookings.s) });
  }
  // توزيع حسب الدولة
  const byCountry = await db.query(`SELECT u.country_code code, COUNT(*) users FROM users u GROUP BY u.country_code`, []);
  // توزيع حالات الرحلات
  const tripStatus = await db.query(`SELECT status, COUNT(*) c FROM trips GROUP BY status`, []);
  res.json({ daily: days, byCountry, tripStatus });
});

// ---------- تصدير CSV ----------
// ============ العروض (Promos) ============
r.get('/promos', async (_req, res) => {
  const rows = await db.query('SELECT * FROM promos ORDER BY created_at DESC', []);
  res.json({ promos: rows });
});
r.post('/promos', async (req, res) => {
  const { code, title, discountType, discountValue, maxUses, country, expiresAt } = req.body || {};
  if (!code || !title || discountValue == null) return bad(res, 'الكود والعنوان والقيمة مطلوبة');
  const exists = await db.queryOne('SELECT id FROM promos WHERE code=?', [String(code).toUpperCase()]);
  if (exists) return bad(res, 'هذا الكود مستخدم مسبقًا');
  const id = await insertReturningId('promos',
    ['code', 'title', 'discount_type', 'discount_value', 'max_uses', 'country', 'active', 'expires_at', 'created_at'],
    [String(code).toUpperCase(), title, discountType === 'flat' ? 'flat' : 'percent', Number(discountValue), Number(maxUses) || 0, country || null, PG_BOOL ? true : 1, expiresAt || null, now()]);
  res.status(201).json({ ok: true, id });
});
r.patch('/promos/:id', async (req, res) => {
  const { active } = req.body || {};
  await db.execute('UPDATE promos SET active=? WHERE id=?', [PG_BOOL ? !!active : (active ? 1 : 0), req.params.id]);
  res.json({ ok: true });
});
r.delete('/promos/:id', async (req, res) => {
  await db.execute('DELETE FROM promos WHERE id=?', [req.params.id]);
  res.json({ ok: true });
});

// ============ الإشعارات الإدارية (Broadcast) ============
r.get('/notifications', async (_req, res) => {
  const rows = await db.query('SELECT * FROM admin_notifications ORDER BY created_at DESC LIMIT 100', []);
  res.json({ notifications: rows });
});
r.post('/notifications', async (req, res) => {
  const { title, body, audience } = req.body || {};
  if (!title || !body) return bad(res, 'العنوان والنص مطلوبان');
  const aud = ['all', 'passengers', 'drivers'].includes(audience) ? audience : 'all';
  // احسب الجمهور وأرسل لكل مستخدم مطابق
  const where = aud === 'all' ? '' : (aud === 'drivers' ? "WHERE role='driver'" : "WHERE role='passenger'");
  const targets = await db.query(`SELECT id FROM users ${where}`, []);
  for (const u of targets) await addNotif(u.id, 'bell', 'blue', title, body);
  const id = await insertReturningId('admin_notifications',
    ['title', 'body', 'audience', 'sent_count', 'created_at'], [title, body, aud, targets.length, now()]);
  res.status(201).json({ ok: true, id, sent: targets.length });
});

// ============ الدعم (Support Tickets) ============
r.get('/support', async (_req, res) => {
  const rows = await db.query('SELECT * FROM support_tickets ORDER BY created_at DESC LIMIT 200', []);
  res.json({ tickets: rows });
});
r.patch('/support/:id', async (req, res) => {
  const { status, reply } = req.body || {};
  if (status && !['open', 'closed'].includes(status)) return bad(res, 'حالة غير صالحة');
  const cur = await db.queryOne('SELECT * FROM support_tickets WHERE id=?', [req.params.id]);
  if (!cur) return bad(res, 'التذكرة غير موجودة', 404);
  await db.execute('UPDATE support_tickets SET status=?, reply=? WHERE id=?',
    [status || cur.status, reply != null ? reply : cur.reply, req.params.id]);
  // أبلغ المستخدم بالرد إن وُجد
  if (reply && cur.user_id) await addNotif(cur.user_id, 'messages', 'green', 'رد على استفسارك', reply);
  res.json({ ok: true });
});

// ============ الأدوار والصلاحيات (Admin Users) ============
r.get('/team', async (_req, res) => {
  const rows = await db.query('SELECT id,username,name,role,permissions,active,created_at FROM admin_users ORDER BY created_at DESC', []);
  res.json({ team: rows.map(t => ({ ...t, permissions: (t.permissions || '').split(',').filter(Boolean) })) });
});
r.post('/team', async (req, res) => {
  const { username, name, role, permissions } = req.body || {};
  if (!username || !name) return bad(res, 'اسم المستخدم والاسم مطلوبان');
  const exists = await db.queryOne('SELECT id FROM admin_users WHERE username=?', [username]);
  if (exists) return bad(res, 'اسم المستخدم مستخدم مسبقًا');
  const perms = Array.isArray(permissions) ? permissions.join(',') : '';
  const id = await insertReturningId('admin_users',
    ['username', 'name', 'role', 'permissions', 'active', 'created_at'],
    [username, name, role || 'support', perms, PG_BOOL ? true : 1, now()]);
  res.status(201).json({ ok: true, id });
});
r.patch('/team/:id', async (req, res) => {
  const { role, permissions, active } = req.body || {};
  const cur = await db.queryOne('SELECT * FROM admin_users WHERE id=?', [req.params.id]);
  if (!cur) return bad(res, 'العضو غير موجود', 404);
  const perms = Array.isArray(permissions) ? permissions.join(',') : cur.permissions;
  const act = active != null ? (PG_BOOL ? !!active : (active ? 1 : 0)) : cur.active;
  await db.execute('UPDATE admin_users SET role=?, permissions=?, active=? WHERE id=?',
    [role || cur.role, perms, act, req.params.id]);
  res.json({ ok: true });
});
r.delete('/team/:id', async (req, res) => {
  await db.execute('DELETE FROM admin_users WHERE id=?', [req.params.id]);
  res.json({ ok: true });
});

// ============ الإعدادات الموسّعة (App Settings) ============
r.get('/app-settings', async (_req, res) => {
  const rows = await db.query('SELECT key,value FROM app_settings', []);
  const map = {};
  for (const row of rows) map[row.key] = row.value;
  res.json({ settings: map });
});
r.patch('/app-settings', async (req, res) => {
  const patch = req.body || {};
  const ex = PG_BOOL ? 'EXCLUDED' : 'excluded';
  for (const [k, v] of Object.entries(patch)) {
    await db.execute(`INSERT INTO app_settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=${ex}.value`, [k, String(v)]);
  }
  res.json({ ok: true });
});

// ============ الخريطة والعمليات (Live Operations) ============
r.get('/operations', async (_req, res) => {
  const activeTrips = await db.query("SELECT t.*, u.name driver_name FROM trips t JOIN users u ON u.id=t.driver_id WHERE t.status NOT IN ('completed','cancelled') ORDER BY t.created_at DESC LIMIT 50", []);
  for (const t of activeTrips) t.requests = await db.query('SELECT passenger_name,status,pickup,pickup_lat,pickup_lng FROM requests WHERE trip_id=?', [t.id]);
  const liveBookings = await db.query("SELECT * FROM bookings WHERE status NOT IN ('completed','cancelled') ORDER BY created_at DESC LIMIT 50", []);
  res.json({
    activeTrips,
    liveBookings,
    summary: {
      activeTrips: activeTrips.length,
      liveBookings: liveBookings.length,
      onlineDrivers: (await db.queryOne("SELECT COUNT(*) c FROM users WHERE role='driver'", [])).c,
    },
  });
});

function toCsv(headers, rows) {
  const esc = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  return '\uFEFF' + [headers.join(','), ...rows.map(r => r.map(esc).join(','))].join('\n');
}
r.get('/export/:kind', async (req, res) => {
  const kind = req.params.kind;
  let headers, rows, name;
  if (kind === 'users') {
    name = 'users';
    headers = ['المعرّف','الاسم','الجوال','الدولة','الدور','التقييم','المحفظة','الأرباح','الحالة','موثّق'];
    rows = (await db.query('SELECT id,name,dial,phone,country_code,role,rating,wallet,earnings,status,verified FROM users ORDER BY id', []))
      .map(u => [u.id, u.name, u.dial + u.phone, u.country_code, u.role === 'driver' ? 'سائق' : 'راكب', u.rating, u.wallet, u.earnings, u.status === 'active' ? 'نشط' : 'موقوف', u.verified ? 'نعم' : 'لا']);
  } else if (kind === 'trips') {
    name = 'trips';
    headers = ['المعرّف','السائق','من','إلى','الوقت','سعر المقعد','المقاعد','الحالة'];
    rows = (await db.query(`SELECT t.id,u.name driver,t.from_label,t.to_label,t.time,t.price_per_seat,t.total_seats,t.status FROM trips t JOIN users u ON u.id=t.driver_id ORDER BY t.id`, []))
      .map(t => [t.id, t.driver, t.from_label, t.to_label, t.time, t.price_per_seat, t.total_seats, t.status]);
  } else if (kind === 'bookings') {
    name = 'bookings';
    headers = ['المعرّف','الراكب','السائق','من','إلى','المقاعد','الأجرة','الحالة'];
    rows = (await db.query(`SELECT b.id,u.name pax,b.driver,b.from_label,b.to_label,b.seats,b.fare,b.status FROM bookings b JOIN users u ON u.id=b.passenger_id ORDER BY b.id`, []))
      .map(b => [b.id, b.pax, b.driver, b.from_label, b.to_label, b.seats, b.fare, b.status]);
  } else if (kind === 'finance') {
    name = 'finance';
    headers = ['المعرّف','المستخدم','العملية','المبلغ','الاتجاه','النطاق','التاريخ'];
    rows = (await db.query(`SELECT t.id,u.name un,t.title,t.amount,t.kind,t.scope,t.created_at FROM transactions t JOIN users u ON u.id=t.user_id ORDER BY t.id DESC LIMIT 1000`, []))
      .map(t => [t.id, t.un, t.title, t.amount, t.kind === 'in' ? 'وارد' : 'صادر', t.scope === 'driver' ? 'سائق' : 'راكب', new Date(t.created_at).toLocaleString('ar')]);
  } else return bad(res, 'نوع تصدير غير معروف', 404);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="wasalni-${name}.csv"`);
  res.send(toCsv(headers, rows));
});

module.exports = r;
