import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";
import { parseStandaloneManifest } from "./standalone-manifest.mjs";

const INPUT_KEYS = Object.freeze(["repository", "eventName", "eventSha", "runId", "runAttempt"]);
const RECORD_KEYS = Object.freeze(["schemaVersion", "repository", "eventName", "eventSha", "runId", "runAttempt", "manifestSha256"]);
const REPOSITORY = "FelixGeisler/code-city";
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function exactObject(value, keys, label) {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  invariant(!utilTypes.isProxy(value) && Object.getPrototypeOf(value) === Object.prototype, `${label} must be plain`);
  invariant(Reflect.ownKeys(value).length === keys.length && keys.every((key, index) => Reflect.ownKeys(value)[index] === key), `${label} keys differ`);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    invariant(descriptor?.enumerable === true && Object.hasOwn(descriptor, "value"), `${label}.${key} must be own data`);
  }
}

function input(value) {
  exactObject(value, INPUT_KEYS, "Standalone publication input");
  invariant(value.repository === REPOSITORY && value.eventName === "push", "Standalone publication identity differs");
  invariant(/^[0-9a-f]{40}$/u.test(value.eventSha), "Standalone publication SHA differs");
  invariant(Number.isSafeInteger(value.runId) && value.runId > 0, "Standalone publication run ID differs");
  invariant(Number.isSafeInteger(value.runAttempt) && value.runAttempt > 0, "Standalone publication run attempt differs");
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function serialize(record) {
  return encoder.encode(`${JSON.stringify(record)}\n`);
}

export function createStandalonePublicationRecord(value, manifestBytes) {
  input(value);
  parseStandaloneManifest(manifestBytes);
  return serialize({
    schemaVersion: 1,
    repository: value.repository,
    eventName: value.eventName,
    eventSha: value.eventSha,
    runId: value.runId,
    runAttempt: value.runAttempt,
    manifestSha256: digest(manifestBytes),
  });
}

export function validateStandalonePublicationRecord(bytes, manifestBytes) {
  parseStandaloneManifest(manifestBytes);
  invariant(bytes instanceof Uint8Array && !Buffer.isBuffer(bytes) && !utilTypes.isProxy(bytes), "Standalone publication record must be plain bytes");
  invariant(Object.getPrototypeOf(bytes) === Uint8Array.prototype && bytes.buffer instanceof ArrayBuffer, "Standalone publication record must use plain storage");
  invariant(bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength, "Standalone publication record must cover its whole buffer");
  let record;
  try { record = JSON.parse(decoder.decode(bytes)); }
  catch { throw new Error("Standalone publication record is not canonical UTF-8 JSON"); }
  exactObject(record, RECORD_KEYS, "Standalone publication record");
  input({ repository: record.repository, eventName: record.eventName, eventSha: record.eventSha, runId: record.runId, runAttempt: record.runAttempt });
  invariant(record.schemaVersion === 1, "Standalone publication record version differs");
  invariant(record.manifestSha256 === digest(manifestBytes), "Standalone publication manifest binding differs");
  invariant(Buffer.from(bytes).equals(Buffer.from(serialize(record))), "Standalone publication record is not canonical");
  return Object.freeze(record);
}
