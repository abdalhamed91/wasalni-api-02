// ============================================================
// تقديم صفحات الويب الثابتة بكفاءة: ضغط gzip مخزّن في الذاكرة + ETag (webapp.html بحجم ~4 ميغابايت
// بترميز base64 وكان يُرسَل خامًا في كل زيارة)، وتقديم خطوط التطبيق التي يطلبها Expo كملفات
// (كانت 404 ويؤخّر ذلك الإقلاع)، وإعادة توجيه المسارات العميقة للتطبيق (/home …) إلى الصفحة نفسها.
// ============================================================
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const cache = new Map(); // file -> { mtimeMs, raw, gzip, etag }

function load(file) {
  const st = fs.statSync(file);
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs) return hit;
  const raw = fs.readFileSync(file);
  const entry = {
    mtimeMs: st.mtimeMs, raw,
    gzip: zlib.gzipSync(raw, { level: 9 }),
    etag: '"' + crypto.createHash('sha1').update(raw).digest('hex').slice(0, 20) + '"',
  };
  cache.set(file, entry);
  return entry;
}

// يرسل ملفًا (HTML عادةً) مضغوطًا إن قبِل العميل ذلك، مع 304 عند تطابق ETag
function sendCompressed(req, res, file, contentType = 'text/html; charset=utf-8') {
  let e;
  try { e = load(file); } catch { return res.status(404).json({ error: 'غير موجود' }); }
  res.setHeader('ETag', e.etag);
  res.setHeader('Cache-Control', 'no-cache'); // يتحقّق بـETag في كل مرة (تحديث فوري عند نشر نسخة جديدة)
  res.setHeader('Vary', 'Accept-Encoding');
  if (req.headers['if-none-match'] === e.etag) return res.status(304).end();
  res.type(contentType);
  if (/\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) {
    res.setHeader('Content-Encoding', 'gzip');
    return res.end(e.gzip);
  }
  return res.end(e.raw);
}

// الخطوط المضمّنة في webapp.html كـ data-URI: نستخرجها مرة واحدة لتقديمها على المسارات التي يطلبها Expo
let fontMap = null;
function fonts(webappFile) {
  if (fontMap) return fontMap;
  fontMap = new Map();
  try {
    const html = fs.readFileSync(webappFile, 'utf8');
    const re = /@font-face\{font-family:'([^']+)';src:url\(data:font\/ttf;base64,([A-Za-z0-9+/=]+)\)/g;
    let m;
    while ((m = re.exec(html))) fontMap.set(m[1], Buffer.from(m[2], 'base64'));
  } catch (e) { console.warn('تعذّر استخراج الخطوط:', e.message); }
  return fontMap;
}

function mount(app, dir) {
  const webapp = path.join(dir, 'webapp.html');
  // /assets/node_modules/@expo-google-fonts/<pkg>/<Family>.<hash>.ttf
  app.get('/assets/node_modules/@expo-google-fonts/:pkg/:file', (req, res, next) => {
    const family = String(req.params.file).split('.')[0];
    const buf = fonts(webapp).get(family);
    if (!buf) return next();
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.type('font/ttf').send(buf);
  });
  app.get('/app', (req, res) => sendCompressed(req, res, webapp));
  app.get('/admin', (req, res) => sendCompressed(req, res, path.join(dir, 'admin.html')));
  // PWA: بيان التطبيق وأيقونته (تثبيت على الشاشة الرئيسية من المتصفح)
  const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#EEF2FB"/><path d="M26 8 L14 54 L26 43 Z" fill="#1D4FB0"/><path d="M32 10 C44 21 52 34 54 44 L32 39 Z" fill="#FF7A2F"/></svg>';
  app.get('/icon.svg', (_req, res) => { res.setHeader('Cache-Control', 'public, max-age=86400'); res.type('image/svg+xml').send(ICON); });
  app.get('/manifest.webmanifest', (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.type('application/manifest+json').send(JSON.stringify({
      name: 'وصلني', short_name: 'وصلني', description: 'شارك الطريق، وخلّ التكلفة أقل',
      lang: 'ar', dir: 'rtl', start_url: '/app', scope: '/', display: 'standalone',
      background_color: '#EEF2FB', theme_color: '#0F2F72',
      icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
    }));
  });
  // الجذر → التطبيق
  app.get('/', (_req, res) => res.redirect(302, '/app'));
}

// آخر معالج قبل 404: مسارات التطبيق العميقة (تحديث الصفحة/رابط محفوظ) تُخدم بصفحة التطبيق نفسها.
// لا يشمل /api و/uploads و/assets و/download ولا الطلبات التي ليست لصفحة HTML.
function spaFallback(dir) {
  const webapp = path.join(dir, 'webapp.html');
  return (req, res, next) => {
    if (req.method !== 'GET') return next();
    if (/^\/(api|uploads|assets|download|pay|live|health|manifest\.webmanifest|icon\.svg)(\/|$)/.test(req.path)) return next();
    if (path.extname(req.path)) return next(); // ملف بامتداد (صورة/خط…) غير موجود → 404 عادي
    if (!String(req.headers.accept || '').includes('text/html')) return next();
    return sendCompressed(req, res, webapp);
  };
}

module.exports = { mount, spaFallback, sendCompressed };
