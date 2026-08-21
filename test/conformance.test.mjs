import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer } from "vite";
import viteConfig from "../vite.config.mjs";
import { assertClosedReference } from "../tools/audit-package.mjs";
import { inspectDependencyClosure } from "../tools/check-dependencies.mjs";
import { checkParserAssets } from "../tools/check-parser-assets.mjs";
import {
  assertWorkerConstructionPolicy,
  inspectEntryPolicy,
} from "../tools/package-policy.mjs";

const projectRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));

async function readText(relativePath) {
  return await readFile(path.join(projectRoot, ...relativePath.split("/")), "utf8");
}

async function readJson(relativePath) {
  return JSON.parse(await readText(relativePath));
}

function showTypeScriptConfig(relativePath) {
  const compiler = path.join(projectRoot, "node_modules", "typescript", "bin", "tsc");
  const output = execFileSync(process.execPath, [compiler, "--showConfig", "--project", relativePath], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  return JSON.parse(output);
}

async function listFiles(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  const files = [];
  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...await listFiles(path.join(directory, entry.name), relativePath));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
  return files;
}

test("the dependency manifest and complete lock closure match the accepted pins", async () => {
  const result = await inspectDependencyClosure(projectRoot);
  assert(result.registryPackageCount > 0);
});

test("selected parser assets, licenses, ABI envelope, and canonical inventory match accepted evidence", async () => {
  await checkParserAssets();
});

test("exactly three strict no-emit TypeScript configs isolate main and worker libraries", async () => {
  const rootEntries = await readdir(projectRoot);
  const configFiles = rootEntries.filter((name) => /^tsconfig(?:\.[^.]+)?\.json$/.test(name)).sort();
  assert.deepEqual(configFiles, ["tsconfig.base.json", "tsconfig.main.json", "tsconfig.worker.json"]);

  const base = await readJson("tsconfig.base.json");
  assert.equal(base.compilerOptions.strict, true);
  assert.equal(base.compilerOptions.noEmit, true);
  assert.equal(base.compilerOptions.isolatedModules, true);

  const main = showTypeScriptConfig("tsconfig.main.json");
  assert.equal(main.compilerOptions.strict, true);
  assert.equal(main.compilerOptions.noEmit, true);
  assert.equal(main.compilerOptions.isolatedModules, true);
  assert.deepEqual(main.compilerOptions.lib, ["es2024", "dom", "dom.iterable"]);
  assert.deepEqual(main.compilerOptions.types, ["vite/client"]);
  assert.deepEqual(main.files.map((file) => file.replaceAll("\\", "/")), ["./src/edge/main.ts", "./src/edge/city-presenter.ts"]);

  const worker = showTypeScriptConfig("tsconfig.worker.json");
  assert.equal(worker.compilerOptions.strict, true);
  assert.equal(worker.compilerOptions.noEmit, true);
  assert.equal(worker.compilerOptions.isolatedModules, true);
  assert.deepEqual(worker.compilerOptions.lib, ["es2024", "webworker"]);
  assert(!worker.compilerOptions.lib.includes("dom"));
  assert.deepEqual(worker.compilerOptions.types, []);
  assert.deepEqual(worker.files.map((file) => file.replaceAll("\\", "/")), ["./src/edge/processing-worker.ts"]);
});

test("the Vite application is strictly layered, policy-closed, and has one static module worker", async () => {
  assert.equal(viteConfig.base, "/code-city/");
  assert.equal(viteConfig.publicDir, false);
  assert.equal(viteConfig.build.sourcemap, false);
  assert.equal(viteConfig.build.assetsInlineLimit, 0);
  assert.equal(viteConfig.worker.format, "es");

  const productionFiles = await listFiles(path.join(projectRoot, "src"));
  assert.deepEqual(productionFiles, [
    "application/base-metric-processing.ts",
    "application/main-controller.ts",
    "application/protocol.ts",
    "application/resolution.ts",
    "application/source-retrieval.ts",
    "application/worker-attempt.ts",
    "domain/base-metrics.ts",
    "domain/city-model.ts",
    "domain/complexity.ts",
    "domain/repository-reference.ts",
    "domain/source-admission.ts",
    "edge/city-presenter.ts",
    "edge/github-revision-gateway.ts",
    "edge/github-source-gateway.ts",
    "edge/main.ts",
    "edge/processing-worker.ts",
    "edge/shell.css",
    "edge/tree-sitter-adapter.ts",
    "edge/tree-sitter-assets.ts",
  ]);

  const indexHtml = await readText("index.html");
  inspectEntryPolicy(indexHtml);
  assert.match(indexHtml, /<h1>Code City<\/h1>/);
  assert.equal((indexHtml.match(/<form\b/gi) ?? []).length, 1);
  assert.equal((indexHtml.match(/<input\b/gi) ?? []).length, 1);
  assert.equal((indexHtml.match(/<button\b/gi) ?? []).length, 1);
  assert.equal((indexHtml.match(/\sdata-form(?:\s|>)/gi) ?? []).length, 1);
  assert.equal((indexHtml.match(/\sdata-status(?:\s|>)/gi) ?? []).length, 1);
  assert.equal((indexHtml.match(/\sdata-commit(?:\s|>)/gi) ?? []).length, 1);
  assert.equal((indexHtml.match(/\sdata-city(?:\s|>)/gi) ?? []).length, 1);
  assert.doesNotMatch(indexHtml, /<(?:select|textarea|canvas)\b/i);

  const formTag = indexHtml.match(/<form\b[^>]*>/i)?.[0];
  const inputTag = indexHtml.match(/<input\b[^>]*>/i)?.[0];
  assert(formTag);
  assert(inputTag);
  assert.match(formTag, /\snovalidate(?:\s|>)/i);
  assert.match(indexHtml, /<label\s+for="repository">GitHub repository URL<\/label>/);
  assert.match(inputTag, /\sid="repository"(?:\s|>)/i);
  assert.match(inputTag, /\sname="repository"(?:\s|>)/i);
  assert.match(inputTag, /\stype="text"(?:\s|>)/i);
  assert.doesNotMatch(inputTag, /\stype="url"|\srequired(?:\s|>)/i);

  const mainSource = await readText("src/edge/main.ts");
  const workerSource = await readText("src/edge/processing-worker.ts");
  assert.match(mainSource, /from "\.\/processing-worker\.ts\?worker&url"/);
  assert.match(mainSource, /new Worker\(processingWorkerUrl, \{ type: "module" \}\)/);
  assert.match(mainSource, /form\.addEventListener\("submit", \(event\) => \{\s*event\.preventDefault\(\);\s*controller\.submit\(input\.value\);\s*\}\);/);
  assert.match(mainSource, /replaceStatus\("Working", cancel\)/);
  assert.match(mainSource, /commit\.textContent = revision/);
  assert.match(mainSource, /window\.addEventListener\("pagehide", \(\) => controller\.dispose\(\), \{ once: true \}\)/);
  assert.doesNotMatch(mainSource, /innerHTML|insertAdjacentHTML/);
  assertWorkerConstructionPolicy([["Main source", mainSource], ["Worker source", workerSource]]);
  assert.doesNotMatch(`${mainSource}\n${workerSource}`, /SharedWorker|blob:|data:|createObjectURL/);
});

