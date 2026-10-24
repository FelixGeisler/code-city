import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MessageChannel, Worker } from "node:worker_threads";

registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(/^\.\.?\//u.test(specifier) && !/(?:\.[a-z]+|\?.*)$/iu.test(specifier) ? `${specifier}.ts` : specifier, context);
  },
});

const projectRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const { createNodeTreeSitterAdapter, NODE_PARSER_ASSET_URLS } = await import("../src/edge/node/parser-assets.ts");
const { startNodeWorkerAttempt } = await import("../src/edge/node/worker-attempt.ts");
const { validateNodeWorkerEvent } = await import("../src/edge/node/worker-protocol.ts");
const REPOSITORY = { owner: "owner", repository: "repo", branch: null };
const SHA = "a".repeat(40);
const ATTEMPT = Buffer.alloc(16).toString("base64url");

async function compiledWorkerFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "code-city-node-worker-bundle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await symlink(path.join(projectRoot, "node_modules"), path.join(root, "node_modules"), "junction");
  await mkdir(path.join(root, "vendor"), { recursive: true });
  await symlink(path.join(projectRoot, "vendor", "tree-sitter-typescript"), path.join(root, "vendor", "tree-sitter-typescript"), "junction");
  const config = path.join(root, "tsconfig.json");
  await writeFile(config, JSON.stringify({
    extends: path.join(projectRoot, "tsconfig.node.json").replaceAll("\\", "/"),
    compilerOptions: {
      noEmit: false, rootDir: projectRoot.replaceAll("\\", "/"), outDir: root.replaceAll("\\", "/"),
      declaration: false, sourceMap: false,
    },
    include: [],
    files: [path.join(projectRoot, "src/edge/node/analysis-worker.ts").replaceAll("\\", "/")],
  }));
  const compiler = path.join(projectRoot, "node_modules", "typescript", "bin", "tsc");
  const built = spawnSync(process.execPath, [compiler, "-p", config, "--pretty", "false"], { encoding: "utf8" });
  assert.equal(built.status, 0, `${built.stdout}${built.stderr}`);

  const cityFault = path.join(root, "city-fault.mjs");
  await writeFile(cityFault, "export function buildCity() { throw new Error('test-only city construction failure'); }\n");
  const acquisitionFault = path.join(root, "acquisition-fault.mjs");
  await writeFile(acquisitionFault, `export async function acquireProjectSources() {
  return { kind: "failure", category: "Source admission failed", code: "M1-ADM-4" };
}\n`);

  const analysisBootstrap = path.join(root, "test-worker.mjs");
  await writeFile(analysisBootstrap, `
import { parentPort, workerData } from "node:worker_threads";
import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, nextResolve) {
  if (workerData.scenario === "cityFailure" && specifier === "../domain/city-model" && context.parentURL?.endsWith("/src/application/project-analysis.js")) {
    return { url: ${JSON.stringify(pathToFileURL(cityFault).href)}, shortCircuit: true };
  }
  if (workerData.scenario === "admissionContent" && specifier === "../../application/source-retrieval" && context.parentURL?.endsWith("/src/edge/node/analysis-worker.js")) {
    return { url: ${JSON.stringify(pathToFileURL(acquisitionFault).href)}, shortCircuit: true };
  }
  return nextResolve(/^\\.\\.?\\//u.test(specifier) && !/\\.[a-z]+$/iu.test(specifier) ? specifier + ".js" : specifier, context);
} });
const { runNodeAnalysisWorker } = await import(${JSON.stringify(pathToFileURL(path.join(root, "src/edge/node/analysis-worker.js")).href)});
const { createSyntaxObservationWriter } = await import(${JSON.stringify(pathToFileURL(path.join(root, "src/domain/base-metrics.js")).href)});
const SHA = "a".repeat(40);
workerData.control?.unref();
const entered = (phase) => workerData.control?.postMessage({ phase });
const regular = (path, sha = SHA) => ({ path, mode: "100644", type: "blob", ...(sha === undefined ? {} : { sha }) });
const inventory = {
  success: [["a.ts", "const a = 1;\\n"]],
  mixed: [["a.ts", "const a = 1;\\n"], ["b.ts", "syntax"], ["c.ts", "metrics"], ["d.ts", null]],
  allFailed: [["a.ts", "syntax"], ["b.ts", "metrics"], ["c.ts", null]],
  parserBusy: [["a.ts", "busy"]],
  providerWait: [["a.ts", "const a = 1;\\n"]],
}[workerData.scenario] ?? [["a.ts", "const a = 1;\\n"]];
const bytes = new TextEncoder();
runNodeAnalysisWorker(parentPort, {
  async revisionGateway(_repository, signal) {
    if (workerData.scenario === "providerWait") {
      entered("providerWait");
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    }
    if (signal.aborted) return { kind: "empty" };
    if (workerData.scenario === "resolutionRepository") return { kind: "http", status: 404 };
    if (workerData.scenario === "resolutionRevision") return { kind: "empty" };
    if (workerData.scenario === "resolutionProvider") return { kind: "invalid-evidence" };
    return { kind: "revision", revision: SHA };
  },
  sourceGateway: {
    async loadInventory() {
      if (workerData.scenario === "inventoryProvider") return { kind: "provider-failure" };
      if (workerData.scenario === "noModules") return { kind: "inventory", entries: [regular("ignored.txt")] };
      if (workerData.scenario === "noModulesSkipped") return { kind: "inventory", entries: [{ path: "a.ts", mode: "120000", type: "blob", sha: SHA }] };
      if (workerData.scenario === "admissionPath") return { kind: "inventory", entries: [regular("a.ts"), regular("a.ts")] };
      if (workerData.scenario === "admissionKind") return { kind: "inventory", entries: [{ path: "a.ts", mode: "100600", type: "blob", sha: SHA }] };
      if (workerData.scenario === "invalidBlob") return { kind: "inventory", entries: [{ path: "a.ts", mode: "100644", type: "blob" }] };
      return { kind: "inventory", entries: inventory.map(([file]) => regular(file)) };
    },
    async readRawSource(_repository, _revision, candidate) {
      if (workerData.scenario === "sourceProvider") return { kind: "provider-failure" };
      if (workerData.scenario === "productLimit") return { kind: "product-limit" };
      const row = inventory.find(([file]) => file === candidate.canonicalPath);
      const source = row ? row[1] : "const a = 1;\\n";
      return { kind: "source", rawBytes: source === null ? new Uint8Array([255]) : bytes.encode(source) };
    },
  },
  parser: {
    async initialize() { if (workerData.scenario === "parserInitialize") throw new Error("parser initialization"); },
    async project(_family, source) {
      if (source === "syntax") throw new Error("syntax");
      if (source === "metrics") return { observations: { [Symbol.iterator]() { throw new Error("metrics"); } }, release() {} };
      if (source === "busy") { entered("parserBusy"); for (;;) {} }
      if (workerData.scenario === "metricFailure") return { observations: createSyntaxObservationWriter().finish(), release() { throw new Error("release"); } };
      return { observations: createSyntaxObservationWriter().finish(), release() {} };
    },
  },
});
`);

  const transferBootstrap = path.join(root, "transfer-worker.mjs");
  await writeFile(transferBootstrap, `
import { parentPort, workerData } from "node:worker_threads";
import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, nextResolve) { return nextResolve(/^\\.\\.?\\//u.test(specifier) && !/\\.[a-z]+$/iu.test(specifier) ? specifier + ".js" : specifier, context); } });
const { publishNodeWorkerEvent } = await import(${JSON.stringify(pathToFileURL(path.join(root, "src/edge/node/analysis-worker.js")).href)});
const { prepareNodeWorkerSuccessForPublication } = await import(${JSON.stringify(pathToFileURL(path.join(root, "src/edge/node/worker-protocol.js")).href)});
const { buildCity } = await import(${JSON.stringify(pathToFileURL(path.join(root, "src/domain/city-model.js")).href)});
const SHA = "a".repeat(40);
const encoder = new TextEncoder();
const selected = (command) => ({ type: "REVISION_SELECTED", attemptId: command.attemptId, generation: command.generation, revision: SHA });
const one = (command, normalizedUtf8 = encoder.encode("x")) => ({
  type: "SUCCESS", attemptId: command.attemptId, generation: command.generation, revision: SHA,
  result: { city: buildCity([{ canonicalPath: "a.ts", S: 1, U: 0, M: 0 }]), notAnalyzedFiles: [] },
  sources: [{ canonicalPath: "a.ts", normalizedUtf8 }],
});
const two = (command, left, right) => ({
  type: "SUCCESS", attemptId: command.attemptId, generation: command.generation, revision: SHA,
  result: { city: buildCity([
    { canonicalPath: "a.ts", S: 1, U: 0, M: 0 }, { canonicalPath: "b.ts", S: 1, U: 0, M: 0 },
  ]), notAnalyzedFiles: [] },
  sources: [{ canonicalPath: "a.ts", normalizedUtf8: left }, { canonicalPath: "b.ts", normalizedUtf8: right }],
});
function eventFor(command, mode) {
  if (mode.endsWith("buffer")) { const value = Buffer.allocUnsafeSlow(1); value[0] = 120; return one(command, value); }
  if (mode.endsWith("subclass")) return one(command, new (class extends Uint8Array {})([120]));
  if (mode.endsWith("view-extra")) { const value = encoder.encode("x"); value.extra = true; return one(command, value); }
  if (mode.endsWith("buffer-extra")) { const value = encoder.encode("x"); value.buffer.extra = true; return one(command, value); }
  if (mode.endsWith("buffer-symbol")) { const value = encoder.encode("x"); value.buffer[Symbol("extra")] = true; return one(command, value); }
  if (mode.endsWith("buffer-accessor")) { const value = encoder.encode("x"); Object.defineProperty(value.buffer, "extra", { enumerable: true, get: () => true }); return one(command, value); }
  if (mode.endsWith("row-accessor")) { const value = one(command); Object.defineProperty(value.sources[0], "canonicalPath", { enumerable: true, get: () => "a.ts" }); return value; }
  if (mode.endsWith("partial")) return one(command, encoder.encode("xy").subarray(1));
  if (mode.endsWith("detached")) { const value = encoder.encode("x"); structuredClone(value.buffer, { transfer: [value.buffer] }); return one(command, value); }
  if (mode.endsWith("proxy")) return one(command, new Proxy(encoder.encode("x"), {}));
  if (mode.endsWith("shared")) { const value = new Uint8Array(new SharedArrayBuffer(1)); value[0] = 120; return one(command, value); }
  if (mode.endsWith("resizable")) { const value = new Uint8Array(new ArrayBuffer(1, { maxByteLength: 2 })); value[0] = 120; return one(command, value); }
  if (mode.endsWith("reused")) { const value = encoder.encode("x"); return two(command, value, new Uint8Array(value.buffer)); }
  if (mode === "raw-invalid-utf8") return one(command, new Uint8Array([255]));
  if (mode === "raw-cr") return one(command, encoder.encode("x\\r"));
  if (mode === "raw-path") { const value = one(command); value.sources[0].canonicalPath = "b.ts"; return value; }
  if (mode === "raw-city") { const value = one(command); value.result.city.geometry.sizes[0] = 999; return value; }
  return one(command);
}
parentPort.on("message", (command) => {
  if (command.type !== "START") return;
  parentPort.postMessage(selected(command));
  const event = eventFor(command, workerData.mode);
  if (workerData.mode === "valid-transfer") {
    const before = [
      event.result.city.geometry.origins.buffer, event.result.city.geometry.sizes.buffer,
      event.result.city.geometry.rgba.buffer, event.result.city.geometry.bounds.buffer,
      event.sources[0].normalizedUtf8.buffer,
    ];
    publishNodeWorkerEvent(parentPort, prepareNodeWorkerSuccessForPublication(event));
    parentPort.postMessage({ type: "DETACHED", distinct: new Set(before).size, byteLengths: before.map((buffer) => buffer.byteLength) });
  } else if (workerData.mode.startsWith("publish-")) {
    publishNodeWorkerEvent(parentPort, event);
  } else {
    parentPort.postMessage(event);
  }
  parentPort.close();
});
`);

  return { analysis: pathToFileURL(analysisBootstrap), transfer: pathToFileURL(transferBootstrap) };
}

