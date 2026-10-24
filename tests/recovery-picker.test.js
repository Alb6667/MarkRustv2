import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { pickRecovery } from '../ui/core/recovery-picker.js';

function setup() {
  const { window } = new JSDOM('<dialog id="recovery-dialog"><div id="recovery-list"></div></dialog>');
  const doc = window.document;
  const dialog = doc.querySelector('dialog');
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; dialog.dispatchEvent(new window.Event('close')); };
  return { window, doc, dialog };
}

test('picker renders path as text and returns the chosen session ID', async () => {
  const { doc, dialog } = setup();
  const picked = pickRecovery(doc, [
    { id: 'session-1', path: '<img src=x onerror=alert(1)>', savedAt: 1 },
    { id: 'session-2', path: null, savedAt: 2 }
  ]);
  assert.equal(dialog.open, true);
  assert.equal(doc.querySelector('img'), null);
  const buttons = doc.querySelectorAll('button');
  assert.match(buttons[1].textContent, /Tanpa Judul/);
  buttons[1].click();
  assert.equal(await picked, 'session-2');
  assert.equal(dialog.open, false);
});

test('cancelling resolves null and reopening has no stale close handler', async () => {
  const { doc, dialog } = setup();
  const first = pickRecovery(doc, [{ id: 'session-1' }]);
  dialog.close();
  assert.equal(await first, null);
  const second = pickRecovery(doc, [{ id: 'session-2' }]);
  doc.querySelector('button').click();
  assert.equal(await second, 'session-2');
});
