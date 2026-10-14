import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
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
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const occurrences = (source, token) => source.split(token).length - 1;

const REQUIRED_CASES = [
  "empty-file-zero-units",
  "comment-only-zero-units",
  "declaration-only-zero-units",
  "lexical-directives-and-branches",
  "all-explicit-and-zero-unit-forms",
  "initialization-and-nested-ownership",
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
  "abstract-zero", "accessor-add", "accessor-get", "accessor-init", "accessor-remove", "accessor-set", "anonymous-method", "attribute-zero", "auto-accessor-zero", "bitwise-zero", "bodyless-zero", "calls-zero", "case-label", "catch", "catch-filter", "comments", "comparisons-zero", "conditional", "conditional-access-zero", "const-zero", "constructor", "constructor-base", "conversion", "default-statement-zero", "destructor", "directives-source", "else-zero", "enum-zero", "error-signal", "expression-indexer", "expression-property", "extern-zero", "finally-zero", "guarded-discard", "if", "interpolated-string", "lambda", "local-function", "logical-and", "logical-or", "loop-do", "loop-for", "loop-foreach", "loop-foreach-deconstruction", "loop-foreach-ordinary", "loop-foreach-ref", "loop-while", "malformed", "method", "missing-signal", "modern-collection-expression", "modern-list-pattern", "modern-raw-string", "modern-record", "modern-required", "nested-callable", "nullish", "nullish-assign", "operator", "parameter-default-zero", "patterns-zero", "preprocessor-all-branches", "primary-base", "primary-header-zero", "query-zero", "raw-string", "recovery", "regular-string", "runtime-event-initializer", "runtime-field-initializer", "runtime-property-initializer", "signature-zero", "switch-expression-arm", "switch-expression-default-zero", "switch-guard", "switch-zero", "top-level", "truncated", "try-zero", "unicode-white-space", "verbatim-string", "empty-file-zero-units", "comment-only-zero-units", "declaration-only-zero-units",
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
  assert.equal(CSHARP_CANDIDATE.status, "qualified-not-admitted");
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
  assert.match(CSHARP_CANDIDATE.renewalRule, /requires renewed ADR 0007 qualification/u);
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

test("both exact-2-MiB candidate modules validate iteratively without a timing threshold", async (t) => {
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
    const events = [];
    const started = performance.now();
    const result = await createCSharpQualifier(initialized, { observeResource: (event) => events.push(event) }).qualify(source, { analyze: false });
    t.diagnostic(`${kind} candidate validation elapsed ${Math.round(performance.now() - started)} ms`);
    assert.equal(result.valid, true, kind);
    assert(result.visitedNodes > (kind === "dense" ? 1_000_000 : 200_000), kind);
    assertResourceClosure(events, false);
  }
});

test("qualification leaves C# admission, production grammar selection, assets, dependencies, and package entry unchanged", async () => {
  const { SUPPORTED_SUFFIXES, hasSupportedSuffix } = await import("../src/domain/source-admission.ts");
  const { selectGrammarFamily } = await import("../src/domain/base-metrics.ts");
  assert.deepEqual(SUPPORTED_SUFFIXES, [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]);
  for (const pathValue of ["a.cs", "A.CS", "a.Cs", "a.cS"]) {
    assert.equal(hasSupportedSuffix(pathValue), false, pathValue);
    assert.throws(() => selectGrammarFamily(pathValue), /Unsupported parser suffix/u, pathValue);
  }
  const pins = {
    "package.json": "384787527c06e0f003b76268caa5de48a90d0200601ff482e4660b7240e02128",
    "package-lock.json": "c0fc6511487ff8383c6c7730b8aa84775f94d8b0e515ab033c4bd3e1567912e4",
    "index.html": "a81a4853261bea9de8338ccde715eebad1cf0444c661cf788330151a1ff9b030",
    "src/domain/source-admission.ts": "b8b2463a8fd79fffe40e21bc7c150fcfd14cf8a699900a824f88d35e4d4bfa89",
    "src/domain/base-metrics.ts": "e48de706601e945579b660c0f4c970714af48e361db81db432ba2df46c02d3c5",
    "src/edge/tree-sitter-assets.ts": "da61189043bcc6944199a06c5500260c901a600d2e0c9d00c95b37d37c8f33e5",
  };
  for (const [relativePath, expected] of Object.entries(pins)) assert.equal(sha256(await readFile(path.join(projectRoot, ...relativePath.split("/")))), expected, relativePath);
  const productionAssets = await readFile(path.join(projectRoot, "src", "edge", "tree-sitter-assets.ts"), "utf8");
  assert.doesNotMatch(productionAssets, /c-sharp|csharp/iu);
});
