import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { canonicalStandaloneRoot, projectRoot } from "./build-standalone.mjs";
import { auditStandaloneArtifact } from "./standalone-manifest.mjs";
import { expectCleanExit, launchStandalone, readyOrigin, request, sendGracefulSignal, terminateForCleanup, writeSignalPreload } from "./standalone-check-support.mjs";

const manifest = await auditStandaloneArtifact(canonicalStandaloneRoot);
assert.deepEqual(manifest.files.filter(f => f.role === "public").map(f => f.path), [
  "public/analysis-worker.js", "public/browser.css", "public/browser.js", "public/index.html",
  "public/parser/tree-sitter-c-sharp.wasm", "public/parser/tree-sitter-javascript.wasm",
  "public/parser/tree-sitter-tsx.wasm", "public/parser/tree-sitter-typescript.wasm",
  "public/parser/web-tree-sitter.js", "public/parser/web-tree-sitter.wasm",
]);
assert.deepEqual(manifest.files.filter(f => f.role === "private").map(f => f.path), [
  "server/licenses.json",
  "server/src/application/city-payload.js", "server/src/application/investigation-origin.js", "server/src/application/saved-investigation.js",
  "server/src/domain/city-model.js", "server/src/domain/district-layout.js", "server/src/domain/exclusion-policy.js", "server/src/domain/repository-reference.js", "server/src/domain/source-admission.js",
  "server/src/edge/node/body-reader.js", "server/src/edge/node/config.js", "server/src/edge/node/fixture-manifest.js",
  "server/src/edge/node/http-perimeter.js", "server/src/edge/node/investigation-store.js", "server/src/edge/node/snapshot-validation-worker.js",
  "server/src/edge/node/standalone-cli.js", "server/src/edge/node/wire-observer.js", "server/standalone.mjs",
]);
for (const [source, name] of [
  ["node_modules/web-tree-sitter/web-tree-sitter.js", "web-tree-sitter.js"],
  ["node_modules/web-tree-sitter/web-tree-sitter.wasm", "web-tree-sitter.wasm"],
  ["node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-javascript.wasm", "tree-sitter-javascript.wasm"],
  ["vendor/tree-sitter-typescript/wasm/tree-sitter-typescript.wasm", "tree-sitter-typescript.wasm"],
  ["vendor/tree-sitter-typescript/wasm/tree-sitter-tsx.wasm", "tree-sitter-tsx.wasm"],
  ["node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-c-sharp.wasm", "tree-sitter-c-sharp.wasm"],
]) assert.ok((await readFile(path.join(projectRoot, source))).equals(await readFile(path.join(canonicalStandaloneRoot, "public/parser", name))), `Parser bytes changed: ${name}`);
const notices = JSON.parse(await readFile(path.join(canonicalStandaloneRoot, "server/licenses.json"), "utf8"));
assert.equal(notices.length, 7);
assert.ok(notices.every(notice => typeof notice.package === "string" && notice.notice.includes("Permission is hereby granted") && notice.notice.includes("Copyright")));
const main = await readFile(path.join(canonicalStandaloneRoot, "public/browser.js"), "utf8");
const worker = await readFile(path.join(canonicalStandaloneRoot, "public/analysis-worker.js"), "utf8");
assert.match(main, /new Worker\(/u);
assert.doesNotMatch(main, /_code-city\/|api\.github\.com|raw\.githubusercontent\.com/u);
assert.doesNotMatch(main + worker, /localStorage|sessionStorage|indexedDB|serviceWorker|document\.cookie|process\.env|providerOverride|fault selector|fixture selector/iu);
assert.ok(worker.includes("api.github.com") && worker.includes("raw.githubusercontent.com") && worker.includes("/parser/web-tree-sitter.wasm"));
for (const record of manifest.files.filter(f => f.role === "private")) {
  const code = await readFile(path.join(canonicalStandaloneRoot, record.path), "utf8");
  assert.doesNotMatch(code, /source-retrieval|github-source-gateway|tree-sitter-adapter|session-runtime|deriveBaseMetricAnalysis|finalizeModuleComplexity/u);
}
const temporary = await mkdtemp(path.join(os.tmpdir(), "code-city-static-package-audit-"));
let processUnderTest;
try {
  const preload = await writeSignalPreload(temporary);
  processUnderTest = launchStandalone({ preload });
  const origin = await readyOrigin(processUnderTest);
  for (const record of manifest.files.filter(f => f.role === "public")) {
    const target = record.path === "public/index.html" ? "/" : "/" + record.path.slice("public/".length);
    const response = await request(origin, target);
    assert.equal(response.status, 200);
    assert.equal(response.headers["content-type"], record.mediaType);
    assert.ok(response.body.equals(await readFile(path.join(canonicalStandaloneRoot, record.path))));
    assert.ok(response.headers["content-security-policy"].includes("worker-src 'self'"));
    assert.ok(response.headers["content-security-policy"].includes("'wasm-unsafe-eval'"));
  }
  for (const target of ["/_code-city/session", "/_code-city/analyze", "/_code-city/cancel", "/_code-city/discard", "/package-manifest.json", "/server/standalone.mjs", "/index.html", "/unknown.wasm"]) {
    const response = await request(origin, target, { method: target.startsWith("/_code-city/") ? "POST" : "GET", headers: { Origin: origin, "Content-Type": "application/json" }, body: target.startsWith("/_code-city/") ? "{}" : undefined });
    assert.equal(response.status, 404); assert.equal(response.body.length, 0);
  }
  sendGracefulSignal(processUnderTest, "SIGTERM");
  assert.equal(await processUnderTest.waitLine(line => line === "SHUTDOWN"), "SHUTDOWN");
  await expectCleanExit(processUnderTest);
  process.stdout.write("Audited public worker/parser integrity, private asset closure, static serving, removed analysis routes, CSP, and clean packaged shutdown.\n");
} finally {
  if (processUnderTest) await terminateForCleanup(processUnderTest);
  await rm(temporary, { recursive: true, force: true });
}
