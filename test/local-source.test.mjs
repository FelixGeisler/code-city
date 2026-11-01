import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
registerHooks({ resolve(s, c, next) { return next(/^\.\.?\//.test(s) && !/\.[a-z]+$/i.test(s) ? `${s}.ts` : s, c); } });
const { acquireLocalWorkingTree, MAX_LOCAL_RAW_BYTES } = await import("../src/application/local-source.ts");
const { recordExclusionPolicy } = await import("../src/domain/exclusion-policy.ts");
const { SUPPORTED_SUFFIXES } = await import("../src/domain/source-admission.ts");
const encode = text => new TextEncoder().encode(text);
const signal = () => new AbortController().signal;
const raw = bytes => ({ kind: "source", rawBytes: typeof bytes === "string" ? encode(bytes) : bytes });
const candidate = (path, read = async () => raw("x")) => ({ rawPath: path, canonicalPath: path.normalize("NFC"), readRawSource: read });
const gateway = candidates => ({ async loadInventory() { return { kind: "inventory", candidates }; } });
const run = (candidates, exclusions = [], name = "synthetic", onProgress) => acquireLocalWorkingTree(name, exclusions, signal(), gateway(candidates), onProgress);
const limit = { kind: "failure", category: "Repository exceeds Code City limits" };
const unavailable = { kind: "failure", category: "Local working tree unavailable" };
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
const tick = () => new Promise(resolve => setImmediate(resolve));

test("capture uses actual raw SHA-256 manifest, canonical order, policy, unsupported bytes, not root name", async () => {
  const entries = [candidate("e\u0301.ts", async () => raw("\uFEFFx\r\ny\r")), candidate("a.cs", async () => raw(new Uint8Array([255])))];
  const progress = [];
  const first = await run(entries, [], "root", (n, total) => progress.push([n, total]));
  assert.equal(first.kind, "success");
  assert.deepEqual(first.acquired.modules.map(m => [m.canonicalPath, m.normalizedSource, [...m.normalizedUtf8]]), [["é.ts", "x\ny\n", [120, 10, 121, 10]]]);
  assert.deepEqual(first.acquired.notAnalyzedFiles, [{ canonicalPath: "a.cs", category: "Source text is not supported" }]);
  const hash = bytes => createHash("sha256").update(bytes).digest("hex");
  const manifest = { version: "code-city-working-tree-v2", policy: {
    supportedSuffixes: SUPPORTED_SUFFIXES,
    metadata: "case-insensitive-.git-at-every-depth", exclusionPolicy: recordExclusionPolicy([]),
  }, files: [["a.cs", 1, hash(new Uint8Array([255]))], ["é.ts", encode("\uFEFFx\r\ny\r").length, hash(encode("\uFEFFx\r\ny\r"))]] };
  assert.equal(first.origin.captureId, hash(JSON.stringify(manifest)));
  const changed = structuredClone(manifest); changed.policy.exclusionPolicy = recordExclusionPolicy(['unused']);
  assert.notEqual(first.origin.captureId, hash(JSON.stringify(changed)), "applied policy changes capture identity even for unchanged files");
  assert.equal(first.acquired.selected, first.origin.captureId);
  assert.match(first.origin.captureId, /^[0-9a-f]{64}$/);
  assert.deepEqual(progress, [[0, 2], [1, 2], [2, 2]]);
  assert.equal((await run([...entries].reverse(), [], "other")).origin.captureId, first.origin.captureId);
  assert.notEqual((await run(entries, ["unused"])).origin.captureId, first.origin.captureId);
  assert.notEqual((await run([entries[0], candidate("a.cs", async () => raw(new Uint8Array([254])))] )).origin.captureId, first.origin.captureId);
  assert.notEqual((await run([candidate("é.ts", async () => raw("x\ny\n")), entries[1]])).origin.captureId, first.origin.captureId);
  assert.notEqual((await run([candidate("renamed.ts", entries[0].readRawSource), entries[1]])).origin.captureId, first.origin.captureId);
});

test("unsupported-only input is retained as per-file outcomes and still identified", async () => {
  const result = await run([candidate("a.ts", async () => raw("x\0")), candidate("b.cs", async () => raw(new Uint8Array([0xc0, 0xaf]))) ]);
  assert.equal(result.kind, "success");
  assert.equal(result.acquired.modules.length, 0);
  assert.equal(result.acquired.notAnalyzedFiles.length, 2);
});

test("invalid name, policy, raw path and NFC collisions fail before reads", async () => {
  let reads = 0;
  const read = async () => { reads++; return raw("x"); };
  for (const path of ["../a.ts", "C:/a.ts", "a\\b.ts", "/a.ts", "a//b.ts", "a\u0001.ts", "a\ud800.ts"]) {
    assert.equal((await run([candidate(path, read)])).code, "M1-ADM-1");
  }
  assert.equal((await run([candidate("é.ts", read), candidate("e\u0301.ts", read)])).code, "M1-ADM-1");
  assert.deepEqual(await run([candidate("a.ts", read)], ["z", "a"]), unavailable);
  assert.deepEqual(await run([candidate("a.ts", read)], [], "../private"), unavailable);
  assert.equal(reads, 0);
});

test("exclusions and metadata are never read; 4000 candidates pass, 4001 fail before reads", async () => {
  const entries = Array.from({ length: 4000 }, (_, i) => candidate(`${String(i).padStart(4, "0")}.ts`, async () => raw("")));
  let unexpected = 0;
  const forbidden = path => candidate(path, async () => { unexpected++; throw new Error("private"); });
  const progress = [];
  const result = await run([...entries, forbidden(".GIT/hidden.ts"), forbidden("dist/a.ts"), forbidden(".angular/a.ts"), forbidden("SYNTHETICFLOW.Hub.Web/ClientApp/.angular/cache/22.2.2/flow.hub.web/vite/deps/dependency.js"), forbidden("excluded/x.ts")], ["excluded"], "root", (n, t) => progress.push([n, t]));
  assert.equal(result.kind, "success");
  assert.equal(result.acquired.modules.length, 4000);
  assert.deepEqual(progress.at(-1), [4000, 4000]);
  assert.deepEqual(await run([...entries, forbidden("extra.ts")]), limit);
  assert.equal(unexpected, 0);
});

test("raw cap and exact normalized per-file and total bounds are enforced", async () => {
  const moduleCap = 2_097_152;
  const maxCRLF = encode(`\uFEFF${"\r\n".repeat(moduleCap)}`);
  assert.equal(maxCRLF.length, MAX_LOCAL_RAW_BYTES);
  const exact = await run([candidate("a.ts", async () => raw(maxCRLF))]);
  assert.equal(exact.kind, "success");
  assert.equal(exact.acquired.modules[0].normalizedUtf8.length, moduleCap);
  assert.deepEqual(await run([candidate("a.ts", async () => raw(new Uint8Array(MAX_LOCAL_RAW_BYTES + 1)))]), limit);
  assert.deepEqual(await run([candidate("a.ts", async () => raw("x".repeat(moduleCap + 1)))]), limit);
  const full = Array.from({ length: 20 }, (_, i) => candidate(`${String(i).padStart(2, "0")}.ts`, async () => raw("x".repeat(moduleCap))));
  assert.equal((await run(full)).kind, "success");
  assert.deepEqual(await run([...full, candidate("z.ts", async () => raw("x"))]), limit);
});

test("eight owned reads, canonical consumption, failure horizon and drain even when later failure settles first", async () => {
  const held = Array.from({ length: 12 }, deferred);
  const calls = [], aborted = [];
  const entries = held.map((pending, i) => candidate(`${String(i).padStart(2, "0")}.ts`, readSignal => {
    calls.push(i);
    readSignal.addEventListener("abort", () => { aborted.push(i); pending.resolve({ kind: "unavailable" }); }, { once: true });
    return pending.promise;
  }));
  const progress = [];
  const pending = run(entries.reverse(), [], "root", (n, total) => progress.push([n, total]));
  await tick();
  assert.deepEqual(calls, [0, 1, 2, 3, 4, 5, 6, 7]);
  held[3].resolve({ kind: "unavailable" });
  await tick();
  assert.deepEqual(aborted, [4, 5, 6, 7]);
  assert.deepEqual(progress, [[0, 12]]);
  held[1].resolve({ kind: "product-limit" });
  held[0].resolve(raw("x"));
  assert.deepEqual(await pending, limit, "earlier canonical raw limit wins over later unavailable");
  assert.deepEqual(calls, [0, 1, 2, 3, 4, 5, 6, 7]);
  assert(aborted.includes(2));
  assert.deepEqual(progress, [[0, 12], [1, 12]]);
});

test("earlier normalized failure wins over later raw error and failure stops refill", async () => {
  const held = deferred();
  let calls = 0;
  const entries = Array.from({ length: 12 }, (_, i) => candidate(`${String(i).padStart(2, "0")}.ts`, async () => {
    calls++;
    return i === 0 ? held.promise : i === 1 ? { kind: "unavailable" } : raw("x");
  }));
  const pending = run(entries);
  await tick();
  held.resolve(raw("x".repeat(2_097_153)));
  assert.deepEqual(await pending, limit);
  assert.equal(calls, 8);
});

test("external cancel aborts and drains owned reads, late values cannot succeed", async () => {
  const controller = new AbortController();
  let reads = 0, aborted = 0, settled = false;
  const delayed = deferred();
  const entries = Array.from({ length: 10 }, (_, i) => candidate(`${i}.ts`, readSignal => {
    reads++;
    readSignal.addEventListener("abort", () => { aborted++; }, { once: true });
    return delayed.promise;
  }));
  const pending = acquireLocalWorkingTree("root", [], controller.signal, gateway(entries)).then(value => { settled = true; return value; });
  await tick();
  controller.abort();
  await tick();
  assert.equal(settled, false, "owned promises must drain before cancellation settles");
  assert.equal(reads, 8);
  assert.equal(aborted, 8);
  delayed.resolve(raw("late"));
  assert.deepEqual(await pending, { kind: "cancelled" });
});

test("cancellation wins an inventory-failure race through terminal cleanup", async () => {
  const controller = new AbortController();
  const gateway = { async loadInventory() {
    queueMicrotask(() => queueMicrotask(() => controller.abort()));
    return unavailable;
  } };
  assert.deepEqual(await acquireLocalWorkingTree("root", [], controller.signal, gateway), { kind: "cancelled" });
});

test("cancel from progress prevents reads; progress exceptions drain and sanitize; thrown reads sanitize", async () => {
  const controller = new AbortController();
  let reads = 0;
  const entries = [candidate("a.ts", async () => { reads++; return raw("x"); })];
  assert.deepEqual(await acquireLocalWorkingTree("root", [], controller.signal, gateway(entries), () => controller.abort()), { kind: "cancelled" });
  assert.equal(reads, 0);
  assert.deepEqual(await run(entries, [], "root", () => { throw new Error("C:/private"); }), unavailable);
  assert.deepEqual(await run([candidate("a.ts", () => { throw new Error("C:/private"); })]), unavailable);
  assert.deepEqual(await run([candidate("a.ts", async () => { throw new Error("C:/private"); })]), unavailable);
  assert.deepEqual(await run([]), { kind: "failure", category: "No supported modules", code: "ADM-06" });
});
