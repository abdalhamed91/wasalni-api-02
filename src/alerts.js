// ============================================================
// قائمة انتظار المسارات: راكب لم يجد رحلة لوجهته يطلب تنبيهًا،
// وحين ينشر أي سائق رحلة قريبة من تلك الوجهة (≤8كم) يُشعَر تلقائيًا مرّة واحدة.
// ============================================================
const { db, addNotif } = require('./db');

function haversineKm(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a[0] == null || b[0] == null) return Infinity;
  const R = 6371, toR = (d) => (d * Math.PI) / 180;
  const dLat = toR(b[0] - a[0]), dLng = toR(b[1] - a[1]);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a[0])) * Math.cos(toR(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

const MATCH_KM = 8;

// يُستدعى بعد نشر أي رحلة (فورية أو متكرّرة) — يُشعر الركّاب المنتظرين وجهةً قريبة ثم يحذف تنبيههم
async function notifyRouteAlerts(trip) {
  try {
    if (trip.to_lat == null || trip.to_lng == null) return;
    const alerts = await db.query('SELECT * FROM route_alerts', []);
    for (const a of alerts) {
      if (haversineKm([a.to_lat, a.to_lng], [trip.to_lat, trip.to_lng]) > MATCH_KM) continue;
      await addNotif(a.passenger_id, 'bell', 'green', 'رحلة جديدة على مسارك! 🎉',
        `${trip.from_label || ''} ← ${trip.to_label || ''} — بانتظارك`,
        `/(passenger)/results?to=${encodeURIComponent(trip.to_label || '')}&toLat=${trip.to_lat}&toLng=${trip.to_lng}`);
      await db.execute('DELETE FROM route_alerts WHERE id=?', [a.id]);
    }
  } catch (e) { console.error('notifyRouteAlerts error:', (e && e.message) || e); }
}

module.exports = { notifyRouteAlerts };
