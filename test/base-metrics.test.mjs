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
const { createSyntaxObservationWriter, deriveBaseMetricAnalysis } = await import("../src/domain/base-metrics.ts");
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

function materializeAnalysis(analysis) {
  return { canonicalPath: analysis.canonicalPath, S: analysis.S, U: analysis.U, units: [...analysis.units], observations: [...analysis.observations] };
}

function endpointParser(startIndex, endIndex, events = [], copies = 1) {
  const rootNode = {
    hasError: false,
    walk() {
      let index = 0;
      return {
        get nodeType() { return "comment"; }, get nodeIsNamed() { return true; }, get nodeIsMissing() { return false; }, get currentFieldName() { return null; }, get startIndex() { return startIndex; }, get endIndex() { return endIndex; },
        gotoFirstChild: () => false, gotoNextSibling() { if (index + 1 >= copies) return false; index += 1; return true; }, gotoParent: () => false, delete() {},
      };
    },
  };
  class FakeParser {
    static async init() {}
    setLanguage() {}
    parse() { return { rootNode, delete() {} }; }
    delete() {}
  }
  return createTreeSitterAdapter({ runtimeJavaScript: "runtime.js", runtimeWasm: "runtime.wasm", grammarJavaScript: "javascript.wasm", grammarTypeScript: "typescript.wasm", grammarTsx: "tsx.wasm" }, {
    importRuntime: async () => ({ Parser: FakeParser, Language: { load: async () => ({}) } }),
    loadBytes: async () => new Uint8Array(),
    observeResource: (event) => events.push(event),
  });
}

const REQUIRED_CASE_IDS = [
  "node-js-function", "node-jsx-comment", "node-ts-type-only", "node-tsx-value",
  "suffix-js", "suffix-mjs", "suffix-cjs", "suffix-jsx", "suffix-ts", "suffix-mts", "suffix-cts", "suffix-tsx",
  "suffix-case-js", "suffix-case-mjs", "suffix-case-cjs", "suffix-case-jsx", "suffix-case-ts", "suffix-case-mts", "suffix-case-cts", "suffix-case-tsx",
  "sloc-empty", "sloc-whitespace", "sloc-line-comment", "sloc-block-comment", "sloc-jsdoc", "sloc-triple-slash", "sloc-hashbang", "sloc-leading-comment", "sloc-trailing-comment", "sloc-embedded-comment", "sloc-string-comment-text", "sloc-template-comment-text", "sloc-regex-comment-text", "sloc-template-blank-lines", "sloc-jsx-text-comment-looking", "sloc-jsx-blank-lines", "sloc-jsx-comment-wrapper", "sloc-typescript-source",
  "unit-function-declaration", "unit-function-expression", "unit-generator-function", "unit-async-function", "unit-exported-function", "unit-arrow-concise-unparenthesized", "unit-arrow-block", "unit-async-arrow", "unit-object-method", "unit-class-method", "unit-constructor", "unit-getter", "unit-setter", "unit-static-block", "unit-modifiers", "unit-decorator-span", "unit-computed-name", "unit-field-arrow", "unit-field-function", "unit-nested-order",
  "bodyless-overload", "bodyless-declare-function", "bodyless-ambient-class", "bodyless-abstract-method", "bodyless-interface-method", "bodyless-implicit-constructor", "ambient-enum", "ambient-namespace", "ambient-nested-runtime-shapes",
  "top-level-empty-statement", "top-level-function", "top-level-value", "top-level-type-only", "top-level-import-type", "top-level-export-type", "top-level-import-all-type-trivia", "top-level-export-all-type-trivia", "top-level-import-mixed", "top-level-export-mixed", "top-level-side-effect-import", "top-level-export-empty", "top-level-export-empty-trivia", "top-level-export-local-value", "top-level-export-empty-reexport", "top-level-export-value-reexport", "top-level-runtime-enum", "top-level-runtime-namespace", "top-level-ambient", "top-level-jsx", "top-level-type-and-value-mixed",
  "decisions-all", "decisions-exclusions", "canonical-src-a", "ownership-parameter-and-nested", "ownership-field-and-computed", "identity-order-astral", "identity-order-same-start-nesting",
  "contextual-top-return", "contextual-top-break", "contextual-top-continue", "contextual-import-defer-rejected",
  "malformed-javascript", "malformed-jsx", "malformed-typescript", "malformed-tsx", "missing-recovery", "forbidden-jsx-js", "typescript-in-javascript", "nonfailure-type-diagnostic", "nonfailure-unresolved-import", "nonexecution-sentinel",
];

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
  assert.deepEqual(fixture.cases.map((entry) => entry.id), REQUIRED_CASE_IDS);
});

