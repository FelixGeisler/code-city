import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { waitForSave } from '../tools/browser-save-barrier.mjs';

function fixture() {
  const nodes = new Map([
    ['[data-save-status]', { textContent: 'Saving investigation' }],
    ['[data-save]', { hidden: false }],
    ['[data-status]', { textContent: '' }],
    ['[data-units] > [role=status]', { textContent: 'Unit inspection unavailable.' }],
    ['[data-source-body] [role=status]', { textContent: 'Source inspection unavailable.' }],
  ]);
  const location = { pathname: '/' };
  let check, disconnected = false;
  class MutationObserver {
    constructor(callback) { check = callback; }
    observe() {}
    disconnect() { disconnected = true; }
  }
  const wait = vm.runInNewContext(`(${waitForSave.toString()})`, { MutationObserver });
  const pending = wait({ querySelector: selector => nodes.get(selector) }, location);
  return { nodes, location, pending, change: () => check(), disconnected: () => disconnected };
}

test('Save waits for its own receipt, hidden action and canonical URL despite retained inspection errors', async () => {
  const f = fixture(); let settled = false;
  void f.pending.then(() => { settled = true; });
  f.change(); await Promise.resolve(); assert.equal(settled, false);
  f.nodes.get('[data-save-status]').textContent = 'Saved';
  f.change(); await Promise.resolve(); assert.equal(settled, false, 'Saved text alone is not readiness');
  f.nodes.get('[data-save]').hidden = true;
  f.location.pathname = '/saved/not-canonical';
  f.change(); await Promise.resolve(); assert.equal(settled, false, 'invalid identity is not readiness');
  f.location.pathname = '/saved/' + 'a'.repeat(43);
  f.change(); assert.equal((await f.pending).saved, true); assert.equal(f.disconnected(), true);
  assert.equal(f.nodes.get('[data-units] > [role=status]').textContent, 'Unit inspection unavailable.');
});

test('a failed Save remains a failure, not a success inferred from a retained scene', async () => {
  const f = fixture();
  f.nodes.get('[data-save-status]').textContent = 'Save failed. The current investigation is unchanged.';
  f.change(); const value = await f.pending;
  assert.equal(value.saved, false); assert.match(value.saveMessage, /Save failed/u); assert.equal(f.disconnected(), true);
});

test('Save still rejects presentation failure rather than ignoring global presentation loss', async () => {
  const f = fixture();
  f.nodes.get('[data-status]').textContent = 'Presentation failed (M1-PRES-1)';
  f.change(); await assert.rejects(f.pending, /Presentation failed/u); assert.equal(f.disconnected(), true);
});
