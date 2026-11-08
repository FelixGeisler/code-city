import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile as execFileCallback, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { recordWindowsHelper, recordWindowsPickerFailure } from '../tools/check-local-folder-native.mjs';

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

test('rejecting helper evidence save preserves the original error and separately reports bounded unpersisted diagnostics', async t => {
  const error = Object.assign(Error('helper failed'), { code: 1, stdout: JSON.stringify(snapshot) });
  const saveError = Error('EACCES: ' + 'x'.repeat(20000));
  const result = { actions: [], status: 'failed' };
  const reports = [];
  t.mock.method(console, 'error', message => reports.push(message));
  let invokes = 0, saves = 0;
  await assert.rejects(recordWindowsHelper(async () => { invokes++; throw error; }, 'select', result,
    async () => { saves++; throw saveError; }), e => e === error);
  assert.equal(invokes, 1);
  assert.equal(saves, 1, 'no diagnostic save retry');
  assert.deepEqual(result.actions, [snapshot]);
  assert.equal(result.windowsHelperFailure.message, error.message);
  assert.deepEqual(result.windowsEvidenceSaveErrors, { helper: { message: saveError.message.slice(0, 2048) } });
  assert.equal(reports.length, 1);
  assert.match(reports[0], /snapshot not persisted/);
  assert(reports[0].length < 4096);
  assert.equal(result.status, 'failed');
});

