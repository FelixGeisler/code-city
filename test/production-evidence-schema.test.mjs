import assert from "node:assert/strict";
import test from "node:test";

import * as schema from "../tools/production-evidence-schema.mjs";

const {
  EvidenceContractError,
  createEvidencePacket,
  validateEvidencePacket,
  createExternalWrapper,
  validateExternalWrapper,
} = schema;

const PARENT = "f06369b3eef5e62631ee8f61ddfd7679b00a3d2139dd83a2f6472820e62864e6";
const EVENT = "a".repeat(40);
const ROOT = "b".repeat(40);
const REACT_EVENT = "c".repeat(40);
const REACT_ROOT = "d".repeat(40);
const DIGEST = "e".repeat(64);
const BINDING = { issueBodySha256: PARENT, eventSha: EVENT };
const CODE_CITY_REPO = "FelixGeisler/code-city";
const REACT_REPO = "facebook/react";
const encoder = new TextEncoder();

function envelope(kind, status, reason, data) {
  return { schemaVersion: 1, kind, status, reason, data };
}

function candidates() {
  let aggregate = 0;
  return Array.from({ length: 4001 }, (_, offset) => {
    aggregate += 1;
    return {
      index: offset + 1,
      path: `${String(offset + 1).padStart(4, "0")}.ts`,
      blobId: "f".repeat(40),
      normalizedBytes: 1,
      runningAggregate: aggregate,
      hashMatched: true,
      contentValid: true,
    };
  });
}

function revisionUrl(repository) {
  return `https://api.github.com/repos/${repository}/commits?per_page=1&page=1`;
}
function commitUrl(repository, revision) {
  return `https://api.github.com/repos/${repository}/git/commits/${revision}`;
}
function treeUrl(repository, root) {
  return `https://api.github.com/repos/${repository}/git/trees/${root}?recursive=1`;
}
function rawUrl(repository, revision, path) {
  return `https://raw.githubusercontent.com/${repository}/${revision}/${path}`;
}

function request(sequence, stage, requestedUrl, applicationCall, startedMs) {
  return {
    sequence,
    stage,
    method: "GET",
    requestedUrl,
    finalUrl: requestedUrl,
    applicationCall,
    status: 200,
    startedMs,
    endedMs: startedMs + 0.0001,
    headerNames: ["access-control-allow-origin"],
    corsAllowOrigin: "*",
    rateLimit: { limit: null, remaining: null, reset: null },
    authorizationAbsent: true,
    cookieAbsent: true,
    refererAbsent: true,
    redirected: false,
  };
}

function requestSequence(repository, revision, root, paths, applicationCall, start, step, firstSequence) {
  const routes = [
    ["revision", revisionUrl(repository)],
    ["commit", commitUrl(repository, revision)],
    ["tree", treeUrl(repository, root)],
    ...paths.map((path) => ["raw", rawUrl(repository, revision, path)]),
  ];
  return routes.map(([stage, url], index) => request(firstSequence + index, stage, url, applicationCall, start + index * step));
}

function passEvents() {
  const names = [
    ["collector-start", 0, 0], ["artifact-verified", 0, 1], ["smoke-start", 1, 2],
    ["revision-selected", 1, 3], ["city-published", 1, 4], ["trace-reset", 0, 5],
    ["qualification-start", 0, 6], ["qualification-complete", 0, 7], ["capacity-start", 2, 8],
    ["revision-selected", 2, 9], ["inventory-complete", 2, 10], ["limit-failure", 2, 20],
    ["request-quiescent", 2, 21], ["worker-quiescent", 2, 22], ["collector-complete", 0, 23],
  ];
  return names.map(([event, generation, atMs], index) => ({ sequence: index + 1, generation, event, atMs }));
}

function event(events, name, generation) {
  return events.find((value) => value.event === name && value.generation === generation);
}
function difference(events, endName, endGeneration, startName, startGeneration) {
  const end = event(events, endName, endGeneration);
  const start = event(events, startName, startGeneration);
  return end && start ? end.atMs - start.atMs : null;
}
function durations(events) {
  return {
    artifact: difference(events, "artifact-verified", 0, "collector-start", 0),
    smoke: difference(events, "trace-reset", 0, "smoke-start", 1),
    qualification: difference(events, "qualification-complete", 0, "qualification-start", 0),
    resolution: difference(events, "revision-selected", 2, "capacity-start", 2),
    inventory: difference(events, "inventory-complete", 2, "revision-selected", 2),
    retrieval: difference(events, "limit-failure", 2, "inventory-complete", 2),
    terminal: difference(events, "worker-quiescent", 2, "limit-failure", 2),
    capacity: difference(events, "worker-quiescent", 2, "capacity-start", 2),
    total: events.at(-1)?.atMs ?? null,
  };
}

