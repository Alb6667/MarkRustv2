/*
 * Draft recovery — jaminan terakhir agar tulisan tidak hilang.
 *
 * Konfirmasi tutup saja tidak cukup: force-quit, crash, dan Cmd+Q di macOS
 * bisa melewati event close. Karena itu dokumen yang sedang kotor disimpan
 * berkala ke localStorage webview, dan ditawarkan kembali saat aplikasi dibuka.
 *
 * Modul ini murni: `storage` di-inject, sehingga bisa diuji tanpa browser.
 */

export const DRAFT_KEY = 'markrust.draft.v1';
const DRAFT_VERSION = 1;

function safeStorage(storage) {
  if (!storage) return null;
  try {
    if (typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') return null;
    return storage;
  } catch (e) {
    return null;
  }
}

/** Baca draf. Mengembalikan null bila tidak ada / rusak / kosong. */
export function readDraft(storage) {
  const s = safeStorage(storage);
  if (!s) return null;
  try {
    const raw = s.getItem(DRAFT_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || typeof data.markdown !== 'string') return null;
    if (data.markdown.trim() === '') return null;
    return {
      markdown: data.markdown,
      path: typeof data.path === 'string' && data.path ? data.path : null,
      savedAt: Number(data.savedAt) || 0
    };
  } catch (e) {
    return null; // JSON rusak -> dianggap tidak ada draf
  }
}

/** Simpan draf. Mengembalikan false bila storage penuh/tidak tersedia. */
export function saveDraft(storage, draft) {
  const s = safeStorage(storage);
  if (!s) return false;
  const markdown = draft && typeof draft.markdown === 'string' ? draft.markdown : '';
  if (markdown.trim() === '') {
    clearDraft(storage);
    return false;
  }
  try {
    s.setItem(DRAFT_KEY, JSON.stringify({
      version: DRAFT_VERSION,
      markdown: markdown,
      path: draft.path || null,
      savedAt: Number(draft.savedAt) || Date.now()
    }));
    return true;
  } catch (e) {
    // localStorage penuh / mode privat: jangan sampai mengganggu pengguna.
    return false;
  }
}

export function clearDraft(storage) {
  const s = safeStorage(storage);
  if (!s || typeof s.removeItem !== 'function') return;
  try { s.removeItem(DRAFT_KEY); } catch (e) { /* abaikan */ }
}

/** Format waktu lokal yang stabil untuk pesan dialog pemulihan. */
export function formatSavedAt(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return 'waktu tidak diketahui';
  const d = new Date(n);
  if (isNaN(d.getTime())) return 'waktu tidak diketahui';
  const pad = (x) => String(x).padStart(2, '0');
  return pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + '/' + d.getFullYear() +
    ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

/** Pesan dialog, dipisah supaya mudah diuji. */
export function restoreMessage(savedAt) {
  return 'Ditemukan draf yang belum tersimpan (' + formatSavedAt(savedAt) +
    '). Pulihkan tulisan tersebut?';
}
