/**
 * =============================================================================
 * MQTT CLIENT — Jembatan Komunikasi ke ESP32
 * =============================================================================
 * File ini mengurus semua komunikasi antara server Node.js dan perangkat ESP32
 * menggunakan protokol MQTT melalui HiveMQ Cloud.
 *
 * MQTT itu apa?
 * MQTT adalah protokol pesan ringan yang populer di dunia IoT. Cara kerjanya
 * seperti sistem "publish-subscribe": ada yang kirim pesan (publish) ke sebuah
 * "topik", dan ada yang langganan (subscribe) topik itu untuk menerimanya.
 *
 * Di sistem ini:
 * - ESP32 → PUBLISH data sensor ke topik 'sensor/sht31'
 * - Server → SUBSCRIBE ke 'sensor/sht31' untuk menerima data tersebut
 * - Server → PUBLISH perintah ke 'cmd/relay/{deviceId}' untuk nyala/matiin pompa
 * - Server → PUBLISH config ke 'config/threshold' saat threshold diubah
 *
 * Fitur penting di file ini: IN-MEMORY CACHE untuk threshold.
 * Tanpa cache: setiap data sensor masuk (bisa 1x/detik!) → query ke Supabase.
 * Dengan cache: data threshold disimpan di memori, query DB hanya tiap 30 detik.
 * Ini menghemat kuota database secara signifikan.
 * =============================================================================
 */

const mqtt = require('mqtt')
const supabase = require('../supabase/client')
const { sendNotification } = require('../utils/notification')

// Daftar topik MQTT yang digunakan dalam sistem ini
const TOPIC_SENSOR = 'sensor/sht31'         // Topik untuk menerima data dari ESP32
const TOPIC_THRESHOLD_BASE = 'config/threshold' // Topik dasar untuk kirim setting threshold ke ESP32
const TOPIC_RELAY = 'cmd/relay'            // Topik dasar untuk kontrol relay
const TOPIC_MODE = 'cmd/mode'             // Topik dasar untuk mengirim perintah ganti mode ke ESP32

// =============================================================================
// IN-MEMORY CACHE — Penyimpanan Sementara di Memori Server
// =============================================================================
// Map ini menyimpan data threshold tiap device agar tidak perlu query DB terus-menerus.
// Format isi Map: { deviceId → { temp_min, temp_max, hum_max, cachedAt } }
const thresholdCache = new Map()
const CACHE_TTL_MS = 5 * 60 * 1000  // 5 menit (diperpanjang agar hemat query DB, otomatis ter-update saat user ganti threshold via API)

/**
 * Ambil data threshold dari cache. Kalau cache kosong atau sudah kadaluarsa,
 * baru query ke database Supabase, lalu simpan hasilnya ke cache.
 *
 * @param {string} deviceId - ID perangkat ESP32
 * @returns {Object|null} Objek { temp_min, temp_max, hum_max } atau null jika gagal
 */
async function getCachedThreshold(deviceId) {
    const cached = thresholdCache.get(deviceId)

    // Cek apakah cache masih valid (belum kadaluarsa)
    if (cached && (Date.now() - cached.cachedAt) < CACHE_TTL_MS) {
        return cached  // cache hit — tidak perlu query DB
    }

    // Cache miss atau sudah expired — ambil data segar dari Supabase
    const { data, error } = await supabase
        .from('thresholds')
        .select('temp_min, temp_max, hum_max')
        .eq('device_id', deviceId)
        .limit(1)
        .maybeSingle()

    if (error) {
        console.error('[Cache] Gagal baca threshold:', error.message)
        return null
    }

    if (!data) {
        console.warn(`[Cache] Threshold belum disetel untuk ${deviceId}`)
        return null
    }

    // Fallback temp_min ke 20.0 jika di db nilainya null
    const temp_min = (data.temp_min === undefined || data.temp_min === null) ? 20.0 : data.temp_min;

    // Simpan hasil query ke cache beserta timestamp saat ini
    thresholdCache.set(deviceId, { 
        temp_min,
        temp_max: data.temp_max,
        hum_max: data.hum_max,
        cachedAt: Date.now() 
    })
    return { temp_min, temp_max: data.temp_max, hum_max: data.hum_max }
}
// =============================================================================

// =============================================================================
// IN-MEMORY CACHE UNTUK SMART FILTER, THROTTLING, & STATUS
// =============================================================================
// Map ini mencatat status terakhir agar tidak spam ke Supabase
const sensorLogCache = new Map()     // { temp, hum, relay_state, mode, lastSavedAt }
const lastSeenCache = new Map()      // timestamp terakhir kali device laporan online
const lastProcessedCache = new Map() // timestamp terakhir kali data sensor diproses (Throttling)