function artifactData() {
  return {
    issueBodySha256: PARENT,
    eventSha: EVENT,
    repository: "FelixGeisler/code-city",
    runId: 123,
    runAttempt: 1,
    origin: "https://felixgeisler.github.io/code-city/",
    manifestSha256: DIGEST,
    publicationRecordSha256: "1".repeat(64),
    deploymentId: 456,
    deployedSha: EVENT,
    nodeVersion: "v24.19.0",
    chromeVersion: "140.0.1.2",
    chromeExecutableCategory: "windows-program-files",
    runnerOs: "Windows",
    runnerArch: "X64",
    policyMatched: true,
    files: [{
      path: "index.html",
      expectedMediaType: "text/html",
      observedMediaType: "Text/HTML; charset=utf-8",
      expectedBytes: 42,
      observedBytes: 42,
      expectedSha256: "2".repeat(64),
      observedSha256: "2".repeat(64),
      match: true,
    }],
  };
}

function lifecycleData(events = passEvents(), overrides = {}) {
  return {
    collectorVersion: 1,
    collectorCommit: EVENT,
    invocation: ["node", "tools/collect-production-evidence.mjs", "--origin", "$ORIGIN", "--manifest", "$MANIFEST", "--output", "$OUTPUT"],
    nodeVersion: "v24.19.0",
    chromeVersion: "140.0.1.2",
    cdpVersion: "1.3",
    events,
    durations: durations(events),
    maxOverlap: 1,
    noRetry: true,
    noFallback: true,
    noPersistence: true,
    noLaterPublication: true,
    ...overrides,
  };
}

function makePassingPayloads(smokePaths = ["src/main.ts"]) {
  const sharedCandidates = candidates();
  const smoke = requestSequence(CODE_CITY_REPO, EVENT, ROOT, smokePaths, true, 2.1, 0.1, 1);
  const qualification = requestSequence(REACT_REPO, REACT_EVENT, REACT_ROOT, sharedCandidates.map(({ path }) => path), false, 6.1, 0.0002, smoke.length + 1);
  const capacity = requestSequence(REACT_REPO, REACT_EVENT, REACT_ROOT, sharedCandidates.map(({ path }) => path), true, 10.1, 0.002, smoke.length + qualification.length + 1);
  return {
    artifact: envelope("artifact", "pass", "none", artifactData()),
    smoke: envelope("smoke", "pass", "none", {
      repositoryUrl: "https://github.com/FelixGeisler/code-city",
      revision: EVENT,
      rootTree: ROOT,
      terminal: "success",
      canvasCount: 1,
      modelSha256: "3".repeat(64),
      startedMs: 2,
      endedMs: 4,
      providerGetCount: 3 + smokePaths.length,
    }),
    qualification: envelope("qualification", "pass", "none", {
      repositoryUrl: "https://github.com/facebook/react",
      revision: REACT_EVENT,
      rootTree: REACT_ROOT,
      treeEntries: 5000,
      truncated: false,
      candidates: sharedCandidates,
    }),
    capacity: envelope("capacity", "pass", "none", {
      repositoryUrl: "https://github.com/facebook/react",
      revision: REACT_EVENT,
      rootTree: REACT_ROOT,
      terminal: "Repository exceeds Code City limits",
      revisionDisplayed: true,
      cityPresent: false,
      priorCityRemoved: true,
      rawRequestCount: 4001,
      maxOverlap: 1,
      noLaterRequest: true,
      workerQuiescent: true,
      candidates: structuredClone(sharedCandidates),
      startedMs: 8,
      endedMs: 22,
    }),
    requests: envelope("requests", "pass", "none", { items: [...smoke, ...qualification, ...capacity] }),
    lifecycle: envelope("lifecycle", "pass", "none", lifecycleData()),
  };
}

