import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(/^\.\.?\//u.test(specifier) && !/(?:\.[a-z]+|\?.*)$/iu.test(specifier) ? `${specifier}.ts` : specifier, context);
  },
});

const { buildCity } = await import("../src/domain/city-model.ts");
const { createFixedTransferNormalizedUtf8 } = await import("../src/application/internal/source-byte-ownership.ts");
const {
  MAX_ADMITTED_MODULES, MAX_NORMALIZED_MODULE_BYTES, MAX_NORMALIZED_TOTAL_BYTES,
} = await import("../src/domain/source-admission.ts");
const {
  parseNodeWorkerCommand, prepareNodeWorkerSuccessForPublication, successTransferList, validSuccessTransferList,
  validateNodeWorkerEvent, validateNodeWorkerEventForPublication, validateNodeWorkerStructuredCloneEvent,
} = await import("../src/edge/node/worker-protocol.ts");
const { publishNodeWorkerEvent } = await import("../src/edge/node/analysis-worker.ts");

const ATTEMPT = Buffer.alloc(16).toString("base64url");
const SHA = "a".repeat(40);
const REPOSITORY = { owner: "owner", repository: "repo", branch: null };
const encoder = new TextEncoder();

function fixedTransferBytes(source) {
  return createFixedTransferNormalizedUtf8(source);
}

function receive(value) {
  return structuredClone(value);
}

function success(overrides = {}) {
  return {
    type: "SUCCESS", attemptId: ATTEMPT, generation: 7, revision: SHA,
    result: { city: buildCity([{ canonicalPath: "a.ts", S: 1, U: 0, M: 0 }]), notAnalyzedFiles: [] },
    sources: [{ canonicalPath: "a.ts", normalizedUtf8: fixedTransferBytes("const a = 1;\n") }],
    ...overrides,
  };
}

function failedSourceEnvelope(byteLengths) {
  const paths = byteLengths.map((_, index) => `file-${String(index).padStart(4, "0")}.ts`);
  return success({
    result: {
      city: null,
      notAnalyzedFiles: paths.map((canonicalPath) => ({ canonicalPath, category: "Syntax could not be analyzed" })),
    },
    sources: paths.map((canonicalPath, index) => ({
      canonicalPath,
      normalizedUtf8: fixedTransferBytes("x".repeat(byteLengths[index])),
    })),
  });
}

function assertSenderAndReceiverAccept(event, label) {
  const prepared = prepareNodeWorkerSuccessForPublication(event);
  let received;
  publishNodeWorkerEvent({
    postMessage(message, transfer) { received = structuredClone(message, { transfer }); },
  }, prepared);
  assert.equal(received.type, "SUCCESS", `${label}: sender`);
  assert.equal(validateNodeWorkerStructuredCloneEvent(received).kind, "valid", `${label}: receiver`);
}

function assertSenderAndReceiverReject(event, label) {
  const prepared = prepareNodeWorkerSuccessForPublication(event);
  let posted;
  publishNodeWorkerEvent({ postMessage(message) { posted = message; } }, prepared);
  assert.equal(posted.type, "FAILURE", `${label}: sender`);
  assert.equal(validateNodeWorkerStructuredCloneEvent(receive(prepared)).kind, "invalid", `${label}: receiver`);
}

function inherited(value) { return Object.assign(Object.create(value), value); }
function accessor(value, key) {
  const copy = { ...value };
  Object.defineProperty(copy, key, { enumerable: true, get: () => value[key] });
  return copy;
}

function assertProviderInvalid(value) {
  assert.deepEqual(validateNodeWorkerEvent(value).kind, "invalid");
}

test("Node commands require exact attempt, generation, repository, and canonical exclusion records", () => {
  const start = { type: "START", attemptId: ATTEMPT, generation: 1, repository: REPOSITORY, additionalExclusions: ["a", "z"] };
  const stop = { type: "STOP", attemptId: ATTEMPT, generation: 1 };
  assert.deepEqual(parseNodeWorkerCommand(start), start);
  assert.deepEqual(parseNodeWorkerCommand(stop), stop);
  const sparse = new Array(1);
  const extra = ["a"]; extra.extra = true;
  for (const invalid of [
    { ...start, attemptId: ATTEMPT.slice(1) }, { ...start, generation: 0 }, { ...start, extra: true },
    { ...start, repository: { owner: "owner", repository: "repo" } },
    { ...start, repository: inherited(REPOSITORY) }, { ...start, additionalExclusions: sparse },
    { ...start, additionalExclusions: extra }, { ...start, additionalExclusions: ["z", "a"] },
    inherited(start), accessor(start, "attemptId"), { ...stop, repository: REPOSITORY },
    new Proxy(start, { ownKeys() { throw new Error("trap"); } }),
  ]) assert.equal(parseNodeWorkerCommand(invalid), undefined);
});

