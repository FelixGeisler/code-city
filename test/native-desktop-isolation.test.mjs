import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile as callback } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, rm, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const execFile = promisify(callback);
const checker = fileURLToPath(new URL('../tools/check-local-folder-native.mjs', import.meta.url));
const helper = fileURLToPath(new URL('../tools/local-folder-native-windows.ps1', import.meta.url));
const windows = { skip: process.platform !== 'win32' };

// Only owned desktop creation and a Node/PowerShell no-GUI child. Not Chrome,
// UIAutomation, windows, foreground, focus, input, screenshots or user processes.
test('normal checker owns lpDesktop/job before no-GUI child execution and releases the exact resources', windows, async () => {
  const evidence = await mkdtemp(path.join(os.tmpdir(), 'code-city-isolation-test-'));
  try {
    await execFile(process.execPath, [checker, '--isolation-proof', '--evidence', evidence], { windowsHide: true, timeout: 30000 });
    const names = await readdir(evidence);
    const [parentName] = names.filter(n => /^isolation-[a-f0-9]{32}\.json$/.test(n));
    const parent = JSON.parse((await readFile(path.join(evidence, parentName), 'utf8')).replace(/^\uFEFF/, ''));
    const child = JSON.parse(await readFile(path.join(evidence, 'child-' + parent.nonce + '.json'), 'utf8'));
    assert.equal(parent.proofOnly, true);
    assert.equal(parent.status, 'passed');
    assert.equal(parent.child.lpDesktop, 'WinSta0\\' + parent.desktop);
    assert.equal(child.desktop, parent.desktop);
    assert.equal(child.targetPid, parent.child.pid);
    assert.notEqual(child.actorPid, child.targetPid, 'a real inherited helper, not self-reported environment');
    assert.deepEqual(child.isolation.child, parent.child);
    assert.equal(child.guiActions, 0);
    assert.deepEqual(child.guardRefusals, ['parent-outside-job', 'missing-window', 'wrong-desktop', 'wrong-owner-start', 'wrong-job']);
    assert.equal(parent.remainingProcesses, 0);
    assert.equal(parent.activeBeforeCleanup, 0, 'all inherited helpers exit naturally before desktop closure');
    assert.equal(parent.forcedJobTermination, undefined);
    assert.equal(parent.desktopHandleClosed, true);
    assert.equal(parent.desktopAbsent, true);
    assert.equal(parent.jobAbsent, true);
    assert.equal(parent.metadataAbsent, true);
    assert.equal(parent.cleanupError, undefined);
    await assert.rejects(readFile(path.join(parent.recordRoot, 'ownership.json')), { code: 'ENOENT' });
  } finally { await rm(evidence, { recursive: true, force: true }); }
});

test('failed isolated CreateProcess remains nonzero and proves exact desktop/job/metadata cleanup', windows, async () => {
  const evidence = await mkdtemp(path.join(os.tmpdir(), 'code-city-isolation-launch-failure-'));
  const launcher = fileURLToPath(new URL('../tools/native-desktop-launcher.ps1', import.meta.url));
  try {
    await assert.rejects(execFile('powershell.exe', ['-NoProfile', '-File', launcher,
      '-Node', path.join(evidence, 'missing-node.exe'), '-Evidence', evidence, '-Proof'],
      { windowsHide: true, timeout: 20000 }), e => e.code === 1);
    const [name] = (await readdir(evidence)).filter(n => /^isolation-[a-f0-9]{32}\.json$/.test(n));
    const result = JSON.parse((await readFile(path.join(evidence, name), 'utf8')).replace(/^\uFEFF/, ''));
    assert.equal(result.status, 'failed');
    assert.match(result.error, /Isolated CreateProcess failed/);
    assert.equal(result.remainingProcesses, 0);
    assert.equal(result.desktopAbsent, true);
    assert.equal(result.jobAbsent, true);
    assert.equal(result.metadataAbsent, true);
    assert.equal(result.cleanupError, undefined);
  } finally { await rm(evidence, { recursive: true, force: true }); }
});

