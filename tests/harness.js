/*
 * Harness pengujian: menjalankan Quill 2 + marked yang SAMA dengan yang
 * di-vendoring aplikasi, di atas jsdom. Tidak ada mock konversi — tes
 * round-trip benar-benar lewat clipboard Quill.
 */
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  registerDividerBlot, registerHrMatcher,
  registerSafeImageBlot, registerImageMatcher
} from '../ui/core/quill-setup.js';
import { resetImagePolicy } from '../ui/core/image-policy.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function readVendor(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function defineGlobal(name, value) {
  Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
}

const emptyRect = () => ({
  top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0,
  toJSON() { return this; }
});
const emptyRects = () => Object.assign([], { item: () => null });

/** Pasang global browser yang dibutuhkan Quill ke globalThis Node. */
export function installGlobals(window) {
  for (const k of [
    'DOMParser', 'Node', 'Element', 'HTMLElement', 'NodeFilter', 'MutationObserver',
    'DOMRect', 'Range', 'Selection', 'Event', 'CustomEvent', 'KeyboardEvent',
    'DocumentFragment', 'Text', 'HTMLInputElement', 'HTMLTextAreaElement'
  ]) {
    if (window[k]) defineGlobal(k, window[k]);
  }
  defineGlobal('window', window);
  defineGlobal('document', window.document);
  defineGlobal('navigator', window.navigator);
  defineGlobal('getComputedStyle', window.getComputedStyle.bind(window));
  defineGlobal('requestAnimationFrame', (cb) => setTimeout(cb, 0));
  defineGlobal('cancelAnimationFrame', clearTimeout);

  // jsdom tidak melakukan layout; Quill menyentuh API ini saat kalkulasi seleksi.
  if (window.Range) {
    window.Range.prototype.getClientRects = window.Range.prototype.getClientRects || emptyRects;
    window.Range.prototype.getBoundingClientRect = window.Range.prototype.getBoundingClientRect || emptyRect;
  }
  window.Element.prototype.getClientRects = window.Element.prototype.getClientRects || emptyRects;
  window.Element.prototype.getBoundingClientRect = window.Element.prototype.getBoundingClientRect || emptyRect;
  return window;
}

let env = null;

export function getEnv() {
  if (env) return env;

  const dom = new JSDOM(
    '<!doctype html><html><body></body></html>',
    { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' }
  );
  const window = installGlobals(dom.window);

  window.eval(readVendor('ui/vendor/quill/quill.js'));
  window.eval(readVendor('ui/vendor/marked/marked.umd.js'));

  const Quill = window.Quill;
  const marked = window.marked;
  if (typeof Quill !== 'function') throw new Error('Quill gagal dimuat di jsdom');
  if (!marked || typeof marked.parse !== 'function') throw new Error('marked gagal dimuat di jsdom');

  // Registrasi yang sama persis dengan app.js (lihat boot() di ui/app.js).
  // Tanpa ini harness menguji jalur yang berbeda dari produksi — persis
  // seperti yang terjadi saat tes round-trip gambar gagal.
  registerDividerBlot(Quill);
  registerSafeImageBlot(Quill);

  env = { dom, window, Quill, marked, DOMParser: window.DOMParser };
  return env;
}

/** Parser yang identik dengan yang dipakai app.js. */
export function parseMarkdown(src) {
  const { marked } = getEnv();
  return marked.parse(String(src || ''), { gfm: true, breaks: false, async: false });
}

let counter = 0;

/** Kembalikan kebijakan gambar ke kondisi awal (dipakai antar tes). */
export function resetPolicy() { resetImagePolicy(); }

/** Instance Quill baru pada container terpisah (aman dipakai paralel). */
export function createQuill(extraModules = {}) {
  const { window, Quill } = getEnv();
  const host = window.document.createElement('div');
  host.id = 'editor-test-' + (++counter);
  window.document.body.appendChild(host);

  const quill = new Quill(host, {
    theme: 'snow',
    modules: Object.assign({ toolbar: false, syntax: false }, extraModules),
    placeholder: ''
  });
  registerHrMatcher(quill, Quill);
  registerImageMatcher(quill, Quill);
  return quill;
}
