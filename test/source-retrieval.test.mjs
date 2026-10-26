import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(/^\.\.?\//.test(specifier) && !/\.[a-z]+$/i.test(specifier) ? `${specifier}.ts` : specifier, context);
  },
});

const { acquireProjectSources, retrieveAdmittedSources } = await import("../src/application/source-retrieval.ts");

const REPOSITORY = { owner: "owner", repository: "repo", branch: null };
const SHA40 = "a".repeat(40);
const SHA64 = "b".repeat(64);
const BLOB40 = "c".repeat(40);
const regular = (path, sha = BLOB40) => ({ path, mode: "100644", type: "blob", sha });
const encoder = new TextEncoder();

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolveValue, rejectValue) => {
    resolve = resolveValue;
    reject = rejectValue;
  });
  return { promise, resolve, reject };
}

function rawSource(text) {
  return { kind: "source", rawBytes: encoder.encode(text) };
}

function gateway(entries, readSource = async () => ({ kind: "source", decodedSource: "" })) {
  const calls = [];
  return {
    calls,
    value: {
      async loadInventory() { calls.push("inventory"); return { kind: "inventory", entries }; },
      async readSource(_repository, _selected, candidate) { calls.push(candidate.canonicalPath); return readSource(candidate); },
    },
  };
}

test("invalid selected object IDs fail before every commit or raw capability", async () => {
  for (const selected of ["a".repeat(39), "a".repeat(41), "a".repeat(63), "a".repeat(65), "A".repeat(40), "g".repeat(40)]) {
    const fixture = gateway([regular("a.ts")]);
    assert.deepEqual(await retrieveAdmittedSources(REPOSITORY, selected, new AbortController().signal, fixture.value), {
      kind: "failure", category: "Provider/resolution failure",
    });
    assert.deepEqual(fixture.calls, []);
  }
});

test("canonical candidate fetch horizons validate width only when reached", async () => {
  const entries = [regular("z.ts", "d".repeat(40)), regular("a.ts", "c".repeat(40)), regular("m.ts", "e".repeat(64))];
  const fixture = gateway(entries);
  assert.deepEqual(await retrieveAdmittedSources(REPOSITORY, SHA40, new AbortController().signal, fixture.value), {
    kind: "failure", category: "Provider/resolution failure",
  });
  assert.deepEqual(fixture.calls, ["inventory", "a.ts"], "mixed-width m.ts fails before its URL/capability call");

  const absent = gateway([regular("z.ts"), { path: "a.ts", mode: "100644", type: "blob" }]);
  assert.deepEqual(await retrieveAdmittedSources(REPOSITORY, SHA40, new AbortController().signal, absent.value), {
    kind: "failure", category: "Provider/resolution failure",
  });
  assert.deepEqual(absent.calls, ["inventory"]);
});

test("provider order permutations produce the same canonical admitted order and ownership phases", async () => {
  const entries = [regular("é.ts"), regular("z.ts"), regular("a.ts")];
  const outcomes = [];
  for (const permutation of [entries, [...entries].reverse(), [entries[1], entries[2], entries[0]]]) {
    const observed = [];
    const fixture = gateway(permutation, async (candidate) => ({ kind: "source", decodedSource: candidate.canonicalPath }));
    const result = await retrieveAdmittedSources(REPOSITORY, SHA40, new AbortController().signal, fixture.value, (state) => observed.push(state));
    assert.equal(result.kind, "admitted");
    outcomes.push(result.modules);
    assert.deepEqual(fixture.calls, ["inventory", "a.ts", "z.ts", "é.ts"]);
    assert(observed.every((state) => state.providerResource === false));
    assert(observed.every((state) => !Object.hasOwn(state, "candidateCount")));
    assert.deepEqual(observed.at(-1), { phase: "static", projectedInventory: false, providerResource: false });
  }
  assert.deepEqual(outcomes[1], outcomes[0]);
  assert.deepEqual(outcomes[2], outcomes[0]);
});

