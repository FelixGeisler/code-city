import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildStandaloneArtifact } from "../tools/build-standalone.mjs";
import { createStandalonePublicationRecord, validateStandalonePublicationRecord } from "../tools/standalone-publication-record.mjs";
import { serializeStandaloneManifest } from "../tools/standalone-manifest.mjs";

const inventoryPath = new URL("../publication/former-analyzer-assets-v1.json", import.meta.url);
const noticePath = new URL("../publication/retirement-notice-v1/index.html", import.meta.url);

function manifestBytes() {
  return Uint8Array.from(serializeStandaloneManifest({
    version: 1,
    files: [{ path: "public/index.html", role: "public", mediaType: "text/html; charset=utf-8", length: 0, sha256: "0".repeat(64) }],
  }));
}

test("the versioned retirement notice is exact and script-free", async () => {
  const notice = await readFile(noticePath);
  const text = notice.toString("utf8");
  assert.match(text, /The in-browser analyzer is retired\./u);
  assert.match(text, /The standalone Code City artifact is deliverable\./u);
  assert.doesNotMatch(text, /<script\b|<form\b|worker|parser|grammar|\.wasm|api\.github\.com|raw\.githubusercontent\.com/iu);
});

test("the former analyzer inventory is complete, canonical, and pinned to the pre-cutover package", async () => {
  const bytes = await readFile(inventoryPath);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), "f4838507e6af3a5066381da4ac31387217154d8f0737df6c040b4623ee8adeae");
  const inventory = JSON.parse(bytes);
  assert.equal(inventory.version, 1);
  assert.equal(inventory.sourceCommit, "eeb276c4b10f4801bc7619aa8b81f9c063d7ed5d");
  assert.equal(inventory.sourceManifestSha256, "ae0c7cdbe66b11e948c25c31a9a5847d27663e7c88ba20f1a6ea9efd526db38a");
  assert.deepEqual(inventory.assets.map(({ kind }) => kind).sort(), [
    "browser-worker", "javascript", "javascript", "parser-wasm", "parser-wasm", "parser-wasm", "parser-wasm", "parser-wasm",
  ]);
  assert.equal(new Set(inventory.assets.map(({ url }) => url)).size, 8);
  assert(inventory.assets.every(({ url }) => url.startsWith(inventory.productionBaseUrl)));
});

