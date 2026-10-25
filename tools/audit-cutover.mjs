import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalStandaloneRoot, projectRoot } from "./build-standalone.mjs";
import { canonicalPagesRoot, retirementNoticeSource } from "./build-retirement-notice.mjs";
import { auditStandaloneArtifact } from "./standalone-manifest.mjs";

const inventoryPath = path.join(projectRoot, "publication", "former-analyzer-assets-v1.json");
const expectedKinds = Object.freeze({ javascript: 2, "browser-worker": 1, "parser-wasm": 5 });

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function exactKeys(value, keys, label) {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  assert.deepEqual(Object.keys(value), keys, `${label} keys differ`);
}

export async function auditCutover() {
  const manifest = await auditStandaloneArtifact(canonicalStandaloneRoot);
  const publicPaths = manifest.files.filter(({ role }) => role === "public").map(({ path: filePath }) => filePath);
  assert.deepEqual(publicPaths, ["public/browser.css", "public/browser.js", "public/index.html"]);

  const publicJavaScript = await readFile(path.join(canonicalStandaloneRoot, "public", "browser.js"), "utf8");
  assert.doesNotMatch(publicJavaScript, /api\.github\.com|raw\.githubusercontent\.com|new\s+Worker\b|SharedWorker\b|web-tree-sitter|tree-sitter-(?:javascript|typescript|tsx|c-sharp)|\.wasm\b|readRawSource|normalizedSource|providerOverride|fallback/iu);
  assert.match(publicJavaScript, /\/_code-city\/session/u);

  assert.deepEqual(await readdir(canonicalPagesRoot), ["index.html"]);
  const [sourceNotice, builtNotice] = await Promise.all([
    readFile(retirementNoticeSource),
    readFile(path.join(canonicalPagesRoot, "index.html")),
  ]);
  assert(sourceNotice.equals(builtNotice), "Pages notice differs from its versioned source");
  const noticeText = builtNotice.toString("utf8");
  assert.doesNotMatch(noticeText, /<script\b|<form\b|api\.github\.com|raw\.githubusercontent\.com|worker|parser|grammar|\.wasm/iu);
  assert.match(noticeText, /in-browser analyzer is retired/u);
  assert.match(noticeText, /standalone Code City artifact is deliverable/u);
  assert.doesNotMatch(noticeText, /Pages (?:is|setting).*disabled|hosted Code City service|device deployment|Internet deployment/iu);

  const inventoryBytes = await readFile(inventoryPath);
  assert.equal(inventoryBytes.at(-1), 0x0a, "Former-asset inventory must end with LF");
  const inventory = JSON.parse(inventoryBytes.toString("utf8"));
  exactKeys(inventory, ["version", "productionBaseUrl", "sourceCommit", "sourceManifestSha256", "assets"], "Former-asset inventory");
  assert.equal(inventory.version, 1);
  assert.equal(inventory.productionBaseUrl, "https://felixgeisler.github.io/code-city/");
  assert.match(inventory.sourceCommit, /^[0-9a-f]{40}$/u);
  assert.match(inventory.sourceManifestSha256, /^[0-9a-f]{64}$/u);
  assert(Array.isArray(inventory.assets));
  assert.equal(inventory.assets.length, 8);
  assert.deepEqual(inventory.assets.map(({ url }) => url), [...inventory.assets.map(({ url }) => url)].sort());
  const kindCounts = {};
  for (const [index, asset] of inventory.assets.entries()) {
    exactKeys(asset, ["url", "kind", "length", "sha256"], `Former asset ${index}`);
    const parsed = new URL(asset.url);
    assert.equal(`${parsed.origin}/code-city/`, inventory.productionBaseUrl);
    assert.equal(parsed.search, "");
    assert.equal(parsed.hash, "");
    assert(asset.kind === "javascript" || asset.kind === "browser-worker" || asset.kind === "parser-wasm");
    assert.equal(asset.url.endsWith(".wasm"), asset.kind === "parser-wasm");
    assert.equal(/processing-worker-[A-Za-z0-9_-]+\.js$/u.test(parsed.pathname), asset.kind === "browser-worker");
    assert(Number.isSafeInteger(asset.length) && asset.length > 0);
    assert.match(asset.sha256, /^[0-9a-f]{64}$/u);
    kindCounts[asset.kind] = (kindCounts[asset.kind] ?? 0) + 1;
  }
  assert.deepEqual(kindCounts, expectedKinds);
  assert.equal(sha256(inventoryBytes), "f4838507e6af3a5066381da4ac31387217154d8f0737df6c040b4623ee8adeae", "Former-asset inventory changed without a version increment");

  const metadata = await lstat(inventoryPath);
  assert(metadata.isFile() && !metadata.isSymbolicLink());
  process.stdout.write(`Audited canonical standalone public closure, notice bytes, and ${inventory.assets.length} former analyzer URLs.\n`);
}

const invokedPath = process.argv[1] && path.resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) await auditCutover();