test("complete validation precedes exclusions while valid excluded files are never read or counted", async () => {
  for (const entries of [
    [regular("excluded/missing.ts")],
    [{ path: "excluded", mode: "120000", type: "blob" }, regular("excluded/child.ts")],
  ]) {
    const malformed = gateway(entries, async () => { throw new Error("excluded source must not be read"); });
    assert.deepEqual(await retrieveAdmittedSources(
      REPOSITORY, SHA40, new AbortController().signal, malformed.value, undefined, ["excluded"],
    ), { kind: "failure", category: "Source admission failed", code: "M1-ADM-3" });
    assert.deepEqual(malformed.calls, ["inventory"]);
  }

  const valid = gateway([
    { path: "excluded", mode: "040000", type: "tree" },
    regular("excluded/huge.ts", undefined),
    regular("kept.ts"),
  ], async (candidate) => {
    assert.equal(candidate.canonicalPath, "kept.ts");
    return { kind: "source", decodedSource: "kept" };
  });
  const result = await retrieveAdmittedSources(
    REPOSITORY, SHA40, new AbortController().signal, valid.value, undefined, ["excluded"],
  );
  assert.equal(result.kind, "admitted");
  assert.deepEqual(result.modules, [{ canonicalPath: "kept.ts", normalizedSource: "kept" }]);
  assert.deepEqual(valid.calls, ["inventory", "kept.ts"]);
});

test("an excluded 4,001st supported file is neither fetched nor counted", async () => {
  const entries = Array.from({ length: 4_001 }, (_, index) => regular(`${String(index).padStart(4, "0")}.ts`));
  const excluded = entries.at(-1).path;
  const fixture = gateway(entries);
  const result = await retrieveAdmittedSources(
    REPOSITORY, SHA40, new AbortController().signal, fixture.value, undefined, [excluded],
  );
  assert.equal(result.kind, "admitted");
  assert.equal(result.modules.length, 4_000);
  assert.equal(fixture.calls.length, 4_001);
  assert.equal(fixture.calls.includes(excluded), false);
});

test("4,001 valid candidate mocks are read sequentially and only the admitted 4,001st triggers count limit", async () => {
  const entries = Array.from({ length: 4_001 }, (_, index) => regular(`${String(index).padStart(4, "0")}.ts`));
  let reads = 0;
  let active = 0;
  let maximumActive = 0;
  const fixture = gateway(entries, async () => {
    reads += 1;
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await Promise.resolve();
    active -= 1;
    return { kind: "source", decodedSource: "" };
  });
  assert.deepEqual(await retrieveAdmittedSources(REPOSITORY, SHA40, new AbortController().signal, fixture.value), {
    kind: "failure", category: "Repository exceeds Code City limits",
  });
  assert.equal(reads, 4_001);
  assert.equal(maximumActive, 1);
});

test("a hash/content-style failure at the potential 4,001st admission retains its own outcome", async () => {
  const entries = Array.from({ length: 4_001 }, (_, index) => regular(`${String(index).padStart(4, "0")}.ts`));
  let reads = 0;
  const fixture = gateway(entries, async () => {
    reads += 1;
    return reads === 4_001 ? { kind: "invalid-content" } : { kind: "source", decodedSource: "" };
  });
  assert.deepEqual(await retrieveAdmittedSources(REPOSITORY, SHA40, new AbortController().signal, fixture.value), {
    kind: "failure", category: "Source admission failed", code: "M1-ADM-4",
  });
  assert.equal(reads, 4_001);
});

test("gateway outcome mapping is closed and never returns partial modules", async () => {
  for (const [source, expected] of [
    [{ kind: "provider-failure" }, { kind: "failure", category: "Provider/resolution failure" }],
    [{ kind: "invalid-content" }, { kind: "failure", category: "Source admission failed", code: "M1-ADM-4" }],
    [{ kind: "product-limit" }, { kind: "failure", category: "Repository exceeds Code City limits" }],
  ]) {
    const fixture = gateway([regular("a.ts"), regular("b.ts")], async () => source);
    const result = await retrieveAdmittedSources(REPOSITORY, SHA40, new AbortController().signal, fixture.value);
    assert.deepEqual(result, expected);
    assert.equal(Object.hasOwn(result, "modules"), false);
    assert.equal(fixture.calls.length, 2);
  }
  const inventoryFailure = gateway([]);
  inventoryFailure.value.loadInventory = async () => ({ kind: "provider-failure" });
  assert.deepEqual(await retrieveAdmittedSources(REPOSITORY, SHA64, new AbortController().signal, inventoryFailure.value), {
    kind: "failure", category: "Provider/resolution failure",
  });
});

