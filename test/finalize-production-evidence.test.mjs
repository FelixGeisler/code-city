import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  finalizeProductionEvidence,
  parseFinalizerArguments,
  runFinalizerCli,
  validateArtifactMetadata,
} from "../tools/finalize-production-evidence.mjs";
import { createEvidencePacket, validateExternalWrapper } from "../tools/production-evidence-schema.mjs";
import { binding, makeEvidencePacket } from "./fixtures/evidence-packet-fixture.mjs";

const execute = promisify(execFile);
const FILES = ["artifact.json", "smoke.json", "qualification.json", "capacity.json", "requests.json", "lifecycle.json", "index.json"];
const EVENT = binding.eventSha;
const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCRATCH_PREFIX = "code-city-evidence-finalize-";

async function temporary(callback) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "code-city-finalizer-test-"));
  try { return await callback(root); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}

function metadataFor(packet, overrides = {}) {
  const value = {
    artifactId: "987654321",
    artifactUrl: "https://github.com/FelixGeisler/code-city/actions/runs/123456/artifacts/987654321",
    platformDigest: "b".repeat(64),
    packetDigest: packet.packetDigest,
    eventSha: EVENT,
    runId: 123456,
    runAttempt: 2,
    retentionDays: 90,
    ...overrides,
  };
  if (overrides.runId !== undefined || overrides.artifactId !== undefined) {
    value.artifactUrl = overrides.artifactUrl ?? `https://github.com/FelixGeisler/code-city/actions/runs/${value.runId}/artifacts/${value.artifactId}`;
  }
  return value;
}

async function arrange(root, packet = makeEvidencePacket(), metadata = metadataFor(packet)) {
  const packetDirectory = path.join(root, "sealed");
  await fs.mkdir(packetDirectory);
  for (const [name, bytes] of packet.files) await fs.writeFile(path.join(packetDirectory, name), bytes);
  const metadataPath = path.join(root, "artifact-metadata.json");
  await fs.writeFile(metadataPath, `${JSON.stringify(metadata)}\n`);
  return { packet, packetDirectory, metadataPath, output: path.join(root, "wrapper.json") };
}

function options(fixture) {
  return { packet: fixture.packetDirectory, metadata: fixture.metadataPath, output: fixture.output };
}

async function snapshot(directory) {
  const result = new Map();
  for (const name of (await fs.readdir(directory)).sort()) result.set(name, await fs.readFile(path.join(directory, name)));
  return result;
}

