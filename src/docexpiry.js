// ============================================================
// تنبيه السائقين قبل انتهاء وثائقهم (رخصة/استمارة/تأمين).
// يفحص يوميًا: إن كانت أي وثيقة تنتهي خلال 30 يومًا أو انتهت،
// يُرسل تنبيهًا واحدًا في اليوم (داخلي + Push) ويسجّل تاريخ التنبيه.
// ============================================================
const { db, addNotif } = require('./db');

const todayStr = () => new Date().toISOString().slice(0, 10); // YYYY-MM-DD

// أيام متبقّية حتى التاريخ (سالبة = منتهية)
function daysUntil(ymd) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(ymd || ''))) return null;
  const [y, m, d] = ymd.split('-').map(Number);
  const target = Date.UTC(y, m - 1, d);
  const t = new Date();
  const today = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
  return Math.round((target - today) / 86400000);
}

const WARN_DAYS = 30;
const LABEL = { license: 'رخصة القيادة', vehicleReg: 'استمارة المركبة', insurance: 'تأمين المركبة' };

async function checkDocExpiry() {
  try {
    const rows = await db.query(
      `SELECT id, license_expiry, vehicle_reg_expiry, insurance_expiry, doc_expiry_notified
       FROM users WHERE role='driver'
         AND (COALESCE(license_expiry,'')<>'' OR COALESCE(vehicle_reg_expiry,'')<>'' OR COALESCE(insurance_expiry,'')<>'')`, []);
    const today = todayStr();
    let sent = 0;
    for (const u of rows) {
      if (u.doc_expiry_notified === today) continue; // نُبّه اليوم بالفعل
      const items = [
        ['license', u.license_expiry],
        ['vehicleReg', u.vehicle_reg_expiry],
        ['insurance', u.insurance_expiry],
      ].map(([k, v]) => ({ k, v, d: daysUntil(v) })).filter(x => x.d != null && x.d <= WARN_DAYS);
      if (!items.length) continue;
      items.sort((a, b) => a.d - b.d);
      const worst = items[0];
      const expired = worst.d < 0;
      const title = expired ? '⚠️ انتهت صلاحية وثيقة' : '🔔 وثيقة على وشك الانتهاء';
      const body = expired
        ? `${LABEL[worst.k]} منتهية — جدّدها لتفادي إيقاف حسابك.`
        : `${LABEL[worst.k]} تنتهي خلال ${worst.d} يومًا — جدّدها في الوقت المناسب.`;
      await addNotif(u.id, 'car', expired ? 'red' : 'amber', title, body, '/(driver)/ddocs');
      await db.execute('UPDATE users SET doc_expiry_notified=? WHERE id=?', [today, u.id]);
      sent++;
    }
    if (sent) console.log(`📄 تنبيهات انتهاء الوثائق: ${sent}`);
  } catch (e) {
    console.error('checkDocExpiry error:', (e && e.message) || e);
  }
}

// يبدأ الفحص بعد دقيقة من الإقلاع ثم كل 24 ساعة
function startDocExpiryJob() {
  setTimeout(checkDocExpiry, 60 * 1000);
  setInterval(checkDocExpiry, 24 * 60 * 60 * 1000);
}

module.exports = { checkDocExpiry, startDocExpiryJob, daysUntil };
