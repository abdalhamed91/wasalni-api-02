// اختبارات تكامل على الخادم الفعلي: التوثيق، الأمان، المال (محفظة/كوبونات/سحب)، وسباقات التزامن.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

let S, api, adminTok, driver, pax;
const r2 = (n) => Math.round(n * 100) / 100;
let phoneSeq = 791000000;
const nextPhone = () => String(phoneSeq++);

test.before(async () => {
  S = await startServer();
  api = S.api;
  adminTok = await api.adminToken();
  driver = await api.approvedDriver(nextPhone(), adminTok);
});
test.after(async () => { await S.stop(); });

// حجز بمحفظة على رحلة جديدة؛ يُعيد { trip, booking, passenger }
async function bookWallet(opts = {}) {
  const trip = await api.publishTrip(driver, opts.trip);
  const passenger = await api.register(nextPhone());
  await api.topup(passenger, opts.topup ?? 100);
  const b = await api.post('/bookings', { rideId: trip.id, seats: 1, payment: opts.payment, promoCode: opts.promoCode }, passenger.token);
  return { trip, passenger, res: b, booking: b.body.booking };
}

test('health + 404 موحّد + رؤوس الأمان', async () => {
  const h = await fetch(S.origin + '/health');
  assert.equal(h.status, 200);
  assert.equal(h.headers.get('x-content-type-options'), 'nosniff');
  // مسار غير موجود خارج /api → 404 موحّد؛ وتحت /api بلا توكن → 401 (الحماية قبل التوجيه)
  const nf = await fetch(S.origin + '/nope-route');
  assert.equal(nf.status, 404);
  assert.equal((await api.get('/nope-route')).status, 401);
});

test('المسارات المحمية ترفض بلا توكن أو بتوكن فاسد', async () => {
  assert.equal((await api.get('/me')).status, 401);
  assert.equal((await api.get('/me', 'garbage.token.here')).status, 401);
  assert.equal((await api.get('/wallet')).status, 401);
});

test('لوحة الإدارة ترفض كلمة مرور خاطئة وتوكن مستخدم عادي', async () => {
  assert.equal((await api.call('POST', '/admin/login', { passcode: 'wrong' })).status, 401);
  const u = await api.register(nextPhone());
  assert.equal((await api.admin.get('/stats', u.token)).status, 403);
  assert.equal((await api.admin.get('/stats', adminTok)).status, 200);
});

test('OTP: رمز خاطئ يُرفض، وحدّ المحاولات يبطل الرمز', async () => {
  const phone = nextPhone();
  const xf = { 'X-Forwarded-For': '10.9.9.9' };
  const s = await api.call('POST', '/auth/otp/send', { phone, dial: '+962' }, null, xf);
  assert.equal(s.status, 200);
  const wrong = s.body.devCode === '1111' ? '2222' : '1111';
  for (let i = 0; i < 5; i++) assert.equal((await api.call('POST', '/auth/otp/verify', { phone, dial: '+962', code: wrong }, null, xf)).status, 401);
  // بعد 5 محاولات خاطئة حتى الرمز الصحيح لا يُقبل
  const late = await api.call('POST', '/auth/otp/verify', { phone, dial: '+962', code: s.body.devCode }, null, xf);
  assert.equal(late.status, 401);
});

test('نفس الرقم بصيغ مختلفة = نفس الحساب (لا تكرار)', async () => {
  const a = await api.register('0795550001');
  const b = await api.register('795550001');
  assert.equal(a.id, b.id);
});

test('PATCH /me يرفض بريدًا غير صالح ودولة غير مدعومة', async () => {
  const u = await api.register(nextPhone());
  assert.equal((await api.patch('/me', { email: 'not-an-email' }, u.token)).status, 400);
  assert.equal((await api.patch('/me', { countryCode: 'XX' }, u.token)).status, 400);
  assert.equal((await api.patch('/me', { name: 'a' }, u.token)).status, 400);
  const ok = await api.patch('/me', { name: 'مستخدم تجريبي', email: 'ok@example.com' }, u.token);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.email, 'ok@example.com');
  assert.equal(ok.body.user.emailVerified, false);
});

test('رفع الصور: يقبل PNG حقيقي ويرفض محتوى غير صورة', async () => {
  const u = await api.register(nextPhone());
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const ok = await api.post('/uploads', { data: 'data:image/png;base64,' + png.toString('base64') }, u.token);
  assert.equal(ok.status, 201);
  assert.match(ok.body.url, /^\/uploads\/.+\.png$/);
  const fetched = await fetch(S.origin + ok.body.url);
  assert.equal(fetched.status, 200);
  const evil = await api.post('/uploads', { data: Buffer.from('<html><script>alert(1)</script></html>').toString('base64'), ext: 'jpg' }, u.token);
  assert.equal(evil.status, 400);
});

