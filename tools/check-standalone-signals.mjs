import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { canonicalStandaloneRoot } from "./build-standalone.mjs";
import { auditStandaloneArtifact } from "./standalone-manifest.mjs";
import { expectCleanExit, launchStandalone, readyOrigin, request, sendGracefulSignal, terminateForCleanup, writeSignalPreload } from "./standalone-check-support.mjs";

await auditStandaloneArtifact(canonicalStandaloneRoot);
for (const signal of ["SIGINT", "SIGTERM"]) {
  for (const state of ["idle", "completed-read", "non-reading-client"]) {
    const temporary = await mkdtemp(path.join(os.tmpdir(), "code-city-static-signal-"));
    let processUnderTest, socket;
    try {
      const preload = await writeSignalPreload(temporary);
      processUnderTest = launchStandalone({ preload });
      const origin = await readyOrigin(processUnderTest);
      if (state === "completed-read") assert.equal((await request(origin, "/")).status, 200);
      if (state === "non-reading-client") {
        const url = new URL(origin);
        socket = net.createConnection({ host: "127.0.0.1", port: Number(url.port) });
        await new Promise((resolve, reject) => {
          socket.once("error", reject);
          socket.once("connect", () => {
            socket.write(`GET /parser/tree-sitter-c-sharp.wasm HTTP/1.1\r\nHost: ${url.host}\r\n\r\n`);
          });
          socket.once("data", () => { socket.pause(); resolve(); });
        });
      }
      sendGracefulSignal(processUnderTest, signal);
      assert.equal(await processUnderTest.waitLine(line => line === "SHUTDOWN"), "SHUTDOWN");
      await expectCleanExit(processUnderTest);
    } finally {
      socket?.destroy();
      if (processUnderTest) await terminateForCleanup(processUnderTest);
      await rm(temporary, { recursive: true, force: true });
    }
  }
}
process.stdout.write(`Verified ${process.platform === "win32" ? "signal-event shutdown (real OS signals run in Linux CI)" : "real SIGINT/SIGTERM shutdown"} for idle, completed reads, and non-reading static clients. No server analysis worker/session exists.\n`);
