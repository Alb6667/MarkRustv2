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
