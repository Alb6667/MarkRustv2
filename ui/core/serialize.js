/*
 * MarkRust — serializer Delta Quill -> Markdown.
 *
 * Modul ini SENGAJA murni (pure): tidak menyentuh `window`, tidak menyimpan
 * instance Quill. `serializeLines()` menerima array deskriptor baris biasa,
 * sehingga bisa diuji tanpa browser. `linesFromQuill()` adalah satu-satunya
 * jembatan ke objek Quill nyata.
 *
 * Deskriptor baris: { divider?: true, runs: Run[], attrs: object }
 * Run: { text: string, attrs?: object } | { image: string, alt?: string }
 */

/* ------------------------------------------------------------------------- *
 * Pembacaan Delta
 * ------------------------------------------------------------------------- */

export function sanitizeAttrs(attrs) {
  if (!attrs) return {};
  var out = {};
  for (var k in attrs) {
    if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
    if (k === 'code-token' || k === 'ql-token') continue; // sisa highlight.js
    out[k] = attrs[k];
  }
  return out;
}

/** Ambil isi satu baris (BlockBlot) menjadi run inline. */
export function lineRuns(line) {
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

/** Satu-satunya fungsi yang bergantung pada instance Quill. */
export function linesFromQuill(quill) {
  var raw = quill.getLines();
  var lines = [];
  for (var n = 0; n < raw.length; n++) {
    var line = raw[n];
    var blot = line.statics && line.statics.blotName;
    if (blot === 'divider') { lines.push({ divider: true, attrs: {}, runs: [] }); continue; }
    var fmts = (line.formats && line.formats()) || {};
    lines.push({ runs: lineRuns(line), attrs: fmts || {} });
  }
  return lines;
}

/* ------------------------------------------------------------------------- *
 * Inline rendering
 * ------------------------------------------------------------------------- */

export function escapeText(s, inTable) {
  var out = String(s);
  out = out.replace(/\\/g, '\\\\');
  // `_` ditangani terpisah: underscore di dalam kata (foo_bar) tidak membentuk
  // emphasis menurut CommonMark, jadi tidak perlu di-escape. Menjaga file .md
  // tetap terbaca dan diff Git tetap bersih.
  out = out.replace(/([`*[\]])/g, '\\$1');
  out = out.replace(/_/g, function (m, idx, str) {
    var prev = idx > 0 ? str.charAt(idx - 1) : '';
    var next = idx + 1 < str.length ? str.charAt(idx + 1) : '';
    if (/[A-Za-z0-9]/.test(prev) && /[A-Za-z0-9]/.test(next)) return '_';
    return '\\_';
  });
  out = out.replace(/~~/g, '\\~\\~');
  out = out.replace(/<(?=[a-zA-Z!/])/g, '\\<');
  if (inTable) out = out.replace(/\|/g, '\\|');
  out = out.replace(/^(\s*)([#>+-])/gm, function (m, sp, ch) { return sp + '\\' + ch; });
  out = out.replace(/^(\s*)(\d+)(\.)\s/gm, function (m, sp, n, dot) { return sp + n + '\\' + dot + ' '; });
  return out;
}

/** Batasi nilai atribut sebelum ditulis ke `style=` / `](...)`. */
export function safeColor(value) {
  var v = String(value == null ? '' : value).trim();
  // Hanya izinkan notasi warna CSS yang tidak bisa membawa url()/ekspresi.
  if (/^#[0-9a-fA-F]{3,8}$/.test(v)) return v;
  if (/^[a-zA-Z]{1,20}$/.test(v)) return v;              // red, rebeccapurple, ...
  if (/^rgba?\(\s*[\d.\s,%]+\)$/.test(v)) return v;
  if (/^hsla?\(\s*[\d.\s,%deg]+\)$/.test(v)) return v;
  return '';
}

export function safeLinkTarget(url) {
  var v = String(url == null ? '' : url).trim();
  if (!v) return '';
  // Blok skema berbahaya; sisanya dibungkus <> bila mengandung spasi/kurung.
  if (/^\s*(?:javascript|vbscript|file|data)\s*:/i.test(v)) return '';
  if (/[<>\s()]/.test(v)) return '<' + v.replace(/[<>\n\r]/g, '') + '>';
  return v;
}

export function renderInline(runs, inTable) {
  var out = '';
  for (var i = 0; i < runs.length; i++) {
    var r = runs[i];
    if (r.image !== undefined) {
      var imgUrl = String(r.image).replace(/[\s()<>]/g, encodeURIComponent);
      out += '![' + String(r.alt || '').replace(/[[\]]/g, '') + '](' + imgUrl + ')';
      continue;
    }
    var a = r.attrs || {};
    var t = r.text == null ? '' : String(r.text);
    if (a.code) {
      // Fence harus lebih panjang dari run backtick terpanjang di dalam isi.
      var btRuns = t.match(/`+/g) || [];
      var maxBt = 0;
      for (var bi = 0; bi < btRuns.length; bi++) maxBt = Math.max(maxBt, btRuns[bi].length);
      var btFence = new Array(maxBt + 2).join('`');
      // CommonMark: konten yang diawali/diakhiri backtick butuh spasi bantalan.
      var btPad = (t.charAt(0) === '`' || t.charAt(t.length - 1) === '`') ? ' ' : '';
      out += btFence + btPad + t + btPad + btFence;
      continue;
    }
    t = escapeText(t, inTable);
    if (a.bold) t = '**' + t + '**';
    if (a.italic) t = '*' + t + '*';
    if (a.strike) t = '~~' + t + '~~';
    if (a.underline) t = '<u>' + t + '</u>';
    if (a.link) {
      var target = safeLinkTarget(a.link);
      if (target) t = '[' + t + '](' + target + ')';
    }
    if (a.color || a.background) {
      var style = [];
      var fg = a.color ? safeColor(a.color) : '';
      var bg = a.background ? safeColor(a.background) : '';
      if (fg) style.push('color:' + fg);
      if (bg) style.push('background-color:' + bg);
      if (style.length) t = '<span style="' + style.join(';') + '">' + t + '</span>';
    }
    out += t;
  }
  return out;
}

