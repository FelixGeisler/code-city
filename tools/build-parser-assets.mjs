import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { cp, lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { inspectWasm } from "./check-parser-assets.mjs";

const projectRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const vendorRoot = path.join(projectRoot, "vendor", "tree-sitter-typescript");
const IMAGE = "docker.io/emscripten/emsdk@sha256:8847dad4171ebc8a53d9ae5cda86a2546ef5b2e68834c14dc1ba2b2962e125cc";
const IMAGE_DIGEST = "sha256:8847dad4171ebc8a53d9ae5cda86a2546ef5b2e68834c14dc1ba2b2962e125cc";
const MAX_REDIRECTS = 3;

const ACQUISITIONS = Object.freeze([
  Object.freeze({ name: "tree-sitter-typescript-0.23.2.tgz", url: "https://registry.npmjs.org/tree-sitter-typescript/-/tree-sitter-typescript-0.23.2.tgz", bytes: 2_961_431, sha256: "0fdf63c35930a75885145d75ee63cb879da2d49db9bfe454bd8e60b08ba778a1", integrity: "sha512-e04JUUKxTT53/x3Uq1zIL45DoYKVfHH4CZqwgZhPg5qYROl5nQjV+85ruFzFGZxu+QeFVbRTPDRnqL9UbU4VeA==" }),
  Object.freeze({ name: "tree-sitter-javascript-0.23.1.tgz", url: "https://registry.npmjs.org/tree-sitter-javascript/-/tree-sitter-javascript-0.23.1.tgz", bytes: 632_551, sha256: "90e80b25a67517a4daf6ad751557bee21efbda7b7a5a554897933245d1734398", integrity: "sha512-/bnhbrTD9frUYHQTiYnPcxyHORIw157ERBa6dqzaKxvR/x3PC4Yzd+D1pZIMS6zNg2v3a8BZ0oK7jHqsQo9fWA==" }),
  Object.freeze({ name: "tree-sitter-cli-0.24.4.tgz", url: "https://registry.npmjs.org/tree-sitter-cli/-/tree-sitter-cli-0.24.4.tgz", bytes: 7_065, sha256: "2d33d29e83bd91fa338d8f08fb22db80a54ed93600e0ff6fc524f441652356d4", integrity: "sha512-I4sdtDidnujYL0tR0Re9q0UJt5KrITf2m+GMHjT4LH6IC6kpM6eLzSR7RS36Z4t5ZQBjDHvg2QUJHAWQi3P2TA==" }),
  Object.freeze({ name: "tree-sitter-cli-0.25.10.tgz", url: "https://registry.npmjs.org/tree-sitter-cli/-/tree-sitter-cli-0.25.10.tgz", bytes: 7_384, sha256: "351b439451769d7e883c24c852e9f2b6e219f429221ad42d7da0bf35145da261", integrity: "sha512-KoebQguKMCIghisEOdA372TIbrUl0kdnfZ9YQIBRAeOvNSKe85XbU4LuFW7hduRUwJj0rAG7pX5wo9sZhbBF1g==" }),
  Object.freeze({ name: "tree-sitter-cli-0.24.4-linux-x64.gz", url: "https://github.com/tree-sitter/tree-sitter/releases/download/v0.24.4/tree-sitter-linux-x64.gz", bytes: 8_537_215, sha256: "60578f6e563e046d311d7cac4bf27207eb6982b97ddec6b78022a4afdf736a9b" }),
  Object.freeze({ name: "tree-sitter-cli-0.25.10-linux-x64.gz", url: "https://github.com/tree-sitter/tree-sitter/releases/download/v0.25.10/tree-sitter-linux-x64.gz", bytes: 6_521_182, sha256: "8283ddba69253c698f6e987ba0e2f9285e079c8db4d36ebe1394b5bb3a0ebdfd" }),
]);
export const METADATA = Object.freeze([
  Object.freeze({ package: "tree-sitter-typescript@0.23.2", url: "https://registry.npmjs.org/tree-sitter-typescript/0.23.2", bytes: 2_470, gitHead: "f975a621f4e7f532fe322e13c4f79495e0a7b2e7", integrity: ACQUISITIONS[0].integrity, tarball: ACQUISITIONS[0].url }),
  Object.freeze({ package: "tree-sitter-javascript@0.23.1", url: "https://registry.npmjs.org/tree-sitter-javascript/0.23.1", bytes: 2_699, gitHead: "3a837b6f3658ca3618f2022f8707e29739c91364", integrity: ACQUISITIONS[1].integrity, tarball: ACQUISITIONS[1].url }),
  Object.freeze({ package: "tree-sitter-cli@0.24.4", url: "https://registry.npmjs.org/tree-sitter-cli/0.24.4", bytes: 1_862, gitHead: "fc8c1863e2e5724a0c40bb6e6cfc8631bfe5908b", integrity: ACQUISITIONS[2].integrity, tarball: ACQUISITIONS[2].url }),
  Object.freeze({ package: "tree-sitter-cli@0.25.10", url: "https://registry.npmjs.org/tree-sitter-cli/0.25.10", bytes: 1_917, gitHead: "da6fe9beb4f7f67beb75914ca8e0d48ae48d6406", integrity: ACQUISITIONS[3].integrity, tarball: ACQUISITIONS[3].url }),
]);
const EXECUTABLES = Object.freeze([
  Object.freeze({ gzip: ACQUISITIONS[4].name, name: "tree-sitter-cli-0.24.4", bytes: 23_984_272, sha256: "e62065f887c51079c943ace813a620a2ed4e69b7f0297192e6db6dc5c633715c", version: "tree-sitter 0.24.4 (fc8c1863e2e5724a0c40bb6e6cfc8631bfe5908b)" }),
  Object.freeze({ gzip: ACQUISITIONS[5].name, name: "tree-sitter-cli-0.25.10", bytes: 19_078_032, sha256: "de21a99ed95e683526b26eee456e12352752487daed0d20afc85157212ab8e3d", version: "tree-sitter 0.25.10 (da6fe9beb4f7f67beb75914ca8e0d48ae48d6406)" }),
]);
const RUN_EXPECTATIONS = Object.freeze({
  control: Object.freeze({
    "tree-sitter-typescript.wasm": ["778025db5a8be0e70f8ccc3671e486dfeddd048c25d9e8a70c26de2e1bf6f97d", 1_413_849],
    "tree-sitter-tsx.wasm": ["79e5da75ea62855a0cd67177685f0164eac87d5f630b3cbe1e0a099751ad30f8", 1_445_638],
    "typescript/src/grammar.json": ["99dc4b95424dff47c89acb50d5d3f25b081b07eaff43994b7881dccd4186b214", 281_518],
    "typescript/src/parser.c": ["74fe453edd70f4eae9af0a1050cbd7943d8971d59165b6aaebbaa0a0b716d1aa", 8_745_894],
    "tsx/src/grammar.json": ["f98a7830b67be266c9e9effb673a5fc154ad6aa26f87f7c6d4a9191e09d8b357", 281_578],
    "tsx/src/parser.c": ["1902cb53fa7ff5179df89b2eea863165e84c8cc866226419dc26921d8c055885", 8_769_870],
  }),
  patched: Object.freeze({
    "tree-sitter-typescript.wasm": ["e78418bb10620f1eef96f254d3a73e745b33f9b9f263ce09ccb195c39dcf88c9", 1_362_713],
    "tree-sitter-tsx.wasm": ["23fca4a07147d124a8453981a24825a47eba090dc3da6ce207a1cbb48579b0a7", 1_446_550],
    "typescript/src/grammar.json": ["76fa04475c29a77c3f89793cf7769d19de57672e15bb837a0903cc4cd47c9fbb", 281_310],
    "typescript/src/parser.c": ["0e7e004cfa96d5487c02420ed5a66cd950e7935f1a29c6be2cad63281ba00d2a", 8_429_417],
    "tsx/src/grammar.json": ["9a58ec754c72a675b85efda53aa1640a52a0189a5311e71e030142abc9df4d56", 281_370],
    "tsx/src/parser.c": ["0491086c6d03d60103ad87a8793fb4f3d3728f49ead650025c1135b60d27d2f9", 8_777_815],
  }),
});
const NODE_TYPES = Object.freeze({
  "typescript/src/node-types.json": ["c790a733fc756b54d4e54dceeb7d2d51e40d8b57136e70277753a75804cce3e3", 108_583],
  "tsx/src/node-types.json": ["78b5789145286799a27a0a7ecc36cc1bcb151f94ec7fa631b248459867010c8c", 113_345],
});
const DYLINK = Object.freeze({
  "tree-sitter-typescript.wasm": { memorySize: 1_330_484, memoryAlign: 4, tableSize: 7, tableAlign: 0, neededLibraries: [], subsectionTypes: [1] },
  "tree-sitter-tsx.wasm": { memorySize: 1_409_560, memoryAlign: 4, tableSize: 7, tableAlign: 0, neededLibraries: [], subsectionTypes: [1] },
});

function invariant(condition, message) { if (!condition) throw new Error(message); }
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function pathKey(value) { const resolved = path.resolve(value); return process.platform === "win32" ? resolved.toLowerCase() : resolved; }
function isWithin(parent, child) { const relative = path.relative(parent, child); return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); }
function assertSafeUrl(value) { const url = new URL(value); invariant(url.protocol === "https:" && !url.username && !url.password, `Acquisition URL is not credential-free HTTPS: ${value}`); return url; }

