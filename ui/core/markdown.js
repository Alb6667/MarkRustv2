/*
 * MarkRust — Markdown -> HTML yang dipahami Quill, + statistik dokumen.
 *
 * Semua ketergantungan browser (marked, DOMParser) di-inject lewat argumen
 * dengan fallback ke global, supaya modul ini bisa diuji di Node/jsdom tanpa
 * mengubah perilaku di webview Tauri.
 */

import {
  shouldBlockRemoteImage, isRemoteImageUrl, IMAGE_PLACEHOLDER
} from './image-policy.js';

export function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Quill 2 menolak/mengabaikan beberapa elemen standar. Normalisasi:
 *   <th>          -> <td>              (Quill tidak mengenali <th>; align dipertahankan)
 *   baris |---|   dibuang              (jika tidak, jadi baris data palsu)
 *   <del>         -> <s>               (blot strike Quill memakai <s>)
 *   <pre><code>   -> <pre data-language> (tag <pre> menjaga whitespace mentah,
 *                    sehingga indentasi kode tidak lipat)
 *   checkbox      -> teks "[ ] " / "[x] " (task list tidak hilang)
 */
/**
 * Sanitasi HTML yang berasal dari Markdown (sumber tidak dipercaya).
 *
 * Pemblokiran gambar jarak jauh terjadi di blot Quill, tetapi vektor lain bisa
 * memicu permintaan jaringan tanpa pernah menyentuh atribut `src`:
 *   - `srcset` pada <img>,
 *   - `background-image: url(...)` pada style inline,
 *   - event handler `on*` (dicegah CSP, tapi tetap dibuang),
 *   - elemen <script>/<iframe>/<object>/<style>/<link>/<base>.
 *
 * Deklarasi CSS `url()` dibuang per-deklarasi, BUKAN seluruh atribut style,
 * supaya warna teks/latar (`color:`/`background-color:`) tetap ikut round-trip.
 */
