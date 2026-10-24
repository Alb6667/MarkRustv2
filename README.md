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
  vendor/           library pihak ketiga (lokal, offline-ready)
tests/
  harness.js        jsdom + Quill/marked hasil vendoring (bukan mock)
  *.test.js         unit + round-trip sungguhan + smoke test boot aplikasi
.github/workflows/  CI: tes Node + build Rust di Linux/Windows/macOS
src-tauri/
  src/main.rs       shell Tauri (jendela + webview)
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

### Catatan privasi gambar

CSP masih mengizinkan `img-src https:`. Artinya, membuka dokumen Markdown dari
pihak lain dapat memicu permintaan jaringan ke URL gambar di dalamnya. Status
bar kini **menampilkan jumlah gambar jarak jauh** supaya ini tidak terjadi
diam-diam. Pemblokiran penuh membutuhkan blot gambar kustom yang menyimpan URL
asli tanpa memuatnya — belum diimplementasikan.

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

## Status

Fondasi editor sudah berfungsi. Yang belum ada: buka/simpan berkas (butuh
`tauri-plugin-fs` + `tauri-plugin-dialog`) dan pintasan keyboard.