test("project acquisition reports exact zero-origin candidate completion only after validated preflight", async () => {
  const observed = [];
  const reads = [];
  const result = await acquireProjectSources(REPOSITORY, SHA40, new AbortController().signal, {
    async loadInventory() {
      return { kind: "inventory", entries: [regular("c.ts"), regular("a.ts"), regular("b.ts")] };
    },
    async readRawSource(_repository, _selected, candidate) {
      reads.push(candidate.canonicalPath);
      return {
        kind: "source",
        rawBytes: candidate.canonicalPath === "b.ts" ? Uint8Array.of(0xff) : new TextEncoder().encode(candidate.canonicalPath),
      };
    },
  }, (ownership) => observed.push(ownership));
  assert.equal(result.kind, "acquired");
  assert.deepEqual(reads, ["a.ts", "b.ts", "c.ts"]);
  assert.deepEqual(observed, [
    { phase: "provider-inventory", projectedInventory: false, providerResource: false },
    { phase: "provider-cleared", projectedInventory: true, providerResource: false },
    { phase: "provider-candidate", candidateIndex: 0, candidateCount: 3, projectedInventory: true, providerResource: false },
    { phase: "provider-candidate", candidateIndex: 1, candidateCount: 3, projectedInventory: true, providerResource: false },
    { phase: "provider-candidate", candidateIndex: 2, candidateCount: 3, projectedInventory: true, providerResource: false },
    { phase: "provider-cleared", candidateIndex: 3, candidateCount: 3, projectedInventory: false, providerResource: false },
    { phase: "static", projectedInventory: false, providerResource: false },
  ]);

  for (const entries of [
    [regular("a.ts"), regular("a.ts")],
    Array.from({ length: 4_001 }, (_, index) => regular(`${String(index).padStart(4, "0")}.ts`)),
  ]) {
    const failedObservations = [];
    const failed = await acquireProjectSources(REPOSITORY, SHA40, new AbortController().signal, {
      async loadInventory() { return { kind: "inventory", entries }; },
      async readRawSource() { throw new Error("preflight failure must not read"); },
    }, (ownership) => failedObservations.push(ownership));
    assert.equal(failed.kind, "failure");
    assert.equal(failedObservations.some((ownership) => Object.hasOwn(ownership, "candidateCount")), false);
  }
});

test("project acquisition validates every identity and the 4,000-file envelope before its first raw read", async () => {
  let boundaryReads = 0;
  const boundary = await acquireProjectSources(REPOSITORY, SHA40, new AbortController().signal, {
    async loadInventory() {
      return { kind: "inventory", entries: Array.from({ length: 4_000 }, (_, index) => regular(`${String(index).padStart(4, "0")}.ts`)) };
    },
    async readRawSource() {
      boundaryReads += 1;
      return { kind: "source", rawBytes: Uint8Array.of(0xff) };
    },
  });
  assert.equal(boundary.kind, "acquired");
  assert.equal(boundaryReads, 4_000);
  assert.equal(boundary.modules.length, 0);
  assert.equal(boundary.notAnalyzedFiles.length, 4_000);

  for (const [entries, expected] of [
    [Array.from({ length: 4_001 }, (_, index) => regular(`${String(index).padStart(4, "0")}.ts`)), { kind: "failure", category: "Repository exceeds Code City limits" }],
    [[regular("a.ts"), regular("z.ts", "d".repeat(64))], { kind: "failure", category: "Provider/resolution failure" }],
  ]) {
    let reads = 0;
    const result = await acquireProjectSources(REPOSITORY, SHA40, new AbortController().signal, {
      async loadInventory() { return { kind: "inventory", entries }; },
      async readRawSource() { reads += 1; return { kind: "source", rawBytes: new Uint8Array() }; },
    });
    assert.deepEqual(result, expected);
    assert.equal(reads, 0);
  }
});

