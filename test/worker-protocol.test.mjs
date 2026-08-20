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
  const drained = { type: "ATTEMPT_DRAINED", generation: 7 };
  assert.deepEqual(parseWorkerMessage(failure, 7), failure);
  assert.deepEqual(parseWorkerMessage(drained, 7), drained);
  for (const invalid of [
    { ...failure, generation: 6 }, { ...failure, category: "raw provider detail" },
    { ...failure, extra: true }, { type: "SUCCESS", generation: 7, revision: SHA },
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

test("successful resolution stays inside the same worker pipeline until STOP", async () => {
  const messages = [];
  let calls = 0;
  const pipeline = createWorkerAttemptPipeline(async () => {
    calls += 1;
    return { kind: "revision", revision: SHA };
  }, (message) => messages.push(message));
  pipeline.start(REPOSITORY, 9);
  await tick();
  assert.equal(calls, 1);
  assert.deepEqual(pipeline.selected(), { kind: "selected", repository: REPOSITORY, revision: SHA });
  assert.deepEqual(messages, [], "no selected-revision or success message may cross the worker boundary");
  pipeline.stop(9);
  await tick();
  assert.deepEqual(messages, [{ type: "ATTEMPT_DRAINED", generation: 9 }]);
});