test('rejecting picker-timeout evidence save preserves the original error without repeating inspection or action', async t => {
  const error = Error('Native picker resolution unavailable within 10s');
  const saveError = Error('ENOSPC: ' + 'x'.repeat(20000));
  const result = { actions: [], status: 'failed' };
  const state = { state: 'pending', error: null, focused: true };
  const calls = [], reports = [];
  t.mock.method(console, 'error', message => reports.push(message));
  await assert.rejects(recordWindowsPickerFailure(error,
    async () => { calls.push('state'); return state; },
    async () => { calls.push('inspect-browser'); }, result,
    async () => { calls.push('save'); throw saveError; }), e => e === error);
  assert.deepEqual(calls, ['state', 'inspect-browser', 'save']);
  assert.deepEqual(result.windowsPickerFailure, state);
  assert.deepEqual(result.actions, []);
  assert.deepEqual(result.windowsEvidenceSaveErrors, { pickerResolution: { message: saveError.message.slice(0, 2048) } });
  assert.equal(reports.length, 1);
  assert.match(reports[0], /snapshot not persisted/);
  assert(reports[0].length < 4096);
  assert.equal(result.status, 'failed');
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

test('picker timeout remains primary when its helper inspection and both diagnostic saves fail', async t => {
  const error = Error('Native picker resolution unavailable within 10s');
  const inspectError = Object.assign(Error('inspection failed'), { code: 1, stdout: JSON.stringify(snapshot) });
  const result = { actions: [], status: 'failed' };
  const reports = [];
  t.mock.method(console, 'error', message => reports.push(message));
  let invokes = 0, saves = 0;
  const save = async () => { saves++; throw Error('EACCES'); };
  await assert.rejects(recordWindowsPickerFailure(error, async () => ({ state: 'pending' }),
    () => recordWindowsHelper(async () => { invokes++; throw inspectError; }, 'inspect-browser', result, save),
    result, save), e => e === error);
  assert.equal(invokes, 1);
  assert.equal(saves, 2, 'one save per distinct failure path, not a retry');
  assert.equal(result.windowsInspectionError, inspectError.message);
  assert.deepEqual(result.windowsEvidenceSaveErrors, {
    helper: { message: 'EACCES' }, pickerResolution: { message: 'EACCES' },
  });
  assert.equal(reports.length, 2);
  assert.equal(result.status, 'failed');
});

test('picker inspection failure is saved without replacing the timeout when persistence works', async () => {
  const error = Error('Native picker resolution unavailable within 10s');
  const result = { actions: [] };
  let saved;
  await assert.rejects(recordWindowsPickerFailure(error, async () => ({ state: 'pending' }),
    async () => { throw Error('inspection unavailable'); }, result,
    async () => { saved = structuredClone(result); }), e => e === error);
  assert.equal(saved.windowsInspectionError, 'inspection unavailable');
  assert.deepEqual(saved.windowsPickerFailure, { state: 'pending' });
  assert.equal(saved.windowsEvidenceSaveErrors, undefined);
});

test('successful helper still rejects a failed normal evidence save', async () => {
  const saveError = Error('EACCES');
  const result = { actions: [] };
  await assert.rejects(recordWindowsHelper(async () => ({ stdout: JSON.stringify(snapshot) }), 'inspect', result,
    async () => { throw saveError; }), e => e === saveError);
  assert.equal(result.windowsEvidenceSaveErrors, undefined, 'only failure diagnostics are best effort');
});

test('both rejecting-save failure paths remain nonzero in no-GUI Node children', async () => {
  const moduleUrl = new URL('../tools/check-local-folder-native.mjs', import.meta.url).href;
  for (const flow of ['helper', 'picker']) {
    const script = `import { recordWindowsHelper, recordWindowsPickerFailure } from ${JSON.stringify(moduleUrl)};
      const primary = Error('PRIMARY_NATIVE_FAILURE');
      const result = { actions: [], status: 'failed' };
      const save = async () => { throw Error('SECONDARY_SAVE_FAILURE'); };
      if (${JSON.stringify(flow)} === 'helper') await recordWindowsHelper(async () => { throw primary; }, 'select', result, save);
      else await recordWindowsPickerFailure(primary, async () => ({ state: 'pending' }), async () => {}, result, save);`;
    await assert.rejects(execFile(process.execPath, ['--input-type=module', '-e', script], { windowsHide: true, timeout: 10000 }), e => {
      assert.equal(e.code, 1, flow);
      assert.match(e.stderr, /snapshot not persisted/);
      assert.match(e.stderr, /Error: PRIMARY_NATIVE_FAILURE/);
      assert.doesNotMatch(e.stderr, /Error: SECONDARY_SAVE_FAILURE/);
      return true;
    });
  }
});

test('focused permission Invoke with an unchanged remaining prompt still propagates picker timeout', async () => {
  const permission = { ...snapshot, mode: 'allow-read', error: null,
    permissionFocus: { state: { isolationValidated: true, active: true, focused: true }, settleMs: 500 },
    action: { mode: 'allow-read', runtimeId: 'owned:731', invokeReturned: 'now' },
    permissionAfter: [{ runtimeId: 'owned:716', enabled: true }, { runtimeId: 'owned:731', enabled: true }] };
  const result = { actions: [], status: 'failed' };
  let calls = 0;
  await recordWindowsHelper(async () => { calls++; return { stdout: JSON.stringify(permission) }; }, 'allow-read', result, async () => {});
  const error = Error('Native picker resolution unavailable within 10s');
  await assert.rejects(recordWindowsPickerFailure(error, async () => ({ state: 'pending', focused: false }),
    async () => { calls++; }, result, async () => {}), e => e === error);
  assert.equal(calls, 2, 'one Invoke helper and one read-only inspection, no action retry');
  assert.deepEqual(result.actions, [permission]);
  assert.equal(result.windowsPickerFailure.state, 'pending');
  assert.equal(result.status, 'failed', 'foreground/focus and Invoke success do not grant a capability');
});

// Execute the production readiness function with synthetic state only. No GUI,
// input, Chrome or other windows. Native acceptance is exercised by the checker.
test('Windows permission readiness requires a stable focused target for the entire protection interval',
  { skip: process.platform !== 'win32' }, async () => {
    const helper = fileURLToPath(new URL('../tools/local-folder-native-windows.ps1', import.meta.url));
    const script = `
      $ErrorActionPreference='Stop'
      $tokens=$null;$errors=$null
      $ast=[Management.Automation.Language.Parser]::ParseFile('${helper.replaceAll("'", "''")}',[ref]$tokens,[ref]$errors)
      if($errors.Count){throw 'Helper parse errors'}
      $f=@($ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Wait-PermissionReady'},$true))
      if($f.Count -ne 1){throw 'Expected production readiness function'}
      Invoke-Expression $f[0].Extent.Text
      $counts=@{reads=0};$evidence=@{}
      $ready=@{isolationValidated=$true;active=$true;focused=$true;pid=42;enabled=$true;offscreen=$false;runtimeId='owned:731';rect='synthetic rectangle'}
      Wait-PermissionReady -ExpectedPid 42 -RuntimeId 'owned:731' -SettleMs 5 -Evidence $evidence -ReadState {
        $counts.reads++;if($counts.reads -eq 1){Start-Sleep -Milliseconds 20};$ready
      }
      $positive=@{reads=$counts.reads;observedMs=$evidence.observedMs;settled=$evidence.settled}
      $failures=@()
      foreach($change in @('isolationValidated','active','focused','pid','enabled','offscreen','runtimeId','rect')){
        $counts.reads=0;$evidence=@{};$bad=$ready.Clone()
        switch($change){
          'pid' {$bad.pid=43}
          'offscreen' {$bad.offscreen=$true}
          'runtimeId' {$bad.runtimeId='replacement'}
          'rect' {$bad.rect='moved'}
          default {$bad[$change]=$false}
        }
        $message=$null
        try {
          Wait-PermissionReady -ExpectedPid 42 -RuntimeId 'owned:731' -SettleMs 5 -Evidence $evidence -ReadState {
            $counts.reads++;if($counts.reads -eq 1){$ready}else{$bad}
          }
        } catch {$message=$_.Exception.Message}
        if(-not $message){throw ('Accepted changed '+$change)}
        $failures+=@{change=$change;reads=$counts.reads;message=$message;settled=$evidence.ContainsKey('settled')}
      }
      @{positive=$positive;failures=$failures}|ConvertTo-Json -Depth 5 -Compress
    `;
    const { stdout } = await execFile('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true, timeout: 20000 });
    const result = JSON.parse(stdout);
    assert(result.positive.reads >= 2, 'slow first read cannot consume the readiness interval');
    assert(result.positive.observedMs >= 5);
    assert(result.positive.settled);
    assert.equal(result.failures.length, 8);
    for (const failure of result.failures) {
      assert.equal(failure.reads, 2, failure.change + ': no readiness restart');
      assert.equal(failure.settled, false);
      assert.match(failure.message, /focus unavailable|target changed|target moved/);
    }
  });

// Exercise the actual PowerShell catch/output path, using an owned Node child
// with NO GUI, Chrome, synthetic directory or access to any other process window.
test('Windows helper on Default fails isolation before ownership, cardinality or action even when invoked manually',
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
      assert.match(data.error, /Owned non-input desktop record required/);
      assert.equal(data.phase, 'isolation-guard');
      assert.equal(data.pid, child.pid);
      assert.deepEqual(data.ownedProcesses, [], 'Default helper must fail before process/window inspection');
      assert.deepEqual(data.dialogs, []);
      assert.equal(data.action, null);
      assert(data.started <= data.finished);
      assert.equal(data.desktop, null);
      await assert.rejects(invoke(['-Mode', 'inspect', '-CreationTicks', '1']), e => {
        const failure = JSON.parse(e.stdout);
        assert.equal(e.code, 1);
        assert.match(failure.error, /Owned non-input desktop record required/);
        assert.equal(failure.phase, 'isolation-guard');
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
