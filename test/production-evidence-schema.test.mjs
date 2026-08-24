import assert from "node:assert/strict";
import test from "node:test";

import {
  EvidenceContractError,
  createEvidencePacket,
  createExternalWrapper,
  validateEvidencePacket,
  validateExternalWrapper,
} from "../tools/production-evidence-schema.mjs";

const PARENT = "62e24a6d2ba751a44a515a8402911a1de0fc811db62a80337bdc9a0518b1f300";
const PRIOR_PARENT = "06f08ca0144ffe9d5e162f3eb74c898b8b3a9e789832eae8c406f0fef55d0184";
const EVENT = "a".repeat(40);
const ROOT = "b".repeat(40);
const REACT = "c".repeat(40);
const REACT_ROOT = "d".repeat(40);
const BINDING = Object.freeze({ issueBodySha256: PARENT, eventSha: EVENT });
const encoder = new TextEncoder();

const SMOKE_KEYS = ["repositoryUrl", "revision", "rootTree", "terminal", "canvasCount", "modelSha256", "startedMs", "endedMs", "providerGetCount"];
const QUALIFICATION_KEYS = ["repositoryUrl", "revision", "rootTree", "treeEntries", "truncated", "candidates"];
const CAPACITY_KEYS = ["repositoryUrl", "revision", "rootTree", "terminal", "revisionDisplayed", "cityPresent", "priorCityRemoved", "rawRequestCount", "maxOverlap", "noLaterRequest", "workerQuiescent", "candidates", "startedMs", "endedMs"];

function canonical(value) { return encoder.encode(`${JSON.stringify(value)}\n`); }
function envelope(kind, status, reason, data) { return { schemaVersion: 3, kind, status, reason, data }; }
function empty(keys, arrays = []) { return Object.fromEntries(keys.map((key) => [key, arrays.includes(key) ? [] : null])); }
function expectInvalid(callback, code = "invalid-payload") {
  assert.throws(callback, (error) => error instanceof EvidenceContractError && error.code === code);
}
function revisionUrl(repository) { return `https://api.github.com/repos/${repository}/commits?per_page=1&page=1`; }
function commitUrl(repository, revision) { return `https://api.github.com/repos/${repository}/git/commits/${revision}`; }
function treeUrl(repository, root) { return `https://api.github.com/repos/${repository}/git/trees/${root}?recursive=1`; }
function rawUrl(repository, revision, rawPath) { return `https://raw.githubusercontent.com/${repository}/${revision}/${rawPath}`; }

function candidates(count = 4001) {
  return Array.from({ length: count }, (_, offset) => ({
    index: offset + 1,
    path: `${String(offset + 1).padStart(4, "0")}.ts`,
    blobId: "f".repeat(40),
    normalizedBytes: 1,
    runningAggregate: offset + 1,
    hashMatched: true,
    contentValid: true,
  }));
}

function request(sequence, stage, requestedUrl, applicationCall, startedMs, status = 200) {
  return {
    sequence, stage, method: "GET", requestedUrl, finalUrl: requestedUrl, applicationCall,
    status, startedMs, endedMs: startedMs + 0.0001,
    headerNames: ["access-control-allow-origin"], corsAllowOrigin: "*",
    rateLimit: { limit: null, remaining: null, reset: null },
    authorizationAbsent: true, cookieAbsent: true, refererAbsent: true, redirected: false,
  };
}

function sequence(repository, revision, root, paths, applicationCall, start, firstSequence) {
  const routes = [
    ["revision", revisionUrl(repository)],
    ["commit", commitUrl(repository, revision)],
    ["tree", treeUrl(repository, root)],
    ...paths.map((rawPath) => ["raw", rawUrl(repository, revision, rawPath)]),
  ];
  return routes.map(([stage, url], index) => {
    const startedMs = repository === "FelixGeisler/code-city" && applicationCall
      ? (index === 0 ? 2.1 : 3 + (index - 1) * 0.1)
      : repository === "react/react" && applicationCall
        ? (index === 0 ? 8.1 : index === 1 ? 9 : index === 2 ? 9.1 : 10.1 + (index - 3) * 0.002)
        : start + index * 0.1;
    return request(firstSequence + index, stage, url, applicationCall, startedMs);
  });
}

