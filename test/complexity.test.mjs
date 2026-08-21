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
const { checkedComplexityIncrement, finalizeModuleComplexity } = await import("../src/domain/complexity.ts");
const fixture = JSON.parse(await readFile(path.join(projectRoot, "test", "fixtures", "complexity-cases.json"), "utf8"));

const assetPath = (relativePath) => pathToFileURL(path.join(projectRoot, ...relativePath.split("/"))).href;
const assets = {
  runtimeJavaScript: assetPath("node_modules/web-tree-sitter/web-tree-sitter.js"),
  runtimeWasm: assetPath("node_modules/web-tree-sitter/web-tree-sitter.wasm"),
  grammarJavaScript: assetPath("node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-javascript.wasm"),
  grammarTypeScript: assetPath("node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-typescript.wasm"),
  grammarTsx: assetPath("node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-tsx.wasm"),
};
const bytesFromFileUrl = async (url) => new Uint8Array(await readFile(fileURLToPath(url)));
const failure = { kind: "failure", category: "Metric processing failed", code: "M1-MET-1" };

function exactKeys(value, keys) {
  assert(value && typeof value === "object" && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
}

function materializeBase(analysis) {
  return { S: analysis.S, U: analysis.U, units: [...analysis.units], observations: [...analysis.observations] };
}

function createParser(observeResource = () => {}) {
  return createTreeSitterAdapter(assets, { loadBytes: bytesFromFileUrl, observeResource });
}

function createRecordingParser(observeResource, finalized) {
  const parser = createParser(observeResource);
  return {
    initialize: () => parser.initialize(),
    async project(family, source) {
      const stream = await parser.project(family, source);
      let decisionObservationCount = 0;
      for (const observation of stream.observations) if (observation.kind === "decision") decisionObservationCount += 1;
      finalized.push({
        observationCount: stream.observations.length,
        decisionObservationCount,
        observationPackedByteLength: stream.observations.packedByteLength(),
      });
      return stream;
    },
  };
}

function validateFixtureSchema() {
  exactKeys(fixture, ["schemaVersion", "cases", "orderingCases"]);
  assert.equal(fixture.schemaVersion, 1);
  assert.equal(new Set(fixture.cases.map((entry) => entry.id)).size, fixture.cases.length);
  for (const entry of fixture.cases) {
    assert(["production-wasm", "synthetic-domain"].includes(entry.mode));
    if (entry.mode === "production-wasm") {
      exactKeys(entry, ["id", "mode", "canonicalPath", "source", "grammarFamily", "expectedOutcome"]);
      exactKeys(entry.expectedOutcome, ["kind", "S", "U", "units", "observations", "baseDigest", "perUnitComplexities", "M", "fact"]);
      assert.equal(entry.expectedOutcome.kind, "processed");
      assert.equal(typeof entry.canonicalPath, "string");
      assert.equal(typeof entry.source, "string");
      assert(["javascript-no-jsx", "javascript-jsx", "typescript", "tsx"].includes(entry.grammarFamily));
      exactKeys(entry.expectedOutcome.fact, ["canonicalPath", "S", "U", "M"]);
      assert.deepEqual(entry.expectedOutcome.fact, { canonicalPath: entry.canonicalPath, S: entry.expectedOutcome.S, U: entry.expectedOutcome.U, M: entry.expectedOutcome.M });
      const base = { S: entry.expectedOutcome.S, U: entry.expectedOutcome.U, units: entry.expectedOutcome.units, observations: entry.expectedOutcome.observations };
      assert.equal(createHash("sha256").update(JSON.stringify(base)).digest("hex"), entry.expectedOutcome.baseDigest);
      assert.equal(entry.expectedOutcome.U, entry.expectedOutcome.units.length);
      assert.equal(entry.expectedOutcome.U, entry.expectedOutcome.perUnitComplexities.length);
    } else if (entry.operation === "finalize") {
      exactKeys(entry, ["id", "mode", "operation", "input", "expectedOutcome"]);
      exactKeys(entry.input, ["canonicalPath", "S", "U", "units", "observations"]);
      assert.equal(typeof entry.input.canonicalPath, "string");
      assert(Number.isSafeInteger(entry.input.S) && entry.input.S >= 0);
      assert(Number.isSafeInteger(entry.input.U) && entry.input.U >= 0);
      assert(Array.isArray(entry.input.units));
      assert(Array.isArray(entry.input.observations));
      assert.deepEqual(entry.expectedOutcome, failure);
    } else {
      exactKeys(entry, ["id", "mode", "operation", "value", "expectedOutcome"]);
      assert.equal(entry.operation, "checked-increment");
      assert.equal(entry.value, Number.MAX_SAFE_INTEGER);
      assert.deepEqual(entry.expectedOutcome, { kind: "throw", code: "M1-MET-1" });
    }
  }
  for (const entry of fixture.orderingCases) {
    assert(["unsigned-utf8-permutation", "duplicate-canonical-path"].includes(entry.id));
    assert(Array.isArray(entry.modules));
    for (const module of entry.modules) exactKeys(module, ["canonicalPath", "source"]);
    if (entry.expectedFacts) for (const fact of entry.expectedFacts) exactKeys(fact, ["canonicalPath", "S", "U", "M"]);
    else assert.deepEqual(entry.expectedOutcome, failure);
  }
}

test("the mode-discriminated complexity fixture has one closed production and malformed-domain schema", () => {
  validateFixtureSchema();
  assert.deepEqual(fixture.cases.filter((entry) => entry.mode === "production-wasm").map((entry) => entry.id), [
    "decisions-all", "decisions-exclusions", "ownership-parameter-and-nested", "ownership-field-and-computed",
    "top-level-type-only", "conditional-type-excluded", "decorator-and-outer-ownership", "equal-maxima", "high-count",
  ]);
  const conditional = fixture.cases.find((entry) => entry.id === "conditional-type-excluded");
  assert.equal(conditional.source, "type X<T> = T extends string ? 1 : 2;");
  assert.deepEqual({ S: conditional.expectedOutcome.S, U: conditional.expectedOutcome.U, M: conditional.expectedOutcome.M }, { S: 1, U: 0, M: 0 });
  assert.deepEqual(conditional.expectedOutcome.units, []);
  assert.equal(conditional.expectedOutcome.observations.some((observation) => observation.kind === "decision"), false);
  assert(fixture.cases.some((entry) => entry.id === "checked-overflow" && entry.value === Number.MAX_SAFE_INTEGER));
});

test("production-WASM rows preserve base evidence and traverse the production finalizer and application", async () => {
  for (const entry of fixture.cases.filter((candidate) => candidate.mode === "production-wasm")) {
    const parser = createParser();
    await parser.initialize();
    const stream = await parser.project(entry.grammarFamily, entry.source);
    const analysis = deriveBaseMetricAnalysis(entry.canonicalPath, entry.source, stream.observations);
    const expectedBase = {
      S: entry.expectedOutcome.S,
      U: entry.expectedOutcome.U,
      units: entry.expectedOutcome.units,
      observations: entry.expectedOutcome.observations,
    };
    assert.deepEqual(materializeBase(analysis), expectedBase, `${entry.id} base facts`);
    const before = createHash("sha256").update(JSON.stringify(materializeBase(analysis))).digest("hex");
    const finalized = finalizeModuleComplexity(analysis);
    exactKeys(finalized, ["fact", "perUnitComplexities"]);
    exactKeys(finalized.fact, ["canonicalPath", "S", "U", "M"]);
    assert(finalized.perUnitComplexities instanceof Float64Array, entry.id);
    assert.deepEqual([...finalized.perUnitComplexities], entry.expectedOutcome.perUnitComplexities, entry.id);
    assert.deepEqual(finalized.fact, entry.expectedOutcome.fact, entry.id);
    assert.equal(finalized.fact.M, entry.expectedOutcome.M, entry.id);
    assert.equal(createHash("sha256").update(JSON.stringify(materializeBase(analysis))).digest("hex"), before, `${entry.id} mutated base facts`);
    stream.release();

    const applicationEvents = [];
    const application = await processAdmittedBaseMetrics(
      [{ canonicalPath: entry.canonicalPath, normalizedSource: entry.source }],
      createParser(),
      (event) => applicationEvents.push(event),
    );
    assert.deepEqual(application, { kind: "processed", facts: [entry.expectedOutcome.fact] }, `${entry.id} application`);
    assert.deepEqual(Object.keys(application.facts[0]).sort(), ["M", "S", "U", "canonicalPath"]);
    assert.deepEqual(applicationEvents, ["source-acquired", "fact-retained", "source-released"]);
  }
});

test("synthetic rows isolate malformed ownership and exact checked overflow through production domain operations", () => {
  for (const entry of fixture.cases.filter((candidate) => candidate.mode === "synthetic-domain")) {
    if (entry.operation === "checked-increment") {
      assert.throws(() => checkedComplexityIncrement(entry.value), /M1-MET-1/, entry.id);
    } else {
      assert.throws(() => finalizeModuleComplexity(entry.input), /M1-MET-1/, entry.id);
    }
  }
  for (const invalid of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => checkedComplexityIncrement(invalid), /M1-MET-1/);
  }
  assert.equal(checkedComplexityIncrement(Number.MAX_SAFE_INTEGER - 1), Number.MAX_SAFE_INTEGER);
});

