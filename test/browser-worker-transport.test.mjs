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

test("inspection RPC is revision-bound, bounded per operation, and malformed data does not discard the city", async () => {
  const f = await fixture();
  try {
    await f.owner.analyze(f.command(1)); const worker = f.workers[0];
    f.emit(worker, "REVISION_SELECTED", 1, { revision });
    f.emit(worker, "ANALYSIS_ALL_FILES_FAILED", 1, { revision, notAnalyzedFiles: [{ canonicalPath: "bad.js", category: "Syntax could not be analyzed" }] });
    const query = { type: "units", path: "file.js", offset: 0 };
    const old = f.owner.inspect(query); const rejected = assert.rejects(old, /Inspection changed/u);
    const current = f.owner.inspect(query); await rejected;
    let command = worker.messages.at(-1);
    f.emit(worker, "INSPECTION_RESULT", 1, { requestId: command.requestId, revision, ok: true, value: { type: "units", path: "file.js", offset: 0, total: 0, rows: [] } });
    assert.equal((await current).total, 0);
    const malformed = f.owner.inspect(query); command = worker.messages.at(-1);
    f.emit(worker, "INSPECTION_RESULT", 1, { requestId: command.requestId, revision: "b".repeat(40), ok: true, value: {} });
    await assert.rejects(malformed, /inspection unavailable/u); assert.equal(f.losses(), 0); assert.equal(worker.terminated, 0);
  } finally { f.owner.close(); }
});

test("replacement rejects pending inspection and stale replies cannot reach the replacement", async () => {
  const f = await fixture();
  try {
    await f.owner.analyze(f.command(1)); const worker = f.workers[0];
    f.emit(worker, "REVISION_SELECTED", 1, { revision }); f.emit(worker, "ANALYSIS_ALL_FILES_FAILED", 1, { revision, notAnalyzedFiles: [{ canonicalPath: "bad.js", category: "Syntax could not be analyzed" }] });
    const pending = f.owner.inspect({ type: "units", path: "file.js", offset: 0 }); const rejected = assert.rejects(pending, /Inspection changed/u);
    const old = worker.messages.at(-1); await f.owner.analyze(f.command(2)); await rejected;
    f.emit(worker, "INSPECTION_RESULT", 1, { requestId: old.requestId, revision, ok: true, value: {} });
    assert.equal(f.losses(), 0); assert.equal(f.workers[1].terminated, 0);
  } finally { f.owner.close(); }
});

const captureId = "c".repeat(64);
const localOrigin = { kind: "working-tree", name: "Synthetic folder", captureId };
const localCommand = (f, generation = 1, root = {}) => ({ sessionId: f.sessionId, generation, inputKind: "working-tree", root, name: localOrigin.name, additionalExclusions: "" });

test("folder capability stays in process and is posted unchanged only to the dedicated worker", async () => {
  const f = await fixture();
  const root = { toJSON() { throw new Error("No JSON serialization"); }, values() { throw new Error("No UI filesystem reads"); } };
  try {
    assert.equal(await f.owner.analyze(localCommand(f, 1, root)), 202);
    assert.equal(f.workers[0].messages[0].root, root);
    assert.equal(f.workers[0].messages[0].inputKind, "working-tree");
    assert.equal(Object.hasOwn(f.workers[0].messages[0], "repositoryUrl"), false);
    f.emit(f.workers[0], "WORKING_TREE_STARTED", 1, { name: localOrigin.name });
    f.emit(f.workers[0], "WORKING_TREE_PROGRESS", 1, { completed: 0, total: 1 });
    assert.deepEqual(f.events.map(event => event.type), ["WORKING_TREE_STARTED", "WORKING_TREE_PROGRESS"]);
    assert.equal(f.losses(), 0);
  } finally { f.owner.close(); }
});

test("local read cancellation and replacement drain before termination; stale capture is suppressed", async () => {
  const f = await fixture();
  try {
    await f.owner.analyze(localCommand(f)); const old = f.workers[0];
    f.emit(old, "WORKING_TREE_STARTED", 1, { name: localOrigin.name });
    f.emit(old, "WORKING_TREE_PROGRESS", 1, { completed: 0, total: 2 });
    const replacement = f.owner.analyze(localCommand(f, 2));
    assert.equal(old.messages.at(-1).type, "STOP"); assert.equal(old.terminated, 0);
    f.emit(old, "ANALYSIS_CANCELLED"); await replacement;
    assert.equal(old.terminated, 1); assert.equal(f.workers.length, 2);
    const before = f.events.length;
    f.emit(old, "WORKING_TREE_CAPTURED", 1, { origin: localOrigin });
    assert.equal(f.events.length, before); assert.equal(f.losses(), 0);
  } finally { f.owner.close(); }
});

test("local capture switches to terminable parser ownership and binds bounded inspection to capture", async () => {
  const f = await fixture();
  try {
    await f.owner.analyze(localCommand(f)); const worker = f.workers[0];
    f.emit(worker, "WORKING_TREE_CAPTURED", 1, { origin: localOrigin });
    f.emit(worker, "ANALYSIS_ALL_FILES_FAILED", 1, { revision: captureId, notAnalyzedFiles: [{ canonicalPath: "bad.js", category: "Syntax could not be analyzed" }] });
    const pending = f.owner.inspect({ type: "units", path: "file.js", offset: 0 });
    const request = worker.messages.at(-1);
    f.emit(worker, "INSPECTION_RESULT", 1, { requestId: request.requestId, revision: captureId, ok: true, value: { type: "units", path: "file.js", offset: 0, total: 0, rows: [] } });
    assert.equal((await pending).total, 0);
    await f.owner.analyze(localCommand(f, 2)); const parserWorker = f.workers[1];
    f.emit(parserWorker, "WORKING_TREE_CAPTURED", 2, { origin: localOrigin });
    assert.equal(await f.owner.cancel(localCommand(f, 2)), 204);
    assert.equal(parserWorker.messages.some(message => message.type === "STOP"), false);
    assert.equal(parserWorker.terminated, 1);
  } finally { f.owner.close(); }
});

test("fabricated zero-candidate progress is rejected before observer delivery", async () => {
  const f = await fixture();
  try {
    await f.owner.analyze(localCommand(f)); const worker = f.workers[0];
    f.emit(worker, "WORKING_TREE_STARTED", 1, { name: localOrigin.name });
    f.emit(worker, "WORKING_TREE_PROGRESS", 1, { completed: 0, total: 0 });
    assert.equal(f.losses(), 1); assert.equal(worker.terminated, 1);
    assert.deepEqual(f.events.map(event => event.type), ["WORKING_TREE_STARTED"]);
  } finally { f.owner.close(); }
});

test("a pre-capture local failure is terminal and unavailable capability cloning is sanitized", async () => {
  const f = await fixture();
  try {
    await f.owner.analyze(localCommand(f));
    f.emit(f.workers[0], "WORKING_TREE_FAILED", 1, { category: "Local working tree unavailable" });
    assert.equal(f.events.at(-1).type, "WORKING_TREE_FAILED"); assert.equal(f.workers[0].terminated, 1); assert.equal(f.losses(), 0);
    await assert.rejects(f.owner.save(), /unavailable/u);
  } finally { f.owner.close(); }
  const failed = await fixture(() => { const worker = new FakeWorker(); worker.postMessage = () => { throw new DOMException("private folder", "DataCloneError"); }; return worker; });
  try { assert.equal(await failed.owner.analyze(localCommand(failed)), 202); assert.equal(failed.losses(), 1); assert.deepEqual(failed.events, []); }
  finally { failed.owner.close(); }
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
