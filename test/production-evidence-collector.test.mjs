import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

import {
  PARENT_ISSUE_BODY_SHA256,
  PRODUCTION_ORIGIN,
  RESPONSE_CAPS,
  CollectorFailure,
  candidateBlobId,
  collectProductionEvidence,
  computeGitBlobId,
  computeModelSha256,
  createBrowserEvidenceSession,
  createWorkerObserverSource,
  deriveCollectorCommit,
  hasNextLinkRelation,
  normalizeSourceBytes,
  parseCollectorArguments,
  projectSourceCandidates,
  qualifyRepository,
  readBoundedResponseBody,
  recordCdpTransferSize,
  responseCapForRoute,
  safeHeaderFacts,
  verifyDeploymentBinding,
  verifyProductionAssets,
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

function response(body, { status = 200, url, headers = {}, redirected = false } = {}) {
  const value = new Response(body, { status, headers });
  Object.defineProperties(value, {
    url: { value: url, configurable: true },
    redirected: { value: redirected, configurable: true },
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

const NATIVE_SOURCE = new TextEncoder().encode("x");
const NATIVE_BLOB = computeGitBlobId(NATIVE_SOURCE, 40);
const NATIVE_ENTRIES = Array.from({ length: 4001 }, (_, offset) => ({
  path: `${String(offset + 1).padStart(4, "0")}.ts`, mode: "100644", type: "blob", sha: NATIVE_BLOB,
}));

function paddedJson(value, byteLength) {
  const json = JSON.stringify(value);
  assert(json.length <= byteLength);
  return `${json}${" ".repeat(byteLength - json.length)}`;
}

function nativeQualificationFetch(overrides = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    let stage;
    let body;
    if (url === revisionUrl("facebook/react")) {
      stage = "revision";
      body = JSON.stringify([{ sha: REACT }]);
    } else if (url === commitUrl("facebook/react", REACT)) {
      stage = "commit";
      body = JSON.stringify({ sha: REACT, tree: { sha: REACT_ROOT } });
    } else if (url === treeUrl("facebook/react", REACT_ROOT)) {
      stage = "tree";
      body = JSON.stringify({ sha: REACT_ROOT, truncated: false, tree: NATIVE_ENTRIES });
    } else if (url.startsWith(`https://raw.githubusercontent.com/facebook/react/${REACT}/`)) {
      stage = "raw";
      body = NATIVE_SOURCE;
    } else {
      throw new Error(`unexpected controlled URL: ${url}`);
    }
    const replacement = typeof overrides[stage] === "function"
      ? overrides[stage]({ url, call: calls.filter((item) => item.url === url).length, body })
      : overrides[stage];
    const selected = replacement ?? {};
    return response(selected.body ?? body, {
      url: selected.url ?? url,
      status: selected.status ?? 200,
      redirected: selected.redirected ?? false,
      headers: selected.headers ?? { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
    });
  };
  return { calls, fetchImpl };
}

async function runNativeQualification(overrides = {}) {
  const controlled = nativeQualificationFetch(overrides);
  let tick = 0;
  const requestItems = [];
  const progress = await qualifyRepository({ fetchImpl: controlled.fetchImpl, now: () => ++tick, requestItems });
  return { ...controlled, requestItems, progress };
}

function qualificationFetchForSources(sourceForIndex) {
  const sources = Array.from({ length: 4001 }, (_, index) => sourceForIndex(index));
  const entries = sources.map((source, index) => ({
    path: `${String(index + 1).padStart(4, "0")}.ts`, mode: "100644", type: "blob",
    sha: computeGitBlobId(source, 40),
  }));
  return nativeQualificationFetch({
    tree: { body: JSON.stringify({ sha: REACT_ROOT, truncated: false, tree: entries }) },
    raw: ({ url }) => {
      const match = /(\d{4})\.ts$/u.exec(url);
      assert(match);
      return { body: sources[Number(match[1]) - 1] };
    },
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

test("page-side Worker observer preserves application constructor and listener transparency, order, this, removal, cardinality, and exceptions", () => {
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
  assert(worker instanceof FakeWorker);
  assert.equal(Object.getPrototypeOf(context.Worker), FakeWorker);
  assert.equal(context.Worker.prototype, FakeWorker.prototype);
  assert.equal(worker.addEventListener, FakeWorker.prototype.addEventListener);
  assert.equal(worker.removeEventListener, FakeWorker.prototype.removeEventListener);
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
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.kill = () => { child.exitCode = 0; child.emit("exit", 0); };
  const launchedPromise = launchInstalledChrome(discovery, path.resolve("fake-profile"), {
    spawnImpl(executable, args, options) { observed = { executable, args, options }; return child; },
  });
  queueMicrotask(() => child.stderr.emit("data", "DevTools listening on ws://127.0.0.1:9222/devtools/browser/abc-123\n"));
  const launched = await launchedPromise;
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

test("native qualification completes the exact 4,004-request pass and classifies real identity, CORS, tree, hash, and content failures", async () => {
  const passed = await runNativeQualification();
  assert.equal(passed.calls.length, 4004);
  assert.deepEqual(passed.calls.slice(0, 3).map(({ url }) => url), [
    revisionUrl("facebook/react"), commitUrl("facebook/react", REACT), treeUrl("facebook/react", REACT_ROOT),
  ]);
  assert(passed.calls.slice(3).every(({ url }, index) => url === rawUrl("facebook/react", REACT, NATIVE_ENTRIES[index].path)));
  assert.equal(passed.progress.candidates.length, 4001);
  assert.equal(passed.requestItems.length, 4004);
  assert(passed.calls.every(({ init }) => init.credentials === "omit" && init.redirect === "error" && init.referrer === ""));

  const cases = [
    ["identity-mismatch", { revision: { body: JSON.stringify([{ sha: "invalid" }]) } }],
    ["identity-mismatch", { commit: { body: JSON.stringify({ sha: EVENT, tree: { sha: REACT_ROOT } }) } }],
    ["identity-mismatch", { commit: { body: JSON.stringify({ sha: REACT }) } }],
    ["identity-mismatch", { tree: { body: JSON.stringify({ sha: ROOT, truncated: false, tree: NATIVE_ENTRIES }) } }],
    ["cors-failure", { revision: { headers: { "Content-Type": "application/json" } } }],
    ["tree-incomplete", { tree: { body: JSON.stringify({ sha: REACT_ROOT, truncated: true, tree: NATIVE_ENTRIES }) } }],
    ["hash-mismatch", { raw: { body: new TextEncoder().encode("different") } }],
    ["content-invalid", { raw: { body: Uint8Array.of(0) } }],
  ];
  for (const [reason, overrides] of cases) {
    const controlled = nativeQualificationFetch(overrides);
    await assert.rejects(qualifyRepository({ fetchImpl: controlled.fetchImpl, now: () => 1, requestItems: [] }),
      (error) => error.stage === "qualification" && error.reason === reason, reason);
  }
});

test("native qualification enforces each revision, commit, tree, and raw response boundary and boundary plus one", async () => {
  const routeCases = [
    ["revision", RESPONSE_CAPS.revision, [{ sha: REACT }], { commit: { body: JSON.stringify({ sha: EVENT, tree: { sha: REACT_ROOT } }) } }, "identity-mismatch"],
    ["commit", RESPONSE_CAPS.commit, { sha: REACT, tree: { sha: REACT_ROOT } }, { tree: { body: JSON.stringify({ sha: REACT_ROOT, truncated: true, tree: [] }) } }, "tree-incomplete"],
    ["tree", RESPONSE_CAPS.tree, { sha: REACT_ROOT, truncated: false, tree: NATIVE_ENTRIES }, {}, null],
    ["raw", RESPONSE_CAPS.raw, null, {}, "content-invalid"],
  ];
  for (const [stage, cap, value, later, boundaryReason] of routeCases) {
    const boundaryBody = stage === "raw" ? new Uint8Array(cap).fill(0x78) : paddedJson(value, cap);
    const boundaryOverrides = { ...later, [stage]: { body: boundaryBody } };
    if (stage === "raw") {
      const entries = NATIVE_ENTRIES.map((entry, index) => (
        index === 0 ? { ...entry, sha: computeGitBlobId(boundaryBody, 40) } : entry
      ));
      boundaryOverrides.tree = { body: JSON.stringify({ sha: REACT_ROOT, truncated: false, tree: entries }) };
    }
    const boundary = nativeQualificationFetch(boundaryOverrides);
    if (boundaryReason) {
      await assert.rejects(qualifyRepository({ fetchImpl: boundary.fetchImpl, now: () => 1, requestItems: [] }),
        (error) => error.reason === boundaryReason, `${stage} boundary`);
    } else {
      const progress = await qualifyRepository({ fetchImpl: boundary.fetchImpl, now: () => 1, requestItems: [] });
      assert.equal(progress.candidates.length, 4001, `${stage} boundary`);
    }

    const overflow = nativeQualificationFetch({ [stage]: { body: new Uint8Array(cap + 1) } });
    await assert.rejects(qualifyRepository({ fetchImpl: overflow.fetchImpl, now: () => 1, requestItems: [] }),
      (error) => error.reason === "provider-failure", `${stage} boundary + 1`);
  }
});

test("qualification preserves only schema-safe prefixes at 2 MiB and 40 MiB boundaries and classifies +1, UTF-8, NUL, and hash failures", async () => {
  const twoMiB = new Uint8Array(2 * 1024 * 1024).fill(0x78);
  const empty = new Uint8Array();

  for (const [name, sourceForIndex, expectedAggregate] of [
    ["per-module boundary", (index) => index === 0 ? twoMiB : empty, twoMiB.byteLength],
    ["aggregate boundary", (index) => index < 20 ? twoMiB : empty, 40 * 1024 * 1024],
  ]) {
    const controlled = qualificationFetchForSources(sourceForIndex);
    const progress = { repositoryUrl: "https://github.com/facebook/react", revision: null, rootTree: null, treeEntries: null, truncated: null, candidates: [] };
    await qualifyRepository({ fetchImpl: controlled.fetchImpl, now: () => 1, requestItems: [], progress });
    assert.equal(progress.candidates.length, 4001, name);
    assert.equal(progress.candidates.at(-1).runningAggregate, expectedAggregate, name);
  }

  for (const [name, sourceForIndex, prefixLength] of [
    ["per-module +1", (index) => index === 0 ? new Uint8Array(2 * 1024 * 1024 + 1).fill(0x78) : empty, 0],
    ["aggregate +1", (index) => index < 20 ? twoMiB : index === 20 ? Uint8Array.of(0x78) : empty, 20],
    ["invalid UTF-8", (index) => index === 0 ? Uint8Array.of(0xc3, 0x28) : empty, 0],
    ["NUL", (index) => index === 0 ? Uint8Array.of(0) : empty, 0],
  ]) {
    const controlled = qualificationFetchForSources(sourceForIndex);
    const progress = { repositoryUrl: "https://github.com/facebook/react", revision: null, rootTree: null, treeEntries: null, truncated: null, candidates: [] };
    await assert.rejects(qualifyRepository({ fetchImpl: controlled.fetchImpl, now: () => 1, requestItems: [], progress }),
      (error) => error.stage === "qualification" && error.reason === "content-invalid", name);
    assert.equal(progress.candidates.length, prefixLength, name);
    assert(progress.candidates.every((candidate) => candidate.contentValid), name);
  }

  const hashProgress = { repositoryUrl: "https://github.com/facebook/react", revision: null, rootTree: null, treeEntries: null, truncated: null, candidates: [] };
  const hash = nativeQualificationFetch({ raw: { body: new TextEncoder().encode("different") } });
  await assert.rejects(qualifyRepository({ fetchImpl: hash.fetchImpl, now: () => 1, requestItems: [], progress: hashProgress }),
    (error) => error.stage === "qualification" && error.reason === "hash-mismatch");
  assert.equal(hashProgress.candidates.length, 1);
  assert.equal(hashProgress.candidates[0].hashMatched, false);
});

test("native deployment fetches enforce both response boundaries and boundary plus one", async () => {
  const listUrl = `https://api.github.com/repos/FelixGeisler/code-city/deployments?sha=${EVENT}&environment=github-pages&per_page=100&page=1`;
  const statusUrl = "https://api.github.com/repos/FelixGeisler/code-city/deployments/7/statuses?per_page=100&page=1";
  const list = [{ id: 7, sha: EVENT, environment: "github-pages", task: "deploy" }];
  const statuses = [{ state: "success", environment_url: PRODUCTION_ORIGIN }];
  for (const selectedStage of ["list", "status"]) {
    const fetchImpl = async (url) => response(
      selectedStage === "list" && url === listUrl ? paddedJson(list, RESPONSE_CAPS.deployment)
        : selectedStage === "status" && url === statusUrl ? paddedJson(statuses, RESPONSE_CAPS.deployment)
          : JSON.stringify(url === listUrl ? list : statuses),
      { url },
    );
    assert.deepEqual(await verifyDeploymentBinding({
      eventSha: EVENT, origin: PRODUCTION_ORIGIN, fetchImpl, now: () => 1, requestItems: [],
    }), { deploymentId: 7, deployedSha: EVENT });

    await assert.rejects(verifyDeploymentBinding({
      eventSha: EVENT, origin: PRODUCTION_ORIGIN,
      fetchImpl: async (url) => response(
        (selectedStage === "list" && url === listUrl) || (selectedStage === "status" && url === statusUrl)
          ? new Uint8Array(RESPONSE_CAPS.deployment + 1)
          : JSON.stringify(url === listUrl ? list : statuses),
        { url },
      ),
      now: () => 1, requestItems: [],
    }), (error) => error.stage === "artifact" && error.reason === "artifact-mismatch", `${selectedStage} boundary + 1`);
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

test("artifact failure packets preserve each publication, platform, Chrome, and deployment fact as soon as observed", async () => {
  for (const stop of ["discovery", "version", "deployment", "setup"]) {
    let stored;
    const seams = collectorMatrixSeams({ packetSink(value) { if (value) stored = value; return stored; } });
    if (stop === "discovery") seams.discoverInstalledChrome = async () => { throw new Error("controlled discovery failure"); };
    if (stop === "version") seams.readInstalledChromeVersion = async () => { throw new Error("controlled version failure"); };
    if (stop === "deployment") seams.verifyDeploymentBinding = async ({ progress }) => {
      Object.assign(progress, { deploymentId: 7, deployedSha: EVENT });
      throw new CollectorFailure("artifact", "artifact-mismatch");
    };
    if (stop === "setup") seams.createBrowserEvidenceSession = async (args) => {
      const harness = fakeCdpHarness({ failMethod: "Page.enable" });
      const child = fakeChromeChild();
      return createBrowserEvidenceSession({
        ...args,
        launchImpl: async () => ({ child, websocketUrl: "ws://127.0.0.1:1/devtools/browser/id" }),
        connectImpl: () => harness.cdp,
      });
    };
    const result = await collectProductionEvidence({
      origin: PRODUCTION_ORIGIN, manifestPath: path.resolve("manifest.json"), output: path.resolve(`artifact-progress-${stop}`),
    }, seams);
    assert.equal(result.status, "fail", stop);
    const artifact = JSON.parse(new TextDecoder().decode(stored.files.get("artifact.json")));
    const lifecycle = JSON.parse(new TextDecoder().decode(stored.files.get("lifecycle.json")));
    assert.equal(artifact.data.eventSha, EVENT, stop);
    assert.equal(artifact.data.runId, 1, stop);
    assert.equal(artifact.data.runAttempt, 1, stop);
    assert.match(artifact.data.manifestSha256, /^[0-9a-f]{64}$/u, stop);
    assert.match(artifact.data.publicationRecordSha256, /^[0-9a-f]{64}$/u, stop);
    assert.equal(artifact.data.nodeVersion, process.version, stop);
    assert.notEqual(artifact.data.runnerOs, null, stop);
    assert.notEqual(artifact.data.runnerArch, null, stop);
    assert.equal(artifact.data.chromeExecutableCategory, stop === "discovery" ? null : "windows-program-files", stop);
    assert.equal(artifact.data.chromeVersion, ["deployment", "setup"].includes(stop) ? "140.0.1.2" : null, stop);
    assert.equal(artifact.data.deploymentId, ["deployment", "setup"].includes(stop) ? 7 : null, stop);
    assert.equal(artifact.data.deployedSha, ["deployment", "setup"].includes(stop) ? EVENT : null, stop);
    assert.equal(lifecycle.data.collectorCommit, EVENT, stop);
    assert.equal(lifecycle.data.cdpVersion, stop === "setup" ? "1.3" : null, stop);
    assert.equal(lifecycle.data.events.at(-1).event, "collector-failed", stop);
    if (stop === "setup") assert.deepEqual(lifecycle.data.events.map(({ event }) => event), [
      "collector-start", "artifact-verified", "collector-failed",
    ]);
  }
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

test("tree projection defers blob identity through the 4,001-fetch horizon and never inspects candidate 4,002", () => {
  let inspected4002 = false;
  const entries = Array.from({ length: 4002 }, (_, index) => {
    const entry = { path: `${String(index + 1).padStart(4, "0")}.ts`, mode: "100644", type: "blob", sha: BLOB };
    if (index === 4001) Object.defineProperty(entry, "sha", { enumerable: true, get() { inspected4002 = true; throw new Error("must not inspect"); } });
    return entry;
  });
  const projected = projectSourceCandidates(entries, 40);
  assert.equal(projected.length, 4002);
  for (let index = 0; index < 4001; index += 1) assert.equal(candidateBlobId(projected[index], 40), BLOB);
  assert.equal(inspected4002, false);
});

test("tree projection closes provider records, rejects proxies, and retains no provider entry or accessor", () => {
  let unrelatedReads = 0;
  const provider = {
    path: "src/a.ts", mode: "100644", type: "blob", sha: BLOB,
    get url() { unrelatedReads += 1; throw new Error("provider locator must not be read"); },
  };
  const [candidate] = projectSourceCandidates([provider], 40, Infinity);
  assert.deepEqual(Object.keys(candidate), ["rawPath", "canonicalPath", "mode", "type", "blobId"]);
  assert(Object.isFrozen(candidate));
  assert.equal(unrelatedReads, 0);
  provider.path = "changed.ts";
  provider.sha = "9".repeat(40);
  assert.deepEqual(candidate, {
    rawPath: "src/a.ts", canonicalPath: "src/a.ts", mode: "100644", type: "blob", blobId: BLOB,
  });
  assert.throws(() => projectSourceCandidates([new Proxy(provider, {})], 40), /invalid tree entry/u);
  assert(!Object.values(candidate).includes(provider));
});

test("RFC Link parsing rejects every next relation token form without substring false positives", () => {
  const nextValues = [
    '<https://api.github.test/page=2>; rel="next"',
    '<https://api.github.test/page=1>; rel="prev next"',
    '<https://api.github.test/page=1>; title="x", <https://api.github.test/page=2>; REL="Last NeXt"',
    '<https://api.github.test/page=2>; rel=NEXT',
    '<https://api.github.test/page=2>; type="application/json"; rel = "prev  next"',
  ];
  for (const value of nextValues) assert.equal(hasNextLinkRelation(value), true, value);
  for (const value of ["", '<x>; rel="prev"', '<x>; title="next"', '<x>; rel="next-page"']) assert.equal(hasNextLinkRelation(value), false, value);
});

test("wire-header minimization derives credential absence only from raw ExtraInfo names", () => {
  const responseHeaders = new Headers({ "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" });
  const absent = safeHeaderFacts({ Accept: "application/json" }, responseHeaders);
  assert.deepEqual([absent.authorizationAbsent, absent.cookieAbsent, absent.refererAbsent], [true, true, true]);
  for (const name of ["Authorization", "Cookie", "Referer"]) {
    const observed = safeHeaderFacts({ Accept: "application/json", [name]: "secret-not-retained" }, responseHeaders);
    assert.equal(observed[`${name.toLowerCase()}Absent`], false);
    assert(!observed.headerNames.includes(name.toLowerCase()));
    assert(!JSON.stringify(observed).includes("secret-not-retained"));
  }
});

test("every CDP route cap accepts the exact boundary and rejects boundary plus one before body retrieval", () => {
  for (const [stage, cap] of Object.entries(RESPONSE_CAPS)) {
    if (stage === "deployment") continue;
    assert.equal(responseCapForRoute({ stage }), cap);
    const entry = { cap };
    recordCdpTransferSize(entry, { dataLength: cap, encodedDataLength: cap });
    assert.throws(() => recordCdpTransferSize({ cap }, { dataLength: cap + 1 }), /before retrieval/u);
    assert.throws(() => recordCdpTransferSize({ cap }, { encodedDataLength: cap + 1 }), /before retrieval/u);
  }
});

test("collector commit binding rejects dirtiness anywhere in the checked-out dependency closure", async () => {
  const calls = [];
  const clean = async (_file, args) => {
    calls.push(args);
    if (args[0] === "rev-parse") return { stdout: `${EVENT}\n` };
    return { stdout: "" };
  };
  assert.equal(await deriveCollectorCommit({ execFileImpl: clean }), EVENT);
  assert(calls.some((args) => args[0] === "status" && args.includes("--untracked-files=all")));
  await assert.rejects(deriveCollectorCommit({ execFileImpl: async (_file, args) => {
    if (args[0] === "rev-parse") return { stdout: `${EVENT}\n` };
    if (args[0] === "status") return { stdout: " M tools/chrome-cdp.mjs\n" };
    return { stdout: "" };
  } }), /dirty/u);
});

test("production asset verification binds exact content, MIME, length, hash, URL, and streamed cap", async () => {
  const bytes = new TextEncoder().encode("asset");
  const expected = { path: "assets/app.js", mediaType: "text/javascript", byteLength: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
  const url = `${PRODUCTION_ORIGIN}assets/app.js`;
  const run = (body, options = {}) => verifyProductionAssets({
    manifest: { files: [expected] }, origin: PRODUCTION_ORIGIN,
    fetchImpl: async (requested, init) => {
      assert.equal(requested, url);
      assert.equal(init.redirect, "error");
      assert.equal(init.credentials, "omit");
      return response(body, { url: options.url ?? url, status: options.status ?? 200, redirected: options.redirected, headers: { "Content-Type": options.type ?? "text/javascript" } });
    },
    now: (() => { let tick = 0; return () => ++tick; })(), requestItems: [],
  });
  const files = await run(bytes);
  assert.equal(files[0].match, true);
  for (const attempt of [
    () => run(new TextEncoder().encode("other")),
    () => run(bytes, { type: "application/javascript" }),
    () => run(bytes, { status: 500 }),
    () => run(bytes, { url: `${url}?redirected=1`, redirected: true }),
    () => run(new Uint8Array(expected.byteLength + 2)),
  ]) await assert.rejects(attempt(), (error) => error.stage === "artifact");
});

test("native asset fetch accepts its route cap boundary and rejects boundary plus one before retaining content", async () => {
  const expected = { path: "index.html", mediaType: "text/html", byteLength: 3, sha256: "f".repeat(64) };
  const cap = expected.byteLength + 1;
  const outcomes = [];
  for (const size of [cap, cap + 1]) {
    let canceled = false;
    let emitted = false;
    const body = {
      getReader() {
        return {
          async read() {
            if (emitted) return { done: true, value: undefined };
            emitted = true;
            return { done: false, value: new Uint8Array(size) };
          },
          async cancel() { canceled = true; },
          releaseLock() {},
        };
      },
    };
    await assert.rejects(verifyProductionAssets({
      manifest: { files: [expected] }, origin: PRODUCTION_ORIGIN,
      fetchImpl: async (url) => ({
        body, status: 200, url, redirected: false, headers: new Headers({ "Content-Type": "text/html" }),
      }),
      now: () => 1, requestItems: [],
    }), (error) => error.stage === "artifact" && error.reason === "artifact-mismatch");
    outcomes.push(canceled);
  }
  assert.deepEqual(outcomes, [false, true]);
});

test("invalid Chrome startup endpoint terminates the process and removes startup listeners exactly once", async () => {
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  let kills = 0;
  child.kill = () => { kills += 1; child.exitCode = 1; child.emit("exit", 1); };
  const promise = launchInstalledChrome({ executable: "chrome", category: "linux-path" }, path.resolve("profile"), { spawnImpl: () => child });
  queueMicrotask(() => child.stderr.emit("data", "DevTools listening on ws://evil.invalid/devtools/browser/id\n"));
  await assert.rejects(promise, /invalid CDP endpoint/u);
  assert.equal(kills, 1);
  assert.equal(child.listenerCount("error"), 0);
  assert.equal(child.listenerCount("exit"), 0);
  assert.equal(child.stderr.listenerCount("data"), 0);
});

function fakeChromeChild() {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.stderr = new EventEmitter();
  child.kills = 0;
  child.kill = () => { child.kills += 1; child.exitCode = 0; child.emit("exit", 0); };
  return child;
}

function fakeCdpHarness({ failMethod } = {}) {
  const listeners = new Set();
  const closeListeners = new Set();
  const bodies = new Map();
  const calls = [];
  let closeCount = 0;
  let bodyCalls = 0;
  const cdp = {
    listeners,
    closeListeners,
    async send(method, params = {}, sessionId) {
      calls.push({ method, params, sessionId });
      if (method === failMethod) throw new Error(`controlled ${method} failure`);
      if (method === "Browser.getVersion") return { product: "Chrome/140.0.1.2", protocolVersion: "1.3" };
      if (method === "Target.createTarget") return { targetId: "page-target" };
      if (method === "Target.attachToTarget") return { sessionId: "page-session" };
      if (method === "Runtime.evaluate") return { result: { value: true } };
      if (method === "Network.getResponseBody") {
        bodyCalls += 1;
        const stored = bodies.get(params.requestId);
        return stored && typeof stored === "object" && typeof stored.body === "string"
          ? stored
          : { body: stored ?? "", base64Encoded: false };
      }
      return {};
    },
    close() { closeCount += 1; },
  };
  return {
    cdp, calls, bodies,
    get closeCount() { return closeCount; },
    get bodyCalls() { return bodyCalls; },
    emit(method, params = {}, sessionId = "worker-session") {
      for (const listener of [...listeners]) listener({ method, params, sessionId });
    },
  };
}

async function openFakeBrowser(harness = fakeCdpHarness()) {
  const child = fakeChromeChild();
  const session = await createBrowserEvidenceSession({
    discovery: { executable: "chrome", category: "linux-path" }, chromeVersion: "140.0.1.2",
    profile: path.resolve("controlled-profile"), origin: PRODUCTION_ORIGIN,
    manifest: { files: [{ path: "index.html" }] }, eventSha: EVENT,
    now: (() => { let tick = 0; return () => ++tick; })(), requestItems: [],
    launchImpl: async () => ({ child, websocketUrl: "ws://127.0.0.1:9222/devtools/browser/id" }),
    connectImpl: () => harness.cdp,
  });
  return { child, session, harness };
}

test("signal-terminal Chrome children never wait for or manufacture a second exit during startup, setup, or final close", async () => {
  {
    const child = fakeChromeChild();
    child.signalCode = "SIGTERM";
    child.kill = () => { throw new Error("terminal startup child was killed twice"); };
    const pending = launchInstalledChrome({ executable: "chrome", category: "linux-path" }, path.resolve("profile"), { spawnImpl: () => child });
    queueMicrotask(() => child.stderr.emit("data", "DevTools listening on ws://evil.invalid/devtools/browser/id\n"));
    await assert.rejects(Promise.race([
      pending,
      new Promise((_, reject) => setTimeout(() => reject(new Error("startup cleanup hung")), 100)),
    ]), (error) => error.message === "Chrome returned an invalid CDP endpoint");
  }

  {
    const harness = fakeCdpHarness({ failMethod: "Page.enable" });
    const child = fakeChromeChild();
    child.signalCode = "SIGKILL";
    child.kill = () => { throw new Error("terminal setup child was killed twice"); };
    await assert.rejects(Promise.race([
      createBrowserEvidenceSession({
        discovery: { executable: "chrome", category: "linux-path" }, chromeVersion: "140.0.1.2",
        profile: path.resolve("profile"), origin: PRODUCTION_ORIGIN, manifest: { files: [{ path: "index.html" }] },
        eventSha: EVENT, now: () => 1, requestItems: [],
        launchImpl: async () => ({ child, websocketUrl: "ws://127.0.0.1:1/devtools/browser/id" }), connectImpl: () => harness.cdp,
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("setup cleanup hung")), 100)),
    ]), (error) => /controlled Page\.enable failure/u.test(error.message));
  }

  {
    const opened = await openFakeBrowser();
    opened.child.signalCode = "SIGABRT";
    const kills = opened.child.kills;
    await Promise.race([
      opened.session.close(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("final cleanup hung")), 100)),
    ]);
    assert.equal(opened.child.kills, kills);
  }
});

function emitBrowserGet(harness, { requestId, url, body, headers = {}, responseHeaders = {
  "Access-Control-Allow-Origin": "*", "Content-Type": "application/json",
}, dataLength } = {}) {
  harness.bodies.set(requestId, body);
  harness.emit("Network.requestWillBeSent", { requestId, request: { url, method: "GET", headers: {} } });
  harness.emit("Network.requestWillBeSentExtraInfo", { requestId, headers, associatedCookies: [] });
  harness.emit("Network.responseReceived", { requestId, response: {
    url, status: 200, headers: responseHeaders, fromDiskCache: false, fromServiceWorker: false,
  } });
  const length = dataLength ?? new TextEncoder().encode(body).byteLength;
  harness.emit("Network.dataReceived", { requestId, dataLength: length, encodedDataLength: length });
  harness.emit("Network.loadingFinished", { requestId, encodedDataLength: length });
}

function emitBrowserBytes(harness, { requestId, url, bytes }) {
  harness.bodies.set(requestId, { body: Buffer.from(bytes).toString("base64"), base64Encoded: true });
  harness.emit("Network.requestWillBeSent", { requestId, request: { url, method: "GET", headers: {} } });
  harness.emit("Network.requestWillBeSentExtraInfo", { requestId, headers: {}, associatedCookies: [] });
  harness.emit("Network.responseReceived", { requestId, response: {
    url, status: 200, headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "text/plain" },
    fromDiskCache: false, fromServiceWorker: false,
  } });
  harness.emit("Network.dataReceived", { requestId, dataLength: bytes.byteLength, encodedDataLength: bytes.byteLength });
  harness.emit("Network.loadingFinished", { requestId, encodedDataLength: bytes.byteLength });
}

test("every Chrome/CDP session setup failure rolls back socket, process, listeners, and ownership once", async () => {
  const methods = [
    "Browser.getVersion", "Target.createTarget", "Target.attachToTarget", "Page.enable", "Runtime.enable",
    "Network.enable", "Runtime.addBinding", "Page.addScriptToEvaluateOnNewDocument", "Target.setAutoAttach", "Page.navigate", "Runtime.evaluate",
  ];
  for (const failMethod of methods) {
    const harness = fakeCdpHarness({ failMethod });
    const child = fakeChromeChild();
    await assert.rejects(createBrowserEvidenceSession({
      discovery: { executable: "chrome", category: "linux-path" }, chromeVersion: "140.0.1.2",
      profile: path.resolve("controlled-profile"), origin: PRODUCTION_ORIGIN,
      manifest: { files: [{ path: "index.html" }] }, eventSha: EVENT, now: () => 1, requestItems: [],
      launchImpl: async () => ({ child, websocketUrl: "ws://127.0.0.1:9222/devtools/browser/id" }),
      connectImpl: () => harness.cdp,
    }), new RegExp(`controlled ${failMethod.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.equal(harness.closeCount, 1, failMethod);
    assert.equal(child.kills, 1, failMethod);
    assert.equal(harness.cdp.listeners.size, 0, failMethod);
    assert.equal(harness.cdp.closeListeners.size, 0, failMethod);
  }

  const child = fakeChromeChild();
  await assert.rejects(createBrowserEvidenceSession({
    discovery: { executable: "chrome", category: "linux-path" }, chromeVersion: "140.0.1.2",
    profile: path.resolve("controlled-profile"), origin: PRODUCTION_ORIGIN,
    manifest: { files: [{ path: "index.html" }] }, eventSha: EVENT, now: () => 1, requestItems: [],
    launchImpl: async () => ({ child, websocketUrl: "ws://127.0.0.1:9222/devtools/browser/id" }),
    connectImpl: () => { throw new Error("controlled connect failure"); },
  }), /controlled connect failure/u);
  assert.equal(child.kills, 1);
});

test("fatal CDP, process, and connection events reject pending fact waiters without timeout", async () => {
  for (const stimulus of ["Runtime.exceptionThrown", "close", "process"]) {
    const opened = await openFakeBrowser();
    const pending = opened.session.collectSmoke(() => ({ atMs: 1 }), 0);
    await Promise.resolve();
    if (stimulus === "close") for (const listener of [...opened.harness.cdp.closeListeners]) listener(new Error("closed"));
    else if (stimulus === "process") { opened.child.exitCode = 1; opened.child.emit("exit", 1); }
    else opened.harness.emit(stimulus, {});
    await assert.rejects(Promise.race([
      pending,
      new Promise((_, reject) => setTimeout(() => reject(new Error("waiter hung")), 100)),
    ]), (error) => !/waiter hung/u.test(error.message));
    await opened.session.close().catch(() => {});
    assert.equal(opened.child.kills, stimulus === "process" ? 0 : 1);
  }
});

test("drain, worker detachment, malformed terminal, and duplicate terminal reject fact waiters deterministically", async () => {
  for (const stimulus of ["drain", "detach", "malformed", "duplicate"]) {
    const opened = await openFakeBrowser();
    const pending = opened.session.collectSmoke(() => ({ atMs: 1 }), 0);
    await Promise.resolve();
    if (stimulus === "drain") {
      opened.harness.emit("Runtime.bindingCalled", { name: "__codeCityCollectorEvidence", payload: JSON.stringify({
        type: "ATTEMPT_DRAINED", generation: 1,
      }) });
    } else if (stimulus === "detach") {
      opened.harness.emit("Target.attachedToTarget", {
        sessionId: "worker-session", targetInfo: { type: "worker", targetId: "worker-target" },
      }, "");
      await new Promise((resolve) => setImmediate(resolve));
      opened.harness.emit("Target.detachedFromTarget", { sessionId: "worker-session", targetId: "worker-target" }, "");
    } else if (stimulus === "malformed") {
      opened.harness.emit("Runtime.bindingCalled", { name: "__codeCityCollectorEvidence", payload: JSON.stringify({
        type: "SUCCESS", generation: 1, revision: EVENT,
      }) });
    } else {
      const terminal = { type: "SUCCESS", generation: 1, revision: EVENT, modelSha256: "1".repeat(64) };
      opened.harness.emit("Runtime.bindingCalled", { name: "__codeCityCollectorEvidence", payload: JSON.stringify(terminal) });
      opened.harness.emit("Runtime.bindingCalled", { name: "__codeCityCollectorEvidence", payload: JSON.stringify(terminal) });
    }
    await assert.rejects(Promise.race([
      pending,
      new Promise((_, reject) => setTimeout(() => reject(new Error("terminal waiter hung")), 100)),
    ]), (error) => error.message !== "terminal waiter hung", stimulus);
    await opened.session.close().catch(() => {});
    assert.equal(opened.harness.closeCount, 1, stimulus);
    assert.equal(opened.child.kills, 1, stimulus);
  }
});

test("CDP request ExtraInfo is mandatory, unique, late-closed, and authoritative for credential facts", async () => {
  {
    const requestItems = [];
    const harness = fakeCdpHarness();
    const child = fakeChromeChild();
    const session = await createBrowserEvidenceSession({
      discovery: { executable: "chrome", category: "linux-path" }, chromeVersion: "140.0.1.2", profile: path.resolve("profile"),
      origin: PRODUCTION_ORIGIN, manifest: { files: [{ path: "index.html" }] }, eventSha: EVENT,
      now: (() => { let value = 0; return () => ++value; })(), requestItems,
      launchImpl: async () => ({ child, websocketUrl: "ws://127.0.0.1:1/devtools/browser/id" }), connectImpl: () => harness.cdp,
    });
    const pending = session.collectSmoke(() => ({ atMs: 1 }), 0);
    await Promise.resolve();
    emitBrowserGet(harness, { requestId: "credential", url: revisionUrl("FelixGeisler/code-city"), body: `${JSON.stringify([{ sha: EVENT }])}\n`, headers: { Cookie: "private" } });
    harness.emit("Runtime.bindingCalled", { name: "__codeCityCollectorEvidence", payload: JSON.stringify({ type: "REVISION_SELECTED", generation: 1, revision: EVENT }) });
    await assert.rejects(pending, /credential header/u);
    assert.equal(requestItems.length, 0);
    assert(!JSON.stringify(requestItems).includes("private"));
    await session.close().catch(() => {});
  }

  for (const kind of ["missing", "duplicate", "late"]) {
    const opened = await openFakeBrowser();
    const pending = opened.session.collectSmoke(() => ({ atMs: 1 }), 0);
    await Promise.resolve();
    const requestId = kind;
    const url = revisionUrl("FelixGeisler/code-city");
    opened.harness.bodies.set(requestId, `${JSON.stringify([{ sha: EVENT }])}\n`);
    opened.harness.emit("Network.requestWillBeSent", { requestId, request: { url, method: "GET", headers: {} } });
    if (kind !== "missing") opened.harness.emit("Network.requestWillBeSentExtraInfo", { requestId, headers: {}, associatedCookies: [] });
    if (kind === "duplicate") opened.harness.emit("Network.requestWillBeSentExtraInfo", { requestId, headers: {}, associatedCookies: [] });
    opened.harness.emit("Network.responseReceived", { requestId, response: { url, status: 200, headers: { "Access-Control-Allow-Origin": "*" }, fromDiskCache: false, fromServiceWorker: false } });
    opened.harness.emit("Network.loadingFinished", { requestId, encodedDataLength: 1 });
    if (kind === "late") {
      await new Promise((resolve) => setImmediate(resolve));
      opened.harness.emit("Network.requestWillBeSentExtraInfo", { requestId, headers: {}, associatedCookies: [] });
    }
    if (kind === "missing") opened.harness.emit("Runtime.bindingCalled", { name: "__codeCityCollectorEvidence", payload: JSON.stringify({ type: "REVISION_SELECTED", generation: 1, revision: EVENT }) });
    await assert.rejects(Promise.race([pending, new Promise((_, reject) => setTimeout(() => reject(new Error("hung")), 100))]), (error) => error.message !== "hung");
    await opened.session.close().catch(() => {});
  }
});

test("CDP ExtraInfo classifies credential names before failure or incompletion and never reads or retains secret values", async () => {
  for (const ending of ["loading-failed", "incomplete", "ignored-asset"]) {
    const opened = await openFakeBrowser();
    const pending = opened.session.collectSmoke(() => ({ atMs: 1 }), 0);
    await Promise.resolve();
    let secretReads = 0;
    let cookieMetadataReads = 0;
    const headers = {};
    Object.defineProperty(headers, "Authorization", {
      enumerable: true,
      get() { secretReads += 1; return "Bearer never-retain"; },
    });
    const params = { requestId: ending, headers };
    Object.defineProperty(params, "associatedCookies", {
      enumerable: true,
      get() { cookieMetadataReads += 1; return [{ cookie: { value: "never-retain" } }]; },
    });
    opened.harness.emit("Network.requestWillBeSent", {
      requestId: ending,
      request: { url: ending === "ignored-asset" ? `${PRODUCTION_ORIGIN}index.html`
        : revisionUrl("FelixGeisler/code-city"), method: "GET", headers: {} },
    });
    opened.harness.emit("Network.requestWillBeSentExtraInfo", params);
    if (ending === "loading-failed") opened.harness.emit("Network.loadingFailed", { requestId: ending });
    await assert.rejects(pending, /credential header observed/u, ending);
    assert.equal(secretReads, 0, ending);
    assert.equal(cookieMetadataReads, 0, ending);
    assert.equal(JSON.stringify(opened.session).includes("never-retain"), false, ending);
    await opened.session.close().catch(() => {});
  }
});

test("complete safe CDP facts survive a later fatal event without retaining unsafe request or response header values", async () => {
  const requestItems = [];
  const harness = fakeCdpHarness();
  const child = fakeChromeChild();
  const session = await createBrowserEvidenceSession({
    discovery: { executable: "chrome", category: "linux-path" }, chromeVersion: "140.0.1.2", profile: path.resolve("profile"),
    origin: PRODUCTION_ORIGIN, manifest: { files: [{ path: "index.html" }] }, eventSha: EVENT,
    now: (() => { let value = 0; return () => ++value; })(), requestItems,
    launchImpl: async () => ({ child, websocketUrl: "ws://127.0.0.1:1/devtools/browser/id" }), connectImpl: () => harness.cdp,
  });
  const pending = session.collectSmoke(() => ({ atMs: 1 }), 0);
  await Promise.resolve();
  let requestSecretReads = 0;
  let responseSecretReads = 0;
  const requestHeaders = { Accept: "application/json" };
  Object.defineProperty(requestHeaders, "X-Private", {
    enumerable: true,
    get() { requestSecretReads += 1; return "request-never-retain"; },
  });
  const responseHeaders = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
  Object.defineProperty(responseHeaders, "Set-Cookie", {
    enumerable: true,
    get() { responseSecretReads += 1; return "response-never-retain"; },
  });
  const requestId = "safe-before-fatal";
  const url = revisionUrl("FelixGeisler/code-city");
  harness.bodies.set(requestId, JSON.stringify([{ sha: EVENT }]));
  harness.emit("Network.requestWillBeSent", { requestId, request: { url, method: "GET", headers: {} } });
  harness.emit("Network.requestWillBeSentExtraInfo", { requestId, headers: requestHeaders, associatedCookies: [] });
  harness.emit("Network.responseReceived", { requestId, response: {
    url, status: 200, headers: responseHeaders, fromDiskCache: false, fromServiceWorker: false,
  } });
  harness.emit("Network.loadingFinished", { requestId, encodedDataLength: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  harness.emit("Runtime.exceptionThrown", {});
  await assert.rejects(pending, /browser exception/u);
  assert.equal(requestItems.length, 1);
  assert.equal(requestItems[0].authorizationAbsent, true);
  assert.equal(requestSecretReads, 0);
  assert.equal(responseSecretReads, 0);
  assert(!JSON.stringify({ requestItems, session }).includes("never-retain"));
  await session.close().catch(() => {});
});

test("CDP transfer overflow fails before getResponseBody and closes owned resources", async () => {
  const opened = await openFakeBrowser();
  const pending = opened.session.collectSmoke(() => ({ atMs: 1 }), 0);
  await Promise.resolve();
  const requestId = "overflow";
  const url = revisionUrl("FelixGeisler/code-city");
  opened.harness.emit("Network.requestWillBeSent", { requestId, request: { url, method: "GET", headers: {} } });
  opened.harness.emit("Network.requestWillBeSentExtraInfo", { requestId, headers: {}, associatedCookies: [] });
  opened.harness.emit("Network.responseReceived", { requestId, response: { url, status: 200, headers: { "Access-Control-Allow-Origin": "*" }, fromDiskCache: false, fromServiceWorker: false } });
  opened.harness.emit("Network.dataReceived", { requestId, dataLength: RESPONSE_CAPS.revision + 1, encodedDataLength: 1 });
  await assert.rejects(pending, /exceeds cap before retrieval/u);
  assert.equal(opened.harness.bodyCalls, 0);
  await opened.session.close().catch(() => {});
  assert.equal(opened.child.kills, 1);
});

test("each native CDP revision, commit, tree, and raw route rejects boundary plus one before body retrieval", async () => {
  const source = new TextEncoder().encode("x");
  const blob = computeGitBlobId(source, 40);
  for (const [overflowStage, expectedBodyCalls] of [["revision", 0], ["commit", 1], ["tree", 2], ["raw", 3]]) {
    const opened = await openFakeBrowser();
    const pending = opened.session.collectSmoke(() => ({ atMs: 1 }), 0);
    await Promise.resolve();
    const complete = async (stage, requestId, url, body) => {
      emitBrowserGet(opened.harness, { requestId, url, body });
      await new Promise((resolve) => setImmediate(resolve));
      if (stage === "revision") {
        opened.harness.emit("Runtime.bindingCalled", { name: "__codeCityCollectorEvidence", payload: JSON.stringify({
          type: "REVISION_SELECTED", generation: 1, revision: EVENT,
        }) });
        await new Promise((resolve) => setImmediate(resolve));
      }
    };
    const overflow = (requestId, url, cap) => {
      opened.harness.emit("Network.requestWillBeSent", { requestId, request: { url, method: "GET", headers: {} } });
      opened.harness.emit("Network.requestWillBeSentExtraInfo", { requestId, headers: {}, associatedCookies: [] });
      opened.harness.emit("Network.responseReceived", { requestId, response: {
        url, status: 200, headers: { "Access-Control-Allow-Origin": "*" }, fromDiskCache: false, fromServiceWorker: false,
      } });
      opened.harness.emit("Network.dataReceived", { requestId, dataLength: cap + 1, encodedDataLength: 1 });
    };

    if (overflowStage === "revision") overflow("overflow-revision", revisionUrl("FelixGeisler/code-city"), RESPONSE_CAPS.revision);
    else {
      await complete("revision", "ok-revision", revisionUrl("FelixGeisler/code-city"), JSON.stringify([{ sha: EVENT }]));
      if (overflowStage === "commit") overflow("overflow-commit", commitUrl("FelixGeisler/code-city", EVENT), RESPONSE_CAPS.commit);
      else {
        await complete("commit", "ok-commit", commitUrl("FelixGeisler/code-city", EVENT), JSON.stringify({ sha: EVENT, tree: { sha: ROOT } }));
        if (overflowStage === "tree") overflow("overflow-tree", treeUrl("FelixGeisler/code-city", ROOT), RESPONSE_CAPS.tree);
        else {
          await complete("tree", "ok-tree", treeUrl("FelixGeisler/code-city", ROOT), JSON.stringify({
            sha: ROOT, truncated: false, tree: [{ path: "src/a.ts", mode: "100644", type: "blob", sha: blob }],
          }));
          overflow("overflow-raw", rawUrl("FelixGeisler/code-city", EVENT, "src/a.ts"), RESPONSE_CAPS.raw);
        }
      }
    }
    await assert.rejects(pending, /exceeds cap before retrieval/u, overflowStage);
    assert.equal(opened.harness.bodyCalls, expectedBodyCalls, overflowStage);
    await opened.session.close().catch(() => {});
  }
});

test("an earlier SUCCESS is the first capacity terminal and fails exact limit ordering deterministically", async () => {
  const opened = await openFakeBrowser();
  const qualification = { revision: REACT, rootTree: REACT_ROOT, candidates: candidates() };
  const pending = opened.session.collectCapacity(qualification, () => ({ atMs: 1 }), 0);
  await Promise.resolve();
  emitBrowserGet(opened.harness, { requestId: "revision", url: revisionUrl("facebook/react"), body: `${JSON.stringify([{ sha: REACT }])}\n` });
  await new Promise((resolve) => setImmediate(resolve));
  opened.harness.emit("Runtime.bindingCalled", { name: "__codeCityCollectorEvidence", payload: JSON.stringify({ type: "REVISION_SELECTED", generation: 2, revision: REACT }) });
  await new Promise((resolve) => setImmediate(resolve));
  opened.harness.emit("Runtime.bindingCalled", { name: "__codeCityCollectorEvidence", payload: JSON.stringify({ type: "SUCCESS", generation: 2, revision: REACT, modelSha256: "f".repeat(64) }) });
  await assert.rejects(pending, /capacity terminal differs/u);
  await opened.session.close().catch(() => {});
});

test("capacity terminal rejects the non-protocol extra code key", async () => {
  const opened = await openFakeBrowser();
  const pending = opened.session.collectCapacity({
    revision: REACT, rootTree: REACT_ROOT, candidates: candidates(),
  }, () => ({ atMs: 1 }), 0);
  await Promise.resolve();
  opened.harness.emit("Runtime.bindingCalled", { name: "__codeCityCollectorEvidence", payload: JSON.stringify({
    type: "FAILURE", generation: 2, revision: REACT,
    category: "Repository exceeds Code City limits", code: "limit",
  }) });
  await assert.rejects(pending, /worker observation is malformed/u);
  await opened.session.close().catch(() => {});
});

test("native CDP capacity observes the complete ordered 4,004 exchange sequence, first terminal, non-overlap, and request/worker quiescence", async () => {
  const requestItems = [];
  const harness = fakeCdpHarness();
  const child = fakeChromeChild();
  let tick = 0;
  const session = await createBrowserEvidenceSession({
    discovery: { executable: "chrome", category: "linux-path" }, chromeVersion: "140.0.1.2", profile: path.resolve("profile"),
    origin: PRODUCTION_ORIGIN, manifest: { files: [{ path: "index.html" }] }, eventSha: EVENT,
    now: () => ++tick, requestItems,
    launchImpl: async () => ({ child, websocketUrl: "ws://127.0.0.1:1/devtools/browser/id" }), connectImpl: () => harness.cdp,
  });
  const qualificationCandidates = NATIVE_ENTRIES.map((entry, offset) => ({
    index: offset + 1, path: entry.path, blobId: entry.sha, normalizedBytes: 1,
    runningAggregate: offset + 1, hashMatched: true, contentValid: true,
  }));
  const qualification = { revision: REACT, rootTree: REACT_ROOT, candidates: qualificationCandidates };
  const events = [];
  const pending = session.collectCapacity(qualification, (event, generation, atMs) => {
    const value = { event, generation, atMs: atMs ?? ++tick };
    events.push(value);
    return value;
  }, 0);
  await Promise.resolve();
  harness.emit("Target.attachedToTarget", { sessionId: "worker-session", targetInfo: { type: "worker", targetId: "worker-target" } }, "");

  emitBrowserGet(harness, {
    requestId: "capacity-revision", url: revisionUrl("facebook/react"), body: JSON.stringify([{ sha: REACT }]),
    dataLength: RESPONSE_CAPS.revision,
  });
  await new Promise((resolve) => setImmediate(resolve));
  harness.emit("Runtime.bindingCalled", { name: "__codeCityCollectorEvidence", payload: JSON.stringify({ type: "REVISION_SELECTED", generation: 2, revision: REACT }) });
  emitBrowserGet(harness, {
    requestId: "capacity-commit", url: commitUrl("facebook/react", REACT),
    body: JSON.stringify({ sha: REACT, tree: { sha: REACT_ROOT } }), dataLength: RESPONSE_CAPS.commit,
  });
  emitBrowserGet(harness, {
    requestId: "capacity-tree", url: treeUrl("facebook/react", REACT_ROOT),
    body: JSON.stringify({ sha: REACT_ROOT, truncated: false, tree: NATIVE_ENTRIES }), dataLength: RESPONSE_CAPS.tree,
  });
  for (let index = 0; index < NATIVE_ENTRIES.length; index += 1) {
    emitBrowserGet(harness, {
      requestId: `capacity-raw-${index + 1}`,
      url: rawUrl("facebook/react", REACT, NATIVE_ENTRIES[index].path), body: "x",
      headers: {}, dataLength: RESPONSE_CAPS.raw,
    });
  }
  for (let attempts = 0; harness.bodyCalls < 4004 && attempts < 100; attempts += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(harness.bodyCalls, 4004);
  harness.emit("Runtime.bindingCalled", { name: "__codeCityCollectorEvidence", payload: JSON.stringify({
    type: "FAILURE", generation: 2, revision: REACT, category: "Repository exceeds Code City limits",
  }) });
  harness.emit("Runtime.bindingCalled", { name: "__codeCityCollectorEvidence", payload: JSON.stringify({ type: "ATTEMPT_DRAINED", generation: 2 }) });
  harness.emit("Target.detachedFromTarget", { sessionId: "worker-session", targetId: "worker-target" }, "");

  const capacity = await pending;
  assert.equal(capacity.rawRequestCount, 4001);
  assert.equal(capacity.candidates.length, 4001);
  assert.equal(capacity.noLaterRequest, true);
  assert.equal(capacity.workerQuiescent, true);
  assert.equal(requestItems.length, 4004);
  assert.deepEqual(requestItems.slice(0, 3).map(({ stage }) => stage), ["revision", "commit", "tree"]);
  assert(requestItems.slice(3).every(({ stage }) => stage === "raw"));
  assert(requestItems.every((item, index) => index === 0 || requestItems[index - 1].endedMs <= item.startedMs));
  assert.deepEqual(events.map(({ event }) => event), [
    "revision-selected", "inventory-complete", "limit-failure", "request-quiescent", "worker-quiescent",
  ]);
  const workerCommands = harness.calls.filter(({ sessionId, method }) => (
    sessionId === "worker-session" && method !== "Network.getResponseBody"
  ));
  assert.deepEqual(workerCommands.map(({ method }) => method), ["Runtime.enable", "Network.enable", "Runtime.runIfWaitingForDebugger"]);
  await session.close();
});

test("CDP admission rejects overlap, wrong order/path, and capacity candidate 4,002 before body retrieval", async () => {
  {
    const opened = await openFakeBrowser();
    const pending = opened.session.collectSmoke(() => ({ atMs: 1 }), 0);
    await Promise.resolve();
    opened.harness.emit("Network.requestWillBeSent", {
      requestId: "active-revision", request: { url: revisionUrl("FelixGeisler/code-city"), method: "GET", headers: {} },
    });
    opened.harness.emit("Network.requestWillBeSent", {
      requestId: "overlap-commit", request: { url: commitUrl("FelixGeisler/code-city", EVENT), method: "GET", headers: {} },
    });
    await assert.rejects(pending, /overlap at admission/u);
    assert.equal(opened.harness.bodyCalls, 0);
    await opened.session.close().catch(() => {});
    assert.equal(opened.harness.closeCount, 1);
    assert.equal(opened.child.kills, 1);
  }

  {
    const opened = await openFakeBrowser();
    const pending = opened.session.collectSmoke(() => ({ atMs: 1 }), 0);
    await Promise.resolve();
    emitBrowserGet(opened.harness, {
      requestId: "ordered-revision", url: revisionUrl("FelixGeisler/code-city"), body: JSON.stringify([{ sha: EVENT }]),
    });
    await new Promise((resolve) => setImmediate(resolve));
    opened.harness.emit("Runtime.bindingCalled", { name: "__codeCityCollectorEvidence", payload: JSON.stringify({
      type: "REVISION_SELECTED", generation: 1, revision: EVENT,
    }) });
    opened.harness.emit("Network.requestWillBeSent", {
      requestId: "wrong-commit", request: { url: commitUrl("FelixGeisler/code-city", "9".repeat(40)), method: "GET", headers: {} },
    });
    await assert.rejects(pending, /sequence differs at admission/u);
    assert.equal(opened.harness.bodyCalls, 1);
    await opened.session.close().catch(() => {});
    assert.equal(opened.harness.closeCount, 1);
    assert.equal(opened.child.kills, 1);
  }

  {
    const opened = await openFakeBrowser();
    const qualificationCandidates = NATIVE_ENTRIES.map((entry, offset) => ({
      index: offset + 1, path: entry.path, blobId: entry.sha, normalizedBytes: 1,
      runningAggregate: offset + 1, hashMatched: true, contentValid: true,
    }));
    const pending = opened.session.collectCapacity({
      revision: REACT, rootTree: REACT_ROOT, candidates: qualificationCandidates,
    }, () => ({ atMs: 1 }), 0);
    await Promise.resolve();
    emitBrowserGet(opened.harness, {
      requestId: "limit-revision", url: revisionUrl("facebook/react"), body: JSON.stringify([{ sha: REACT }]),
    });
    await new Promise((resolve) => setImmediate(resolve));
    opened.harness.emit("Runtime.bindingCalled", { name: "__codeCityCollectorEvidence", payload: JSON.stringify({
      type: "REVISION_SELECTED", generation: 2, revision: REACT,
    }) });
    emitBrowserGet(opened.harness, {
      requestId: "limit-commit", url: commitUrl("facebook/react", REACT),
      body: JSON.stringify({ sha: REACT, tree: { sha: REACT_ROOT } }),
    });
    emitBrowserGet(opened.harness, {
      requestId: "limit-tree", url: treeUrl("facebook/react", REACT_ROOT),
      body: JSON.stringify({ sha: REACT_ROOT, truncated: false, tree: NATIVE_ENTRIES }),
    });
    for (let index = 0; index < NATIVE_ENTRIES.length; index += 1) {
      emitBrowserGet(opened.harness, {
        requestId: `limit-raw-${index + 1}`,
        url: rawUrl("facebook/react", REACT, NATIVE_ENTRIES[index].path), body: "x",
      });
    }
    for (let attempts = 0; opened.harness.bodyCalls < 4004 && attempts < 100; attempts += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(opened.harness.bodyCalls, 4004);
    opened.harness.emit("Network.requestWillBeSent", {
      requestId: "candidate-4002", request: {
        url: rawUrl("facebook/react", REACT, "4002.ts"), method: "GET", headers: {},
      },
    });
    await assert.rejects(pending, /limit ordering.*4,002/u);
    assert.equal(opened.harness.bodyCalls, 4004);
    await opened.session.close().catch(() => {});
    assert.equal(opened.harness.closeCount, 1);
    assert.equal(opened.child.kills, 1);
  }
});

const HANDLED_REASONS = {
  artifact: ["artifact-mismatch", "production-unreachable", "infrastructure-failure"],
  smoke: ["smoke-failure", "provider-failure", "cors-failure", "request-sequence", "request-overlap", "unexpected-request", "credential-header", "stale-publication", "quiescence-failure", "cleanup-failure", "infrastructure-failure"],
  qualification: ["qualification-failure", "identity-mismatch", "provider-failure", "cors-failure", "tree-incomplete", "hash-mismatch", "content-invalid", "request-sequence", "request-overlap", "unexpected-request", "credential-header", "infrastructure-failure"],
  capacity: ["identity-mismatch", "provider-failure", "cors-failure", "tree-incomplete", "hash-mismatch", "content-invalid", "limit-order", "request-sequence", "request-overlap", "unexpected-request", "credential-header", "stale-publication", "quiescence-failure", "cleanup-failure", "infrastructure-failure"],
};

function matrixManifest() {
  return {
    schemaVersion: 2,
    basePath: "/code-city/",
    policy: { contentSecurityPolicy: CSP, referrerPolicy: "no-referrer", connectOrigins: ["'self'", "https://api.github.com", "https://raw.githubusercontent.com"] },
    files: [{ path: "index.html", mediaType: "text/html", byteLength: 1, sha256: "f".repeat(64) }],
  };
}

function collectorMatrixSeams({ failStage, reason, progressedQualification = false, progressedCapacity = false, packetSink } = {}) {
  const manifest = matrixManifest();
  const manifestBytes = serializePackageManifest(manifest);
  const shared = candidates();
  let tick = 0;
  let capacityProgress;
  const failAt = (stage) => { if (failStage === stage) throw new CollectorFailure(stage, reason); };
  return {
    clock: () => tick++,
    readPublicationInput: async () => ({
      manifestBytes, manifest, publicationRecordBytes: new TextEncoder().encode("record\n"),
      publicationRecord: { eventSha: EVENT, runId: 1, runAttempt: 1 },
    }),
    deriveCollectorCommit: async () => EVENT,
    discoverInstalledChrome: async () => ({ executable: "hidden", category: "windows-program-files" }),
    readInstalledChromeVersion: async () => "140.0.1.2",
    verifyDeploymentBinding: async () => { failAt("artifact"); return { deploymentId: 7, deployedSha: EVENT }; },
    verifyProductionAssets: async () => [{
      path: "index.html", expectedMediaType: "text/html", observedMediaType: "text/html", expectedBytes: 1,
      observedBytes: 1, expectedSha256: "f".repeat(64), observedSha256: "f".repeat(64), match: true,
    }],
    mkdtemp: async () => path.resolve("matrix-profile"),
    rm: async () => {},
    createBrowserEvidenceSession: async ({ now, requestItems }) => ({
      cdpVersion: "1.3",
      async collectSmoke(emit, startedMs) {
        failAt("smoke");
        directRequest(requestItems, now, "revision", revisionUrl("FelixGeisler/code-city"), true);
        emit("revision-selected", 1);
        for (const [stage, url] of [
          ["commit", commitUrl("FelixGeisler/code-city", EVENT)],
          ["tree", treeUrl("FelixGeisler/code-city", ROOT)],
          ["raw", rawUrl("FelixGeisler/code-city", EVENT, "src/a.ts")],
        ]) directRequest(requestItems, now, stage, url, true);
        const published = emit("city-published", 1);
        return { repositoryUrl: "https://github.com/FelixGeisler/code-city", revision: EVENT, rootTree: ROOT, terminal: "success", canvasCount: 1, modelSha256: "1".repeat(64), startedMs, endedMs: published.atMs, providerGetCount: 4 };
      },
      clearTrace() {},
      async collectCapacity(qualification, emit, startedMs) {
        if (!progressedCapacity) failAt("capacity");
        appendSequence(requestItems, now, "facebook/react", REACT, REACT_ROOT, shared.map((item) => item.path), true, {
          revision: () => emit("revision-selected", 2), inventory: () => emit("inventory-complete", 2),
        });
        const limit = emit("limit-failure", 2);
        capacityProgress = {
          repositoryUrl: "https://github.com/facebook/react", revision: REACT, rootTree: REACT_ROOT,
          terminal: "Repository exceeds Code City limits", revisionDisplayed: true, cityPresent: false,
          priorCityRemoved: true, rawRequestCount: 4001, maxOverlap: 1, noLaterRequest: false,
          workerQuiescent: false, candidates: structuredClone(qualification.candidates), startedMs, endedMs: null,
        };
        if (failStage === "capacity") throw new CollectorFailure("capacity", reason);
        emit("request-quiescent", 2);
        const worker = emit("worker-quiescent", 2);
        return { ...capacityProgress, noLaterRequest: true, workerQuiescent: true, endedMs: worker.atMs };
      },
      snapshot(kind) { return kind === "capacity" ? capacityProgress : undefined; },
      async close() {},
    }),
    qualifyRepository: async ({ now, requestItems, progress }) => {
      if (failStage === "qualification") {
        if (progressedQualification) {
          directRequest(requestItems, now, "revision", revisionUrl("facebook/react"), false);
          progress.revision = REACT;
        }
        failAt("qualification");
      }
      appendSequence(requestItems, now, "facebook/react", REACT, REACT_ROOT, shared.map((item) => item.path), false);
      return Object.assign(progress, { repositoryUrl: "https://github.com/facebook/react", revision: REACT, rootTree: REACT_ROOT, treeEntries: 5000, truncated: false, candidates: shared });
    },
    writeValidatedEvidencePacket: async (_output, packet) => {
      const validated = validateEvidencePacket(packet.files, packet.binding);
      packetSink?.(validated);
    },
    readValidatedEvidencePacket: async (_output, binding) => {
      const packet = packetSink?.();
      if (packet) return packet;
      throw new Error(`missing matrix packet for ${binding.eventSha}`);
    },
  };
}

async function collectHandledMatrix(stage, reason) {
  let stored;
  const seams = collectorMatrixSeams({ failStage: stage, reason, packetSink(value) { if (value) stored = value; return stored; } });
  const result = await collectProductionEvidence({
    origin: PRODUCTION_ORIGIN, manifestPath: path.resolve("matrix-manifest.json"), output: path.resolve(`matrix-${stage}-${reason}`),
  }, seams);
  return { result, stored };
}

test("fatal CDP, connection, and Chrome process races abort a blocked qualification reader before browser and workspace release", async () => {
  for (const stimulus of ["cdp", "connection", "process"]) {
    let stored;
    const order = [];
    const seams = collectorMatrixSeams({ packetSink(value) { if (value) stored = value; return stored; } });
    delete seams.qualifyRepository;
    seams.rm = async () => { order.push("workspace"); };
    seams.createBrowserEvidenceSession = async (args) => {
      const harness = fakeCdpHarness();
      const child = fakeChromeChild();
      const native = await createBrowserEvidenceSession({
        ...args,
        launchImpl: async () => ({ child, websocketUrl: "ws://127.0.0.1:1/devtools/browser/id" }),
        connectImpl: () => harness.cdp,
      });
      let triggered = false;
      seams.fetchImpl = async (url) => ({
        status: 200,
        url,
        redirected: false,
        headers: new Headers({ "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" }),
        body: {
          getReader() {
            return {
              read() {
                if (!triggered) {
                  triggered = true;
                  queueMicrotask(() => {
                    if (stimulus === "cdp") harness.emit("Runtime.exceptionThrown", {});
                    else if (stimulus === "connection") {
                      for (const listener of [...harness.cdp.closeListeners]) listener(new Error("controlled connection fatal"));
                    } else {
                      child.exitCode = 1;
                      child.emit("exit", 1);
                    }
                  });
                }
                return new Promise(() => {});
              },
              async cancel() { order.push("reader-cancel"); },
              releaseLock() { order.push("reader-release"); },
            };
          },
        },
      });
      return Object.freeze({
        cdpVersion: native.cdpVersion,
        fatalSignal: native.fatalSignal,
        snapshot: native.snapshot,
        async collectSmoke(emit, startedMs) {
          directRequest(args.requestItems, args.now, "revision", revisionUrl("FelixGeisler/code-city"), true);
          emit("revision-selected", 1);
          for (const [stage, url] of [
            ["commit", commitUrl("FelixGeisler/code-city", EVENT)],
            ["tree", treeUrl("FelixGeisler/code-city", ROOT)],
            ["raw", rawUrl("FelixGeisler/code-city", EVENT, "src/a.ts")],
          ]) directRequest(args.requestItems, args.now, stage, url, true);
          const published = emit("city-published", 1);
          return { repositoryUrl: "https://github.com/FelixGeisler/code-city", revision: EVENT, rootTree: ROOT,
            terminal: "success", canvasCount: 1, modelSha256: "1".repeat(64), startedMs,
            endedMs: published.atMs, providerGetCount: 4 };
        },
        clearTrace() {},
        collectCapacity: native.collectCapacity,
        async close() { await native.close(); order.push("browser-close"); },
      });
    };
    const result = await collectProductionEvidence({
      origin: PRODUCTION_ORIGIN, manifestPath: path.resolve("manifest.json"), output: path.resolve(`qualification-fatal-${stimulus}`),
    }, seams);
    assert.deepEqual([result.status, result.reason], ["fail", "infrastructure-failure"], stimulus);
    assert.deepEqual(order, ["reader-cancel", "reader-release", "browser-close", "workspace"], stimulus);
    const qualification = JSON.parse(new TextDecoder().decode(stored.files.get("qualification.json")));
    const requests = JSON.parse(new TextDecoder().decode(stored.files.get("requests.json")));
    assert.deepEqual([qualification.status, qualification.reason], ["fail", "infrastructure-failure"], stimulus);
    assert.equal(qualification.data.candidates.length, 0, stimulus);
    assert.equal(requests.data.items.filter((item) => !item.applicationCall
      && item.requestedUrl.includes("/facebook/react/")).length, 0, stimulus);
  }
});

test("native CDP overlap and candidate-4,002 admission stops produce schema-valid marked packets", async () => {
  for (const kind of ["overlap", "candidate-4002"]) {
    let stored;
    let bodyCallsAtStop = null;
    const seams = collectorMatrixSeams({ packetSink(value) { if (value) stored = value; return stored; } });
    const nativeCandidates = NATIVE_ENTRIES.map((entry, offset) => ({
      index: offset + 1, path: entry.path, blobId: entry.sha, normalizedBytes: 1,
      runningAggregate: offset + 1, hashMatched: true, contentValid: true,
    }));
    if (kind === "candidate-4002") {
      seams.qualifyRepository = async ({ now, requestItems, progress }) => {
        appendSequence(requestItems, now, "facebook/react", REACT, REACT_ROOT,
          NATIVE_ENTRIES.map(({ path: sourcePath }) => sourcePath), false);
        return Object.assign(progress, {
          repositoryUrl: "https://github.com/facebook/react", revision: REACT, rootTree: REACT_ROOT,
          treeEntries: 4002, truncated: false, candidates: structuredClone(nativeCandidates),
        });
      };
    }
    seams.createBrowserEvidenceSession = async (args) => {
      const harness = fakeCdpHarness();
      const child = fakeChromeChild();
      const native = await createBrowserEvidenceSession({
        ...args,
        launchImpl: async () => ({ child, websocketUrl: "ws://127.0.0.1:1/devtools/browser/id" }),
        connectImpl: () => harness.cdp,
      });
      const driveOverlap = async () => {
        await Promise.resolve();
        harness.emit("Network.requestWillBeSent", {
          requestId: "packet-active", request: { url: revisionUrl("FelixGeisler/code-city"), method: "GET", headers: {} },
        });
        harness.emit("Network.requestWillBeSent", {
          requestId: "packet-overlap", request: { url: commitUrl("FelixGeisler/code-city", EVENT), method: "GET", headers: {} },
        });
        bodyCallsAtStop = harness.bodyCalls;
      };
      const driveLimit = async () => {
        await Promise.resolve();
        emitBrowserGet(harness, {
          requestId: "packet-limit-revision", url: revisionUrl("facebook/react"), body: JSON.stringify([{ sha: REACT }]),
        });
        await new Promise((resolve) => setImmediate(resolve));
        harness.emit("Runtime.bindingCalled", { name: "__codeCityCollectorEvidence", payload: JSON.stringify({
          type: "REVISION_SELECTED", generation: 2, revision: REACT,
        }) });
        emitBrowserGet(harness, {
          requestId: "packet-limit-commit", url: commitUrl("facebook/react", REACT),
          body: JSON.stringify({ sha: REACT, tree: { sha: REACT_ROOT } }),
        });
        emitBrowserGet(harness, {
          requestId: "packet-limit-tree", url: treeUrl("facebook/react", REACT_ROOT),
          body: JSON.stringify({ sha: REACT_ROOT, truncated: false, tree: NATIVE_ENTRIES }),
        });
        for (let index = 0; index < NATIVE_ENTRIES.length; index += 1) {
          emitBrowserGet(harness, {
            requestId: `packet-limit-raw-${index + 1}`,
            url: rawUrl("facebook/react", REACT, NATIVE_ENTRIES[index].path), body: "x",
          });
        }
        for (let attempts = 0; harness.bodyCalls < 4004 && attempts < 100; attempts += 1) {
          await new Promise((resolve) => setImmediate(resolve));
        }
        harness.emit("Network.requestWillBeSent", {
          requestId: "packet-candidate-4002", request: {
            url: rawUrl("facebook/react", REACT, "4002.ts"), method: "GET", headers: {},
          },
        });
        bodyCallsAtStop = harness.bodyCalls;
      };
      return Object.freeze({
        cdpVersion: native.cdpVersion,
        snapshot: native.snapshot,
        async collectSmoke(emit, startedMs) {
          if (kind === "overlap") {
            const pending = native.collectSmoke(emit, startedMs);
            void driveOverlap();
            return pending;
          }
          directRequest(args.requestItems, args.now, "revision", revisionUrl("FelixGeisler/code-city"), true);
          emit("revision-selected", 1);
          for (const [stage, url] of [
            ["commit", commitUrl("FelixGeisler/code-city", EVENT)],
            ["tree", treeUrl("FelixGeisler/code-city", ROOT)],
            ["raw", rawUrl("FelixGeisler/code-city", EVENT, "src/a.ts")],
          ]) directRequest(args.requestItems, args.now, stage, url, true);
          const published = emit("city-published", 1);
          return {
            repositoryUrl: "https://github.com/FelixGeisler/code-city", revision: EVENT, rootTree: ROOT,
            terminal: "success", canvasCount: 1, modelSha256: "1".repeat(64), startedMs,
            endedMs: published.atMs, providerGetCount: 4,
          };
        },
        clearTrace() {},
        async collectCapacity(qualification, emit, startedMs) {
          const pending = native.collectCapacity(qualification, emit, startedMs);
          void driveLimit();
          return pending;
        },
        close: native.close,
      });
    };
    const result = await collectProductionEvidence({
      origin: PRODUCTION_ORIGIN, manifestPath: path.resolve("manifest.json"), output: path.resolve(`native-admission-${kind}`),
    }, seams);
    const expectedReason = kind === "overlap" ? "request-overlap" : "limit-order";
    const expectedStage = kind === "overlap" ? "smoke" : "capacity";
    assert.deepEqual([result.status, result.reason], ["fail", expectedReason], kind);
    assert.equal(bodyCallsAtStop, kind === "overlap" ? 0 : 4004, kind);
    const stage = JSON.parse(new TextDecoder().decode(stored.files.get(`${expectedStage}.json`)));
    const requests = JSON.parse(new TextDecoder().decode(stored.files.get("requests.json")));
    const lifecycle = JSON.parse(new TextDecoder().decode(stored.files.get("lifecycle.json")));
    assert.deepEqual([stage.reason, requests.reason, lifecycle.reason], [expectedReason, expectedReason, expectedReason], kind);
    if (kind === "candidate-4002") {
      assert.equal(stage.data.rawRequestCount, 4001);
      assert.equal(stage.data.candidates.length, 4001);
      assert.equal(requests.data.items.filter((item) => item.applicationCall
        && item.requestedUrl.includes("/facebook/react/") && item.stage === "raw").length, 4001);
    }
  }
});

test("native qualification classifiers flow through the exact qualification stop packet and lifecycle", async () => {
  const cases = [
    ["cors-failure", { revision: { headers: { "Content-Type": "application/json" } } }],
    ["identity-mismatch", { commit: { body: JSON.stringify({ sha: EVENT, tree: { sha: REACT_ROOT } }) } }],
    ["tree-incomplete", { tree: { body: JSON.stringify({ sha: REACT_ROOT, truncated: true, tree: NATIVE_ENTRIES }) } }],
    ["hash-mismatch", { raw: { body: new TextEncoder().encode("different") } }],
    ["content-invalid", { raw: { body: Uint8Array.of(0) } }],
  ];
  for (const [reason, overrides] of cases) {
    let stored;
    const seams = collectorMatrixSeams({ packetSink(value) { if (value) stored = value; return stored; } });
    const controlled = nativeQualificationFetch(overrides);
    seams.qualifyRepository = async ({ now, requestItems, progress }) => qualifyRepository({
      fetchImpl: controlled.fetchImpl, now, requestItems, progress,
    });
    const result = await collectProductionEvidence({
      origin: PRODUCTION_ORIGIN, manifestPath: path.resolve("manifest.json"), output: path.resolve(`native-${reason}`),
    }, seams);
    assert.deepEqual([result.status, result.reason], ["fail", reason]);
    const qualification = JSON.parse(new TextDecoder().decode(stored.files.get("qualification.json")));
    const requests = JSON.parse(new TextDecoder().decode(stored.files.get("requests.json")));
    const lifecycle = JSON.parse(new TextDecoder().decode(stored.files.get("lifecycle.json")));
    assert.deepEqual([qualification.status, qualification.reason], ["fail", reason]);
    assert.deepEqual([requests.status, requests.reason], ["fail", reason]);
    assert.deepEqual([lifecycle.status, lifecycle.reason], ["fail", reason]);
    assert.deepEqual(lifecycle.data.events.slice(-2).map(({ event }) => event), ["qualification-start", "collector-failed"]);
  }
});

test("qualification bound crossings write schema-valid marked packets with the completed safe prefix", async () => {
  const twoMiB = new Uint8Array(2 * 1024 * 1024).fill(0x78);
  const empty = new Uint8Array();
  for (const [name, sourceForIndex, prefixLength] of [
    ["module", (index) => index === 0 ? new Uint8Array(twoMiB.byteLength + 1).fill(0x78) : empty, 0],
    ["aggregate", (index) => index < 20 ? twoMiB : index === 20 ? Uint8Array.of(0x78) : empty, 20],
  ]) {
    let stored;
    const seams = collectorMatrixSeams({ packetSink(value) { if (value) stored = value; return stored; } });
    const controlled = qualificationFetchForSources(sourceForIndex);
    seams.qualifyRepository = async ({ now, requestItems, progress, signal }) => qualifyRepository({
      fetchImpl: controlled.fetchImpl, now, requestItems, progress, signal,
    });
    const result = await collectProductionEvidence({
      origin: PRODUCTION_ORIGIN, manifestPath: path.resolve("manifest.json"), output: path.resolve(`qualification-bound-${name}`),
    }, seams);
    assert.deepEqual([result.status, result.reason], ["fail", "content-invalid"], name);
    const qualification = JSON.parse(new TextDecoder().decode(stored.files.get("qualification.json")));
    const requests = JSON.parse(new TextDecoder().decode(stored.files.get("requests.json")));
    assert.equal(qualification.data.candidates.length, prefixLength, name);
    assert(qualification.data.candidates.every((candidate) => candidate.contentValid), name);
    assert.equal(requests.data.items.filter((item) => item.stage === "raw" && !item.applicationCall).length,
      prefixLength + 1, name);
  }
});

test("browser capacity normalization and hash failures produce stage-aware schema-valid packets at safe prefixes", async () => {
  const twoMiB = new Uint8Array(2 * 1024 * 1024).fill(0x78);
  const empty = new Uint8Array();
  for (const [kind, reason, prefixLength] of [
    ["module", "content-invalid", 0],
    ["aggregate", "content-invalid", 20],
    ["utf8", "content-invalid", 0],
    ["nul", "content-invalid", 0],
    ["hash", "hash-mismatch", 1],
  ]) {
    const sourceForIndex = (index) => {
      if (kind === "module") return index === 0 ? new Uint8Array(twoMiB.byteLength + 1).fill(0x78) : empty;
      if (kind === "aggregate") return index < 20 ? twoMiB : index === 20 ? Uint8Array.of(0x78) : empty;
      if (kind === "utf8") return index === 0 ? Uint8Array.of(0xc3, 0x28) : empty;
      if (kind === "nul") return index === 0 ? Uint8Array.of(0) : empty;
      return index === 0 ? NATIVE_SOURCE : empty;
    };
    const sources = Array.from({ length: 4001 }, (_, index) => sourceForIndex(index));
    const entries = sources.map((source, index) => ({
      path: `${String(index + 1).padStart(4, "0")}.ts`, mode: "100644", type: "blob",
      sha: kind === "hash" && index === 0 ? BLOB : computeGitBlobId(source, 40),
    }));
    let stored;
    const seams = collectorMatrixSeams({ packetSink(value) { if (value) stored = value; return stored; } });
    seams.createBrowserEvidenceSession = async (args) => {
      const harness = fakeCdpHarness();
      const child = fakeChromeChild();
      const native = await createBrowserEvidenceSession({
        ...args,
        launchImpl: async () => ({ child, websocketUrl: "ws://127.0.0.1:1/devtools/browser/id" }),
        connectImpl: () => harness.cdp,
      });
      const drive = async () => {
        await Promise.resolve();
        emitBrowserGet(harness, {
          requestId: `${kind}-revision`, url: revisionUrl("facebook/react"), body: JSON.stringify([{ sha: REACT }]),
        });
        await new Promise((resolve) => setImmediate(resolve));
        harness.emit("Runtime.bindingCalled", { name: "__codeCityCollectorEvidence", payload: JSON.stringify({
          type: "REVISION_SELECTED", generation: 2, revision: REACT,
        }) });
        emitBrowserGet(harness, {
          requestId: `${kind}-commit`, url: commitUrl("facebook/react", REACT),
          body: JSON.stringify({ sha: REACT, tree: { sha: REACT_ROOT } }),
        });
        emitBrowserGet(harness, {
          requestId: `${kind}-tree`, url: treeUrl("facebook/react", REACT_ROOT),
          body: JSON.stringify({ sha: REACT_ROOT, truncated: false, tree: entries }),
        });
        const rawCount = kind === "aggregate" ? 21 : 1;
        for (let index = 0; index < rawCount; index += 1) {
          emitBrowserBytes(harness, {
            requestId: `${kind}-raw-${index + 1}`,
            url: rawUrl("facebook/react", REACT, entries[index].path), bytes: sources[index],
          });
        }
      };
      return Object.freeze({
        cdpVersion: native.cdpVersion,
        fatalSignal: native.fatalSignal,
        snapshot: native.snapshot,
        async collectSmoke(emit, startedMs) {
          directRequest(args.requestItems, args.now, "revision", revisionUrl("FelixGeisler/code-city"), true);
          emit("revision-selected", 1);
          for (const [stage, url] of [
            ["commit", commitUrl("FelixGeisler/code-city", EVENT)],
            ["tree", treeUrl("FelixGeisler/code-city", ROOT)],
            ["raw", rawUrl("FelixGeisler/code-city", EVENT, "src/a.ts")],
          ]) directRequest(args.requestItems, args.now, stage, url, true);
          const published = emit("city-published", 1);
          return { repositoryUrl: "https://github.com/FelixGeisler/code-city", revision: EVENT, rootTree: ROOT,
            terminal: "success", canvasCount: 1, modelSha256: "1".repeat(64), startedMs,
            endedMs: published.atMs, providerGetCount: 4 };
        },
        clearTrace() {},
        async collectCapacity(qualification, emit, startedMs) {
          const pending = native.collectCapacity(qualification, emit, startedMs);
          void drive();
          return pending;
        },
        close: native.close,
      });
    };
    const result = await collectProductionEvidence({
      origin: PRODUCTION_ORIGIN, manifestPath: path.resolve("manifest.json"), output: path.resolve(`browser-bound-${kind}`),
    }, seams);
    assert.deepEqual([result.status, result.reason], ["fail", reason], kind);
    const capacity = JSON.parse(new TextDecoder().decode(stored.files.get("capacity.json")));
    const requests = JSON.parse(new TextDecoder().decode(stored.files.get("requests.json")));
    assert.deepEqual([capacity.status, capacity.reason], ["fail", reason], kind);
    assert.equal(capacity.data.candidates.length, prefixLength, kind);
    assert.equal(requests.data.items.filter((item) => item.applicationCall
      && item.requestedUrl.includes("/facebook/react/") && item.stage === "raw").length,
    kind === "hash" ? 1 : prefixLength + 1, kind);
  }
});

test("native browser CORS and incomplete-tree triggers flow through their owning stop packets and lifecycles", async () => {
  for (const kind of ["cors", "tree"]) {
    let stored;
    const seams = collectorMatrixSeams({ packetSink(value) { if (value) stored = value; return stored; } });
    seams.createBrowserEvidenceSession = async (args) => {
      const harness = fakeCdpHarness();
      const child = fakeChromeChild();
      const native = await createBrowserEvidenceSession({
        ...args,
        launchImpl: async () => ({ child, websocketUrl: "ws://127.0.0.1:1/devtools/browser/id" }),
        connectImpl: () => harness.cdp,
      });
      const driveCors = async () => {
        await Promise.resolve();
        emitBrowserGet(harness, {
          requestId: "cors-revision", url: revisionUrl("FelixGeisler/code-city"),
          body: JSON.stringify([{ sha: EVENT }]), headers: {}, responseHeaders: { "Content-Type": "application/json" },
        });
      };
      const driveTree = async () => {
        await Promise.resolve();
        emitBrowserGet(harness, {
          requestId: "tree-revision", url: revisionUrl("facebook/react"), body: JSON.stringify([{ sha: REACT }]),
        });
        await new Promise((resolve) => setImmediate(resolve));
        harness.emit("Runtime.bindingCalled", { name: "__codeCityCollectorEvidence", payload: JSON.stringify({
          type: "REVISION_SELECTED", generation: 2, revision: REACT,
        }) });
        emitBrowserGet(harness, {
          requestId: "tree-commit", url: commitUrl("facebook/react", REACT),
          body: JSON.stringify({ sha: REACT, tree: { sha: REACT_ROOT } }),
        });
        emitBrowserGet(harness, {
          requestId: "tree-incomplete", url: treeUrl("facebook/react", REACT_ROOT),
          body: JSON.stringify({ sha: REACT_ROOT, truncated: true, tree: NATIVE_ENTRIES }),
        });
      };
      return Object.freeze({
        cdpVersion: native.cdpVersion,
        snapshot: native.snapshot,
        clearTrace: native.clearTrace,
        async collectSmoke(emit, startedMs) {
          if (kind === "cors") {
            const pending = native.collectSmoke(emit, startedMs);
            void driveCors();
            return pending;
          }
          directRequest(args.requestItems, args.now, "revision", revisionUrl("FelixGeisler/code-city"), true);
          emit("revision-selected", 1);
          for (const [stage, url] of [
            ["commit", commitUrl("FelixGeisler/code-city", EVENT)],
            ["tree", treeUrl("FelixGeisler/code-city", ROOT)],
            ["raw", rawUrl("FelixGeisler/code-city", EVENT, "src/a.ts")],
          ]) directRequest(args.requestItems, args.now, stage, url, true);
          const published = emit("city-published", 1);
          return { repositoryUrl: "https://github.com/FelixGeisler/code-city", revision: EVENT, rootTree: ROOT,
            terminal: "success", canvasCount: 1, modelSha256: "1".repeat(64), startedMs,
            endedMs: published.atMs, providerGetCount: 4 };
        },
        async collectCapacity(qualification, emit, startedMs) {
          const pending = native.collectCapacity(qualification, emit, startedMs);
          void driveTree();
          return pending;
        },
        close: native.close,
      });
    };
    const result = await collectProductionEvidence({
      origin: PRODUCTION_ORIGIN, manifestPath: path.resolve("manifest.json"), output: path.resolve(`native-browser-${kind}`),
    }, seams);
    const stage = kind === "cors" ? "smoke" : "capacity";
    const reason = kind === "cors" ? "cors-failure" : "tree-incomplete";
    assert.deepEqual([result.status, result.reason], ["fail", reason]);
    const stagePacket = JSON.parse(new TextDecoder().decode(stored.files.get(`${stage}.json`)));
    const requests = JSON.parse(new TextDecoder().decode(stored.files.get("requests.json")));
    const lifecycle = JSON.parse(new TextDecoder().decode(stored.files.get("lifecycle.json")));
    assert.deepEqual([stagePacket.status, stagePacket.reason], ["fail", reason]);
    assert.deepEqual([requests.reason, lifecycle.reason], [reason, reason]);
    assert.equal(lifecycle.data.events.at(-1).event, "collector-failed");
  }
});

test("native smoke tree, zero-candidate, identity, hash, UTF-8, NUL, and content-bound failures produce marked smoke-failure packets", async () => {
  const cases = ["truncated", "invalid", "zero", "identity", "hash", "utf8", "content", "module", "aggregate"];
  for (const kind of cases) {
    let stored;
    const seams = collectorMatrixSeams({ packetSink(value) { if (value) stored = value; return stored; } });
    seams.createBrowserEvidenceSession = async (args) => {
      const harness = fakeCdpHarness();
      const child = fakeChromeChild();
      const native = await createBrowserEvidenceSession({
        ...args,
        launchImpl: async () => ({ child, websocketUrl: "ws://127.0.0.1:1/devtools/browser/id" }),
        connectImpl: () => harness.cdp,
      });
      const drive = async () => {
        await Promise.resolve();
        emitBrowserGet(harness, {
          requestId: `${kind}-revision`, url: revisionUrl("FelixGeisler/code-city"),
          body: JSON.stringify([{ sha: EVENT }]),
        });
        await new Promise((resolve) => setImmediate(resolve));
        harness.emit("Runtime.bindingCalled", { name: "__codeCityCollectorEvidence", payload: JSON.stringify({
          type: "REVISION_SELECTED", generation: 1, revision: EVENT,
        }) });
        emitBrowserGet(harness, {
          requestId: `${kind}-commit`, url: commitUrl("FelixGeisler/code-city", EVENT),
          body: JSON.stringify({ sha: EVENT, tree: { sha: ROOT } }),
        });
        const twoMiB = new Uint8Array(2 * 1024 * 1024).fill(0x78);
        const rawSources = kind === "aggregate"
          ? Array.from({ length: 21 }, (_, index) => index < 20 ? twoMiB : Uint8Array.of(0x78))
          : [kind === "content" ? Uint8Array.of(0)
            : kind === "utf8" ? Uint8Array.of(0xc3, 0x28)
              : kind === "module" ? new Uint8Array(twoMiB.byteLength + 1).fill(0x78)
                : NATIVE_SOURCE];
        const rawEntries = rawSources.map((source, index) => ({
          path: `src/${String(index + 1).padStart(2, "0")}.ts`, mode: "100644", type: "blob",
          sha: kind === "hash" && index === 0 ? BLOB : computeGitBlobId(source, 40),
        }));
        const treeBody = kind === "invalid" ? "{"
          : JSON.stringify({
            sha: kind === "identity" ? "9".repeat(40) : ROOT,
            truncated: kind === "truncated",
            tree: kind === "zero" ? [] : rawEntries,
          });
        emitBrowserGet(harness, {
          requestId: `${kind}-tree`, url: treeUrl("FelixGeisler/code-city", ROOT), body: treeBody,
        });
        if (["hash", "utf8", "content", "module", "aggregate"].includes(kind)) {
          for (let index = 0; index < rawSources.length; index += 1) {
            emitBrowserBytes(harness, {
              requestId: `${kind}-raw-${index + 1}`,
              url: rawUrl("FelixGeisler/code-city", EVENT, rawEntries[index].path), bytes: rawSources[index],
            });
          }
        }
      };
      return Object.freeze({
        cdpVersion: native.cdpVersion,
        snapshot: native.snapshot,
        clearTrace: native.clearTrace,
        async collectSmoke(emit, startedMs) {
          const pending = native.collectSmoke(emit, startedMs);
          void drive();
          return pending;
        },
        collectCapacity: native.collectCapacity,
        close: native.close,
      });
    };
    const result = await collectProductionEvidence({
      origin: PRODUCTION_ORIGIN, manifestPath: path.resolve("manifest.json"), output: path.resolve(`native-smoke-${kind}`),
    }, seams);
    assert.deepEqual([result.status, result.reason], ["fail", "smoke-failure"], kind);
    const smoke = JSON.parse(new TextDecoder().decode(stored.files.get("smoke.json")));
    const requests = JSON.parse(new TextDecoder().decode(stored.files.get("requests.json")));
    const lifecycle = JSON.parse(new TextDecoder().decode(stored.files.get("lifecycle.json")));
    assert.deepEqual([smoke.status, smoke.reason, requests.reason, lifecycle.reason], [
      "fail", "smoke-failure", "smoke-failure", "smoke-failure",
    ], kind);
    assert.equal(lifecycle.data.events.at(-1).event, "collector-failed", kind);
  }
});

test("pre-packet overlap derivation converts a completed overlap into a marked request-overlap packet", async () => {
  let stored;
  const seams = collectorMatrixSeams({ packetSink(value) { if (value) stored = value; return stored; } });
  const createSession = seams.createBrowserEvidenceSession;
  seams.createBrowserEvidenceSession = async (args) => {
    const session = await createSession(args);
    let progress;
    return {
      ...session,
      async collectSmoke(emit, startedMs) {
        directRequest(args.requestItems, args.now, "revision", revisionUrl("FelixGeisler/code-city"), true);
        emit("revision-selected", 1);
        directRequest(args.requestItems, args.now, "commit", commitUrl("FelixGeisler/code-city", EVENT), true);
        directRequest(args.requestItems, args.now, "tree", treeUrl("FelixGeisler/code-city", ROOT), true);
        const gets = args.requestItems.slice(-2);
        gets[0].endedMs = gets[1].endedMs;
        progress = {
          repositoryUrl: "https://github.com/FelixGeisler/code-city", revision: EVENT, rootTree: ROOT,
          terminal: null, canvasCount: null, modelSha256: null, startedMs, endedMs: null, providerGetCount: 3,
        };
        throw new Error("controlled post-exchange observation failure");
      },
      snapshot(kind) { return kind === "smoke" ? progress : session.snapshot?.(kind); },
    };
  };
  const result = await collectProductionEvidence({
    origin: PRODUCTION_ORIGIN, manifestPath: path.resolve("manifest.json"), output: path.resolve("derived-overlap"),
  }, seams);
  assert.deepEqual([result.status, result.reason], ["fail", "request-overlap"]);
  const smoke = JSON.parse(new TextDecoder().decode(stored.files.get("smoke.json")));
  const lifecycle = JSON.parse(new TextDecoder().decode(stored.files.get("lifecycle.json")));
  assert.deepEqual([smoke.reason, lifecycle.reason, lifecycle.data.events.at(-1).event], [
    "request-overlap", "request-overlap", "collector-failed",
  ]);
});

test("collector controlled matrix produces a schema-valid marked packet for every handled stage and reason class", async () => {
  for (const [stage, reasons] of Object.entries(HANDLED_REASONS)) {
    for (const reason of reasons) {
      const { result, stored } = await collectHandledMatrix(stage, reason);
      assert.equal(result.status, "fail", `${stage}/${reason}`);
      assert.equal(result.reason, reason, `${stage}/${reason}`);
      const lifecycle = JSON.parse(new TextDecoder().decode(stored.files.get("lifecycle.json")));
      assert.equal(lifecycle.reason, reason, `${stage}/${reason}`);
      assert.equal(lifecycle.data.events.at(-1).event, "collector-failed", `${stage}/${reason}`);
    }
  }
});

test("progressed qualification failure preserves its start event and completed safe request through stop", async () => {
  let stored;
  const seams = collectorMatrixSeams({
    failStage: "qualification", reason: "provider-failure", progressedQualification: true,
    packetSink(value) { if (value) stored = value; return stored; },
  });
  await collectProductionEvidence({
    origin: PRODUCTION_ORIGIN, manifestPath: path.resolve("manifest.json"), output: path.resolve("progressed-qualification"),
  }, seams);
  const qualification = JSON.parse(new TextDecoder().decode(stored.files.get("qualification.json")));
  const requests = JSON.parse(new TextDecoder().decode(stored.files.get("requests.json")));
  const lifecycle = JSON.parse(new TextDecoder().decode(stored.files.get("lifecycle.json")));
  assert.equal(qualification.data.revision, REACT);
  assert.equal(requests.data.items.filter((item) => !item.applicationCall && item.requestedUrl.includes("/facebook/react/")).length, 1);
  assert.deepEqual(lifecycle.data.events.slice(-2).map((event) => event.event), ["qualification-start", "collector-failed"]);
});

test("progressed capacity failure preserves all 4,001 facts, 4,004 completed requests, and the exact lifecycle prefix", async () => {
  let stored;
  const seams = collectorMatrixSeams({
    failStage: "capacity", reason: "quiescence-failure", progressedCapacity: true,
    packetSink(value) { if (value) stored = value; return stored; },
  });
  const result = await collectProductionEvidence({
    origin: PRODUCTION_ORIGIN, manifestPath: path.resolve("manifest.json"), output: path.resolve("progressed-capacity"),
  }, seams);
  assert.equal(result.reason, "quiescence-failure");
  const capacity = JSON.parse(new TextDecoder().decode(stored.files.get("capacity.json")));
  const requests = JSON.parse(new TextDecoder().decode(stored.files.get("requests.json")));
  const lifecycle = JSON.parse(new TextDecoder().decode(stored.files.get("lifecycle.json")));
  assert.equal(capacity.data.candidates.length, 4001);
  assert.equal(capacity.data.rawRequestCount, 4001);
  assert.equal(requests.data.items.filter((item) => item.applicationCall && item.requestedUrl.includes("/facebook/react/")).length, 4004);
  assert.deepEqual(lifecycle.data.events.slice(-2).map((event) => event.event), ["limit-failure", "collector-failed"]);
  assert.equal(lifecycle.data.maxOverlap, 1);
});

test("schema/privacy packet construction failure writes no handled packet and adapter failures never trigger read-back", async () => {
  let wrote = false;
  let read = false;
  const seams = collectorMatrixSeams({ failStage: "artifact", reason: "artifact-mismatch" });
  seams.createEvidencePacket = () => { throw new Error("controlled privacy/schema rejection"); };
  seams.writeValidatedEvidencePacket = async () => { wrote = true; };
  seams.readValidatedEvidencePacket = async () => { read = true; };
  await assert.rejects(collectProductionEvidence({
    origin: PRODUCTION_ORIGIN, manifestPath: path.resolve("manifest.json"), output: path.resolve("schema-rejected"),
  }, seams), /privacy\/schema rejection/u);
  assert.equal(wrote, false);
  assert.equal(read, false);

  delete seams.createEvidencePacket;
  seams.writeValidatedEvidencePacket = async () => { throw new Error("controlled marker commit rejection"); };
  await assert.rejects(collectProductionEvidence({
    origin: PRODUCTION_ORIGIN, manifestPath: path.resolve("manifest.json"), output: path.resolve("marker-rejected"),
  }, seams), /marker commit rejection/u);
  assert.equal(read, false);
});

test("collector awaits the #494 writer and reader APIs and owns no storage rename", async () => {
  let stored;
  let resolveWrite;
  let resolveRead;
  let readCalled = false;
  const writeGate = new Promise((resolve) => { resolveWrite = resolve; });
  const readGate = new Promise((resolve) => { resolveRead = resolve; });
  const seams = collectorMatrixSeams({ failStage: "artifact", reason: "artifact-mismatch" });
  seams.writeValidatedEvidencePacket = async (_output, packet) => {
    stored = validateEvidencePacket(packet.files, packet.binding);
    await writeGate;
  };
  seams.readValidatedEvidencePacket = async () => { readCalled = true; await readGate; return stored; };
  const pending = collectProductionEvidence({
    origin: PRODUCTION_ORIGIN, manifestPath: path.resolve("manifest.json"), output: path.resolve("awaited-adapter"),
  }, seams);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(readCalled, false);
  resolveWrite();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(readCalled, true);
  let settled = false;
  pending.finally(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  resolveRead();
  assert.equal((await pending).status, "fail");

  const source = await readFile(new URL("../tools/collect-production-evidence.mjs", import.meta.url), "utf8");
  assert(!/\brename\s*\(/u.test(source));
  assert(!/\.validated(?:\.staged)?/u.test(source));
  assert.match(source, /await \(seams\.writeValidatedEvidencePacket \?\? writeValidatedEvidencePacket\)/u);
  assert.match(source, /await \(seams\.readValidatedEvidencePacket \?\? readValidatedEvidencePacket\)/u);
});

test("controlled smoke observes exact request identities and remains pending until target detachment", async () => {
  const opened = await openFakeBrowser();
  const emitted = [];
  const pending = opened.session.collectSmoke((event, generation, atMs) => {
    const value = { event, generation, atMs: atMs ?? emitted.length + 1 };
    emitted.push(value);
    return value;
  }, 0);
  await Promise.resolve();
  opened.harness.emit("Target.attachedToTarget", { sessionId: "worker-session", targetInfo: { type: "worker", targetId: "worker-target" } }, "");
  await new Promise((resolve) => setImmediate(resolve));
  const workerCommands = opened.harness.calls.filter(({ sessionId }) => sessionId === "worker-session");
  assert.deepEqual(workerCommands.map(({ method }) => method), [
    "Runtime.enable", "Network.enable", "Runtime.runIfWaitingForDebugger",
  ]);
  assert(!workerCommands.some(({ method }) => ["Runtime.addBinding", "Runtime.evaluate", "Page.addScriptToEvaluateOnNewDocument"].includes(method)));
  assert.equal(opened.harness.calls.filter(({ method, sessionId }) => method === "Runtime.addBinding" && sessionId === "page-session").length, 1);

  emitBrowserGet(opened.harness, {
    requestId: "smoke-revision", url: revisionUrl("FelixGeisler/code-city"),
    body: `${JSON.stringify([{ sha: EVENT }])}\n`,
  });
  await new Promise((resolve) => setImmediate(resolve));
  opened.harness.emit("Runtime.bindingCalled", { name: "__codeCityCollectorEvidence", payload: JSON.stringify({ type: "REVISION_SELECTED", generation: 1, revision: EVENT }) });

  emitBrowserGet(opened.harness, {
    requestId: "smoke-commit", url: commitUrl("FelixGeisler/code-city", EVENT),
    body: `${JSON.stringify({ sha: EVENT, tree: { sha: ROOT } })}\n`,
  });
  const source = new TextEncoder().encode("x");
  const blob = computeGitBlobId(source, 40);
  emitBrowserGet(opened.harness, {
    requestId: "smoke-tree", url: treeUrl("FelixGeisler/code-city", ROOT),
    body: `${JSON.stringify({ sha: ROOT, truncated: false, tree: [{ path: "src/a.ts", mode: "100644", type: "blob", sha: blob }] })}\n`,
  });
  emitBrowserGet(opened.harness, {
    requestId: "smoke-raw", url: rawUrl("FelixGeisler/code-city", EVENT, "src/a.ts"), body: "x",
  });
  await new Promise((resolve) => setImmediate(resolve));
  opened.harness.emit("Runtime.bindingCalled", { name: "__codeCityCollectorEvidence", payload: JSON.stringify({ type: "SUCCESS", generation: 1, revision: EVENT, modelSha256: "1".repeat(64) }) });
  opened.harness.emit("Runtime.bindingCalled", { name: "__codeCityCollectorEvidence", payload: JSON.stringify({ type: "ATTEMPT_DRAINED", generation: 1 }) });

  const beforeDetach = await Promise.race([
    pending.then(() => "settled", () => "rejected"),
    new Promise((resolve) => setTimeout(() => resolve("pending"), 20)),
  ]);
  assert.equal(beforeDetach, "pending");
  opened.harness.emit("Target.detachedFromTarget", { sessionId: "worker-session", targetId: "worker-target" }, "");
  const smoke = await pending;
  assert.equal(smoke.providerGetCount, 4);
  assert.equal(smoke.revision, EVENT);
  assert.deepEqual(emitted.map((item) => item.event), ["revision-selected", "city-published"]);
  await opened.session.close();
  assert.equal(opened.child.kills, 1);
});
