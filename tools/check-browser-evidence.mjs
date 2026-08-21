import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
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

const WATCHDOG_MS = 8 * 60 * 1000;
const SUCCESS_FIXTURE = Object.freeze({
  repositoryUrl: "https://github.com/code-city/evidence-fixture",
  selected: "0123456789abcdef0123456789abcdef01234567",
  root: "89abcdef89abcdef89abcdef89abcdef89abcdef",
  path: "src/answer.js",
  source: "const answer = 42;\n",
  blob: "5c947feee9cbb434b57ed2e576b643e99e35e782",
  expectedNormalizedSourceSha256: "8691f74ea796569734dafffbbcb79088362b52c3cef154aa0d8f32696d2d4737",
  modelBytesSha256: "90ea132d2534fd0f06f796ba584a5fd0b927914230119a0a641d9b5497133bd6",
});
const CSP = "default-src 'none'; base-uri 'none'; connect-src 'self' https://api.github.com https://raw.githubusercontent.com; form-action 'none'; frame-src 'none'; object-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; worker-src 'self'";

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function chromeCandidates() {
  if (process.platform === "win32") {
    return [
      process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"),
      process.env["PROGRAMFILES(X86)"] && path.join(process.env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe"),
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
    ].filter(Boolean);
  }
  return ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/opt/google/chrome/chrome"];
}

async function findChrome() {
  for (const candidate of chromeCandidates()) {
    try {
      const metadata = await import("node:fs/promises").then(({ stat }) => stat(candidate));
      if (metadata.isFile()) return candidate;
    } catch {}
  }
  throw new Error("Installed Google Chrome was not found; substitution and download are forbidden");
}

async function executableVersion(executable) {
  let version;
  if (process.platform === "win32") {
    const escaped = executable.replaceAll("'", "''");
    version = await new Promise((resolve, reject) => execFile(
      "powershell.exe",
      ["-NoProfile", "-Command", `(Get-Item -LiteralPath '${escaped}').VersionInfo.ProductVersion`],
      { encoding: "utf8" },
      (error, stdout) => error ? reject(error) : resolve(stdout.trim()),
    ));
  } else {
    version = await new Promise((resolve, reject) => execFile(
      executable,
      ["--version"],
      { encoding: "utf8" },
      (error, stdout) => error ? reject(error) : resolve(stdout.trim().replace(/^Google Chrome\s+/u, "")),
    ));
  }
  invariant(/^\d+\.\d+\.\d+\.\d+$/u.test(version), "Installed Google Chrome version could not be recorded");
  return version;
}

async function launchChrome(executable, profile) {
  const child = spawn(executable, [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  let stderr = "";
  const websocketUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Chrome DevTools endpoint did not appear: ${stderr}`)), 30_000);
    const finish = (error, value) => { clearTimeout(timer); error ? reject(error) : resolve(value); };
    child.once("error", (error) => finish(error));
    child.once("exit", (code) => finish(new Error(`Chrome exited before CDP startup (${code}): ${stderr}`)));
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      const match = /DevTools listening on (ws:\/\/[^\s]+)/u.exec(stderr);
      if (match) finish(undefined, match[1]);
    });
  });
  return { child, websocketUrl };
}

function connectCdp(url) {
  const socket = new WebSocket(url);
  let nextId = 1;
  const pending = new Map();
  const listeners = new Set();
  const opened = new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("CDP WebSocket failed to open")), { once: true });
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id) {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(`CDP ${waiter.method} failed: ${message.error.message}`));
      else waiter.resolve(message.result);
      return;
    }
    for (const listener of listeners) listener(message);
  });
  return {
    socket,
    listeners,
    async send(method, params = {}, sessionId) {
      await opened;
      const id = nextId++;
      const response = new Promise((resolve, reject) => pending.set(id, { method, resolve, reject }));
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      return await response;
    },
    close() { if (socket.readyState < WebSocket.CLOSING) socket.close(); },
  };
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
    const evidence = { messages: [], contexts: [] };
    Object.defineProperty(globalThis, "__codeCitySuccessEvidence", { value: evidence, configurable: true });
    const observedWorkers = new WeakSet();
    const add = Worker.prototype.addEventListener;
    Worker.prototype.addEventListener = function(type, listener, options) {
      if (type === "message" && !observedWorkers.has(this)) {
        observedWorkers.add(this);
        add.call(this, "message", (event) => {
          const message = event.data;
          if (!message || message.type !== "SUCCESS") return;
          const model = message.model;
          evidence.messages.push({
            generation: message.generation,
            revision: message.revision,
            keys: Object.keys(message),
            modelKeys: Object.keys(model),
            buffers: [model.origins, model.sizes, model.rgba, model.bounds].map((view) => Array.from(new Uint8Array(view.buffer))),
          });
        });
      }
      return add.call(this, type, listener, options);
    };
    const acquire = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function(kind, attributes) {
      const actual = acquire.call(this, kind, attributes);
      if (kind !== "webgl2" || !actual) return actual;
      const record = { uploads: [], matrices: [], draws: [], deletes: { shader: 0, program: 0, buffer: 0, vao: 0 } };
      evidence.contexts.push(record);
      return new Proxy(actual, { get(target, property) {
        if (property === "bufferData") return (targetKind, data, usage) => {
          record.uploads.push(Array.from(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)));
          return target.bufferData(targetKind, data, usage);
        };
        if (property === "uniformMatrix4fv") return (location, transpose, matrix) => {
          record.matrices.push(Array.from(matrix));
          return target.uniformMatrix4fv(location, transpose, matrix);
        };
        if (property === "drawElementsInstanced") return (...args) => {
          record.draws.push(args.slice(1));
          return target.drawElementsInstanced(...args);
        };
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
    const expected = [message.model.origins.buffer, message.model.sizes.buffer, message.model.rgba.buffer, message.model.bounds.buffer];
    const observation = { count: transfer?.length, ordered: transfer?.every((buffer, index) => buffer === expected[index]), distinct: new Set(transfer).size, whole: [message.model.origins, message.model.sizes, message.model.rgba, message.model.bounds].every((view, index) => view.byteOffset === 0 && view.byteLength === expected[index].byteLength) };
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
  const failures = [];
  let activeGets = 0;
  let maximumGetConcurrency = 0;
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
      failures.push(new Error(`Worker network request failed: ${message.params.errorText}`));
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

    const cleared = await evaluate(`document.querySelector('input[name=repository]').value=${JSON.stringify(fixture.repositoryUrl)};document.querySelector('form').requestSubmit();({commit:document.querySelector('[data-commit]').textContent,canvases:document.querySelectorAll('[data-city] canvas').length,deletes:globalThis.__codeCitySuccessEvidence.contexts[0].deletes})`);
    assert.equal(cleared.commit, "");
    assert.equal(cleared.canvases, 0);
    assert.deepEqual(cleared.deletes, { shader: 2, program: 1, buffer: 3, vao: 1 });

    await waitFor(`document.querySelector('[data-commit]').textContent===${JSON.stringify(fixture.selected)}&&document.querySelectorAll('[data-city] canvas').length===1&&globalThis.__codeCitySuccessEvidence.messages.length===2&&globalThis.__codeCitySuccessEvidence.contexts.length===2`, "second successful city");
    await Promise.all(childInstallations);
    await waitFor("globalThis.__codeCitySuccessEvidence.contexts.every((entry)=>entry.draws.length===1)&&globalThis.__codeCitySuccessEvidence.messages.length===2", "presentation evidence");
    const observed = await evaluate("globalThis.__codeCitySuccessEvidence");
    const surface = await evaluate("({forms:document.querySelectorAll('[data-form]').length,status:document.querySelectorAll('[data-status]').length,commits:document.querySelectorAll('[data-commit]').length,cities:document.querySelectorAll('[data-city]').length,inputs:document.querySelectorAll('input[name=repository]').length,submit:document.querySelector('form button[type=submit]').textContent,commit:document.querySelector('[data-commit]').textContent,canvases:document.querySelectorAll('[data-city] canvas').length})");

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
    assert.deepEqual(generationSourceRecords, [
      { normalizedSourceSha256: computedNormalizedSourceSha256 },
      { normalizedSourceSha256: computedNormalizedSourceSha256 },
    ]);
    assert(generationSourceRecords.every(({ normalizedSourceSha256 }) => normalizedSourceSha256 === fixture.expectedNormalizedSourceSha256));
    const modelDigests = observed.messages.map((message) => digestBytes(message.buffers));
    assert.deepEqual(modelDigests, [fixture.modelBytesSha256, fixture.modelBytesSha256]);
    for (const message of observed.messages) {
      assert.deepEqual(message.keys, ["type", "generation", "revision", "model"]);
      assert.deepEqual(message.modelKeys, ["kind", "count", "origins", "sizes", "rgba", "bounds"]);
      assert.equal(message.revision, fixture.selected);
    }
    const presentationDigests = observed.contexts.map((context) => createHash("sha256").update(JSON.stringify({ uploads: context.uploads, matrices: context.matrices, draws: context.draws })).digest("hex"));
    assert.equal(presentationDigests[0], presentationDigests[1]);
    for (const context of observed.contexts) {
      assert.deepEqual(context.uploads.map((bytes) => bytes.length), [96, 36, 28]);
      assert.equal(context.matrices.length, 1);
      assert.deepEqual(context.draws, [[36, 5121, 0, 1]]);
    }
    assert.deepEqual(surface, { forms: 1, status: 1, commits: 1, cities: 1, inputs: 1, submit: "Submit", commit: fixture.selected, canvases: 1 });

    const actualNetwork = requestedUrls.slice(networkStart);
    const manifestUrls = new Set(manifest.files.map((record) => `${origin}/code-city/${record.path}`));
    manifestUrls.add(`${origin}/code-city/`);
    for (const requestUrl of actualNetwork) invariant(manifestUrls.has(requestUrl) || urls.includes(requestUrl), `Unexpected parent production-flow request: ${requestUrl}`);
    for (const exchange of workerNetwork) invariant(manifestUrls.has(exchange.url) || urls.includes(exchange.url), `Unexpected worker production-flow request: ${exchange.method} ${exchange.url}`);
    for (const expectedUrl of urls) assert.equal(workerNetwork.filter(({ url, method }) => url === expectedUrl && method === "GET").length, 2, `Worker did not issue both parent-intercepted GETs for ${expectedUrl}`);

    console.log(`Production success evidence passed: selected=${fixture.selected}; normalized-source-sha256=${computedNormalizedSourceSha256}; model-sha256=${fixture.modelBytesSha256}; presenter-sha256=${presentationDigests[0]}; GETs=${gets.map(({ url }) => url).join(" -> ")}; OPTIONS=${JSON.stringify(options)}.`);
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
  exactKeys(result.presentation, ["webgl2Available", "actualContexts", "initialDraws", "repeatDraws", "resizeDraws", "lossDefaultPrevented", "lossDraws", "lossFailures", "lossCleanup", "lossTerminalState", "compileFailureResult", "compileFailureDraws", "compileFailures", "compileCleanup", "compileFailureTerminalState", "pass"], "Presentation");
  assert.deepEqual(result.presentation, {
    webgl2Available: true,
    actualContexts: 4,
    initialDraws: 1,
    repeatDraws: 1,
    resizeDraws: 1,
    lossDefaultPrevented: false,
    lossDraws: 0,
    lossFailures: [[3, "Presentation failed", "M1-PRES-1"]],
    lossCleanup: { deleteShader: 2, deleteProgram: 1, deleteBuffer: 3, deleteVertexArray: 1 },
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
  const executable = await findChrome();
  const version = await executableVersion(executable);
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

    chrome = await launchChrome(executable, profile);
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
        watchdog = setTimeout(() => reject(new Error(`Packaged browser evidence exceeded the eight-minute watchdog; exceptions=${browserExceptions.join("|")}; requests=${requestedUrls.join("|")}`)), WATCHDOG_MS);
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
    console.log(`Packaged Chrome/CDP evidence passed with ${executable} (${version}); ${result.cases.length} stress cases, two comment matrices, two complete complexity matrices, presenter failure evidence, and two canonical production success flows.`);
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
