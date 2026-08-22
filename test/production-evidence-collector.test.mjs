import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

import {
  PARENT_ISSUE_BODY_SHA256,
  PRODUCTION_ORIGIN,
  collectProductionEvidence,
  computeGitBlobId,
  computeModelSha256,
  createWorkerObserverSource,
  normalizeSourceBytes,
  parseCollectorArguments,
  projectSourceCandidates,
  readBoundedResponseBody,
  verifyDeploymentBinding,
} from "../tools/collect-production-evidence.mjs";
import {
  CHROME_ARGUMENTS,
  discoverInstalledChrome,
  launchInstalledChrome,
} from "../tools/chrome-cdp.mjs";
import { serializePackageManifest } from "../tools/package-manifest.mjs";
import { validateEvidencePacket } from "../tools/production-evidence-schema.mjs";

const EVENT = "a".repeat(40);
const ROOT = "b".repeat(40);
const REACT = "c".repeat(40);
const REACT_ROOT = "d".repeat(40);
const BLOB = "e".repeat(40);
const CSP = "default-src 'none'; base-uri 'none'; connect-src 'self' https://api.github.com https://raw.githubusercontent.com; form-action 'none'; frame-src 'none'; object-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; worker-src 'self'";

function response(body, { status = 200, url, headers = {} } = {}) {
  const value = new Response(body, { status, headers });
  Object.defineProperties(value, {
    url: { value: url, configurable: true },
    redirected: { value: false, configurable: true },
  });
  return value;
}

function directRequest(items, now, stage, url, applicationCall = false) {
  const startedMs = now();
  const endedMs = now();
  items.push({
    sequence: items.length + 1,
    stage,
    method: "GET",
    requestedUrl: url,
    finalUrl: url,
    applicationCall,
    status: 200,
    startedMs,
    endedMs,
    headerNames: ["access-control-allow-origin"],
    corsAllowOrigin: "*",
    rateLimit: { limit: null, remaining: null, reset: null },
    authorizationAbsent: true,
    cookieAbsent: true,
    refererAbsent: true,
    redirected: false,
  });
}

function revisionUrl(repository) { return `https://api.github.com/repos/${repository}/commits?per_page=1&page=1`; }
function commitUrl(repository, revision) { return `https://api.github.com/repos/${repository}/git/commits/${revision}`; }
function treeUrl(repository, root) { return `https://api.github.com/repos/${repository}/git/trees/${root}?recursive=1`; }
function rawUrl(repository, revision, sourcePath) { return `https://raw.githubusercontent.com/${repository}/${revision}/${sourcePath}`; }

function candidates() {
  let runningAggregate = 0;
  return Array.from({ length: 4001 }, (_, offset) => {
    runningAggregate += 1;
    return {
      index: offset + 1,
      path: `${String(offset + 1).padStart(4, "0")}.ts`,
      blobId: BLOB,
      normalizedBytes: 1,
      runningAggregate,
      hashMatched: true,
      contentValid: true,
    };
  });
}

function appendSequence(items, now, repository, revision, root, paths, applicationCall, emit = {}) {
  directRequest(items, now, "revision", revisionUrl(repository), applicationCall);
  emit.revision?.();
  directRequest(items, now, "commit", commitUrl(repository, revision), applicationCall);
  directRequest(items, now, "tree", treeUrl(repository, root), applicationCall);
  emit.inventory?.();
  for (const sourcePath of paths) directRequest(items, now, "raw", rawUrl(repository, revision, sourcePath), applicationCall);
}

test("production CLI accepts only the exact ordered three-option contract", () => {
  const valid = ["--origin", PRODUCTION_ORIGIN, "--manifest", "build/publication/package-manifest.json", "--output", "build/production-evidence"];
  assert.deepEqual(parseCollectorArguments(valid), {
    origin: PRODUCTION_ORIGIN,
    manifestPath: path.resolve(valid[3]),
    output: path.resolve(valid[5]),
  });
  const invalid = [
    [], valid.slice(0, -1), [...valid, "extra"],
    ["--manifest", valid[3], "--origin", valid[1], "--output", valid[5]],
    ["--origin", valid[1], "--origin", valid[1], "--output", valid[5]],
    ["--origin", "http://127.0.0.1/", "--manifest", valid[3], "--output", valid[5]],
    ["--origin", valid[1], "--manifest", "--output", "x", "--output"],
  ];
  for (const args of invalid) assert.throws(() => parseCollectorArguments(args), /invalid collector invocation/u);
});

