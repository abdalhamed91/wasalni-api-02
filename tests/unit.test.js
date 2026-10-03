// اختبارات وحدات بلا خادم: توحيد الأرقام، حساب أيام انتهاء الوثائق، محدّد المعدّل، الترجمة.
process.env.DB_PATH = require('node:path').join(require('node:os').tmpdir(), `wasalni-unit-${process.pid}.db`);
const test = require('node:test');
const assert = require('node:assert/strict');

test('normalizePhone يوحّد صيغ الرقم نفسه', () => {
  const { normalizePhone } = require('../src/auth');
  for (const raw of ['0790001111', '790001111', '962790001111', '+962 79 000 1111', '00962790001111', '079-000-1111']) {
    assert.equal(normalizePhone(raw, '+962'), '790001111', raw);
  }
  assert.equal(normalizePhone('', '+962'), '');
  assert.equal(normalizePhone(null, null), '');
});

test('daysUntil يحسب الأيام المتبقّية ويرفض التواريخ الخاطئة', () => {
  const { daysUntil } = require('../src/docexpiry');
  const iso = (offset) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + offset); return d.toISOString().slice(0, 10); };
  assert.equal(daysUntil(iso(0)), 0);
  assert.equal(daysUntil(iso(30)), 30);
  assert.equal(daysUntil(iso(-5)), -5);
  assert.equal(daysUntil('غير تاريخ'), null);
  assert.equal(daysUntil(''), null);
  assert.equal(daysUntil('2025-1-1'), null);
});

test('rateLimit يسمح بالحدّ ثم يردّ 429 مع Retry-After', () => {
  const { rateLimit } = require('../src/security');
  const mw = rateLimit({ windowMs: 60000, max: 3, message: 'كثير' });
  const mkRes = () => { const r = { headers: {}, code: 200, setHeader(k, v) { r.headers[k] = v; }, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } }; return r; };
  let passed = 0;
  for (let i = 0; i < 3; i++) mw({ ip: '1.1.1.1', headers: {} }, mkRes(), () => passed++);
  assert.equal(passed, 3);
  const blocked = mkRes();
  mw({ ip: '1.1.1.1', headers: {} }, blocked, () => assert.fail('يجب الحظر'));
  assert.equal(blocked.code, 429);
  assert.ok(Number(blocked.headers['Retry-After']) > 0);
  // IP آخر غير متأثّر
  let other = 0; mw({ ip: '2.2.2.2', headers: {} }, mkRes(), () => other++);
  assert.equal(other, 1);
});

test('securityHeaders يضيف رؤوس الأمان', () => {
  const { securityHeaders } = require('../src/security');
  const h = {}; let nexted = false;
  securityHeaders({}, { setHeader: (k, v) => { h[k] = v; } }, () => { nexted = true; });
  assert.ok(nexted);
  assert.equal(h['X-Content-Type-Options'], 'nosniff');
  assert.equal(h['X-Frame-Options'], 'SAMEORIGIN');
});

test('tl يترجم للإنجليزية ويبقي العربية كما هي', () => {
  const { tl } = require('../src/i18n');
  assert.equal(tl('ar', 'مطلوب تسجيل الدخول'), 'مطلوب تسجيل الدخول');
  const en = tl('en', 'مطلوب تسجيل الدخول');
  assert.ok(/[A-Za-z]/.test(en), 'يُفترض وجود ترجمة إنجليزية: ' + en);
  assert.equal(tl('en', 'نص غير موجود في القاموس xyz'), 'نص غير موجود في القاموس xyz');
});

test.after(() => { for (const s of ['', '-wal', '-shm']) { try { require('node:fs').unlinkSync(process.env.DB_PATH + s); } catch {} } });
