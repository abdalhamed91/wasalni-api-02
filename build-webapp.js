#!/usr/bin/env node
// يبني webapp.html (المخدوم على /app) بتضمين حزمة Expo web المُصدّرة كـ data-URI.
// الاستخدام: 1) في مجلد التطبيق نفّذ: npx expo export -p web --output-dir dist
//            2) ثم من مجلد الخادم: node build-webapp.js
// يحافظ على قالب webapp.html كاملًا ويستبدل فقط محتوى حزمة الدخول base64.
const fs = require('fs');
const path = require('path');

// المسار الجديد (المستودعان شقيقان تحت C:\Users\abdul\wasalni) مع بديل للمسار القديم
const APP_DIST = fs.existsSync(path.resolve(__dirname, '../wasalni-app/dist'))
  ? path.resolve(__dirname, '../wasalni-app/dist')
  : path.resolve(__dirname, '../../wasalni-app/wasalni-app/dist');
const WEBAPP = path.join(__dirname, 'webapp.html');

// أحدث ملف entry-*.js
const jsDir = path.join(APP_DIST, '_expo/static/js/web');
const entry = fs.readdirSync(jsDir).filter(f => /^entry-.*\.js$/.test(f))
  .map(f => ({ f, m: fs.statSync(path.join(jsDir, f)).mtimeMs }))
  .sort((a, b) => b.m - a.m)[0];
if (!entry) { console.error('✖ لم يُعثر على حزمة entry-*.js — شغّل expo export أولًا'); process.exit(1); }

const bundle = fs.readFileSync(path.join(jsDir, entry.f));
const b64 = bundle.toString('base64');
console.log(`📦 حزمة الدخول: ${entry.f} (${(bundle.length / 1048576).toFixed(2)} ميغابايت)`);

let html = fs.readFileSync(WEBAPP, 'utf8');
const re = /(<script src="data:text\/javascript;base64,)[^"]*(")/;
if (!re.test(html)) { console.error('✖ لم يُعثر على وسم الحزمة المضمّنة في webapp.html'); process.exit(1); }
html = html.replace(re, `$1${b64}$2`);
fs.writeFileSync(WEBAPP, html);
console.log(`✅ تم تحديث webapp.html (${(fs.statSync(WEBAPP).size / 1048576).toFixed(2)} ميغابايت)`);
