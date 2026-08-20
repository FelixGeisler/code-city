import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(/^\.\.?\//.test(specifier) && !/(?:\.[a-z]+|\?.*)$/i.test(specifier) ? `${specifier}.ts` : specifier, context);
  },
});

const projectRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const { createTreeSitterAdapter } = await import("../src/edge/tree-sitter-adapter.ts");
const { processAdmittedBaseMetrics } = await import("../src/application/base-metric-processing.ts");
const { deriveBaseMetricAnalysis } = await import("../src/domain/base-metrics.ts");
const fixture = JSON.parse(await readFile(path.join(projectRoot, "test", "fixtures", "base-metric-cases.json"), "utf8"));

const assetPath = (relativePath) => pathToFileURL(path.join(projectRoot, ...relativePath.split("/"))).href;
const assets = {
  runtimeJavaScript: assetPath("node_modules/web-tree-sitter/web-tree-sitter.js"),
  runtimeWasm: assetPath("node_modules/web-tree-sitter/web-tree-sitter.wasm"),
  grammarJavaScript: assetPath("node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-javascript.wasm"),
  grammarTypeScript: assetPath("node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-typescript.wasm"),
  grammarTsx: assetPath("node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-tsx.wasm"),
};
const bytesFromFileUrl = async (url) => new Uint8Array(await readFile(fileURLToPath(url)));

