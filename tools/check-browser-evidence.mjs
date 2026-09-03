import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createHttpServer } from "node:http";
import { createServer as createViteServer } from "vite";
import {
  assertPackageStateUnchanged,
  capturePackageState,
  readPackageManifest,
} from "./package-manifest.mjs";
import { canonicalDistDirectory, canonicalManifestPath, projectRoot } from "./build-package.mjs";
import { createBrowserHarnessSource } from "./browser-evidence-harness.mjs";
import { SELECTED_ASSETS } from "./check-parser-assets.mjs";
import {
  connectCdp,
  discoverInstalledChrome,
  launchInstalledChrome,
  readInstalledChromeVersion,
} from "./chrome-cdp.mjs";

const WATCHDOG_MS = 600_000;
const SUCCESS_FIXTURE = Object.freeze({
  repositoryUrl: "https://github.com/code-city/evidence-fixture",
  selected: "0123456789abcdef0123456789abcdef01234567",
  root: "89abcdef89abcdef89abcdef89abcdef89abcdef",
  path: "src/answer.js",
  source: "const answer = 42;\n",
  blob: "5c947feee9cbb434b57ed2e576b643e99e35e782",
  expectedNormalizedSourceSha256: "8691f74ea796569734dafffbbcb79088362b52c3cef154aa0d8f32696d2d4737",
  modelBytesSha256: "d3b16b372fafc88ffe3570f934474c516dca12f066a1bd3da890bea7cae1af7b",
});
const CSP = "default-src 'none'; base-uri 'none'; connect-src 'self' https://api.github.com https://raw.githubusercontent.com; form-action 'none'; frame-src 'none'; object-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; worker-src 'self'";

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function exactKeys(value, keys, label) {
  invariant(value && typeof value === "object" && !Array.isArray(value), `${label} is not an object`);
  assert.deepEqual(Object.keys(value), keys, `${label} key order/shape changed`);
}

function digestBytes(parts) {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(Uint8Array.from(part));
  return hash.digest("hex");
}

function normalizedSourceDigest(rawBytes) {
  invariant(rawBytes instanceof Uint8Array, "Raw source fixture is not exact bytes");
  let decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(rawBytes);
  if (decoded.startsWith("\uFEFF")) decoded = decoded.slice(1);
  invariant(!decoded.includes("\0"), "Raw source fixture contains NUL");
  const normalized = decoded.replace(/\r\n?/gu, "\n");
  return createHash("sha256").update(new TextEncoder().encode(normalized)).digest("hex");
}

function checkStrictSourceNormalization() {
  const raw = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("first\r\nsecond\rthird\n", "utf8")]);
  const expected = createHash("sha256").update(Buffer.from("first\nsecond\nthird\n", "utf8")).digest("hex");
  assert.equal(normalizedSourceDigest(raw), expected);
  assert.throws(() => normalizedSourceDigest(Uint8Array.from([0xc3, 0x28])), /encoded data|encoding/iu);
  assert.throws(() => normalizedSourceDigest(Buffer.from("before\0after", "utf8")), /NUL/u);
}

function pageObservationSource() {
  return `(() => {
    const evidence = { messages: [], contexts: [], canvasListeners: [], resetListeners: { adds: 0, removes: 0 }, hoverFrames: { requests: 0, callbacks: 0, cancels: 0, pending: 0, maximumPending: 0 }, workers: [], liveWorkers: 0, maximumLiveWorkers: 0 };
    Object.defineProperty(globalThis, "__codeCitySuccessEvidence", { value: evidence, configurable: true });
    const nativeRequestAnimationFrame = globalThis.requestAnimationFrame;
    const nativeCancelAnimationFrame = globalThis.cancelAnimationFrame;
    const pendingFrames = new Set();
    globalThis.requestAnimationFrame = function(callback) {
      evidence.hoverFrames.requests += 1;
      let handle;
      handle = nativeRequestAnimationFrame.call(this, (timestamp) => {
        if (pendingFrames.delete(handle)) evidence.hoverFrames.pending -= 1;
        evidence.hoverFrames.callbacks += 1;
        callback(timestamp);
      });
      pendingFrames.add(handle);
      evidence.hoverFrames.pending += 1;
      evidence.hoverFrames.maximumPending = Math.max(evidence.hoverFrames.maximumPending, evidence.hoverFrames.pending);
      return handle;
    };
    globalThis.cancelAnimationFrame = function(handle) {
      if (pendingFrames.delete(handle)) {
        evidence.hoverFrames.pending -= 1;
        evidence.hoverFrames.cancels += 1;
      }
      return nativeCancelAnimationFrame.call(this, handle);
    };
    const NativeWorker = Worker;
    const nativeAdd = NativeWorker.prototype.addEventListener;
    const nativeRemove = NativeWorker.prototype.removeEventListener;
    const nativePost = NativeWorker.prototype.postMessage;
    const nativeTerminate = NativeWorker.prototype.terminate;
    class ObservedWorker extends NativeWorker {
      constructor(...args) {
        super(...args);
        const record = { posts: [], listenerAdds: [], listenerRemoves: [], terminateCalls: 0, usable: true };
        Object.defineProperty(this, "__codeCityWorkerRecord", { value: record });
        evidence.workers.push(record);
        evidence.liveWorkers += 1;
        evidence.maximumLiveWorkers = Math.max(evidence.maximumLiveWorkers, evidence.liveWorkers);
        nativeAdd.call(this, "message", (event) => {
          const message = event.data;
          if (!message || message.type !== "SUCCESS") return;
          const geometry = message.city.geometry;
          evidence.messages.push({
            generation: message.generation,
            revision: message.revision,
            keys: Object.keys(message),
            geometryKeys: Object.keys(geometry),
            count: geometry.count,
            buffers: [geometry.origins, geometry.sizes, geometry.rgba, geometry.bounds].map((view) => Array.from(new Uint8Array(view.buffer))),
          });
        });
      }
      postMessage(command, transfer) {
        this.__codeCityWorkerRecord.posts.push({ type: command?.type, generation: command?.generation });
        return transfer === undefined ? nativePost.call(this, command) : nativePost.call(this, command, transfer);
      }
      addEventListener(type, listener, options) {
        this.__codeCityWorkerRecord.listenerAdds.push(type);
        return nativeAdd.call(this, type, listener, options);
      }
      removeEventListener(type, listener, options) {
        this.__codeCityWorkerRecord.listenerRemoves.push(type);
        return nativeRemove.call(this, type, listener, options);
      }
      terminate() {
        const record = this.__codeCityWorkerRecord;
        record.terminateCalls += 1;
        if (record.usable) {
          record.usable = false;
          evidence.liveWorkers -= 1;
        }
        return nativeTerminate.call(this);
      }
    }
    Object.defineProperty(globalThis, "Worker", { value: ObservedWorker, configurable: true, writable: true });
    const nativeCanvasAdd = HTMLCanvasElement.prototype.addEventListener;
    const nativeCanvasRemove = HTMLCanvasElement.prototype.removeEventListener;
    const canvasListenerRecords = new WeakMap();
    const listenerRecord = (canvas) => {
      let record = canvasListenerRecords.get(canvas);
      if (!record) {
        record = { adds: [], removes: [] };
        canvasListenerRecords.set(canvas, record);
        evidence.canvasListeners.push(record);
      }
      return record;
    };
    HTMLCanvasElement.prototype.addEventListener = function(type, listener, options) {
      if (["webglcontextlost", "keydown", "wheel", "pointerdown", "pointermove", "pointerup", "pointercancel", "pointerleave", "lostpointercapture", "contextmenu"].includes(type)) listenerRecord(this).adds.push({ type, passive: options?.passive ?? null, once: options?.once ?? false });
      return nativeCanvasAdd.call(this, type, listener, options);
    };
    HTMLCanvasElement.prototype.removeEventListener = function(type, listener, options) {
      if (["webglcontextlost", "keydown", "wheel", "pointerdown", "pointermove", "pointerup", "pointercancel", "pointerleave", "lostpointercapture", "contextmenu"].includes(type)) listenerRecord(this).removes.push(type);
      return nativeCanvasRemove.call(this, type, listener, options);
    };
    const nativeButtonAdd = HTMLButtonElement.prototype.addEventListener;
    const nativeButtonRemove = HTMLButtonElement.prototype.removeEventListener;
    HTMLButtonElement.prototype.addEventListener = function(type, listener, options) {
      if (type === "click" && this.matches("[data-city-reset]")) evidence.resetListeners.adds += 1;
      return nativeButtonAdd.call(this, type, listener, options);
    };
    HTMLButtonElement.prototype.removeEventListener = function(type, listener, options) {
      if (type === "click" && this.matches("[data-city-reset]")) evidence.resetListeners.removes += 1;
      return nativeButtonRemove.call(this, type, listener, options);
    };
    const acquire = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function(kind, attributes) {
      const actual = acquire.call(this, kind, attributes);
      if (kind !== "webgl2" || !actual) return actual;
      const record = { uploads: [], subUploads: [], matrices: [], outlineMatrices: [], hoverMatrices: [], draws: [], outlineDraws: [], hoverDraws: [], shaderSources: [], operations: [], polygonOffsetEnables: 0, forceLost: false, lastMatrix: null, listeners: listenerRecord(this), deletes: { shader: 0, program: 0, buffer: 0, vao: 0 } };
      evidence.contexts.push(record);
      return new Proxy(actual, { get(target, property) {
        if (property === "bufferData") return (targetKind, data, usage) => {
          record.uploads.push(Array.from(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)));
          return target.bufferData(targetKind, data, usage);
        };
        if (property === "bufferSubData") return (targetKind, offset, data) => {
          record.subUploads.push(Array.from(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)));
          return target.bufferSubData(targetKind, offset, data);
        };
        if (property === "shaderSource") return (shader, source) => {
          record.shaderSources.push(source);
          return target.shaderSource(shader, source);
        };
        if (property === "uniformMatrix4fv") return (location, transpose, matrix) => {
          record.lastMatrix = Array.from(matrix);
          return target.uniformMatrix4fv(location, transpose, matrix);
        };
        if (property === "drawElementsInstanced") return (...args) => {
          if (args[0] === 0x0001 && args[1] === 8) {
            record.hoverDraws.push(args.slice(1));
            record.hoverMatrices.push(record.lastMatrix);
            record.operations.push("hover");
          } else if (args[0] === 0x0001) {
            record.outlineDraws.push(args.slice(1));
            record.outlineMatrices.push(record.lastMatrix);
            record.operations.push("outline");
          } else {
            record.draws.push(args.slice(1));
            record.matrices.push(record.lastMatrix);
            record.operations.push("city");
          }
          return target.drawElementsInstanced(...args);
        };
        if (property === "disable") return (...args) => {
          if (args[0] === 0x0b71) record.operations.push("depth:off");
          return target.disable(...args);
        };
        if (property === "enable") return (...args) => {
          if (args[0] === 0x0b71) record.operations.push("depth:on");
          if (args[0] === 0x8037) record.polygonOffsetEnables += 1;
          return target.enable(...args);
        };
        if (property === "isContextLost" && record.forceLost) return () => true;
        const deletions = { deleteShader: "shader", deleteProgram: "program", deleteBuffer: "buffer", deleteVertexArray: "vao" };
        if (deletions[property]) return (...args) => { record.deletes[deletions[property]] += 1; return target[property](...args); };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }});
    };
  })();`;
}

