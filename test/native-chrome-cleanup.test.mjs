import assert from 'node:assert/strict';
import { spawn, execFile as callback } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { test } from 'node:test';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { closeNativeChrome, recordShutdownError } from '../tools/check-local-folder-native.mjs';

async function ownedChild(t) {
  const child = spawn(process.execPath, ['-e', `process.stdin.once('data',()=>process.exit(0));process.stdout.write('ready');`],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await closed; });
  await once(child.stdout, 'data');
  return { child, closed };
}

test('lost Browser.close response joins a real child normally, without interrupting shutdown', async t => {
  const chrome = await ownedChild(t), diagnostics = {};
  let forced = false;
  const stopping = closeNativeChrome(chrome, { async send(method) {
    assert.equal(method, 'Browser.close'); throw Error('CDP WebSocket closed');
  }, close() {} }, async () => { forced = true; chrome.child.kill(); }, 15000, diagnostics);
  await nextTurn(); // send rejection has been handled; the child is still joining
  assert.equal(chrome.child.killed, false, 'lost ACK must not force-kill');
  assert.equal(chrome.child.exitCode, null);
  chrome.child.stdin.end('complete normal join');
  await stopping;
  assert.equal(forced, false);
  assert.equal(diagnostics.forced, undefined);
  assert.equal(diagnostics.requestError, 'CDP WebSocket closed');
  assert.deepEqual(diagnostics.closed, { code: 0, signal: null });
  assert.equal(diagnostics.final.stderrClosed, true);
  assert.equal(diagnostics.final.stderrEnded, true);
});

