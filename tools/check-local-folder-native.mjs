// Real external File System Access qualification, NOT OPFS, FileList or application/Save acceptance.
// Node 24+, installed Google Chrome; Windows: PowerShell/UIAutomation, English Chrome UI.
// Linux qualification only: non-root, Xvfb (-displayfd), python3, libX11/libXtst. Never caller DISPLAY.
// Run: node tools/check-local-folder-native.mjs --evidence <directory>
// Windows additionally requires: --allow-public-documents-synthetic
// Each run writes a unique evidence subdirectory; failure is nonzero, never a native-gate skip.
// No installs/build outputs. Actual gateway/acquisition TS is stripped by Node and served as ESM.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { spawn, execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { stripTypeScriptTypes } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, lstat, readdir, unlink, rmdir, readlink, symlink, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { discoverInstalledChrome, readInstalledChromeVersion, connectCdp, closeInstalledChrome } from './chrome-cdp.mjs';

const execFile = promisify(execFileCallback);
const tools = path.dirname(fileURLToPath(import.meta.url));
const project = path.dirname(tools);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
async function absent(p) { try { await lstat(p); return false; } catch (e) { if (e.code === 'ENOENT') return true; throw e; } }
async function bounded(work, ms, label) {
  let timer;
  try { return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`${label} timed out`)), ms); })]); }
  finally { clearTimeout(timer); }
}
async function until(check, label) {
  const end = Date.now() + 10000;
  do { const value = await check(); if (value) return value; await delay(100); } while (Date.now() < end);
  throw Error(`${label} unavailable within 10s`);
}
function processHandle(executable, args, options = {}) {
  const child = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, ...options });
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  // Keep spawn failures handled even before the startup waiter is installed.
  let error; child.on('error', e => { error = e; });
  return { child, closed, get error() { return error; } };
}
// A timeout must also release the OS child/stdio handles, not just reject a promise.
// Forced shutdown is a failed qualification: preserve its profile for inspection.
async function closeNativeChrome(chrome, cdp, terminateOwned, timeout = 15000) {
  try { await bounded(closeInstalledChrome(chrome, cdp), timeout, 'Chrome closed barrier'); }
  catch (error) {
    cdp?.close();
    try { await terminateOwned('SIGTERM'); }
    finally {
      if(chrome.child.exitCode===null&&chrome.child.signalCode===null)chrome.child.kill();
      try { await bounded(chrome.closed, 5000, 'Forced Chrome closure'); }
      catch {
        try { await terminateOwned('SIGKILL');if(chrome.child.exitCode===null&&chrome.child.signalCode===null)chrome.child.kill('SIGKILL');await bounded(chrome.closed,2000,'Killed Chrome closure'); }
        finally { chrome.child.unref();chrome.child.stderr?.destroy(); }
      }
    }
    throw error;
  }
}
async function closeNativeDisplay(display, timeout = 5000) {
  if(display.child.exitCode===null&&display.child.signalCode===null)display.child.kill('SIGTERM');
  try { return await bounded(display.closed,timeout,'Xvfb close'); }
  catch(error) {
    try {
      if(display.child.exitCode===null&&display.child.signalCode===null)display.child.kill('SIGKILL');
      await bounded(display.closed,2000,'Killed Xvfb closure');
    } finally { display.child.unref();display.child.stderr?.destroy();display.child.stdio[3]?.destroy(); }
    throw error;
  }
}
// Linux PATH discovery may name a distribution launcher, not the CDP browser.
// Keep the launched PGID for cleanup, but bind dialogs to the independently
// checked browser identity. These snapshots also survive failure in result.json.
function linuxStat(text) {
  const fields = text.slice(text.lastIndexOf(')') + 1).trim().split(/\s+/);
  return { ppid: Number(fields[1]), pgid: Number(fields[2]), start: fields[19] };
}
function linuxCommandLine(text) {
  // Remove only the terminator, not meaningful empty argv entries.
  return text.split('\0').filter((v, i, all) => i < all.length - 1 || v !== '');
}
async function linuxProcess(pid) {
  assert(Number.isSafeInteger(pid) && pid > 0, 'Invalid Linux process PID');
  const base = '/proc/' + pid;
  const before = linuxStat(await readFile(base + '/stat', 'utf8'));
  const record = { pid, ...before, uid: (await lstat(base)).uid,
    exe: await readlink(base + '/exe'), args: linuxCommandLine(await readFile(base + '/cmdline', 'utf8')) };
  assert.equal(linuxStat(await readFile(base + '/stat', 'utf8')).start, before.start, 'Linux PID changed during snapshot');
  return record;
}
function linuxProfileValues(args) {
  const values = [];
  for (let i = 1; i < args.length && args[i] !== '--'; i++) {
    if (args[i] === '--user-data-dir') values.push(args[++i]);
    else if (args[i].startsWith('--user-data-dir=')) values.push(args[i].slice('--user-data-dir='.length));
    else if (args[i].startsWith('--user-data-dir')) values.push(undefined); // malformed prefix
  }
  return values;
}
function linuxBrowserPid(processInfo) {
  const browsers = processInfo.filter(p => p.type === 'browser');
  assert.equal(browsers.length, 1, 'CDP must identify exactly one browser process');
  const pid = browsers[0].id;
  assert(Number.isSafeInteger(pid) && pid > 0, 'Invalid CDP browser PID');
  return pid;
}
function linuxBrowserArguments(browser, expectedArguments) {
  assert(expectedArguments.length > 0 && expectedArguments.every(arg =>
    typeof arg === 'string' && arg.length > 0 && !/[\s\u0085\u001c-\u001f\0]/u.test(arg)),
  'Expected Chrome arguments must be nonempty and whitespace/NUL-free');
  if (browser.args.length !== 1) return browser.args;
  // Chrome can rewrite argv to one process title. Never parse that title: only
  // an exact match of our complete launch vector proves the original arguments.
  assert.equal(browser.args[0], browser.exe + ' ' + expectedArguments.join(' '), 'Chrome flattened argv mismatch');
  return [browser.exe, ...expectedArguments];
}
// /proc/environ is mutable process-title storage, not authoritative launch evidence.
// Log only DISPLAY entries, never unrelated environment values. Missing/scrubbed
// metadata defers qualification to the helper's positive X11 server/window proof.
function linuxDisplayEntries(environment) {
  return environment.split('\0').filter(entry => entry.startsWith('DISPLAY='));
}
function checkLinuxDisplay(display, entries) {
  assert(/^:\d+$/.test(display), 'Not an owned local display number');
  assert(entries.every(entry => entry === 'DISPLAY=' || entry === 'DISPLAY=' + display),
    'Observed Chrome DISPLAY contradicts owned Xvfb: ' + JSON.stringify(entries));
}
function linuxSpawnDisplay(environment, display, xvfbPid, source) {
  checkLinuxDisplay(display, ['DISPLAY=' + environment.DISPLAY]);
  assert.equal(environment.DISPLAY, display, 'Spawn DISPLAY must be exactly the owned Xvfb');
  return { source, display: environment.DISPLAY, xvfbPid };
}
function bindLinuxBrowser(launcher, browser, profile, display, environment, uid, expectedArguments) {
  assert.equal(launcher.uid, uid, 'Launcher UID mismatch');
  assert.equal(launcher.pgid, launcher.pid, 'Launcher does not own a new process group');
  assert.equal(browser.uid, uid, 'Browser UID mismatch');
  assert.equal(browser.pgid, launcher.pgid, 'CDP browser outside owned launch process group');
  assert(BigInt(browser.start) >= BigInt(launcher.start), 'Browser predates launch');
  if (browser.pid === launcher.pid) assert.equal(browser.start, launcher.start, 'Launcher PID reused');
  assert.deepEqual(linuxProfileValues(linuxBrowserArguments(browser, expectedArguments)), [profile], 'CDP browser profile mismatch');
  checkLinuxDisplay(display, linuxDisplayEntries(environment)); // still pending actual X11 proof
  return browser;
}
function ownedLinuxGroupMember(p, launcher, browser, uid) {
  if (!launcher || launcher.uid !== uid || launcher.pgid !== launcher.pid) return false;
  // A candidate that failed profile/display checks is not a dialog target, but
  // its executable can identify cleanup members IF its launch identity is proven.
  const browserExe = browser && browser.uid === uid && browser.pgid === launcher.pgid &&
    BigInt(browser.start) >= BigInt(launcher.start) &&
    (browser.pid !== launcher.pid || browser.start === launcher.start) ? browser.exe : undefined;
  return p.uid === uid && p.pgid === launcher.pgid && BigInt(p.start) >= BigInt(launcher.start) &&
    (p.exe === launcher.exe || p.exe === browserExe);
}
function safeTree(identities, links, removed) {
  return async function remove(p) {
    const s = await lstat(p);
    if (s.isSymbolicLink()) {
      assert(links.has(p), `Unexpected link retained: ${p}`);
      assert.equal(path.resolve(await readlink(p)), path.resolve(links.get(p)), 'Link target changed; retain');
      await unlink(p); removed.push({ path: p, mode: 'unlink-only', target: links.get(p) });
    } else if (s.isDirectory()) {
      if (identities.has(p)) assert(same(s, identities.get(p)), `Directory identity changed: ${p}`);
      for (const name of await readdir(p)) await remove(path.join(p, name));
      await rmdir(p);
    } else { assert(s.isFile(), `Unexpected object retained: ${p}`); await unlink(p); }
  };
}
// Compile only the actual local-source graph. No dynamic arbitrary-file HTTP route.
async function sourceModules() {
  const routes = new Map();
  async function visit(relative) {
    const route = '/' + relative.replaceAll('\\', '/');
    if (routes.has(route)) return;
    assert(relative.startsWith('src/') && !relative.split('/').includes('..'));
    const source = await readFile(path.join(project, relative + '.ts'), 'utf8');
    const javascript = stripTypeScriptTypes(source, { mode: 'strip' });
    routes.set(route, javascript);
    for (const match of javascript.matchAll(/\bfrom\s*["'](\.[^"']+)["']/g)) {
      await visit(path.posix.normalize(path.posix.join(path.posix.dirname(relative), match[1])));
    }
  }
  await visit('src/edge/local-folder-gateway');
  await visit('src/application/local-source');
  return routes;
}
const page = `<!doctype html><meta charset="utf-8"><title>Code City synthetic native qualification</title>
<script>
window.worker = new Worker('/worker.js', {type:'module'});
let next=0; const pending=new Map();
worker.onmessage=({data})=>{const p=pending.get(data.id); if(!p)return; pending.delete(data.id); data.error?p.reject(Error(JSON.stringify(data.error))):p.resolve(data.result)};
worker.onerror=e=>{for(const p of pending.values())p.reject(Error(e.message));pending.clear()};
window.rpc=(command)=>new Promise((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject});worker.postMessage({id,command,handle:root})});
window.pickerState='idle'; window.pick=()=>{pickerState='pending';window.pickerError=null;showDirectoryPicker({mode:'read'}).then(h=>{window.root=h;pickerState='selected'},e=>{window.pickerError={name:e.name,message:e.message};pickerState='rejected'})};
</script>`;
const workerSource = `import {createLocalFolderGateway} from '/src/edge/local-folder-gateway';
import {acquireLocalWorkingTree} from '/src/application/local-source';
let root, inventory; const snapshots={}; let log=[];
const attempt=async f=>{try{return {ok:true,value:await f()}}catch(e){return {ok:false,name:e.name,message:e.message}}};
// Instrumentation delegates every operation to the real native capability, preserving pruning proof.
function instrument(h,p='') {return {kind:h.kind,name:h.name,
 async *values(){log.push({op:'values',path:p}); for await(const c of h.values()){const childPath=p?p+'/'+c.name:c.name;log.push({op:'entry',path:childPath,kind:c.kind});yield instrument(c,childPath)}},
 async getFile(){log.push({op:'getFile',path:p});return h.getFile()}}}
const signal=()=>new AbortController().signal;
self.onmessage=async({data:{id,command,handle}})=>{try{let result;
 if(command==='init'){root=handle;result={worker:typeof document==='undefined',native:root instanceof FileSystemDirectoryHandle,name:root.name,permission:await root.queryPermission({mode:'read'})}}
 if(command==='capture'){log=[];const capture=await acquireLocalWorkingTree(root.name,['src/user-excluded','user-excluded'],signal(),createLocalFolderGateway(instrument(root))); result={capture,log}}
 if(command==='inventory'){inventory=await createLocalFolderGateway(root).loadInventory(['src/user-excluded','user-excluded'],signal());result={kind:inventory.kind,paths:inventory.candidates?.map(c=>c.canonicalPath)}}
 if(command==='read-inventory'){result={};for(const c of inventory.candidates)if(['mutate.cs','delete.cs','denied.cs'].includes(c.canonicalPath))result[c.canonicalPath]=await c.readRawSource(signal())}
 if(command==='links'){result={};for(const name of ['outward-junction','outward-dir-link','outward-file-link.cs','loop'])result[name]=await attempt(async()=>{const h=name.endsWith('.cs')?await root.getFileHandle(name):await root.getDirectoryHandle(name);if(h.kind==='file')return(await h.getFile()).text();return Array.fromAsync(h.keys())})}
 if(command==='snapshot'){result={};for(const name of ['mutate.cs','delete.cs','denied.cs']){const h=await root.getFileHandle(name),f=await h.getFile();snapshots[name]={h,f};result[name]={size:f.size,text:await f.text()}}}
 if(command==='read-snapshots'){result={};for(const [name,{h,f}]of Object.entries(snapshots))result[name]={oldFile:await attempt(()=>f.text()),newFile:await attempt(async()=>await(await h.getFile()).text())}}
 if(command==='directory-read')result=await attempt(async()=>Array.fromAsync((await root.getDirectoryHandle('acl-directory')).keys()));
 self.postMessage({id,result});
}catch(e){self.postMessage({id,error:{name:e.name,message:e.message}})}};`;

