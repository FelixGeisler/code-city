import assert from 'node:assert/strict';

// Product integration uses real OPFS directory/file capabilities transferred into the
// production worker. The external native chooser/link/ACL boundary is qualified by
// check-local-folder-native.mjs, not claimed by this capability-picker substitution.
export const localPickerSubstitution = `window.showDirectoryPicker=async()=>{if(window.__localPickerError)throw new DOMException('Synthetic picker rejection',window.__localPickerError);return window.__localRoot;};`;
const markerA = 'PRIVATE_SYNTHETIC_UNCOMMITTED_A';
const markerB = 'PRIVATE_SYNTHETIC_UNCOMMITTED_B';
const sourcePath = 'src/app.ts';
const chooseFile = (p, path) => p.evaluate(`(()=>{const files=document.querySelector('[data-analyzed]');files.open=true;[...document.querySelectorAll('[data-analyzed-rows] button')].find(button=>button.querySelector('bdi').textContent===${JSON.stringify(path)}).click();return true;})()`);
async function sourceContains(p, marker) {
  await chooseFile(p, sourcePath); await p.wait(s=>s.units>0); await p.click('[data-unit-rows] button');
  await p.wait(s=>s.sourceReady&&s.contributions>0);
  assert.equal(await p.evaluate(`document.querySelector('[data-source-code]').textContent.includes(${JSON.stringify(marker)})`),true);
  assert.equal(await p.evaluate(`document.querySelectorAll('[data-source-code] script,[data-source-code] img').length`),0);
  await p.closeSource();
}
export function assertLocalRequests(requests, origin, {expectedPosts=0,savedId,forbidParser=false}={}) {
  const assets=new Set(['/','/favicon.ico','/browser.js','/browser.css','/analysis-worker.js','/parser/web-tree-sitter.js','/parser/web-tree-sitter.wasm','/parser/tree-sitter-javascript.wasm','/parser/tree-sitter-typescript.wasm','/parser/tree-sitter-tsx.wasm','/parser/tree-sitter-c-sharp.wasm']);
  const restored=new Set(savedId?[`/saved/${savedId}`,`/api/investigations/${savedId}`,`/api/investigations/${savedId}/record`]:[]);
  let posts=0;
  for (const request of requests) {
    const url = new URL(request.url);
    assert.equal(url.origin, origin, 'Local acquisition/inspection contacted a provider');
    assert.equal(url.search, '', 'Local data entered a request query');
    if (request.method === 'POST') {
      assert.equal(url.pathname,'/api/investigations','Unexpected local data upload route');posts++;
    } else {
      assert.equal(request.method,'GET');assert.ok(assets.has(url.pathname)||restored.has(url.pathname),'Unapproved local request route');
    }
    if(forbidParser)assert.equal(url.pathname.startsWith('/parser/'),false,'Reopen/inspection initialized an analysis parser');
    const metadata=JSON.stringify({url:url.href,headers:request.headers??{}});
    for(const value of ['PRIVATE_SYNTHETIC','synthetic-working-tree','src/app.ts'])assert.equal(metadata.includes(value),false,'Local repository data entered request metadata');
  }
  assert.equal(posts,expectedPosts,'Upload occurred outside its single explicit Save authorization');
}
const folderMessage = (p, text) => p.evaluate(`new Promise(resolve=>{let observer;const check=()=>{if(document.querySelector('[data-folder-status]').textContent.includes(${JSON.stringify(text)})){observer?.disconnect();resolve(true);}};observer=new MutationObserver(check);observer.observe(document.querySelector('[data-folder-status]'),{childList:true,subtree:true,characterData:true});check();})`);
async function submit(p) {
  await p.evaluate(`(()=>{const change=document.querySelector('[data-change-repository]');if(document.querySelector('form').hidden&&!change.disabled)change.click();document.querySelector('select[name=input-kind]').value='working-tree';document.querySelector('textarea').value='src/user-excluded';document.querySelector('form').requestSubmit();return true;})()`);
}
async function healthy(p) {
  const value = await p.wait(s=>s.canvases===1||s.feedback!==''||/failure|unavailable|could not|No supported|exceeds|admission failed/u.test(s.status));
  assert.equal(value.canvases,1,JSON.stringify(value)); assert.equal(value.analyzed,5); assert.equal(value.failed,2);
}
export async function exerciseLocalBrowser({page,cdp,harness,origin,request,checked}) {
  process.stdout.write('Browser evidence: local working-tree capture and source-once Save\n');
  harness.setMode('no-provider');
  const p = await page({localPicker:true});
  assert.equal(await p.evaluate(`document.querySelector('select[name=input-kind]').value`),'working-tree');
  const start = harness.requests.length, workers = harness.workers.size;
  await p.evaluate(`document.querySelector('form').requestSubmit();true`); await folderMessage(p,'Choose a folder');
  assert.equal(harness.workers.size,workers,'Missing folder created a worker');
  await p.evaluate(`(async()=>{const base=await navigator.storage.getDirectory();window.__localRoot=await base.getDirectoryHandle('synthetic-working-tree',{create:true});
    window.__writeLocal=async(path,text)=>{const parts=path.split('/');let dir=window.__localRoot;for(const name of parts.slice(0,-1))dir=await dir.getDirectoryHandle(name,{create:true});const file=await dir.getFileHandle(parts.at(-1),{create:true}),writer=await file.createWritable();await writer.write(text);await writer.close();};
    await window.__writeLocal('src/app.ts','export function choose(x: number) { return x; }\\r\\n');
    for(const name of ['.git','node_modules','dist','build','bin','obj','.angular','SYNTHETICFLOW.Hub.Web/ClientApp/.angular/cache/22.2.2/flow.hub.web/vite/deps','src/.GIT','src/user-excluded'])await window.__writeLocal(name+'/sentinel.cs','THIS_IS_SYNTHETIC_EXCLUDED_INVALID_SOURCE');
    await window.__writeLocal('src/View.cs','class View { int Choose(int x) { if(x>0) return 1; return 0; } }\\r\\n');
    await window.__writeLocal('src/view.jsx','export const view = x => x ? <A/> : <B/>;\\n');
    await window.__writeLocal('untracked.js','export const untracked = 1;\\n');
    await window.__writeLocal('.gitignore','ignored.js\\n');await window.__writeLocal('ignored.js','export const ignored = true;\\n');
    await window.__writeLocal('bad.ts','export const = ;');await window.__writeLocal('unsupported.ts',new Uint8Array([195,40]));
    return true;})()`);
  await p.click('[data-choose-folder]'); await folderMessage(p,'Folder selected');
  assert.equal(harness.workers.size,workers,'Choosing a folder analyzed it');
  await p.evaluate(`window.__writeLocal('src/app.ts',${JSON.stringify(`export function choose(x: number) { const marker = '${markerA}'; if(x) return x > 1 ? 1 : 2; return 0; }\r\n`)})`);
  await submit(p); await healthy(p);
  const captureId=(await p.snapshot()).commit;
  assert.match(captureId,/^[0-9a-f]{64}$/u);
  assert.equal(await p.evaluate(`document.querySelector('[data-origin-label]').textContent`),'Working-tree capture');
  assert.equal((await p.snapshot()).repository,'synthetic-working-tree');
  assert.deepEqual(await p.evaluate(`[...document.querySelectorAll('[data-analyzed-rows] bdi')].map(node=>node.textContent).sort()`),['ignored.js','src/View.cs','src/app.ts','src/view.jsx','untracked.js']);
  const fingerprint=await p.evaluate('window.__cityFingerprint');
  const frame=await p.evaluate(`({matrix:JSON.stringify(window.__render.matrices.at(-1)),uploads:window.__render.uploads})`);
  await sourceContains(p,markerA);
  assert.deepEqual(await p.evaluate(`({matrix:JSON.stringify(window.__render.matrices.at(-1)),uploads:window.__render.uploads})`),frame,'Local source inspection moved camera or uploaded geometry');
  assertLocalRequests(harness.requests.slice(start),origin);
  for(const kind of ['AbortError','NotAllowedError']) {
    await p.evaluate(`(()=>{if(document.querySelector('form').hidden)document.querySelector('[data-change-repository]').click();window.__localPickerError=${JSON.stringify(kind)};return true;})()`);
    await p.click('[data-choose-folder]'); await folderMessage(p,kind==='AbortError'?'cancelled':'denied');
    assert.equal(await p.evaluate('window.__cityFingerprint'),fingerprint,'Picker rejection discarded completed city');
    assert.equal((await p.snapshot()).canvases,1);
  }
  await p.evaluate(`window.__localPickerError=undefined;true`);
  assertLocalRequests(harness.requests.slice(start),origin);
  const saveStart=harness.requests.length;
  await p.click('[data-save]'); await p.wait(s=>s.saved||s.saveMessage.includes('unchanged'));
  assert.equal((await p.snapshot()).saved,true,(await p.snapshot()).saveMessage);
  const savedUrl=await p.evaluate('location.href'),id=new URL(savedUrl).pathname.split('/').at(-1);
  const response=await checked(request(origin,'/api/investigations/'+id));assert.equal(response.status,200);
  const bytes=response.body,headerBytes=bytes.readUInt32BE(8),header=JSON.parse(bytes.subarray(12,12+headerBytes).toString('utf8'));
  assert.equal(header.version,3);assert.deepEqual(header.origin,{kind:'working-tree',name:'synthetic-working-tree',captureId});
  assert.equal(header.files.length,7);assert.equal(header.files.find(file=>file.path==='unsupported.ts').normalized,null);
  assert.ok(header.files.every(file=>!Object.hasOwn(file,'raw')&&!Object.hasOwn(file,'blob')&&!Object.hasOwn(file,'rawPath')));
  assert.equal(bytes.length,12+headerBytes+header.files.reduce((sum,file)=>sum+(file.normalized?.length??0),0));
  assert.equal(bytes.indexOf(Buffer.from(markerA)),bytes.lastIndexOf(Buffer.from(markerA)),'Source appeared more than once in snapshot');
  assert.ok(bytes.indexOf(Buffer.from(markerA))>=12+headerBytes);
  assertLocalRequests(harness.requests.slice(saveStart),origin,{expectedPosts:1});
  const afterSave=harness.requests.length;
  await p.evaluate(`window.__writeLocal('src/app.ts',${JSON.stringify(`export function choose(x: number) { const marker = '${markerB}'; if(x) return x > 1 ? 1 : 2; return 0; }\n`)})`);
  await submit(p); await healthy(p); assert.notEqual((await p.snapshot()).commit,captureId,'Uncommitted edit did not change capture identity');
  await sourceContains(p,markerB);
  const editedId=(await p.snapshot()).commit;
  // Hold a real parser asset, then replace the local attempt: no old reply may publish.
  const barrierStart=harness.events.length;harness.setMode('parser-held');await submit(p);
  const barrier=await checked(harness.waitFor(event=>harness.events.indexOf(event)>=barrierStart&&event.kind==='parser-held'));
  await p.click('[data-status] button');await p.wait(s=>s.status==='Cancelled'&&s.canvases===0);
  await checked(harness.waitFor(event=>event.kind==='detached'&&event.sessionId===barrier.sessionId));
  const replacementStart=harness.events.length;harness.setMode('parser-held');await submit(p);
  const replaced=await checked(harness.waitFor(event=>harness.events.indexOf(event)>=replacementStart&&event.kind==='parser-held'));
  harness.setMode('no-provider');await p.evaluate(`document.querySelector('form').requestSubmit();true`);await healthy(p);
  await checked(harness.waitFor(event=>event.kind==='detached'&&event.sessionId===replaced.sessionId));
  assert.equal((await p.snapshot()).commit,editedId,'Replacement changed identical captured input');
  assertLocalRequests(harness.requests.slice(afterSave),origin);
  await checked(cdp.send('Target.closeTarget',{targetId:p.targetId}));
  return{savedUrl,fingerprint,captureId,marker:markerA,sourcePath};
}
export async function reopenLocalBrowser({page,cdp,harness,checked,origin,saved}) {
  process.stdout.write('Browser evidence: local restart/fresh-context source drill-down without folder/provider\n');
  const start=harness.requests.length;
  const {browserContextId}=await checked(cdp.send('Target.createBrowserContext'));
  const p=await page({url:saved.savedUrl,browserContextId});
  await p.wait(s=>s.canvases===1&&s.saved);
  assert.equal((await p.snapshot()).commit,saved.captureId);assert.equal(await p.evaluate('window.__cityFingerprint'),saved.fingerprint);
  assert.equal(await p.evaluate(`document.querySelector('[data-origin-label]').textContent`),'Working-tree capture');
  assert.equal(await p.evaluate(`document.querySelector('[data-folder-name]').textContent`),'No folder selected');
  assert.ok(harness.requests.slice(start).every(item=>new URL(item.url).origin===origin&&!new URL(item.url).pathname.startsWith('/parser/')),'Reopen acquired or analyzed source');
  await sourceContains(p,saved.marker);
  assertLocalRequests(harness.requests.slice(start),origin,{savedId:new URL(saved.savedUrl).pathname.split('/').at(-1),forbidParser:true});
  await checked(cdp.send('Target.closeTarget',{targetId:p.targetId}));await checked(cdp.send('Target.disposeBrowserContext',{browserContextId}));
}
