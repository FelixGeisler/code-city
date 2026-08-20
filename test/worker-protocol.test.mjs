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

test("worker-to-main protocol rejects unknown, inherited, accessor, malformed, and wrong-generation values", () => {
  const failure = { type: "FAILURE", generation: 7, category: "Revision unavailable" };
  const codedFailure = { type: "FAILURE", generation: 7, category: "Source admission failed", code: "M1-ADM-4" };
  const metricFailure = { type: "FAILURE", generation: 7, category: "Metric processing failed", code: "M1-MET-1" };
  const staticEntered = { type: "PROVIDER_DRAINED_STATIC_ENTERED", generation: 7 };
  const drained = { type: "ATTEMPT_DRAINED", generation: 7 };
  assert.deepEqual(parseWorkerMessage(failure, 7), failure);
  assert.deepEqual(parseWorkerMessage(codedFailure, 7), codedFailure);
  assert.deepEqual(parseWorkerMessage(metricFailure, 7), metricFailure);
  assert.deepEqual(parseWorkerMessage(staticEntered, 7), staticEntered);
  assert.deepEqual(parseWorkerMessage(drained, 7), drained);
  for (const invalid of [
    { ...failure, generation: 6 }, { ...failure, category: "raw provider detail" },
    { ...failure, extra: true }, { type: "SUCCESS", generation: 7, revision: SHA },
    { type: "Source admission failed", generation: 7, category: "Source admission failed" },
    { type: "FAILURE", generation: 7, category: "No supported modules", code: "M1-ADM-1" },
    { type: "FAILURE", generation: 7, category: "Metric processing failed", code: "M1-ADM-1" },
    { type: "ATTEMPT_DRAINED", generation: 7, extra: true },
    inherited(failure), accessor(failure, "category"), accessor(drained, "generation"),
    new Proxy(failure, { ownKeys() { throw new Error("trap"); } }),
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

test("metric initialization starts only after the source-free static barrier and an ordinary failure drains atomically", async () => {
  const order = [];
  const pipeline = createWorkerAttemptPipeline(async () => ({ kind: "revision", revision: SHA }), {
    async loadInventory() {
      return { kind: "inventory", entries: [
        { path: "a.js", mode: "100644", type: "blob", sha: SHA },
        { path: "b.ts", mode: "100644", type: "blob", sha: SHA },
        { path: "c.tsx", mode: "100644", type: "blob", sha: SHA },
      ] };
    },
    async readSource() { return { kind: "source", decodedSource: "" }; },
  }, (message) => order.push(message), undefined, {
    async initialize() { order.push("parser:initialize"); throw new Error("runtime-import"); },
    async project() { order.push("parser:project"); throw new Error("must not parse"); },
  });
  pipeline.start(REPOSITORY, 8);
  await tick();
  await tick();
  assert.deepEqual(order, [
    { type: "PROVIDER_DRAINED_STATIC_ENTERED", generation: 8 },
    "parser:initialize",
    { type: "FAILURE", generation: 8, category: "Metric processing failed", code: "M1-MET-1" },
    { type: "ATTEMPT_DRAINED", generation: 8 },
  ]);
  assert.deepEqual(pipeline.ownership(), {
    phase: "idle",
    selectedRevisionRetained: false,
    admittedModuleCount: 0,
    providerResource: false,
  });
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
    admittedModuleCount: 1,
    providerResource: false,
  });
  assert.deepEqual(messages, [{ type: "PROVIDER_DRAINED_STATIC_ENTERED", generation: 9 }]);
  assert.doesNotMatch(JSON.stringify(messages), /source|revision|repository|providerResource/);
  pipeline.stop(9);
  await tick();
  assert.equal(messages.length, 1, "static cancellation is realm termination owned by main");
});
