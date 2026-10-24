import test from 'node:test';
import assert from 'node:assert/strict';
import {
  basename, isMarkdownFilename, titleFor, openWithTauri, saveWithTauri,
  confirmDiscard, MARKDOWN_FILTERS, DEFAULT_FILENAME
} from '../ui/core/files.js';

function fakeTauri(opts = {}) {
  const calls = [];
  const openResult = 'openResult' in opts ? opts.openResult : '/home/u/catatan.md';
  const saveResult = 'saveResult' in opts ? opts.saveResult : '/home/u/hasil.md';
  const bridge = {
    calls,
    core: {
      invoke: async (cmd, args) => {
        calls.push(['invoke', cmd, args]);
        return opts.invokeResult !== undefined ? opts.invokeResult : '# Dari disk\n\nIsi.\n';
      }
    },
    dialog: {
      open: async (o) => { calls.push(['open', o]); return openResult; },
      save: async (o) => { calls.push(['save', o]); return saveResult; },
      ask: async (msg) => { calls.push(['ask', msg]); return opts.askResult !== undefined ? opts.askResult : true; },
      message: async (msg) => { calls.push(['message', msg]); }
    }
  };
  if (opts.withoutDialog) delete bridge.dialog;
  return bridge;
}

test('basename menangani path Unix dan Windows', () => {
  assert.equal(basename('/home/u/catatan.md'), 'catatan.md');
  assert.equal(basename('C:\\Users\\u\\catatan.md'), 'catatan.md');
  assert.equal(basename('/home/u/'), 'u');
  assert.equal(basename(''), DEFAULT_FILENAME);
});

test('isMarkdownFilename hanya menerima ekstensi teks', () => {
  assert.equal(isMarkdownFilename('a.md'), true);
  assert.equal(isMarkdownFilename('A.MARKDOWN'), true);
  assert.equal(isMarkdownFilename('a.txt'), true);
  assert.equal(isMarkdownFilename('a.png'), false);
  assert.equal(isMarkdownFilename(''), false);
});

test('titleFor menyertakan nama berkas dan penanda kotor', () => {
  assert.equal(titleFor('/home/u/catatan.md', false), 'MarkRust — catatan.md');
  assert.equal(titleFor('/home/u/catatan.md', true), 'MarkRust — catatan.md ●');
  assert.equal(titleFor(null, false), 'MarkRust — Tanpa Judul');
});

test('openWithTauri memanggil dialog lalu read_document, dan kembalikan isi', async () => {
  const t = fakeTauri();
  const result = await openWithTauri(t);
  assert.deepEqual(result, { path: '/home/u/catatan.md', contents: '# Dari disk\n\nIsi.\n' });
  assert.deepEqual(t.calls[0], ['open', {
    multiple: false, directory: false, filters: MARKDOWN_FILTERS
  }]);
  assert.deepEqual(t.calls[1], ['invoke', 'read_document', { path: '/home/u/catatan.md' }]);
});

test('openWithTauri menerima hasil dialog berbentuk array', async () => {
  const t = fakeTauri({ openResult: ['/x.md'] });
  const result = await openWithTauri(t);
  assert.equal(result.path, '/x.md');
});

test('openWithTauri mengembalikan null bila dibatalkan, tanpa invoke', async () => {
  const t = fakeTauri({ openResult: null });
  assert.equal(await openWithTauri(t), null);
  assert.equal(t.calls.length, 1);
});

test('openWithTauri menolak bila dialog tidak ada', async () => {
  await assert.rejects(() => openWithTauri(fakeTauri({ withoutDialog: true })),
    /Dialog Tauri tidak tersedia/);
});

test('saveWithTauri langsung menulis bila path sudah ada', async () => {
  const t = fakeTauri();
  const saved = await saveWithTauri(t, { path: '/home/u/lama.md', contents: 'isi' });
  assert.equal(saved, '/home/u/lama.md');
  assert.deepEqual(t.calls, [['invoke', 'write_document', { path: '/home/u/lama.md', contents: 'isi' }]]);
});

test('saveWithTauri membuka dialog bila saveAs atau belum punya path', async () => {
  const t = fakeTauri();
  const saved = await saveWithTauri(t, { path: '/home/u/lama.md', contents: 'isi', saveAs: true });
  assert.equal(saved, '/home/u/hasil.md');
  assert.deepEqual(t.calls[0], ['save', { filters: MARKDOWN_FILTERS, defaultPath: '/home/u/lama.md' }]);
  assert.deepEqual(t.calls[1], ['invoke', 'write_document', { path: '/home/u/hasil.md', contents: 'isi' }]);
});

test('saveWithTauri batal -> null, tidak ada invoke', async () => {
  const t = fakeTauri({ saveResult: null });
  assert.equal(await saveWithTauri(t, { contents: 'isi' }), null);
  assert.equal(t.calls.length, 1);
});

test('confirmDiscard memakai dialog native bila tersedia', async () => {
  const t = fakeTauri();
  assert.equal(await confirmDiscard(t), true);
  assert.equal(t.calls[0][0], 'ask');
});