test("project acquisition keeps unsupported and excluded paths absent and preserves zero-eligible failure", async () => {
  const entries = [
    { path: "excluded", mode: "040000", type: "tree" },
    regular("excluded/a.ts"),
    regular("ignored.txt"),
    regular("kept.ts"),
  ];
  const reads = [];
  const result = await acquireProjectSources(REPOSITORY, SHA40, new AbortController().signal, {
    async loadInventory() { return { kind: "inventory", entries }; },
    async readRawSource(_repository, _selected, candidate) {
      reads.push(candidate.canonicalPath);
      return { kind: "source", rawBytes: new TextEncoder().encode("kept") };
    },
  }, undefined, ["excluded"]);
  assert.equal(result.kind, "acquired");
  assert.deepEqual(reads, ["kept.ts"]);
  assert.deepEqual(result.modules.map(({ canonicalPath }) => canonicalPath), ["kept.ts"]);

  let zeroReads = 0;
  const zero = await acquireProjectSources(REPOSITORY, SHA40, new AbortController().signal, {
    async loadInventory() { return { kind: "inventory", entries: [regular("ignored.txt")] }; },
    async readRawSource() { zeroReads += 1; throw new Error("must not read"); },
  });
  assert.deepEqual(zero, { kind: "failure", category: "No supported modules", code: "ADM-06" });
  assert.equal(zeroReads, 0);
});

test("project acquisition continues text failures, retains exact normalized own bytes, and is provider-order deterministic", async () => {
  const entries = [regular("z.ts"), regular("bad-utf8.ts"), regular("nul.ts"), regular("a.ts")];
  const bytes = new Map([
    ["a.ts", Uint8Array.from([0xef, 0xbb, 0xbf, 0x61, 0x0d, 0x0a, 0x62, 0x0d])],
    ["bad-utf8.ts", Uint8Array.of(0xff)],
    ["nul.ts", new TextEncoder().encode("a\0b")],
    ["z.ts", new TextEncoder().encode("z")],
  ]);
  const outcomes = [];
  for (const inventoryEntries of [entries, [...entries].reverse()]) {
    const reads = [];
    const result = await acquireProjectSources(REPOSITORY, SHA40, new AbortController().signal, {
      async loadInventory() { return { kind: "inventory", entries: inventoryEntries }; },
      async readRawSource(_repository, _selected, candidate) {
        reads.push(candidate.canonicalPath);
        return { kind: "source", rawBytes: bytes.get(candidate.canonicalPath) };
      },
    });
    assert.equal(result.kind, "acquired");
    assert.deepEqual(reads, ["a.ts", "bad-utf8.ts", "nul.ts", "z.ts"]);
    assert.deepEqual(result.notAnalyzedFiles, [
      { canonicalPath: "bad-utf8.ts", category: "Source text is not supported" },
      { canonicalPath: "nul.ts", category: "Source text is not supported" },
    ]);
    assert.deepEqual(result.modules.map(({ canonicalPath, normalizedSource }) => [canonicalPath, normalizedSource]), [["a.ts", "a\nb\n"], ["z.ts", "z"]]);
    for (const module of result.modules) {
      assert.equal(Object.getPrototypeOf(module.normalizedUtf8), Uint8Array.prototype);
      assert.equal(module.normalizedUtf8.byteOffset, 0);
      assert.equal(module.normalizedUtf8.byteLength, module.normalizedUtf8.buffer.byteLength);
      assert.equal(Object.isExtensible(module.normalizedUtf8), true);
      assert.equal(Object.isExtensible(module.normalizedUtf8.buffer), true);
      assert.deepEqual(module.normalizedUtf8, new TextEncoder().encode(module.normalizedSource));
    }
    outcomes.push(result);
  }
  assert.deepEqual(outcomes[1], outcomes[0]);
});

