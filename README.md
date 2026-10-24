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

Frontend bisa juga dibuka langsung di browser (untuk inspeksi UI) dengan menyajikan
folder `ui/` secara statis — seluruh library sudah di-vendoring, jadi tidak butuh internet.

## Struktur

```
ui/
  index.html        markup + tema
  app.js            seluruh logika editor dan konversi
  vendor/           library pihak ketiga (lokal, offline-ready)
src-tauri/
  src/main.rs      shell Tauri (jendela + webview)
  tauri.conf.json  konfigurasi aplikasi
```

## Cara kerja konversi

| Arah | Jalur |
| --- | --- |
| Markdown → WYSIWYG | `marked` → normalisasi DOM → `quill.clipboard.dangerouslyPasteHTML()` |
| WYSIWYG → Markdown | `quill.getLines()` → serializer Delta bawaan (`quillToMarkdown`) |

Konversi balik **tidak** memakai Turndown. Quill 2 tidak memakai DOM standar — code block
adalah `<div>`, bullet list direpresentasikan sebagai `<ol data-list="bullet">`, dan warna
disimpan sebagai atribut format. Mengonversi DOM-nya akan merusak ketiganya, sehingga
serializer ini membaca **Delta** Quill langsung, yang merupakan model datanya yang sebenarnya.

Hal-hal yang dijaga saat round-trip: bahasa pada fenced code block, jenis list
(bullet/ordered/bersarang), task list, tabel GFM, tautan, gambar, warna teks dan latar,
serta garis pemisah (`---`).

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
