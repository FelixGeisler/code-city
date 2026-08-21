import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(/^\.\.?\//.test(specifier) && !/\.[a-z]+$/i.test(specifier) ? `${specifier}.ts` : specifier, context);
  },
});
const { parseWorkerCommand, parseWorkerMessage } = await import("../src/application/protocol.ts");
const { createWorkerAttemptPipeline } = await import("../src/application/worker-attempt.ts");
const { createTreeSitterAdapter } = await import("../src/edge/tree-sitter-adapter.ts");
const { buildCity } = await import("../src/domain/city-model.ts");

const REPOSITORY = { owner: "owner", repository: "repo" };
const SHA = "a".repeat(40);
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function inherited(record) {
  return Object.assign(Object.create(record), record);
}

function accessor(record, key) {
  const copy = { ...record };
  Object.defineProperty(copy, key, { enumerable: true, get: () => record[key] });
  return copy;
}

test("command protocol is closed, own-data-only, and generation-tagged", () => {
  const start = { type: "START", generation: 1, repository: REPOSITORY };
  const stop = { type: "STOP", generation: 1 };
  assert.deepEqual(parseWorkerCommand(start), start);
  assert.deepEqual(parseWorkerCommand(stop), stop);

  for (const invalid of [
    null, [], { ...start, extra: true }, { type: "UNKNOWN", generation: 1 },
    { type: "START", generation: 0, repository: REPOSITORY },
    { type: "START", generation: 1.5, repository: REPOSITORY },
    { type: "START", generation: 1, repository: { owner: "owner" } },
    { type: "START", generation: 1, repository: { ...REPOSITORY, extra: true } },
    inherited(start), accessor(start, "type"), accessor(start, "generation"),
    new Proxy(start, { getPrototypeOf() { throw new Error("trap"); } }),
    { ...start, repository: inherited(REPOSITORY) },
    { ...start, repository: accessor(REPOSITORY, "owner") },
  ]) {
    assert.equal(parseWorkerCommand(invalid), undefined);
  }
});

test("worker-to-main protocol accepts every exact pre/post-selection row and closes every message shape", () => {
  const revision64 = "b".repeat(64);
  const selected = { type: "REVISION_SELECTED", generation: 7, revision: SHA };
  const preFailures = [
    { type: "FAILURE", generation: 7, category: "Repository unavailable for anonymous access" },
    { type: "FAILURE", generation: 7, category: "Revision unavailable" },
    { type: "FAILURE", generation: 7, category: "Provider/resolution failure" },
  ];
  const postFailures = [
    { type: "FAILURE", generation: 7, revision: SHA, category: "Provider/resolution failure" },
    { type: "FAILURE", generation: 7, revision: SHA, category: "Repository exceeds Code City limits" },
    { type: "FAILURE", generation: 7, revision: SHA, category: "No supported modules", code: "ADM-06" },
    { type: "FAILURE", generation: 7, revision: SHA, category: "No supported modules", code: "ADM-07" },
    { type: "FAILURE", generation: 7, revision: SHA, category: "Source admission failed", code: "M1-ADM-1" },
    { type: "FAILURE", generation: 7, revision: SHA, category: "Source admission failed", code: "M1-ADM-3" },
    { type: "FAILURE", generation: 7, revision: SHA, category: "Source admission failed", code: "M1-ADM-4" },
    { type: "FAILURE", generation: 7, revision: SHA, category: "Metric processing failed", code: "M1-MET-1" },
    { type: "FAILURE", generation: 7, revision: SHA, category: "City construction failed", code: "M1-CITY-1" },
  ];
  const staticEntered = { type: "PROVIDER_DRAINED_STATIC_ENTERED", generation: 7 };
  const success = { type: "SUCCESS", generation: 7, revision: SHA, model: buildCity([{ canonicalPath: "a.js", S: 1, U: 1, M: 0 }]).model };
  const drained = { type: "ATTEMPT_DRAINED", generation: 7 };
  for (const valid of [selected, { ...selected, revision: revision64 }, ...preFailures, ...postFailures, staticEntered, success, drained]) {
    assert.deepEqual(parseWorkerMessage(valid, 7), valid);
  }
  assert.deepEqual(parseWorkerMessage({ ...success, model: {} }, 7), {
    type: "FAILURE", generation: 7, revision: SHA, category: "City construction failed", code: "M1-CITY-1",
  });

  const failure = preFailures[1];
  const cityFailure = postFailures.at(-1);
  for (const invalid of [
    { ...selected, generation: 6 }, { ...selected, revision: SHA.toUpperCase() }, { ...selected, revision: "a".repeat(39) },
    { ...failure, generation: 6 }, { ...failure, category: "raw provider detail" }, { ...failure, extra: true },
    { type: "SUCCESS", generation: 7, revision: SHA }, { ...success, revision: SHA.toUpperCase() },
    { ...success, revision: "a".repeat(39) }, { ...success, extra: true }, inherited(success), accessor(success, "model"),
    { type: "Source admission failed", generation: 7, revision: SHA, category: "Source admission failed", code: "M1-ADM-4" },
    { type: "FAILURE", generation: 7, category: "No supported modules", code: "ADM-06" },
    { type: "FAILURE", generation: 7, revision: SHA, category: "Repository unavailable for anonymous access" },
    { type: "FAILURE", generation: 7, revision: SHA, category: "Revision unavailable" },
    { type: "FAILURE", generation: 7, revision: SHA, category: "Provider/resolution failure", code: "M1-CITY-1" },
    { type: "FAILURE", generation: 7, revision: SHA, category: "No supported modules", code: "M1-ADM-1" },
    { type: "FAILURE", generation: 7, revision: SHA, category: "Metric processing failed", code: "M1-ADM-1" },
    { type: "FAILURE", generation: 7, revision: SHA, category: "City construction failed", code: "M1-MET-1" },
    { type: "FAILURE", generation: 7, revision: SHA, category: "City construction failed" },
    { type: "FAILURE", generation: 7, revision: SHA, category: "Unknown city failure", code: "M1-CITY-1" },
    inherited(cityFailure), accessor(cityFailure, "code"), inherited(selected), accessor(selected, "revision"),
    { type: "ATTEMPT_DRAINED", generation: 7, extra: true }, inherited(failure), accessor(failure, "category"),
    accessor(drained, "generation"), new Proxy(failure, { ownKeys() { throw new Error("trap"); } }),
  ]) {
    assert.equal(parseWorkerMessage(invalid, 7), undefined);
  }
});

