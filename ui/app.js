/*
 * MarkRust — logika UI editor.
 *
 * Konversi arah:
 *   Markdown -> WYSIWYG : marked.parse()  -> normalisasi DOM -> Quill clipboard
 *   WYSIWYG  -> Markdown: Delta Quill    -> serializeLines()
 *
 * Seluruh logika konversi ada di ./core/ (modul murni, tanpa ketergantungan
 * pada instance Quill / window), supaya bisa diuji di Node. File ini hanya
 * mengurung hal-hal yang memang butuh DOM: inisialisasi Quill, toolbar, mode,
 * dan statistik.
 */
import {
  linesFromQuill,
  serializeLines
} from './core/serialize.js';
import {
  mdToQuillHtml,
  documentStats,
  remoteImageCount,
  isValidImageUrl
} from './core/markdown.js';
import {
  registerDividerBlot, registerHrMatcher,
  registerSafeImageBlot, registerImageMatcher, revealAllowedImages
} from './core/quill-setup.js';
import {
  resetImagePolicy, allowRemoteImage, allowAllRemoteImages,
  isRemoteImageAllowed
} from './core/image-policy.js';
import {
  getTauriApi, openWithTauri, saveWithTauri, readBrowserFile,
  downloadBrowserFile, confirmDiscard, confirmSaveOnClose, confirmRestore,
  showError, setWindowTitle, basename, isMarkdownFilename, titleFor,
  DEFAULT_FILENAME
} from './core/files.js';
import {
  readDraft, saveDraft, clearDraft, restoreMessage, DRAFT_KEY
} from './core/drafts.js';

const Quill = window.Quill;
const marked = window.marked;
const hljs = window.hljs;

if (!Quill || !marked) {
  document.body.innerHTML =
    '<p style="padding:24px;font-family:sans-serif">Gagal memuat library editor (Quill / marked).</p>';
} else {
  boot();
}

