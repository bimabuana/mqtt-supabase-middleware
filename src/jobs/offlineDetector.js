const supabase = require('../supabase/client');
const { sendNotification } = require('../utils/notification');

// Jalankan pengecekan setiap 5 menit
const CHECK_INTERVAL_MS = 5 * 60 * 1000;

let intervalId = null;

function startOfflineDetector() {
    if (intervalId) return; // Menghindari multiple intervals
    intervalId = setInterval(async () => {
        try {
            // console.log('[OfflineDetector] Mengecek perangkat offline...');

            // Waktu 5 menit yang lalu (di Supabase pakai UTC)
            const fiveMinsAgo = new Date(Date.now() - CHECK_INTERVAL_MS).toISOString();

            // Cari perangkat yang is_online = true TAPI last_seen < 5 menit yang lalu
            const { data: devices, error } = await supabase
                .from('devices')
                .select('device_id, claimed_by, last_seen')
                .eq('is_online', true)
                .lt('last_seen', fiveMinsAgo);

            if (error) throw error;

            for (const device of devices) {
                console.log(`[OfflineDetector] Perangkat ${device.device_id} terdeteksi OFFLINE!`);

                // 1. Update status di DB jadi offline
                await supabase
                    .from('devices')
                    .update({ is_online: false })
                    .eq('device_id', device.device_id);

                // 2. Kirim Notifikasi OneSignal
                // Cooldown 1 jam (3600 detik) di-handle otomatis oleh sendNotification
                if (device.claimed_by) {
                    sendNotification(
                        device.claimed_by,
                        'Perangkat Offline! 🚨',
                        `Perangkat IoT Kumbung (${device.device_id}) terputus dari jaringan atau mati listrik.`,
                        3600
                    );
                }
            }
        } catch (error) {
            console.error('[OfflineDetector] Error:', error.message);
        }
    }, CHECK_INTERVAL_MS);

    console.log('[OfflineDetector] Aktif. Pengecekan perangkat offline berjalan setiap 5 menit.');
}

function stopOfflineDetector() {
    if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
        console.log('[OfflineDetector] Dinonaktifkan.');
    }
}

module.exports = { startOfflineDetector, stopOfflineDetector };