test("provider resources settle before FAILURE, which precedes one drain", async () => {
  const order = [];
  const pipeline = createWorkerAttemptPipeline(async () => {
    await tick();
    order.push("request-reader-gateway-released");
    return { kind: "invalid-evidence" };
  }, {
    async loadInventory() { throw new Error("must not run"); },
    async readSource() { throw new Error("must not run"); },
  }, (message) => order.push(message.type));
  pipeline.start(REPOSITORY, 1);
  await tick();
  await tick();
  assert.deepEqual(order, ["request-reader-gateway-released", "FAILURE", "ATTEMPT_DRAINED"]);
  pipeline.stop(1);
  await tick();
  assert.equal(order.filter((entry) => entry === "ATTEMPT_DRAINED").length, 1);
});

test("STOP aborts current work, releases it, stops downstream publication, and drains once", async () => {
  const order = [];
  let observedSignal;
  const pipeline = createWorkerAttemptPipeline(async (_repository, signal) => {
    observedSignal = signal;
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    order.push("released");
    throw new Error("aborted transport");
  }, {
    async loadInventory() { throw new Error("must not run"); },
    async readSource() { throw new Error("must not run"); },
  }, (message) => order.push(message.type));
  pipeline.start(REPOSITORY, 4);
  pipeline.stop(3);
  assert.equal(observedSignal.aborted, false, "stale STOP must not abort current work");
  pipeline.stop(4);
  assert.equal(observedSignal.aborted, true);
  await tick();
  assert.deepEqual(order, ["released", "ATTEMPT_DRAINED"]);
  pipeline.stop(4);
  await tick();
  assert.equal(order.filter((entry) => entry === "ATTEMPT_DRAINED").length, 1);
});

