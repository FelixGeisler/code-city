import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalStandaloneRoot, projectRoot } from "./build-standalone.mjs";
import { auditStandaloneArtifact } from "./standalone-manifest.mjs";

const inventoryPath = path.join(projectRoot, "publication", "former-analyzer-assets-v1.json");
const noticePath = path.join(projectRoot, "publication", "retirement-notice-v1", "index.html");
const verificationPath = path.join(projectRoot, "publication", "retirement-live-verification-v1.json");
const expectedKinds = Object.freeze({ javascript: 2, "browser-worker": 1, "parser-wasm": 5 });

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function exactKeys(value, keys, label) {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  assert.deepEqual(Object.keys(value), keys, `${label} keys differ`);
}

function instant(value, label) {
  const timestamp = Date.parse(value);
  assert(Number.isFinite(timestamp), `${label} must be an ISO timestamp`);
  return timestamp;
}

async function auditRetirementEvidence(inventory, noticeBytes) {
  const bytes = await readFile(verificationPath);
  assert.equal(bytes.at(-1), 0x0a, "Retirement verification must end with LF");
  assert.equal(sha256(bytes), "ad8d38d5aaccd6d989313f36351daea521f5d752f6f07447db45257578c9a678", "Retirement verification changed without a version increment");
  const evidence = JSON.parse(bytes.toString("utf8"));
  assert(Buffer.from(`${JSON.stringify(evidence)}\n`, "utf8").equals(bytes), "Retirement verification must be canonical JSON");
  assert.equal(evidence.schemaVersion, 1);
  assert.equal(evidence.issue, 626);
  assert.equal(evidence.acceptedIssueBodySha256, "3a29d383d16b00de498cc5a664fc13ce5d7ebab7771be605b595e5968e536f88");
  assert.equal(evidence.result, "PASS");
  assert.deepEqual(evidence.cutover, {
    issueUrl: "https://github.com/FelixGeisler/code-city/issues/625",
    pullRequestUrl: "https://github.com/FelixGeisler/code-city/pull/646",
    mergeCommitSha: "a6214152113175e2e1373b58929dcd228ce4abec",
  });
  assert.deepEqual({ id: evidence.publishRun.id, attempt: evidence.publishRun.attempt, headSha: evidence.publishRun.headSha, conclusion: evidence.publishRun.conclusion }, {
    id: 40181401593, attempt: 1, headSha: evidence.cutover.mergeCommitSha, conclusion: "success",
  });
  assert.deepEqual(evidence.publishRun.jobs.map(({ id, name, conclusion }) => ({ id, name, conclusion })), [
    { id: 121133051825, name: "verify", conclusion: "success" },
    { id: 121134290053, name: "deploy", conclusion: "success" },
    { id: 121134340142, name: "eligibility", conclusion: "success" },
    { id: 121134368195, name: "production-evidence", conclusion: "skipped" },
  ]);

  const artifactExpectations = [
    ["standalone", 12594940041, "ec965acf04a1cce6a330e745d8c23a96b3fbf5c7c127a813dc4a6ae77e0fa940"],
    ["retirement-notice", 12594590768, "662ec30a5f2b41c528720119d7d3099449231a6e0538f672993a6d78fc11a985"],
    ["publication-evidence", 12594429597, "fd789731146cebddfb22f36ec97334fc125d602d5e979514bc939904e541b931"],
  ];
  assert.deepEqual(evidence.artifacts.map(({ role, id, downloadZipSha256 }) => [role, id, downloadZipSha256]), artifactExpectations);
  for (const artifact of evidence.artifacts) {
    assert.equal(artifact.runId, evidence.publishRun.id);
    assert.equal(artifact.platformDigest, `sha256:${artifact.downloadZipSha256}`);
    assert.equal(artifact.url, `https://api.github.com/repos/FelixGeisler/code-city/actions/artifacts/${artifact.id}/zip`);
  }

  assert.deepEqual(evidence.standalonePublication, {
    schemaVersion: 1,
    repository: "FelixGeisler/code-city",
    eventName: "push",
    eventSha: evidence.cutover.mergeCommitSha,
    runId: evidence.publishRun.id,
    runAttempt: evidence.publishRun.attempt,
    manifestSha256: "e47f076abae509e15a709d9045f523b14a7e25526cee4fce52994d5b0a1ac15c",
    publicationRecordSha256: "276974581dbe3702346c2b1beb829b104ea62cc61f3e3c101e469a0c2a7037fd",
    uploadedManifestSha256: "e47f076abae509e15a709d9045f523b14a7e25526cee4fce52994d5b0a1ac15c",
    standaloneManifestSha256: "e47f076abae509e15a709d9045f523b14a7e25526cee4fce52994d5b0a1ac15c",
    manifestBytesEqual: true,
  });
  assert.deepEqual(evidence.retirementNotice, { sha256: sha256(noticeBytes), length: noticeBytes.length, uploadedPagesBytesEqual: true });
  assert.deepEqual(evidence.formerAnalyzerInventory, { sha256: sha256(Buffer.from(`${JSON.stringify(inventory)}\n`)), sourceCommit: inventory.sourceCommit, assetCount: inventory.assets.length });

  const runCompleted = instant(evidence.publishRun.completedAt, "Publish completion");
  const gateCompleted = instant(evidence.gateCompletedAt, "Gate completion");
  const packetCreated = instant(evidence.evidencePacketCreatedAt, "Packet creation");
  const checkoutCreated = instant(evidence.cleanupCheckoutCreatedAt, "Cleanup checkout creation");
  const editingAuthorized = instant(evidence.cleanupEditingAuthorizedAt, "Cleanup authorization");
  assert(runCompleted < gateCompleted && gateCompleted <= packetCreated && packetCreated < checkoutCreated && checkoutCreated < editingAuthorized);

  assert.equal(evidence.liveRequests.length, 2 + inventory.assets.length);
  const noticeRequests = evidence.liveRequests.slice(0, 2);
  assert.deepEqual(noticeRequests.map(({ url }) => url), [inventory.productionBaseUrl, `${inventory.productionBaseUrl}index.html`]);
  for (const request of noticeRequests) {
    assert.equal(request.expectedStatus, 200);
    assert.equal(request.status, 200);
    assert.equal(request.bodyLength, noticeBytes.length);
    assert.equal(request.bodySha256, sha256(noticeBytes));
    assert.equal(request.expectedBodySha256, sha256(noticeBytes));
    assert.equal(request.bodyEqual, true);
  }
  const assetRequests = evidence.liveRequests.slice(2);
  assert.deepEqual(assetRequests.map(({ url, kind }) => ({ url, kind })), inventory.assets.map(({ url, kind }) => ({ url, kind })));
  for (const request of assetRequests) {
    assert.equal(request.expectedStatus, 404);
    assert.equal(request.status, 404);
    assert.match(request.bodySha256, /^[0-9a-f]{64}$/u);
    assert.equal(request.expectedBodySha256, null);
    assert.equal(request.bodyEqual, null);
  }
  for (const [index, request] of evidence.liveRequests.entries()) {
    const requested = instant(request.requestedAt, `Request ${index} start`);
    const completed = instant(request.completedAt, `Request ${index} completion`);
    assert(runCompleted < requested && requested <= completed && completed <= gateCompleted);
    assert.match(request.contentIdentity.etag, /^"[0-9a-f]+-[0-9a-f]+"$/u);
    assert.equal(request.contentIdentity.contentType, "text/html; charset=utf-8");
    assert.equal(request.contentIdentity.contentLength, String(request.bodyLength));
    assert.match(request.contentIdentity.xGithubRequestId, /^[A-F0-9]+:[A-F0-9]+:[A-F0-9]+:[A-F0-9]+:[A-F0-9]+$/u);
  }
}