async function snapshotTree(directory, current = directory, result = new Map()) {
  for (const entry of (await fs.readdir(current, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
    const target = path.join(current, entry.name);
    const relative = path.relative(directory, target);
    if (entry.isDirectory()) {
      result.set(relative, "directory");
      await snapshotTree(directory, target, result);
    } else if (entry.isSymbolicLink()) {
      result.set(relative, `symlink:${await fs.readlink(target)}`);
    } else {
      result.set(relative, new Uint8Array(await fs.readFile(target)));
    }
  }
  return result;
}

function mutationTrackingIo(mutations) {
  return {
    ...fs,
    async mkdtemp(...args) { mutations.push("mkdtemp"); return fs.mkdtemp(...args); },
    async writeFile(...args) { mutations.push("writeFile"); return fs.writeFile(...args); },
    async open(target, flags, ...args) {
      if (typeof flags === "string" && /[awx+]/u.test(flags)) mutations.push(`open:${flags}`);
      return fs.open(target, flags, ...args);
    },
    async link(...args) { mutations.push("link"); return fs.link(...args); },
    async unlink(...args) { mutations.push("unlink"); return fs.unlink(...args); },
    async rm(...args) { mutations.push("rm"); return fs.rm(...args); },
  };
}

function alternatePacket() {
  const original = makeEvidencePacket();
  const decoder = new TextDecoder();
  const payloads = {};
  for (const name of FILES.slice(0, -1)) payloads[name.slice(0, -5)] = JSON.parse(decoder.decode(original.files.get(name)));
  payloads.lifecycle.data.events[1].atMs = 2;
  payloads.lifecycle.data.durations.total = 2;
  return createEvidencePacket(payloads, binding);
}

test("the CLI accepts exactly three once-only ordered options and rejects every other shape before output", async () => temporary(async (root) => {
  const valid = ["--packet", path.join(root, "packet"), "--metadata", path.join(root, "metadata.json"), "--output", path.join(root, "wrapper.json")];
  assert.deepEqual(parseFinalizerArguments(valid), {
    packet: path.resolve(valid[1]), metadata: path.resolve(valid[3]), output: path.resolve(valid[5]),
  });
  const invalid = [
    [], valid.slice(0, -1), [...valid, "extra"], ["position", ...valid],
    ["--metadata", valid[3], "--packet", valid[1], "--output", valid[5]],
    ["--packet", valid[1], "--packet", valid[1], "--output", valid[5]],
    ["--packet", "--metadata", "x", "--output", "y", "z"],
  ];
  for (const args of invalid) assert.throws(() => parseFinalizerArguments(args));
  assert.equal(await runFinalizerCli(["--output", valid[5]]), 1);
  await assert.rejects(fs.lstat(valid[5]), { code: "ENOENT" });
}));

test("metadata is exact, closed, typed, canonical-run bound, and retention-bound", () => {
  const packet = makeEvidencePacket();
  const valid = metadataFor(packet);
  assert.deepEqual(validateArtifactMetadata(valid), valid);
  const mutations = {
    artifactId: "0", artifactUrl: "https://example.com", platformDigest: "B".repeat(64), packetDigest: "x",
    eventSha: "x", runId: 0, runAttempt: 0, retentionDays: 89,
  };
  for (const [key, value] of Object.entries(mutations)) assert.throws(() => validateArtifactMetadata({ ...valid, [key]: value }), key);
  assert.throws(() => validateArtifactMetadata({ extra: true, ...valid }));
  const missing = { ...valid }; delete missing.packetDigest;
  assert.throws(() => validateArtifactMetadata(missing));
  assert.throws(() => validateArtifactMetadata({ runAttempt: valid.runAttempt, ...valid }));
});

test("finalization copies an exact marker-free packet, uses the validated reader, writes canonical wrapper bytes, and never mutates the packet", async () => temporary(async (root) => {
  const fixture = await arrange(root);
  const before = await snapshot(fixture.packetDirectory);
  let readerCalls = 0;
  const result = await finalizeProductionEvidence(options(fixture), {
    temporarySuffix: "success",
    async readValidatedEvidencePacket(directory, expectedBinding) {
      readerCalls += 1;
      assert.notEqual(directory, fixture.packetDirectory);
      assert.deepEqual(expectedBinding, binding);
      const module = await import("../tools/evidence-packet-files.mjs");
      return module.readValidatedEvidencePacket(directory, expectedBinding);
    },
  });
  assert.equal(readerCalls, 1);
  assert.equal(result.cleanupWarning, false);
  assert.deepEqual(await snapshot(fixture.packetDirectory), before);
  assert.deepEqual((await fs.readdir(fixture.packetDirectory)).sort(), FILES.slice().sort());
  const bytes = new Uint8Array(await fs.readFile(fixture.output));
  assert.deepEqual(bytes, result.wrapperBytes);
  const expectedBinding = {
    artifactId: "987654321", platformDigest: "b".repeat(64), packetDigest: fixture.packet.packetDigest,
    eventSha: EVENT, runId: 123456, runAttempt: 2,
  };
  const wrapper = validateExternalWrapper(bytes, expectedBinding);
  assert.deepEqual(Object.keys(wrapper), ["schemaVersion", "artifactId", "artifactUrl", "platformDigest", "packetDigest", "eventSha", "runId", "runAttempt", "retentionDays"]);
  assert.equal(new TextDecoder().decode(bytes), `${JSON.stringify(wrapper)}\n`);
  await assert.rejects(fs.lstat(path.join(root, ".wrapper.json.success.tmp")), { code: "ENOENT" });
}));

test("finalizer rejects packet v1 and every mixed envelope, index, and collector version without a wrapper", async () => temporary(async (root) => {
  const mutations = [
    ...["artifact", "smoke", "qualification", "capacity", "requests", "lifecycle"]
      .map((name) => [`${name} envelope v1`, `${name}.json`, (value) => { value.schemaVersion = 1; }]),
    ["collector v1", "lifecycle.json", (value) => { value.data.collectorVersion = 1; }],
    ["index v1", "index.json", (value) => { value.schemaVersion = 1; }],
  ];
  for (const [name, file, mutate] of mutations) {
    const scenarioRoot = path.join(root, name.replaceAll(" ", "-"));
    await fs.mkdir(scenarioRoot);
    const source = makeEvidencePacket();
    const files = new Map(source.files);
    const value = JSON.parse(new TextDecoder().decode(files.get(file)));
    mutate(value);
    files.set(file, new TextEncoder().encode(`${JSON.stringify(value)}\n`));
    const fixture = await arrange(scenarioRoot, { ...source, files });
    const before = await snapshot(fixture.packetDirectory);
    await assert.rejects(finalizeProductionEvidence(options(fixture), { temporarySuffix: "packet-v1" }), undefined, name);
    await assert.rejects(fs.lstat(fixture.output), { code: "ENOENT" }, `${name} emitted a wrapper`);
    assert.deepEqual(await snapshot(fixture.packetDirectory), before, `${name} mutated the packet`);
  }
}));

test("finalizer compiles the accepted parent digest and exposes no runtime replacement path", async () => temporary(async (root) => {
  const fixture = await arrange(root);
  const formerDigest = "f06369b3eef5e62631ee8f61ddfd7679b00a3d2139dd83a2f6472820e62864e6";
  let observedBinding;
  await finalizeProductionEvidence(options(fixture), {
    temporarySuffix: "fixed-parent",
    async readValidatedEvidencePacket(directory, expectedBinding) {
      observedBinding = expectedBinding;
      const module = await import("../tools/evidence-packet-files.mjs");
      return module.readValidatedEvidencePacket(directory, expectedBinding);
    },
  });
  assert.deepEqual(observedBinding, binding);
  assert.notEqual(observedBinding.issueBodySha256, formerDigest);
}));

test("fixed module custody rejects repository output, packet, and metadata paths before mutation", async () => temporary(async (root) => {
  const fixture = await arrange(root);
  const packetBefore = await snapshotTree(fixture.packetDirectory);
  const repositoryNamesBefore = (await fs.readdir(PROJECT_ROOT)).sort();
  const repositoryBytesBefore = await fs.readFile(path.join(PROJECT_ROOT, "package.json"));
  const fixtureTreeBefore = await snapshotTree(path.join(PROJECT_ROOT, "test", "fixtures"));
  const nestedRepositoryOutput = path.join(PROJECT_ROOT, "test", "fixtures", "publication-custody", "wrapper.json");

  const cases = [
    ["repository output", { ...options(fixture), output: PROJECT_ROOT }],
    ["nested repository output", { ...options(fixture), output: nestedRepositoryOutput }],
    ["repository packet", { ...options(fixture), packet: PROJECT_ROOT }],
    ["repository metadata", { ...options(fixture), metadata: path.join(PROJECT_ROOT, "package.json") }],
  ];
  for (const [name, unsafe] of cases) {
    const mutations = [];
    await assert.rejects(finalizeProductionEvidence(unsafe, {
      fs: mutationTrackingIo(mutations),
      temporarySuffix: "repository-custody",
    }), undefined, name);
    assert.deepEqual(mutations, [], `${name} reached a mutating operation`);
    assert.deepEqual(await snapshotTree(fixture.packetDirectory), packetBefore, name);
  }

  assert.deepEqual((await fs.readdir(PROJECT_ROOT)).sort(), repositoryNamesBefore);
  assert.deepEqual(await fs.readFile(path.join(PROJECT_ROOT, "package.json")), repositoryBytesBefore);
  assert.deepEqual(await snapshotTree(path.join(PROJECT_ROOT, "test", "fixtures")), fixtureTreeBefore);
  await assert.rejects(fs.lstat(nestedRepositoryOutput), { code: "ENOENT" });
}));

test("validation scratch accepts only a real external root and rejects repository, packet, non-directory, and symlink roots before creation", async () => temporary(async (root) => {
  const fixture = await arrange(root);
  const repositoryNamesBefore = (await fs.readdir(PROJECT_ROOT)).sort();
  const testsBefore = await snapshotTree(path.join(PROJECT_ROOT, "test"));
  const packetBefore = await snapshotTree(fixture.packetDirectory);
  const packetAlias = path.join(root, "packet-temp-alias");
  const repositoryAlias = path.join(root, "repository-temp-alias");
  await fs.symlink(fixture.packetDirectory, packetAlias, process.platform === "win32" ? "junction" : "dir");
  await fs.symlink(PROJECT_ROOT, repositoryAlias, process.platform === "win32" ? "junction" : "dir");

  const unsafeRoots = [
    ["repository root", PROJECT_ROOT],
    ["repository child", path.join(PROJECT_ROOT, "test")],
    ["packet root", fixture.packetDirectory],
    ["packet child", path.join(fixture.packetDirectory, "nested-temp")],
    ["non-directory", fixture.metadataPath],
    ["repository symlink alias", repositoryAlias],
    ["packet symlink alias", packetAlias],
  ];
  for (const [name, validationTemporaryRoot] of unsafeRoots) {
    const mutations = [];
    await assert.rejects(finalizeProductionEvidence(options(fixture), {
      fs: mutationTrackingIo(mutations),
      temporarySuffix: "unsafe-temp-root",
      validationTemporaryRoot,
    }), undefined, name);
    assert.deepEqual(mutations, [], `${name} reached a mutating operation`);
    assert.deepEqual(await snapshotTree(fixture.packetDirectory), packetBefore, name);
    await assert.rejects(fs.lstat(fixture.output), { code: "ENOENT" });
  }

  await assert.rejects(
    execute(process.execPath, [
      "tools/finalize-production-evidence.mjs",
      "--packet", fixture.packetDirectory,
      "--metadata", fixture.metadataPath,
      "--output", fixture.output,
    ], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, TMPDIR: PROJECT_ROOT, TMP: PROJECT_ROOT, TEMP: PROJECT_ROOT },
    }),
    (error) => error.code === 1 && error.stdout === "" && error.stderr === "Production evidence finalization failed safely.\n",
  );

  assert.deepEqual((await fs.readdir(PROJECT_ROOT)).sort(), repositoryNamesBefore);
  assert.deepEqual(await snapshotTree(path.join(PROJECT_ROOT, "test")), testsBefore);
  assert.deepEqual(await snapshotTree(fixture.packetDirectory), packetBefore);
  for (const directory of [PROJECT_ROOT, path.join(PROJECT_ROOT, "test"), fixture.packetDirectory]) {
    assert.deepEqual((await fs.readdir(directory)).filter((name) => name.startsWith(SCRATCH_PREFIX)), []);
  }

  const productionRoot = path.join(root, "packets", "FelixGeisler--code-city", "issue-496", EVENT, "production");
  const validationTemporaryRoot = path.join(root, "external-validation-temp");
  await fs.mkdir(productionRoot, { recursive: true });
  await fs.mkdir(validationTemporaryRoot);
  const validFixture = await arrange(productionRoot);
  await finalizeProductionEvidence(options(validFixture), {
    temporarySuffix: "external-custody",
    validationTemporaryRoot,
  });
  assert((await fs.lstat(validFixture.output)).isFile());
  assert.deepEqual(await fs.readdir(validationTemporaryRoot), []);
  assert.deepEqual((await fs.readdir(validFixture.packetDirectory)).sort(), FILES.slice().sort());
}));

