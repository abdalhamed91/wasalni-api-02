// اختبار تراجع شامل لواجهة وصلني API — يغطي التسجيل والتوثيق والاعتماد
// الإداري ونشر رحلة والبحث والحجز (محفظة/نقد) وطلب التوصيلة الفوري
// (محفظة/نقد) والمسارات المحفوظة والمجموعات ودخول البريد والتقييم.
//
// التشغيل: شغّل خادمًا محليًّا بقاعدة بيانات مؤقّتة نظيفة ثم نفّذ هذا الملف:
//   rm -f /tmp/x.db*
//   DB_PATH=/tmp/x.db PORT=4090 JWT_SECRET=test ADMIN_SECRET=wasalni-admin node server.js &
//   node tests/regression.js
// (اضبط TEST_BASE إن استخدمت منفذًا مختلفًا)
const BASE = process.env.TEST_BASE || 'http://localhost:4090/api';
const ADMIN_BASE = BASE + '/admin';

let pass = 0, fail = 0;
const failures = [];
function check(label, cond, extra) {
  if (cond) { pass++; console.log('  OK  ', label); }
  else { fail++; failures.push(label); console.log('  FAIL', label, extra !== undefined ? JSON.stringify(extra) : ''); }
}

async function req(method, path, body, token, base = BASE) {
  const r = await fetch(base + path, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: method === 'GET' ? undefined : JSON.stringify(body || {}),
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, body: j };
}

async function registerPhone(phone) {
  const s = await req('POST', '/auth/otp/send', { phone, dial: '+962' });
  const v = await req('POST', '/auth/otp/verify', { phone, dial: '+962', countryCode: 'JO', code: s.body.devCode });
  return v.body;
}

