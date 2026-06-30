// ============================================================
// مخطّط قاعدة بيانات وصلني — متوافق مع SQLite و PostgreSQL
// ============================================================
const db = require('./database');
const PG = db.kind === 'postgres';

// أنواع تتكيّف حسب المحرّك
const ID = PG ? 'BIGSERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
const NOW = 'BIGINT NOT NULL';           // نخزّن الوقت كـepoch ms (متوافق)
const INT = PG ? 'BIGINT' : 'INTEGER';
const BOOL = PG ? 'BOOLEAN' : 'INTEGER';  // SQLite يخزّن 0/1

const TABLES = [
  `CREATE TABLE IF NOT EXISTS users (
    id ${ID},
    phone TEXT UNIQUE NOT NULL,
    dial TEXT NOT NULL DEFAULT '+962',
    country_code TEXT NOT NULL DEFAULT 'JO',
    role TEXT NOT NULL DEFAULT 'passenger',
    name TEXT NOT NULL DEFAULT '',
    email TEXT DEFAULT '',
    gender TEXT,
    rating REAL NOT NULL DEFAULT 5.0,
    rating_count ${INT} DEFAULT 0,
    service_type TEXT DEFAULT 'carpool',
    wallet REAL NOT NULL DEFAULT 0.0,
    earnings REAL NOT NULL DEFAULT 0.0,
    status TEXT NOT NULL DEFAULT 'active',
    verified ${BOOL} NOT NULL DEFAULT ${PG ? 'false' : '0'},
    id_number TEXT DEFAULT '',
    birth_date TEXT DEFAULT '',
    city TEXT DEFAULT '',
    verify_status TEXT NOT NULL DEFAULT 'none',
    verify_submitted_at ${INT},
    docs TEXT DEFAULT '',
    created_at ${NOW}
  )`,
  `CREATE TABLE IF NOT EXISTS otps (
    phone TEXT PRIMARY KEY,
    code TEXT NOT NULL,
    expires_at ${INT} NOT NULL,
    attempts ${INT} NOT NULL DEFAULT 0,
    sent_at ${INT} NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS vehicles (
    user_id ${INT} PRIMARY KEY,
    make TEXT, model TEXT, year TEXT, color TEXT, plate TEXT, capacity ${INT} DEFAULT 4
  )`,
  `CREATE TABLE IF NOT EXISTS transactions (
    id ${ID},
    user_id ${INT} NOT NULL,
    title TEXT NOT NULL,
    amount REAL NOT NULL,
    kind TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT 'passenger',
    created_at ${NOW}
  )`,
  `CREATE TABLE IF NOT EXISTS trips (
    id ${ID},
    driver_id ${INT} NOT NULL,
    from_label TEXT, to_label TEXT,
    from_lat REAL, from_lng REAL, to_lat REAL, to_lng REAL,
    date TEXT, time TEXT,
    price_per_seat REAL NOT NULL,
    total_seats ${INT} NOT NULL,
    gender_pref TEXT DEFAULT 'any',
    kind TEXT NOT NULL DEFAULT 'city',
    cancel_reason TEXT,
    driver_lat REAL, driver_lng REAL, driver_loc_at ${INT},
    status TEXT NOT NULL DEFAULT 'scheduled',
    created_at ${NOW}
  )`,
  `CREATE TABLE IF NOT EXISTS requests (
    id ${ID},
    trip_id ${INT} NOT NULL,
    passenger_id ${INT},
    passenger_name TEXT NOT NULL,
    rating REAL NOT NULL DEFAULT 4.8,
    seats ${INT} NOT NULL DEFAULT 1,
    pickup TEXT NOT NULL,
    pickup_lat REAL, pickup_lng REAL,
    fare REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
  )`,
  `CREATE TABLE IF NOT EXISTS bookings (
    id ${ID},
    passenger_id ${INT} NOT NULL,
    request_id ${INT},
    driver TEXT, driver_rating REAL, car TEXT, plate TEXT,
    from_label TEXT, to_label TEXT, time TEXT,
    seats ${INT} NOT NULL, fare REAL,
    preferences TEXT, pax_note TEXT,
    status TEXT NOT NULL DEFAULT 'confirmed',
    created_at ${NOW}
  )`,
  `CREATE TABLE IF NOT EXISTS threads (
    id ${ID},
    user_id ${INT} NOT NULL,
    peer_name TEXT NOT NULL,
    initial TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS messages (
    id ${ID},
    thread_id ${INT} NOT NULL,
    text TEXT NOT NULL,
    mine ${INT} NOT NULL DEFAULT 1,
    created_at ${NOW}
  )`,
  `CREATE TABLE IF NOT EXISTS notifications (
    id ${ID},
    user_id ${INT} NOT NULL,
    icon TEXT NOT NULL DEFAULT 'bell', tone TEXT NOT NULL DEFAULT 'blue',
    title TEXT NOT NULL, sub TEXT NOT NULL DEFAULT '',
    to_route TEXT,
    created_at ${NOW}
  )`,
  `CREATE TABLE IF NOT EXISTS places (
    id ${ID},
    user_id ${INT} NOT NULL,
    label TEXT NOT NULL, sub TEXT NOT NULL DEFAULT '',
    lat REAL, lng REAL
  )`,
  `CREATE TABLE IF NOT EXISTS cards (
    id ${ID},
    user_id ${INT} NOT NULL,
    brand TEXT NOT NULL DEFAULT 'mada', last4 TEXT NOT NULL,
    exp TEXT NOT NULL, holder TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS reports (
    id ${ID},
    reporter_id ${INT} NOT NULL,
    reporter_role TEXT,
    against TEXT,
    trip_id ${INT},
    category TEXT NOT NULL,
    note TEXT,
    reply TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    created_at ${NOW}
  )`,
  `CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS promos (
    id ${ID},
    code TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    discount_type TEXT NOT NULL DEFAULT 'percent',
    discount_value REAL NOT NULL,
    max_uses ${INT} NOT NULL DEFAULT 0,
    used_count ${INT} NOT NULL DEFAULT 0,
    country TEXT,
    active ${BOOL} NOT NULL DEFAULT ${PG ? 'true' : '1'},
    expires_at ${INT},
    created_at ${NOW}
  )`,
  `CREATE TABLE IF NOT EXISTS admin_notifications (
    id ${ID},
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    audience TEXT NOT NULL DEFAULT 'all',
    sent_count ${INT} NOT NULL DEFAULT 0,
    created_at ${NOW}
  )`,
  `CREATE TABLE IF NOT EXISTS support_tickets (
    id ${ID},
    user_id ${INT},
    user_name TEXT,
    subject TEXT NOT NULL,
    message TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    reply TEXT,
    created_at ${NOW}
  )`,
  `CREATE TABLE IF NOT EXISTS admin_users (
    id ${ID},
    username TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'support',
    permissions TEXT NOT NULL DEFAULT '',
    active ${BOOL} NOT NULL DEFAULT ${PG ? 'true' : '1'},
    created_at ${NOW}
  )`,
  `CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS bank_accounts (
    user_id ${INT} PRIMARY KEY,
    holder TEXT NOT NULL,
    bank TEXT NOT NULL,
    iban TEXT NOT NULL,
    updated_at ${NOW}
  )`,
  `CREATE TABLE IF NOT EXISTS payments (
    id ${ID},
    user_id ${INT} NOT NULL,
    provider TEXT NOT NULL,
    ref TEXT UNIQUE NOT NULL,
    amount REAL NOT NULL,
    created_at ${NOW}
  )`,
  `CREATE TABLE IF NOT EXISTS withdrawals (
    id ${ID},
    user_id ${INT} NOT NULL,
    amount REAL NOT NULL,
    holder TEXT, bank TEXT, iban TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    admin_note TEXT,
    created_at ${NOW},
    paid_at ${INT}
  )`,
  `CREATE TABLE IF NOT EXISTS country_settings (
    code TEXT PRIMARY KEY,
    profit_type TEXT NOT NULL DEFAULT 'percent',
    profit_value REAL NOT NULL DEFAULT 0.15,
    price_per_km REAL NOT NULL DEFAULT 1.5,
    km_cap REAL NOT NULL DEFAULT 2.5,
    enabled ${BOOL} NOT NULL DEFAULT ${PG ? 'true' : '1'}
  )`,
  `CREATE TABLE IF NOT EXISTS reviews (
    id ${ID},
    target_id ${INT} NOT NULL,
    reviewer_id ${INT},
    booking_id ${INT},
    stars ${INT} NOT NULL,
    tags TEXT,
    comment TEXT,
    created_at ${NOW}
  )`,
  `CREATE TABLE IF NOT EXISTS promo_redemptions (
    id ${ID},
    promo_id ${INT} NOT NULL,
    user_id ${INT} NOT NULL,
    amount REAL NOT NULL DEFAULT 0,
    created_at ${NOW}
  )`,
  `CREATE TABLE IF NOT EXISTS ride_requests (
    id ${ID},
    passenger_id ${INT} NOT NULL,
    passenger_name TEXT,
    country_code TEXT,
    from_label TEXT, from_lat REAL, from_lng REAL,
    to_label TEXT, to_lat REAL, to_lng REAL,
    seats ${INT} NOT NULL DEFAULT 1,
    fare REAL NOT NULL DEFAULT 0,
    note TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    driver_id ${INT},
    trip_id ${INT},
    created_at ${NOW}
  )`,
];