test("the immutable live-retirement record binds the cutover run, artifacts, notice, and complete 404 inventory before cleanup", async () => {
  const verificationPath = new URL("../publication/retirement-live-verification-v1.json", import.meta.url);
  const [bytes, inventoryBytes, notice] = await Promise.all([readFile(verificationPath), readFile(inventoryPath), readFile(noticePath)]);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), "ad8d38d5aaccd6d989313f36351daea521f5d752f6f07447db45257578c9a678");
  const evidence = JSON.parse(bytes);
  assert(Buffer.from(`${JSON.stringify(evidence)}\n`).equals(bytes));
  const inventory = JSON.parse(inventoryBytes);
  const noticeSha256 = createHash("sha256").update(notice).digest("hex");
  assert.deepEqual({ issue: evidence.issue, digest: evidence.acceptedIssueBodySha256, result: evidence.result }, {
    issue: 626, digest: "3a29d383d16b00de498cc5a664fc13ce5d7ebab7771be605b595e5968e536f88", result: "PASS",
  });
  assert.deepEqual({ id: evidence.publishRun.id, attempt: evidence.publishRun.attempt, head: evidence.publishRun.headSha, conclusion: evidence.publishRun.conclusion }, {
    id: 40181401593, attempt: 1, head: "a6214152113175e2e1373b58929dcd228ce4abec", conclusion: "success",
  });
  assert.deepEqual(evidence.artifacts.map(({ role, runId, id, downloadZipSha256 }) => ({ role, runId, id, downloadZipSha256 })), [
    { role: "standalone", runId: 40181401593, id: 12594940041, downloadZipSha256: "ec965acf04a1cce6a330e745d8c23a96b3fbf5c7c127a813dc4a6ae77e0fa940" },
    { role: "retirement-notice", runId: 40181401593, id: 12594590768, downloadZipSha256: "662ec30a5f2b41c528720119d7d3099449231a6e0538f672993a6d78fc11a985" },
    { role: "publication-evidence", runId: 40181401593, id: 12594429597, downloadZipSha256: "fd789731146cebddfb22f36ec97334fc125d602d5e979514bc939904e541b931" },
  ]);
  assert.deepEqual({ recordSha256: evidence.standalonePublication.publicationRecordSha256, manifestSha256: evidence.standalonePublication.manifestSha256, equal: evidence.standalonePublication.manifestBytesEqual }, {
    recordSha256: "276974581dbe3702346c2b1beb829b104ea62cc61f3e3c101e469a0c2a7037fd",
    manifestSha256: "e47f076abae509e15a709d9045f523b14a7e25526cee4fce52994d5b0a1ac15c",
    equal: true,
  });
  assert.deepEqual(evidence.retirementNotice, { sha256: noticeSha256, length: notice.length, uploadedPagesBytesEqual: true });
  assert.deepEqual(evidence.formerAnalyzerInventory, {
    sha256: createHash("sha256").update(inventoryBytes).digest("hex"), sourceCommit: inventory.sourceCommit, assetCount: 8,
  });
  assert(Date.parse(evidence.publishRun.completedAt) < Date.parse(evidence.gateCompletedAt));
  assert(Date.parse(evidence.gateCompletedAt) <= Date.parse(evidence.evidencePacketCreatedAt));
  assert(Date.parse(evidence.evidencePacketCreatedAt) < Date.parse(evidence.cleanupCheckoutCreatedAt));
  assert(Date.parse(evidence.cleanupCheckoutCreatedAt) < Date.parse(evidence.cleanupEditingAuthorizedAt));
  assert.equal(evidence.liveRequests.length, 10);
  assert.deepEqual(evidence.liveRequests.slice(0, 2).map(({ status, bodySha256, bodyEqual }) => ({ status, bodySha256, bodyEqual })), [
    { status: 200, bodySha256: noticeSha256, bodyEqual: true },
    { status: 200, bodySha256: noticeSha256, bodyEqual: true },
  ]);
  assert.deepEqual(evidence.liveRequests.slice(2).map(({ url, kind, status }) => ({ url, kind, status })),
    inventory.assets.map(({ url, kind }) => ({ url, kind, status: 404 })));
  for (const request of evidence.liveRequests) {
    assert(Date.parse(request.requestedAt) <= Date.parse(request.completedAt));
    assert.match(request.bodySha256, /^[0-9a-f]{64}$/u);
    assert.match(request.contentIdentity.etag, /^"[0-9a-f]+-[0-9a-f]+"$/u);
    assert.equal(request.contentIdentity.contentLength, String(request.bodyLength));
    assert.match(request.contentIdentity.xGithubRequestId, /^[A-F0-9:]+$/u);
  }
});

test("standalone publication records bind exact manifest bytes and workflow identity", () => {
  const manifest = manifestBytes();
  const input = {
    repository: "FelixGeisler/code-city",
    eventName: "push",
    eventSha: "a".repeat(40),
    runId: 123,
    runAttempt: 2,
  };
  const record = createStandalonePublicationRecord(input, manifest);
  assert.deepEqual(validateStandalonePublicationRecord(Uint8Array.from(record), manifest), {
    schemaVersion: 1,
    ...input,
    manifestSha256: createHash("sha256").update(manifest).digest("hex"),
  });
  const changed = Uint8Array.from(manifest);
  changed[changed.length - 2] ^= 1;
  assert.throws(() => validateStandalonePublicationRecord(Uint8Array.from(record), changed));
  const padded = new Uint8Array(record.byteLength + 2);
  padded.set(record, 1);
  assert.throws(() => validateStandalonePublicationRecord(padded.subarray(1, -1), manifest), /whole buffer/u);
});

test("development builds the standalone layout outside canonical dist", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "code-city-development-build-"));
  try {
    await buildStandaloneArtifact(temporary);
    assert.equal(JSON.parse(await readFile(path.join(temporary, "package-manifest.json"), "utf8")).version, 1);
    assert.equal((await readFile(path.join(temporary, "public", "browser.js"), "utf8")).includes("/_code-city/session"), true);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
