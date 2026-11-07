import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile as execFileCallback, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { recordWindowsHelper } from '../tools/check-local-folder-native.mjs';

const execFile = promisify(execFileCallback);
const snapshot = { mode: 'select', phase: 'action-select', error: 'Expected exactly one owned dialog, got 0',
  ownedProcesses: [{ pid: 42, creationTicks: '123', role: 'browser' }], dialogs: [], action: null };

test('failed Windows helper snapshot is saved before its original nonzero exit propagates', async () => {
  const error = Object.assign(Error('helper failed'), { code: 1, stdout: JSON.stringify(snapshot), stderr: 'x'.repeat(20000) });
  const result = { actions: [] };
  let saved;
  await assert.rejects(recordWindowsHelper(async () => { throw error; }, 'select', result,
    async () => { saved = structuredClone(result); }), e => e === error);
  assert.deepEqual(saved.actions, [snapshot]);
  assert.equal(saved.windowsHelperFailure.mode, 'select');
  assert.equal(saved.windowsHelperFailure.stderr.length, 16384);
  assert.equal(result.status, undefined, 'evidence cannot turn failure into qualification');
});

test('missing/malformed helper stdout cannot conceal its original failure or invent an action', async () => {
  for (const stdout of [undefined, '', 'not JSON']) {
    const error = Object.assign(Error('spawn/helper failure'), { stdout });
    const result = { actions: [] };
    let saved = false;
    await assert.rejects(recordWindowsHelper(async () => { throw error; }, 'inspect', result,
      async () => { saved = true; }), e => e === error);
    assert.equal(saved, true);
    assert.deepEqual(result.actions, []);
  }
});

test('successful helper output is preserved once, without asserting picker resolution', async () => {
  const data = { ...snapshot, error: null, action: { mode: 'allow-read', mechanism: 'scoped UIAutomation InvokePattern' } };
  const result = { actions: [] };
  let saves = 0;
  assert.deepEqual(await recordWindowsHelper(async () => ({ stdout: JSON.stringify(data) }), 'allow-read', result,
    async () => { saves++; }), data);
  assert.deepEqual(result.actions, [data]);
  assert.equal(saves, 1);
  assert.equal(result.status, undefined);
});

// Exercise the actual PowerShell catch/output path, using an owned Node child
// with NO GUI, Chrome, synthetic directory or access to any other process window.
test('Windows helper emits ownership/cardinality and identity failures as JSON plus nonzero exit',
  { skip: process.platform !== 'win32' }, async () => {
    const profile = 'CodeCitySynthetic-evidence-test';
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', '--', '--user-data-dir=' + profile],
      { windowsHide: true, stdio: 'ignore' });
    const closed = once(child, 'close');
    try {
      await once(child, 'spawn');
      const helper = fileURLToPath(new URL('../tools/local-folder-native-windows.ps1', import.meta.url));
      const args = ['-NoProfile', '-File', helper, '-OwnedPid', String(child.pid), '-Executable', process.execPath, '-Profile', profile];
      const invoke = more => execFile('powershell.exe', [...args, ...more], { windowsHide: true, timeout: 20000 });
      const result = { actions: [] };
      let saved;
      await assert.rejects(recordWindowsHelper(() => invoke(['-Mode', 'select']), 'select', result,
        async () => { saved = structuredClone(result); }), e => e.code === 1);
      const [data] = saved.actions;
      assert.equal(data.error, 'Expected exactly one owned dialog, got 0');
      assert.equal(data.phase, 'action-select');
      assert.equal(data.pid, child.pid);
      assert.equal(data.ownedProcesses[0].pid, child.pid);
      assert.match(data.ownedProcesses[0].creationTicks, /^\d+$/);
      assert.deepEqual(data.dialogs, []);
      assert.equal(data.action, null);
      assert(data.started <= data.finished);
      assert.equal(typeof data.desktop, 'string');
      await assert.rejects(invoke(['-Mode', 'inspect', '-CreationTicks', '1']), e => {
        const failure = JSON.parse(e.stdout);
        assert.equal(e.code, 1);
        assert.equal(failure.error, 'Creation time mismatch');
        assert.equal(failure.phase, 'verify');
        assert.deepEqual(failure.ownedProcesses, []);
        assert.deepEqual(failure.ownedTopClasses, []);
        assert.equal(failure.action, null);
        return true;
      });
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await closed;
    }
  });