test("all table cases traverse the production adapter, domain, and application path with pinned actual WASM", async () => {
  const events = [];
  delete globalThis.__codeCitySentinel;
  const parser = createTreeSitterAdapter(assets, { loadBytes: bytesFromFileUrl, observeResource: (event) => events.push(event) });
  for (const entry of fixture.cases) {
    const before = events.length;
    const sourceEvents = [];
    const result = await processAdmittedBaseMetrics([
      { canonicalPath: entry.canonicalPath, normalizedSource: entry.source },
    ], parser, (event) => sourceEvents.push(event));
    if (entry.expectedOutcome.kind === "failure") {
      assert.deepEqual(result, entry.expectedOutcome, entry.id);
      assert.deepEqual(sourceEvents, ["source-acquired", "source-released"], entry.id);
      assert.equal(events.slice(before).filter((event) => event === "observation-stream-created").length, 0, entry.id);
    } else {
      assert.equal(result.kind, "processed", entry.id);
      assert.deepEqual(result.analyses.map(materializeAnalysis), [expectedAnalysis(entry)], entry.id);
      assert.deepEqual(sourceEvents, ["source-acquired", "analysis-retained", "source-released"], entry.id);
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
      if (entry.id === "nonexecution-sentinel") {
        assert.equal(globalThis.__codeCitySentinel, undefined);
        assert.equal(events.slice(before).filter((event) => event === "parser-created").length, 1, "sentinel reparsed");
      }
    }
  }
  assert.equal(globalThis.__codeCitySentinel, undefined);
});

test("actual WASM accepts duplicate projected endpoints followed by trailing comment and trivia", async () => {
  const parser = createTreeSitterAdapter(assets, { loadBytes: bytesFromFileUrl });
  const source = "function f() {}\n/* 😀 trailing */\n  ";
  const result = await processAdmittedBaseMetrics([{ canonicalPath: "duplicate.js", normalizedSource: source }], parser);
  assert.equal(result.kind, "processed");
  assert.deepEqual(result.analyses.map(materializeAnalysis), [{
    canonicalPath: "duplicate.js",
    S: 1,
    U: 2,
    units: [
      { path: "duplicate.js", kind: "top-level" },
      { path: "duplicate.js", kind: "function", startByte: 0, endByte: 15, ownedRegions: [{ startByte: 10, endByte: 12 }, { startByte: 13, endByte: 15 }] },
    ],
    observations: [
      { kind: "explicit-unit", form: "function", startByte: 0, endByte: 15, ownedRegions: [{ startByte: 10, endByte: 12 }, { startByte: 13, endByte: 15 }] },
      { kind: "value-anchor", valueKind: "explicit-unit-declaration/expression", startByte: 0, endByte: 15 },
      { kind: "lexical-exclusion", startByte: 16, endByte: 35 },
    ],
  }]);
});

test("endpoint dedup bounds conversion to the compacted prefix", async () => {
  const stream = await endpointParser(0, 1, [], 2).project("javascript-no-jsx", "x ");
  assert.deepEqual([...stream.observations], [
    { kind: "lexical-exclusion", startByte: 0, endByte: 1 },
    { kind: "lexical-exclusion", startByte: 0, endByte: 1 },
  ]);
  stream.release();
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
  assert.equal(events.filter((event) => event === "source-acquired").length, 2);
  assert.equal(events.filter((event) => event === "source-released").length, 3);
  assert.equal(events.filter((event) => event === "observation-stream-released").length, 1);
  assert.equal(events.filter((event) => event === "parser-deleted").length, 2);
});

