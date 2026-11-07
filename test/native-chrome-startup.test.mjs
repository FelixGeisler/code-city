import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { test } from 'node:test';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { launchNativeChrome, observeChromeStartup } from '../tools/check-local-folder-native.mjs';

const url = 'ws://127.0.0.1:12345/devtools/browser/owned';
function fixture(properties = {}) {
  const child = Object.assign(new EventEmitter(), {
    stderr: new EventEmitter(), exitCode: null, signalCode: null,
  }, properties);
  const result = {};
  const startup = observeChromeStartup({ child }, result);
  return { child, result, startup };
}
function released(child) {
  assert.equal(child.listenerCount('error'), 0);
  assert.equal(child.listenerCount('exit'), 0);
  assert.equal(child.stderr.listenerCount('data'), 0);
}

test('owned Node exit during async setup is observed before the owner awaits startup', async () => {
  const result = {};
  const chrome = launchNativeChrome(process.execPath,
    ['-e', 'process.stderr.write("synthetic startup failure\\n"); process.exit(23)'], {}, result);
  // These listeners must exist synchronously, before any OS metadata/helper await.
  assert.equal(chrome.child.listenerCount('exit'), 1);
  assert.equal(chrome.child.stderr.listenerCount('data'), 1);
  try {
    const closed = await chrome.closed; // deterministic async setup barrier, no sleep or GUI
    await nextTurn(); // an unobserved rejection would fail node:test here
    assert.equal(closed.code, 23);
    assert.equal(result.chromeStartup.status, 'exit');
    assert.equal(result.chromeStartup.exitCode, 23);
    assert.match(result.chromeStderr, /synthetic startup failure/);
    await assert.rejects(chrome.startup.endpoint, /Chrome exited before CDP \(code=23, signal=null\)/);
    assert.equal(chrome.child.listenerCount('exit'), 0);
    assert.equal(chrome.child.stderr.listenerCount('data'), 0);
  } finally {
    chrome.startup.dispose();
    if (chrome.child.exitCode === null && chrome.child.signalCode === null) chrome.child.kill();
    await chrome.closed;
  }
});

test('owned Node endpoint during setup survives later exit and retains the close barrier', async () => {
  const result = {};
  const chrome = launchNativeChrome(process.execPath,
    ['-e', `process.stderr.write(${JSON.stringify(`DevTools listening on ${url}\n`)});`], {}, result);
  try {
    assert.deepEqual(await chrome.closed, { code: 0, signal: null });
    await nextTurn();
    assert.equal(await chrome.startup.endpoint, url);
    assert.equal(result.chromeStartup.status, 'endpoint');
    assert.equal(chrome.child.listenerCount('exit'), 0);
    assert.equal(chrome.child.stderr.listenerCount('data'), 0);
  } finally {
    chrome.startup.dispose();
    if (chrome.child.exitCode === null && chrome.child.signalCode === null) chrome.child.kill();
    await chrome.closed;
  }
});

test('spawn error during async setup stays handled but still rejects to its owner', async () => {
  const result = {};
  const chrome = launchNativeChrome(path.join(os.tmpdir(), 'code-city-missing-' + randomUUID()), [], {}, result);
  await chrome.closed;
  await nextTurn();
  assert.equal(result.chromeStartup.status, 'error');
  await assert.rejects(chrome.startup.endpoint, error => error === chrome.error && error.code === 'ENOENT');
  assert.equal(chrome.child.listenerCount('exit'), 0);
  assert.equal(chrome.child.stderr.listenerCount('data'), 0);
});

test('already-terminal exit, signal and captured spawn error reject immediately', async () => {
  for (const properties of [{ exitCode: 7 }, { signalCode: 'SIGTERM' }]) {
    const { child, result, startup } = fixture(properties);
    await assert.rejects(startup.endpoint, /Chrome exited before CDP/);
    assert.equal(result.chromeStartup.status, 'exit');
    assert.equal(result.chromeStartup.exitCode, child.exitCode);
    assert.equal(result.chromeStartup.signalCode, child.signalCode);
    released(child);
  }
  const child = Object.assign(new EventEmitter(), {stderr: new EventEmitter(), exitCode: null, signalCode: null});
  const error = Error('already failed to spawn');
  const result = {};
  const startup = observeChromeStartup({ child, error }, result);
  await assert.rejects(startup.endpoint, e => e === error);
  assert.equal(result.chromeStartup.error, error.message);
  released(child);
});

