import assert from 'node:assert/strict';
import { assertLocalRequests } from './standalone-local-browser-scenarios.mjs';

// Real OPFS capabilities, production worker/parser/UI, and isolated harness hosts.
// This is NOT OS-native chooser qualification (that separate gate is unchanged).
export const automaticExclusionObservation = `(() => {
  window.__automaticCommands=[];
  const post=Worker.prototype.postMessage;
  Worker.prototype.postMessage=function(value,...args){window.__automaticCommands.push(value?.type);return post.call(this,value,...args);};
})()`;
const markerA = 'AUTOMATIC_LOCAL_MARKER_A';
const cacheMarker = 'AUTOMATIC_CACHE_INCLUDED';
const initialManual = ['manual-omit'];
const editedManual = ['manual-next', 'manual-omit'];
const defaultDetected = [['.vite','cache:.vite'],['.yarn/cache','dependency:.yarn/cache']];
const includedDetected = [['.vite','cache:.vite'],['.vite/node_modules','dependency:node_modules'],['.yarn/cache','dependency:.yarn/cache']];
const policy = (manual, included, detected, effective) => ({version:'code-city-auto-exclusions-1',manual,included,detected,effective});
const defaultPolicy = policy(initialManual, [], defaultDetected, ['.vite','.yarn/cache','manual-omit']);
const includedPolicy = policy(editedManual, ['.vite'], includedDetected, ['.vite/node_modules','.yarn/cache',...editedManual]);
const localPaths = ['.yarn/plugins/authored.js','src/app.ts'];
const githubPaths = ['.yarn/plugins/authored.js','owned.js','packages/owned.js'];
const sort = values => [...values].sort(); // All fixture paths are ASCII.
const editor = 'textarea[name=additional-exclusions]';
const rows = p => p.evaluate(`document.querySelector(${JSON.stringify(editor)}).value.split('\\n').filter(Boolean)`);
async function assertRows(p, detected, included = [], manual = []) {
  const effective = [...new Set([...manual,...detected.filter(([path])=>!included.includes(path)||manual.some(root=>path===root||path.startsWith(root+'/'))).map(([path])=>path)])];
  assert.deepEqual(sort(await rows(p)), sort(effective));
  assert.equal(await p.evaluate(`document.querySelectorAll('textarea').length===1&&!document.querySelector('select[name=input-kind], [data-automatic-exclusions], input[type=checkbox]')`),true);
}
async function togglePath(p, path) {
  const paths=await rows(p);
  await manual(p,paths.includes(path)?paths.filter(value=>value!==path):[...paths,path]);
}
async function openSetup(p) {
  await p.evaluate(`(()=>{if(document.querySelector('form').hidden)document.querySelector('[data-change-repository]').click();document.querySelector('[data-exclusions]').open=true;return true;})()`);
}
async function manual(p, paths) {
  await p.evaluate(`(()=>{const input=document.querySelector('textarea[name=additional-exclusions]');input.value=${JSON.stringify(paths.join('\n'))};input.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
}
async function analyze(p) {
  await openSetup(p);
  await p.evaluate(`document.querySelector('form').requestSubmit();true`);
}
async function terminal({p,harness,checked,start,paths,label}) {
  const event=await checked(harness.waitFor(e=>harness.events.indexOf(e)>=start&&e.kind==='event'&&['ANALYSIS_SUCCEEDED','ANALYSIS_FAILED','ANALYSIS_ALL_FILES_FAILED','WORKING_TREE_FAILED'].includes(e.value.type)));
  assert.equal(event.value.type,'ANALYSIS_SUCCEEDED',JSON.stringify(event.value));
  const value=await p.wait(s=>s.progress===null&&(s.canvases===1||s.status.includes('failure')));
  assert.equal(value.canvases,1,JSON.stringify(value));assert.equal(value.analyzed,paths.length);assert.equal(value.failed,0);assert.equal(value.controls,true);
  assert.deepEqual(sort(event.value.city.inspection.map(file=>file.canonicalPath)),sort(paths));
  assert.deepEqual(sort(await p.evaluate(`[...document.querySelectorAll('[data-analyzed-rows] bdi')].map(row=>row.textContent)`)),sort(paths));
  process.stdout.write(`Automatic exclusion table: ${label}: ${value.analyzed} analyzed, ${value.failed} failed, ${value.canvases} canvas, final progress absent\n`);
  return event;
}
async function assertApplied(harness,start,expected) {
  const reports=harness.events.slice(start).filter(e=>e.kind==='event'&&e.value.type==='EXCLUSION_POLICY');
  assert.ok(reports.length>0,'Actual worker did not report applied policy');
  assert.equal(reports.at(-1).value.complete,true);
  assert.deepEqual(reports.at(-1).value.policy,expected);
}
async function inspect(p,path,marker) {
  await p.evaluate(`(()=>{document.querySelector('[data-analyzed]').open=true;[...document.querySelectorAll('[data-analyzed-rows] button')].find(button=>button.querySelector('bdi').textContent===${JSON.stringify(path)}).click();return true;})()`);
  await p.wait(s=>s.units>0);await p.click('[data-unit-rows] button');await p.wait(s=>s.sourceReady);
  assert.equal(await p.evaluate(`document.querySelector('[data-source-code]').textContent.includes(${JSON.stringify(marker)})`),true,`Actual code-unit inspection omitted ${marker}`);
  await p.closeSource();
}
async function quietState(p,harness) {
  // Two rendered frames, not a sleep/retry: let any UI redraw be observable.
  await p.evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
  const owns = sessionId => sessionId===p.sessionId||harness.workers.get(sessionId)?.parentSessionId===p.sessionId;
  return {requests:harness.requests.filter(r=>owns(r.sessionId)).length,events:harness.events.filter(e=>owns(e.sessionId)).length,workers:[...harness.workers.values()].filter(w=>owns(w.sessionId)).length,...await p.evaluate(`({commands:window.__automaticCommands.length,fingerprint:window.__cityFingerprint,uploads:window.__render.uploads,matrices:JSON.stringify(window.__render.matrices),frames:JSON.stringify(window.__render.frames),canvases:document.querySelectorAll('[data-city] canvas').length})`)};
}
async function selectFolder(p) {
  await p.click('[data-choose-folder]');
  await p.evaluate(`new Promise(resolve=>{let observer;const check=()=>{if(document.querySelector('[data-folder-status]').textContent.startsWith('Folder selected.')){observer?.disconnect();resolve(true);}};observer=new MutationObserver(check);observer.observe(document.querySelector('[data-folder-status]'),{subtree:true,childList:true,characterData:true});check();})`);
}
async function createFolder(p,name,{onlyExcluded=false,cache=cacheMarker,excludedRoot='.vite'}={}) {
  const fixtures=onlyExcluded ? [[`${excludedRoot}/cache.ts`,`export function cache(x: number) { return x ? '${cache}' : ''; }\n`]] : [
    ['src/app.ts',`export function app(x: number) { const marker = '${markerA}'; return x ? marker : ''; }\n`],
    ['.vite/cache.js',`export function cache(x) { const marker = '${cache}'; return x ? marker : ''; }\n`],
    ['.vite/node_modules/deep.js',"export function nested(x) { return x ? 1 : 0; }\n"],
    ['.yarn/cache/pkg.js',"export function dependency(x) { return x ? 1 : 0; }\n"],
    ['.yarn/plugins/authored.js',"export function authored(x) { return x ? 1 : 0; }\n"],
    ['manual-omit/owned.js',"export function manual(x) { return x ? 1 : 0; }\n"],
  ];
  await p.evaluate(`(async()=>{window.__localRoot=await (await navigator.storage.getDirectory()).getDirectoryHandle(${JSON.stringify(name)},{create:true});for(const [path,text] of ${JSON.stringify(fixtures)}){const parts=path.split('/');let dir=window.__localRoot;for(const part of parts.slice(0,-1))dir=await dir.getDirectoryHandle(part,{create:true});const file=await dir.getFileHandle(parts.at(-1),{create:true}),writer=await file.createWritable();await writer.write(text);await writer.close();}return true;})()`);
}
async function readSnapshot({origin,request,checked,savedUrl,expected,paths,markers}) {
  const id=new URL(savedUrl).pathname.split('/').at(-1);
  const response=await checked(request(origin,'/api/investigations/'+id));assert.equal(response.status,200);
  const bytes=response.body;
  assert.equal(bytes.subarray(0,8).toString('ascii'),'CCSAVE4\0');
  const size=bytes.readUInt32BE(8),header=JSON.parse(bytes.subarray(12,12+size).toString('utf8'));
  assert.equal(header.version,4);assert.deepEqual(header.exclusionPolicy,expected);
  assert.deepEqual(sort(header.files.map(file=>file.path)),sort(paths));
  assert.equal(bytes.length,12+size+header.files.reduce((sum,file)=>sum+(file.normalized?.length??0),0));
  for(const marker of markers){assert.ok(bytes.indexOf(Buffer.from(marker))>=12+size);assert.equal(bytes.indexOf(Buffer.from(marker)),bytes.lastIndexOf(Buffer.from(marker)),'Saved source was copied more than once');}
  if(!expected.included.includes('.vite'))assert.equal(bytes.includes(Buffer.from(cacheMarker)),false,'Pending override leaked cache bytes into Save');
  return {id,bytes,header};
}
async function save({p,harness,origin,request,checked,expected,paths,markers}) {
  // Strict interval begins immediately before this sole explicit click and ends
  // when its saved UI state is bound, before any subsequent action.
  const start=harness.requests.length;
  await p.click('[data-save]');const value=await p.wait(s=>s.saved||s.saveMessage.includes('unchanged'));
  assert.equal(value.saved,true,value.saveMessage);
  assertLocalRequests(harness.requests.slice(start),origin,{expectedPosts:1});
  const savedUrl=await p.evaluate('location.href');
  const snapshot=await readSnapshot({origin,request,checked,savedUrl,expected,paths,markers});
  return {savedUrl,fingerprint:await p.evaluate('window.__cityFingerprint'),captureId:(await p.snapshot()).commit,expected,paths,markers,...snapshot};
}

export async function exerciseAutomaticExclusions({page,cdp,harness,origin,request,checked}) {
  process.stdout.write('Browser evidence: automatic exclusions, real OPFS capability and staged/applied Save\n');
  harness.setMode('automatic-exclusions-local');
  const p=await page({localPicker:true,observation:automaticExclusionObservation});
  const requestStart=harness.requests.length;
  await createFolder(p,'synthetic-automatic-exclusions');
  const beforeSelection=await quietState(p,harness);
  await selectFolder(p);
  assert.deepEqual(await quietState(p,harness),beforeSelection,'Folder selection performed acquisition or analysis');
  await manual(p,initialManual);
  let start=harness.events.length;await analyze(p);
  const initial=await terminal({p,harness,checked,start,paths:localPaths,label:'local default'});
  await assertApplied(harness,start,defaultPolicy);await openSetup(p);await assertRows(p,defaultDetected,[],initialManual);
  const initialIdentity=(await p.snapshot()).commit;
  start=harness.events.length;await analyze(p);
  await terminal({p,harness,checked,start,paths:localPaths,label:'local identical default rerun'});
  await assertApplied(harness,start,defaultPolicy);
  assert.equal((await p.snapshot()).commit,initialIdentity,'Unchanged populated list promoted automatic paths to manual or changed identity');
  await openSetup(p);
  // The gateway snapshots each admitted File twice (before/after streaming) to
  // detect mutation. Both accesses, and every requested directory descent, count.
  assert.deepEqual(sort(harness.events.slice(start).filter(e=>e.kind==='local-read').map(e=>e.value.path)),sort(localPaths.flatMap(path=>[path,path])),'Default capture read a pruned source or omitted an admitted source');
  assert.deepEqual(sort(harness.events.slice(start).filter(e=>e.kind==='local-descent').map(e=>e.value.path)),['','.yarn','.yarn/plugins','src'],'Default capture descended into a pruned directory');
  await inspect(p,'src/app.ts',markerA);
  const beforeEdit=await quietState(p,harness);
  await togglePath(p,'.vite');await manual(p,[...await rows(p),'manual-next']);
  assert.deepEqual(await quietState(p,harness),beforeEdit,'Staged list edits changed source, worker RPC, network, city, GPU or camera');
  await assertRows(p,defaultDetected,['.vite'],editedManual);
  assertLocalRequests(harness.requests.slice(requestStart),origin);
  const pending=await save({p,harness,origin,request,checked,expected:defaultPolicy,paths:localPaths,markers:[markerA]});
  assert.equal(pending.fingerprint,JSON.stringify(initial.value.city));
  const afterPendingSave=harness.requests.length;
  start=harness.events.length;await analyze(p);
  const includedPaths=['.vite/cache.js',...localPaths];
  await terminal({p,harness,checked,start,paths:includedPaths,label:'local explicit include'});
  await assertApplied(harness,start,includedPolicy);await openSetup(p);await assertRows(p,includedDetected,['.vite'],editedManual);
  assert.deepEqual(sort(harness.events.slice(start).filter(e=>e.kind==='local-read').map(e=>e.value.path)),sort(includedPaths.flatMap(path=>[path,path])),'Exact include read nested dependencies or omitted real cache reads');
  assert.deepEqual(sort(harness.events.slice(start).filter(e=>e.kind==='local-descent').map(e=>e.value.path)),['','.vite','.yarn','.yarn/plugins','src'],'Exact include descended into nested dependencies');
  const includedIdentity=(await p.snapshot()).commit;
  start=harness.events.length;await analyze(p);
  await terminal({p,harness,checked,start,paths:includedPaths,label:'local identical included rerun'});
  await assertApplied(harness,start,includedPolicy);
  assert.equal((await p.snapshot()).commit,includedIdentity,'Exact include or nested automatic provenance changed on identical rerun');
  await openSetup(p);await inspect(p,'.vite/cache.js',cacheMarker);
  assertLocalRequests(harness.requests.slice(afterPendingSave),origin);
  const included=await save({p,harness,origin,request,checked,expected:includedPolicy,paths:includedPaths,markers:[markerA,cacheMarker]});
  assert.notEqual(included.captureId,pending.captureId);
  const afterIncludedSave=harness.requests.length;
  const beforePostSave=await quietState(p,harness);
  await togglePath(p,'.vite');
  assert.deepEqual(await quietState(p,harness),beforePostSave,'Post-Save list edit performed work');
  const unchanged=await readSnapshot({origin,request,checked,...included});
  assert.deepEqual(unchanged.bytes,included.bytes,'Pending next-Analyze settings mutated the recorded snapshot');
  start=harness.events.length;await analyze(p);
  await terminal({p,harness,checked,start,paths:localPaths,label:'local readded root excludes again'});
  await assertApplied(harness,start,policy(editedManual,[],defaultDetected,['.vite','.yarn/cache',...editedManual]));
  await openSetup(p);
  const beforeTabs=await quietState(p,harness);
  await p.click('[data-source-github]');
  assert.equal(await p.evaluate(`document.querySelector('[data-github-setup]').checkVisibility()&&!document.querySelector('[data-local-setup]').checkVisibility()`),true);
  await p.evaluate(`document.querySelector('[data-source-github]').focus();true`);
  await checked(cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Home',code:'Home',windowsVirtualKeyCode:36},p.sessionId));
  await checked(cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Home',code:'Home',windowsVirtualKeyCode:36},p.sessionId));
  assert.equal(await p.evaluate(`document.activeElement===document.querySelector('[data-source-local]')&&document.querySelector('[data-source-local]').getAttribute('aria-selected')==='true'&&document.querySelector('[data-local-setup]').checkVisibility()&&!document.querySelector('[data-github-setup]').checkVisibility()`),true);
  assert.deepEqual(await quietState(p,harness),beforeTabs,'Source tab pointer/keyboard changes performed work or changed current city/camera/GPU');
  assert.deepEqual(await rows(p),editedManual,'Source change retained auto-only rows');
  await checked(cdp.send('Target.closeTarget',{targetId:p.targetId}));

  const all=await page({localPicker:true,observation:automaticExclusionObservation});
  const excludedRoot='SYNTHETICFLOW.Hub.Web/ClientApp/long-workspace-directory-for-automatic-exclusion-layout/.vite';
  await createFolder(all,'synthetic-all-excluded',{onlyExcluded:true,excludedRoot});await selectFolder(all);
  start=harness.events.length;await analyze(all);
  const failed=await checked(harness.waitFor(e=>harness.events.indexOf(e)>=start&&e.kind==='event'&&e.value.type==='WORKING_TREE_FAILED'));
  assert.equal(failed.value.category,'No supported modules');
  const empty=await all.wait(s=>s.progress===null&&s.status.includes('No supported'));
  assert.equal(empty.canvases,0);assert.equal(empty.setup,true);assert.equal(empty.analyzed,0);assert.equal(empty.failed,0);
  assert.equal(await all.evaluate(`document.querySelector('[data-exclusions]').open&&document.querySelector(${JSON.stringify(editor)}).checkVisibility()`),true);
  assert.equal(harness.events.slice(start).filter(e=>e.kind==='local-read').length,0);
  await assertRows(all,[[excludedRoot,'cache:.vite']]);
  await checked(cdp.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true},all.sessionId));
  const layout=await all.evaluate(`(()=>{const input=document.querySelector(${JSON.stringify(editor)}),box=input.getBoundingClientRect();return {width:box.width,height:box.height,scroll:document.documentElement.scrollWidth,viewport:innerWidth};})()`);
  assert.ok(layout.width>=250&&layout.width<=layout.viewport&&layout.height>=70,JSON.stringify(layout));
  assert.ok(layout.scroll<=layout.viewport+1,JSON.stringify(layout));
  process.stdout.write(`Automatic exclusion table: local all excluded: 0 analyzed, 0 canvas, editable exclusions (${failed.value.type})\n`);
  await togglePath(all,excludedRoot);start=harness.events.length;await analyze(all);
  await terminal({p:all,harness,checked,start,paths:[`${excludedRoot}/cache.ts`],label:'local all-excluded recovery'});
  await inspect(all,`${excludedRoot}/cache.ts`,cacheMarker);
  assertLocalRequests(harness.requests.slice(afterIncludedSave),origin);
  await checked(cdp.send('Target.closeTarget',{targetId:all.targetId}));

  process.stdout.write('Browser evidence: GitHub automatic exclusions, actual admission/projector/raw reads\n');
  harness.setMode('automatic-exclusions');
  const github=await page({observation:automaticExclusionObservation});
  // Use the real source tab, not a hidden compatibility input.
  await github.click('[data-source-github]');
  await github.evaluate(`document.querySelector('input[name=repository]').value='https://github.com/fixture/standalone';true`);
  const githubCases=[
    {label:'github default',paths:githubPaths,included:[],manual:[],detected:defaultDetected,effective:['.vite','.yarn/cache']},
    {label:'github include',paths:['.vite/cache.js',...githubPaths],included:['.vite'],manual:[],detected:includedDetected,effective:['.vite/node_modules','.yarn/cache'],toggle:true},
    {label:'github readd excludes',paths:githubPaths,included:[],manual:[],detected:defaultDetected,effective:['.vite','.yarn/cache'],toggle:true},
    {label:'github manual ancestor/file wins',paths:['.vite/cache.js','packages/owned.js'],included:['.vite'],manual:['.yarn','owned.js'],detected:includedDetected.filter(([path])=>!path.startsWith('.yarn/')),effective:['.vite/node_modules','.yarn','owned.js'],toggle:true},
  ];
  for(const test of githubCases){
    await openSetup(github);if(test.toggle)await togglePath(github,'.vite');
    if(test.manual.length)await manual(github,[...await rows(github),...test.manual]);
    start=harness.events.length;const networkStart=harness.requests.length;await analyze(github);
    const result=await terminal({p:github,harness,checked,start,paths:test.paths,label:test.label});
    await assertApplied(harness,start,policy(test.manual,test.included,test.detected,test.effective));
    await openSetup(github);await assertRows(github,test.detected,test.included,test.manual);
    assert.deepEqual(sort(harness.events.slice(start).filter(e=>e.kind==='raw').map(e=>e.name)),sort(test.paths),'Provider route did not fetch exactly the admitted sources');
    const workerRequests=harness.requests.slice(networkStart).filter(r=>r.sessionId===result.sessionId&&r.method==='GET');
    assert.deepEqual(sort(workerRequests.filter(r=>new URL(r.url).origin==='https://raw.githubusercontent.com').map(r=>new URL(r.url).pathname.split('/').slice(4).map(decodeURIComponent).join('/'))),sort(test.paths),'Full worker Network metadata differs from admitted raw reads');
    assert.equal(workerRequests.filter(r=>new URL(r.url).origin==='https://api.github.com').length,3,'Provider metadata inventory/resolution was skipped');
    if(test.included.includes('.vite'))await inspect(github,'.vite/cache.js',cacheMarker);
  }
  await checked(cdp.send('Target.closeTarget',{targetId:github.targetId}));
  harness.setMode('no-provider');
  return [pending,included];
}

export async function reopenAutomaticExclusions({page,cdp,harness,origin,request,checked,saved}) {
  process.stdout.write('Browser evidence: automatic policy/source restart restoration and deliberate folder reanalysis\n');
  for(const record of saved){
    harness.setMode('automatic-exclusions-restore');
    const start=harness.requests.length;
    const {browserContextId}=await checked(cdp.send('Target.createBrowserContext'));
    const p=await page({url:record.savedUrl,browserContextId,localPicker:true,observation:automaticExclusionObservation});
    await p.wait(s=>s.canvases===1&&s.saved&&s.progress===null);
    assert.equal((await p.snapshot()).analyzed,record.paths.length);
    assert.equal((await p.snapshot()).commit,record.captureId);assert.equal(await p.evaluate('window.__cityFingerprint'),record.fingerprint);
    assert.equal(await p.evaluate(`document.querySelector('[data-folder-name]').textContent`),'No folder selected');
    await openSetup(p);await assertRows(p,record.expected.detected,record.expected.included,record.expected.manual);
    assert.deepEqual(await rows(p),record.expected.effective);
    await inspect(p,'src/app.ts',markerA);
    if(record.expected.included.length)await inspect(p,'.vite/cache.js',cacheMarker);
    assertLocalRequests(harness.requests.slice(start),origin,{savedId:record.id,forbidParser:true});
    const restorationEvents=harness.events.filter(e=>harness.workers.get(e.sessionId)?.parentSessionId===p.sessionId);
    const restored=restorationEvents.filter(e=>e.kind==='event'&&e.value.type==='RESTORED');
    assert.equal(restored.length,1);assert.deepEqual(restored[0].value.exclusionPolicy,record.expected,'Restored worker changed the applied policy, including effective exclusions');
    assert.deepEqual(restorationEvents.filter(e=>e.kind==='local-capability').map(e=>e.value.present),[false],'Restoration acquired a filesystem capability');
    assert.equal(restorationEvents.filter(e=>e.kind==='local-read'||e.kind==='local-descent').length,0,'Restoration read a filesystem capability');
    const snapshot=await readSnapshot({origin,request,checked,...record});assert.deepEqual(snapshot.bytes,record.bytes);
    if(record.expected.included.length){
      const beforeMissing=await quietState(p,harness);await analyze(p);
      assert.ok(await p.evaluate(`document.querySelector('[data-folder-status]').textContent.includes('Choose a folder')`));
      assert.deepEqual(await quietState(p,harness),beforeMissing,'Restored capture implicitly reconnected');
      await createFolder(p,'synthetic-automatic-reselected',{cache:'AUTOMATIC_RESELECTED_CACHE'});
      const beforeSelection=await quietState(p,harness);await selectFolder(p);
      assert.deepEqual(await quietState(p,harness),beforeSelection,'Restored folder selection scanned or changed the city');
      await assertRows(p,record.expected.detected,record.expected.included,record.expected.manual);
      assert.deepEqual(await rows(p),record.expected.effective,'Required folder selection lost restored effective list');
      harness.setMode('automatic-exclusions-local');const attemptStart=harness.events.length;await analyze(p);
      await terminal({p,harness,checked,start:attemptStart,paths:record.paths,label:'restored include survives explicit folder selection'});
      await assertApplied(harness,attemptStart,includedPolicy);await inspect(p,'.vite/cache.js','AUTOMATIC_RESELECTED_CACHE');
    }
    await checked(cdp.send('Target.closeTarget',{targetId:p.targetId}));await checked(cdp.send('Target.disposeBrowserContext',{browserContextId}));
  }
  harness.setMode('no-provider');
}