test("domain validation rejects duplicate/range/order defects and canonicalizes observation-order permutations", () => {
  const source = "function f(){}";
  const duplicate = createSyntaxObservationWriter();
  duplicate.appendExplicit("function", 0, 14, Uint32Array.of(10, 12), Uint32Array.of(12, 14));
  duplicate.appendExplicit("function", 0, 14, Uint32Array.of(10, 12), Uint32Array.of(12, 14));
  assert.throws(() => deriveBaseMetricAnalysis("a.js", source, duplicate.finish()), /Duplicate/);
  const invalid = createSyntaxObservationWriter(); invalid.appendLexical(0, 99);
  assert.throws(() => deriveBaseMetricAnalysis("a.js", source, invalid.finish()), /Invalid/);
  const reordered = createSyntaxObservationWriter(); reordered.appendValue("runtime-statement/declaration", 5, 6); reordered.appendValue("runtime-statement/declaration", 0, 1);
  assert.throws(() => deriveBaseMetricAnalysis("a.js", source, reordered.finish()), /source ordered/);
  const wrongKindOrder = createSyntaxObservationWriter(); wrongKindOrder.appendValue("explicit-unit-declaration/expression", 0, 14); wrongKindOrder.appendExplicit("function", 0, 14, Uint32Array.of(10, 12), Uint32Array.of(12, 14));
  assert.throws(() => deriveBaseMetricAnalysis("a.js", source, wrongKindOrder.finish()), /source ordered/);
  const canonical = createSyntaxObservationWriter(); canonical.appendExplicit("function", 0, 14, Uint32Array.of(10, 12), Uint32Array.of(12, 14)); canonical.appendValue("explicit-unit-declaration/expression", 0, 14);
  const analysis = deriveBaseMetricAnalysis("a.js", source, canonical.finish());
  assert.deepEqual([...analysis.units].map(({ kind, startByte, endByte }) => ({ kind, startByte, endByte })), [{ kind: "top-level", startByte: undefined, endByte: undefined }, { kind: "function", startByte: 0, endByte: 14 }]);
});