test('نشر الرحلة: راكب عادي ممنوع، وقيم السعر/المقاعد تُتحقَّق', async () => {
  const u = await api.register(nextPhone());
  assert.ok((await api.post('/trips', { from: 'أ', to: 'ب', time: 'الآن', price: 5, seats: 2 }, u.token)).status >= 400);
  const bad1 = await api.post('/trips', { from: 'أ', to: 'ب', time: 'الآن', price: 0.01, seats: 2 }, driver.token);
  assert.equal(bad1.status, 400);
  const bad2 = await api.post('/trips', { from: 'أ', to: 'ب', time: 'الآن', price: 5, seats: 9 }, driver.token);
  assert.equal(bad2.status, 400);
  const bad3 = await api.post('/trips', { from: 'أ', to: 'ب', time: 'الآن', price: 99999, seats: 2 }, driver.token);
  assert.equal(bad3.status, 400);
});

test('شحن المحفظة يرفض المبالغ الشاذّة', async () => {
  const u = await api.register(nextPhone());
  for (const amount of [0, -5, 'abc', 1e9, null]) assert.equal((await api.post('/wallet/topup', { amount }, u.token)).status, 400, String(amount));
  assert.equal((await api.post('/wallet/topup', { amount: 50 }, u.token)).body.balance, 50);
});

test('الحجز: خصم المحفظة، رفض الرصيد الناقص، ومنع الحجز المكرّر وحجز رحلتك', async () => {
  const { trip, passenger, res } = await bookWallet({ topup: 100 });
  assert.equal(res.status, 201);
  assert.equal(await api.balance(passenger), 90);
  // حجز مكرّر لنفس الرحلة
  assert.equal((await api.post('/bookings', { rideId: trip.id, seats: 1 }, passenger.token)).status, 409);
  // السائق لا يحجز رحلته
  assert.equal((await api.post('/bookings', { rideId: trip.id, seats: 1, payment: 'cash' }, driver.token)).status, 400);
  // راكب بلا رصيد
  const poor = await api.register(nextPhone());
  const r = await api.post('/bookings', { rideId: trip.id, seats: 1 }, poor.token);
  assert.equal(r.status, 400);
  // المقاعد لم تتأثّر بالمحاولة الفاشلة (3 - 1 = 2)
  const mine = await api.get('/trips', driver.token);
  const mt = mine.body.trips.find((t) => t.id === trip.id);
  assert.equal(mt.seats_left, 2);
  assert.equal(mt.total_seats, 3); // السعة الفعلية (متبقّي + محجوز) لا المتبقّي فقط
});

test('الحجز المتزامن لا يبيع مقاعد أكثر من المتاح', async () => {
  const trip = await api.publishTrip(driver, { seats: 2 });
  const users = [];
  for (let i = 0; i < 5; i++) { const u = await api.register(nextPhone()); users.push(u); }
  const results = await Promise.all(users.map((u) => api.post('/bookings', { rideId: trip.id, seats: 1, payment: 'cash' }, u.token)));
  assert.equal(results.filter((x) => x.status === 201).length, 2);
  const mine = await api.get('/trips', driver.token);
  assert.equal(mine.body.trips.find((t) => t.id === trip.id).seats_left, 0);
  assert.equal(mine.body.trips.find((t) => t.id === trip.id).total_seats, 2);
});

// ===== إصلاح: كود الخصم بالنسبة (10 = 10% وليس ×10) =====
test('كود خصم نسبة: 10% يخفّض الأجرة ولا يُنتج رصيدًا سالبًا', async () => {
  const code = 'PCT' + Date.now();
  const mk = await api.admin.post('/promos', { code, title: 'خصم 10', discountType: 'percent', discountValue: 10 }, adminTok);
  assert.equal(mk.status, 201);
  const { passenger, res } = await bookWallet({ topup: 100, promoCode: code });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.booking.fare, 9); // 10 د × (1 - 10%)
  assert.equal(await api.balance(passenger), 91);
});

test('كود الخصم يُستخدم مرّة واحدة لكل مستخدم (حتى مع طلبات متزامنة)', async () => {
  const code = 'ONCE' + Date.now();
  await api.admin.post('/promos', { code, title: 'مرة', discountType: 'percent', discountValue: 50 }, adminTok);
  const passenger = await api.register(nextPhone());
  await api.topup(passenger, 200);
  const t1 = await api.publishTrip(driver), t2 = await api.publishTrip(driver);
  const [a, b] = await Promise.all([
    api.post('/bookings', { rideId: t1.id, seats: 1, promoCode: code }, passenger.token),
    api.post('/bookings', { rideId: t2.id, seats: 1, promoCode: code }, passenger.token),
  ]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [201, 400]);
  // الرصيد: حجز بنصف السعر (5) + حجز بكامل السعر لا يتم… الحجز المرفوض لا يخصم شيئًا
  assert.equal(await api.balance(passenger), 195);
});