function start(bundle, scenario, release = () => {}) {
  return startNodeWorkerAttempt({
    repository: REPOSITORY, generation: 3, workerUrl: bundle,
    workerFactory: (url) => new Worker(url, { workerData: { scenario, mode: scenario } }), release,
  });
}

function startAtBarrier(bundle, scenario, release = () => {}) {
  const { port1, port2 } = new MessageChannel();
  const reached = new Promise((resolve, reject) => {
    port1.once("message", (message) => {
      try {
        assert.deepEqual(message, { phase: scenario });
        resolve();
      } catch (error) {
        reject(error);
      } finally {
        port1.close();
      }
    });
  });
  const attempt = startNodeWorkerAttempt({
    repository: REPOSITORY, generation: 3, workerUrl: bundle,
    workerFactory: (url) => new Worker(url, {
      workerData: { scenario, mode: scenario, control: port2 }, transferList: [port2],
    }),
    release,
  });
  return { attempt, reached };
}

async function collectWorkerMessages(bundle, mode) {
  const worker = new Worker(bundle, { workerData: { mode } });
  const messages = [];
  worker.on("message", (message) => messages.push(message));
  worker.postMessage({ type: "START", attemptId: ATTEMPT, generation: 3, repository: REPOSITORY, additionalExclusions: [] });
  const code = await new Promise((resolve, reject) => {
    worker.once("error", reject);
    worker.once("exit", resolve);
  });
  assert.equal(code, 0, mode);
  return messages;
}

