import * as fs from "node:fs/promises";
import path from "node:path";
import { types as utilTypes } from "node:util";

import { EvidenceContractError, validateEvidencePacket } from "./production-evidence-schema.mjs";

const FILES = [
  "artifact.json",
  "smoke.json",
  "qualification.json",
  "capacity.json",
  "requests.json",
  "lifecycle.json",
  "index.json",
];
const CAPS = new Map([
  ["artifact.json", 64 * 1024],
  ["smoke.json", 64 * 1024],
  ["qualification.json", 4 * 1024 * 1024],
  ["capacity.json", 4 * 1024 * 1024],
  ["requests.json", 8 * 1024 * 1024],
  ["lifecycle.json", 1024 * 1024],
  ["index.json", 16 * 1024],
]);
const MARKER = ".validated";
const STAGED_MARKER = ".validated.staged";
const ENCODER = new TextEncoder();
const DECODER = new TextDecoder("utf-8", { fatal: true });

function failure(code) {
  return new EvidenceContractError(code);
}

function exactPacket(value) {
  if (typeof value !== "object" || value === null || utilTypes.isProxy(value)
      || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw failure("invalid-payload");
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 3 || keys[0] !== "binding" || keys[1] !== "files" || keys[2] !== "packetDigest") throw failure("invalid-payload");
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw failure("invalid-payload");
  }
}

function sameBinding(left, right) {
  return left.issueBodySha256 === right.issueBodySha256 && left.eventSha === right.eventSha;
}

function normalized(error, fallback = "io-failure") {
  return error instanceof EvidenceContractError ? error : failure(fallback);
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

async function checkedLstat(target, missingCode = "filesystem-safety") {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if (isMissing(error)) throw failure(missingCode);
    throw failure("io-failure");
  }
}

function requireDirectory(stat) {
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw failure("filesystem-safety");
}

function requireRegular(stat) {
  if (stat.isSymbolicLink() || !stat.isFile()) throw failure("filesystem-safety");
}

async function checkPath(output, includeOutput) {
  if (typeof output !== "string" || output.length === 0 || output.includes("\0")
      || !path.isAbsolute(output) || path.resolve(output) !== output) {
    throw failure("filesystem-safety");
  }
  const parsed = path.parse(output);
  const relative = output.slice(parsed.root.length);
  const parts = relative.length === 0 ? [] : relative.split(path.sep);
  const limit = includeOutput ? parts.length : parts.length - 1;
  let current = parsed.root;
  requireDirectory(await checkedLstat(current));
  for (let index = 0; index < limit; index += 1) {
    current = path.join(current, parts[index]);
    requireDirectory(await checkedLstat(current));
  }
}

async function closeHandle(handle, priorError = null) {
  try {
    await handle.close();
  } catch {
    throw failure("io-failure");
  }
  if (priorError) throw priorError;
}

async function readBoundedFile(target, cap) {
  const entry = await checkedLstat(target);
  requireRegular(entry);
  let handle;
  try {
    handle = await fs.open(target, "r");
  } catch (error) {
    throw failure(isMissing(error) ? "filesystem-safety" : "io-failure");
  }
  let result;
  let readError = null;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameIdentity(entry, opened)) throw failure("filesystem-safety");
    const buffer = new Uint8Array(cap + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > cap) throw failure("noncanonical-bytes");
    result = buffer.slice(0, offset);
  } catch (error) {
    readError = normalized(error);
  }
  await closeHandle(handle, readError);
  return result;
}

async function boundedNames(output, maximum) {
  let directory;
  try {
    directory = await fs.opendir(output);
  } catch (error) {
    throw failure(isMissing(error) ? "filesystem-safety" : "io-failure");
  }
  const names = [];
  let iterationError = null;
  try {
    while (names.length < maximum) {
      const entry = await directory.read();
      if (entry === null) break;
      names.push(entry.name);
    }
  } catch (error) {
    iterationError = normalized(error);
  }
  try {
    await directory.close();
  } catch {
    throw iterationError ?? failure("io-failure");
  }
  if (iterationError) throw iterationError;
  return names;
}

function requireExactNames(names, expected) {
  if (names.length !== expected.length || new Set(names).size !== names.length
      || names.some((name) => !expected.includes(name))) throw failure("filesystem-safety");
}

async function readPacketFiles(output) {
  const files = new Map();
  for (const name of FILES) files.set(name, await readBoundedFile(path.join(output, name), CAPS.get(name)));
  return files;
}

async function verifyCreatedEntries(output) {
  const names = await boundedNames(output, 8);
  requireExactNames(names, FILES);
  return readPacketFiles(output);
}

async function verifyAbsent(target) {
  try {
    await fs.lstat(target);
  } catch (error) {
    if (isMissing(error)) return;
    throw failure("io-failure");
  }
  throw failure("filesystem-safety");
}

