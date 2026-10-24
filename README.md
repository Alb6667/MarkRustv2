# MarkRust

WYSIWYG Markdown editor desktop berbasis **Rust + Tauri v2**, dengan frontend vanilla
HTML/CSS/JS (tanpa Node, tanpa bundler, tanpa framework).

Tulis dengan formatting yang langsung terlihat, lalu toggle ke raw Markdown kapan saja —
tanpa split view.

## Menjalankan

Butuh Rust toolchain dan dependensi webview sistem (lihat
[dokumentasi prasyarat Tauri](https://v2.tauri.app/start/prerequisites/)).

```bash
cargo install tauri-cli --version '^2'
cd src-tauri && cargo tauri dev
```

Build rilis:

```bash
cd src-tauri && cargo tauri build
```

Frontend bisa juga dibuka di browser (untuk inspeksi UI) dengan menyajikan folder
`ui/` secara statis — `app.js` kini ES module, jadi **harus lewat HTTP**, bukan
`file://`:

```bash
cd ui && python3 -m http.server 8080   # lalu buka http://localhost:8080
```

Seluruh library sudah di-vendoring, jadi tetap tidak butuh internet saat runtime.

## Struktur

```
ui/
  index.html        markup saja (tanpa CSS inline)
  app.css           seluruh tema & gaya editor
  app.js            logika UI: inisialisasi Quill, toolbar, mode, status bar
  core/
    serialize.js    Delta Quill -> Markdown (murni, tanpa DOM/Quill instance)
    markdown.js     Markdown -> HTML untuk Quill + statistik dokumen
    quill-setup.js  registrasi blot <hr> & matcher clipboard (dipakai app + tes)
  files.js        I/O dokumen: dialog Tauri + fallback browser
  drafts.js       penyimpanan & pemulihan draf (murni, storage di-inject)
  image-policy.js allow-list gambar jarak jauh per dokumen
  vendor/           library pihak ketiga (lokal, offline-ready)
tests/
  harness.js        jsdom + Quill/marked hasil vendoring (bukan mock)
  *.test.js         unit + round-trip sungguhan + smoke test boot aplikasi
.github/workflows/  CI: tes Node + build Rust di Linux/Windows/macOS
src-tauri/
  src/main.rs       shell Tauri + perintah berkas + menu native
  tauri.conf.json   konfigurasi aplikasi
  capabilities/     izin IPC (ACL) untuk jendela utama
  icons/            ikon desktop saja (mobile belum didukung)
  gen/schemas/      DI-GENERATE saat build — tidak di-commit
```

Modul `ui/core/` sengaja **murni** (tidak menyentuh `window`, tidak menyimpan
instance Quill). `serializeLines()` menerima array deskriptor baris biasa,
sehingga seluruh logika konversi bisa diuji tanpa browser. `linesFromQuill()`
adalah satu-satunya jembatan ke objek Quill nyata.

> **Catatan tooling:** `package.json` di root **hanya untuk dev/test**.
> Runtime aplikasi tetap tanpa Node, tanpa bundler, tanpa framework.

## Pengujian

```bash
npm ci
npm test
```

Tes berjalan di `node:test` + jsdom dan menggunakan berkas `ui/vendor/` yang
**sama** dengan yang dikirim ke webview — jadi round-trip yang diuji bukan
tiruan. Cakupan: heading, indentasi & bahasa code block, fence backtick
bersarang, list campuran bernomor, task list, alignment tabel, garis pemisah,
tautan/gambar, warna, underline, escape teks, penolakan injeksi CSS/URL,
idempotensi serialisasi, paritas jumlah kata lintas mode, dan smoke test yang
memuat `index.html` + `app.js` sungguhan untuk menjaga wiring DOM tetap utuh.

Beberapa perilaku yang sengaja didokumentasikan sebagai **batasan yang diketahui**
(diuji supaya perubahannya ketahuan): soft line break melebur jadi spasi sesuai
CommonMark, hard break di paragraf biasa berubah jadi dua paragraf, dan raw HTML
kehilangan tag pembungkusnya.

## Keputusan UI

- **Status bar selalu tampil** (mode, indikator belum disimpan, jumlah kata &
  karakter, peringatan gambar jarak jauh). Widget jumlah kata yang mengambang
  dan memudar sendiri sudah dihapus — informasinya jadi tidak terbaca.
- **Toolbar tampil secara default.** Auto-hide tetap tersedia lewat tombol pin,
  dan tidak pernah menyembunyikan diri saat ada teks terseleksi.
- **Tanpa region-drag kustom.** `decorations: true` sudah memberi title bar
  native; CSS lama tidak bekerja di Linux/WebKitGTK.
- **Dialog gambar memakai `<dialog>` native**, bukan `window.prompt` yang tidak
  reliabel di WKWebView/Tauri. Hanya `http://` dan `https://` yang diterima.
- **Konfigurasi toolbar Quill dikirim sebagai array**, lalu handler gambar
  dipasang via `addHandler()`. Bentuk `{ container, handlers }` bergantung pada
  pemeriksaan internal `constructor !== Object` yang rapuh lintas realm.

### Privasi gambar jarak jauh

Membuka dokumen Markdown dari pihak lain **tidak lagi** memicu permintaan
jaringan. Sebelumnya CSP mengizinkan `img-src https:`, sehingga setiap
`![gambar](https://…)` langsung menjadi *tracking beacon* yang melapor ke
server si pengirim berkas.

Pemblokiran dilakukan berlapis, karena satu titik saja tidak cukup:

1. **Normalisasi HTML (utama).** Sebelum HTML diserahkan ke Quill, URL `src`
   gambar dipindah ke atribut inert `data-mr-src` dan diganti placeholder
   `data:` lokal. Ini krusial: di Chrome, `img.src` memicu fetch **walau
   elemennya tidak pernah dipasang ke DOM**, jadi menunggu sampai tahap render
   sudah terlambat.
2. **Sanitasi vektor lain.** `srcset`, CSS `url()`, `background`, `poster`,
   `ping`, `data`, `formaction`, handler `on*`, serta elemen
   `<iframe>/<object>/<script>/<style>/<svg>/<video>/<audio>/<input type=image>`
   dibuang. CSS dibuang per-deklarasi supaya warna teks/latar tetap ikut
   round-trip.
3. **Blot gambar aman.** Menggantikan blot `image` bawaan Quill sebagai
   pengaman kedua (misalnya untuk gambar yang disisipkan lewat paste).
   `value()` membaca `data-mr-src`, sehingga **Delta dan berkas `.md` tetap
   berisi URL asli** — tidak ada data yang hilang.
4. **Allow-list per dokumen.** URL dimuat hanya setelah pengguna menekan
   tombol **"Muat gambar"** di status bar, atau saat ia menyisipkan URL itu
   sendiri lewat dialog. Izin tidak pernah di-*persist* dan otomatis direset
   setiap dokumen diganti, sehingga berkas asing berikutnya kembali aman.

**Trade-off yang perlu diketahui:** CSP masih mencantumkan `https:` pada
`img-src` — itu memang diperlukan agar pemuatan atas izin eksplisit bisa
berfungsi. Dengan demikian jaminan keamanan berada pada **lapisan aplikasi**
(sanitasi + blot + tes), bukan pada CSP. Vektor yang diketahui sudah ditutup
dan dikunci oleh tes, tetapi celah baru di masa depan tidak akan dicegah oleh
CSP. Hardening lanjutan yang lebih kuat adalah memindahkan pengunduhan gambar
ke perintah Rust dengan validasi ketat (batas ukuran, blokir alamat privat,
`Content-Type: image/*`) lalu menyajikannya sebagai `data:`/skema kustom —
dengan begitu `https:` bisa dihapus total dari CSP.

## Cara kerja konversi

| Arah | Jalur |
| --- | --- |
| Markdown → WYSIWYG | `marked` → normalisasi DOM → `quill.clipboard.dangerouslyPasteHTML()` |
| WYSIWYG → Markdown | `linesFromQuill()` → `serializeLines()` di `ui/core/serialize.js` |

Konversi balik **tidak** memakai Turndown. Quill 2 tidak memakai DOM standar — code block
adalah `<div>`, bullet list direpresentasikan sebagai `<ol data-list="bullet">`, dan warna
disimpan sebagai atribut format. Mengonversi DOM-nya akan merusak ketiganya, sehingga
serializer ini membaca **Delta** Quill langsung, yang merupakan model datanya yang sebenarnya.

Hal-hal yang dijaga saat round-trip: bahasa **dan indentasi** pada fenced code block
(spasi/tab di awal baris tidak lagi terlipat), jenis list (bullet/ordered/bersarang,
termasuk list campuran dengan penomoran yang tetap berlanjut), task list, tabel GFM
beserta alignment kolom `:---:`/`---:`, backtick di dalam inline code (fence memanjang
otomatis), tautan, gambar, warna teks dan latar, serta garis pemisah (`---`).

Catatan batasan: Quill 2 tidak menyimpan alignment rata kiri eksplisit, jadi `:---`
ditulis ulang menjadi `---` (keduanya identik secara GFM). Quill juga melepas atribut
blockquote pada baris yang sekaligus merupakan item list, sehingga list di dalam
blockquote tidak bisa dipertahankan.

## Library yang di-vendoring

| Library | Versi | Lisensi |
| --- | --- | --- |
| [Quill](https://quilljs.com/) | 2.0.3 | BSD-3-Clause |
| [marked](https://marked.js.org/) | 18.1.1 | MIT |
| [highlight.js](https://highlight.js.org/) | 11.12.0 | BSD-3-Clause |

Lihat `ui/vendor/README.md` untuk detail dan cara memperbarui.

## Berkas & pintasan

Tombol **Baru / Buka / Simpan** ada di kiri toolbar; menu native **Berkas**
tersedia pula di aplikasi desktop.

| Pintasan | Aksi |
| --- | --- |
| `Ctrl/Cmd+N` | Dokumen baru |
| `Ctrl/Cmd+O` | Buka berkas |
| `Ctrl/Cmd+S` | Simpan |
| `Ctrl/Cmd+Shift+S` | Simpan Sebagai |
| `Ctrl/Cmd+Shift+M` | Ganti mode WYSIWYG / Markdown |

Berkas `.md` juga bisa dijatuhkan langsung ke jendela. Di browser biasa
(tanpa Tauri) fitur ini otomatis memakai fallback: `<input type="file">`
untuk membuka dan unduhan Blob untuk menyimpan.

### Arsitektur I/O

Frontend **tidak** diberi akses filesystem umum. Hanya dua perintah Rust yang
menyentuh disk:

- `read_document(path)` — menolak path relatif, ekstensi selain teks/Markdown,
  dan berkas di atas 10 MB.
- `write_document(path, contents)` — menulis ke berkas sementara di direktori
  yang sama lalu `rename`, sehingga pembaca tidak pernah melihat dokumen
  setengah jadi.

Daftar ekstensi yang diizinkan dijaga tetap identik antara Rust dan JavaScript
oleh sebuah tes (`tests/files.test.js`), karena validasi terjadi di dua tempat:
perintah Rust dan handler drag-drop di frontend.

Dialog pemilih berkas memakai `tauri-plugin-dialog`. API vanilla JS tersedia
lewat `withGlobalTauri: true`, jadi tetap **tanpa bundler dan tanpa Node**
di runtime. Menu native sengaja tidak memasang accelerator: pintasan keyboard
dipusatkan di frontend agar tidak ada dobel-trigger `Ctrl+S`.

> `Cargo.lock` di repo belum mencantumkan `tauri-plugin-dialog` karena sandbox
> pengembangan ini tidak punya toolchain Rust. `cargo build` tanpa `--locked`
> akan memperbaruinya otomatis, jadi aplikasi tetap bisa dibangun. Untuk
> merapikan: buka halaman **GitHub Actions → run CI terbaru → job
> `Build Rust (ubuntu-latest)` → Artifacts → `cargo-lock`**, lalu salin isinya
> ke `src-tauri/Cargo.lock`. Atau cukup jalankan `cargo build` sekali di mesin
> lokal dan commit hasilnya.

## Keamanan tulisan: draf & konfirmasi tutup

Ada **dua lapis** pelindung, karena konfirmasi tutup saja tidak cukup —
*force quit*, crash proses, dan `Cmd+Q`/Dock Quit di macOS diketahui dapat
melewati event *close* Tauri [10](https://github.com/tauri-apps/tauri/issues/13778).

1. **Draft recovery (jaminan utama).** Saat dokumen berstatus kotor, isinya
   disimpan berkala (debounce 700 ms) ke `localStorage` webview, lalu di-*flush*
   pada `pagehide`/`beforeunload` dan sebelum dialog tutup. Saat aplikasi dibuka
   berikutnya, pengguna ditanya apakah draf itu ingin dipulihkan. Draf dihapus
   hanya setelah berkas benar-benar tersimpan, dokumen baru dibuat, berkas lain
   dibuka, atau pengguna menolak pemulihan.
2. **Konfirmasi tutup (UX).** `getCurrentWindow().onCloseRequested()` menawarkan
   "Simpan sebelum keluar?" bila ada perubahan. Bila simpan gagal, penutupan
   dicegah supaya data tidak hilang. Handler `beforeunload` hanya aktif di mode
   browser agar tidak muncul dialog ganda di atas dialog native.

Dengan begitu, memilih keluar tanpa menyimpan pun **tetap aman**: tulisannya
masih bisa dipulihkan. Catatan: `localStorage` webview punya batas ukuran
(umumnya beberapa MB); dokumen sangat besar dapat melewati batas itu, dan dalam
kasus tersebut konfirmasi tutup menjadi satu-satunya pelindung.

## Status & batasan yang diketahui

Sudah berfungsi: editing WYSIWYG, toggle Markdown, round-trip format, buka/
simpan berkas, menu native, pintasan, drag-drop, statistik dokumen, konfirmasi
tutup, pemulihan draf, dan pemblokiran gambar jarak jauh dengan izin eksplisit.

Belum / perlu diperhatikan:

- **Autosave ke berkas asli** belum ada (draf baru tersimpan di webview, bukan
  menimpa berkas `.md` yang sedang dibuka), dan belum ada daftar berkas terakhir.
- **Batas `localStorage`** berlaku untuk draf (lihat bagian di atas).
- **CSP `img-src` masih mengizinkan `https:`** demi fitur pemuatan gambar atas
  izin eksplisit (lihat *Privasi gambar jarak jauh* di atas). Pemblokiran
  otomatis sudah aktif, tetapi pertahanannya ada di lapisan aplikasi.
- **Raw HTML**, soft/hard line break, dan `:---` mengikuti batasan yang sudah
  dijelaskan di bagian konversi.
- **Lisensi proyek** belum ditentukan. Yang ada saat ini hanya lisensi
  milik library yang di-vendoring; pilih lisensi untuk kode MarkRust sendiri
  sebelum dirilis ke publik.

### Perbaikan integritas draf & simpan

- Setiap suntingan pengguna menjadwalkan ulang cadangan draf, bukan hanya
  suntingan pertama setelah dokumen bersih. Debounce tetap 700 ms; crash sebelum
  timer berjalan masih dapat kehilangan ketikan paling akhir.
- Draf kosong tetap valid: menghapus semua isi merupakan perubahan yang perlu
  bisa dipulihkan.
- Simpan memakai snapshot dokumen dan revisi. Ketikan saat dialog/penulisan
  berlangsung tetap ditandai belum tersimpan dan dicadangkan; hasil simpan
  dokumen lama tidak mengubah path/status dokumen penggantinya.
- Operasi simpan paralel ditolak agar tidak berebut berkas sementara.
  Ini bukan autosave ke berkas asli; `Ctrl/Cmd+S` tetap diperlukan.

### Bila cadangan tidak tersedia

Cadangan memakai jeda 700 ms setelah suntingan terakhir, dengan batas tunggu
3 detik selama mengetik berkelanjutan (timer dapat ditunda oleh sistem/browser).
Saat halaman disembunyikan, aplikasi juga mencoba menulis draf segera.

Jika localStorage penuh/diblokir, status bar menampilkan **Cadangan gagal —
simpan berkas sekarang**. Penutupan native melalui handler yang terdaftar
akan ditahan bila pengguna memilih tidak menyimpan dan pencadangan gagal.
Pengguna perlu menyimpan berkas atau memperbaiki storage lalu mencoba lagi.
Ini bukan jaminan terhadap force-quit, crash, atau matinya perangkat; data yang
belum tercadangkan tetap berisiko hilang. Storage webview bukan backup permanen.

## Recovery disk native (desktop)

Desktop kini menggunakan `<app_data_dir>/recovery-v1/`, bukan localStorage,
sebagai cadangan utama. Lokasi ditentukan Tauri untuk OS pengguna; frontend
**tidak dapat memilih path recovery**. Perintah terbatas: `write_recovery`,
`read_recovery`, `clear_recovery`. Dokumen Tanpa Judul juga dicadangkan.

- Maksimum payload JSON 12 MB; maksimum **5 versi** terakhir untuk editor
  satu-dokumen ini. Ini bukan daftar cadangan per berkas atau recent files.
- Snapshot ditulis ke nama sementara unik, `sync_all`, lalu rename ke nama
  final baru. Versi lama dipangkas hanya sesudah penulisan berhasil.
- Saat startup, versi valid terbaru ditawarkan. Jika versi terbaru rusak,
  pembaca mencoba versi sebelumnya; belum ada UI untuk memilih versi manual.
- Simpan berhasil / buang / ganti dokumen menghapus riwayat recovery aktif.
  Tulisan asli tidak ditimpa otomatis. Cadangan berisi teks biasa (tidak
  terenkripsi); pada Unix file baru memakai izin 0600.
- Browser biasa tetap memakai localStorage. Draf localStorage dari versi lama
  ditawarkan jika belum ada recovery disk (migrasi).
- Cadangan bukan jaminan nol kehilangan data: timer, disk penuh, force-quit,
  kerusakan disk, dan durability direktori saat listrik mati tetap batas nyata.
  Jangan membuka beberapa instance MarkRust sekaligus: direktori recovery
  masih dibagi antar-instance, belum memiliki isolasi sesi lintas proses.

## Roadmap pengembangan

Lihat [ROADMAP.md](ROADMAP.md) untuk urutan prioritas, cakupan, dan kriteria
kelulusan tiap tahap menuju rilis publik.

### M1a — Isolasi recovery antar-instance

Recovery baru berada di `recovery-v2/session-<id>/`. Setiap proses memegang
lock eksklusif OS pada `session.lock` sepanjang hidupnya. Pembacaan, pruning,
dan penghapusan hanya berlaku pada sesi yang dimiliki proses tersebut. Sesi
aktif milik proses lain dilewati; setelah crash, OS melepas lock sehingga
satu proses berikutnya dapat mengambil recovery itu. Jika ada beberapa sesi
terbengkalai, hanya satu diambil; sisanya dipertahankan.

Draf `recovery-v1` lama dapat diambil dengan lock yang sama bila tidak ada
recovery v2 yang diambil. Jangan menjalankan binary lama dan baru bersamaan:
binary lama belum mengikuti protokol lock ini.

Batas M1a: retensi masih 5 snapshot per sesi; belum ada batas disk global atau
UI pemilih sesi terbengkalai. Dokumen yang sengaja diganti setelah konfirmasi
masih membuang recovery sesi aktif. Pengujian dua proses desktop nyata tetap
menjadi gerbang M1/M2; unit test lock bukan pengganti uji runtime tersebut.

### M1b — Anggaran disk recovery

Recovery memiliki batas total **256 MiB** (v1 + semua sesi v2, termasuk berkas
sementara tertinggal). Pengecekan dan penulisan diserialkan dengan lock OS
`recovery-budget.lock` antar-proses. Ruang untuk snapshot baru harus tersedia
sebelum versi lama sesi sendiri dipangkas. Karena itu, batas bisa menolak
snapshot walau pemangkasan setelah penulisan nantinya akan menghemat ruang.

Saat batas tercapai, cadangan baru ditolak dan indikator kegagalan ditampilkan;
penyebab native tersedia di tooltip. **Tidak ada penghapusan otomatis recovery
sesi lain**, termasuk sesi crash. Simpan berkas asli untuk mengamankan pekerjaan;
riwayat sesi itu kemudian dibersihkan oleh alur simpan yang sudah ada. Ini batas
penerimaan snapshot, bukan pembersih disk paksa: data lama di atas batas tidak
dihapus otomatis. Penulis versi lama yang tidak memakai lock anggaran tidak
mengikuti batas ini.

Tes Rust kini menjalankan proses anak nyata: sesi aktif dilewati, proses anak
dihentikan paksa, lalu lock dan cadangannya dapat diambil kembali. Ini menguji
filesystem/process, bukan dialog atau lifecycle webview desktop.

### M1c — Pemilih recovery saat startup

Jika beberapa recovery tersedia, dialog startup menampilkan path/nama dokumen
serta waktu snapshot. Pilih satu untuk melanjutkan konfirmasi pemulihan;
**Nanti saja** menutup pemilih tanpa menghapus snapshot. Sesi lain yang tidak
dipilih tetap disimpan. Pemilih belum menyediakan hapus massal atau pemilihan
versi snapshot manual.

Daftar hanya menyertakan sesi milik instance ini atau sesi yang lock-nya dapat
diambil. Lock diperiksa ulang saat memilih, karena instance lain mungkin sudah
mengambil sesi sejak daftar ditampilkan. ID recovery dibatasi ke nama sesi,
bukan path filesystem dari frontend. Recovery yang seluruh snapshot-nya rusak
tidak ditampilkan dalam daftar ini dan tidak dihapus.

## Laporan untuk melanjutkan pekerjaan

Baca [STATUS-HANDOFF.md](STATUS-HANDOFF.md) untuk status implementasi,
verifikasi, risiko terbuka dan peta kode. Gunakan
[DESKTOP-TEST-CHECKLIST.md](DESKTOP-TEST-CHECKLIST.md) untuk pengujian native;
status awalnya belum diuji, bukan otomatis lulus karena CI hijau.
# Test dari akun kedua