test("direct invalid CLI emits only the fixed safe summary and never creates output", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "collector-cli-test-"));
  const output = path.join(temporary, "packet");
  const child = spawn(process.execPath, ["tools/collect-production-evidence.mjs", "--output", output], {
    cwd: path.resolve("."), stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = ""; let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(code, 1);
  assert.equal(stdout, "");
  assert.equal(stderr, "Production evidence collection failed safely.\n");
  await assert.rejects(import("node:fs/promises").then(({ lstat }) => lstat(output)), { code: "ENOENT" });
  await rm(temporary, { recursive: true, force: true });
});

test("bounded response reader accepts its boundary and rejects boundary plus one", async () => {
  assert.deepEqual([...await readBoundedResponseBody(response(Uint8Array.of(1, 2, 3)), 3)], [1, 2, 3]);
  await assert.rejects(readBoundedResponseBody(response(Uint8Array.of(1, 2, 3, 4)), 3), /exceeds cap/u);
});

test("independent candidate projection applies regular-kind, boundary, suffix, NFC, and unsigned UTF-8 order", () => {
  const entries = [
    { path: "z.TS", mode: "100644", type: "blob", sha: BLOB },
    { path: "vendor", mode: "160000", type: "commit", sha: BLOB },
    { path: "vendor/ignored.ts", mode: "nonsense", type: "nonsense" },
    { path: "a.jsx", mode: "100755", type: "blob", sha: BLOB },
    { path: "readme.md", mode: "100644", type: "blob", sha: BLOB },
    { path: "é.mjs", mode: "100644", type: "blob", sha: BLOB },
  ];
  assert.deepEqual(projectSourceCandidates(entries, 40).map(({ canonicalPath }) => canonicalPath), ["a.jsx", "z.TS", "é.mjs"]);
  assert.throws(() => projectSourceCandidates([], 40), /no supported/u);
  assert.throws(() => projectSourceCandidates([
    { path: "café.ts", mode: "100644", type: "blob", sha: BLOB },
    { path: "café.ts", mode: "100644", type: "blob", sha: BLOB },
  ], 40), /invalid tree entry/u);
});

test("Git blob and strict normalization facts are exact and bounded-view model digest includes count", () => {
  const source = new TextEncoder().encode("a\r\nb\rc\n");
  assert.equal(normalizeSourceBytes(source), 6);
  assert.equal(computeGitBlobId(new TextEncoder().encode("test\n"), 40), "9daeafb9864cf43055ae93beb0afd6c7d144bfa4");
  assert.throws(() => normalizeSourceBytes(Uint8Array.of(0xc3, 0x28)));
  assert.throws(() => normalizeSourceBytes(new TextEncoder().encode("a\0b")), /NUL/u);

  const backing = new Uint8Array([99, 1, 2, 98, 3, 4, 97, 5, 6, 96, 7, 8]);
  const model = {
    count: 7,
    origins: new Uint8Array(backing.buffer, 1, 2),
    sizes: new Uint8Array(backing.buffer, 4, 2),
    rgba: new Uint8Array(backing.buffer, 7, 2),
    bounds: new Uint8Array(backing.buffer, 10, 2),
  };
  const expected = createHash("sha256").update(Uint8Array.of(7, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8)).digest("hex");
  assert.equal(computeModelSha256(model), expected);
});