const SENSOR_THROTTLE_MS = 5 * 1000;         // Minimal jeda 5 detik antar pemrosesan sensor (hemat CPU)
const TEMP_DELTA = 0.5;                      // Perubahan suhu minimal untuk disimpan ke DB
const HUM_DELTA = 1.0;                       // Perubahan kelembapan minimal untuk disimpan ke DB
const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000; // 5 menit (jaga grafik tidak putus)
const LAST_SEEN_INTERVAL_MS = 1 * 60 * 1000; // 1 menit (throttle status online)
// =============================================================================

// Variabel untuk menyimpan instance koneksi MQTT (digunakan di seluruh file ini)
let client

/**
 * Memulai koneksi ke MQTT broker (HiveMQ Cloud).
 * Fungsi ini dipanggil PERTAMA KALI saat server start di index.js,
 * sebelum Worker dijalankan, agar MQTT siap saat Worker butuh publishRelay.
 */
function connect() {
    if (client) {
        console.warn('[MQTT] Client sudah terhubung. Mengabaikan pemanggilan connect() baru.')
        return
    }
    // Buat koneksi ke HiveMQ menggunakan kredensial dari .env (Protokol MQTT 5 untuk Shared Subscription)
    client = mqtt.connect(process.env.MQTT_BROKER_URL, {
        port: parseInt(process.env.MQTT_PORT) || 8883,
        username: process.env.MQTT_USERNAME,
        password: process.env.MQTT_PASSWORD,
        protocol: 'mqtts',       // wajib TLS untuk HiveMQ Cloud (koneksi terenkripsi)
        protocolVersion: 5,      // MQTT 5 untuk mendukung Shared Subscription ($share)
        clientId: `nodejs-backend-${Date.now()}`, // ID unik agar tidak bentrok
        clean: true,
        reconnectPeriod: 5000,   // Coba reconnect tiap 5 detik jika koneksi putus
    })

    // Event: Berhasil terhubung ke broker
    client.on('connect', () => {
        console.log('[MQTT] Terhubung ke HiveMQ Cloud (MQTT 5 Shared Subscription aktif)')
        // Mulai "dengarkan" data sensor dari ESP32 menggunakan Shared Subscription.
        // Dengan $share/backend_jamur/, HiveMQ Cloud hanya akan mengirimkan data sensor
        // ke 1 instance backend saja secara bergantian (mencegah duplikasi log jika ada multi-server).
        client.subscribe(`$share/backend_jamur/${TOPIC_SENSOR}`, { qos: 1 })
        // Mulai "dengarkan" status keaktifan perangkat (LWT)
        client.subscribe('$share/backend_jamur/status/+', { qos: 1 })
    })

    /**
     * Event: Ada pesan masuk dari topik yang di-subscribe.
     * Ini adalah inti dari pemrosesan data sensor.
     * Alur: Terima data → Simpan ke DB → Cek threshold → Kontrol relay
     */
    client.on('message', async (topic, payload) => {
        try {
            // Proses pesan status LWT (status/+)
            if (topic.startsWith('status/')) {
                const device_id = topic.split('/')[1]
                const status = payload.toString().trim() // "online" atau "offline"
                console.log(`[MQTT] [LWT] Perangkat ${device_id} berstatus: ${status}`)

                const isOnline = status === 'online'
                
                // Update status di Supabase
                const { data, error } = await supabase.from('devices')
                    .update({ 
                        is_online: isOnline, 
                        last_seen: new Date().toISOString() 
                    })
                    .eq('device_id', device_id)
                    .select('claimed_by')
                    .maybeSingle()

                if (error) {
                    console.error(`[MQTT] [LWT] Gagal update status ${device_id} ke DB:`, error.message)
                } else {
                    console.log(`[MQTT] [LWT] Berhasil update status ${device_id} ke DB -> is_online: ${isOnline}`)
                    if (!isOnline && data && data.claimed_by) {
                        sendNotification(
                            data.claimed_by,
                            'Perangkat Offline! 🚨',
                            `Perangkat IoT Kumbung (${device_id}) terputus dari jaringan atau mati listrik (LWT).`,
                            3600 // Cooldown 1 jam
                        );
                    }
                }
                return
            }

            // Hanya proses pesan dari topik sensor, abaikan topik lain
            if (topic !== TOPIC_SENSOR) return

            // Parsing payload dari format JSON ke objek JavaScript
            let data
            try {
                data = JSON.parse(payload.toString())
            } catch {
                return console.error('[MQTT] Payload tidak valid JSON')
            }

            // Destructure data sensor. Jika ESP32 tidak kirim device_id, pakai default 'esp32-01'
            const { temp, hum, mode, device_id = 'esp32-01' } = data
            const relay_state = data.relay_state ?? data.relay ?? false;

            const now = Date.now();
            const lastData = sensorLogCache.get(device_id);
            const safeMode = mode ?? (lastData?.mode ?? 'auto');

            const relayChanged = lastData ? (relay_state !== lastData.relay_state) : false;
            const modeChanged = lastData ? (safeMode !== lastData.mode) : false;

            // ── INGESTION THROTTLING (HEMAT CPU & MEMORY) ─────────────────────────
            // Jika data masuk dalam jeda < 5 detik dan TIDAK ada perubahan status pompa/mode,
            // langsung lewati (skip) agar CPU tidak bekerja berlebihan.
            const lastProcessed = lastProcessedCache.get(device_id) || 0;
            if (lastData && (now - lastProcessed < SENSOR_THROTTLE_MS) && !relayChanged && !modeChanged) {
                return; // Lewati siklus ini
            }
            lastProcessedCache.set(device_id, now);
            // ──────────────────────────────────────────────────────────────────────

            // Langkah 1A: Update status online (last_seen) dengan throttle 1 menit
            const lastSeen = lastSeenCache.get(device_id) || 0;
            if (now - lastSeen > LAST_SEEN_INTERVAL_MS) {
                supabase.from('devices')
                    .update({ is_online: true, last_seen: new Date().toISOString() })
                    .eq('device_id', device_id)
                    .then(({ error }) => {
                        if (error) console.error('[MQTT] Gagal update last_seen:', error.message);
                        else lastSeenCache.set(device_id, now);
                    });
            }

            // Langkah 1B: Smart Filter untuk menyimpan data ke tabel sensor_logs
            let shouldSaveData = false;

            if (!lastData) {
                shouldSaveData = true; // Simpan jika belum ada riwayat di memori server
            } else {
                const tempDiff = Math.abs(temp - lastData.temp);
                const humDiff = Math.abs(hum - lastData.hum);
                const timeDiff = now - lastData.lastSavedAt;

                // Logika Smart Filter (Deadband)
                if (tempDiff > TEMP_DELTA || humDiff > HUM_DELTA || relayChanged || modeChanged || timeDiff > HEARTBEAT_INTERVAL_MS) {
                    shouldSaveData = true;
                }
            }

            if (shouldSaveData) {
                const { error: insertErr } = await supabase.from('sensor_logs').insert({
                    device_id,
                    temperature: temp,
                    humidity: hum,
                    relay_state: relay_state ?? false,
                    mode: safeMode,   // Simpan snapshot mode ESP32 saat data dikirim
                })
                if (insertErr) {
                    console.error('[MQTT] Gagal simpan sensor log:', insertErr.message)
                } else {
                    // Catat ke memori setelah berhasil insert
                    sensorLogCache.set(device_id, {
                        temp,
                        hum,
                        relay_state: relay_state ?? false,
                        mode: safeMode,
                        lastSavedAt: now
                    });
                }
            }

            // Langkah 2: Baca threshold dari cache (hanya untuk memastikan cache tersimpan, logika auto diurus ESP32)
            const threshold = await getCachedThreshold(device_id)

            // Langkah 3: Pengecekan Suhu & Kelembapan untuk Push Notification
            // Anti-spam (cooldown 30 menit) kini diurus otomatis oleh sendNotification.
            if (threshold) {
                const alerts = []
                let isCold = false
                let isHot = false
                let isDry = false

                if (hum < threshold.hum_max) {
                    alerts.push(`Kelembapan saat ini ${hum}% (Batas minimal: ${threshold.hum_max}%)`)
                    isDry = true
                }
                if (temp > threshold.temp_max) {
                    alerts.push(`Suhu saat ini ${temp}°C (Batas maksimal: ${threshold.temp_max}°C)`)
                    isHot = true
                } else if (temp < threshold.temp_min) {
                    alerts.push(`Suhu saat ini ${temp}°C (Batas minimal: ${threshold.temp_min}°C)`)
                    isCold = true
                }

                if (alerts.length > 0) {
                    let alertMsg = ''
                    if (alerts.length >= 2) {
                        alertMsg = `Peringatan Kumbung! ${alerts.join(' dan ')}`
                    } else if (isCold) {
                        alertMsg = `Peringatan Dingin! ${alerts[0]}`
                    } else if (isDry) {
                        alertMsg = `Peringatan Kering! ${alerts[0]}`
                    } else if (isHot) {
                        alertMsg = `Peringatan Panas! ${alerts[0]}`
                    }

                    // Cari user yang memiliki alat ini
                    const { data: device } = await supabase
                        .from('devices')
                        .select('claimed_by')
                        .eq('device_id', device_id)
                        .single()

                    if (device && device.claimed_by) {
                        // Cooldown 30 menit (1800 detik) di-handle oleh sendNotification
                        sendNotification(device.claimed_by, 'Peringatan Sensor Kumbung ⚠️', alertMsg, 1800)
                    }
                }
            }
        } catch (globalErr) {
            console.error('[MQTT] Kesalahan tidak terduga saat memproses pesan:', globalErr.message)
        }
    })

    // Event: Terjadi error pada koneksi MQTT
    client.on('error', err => console.error('[MQTT] Error:', err.message))

    // Event: Koneksi terputus — otomatis akan mencoba reconnect sesuai reconnectPeriod
    client.on('offline', () => console.warn('[MQTT] Koneksi terputus, mencoba reconnect...'))
}

