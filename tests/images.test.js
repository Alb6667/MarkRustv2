/*
 * Keamanan gambar jarak jauh.
 *
 * Jaminan yang diuji di sini bukan sekadar "gambar tidak tampil", melainkan
 * "tidak ada URL http(s) yang sampai ke DOM sama sekali" — karena di Chrome
 * img.src memicu fetch walau elemennya tidak pernah dipasang ke dokumen.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { getEnv, parseMarkdown, createQuill } from './harness.js';
import {
  resetImagePolicy, allowRemoteImage, allowAllRemoteImages,
  isRemoteImageAllowed, isRemoteImageUrl, shouldBlockRemoteImage,
  IMAGE_PLACEHOLDER
} from '../ui/core/image-policy.js';
import { mdToQuillHtml, normalizeForQuill } from '../ui/core/markdown.js';
import { linesFromQuill } from '../ui/core/serialize.js';
import { revealAllowedImages } from '../ui/core/quill-setup.js';

const { DOMParser } = getEnv();
const REMOTE = 'https://tracker.example/pixel.png';

function render(md) {
  const quill = createQuill();
  quill.setContents([{ insert: '\n' }], 'silent');
  quill.clipboard.dangerouslyPasteHTML(0, mdToQuillHtml(md, parseMarkdown, DOMParser), 'api');
  return quill;
}

/*
 * Atribut yang benar-benar dapat memicu permintaan jaringan. `data-mr-src`
 * SENGAJA tidak termasuk: itu atribut inert buatan kita untuk menyimpan URL
 * asli, dan browser tidak pernah memuatnya. Yang dijamin nol di bawah adalah
 * atribut pemicu fetch, bukan sekadar "ada string https di mana pun".
 */
const FETCH_ATTRS = ['src', 'srcset', 'poster', 'background', 'data', 'formaction', 'ping'];

