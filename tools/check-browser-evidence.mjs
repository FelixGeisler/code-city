import assert from "node:assert/strict";
import { execFile } from "node:child_process";
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
const CSP = "default-src 'none'; base-uri 'none'; connect-src 'self' https://api.github.com https://raw.githubusercontent.com; form-action 'none'; frame-src 'none'; object-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; worker-src 'self'";

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function chromeCandidates() {
  return [
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"),
    process.env["PROGRAMFILES(X86)"] && path.join(process.env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe"),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
  ].filter(Boolean);
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
  const escaped = executable.replaceAll("'", "''");
  const version = await new Promise((resolve, reject) => execFile(
    "powershell.exe",
    ["-NoProfile", "-Command", `(Get-Item -LiteralPath '${escaped}').VersionInfo.ProductVersion`],
    { encoding: "utf8" },
    (error, stdout) => error ? reject(error) : resolve(stdout.trim()),
  ));
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

function validateBrowserResult(result, expectedAssets) {
  exactKeys(result, ["schemaVersion", "assetRequests", "cases", "matrixRuns", "browserExceptions", "unexpectedNetworkRequests", "overallPass"], "Browser result");
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
    console.log(`Packaged Chrome/CDP evidence passed with ${executable} (${version}); ${result.cases.length} stress cases and two complete matrix runs.`);
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
