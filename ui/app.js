/*
 * MarkRust — frontend logic.
 *
 * Konversi arah:
 *   Markdown -> WYSIWYG : marked.parse()  -> normalisasi DOM -> Quill clipboard
 *   WYSIWYG  -> Markdown: Delta Quill    -> serializer di bawah ini
 *
 * Serializer Delta dipakai (bukan Turndown) karena Quill 2 tidak memakai DOM
 * standar: code block adalah <div>, list bullet pakai <ol data-list="bullet">,
 * dan warna disimpan sebagai atribut. Mengonversi DOM-nya akan merusak semua itu.
 */
(function () {
  'use strict';

  var Quill = window.Quill;
  var marked = window.marked;
  var hljs = window.hljs;

  if (!Quill || !marked) {
    document.body.innerHTML =
      '<p style="padding:24px;font-family:sans-serif">Gagal memuat library editor (Quill / marked).</p>';
    return;
  }

  /* =========================================================
   * 1. Blot divider — Quill 2.0.3 tidak menyertakan <hr>
   * =======================================================*/
  // Harus ES class: Parchment menolak membuat blot dari fungsi konstruktor biasa.
  var BlockEmbed = Quill.import('blots/block/embed');
  class DividerBlot extends BlockEmbed { }
  DividerBlot.blotName = 'divider';
  DividerBlot.tagName = 'HR';
  DividerBlot.value = function () { return true; };
  Quill.register(DividerBlot, true);

  /* =========================================================
   * 2. Bahasa yang tersedia untuk syntax highlighting
   * =======================================================*/
  var SYNTAX_LANGS = [
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
    var esc = function (s) {
      return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    };
    var safe = Object.create(base);
    safe.highlight = function (code, opts) {
      var lang = opts && opts.language;
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
   * =======================================================*/
  var toolbarOptions = [
    [{ 'header': [1, 2, 3, false] }],
    ['bold', 'italic', 'underline', 'strike'],
    [{ 'color': [] }, { 'background': [] }],
    [{ 'list': 'ordered' }, { 'list': 'bullet' }],
    ['blockquote', 'code-block'],
    ['link', 'image'],
    ['clean']
  ];

  // Gambar dimasukkan lewat URL, bukan base64 (base64 membuat file .md membengkak).
  function imageHandler() {
    var range = quill.getSelection(true);
    var url = window.prompt('URL gambar:');
    if (!url) return;
    url = url.trim();
    if (!/^(https?:\/\/|data:image\/)/i.test(url)) {
      window.alert('URL tidak valid.\nGunakan http://, https://, atau data:image/...');
      return;
    }
    quill.insertEmbed(range.index, 'image', url, 'user');
    quill.setSelection(range.index + 1, 0, 'user');
  }

  var modules = {
    toolbar: { container: toolbarOptions, handlers: { image: imageHandler } },
    clipboard: { matchVisual: false }
  };
  if (hljs) {
    modules.syntax = { hljs: buildSafeHljs(hljs), interval: 500, languages: SYNTAX_LANGS };
  }

  var quill = new Quill('#editor', {
    modules: modules,
    theme: 'snow',
    placeholder: 'Mulai mengetik di sini... (mode WYSIWYG)'
  });

  // Pindahkan toolbar Quill ke dalam toolbar aplikasi.
  var toolbarModule = quill.getModule('toolbar');
  if (toolbarModule && toolbarModule.container) {
    document.getElementById('quill-toolbar').appendChild(toolbarModule.container);
  }

  // <hr> tidak dikenali clipboard Quill walupun blot sudah terdaftar,
  // jadi daftarkan matcher secara eksplisit.
  var Delta = Quill.import('delta');
  if (Delta) {
    quill.clipboard.addMatcher('hr', function () {
      return new Delta().insert({ divider: true });
    });
  }

  /* =========================================================
   * 4. Markdown -> HTML yang bisa dipahami Quill
   * =======================================================*/
  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /*
   * Quill 2 menolak/mengabaikan beberapa elemen standar. Normalisasi:
   *   <th>      -> <td>              (Quill tidak mengenali <th>)
   *   baris |---|---| dibuang        (jika tidak, jadi baris data palsu)
   *   <del>     -> <s>               (blot strike Quill memakai <s>)
   *   <pre><code> -> code block native Quill (menjaga info bahasa)
   *   checkbox  -> teks "[ ] " / "[x] " (agar task list tidak hilang)
   */
  function normalizeForQuill(html) {
    var doc = new DOMParser().parseFromString('<div id="__mr_root">' + html + '</div>', 'text/html');
    var root = doc.getElementById('__mr_root');

    var i, nodes;

    // <th> -> <td>
    nodes = root.querySelectorAll('th');
    for (i = 0; i < nodes.length; i++) {
      var th = nodes[i];
      var td = doc.createElement('td');
      while (th.firstChild) td.appendChild(th.firstChild);
      th.parentNode.replaceChild(td, th);
    }

    // Buang baris pemisah tabel GFM (jika ada) dan text node whitespace-only
    // di antara tag struktural tabel. Tanpa ini Quill menyisipkan paragraf
    // kosong di tengah tabel dan memecahnya menjadi beberapa tabel.
    var tables = root.querySelectorAll('table');
    for (i = 0; i < tables.length; i++) {
      var rows = tables[i].querySelectorAll('tr');
      if (rows.length > 1) {
        var cells = rows[1].children;
        var isDelim = cells.length > 0;
        for (var c = 0; c < cells.length; c++) {
          if (!/^:?-{1,}:?$/.test((cells[c].textContent || '').trim())) { isDelim = false; break; }
        }
        if (isDelim) rows[1].parentNode.removeChild(rows[1]);
      }

      var walker = doc.createTreeWalker(tables[i], 4 /* NodeFilter.SHOW_TEXT */);
      var dead = [];
      var tn;
      while ((tn = walker.nextNode())) {
        var parentTag = tn.parentNode && tn.parentNode.tagName;
        if (parentTag !== 'TABLE' && parentTag !== 'THEAD' && parentTag !== 'TBODY'
            && parentTag !== 'TFOOT' && parentTag !== 'TR') continue;
        if (tn.nodeValue.replace(/\s/g, '') === '') dead.push(tn);
      }
      for (var d = 0; d < dead.length; d++) dead[d].parentNode.removeChild(dead[d]);
    }

    // <del> -> <s>
    nodes = root.querySelectorAll('del');
    for (i = 0; i < nodes.length; i++) {
      var del = nodes[i];
      var s = doc.createElement('s');
      while (del.firstChild) s.appendChild(del.firstChild);
      del.parentNode.replaceChild(s, del);
    }

    // <pre><code class="language-x"> -> blok kode native Quill
    nodes = root.querySelectorAll('pre');
    for (i = 0; i < nodes.length; i++) {
      var pre = nodes[i];
      var code = pre.querySelector('code');
      var source = code || pre;
      var lang = '';
      if (code) {
        var m = (code.getAttribute('class') || '').match(/(?:^|\s)(?:language|lang)-([^\s]+)/);
        if (m) lang = m[1];
      }
      var container = doc.createElement('div');
      container.className = 'ql-code-block-container';
      container.setAttribute('spellcheck', 'false');
      if (lang) container.setAttribute('data-language', lang);

      var text = (source.textContent || '').replace(/\n$/, '');
      var lines = text.split('\n');
      for (var ln = 0; ln < lines.length; ln++) {
        var lineDiv = doc.createElement('div');
        lineDiv.className = 'ql-code-block';
        if (lang) lineDiv.setAttribute('data-language', lang);
        lineDiv.textContent = lines[ln];
        container.appendChild(lineDiv);
      }
      pre.parentNode.replaceChild(container, pre);
    }

    // Checkbox task list -> teks literal
    nodes = root.querySelectorAll('input[type="checkbox"]');
    for (i = 0; i < nodes.length; i++) {
      var cb = nodes[i];
      nodes[i].parentNode.replaceChild(
        doc.createTextNode(cb.hasAttribute('checked') ? '[x] ' : '[ ] '), cb);
    }

    return root.innerHTML;
  }

  function mdToQuillHtml(md) {
    var html;
    try {
      // async:false -> marked.parse() mengembalikan string, bukan Promise.
      html = marked.parse(String(md || ''), { gfm: true, breaks: false, async: false });
    } catch (e) {
      html = '<p>' + escapeHtml(md) + '</p>';
    }
    if (typeof html !== 'string') return '<p></p>';
    return normalizeForQuill(html);
  }

  /* =========================================================
   * 5. Delta Quill -> Markdown
   * =======================================================*/
  function sanitizeAttrs(attrs) {
    if (!attrs) return {};
    var out = {};
    for (var k in attrs) {
      if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
      if (k === 'code-token' || k === 'ql-token') continue; // sisa highlight.js
      out[k] = attrs[k];
    }
    return out;
  }

  /* Ambil isi satu baris (BlockBlot) menjadi run inline. */
  function lineRuns(line) {
    var d = line.delta && line.delta();
    var ops = (d && d.ops) || [];
    var runs = [];
    for (var i = 0; i < ops.length; i++) {
      var op = ops[i];
      var attrs = sanitizeAttrs(op.attributes);
      var ins = op.insert;
      if (ins && typeof ins === 'object') {
        if (typeof ins.image === 'string') runs.push({ image: ins.image, alt: attrs.alt || '' });
        continue;
      }
      if (typeof ins !== 'string') continue;
      var t = ins;
      if (t.charAt(t.length - 1) === '\n') t = t.slice(0, -1);
      if (t !== '') runs.push({ text: t, attrs: attrs });
    }
    return runs;
  }

  function escapeText(s, inTable) {
    var out = String(s);
    out = out.replace(/\\/g, '\\\\');
    out = out.replace(/([`*_[\]])/g, '\\$1');
    out = out.replace(/~~/g, '\\~\\~');
    out = out.replace(/<(?=[a-zA-Z!/])/g, '\\<');
    if (inTable) out = out.replace(/\|/g, '\\|');
    out = out.replace(/^(\s*)([#>+-])/gm, function (m, sp, ch) { return sp + '\\' + ch; });
    out = out.replace(/^(\s*)(\d+)(\.)\s/gm, function (m, sp, n, dot) { return sp + n + '\\' + dot + ' '; });
    return out;
  }

  function renderInline(runs, inTable) {
    var out = '';
    for (var i = 0; i < runs.length; i++) {
      var r = runs[i];
      if (r.image !== undefined) {
        out += '![' + String(r.alt || '').replace(/[[\]]/g, '') + '](' + r.image + ')';
        continue;
      }
      var a = r.attrs || {};
      var t = r.text == null ? '' : String(r.text);
      if (a.code) { out += '`' + t.replace(/`/g, '') + '`'; continue; }
      t = escapeText(t, inTable);
      if (a.bold) t = '**' + t + '**';
      if (a.italic) t = '*' + t + '*';
      if (a.strike) t = '~~' + t + '~~';
      if (a.underline) t = '<u>' + t + '</u>';
      if (a.link) t = '[' + t + '](' + a.link + ')';
      if (a.color || a.background) {
        var style = [];
        if (a.color) style.push('color:' + a.color);
        if (a.background) style.push('background-color:' + a.background);
        t = '<span style="' + style.join(';') + '">' + t + '</span>';
      }
      out += t;
    }
    return out;
  }

  function plainRuns(runs) {
    var out = '';
    for (var i = 0; i < runs.length; i++) {
      if (runs[i].text != null) out += String(runs[i].text);
    }
    return out;
  }

  function codeLangOf(line) {
    var raw = line.attrs && line.attrs['code-block'];
    return (typeof raw === 'string' && raw && raw !== 'plain') ? raw : '';
  }

  function makeFence(codeLines) {
    var max = 0;
    for (var i = 0; i < codeLines.length; i++) {
      var m = codeLines[i].match(/`+/g);
      if (m) for (var j = 0; j < m.length; j++) max = Math.max(max, m[j].length);
    }
    return new Array(Math.max(3, max + 1) + 1).join('`');
  }

  function renderTable(rows) {
    if (!rows.length) return '';
    var width = 0, i;
    for (i = 0; i < rows.length; i++) width = Math.max(width, rows[i].length);
    var norm = rows.map(function (r) {
      var c = r.slice(0, width);
      while (c.length < width) c.push('');
      return c;
    });
    var rowLine = function (cells) {
      return '| ' + cells.map(function (c) { return c === '' ? ' ' : c; }).join(' | ') + ' |';
    };
    var out = [rowLine(norm[0]), rowLine(norm[0].map(function () { return '---'; }))];
    for (i = 1; i < norm.length; i++) out.push(rowLine(norm[i]));
    return out.join('\n');
  }

  function prefixLines(text, prefix, blank) {
    return String(text).split('\n').map(function (t) {
      return t === '' ? blank : prefix + t;
    }).join('\n');
  }

  function quillToMarkdown() {
    var raw = quill.getLines();
    var lines = [];
    for (var n = 0; n < raw.length; n++) {
      var line = raw[n];
      var blot = line.statics && line.statics.blotName;
      if (blot === 'divider') { lines.push({ divider: true, attrs: {}, runs: [] }); continue; }
      var fmts = (line.formats && line.formats()) || {};
      lines.push({ runs: lineRuns(line), attrs: fmts || {} });
    }

    var blocks = [];
    var i = 0;
    var isEmpty = function (l) { return !l.divider && (!l.runs || l.runs.length === 0); };
    var kindOf = function (l) {
      var a = l.attrs || {};
      if (a['code-block'] !== undefined) return 'code';
      if (a.table) return 'table';
      if (a.list) return 'list';
      if (a.blockquote) return 'quote';
      if (a.header) return 'header';
      return 'para';
    };

    while (i < lines.length) {
      var l = lines[i];

      if (l.divider) { blocks.push('---'); i++; continue; }
      if (isEmpty(l)) { i++; continue; }

      var kind = kindOf(l);

      if (kind === 'code') {
        var lang = codeLangOf(l);
        var buf = [];
        while (i < lines.length && kindOf(lines[i]) === 'code' && codeLangOf(lines[i]) === lang) {
          buf.push(plainRuns(lines[i].runs));
          i++;
        }
        while (buf.length && buf[buf.length - 1].trim() === '') buf.pop();
        var fence = makeFence(buf);
        blocks.push(fence + lang + '\n' + buf.join('\n') + '\n' + fence);
        continue;
      }

      if (kind === 'header') {
        var level = Math.max(1, Math.min(6, parseInt(l.attrs.header, 10) || 1));
        blocks.push(new Array(level + 1).join('#') + ' ' + renderInline(l.runs, false));
        i++;
        continue;
      }

      if (kind === 'quote') {
        var qbuf = [];
        while (i < lines.length && kindOf(lines[i]) === 'quote') {
          qbuf.push(prefixLines(renderInline(lines[i].runs, false), '> ', '>'));
          i++;
        }
        blocks.push(qbuf.join('\n>\n'));
        continue;
      }

      if (kind === 'list') {
        var type = l.attrs.list;
        var items = [];
        var counters = [];
        while (i < lines.length && kindOf(lines[i]) === 'list' && lines[i].attrs.list === type) {
          var indent = Math.max(0, Math.min(7, parseInt(lines[i].attrs.indent, 10) || 0));
          var runs = lines[i].runs;

          // Checkbox task list disimpan sebagai teks literal "[ ] " / "[x] ".
          var task = null;
          if (runs.length && runs[0].text != null) {
            var tm = String(runs[0].text).match(/^\[([ xX])\][ \t]+/);
            if (tm) {
              task = tm[1].toLowerCase() === 'x' ? 'x' : ' ';
              var cut = tm[0].length;
              runs = runs.map(function (r, idx) {
                if (idx !== 0) return r;
                var copy = {};
                for (var k in r) {
                  if (Object.prototype.hasOwnProperty.call(r, k)) copy[k] = r[k];
                }
                copy.text = String(r.text).slice(cut);
                return copy;
              });
            }
          }

          var text = renderInline(runs, false);
          var marker;
          if (task) {
            marker = '- [' + task + '] ';
          } else if (type === 'ordered') {
            counters.length = indent + 1;
            counters[indent] = (counters[indent] || 0) + 1;
            marker = counters[indent] + '. ';
          } else if (type === 'checked') {
            marker = '- [x] ';
          } else if (type === 'unchecked') {
            marker = '- [ ] ';
          } else {
            marker = '- ';
          }
          var pad = new Array(indent + 1).join('  ');
          var cont = new Array(marker.length + 1).join(' ');
          items.push(pad + marker + text.replace(/\n/g, '\n' + pad + cont));
          i++;
        }
        blocks.push(items.join('\n'));
        continue;
      }

      if (kind === 'table') {
        var rows = [];
        var lastId = null;
        while (i < lines.length && kindOf(lines[i]) === 'table') {
          var id = String(lines[i].attrs.table);
          if (id !== lastId) { rows.push([]); lastId = id; }
          rows[rows.length - 1].push(renderInline(lines[i].runs, true));
          i++;
        }
        var tbl = renderTable(rows);
        if (tbl) blocks.push(tbl);
        continue;
      }

      // Satu baris Quill = satu paragraf. Jangan digabung: dua paragraf
      // berurutan harus tetap terpisah (kalau tidak, mereka menyatu saat dibaca lagi).
      blocks.push(renderInline(l.runs, false));
      i++;
    }

    var md = blocks.join('\n\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]+$/gm, '');
    return md.replace(/\n+$/, '') + '\n';
  }

  /* =========================================================
   * 6. Mode WYSIWYG <-> Markdown
   * =======================================================*/
  var editorWrap = document.getElementById('editor-wrap');
  var rawView = document.getElementById('raw-view');
  var textarea = document.getElementById('raw-textarea');
  var btnWysiwyg = document.getElementById('btn-wysiwyg');
  var btnMarkdown = document.getElementById('btn-markdown');
  var statMode = document.getElementById('stat-mode');
  var currentMode = 'wysiwyg';

  function loadMarkdownIntoQuill(md) {
    var html = mdToQuillHtml(md);
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
    statMode.textContent = mode === 'wysiwyg' ? 'WYSIWYG' : 'Markdown';
    updateStats();
  }

  btnWysiwyg.addEventListener('click', function () { setMode('wysiwyg'); });
  btnMarkdown.addEventListener('click', function () { setMode('markdown'); });

  /* =========================================================
   * 7. Statistik
   * =======================================================*/
  function countWords(text) {
    var t = String(text || '').replace(/\s+/g, ' ').trim();
    return t ? t.split(' ').length : 0;
  }

  function stripMarkup(md) {
    // Hitung kata dari teks yang terlihat, bukan dari sintaks/tag.
    return String(md || '')
      .replace(/```[\s\S]*?```/g, function (m) { return ' ' + m.replace(/```/g, ' ') + ' '; })
      .replace(/<[^>]*>/g, ' ')
      .replace(/&[a-zA-Z#0-9]+;/g, ' ');
  }

  function updateStats() {
    var raw;
    if (currentMode === 'wysiwyg') {
      raw = quill.getText();
    } else {
      raw = stripMarkup(textarea.value);
    }
    document.getElementById('stat-words').textContent = 'Words: ' + countWords(raw);
    document.getElementById('stat-chars').textContent =
      'Chars: ' + (currentMode === 'wysiwyg' ? quill.getText().length : textarea.value.length);
  }

  quill.on('text-change', updateStats);
  textarea.addEventListener('input', updateStats);

  /* =========================================================
   * 8. Konten awal
   * =======================================================*/
  var defaultMarkdown = [
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
    '- Heading dengan warna berbeda',
    '- Bullet dan numbered list',
    '  - termasuk list bersarang',
    '- Blockquote dengan border ungu',
    '- Code block dengan syntax highlighting',
    '- Tabel, link, dan gambar',
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
    'Coba klik tombol **⟨/⟩ Markdown** di kanan atas untuk melihat raw markdown-nya! 🚀',
    ''
  ].join('\n');

  loadMarkdownIntoQuill(defaultMarkdown);

  // Dipakai untuk testing dan untuk jembatan Tauri di kemudian hari.
  window.MarkRust = {
    quill: quill,
    setMode: setMode,
    quillToMarkdown: quillToMarkdown,
    mdToQuillHtml: mdToQuillHtml,
    getMarkdown: function () {
      return currentMode === 'markdown' ? textarea.value : quillToMarkdown();
    },
    setMarkdown: loadMarkdownIntoQuill
  };
})();
