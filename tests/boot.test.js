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
const asks = [];
const closeHandlers = [];
const destroyed = [];
let nextAskResult = true;
let failWrite = false;
let pendingWrite = null;
const DISK_DOC = '# Dokumen Dari Disk\n\nIsi dari berkas.\n';
window.__TAURI__ = {
  core: {
    invoke: async (cmd, args) => {
      tauriCalls.push([cmd, args]);
      if (cmd === 'write_document' && pendingWrite) await pendingWrite;
      if (cmd === 'write_document' && failWrite) throw new Error('disk penuh');
      return cmd === 'read_document' ? DISK_DOC : null;
    }
  },
  dialog: {
    open: async () => '/home/u/catatan.md',
    save: async () => '/home/u/catatan-baru.md',
    ask: async (msg) => { asks.push(msg); return nextAskResult; },
    message: async () => {}
  },
  event: { listen: async () => () => {} },
  window: {
    getCurrentWindow: () => ({
      setTitle: async (t) => { titles.push(t); },
      onCloseRequested: async (fn) => { closeHandlers.push(fn); return () => {}; },
      destroy: async () => { destroyed.push(true); }
    })
  }
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
    'btn-new', 'btn-open', 'btn-save', 'sb-file', 'sb-load-images'
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


/* ------------------------------------------------------------------------- *
 * Draft recovery & konfirmasi tutup
 * ------------------------------------------------------------------------- */

test('handler close native terdaftar saat boot', () => {
  assert.equal(api.isCloseHandlerRegistered(), true);
  assert.ok(closeHandlers.length >= 1);
});

test('tutup saat dokumen bersih tidak memunculkan dialog', async () => {
  nextAskResult = true;
  await api.newDocument();                 // dokumen kosong & bersih
  const before = asks.length;
  const fakeEvent = { preventDefault: () => { throw new Error('tidak boleh dicegah'); } };
  await closeHandlers[closeHandlers.length - 1](fakeEvent);
  assert.equal(asks.length, before, 'tidak boleh bertanya saat tidak ada perubahan');
});

test('tutup saat kotor + pilih simpan -> write_document dipanggil, close diteruskan', async () => {
  await api.newDocument();
  api.quill.insertText(0, 'A', 'user');
  assert.equal(api.isDirty(), true);

  nextAskResult = true;
  let prevented = false;
  const before = asks.length;
  const writesBefore = tauriCalls.filter((c) => c[0] === 'write_document').length;
  await closeHandlers[closeHandlers.length - 1]({ preventDefault: () => { prevented = true; } });

  assert.ok(asks.length > before, 'harus menanyakan konfirmasi');
  assert.match(asks[asks.length - 1], /Simpan sebelum keluar/);
  assert.equal(tauriCalls.filter((c) => c[0] === 'write_document').length, writesBefore + 1);
  assert.equal(prevented, false, 'close boleh dilanjutkan setelah simpan berhasil');
  assert.equal(api.isDirty(), false);
});

test('tutup saat kotor + pilih tidak menyimpan -> draf tetap ada untuk dipulihkan', async () => {
  await api.newDocument();
  api.quill.insertText(0, 'Teks penting', 'user');
  const expected = api.getMarkdown();

  nextAskResult = false;
  let prevented = false;
  const writesBefore = tauriCalls.filter((c) => c[0] === 'write_document').length;
  await closeHandlers[closeHandlers.length - 1]({ preventDefault: () => { prevented = true; } });

  assert.equal(tauriCalls.filter((c) => c[0] === 'write_document').length, writesBefore,
    'tidak boleh menulis berkas bila pengguna memilih keluar tanpa menyimpan');
  assert.equal(prevented, false);
  const raw = window.localStorage.getItem(api.draftKey);
  assert.ok(raw, 'draf harus sudah ditulis sebelum dialog');
  assert.equal(JSON.parse(raw).markdown, expected);
});

test('gagal menyimpan saat mau keluar -> close dicegah, data tidak hilang', async () => {
  await api.newDocument();
  api.quill.insertText(0, 'Jangan hilang', 'user');

  failWrite = true;
  nextAskResult = true;
  let prevented = false;
  try {
    await closeHandlers[closeHandlers.length - 1]({ preventDefault: () => { prevented = true; } });
  } finally {
    failWrite = false;
  }
  assert.equal(prevented, true, 'jendela harus tetap terbuka bila simpan gagal');
  assert.equal(api.isDirty(), true);
  assert.ok(JSON.parse(window.localStorage.getItem(api.draftKey)).markdown.includes('Jangan hilang'));
});

test('draf dari sesi sebelumnya ditawarkan dan dipulihkan', async () => {
  await api.newDocument();
  const savedAt = Date.now() - 60000;
  window.localStorage.setItem(api.draftKey, JSON.stringify({
    version: 1, markdown: '# Pulihkan saya\n\nIsi draf.\n',
    path: '/home/u/draf.md', savedAt
  }));

  nextAskResult = true;
  const before = asks.length;
  const ok = await api.restoreDraftIfAny();

  assert.equal(ok, true);
  assert.ok(asks.length > before);
  assert.match(asks[asks.length - 1], /Ditemukan draf/);
  assert.ok(api.getMarkdown().includes('Pulihkan saya'));
  assert.equal(api.getPath(), '/home/u/draf.md');
  assert.equal(api.isDirty(), true, 'hasil pemulihan masih harus dianggap belum tersimpan');
});

test('menolak pemulihan draf akan membuang draf tersebut', async () => {
  await api.newDocument();
  window.localStorage.setItem(api.draftKey, JSON.stringify({
    version: 1, markdown: '# Draf lama\n', path: null, savedAt: Date.now()
  }));

  nextAskResult = false;
  const ok = await api.restoreDraftIfAny();

  assert.equal(ok, false);
  assert.equal(window.localStorage.getItem(api.draftKey), null);
  assert.ok(!api.getMarkdown().includes('Draf lama'));
});

test('simpan berhasil menghapus draf yang tersisa', async () => {
  await api.newDocument();
  api.quill.insertText(0, 'Akan disimpan', 'user');
  api.flushDraft();
  assert.ok(window.localStorage.getItem(api.draftKey), 'draf harus ada sebelum simpan');

  assert.equal(await api.saveDocument(false), true);
  assert.equal(window.localStorage.getItem(api.draftKey), null,
    'draf harus dihapus setelah berkas tersimpan');
});


/* ------------------------------------------------------------------------- *
 * Keamanan gambar jarak jauh (integrasi dengan UI)
 * ------------------------------------------------------------------------- */

test('membuka dokumen asing menahan gambar dan menampilkan tombol Muat gambar', async () => {
  api.setMarkdown('![foto](https://tracker.example/pixel.png)\n');
  const imgs = Array.from(api.quill.root.querySelectorAll('img'));
  assert.equal(imgs.length, 1);
  assert.ok(!/^https?:/i.test(imgs[0].getAttribute('src') || ''),
    'src tidak boleh menunjuk ke jaringan sebelum ada izin');
  assert.equal(imgs[0].getAttribute('data-mr-src'), 'https://tracker.example/pixel.png');

  const btn = window.document.getElementById('sb-load-images');
  assert.equal(btn.hidden, false);
  assert.match(btn.textContent, /Muat gambar \(1\)/);
  assert.match(window.document.getElementById('sb-notice').textContent, /diblokir/);
});

test('Muat gambar mengembalikan src asli dan menyembunyikan tombol', async () => {
  const n = await api.loadRemoteImages();
  assert.equal(n, 1);
  const img = api.quill.root.querySelector('img');
  assert.equal(img.getAttribute('src'), 'https://tracker.example/pixel.png');
  assert.equal(window.document.getElementById('sb-load-images').hidden, true);
});

test('URL gambar tetap utuh di Markdown walau ditahan', () => {
  api.setMarkdown('![foto](https://tracker.example/pixel.png)\n');
  assert.match(api.getMarkdown(), /!\[foto\]\(https:\/\/tracker\.example\/pixel\.png\)/);
});

test('setMarkdown mereset izin gambar untuk dokumen berikutnya', async () => {
  api.setMarkdown('![foto](https://tracker.example/pixel.png)\n');
  await api.loadRemoteImages();
  assert.equal(api.quill.root.querySelector('img').getAttribute('src'),
    'https://tracker.example/pixel.png');

  api.setMarkdown('![baru](https://tracker.example/lain.png)\n');
  const img = api.quill.root.querySelector('img');
  assert.ok(!/^https?:/i.test(img.getAttribute('src') || ''),
    'dokumen baru harus kembali diblokir');
  assert.equal(window.document.getElementById('sb-load-images').hidden, false);
});


test('draf diperbarui juga setelah ketikan kedua saat dokumen masih kotor', async () => {
  nextAskResult = true;
  await api.newDocument();
  api.quill.insertText(0, 'Pertama', 'user');
  await new Promise((r) => setTimeout(r, 800));
  const first = JSON.parse(window.localStorage.getItem(api.draftKey)).markdown;
  api.quill.insertText(0, 'Kedua ', 'user');
  await new Promise((r) => setTimeout(r, 800));
  const second = JSON.parse(window.localStorage.getItem(api.draftKey)).markdown;
  assert.notEqual(first, second);
  assert.equal(second, api.getMarkdown());
});

test('ketikan selama simpan berlangsung tetap kotor dan dicadangkan', async () => {
  await api.newDocument();
  api.quill.insertText(0, 'Snapshot', 'user');
  let release;
  pendingWrite = new Promise((r) => { release = r; });
  try {
    const saving = api.saveDocument(false);
    await new Promise((r) => setTimeout(r, 0));
    api.quill.insertText(0, 'Baru ', 'user');
    assert.equal(await api.saveDocument(false), false, 'simpan paralel ditolak');
    release();
    assert.equal(await saving, false, 'snapshot lama bukan seluruh perubahan terbaru');
    assert.equal(api.isDirty(), true);
    assert.equal(JSON.parse(window.localStorage.getItem(api.draftKey)).markdown, api.getMarkdown());
  } finally { release(); pendingWrite = null; }
});

test('hasil simpan lama tidak mengubah path atau dirty dokumen baru', async () => {
  await api.newDocument();
  api.quill.insertText(0, 'Dokumen lama', 'user');
  let release;
  pendingWrite = new Promise((r) => { release = r; });
  try {
    const saving = api.saveDocument(false);
    await new Promise((r) => setTimeout(r, 0));
    await api.newDocument();
    api.quill.insertText(0, 'Dokumen baru', 'user');
    release();
    assert.equal(await saving, false);
    assert.equal(api.getPath(), null);
    assert.equal(api.isDirty(), true);
    assert.match(api.getMarkdown(), /Dokumen baru/);
  } finally { release(); pendingWrite = null; }
});
