import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiskRecovery } from '../ui/core/recovery.js';

test('disk recovery serializes writes and clear after a pending snapshot', async () => {
  const calls = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const disk = createDiskRecovery({ core: { invoke: async (cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === 'write_recovery') await gate;
  } } });
  const write = disk.write({ markdown: 'snapshot', path: null });
  const clear = disk.clear();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(calls[0][1].contents).version, 1);
  release();
  await Promise.all([write, clear]);
  assert.deepEqual(calls.map(([cmd]) => cmd), ['write_recovery', 'clear_recovery']);
});

test('disk queue recovers after a failed write and validates reads', async () => {
  let fail = true;
  const disk = createDiskRecovery({ core: { invoke: async (cmd) => {
    if (cmd === 'write_recovery' && fail) throw new Error('disk full');
    return JSON.stringify({ version: 1, markdown: '', path: null });
  } } });
  await assert.rejects(disk.write({ markdown: 'a' }), /disk full/);
  fail = false;
  await disk.write({ markdown: 'b' });
  assert.equal((await disk.read()).markdown, '');
});

test('listing and selecting recoveries uses serialized native commands', async () => {
  const calls = [];
  const disk = createDiskRecovery({ core: { invoke: async (cmd, args) => {
    calls.push([cmd, args]);
    return cmd === 'list_recoveries' ? JSON.stringify([{ id: 'session-1', path: null }]) : null;
  } } });
  assert.equal((await disk.list())[0].id, 'session-1');
  await disk.select('session-1');
  assert.deepEqual(calls.map(([cmd]) => cmd), ['list_recoveries', 'select_recovery']);
  assert.deepEqual(calls[1][1], { id: 'session-1' });
});