test('early error and exit settle only once and release startup listeners', async () => {
  for (const first of ['error', 'exit']) {
    const { child, result, startup } = fixture();
    const error = Error('synthetic early error');
    if (first === 'error') child.emit('error', error);
    else child.emit('exit', 9, null);
    await nextTurn(); // delayed owner must not create unhandled rejection
    await assert.rejects(startup.endpoint, e => first === 'error' ? e === error : /code=9/.test(e.message));
    assert.equal(result.chromeStartup.status, first);
    child.emit('exit', 0, null);
    child.stderr.emit('data', `DevTools listening on ${url}\n`);
    startup.dispose();
    await assert.rejects(startup.endpoint);
    released(child);
  }
});

test('split notice and URL resolve only when complete, then terminal events cannot change success', async () => {
  const { child, result, startup } = fixture();
  let settled = false;
  startup.endpoint.then(() => { settled = true; });
  child.stderr.emit('data', 'noise\nDevTools list');
  child.stderr.emit('data', 'ening on ws://127.0.0.1:123');
  await nextTurn();
  assert.equal(settled, false, 'a partial URL must not be accepted');
  child.stderr.emit('data', '45/devtools/browser/owned');
  await nextTurn();
  assert.equal(settled, false, 'wait for the URL delimiter');
  child.stderr.emit('data', '\n');
  assert.equal(await startup.endpoint, url);
  assert.equal(result.chromeStartup.status, 'endpoint');
  released(child);
  child.emit('exit', 0, null);
  startup.dispose();
  assert.equal(await startup.endpoint, url);
});

test('stderr retains only its latest 16 KiB, including UTF-8 and endpoint chunks', async () => {
  const { child, result, startup } = fixture();
  child.stderr.emit('data', Buffer.alloc(20000, 'x'));
  assert.equal(Buffer.byteLength(result.chromeStderr), 16384);
  const unicode = Buffer.from('😀'.repeat(6000));
  child.stderr.emit('data', unicode.subarray(0, unicode.length - 1));
  assert(Buffer.byteLength(result.chromeStderr) <= 16384);
  child.stderr.emit('data', unicode.subarray(unicode.length - 1));
  assert(Buffer.byteLength(result.chromeStderr) <= 16384);
  assert(result.chromeStderr.endsWith('😀'));
  child.stderr.emit('data', `\nDevTools listening on ${url}\n`);
  assert.equal(await startup.endpoint, url);
  assert(Buffer.byteLength(result.chromeStderr) <= 16384);
  assert(!result.chromeStderr.includes('x'));
  released(child);
});

test('deadline remains exactly 20 seconds from registration, including async setup', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { child, result, startup } = fixture();
  t.mock.timers.tick(19999);
  await nextTurn();
  assert.equal(result.chromeStartup.status, 'waiting');
  t.mock.timers.tick(1);
  await nextTurn();
  assert.equal(result.chromeStartup.deadlineMs, 20000);
  assert.equal(result.chromeStartup.status, 'timeout');
  await assert.rejects(startup.endpoint, /^Error: Headed Chrome startup timed out$/);
  released(child);
});

test('setup failure disposal releases listeners and preserves the rejecting owner promise', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { child, result, startup } = fixture();
  startup.dispose();
  startup.dispose();
  await nextTurn();
  await assert.rejects(startup.endpoint, /Chrome startup observation disposed/);
  assert.equal(result.chromeStartup.status, 'disposed');
  released(child);
  t.mock.timers.tick(20000);
  assert.equal(result.chromeStartup.status, 'disposed');
});
