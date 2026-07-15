// ============================================================
// الرحلات المتكرّرة: يحدّد السائق أيام الأسبوع مرّة واحدة، ونشر رحلة
// فعلية تلقائيًا كل يوم يطابق (مرّة واحدة يوميًا) دون تدخّل يدوي.
// ============================================================
const { db, now, insertReturningId } = require('./db');
const { notifyRouteAlerts } = require('./alerts');

const todayStr = () => new Date().toISOString().slice(0, 10); // YYYY-MM-DD
const dow = () => new Date().getDay(); // 0=أحد..6=سبت (يطابق التخزين)

// ينشر رحلة فعلية من قالب متكرّر بتاريخ مُعطى ويُحدّث last_run_date — يُستخدم من المهمّة اليومية
// ومن نقطة الإنشاء (لنشر رحلة اليوم فورًا إن كان يومها ضمن الأيام المختارة)
async function publishFromTemplate(rt, dateStr) {
  const tripId = await insertReturningId('trips',
    ['driver_id', 'from_label', 'to_label', 'from_lat', 'from_lng', 'to_lat', 'to_lng', 'date', 'time', 'price_per_seat', 'total_seats', 'gender_pref', 'kind', 'status', 'created_at'],
    [rt.driver_id, rt.from_label, rt.to_label, rt.from_lat, rt.from_lng, rt.to_lat, rt.to_lng, dateStr, rt.time, rt.price_per_seat, rt.total_seats, rt.gender_pref || 'any', rt.kind || 'city', 'scheduled', now()]);
  await db.execute('UPDATE recurring_trips SET last_run_date=? WHERE id=?', [dateStr, rt.id]);
  const trip = await db.queryOne('SELECT * FROM trips WHERE id=?', [tripId]);
  if (trip) await notifyRouteAlerts(trip);
}

async function runRecurringPublish() {
  try {
    const today = todayStr();
    const d = dow();
    const rows = await db.query(
      "SELECT * FROM recurring_trips WHERE active=1 AND (last_run_date IS NULL OR last_run_date<>?)",
      [today]);
    let published = 0;
    for (const rt of rows) {
      const days = String(rt.days || '').split(',').map(s => s.trim()).filter(Boolean).map(Number);
      if (!days.includes(d)) continue;
      // السائق يجب أن يبقى نشطًا وموثّقًا لنشر رحلة نيابةً عنه
      const drv = await db.queryOne("SELECT status, verified, role FROM users WHERE id=?", [rt.driver_id]);
      if (!drv || drv.status !== 'active' || !drv.verified || drv.role !== 'driver') { continue; }
      await publishFromTemplate(rt, today);
      published++;
    }
    if (published) console.log(`🔁 رحلات متكرّرة نُشرت تلقائيًا: ${published}`);
  } catch (e) {
    console.error('runRecurringPublish error:', (e && e.message) || e);
  }
}

// يبدأ الفحص بعد نصف دقيقة من الإقلاع (يلتقط أي يوم فات أثناء توقّف الخادم) ثم كل ساعة
// (كل ساعة وليس كل 24 ساعة: يضمن نشر الرحلة أول اليوم حتى لو أُعيد تشغيل الخادم متأخرًا)
function startRecurringJob() {
  setTimeout(runRecurringPublish, 30 * 1000);
  setInterval(runRecurringPublish, 60 * 60 * 1000);
}

module.exports = { runRecurringPublish, startRecurringJob, publishFromTemplate, todayStr, dow };