function passEvents() {
  return [
    ["collector-start", 0, 0], ["artifact-verified", 0, 1], ["smoke-start", 1, 2],
    ["revision-selected", 1, 3], ["city-published", 1, 4], ["trace-reset", 0, 5],
    ["qualification-start", 0, 6], ["capacity-start", 2, 8], ["revision-selected", 2, 9],
    ["inventory-complete", 2, 10], ["qualification-complete", 0, 20], ["limit-failure", 2, 21],
    ["request-quiescent", 2, 22], ["worker-quiescent", 2, 23], ["collector-complete", 0, 24],
  ].map(([event, generation, atMs], index) => ({ sequence: index + 1, generation, event, atMs }));
}
function event(events, name, generation) { return events.find((item) => item.event === name && item.generation === generation); }
function difference(events, endName, endGeneration, startName, startGeneration) {
  const end = event(events, endName, endGeneration); const start = event(events, startName, startGeneration);
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
function lifecycle(events, status = "pass", reason = "none", maxOverlap = 1) {
  return envelope("lifecycle", status, reason, {
    collectorVersion: 3,
    collectorCommit: EVENT,
    invocation: ["node", "tools/collect-production-evidence.mjs", "--origin", "$ORIGIN", "--manifest", "$MANIFEST", "--output", "$OUTPUT"],
    nodeVersion: "v24.19.0", chromeVersion: "140.0.1.2", cdpVersion: "1.3",
    events, durations: durations(events), maxOverlap,
    noRetry: status === "pass" ? true : null,
    noFallback: status === "pass" ? true : null,
    noPersistence: status === "pass" ? true : null,
    noLaterPublication: status === "pass" ? true : null,
  });
}
function artifact() {
  return {
    issueBodySha256: PARENT, eventSha: EVENT, repository: "FelixGeisler/code-city",
    runId: 1, runAttempt: 1, origin: "https://felixgeisler.github.io/code-city/",
    manifestSha256: "1".repeat(64), publicationRecordSha256: "2".repeat(64),
    deploymentId: 1, deployedSha: EVENT, nodeVersion: "v24.19.0", chromeVersion: "140.0.1.2",
    chromeExecutableCategory: "windows-program-files", runnerOs: "Windows", runnerArch: "X64",
    policyMatched: true,
    files: [{
      path: "index.html", expectedMediaType: "text/html", observedMediaType: "text/html",
      expectedBytes: 1, observedBytes: 1, expectedSha256: "3".repeat(64),
      observedSha256: "3".repeat(64), match: true,
    }],
  };
}

function passingPayloads() {
  const facts = candidates();
  const smoke = sequence("FelixGeisler/code-city", EVENT, ROOT, ["src/main.ts"], true, 2.1, 1);
  const qualification = sequence("react/react", REACT, REACT_ROOT, [], false, 6.1, smoke.length + 1);
  const capacity = sequence("react/react", REACT, REACT_ROOT, facts.map(({ path: value }) => value), true, 8.1, smoke.length + qualification.length + 1);
  return {
    artifact: envelope("artifact", "pass", "none", artifact()),
    smoke: envelope("smoke", "pass", "none", {
      repositoryUrl: "https://github.com/FelixGeisler/code-city", revision: EVENT, rootTree: ROOT,
      terminal: "success", canvasCount: 1, modelSha256: "4".repeat(64),
      startedMs: 2, endedMs: 4, providerGetCount: 4,
    }),
    qualification: envelope("qualification", "pass", "none", {
      repositoryUrl: "https://github.com/react/react", revision: REACT, rootTree: REACT_ROOT,
      treeEntries: 5000, truncated: false, candidates: facts,
    }),
    capacity: envelope("capacity", "pass", "none", {
      repositoryUrl: "https://github.com/react/react", revision: REACT, rootTree: REACT_ROOT,
      terminal: "Repository exceeds Code City limits", revisionDisplayed: true, cityPresent: false,
      priorCityRemoved: true, rawRequestCount: 4001, maxOverlap: 1, noLaterRequest: true,
      workerQuiescent: true, candidates: structuredClone(facts), startedMs: 8, endedMs: 23,
    }),
    requests: envelope("requests", "pass", "none", { items: [...smoke, ...qualification, ...capacity] }),
    lifecycle: lifecycle(passEvents()),
  };
}

function failedEvents(prefixLength, atMs = 25) {
  const events = passEvents().slice(0, prefixLength);
  events.push({ sequence: events.length + 1, generation: 0, event: "collector-failed", atMs });
  return events;
}
function failureAuxiliary(payloads, reason, events, maxOverlap) {
  payloads.requests.status = "fail"; payloads.requests.reason = reason;
  payloads.lifecycle = lifecycle(events, "fail", reason, maxOverlap);
  return payloads;
}
function nativeQualificationFailure() {
  const payloads = passingPayloads();
  const smokeCount = 4;
  const failed = request(smokeCount + 1, "revision", revisionUrl("react/react"), false, 6.1, 500);
  payloads.qualification = envelope("qualification", "fail", "provider-failure", {
    ...empty(QUALIFICATION_KEYS, ["candidates"]), repositoryUrl: "https://github.com/react/react",
  });
  payloads.capacity = envelope("capacity", "not-run", "blocked", empty(CAPACITY_KEYS, ["candidates"]));
  payloads.requests.data.items = [...payloads.requests.data.items.slice(0, smokeCount), failed];
  return failureAuxiliary(payloads, "provider-failure", failedEvents(7, 7), null);
}
function sharedBrowserFailure() {
  const payloads = passingPayloads();
  const prefix = candidates(1);
  const smokeAndNative = payloads.requests.data.items.slice(0, 7);
  const browser = sequence("react/react", REACT, REACT_ROOT, ["0001.ts", "0002.ts"], true, 8.1, 8);
  const qualificationData = {
    repositoryUrl: "https://github.com/react/react", revision: REACT, rootTree: REACT_ROOT,
    treeEntries: 5000, truncated: false, candidates: structuredClone(prefix),
  };
  const capacityData = {
    ...empty(CAPACITY_KEYS, ["candidates"]), repositoryUrl: "https://github.com/react/react",
    revision: REACT, rootTree: REACT_ROOT, rawRequestCount: 2, maxOverlap: 1,
    candidates: structuredClone(prefix), startedMs: 8,
  };
  payloads.qualification = envelope("qualification", "fail", "content-invalid", qualificationData);
  payloads.capacity = envelope("capacity", "fail", "content-invalid", capacityData);
  payloads.requests.data.items = [...smokeAndNative, ...browser];
  return failureAuxiliary(payloads, "content-invalid", failedEvents(10, 12), 1);
}
function postQualificationFailure() {
  const payloads = passingPayloads();
  payloads.capacity.status = "fail"; payloads.capacity.reason = "infrastructure-failure";
  Object.assign(payloads.capacity.data, {
    terminal: null, revisionDisplayed: null, cityPresent: null, priorCityRemoved: null,
    noLaterRequest: null, workerQuiescent: null, endedMs: null,
  });
  return failureAuxiliary(payloads, "infrastructure-failure", failedEvents(11, 21), 1);
}

test("packet v3 round-trips canonical bytes with exact parent binding and unchanged external wrapper v1", () => {
  const payloads = passingPayloads();
  const packet = createEvidencePacket(payloads, BINDING);
  assert.deepEqual([...packet.files.keys()], ["artifact.json", "smoke.json", "qualification.json", "capacity.json", "requests.json", "lifecycle.json", "index.json"]);
  for (const kind of ["artifact", "smoke", "qualification", "capacity", "requests", "lifecycle"]) {
    assert.deepEqual(packet.files.get(`${kind}.json`), canonical(payloads[kind]));
    assert.equal(payloads[kind].schemaVersion, 3);
  }
  const index = JSON.parse(new TextDecoder().decode(packet.files.get("index.json")));
  assert.equal(index.schemaVersion, 3);
  assert.equal(index.issueBodySha256, PARENT);
  assert.equal(index.overallStatus, "pass");
  assert.equal(payloads.lifecycle.data.collectorVersion, 3);
  assert.equal(validateEvidencePacket(packet.files, BINDING).packetDigest, packet.packetDigest);

  const wrapperBinding = { artifactId: "9", platformDigest: "5".repeat(64), packetDigest: packet.packetDigest, eventSha: EVENT, runId: 7, runAttempt: 1 };
  const wrapper = createExternalWrapper(wrapperBinding);
  assert.equal(JSON.parse(new TextDecoder().decode(wrapper)).schemaVersion, 1);
  assert.equal(validateExternalWrapper(wrapper, wrapperBinding).retentionDays, 90);
});

test("v1, v2, every mixed packet version, the prior parent, and runtime replacement fields fail closed", () => {
  for (const version of [1, 2]) {
    for (const kind of ["artifact", "smoke", "qualification", "capacity", "requests", "lifecycle"]) {
      const payloads = passingPayloads(); payloads[kind].schemaVersion = version;
      expectInvalid(() => createEvidencePacket(payloads, BINDING));
    }
    const payloads = passingPayloads(); payloads.lifecycle.data.collectorVersion = version;
    expectInvalid(() => createEvidencePacket(payloads, BINDING));
    const packet = createEvidencePacket(passingPayloads(), BINDING);
    const index = JSON.parse(new TextDecoder().decode(packet.files.get("index.json")));
    index.schemaVersion = version;
    const mixed = new Map(packet.files); mixed.set("index.json", canonical(index));
    expectInvalid(() => validateEvidencePacket(mixed, BINDING));
  }
  expectInvalid(() => createEvidencePacket(passingPayloads(), { issueBodySha256: PRIOR_PARENT, eventSha: EVENT }), "invalid-binding");
  expectInvalid(() => createEvidencePacket(passingPayloads(), { ...BINDING, parentDigest: PARENT }), "invalid-binding");
  const oldArtifact = passingPayloads(); oldArtifact.artifact.data.issueBodySha256 = PRIOR_PARENT;
  expectInvalid(() => createEvidencePacket(oldArtifact, BINDING));
});

test("passing React evidence is exactly three native metadata GETs plus 4,004 sequential browser GETs", () => {
  const payloads = passingPayloads();
  createEvidencePacket(payloads, BINDING);
  const react = payloads.requests.data.items.filter(({ requestedUrl }) => requestedUrl.includes("/react/react/"));
  const native = react.filter(({ applicationCall }) => !applicationCall);
  const browser = react.filter(({ applicationCall }) => applicationCall);
  assert.deepEqual(native.map(({ stage }) => stage), ["revision", "commit", "tree"]);
  assert.equal(native.some(({ stage }) => stage === "raw"), false);
  assert.equal(browser.length, 4004);
  assert.deepEqual(browser.slice(0, 3).map(({ stage }) => stage), ["revision", "commit", "tree"]);
  assert(browser.slice(3).every(({ stage }) => stage === "raw"));
  assert.equal(react.length, 4007);
  assert.deepEqual(payloads.qualification.data.candidates, payloads.capacity.data.candidates);
});

test("native-before-browser, shared-browser, and post-qualification failure statuses are the only nested frontiers", () => {
  const native = nativeQualificationFailure();
  assert.doesNotThrow(() => createEvidencePacket(native, BINDING));
  assert.deepEqual([native.qualification.status, native.capacity.status], ["fail", "not-run"]);

  const shared = sharedBrowserFailure();
  assert.doesNotThrow(() => createEvidencePacket(shared, BINDING));
  assert.deepEqual([shared.qualification.status, shared.capacity.status], ["fail", "fail"]);
  assert.equal(shared.qualification.reason, shared.capacity.reason);
  assert.deepEqual(shared.qualification.data.candidates, shared.capacity.data.candidates);
  assert.deepEqual(shared.lifecycle.data.events.slice(-1).map(({ event: value }) => value), ["collector-failed"]);

  const after = postQualificationFailure();
  assert.doesNotThrow(() => createEvidencePacket(after, BINDING));
  assert.deepEqual([after.qualification.status, after.capacity.status], ["pass", "fail"]);

  const impossible = sharedBrowserFailure(); impossible.capacity.reason = "provider-failure";
  expectInvalid(() => createEvidencePacket(impossible, BINDING));
  const impossiblePrefix = sharedBrowserFailure(); impossiblePrefix.capacity.data.candidates = [];
  expectInvalid(() => createEvidencePacket(impossiblePrefix, BINDING));
  const prematurePass = sharedBrowserFailure(); prematurePass.qualification.status = "pass"; prematurePass.qualification.reason = "none";
  expectInvalid(() => createEvidencePacket(prematurePass, BINDING));
  const blockedAfterComplete = postQualificationFailure(); blockedAfterComplete.capacity = envelope("capacity", "not-run", "blocked", empty(CAPACITY_KEYS, ["candidates"]));
  expectInvalid(() => createEvidencePacket(blockedAfterComplete, BINDING));
});

test("qualification-complete is after candidate 4,001 projection and before the expected limit terminal", () => {
  const payloads = passingPayloads();
  createEvidencePacket(payloads, BINDING);
  const events = payloads.lifecycle.data.events;
  const complete = event(events, "qualification-complete", 0);
  const limit = event(events, "limit-failure", 2);
  const lastRaw = payloads.requests.data.items.filter((item) => item.applicationCall && item.stage === "raw").at(-1);
  assert(lastRaw.endedMs <= complete.atMs);
  assert(complete.atMs <= limit.atMs);
  assert.deepEqual(events.map(({ event: value }) => value).slice(6, 12), [
    "qualification-start", "capacity-start", "revision-selected", "inventory-complete", "qualification-complete", "limit-failure",
  ]);
});

test("canonical identity, routes, redirects, aliases, retries, fallback, raw retention, and credential disclosure are rejected", () => {
  for (const replacement of ["facebook/react", "10270250", "React/react", "reactjs/react"]) {
    const payloads = passingPayloads();
    payloads.qualification.data.repositoryUrl = `https://github.com/${replacement}`;
    payloads.capacity.data.repositoryUrl = `https://github.com/${replacement}`;
    for (const item of payloads.requests.data.items) {
      item.requestedUrl = item.requestedUrl.replace("/react/react/", `/${replacement}/`);
      item.finalUrl = item.finalUrl.replace("/react/react/", `/${replacement}/`);
    }
    expectInvalid(() => createEvidencePacket(payloads, BINDING));
  }
  const redirect = passingPayloads();
  const selected = redirect.requests.data.items.find((item) => item.requestedUrl.includes("/react/react/"));
  selected.finalUrl = selected.requestedUrl.replace("/react/react/", "/facebook/react/"); selected.redirected = true;
  expectInvalid(() => createEvidencePacket(redirect, BINDING));

  const retry = passingPayloads();
  const duplicate = structuredClone(retry.requests.data.items.at(-1)); duplicate.sequence += 1; duplicate.startedMs += 1; duplicate.endedMs += 1;
  retry.requests.data.items.push(duplicate);
  expectInvalid(() => createEvidencePacket(retry, BINDING));

  const body = passingPayloads(); body.requests.data.items.at(-1).body = "secret";
  expectInvalid(() => createEvidencePacket(body, BINDING));
  const credential = passingPayloads(); credential.requests.data.items.at(-1).authorizationAbsent = false;
  expectInvalid(() => createEvidencePacket(credential, BINDING));
});

test("candidate caps, ordering, body-derived facts, and aggregate privacy invariants remain enforced", () => {
  const mutations = [
    (p) => { p.qualification.data.candidates[0].path = "../secret.ts"; p.capacity.data.candidates[0].path = "../secret.ts"; },
    (p) => { p.qualification.data.candidates[0].normalizedBytes = 2 * 1024 * 1024 + 1; p.capacity.data.candidates[0].normalizedBytes = 2 * 1024 * 1024 + 1; },
    (p) => { p.qualification.data.candidates[0].hashMatched = false; p.capacity.data.candidates[0].hashMatched = false; },
    (p) => { p.qualification.data.candidates[0].contentValid = false; p.capacity.data.candidates[0].contentValid = false; },
    (p) => { [p.qualification.data.candidates[0], p.qualification.data.candidates[1]] = [p.qualification.data.candidates[1], p.qualification.data.candidates[0]]; },
    (p) => { p.capacity.data.rawBody = "forbidden"; },
  ];
  for (const mutate of mutations) {
    const payloads = passingPayloads(); mutate(payloads);
    expectInvalid(() => createEvidencePacket(payloads, BINDING));
  }
});

test("packet map, canonical UTF-8 plus LF, exact file set, index digest, and whole-view requirements fail closed", () => {
  const packet = createEvidencePacket(passingPayloads(), BINDING);
  const missing = new Map(packet.files); missing.delete("smoke.json");
  expectInvalid(() => validateEvidencePacket(missing, BINDING));
  const extra = new Map(packet.files); extra.set("extra.json", canonical({}));
  expectInvalid(() => validateEvidencePacket(extra, BINDING));
  const noncanonical = new Map(packet.files); noncanonical.set("smoke.json", encoder.encode(" {}\n"));
  expectInvalid(() => validateEvidencePacket(noncanonical, BINDING), "noncanonical-bytes");
  const alteredIndex = new Map(packet.files); const index = JSON.parse(new TextDecoder().decode(alteredIndex.get("index.json")));
  index.firstFailure = "provider-failure"; alteredIndex.set("index.json", canonical(index));
  expectInvalid(() => validateEvidencePacket(alteredIndex, BINDING));
  const source = packet.files.get("artifact.json"); const padded = new Uint8Array(source.byteLength + 1); padded.set(source, 1);
  const partial = new Map(packet.files); partial.set("artifact.json", padded.subarray(1));
  expectInvalid(() => validateEvidencePacket(partial, BINDING));
});