test("project acquisition enforces inclusive normalized limits and discards a late whole-attempt outcome", async () => {
  const exact = "x".repeat(2_097_152);
  const exactResult = await acquireProjectSources(REPOSITORY, SHA40, new AbortController().signal, {
    async loadInventory() { return { kind: "inventory", entries: [regular("a.ts")] }; },
    async readRawSource() { return { kind: "source", rawBytes: new TextEncoder().encode(exact) }; },
  });
  assert.equal(exactResult.kind, "acquired");
  assert.equal(exactResult.modules[0].normalizedUtf8.byteLength, 2_097_152);

  const overResult = await acquireProjectSources(REPOSITORY, SHA40, new AbortController().signal, {
    async loadInventory() { return { kind: "inventory", entries: [regular("a.ts")] }; },
    async readRawSource() { return { kind: "source", rawBytes: new TextEncoder().encode(`${exact}x`) }; },
  });
  assert.deepEqual(overResult, { kind: "failure", category: "Repository exceeds Code City limits" });

  const aggregateEntries = Array.from({ length: 21 }, (_, index) => regular(`${String(index).padStart(2, "0")}.ts`));
  const aggregateBytes = new TextEncoder().encode(exact);
  const exactAggregate = await acquireProjectSources(REPOSITORY, SHA40, new AbortController().signal, {
    async loadInventory() { return { kind: "inventory", entries: aggregateEntries.slice(0, 20) }; },
    async readRawSource() { return { kind: "source", rawBytes: aggregateBytes }; },
  });
  assert.equal(exactAggregate.kind, "acquired");
  assert.equal(exactAggregate.modules.reduce((sum, module) => sum + module.normalizedUtf8.byteLength, 0), 41_943_040);
  const overAggregate = await acquireProjectSources(REPOSITORY, SHA40, new AbortController().signal, {
    async loadInventory() { return { kind: "inventory", entries: aggregateEntries }; },
    async readRawSource(_repository, _selected, candidate) {
      return { kind: "source", rawBytes: candidate.canonicalPath === "20.ts" ? Uint8Array.of(0x78) : aggregateBytes };
    },
  });
  assert.deepEqual(overAggregate, { kind: "failure", category: "Repository exceeds Code City limits" });

  let reads = 0;
  const late = await acquireProjectSources(REPOSITORY, SHA40, new AbortController().signal, {
    async loadInventory() { return { kind: "inventory", entries: [regular("a.ts"), regular("b.ts")] }; },
    async readRawSource() {
      reads += 1;
      return reads === 1 ? { kind: "source", rawBytes: new TextEncoder().encode("retained only on complete acquisition") } : { kind: "provider-failure" };
    },
  });
  assert.deepEqual(late, { kind: "failure", category: "Provider/resolution failure" });
  assert.equal(Object.hasOwn(late, "modules"), false);
  assert.equal(Object.hasOwn(late, "notAnalyzedFiles"), false);

  const controller = new AbortController();
  let cancellationReads = 0;
  const cancelled = await acquireProjectSources(REPOSITORY, SHA40, controller.signal, {
    async loadInventory() { return { kind: "inventory", entries: [regular("a.ts"), regular("b.ts")] }; },
    async readRawSource() {
      cancellationReads += 1;
      if (cancellationReads === 2) controller.abort();
      return { kind: "source", rawBytes: new TextEncoder().encode("temporary") };
    },
  });
  assert.deepEqual(cancelled, { kind: "cancelled" });
  assert.equal(Object.hasOwn(cancelled, "modules"), false);
  assert.equal(Object.hasOwn(cancelled, "notAnalyzedFiles"), false);
});