test("independent zero-unit, mixed-list, contextual, and arrow-owned-region decisions are pinned", () => {
  const byId = new Map(fixture.cases.map((entry) => [entry.id, entry]));
  for (const id of ["ambient-enum", "ambient-namespace", "ambient-nested-runtime-shapes", "bodyless-declare-function", "bodyless-ambient-class", "top-level-ambient"]) {
    const expected = byId.get(id).expectedOutcome;
    assert.equal(expected.kind, "processed", id); assert.equal(expected.U, 0, id); assert.deepEqual(expected.units, [], id);
    assert.deepEqual(expected.observations.map((observation) => observation.kind), ["type-only"], id);
  }
  for (const id of ["top-level-import-all-type-trivia", "top-level-export-all-type-trivia"]) {
    const expected = byId.get(id).expectedOutcome;
    assert.equal(expected.U, 0, id); assert.deepEqual(expected.units, [], id);
    assert.equal(expected.observations[0].typeKind, "import/export lists all specifiers type-only", id);
  }
  for (const id of ["top-level-import-mixed", "top-level-export-mixed"]) {
    const expected = byId.get(id).expectedOutcome;
    assert.equal(expected.U, 1, id); assert.deepEqual(expected.units, [{ path: "t.ts", kind: "top-level" }], id);
    assert.equal(expected.observations[0].valueKind, "value-or-side-effect-import-export", id);
  }
  for (const id of ["top-level-export-empty", "top-level-export-empty-trivia"]) {
    const expected = byId.get(id).expectedOutcome;
    assert.equal(expected.U, 0, id); assert.deepEqual(expected.units, [], id);
    assert.equal(expected.observations[0].typeKind, "exact export{}", id);
  }
  for (const id of ["top-level-export-local-value", "top-level-export-empty-reexport", "top-level-export-value-reexport"]) {
    const expected = byId.get(id).expectedOutcome;
    assert.equal(expected.U, 1, id); assert.deepEqual(expected.units, [{ path: "t.ts", kind: "top-level" }], id);
    assert.equal(expected.observations[0].valueKind, "value-or-side-effect-import-export", id);
  }
  assert.deepEqual(byId.get("unit-arrow-concise-unparenthesized").expectedOutcome.units, [
    { path: "u.js", kind: "top-level" },
    { path: "u.js", kind: "arrow", startByte: 10, endByte: 16, ownedRegions: [{ startByte: 10, endByte: 11 }, { startByte: 15, endByte: 16 }] },
  ]);
  const canonical = byId.get("canonical-src-a").expectedOutcome;
  assert.equal(canonical.S, 4); assert.equal(canonical.U, 3);
  assert.deepEqual(canonical.units.map(({ path, kind, startByte, endByte }) => ({ path, kind, ...(startByte === undefined ? {} : { startByte, endByte }) })), [
    { path: "src/a.js", kind: "top-level" }, { path: "src/a.js", kind: "function", startByte: 0, endByte: 68 }, { path: "src/a.js", kind: "arrow", startByte: 41, endByte: 53 },
  ]);
  assert.equal(byId.get("decisions-all").expectedOutcome.observations.filter((observation) => observation.kind === "decision").length, 17);
  for (const id of ["contextual-top-return", "contextual-top-break", "contextual-top-continue"]) assert.equal(byId.get(id).expectedOutcome.U, 1, id);
  assert.deepEqual(byId.get("contextual-import-defer-rejected").expectedOutcome, { kind: "failure", category: "Metric processing failed", code: "M1-MET-1" });
});

test("dense full-envelope actual-WASM processing retains compact facts with one live resource of each kind", async () => {
  const live = { parser: 0, tree: 0, cursor: 0, source: 0, stream: 0 };
  const peak = { ...live };
  const cleanup = { parser: 0, tree: 0, cursor: 0, source: 0, stream: 0 };
  const resource = {
    "parser-created": ["parser", 1], "parser-deleted": ["parser", -1],
    "tree-created": ["tree", 1], "tree-deleted": ["tree", -1],
    "cursor-created": ["cursor", 1], "cursor-deleted": ["cursor", -1],
    "observation-stream-created": ["stream", 1], "observation-stream-released": ["stream", -1],
  };
  const parser = createTreeSitterAdapter(assets, { loadBytes: bytesFromFileUrl, observeResource(event) {
    const [kind, delta] = resource[event]; live[kind] += delta; assert(live[kind] >= 0, event); peak[kind] = Math.max(peak[kind], live[kind]); if (delta < 0) cleanup[kind] += 1;
  } });
  const dense = ";".repeat(2_097_152);
  const modules = Array.from({ length: 4_000 }, (_, index) => ({ canonicalPath: `dense/${String(index).padStart(4, "0")}.${["js", "jsx", "ts", "tsx"][index % 4]}`, normalizedSource: index < 20 ? dense : "" }));
  const normalizedBytes = modules.reduce((total, module) => total + Buffer.byteLength(module.normalizedSource), 0);
  const result = await processAdmittedBaseMetrics(modules, parser, (event) => {
    if (event === "source-acquired") { live.source += 1; peak.source = Math.max(peak.source, live.source); }
    if (event === "source-released") { live.source -= 1; cleanup.source += 1; assert(live.source >= 0); }
  });
  assert.equal(result.kind, "processed");
  assert.equal(normalizedBytes, 41_943_040);
  assert.equal(result.analyses.length, 4_000);
  assert.equal(result.analyses.slice(0, 20).reduce((total, analysis) => total + analysis.observations.length, 0), 41_943_040);
  assert(result.analyses.slice(0, 20).every((analysis) => analysis.S === 1 && analysis.U === 1 && analysis.units.at(0).kind === "top-level"));
  assert(result.analyses.slice(0, 20).every((analysis) => analysis.observations.packedByteLength() <= 64 && analysis.units.packedByteLength() === 0));
  assert(result.analyses.slice(20).every((analysis) => analysis.S === 0 && analysis.U === 0 && analysis.observations.length === 0));
  assert.deepEqual(peak, { parser: 1, tree: 1, cursor: 1, source: 1, stream: 1 });
  assert.deepEqual(live, { parser: 0, tree: 0, cursor: 0, source: 0, stream: 0 });
  assert.deepEqual(cleanup, { parser: 4_000, tree: 4_000, cursor: 8_000, source: 4_000, stream: 4_000 });
});

