/*
 * Round-trip SUNGGUHAN: Markdown -> marked -> normalizeForQuill -> clipboard
 * Quill 2.0.3 -> Delta -> serializeLines -> Markdown.
 * Tidak ada mock konversi; yang dipakai adalah berkas vendor yang sama dengan
 * yang dikirim ke webview Tauri.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { getEnv, parseMarkdown, createQuill } from './harness.js';
import { registerDividerBlot, registerHrMatcher } from '../ui/core/quill-setup.js';
import { mdToQuillHtml, documentStats } from '../ui/core/markdown.js';
import { linesFromQuill, serializeLines } from '../ui/core/serialize.js';

const { Quill, DOMParser } = getEnv();
registerDividerBlot(Quill);

function roundTrip(md) {
  const quill = createQuill();
  registerHrMatcher(quill, Quill);
  quill.setContents([{ insert: '\n' }], 'silent');
  const html = mdToQuillHtml(md, parseMarkdown, DOMParser);
  quill.clipboard.dangerouslyPasteHTML(0, html, 'api');
  const canonical = serializeLines(linesFromQuill(quill));
  return { canonical, quill, html };
}

function expectExact(md) {
  const { canonical } = roundTrip(md);
  assert.equal(canonical, md, 'round-trip harus identik');
}

test('heading, paragraf, bold, italic', () => {
  expectExact('# Judul\n\nParagraf **tebal** dan *miring*.\n');
});

test('hierarki heading 1/2/3 tidak rontok', () => {
  expectExact('# A\n\n## B\n\n### C\n\nteks biasa\n');
});

test('code block: bahasa DAN indentasi spasi bertahan', () => {
  expectExact('```rust\nfn main() {\n    println!("Hello, MarkRust!");\n}\n```\n');
});

test('code block bergaya fence bersarang tidak menutup lebih awal', () => {
  expectExact('````md\n```js\nlet x = 1;\n```\n````\n');
});

test('dua code block dengan bahasa berbeda tetap terpisah', () => {
  expectExact('```js\nlet a = 1;\n```\n\n```python\nprint("b")\n```\n');
});

test('list campuran: penomoran ordered berlanjut melewati bullet bersarang', () => {
  expectExact('1. satu\n2. dua\n   - anak\n   - lagi\n3. tiga\n');
});

test('task list checked/unchecked bertahan', () => {
  expectExact('- [ ] belum\n- [x] selesai\n');
});

test('tabel GFM: alignment kanan/tengah bertahan', () => {
  expectExact('| A | B |\n| :---: | ---: |\n| 1 | 2 |\n');
});

test('tabel: alignment kiri eksplisit dinormalisasi jadi --- (identik secara GFM)', () => {
  const { canonical } = roundTrip('| A | B |\n| :--- | --- |\n| 1 | 2 |\n');
  assert.equal(canonical, '| A | B |\n| --- | --- |\n| 1 | 2 |\n');
});

test('garis pemisah --- tidak hilang', () => {
  expectExact('atas\n\n---\n\nbawah\n');
});

test('tautan dan gambar (alt + URL) bertahan', () => {
  expectExact('[tautan](https://x.test) dan ![alt](https://x.test/a.png)\n');
});

test('inline code dengan backtick di dalamnya memanjangkan fence', () => {
  expectExact('kode `a` dan ``b`c``\n');
});

test('strikethrough dari ~~ dan <del> sama-sama jadi ~~', () => {
  const { canonical } = roundTrip('~~coret~~ dan <del>hapus</del>\n');
  assert.equal(canonical, '~~coret~~ dan ~~hapus~~\n');
});

test('underline dan warna inline dipertahankan sebagai HTML', () => {
  expectExact('<u>garis bawah</u>\n');
  expectExact('<span style="color:#ff0000">merah</span>\n');
});

test('soft line break di paragraf melebur jadi spasi (sesuai CommonMark)', () => {
  const { canonical } = roundTrip('baris satu\nbaris dua\n');
  assert.equal(canonical, 'baris satu baris dua\n');
});

test('hard break (dua spasi) di blockquote tetap dua baris', () => {
  const { canonical } = roundTrip('> baris satu  \n> baris dua\n');
  assert.equal(canonical, '> baris satu\n>\n> baris dua\n');
});

test('dua paragraf blockquote dipisahkan baris > kosong', () => {
  const { canonical } = roundTrip('> paragraf satu\n>\n> paragraf dua\n');
  assert.equal(canonical, '> paragraf satu\n>\n> paragraf dua\n');
});

// Batasan yang memang diketahui: dinamisasi di sini supaya kalau perilakunya
// berubah (misal karena upgrade Quill), tes memberi tahu, bukan diam-diam.
test('BATASAN: raw HTML kehilangan pembungkusnya (Quill meratakan ke paragraf)', () => {
  const { canonical } = roundTrip('<div class="kotak">konten html</div>\n');
  assert.equal(canonical, 'konten html\n');
});

test('BATASAN: hard break di paragraf biasa berubah jadi dua paragraf', () => {
  const { canonical } = roundTrip('baris satu  \nbaris dua\n');
  assert.equal(canonical, 'baris satu\n\nbaris dua\n');
});

// ---------------------------------------------------------------------------
// Idempotensi & paritas statistik
// ---------------------------------------------------------------------------

const FIXTURE = [
  '# Selamat Datang di MarkRust ✨',
  '',
  'Ini adalah **WYSIWYG Markdown Editor** yang dibuat dengan *Rust* + *Tauri*.',
  '',
  '### Fitur',
  '',
  '- **Bold**, *italic*, ~~strikethrough~~',
  '- Daftar bersarang',
  '  - anak satu',
  '  - anak dua',
  '- [x] tugas selesai',
  '',
  '```rust',
  'fn main() {',
  '    println!("hi");',
  '}',
  '```',
  '',
  '> “Simplicity is the ultimate sophistication.”',
  '',
  '---',
  '',
  '| Format | Contoh |',
  '| --- | ---: |',
  '| Tebal | **teks** |',
  '| Kode | `kode` |',
  '',
  'Akhir dokumen.'
].join('\n') + '\n';

test('idempoten: serialisasi kedua identik dengan yang pertama', () => {
  const first = roundTrip(FIXTURE).canonical;
  const second = roundTrip(first).canonical;
  assert.equal(second, first);
});

test('statistik identik di mode Markdown, mode WYSIWYG, dan teks Quill', () => {
  const { canonical, quill } = roundTrip(FIXTURE);
  const fromRaw = documentStats(FIXTURE);
  const fromCanonical = documentStats(canonical);
  // Aplikasi menyimpan checkbox task list sebagai TEKS literal '[x] ' di Delta
  // Quill (lihat normalizeForQuill). Itu terlihat di WYSIWYG, tetapi bukan
  // konten dalam model Markdown — jadi samakan dulu sebelum membandingkan.
  const quillText = quill.getText().replace(/^\s*\[[ xX]\]\s+/gm, '');
  const flat = quillText.replace(/\s+/g, ' ').trim();
  const quillWords = flat ? flat.split(' ').length : 0;

  assert.ok(fromRaw.words > 0);
  assert.equal(fromRaw.words, quillWords, 'documentStats(md) harus cocok dengan teks Quill');
  assert.equal(fromCanonical.words, fromRaw.words);
  assert.equal(fromCanonical.chars, fromRaw.chars);
});
