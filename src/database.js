// ============================================================
// محوّل قاعدة البيانات الموحّد لوصلني
// يدعم: PostgreSQL (إنتاج) عبر DATABASE_URL، أو SQLite (تطوير محلي)
// واجهة موحّدة async: query / queryOne / execute / tx
// ============================================================
const USE_PG = !!process.env.DATABASE_URL;

let impl;

if (USE_PG) {
  // ---------- PostgreSQL ----------
  const { Pool } = require('pg');
  const isLocal = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL);
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: isLocal ? false : { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 30000,
  });
  // تحويل علامات ? إلى $1,$2.. التلقائي
  const toPg = (sql) => { let i = 0; return sql.replace(/\?/g, () => `$${++i}`); };
  impl = {
    kind: 'postgres',
    async query(sql, params = []) { const r = await pool.query(toPg(sql), params); return r.rows; },
    async queryOne(sql, params = []) { const r = await pool.query(toPg(sql), params); return r.rows[0] || null; },
    async execute(sql, params = []) { const r = await pool.query(toPg(sql), params); return { rowCount: r.rowCount, rows: r.rows }; },
    async exec(sql) { await pool.query(sql); },
    async tx(fn) {
      const client = await pool.connect();
      try { await client.query('BEGIN'); const res = await fn(client); await client.query('COMMIT'); return res; }
      catch (e) { await client.query('ROLLBACK'); throw e; }
      finally { client.release(); }
    },
    pool,
  };
} else {
  // ---------- SQLite (تطوير) ----------
  const { DatabaseSync } = require('node:sqlite');
  const path = require('path');
  const fs = require('fs');
  const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'wasalni.db');
  try { fs.mkdirSync(path.dirname(DB_PATH), { recursive: true }); } catch (e) {}
  const sdb = new DatabaseSync(DB_PATH);
  sdb.exec('PRAGMA journal_mode = WAL;');
  sdb.exec('PRAGMA foreign_keys = ON;');
  impl = {
    kind: 'sqlite',
    async query(sql, params = []) { return sdb.prepare(sql).all(...params); },
    async queryOne(sql, params = []) { return sdb.prepare(sql).get(...params) || null; },
    async execute(sql, params = []) { const r = sdb.prepare(sql).run(...params); return { rowCount: r.changes, lastId: r.lastInsertRowid }; },
    async exec(sql) { sdb.exec(sql); },
    async tx(fn) { return fn(impl); }, // SQLite متزامن — معاملة مبسّطة
    raw: sdb,
  };
}

module.exports = impl;