function sanitizeUntrustedHtml(root) {
  var dangerous = root.querySelectorAll(
    'script,iframe,object,embed,style,link,meta,base,form,svg,math,' +
    'audio,video,source,track,picture,frame,frameset,applet,portal,' +
    'input[type="image"]'
  );
  for (var d = 0; d < dangerous.length; d++) {
    if (dangerous[d].parentNode) dangerous[d].parentNode.removeChild(dangerous[d]);
  }

  var nodes = root.querySelectorAll('*');
  for (var i = 0; i < nodes.length; i++) {
    var el = nodes[i];
    var attrs = [];
    for (var a = 0; a < el.attributes.length; a++) attrs.push(el.attributes[a]);
    for (var j = 0; j < attrs.length; j++) {
      var name = attrs[j].name.toLowerCase();
      var value = attrs[j].value || '';
      if (name.indexOf('on') === 0 || name === 'srcset' || name === 'poster' ||
          name === 'background' || name === 'data' || name === 'formaction' ||
          name === 'ping') {
        el.removeAttribute(attrs[j].name);
      } else if (name === 'src' && el.tagName !== 'IMG') {
        // Elemen non-img dengan src (video/audio/source/... ) sudah dihapus di
        // atas, tetapi ini menutup elemen tak dikenal yang mungkin ditambahkan
        // parser di masa depan. Hanya <img> yang boleh punya src.
        el.removeAttribute(attrs[j].name);
      } else if (name === 'href' && el.tagName !== 'A' && isRemoteImageUrl(value)) {
        // <svg><image href="..."> dan sejenisnya sudah terhapus di atas,
        // ini jaga-jaga untuk elemen lain yang memakai href sebagai sumber.
        el.removeAttribute(attrs[j].name);
      } else if (name === 'style' && /url\s*\(|expression\s*\(/i.test(value)) {
        var kept = value.split(';').filter(function (decl) {
          return !/url\s*\(|expression\s*\(/i.test(decl);
        }).join(';').trim();
        if (kept) el.setAttribute('style', kept);
        else el.removeAttribute('style');
      }
    }
  }

  /* Pemblokiran gambar HARUS terjadi di sini, bukan hanya di blot Quill.
     Di Chrome, menyetel `img.src` pada elemen yang masih terlepas dari DOM
     tetap memicu permintaan jaringan. Karena `dangerouslyPasteHTML` membangun
     pohon perantara seperti itu, URL asli tidak boleh pernah sampai ke sana.
     URL aslinya dipindah ke `data-mr-src`; matcher clipboard membacanya
     kembali sehingga Delta (dan berkas .md) tetap berisi alamat asli. */
  var imgs = root.querySelectorAll('img');
  for (var k = 0; k < imgs.length; k++) {
    var img = imgs[k];
    var src = img.getAttribute('src') || '';
    if (shouldBlockRemoteImage(src)) {
      img.setAttribute('data-mr-src', src);
      img.setAttribute('src', IMAGE_PLACEHOLDER);
    }
  }
}

export function normalizeForQuill(html, DOMParserImpl) {
  var Parser = DOMParserImpl || globalThis.DOMParser;
  if (!Parser) throw new Error('normalizeForQuill membutuhkan DOMParser');
  var doc = new Parser().parseFromString('<div id="__mr_root">' + html + '</div>', 'text/html');
  var root = doc.getElementById('__mr_root');

  sanitizeUntrustedHtml(root);

  var i, nodes;

  // <th> -> <td> (marked menaruh align="left|center|right" pada th maupun td)
  nodes = root.querySelectorAll('th');
  for (i = 0; i < nodes.length; i++) {
    var th = nodes[i];
    var td = doc.createElement('td');
    var thAlign = th.getAttribute('align');
    if (thAlign) td.setAttribute('align', thAlign);
    while (th.firstChild) td.appendChild(th.firstChild);
    th.parentNode.replaceChild(td, th);
  }

  // Buang baris pemisah tabel GFM dan text node whitespace-only di antara tag
  // struktural tabel. Tanpa ini Quill menyisipkan paragraf kosong di tengah
  // tabel dan memecahnya menjadi beberapa tabel.
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

  // <pre><code class="language-x"> -> <pre data-language="x"> native Quill.
  // PENTING: elemennya HARUS tetap ber-tag <pre>. Matcher clipboard Quill hanya
  // mempertahankan whitespace mentah di dalam keturunan <pre>; di luar <pre>
  // spasi dilipat lalu spasi awal dibuang, sehingga indentasi kode hilang.
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
    var nativePre = doc.createElement('pre');
    if (lang) nativePre.setAttribute('data-language', lang);
    // Buang satu newline trailing: Quill menjadikan tiap baris sebagai satu
    // code-block line, newline ekstra akan menjadi baris kosong palsu.
    nativePre.textContent = (source.textContent || '').replace(/\n$/, '');
    pre.parentNode.replaceChild(nativePre, pre);
  }

  // Checkbox task list -> teks literal
  nodes = root.querySelectorAll('input[type="checkbox"]');
  for (i = 0; i < nodes.length; i++) {
    var cb = nodes[i];
    cb.parentNode.replaceChild(
      doc.createTextNode(cb.hasAttribute('checked') ? '[x] ' : '[ ] '), cb);
  }

  return root.innerHTML;
}

/** Parse Markdown menjadi HTML siap ditempel ke clipboard Quill. */
export function mdToQuillHtml(md, parse, DOMParserImpl) {
  var parseFn = parse || function (src) {
    var m = globalThis.marked;
    if (!m) throw new Error('marked belum dimuat');
    // async:false -> mengembalikan string, bukan Promise.
    return m.parse(String(src || ''), { gfm: true, breaks: false, async: false });
  };
  var html;
  try {
    html = parseFn(String(md || ''));
  } catch (e) {
    html = '<p>' + escapeHtml(md) + '</p>';
  }
  if (typeof html !== 'string') return '<p></p>';
  return normalizeForQuill(html, DOMParserImpl);
}

/* ------------------------------------------------------------------------- *
 * Statistik dokumen — SATU sumber kebenaran untuk kedua mode.
 * ------------------------------------------------------------------------- */

/**
 * Ekstrak teks yang benar-benar terlihat dari Markdown.
 * Berbeda dengan `stripMarkup` lama yang hanya membuang fence/tag/entity:
 * di sini marker heading, emphasis, list, task, blockquote, tabel, tautan,
 * dan gambar ikut dibuang sehingga jumlahnya sama dengan mode WYSIWYG.
 */
export function plainTextFromMarkdown(md) {
  var text = String(md == null ? '' : md);

  // Fenced code: isinya tetap dihitung, fence + info string dibuang.
  text = text.replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n([\s\S]*?)^ {0,3}\1[ \t]*$/gm,
    function (m, fence, body) { return '\n' + body + '\n'; });

  text = text.replace(/<!--[\s\S]*?-->/g, ' ');
  text = text.replace(/<[^>]*>/g, ' ');
  text = text.replace(/&[a-zA-Z#0-9]+;/g, ' ');

  // Gambar -> alt, tautan -> label.
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  text = text.replace(/!?\[([^\]]*)\]\[[^\]]*\]/g, '$1');

  // Inline code: simpan isinya saja.
  text = text.replace(/(`+)([\s\S]*?)\1/g, '$2');

  // Marker emphasis/strike dibuang, bukan diganti spasi, supaya tidak
  // memecah kata yang memang tersambung (foo*bar* tetap satu kata).
  text = text.replace(/\*\*|__|~~|\*|_/g, '');
  text = text.replace(/\\([\\`*_{}[\]()#+\-.!>])/g, '$1');
  text = text.replace(/\\</g, '<');

  text = text.split('\n').map(function (line) {
    // Baris delimiter tabel DAN garis pemisah harus dibuang SEBELUM pipe
    // diubah jadi spasi. Kalau tidak, '|---|---|' berubah menjadi ' --- --- '
    // dan dihitung sebagai dua kata tambahan.
    if (/^\s*\|?\s*:?-{1,}:?\s*(?:\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(line)) return '';
    return line
      .replace(/^\s{0,3}#{1,6}\s+/, '')
      .replace(/^\s{0,3}>\s?/, '')
      .replace(/^(\s*)(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, '$1')
      .replace(/^\s*\|/, '')
      .replace(/\|\s*$/, '')
      .replace(/\|/g, ' ');
  }).join('\n');

  return text;
}

/** Satu-satunya skema URL gambar yang diterima. */
export function isValidImageUrl(url) {
  return /^https?:\/\/[^\s]+$/i.test(String(url == null ? '' : url).trim());
}

/**
 * Hitung gambar remote untuk status/izin eksplisit. Desktop mengunduhnya lewat
 * perintah Rust terbatas lalu memakai data URI; CSP tidak mengizinkan https
 * pada img-src. Browser fallback tetap memerlukan klik/penyisipan eksplisit.
 */
export function remoteImageCount(md) {
  const src = String(md == null ? '' : md);
  let count = 0;
  const fromMarkdown = /!\[[^\]]*\]\(\s*<?((?:https?:)?\/\/[^\s)>]+)/gi;
  while (fromMarkdown.exec(src)) count++;
  const fromHtml = /<img\b[^>]*\bsrc\s*=\s*["']?((?:https?:)?\/\/[^"'\s>]+)/gi;
  while (fromHtml.exec(src)) count++;
  return count;
}

/** { words, chars } dari sumber Markdown, identik untuk mode WYSIWYG & raw. */
export function documentStats(md) {
  var normalized = plainTextFromMarkdown(md)
    .replace(/\r/g, '')
    // Spasi beruntun di sumber Markdown melebur saat dirender; samakan supaya
    // jumlah karakter tidak bergantung pada gaya penulisan/soft-wrap.
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{2,}/g, '\n')
    .replace(/^\n+|\n+$/g, '');
  var flat = normalized.replace(/\s+/g, ' ').trim();
  return {
    words: flat ? flat.split(' ').length : 0,
    chars: normalized.length
  };
}
