/*
 * I/O dokumen untuk dua lingkungan:
 *   - Tauri  : dialog native + perintah Rust read_document/write_document
 *   - Browser: <input type="file"> + unduhan Blob (fallback untuk inspeksi UI)
 *
 * Fungsi-fungsi di sini menerima `tauri` hasil injeksi, jadi bisa diuji dengan
 * bridge palsu tanpa menjalankan aplikasi desktop.
 */

export const MARKDOWN_FILTERS = [
  { name: 'Markdown', extensions: ['md', 'markdown', 'txt'] }
];

export const DEFAULT_FILENAME = 'dokumen.md';

export function getTauriApi() {
  if (typeof window === 'undefined') return null;
  const t = window.__TAURI__;
  return t && t.core && typeof t.core.invoke === 'function' ? t : null;
}

export function isTauri() {
  return getTauriApi() !== null;
}

/** Ambil nama berkas dari path Unix maupun Windows. */
export function basename(path) {
  const s = String(path == null ? '' : path).replace(/\\/g, '/').replace(/\/+$/, '');
  const i = s.lastIndexOf('/');
  return (i >= 0 ? s.slice(i + 1) : s) || DEFAULT_FILENAME;
}

// Daftar ini harus tetap identik dengan `document_path()` di src-tauri/src/main.rs.
export const ALLOWED_EXTENSIONS = ['md', 'markdown', 'txt', 'mdown', 'mkd'];

export function isMarkdownFilename(name) {
  return new RegExp('\\.(' + ALLOWED_EXTENSIONS.join('|') + ')$', 'i')
    .test(String(name || ''));
}

export function titleFor(path, dirty) {
  return 'MarkRust — ' + (path ? basename(path) : 'Tanpa Judul') + (dirty ? ' ●' : '');
}

/** Buka dokumen lewat dialog Tauri. Mengembalikan null bila pengguna membatalkan. */
export async function openWithTauri(tauri) {
  if (!tauri || !tauri.dialog || typeof tauri.dialog.open !== 'function') {
    throw new Error('Dialog Tauri tidak tersedia');
  }
  const selected = await tauri.dialog.open({
    multiple: false,
    directory: false,
    filters: MARKDOWN_FILTERS
  });
  const path = Array.isArray(selected) ? selected[0] : selected;
  if (!path || typeof path !== 'string') return null;
  const contents = await tauri.core.invoke('read_document', { path });
  return { path, contents: String(contents == null ? '' : contents) };
}

/**
 * Simpan dokumen lewat perintah Rust.
 * `saveAs: true` atau belum punya path -> tampilkan dialog simpan.
 * Mengembalikan path tujuan, atau null bila dibatalkan.
 */
export async function saveWithTauri(tauri, options) {
  const opts = options || {};
  if (!tauri || typeof tauri.core.invoke !== 'function') {
    throw new Error('Tauri tidak tersedia');
  }
  let target = opts.path || null;
  if (!target || opts.saveAs) {
    if (!tauri.dialog || typeof tauri.dialog.save !== 'function') {
      throw new Error('Dialog simpan Tauri tidak tersedia');
    }
    const dialogOpts = { filters: MARKDOWN_FILTERS };
    if (target) dialogOpts.defaultPath = target;
    target = await tauri.dialog.save(dialogOpts);
  }
  if (!target) return null;
  await tauri.core.invoke('write_document', { path: target, contents: opts.contents || '' });
  return target;
}

/** Fallback browser: baca File/Blob yang dijatuhkan atau dipilih. */
export function readBrowserFile(file) {
  return new Promise(function (resolve, reject) {
    if (!file) { reject(new Error('Tidak ada berkas')); return; }
    if (typeof FileReader === 'undefined') {
      reject(new Error('FileReader tidak tersedia'));
      return;
    }
    const reader = new FileReader();
    reader.onload = function () {
      resolve({ path: file.name || DEFAULT_FILENAME, contents: String(reader.result || '') });
    };
    reader.onerror = function () { reject(new Error('Gagal membaca berkas')); };
    reader.readAsText(file);
  });
}

/** Fallback browser: unduh teks sebagai berkas .md. */
export function downloadBrowserFile(filename, contents) {
  const name = filename || DEFAULT_FILENAME;
  const blob = new Blob([String(contents == null ? '' : contents)], {
    type: 'text/markdown;charset=utf-8'
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  return name;
}

export async function confirmDiscard(tauri) {
  const message = 'Perubahan belum disimpan. Lanjutkan dan buang perubahan itu?';
  return askOrConfirm(tauri, message, 'MarkRust', 'warning');
}

/** Ditanyakan saat pengguna menutup jendela dengan dokumen masih kotor. */
export async function confirmSaveOnClose(tauri) {
  const message = 'Ada perubahan yang belum disimpan. Simpan sebelum keluar?\n\n' +
    'Jika memilih tidak menyimpan, draf tetap disimpan otomatis dan bisa ' +
    'dipulihkan saat aplikasi dibuka lagi.';
  return askOrConfirm(tauri, message, 'MarkRust', 'warning');
}

/** Ditanyakan saat startup bila draf dari sesi sebelumnya ditemukan. */
export async function confirmRestore(tauri, message) {
  return askOrConfirm(tauri, message, 'MarkRust — Pulihkan draf', 'info');
}

function askOrConfirm(tauri, message, title, kind) {
  if (tauri && tauri.dialog && typeof tauri.dialog.ask === 'function') {
    return tauri.dialog.ask(message, { title: title, kind: kind });
  }
  return Promise.resolve(
    typeof window !== 'undefined' && typeof window.confirm === 'function'
      ? window.confirm(message)
      : false
  );
}

export async function showError(tauri, message) {
  if (tauri && tauri.dialog && typeof tauri.dialog.message === 'function') {
    await tauri.dialog.message(String(message), { title: 'MarkRust', kind: 'error' });
    return;
  }
  if (typeof window !== 'undefined' && typeof window.alert === 'function') {
    window.alert(String(message));
  }
}

/** Judul jendela native + <title>. Keduanya diabaikan bila tidak didukung. */
export async function setWindowTitle(tauri, title) {
  if (typeof document !== 'undefined') document.title = title;
  try {
    if (tauri && tauri.window && typeof tauri.window.getCurrentWindow === 'function') {
      await tauri.window.getCurrentWindow().setTitle(title);
    }
  } catch (e) {
    // Di browser biasa atau bila izin set-title tidak ada: abaikan.
  }
}