test('كود الخصم محدود الاستخدام (maxUses) يُحترم بين مستخدمين متزامنين', async () => {
  const code = 'MAX1' + Date.now();
  await api.admin.post('/promos', { code, title: 'واحد فقط', discountType: 'percent', discountValue: 20, maxUses: 1 }, adminTok);
  const trip = await api.publishTrip(driver, { seats: 3 });
  const us = [await api.register(nextPhone()), await api.register(nextPhone())];
  for (const u of us) await api.topup(u, 50);
  const rs = await Promise.all(us.map((u) => api.post('/bookings', { rideId: trip.id, seats: 1, promoCode: code }, u.token)));
  assert.equal(rs.filter((x) => x.status === 201).length, 1);
  // فاشل الحجز لا يخصم من محفظته
  const failedIdx = rs.findIndex((x) => x.status !== 201);
  assert.equal(await api.balance(us[failedIdx]), 50);
});

test('إدارة الكوبونات: تُرفض القيم غير المنطقية', async () => {
  const c = () => 'BAD' + Math.random().toString(36).slice(2, 8);
  assert.equal((await api.admin.post('/promos', { code: c(), title: 'x', discountType: 'percent', discountValue: 150 }, adminTok)).status, 400);
  assert.equal((await api.admin.post('/promos', { code: c(), title: 'x', discountType: 'percent', discountValue: -5 }, adminTok)).status, 400);
  assert.equal((await api.admin.post('/promos', { code: c(), title: 'x', discountType: 'percent', discountValue: 'abc' }, adminTok)).status, 400);
});

test('استبدال كود مبلغ ثابت: مرة واحدة لكل مستخدم، وبلا استبدال مزدوج متزامن', async () => {
  const code = 'FLAT' + Date.now();
  await api.admin.post('/promos', { code, title: 'هدية', discountType: 'flat', discountValue: 7 }, adminTok);
  const u = await api.register(nextPhone());
  const rs = await Promise.all([1, 2, 3].map(() => api.post('/promos/redeem', { code }, u.token)));
  assert.equal(rs.filter((x) => x.status === 200).length, 1);
  assert.equal(await api.balance(u), 7);
  assert.equal((await api.post('/promos/redeem', { code }, u.token)).status, 400);
});

// ===== إصلاح: إلغاء الراكب ومنع الاسترجاع المزدوج / الاحتيال =====
test('إلغاء الحجز من الراكب يُرجع المبلغ مرّة واحدة حتى مع طلبات متزامنة', async () => {
  const { trip, passenger, booking } = await bookWallet({ topup: 100 });
  assert.equal(await api.balance(passenger), 90);
  const rs = await Promise.all([1, 2, 3].map(() => api.post(`/bookings/${booking.id}/status`, { status: 'cancelled' }, passenger.token)));
  assert.ok(rs.every((x) => x.status === 200 || x.status === 400));
  assert.ok(rs.filter((x) => x.status === 200 && x.body.wallet !== undefined).length <= 1);
  assert.equal(await api.balance(passenger), 100); // المبلغ عاد مرّة واحدة فقط
  // تكرار الطلب لاحقًا idempotent (200 بلا استرجاع إضافي)
  assert.equal((await api.post(`/bookings/${booking.id}/status`, { status: 'cancelled' }, passenger.token)).status, 200);
  assert.equal(await api.balance(passenger), 100);
  const mine = await api.get('/trips', driver.token);
  assert.equal(mine.body.trips.find((t) => t.id === trip.id).seats_left, 3);
});

test('الراكب لا يستطيع «إكمال» الحجز بنفسه ولا الإلغاء بعد صعوده', async () => {
  const { trip, passenger, booking } = await bookWallet({ topup: 100 });
  assert.equal((await api.post(`/bookings/${booking.id}/status`, { status: 'completed' }, passenger.token)).status, 400);
  await api.post(`/requests/${booking.request_id}/accept`, {}, driver.token);
  await api.post(`/trips/${trip.id}/start`, {}, driver.token);
  const cancel = await api.post(`/bookings/${booking.id}/status`, { status: 'cancelled' }, passenger.token);
  assert.equal(cancel.status, 400);
  assert.equal(await api.balance(passenger), 90); // لم يُسترجع شيء
});

test('راكب آخر لا يصل لحجز غيره', async () => {
  const { booking } = await bookWallet();
  const other = await api.register(nextPhone());
  assert.equal((await api.post(`/bookings/${booking.id}/status`, { status: 'cancelled' }, other.token)).status, 403);
  assert.equal((await api.get(`/bookings/${booking.id}/track`, other.token)).status, 403);
  assert.equal((await api.post(`/bookings/${booking.id}/rate`, { stars: 5 }, other.token)).status, 403);
});

// ===== قبول/رفض الطلب =====
test('رفض الطلب يُرجع المبلغ مرّة واحدة حتى عند الضغط المتزامن', async () => {
  const { trip, passenger, booking } = await bookWallet({ topup: 100 });
  const rs = await Promise.all([1, 2, 3].map(() => api.post(`/requests/${booking.request_id}/reject`, {}, driver.token)));
  assert.equal(rs.filter((x) => x.status === 200).length, 1);
  assert.equal(await api.balance(passenger), 100);
  const mine = await api.get('/trips', driver.token);
  assert.equal(mine.body.trips.find((t) => t.id === trip.id).seats_left, 3);
});

