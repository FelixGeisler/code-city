import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { auditStandaloneArtifact } from "./standalone-manifest.mjs";
import { canonicalStandaloneRoot } from "./build-standalone.mjs";
import { connectCdp, discoverInstalledChrome, launchInstalledChrome, readInstalledChromeVersion } from "./chrome-cdp.mjs";
import {
  expectCleanExit,
  launchStandalone,
  openSession,
  readyOrigin,
  request,
  sendGracefulSignal,
  terminateForCleanup,
  writeSignalPreload,
} from "./standalone-check-support.mjs";
import { writeStandaloneBrowserProviderHarness } from "./standalone-browser-provider-harness.mjs";

const WATCHDOG_MS = 600_000;
const REPOSITORY = "https://github.com/fixture/standalone";
const CAPACITY = [
  "--port", "0",
  "--max-live-sessions", "2",
  "--max-active-attempts", "1",
  "--max-command-body-readers", "2",
  "--max-command-body-bytes", "4096",
  "--max-retained-source-bytes", "41943040",
];
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

async function setMode(harness, mode) {
  await writeFile(harness.control, `${JSON.stringify({ mode })}\n`, "utf8");
}

async function logRows(harness) {
  const text = await readFile(harness.log, "utf8");
  return text.trim() ? text.trim().split("\n").map((line) => JSON.parse(line)) : [];
}

async function waitForLog(harness, start, predicate, label, milliseconds = 120_000) {
  const end = Date.now() + milliseconds;
  while (Date.now() < end) {
    const rows = (await logRows(harness)).slice(start);
    if (predicate(rows)) return rows;
    await sleep(20);
  }
  throw new Error(`Timed out waiting for provider evidence: ${label}`);
}

function holdBodyReader(origin) {
  const url = new URL(origin);
  const socket = net.createConnection({ host: "127.0.0.1", port: Number(url.port) });
  const ready = new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.once("connect", () => {
      const body = JSON.stringify({ sessionId: "A".repeat(43), generation: 1 });
      socket.write(`POST /_code-city/cancel HTTP/1.1\r\nHost: ${url.host}\r\nOrigin: ${origin}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body.slice(0, 1)}`);
      resolve();
    });
  });
  return { socket, ready };
}

function openPausedSession(origin) {
  return new Promise((resolve, reject) => {
    const client = new URL(origin);
    const requestSocket = net.createConnection({ host: "127.0.0.1", port: Number(client.port) });
    let text = "";
    requestSocket.once("error", reject);
    requestSocket.once("connect", () => requestSocket.write(`POST /_code-city/session HTTP/1.1\r\nHost: ${client.host}\r\nOrigin: ${origin}\r\nContent-Length: 0\r\n\r\n`));
    requestSocket.on("data", (chunk) => {
      text += chunk.toString("utf8");
      const match = /\r\n\r\n[0-9a-f]+\r\n(\{[^\n]+\})\n/iu.exec(text);
      if (!match) return;
      let event;
      try { event = JSON.parse(match[1]); } catch (error) { reject(error); return; }
      requestSocket.pause();
      resolve({ socket: requestSocket, sessionId: event.sessionId });
    });
  });
}

