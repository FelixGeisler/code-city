import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readValidatedEvidencePacket } from "./evidence-packet-files.mjs";
import { createExternalWrapper, validateExternalWrapper } from "./production-evidence-schema.mjs";

const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PARENT_ISSUE_BODY_SHA256 = "06f08ca0144ffe9d5e162f3eb74c898b8b3a9e789832eae8c406f0fef55d0184";
const PACKET_FILES = Object.freeze([
  "artifact.json",
  "smoke.json",
  "qualification.json",
  "capacity.json",
  "requests.json",
  "lifecycle.json",
  "index.json",
]);
const FILE_CAPS = new Map([
  ["artifact.json", 64 * 1024],
  ["smoke.json", 64 * 1024],
  ["qualification.json", 4 * 1024 * 1024],
  ["capacity.json", 4 * 1024 * 1024],
  ["requests.json", 8 * 1024 * 1024],
  ["lifecycle.json", 1024 * 1024],
  ["index.json", 16 * 1024],
]);
const METADATA_KEYS = Object.freeze([
  "artifactId",
  "artifactUrl",
  "platformDigest",
  "packetDigest",
  "eventSha",
  "runId",
  "runAttempt",
  "retentionDays",
]);
const DECODER = new TextDecoder("utf-8", { fatal: true });
const ENCODER = new TextEncoder();
const CLEANUP_WARNING = "Warning: wrapper published; temporary cleanup failed.\n";

function invariant(condition) {
  if (!condition) throw new Error("production evidence finalization failed");
}

function isMissing(error) {
  return error && typeof error === "object" && error.code === "ENOENT";
}

function isExisting(error) {
  return error && typeof error === "object" && error.code === "EEXIST";
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function exactKeys(value, expected) {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value));
  invariant(Object.getPrototypeOf(value) === Object.prototype);
  const keys = Reflect.ownKeys(value);
  invariant(keys.length === expected.length && keys.every((key, index) => key === expected[index]));
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    invariant(descriptor && Object.hasOwn(descriptor, "value") && descriptor.enumerable);
  }
}

function positiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function requireResolvedAbsolutePath(target) {
  invariant(typeof target === "string" && target.length > 0 && !target.includes("\0"));
  invariant(path.isAbsolute(target) && path.resolve(target) === target);
}

function isSameOrLexicallyBelow(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export function validateArtifactMetadata(value) {
  exactKeys(value, METADATA_KEYS);
  invariant(typeof value.artifactId === "string" && /^[1-9][0-9]{0,19}$/u.test(value.artifactId));
  invariant(value.artifactUrl === `https://github.com/FelixGeisler/code-city/actions/runs/${value.runId}/artifacts/${value.artifactId}`);
  invariant(typeof value.platformDigest === "string" && /^[0-9a-f]{64}$/u.test(value.platformDigest));
  invariant(typeof value.packetDigest === "string" && /^[0-9a-f]{64}$/u.test(value.packetDigest));
  invariant(typeof value.eventSha === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value.eventSha));
  invariant(positiveSafeInteger(value.runId));
  invariant(positiveSafeInteger(value.runAttempt));
  invariant(value.retentionDays === 90);
  return Object.freeze({ ...value });
}

export function parseFinalizerArguments(args) {
  invariant(Array.isArray(args));
  invariant(args.length === 6 && args[0] === "--packet" && args[2] === "--metadata" && args[4] === "--output");
  for (const index of [1, 3, 5]) invariant(typeof args[index] === "string" && args[index].length > 0 && !args[index].startsWith("-"));
  return Object.freeze({
    packet: path.resolve(args[1]),
    metadata: path.resolve(args[3]),
    output: path.resolve(args[5]),
  });
}

async function requireSafeAbsolutePath(target, includeTarget, io) {
  invariant(typeof target === "string" && target.length > 0 && !target.includes("\0"));
  invariant(path.isAbsolute(target) && path.resolve(target) === target);
  const parsed = path.parse(target);
  const parts = target.slice(parsed.root.length).split(path.sep).filter(Boolean);
  const limit = includeTarget ? parts.length : parts.length - 1;
  let current = parsed.root;
  for (let index = 0; index < limit; index += 1) {
    current = path.join(current, parts[index]);
    const stat = await io.lstat(current);
    invariant(stat.isDirectory() && !stat.isSymbolicLink());
  }
}