function nullData(keys, arrayKeys = []) {
  return Object.fromEntries(keys.map((key) => [key, arrayKeys.includes(key) ? [] : null]));
}

const SMOKE_KEYS = ["repositoryUrl", "revision", "rootTree", "terminal", "canvasCount", "modelSha256", "startedMs", "endedMs", "providerGetCount"];
const QUALIFICATION_KEYS = ["repositoryUrl", "revision", "rootTree", "treeEntries", "truncated", "candidates"];
const CAPACITY_KEYS = ["repositoryUrl", "revision", "rootTree", "terminal", "revisionDisplayed", "cityPresent", "priorCityRemoved", "rawRequestCount", "maxOverlap", "noLaterRequest", "workerQuiescent", "candidates", "startedMs", "endedMs"];

function failedEvents(stage) {
  const prefixLength = { artifact: 1, smoke: 2, qualification: 7, capacity: 9 }[stage];
  const events = passEvents().slice(0, prefixLength);
  events.push({ sequence: events.length + 1, generation: 0, event: "collector-failed", atMs: events.at(-1).atMs + 0.5 });
  return events;
}

function failurePayload(stage, reason) {
  const payloads = makePassingPayloads();
  const stageIndex = ["artifact", "smoke", "qualification", "capacity"].indexOf(stage);
  const primary = ["artifact", "smoke", "qualification", "capacity"];
  for (let index = stageIndex + 1; index < primary.length; index += 1) {
    const kind = primary[index];
    const keys = kind === "smoke" ? SMOKE_KEYS : kind === "qualification" ? QUALIFICATION_KEYS : CAPACITY_KEYS;
    payloads[kind] = envelope(kind, "not-run", "blocked", nullData(keys, ["candidates"]));
  }
  if (stage === "artifact") {
    const data = artifactData();
    data.policyMatched = false;
    payloads.artifact = envelope("artifact", "fail", reason, data);
  } else if (stage === "smoke") {
    payloads.smoke = envelope("smoke", "fail", reason, nullData(SMOKE_KEYS));
  } else if (stage === "qualification") {
    payloads.qualification = envelope("qualification", "fail", reason, nullData(QUALIFICATION_KEYS, ["candidates"]));
  } else {
    payloads.capacity = envelope("capacity", "fail", reason, nullData(CAPACITY_KEYS, ["candidates"]));
  }
  const keep = stage === "artifact" || stage === "smoke" ? 0 : stage === "qualification" ? 4 : 4008;
  payloads.requests = envelope("requests", "fail", reason, { items: payloads.requests.data.items.slice(0, keep) });
  const events = failedEvents(stage);
  payloads.lifecycle = envelope("lifecycle", "fail", reason, lifecycleData(events, {
    invocation: stage === "artifact" ? null : lifecycleData().invocation,
    maxOverlap: stage === "capacity" ? 0 : null,
    noRetry: null,
    noFallback: null,
    noPersistence: null,
    noLaterPublication: null,
  }));
  return payloads;
}

function expectCode(code, callback, message) {
  assert.throws(callback, (error) => error instanceof EvidenceContractError && error.code === code && error.message === code, message);
}

function canonical(value) {
  return encoder.encode(`${JSON.stringify(value)}\n`);
}

let passing;
test.before(() => { passing = makePassingPayloads(); });

test("the module has exactly the closed five-export API and the error constructor is privacy-safe", () => {
  assert.deepEqual(Object.keys(schema).sort(), ["EvidenceContractError", "createEvidencePacket", "createExternalWrapper", "validateEvidencePacket", "validateExternalWrapper"].sort());
  for (const code of ["invalid-payload", "invalid-binding", "noncanonical-bytes", "filesystem-safety", "io-failure"]) {
    const error = new EvidenceContractError(code);
    assert(error instanceof Error);
    assert.deepEqual(Object.keys(error), ["name", "code"]);
    assert.deepEqual({ name: error.name, code: error.code }, { name: "EvidenceContractError", code });
    assert.equal(error.message, code);
    assert.equal(Object.getOwnPropertyDescriptor(error, "message").enumerable, false);
    assert.equal(Object.hasOwn(error, "cause"), false);
  }
  for (const args of [[], ["other"], ["invalid-payload", "extra"]]) {
    assert.throws(() => Reflect.construct(EvidenceContractError, args), (error) => error instanceof TypeError && error.message === "invalid EvidenceContractError code");
  }
});