test('سائق آخر لا يقبل طلبات رحلة غيره', async () => {
  const { booking } = await bookWallet();
  const d2 = await api.approvedDriver(nextPhone(), adminTok);
  assert.equal((await api.post(`/requests/${booking.request_id}/accept`, {}, d2.token)).status, 403);
});

// ===== إلغاء الرحلة / إكمالها =====
test('إلغاء السائق للرحلة يُرجع محافظ الركّاب مرّة واحدة (حتى مع التكرار المتزامن)', async () => {
  const { trip, passenger } = await bookWallet({ topup: 100 });
  const rs = await Promise.all([1, 2].map(() => api.post(`/trips/${trip.id}/cancel`, { reason: 'ظرف' }, driver.token)));
  assert.equal(rs.filter((x) => x.status === 200).length, 1);
  assert.equal(await api.balance(passenger), 100);
  // لا يمكن حجز رحلة ملغاة
  const late = await api.register(nextPhone());
  assert.equal((await api.post('/bookings', { rideId: trip.id, seats: 1, payment: 'cash' }, late.token)).status, 400);
});

test('إكمال الرحلة مرّتين متزامنتين يحتسب العمولة مرّة واحدة', async () => {
  const trip = await api.publishTrip(driver, { price: 20 });
  const p = await api.register(nextPhone());
  const b = await api.post('/bookings', { rideId: trip.id, seats: 1, payment: 'cash' }, p.token);
  await api.post(`/requests/${b.body.booking.request_id}/accept`, {}, driver.token);
  await api.post(`/trips/${trip.id}/start`, {}, driver.token);
  const duesBefore = (await api.get('/me/dues', driver.token)).body.dues;
  const rs = await Promise.all([1, 2, 3].map(() => api.post(`/trips/${trip.id}/complete`, {}, driver.token)));
  assert.equal(rs.filter((x) => x.status === 200).length, 1);
  const duesAfter = (await api.get('/me/dues', driver.token)).body.dues;
  assert.equal(r2(duesAfter - duesBefore), 3); // 15% من 20
});

test('إكمال الرحلة يُرجع مبلغ الطلبات التي لم يقبلها السائق', async () => {
  const { trip, passenger } = await bookWallet({ topup: 100 }); // طلب معلّق، لم يُقبل
  assert.equal(await api.balance(passenger), 90);
  const done = await api.post(`/trips/${trip.id}/complete`, {}, driver.token);
  assert.equal(done.status, 200);
  assert.equal(await api.balance(passenger), 100);
});

test('تحديث الموقع يرفض إحداثيات خارج النطاق', async () => {
  const trip = await api.publishTrip(driver);
  assert.equal((await api.post(`/trips/${trip.id}/location`, { lat: 200, lng: 10 }, driver.token)).status, 400);
  assert.equal((await api.post(`/trips/${trip.id}/location`, { lat: 31.9, lng: 'x' }, driver.token)).status, 400);
  assert.equal((await api.post(`/trips/${trip.id}/location`, { lat: 31.9, lng: 35.9 }, driver.token)).status, 200);
});

// ===== التقييم =====
test('التقييم: يتطلّب رحلة مكتملة وقيمة 1–5، ولا يتكرّر', async () => {
  const trip = await api.publishTrip(driver);
  const p = await api.register(nextPhone());
  const b = (await api.post('/bookings', { rideId: trip.id, seats: 1, payment: 'cash' }, p.token)).body.booking;
  // قبل اكتمال الرحلة
  assert.equal((await api.post(`/bookings/${b.id}/rate`, { stars: 5 }, p.token)).status, 400);
  await api.post(`/requests/${b.request_id}/accept`, {}, driver.token);
  await api.post(`/trips/${trip.id}/start`, {}, driver.token);
  await api.post(`/trips/${trip.id}/complete`, {}, driver.token);
  assert.equal((await api.post(`/bookings/${b.id}/rate`, { stars: 99 }, p.token)).status, 400);
  assert.equal((await api.post(`/bookings/${b.id}/rate`, {}, p.token)).status, 400);
  const rs = await Promise.all([1, 2, 3].map(() => api.post(`/bookings/${b.id}/rate`, { stars: 4, tags: ['ودود'] }, p.token)));
  assert.equal(rs.filter((x) => x.status === 200).length, 1);
  // السائق يقيّم الراكب بعد الإنزال
  assert.equal((await api.post(`/requests/${b.request_id}/rate`, { stars: 0 }, driver.token)).status, 400);
  assert.equal((await api.post(`/requests/${b.request_id}/rate`, { stars: 5 }, driver.token)).status, 200);
  assert.equal((await api.post(`/requests/${b.request_id}/rate`, { stars: 5 }, driver.token)).status, 400);
});

