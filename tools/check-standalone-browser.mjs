import assert from "node:assert/strict";
import { closeDialogAndWait } from "./browser-dialog-barrier.mjs";
import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, nextResolve) { return nextResolve(/^\.\.?\//u.test(specifier) && !/\.[a-z]+$/iu.test(specifier) ? `${specifier}.ts` : specifier, context); } });
const { resetCamera, pickAtCanvasPoint } = await import("../src/domain/camera-picking-policy.ts");
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { auditStandaloneArtifact } from "./standalone-manifest.mjs";
import { canonicalStandaloneRoot } from "./build-standalone.mjs";
import { closeInstalledChrome, connectCdp, discoverInstalledChrome, launchInstalledChrome, readInstalledChromeVersion } from "./chrome-cdp.mjs";
import { expectCleanExit, launchStandalone, readyOrigin, request, sendGracefulSignal, terminateForCleanup, writeSignalPreload } from "./standalone-check-support.mjs";
import { createBrowserProviderHarness, FIXTURE_REVISION } from "./standalone-browser-provider-harness.mjs";

const WATCHDOG_MS = 600_000;
const REPOSITORY = "https://github.com/fixture/standalone";
const snapshotExpression = `({ready:document.readyState,status:document.querySelector('[data-status]')?.textContent??'',feedback:document.querySelector('[data-feedback]')?.textContent??'',commit:document.querySelector('[data-commit]')?.textContent??'',canvases:document.querySelectorAll('[data-city] canvas').length,analyzed:document.querySelectorAll('[data-analyzed-rows] li').length,failed:document.querySelectorAll('[data-failed-rows] li').length,units:document.querySelectorAll('[data-unit-rows] li').length,unitMessage:document.querySelector('[data-units] > [role=status]')?.textContent??'',sourceOpen:document.querySelector('[data-unit-source]')?.open??false,sourceReady:document.querySelectorAll('[data-source-code] [data-source-line]').length>0,sourceMessage:document.querySelector('[data-source-body] [role=status]')?.textContent??'',contributionMessage:document.querySelector('[data-owned-contributions] [role=status]')?.textContent??'',contributions:document.querySelectorAll('[data-contribution-rows] li').length,saved:document.querySelector('[data-save]')?.textContent==='Copy link',saveMessage:document.querySelector('[data-save-status]')?.textContent??'',setup:!document.querySelector('form').hidden,summary:!document.querySelector('[data-investigation]').hidden,repository:document.querySelector('[data-repository]').textContent,findOpen:document.querySelector('[data-analyzed]')?.open??null,failuresOpen:document.querySelector('[data-failed]').open,district:document.querySelector('[data-district-path]')?.textContent??null,selectedFile:document.querySelector('[data-canonical-path]')?.textContent??null,controls:!document.querySelector('[data-investigation-controls]').hidden,progress:(()=>{const p=document.querySelector('progress');return p?{value:p.value,max:p.max,determinate:p.hasAttribute('value')}:null})()})`;
const renderObservation = `(() => {
 window.__render={matrices:[],uploads:0,integers:{},frames:[],capturePixels:false,progress:[]};
 const progressIds=new WeakMap();let nextProgress=0;
 const value=Object.getOwnPropertyDescriptor(HTMLProgressElement.prototype,'value');
 Object.defineProperty(HTMLProgressElement.prototype,'value',{...value,set(next){value.set.call(this,next);if(!progressIds.has(this))progressIds.set(this,++nextProgress);window.__render.progress.push({id:progressIds.get(this),value:this.value,max:this.max,ready:!!document.querySelector('[data-city] canvas')});}});
 const getContext=HTMLCanvasElement.prototype.getContext;
 HTMLCanvasElement.prototype.getContext=function(type,...args){
  const gl=getContext.call(this,type,...args);if(type!=='webgl2'||!gl||gl.__observed)return gl;
  gl.__observed=true;const names=new WeakMap();const location=gl.getUniformLocation.bind(gl);
  gl.getUniformLocation=(p,n)=>{const l=location(p,n);if(l)names.set(l,n);return l;};
  const matrix=gl.uniformMatrix4fv.bind(gl);gl.uniformMatrix4fv=(l,t,v)=>{if(names.get(l)==='u_clipFromTarget')window.__render.matrices.push([...v]);return matrix(l,t,v);};
  const integer=gl.uniform1i.bind(gl);gl.uniform1i=(l,v)=>{window.__render.integers[names.get(l)]=v;return integer(l,v);};
  const draw=gl.drawElementsInstanced.bind(gl);gl.drawElementsInstanced=(...args)=>{const result=draw(...args);if(window.__render.capturePixels&&window.__render.integers.u_passKind===1){const bytes=new Uint8Array(gl.drawingBufferWidth*gl.drawingBufferHeight*4);gl.readPixels(0,0,gl.drawingBufferWidth,gl.drawingBufferHeight,gl.RGBA,gl.UNSIGNED_BYTE,bytes);let hash=2166136261;for(const byte of bytes)hash=Math.imul(hash^byte,16777619)>>>0;let contrast;if(window.__render.captureContrast){contrast={base:0,lower:0,upper:0,edge:0,selected:0};for(let i=0;i<bytes.length;i+=4){const rgb=(bytes[i]<<16)|(bytes[i+1]<<8)|bytes[i+2];if(rgb===0x182a43)contrast.base++;else if(rgb===0x36506c)contrast.lower++;else if(rgb===0x4d6886)contrast.upper++;else if(rgb===0x94b1cd)contrast.edge++;else if(rgb===0xc8dcf0)contrast.selected++;}}window.__render.frames.push({hash,selected:window.__render.integers.u_selectionIndex,contrast});}return result;};
  const buffer=gl.bufferData.bind(gl);gl.bufferData=(...args)=>{window.__render.uploads++;return buffer(...args);};return gl;
 };
 window.__gate={active:false,opened:false,queue:[]};
 const add=Worker.prototype.addEventListener, remove=Worker.prototype.removeEventListener, listeners=new WeakMap();
 Worker.prototype.addEventListener=function(type,callback,...options){
  if(type!=='message'||typeof callback!=='function')return add.call(this,type,callback,...options);
  const wrapped=event=>{const gate=window.__gate;const data=event.data;
   if(data.type==='ANALYSIS_SUCCEEDED')window.__cityFingerprint=JSON.stringify(data.city);
   if(gate.active){
    if(!gate.opened&&data.type==='ANALYSIS_PROGRESS'&&data.stage==='analysis'&&data.completed===0)gate.opened=true;
    else if(gate.opened){gate.queue.push({data,deliver:()=>callback.call(this,event)});window.__codeCityDeliveryEvidence(JSON.stringify({type:data.type,stage:data.stage,completed:data.completed}));return;}
   }
   callback.call(this,event);
  };
  let map=listeners.get(this);if(!map){map=new WeakMap();listeners.set(this,map);}map.set(callback,wrapped);
  return add.call(this,type,wrapped,...options);
 };
 Worker.prototype.removeEventListener=function(type,callback,...options){return remove.call(this,type,type==='message'?(listeners.get(this)?.get(callback)??callback):callback,...options);};
 window.__drainProgress=count=>{if(count===null)window.__gate.active=false;while(window.__gate.queue.length){const item=window.__gate.queue.shift();item.deliver();if(count!==null&&item.data.type==='ANALYSIS_PROGRESS'&&item.data.stage==='analysis'&&item.data.completed===count)break;}};
})()`;

export async function checkStandaloneBrowser() {
  const failure = Promise.withResolvers();
  const checked = promise => Promise.race([promise, failure.promise]);
  const timer = setTimeout(() => failure.reject(new Error("Standalone browser evidence exceeded its watchdog")), WATCHDOG_MS);
  let temporary, processUnderTest, chrome, cdp, harness;
  let chromeLaunchAttempted = false;
  const exceptions = [];
  try {
    const manifest = await checked(auditStandaloneArtifact(canonicalStandaloneRoot));
    temporary = await checked(mkdtemp(path.join(os.tmpdir(), "code-city-browser-worker-evidence-")));
    const preload = await checked(writeSignalPreload(temporary));
    const dataDirectory = path.join(temporary, "saved-data");
    processUnderTest = launchStandalone({ preload, serverArguments: ["--port", "0", "--data-dir", dataDirectory] });
    const origin = await checked(readyOrigin(processUnderTest));
    const discovery = await checked(discoverInstalledChrome());
    const version = await checked(readInstalledChromeVersion(discovery));
    chromeLaunchAttempted = true;
    chrome = await checked(launchInstalledChrome(discovery, path.join(temporary, "profile")));
    const connection = connectCdp(chrome.websocketUrl);
    cdp = { ...connection, async send(method, params, sessionId) {
      try { return await connection.send(method, params, sessionId); }
      catch (error) { throw new Error(`Browser CDP command failed: ${method}`, { cause: error }); }
    } };
    harness = createBrowserProviderHarness(cdp, origin, error => failure.reject(error));
    cdp.listeners.add(message => {
      if (message.method === "Runtime.exceptionThrown") {
        const description = message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text;
        exceptions.push(description);
        failure.reject(new Error(`Packaged browser exception: ${description}`));
      }
    });
    const pages = [];
    async function page({ withoutCrypto = false, url = origin, browserContextId } = {}) {
      const { targetId } = await checked(cdp.send("Target.createTarget", { url: "about:blank", ...(browserContextId ? { browserContextId } : {}) }));
      const { sessionId } = await checked(cdp.send("Target.attachToTarget", { targetId, flatten: true }));
      await checked(cdp.send("Page.enable", {}, sessionId));
      await checked(cdp.send("Runtime.enable", {}, sessionId));
      await checked(cdp.send("Emulation.setDeviceMetricsOverride", { width: 1365, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId));
      await checked(cdp.send("Runtime.addBinding", { name: "__codeCityDeliveryEvidence" }, sessionId));
      await checked(harness.attachPage(sessionId));
      await checked(cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: renderObservation }, sessionId));
      if (withoutCrypto) await checked(cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `Object.defineProperty(crypto,'subtle',{value:undefined});` }, sessionId));
      const evaluate = async expression => {
        const result = await checked(cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId));
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
        return result.result.value;
      };
      const wait = async predicate => evaluate(`new Promise((resolve,reject)=>{const read=()=>(${snapshotExpression});const ok=${predicate.toString()};let observer;const check=()=>{const value=read();const error=value.status.startsWith('Presentation failed')?value.status:[value.unitMessage,value.sourceMessage,value.contributionMessage].find(text=>text.includes('unavailable'));if(error){observer?.disconnect();reject(new Error(error));return;}if(ok(value)){observer?.disconnect();resolve(value);}};observer=new MutationObserver(check);observer.observe(document,{subtree:true,childList:true,attributes:true,characterData:true});check();})`);
      const submit = (url = REPOSITORY, exclusions = "") => evaluate(`(()=>{const change=document.querySelector('[data-change-repository]');if(document.querySelector('form').hidden&&!change.disabled)change.click();document.querySelector('input[name=repository]').value=${JSON.stringify(url)};document.querySelector('textarea[name=additional-exclusions]').value=${JSON.stringify(exclusions)};document.querySelector('form').requestSubmit();return true;})()`);
      const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click();true`);
      const closeSource = () => evaluate(`(${closeDialogAndWait.toString()})(document.querySelector('[data-unit-source]'),()=>document.querySelector('[data-close-source]').click())`);
      const loaded = Promise.withResolvers();
      const onLoad = message => { if (message.sessionId === sessionId && message.method === "Page.loadEventFired") loaded.resolve(); };
      cdp.listeners.add(onLoad);
      try {
        await checked(cdp.send("Page.navigate", { url }, sessionId));
        await checked(loaded.promise);
      } finally { cdp.listeners.delete(onLoad); }
      await wait(s => s.ready === "complete");
      const p = { targetId, sessionId, evaluate, wait, submit, click, closeSource, snapshot: () => evaluate(snapshotExpression) };
      pages.push(p);return p;
    }
    const p = await page();
    const idle = await page();
    const idleThird = await page();
    const unsupported = await page({ withoutCrypto: true });
    assert.equal((await unsupported.snapshot()).status, "Browser analysis requires HTTPS or localhost.");
    assert.equal(await unsupported.evaluate(`document.querySelector('form button[type="submit"]').disabled`), true);
    await checked(cdp.send("Target.closeTarget", { targetId: unsupported.targetId }));
    await checked(cdp.send("Page.bringToFront", {}, p.sessionId));
    assert.equal(harness.workers.size, 0, "idle tabs started analysis workers");
    assert.equal(harness.requests.some(r => r.method !== "GET" || new URL(r.url).pathname.startsWith("/_code-city/")), false);
    assert.equal((await idle.snapshot()).status, "");
    assert.equal((await p.snapshot()).setup, true);
    assert.equal((await p.snapshot()).summary, false);
    assert.equal(await p.evaluate(`document.querySelector('[data-exclusions]').open`), false);
    assert.equal(await p.evaluate(`document.querySelector('textarea').checkVisibility()`), false);
    await p.click("[data-exclusions] > summary");
    assert.equal(await p.evaluate(`document.querySelector('textarea').checkVisibility()`), true);
    await p.click("[data-exclusions] > summary");
    assert.equal((await idleThird.snapshot()).status, "");
    await p.submit("invalid input");
    await p.wait(s => s.feedback === "Invalid input");
    assert.equal((await p.snapshot()).setup, true);
    assert.equal((await p.snapshot()).summary, false);
    assert.equal(harness.workers.size, 0);

    async function run(mode, predicate) {
      process.stdout.write(`Browser evidence: ${mode}\n`);
      const start = harness.events.length;
      harness.setMode(mode);
      await p.submit();
      const result = await p.wait(predicate);
      await checked(harness.waitFor(e => harness.events.indexOf(e) >= start && e.kind === "event" && ["ANALYSIS_SUCCEEDED", "ANALYSIS_ALL_FILES_FAILED", "ANALYSIS_FAILED"].includes(e.value.type)));
      process.stdout.write(`Browser evidence complete: ${mode}\n`);
      return { result, events: harness.events.slice(start), start };
    }
    let ordinary = await run("success", s => s.canvases === 1 && s.analyzed === 5 && s.controls);
    assert.equal(ordinary.result.commit, FIXTURE_REVISION);
    const success = ordinary.events.find(e => e.kind === "event" && e.value.type === "ANALYSIS_SUCCEEDED").value;
    assert.deepEqual(success.city.inspection.map(({ canonicalPath,S,U,M })=>({canonicalPath,S,U,M})), [
      {canonicalPath:"a.js",S:1,U:2,M:2}, {canonicalPath:"b.ts",S:1,U:1,M:1},
      {canonicalPath:"c.tsx",S:1,U:1,M:1}, {canonicalPath:"d.cs",S:1,U:1,M:1}, {canonicalPath:"empty.js",S:0,U:0,M:0},
    ]);
    process.stdout.write("Browser evidence: city-first workspace\n");
    assert.equal(ordinary.result.setup, false);
    assert.equal(ordinary.result.summary, true);
    assert.equal(ordinary.result.repository, REPOSITORY);
    assert.equal(ordinary.result.controls, true);
    assert.equal(ordinary.result.findOpen, false);
    assert.equal(await p.evaluate(`document.querySelector('[data-analyzed-rows] button').checkVisibility()`), false);
    assert.equal(await p.evaluate(`document.querySelector('[data-city-navigation]')`), null);
    assert.equal(await p.evaluate(`document.querySelector('[data-reanalyze], [data-actions]')`), null);
    const layout = await p.evaluate(`({top:document.querySelector('[data-city]').getBoundingClientRect().top,height:document.querySelector('[data-city]').getBoundingClientRect().height,viewport:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth})`);
    assert.ok(layout.top < 200 && layout.height > layout.viewport * 0.6, JSON.stringify(layout));
    assert.equal(layout.overflow, false);
    const initial = await p.evaluate(`({matrix:JSON.stringify(window.__render.matrices.at(-1)),uploads:window.__render.uploads})`);
    async function key(key, code, virtualKeyCode) {
      await checked(cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: virtualKeyCode, ...(key === "Enter" ? { text: "\r" } : {}) }, p.sessionId));
      await checked(cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: virtualKeyCode }, p.sessionId));
    }
    await p.evaluate(`document.querySelector('[data-analyzed] > summary').focus();true`);
    await key("Enter", "Enter", 13);
    assert.equal((await p.snapshot()).findOpen, true, "Enter did not open file navigation");
    assert.equal(await p.evaluate(`document.querySelector('[data-analyzed-rows] button').checkVisibility()`), true);
    await p.click("[data-analyzed-rows] button");
    assert.equal(await p.evaluate(`document.querySelector('[data-canonical-path]').textContent`), "a.js");
    process.stdout.write("Browser evidence: explicit unit source inspection\n");
    await p.wait(s => s.units === 2 || s.unitMessage.includes('unavailable'));
    assert.equal((await p.snapshot()).units, 2);
    assert.equal((await p.snapshot()).sourceOpen, false);
    const inspectionRequests = harness.requests.length;
    await p.evaluate(`document.querySelector('[data-unit-rows] button').focus();true`); await key('Enter','Enter',13);
    await p.wait(s => s.sourceReady && s.contributions === 1);
    assert.equal(await p.evaluate(`document.querySelector('[data-unit-details]').textContent.includes('Complexity 2')`),true);
    assert.equal(await p.evaluate(`[...document.querySelectorAll('[data-source-line] code')].map(row=>row.textContent).join('\\n')`), 'function choose(v) { return v ? 1 : 0; }');
    assert.ok(await p.evaluate(`document.querySelector('[data-contribution-rows]').textContent.includes('ternary')`));
    assert.equal(await p.evaluate(`document.querySelector('[data-unit-details]').textContent.startsWith('Function ·')`),true);
    assert.equal(await p.evaluate(`(()=>{const code=document.querySelector('[data-source-code]'),keyword=code.querySelector('[data-syntax-color="5"]'),number=code.querySelector('[data-syntax-color="2"]'),owned=code.querySelector('mark [data-syntax-color]');return keyword.textContent==='function'&&getComputedStyle(keyword).color!==getComputedStyle(number).color&&!!owned&&getComputedStyle(owned.closest('mark')).textDecorationLine.includes('underline');})()`),true);
    await p.evaluate(`document.querySelector('[data-source-code]').focus();true`); await key('ArrowRight','ArrowRight',39);
    assert.deepEqual(await p.evaluate(`({matrix:JSON.stringify(window.__render.matrices.at(-1)),uploads:window.__render.uploads})`), initial, 'source inspection moved the camera');
    await key('Escape','Escape',27); await p.wait(s=>!s.sourceOpen);
    assert.equal(await p.evaluate(`document.activeElement===document.querySelector('[data-unit-rows] button')`),true);
    assert.equal(harness.requests.length,inspectionRequests,'unit inspection made a network request');
    await p.evaluate(`(()=>{const q=document.querySelector('[data-analyzed-query]');q.value='b.ts';q.dispatchEvent(new Event('input'));return true;})()`);
    assert.equal(await p.evaluate(`document.querySelectorAll('[data-analyzed-rows] li').length`), 1);
    await p.evaluate(`(()=>{const q=document.querySelector('[data-analyzed-query]');q.value='';q.dispatchEvent(new Event('input'));const s=document.querySelector('[data-analyzed-sort]');s.value='M';s.dispatchEvent(new Event('change'));return true;})()`);
    assert.deepEqual(await p.evaluate(`({matrix:JSON.stringify(window.__render.matrices.at(-1)),uploads:window.__render.uploads})`), initial, "inventory changed camera or geometry uploads");
    await p.evaluate(`document.querySelector('[data-analyzed] > summary').focus();true`);
    await key("Enter", "Enter", 13);
    assert.equal((await p.snapshot()).findOpen, false, "Enter did not close file navigation");
    assert.equal(await p.evaluate(`document.querySelector('[data-analyzed-query]').value`), "");
    assert.equal(await p.evaluate(`document.querySelector('[data-analyzed-sort]').value`), "M");
    await p.evaluate(`document.querySelector('[data-city] canvas').focus();true`);
    await key("End", "End", 35);
    assert.equal(await p.evaluate(`document.querySelector('[data-canonical-path]').textContent`), "empty.js");
    assert.deepEqual(await p.evaluate(`({matrix:JSON.stringify(window.__render.matrices.at(-1)),uploads:window.__render.uploads})`), initial, "closed file navigation changed camera or geometry");
    process.stdout.write("Browser evidence: changing repository\n");
    const requestsBeforeEditing = harness.requests.length;
    await p.click("[data-change-repository]");
    assert.equal((await p.snapshot()).setup, true);
    assert.equal((await p.snapshot()).canvases, 1);
    assert.equal(await p.evaluate(`document.activeElement === document.querySelector('input[name=repository]')`), true);
    await p.evaluate(`document.querySelector('input[name=repository]').value='invalid unsent URL';document.querySelector('textarea').value='a.js';true`);
    await p.click("[data-change-repository]");
    assert.equal((await p.snapshot()).setup, false);
    assert.equal((await p.snapshot()).repository, REPOSITORY);
    assert.equal(harness.requests.length, requestsBeforeEditing, "opening/closing setup made network requests");
    await p.click("[data-change-repository]");
    await p.evaluate(`document.querySelector('input[name=repository]').value=${JSON.stringify(REPOSITORY)};document.querySelector('form').requestSubmit();true`);
    const changed = await p.wait(s => s.canvases === 1 || s.feedback !== "");
    assert.equal(changed.feedback, "");
    assert.equal(changed.analyzed, 4, "Analyze did not apply the edited exclusions");
    assert.equal(changed.repository, REPOSITORY);
    assert.equal(changed.setup, false);
    assert.equal(changed.findOpen, false);
    assert.equal(await p.evaluate(`document.querySelector('[data-analyzed-sort]').value`), "S");
    process.stdout.write("Browser evidence: narrow workspace\n");
    await checked(cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }, p.sessionId));
    assert.equal(await p.evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(document.documentElement.scrollWidth<=innerWidth&&document.querySelector('[data-city]').getBoundingClientRect().width>0))))`), true, "mobile workspace overflowed");
    await checked(cdp.send("Emulation.setDeviceMetricsOverride", { width: 1365, height: 900, deviceScaleFactor: 1, mobile: false }, p.sessionId));
    harness.setMode("success");
    await idle.submit();
    await idle.wait(s => s.canvases === 1 && s.analyzed === 5);
    assert.equal((await p.snapshot()).canvases, 1, "one tab blocked or evicted another investigation");
    await p.click("[data-change-repository]");
    assert.equal((await p.snapshot()).setup, true);
    assert.equal((await p.snapshot()).canvases, 1);
    assert.equal((await idle.snapshot()).canvases, 1);

    await p.evaluate(`window.__render.capturePixels=true;window.__render.captureContrast=true;true`);
    const districts = await run("districts", s => s.canvases === 1 && s.analyzed === 5);
    const contrast = await p.evaluate(`window.__render.frames.at(-1).contrast`);
    assert.ok(contrast.base > 0 && contrast.lower > 0 && contrast.upper > 0 && contrast.edge > 0, `Base, nested platform fills and boundaries must all remain visible: ${JSON.stringify(contrast)}`);
    await p.evaluate(`window.__render.captureContrast=false;true`);
    const districtCity = districts.events.find(e => e.kind === "event" && e.value.type === "ANALYSIS_SUCCEEDED").value.city;
    const dimensions = await p.evaluate(`(()=>{const c=document.querySelector('[data-city] canvas'),r=c.getBoundingClientRect();return {width:c.width,height:c.height,rectangle:{left:r.left,top:r.top,width:r.width,height:r.height}};})()`);
    const camera = resetCamera(districtCity.presentation.sceneBounds, dimensions);
    assert.equal(camera.kind, "success");
    const geometry = { count: districtCity.geometry.count, origins: Float32Array.from(districtCity.geometry.origins), sizes: Float32Array.from(districtCity.geometry.sizes) };
    const plates = { count: districtCity.presentation.plates.length,
      origins: Float32Array.from(districtCity.presentation.plates.flatMap(plate => plate.minimum)),
      sizes: Float32Array.from(districtCity.presentation.plates.flatMap(plate => plate.dimensions)) };
    const wantedDistrict = districtCity.districts.findIndex(value => !value.root && value.identity === "src/edge");
    let platformPoint, buildingPoint;
    for (let y = 0; y < dimensions.height && (!platformPoint || !buildingPoint); y += 2) for (let x = 0; x < dimensions.width; x += 2) {
      const clientX = dimensions.rectangle.left + x, clientY = dimensions.rectangle.top + y;
      const building = pickAtCanvasPoint(camera.view, clientX, clientY, dimensions.rectangle, dimensions, geometry);
      const plate = pickAtCanvasPoint(camera.view, clientX, clientY, dimensions.rectangle, dimensions, plates);
      assert.equal(building.kind, "success"); assert.equal(plate.kind, "success");
      if (plate.index === wantedDistrict && (building.tEnter === null || plate.tEnter < building.tEnter)) platformPoint ??= { x: clientX, y: clientY };
      if (building.index !== null && (plate.tEnter === null || building.tEnter <= plate.tEnter)) buildingPoint ??= { x: clientX, y: clientY, index: building.index };
    }
    assert.ok(platformPoint && buildingPoint, "fixture has no visible platform/building hit");
    const beforeDistrict = await p.evaluate(`({matrix:JSON.stringify(window.__render.matrices.at(-1)),uploads:window.__render.uploads,hash:window.__render.frames.at(-1).hash})`);
    async function pointer(point) {
      await checked(cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y }, p.sessionId));
      await checked(cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 }, p.sessionId));
      await checked(cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 }, p.sessionId));
    }
    await pointer(platformPoint);
    await p.wait(s => s.district === "src/edge");
    assert.deepEqual(await p.evaluate(`['data-file-count','data-source-lines','data-executable-units','data-maximum-complexity'].map(name=>document.querySelector('['+name+']').textContent)`), ["3", "3", "4", "2"]);
    const afterDistrict = await p.evaluate(`({matrix:JSON.stringify(window.__render.matrices.at(-1)),uploads:window.__render.uploads,hash:window.__render.frames.at(-1).hash,selected:window.__render.integers.u_selectionIndex})`);
    assert.equal(afterDistrict.matrix, beforeDistrict.matrix); assert.equal(afterDistrict.uploads, beforeDistrict.uploads);
    assert.equal(afterDistrict.selected, -wantedDistrict - 2);
    assert.notEqual(afterDistrict.hash, beforeDistrict.hash, "district did not change actual rendered pixels");
    const hierarchyRequests = harness.requests.length;
    await p.evaluate(`(()=>{const input=document.querySelector('[data-analyzed-query]');input.value='not-a-file';input.dispatchEvent(new Event('input'));document.querySelector('[data-district-rows="directories"] button').focus();return true;})()`);
    await key('Enter','Enter',13); await p.wait(s=>s.district==='src/edge/deep');
    assert.equal(await p.evaluate(`document.querySelector('[data-file-count]').textContent`),'1');
    await p.evaluate(`document.querySelector('[data-district-rows="files"] button').focus();true`); await key('Enter','Enter',13);
    await p.wait(s=>s.selectedFile==='src/edge/deep/b.ts');
    assert.equal((await p.snapshot()).sourceOpen,false,'hierarchy file activation opened source automatically');
    await p.evaluate(`window.__render.captureContrast=true;true`);
    await p.click('[data-browse-directories]'); await p.wait(s=>s.district==='/');
    const rootContrast = await p.evaluate(`window.__render.frames.at(-1).contrast`);
    assert.ok(rootContrast.base > 0 && rootContrast.lower > 0 && rootContrast.upper > 0 && rootContrast.edge > 0 && rootContrast.selected > 0, `Root selection must preserve fill contrast and brighten only its boundary: ${JSON.stringify(rootContrast)}`);
    await p.evaluate(`window.__render.captureContrast=false;true`);
    assert.equal(await p.evaluate(`document.querySelector('[data-file-count]').textContent`),'5');
    for (const path of ['src','src/edge']) {
      await p.evaluate(`[...document.querySelectorAll('[data-district-rows="directories"] button')].find(button=>button.querySelector('bdi').textContent===${JSON.stringify(path)}).click();true`);
      assert.equal((await p.snapshot()).district,path);
    }
    await p.evaluate(`(()=>{const input=document.querySelector('[data-analyzed-query]');input.value='';input.dispatchEvent(new Event('input'));return true;})()`);
    assert.equal(harness.requests.length,hierarchyRequests,'directory drill-down made a request');
    assert.deepEqual(await p.evaluate(`({matrix:JSON.stringify(window.__render.matrices.at(-1)),uploads:window.__render.uploads})`),{matrix:beforeDistrict.matrix,uploads:beforeDistrict.uploads},'directory drill-down changed camera or geometry');
    await p.evaluate(`document.querySelector('[data-city] canvas').focus();true`); await key("Escape", "Escape", 27);
    assert.equal((await p.snapshot()).district, null);
    assert.equal(await p.evaluate(`window.__render.frames.at(-1).hash`), beforeDistrict.hash, "clear did not restore the scene");
    await pointer(buildingPoint);
    await p.wait(s => s.selectedFile !== null);
    assert.equal((await p.snapshot()).selectedFile, districtCity.inspection[buildingPoint.index].canonicalPath);
    assert.equal(await p.evaluate(`document.querySelector('[data-canonical-path]').parentElement.tagName`), "H2");
    assert.equal(await p.evaluate(`!!document.querySelector('[data-inspector-identity],[data-metric-dimensions],[data-selected-rgba],[data-dimension-policy]')`), false);
    await p.evaluate(`document.querySelector('[data-select-district]').focus();true`); await key("Enter", "Enter", 13);
    await p.wait(s => s.district !== null);
    assert.equal((await p.snapshot()).selectedFile, null);
    await p.evaluate(`window.__render.capturePixels=false;true`);
    await checked(cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }, p.sessionId));
    assert.equal(await p.evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>{const panel=document.querySelector('[data-inspector]'),last=panel.querySelector('dl > div:last-child');resolve(document.documentElement.scrollWidth<=innerWidth&&last.getBoundingClientRect().bottom<=panel.getBoundingClientRect().bottom);})))`), true, "mobile district metrics were clipped or overflowed");
    await checked(cdp.send("Emulation.setDeviceMetricsOverride", { width: 1365, height: 900, deviceScaleFactor: 1, mobile: false }, p.sessionId));

    process.stdout.write("Browser evidence: explicit Save and project/ref picker\n");
    async function saveCurrent() {
      await p.click("[data-save]");
      const saved = await p.wait(s => s.saved || s.saveMessage.includes("unchanged"));
      assert.ok(saved.saved, saved.saveMessage);
      return p.evaluate("location.href");
    }
    const savedDistrictFingerprint = await p.evaluate("window.__cityFingerprint");
    const savedDistrictUrl = await saveCurrent();
    for (const url of ["https://github.com/fixture/another", REPOSITORY + "/tree/feature/save", REPOSITORY + "/releases/tag/v1.0"]) {
      harness.setMode("success"); await p.submit(url); await p.wait(s => s.canvases === 1 && s.analyzed === 5 && !s.saved); await saveCurrent();
    }
    const beforePicker = harness.requests.length;
    await p.click("[data-open-saved]");
    await p.evaluate("new Promise(resolve=>{const check=()=>{if(document.querySelectorAll('[data-saved-projects] details').length===2){observer.disconnect();resolve();}};const observer=new MutationObserver(check);observer.observe(document.querySelector('[data-saved-projects]'),{subtree:true,childList:true});check();})");
    assert.equal(await p.evaluate("document.querySelectorAll('[data-saved-projects] button').length"), 4);
    assert.ok(await p.evaluate("document.querySelector('[data-saved-projects]').textContent.includes('feature/save')&&document.querySelector('[data-saved-projects]').textContent.includes('tag: v1.0')"));
    harness.setMode("no-provider");
    await p.evaluate("[...document.querySelectorAll('[data-saved-projects] button')].find(button=>button.textContent.includes('default branch')&&button.closest('details').querySelector('summary bdi').textContent==='fixture/standalone').click();true");
    await p.wait(s => s.canvases === 1 && s.analyzed === 5 && s.saved);
    assert.ok(await p.evaluate("window.__cityFingerprint") === savedDistrictFingerprint, "Saved city/metrics were not restored exactly");
    assert.ok(harness.requests.slice(beforePicker).every(item => new URL(item.url).origin === origin && !new URL(item.url).pathname.startsWith('/parser/')));
    assert.equal(await p.evaluate("location.href"), savedDistrictUrl);
    const beforeSavedInspection = harness.requests.length;
    await p.evaluate(`[...document.querySelectorAll('[data-analyzed-rows] button')].find(button=>button.querySelector('bdi').textContent==='src/edge/a.js').click();true`);
    await p.wait(s=>s.units===2); await p.click('[data-unit-rows] button'); await p.wait(s=>s.sourceReady&&s.contributions===1);
    assert.ok(await p.evaluate(`document.querySelector('[data-source-code]').textContent.includes('function choose')`));
    assert.equal(await p.evaluate(`document.querySelector('[data-source-code] [data-syntax-color="5"]').textContent`),'function');
    await p.closeSource(); assert.equal(harness.requests.length,beforeSavedInspection,'saved inspection reacquired source');

    await run("mixed", s => s.canvases === 1 && s.analyzed === 5 && s.failed === 2);
    assert.equal((await p.snapshot()).failuresOpen, false);
    assert.equal(await p.evaluate(`document.querySelector('[data-failed-summary]').textContent`), "2 files not analyzed");
    assert.equal(await p.evaluate(`document.querySelector('[data-failed-rows] li').checkVisibility()`), false);
    await p.click("[data-failed] > summary");
    assert.equal(await p.evaluate(`document.querySelector('[data-failed-rows] li').checkVisibility()`), true);
    await run("all-failed", s => s.canvases === 0 && s.failed === 2 && s.controls);
    assert.equal((await p.snapshot()).failuresOpen, false);
    assert.equal((await p.snapshot()).findOpen, null);
    assert.equal((await p.snapshot()).status, "No files could be analyzed.");
    for (const mode of ["integrity", "cors-failure"]) {
      await run(mode, s => s.status === "Provider/resolution failure" && s.canvases === 0);
    }
    for (const mode of ["too-many", "file-limit", "raw-limit", "total-limit"]) {
      const outcome = await run(mode, s => s.status === "Repository exceeds Code City limits" && s.canvases === 0);
      if (mode === "too-many") assert.equal(outcome.events.filter(e => e.kind === "raw").length, 0);
    }

    process.stdout.write("Browser evidence: bounded window\n");
    let start = harness.events.length;
    harness.setMode("window"); await p.submit();
    const held = await checked(harness.waitFor(e => harness.events.indexOf(e) >= start && e.kind === "raw-held"));
    await checked(harness.waitFor(e => e.kind === "raw" && e.sessionId === held.sessionId && harness.events.filter(r => r.kind === "raw" && r.sessionId === held.sessionId).length === 8));
    const zero = await p.wait(s => s.progress?.determinate && s.progress.value === 0 && s.progress.max === 27);
    assert.ok(zero.status.includes("Acquiring files 0 of 12"));
    assert.equal(zero.setup, false);
    assert.equal(zero.summary, true);
    assert.equal(zero.controls, false);
    assert.equal(zero.repository, REPOSITORY);
    assert.equal(harness.events.filter(e => e.kind === "raw" && e.sessionId === held.sessionId).length, 8);
    assert.equal((await checked(request(origin, "/"))).status, 200);
    await checked(harness.release(held.sessionId));
    await p.wait(s => s.canvases === 1 && s.analyzed === 12);

    process.stdout.write("Browser evidence: progress barriers\n");
    const progressStart = await p.evaluate(`window.__render.progress.length`);
    start = harness.events.length;
    await p.evaluate(`window.__gate={active:true,opened:false,queue:[]};true`);
    harness.setMode("progress"); await p.submit();
    await checked(harness.waitFor(e => harness.events.indexOf(e) >= start && e.kind === "event" && e.value.stage === "analysis" && e.value.completed === 1));
    await checked(harness.waitFor(e => harness.events.indexOf(e) >= start && e.kind === "delivery-held" && e.sessionId === p.sessionId && e.value.stage === "analysis" && e.value.completed === 1));
    await p.wait(s => s.progress?.value === 5 && s.progress.max === 9 && s.status.includes("Analyzing files 0 of 2"));
    await p.evaluate(`window.__drainProgress(1);true`);
    await p.wait(s => s.progress?.value === 6 && s.progress.max === 9);
    await p.evaluate(`window.__drainProgress(null);true`);
    await p.wait(s => s.canvases === 1 && s.analyzed === 2 && s.failed === 1);
    const singleProgress = await p.evaluate(`window.__render.progress.slice(${progressStart})`);
    assert.equal(new Set(singleProgress.map(value => value.id)).size, 1, "phases replaced the progress bar");
    assert.ok(singleProgress.every((value, index) => value.max === 9 && (index === 0 || value.value >= singleProgress[index - 1].value)));
    assert.equal(singleProgress.at(-1).value, 9);
    assert.equal(singleProgress.at(-1).ready, true, "progress completed before the city was ready");

    harness.setMode("busy"); await p.submit();
    await p.wait(s => s.status.includes("Analyzing files") && s.progress?.max === 19);
    assert.equal(await p.evaluate(`new Promise(resolve=>requestAnimationFrame(()=>resolve(true)))`), true, "worker analysis blocked the UI thread");
    await p.click("[data-status] button");
    await p.wait(s => s.status === "Cancelled" && s.progress === null);

    process.stdout.write("Browser evidence: cancellation\n");
    for (const mode of ["revision-held", "raw-held", "parser-held"]) {
      start = harness.events.length;
      harness.setMode(mode === "raw-held" ? "window" : mode); await p.submit();
      const barrier = await checked(harness.waitFor(e => harness.events.indexOf(e) >= start && e.kind === mode));
      await p.click("[data-status] button");
      await p.wait(s => s.status === "Cancelled" && s.canvases === 0 && s.progress === null);
      await checked(harness.waitFor(e => e.kind === "detached" && e.sessionId === barrier.sessionId));
    }
    start = harness.events.length;
    harness.setMode("revision-held"); await p.submit();
    const old = await checked(harness.waitFor(e => harness.events.indexOf(e) >= start && e.kind === "revision-held"));
    harness.setMode("success"); await p.submit();
    await p.wait(s => s.canvases === 1 && s.analyzed === 5);
    await checked(harness.waitFor(e => e.kind === "detached" && e.sessionId === old.sessionId));

    const departing = await page();
    start = harness.events.length;
    harness.setMode("revision-held"); await departing.submit();
    const departingWorker = await checked(harness.waitFor(e => harness.events.indexOf(e) >= start && e.kind === "revision-held"));
    await checked(cdp.send("Page.navigate", { url: "about:blank" }, departing.sessionId));
    await checked(harness.waitFor(e => e.kind === "detached" && e.sessionId === departingWorker.sessionId));
    await checked(cdp.send("Target.closeTarget", { targetId: departing.targetId }));
    await checked(cdp.send("Page.bringToFront", {}, p.sessionId));
    assert.equal((await idle.snapshot()).canvases, 1);

    const unitEvidence = await run('unit-evidence',s=>s.canvases===1&&s.analyzed===4);
    const beforeEvidenceRequests=harness.requests.length;
    async function chooseFile(path) { await p.evaluate(`[...document.querySelectorAll('[data-analyzed-rows] button')].find(button=>button.querySelector('bdi').textContent===${JSON.stringify(path)}).click();true`); }
    process.stdout.write('Browser evidence: unit-evidence parent unit\n');
    await chooseFile('a.js'); await p.wait(s=>s.units===3||s.unitMessage.includes('unavailable')); assert.equal((await p.snapshot()).units,3);
    assert.deepEqual(await p.evaluate(`[...document.querySelectorAll('[data-unit-complexity]')].map(row=>row.textContent)`),['Complexity 3','Complexity 2','Complexity 1']);
    await p.click('[data-unit-rows] button'); await p.wait(s=>s.sourceReady&&s.contributions===2);
    assert.equal(await p.evaluate(`document.querySelector('[data-contribution-rows]').textContent.includes('ternary')`),false,'nested contribution leaked into parent');
    await p.closeSource();
    process.stdout.write('Browser evidence: unit-evidence nested unit\n');
    await p.evaluate(`document.querySelectorAll('[data-unit-rows] button')[1].click();true`); await p.wait(s=>s.sourceReady&&s.contributions===1);
    assert.equal(await p.evaluate(`document.querySelector('[data-unit-details]').textContent.startsWith('Arrow function ·')`),true);
    assert.equal(await p.evaluate(`[...document.querySelectorAll('[data-source-line] code')].map(row=>row.textContent).join('\\n')`),'y => y ? 1 : 0');
    await p.closeSource();
    process.stdout.write('Browser evidence: unit-evidence top-level\n');
    await p.evaluate(`document.querySelectorAll('[data-unit-rows] button')[2].click();true`); await p.wait(s=>s.sourceReady);
    assert.equal(await p.evaluate(`document.querySelectorAll('[data-source-code] img,[data-source-code] script').length`),0);
    assert.ok(await p.evaluate(`document.querySelector('[data-source-code]').textContent.includes('<img src=x onerror=')`));
    assert.equal(await p.evaluate(`globalThis.__sourceExecuted===undefined`),true);
    await checked(cdp.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true},p.sessionId));
    assert.ok(await p.evaluate(`document.querySelector('[data-unit-source]').getBoundingClientRect().width<=innerWidth&&document.documentElement.scrollWidth<=innerWidth`));
    await p.closeSource();
    process.stdout.write('Browser evidence: unit-evidence unit pages\n');
    await checked(cdp.send('Emulation.setDeviceMetricsOverride',{width:1365,height:900,deviceScaleFactor:1,mobile:false},p.sessionId));
    await chooseFile('b.js');
    await p.wait(s=>s.units===32); await p.click('[data-unit-paging] button:last-child'); await p.wait(s=>s.units===9);
    process.stdout.write('Browser evidence: unit-evidence dense source pages\n');
    await chooseFile('dense.js'); await p.wait(s=>s.units===1); await p.click('[data-unit-rows] button'); await p.wait(s=>s.sourceReady&&s.contributions===32);
    const firstSourceRange=await p.evaluate(`document.querySelector('[data-source-range]').textContent`);
    await p.click('[data-source-paging] button:last-child');
    await p.evaluate(`new Promise(resolve=>{let observer;const check=()=>{if(document.querySelector('[data-source-range]').textContent!==${JSON.stringify(firstSourceRange)}){observer?.disconnect();resolve(true);}};observer=new MutationObserver(check);observer.observe(document.querySelector('[data-source-range]'),{subtree:true,childList:true,characterData:true});check();})`);
    await p.closeSource();
    process.stdout.write('Browser evidence: source-scoped contributions and explicit location jump\n');
    await chooseFile('long.js'); await p.wait(s=>s.units===2); await p.click('[data-unit-rows] button');
    await p.wait(s=>s.sourceReady&&s.contributionMessage.includes('0 of 27'));
    assert.equal(await p.evaluate(`document.querySelector('[data-source-line-number]').textContent`),'660');
    assert.ok(await p.evaluate(`document.querySelector('[data-unit-details]').textContent.includes('Complexity 28 (whole unit)')`));
    await p.evaluate(`(()=>{const select=document.querySelector('[data-contribution-scope]');select.value='unit';select.dispatchEvent(new Event('change'));return true;})()`);
    await p.wait(s=>s.contributions===27); await p.evaluate(`document.querySelector('[data-contribution-rows] button').focus();true`); await key('Enter','Enter',13);
    await p.wait(s=>s.sourceReady&&s.contributions>0&&s.contributions<27);
    assert.equal(await p.evaluate(`document.querySelector('[data-source-line-number]').textContent`),'975');
    assert.equal(await p.evaluate(`document.querySelector('[data-contribution-scope]').value`),'shown');
    assert.equal(await p.evaluate(`document.activeElement===document.querySelector('[data-source-code]')`),true);
    assert.equal(await p.evaluate(`document.querySelector('[data-source-line] code').textContent.startsWith('if(x)')`),true);
    await p.evaluate(`document.querySelector('[data-source-paging] button:first-child').focus();true`); await key('Enter','Enter',13);
    await p.wait(s=>s.sourceReady&&s.contributionMessage.includes('0 of 27'));
    assert.equal(await p.evaluate(`document.querySelector('[data-source-line-number]').textContent`),'660');
    await p.closeSource(); assert.equal(harness.requests.length,beforeEvidenceRequests,'inspection contacted provider/host');

    const maximum = await run("maximum", s => s.canvases === 1 && s.analyzed === 4000 && s.controls && s.progress === null);
    const final = maximum.events.find(e => e.kind === "event" && e.value.type === "ANALYSIS_SUCCEEDED").value;
    assert.equal(final.city.inspection.length, 4000);
    assert.ok(final.city.inspection.every(f => f.S === 0 && f.U === 0 && f.M === 0));
    const acquisition = maximum.events.filter(e => e.kind === "event" && e.value.type === "ANALYSIS_PROGRESS" && e.value.stage === "acquisition").map(e => e.value);
    const analysis = maximum.events.filter(e => e.kind === "event" && e.value.type === "ANALYSIS_PROGRESS" && e.value.stage === "analysis").map(e => e.value);
    assert.equal(acquisition.length, 4001); assert.equal(analysis.length, 4001);
    acquisition.forEach((e, i) => { assert.equal(e.completed, i); assert.equal(e.total, 4000); });
    analysis.forEach((e, i) => { assert.equal(e.completed, i); assert.equal(e.total, 4000); });
    assert.equal((await idle.snapshot()).canvases, 1);
    await p.evaluate(`window.__render.capturePixels=true;document.querySelector('[data-city] canvas').focus();true`);
    await key("Home", "Home", 36); await key("Escape", "Escape", 27);
    const maximumPixels = await p.evaluate(`window.__render.frames.at(-1).hash`);
    const maximumFrame = await p.evaluate(`({matrix:JSON.stringify(window.__render.matrices.at(-1)),uploads:window.__render.uploads})`);
    await p.evaluate(`document.querySelector('[data-city] canvas').focus();true`); await key("Home", "Home", 36);
    await p.evaluate(`document.querySelector('[data-select-district]').focus();true`); await key("Enter", "Enter", 13);
    assert.equal((await p.snapshot()).district, "matrix-0000/src");
    assert.equal(final.city.presentation.plates.length, 8001, 'full recursive hierarchy was not retained');
    assert.deepEqual(await p.evaluate(`['data-file-count','data-source-lines','data-executable-units','data-maximum-complexity'].map(name=>document.querySelector('['+name+']').textContent)`), ["1", "0", "0", "0"]);
    await p.click('[data-district-navigation] > button:first-child'); await p.wait(s=>s.district==='/');
    assert.notEqual(await p.evaluate(`window.__render.frames.at(-1).hash`), maximumPixels, "maximum-envelope district did not highlight");
    await p.evaluate(`window.__render.capturePixels=false;true`);
    assert.deepEqual(await p.evaluate(`['data-file-count','data-source-lines','data-executable-units','data-maximum-complexity'].map(name=>document.querySelector('['+name+']').textContent)`), ["4000", "0", "0", "0"]);
    assert.deepEqual(await p.evaluate(`({matrix:JSON.stringify(window.__render.matrices.at(-1)),uploads:window.__render.uploads})`), maximumFrame);
    const progressHistory = await p.evaluate(`window.__render.progress`);
    const previous = new Map();
    for (const value of progressHistory) {
      const prior = previous.get(value.id);
      assert.ok(!prior || (prior.max === value.max && prior.value <= value.value), "bar reset or changed its budget");
      assert.ok(value.value < value.max || value.ready, "bar reached completion before presentation");
      previous.set(value.id, value);
    }
    process.stdout.write("Browser evidence: maximum snapshot Save and failed-write isolation\n");
    // A failed explicit Save must leave the completed maximum-sized scene usable.
    const maximumFingerprint = await p.evaluate("window.__cityFingerprint");
    await mkdir(path.join(dataDirectory, "write-lock"));
    await p.click("[data-save]");
    await p.wait(s => s.saveMessage.includes("unchanged"));
    process.stdout.write("Browser evidence: maximum failed Save preserved scene\n");
    assert.equal((await p.snapshot()).analyzed, 4000); assert.equal((await p.snapshot()).canvases, 1);
    assert.ok(await p.evaluate("window.__cityFingerprint") === maximumFingerprint);
    await rm(path.join(dataDirectory, "write-lock"), { recursive: true });
    const maximumSavedUrl = await saveCurrent();
    process.stdout.write("Browser evidence: maximum Save completed\n");
    await checked(cdp.send("Page.navigate", { url: "about:blank" }, p.sessionId));
    const maximumWorker = maximum.events.find(e => e.kind === "worker");
    await checked(harness.waitFor(e => e.kind === "detached" && e.sessionId === maximumWorker.sessionId));
    for (const target of ["/_code-city/session", "/_code-city/analyze", "/_code-city/cancel", "/_code-city/discard", "/package-manifest.json", "/server/standalone.mjs"]) {
      const response = await checked(request(origin, target, { method: target.startsWith("/_code-city/") ? "POST" : "GET", headers: { Origin: origin, "Content-Type": "application/json" }, body: target.startsWith("/_code-city/") ? "{}" : undefined }));
      assert.equal(response.status, 404); assert.equal(response.body.length, 0);
    }
    process.stdout.write("Browser evidence: restart and fresh-context reopen without provider/parser\n");
    sendGracefulSignal(processUnderTest, "SIGTERM"); await checked(expectCleanExit(processUnderTest));
    processUnderTest = launchStandalone({ preload, serverArguments: ["--port", new URL(origin).port, "--data-dir", dataDirectory] });
    assert.equal(await checked(readyOrigin(processUnderTest)), origin);
    const restoreStart = harness.requests.length;
    harness.setMode("no-provider");
    const { browserContextId } = await checked(cdp.send("Target.createBrowserContext"));
    const reopened = await page({ url: maximumSavedUrl, browserContextId });
    await reopened.wait(s => s.canvases === 1 && s.analyzed === 4000 && s.saved);
    assert.ok(await reopened.evaluate("window.__cityFingerprint") === maximumFingerprint, "Restart/fresh-context restoration changed the saved city or metrics");
    assert.ok(harness.requests.slice(restoreStart).every(item => new URL(item.url).origin === origin && !new URL(item.url).pathname.startsWith('/parser/')), "Reopen acquired or parsed source");
    await checked(cdp.send("Target.closeTarget", { targetId: reopened.targetId }));
    await checked(cdp.send("Target.disposeBrowserContext", { browserContextId }));
    for (const item of harness.requests) {
      const url = new URL(item.url);
      assert.ok([origin,"https://api.github.com","https://raw.githubusercontent.com"].includes(url.origin));
      assert.ok(["GET", "OPTIONS"].includes(item.method) || (item.method === "POST" && url.origin === origin && url.pathname === "/api/investigations"));
      assert.equal(url.pathname.startsWith("/_code-city/"), false);
      if (url.origin !== origin) {
        assert.equal(item.worker, true);
        assert.equal(Object.keys(item.headers).some(name => ["authorization", "cookie", "referer"].includes(name.toLowerCase())), false, "Provider request leaked credentials or referrer");
        if (item.method === "GET") assert.ok(harness.workers.get(item.sessionId)?.networkUrls.has(item.url), "Provider GET did not originate from the actual worker network context");
      }
    }
    assert.equal(exceptions.length, 0, exceptions.join("; "));
    sendGracefulSignal(processUnderTest, "SIGTERM");
    assert.equal(await checked(processUnderTest.waitLine(line => line === "SHUTDOWN")), "SHUTDOWN");
    await checked(expectCleanExit(processUnderTest));
    assert.equal((await idle.snapshot()).canvases, 1, "static-host shutdown discarded a browser-owned completed view");
    process.stdout.write(JSON.stringify({
      chrome: { category: discovery.category, version },
      scenarios: ["idle-three-tabs-no-server-sessions", "missing-WebCrypto-clear-failure", "invalid-before-worker", "four-grammar-success", "city-primary-collapsed-setup", "keyboard-file-disclosure", "edited-input-analysis", "selectable-districts-and-exact-summaries", "visible-neutral-nested-platform-fills-and-edges", "single-monotonic-progress", "mobile-no-overflow", "collapsed-failure-count", "inventory-selection-no-camera-movement", "independent-retained-tabs", "mixed", "all-files-failed", "blob-integrity", "CORS-rejection", "4001-preflight", "per-file-limit", "raw-limit", "total-limit", "eight-slot-slow-first", "measured-progress-barriers", "UI-responsive-during-analysis", "provider-cancel", "parser-cancel", "replacement", "4000-files-40MiB", "unit-source-and-owned-contributions", "syntax-colors-distinct-from-ownership-underlines", "readable-unit-kind-labels", "nested-units-unicode-inert-source", "bounded-unit-source-contribution-pages", "shown-source-contribution-scope-and-location-jump", "saved-source-without-provider-or-parser", "explicit-save", "multiple-project-branch-release-picker", "failed-save-preserves-scene", "maximum-snapshot-restart-fresh-context-no-provider-no-parser", "pagehide", "removed-analysis-routes", "exact-network-allowlist"],
      requests: harness.requests.length, workerEvents: harness.events.filter(e=>e.kind==='event').length,
      publicFiles: manifest.files.filter(f=>f.role==='public').map(f=>f.path),
    }) + "\n");
  } finally {
    clearTimeout(timer);
    harness?.close();
    let profileStopped = !chromeLaunchAttempted;
    try {
      await closeInstalledChrome(chrome, cdp);
      if (chrome) profileStopped = true;
    } finally {
      if (processUnderTest) await terminateForCleanup(processUnderTest);
      if (temporary && profileStopped) await rm(temporary, { recursive: true, force: true });
      else if (temporary) process.stderr.write(`Chrome shutdown was not proven clean; temporary evidence retained at ${temporary}\n`);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await checkStandaloneBrowser();