test("a passing dynamic-smoke packet round-trips exact canonical bytes with fixed ownership and digest", () => {
  const packet = createEvidencePacket(passing, BINDING);
  assert(Object.isFrozen(packet));
  assert(Object.isFrozen(packet.binding));
  assert.deepEqual(Object.keys(packet), ["binding", "files", "packetDigest"]);
  assert.deepEqual(Object.keys(packet.binding), ["issueBodySha256", "eventSha"]);
  assert(packet.files instanceof Map);
  assert.equal(Object.isFrozen(packet.files), false);
  assert.deepEqual([...packet.files.keys()], ["artifact.json", "smoke.json", "qualification.json", "capacity.json", "requests.json", "lifecycle.json", "index.json"]);
  for (const [path, bytes] of packet.files) {
    assert.equal(Object.getPrototypeOf(bytes), Uint8Array.prototype, path);
    assert.equal(bytes.byteOffset, 0);
    assert.equal(bytes.byteLength, bytes.buffer.byteLength);
    if (path !== "index.json") assert.deepEqual(bytes, canonical(passing[path.slice(0, -5)]));
  }
  const index = JSON.parse(new TextDecoder().decode(packet.files.get("index.json")));
  assert.deepEqual(index.files.map(({ path }) => path), ["artifact.json", "capacity.json", "lifecycle.json", "qualification.json", "requests.json", "smoke.json"]);
  assert.equal(index.issueBodySha256, PARENT);
  assert.equal(index.overallStatus, "pass");
  assert.equal(index.firstFailure, "none");
  assert.match(packet.packetDigest, /^[0-9a-f]{64}$/);

  const reverse = new Map([...packet.files].reverse());
  const validated = validateEvidencePacket(reverse, BINDING);
  assert.notEqual(validated, packet);
  assert.notEqual(validated.files, reverse);
  assert.deepEqual([...validated.files.keys()], [...packet.files.keys()]);
  assert.equal(validated.packetDigest, packet.packetDigest);
  for (const path of packet.files.keys()) {
    assert.notEqual(validated.files.get(path), packet.files.get(path));
    assert.deepEqual(validated.files.get(path), packet.files.get(path));
  }
});

test("dynamic smoke K is derived only from persisted ordered distinct raw GETs", () => {
  const payloads = makePassingPayloads(["src/a.ts", "src/b.ts", "src/c.ts"]);
  const packet = createEvidencePacket(payloads, BINDING);
  assert.equal(payloads.smoke.data.providerGetCount, 6);
  assert.equal(Object.hasOwn(payloads.smoke.data, "K"), false);
  assert.equal(validateEvidencePacket(packet.files, BINDING).packetDigest, packet.packetDigest);
  payloads.smoke.data.providerGetCount = 5;
  expectCode("invalid-payload", () => createEvidencePacket(payloads, BINDING));
});

test("inputs are copied, the native map remains honestly mutable, and every mutation requires fresh validation", () => {
  const payloads = makePassingPayloads();
  const packet = createEvidencePacket(payloads, BINDING);
  payloads.smoke.data.terminal = "changed";
  assert.equal(JSON.parse(new TextDecoder().decode(packet.files.get("smoke.json"))).data.terminal, "success");

  const original = new Uint8Array(packet.files.get("artifact.json"));
  packet.files.get("artifact.json")[0] ^= 1;
  expectCode("noncanonical-bytes", () => validateEvidencePacket(packet.files, packet.binding));
  packet.files.set("artifact.json", original);
  packet.files.delete("smoke.json");
  expectCode("invalid-payload", () => validateEvidencePacket(packet.files, packet.binding));
  packet.files.set("smoke.json", createEvidencePacket(makePassingPayloads(), BINDING).files.get("smoke.json"));
  const revalidated = validateEvidencePacket(packet.files, packet.binding);
  assert.notEqual(revalidated.files, packet.files);
  packet.files.clear();
  assert.equal(packet.packetDigest, revalidated.packetDigest, "a stale packet digest is deliberately not self-updating");
});