test("every Node event variant is exact and failure code/category cross-products remain closed", () => {
  const rows = [
    { type: "REVISION_SELECTED", attemptId: ATTEMPT, generation: 7, revision: SHA },
    { type: "FAILURE", attemptId: ATTEMPT, generation: 7, category: "Repository unavailable for anonymous access" },
    { type: "FAILURE", attemptId: ATTEMPT, generation: 7, category: "Revision unavailable" },
    { type: "FAILURE", attemptId: ATTEMPT, generation: 7, category: "Provider/resolution failure" },
    { type: "FAILURE", attemptId: ATTEMPT, generation: 7, revision: SHA, category: "Provider/resolution failure" },
    { type: "FAILURE", attemptId: ATTEMPT, generation: 7, revision: SHA, category: "Repository exceeds Code City limits" },
    { type: "FAILURE", attemptId: ATTEMPT, generation: 7, revision: SHA, category: "No supported modules", code: "ADM-06" },
    { type: "FAILURE", attemptId: ATTEMPT, generation: 7, revision: SHA, category: "No supported modules", code: "ADM-07" },
    { type: "FAILURE", attemptId: ATTEMPT, generation: 7, revision: SHA, category: "Source admission failed", code: "M1-ADM-1" },
    { type: "FAILURE", attemptId: ATTEMPT, generation: 7, revision: SHA, category: "Source admission failed", code: "M1-ADM-3" },
    { type: "FAILURE", attemptId: ATTEMPT, generation: 7, revision: SHA, category: "Source admission failed", code: "M1-ADM-4" },
    { type: "FAILURE", attemptId: ATTEMPT, generation: 7, revision: SHA, category: "Metric processing failed", code: "M1-MET-1" },
    { type: "FAILURE", attemptId: ATTEMPT, generation: 7, revision: SHA, category: "City construction failed", code: "M1-CITY-1" },
  ];
  for (const row of rows) assert.equal(validateNodeWorkerEvent(row).kind, "valid", JSON.stringify(row));
  for (const invalid of [
    { ...rows[0], revision: SHA.toUpperCase() }, { ...rows[1], revision: SHA }, { ...rows[4], code: "M1-CITY-1" },
    { ...rows[6], code: "M1-ADM-1" }, { ...rows[11], code: "M1-CITY-1" }, { ...rows[12], code: "M1-MET-1" },
    { ...rows[0], extra: true }, inherited(rows[0]), accessor(rows[12], "code"),
  ]) assertProviderInvalid(invalid);
});

test("progress records use exact source-free stage and bounded count schemas", () => {
  const identity = { type: "PROGRESS", attemptId: ATTEMPT, generation: 7, revision: SHA };
  const valid = [
    { ...identity, stage: "acquisition", completed: 0, total: 1 },
    { ...identity, stage: "acquisition", completed: 4_000, total: 4_000 },
    { ...identity, stage: "analysis-initialization" },
    { ...identity, stage: "analysis", completed: 0, total: 4_000 },
    { ...identity, stage: "analysis", completed: 4_000, total: 4_000 },
    { ...identity, stage: "city-construction" },
  ];
  for (const event of valid) {
    assert.equal(validateNodeWorkerEvent(event).kind, "valid", JSON.stringify(event));
    let posted;
    publishNodeWorkerEvent({ postMessage(value) { posted = value; } }, event);
    assert.deepEqual(posted, event);
    assert.equal(JSON.stringify(event).includes("source"), false);
    assert.equal(JSON.stringify(event).includes("path"), false);
  }

  const counted = valid[0];
  for (const invalid of [
    { ...counted, completed: -1 }, { ...counted, completed: 1.5 }, { ...counted, completed: Number.MAX_SAFE_INTEGER + 1 },
    { ...counted, total: 0 }, { ...counted, total: -1 }, { ...counted, total: 4_001 },
    { ...counted, completed: 2, total: 1 }, { ...counted, extra: true }, inherited(counted),
    accessor(counted, "completed"), { ...identity, stage: "analysis-initialization", completed: 0, total: 1 },
    { ...identity, stage: "unknown" }, { ...identity, revision: SHA.toUpperCase(), stage: "city-construction" },
  ]) assertProviderInvalid(invalid);
  const symbol = { ...counted };
  symbol[Symbol("extra")] = true;
  assertProviderInvalid(symbol);
});