test("packet-contained outputs and symlink aliases fail before mutation and preserve the exact seven packet files", async () => temporary(async (root) => {
  const fixture = await arrange(root);
  const before = await snapshot(fixture.packetDirectory);
  const beforeRootNames = (await fs.readdir(root)).sort();
  assert.deepEqual([...before.keys()], FILES.slice().sort());

  for (const [name, output] of [
    ["packet directory", fixture.packetDirectory],
    ["packet wrapper", path.join(fixture.packetDirectory, "wrapper.json")],
    ["nested packet wrapper", path.join(fixture.packetDirectory, "nested", "wrapper.json")],
  ]) {
    const mutations = [];
    const io = { ...fs };
    for (const operation of ["mkdtemp", "writeFile", "open", "link", "unlink", "rm"]) {
      io[operation] = async (...args) => {
        mutations.push(operation);
        return fs[operation](...args);
      };
    }
    await assert.rejects(finalizeProductionEvidence({ ...options(fixture), output }, { fs: io, temporarySuffix: name.replaceAll(" ", "-") }));
    assert.deepEqual(mutations, [], `${name} was rejected only after mutation started`);
    assert.deepEqual(await snapshot(fixture.packetDirectory), before, name);
    assert.deepEqual((await fs.readdir(fixture.packetDirectory)).sort(), FILES.slice().sort(), name);
    assert.deepEqual((await fs.readdir(root)).sort(), beforeRootNames, name);
  }

  const alias = path.join(root, "sealed-alias");
  await fs.symlink(fixture.packetDirectory, alias, process.platform === "win32" ? "junction" : "dir");
  const aliasRootNames = (await fs.readdir(root)).sort();
  for (const unsafe of [
    { ...options(fixture), output: path.join(alias, "wrapper.json") },
    { ...options(fixture), packet: alias },
  ]) {
    await assert.rejects(finalizeProductionEvidence(unsafe, { temporarySuffix: "alias" }));
    assert.deepEqual(await snapshot(fixture.packetDirectory), before);
    assert.deepEqual((await fs.readdir(fixture.packetDirectory)).sort(), FILES.slice().sort());
    assert.deepEqual((await fs.readdir(root)).sort(), aliasRootNames);
  }
  await assert.rejects(fs.lstat(path.join(fixture.packetDirectory, "wrapper.json")), { code: "ENOENT" });
  await assert.rejects(fs.lstat(path.join(fixture.packetDirectory, "nested")), { code: "ENOENT" });
}));

