import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
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
const METADATA = Object.freeze([
  Object.freeze({ package: "tree-sitter-typescript@0.23.2", url: "https://registry.npmjs.org/tree-sitter-typescript/0.23.2", gitHead: "f975a621f4e7f532fe322e13c4f79495e0a7b2e7", integrity: ACQUISITIONS[0].integrity, tarball: ACQUISITIONS[0].url }),
  Object.freeze({ package: "tree-sitter-javascript@0.23.1", url: "https://registry.npmjs.org/tree-sitter-javascript/0.23.1", gitHead: "3a837b6f3658ca3618f2022f8707e29739c91364", integrity: ACQUISITIONS[1].integrity, tarball: ACQUISITIONS[1].url }),
  Object.freeze({ package: "tree-sitter-cli@0.24.4", url: "https://registry.npmjs.org/tree-sitter-cli/0.24.4", gitHead: "fc8c1863e2e5724a0c40bb6e6cfc8631bfe5908b", integrity: ACQUISITIONS[2].integrity, tarball: ACQUISITIONS[2].url }),
  Object.freeze({ package: "tree-sitter-cli@0.25.10", url: "https://registry.npmjs.org/tree-sitter-cli/0.25.10", gitHead: "da6fe9beb4f7f67beb75914ca8e0d48ae48d6406", integrity: ACQUISITIONS[3].integrity, tarball: ACQUISITIONS[3].url }),
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

async function run(command, args, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"], windowsHide: true });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => {
      const output = Buffer.concat(stdout).toString("utf8");
      const errorOutput = Buffer.concat(stderr).toString("utf8");
      if (code === 0) resolve({ stdout: output, stderr: errorOutput });
      else reject(new Error(`${command} failed (${signal ?? code}): ${errorOutput || output}`));
    });
    if (options.input !== undefined) child.stdin.end(options.input);
  });
}

async function fetchBounded(urlValue, expectedBytes, accept = "application/octet-stream") {
  let url = assertSafeUrl(urlValue);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const response = await fetch(url, { redirect: "manual", headers: { Accept: accept, "User-Agent": "code-city-parser-asset-builder/1" }, credentials: "omit", referrerPolicy: "no-referrer" });
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
      length += chunk.byteLength;
      invariant(length <= maximum, `Acquisition exceeded its byte bound: ${urlValue}`);
      chunks.push(Buffer.from(chunk));
    }
    if (expectedBytes !== undefined) invariant(length === expectedBytes, `Acquisition byte length changed: ${urlValue}`);
    return Buffer.concat(chunks);
  }
  throw new Error(`Redirect handling failed: ${urlValue}`);
}

async function verifyFile(filePath, expected, label = filePath) {
  const bytes = await readFile(filePath);
  invariant(bytes.byteLength === expected[1], `${label} byte length changed`);
  invariant(sha256(bytes) === expected[0], `${label} SHA-256 changed`);
  return bytes;
}

