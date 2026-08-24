import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as storage from "../tools/evidence-packet-files.mjs";
import { EvidenceContractError } from "../tools/production-evidence-schema.mjs";
import { binding, makeEvidencePacket } from "./fixtures/evidence-packet-fixture.mjs";

const execute = promisify(execFile);
const FILES = ["artifact.json", "smoke.json", "qualification.json", "capacity.json", "requests.json", "lifecycle.json", "index.json"];
const CAPS = new Map([
  ["artifact.json", 64 * 1024], ["smoke.json", 64 * 1024], ["qualification.json", 4 * 1024 * 1024],
  ["capacity.json", 4 * 1024 * 1024], ["requests.json", 8 * 1024 * 1024],
  ["lifecycle.json", 1024 * 1024], ["index.json", 16 * 1024],
]);

async function temporary(callback) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "code-city-evidence-files-"));
  try { return await callback(root); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}

function expectedError(code) {
  return (error) => {
    assert(error instanceof EvidenceContractError);
    assert.deepEqual(Object.keys(error), ["name", "code"]);
    assert.deepEqual({ name: error.name, code: error.code }, { name: "EvidenceContractError", code });
    assert.equal(error.message, code);
    assert.equal(Object.getOwnPropertyDescriptor(error, "message").enumerable, false);
    assert.equal(Object.hasOwn(error, "cause"), false);
    return true;
  };
}

async function writeLooseDirectory(output, packet, markerName = null, markerBytes = null) {
  await fs.mkdir(output);
  for (const [name, bytes] of packet.files) await fs.writeFile(path.join(output, name), bytes, { flag: "wx" });
  if (markerName !== null) await fs.writeFile(path.join(output, markerName), markerBytes, { flag: "wx" });
}

test("the adapter exposes only two async Promise APIs and all invocation failures reject privately", async () => {
  assert.deepEqual(Object.keys(storage).sort(), ["readValidatedEvidencePacket", "writeValidatedEvidencePacket"]);
  for (const [invoke, code] of [
    [() => storage.writeValidatedEvidencePacket("", null), "invalid-payload"],
    [() => storage.readValidatedEvidencePacket("", binding), "filesystem-safety"],
  ]) {
    let promise;
    assert.doesNotThrow(() => { promise = invoke(); });
    assert(promise instanceof Promise);
    await assert.rejects(promise, expectedError(code));
  }
});

test("write reserves one final directory and read returns fresh exact validator bytes only after the canonical commit marker", async () => temporary(async (root) => {
  const output = path.join(root, "packet");
  const source = makeEvidencePacket();
  const resultPromise = storage.writeValidatedEvidencePacket(output, source);
  assert(resultPromise instanceof Promise);
  const result = await resultPromise;
  assert(Object.isFrozen(result));
  assert.deepEqual(Object.keys(result), ["packetDigest"]);
  assert.deepEqual(result, { packetDigest: source.packetDigest });

  assert.deepEqual((await fs.readdir(output)).sort(), [...FILES, ".validated"].sort());
  assert.equal(await fs.readFile(path.join(output, ".validated"), "utf8"), `${source.packetDigest}\n`);
  await assert.rejects(fs.lstat(path.join(output, ".validated.staged")), { code: "ENOENT" });
  for (const [name, bytes] of source.files) assert.deepEqual(new Uint8Array(await fs.readFile(path.join(output, name))), bytes, name);

  const readPromise = storage.readValidatedEvidencePacket(output, binding);
  assert(readPromise instanceof Promise);
  const read = await readPromise;
  assert.equal(read.packetDigest, source.packetDigest);
  assert.notEqual(read.files, source.files);
  assert.deepEqual([...read.files.keys()], FILES);
  assert.equal(read.files.has(".validated"), false);
  assert.equal(read.files.has(".validated.staged"), false);
  for (const name of FILES) {
    assert.notEqual(read.files.get(name), source.files.get(name));
    assert.deepEqual(read.files.get(name), source.files.get(name));
  }
}));

test("writer revalidates mutable shape, map, bytes, binding, and digest before any mutation", async () => temporary(async (root) => {
  const cases = [
    ["shape", () => ({ files: makeEvidencePacket().files, binding, packetDigest: "0".repeat(64) }), "invalid-payload"],
    ["map", () => { const packet = makeEvidencePacket(); packet.files.delete("smoke.json"); return packet; }, "invalid-payload"],
    ["bytes", () => { const packet = makeEvidencePacket(); packet.files.get("artifact.json")[0] ^= 1; return packet; }, "noncanonical-bytes"],
    ["binding", () => { const packet = makeEvidencePacket(); return { binding: { ...packet.binding, eventSha: "b".repeat(40) }, files: packet.files, packetDigest: packet.packetDigest }; }, "invalid-payload"],
    ["digest", () => { const packet = makeEvidencePacket(); return { binding: packet.binding, files: packet.files, packetDigest: "0".repeat(64) }; }, "invalid-payload"],
  ];
  for (const [name, make, code] of cases) {
    const output = path.join(root, name);
    await assert.rejects(storage.writeValidatedEvidencePacket(output, make()), expectedError(code));
    await assert.rejects(fs.lstat(output), { code: "ENOENT" });
  }
}));

