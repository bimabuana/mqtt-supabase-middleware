/**
 * =============================================================================
 * ROUTE: SCHEDULE — Jadwal & Kontrol Penyiraman
 * =============================================================================
 * File ini adalah "pusat kontrol" untuk semua hal yang berhubungan dengan
 * penyiraman: jadwal terjadwal, trigger manual, hingga menghentikan pompa.
 *
 * Catatan arsitektur (setelah migrasi dari BullMQ+Redis):
 * Jadwal disimpan di DUA tempat:
 * 1. Database Supabase → data permanen (label, cron, durasi, dll), survive restart
 * 2. Memori aplikasi (node-cron) → yang benar-benar menjalankan jadwal secara real-time
 *
 * Karena node-cron hidup di memori, setiap kali server start ulang, jadwal
 * yang is_active=true di Supabase didaftarkan ulang otomatis lewat
 * scheduler.restoreSchedules() (dipanggil di index.js).
 *
 * Endpoint yang tersedia:
 * - GET    /api/schedule/:deviceId          → Daftar semua jadwal
 * - POST   /api/schedule/:deviceId          → Buat jadwal baru
 * - DELETE /api/schedule/:id                → Hapus jadwal
 * - POST   /api/schedule/:deviceId/now      → Siram sekarang (sekali jalan)
 * - POST   /api/schedule/:deviceId/stop     → Hentikan pompa sekarang
 * - PATCH  /api/schedule/:id/toggle         → Aktifkan atau nonaktifkan jadwal
 * =============================================================================
 */

const cron = require('node-cron')
const router = require('express').Router()
const supabase = require('../supabase/client')
const { publishRelay } = require('../mqtt/mqttClient')
const scheduler = require('../scheduler/irrigationScheduler')

/**
 * GET /api/schedule/:deviceId
 * -----------------------------------------------------------------------------
 * Mengambil semua jadwal penyiraman yang dimiliki oleh sebuah device.
 */
router.get('/:deviceId', async (req, res) => {
    const { data, error } = await supabase
        .from('schedules')
        .select('*')
        .eq('device_id', req.params.deviceId)
        .order('created_at')

    if (error) return res.status(500).json({ error: error.message })
    res.json(data)
})

/**
 * POST /api/schedule/:deviceId
 * -----------------------------------------------------------------------------
 * Membuat jadwal penyiraman baru yang akan berulang sesuai pola cron.
 *
 * Yang terjadi saat endpoint ini dipanggil:
 * 1. Validasi input (cron dan duration_s wajib ada)
 * 2. Simpan data jadwal ke Supabase
 * 3. Daftarkan jadwal ke scheduler in-memory (node-cron) agar langsung aktif
 *
 * Format Cron: "menit jam hari bulan hari-minggu"
 * Contoh:
 * - "0 6 * * *"     → Setiap hari jam 06:00
 * - "30 17 * * *"   → Setiap hari jam 17:30
 * - "0 6,17 * * *"  → Setiap hari jam 06:00 dan 17:00
 *
 * Params: deviceId — ID perangkat
 * Body:   { label: string, cron: string, duration_s: number }
 */
router.post('/:deviceId', async (req, res) => {
    const { label, cron: cronPattern, duration_s } = req.body
    const deviceId = req.params.deviceId

    // Validasi: cron pattern dan durasi penyiraman wajib dikirim
    if (!cronPattern || !duration_s) {
        return res.status(400).json({ error: 'cron dan duration_s wajib diisi' })
    }

    // Validasi format cron (minimal harus ada 5 bagian yang dipisahkan spasi)
    if (cronPattern.split(' ').length !== 5) {
        return res.status(400).json({ error: 'Format cron tidak valid' })
    }

    // Validasi cron benar-benar bisa di-parse
    if (!cron.validate(cronPattern)) {
        return res.status(400).json({ error: 'Pola cron tidak valid' })
    }

    // Langkah 1: Simpan jadwal ke database dulu (biar dapat UUID dari Supabase)
    const { data, error } = await supabase
        .from('schedules')
        .insert({ device_id: deviceId, label, cron: cronPattern, duration_s, is_active: true })
        .select()
        .single()

    if (error) return res.status(500).json({ error: error.message })

    // Langkah 2: Daftarkan ke scheduler in-memory pakai UUID dari Supabase sebagai key
    scheduler.registerSchedule(data.id, deviceId, cronPattern, duration_s)

    res.status(201).json(data)
})

