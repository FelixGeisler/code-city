import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { canonicalStandaloneRoot } from "./build-standalone.mjs";
import { auditStandaloneArtifact } from "./standalone-manifest.mjs";
import { analyze, expectCleanExit, launchStandalone, openSession, readyOrigin, sendGracefulSignal, terminateForCleanup, writeProviderHarness, writeSignalPreload } from "./standalone-check-support.mjs";

const manifest = await auditStandaloneArtifact(canonicalStandaloneRoot);
const publicPaths = manifest.files.filter(({ role }) => role === "public").map(({ path: filePath }) => filePath);
if (JSON.stringify(publicPaths) !== JSON.stringify(["public/browser.css", "public/browser.js", "public/index.html"])) {
  throw new Error(`Standalone public closure differs: ${JSON.stringify(publicPaths)}`);
}
const generated = [];
for (const record of manifest.files) {
  if (record.path.endsWith(".js") || record.path.endsWith(".mjs")) generated.push(await readFile(path.join(canonicalStandaloneRoot, ...record.path.split("/")), "utf8"));
}
const generatedSource = generated.join("\n");
if (/process\.env|--(?:test|fixture|provider|fault)\b|providerOverride|fault selector|fixture selector|main-controller|processing-worker/iu.test(generatedSource)) {
  throw new Error("Standalone generated JavaScript contains a forbidden runtime/test selector or legacy browser process");
}
const publicJavaScript = await readFile(path.join(canonicalStandaloneRoot, "public", "browser.js"), "utf8");
if (/new\s+Worker\b|SharedWorker\b|createGithub(?:Revision|RawSource)Gateway|readRawSource|normalizedSource|rawDiagnostic|web-tree-sitter|tree-sitter-(?:javascript|typescript|tsx|c-sharp)|\.wasm\b|api\.github\.com|raw\.githubusercontent\.com/iu.test(publicJavaScript)) {
  throw new Error("Standalone public JavaScript contains a browser analysis process, provider/source contract, or parser asset reference");
}
if (!publicJavaScript.includes("/_code-city/session") || !publicJavaScript.includes("Discard current analysis")
  || !publicJavaScript.includes("Code City capacity is unavailable.")) {
  throw new Error("Standalone public browser client is incomplete");
}

const temporary = await mkdtemp(path.join(os.tmpdir(), "code-city-standalone-package-audit-"));
let processUnderTest;
try {
  const harness = await writeProviderHarness(temporary);
  const preload = await writeSignalPreload(temporary, harness.preload);
  processUnderTest = launchStandalone({ preload });
  const origin = await readyOrigin(processUnderTest);
  const session = await openSession(origin);
  await analyze(origin, session.sessionId);
  const selected = await session.stream.waitFor((event) => event.type === "REVISION_SELECTED");
  if (selected.revision !== "a".repeat(40)) throw new Error("Packaged worker revision differs");
  const success = await session.stream.waitFor((event) => event.type === "ANALYSIS_SUCCEEDED", 30_000);
  if (success.notAnalyzedFiles.length !== 0 || success.city?.geometry?.count < 4) throw new Error(`Packaged worker/parser result differs: ${JSON.stringify(success)}`);
  session.response.destroy();
  sendGracefulSignal(processUnderTest, "SIGTERM");
  const shutdown = await processUnderTest.waitLine((line) => line.startsWith("SHUTDOWN "));
  if (shutdown !== 'SHUTDOWN {"liveSessions":0,"activeAttempts":0,"retainedSourceBytes":0}') throw new Error(`Shutdown counters differ: ${shutdown}`);
  await expectCleanExit(processUnderTest);
  process.stdout.write("Audited the packaged perimeter, worker, parser assets, and deterministic four-grammar analysis without live GitHub.\n");
} finally {
  if (processUnderTest) await terminateForCleanup(processUnderTest);
  await rm(temporary, { recursive: true, force: true });
}