test('internal child flag cannot bypass isolation or reach Chrome discovery', windows, async () => {
  const evidence = await mkdtemp(path.join(os.tmpdir(), 'code-city-isolation-refusal-'));
  const env = { ...process.env }; delete env.CODE_CITY_NATIVE_ISOLATION_FILE;
  try {
    await assert.rejects(execFile(process.execPath, [checker, '--isolation-child-proof', '--evidence', evidence],
      { env, windowsHide: true, timeout: 20000 }), e => {
      assert.match(e.stderr, /Owned non-input desktop record required/); return e.code === 1;
    });
    assert.deepEqual(await readdir(evidence), []);
  } finally { await rm(evidence, { recursive: true, force: true }); }
});

test('a forged nonce record cannot authorize the normal Windows checker on Default', windows, async () => {
  const nonce = randomUUID().replaceAll('-', '');
  const root = path.join(os.tmpdir(), 'code-city-desktop-' + nonce);
  const evidence = await mkdtemp(path.join(os.tmpdir(), 'code-city-isolation-forged-'));
  await mkdir(root);
  try {
    const record = path.join(root, 'ownership.json');
    await writeFile(record, JSON.stringify({ schema: 1, nonce, desktop: 'CodeCityNative-' + nonce,
      job: 'Local\\CodeCityNative-' + nonce, ownerPid: process.pid, ownerTicks: '1', ownerExecutable: process.execPath }));
    await assert.rejects(execFile(process.execPath, [checker, '--allow-public-documents-synthetic', '--evidence', evidence],
      { env: { ...process.env, CODE_CITY_NATIVE_ISOLATION_FILE: record }, windowsHide: true, timeout: 20000 }), e => {
      assert.match(e.stderr, /Actor\/target desktop mismatch/); return e.code === 1;
    });
    const files = await readdir(evidence);
    assert(files.every(n => /^isolation-child-failure-\d+\.json$/.test(n)), 'no browser qualification run directory');
  } finally { await rm(root, { recursive: true, force: true }); await rm(evidence, { recursive: true, force: true }); }
});

