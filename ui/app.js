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
  documentStats
} from './core/markdown.js';
import {
  registerDividerBlot,
  registerHrMatcher
} from './core/quill-setup.js';

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

  /* =========================================================
   * 1. Blot divider — modul bersama dengan harness tes
   * ======================================================= */
  registerDividerBlot(Quill);

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
  // berkas .md membengkak dan tidak bisa dibaca ulang sebagai tautan.
  function imageHandler() {
    const range = quill.getSelection(true);
    const url = window.prompt('URL gambar:');
    if (!url) return;
    const clean = url.trim();
    if (!/^https?:\/\//i.test(clean)) {
      window.alert('URL tidak valid.\nGunakan http:// atau https://');
      return;
    }
    quill.insertEmbed(range.index, 'image', clean, 'user');
    quill.setSelection(range.index + 1, 0, 'user');
  }

  const modules = {
    toolbar: { container: toolbarOptions, handlers: { image: imageHandler } },
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

  // Pindahkan toolbar Quill ke dalam toolbar aplikasi.
  const toolbarModule = quill.getModule('toolbar');
  if (toolbarModule && toolbarModule.container) {
    document.getElementById('quill-toolbar').appendChild(toolbarModule.container);
  }

  registerHrMatcher(quill, Quill);

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
  const wordcount = document.getElementById('wordcount');
  let currentMode = 'wysiwyg';

  function getCanonicalMarkdown() {
    return currentMode === 'markdown' ? textarea.value : quillToMarkdown();
  }

  /* Widget word count disembunyikan saat menganggur dan dimunculkan sementara
     ketika pointer bergerak atau saat ada ketikan. */
  let wcTimer = null;
  function revealWordCount() {
    if (!wordcount) return;
    wordcount.classList.add('is-visible');
    clearTimeout(wcTimer);
    wcTimer = setTimeout(function () {
      wordcount.classList.remove('is-visible');
    }, 1800);
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

  let lastReveal = 0;
  function onPointerMove(e) {
    // Throttle: pointermove bisa ratusan kali per detik; reset timer di setiap
    // event itu sia-sia. 120ms cukup untuk membuat widget tetap terasa hidup.
    const now = Date.now();
    if (now - lastReveal > 120) { revealWordCount(); lastReveal = now; }

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
    updateStats();
  }

  btnWysiwyg.addEventListener('click', function () { setMode('wysiwyg'); });
  btnMarkdown.addEventListener('click', function () { setMode('markdown'); });

  /* =========================================================
   * 6. Statistik — selalu dari sumber Markdown kanonik yang sama.
   * ======================================================= */
  let statsTimer = null;
  function updateStats() {
    const stats = documentStats(getCanonicalMarkdown());
    document.getElementById('stat-words').textContent = 'Words: ' + stats.words;
    document.getElementById('stat-chars').textContent = 'Chars: ' + stats.chars;
    revealWordCount();
  }

  // Debounce: serializeLines() berjalan tiap ketikan kalau tidak ditunda.
  function scheduleStats() {
    clearTimeout(statsTimer);
    statsTimer = setTimeout(updateStats, 120);
  }

  quill.on('text-change', scheduleStats);
  textarea.addEventListener('input', scheduleStats);

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

  // Jembatan untuk pengujian dan untuk integrasi Tauri di kemudian hari.
  window.MarkRust = {
    quill: quill,
    setMode: setMode,
    quillToMarkdown: quillToMarkdown,
    mdToQuillHtml: toHtml,
    getMarkdown: getCanonicalMarkdown,
    setMarkdown: loadMarkdownIntoQuill,
    getStats: function () { return documentStats(getCanonicalMarkdown()); },
    isToolbarPinned: function () { return pinned; },
    isToolbarVisible: isToolbarShown
  };
}