test("small input permutations sort final facts by unsigned UTF-8 and duplicate paths fail atomically", async () => {
  for (const entry of fixture.orderingCases) {
    const events = [];
    const modules = entry.modules.map((module) => ({ canonicalPath: module.canonicalPath, normalizedSource: module.source }));
    const result = await processAdmittedBaseMetrics(modules, createParser(), (event) => events.push(event));
    if (entry.expectedOutcome) {
      assert.deepEqual(result, entry.expectedOutcome, entry.id);
      assert.equal(events.filter((event) => event === "source-released").length, entry.modules.length, entry.id);
    } else {
      assert.deepEqual(result, { kind: "processed", facts: entry.expectedFacts }, entry.id);
    }
  }
});

test("source-ordered ownership sweep handles 10,000 structural units and decisions", { timeout: 60_000 }, () => {
  const count = 10_000;
  const units = [{ path: "structural.js", kind: "top-level" }];
  const observations = [];
  for (let index = 0; index < count; index += 1) {
    const startByte = index * 10;
    units.push({
      path: "structural.js",
      kind: "function",
      startByte,
      endByte: startByte + 8,
      ownedRegions: [{ startByte, endByte: startByte + 8 }],
    });
    observations.push({ kind: "decision", decisionKind: "logical-and", startByte: startByte + 2, endByte: startByte + 6 });
  }

  const finalized = finalizeModuleComplexity({ canonicalPath: "structural.js", S: 1, U: count + 1, units, observations });
  assert.deepEqual(finalized.fact, { canonicalPath: "structural.js", S: 1, U: 10_001, M: 2 });
  assert.equal(finalized.perUnitComplexities.length, 10_001);
  assert.equal(finalized.perUnitComplexities[0], 1);
  assert(finalized.perUnitComplexities.subarray(1).every((complexity) => complexity === 2));
});