test('normal exit alone cannot pass while a real no-GUI descendant retains inherited stderr', async t => {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const connected = once(server, 'connection');
  const descendant = `const net=require('node:net');const s=net.connect(${server.address().port},'127.0.0.1',()=>process.send('ready'));s.once('data',()=>{s.destroy();if(process.connected)process.disconnect();});`;
  // Only this synthetic no-GUI descendant is detached, so Windows' ordinary
  // per-child job cannot kill it at parent exit. Native Chrome's reviewed
  // non-breakaway desktop/job containment is not changed or bypassed.
  const child = spawn(process.execPath, ['-e', `const {spawn}=require('node:child_process');const d=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{windowsHide:true,detached:true,stdio:['ignore','inherit','inherit','ipc']});d.once('message',()=>process.exit(0));`],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.resume(); child.stderr.resume();
  const exited = once(child, 'exit');
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  const [socket] = await connected;
  t.after(async () => {
    socket.end('join');
    if (child.exitCode === null) child.kill();
    await closed;
    await new Promise(resolve => server.close(resolve));
  });
  const diagnostics = {};
  let settled = false;
  const stopping = closeNativeChrome({ child, closed }, { async send() {}, close() {} },
    async () => { assert.fail('normal descendant join must not force shutdown'); }, 15000, diagnostics)
    .then(() => { settled = true; });
  await exited;
  await nextTurn();
  assert.equal(child.exitCode, 0);
  assert.equal(child.stderr.closed, false);
  assert.equal(settled, false, 'process exit is not inherited-stdio closure');
  socket.end('join');
  await stopping;
  assert.equal(diagnostics.final.stderrClosed, true);
  assert.equal(diagnostics.forced, undefined);
});

test('actual abnormal child exit remains failure even when Browser.close was acknowledged', async t => {
  const chrome = await ownedChild(t), diagnostics = {};
  const stopping = closeNativeChrome(chrome, { async send() { chrome.child.kill(); }, close() {} },
    async () => {}, 15000, diagnostics);
  await assert.rejects(stopping, /Chrome did not shut down cleanly/);
  assert.equal(diagnostics.acknowledged, true);
  assert.equal(diagnostics.forced, true);
});

test('native close deadline releases the real child but preserves first error and secondary cleanup failure', async t => {
  const chrome = await ownedChild(t), diagnostics = {};
  await assert.rejects(closeNativeChrome(chrome, { send: () => new Promise(() => {}), close() { throw Error('secondary CDP disconnect'); } },
    async () => { throw Error('secondary termination observation'); }, 40, diagnostics), /Chrome closed barrier timed out/);
  assert.equal(diagnostics.cleanupError, 'secondary termination observation');
  assert.equal(diagnostics.disconnectError, 'secondary CDP disconnect');
  assert.equal(diagnostics.beforeForced.exitCode, null);
  assert.equal(diagnostics.beforeForced.stderrClosed, false);
  assert.equal(diagnostics.final.stderrClosed, true);
  assert.equal(diagnostics.forced, true);
  assert(chrome.child.exitCode !== null || chrome.child.signalCode !== null);
  const result = {};
  recordShutdownError(result, 'chrome-close', Error('Chrome closed barrier timed out'));
  recordShutdownError(result, 'remaining-processes', Error('Owned Chrome processes remain'));
  assert.equal(result.shutdownError, 'Chrome closed barrier timed out');
  assert.deepEqual(result.shutdownErrors.map(e => [e.stage, e.message]), [
    ['chrome-close', 'Chrome closed barrier timed out'], ['remaining-processes', 'Owned Chrome processes remain'],
  ]);
});

test('Windows cleanup CLI preserves multiple JSON identities and signals only a verified live owned child',
  { skip: process.platform !== 'win32' }, async t => {
    const chrome = await ownedChild(t);
    const execFile = promisify(callback);
    const helper = fileURLToPath(new URL('../tools/native-process-cleanup.ps1', import.meta.url));
    const options = { windowsHide: true, timeout: 20000 };
    const { stdout } = await execFile('powershell.exe', ['-NoProfile', '-Command',
      `[Diagnostics.Process]::GetProcessById(${chrome.child.pid}).StartTime.ToUniversalTime().Ticks.ToString()`], options);
    const identity = { pid: chrome.child.pid, ticks: stdout.trim() };
    const reused = { pid: chrome.child.pid, ticks: '1' };
    const run = async (items, terminate = false) => JSON.parse((await execFile('powershell.exe', ['-NoProfile', '-File', helper,
      '-IdentitiesJson', JSON.stringify(items), '-Executable', process.execPath, ...(terminate ? ['-Terminate'] : [])], options)).stdout);
    const live = await run([identity, reused]);
    assert.deepEqual(live.remaining, [identity]);
    assert.deepEqual(live.reused, [reused]);
    const refusal = await run([reused], true);
    assert.deepEqual(refusal.stopped, []);
    assert.equal(chrome.child.exitCode, null);
    const forced = await run([identity], true);
    assert.deepEqual(forced.stopped, [identity]);
    const closed = await chrome.closed;
    assert(closed.code !== 0 || closed.signal !== null, 'forced cleanup is not normal qualification');
  });

test('production Windows predicate distinguishes retained exited handles, reused identities and real live children',
  { skip: process.platform !== 'win32' }, async () => {
    const helper = fileURLToPath(new URL('../tools/native-process-cleanup.ps1', import.meta.url)).replaceAll("'", "''");
    const node = process.execPath.replaceAll("'", "''");
    const script = `
      $ErrorActionPreference='Stop'
      . '${helper}'
      $info=New-Object Diagnostics.ProcessStartInfo
      $info.FileName='${node}'
      $info.Arguments='-e "process.stdin.once(''data'',()=>process.exit(259));process.stdout.write(''ready'')"'
      $info.UseShellExecute=$false;$info.CreateNoWindow=$true
      $info.RedirectStandardInput=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
      $child=[Diagnostics.Process]::Start($info)
      $enumerated=$null
      try {
        $ready=New-Object char[] 5
        if($child.StandardOutput.Read($ready,0,5) -ne 5){throw 'No real ready barrier'}
        $enumerated=Get-Process -Id $child.Id
        [void]$enumerated.Handle
        $ticks=$enumerated.StartTime.ToUniversalTime().Ticks.ToString()
        $live=Get-OwnedProcessState $enumerated $ticks '${node}'
        $reused=Get-OwnedProcessState $enumerated '1' '${node}'
        $wrongExeRefused=$false
        try{Get-OwnedProcessState $enumerated $ticks 'wrong.exe'}catch{if($_.Exception.Message -ne 'Owned process executable mismatch'){throw};$wrongExeRefused=$true}
        $identities=ConvertTo-Json -InputObject @(@{pid=$child.Id;ticks=$ticks}) -Compress
        $scanLive=(& '${helper}' -IdentitiesJson $identities -Executable '${node}')|ConvertFrom-Json
        $child.StandardInput.WriteLine('exit');$child.StandardInput.Flush()
        if(-not $child.WaitForExit(5000)){throw 'Owned child did not exit'}
        # The exit code is STILL_ACTIVE (259), but the exact handle is signalled.
        # HasExited must still win over the stale StartTime/handle observation.
        $exited=Get-OwnedProcessState $enumerated $ticks '${node}'
        $oldPredicate=($enumerated.StartTime.ToUniversalTime().Ticks.ToString() -eq $ticks)
        $scanDead=(& '${helper}' -IdentitiesJson $identities -Executable '${node}')|ConvertFrom-Json
        @{live=$live;reused=$reused;wrongExeRefused=$wrongExeRefused;exited=$exited;exitCode=$child.ExitCode;
          oldPredicate=$oldPredicate;scanLive=$scanLive;scanDead=$scanDead}|ConvertTo-Json -Depth 6 -Compress
      } finally {
        if(-not $child.HasExited){$child.Kill();$child.WaitForExit()}
        if($enumerated){$enumerated.Dispose()};$child.Dispose()
      }
    `;
    const { stdout } = await promisify(callback)('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true, timeout: 20000 });
    const r = JSON.parse(stdout);
    assert.equal(r.live, 'live');
    assert.equal(r.reused, 'reused');
    assert.equal(r.wrongExeRefused, true);
    assert.equal(r.oldPredicate, true, 'old PID/start-only predicate miscounts a real exited process');
    assert.equal(r.exited, 'exited');
    assert.equal(r.exitCode, 259);
    assert.equal(r.scanLive.remaining.length, 1);
    assert.equal(r.scanDead.remaining.length, 0);
    assert.equal(r.scanDead.exited.length + r.scanDead.absent.length, 1);
    assert.deepEqual(r.scanDead.stopped, []);
  });