export function plainRuns(runs) {
  var out = '';
  for (var i = 0; i < runs.length; i++) {
    if (runs[i].text != null) out += String(runs[i].text);
  }
  return out;
}

/* ------------------------------------------------------------------------- *
 * Blok rendering
 * ------------------------------------------------------------------------- */

export function codeLangOf(line) {
  var raw = line.attrs && line.attrs['code-block'];
  return (typeof raw === 'string' && raw && raw !== 'plain') ? raw : '';
}

export function makeFence(codeLines) {
  var max = 0;
  for (var i = 0; i < codeLines.length; i++) {
    var m = codeLines[i].match(/`+/g);
    if (m) for (var j = 0; j < m.length; j++) max = Math.max(max, m[j].length);
  }
  return new Array(Math.max(3, max + 1) + 1).join('`');
}

// Quill hanya menyimpan alignment non-default: 'center' dan 'right'.
// Eksplisit 'left' (':---') ditulis ulang jadi ' --- ' — identik secara GFM.
export function alignToken(align) {
  if (align === 'center') return ':---:';
  if (align === 'right') return '---:';
  return '---';
}

export function renderTable(rows) {
  if (!rows.length) return '';
  var width = 0, i;
  for (i = 0; i < rows.length; i++) width = Math.max(width, rows[i].length);
  var norm = rows.map(function (r) {
    var c = r.slice(0, width);
    while (c.length < width) c.push({ text: '', align: undefined });
    return c;
  });
  var rowLine = function (cells) {
    return '| ' + cells.map(function (c) { return c.text === '' ? ' ' : c.text; }).join(' | ') + ' |';
  };
  var delimLine = '| ' + norm[0].map(function (c) { return alignToken(c.align); }).join(' | ') + ' |';
  var out = [rowLine(norm[0]), delimLine];
  for (i = 1; i < norm.length; i++) out.push(rowLine(norm[i]));
  return out.join('\n');
}

export function prefixLines(text, prefix, blank) {
  return String(text).split('\n').map(function (t) {
    return t === '' ? blank : prefix + t;
  }).join('\n');
}

/* ------------------------------------------------------------------------- *
 * Serializer utama
 * ------------------------------------------------------------------------- */

export function kindOfLine(l) {
  var a = l.attrs || {};
  if (a['code-block'] !== undefined) return 'code';
  if (a.table) return 'table';
  if (a.list) return 'list';
  if (a.blockquote) return 'quote';
  // `if (a.header)` saja tidak cukup: nilai 0 (atau '0') falsy sehingga
  // jatuh ke paragraf, padahal blok clamp di bawah menulis '# '. Samakan
  // perlakuannya supaya tidak ada baris yang hilang prefixnya diam-diam.
  if (a.header !== undefined && a.header !== null && a.header !== false) return 'header';
  return 'para';
}

/**
 * Ubah array deskriptor baris menjadi Markdown.
 * Tidak membutuhkan Quill, DOM, atau global browser apa pun.
 */
export function serializeLines(lines) {
  var blocks = [];
  var i = 0;
  // State list dipakai bersama lintas blok: list campuran (ordered yang
  // disisipi bullet bersarang) dipecah menjadi beberapa blok karena type-nya
  // berbeda, tetapi penomoran dan lebar marker harus tetap berlanjut.
  var listCounters = [];
  var listMarkerWidths = [];
  var prevWasList = false;
  var isEmpty = function (l) { return !l.divider && (!l.runs || l.runs.length === 0); };

  while (i < lines.length) {
    var l = lines[i];

    if (l.divider) { blocks.push('---'); prevWasList = false; i++; continue; }
    if (isEmpty(l)) { i++; continue; }

    var kind = kindOfLine(l);
    if (kind !== 'list') {
      listCounters = [];
      listMarkerWidths = [];
      prevWasList = false;
    }

    if (kind === 'code') {
      var lang = codeLangOf(l);
      var buf = [];
      while (i < lines.length && kindOfLine(lines[i]) === 'code' && codeLangOf(lines[i]) === lang) {
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
      while (i < lines.length && kindOfLine(lines[i]) === 'quote') {
        qbuf.push(prefixLines(renderInline(lines[i].runs, false), '> ', '>'));
        i++;
      }
      blocks.push(qbuf.join('\n>\n'));
      continue;
    }

    if (kind === 'list') {
      var type = l.attrs.list;
      var items = [];
      // Lebar marker per kedalaman. Padding anak harus sejajar teks induk,
      // bukan kelipatan 2 spasi: '- ' = 2, '1. ' = 3, '- [ ] ' = 6.
      while (i < lines.length && kindOfLine(lines[i]) === 'list' && lines[i].attrs.list === type) {
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
          listCounters.length = indent + 1;
          listCounters[indent] = (listCounters[indent] || 0) + 1;
          marker = listCounters[indent] + '. ';
        } else if (type === 'checked') {
          marker = '- [x] ';
        } else if (type === 'unchecked') {
          marker = '- [ ] ';
        } else {
          marker = '- ';
        }
        listMarkerWidths[indent] = marker.length;
        var pad = '';
        for (var depth = 0; depth < indent; depth++) {
          pad += new Array((listMarkerWidths[depth] || 2) + 1).join(' ');
        }
        var cont = new Array(marker.length + 1).join(' ');
        items.push(pad + marker + text.replace(/\n/g, '\n' + pad + cont));
        i++;
      }
      var listText = items.join('\n');
      if (prevWasList) blocks[blocks.length - 1] += '\n' + listText;
      else blocks.push(listText);
      prevWasList = true;
      continue;
    }

    if (kind === 'table') {
      var rows = [];
      var lastId = null;
      while (i < lines.length && kindOfLine(lines[i]) === 'table') {
        var id = String(lines[i].attrs.table);
        if (id !== lastId) { rows.push([]); lastId = id; }
        rows[rows.length - 1].push({
          text: renderInline(lines[i].runs, true),
          align: lines[i].attrs.align
        });
        i++;
      }
      var tbl = renderTable(rows);
      if (tbl) blocks.push(tbl);
      continue;
    }

    // Satu baris Quill = satu paragraf. Jangan digabung: dua paragraf
    // berurutan harus tetap terpisah saat dibaca lagi.
    blocks.push(renderInline(l.runs, false));
    i++;
  }

  var md = blocks.join('\n\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]+$/gm, '');
  return md.replace(/\n+$/, '') + '\n';
}
