/**
 * =============================================================================
 * ROUTE: MODE — Kontrol Mode Operasi ESP32
 * =============================================================================
 * File ini mengurus pergantian mode operasi perangkat ESP32 secara remote.
 *
 * ESP32 mendukung 2 mode:
 * - auto    : Pompa menyala/mati otomatis berdasarkan pembacaan sensor SHT31
 * - manual  : Pompa dikendalikan sepenuhnya oleh perintah dari aplikasi
 *
 * Cara Kerja:
 * 1. Aplikasi Flutter memanggil POST /api/mode/:deviceId
 * 2. Backend memvalidasi nilai mode
 * 3. Backend mengirim perintah ke ESP32 via MQTT (cmd/mode/<deviceId>)
 * 4. Backend menyimpan mode baru ke kolom current_mode di tabel devices
 * 5. Backend mengirim notifikasi ke user bahwa mode telah berubah
 *
 * Endpoint yang tersedia:
 * - GET  /api/mode/:deviceId → Baca mode aktif saat ini dari database
 * - POST /api/mode/:deviceId → Ubah mode operasi ESP32
 * =============================================================================
 */

const router = require('express').Router()
const supabase = require('../supabase/client')
const { publishMode } = require('../mqtt/mqttClient')
const { sendNotification } = require('../utils/notification')

// Daftar nilai mode yang diizinkan (whitelist)
const VALID_MODES = ['auto', 'manual']

// Label ramah untuk notifikasi
const MODE_LABELS = {
    auto:    'AUTO 🤖 — Pompa dikendalikan sensor secara otomatis',
    manual:  'MANUAL 🖐️ — Pompa dikendalikan langsung dari aplikasi',
}

/**
 * GET /api/mode/:deviceId
 * -----------------------------------------------------------------------------
 * Membaca mode operasi aktif dari database untuk sebuah device.
 * Biasanya dipanggil saat aplikasi Flutter dibuka untuk menampilkan
 * status mode yang sedang berjalan.
 *
 * Params: deviceId — ID perangkat, contoh: "esp32-new-05"
 */
router.get('/:deviceId', async (req, res) => {
    const { data, error } = await supabase
        .from('devices')
        .select('device_id, current_mode, is_online, last_seen')
        .eq('device_id', req.params.deviceId)
        .single()

    if (error || !data) {
        return res.status(404).json({ error: 'Device tidak ditemukan' })
    }

    res.json({
        device_id:    data.device_id,
        current_mode: data.current_mode ?? 'auto', // Fallback ke 'auto' jika kolom masih null
        is_online:    data.is_online,
        last_seen:    data.last_seen,
    })
})

/**
 * POST /api/mode/:deviceId
 * -----------------------------------------------------------------------------
 * Mengubah mode operasi ESP32 dan menyimpan perubahan ke database.
 *
 * Alur eksekusi:
 * 1. Validasi nilai mode (hanya "auto", "manual" yang diterima)
 * 2. Cek apakah device terdaftar dan dimiliki oleh seseorang
 * 3. Kirim perintah mode baru ke ESP32 via MQTT
 * 4. Update kolom current_mode di tabel devices di Supabase
 * 5. Kirim notifikasi OneSignal ke pemilik device
 *
 * Params: deviceId — ID perangkat
 * Body:   { mode: "auto" | "manual" }
 */
router.post('/:deviceId', async (req, res) => {
    const { deviceId } = req.params
    const { mode } = req.body

    // Validasi 1: Field mode wajib dikirim
    if (!mode) {
        return res.status(400).json({ error: 'Field "mode" wajib diisi' })
    }

    // Validasi 2: Nilai mode harus salah satu dari whitelist
    if (!VALID_MODES.includes(mode)) {
        return res.status(400).json({
            error: `Mode tidak valid. Nilai yang diizinkan: ${VALID_MODES.join(', ')}`,
        })
    }

    // Ambil info device (dibutuhkan untuk validasi keberadaan + kirim notifikasi)
    const { data: device, error: deviceErr } = await supabase
        .from('devices')
        .select('device_id, claimed_by, current_mode')
        .eq('device_id', deviceId)
        .single()

    if (deviceErr || !device) {
        return res.status(404).json({ error: 'Device tidak ditemukan' })
    }

    // Kirim perintah ganti mode ke ESP32 via MQTT
    // Selalu kirim, karena ESP32 mungkin sebelumnya sedang "cooldown" dan mengabaikan perintah
    publishMode(deviceId, mode)

    // Simpan mode baru ke database hanya jika berbeda
    if (device.current_mode !== mode) {
        const { error: updateErr } = await supabase
            .from('devices')
            .update({ current_mode: mode })
            .eq('device_id', deviceId)

        if (updateErr) {
            return res.status(500).json({ error: 'Gagal menyimpan mode ke database' })
        }
    }

    // Kirim notifikasi ke pemilik device hanya jika mode benar-benar berubah
    if (device.claimed_by && device.current_mode !== mode) {
        try {
            sendNotification(
                device.claimed_by,
                'Mode Kumbung Berubah 🔄',
                `Mode diubah ke ${MODE_LABELS[mode]}`
            )
        } catch (notifErr) {
            // Jangan sampai gagal notifikasi membatalkan seluruh respons
            console.error('[Mode] Gagal kirim notifikasi:', notifErr.message)
        }
    }

    console.log(`[Mode] ${deviceId} → ${device.current_mode} → ${mode} (Forced MQTT Publish)`)

    res.json({
        message: device.current_mode === mode
            ? `Perintah mode ${mode} dikirim ulang ke perangkat`
            : `Mode berhasil diubah ke ${mode}`,
        mode,
        changed: device.current_mode !== mode,
    })
})

module.exports = router
