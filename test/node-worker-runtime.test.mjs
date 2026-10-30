import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
const { validateNodeWorkerStructuredCloneEvent } = await import("../src/edge/node/worker-protocol.ts");
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
  const firstSourceMutationFault = path.join(root, "first-source-mutation-fault.mjs");
  const projectAnalysisUrl = `${pathToFileURL(path.join(root, "src/application/project-analysis.js")).href}?production-first-source-mutation`;
  await writeFile(firstSourceMutationFault, `
import { analyzeProjectSources as analyzeProductionProjectSources } from ${JSON.stringify(projectAnalysisUrl)};
export async function analyzeProjectSources(acquired, parser) {
  const result = await analyzeProductionProjectSources(acquired, parser);
  if (result.kind === "analyzed" && result.result.sources.length > 0) {
    result.result.sources[0].normalizedUtf8[0] = 0;
  }
  return result;
}
`);

  const analysisBootstrap = path.join(root, "test-worker.mjs");
  await writeFile(analysisBootstrap, `
import { parentPort, workerData } from "node:worker_threads";
import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, nextResolve) {
  if (workerData.scenario === "cityFailure"
    && (specifier === "../domain/city-model" || specifier === "../../domain/city-model")
    && (context.parentURL?.endsWith("/src/application/project-analysis.js") || context.parentURL?.endsWith("/src/application/analyze-repository.js"))) {
    return { url: ${JSON.stringify(pathToFileURL(cityFault).href)}, shortCircuit: true };
  }
  if (workerData.scenario === "admissionContent" && specifier === "./source-retrieval" && context.parentURL?.endsWith("/src/application/analyze-repository.js")) {
    return { url: ${JSON.stringify(pathToFileURL(acquisitionFault).href)}, shortCircuit: true };
  }
  if (workerData.scenario === "firstSourceMutation" && specifier === "./project-analysis" && context.parentURL?.endsWith("/src/application/analyze-repository.js")) {
    return { url: ${JSON.stringify(pathToFileURL(firstSourceMutationFault).href)}, shortCircuit: true };
  }
  return nextResolve(/^\\.\\.?\\//u.test(specifier) && !/\\.[a-z]+$/iu.test(specifier) ? specifier + ".js" : specifier, context);
} });
const { runNodeAnalysisWorker } = await import(${JSON.stringify(pathToFileURL(path.join(root, "src/edge/node/analysis-worker.js")).href)});
const { createSyntaxObservationWriter } = await import(${JSON.stringify(pathToFileURL(path.join(root, "src/domain/base-metrics.js")).href)});
const SHA = "a".repeat(40);
workerData.control?.unref();
const entered = (phase) => workerData.control?.postMessage({ phase });
const waitForRelease = async (phase) => {
  if (!workerData.control) return;
  await new Promise((resolve) => {
    const listener = (message) => {
      if (message?.release !== phase) return;
      workerData.control.off("message", listener);
      resolve();
    };
    workerData.control.on("message", listener);
    entered(phase);
  });
};
const regular = (path, sha = SHA) => ({ path, mode: "100644", type: "blob", ...(sha === undefined ? {} : { sha }) });
const inventory = {
  success: [["a.ts", "const a = 1;\\n"]],
  mixed: [["a.ts", "const a = 1;\\n"], ["b.ts", "syntax"], ["c.ts", "metrics"], ["d.ts", null]],
  allFailed: [["a.ts", "syntax"], ["b.ts", "metrics"], ["c.ts", null]],
  zeroText: [["a.ts", null]],
  parserBusy: [["a.ts", "busy"]],
  providerWait: [["a.ts", "const a = 1;\\n"]],
  firstSourceMutation: [["a.ts", "const a = 1;\\n"], ["b.ts", "const b = 1;\\n"]],
  progressBarriers: [["a.ts", "const a = 1;\\n"], ["b.ts", "const b = 1;\\n"], ["c.ts", "const c = 1;\\n"]],
}[workerData.scenario] ?? [["a.ts", "const a = 1;\\n"]];
const bytes = new TextEncoder();
let sourceReadCount = 0;
let projectCount = 0;
if (workerData.scenario === "earlyExit") {
  await waitForRelease("early-exit");
  parentPort.close();
} else runNodeAnalysisWorker(parentPort, {
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
      if (workerData.scenario === "progressBarriers") {
        const sourceIndex = sourceReadCount++;
        if (sourceReadCount === 3) entered("acquisition-window-filled");
        if (sourceIndex === 0) await waitForRelease("first-acquisition");
      }
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
      if (workerData.scenario === "progressBarriers" && projectCount++ === 0) await waitForRelease("first-analysis");
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
const { createFixedTransferNormalizedUtf8 } = await import(${JSON.stringify(pathToFileURL(path.join(root, "src/application/internal/source-byte-ownership.js")).href)});
const SHA = "a".repeat(40);
const encoder = new TextEncoder();
const selected = (command) => ({ type: "REVISION_SELECTED", attemptId: command.attemptId, generation: command.generation, revision: SHA });
const fixedTransferBytes = (source) => createFixedTransferNormalizedUtf8(source);
const one = (command, normalizedUtf8 = fixedTransferBytes("x")) => ({
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
  if (mode.endsWith("view-nonenumerable")) { const value = encoder.encode("x"); Object.defineProperty(value, "extra", { value: true }); return one(command, value); }
  if (mode.endsWith("view-accessor")) { const value = encoder.encode("x"); Object.defineProperty(value, "extra", { enumerable: true, get: () => true }); return one(command, value); }
  if (mode.endsWith("view-symbol")) { const value = encoder.encode("x"); value[Symbol("extra")] = true; return one(command, value); }
  if (mode.endsWith("buffer-extra")) { const value = encoder.encode("x"); value.buffer.extra = true; return one(command, value); }
  if (mode.endsWith("buffer-nonenumerable")) { const value = encoder.encode("x"); Object.defineProperty(value.buffer, "extra", { value: true }); return one(command, value); }
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
const publishPrepared = (event) => {
  try {
    publishNodeWorkerEvent(parentPort, prepareNodeWorkerSuccessForPublication(event));
  } catch {
    publishNodeWorkerEvent(parentPort, {
      type: "FAILURE", attemptId: event.attemptId, generation: event.generation, revision: event.revision,
      category: "Provider/resolution failure",
    });
  }
};
parentPort.on("message", (command) => {
  if (command.type !== "START") return;
  parentPort.postMessage(selected(command));
  if (workerData.mode.startsWith("raw-")) {
    const progress = (stage, completed, total) => parentPort.postMessage({
      type: "PROGRESS", attemptId: command.attemptId, generation: command.generation, revision: SHA, stage,
      ...(completed === undefined ? {} : { completed, total }),
    });
    progress("acquisition", 0, 1);
    progress("acquisition", 1, 1);
    progress("analysis-initialization");
    progress("analysis", 0, 1);
    progress("analysis", 1, 1);
    progress("city-construction");
  }
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
    publishPrepared(event);
  } else {
    parentPort.postMessage(event);
  }
  parentPort.close();
});
`);

  return { root, analysis: pathToFileURL(analysisBootstrap), transfer: pathToFileURL(transferBootstrap) };
}

