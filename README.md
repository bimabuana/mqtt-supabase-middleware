# 🍄 Backend IoT Kumbung Jamur

> **⚠️ CATATAN MIGRASI (dibaca dulu sebelum baca bagian di bawah)**
> Versi ini sudah **tidak lagi memakai Redis/BullMQ maupun dual-server failover**
> yang dijelaskan di bagian "Arsitektur Sistem Terdistribusi" di bawah ini.
> Perubahannya:
> - Penjadwalan penyiraman kini pakai **node-cron in-memory** (lihat
>   `src/scheduler/irrigationScheduler.js`), bukan BullMQ + Redis lagi.
> - Cooldown notifikasi anti-spam kini pakai **in-memory Map**, bukan Redis.
> - Server dijalankan sebagai **satu instance saja** (single server di Railway),
>   tanpa server cadangan di VPS. File `failoverManager.js` sudah dihapus.
> - Fitur test latency MQTT (`/api/latency`) dan mode `offline` ESP32 sudah
>   dihapus karena tidak dipakai.
>
> Alasan: biaya Redis (Upstash/VPS) jadi beban utama padahal kebutuhan
> sebenarnya (kontrol on/off pompa + jadwal) tidak butuh infrastruktur seberat
> itu. Bagian README di bawah ini **dibiarkan apa adanya sebagai referensi
> sejarah arsitektur lama** — kalau butuh detail teknis terkini, cek langsung
> ke kode di folder `src/`.

Backend Node.js untuk sistem monitoring dan kontrol otomatis kumbung jamur berbasis IoT. Sistem ini menghubungkan sensor **SHT31** dan relay pada **ESP32** ke aplikasi mobile **Flutter** melalui **MQTT (HiveMQ Cloud)**, dengan penjadwalan penyiraman otomatis menggunakan **BullMQ (Redis)**, sistem push notification anti-spam via **OneSignal**, serta database utama **Supabase**.

Aplikasi ini dirancang dengan arsitektur **High Availability (Dual Server Failover)** dan **In-Memory Optimizations** untuk memastikan keandalan sistem yang optimal dan efisiensi resource yang sangat tinggi.

---

## 🏗️ Arsitektur Sistem Terdistribusi

Sistem ini mendukung arsitektur **Failover Otomatis** menggunakan dua server (Primary & Backup) untuk menjamin layanan tetap berjalan meskipun server utama mengalami kendala (*down*).

```
                 ┌──────────────────────────────────────┐
                 │             Aplikasi Flutter         │
                 └──────┬────────────────────────┬──────┘
                        │                        │
       HTTP REST API    │                        │ HTTP REST API
   (https://...railway.app)                      │ (https://vps-backup-ip)
                        ▼                        ▼
           ┌────────────────────────┐  Ping  ┌────────────────────────┐
           │     PRIMARY SERVER     ├───────>│     BACKUP SERVER      │
           │       (Railway)        │ (10s)  │      (VPS Standby)     │
           └───────────┬────────────┘        └───────────┬────────────┘
                       │                                 │
                 ┌─────┴─────────────────────────────────┴─────┐
                 │                                             │
                 ▼                     ▼                       ▼
            Supabase (DB)       Upstash (Redis)           HiveMQ Cloud
         ┌────────────────┐   ┌─────────────────┐     ┌──────────────────┐
         │  Tabel Utama &  │   │  Antrian Kerja  │     │   Broker MQTT    │
         │  RPC Functions │   │    (BullMQ)     │     │      (TLS)       │
         └────────────────┘   └─────────────────┘     └────────┬─────────┘
                                                               │
                                                               ▼ (mqtts://)
                                                       ┌─────────────────┐
                                                       │ ESP32 + SHT31   │
                                                       └─────────────────┘
```

