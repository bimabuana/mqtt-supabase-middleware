// Anti-spam cooldown disimpan di memori aplikasi (tidak pakai Redis lagi).
// Catatan: kalau server restart, cooldown ke-reset — dampaknya minimal,
// paling buruk user dapat 1 notifikasi "dobel" pas restart.
const inMemoryCooldown = new Map();

/**
 * Kirim push notification via OneSignal dengan perlindungan anti-spam bawaan.
 * Setiap kombinasi (userId + title) diberi cooldown agar tidak bisa dikirim
 * berulang kali dalam jangka waktu tertentu.
 *
 * @param {string} userId       - ID user penerima (external_id OneSignal)
 * @param {string} title        - Judul notifikasi (juga dipakai sebagai kunci cooldown)
 * @param {string} message      - Isi pesan notifikasi
 * @param {number} [cooldownSec=300] - Cooldown dalam detik (default: 5 menit)
 */
const sendNotification = async (userId, title, message, cooldownSec = 300) => {
  const appId = process.env.ONESIGNAL_APP_ID;
  const restApiKey = process.env.ONESIGNAL_REST_API_KEY;

  if (!appId || !restApiKey) {
    console.warn('[Notif] OneSignal credentials missing. Skipping.');
    return;
  }

  // Ensure targetIds is a flat array of unique strings
  const targetIds = Array.isArray(userId) ? [...new Set(userId.flat())] : [userId];
  
  if (targetIds.length === 0) return;

  // ── Anti-Spam Guard ──────────────────────────────────────────────────────
  // Buat kunci unik berdasarkan siapa penerima dan judul notifikasinya.
  // Ini mencegah notif "Penyiraman Dimulai" atau "Perangkat Offline"
  // dikirim berkali-kali dalam waktu singkat.
  const cooldownKey = `notif_cd:${targetIds.join(',')}:${title.replace(/\s+/g, '_').toLowerCase()}`;

  const expiresAt = inMemoryCooldown.get(cooldownKey);
  if (expiresAt && Date.now() < expiresAt) {
    console.log(`[Notif] Cooldown aktif, skip: "${title}" → ${targetIds}`);
    return;
  }
  inMemoryCooldown.set(cooldownKey, Date.now() + cooldownSec * 1000);
  // ────────────────────────────────────────────────────────────────────────

  const payload = {
    app_id: appId,
    include_aliases: {
      external_id: targetIds
    },
    target_channel: 'push',
    headings: { en: title },
    contents: { en: message },
    // -- Konfigurasi Grouping & Stacking (Agar rapi seperti WhatsApp) --
    android_group: 'jamur_monitoring_group', // Mengelompokkan notifikasi di Android
    thread_id: 'jamur_monitoring_group',     // Mengelompokkan notifikasi di iOS
    // Menimpa (replace) notifikasi lama yang jenisnya sama, agar tidak spam
    collapse_id: title.replace(/\s+/g, '_').toLowerCase()
  };

  try {
    const response = await fetch('https://onesignal.com/api/v1/notifications', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Authorization': `Basic ${restApiKey}`
      },
      body: JSON.stringify(payload)
    });

    const result = await response.json();
    if (result.errors) {
      // Jika error karena user belum login (invalid_aliases), jangan tampilkan error panjang
      if (result.errors.invalid_aliases) {
        console.warn(`[Notif] User belum register OneSignal (invalid_aliases):`, targetIds);
      } else {
        console.error('[Notif] OneSignal error:', result.errors);
      }
    } else {
      console.log(`[Notif] Terkirim ke ${targetIds}: "${title}"`);
    }
  } catch (error) {
    console.error('[Notif] Gagal kirim via OneSignal:', error.message);
  }
};

module.exports = {
  sendNotification
};