async function executeChild(controller, spawnImpl, kind, command, args, options = {}) {
  if (kind === "normal") controller.assertCanSpawn();
  else controller.assertCleanupCommand(command, args);
  return await new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(command, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"], windowsHide: true });
    } catch (error) {
      reject(error);
      return;
    }
    const stdout = [];
    const stderr = [];
    let settleChild;
    let childFinished = false;
    const record = { child, kind, settled: new Promise((settle) => { settleChild = settle; }) };
    controller.trackChild(record);
    const finish = (callback) => {
      if (childFinished) return;
      childFinished = true;
      controller.childSettled(record);
      settleChild();
      callback();
    };
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", (code, signal) => finish(() => {
      const output = Buffer.concat(stdout).toString("utf8");
      const errorOutput = Buffer.concat(stderr).toString("utf8");
      if (code === 0 || options.allowFailure) resolve({ code, signal, stdout: output, stderr: errorOutput });
      else reject(new Error(`${command} failed (${signal ?? code}): ${errorOutput || output}`));
    }));
    if (options.input !== undefined) child.stdin.end(options.input);
  });
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason ?? new Error("Builder cancellation is already in progress");
}

export async function fetchBounded(urlValue, expectedBytes, accept = "application/octet-stream", fetchImpl = fetch, signal) {
  let url = assertSafeUrl(urlValue);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    throwIfAborted(signal);
    const response = await fetchImpl(url, { redirect: "manual", headers: { Accept: accept, "Accept-Encoding": "identity", "User-Agent": "code-city-parser-asset-builder/1" }, credentials: "omit", referrerPolicy: "no-referrer", signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      invariant(redirects < MAX_REDIRECTS, `Too many redirects for ${urlValue}`);
      const location = response.headers.get("location");
      invariant(location, `Redirect omitted Location for ${urlValue}`);
      url = assertSafeUrl(new URL(location, url).href);
      continue;
    }
    invariant(response.status === 200 && response.body, `Acquisition failed (${response.status}): ${url}`);
    const declared = response.headers.get("content-length");
    if (declared !== null && expectedBytes !== undefined) invariant(Number(declared) === expectedBytes, `Acquisition Content-Length changed: ${urlValue}`);
    const chunks = [];
    let length = 0;
    const maximum = expectedBytes ?? 1_048_576;
    for await (const chunk of response.body) {
      throwIfAborted(signal);
      length += chunk.byteLength;
      invariant(length <= maximum, `Acquisition exceeded its byte bound: ${urlValue}`);
      chunks.push(Buffer.from(chunk));
    }
    throwIfAborted(signal);
    if (expectedBytes !== undefined) invariant(length === expectedBytes, `Acquisition byte length changed: ${urlValue}`);
    return Buffer.concat(chunks);
  }
  throw new Error(`Redirect handling failed: ${urlValue}`);
}