async function cleanup(output, directoryIdentity, created) {
  try {
    const currentDirectory = await fs.lstat(output);
    requireDirectory(currentDirectory);
    if (!sameIdentity(currentDirectory, directoryIdentity)) throw failure("io-failure");
    const names = await boundedNames(output, created.length + 1);
    requireExactNames(names, created.map(({ name }) => name));
    for (const item of created) {
      const current = await fs.lstat(path.join(output, item.name));
      requireRegular(current);
      if (item.identity !== null && !sameIdentity(current, item.identity)) throw failure("io-failure");
    }
    for (const item of [...created].reverse()) await fs.unlink(path.join(output, item.name));
    await fs.rmdir(output);
  } catch {
    throw failure("io-failure");
  }
}

export async function writeValidatedEvidencePacket(output, packet) {
  let reserved = false;
  let committed = false;
  let directoryIdentity;
  const created = [];
  try {
    exactPacket(packet);
    const validated = validateEvidencePacket(packet.files, packet.binding);
    const ownedBinding = Object.freeze({
      issueBodySha256: validated.binding.issueBodySha256,
      eventSha: validated.binding.eventSha,
    });
    const ownedPacketDigest = validated.packetDigest;
    if (!sameBinding(ownedBinding, packet.binding) || ownedPacketDigest !== packet.packetDigest) {
      throw failure("invalid-payload");
    }

    await checkPath(output, false);
    try {
      await fs.mkdir(output);
    } catch (error) {
      throw failure(isExisting(error) ? "filesystem-safety" : "io-failure");
    }
    reserved = true;
    directoryIdentity = await checkedLstat(output);
    requireDirectory(directoryIdentity);

    for (const name of FILES) {
      const target = path.join(output, name);
      let handle;
      try {
        handle = await fs.open(target, "wx");
      } catch (error) {
        throw failure(isExisting(error) ? "filesystem-safety" : "io-failure");
      }
      const tracked = { name, identity: null };
      created.push(tracked);
      try {
        tracked.identity = await handle.stat();
        if (!tracked.identity.isFile()) throw failure("filesystem-safety");
      } catch (error) {
        await closeHandle(handle).catch(() => {});
        throw normalized(error);
      }
      let writeError = null;
      try {
        const bytes = validated.files.get(name);
        const { bytesWritten } = await handle.write(bytes, 0, bytes.byteLength, 0);
        if (bytesWritten !== bytes.byteLength) throw failure("io-failure");
      } catch (error) {
        writeError = normalized(error);
      }
      await closeHandle(handle, writeError);
    }

    const rereadFiles = await verifyCreatedEntries(output);
    const reread = validateEvidencePacket(rereadFiles, ownedBinding);
    if (!sameBinding(reread.binding, ownedBinding) || reread.packetDigest !== ownedPacketDigest) {
      throw failure("invalid-payload");
    }

    const markerBytes = ENCODER.encode(`${ownedPacketDigest}\n`);
    const stagedTarget = path.join(output, STAGED_MARKER);
    let markerHandle;
    try {
      markerHandle = await fs.open(stagedTarget, "wx");
    } catch (error) {
      throw failure(isExisting(error) ? "filesystem-safety" : "io-failure");
    }
    const staged = { name: STAGED_MARKER, identity: null };
    created.push(staged);
    try {
      staged.identity = await markerHandle.stat();
      if (!staged.identity.isFile()) throw failure("filesystem-safety");
    } catch (error) {
      await closeHandle(markerHandle).catch(() => {});
      throw normalized(error);
    }
    let markerError = null;
    try {
      const { bytesWritten } = await markerHandle.write(markerBytes, 0, markerBytes.byteLength, 0);
      if (bytesWritten !== markerBytes.byteLength) throw failure("io-failure");
      await markerHandle.sync();
    } catch (error) {
      markerError = normalized(error);
    }
    await closeHandle(markerHandle, markerError);

    await verifyAbsent(path.join(output, MARKER));
    try {
      await fs.rename(stagedTarget, path.join(output, MARKER));
    } catch {
      throw failure("io-failure");
    }
    committed = true;
    return Object.freeze({ packetDigest: ownedPacketDigest });
  } catch (error) {
    const initiating = normalized(error);
    if (reserved && !committed) {
      try {
        await cleanup(output, directoryIdentity, created);
      } catch {
        throw failure("io-failure");
      }
    }
    throw initiating;
  }
}

export async function readValidatedEvidencePacket(output, binding) {
  try {
    await checkPath(output, true);
    const names = await boundedNames(output, 9);
    requireExactNames(names, [...FILES, MARKER]);

    const markerBytes = await readBoundedFile(path.join(output, MARKER), 65);
    let marker;
    try {
      marker = DECODER.decode(markerBytes);
    } catch {
      throw failure("noncanonical-bytes");
    }
    if (!/^[0-9a-f]{64}\n$/.test(marker)) throw failure("noncanonical-bytes");

    const files = await readPacketFiles(output);
    const packet = validateEvidencePacket(files, binding);
    if (packet.packetDigest !== marker.slice(0, -1)) throw failure("invalid-payload");
    return packet;
  } catch (error) {
    throw normalized(error);
  }
}
