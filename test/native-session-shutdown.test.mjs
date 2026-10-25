import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const childEntry = path.join(projectRoot, "test", "fixtures", "native-session-signal-child.mjs");
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function artifact(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "code-city-session-signal-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "public"), { recursive: true });
  const index = Buffer.from("fixture\n");
  await writeFile(path.join(root, "public", "index.html"), index);
  const manifestPath = path.join(root, "manifest.json");
  await writeFile(manifestPath, `${JSON.stringify({ version: 1, files: [{
    path: "public/index.html", role: "public", mediaType: "text/html; charset=utf-8",
    length: index.byteLength, sha256: createHash("sha256").update(index).digest("hex"),
  }] })}\n`);
  return { root, manifestPath };
}

function launch(t, mode, controlled) {
  const child = spawn(process.execPath, [childEntry, mode, controlled.root, controlled.manifestPath], {
    cwd: projectRoot,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });

  let text = "";
  const lines = [];
  const waiters = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    text += chunk;
    for (;;) {
      const newline = text.indexOf("\n");
      if (newline < 0) break;
      const line = text.slice(0, newline);
      text = text.slice(newline + 1);
      lines.push(line);
      for (const waiter of [...waiters]) {
        if (!waiter.predicate(line)) continue;
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(line);
      }
    }
  });
  const waitLine = (predicate, milliseconds = 3000) => {
    const existing = lines.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve };
      waiters.push(waiter);
      const timer = setTimeout(() => reject(new Error(`child line timeout: ${JSON.stringify(lines)} ${stderr}`)), milliseconds);
      waiter.resolve = (line) => { clearTimeout(timer); resolve(line); };
    });
  };
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal, stderr, lines }));
  });
  return { child, waitLine, exited };
}

function openSession(origin) {
  return new Promise((resolve, reject) => {
    const request = http.request(`${origin}/_code-city/session`, {
      method: "POST", headers: { Origin: origin, "Content-Length": "0" },
    }, (response) => {
      response.setEncoding("utf8");
      let text = "";
      response.on("data", (chunk) => {
        text += chunk;
        const newline = text.indexOf("\n");
        if (newline < 0) return;
        const opened = JSON.parse(text.slice(0, newline));
        resolve({ response, sessionId: opened.sessionId });
      });
    });
    request.on("error", reject);
    request.end();
  });
}

function analyze(origin, sessionId, generation = 1) {
  const bytes = Buffer.from(JSON.stringify({
    sessionId, generation, repositoryUrl: "https://github.com/owner/repository", additionalExclusions: "",
  }));
  return new Promise((resolve, reject) => {
    const request = http.request(`${origin}/_code-city/analyze`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json", "Content-Length": String(bytes.byteLength) },
    }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode));
    });
    request.on("error", reject);
    request.end(bytes);
  });
}

function sendSignal(child, signal) {
  if (process.platform === "win32") child.stdin.write(`SIGNAL ${signal}\n`);
  else child.kill(signal);
}

async function expectCleanExit(exited) {
  const result = await exited;
  assert.deepEqual({ code: result.code, signal: result.signal }, { code: 0, signal: null }, `${result.stderr}\n${result.lines.join("\n")}`);
  return result;
}

test("SIGINT exits successfully with no session only after the listener is closed", async (t) => {
  const controlled = await artifact(t);
  const processUnderTest = launch(t, "none", controlled);
  await processUnderTest.waitLine((line) => line.startsWith("READY "));
  sendSignal(processUnderTest.child, "SIGINT");
  await expectCleanExit(processUnderTest.exited);
});

test("SIGTERM closes an owned session response and releases all ownership before exit", async (t) => {
  const controlled = await artifact(t);
  const processUnderTest = launch(t, "owned", controlled);
  const ready = await processUnderTest.waitLine((line) => line.startsWith("READY "));
  const owner = await openSession(ready.slice("READY ".length));
  const responseEnded = new Promise((resolve) => owner.response.once("end", resolve));
  sendSignal(processUnderTest.child, "SIGTERM");
  await responseEnded;
  await expectCleanExit(processUnderTest.exited);
});

test("SIGINT refuses to exit during an active deterministic attempt until worker join completes", async (t) => {
  const controlled = await artifact(t);
  const processUnderTest = launch(t, "active", controlled);
  const ready = await processUnderTest.waitLine((line) => line.startsWith("READY "));
  const origin = ready.slice("READY ".length);
  const owner = await openSession(origin);
  assert.equal(await analyze(origin, owner.sessionId), 202);
  await processUnderTest.waitLine((line) => line === "ATTEMPT");
  sendSignal(processUnderTest.child, "SIGINT");
  await processUnderTest.waitLine((line) => line === "JOINING");
  const early = await Promise.race([processUnderTest.exited.then(() => true), sleep(75).then(() => false)]);
  assert.equal(early, false, "process exited before worker join");
  processUnderTest.child.stdin.write("JOIN\n");
  await expectCleanExit(processUnderTest.exited);
});

test("SIGTERM during a replacement join keeps response ownership and cannot start detached work", async (t) => {
  const controlled = await artifact(t);
  const processUnderTest = launch(t, "replacement", controlled);
  const ready = await processUnderTest.waitLine((line) => line.startsWith("READY "));
  const origin = ready.slice("READY ".length);
  const owner = await openSession(origin);
  assert.equal(await analyze(origin, owner.sessionId), 202);
  await processUnderTest.waitLine((line) => line === "ATTEMPT");
  const replacement = analyze(origin, owner.sessionId, 2);
  await processUnderTest.waitLine((line) => line === "JOINING");

  let responseEnded = false;
  const ended = new Promise((resolve) => {
    const complete = () => { responseEnded = true; resolve(); };
    owner.response.once("end", complete);
    owner.response.once("close", complete);
  });
  sendSignal(processUnderTest.child, "SIGTERM");
  const earlyExit = await Promise.race([processUnderTest.exited.then(() => true), sleep(75).then(() => false)]);
  assert.equal(earlyExit, false, "process exited before replacement join");
  assert.equal(responseEnded, false, "session response ownership ended before replacement join");

  processUnderTest.child.stdin.write("JOIN\n");
  assert.equal(await replacement, 404);
  await ended;
  const result = await expectCleanExit(processUnderTest.exited);
  assert.equal(result.lines.includes("DETACHED"), false, "shutdown admitted detached replacement work");
});