### 🔄 Alur & Fitur Utama Failover (Dynamic Failover Manager)
1. **Primary Server (Railway)**: Berjalan secara aktif. Menangani REST API, koneksi MQTT, pemrosesan antrian BullMQ, dan pendeteksian perangkat offline.
2. **Backup Server (VPS - Standby)**:
   - Saat startup, background services (MQTT, Worker BullMQ, Scheduler Restore, Offline Detector) **dinonaktifkan** (standby).
   - Secara berkala (setiap 10 detik / `FAILOVER_PING_INTERVAL_MS`), server backup mengirimkan ping (HTTP GET) ke `PRIMARY_SERVER_URL`.
   - **Jika Primary Down (Ping Gagal)**: Backup server langsung mengaktifkan semua background services lokal, me-resume worker BullMQ, me-restore jadwal aktif dari database, dan mengambil alih kendali sistem.
   - **Jika Primary Kembali Online (Ping Sukses)**: Backup server secara otomatis mendegradasi diri kembali ke mode standby (disconnect MQTT, pause worker, matikan offline detector) untuk menghindari bentrokan eksekusi (*race conditions*).

---

## ⚡ Optimalisasi Kinerja & Efisiensi Database

Untuk mencegah pembengkakan biaya database (kuota request Supabase) dan beban broker MQTT akibat frekuensi transmisi data ESP32 yang tinggi, backend mengimplementasikan beberapa teknik optimalisasi tingkat tinggi:

### 1. In-Memory Cache (Threshold Cache)
* **Masalah**: ESP32 mengirim data sensor secara real-time. Jika backend harus menanyakan batas threshold ke Supabase setiap kali data masuk, database akan terbebani ribuan query per menit.
* **Solusi**: Nilai threshold disimpan dalam *in-memory cache* server dengan TTL 30 detik (`CACHE_TTL_MS`). Query ke Supabase hanya dilakukan saat cache kedaluwarsa atau terjadi update threshold melalui API (cache langsung di-invalidate secara instan).

### 2. Smart Filtering & Deadband Logging (Sensor Log Cache)
Backend menyaring log sensor sebelum disimpan ke database Supabase melalui algoritma *Deadband filtering*:
* Data sensor hanya akan disimpan ke tabel `sensor_logs` jika memenuhi salah satu kondisi berikut:
  - Suhu berubah lebih dari **0.5°C** (`TEMP_DELTA`).
  - Kelembapan berubah lebih dari **1.0%** (`HUM_DELTA`).
  - Status relay berubah (`ON` ↔ `OFF`).
  - Mode operasi perangkat berubah (`auto`, `manual`, `offline`).
  - Interval waktu detak jantung (*heartbeat*) telah mencapai **5 menit** (`HEARTBEAT_INTERVAL_MS`), bertujuan untuk menjaga kontinuitas grafik di UI.
* Mengurangi penyimpanan database hingga **90%** tanpa kehilangan data historis yang penting.

### 3. Online Status Throttling
* Status keaktifan perangkat (`last_seen` dan `is_online`) di database diperbarui secara berkala maksimal **1 menit sekali** (`LAST_SEEN_INTERVAL_MS`), mencegah spam penulisan (*write-heavy*) ke Supabase.

---

## 🚨 Pendeteksi Perangkat Offline & Push Notification

### 1. Offline Detector Job
* Berjalan di latar belakang setiap 5 menit.
* Memindai perangkat di database yang berstatus `is_online = true` namun `last_seen` berumur lebih dari 5 menit lalu.
* Jika ditemukan, secara otomatis memperbarui status perangkat menjadi offline di database dan memicu push notification darurat ke pemilik perangkat.

### 2. Anti-Spam Push Notification (OneSignal Integration)
* **Koneksi**: Integrasi langsung ke OneSignal menggunakan API REST resmi.
* **Anti-Spam Guard (Cooldown)**: Setiap notifikasi yang sama (misal peringatan sensor kering/panas atau status offline) memiliki *cooldown time* (seperti 30 menit atau 1 jam) yang dikelola di Redis / In-Memory Map agar pengguna tidak dibanjiri spam push notification.
* **Notification Stacking & Threading**: Menggunakan `android_group`, `thread_id`, dan `collapse_id` dengan nama `jamur_monitoring_group` untuk mengelompokkan notifikasi secara rapi di notification tray Android & iOS (seperti gaya chat WhatsApp).

