import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
registerHooks({ resolve(s, c, next) { return next(/^\.\.?\//.test(s) && !/\.[a-z]+$/i.test(s) ? `${s}.ts` : s, c); } });
const { createLocalFolderGateway } = await import("../src/edge/local-folder-gateway.ts");
const { acquireLocalWorkingTree, MAX_LOCAL_RAW_BYTES } = await import("../src/application/local-source.ts");
const signal = () => new AbortController().signal;
const bytes = text => new TextEncoder().encode(text);
const unavailable = { kind: "failure", category: "Local working tree unavailable" };
const limit = { kind: "failure", category: "Repository exceeds Code City limits" };
const tick = () => new Promise(resolve => setImmediate(resolve));
function file(name, text = "x", calls = []) {
  return { name, kind: "file", async getFile() { calls.push(`getFile:${name}`); return new File([text], name, { lastModified: 1 }); } };
}
function dir(name, children = [], calls = []) {
  return { name, kind: "directory", async *values() {
    calls.push(`values:${name}`);
    try { yield* children; } finally { calls.push(`closed:${name}`); }
  } };
}
const acquire = (root, exclusions = [], controller = new AbortController(), onProgress) => acquireLocalWorkingTree("synthetic", exclusions, controller.signal, createLocalFolderGateway(root), onProgress);
function streamHandle({ size, chunks, error, modified = 1, afterModified = modified, afterError, pending = false }) {
  const state = { reads: 0, cancelled: 0, gets: 0, streams: 0, released: false };
  const handle = { name: "a.ts", kind: "file", async getFile() {
    state.gets++;
    if (state.gets > 1 && afterError) throw new DOMException("C:/private/missing", afterError);
    return { size, lastModified: state.gets > 1 ? afterModified : modified, stream() {
      state.streams++;
      const stream = new ReadableStream({
        pull(c) {
          state.reads++;
          if (error) { c.error(new DOMException("C:/private/changed", error)); return; }
          if (chunks.length) c.enqueue(chunks.shift());
          else if (!pending) c.close();
        },
        cancel() { state.cancelled++; },
      }, { highWaterMark: 0 });
      const getReader = stream.getReader.bind(stream);
      stream.getReader = () => {
        const reader = getReader();
        const release = reader.releaseLock.bind(reader);
        reader.releaseLock = () => { state.released = true; release(); };
        return reader;
      };
      return stream;
    } };
  } };
  return { handle, state };
}

test("native-like prototypes work; exclusions prune BEFORE values/getFile and gitignore is never read", async () => {
  const calls = [];
  const forbiddenDir = name => ({ name, kind: "directory", values() { throw new Error(`Must not enter ${name}`); } });
  const forbiddenFile = name => ({ name, kind: "file", getFile() { throw new Error(`Must not read ${name}`); } });
  class NativeLikeRoot {
    get kind() { return "directory"; }
    async *values() {
      yield forbiddenDir("node_modules"); yield forbiddenDir("dist"); yield forbiddenDir("build");
      yield forbiddenDir("bin"); yield forbiddenDir("obj"); yield forbiddenDir(".GiT");
      yield forbiddenDir("excluded"); yield forbiddenFile("omit.ts"); yield forbiddenFile(".gitignore");
      yield dir("nested", [forbiddenFile(".GIT"), file("ignored-and-untracked.CS", "edit", calls)], calls);
      yield file("a.ts", "edited", calls);
    }
  }
  const result = await acquire(new NativeLikeRoot(), ["excluded", "omit.ts"]);
  assert.equal(result.kind, "success");
  assert.deepEqual(result.acquired.modules.map(m => [m.canonicalPath, m.normalizedSource]), [["a.ts", "edited"], ["nested/ignored-and-untracked.CS", "edit"]]);
  assert.equal(calls.filter(c => c.startsWith("getFile:")).length, 4, "initial and post-read metadata per eligible file only");
});

test("iterative deep traversal validates native raw paths, NFC collisions and canonical order", async () => {
  let nested = file("e\u0301.ts");
  for (let i = 0; i < 1200; i++) nested = dir("d", [nested]);
  const result = await acquire(dir("root", [nested, file("z.ts"), file("a.ts")]));
  assert.equal(result.kind, "success");
  assert.deepEqual(result.acquired.modules.map(m => m.canonicalPath), ["a.ts", `${"d/".repeat(1200)}é.ts`, "z.ts"]);
  for (const name of ["", ".", "..", "a/b.ts", "a\\b.ts", "C:", "bad\0.ts", "bad\ud800.ts"]) {
    assert.equal((await acquire(dir("root", [file(name)]))).code, "M1-ADM-1", JSON.stringify(name));
  }
  for (const children of [[file("é.ts"), file("e\u0301.ts")], [dir("é"), dir("e\u0301")], [file("a.ts"), file("a.ts")]]) {
    assert.equal((await acquire(dir("root", children))).code, "M1-ADM-1");
  }
});

test("drive-like nested names are ordinary segments but root drive prefixes remain invalid", async () => {
  const result = await acquire(dir("root", [dir("src", [file("C:example.ts"), dir("D:folder", [file("kept.ts")])])]));
  assert.equal(result.kind, "success");
  assert.deepEqual(result.acquired.modules.map(m => m.canonicalPath), ["src/C:example.ts", "src/D:folder/kept.ts"]);
  assert.equal((await acquire(dir("root", [file("C:example.ts")]))).code, "M1-ADM-1");
  assert.equal((await acquire(dir("root", [dir("C:folder", [file("kept.ts")])]))).code, "M1-ADM-1");
});

test("inventory count boundary closes iterators without any file reads", async () => {
  const calls = [];
  const root = dir("root", Array.from({ length: 4001 }, (_, i) => file(`${i}.ts`, "", calls)), calls);
  assert.deepEqual(await acquire(root), limit);
  assert.deepEqual(calls, ["values:root", "closed:root"]);
  const excluded = await acquire(root, ["4000.ts"]);
  assert.equal(excluded.kind, "success");
  assert.equal(excluded.acquired.modules.length, 4000);
});

test("stream raw guard accepts exact bytes, rejects size and actual-byte overflow, releases/cancels", async () => {
  const exact = streamHandle({ size: MAX_LOCAL_RAW_BYTES, chunks: [new Uint8Array(MAX_LOCAL_RAW_BYTES)] });
  const inventory = await createLocalFolderGateway(dir("root", [exact.handle])).loadInventory([], signal());
  const read = await inventory.candidates[0].readRawSource(signal());
  assert.equal(read.kind, "source");
  assert.equal(read.rawBytes.length, MAX_LOCAL_RAW_BYTES);
  assert.equal(exact.state.gets, 2);
  assert.equal(exact.state.released, true);
  const oversized = streamHandle({ size: MAX_LOCAL_RAW_BYTES + 1, chunks: [] });
  assert.deepEqual(await acquire(dir("root", [oversized.handle])), limit);
  assert.equal(oversized.state.streams, 0);
  const lying = streamHandle({ size: 1, chunks: [bytes("x"), new Uint8Array(MAX_LOCAL_RAW_BYTES)] });
  assert.deepEqual(await acquire(dir("root", [lying.handle])), limit);
  assert.equal(lying.state.cancelled, 1);
  assert.equal(lying.state.released, true);
  const short = streamHandle({ size: 2, chunks: [bytes("x")] });
  assert.deepEqual(await acquire(dir("root", [short.handle])), unavailable);
});

test("changed, missing and permission-revoked eligible files fail whole capture, never retry", async () => {
  for (const name of ["NotFoundError", "NotAllowedError", "NotReadableError", "SecurityError"]) {
    const handle = { name: "b.ts", kind: "file", async getFile() { throw new DOMException("C:/private/source", name); } };
    assert.deepEqual(await acquire(dir("root", [file("a.ts"), handle])), unavailable);
    const streamed = streamHandle({ size: 1, chunks: [], error: name });
    assert.deepEqual(await acquire(dir("root", [streamed.handle])), unavailable);
    assert.equal(streamed.state.gets, 1);
    assert.equal(streamed.state.released, true);
    const after = streamHandle({ size: 1, chunks: [bytes("x")], afterError: name });
    assert.deepEqual(await acquire(dir("root", [after.handle])), unavailable);
    assert.equal(after.state.gets, 2);
  }
  const changed = streamHandle({ size: 1, chunks: [bytes("x")], afterModified: 2 });
  assert.deepEqual(await acquire(dir("root", [changed.handle])), unavailable);
  assert.equal(changed.state.gets, 2);
});

test("cancel interrupts an actual pending stream read and drains cancellation before settling", async () => {
  const controller = new AbortController();
  const held = streamHandle({ size: 1, chunks: [], pending: true });
  const pending = acquire(dir("root", [held.handle]), [], controller);
  await tick();
  assert.equal(held.state.reads, 1);
  controller.abort();
  assert.deepEqual(await pending, { kind: "cancelled" });
  assert.equal(held.state.cancelled, 1);
  assert.equal(held.state.released, true);
  assert.equal(held.state.gets, 1);
});

test("cancellation during getFile drains late resolution without opening a stream", async () => {
  const controller = new AbortController();
  let resolve, streams = 0, settled = false;
  const handle = { name: "a.ts", kind: "file", getFile() { return new Promise(r => { resolve = r; }); } };
  const pending = acquire(dir("root", [handle]), [], controller).then(result => { settled = true; return result; });
  await tick();
  controller.abort();
  await tick();
  assert.equal(settled, false);
  resolve({ size: 1, lastModified: 1, stream() { streams++; throw new Error("must not stream"); } });
  assert.deepEqual(await pending, { kind: "cancelled" });
  assert.equal(streams, 0);
});

test("bad roots, inaccessible directories, unknown kinds sanitize; abort closes nested iterators", async () => {
  for (const root of [null, [], {}, { kind: "file" }, { kind: "directory", values() { throw new Error("C:/private"); } }]) {
    assert.deepEqual(await acquire(root), unavailable);
  }
  const calls = [];
  const throwing = { name: "denied", kind: "directory", async *values() { throw new DOMException("C:/private", "NotAllowedError"); } };
  assert.deepEqual(await acquire(dir("root", [file("a.ts"), throwing], calls)), unavailable);
  assert(calls.includes("closed:root"));
  assert.deepEqual(await acquire(dir("root", [{ name: "link.ts", kind: "symbolic-link" }])), unavailable);
  const controller = new AbortController();
  const child = { name: "child", kind: "directory", async *values() { try { controller.abort(); yield file("late.ts"); } finally { calls.push("closed:child"); } } };
  assert.deepEqual(await acquire(dir("root", [child], calls), [], controller), { kind: "cancelled" });
  assert(calls.includes("closed:child"));
  assert.deepEqual(await acquire(dir("root", [dir("empty.ts")])), { kind: "failure", category: "No supported modules", code: "ADM-07" });
});

test("replacement inventories have independent file capabilities, no mutable path map", async () => {
  let text = "first";
  const root = { kind: "directory", async *values() { yield file("a.ts", text); } };
  const gateway = createLocalFolderGateway(root);
  const first = await gateway.loadInventory([], signal());
  text = "second";
  const second = await gateway.loadInventory([], signal());
  assert.equal(new TextDecoder().decode((await first.candidates[0].readRawSource(signal())).rawBytes), "first");
  assert.equal(new TextDecoder().decode((await second.candidates[0].readRawSource(signal())).rawBytes), "second");
});