test("missing, extra, changed, symlinked, and substituted valid packet files never publish", async () => temporary(async (root) => {
  const variants = ["missing", "extra", "changed", "symlink"];
  for (const variant of variants) {
    const directory = path.join(root, variant);
    await fs.mkdir(directory);
    const fixture = await arrange(directory);
    if (variant === "missing") await fs.unlink(path.join(fixture.packetDirectory, "smoke.json"));
    if (variant === "extra") await fs.writeFile(path.join(fixture.packetDirectory, "extra.json"), "{}\n");
    if (variant === "changed") await fs.appendFile(path.join(fixture.packetDirectory, "smoke.json"), " ");
    if (variant === "symlink") {
      const target = path.join(directory, "target-directory");
      await fs.mkdir(target);
      await fs.unlink(path.join(fixture.packetDirectory, "smoke.json"));
      await fs.symlink(target, path.join(fixture.packetDirectory, "smoke.json"), process.platform === "win32" ? "junction" : "dir");
    }
    await assert.rejects(finalizeProductionEvidence(options(fixture), { temporarySuffix: variant }));
    await assert.rejects(fs.lstat(fixture.output), { code: "ENOENT" });
  }

  const substituteRoot = path.join(root, "substitute");
  await fs.mkdir(substituteRoot);
  const original = makeEvidencePacket();
  const replacement = alternatePacket();
  assert.notEqual(replacement.packetDigest, original.packetDigest);
  const fixture = await arrange(substituteRoot, replacement, metadataFor(original));
  await assert.rejects(finalizeProductionEvidence(options(fixture), { temporarySuffix: "substitute" }));
  await assert.rejects(fs.lstat(fixture.output), { code: "ENOENT" });

  const bindingRoot = path.join(root, "binding");
  await fs.mkdir(bindingRoot);
  const bindingFixture = await arrange(bindingRoot, original, metadataFor(original, { eventSha: "c".repeat(40) }));
  await assert.rejects(finalizeProductionEvidence(options(bindingFixture), { temporarySuffix: "binding" }));
  await assert.rejects(fs.lstat(bindingFixture.output), { code: "ENOENT" });
}));