// يضمن وجود عمود في جدول (يضيفه إن غاب) — يعمل على SQLite وPostgreSQL
async function ensureColumn(table, column, definition) {
  try {
    if (PG) {
      const r = await db.queryOne(
        `SELECT column_name FROM information_schema.columns WHERE table_name=$1 AND column_name=$2`,
        [table, column]
      );
      if (!r) await db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    } else {
      const cols = await db.query(`PRAGMA table_info(${table})`, []);
      if (!cols.some(c => c.name === column)) await db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  } catch (e) { /* العمود موجod أو خطأ غير حرج */ }
}

async function runMigrations() {
  // أعمدة التوثيق على users (للقواعد القديمة)
  await ensureColumn('users', 'id_number', "TEXT DEFAULT ''");
  await ensureColumn('users', 'birth_date', "TEXT DEFAULT ''");
  await ensureColumn('users', 'city', "TEXT DEFAULT ''");
  await ensureColumn('users', 'verify_status', "TEXT NOT NULL DEFAULT 'none'");
  await ensureColumn('users', 'verify_submitted_at', PG ? 'BIGINT' : 'INTEGER');
  // عمود الرد على البلاغات
  await ensureColumn('reports', 'reply', 'TEXT');
  // ربط طلب الحجز بالراكب (لإشعاره عند القبول/الرفض)
  await ensureColumn('requests', 'passenger_id', PG ? 'BIGINT' : 'INTEGER');
  // ربط الحجز بطلب السائق (للاسترجاع التلقائي عند الرفض)
  await ensureColumn('bookings', 'request_id', PG ? 'BIGINT' : 'INTEGER');
  // وثائق توثيق السائق (روابط الصور كـJSON)
  await ensureColumn('users', 'docs', "TEXT DEFAULT ''");
  // موقع السائق اللحظي أثناء الرحلة
  await ensureColumn('trips', 'driver_lat', 'REAL');
  await ensureColumn('trips', 'driver_lng', 'REAL');
  await ensureColumn('trips', 'driver_loc_at', PG ? 'BIGINT' : 'INTEGER');
  // توكن الإشعارات الفورية (Expo Push)
  await ensureColumn('users', 'push_token', 'TEXT');
  // نوع النقل: city | intercity | public_bus | school_bus
  await ensureColumn('trips', 'kind', "TEXT NOT NULL DEFAULT 'city'");
  // التقييم الحقيقي: عدد التقييمات (0 = بدون تقييم بعد) + منع التقييم المزدوج
  await ensureColumn('users', 'rating_count', PG ? 'INTEGER DEFAULT 0' : 'INTEGER DEFAULT 0');
  await ensureColumn('bookings', 'rated', PG ? 'INTEGER DEFAULT 0' : 'INTEGER DEFAULT 0');
  await ensureColumn('requests', 'rated', PG ? 'INTEGER DEFAULT 0' : 'INTEGER DEFAULT 0');
  // نوع خدمة السائق: carpool | public_bus | school_bus
  await ensureColumn('users', 'service_type', "TEXT DEFAULT 'carpool'");
  // صورة الملف الشخصي (رابط من /uploads)
  await ensureColumn('users', 'avatar', "TEXT DEFAULT ''");
  // وقت طلب التوصيلة (الآن أو وقت محدّد)
  await ensureColumn('ride_requests', 'ride_time', "TEXT DEFAULT 'الآن'");
  // ضريبة القيمة المضافة وسعر الصرف لكل دولة (يديرهما المشرف)
  await ensureColumn('country_settings', 'tax_rate', 'REAL NOT NULL DEFAULT 0');
  await ensureColumn('country_settings', 'exchange_rate', 'REAL NOT NULL DEFAULT 1');
  // تواريخ انتهاء وثائق السائق + تتبّع آخر تنبيه (YYYY-MM-DD)
  await ensureColumn('users', 'license_expiry', "TEXT DEFAULT ''");
  await ensureColumn('users', 'vehicle_reg_expiry', "TEXT DEFAULT ''");
  await ensureColumn('users', 'insurance_expiry', "TEXT DEFAULT ''");
  await ensureColumn('users', 'doc_expiry_notified', "TEXT DEFAULT ''");
  // توثيق البريد الإلكتروني برمز
  await ensureColumn('users', 'email_verified', PG ? 'INTEGER DEFAULT 0' : 'INTEGER DEFAULT 0');
  await ensureColumn('users', 'email_otp', "TEXT DEFAULT ''");
  await ensureColumn('users', 'email_otp_exp', PG ? 'BIGINT' : 'INTEGER');
  // ربط محادثة الراكب بالسائق (الطرف الآخر) لتمرير الرسائل بين الجهتين
  await ensureColumn('threads', 'peer_id', PG ? 'BIGINT' : 'INTEGER');
  // توقيتات انطلاق/وصول الرحلة الفعلية (لصفحة تفاصيل الرحلة)
  await ensureColumn('trips', 'started_at', PG ? 'BIGINT' : 'INTEGER');
  await ensureColumn('trips', 'completed_at', PG ? 'BIGINT' : 'INTEGER');
  // رمز مشاركة رابط تتبّع الرحلة (عام، بلا تسجيل دخول)
  await ensureColumn('bookings', 'share_token', "TEXT DEFAULT ''");
  // طريقة الدفع: wallet (محفظة) أو cash (نقدًا للسائق)
  await ensureColumn('bookings', 'payment', "TEXT DEFAULT 'wallet'");
  await ensureColumn('requests', 'payment', "TEXT DEFAULT 'wallet'");
  // مفاوضة سعر طلب التوصيلة
  await ensureColumn('ride_requests', 'offered_fare', 'REAL');
  await ensureColumn('ride_requests', 'offer_by', "TEXT DEFAULT ''");
}

// فهارس لتسريع الاستعلامات المتكرّرة مع نمو البيانات
const INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_trips_driver ON trips(driver_id)',
  'CREATE INDEX IF NOT EXISTS idx_trips_status ON trips(status)',
  'CREATE INDEX IF NOT EXISTS idx_requests_trip ON requests(trip_id)',
  'CREATE INDEX IF NOT EXISTS idx_requests_passenger ON requests(passenger_id)',
  'CREATE INDEX IF NOT EXISTS idx_bookings_passenger ON bookings(passenger_id)',
  'CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id)',
  'CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id)',
  'CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id)',
  'CREATE INDEX IF NOT EXISTS idx_threads_user ON threads(user_id)',
  'CREATE INDEX IF NOT EXISTS idx_withdrawals_user ON withdrawals(user_id)',
  'CREATE INDEX IF NOT EXISTS idx_withdrawals_status ON withdrawals(status)',
];