export async function auditCutover() {
  const manifest = await auditStandaloneArtifact(canonicalStandaloneRoot);
  const publicPaths = manifest.files.filter(({ role }) => role === "public").map(({ path: filePath }) => filePath);
  assert.deepEqual(publicPaths, [
    "public/analysis-worker.js", "public/browser.css", "public/browser.js", "public/index.html",
    "public/parser/tree-sitter-c-sharp.wasm", "public/parser/tree-sitter-javascript.wasm",
    "public/parser/tree-sitter-tsx.wasm", "public/parser/tree-sitter-typescript.wasm",
    "public/parser/web-tree-sitter.js", "public/parser/web-tree-sitter.wasm",
  ]);

  const publicJavaScript = await readFile(path.join(canonicalStandaloneRoot, "public", "browser.js"), "utf8");
  assert.match(publicJavaScript, /new Worker\(/u);
  assert.doesNotMatch(publicJavaScript, /_code-city\/|api\.github\.com|raw\.githubusercontent\.com|\bfetch\s*\(/u);
  const worker = await readFile(path.join(canonicalStandaloneRoot, "public", "analysis-worker.js"), "utf8");
  assert.ok(worker.includes("api.github.com") && worker.includes("raw.githubusercontent.com"));
  assert.doesNotMatch(publicJavaScript + worker, /providerOverride|process\.env|localStorage|sessionStorage|indexedDB|serviceWorker/iu);

  const noticeBytes = await readFile(noticePath);
  const noticeText = noticeBytes.toString("utf8");
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

  for (const filePath of [inventoryPath, noticePath, verificationPath]) {
    const metadata = await lstat(filePath);
    assert(metadata.isFile() && !metadata.isSymbolicLink());
  }
  await auditRetirementEvidence(inventory, noticeBytes);
  process.stdout.write(`Audited canonical standalone public closure and immutable retirement evidence for ${inventory.assets.length} former analyzer URLs.\n`);
}

const invokedPath = process.argv[1] && path.resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) await auditCutover();
