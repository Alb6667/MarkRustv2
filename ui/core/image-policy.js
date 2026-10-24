/*
 * Kebijakan pemuatan gambar jarak jauh.
 *
 * Masalah: CSP lama mengizinkan `img-src https:`. Membuka dokumen Markdown
 * dari pihak lain lalu langsung memicu permintaan ke server mereka —“beacon”
 * yang membocorkan kapan dan di mana dokumen itu dibuka.
 *
 * Kebijakan default: SEMUA gambar http/https diblokir. URL aslinya tetap
 * disimpan (di atribut data pada blot Quill), jadi berkas .md tidak rusak.
 * Gambar dimuat hanya bila:
 *   - pengguna menyisipkannya sendiri lewat dialog (persetujuan eksplisit), atau
 *   - pengguna menekan tombol "Muat gambar" pada dokumen yang sedang dibuka.
 *
 * Allow-list HANYA berlaku untuk dokumen saat ini. Membuka berkas lain atau
 * membuat dokumen baru memanggil resetImagePolicy(), sehingga dokumen asing
 * berikutnya kembali aman. Sengaja tidak di-persist ke localStorage.
 */

const allowedUrls = new Set();
let allowAllForCurrentDocument = false;

/** Placeholder lokal (data URI) — tidak pernah menyentuh jaringan. */
export const IMAGE_PLACEHOLDER =
  'data:image/svg+xml;charset=utf-8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="76" viewBox="0 0 480 76">' +
    '<rect width="480" height="76" rx="10" fill="#1d2127"/>' +
    '<rect x="0.5" y="0.5" width="479" height="75" rx="9.5" fill="none" stroke="#3a414b"/>' +
    '<circle cx="26" cy="38" r="9" fill="none" stroke="#7c848f" stroke-width="1.6"/>' +
    '<path d="M22 38h8M26 34v8" stroke="#7c848f" stroke-width="1.6" stroke-linecap="round"/>' +
    '<text x="46" y="34" fill="#a7adb6" font-family="sans-serif" font-size="12.5">' +
    'Gambar jarak jauh diblokir</text>' +
    '<text x="46" y="52" fill="#7c848f" font-family="sans-serif" font-size="11">' +
    'URL tetap tersimpan — klik “Muat gambar” di bawah untuk menampilkannya' +
    '</text></svg>'
  );

export function isRemoteImageUrl(url) {
  // `//host/path` (protocol-relative) juga memicu request: browser mengisi
  // skemanya dari halaman. Tanpa ini, pelaku cukup menulis //tracker.example/x
  // untuk melewati pemblokiran. Karakter kontrol disingkirkan dulu agar
  // variasi seperti "\nhttps://..." tidak lolos.
  var cleaned = String(url == null ? '' : url)
    .replace(/[\u0000-\u0020\u007f]/g, '')
    .trim();
  return /^(?:https?:)?\/\//i.test(cleaned);
}

export function isPlaceholderUrl(url) {
  return String(url || '').startsWith(IMAGE_PLACEHOLDER.slice(0, 40));
}

export function resetImagePolicy() {
  allowedUrls.clear();
  allowAllForCurrentDocument = false;
}

/** Izinkan satu URL (dipakai saat pengguna menyisipkan gambar sendiri). */
export function allowRemoteImage(url) {
  if (url) allowedUrls.add(String(url));
}

/** Izinkan semua URL pada dokumen saat ini (tombol "Muat gambar"). */
export function allowAllRemoteImages(urls) {
  allowAllForCurrentDocument = true;
  (urls || []).forEach(function (u) { if (u) allowedUrls.add(String(u)); });
}

export function isRemoteImageAllowed(url) {
  return allowAllForCurrentDocument || allowedUrls.has(String(url || ''));
}

export function allowedUrlCount() {
  return allowedUrls.size;
}

/** Apakah URL ini harus diganti placeholder saat dirender? */
export function shouldBlockRemoteImage(url) {
  return isRemoteImageUrl(url) && !isRemoteImageAllowed(url);
}