test("bounded raw acquisition owns at most eight pending or completed outcomes and a slow first file blocks candidate eight", async () => {
  const entries = Array.from({ length: 10 }, (_, index) => regular(`${String(index).padStart(2, "0")}.ts`));
  const controls = new Map();
  const starts = [];
  let owned = 0;
  let peakOwned = 0;
  const firstWindow = deferred();
  const ninthStart = deferred();
  const outcome = (index) => {
    const rawBytes = encoder.encode(`source-${index}`);
    return {
      kind: "source",
      get rawBytes() {
        owned -= 1;
        return rawBytes;
      },
    };
  };
  const pending = acquireProjectSources(REPOSITORY, SHA40, new AbortController().signal, {
    async loadInventory() { return { kind: "inventory", entries }; },
    readRawSource(_repository, _selected, candidate) {
      const index = Number.parseInt(candidate.canonicalPath, 10);
      starts.push(index);
      owned += 1;
      peakOwned = Math.max(peakOwned, owned);
      assert(owned <= 8, `owned raw outcomes exceeded the window at ${index}`);
      if (starts.length === 8) firstWindow.resolve();
      if (starts.length === 9) ninthStart.resolve();
      if (index >= 8) return Promise.resolve(outcome(index));
      const control = deferred();
      controls.set(index, control);
      return control.promise;
    },
  });

  await firstWindow.promise;
  assert.deepEqual(starts, [0, 1, 2, 3, 4, 5, 6, 7]);
  for (let index = 1; index < 8; index += 1) controls.get(index).resolve(outcome(index));
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(starts, [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(owned, 8, "completed but unconsumed outcomes retain their slots");

  controls.get(0).resolve(outcome(0));
  await ninthStart.promise;
  assert.deepEqual(starts.slice(0, 9), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  const result = await pending;
  assert.equal(result.kind, "acquired");
  assert.deepEqual(result.modules.map(({ canonicalPath }) => canonicalPath), entries.map(({ path }) => path));
  assert.deepEqual(starts, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(peakOwned, 8);
  assert.equal(owned, 0);
});

test("reverse raw completion preserves canonical modules, failed rows, starts, and acquisition progress", async () => {
  const entries = Array.from({ length: 12 }, (_, index) => regular(`${String(index).padStart(2, "0")}.ts`));
  const controls = new Map();
  const starts = [];
  const progress = [];
  const firstWindow = deferred();
  const pending = acquireProjectSources(REPOSITORY, SHA40, new AbortController().signal, {
    async loadInventory() { return { kind: "inventory", entries: [...entries].reverse() }; },
    readRawSource(_repository, _selected, candidate) {
      const index = Number.parseInt(candidate.canonicalPath, 10);
      starts.push(index);
      if (starts.length === 8) firstWindow.resolve();
      if (index >= 8) return Promise.resolve(index === 10 ? { kind: "source", rawBytes: Uint8Array.of(0xff) } : rawSource(`${index}\r\n`));
      const control = deferred();
      controls.set(index, control);
      return control.promise;
    },
  }, (ownership) => {
    if (ownership.phase === "provider-candidate" || (ownership.phase === "provider-cleared" && ownership.candidateIndex !== undefined)) {
      progress.push(ownership.candidateIndex);
    }
  });

  await firstWindow.promise;
  for (let index = 7; index >= 0; index -= 1) controls.get(index).resolve(index === 3
    ? { kind: "source", rawBytes: Uint8Array.of(0xff) }
    : rawSource(`${index}\r\n`));
  const result = await pending;
  assert.equal(result.kind, "acquired");
  assert.deepEqual(starts, Array.from({ length: 12 }, (_, index) => index));
  assert.deepEqual(result.modules.map(({ canonicalPath, normalizedSource }) => [canonicalPath, normalizedSource]), [
    ["00.ts", "0\n"], ["01.ts", "1\n"], ["02.ts", "2\n"], ["04.ts", "4\n"], ["05.ts", "5\n"],
    ["06.ts", "6\n"], ["07.ts", "7\n"], ["08.ts", "8\n"], ["09.ts", "9\n"], ["11.ts", "11\n"],
  ]);
  assert.deepEqual(result.notAnalyzedFiles, [
    { canonicalPath: "03.ts", category: "Source text is not supported" },
    { canonicalPath: "10.ts", category: "Source text is not supported" },
  ]);
  assert.deepEqual(progress, Array.from({ length: 13 }, (_, index) => index));
});

test("the lowest known raw failure horizon stops admission, preserves the earlier prefix, and ignores internal abort outcomes", async () => {
  const entries = Array.from({ length: 10 }, (_, index) => regular(`${index}.ts`));
  const first = deferred();
  const higherAborted = deferred();
  const starts = [];
  let abortedHigher = 0;
  let outstanding = 0;
  const pending = acquireProjectSources(REPOSITORY, SHA40, new AbortController().signal, {
    async loadInventory() { return { kind: "inventory", entries }; },
    readRawSource(_repository, _selected, candidate, signal) {
      const index = Number.parseInt(candidate.canonicalPath, 10);
      starts.push(index);
      outstanding += 1;
      if (index === 0) return first.promise.finally(() => { outstanding -= 1; });
      if (index === 4) {
        outstanding -= 1;
        return Promise.resolve({ kind: "product-limit" });
      }
      if (index > 4) {
        return new Promise((resolve) => signal.addEventListener("abort", () => {
          abortedHigher += 1;
          outstanding -= 1;
          resolve({ kind: "provider-failure" });
          if (abortedHigher === 3) higherAborted.resolve();
        }, { once: true }));
      }
      outstanding -= 1;
      return Promise.resolve(rawSource(`${index}`));
    },
  });

  await higherAborted.promise;
  assert.deepEqual(starts, [0, 1, 2, 3, 4, 5, 6, 7]);
  first.resolve({ kind: "provider-failure" });
  assert.deepEqual(await pending, { kind: "failure", category: "Provider/resolution failure" });
  assert.equal(outstanding, 0);
  assert.equal(starts.includes(8), false);
});

test("canonical observer and ownership failures precede prefetched raw failures", async () => {
  const entries = Array.from({ length: 8 }, (_, index) => regular(`${index}.ts`));
  const observerResult = await acquireProjectSources(REPOSITORY, SHA40, new AbortController().signal, {
    async loadInventory() { return { kind: "inventory", entries }; },
    async readRawSource(_repository, _selected, candidate) {
      return candidate.canonicalPath === "2.ts" ? { kind: "product-limit" } : rawSource(candidate.canonicalPath);
    },
  }, (ownership) => {
    if (ownership.phase === "provider-candidate" && ownership.candidateIndex === 2) throw new Error("observer");
  });
  assert.deepEqual(observerResult, { kind: "failure", category: "Provider/resolution failure" });

  const target = {
    async loadInventory() { return { kind: "inventory", entries }; },
    async readRawSource(_repository, _selected, candidate) {
      return candidate.canonicalPath === "4.ts" ? { kind: "product-limit" } : rawSource(candidate.canonicalPath);
    },
  };
  const ownershipFault = new Proxy(target, {
    getOwnPropertyDescriptor() { throw new Error("ownership"); },
  });
  assert.deepEqual(await acquireProjectSources(
    REPOSITORY, SHA40, new AbortController().signal, ownershipFault,
  ), { kind: "failure", category: "Provider/resolution failure" });
});

test("a lower canonical aggregate overflow precedes a known higher raw provider failure", async () => {
  const entries = Array.from({ length: 28 }, (_, index) => regular(`${String(index).padStart(2, "0")}.ts`));
  const exact = encoder.encode("x".repeat(2_097_152));
  const result = await acquireProjectSources(REPOSITORY, SHA40, new AbortController().signal, {
    async loadInventory() { return { kind: "inventory", entries }; },
    async readRawSource(_repository, _selected, candidate) {
      const index = Number.parseInt(candidate.canonicalPath, 10);
      if (index === 27) return { kind: "provider-failure" };
      return { kind: "source", rawBytes: index < 20 ? exact : Uint8Array.of(0x78) };
    },
  });
  assert.deepEqual(result, { kind: "failure", category: "Repository exceeds Code City limits" });
});

test("synchronous and rejected raw reads are handled immediately without unhandled rejection", async () => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    for (const mode of ["throw", "reject"]) {
      let reads = 0;
      const result = await acquireProjectSources(REPOSITORY, SHA40, new AbortController().signal, {
        async loadInventory() { return { kind: "inventory", entries: Array.from({ length: 10 }, (_, index) => regular(`${index}.ts`)) }; },
        readRawSource(_repository, _selected, candidate) {
          reads += 1;
          if (candidate.canonicalPath === "0.ts") {
            if (mode === "throw") throw new Error("synchronous");
            return Promise.reject(new Error("rejected"));
          }
          return Promise.resolve(rawSource(candidate.canonicalPath));
        },
      });
      assert.deepEqual(result, { kind: "failure", category: "Provider/resolution failure" });
      assert(reads <= 8, mode);
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("external cancellation during terminal drain wins and return waits for every owned raw read", async () => {
  const entries = Array.from({ length: 8 }, (_, index) => regular(`${index}.ts`));
  const controller = new AbortController();
  const drainRelease = deferred();
  const allAborted = deferred();
  let aborted = 0;
  let outstanding = 0;
  let listenerAdds = 0;
  let listenerRemoves = 0;
  const originalAdd = controller.signal.addEventListener.bind(controller.signal);
  const originalRemove = controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.addEventListener = (...args) => { listenerAdds += 1; return originalAdd(...args); };
  controller.signal.removeEventListener = (...args) => { listenerRemoves += 1; return originalRemove(...args); };

  const pending = acquireProjectSources(REPOSITORY, SHA40, controller.signal, {
    async loadInventory() { return { kind: "inventory", entries }; },
    readRawSource(_repository, _selected, candidate, signal) {
      const index = Number.parseInt(candidate.canonicalPath, 10);
      if (index === 0) return Promise.resolve({ kind: "provider-failure" });
      outstanding += 1;
      return new Promise((resolve) => signal.addEventListener("abort", () => {
        aborted += 1;
        if (aborted === 7) allAborted.resolve();
        drainRelease.promise.then(() => {
          outstanding -= 1;
          resolve({ kind: "provider-failure" });
        });
      }, { once: true }));
    },
  });

  await allAborted.promise;
  let returned = false;
  pending.then(() => { returned = true; });
  await Promise.resolve();
  assert.equal(returned, false);
  controller.abort();
  drainRelease.resolve();
  assert.deepEqual(await pending, { kind: "cancelled" });
  assert.equal(outstanding, 0);
  assert.equal(listenerAdds, 1);
  assert.equal(listenerRemoves, 1);
});

test("candidate-zero observer cancellation launches no raw read", async () => {
  const controller = new AbortController();
  let reads = 0;
  const result = await acquireProjectSources(REPOSITORY, SHA40, controller.signal, {
    async loadInventory() { return { kind: "inventory", entries: [regular("a.ts")] }; },
    async readRawSource() { reads += 1; return rawSource("a"); },
  }, (ownership) => {
    if (ownership.phase === "provider-candidate") controller.abort();
  });
  assert.deepEqual(result, { kind: "cancelled" });
  assert.equal(reads, 0);
});

test("current cancellation during inventory, JSON-equivalent completion, candidate read, hash wait, and between requests wins", async () => {
  for (const phase of ["inventory", "json", "read", "hash", "between"]) {
    const controller = new AbortController();
    let reads = 0;
    const fixture = {
      async loadInventory() {
        if (phase === "inventory") {
          await new Promise((resolve) => controller.signal.addEventListener("abort", resolve, { once: true }));
          return { kind: "provider-failure" };
        }
        if (phase === "json") controller.abort();
        return { kind: "inventory", entries: [regular("a.ts"), regular("b.ts")] };
      },
      async readSource() {
        reads += 1;
        if ((phase === "read" || phase === "hash") && reads === 1) {
          await new Promise((resolve) => controller.signal.addEventListener("abort", resolve, { once: true }));
          return { kind: "provider-failure" };
        }
        if (phase === "between" && reads === 1) controller.abort();
        return { kind: "source", decodedSource: "" };
      },
    };
    const pending = retrieveAdmittedSources(REPOSITORY, SHA40, controller.signal, fixture);
    if (["inventory", "read", "hash"].includes(phase)) controller.abort();
    assert.deepEqual(await pending, { kind: "cancelled" }, phase);
    if (phase === "between") assert.equal(reads, 1);
  }
});
