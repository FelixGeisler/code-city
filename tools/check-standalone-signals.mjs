import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { canonicalStandaloneRoot } from "./build-standalone.mjs";
import { auditStandaloneArtifact } from "./standalone-manifest.mjs";
import { analyze, expectCleanExit, launchStandalone, openSession, readyOrigin, sendGracefulSignal, terminateForCleanup, writeProviderHarness, writeSignalPreload } from "./standalone-check-support.mjs";

await auditStandaloneArtifact(canonicalStandaloneRoot);
const ZERO = 'SHUTDOWN {"liveSessions":0,"activeAttempts":0,"retainedSourceBytes":0}';

async function scenario(signal, state) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), `code-city-standalone-signal-${state}-`));
  let processUnderTest;
  try {
    let chained;
    if (state === "active") chained = (await writeProviderHarness(temporary, { blockInventory: true, observeJoin: true })).preload;
    const preload = await writeSignalPreload(temporary, chained);
    processUnderTest = launchStandalone({ preload });
    const origin = await readyOrigin(processUnderTest);
    let session;
    let responseEnded;
    if (state !== "none") {
      session = await openSession(origin);
      responseEnded = new Promise((resolve) => {
        let ended = false;
        const complete = () => { if (!ended) { ended = true; resolve(); } };
        session.response.once("end", complete);
        session.response.once("close", complete);
      });
    }
    if (state === "active") {
      await analyze(origin, session.sessionId);
      await session.stream.waitFor((event) => event.type === "REVISION_SELECTED");
    }
    sendGracefulSignal(processUnderTest, signal);
    if (state !== "none") await responseEnded;
    if (state === "active") {
      await processUnderTest.waitLine((line) => line === "HARNESS_JOINING");
      await processUnderTest.waitLine((line) => line === "HARNESS_JOINED");
    }
    const shutdown = await processUnderTest.waitLine((line) => line.startsWith("SHUTDOWN "));
    if (shutdown !== ZERO) throw new Error(`${signal}/${state} counters differ: ${shutdown}`);
    const result = await expectCleanExit(processUnderTest);
    if (state === "active") {
      const joining = result.lines.indexOf("HARNESS_JOINING");
      const joined = result.lines.indexOf("HARNESS_JOINED");
      const stopped = result.lines.indexOf(ZERO);
      if (!(joining >= 0 && joining < joined && joined < stopped)) throw new Error(`${signal} exited before active worker join`);
    }
  } finally {
    if (processUnderTest) await terminateForCleanup(processUnderTest);
    await rm(temporary, { recursive: true, force: true });
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  for (const state of ["none", "owned", "active"]) await scenario(signal, state);
}
process.stdout.write(`Verified ${process.platform === "win32" ? "packaged signal-event handling (real OS signals run in Linux CI)" : "real packaged SIGINT/SIGTERM handling"} for no session, owned response, active worker join, and zero ownership.\n`);