test("actual WASM handles 10,000 arrow units each owning one decision", { timeout: 2 * 60_000 }, async () => {
  const count = 10_000;
  const source = Array.from({ length: count }, (_, index) => `const a${index}=()=>x&&y;`).join("");
  assert.equal(Buffer.byteLength(source), 208_890);
  assert(Buffer.byteLength(source) < 2 * 1024 * 1024);

  const parser = createParser();
  await parser.initialize();
  const stream = await parser.project("javascript-no-jsx", source);
  const analysis = deriveBaseMetricAnalysis("many-units.js", source, stream.observations);
  assert.deepEqual({ S: analysis.S, U: analysis.U }, { S: 1, U: 10_001 });
  const units = [...analysis.units];
  assert.deepEqual(units[0], { path: "many-units.js", kind: "top-level" });
  for (let index = 1; index < units.length; index += 1) assert.equal(units[index].kind, "arrow");
  let decisionCount = 0;
  for (const observation of analysis.observations) if (observation.kind === "decision") decisionCount += 1;
  assert.equal(decisionCount, 10_000);
  assert(stream.observations.packedByteLength() < 2 * 1024 * 1024);

  const finalized = finalizeModuleComplexity(analysis);
  assert.deepEqual(finalized.fact, { canonicalPath: "many-units.js", S: 1, U: 10_001, M: 2 });
  assert.equal(finalized.perUnitComplexities.length, 10_001);
  assert.equal(finalized.perUnitComplexities[0], 1);
  assert(finalized.perUnitComplexities.subarray(1).every((complexity) => complexity === 2));
  stream.release();

  assert.deepEqual(
    await processAdmittedBaseMetrics([{ canonicalPath: "many-units.js", normalizedSource: source }], createParser()),
    { kind: "processed", facts: [{ canonicalPath: "many-units.js", S: 1, U: 10_001, M: 2 }] },
  );
});

