import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(/^\.\.?\//u.test(specifier) && !/(?:\.[a-z]+|\?.*)$/iu.test(specifier) ? `${specifier}.ts` : specifier, context);
  },
});

const { startNodeWorkerAttempt } = await import("../src/edge/node/worker-attempt.ts");
const REPOSITORY = { owner: "owner", repository: "repo", branch: null };
const SHA = "a".repeat(40);

async function faultWorker(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "code-city-worker-fault-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "fault.mjs");
  await writeFile(file, `
import { parentPort, workerData } from "node:worker_threads";
const SHA = "a".repeat(40);
parentPort.on("message", (command) => {
  if (command.type !== "START") return;
  const selected = { type: "REVISION_SELECTED", attemptId: command.attemptId, generation: command.generation, revision: SHA };
  const failure = { type: "FAILURE", attemptId: command.attemptId, generation: command.generation, revision: SHA, category: "Provider/resolution failure" };
  const success = {
    type: "SUCCESS", attemptId: command.attemptId, generation: command.generation, revision: SHA,
    result: { city: null, notAnalyzedFiles: [{ canonicalPath: "a.ts", category: "Syntax could not be analyzed" }] },
    sources: [{ canonicalPath: "a.ts", normalizedUtf8: new TextEncoder().encode("x") }],
  };
  if (workerData.mode === "pre-nonzero") { parentPort.postMessage({ type: "FAILURE", attemptId: command.attemptId, generation: command.generation, category: "Revision unavailable" }); setTimeout(() => process.exit(7), 30); return; }
  parentPort.postMessage(selected);
  if (workerData.mode === "normal-delay") { parentPort.postMessage(failure); setTimeout(() => parentPort.close(), 40); return; }
  if (workerData.mode === "nonzero") { parentPort.postMessage(failure); setTimeout(() => process.exit(9), 40); return; }
  if (workerData.mode === "success-nonzero") { parentPort.postMessage(success); setTimeout(() => process.exit(9), 40); return; }
  if (workerData.mode === "success-cancel") { parentPort.postMessage(success); setInterval(() => {}, 1_000); return; }
  if (workerData.mode === "missing") { parentPort.close(); return; }
  if (workerData.mode === "malformed") { parentPort.postMessage({ type: "SUCCESS", attemptId: command.attemptId, generation: command.generation, revision: SHA }); return; }
  if (workerData.mode === "invalid-city") { parentPort.postMessage({ type: "SUCCESS", attemptId: command.attemptId, generation: command.generation, revision: SHA, result: { city: {}, notAnalyzedFiles: [] }, sources: [] }); parentPort.close(); return; }
  if (workerData.mode === "duplicate") { parentPort.postMessage(failure); parentPort.postMessage(failure); return; }
  if (workerData.mode === "late-selected") { parentPort.postMessage(failure); parentPort.postMessage(selected); return; }
  if (workerData.mode === "stale") { parentPort.postMessage({ ...failure, attemptId: "AAAAAAAAAAAAAAAAAAAAAA" }); return; }
  if (workerData.mode === "error") { setTimeout(() => { throw new Error("test-only worker fault"); }, 5); return; }
});
`);
  return pathToFileURL(file);
}

function run(url, mode, release = () => {}, capture = () => {}) {
  return startNodeWorkerAttempt({
    repository: REPOSITORY, generation: 11, workerUrl: url,
    workerFactory: (entry) => {
      const worker = new Worker(entry, { workerData: { mode } });
      capture(worker);
      return worker;
    },
    release,
  });
}

function assertNoAttemptListeners(worker) {
  for (const event of ["exit", "message", "messageerror", "error"]) assert.equal(worker.listenerCount(event), 0, event);
}

async function remainsPending(promise, milliseconds = 10) {
  return Promise.race([
    promise.then(() => false),
    new Promise((resolve) => setTimeout(() => resolve(true), milliseconds)),
  ]);
}

test("terminal values remain provisional until a joined normal exit", async (t) => {
  const url = await faultWorker(t);
  const attempt = run(url, "normal-delay");
  assert.equal(await remainsPending(attempt.result), true);
  const terminal = await attempt.result;
  assert.equal(terminal.type, "FAILURE");
  assert.equal(terminal.category, "Provider/resolution failure");
  assert.equal(terminal.revision, SHA);
});

test("every nonzero exit overrides provisional success/failure semantics after the join", async (t) => {
  const url = await faultWorker(t);
  for (const mode of ["nonzero", "success-nonzero", "pre-nonzero"]) {
    let worker;
    const attempt = run(url, mode, () => {}, (created) => { worker = created; });
    assert.equal(await remainsPending(attempt.result), true, mode);
    const terminal = await attempt.result;
    assert.deepEqual(terminal, mode === "pre-nonzero"
      ? { type: "FAILURE", attemptId: attempt.attemptId, generation: 11, category: "Provider/resolution failure" }
      : { type: "FAILURE", attemptId: attempt.attemptId, generation: 11, revision: SHA, category: "Provider/resolution failure" });
    assert.equal(Object.hasOwn(terminal, "result"), false, mode);
    assert.equal(Object.hasOwn(terminal, "sources"), false, mode);
    assertNoAttemptListeners(worker);
  }
});

test("an observably invalid present city maps to the coded city failure only after normal join", async (t) => {
  const url = await faultWorker(t);
  const attempt = run(url, "invalid-city");
  assert.deepEqual(await attempt.result, {
    type: "FAILURE", attemptId: attempt.attemptId, generation: 11, revision: SHA,
    category: "City construction failed", code: "M1-CITY-1",
  });
});

