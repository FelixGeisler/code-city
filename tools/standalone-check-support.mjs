import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalStandaloneRoot } from "./build-standalone.mjs";

export const CAPACITY_ARGUMENTS = Object.freeze([
  "--port", "0",
  "--max-live-sessions", "2",
  "--max-active-attempts", "1",
  "--max-command-body-readers", "2",
  "--max-command-body-bytes", "4096",
  "--max-retained-source-bytes", "41943040",
]);

export function launchStandalone({ preload, capacityArguments = CAPACITY_ARGUMENTS } = {}) {
  const entry = path.join(canonicalStandaloneRoot, "server", "standalone.mjs");
  const args = [...(preload ? ["--import", pathToFileURL(preload).href] : []), entry, ...capacityArguments];
  const child = spawn(process.execPath, args, { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  const lines = [];
  const waiters = [];
  let pending = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    pending += chunk;
    for (;;) {
      const newline = pending.indexOf("\n");
      if (newline < 0) break;
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      lines.push(line);
      for (const waiter of [...waiters]) {
        if (!waiter.predicate(line)) continue;
        waiters.splice(waiters.indexOf(waiter), 1);
        clearTimeout(waiter.timer);
        waiter.resolve(line);
      }
    }
  });
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal, stderr, lines }));
  });
  return {
    child,
    lines,
    exited,
    waitLine(predicate, milliseconds = 10_000) {
      const existing = lines.find(predicate);
      if (existing !== undefined) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, timer: undefined };
        waiter.timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error(`Standalone line timeout; lines=${JSON.stringify(lines)} stderr=${stderr}`));
        }, milliseconds);
        waiters.push(waiter);
      });
    },
    diagnostic() { return `${stderr}\n${lines.join("\n")}`; },
  };
}

export async function readyOrigin(processUnderTest) {
  const line = await processUnderTest.waitLine((value) => value.startsWith("READY "));
  return line.slice("READY ".length);
}

export function sendGracefulSignal(processUnderTest, signal) {
  if (process.platform === "win32") processUnderTest.child.stdin.write(`SIGNAL ${signal}\n`);
  else if (!processUnderTest.child.kill(signal)) throw new Error(`Could not send ${signal}`);
}

export async function expectCleanExit(processUnderTest) {
  const result = await processUnderTest.exited;
  if (result.code !== 0 || result.signal !== null) throw new Error(`Standalone exit was not clean: ${JSON.stringify(result)}\n${processUnderTest.diagnostic()}`);
  return result;
}

export async function terminateForCleanup(processUnderTest) {
  if (processUnderTest.child.exitCode !== null || processUnderTest.child.signalCode !== null) return;
  if (process.platform === "win32") processUnderTest.child.kill();
  else processUnderTest.child.kill("SIGKILL");
  await processUnderTest.exited.catch(() => {});
}

export function request(origin, target, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const requestBody = body === undefined ? undefined : Buffer.from(body);
    const client = http.request(`${origin}${target}`, {
      method,
      headers: {
        ...headers,
        ...(requestBody ? { "Content-Length": String(requestBody.byteLength) } : {}),
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    client.on("error", reject);
    client.end(requestBody);
  });
}

function eventStream(response) {
  const events = [];
  const waiters = [];
  let pending = "";
  response.setEncoding("utf8");
  response.on("data", (chunk) => {
    pending += chunk;
    for (;;) {
      const newline = pending.indexOf("\n");
      if (newline < 0) break;
      const event = JSON.parse(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
      events.push(event);
      for (const waiter of [...waiters]) {
        if (!waiter.predicate(event)) continue;
        waiters.splice(waiters.indexOf(waiter), 1);
        clearTimeout(waiter.timer);
        waiter.resolve(event);
      }
    }
  });
  return {
    events,
    waitFor(predicate, milliseconds = 20_000) {
      const existing = events.find(predicate);
      if (existing !== undefined) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, timer: undefined };
        waiter.timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error(`Standalone event timeout; events=${JSON.stringify(events)}`));
        }, milliseconds);
        waiters.push(waiter);
      });
    },
  };
}

