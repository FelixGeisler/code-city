import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http, { ServerResponse } from "node:http";
import net from "node:net";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const barrierUrl = new URL("./fixtures/native-session-attempt-barrier.mjs", import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "./worker-attempt" && context.parentURL?.endsWith("/session-runtime.ts")) {
      return { url: barrierUrl, shortCircuit: true };
    }
    return nextResolve(/^\.\.?\//u.test(specifier) && !/(?:\.[a-z]+|\?.*)$/iu.test(specifier) ? `${specifier}.ts` : specifier, context);
  },
});

const { parseStandaloneArguments } = await import("../src/edge/node/config.ts");
const { startInactiveSessionRuntime } = await import("../src/edge/node/session-runtime.ts");
const { nativeSessionAttempts, resetNativeSessionAttemptBarrier } = await import("./fixtures/native-session-attempt-barrier.mjs");

const MAX_SOURCE = 41_943_040;
const VALID_REPOSITORY = "https://github.com/owner/repository";
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "code-city-session-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "public"), { recursive: true });
  const index = Buffer.from("fixture\n");
  await writeFile(path.join(root, "public", "index.html"), index);
  const manifest = Buffer.from(`${JSON.stringify({ version: 1, files: [{
    path: "public/index.html", role: "public", mediaType: "text/html; charset=utf-8",
    length: index.byteLength, sha256: createHash("sha256").update(index).digest("hex"),
  }] })}\n`);
  return { root, manifest };
}

function configuration({ sessions = 2, attempts = 1, readers = 2, bodyBytes = 4096, sourceBytes = MAX_SOURCE } = {}) {
  return parseStandaloneArguments([
    "--port", "0", "--max-live-sessions", String(sessions), "--max-active-attempts", String(attempts),
    "--max-command-body-readers", String(readers), "--max-command-body-bytes", String(bodyBytes),
    "--max-retained-source-bytes", String(sourceBytes),
  ]);
}

async function running(t, capacities) {
  resetNativeSessionAttemptBarrier();
  const controlled = await fixture(t);
  const runtime = await startInactiveSessionRuntime({
    configuration: configuration(capacities), fixtureManifestBytes: controlled.manifest, artifactRoot: controlled.root,
  });
  t.after(() => runtime.close());
  return runtime;
}

function eventStream(response) {
  const events = [];
  const waiters = [];
  let text = "";
  response.setEncoding("utf8");
  response.on("data", (chunk) => {
    text += chunk;
    for (;;) {
      const newline = text.indexOf("\n");
      if (newline < 0) break;
      const line = text.slice(0, newline);
      text = text.slice(newline + 1);
      const event = JSON.parse(line);
      events.push(event);
      for (const waiter of [...waiters]) {
        if (!waiter.predicate(event)) continue;
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(event);
      }
    }
  });
  return {
    events,
    waitFor(predicate, milliseconds = 1000) {
      const existing = events.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve };
        waiters.push(waiter);
        const timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error(`Timed out waiting for event; received ${JSON.stringify(events)}`));
        }, milliseconds);
        waiter.resolve = (event) => { clearTimeout(timer); resolve(event); };
      });
    },
  };
}

function openSession(origin, body = Buffer.alloc(0)) {
  return new Promise((resolve, reject) => {
    const request = http.request(`${origin}/_code-city/session`, {
      method: "POST",
      headers: { Origin: origin, "Content-Length": String(body.byteLength) },
    });
    request.on("response", (response) => {
      if (response.statusCode !== 200) {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => resolve({ response, status: response.statusCode, body: Buffer.concat(chunks) }));
        return;
      }
      const stream = eventStream(response);
      stream.waitFor((event) => event.type === "SESSION_OPENED").then((opened) => {
        resolve({ response, stream, opened, sessionId: opened.sessionId, status: response.statusCode });
      }, reject);
    });
    request.on("error", reject);
    request.end(body);
  });
}

