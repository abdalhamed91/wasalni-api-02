// ============================================================
// طبقة بيانات وصلني — async موحّدة (SQLite تطوير · PostgreSQL إنتاج)
// ============================================================
const db = require('./database');
const { initSchema } = require('./schema');

const now = () => Date.now();
const round2 = (n) => Math.round(n * 100) / 100;
const COMMISSION_RATE = 0.15;
const SERVICE_COUNTRIES = ['SA', 'JO', 'EG'];

async function insertReturningId(table, columns, values) {
  const placeholders = columns.map(() => '?').join(',');
  if (db.kind === 'postgres') {
    const r = await db.execute(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${placeholders}) RETURNING id`, values);
    return r.rows[0].id;
  }
  const r = await db.execute(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${placeholders})`, values);
  return r.lastId;
}

async function seedRides() {
  // لا بيانات وهمية — الرحلات الحقيقية يُنشئها السائقون فقط
  return;
}

async function initDb() { await initSchema(); }

async function addTxn(userId, scope, title, amount, kind) {
  await db.execute('INSERT INTO transactions (user_id,scope,title,amount,kind,created_at) VALUES (?,?,?,?,?,?)',
    [userId, scope, title, round2(Math.abs(amount)), kind, now()]);
}
async function addNotif(userId, icon, tone, title, sub, toRoute = null) {
  await db.execute('INSERT INTO notifications (user_id,icon,tone,title,sub,to_route,created_at) VALUES (?,?,?,?,?,?,?)',
    [userId, icon, tone, title, sub, toRoute, now()]);
  // إشعار فوري للجهاز (إن وُجد توكن) — بلا انتظار حتى لا يبطّئ الطلب
  try { require('./push').pushToUser(userId, title, sub, toRoute ? { to: toRoute } : undefined); } catch (e) {}
}

async function ensureSeedForUser(_userId, _name) {
  // المستخدم الجديد يبدأ نظيفًا تمامًا — لا إشعارات/محادثات/بيانات مسبقة.
}

async function getConfig(key, def) {
  const row = await db.queryOne('SELECT value FROM config WHERE key=?', [key]);
  return row ? row.value : def;
}
async function setConfig(key, value) {
  const ex = db.kind === 'postgres' ? 'EXCLUDED' : 'excluded';
  await db.execute(`INSERT INTO config (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=${ex}.value`, [key, String(value)]);
}
async function commissionRate() { return Number(await getConfig('commission_rate', String(COMMISSION_RATE))); }
async function serviceCountries() { return (await getConfig('service_countries', SERVICE_COUNTRIES.join(','))).split(',').filter(Boolean); }

async function countrySetting(code) {
  const row = await db.queryOne('SELECT * FROM country_settings WHERE code=?', [code]);
  if (row) return row;
  return { code, profit_type: 'percent', profit_value: await commissionRate(), price_per_km: 1.5, km_cap: 2.5, enabled: 1 };
}
async function platformProfit(code, gross) {
  const c = await countrySetting(code);
  if (c.profit_type === 'flat') return round2(Math.min(c.profit_value, gross));
  return round2(gross * c.profit_value);
}
async function seatPriceForDistance(code, km) {
  const c = await countrySetting(code);
  const rate = Math.min(c.price_per_km, c.km_cap);
  return round2(Math.max(rate, rate * km));
}
async function allCountrySettings() { return db.query('SELECT * FROM country_settings ORDER BY code'); }
async function setCountrySetting(code, patch) {
  const cur = await countrySetting(code);
  const next = { ...cur, ...patch, code };
  const enabledVal = db.kind === 'postgres' ? !!next.enabled : (next.enabled ? 1 : 0);
  const ex = db.kind === 'postgres' ? 'EXCLUDED' : 'excluded';
  await db.execute(
    `INSERT INTO country_settings (code,profit_type,profit_value,price_per_km,km_cap,enabled)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(code) DO UPDATE SET profit_type=${ex}.profit_type, profit_value=${ex}.profit_value,
       price_per_km=${ex}.price_per_km, km_cap=${ex}.km_cap, enabled=${ex}.enabled`,
    [code, next.profit_type, Number(next.profit_value), Number(next.price_per_km), Number(next.km_cap), enabledVal]
  );
  return countrySetting(code);
}

module.exports = {
  db, now, round2, insertReturningId, initDb,
  addTxn, addNotif, ensureSeedForUser,
  COMMISSION_RATE, SERVICE_COUNTRIES,
  getConfig, setConfig, commissionRate, serviceCountries,
  countrySetting, platformProfit, seatPriceForDistance, allCountrySettings, setCountrySetting,
};
