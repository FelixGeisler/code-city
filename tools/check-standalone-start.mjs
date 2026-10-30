import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { canonicalStandaloneRoot } from "./build-standalone.mjs";
import { auditStandaloneArtifact } from "./standalone-manifest.mjs";
import { expectCleanExit, launchStandalone, readyOrigin, request, sendGracefulSignal, terminateForCleanup, writeSignalPreload } from "./standalone-check-support.mjs";
const manifest = await auditStandaloneArtifact(canonicalStandaloneRoot);
const temporary = await mkdtemp(path.join(os.tmpdir(), "code-city-static-start-"));
let processUnderTest;
try {
  processUnderTest = launchStandalone({ preload: await writeSignalPreload(temporary) });
  const origin = await readyOrigin(processUnderTest);
  for (const file of manifest.files.filter(f => f.role === "public")) {
    const target = file.path === "public/index.html" ? "/" : "/" + file.path.slice(7);
    const response = await request(origin, target);
    assert.equal(response.status, 200);
    assert.equal(response.headers["content-type"], file.mediaType);
    assert.ok(response.body.equals(await readFile(path.join(canonicalStandaloneRoot, file.path))));
  }
  for (const target of ["/package-manifest.json", "/server/standalone.mjs", "/_code-city/session", "/index.html", "/unlisted.js"]) {
    assert.equal((await request(origin, target)).status, 404);
  }
  sendGracefulSignal(processUnderTest, "SIGTERM");
  assert.equal(await processUnderTest.waitLine(line => line === "SHUTDOWN"), "SHUTDOWN");
  await expectCleanExit(processUnderTest);
  process.stdout.write(`Verified packaged static-host startup, public/private routing, and clean shutdown at ${origin}.\n`);
} finally {
  if (processUnderTest) await terminateForCleanup(processUnderTest);
  await rm(temporary, { recursive: true, force: true });
}