test("injected Worker observer preserves application listener identity, order, this, removal, cardinality, and exceptions", () => {
  const emitted = [];
  class FakeWorker {
    constructor() { this.listeners = []; this.exceptions = []; }
    addEventListener(type, listener) { this.listeners.push({ type, listener }); }
    removeEventListener(type, listener) { this.listeners = this.listeners.filter((item) => item.type !== type || item.listener !== listener); }
    dispatch(event) {
      for (const item of [...this.listeners]) if (item.type === "message") {
        try { item.listener.call(this, event); } catch (error) { this.exceptions.push(error); }
      }
    }
  }
  const context = {
    Worker: FakeWorker,
    __codeCityCollectorEvidence: (value) => emitted.push(value),
    ArrayBuffer, Uint8Array, Uint32Array, Number, Object, Reflect, Set, TypeError, JSON,
  };
  vm.runInNewContext(createWorkerObserverSource(), context);
  const worker = new context.Worker("worker.js");
  const order = [];
  const model = { count: 1, origins: Uint8Array.of(1), sizes: Uint8Array.of(2), rgba: Uint8Array.of(3), bounds: Uint8Array.of(4) };
  const message = { type: "SUCCESS", generation: 1, revision: EVENT, model };
  const event = { data: message };
  function first(received) { order.push("first"); assert.equal(this, worker); assert.equal(received, event); assert.equal(received.data, message); assert.equal(received.data.model, model); }
  function throwing() { order.push("throwing"); throw new Error("application exception"); }
  function last() { order.push("last"); }
  worker.addEventListener("message", first);
  worker.addEventListener("message", throwing);
  worker.addEventListener("message", last);
  worker.dispatch(event);
  worker.removeEventListener("message", first);
  worker.dispatch({ data: { type: "ATTEMPT_DRAINED", generation: 1 } });
  assert.deepEqual(order, ["first", "throwing", "last", "throwing", "last"]);
  assert.equal(worker.exceptions.length, 2);
  assert.equal(emitted.length, 2);
  const observed = JSON.parse(emitted[0]);
  assert.deepEqual(Object.keys(observed), ["type", "generation", "revision", "modelSha256"]);
  assert.equal(observed.modelSha256, computeModelSha256(model));
});

