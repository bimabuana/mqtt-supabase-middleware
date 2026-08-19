/**
 * =============================================================================
 * ROUTE: HISTORY — Riwayat Data Sensor
 * =============================================================================
 * File ini mengurus pengambilan data historis dari sensor SHT31.
 * Data historis berguna untuk:
 * - Menampilkan grafik suhu & kelembapan di aplikasi Flutter
 * - Melihat tren kondisi kumbung jamur dalam beberapa hari terakhir
 * - Evaluasi apakah sistem otomasi bekerja dengan baik
 *
 * Endpoint yang tersedia:
 * - GET /api/history/:deviceId            → Data sensor terbaru (N data terakhir)
 * - GET /api/history/:deviceId/daily      → Rata-rata per hari (N hari terakhir)
 * =============================================================================
 */

const router = require('express').Router()
const supabase = require('../supabase/client')

/**
 * GET /api/history/:deviceId?limit=100
 * -----------------------------------------------------------------------------
 * Mengambil data log sensor terbaru untuk sebuah device.
 * Data diurutkan dari yang paling baru ke paling lama.
 *
 * Kenapa ada batas maksimum 500?
 * Untuk mencegah query yang terlalu berat ke database, yang bisa memperlambat
 * server dan menghabiskan kuota Supabase. Kalau butuh lebih banyak data,
 * sebaiknya gunakan endpoint /daily dengan agregasi.
 *
 * Params: deviceId — ID perangkat
 * Query:  limit (opsional, default 100, maks 500)
 *
 * Contoh: GET /api/history/esp32-01?limit=50
 */
router.get('/:deviceId', async (req, res) => {
    console.log(`[History Route] Handler berjalan untuk device: ${req.params.deviceId}`)
    // Math.min memastikan limit tidak melebihi 500, sekali pun user kirim nilai lebih besar
    const limit = Math.min(parseInt(req.query.limit) || 100, 500)

    const { data, error } = await supabase
        .from('sensor_logs')
        .select('temperature, humidity, relay_state, mode, created_at')
        .eq('device_id', req.params.deviceId)
        .order('created_at', { ascending: false }) // Data terbaru di atas
        .limit(limit)

    if (error) {
        console.error('[History Router] Gagal ambil history:', error.message)
        return res.status(500).json({ error: error.message })
    }
    res.json(data)
})

/**
 * GET /api/history/:deviceId/daily?days=7
 * -----------------------------------------------------------------------------
 * Mengambil data rata-rata suhu dan kelembapan per hari.
 * Berguna untuk grafik tren jangka panjang tanpa data yang terlalu padat.
 *
 * Endpoint ini memanggil Stored Procedure (fungsi SQL) bernama 'get_daily_average'
 * yang sudah didefinisikan di Supabase. Artinya proses agregasi dilakukan
 * di sisi database (lebih efisien daripada di server Node.js).
 *
 * Params: deviceId — ID perangkat
 * Query:  days (opsional, default 7 hari)
 *
 * Contoh: GET /api/history/esp32-01/daily?days=14
 */
router.get('/:deviceId/daily', async (req, res) => {
    const { deviceId } = req.params
    const days = parseInt(req.query.days) || 7  // default 7 hari terakhir

    // Panggil stored procedure di Supabase dengan parameter deviceId dan jumlah hari
    const { data, error } = await supabase.rpc('get_daily_average', {
        p_device_id: deviceId,
        p_days: days,
    })

    if (error) return res.status(500).json({ error: error.message })
    res.json(data)
})

/**
 * GET /api/history/:deviceId/hourly?days=7
 * -----------------------------------------------------------------------------
 * Mengambil rata-rata suhu dan kelembapan per jam.
 * Digunakan untuk grafik harian yang menunjukkan data per jam di UI.
 * Memanggil fungsi RPC 'get_hourly_average' di Supabase untuk performa yang lebih baik,
 * terutama mengingat data sensor masuk sangat cepat (misal setiap 3 detik).
 * 
 * Params: deviceId — ID perangkat
 * Query:  days (opsional, default 7 hari)
 */
router.get('/:deviceId/hourly', async (req, res) => {
    const { deviceId } = req.params
    const days = parseInt(req.query.days) || 7

    // Panggil stored procedure di Supabase dengan parameter deviceId dan jumlah hari
    const { data, error } = await supabase.rpc('get_hourly_average', {
        p_device_id: deviceId,
        p_days: days,
    })

    if (error) return res.status(500).json({ error: error.message })
    res.json(data)
})

module.exports = router