test("success validation enforces city, failure, path-union, source bytes, order, and size contracts", () => {
  assert.equal(validateNodeWorkerStructuredCloneEvent(receive(success())).kind, "valid");
  const mixed = success({
    result: {
      city: buildCity([{ canonicalPath: "a.ts", S: 1, U: 0, M: 0 }]),
      notAnalyzedFiles: [
        { canonicalPath: "b.ts", category: "Source text is not supported" },
        { canonicalPath: "c.ts", category: "Syntax could not be analyzed" },
      ],
    },
    sources: [
      { canonicalPath: "a.ts", normalizedUtf8: encoder.encode("a") },
      { canonicalPath: "c.ts", normalizedUtf8: encoder.encode("c") },
    ],
  });
  assert.equal(validateNodeWorkerStructuredCloneEvent(receive(mixed)).kind, "valid");
  assert.equal(validateNodeWorkerStructuredCloneEvent(receive({ ...mixed, result: { city: null, notAnalyzedFiles: mixed.result.notAnalyzedFiles } })).kind, "invalid");
  const allFailed = success({
    result: { city: null, notAnalyzedFiles: [{ canonicalPath: "a.ts", category: "Syntax could not be analyzed" }] },
    sources: [{ canonicalPath: "a.ts", normalizedUtf8: encoder.encode("a") }],
  });
  assert.equal(validateNodeWorkerStructuredCloneEvent(receive(allFailed)).kind, "valid");

  const badUtf8 = new Uint8Array([0xff]);
  const partialBacking = new Uint8Array([1, 2]);
  const partial = partialBacking.subarray(1);
  const reused = encoder.encode("x");
  const subclass = new (class extends Uint8Array {})(encoder.encode("x"));
  const detached = encoder.encode("x"); structuredClone(detached.buffer, { transfer: [detached.buffer] });
  const buffer = Buffer.from("x");
  const accessorRow = { canonicalPath: "a.ts", normalizedUtf8: encoder.encode("x") };
  Object.defineProperty(accessorRow, "canonicalPath", { enumerable: true, get: () => "a.ts" });
  const candidates = [badUtf8, partial, subclass, detached, buffer, new Proxy(encoder.encode("x"), {})];
  if (typeof SharedArrayBuffer === "function") candidates.push(new Uint8Array(new SharedArrayBuffer(1)));
  if (ArrayBuffer.prototype.resize) candidates.push(new Uint8Array(new ArrayBuffer(1, { maxByteLength: 2 })));
  for (const normalizedUtf8 of candidates) assertProviderInvalid(success({ sources: [{ canonicalPath: "a.ts", normalizedUtf8 }] }));
  assertProviderInvalid(success({ sources: [accessorRow] }));
  assertProviderInvalid(success({ sources: [{ canonicalPath: "a.ts", normalizedUtf8: encoder.encode("x\r\n") }] }));
  assertProviderInvalid(success({ sources: [{ canonicalPath: "a.ts", normalizedUtf8: encoder.encode("\uFEFFx") }] }));
  assertProviderInvalid(success({ sources: [{ canonicalPath: "a.ts", normalizedUtf8: encoder.encode("x\0") }] }));
  assertProviderInvalid(success({ sources: [{ canonicalPath: "b.ts", normalizedUtf8: encoder.encode("x") }] }));
  assertProviderInvalid(success({ sources: [
    { canonicalPath: "a.ts", normalizedUtf8: reused }, { canonicalPath: "b.ts", normalizedUtf8: new Uint8Array(reused.buffer) },
  ] }));
  const invalidCity = success(); invalidCity.result.city.geometry.sizes[0] = 999;
  assert.equal(validateNodeWorkerStructuredCloneEvent(receive(invalidCity)).mapping, "city");
});