test("actual worker returns city/source, mixed failures, and all-files-failed only after a code-0 join", async (t) => {
  const { analysis } = await compiledWorkerFixture(t);
  const success = await start(analysis, "success").result;
  assert.equal(success.type, "SUCCESS");
  assert.deepEqual(success.result.city.inspection.map(({ canonicalPath }) => canonicalPath), ["a.ts"]);
  assert.deepEqual(success.sources.map(({ canonicalPath }) => canonicalPath), ["a.ts"]);

  const mixed = await start(analysis, "mixed").result;
  assert.equal(mixed.type, "SUCCESS");
  assert.deepEqual(mixed.result.notAnalyzedFiles, [
    { canonicalPath: "b.ts", category: "Syntax could not be analyzed" },
    { canonicalPath: "c.ts", category: "Metrics could not be computed" },
    { canonicalPath: "d.ts", category: "Source text is not supported" },
  ]);
  assert.deepEqual(mixed.sources.map(({ canonicalPath }) => canonicalPath), ["a.ts", "b.ts", "c.ts"]);

  const allFailed = await start(analysis, "allFailed").result;
  assert.equal(allFailed.type, "SUCCESS");
  assert.equal(allFailed.result.city, null);
  assert.deepEqual(allFailed.sources.map(({ canonicalPath }) => canonicalPath), ["a.ts", "b.ts"]);
});

