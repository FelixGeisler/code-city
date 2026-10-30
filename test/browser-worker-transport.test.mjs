import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
registerHooks({ resolve(specifier, context, nextResolve) {
  return nextResolve(/^\.\.?\//u.test(specifier) && !/(?:\.[a-z]+|\?.*)$/iu.test(specifier) ? `${specifier}.ts` : specifier, context);
} });
const { createBrowserWorkerTransport } = await import("../src/edge/browser-worker-transport.ts");
const revision = "a".repeat(40);
class FakeWorker extends EventTarget {
  messages = [];
  terminated = 0;
  postMessage(value) { this.messages.push(value); }
  terminate() { this.terminated += 1; }
  emit(value) { this.dispatchEvent(new MessageEvent("message", { data: value })); }
}
async function fixture(factory) {
  const workers = [];
  const events = [];
  let losses = 0;
  const transport = createBrowserWorkerTransport(factory ?? (() => { const worker = new FakeWorker(); workers.push(worker); return worker; }));
  const owner = transport.open({ event: event => events.push(event), lost: () => { losses += 1; } });
  const { sessionId } = await owner.ready;
  const command = generation => ({ sessionId, generation, repositoryUrl: "https://github.com/fixture/repository", additionalExclusions: "" });
  const emit = (worker, type, generation = 1, detail = {}) => worker.emit({ type, sessionId, generation, ...detail });
  return { owner, workers, events, command, emit, sessionId, losses: () => losses };
}

test("idle and invalid-input owners create neither worker nor server request", async () => {
  const f = await fixture();
  try {
    assert.match(f.sessionId, /^[A-Za-z0-9_-]{43}$/u);
    assert.equal(f.workers.length, 0);
    assert.equal(await f.owner.analyze({ ...f.command(1), repositoryUrl: "not a repository" }), 422);
    assert.equal(await f.owner.analyze({ ...f.command(2), additionalExclusions: "../bad" }), 422);
    assert.equal(f.workers.length, 0);
    assert.equal(await f.owner.analyze(f.command(3)), 202);
    assert.equal(f.workers.length, 1);
    assert.equal(f.workers[0].messages[0].type, "START");
  } finally { f.owner.close(); }
});

test("provider cancellation awaits raw-read drain acknowledgement and terminates once", async () => {
  const f = await fixture();
  try {
    await f.owner.analyze(f.command(1));
    const worker = f.workers[0];
    let settled = false;
    const cancelled = f.owner.cancel(f.command(1)).then(status => { settled = true; return status; });
    assert.equal(worker.messages.at(-1).type, "STOP");
    await Promise.resolve();
    assert.equal(settled, false);
    assert.equal(worker.terminated, 0);
    f.emit(worker, "ANALYSIS_CANCELLED");
    assert.equal(await cancelled, 204);
    assert.equal(worker.terminated, 1);
    assert.deepEqual(f.events.map(e => e.type), ["ANALYSIS_CANCELLED"]);
    assert.equal(await f.owner.cancel(f.command(1)), 204);
    assert.equal(worker.terminated, 1);
  } finally { f.owner.close(); }
});

test("replacement drains old provider work, coalesces to newest generation, and rejects stale delivery", async () => {
  const f = await fixture();
  try {
    await f.owner.analyze(f.command(1));
    const old = f.workers[0];
    const second = f.owner.analyze(f.command(2));
    const third = f.owner.analyze(f.command(3));
    assert.equal(f.workers.length, 1);
    assert.equal(old.messages.filter(m => m.type === "STOP").length, 1);
    f.emit(old, "ANALYSIS_CANCELLED");
    assert.deepEqual(await Promise.all([second, third]), [202, 202]);
    assert.equal(f.workers.length, 2);
    assert.equal(f.workers[1].messages[0].generation, 3);
    f.emit(old, "REVISION_SELECTED", 1, { revision });
    assert.deepEqual(f.events, []);
    f.emit(f.workers[1], "REVISION_SELECTED", 3, { revision });
    assert.equal(f.events.length, 1);
  } finally { f.owner.close(); }
});

test("parser-time cancellation terminates immediately without waiting for a blocked worker event loop", async () => {
  const f = await fixture();
  try {
    await f.owner.analyze(f.command(1));
    const worker = f.workers[0];
    f.emit(worker, "REVISION_SELECTED", 1, { revision });
    f.emit(worker, "ANALYSIS_PROGRESS", 1, { revision, stage: "analysis-initialization" });
    assert.equal(await f.owner.cancel(f.command(1)), 204);
    assert.equal(worker.messages.filter(m => m.type === "STOP").length, 0);
    assert.equal(worker.terminated, 1);
    assert.equal(f.events.at(-1).type, "ANALYSIS_CANCELLED");
  } finally { f.owner.close(); }
});

test("completed local data survives Cancel and is released by Discard or page loss", async () => {
  const f = await fixture();
  await f.owner.analyze(f.command(1));
  const worker = f.workers[0];
  f.emit(worker, "ANALYSIS_ALL_FILES_FAILED", 1, { revision, notAnalyzedFiles: [{ canonicalPath: "bad.js", category: "Syntax could not be analyzed" }] });
  assert.equal(await f.owner.cancel(f.command(1)), 204);
  assert.equal(worker.terminated, 0);
  assert.equal(await f.owner.discard(f.command(1)), 204);
  assert.equal(worker.terminated, 1);
  assert.equal(f.events.at(-1).type, "CURRENT_DISCARDED");
  f.owner.close(); f.owner.close();
  assert.equal(worker.terminated, 1);
});

test("closing an owner during drain unblocks replacement without starting detached work", async () => {
  const f = await fixture();
  await f.owner.analyze(f.command(1));
  const replacement = f.owner.analyze(f.command(2));
  f.owner.close();
  assert.equal(await replacement, 202);
  assert.equal(f.workers.length, 1);
  assert.equal(f.workers[0].terminated, 1);
  assert.deepEqual(f.events, []);
});

test("startup, crash, and malformed-worker errors release owned resources and expose no raw error", async () => {
  const failed = await fixture(() => { throw new Error("private startup detail"); });
  await failed.owner.analyze(failed.command(1));
  assert.equal(failed.losses(), 1); failed.owner.close();
  for (const kind of ["error", "messageerror", "malformed"]) {
    const f = await fixture();
    await f.owner.analyze(f.command(1));
    if (kind === "malformed") f.workers[0].emit({ raw: "private diagnostic" });
    else f.workers[0].dispatchEvent(new Event(kind));
    assert.equal(f.losses(), 1);
    assert.equal(f.workers[0].terminated, 1);
    assert.deepEqual(f.events, []);
    f.owner.close();
  }
});
