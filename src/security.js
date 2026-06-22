// ============================================================
// طبقة أمان وصلني — بلا تبعيات خارجية (تعمل على Railway مباشرة)
// رؤوس أمان + تحديد معدّل الطلبات + فحص الأسرار في الإنتاج
// ============================================================
const IS_PROD = process.env.NODE_ENV === 'production';

// يرفض التشغيل في الإنتاج إن بقيت الأسرار على قيمها الافتراضية
function assertProdSecrets() {
  if (!IS_PROD) return;
  const weak = [];
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'wasalni-dev-secret-change-in-production') weak.push('JWT_SECRET');
  if (!process.env.ADMIN_SECRET || process.env.ADMIN_SECRET === 'wasalni-admin') weak.push('ADMIN_SECRET');
  if (weak.length) {
    throw new Error(
      `أسرار غير آمنة في الإنتاج (${weak.join(', ')}). اضبط قيمًا عشوائية قوية في متغيّرات البيئة قبل التشغيل.`
    );
  }
}

// رؤوس أمان أساسية لكل الردود
function securityHeaders(_req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  res.setHeader('Permissions-Policy', 'geolocation=(self), microphone=(), camera=()');
  if (IS_PROD) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  next();
}

// محدّد معدّل بسيط في الذاكرة (نافذة ثابتة لكل IP) — كافٍ لخادم واحد
function rateLimit({ windowMs = 60000, max = 30, message = 'محاولات كثيرة، حاول لاحقًا' } = {}) {
  const hits = new Map(); // ip -> { count, reset }
  return (req, res, next) => {
    const now = Date.now();
    // تنظيف دوري لمنع نمو الذاكرة
    if (hits.size > 5000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    let e = hits.get(ip);
    if (!e || e.reset < now) { e = { count: 0, reset: now + windowMs }; hits.set(ip, e); }
    e.count++;
    if (e.count > max) {
      const retryAfter = Math.ceil((e.reset - now) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({ error: message, retryAfter });
    }
    next();
  };
}

module.exports = { assertProdSecrets, securityHeaders, rateLimit, IS_PROD };
