import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalStandaloneRoot } from "./build-standalone.mjs";

export const SERVER_ARGUMENTS = Object.freeze(["--port", "0"]);

export function launchStandalone({ preload, serverArguments = SERVER_ARGUMENTS } = {}) {
  const entry = path.join(canonicalStandaloneRoot, "server", "standalone.mjs");
  const args = [...(preload ? ["--import", pathToFileURL(preload).href] : []), entry, ...serverArguments];
  const child = spawn(process.execPath, args, { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "", pending = "";
  const lines = [], waiters = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => { stderr += chunk; });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    pending += chunk;
    for (;;) {
      const newline = pending.indexOf("\n");
      if (newline < 0) break;
      const line = pending.slice(0, newline); pending = pending.slice(newline + 1); lines.push(line);
      for (const waiter of [...waiters]) if (waiter.predicate(line)) {
        waiters.splice(waiters.indexOf(waiter), 1); clearTimeout(waiter.timer); waiter.resolve(line);
      }
    }
  });
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      for (const waiter of waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error(`Standalone exited before expected output: ${stderr}`));
      }
      resolve({ code, signal, stderr, lines });
    });
  });
  return {
    child, lines, exited,
    waitLine(predicate, milliseconds = 10_000) {
      const existing = lines.find(predicate);
      if (existing !== undefined) return Promise.resolve(existing);
      if (child.exitCode !== null || child.signalCode !== null) return Promise.reject(new Error(`Standalone already exited: ${stderr}`));
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, reject, timer: undefined };
        waiter.timer = setTimeout(() => {
          const index = waiters.indexOf(waiter); if (index >= 0) waiters.splice(index, 1);
          reject(new Error(`Standalone line timeout; lines=${JSON.stringify(lines)} stderr=${stderr}`));
        }, milliseconds);
        waiters.push(waiter);
      });
    },
    diagnostic() { return `${stderr}\n${lines.join("\n")}`; },
  };
}
export async function readyOrigin(processUnderTest) {
  return (await processUnderTest.waitLine(line => line.startsWith("READY "))).slice(6);
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
  processUnderTest.child.kill(process.platform === "win32" ? undefined : "SIGKILL");
  await processUnderTest.exited.catch(() => {});
}
export function request(origin, target, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const bytes = body === undefined ? undefined : Buffer.from(body);
    const client = http.request(`${origin}${target}`, {
      method, headers: { ...headers, ...(bytes ? { "Content-Length": String(bytes.length) } : {}) },
    }, response => {
      const chunks = []; response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    client.on("error", reject); client.end(bytes);
  });
}
export async function writeSignalPreload(directory) {
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, "signal-preload.mjs");
  await writeFile(file, `if(process.platform==='win32'){process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{for(const line of chunk.split(/\\r?\\n/u)){if(line==='SIGNAL SIGINT')process.emit('SIGINT');if(line==='SIGNAL SIGTERM')process.emit('SIGTERM');}});process.stdin.resume();process.stdin.unref?.();}\n`, "utf8");
  return file;
}