test("malformed, missing, duplicate, late, stale, and crashing workers map only to joined provider failure", async (t) => {
  const url = await faultWorker(t);
  for (const mode of ["missing", "malformed", "duplicate", "late-selected", "stale", "error"]) {
    let worker;
    const attempt = run(url, mode, () => {}, (created) => { worker = created; });
    const terminal = await attempt.result;
    assert.equal(terminal.type, "FAILURE", mode);
    assert.equal(terminal.category, "Provider/resolution failure", mode);
    assert.equal(terminal.attemptId, attempt.attemptId, mode);
    assert.equal(terminal.generation, 11, mode);
    assertNoAttemptListeners(worker);
  }
});

test("invalid start, constructor, listener, and post failures release exactly once; worker-owned failures still join", async () => {
  let invalidCreations = 0;
  const invalid = startNodeWorkerAttempt({
    repository: REPOSITORY, generation: 0,
    workerFactory() { invalidCreations += 1; throw new Error("must not construct"); },
  });
  assert.equal((await invalid.result).category, "Provider/resolution failure");
  assert.equal(invalidCreations, 0);

  let constructorReleases = 0;
  const constructor = startNodeWorkerAttempt({
    repository: REPOSITORY, generation: 1,
    workerFactory() { throw new Error("constructor"); },
    release() { constructorReleases += 1; },
  });
  assert.deepEqual(await constructor.result, {
    type: "FAILURE", attemptId: constructor.attemptId, generation: 1, category: "Provider/resolution failure",
  });
  await constructor.cancel();
  assert.equal(constructorReleases, 1);

  class PostFailureWorker extends EventEmitter {
    postMessage() { throw new Error("post"); }
    terminate() { queueMicrotask(() => this.emit("exit", 1)); return Promise.resolve(1); }
  }
  let postReleases = 0;
  const post = startNodeWorkerAttempt({
    repository: REPOSITORY, generation: 2, workerFactory: () => new PostFailureWorker(),
    release() { postReleases += 1; },
  });
  assert.equal((await post.result).category, "Provider/resolution failure");
  assert.equal(postReleases, 1);

  class ListenerFailureWorker extends EventEmitter {
    on(name, listener) {
      if (name === "message") throw new Error("listener");
      return super.on(name, listener);
    }
    postMessage() { throw new Error("must not post"); }
    terminate() { queueMicrotask(() => this.emit("exit", 1)); return Promise.resolve(1); }
  }
  const laterListenerWorker = new ListenerFailureWorker();
  const listener = startNodeWorkerAttempt({ repository: REPOSITORY, generation: 3, workerFactory: () => laterListenerWorker });
  assert.equal((await listener.result).category, "Provider/resolution failure");
  assertNoAttemptListeners(laterListenerWorker);

  class ExitListenerFailureWorker extends EventEmitter {
    on(name, listener) {
      if (name === "exit") throw new Error("first listener");
      return super.on(name, listener);
    }
    postMessage() { throw new Error("must not post"); }
    terminate() { return Promise.resolve(1); }
  }
  let firstListenerReleases = 0;
  const firstListenerWorker = new ExitListenerFailureWorker();
  const firstListener = startNodeWorkerAttempt({
    repository: REPOSITORY, generation: 4, workerFactory: () => firstListenerWorker,
    release() { firstListenerReleases += 1; },
  });
  assert.deepEqual(await firstListener.result, {
    type: "FAILURE", attemptId: firstListener.attemptId, generation: 4, category: "Provider/resolution failure",
  });
  await firstListener.cancel();
  assert.equal(firstListenerReleases, 1);
  assertNoAttemptListeners(firstListenerWorker);
});

test("messageerror is terminally invalid and waits for the registered exit join", async () => {
  class MessageErrorWorker extends EventEmitter {
    postMessage() { queueMicrotask(() => this.emit("messageerror", new Error("clone"))); }
    terminate() { setTimeout(() => this.emit("exit", 1), 20); return Promise.resolve(1); }
  }
  const attempt = startNodeWorkerAttempt({ repository: REPOSITORY, generation: 2, workerFactory: () => new MessageErrorWorker() });
  assert.equal(await remainsPending(attempt.result), true);
  assert.equal((await attempt.result).category, "Provider/resolution failure");
});

test("cancellation clears provisional source/result ownership, removes listeners, and releases once", async (t) => {
  const url = await faultWorker(t);
  let releases = 0;
  let worker;
  const attempt = run(url, "success-cancel", () => { releases += 1; }, (created) => { worker = created; });
  await new Promise((resolve) => setTimeout(resolve, 25));
  await attempt.cancel();
  assert.deepEqual(await attempt.result, { type: "CANCELLED" });
  await attempt.cancel();
  assert.equal(releases, 1);
  assertNoAttemptListeners(worker);
});

test("replacement cancels and joins the old worker; generated attempt identities are fresh and canonical", async (t) => {
  const url = await faultWorker(t);
  let releases = 0;
  let firstWorker;
  const first = run(url, "normal-delay", () => { releases += 1; }, (created) => { firstWorker = created; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  await first.cancel();
  const second = run(url, "normal-delay", () => { releases += 1; });
  assert.notEqual(first.attemptId, second.attemptId);
  assert.match(first.attemptId, /^[A-Za-z0-9_-]{22}$/u);
  assert.deepEqual(await first.result, { type: "CANCELLED" });
  assertNoAttemptListeners(firstWorker);
  assert.equal((await second.result).type, "FAILURE");
  assert.equal(releases, 2);
});