test("UTF-16 endpoint conversion rejects split, range, and malformed scalar defects atomically", async () => {
  const cases = [
    { id: "split-start", source: "😀x", start: 1, end: 3 },
    { id: "split-end", source: "😀x", start: 0, end: 1 },
    { id: "past-end", source: "😀x", start: 0, end: 4 },
    { id: "malformed-high-surrogate", source: "\ud800x", start: 0, end: 2 },
    { id: "malformed-low-surrogate", source: "\udc00x", start: 0, end: 2 },
  ];
  for (const entry of cases) {
    const resourceEvents = [], sourceEvents = [];
    const result = await processAdmittedBaseMetrics([{ canonicalPath: "a.js", normalizedSource: entry.source }], endpointParser(entry.start, entry.end, resourceEvents), (event) => sourceEvents.push(event));
    assert.deepEqual(result, { kind: "failure", category: "Metric processing failed", code: "M1-MET-1" }, entry.id);
    assert.deepEqual(sourceEvents, ["source-acquired", "source-released"], entry.id);
    assert.equal(resourceEvents.filter((event) => event === "observation-stream-created").length, 0, entry.id);
    assert.equal(resourceEvents.filter((event) => event === "cursor-deleted").length, 2, entry.id);
    assert.equal(resourceEvents.filter((event) => event === "tree-deleted").length, 1, entry.id);
    assert.equal(resourceEvents.filter((event) => event === "parser-deleted").length, 1, entry.id);
  }
});

test("UTF-16 endpoint conversion scans astral source without indexing unrelated scalars", async () => {
  const parser = endpointParser(1, 3);
  await parser.initialize();
  const astral = await parser.project("javascript-no-jsx", "a😀b");
  assert.deepEqual([...astral.observations], [{ kind: "lexical-exclusion", startByte: 1, endByte: 5 }]);
  astral.release();

  const unrelatedSource = `x${"😀".repeat(1_000_000)}`;
  const unrelated = await endpointParser(0, 1).project("javascript-no-jsx", unrelatedSource);
  assert.deepEqual([...unrelated.observations], [{ kind: "lexical-exclusion", startByte: 0, endByte: 1 }]);
  assert(unrelated.observations.packedByteLength() < 64);
  unrelated.release();
});

test("production parser source uses only the approved iterative cursor surface", async () => {
  const source = await readFile(path.join(projectRoot, "src", "edge", "tree-sitter-adapter.ts"), "utf8");
  for (const forbidden of [
    ".children", ".namedChildren", ".child(", ".parent", ".text", ".toString(", "QueryCursor", "new Query", ".setLogger", "progressCallback", "oldTree", "astralEnds", "astralExtras",
  ]) assert(!source.includes(forbidden), `Forbidden parser API token ${forbidden}`);
  assert.equal((source.match(/\.parse\(normalizedSource\)/g) ?? []).length, 1);
  assert.doesNotMatch(source, /function\s+\w+\([^)]*\)\s*\{[^{}]*\b\1\s*\(/s);
});