test("unsafe ancestors, existing output, and a link-time EEXIST race preserve existing content", async () => temporary(async (root) => {
  const fixture = await arrange(root);
  await fs.writeFile(fixture.output, "existing");
  await assert.rejects(finalizeProductionEvidence(options(fixture), { temporarySuffix: "existing" }));
  assert.equal(await fs.readFile(fixture.output, "utf8"), "existing");

  await fs.unlink(fixture.output);
  const actualLink = fs.link;
  const io = {
    ...fs,
    async link(source, output) {
      await fs.writeFile(output, "racer", { flag: "wx" });
      return actualLink(source, output);
    },
  };
  await assert.rejects(finalizeProductionEvidence(options(fixture), { fs: io, temporarySuffix: "race" }));
  assert.equal(await fs.readFile(fixture.output, "utf8"), "racer");
  await assert.rejects(fs.lstat(path.join(root, ".wrapper.json.race.tmp")), { code: "ENOENT" });

  const real = path.join(root, "real");
  const linked = path.join(root, "linked");
  await fs.mkdir(real);
  await fs.symlink(real, linked, process.platform === "win32" ? "junction" : "dir");
  const unsafe = { ...options(fixture), output: path.join(linked, "wrapper.json") };
  await assert.rejects(finalizeProductionEvidence(unsafe, { temporarySuffix: "unsafe" }));
  assert.deepEqual(await fs.readdir(real), []);
}));

