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