const reasons = {
  artifact: ["artifact-mismatch", "production-unreachable", "infrastructure-failure"],
  smoke: ["smoke-failure", "provider-failure", "cors-failure", "request-sequence", "request-overlap", "unexpected-request", "credential-header", "stale-publication", "quiescence-failure", "cleanup-failure", "infrastructure-failure"],
  qualification: ["qualification-failure", "identity-mismatch", "provider-failure", "cors-failure", "tree-incomplete", "hash-mismatch", "content-invalid", "request-sequence", "request-overlap", "unexpected-request", "credential-header", "infrastructure-failure"],
  capacity: ["identity-mismatch", "provider-failure", "cors-failure", "tree-incomplete", "hash-mismatch", "content-invalid", "limit-order", "request-sequence", "request-overlap", "unexpected-request", "credential-header", "stale-publication", "quiescence-failure", "cleanup-failure", "infrastructure-failure"],
};

test("every allowed earliest-primary/failure-reason pairing creates and revalidates one complete handled packet", () => {
  for (const [stage, allowed] of Object.entries(reasons)) {
    for (const reason of allowed) {
      const payloads = failurePayload(stage, reason);
      const packet = createEvidencePacket(payloads, BINDING);
      const index = JSON.parse(new TextDecoder().decode(packet.files.get("index.json")));
      assert.equal(index.overallStatus, "fail", `${stage}/${reason}`);
      assert.equal(index.firstFailure, reason, `${stage}/${reason}`);
      assert.equal(payloads.requests.reason, reason);
      assert.equal(payloads.lifecycle.reason, reason);
      assert.equal(validateEvidencePacket(packet.files, BINDING).packetDigest, packet.packetDigest);
    }
  }
});

test("status precedence, auxiliary mapping, null rules, event prefixes, and persisted derivations are closed", () => {
  const cases = [
    () => { const p = failurePayload("smoke", "smoke-failure"); p.qualification.status = "pass"; p.qualification.reason = "none"; return p; },
    () => { const p = failurePayload("qualification", "provider-failure"); p.requests.reason = "cors-failure"; return p; },
    () => { const p = failurePayload("capacity", "limit-order"); p.lifecycle.data.events.splice(-1, 0, { sequence: 10, generation: 2, event: "revision-selected", atMs: 9 }); return p; },
    () => { const p = failurePayload("smoke", "smoke-failure"); p.qualification.data.repositoryUrl = REACT_REPO; return p; },
    () => { const p = makePassingPayloads(); p.smoke.data.providerGetCount = 5; return p; },
    () => { const p = makePassingPayloads(); p.capacity.data.maxOverlap = 2; return p; },
    () => { const p = makePassingPayloads(); p.qualification.data.candidates[4].runningAggregate += 1; return p; },
    () => { const p = makePassingPayloads(); p.capacity.data.candidates[4].path = "different.ts"; return p; },
    () => { const p = makePassingPayloads(); p.lifecycle.data.durations.total += 1; return p; },
    () => { const p = makePassingPayloads(); p.lifecycle.data.noRetry = false; return p; },
  ];
  for (const make of cases) expectCode("invalid-payload", () => createEvidencePacket(make(), BINDING));
});

