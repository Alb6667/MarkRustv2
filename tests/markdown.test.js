import test from 'node:test';
import assert from 'node:assert/strict';
import { getEnv, parseMarkdown } from './harness.js';
import {
  escapeHtml, normalizeForQuill, mdToQuillHtml,
  plainTextFromMarkdown, documentStats
} from '../ui/core/markdown.js';

const { DOMParser } = getEnv();

test('escapeHtml menetralkan entity dasar', () => {
  assert.equal(escapeHtml('<b>&</b>'), '&lt;b&gt;&amp;&lt;/b&gt;');
});

test('normalizeForQuill: <th> jadi <td> dengan align dipertahankan', () => {
  const out = normalizeForQuill(
    '<table><thead><tr><th align="center">A</th></tr></thead></table>', DOMParser);
  assert.match(out, /<td align="center">A<\/td>/);
  assert.ok(!/<th[\s>]/.test(out));
});

test('normalizeForQuill: baris delimiter tabel dibuang', () => {
  const out = normalizeForQuill(
    '<table><tr><th>A</th></tr><tr><td>---</td></tr><tr><td>1</td></tr></table>', DOMParser);
  assert.equal((out.match(/<tr>/g) || []).length, 2);
  assert.ok(!/>---</.test(out));
});

test('normalizeForQuill: <del> jadi <s>', () => {
  assert.match(normalizeForQuill('<p><del>x</del></p>', DOMParser), /<s>x<\/s>/);
});

test('normalizeForQuill: <pre><code class="language-x"> jadi <pre data-language>', () => {
  const out = normalizeForQuill(
    '<pre><code class="language-rust">fn main() {\n    x();\n}\n</code></pre>', DOMParser);
  assert.match(out, /<pre data-language="rust">/);
  assert.match(out, /\n    x\(\);/);            // indentasi tidak lipat
  assert.ok(!out.endsWith('\n</pre>'));         // newline trailing dibuang
  assert.ok(!out.includes('<code'));
});

test('normalizeForQuill: checkbox jadi teks literal', () => {
  const out = normalizeForQuill(
    '<ul><li><input type="checkbox" checked> a</li><li><input type="checkbox"> b</li></ul>',
    DOMParser);
  assert.match(out, /\[x\]\s+a/);
  assert.match(out, /\[ \]\s+b/);
  assert.ok(!out.includes('<input'));
});

test('mdToQuillHtml menghasilkan string untuk input kosong', () => {
  assert.equal(mdToQuillHtml('', parseMarkdown, DOMParser), '');
});

test('mdToQuillHtml fallback ke paragraf ter-escape bila parser melempar', () => {
  const boom = () => { throw new Error('parse failed'); };
  assert.equal(mdToQuillHtml('<b>x</b>', boom, DOMParser), '<p>&lt;b&gt;x&lt;/b&gt;</p>');
});

test('plainTextFromMarkdown membuang sintaks, bukan hanya tag', () => {
  const md = '# Judul\n\nIni **tebal** dan *miring*.\n\n- satu\n- [x] dua\n\n> kutipan\n\n| A | B |\n|---|---|\n| 1 | 2 |\n';
  const plain = plainTextFromMarkdown(md);
  assert.ok(!/[#*|>]/.test(plain), 'marker sintaks harus hilang: ' + JSON.stringify(plain));
  assert.ok(plain.includes('Judul'));
  assert.ok(plain.includes('tebal'));
  assert.ok(plain.includes('dua'));
});

test('plainTextFromMarkdown: isi fenced code tetap dihitung, fence & bahasa tidak', () => {
  const plain = plainTextFromMarkdown('```rust\nlet x = 1;\n```\n');
  assert.ok(plain.includes('let x = 1;'));
  assert.ok(!plain.includes('```'));
  assert.ok(!plain.includes('rust'));
});

test('plainTextFromMarkdown: tautan jadi label, gambar jadi alt', () => {
  const plain = plainTextFromMarkdown('[label](https://x.test) ![alt](https://x.test/a.png)\n');
  assert.equal(plain.trim(), 'label alt');
});

test('documentStats: 13 kata untuk dokumen contoh (bukan 24 seperti stripMarkup lama)', () => {
  const md = '# Judul Dokumen\n\nIni **tebal** dan *miring*.\n\n- satu\n- dua\n- tiga\n\n| A | B |\n|---|---|\n| 1 | 2 |\n';
  assert.deepEqual(documentStats(md), { words: 13, chars: 59 });
});

test('documentStats: dokumen kosong -> nol', () => {
  assert.deepEqual(documentStats(''), { words: 0, chars: 0 });
  assert.deepEqual(documentStats('   \n\n'), { words: 0, chars: 0 });
});

test('documentStats stabil terhadap whitespace tambahan', () => {
  const a = documentStats('satu dua tiga\n');
  const b = documentStats('satu   dua\n\n\ntiga\n\n');
  assert.deepEqual(a, b);
});
