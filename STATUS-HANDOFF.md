# Laporan status & handoff MarkRust

Tanggal: 24 Oktober 2026. Branch: `arena/bcbf3e21-markrust`.
Dokumen ini adalah titik masuk untuk melanjutkan pekerjaan; baca bersama
[ROADMAP.md](ROADMAP.md) dan [DESKTOP-TEST-CHECKLIST.md](DESKTOP-TEST-CHECKLIST.md).

## Ringkasan jujur

Editor dan recovery native sudah diimplementasikan. M1a–M1c memiliki tes otomatis
serta build/test CI lintas OS yang hijau pada commit `0ecfd7a`. Audit lifecycle
lanjutan menambah pengaman operasi async dan membawa jumlah tes JS menjadi
**144 lulus**. CI audit `40074055940` pada commit `b931d22` juga lulus: Node serta
build/test Rust Linux, Windows, macOS.

**Belum siap dinyatakan rilis publik. M1 belum ditutup secara keseluruhan, M2
belum dijalankan di webview desktop nyata.** Jangan menyamakan build CI dengan
uji GUI, installer, atau jaminan tidak kehilangan data.

## Sudah selesai di kode

| Area | Hasil |
|---|---|
| Fondasi | Modul konversi/statistik murni, CSS terpisah, round-trip Quill asli di jsdom, CI |
| UI | Status bar, dirty/path/title, dialog gambar in-app, toolbar diperbaiki |
| Berkas | Baru/Buka/Simpan/Simpan Sebagai, menu native, shortcut, browser fallback |
| Integritas simpan | Snapshot revisi/generasi, simpan paralel ditolak, ketikan saat write tertunda tidak dibersihkan |
| Recovery | Disk native, 5 snapshot, fallback versi rusak, draf kosong, migrasi lokal, browser localStorage |
| Jadwal backup | Debounce 700 ms, batas tunggu 3 detik, flush sebelum close/pagehide/visibility hidden |
| Kegagalan backup | Indikator terlihat, sebab native pada tooltip; close tanpa simpan ditahan bila backup gagal |
| M1a | Direktori sesi dan lock OS eksklusif; sesi aktif dilewati; crash melepas lock |
| M1b | Batas penerimaan total 256 MiB, termasuk v1/temp; lock quota lintas proses; tidak menghapus sesi lain |
| M1c | Pemilih recovery startup bila lebih dari satu; path/waktu, batal tanpa hapus, lock diperiksa ulang |
| Gambar | Placeholder + URL asli tetap di model, izin per dokumen, sanitasi HTML, tombol pemuatan eksplisit |
| Audit tambahan | Baru/Buka/drop memeriksa revisi setelah await; restore menolak dokumen kotor |

## Hasil audit lifecycle terakhir

Diperbaiki:
- Buka yang tertunda tidak boleh menimpa ketikan atau dokumen pengganti.
- Konfirmasi Baru yang tertunda tidak boleh membuang suntingan setelah dialog dimulai.
- Drop memeriksa generasi/revisi sebelum dan sesudah konfirmasi.
- Pemulihan tidak boleh berjalan di atas dokumen kotor.

Tes baru secara langsung meliputi open tertunda, konfirmasi Baru tertunda, dan
restore pada dokumen kotor. Guard drop telah dipasang tetapi race drop belum
memiliki tes otomatis tersendiri; masukkan ke uji F07.

## Verifikasi yang tersedia

- Lokal: `npm test` → **144 tests, 144 pass, 0 fail**.
- Tidak ada toolchain Rust lokal; Rust diverifikasi lewat GitHub Actions.
- CI M1c `40073225635`, commit `0ecfd7a`: Node + build/test Rust Linux,
  Windows, macOS lulus. Bundel rilis tidak berjalan pada push biasa.
- Tes Rust recovery meliputi retensi/fallback rusak, isolasi sesi, quota,
  validasi ID, dan proses anak yang di-kill kemudian recovery diambil kembali.
- Tes subprocess bukan tes dua GUI desktop. Status native manual seluruhnya
  **BELUM DIUJI** sampai bukti checklist diisi.

## Belum selesai / risiko terbuka (urutan lanjutan)

### 1. Gerbang M1/M2: validasi lifecycle native

Jalankan checklist tiga OS. Audit khusus registrasi close listener, permission,
close berulang, Cmd+Q, error IPC, dan dialog yang dibatalkan. Tidak ada bukti
runtime native dalam sesi sandbox ini. Jangan menandai M1/M2 selesai dulu.

### 2. Lifecycle recovery yang masih terbatas

- Sesi recovery per proses, bukan registry beberapa dokumen per sesi.
- Save/konfirmasi buang/ganti dokumen membersihkan recovery aktif; tidak ada UI
  memilih versi snapshot manual atau hapus massal stale sessions.