test("source envelopes enforce exact count and byte boundaries for sender and receiver without a memory promise", () => {
  assertSenderAndReceiverAccept(failedSourceEnvelope(Array(MAX_ADMITTED_MODULES).fill(0)), "maximum source count");
  assertSenderAndReceiverReject(failedSourceEnvelope(Array(MAX_ADMITTED_MODULES + 1).fill(0)), "source count overflow");

  assertSenderAndReceiverAccept(failedSourceEnvelope([MAX_NORMALIZED_MODULE_BYTES]), "maximum row bytes");
  assertSenderAndReceiverReject(failedSourceEnvelope([MAX_NORMALIZED_MODULE_BYTES + 1]), "row byte overflow");

  const fullRows = MAX_NORMALIZED_TOTAL_BYTES / MAX_NORMALIZED_MODULE_BYTES;
  assert.equal(Number.isInteger(fullRows), true);
  assertSenderAndReceiverAccept(
    failedSourceEnvelope(Array(fullRows).fill(MAX_NORMALIZED_MODULE_BYTES)),
    "maximum total bytes",
  );
  assertSenderAndReceiverReject(
    failedSourceEnvelope([...Array(fullRows).fill(MAX_NORMALIZED_MODULE_BYTES), 1]),
    "total byte overflow",
  );
});

test("source association rejects order, duplicate, missing, and extra rows at sender and receiver", () => {
  const base = success({
    result: {
      city: buildCity([{ canonicalPath: "a.ts", S: 1, U: 0, M: 0 }]),
      notAnalyzedFiles: [
        { canonicalPath: "b.ts", category: "Source text is not supported" },
        { canonicalPath: "c.ts", category: "Syntax could not be analyzed" },
      ],
    },
    sources: [
      { canonicalPath: "a.ts", normalizedUtf8: fixedTransferBytes("a") },
      { canonicalPath: "c.ts", normalizedUtf8: fixedTransferBytes("c") },
    ],
  });
  assertSenderAndReceiverReject(success({ ...base, sources: [...base.sources].reverse() }), "out-of-order sources");
  assertSenderAndReceiverReject(success({ ...base, sources: [base.sources[0], {
    canonicalPath: "a.ts", normalizedUtf8: fixedTransferBytes("duplicate"),
  }] }), "duplicate source path");
  assertSenderAndReceiverReject(success({ ...base, sources: [base.sources[0]] }), "missing source path");
  assertSenderAndReceiverReject(success({ ...base, sources: [
    base.sources[0], { canonicalPath: "b.ts", normalizedUtf8: fixedTransferBytes("extra") }, base.sources[1],
  ] }), "extra text-failed source path");
  assertSenderAndReceiverAccept(base, "exact source union");
});

test("sender validation rejects normalized-away mutations and transfers every city/source buffer once", () => {
  const event = prepareNodeWorkerSuccessForPublication(success());
  const expected = successTransferList(event);
  assert.equal(expected.length, 5);
  assert.equal(validSuccessTransferList(event, expected), true);
  assert.equal(validSuccessTransferList(event, expected.slice(1)), false);
  assert.equal(validSuccessTransferList(event, [...expected, expected[0]]), false);

  let clone;
  publishNodeWorkerEvent({ postMessage(message, transfer) { clone = structuredClone(message, { transfer }); } }, event);
  assert.equal(event.result.city.geometry.origins.byteLength, 0);
  assert.equal(event.sources[0].normalizedUtf8.byteLength, 0);
  assert.equal(validateNodeWorkerStructuredCloneEvent(clone).kind, "valid");

  for (const source of [Buffer.from("x"), new (class extends Uint8Array {})([120])]) {
    let posted;
    publishNodeWorkerEvent({ postMessage(message) { posted = message; } }, success({ sources: [{ canonicalPath: "a.ts", normalizedUtf8: source }] }));
    assert.equal(posted.type, "FAILURE");
    assert.equal(posted.category, "Provider/resolution failure");
  }

  const firstSourceMutation = success({
    result: {
      city: buildCity([
        { canonicalPath: "a.ts", S: 1, U: 0, M: 0 },
        { canonicalPath: "b.ts", S: 1, U: 0, M: 0 },
      ]),
      notAnalyzedFiles: [],
    },
    sources: [
      { canonicalPath: "a.ts", normalizedUtf8: fixedTransferBytes("a") },
      { canonicalPath: "b.ts", normalizedUtf8: fixedTransferBytes("b") },
    ],
  });
  firstSourceMutation.sources[0].normalizedUtf8[0] = 0;
  let posted;
  publishNodeWorkerEvent({ postMessage(message) { posted = message; } }, firstSourceMutation);
  assert.equal(posted.type, "FAILURE");
  assert.equal(posted.category, "Provider/resolution failure");
});

