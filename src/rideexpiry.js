// ============================================================
// انتهاء صلاحية طلبات «اطلب توصيلة» العالقة: طلب فوري («الآن») بلا اتفاق خلال 30 دقيقة،
// أو طلب مجدول (وقت محدّد) خلال 12 ساعة، يُلغى تلقائيًا ويُشعَر صاحبه (والسائق إن كان يفاوض).
// قبلها كانت الطلبات القديمة تبقى «مفتوحة» أبد الدهر وتظهر للسائقين وتُلغي طلبات الراكب الجديدة.
// ============================================================
const { db, now, addNotif } = require('./db');

const NOW_TTL_MS = (Number(process.env.RIDE_REQUEST_TTL_MIN) || 30) * 60 * 1000;
const SCHEDULED_TTL_MS = 12 * 60 * 60 * 1000;

async function expireStaleRideRequests(nowMs = now()) {
  let expired = 0;
  try {
    const rows = await db.query("SELECT * FROM ride_requests WHERE status IN ('open','offered','countered')", []);
    for (const rr of rows) {
      const immediate = !rr.ride_time || rr.ride_time === 'الآن';
      const ttl = immediate ? NOW_TTL_MS : SCHEDULED_TTL_MS;
      if (nowMs - Number(rr.created_at) < ttl) continue;
      // انتقال ذرّي: لا يُلغى طلب اتُّفق عليه للتوّ
      const upd = await db.execute("UPDATE ride_requests SET status='cancelled' WHERE id=? AND status IN ('open','offered','countered')", [rr.id]);
      if (!upd.rowCount) continue;
      expired++;
      await addNotif(rr.passenger_id, 'clock', 'amber', 'انتهت مهلة طلب توصيلتك',
        `${rr.from_label} ← ${rr.to_label} — لم يتم الاتفاق مع سائق، يمكنك إرسال طلب جديد`, '/(passenger)/myrequests');
      if (rr.driver_id) await addNotif(rr.driver_id, 'clock', 'amber', 'انتهى طلب التوصيلة', `${rr.from_label} ← ${rr.to_label}`, '/(driver)/driderequests');
    }
    if (expired) console.log(`⏱️ طلبات توصيلة منتهية: ${expired}`);
  } catch (e) {
    console.error('expireStaleRideRequests error:', (e && e.message) || e);
  }
  return expired;
}

// كل 5 دقائق
function startRideExpiryJob() {
  const t = setInterval(expireStaleRideRequests, 5 * 60 * 1000);
  if (t.unref) t.unref();
}

module.exports = { expireStaleRideRequests, startRideExpiryJob };
