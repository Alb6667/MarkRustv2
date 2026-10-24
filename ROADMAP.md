# Roadmap MarkRust

Tanggal acuan: 24 Oktober 2026. Roadmap ini berurutan menurut risiko, bukan
janji tanggal rilis. Selesaikan kriteria keluar tiap tahap sebelum melanjutkan.

## Titik awal

MarkRust sudah memiliki editor WYSIWYG/Markdown, operasi berkas native,
shortcut/menu, pemblokiran gambar remote berbasis izin, dan recovery otomatis
ke disk (5 versi, fallback dari snapshot rusak). Browser memakai localStorage.

Verifikasi pada commit `bf4b3c4`: 138 tes JavaScript lulus; build dan tes recovery
Rust lulus di CI Linux, Windows, macOS. Ini belum merupakan verifikasi manual
webview native atau installer. Posisi produk: kandidat uji desktop internal,
belum siap rilis publik.

## M1 — Integritas recovery dan lifecycle (prioritas kritis)

**Tujuan:** satu instance/dokumen tidak menghapus cadangan milik yang lain.

Pekerjaan:
- Tentukan identitas sesi/dokumen recovery; simpan versi per identitas.
- Pisahkan lifecycle simpan, buang, dan pemulihan; hapus hanya recovery terkait.
- Atur deteksi sesi aktif/stale tanpa menganggap snapshot instance lain sebagai
  sisa crash. Tentukan penanganan lock basi setelah crash.
- Batasi retensi per dokumen serta total disk; jangan memangkas draf aktif
  secara diam-diam. Tetap tampilkan kegagalan tulis dan cleanup.
- Uji dua instance secara bersamaan, tabrakan operasi, crash/restart, draf
  kosong, kuota/disk penuh, dan snapshot rusak.

**Kriteria keluar:** dua instance dapat mengedit dan menyimpan dokumen berbeda
secara bersamaan tanpa saling membersihkan recovery; setelah salah satunya
crash, drafnya tetap dapat dipulihkan. Draf aktif tidak hilang akibat pruning.

**Bukan cakupan:** recent files atau autosave ke berkas asli.

## M2 — Validasi desktop nyata (prioritas tinggi; bergantung M1)

**Tujuan:** membuktikan perilaku runtime, bukan hanya build/tes mock.

Pekerjaan:
- Buat checklist manual Linux, Windows, macOS dengan versi OS dan commit uji.
- Uji Baru/Buka/Simpan/Simpan Sebagai, path Unicode/spasi, file read-only,
  kegagalan tulis, dan berkas mendekati batas ukuran.
- Uji close/X, Alt+F4, Cmd+Q/Dock Quit, simpan batal/gagal, dan permintaan
  tutup berulang. Audit permission dan kegagalan registrasi listener native.
- Uji ketikan selama dialog/write tertunda, pergantian dokumen, force-quit,
  restart, serta migrasi draf localStorage.
- Catat hasil pass/fail/belum diuji dan perbaiki semua kegagalan kehilangan data.

**Kriteria keluar:** alur kritis lulus pada ketiga OS dengan bukti uji native;
tidak ada blocker kehilangan data yang diketahui. Build CI saja tidak cukup.

## M3 — Privasi gambar ditegakkan lintas lapisan (prioritas tinggi)

**Tujuan:** hilangkan izin gambar jaringan langsung dari CSP tanpa membuka
HTTP client umum ke webview.

Pekerjaan:
- Rancang perintah unduh gambar terbatas dengan persetujuan eksplisit pengguna.
- Validasi skema/host/port, DNS dan IP tujuan, termasuk setiap redirect; blokir
  loopback, alamat privat/link-local, IPv6 ekuivalen, serta DNS rebinding.
- Batasi waktu, redirect, ukuran respons secara streaming, dan jumlah request.
- Validasi tipe serta konten gambar; tentukan format aman (jangan menganggap
  semua `image/*`, khususnya SVG, otomatis aman). Jangan kirim cookie/kredensial.
- Sajikan hasil sebagai sumber lokal/data yang aman; URL Markdown asli tetap
  dipertahankan. Hapus `https:` dari `img-src` setelah jalur ini berfungsi.