// ===== تحويل المحفظة =====
test('تحويل المحفظة: ذرّي، يرفض الذات والرصيد الناقص', async () => {
  const a = await api.register('0796660001'), b = await api.register('0796660002');
  await api.topup(a, 40);
  assert.equal((await api.post('/wallet/transfer', { phone: '0796660001', amount: 5 }, a.token)).status, 400); // لنفسه
  assert.equal((await api.post('/wallet/transfer', { phone: '0796660002', amount: 500 }, a.token)).status, 400); // رصيد ناقص
  assert.equal((await api.post('/wallet/transfer', { phone: '0796660002', amount: -5 }, a.token)).status, 400);
  const rs = await Promise.all([1, 2, 3].map(() => api.post('/wallet/transfer', { phone: '0796660002', amount: 20 }, a.token)));
  assert.equal(rs.filter((x) => x.status === 200).length, 2);
  assert.equal(await api.balance(a), 0);
  assert.equal(await api.balance(b), 40);
});

// ===== السحب (إدارة) =====
test('رفض الإدارة لطلب السحب يُرجع الأرباح مرّة واحدة', async () => {
  // أرباح السائق تأتي هنا من اشتراك مجموعة (يذهب كاملًا لمنشئها السائق)
  const grp = await api.post('/groups', { name: 'خط', fromLabel: 'أ', fromCoord: [31.9, 35.9], toLabel: 'ب', toCoord: [32, 35.8], weeklyPrice: 30 }, driver.token);
  assert.equal(grp.status, 201);
  const m = await api.register(nextPhone());
  await api.topup(m, 100);
  await api.post('/groups/join', { code: grp.body.group.join_code }, m.token);
  assert.equal((await api.post(`/groups/${grp.body.group.id}/subscribe`, { plan: 'weekly' }, m.token)).status, 201);
  const before = (await api.get('/earnings', driver.token)).body.balance;
  assert.ok(before >= 30);
  assert.equal((await api.put('/me/bank', { holder: 'سائق', bank: 'بنك', iban: 'JO94CBJO0010000000000131000302' }, driver.token)).status, 200);
  const wd = await api.post('/earnings/withdraw', { amount: 30 }, driver.token);
  assert.equal(wd.status, 201);
  assert.equal(r2((await api.get('/earnings', driver.token)).body.balance), r2(before - 30));
  const id = wd.body.withdrawal.id;
  const rs = await Promise.all([1, 2, 3].map(() => api.admin.patch(`/withdrawals/${id}`, { action: 'reject', note: 'اختبار' }, adminTok)));
  assert.equal(rs.filter((x) => x.status === 200).length, 1);
  assert.equal(r2((await api.get('/earnings', driver.token)).body.balance), r2(before));
  // مبلغ أكبر من الرصيد مرفوض + ايبان غير صالح مرفوض
  assert.equal((await api.post('/earnings/withdraw', { amount: 1e6 }, driver.token)).status, 400);
  assert.equal((await api.put('/me/bank', { holder: 'س', bank: 'ب', iban: '123' }, driver.token)).status, 400);
});

// ===== مستحقّات المنصّة =====
test('تسوية المستحقّات: لا تتجاوز الدين ولا تُعالج مرّتين', async () => {
  const d = await api.approvedDriver(nextPhone(), adminTok);
  const trip = await api.publishTrip(d, { price: 40 });
  const p = await api.register(nextPhone());
  const b = (await api.post('/bookings', { rideId: trip.id, seats: 1, payment: 'cash' }, p.token)).body.booking;
  await api.post(`/requests/${b.request_id}/accept`, {}, d.token);
  await api.post(`/trips/${trip.id}/start`, {}, d.token);
  await api.post(`/trips/${trip.id}/complete`, {}, d.token);
  const dues = (await api.get('/me/dues', d.token)).body.dues;
  assert.equal(dues, 6); // 15% من 40
  assert.equal((await api.post('/me/settlements', { amount: 100, reference: 'x' }, d.token)).status, 400);
  const s1 = await api.post('/me/settlements', { amount: 6, reference: 'تحويل' }, d.token);
  assert.equal(s1.status, 201);
  // لا تسوية معلّقة ثانية تتجاوز الدين الإجمالي
  assert.equal((await api.post('/me/settlements', { amount: 6, reference: 'مكرر' }, d.token)).status, 400);
  const id = s1.body.settlement.id;
  const rs = await Promise.all([1, 2].map(() => api.admin.patch(`/settlements/${id}`, { action: 'confirm' }, adminTok)));
  assert.equal(rs.filter((x) => x.status === 200).length, 1);
  assert.equal((await api.get('/me/dues', d.token)).body.dues, 0);
});

// ===== حذف الحساب =====
test('حذف الحساب يمسح الهوية ويمنع التوكن بعدها', async () => {
  const u = await api.register(nextPhone());
  await api.patch('/me', { name: 'سيُحذف', email: 'del@example.com' }, u.token);
  assert.equal((await api.call('DELETE', '/me', {}, u.token)).status, 200);
  assert.equal((await api.get('/me', u.token)).status, 401);
});

