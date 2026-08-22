import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { serializePackageManifest } from "../tools/package-manifest.mjs";
import { createPublicationRecord, validatePublicationRecord } from "../tools/publication-record.mjs";

const CSP = "default-src 'none'; base-uri 'none'; connect-src 'self' https://api.github.com https://raw.githubusercontent.com; form-action 'none'; frame-src 'none'; object-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; worker-src 'self'";
const encoder = new TextEncoder();

function manifestObject({ fileDigest = "0".repeat(64) } = {}) {
  return {
    schemaVersion: 2,
    basePath: "/code-city/",
    policy: {
      contentSecurityPolicy: CSP,
      referrerPolicy: "no-referrer",
      connectOrigins: ["'self'", "https://api.github.com", "https://raw.githubusercontent.com"],
    },
    files: [
      { path: "index.html", mediaType: "text/html", byteLength: 0, sha256: fileDigest },
    ],
  };
}

function canonicalInput({ eventSha = "a".repeat(40), runId = 123, runAttempt = 2 } = {}) {
  return {
    repository: "FelixGeisler/code-city",
    eventName: "push",
    eventSha,
    runId,
    runAttempt,
  };
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function bytes(text) {
  return encoder.encode(text);
}

function recordBytes(record) {
  return bytes(`${JSON.stringify(record)}\n`);
}

function parsedRecord(publicationBytes) {
  return JSON.parse(new TextDecoder().decode(publicationBytes));
}

function expectInvalidRecord(candidate, manifestBytes, pattern = /./u) {
  const candidateBefore = Uint8Array.from(candidate);
  const manifestBefore = Uint8Array.from(manifestBytes);
  assert.throws(() => validatePublicationRecord(candidate, manifestBytes), pattern);
  assert.deepEqual(Uint8Array.from(candidate), candidateBefore);
  assert.deepEqual(manifestBytes, manifestBefore);
}

test("publication module exposes only canonical create and byte-validation APIs", async () => {
  const module = await import("../tools/publication-record.mjs");
  assert.deepEqual(Object.keys(module), ["createPublicationRecord", "validatePublicationRecord"]);
});

test("creation derives ordered schema and manifest identity deterministically without aliasing or mutation", () => {
  const manifestBytes = serializePackageManifest(manifestObject());
  const input = canonicalInput();
  const inputBefore = structuredClone(input);
  const manifestBefore = Uint8Array.from(manifestBytes);
  const first = createPublicationRecord(input, manifestBytes);
  const second = createPublicationRecord(input, manifestBytes);
  const expectedRecord = {
    schemaVersion: 1,
    repository: "FelixGeisler/code-city",
    eventName: "push",
    eventSha: "a".repeat(40),
    runId: 123,
    runAttempt: 2,
    manifestSha256: digest(manifestBytes),
  };

  assert(first instanceof Uint8Array);
  assert.equal(Buffer.isBuffer(first), false);
  assert.equal(first.byteOffset, 0);
  assert.equal(first.byteLength, first.buffer.byteLength);
  assert.deepEqual(first, recordBytes(expectedRecord));
  assert.deepEqual(second, first);
  assert.notEqual(second, first);
  assert.deepEqual(Object.keys(parsedRecord(second)), ["schemaVersion", "repository", "eventName", "eventSha", "runId", "runAttempt", "manifestSha256"]);
  first[0] = 0;
  assert.deepEqual(second, recordBytes(expectedRecord));
  assert.deepEqual(input, inputBefore);
  assert.deepEqual(manifestBytes, manifestBefore);

  const validated = validatePublicationRecord(second, manifestBytes);
  assert.deepEqual(validated, expectedRecord);
  assert.notEqual(validated, expectedRecord);
  assert.equal(Object.isFrozen(validated), true);
  assert.throws(() => { validated.runId = 4; }, TypeError);
});

test("40/64-hex event SHAs and positive-safe-integer boundaries are exact", () => {
  const manifestBytes = serializePackageManifest(manifestObject());
  for (const eventSha of ["0".repeat(40), "f".repeat(40), "0".repeat(64), "f".repeat(64)]) {
    for (const boundary of [1, Number.MAX_SAFE_INTEGER]) {
      const input = canonicalInput({ eventSha, runId: boundary, runAttempt: boundary });
      const record = validatePublicationRecord(createPublicationRecord(input, manifestBytes), manifestBytes);
      assert.equal(record.eventSha, eventSha);
      assert.equal(record.runId, boundary);
      assert.equal(record.runAttempt, boundary);
    }
  }
});

test("publication input rejects every field, type, shape, order, and runtime-property mutation", () => {
  const manifestBytes = serializePackageManifest(manifestObject());
  const cases = [];
  const add = (label, mutate) => {
    const input = canonicalInput();
    mutate(input);
    cases.push([label, input]);
  };
  add("repository value", (value) => { value.repository = "Other/code-city"; });
  add("repository type", (value) => { value.repository = null; });
  add("event value", (value) => { value.eventName = "pull_request"; });
  add("event type", (value) => { value.eventName = 1; });
  for (const eventSha of ["a".repeat(39), "a".repeat(41), "a".repeat(63), "a".repeat(65), "A".repeat(40), "g".repeat(40), 1, null]) {
    add(`event SHA ${String(eventSha)}`, (value) => { value.eventSha = eventSha; });
  }
  for (const field of ["runId", "runAttempt"]) {
    for (const invalid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1", null]) {
      add(`${field} ${String(invalid)}`, (value) => { value[field] = invalid; });
    }
  }
  add("missing", (value) => { delete value.runAttempt; });
  add("extra", (value) => { value.manifestSha256 = "0".repeat(64); });
  cases.push(["reordered", { eventName: "push", repository: "FelixGeisler/code-city", eventSha: "a".repeat(40), runId: 123, runAttempt: 2 }]);

  for (const [label, input] of cases) {
    const before = structuredClone(input);
    assert.throws(() => createPublicationRecord(input, manifestBytes), undefined, label);
    assert.deepEqual(input, before, label);
  }

  const inherited = Object.assign(Object.create(canonicalInput()), canonicalInput());
  assert.throws(() => createPublicationRecord(inherited, manifestBytes), /plain object/u);
  const accessor = canonicalInput();
  Object.defineProperty(accessor, "runId", { enumerable: true, get: () => 123 });
  assert.throws(() => createPublicationRecord(accessor, manifestBytes), /data property/u);
  const symbol = canonicalInput();
  symbol[Symbol("extra")] = true;
  assert.throws(() => createPublicationRecord(symbol, manifestBytes), /fields/u);
  assert.throws(() => createPublicationRecord(new Proxy(canonicalInput(), {}), manifestBytes), /proxy/u);
});

test("both publication APIs require canonical whole-view manifest bytes", () => {
  const manifestBytes = serializePackageManifest(manifestObject());
  const input = canonicalInput();
  const publicationBytes = createPublicationRecord(input, manifestBytes);
  const noncanonicalManifest = bytes(`${JSON.stringify(manifestObject(), null, 2)}\n`);
  const padded = new Uint8Array(manifestBytes.byteLength + 2);
  padded.set(manifestBytes, 1);
  const partial = padded.subarray(1, -1);

  for (const invalidManifest of [Buffer.from(manifestBytes), partial, noncanonicalManifest]) {
    const before = Uint8Array.from(invalidManifest);
    assert.throws(() => createPublicationRecord(input, invalidManifest));
    assert.deepEqual(Uint8Array.from(invalidManifest), before);
    assert.throws(() => validatePublicationRecord(publicationBytes, invalidManifest));
    assert.deepEqual(Uint8Array.from(invalidManifest), before);
  }
});

test("publication byte validation rejects whole-view violations and noncanonical representations", () => {
  const manifestBytes = serializePackageManifest(manifestObject());
  const canonical = createPublicationRecord(canonicalInput(), manifestBytes);
  expectInvalidRecord(Buffer.from(canonical), manifestBytes, /Uint8Array/u);
  const padded = new Uint8Array(canonical.byteLength + 2);
  padded.set(canonical, 1);
  expectInvalidRecord(padded.subarray(1, -1), manifestBytes, /whole backing buffer/u);
  const partial = new Uint8Array(canonical.buffer, 0, canonical.byteLength - 1);
  expectInvalidRecord(partial, manifestBytes, /whole backing buffer/u);
  assert.throws(() => validatePublicationRecord(new Proxy(canonical, {}), manifestBytes), /proxy|Uint8Array/u);

  const text = new TextDecoder().decode(canonical);
  for (const representation of [
    Uint8Array.from([0xc3, 0x28]),
    bytes("{bad-json}\n"),
    Uint8Array.from([0xef, 0xbb, 0xbf, ...canonical]),
    bytes(text.replace(/\n$/u, "\r\n")),
    bytes(text.slice(0, -1)),
    bytes(`${text}\n`),
    bytes(`${JSON.stringify(parsedRecord(canonical), null, 2)}\n`),
    bytes(text.replace("FelixGeisler/code-city", "FelixGeisler\\/code-city")),
    bytes(text.replace('{"schemaVersion":1,"repository"', '{"repository":"FelixGeisler/code-city","schemaVersion":1,"discarded"').replace('"FelixGeisler/code-city":"FelixGeisler/code-city",', "")),
    bytes(text.replace('{"schemaVersion":1', '{"schemaVersion":1,"schemaVersion":1')),
    bytes(`${text}null`),
  ]) {
    expectInvalidRecord(representation, manifestBytes);
  }
});

test("record validation rejects each byte-representable field, type, shape, and digest mutation", () => {
  const manifestBytes = serializePackageManifest(manifestObject());
  const canonical = parsedRecord(createPublicationRecord(canonicalInput(), manifestBytes));
  const cases = [];
  const add = (label, mutate) => {
    const record = structuredClone(canonical);
    mutate(record);
    cases.push([label, recordBytes(record)]);
  };
  add("schema value", (value) => { value.schemaVersion = 2; });
  add("schema type", (value) => { value.schemaVersion = "1"; });
  add("repository value", (value) => { value.repository = "Other/code-city"; });
  add("repository type", (value) => { value.repository = null; });
  add("event value", (value) => { value.eventName = "workflow_dispatch"; });
  add("event type", (value) => { value.eventName = 1; });
  for (const eventSha of ["a".repeat(39), "a".repeat(41), "a".repeat(63), "a".repeat(65), "A".repeat(40), 1, null]) {
    add(`event SHA ${String(eventSha)}`, (value) => { value.eventSha = eventSha; });
  }
  for (const field of ["runId", "runAttempt"]) {
    for (const invalid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1", null]) {
      add(`${field} ${String(invalid)}`, (value) => { value[field] = invalid; });
    }
  }
  for (const invalid of ["1".repeat(64), "F".repeat(64), "0".repeat(63), "g".repeat(64), 0, null]) {
    add(`manifest digest ${String(invalid)}`, (value) => { value.manifestSha256 = invalid; });
  }
  add("missing", (value) => { delete value.eventName; });
  add("extra", (value) => { value.extra = true; });
  const reordered = {
    repository: canonical.repository,
    schemaVersion: canonical.schemaVersion,
    eventName: canonical.eventName,
    eventSha: canonical.eventSha,
    runId: canonical.runId,
    runAttempt: canonical.runAttempt,
    manifestSha256: canonical.manifestSha256,
  };
  cases.push(["reordered", recordBytes(reordered)]);

  for (const [label, candidate] of cases) {
    const before = Uint8Array.from(candidate);
    assert.throws(() => validatePublicationRecord(candidate, manifestBytes), undefined, label);
    assert.deepEqual(candidate, before, label);
  }
});

test("manifest binding changes deterministically and rejects a record bound to other canonical bytes", () => {
  const firstManifest = serializePackageManifest(manifestObject({ fileDigest: "0".repeat(64) }));
  const secondManifest = serializePackageManifest(manifestObject({ fileDigest: "1".repeat(64) }));
  const input = canonicalInput({ eventSha: "b".repeat(64), runId: 1, runAttempt: 1 });
  const firstRecordBytes = createPublicationRecord(input, firstManifest);
  const secondRecordBytes = createPublicationRecord(input, secondManifest);
  const firstRecord = parsedRecord(firstRecordBytes);
  const secondRecord = parsedRecord(secondRecordBytes);
  assert.notEqual(firstRecord.manifestSha256, secondRecord.manifestSha256);
  assert.notDeepEqual(firstRecordBytes, secondRecordBytes);
  assert.equal(firstRecord.manifestSha256, digest(firstManifest));
  assert.equal(secondRecord.manifestSha256, digest(secondManifest));
  expectInvalidRecord(firstRecordBytes, secondManifest, /does not match/u);
});