test("writer rejects packet v1 and every mixed envelope, index, and collector version before creating output", async () => temporary(async (root) => {
  const mutations = [
    ...["artifact", "smoke", "qualification", "capacity", "requests", "lifecycle"]
      .map((name) => [`${name} envelope v1`, `${name}.json`, (value) => { value.schemaVersion = 1; }]),
    ["collector v1", "lifecycle.json", (value) => { value.data.collectorVersion = 1; }],
    ["index v1", "index.json", (value) => { value.schemaVersion = 1; }],
  ];
  for (const [name, file, mutate] of mutations) {
    const source = makeEvidencePacket();
    const files = new Map(source.files);
    const value = JSON.parse(new TextDecoder().decode(files.get(file)));
    mutate(value);
    files.set(file, new TextEncoder().encode(`${JSON.stringify(value)}\n`));
    const packet = { binding: source.binding, files, packetDigest: source.packetDigest };
    const output = path.join(root, name.replaceAll(" ", "-"));
    await assert.rejects(storage.writeValidatedEvidencePacket(output, packet), expectedError("invalid-payload"), name);
    await assert.rejects(fs.lstat(output), { code: "ENOENT" }, `${name} left partial output`);
  }
}));

test("path policy rejects malformed paths, missing or non-directory parents, and symlink ancestors without mutation", async () => temporary(async (root) => {
  const packet = makeEvidencePacket();
  const fileParent = path.join(root, "file-parent");
  await fs.writeFile(fileParent, "keep");
  const missingParent = path.join(root, "missing", "packet");
  const unresolved = `${root}${path.sep}segment${path.sep}..${path.sep}packet`;
  for (const output of ["", "relative", unresolved, `${root}\0bad`, missingParent, path.join(fileParent, "packet")]) {
    await assert.rejects(storage.writeValidatedEvidencePacket(output, packet), expectedError("filesystem-safety"), output);
  }
  assert.equal(await fs.readFile(fileParent, "utf8"), "keep");

  const real = path.join(root, "real");
  const link = path.join(root, "link");
  await fs.mkdir(real);
  await fs.symlink(real, link, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(storage.writeValidatedEvidencePacket(path.join(link, "packet"), packet), expectedError("filesystem-safety"));
  assert.deepEqual(await fs.readdir(real), []);
}));

test("exclusive reservation rejects pre-existing, repeated, and race-winning outputs without inspection or cleanup", async () => temporary(async (root) => {
  const output = path.join(root, "packet");
  await fs.mkdir(output);
  await fs.writeFile(path.join(output, "winner"), "unchanged");
  await assert.rejects(storage.writeValidatedEvidencePacket(output, makeEvidencePacket()), expectedError("filesystem-safety"));
  assert.deepEqual(await fs.readdir(output), ["winner"]);
  assert.equal(await fs.readFile(path.join(output, "winner"), "utf8"), "unchanged");

  const other = path.join(root, "other");
  await storage.writeValidatedEvidencePacket(other, makeEvidencePacket());
  await assert.rejects(storage.writeValidatedEvidencePacket(other, makeEvidencePacket()), expectedError("filesystem-safety"));
  assert.equal((await fs.readdir(other)).includes(".validated"), true);
}));

test("readers reject every unmarked, staged, partial, extra, missing, non-file, and symlink entry", async () => temporary(async (root) => {
  const packet = makeEvidencePacket();
  const marker = new TextEncoder().encode(`${packet.packetDigest}\n`);
  const variants = [
    ["unmarked", null, null],
    ["staged", ".validated.staged", marker],
    ["partial-marker", ".validated", marker.slice(0, 20)],
  ];
  for (const [name, markerName, bytes] of variants) {
    const output = path.join(root, name);
    await writeLooseDirectory(output, packet, markerName, bytes);
    await assert.rejects(storage.readValidatedEvidencePacket(output, binding), expectedError(markerName === ".validated" ? "noncanonical-bytes" : "filesystem-safety"));
  }

  for (const name of ["missing", "extra", "directory", "symlink"]) {
    const output = path.join(root, name);
    await writeLooseDirectory(output, packet, ".validated", marker);
    if (name === "missing") await fs.unlink(path.join(output, "smoke.json"));
    if (name === "extra") await fs.writeFile(path.join(output, "extra"), "x");
    if (name === "directory") { await fs.unlink(path.join(output, "smoke.json")); await fs.mkdir(path.join(output, "smoke.json")); }
    if (name === "symlink") {
      await fs.unlink(path.join(output, "smoke.json"));
      const target = path.join(root, "symlink-target");
      await fs.mkdir(target);
      await fs.symlink(target, path.join(output, "smoke.json"), process.platform === "win32" ? "junction" : "dir");
    }
    await assert.rejects(storage.readValidatedEvidencePacket(output, binding), expectedError("filesystem-safety"), name);
  }

  const outputTarget = path.join(root, "output-symlink-target");
  const outputLink = path.join(root, "output-symlink");
  await fs.mkdir(outputTarget);
  await fs.writeFile(path.join(outputTarget, "keep"), "unchanged");
  await fs.symlink(outputTarget, outputLink, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(storage.readValidatedEvidencePacket(outputLink, binding), expectedError("filesystem-safety"));
  assert.deepEqual(await fs.readdir(outputTarget), ["keep"]);
  assert.equal(await fs.readFile(path.join(outputTarget, "keep"), "utf8"), "unchanged");
}));

test("marker canonicality, 65/66-byte boundary, and digest equality are exact", async () => temporary(async (root) => {
  const packet = makeEvidencePacket();
  const cases = [
    ["upper", `${packet.packetDigest.toUpperCase()}\n`, "noncanonical-bytes"],
    ["no-lf", packet.packetDigest, "noncanonical-bytes"],
    ["crlf", `${packet.packetDigest}\r\n`, "noncanonical-bytes"],
    ["oversized", `${packet.packetDigest}\nX`, "noncanonical-bytes"],
    ["mismatch", `${"0".repeat(64)}\n`, "invalid-payload"],
  ];
  for (const [name, value, code] of cases) {
    const output = path.join(root, name);
    await writeLooseDirectory(output, packet, ".validated", value);
    await assert.rejects(storage.readValidatedEvidencePacket(output, binding), expectedError(code), name);
  }
}));

test("each packet file accepts canonical bytes at its exact cap and rejects cap plus one before schema parsing", async () => temporary(async (root) => {
  const packet = makeEvidencePacket();
  for (const name of FILES) {
    const cap = CAPS.get(name);
    const exactBytes = new TextEncoder().encode(`${JSON.stringify("x".repeat(cap - 3))}\n`);
    assert.equal(exactBytes.byteLength, cap, `${name} exact fixture`);

    const exactOutput = path.join(root, `${name.replace(".json", "")}-exact`);
    await writeLooseDirectory(exactOutput, packet, ".validated", `${packet.packetDigest}\n`);
    await fs.writeFile(path.join(exactOutput, name), exactBytes);
    await assert.rejects(
      storage.readValidatedEvidencePacket(exactOutput, binding),
      expectedError("invalid-payload"),
      `${name} exact cap reaches semantic validation`,
    );

    const oversizedOutput = path.join(root, `${name.replace(".json", "")}-oversized`);
    await writeLooseDirectory(oversizedOutput, packet, ".validated", `${packet.packetDigest}\n`);
    await fs.writeFile(path.join(oversizedOutput, name), new Uint8Array(cap + 1));
    await assert.rejects(
      storage.readValidatedEvidencePacket(oversizedOutput, binding),
      expectedError("noncanonical-bytes"),
      `${name} cap plus one`,
    );
  }
}));

test("canonical file changes and marker mismatch remain invalid payloads without leaking diagnostics", async () => temporary(async (root) => {
  const packet = makeEvidencePacket();
  const output = path.join(root, "packet");
  await writeLooseDirectory(output, packet, ".validated", `${packet.packetDigest}\n`);
  const artifact = JSON.parse(await fs.readFile(path.join(output, "artifact.json"), "utf8"));
  artifact.reason = "production-unreachable";
  await fs.writeFile(path.join(output, "artifact.json"), `${JSON.stringify(artifact)}\n`);
  await assert.rejects(storage.readValidatedEvidencePacket(output, binding), expectedError("invalid-payload"));
}));

test("deterministic internal filesystem seams prove commit ordering, races, failure mapping, and owned cleanup", async () => {
  const helper = path.join(import.meta.dirname, "fixtures", "evidence-packet-files-seams.mjs");
  const { stdout, stderr } = await execute(process.execPath, ["--no-warnings", "--experimental-test-module-mocks", helper], {
    cwd: path.resolve(import.meta.dirname, ".."),
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  assert.equal(stderr, "");
  assert.match(stdout, /^seams: ok\s*$/);
});
