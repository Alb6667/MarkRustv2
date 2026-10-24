import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DRAFT_KEY, readDraft, saveDraft, clearDraft, formatSavedAt, restoreMessage
} from '../ui/core/drafts.js';

function memoryStorage(seed) {
  const map = new Map(seed ? Object.entries(seed) : []);
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    _map: map
  };
}

const DRAFT = { markdown: '# Draf\n\nTulisan yang belum sempat disimpan.\n', path: '/home/u/draf.md', savedAt: 1730000000000 };

test('readDraft mengembalikan null saat storage kosong', () => {
  assert.equal(readDraft(memoryStorage()), null);
  assert.equal(readDraft(null), null);
});

test('saveDraft lalu readDraft mengembalikan data yang sama', () => {
  const s = memoryStorage();
  assert.equal(saveDraft(s, DRAFT), true);
  assert.deepEqual(readDraft(s), {
    markdown: DRAFT.markdown, path: DRAFT.path, savedAt: DRAFT.savedAt
  });
  assert.ok(s._map.has(DRAFT_KEY));
});

test('path opsional dinormalisasi menjadi null', () => {
  const s = memoryStorage();
  assert.equal(saveDraft(s, { markdown: '# x\n', savedAt: 1 }), true);
  assert.equal(readDraft(s).path, null);
});

test('draf kosong tetap tersimpan untuk memulihkan penghapusan isi', () => {
  const s = memoryStorage();
  assert.equal(saveDraft(s, { markdown: '   \n', savedAt: 1 }), true);
  assert.equal(s._map.has(DRAFT_KEY), true);
  assert.equal(readDraft(s).markdown, '   \n');
});

test('JSON rusak di storage diabaikan, bukan melempar', () => {
  const s = memoryStorage({ [DRAFT_KEY]: '{bukan-json' });
  assert.equal(readDraft(s), null);
});

test('payload yang tidak valid diabaikan', () => {
  assert.equal(readDraft(memoryStorage({ [DRAFT_KEY]: JSON.stringify({ markdown: 42 }) })), null);
  assert.equal(readDraft(memoryStorage({ [DRAFT_KEY]: JSON.stringify({ markdown: '  ' }) })).markdown, '  ');
});

test('clearDraft menghapus kunci', () => {
  const s = memoryStorage();
  saveDraft(s, DRAFT);
  clearDraft(s);
  assert.equal(readDraft(s), null);
  assert.equal(s._map.has(DRAFT_KEY), false);
});

test('storage yang melempar (quota/privat) tidak memecah aplikasi', () => {
  const broken = {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('quota'); },
    removeItem() { throw new Error('blocked'); }
  };
  assert.equal(readDraft(broken), null);
  assert.equal(saveDraft(broken, DRAFT), false);
  assert.doesNotThrow(() => clearDraft(broken));
});

test('formatSavedAt menghasilkan format tanggal lokal yang stabil', () => {
  assert.match(formatSavedAt(1730000000000), /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/);
  assert.equal(formatSavedAt(0), 'waktu tidak diketahui');
  assert.equal(formatSavedAt('bukan-angka'), 'waktu tidak diketahui');
  assert.equal(formatSavedAt(null), 'waktu tidak diketahui');
});

test('restoreMessage menyertakan waktu dan kata kunci', () => {
  const msg = restoreMessage(1730000000000);
  assert.match(msg, /Ditemukan draf/);
  assert.match(msg, /Pulihkan/);
  assert.ok(!msg.includes('waktu tidak diketahui'));
});
