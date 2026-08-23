import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export function inlineModule(step) {
  const match = /^node --input-type=module <<'NODE'\n([\s\S]*)\nNODE\n?$/u.exec(step.run);
  if (!match) throw new Error(`step ${step.name} is not one inline Node module`);
  return match[1];
}

export async function runModule(source, { cwd, env = {}, prefix = "" } = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module"], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
    child.stdin.end(`${prefix}\n${source}\n`);
  });
}

export async function runEligibility(source, directory, scenario) {
  const observerPath = path.join(directory, "observer.json");
  const outputPath = path.join(directory, "output.txt");
  const prefix = `
import { writeFileSync } from "node:fs";
const observer = { fetched: false, cancelled: false, released: false, reads: 0 };
const scenario = JSON.parse(process.env.TEST_SCENARIO);
process.on("exit", () => writeFileSync(process.env.TEST_OBSERVER, JSON.stringify(observer)));
globalThis.fetch = async (url, options) => {
  observer.fetched = true;
  observer.url = url;
  observer.redirect = options?.redirect;
  observer.accept = options?.headers?.accept;
  observer.authorization = options?.headers?.authorization;
  observer.apiVersion = options?.headers?.["x-github-api-version"];
  if (scenario.kind === "query-error") throw new Error("controlled query failure");
  const maximumBytes = 1024 * 1024;
  const prefix = '{"state":"open","padding":"';
  const suffix = '"}';
  let text;
  if (scenario.kind === "boundary" || scenario.kind === "overflow") {
    const length = maximumBytes + (scenario.kind === "overflow" ? 1 : 0);
    text = prefix + "a".repeat(length - Buffer.byteLength(prefix) - Buffer.byteLength(suffix)) + suffix;
  } else if (scenario.kind === "parse-error") {
    text = '{"state":';
  } else if (scenario.kind === "missing-state") {
    text = '{}';
  } else {
    text = JSON.stringify({ state: scenario.state ?? "open" });
  }
  const chunks = [new TextEncoder().encode(text)];
  let index = 0;
  const reader = {
    async read() {
      observer.reads += 1;
      return index < chunks.length ? { done: false, value: chunks[index++] } : { done: true, value: undefined };
    },
    async cancel() { observer.cancelled = true; },
    releaseLock() { observer.released = true; },
  };
  return {
    url: scenario.kind === "url-error" ? url + "/redirected" : url,
    status: scenario.kind === "status-error" ? 404 : 200,
    body: { getReader: () => reader },
  };
};`;
  const result = await runModule(source, {
    cwd: directory,
    prefix,
    env: {
      GH_TOKEN: "controlled-token",
      GITHUB_OUTPUT: outputPath,
      TEST_OBSERVER: observerPath,
      TEST_SCENARIO: JSON.stringify(scenario),
    },
  });
  return {
    ...result,
    observer: JSON.parse(await readFile(observerPath, "utf8")),
    output: await readFile(outputPath, "utf8").catch(() => ""),
  };
}

export async function preparePacket(directory, names, marker) {
  const output = path.join(directory, "build", "production-evidence");
  await mkdir(output, { recursive: true });
  for (const name of names) await writeFile(path.join(output, name), "{}\n");
  if (marker !== undefined) await writeFile(path.join(output, ".validated"), marker);
  return output;
}

export function evaluateCondition(expression, values) {
  const substitutions = new Map([
    ["needs.eligibility.outputs.run-evidence", values.eligibility],
    ["steps.packet.outputs.ready", values.ready],
    ["steps.evidence-upload.outcome", values.upload],
    ["steps.collector.outcome", values.collector],
  ]);
  let resolved = expression.replaceAll("always()", "true");
  for (const [token, value] of substitutions) resolved = resolved.replaceAll(token, JSON.stringify(value ?? ""));
  if (!/^[\s()=!&|'"a-z0-9_-]+$/u.test(resolved)) throw new Error(`unsupported condition: ${expression}`);
  return Boolean(Function(`"use strict"; return (${resolved});`)());
}