async function readBoundedRegularFile(target, cap, io) {
  const before = await io.lstat(target);
  invariant(before.isFile() && !before.isSymbolicLink());
  const handle = await io.open(target, "r");
  let bytes;
  let failure;
  try {
    const opened = await handle.stat();
    invariant(opened.isFile() && sameIdentity(before, opened));
    const buffer = new Uint8Array(cap + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const result = await handle.read(buffer, offset, buffer.byteLength - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    invariant(offset <= cap);
    bytes = buffer.slice(0, offset);
  } catch (error) {
    failure = error;
  }
  try { await handle.close(); } catch (error) { failure ??= error; }
  if (failure) throw failure;
  return bytes;
}

async function requireAbsent(target, io) {
  try {
    await io.lstat(target);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  invariant(false);
}

async function readMetadata(metadataPath, io) {
  await requireSafeAbsolutePath(metadataPath, false, io);
  const bytes = await readBoundedRegularFile(metadataPath, 8192, io);
  let value;
  try { value = JSON.parse(DECODER.decode(bytes)); } catch { invariant(false); }
  return validateArtifactMetadata(value);
}

async function copyPacketForValidation(packetPath, validationDirectory, metadata, io, packetReader) {
  await requireSafeAbsolutePath(packetPath, true, io);
  const packetStat = await io.lstat(packetPath);
  invariant(packetStat.isDirectory() && !packetStat.isSymbolicLink());
  const entries = await io.readdir(packetPath, { withFileTypes: true });
  invariant(entries.length === PACKET_FILES.length);
  invariant(entries.every((entry) => PACKET_FILES.includes(entry.name) && entry.isFile() && !entry.isSymbolicLink()));
  invariant(new Set(entries.map((entry) => entry.name)).size === PACKET_FILES.length);

  for (const name of PACKET_FILES) {
    const bytes = await readBoundedRegularFile(path.join(packetPath, name), FILE_CAPS.get(name), io);
    await io.writeFile(path.join(validationDirectory, name), bytes, { flag: "wx" });
  }
  await io.writeFile(path.join(validationDirectory, ".validated"), ENCODER.encode(`${metadata.packetDigest}\n`), { flag: "wx" });
  const packet = await packetReader(validationDirectory, {
    issueBodySha256: PARENT_ISSUE_BODY_SHA256,
    eventSha: metadata.eventSha,
  });
  invariant(packet.packetDigest === metadata.packetDigest);
  return packet;
}

function wrapperBinding(metadata) {
  return {
    artifactId: metadata.artifactId,
    platformDigest: metadata.platformDigest,
    packetDigest: metadata.packetDigest,
    eventSha: metadata.eventSha,
    runId: metadata.runId,
    runAttempt: metadata.runAttempt,
  };
}

async function writeAll(handle, bytes) {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.write(bytes, offset, bytes.byteLength - offset, offset);
    invariant(result.bytesWritten > 0);
    offset += result.bytesWritten;
  }
}

async function publishWrapper(output, bytes, binding, io, suffix, validateWrapper) {
  await requireSafeAbsolutePath(output, false, io);
  await requireAbsent(output, io);
  const parent = path.dirname(output);
  const temporary = path.join(parent, `.${path.basename(output)}.${suffix}.tmp`);
  let handle;
  let created = false;
  let linked = false;
  let primaryFailure;
  let cleanupFailure = false;

  try {
    handle = await io.open(temporary, "wx", 0o600);
    created = true;
    const opened = await handle.stat();
    invariant(opened.isFile());
    const named = await io.lstat(temporary);
    invariant(named.isFile() && !named.isSymbolicLink() && sameIdentity(opened, named));
    await writeAll(handle, bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;

    const reread = await readBoundedRegularFile(temporary, 4096, io);
    invariant(Buffer.from(reread).equals(Buffer.from(bytes)));
    validateWrapper(reread, binding);
    await io.link(temporary, output);
    linked = true;
  } catch (error) {
    primaryFailure = error;
  } finally {
    if (handle) {
      try { await handle.close(); } catch (error) { primaryFailure ??= error; }
    }
    if (created) {
      try { await io.unlink(temporary); } catch { cleanupFailure = true; }
    }
  }

  if (linked) return Object.freeze({ cleanupWarning: cleanupFailure });
  if (primaryFailure && isExisting(primaryFailure)) invariant(false);
  if (cleanupFailure) invariant(false);
  throw primaryFailure ?? new Error("production evidence finalization failed");
}

export async function finalizeProductionEvidence(options, seams = {}) {
  const io = seams.fs ?? fs;
  const packetReader = seams.readValidatedEvidencePacket ?? readValidatedEvidencePacket;
  const createWrapper = seams.createExternalWrapper ?? createExternalWrapper;
  const validateWrapper = seams.validateExternalWrapper ?? validateExternalWrapper;
  const suffix = seams.temporarySuffix ?? `${process.pid}.${randomBytes(16).toString("hex")}`;
  const validationTemporaryRoot = path.resolve(seams.validationTemporaryRoot ?? os.tmpdir());
  invariant(options && typeof options === "object");
  requireResolvedAbsolutePath(options.packet);
  requireResolvedAbsolutePath(options.metadata);
  requireResolvedAbsolutePath(options.output);
  requireResolvedAbsolutePath(PROJECT_ROOT);
  requireResolvedAbsolutePath(validationTemporaryRoot);

  for (const externalPath of [options.packet, options.metadata, options.output]) {
    invariant(!isSameOrLexicallyBelow(PROJECT_ROOT, externalPath));
  }
  invariant(!isSameOrLexicallyBelow(options.packet, options.output));
  invariant(!isSameOrLexicallyBelow(PROJECT_ROOT, validationTemporaryRoot));
  invariant(!isSameOrLexicallyBelow(options.packet, validationTemporaryRoot));

  await requireSafeAbsolutePath(PROJECT_ROOT, true, io);
  await requireSafeAbsolutePath(options.packet, true, io);
  await requireSafeAbsolutePath(options.metadata, false, io);
  await requireSafeAbsolutePath(options.output, false, io);
  await requireSafeAbsolutePath(validationTemporaryRoot, true, io);
  await requireAbsent(options.output, io);
  const metadata = await readMetadata(options.metadata, io);
  const validationDirectory = await io.mkdtemp(path.join(validationTemporaryRoot, "code-city-evidence-finalize-"));
  let packet;
  let validationFailure;
  try {
    packet = await copyPacketForValidation(options.packet, validationDirectory, metadata, io, packetReader);
  } catch (error) {
    validationFailure = error;
  }
  try { await io.rm(validationDirectory, { recursive: true, force: false }); } catch (error) { validationFailure ??= error; }
  if (validationFailure) throw validationFailure;
  invariant(packet.packetDigest === metadata.packetDigest);

  const binding = wrapperBinding(metadata);
  const wrapperBytes = createWrapper(binding);
  validateWrapper(wrapperBytes, binding);
  const publication = await publishWrapper(options.output, wrapperBytes, binding, io, suffix, validateWrapper);
  return Object.freeze({ wrapperBytes: new Uint8Array(wrapperBytes), cleanupWarning: publication.cleanupWarning });
}

export async function runFinalizerCli(args = process.argv.slice(2), seams = {}) {
  try {
    const options = parseFinalizerArguments(args);
    const result = await finalizeProductionEvidence(options, seams);
    if (result.cleanupWarning) process.stderr.write(CLEANUP_WARNING);
    return 0;
  } catch {
    process.stderr.write("Production evidence finalization failed safely.\n");
    return 1;
  }
}

const invokedPath = process.argv[1] && path.resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) process.exitCode = await runFinalizerCli();
