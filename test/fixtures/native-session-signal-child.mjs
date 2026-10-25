import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";

const [mode, root, manifestPath] = process.argv.slice(2);

if (mode !== undefined) {
  const barrierUrl = new URL("./native-session-attempt-barrier.mjs", import.meta.url).href;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "./worker-attempt" && context.parentURL?.endsWith("/session-runtime.ts")) {
        return { url: barrierUrl, shortCircuit: true };
      }
      return nextResolve(/^\.\.?\//u.test(specifier) && !/(?:\.[a-z]+|\?.*)$/iu.test(specifier) ? `${specifier}.ts` : specifier, context);
    },
  });

  const { parseStandaloneArguments } = await import("../../src/edge/node/config.ts");
  const { installInactiveSessionShutdownSignals, startInactiveSessionRuntime } = await import("../../src/edge/node/session-runtime.ts");
  const { nativeSessionAttempts, resetNativeSessionAttemptBarrier } = await import("./native-session-attempt-barrier.mjs");

  resetNativeSessionAttemptBarrier(
    mode === "active" ? [{ holdCancel: true }]
      : mode === "replacement" ? [{ holdCancel: true }, { onStart: () => process.stdout.write("DETACHED\n") }]
        : [],
  );
  const runtime = await startInactiveSessionRuntime({
    configuration: parseStandaloneArguments([
      "--port", "0", "--max-live-sessions", "1", "--max-active-attempts", "1",
      "--max-command-body-readers", "1", "--max-command-body-bytes", "4096",
      "--max-retained-source-bytes", "41943040",
    ]),
    fixtureManifestBytes: await readFile(manifestPath),
    artifactRoot: root,
  });
  installInactiveSessionShutdownSignals(runtime);
  process.stdout.write(`READY ${runtime.origin}\n`);

  let activeControl;
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    for (const line of chunk.split(/\r?\n/u)) {
      if (line === "SIGNAL SIGINT") process.emit("SIGINT");
      if (line === "SIGNAL SIGTERM") process.emit("SIGTERM");
      if (line === "JOIN") activeControl?.allowCancelJoin();
    }
  });
  process.stdin.resume();
  process.stdin.unref();

  if (mode === "active" || mode === "replacement") {
    const timer = setInterval(() => {
      const attempt = nativeSessionAttempts()[0];
      if (!attempt) return;
      clearInterval(timer);
      activeControl = attempt;
      process.stdout.write("ATTEMPT\n");
      const joining = setInterval(() => {
        if (!attempt.cancelled) return;
        clearInterval(joining);
        process.stdout.write("JOINING\n");
      }, 1);
    }, 1);
  }
}