/** Semua atribut (apa pun namanya) yang nilainya URL jaringan. */
function remoteAttributesIn(root) {
  const hits = [];
  const els = root.querySelectorAll('*');
  for (let i = 0; i < els.length; i++) {
    const el = els[i];
    for (let a = 0; a < el.attributes.length; a++) {
      const at = el.attributes[a];
      if (/^https?:\/\//i.test(at.value || '')) hits.push(el.tagName + '@' + at.name);
    }
  }
  return hits;
}

function networkTriggeringAttributesIn(root) {
  const hits = [];
  const els = root.querySelectorAll('*');
  for (let i = 0; i < els.length; i++) {
    const el = els[i];
    for (let a = 0; a < el.attributes.length; a++) {
      const at = el.attributes[a];
      const name = at.name.toLowerCase();
      const value = at.value || '';
      if (FETCH_ATTRS.indexOf(name) !== -1 && /^(?:https?:)?\/\//i.test(value)) {
        hits.push(el.tagName + '@' + name);
      } else if (name === 'style' && /url\s*\(\s*['"]?https?:\/\//i.test(value)) {
        hits.push(el.tagName + '@style');
      } else if (name === 'href' && el.tagName !== 'A' && /^https?:\/\//i.test(value)) {
        hits.push(el.tagName + '@href');
      }
    }
  }
  return hits;
}

test('isRemoteImageUrl hanya mengenali http/https', () => {
  assert.equal(isRemoteImageUrl(REMOTE), true);
  assert.equal(isRemoteImageUrl('http://x.test/a.png'), true);
  assert.equal(isRemoteImageUrl('//tracker.example/x.png'), true,
    'protocol-relative juga memicu request dan harus dikenali');
  assert.equal(isRemoteImageUrl('  \nhttps://tracker.example/x.png'), true,
    'karakter kontrol di depan tidak boleh menyamarkan URL');
  assert.equal(isRemoteImageUrl('data:image/png;base64,AAA'), false);
  assert.equal(isRemoteImageUrl('/lokal/gambar.png'), false);
  assert.equal(isRemoteImageUrl(''), false);
});

test('placeholder adalah data URI lokal, bukan URL jaringan', () => {
  assert.ok(IMAGE_PLACEHOLDER.startsWith('data:image/svg+xml'));
  assert.equal(isRemoteImageUrl(IMAGE_PLACEHOLDER), false);
});

test('kebijakan default memblokir; allow bekerja per-URL', () => {
  resetImagePolicy();
  assert.equal(shouldBlockRemoteImage(REMOTE), true);
  assert.equal(isRemoteImageAllowed(REMOTE), false);
  allowRemoteImage(REMOTE);
  assert.equal(shouldBlockRemoteImage(REMOTE), false);
  assert.equal(isRemoteImageAllowed(REMOTE), true);
  assert.equal(shouldBlockRemoteImage('https://lain.example/a.png'), true,
    'mengizinkan satu URL tidak boleh mengizinkan URL lain');
});

test('allowAll lalu reset mengembalikan ke kondisi aman', () => {
  resetImagePolicy();
  allowAllRemoteImages([REMOTE]);
  assert.equal(isRemoteImageAllowed(REMOTE), true);
  resetImagePolicy();
  assert.equal(isRemoteImageAllowed(REMOTE), false);
  assert.equal(shouldBlockRemoteImage(REMOTE), true);
});

test('protocol-relative //host/path juga ditahan', () => {
  resetImagePolicy();
  const html = mdToQuillHtml('![foto](//tracker.example/pixel.png)\n', parseMarkdown, DOMParser);
  const doc = new DOMParser().parseFromString('<div id="r">' + html + '</div>', 'text/html');
  const root = doc.getElementById('r');
  const img = root.querySelector('img');
  assert.equal(img.getAttribute('src'), IMAGE_PLACEHOLDER);
  assert.equal(img.getAttribute('data-mr-src'), '//tracker.example/pixel.png');
  assert.deepEqual(networkTriggeringAttributesIn(root), []);
});

test('normalisasi: TIDAK ada atribut bernilai http(s) saat diblokir', () => {
  resetImagePolicy();
  const md = '![foto](https://tracker.example/pixel.png)\n';
  const html = mdToQuillHtml(md, parseMarkdown, DOMParser);
  const doc = new DOMParser().parseFromString('<div id="r">' + html + '</div>', 'text/html');
  const root = doc.getElementById('r');

  assert.deepEqual(networkTriggeringAttributesIn(root), [],
    'tidak ada atribut pemicu fetch yang berisi URL jaringan sebelum Quill melihatnya');
  // URL asli boleh (dan memang harus) tetap ada, tapi HANYA di atribut inert.
  assert.deepEqual(
    remoteAttributesIn(root), ['IMG@data-mr-src'],
    'URL asli hanya boleh tersimpan di data-mr-src');
  const img = root.querySelector('img');
  assert.ok(img);
  assert.equal(img.getAttribute('src'), IMAGE_PLACEHOLDER);
  assert.equal(img.getAttribute('data-mr-src'), REMOTE,
    'URL asli tetap disimpan di atribut khusus agar tidak hilang');
});

test('render Quill: nol gambar dengan src jaringan saat diblokir', () => {
  resetImagePolicy();
  const q = render('Sebelum\n\n![foto kucing](' + REMOTE + ')\n\nSesudah\n');
  const imgs = Array.from(q.root.querySelectorAll('img'));
  assert.equal(imgs.length, 1);
  assert.ok(!/^https?:/i.test(imgs[0].getAttribute('src') || ''));
  assert.equal(imgs[0].getAttribute('data-mr-src'), REMOTE);
  assert.deepEqual(networkTriggeringAttributesIn(q.root), [],
    'DOM final tidak boleh berisi atribut pemicu fetch ke jaringan');
});

test('URL asli TETAP sampai ke serializer Markdown (round-trip tidak rusak)', () => {
  resetImagePolicy();
  const q = render('![foto kucing](' + REMOTE + ')\n');
  const lines = linesFromQuill(q);
  const imageRun = lines.reduce((acc, l) => acc.concat(l.runs), [])
    .find((r) => r.image !== undefined);
  assert.ok(imageRun, 'embed gambar harus tetap ada di Delta');
  assert.equal(imageRun.image, REMOTE);
  assert.equal(imageRun.alt, 'foto kucing', 'alt tidak boleh hilang');
});

test('setelah diizinkan, src dikembalikan ke URL asli dan placeholder hilang', () => {
  resetImagePolicy();
  const q = render('![' + 'foto' + '](' + REMOTE + ')\n');
  allowAllRemoteImages([REMOTE]);
  const n = revealAllowedImages(q);
  assert.equal(n, 1);
  const img = q.root.querySelector('img');
  assert.equal(img.getAttribute('src'), REMOTE);
  assert.ok(!img.getAttribute('src').startsWith('data:'));
});

test('gambar data: URI tidak pernah diblokir', () => {
  resetImagePolicy();
  const md = '![lokal](data:image/png;base64,iVBORw0KGgo=)\n';
  const q = render(md);
  const img = q.root.querySelector('img');
  assert.ok(String(img.getAttribute('src')).startsWith('data:image/png'));
  assert.equal(img.getAttribute('data-mr-src'), null);
});

test('normalisasi membuang srcset, style url(), handler on*, dan <iframe>', () => {
  resetImagePolicy();
  const html = normalizeForQuill(
    '<p onclick="alert(1)" style="color:red;background-image:url(https://evil.test/x.png)">teks</p>' +
    '<img src="https://tracker.example/a.png" srcset="https://tracker.example/b.png 2x">' +
    '<iframe src="https://evil.test/frame"></iframe>' +
    '<script>alert(1)</script>',
    DOMParser
  );
  assert.ok(!/onclick/i.test(html));
  assert.ok(!/srcset/i.test(html));
  assert.ok(!/iframe/i.test(html));
  assert.ok(!/background-image/i.test(html));
  assert.ok(!/<script/i.test(html));
  assert.ok(!/https:\/\/evil\.test\/x\.png/.test(html), 'url() CSS harus hilang');
  assert.ok(/color:red/.test(html), 'warna teks yang aman harus tetap dipertahankan');
  // Cek atribut src-nya secara eksplisit, bukan sekadar "string URL ada".
  const doc2 = new DOMParser().parseFromString('<div id="r">' + html + '</div>', 'text/html');
  const img2 = doc2.getElementById('r').querySelector('img');
  assert.ok(img2, 'gambar harus tetap ada (URL-nya tersimpan, bukan dibuang)');
  assert.equal(img2.getAttribute('src'), IMAGE_PLACEHOLDER, 'src harus placeholder');
  assert.equal(img2.getAttribute('data-mr-src'), 'https://tracker.example/a.png');
});

test('normalisasi membuang <input type=image> dan atribut ping', () => {
  resetImagePolicy();
  const html = normalizeForQuill(
    '<a href="https://x.test" ping="https://tracker.example/ping">tautan</a>' +
    '<input type="image" src="https://tracker.example/btn.png">',
    DOMParser
  );
  assert.ok(!/ping=/i.test(html));
  assert.ok(!/type="image"/i.test(html));
  assert.ok(!/tracker\.example\/btn\.png/.test(html));
});

test('beberapa gambar: semua ditahan, semuanya bisa diizinkan sekaligus', () => {
  resetImagePolicy();
  const urls = ['https://a.test/1.png', 'https://b.test/2.png'];
  const q = render('![satu](' + urls[0] + ')\n\n![dua](' + urls[1] + ')\n');
  const imgs = Array.from(q.root.querySelectorAll('img'));
  assert.equal(imgs.length, 2);
  assert.ok(imgs.every((i) => !/^https?:/.test(i.getAttribute('src') || '')));
  allowAllRemoteImages(urls);
  assert.equal(revealAllowedImages(q), 2);
  assert.deepEqual(Array.from(q.root.querySelectorAll('img')).map((i) => i.getAttribute('src')), urls);
});
