import test from 'node:test';
import assert from 'node:assert/strict';
import {
  escapeText, renderInline, plainRuns, codeLangOf, makeFence, alignToken,
  renderTable, prefixLines, serializeLines, kindOfLine,
  safeColor, safeLinkTarget, sanitizeAttrs
} from '../ui/core/serialize.js';

// ---- pembantu deskriptor baris -------------------------------------------
const p = (text, attrs = {}) => ({ runs: text === '' ? [] : [{ text, attrs: {} }], attrs });
const rich = (runs, attrs = {}) => ({ runs, attrs });
const hr = () => ({ divider: true, attrs: {}, runs: [] });

test('kindOfLine memprioritaskan code > table > list > quote > header', () => {
  assert.equal(kindOfLine(p('x', { 'code-block': 'rust', header: 1 })), 'code');
  assert.equal(kindOfLine(p('x', { table: 'r1', list: 'bullet' })), 'table');
  assert.equal(kindOfLine(p('x', { list: 'bullet', blockquote: true })), 'list');
  assert.equal(kindOfLine(p('x', { header: 2 })), 'header');
  assert.equal(kindOfLine(p('x')), 'para');
});

test('heading dibatasi ke rentang 1..6', () => {
  assert.equal(serializeLines([p('Judul', { header: 1 })]), '# Judul\n');
  assert.equal(serializeLines([p('Judul', { header: 3 })]), '### Judul\n');
  assert.equal(serializeLines([p('Judul', { header: 99 })]), '###### Judul\n');
  assert.equal(serializeLines([p('Judul', { header: 0 })]), '# Judul\n');
});

test('baris kosong dibuang, dua paragraf tetap terpisah', () => {
  const out = serializeLines([p('satu'), p(''), p('dua')]);
  assert.equal(out, 'satu\n\ndua\n');
});

test('divider ditulis sebagai --- dan memutus state list', () => {
  const out = serializeLines([p('atas'), hr(), p('bawah')]);
  assert.equal(out, 'atas\n\n---\n\nbawah\n');
});

test('code block menjaga indentasi dan bahasa', () => {
  const lines = [
    p('fn main() {', { 'code-block': 'rust' }),
    p('    println!("hi");', { 'code-block': 'rust' }),
    p('}', { 'code-block': 'rust' })
  ];
  assert.equal(serializeLines(lines), '```rust\nfn main() {\n    println!("hi");\n}\n```\n');
});

test('dua code block berurutan dengan bahasa berbeda tidak menyatu', () => {
  const out = serializeLines([
    p('a', { 'code-block': 'js' }),
    p('b', { 'code-block': 'python' })
  ]);
  assert.equal(out, '```js\na\n```\n\n```python\nb\n```\n');
});

test('codeLangOf menganggap plain sebagai tanpa bahasa', () => {
  assert.equal(codeLangOf(p('x', { 'code-block': 'plain' })), '');
  assert.equal(codeLangOf(p('x', { 'code-block': 'rust' })), 'rust');
  assert.equal(codeLangOf(p('x', {})), '');
});

test('makeFence selalu lebih panjang dari run backtick terpanjang', () => {
  assert.equal(makeFence(['let x = 1;']), '```');
  assert.equal(makeFence(['```js', 'x']), '````');
  assert.equal(makeFence(['`````']), '``````');
});

test('blockquote: tiap baris diberi prefix, baris kosong jadi >', () => {
  assert.equal(prefixLines('a\nb', '> ', '>'), '> a\n> b');
  assert.equal(prefixLines('', '> ', '>'), '>');
  assert.equal(serializeLines([
    p('satu', { blockquote: true }),
    p('dua', { blockquote: true })
  ]), '> satu\n>\n> dua\n');
});

test('list ordered bernomor, dan penomoran berlanjut lintas blok campuran', () => {
  const out = serializeLines([
    p('satu', { list: 'ordered', indent: 0 }),
    p('dua', { list: 'ordered', indent: 0 }),
    p('anak', { list: 'bullet', indent: 1 }),
    p('tiga', { list: 'ordered', indent: 0 })
  ]);
  assert.equal(out, '1. satu\n2. dua\n   - anak\n3. tiga\n');
});

test('penomoran direset setelah konten non-list', () => {
  const out = serializeLines([
    p('satu', { list: 'ordered' }),
    p('jeda'),
    p('baru', { list: 'ordered' })
  ]);
  assert.equal(out, '1. satu\n\njeda\n\n1. baru\n');
});