- Uji Markdown/HTML berbahaya, clipboard, protocol-relative URL, redirect ke
  jaringan privat, dan nol request sebelum izin memakai browser/webview nyata.

**Kriteria keluar:** dokumen tak dipercaya tidak dapat memicu request gambar
langsung; pemuatan berizin tetap berfungsi; round-trip URL/alt terjaga;
request privat ditolak, termasuk setelah redirect/DNS resolution.

**Catatan:** M3 dapat dikerjakan setelah fondasi M1 stabil, tetapi harus selesai
sebelum mengklaim privasi jaringan yang ditegakkan oleh CSP.

## M4 — Build reproducible dan kesiapan distribusi

**Tujuan:** orang lain dapat membangun dan memasang versi yang sama.

Pekerjaan:
- Perbarui dan commit Cargo.lock, kemudian aktifkan build/test `--locked` di CI.
- Audit dependency, izin Tauri, dan kebijakan penyertaan komponen vendor.
- Pemilik proyek memilih lisensi; tambahkan LICENSE dan pemberitahuan vendor.
- Buat kandidat bundel, uji install/launch/upgrade/uninstall di tiga OS; verifikasi
  apakah recovery/data pengguna tetap dipertahankan sesuai kebijakan.
- Tentukan signing/notarization, keterbatasan platform, dan kanal distribusi.
- Buat release notes, known issues, serta langkah pemulihan dan rollback.

**Kriteria keluar:** dependency terkunci; lisensi jelas; kandidat installer
teruji; status signing dan batasan distribusi dinyatakan secara terbuka.

## M5 — Beta terbatas dan gerbang rilis

**Tujuan:** memperoleh bukti dari pemakaian nyata sebelum rilis publik.

Pekerjaan:
- Rilis kandidat kepada kelompok penguji kecil dengan checklist dan format bug.
- Uji dokumen nyata dan batas konversi Markdown; prioritaskan kehilangan data,
  akses filesystem, kebocoran jaringan, dan recovery sebelum polish UI.
- Triase bug menurut dampak; dokumentasikan batasan yang diterima.

**Kriteria keluar:** M1–M4 selesai; tidak ada blocker data/security terbuka;
masalah mayor sudah diperbaiki atau cakupan berisiko dinonaktifkan; bukti uji,
known issues, dan catatan rilis tersedia. Beta tidak otomatis berarti stabil.

## Setelah fondasi stabil (bukan syarat rilis pertama)

1. **Autosave berkas asli, opt-in:** hanya pada path yang sudah dipilih; deteksi
   perubahan eksternal sebelum overwrite, UI konflik, backup/recovery tetap ada.
2. **Pemilih versi recovery:** tampilkan waktu/dokumen dan pratinjau sebelum
   restore; jangan menimpa tulisan aktif tanpa konfirmasi.
3. **Recent files:** tangani path hilang/berpindah dan privasi daftar berkas.
4. **Polish editor:** aksesibilitas keyboard/fokus, dokumen besar, font/lebar,
   tema, dan perbaikan fidelity konversi berdasarkan kasus nyata.

## Prinsip pelaksanaan

- Satu milestone per putaran; perubahan kecil dengan tes regresi untuk bug.
- Laporkan terpisah: tes otomatis, build CI, uji runtime native, uji installer.
- Jangan klaim nol kehilangan data atau keamanan total; nyatakan batasnya.
- Jangan autosave menimpa berkas asli tanpa persetujuan dan kontrol konflik.
- Evaluasi ulang prioritas bila pengujian menemukan risiko data/security baru.
- Update roadmap berdasarkan hasil, bukan menambahkan fitur sebelum gerbang
  tahap sebelumnya terpenuhi.

## Catatan pelaksanaan M1

- M1a diimplementasikan: direktori sesi + lock eksklusif OS, adopsi sesi
  terbengkalai setelah lock terlepas, dan perlindungan recovery v1 dengan lock.
- Belum menutup seluruh M1: batas disk global, pemilihan beberapa recovery,
  serta bukti pengujian dua proses desktop nyata masih diperlukan.