- Semua snapshot rusak tidak ditampilkan di picker; file tetap dipertahankan,
  tetapi pengguna belum mendapat workflow inspeksi/perbaikan khusus.
- Memilih Nanti saja mempertahankan snapshot saat itu; jika kemudian pengguna
  mengedit/mengganti dokumen, sesi aktif masih mengikuti kebijakan lifecycle
  yang ada. Belum ada pemisahan eksplisit "arsip ditunda" vs sesi edit baru.
- Snapshot global budget dihitung saat tulis; data lama yang sudah di atas
  batas tidak dipangkas paksa. Empty session dirs/temp sisa crash belum punya
  cleanup UI. Simpan berkas asli untuk mengamankan pekerjaan saat quota gagal.
- Jangan menjalankan binary sebelum protokol lock bersama versi baru.
- File sync + rename belum menjamin durability direktori saat listrik mati.

### 3. Privasi/CSP (M3, prioritas tinggi)

`img-src` masih mengizinkan `https:`; pertahanan sekarang di aplikasi, bukan
CSP penuh. Jangan mengklaim nol request hanya dari tes DOM jsdom. Audit dengan
network inspector pada Markdown dan clipboard asli. Khususnya periksa urutan
pembuatan blot (`super.create(value)` dapat menyetel URL asli sebelum placeholder)
dan parsing HTML sementara. Jika fetch teramati, perlakukan sebagai blocker.

Desain lanjutan: downloader native terbatas dengan validasi skema/DNS/IP,
redirect, ukuran/timeouts, format gambar aman; tidak membuka HTTP client umum
ke webview. Baru setelah itu hapus https dari CSP.

### 4. Build/distribusi (M4)

Cargo.lock belum diselaraskan dengan dependency baru secara lokal (dialog,
serde_json, fs2). CI build tanpa --locked menyelesaikan dependency dan menyimpan
artifact cargo-lock. Perbarui lockfile lalu gunakan --locked setelah diperoleh.
Download artifact sandbox pernah terhalang host blob GitHub. Jangan edit lock
manual atau mengklaim build reproducible sebelum ini beres.

LICENSE proyek belum dipilih pemilik; tidak boleh dipilih atas namanya.
Installer, signing/notarization, upgrade/uninstall, kebijakan data belum diuji.

### 5. Sesudah fondasi stabil

Autosave berkas asli masih belum ada: harus opt-in, deteksi perubahan eksternal,
UI konflik, dan tetap memiliki backup. Recent files, pemilih versi, aksesibilitas,
performa dokumen besar dan tema adalah pekerjaan lanjutan, bukan alasan menunda
perbaikan blocker data/security.

## Peta berkas untuk melanjutkan

- `ui/app.js`: generasi/revisi, async operasi berkas, dirty, recovery, close/drop.
- `ui/core/recovery.js`: antrean IPC recovery; kegagalan tidak memutus antrean.
- `ui/core/recovery-picker.js`: dialog pemilih; label via textContent.
- `ui/core/drafts.js`: fallback browser dan format waktu.
- `src-tauri/src/recovery.rs`: lock sesi, quota, retensi, scan/select, tes Rust.
- `src-tauri/src/main.rs`: custom commands, read/write dokumen, menu.
- `src-tauri/capabilities/default.json`: izin dialog/window.
- `ui/core/image-policy.js`, `quill-setup.js`, `markdown.js`: privasi/render.
- `tests/boot.test.js`: integrasi jsdom + bridge Tauri palsu, termasuk race async.
- `tests/recovery*.test.js`, `tests/images.test.js`: unit/DOM keamanan/recovery.
- `.github/workflows/ci.yml`: Node, build/test Rust matrix; bundel hanya tag.

## Cara melanjutkan

1. Pastikan branch tetap `arena/bcbf3e21-markrust`; cek `git status` dan laporan ini.
2. `npm ci && npm test` untuk baseline JS. Rust: di mesin dengan toolchain +
   dependency sistem, jalankan `cargo test --manifest-path src-tauri/Cargo.toml`.
3. Isi checklist native dengan commit/runtime yang benar. Prioritaskan FAIL
   kehilangan data/network; buat reproduksi dan tes regresi sebelum fitur baru.
4. Lanjutkan lifecycle recovery ditunda/rusak jika ditemukan masalah; lalu M3.
5. Update laporan, roadmap dan hasil verifikasi setiap tahap. Jangan mengubah
   status BELUM DIUJI menjadi PASS tanpa eksekusi dan bukti.

## Commit acuan

- `bf4b3c4`: recovery disk native.
- `3c7fa47`: M1a + koreksi lock Windows.
- `c74339b`: M1b quota + tes proses kill.
- `0ecfd7a`: M1c pemilih recovery.
- `b931d22`: audit lifecycle + checklist native dan laporan handoff; CI `40074055940` lulus.