function start(bundle, scenario, release = () => {}, onProgress) {
  return startNodeWorkerAttempt({
    repository: REPOSITORY, generation: 3, workerUrl: bundle,
    workerFactory: (url) => new Worker(url, { workerData: { scenario, mode: scenario } }), release, onProgress,
  });
}

function gateTerminated(kind, condition, terminal) {
  const error = new Error(`${kind} gate ${JSON.stringify(condition)} was not reached before the owned attempt terminated: ${JSON.stringify(terminal)}`);
  error.cause = terminal;
  return error;
}

function startTracked(bundle, scenario, release = () => {}) {
  const progress = [];
  const waiters = [];
  let terminal;
  const attempt = start(bundle, scenario, release, (event) => {
    progress.push(event);
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(progress)) continue;
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve();
    }
  });
  void attempt.result.then((result) => {
    terminal = result;
    for (const waiter of waiters.splice(0)) waiter.reject(gateTerminated("progress", waiter.label, result));
  });
  return {
    attempt,
    progress,
    async progressReached(label, predicate) {
      if (predicate(progress)) return;
      if (terminal !== undefined) throw gateTerminated("progress", label, terminal);
      await new Promise((resolve, reject) => waiters.push({ label, predicate, resolve, reject }));
    },
  };
}

async function startControlledWorker(bundle, scenario, {
  holdProgress,
  onAttemptRelease = () => {},
  workerFactory = (url, port) => new Worker(url, {
    workerData: { scenario, mode: scenario, control: port }, transferList: [port],
  }),
  onTerminal = () => {},
  onExplicitPortClose = () => {},
} = {}) {
  const { port1, port2 } = new MessageChannel();
  const phases = [];
  const progress = [];
  const phaseWaiters = [];
  const progressWaiters = [];
  const heldWaiters = [];
  const heldProgress = [];
  let holdReleased = holdProgress === undefined;
  let terminal;
  let controlFailure;
  let attempt;
  let cleanupPromise;
  let portsClosed = false;

  const closePorts = () => {
    if (portsClosed) return;
    portsClosed = true;
    port1.off("message", onControlMessage);
    onExplicitPortClose("port1");
    port1.close();
    onExplicitPortClose("port2");
    port2.close();
  };
  const rejectWaiters = (result) => {
    for (const waiter of phaseWaiters.splice(0)) waiter.reject(gateTerminated("phase", waiter.phase, result));
    for (const waiter of progressWaiters.splice(0)) waiter.reject(gateTerminated("progress", waiter.label, result));
    for (const waiter of heldWaiters.splice(0)) waiter.reject(gateTerminated("withheld progress", waiter.label, result));
  };
  const failWaiters = (error) => {
    for (const waiter of phaseWaiters.splice(0)) waiter.reject(error);
    for (const waiter of progressWaiters.splice(0)) waiter.reject(error);
    for (const waiter of heldWaiters.splice(0)) waiter.reject(error);
  };
  const recordProgress = (event) => {
    if (terminal !== undefined) return;
    progress.push(event);
    for (const waiter of [...progressWaiters]) {
      if (!waiter.predicate(progress)) continue;
      progressWaiters.splice(progressWaiters.indexOf(waiter), 1);
      waiter.resolve();
    }
  };
  const onControlMessage = (message) => {
    if (terminal !== undefined || controlFailure !== undefined) return;
    try {
      assert.deepEqual(message, { phase: message?.phase });
    } catch (error) {
      controlFailure = error;
      failWaiters(error);
      void cleanup();
      return;
    }
    phases.push(message.phase);
    for (const waiter of [...phaseWaiters]) {
      if (waiter.phase !== message.phase) continue;
      phaseWaiters.splice(phaseWaiters.indexOf(waiter), 1);
      waiter.resolve();
    }
  };
  port1.on("message", onControlMessage);

  const cleanup = () => {
    cleanupPromise ??= (async () => {
      try {
        await attempt?.cancel();
      } finally {
        closePorts();
      }
    })();
    return cleanupPromise;
  };

  try {
    attempt = startNodeWorkerAttempt({
      repository: REPOSITORY,
      generation: 3,
      workerUrl: bundle,
      workerFactory: (url) => workerFactory(url, port2),
      release: onAttemptRelease,
      onProgress: (event) => {
        if (!holdReleased && holdProgress(event)) {
          heldProgress.push(event);
          for (const waiter of heldWaiters.splice(0)) waiter.resolve();
          return;
        }
        recordProgress(event);
      },
    });
  } catch (error) {
    await cleanup();
    throw error;
  }

  const terminalCleanup = attempt.result.then(async (result) => {
    terminal = result;
    rejectWaiters(result);
    onTerminal(result);
    await cleanup();
    return result;
  });

  return {
    attempt,
    phases,
    progress,
    cleanup,
    terminalCleanup,
    portsAreClosed: () => portsClosed,
    controlListenerCount: () => port1.listenerCount("message"),
    async reached(phase) {
      if (phases.includes(phase)) return;
      if (controlFailure !== undefined) throw controlFailure;
      if (terminal !== undefined) throw gateTerminated("phase", phase, terminal);
      await new Promise((resolve, reject) => phaseWaiters.push({ phase, resolve, reject }));
    },
    async progressReached(label, predicate) {
      if (predicate(progress)) return;
      if (controlFailure !== undefined) throw controlFailure;
      if (terminal !== undefined) throw gateTerminated("progress", label, terminal);
      await new Promise((resolve, reject) => progressWaiters.push({ label, predicate, resolve, reject }));
    },
    async heldProgressObserved(label) {
      if (heldProgress.length > 0) return;
      if (controlFailure !== undefined) throw controlFailure;
      if (terminal !== undefined) throw gateTerminated("withheld progress", label, terminal);
      await new Promise((resolve, reject) => heldWaiters.push({ label, resolve, reject }));
    },
    releaseHeldProgress() {
      if (holdReleased) return;
      holdReleased = true;
      for (const event of heldProgress.splice(0)) recordProgress(event);
    },
    release(phase) { port1.postMessage({ release: phase }); },
  };
}

