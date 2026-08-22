import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";
import { parsePackageManifest } from "./package-manifest.mjs";

const INPUT_KEYS = Object.freeze(["repository", "eventName", "eventSha", "runId", "runAttempt"]);
const RECORD_KEYS = Object.freeze(["schemaVersion", "repository", "eventName", "eventSha", "runId", "runAttempt", "manifestSha256"]);
const REPOSITORY = "FelixGeisler/code-city";
const EVENT_NAME = "push";
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function invariant(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function sameKeys(actual, expected) {
  return actual.length === expected.length
    && actual.every((key, index) => typeof key === "string" && key === expected[index]);
}

function assertExactDataObject(value, expectedKeys, label) {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  invariant(!utilTypes.isProxy(value), `${label} must not be a proxy`);
  invariant(Object.getPrototypeOf(value) === Object.prototype, `${label} must be a plain object`);
  invariant(sameKeys(Reflect.ownKeys(value), expectedKeys), `${label} has unexpected or reordered fields`);
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    invariant(descriptor && Object.hasOwn(descriptor, "value") && descriptor.enumerable, `${label}.${key} must be an enumerable own data property`);
  }
}

function assertWholeUint8Array(bytes, label) {
  invariant(bytes instanceof Uint8Array && !Buffer.isBuffer(bytes), `${label} must be a Uint8Array`);
  invariant(!utilTypes.isProxy(bytes), `${label} must not be a proxy`);
  invariant(Object.getPrototypeOf(bytes) === Uint8Array.prototype, `${label} must be a plain Uint8Array`);
  invariant(bytes.buffer instanceof ArrayBuffer, `${label} must use an ArrayBuffer`);
  invariant(bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength, `${label} must cover its whole backing buffer`);
}

function bytesEqual(left, right) {
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertEventSha(eventSha, label) {
  invariant(typeof eventSha === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(eventSha), `${label} has an invalid event SHA`);
}

function assertPositiveSafeInteger(value, label) {
  invariant(Number.isSafeInteger(value) && value > 0, `${label} must be a positive safe integer`);
}

function validateInput(input) {
  assertExactDataObject(input, INPUT_KEYS, "Publication input");
  invariant(input.repository === REPOSITORY, `Publication repository must be ${REPOSITORY}`);
  invariant(input.eventName === EVENT_NAME, `Publication event must be ${EVENT_NAME}`);
  assertEventSha(input.eventSha, "Publication input");
  assertPositiveSafeInteger(input.runId, "Publication run ID");
  assertPositiveSafeInteger(input.runAttempt, "Publication run attempt");
}

function validateRecord(record, manifestSha256) {
  assertExactDataObject(record, RECORD_KEYS, "Publication record");
  invariant(record.schemaVersion === 1, "Unsupported publication record schema");
  invariant(record.repository === REPOSITORY, `Publication repository must be ${REPOSITORY}`);
  invariant(record.eventName === EVENT_NAME, `Publication event must be ${EVENT_NAME}`);
  assertEventSha(record.eventSha, "Publication record");
  assertPositiveSafeInteger(record.runId, "Publication run ID");
  assertPositiveSafeInteger(record.runAttempt, "Publication run attempt");
  invariant(typeof record.manifestSha256 === "string" && /^[0-9a-f]{64}$/u.test(record.manifestSha256), "Publication record has an invalid manifest SHA-256");
  invariant(record.manifestSha256 === manifestSha256, "Publication record does not match the package manifest");
}

function serializeRecord(record) {
  return encoder.encode(`${JSON.stringify(record)}\n`);
}

export function createPublicationRecord(input, manifestBytes) {
  validateInput(input);
  parsePackageManifest(manifestBytes);
  const record = {
    schemaVersion: 1,
    repository: input.repository,
    eventName: input.eventName,
    eventSha: input.eventSha,
    runId: input.runId,
    runAttempt: input.runAttempt,
    manifestSha256: digest(manifestBytes),
  };
  return serializeRecord(record);
}

export function validatePublicationRecord(bytes, manifestBytes) {
  parsePackageManifest(manifestBytes);
  assertWholeUint8Array(bytes, "Publication record bytes");
  let record;
  try {
    record = JSON.parse(decoder.decode(bytes));
  } catch (error) {
    throw new Error(`Publication record bytes are not valid UTF-8 JSON: ${error.message}`);
  }
  validateRecord(record, digest(manifestBytes));
  invariant(bytesEqual(bytes, serializeRecord(record)), "Publication record bytes are not canonical");
  return Object.freeze(record);
}
