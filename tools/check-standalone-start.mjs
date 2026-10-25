import { readFile } from "node:fs/promises";
import path from "node:path";
import { canonicalStandaloneRoot } from "./build-standalone.mjs";
import { auditStandaloneArtifact } from "./standalone-manifest.mjs";
import { expectCleanExit, launchStandalone, readyOrigin, request, sendGracefulSignal, terminateForCleanup } from "./standalone-check-support.mjs";

await auditStandaloneArtifact(canonicalStandaloneRoot);
const processUnderTest = launchStandalone();
try {
  const origin = await readyOrigin(processUnderTest);
  for (const [target, file, mediaType] of [
    ["/", "index.html", "text/html; charset=utf-8"],
    ["/fixture.css", "fixture.css", "text/css; charset=utf-8"],
    ["/fixture.svg", "fixture.svg", "image/svg+xml"],
  ]) {
    const expected = await readFile(path.join(canonicalStandaloneRoot, "public", file));
    const response = await request(origin, target);
    if (response.status !== 200 || response.headers["content-type"] !== mediaType || !response.body.equals(expected)) throw new Error(`Packaged public response mismatch: ${target}`);
  }
  for (const target of [
    "/package-manifest.json",
    "/server/standalone.mjs",
    "/parser/web-tree-sitter.wasm",
    "/index.html",
    "/unlisted.js",
  ]) {
    const response = await request(origin, target);
    if (response.status !== 404 || response.body.byteLength !== 0) throw new Error(`Packaged private or unlisted route was exposed: ${target}`);
  }
  if (process.platform === "win32") {
    await terminateForCleanup(processUnderTest);
  } else {
    sendGracefulSignal(processUnderTest, "SIGTERM");
    const shutdown = await processUnderTest.waitLine((line) => line.startsWith("SHUTDOWN "));
    if (shutdown !== 'SHUTDOWN {"liveSessions":0,"activeAttempts":0,"retainedSourceBytes":0}') throw new Error(`Shutdown counters differ: ${shutdown}`);
    await expectCleanExit(processUnderTest);
  }
  process.stdout.write(`Started the packaged server at ${origin} and verified public/private routing.\n`);
} finally {
  await terminateForCleanup(processUnderTest);
}