// ===== البلاغات والدعم =====
test('البلاغات تتحمّل مدخلات شاذّة بلا خطأ 500', async () => {
  const u = await api.register(nextPhone());
  const r = await api.post('/reports', { category: 'سلوك', against: { x: 1 }, tripId: 'abc', note: 'ملاحظة' }, u.token);
  assert.equal(r.status, 201);
  assert.equal((await api.post('/reports', {}, u.token)).status, 400);
  assert.equal((await api.post('/sos', { lat: 999, lng: 'x', tripId: [] }, u.token)).status, 201);
  assert.equal((await api.post('/support', { message: '' }, u.token)).status, 400);
  assert.equal((await api.post('/support', { subject: 'ب', message: 'مشكلة' }, u.token)).status, 201);
});

test('البحث عن الرحلات يجد الرحلة بالنص والممرّ الجغرافي', async () => {
  const trip = await api.publishTrip(driver, { to: 'الزرقاء', toCoord: [32.07, 36.09] });
  const p = await api.register(nextPhone());
  const byText = await api.get('/rides/search?to=' + encodeURIComponent('الزرقاء'), p.token);
  assert.ok(byText.body.rides.some((x) => x.id === trip.id));
  const byGeo = await api.get('/rides/search?fromLat=31.96&fromLng=35.92&toLat=32.07&toLng=36.09', p.token);
  assert.ok(byGeo.body.rides.some((x) => x.id === trip.id));
  const far = await api.get('/rides/search?fromLat=29.5&fromLng=34.9&toLat=29.6&toLng=35', p.token);
  assert.ok(!far.body.rides.some((x) => x.id === trip.id));
});

test('الإيقاف الإداري يمنع المستخدم فورًا', async () => {
  const u = await api.register(nextPhone());
  assert.equal((await api.admin.patch(`/users/${u.id}/status`, { status: 'suspended' }, adminTok)).status, 200);
  const r = await api.get('/me', u.token);
  assert.equal(r.status, 403);
  assert.equal(r.body.suspended, true);
});

// ===== ميزات جديدة =====
test('الإشعارات: عدّاد غير المقروء + تعليم كمقروء (الكل أو بالمعرّف) ولمالكها فقط', async () => {
  const trip = await api.publishTrip(driver);
  const p = await api.register(nextPhone());
  await api.post('/bookings', { rideId: trip.id, seats: 1, payment: 'cash' }, p.token);
  const before = await api.get('/notifications', driver.token);
  assert.ok(before.body.unread >= 1);
  assert.equal(before.body.notifications[0].read, false);
  const firstId = before.body.notifications[0].id;
  // مستخدم آخر لا يستطيع تعليم إشعار غيره
  const other = await api.post('/notifications/read', { ids: [firstId] }, p.token);
  assert.equal(other.status, 200);
  assert.equal((await api.get('/notifications', driver.token)).body.unread, before.body.unread);
  const one = await api.post('/notifications/read', { ids: [firstId] }, driver.token);
  assert.equal(one.body.unread, before.body.unread - 1);
  const all = await api.post('/notifications/read', {}, driver.token);
  assert.equal(all.body.unread, 0);
  const after = await api.get('/notifications', driver.token);
  assert.ok(after.body.notifications.every((n) => n.read === true));
});

test('إحصاءات السائق: رحلات مكتملة وركّاب ونقد وعمولة', async () => {
  const d = await api.approvedDriver(nextPhone(), adminTok);
  assert.equal((await api.get('/driver/stats', (await api.register(nextPhone())).token)).status, 403);
  const empty = await api.get('/driver/stats', d.token);
  assert.equal(empty.status, 200);
  assert.equal(empty.body.trips.completed, 0);
  assert.equal(empty.body.acceptanceRate, null);
  const trip = await api.publishTrip(d, { price: 20 });
  const p1 = await api.register(nextPhone()), p2 = await api.register(nextPhone());
  const b1 = (await api.post('/bookings', { rideId: trip.id, seats: 1, payment: 'cash' }, p1.token)).body.booking;
  const b2 = (await api.post('/bookings', { rideId: trip.id, seats: 1, payment: 'cash' }, p2.token)).body.booking;
  await api.post(`/requests/${b1.request_id}/accept`, {}, d.token);
  await api.post(`/requests/${b2.request_id}/reject`, {}, d.token);
  await api.post(`/trips/${trip.id}/start`, {}, d.token);
  await api.post(`/trips/${trip.id}/complete`, {}, d.token);
  const st = await api.get('/driver/stats', d.token);
  assert.equal(st.body.trips.completed, 1);
  assert.equal(st.body.passengers.seatsCarried, 1);
  assert.equal(st.body.cashCollected, 20);
  assert.equal(st.body.platformDues, 3);
  assert.equal(st.body.acceptanceRate, 0.5);
});