function splitCommand(origin, target, value, splitAt) {
  const body = Buffer.from(JSON.stringify(value));
  const url = new URL(origin);
  let socket;
  const response = new Promise((resolve, reject) => {
    socket = net.createConnection({ host: "127.0.0.1", port: Number(url.port) });
    const chunks = [];
    socket.on("connect", () => {
      socket.write(`POST ${target} HTTP/1.1\r\nHost: ${url.host}\r\nOrigin: ${origin}\r\nContent-Type: application/json\r\nContent-Length: ${body.byteLength}\r\nConnection: close\r\n\r\n`);
      socket.write(body.subarray(0, splitAt));
    });
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("error", reject);
    socket.on("close", () => resolve(Number(/^HTTP\/1\.1 ([0-9]{3})/u.exec(Buffer.concat(chunks).toString("latin1"))?.[1])));
  });
  return { response, finish() { socket.end(body.subarray(splitAt)); } };
}

function command(origin, target, value) {
  const body = Buffer.from(JSON.stringify(value));
  return new Promise((resolve, reject) => {
    const request = http.request(`${origin}${target}`, {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        "Content-Length": String(body.byteLength),
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    request.on("error", reject);
    request.end(body);
  });
}

function analyze(sessionId, generation, repositoryUrl = VALID_REPOSITORY, additionalExclusions = "") {
  return { sessionId, generation, repositoryUrl, additionalExclusions };
}

function control(sessionId, generation) {
  return { sessionId, generation };
}

function sampleCity() {
  return {
    geometry: {
      kind: "code-city/instances-v1", count: 1,
      origins: new Float32Array([0, 0, 0]), sizes: new Float32Array([3, 4, 3]),
      rgba: new Uint8Array([34, 197, 94, 255]), bounds: new Float32Array([0, 0, 0, 3, 4, 3]),
    },
    inspection: [{ canonicalPath: "a.ts", S: 0, U: 0, M: 0 }],
    presentation: { plates: [{ minimum: [-3, -0.5, -3], dimensions: [9, 0.5, 9] }], sceneBounds: [-3, -0.5, -3, 6, 4, 6], centre: [1.5, 1.75, 1.5] },
    districts: [{ root: true, identity: "_root" }],
  };
}

async function rawStatus(origin, target, headers, body = "") {
  const url = new URL(origin);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port: Number(url.port) });
    const chunks = [];
    socket.on("connect", () => socket.end(`POST ${target} HTTP/1.1\r\nHost: ${url.host}\r\nOrigin: ${origin}\r\n${headers.join("\r\n")}\r\n\r\n${body}`));
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("error", reject);
    socket.on("close", () => {
      const bytes = Buffer.concat(chunks);
      resolve({ status: Number(/^HTTP\/1\.1 ([0-9]{3})/u.exec(bytes.toString("latin1"))?.[1]), bytes });
    });
  });
}