test("publication derives transfer membership from the same source validation snapshot", () => {
  const event = prepareNodeWorkerSuccessForPublication(success());
  const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
  const original = Object.getOwnPropertyDescriptor(typedArrayPrototype, "some");
  assert.ok(original && "value" in original);
  let validationPasses = 0;
  Object.defineProperty(typedArrayPrototype, "some", {
    ...original,
    value(...arguments_) {
      validationPasses += 1;
      return Reflect.apply(original.value, this, arguments_);
    },
  });
  try {
    publishNodeWorkerEvent({ postMessage(_message, transfer) { assert.equal(transfer.length, 5); } }, event);
    assert.equal(validationPasses, 1);
  } finally {
    Object.defineProperty(typedArrayPrototype, "some", original);
  }
});

test("publication preparation rejects own view properties and non-pristine byte identities", () => {
  const ownViewMutations = [];
  for (const descriptor of [
    { value: true, enumerable: true },
    { value: true, enumerable: false },
    { get: () => true, enumerable: true },
  ]) {
    const bytes = encoder.encode("x");
    Object.defineProperty(bytes, "extra", { configurable: true, ...descriptor });
    ownViewMutations.push(bytes);
  }
  const symbol = encoder.encode("x");
  symbol[Symbol("extra")] = true;
  ownViewMutations.push(symbol, Buffer.from("x"), new (class extends Uint8Array {})([120]), new Proxy(encoder.encode("x"), {}));

  for (const normalizedUtf8 of ownViewMutations) {
    const event = success({ sources: [{ canonicalPath: "a.ts", normalizedUtf8 }] });
    assert.throws(() => prepareNodeWorkerSuccessForPublication(event), /source bytes are invalid/u);
    assert.equal(validateNodeWorkerEvent(event).kind, "invalid");
  }

  const provenanceBypass = encoder.encode("x");
  Object.preventExtensions(provenanceBypass.buffer);
  Object.preventExtensions(provenanceBypass);
  assert.throws(() => prepareNodeWorkerSuccessForPublication(success({
    sources: [{ canonicalPath: "a.ts", normalizedUtf8: provenanceBypass }],
  })), /source bytes are invalid/u);

  const pristine = success();
  assert.equal(prepareNodeWorkerSuccessForPublication(pristine), pristine);
  assert.equal(validateNodeWorkerEventForPublication(pristine).validation.kind, "valid");
});

test("structured cloning can normalize sender identity and backing-buffer properties", () => {
  const normalizedSenders = [];
  const senderBuffer = Buffer.allocUnsafeSlow(1); senderBuffer[0] = 120;
  normalizedSenders.push(senderBuffer, new (class extends Uint8Array {})([120]));

  for (const key of ["extra", Symbol("extra"), "accessor"]) {
    const bytes = encoder.encode("x");
    Object.defineProperty(bytes.buffer, key, key === "accessor"
      ? { configurable: true, enumerable: true, get: () => true }
      : { configurable: true, enumerable: true, value: true });
    normalizedSenders.push(bytes);
  }

  for (const normalizedUtf8 of normalizedSenders) {
    const sender = success({ sources: [{ canonicalPath: "a.ts", normalizedUtf8 }] });
    assert.equal(validateNodeWorkerEventForPublication(sender).validation.kind, "invalid", "worker-side value is rejected");
    const clone = receive(sender);
    assert.equal(Object.getPrototypeOf(clone.sources[0].normalizedUtf8), Uint8Array.prototype);
    assert.equal(Reflect.ownKeys(clone.sources[0].normalizedUtf8.buffer).length, 0);
    assert.equal(validateNodeWorkerStructuredCloneEvent(clone).kind, "valid", "receiver can validate only the observable clone");
  }
});