const WORKER_OBSERVATION_SOURCE = `(() => {
  const nativePostMessage = self.postMessage.bind(self);
  self.postMessage = function(message, transfer) {
    if (!message || message.type !== "SUCCESS") return nativePostMessage(message, transfer);
    const geometry = message.city.geometry;
    const expected = [geometry.origins.buffer, geometry.sizes.buffer, geometry.rgba.buffer, geometry.bounds.buffer];
    const observation = { count: transfer?.length, ordered: transfer?.every((buffer, index) => buffer === expected[index]), distinct: new Set(transfer).size, whole: [geometry.origins, geometry.sizes, geometry.rgba, geometry.bounds].every((view, index) => view.byteOffset === 0 && view.byteLength === expected[index].byteLength) };
    const result = nativePostMessage(message, transfer);
    observation.detached = expected.map((buffer) => buffer.byteLength);
    console.log("success-worker-evidence:" + JSON.stringify(observation));
    return result;
  };
})();`;

async function checkProductionSuccessPath({ cdp, sessionId, origin, manifest, requestedUrls, browserExceptions, failedRequests }) {
  checkStrictSourceNormalization();
  const fixture = SUCCESS_FIXTURE;
  const revisionUrl = "https://api.github.com/repos/code-city/evidence-fixture/commits?per_page=1&page=1";
  const commitUrl = `https://api.github.com/repos/code-city/evidence-fixture/git/commits/${fixture.selected}`;
  const treeUrl = `https://api.github.com/repos/code-city/evidence-fixture/git/trees/${fixture.root}?recursive=1`;
  const rawUrl = `https://raw.githubusercontent.com/code-city/evidence-fixture/${fixture.selected}/${fixture.path}`;
  const urls = [revisionUrl, commitUrl, treeUrl, rawUrl];
  const rawSourceBytes = Buffer.from(fixture.source, "utf8");
  const computedNormalizedSourceSha256 = normalizedSourceDigest(rawSourceBytes);
  assert.equal(computedNormalizedSourceSha256, fixture.expectedNormalizedSourceSha256);
  const bodies = new Map([
    [revisionUrl, JSON.stringify([{ sha: fixture.selected }])],
    [commitUrl, JSON.stringify({ sha: fixture.selected, tree: { sha: fixture.root } })],
    [treeUrl, JSON.stringify({ sha: fixture.root, truncated: false, tree: [{ path: fixture.path, mode: "100644", type: "blob", sha: fixture.blob }] })],
    [rawUrl, rawSourceBytes],
  ]);
  const gets = [];
  const options = [];
  const workerTransfers = [];
  const workerNetwork = [];
  const generationSourceRecords = [];
  const childInstallations = [];
  const detachedWorkerTargets = [];
  const failures = [];
  const heldRequests = [];
  let activeGets = 0;
  let holdRevisionRequest = false;
  let maximumGetConcurrency = 0;
  let pageDisposalSelected = false;
  const networkStart = requestedUrls.length;

  const fulfill = async (requestId, responseCode, responseHeaders, body = "") => {
    const exactBytes = typeof body === "string" ? Buffer.from(body, "utf8") : Buffer.from(body);
    await cdp.send("Fetch.fulfillRequest", {
      requestId,
      responseCode,
      responseHeaders,
      body: exactBytes.toString("base64"),
    }, sessionId);
  };

  const listener = (message) => {
    if (message.method === "Target.detachedFromTarget") {
      detachedWorkerTargets.push(message.params.targetId);
      return;
    }
    if (message.method === "Target.attachedToTarget" && message.sessionId === sessionId && message.params.targetInfo.type === "worker") {
      const childSession = message.params.sessionId;
      childInstallations.push((async () => {
        await Promise.all([
          cdp.send("Runtime.enable", {}, childSession),
          cdp.send("Network.enable", {}, childSession),
        ]);
        await cdp.send("Runtime.evaluate", { expression: WORKER_OBSERVATION_SOURCE }, childSession);
        await cdp.send("Runtime.runIfWaitingForDebugger", {}, childSession);
      })().catch((error) => { failures.push(error); }));
      return;
    }
    if (message.sessionId !== sessionId && message.method === "Network.requestWillBeSent") {
      workerNetwork.push({ url: message.params.request.url, method: message.params.request.method });
      return;
    }
    if (message.sessionId !== sessionId && message.method === "Network.loadingFailed") {
      if (!pageDisposalSelected) failures.push(new Error(`Worker network request failed: ${message.params.errorText}`));
      return;
    }
    if (message.method === "Runtime.consoleAPICalled" && message.sessionId !== sessionId) {
      const line = message.params.args.map((argument) => argument.value ?? argument.description ?? "").join(" ");
      if (line.startsWith("success-worker-evidence:")) workerTransfers.push(JSON.parse(line.slice("success-worker-evidence:".length)));
      return;
    }
    if (message.method !== "Fetch.requestPaused" || message.sessionId !== sessionId) return;
    void (async () => {
      const { requestId, request } = message.params;
      const url = request.url;
      const method = request.method;
      invariant(urls.includes(url), `Parent Fetch intercepted an unrecognized URL: ${url}`);
      const headers = Object.fromEntries(Object.entries(request.headers).map(([name, value]) => [name.toLowerCase(), value]));
      invariant(headers.origin === origin, `GitHub exchange has wrong Origin: ${headers.origin ?? "none"}`);
      if (method === "OPTIONS") {
        invariant(url !== rawUrl, "Raw simple GET unexpectedly produced a preflight");
        invariant(headers["access-control-request-method"] === "GET", "Preflight did not request GET");
        const requested = (headers["access-control-request-headers"] ?? "").split(",").map((name) => name.trim().toLowerCase()).filter(Boolean).sort();
        invariant(requested.includes("x-github-api-version"), "Preflight omitted x-github-api-version");
        invariant(requested.every((name) => ["accept", "cache-control", "pragma", "x-github-api-version"].includes(name)), `Preflight requested an unrecognized header: ${requested.join(",")}`);
        options.push({ url, requestedHeaders: requested });
        await fulfill(requestId, 204, [
          { name: "Access-Control-Allow-Origin", value: origin },
          { name: "Access-Control-Allow-Methods", value: "GET" },
          { name: "Access-Control-Allow-Headers", value: requested.join(", ") },
          { name: "Content-Length", value: "0" },
        ]);
        return;
      }
      invariant(method === "GET", `Unrecognized GitHub method: ${method}`);
      if (holdRevisionRequest && url === revisionUrl) {
        heldRequests.push({ requestId, url });
        return;
      }
      activeGets += 1;
      maximumGetConcurrency = Math.max(maximumGetConcurrency, activeGets);
      try {
        invariant(!headers.authorization && !headers.cookie && !headers.referer, "Credential or referrer header escaped the gateway");
        if (url === rawUrl) {
          invariant(!headers["x-github-api-version"], "Raw GET carried an API version header");
        } else {
          invariant(headers.accept === "application/vnd.github+json", `API Accept changed: ${headers.accept ?? "none"}`);
          invariant(headers["x-github-api-version"] === "2026-03-10", "API version changed");
        }
        gets.push({ url, method });
        const body = bodies.get(url);
        const bodyBytes = typeof body === "string" ? Buffer.from(body, "utf8") : Buffer.from(body);
        if (url === rawUrl) {
          generationSourceRecords.push({ normalizedSourceSha256: normalizedSourceDigest(bodyBytes) });
        }
        await fulfill(requestId, 200, [
          { name: "Access-Control-Allow-Origin", value: origin },
          { name: "Content-Type", value: url === rawUrl ? "text/plain; charset=utf-8" : "application/json; charset=utf-8" },
          { name: "Content-Length", value: String(bodyBytes.byteLength) },
        ], bodyBytes);
      } finally {
        activeGets -= 1;
      }
    })().catch(async (error) => {
      failures.push(error);
      try { await cdp.send("Fetch.failRequest", { requestId: message.params.requestId, errorReason: "Failed" }, sessionId); } catch {}
    });
  };
  cdp.listeners.add(listener);

  const evaluate = async (expression) => (await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId)).result.value;
  const dispatchKey = async ({ key, code, virtualKey, modifiers = 0, text = "", autoRepeat = false }) => {
    await cdp.send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", key, code, windowsVirtualKeyCode: virtualKey, nativeVirtualKeyCode: virtualKey, modifiers, text, autoRepeat }, sessionId);
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: virtualKey, nativeVirtualKeyCode: virtualKey, modifiers }, sessionId);
  };
  const dispatchWheel = async ({ x, y, deltaY, modifiers = 0 }) => {
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY, modifiers }, sessionId);
  };
  const dispatchPointer = async ({ type, x, y, button = "none", buttons = 0, modifiers = 0 }) => {
    await cdp.send("Input.dispatchMouseEvent", { type, x, y, button, buttons, modifiers, clickCount: type === "mouseMoved" ? 0 : 1 }, sessionId);
  };
  const waitFor = async (expression, label) => {
    const end = Date.now() + 120_000;
    while (Date.now() < end) {
      if (failures.length) throw failures[0];
      const value = await evaluate(expression);
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const snapshot = await evaluate("({status:document.querySelector('[data-status]')?.textContent,commit:document.querySelector('[data-commit]')?.textContent,canvases:document.querySelectorAll('[data-city] canvas').length,evidence:globalThis.__codeCitySuccessEvidence})");
    throw new Error(`Timed out waiting for ${label}; snapshot=${JSON.stringify(snapshot)}; GETs=${JSON.stringify(gets)}; OPTIONS=${JSON.stringify(options)}; transfers=${JSON.stringify(workerTransfers)}; childInstallations=${childInstallations.length}; network=${JSON.stringify(requestedUrls.slice(networkStart))}`);
  };

  try {
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: pageObservationSource() }, sessionId);
    await cdp.send("Fetch.enable", { patterns: urls.map((urlPattern) => ({ urlPattern, requestStage: "Request" })) }, sessionId);
    await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId);
    await cdp.send("Page.navigate", { url: `${origin}/code-city/index.html` }, sessionId);
    await waitFor("document.readyState==='complete'&&document.querySelector('form')&&globalThis.__codeCitySuccessEvidence", "canonical package startup");

    const submit = `document.querySelector('input[name=repository]').value=${JSON.stringify(fixture.repositoryUrl)};document.querySelector('form').requestSubmit();true`;
    await evaluate(submit);
    const first = await waitFor(`document.querySelector('[data-commit]').textContent===${JSON.stringify(fixture.selected)}&&document.querySelectorAll('[data-city] canvas').length===1&&globalThis.__codeCitySuccessEvidence.messages.length===1`, "first successful city");
    invariant(first === true, "First successful package run did not publish");

    const cleared = await evaluate(`document.querySelector('input[name=repository]').value=${JSON.stringify(fixture.repositoryUrl)};document.querySelector('form').requestSubmit();({commit:document.querySelector('[data-commit]').textContent,canvases:document.querySelectorAll('[data-city] canvas').length,inspectors:document.querySelectorAll('[data-city] [data-inspector]').length,children:document.querySelector('[data-city]').childNodes.length,deletes:globalThis.__codeCitySuccessEvidence.contexts[0].deletes})`);
    assert.equal(cleared.commit, "");
    assert.equal(cleared.canvases, 0);
    assert.equal(cleared.inspectors, 0);
    assert.equal(cleared.children, 0);
    assert.deepEqual(cleared.deletes, { shader: 6, program: 3, buffer: 9, vao: 3 });

    await waitFor(`document.querySelector('[data-commit]').textContent===${JSON.stringify(fixture.selected)}&&document.querySelectorAll('[data-city] canvas').length===1&&globalThis.__codeCitySuccessEvidence.messages.length===2&&globalThis.__codeCitySuccessEvidence.contexts.length===2`, "second successful city");
    await Promise.all(childInstallations);
    await waitFor("globalThis.__codeCitySuccessEvidence.contexts.every((entry)=>entry.draws.length===1)&&globalThis.__codeCitySuccessEvidence.messages.length===2", "presentation evidence");
    await waitFor("globalThis.__codeCitySuccessEvidence.workers.length===2&&globalThis.__codeCitySuccessEvidence.workers.every((worker)=>worker.terminateCalls===1&&!worker.usable)&&globalThis.__codeCitySuccessEvidence.liveWorkers===0", "successful worker cleanup");

    await evaluate(`(() => {
      document.body.style.minHeight="200vh";
      const canvas=document.querySelector('[data-city] canvas');
      canvas.scrollIntoView({block:"center"});
      globalThis.__navigationEvidence={keys:[],wheels:[],pointers:[],contextMenus:[]};
      window.addEventListener("keydown",event=>globalThis.__navigationEvidence.keys.push({key:event.key,repeat:event.repeat,shift:event.shiftKey,ctrl:event.ctrlKey,defaultPrevented:event.defaultPrevented}));
      window.addEventListener("wheel",event=>globalThis.__navigationEvidence.wheels.push({deltaY:event.deltaY,shift:event.shiftKey,defaultPrevented:event.defaultPrevented}),{passive:true});
      window.addEventListener("pointerdown",event=>globalThis.__navigationEvidence.pointers.push({type:event.type,pointerId:event.pointerId,button:event.button,clientX:event.clientX,clientY:event.clientY,ctrl:event.ctrlKey,alt:event.altKey,meta:event.metaKey,shift:event.shiftKey,target:event.target.tagName,defaultPrevented:event.defaultPrevented}));
      window.addEventListener("pointerup",event=>globalThis.__navigationEvidence.pointers.push({type:event.type,pointerId:event.pointerId,button:event.button,clientX:event.clientX,clientY:event.clientY,ctrl:event.ctrlKey,alt:event.altKey,meta:event.metaKey,shift:event.shiftKey,target:event.target.tagName,defaultPrevented:event.defaultPrevented}));
      window.addEventListener("contextmenu",event=>globalThis.__navigationEvidence.contextMenus.push({target:event.target.tagName,defaultPrevented:event.defaultPrevented}));
      document.querySelector('form button[type=submit]').focus();
      return true;
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await evaluate("document.querySelector('[data-city] canvas').scrollIntoView({block:'center'});true");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const hoverPoint = await evaluate(`(() => { const r=document.querySelector('[data-city] canvas').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2,left:r.left,top:r.top,right:r.right,bottom:r.bottom}; })()`);
    const hoverStart = await evaluate(`(() => { const context=globalThis.__codeCitySuccessEvidence.contexts[1]; return {city:context.draws.length,outline:context.outlineDraws.length,hover:context.hoverDraws.length,subUploads:context.subUploads.length,operations:context.operations.length,uploads:JSON.stringify(context.uploads),frames:{...globalThis.__codeCitySuccessEvidence.hoverFrames}}; })()`);
    await dispatchPointer({ type: "mouseMoved", x: hoverPoint.x - 2, y: hoverPoint.y });
    await dispatchPointer({ type: "mouseMoved", x: hoverPoint.x + 2, y: hoverPoint.y });
    await dispatchPointer({ type: "mouseMoved", x: hoverPoint.x, y: hoverPoint.y });
    await waitFor(`globalThis.__codeCitySuccessEvidence.contexts[1].hoverDraws.length>=${hoverStart.hover + 1}&&globalThis.__codeCitySuccessEvidence.hoverFrames.pending===0`, "native burst hover");
    const burstHover = await evaluate(`(() => { const context=globalThis.__codeCitySuccessEvidence.contexts[1]; return {cityDraws:context.draws.length-${hoverStart.city},outlineDraws:context.outlineDraws.length-${hoverStart.outline},hoverDraws:context.hoverDraws.length-${hoverStart.hover},subUploads:context.subUploads.length-${hoverStart.subUploads},hoverArgs:context.hoverDraws.slice(${hoverStart.hover}),topIndices:context.uploads[7],fixedMagenta:context.shaderSources.some(source=>source.includes('o_color = vec4(1.0, 0.0, 1.0, 1.0);')),inspectorHidden:document.querySelector('[data-inspector]').hidden,frames:{...globalThis.__codeCitySuccessEvidence.hoverFrames}}; })()`);
    const cameraHoverStart = await evaluate(`(() => { const canvas=document.querySelector('[data-city] canvas'); canvas.focus(); const context=globalThis.__codeCitySuccessEvidence.contexts[1]; return {city:context.draws.length,outline:context.outlineDraws.length,hover:context.hoverDraws.length}; })()`);
    await dispatchKey({ key: "d", code: "KeyD", virtualKey: 68, text: "d" });
    await waitFor(`globalThis.__codeCitySuccessEvidence.contexts[1].hoverDraws.length>=${cameraHoverStart.hover + 1}&&globalThis.__codeCitySuccessEvidence.hoverFrames.pending===0`, "no-motion camera hover renewal");
    const cameraHover = await evaluate(`(() => { const context=globalThis.__codeCitySuccessEvidence.contexts[1]; return {cityDraws:context.draws.length-${cameraHoverStart.city},outlineDraws:context.outlineDraws.length-${cameraHoverStart.outline},hoverDraws:context.hoverDraws.length-${cameraHoverStart.hover}}; })()`);
    const leaveStart = await evaluate("globalThis.__codeCitySuccessEvidence.contexts[1].draws.length");
    await dispatchPointer({ type: "mouseMoved", x: 2, y: 2 });
    await waitFor(`globalThis.__codeCitySuccessEvidence.contexts[1].draws.length>=${leaveStart + 1}&&globalThis.__codeCitySuccessEvidence.hoverFrames.pending===0`, "native pointer leave clear");
    const leaveHover = await evaluate(`(() => { const context=globalThis.__codeCitySuccessEvidence.contexts[1]; return {cityDraws:context.draws.length-${leaveStart},hoverDraws:context.hoverDraws.length-${cameraHoverStart.hover + cameraHover.hoverDraws}}; })()`);
    const reenterStart = await evaluate(`(() => { const context=globalThis.__codeCitySuccessEvidence.contexts[1]; return {city:context.draws.length,hover:context.hoverDraws.length}; })()`);
    await dispatchPointer({ type: "mouseMoved", x: hoverPoint.x, y: hoverPoint.y });
    await waitFor(`globalThis.__codeCitySuccessEvidence.contexts[1].hoverDraws.length>=${reenterStart.hover + 1}&&globalThis.__codeCitySuccessEvidence.hoverFrames.pending===0`, "native pointer re-entry hover");
    const reenterHover = await evaluate(`(() => { const context=globalThis.__codeCitySuccessEvidence.contexts[1]; return {cityDraws:context.draws.length-${reenterStart.city},hoverDraws:context.hoverDraws.length-${reenterStart.hover}}; })()`);
    const resetHoverStart = await evaluate(`(() => { const context=globalThis.__codeCitySuccessEvidence.contexts[1]; return {city:context.draws.length,hover:context.hoverDraws.length}; })()`);
    await dispatchKey({ key: "0", code: "Digit0", virtualKey: 48, text: "0" });
    await waitFor(`globalThis.__codeCitySuccessEvidence.contexts[1].hoverDraws.length>=${resetHoverStart.hover + 1}&&globalThis.__codeCitySuccessEvidence.hoverFrames.pending===0`, "native Reset hover renewal");
    const resetHover = await evaluate(`(() => { const context=globalThis.__codeCitySuccessEvidence.contexts[1]; return {cityDraws:context.draws.length-${resetHoverStart.city},hoverDraws:context.hoverDraws.length-${resetHoverStart.hover}}; })()`);
    const finalLeaveStart = await evaluate("globalThis.__codeCitySuccessEvidence.contexts[1].draws.length");
    await dispatchPointer({ type: "mouseMoved", x: 2, y: 2 });
    await waitFor(`globalThis.__codeCitySuccessEvidence.contexts[1].draws.length>=${finalLeaveStart + 1}&&globalThis.__codeCitySuccessEvidence.hoverFrames.pending===0`, "native final hover clear");
    const hoverJourney = await evaluate(`(() => { const context=globalThis.__codeCitySuccessEvidence.contexts[1]; return {burst:${JSON.stringify(burstHover)},camera:${JSON.stringify(cameraHover)},leave:${JSON.stringify(leaveHover)},reenter:${JSON.stringify(reenterHover)},reset:${JSON.stringify(resetHover)},metricUploadsUnchanged:JSON.stringify(context.uploads)===${JSON.stringify(hoverStart.uploads)},frames:{...globalThis.__codeCitySuccessEvidence.hoverFrames}}; })()`);
    await evaluate("document.querySelector('form button[type=submit]').focus();true");
    const navigationStart = await evaluate(`(() => {
      const canvas=document.querySelector('[data-city] canvas');
      const context=globalThis.__codeCitySuccessEvidence.contexts[1];
      return {draws:context.draws.length,outlineDraws:context.outlineDraws.length,hoverDraws:context.hoverDraws.length,matrices:context.matrices.length,outlineMatrices:context.outlineMatrices.length,hoverMatrices:context.hoverMatrices.length,subUploads:context.subUploads.length,operations:context.operations.length,uploads:context.uploads.map(bytes=>bytes.length),matrix:context.matrices.at(-1),eventCounts:Object.fromEntries(Object.entries(globalThis.__navigationEvidence).map(([key,value])=>[key,value.length])),rect:(()=>{const r=canvas.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()};
    })()`);
    await dispatchKey({ key: "Tab", code: "Tab", virtualKey: 9 });
    const focusedCanvas = await evaluate(`(() => { const canvas=document.querySelector('[data-city] canvas'); const style=getComputedStyle(canvas); return {active:document.activeElement===canvas,tabIndex:canvas.tabIndex,label:canvas.getAttribute("aria-label"),description:canvas.getAttribute("aria-describedby"),outlineStyle:style.outlineStyle,outlineWidth:style.outlineWidth,outlineColor:style.outlineColor}; })()`);

    await dispatchKey({ key: "d", code: "KeyD", virtualKey: 68, text: "d" });
    await dispatchKey({ key: "d", code: "KeyD", virtualKey: 68, text: "d", autoRepeat: true });
    await dispatchKey({ key: "d", code: "KeyD", virtualKey: 68, modifiers: 2, text: "d" });
    await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKey: 39 });
    const selectedByKeyboard = await evaluate(`(() => { const inspector=document.querySelector('[data-inspector]'); const path=inspector.querySelector('[data-canonical-path]'); const context=globalThis.__codeCitySuccessEvidence.contexts[1]; return {hidden:inspector.hidden,text:inspector.textContent,pathText:path.textContent,pathTag:path.tagName,role:inspector.getAttribute('role'),live:inspector.getAttribute('aria-live'),atomic:inspector.getAttribute('aria-atomic'),cityDraws:context.draws.length-${navigationStart.draws},outlineDraws:context.outlineDraws.length-${navigationStart.outlineDraws},subUploads:context.subUploads.length-${navigationStart.subUploads},exactReplica:JSON.stringify(context.subUploads[0])===JSON.stringify(context.uploads[2].slice(0,24)),operations:context.operations.slice(-5),outlineArgs:context.outlineDraws.at(-1),fixedBlack:context.shaderSources.some(source=>source.includes('o_color = vec4(0.0, 0.0, 0.0, 1.0);')),polygonOffsetEnables:context.polygonOffsetEnables}; })()`);
    await dispatchKey({ key: "ArrowLeft", code: "ArrowLeft", virtualKey: 37, modifiers: 8 });
    await dispatchKey({ key: "ArrowDown", code: "ArrowDown", virtualKey: 40, autoRepeat: true });
    await dispatchKey({ key: "Home", code: "Home", virtualKey: 36 });
    await dispatchKey({ key: "End", code: "End", virtualKey: 35 });
    await dispatchKey({ key: "Escape", code: "Escape", virtualKey: 27 });
    const clearedSelection = await evaluate(`(() => { const inspector=document.querySelector('[data-inspector]'); return {hidden:inspector.hidden,text:inspector.textContent}; })()`);
    await dispatchKey({ key: "ArrowUp", code: "ArrowUp", virtualKey: 38 });
    await dispatchKey({ key: "W", code: "KeyW", virtualKey: 87, modifiers: 8, text: "W" });
    await dispatchKey({ key: "+", code: "Equal", virtualKey: 187, modifiers: 8, text: "+" });
    await dispatchKey({ key: "-", code: "Minus", virtualKey: 189, text: "-" });
    await dispatchKey({ key: "0", code: "Digit0", virtualKey: 48, text: "0" });
    const wheelPoint = await evaluate(`(() => { const canvas=document.querySelector('[data-city] canvas'); canvas.scrollIntoView({block:"center"}); const r=canvas.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await dispatchWheel({ x: wheelPoint.x, y: wheelPoint.y, deltaY: -120 });
    await dispatchWheel({ x: wheelPoint.x, y: wheelPoint.y, deltaY: 120, modifiers: 8 });
    await dispatchKey({ key: "Escape", code: "Escape", virtualKey: 27 });
    await evaluate("document.querySelector('form button[type=submit]').focus();true");
    const pointerPoint = await evaluate(`(() => { const canvas=document.querySelector('[data-city] canvas'); canvas.scrollIntoView({block:"center"}); const r=canvas.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const pointerTarget = await evaluate(`(() => { const canvas=document.querySelector('[data-city] canvas'); const r=canvas.getBoundingClientRect(); const x=r.x+r.width/2; const y=r.y+r.height/2; return {requested:${JSON.stringify(pointerPoint)},actual:{x,y},target:document.elementFromPoint(x,y)?.tagName,rect:{x:r.x,y:r.y,width:r.width,height:r.height},scrollY}; })()`);
    assert.equal(pointerTarget.target, "CANVAS", JSON.stringify(pointerTarget));

    const gesturePoint = pointerTarget.actual;
    const beforePointerActivation = await evaluate("globalThis.__codeCitySuccessEvidence.contexts[1].matrices.at(-1)");
    await dispatchPointer({ type: "mousePressed", x: gesturePoint.x, y: gesturePoint.y, button: "left", buttons: 1 });
    const pointerActivationCaptured = await evaluate("document.querySelector('[data-city] canvas').hasPointerCapture(globalThis.__navigationEvidence.pointers.at(-1).pointerId)");
    await dispatchPointer({ type: "mouseReleased", x: gesturePoint.x, y: gesturePoint.y, button: "left", buttons: 0 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const selectedByPointer = await evaluate(`(() => { const inspector=document.querySelector('[data-inspector]'); const path=inspector.querySelector('[data-canonical-path]'); return {hidden:inspector.hidden,text:inspector.textContent,pathText:path.textContent,pathTag:path.tagName,role:inspector.getAttribute('role'),live:inspector.getAttribute('aria-live'),atomic:inspector.getAttribute('aria-atomic')}; })()`);
    const pointerActivationMatrixUnchanged = JSON.stringify(await evaluate("globalThis.__codeCitySuccessEvidence.contexts[1].matrices.at(-1)")) === JSON.stringify(beforePointerActivation);

    const beforePrimaryDrag = await evaluate("globalThis.__codeCitySuccessEvidence.contexts[1].matrices.at(-1)");
    await dispatchPointer({ type: "mousePressed", x: gesturePoint.x, y: gesturePoint.y, button: "left", buttons: 1 });
    const primaryCapture = await evaluate(`(() => { const canvas=document.querySelector('[data-city] canvas'); const pointerId=globalThis.__navigationEvidence.pointers.at(-1).pointerId; return {focused:document.activeElement===canvas,pointerId,captured:canvas.hasPointerCapture(pointerId)}; })()`);
    await dispatchPointer({ type: "mouseMoved", x: gesturePoint.x + 12, y: gesturePoint.y + 4, buttons: 1 });
    await dispatchPointer({ type: "mouseReleased", x: 2, y: 2, button: "left", buttons: 0 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const primaryReleased = await evaluate(`(() => { const canvas=document.querySelector('[data-city] canvas'); const inspector=document.querySelector('[data-inspector]'); return {released:!canvas.hasPointerCapture(${primaryCapture.pointerId}),selectionRetained:!inspector.hidden&&inspector.querySelector('[data-canonical-path]').textContent===${JSON.stringify(fixture.path)},matrix:globalThis.__codeCitySuccessEvidence.contexts[1].matrices.at(-1)}; })()`);
    const primaryOrbitChanged = JSON.stringify(primaryReleased.matrix) !== JSON.stringify(beforePrimaryDrag);
    delete primaryReleased.matrix;

    const edgePoint = await evaluate(`(() => { const r=document.querySelector('[data-city] canvas').getBoundingClientRect(); return {x:r.right-1,y:r.bottom-1}; })()`);
    await dispatchPointer({ type: "mousePressed", x: edgePoint.x, y: edgePoint.y, button: "left", buttons: 1, modifiers: 8 });
    await dispatchPointer({ type: "mouseReleased", x: edgePoint.x, y: edgePoint.y, button: "left", buttons: 0, modifiers: 8 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await dispatchPointer({ type: "mousePressed", x: edgePoint.x, y: edgePoint.y, button: "right", buttons: 2 });
    const secondaryCapture = await evaluate(`(() => { const canvas=document.querySelector('[data-city] canvas'); const pointerId=globalThis.__navigationEvidence.pointers.at(-1).pointerId; return {pointerId,captured:canvas.hasPointerCapture(pointerId),events:globalThis.__navigationEvidence}; })()`);
    assert.equal(secondaryCapture.captured, true, JSON.stringify(secondaryCapture));
    await dispatchPointer({ type: "mouseReleased", x: edgePoint.x, y: edgePoint.y, button: "right", buttons: 0 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const stationaryNonActivationsRetained = await evaluate("!document.querySelector('[data-inspector]').hidden");

    await dispatchPointer({ type: "mousePressed", x: edgePoint.x, y: edgePoint.y, button: "left", buttons: 1 });
    await dispatchPointer({ type: "mouseReleased", x: edgePoint.x, y: edgePoint.y, button: "left", buttons: 0 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const emptyActivationCleared = await evaluate("document.querySelector('[data-inspector]').hidden&&document.querySelector('[data-inspector]').textContent==='' ");
    await dispatchKey({ key: "ArrowUp", code: "ArrowUp", virtualKey: 38 });

    const secondaryPoint = await evaluate(`(() => { const r=document.querySelector('[data-city] canvas').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
    const beforeSecondaryDrag = await evaluate("globalThis.__codeCitySuccessEvidence.contexts[1].matrices.at(-1)");
    await dispatchPointer({ type: "mousePressed", x: secondaryPoint.x, y: secondaryPoint.y, button: "right", buttons: 2 });
    await dispatchPointer({ type: "mouseMoved", x: secondaryPoint.x - 9, y: secondaryPoint.y + 7, buttons: 2 });
    await dispatchPointer({ type: "mouseReleased", x: secondaryPoint.x - 9, y: secondaryPoint.y + 7, button: "right", buttons: 0 });
    const secondaryPanChanged = JSON.stringify(await evaluate("globalThis.__codeCitySuccessEvidence.contexts[1].matrices.at(-1)")) !== JSON.stringify(beforeSecondaryDrag);

    const outsideCapturePoint = await evaluate(`(() => { const r=document.querySelector('[data-city] canvas').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2,rect:{left:r.left,top:r.top,right:r.right,bottom:r.bottom}}; })()`);
    await dispatchPointer({ type: "mousePressed", x: outsideCapturePoint.x, y: outsideCapturePoint.y, button: "left", buttons: 1 });
    assert.equal(outsideCapturePoint.x >= outsideCapturePoint.rect.left && outsideCapturePoint.x <= outsideCapturePoint.rect.right && outsideCapturePoint.y >= outsideCapturePoint.rect.top && outsideCapturePoint.y <= outsideCapturePoint.rect.bottom, true, JSON.stringify(outsideCapturePoint));
    const outsideCapture = await evaluate(`(() => {
      const canvas=document.querySelector('[data-city] canvas');
      const pointerDown=globalThis.__navigationEvidence.pointers.at(-1);
      const context=globalThis.__codeCitySuccessEvidence.contexts[1];
      const inspector=document.querySelector('[data-inspector]');
      return {pointerId:pointerDown.pointerId,captured:canvas.hasPointerCapture(pointerDown.pointerId),pointerUpCount:globalThis.__navigationEvidence.pointers.filter(({type})=>type==='pointerup').length,selection:{hidden:inspector.hidden,path:inspector.querySelector('[data-canonical-path]').textContent},cityDraws:context.draws.length,outlineDraws:context.outlineDraws.length,operations:context.operations.length};
    })()`);
    assert.equal(outsideCapture.captured, true, JSON.stringify(outsideCapture));
    assert.deepEqual(outsideCapture.selection, { hidden: false, path: fixture.path });
    await evaluate("document.body.style.minHeight='400vh';scrollTo(0,document.documentElement.scrollHeight);true");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const outsideReleasePosition = await evaluate(`(() => { const r=document.querySelector('[data-city] canvas').getBoundingClientRect(); const x=${outsideCapturePoint.x}; const y=${outsideCapturePoint.y}; return {x,y,rect:{left:r.left,top:r.top,right:r.right,bottom:r.bottom},outside:x<r.left||x>r.right||y<r.top||y>r.bottom}; })()`);
    assert.equal(outsideReleasePosition.outside, true, JSON.stringify(outsideReleasePosition));
    await dispatchPointer({ type: "mouseReleased", x: outsideReleasePosition.x, y: outsideReleasePosition.y, button: "left", buttons: 0 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const outsideRelease = await evaluate(`(() => {
      const canvas=document.querySelector('[data-city] canvas');
      const inspector=document.querySelector('[data-inspector]');
      const context=globalThis.__codeCitySuccessEvidence.contexts[1];
      const pointerUps=globalThis.__navigationEvidence.pointers.filter(({type})=>type==='pointerup');
      const delivered=pointerUps.at(-1);
      return {captured:canvas.hasPointerCapture(${outsideCapture.pointerId}),pointerUpCount:pointerUps.length,delivered:{type:delivered?.type,pointerId:delivered?.pointerId,button:delivered?.button,clientX:delivered?.clientX,clientY:delivered?.clientY,target:delivered?.target},selection:{hidden:inspector.hidden,text:inspector.textContent,path:inspector.querySelector('[data-canonical-path]').textContent},cityDraws:context.draws.length-${outsideCapture.cityDraws},outlineDraws:context.outlineDraws.length-${outsideCapture.outlineDraws},operations:context.operations.slice(${outsideCapture.operations})};
    })()`);
    await evaluate(`document.body.style.minHeight="200vh";document.querySelector('[data-city] canvas').scrollIntoView({block:"center"});document.querySelector('[data-city] canvas').focus();true`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await dispatchKey({ key: "ArrowUp", code: "ArrowUp", virtualKey: 38 });
    await dispatchPointer({ type: "mousePressed", x: 2, y: 2, button: "right", buttons: 2 });
    await dispatchPointer({ type: "mouseReleased", x: 2, y: 2, button: "right", buttons: 0 });

    await evaluate("scrollTo(0,0);true");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const scrollBefore = await evaluate("scrollY");
    await dispatchWheel({ x: 2, y: 2, deltaY: 180 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const scrollAfter = await evaluate("scrollY");
    await evaluate(`document.querySelector('[data-city] canvas').scrollIntoView({block:"center"});true`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const interruptionPoint = await evaluate(`(() => { const r=document.querySelector('[data-city] canvas').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
    await dispatchPointer({ type: "mousePressed", x: interruptionPoint.x, y: interruptionPoint.y, button: "left", buttons: 1 });
    const interruptedPointerId = await evaluate("globalThis.__navigationEvidence.pointers.at(-1).pointerId");
    const drawsBeforeResize = await evaluate("globalThis.__codeCitySuccessEvidence.contexts[1].draws.length");
    const matrixBeforeResize = await evaluate("globalThis.__codeCitySuccessEvidence.contexts[1].matrices.at(-1)");
    await evaluate("document.querySelector('[data-city]').style.width='75%';true");
    await waitFor(`globalThis.__codeCitySuccessEvidence.contexts[1].draws.length>=${drawsBeforeResize + 1}`, "native navigation and resize redraws");
    const resizeReleasedCapture = await evaluate(`!document.querySelector('[data-city] canvas').hasPointerCapture(${interruptedPointerId})`);
    const resizeChangedMatrix = JSON.stringify(await evaluate("globalThis.__codeCitySuccessEvidence.contexts[1].matrices.at(-1)")) !== JSON.stringify(matrixBeforeResize);
    await dispatchPointer({ type: "mouseMoved", x: interruptionPoint.x + 20, y: interruptionPoint.y + 20, buttons: 1 });
    await dispatchPointer({ type: "mouseReleased", x: interruptionPoint.x + 20, y: interruptionPoint.y + 20, button: "left", buttons: 0 });
    await dispatchKey({ key: "0", code: "Digit0", virtualKey: 48, text: "0" });
    const keyboardResetMatrix = await evaluate("globalThis.__codeCitySuccessEvidence.contexts[1].matrices.at(-1)");
    await dispatchKey({ key: "Tab", code: "Tab", virtualKey: 9 });
    const focusedReset = await evaluate("document.activeElement===document.querySelector('[data-city-reset]')");
    await dispatchKey({ key: "Enter", code: "Enter", virtualKey: 13, text: "\r" });
    await waitFor(`globalThis.__codeCitySuccessEvidence.contexts[1].draws.length>=${navigationStart.draws + 17}&&globalThis.__codeCitySuccessEvidence.hoverFrames.pending===0`, "keyboard Reset redraw and hover renewal");
    const navigation = await evaluate(`(() => { const context=globalThis.__codeCitySuccessEvidence.contexts[1]; const inspector=document.querySelector('[data-inspector]'); return {draws:context.draws.length-${navigationStart.draws},outlineDraws:context.outlineDraws.length-${navigationStart.outlineDraws},hoverDraws:context.hoverDraws.length-${navigationStart.hoverDraws},matrices:context.matrices.slice(${navigationStart.matrices}),outlineMatrices:context.outlineMatrices.slice(${navigationStart.outlineMatrices}),hoverMatrices:context.hoverMatrices.slice(${navigationStart.hoverMatrices}),subUploads:context.subUploads.length-${navigationStart.subUploads},uploads:context.uploads.map(bytes=>bytes.length),events:Object.fromEntries(Object.entries(globalThis.__navigationEvidence).map(([key,value])=>[key,value.slice(${JSON.stringify(navigationStart.eventCounts)}[key])])),canvasListeners:context.listeners,resetListeners:globalThis.__codeCitySuccessEvidence.resetListeners,selectionAfterCameraResizeReset:{hidden:inspector.hidden,text:inspector.textContent}}; })()`);

    const observed = await evaluate("globalThis.__codeCitySuccessEvidence");
    const surface = await evaluate("({forms:document.querySelectorAll('[data-form]').length,status:document.querySelectorAll('[data-status]').length,commits:document.querySelectorAll('[data-commit]').length,cities:document.querySelectorAll('[data-city]').length,inputs:document.querySelectorAll('input[name=repository]').length,submit:document.querySelector('form button[type=submit]').textContent,commit:document.querySelector('[data-commit]').textContent,canvases:document.querySelectorAll('[data-city] canvas').length,inspectors:document.querySelectorAll('[data-city] [data-inspector]').length,inspectorHidden:document.querySelector('[data-inspector]')?.hidden,inspectorText:document.querySelector('[data-inspector]')?.textContent,pathTag:document.querySelector('[data-canonical-path]')?.tagName,instructions:document.querySelector('#city-navigation-instructions').textContent,resets:document.querySelectorAll('[data-city-reset]').length,resetText:document.querySelector('[data-city-reset]').textContent,publicationChildren:[...document.querySelector('[data-city]').children].map((node)=>node.tagName)})");

    invariant(failures.length === 0, `Production success instrumentation failed: ${failures.map(String).join("; ")}`);
    invariant(browserExceptions.length === 0, `Production browser exceptions: ${browserExceptions.join("; ")}`);
    invariant(failedRequests.length === 0, `Production failed requests: ${failedRequests.join("; ")}`);
    assert.deepEqual(gets.map(({ url }) => url), [...urls, ...urls]);
    assert.equal(maximumGetConcurrency, 1);
    invariant(options.length >= 3, "Native CORS preflights were not intercepted on the parent session");
    for (const apiUrl of urls.slice(0, 3)) invariant(options.some((entry) => entry.url === apiUrl), `No preflight was intercepted for ${apiUrl}`);
    assert.equal(workerTransfers.length, 2);
    for (const transfer of workerTransfers) assert.deepEqual(transfer, { count: 4, ordered: true, distinct: 4, whole: true, detached: [0, 0, 0, 0] });
    assert.equal(observed.messages.length, 2);
    assert.equal(observed.maximumLiveWorkers, 1);
    assert.equal(observed.liveWorkers, 0);
    assert.equal(observed.workers.length, 2);
    for (const [index, worker] of observed.workers.entries()) {
      assert.deepEqual(worker.posts, [{ type: "START", generation: index + 1 }]);
      assert.deepEqual(worker.listenerAdds, ["message", "error", "messageerror"]);
      assert.deepEqual(worker.listenerRemoves, ["message", "error", "messageerror"]);
      assert.equal(worker.terminateCalls, 1);
      assert.equal(worker.usable, false);
    }
    assert.deepEqual(generationSourceRecords, [
      { normalizedSourceSha256: computedNormalizedSourceSha256 },
      { normalizedSourceSha256: computedNormalizedSourceSha256 },
    ]);
    assert(generationSourceRecords.every(({ normalizedSourceSha256 }) => normalizedSourceSha256 === fixture.expectedNormalizedSourceSha256));
    const modelDigests = observed.messages.map((message) => {
      const count = new Uint8Array(4);
      new DataView(count.buffer).setUint32(0, message.count, true);
      return digestBytes([count, ...message.buffers]);
    });
    assert.deepEqual(modelDigests, [fixture.modelBytesSha256, fixture.modelBytesSha256]);
    for (const message of observed.messages) {
      assert.deepEqual(message.keys, ["type", "generation", "revision", "city"]);
      assert.deepEqual(message.geometryKeys, ["kind", "count", "origins", "sizes", "rgba", "bounds"]);
      assert.equal(message.revision, fixture.selected);
    }
    const presentationDigests = observed.contexts.map((context) => createHash("sha256").update(JSON.stringify({ uploads: context.uploads, matrices: context.matrices.slice(0, 1), draws: context.draws.slice(0, 1) })).digest("hex"));
    assert.equal(presentationDigests[0], presentationDigests[1]);
    for (const context of observed.contexts) assert.deepEqual(context.uploads.map((bytes) => bytes.length), [96, 36, 28, 96, 24, 24, 96, 8, 24]);
    assert.equal(observed.contexts[0].matrices.length, 1);
    assert.deepEqual(observed.contexts[0].draws, [[36, 5121, 0, 1]]);
    assert.deepEqual(observed.contexts[1].matrices[0], observed.contexts[0].matrices[0]);
    assert.deepEqual(observed.contexts[1].draws[0], [36, 5121, 0, 1]);
    assert.equal(focusedCanvas.active, true);
    assert.equal(focusedCanvas.tabIndex, 0);
    assert.equal(focusedCanvas.label, "Interactive code city");
    assert.equal(focusedCanvas.description, "city-navigation-instructions");
    assert.equal(focusedCanvas.outlineStyle, "solid");
    assert.notEqual(focusedCanvas.outlineWidth, "0px");
    assert.notEqual(focusedCanvas.outlineColor, "rgba(0, 0, 0, 0)");
    assert.equal(focusedReset, true);
    assert.equal(hoverJourney.burst.cityDraws, 1);
    assert.equal(hoverJourney.burst.outlineDraws, 0);
    assert.equal(hoverJourney.burst.hoverDraws, 1);
    assert.equal(hoverJourney.burst.subUploads, 1);
    assert.deepEqual(hoverJourney.burst.hoverArgs, [[8, 5121, 0, 1]]);
    assert.deepEqual(hoverJourney.burst.topIndices, [4, 5, 5, 6, 6, 7, 7, 4]);
    assert.equal(hoverJourney.burst.fixedMagenta, true);
    assert.equal(hoverJourney.burst.inspectorHidden, true);
    assert.deepEqual(hoverJourney.camera, { cityDraws: 3, outlineDraws: 0, hoverDraws: 1 });
    assert.deepEqual(hoverJourney.leave, { cityDraws: 1, hoverDraws: 0 });
    assert.deepEqual(hoverJourney.reenter, { cityDraws: 1, hoverDraws: 1 });
    assert.deepEqual(hoverJourney.reset, { cityDraws: 3, hoverDraws: 1 });
    assert.equal(hoverJourney.metricUploadsUnchanged, true);
    assert.equal(hoverJourney.frames.maximumPending, 1);
    assert.equal(hoverJourney.frames.pending, 0);
    assert.deepEqual(selectedByKeyboard, { hidden: false, text: fixture.path, pathText: fixture.path, pathTag: "BDI", role: "status", live: "polite", atomic: "true", cityDraws: 3, outlineDraws: 1, subUploads: 1, exactReplica: true, operations: ["depth:on", "city", "depth:off", "outline", "depth:on"], outlineArgs: [24, 5121, 0, 1], fixedBlack: true, polygonOffsetEnables: 0 });
    assert.deepEqual(clearedSelection, { hidden: true, text: "" });
    assert.deepEqual(navigation.selectionAfterCameraResizeReset, { hidden: false, text: fixture.path });
    assert.deepEqual(primaryCapture, { focused: true, pointerId: 1, captured: true });
    assert.deepEqual(primaryReleased, { released: true, selectionRetained: true });
    assert.equal(pointerActivationCaptured, true);
    assert.deepEqual(selectedByPointer, {
      hidden: selectedByKeyboard.hidden,
      text: selectedByKeyboard.text,
      pathText: selectedByKeyboard.pathText,
      pathTag: selectedByKeyboard.pathTag,
      role: selectedByKeyboard.role,
      live: selectedByKeyboard.live,
      atomic: selectedByKeyboard.atomic,
    });
    assert.equal(pointerActivationMatrixUnchanged, true);
    assert.equal(primaryOrbitChanged, true);
    assert.equal(secondaryPanChanged, true);
    assert.equal(stationaryNonActivationsRetained, true);
    assert.equal(emptyActivationCleared, true);
    assert.deepEqual(outsideRelease, {
      captured: false,
      pointerUpCount: outsideCapture.pointerUpCount + 1,
      delivered: { type: "pointerup", pointerId: outsideCapture.pointerId, button: 0, clientX: outsideReleasePosition.x, clientY: outsideReleasePosition.y, target: "CANVAS" },
      selection: { hidden: true, text: "", path: "" },
      cityDraws: 1,
      outlineDraws: 0,
      operations: ["depth:on", "city"],
    });
    assert.equal(resizeReleasedCapture, true);
    assert.equal(resizeChangedMatrix, true);
    assert(scrollAfter > scrollBefore, `Wheel outside canvas did not retain browser scrolling: ${scrollBefore} -> ${scrollAfter}`);
    assert.equal(navigation.draws, 26);
    assert.equal(navigation.outlineDraws, 20);
    assert.equal(navigation.hoverDraws, 3);
    assert.equal(navigation.matrices.length, 26);
    assert.equal(navigation.outlineMatrices.length, 20);
    assert.equal(navigation.hoverMatrices.length, 3);
    assert.equal(navigation.subUploads, 8);
    assert.deepEqual(navigation.uploads, navigationStart.uploads);
    assert.deepEqual(navigation.matrices[8], navigationStart.matrix, "keyboard 0 did not restore the exact initial overview");
    assert.notDeepEqual(navigation.matrices[9], navigation.matrices[8], "native wheel did not zoom");
    assert.deepEqual(navigation.matrices.at(-1), keyboardResetMatrix, "native Reset button did not reproduce the keyboard resized overview");
    assert(navigation.outlineMatrices.every((matrix) => navigation.matrices.some((cityMatrix) => JSON.stringify(cityMatrix) === JSON.stringify(matrix))), "outline did not reuse a city camera matrix");
    assert(navigation.hoverMatrices.every((matrix) => navigation.matrices.some((cityMatrix) => JSON.stringify(cityMatrix) === JSON.stringify(matrix))), "hover did not reuse a city camera matrix");
    assert.deepEqual(navigation.canvasListeners.adds, [
      { type: "webglcontextlost", passive: true, once: true },
      { type: "keydown", passive: null, once: false },
      { type: "wheel", passive: false, once: false },
      { type: "pointerdown", passive: null, once: false },
      { type: "pointermove", passive: null, once: false },
      { type: "pointerup", passive: null, once: false },
      { type: "pointercancel", passive: null, once: false },
      { type: "pointerleave", passive: null, once: false },
      { type: "lostpointercapture", passive: null, once: false },
      { type: "contextmenu", passive: null, once: false },
    ]);
    assert.deepEqual(navigation.canvasListeners.removes, []);
    assert.deepEqual(navigation.resetListeners, { adds: 2, removes: 1 });
    const productKeys = navigation.events.keys.filter(({ key }) => ["d", "W", "+", "-", "0", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "Escape"].includes(key));
    assert.equal(productKeys.filter(({ key }) => key === "d").length, 3);
    assert.deepEqual(productKeys.filter(({ key }) => key === "d").map(({ repeat, ctrl, defaultPrevented }) => ({ repeat, ctrl, defaultPrevented })), [
      { repeat: false, ctrl: false, defaultPrevented: true },
      { repeat: true, ctrl: false, defaultPrevented: true },
      { repeat: false, ctrl: true, defaultPrevented: false },
    ]);
    for (const key of ["ArrowUp", "ArrowDown", "ArrowRight", "Home", "End", "Escape"]) assert.equal(productKeys.find((entry) => entry.key === key)?.defaultPrevented, true, key);
    assert.deepEqual(productKeys.filter(({ key }) => key === "ArrowLeft").map(({ shift, defaultPrevented }) => ({ shift, defaultPrevented })), [{ shift: true, defaultPrevented: false }]);
    assert.equal(productKeys.find((entry) => entry.key === "ArrowDown")?.repeat, true);
    for (const key of ["W", "+", "-"]) assert.equal(productKeys.find((entry) => entry.key === key)?.defaultPrevented, true, key);
    assert(productKeys.filter(({ key }) => key === "0").every(({ defaultPrevented }) => defaultPrevented));
    assert.deepEqual(navigation.events.wheels.map(({ shift, defaultPrevented }) => ({ shift, defaultPrevented })), [
      { shift: false, defaultPrevented: true },
      { shift: true, defaultPrevented: false },
      { shift: false, defaultPrevented: false },
    ]);
    assert(navigation.events.pointers.some(({ type, target, defaultPrevented }) => type === "pointerdown" && target === "CANVAS" && defaultPrevented));
    assert(navigation.events.pointers.some(({ type, target, defaultPrevented }) => type === "pointerdown" && target !== "CANVAS" && !defaultPrevented));
    assert(navigation.events.contextMenus.some(({ target, defaultPrevented }) => target === "CANVAS" && defaultPrevented));
    assert(navigation.events.contextMenus.some(({ target, defaultPrevented }) => target !== "CANVAS" && !defaultPrevented));
    assert.deepEqual(surface, { forms: 1, status: 1, commits: 1, cities: 1, inputs: 1, submit: "Submit", commit: fixture.selected, canvases: 1, inspectors: 1, inspectorHidden: false, inspectorText: fixture.path, pathTag: "BDI", instructions: "Keyboard navigation: use W, A, S, and D to orbit; hold Shift with W, A, S, or D to pan; use + and − to zoom; use 0 or Reset view to return to the overview. Use the arrow keys to traverse buildings, Home or End to select the first or last building, and Escape to clear selection.", resets: 1, resetText: "Reset view", publicationChildren: ["CANVAS", "SECTION"] });

    const actualNetwork = requestedUrls.slice(networkStart);
    const manifestUrls = new Set(manifest.files.map((record) => `${origin}/code-city/${record.path}`));
    manifestUrls.add(`${origin}/code-city/`);
    for (const requestUrl of actualNetwork) invariant(manifestUrls.has(requestUrl) || urls.includes(requestUrl), `Unexpected parent production-flow request: ${requestUrl}`);
    for (const exchange of workerNetwork) invariant(manifestUrls.has(exchange.url) || urls.includes(exchange.url), `Unexpected worker production-flow request: ${exchange.method} ${exchange.url}`);
    for (const expectedUrl of urls) assert.equal(workerNetwork.filter(({ url, method }) => url === expectedUrl && method === "GET").length, 2, `Worker did not issue both parent-intercepted GETs for ${expectedUrl}`);

    const contextLoss = await evaluate(`(() => {
      const canvas=document.querySelector('[data-city] canvas');
      const event=new Event('webglcontextlost',{cancelable:true});
      globalThis.__codeCitySuccessEvidence.contexts[1].forceLost=true;
      canvas.dispatchEvent(event);
      return {defaultPrevented:event.defaultPrevented,status:document.querySelector('[data-status]').textContent,commit:document.querySelector('[data-commit]').textContent,canvases:document.querySelectorAll('[data-city] canvas').length,inspectors:document.querySelectorAll('[data-city] [data-inspector]').length,listeners:globalThis.__codeCitySuccessEvidence.contexts[1].listeners,resetListeners:globalThis.__codeCitySuccessEvidence.resetListeners,deletes:globalThis.__codeCitySuccessEvidence.contexts[1].deletes};
    })()`);
    assert.deepEqual(contextLoss, {
      defaultPrevented: false,
      status: "Presentation failed (M1-PRES-1)",
      commit: fixture.selected,
      canvases: 0,
      inspectors: 0,
      listeners: {
        adds: [
          { type: "webglcontextlost", passive: true, once: true },
          { type: "keydown", passive: null, once: false },
          { type: "wheel", passive: false, once: false },
          { type: "pointerdown", passive: null, once: false },
          { type: "pointermove", passive: null, once: false },
          { type: "pointerup", passive: null, once: false },
          { type: "pointercancel", passive: null, once: false },
          { type: "pointerleave", passive: null, once: false },
          { type: "lostpointercapture", passive: null, once: false },
          { type: "contextmenu", passive: null, once: false },
        ],
        removes: ["webglcontextlost", "keydown", "wheel", "pointerdown", "pointermove", "pointerup", "pointercancel", "pointerleave", "lostpointercapture", "contextmenu"],
      },
      resetListeners: { adds: 2, removes: 2 },
      deletes: { shader: 6, program: 0, buffer: 0, vao: 0 },
    });

    holdRevisionRequest = true;
    await evaluate(submit);
    const heldDeadline = Date.now() + 120_000;
    while (heldRequests.length !== 1 && Date.now() < heldDeadline) {
      if (failures.length) throw failures[0];
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    invariant(heldRequests.length === 1, "Page-lifecycle fixture did not hold exactly one provider request");
    const beforePagehide = await evaluate("({workers:globalThis.__codeCitySuccessEvidence.workers.length,live:globalThis.__codeCitySuccessEvidence.liveWorkers,messages:globalThis.__codeCitySuccessEvidence.messages.length,canvases:document.querySelectorAll('[data-city] canvas').length,commit:document.querySelector('[data-commit]').textContent})");
    assert.deepEqual(beforePagehide, { workers: 3, live: 1, messages: 2, canvases: 0, commit: "" });

    pageDisposalSelected = true;
    const pagehide = await evaluate("window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:false}));({workers:globalThis.__codeCitySuccessEvidence.workers,live:globalThis.__codeCitySuccessEvidence.liveWorkers,status:document.querySelector('[data-status]').textContent,commit:document.querySelector('[data-commit]').textContent,canvases:document.querySelectorAll('[data-city] canvas').length})");
    assert.equal(pagehide.live, 0);
    assert.equal(pagehide.status, "");
    assert.equal(pagehide.commit, "");
    assert.equal(pagehide.canvases, 0);
    assert.equal(pagehide.workers.length, 3);
    assert.deepEqual(pagehide.workers[2], {
      posts: [{ type: "START", generation: 3 }],
      listenerAdds: ["message", "error", "messageerror"],
      listenerRemoves: ["message", "error", "messageerror"],
      terminateCalls: 1,
      usable: false,
    });

    const detachDeadline = Date.now() + 30_000;
    while (detachedWorkerTargets.length < 3 && Date.now() < detachDeadline) await new Promise((resolve) => setTimeout(resolve, 50));
    invariant(detachedWorkerTargets.length >= 3, "Chrome did not expose worker-target detachment for all terminated package workers");
    const quiescent = {
      productMessages: (await evaluate("globalThis.__codeCitySuccessEvidence.messages.length")),
      requests: requestedUrls.length,
      workerRequests: workerNetwork.length,
    };
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(await evaluate("globalThis.__codeCitySuccessEvidence.messages.length"), quiescent.productMessages);
    assert.equal(requestedUrls.length, quiescent.requests);
    assert.equal(workerNetwork.length, quiescent.workerRequests);
    try { await cdp.send("Fetch.failRequest", { requestId: heldRequests[0].requestId, errorReason: "Aborted" }, sessionId); } catch {}

    holdRevisionRequest = false;
    await cdp.send("Page.reload", { ignoreCache: true }, sessionId);
    await waitFor("document.readyState==='complete'&&globalThis.__codeCitySuccessEvidence&&globalThis.__codeCitySuccessEvidence.workers.length===0", "empty package reload");
    const reloaded = await evaluate("({workers:globalThis.__codeCitySuccessEvidence.workers.length,messages:globalThis.__codeCitySuccessEvidence.messages.length,status:document.querySelector('[data-status]').textContent,commit:document.querySelector('[data-commit]').textContent,canvases:document.querySelectorAll('[data-city] canvas').length})");
    assert.deepEqual(reloaded, { workers: 0, messages: 0, status: "", commit: "", canvases: 0 });

    console.log(`Production lifecycle evidence passed: selected=${fixture.selected}; normalized-source-sha256=${computedNormalizedSourceSha256}; model-sha256=${fixture.modelBytesSha256}; presenter-sha256=${presentationDigests[0]}; max-live-worker=1; pagehide-target-detach=${detachedWorkerTargets.length}; GETs=${gets.map(({ url }) => url).join(" -> ")}; OPTIONS=${JSON.stringify(options)}.`);
  } finally {
    cdp.listeners.delete(listener);
    try { await cdp.send("Fetch.disable", {}, sessionId); } catch {}
  }
}

function validateBrowserResult(result, expectedAssets) {
  exactKeys(result, ["schemaVersion", "assetRequests", "cases", "matrixRuns", "complexityMatrixRuns", "presentation", "browserExceptions", "unexpectedNetworkRequests", "overallPass"], "Browser result");
  assert.equal(result.schemaVersion, 1);
  assert.deepEqual(result.assetRequests, expectedAssets.map(({ role, path: assetPath, sha256 }) => ({ role, path: assetPath, sha256 })));
  assert.deepEqual(result.cases.map(({ id, family }) => ({ id, family })), [
    { id: "js-nesting-100000", family: "javascript-no-jsx" },
    { id: "js-million-empty-statements", family: "javascript-no-jsx" },
    { id: "js-long-string", family: "javascript-no-jsx" },
    { id: "js-comment-only", family: "javascript-no-jsx" },
    { id: "ts-type-nesting-10000", family: "typescript" },
    { id: "tsx-elements-10000", family: "tsx" },
  ]);
  for (const [index, entry] of result.cases.entries()) {
    exactKeys(entry, ["id", "family", "inputUtf8Bytes", "expected", "observed", "expectedDigest", "observedDigest", "cleanup", "pass"], `Case ${index}`);
    for (const side of ["expected", "observed"]) {
      exactKeys(entry[side], ["S", "U", "unitForms", "unitByteSpans", "observationKindCounts", "observationOrderDigest"], `Case ${index} ${side}`);
      exactKeys(entry[side].observationKindCounts, ["lexicalExclusion", "explicitUnit", "valueAnchor", "typeOnly", "if", "loop", "case", "catch", "ternary", "logicalAnd", "logicalOr", "nullish", "logicalAndAssign", "logicalOrAssign", "nullishAssign"], `Case ${index} counts`);
    }
    if (!entry.pass) console.error(JSON.stringify({ id: entry.id, expected: entry.expected, observed: entry.observed, cleanup: entry.cleanup }, null, 2));
    assert.equal(entry.pass, true, entry.id);
    assert.equal(entry.expectedDigest, entry.observedDigest, entry.id);
    assert.deepEqual(entry.cleanup, { parserDeletes: 1, treeDeletes: 1, cursorDeletes: 2, sourceReleases: 1, observationStreamReleases: 1 });
  }
  assert.equal(result.matrixRuns.length, 2);
  for (const [index, entry] of result.matrixRuns.entries()) {
    exactKeys(entry, ["modules", "normalizedBytes", "expected", "observed", "peakLive", "cleanup", "runDigest", "pass"], `Matrix ${index}`);
    assert.equal(entry.modules, 4000);
    assert.equal(entry.normalizedBytes, 41_943_040);
    assert.deepEqual(entry.expected, entry.observed);
    assert.deepEqual(entry.peakLive, { parser: 1, tree: 1, cursor: 1, source: 1, observationStream: 1 });
    assert.deepEqual(entry.cleanup, { parserDeletes: 4000, treeDeletes: 4000, cursorDeletes: 8000, sourceReleases: 4000, observationStreamReleases: 4000 });
    assert.equal(entry.pass, true);
  }
  assert.equal(result.matrixRuns[0].runDigest, result.matrixRuns[1].runDigest);
  assert.equal(result.complexityMatrixRuns.length, 2);
  for (const [index, entry] of result.complexityMatrixRuns.entries()) {
    exactKeys(entry, ["modules", "normalizedBytes", "expected", "observed", "densePackedByteLength", "peakLive", "cleanup", "retainedOnlyFinalFacts", "runDigest", "pass"], `Complexity matrix ${index}`);
    assert.equal(entry.modules, 4_000);
    assert.equal(entry.normalizedBytes, 41_943_040);
    assert.deepEqual(entry.expected, {
      totalS: 20,
      totalU: 20,
      totalM: 6_990_520,
      totalDecisionObservations: 6_990_500,
      factsDigest: "f2ec54ea39565022686f3d17d07360570b1ebf6d097ca4254f95700bd0a520d4",
    });
    assert.deepEqual(entry.observed, entry.expected);
    assert(entry.densePackedByteLength > 0);
    assert.deepEqual(entry.peakLive, { parser: 1, tree: 1, cursor: 1, source: 1, observationStream: 1 });
    assert.deepEqual(entry.cleanup, { parserDeletes: 4_000, treeDeletes: 4_000, cursorDeletes: 8_000, sourceReleases: 4_000, observationStreamReleases: 4_000 });
    assert.equal(entry.retainedOnlyFinalFacts, true);
    assert.equal(entry.pass, true);
  }
  assert.equal(result.complexityMatrixRuns[0].densePackedByteLength, result.complexityMatrixRuns[1].densePackedByteLength);
  assert.equal(result.complexityMatrixRuns[0].runDigest, result.complexityMatrixRuns[1].runDigest);
  assert.equal(result.complexityMatrixRuns[0].observed.factsDigest, result.complexityMatrixRuns[1].observed.factsDigest);
  exactKeys(result.presentation, ["webgl2Available", "actualContexts", "initialDraws", "repeatDraws", "resizeDraws", "outline", "accessibility", "inputCleanup", "lossDefaultPrevented", "lossDraws", "lossFailures", "lossOrdering", "lossCleanup", "lossTerminalState", "compileFailureResult", "compileFailureDraws", "compileFailures", "compileCleanup", "compileFailureTerminalState", "pass"], "Presentation");
  const outline = result.presentation.outline;
  exactKeys(outline, ["allocationUploads", "updateBytes", "exactReplica", "selection", "camera", "resizeOutlineDraws", "reset", "clear", "immutableUploads", "shaderFixedBlack", "polygonOffsetEnables", "cleanup"], "Selection outline");
  assert.deepEqual(outline.allocationUploads, [96, 36, 28, 96, 24, 24, 96, 8, 24, 96, 36, 28, 96, 24, 24, 96, 8, 24]);
  assert.equal(outline.updateBytes.length, 24);
  assert.equal(outline.exactReplica, true);
  assert.deepEqual(outline.selection, { cityDraws: 1, outlineDraws: 1, operations: ["depth:on", "city", "depth:off", "outline", "depth:on"] });
  assert.deepEqual(outline.camera, { cityDraws: 1, outlineDraws: 1 });
  assert.equal(outline.resizeOutlineDraws, 1);
  assert.deepEqual(outline.reset, { cityDraws: 1, outlineDraws: 1 });
  assert.deepEqual(outline.clear, { cityDraws: 1, outlineDraws: 0 });
  assert.equal(outline.immutableUploads, true);
  assert.equal(outline.shaderFixedBlack, true);
  assert.equal(outline.polygonOffsetEnables, 0);
  assert.deepEqual(outline.cleanup, { deleteShader: 12, deleteProgram: 6, deleteBuffer: 18, deleteVertexArray: 6 });
  assert.deepEqual(result.presentation, {
    webgl2Available: true,
    actualContexts: 4,
    initialDraws: 1,
    repeatDraws: 1,
    resizeDraws: 1,
    outline,
    accessibility: {
      tabIndex: 0,
      label: "Interactive code city",
      description: "city-navigation-instructions",
      listenerAdds: ["webglcontextlost", "keydown", "wheel", "pointerdown", "pointermove", "pointerup", "pointercancel", "pointerleave", "lostpointercapture", "contextmenu", "blur", "visibilitychange", "pagehide"],
      resetText: "Reset view",
    },
    inputCleanup: {
      listenerAdds: ["webglcontextlost", "keydown", "wheel", "pointerdown", "pointermove", "pointerup", "pointercancel", "pointerleave", "lostpointercapture", "contextmenu", "blur", "visibilitychange", "pagehide", "webglcontextlost", "keydown", "wheel", "pointerdown", "pointermove", "pointerup", "pointercancel", "pointerleave", "lostpointercapture", "contextmenu", "blur", "visibilitychange", "pagehide"],
      listenerRemoves: ["webglcontextlost", "keydown", "wheel", "pointerdown", "pointermove", "pointerup", "pointercancel", "pointerleave", "lostpointercapture", "contextmenu", "blur", "visibilitychange", "pagehide", "webglcontextlost", "keydown", "wheel", "pointerdown", "pointermove", "pointerup", "pointercancel", "pointerleave", "lostpointercapture", "contextmenu", "blur", "visibilitychange", "pagehide"],
      reset: { adds: 2, removes: 2 },
    },
    lossDefaultPrevented: false,
    lossDraws: 0,
    lossFailures: [[3, "Presentation failed", "M1-PRES-1"]],
    lossOrdering: {
      semanticPresentAtNotification: true,
      hostChildrenAtNotification: 2,
      cleanupAtNotification: { deleteShader: 6, deleteProgram: 0, deleteBuffer: 0, deleteVertexArray: 0 },
      semanticPresentAfterControllerClear: false,
    },
    lossCleanup: { deleteShader: 6, deleteProgram: 0, deleteBuffer: 0, deleteVertexArray: 0 },
    lossTerminalState: { retainedCallbacks: 1, failures: 1, drawsAfterTerminal: 0, canvases: 1, hostChildren: 0, cleanupUnchanged: true },
    compileFailureResult: { kind: "failure", category: "Presentation failed", code: "M1-PRES-1" },
    compileFailureDraws: 0,
    compileFailures: [],
    compileCleanup: { deleteShader: 1, deleteProgram: 0, deleteBuffer: 0, deleteVertexArray: 0 },
    compileFailureTerminalState: { retainedCallbacks: 1, failures: 0, drawsAfterTerminal: 0, canvases: 1, hostChildren: 0, cleanupUnchanged: true },
    pass: true,
  });
  assert.deepEqual(result.browserExceptions, []);
  assert.deepEqual(result.unexpectedNetworkRequests, []);
  assert.equal(result.overallPass, true);
}

export async function checkPackagedBrowserEvidence() {
  const canonicalBefore = await capturePackageState(canonicalDistDirectory, canonicalManifestPath);
  const manifest = await readPackageManifest(canonicalManifestPath);
  const harnessDirectory = path.join(projectRoot, "build", "browser-evidence");
  const profile = await mkdtemp(path.join(os.tmpdir(), "code-city-chrome-"));
  const discovery = await discoverInstalledChrome();
  const executable = discovery.executable;
  const version = await readInstalledChromeVersion(discovery);
  let vite;
  let httpServer;
  let chrome;
  let cdp;
  let failure;
  try {
    await rm(harnessDirectory, { force: true, recursive: true });
    await mkdir(harnessDirectory, { recursive: true });
    const selected = SELECTED_ASSETS.map((asset) => {
      const record = manifest.files.find((candidate) => candidate.sha256 === asset.sha256);
      invariant(record, `Canonical dist has no ${asset.role}`);
      return { role: asset.role, path: `/code-city/${record.path}`, sha256: asset.sha256, url: `/code-city/${record.path}` };
    });
    const rootUrl = `/@fs/${projectRoot.replaceAll("\\", "/")}/`;
    await writeFile(path.join(harnessDirectory, "harness.ts"), createBrowserHarnessSource({ projectRootUrl: rootUrl, assets: selected }), "utf8");
    const runtimeLoader = `globalThis.__codeCityRuntimePromise = import(${JSON.stringify(selected[0].url)});\n`;
    await writeFile(path.join(harnessDirectory, "runtime-loader.js"), runtimeLoader, "utf8");
    await writeFile(path.join(harnessDirectory, "index.html"), `<!doctype html><html><head><meta charset="UTF-8"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="${CSP}"></head><body><pre id="result"></pre><script type="module" src="./runtime-loader.js"></script><script type="module" src="./harness.ts"></script></body></html>`, "utf8");

    const resources = new Map();
    for (const record of manifest.files) resources.set(`/code-city/${record.path}`, { record, bytes: await readFile(path.join(canonicalDistDirectory, ...record.path.split("/"))) });
    vite = await createViteServer({
      root: harnessDirectory,
      base: "/code-city/browser-evidence/",
      appType: "spa",
      configFile: false,
      logLevel: "silent",
      server: { middlewareMode: true, hmr: false },
    });
    httpServer = createHttpServer((request, response) => {
      if (request.url === "/code-city/browser-evidence/runtime-loader.js") {
        const bytes = Buffer.from(runtimeLoader, "utf8");
        response.writeHead(200, { "Content-Length": String(bytes.byteLength), "Content-Type": "text/javascript", "Content-Security-Policy": CSP });
        response.end(bytes);
        return;
      }
      const resource = resources.get(request.url);
      if (!resource) {
        vite.middlewares(request, response);
        return;
      }
      response.writeHead(200, {
        "Content-Length": String(resource.record.byteLength),
        "Content-Type": resource.record.mediaType,
        "Content-Security-Policy": CSP,
        "X-Content-Type-Options": "nosniff",
      });
      response.end(resource.bytes);
    });
    await new Promise((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(0, "127.0.0.1", resolve);
    });
    const address = httpServer.address();
    invariant(typeof address === "object" && address, "Vite browser evidence server has no address");
    const origin = `http://127.0.0.1:${address.port}`;

    chrome = await launchInstalledChrome(discovery, profile);
    cdp = connectCdp(chrome.websocketUrl);
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const browserExceptions = [];
    const failedRequests = [];
    const requestedUrls = [];
    cdp.listeners.add((message) => {
      if (message.sessionId !== sessionId) return;
      if (message.method === "Runtime.exceptionThrown") browserExceptions.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
      if (message.method === "Runtime.consoleAPICalled") {
        const line = message.params.args.map((argument) => argument.value ?? argument.description ?? "").join(" ");
        if (line.startsWith("browser-evidence:")) console.log(line);
      }
      if (message.method === "Network.loadingFailed") failedRequests.push(message.params.errorText);
      if (message.method === "Network.requestWillBeSent") requestedUrls.push(message.params.request.url);
    });
    await Promise.all([
      cdp.send("Page.enable", {}, sessionId),
      cdp.send("Runtime.enable", {}, sessionId),
      cdp.send("Network.enable", {}, sessionId),
    ]);
    await cdp.send("Page.navigate", { url: `${origin}/code-city/browser-evidence/` }, sessionId);

    let watchdog;
    const result = await Promise.race([
      (async () => {
        for (;;) {
          const evaluation = await cdp.send("Runtime.evaluate", {
            expression: "document.querySelector('#result')?.textContent || ''",
            returnByValue: true,
          }, sessionId);
          const text = evaluation.result.value;
          if (text) return JSON.parse(text);
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      })(),
      new Promise((_, reject) => {
        watchdog = setTimeout(() => reject(new Error(`Packaged browser evidence exceeded the ten-minute watchdog; exceptions=${browserExceptions.join("|")}; requests=${requestedUrls.join("|")}`)), WATCHDOG_MS);
      }),
    ]);
    clearTimeout(watchdog);

    invariant(browserExceptions.length === 0, `Browser exceptions: ${browserExceptions.join("; ")}`);
    invariant(failedRequests.length === 0, `Failed browser requests: ${failedRequests.join("; ")}`);
    const selectedUrls = new Set(selected.map((asset) => `${origin}${asset.path}`));
    for (const assetUrl of selectedUrls) invariant(requestedUrls.includes(assetUrl), `Browser did not request selected asset ${assetUrl}`);
    const unexpected = requestedUrls.filter((url) => {
      if (selectedUrls.has(url)) return false;
      if (!url.startsWith(origin)) return true;
      const pathname = new URL(url).pathname;
      return !(pathname.startsWith("/code-city/browser-evidence/") || pathname.startsWith("/@vite/") || pathname.startsWith("/@fs/"));
    });
    invariant(unexpected.length === 0, `Unexpected browser network request(s): ${unexpected.join(", ")}`);
    validateBrowserResult(result, selected);
    await checkProductionSuccessPath({ cdp, sessionId, origin, manifest, requestedUrls, browserExceptions, failedRequests });
    console.log(`Packaged Chrome/CDP evidence passed with ${executable} (${version}); ${result.cases.length} stress cases, two comment matrices, two complete complexity matrices, canonical success/context-loss evidence, and pagehide/reload lifecycle evidence.`);
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
    if (httpServer?.listening) await new Promise((resolve) => httpServer.close(resolve));
    if (vite) await vite.close();
    await rm(profile, { force: true, recursive: true, maxRetries: 5, retryDelay: 100 });
    await rm(harnessDirectory, { force: true, recursive: true });
    try { await assertPackageStateUnchanged(canonicalBefore, canonicalDistDirectory, canonicalManifestPath); }
    catch (stateError) { failure = failure ? new AggregateError([failure, stateError]) : stateError; }
  }
  if (failure) throw failure;
}

const invokedPath = process.argv[1] && path.resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) await checkPackagedBrowserEvidence();
