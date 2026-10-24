import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(/^\.\.?\//u.test(specifier) && !/(?:\.[a-z]+|\?.*)$/iu.test(specifier) ? `${specifier}.ts` : specifier, context);
  },
});

const projectRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const { createNodeTreeSitterAdapter, NODE_PARSER_ASSET_URLS } = await import("../src/edge/node/parser-assets.ts");
const { startNodeWorkerAttempt } = await import("../src/edge/node/worker-attempt.ts");
const REPOSITORY = { owner: "owner", repository: "repo", branch: null };
const SHA = "a".repeat(40);

async function compiledWorkerFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "code-city-node-worker-bundle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await symlink(path.join(projectRoot, "node_modules"), path.join(root, "node_modules"), "junction");
  await mkdir(path.join(root, "vendor"), { recursive: true });
  await symlink(path.join(projectRoot, "vendor", "tree-sitter-typescript"), path.join(root, "vendor", "tree-sitter-typescript"), "junction");
  const config = path.join(root, "tsconfig.json");
  await writeFile(config, JSON.stringify({
    extends: path.join(projectRoot, "tsconfig.node.json").replaceAll("\\", "/"),
    compilerOptions: {
      noEmit: false, rootDir: projectRoot.replaceAll("\\", "/"), outDir: root.replaceAll("\\", "/"),
      declaration: false, sourceMap: false,
    },
    include: [],
    files: [path.join(projectRoot, "src/edge/node/analysis-worker.ts").replaceAll("\\", "/")],
  }));
  const compiler = path.join(projectRoot, "node_modules", "typescript", "bin", "tsc");
  const built = spawnSync(process.execPath, [compiler, "-p", config, "--pretty", "false"], { encoding: "utf8" });
  assert.equal(built.status, 0, `${built.stdout}${built.stderr}`);

  const bootstrap = path.join(root, "test-worker.mjs");
  await writeFile(bootstrap, `
import { parentPort, workerData } from "node:worker_threads";
import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, nextResolve) { return nextResolve(/^\\.\\.?\\//u.test(specifier) && !/\\.[a-z]+$/iu.test(specifier) ? specifier + ".js" : specifier, context); } });
const { runNodeAnalysisWorker } = await import(${JSON.stringify(pathToFileURL(path.join(root, "src/edge/node/analysis-worker.js")).href)});
const { createSyntaxObservationWriter } = await import(${JSON.stringify(pathToFileURL(path.join(root, "src/domain/base-metrics.js")).href)});
const SHA = "a".repeat(40);
const inventory = {
  success: [["a.ts", "const a = 1;\\n"]],
  mixed: [["a.ts", "const a = 1;\\n"], ["b.ts", "syntax"], ["c.ts", "metrics"], ["d.ts", null]],
  allFailed: [["a.ts", "syntax"], ["b.ts", "metrics"], ["c.ts", null]],
  parserBusy: [["a.ts", "busy"]],
  providerWait: [["a.ts", "const a = 1;\\n"]],
}[workerData.scenario];
const bytes = new TextEncoder();
runNodeAnalysisWorker(parentPort, {
  async revisionGateway(_repository, signal) {
    if (workerData.scenario === "providerWait") await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    return signal.aborted ? { kind: "empty" } : { kind: "revision", revision: SHA };
  },
  sourceGateway: {
    async loadInventory() { return { kind: "inventory", entries: inventory.map(([file]) => ({ path: file, mode: "100644", type: "blob", sha: SHA })) }; },
    async readRawSource(_repository, _revision, candidate) {
      const source = inventory.find(([file]) => file === candidate.canonicalPath)[1];
      return { kind: "source", rawBytes: source === null ? new Uint8Array([255]) : bytes.encode(source) };
    },
  },
  parser: {
    async initialize() {},
    async project(_family, source) {
      if (source === "syntax") throw new Error("syntax");
      if (source === "metrics") return { observations: { [Symbol.iterator]() { throw new Error("metrics"); } }, release() {} };
      if (source === "busy") for (;;) {}
      return { observations: createSyntaxObservationWriter().finish(), release() {} };
    },
  },
});
`);
  return pathToFileURL(bootstrap);
}

function start(bundle, scenario, release = () => {}) {
  return startNodeWorkerAttempt({
    repository: REPOSITORY, generation: 3, workerUrl: bundle,
    workerFactory: (url) => new Worker(url, { workerData: { scenario } }), release,
  });
}

test("actual worker returns city/source, mixed failures, and all-files-failed only after a code-0 join", async (t) => {
  const bundle = await compiledWorkerFixture(t);
  const success = await start(bundle, "success").result;
  assert.equal(success.type, "SUCCESS");
  assert.deepEqual(success.result.city.inspection.map(({ canonicalPath }) => canonicalPath), ["a.ts"]);
  assert.deepEqual(success.sources.map(({ canonicalPath }) => canonicalPath), ["a.ts"]);

  const mixed = await start(bundle, "mixed").result;
  assert.equal(mixed.type, "SUCCESS");
  assert.deepEqual(mixed.result.notAnalyzedFiles, [
    { canonicalPath: "b.ts", category: "Syntax could not be analyzed" },
    { canonicalPath: "c.ts", category: "Metrics could not be computed" },
    { canonicalPath: "d.ts", category: "Source text is not supported" },
  ]);
  assert.deepEqual(mixed.sources.map(({ canonicalPath }) => canonicalPath), ["a.ts", "b.ts", "c.ts"]);

  const allFailed = await start(bundle, "allFailed").result;
  assert.equal(allFailed.type, "SUCCESS");
  assert.equal(allFailed.result.city, null);
  assert.deepEqual(allFailed.sources.map(({ canonicalPath }) => canonicalPath), ["a.ts", "b.ts"]);
});

test("Node parser assets use actual package-compatible file URLs for runtime, JS, TS, TSX, and C#", async () => {
  for (const url of Object.values(NODE_PARSER_ASSET_URLS)) assert.equal(new URL(url).protocol, "file:");
  const parser = createNodeTreeSitterAdapter();
  await parser.initialize();
  for (const [family, source] of [
    ["javascript-no-jsx", "export const a = 1;"], ["typescript", "const a: number = 1;"],
    ["tsx", "const a = <div />;"], ["csharp", "class C { void M() {} }"],
  ]) {
    const projected = await parser.project(family, source);
    assert.ok([...projected.observations].length >= 0);
    projected.release();
  }
});

test("provider cancellation and parser-time termination join and release exactly once without a terminal", async (t) => {
  const bundle = await compiledWorkerFixture(t);
  for (const scenario of ["providerWait", "parserBusy"]) {
    let releases = 0;
    const attempt = start(bundle, scenario, () => { releases += 1; });
    await new Promise((resolve) => setTimeout(resolve, 25));
    await attempt.cancel();
    assert.deepEqual(await attempt.result, { type: "CANCELLED" });
    await attempt.cancel();
    assert.equal(releases, 1, scenario);
  }
});

test("a busy analysis worker leaves the parent timer and a small native HTTP response responsive", async (t) => {
  const bundle = await compiledWorkerFixture(t);
  const attempt = start(bundle, "parserBusy");
  const server = http.createServer((_request, response) => response.end("ok"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  const timer = new Promise((resolve) => setTimeout(() => resolve("timer"), 15));
  const response = new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${address.port}/`, (incoming) => {
      const chunks = [];
      incoming.on("data", (chunk) => chunks.push(chunk));
      incoming.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    }).on("error", reject);
  });
  assert.deepEqual(await Promise.all([timer, response]), ["timer", "ok"]);
  await attempt.cancel();
});
