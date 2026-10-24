import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CSHARP_CANDIDATE,
  createCSharpQualifier,
  createExactStressModule,
  verifyCSharpCandidate,
} from "../tools/qualify-csharp-grammar.mjs";

registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(/^\.\.?\//.test(specifier) && !/(?:\.[a-z]+|\?.*)$/i.test(specifier) ? `${specifier}.ts` : specifier, context);
  },
});

const projectRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const fixture = JSON.parse(await readFile(path.join(projectRoot, "test", "fixtures", "csharp-qualification-cases.json"), "utf8"));
const initialized = await verifyCSharpCandidate(projectRoot);
const { createTreeSitterAdapter } = await import("../src/edge/tree-sitter-adapter.ts");
const { deriveBaseMetricAnalysis } = await import("../src/domain/base-metrics.ts");
const { finalizeModuleComplexity } = await import("../src/domain/complexity.ts");
const { processAdmittedBaseMetrics } = await import("../src/application/base-metric-processing.ts");
const { createWorkerAttemptPipeline } = await import("../src/application/worker-attempt.ts");
const assetUrl = (relativePath) => pathToFileURL(path.join(projectRoot, ...relativePath.split("/"))).href;
const adapterAssets = {
  runtimeJavaScript: assetUrl("node_modules/web-tree-sitter/web-tree-sitter.js"),
  runtimeWasm: assetUrl("node_modules/web-tree-sitter/web-tree-sitter.wasm"),
  grammarJavaScript: assetUrl("node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-javascript.wasm"),
  grammarTypeScript: assetUrl("vendor/tree-sitter-typescript/wasm/tree-sitter-typescript.wasm"),
  grammarTsx: assetUrl("vendor/tree-sitter-typescript/wasm/tree-sitter-tsx.wasm"),
  grammarCSharp: assetUrl(CSHARP_CANDIDATE.asset.path),
};
const bytesFromFileUrl = async (url) => new Uint8Array(await readFile(fileURLToPath(url)));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const occurrences = (source, token) => source.split(token).length - 1;

const REQUIRED_CASES = [
  "empty-file-zero-units",
  "comment-only-zero-units",
  "declaration-only-zero-units",
  "lexical-directives-and-branches",
  "all-explicit-and-zero-unit-forms",
  "initialization-and-nested-ownership",
  "excluded-syntax-in-callables",
  "excluded-syntax-in-initialization",
  "initializer-range-ownership",
  "preprocessor-condition-and-branch-ownership",
  "foreach-forms",
  "decision-points",
  "switch-guards-filters-and-defaults",
  "zero-point-and-zero-unit-syntax",
  "unicode-whitespace-lines",
  "representative-modern-syntax",
  "malformed-error",
  "truncated-missing",
  "recovery-error",
];
const REQUIRED_COVERAGE = [
  "abstract-zero", "accessor-add", "accessor-get", "accessor-init", "accessor-remove", "accessor-set", "anonymous-method", "attribute-zero", "auto-accessor-zero", "bitwise-zero", "bodyless-zero", "calls-zero", "case-label", "catch", "catch-filter", "comments", "comparisons-zero", "conditional", "conditional-access-zero", "const-zero", "constructor", "constructor-base", "conversion", "default-statement-zero", "destructor", "directives-source", "else-zero", "enum-zero", "error-signal", "excluded-attribute-nesting", "excluded-const-in-callable", "excluded-const-in-initialization", "excluded-enum-value-nesting", "excluded-parameter-default-nesting", "expression-indexer", "expression-property", "extern-zero", "finally-zero", "guarded-discard", "if", "initializer-body-ownership", "interpolated-string", "lambda", "local-function", "logical-and", "logical-or", "loop-do", "loop-for", "loop-foreach", "loop-foreach-deconstruction", "loop-foreach-ordinary", "loop-foreach-ref", "loop-while", "malformed", "method", "missing-signal", "modern-collection-expression", "modern-list-pattern", "modern-raw-string", "modern-record", "modern-required", "nested-callable", "nullish", "nullish-assign", "operator", "parameter-default-zero", "patterns-zero", "preprocessor-all-branches", "preprocessor-condition-zero", "preprocessor-top-level-branches", "primary-base", "primary-header-zero", "query-zero", "raw-string", "recovery", "regular-string", "runtime-event-initializer", "runtime-field-initializer", "runtime-property-initializer", "runtime-property-initializer-decision", "signature-zero", "switch-expression-arm", "switch-expression-default-zero", "switch-guard", "switch-zero", "top-level", "top-level-block-const-exclusion", "truncated", "try-zero", "unicode-white-space", "verbatim-string", "empty-file-zero-units", "comment-only-zero-units", "declaration-only-zero-units",
];
const FIXTURE_NON_ASCII_WHITE_SPACE = ["\u00a0", "\u3000"];