async function validateOutputPath(output) {
  invariant(path.isAbsolute(output), "Output must be an absolute path");
  const resolved = path.resolve(output);
  invariant(resolved === output || (process.platform === "win32" && pathKey(resolved) === pathKey(output)), "Output must be canonical absolute syntax");
  try { await lstat(output); throw new Error("Output must not exist"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const tempReal = await realpath(os.tmpdir());
  let nearest = path.dirname(output);
  const inspected = [];
  for (;;) {
    try {
      const metadata = await lstat(nearest);
      inspected.push([nearest, metadata]);
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = path.dirname(nearest);
      invariant(parent !== nearest, "Output has no existing parent");
      nearest = parent;
    }
  }
  for (let current = nearest; isWithin(tempReal, current); current = path.dirname(current)) inspected.push([current, await lstat(current)]);
  for (const [candidate, metadata] of inspected) invariant(!metadata.isSymbolicLink(), `Output ancestor is a symlink or reparse point: ${candidate}`);
  const nearestReal = await realpath(nearest);
  invariant(pathKey(nearestReal) === pathKey(tempReal) || isWithin(tempReal, nearestReal), "Output's nearest existing parent escapes the system Temp directory");
  invariant(isWithin(tempReal, resolved), "Output must be beneath the resolved system Temp directory");
  invariant(!isWithin(projectRoot, resolved) && pathKey(resolved) !== pathKey(projectRoot), "Output must not be inside the tracked worktree");
  return resolved;
}

async function assertTarSafe(tarball) {
  const { stdout } = await run("tar", ["--force-local", "-tzf", tarball]);
  const entries = stdout.split(/\r?\n/u).filter(Boolean);
  invariant(entries.length > 0, `Tarball is empty: ${tarball}`);
  for (const entry of entries) {
    invariant(entry.startsWith("package/") && !entry.includes("\\") && !entry.split("/").includes(".."), `Tarball has an unsafe entry: ${entry}`);
  }
}

const ownedContainers = new Set();
let ownedOutput;
let finished = false;
async function cleanupContainers() {
  for (const name of [...ownedContainers]) {
    try { await run("docker", ["rm", "-f", name]); } catch {}
    ownedContainers.delete(name);
  }
}
async function failCleanup() {
  await cleanupContainers();
  if (ownedOutput && !finished) await rm(ownedOutput, { recursive: true, force: true });
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => { void failCleanup().finally(() => process.exit(128 + (signal === "SIGINT" ? 2 : 15))); });
}

async function main() {
  invariant(process.argv.length === 3, "Usage: node tools/build-parser-assets.mjs <absolute-new-output-under-system-Temp>");
  ownedOutput = await validateOutputPath(process.argv[2]);
  await mkdir(ownedOutput);
  const work = path.join(ownedOutput, ".work");
  const inputs = path.join(work, "inputs");
  const runsRoot = path.join(work, "runs");
  await mkdir(inputs, { recursive: true });
  await mkdir(runsRoot, { recursive: true });

  const tracked = [
    ["grammar.patch", "470d7029ad57d743704d5c1ab871449a4e817b9bd8c3266912aeb52b4ad4b62d", 963],
    ["provenance.json", "885ad8788f6ba6f50c82702ebb61179408f4825ba3ec1cbbee494d43b50f3bc3", 8_223],
    ["LICENSE", "49bf33cf78ef5897e4e161ce1517df7de1ae5042a65b6bcfd44401e0fc606559", 1_080],
    ["LICENSE.javascript", "2e0110e07abef7c2548b26ec9d6969775617ca539a0dc8dbeeb14d6452c711d1", 1_080],
  ];
  for (const [name, hash, bytes] of tracked) {
    const source = await readFile(path.join(vendorRoot, name));
    invariant(source.byteLength === bytes && sha256(source) === hash, `Tracked ${name} changed before reproduction`);
    await writeFile(path.join(inputs, name), source, { flag: "wx" });
  }

  for (const metadata of METADATA) {
    const bytes = await fetchBounded(metadata.url, undefined, "application/json");
    const value = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));
    invariant(value.gitHead === metadata.gitHead && value.dist?.integrity === metadata.integrity && value.dist?.tarball === metadata.tarball, `npm metadata changed: ${metadata.package}`);
  }
  for (const item of ACQUISITIONS) {
    const bytes = await fetchBounded(item.url, item.bytes);
    invariant(sha256(bytes) === item.sha256, `Acquisition SHA-256 changed: ${item.name}`);
    if (item.integrity) invariant(`sha512-${createHash("sha512").update(bytes).digest("base64")}` === item.integrity, `Acquisition npm integrity changed: ${item.name}`);
    await writeFile(path.join(inputs, item.name), bytes, { flag: "wx" });
  }
  await assertTarSafe(path.join(inputs, ACQUISITIONS[0].name));
  await assertTarSafe(path.join(inputs, ACQUISITIONS[1].name));
  // The CLI npm tarballs are verified provenance only and are deliberately never extracted or executed.

  for (const executable of EXECUTABLES) {
    const compressed = await readFile(path.join(inputs, executable.gzip));
    const bytes = gunzipSync(compressed);
    invariant(bytes.byteLength === executable.bytes && sha256(bytes) === executable.sha256, `Pinned executable changed: ${executable.name}`);
    await writeFile(path.join(inputs, executable.name), bytes, { flag: "wx", mode: 0o755 });
  }

  const image = await run("docker", ["image", "inspect", IMAGE, "--format", "{{json .RepoDigests}}|{{.Os}}/{{.Architecture}}"]);
  const [digestsText, platform] = image.stdout.trim().split("|");
  const imageDigests = JSON.parse(digestsText);
  invariant(platform === "linux/amd64" && imageDigests.some((value) => value.endsWith(`@${IMAGE_DIGEST}`)), "The exact cached linux/amd64 Emscripten image is unavailable");

  const runNames = ["control-1", "control-2", "patched-1", "patched-2"];
  for (const runName of runNames) {
    const runRoot = path.join(runsRoot, runName);
    const source = path.join(runRoot, "src");
    const jsDependency = path.join(source, "node_modules", "tree-sitter-javascript");
    const output = path.join(runRoot, "out");
    await mkdir(source, { recursive: true });
    await mkdir(jsDependency, { recursive: true });
    await mkdir(output, { recursive: true });
    await run("tar", ["--force-local", "-xzf", path.join(inputs, ACQUISITIONS[0].name), "--strip-components=1"], { cwd: source });
    await run("tar", ["--force-local", "-xzf", path.join(inputs, ACQUISITIONS[1].name), "--strip-components=1"], { cwd: jsDependency });
    const sourcePackage = JSON.parse(await readFile(path.join(source, "package.json"), "utf8"));
    const dependencyPackage = JSON.parse(await readFile(path.join(jsDependency, "package.json"), "utf8"));
    invariant(`${sourcePackage.name}@${sourcePackage.version}` === "tree-sitter-typescript@0.23.2", "Extracted TypeScript package identity changed");
    invariant(`${dependencyPackage.name}@${dependencyPackage.version}` === "tree-sitter-javascript@0.23.1", "Extracted JavaScript package identity changed");
    assert.deepEqual(await readFile(path.join(source, "LICENSE")), await readFile(path.join(inputs, "LICENSE")), "TypeScript notice differs after verified extraction");
    assert.deepEqual(await readFile(path.join(jsDependency, "LICENSE")), await readFile(path.join(inputs, "LICENSE.javascript")), "JavaScript dependency notice differs after verified extraction");
    if (runName.startsWith("patched")) await run("patch", ["--batch", "--fuzz=0", "-p1", "-i", path.join(inputs, "grammar.patch")], { cwd: source });

    const containerName = `code-city-parser-577-${process.pid}-${randomBytes(6).toString("hex")}`;
    ownedContainers.add(containerName);
    try {
      await run("docker", [
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
      ownedContainers.delete(containerName);
    }

    const kind = runName.startsWith("control") ? "control" : "patched";
    for (const [relative, expected] of Object.entries({ ...RUN_EXPECTATIONS[kind], ...NODE_TYPES })) {
      const location = relative.endsWith(".wasm") ? path.join(output, relative) : path.join(source, ...relative.split("/"));
      await verifyFile(location, expected, `${runName}/${relative}`);
    }
  }

  for (const kind of ["control", "patched"]) {
    for (const wasm of ["tree-sitter-typescript.wasm", "tree-sitter-tsx.wasm"]) {
      const first = await readFile(path.join(runsRoot, `${kind}-1`, "out", wasm));
      const second = await readFile(path.join(runsRoot, `${kind}-2`, "out", wasm));
      assert.deepEqual(first, second, `${kind} reproductions differ: ${wasm}`);
    }
  }

  const runtime = await import(pathToFileURL(path.join(projectRoot, "node_modules", "web-tree-sitter", "web-tree-sitter.js")).href);
  await runtime.Parser.init({ locateFile: () => pathToFileURL(path.join(projectRoot, "node_modules", "web-tree-sitter", "web-tree-sitter.wasm")).href, print() {}, printErr() {} });
  for (const wasm of ["tree-sitter-typescript.wasm", "tree-sitter-tsx.wasm"]) {
    const bytes = await readFile(path.join(runsRoot, "patched-1", "out", wasm));
    assert.deepEqual(inspectWasm(bytes).dylink, DYLINK[wasm], `${wasm} dylink.0 changed`);
    const language = await runtime.Language.load(new Uint8Array(bytes));
    invariant(language.abiVersion === 14, `${wasm} ABI changed`);
  }

  const publish = path.join(work, "publish");
  await mkdir(publish);
  for (const wasm of ["tree-sitter-typescript.wasm", "tree-sitter-tsx.wasm"]) {
    await cp(path.join(runsRoot, "patched-1", "out", wasm), path.join(publish, wasm), { errorOnExist: true, force: false });
  }
  await rename(publish, path.join(ownedOutput, "wasm"));
  await rm(work, { recursive: true, force: true });
  finished = true;
  console.log("Reproduced two controls and two patched builds; verified all pins; retained only wasm/tree-sitter-typescript.wasm and wasm/tree-sitter-tsx.wasm.");
}

try {
  await main();
} catch (error) {
  await failCleanup();
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
}