test("publication performs exclusive create, write, fsync, reread validation, hard link, and exactly one cleanup attempt", async () => temporary(async (root) => {
  const fixture = await arrange(root);
  const events = [];
  const io = {
    ...fs,
    async open(target, flags, mode) {
      const handle = await fs.open(target, flags, mode);
      if (target.includes(".wrapper.json.sequence.tmp")) {
        events.push(`open:${flags}`);
        return {
          stat: (...args) => handle.stat(...args),
          write: async (...args) => { events.push("write"); return handle.write(...args); },
          sync: async (...args) => { events.push("sync"); return handle.sync(...args); },
          close: (...args) => handle.close(...args),
          read: async (...args) => { events.push("reread"); return handle.read(...args); },
        };
      }
      return handle;
    },
    async link(source, output) { events.push("link"); return fs.link(source, output); },
    async unlink(target) { if (target.includes(".wrapper.json.sequence.tmp")) events.push("unlink"); return fs.unlink(target); },
  };
  await finalizeProductionEvidence(options(fixture), { fs: io, temporarySuffix: "sequence" });
  assert.deepEqual(events, ["open:wx", "write", "sync", "open:r", "reread", "reread", "link", "unlink"]);
  assert.equal(events.filter((event) => event === "unlink").length, 1);
}));