export function openSession(origin) {
  return new Promise((resolve, reject) => {
    const client = http.request(`${origin}/_code-city/session`, {
      method: "POST",
      headers: { Origin: origin, "Content-Length": "0" },
    });
    client.once("response", (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Session status ${response.statusCode}`));
        return;
      }
      const stream = eventStream(response);
      stream.waitFor((event) => event.type === "SESSION_OPENED").then((event) => resolve({ response, stream, sessionId: event.sessionId }), reject);
    });
    client.once("error", reject);
    client.end();
  });
}

export async function analyze(origin, sessionId) {
  const result = await request(origin, "/_code-city/analyze", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId,
      generation: 1,
      repositoryUrl: "https://github.com/fixture/standalone",
      additionalExclusions: "",
    }),
  });
  if (result.status !== 202 || result.body.byteLength !== 0) throw new Error(`Analyze status mismatch: ${result.status}`);
}

export async function writeSignalPreload(directory, chainedPreload) {
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, "signal-preload.mjs");
  await writeFile(file, `import { isMainThread } from "node:worker_threads";\n${chainedPreload ? `import ${JSON.stringify(pathToFileURL(chainedPreload).href)};\n` : ""}if (process.platform === "win32" && isMainThread) {\n  process.stdin.setEncoding("utf8");\n  process.stdin.on("data", (chunk) => { for (const line of chunk.split(/\\r?\\n/u)) { if (line === "SIGNAL SIGINT") process.emit("SIGINT"); if (line === "SIGNAL SIGTERM") process.emit("SIGTERM"); } });\n  process.stdin.resume();\n  process.stdin.unref?.();\n}\n`, "utf8");
  return file;
}

export async function writeProviderHarness(directory, { blockInventory = false, observeJoin = false } = {}) {
  await mkdir(directory, { recursive: true });
  const packageUrl = (relative) => pathToFileURL(path.join(canonicalStandaloneRoot, ...relative.split("/"))).href;
  const wrapper = path.join(directory, "worker-attempt.mjs");
  const revisionModule = path.join(directory, "revision-gateway.mjs");
  const sourceModule = path.join(directory, "source-gateway.mjs");
  const preload = path.join(directory, "provider-preload.mjs");
  const revision = "a".repeat(40);
  const blob = "b".repeat(40);
  const sourceRows = {
    "fixture.js": "export function choose(a, b) { if (a && b) return a + b; return 0; }\n",
    "fixture.ts": "export interface Value { value: number }\nexport const value: Value = { value: 1 };\n",
    "fixture.tsx": "export const View = () => <main>fixture</main>;\n",
    "Fixture.cs": "public class Fixture { public int Choose(int value) { return value > 0 ? value : 0; } }\n",
  };
  await writeFile(revisionModule, `export function createGithubRevisionGateway() { return async () => ({ kind: "revision", revision: ${JSON.stringify(revision)} }); }\n`, "utf8");
  await writeFile(sourceModule, `const sources = new Map(Object.entries(${JSON.stringify(sourceRows)}).map(([name, source]) => [name, new TextEncoder().encode(source)]));\nexport function createGithubRawSourceGateway() { return {\n  async loadInventory(_repository, _selected, signal) { ${blockInventory ? "await new Promise((resolve) => signal.addEventListener(\"abort\", resolve, { once: true })); return { kind: \"provider-failure\" };" : `return { kind: "inventory", entries: [...sources.keys()].map((sourcePath) => ({ path: sourcePath, mode: "100644", type: "blob", sha: ${JSON.stringify(blob)} })) };`} },\n  async readRawSource(_repository, _selected, candidate) { const rawBytes = sources.get(candidate.rawPath); return rawBytes ? { kind: "source", rawBytes } : { kind: "provider-failure" }; },\n}; }\n`, "utf8");
  await writeFile(wrapper, `import { startNodeWorkerAttempt as startPackagedAttempt } from ${JSON.stringify(packageUrl("server/src/edge/node/worker-attempt.js"))};\nexport function startNodeWorkerAttempt(options) {\n  const attempt = startPackagedAttempt(options);\n  return ${observeJoin ? `{ ...attempt, async cancel() { process.stdout.write("HARNESS_JOINING\\n"); await attempt.cancel(); process.stdout.write("HARNESS_JOINED\\n"); } }` : "attempt"};\n}\n`, "utf8");
  await writeFile(preload, `import { registerHooks } from "node:module";\nconst session = ${JSON.stringify(packageUrl("server/src/edge/node/session-runtime.js"))};\nconst workerEntry = ${JSON.stringify(packageUrl("server/src/edge/node/analysis-worker-entry.js"))};\nconst attemptReplacement = ${JSON.stringify(pathToFileURL(wrapper).href)};\nconst revisionReplacement = ${JSON.stringify(pathToFileURL(revisionModule).href)};\nconst sourceReplacement = ${JSON.stringify(pathToFileURL(sourceModule).href)};\nregisterHooks({ resolve(specifier, context, nextResolve) {\n  if (context.parentURL === session && specifier === "./worker-attempt.js") return { url: attemptReplacement, shortCircuit: true };\n  if (context.parentURL === workerEntry && specifier === "../github-revision-gateway.js") return { url: revisionReplacement, shortCircuit: true };\n  if (context.parentURL === workerEntry && specifier === "../github-source-gateway.js") return { url: sourceReplacement, shortCircuit: true };\n  return nextResolve(specifier, context);\n} });\n`, "utf8");
  return { preload, wrapper, revisionModule, sourceModule };
}