test("production session composition exposes no provider, worker-fault, environment, HTTP, or diagnostic selector", async () => {
  const source = await readFile(new URL("../src/edge/node/session-runtime.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /workerFactory|workerUrl|process\.env|console\.|searchParams|fault selector|provider selector/u);
  assert.match(source, /startNodeWorkerAttempt\(\{/u);
});

test("session ownership starts after empty-body admission, uses a 32-byte identity, has no idle expiry, and releases exactly once", async (t) => {
  const runtime = await running(t, { sessions: 1 });
  const first = await openSession(runtime.origin);
  assert.equal(first.status, 200);
  assert.equal(first.response.headers["content-type"], "application/x-ndjson; charset=utf-8");
  assert.deepEqual(first.opened, { type: "SESSION_OPENED", sessionId: first.sessionId });
  assert.match(first.sessionId, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(Buffer.from(first.sessionId, "base64url").byteLength, 32);
  await sleep(30);
  assert.equal(first.response.destroyed, false);

  const exhausted = await openSession(runtime.origin);
  assert.equal(exhausted.status, 503);
  assert.equal(exhausted.body.byteLength, 0);
  assert.equal(exhausted.response.headers.connection, "close");
  const nonempty = await rawStatus(runtime.origin, "/_code-city/session", ["Content-Length: 1"], "x");
  assert.equal(nonempty.status, 400);
  assert.match(nonempty.bytes.toString("latin1"), /Connection: close/iu);

  first.response.destroy();
  for (let index = 0; index < 50; index += 1) {
    const replacement = await openSession(runtime.origin);
    if (replacement.status === 200) {
      assert.notEqual(replacement.sessionId, first.sessionId);
      replacement.response.destroy();
      return;
    }
    await sleep(5);
  }
  assert.fail("session ownership was not released after response loss");
});

test("analyze waits for exact complete parsing, preserves generations on protocol failures, and consumes semantic invalid input", async (t) => {
  resetNativeSessionAttemptBarrier([{ holdCancel: true }]);
  const controlled = await fixture(t);
  const runtime = await startInactiveSessionRuntime({
    configuration: configuration({ sessions: 2, attempts: 1, readers: 2 }),
    fixtureManifestBytes: controlled.manifest, artifactRoot: controlled.root,
  });
  t.after(() => runtime.close());
  const owner = await openSession(runtime.origin);

  const malformed = await command(runtime.origin, "/_code-city/analyze", { ...analyze(owner.sessionId, 1), extra: true });
  assert.equal(malformed.status, 400);
  assert.equal(nativeSessionAttempts().length, 0);
  const unsupported = await rawStatus(runtime.origin, "/_code-city/analyze", ["Content-Type: text/plain", "Content-Length: 2"], "{}");
  assert.equal(unsupported.status, 415);
  const oversized = await rawStatus(runtime.origin, "/_code-city/analyze", ["Content-Type: application/json", "Content-Length: 5000"], "x".repeat(5000));
  assert.equal(oversized.status, 413);
  assert.equal(nativeSessionAttempts().length, 0);
  const split = splitCommand(runtime.origin, "/_code-city/analyze", analyze(owner.sessionId, 1), 10);
  await sleep(20);
  assert.equal(nativeSessionAttempts().length, 0, "partial body mutated state");
  split.finish();
  assert.equal(await split.response, 202);
  assert.equal(nativeSessionAttempts().length, 1);

  const invalidPromise = command(runtime.origin, "/_code-city/analyze", analyze(owner.sessionId, 2, "not-a-repository"));
  while (!nativeSessionAttempts()[0].cancelled) await sleep(1);
  const busy = await command(runtime.origin, "/_code-city/cancel", control(owner.sessionId, 1));
  assert.equal(busy.status, 409);
  assert.equal(nativeSessionAttempts().length, 1);
  nativeSessionAttempts()[0].allowCancelJoin();
  assert.equal((await invalidPromise).status, 422);
  assert.equal((await command(runtime.origin, "/_code-city/analyze", analyze(owner.sessionId, 2))).status, 409);
  assert.equal((await command(runtime.origin, "/_code-city/analyze", analyze(owner.sessionId, 3))).status, 202);
  owner.response.destroy();
});

test("post-cleanup capacity rejection consumes generation and never starts a worker or emits an event", async (t) => {
  const runtime = await running(t, { sessions: 2, attempts: 2, sourceBytes: MAX_SOURCE });
  const first = await openSession(runtime.origin);
  const second = await openSession(runtime.origin);
  assert.equal((await command(runtime.origin, "/_code-city/analyze", analyze(first.sessionId, 1))).status, 202);
  const attempt = nativeSessionAttempts()[0];
  attempt.select();
  attempt.success();
  await first.stream.waitFor((event) => event.type === "ANALYSIS_ALL_FILES_FAILED");
  const before = second.stream.events.length;
  assert.equal((await command(runtime.origin, "/_code-city/analyze", analyze(second.sessionId, 1))).status, 503);
  assert.equal(nativeSessionAttempts().length, 1);
  assert.equal((await command(runtime.origin, "/_code-city/analyze", analyze(second.sessionId, 1))).status, 409);
  await sleep(20);
  assert.equal(second.stream.events.length, before);
  assert.equal((await command(runtime.origin, "/_code-city/discard", control(first.sessionId, 1))).status, 204);
  await first.stream.waitFor((event) => event.type === "CURRENT_DISCARDED");
  assert.equal((await command(runtime.origin, "/_code-city/analyze", analyze(second.sessionId, 2))).status, 202);
  assert.equal(nativeSessionAttempts().length, 2);
  first.response.destroy();
  second.response.destroy();
});

test("success shrinks the 40 MiB reservation only to exact retained normalized bytes", async (t) => {
  const runtime = await running(t, { sessions: 2, attempts: 2, sourceBytes: MAX_SOURCE + 1 });
  const first = await openSession(runtime.origin);
  const second = await openSession(runtime.origin);
  assert.equal((await command(runtime.origin, "/_code-city/analyze", analyze(first.sessionId, 1))).status, 202);
  const attempt = nativeSessionAttempts()[0];
  attempt.select();
  attempt.success({ sources: [{ canonicalPath: "a.ts", normalizedUtf8: new Uint8Array([120]) }] });
  await first.stream.waitFor((event) => event.type === "ANALYSIS_ALL_FILES_FAILED");
  assert.equal((await command(runtime.origin, "/_code-city/analyze", analyze(second.sessionId, 1))).status, 202);
  assert.equal(nativeSessionAttempts().length, 2);
  first.response.destroy();
  second.response.destroy();
});

test("worker construction failure is an accepted joined-mapping event and releases admission immediately", async (t) => {
  resetNativeSessionAttemptBarrier([{ throwStart: true }, {}]);
  const controlled = await fixture(t);
  const runtime = await startInactiveSessionRuntime({
    configuration: configuration({ sessions: 1, attempts: 1, sourceBytes: MAX_SOURCE }),
    fixtureManifestBytes: controlled.manifest, artifactRoot: controlled.root,
  });
  t.after(() => runtime.close());
  const owner = await openSession(runtime.origin);
  assert.equal((await command(runtime.origin, "/_code-city/analyze", analyze(owner.sessionId, 1))).status, 202);
  assert.deepEqual(await owner.stream.waitFor((event) => event.type === "ANALYSIS_FAILED"), {
    type: "ANALYSIS_FAILED", sessionId: owner.sessionId, generation: 1, category: "Provider/resolution failure",
  });
  assert.equal((await command(runtime.origin, "/_code-city/analyze", analyze(owner.sessionId, 2))).status, 202);
  assert.equal(nativeSessionAttempts().length, 1);
  owner.response.destroy();
});

test("progress emitted before the active wrapper exists is omitted rather than buffered", async (t) => {
  resetNativeSessionAttemptBarrier([{ progressOnStart: true }]);
  const controlled = await fixture(t);
  const runtime = await startInactiveSessionRuntime({
    configuration: configuration({ sessions: 1, attempts: 1, sourceBytes: MAX_SOURCE }),
    fixtureManifestBytes: controlled.manifest,
    artifactRoot: controlled.root,
  });
  t.after(() => runtime.close());
  const owner = await openSession(runtime.origin);
  assert.equal((await command(runtime.origin, "/_code-city/analyze", analyze(owner.sessionId, 1))).status, 202);
  const attempt = nativeSessionAttempts()[0];
  attempt.select();
  await owner.stream.waitFor((event) => event.type === "REVISION_SELECTED");
  assert.equal(owner.stream.events.some((event) => event.type === "ANALYSIS_PROGRESS"), false);
  attempt.progress({ stage: "acquisition", completed: 1, total: 1 });
  const progress = await owner.stream.waitFor((event) => event.type === "ANALYSIS_PROGRESS");
  assert.equal(progress.completed, 1);
  owner.response.destroy();
});

test("events use exact source-free schemas, terminal cancel preserves current state, and discard releases it once", async (t) => {
  const runtime = await running(t, { sourceBytes: MAX_SOURCE * 2 });
  const owner = await openSession(runtime.origin);

  assert.equal((await command(runtime.origin, "/_code-city/analyze", analyze(owner.sessionId, 1))).status, 202);
  let attempt = nativeSessionAttempts()[0];
  attempt.select();
  const selected = await owner.stream.waitFor((event) => event.type === "REVISION_SELECTED" && event.generation === 1);
  attempt.progress({ stage: "acquisition", completed: 0, total: 2 });
  const acquisition = await owner.stream.waitFor((event) => event.type === "ANALYSIS_PROGRESS" && event.stage === "acquisition");
  attempt.progress({ stage: "analysis-initialization" });
  const initialization = await owner.stream.waitFor((event) => event.type === "ANALYSIS_PROGRESS" && event.stage === "analysis-initialization");
  attempt.progress({ stage: "analysis", completed: 0, total: 1 });
  const analysis = await owner.stream.waitFor((event) => event.type === "ANALYSIS_PROGRESS" && event.stage === "analysis");
  attempt.progress({ stage: "city-construction" });
  const construction = await owner.stream.waitFor((event) => event.type === "ANALYSIS_PROGRESS" && event.stage === "city-construction");
  attempt.failure({ revision: "a".repeat(40), category: "No supported modules", code: "ADM-06" });
  const failed = await owner.stream.waitFor((event) => event.type === "ANALYSIS_FAILED" && event.generation === 1);
  assert.deepEqual(Object.keys(selected), ["type", "sessionId", "generation", "revision"]);
  assert.deepEqual(Object.keys(acquisition), ["type", "sessionId", "generation", "revision", "stage", "completed", "total"]);
  assert.deepEqual(Object.keys(initialization), ["type", "sessionId", "generation", "revision", "stage"]);
  assert.deepEqual(Object.keys(analysis), ["type", "sessionId", "generation", "revision", "stage", "completed", "total"]);
  assert.deepEqual(Object.keys(construction), ["type", "sessionId", "generation", "revision", "stage"]);
  assert.equal(JSON.stringify([acquisition, initialization, analysis, construction]).includes("source"), false);
  assert.deepEqual(Object.keys(failed), ["type", "sessionId", "generation", "revision", "category", "code"]);

  assert.equal((await command(runtime.origin, "/_code-city/analyze", analyze(owner.sessionId, 2))).status, 202);
  attempt = nativeSessionAttempts()[1];
  attempt.select("b".repeat(40));
  attempt.success({ revision: "b".repeat(40) });
  const allFailed = await owner.stream.waitFor((event) => event.type === "ANALYSIS_ALL_FILES_FAILED" && event.generation === 2);
  assert.deepEqual(Object.keys(allFailed), ["type", "sessionId", "generation", "revision", "notAnalyzedFiles"]);
  const countBeforeCancel = owner.stream.events.length;
  assert.equal((await command(runtime.origin, "/_code-city/cancel", control(owner.sessionId, 2))).status, 204);
  await sleep(20);
  assert.equal(owner.stream.events.length, countBeforeCancel);
  assert.equal((await command(runtime.origin, "/_code-city/discard", control(owner.sessionId, 2))).status, 204);
  const discarded = await owner.stream.waitFor((event) => event.type === "CURRENT_DISCARDED" && event.generation === 2);
  assert.deepEqual(Object.keys(discarded), ["type", "sessionId", "generation"]);
  const countBeforeRepeat = owner.stream.events.length;
  assert.equal((await command(runtime.origin, "/_code-city/discard", control(owner.sessionId, 2))).status, 204);
  await sleep(20);
  assert.equal(owner.stream.events.length, countBeforeRepeat);

  assert.equal((await command(runtime.origin, "/_code-city/analyze", analyze(owner.sessionId, 3))).status, 202);
  attempt = nativeSessionAttempts()[2];
  attempt.select("c".repeat(40));
  attempt.success({
    revision: "c".repeat(40), city: sampleCity(), notAnalyzedFiles: [],
    sources: [{ canonicalPath: "a.ts", normalizedUtf8: new Uint8Array([120]) }],
  });
  const succeeded = await owner.stream.waitFor((event) => event.type === "ANALYSIS_SUCCEEDED" && event.generation === 3);
  assert.deepEqual(Object.keys(succeeded), ["type", "sessionId", "generation", "revision", "city", "notAnalyzedFiles"]);
  assert.equal(JSON.stringify(succeeded).includes("normalizedUtf8"), false);
  assert.deepEqual(succeeded.city.geometry.origins, [0, 0, 0]);
  assert.deepEqual(succeeded.city.inspection, [{ canonicalPath: "a.ts", S: 0, U: 0, M: 0 }]);
  owner.response.destroy();
});

test("replacement and active controls join before release, emit only their own control event, and suppress stale completion", async (t) => {
  resetNativeSessionAttemptBarrier([{ holdCancel: true }, {}, { holdCancel: true }]);
  const controlled = await fixture(t);
  const runtime = await startInactiveSessionRuntime({
    configuration: configuration({ sourceBytes: MAX_SOURCE }), fixtureManifestBytes: controlled.manifest, artifactRoot: controlled.root,
  });
  t.after(() => runtime.close());
  const owner = await openSession(runtime.origin);
  assert.equal((await command(runtime.origin, "/_code-city/analyze", analyze(owner.sessionId, 1))).status, 202);
  const old = nativeSessionAttempts()[0];
  old.select();
  const replace = command(runtime.origin, "/_code-city/analyze", analyze(owner.sessionId, 2));
  while (!old.cancelled) await sleep(1);
  old.failure({ revision: "a".repeat(40) });
  assert.equal((await replace).status, 202);
  assert.equal(nativeSessionAttempts().length, 2);
  await sleep(20);
  assert.equal(owner.stream.events.some((event) => event.type === "ANALYSIS_FAILED" && event.generation === 1), false);

  const current = nativeSessionAttempts()[1];
  const cancel = command(runtime.origin, "/_code-city/cancel", control(owner.sessionId, 2));
  assert.equal((await cancel).status, 204);
  const cancelled = await owner.stream.waitFor((event) => event.type === "ANALYSIS_CANCELLED" && event.generation === 2);
  assert.deepEqual(cancelled, { type: "ANALYSIS_CANCELLED", sessionId: owner.sessionId, generation: 2 });
  assert.equal(current.cancelled, true);

  assert.equal((await command(runtime.origin, "/_code-city/analyze", analyze(owner.sessionId, 3))).status, 202);
  const active = nativeSessionAttempts()[2];
  const discard = command(runtime.origin, "/_code-city/discard", control(owner.sessionId, 3));
  while (!active.cancelled) await sleep(1);
  assert.equal((await command(runtime.origin, "/_code-city/cancel", control(owner.sessionId, 3))).status, 409);
  active.allowCancelJoin();
  assert.equal((await discard).status, 204);
  await owner.stream.waitFor((event) => event.type === "CURRENT_DISCARDED" && event.generation === 3);
  owner.response.destroy();
});

test("response loss during every command-owned join fences replacement and holds all capacity until worker exit", async (t) => {
  for (const operation of ["replacement", "cancel", "discard"]) {
    await t.test(operation, async (t) => {
      resetNativeSessionAttemptBarrier([{ holdCancel: true }, {}]);
      const controlled = await fixture(t);
      const runtime = await startInactiveSessionRuntime({
        configuration: configuration({ sessions: 2, attempts: 1, sourceBytes: MAX_SOURCE }),
        fixtureManifestBytes: controlled.manifest, artifactRoot: controlled.root,
      });
      t.after(() => runtime.close());
      const owner = await openSession(runtime.origin);
      const contender = await openSession(runtime.origin);
      assert.equal((await command(runtime.origin, "/_code-city/analyze", analyze(owner.sessionId, 1))).status, 202);
      const old = nativeSessionAttempts()[0];
      const transition = operation === "replacement"
        ? command(runtime.origin, "/_code-city/analyze", analyze(owner.sessionId, 2))
        : command(runtime.origin, `/_code-city/${operation}`, control(owner.sessionId, 1));
      while (!old.cancelled) await sleep(1);

      let settled = false;
      void transition.then(() => { settled = true; });
      owner.response.destroy();
      for (let index = 0; index < 50; index += 1) {
        const probe = await command(runtime.origin, "/_code-city/cancel", control(owner.sessionId, 1));
        if (probe.status === 404) break;
        assert.equal(probe.status, 409);
        await sleep(2);
        if (index === 49) assert.fail("response loss was not observed during the held join");
      }

      assert.equal(settled, false, "command completed before worker join");
      assert.equal((await openSession(runtime.origin)).status, 503, "session capacity was reused before join");
      assert.equal(
        (await command(runtime.origin, "/_code-city/analyze", analyze(contender.sessionId, 1))).status,
        503,
        "attempt or source capacity was reused before join",
      );
      assert.equal(nativeSessionAttempts().length, 1, "replacement work started before join");

      old.allowCancelJoin();
      assert.equal((await transition).status, 404);
      assert.equal(nativeSessionAttempts().length, 1, "lost session started detached replacement work");

      let replacement;
      for (let index = 0; index < 50; index += 1) {
        replacement = await openSession(runtime.origin);
        if (replacement.status === 200) break;
        await sleep(2);
      }
      assert.equal(replacement?.status, 200, "session capacity was not released after joined loss cleanup");
      assert.equal((await command(runtime.origin, "/_code-city/analyze", analyze(contender.sessionId, 2))).status, 202);
      assert.equal(nativeSessionAttempts().length, 2, "attempt/source capacity was not released after join");
      replacement.response.destroy();
      contender.response.destroy();
    });
  }
});

test("optional progress omits busy writes without serialization, resumes after drain, and never queues a latest value", async (t) => {
  const originalWrite = ServerResponse.prototype.write;
  const priorNeedDrain = Object.getOwnPropertyDescriptor(ServerResponse.prototype, "writableNeedDrain");
  const priorLength = Object.getOwnPropertyDescriptor(ServerResponse.prototype, "writableLength");
  let forceNeedDrain = false;
  let forceLength = false;
  let blockNextProgress = false;
  let blockedResponse;
  let progressWrites = 0;
  ServerResponse.prototype.write = function patchedWrite(chunk, ...args) {
    if (String(chunk).includes('"type":"ANALYSIS_PROGRESS"')) {
      progressWrites += 1;
      const result = originalWrite.call(this, chunk, ...args);
      if (blockNextProgress) {
        blockNextProgress = false;
        blockedResponse = this;
        return false;
      }
      return result;
    }
    return originalWrite.call(this, chunk, ...args);
  };
  Object.defineProperty(ServerResponse.prototype, "writableNeedDrain", {
    configurable: true,
    get() { return forceNeedDrain || false; },
  });
  Object.defineProperty(ServerResponse.prototype, "writableLength", {
    configurable: true,
    get() { return forceLength ? 1 : 0; },
  });
  t.after(() => {
    ServerResponse.prototype.write = originalWrite;
    if (priorNeedDrain) Object.defineProperty(ServerResponse.prototype, "writableNeedDrain", priorNeedDrain);
    else delete ServerResponse.prototype.writableNeedDrain;
    if (priorLength) Object.defineProperty(ServerResponse.prototype, "writableLength", priorLength);
    else delete ServerResponse.prototype.writableLength;
  });

  const runtime = await running(t, { sessions: 1, sourceBytes: MAX_SOURCE });
  const owner = await openSession(runtime.origin);
  assert.equal((await command(runtime.origin, "/_code-city/analyze", analyze(owner.sessionId, 1))).status, 202);
  const attempt = nativeSessionAttempts()[0];
  attempt.select();
  await owner.stream.waitFor((event) => event.type === "REVISION_SELECTED");

  const originalStringify = JSON.stringify;
  let progressSerializations = 0;
  JSON.stringify = function patchedStringify(value, ...args) {
    if (value?.type === "ANALYSIS_PROGRESS") progressSerializations += 1;
    return originalStringify(value, ...args);
  };
  try {
    forceNeedDrain = true;
    attempt.progress({ stage: "acquisition", completed: 0, total: 3 });
    forceNeedDrain = false;
    forceLength = true;
    attempt.progress({ stage: "acquisition", completed: 1, total: 3 });
    forceLength = false;
    assert.equal(progressSerializations, 0);
    assert.equal(progressWrites, 0);

    attempt.progress({ stage: "acquisition", completed: 2, total: 3 });
    await owner.stream.waitFor((event) => event.type === "ANALYSIS_PROGRESS" && event.completed === 2);
    assert.equal(progressSerializations, 1);
    assert.equal(progressWrites, 1);

    blockNextProgress = true;
    attempt.progress({ stage: "acquisition", completed: 3, total: 3 });
    await owner.stream.waitFor((event) => event.type === "ANALYSIS_PROGRESS" && event.completed === 3);
    assert.ok(blockedResponse);
    attempt.progress({ stage: "analysis-initialization" });
    assert.equal(progressSerializations, 2, "blocked progress was serialized");
    assert.equal(progressWrites, 2, "blocked progress was written");

    blockedResponse.emit("drain");
    attempt.progress({ stage: "analysis", completed: 1, total: 1 });
    await owner.stream.waitFor((event) => event.type === "ANALYSIS_PROGRESS" && event.stage === "analysis");
    assert.equal(owner.stream.events.some((event) => event.stage === "analysis-initialization"), false);
    attempt.failure({ revision: "a".repeat(40) });
    await owner.stream.waitFor((event) => event.type === "ANALYSIS_FAILED");
  } finally {
    JSON.stringify = originalStringify;
  }
  owner.response.destroy();
});

test("one blocked valid frame waits for drain, while a command or second event during blockage causes joined session loss", async (t) => {
  const originalWrite = ServerResponse.prototype.write;
  let mode = "none";
  let blockedResponse;
  ServerResponse.prototype.write = function patchedWrite(chunk, ...args) {
    const result = originalWrite.call(this, chunk, ...args);
    const text = String(chunk);
    if (mode !== "none" && text.includes(`\"type\":\"${mode}\"`)) {
      blockedResponse = this;
      return false;
    }
    return result;
  };
  t.after(() => { ServerResponse.prototype.write = originalWrite; });

  const runtime = await running(t, { sessions: 1, sourceBytes: MAX_SOURCE });
  let owner = await openSession(runtime.origin);
  assert.equal((await command(runtime.origin, "/_code-city/analyze", analyze(owner.sessionId, 1))).status, 202);
  let attempt = nativeSessionAttempts()[0];
  attempt.select();
  mode = "ANALYSIS_ALL_FILES_FAILED";
  const largeFailures = Array.from({ length: 4000 }, (_, index) => ({
    canonicalPath: `file-${String(index).padStart(4, "0")}-${"x".repeat(64)}.ts`,
    category: "Syntax could not be analyzed",
  }));
  attempt.success({
    notAnalyzedFiles: largeFailures,
    sources: largeFailures.map(({ canonicalPath }) => ({ canonicalPath, normalizedUtf8: new Uint8Array([120]) })),
  });
  const largeFrame = await owner.stream.waitFor((event) => event.type === "ANALYSIS_ALL_FILES_FAILED");
  assert.ok(Buffer.byteLength(JSON.stringify(largeFrame)) > 262_144, "test frame must exercise a valid large envelope");
  assert.ok(blockedResponse);
  mode = "none";
  blockedResponse.emit("drain");
  assert.equal((await command(runtime.origin, "/_code-city/discard", control(owner.sessionId, 1))).status, 204);
  await owner.stream.waitFor((event) => event.type === "CURRENT_DISCARDED");
  owner.response.destroy();
  await sleep(20);

  owner = await openSession(runtime.origin);
  resetNativeSessionAttemptBarrier([{ holdCancel: true }]);
  assert.equal((await command(runtime.origin, "/_code-city/analyze", analyze(owner.sessionId, 1))).status, 202);
  attempt = nativeSessionAttempts()[0];
  mode = "REVISION_SELECTED";
  attempt.select();
  await owner.stream.waitFor((event) => event.type === "REVISION_SELECTED");
  assert.equal((await command(runtime.origin, "/_code-city/cancel", control(owner.sessionId, 1))).status, 409);
  while (!attempt.cancelled) await sleep(1);
  assert.equal((await openSession(runtime.origin)).status, 503, "session capacity must not be reused before join");
  mode = "none";
  attempt.allowCancelJoin();
  let releasedAfterJoin = false;
  for (let index = 0; index < 50; index += 1) {
    const replacement = await openSession(runtime.origin);
    if (replacement.status === 200) {
      releasedAfterJoin = true;
      replacement.response.destroy();
      break;
    }
    await sleep(5);
  }
  assert.equal(releasedAfterJoin, true, "blocked-command loss did not release after join");
  await sleep(20);

  owner = await openSession(runtime.origin);
  resetNativeSessionAttemptBarrier();
  assert.equal((await command(runtime.origin, "/_code-city/analyze", analyze(owner.sessionId, 1))).status, 202);
  attempt = nativeSessionAttempts()[0];
  mode = "REVISION_SELECTED";
  attempt.select();
  await owner.stream.waitFor((event) => event.type === "REVISION_SELECTED");
  attempt.failure({ revision: "a".repeat(40) });
  await sleep(20);
  assert.equal(owner.stream.events.some((event) => event.type === "ANALYSIS_FAILED"), false);
  mode = "none";
  let releasedAfterSecondEvent = false;
  for (let index = 0; index < 50; index += 1) {
    const replacement = await openSession(runtime.origin);
    if (replacement.status === 200) {
      releasedAfterSecondEvent = true;
      replacement.response.destroy();
      break;
    }
    await sleep(5);
  }
  assert.equal(releasedAfterSecondEvent, true, "second-event loss did not release session ownership");
});
