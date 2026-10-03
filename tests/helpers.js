// أدوات اختبارات التكامل: تشغّل الخادم الفعلي في عملية فرعية بقاعدة بيانات مؤقّتة
// على منفذ حرّ، وتوفّر عميل HTTP صغيرًا ودوالّ تسجيل/اعتماد مستخدمين.
const { spawn } = require('node:child_process');
const net = require('node:net');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const ADMIN_SECRET = 'test-admin-secret';

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
    srv.on('error', reject);
  });
}

async function startServer() {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wasalni-test-'));
  const env = {
    ...process.env, PORT: String(port), DB_PATH: path.join(dir, 'test.db'),
    JWT_SECRET: 'test-jwt-secret', ADMIN_SECRET, NODE_ENV: 'test',
  };
  delete env.DATABASE_URL; delete env.MOYASAR_SECRET_KEY; delete env.MOYASAR_PUBLISHABLE_KEY;
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const origin = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(origin + '/health'); if (r.ok) break; } catch { /* لم يبدأ بعد */ }
    if (child.exitCode != null) throw new Error('الخادم توقّف مبكّرًا:\n' + log);
    await new Promise((r) => setTimeout(r, 100));
  }
  const api = makeClient(origin);
  return {
    origin, api, dbPath: env.DB_PATH, log: () => log,
    async stop() { child.kill(); await new Promise((r) => child.once('exit', r)); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

let ipCounter = 1;
function makeClient(origin) {
  async function call(method, p, body, token, extraHeaders = {}) {
    const res = await fetch(origin + '/api' + p, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...extraHeaders },
      body: method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(body || {}),
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, body: json, headers: res.headers };
  }
  const client = {
    call,
    get: (p, t) => call('GET', p, null, t),
    post: (p, b, t) => call('POST', p, b, t),
    patch: (p, b, t) => call('PATCH', p, b, t),
    put: (p, b, t) => call('PUT', p, b, t),
    del: (p, t) => call('DELETE', p, null, t),
    // يسجّل مستخدمًا برقم فريد (X-Forwarded-For مختلف لكل مستخدم كي لا يصطدم بمحدّد معدّل الـIP)
    async register(phone, countryCode = 'JO') {
      const xf = { 'X-Forwarded-For': `10.1.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}` };
      const s = await call('POST', '/auth/otp/send', { phone, dial: '+962' }, null, xf);
      const v = await call('POST', '/auth/otp/verify', { phone, dial: '+962', countryCode, code: s.body.devCode }, null, xf);
      if (!v.body.token) throw new Error('فشل التسجيل: ' + JSON.stringify(v.body));
      return { token: v.body.token, id: v.body.user.id, user: v.body.user };
    },
    async adminToken() {
      const r = await call('POST', '/admin/login', { passcode: ADMIN_SECRET });
      return r.body.token;
    },
    admin: {
      get: async (p, t) => call('GET', '/admin' + p, null, t),
      post: async (p, b, t) => call('POST', '/admin' + p, b, t),
      patch: async (p, b, t) => call('PATCH', '/admin' + p, b, t),
    },
    // سائق معتمَد جاهز للنشر (مركبة + توثيق + اعتماد إداري)
    async approvedDriver(phone, adminToken) {
      const d = await client.register(phone);
      await client.patch('/me', { role: 'driver', name: 'سائق ' + phone }, d.token);
      await client.post('/me/verify-request', { idNumber: '1234567890', birthDate: '1990-01-01', city: 'عمان', serviceType: 'carpool' }, d.token);
      await client.put('/me/vehicle', { make: 'Kia', model: 'Optima', year: '2020', color: 'أبيض', plate: 'AB-' + phone.slice(-4), capacity: 4 }, d.token);
      const ap = await client.admin.post(`/drivers/${d.id}/verify`, { approve: true }, adminToken);
      if (ap.status !== 200) throw new Error('فشل الاعتماد: ' + JSON.stringify(ap.body));
      return d;
    },
    async publishTrip(driver, over = {}) {
      const r = await client.post('/trips', { from: 'عمان', to: 'إربد', fromCoord: [31.95, 35.91], toCoord: [32.55, 35.85], time: '5:00 م', price: 10, seats: 3, ...over }, driver.token);
      if (r.status !== 201) throw new Error('فشل نشر الرحلة: ' + JSON.stringify(r.body));
      return r.body.trip;
    },
    async topup(user, amount) { return client.post('/wallet/topup', { amount }, user.token); },
    async balance(user) { return (await client.get('/me', user.token)).body.user.wallet; },
  };
  return client;
}

module.exports = { startServer, ADMIN_SECRET };