test("all five initialization failures traverse selected-revision worker ownership and drain atomically", async () => {
  const rows = [
    ["runtime-import", 0], ["Parser.init/runtime-WASM", 0], ["JS grammar load", 1], ["TS grammar load", 2], ["TSX grammar load", 3],
  ];
  const initializationOrder = ["runtime-import", "Parser.init/runtime-WASM", "JS grammar load", "TS grammar load", "TSX grammar load"];
  for (const [injected, failingLoad] of rows) {
    const order = [];
    const resourceEvents = [];
    const ownershipAtPublication = [];
    let grammarLoads = 0;
    let projects = 0;
    class FakeParser {
      static async init() { order.push("Parser.init/runtime-WASM"); if (injected === "Parser.init/runtime-WASM") throw new Error(injected); }
      setLanguage() {}
      parse() { projects += 1; throw new Error("no module may start"); }
      delete() {}
    }
    const parser = createTreeSitterAdapter({ runtimeJavaScript: "runtime.js", runtimeWasm: "runtime.wasm", grammarJavaScript: "javascript.wasm", grammarTypeScript: "typescript.wasm", grammarTsx: "tsx.wasm" }, {
      async importRuntime() {
        order.push("runtime-import");
        if (injected === "runtime-import") throw new Error(injected);
        return { Parser: FakeParser, Language: { async load() { grammarLoads += 1; const step = initializationOrder[grammarLoads + 1]; order.push(step); if (grammarLoads === failingLoad) throw new Error(injected); return {}; } } };
      },
      async loadBytes() { return new Uint8Array([0]); },
      observeResource(event) { resourceEvents.push(event); },
    });
    let pipeline;
    pipeline = createWorkerAttemptPipeline(async () => ({ kind: "revision", revision: SHA }), {
      async loadInventory() { return { kind: "inventory", entries: [
        { path: "a.js", mode: "100644", type: "blob", sha: SHA },
        { path: "b.ts", mode: "100644", type: "blob", sha: SHA },
        { path: "c.tsx", mode: "100644", type: "blob", sha: SHA },
      ] }; },
      async readSource(_repository, _revision, candidate) { order.push(`retrieved:${candidate.canonicalPath}`); return { kind: "source", decodedSource: "" }; },
    }, (message) => { order.push(message.type); ownershipAtPublication.push([message.type, pipeline.ownership()]); }, undefined, parser, (event) => order.push(event));
    pipeline.start(REPOSITORY, 8);
    await tick(); await tick();
    assert.deepEqual(order.slice(0, 5), ["REVISION_SELECTED", "retrieved:a.js", "retrieved:b.ts", "retrieved:c.tsx", "PROVIDER_DRAINED_STATIC_ENTERED"], injected);
    assert.deepEqual(order.slice(5, 5 + initializationOrder.indexOf(injected) + 1), initializationOrder.slice(0, initializationOrder.indexOf(injected) + 1), injected);
    assert.deepEqual(order.slice(-5), ["source-released", "source-released", "source-released", "FAILURE", "ATTEMPT_DRAINED"], injected);
    assert.equal(order.filter((entry) => entry === "source-released").length, 3, injected);
    assert.equal(order.includes("source-acquired"), false, injected);
    assert.equal(projects, 0, injected);
    assert.deepEqual(resourceEvents, [], injected);
    assert.equal(grammarLoads, failingLoad, injected);
    assert.deepEqual(ownershipAtPublication.map(([type, ownership]) => [type, ownership.selectedRevisionRetained, ownership.admittedModuleCount, ownership.finalFactCount]), [
      ["REVISION_SELECTED", true, 0, 0], ["PROVIDER_DRAINED_STATIC_ENTERED", true, 0, 0],
      ["FAILURE", true, 0, 0], ["ATTEMPT_DRAINED", false, 0, 0],
    ], injected);
    assert.deepEqual(pipeline.ownership(), { phase: "idle", selectedRevisionRetained: false, admittedModuleCount: 0, presentationModelRetained: false, finalFactCount: 0, providerResource: false }, injected);
  }
});

test("complete admission crosses only the closed static barrier and retains no provider state", async () => {
  const messages = [];
  let calls = 0;
  const pipeline = createWorkerAttemptPipeline(async () => {
    calls += 1;
    return { kind: "revision", revision: SHA };
  }, {
    async loadInventory() {
      return { kind: "inventory", entries: [{ path: "src/a.ts", mode: "100644", type: "blob", sha: SHA }] };
    },
    async readSource() { return { kind: "source", decodedSource: "const value = 1;" }; },
  }, (message) => messages.push(message));
  pipeline.start(REPOSITORY, 9);
  await tick();
  await tick();
  assert.equal(calls, 1);
  assert.deepEqual(pipeline.ownership(), {
    phase: "static",
    generation: 9,
    selectedRevisionRetained: true,
    admittedModuleCount: 0,
    presentationModelRetained: false,
    finalFactCount: 0,
    providerResource: false,
  });
  assert.deepEqual(messages, [
    { type: "REVISION_SELECTED", generation: 9, revision: SHA },
    { type: "PROVIDER_DRAINED_STATIC_ENTERED", generation: 9 },
  ]);
  assert.doesNotMatch(JSON.stringify(messages), /source|repository|providerResource/);
  pipeline.stop(9);
  await tick();
  assert.equal(messages.length, 2, "static cancellation is realm termination owned by main");
});