test("the package closure guard rejects path aliases and traversal before manifest lookup", () => {
  const manifestPaths = new Set(["index.html", "assets/main.js", "assets/name with space.css"]);
  for (const reference of [
    "/code-city/",
    "/code-city/index.html",
    "/code-city/assets/main.js",
    "/code-city/assets/name%20with%20space.css",
  ]) {
    assert.doesNotThrow(() => assertClosedReference(reference, manifestPaths));
  }

  for (const reference of [
    "/code-city/../index.html",
    "/code-city/%2e%2e/index.html",
    "/code-city/assets%2fmain.js",
    "/code-city/assets%5cmain.js",
    "/code-city/assets\\main.js",
    "/code-city/assets//main.js",
    "/code-city/assets/./main.js",
    "/code-city/%69ndex.html",
    "/code-city/%",
  ]) {
    assert.throws(
      () => assertClosedReference(reference, manifestPaths),
      Error,
      `Expected package closure rejection for ${reference}`,
    );
  }
});

test("the development command configuration starts at the public base and shuts down cleanly", async () => {
  const server = await createViteServer({
    root: projectRoot,
    configFile: path.join(projectRoot, "vite.config.mjs"),
    logLevel: "silent",
    server: {
      host: "127.0.0.1",
      port: 0,
    },
  });
  try {
    await server.listen();
    const address = server.httpServer?.address();
    assert(typeof address === "object" && address);
    const response = await fetch(`http://127.0.0.1:${address.port}/code-city/`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /<h1>Code City<\/h1>/);
  } finally {
    await server.close();
  }
  assert.equal(server.httpServer?.listening, false);
});

test("commands and CI preserve the canonical package audit sequence without deployment", async () => {
  const packageManifest = await readJson("package.json");
  assert.deepEqual(packageManifest.scripts, {
    dev: "vite",
    typecheck: "tsc -p tsconfig.main.json && tsc -p tsconfig.worker.json",
    test: "node --test",
    build: "node tools/build-package.mjs",
    "test:reproducibility": "node tools/check-reproducibility.mjs",
    start: "node tools/serve-package.mjs",
    "test:package": "node tools/audit-package.mjs",
    "docs:build": "antora antora-playbook.yml",
    verify: "npm run typecheck && npm run test && npm run build && npm run test:reproducibility && npm run test:package && npm run docs:build",
  });

  const ci = await readText(".github/workflows/ci.yml");
  assert.match(ci, /pull_request:/);
  assert.match(ci, /push:\s*\n\s*branches: \[main\]/);
  assert.match(ci, /permissions:\s*\n\s*contents: read/);
  const install = ci.indexOf("npm ci --ignore-scripts");
  const closure = ci.indexOf("npm ls --all");
  const audit = ci.indexOf("npm audit --audit-level=high");
  const verify = ci.indexOf("npm run verify");
  assert(install >= 0 && install < closure && closure < audit && audit < verify);
  assert.doesNotMatch(ci, /\bv2\b|upload-artifact|deploy-pages|configure-pages|environment:|pages:\s*write|id-token:\s*write|contents:\s*write/i);
});

test("README and agent guidance describe the current product and supported commands", async () => {
  const readme = await readText("README.md");
  for (const expected of [
    "npm ci --ignore-scripts",
    "npm run dev",
    "http://localhost:5173/code-city/",
    "npm run build",
    "npm run start",
    "http://127.0.0.1:4173/code-city/",
    "npm run verify",
    "`main`",
  ]) {
    assert(readme.includes(expected), `README is missing ${expected}`);
  }

  const agents = await readText("AGENTS.md");
  for (const expected of ["npm run typecheck", "npm run test", "npm run build", "npm run test:reproducibility", "npm run test:package", "npm run docs:build", "npm run verify"]) {
    assert(agents.includes(expected), `AGENTS.md is missing ${expected}`);
  }
  assert.doesNotMatch(`${readme}\n${agents}`, /\bv2\b|\b2\.x\b|reimplementation|template|\bv1\b|\barchiv(?:e|al)\b|\bformer\b/i);
});