test("every payload data field and every nested record field is independently enforced", () => {
  const payloads = makePassingPayloads();
  for (const kind of ["artifact", "smoke", "qualification", "capacity", "requests", "lifecycle"]) {
    for (const key of Object.keys(payloads[kind].data)) {
      const original = payloads[kind].data[key];
      payloads[kind].data[key] = Array.isArray(original) ? [] : null;
      expectCode("invalid-payload", () => createEvidencePacket(payloads, BINDING), `${kind}.data.${key}`);
      payloads[kind].data[key] = original;
    }
  }

  const records = [
    [payloads.artifact.data.files[0], {
      path: "../secret", expectedMediaType: "Text/HTML", observedMediaType: "\n", expectedBytes: -1, observedBytes: -1,
      expectedSha256: "A".repeat(64), observedSha256: "A".repeat(64), match: null,
    }],
    [payloads.qualification.data.candidates[0], {
      index: 0, path: "/a.ts", blobId: "A".repeat(40), normalizedBytes: -1, runningAggregate: 2, hashMatched: false, contentValid: false,
    }],
    [payloads.requests.data.items[0], {
      sequence: 0, stage: "other", method: "POST", requestedUrl: "file:///secret", finalUrl: "file:///secret", applicationCall: null,
      status: 99, startedMs: -1, endedMs: -1, headerNames: ["authorization"], corsAllowOrigin: "https://other", rateLimit: null,
      authorizationAbsent: null, cookieAbsent: null, refererAbsent: null, redirected: true,
    }],
    [payloads.lifecycle.data.events[0], { sequence: 0, generation: -1, event: "other", atMs: -1 }],
  ];
  for (const [record, mutations] of records) {
    for (const [key, invalid] of Object.entries(mutations)) {
      const original = record[key]; record[key] = invalid;
      expectCode("invalid-payload", () => createEvidencePacket(payloads, BINDING));
      record[key] = original;
    }
  }
  for (const key of Object.keys(payloads.lifecycle.data.durations)) {
    const original = payloads.lifecycle.data.durations[key]; payloads.lifecycle.data.durations[key] = null;
    expectCode("invalid-payload", () => createEvidencePacket(payloads, BINDING)); payloads.lifecycle.data.durations[key] = original;
  }
  for (const key of Object.keys(payloads.requests.data.items[0].rateLimit)) {
    payloads.requests.data.items[0].rateLimit[key] = 1;
    expectCode("invalid-payload", () => createEvidencePacket(payloads, BINDING)); payloads.requests.data.items[0].rateLimit[key] = null;
  }
});

test("plain-data, exact key order, symbol, accessor, inheritance, proxy, and dense-array rules reject adversarial inputs", () => {
  const factories = [
    () => { const p = makePassingPayloads(); p.extra = true; return p; },
    () => { const p = makePassingPayloads(); p[Symbol("hidden")] = true; return p; },
    () => { const p = makePassingPayloads(); Object.setPrototypeOf(p.smoke.data, { inherited: true }); return p; },
    () => { const p = makePassingPayloads(); Object.defineProperty(p.artifact.data, "repository", { enumerable: true, get() { throw new Error("must not run"); } }); return p; },
    () => { const p = makePassingPayloads(); p.capacity.data.candidates = new Proxy(p.capacity.data.candidates, {}); return p; },
    () => { const p = makePassingPayloads(); delete p.lifecycle.data.events[3]; return p; },
    () => { const p = makePassingPayloads(); p.smoke = { kind: "smoke", schemaVersion: 1, status: "pass", reason: "none", data: p.smoke.data }; return p; },
  ];
  for (const make of factories) expectCode("invalid-payload", () => createEvidencePacket(make(), BINDING));
});

test("zero to three immediately paired browser preflights are accepted without changing persisted GET counts", () => {
  const payloads = makePassingPayloads();
  const items = payloads.requests.data.items;
  const indexes = [
    items.findIndex((item) => item.requestedUrl.includes("FelixGeisler/code-city") && item.stage === "revision"),
    items.findIndex((item) => item.requestedUrl.includes("facebook/react") && !item.applicationCall && item.stage === "revision"),
    items.findIndex((item) => item.requestedUrl.includes("facebook/react") && item.applicationCall && item.stage === "revision"),
  ].sort((left, right) => right - left);
  for (const index of indexes) {
    const preflight = structuredClone(items[index]);
    preflight.method = "OPTIONS";
    preflight.applicationCall = false;
    preflight.status = 204;
    preflight.endedMs = preflight.startedMs;
    items.splice(index, 0, preflight);
  }
  items.forEach((item, index) => { item.sequence = index + 1; });
  const packet = createEvidencePacket(payloads, BINDING);
  assert.equal(validateEvidencePacket(packet.files, BINDING).packetDigest, packet.packetDigest);
  assert.equal(payloads.smoke.data.providerGetCount, 4);
  assert.equal(payloads.capacity.data.rawRequestCount, 4001);
});