---

## 📋 Prasyarat Layanan Cloud

Pastikan Anda memiliki akun dan konfigurasi untuk layanan-layanan berikut:

| Layanan | Keterangan |
|---|---|
| [Supabase](https://supabase.com) | Database PostgreSQL utama (gratis) |
| [HiveMQ Cloud](https://www.hivemq.com/mqtt-cloud-broker/) | MQTT Broker TLS aman port 8883 (gratis) |
| [Upstash Redis](https://upstash.com) | Redis Cloud untuk antrian BullMQ (gratis) |
| [OneSignal](https://onesignal.com) | Platform Push Notification ke Aplikasi Mobile |
| Node.js >= 18 | Runtime JavaScript lokal |

---

## ⚙️ Instalasi & Konfigurasi

### 1. Clone & Install Dependencies

```bash
git clone <repository-url>
cd backend-jamur
npm install
```

### 2. Setup Environment Variables

Buat file `.env` di root folder aplikasi, lalu isi konfigurasi berikut:

```env
# 💻 Server Configuration
PORT=3000
IS_BACKUP_SERVER=false                  # Set 'true' jika ini dideploy ke server VPS Backup
PRIMARY_SERVER_URL=https://nama-project-kamu.up.railway.app # URL Primary Server (diperlukan jika ini Backup Server)
FAILOVER_PING_INTERVAL_MS=10000         # Interval cek primary server (dalam milidetik, default 10 detik)

# ⚡ Supabase Configuration (Ambil dari: Project Settings > API)
SUPABASE_URL=https://xxxxxxxxxxxxxxxx.supabase.co
SUPABASE_SERVICE_KEY=sb_secret_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# 📡 HiveMQ Cloud MQTT Broker (Ambil dari: Clusters > MQTT Credentials & Connection Settings)
MQTT_BROKER_URL=mqtts://xxxxxxxxxxxxxxxxxxxxxxxx.s1.eu.hivemq.cloud:8883
MQTT_PORT=8883
MQTT_USERNAME=username_hivemq_kamu
MQTT_PASSWORD=password_hivemq_kamu

# 🔴 Upstash Redis Connection (Ambil dari: Database > Details > Connection URL)
REDIS_URL=rediss://default:xxxxxxxx@xxxx.upstash.io:6379

# 🔔 OneSignal Push Notification (Ambil dari: Settings > Keys & IDs)
ONESIGNAL_APP_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
ONESIGNAL_REST_API_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

> ⚠️ **PENTING**: Jangan pernah melakukan commit file `.env` ke Git! File ini sudah otomatis diabaikan di file `.gitignore`.

### 3. Setup Database Supabase (Skema Tabel & Stored Procedure)

Jalankan perintah SQL berikut di dashboard **Supabase > SQL Editor**:

```sql
-- 1. TABEL UTAMA: Perangkat ESP32
CREATE TABLE devices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id TEXT UNIQUE NOT NULL,       -- e.g. "esp32-01"
    label TEXT,                           -- nama display e.g. "Kumbung Barat"
    location TEXT,                        -- lokasi penempatan
    claim_code TEXT UNIQUE,               -- kode klaim huruf kapital, e.g. "JAMUR01"
    claimed_by UUID REFERENCES auth.users(id),
    claimed_at TIMESTAMPTZ,
    is_online BOOLEAN DEFAULT false,
    last_seen TIMESTAMPTZ,
    current_mode TEXT DEFAULT 'auto'      -- mode kerja aktif: auto, manual, offline
);

-- 2. TABEL LOG: Riwayat Sensor & Log Aksi
CREATE TABLE sensor_logs (
    id BIGSERIAL PRIMARY KEY,
    device_id TEXT NOT NULL,
    temperature FLOAT,
    humidity FLOAT,
    relay_state BOOLEAN DEFAULT false,    -- true = ON, false = OFF
    mode TEXT DEFAULT 'auto',             -- snapshot mode kerja saat log terekam
    event TEXT,                           -- event penting (e.g. "manual_stop", "system_on")
    note TEXT,                            -- catatan tambahan
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. TABEL CONFIG: Batas Sensor Otomatisasi
CREATE TABLE thresholds (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id TEXT UNIQUE NOT NULL,
    temp_max FLOAT NOT NULL DEFAULT 30.0,    -- suhu maks sebelum pompa ON
    hum_max FLOAT NOT NULL DEFAULT 80.0,     -- kelembapan maks sebelum pompa ON
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. TABEL JADWAL: Jadwal Penyiraman BullMQ
CREATE TABLE schedules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id TEXT NOT NULL,
    label TEXT,
    cron TEXT NOT NULL,          -- cron format: "menit jam hari bulan hari-minggu"
    duration_s INTEGER NOT NULL, -- durasi penyiraman dalam detik
    bull_job_id TEXT,            -- ID job BullMQ untuk kontrol sinkronisasi
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. FUNCTION: Rata-rata Harian (RPC Function)
CREATE OR REPLACE FUNCTION get_daily_average(p_device_id TEXT, p_days INT)
RETURNS TABLE(day DATE, avg_temp NUMERIC, avg_hum NUMERIC) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        created_at::DATE AS day,
        ROUND(AVG(temperature)::NUMERIC, 1) AS avg_temp,
        ROUND(AVG(humidity)::NUMERIC, 1) AS avg_hum
    FROM sensor_logs
    WHERE device_id = p_device_id
      AND created_at >= NOW() - (p_days || ' days')::INTERVAL
      AND temperature IS NOT NULL
      AND humidity IS NOT NULL
    GROUP BY created_at::DATE
    ORDER BY day DESC;
END;
$$ LANGUAGE plpgsql;

-- 6. FUNCTION: Rata-rata Per Jam (RPC Function)
CREATE OR REPLACE FUNCTION get_hourly_average(p_device_id TEXT, p_days INT)
RETURNS TABLE(hour TIMESTAMPTZ, avg_temp NUMERIC, avg_hum NUMERIC) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        date_trunc('hour', created_at) AS hour,
        ROUND(AVG(temperature)::NUMERIC, 1) AS avg_temp,
        ROUND(AVG(humidity)::NUMERIC, 1) AS avg_hum
    FROM sensor_logs
    WHERE device_id = p_device_id
      AND created_at >= NOW() - (p_days || ' days')::INTERVAL
      AND temperature IS NOT NULL
      AND humidity IS NOT NULL
    GROUP BY date_trunc('hour', created_at)
    ORDER BY hour DESC;
END;
$$ LANGUAGE plpgsql;
```

### 4. Jalankan Server Secara Lokal

```bash
# Jalankan mode Development (Auto-restart via nodemon)
npm run dev

# Jalankan mode Production
npm start
```

Server akan aktif pada port `http://localhost:3000` (atau sesuai konfigurasi env `PORT`).

---

## 🚀 Panduan Deployment

### A. Deploy ke Railway (Sebagai Primary Server)
1. Hubungkan repository GitHub Anda ke [Railway.app](https://railway.app).
2. Buat Project Baru dan pilih **Deploy dari GitHub**.
3. Di tab **Variables**, masukkan semua Environment Variables seperti isi file `.env` di atas (kecuali `PORT` karena dikelola otomatis oleh Railway).
4. Klik **Generate Domain** di tab **Settings > Networking** untuk mendapatkan URL server publik (contoh: `https://nama-project-kamu.up.railway.app`).

### B. Deploy ke VPS (Sebagai Backup Server)
1. Siapkan server VPS (Ubuntu/Debian) dengan Node.js >= 18 dan PM2 terinstall.
2. Clone repository, jalankan `npm install`.
3. Set file `.env` dengan variabel `IS_BACKUP_SERVER=true` dan isikan `PRIMARY_SERVER_URL` dengan URL Railway yang didapatkan dari langkah di atas.
4. Jalankan server menggunakan PM2 agar berjalan di latar belakang:
   ```bash
   pm2 start src/index.js --name backend-jamur-backup
   pm2 save
   pm2 startup
   ```

---

## 🔌 API Reference

Base URL (Development): `http://localhost:3000/api`  
Base URL (Production): `https://nama-project-kamu.up.railway.app/api`

> 🛡️ **Rate Limiting**:
> * Global rate limit untuk semua API: **100 request/menit per IP**.
> * Rate limit ketat untuk trigger siram manual: **5 request/menit per IP** (menghindari banjir air pada kumbung).

---

### 📋 Ringkasan Daftar API (API Cheat Sheet)

Untuk mempermudah pencarian, berikut adalah ringkasan seluruh endpoint API yang tersedia pada backend ini:

| Kategori | Fitur / Kegunaan | Method | Endpoint | Deskripsi Singkat |
|---|---|:---:|---|---|
| **📱 Device** | Klaim Device Baru (Pairing) | `POST` | `/api/device/claim` | Menghubungkan perangkat fisik ke akun user via kode klaim. |
| | Ambil Info Device User | `GET` | `/api/device/my-device/:userId` | Mengambil detail perangkat milik user (status online, last seen). |
| **🌡️ Threshold** | Ambil Threshold Aktif | `GET` | `/api/threshold/:deviceId` | Membaca batas suhu & kelembapan otomatisasi aktif. |
| | Update Threshold | `POST` | `/api/threshold/:deviceId` | Mengubah batas threshold (langsung sinkron ke ESP32 via MQTT). |
| **🗓️ Jadwal** | Ambil Semua Jadwal | `GET` | `/api/schedule/:deviceId` | Membaca seluruh daftar jadwal penyiraman perangkat. |
| | Buat Jadwal Baru | `POST` | `/api/schedule/:deviceId` | Mendaftarkan jadwal berulang baru ke DB & BullMQ (cron). |
| | Hapus Jadwal | `DELETE` | `/api/schedule/:id` | Menghapus jadwal permanen dari database dan antrian BullMQ. |
| | Toggle Status Jadwal | `PATCH` | `/api/schedule/:id/toggle` | Mengaktifkan/menonaktifkan jadwal sementara tanpa menghapus. |
| | Trigger Siram Instan | `POST` | `/api/schedule/:deviceId/now` | Memicu penyiraman manual sekali jalan (default durasi 30 detik). |
| | Hentikan Pompa Paksa | `POST` | `/api/schedule/:deviceId/stop` | Mengirim sinyal `OFF` langsung ke relay pompa via MQTT. |
| **⚙️ Mode** | Ambil Mode Kerja Aktif | `GET` | `/api/mode/:deviceId` | Membaca mode kerja aktif perangkat (`auto`, `manual`, `offline`). |
| | Ubah Mode Kerja | `POST` | `/api/mode/:deviceId` | Mengubah mode kerja ESP32 dan sinkronisasi perintah via MQTT. |
| **📊 Riwayat** | Ambil Log Sensor Terbaru | `GET` | `/api/history/:deviceId` | Mengambil data sensor real-time terbaru (terlimit maks 500). |
| | Rata-rata Harian | `GET` | `/api/history/:deviceId/daily` | Mengambil data rata-rata suhu & kelembapan harian (tren grafik). |
| | Rata-rata Per Jam | `GET` | `/api/history/:deviceId/hourly` | Mengambil data rata-rata suhu & kelembapan per jam (grafik analitis). |

---

### 📱 Device Management

#### 1. Klaim Device Baru (Pairing)
Menghubungkan kode unik perangkat fisik dengan ID akun pengguna.
* **Endpoint**: `POST /api/device/claim`
* **Body Request**:
  ```json
  {
      "claim_code": "JAMUR01",
      "user_id": "uuid-user-dari-supabase-auth"
  }
  ```
* **Respons Sukses (200)**:
  ```json
  {
      "message": "Device berhasil diklaim",
      "device": {
          "device_id": "esp32-01",
          "label": "Kumbung Barat",
          "location": "Sektor A"
      }
  }
  ```

#### 2. Ambil Info Device Milik User
* **Endpoint**: `GET /api/device/my-device/:userId`
* **Respons Sukses (200)**:
  ```json
  {
      "device_id": "esp32-01",
      "label": "Kumbung Barat",
      "location": "Sektor A",
      "is_online": true,
      "last_seen": "2026-05-24T10:00:00Z"
  }
  ```

---

### 🌡️ Threshold Management

#### 1. Ambil Threshold Aktif
* **Endpoint**: `GET /api/threshold/:deviceId`
* **Respons Sukses (200)**:
  ```json
  {
      "device_id": "esp32-01",
      "temp_max": 30.0,
      "hum_max": 80.0,
      "updated_at": "2026-05-24T09:00:00Z"
  }
  ```

#### 2. Update Threshold
Memperbarui batas threshold di DB dan langsung mengirimkan pembaruan ke ESP32 secara instan via MQTT.
* **Endpoint**: `POST /api/threshold/:deviceId`
* **Body Request**:
  ```json
  {
      "temp_max": 31.5,
      "hum_max": 85.0
  }
  ```
* **Respons Sukses (200)**:
  ```json
  {
      "message": "Threshold diupdate",
      "data": { "device_id": "esp32-01", "temp_max": 31.5, "hum_max": 85.0 }
  }
  ```

---

### 🗓️ Jadwal & Kontrol Penyiraman

#### 1. Ambil Semua Jadwal Perangkat
* **Endpoint**: `GET /api/schedule/:deviceId`
* **Respons Sukses (200)**:
  ```json
  [
      {
          "id": "uuid-jadwal-1",
          "device_id": "esp32-01",
          "label": "Siram Pagi Hari",
          "cron": "0 6 * * *",
          "duration_s": 60,
          "is_active": true,
          "created_at": "2026-05-24T08:00:00Z"
      }
  ]
  ```

#### 2. Buat Jadwal Penyiraman Baru
Menambahkan jadwal ke DB dan mendaftarkannya sebagai antrian *repeatable job* di BullMQ.
* **Endpoint**: `POST /api/schedule/:deviceId`
* **Body Request**:
  ```json
  {
      "label": "Siram Sore",
      "cron": "0 17 * * *",
      "duration_s": 45
  }
  ```
* **Respons Sukses (210/201)**:
  ```json
  {
      "id": "uuid-jadwal-baru",
      "device_id": "esp32-01",
      "label": "Siram Sore",
      "cron": "0 17 * * *",
      "duration_s": 45,
      "is_active": true
  }
  ```

#### 3. Hapus Jadwal
Menghapus permanen jadwal dari database dan membatalkan repeatable job dari BullMQ.
* **Endpoint**: `DELETE /api/schedule/:id`
* **Respons Sukses (200)**:
  ```json
  { "message": "Jadwal dihapus" }
  ```

#### 4. Toggle Jadwal (Aktif / Nonaktif)
Menghentikan eksekusi jadwal sementara waktu di BullMQ tanpa menghapus data jadwal dari database.
* **Endpoint**: `PATCH /api/schedule/:id/toggle`
* **Respons Sukses (200)**:
  ```json
  {
      "message": "Jadwal dinonaktifkan",
      "data": { "id": "uuid-jadwal-1", "is_active": false }
  }
  ```

#### 5. Trigger Siram Manual (Sekali Jalan)
Memicu penyiraman instan di luar jadwal reguler.
* **Endpoint**: `POST /api/schedule/:deviceId/now`
* **Body Request** (Opsional):
  ```json
  { "duration_s": 30 }
  ```
* **Respons Sukses (200)**:
  ```json
  { "message": "Siram manual 30s dijadwalkan" }
  ```

#### 6. Hentikan Pompa Secara Paksa
Segera mengirimkan sinyal relay `OFF` via MQTT untuk mematikan pompa secara langsung.
* **Endpoint**: `POST /api/schedule/:deviceId/stop`
* **Respons Sukses (200)**:
  ```json
  { "message": "Pompa dimatikan" }
  ```

---

### ⚙️ Mode Operasi Perangkat

ESP32 mendukung 3 mode operasi utama:
* `auto`: Pompa dikendalikan secara otomatis berdasarkan data sensor SHT31.
* `manual`: Logika otomatis dimatikan, kontrol pompa sepenuhnya diatur manual lewat API/Aplikasi.
* `offline`: Mode darurat jika terputus dari jaringan cloud (logika auto berjalan mandiri di hardware lokal tanpa mempublikasikan data MQTT).

#### 1. Ambil Mode Kerja Aktif
* **Endpoint**: `GET /api/mode/:deviceId`
* **Respons Sukses (200)**:
  ```json
  {
      "device_id": "esp32-01",
      "current_mode": "auto",
      "is_online": true,
      "last_seen": "2026-05-24T10:00:00Z"
  }
  ```

#### 2. Ubah Mode Kerja
Mengirim perintah ganti mode ke hardware via MQTT dan menyimpan perubahannya di database.
* **Endpoint**: `POST /api/mode/:deviceId`
* **Body Request**:
  ```json
  { "mode": "manual" }
  ```
* **Respons Sukses (200)**:
  ```json
  {
      "message": "Mode berhasil diubah ke manual",
      "mode": "manual",
      "changed": true
  }
  ```

---

### 📊 Riwayat Sensor & Tren Kondisi

#### 1. Ambil Log Sensor Terbaru
Mengambil log real-time sensor terbaru (termasuk filter in-memory deadband).
* **Endpoint**: `GET /api/history/:deviceId?limit=100`
* **Respons Sukses (200)**:
  ```json
  [
      {
          "temperature": 28.5,
          "humidity": 82.3,
          "relay_state": false,
          "mode": "auto",
          "created_at": "2026-05-24T10:15:00Z"
      }
  ]
  ```

#### 2. Ambil Rata-rata Sensor Harian (RPC get_daily_average)
Untuk visualisasi grafik jangka panjang di aplikasi Flutter.
* **Endpoint**: `GET /api/history/:deviceId/daily?days=7`
* **Respons Sukses (200)**:
  ```json
  [
      {
          "day": "2026-05-24",
          "avg_temp": 28.1,
          "avg_hum": 83.4
      }
  ]
  ```

#### 3. Ambil Rata-rata Sensor Per Jam (RPC get_hourly_average)
Untuk visualisasi grafik analitis jangka menengah/harian.
* **Endpoint**: `GET /api/history/:deviceId/hourly?days=7`
* **Respons Sukses (200)**:
  ```json
  [
      {
          "hour": "2026-05-24T10:00:00.000Z",
          "avg_temp": 28.5,
          "avg_hum": 82.9
      }
  ]
  ```

---

## 📡 MQTT Topics

Sistem komunikasi backend dan ESP32 menggunakan protokol MQTT over TLS (mqtts) di port 8883.

| Topic | Arah | Payload | Keterangan |
|---|---|---|---|
| `sensor/sht31` | ESP32 → Backend | `{"device_id":"esp32-01","temp":28.5,"hum":82.3,"mode":"auto","relay":false}` | Laporan status sensor & hardware berkala |
| `config/threshold/{deviceId}` | Backend → ESP32 | `{"temp":31.5,"hum":85.0}` | Sinkronisasi perubahan threshold sensor |
| `cmd/relay/{deviceId}` | Backend → ESP32 | `"ON"` atau `"OFF"` | Perintah langsung kontrol relay pompa |
| `cmd/mode/{deviceId}` | Backend → ESP32 | `"auto"`, `"manual"`, atau `"offline"` | Perintah langsung untuk mengubah mode operasi |

---

## 🔁 Antrian Kerja (BullMQ) & Recovery Sistem

Sistem penjadwalan dikelola secara hybrid menggunakan **BullMQ** dan **Supabase**. Hal ini memecahkan masalah hilangnya repeatable job jika server mengalami restart/deployment ulang.

### Alur Kerja BullMQ Worker
1. Job repeatable terpicu sesuai jadwal *cron* atau instan dari trigger siram manual.
2. Worker BullMQ mengambil job dari Redis:
   - Mengirim perintah relay `ON` ke ESP32 via MQTT.
   - Mengirimkan push notification "Penyiraman Dimulai" via OneSignal ke pemilik alat.
   - Menahan eksekusi (*non-blocking sleep*) selama durasi siram `duration_s`.
   - Mengirim perintah relay `OFF` ke ESP32 via MQTT saat durasi berakhir.

### Alur Recovery (Schedule Restore)
Saat server pertama kali menyala (atau setelah failover berpindah ke aktif):
1. Menghapus semua job antrian lama di Redis demi mencegah tumpang tindih.
2. Membaca semua data jadwal yang aktif (`is_active = true`) di tabel Supabase.
3. Mendaftarkan ulang job ke Redis menggunakan pustaka terbaru **BullMQ v5+** (menggunakan format parameter `cron`).

---

## 📁 Struktur Folder

```
backend-jamur/
├── src/
│   ├── index.js              # Entry point utama, Express & rate limit setup
│   ├── jobs/
│   │   └── offlineDetector.js# Background job pemeriksa status online perangkat
│   ├── mqtt/
│   │   └── mqttClient.js     # Koneksi HiveMQ, subscriber sensor, & publisher command
│   ├── queues/
│   │   ├── irrigationQueue.js# Inisialisasi antrian BullMQ & koneksi Redis Upstash
│   │   ├── irrigationWorker.js# Worker pengeksekusi siklus pompa ON -> DELAY -> OFF
│   │   └── scheduleRestore.js# Pemulihan otomatis jadwal aktif dari database saat startup
│   ├── routes/
│   │   ├── device.js         # API endpoint klaim & info perangkat
│   │   ├── history.js        # API endpoint riwayat & agregasi sensor (daily/hourly)
│   │   ├── mode.js           # API endpoint kontrol mode kerja ESP32
│   │   ├── schedule.js       # API endpoint CRUD jadwal & trigger pompa manual
│   │   └── threshold.js      # API endpoint pembacaan & modifikasi batas sensor
│   ├── supabase/
│   │   └── client.js         # Setup Supabase JS client (Service Role authorization)
│   └── utils/
│       ├── failoverManager.js# Pengelola status failover (Primary ↔ Backup Standby)
│       └── notification.js   # Pengirim OneSignal Push Notification + Cooldown redis
├── .env                      # File konfigurasi privat (lokal)
├── .gitignore                # Daftar file terabaikan dari Git
├── package.json              # Daftar pustaka dependencies & scripts npm
└── package-lock.json         # Lock file dependencies
```

---

## 📦 Dependensi Utama

Detail library penting yang digunakan pada proyek ini:

```json
"dependencies": {
  "@supabase/supabase-js": "^2.101.1",
  "bullmq": "^5.73.0",
  "dotenv": "^17.4.1",
  "express": "^5.2.1",
  "express-rate-limit": "^8.3.2",
  "ioredis": "^5.10.1",
  "mqtt": "^5.15.1"
}
```