/**
 * DELETE /api/schedule/:id
 * -----------------------------------------------------------------------------
 * Menghapus jadwal secara permanen dari database DAN dari scheduler in-memory.
 *
 * Params: id — UUID jadwal dari tabel schedules di Supabase
 */
router.delete('/:id', async (req, res) => {
    // Hentikan task di memori (aman dipanggil walau task-nya tidak ada/sudah nonaktif)
    scheduler.unregisterSchedule(req.params.id)

    // Hapus record dari database Supabase
    const { error } = await supabase.from('schedules').delete().eq('id', req.params.id)
    if (error) return res.status(500).json({ error: error.message })

    res.json({ message: 'Jadwal dihapus' })
})

/**
 * POST /api/schedule/:deviceId/now
 * -----------------------------------------------------------------------------
 * Memicu penyiraman SEKARANG JUGA tanpa membuat jadwal permanen.
 * Cocok untuk penyiraman darurat atau percobaan manual.
 *
 * Endpoint ini dilindungi rate limiter ketat (5x/menit) yang didefinisikan
 * di index.js untuk mencegah penyiraman berlebihan.
 *
 * Params: deviceId — ID perangkat
 * Body:   { duration_s: number } — opsional, default 30 detik
 */
router.post('/:deviceId/now', async (req, res) => {
    const { duration_s = 30 } = req.body // Default durasi 30 detik jika tidak dikirim

    // Jalankan langsung (tidak di-await, biar response tidak menunggu pompa selesai)
    scheduler.runIrrigationNow(req.params.deviceId, duration_s)
        .catch(err => console.error('[Schedule] Gagal menjalankan siram manual:', err.message))

    res.json({ message: `Siram manual ${duration_s}s dijadwalkan` })
})

/**
 * POST /api/schedule/:deviceId/stop
 * -----------------------------------------------------------------------------
 * Menghentikan pompa secara paksa dan instan via MQTT.
 *
 * Params: deviceId — ID perangkat
 */
router.post('/:deviceId/stop', async (req, res) => {
    const { deviceId } = req.params

    // Kirim perintah OFF langsung ke relay ESP32 via MQTT
    publishRelay(deviceId, 'OFF')

    // Catat event ini ke tabel sensor_logs sebagai audit trail
    await supabase.from('sensor_logs').insert({
        device_id: deviceId,
        event: 'manual_stop',
        note: 'Pompa dimatikan manual',
    })

    res.json({ message: 'Pompa dimatikan' })
})

/**
 * PATCH /api/schedule/:id/toggle
 * -----------------------------------------------------------------------------
 * Mengaktifkan atau menonaktifkan jadwal tanpa menghapusnya.
 *
 * Cara kerjanya:
 * - Jika jadwal sedang AKTIF → hentikan task di memori, update is_active = false
 * - Jika jadwal sedang NON-AKTIF → daftarkan ulang task di memori, update is_active = true
 *
 * Params: id — UUID jadwal dari tabel schedules
 */
router.patch('/:id/toggle', async (req, res) => {
    const { data: schedule, error: fetchErr } = await supabase
        .from('schedules')
        .select('is_active, cron, duration_s, device_id')
        .eq('id', req.params.id)
        .single()

    if (fetchErr) return res.status(404).json({ error: 'Jadwal tidak ditemukan' })

    const newStatus = !schedule.is_active

    if (newStatus) {
        scheduler.registerSchedule(req.params.id, schedule.device_id, schedule.cron, schedule.duration_s)
        console.log(`[Schedule] Jadwal ${req.params.id} diaktifkan kembali`)
    } else {
        scheduler.unregisterSchedule(req.params.id)
        console.log(`[Schedule] Jadwal ${req.params.id} dinonaktifkan`)
    }

    const { data, error } = await supabase
        .from('schedules')
        .update({ is_active: newStatus })
        .eq('id', req.params.id)
        .select()
        .single()

    if (error) return res.status(500).json({ error: error.message })

    res.json({
        message: newStatus ? 'Jadwal diaktifkan' : 'Jadwal dinonaktifkan',
        data,
    })
})

module.exports = router