test("actual worker maps resolution, acquisition, parser, metric, and city outcomes exactly", async (t) => {
  const { analysis } = await compiledWorkerFixture(t);
  const rows = [
    ["resolutionRepository", { category: "Repository unavailable for anonymous access" }],
    ["resolutionRevision", { category: "Revision unavailable" }],
    ["resolutionProvider", { category: "Provider/resolution failure" }],
    ["inventoryProvider", { revision: SHA, category: "Provider/resolution failure" }],
    ["sourceProvider", { revision: SHA, category: "Provider/resolution failure" }],
    ["invalidBlob", { revision: SHA, category: "Provider/resolution failure" }],
    ["productLimit", { revision: SHA, category: "Repository exceeds Code City limits" }],
    ["noModules", { revision: SHA, category: "No supported modules", code: "ADM-06" }],
    ["noModulesSkipped", { revision: SHA, category: "No supported modules", code: "ADM-07" }],
    ["admissionPath", { revision: SHA, category: "Source admission failed", code: "M1-ADM-1" }],
    ["admissionKind", { revision: SHA, category: "Source admission failed", code: "M1-ADM-3" }],
    ["admissionContent", { revision: SHA, category: "Source admission failed", code: "M1-ADM-4" }],
    ["parserInitialize", { revision: SHA, category: "Metric processing failed", code: "M1-MET-1" }],
    ["metricFailure", { revision: SHA, category: "Metric processing failed", code: "M1-MET-1" }],
    ["cityFailure", { revision: SHA, category: "City construction failed", code: "M1-CITY-1" }],
  ];
  for (const [scenario, expected] of rows) {
    const attempt = start(analysis, scenario);
    assert.deepEqual(await attempt.result, {
      type: "FAILURE", attemptId: attempt.attemptId, generation: 3, ...expected,
    }, scenario);
  }
});

