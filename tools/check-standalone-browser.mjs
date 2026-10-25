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
                if(line.length>0)window.__codeCityObservedSessionEvents.push(JSON.parse(line));
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
    const snapshotExpression = `({ready:document.readyState,status:document.querySelector('[data-status]')?.textContent??'',feedback:document.querySelector('[data-feedback]')?.textContent??'',commit:document.querySelector('[data-commit]')?.textContent??'',canvases:document.querySelectorAll('[data-city] canvas').length,failed:[...document.querySelectorAll('[data-failed-rows] li')].map((row)=>row.textContent),discard:[...document.querySelectorAll('[data-actions] button')].map((button)=>button.textContent)})`;
    const snapshot = () => evaluate(snapshotExpression);
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
      type: "SESSION_OPENED", sessionId: firstAnalyze.sessionId,
    });
    assert.equal((await waitForSessionEvent("ANALYSIS_SUCCEEDED", firstAnalyze.generation, firstAnalyze.sessionId, "ordinary success generation")).generation, 1);
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
      type: "SESSION_OPENED", sessionId: afterUnrepresentableCommand.sessionId,
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
    assert.deepEqual(await snapshot(), { ...state, status: "", feedback: "", commit: "", canvases: 0, failed: [], discard: [] });

    state = await recoverSuccess("success after repeated no-state discard");
    const retained = latestAnalyze();
    assert.equal(await browserCommand("/_code-city/discard", { sessionId: retained.sessionId, generation: retained.generation - 1 }), 409);
    assert.deepEqual(await snapshot(), state, "stale repeated discard changed retained current state");

    await setMode(harness, "mixed");
    await submit();
    state = await waitFor((value) => value.canvases === 1 && value.failed.length === 1, "mixed success");
    assert.match(state.failed[0], /bad\.jsSyntax could not be analyzed/u);

    await setMode(harness, "all-failed");
    await submit();
    state = await waitFor((value) => value.canvases === 0 && value.failed.length === 1 && value.discard.length === 1, "all files failed");
    assert.match(state.failed[0], /bad\.jsSyntax could not be analyzed/u);

    let logStart = (await logRows(harness)).length;
    await setMode(harness, "block-provider");
    await submit();
    await waitForLog(harness, logStart, (rows) => rows.some(({ event }) => event === "revision-start"), "provider start before cancellation");
    current = latestAnalyze();
    await installDelayedControlResponse("/_code-city/cancel");
    await click("[data-status] button");
    state = await waitFor((value) => value.status === "Cancelled", "cancel event before response delivery");
    assert.deepEqual(await evaluate(`({status:window.__codeCityControlStatus,settled:window.__codeCityControlSettled})`), { status: 204, settled: false });
    assert.equal(await releaseDelayedControlResponse(), 204);
    assert.equal(await browserCommand("/_code-city/cancel", { sessionId: current.sessionId, generation: current.generation }), 204);
    assert.deepEqual(await snapshot(), state, "repeat no-op cancel emitted an event");

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

    let responseStart = responses.length;
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
        "discard-repeat-no-state", "discard-stale", "mixed", "all-files-failed", "cancel-event-first", "cancel-repeat-noop",
        "replacement-stale-suppression", "parser-cancel", "join-reuse", "analyze-400", "analyze-404", "analyze-409",
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