function exactKeys(value, keys) {
  assert(value && typeof value === "object" && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
}

function expectedAnalysis(entry) {
  const { S, U, units, observations } = entry.expectedOutcome;
  return { canonicalPath: entry.canonicalPath, S, U, units, observations };
}

test("the single base-metric table fixture has a closed schema and complete required inventory", () => {
  exactKeys(fixture, ["schemaVersion", "cases"]);
  assert.equal(fixture.schemaVersion, 1);
  assert(Array.isArray(fixture.cases));
  assert.equal(new Set(fixture.cases.map((entry) => entry.id)).size, fixture.cases.length);
  for (const entry of fixture.cases) {
    exactKeys(entry, ["id", "canonicalPath", "source", "grammarFamily", "expectedOutcome"]);
    assert.equal(typeof entry.id, "string");
    assert.equal(typeof entry.canonicalPath, "string");
    assert.equal(typeof entry.source, "string");
    assert(["javascript-no-jsx", "javascript-jsx", "typescript", "tsx"].includes(entry.grammarFamily));
    if (entry.expectedOutcome.kind === "failure") {
      exactKeys(entry.expectedOutcome, ["kind", "category", "code"]);
      assert.deepEqual(entry.expectedOutcome, { kind: "failure", category: "Metric processing failed", code: "M1-MET-1" });
    } else {
      exactKeys(entry.expectedOutcome, ["kind", "S", "U", "units", "observations", "digest"]);
      const expected = {
        S: entry.expectedOutcome.S,
        U: entry.expectedOutcome.U,
        units: entry.expectedOutcome.units,
        observations: entry.expectedOutcome.observations,
      };
      assert.equal(createHash("sha256").update(JSON.stringify(expected)).digest("hex"), entry.expectedOutcome.digest);
      assert.equal(entry.expectedOutcome.U, entry.expectedOutcome.units.length);
    }
  }
  const ids = new Set(fixture.cases.map((entry) => entry.id));
  for (const required of [
    "node-js-function", "node-jsx-comment", "node-ts-type-only", "node-tsx-value",
    "suffix-mjs", "suffix-cjs", "suffix-mts", "suffix-cts", "suffix-ascii-case",
    "all-explicit-forms", "nested-unit-order", "astral-offsets", "missing-recovery", "forbidden-jsx-js",
  ]) assert(ids.has(required), `Missing required fixture ${required}`);
});

test("all table cases traverse the production adapter, domain, and application path with pinned actual WASM", async () => {
  const events = [];
  const parser = createTreeSitterAdapter(assets, { loadBytes: bytesFromFileUrl, observeResource: (event) => events.push(event) });
  for (const entry of fixture.cases) {
    const before = events.length;
    const sourceEvents = [];
    const result = await processAdmittedBaseMetrics([
      { canonicalPath: entry.canonicalPath, normalizedSource: entry.source },
    ], parser, (event) => sourceEvents.push(event));
    if (entry.expectedOutcome.kind === "failure") {
      assert.deepEqual(result, entry.expectedOutcome, entry.id);
      assert.deepEqual(sourceEvents, ["source-released"], entry.id);
      assert.equal(events.slice(before).filter((event) => event === "observation-stream-created").length, 0, entry.id);
    } else {
      assert.equal(result.kind, "processed", entry.id);
      assert.deepEqual(result.analyses, [expectedAnalysis(entry)], entry.id);
      assert.deepEqual(sourceEvents, ["analysis-retained", "source-released"], entry.id);
      assert.deepEqual(Object.fromEntries([
        "parser-created", "parser-deleted", "tree-created", "tree-deleted",
        "cursor-created", "cursor-deleted", "observation-stream-created", "observation-stream-released",
      ].map((name) => [name, events.slice(before).filter((event) => event === name).length])), {
        "parser-created": 1,
        "parser-deleted": 1,
        "tree-created": 1,
        "tree-deleted": 1,
        "cursor-created": 2,
        "cursor-deleted": 2,
        "observation-stream-created": 1,
        "observation-stream-released": 1,
      }, entry.id);
      assert.equal(Object.hasOwn(result.analyses[0], "normalizedSource"), false, `Source retained for ${entry.id}`);
    }
  }
});

test("initialization failures release all three admitted sources before one atomic M1-MET-1 result", async () => {
  for (const injected of [
    "runtime-import", "Parser.init/runtime-WASM", "JS grammar load", "TS grammar load", "TSX grammar load",
  ]) {
    const order = [];
    const result = await processAdmittedBaseMetrics([
      { canonicalPath: "a.js", normalizedSource: "" },
      { canonicalPath: "b.ts", normalizedSource: "" },
      { canonicalPath: "c.tsx", normalizedSource: "" },
    ], {
      async initialize() { order.push(`failure:${injected}`); throw new Error(injected); },
      async project() { order.push("parser-created"); throw new Error("must not parse"); },
    }, (event) => order.push(event));
    assert.deepEqual(result, { kind: "failure", category: "Metric processing failed", code: "M1-MET-1" });
    assert.deepEqual(order, [`failure:${injected}`, "source-released", "source-released", "source-released"]);
  }
});

test("a later module failure discards complete earlier facts and releases every source and stream", async () => {
  const entry = fixture.cases.find((candidate) => candidate.id === "node-js-function");
  const malformed = fixture.cases.find((candidate) => candidate.id === "malformed-typescript");
  const events = [];
  const parser = createTreeSitterAdapter(assets, { loadBytes: bytesFromFileUrl, observeResource: (event) => events.push(event) });
  const result = await processAdmittedBaseMetrics([
    { canonicalPath: entry.canonicalPath, normalizedSource: entry.source },
    { canonicalPath: malformed.canonicalPath, normalizedSource: malformed.source },
    { canonicalPath: "c.tsx", normalizedSource: "" },
  ], parser, (event) => events.push(event));
  assert.deepEqual(result, { kind: "failure", category: "Metric processing failed", code: "M1-MET-1" });
  assert.equal(events.filter((event) => event === "source-released").length, 3);
  assert.equal(events.filter((event) => event === "observation-stream-released").length, 1);
  assert.equal(events.filter((event) => event === "parser-deleted").length, 2);
});

test("domain validation rejects duplicate identities, invalid ranges, and reordered observations atomically", () => {
  const source = "function f(){}";
  const unit = {
    kind: "explicit-unit",
    form: "function",
    startByte: 0,
    endByte: 14,
    ownedRegions: [{ startByte: 10, endByte: 12 }, { startByte: 12, endByte: 14 }],
  };
  assert.throws(() => deriveBaseMetricAnalysis("a.js", source, [unit, unit]), /Duplicate/);
  assert.throws(() => deriveBaseMetricAnalysis("a.js", source, [{ kind: "lexical-exclusion", startByte: 0, endByte: 99 }]), /Invalid/);
  assert.throws(() => deriveBaseMetricAnalysis("a.js", source, [
    { kind: "value-anchor", valueKind: "runtime-statement/declaration", startByte: 5, endByte: 6 },
    { kind: "value-anchor", valueKind: "runtime-statement/declaration", startByte: 0, endByte: 1 },
  ]), /source ordered/);
});

test("production parser source uses only the approved iterative cursor surface", async () => {
  const source = await readFile(path.join(projectRoot, "src", "edge", "tree-sitter-adapter.ts"), "utf8");
  for (const forbidden of [
    ".children", ".namedChildren", ".child(", ".parent", ".text", ".toString(", "QueryCursor", "new Query", ".setLogger", "progressCallback", "oldTree",
  ]) assert(!source.includes(forbidden), `Forbidden parser API token ${forbidden}`);
  assert.equal((source.match(/\.parse\(normalizedSource\)/g) ?? []).length, 1);
  assert.doesNotMatch(source, /function\s+\w+\([^)]*\)\s*\{[^{}]*\b\1\s*\(/s);
});