function boot() {
  // `withGlobalTauri: true` menyuntikkan API vanilla JS ke window.__TAURI__.
  // Null di browser biasa -> semua operasi berkas memakai fallback.
  const tauri = getTauriApi();

  /* =========================================================
   * 1. Blot divider — modul bersama dengan harness tes
   * ======================================================= */
  registerDividerBlot(Quill);
  // Harus sebelum `new Quill()` agar blot pengganti dipakai sejak awal.
  registerSafeImageBlot(Quill);

  /* =========================================================
   * 2. Bahasa yang tersedia untuk syntax highlighting
   * ======================================================= */
  const SYNTAX_LANGS = [
    ['plain', 'Plain'], ['bash', 'Bash'], ['c', 'C'], ['cpp', 'C++'],
    ['csharp', 'C#'], ['css', 'CSS'], ['diff', 'Diff'], ['dockerfile', 'Dockerfile'],
    ['go', 'Go'], ['http', 'HTTP'], ['ini', 'INI'], ['java', 'Java'],
    ['javascript', 'JavaScript'], ['json', 'JSON'], ['kotlin', 'Kotlin'],
    ['makefile', 'Makefile'], ['markdown', 'Markdown'], ['php', 'PHP'],
    ['python', 'Python'], ['ruby', 'Ruby'], ['rust', 'Rust'], ['scss', 'SCSS'],
    ['sql', 'SQL'], ['swift', 'Swift'], ['typescript', 'TypeScript'],
    ['xml', 'HTML/XML'], ['yaml', 'YAML']
  ].map(function (p) { return { key: p[0], label: p[1] }; });

  // highlight.js melempar error untuk bahasa yang tidak terdaftar; bungkus agar aman.
  function buildSafeHljs(base) {
    const esc = function (s) {
      return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    };
    const safe = Object.create(base);
    safe.highlight = function (code, opts) {
      const lang = opts && opts.language;
      try {
        if (lang && lang !== 'plain' && !base.getLanguage(lang)) return { value: esc(code) };
        if (lang === 'plain') return { value: esc(code) };
        return base.highlight(code, opts);
      } catch (e) {
        return { value: esc(code) };
      }
    };
    return safe;
  }

  /* =========================================================
   * 3. Inisialisasi Quill
   * ======================================================= */
  // Header berupa tombol independen (H1/H2/H3), bukan dropdown — sama seperti
  // tombol format lain. Klik pada header yang aktif mengembalikan teks normal.
  const toolbarOptions = [
    [{ header: '1' }, { header: '2' }, { header: '3' }],
    ['bold', 'italic', 'underline', 'strike'],
    [{ 'color': [] }, { 'background': [] }],
    [{ 'list': 'ordered' }, { 'list': 'bullet' }],
    ['blockquote', 'code-block'],
    ['link', 'image'],
    ['clean']
  ];

  // Gambar dimasukkan lewat URL. `data:image/` sengaja DITOLAK: base64 membuat
  // berkas .md membengkak. Dialog memakai <dialog> native, bukan window.prompt
  // yang tidak reliabel di WKWebView/Tauri (bisa gagal diam-diam di macOS).
  let pendingImageRange = null;
  const imageDialog = document.getElementById('image-dialog');
  const imageForm = document.getElementById('image-form');
  const imageInput = document.getElementById('image-url');
  const imageError = document.getElementById('image-error');

  function imageHandler() {
    pendingImageRange = quill.getSelection(true);
    imageInput.value = '';
    imageError.textContent = '';
    if (typeof imageDialog.showModal === 'function') imageDialog.showModal();
    else imageDialog.setAttribute('open', '');
    imageInput.focus();
  }

  document.getElementById('image-cancel').addEventListener('click', function () {
    if (typeof imageDialog.close === 'function') imageDialog.close();
    else imageDialog.removeAttribute('open');
    quill.focus();
  });

  imageForm.addEventListener('submit', function (e) {
    e.preventDefault();
    const clean = imageInput.value.trim();
    if (!isValidImageUrl(clean)) {
      imageError.textContent = 'Gunakan alamat http:// atau https://';
      imageInput.focus();
      return;
    }
    const idx = pendingImageRange ? pendingImageRange.index
      : (quill.getSelection(true) || { index: 0 }).index;
    // URL dimasukkan sendiri lewat dialog => persetujuan eksplisit.
    allowRemoteImage(clean);
    quill.insertEmbed(idx, 'image', clean, 'user');
    quill.setSelection(idx + 1, 0, 'user');
    if (typeof imageDialog.close === 'function') imageDialog.close();
    else imageDialog.removeAttribute('open');
    quill.focus();
  });

  // `toolbar` sengaja dikirim sebagai ARRAY, bukan objek
  // `{ container: [...], handlers: {...} }`. Quill 2.0.3 menormalkan opsi
  // dengan `u.toolbar.constructor !== Object`; objek yang dibuat di realm
  // berbeda (mis. saat app.js dimuat sebagai ES module di luar realm skrip
  // UMD) akan dianggap bukan Object, dibungkus dua kali, dan modul toolbar
  // gagal dibuat. Array selalu aman; handler khusus dipasang setelah init.
  const modules = {
    toolbar: toolbarOptions,
    clipboard: { matchVisual: false }
  };
  if (hljs) {
    modules.syntax = { hljs: buildSafeHljs(hljs), interval: 500, languages: SYNTAX_LANGS };
  }

  const quill = new Quill('#editor', {
    modules: modules,
    theme: 'snow',
    placeholder: 'Mulai mengetik di sini... (mode WYSIWYG)'
  });

  // Pindahkan toolbar Quill ke dalam toolbar aplikasi, lalu pasang handler
  // gambar kustom (menggantikan handler bawaan Quill yang memakai prompt).
  const toolbarModule = quill.getModule('toolbar');
  if (toolbarModule) {
    if (toolbarModule.container) {
      document.getElementById('quill-toolbar').appendChild(toolbarModule.container);
    }
    if (typeof toolbarModule.addHandler === 'function') {
      toolbarModule.addHandler('image', imageHandler);
    }
  }

  registerHrMatcher(quill, Quill);
  registerImageMatcher(quill, Quill);

  /* =========================================================
   * 4. Konversi (delegasi ke modul murni)
   * ======================================================= */
  function toHtml(md) {
    return mdToQuillHtml(md, function (src) {
      return marked.parse(String(src || ''), { gfm: true, breaks: false, async: false });
    });
  }

  function quillToMarkdown() {
    return serializeLines(linesFromQuill(quill));
  }

  /* =========================================================
   * 5. Mode WYSIWYG <-> Markdown
   * ======================================================= */
  const editorWrap = document.getElementById('editor-wrap');
  const rawView = document.getElementById('raw-view');
  const textarea = document.getElementById('raw-textarea');
  const btnWysiwyg = document.getElementById('btn-wysiwyg');
  const btnMarkdown = document.getElementById('btn-markdown');
  const sbMode = document.getElementById('sb-mode');
  const sbDirty = document.getElementById('sb-dirty');
  const sbNotice = document.getElementById('sb-notice');
  const sbFile = document.getElementById('sb-file');
  const btnLoadImages = document.getElementById('sb-load-images');
  let currentMode = 'wysiwyg';
  let currentPath = null;
  let dirty = false;
  let documentGeneration = 0;
  let editRevision = 0;
  let saveInProgress = false;

  function getCanonicalMarkdown() {
    return currentMode === 'markdown' ? textarea.value : quillToMarkdown();
  }

  function refreshTitle() {
    const name = currentPath ? basename(currentPath) : 'Tanpa Judul';
    sbFile.textContent = name;
    sbFile.title = currentPath || '';
    setWindowTitle(tauri, titleFor(currentPath, dirty));
  }

  /* ---------------------------------------------------------
   * Draft recovery
   *
   * Konfirmasi tutup tidak cukup: force-quit / crash / Cmd+Q di macOS bisa
   * melewati event close. Draf disimpan ke localStorage webview saat dokumen
   * kotor, lalu ditawarkan kembali pada startup berikutnya.
   * -------------------------------------------------------*/
  let draftStorage = null;
  try { draftStorage = window.localStorage || null; } catch (e) { draftStorage = null; }

  const DRAFT_DEBOUNCE = 700;
  let draftTimer = null;

  function writeDraftNow() {
    if (!dirty) return false;
    return saveDraft(draftStorage, {
      markdown: getCanonicalMarkdown(),
      path: currentPath,
      savedAt: Date.now()
    });
  }

  /** Paksa tulis draf sekarang (dipakai sebelum dialog tutup / pagehide). */
  function flushDraft() {
    clearTimeout(draftTimer);
    draftTimer = null;
    return writeDraftNow();
  }

  function scheduleDraftSave() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(function () {
      draftTimer = null;
      writeDraftNow();
    }, DRAFT_DEBOUNCE);
    // Jangan biarkan timer debounce menahan proses Node saat pengujian.
    try { if (draftTimer && typeof draftTimer.unref === 'function') draftTimer.unref(); }
    catch (e) { /* browser mengembalikan angka */ }
  }

  function discardDraft() {
    clearTimeout(draftTimer);
    draftTimer = null;
    clearDraft(draftStorage);
  }

  function markDirty() {
    editRevision++;
    scheduleDraftSave();
    // Dijaga supaya IPC setTitle tidak dikirim pada setiap ketikan setelah
    // dokumen sudah berstatus kotor.
    if (dirty) return;
    dirty = true;
    sbDirty.hidden = false;
    refreshTitle();
  }

  function markClean() {
    dirty = false;
    sbDirty.hidden = true;
    refreshTitle();
    // SENGATA tidak menghapus draf di sini: markClean() juga dipanggil saat
    // boot, dan itu akan menghilangkan draf sebelum sempat ditawarkan.
    // Penghapusan dilakukan eksplisit oleh aksi simpan/buang di bawah.
  }

  /* ---------------------------------------------------------
   * Toolbar auto-hide + pin
   * -------------------------------------------------------*/
  const app = document.getElementById('app');
  const toolbar = document.getElementById('toolbar');
  const btnPin = document.getElementById('btn-pin');

  const EDGE = 8;      // zona pemicu di tepi atas jendela (px)
  const SLACK = 12;    // toleransi agar toolbar tak menutup saat pointer sedikit turun
  const GRACE = 400;   // jeda sebelum turun lagi (ms)
  const PIN_KEY = 'markrust.toolbar.pinned';

  let pinned = true;
  try {
    const stored = localStorage.getItem(PIN_KEY);
    if (stored !== null) pinned = stored === '1';
  } catch (e) { pinned = true; }
  let tbFocus = false;
  let tbTimer = null;
  // 9999 = pointer belum pernah berada dekat tepi atas.
  let lastY = 9999;

  function isToolbarShown() { return !app.classList.contains('tb-hidden'); }

  // Jangan sembunyikan toolbar saat pengguna sedang memilih teks — momen itu
  // justru ketika tombol format paling dibutuhkan.
  function hasTextSelection() {
    const sel = quill.getSelection();
    return !!(sel && sel.length > 0);
  }

  function syncToolbarHeight() {
    document.documentElement.style.setProperty('--toolbar-h', toolbar.offsetHeight + 'px');
  }

  function setToolbarShown(shown) {
    clearTimeout(tbTimer);
    tbTimer = null;
    app.classList.toggle('tb-hidden', !shown);
  }

  function scheduleHide() {
    if (pinned || tbFocus || hasTextSelection()) return;
    clearTimeout(tbTimer);
    tbTimer = setTimeout(function () {
      tbTimer = null;
      if (pinned || tbFocus || hasTextSelection()) return;
      app.classList.add('tb-hidden');
    }, GRACE);
  }

  function onPointerMove(e) {
    if (typeof e.clientY === 'number') lastY = e.clientY;
    if (pinned || tbFocus) { app.classList.remove('tb-hidden'); return; }

    const h = toolbar.offsetHeight;
    const inZone = lastY <= EDGE || (isToolbarShown() && lastY <= h + SLACK);
    if (inZone) setToolbarShown(true);
    else scheduleHide();
  }

  document.addEventListener('pointermove', onPointerMove);

  // Aksesibilitas: Tab ke kontrol toolbar harus menampilkannya.
  toolbar.addEventListener('focusin', function () {
    tbFocus = true;
    setToolbarShown(true);
  });
  toolbar.addEventListener('focusout', function () {
    tbFocus = false;
    scheduleHide();
  });

  if (btnPin) {
    btnPin.setAttribute('aria-pressed', pinned ? 'true' : 'false');
    btnPin.addEventListener('click', function () {
      pinned = !pinned;
      btnPin.setAttribute('aria-pressed', pinned ? 'true' : 'false');
      try { localStorage.setItem(PIN_KEY, pinned ? '1' : '0'); } catch (err) { /* abaikan */ }
      if (pinned) setToolbarShown(true);
      else scheduleHide();
    });
  }

  if (pinned) {
    app.classList.remove('tb-hidden');
  } else {
    // Tampil sebentar saat dimuat supaya jelas toolbar-nya ada, lalu turun.
    setTimeout(function () {
      if (!pinned && !tbFocus && lastY > EDGE) scheduleHide();
    }, 2500);
  }

  if (window.ResizeObserver) {
    new window.ResizeObserver(syncToolbarHeight).observe(toolbar);
  } else {
    window.addEventListener('resize', syncToolbarHeight);
  }
  syncToolbarHeight();

  function loadMarkdownIntoQuill(md) {
    const html = toHtml(md);
    quill.setContents([{ insert: '\n' }], 'silent');
    quill.clipboard.dangerouslyPasteHTML(0, html, 'api');
    if (quill.history && quill.history.clear) quill.history.clear();
    updateStats();
  }

  function setMode(mode) {
    if (mode === currentMode) return;

    if (mode === 'markdown') {
      textarea.value = quillToMarkdown();
      editorWrap.style.display = 'none';
      rawView.style.display = 'flex';
      textarea.focus();
    } else {
      loadMarkdownIntoQuill(textarea.value);
      rawView.style.display = 'none';
      editorWrap.style.display = 'flex';
    }

    currentMode = mode;
    btnWysiwyg.classList.toggle('active', mode === 'wysiwyg');
    btnMarkdown.classList.toggle('active', mode === 'markdown');
    sbMode.textContent = mode === 'wysiwyg' ? 'WYSIWYG' : 'Markdown';
    updateStats();
  }

  btnWysiwyg.addEventListener('click', function () { setMode('wysiwyg'); });
  btnMarkdown.addEventListener('click', function () { setMode('markdown'); });

  /* =========================================================
   * 5b. Operasi berkas (Tauri + fallback browser)
   * ======================================================= */
  function toggleMode() {
    setMode(currentMode === 'wysiwyg' ? 'markdown' : 'wysiwyg');
  }

  /** Terapkan dokumen ke mode yang sedang aktif. */
  function applyDocument(md) {
    documentGeneration++;
    // Dokumen baru = kepercayaan baru. Izin gambar tidak boleh menular dari
    // dokumen sebelumnya ke dokumen yang baru dibuka.
    resetImagePolicy();
    if (currentMode === 'markdown') {
      textarea.value = md;
      updateStats();
    } else {
      loadMarkdownIntoQuill(md); // sudah memanggil updateStats()
    }
  }

  function pickBrowserFile() {
    return new Promise(function (resolve) {
      if (typeof document === 'undefined') { resolve(null); return; }
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.md,.markdown,.txt';
      input.addEventListener('change', function () {
        const file = input.files && input.files[0];
        if (!file) { resolve(null); return; }
        readBrowserFile(file).then(resolve, function (err) {
          showError(tauri, err && err.message ? err.message : String(err));
          resolve(null);
        });
      });
      input.click();
    });
  }

  async function newDocument() {
    if (dirty && !(await confirmDiscard(tauri))) return false;
    discardDraft();
    currentPath = null;
    applyDocument('');
    markClean();
    if (currentMode === 'wysiwyg') quill.focus();
    return true;
  }

  async function openDocument() {
    if (dirty && !(await confirmDiscard(tauri))) return false;
    try {
      const result = tauri ? await openWithTauri(tauri) : await pickBrowserFile();
      if (!result) return false;
      discardDraft();
      currentPath = result.path;
      applyDocument(result.contents);
      markClean();
      return true;
    } catch (err) {
      await showError(tauri, err && err.message ? err.message : String(err));
      return false;
    }
  }

  async function saveDocument(saveAs) {
    // Never overlap writes to the same temporary file or race save dialogs.
    if (saveInProgress) return false;
    saveInProgress = true;
    const generation = documentGeneration;
    const revision = editRevision;
    try {
      const contents = getCanonicalMarkdown();
      let savedPath;
      if (tauri) {
        savedPath = await saveWithTauri(tauri, {
          path: currentPath, contents: contents, saveAs: !!saveAs
        });
      } else {
        savedPath = downloadBrowserFile(
          currentPath ? basename(currentPath) : DEFAULT_FILENAME, contents);
      }
      if (!savedPath) return false;
      // An old save must not rename/clean a different document opened meanwhile.
      if (generation !== documentGeneration) return false;
      currentPath = savedPath;
      if (revision !== editRevision || contents !== getCanonicalMarkdown()) {
        refreshTitle();
        flushDraft(); // Preserve edits made while the disk write/dialog was pending.
        return false; // Not all current edits are saved; close must remain blocked.
      }
      discardDraft();
      markClean();
      return true;
    } catch (err) {
      await showError(tauri, err && err.message ? err.message : String(err));
      return false;
    } finally {
      saveInProgress = false;
    }
  }

  async function handleMenuAction(action) {
    switch (action) {
      case 'new': return newDocument();
      case 'open': return openDocument();
      case 'save': return saveDocument(false);
      case 'save_as': return saveDocument(true);
      case 'toggle_mode': toggleMode(); return true;
      default: return false;
    }
  }

  document.getElementById('btn-new').addEventListener('click', newDocument);
  document.getElementById('btn-open').addEventListener('click', openDocument);
  document.getElementById('btn-save').addEventListener('click', function (e) {
    saveDocument(e.shiftKey);
  });

  // Pintasan keyboard ditangani terpusat di sini. Menu native sengaja tidak
  // memasang accelerator supaya tidak ada dobel-trigger Ctrl+S.
  document.addEventListener('keydown', function (e) {
    if (!(e.ctrlKey || e.metaKey)) return;
    const key = String(e.key || '').toLowerCase();
    if (key === 's') { e.preventDefault(); saveDocument(e.shiftKey); }
    else if (key === 'o') { e.preventDefault(); openDocument(); }
    else if (key === 'n') { e.preventDefault(); newDocument(); }
    else if (key === 'm' && e.shiftKey) { e.preventDefault(); toggleMode(); }
  });

  // Event dari menu native Rust (Berkas > ...).
  if (tauri && tauri.event && typeof tauri.event.listen === 'function') {
    try {
      tauri.event.listen('markrust://menu', function (event) {
        handleMenuAction(event && event.payload);
      });
    } catch (e) { /* diabaikan: frontend tetap bisa lewat tombol & shortcut */ }
  }

  // Drag & drop berkas .md (berjalan di webview maupun browser).
  document.addEventListener('dragover', function (e) { e.preventDefault(); });
  document.addEventListener('drop', function (e) {
    const dt = e.dataTransfer;
    const file = dt && dt.files && dt.files[0];
    if (!file) return;
    e.preventDefault();
    if (!isMarkdownFilename(file.name)) {
      showError(tauri, 'Berkas harus berekstensi .md, .markdown, atau .txt');
      return;
    }
    readBrowserFile(file).then(async function (result) {
      if (dirty && !(await confirmDiscard(tauri))) return;
      discardDraft();
      currentPath = result.path;
      applyDocument(result.contents);
      markClean();
    }, function (err) {
      showError(tauri, err && err.message ? err.message : String(err));
    });
  });

  /* Konfirmasi tutup jendela native (tombol X / Alt+F4).
     Tidak memakai preventDefault() secara permanen: bila handler async
     selesai tanpa mencegah, Tauri meneruskan penutupan. Draf sudah ditulis
     lebih dulu, jadi memilih "keluar tanpa menyimpan" tetap aman. */
  let closeHandlerRegistered = false;
  if (tauri && tauri.window && typeof tauri.window.getCurrentWindow === 'function') {
    try {
      const win = tauri.window.getCurrentWindow();
      if (win && typeof win.onCloseRequested === 'function') {
        win.onCloseRequested(async function (event) {
          if (!dirty) return;
          flushDraft();
          const saveFirst = await confirmSaveOnClose(tauri);
          if (!saveFirst) return; // draf tersimpan, tutup boleh dilanjutkan
          const ok = await saveDocument(false);
          if (!ok && event && typeof event.preventDefault === 'function') {
            event.preventDefault(); // gagal menyimpan -> jangan tutup
          }
        });
        closeHandlerRegistered = true;
      }
    } catch (e) { /* draf tetap menjadi jaminan */ }
  }

  /* Tawarkan pemulihan draf dari sesi sebelumnya. Dipanggil setelah konten
     awal dimuat, sehingga pengguna punya pembanding sebelum memutuskan. */
  async function restoreDraftIfAny() {
    const draft = readDraft(draftStorage);
    if (!draft) return false;
    const ok = await confirmRestore(tauri, restoreMessage(draft.savedAt));
    if (!ok) { discardDraft(); return false; }
    currentPath = draft.path || null;
    applyDocument(draft.markdown);
    markClean();          // reset dulu supaya markDirty() tidak di-skip
    markDirty();          // dokumen hasil pemulihan memang belum tersimpan
    return true;
  }

  function onPageHide() { flushDraft(); }

  window.addEventListener('beforeunload', function (e) {
    onPageHide();
    // Di Tauri, konfirmasi sudah ditangani onCloseRequested. Mencegah di sini
    // juga bisa memunculkan dialog webview kedua di atas dialog native.
    if (tauri || !dirty) return;
    e.preventDefault();
    e.returnValue = '';
  });
  window.addEventListener('pagehide', onPageHide);

  /* =========================================================
   * 6. Statistik — selalu dari sumber Markdown kanonik yang sama.
   * ======================================================= */
  let statsTimer = null;
  function updateStats() {
    const canonical = getCanonicalMarkdown();
    const stats = documentStats(canonical);
    document.getElementById('stat-words').textContent = 'Words: ' + stats.words;
    document.getElementById('stat-chars').textContent = 'Chars: ' + stats.chars;

    // Hitung dari DOM, bukan hanya dari teks: yang penting adalah berapa
    // gambar yang BENAR-BENAR masih tertahan, bukan sekadar jumlah URL.
    const held = quill.root.querySelectorAll('img[data-mr-src]');
    const blocked = [];
    for (let i = 0; i < held.length; i++) {
      const url = held[i].getAttribute('data-mr-src');
      if (url && !isRemoteImageAllowed(url)) blocked.push(url);
    }
    const total = remoteImageCount(canonical);

    if (blocked.length) {
      sbNotice.hidden = false;
      sbNotice.textContent = blocked.length + ' gambar jarak jauh diblokir';
      btnLoadImages.hidden = false;
      btnLoadImages.textContent = 'Muat gambar (' + blocked.length + ')';
      btnLoadImages.dataset.count = String(blocked.length);
    } else {
      btnLoadImages.hidden = true;
      sbNotice.hidden = total === 0;
      sbNotice.textContent = total
        ? total + ' gambar jarak jauh diizinkan'
        : '';
    }
  }

  async function loadRemoteImages() {
    const nodes = quill.root.querySelectorAll('img[data-mr-src]');
    const urls = [];
    for (let i = 0; i < nodes.length; i++) {
      const u = nodes[i].getAttribute('data-mr-src');
      if (u) urls.push(u);
    }
    if (!urls.length) return 0;
    allowAllRemoteImages(urls);
    const revealed = revealAllowedImages(quill);
    updateStats();
    return revealed;
  }

  btnLoadImages.addEventListener('click', loadRemoteImages);

  // Debounce: serializeLines() berjalan tiap ketikan kalau tidak ditunda.
  function scheduleStats() {
    clearTimeout(statsTimer);
    statsTimer = setTimeout(updateStats, 120);
  }

  quill.on('text-change', function (delta, oldDelta, source) {
    if (source === 'user') markDirty();
    scheduleStats();
  });
  textarea.addEventListener('input', function () {
    markDirty();
    scheduleStats();
  });

  /* =========================================================
   * 7. Konten awal
   * ======================================================= */
  const defaultMarkdown = [
    '# Selamat Datang di MarkRust ✨',
    '',
    'Ini adalah **WYSIWYG Markdown Editor** yang dibuat dengan *Rust* + *Tauri*.',
    '',
    '## Cara Pakai',
    '',
    'Ketik langsung di area editor. Semua formatting **langsung terlihat** saat kamu',
    'mengetik — tidak perlu split view!',
    '',
    '### Fitur',
    '',
    '- **Bold**, *italic*, ~~strikethrough~~ langsung terlihat',
    '- Heading, blok kutipan, dan daftar (termasuk daftar bersarang)',
    '- Code block dengan syntax highlighting',
    '- Tabel, task list, tautan, gambar, dan garis pemisah',
    '',
    '### Contoh Code',
    '',
    '```rust',
    'fn main() {',
    '    println!("Hello, MarkRust!");',
    '}',
    '```',
    '',
    '> “Simplicity is the ultimate sophistication.”',
    '> — Leonardo da Vinci',
    '',
    '---',
    '',
    '| Format | Contoh |',
    '| --- | --- |',
    '| Tebal | **teks** |',
    '| Kode | `kode` |',
    '',
    'Ganti mode lewat dua tombol di kiri atas toolbar. 🚀',
    ''
  ].join('\n');

  loadMarkdownIntoQuill(defaultMarkdown);
  markClean();
  restoreDraftIfAny();

  // Jembatan untuk pengujian dan untuk integrasi Tauri di kemudian hari.
  window.MarkRust = {
    quill: quill,
    setMode: setMode,
    quillToMarkdown: quillToMarkdown,
    mdToQuillHtml: toHtml,
    getMarkdown: getCanonicalMarkdown,
    setMarkdown: function (md) {
      // Jembatan ini dipakai untuk mengganti dokumen, bukan sekadar toggle
      // mode. Reset kebijakan agar izin gambar tidak menular ke dokumen baru.
      documentGeneration++;
      resetImagePolicy();
      return loadMarkdownIntoQuill(md);
    },
    getStats: function () { return documentStats(getCanonicalMarkdown()); },
    isDirty: function () { return dirty; },
    markClean: markClean,
    getPath: function () { return currentPath; },
    newDocument: newDocument,
    openDocument: openDocument,
    saveDocument: saveDocument,
    handleMenuAction: handleMenuAction,
    restoreDraftIfAny: restoreDraftIfAny,
    loadRemoteImages: loadRemoteImages,
    flushDraft: flushDraft,
    discardDraft: discardDraft,
    draftKey: DRAFT_KEY,
    isCloseHandlerRegistered: function () { return closeHandlerRegistered; },
    isToolbarPinned: function () { return pinned; },
    isToolbarVisible: isToolbarShown
  };
}
