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
    cdp.listeners.add((message) => {
      if (message.sessionId !== sessionId) return;
      if (message.method === "Runtime.exceptionThrown") browserExceptions.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
      if (message.method === "Network.requestWillBeSent") requests.push({
        url: message.params.request.url,
        method: message.params.request.method,
        postData: message.params.request.postData,
      });
    });
    await Promise.all([
      cdp.send("Page.enable", {}, sessionId),
      cdp.send("Runtime.enable", {}, sessionId),
      cdp.send("Network.enable", {}, sessionId),
    ]);
    const evaluate = async (expression) => {
      const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
      return result.result.value;
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
    const submit = async () => evaluate(`document.querySelector('input[name=repository]').value=${JSON.stringify(REPOSITORY)};document.querySelector('textarea[name=additional-exclusions]').value='';document.querySelector('form').requestSubmit();true`);
    const click = async (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click();true`);

    await cdp.send("Page.navigate", { url: `${origin}/` }, sessionId);
    await waitFor((value) => value.ready === "complete", "browser startup");

    await setMode(harness, "success");
    await submit();
    let state = await waitFor((value) => value.canvases === 1 && value.discard[0] === "Discard current analysis", "ordinary success");
    assert.equal(state.commit, "a".repeat(40));
    await sleep(250);
    assert.deepEqual(await snapshot(), state, "retained result changed during idle time");
    await click("[data-actions] button");
    await waitFor((value) => value.canvases === 0 && value.commit === "" && value.discard.length === 0, "discard");

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
    while ((await logRows(harness)).slice(logStart).every(({ event }) => event !== "revision-start")) await sleep(20);
    await click("[data-status] button");
    await waitFor((value) => value.status === "Cancelled", "provider cancellation");
    assert((await logRows(harness)).slice(logStart).some(({ event }) => event === "revision-start"));

    logStart = (await logRows(harness)).length;
    await setMode(harness, "block-provider");
    await submit();
    while ((await logRows(harness)).slice(logStart).every(({ event }) => event !== "revision-start")) await sleep(20);
    await setMode(harness, "success");
    await submit();
    await waitFor((value) => value.canvases === 1 && value.commit === "a".repeat(40), "replacement success");
    const generations = requests.filter(({ url }) => url === `${origin}/_code-city/analyze`).map(({ postData }) => JSON.parse(postData).generation);
    assert(generations.every((generation, index) => index === 0 || generation > generations[index - 1]), "Analyze generations were not strictly increasing");

    logStart = (await logRows(harness)).length;
    await setMode(harness, "busy-parser");
    await submit();
    while ((await logRows(harness)).slice(logStart).filter(({ event }) => event === "source").length < 8) await sleep(20);
    const responsive = await Promise.race([
      request(origin, "/browser.css"),
      sleep(5_000).then(() => ({ status: 0 })),
    ]);
    assert.equal(responsive.status, 200, "actual busy analysis blocked a small HTTP response");
    await click("[data-status] button");
    await waitFor((value) => value.status === "Cancelled", "parser cancellation");
    await setMode(harness, "success");
    await submit();
    await waitFor((value) => value.canvases === 1, "joined worker-slot reuse");

    logStart = (await logRows(harness)).length;
    await setMode(harness, "block-provider");
    await submit();
    while ((await logRows(harness)).slice(logStart).every(({ event }) => event !== "revision-start")) await sleep(20);
    const held = [holdBodyReader(origin), holdBodyReader(origin)];
    await Promise.all(held.map(({ ready }) => ready));
    await setMode(harness, "success");
    await submit();
    await waitFor((value) => value.status === "Code City capacity is unavailable." && value.canvases === 0 && value.commit === "", "reader 503 loss policy");
    for (const { socket } of held) socket.destroy();
    await setMode(harness, "success");
    await submit();
    await waitFor((value) => value.canvases === 1, "explicit post-loss session creation");

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
    const unexpectedNetwork = requests.filter(({ url }) => !url.startsWith(origin));
    assert.deepEqual(unexpectedNetwork, [], "browser made a cross-origin request");
    const requestedPaths = new Set(requests.map(({ url }) => new URL(url).pathname));
    for (const privatePath of ["/server/standalone.mjs", "/parser/web-tree-sitter.wasm", "/package-manifest.json"]) {
      assert.equal(requestedPaths.has(privatePath), false, `browser requested private path ${privatePath}`);
    }
    assert.equal(browserExceptions.length, 0, `Browser exceptions: ${browserExceptions.join("; ")}`);

    sendGracefulSignal(processUnderTest, "SIGTERM");
    await processUnderTest.waitLine((line) => line.startsWith("SHUTDOWN "));
    await expectCleanExit(processUnderTest);
    process.stdout.write(`${JSON.stringify({
      chrome: { category: discovery.category, version: chromeVersion },
      scenarios: ["success", "mixed", "all-files-failed", "provider-cancel", "replacement", "parser-cancel", "join-reuse", "reader-503", "pagehide", "non-reading-owner"],
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
  await Promise.race([
    checkStandaloneBrowser(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("Standalone browser evidence exceeded its watchdog")), WATCHDOG_MS)),
  ]);
}
