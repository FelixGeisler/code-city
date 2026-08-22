import assert from "node:assert/strict";
import * as realFs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mock } from "node:test";

import { binding, makeEvidencePacket } from "./evidence-packet-fixture.mjs";
import { EvidenceContractError } from "../../tools/production-evidence-schema.mjs";

if (typeof mock.module === "function") {
const state = {
  events: [],
  failure: null,
  holdClose: null,
  holdRename: null,
  holdRead: null,
  mutateAtSeal: null,
  sealMutated: false,
  extraOnRenameFailure: false,
  forceRenameFailure: false,
};
const issue = (code = "EIO") => Object.assign(new Error(code), { code });
const event = (operation, target = "") => state.events.push([operation, String(target)]);
const base = (target) => path.basename(String(target));
const matches = (operation, target = "") => {
  const matched = state.failure === `${operation}:${base(target)}` || state.failure === operation;
  if (matched) state.failure = null;
  return matched;
};

function gate() {
  let release;
  let reached;
  const waiting = new Promise((resolve) => { release = resolve; });
  const arrived = new Promise((resolve) => { reached = resolve; });
  return { waiting, arrived, release, reached };
}

function wrapHandle(handle, target, flag) {
  return {
    async stat(...args) {
      event("handle.stat", target);
      if (matches("handle.stat", target)) throw issue();
      return handle.stat(...args);
    },
    async write(buffer, offset, length, position) {
      event(`write:${length}`, target);
      if (matches("write", target)) throw issue();
      if (matches("short-write", target)) return { bytesWritten: Math.max(0, length - 1), buffer };
      return handle.write(buffer, offset, length, position);
    },
    async read(buffer, offset, length, position) {
      event(`read:${length}`, target);
      if (matches("read", target)) throw issue();
      return handle.read(buffer, offset, length, position);
    },
    async sync() {
      event("sync", target);
      if (matches("sync", target)) throw issue();
      return handle.sync();
    },
    async close() {
      event("close", target);
      if (base(target) === ".validated.staged" && flag === "wx" && state.holdClose) {
        state.holdClose.reached();
        await state.holdClose.waiting;
      }
      await handle.close();
      if (matches("close", target)) throw issue();
    },
  };
}

const mocked = {
  async lstat(target, ...args) {
    event("lstat", target);
    if (matches("lstat", target)) throw issue();
    return realFs.lstat(target, ...args);
  },
  async mkdir(target, ...args) {
    event("mkdir", target);
    if (state.failure === "reservation-race") {
      await realFs.mkdir(target);
      await realFs.writeFile(path.join(target, "winner"), "unchanged");
      throw issue("EEXIST");
    }
    if (matches("mkdir", target)) throw issue();
    return realFs.mkdir(target, ...args);
  },
  async open(target, flag, ...args) {
    event(`open:${flag}`, target);
    if (flag === "r" && base(target) === ".validated" && state.holdRead) {
      state.holdRead.reached();
      await state.holdRead.waiting;
    }
    if (matches(flag === "r" ? "open-read" : "open", target)) throw issue();
    return wrapHandle(await realFs.open(target, flag, ...args), target, flag);
  },
  async opendir(target, ...args) {
    event("opendir", target);
    if (matches("opendir", target)) throw issue();
    if (state.mutateAtSeal && !state.sealMutated) {
      state.sealMutated = true;
      const smoke = path.join(target, "smoke.json");
      if (state.mutateAtSeal === "extra") await realFs.writeFile(path.join(target, "extra"), "unexpected");
      if (state.mutateAtSeal === "missing") await realFs.unlink(smoke);
      if (state.mutateAtSeal === "directory") { await realFs.unlink(smoke); await realFs.mkdir(smoke); }
      if (state.mutateAtSeal === "changed") await realFs.writeFile(path.join(target, "artifact.json"), "{}\n");
    }
    const directory = await realFs.opendir(target, ...args);
    return {
      async read() {
        event("directory.read", target);
        if (matches("directory.read", target)) throw issue();
        return directory.read();
      },
      async close() {
        event("directory.close", target);
        await directory.close();
        if (matches("directory.close", target)) throw issue();
      },
    };
  },
  async rename(from, to) {
    event("rename", `${from}->${to}`);
    if (state.holdRename) {
      state.holdRename.reached();
      await state.holdRename.waiting;
    }
    if (state.extraOnRenameFailure) {
      await realFs.writeFile(path.join(path.dirname(from), "unknown"), "hostile");
      throw issue();
    }
    if (state.failure === "rename") { state.failure = null; throw issue(); }
    if (state.forceRenameFailure) throw issue();
    return realFs.rename(from, to);
  },
  async unlink(target) {
    event("unlink", target);
    if (matches("unlink", target)) throw issue();
    return realFs.unlink(target);
  },
  async rmdir(target) {
    event("rmdir", target);
    if (matches("rmdir", target)) throw issue();
    return realFs.rmdir(target);
  },
};

mock.module("node:fs/promises", { exports: mocked });
const storage = await import(`../../tools/evidence-packet-files.mjs?seams=${Date.now()}`);
const FILES = ["artifact.json", "smoke.json", "qualification.json", "capacity.json", "requests.json", "lifecycle.json", "index.json"];
const CAPS = new Map([
  ["artifact.json", 64 * 1024], ["smoke.json", 64 * 1024], ["qualification.json", 4 * 1024 * 1024],
  ["capacity.json", 4 * 1024 * 1024], ["requests.json", 8 * 1024 * 1024],
  ["lifecycle.json", 1024 * 1024], ["index.json", 16 * 1024],
]);

function expectCode(code) {
  return (error) => error instanceof EvidenceContractError && error.code === code
    && error.message === code && JSON.stringify(error) === JSON.stringify({ name: "EvidenceContractError", code });
}

async function temp(callback) {
  const root = await realFs.mkdtemp(path.join(os.tmpdir(), "code-city-evidence-seam-"));
  try { await callback(root); }
  finally {
    state.events = [];
    state.failure = null;
    state.holdClose = null;
    state.holdRename = null;
    state.holdRead = null;
    state.mutateAtSeal = null;
    state.sealMutated = false;
    state.extraOnRenameFailure = false;
    state.forceRenameFailure = false;
    await realFs.rm(root, { recursive: true, force: true });
  }
}

async function assertPending(promise) {
  let settled = false;
  promise.finally(() => { settled = true; }).catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
}

await temp(async (root) => {
  const output = path.join(root, "packet");
  const packet = makeEvidencePacket();
  await storage.writeValidatedEvidencePacket(output, packet);
  const events = state.events;
  assert.equal(events.filter(([operation, target]) => operation === "mkdir" && target === output).length, 1);
  assert.deepEqual(events.filter(([operation]) => operation === "open:wx").map(([, target]) => base(target)), [...FILES, ".validated.staged"]);
  assert.equal(events.filter(([operation]) => operation === "rename").length, 1);
  const markerWrite = events.findIndex(([operation, target]) => operation === "write:65" && base(target) === ".validated.staged");
  const markerSync = events.findIndex(([operation, target]) => operation === "sync" && base(target) === ".validated.staged");
  const markerClose = events.findIndex(([operation, target]) => operation === "close" && base(target) === ".validated.staged");
  const markerRename = events.findIndex(([operation]) => operation === "rename");
  assert(markerWrite >= 0 && markerWrite < markerSync && markerSync < markerClose && markerClose < markerRename);
  assert.equal(events.filter(([operation]) => operation === "directory.read").length, 8, "seven entries plus bounded EOF probe");
  for (const [name, cap] of CAPS) assert(events.some(([operation, target]) => operation === `read:${cap + 1}` && base(target) === name), name);
});

for (const phase of ["close", "rename"]) {
  await temp(async (root) => {
    const output = path.join(root, "packet");
    const source = makeEvidencePacket();
    const packet = {
      binding: { ...source.binding },
      files: new Map([...source.files].map(([name, bytes]) => [name, new Uint8Array(bytes)])),
      packetDigest: source.packetDigest,
    };
    const acceptedBinding = Object.freeze({ ...packet.binding });
    const acceptedDigest = packet.packetDigest;
    const hold = gate();
    if (phase === "close") state.holdClose = hold;
    else state.holdRename = hold;
    const writing = storage.writeValidatedEvidencePacket(output, packet);
    await hold.arrived;
    await assertPending(writing);
    await assert.rejects(storage.readValidatedEvidencePacket(output, acceptedBinding), expectCode("filesystem-safety"));
    assert.equal(await realFs.stat(path.join(output, ".validated.staged")).then(() => true), true);
    await assert.rejects(realFs.lstat(path.join(output, ".validated")), { code: "ENOENT" });

    packet.binding.eventSha = "b".repeat(40);
    packet.files.get("artifact.json").fill(0);
    packet.files.clear();
    packet.packetDigest = "0".repeat(64);

    hold.release();
    const result = await writing;
    assert.deepEqual(result, { packetDigest: acceptedDigest });
    assert.equal(await realFs.readFile(path.join(output, ".validated"), "utf8"), `${acceptedDigest}\n`);
    assert.equal((await storage.readValidatedEvidencePacket(output, acceptedBinding)).packetDigest, acceptedDigest);
  });
}

await temp(async (root) => {
  const output = path.join(root, "packet");
  const packet = makeEvidencePacket();
  await storage.writeValidatedEvidencePacket(output, packet);
  state.events = [];
  state.holdRead = gate();
  const accepted = storage.readValidatedEvidencePacket(output, binding);
  await state.holdRead.arrived;
  await assertPending(accepted);
  state.holdRead.release();
  assert.equal((await accepted).packetDigest, packet.packetDigest);

  state.holdRead = gate();
  const rejected = storage.readValidatedEvidencePacket(output, binding);
  await state.holdRead.arrived;
  await assertPending(rejected);
  await realFs.writeFile(path.join(output, ".validated"), `${packet.packetDigest}\nX`);
  state.holdRead.release();
  await assert.rejects(rejected, expectCode("noncanonical-bytes"));
});

for (const [mutation, expected, removed] of [
  ["extra", "io-failure", false],
  ["missing", "io-failure", false],
  ["directory", "io-failure", false],
  ["changed", "invalid-payload", true],
]) {
  await temp(async (root) => {
    const output = path.join(root, "packet");
    state.mutateAtSeal = mutation;
    await assert.rejects(storage.writeValidatedEvidencePacket(output, makeEvidencePacket()), expectCode(expected), mutation);
    assert.equal(await realFs.lstat(output).then(() => false, () => true), removed, mutation);
    if (!removed) await assert.rejects(realFs.lstat(path.join(output, ".validated")), { code: "ENOENT" });
  });
}

for (const [failurePoint, expected = "io-failure"] of [
  ["mkdir"], ["open:capacity.json"], ["handle.stat:capacity.json"], ["write:capacity.json"],
  ["short-write:capacity.json"], ["close:capacity.json"], ["opendir"], ["directory.read"],
  ["directory.close"], ["open-read:artifact.json"], ["read:artifact.json"], ["open:.validated.staged"],
  ["write:.validated.staged"], ["short-write:.validated.staged"], ["sync:.validated.staged"],
  ["close:.validated.staged"], ["rename"],
]) {
  await temp(async (root) => {
    const output = path.join(root, "packet");
    state.failure = failurePoint;
    await assert.rejects(storage.writeValidatedEvidencePacket(output, makeEvidencePacket()), expectCode(expected), failurePoint);
    await assert.rejects(realFs.lstat(output), { code: "ENOENT" }, failurePoint);
    assert.equal(state.events.some(([operation, target]) => operation === "rename" && target.includes(`${path.sep}.validated.staged->`)), failurePoint === "rename");
  });
}

await temp(async (root) => {
  const output = path.join(root, "packet");
  state.failure = "reservation-race";
  await assert.rejects(storage.writeValidatedEvidencePacket(output, makeEvidencePacket()), expectCode("filesystem-safety"));
  assert.equal(await realFs.readFile(path.join(output, "winner"), "utf8"), "unchanged");
  const mkdirIndex = state.events.findIndex(([operation]) => operation === "mkdir");
  assert.equal(state.events.slice(mkdirIndex + 1).some(([operation, target]) => operation === "lstat" && target === output), false);
  assert.equal(state.events.some(([operation]) => operation === "unlink" || operation === "rmdir"), false);
});

for (const cleanupFailure of ["unlink:.validated.staged", "rmdir"]) {
  await temp(async (root) => {
    const output = path.join(root, "packet");
    state.failure = cleanupFailure;
    state.forceRenameFailure = true;
    await assert.rejects(storage.writeValidatedEvidencePacket(output, makeEvidencePacket()), expectCode("io-failure"));
    assert.equal(await realFs.lstat(output).then(() => true), true);
    await assert.rejects(realFs.lstat(path.join(output, ".validated")), { code: "ENOENT" });
  });
}

await temp(async (root) => {
  const output = path.join(root, "packet");
  state.extraOnRenameFailure = true;
  await assert.rejects(storage.writeValidatedEvidencePacket(output, makeEvidencePacket()), expectCode("io-failure"));
  assert.equal(await realFs.readFile(path.join(output, "unknown"), "utf8"), "hostile");
  assert.equal(state.events.some(([operation]) => operation === "unlink"), false, "unsafe cleanup stops before unlinking owned children");
  await assert.rejects(realFs.lstat(path.join(output, ".validated")), { code: "ENOENT" });
});

console.log("seams: ok");
}