async function main() {
  console.log('== health ==');
  const h = await req('GET', '/health');
  check('health ok', h.status === 200 && h.body.ok === true, h.body);

  console.log('== registration ==');
  const pax = await registerPhone('790000001');
  check('passenger registered', !!pax.token, pax);
  const paxToken = pax.token;

  const drv = await registerPhone('790000002');
  check('driver account registered', !!drv.token, drv);
  const drvToken = drv.token;

  console.log('== unverified/passenger cannot publish a trip (should be BLOCKED) ==');
  const sneaky = await req('POST', '/trips', { from: 'A', to: 'B', time: 'الآن', price: 10, seats: 2 }, paxToken);
  check('plain passenger publishing a trip is rejected', sneaky.status >= 400, sneaky.body);

  console.log('== driver onboarding ==');
  await req('PATCH', '/me', { role: 'driver', name: 'سائق تجريبي' }, drvToken);
  const vreq = await req('POST', '/me/verify-request', { idNumber: '1234567890', birthDate: '1990-01-01', city: 'عمان', serviceType: 'carpool' }, drvToken);
  check('verify-request accepted', vreq.status === 200, vreq.body);
  await req('PUT', '/me/vehicle', { make: 'Kia', model: 'Optima', year: '2020', color: 'أبيض', plate: 'AB-1234', capacity: 4 }, drvToken);

  console.log('== driver still cannot publish before admin approval ==');
  const beforeApproval = await req('POST', '/trips', { from: 'عمان', to: 'إربد', time: '5:00 م', price: 10, seats: 3 }, drvToken);
  check('unapproved driver publishing a trip is rejected', beforeApproval.status >= 400, beforeApproval.body);

  console.log('== admin approves driver ==');
  const adminLoginBad = await req('POST', '/login', { passcode: 'wrong-password' }, null, ADMIN_BASE);
  check('admin login wrong password rejected', adminLoginBad.status === 401, adminLoginBad.body);
  const adminLogin = await req('POST', '/login', { passcode: process.env.ADMIN_SECRET || 'wasalni-admin' }, null, ADMIN_BASE);
  check('admin login ok', adminLogin.status === 200 && !!adminLogin.body.token, adminLogin.body);
  const adminToken = adminLogin.body.token;
  const pending = await req('GET', '/drivers/pending', null, adminToken, ADMIN_BASE);
  const drvId = (pending.body.drivers || []).find(d => d.phone === '790000002')?.id;
  check('driver shows up in pending list', !!drvId, pending.body);
  const approve = await req('POST', `/drivers/${drvId}/verify`, { approve: true }, adminToken, ADMIN_BASE);
  check('admin approve driver ok', approve.status === 200, approve.body);

  console.log('== driver publishes a trip now that approved ==');
  const pub = await req('POST', '/trips', { from: 'عمان', to: 'إربد', fromCoord: [31.95, 35.91], toCoord: [32.55, 35.85], time: '5:00 م', price: 10, seats: 3 }, drvToken);
  check('approved driver can publish', pub.status === 201 && !!pub.body.trip, pub.body);
  const tripId = pub.body.trip?.id;

  console.log('== passenger searches and finds the trip ==');
  const search = await req('GET', `/rides/search?to=${encodeURIComponent('إربد')}`, null, paxToken);
  const found = (search.body.rides || []).some(t => t.id === tripId);
  check('passenger search finds published trip', found, search.body.rides?.map(t => t.id));

  console.log('== wallet top-up (dev mode) + booking with wallet ==');
  const topup = await req('POST', '/wallet/topup', { amount: 200 }, paxToken);
  check('dev-mode topup works', topup.status === 200 && topup.body.balance === 200, topup.body);
  const book1 = await req('POST', '/bookings', { rideId: tripId, seats: 1, to: 'إربد' }, paxToken);
  check('wallet booking succeeds', book1.status === 201, book1.body);
  const meAfterBook = await req('GET', '/me', null, paxToken);
  check('wallet debited after booking', meAfterBook.body.user.wallet === round2(200 - 10), meAfterBook.body.user.wallet);

  console.log('== second passenger books same trip with CASH ==');
  const pax2 = await registerPhone('790000003');
  const book2 = await req('POST', '/bookings', { rideId: tripId, seats: 1, to: 'إربد', payment: 'cash' }, pax2.token);
  check('cash booking succeeds without wallet balance', book2.status === 201, book2.body);
  const pax2After = await req('GET', '/me', null, pax2.token);
  check('cash booking: wallet untouched (still 0)', pax2After.body.user.wallet === 0, pax2After.body.user.wallet);

  console.log('== driver accepts both booking requests ==');
  const acc1 = await req('POST', `/requests/${book1.body.booking.request_id}/accept`, {}, drvToken);
  check('driver accepts wallet booking request', acc1.status === 200, acc1.body);
  const acc2 = await req('POST', `/requests/${book2.body.booking.request_id}/accept`, {}, drvToken);
  check('driver accepts cash booking request', acc2.status === 200, acc2.body);

  console.log('== driver starts + completes the trip, checks cash vs wallet accounting ==');
  const start = await req('POST', `/trips/${tripId}/start`, {}, drvToken);
  check('trip start ok', start.status === 200, start.body);
  const complete = await req('POST', `/trips/${tripId}/complete`, {}, drvToken);
  check('trip complete ok', complete.status === 200, complete.body);
  check('trip complete reports cashCollected > 0', complete.body.cashCollected > 0, complete.body);
  check('trip complete gross reflects only wallet fare (10)', complete.body.gross === 10, complete.body);

  console.log('== on-demand ride-request flow (wallet) ==');
  const rrPax = await registerPhone('790000004');
  await req('POST', '/wallet/topup', { amount: 100 }, rrPax.token);
  const rr = await req('POST', '/ride-requests', { fromLabel: 'من', fromCoord: [31.9, 35.9], toLabel: 'إلى', toCoord: [32.0, 35.85], seats: 1, payment: 'wallet' }, rrPax.token);
  check('ride-request created', rr.status === 201, rr.body);
  const rrId = rr.body.request?.id;
  const offer = await req('POST', `/ride-requests/${rrId}/offer`, { fare: 8 }, drvToken);
  check('driver offer accepted by server', offer.status === 200, offer.body);
  const agree = await req('POST', `/ride-requests/${rrId}/agree`, {}, rrPax.token);
  check('passenger agree finalizes ride-request', agree.status === 201, agree.body);
  const rrPaxAfter = await req('GET', '/me', null, rrPax.token);
  check('wallet ride-request: wallet debited by agreed fare', rrPaxAfter.body.user.wallet === round2(100 - 8), rrPaxAfter.body.user.wallet);

  console.log('== on-demand ride-request flow (cash) ==');
  const rrPax2 = await registerPhone('790000005');
  const rr2 = await req('POST', '/ride-requests', { fromLabel: 'من', fromCoord: [31.9, 35.9], toLabel: 'إلى', toCoord: [32.0, 35.85], seats: 1, payment: 'cash' }, rrPax2.token);
  const rr2Id = rr2.body.request?.id;
  await req('POST', `/ride-requests/${rr2Id}/offer`, { fare: 9 }, drvToken);
  const agree2 = await req('POST', `/ride-requests/${rr2Id}/agree`, {}, rrPax2.token);
  check('cash ride-request finalizes without wallet balance', agree2.status === 201, agree2.body);
  const rrPax2After = await req('GET', '/me', null, rrPax2.token);
  check('cash ride-request: wallet untouched (still 0)', rrPax2After.body.user.wallet === 0, rrPax2After.body.user.wallet);

  console.log('== saved routes CRUD ==');
  const sr = await req('POST', '/saved-routes', { label: 'المنزل-الجامعة', fromLabel: 'المنزل', fromCoord: [31.9, 35.9], toLabel: 'الجامعة', toCoord: [32.0, 35.87] }, paxToken);
  check('saved route created', sr.status === 201, sr.body);
  const srList = await req('GET', '/saved-routes', null, paxToken);
  check('saved route appears in list', (srList.body.routes || []).some(r => r.id === sr.body.route.id), srList.body);
  const srDel = await req('DELETE', `/saved-routes/${sr.body.route.id}`, null, paxToken);
  check('saved route deleted', srDel.status === 200, srDel.body);

  console.log('== groups ==');
  const grp = await req('POST', '/groups', { name: 'اختبار', fromLabel: 'من', fromCoord: [31.9, 35.9], toLabel: 'إلى', toCoord: [32.0, 35.87] }, paxToken);
  check('group created', grp.status === 201, grp.body);
  const joinRes = await req('POST', '/groups/join', { code: grp.body.group.join_code }, drvToken);
  check('driver joins group by code', joinRes.status === 201, joinRes.body);
  const grpDetail = await req('GET', `/groups/${grp.body.group.id}`, null, paxToken);
  check('group detail shows 2 members', (grpDetail.body.members || []).length === 2, grpDetail.body);
  const leaveRes = await req('POST', `/groups/${grp.body.group.id}/leave`, {}, drvToken);
  check('driver leaves group', leaveRes.status === 200, leaveRes.body);

  console.log('== email login ==');
  const eOtp = await req('POST', '/me/email/otp', { email: 'pax@example.com' }, paxToken);
  await req('POST', '/me/email/verify', { email: 'pax@example.com', code: eOtp.body.devCode }, paxToken);
  const eSend = await req('POST', '/auth/email/send', { email: 'pax@example.com' });
  check('email login send ok after verify', eSend.status === 200, eSend.body);
  const eVerify = await req('POST', '/auth/email/verify', { email: 'pax@example.com', code: eSend.body.devCode });
  check('email login verify returns token', eVerify.status === 200 && !!eVerify.body.token, eVerify.body);

  console.log('== ratings ==');
  const rate = await req('POST', `/bookings/${book1.body.booking.id}/rate`, { stars: 5 }, paxToken);
  check('passenger rates driver after completed trip', rate.status === 200, rate.body);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log('FAILURES:', failures.join(' | ')); process.exit(1); }
}
function round2(n) { return Math.round(n * 100) / 100; }
main().catch(e => { console.error('SCRIPT CRASHED', e); process.exit(1); });
