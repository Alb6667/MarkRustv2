/*
 * Registrasi khusus Quill 2 yang dipakai bersama oleh aplikasi DAN tes.
 * Dipisahkan agar perilaku clipboard di harness pengujian identik dengan
 * perilaku di webview Tauri (bukan tiruan yang bisa menyimpang).
 */

let registered = new WeakSet();

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
