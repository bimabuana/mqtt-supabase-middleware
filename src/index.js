/**
 * =============================================================================
 * ENTRY POINT — Titik Masuk Aplikasi Backend
 * =============================================================================
 * File PERTAMA yang berjalan saat server dinyalakan.
 * Tugasnya: setup semua komponen (MQTT, Scheduler, Express, Rate Limiter)
 * dan menghubungkan semuanya menjadi satu aplikasi yang siap melayani request.
 *
 * PENTING — Urutan startup sangat penting:
 * 1. connect() -> Koneksi MQTT dijalankan PERTAMA, karena publishRelay butuh ini.
 * 2. restoreSchedules() -> Baca jadwal aktif dari DB dan daftarkan ulang ke
 *    scheduler in-memory (node-cron). Ini menjamin jadwal tidak hilang
 *    setelah server restart/redeploy.
 * 3. startOfflineDetector() -> Mulai pantau perangkat yang berhenti lapor.
 * 4. Baru setelah itu Express & semua route dijalankan.
 *
 * Catatan arsitektur:
 * Server ini didesain untuk jalan sebagai SATU instance saja (single server),
 * tanpa server cadangan/failover. Semua data penting (jadwal, threshold,
 * histori) tetap tersimpan aman di Supabase — kalau server restart/redeploy,
 * semuanya otomatis dipulihkan lewat restoreSchedules(). Yang bisa hilang
 * hanya siraman yang KEBETULAN sedang berjalan tepat saat restart terjadi.
 * =============================================================================
 */

const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '../.env') })
require('dotenv').config() // Fallback untuk CWD jika ada
const express = require('express')
const rateLimit = require('express-rate-limit')
const { connect } = require('./mqtt/mqttClient')
const { restoreSchedules } = require('./scheduler/irrigationScheduler')
const { startOfflineDetector } = require('./jobs/offlineDetector')

// LANGKAH 1-3: Nyalakan MQTT, pulihkan jadwal, mulai deteksi perangkat offline
connect()
restoreSchedules()
startOfflineDetector()

// LANGKAH 4: Inisialisasi aplikasi Express
const app = express()

// Percayai 1 layer proxy di depan aplikasi (Railway edge proxy).
app.set('trust proxy', 1)

app.use(express.json()) // Supaya server bisa membaca body request dalam format JSON

// Middleware logger sederhana untuk membantu memantau request di Railway logs
app.use((req, res, next) => {
    console.log(`[HTTP] ${req.method} ${req.url}`)
    next()
})

// =============================================================================
// RATE LIMITER — Pelindung dari request berlebihan
// =============================================================================
// Rate limiter global: berlaku untuk semua endpoint /api
// Maksimal 100 request per menit dari satu IP address yang sama
const globalLimiter = rateLimit({
    windowMs: 60 * 1000, // Window waktu: 1 menit
    max: 100,            // Maks 100 request per window
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Terlalu banyak request, coba lagi dalam 1 menit.' },
})

// Rate limiter ketat khusus untuk endpoint siram manual
// Dibatasi hanya 5x per menit untuk mencegah penyiraman berlebihan yang
// bisa merusak tanaman atau menguras air terlalu cepat
const manualIrrigationLimiter = rateLimit({
    windowMs: 60 * 1000, // Window waktu: 1 menit
    max: 5,              // Maks 5 kali siram manual per menit
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Terlalu sering menyiram, tunggu sebentar.' },
})
// =============================================================================

// Terapkan rate limiter global ke semua route /api
app.use('/api', globalLimiter)

// =============================================================================
// ROUTE REGISTRATION — Daftarkan semua endpoint API
// =============================================================================
app.use('/api/threshold', require('./routes/threshold'))    // Atur batas suhu & kelembapan
app.use('/api/history', require('./routes/history'))        // Lihat riwayat data sensor
app.use('/api/schedule/:deviceId/now', manualIrrigationLimiter) // Extra ketat untuk siram manual (HARUS sebelum route schedule!)
app.use('/api/schedule', require('./routes/schedule'))      // Kelola jadwal penyiraman
app.use('/api/device', require('./routes/device'))          // Klaim & kelola perangkat
app.use('/api/mode', require('./routes/mode'))              // Kontrol mode operasi ESP32 (auto/manual)
// =============================================================================

// Endpoint health check untuk platform deployment seperti Railway
app.get('/', (req, res) => {
    res.status(200).send('OK');
});

// Port & Host binding:
// Railway & Render menyediakan process.env.PORT
// Alwaysdata menyediakan process.env.PORT dan process.env.IP (IPv6)
const PORT = parseInt(process.env.PORT) || 3000
const HOST = process.env.IP || '0.0.0.0'

app.listen(PORT, HOST, () => {
    console.log(`[Server] Running on ${HOST}:${PORT}`)
})