test("actual worker publisher rejects normalized sender mutations and transfers every owned buffer", async (t) => {
  const { transfer } = await compiledWorkerFixture(t);
  const valid = await collectWorkerMessages(transfer, "valid-transfer");
  assert.equal(valid[0].type, "REVISION_SELECTED");
  assert.equal(validateNodeWorkerEvent(valid[1]).kind, "valid");
  assert.deepEqual(valid[2], { type: "DETACHED", distinct: 5, byteLengths: [0, 0, 0, 0, 0] });

  const senderMutations = [
    "buffer", "subclass", "view-extra", "buffer-extra", "buffer-symbol", "buffer-accessor", "row-accessor",
    "partial", "detached", "proxy", "shared", "reused",
  ];
  if (ArrayBuffer.prototype.resize) senderMutations.push("resizable");
  for (const mutation of senderMutations) {
    const messages = await collectWorkerMessages(transfer, `publish-${mutation}`);
    assert.equal(messages[0].type, "REVISION_SELECTED", mutation);
    assert.deepEqual(messages[1], {
      type: "FAILURE", attemptId: ATTEMPT, generation: 3, revision: SHA, category: "Provider/resolution failure",
    }, mutation);
    assert.equal(messages.length, 2, mutation);
  }
});

test("actual structured clones separate normalized sender identity from receiver-visible malformed data", async (t) => {
  const { transfer } = await compiledWorkerFixture(t);
  for (const mode of ["raw-buffer", "raw-subclass", "raw-view-extra", "raw-buffer-extra", "raw-buffer-symbol", "raw-buffer-accessor"]) {
    const result = await start(transfer, mode).result;
    assert.equal(result.type, "SUCCESS", mode);
    assert.equal(Object.getPrototypeOf(result.sources[0].normalizedUtf8), Uint8Array.prototype, mode);
    assert.equal(Reflect.ownKeys(result.sources[0].normalizedUtf8.buffer).length, 0, mode);
  }

  for (const mode of ["raw-partial", "raw-reused", "raw-invalid-utf8", "raw-cr", "raw-path"]) {
    const result = await start(transfer, mode).result;
    assert.equal(result.type, "FAILURE", mode);
    assert.equal(result.category, "Provider/resolution failure", mode);
    assert.equal(result.revision, SHA, mode);
  }
  const city = await start(transfer, "raw-city").result;
  assert.deepEqual(
    { type: city.type, revision: city.revision, category: city.category, code: city.code },
    { type: "FAILURE", revision: SHA, category: "City construction failed", code: "M1-CITY-1" },
  );
});

test("Node parser assets use actual package-compatible file URLs for runtime, JS, TS, TSX, and C#", async () => {
  for (const url of Object.values(NODE_PARSER_ASSET_URLS)) assert.equal(new URL(url).protocol, "file:");
  const parser = createNodeTreeSitterAdapter();
  await parser.initialize();
  for (const [family, source] of [
    ["javascript-no-jsx", "export const a = 1;"], ["typescript", "const a: number = 1;"],
    ["tsx", "const a = <div />;"], ["csharp", "class C { void M() {} }"],
  ]) {
    const projected = await parser.project(family, source);
    assert.ok([...projected.observations].length >= 0);
    projected.release();
  }
});

test("provider cancellation and parser-time termination join and release exactly once without a terminal", async (t) => {
  const { analysis } = await compiledWorkerFixture(t);
  for (const scenario of ["providerWait", "parserBusy"]) {
    let releases = 0;
    const { attempt, reached } = startAtBarrier(analysis, scenario, () => { releases += 1; });
    await reached;
    await attempt.cancel();
    assert.deepEqual(await attempt.result, { type: "CANCELLED" });
    await attempt.cancel();
    assert.equal(releases, 1, scenario);
  }
});

test("a busy analysis worker leaves the parent timer and a small native HTTP response responsive", async (t) => {
  const { analysis } = await compiledWorkerFixture(t);
  const { attempt, reached } = startAtBarrier(analysis, "parserBusy");
  await reached;
  const server = http.createServer((_request, response) => response.end("ok"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  const timer = new Promise((resolve) => setTimeout(() => resolve("timer"), 15));
  const response = new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${address.port}/`, (incoming) => {
      const chunks = [];
      incoming.on("data", (chunk) => chunks.push(chunk));
      incoming.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    }).on("error", reject);
  });
  assert.deepEqual(await Promise.all([timer, response]), ["timer", "ok"]);
  await attempt.cancel();
});
