# Ringkasan Perubahan — Hapus Ketergantungan Redis

Tujuan: menurunkan biaya hosting drastis dengan menghapus kebutuhan Redis dan
server cadangan, karena kebutuhan mitra cuma kontrol on/off pompa + jadwal.

## File yang dihapus
- `src/queues/irrigationQueue.js` — koneksi BullMQ Queue ke Redis
- `src/queues/irrigationWorker.js` — koneksi BullMQ Worker ke Redis
- `src/queues/scheduleRestore.js` — digabung ke scheduler baru
- `src/utils/failoverManager.js` — logika dual-server (ping tiap 10 detik)
- `src/routes/latency.js` — endpoint test latency, tidak dipakai app
- `test-latency.js` — script test latency, tidak dipakai app

## File baru
- `src/scheduler/irrigationScheduler.js` — pengganti BullMQ, jadwal disimpan
  di memori pakai `node-cron`. Fungsi: `registerSchedule`, `unregisterSchedule`,
  `runIrrigationNow`, `restoreSchedules`.

## File yang diubah
- `package.json` — hapus `bullmq` & `ioredis`, tambah `node-cron`
- `src/index.js` — hapus `initFailover()`, langsung `connect()` +
  `restoreSchedules()` + `startOfflineDetector()`. Hapus registrasi route
  `/api/latency`. `trust proxy` disederhanakan jadi selalu 1 layer.
- `src/routes/schedule.js` — semua pemanggilan `irrigationQueue` diganti ke
  `scheduler.registerSchedule` / `unregisterSchedule` / `runIrrigationNow`
- `src/routes/mode.js` — hapus mode `offline` dari whitelist & label
- `src/mqtt/mqttClient.js` — hapus fitur ping latency (`measureLatency`,
  topic `latency/test/ping`, `pendingPings` Map)
- `src/utils/notification.js` — hapus koneksi Redis, cooldown anti-spam
  sekarang selalu pakai in-memory Map

## Environment variable yang SUDAH TIDAK DIPAKAI (boleh dihapus dari Railway)
- `REDIS_URL`
- `IS_BACKUP_SERVER`
- `PRIMARY_SERVER_URL`
- `FAILOVER_PING_INTERVAL_MS`

## Yang perlu kamu lakukan setelah pull perubahan ini
1. Hapus 4 environment variable di atas dari Railway (opsional, tidak wajib
   dihapus tapi sudah tidak berpengaruh)
2. Kalau masih ada server backup di VPS, matikan (stop process PM2-nya) —
   sekarang cukup 1 server di Railway
3. Kalau masih pakai Redis (Upstash dll), boleh dihapus/unsubscribe setelah
   yakin deploy baru ini jalan normal beberapa hari
4. Test alur: buat jadwal baru → cek pompa nyala tepat waktu → toggle
   nonaktifkan jadwal → cek pompa tidak nyala lagi → siram manual via `/now`

## Trade-off yang perlu diketahui
Jadwal sekarang hidup di memori aplikasi (bukan di Redis). Kalau server
restart PAS DI DETIK jadwal seharusnya jalan, siraman itu bisa terlewat
sekali. Begitu server hidup lagi, jadwal otomatis dipulihkan dari Supabase
lewat `restoreSchedules()` dan lanjut jalan normal untuk jadwal berikutnya.