test("exclusive creation, write, fsync, reread-validation, link, and cleanup failures are contained without rename or retry", async () => temporary(async (root) => {
  const createRoot = path.join(root, "create");
  await fs.mkdir(createRoot);
  const createFixture = await arrange(createRoot);
  let createCleanupCalls = 0;
  const createIo = {
    ...fs,
    async open(target, flags, mode) {
      if (target.includes(".wrapper.json.create.tmp") && flags === "wx") throw new Error("exclusive create");
      return fs.open(target, flags, mode);
    },
    async unlink(target) { if (target.includes(".wrapper.json.create.tmp")) createCleanupCalls += 1; return fs.unlink(target); },
  };
  await assert.rejects(finalizeProductionEvidence(options(createFixture), { fs: createIo, temporarySuffix: "create" }));
  assert.equal(createCleanupCalls, 0, "an uncreated path is not invocation-owned");
  await assert.rejects(fs.lstat(createFixture.output), { code: "ENOENT" });

  for (const stage of ["write", "sync", "reread", "validate", "link", "cleanup"]) {
    const directory = path.join(root, stage);
    await fs.mkdir(directory);
    const fixture = await arrange(directory);
    let unlinkCalls = 0;
    let validationCalls = 0;
    const io = {
      ...fs,
      async open(target, flags, mode) {
        const handle = await fs.open(target, flags, mode);
        if (!target.includes(`.wrapper.json.${stage}.tmp`)) return handle;
        if (stage === "reread" && flags === "r") {
          return { stat: (...args) => handle.stat(...args), read: async () => { throw new Error("read"); }, close: (...args) => handle.close(...args) };
        }
        if (flags !== "wx") return handle;
        return {
          stat: (...args) => handle.stat(...args),
          write: ["write", "cleanup"].includes(stage) ? async () => { throw new Error("write"); } : (...args) => handle.write(...args),
          sync: stage === "sync" ? async () => { throw new Error("sync"); } : (...args) => handle.sync(...args),
          close: (...args) => handle.close(...args),
        };
      },
      async link(source, output) { if (stage === "link") throw new Error("link"); return fs.link(source, output); },
      async unlink(target) {
        if (target.includes(`.wrapper.json.${stage}.tmp`)) {
          unlinkCalls += 1;
          if (stage === "cleanup") throw new Error("cleanup");
        }
        return fs.unlink(target);
      },
    };
    const seams = {
      fs: io,
      temporarySuffix: stage,
      validateExternalWrapper(bytes, wrapperBinding) {
        validationCalls += 1;
        if (stage === "validate" && validationCalls === 2) throw new Error("validate");
        return validateExternalWrapper(bytes, wrapperBinding);
      },
    };
    await assert.rejects(finalizeProductionEvidence(options(fixture), seams), undefined, stage);
    assert.equal(unlinkCalls, 1, stage);
    await assert.rejects(fs.lstat(fixture.output), { code: "ENOENT" });
  }
}));

test("post-link cleanup failure succeeds with only the fixed privacy-safe warning and committed valid output", async () => temporary(async (root) => {
  const fixture = await arrange(root);
  let unlinkCalls = 0;
  const io = {
    ...fs,
    async unlink(target) {
      if (target.includes(".wrapper.json.warning.tmp")) { unlinkCalls += 1; throw new Error("private path"); }
      return fs.unlink(target);
    },
  };
  let stderr = "";
  const originalWrite = process.stderr.write;
  process.stderr.write = (value) => { stderr += value; return true; };
  let code;
  try { code = await runFinalizerCli(["--packet", fixture.packetDirectory, "--metadata", fixture.metadataPath, "--output", fixture.output], { fs: io, temporarySuffix: "warning" }); }
  finally { process.stderr.write = originalWrite; }
  assert.equal(code, 0);
  assert.equal(unlinkCalls, 1);
  assert.equal(stderr, "Warning: wrapper published; temporary cleanup failed.\n");
  assert((await fs.lstat(fixture.output)).isFile());
}));

test("the finalizer is dependency-free and contains no network, credential, subprocess, repository-write, rename, or output-removal path", async () => {
  const source = await fs.readFile("tools/finalize-production-evidence.mjs", "utf8");
  assert.doesNotMatch(source, /node:(?:http|https|net|tls|child_process)|\bfetch\s*\(|GITHUB_TOKEN|GH_TOKEN|execFile|spawn|\.rename\s*\(/u);
  assert.doesNotMatch(source, /unlink\(output\)|rm\(output/u);
  await assert.rejects(
    execute(process.execPath, ["tools/finalize-production-evidence.mjs", "--unknown", "value"]),
    (error) => error.code === 1 && error.stdout === "" && error.stderr === "Production evidence finalization failed safely.\n",
  );
});