test('طلبات «اطلب توصيلة» العالقة تنتهي صلاحيتها ويُشعَر الراكب', async () => {
  const p = await api.register(nextPhone());
  const rr = await api.post('/ride-requests', { fromLabel: 'أ', fromCoord: [31.9, 35.9], toLabel: 'ب', toCoord: [32.0, 35.85], seats: 1, payment: 'cash' }, p.token);
  assert.equal(rr.status, 201);
  // نُشغّل وحدة الانتهاء في عملية منفصلة على ملف قاعدة الخادم نفسه مع تقديم الساعة 31 دقيقة
  const { spawnSync } = require('node:child_process');
  const path = require('node:path');
  const dbPath = S.dbPath;
  const script = `
    process.env.DB_PATH = ${JSON.stringify(dbPath)};
    const { expireStaleRideRequests } = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'rideexpiry.js'))});
    (async () => {
      const fresh = await expireStaleRideRequests(Date.now());
      const stale = await expireStaleRideRequests(Date.now() + 31 * 60 * 1000);
      console.log(JSON.stringify({ fresh, stale }));
      process.exit(0);
    })();`;
  const out = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env: S.env });
  const res = JSON.parse(out.stdout.trim().split('\n').pop());
  assert.equal(res.fresh, 0);
  assert.ok(res.stale >= 1);
  const mine = await api.get('/ride-requests/mine', p.token);
  assert.equal(mine.body.requests[0].status, 'cancelled');
  const notes = await api.get('/notifications', p.token);
  assert.ok(notes.body.notifications.some((n) => n.title === 'انتهت مهلة طلب توصيلتك'));
  // مع لغة إنجليزية تُترجم
  const en = await api.call('GET', '/notifications', null, p.token, { 'X-App-Lang': 'en' });
  assert.ok(en.body.notifications.some((n) => n.title === 'Your ride request timed out'));
});

test('محدّد المعدّل على استبدال الأكواد يمنع التخمين الجماعي', async () => {
  const u = await api.register(nextPhone());
  const xf = { 'X-Forwarded-For': '10.77.77.77' };
  let blocked = 0;
  for (let i = 0; i < 14; i++) {
    const r = await api.call('POST', '/promos/redeem', { code: 'GUESS' + i }, u.token, xf);
    if (r.status === 429) blocked++;
  }
  assert.ok(blocked >= 3, 'متوقّع حظر الطلبات بعد 10');
});

test('رسائل الخطأ تُترجم للإنجليزية عند طلبها', async () => {
  const u = await api.register(nextPhone());
  const r = await api.call('POST', '/bookings/999999/rate', { stars: 5 }, u.token, { 'X-App-Lang': 'en' });
  assert.equal(r.status, 404);
  assert.ok(/[A-Za-z]/.test(r.body.error), r.body.error);
});

test('/health يعرض حالة القاعدة', async () => {
  const h = await (await fetch(S.origin + '/health')).json();
  assert.equal(h.ok, true);
  assert.equal(h.db, true);
});

test('البحث: وجود وجهة (نص) يمنع ظهور رحلات لوجهة أخرى لمجرد قرب نقطة الانطلاق', async () => {
  const d = await api.approvedDriver(nextPhone(), adminTok);
  const irbid = await api.publishTrip(d, { from: 'عمان', to: 'إربد', fromCoord: [31.95, 35.91], toCoord: [32.55, 35.85] });
  const zarqa = await api.publishTrip(d, { from: 'عمان', to: 'الزرقاء', fromCoord: [31.96, 35.92], toCoord: [32.07, 36.09] });
  const p = await api.register(nextPhone());
  const ids = (r) => r.body.rides.map((x) => x.id);
  // وجهة نصية + موقع الراكب
  const a = await api.get('/rides/search?to=' + encodeURIComponent('إربد') + '&fromLat=31.95&fromLng=35.91', p.token);
  assert.ok(ids(a).includes(irbid.id));
  assert.ok(!ids(a).includes(zarqa.id), 'رحلة الزرقاء يجب ألا تظهر في بحث إربد');
  // موقع فقط (القريب مني): الرحلتان تظهران
  const near = await api.get('/rides/search?fromLat=31.95&fromLng=35.91', p.token);
  assert.ok(ids(near).includes(irbid.id) && ids(near).includes(zarqa.id));
  // وجهة بالإحداثيات فقط
  const byD = await api.get('/rides/search?toLat=32.07&toLng=36.09', p.token);
  assert.ok(ids(byD).includes(zarqa.id) && !ids(byD).includes(irbid.id));
});

test('تعديل مقاعد الرحلة يتعامل مع السعة الإجمالية دون تقليصها بالحجوزات', async () => {
  const trip = await api.publishTrip(driver, { seats: 4 });
  const p = await api.register(nextPhone());
  await api.post('/bookings', { rideId: trip.id, seats: 2, payment: 'cash' }, p.token);
  // الواجهة تعرض السعة 4 وتعيد إرسالها كما هي → لا تتغيّر المقاعد المتبقّية
  const same = await api.patch(`/trips/${trip.id}`, { seats: 4 }, driver.token);
  assert.equal(same.status, 200);
  assert.equal(same.body.trip.total_seats, 4);
  assert.equal(same.body.trip.seats_left, 2);
  // تقليل السعة تحت المحجوز مرفوض
  assert.equal((await api.patch(`/trips/${trip.id}`, { seats: 1 }, driver.token)).status, 400);
  const less = await api.patch(`/trips/${trip.id}`, { seats: 3 }, driver.token);
  assert.equal(less.body.trip.total_seats, 3);
  assert.equal(less.body.trip.seats_left, 1);
});

