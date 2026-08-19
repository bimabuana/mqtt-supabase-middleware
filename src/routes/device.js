/**
 * =============================================================================
 * ROUTE: DEVICE — Klaim dan Manajemen Perangkat
 * =============================================================================
 * File ini mengurus proses "pairing" antara akun user dan perangkat ESP32 fisik.
 *
 * Kenapa perlu proses klaim?
 * Setiap ESP32 punya kode unik (claim_code) yang tercetak atau tertempel di box-nya.
 * Saat user pertama kali daftar, mereka harus memasukkan kode ini untuk
 * "mengklaim" perangkat tersebut sebagai milik mereka.
 * Setelah diklaim, semua data dan perintah akan dikaitkan dengan device itu.
 *
 * Endpoint yang tersedia:
 * - POST /api/device/claim      → Klaim perangkat dengan kode unik
 * - GET  /api/device/my-device/:userId → Ambil info perangkat milik user
 * =============================================================================
 */

const router = require('express').Router()
const supabase = require('../supabase/client')

/**
 * POST /api/device/claim
 * -----------------------------------------------------------------------------
 * Menghubungkan perangkat ESP32 ke akun user berdasarkan kode klaim.
 *
 * Ada 4 pengecekan yang dilakukan secara berurutan:
 * 1. Validasi input — pastikan claim_code dan user_id dikirim
 * 2. Cari device — apakah kode ini terdaftar di database?
 * 3. Cek kepemilikan — sudah diklaim orang lain atau belum?
 * 4. Cek limit user — satu user hanya boleh punya satu device
 *
 * Body: { claim_code: string, user_id: string }
 */
router.post('/claim', async (req, res) => {
    const { claim_code, user_id } = req.body

    // Pengecekan 1: Pastikan kedua field dikirim oleh client
    if (!claim_code || !user_id) {
        return res.status(400).json({ error: 'claim_code dan user_id wajib diisi' })
    }

    // Pengecekan 2: Cari device dengan kode ini di database
    // claim_code selalu diubah ke huruf kapital agar tidak case-sensitive
    const { data: device, error } = await supabase
        .from('devices')
        .select('id, device_id, claimed_by')
        .eq('claim_code', claim_code.toUpperCase())
        .single()

    if (error || !device) {
        return res.status(404).json({ error: 'Kode tidak ditemukan' })
    }

    // Pengecekan 3: Apakah device ini sudah diklaim oleh orang LAIN?
    // Kalau yang mengklaim adalah user yang sama (misalnya retry), tetap diizinkan
    if (device.claimed_by && device.claimed_by !== user_id) {
        return res.status(409).json({ error: 'Device sudah diklaim oleh pengguna lain' })
    }

    // Pengecekan 4: Apakah user ini sudah punya device lain sebelumnya?
    // Satu akun hanya boleh mengklaim satu perangkat
    const { data: existing } = await supabase
        .from('devices')
        .select('device_id')
        .eq('claimed_by', user_id)
        .single()

    if (existing) {
        return res.status(409).json({ error: 'Anda sudah memiliki device terdaftar' })
    }

    // Semua pengecekan lolos → Update database: tandai device sebagai milik user ini
    const { data: updated } = await supabase
        .from('devices')
        .update({ claimed_by: user_id, claimed_at: new Date() })
        .eq('claim_code', claim_code.toUpperCase())
        .select('device_id, label, location')
        .single()

    // 5. Buat data threshold default otomatis untuk device ini
    //    Mencegah error 500 saat user pertama kali mengatur batas sensor
    if (updated?.device_id) {
        const { error: thresholdErr } = await supabase
            .from('thresholds')
            .insert({
                device_id: updated.device_id,
                temp_max: 30,
                hum_max: 80,
            })
        if (thresholdErr) {
            console.warn('[Claim] Gagal membuat threshold default:', thresholdErr.message)
        } else {
            console.log(`[Claim] Threshold default dibuat untuk device: ${updated.device_id}`)
        }
    }

    // Kembalikan info device yang berhasil diklaim ke client (Flutter)
    res.json({ message: 'Device berhasil diklaim', device: updated })
})

/**
 * GET /api/device/my-device/:userId
 * -----------------------------------------------------------------------------
 * Mengambil informasi perangkat yang dimiliki oleh user tertentu.
 * Biasanya dipanggil saat user login untuk mengetahui device_id mereka,
 * lalu device_id itu digunakan di semua request API selanjutnya.
 *
 * Params: userId — UUID user dari Supabase Auth
 */
router.get('/my-device/:userId', async (req, res) => {
    console.log(`[Device Route] Handler berjalan untuk user: ${req.params.userId}`)
    const { data, error } = await supabase
        .from('devices')
        .select('device_id, label, location, is_online, last_seen')
        .eq('claimed_by', req.params.userId)
        .single()

    if (error) {
        console.error('[Device Router] Gagal ambil my-device:', error.message)
        return res.status(404).json({ error: 'Device tidak ditemukan' })
    }
    res.json(data)
})

/**
 * GET /api/device/status/:deviceId
 * -----------------------------------------------------------------------------
 * Mengambil status keaktifan perangkat (is_online, last_seen) secara real-time.
 * Params: deviceId — ID perangkat ESP32
 */
router.get('/status/:deviceId', async (req, res) => {
    const { data, error } = await supabase
        .from('devices')
        .select('is_online, last_seen')
        .eq('device_id', req.params.deviceId)
        .maybeSingle()

    if (error || !data) {
        console.error('[Device Router] Gagal ambil status:', error ? error.message : 'Not found')
        return res.status(404).json({ error: 'Device tidak ditemukan' })
    }
    res.json(data)
})

module.exports = router