// ============================================================
// طبقة الدفع لوصلني — التحقّق من المدفوعات عبر بوابة (Moyasar — مدى/فيزا/أبل باي)
// التفعيل: ضع MOYASAR_SECRET_KEY في متغيّرات البيئة. بلا مفتاح = وضع تطوير (شحن مباشر).
// التدفّق: التطبيق يجمع البطاقة عبر نموذج Moyasar ويحصل على paymentId،
//          ثم يرسله للخادم الذي يتحقّق من حالته الفعلية قبل إضافة الرصيد.
// ============================================================
function paymentsEnabled() { return !!process.env.MOYASAR_SECRET_KEY; }

async function verifyMoyasar(paymentId) {
  const key = process.env.MOYASAR_SECRET_KEY;
  const auth = Buffer.from(key + ':').toString('base64');
  const res = await fetch(`https://api.moyasar.com/v1/payments/${encodeURIComponent(paymentId)}`, {
    headers: { Authorization: `Basic ${auth}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('Moyasar: ' + (data.message || res.status));
  // المبلغ بالهللات؛ والحالة paid عند نجاح الدفع
  return { id: data.id, status: data.status, amount: Number(data.amount) / 100, currency: data.currency };
}

// يتحقّق من الدفع ويعيد {id, amount} عند النجاح، أو يرمي خطأً
async function verifyPayment(paymentId) {
  if (!paymentsEnabled()) throw new Error('لا توجد بوابة دفع مُهيّأة');
  const p = await verifyMoyasar(paymentId);
  if (p.status !== 'paid') throw new Error('لم يكتمل الدفع');
  return p;
}

module.exports = { paymentsEnabled, verifyPayment };