function startProgressBarriers(bundle, holdProgress) {
  return startControlledWorker(bundle, "progressBarriers", { holdProgress });
}

async function startAtBarrier(bundle, scenario, onAttemptRelease = () => {}) {
  const controlled = await startControlledWorker(bundle, scenario, { onAttemptRelease });
  return { ...controlled, reached: controlled.reached(scenario) };
}

async function runAssertionFailureCleanupRegression(root) {
  const workerFile = path.join(root, "blocked-assertion-worker.mjs");
  const childFile = path.join(root, "blocked-assertion-child.test.mjs");
  const markerFile = path.join(root, "blocked-assertion-joined.txt");
  await writeFile(workerFile, `
import { parentPort, workerData } from "node:worker_threads";
workerData.control.on("message", () => {});
parentPort.once("message", () => workerData.control.postMessage({ phase: "blocked" }));
`);
  await writeFile(childFile, `
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import test from "node:test";
import { MessageChannel, Worker } from "node:worker_threads";
registerHooks({ resolve(specifier, context, nextResolve) {
  return nextResolve(/^\\.\\.?\\//u.test(specifier) && !/(?:\\.[a-z]+|\\?.*)$/iu.test(specifier) ? specifier + ".ts" : specifier, context);
} });
const { startNodeWorkerAttempt } = await import(${JSON.stringify(pathToFileURL(path.join(projectRoot, "src/edge/node/worker-attempt.ts")).href)});
const workerUrl = new URL(${JSON.stringify(pathToFileURL(workerFile).href)});
const markerFile = new URL(${JSON.stringify(pathToFileURL(markerFile).href)});
async function createOwnedBlockedAttempt() {
  const { port1, port2 } = new MessageChannel();
  let attempt;
  let cleanupPromise;
  const closePorts = () => { port1.close(); port2.close(); };
  const cleanup = () => cleanupPromise ??= (async () => {
    try { await attempt?.cancel(); } finally { closePorts(); }
  })();
  try {
    attempt = startNodeWorkerAttempt({
      repository: ${JSON.stringify(REPOSITORY)}, generation: 3, workerUrl,
      workerFactory: (url) => new Worker(url, { workerData: { control: port2 }, transferList: [port2] }),
    });
  } catch (error) {
    await cleanup();
    throw error;
  }
  const reached = Promise.race([
    new Promise((resolve) => port1.once("message", resolve)),
    attempt.result.then((result) => { throw new Error("blocked phase was not reached before terminal: " + JSON.stringify(result)); }),
  ]);
  return { attempt, cleanup, reached };
}
test("intentional assertion failure joins its blocked worker", async (t) => {
  let owned;
  t.after(async () => {
    await owned?.cleanup();
    await owned?.cleanup();
    await writeFile(markerFile, "joined\\n");
  });
  owned = await createOwnedBlockedAttempt();
  await owned.reached;
  assert.fail("intentional blocked-worker assertion");
});
`);
  const child = spawnSync(process.execPath, [childFile], { encoding: "utf8" });
  assert.equal(child.status, 1, `${child.stdout}${child.stderr}`);
  assert.match(`${child.stdout}${child.stderr}`, /intentional blocked-worker assertion/u);
  assert.equal(await readFile(markerFile, "utf8"), "joined\n");
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

test("actual worker exposes zero and nonzero acquisition and analysis progress at real barriers", async (t) => {
  let controlled;
  t.after(async () => controlled?.cleanup());
  const { analysis } = await compiledWorkerFixture(t);
  const acquisitionStarted = (events) => events.some(({ stage, completed, total }) => stage === "acquisition" && completed === 0 && total === 3);
  controlled = await startProgressBarriers(
    analysis,
    ({ stage, completed, total }) => stage === "acquisition" && completed === 0 && total === 3,
  );

  const releaseFirstAcquisition = (async () => {
    await controlled.progressReached("acquisition 0/3", acquisitionStarted);
    controlled.release("first-acquisition");
  })();
  await controlled.reached("first-acquisition");
  await controlled.reached("acquisition-window-filled");
  await controlled.heldProgressObserved("acquisition 0/3 callback");
  assert.equal(controlled.progress.length, 0);
  assert.equal(controlled.phases.includes("first-acquisition"), true);
  controlled.releaseHeldProgress();
  await releaseFirstAcquisition;
  assert.deepEqual(controlled.progress.map(({ stage, completed, total }) => ({ stage, completed, total })), [
    { stage: "acquisition", completed: 0, total: 3 },
  ]);

  await controlled.reached("first-analysis");
  await controlled.progressReached(
    "acquisition 3/3",
    (events) => events.some(({ stage, completed, total }) => stage === "acquisition" && completed === 3 && total === 3),
  );
  await controlled.progressReached(
    "analysis initialization",
    (events) => events.some(({ stage }) => stage === "analysis-initialization"),
  );
  await controlled.progressReached(
    "analysis 0/3",
    (events) => events.some(({ stage, completed, total }) => stage === "analysis" && completed === 0 && total === 3),
  );
  assert.deepEqual(
    controlled.progress.filter(({ stage }) => stage === "acquisition").map(({ completed, total }) => [completed, total]),
    [[0, 3], [1, 3], [2, 3], [3, 3]],
  );
  assert(controlled.progress.some(({ stage }) => stage === "analysis-initialization"));
  assert.deepEqual(
    controlled.progress.filter(({ stage }) => stage === "analysis").map(({ completed, total }) => [completed, total]),
    [[0, 3]],
  );
  controlled.release("first-analysis");

  const result = await controlled.attempt.result;
  assert.equal(result.type, "SUCCESS");
  await controlled.progressReached(
    "analysis 3/3",
    (events) => events.some(({ stage, completed, total }) => stage === "analysis" && completed === 3 && total === 3),
  );
  await controlled.progressReached(
    "city construction",
    (events) => events.some(({ stage }) => stage === "city-construction"),
  );
  assert.deepEqual(
    controlled.progress.filter(({ stage }) => stage === "analysis").map(({ completed, total }) => [completed, total]),
    [[0, 3], [1, 3], [2, 3], [3, 3]],
  );
  assert.equal(controlled.progress.filter(({ stage }) => stage === "city-construction").length, 1);
});

test("phase and progress gates reject with the owned terminal before and after worker exit", async (t) => {
  let controlled;
  t.after(async () => controlled?.cleanup());
  const { analysis } = await compiledWorkerFixture(t);
  controlled = await startControlledWorker(analysis, "earlyExit");
  await controlled.reached("early-exit");
  const pendingPhase = controlled.reached("unreachable-phase-before-terminal");
  const pendingProgress = controlled.progressReached(
    "unreachable progress before terminal",
    (events) => events.length > 0,
  );
  controlled.release("early-exit");

  const ownedTerminal = await controlled.attempt.result;
  assert.equal(ownedTerminal.type, "FAILURE");
  const [phaseBefore, progressBefore] = await Promise.allSettled([pendingPhase, pendingProgress]);
  assert.equal(phaseBefore.status, "rejected");
  assert.match(phaseBefore.reason.message, /phase gate .*unreachable-phase-before-terminal.*owned attempt terminated/u);
  assert.equal(phaseBefore.reason.cause, ownedTerminal);
  assert.equal(progressBefore.status, "rejected");
  assert.match(progressBefore.reason.message, /progress gate .*unreachable progress before terminal.*owned attempt terminated/u);
  assert.equal(progressBefore.reason.cause, ownedTerminal);

  await assert.rejects(
    controlled.reached("unreachable-phase-after-terminal"),
    (error) => {
      assert.match(error.message, /phase gate .*unreachable-phase-after-terminal.*owned attempt terminated/u);
      assert.equal(error.cause, ownedTerminal);
      return true;
    },
  );
  await assert.rejects(
    controlled.progressReached("unreachable progress after terminal", (events) => events.length > 0),
    (error) => {
      assert.match(error.message, /progress gate .*unreachable progress after terminal.*owned attempt terminated/u);
      assert.equal(error.cause, ownedTerminal);
      return true;
    },
  );
});

test("worker constructor failure joins before explicit port cleanup and retains no control event source", async (t) => {
  let controlled;
  t.after(async () => controlled?.cleanup());
  const { analysis } = await compiledWorkerFixture(t);
  const order = [];
  controlled = await startControlledWorker(analysis, "constructorFailure", {
    workerFactory: () => {
      order.push("worker constructor");
      throw new Error("deterministic worker constructor failure");
    },
    onAttemptRelease: () => order.push("attempt joined"),
    onTerminal: () => order.push("terminal observed"),
    onExplicitPortClose: (port) => order.push(`explicitly close ${port}`),
  });

  const ownedTerminal = await controlled.terminalCleanup;
  assert.deepEqual(ownedTerminal, {
    type: "FAILURE",
    attemptId: controlled.attempt.attemptId,
    generation: 3,
    category: "Provider/resolution failure",
  });
  assert.deepEqual(order, [
    "worker constructor",
    "attempt joined",
    "terminal observed",
    "explicitly close port1",
    "explicitly close port2",
  ]);
  assert.equal(controlled.portsAreClosed(), true);
  assert.equal(controlled.controlListenerCount(), 0);
});

test("an assertion failure with a blocked worker exits nonzero after joined cleanup", async (t) => {
  const { root } = await compiledWorkerFixture(t);
  await runAssertionFailureCleanupRegression(root);
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

test("actual worker counts syntax and metric attempts after cleanup without fabricating fatal completions", async (t) => {
  const { analysis } = await compiledWorkerFixture(t);

  const mixed = startTracked(analysis, "mixed");
  await mixed.progressReached(
    "mixed analysis 3/3",
    (events) => events.some(({ stage, completed, total }) => stage === "analysis" && completed === 3 && total === 3),
  );
  assert.equal((await mixed.attempt.result).type, "SUCCESS");
  assert.deepEqual(
    mixed.progress.filter(({ stage }) => stage === "analysis").map(({ completed, total }) => [completed, total]),
    [[0, 3], [1, 3], [2, 3], [3, 3]],
  );

  const initialization = startTracked(analysis, "parserInitialize");
  await initialization.progressReached(
    "parser initialization",
    (events) => events.some(({ stage }) => stage === "analysis-initialization"),
  );
  assert.equal((await initialization.attempt.result).category, "Metric processing failed");
  assert.equal(initialization.progress.some(({ stage }) => stage === "analysis"), false);
  assert.equal(initialization.progress.filter(({ stage }) => stage === "analysis-initialization").length, 1);

  const release = startTracked(analysis, "metricFailure");
  await release.progressReached(
    "metric failure analysis 0/1",
    (events) => events.some(({ stage, completed, total }) => stage === "analysis" && completed === 0 && total === 1),
  );
  assert.equal((await release.attempt.result).category, "Metric processing failed");
  assert.deepEqual(
    release.progress.filter(({ stage }) => stage === "analysis").map(({ completed, total }) => [completed, total]),
    [[0, 1]],
  );

  const allFailed = startTracked(analysis, "allFailed");
  await allFailed.progressReached(
    "all-failed analysis 2/2",
    (events) => events.some(({ stage, completed, total }) => stage === "analysis" && completed === 2 && total === 2),
  );
  const allFailedResult = await allFailed.attempt.result;
  assert.equal(allFailedResult.type, "SUCCESS");
  assert.equal(allFailedResult.result.city, null);
  assert.equal(allFailed.progress.some(({ stage }) => stage === "city-construction"), false);

  const zero = startTracked(analysis, "zeroText");
  await zero.progressReached(
    "zero-text analysis initialization",
    (events) => events.some(({ stage }) => stage === "analysis-initialization"),
  );
  const zeroResult = await zero.attempt.result;
  assert.equal(zeroResult.type, "SUCCESS");
  assert.equal(zeroResult.sources.length, 0);
  assert.equal(zero.progress.filter(({ stage }) => stage === "analysis-initialization").length, 1);
  assert.equal(zero.progress.some(({ stage }) => stage === "analysis" || stage === "city-construction"), false);
});

test("actual production worker rejects a mutation of the first acquired source before transfer", async (t) => {
  const { analysis } = await compiledWorkerFixture(t);
  const attempt = start(analysis, "firstSourceMutation");
  assert.deepEqual(await attempt.result, {
    type: "FAILURE", attemptId: attempt.attemptId, generation: 3, revision: SHA,
    category: "Provider/resolution failure",
  });
});

test("actual worker publisher rejects normalized sender mutations and transfers every owned buffer", async (t) => {
  const { transfer } = await compiledWorkerFixture(t);
  const valid = await collectWorkerMessages(transfer, "valid-transfer");
  assert.equal(valid[0].type, "REVISION_SELECTED");
  assert.equal(validateNodeWorkerStructuredCloneEvent(valid[1]).kind, "valid");
  assert.deepEqual(valid[2], { type: "DETACHED", distinct: 5, byteLengths: [0, 0, 0, 0, 0] });

  const senderMutations = [
    "buffer", "subclass", "view-extra", "view-nonenumerable", "view-accessor", "view-symbol",
    "buffer-extra", "buffer-nonenumerable", "buffer-symbol", "buffer-accessor", "row-accessor",
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
  for (const mode of [
    "raw-buffer", "raw-subclass", "raw-view-extra", "raw-view-nonenumerable", "raw-view-accessor", "raw-view-symbol",
    "raw-buffer-extra", "raw-buffer-nonenumerable", "raw-buffer-symbol", "raw-buffer-accessor",
  ]) {
    const result = await start(transfer, mode).result;
    assert.equal(result.type, "SUCCESS", mode);
    assert.equal(Object.getPrototypeOf(result.sources[0].normalizedUtf8), Uint8Array.prototype, mode);
    assert.equal(Reflect.ownKeys(result.sources[0].normalizedUtf8.buffer).length, 0, mode);
  }

  for (const mode of ["raw-partial", "raw-reused", "raw-invalid-utf8", "raw-cr", "raw-path", "raw-proxy"]) {
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
  const owned = [];
  t.after(async () => {
    for (const controlled of owned) await controlled.cleanup();
  });
  const { analysis } = await compiledWorkerFixture(t);
  for (const scenario of ["providerWait", "parserBusy"]) {
    let releases = 0;
    const controlled = await startAtBarrier(analysis, scenario, () => { releases += 1; });
    owned.push(controlled);
    await controlled.reached;
    await controlled.cleanup();
    assert.deepEqual(await controlled.attempt.result, { type: "CANCELLED" });
    await controlled.cleanup();
    assert.equal(releases, 1, scenario);
  }
});

test("a busy analysis worker leaves the parent timer and a small native HTTP response responsive", async (t) => {
  let controlled;
  t.after(async () => controlled?.cleanup());
  const { analysis } = await compiledWorkerFixture(t);
  controlled = await startAtBarrier(analysis, "parserBusy");
  await controlled.reached;
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
  await controlled.cleanup();
});