function assertResourceClosure(events, valid) {
  const counts = Object.fromEntries([...new Set(events)].map((event) => [event, events.filter((candidate) => candidate === event).length]));
  assert.equal(counts["source-acquired"], 1);
  assert.equal(counts["source-released"], 1);
  assert.equal(counts["parser-created"], 1);
  assert.equal(counts["parser-deleted"], 1);
  assert.equal(counts["tree-created"], 1);
  assert.equal(counts["tree-deleted"], 1);
  assert.equal(counts["cursor-created"], valid ? 2 : 1);
  assert.equal(counts["cursor-deleted"], valid ? 2 : 1);
  assert.equal(counts["observation-created"] ?? 0, valid ? 1 : 0);
  assert.equal(counts["observation-released"] ?? 0, valid ? 1 : 0);
}

test("the existing packaged C# candidate has immutable provenance, licence, ABI, inventory, and direct-load evidence", async () => {
  assert.equal(Object.isFrozen(CSHARP_CANDIDATE), true);
  assert.equal(CSHARP_CANDIDATE.sourceGrammar.license.productionNoticeRequiredOnAdmission, true);
  assert.equal(initialized.language.abiVersion, 15);
  assert.deepEqual(CSHARP_CANDIDATE.dylink, {
    memorySize: 5_013_132,
    memoryAlign: 4,
    tableSize: 7,
    tableAlign: 0,
    neededLibraries: [],
    subsectionTypes: [1],
  });
  assert.match(CSHARP_CANDIDATE.renewalRule, /requires renewed C# grammar qualification/u);
  const qualificationSource = await readFile(path.join(projectRoot, "tools", "qualify-csharp-grammar.mjs"), "utf8");
  for (const forbidden of [".children", ".namedChildren", ".child(", ".namedChild(", ".text", "QueryCursor", "new Query"]) assert(!qualificationSource.includes(forbidden), forbidden);
  for (const required of ["root.walk()", "cursor.gotoFirstChild()", "cursor.gotoNextSibling()", "cursor.gotoParent()", "cursor.delete()", "tree.delete()", "parser.delete()"]) assert(qualificationSource.includes(required), required);

  const events = [];
  const result = await createCSharpQualifier(initialized, { observeResource: (event) => events.push(event) }).qualify("class DirectLoad { int M() => 1; }");
  assert.equal(result.valid, true);
  assert.equal(result.U, 1);
  assertResourceClosure(events, true);
});

test("the closed C# fixture table pins validity, concrete shape, source lines, units, ownership, decisions, U, and M", async () => {
  assert.deepEqual(Object.keys(fixture), ["schemaVersion", "cases"]);
  assert.equal(fixture.schemaVersion, 1);
  assert.deepEqual(fixture.cases.map((entry) => entry.id), REQUIRED_CASES);
  assert.equal(new Set(fixture.cases.map((entry) => entry.id)).size, fixture.cases.length);
  assert.deepEqual([...new Set(fixture.cases.flatMap((entry) => entry.coverage))].sort(), [...REQUIRED_COVERAGE].sort());

  for (const entry of fixture.cases) {
    assert.deepEqual(Object.keys(entry), ["id", "source", "coverage", "expected"]);
    assert.equal(typeof entry.source, "string", entry.id);
    assert(entry.source.isWellFormed(), entry.id);
    assert(Array.isArray(entry.coverage) && entry.coverage.length > 0, entry.id);
    const events = [];
    const actual = await createCSharpQualifier(initialized, { observeResource: (event) => events.push(event) }).qualify(entry.source);
    assert.deepEqual(actual, entry.expected, entry.id);
    assertResourceClosure(events, entry.expected.valid);
    if (entry.expected.valid) {
      assert.match(entry.expected.shapeDigest, /^[0-9a-f]{64}$/u, entry.id);
      assert.equal(entry.expected.U, entry.expected.units.length, entry.id);
      assert.equal(entry.expected.M, entry.expected.units.length === 0 ? 0 : Math.max(...entry.expected.units.map((unit) => unit.complexity)), entry.id);
      assert(entry.expected.decisions.every((decision) => entry.expected.units.some((unit) => unit.id === decision.owner)), entry.id);
    }
  }
});

test("the production adapter projects every valid C# fixture through the fixed domain metrics and rejects every invalid fixture", async () => {
  const events = [];
  const loads = [];
  const adapter = createTreeSitterAdapter(adapterAssets, {
    async loadBytes(url) { loads.push(url); return bytesFromFileUrl(url); },
    observeResource: (event) => events.push(event),
  });
  const formForKind = {
    method: "method", destructor: "method", operator: "method", conversion: "method",
    "local-function": "function", "anonymous-method": "function", constructor: "constructor",
    "property-getter": "getter", "indexer-getter": "getter", get: "getter",
    set: "setter", init: "setter", add: "setter", remove: "setter", lambda: "arrow",
  };
  const live = { parser: 0, tree: 0, cursor: 0, stream: 0 };
  const peak = { ...live };
  const deltas = {
    "parser-created": ["parser", 1], "parser-deleted": ["parser", -1],
    "tree-created": ["tree", 1], "tree-deleted": ["tree", -1],
    "cursor-created": ["cursor", 1], "cursor-deleted": ["cursor", -1],
    "observation-stream-created": ["stream", 1], "observation-stream-released": ["stream", -1],
  };
  let consumedEvents = 0;
  for (const entry of fixture.cases) {
    const before = events.length;
    if (!entry.expected.valid) {
      await assert.rejects(() => adapter.project("csharp", entry.source), /Syntax validation failed/u, entry.id);
      assert.deepEqual(events.slice(before), ["parser-created", "tree-created", "cursor-created", "cursor-deleted", "tree-deleted", "parser-deleted"], entry.id);
      continue;
    }
    const stream = await adapter.project("csharp", entry.source);
    const base = deriveBaseMetricAnalysis("fixture.js", entry.source, stream.observations);
    const finalized = finalizeModuleComplexity(base);
    assert.deepEqual({ S: base.S, U: base.U, M: finalized.fact.M }, { S: entry.expected.S, U: entry.expected.U, M: entry.expected.M }, entry.id);
    assert.deepEqual(Array.from(finalized.perUnitComplexities), entry.expected.units.map((unit) => unit.complexity), `${entry.id} per-owner complexity`);
    assert.deepEqual([...base.units].map((unit) => unit.kind), entry.expected.units.map((unit) => unit.kind === "initialization/top-level" ? "top-level" : formForKind[unit.kind]), `${entry.id} transport forms`);
    for (const observation of stream.observations) {
      const common = ["kind", "startByte", "endByte"];
      const keys = observation.kind === "explicit-unit" ? [...common, "form", "ownedRegions"]
        : observation.kind === "value-anchor" ? [...common, "valueKind"]
        : observation.kind === "decision" ? [...common, "decisionKind"] : common;
      assert.deepEqual(Object.keys(observation).sort(), keys.sort(), `${entry.id} source-free ${observation.kind}`);
    }
    stream.release();
    stream.release();
    assert.deepEqual(events.slice(before), ["parser-created", "tree-created", "cursor-created", "cursor-deleted", "cursor-created", "cursor-deleted", "observation-stream-created", "tree-deleted", "parser-deleted", "observation-stream-released"], entry.id);
  }
  assert.equal(loads.filter((url) => url === adapterAssets.grammarCSharp).length, 1, "candidate language load count");
  assert.deepEqual(loads, [adapterAssets.grammarJavaScript, adapterAssets.grammarTypeScript, adapterAssets.grammarTsx, adapterAssets.grammarCSharp]);
  for (const event of events) {
    const change = deltas[event]; if (!change) continue;
    const [kind, delta] = change; live[kind] += delta; assert(live[kind] >= 0, `${event} after event ${consumedEvents}`); peak[kind] = Math.max(peak[kind], live[kind]); consumedEvents += 1;
  }
  assert.deepEqual(peak, { parser: 1, tree: 1, cursor: 1, stream: 1 });
  assert.deepEqual(live, { parser: 0, tree: 0, cursor: 0, stream: 0 });
});

test("focused C# observations have exact packed payloads, UTF-8 spans, and owned regions", async () => {
  const adapter = createTreeSitterAdapter(adapterAssets, { loadBytes: bytesFromFileUrl });
  const byId = new Map(fixture.cases.map((entry) => [entry.id, entry]));
  const region = (startByte, endByte) => ({ startByte, endByte });
  const unit = (form, startByte, endByte, ownedRegions) => ({ kind: "explicit-unit", form, startByte, endByte, ownedRegions });
  const value = (startByte, endByte) => ({ kind: "value-anchor", valueKind: "runtime-statement/declaration", startByte, endByte });
  const decision = (decisionKind, startByte, endByte) => ({ kind: "decision", decisionKind, startByte, endByte });
  const lexical = (startByte, endByte) => ({ kind: "lexical-exclusion", startByte, endByte });
  const assertPacked = async (id, expected) => {
    const entry = byId.get(id);
    const stream = await adapter.project("csharp", entry.source);
    assert.equal(stream.observations.length, expected.length, `${id} packed length`);
    for (let index = 0; index < expected.length; index += 1) {
      assert.deepEqual(stream.observations.at(index), expected[index], `${id} packed observation ${index}`);
    }
    assert.deepEqual(stream.observations.toJSON(), expected, `${id} packed table`);
    stream.release();
    return entry.source;
  };

  await assertPacked("all-explicit-and-zero-unit-forms", [
    unit("getter", 142, 153, [region(148, 152)]),
    unit("getter", 156, 177, [region(172, 176)]),
    unit("getter", 188, 205, [region(192, 205)]),
    unit("setter", 206, 224, [region(210, 223)]),
    unit("setter", 225, 245, [region(230, 245)]),
    unit("setter", 267, 285, [region(271, 284)]),
    unit("setter", 286, 308, [region(293, 308)]),
    unit("constructor", 313, 332, [region(321, 329), region(330, 332)]),
    unit("method", 335, 346, [region(344, 346)]),
    unit("method", 349, 451, [region(367, 451)]),
    unit("function", 369, 384, [region(382, 384)]),
    unit("arrow", 403, 409, [region(408, 409)]),
    unit("function", 419, 448, [region(435, 448)]),
    unit("method", 454, 508, [region(503, 507)]),
    unit("method", 511, 561, [region(556, 560)]),
  ]);

  await assertPacked("initialization-and-nested-ownership", [
    value(0, 7),
    value(32, 47),
    decision("ternary", 33, 46),
    value(56, 70),
    decision("nullish", 64, 70),
    value(87, 98),
    value(126, 129),
    value(147, 174),
    unit("arrow", 156, 174, [region(161, 174)]),
    decision("ternary", 161, 174),
    unit("constructor", 215, 243, [region(222, 240), region(241, 243)]),
    decision("nullish", 229, 239),
  ]);

  await assertPacked("excluded-syntax-in-callables", [
    unit("method", 29, 325, [region(43, 325)]),
    unit("function", 49, 227, [region(225, 227)]),
  ]);
  await assertPacked("excluded-syntax-in-initialization", [
    value(142, 264),
    unit("arrow", 152, 264, [region(259, 264)]),
  ]);

  await assertPacked("decision-points", [
    unit("method", 20, 264, [region(48, 264)]),
    decision("if", 54, 75),
    decision("loop", 80, 110),
    decision("loop", 115, 147),
    decision("loop", 152, 168),
    decision("loop", 173, 193),
    decision("nullish-assign", 198, 205),
    decision("ternary", 218, 259),
    decision("logical-or", 219, 243),
    decision("logical-and", 219, 233),
    decision("nullish", 248, 254),
  ]);

  await assertPacked("switch-guards-filters-and-defaults", [
    unit("method", 19, 236, [region(32, 236)]),
    decision("case", 51, 76),
    decision("if", 58, 68),
    decision("case", 77, 84),
    decision("case", 85, 99),
    decision("catch", 129, 162),
    decision("if", 147, 159),
    decision("case", 185, 202),
    decision("if", 187, 197),
    decision("case", 204, 221),
    decision("if", 206, 216),
  ]);

  await assertPacked("preprocessor-condition-and-branch-ownership", [
    value(17, 35),
    decision("ternary", 21, 33),
    value(42, 61),
    decision("ternary", 46, 59),
    unit("method", 101, 196, [region(115, 196)]),
    decision("if", 146, 158),
    decision("loop", 169, 185),
  ]);

  const unicodeSource = await assertPacked("unicode-whitespace-lines", [
    value(35, 49),
    lexical(53, 91),
  ]);
  assert.equal(unicodeSource.indexOf("// excluded after supplementary scalar"), 51, "fixture UTF-16 comment offset");
  assert.equal(Buffer.from(unicodeSource.slice(0, 51), "utf8").byteLength, 53, "supplementary scalar shifts the exact UTF-8 comment offset");
});

test("an adapter without the required C# URL rejects projection before runtime initialization", async () => {
  let touched = false;
  const production = createTreeSitterAdapter({ ...adapterAssets, grammarCSharp: undefined }, {
    async importRuntime() { touched = true; throw new Error("must not initialize"); },
    async loadBytes() { touched = true; throw new Error("must not load"); },
  });
  await assert.rejects(() => production.project("csharp", "class C {}"), /C# parser asset is not configured/u);
  assert.equal(touched, false);
});

test("a projection-time failure releases both cursors, tree, and parser without returning a stream", async () => {
  const events = [];
  let runtimeOptions;
  let parses = 0;
  const rootNode = {
    hasError: false,
    walk() {
      return {
        nodeType: "comment", nodeIsNamed: true, nodeIsMissing: false, currentFieldName: null, startIndex: 0, endIndex: 2,
        gotoFirstChild: () => false, gotoNextSibling: () => false, gotoParent: () => false, delete() {},
      };
    },
  };
  class FakeParser {
    static async init(options) { runtimeOptions = options; }
    setLanguage() {}
    parse() { parses += 1; return { rootNode, delete() {} }; }
    delete() {}
  }
  const adapter = createTreeSitterAdapter({ runtimeJavaScript: "runtime.js", runtimeWasm: "runtime.wasm", grammarJavaScript: "javascript.wasm", grammarTypeScript: "typescript.wasm", grammarTsx: "tsx.wasm", grammarCSharp: "csharp.wasm" }, {
    importRuntime: async () => ({ Parser: FakeParser, Language: { load: async () => ({}) } }),
    loadBytes: async () => new Uint8Array(),
    observeResource: (event) => events.push(event),
  });
  await assert.rejects(() => adapter.project("csharp", "x"), /Invalid parser endpoint/u);
  assert.equal(parses, 1);
  assert.equal(typeof runtimeOptions.print, "function");
  assert.equal(typeof runtimeOptions.printErr, "function");
  assert.equal(runtimeOptions.print("suppressed"), undefined);
  assert.equal(runtimeOptions.printErr("suppressed"), undefined);
  assert.deepEqual(events, ["parser-created", "tree-created", "cursor-created", "cursor-deleted", "cursor-created", "cursor-deleted", "tree-deleted", "parser-deleted"]);
});

test("valid empty, comment-only, and declaration-only forms have no executable units or complexity", () => {
  const expectedById = new Map(fixture.cases.map((entry) => [entry.id, entry.expected]));
  const sourceLinesById = {
    "empty-file-zero-units": 0,
    "comment-only-zero-units": 0,
    "declaration-only-zero-units": 9,
  };
  for (const [id, S] of Object.entries(sourceLinesById)) {
    const expected = expectedById.get(id);
    assert.equal(expected.valid, true, id);
    assert.equal(expected.S, S, id);
    assert.equal(expected.U, 0, id);
    assert.equal(expected.M, 0, id);
    assert.deepEqual(expected.units, [], id);
    assert.deepEqual(expected.decisions, [], id);
  }
});

test("excluded C# syntax contributes no nested units, ownership, or decisions at callable and initialization depth", () => {
  const byId = new Map(fixture.cases.map((entry) => [entry.id, entry]));
  const callable = byId.get("excluded-syntax-in-callables");
  assert.equal(occurrences(callable.source, "=>"), 3);
  assert.deepEqual(callable.expected.units, [
    { id: "method#1", kind: "method", form: "block", parent: "file", complexity: 1 },
    { id: "local-function#2", kind: "local-function", form: "block", parent: "method#1", complexity: 1 },
  ]);
  assert.deepEqual(callable.expected.decisions, []);
  assert.equal(callable.expected.M, 1);

  const initialization = byId.get("excluded-syntax-in-initialization");
  assert.equal(occurrences(initialization.source, "=>"), 5);
  assert.deepEqual(initialization.expected.units, [
    { id: "initialization/top-level", kind: "initialization/top-level", form: "file", parent: "file", complexity: 1 },
    { id: "lambda#1", kind: "lambda", form: "expression", parent: "initialization/top-level", complexity: 1 },
  ]);
  assert.deepEqual(initialization.expected.decisions, []);
  assert.equal(initialization.expected.M, 1);
});

test("initializer ranges preserve callable ownership and preprocessor conditions add no decisions", () => {
  const byId = new Map(fixture.cases.map((entry) => [entry.id, entry.expected]));
  const initialization = byId.get("initializer-range-ownership");
  assert.deepEqual(initialization.decisions, [
    { kind: "conditional", owner: "initialization/top-level" },
    { kind: "conditional", owner: "lambda#1" },
    { kind: "conditional", owner: "get#2" },
    { kind: "conditional", owner: "initialization/top-level" },
    { kind: "conditional", owner: "initialization/top-level" },
  ]);
  assert.equal(initialization.M, 4);

  const preprocessor = byId.get("preprocessor-condition-and-branch-ownership");
  assert.deepEqual(preprocessor.decisions, [
    { kind: "conditional", owner: "initialization/top-level" },
    { kind: "conditional", owner: "initialization/top-level" },
    { kind: "if", owner: "method#1" },
    { kind: "loop", owner: "method#1" },
  ]);
  assert.equal(preprocessor.decisions.some((decision) => decision.kind === "&&" || decision.kind === "||"), false);
  assert.equal(preprocessor.M, 3);
});

test("ordinary, deconstruction, and ref foreach forms each add one loop decision", () => {
  const expected = fixture.cases.find((entry) => entry.id === "foreach-forms").expected;
  assert.deepEqual(expected.decisions, [
    { kind: "loop", owner: "method#1" },
    { kind: "loop", owner: "method#1" },
    { kind: "loop", owner: "method#1" },
  ]);
  assert.equal(expected.M, 4);
});

test("C# source lines use Unicode-scalar White_Space and preserve comment ranges after supplementary scalars", () => {
  const entry = fixture.cases.find((candidate) => candidate.id === "unicode-whitespace-lines");
  assert.equal(entry.expected.S, 3);
  for (const scalar of FIXTURE_NON_ASCII_WHITE_SPACE) assert(entry.source.includes(scalar), `missing U+${scalar.codePointAt(0).toString(16).toUpperCase()}`);
});

test("guard, filter, switch default, and nested-callable ownership follow the fixed contract", () => {
  const byId = new Map(fixture.cases.map((entry) => [entry.id, entry.expected]));
  const branches = byId.get("switch-guards-filters-and-defaults");
  assert.deepEqual(branches.decisions, [
    { kind: "case", owner: "method#1" },
    { kind: "switch-guard", owner: "method#1" },
    { kind: "case", owner: "method#1" },
    { kind: "case", owner: "method#1" },
    { kind: "catch", owner: "method#1" },
    { kind: "catch-filter", owner: "method#1" },
    { kind: "switch-expression-arm", owner: "method#1" },
    { kind: "switch-guard", owner: "method#1" },
    { kind: "switch-expression-arm", owner: "method#1" },
    { kind: "switch-guard", owner: "method#1" },
  ]);
  assert.equal(branches.M, 11);
  const initialization = byId.get("initialization-and-nested-ownership");
  assert.deepEqual(initialization.decisions, [
    { kind: "conditional", owner: "initialization/top-level" },
    { kind: "??", owner: "initialization/top-level" },
    { kind: "conditional", owner: "lambda#1" },
    { kind: "??", owner: "constructor#2" },
  ]);
  assert.equal(initialization.units.find((unit) => unit.id === "lambda#1").parent, "initialization/top-level");
});

test("malformed, missing, and recovery trees fail closed through each candidate signal", () => {
  const byId = new Map(fixture.cases.map((entry) => [entry.id, entry.expected]));
  assert.deepEqual(byId.get("malformed-error").signals, { rootHasError: true, errorNodes: 1, missingNodes: 0 });
  assert.deepEqual(byId.get("truncated-missing").signals, { rootHasError: true, errorNodes: 0, missingNodes: 1 });
  assert.deepEqual(byId.get("recovery-error").signals, { rootHasError: true, errorNodes: 0, missingNodes: 0 });
  for (const id of ["malformed-error", "truncated-missing", "recovery-error"]) assert.equal(byId.get(id).valid, false, id);
});

test("qualified error, missing, and recovery fixtures map to one complete application and worker M1-MET-1 failure", async () => {
  const invalidCases = fixture.cases.filter(({ id }) => ["malformed-error", "truncated-missing", "recovery-error"].includes(id));
  assert.equal(invalidCases.length, 3);
  for (const [index, entry] of invalidCases.entries()) {
    const applicationEvents = [];
    const application = await processAdmittedBaseMetrics(
      [{ canonicalPath: `failure-${index}.CS`, normalizedSource: entry.source }],
      createTreeSitterAdapter(adapterAssets, { loadBytes: bytesFromFileUrl }),
      (event) => applicationEvents.push(event),
    );
    assert.deepEqual(application, { kind: "failure", category: "Metric processing failed", code: "M1-MET-1" }, entry.id);
    assert.deepEqual(applicationEvents, ["source-acquired", "source-released"], entry.id);

    const messages = [];
    const selected = String(index + 1).repeat(40);
    const parser = createTreeSitterAdapter(adapterAssets, { loadBytes: bytesFromFileUrl });
    const pipeline = createWorkerAttemptPipeline(
      async () => ({ kind: "revision", revision: selected }),
      {
        async loadInventory() { return { kind: "inventory", entries: [{ path: `failure-${index}.CS`, mode: "100644", type: "blob", sha: selected }] }; },
        async readSource() { return { kind: "source", decodedSource: entry.source }; },
      },
      (message) => messages.push(message),
      undefined,
      parser,
    );
    pipeline.start({ owner: "owner", repository: "repo", branch: null }, index + 1);
    const deadline = Date.now() + 10_000;
    while (!messages.some(({ type }) => type === "ATTEMPT_DRAINED") && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(messages, [
      { type: "REVISION_SELECTED", generation: index + 1, revision: selected },
      { type: "PROVIDER_DRAINED_STATIC_ENTERED", generation: index + 1 },
      { type: "FAILURE", generation: index + 1, revision: selected, category: "Metric processing failed", code: "M1-MET-1" },
      { type: "ATTEMPT_DRAINED", generation: index + 1 },
    ], entry.id);
    assert.doesNotMatch(JSON.stringify(messages), /failure-|normalizedSource|parser|diagnostic|source body/iu, entry.id);
    assert.deepEqual(pipeline.ownership(), { phase: "idle", selectedRevisionRetained: false, admittedModuleCount: 0, presentationModelRetained: false, finalFactCount: 0, providerResource: false }, entry.id);
  }
});

test("both exact-2-MiB candidate modules validate, project, and derive exact metrics without a timing threshold", async (t) => {
  const events = [];
  const adapter = createTreeSitterAdapter(adapterAssets, { loadBytes: bytesFromFileUrl, observeResource: (event) => events.push(event) });
  for (const kind of ["dense", "deep"]) {
    const source = createExactStressModule(kind);
    assert.equal(Buffer.byteLength(source, "utf8"), 2_097_152, kind);
    const comment = source.lastIndexOf("//");
    assert(comment > 0, kind);
    assert(/^\/\/p+$/u.test(source.slice(comment)), kind);
    if (kind === "dense") {
      assert.equal(occurrences(source.slice(0, comment), ";"), 1_000_000);
    } else {
      const expression = source.slice(source.indexOf("=>") + 2, comment);
      const literal = expression.indexOf("1");
      const terminator = expression.indexOf(";", literal);
      assert.equal(expression.slice(0, literal).trim().length, 100_000);
      assert(/^\(+$/u.test(expression.slice(0, literal).trim()));
      assert.equal(expression.slice(literal + 1, terminator).length, 100_000);
      assert(/^\)+$/u.test(expression.slice(literal + 1, terminator)));
    }
    const before = events.length;
    const started = performance.now();
    const stream = await adapter.project("csharp", source);
    const base = deriveBaseMetricAnalysis("fixture.js", source, stream.observations);
    const finalized = finalizeModuleComplexity(base);
    t.diagnostic(`${kind} adapter validation, projection, and metrics elapsed ${Math.round(performance.now() - started)} ms`);
    assert.deepEqual(finalized.fact, { canonicalPath: "fixture.js", S: 1, U: 1, M: 1 }, kind);
    stream.release();
    assert.deepEqual(events.slice(before), ["parser-created", "tree-created", "cursor-created", "cursor-deleted", "cursor-created", "cursor-deleted", "observation-stream-created", "tree-deleted", "parser-deleted", "observation-stream-released"], kind);
  }
});

test("production admission selects the exact qualified C# package asset without dependency changes", async () => {
  const { SUPPORTED_SUFFIXES, hasSupportedSuffix } = await import("../src/domain/source-admission.ts");
  const { selectGrammarFamily } = await import("../src/domain/base-metrics.ts");
  assert.deepEqual(SUPPORTED_SUFFIXES, [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".cs"]);
  for (const pathValue of ["a.cs", "A.CS", "a.Cs", "a.cS"]) {
    assert.equal(hasSupportedSuffix(pathValue), true, pathValue);
    assert.equal(selectGrammarFamily(pathValue), "csharp", pathValue);
  }
  const pins = {
    "package.json": "b25546a2df560e0c3b9e9bd924015945697c16b12e5e00673716a419e4081977",
    "package-lock.json": "a5c687fa928640528b067f51f8720745ee3f4a9fff29201d04c9c0e78d32e09f",
    "src/domain/base-metrics.ts": "72503f7b527a5fc443edf5986ee447f365827ecccad7eeacabcaaf3684d9286a",
  };
  for (const [relativePath, expected] of Object.entries(pins)) assert.equal(sha256(await readFile(path.join(projectRoot, ...relativePath.split("/")))), expected, relativePath);
  const productionAssets = await readFile(path.join(projectRoot, "src", "edge", "tree-sitter-assets.ts"), "utf8");
  assert.match(productionAssets, /import grammarCSharp from "@vscode\/tree-sitter-wasm\/wasm\/tree-sitter-c-sharp\.wasm\?url";/u);
  assert.match(productionAssets, /grammarTsx,\s*grammarCSharp,/u);
});
