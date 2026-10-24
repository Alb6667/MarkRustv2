/*
 * Smoke test aplikasi utuh: index.html + vendor + app.js di jsdom.
 * Tujuannya bukan menguji konversi (itu sudah di roundtrip.test.js), melainkan
 * memastikan wiring DOM tidak putus: elemen yang dicari app.js benar-benar ada,
 * status bar terisi, dan jembatan window.MarkRust terbentuk.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { installGlobals, readVendor } from './harness.js';

const html = readVendor('ui/index.html').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');

const dom = new JSDOM(html, {
  runScripts: 'outside-only',
  pretendToBeVisual: true,
  url: 'http://localhost/'
});
const window = installGlobals(dom.window);
window.eval(readVendor('ui/vendor/quill/quill.js'));
window.eval(readVendor('ui/vendor/marked/marked.umd.js'));
// highlight.js opsional: app.js harus tetap jalan tanpanya.
if (!window.hljs) {
  // sengaja tidak dimuat -> menguji cabang `if (hljs)`.

}

await import('../ui/app.js');

const api = window.MarkRust;

test('app.js boot tanpa error dan mengekspos window.MarkRust', () => {
  assert.ok(api, 'window.MarkRust harus ada');
  assert.equal(typeof api.quillToMarkdown, 'function');
  assert.equal(typeof api.setMode, 'function');
  assert.equal(typeof api.setMarkdown, 'function');
  assert.equal(typeof api.getMarkdown, 'function');
  assert.equal(typeof api.getStats, 'function');
});

test('index.html menyediakan semua elemen yang dipakai status bar & dialog', () => {
  const d = window.document;
  for (const id of [
    'editor', 'editor-wrap', 'raw-view', 'raw-textarea',
    'toolbar', 'quill-toolbar', 'btn-wysiwyg', 'btn-markdown', 'btn-pin',
    'statusbar', 'sb-mode', 'sb-dirty', 'sb-notice', 'stat-words', 'stat-chars',
    'image-dialog', 'image-form', 'image-url', 'image-error', 'image-cancel', 'image-ok'
  ]) {
    assert.ok(d.getElementById(id), 'elemen #' + id + ' hilang dari index.html');
  }
});

test('tidak ada lagi #wordcount mengambang', () => {
  assert.equal(window.document.getElementById('wordcount'), null);
  const css = readVendor('ui/app.css');
  assert.ok(!css.includes('#wordcount'), 'CSS lama masih menyisakan #wordcount');
  assert.ok(css.includes('#statusbar'));
});

test('app.css dimuat sebagai stylesheet terpisah, bukan inline', () => {
  assert.ok(html.includes('href="app.css"'));
  assert.ok(!html.includes('<style>'));
});

test('toolbar tidak lagi memakai -webkit-app-region (decorations native aktif)', () => {
  assert.ok(!readVendor('ui/app.css').includes('-webkit-app-region'));
});

test('status bar terisi angka, bukan 0', () => {
  const stats = api.getStats();
  assert.ok(stats.words > 0, 'konten awal harus punya kata');
  assert.match(window.document.getElementById('stat-words').textContent, /^Words: \d+$/);
  assert.match(window.document.getElementById('stat-chars').textContent, /^Chars: \d+$/);
  assert.equal(window.document.getElementById('sb-mode').textContent, 'WYSIWYG');
});

test('toolbar default pinned/tampil dan dokumen awal tidak ditandai kotor', () => {
  assert.equal(api.isToolbarPinned(), true);
  assert.equal(api.isToolbarVisible(), true);
  assert.equal(api.isDirty(), false);
  assert.equal(window.document.getElementById('sb-dirty').hidden, true);
});

test('ganti mode mengubah label status bar dan isi tetap round-trip', () => {
  const before = api.getMarkdown();
  api.setMode('markdown');
  assert.equal(window.document.getElementById('sb-mode').textContent, 'Markdown');
  assert.equal(window.document.getElementById('raw-textarea').value, before);
  api.setMode('wysiwyg');
  assert.equal(window.document.getElementById('sb-mode').textContent, 'WYSIWYG');
  assert.equal(api.getMarkdown(), before);
});

test('notifikasi gambar jarak jauh muncul hanya bila ada URL remote', () => {
  const notice = window.document.getElementById('sb-notice');
  assert.equal(notice.hidden, true, 'konten awal tidak boleh punya gambar remote');

  api.setMarkdown('![foto](https://contoh.test/foto.png)\n');
  api.setMode('markdown');
  api.setMode('wysiwyg');
  assert.equal(notice.hidden, false);
  assert.match(notice.textContent, /1 gambar jarak jauh/);
});

test('setMarkdown lewat jembatan tidak menandai dokumen kotor', () => {
  api.markClean();
  api.setMarkdown('# Dokumen baru\n\nIsi.\n');
  assert.equal(api.isDirty(), false);
  assert.ok(api.getMarkdown().includes('Dokumen baru'));
});