// Keep the two-image/budget bound, showing the latest selection attempt rather
// than a successful earlier chooser when the second selection fails.
function diagnosticImageNames(names) {
  return names.filter(name => /^linux-native-\d+-select(-before-confirm)?\.png$/.test(name))
    .sort((a,b)=>Number(b.split('-')[2])-Number(a.split('-')[2])||a.localeCompare(b)).slice(0, 2);
}

async function selfTest() {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'code-city-native-selftest-'));
  const identities = new Map([[scratch, await lstat(scratch)]]), links = new Map(), removed = [];
  const remove = safeTree(identities, links, removed);
  const outside = path.join(scratch, 'target'), inside = path.join(scratch, 'inside');
  try {
    assert.deepEqual(diagnosticImageNames(['result.json', 'linux-native-1-select.png',
      'linux-native-1-select-before-confirm.png', 'linux-native-2-inspect.png',
      'linux-native-1-select-after-location.png', '../linux-native-1-select.png',
      'linux-native-4-select-before-confirm.png','linux-native-4-select-after-location.png','linux-native-4-select.png']),
    ['linux-native-4-select-before-confirm.png', 'linux-native-4-select.png']);
    const launcher = {pid: 100, ppid: 90, pgid: 100, start: '200', uid: 42, exe: '/bin/sh', args: ['sh', '/usr/bin/google-chrome']};
    const browser = {pid: 101, ppid: 100, pgid: 100, start: '201', uid: 42, exe: '/opt/google/chrome/chrome', args: ['chrome', '--user-data-dir=/tmp/owned']};
    const bind = (p = browser, l = launcher, env = 'DISPLAY=:7\0', profile = '/tmp/owned') => bindLinuxBrowser(l, p, profile, ':7', env, 42, ['--user-data-dir=/tmp/owned']);
    assert.deepEqual(linuxStat('100 (a name with ) parentheses) ' + ['S', '90', '100', ...Array(16).fill('0'), '200'].join(' ')), {ppid:90, pgid:100, start:'200'});
    assert.equal(linuxBrowserPid([{type:'renderer', id:102}, {type:'browser', id:101}]), 101);
    for (const info of [[], [{type:'browser',id:0}], [{type:'browser',id:'101'}], [{type:'browser',id:101},{type:'browser',id:102}]]) assert.throws(() => linuxBrowserPid(info));
    assert.equal(bind(), browser);
    for (const env of ['', 'OTHER=not-recorded\0', 'DISPLAY=\0', 'DISPLAY=:7\0DISPLAY=\0']) assert.equal(bind(browser, launcher, env), browser);
    for (const env of ['DISPLAY=:70\0', 'DISPLAY=:7-extra\0', 'DISPLAY=:7\0DISPLAY=:8\0', 'DISPLAY=localhost:7\0']) assert.throws(() => bind(browser, launcher, env), /DISPLAY contradicts/);
    assert.deepEqual(linuxDisplayEntries('SECRET=not-recorded\0DISPLAY=:70\0DISPLAY=\0'), ['DISPLAY=:70', 'DISPLAY=']);
    assert.deepEqual(linuxDisplayEntries('NOT_DISPLAY=:7\0'), []);
    assert.deepEqual(linuxSpawnDisplay({DISPLAY:':7'}, ':7', 90, 'test'), {source:'test', display:':7', xvfbPid:90});
    for (const DISPLAY of [undefined, '', ':70', ':7-extra']) assert.throws(() => linuxSpawnDisplay({DISPLAY}, ':7', 90, 'test'));
    const direct = {...browser, pid:100, start:'200'};
    assert.equal(bind(direct), direct);
    assert.equal(bind({...browser,args:['chrome','--user-data-dir','/tmp/owned']}).pid,101);
    for (const changed of [{uid:43}, {pgid:90}, {start:'199'}, {pid:100,start:'201'}]) assert.throws(() => bind({...browser,...changed}));
    assert.throws(() => bind(browser,{...launcher,pgid:90}));
    assert.throws(() => bind(browser,{...launcher,uid:43}));
    assert.throws(() => bind(browser,launcher,'DISPLAY=:70\0'));
    for (const args of [[], ['--user-data-dir=/tmp/owned-extra'], ['--user-data-directory=/tmp/owned'], ['--other=--user-data-dir=/tmp/owned'], ['--user-data-dir'], ['--user-data-dir='], ['--','--user-data-dir=/tmp/owned'], ['--user-data-dir=/tmp/owned','--user-data-dir=/tmp/owned'], ['--user-data-dir=/wrong','--user-data-dir','/tmp/owned']]) assert.throws(() => bind({...browser,args:['chrome',...args]}));
    // Reproduce CI 41263489673's complete rewritten argv[0], not a profile-only title.
    const profile = '/tmp/code-city-native-o8tUex/profile';
    const expectedArguments = ['--remote-debugging-port=0', '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-default-apps', '--disable-sync', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-features=CalculateNativeWinOcclusion', '--lang=en-US', '--ozone-platform=x11', '--disable-gpu', '--window-size=900,650', 'about:blank'];
    const title = browser.exe + ' ' + expectedArguments.join(' ');
    const flat = {...direct, args: linuxCommandLine(title + '\0')};
    const bindFlat = (p = flat, expected = expectedArguments, env = 'DISPLAY=:7\0', l = launcher) => bindLinuxBrowser(l, p, profile, ':7', env, 42, expected);
    assert.equal(bindFlat(), flat);
    assert.equal(bindFlat({...flat, pid:101, start:'201'}).pid, 101);
    assert.deepEqual(linuxBrowserArguments(flat, expectedArguments), [browser.exe, ...expectedArguments]);
    assert.deepEqual(flat.args, [title], 'Raw failure evidence must not be rewritten');
    assert.deepEqual(linuxCommandLine(''), []);
    assert.deepEqual(linuxCommandLine('\0'), ['']);
    assert.deepEqual(linuxCommandLine('chrome\0\0'), ['chrome', '']);
    assert.deepEqual(linuxCommandLine('\0chrome\0\0arg\0'), ['', 'chrome', '', 'arg']);
    assert.deepEqual(linuxCommandLine('chrome\0arg'), ['chrome', 'arg']);
    for (const changedTitle of [title.replace('--no-first-run', '--no-first-rum'), title.replace(profile, profile + '-wrong'), title.replace('--user-data-dir=' + profile + ' ', ''), title.replace('--user-data-dir=' + profile, '--user-data-dir=' + profile + ' --user-data-dir=' + profile), title + ' --extra', title + ' ', title.replace(' --no-first-run', '\t--no-first-run'), title.replace(' --no-first-run', '\0--no-first-run'), title.replace(browser.exe, browser.exe + '-spoof'), title.replace(browser.exe, '/wrong/chrome'), title.replace(' --no-first-run', '  --no-first-run')]) {
      assert.throws(() => bindFlat({...flat, args:linuxCommandLine(changedTitle + '\0')}));
    }
    assert.throws(() => bindFlat({...flat, args:[title, '']}), 'Meaningful empty argv must not become a flattened title');
    assert.throws(() => bindFlat({...flat, exe:browser.exe + '-changed'}));
    for (const arg of ['', 'a b', 'a\tb', 'a\nb', 'a\rb', 'a\u00a0b', 'a\u0085b', 'a\ufeffb', 'a\u001cb', 'a\u001fb', 'a\0b']) {
      const expected = [...expectedArguments, arg];
      assert.throws(() => bindFlat({...flat, args:[browser.exe + ' ' + expected.join(' ')]}, expected));
    }
    for (const expected of [expectedArguments.filter(arg => !arg.startsWith('--user-data-dir=')), [...expectedArguments, '--user-data-dir=' + profile], expectedArguments.map(arg => arg === '--user-data-dir=' + profile ? '--user-data-dir=/wrong' : arg)]) {
      assert.throws(() => bindFlat({...flat, args:[browser.exe + ' ' + expected.join(' ')]}, expected), 'Exact title must still pass the strict profile parser');
    }
    for (const changed of [{uid:43}, {pgid:90}, {start:'199'}, {start:'201'}]) assert.throws(() => bindFlat({...flat,...changed}));
    assert.throws(() => bindFlat(flat, expectedArguments, 'DISPLAY=:70\0'));
    assert.throws(() => bindFlat(flat, expectedArguments, 'DISPLAY=:7\0', {...launcher,uid:43}));
    assert.throws(() => bindFlat(flat, expectedArguments, 'DISPLAY=:7\0', {...launcher,pgid:90}));
    assert(ownedLinuxGroupMember(browser,launcher,browser,42));
    assert(ownedLinuxGroupMember(launcher,launcher,browser,42));
    for (const changed of [{uid:43},{pgid:90},{start:'199'},{exe:'/unrelated'}]) assert(!ownedLinuxGroupMember({...browser,...changed},launcher,browser,42));
    assert(ownedLinuxGroupMember(browser,launcher,{...browser,args:['chrome','--user-data-dir=/wrong']},42), 'Rejected profile must not strand the owned group');
    for (const changed of [{uid:43},{pgid:90},{start:'199'},{pid:100,start:'201'}]) assert(!ownedLinuxGroupMember(browser,launcher,{...browser,...changed},42));
    await mkdir(outside); await mkdir(inside); await writeFile(path.join(outside, 'keep'), 'synthetic');
    const link = path.join(inside, 'link'); await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(remove(inside), /Unexpected link retained/);
    assert.equal(await readFile(path.join(outside, 'keep'), 'utf8'), 'synthetic');
    links.set(link, inside); await assert.rejects(remove(inside), /Link target changed/);
    links.set(link, outside); await remove(inside);
    assert.equal(await readFile(path.join(outside, 'keep'), 'utf8'), 'synthetic');
    assert.equal(removed[0].mode, 'unlink-only');
    const modules = await sourceModules();
    assert(modules.get('/src/edge/local-folder-gateway').includes('createLocalFolderGateway'));
    assert(modules.get('/src/application/local-source').includes('acquireLocalWorkingTree'));
    const child=processHandle(process.execPath,['-e','setInterval(()=>{},1000)']);
    await new Promise((resolve,reject)=>{child.child.once('spawn',resolve);child.child.once('error',reject);});
    await assert.rejects(closeNativeChrome(child,{send:()=>new Promise(()=>{}),close(){}},async()=>{child.child.kill();},40),/Chrome closed barrier timed out/);
    assert(child.child.exitCode!==null||child.child.signalCode!==null,'Timeout left the owned child alive');
    const display=processHandle(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','ignore','pipe','pipe']});
    await new Promise((resolve,reject)=>{display.child.once('spawn',resolve);display.child.once('error',reject);});
    const kill=display.child.kill.bind(display.child);display.child.kill=signal=>signal==='SIGTERM'?true:kill(signal);
    await assert.rejects(closeNativeDisplay(display,40),/Xvfb close timed out/);
    assert(display.child.exitCode!==null||display.child.signalCode!==null,'Display timeout left the owned child alive');
    assert(display.child.stderr.destroyed&&display.child.stdio[3].destroyed,'Display pipes remain referenced');
    console.log(JSON.stringify({ status: 'passed', checks: ['bounded failure-image ordering retains after-location and before-confirm', 'unexpected link refusal', 'changed link target refusal', 'verified link unlink preserves target', 'actual TS graph compilation', 'stalled close terminates child and awaits streams', 'stalled display terminates child and closes both pipes', 'CDP browser PID cardinality and type', 'direct and wrapper browser binding', 'UID/start/group/profile and contradictory DISPLAY refusals; scrubbed DISPLAY defers to X11 proof', 'exact spawn DISPLAY source and DISPLAY-only evidence', 'exact full flattened argv and spoof refusals; raw evidence and empty argv preserved', 'owned launch group cleanup identities'], modules: [...modules.keys()] }));
  } finally { await remove(scratch); }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--self-test') return selfTest();
  if (args.length === 1 && args[0] === '--help') {
    console.log('node tools/check-local-folder-native.mjs --evidence <directory> [--allow-public-documents-synthetic]\nWindows: installed English Chrome, PowerShell/UIAutomation. Linux: installed Chrome, non-root, Xvfb, python3, libX11/libXtst (qualification only); own display only. --self-test runs non-browser cleanup/compiler regressions.'); return;
  }
  let evidenceRoot, authorized = false;
  for (let i=0;i<args.length;i++) {
    if (args[i] === '--evidence' && args[i+1]) evidenceRoot = path.resolve(args[++i]);
    else if (args[i] === '--allow-public-documents-synthetic') authorized = true;
    else throw Error('Unknown/incomplete argument: ' + args[i]);
  }
  assert(evidenceRoot, '--evidence <directory> is required');
  assert(['win32','linux'].includes(process.platform), 'Only Windows and Linux native paths are supported');
  assert(process.platform !== 'win32' || authorized, 'Explicit --allow-public-documents-synthetic authorization required');
  await mkdir(evidenceRoot, {recursive:true});
  const evidence = await mkdtemp(path.join(evidenceRoot, 'run-'));
  const result = { status:'failed', started:new Date().toISOString(), platform:process.platform, os:os.release(), evidence, actions:[], links:{}, cleanup:[], limitations:[] };
  const identities = new Map(), links = new Map(), denied = new Set();
  const remove = safeTree(identities, links, result.cleanup);
  let scratch, fixture, empty, profile, server, chrome, cdp, sessionId, discovery, ticks, xvfb, sid, linuxEnvironment, linuxLauncher, linuxBrowser, linuxCandidate;
  const ps = args => execFile('powershell.exe', ['-NoProfile', ...args], {windowsHide:true,timeout:20000,maxBuffer:4*2**20});
  const save = () => writeFile(path.join(evidence, 'result.json'), JSON.stringify(result,null,2)+'\n');
  async function ownDirectory(p) { await mkdir(p); identities.set(p, await lstat(p)); }
  async function assertOwned(p) { const s=await lstat(p); assert(s.isDirectory()&&!s.isSymbolicLink()&&identities.has(p)&&same(s,identities.get(p)), 'Owned root changed: '+p); }
  async function dialog(mode, target=fixture) {
    if(mode==='select') await assertOwned(target);
    const x=await ps(['-File',path.join(tools,'local-folder-native-windows.ps1'),'-OwnedPid',String(chrome.child.pid),'-Executable',discovery.executable,'-Profile',profile,'-Mode',mode,'-Fixture',target,'-ExpectedOrigin',result.origin,'-OwnershipFile',path.join(scratch,'ownership.json'),...(ticks?['-CreationTicks',ticks]:[])]);
    const data=JSON.parse(x.stdout.trim()); ticks??=data.creationTicks; result.actions.push(data); await save(); return data;
  }
  let linuxDialogCount=0;
  async function linuxDialog(mode, target=fixture) {
    result.linuxDisplayProof={status:'awaiting-x11-proof', displayQualified:false, mode};
    result.linuxHelperSpawn=linuxSpawnDisplay(linuxEnvironment,result.display,xvfb.child.pid,'python3 spawn env');
    await save();
    try {
      const x=await execFile('python3',[path.join(tools,'local-folder-native-linux.py'),'--display',result.display,'--xvfb-pid',String(xvfb.child.pid),'--chrome-pid',String(linuxBrowser.pid),'--profile',profile,'--ownership',path.join(scratch,'ownership.json'),'--mode',mode,'--fixture',target,'--diagnostic-png',path.join(evidence,`linux-native-${++linuxDialogCount}-${mode}.png`)],{env:linuxEnvironment,timeout:15000});
      const data=JSON.parse(x.stdout);
      assert.equal(data.displayProof?.status,'x11-owned-window-proved');
      assert.equal(data.displayProof.displayQualified,true);
      result.linuxDisplayProof=data.displayProof;result.actions.push(data);await save();return data;
    } catch(error) {
      if(error.stdout)try{result.linuxHelperFailure=JSON.parse(error.stdout);}catch{} // only helper's bounded JSON, not environ
      result.linuxDisplayProof={...result.linuxDisplayProof,status:'failed',displayQualified:false};
      await save();throw error;
    }
  }
  async function evaluate(expression, awaitPromise=false, userGesture=false) {
    const r=await bounded(cdp.send('Runtime.evaluate',{expression,awaitPromise,userGesture,returnByValue:true},sessionId),15000,'Browser evaluation');
    if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;
  }
  const worker = command => evaluate('rpc('+JSON.stringify(command)+')',true);
  async function pick(target) {
    await assertOwned(target);
    await cdp.send('Page.bringToFront',{},sessionId);
    await until(()=>evaluate('document.hasFocus()'),'Owned native picker page focus');
    await evaluate('pick();void 0',false,true);
    if(process.platform==='win32') {
      await until(async()=>{const d=await dialog('inspect');return d.dialogs.length;},'Owned native chooser');
      await dialog('select',target); await delay(800);
      if((await evaluate('pickerState'))==='pending') {
        const d=await dialog('inspect');if(d.dialogs.length){await dialog('confirm',target);await delay(800);}
      }
      if((await evaluate('pickerState'))==='pending') {
        await until(async()=>{const d=await dialog('inspect-browser');return d.browserUi.some(e=>e.type==='ControlType.Button'&&e.name==='Allow');},'Owned read permission prompt');
        await dialog('allow-read',target);
      }
    } else {
      await linuxDialog('select',target); await delay(800);
      if((await evaluate('pickerState'))==='pending') {
        const ui=await linuxDialog('inspect',target); // no input; pending alone is not prompt evidence
        assert.equal(ui.chooserClosed,true,'Owned native chooser still open after selection; no browser Allow input sent');
        result.linuxPickerPhase='chooser-closed-picker-pending-not-yet-qualified';await save();
        await linuxDialog('allow-read',target);
      }
    }
    try {
      await until(async()=>(await evaluate('pickerState'))!=='pending','Native picker resolution');
    } catch(error) {
      if(process.platform==='linux') {
        result.linuxPickerPhase='picker-resolution-failed';
        try {await linuxDialog('inspect',target);}catch(diagnosticError){result.linuxInspectionError=diagnosticError.message;}
        await save();
      }
      throw error;
    }
    const state=await evaluate('({state:pickerState,error:window.pickerError,root:window.root?{name:root.name,native:root instanceof FileSystemDirectoryHandle}:null})');
    assert.equal(state.state,'selected',JSON.stringify(state));assert.equal(state.root.native,true);assert.equal(state.root.name,path.basename(target));return state;
  }
  async function restore(p) {
    await assertOwned(fixture);assert(!(await lstat(p)).isSymbolicLink(),'ACL target changed');
    if(process.platform==='win32')await execFile('icacls.exe',[p,'/remove:d','*'+sid],{windowsHide:true,timeout:10000});
    else await chmod(p, p===path.join(fixture,'denied.cs')?0o600:0o700);
    denied.delete(p);
  }
  try {
    if(process.platform==='linux') {
      assert(process.getuid()!==0,'Native chmod qualification requires a non-root Linux user; no --no-sandbox fallback');
      await execFile('python3',['--version'],{timeout:5000});
      await execFile('Xvfb',['-help'],{timeout:5000});
    }
    discovery=await discoverInstalledChrome();result.chrome={...discovery,version:await readInstalledChromeVersion(discovery,{execFileImpl:(command,args,options)=>execFile(command,args,{...options,timeout:10000})})};
    const modules=await sourceModules();
    result.servedModuleSha256=Object.fromEntries([...modules].map(([name,text])=>[name,createHash('sha256').update(text).digest('hex')]));
    result.toolSha256={};for(const name of ['check-local-folder-native.mjs','local-folder-native-windows.ps1','local-folder-native-linux.py'])result.toolSha256[name]=createHash('sha256').update(await readFile(path.join(tools,name))).digest('hex');
    scratch=await mkdtemp(path.join(os.tmpdir(),'code-city-native-'));identities.set(scratch,await lstat(scratch));
    profile=path.join(scratch,'profile');await ownDirectory(profile);
    if(process.platform==='linux') {
      // Isolate GTK history/config/auth as well as the display. An ambient desktop
      // portal must never launch a chooser on the caller's D-Bus/Wayland session.
      const home=path.join(scratch,'home'),runtime=path.join(scratch,'runtime'),authority=path.join(scratch,'xauthority');
      await ownDirectory(home);await ownDirectory(runtime);await chmod(runtime,0o700);await writeFile(authority,'',{mode:0o600});
      linuxEnvironment={...process.env,HOME:home,XDG_CONFIG_HOME:path.join(home,'config'),XDG_DATA_HOME:path.join(home,'data'),XDG_CACHE_HOME:path.join(home,'cache'),XDG_RUNTIME_DIR:runtime,XAUTHORITY:authority,DBUS_SESSION_BUS_ADDRESS:'unix:path='+path.join(scratch,'no-session-bus'),WAYLAND_DISPLAY:'',GTK_USE_PORTAL:'0'};
    }
    const token=randomUUID();
    fixture=process.platform==='win32'?path.win32.join('C:/Users/Public/Documents','CodeCitySynthetic-'+token):path.join(scratch,'CodeCitySynthetic-'+token);
    // Distinct names avoid GTK completing the main path to a prefix-matching sibling.
    empty=process.platform==='linux'?path.join(scratch,'CodeCitySynthetic-'+randomUUID()+'-empty'):fixture+'-empty';await ownDirectory(fixture);await ownDirectory(empty);
    Object.assign(result,{workspace:scratch,fixture,empty,profile});await save();
    await writeFile(path.join(scratch,'ownership.json'),JSON.stringify({fixture,empty,profile,identities:Object.fromEntries([...identities].map(([p,s])=>[p,{dev:s.dev,ino:s.ino}]))}));
    for(const dir of ['.git','node_modules','dist','build','bin','obj','user-excluded','src','src/.GIT','src/user-excluded','acl-directory']) {
      await mkdir(path.join(fixture,dir));await writeFile(path.join(fixture,dir,'sentinel.cs'),'// synthetic excluded or ordinary '+dir+'\nclass Synthetic {}\n');
    }
    for(const name of ['edited.cs','mutate.cs','delete.cs','denied.cs'])await writeFile(path.join(fixture,name),'// synthetic original\r\nclass Synthetic {}\r\n');
    await writeFile(path.join(fixture,'edited.cs'),'// synthetic edited before native capture\r\nclass Edited {}\r\n');
    for(const name of ['space name.cs','épreuve.cs','😀.cs'])await writeFile(path.join(fixture,'src',name),'// synthetic path '+name+'\nclass Synthetic {}\n');
    await writeFile(path.join(empty,'outside.cs'),'// SYNTHETIC_OUTSIDE_MUST_NOT_READ\n');
    for(const [name,target,type]of [
      ...(process.platform==='win32'?[['outward-junction',empty,'junction']]:[]),
      ['outward-dir-link',empty,'dir'],['outward-file-link.cs',path.join(empty,'outside.cs'),'file'],['loop',fixture,process.platform==='win32'?'junction':'dir']]) {
      const p=path.join(fixture,name);
      try {await symlink(target,p,type);links.set(p,target);assert((await lstat(p)).isSymbolicLink());result.links[name]={created:true,target};}
      catch(e) { if(process.platform!=='win32'||!['EPERM','EACCES'].includes(e.code))throw e; result.links[name]={created:false,code:e.code};result.limitations.push(name+': Windows symbolic link privilege unavailable; not qualified'); }
    }
    // Select the allowed external target separately, so containment cannot pass just because the target is protected Temp.
    await save();
    if(process.platform==='linux') {
      xvfb=processHandle('Xvfb',['-displayfd','3','-screen','0','1280x900x24','-nolisten','tcp','-ac'],{stdio:['ignore','ignore','pipe','pipe']});
      const display=await bounded(new Promise((resolve,reject)=>{let text='';xvfb.child.once('error',reject);xvfb.child.once('exit',()=>reject(Error('Xvfb exited during startup')));xvfb.child.stdio[3].on('data',chunk=>{text+=String(chunk);if(/^\d+\n$/.test(text))resolve(':'+text.trim());});}),10000,'Isolated Xvfb');
      assert(/^:\d+$/.test(display));result.display=display;result.xvfbPid=xvfb.child.pid;linuxEnvironment.DISPLAY=display;
    }
    server=http.createServer((req,res)=>{
      const text=req.url==='/'?page:req.url==='/worker.js'?workerSource:modules.get(req.url);
      res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type',req.url==='/'?'text/html':'text/javascript');res.statusCode=text===undefined?404:200;res.end(text??'Not found');
    });
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
    assert.notEqual(server.address().port,55583);result.origin='http://127.0.0.1:'+server.address().port;
    const arguments_=['--remote-debugging-port=0','--user-data-dir='+profile,'--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update','--disable-default-apps','--disable-sync','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows','--disable-features=CalculateNativeWinOcclusion','--lang=en-US',...(process.platform==='win32'?['--window-position=-22000,-22000']:['--ozone-platform=x11','--disable-gpu']),'--window-size=900,650','about:blank'];
    // Snapshot the actual spawn option at source, before Chrome can rewrite proc metadata.
    if(process.platform==='linux') {
      result.linuxChromeSpawn=linuxSpawnDisplay(linuxEnvironment,result.display,xvfb.child.pid,'Chrome spawn env');
      result.linuxDisplayProof={status:'launch-env-recorded',displayQualified:false};await save();
    }
    // Explicit headed launch here only; chrome-cdp's default headless arguments and closed barrier remain unchanged.
    chrome=processHandle(discovery.executable,arguments_,{detached:process.platform==='linux',env:process.platform==='linux'?linuxEnvironment:process.env});
    result.chrome.pid=chrome.child.pid;result.chrome.arguments=arguments_;
    if(process.platform==='linux') {
      linuxLauncher=await linuxProcess(chrome.child.pid);result.chrome.launchedProcess=linuxLauncher;
      await save();
    }
    if(process.platform==='win32')await dialog('inspect');
    const endpoint=await bounded(new Promise((resolve,reject)=>{let text='';chrome.child.once('error',reject);chrome.child.once('exit',()=>reject(Error('Chrome exited before CDP')));chrome.child.stderr.on('data',chunk=>{text=(text+String(chunk)).slice(-16384);result.chromeStderr=text;const match=/DevTools listening on (ws:\/\/[^\s]+)/.exec(text);if(match)resolve(match[1]);});}),20000,'Headed Chrome startup');
    assert(/^ws:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\/devtools\/browser\//.test(endpoint));
    const connection=connectCdp(endpoint);cdp={...connection,send:(...args)=>bounded(connection.send(...args),15000,'CDP '+args[0])};
    result.protocol=await cdp.send('Browser.getVersion');
    if(process.platform==='linux') {
      const info=await cdp.send('SystemInfo.getProcessInfo');
      result.chrome.processInfo=info.processInfo;await save();
      linuxCandidate=await linuxProcess(linuxBrowserPid(info.processInfo));
      result.chrome.actualProcess=linuxCandidate;await save(); // preserve args even when a guard rejects them
      const environment=await readFile('/proc/'+linuxCandidate.pid+'/environ','utf8');
      result.chrome.observedDisplayEntries=linuxDisplayEntries(environment);await save();
      linuxBrowser=bindLinuxBrowser(linuxLauncher,linuxCandidate,profile,result.display,environment,process.getuid(),arguments_);
      const ownership=JSON.parse(await readFile(path.join(scratch,'ownership.json'),'utf8'));
      ownership.linux={display:result.display,xvfbPid:xvfb.child.pid,xvfbStart:(await linuxProcess(xvfb.child.pid)).start,
        launcher:linuxLauncher,chromePid:linuxBrowser.pid,chromeStart:linuxBrowser.start,chromeExe:linuxBrowser.exe,
        chromeUid:linuxBrowser.uid,chromePgid:linuxBrowser.pgid,expectedArguments:arguments_,chromeSpawn:result.linuxChromeSpawn};result.linuxOwnership=ownership.linux;
      result.linuxDisplayProof={status:'process-bound-awaiting-x11-proof',displayQualified:false};
      await writeFile(path.join(scratch,'ownership.json'),JSON.stringify(ownership));await save();
    }
    const target=(await cdp.send('Target.getTargets')).targetInfos.find(t=>t.type==='page');
    ({sessionId}=await cdp.send('Target.attachToTarget',{targetId:target.targetId,flatten:true}));await cdp.send('Page.enable',{},sessionId);
    await cdp.send('Page.navigate',{url:result.origin},sessionId);
    await until(()=>evaluate('typeof pick === "function"'),'Probe page');
    result.environment=await evaluate('({secure:isSecureContext,picker:typeof showDirectoryPicker,ua:navigator.userAgent})');assert.equal(result.environment.secure,true);assert.equal(result.environment.picker,'function');
    if(process.platform==='win32')await dialog('prepare');
    result.externalTargetPicker=await pick(empty);await unlink(path.join(empty,'outside.cs'));
    result.emptyCapture=await worker('init');result.emptyCapture=await worker('capture');
    assert.equal(result.emptyCapture.capture.category,'No supported modules');
    await writeFile(path.join(empty,'outside.cs'),'// SYNTHETIC_OUTSIDE_MUST_NOT_READ\n');
    result.picker=await pick(fixture);result.worker=await worker('init');assert.equal(result.worker.worker,true);assert.equal(result.worker.native,true);assert.equal(result.worker.permission,'granted');
    result.capture=await worker('capture');assert.equal(result.capture.capture.kind,'success',JSON.stringify(result.capture));
    const files=result.capture.capture.acquired.modules;
    assert.equal(files.find(f=>f.canonicalPath==='edited.cs')?.normalizedSource,'// synthetic edited before native capture\nclass Edited {}\n');
    for(const n of ['space name.cs','épreuve.cs','😀.cs'])assert(files.some(f=>f.canonicalPath==='src/'+n));
    assert(!files.some(f=>f.canonicalPath.includes('outward')||f.canonicalPath.includes('loop')||JSON.stringify(f).includes('SYNTHETIC_OUTSIDE')),'Link escaped native boundary');
    for(const e of result.capture.log)if(e.op!=='entry')assert(!e.path.split('/').some(n=>['.git','node_modules','dist','build','bin','obj','user-excluded'].includes(n.toLowerCase())),'Excluded native operation '+JSON.stringify(e));
    for(const excluded of ['.git','node_modules','dist','build','bin','obj','user-excluded','src/.GIT','src/user-excluded'])assert(result.capture.log.some(e=>e.op==='entry'&&e.path===excluded),'Expected native excluded entry '+excluded);
    result.directLinks=await worker('links');
    for(const [name,info]of Object.entries(result.links))if(info.created)assert.equal(result.directLinks[name].ok,false,'Native link lookup escaped: '+name);
    result.inventory=await worker('inventory');assert.equal(result.inventory.kind,'inventory');result.before=await worker('snapshot');
    await assertOwned(fixture);
    await writeFile(path.join(fixture,'mutate.cs'),'// synthetic changed after getFile\nclass Changed { int Value => 12345; }\n');await unlink(path.join(fixture,'delete.cs'));
    if(process.platform==='win32')sid=(await ps(['-Command','[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value'])).stdout.trim();
    for(const name of ['denied.cs','acl-directory']) {
      const p=path.join(fixture,name);assert(!(await lstat(p)).isSymbolicLink());denied.add(p);
      if(process.platform==='win32')await execFile('icacls.exe',[p,'/deny','*'+sid+':(RD)'],{windowsHide:true,timeout:10000});else await chmod(p,0);
    }
    result.after=await worker('read-snapshots');result.gatewayReads=await worker('read-inventory');result.directoryDenied=await worker('directory-read');result.captureDenied=await worker('capture');
    assert.equal(result.after['mutate.cs'].oldFile.ok,false);assert.equal(result.after['mutate.cs'].newFile.ok,true);assert(result.after['mutate.cs'].newFile.value.includes('changed after getFile'));
    assert.equal(result.after['delete.cs'].oldFile.ok,false);assert.equal(result.after['delete.cs'].newFile.name,'NotFoundError');assert.equal(result.after['denied.cs'].newFile.ok,false);
    assert.equal(result.gatewayReads['mutate.cs'].kind,'source');assert.equal(result.gatewayReads['delete.cs'].kind,'unavailable');assert.equal(result.gatewayReads['denied.cs'].kind,'unavailable');
    assert.equal(result.directoryDenied.ok,false);assert.equal(result.captureDenied.capture.category,'Local working tree unavailable');
    for(const p of [...denied])await restore(p);result.directoryRestored=await worker('directory-read');assert.equal(result.directoryRestored.ok,true);
    await evaluate('pick();void 0',false,true);
    if(process.platform==='win32'){await until(async()=>(await dialog('inspect')).dialogs.length,'Cancel chooser');await dialog('cancel');}else await linuxDialog('cancel');
    await until(async()=>(await evaluate('pickerState'))!=='pending','Chooser cancellation');result.cancel=await evaluate('({error:pickerError,retained:root.name})');assert.equal(result.cancel.error.name,'AbortError');assert.equal(result.cancel.retained,path.basename(fixture));
    result.status='qualified';
  } catch(e) {result.error={message:e.message,stack:e.stack};}
  finally {
    for(const p of [...denied])try{await restore(p);}catch(e){result.cleanup.push({path:p,status:'retained',error:e.message});}
    try {
      if(chrome){
        if(process.platform==='win32'&&chrome.child.exitCode===null&&cdp){try{const d=await dialog('inspect');if(d.dialogs.length)await dialog('cancel');}catch(e){result.shutdownInspectionError=e.message;}}
        await closeNativeChrome(chrome,cdp,async(signal)=>{
          if(process.platform==='win32') {
            // Only previously recorded PID/start-time/executable identities, never taskkill /T or global Chrome.
            const known=new Map();for(const a of result.actions)for(const p of a.ownedProcesses??[])known.set(p.pid+':'+p.creationTicks,p);
            const executable=discovery.executable.replaceAll("'","''");
            const items=[...known.values()].sort((a,b)=>(a.role==='browser')-(b.role==='browser')).map(p=>'@{pid='+p.pid+';ticks="'+p.creationTicks+'"}').join(',');
            const script="$stopped=@();foreach($i in @("+items+")){$p=Get-Process -Id $i.pid -ErrorAction SilentlyContinue;if($p -and $p.Path -eq '"+executable+"' -and $p.StartTime.ToUniversalTime().Ticks.ToString() -eq $i.ticks){Stop-Process -Id $p.Id -ErrorAction Stop;$stopped+=$i}};ConvertTo-Json -InputObject @($stopped) -Compress";
            result.forcedProcesses=JSON.parse((await ps(['-Command',script])).stdout);
          } else {
            // Chrome alone owns this new process group; never signal a caller's group/display.
            const members=[];
            for(const name of await readdir('/proc'))if(/^\d+$/.test(name)){try{if(ownedLinuxGroupMember(await linuxProcess(Number(name)),linuxLauncher,linuxCandidate,process.getuid()))members.push(Number(name));}catch(e){if(!['ENOENT','ESRCH','EACCES'].includes(e.code))throw e;}}
            result.forcedProcessGroup={id:linuxLauncher?.pgid,verifiedMembers:members};
            const liveLauncher=linuxLauncher?.pid===chrome.child.pid&&linuxLauncher.pgid===chrome.child.pid&&linuxLauncher.uid===process.getuid()&&chrome.child.exitCode===null&&chrome.child.signalCode===null;
            if(members.length||liveLauncher)try{process.kill(-linuxLauncher.pgid,signal);}catch(e){if(e.code!=='ESRCH')throw e;}
          }
        });result.browserClosed=await chrome.closed;
      }
    }catch(e){result.shutdownError=e.message;cdp?.close();}
    if(server?.listening){const port=server.address().port;await new Promise(resolve=>server.close(resolve));result.serverClosed=await new Promise(resolve=>{const s=net.connect({host:'127.0.0.1',port});s.on('connect',()=>{s.destroy();resolve(false)});s.on('error',e=>resolve(e.code==='ECONNREFUSED'));});}
    if(xvfb){try{result.xvfbClosed=await closeNativeDisplay(xvfb);if(result.display){const number=result.display.slice(1);result.xvfbDisplayRemoved=await absent('/tmp/.X11-unix/X'+number)&&await absent('/tmp/.X'+number+'-lock');assert(result.xvfbDisplayRemoved,'Owned Xvfb display socket/lock remains; inspect, do not force-delete');}}catch(e){result.shutdownError=e.message;}}
    // Windows helper records PID+creation-time identities; verify no recorded Chrome child is still live.
    try {
      if(process.platform==='win32'&&chrome){
        const identities=new Map();for(const a of result.actions)for(const p of a.ownedProcesses??[])identities.set(p.pid+':'+p.creationTicks,p);
        assert(identities.size,'No owned process identities recorded; retain profile');
        const items=[...identities.values()].map(p=>'@{pid='+p.pid+';ticks="'+p.creationTicks+'"}').join(',');
        const script='$live=@();foreach($i in @('+items+')){$p=Get-Process -Id $i.pid -ErrorAction SilentlyContinue;if($p -and $p.StartTime.ToUniversalTime().Ticks.ToString() -eq $i.ticks){$live+=$i}};ConvertTo-Json -InputObject @($live) -Compress';
        result.remainingProcesses=JSON.parse((await ps(['-Command',script])).stdout);assert.equal(result.remainingProcesses.length,0,'Owned Chrome processes remain');
      }
      if(process.platform==='linux'&&profile){
        const remaining=[];
        for(const name of await readdir('/proc'))if(/^\d+$/.test(name)){try{const p=await linuxProcess(Number(name));if(linuxProfileValues(p.args).includes(profile)||ownedLinuxGroupMember(p,linuxLauncher,linuxCandidate,process.getuid()))remaining.push(p.pid);}catch(e){if(!['ENOENT','ESRCH','EACCES'].includes(e.code))throw e;}}
        result.remainingProcesses=remaining;assert.equal(remaining.length,0,'Owned Chrome processes remain');
      }
    }catch(e){result.shutdownError=e.message;}
    if(!result.shutdownError&&!denied.size){
      for(const p of [fixture,empty,scratch].filter(Boolean))try{if(identities.has(p)&&!(await absent(p))){await assertOwned(p);await remove(p);}result.cleanup.push({path:p,status:await absent(p)?'removed':'retained'});}catch(e){result.cleanup.push({path:p,status:'retained',error:e.message});}
    }
    for(const [name,p]of Object.entries({workspace:scratch,fixture,empty}))if(p)result[name+'Status']=await absent(p)?'removed':'retained';
    if(result.shutdownError||denied.size||result.cleanup.some(x=>x.status==='retained')||result.workspaceStatus==='retained'||result.fixtureStatus==='retained'||result.emptyStatus==='retained'||result.serverClosed===false)result.status='failed';
    // Failure-only, bounded images of the independently proved synthetic Xvfb.
    // No CI artifact publication, user DISPLAY, repository source or environment dump.
    const diagnosticImages=[];
    if(process.platform==='linux'&&result.status==='failed') {
      let budget=256*1024;
      for(const name of diagnosticImageNames(await readdir(evidence))) {
        const p=path.join(evidence,name),s=await lstat(p);
        if(s.isFile()&&!s.isSymbolicLink()&&s.size<=budget){const bytes=await readFile(p);budget-=bytes.length;diagnosticImages.push({name,base64:bytes.toString('base64')});}
      }
    }
    result.finished=new Date().toISOString();await save();console.log(JSON.stringify({status:result.status,evidence,error:result.error,diagnosticImages,shutdownError:result.shutdownError,linuxProcesses:process.platform==='linux'&&result.status==='failed'?{launcher:result.chrome?.launchedProcess,actual:result.chrome?.actualProcess,observedDisplayEntries:result.chrome?.observedDisplayEntries,displayProof:result.linuxDisplayProof,helperFailure:result.linuxHelperFailure,pickerPhase:result.linuxPickerPhase,actions:result.actions}:undefined,workspace:scratch,workspaceStatus:result.workspaceStatus,fixtureStatus:result.fixtureStatus,emptyStatus:result.emptyStatus},null,2));
    if(result.status!=='qualified')process.exitCode=1;
  }
}
await main();
