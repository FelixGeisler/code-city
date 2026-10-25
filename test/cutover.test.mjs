import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildRetirementNotice } from "../tools/build-retirement-notice.mjs";
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
  const temporary = await mkdtemp(path.join(os.tmpdir(), "code-city-notice-"));
  try {
    await buildRetirementNotice(temporary);
    assert((await readFile(path.join(temporary, "index.html"))).equals(notice));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
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