function resourceTracker() {
  const live = { parser: 0, tree: 0, cursor: 0, source: 0, observationStream: 0 };
  const peak = { ...live };
  const cleanup = { parserDeletes: 0, treeDeletes: 0, cursorDeletes: 0, sourceReleases: 0, observationStreamReleases: 0 };
  const resources = {
    "parser-created": ["parser", 1], "parser-deleted": ["parser", -1],
    "tree-created": ["tree", 1], "tree-deleted": ["tree", -1],
    "cursor-created": ["cursor", 1], "cursor-deleted": ["cursor", -1],
    "observation-stream-created": ["observationStream", 1], "observation-stream-released": ["observationStream", -1],
  };
  return {
    live, peak, cleanup,
    resource(event) {
      const [kind, delta] = resources[event];
      live[kind] += delta;
      assert(live[kind] >= 0, event);
      peak[kind] = Math.max(peak[kind], live[kind]);
      if (event === "parser-deleted") cleanup.parserDeletes += 1;
      if (event === "tree-deleted") cleanup.treeDeletes += 1;
      if (event === "cursor-deleted") cleanup.cursorDeletes += 1;
      if (event === "observation-stream-released") cleanup.observationStreamReleases += 1;
    },
    application(event) {
      if (event === "source-acquired") {
        live.source += 1;
        peak.source = Math.max(peak.source, live.source);
      } else if (event === "source-released") {
        live.source -= 1;
        cleanup.sourceReleases += 1;
        assert(live.source >= 0);
      }
    },
  };
}

const COMPLEXITY_MATRIX_DIGEST = "f2ec54ea39565022686f3d17d07360570b1ebf6d097ca4254f95700bd0a520d4";

test("one complete Node complexity matrix finalizes exact facts within one eight-minute watchdog", { timeout: 8 * 60 * 1000 }, async () => {
  const dense = "a&&a; ".repeat(349_525) + ";;";
  assert.equal(Buffer.byteLength(dense), 2_097_152);
  const paths = Array.from({ length: 4_000 }, (_, index) => `complexity/${String(index).padStart(4, "0")}.${["js", "jsx", "ts", "tsx"][index % 4]}`);
  const modules = paths.map((canonicalPath, index) => ({ canonicalPath, normalizedSource: index < 20 ? dense : "" }));
  const tracker = resourceTracker();
  const finalized = [];
  const result = await processAdmittedBaseMetrics(
    modules,
    createRecordingParser((event) => tracker.resource(event), finalized),
    (event) => tracker.application(event),
  );
  assert.equal(result.kind, "processed");
  assert.equal(result.facts.length, 4_000);
  assert(result.facts.slice(0, 20).every((fact) => fact.S === 1 && fact.U === 1 && fact.M === 349_526));
  assert(result.facts.slice(20).every((fact) => fact.S === 0 && fact.U === 0 && fact.M === 0));
  assert(finalized.slice(0, 20).every((entry) => entry.decisionObservationCount === 349_525));
  assert(finalized.slice(0, 20).every((entry) => entry.observationPackedByteLength > 0));
  assert(finalized.slice(20).every((entry) => entry.decisionObservationCount === 0 && entry.observationPackedByteLength === 0));
  const factsText = result.facts.map((fact) => `${fact.canonicalPath}\t${fact.S}\t${fact.U}\t${fact.M}\n`).join("");
  assert.equal(createHash("sha256").update(factsText).digest("hex"), COMPLEXITY_MATRIX_DIGEST);
  assert.deepEqual(tracker.peak, { parser: 1, tree: 1, cursor: 1, source: 1, observationStream: 1 });
  assert.deepEqual(tracker.live, { parser: 0, tree: 0, cursor: 0, source: 0, observationStream: 0 });
  assert.deepEqual(tracker.cleanup, { parserDeletes: 4_000, treeDeletes: 4_000, cursorDeletes: 8_000, sourceReleases: 4_000, observationStreamReleases: 4_000 });
  assert(result.facts.every((fact) => Object.keys(fact).length === 4));
});