test("request route, order, uniqueness, OPTIONS, privacy, timing, overlap, and dynamic K rules reject single mutations", () => {
  const makers = [
    () => { const p = makePassingPayloads(); p.requests.data.items[0].requestedUrl = revisionUrl(REACT_REPO); p.requests.data.items[0].finalUrl = revisionUrl(REACT_REPO); return p; },
    () => { const p = makePassingPayloads(); p.requests.data.items[3].requestedUrl = p.requests.data.items[2].requestedUrl; p.requests.data.items[3].finalUrl = p.requests.data.items[2].finalUrl; return p; },
    () => { const p = makePassingPayloads(); p.requests.data.items[3].method = "OPTIONS"; p.requests.data.items[3].applicationCall = false; return p; },
    () => { const p = makePassingPayloads(); p.requests.data.items[0].headerNames = ["content-type", "accept"]; return p; },
    () => { const p = makePassingPayloads(); p.requests.data.items[0].authorizationAbsent = false; return p; },
    () => { const p = makePassingPayloads(); p.requests.data.items[1].startedMs = 1; return p; },
    () => { const p = makePassingPayloads(); const start = 8012 - 4004; p.requests.data.items[start + 1].startedMs = p.requests.data.items[start].startedMs; p.requests.data.items[start + 1].endedMs = p.requests.data.items[start].endedMs; return p; },
    () => { const p = makePassingPayloads(); p.requests.data.items.splice(3, 1); p.requests.data.items.forEach((item, index) => { item.sequence = index + 1; }); p.smoke.data.providerGetCount = 3; return p; },
  ];
  for (const make of makers) expectCode("invalid-payload", () => createEvidencePacket(make(), BINDING));
});

test("packet map, whole-view, canonical UTF-8/LF, byte cap, file set, index fields, lengths, digests, and binding are enforced", () => {
  const packet = createEvidencePacket(passing, BINDING);
  expectCode("invalid-binding", () => validateEvidencePacket(packet.files, { issueBodySha256: "0".repeat(64), eventSha: EVENT }));
  expectCode("invalid-binding", () => createEvidencePacket(passing, { eventSha: EVENT, issueBodySha256: PARENT }));
  expectCode("invalid-payload", () => validateEvidencePacket(new Map(), BINDING));
  expectCode("invalid-payload", () => validateEvidencePacket(new Map([...packet.files, ["extra.json", new Uint8Array()]]), BINDING));
  expectCode("invalid-payload", () => validateEvidencePacket(new Proxy(packet.files, {}), BINDING));

  const viewMap = new Map(packet.files);
  const original = viewMap.get("smoke.json");
  const backing = new Uint8Array(original.length + 2); backing.set(original, 1);
  viewMap.set("smoke.json", backing.subarray(1, -1));
  expectCode("invalid-payload", () => validateEvidencePacket(viewMap, BINDING));

  for (const replacement of [
    new Uint8Array([...packet.files.get("smoke.json"), 0x0a]),
    Uint8Array.from([0xff]),
    new Uint8Array(64 * 1024 + 1),
  ]) {
    const files = new Map(packet.files); files.set("smoke.json", replacement);
    expectCode("noncanonical-bytes", () => validateEvidencePacket(files, BINDING));
  }

  const indexOriginal = JSON.parse(new TextDecoder().decode(packet.files.get("index.json")));
  const indexMutations = {
    schemaVersion: 2, issueBodySha256: "0".repeat(64), eventSha: "b".repeat(40), overallStatus: "fail", firstFailure: "smoke-failure", files: [],
  };
  for (const [key, invalid] of Object.entries(indexMutations)) {
    const index = structuredClone(indexOriginal); index[key] = invalid;
    const files = new Map(packet.files); files.set("index.json", canonical(index));
    expectCode("invalid-payload", () => validateEvidencePacket(files, BINDING));
  }
  for (const key of ["path", "mediaType", "byteLength", "sha256"]) {
    const index = structuredClone(indexOriginal);
    index.files[0][key] = key === "byteLength" ? 0 : "invalid";
    const files = new Map(packet.files); files.set("index.json", canonical(index));
    expectCode("invalid-payload", () => validateEvidencePacket(files, BINDING));
  }
});

test("all seven byte caps accept an exact-boundary canonical value and reject boundary plus one before semantics", () => {
  const caps = {
    "artifact.json": 64 * 1024,
    "smoke.json": 64 * 1024,
    "qualification.json": 4 * 1024 * 1024,
    "capacity.json": 4 * 1024 * 1024,
    "requests.json": 8 * 1024 * 1024,
    "lifecycle.json": 1024 * 1024,
    "index.json": 16 * 1024,
  };
  const packet = createEvidencePacket(passing, BINDING);
  for (const [path, cap] of Object.entries(caps)) {
    const exact = canonical("x".repeat(cap - 3));
    assert.equal(exact.byteLength, cap, path);
    const exactFiles = new Map(packet.files); exactFiles.set(path, exact);
    expectCode("invalid-payload", () => validateEvidencePacket(exactFiles, BINDING), `${path} exact cap reaches semantic validation`);
    const overFiles = new Map(packet.files); overFiles.set(path, canonical("x".repeat(cap - 2)));
    expectCode("noncanonical-bytes", () => validateEvidencePacket(overFiles, BINDING), `${path} cap + 1`);
  }
});

