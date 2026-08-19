/**
 * =============================================================================
 * IRRIGATION SCHEDULER — Pengganti BullMQ + Redis
 * =============================================================================
 * File ini menggabungkan tugas yang dulu dipecah ke 3 file terpisah
 * (irrigationQueue.js, irrigationWorker.js, scheduleRestore.js) yang semuanya
 * butuh Redis. Sekarang semua jadwal disimpan LANGSUNG DI MEMORI aplikasi
 * (pakai library node-cron), tanpa perlu koneksi ke server Redis eksternal.
 *
 * Kenapa ini aman untuk kebutuhan kontrol pompa air:
 * - Jadwal cron & siram manual cuma butuh "jalan tepat waktu", tidak butuh
 *   antrian yang rumit atau retry berlapis seperti BullMQ.
 * - Kalau server restart, jadwal otomatis didaftarkan ulang dari Supabase
 *   (lihat restoreSchedules di bawah) — sama seperti sebelumnya.
 *
 * Trade-off yang perlu diketahui:
 * - Kalau server RESTART TEPAT PADA DETIK jadwal seharusnya jalan, siraman
 *   itu bisa terlewat sekali (beda dengan BullMQ yang menyimpan job di Redis
 *   sehingga survive restart). Untuk kontrol pompa kumbung jamur, risiko ini
 *   biasanya bisa diterima.
 * =============================================================================
 */

const cron = require('node-cron')
const supabase = require('../supabase/client')
const { publishRelay } = require('../mqtt/mqttClient')
const { sendNotification } = require('../utils/notification')

// Menyimpan task cron yang sedang aktif, key = schedule.id (UUID dari Supabase)
const activeTasks = new Map()

/**
 * Eksekusi siram: nyalakan relay, tunggu durasi, matikan relay.
 * Dipakai baik oleh jadwal cron maupun trigger manual ("siram sekarang").
 *
 * @param {string} deviceId
 * @param {number} durationSeconds
 * @param {string} source - 'Jadwal otomatis' atau 'Siram manual', untuk log & notifikasi
 */
async function executeIrrigation(deviceId, durationSeconds, source = 'Siram manual') {
    const nowWIB = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().replace('T', ' ').substring(0, 19)

    console.log(`[Scheduler] ============================================================`)
    console.log(`[Scheduler] SIRAM DIMULAI`)
    console.log(`[Scheduler] Device  : ${deviceId}`)
    console.log(`[Scheduler] Durasi  : ${durationSeconds} detik`)
    console.log(`[Scheduler] Waktu   : ${nowWIB} WIB`)
    console.log(`[Scheduler] Sumber  : ${source}`)
    console.log(`[Scheduler] ============================================================`)

    // Langkah 1: Nyalakan pompa
    publishRelay(deviceId, 'ON')
    console.log(`[Scheduler] >> Relay ON dikirim ke ${deviceId}`)

    // Kirim notifikasi (tidak menunggu/blocking, tidak menggagalkan proses jika error)
    supabase
        .from('devices')
        .select('claimed_by')
        .eq('device_id', deviceId)
        .single()
        .then(({ data: device }) => {
            if (device && device.claimed_by) {
                sendNotification(
                    device.claimed_by,
                    'Penyiraman Dimulai 💦',
                    `Pompa menyala selama ${durationSeconds} detik via ${source}.`
                )
            }
        })
        .catch((e) => console.error('[Scheduler] Gagal mengirim notifikasi:', e.message))

    // Langkah 2: Tunggu durasi (tidak memblokir request lain karena berbasis async/timer)
    await new Promise(resolve => setTimeout(resolve, durationSeconds * 1000))

    // Langkah 3: Matikan pompa
    publishRelay(deviceId, 'OFF')
    console.log(`[Scheduler] >> Relay OFF dikirim ke ${deviceId}`)
    console.log(`[Scheduler] SIRAM SELESAI — ${deviceId} | durasi: ${durationSeconds}s`)
}

/**
 * Daftarkan jadwal berulang (cron) ke memori aplikasi.
 * Kalau scheduleId sudah pernah didaftarkan sebelumnya, task lama dihentikan
 * dulu supaya tidak dobel jalan.
 *
 * @param {string} scheduleId - UUID jadwal dari tabel schedules di Supabase
 * @param {string} deviceId
 * @param {string} cronPattern - format "menit jam hari bulan hari-minggu"
 * @param {number} durationSeconds
 */
function registerSchedule(scheduleId, deviceId, cronPattern, durationSeconds) {
    // Hentikan task lama dengan id yang sama jika ada, biar tidak dobel
    unregisterSchedule(scheduleId)

    if (!cron.validate(cronPattern)) {
        console.error(`[Scheduler] Pola cron tidak valid untuk jadwal ${scheduleId}: "${cronPattern}"`)
        return false
    }

    const task = cron.schedule(cronPattern, () => {
        executeIrrigation(deviceId, durationSeconds, `Jadwal otomatis cron: ${cronPattern}`)
            .catch(err => console.error(`[Scheduler] Gagal menjalankan jadwal ${scheduleId}:`, err.message))
    })

    activeTasks.set(scheduleId, task)
    console.log(`[Scheduler] ✓ Jadwal ${scheduleId} (${cronPattern}) terdaftar untuk ${deviceId}`)
    return true
}

/**
 * Hentikan & hapus jadwal dari memori (dipakai saat delete atau toggle non-aktif).
 * @param {string} scheduleId
 */
function unregisterSchedule(scheduleId) {
    const task = activeTasks.get(scheduleId)
    if (task) {
        task.stop()
        activeTasks.delete(scheduleId)
        console.log(`[Scheduler] Jadwal ${scheduleId} dihentikan & dihapus dari memori`)
    }
}

/**
 * Jalankan siram sekali langsung (dipakai untuk endpoint "siram sekarang").
 * Tidak disimpan sebagai jadwal berulang.
 */
function runIrrigationNow(deviceId, durationSeconds) {
    // Sengaja tidak di-await di pemanggil (route) supaya request langsung dijawab
    // "sedang berjalan" tanpa menunggu pompa selesai menyala.
    return executeIrrigation(deviceId, durationSeconds, 'Siram manual')
}

/**
 * Baca semua jadwal aktif dari Supabase dan daftarkan ke memori.
 * Dipanggil sekali saat server startup untuk memulihkan jadwal setelah restart.
 */
async function restoreSchedules() {
    console.log('[Scheduler] Memulai pemulihan jadwal dari database...')

    // Bersihkan dulu semua task yang mungkin tersisa di memori (mis. saat hot-reload)
    for (const scheduleId of activeTasks.keys()) {
        unregisterSchedule(scheduleId)
    }

    try {
        const { data: schedules, error } = await supabase
            .from('schedules')
            .select('*')
            .eq('is_active', true)

        if (error) {
            console.error('[Scheduler] Gagal mengambil jadwal dari DB:', error.message)
            return
        }

        if (!schedules || schedules.length === 0) {
            console.log('[Scheduler] Tidak ada jadwal aktif untuk di-restore.')
            return
        }

        console.log(`[Scheduler] Mendaftarkan ulang ${schedules.length} jadwal aktif...`)
        for (const schedule of schedules) {
            registerSchedule(schedule.id, schedule.device_id, schedule.cron, schedule.duration_s)
        }
        console.log('[Scheduler] Pemulihan jadwal selesai.')
    } catch (err) {
        console.error('[Scheduler] Error tidak terduga saat restore jadwal:', err.message)
    }
}

module.exports = {
    registerSchedule,
    unregisterSchedule,
    runIrrigationNow,
    restoreSchedules,
}