/**
 * Memutuskan koneksi MQTT secara aman (digunakan saat failover kembali ke standby).
 */
function disconnect() {
    if (client) {
        client.end(true, () => {
            console.log('[MQTT] Terputus secara aman (dinonaktifkan oleh failover)')
        })
        client = null
    }
}

/**
 * Kirim nilai threshold terbaru ke ESP32 via MQTT.
 * Dipanggil otomatis saat user update threshold melalui API.
 * Sekaligus memperbarui cache agar nilai baru langsung efektif.
 *
 * @param {string} deviceId - ID perangkat target
 * @param {number} tempMin - Batas minimum suhu (°C)
 * @param {number} tempMax - Batas maksimum suhu (°C)
 * @param {number} humMax - Batas maksimum kelembapan (%)
 */
function publishThreshold(deviceId, tempMin, tempMax, humMax) {
    const payload = JSON.stringify({ 
        temp_min: tempMin, 
        temp_max: tempMax, 
        temp: tempMax, // backward compatibility
        hum: humMax 
    })
    // retain: true → ESP32 yang baru connect akan langsung dapat nilai threshold terkini
    if (client) {
        client.publish(`${TOPIC_THRESHOLD_BASE}/${deviceId}`, payload, { qos: 1, retain: true })
    } else {
        console.warn(`[MQTT] Terputus. Gagal publish threshold untuk ${deviceId} (Server Standby)`)
    }

    // Perbarui cache langsung agar nilai baru efektif tanpa harus tunggu 30 detik
    thresholdCache.set(deviceId, { temp_min: tempMin, temp_max: tempMax, hum_max: humMax, cachedAt: Date.now() })
    console.log(`[Cache] Threshold ${deviceId} diperbarui dari API`)
}

