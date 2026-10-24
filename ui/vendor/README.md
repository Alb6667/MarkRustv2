# Library pihak ketiga (vendored)

Semua library disalin ke sini, **bukan** dimuat dari CDN. Tujuannya:

- aplikasi tetap berfungsi sepenuhnya **offline**;
- versi terkunci, jadi perilakunya bisa direproduksi;
- tidak ada permintaan jaringan saat runtime (ini juga yang memungkinkan CSP ketat
  `script-src 'self'` di `src-tauri/tauri.conf.json`).

## Isi

| Direktori | Berkas | Versi | Lisensi |
| --- | --- | --- | --- |
| `quill/` | `quill.js`, `quill.snow.css` | 2.0.3 | BSD-3-Clause |
| `marked/` | `marked.umd.js` | 18.1.1 | MIT |
| `highlight/` | `highlight.min.js`, `night-owl.min.css` | 11.12.0 | BSD-3-Clause |

## Catatan khusus: bundle highlight.js

Paket npm `highlight.js` v11 **tidak** menyertakan bundle browser siap pakai. Berkas
`highlight/highlight.min.js` dibuat sendiri dengan esbuild dari `highlight.js/lib/core`
plus 27 bahasa yang dipilih, dibungkus sebagai IIFE yang mengekspos global `hljs`.

Alasannya: modul syntax Quill 2 memanggil API v11 (`hljs.highlight(code, { language })`)
dan mengambil `window.hljs` secara langsung.

Bila perlu membangun ulang:

```bash
npm install esbuild highlight.js@11.12.0
npx esbuild entry.js --bundle --minify --format=iife --target=es2019 \
  --legal-comments=none --outfile=highlight.min.js
```

Dengan `entry.js` berisi:

```js
import hljs from 'highlight.js/lib/core';
import rust from 'highlight.js/lib/languages/rust';
// ...bahasa lain...

hljs.registerLanguage('rust', rust);
// ...registerLanguage lainnya...

// alias agar ```rs, ```js, ```sh, ```yml ikut terdeteksi
hljs.registerAliases(['rs'], { languageName: 'rust' });

window.hljs = hljs;
```

Bahasa yang disertakan: bash, c, cpp, csharp, css, diff, dockerfile, go, http, ini, java,
javascript, json, kotlin, makefile, markdown, php, plaintext, python, ruby, rust, scss,
sql, swift, typescript, xml, yaml.