async function initSchema() {
  for (const sql of TABLES) await db.exec(sql);
  await runMigrations();
  for (const sql of INDEXES) { try { await db.exec(sql); } catch (e) { /* فهرس موجود */ } }
  // بذور إعدادات الدول
  const defaults = {
    SA: ['percent', 0.15, 1.5, 2.5], JO: ['percent', 0.15, 0.35, 0.6], EG: ['percent', 0.15, 5.0, 9.0],
  };
  for (const [code, [pt, pv, ppk, cap]] of Object.entries(defaults)) {
    const exists = await db.queryOne('SELECT code FROM country_settings WHERE code=?', [code]);
    if (!exists) await db.execute(
      'INSERT INTO country_settings (code,profit_type,profit_value,price_per_km,km_cap) VALUES (?,?,?,?,?)',
      [code, pt, pv, ppk, cap]
    );
  }
  // بذر ضريبة القيمة المضافة الافتراضية لمرة واحدة (لا يعكس تعديل المشرف لاحقًا)
  try {
    const seeded = await db.queryOne("SELECT value FROM config WHERE key='tax_seeded'");
    if (!seeded) {
      const taxSeed = { JO: 0.16, SA: 0.15, EG: 0.14, AE: 0.05, BH: 0.10, OM: 0.05, PS: 0.16, LB: 0.11, QA: 0, KW: 0, IQ: 0 };
      for (const [code, t] of Object.entries(taxSeed)) {
        await db.execute('UPDATE country_settings SET tax_rate=? WHERE code=?', [t, code]);
      }
      const ex = PG ? 'EXCLUDED' : 'excluded';
      await db.execute(`INSERT INTO config (key,value) VALUES ('tax_seeded','1') ON CONFLICT(key) DO UPDATE SET value=${ex}.value`, []);
    }
  } catch (e) { /* غير حرج */ }
  console.log(`✅ المخطّط جاهز (${db.kind})`);
}

module.exports = { initSchema, PG };