test('compiled production Win32 action wrappers reject Default/wrong desktop BEFORE native actuation', windows, async () => {
  const source = helper.replaceAll("'", "''");
  const script = `
    $ErrorActionPreference='Stop'
    $tokens=$null;$errors=$null
    $ast=[Management.Automation.Language.Parser]::ParseFile('${source}',[ref]$tokens,[ref]$errors)
    if($errors.Count){throw 'Helper parse errors'}
    $compile=@($ast.FindAll({param($n) $n -is [Management.Automation.Language.CommandAst] -and $n.Extent.Text.StartsWith('Add-Type -TypeDefinition')},$true))
    if($compile.Count -ne 1){throw 'Expected actual production Win32 compilation'}
    $code=$compile[0].Extent.Text.Replace('$PSScriptRoot',([char]39+'${path.dirname(helper).replaceAll("'", "''")}'+[char]39))
    Invoke-Expression $code
    $desktop='CodeCityNative-'+[Guid]::NewGuid().ToString('N')
    $refused=@()
    foreach($sample in @(
      @('Default','Default','Default'),
      @($desktop,'Default','Default'),
      @($desktop,$desktop,$desktop)
    )){
      try{[NativeDesktopIsolation]::CheckNames($sample[0],$sample[1],$sample[2]);throw 'Unexpected acceptance'}catch{if($_.Exception.Message -like '*Unexpected acceptance*'){throw};$refused+=$_.Exception.Message}
    }
    [NativeDesktopIsolation]::CheckNames($desktop,$desktop,'Default')
    try{[NativeDesktopIsolation]::Configure($desktop,'missing',0,0,'missing');throw 'Unexpected acceptance'}catch{if($_.Exception.Message -notlike '*desktop mismatch*'){throw}}
    $actions=@()
    foreach($name in @('MoveWindow','ShowWindow','Send','SendText','ReadText')){
      $r=[IntPtr]::Zero
      try{
        switch($name){
          'MoveWindow' {[void][NativeProbe]::MoveWindow([IntPtr]::Zero,0,0,1,1,$false)}
          'ShowWindow' {[void][NativeProbe]::ShowWindow([IntPtr]::Zero,0)}
          'Send' {[void][NativeProbe]::Send([IntPtr]::Zero,0,[IntPtr]::Zero,[IntPtr]::Zero,0,1,[ref]$r)}
          'SendText' {[void][NativeProbe]::SendText([IntPtr]::Zero,0,[IntPtr]::Zero,'synthetic',0,1,[ref]$r)}
          'ReadText' {[void][NativeProbe]::ReadText([IntPtr]::Zero,0,[IntPtr]::Zero,(New-Object Text.StringBuilder),0,1,[ref]$r)}
        }
        throw 'Unexpected actuation'
      }catch{if($_.Exception.Message -notlike '*desktop mismatch*'){throw};$actions+=$name}
    }
    # A real no-GUI child cannot execute even when job assignment fails. The
    # caller still owns its handles and joins that exact child before closure.
    $d=[NativeDesktopIsolation]::CreateOwnedDesktop($desktop)
    $jobName='Local\\'+$desktop
    $job=[NativeDesktopIsolation]::CreateOwnedJob($jobName)
    $child=New-Object NativeDesktopIsolation+Child
    try{
      $child=[NativeDesktopIsolation]::Launch($desktop,'${process.execPath.replaceAll("'", "''")}','"${process.execPath.replaceAll("'", "''")}" -e "process.exit(99)"','${os.tmpdir().replaceAll("'", "''")}')
      try{[NativeDesktopIsolation]::AssignChild([IntPtr]::Zero,$child);throw 'Unexpected assignment'}catch{if($_.Exception.Message -notlike '*Assign owned job failed*'){throw}}
      if([NativeDesktopIsolation]::WaitForSingleObject($child.process,0) -ne 258){throw 'Suspended child ran before containment'}
    }finally{
      if($child.process -ne [IntPtr]::Zero){
        [NativeDesktopIsolation]::TerminateChild($child)
        if([NativeDesktopIsolation]::WaitForSingleObject($child.process,5000) -ne 0){throw 'Child exit unproved; retain desktop'}
        if(-not [NativeDesktopIsolation]::CloseHandle($child.thread)){throw 'Thread handle closure failed'}
        if(-not [NativeDesktopIsolation]::CloseHandle($child.process)){throw 'Process handle closure failed'}
      }
      if([NativeDesktopIsolation]::ActiveProcesses($job) -ne 0){throw 'Unexpected job child; retain desktop'}
      if(-not [NativeDesktopIsolation]::CloseDesktop($d)){throw 'Desktop closure failed'}
      if(-not [NativeDesktopIsolation]::CloseHandle($job)){throw 'Job closure failed'}
    }
    if([NativeDesktopIsolation]::DesktopExists($desktop) -or [NativeDesktopIsolation]::JobExists($jobName)){throw 'Exact isolated resource remains'}
    @{nameRefusals=$refused;guardedActions=$actions;failedAssignmentChildJoined=$true}|ConvertTo-Json -Compress
  `;
  const { stdout } = await execFile('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true, timeout: 20000 });
  const result = JSON.parse(stdout);
  assert.equal(result.nameRefusals.length, 3);
  assert.match(result.nameRefusals[0], /Invalid owned desktop nonce/);
  assert.match(result.nameRefusals[1], /desktop mismatch/);
  assert.match(result.nameRefusals[2], /input desktop/);
  assert.deepEqual(result.guardedActions, ['MoveWindow', 'ShowWindow', 'Send', 'SendText', 'ReadText']);
  assert.equal(result.failedAssignmentChildJoined, true);
});