test('الأمن: مستندات التوثيق وحقول الملف لا تقبل HTML/روابط خطرة (حماية لوحة الإدارة من XSS)', async () => {
  const d = await api.register(nextPhone());
  await api.patch('/me', { role: 'driver', name: 'سائق' }, d.token);
  const evilEmail = await api.patch('/me', { email: '<img/src=x/onerror=alert(1)>@a.bc' }, d.token);
  assert.equal(evilEmail.status, 400);
  const r = await api.post('/me/verify-request', {
    idNumber: '1'.repeat(80), city: 'x'.repeat(200), serviceType: 'carpool',
    docs: { license: '/uploads/ok_1.jpg', idImage: 'https://example.com/a.png', carFront: 'javascript:alert(1)', carBack: 'x" onerror="alert(1)', ['bad key<']: '/uploads/a.jpg' },
  }, d.token);
  assert.equal(r.status, 200);
  const detail = await api.admin.get(`/users/${d.id}`, adminTok);
  assert.deepEqual(Object.keys(detail.body.docs).sort(), ['idImage', 'license']);
  assert.ok(detail.body.user.city.length <= 60);
  assert.ok(detail.body.user.id_number.length <= 30);
});

test('لوحة الإدارة لا تعرض كلمة المرور الافتراضية وتهرب القيم', async () => {
  const html = await (await fetch(S.origin + '/admin')).text();
  assert.ok(!html.includes('كلمة المرور الافتراضية للتجربة'));
  assert.match(html, /&#39;/); // esc يهرب علامة الاقتباس المفردة
});

test('الويب: الجذر يحوّل لـ/app، المسارات العميقة تخدم التطبيق، وgzip وETag يعملان', async () => {
  const root = await fetch(S.origin + '/', { redirect: 'manual' });
  assert.equal(root.status, 302);
  assert.equal(root.headers.get('location'), '/app');
  const deep = await fetch(S.origin + '/home', { headers: { Accept: 'text/html' } });
  assert.equal(deep.status, 200);
  assert.match(deep.headers.get('content-type'), /text\/html/);
  const gz = await fetch(S.origin + '/app', { headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(gz.headers.get('content-encoding'), 'gzip');
  const etag = gz.headers.get('etag');
  assert.ok(etag);
  const again = await fetch(S.origin + '/app', { headers: { 'If-None-Match': etag } });
  assert.equal(again.status, 304);
  // مسار API مجهول لا يُخدم بصفحة التطبيق
  const api404 = await fetch(S.origin + '/api/nope', { headers: { Accept: 'text/html' } });
  assert.notEqual(api404.headers.get('content-type') || '', 'text/html; charset=utf-8');
  // ملفات PWA والخطوط
  assert.equal((await fetch(S.origin + '/manifest.webmanifest')).status, 200);
  assert.equal((await fetch(S.origin + '/icon.svg')).status, 200);
  const font = await fetch(S.origin + '/assets/node_modules/@expo-google-fonts/cairo/Cairo_400Regular.abc.ttf');
  assert.equal(font.status, 200);
  assert.equal(font.headers.get('content-type'), 'font/ttf');
});

test('أخطاء العميل: JSON تالف → 400 وحجم زائد → 413 (لا 500)', async () => {
  const bad = await fetch(S.origin + '/api/auth/otp/send', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.50.0.1' }, body: '{oops' });
  assert.equal(bad.status, 400);
  const big = await fetch(S.origin + '/api/auth/otp/send', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.50.0.2' }, body: JSON.stringify({ a: 'x'.repeat(2 * 1024 * 1024) }) });
  assert.equal(big.status, 413);
});

test('رابط التتبّع العام: يعمل أثناء الرحلة ولا يكشف موقع السائق بعد انتهائها', async () => {
  const trip = await api.publishTrip(driver);
  const p = await api.register(nextPhone());
  const b = (await api.post('/bookings', { rideId: trip.id, seats: 1, payment: 'cash' }, p.token)).body.booking;
  const share = await api.post(`/bookings/${b.id}/share`, {}, p.token);
  assert.equal(share.status, 200);
  assert.equal((await api.get('/live/' + share.body.token)).status, 200);
  assert.equal((await api.get('/live/nope')).status, 404);
  await api.post(`/requests/${b.request_id}/accept`, {}, driver.token);
  await api.post(`/trips/${trip.id}/start`, {}, driver.token);
  await api.post(`/trips/${trip.id}/location`, { lat: 31.97, lng: 35.9 }, driver.token);
  const live = await api.get('/live/' + share.body.token);
  assert.deepEqual(live.body.driver, [31.97, 35.9]);
  await api.post(`/trips/${trip.id}/complete`, {}, driver.token);
  const done = await api.get('/live/' + share.body.token);
  assert.equal(done.status, 200);
  assert.equal(done.body.driver, null); // لا موقع بعد الاكتمال
});