test('task list literal [ ] / [x] dipulihkan markernya', () => {
  const out = serializeLines([
    p('[ ] belum', { list: 'bullet' }),
    p('[X] selesai', { list: 'bullet' })
  ]);
  assert.equal(out, '- [ ] belum\n- [x] selesai\n');
});

test('tipe list checked/unchecked Quill 2', () => {
  assert.equal(serializeLines([p('a', { list: 'checked' })]), '- [x] a\n');
  assert.equal(serializeLines([p('a', { list: 'unchecked' })]), '- [ ] a\n');
});

test('alignToken memetakan center/right, left jadi default GFM', () => {
  assert.equal(alignToken('center'), ':---:');
  assert.equal(alignToken('right'), '---:');
  assert.equal(alignToken('left'), '---');
  assert.equal(alignToken(undefined), '---');
});

test('renderTable menormalkan baris yang lebarnya tidak sama', () => {
  const rows = [
    [{ text: 'A', align: 'center' }, { text: 'B', align: 'right' }],
    [{ text: '1' }]
  ];
  assert.equal(renderTable(rows), '| A | B |\n| :---: | ---: |\n| 1 |   |');
});

test('renderInline: fence code span memanjang dan diberi spasi bantalan', () => {
  assert.equal(renderInline([{ text: 'a', attrs: { code: true } }], false), '`a`');
  assert.equal(renderInline([{ text: 'b`c', attrs: { code: true } }], false), '``b`c``');
  assert.equal(renderInline([{ text: '`x', attrs: { code: true } }], false), '`` `x ``');
});

test('renderInline: format diterapkan dengan urutan yang benar', () => {
  const out = renderInline([{
    text: 'teks', attrs: { bold: true, italic: true, strike: true, underline: true, link: 'https://x.test' }
  }], false);
  assert.equal(out, '[<u>~~***teks***~~</u>](https://x.test)');
});

test('escapeText: underscore intraword dibiarkan, emphasis tetap di-escape', () => {
  assert.equal(escapeText('nama_variabel'), 'nama_variabel');
  assert.equal(escapeText('_miring_'), '\\_miring\\_');
  assert.equal(escapeText('a * b'), 'a \\* b');
});

test('escapeText: marker blok diawal baris di-escape, pipe hanya di tabel', () => {
  assert.equal(escapeText('# judul'), '\\# judul');
  assert.equal(escapeText('1. item'), '1\\. item');
  assert.equal(escapeText('a|b', false), 'a|b');
  assert.equal(escapeText('a|b', true), 'a\\|b');
});

test('safeColor menolak injeksi CSS, mengizinkan notasi warna wajar', () => {
  assert.equal(safeColor('#ff0000'), '#ff0000');
  assert.equal(safeColor('rebeccapurple'), 'rebeccapurple');
  assert.equal(safeColor('rgb(1, 2, 3)'), 'rgb(1, 2, 3)');
  assert.equal(safeColor('red; background:url(https://evil.test)'), '');
  assert.equal(safeColor('expression(alert(1))'), '');
  assert.equal(safeColor('url(https://evil.test)'), '');
});

test('safeLinkTarget menolak skema berbahaya dan membungkus URL bertanda kurung', () => {
  assert.equal(safeLinkTarget('javascript:alert(1)'), '');
  assert.equal(safeLinkTarget('data:text/html,x'), '');
  assert.equal(safeLinkTarget('https://x.test/a'), 'https://x.test/a');
  assert.equal(safeLinkTarget('https://x.test/a b'), '<https://x.test/a b>');
});

test('renderInline menolak warna dan tautan berbahaya (tidak ada style= / javascript:)', () => {
  const out = renderInline([
    { text: 'x', attrs: { color: 'red;background:url(https://evil.test)' } },
    { text: 'y', attrs: { link: 'javascript:alert(1)' } }
  ], false);
  assert.equal(out, 'xy');
  assert.ok(!out.includes('javascript:'));
  assert.ok(!out.includes('<span'));
});

test('plainRuns mengabaikan embed gambar', () => {
  assert.equal(plainRuns([{ text: 'a' }, { image: 'x.png' }, { text: 'b' }]), 'ab');
});

test('sanitizeAttrs membuang sisa token highlight.js', () => {
  assert.deepEqual(sanitizeAttrs({ bold: true, 'code-token': 'x', 'ql-token': 'y' }), { bold: true });
});

test('serializeLines selalu diakhiri tepat satu newline', () => {
  assert.equal(serializeLines([p('a'), p('b'), p('c')]), 'a\n\nb\n\nc\n');
  assert.equal(serializeLines([]), '\n');
});