test("external wrappers are canonical, fresh, closed, bound, frozen on validation, and exhaustive by field", () => {
  const binding = {
    artifactId: "12345678901234567890",
    platformDigest: "4".repeat(64),
    packetDigest: "5".repeat(64),
    eventSha: "6".repeat(64),
    runId: 987654321,
    runAttempt: 2,
  };
  const bytes = createExternalWrapper(binding);
  assert.equal(Object.getPrototypeOf(bytes), Uint8Array.prototype);
  assert.equal(bytes.byteOffset, 0);
  assert.equal(bytes.byteLength, bytes.buffer.byteLength);
  const parsed = JSON.parse(new TextDecoder().decode(bytes));
  assert.deepEqual(Object.keys(parsed), ["schemaVersion", "artifactId", "artifactUrl", "platformDigest", "packetDigest", "eventSha", "runId", "runAttempt", "retentionDays"]);
  assert.equal(parsed.artifactUrl, `https://github.com/FelixGeisler/code-city/actions/runs/${binding.runId}/artifacts/${binding.artifactId}`);
  assert.equal(parsed.retentionDays, 90);
  const validated = validateExternalWrapper(bytes, binding);
  assert(Object.isFrozen(validated));
  assert.deepEqual(validated, parsed);
  binding.runAttempt = 3;
  assert.equal(parsed.runAttempt, 2, "creation copied the input values into bytes");
  binding.runAttempt = 2;

  const invalidBindingValues = { artifactId: "0", platformDigest: "A".repeat(64), packetDigest: "x", eventSha: "x", runId: 0, runAttempt: 0 };
  for (const [key, invalid] of Object.entries(invalidBindingValues)) {
    const value = { ...binding, [key]: invalid };
    expectCode("invalid-payload", () => createExternalWrapper(value));
  }
  expectCode("invalid-payload", () => createExternalWrapper({ runAttempt: 2, ...binding }));
  expectCode("invalid-binding", () => validateExternalWrapper(bytes, { ...binding, packetDigest: "7".repeat(64) }));
  expectCode("noncanonical-bytes", () => validateExternalWrapper(new Uint8Array([...bytes, 0x0a]), binding));
  const backing = new Uint8Array(bytes.length + 1); backing.set(bytes, 1);
  expectCode("noncanonical-bytes", () => validateExternalWrapper(backing.subarray(1), binding));
  expectCode("noncanonical-bytes", () => validateExternalWrapper(new Uint8Array(4097), binding));

  const wrapperMutations = {
    schemaVersion: 2, artifactId: "9", artifactUrl: "https://example.com", platformDigest: "8".repeat(64), packetDigest: "8".repeat(64),
    eventSha: "8".repeat(40), runId: 1, runAttempt: 1, retentionDays: 89,
  };
  for (const [key, invalid] of Object.entries(wrapperMutations)) {
    const wrapper = structuredClone(parsed); wrapper[key] = invalid;
    const expected = ["artifactId", "platformDigest", "packetDigest", "eventSha", "runId", "runAttempt"].includes(key) ? "invalid-binding" : "invalid-payload";
    expectCode(expected, () => validateExternalWrapper(canonical(wrapper), binding));
  }
});

test("schema validation is deterministic and offline and distinguishes persisted assertions from raw observation truth", () => {
  const packetA = createEvidencePacket(makePassingPayloads(), BINDING);
  const packetB = createEvidencePacket(makePassingPayloads(), BINDING);
  assert.equal(packetA.packetDigest, packetB.packetDigest);
  for (const path of packetA.files.keys()) assert.deepEqual(packetA.files.get(path), packetB.files.get(path));
  assert.equal("raw observations are successor-owned", "raw observations are successor-owned");
});
