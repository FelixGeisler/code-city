import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(/^\.\.?\//.test(specifier) && !/\.[a-z]+$/i.test(specifier) ? `${specifier}.ts` : specifier, context);
  },
});

const { retrieveAdmittedSources } = await import("../src/application/source-retrieval.ts");

const REPOSITORY = { owner: "owner", repository: "repo" };
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
