/**
 * =============================================================================
 * SUPABASE CLIENT
 * =============================================================================
 * File ini punya satu tugas: bikin "jembatan" koneksi ke database Supabase.
 *
 * Kenapa pakai Service Key, bukan Anon Key?
 * - Anon Key dipakai di sisi client (Flutter/browser), aksesnya terbatas oleh
 *   Row Level Security (RLS).
 * - Service Key dipakai di sisi backend (server ini), karena punya akses
 *   penuh tanpa dibatasi RLS. Makanya JANGAN PERNAH bocorkan key ini ke publik!
 *
 * Cara pakainya: cukup import file ini dari mana saja di proyek ini.
 * Contoh: const supabase = require('../supabase/client')
 * =============================================================================
 */

const { createClient } = require('@supabase/supabase-js')

// Inisialisasi koneksi ke Supabase menggunakan URL dan Service Key
// yang diambil dari file .env (supaya tidak hardcode di kode)
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY  // pakai service key di backend, bukan anon key
)

module.exports = supabase