/**
 * Kirim perintah nyala atau mati ke relay ESP32.
 * Topik yang digunakan bersifat dinamis per device: cmd/relay/{deviceId}
 * Sehingga jika ada banyak device, perintah tidak tercampur.
 *
 * @param {string} deviceId - ID perangkat target
 * @param {'ON'|'OFF'} state - Perintah yang dikirim
 */
function publishRelay(deviceId, state) {
    if (client) {
        client.publish(`${TOPIC_RELAY}/${deviceId}`, state, { qos: 1 })
        console.log(`[MQTT] Relay ${deviceId} → ${state}`)
    } else {
        console.warn(`[MQTT] Terputus. Gagal kirim perintah relay ${state} ke ${deviceId} (Server Standby)`)
    }
}

/**
 * Kirim perintah ganti mode operasi ke ESP32.
 * ESP32 akan berpindah ke mode target dan menjalankan logika yang sesuai.
 *
 * @param {string} deviceId - ID perangkat target
 * @param {'auto'|'manual'|'offline'} mode - Mode yang ingin diaktifkan
 */
function publishMode(deviceId, mode) {
    if (client) {
        client.publish(`${TOPIC_MODE}/${deviceId}`, mode, { qos: 1 })
        console.log(`[MQTT] Mode ${deviceId} → ${mode}`)
    } else {
        console.warn(`[MQTT] Terputus. Gagal kirim perintah mode ${mode} ke ${deviceId} (Server Standby)`)
    }
}

module.exports = { connect, disconnect, publishThreshold, publishRelay, publishMode }