async function command(origin, target, value) {
  return request(origin, target, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
}

async function openSessionEventually(origin) {
  let lastError;
  for (let index = 0; index < 100; index += 1) {
    try { return await openSession(origin); }
    catch (error) { lastError = error; await sleep(20); }
  }
  throw lastError;
}

async function probeTwoSessions(origin) {
  const first = await openSessionEventually(origin);
  const second = await openSessionEventually(origin);
  first.response.destroy();
  second.response.destroy();
}

export async function checkStandaloneBrowser() {
  const manifest = await auditStandaloneArtifact(canonicalStandaloneRoot);
  const publicPaths = manifest.files.filter(({ role }) => role === "public").map(({ path: filePath }) => filePath);
  assert.deepEqual(publicPaths, ["public/browser.css", "public/browser.js", "public/index.html"]);
  const packagedHtml = await readFile(path.join(canonicalStandaloneRoot, "public", "index.html"), "utf8");
  assert.equal(packagedHtml.includes("/src/edge/standalone-browser-main.ts"), false);
  assert.equal(packagedHtml.match(/href="\/browser\.css"/gu)?.length, 1);
  assert.equal(packagedHtml.match(/src="\/browser\.js"/gu)?.length, 1);

  const temporary = await mkdtemp(path.join(os.tmpdir(), "code-city-standalone-browser-"));
  const profile = path.join(temporary, "chrome-profile");
  const harness = await writeStandaloneBrowserProviderHarness(path.join(temporary, "provider"));
  const preload = await writeSignalPreload(path.join(temporary, "preload"), harness.preload);
  let processUnderTest;
  let chrome;
  let cdp;
  let failure;
  try {
    const discovery = await discoverInstalledChrome();
    const chromeVersion = await readInstalledChromeVersion(discovery);
    processUnderTest = launchStandalone({ preload, capacityArguments: CAPACITY });
    const origin = await readyOrigin(processUnderTest);
    chrome = await launchInstalledChrome(discovery, profile);
    cdp = connectCdp(chrome.websocketUrl);
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const browserExceptions = [];
    const requests = [];
    const responses = [];
    cdp.listeners.add((message) => {
      if (message.sessionId !== sessionId) return;
      if (message.method === "Runtime.exceptionThrown") browserExceptions.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
      if (message.method === "Network.requestWillBeSent") requests.push({
        requestId: message.params.requestId,
        url: message.params.request.url,
        method: message.params.request.method,
        postData: message.params.request.postData,
      });
      if (message.method === "Network.responseReceived") responses.push({
        requestId: message.params.requestId,
        url: message.params.response.url,
        status: message.params.response.status,
      });
    });
    await Promise.all([
      cdp.send("Page.enable", {}, sessionId),
      cdp.send("Runtime.enable", {}, sessionId),
      cdp.send("Network.enable", {}, sessionId),
    ]);
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `(()=>{
      window.__codeCityObservedSessionEvents=[];
      window.__codeCitySessionObservationError="";
      window.__codeCityRenderEvidence={matrices:[],selections:[],uploads:0};
      const originalGetContext=HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext=function(type,...args){
        const context=originalGetContext.call(this,type,...args);
        if(type!=="webgl2"||!context||context.__codeCityObserved)return context;
        Object.defineProperty(context,"__codeCityObserved",{value:true});
        const names=new WeakMap();
        const getUniformLocation=context.getUniformLocation.bind(context);
        context.getUniformLocation=(program,name)=>{const location=getUniformLocation(program,name);if(location)names.set(location,name);return location;};
        const uniformMatrix4fv=context.uniformMatrix4fv.bind(context);
        context.uniformMatrix4fv=(location,transpose,value)=>{if(names.get(location)==="u_clipFromTarget")window.__codeCityRenderEvidence.matrices.push([...value]);return uniformMatrix4fv(location,transpose,value);};
        const uniform1i=context.uniform1i.bind(context);
        context.uniform1i=(location,value)=>{if(names.get(location)==="u_selectionIndex")window.__codeCityRenderEvidence.selections.push(value);return uniform1i(location,value);};
        const bufferData=context.bufferData.bind(context);
        context.bufferData=(...values)=>{window.__codeCityRenderEvidence.uploads+=1;return bufferData(...values);};
        return context;
      };
      const originalFetch=window.fetch.bind(window);
      window.fetch=async(input,init)=>{
        const response=await originalFetch(input,init);
        const target=typeof input==="string"?input:input instanceof Request?input.url:String(input);
        if(new URL(target,location.href).pathname!=="/_code-city/session"||!response.body)return response;
        const evidence=response.clone();
        void(async()=>{
          try{
            const reader=evidence.body.getReader();
            const decoder=new TextDecoder("utf-8",{fatal:true});
            let pending="";
            for(;;){
              const result=await reader.read();
              if(result.done)break;
              pending+=decoder.decode(result.value,{stream:true});
              for(;;){
                const newline=pending.indexOf("\\n");
                if(newline<0)break;
                const line=pending.slice(0,newline);
                pending=pending.slice(newline+1);
                if(line.length>0){const event=JSON.parse(line);window.__codeCityObservedSessionEvents.push({type:event.type,sessionId:event.sessionId,generation:event.generation,revision:event.revision,successfulCount:event.city?.geometry?.count??0,failedCount:event.notAnalyzedFiles?.length??0});}
              }
            }
            pending+=decoder.decode();
            if(pending.length!==0)throw new Error("incomplete session frame");
          }catch(error){if(error?.name!=="AbortError")window.__codeCitySessionObservationError=String(error);}
        })();
        return response;
      };
    })();` }, sessionId);
    const evaluate = async (expression) => {
      const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
      return result.result.value;
    };
    const observedSessionEvents = () => evaluate(`window.__codeCityObservedSessionEvents.map((event)=>({...event}))`);
    const waitForSessionEvent = async (type, generation, expectedSessionId, label, milliseconds = 120_000) => {
      const end = Date.now() + milliseconds;
      while (Date.now() < end) {
        const evidence = await evaluate(`({error:window.__codeCitySessionObservationError,event:window.__codeCityObservedSessionEvents.find((event)=>event.type===${JSON.stringify(type)}&&${generation === undefined ? "true" : `event.generation===${generation}`}&&event.sessionId===${JSON.stringify(expectedSessionId)})??null})`);
        if (evidence.error) throw new Error(`Session observation failed while waiting for ${label}: ${evidence.error}`);
        if (evidence.event) return evidence.event;
        await sleep(20);
      }
      throw new Error(`Timed out waiting for observed session event: ${label}`);
    };
    const snapshotExpression = `({ready:document.readyState,status:document.querySelector('[data-status]')?.textContent??'',feedback:document.querySelector('[data-feedback]')?.textContent??'',commit:document.querySelector('[data-commit]')?.textContent??'',canvases:document.querySelectorAll('[data-city] canvas').length,analyzed:document.querySelectorAll('[data-analyzed-rows] li').length,failed:document.querySelectorAll('[data-failed-rows] li').length,discard:[...document.querySelectorAll('[data-actions] button')].map((button)=>button.textContent)})`;
    const snapshot = () => evaluate(snapshotExpression);
    const progressEvidence = () => evaluate(`(()=>{
      const host=document.querySelector('[data-status]');
      const controls=[...host.querySelectorAll('progress')];
      const progress=controls[0];
      const label=progress?.closest('label[data-analysis-progress]');
      const button=host.querySelector(':scope > button');
      const text=host.querySelector(':scope > p');
      const visible=(element)=>{if(!element)return false;const style=getComputedStyle(element);const rectangle=element.getBoundingClientRect();return style.display!=='none'&&style.visibility!=='hidden'&&Number(style.opacity)>0&&rectangle.width>0&&rectangle.height>0;};
      const channel=(value)=>{value/=255;return value<=0.04045?value/12.92:((value+0.055)/1.055)**2.4;};
      const luminance=(value)=>{const channels=value.match(/[\\d.]+/gu)?.slice(0,3).map(Number)??[];return channels.length===3?0.2126*channel(channels[0])+0.7152*channel(channels[1])+0.0722*channel(channels[2]):0;};
      const foreground=label?getComputedStyle(label).color:'rgb(0, 0, 0)';
      const background=getComputedStyle(document.body).backgroundColor;
      const high=Math.max(luminance(foreground),luminance(background));
      const low=Math.min(luminance(foreground),luminance(background));
      const rectangle=progress?.getBoundingClientRect();
      return {
        count:controls.length,
        native:progress instanceof HTMLProgressElement,
        indeterminate:progress?.matches(':indeterminate')??false,
        valueAttribute:progress?.hasAttribute('value')??false,
        ariaValueNow:progress?.hasAttribute('aria-valuenow')??false,
        associated:progress?.labels?.length===1&&progress.labels[0]===label&&label.control===progress,
        label:label?.textContent??'',
        status:text?.textContent??'',
        statusRole:text?.getAttribute('role')??'',
        cancel:button?.textContent??'',
        exactChildren:JSON.stringify([...host.children].map((node)=>node.tagName))===JSON.stringify(['P','LABEL','BUTTON']),
        visible:visible(text)&&visible(label)&&visible(progress)&&visible(button),
        noHorizontalOverflow:document.documentElement.scrollWidth<=window.innerWidth&&host.scrollWidth<=host.clientWidth,
        viewportContained:rectangle!==undefined&&rectangle.left>=0&&rectangle.right<=window.innerWidth,
        labelContrast:(high+0.05)/(low+0.05),
      };
    })()`);
    const assertActiveProgress = async (width, theme, label) => {
      await cdp.send("Emulation.setDeviceMetricsOverride", { width, height: 800, deviceScaleFactor: 1, mobile: false }, sessionId);
      await cdp.send("Emulation.setEmulatedMedia", { media: "screen", features: [{ name: "prefers-color-scheme", value: theme }] }, sessionId);
      await evaluate("new Promise((resolve)=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
      const evidence = await progressEvidence();
      assert.deepEqual({
        count: evidence.count,
        native: evidence.native,
        indeterminate: evidence.indeterminate,
        valueAttribute: evidence.valueAttribute,
        ariaValueNow: evidence.ariaValueNow,
        associated: evidence.associated,
        label: evidence.label,
        status: evidence.status,
        statusRole: evidence.statusRole,
        cancel: evidence.cancel,
        exactChildren: evidence.exactChildren,
        visible: evidence.visible,
        noHorizontalOverflow: evidence.noHorizontalOverflow,
        viewportContained: evidence.viewportContained,
      }, {
        count: 1,
        native: true,
        indeterminate: true,
        valueAttribute: false,
        ariaValueNow: false,
        associated: true,
        label: "Analysis progress",
        status: "Analyzing repository",
        statusRole: "status",
        cancel: "Cancel",
        exactChildren: true,
        visible: true,
        noHorizontalOverflow: true,
        viewportContained: true,
      }, label);
      assert(evidence.labelContrast >= 4.5, `${label} label contrast was ${evidence.labelContrast}`);
    };
    const restoreViewport = async () => {
      await cdp.send("Emulation.clearDeviceMetricsOverride", {}, sessionId);
      await cdp.send("Emulation.setEmulatedMedia", { media: "", features: [] }, sessionId);
    };
    const waitFor = async (predicate, label, milliseconds = 120_000) => {
      const end = Date.now() + milliseconds;
      while (Date.now() < end) {
        const value = await snapshot();
        if (predicate(value)) return value;
        if (browserExceptions.length) throw new Error(`Browser exception while waiting for ${label}: ${browserExceptions.join("; ")}`);
        await sleep(50);
      }
      throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(await snapshot())}`);
    };
    const waitForResponse = async (start, pathname, expectedStatus, milliseconds = 120_000) => {
      const end = Date.now() + milliseconds;
      while (Date.now() < end) {
        const response = responses.slice(start).find(({ url, status }) => new URL(url).pathname === pathname && status === expectedStatus);
        if (response) return response;
        if (browserExceptions.length) throw new Error(`Browser exception while waiting for ${pathname} ${expectedStatus}: ${browserExceptions.join("; ")}`);
        await sleep(20);
      }
      throw new Error(`Timed out waiting for ${pathname} response ${expectedStatus}`);
    };
    const submit = async (repositoryUrl = REPOSITORY, additionalExclusions = "") => evaluate(`(()=>{const repository=document.querySelector('input[name=repository]');const exclusions=document.querySelector('textarea[name=additional-exclusions]');repository.value=${JSON.stringify(repositoryUrl)};exclusions.value=${JSON.stringify(additionalExclusions)};const raw={repositoryUrl:repository.value,additionalExclusions:exclusions.value};document.querySelector('form').requestSubmit();return raw;})()`);
    const click = async (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click();true`);
    const browserCommand = async (target, value) => evaluate(`fetch(${JSON.stringify(target)},{method:'POST',headers:{'Content-Type':'application/json'},body:${JSON.stringify(JSON.stringify(value))},cache:'no-store',credentials:'omit',redirect:'error'}).then(async(response)=>{await response.arrayBuffer();return response.status;})`);
    const analyzeRequests = () => requests.filter(({ url }) => url === `${origin}/_code-city/analyze`);
    const latestAnalyze = () => JSON.parse(analyzeRequests().at(-1).postData);
    const recoverSuccess = async (label) => {
      await setMode(harness, "success");
      await submit();
      return waitFor((value) => value.canvases === 1 && value.commit === "a".repeat(40), label);
    };
    const installAnalyzeMutation = async (kind) => evaluate(`(()=>{const original=window.fetch.bind(window);window.fetch=(input,init)=>{if(input!=='/_code-city/analyze')return original(input,init);window.fetch=original;const next={...init};if(${JSON.stringify(kind)}==='bad-shape')next.body='{}';if(${JSON.stringify(kind)}==='missing-session'){const value=JSON.parse(next.body);value.sessionId='A'.repeat(43);next.body=JSON.stringify(value);}if(${JSON.stringify(kind)}==='wrong-media'){const headers=new Headers(next.headers);headers.set('Content-Type','text/plain');next.headers=headers;}return original(input,next);};return true;})()`);
    const installDelayedControlResponse = async (target) => evaluate(`(()=>{const original=window.fetch.bind(window);let release;const gate=new Promise((resolve)=>{release=resolve;});window.__codeCityReleaseControl=release;window.__codeCityControlStatus=null;window.__codeCityControlSettled=false;window.fetch=(input,init)=>{if(input!==${JSON.stringify(target)})return original(input,init);window.fetch=original;const pending=(async()=>{const response=await original(input,init);window.__codeCityControlStatus=response.status;await gate;window.__codeCityControlSettled=true;return response;})();window.__codeCityControlPromise=pending.then((response)=>response.status);return pending;};return true;})()`);
    const releaseDelayedControlResponse = async () => evaluate(`window.__codeCityReleaseControl();window.__codeCityControlPromise`);

    await cdp.send("Page.navigate", { url: `${origin}/` }, sessionId);
    await waitFor((value) => value.ready === "complete", "browser startup");

    await setMode(harness, "success");
    await submit();
    let state = await waitFor((value) => value.canvases === 1 && value.discard[0] === "Discard current analysis", "ordinary success");
    assert.equal(state.commit, "a".repeat(40));
    const firstAnalyze = latestAnalyze();
    assert.equal(firstAnalyze.generation, 1);
    assert.deepEqual(await waitForSessionEvent("SESSION_OPENED", undefined, firstAnalyze.sessionId, "initial session opening"), {
      type: "SESSION_OPENED", sessionId: firstAnalyze.sessionId, successfulCount: 0, failedCount: 0,
    });
    const firstSuccessEvent = await waitForSessionEvent("ANALYSIS_SUCCEEDED", firstAnalyze.generation, firstAnalyze.sessionId, "ordinary success generation");
    assert.equal(firstSuccessEvent.generation, 1);
    assert.equal(firstSuccessEvent.successfulCount, 5);
    const initialInventory = await evaluate(`(()=>{
      const buttons=[...document.querySelectorAll('[data-analyzed-rows] button')];
      const expected=[
        ['src/literal[1].js',['S: 4','U: 2','M: 3']],
        ['src/a space.js',['S: 2','U: 1','M: 1']],
        ['src/Ω.js',['S: 2','U: 3','M: 1']],
        ['src/Zeta.js',['S: 1','U: 1','M: 1']],
        ['src/é.js',['S: 1','U: 2','M: 2']],
      ];
      const exact=buttons.length===expected.length&&buttons.every((button,index)=>{
        const path=button.querySelector('bdi');
        const metrics=[...button.querySelectorAll('[data-analyzed-metrics] span')].map(node=>node.textContent);
        return button.type==='button'&&button.getAttribute('aria-pressed')==='false'&&path?.textContent===expected[index][0]
          &&path.getAttribute('dir')==='auto'&&path.attributes.length===1&&path.children.length===0
          &&JSON.stringify(metrics)===JSON.stringify(expected[index][1]);
      });
      const panel=document.querySelector('[data-analyzed-panel]').getBoundingClientRect();
      const city=document.querySelector('[data-city]').getBoundingClientRect();
      const matrix=globalThis.__codeCityRenderEvidence.matrices.at(-1);
      globalThis.__codeCityInventoryBaseline={matrix:JSON.stringify(matrix),uploads:globalThis.__codeCityRenderEvidence.uploads};
      return {exact,count:buttons.length,native:document.querySelector('[data-analyzed-query]').type==='search'&&document.querySelector('[data-analyzed-sort]').tagName==='SELECT',bounded:getComputedStyle(document.querySelector('[data-analyzed-panel]')).overflowY==='auto'&&panel.bottom<=city.top,matrix:matrix?.length===16};
    })()`);
    assert.deepEqual(initialInventory, { exact: true, count: 5, native: true, bounded: true, matrix: true });

    const rowPoint = await evaluate(`(()=>{const button=document.querySelector('[data-analyzed-rows] button');button.scrollIntoView({block:'center'});const rectangle=button.getBoundingClientRect();return {x:rectangle.left+rectangle.width/2,y:rectangle.top+rectangle.height/2};})()`);
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: rowPoint.x, y: rowPoint.y, button: "left", clickCount: 1 }, sessionId);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: rowPoint.x, y: rowPoint.y, button: "left", clickCount: 1 }, sessionId);
    assert.deepEqual(await evaluate(`(()=>{
      const button=document.querySelector('[data-analyzed-rows] button');
      const inspector=document.querySelector('[data-inspector]');
      const sameCamera=globalThis.__codeCityInventoryBaseline.matrix===JSON.stringify(globalThis.__codeCityRenderEvidence.matrices.at(-1));
      return {pressed:button.getAttribute('aria-pressed')==='true',focused:document.activeElement===button,inspector:!inspector.hidden&&inspector.querySelector('[data-canonical-path]').textContent==='src/literal[1].js'&&inspector.querySelector('[data-source-lines]').textContent==='4'&&inspector.querySelector('[data-executable-units]').textContent==='2'&&inspector.querySelector('[data-maximum-complexity]').textContent==='3',cityIndex:globalThis.__codeCityRenderEvidence.selections.at(-1)===2,sameCamera,sameUploads:globalThis.__codeCityInventoryBaseline.uploads===globalThis.__codeCityRenderEvidence.uploads};
    })()`), { pressed: true, focused: true, inspector: true, cityIndex: true, sameCamera: true, sameUploads: true });

    assert.deepEqual(await evaluate(`(()=>{
      const input=document.querySelector('[data-analyzed-query]');
      const update=(value)=>{input.value=value;input.dispatchEvent(new InputEvent('input',{bubbles:true}));};
      update(' space');
      const whitespace=document.querySelectorAll('[data-analyzed-rows] button').length===1&&document.querySelector('[data-analyzed-rows] bdi').textContent==='src/a space.js'&&!document.querySelector('[data-inspector]').hidden&&document.querySelector('[data-canonical-path]').textContent==='src/literal[1].js';
      update('Space');
      const exactCase=document.querySelectorAll('[data-analyzed-rows] button').length===0&&document.querySelector('[data-analyzed-no-matches]').textContent==='No matching analyzed files.'&&!document.querySelector('[data-analyzed-no-matches]').hidden;
      update('[1]');
      const literal=document.querySelectorAll('[data-analyzed-rows] button').length===1&&document.querySelector('[data-analyzed-rows] button').getAttribute('aria-pressed')==='true';
      update('');
      const restored=document.querySelectorAll('[data-analyzed-rows] button').length===5;
      return {whitespace,exactCase,literal,restored,sameCamera:globalThis.__codeCityInventoryBaseline.matrix===JSON.stringify(globalThis.__codeCityRenderEvidence.matrices.at(-1)),sameUploads:globalThis.__codeCityInventoryBaseline.uploads===globalThis.__codeCityRenderEvidence.uploads};
    })()`), { whitespace: true, exactCase: true, literal: true, restored: true, sameCamera: true, sameUploads: true });

    assert.deepEqual(await evaluate(`(()=>{
      const select=document.querySelector('[data-analyzed-sort]');
      const order=()=>[...document.querySelectorAll('[data-analyzed-rows] bdi')].map(node=>node.textContent);
      const change=(value)=>{select.value=value;select.dispatchEvent(new Event('change',{bubbles:true}));};
      change('U');const units=JSON.stringify(order())===JSON.stringify(['src/Ω.js','src/literal[1].js','src/é.js','src/Zeta.js','src/a space.js']);
      change('M');const complexity=JSON.stringify(order())===JSON.stringify(['src/literal[1].js','src/é.js','src/Zeta.js','src/a space.js','src/Ω.js']);
      change('S');const source=JSON.stringify(order())===JSON.stringify(['src/literal[1].js','src/a space.js','src/Ω.js','src/Zeta.js','src/é.js']);
      return {units,complexity,source,selection:[...document.querySelectorAll('[data-analyzed-rows] button')].filter(button=>button.getAttribute('aria-pressed')==='true').length===1,sameCamera:globalThis.__codeCityInventoryBaseline.matrix===JSON.stringify(globalThis.__codeCityRenderEvidence.matrices.at(-1)),sameUploads:globalThis.__codeCityInventoryBaseline.uploads===globalThis.__codeCityRenderEvidence.uploads};
    })()`), { units: true, complexity: true, source: true, selection: true, sameCamera: true, sameUploads: true });

    await evaluate("document.querySelector('[data-city] canvas').focus();true");
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowRight", code: "ArrowRight" }, sessionId);
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowRight", code: "ArrowRight" }, sessionId);
    assert.deepEqual(await evaluate(`(()=>({inspector:document.querySelector('[data-canonical-path]').textContent==='src/é.js',pressed:[...document.querySelectorAll('[data-analyzed-rows] button')].find(button=>button.getAttribute('aria-pressed')==='true')?.querySelector('bdi').textContent==='src/é.js',cityIndex:globalThis.__codeCityRenderEvidence.selections.at(-1)===3,sameCamera:globalThis.__codeCityInventoryBaseline.matrix===JSON.stringify(globalThis.__codeCityRenderEvidence.matrices.at(-1)),sameUploads:globalThis.__codeCityInventoryBaseline.uploads===globalThis.__codeCityRenderEvidence.uploads}))()`), { inspector: true, pressed: true, cityIndex: true, sameCamera: true, sameUploads: true });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" }, sessionId);
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape" }, sessionId);
    assert.equal(await evaluate("document.querySelector('[data-inspector]').hidden&&[...document.querySelectorAll('[data-analyzed-rows] button')].every(button=>button.getAttribute('aria-pressed')==='false')"), true);
    assert.equal((await request(origin, "/browser.css")).status, 200);
    assert.deepEqual(await snapshot(), state, "retained result changed while the session remained idle");

    let current = latestAnalyze();
    assert.equal(await browserCommand("/_code-city/cancel", { sessionId: current.sessionId, generation: current.generation }), 204);
    assert.deepEqual(await snapshot(), state, "no-op cancel discarded retained success");

    const invalidRaw = await submit("  invalid repository  ", "raw\r\nvalue ");
    const invalidRequest = latestAnalyze();
    assert.equal(invalidRequest.generation, firstAnalyze.generation + 1);
    assert.equal(invalidRequest.repositoryUrl, invalidRaw.repositoryUrl);
    assert.equal(invalidRequest.additionalExclusions, invalidRaw.additionalExclusions);
    state = await waitFor((value) => value.feedback === "Invalid input" && value.canvases === 0 && value.commit === "" && value.discard.length === 0, "consumed raw 422");
    assert.equal((await progressEvidence()).count, 0, "invalid submission retained progress");
    assert.equal(await browserCommand("/_code-city/discard", { sessionId: invalidRequest.sessionId, generation: invalidRequest.generation }), 204);
    assert.deepEqual(await snapshot(), state, "repeat discard after consumed 422 emitted an event or restored old UI");

    state = await recoverSuccess("success after consumed 422");
    const beforeUnrepresentableCommand = latestAnalyze();
    assert.equal(beforeUnrepresentableCommand.generation, invalidRequest.generation + 1);
    assert.equal((await waitForSessionEvent("ANALYSIS_SUCCEEDED", beforeUnrepresentableCommand.generation, beforeUnrepresentableCommand.sessionId, "pre-unrepresentable success generation")).generation, beforeUnrepresentableCommand.generation);
    const beforeUnrepresentable = analyzeRequests().length;
    await evaluate(`(()=>{const input=document.querySelector('input[name=repository]');Object.defineProperty(input,'value',{configurable:true,value:Symbol('unrepresentable')});document.querySelector('form').requestSubmit();return true;})()`);
    await waitFor((value) => value.status === "Provider/resolution failure" && value.canvases === 0 && value.commit === "" && value.discard.length === 0, "unrepresentable input closure");
    assert.equal(analyzeRequests().length, beforeUnrepresentable, "unrepresentable input reached the Analyze endpoint");
    await evaluate(`(()=>{const input=document.querySelector('input[name=repository]');delete input.value;return true;})()`);
    state = await recoverSuccess("success after unrepresentable input closure");
    const afterUnrepresentableCommand = latestAnalyze();
    assert.equal(afterUnrepresentableCommand.generation, beforeUnrepresentableCommand.generation + 2, "unrepresentable Analyze did not consume its generation");
    assert.notEqual(afterUnrepresentableCommand.sessionId, beforeUnrepresentableCommand.sessionId, "explicit recovery reused the lost session");
    assert.deepEqual(await waitForSessionEvent("SESSION_OPENED", undefined, afterUnrepresentableCommand.sessionId, "post-loss explicit session opening"), {
      type: "SESSION_OPENED", sessionId: afterUnrepresentableCommand.sessionId, successfulCount: 0, failedCount: 0,
    });
    assert.equal((await waitForSessionEvent("ANALYSIS_SUCCEEDED", afterUnrepresentableCommand.generation, afterUnrepresentableCommand.sessionId, "post-loss success generation")).generation, afterUnrepresentableCommand.generation);
    assert.equal((await observedSessionEvents()).some(({ generation }) => generation === beforeUnrepresentableCommand.generation + 1), false, "unrepresentable Analyze emitted a session event");

    current = latestAnalyze();
    await installDelayedControlResponse("/_code-city/discard");
    await click("[data-actions] button");
    await waitFor((value) => value.canvases === 0 && value.commit === "" && value.discard.length === 0, "discard event before response delivery");
    assert.deepEqual(await evaluate(`({status:window.__codeCityControlStatus,settled:window.__codeCityControlSettled})`), { status: 204, settled: false });
    assert.equal(await releaseDelayedControlResponse(), 204);
    assert.equal(await browserCommand("/_code-city/discard", { sessionId: current.sessionId, generation: current.generation }), 204);
    assert.deepEqual(await snapshot(), { ...state, status: "", feedback: "", commit: "", canvases: 0, analyzed: 0, failed: 0, discard: [] });

    state = await recoverSuccess("success after repeated no-state discard");
    const retained = latestAnalyze();
    assert.equal(await browserCommand("/_code-city/discard", { sessionId: retained.sessionId, generation: retained.generation - 1 }), 409);
    assert.deepEqual(await snapshot(), state, "stale repeated discard changed retained current state");

    await setMode(harness, "mixed");
    await submit();
    state = await waitFor((value) => value.canvases === 1 && value.analyzed === 5 && value.failed === 1, "mixed success");
    assert.equal(await evaluate("(()=>{const row=document.querySelector('[data-failed-rows] li');const path=row?.querySelector('bdi');const detail=row?.querySelector('span');return path?.textContent==='bad.js'&&path?.getAttribute('dir')==='auto'&&path.children.length===0&&detail?.textContent==='Syntax could not be analyzed';})()"), true);

    await setMode(harness, "all-failed");
    await submit();
    state = await waitFor((value) => value.canvases === 0 && value.analyzed === 0 && value.failed === 1 && value.discard.length === 1, "all files failed");
    assert.equal(await evaluate("document.querySelector('[data-presentation]').hidden&&document.querySelectorAll('[data-inspector]').length===0"), true);
    assert.equal((await progressEvidence()).count, 0, "all-files-failed retained progress");

    let logStart = (await logRows(harness)).length;
    await setMode(harness, "block-provider");
    let responseStart = responses.length;
    await submit();
    await waitForLog(harness, logStart, (rows) => rows.some(({ event }) => event === "revision-start"), "provider start before cancellation");
    await waitForResponse(responseStart, "/_code-city/analyze", 202);
    await assertActiveProgress(900, "light", "post-acknowledgement light progress");
    await assertActiveProgress(320, "dark", "post-acknowledgement narrow dark progress");
    current = latestAnalyze();
    await installDelayedControlResponse("/_code-city/cancel");
    await click("[data-status] button");
    state = await waitFor((value) => value.status === "Cancelled", "cancel event before response delivery");
    assert.equal((await progressEvidence()).count, 0, "terminal cancellation event retained progress");
    assert.deepEqual(await evaluate(`({status:window.__codeCityControlStatus,settled:window.__codeCityControlSettled})`), { status: 204, settled: false });
    assert.equal(await releaseDelayedControlResponse(), 204);
    assert.equal(await browserCommand("/_code-city/cancel", { sessionId: current.sessionId, generation: current.generation }), 204);
    assert.deepEqual(await snapshot(), state, "repeat no-op cancel emitted an event");
    await restoreViewport();

    logStart = (await logRows(harness)).length;
    await setMode(harness, "block-inventory");
    responseStart = responses.length;
    await submit();
    await waitForLog(harness, logStart, (rows) => rows.some(({ event }) => event === "inventory-held"), "inventory barrier after revision selection");
    current = latestAnalyze();
    await waitForResponse(responseStart, "/_code-city/analyze", 202);
    await waitForSessionEvent("REVISION_SELECTED", current.generation, current.sessionId, "held post-revision generation");
    await assertActiveProgress(320, "light", "post-revision narrow light progress");
    await click("[data-status] button");
    await waitFor((value) => value.status === "Cancelled", "post-revision cancellation");
    assert.equal((await progressEvidence()).count, 0, "post-revision terminal event retained progress");
    await restoreViewport();

    logStart = (await logRows(harness)).length;
    await setMode(harness, "block-provider");
    await submit();
    await waitForLog(harness, logStart, (rows) => rows.some(({ event }) => event === "revision-start"), "provider start before replacement");
    await setMode(harness, "success");
    await submit();
    state = await waitFor((value) => value.canvases === 1 && value.commit === "a".repeat(40), "replacement success");
    assert.deepEqual(await snapshot(), state, "stale replaced attempt published after replacement success");
    const generations = analyzeRequests().map(({ postData }) => JSON.parse(postData).generation);
    assert(generations.every((generation, index) => index === 0 || generation > generations[index - 1]), "Analyze generations were not strictly increasing");

    logStart = (await logRows(harness)).length;
    await setMode(harness, "busy-parser");
    await submit();
    await waitForLog(harness, logStart, (rows) => rows.filter(({ event }) => event === "source").length >= 8, "busy parser sources");
    const responsive = await Promise.race([
      request(origin, "/browser.css"),
      sleep(5_000).then(() => ({ status: 0 })),
    ]);
    assert.equal(responsive.status, 200, "actual busy analysis blocked a small HTTP response");
    await click("[data-status] button");
    await waitFor((value) => value.status === "Cancelled", "parser cancellation");
    await recoverSuccess("joined worker-slot reuse");

    for (const scenario of [
      { status: 400, mutation: "bad-shape", label: "Analyze 400" },
      { status: 404, mutation: "missing-session", label: "Analyze 404" },
      { status: 415, mutation: "wrong-media", label: "Analyze 415" },
    ]) {
      const responseStart = responses.length;
      await installAnalyzeMutation(scenario.mutation);
      await submit();
      await waitFor((value) => value.status === "Provider/resolution failure" && value.canvases === 0 && value.commit === "", `${scenario.label} loss policy`);
      await waitForResponse(responseStart, "/_code-city/analyze", scenario.status);
      await recoverSuccess(`success after ${scenario.label}`);
    }

    responseStart = responses.length;
    await submit(REPOSITORY, "x".repeat(5000));
    await waitFor((value) => value.status === "Provider/resolution failure" && value.canvases === 0 && value.commit === "", "Analyze 413 loss policy");
    await waitForResponse(responseStart, "/_code-city/analyze", 413);
    state = await recoverSuccess("success after Analyze 413");

    current = latestAnalyze();
    assert.equal(await browserCommand("/_code-city/analyze", {
      sessionId: current.sessionId,
      generation: current.generation + 2,
      repositoryUrl: "invalid",
      additionalExclusions: "",
    }), 422);
    responseStart = responses.length;
    await submit();
    await waitFor((value) => value.status === "Provider/resolution failure" && value.canvases === 0 && value.commit === "", "Analyze 409 loss policy");
    await waitForResponse(responseStart, "/_code-city/analyze", 409);
    await recoverSuccess("success after Analyze 409");

    logStart = (await logRows(harness)).length;
    await setMode(harness, "block-provider");
    await submit();
    await waitForLog(harness, logStart, (rows) => rows.some(({ event }) => event === "revision-start"), "provider start before reader capacity loss");
    const held = [holdBodyReader(origin), holdBodyReader(origin)];
    await Promise.all(held.map(({ ready }) => ready));
    await setMode(harness, "success");
    responseStart = responses.length;
    await submit();
    await waitFor((value) => value.status === "Code City capacity is unavailable." && value.canvases === 0 && value.commit === "", "reader 503 loss policy");
    await waitForResponse(responseStart, "/_code-city/analyze", 503);
    for (const { socket } of held) socket.destroy();
    await recoverSuccess("explicit post-loss session creation");

    const allowedRequests = new Set([
      "GET /",
      "GET /browser.css",
      "GET /browser.js",
      "POST /_code-city/session",
      "POST /_code-city/analyze",
      "POST /_code-city/cancel",
      "POST /_code-city/discard",
    ]);
    for (const observed of requests.filter(({ url }) => /^https?:/u.test(url))) {
      const url = new URL(observed.url);
      assert.equal(url.origin, origin, `browser made a cross-origin request: ${observed.url}`);
      assert.equal(allowedRequests.has(`${observed.method} ${url.pathname}`), true, `browser requested a non-application path: ${observed.method} ${url.pathname}`);
    }
    for (const forbiddenPath of [
      "/server/standalone.mjs",
      "/parser/web-tree-sitter.wasm",
      "/package-manifest.json",
      "/src/edge/github-source-gateway.ts",
      "/src/edge/github-revision-gateway.ts",
      "/src/edge/tree-sitter-assets.ts",
    ]) {
      assert.equal(requests.some(({ url }) => /^https?:/u.test(url) && new URL(url).pathname === forbiddenPath), false, `browser requested forbidden same-origin path ${forbiddenPath}`);
    }

    await cdp.send("Page.navigate", { url: "about:blank" }, sessionId);
    await sleep(100);
    await probeTwoSessions(origin);

    await setMode(harness, "large-failures");
    const paused = await openPausedSession(origin);
    const large = await command(origin, "/_code-city/analyze", {
      sessionId: paused.sessionId,
      generation: 1,
      repositoryUrl: REPOSITORY,
      additionalExclusions: "",
    });
    assert.equal(large.status, 202);
    await sleep(3_000);
    const blocked = await command(origin, "/_code-city/discard", { sessionId: paused.sessionId, generation: 1 });
    assert([204, 409].includes(blocked.status), `non-reading owner returned unexpected status ${blocked.status}`);
    paused.socket.destroy();
    await probeTwoSessions(origin);

    for (const privatePath of ["/server/standalone.mjs", "/parser/web-tree-sitter.wasm", "/package-manifest.json"]) {
      assert.equal((await request(origin, privatePath)).status, 404, `${privatePath} escaped private serving`);
    }
    assert.equal(browserExceptions.length, 0, `Browser exceptions: ${browserExceptions.join("; ")}`);

    sendGracefulSignal(processUnderTest, "SIGTERM");
    await processUnderTest.waitLine((line) => line.startsWith("SHUTDOWN "));
    await expectCleanExit(processUnderTest);
    process.stdout.write(`${JSON.stringify({
      chrome: { category: discovery.category, version: chromeVersion },
      scenarios: [
        "success", "retained-noop-cancel", "raw-422-cleanup", "unrepresentable-input", "discard-event-first",
        "discard-repeat-no-state", "discard-stale", "mixed", "all-files-failed", "progress-post-ack", "cancel-event-first",
        "cancel-repeat-noop", "progress-post-revision", "replacement-stale-suppression", "parser-cancel", "join-reuse", "analyze-400", "analyze-404", "analyze-409",
        "analyze-413", "analyze-415", "reader-503", "pagehide", "non-reading-owner", "exact-network-allowlist",
      ],
      browserRequests: requests.length,
      providerEvents: (await logRows(harness)).length,
      publicFiles: publicPaths,
    })}\n`);
  } catch (error) {
    failure = error;
  } finally {
    if (cdp) {
      try { await cdp.send("Browser.close"); } catch {}
      cdp.close();
    }
    if (chrome?.child && chrome.child.exitCode === null) {
      chrome.child.kill();
      await new Promise((resolve) => chrome.child.once("exit", resolve));
    }
    if (processUnderTest) await terminateForCleanup(processUnderTest);
    await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  if (failure) throw failure;
}

const invokedPath = process.argv[1] && path.resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  let watchdog;
  try {
    await Promise.race([
      checkStandaloneBrowser(),
      new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error("Standalone browser evidence exceeded its watchdog")), WATCHDOG_MS); }),
    ]);
  } finally {
    if (watchdog !== undefined) clearTimeout(watchdog);
  }
}