test("Chrome discovery excludes LOCALAPPDATA and launch uses exactly the approved flags", async () => {
  const checked = [];
  const discovery = await discoverInstalledChrome({
    platform: "win32",
    environment: { PROGRAMFILES: "C:\\Program Files", "PROGRAMFILES(X86)": "C:\\Program Files (x86)", LOCALAPPDATA: "C:\\Users\\x" },
    statImpl: async (candidate) => {
      checked.push(candidate);
      if (candidate.startsWith("C:\\Program Files (x86)")) return { isFile: () => true };
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
  });
  assert.equal(discovery.category, "windows-program-files");
  assert(checked.every((candidate) => !candidate.includes("Users\\x")));

  let observed;
  const child = {
    stderr: { on(_name, listener) { queueMicrotask(() => listener("DevTools listening on ws://127.0.0.1:9222/devtools/browser/abc-123\n")); } },
    once() {},
  };
  const launched = await launchInstalledChrome(discovery, path.resolve("fake-profile"), {
    spawnImpl(executable, args, options) { observed = { executable, args, options }; return child; },
  });
  assert.equal(launched.websocketUrl, "ws://127.0.0.1:9222/devtools/browser/abc-123");
  assert.deepEqual(observed.args, CHROME_ARGUMENTS.map((argument) => argument.replace("<temporary profile>", path.resolve("fake-profile"))));
  assert(!observed.args.some((argument) => argument.includes("proxy") || argument.includes("swiftshader") || argument === "about:blank"));
});

test("deployment proof accepts one active exact match and rejects duplicate, pagination, inactive, origin, redirect, cap, and shape mismatches", async () => {
  const listUrl = `https://api.github.com/repos/FelixGeisler/code-city/deployments?sha=${EVENT}&environment=github-pages&per_page=100&page=1`;
  const statusUrl = "https://api.github.com/repos/FelixGeisler/code-city/deployments/7/statuses?per_page=100&page=1";
  const calls = [];
  const makeFetch = (list, statuses, listHeaders = {}) => async (url) => {
    calls.push(url);
    if (url === listUrl) return response(`${JSON.stringify(list)}\n`, { url, headers: listHeaders });
    if (url === statusUrl) return response(`${JSON.stringify(statuses)}\n`, { url });
    throw new Error("provider URL was followed");
  };
  const requestItems = []; let time = 0;
  const result = await verifyDeploymentBinding({
    eventSha: EVENT, origin: PRODUCTION_ORIGIN,
    fetchImpl: makeFetch([{ id: 7, sha: EVENT, environment: "github-pages", task: "deploy", environment_url: "https://evil.invalid/" }], [
      { state: "success", environment_url: PRODUCTION_ORIGIN },
      { state: "queued", environment_url: PRODUCTION_ORIGIN },
    ]),
    now: () => ++time, requestItems,
  });
  assert.deepEqual(result, { deploymentId: 7, deployedSha: EVENT });
  assert.deepEqual(calls, [listUrl, statusUrl]);
  assert.equal(requestItems.length, 2);

  const failures = [
    [[], [{ state: "success", environment_url: PRODUCTION_ORIGIN }], {}],
    [[{ id: 7, sha: EVENT, environment: "github-pages", task: "deploy" }, { id: 8, sha: EVENT, environment: "github-pages", task: "deploy" }], [], {}],
    [[{ id: 7, sha: EVENT, environment: "github-pages", task: "deploy" }], [{ state: "failure", environment_url: PRODUCTION_ORIGIN }], {}],
    [[{ id: 7, sha: EVENT, environment: "github-pages", task: "deploy" }], [{ state: "success", environment_url: "https://evil.invalid/" }], {}],
    [[{ id: 7, sha: EVENT, environment: "github-pages", task: "deploy" }], [{ state: "success", environment_url: PRODUCTION_ORIGIN }, { state: "inactive", environment_url: PRODUCTION_ORIGIN }], {}],
    [[{ id: 7, sha: EVENT, environment: "github-pages", task: "deploy" }], [{ state: "success", environment_url: PRODUCTION_ORIGIN }], { Link: `<${listUrl}&page=2>; rel="next"` }],
    [[{ id: "7", sha: EVENT, environment: "github-pages", task: "deploy" }], [], {}],
  ];
  for (const [list, statuses, headers] of failures) {
    await assert.rejects(verifyDeploymentBinding({
      eventSha: EVENT, origin: PRODUCTION_ORIGIN, fetchImpl: makeFetch(list, statuses, headers),
      now: () => ++time, requestItems: [],
    }), (error) => error.stage === "artifact" && error.reason === "artifact-mismatch");
  }
});

test("collector-commit mismatch emits a marked schema-valid artifact failure without starting Chrome", async () => {
  const manifest = {
    schemaVersion: 2,
    basePath: "/code-city/",
    policy: { contentSecurityPolicy: CSP, referrerPolicy: "no-referrer", connectOrigins: ["'self'", "https://api.github.com", "https://raw.githubusercontent.com"] },
    files: [{ path: "index.html", mediaType: "text/html", byteLength: 1, sha256: "f".repeat(64) }],
  };
  const manifestBytes = serializePackageManifest(manifest);
  let stored;
  const result = await collectProductionEvidence({ origin: PRODUCTION_ORIGIN, manifestPath: path.resolve("manifest.json"), output: path.resolve("failed-packet") }, {
    clock: (() => { let value = 0; return () => value++; })(),
    readPublicationInput: async () => ({ manifestBytes, manifest, publicationRecordBytes: new TextEncoder().encode("record\n"), publicationRecord: { eventSha: EVENT, runId: 1, runAttempt: 1 } }),
    deriveCollectorCommit: async () => "9".repeat(40),
    discoverInstalledChrome: async () => { throw new Error("Chrome must not start"); },
    writeValidatedEvidencePacket: async (_output, packet) => { stored = validateEvidencePacket(packet.files, packet.binding); },
    readValidatedEvidencePacket: async () => stored,
  });
  assert.equal(result.status, "fail");
  assert.equal(result.reason, "artifact-mismatch");
  const artifact = JSON.parse(new TextDecoder().decode(stored.files.get("artifact.json")));
  const lifecycle = JSON.parse(new TextDecoder().decode(stored.files.get("lifecycle.json")));
  assert.equal(artifact.status, "fail");
  assert.deepEqual(lifecycle.data.events.map(({ event }) => event), ["collector-start", "collector-failed"]);
});

test("full seam-driven collector maps the exact pass lifecycle, dynamic smoke K, 4,001 boundary, schema, writer, and read-back", async () => {
  const manifest = {
    schemaVersion: 2,
    basePath: "/code-city/",
    policy: { contentSecurityPolicy: CSP, referrerPolicy: "no-referrer", connectOrigins: ["'self'", "https://api.github.com", "https://raw.githubusercontent.com"] },
    files: [{ path: "index.html", mediaType: "text/html", byteLength: 1, sha256: "f".repeat(64) }],
  };
  const manifestBytes = serializePackageManifest(manifest);
  const publicationRecordBytes = new TextEncoder().encode("record\n");
  const shared = candidates();
  let tick = 0;
  let stored;
  const output = path.resolve("build/fake-production-evidence");
  const result = await collectProductionEvidence({ origin: PRODUCTION_ORIGIN, manifestPath: path.resolve("manifest.json"), output }, {
    clock: () => tick++,
    readPublicationInput: async () => ({
      manifestBytes, manifest, publicationRecordBytes,
      publicationRecord: { eventSha: EVENT, runId: 123, runAttempt: 1 },
    }),
    deriveCollectorCommit: async () => EVENT,
    discoverInstalledChrome: async () => ({ executable: "hidden", category: "windows-program-files" }),
    readInstalledChromeVersion: async () => "140.0.1.2",
    verifyDeploymentBinding: async ({ now, requestItems }) => {
      directRequest(requestItems, now, "deployment", `https://api.github.com/repos/FelixGeisler/code-city/deployments?sha=${EVENT}&environment=github-pages&per_page=100&page=1`);
      directRequest(requestItems, now, "deployment", "https://api.github.com/repos/FelixGeisler/code-city/deployments/7/statuses?per_page=100&page=1");
      return { deploymentId: 7, deployedSha: EVENT };
    },
    verifyProductionAssets: async ({ now, requestItems }) => {
      directRequest(requestItems, now, "asset", `${PRODUCTION_ORIGIN}index.html`);
      return [{ path: "index.html", expectedMediaType: "text/html", observedMediaType: "text/html", expectedBytes: 1, observedBytes: 1, expectedSha256: "f".repeat(64), observedSha256: "f".repeat(64), match: true }];
    },
    mkdtemp: async () => path.resolve("fake-profile"),
    rm: async () => {},
    createBrowserEvidenceSession: async ({ now, requestItems }) => ({
      cdpVersion: "1.3",
      async collectSmoke(emit, startedMs) {
        directRequest(requestItems, now, "revision", revisionUrl("FelixGeisler/code-city"), true);
        emit("revision-selected", 1);
        appendSequence(requestItems, now, "FelixGeisler/code-city", EVENT, ROOT, ["src/a.ts", "src/b.ts"], true);
        requestItems.splice(requestItems.length - 5, 1);
        requestItems.forEach((item, index) => { item.sequence = index + 1; });
        const published = emit("city-published", 1);
        return { repositoryUrl: "https://github.com/FelixGeisler/code-city", revision: EVENT, rootTree: ROOT, terminal: "success", canvasCount: 1, modelSha256: "1".repeat(64), startedMs, endedMs: published.atMs, providerGetCount: 5 };
      },
      clearTrace() {},
      async collectCapacity(qualification, emit, startedMs) {
        appendSequence(requestItems, now, "facebook/react", REACT, REACT_ROOT, shared.map(({ path: sourcePath }) => sourcePath), true, {
          revision: () => emit("revision-selected", 2), inventory: () => emit("inventory-complete", 2),
        });
        emit("limit-failure", 2); emit("request-quiescent", 2); const worker = emit("worker-quiescent", 2);
        return { repositoryUrl: "https://github.com/facebook/react", revision: REACT, rootTree: REACT_ROOT, terminal: "Repository exceeds Code City limits", revisionDisplayed: true, cityPresent: false, priorCityRemoved: true, rawRequestCount: 4001, maxOverlap: 1, noLaterRequest: true, workerQuiescent: true, candidates: structuredClone(qualification.candidates), startedMs, endedMs: worker.atMs };
      },
      async close() {},
    }),
    qualifyRepository: async ({ now, requestItems }) => {
      appendSequence(requestItems, now, "facebook/react", REACT, REACT_ROOT, shared.map(({ path: sourcePath }) => sourcePath), false);
      return { repositoryUrl: "https://github.com/facebook/react", revision: REACT, rootTree: REACT_ROOT, treeEntries: 5000, truncated: false, candidates: shared };
    },
    writeValidatedEvidencePacket: async (_output, packet) => { stored = validateEvidencePacket(packet.files, packet.binding); },
    readValidatedEvidencePacket: async () => stored,
  });
  assert.deepEqual(result, { packetDigest: stored.packetDigest, status: "pass", reason: "none" });
  const lifecycle = JSON.parse(new TextDecoder().decode(stored.files.get("lifecycle.json")));
  assert.deepEqual(lifecycle.data.events.map(({ event, generation }) => [event, generation]), [
    ["collector-start", 0], ["artifact-verified", 0], ["smoke-start", 1], ["revision-selected", 1], ["city-published", 1], ["trace-reset", 0],
    ["qualification-start", 0], ["qualification-complete", 0], ["capacity-start", 2], ["revision-selected", 2], ["inventory-complete", 2],
    ["limit-failure", 2], ["request-quiescent", 2], ["worker-quiescent", 2], ["collector-complete", 0],
  ]);
  const smoke = JSON.parse(new TextDecoder().decode(stored.files.get("smoke.json")));
  assert.equal(smoke.data.providerGetCount, 5);
});
