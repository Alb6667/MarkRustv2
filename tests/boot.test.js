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
// highlight.js sengaja TIDAK dimuat -> menguji cabang `if (hljs)` di app.js.

// Bridge Tauri palsu. Disuntikkan SEBELUM import app.js supaya jalur Tauri
// (bukan fallback browser) yang benar-benar diuji.
const tauriCalls = [];
const titles = [];
const DISK_DOC = '# Dokumen Dari Disk\n\nIsi dari berkas.\n';
window.__TAURI__ = {
  core: {
    invoke: async (cmd, args) => {
      tauriCalls.push([cmd, args]);
      return cmd === 'read_document' ? DISK_DOC : null;
    }
  },
  dialog: {
    open: async () => '/home/u/catatan.md',
    save: async () => '/home/u/catatan-baru.md',
    ask: async () => true,
    message: async () => {}
  },
  event: { listen: async () => () => {} },
  window: { getCurrentWindow: () => ({ setTitle: async (t) => { titles.push(t); } }) }
};

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
    'image-dialog', 'image-form', 'image-url', 'image-error', 'image-cancel', 'image-ok',
    'btn-new', 'btn-open', 'btn-save', 'sb-file'
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


test('judul awal memakai "Tanpa Judul" lewat jembatan Tauri', async () => {
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(titles.length > 0, 'setTitle harus dipanggil');
  assert.equal(titles[titles.length - 1], 'MarkRust — Tanpa Judul');
  assert.equal(window.document.getElementById('sb-file').textContent, 'Tanpa Judul');
});

test('menu native: buka berkas memanggil read_document dan mengisi editor', async () => {
  const ok = await api.handleMenuAction('open');
  assert.equal(ok, true);
  assert.equal(api.getPath(), '/home/u/catatan.md');
  assert.ok(api.getMarkdown().includes('Dokumen Dari Disk'));
  assert.ok(tauriCalls.some((c) => c[0] === 'read_document'));
  assert.equal(api.isDirty(), false);
  assert.equal(window.document.getElementById('sb-file').textContent, 'catatan.md');
});

test('menu native: simpan memanggil write_document dan membersihkan penanda kotor', async () => {
  const before = tauriCalls.length;
  const ok = await api.saveDocument(false);
  assert.equal(ok, true);
  const write = tauriCalls.slice(before).find((c) => c[0] === 'write_document');
  assert.ok(write, 'write_document harus dipanggil');
  assert.equal(write[1].path, '/home/u/catatan.md');
  assert.equal(write[1].contents, api.getMarkdown());
  assert.equal(api.isDirty(), false);
});

test('Simpan Sebagai memakai path baru dari dialog', async () => {
  const ok = await api.saveDocument(true);
  assert.equal(ok, true);
  assert.equal(api.getPath(), '/home/u/catatan-baru.md');
  assert.ok(tauriCalls.some((c) => c[0] === 'write_document' && c[1].path === '/home/u/catatan-baru.md'));
});

test('judul jendela berubah saat ada path dan saat dokumen kotor', async () => {
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(titles.includes('MarkRust — catatan-baru.md'));
  // Suntingan bersumber 'user' harus menaikkan penanda kotor.
  api.quill.insertText(0, 'X', 'user');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(api.isDirty(), true);
  assert.equal(titles[titles.length - 1], 'MarkRust — catatan-baru.md ●');
  assert.equal(window.document.getElementById('sb-dirty').hidden, false);
});

test('Ctrl+S memicu simpan lewat handler keyboard', async () => {
  const before = tauriCalls.filter((c) => c[0] === 'write_document').length;
  const ev = new window.KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true });
  window.document.dispatchEvent(ev);
  await new Promise((r) => setTimeout(r, 0));
  const after = tauriCalls.filter((c) => c[0] === 'write_document').length;
  assert.equal(after, before + 1);
  assert.equal(ev.defaultPrevented, true);
});

test('menu native: toggle_mode berpindah mode dan kembali', async () => {
  const start = window.document.getElementById('sb-mode').textContent;
  await api.handleMenuAction('toggle_mode');
  assert.notEqual(window.document.getElementById('sb-mode').textContent, start);
  await api.handleMenuAction('toggle_mode');
  assert.equal(window.document.getElementById('sb-mode').textContent, start);
});

test('dokumen baru mengosongkan path, isi, dan penanda kotor', async () => {
  const ok = await api.newDocument();
  assert.equal(ok, true);
  assert.equal(api.getPath(), null);
  assert.equal(api.getMarkdown().trim(), '');
  assert.equal(api.isDirty(), false);
  assert.equal(window.document.getElementById('sb-file').textContent, 'Tanpa Judul');
});