export function validateMetadata(metadata, bytes) {
  const text = new TextDecoder("utf8", { fatal: true }).decode(bytes);
  invariant(Buffer.byteLength(text, "utf8") === metadata.bytes, `npm metadata UTF-8 length changed: ${metadata.package}`);
  const value = JSON.parse(text);
  invariant(value.gitHead === metadata.gitHead && value.dist?.integrity === metadata.integrity && value.dist?.tarball === metadata.tarball, `npm metadata changed: ${metadata.package}`);
  return value;
}

async function verifyFile(filePath, expected, label, controller) {
  const bytes = await controller.runNormal(() => readFile(filePath));
  invariant(bytes.byteLength === expected[1], `${label} byte length changed`);
  invariant(sha256(bytes) === expected[0], `${label} SHA-256 changed`);
  return bytes;
}

async function validateOutputPath(output, controller) {
  invariant(path.isAbsolute(output), "Output must be an absolute path");
  const resolved = path.resolve(output);
  invariant(resolved === output || (process.platform === "win32" && pathKey(resolved) === pathKey(output)), "Output must be canonical absolute syntax");
  try { await controller.runNormal(() => lstat(output)); throw new Error("Output must not exist"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const tempReal = await controller.runNormal(() => realpath(os.tmpdir()));
  let nearest = path.dirname(output);
  const inspected = [];
  for (;;) {
    try {
      const metadata = await controller.runNormal(() => lstat(nearest));
      inspected.push([nearest, metadata]);
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = path.dirname(nearest);
      invariant(parent !== nearest, "Output has no existing parent");
      nearest = parent;
    }
  }
  for (let current = nearest; isWithin(tempReal, current); current = path.dirname(current)) inspected.push([current, await controller.runNormal(() => lstat(current))]);
  for (const [candidate, metadata] of inspected) invariant(!metadata.isSymbolicLink(), `Output ancestor is a symlink or reparse point: ${candidate}`);
  const nearestReal = await controller.runNormal(() => realpath(nearest));
  invariant(pathKey(nearestReal) === pathKey(tempReal) || isWithin(tempReal, nearestReal), "Output's nearest existing parent escapes the system Temp directory");
  invariant(isWithin(tempReal, resolved), "Output must be beneath the resolved system Temp directory");
  invariant(!isWithin(projectRoot, resolved) && pathKey(resolved) !== pathKey(projectRoot), "Output must not be inside the tracked worktree");
  return resolved;
}

async function assertTarSafe(tarball, controller) {
  const { stdout } = await controller.runNormalCommand("tar", ["--force-local", "-tzf", tarball]);
  const entries = stdout.split(/\r?\n/u).filter(Boolean);
  invariant(entries.length > 0, `Tarball is empty: ${tarball}`);
  for (const entry of entries) {
    invariant(entry.startsWith("package/") && !entry.includes("\\") && !entry.split("/").includes(".."), `Tarball has an unsafe entry: ${entry}`);
  }
}

function containerAbsentFrom(result, name) {
  if (result.code === 0) return false;
  invariant(result.code === 1 && /No such (?:object|container)/iu.test(`${result.stderr}\n${result.stdout}`), `Could not verify absence of owned container ${name}`);
  return true;
}

export function createCleanupController({
  removeOutput = (output) => rm(output, { recursive: true }),
  spawnImpl = spawn,
} = {}) {
  const children = new Set();
  const containers = new Set();
  const uncertainPaths = new Set();
  const cancellation = new AbortController();
  const stopErrors = [];
  let output;
  let outputComplete = false;
  let stopping = false;
  let stopSignal;
  let workflow;
  let terminal;
  const controller = {
    assertCanSpawn() { invariant(!stopping, "Builder cancellation is already in progress"); },
    assertCleanupCommand(command, args) {
      const name = args.at(-1);
      const removal = command === "docker" && args.length === 3 && args[0] === "rm" && args[1] === "-f";
      const inspection = command === "docker" && args.length === 3 && args[0] === "container" && args[1] === "inspect";
      invariant((removal || inspection) && containers.has(name), "Only cleanup of a tracked owned container is permitted after cancellation");
    },
    trackChild(record) { children.add(record); },
    childSettled(record) { children.delete(record); },
    async runNormal(operation) {
      controller.assertCanSpawn();
      const result = await operation(cancellation.signal);
      controller.assertCanSpawn();
      return result;
    },
    runNormalCommand(command, args, options) { return executeChild(controller, spawnImpl, "normal", command, args, options); },
    claimOutput(value) { invariant(output === undefined, "Builder output ownership was already assigned"); output = value; },
    retainUncertainPath(value) { uncertainPaths.add(value); },
    completeOutput() { controller.assertCanSpawn(); outputComplete = true; },
    trackContainer(name) { controller.assertCanSpawn(); containers.add(name); },
    setWorkflow(value) {
      invariant(workflow === undefined, "Builder workflow ownership was already assigned");
      workflow = Promise.resolve(value);
      void workflow.catch(() => {});
    },
    requestStop(signal) {
      if (stopping) return;
      stopping = true;
      stopSignal = signal;
      cancellation.abort(new Error(`Builder cancellation requested${signal ? ` by ${signal}` : ""}`));
      for (const record of children) {
        if (record.kind !== "normal") continue;
        try { record.child.kill("SIGTERM"); } catch (error) { stopErrors.push(error); }
      }
    },
    get stopRequested() { return stopping; },
    get signal() { return cancellation.signal; },
    async confirmContainerAbsent(name) {
      if (!containers.has(name)) return;
      const result = await executeChild(controller, spawnImpl, "cleanup", "docker", ["container", "inspect", name], { allowFailure: true });
      invariant(containerAbsentFrom(result, name), `Owned container still exists after --rm: ${name}`);
      containers.delete(name);
    },
    finish({ success = false, signal } = {}) {
      if (terminal) return terminal;
      controller.requestStop(signal);
      terminal = (async () => {
        const errors = [...stopErrors];
        if (workflow) {
          try { await workflow; } catch {}
        }
        const active = [...children];
        for (const record of active) {
          if (record.kind !== "normal") continue;
          try { record.child.kill("SIGTERM"); } catch (error) { errors.push(error); }
        }
        await Promise.all(active.map((record) => record.settled));
        for (const name of [...containers]) {
          try { await executeChild(controller, spawnImpl, "cleanup", "docker", ["rm", "-f", name]); } catch (error) { errors.push(new Error(`Failed to remove owned container ${name}`, { cause: error })); }
          try {
            const result = await executeChild(controller, spawnImpl, "cleanup", "docker", ["container", "inspect", name], { allowFailure: true });
            if (containerAbsentFrom(result, name)) containers.delete(name);
            else errors.push(new Error(`Owned container still exists after cleanup: ${name}`));
          } catch (error) { errors.push(new Error(`Could not verify owned container absence: ${name}`, { cause: error })); }
        }
        if (output && (!success || !outputComplete)) {
          if (containers.size > 0) {
            errors.push(new Error(`Owned output retained because container absence was not verified: ${output}`));
          } else {
            try { await removeOutput(output); } catch (error) { errors.push(new Error(`Owned output retained after cleanup failure: ${output}`, { cause: error })); }
          }
        }
        for (const value of uncertainPaths) errors.push(new Error(`Uncertain output ownership; retained without deletion: ${value}`));
        if (containers.size > 0) errors.push(new Error(`Owned containers retained because absence was not verified: ${[...containers].join(", ")}`));
        if (children.size > 0) errors.push(new Error("Owned child processes remained active after terminal cleanup"));
        if (errors.length > 0) {
          const summary = errors.map((error) => error instanceof Error ? error.message : String(error)).join("; ");
          throw new AggregateError(errors, `Builder terminal cleanup failed${stopSignal ? ` after ${stopSignal}` : ""}: ${summary}`);
        }
      })();
      return terminal;
    },
  };
  return controller;
}

export async function acquireOutputPath(output, controller, io = { mkdir, lstat, realpath }) {
  const resolved = await validateOutputPath(output, controller);
  controller.assertCanSpawn();
  await io.mkdir(resolved);
  try {
    const metadata = await io.lstat(resolved);
    invariant(metadata.isDirectory() && !metadata.isSymbolicLink(), `Created output is not an owned ordinary directory: ${resolved}`);
    const [createdReal, tempReal] = await Promise.all([io.realpath(resolved), io.realpath(os.tmpdir())]);
    invariant(pathKey(createdReal) === pathKey(resolved), `Created output changed through a reparse point: ${resolved}`);
    invariant(isWithin(tempReal, createdReal), `Created output escaped the system Temp directory: ${resolved}`);
  } catch (error) {
    controller.retainUncertainPath(resolved);
    throw error;
  }
  controller.claimOutput(resolved);
  controller.assertCanSpawn();
  return resolved;
}

export async function main(outputArgument = process.argv[2], controller = createCleanupController()) {
  invariant(outputArgument && process.argv.length === 3, "Usage: node tools/build-parser-assets.mjs <absolute-new-output-under-system-Temp>");
  const normal = (operation) => controller.runNormal(operation);
  const ownedOutput = await acquireOutputPath(outputArgument, controller);
  const work = path.join(ownedOutput, ".work");
  const inputs = path.join(work, "inputs");
  const runsRoot = path.join(work, "runs");
  await normal(() => mkdir(inputs, { recursive: true }));
  await normal(() => mkdir(runsRoot, { recursive: true }));

  const tracked = [
    ["grammar.patch", "470d7029ad57d743704d5c1ab871449a4e817b9bd8c3266912aeb52b4ad4b62d", 963],
    ["provenance.json", "885ad8788f6ba6f50c82702ebb61179408f4825ba3ec1cbbee494d43b50f3bc3", 8_223],
    ["LICENSE", "49bf33cf78ef5897e4e161ce1517df7de1ae5042a65b6bcfd44401e0fc606559", 1_080],
    ["LICENSE.javascript", "2e0110e07abef7c2548b26ec9d6969775617ca539a0dc8dbeeb14d6452c711d1", 1_080],
  ];
  for (const [name, hash, bytes] of tracked) {
    const source = await normal(() => readFile(path.join(vendorRoot, name)));
    invariant(source.byteLength === bytes && sha256(source) === hash, `Tracked ${name} changed before reproduction`);
    await normal(() => writeFile(path.join(inputs, name), source, { flag: "wx" }));
  }

  for (const metadata of METADATA) {
    const bytes = await normal((signal) => fetchBounded(metadata.url, metadata.bytes, "application/json", fetch, signal));
    validateMetadata(metadata, bytes);
  }
  for (const item of ACQUISITIONS) {
    const bytes = await normal((signal) => fetchBounded(item.url, item.bytes, "application/octet-stream", fetch, signal));
    invariant(sha256(bytes) === item.sha256, `Acquisition SHA-256 changed: ${item.name}`);
    if (item.integrity) invariant(`sha512-${createHash("sha512").update(bytes).digest("base64")}` === item.integrity, `Acquisition npm integrity changed: ${item.name}`);
    await normal(() => writeFile(path.join(inputs, item.name), bytes, { flag: "wx" }));
  }
  await assertTarSafe(path.join(inputs, ACQUISITIONS[0].name), controller);
  await assertTarSafe(path.join(inputs, ACQUISITIONS[1].name), controller);
  // The CLI npm tarballs are verified provenance only and are deliberately never extracted or executed.

  for (const executable of EXECUTABLES) {
    const compressed = await normal(() => readFile(path.join(inputs, executable.gzip)));
    const bytes = gunzipSync(compressed);
    invariant(bytes.byteLength === executable.bytes && sha256(bytes) === executable.sha256, `Pinned executable changed: ${executable.name}`);
    await normal(() => writeFile(path.join(inputs, executable.name), bytes, { flag: "wx", mode: 0o755 }));
  }

  const image = await controller.runNormalCommand("docker", ["image", "inspect", IMAGE, "--format", "{{json .RepoDigests}}|{{.Os}}/{{.Architecture}}"]);
  const [digestsText, platform] = image.stdout.trim().split("|");
  const imageDigests = JSON.parse(digestsText);
  invariant(platform === "linux/amd64" && imageDigests.some((value) => value.endsWith(`@${IMAGE_DIGEST}`)), "The exact cached linux/amd64 Emscripten image is unavailable");

  const runNames = ["control-1", "control-2", "patched-1", "patched-2"];
  for (const runName of runNames) {
    const runRoot = path.join(runsRoot, runName);
    const source = path.join(runRoot, "src");
    const jsDependency = path.join(source, "node_modules", "tree-sitter-javascript");
    const output = path.join(runRoot, "out");
    await normal(() => mkdir(source, { recursive: true }));
    await normal(() => mkdir(jsDependency, { recursive: true }));
    await normal(() => mkdir(output, { recursive: true }));
    await controller.runNormalCommand("tar", ["--force-local", "-xzf", path.join(inputs, ACQUISITIONS[0].name), "--strip-components=1"], { cwd: source });
    await controller.runNormalCommand("tar", ["--force-local", "-xzf", path.join(inputs, ACQUISITIONS[1].name), "--strip-components=1"], { cwd: jsDependency });
    const sourcePackage = JSON.parse(await normal(() => readFile(path.join(source, "package.json"), "utf8")));
    const dependencyPackage = JSON.parse(await normal(() => readFile(path.join(jsDependency, "package.json"), "utf8")));
    invariant(`${sourcePackage.name}@${sourcePackage.version}` === "tree-sitter-typescript@0.23.2", "Extracted TypeScript package identity changed");
    invariant(`${dependencyPackage.name}@${dependencyPackage.version}` === "tree-sitter-javascript@0.23.1", "Extracted JavaScript package identity changed");
    assert.deepEqual(await normal(() => readFile(path.join(source, "LICENSE"))), await normal(() => readFile(path.join(inputs, "LICENSE"))), "TypeScript notice differs after verified extraction");
    assert.deepEqual(await normal(() => readFile(path.join(jsDependency, "LICENSE"))), await normal(() => readFile(path.join(inputs, "LICENSE.javascript"))), "JavaScript dependency notice differs after verified extraction");
    if (runName.startsWith("patched")) await controller.runNormalCommand("patch", ["--batch", "--fuzz=0", "-p1", "-i", path.join(inputs, "grammar.patch")], { cwd: source });

    const containerName = `code-city-parser-577-${process.pid}-${randomBytes(6).toString("hex")}`;
    controller.trackContainer(containerName);
    try {
      await controller.runNormalCommand("docker", [
        "run", "--name", containerName, "--rm", "--pull", "never", "--network", "none", "--platform", "linux/amd64",
        "--mount", `type=bind,source=${inputs},target=/inputs,readonly`,
        "--mount", `type=bind,source=${runRoot},target=/work`,
        IMAGE, "bash", "-lc",
        `set -euo pipefail
         test \"$(/inputs/tree-sitter-cli-0.24.4 --version)\" = \"${EXECUTABLES[0].version}\"
         test \"$(/inputs/tree-sitter-cli-0.25.10 --version)\" = \"${EXECUTABLES[1].version}\"
         emcc --version | head -1 | grep -F \"emcc (Emscripten gcc/clang-like replacement + linker emulating GNU ld) 3.1.64\"
         cd /work/src/typescript && /inputs/tree-sitter-cli-0.24.4 generate --abi 14
         cd /work/src/tsx && /inputs/tree-sitter-cli-0.24.4 generate --abi 14
         cd /work/out
         /inputs/tree-sitter-cli-0.25.10 build --wasm /work/src/typescript
         /inputs/tree-sitter-cli-0.25.10 build --wasm /work/src/tsx`,
      ]);
    } finally {
      await controller.confirmContainerAbsent(containerName);
    }

    const kind = runName.startsWith("control") ? "control" : "patched";
    for (const [relative, expected] of Object.entries({ ...RUN_EXPECTATIONS[kind], ...NODE_TYPES })) {
      const location = relative.endsWith(".wasm") ? path.join(output, relative) : path.join(source, ...relative.split("/"));
      await verifyFile(location, expected, `${runName}/${relative}`, controller);
    }
  }

  for (const kind of ["control", "patched"]) {
    for (const wasm of ["tree-sitter-typescript.wasm", "tree-sitter-tsx.wasm"]) {
      const first = await normal(() => readFile(path.join(runsRoot, `${kind}-1`, "out", wasm)));
      const second = await normal(() => readFile(path.join(runsRoot, `${kind}-2`, "out", wasm)));
      assert.deepEqual(first, second, `${kind} reproductions differ: ${wasm}`);
    }
  }

  const runtime = await normal(() => import(pathToFileURL(path.join(projectRoot, "node_modules", "web-tree-sitter", "web-tree-sitter.js")).href));
  await normal(() => runtime.Parser.init({ locateFile: () => pathToFileURL(path.join(projectRoot, "node_modules", "web-tree-sitter", "web-tree-sitter.wasm")).href, print() {}, printErr() {} }));
  for (const wasm of ["tree-sitter-typescript.wasm", "tree-sitter-tsx.wasm"]) {
    const bytes = await normal(() => readFile(path.join(runsRoot, "patched-1", "out", wasm)));
    assert.deepEqual(inspectWasm(bytes).dylink, DYLINK[wasm], `${wasm} dylink.0 changed`);
    const language = await normal(() => runtime.Language.load(new Uint8Array(bytes)));
    invariant(language.abiVersion === 14, `${wasm} ABI changed`);
  }

  const publish = path.join(work, "publish");
  await normal(() => mkdir(publish));
  for (const wasm of ["tree-sitter-typescript.wasm", "tree-sitter-tsx.wasm"]) {
    await normal(() => cp(path.join(runsRoot, "patched-1", "out", wasm), path.join(publish, wasm), { errorOnExist: true, force: false }));
  }
  await normal(() => rename(publish, path.join(ownedOutput, "wasm")));
  await normal(() => rm(work, { recursive: true }));
  controller.completeOutput();
  console.log("Reproduced two controls and two patched builds; verified all pins; retained only wasm/tree-sitter-typescript.wasm and wasm/tree-sitter-tsx.wasm.");
}

const invokedPath = process.argv[1] && path.resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  const controller = createCleanupController();
  let signalName;
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.once(signal, () => {
      signalName ??= signal;
      controller.requestStop(signal);
    });
  }
  const workflow = main(process.argv[2], controller);
  controller.setWorkflow(workflow);
  try {
    await workflow;
    if (controller.stopRequested) throw controller.signal.reason;
    await controller.finish({ success: true });
  } catch (error) {
    let cleanupError;
    try { await controller.finish({ signal: signalName }); } catch (caught) { cleanupError = caught; }
    console.error(error instanceof Error ? error.stack : String(error));
    if (cleanupError) console.error(cleanupError instanceof Error ? cleanupError.stack : String(cleanupError));
    process.exitCode = signalName && !cleanupError ? 128 + (signalName === "SIGINT" ? 2 : 15) : 1;
  }
}
