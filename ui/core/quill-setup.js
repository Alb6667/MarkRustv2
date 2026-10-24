/*
 * Registrasi khusus Quill 2 yang dipakai bersama oleh aplikasi DAN tes.
 * Dipisahkan agar perilaku clipboard di harness pengujian identik dengan
 * perilaku di webview Tauri (bukan tiruan yang bisa menyimpang).
 */
import {
  IMAGE_PLACEHOLDER, shouldBlockRemoteImage, isRemoteImageAllowed
} from './image-policy.js';

const registered = new WeakSet();

/** Quill 2.0.3 tidak menyertakan blot <hr>. Harus ES class: Parchment menolak
 *  membuat blot dari fungsi konstruktor biasa. */
export function registerDividerBlot(Quill) {
  if (registered.has(Quill)) return;
  const BlockEmbed = Quill.import('blots/block/embed');
  class DividerBlot extends BlockEmbed { }
  DividerBlot.blotName = 'divider';
  DividerBlot.tagName = 'HR';
  DividerBlot.value = function () { return true; };
  Quill.register(DividerBlot, true);
  registered.add(Quill);
}

/** <hr> tetap tidak dikenali clipboard walaupun blot sudah terdaftar. */
export function registerHrMatcher(quill, Quill) {
  const Delta = Quill.import('delta');
  if (!Delta) return;
  quill.clipboard.addMatcher('hr', function () {
    return new Delta().insert({ divider: true });
  });
}

const safeImageRegistered = new WeakSet();

/**
 * Ganti blot `image` bawaan Quill dengan versi yang menahan gambar jarak jauh.
 *
 * Kuncinya: `create()` menulis URL asli ke atribut `data-mr-src` dan mengganti
 * `src` dengan placeholder data-URI, sedangkan `value()` membaca kembali
 * `data-mr-src` lebih dulu. Akibatnya model data (Delta) TETAP berisi URL asli
 * —serializer Markdown tidak rusak— sementara DOM tidak pernah memuat
 * sumber jaringan sampai pengguna mengizinkannya.
 *
 * Harus dipanggil sebelum instance Quill dibuat. Idempoten per konstruktor.
 */
export function registerSafeImageBlot(Quill) {
  if (safeImageRegistered.has(Quill)) return;
  const BaseImage = Quill.import('formats/image');
  if (!BaseImage) return;

  class SafeImageBlot extends BaseImage {
    static blotName = 'image';
    static tagName = 'IMG';

    static create(value) {
      const url = String(value == null ? '' : value);
      const blocked = shouldBlockRemoteImage(url);
      // Jangan berikan URL asli kepada blot bawaan: super.create(value) menulis
      // `src` langsung dan browser dapat mem-fetch sebelum placeholder dipasang.
      const node = super.create(blocked ? IMAGE_PLACEHOLDER : value);
      if (blocked) node.setAttribute('data-mr-src', url);
      return node;
    }

    static value(node) {
      return node.getAttribute('data-mr-src') || super.value(node);
    }
  }

  Quill.register(SafeImageBlot, true);
  safeImageRegistered.add(Quill);
}

/**
 * Matcher clipboard untuk <img>. `data-mr-src` diprioritaskan supaya gambar
 * yang sudah terlanjur ber-placeholder tidak berubah nilainya saat dipaste
 * ulang (misalnya saat berpindah mode WYSIWYG -> Markdown -> WYSIWYG).
 * Atribut `alt` ikut dibawa agar tidak hilang saat round-trip.
 */
export function registerImageMatcher(quill, Quill) {
  const Delta = Quill.import('delta');
  if (!Delta) return;
  quill.clipboard.addMatcher('img', function (node) {
    const original = node.getAttribute('data-mr-src') ||
      node.getAttribute('src') || '';
    if (!original) return new Delta();
    const attrs = {};
    const alt = node.getAttribute('alt');
    if (alt) attrs.alt = alt;
    return new Delta().insert({ image: original }, attrs);
  });
}

/** Replace one held URL with an already validated local data source. The
 * original remote URL stays in data-mr-src for Delta/Markdown round-trip. */
export function revealImageSource(quill, original, source) {
  if (!quill || !quill.root || !original || !source) return 0;
  const nodes = quill.root.querySelectorAll('img[data-mr-src]');
  let count = 0;
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].getAttribute('data-mr-src') !== original) continue;
    nodes[i].setAttribute('src', source);
    nodes[i].setAttribute('data-mr-loaded', 'true');
    count++;
  }
  return count;
}

/** Browser fallback: reveal only URLs explicitly allowed for this document. */
export function revealAllowedImages(quill) {
  if (!quill || !quill.root) return 0;
  const nodes = quill.root.querySelectorAll('img[data-mr-src]');
  let count = 0;
  for (let i = 0; i < nodes.length; i++) {
    const original = nodes[i].getAttribute('data-mr-src');
    if (!original || !isRemoteImageAllowed(original)) continue;
    nodes[i].setAttribute('src', original);
    nodes[i].setAttribute('data-mr-loaded', 'true');
    count++;
  }
  return count;
}
