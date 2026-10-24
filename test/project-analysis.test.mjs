import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(/^\.\.?\//.test(specifier) && !/(?:\.[a-z]+|\?.*)$/i.test(specifier) ? `${specifier}.ts` : specifier, context);
  },
});

const projectRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const { analyzeProjectSources } = await import("../src/application/project-analysis.ts");
const { createSyntaxObservationWriter } = await import("../src/domain/base-metrics.ts");
const { buildCity } = await import("../src/domain/city-model.ts");
const { createTreeSitterAdapter } = await import("../src/edge/tree-sitter-adapter.ts");
const encoder = new TextEncoder();
const SHA = "a".repeat(40);

function module(canonicalPath, normalizedSource) {
  const normalizedUtf8 = new Uint8Array(encoder.encode(normalizedSource));
  return { canonicalPath, normalizedSource, normalizedUtf8 };
}

function acquired(modules, notAnalyzedFiles = []) {
  return { kind: "acquired", selected: SHA, modules, notAnalyzedFiles };
}

function emptyStream(release = () => {}) {
  return { observations: createSyntaxObservationWriter().finish(), release };
}

test("the unwired project-analysis module has no strict worker-config TypeScript diagnostics", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "code-city-project-analysis-types-"));
  const configPath = path.join(temporary, "tsconfig.json");
  try {
    await writeFile(configPath, JSON.stringify({
      extends: path.join(projectRoot, "tsconfig.worker.json").replaceAll("\\", "/"),
      include: [],
      files: [path.join(projectRoot, "src", "application", "project-analysis.ts").replaceAll("\\", "/")],
    }));
    const compiler = path.join(projectRoot, "node_modules", "typescript", "bin", "tsc");
    const result = spawnSync(process.execPath, [compiler, "--project", configPath, "--pretty", "false"], { encoding: "utf8" });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("mixed continuation classifies syntax and metrics independently, releases streams once, and retains normalized sources", async () => {
  const releases = new Map();
  let initializeCalls = 0;
  const parser = {
    async initialize() { initializeCalls += 1; },
    async project(_family, source) {
      if (source === "syntax") throw new Error("syntax detail");
      const release = () => releases.set(source, (releases.get(source) ?? 0) + 1);
      if (source === "metrics") {
        return { observations: { [Symbol.iterator]() { throw new Error("derive detail"); } }, release };
      }
      if (source === "finalize") {
        return {
          observations: [{ kind: "decision", decisionKind: "invalid", startByte: 0, endByte: 1 }],
          release,
        };
      }
      return emptyStream(release);
    },
  };
  const retained = [
    module("z.ts", "ok"),
    module("a.ts", "syntax"),
    module("m.ts", "metrics"),
    module("f.ts", "finalize"),
  ];
  const result = await analyzeProjectSources(acquired(retained, [
    { canonicalPath: "c.ts", category: "Source text is not supported" },
  ]), parser);
  assert.equal(result.kind, "analyzed");
  assert.equal(initializeCalls, 1);
  assert.deepEqual(result.result.notAnalyzedFiles, [
    { canonicalPath: "a.ts", category: "Syntax could not be analyzed" },
    { canonicalPath: "c.ts", category: "Source text is not supported" },
    { canonicalPath: "f.ts", category: "Metrics could not be computed" },
    { canonicalPath: "m.ts", category: "Metrics could not be computed" },
  ]);
  assert.deepEqual(result.result.sources.map(({ canonicalPath }) => canonicalPath), ["a.ts", "f.ts", "m.ts", "z.ts"]);
  assert.equal(result.result.sources.find(({ canonicalPath }) => canonicalPath === "a.ts").normalizedUtf8, retained[1].normalizedUtf8);
  assert.equal(result.result.sources.find(({ canonicalPath }) => canonicalPath === "m.ts").normalizedUtf8, retained[2].normalizedUtf8);
  assert.deepEqual([...releases], [["ok", 1], ["metrics", 1], ["finalize", 1]]);
  assert.deepEqual(result.result.city.inspection, [{ canonicalPath: "z.ts", S: 1, U: 0, M: 0 }]);
  assert.deepEqual(new Set([
    ...result.result.city.inspection.map(({ canonicalPath }) => canonicalPath),
    ...result.result.notAnalyzedFiles.map(({ canonicalPath }) => canonicalPath),
  ]), new Set(["a.ts", "c.ts", "f.ts", "m.ts", "z.ts"]));
});

test("all attempted failures still initialize once and return a null city with the complete source invariant", async () => {
  let initializeCalls = 0;
  const result = await analyzeProjectSources(acquired([
    module("a.ts", "syntax"), module("b.ts", "metrics"),
  ], [{ canonicalPath: "c.ts", category: "Source text is not supported" }]), {
    async initialize() { initializeCalls += 1; },
    async project(_family, source) {
      if (source === "syntax") throw new Error("syntax");
      return { observations: { [Symbol.iterator]() { throw new Error("metrics"); } }, release() {} };
    },
  });
  assert.equal(initializeCalls, 1);
  assert.deepEqual(result, {
    kind: "analyzed",
    result: {
      city: null,
      notAnalyzedFiles: [
        { canonicalPath: "a.ts", category: "Syntax could not be analyzed" },
        { canonicalPath: "b.ts", category: "Metrics could not be computed" },
        { canonicalPath: "c.ts", category: "Source text is not supported" },
      ],
      sources: [
        { canonicalPath: "a.ts", normalizedUtf8: encoder.encode("syntax") },
        { canonicalPath: "b.ts", normalizedUtf8: encoder.encode("metrics") },
      ],
    },
  });
});

test("cleanup and city ownership failures are fatal and return no partial analysis", async () => {
  const cleanup = await analyzeProjectSources(acquired([module("a.ts", "ok")]), {
    async initialize() {},
    async project() { return emptyStream(() => { throw new Error("cleanup detail"); }); },
  });
  assert.deepEqual(cleanup, { kind: "failure", category: "Metric processing failed", code: "M1-MET-1" });
  assert.equal(Object.hasOwn(cleanup, "result"), false);

  for (const constructCity of [
    () => { throw new Error("city detail"); },
    (facts) => ({ ...buildCity(facts), inspection: [] }),
    (facts) => {
      const city = buildCity(facts);
      return { ...city, geometry: { ...city.geometry, sizes: city.geometry.origins } };
    },
  ]) {
    const result = await analyzeProjectSources(acquired([module("a.ts", "ok")]), {
      async initialize() {}, async project() { return emptyStream(); },
    }, constructCity);
    assert.deepEqual(result, { kind: "failure", category: "City construction failed", code: "M1-CITY-1" });
    assert.equal(Object.hasOwn(result, "result"), false);
  }
});

const assetUrl = (relativePath) => pathToFileURL(path.join(projectRoot, ...relativePath.split("/"))).href;
const productionAssets = {
  runtimeJavaScript: assetUrl("node_modules/web-tree-sitter/web-tree-sitter.js"),
  runtimeWasm: assetUrl("node_modules/web-tree-sitter/web-tree-sitter.wasm"),
  grammarJavaScript: assetUrl("node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-javascript.wasm"),
  grammarTypeScript: assetUrl("vendor/tree-sitter-typescript/wasm/tree-sitter-typescript.wasm"),
  grammarTsx: assetUrl("vendor/tree-sitter-typescript/wasm/tree-sitter-tsx.wasm"),
  grammarCSharp: assetUrl("node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-c-sharp.wasm"),
};

test("the complete existing production adapter initializes the real runtime and JS/TS/TSX/C# assets once before all-text-failed completion", async () => {
  const events = [];
  const parser = createTreeSitterAdapter(productionAssets, {
    async importRuntime(url) { events.push("runtime"); return import(url); },
    async loadBytes(url) {
      events.push(url === productionAssets.grammarJavaScript ? "javascript"
        : url === productionAssets.grammarTypeScript ? "typescript"
        : url === productionAssets.grammarTsx ? "tsx"
        : url === productionAssets.grammarCSharp ? "csharp" : "unexpected");
      return new Uint8Array(await readFile(fileURLToPath(url)));
    },
  });
  await Promise.all([parser.initialize(), parser.initialize()]);
  const result = await analyzeProjectSources(acquired([], [
    { canonicalPath: "bad.ts", category: "Source text is not supported" },
  ]), parser);
  assert.equal(result.kind, "analyzed");
  assert.equal(result.result.city, null);
  assert.deepEqual(events, ["runtime", "javascript", "typescript", "tsx", "csharp"]);
});

test("existing adapter memoizes concurrent and repeated initialization rejection", async () => {
  let imports = 0;
  const failure = new Error("runtime unavailable");
  const parser = createTreeSitterAdapter({
    runtimeJavaScript: "runtime.js", runtimeWasm: "runtime.wasm", grammarJavaScript: "javascript.wasm",
    grammarTypeScript: "typescript.wasm", grammarTsx: "tsx.wasm", grammarCSharp: "csharp.wasm",
  }, {
    async importRuntime() { imports += 1; await Promise.resolve(); throw failure; },
  });
  const first = parser.initialize();
  const second = parser.initialize();
  await assert.rejects(first, (error) => error === failure);
  await assert.rejects(second, (error) => error === failure);
  await assert.rejects(parser.initialize(), (error) => error === failure);
  assert.equal(imports, 1);
});

test("runtime import, runtime WASM, and each configured grammar failure are fatal before projection", async () => {
  const assets = {
    runtimeJavaScript: "runtime.js", runtimeWasm: "runtime.wasm", grammarJavaScript: "javascript.wasm",
    grammarTypeScript: "typescript.wasm", grammarTsx: "tsx.wasm", grammarCSharp: "csharp.wasm",
  };
  for (const stage of ["import", "runtime.wasm", "javascript.wasm", "typescript.wasm", "tsx.wasm", "csharp.wasm"]) {
    let parserConstructions = 0;
    class FakeParser {
      constructor() { parserConstructions += 1; }
      static async init(options) {
        assert.equal(options.locateFile("web-tree-sitter.wasm", ""), "runtime.wasm");
        if (stage === "runtime.wasm") throw new Error(stage);
      }
      setLanguage() {}
      parse() { throw new Error("project must not run"); }
      delete() {}
    }
    const parser = createTreeSitterAdapter(assets, {
      async importRuntime() {
        if (stage === "import") throw new Error(stage);
        return { Parser: FakeParser, Language: { async load() { return {}; } } };
      },
      async loadBytes(url) {
        if (stage === url) throw new Error(stage);
        return new Uint8Array();
      },
    });
    const result = await analyzeProjectSources(acquired([module("a.ts", "ok")]), parser);
    assert.deepEqual(result, { kind: "failure", category: "Metric processing failed", code: "M1-MET-1" }, stage);
    assert.equal(parserConstructions, 0, stage);
  }
});
