import assert from "node:assert/strict";
import test from "node:test";

import * as schema from "../tools/production-evidence-schema.mjs";
import {
  EvidenceContractError,
  createEvidencePacket,
  createExternalWrapper,
  validateEvidencePacket,
  validateExternalWrapper,
} from "../tools/production-evidence-schema.mjs";

const PARENT = "1d03ad3c36450de38085d622d8ecb6675d77a4f1b5c2b9f119495f38011e79b0";
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

function nativeQualificationItems(payloads) {
  return payloads.requests.data.items.filter((item) => !item.applicationCall
    && item.requestedUrl.includes("/react/react/"));
}

function addNativePreflight(payloads, status = 204) {
  const items = payloads.requests.data.items;
  const getIndex = items.findIndex((item) => !item.applicationCall
    && item.requestedUrl.includes("/react/react/") && item.method === "GET");
  const options = structuredClone(items[getIndex]);
  Object.assign(options, { method: "OPTIONS", status, endedMs: options.startedMs });
  items.splice(getIndex, 0, options);
  items.forEach((item, index) => { item.sequence = index + 1; });
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

test("capacity-start and qualification-complete require exact completed successful native metadata transport", () => {
  const mutations = [
    ["GET status is exactly 200", (p) => { nativeQualificationItems(p)[0].status = 201; }],
    ["OPTIONS status is 2xx", (p) => { addNativePreflight(p, 300); }],
    ["response is not redirected", (p) => {
      const item = nativeQualificationItems(p)[0];
      item.finalUrl = revisionUrl("FelixGeisler/code-city"); item.redirected = true;
    }],
    ["authorization is absent", (p) => { nativeQualificationItems(p)[0].authorizationAbsent = false; }],
    ["cookie is absent", (p) => { nativeQualificationItems(p)[0].cookieAbsent = false; }],
    ["referer is absent", (p) => { nativeQualificationItems(p)[0].refererAbsent = false; }],
    ["accepted CORS is present", (p) => {
      const item = nativeQualificationItems(p)[0];
      item.corsAllowOrigin = null; item.headerNames = item.headerNames.filter((name) => name !== "access-control-allow-origin");
    }],
    ["CORS origin is accepted", (p) => { nativeQualificationItems(p)[0].corsAllowOrigin = "https://example.com"; }],
    ["exchange completed before capacity-start", (p) => { nativeQualificationItems(p).at(-1).endedMs = 8.0001; }],
    ["all three GETs completed", (p) => {
      const items = p.requests.data.items;
      items.splice(items.indexOf(nativeQualificationItems(p)[1]), 1);
      items.forEach((item, index) => { item.sequence = index + 1; });
    }],
  ];
  for (const make of [sharedBrowserFailure, postQualificationFailure]) {
    for (const [name, mutate] of mutations) {
      const payloads = make(); mutate(payloads);
      expectInvalid(() => createEvidencePacket(payloads, BINDING));
    }
  }
  for (const make of [sharedBrowserFailure, postQualificationFailure]) {
    const payloads = make(); addNativePreflight(payloads);
    assert.doesNotThrow(() => createEvidencePacket(payloads, BINDING));
  }
});

test("native transport failures retain the native-before-browser frontier", () => {
  const cases = [
    ["provider-failure", () => {}],
    ["cors-failure", (item) => {
      item.status = 200; item.corsAllowOrigin = null;
      item.headerNames = item.headerNames.filter((name) => name !== "access-control-allow-origin");
    }],
    ["credential-header", (item) => { item.status = 200; item.authorizationAbsent = false; }],
    ["credential-header", (item) => { item.status = 200; item.cookieAbsent = false; }],
    ["credential-header", (item) => { item.status = 200; item.refererAbsent = false; }],
  ];
  for (const [reason, mutate] of cases) {
    const payloads = nativeQualificationFailure();
    const item = nativeQualificationItems(payloads)[0];
    mutate(item);
    payloads.qualification.reason = reason; payloads.requests.reason = reason; payloads.lifecycle.reason = reason;
    assert.doesNotThrow(() => createEvidencePacket(payloads, BINDING));
    assert.deepEqual([payloads.qualification.status, payloads.capacity.status], ["fail", "not-run"]);
    assert.equal(event(payloads.lifecycle.data.events, "capacity-start", 2), undefined);
    assert.equal(payloads.requests.data.items.some((value) => value.applicationCall
      && value.requestedUrl.includes("/react/react/")), false);
  }
});

test("capacity-start rejects overlapping native qualification GETs even at a shared request-overlap frontier", () => {
  const payloads = mutateSharedReason("request-overlap");
  const native = nativeQualificationItems(payloads);
  native[0].endedMs = native[1].endedMs;
  expectInvalid(() => createEvidencePacket(payloads, BINDING));
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

// Baseline v2 suite migration map: the tests below retain the exhaustive API/error,
// payload/nested-field, adversarial container/accessor/proxy, seven-cap, lifecycle,
// status, request-topology, canonical packet/index, and wrapper assertions. Native
// raw-qualification success/failure representations are the only structurally
// obsolete cases; v3 replaces them with unconditional native-raw rejection and
// shared-browser frontier matrices.

function packetIndex(packet) {
  return JSON.parse(new TextDecoder().decode(packet.files.get("index.json")));
}

function setReason(payloads, reason) {
  payloads.qualification.reason = reason;
  payloads.capacity.reason = reason;
  payloads.requests.reason = reason;
  payloads.lifecycle.reason = reason;
}

function mutateSharedReason(reason) {
  const payloads = sharedBrowserFailure();
  setReason(payloads, reason);
  return payloads;
}

function directArtifactRequest(sequence = 1) {
  const value = request(sequence, "asset", "https://felixgeisler.github.io/code-city/package-manifest.json", false, 0.1);
  value.headerNames = [];
  value.corsAllowOrigin = null;
  return value;
}

test("the module retains the closed five-export API and privacy-safe error surface", () => {
  assert.deepEqual(Object.keys(schema).sort(), [
    "EvidenceContractError", "createEvidencePacket", "createExternalWrapper", "validateEvidencePacket", "validateExternalWrapper",
  ].sort());
  for (const code of ["invalid-payload", "invalid-binding", "noncanonical-bytes", "filesystem-safety", "io-failure"]) {
    const error = new EvidenceContractError(code);
    assert.deepEqual(Object.keys(error), ["name", "code"]);
    assert.equal(error.message, code);
    assert.equal(Object.hasOwn(error, "cause"), false);
  }
  assert.throws(() => new EvidenceContractError("secret"), TypeError);
});

test("packet creation copies inputs and validation returns fresh sealed packet metadata", () => {
  const payloads = passingPayloads();
  const packet = createEvidencePacket(payloads, BINDING);
  payloads.smoke.data.terminal = "changed";
  assert.equal(JSON.parse(new TextDecoder().decode(packet.files.get("smoke.json"))).data.terminal, "success");
  const validated = validateEvidencePacket(packet.files, BINDING);
  assert(Object.isFrozen(packet) && Object.isFrozen(packet.binding));
  assert(Object.isFrozen(validated) && Object.isFrozen(validated.binding));
  assert.notEqual(validated.files, packet.files);
  assert.equal(validated.packetDigest, packet.packetDigest);
});

test("all six envelopes require exact ordered fields and plain data", () => {
  for (const kind of ["artifact", "smoke", "qualification", "capacity", "requests", "lifecycle"]) {
    const extra = passingPayloads(); extra[kind].extra = true;
    expectInvalid(() => createEvidencePacket(extra, BINDING));
    const reordered = passingPayloads();
    reordered[kind] = { kind, schemaVersion: 3, status: reordered[kind].status, reason: reordered[kind].reason, data: reordered[kind].data };
    expectInvalid(() => createEvidencePacket(reordered, BINDING));
  }
});

test("the payload set rejects missing, extra, symbol, accessor, inherited, and proxy members", () => {
  const factories = [
    () => { const p = passingPayloads(); delete p.smoke; return p; },
    () => { const p = passingPayloads(); p.extra = true; return p; },
    () => { const p = passingPayloads(); p[Symbol("hidden")] = true; return p; },
    () => { const p = passingPayloads(); Object.setPrototypeOf(p, { inherited: true }); return p; },
    () => { const p = passingPayloads(); Object.defineProperty(p, "smoke", { enumerable: true, get() { throw new Error("must not run"); } }); return p; },
    () => new Proxy(passingPayloads(), {}),
  ];
  for (const make of factories) expectInvalid(() => createEvidencePacket(make(), BINDING));
});

test("every payload data field remains independently required", () => {
  for (const kind of ["artifact", "smoke", "qualification", "capacity", "requests", "lifecycle"]) {
    const baseline = passingPayloads();
    for (const key of Object.keys(baseline[kind].data)) {
      const payloads = passingPayloads();
      const original = payloads[kind].data[key];
      payloads[kind].data[key] = Array.isArray(original) ? [] : original === null ? {} : null;
      expectInvalid(() => createEvidencePacket(payloads, BINDING), undefined, `${kind}.${key}`);
    }
  }
});

test("artifact record fields reject independent malformed mutations", () => {
  const mutations = { path: "../secret", expectedMediaType: "Text/HTML", observedMediaType: "\n", expectedBytes: -1, observedBytes: -1,
    expectedSha256: "A".repeat(64), observedSha256: "A".repeat(64), match: null };
  for (const [key, value] of Object.entries(mutations)) {
    const payloads = passingPayloads(); payloads.artifact.data.files[0][key] = value;
    expectInvalid(() => createEvidencePacket(payloads, BINDING));
  }
});

test("candidate record fields reject independent malformed mutations", () => {
  const mutations = { index: 0, path: "/a.ts", blobId: "A".repeat(40), normalizedBytes: -1,
    runningAggregate: 2, hashMatched: false, contentValid: false };
  for (const [key, value] of Object.entries(mutations)) {
    const payloads = passingPayloads();
    payloads.qualification.data.candidates[0][key] = value;
    payloads.capacity.data.candidates[0][key] = value;
    expectInvalid(() => createEvidencePacket(payloads, BINDING));
  }
});

test("request record fields reject independent malformed mutations", () => {
  const mutations = { sequence: 0, stage: "other", method: "POST", requestedUrl: "file:///secret", finalUrl: "file:///secret",
    applicationCall: null, status: 99, startedMs: -1, endedMs: -1, headerNames: ["authorization"], corsAllowOrigin: "https://other",
    rateLimit: null, authorizationAbsent: null, cookieAbsent: null, refererAbsent: null, redirected: true };
  for (const [key, value] of Object.entries(mutations)) {
    const payloads = passingPayloads(); payloads.requests.data.items[0][key] = value;
    expectInvalid(() => createEvidencePacket(payloads, BINDING));
  }
});

test("lifecycle event and duration fields reject independent malformed mutations", () => {
  for (const [key, value] of Object.entries({ sequence: 0, generation: -1, event: "other", atMs: -1 })) {
    const payloads = passingPayloads(); payloads.lifecycle.data.events[0][key] = value;
    expectInvalid(() => createEvidencePacket(payloads, BINDING));
  }
  for (const key of Object.keys(passingPayloads().lifecycle.data.durations)) {
    const payloads = passingPayloads(); payloads.lifecycle.data.durations[key] = null;
    expectInvalid(() => createEvidencePacket(payloads, BINDING));
  }
});

test("candidate arrays reject sparse, inherited, accessor, and proxy shapes", () => {
  const factories = [
    (value) => { delete value[3]; return value; },
    (value) => { Object.setPrototypeOf(value, null); return value; },
    (value) => { Object.defineProperty(value, "0", { enumerable: true, get() { throw new Error("must not run"); } }); return value; },
    (value) => new Proxy(value, {}),
  ];
  for (const make of factories) {
    const payloads = passingPayloads(); payloads.capacity.data.candidates = make(payloads.capacity.data.candidates);
    expectInvalid(() => createEvidencePacket(payloads, BINDING));
  }
});

test("blocked candidate proxies reject without invoking traps", () => {
  for (const [stage, make] of [["capacity", nativeQualificationFailure], ["qualification", () => {
    const p = nativeQualificationFailure(); p.smoke.status = "fail"; p.smoke.reason = "infrastructure-failure";
    p.qualification = envelope("qualification", "not-run", "blocked", empty(QUALIFICATION_KEYS, ["candidates"]));
    p.requests.reason = "infrastructure-failure"; p.lifecycle.reason = "infrastructure-failure";
    p.requests.data.items = p.requests.data.items.slice(0, 4); p.lifecycle = lifecycle(failedEvents(3, 3), "fail", "infrastructure-failure", null);
    return p;
  }]]) {
    const payloads = make(); let calls = 0;
    payloads[stage].data.candidates = new Proxy([], { get() { calls += 1; throw new Error("trap"); }, ownKeys() { calls += 1; throw new Error("trap"); } });
    expectInvalid(() => createEvidencePacket(payloads, BINDING));
    assert.equal(calls, 0);
  }
});

test("payload accessors and proxies never leak attacker-selected contract errors", () => {
  let calls = 0;
  const payloads = passingPayloads();
  Object.defineProperty(payloads.artifact.data, "repository", { enumerable: true, get() { calls += 1; throw new EvidenceContractError("io-failure"); } });
  expectInvalid(() => createEvidencePacket(payloads, BINDING));
  assert.equal(calls, 0);
});

test("packet maps reject overridden methods and proxies without invoking traps", () => {
  const packet = createEvidencePacket(passingPayloads(), BINDING); let calls = 0;
  for (const mutate of [
    (map) => Object.defineProperty(map, "size", { get() { calls += 1; throw new Error("trap"); } }),
    (map) => Object.defineProperty(map, "get", { value() { calls += 1; throw new Error("trap"); } }),
    (map) => Object.defineProperty(map, Symbol.iterator, { value() { calls += 1; throw new Error("trap"); } }),
  ]) {
    const map = new Map(packet.files); mutate(map); expectInvalid(() => validateEvidencePacket(map, BINDING)); assert.equal(calls, 0);
  }
  expectInvalid(() => validateEvidencePacket(new Proxy(packet.files, {}), BINDING));
});

test("byte views reject overridden accessors and partial backing buffers", () => {
  const packet = createEvidencePacket(passingPayloads(), BINDING);
  for (const property of ["buffer", "byteLength", "length"]) {
    const files = new Map(packet.files); const bytes = new Uint8Array(files.get("smoke.json"));
    Object.defineProperty(bytes, property, { get() { throw new Error("trap"); } }); files.set("smoke.json", bytes);
    expectInvalid(() => validateEvidencePacket(files, BINDING));
  }
  const source = packet.files.get("smoke.json"); const backing = new Uint8Array(source.length + 2); backing.set(source, 1);
  const files = new Map(packet.files); files.set("smoke.json", backing.subarray(1, -1));
  expectInvalid(() => validateEvidencePacket(files, BINDING));
});

test("intrinsic request and lifecycle caps reject oversized arrays before traversal", () => {
  for (const [kind, field, size] of [["requests", "items", 8201], ["lifecycle", "events", 20001]]) {
    const payloads = passingPayloads(); let calls = 0; const oversized = new Array(size);
    Object.defineProperty(oversized, "0", { enumerable: true, get() { calls += 1; throw new Error("trap"); } });
    payloads[kind].data[field] = oversized;
    expectInvalid(() => createEvidencePacket(payloads, BINDING));
    assert.equal(calls, 0);
  }
});

test("all seven byte caps reach semantics at the boundary and reject boundary plus one", () => {
  const caps = { "artifact.json": 64 * 1024, "smoke.json": 64 * 1024, "qualification.json": 4 * 1024 * 1024,
    "capacity.json": 4 * 1024 * 1024, "requests.json": 8 * 1024 * 1024, "lifecycle.json": 1024 * 1024, "index.json": 16 * 1024 };
  const packet = createEvidencePacket(passingPayloads(), BINDING);
  for (const [path, cap] of Object.entries(caps)) {
    const exact = canonical("x".repeat(cap - 3)); assert.equal(exact.byteLength, cap);
    const exactFiles = new Map(packet.files); exactFiles.set(path, exact); expectInvalid(() => validateEvidencePacket(exactFiles, BINDING));
    const over = new Map(packet.files); over.set(path, canonical("x".repeat(cap - 2)));
    expectInvalid(() => validateEvidencePacket(over, BINDING), "noncanonical-bytes");
  }
});

test("packet maps require the canonical seven-file order-independent set", () => {
  const packet = createEvidencePacket(passingPayloads(), BINDING);
  assert.equal(validateEvidencePacket(new Map([...packet.files].reverse()), BINDING).packetDigest, packet.packetDigest);
  for (const path of packet.files.keys()) {
    const files = new Map(packet.files); files.delete(path); expectInvalid(() => validateEvidencePacket(files, BINDING));
  }
});

test("canonical packet bytes reject duplicate LF, invalid UTF-8, and leading whitespace", () => {
  const packet = createEvidencePacket(passingPayloads(), BINDING);
  for (const replacement of [new Uint8Array([...packet.files.get("smoke.json"), 0x0a]), Uint8Array.of(0xff), encoder.encode(" {}\n")]) {
    const files = new Map(packet.files); files.set("smoke.json", replacement);
    expectInvalid(() => validateEvidencePacket(files, BINDING), "noncanonical-bytes");
  }
});

test("every canonical index field is bound to packet facts", () => {
  const packet = createEvidencePacket(passingPayloads(), BINDING); const original = packetIndex(packet);
  const mutations = { schemaVersion: 2, issueBodySha256: "0".repeat(64), eventSha: "b".repeat(40), overallStatus: "fail", firstFailure: "provider-failure", files: [] };
  for (const [key, value] of Object.entries(mutations)) {
    const index = structuredClone(original); index[key] = value; const files = new Map(packet.files); files.set("index.json", canonical(index));
    expectInvalid(() => validateEvidencePacket(files, BINDING));
  }
});

test("every index file record field is bound to path, media type, length, and digest", () => {
  const packet = createEvidencePacket(passingPayloads(), BINDING); const original = packetIndex(packet);
  for (const key of ["path", "mediaType", "byteLength", "sha256"]) {
    const index = structuredClone(original); index.files[0][key] = key === "byteLength" ? 0 : "invalid";
    const files = new Map(packet.files); files.set("index.json", canonical(index));
    expectInvalid(() => validateEvidencePacket(files, BINDING));
  }
});

test("external wrappers remain canonical v1, closed, frozen, and bound", () => {
  const binding = { artifactId: "123", platformDigest: "4".repeat(64), packetDigest: "5".repeat(64), eventSha: EVENT, runId: 7, runAttempt: 2 };
  const bytes = createExternalWrapper(binding); const parsed = validateExternalWrapper(bytes, binding);
  assert(Object.isFrozen(parsed)); assert.equal(parsed.schemaVersion, 1); assert.equal(parsed.retentionDays, 90);
  assert.equal(parsed.artifactUrl, "https://github.com/FelixGeisler/code-city/actions/runs/7/artifacts/123");
});

test("external wrapper binding fields reject malformed and mismatched values", () => {
  const binding = { artifactId: "123", platformDigest: "4".repeat(64), packetDigest: "5".repeat(64), eventSha: EVENT, runId: 7, runAttempt: 2 };
  const bytes = createExternalWrapper(binding);
  for (const [key, value] of Object.entries({ artifactId: "0", platformDigest: "A".repeat(64), packetDigest: "x", eventSha: "x", runId: 0, runAttempt: 0 })) {
    expectInvalid(() => createExternalWrapper({ ...binding, [key]: value }));
  }
  assert.throws(() => validateExternalWrapper(bytes, { ...binding, packetDigest: "6".repeat(64) }),
    (error) => error instanceof EvidenceContractError && error.code === "invalid-binding");
});

test("external wrapper bytes reject partial views, proxies, excess size, and noncanonical LF", () => {
  const binding = { artifactId: "123", platformDigest: "4".repeat(64), packetDigest: "5".repeat(64), eventSha: EVENT, runId: 7, runAttempt: 2 };
  const bytes = createExternalWrapper(binding); const backing = new Uint8Array(bytes.length + 1); backing.set(bytes, 1);
  for (const value of [backing.subarray(1), new Proxy(new Uint8Array(bytes), {}), new Uint8Array(4097), new Uint8Array([...bytes, 0x0a])]) {
    expectInvalid(() => validateExternalWrapper(value, binding), "noncanonical-bytes");
  }
});

test("the schema unconditionally rejects native qualification raw GETs for every status frontier", () => {
  for (const make of [nativeQualificationFailure, sharedBrowserFailure, postQualificationFailure, passingPayloads]) {
    const payloads = make(); const items = payloads.requests.data.items;
    const firstNative = items.findIndex((item) => !item.applicationCall && item.requestedUrl.includes("/react/react/"));
    const raw = request(0, "raw", rawUrl("react/react", REACT, "0001.ts"), false, items[firstNative]?.startedMs ?? 6.5);
    items.splice(firstNative < 0 ? items.length : firstNative + 1, 0, raw); items.forEach((item, index) => { item.sequence = index + 1; });
    expectInvalid(() => createEvidencePacket(payloads, BINDING));
  }
});

test("native-before-browser accepts only exact native qualification reasons", () => {
  const accepted = ["qualification-failure", "identity-mismatch", "provider-failure", "cors-failure", "tree-incomplete",
    "request-sequence", "request-overlap", "unexpected-request", "credential-header", "infrastructure-failure"];
  for (const reason of accepted) {
    const payloads = nativeQualificationFailure();
    payloads.qualification.reason = reason; payloads.requests.reason = reason; payloads.lifecycle.reason = reason;
    if (reason !== "provider-failure") payloads.requests.data.items.at(-1).status = 200;
    assert.doesNotThrow(() => createEvidencePacket(payloads, BINDING), reason);
  }
});

test("native-before-browser rejects capacity-only reasons at the frontier", () => {
  for (const reason of ["hash-mismatch", "content-invalid", "limit-order", "stale-publication", "quiescence-failure", "cleanup-failure"]) {
    const payloads = nativeQualificationFailure();
    payloads.qualification.reason = reason; payloads.requests.reason = reason; payloads.lifecycle.reason = reason;
    payloads.requests.data.items.at(-1).status = 200;
    expectInvalid(() => createEvidencePacket(payloads, BINDING));
  }
});

test("shared capacity-start failures accept the exact shared reason set with dual failure", () => {
  const reasons = ["identity-mismatch", "provider-failure", "cors-failure", "tree-incomplete", "hash-mismatch", "content-invalid",
    "limit-order", "request-sequence", "request-overlap", "unexpected-request", "credential-header", "stale-publication",
    "quiescence-failure", "cleanup-failure", "infrastructure-failure"];
  for (const reason of reasons) {
    assert.doesNotThrow(() => createEvidencePacket(mutateSharedReason(reason), BINDING), `${reason}/terminal`);
    const withoutTerminal = mutateSharedReason(reason);
    withoutTerminal.requests.data.items.pop();
    withoutTerminal.capacity.data.rawRequestCount = 1;
    assert.doesNotThrow(() => createEvidencePacket(withoutTerminal, BINDING), `${reason}/prefix`);
  }
});

test("shared capacity frontiers admit at most one final canonical raw GET on the immutable revision", () => {
  const tooMany = mutateSharedReason("infrastructure-failure");
  tooMany.requests.data.items.push(request(tooMany.requests.data.items.length + 1, "raw",
    rawUrl("react/react", REACT, "0003.ts"), true, 11.5));
  tooMany.capacity.data.rawRequestCount = 3;
  expectInvalid(() => createEvidencePacket(tooMany, BINDING));

  const laterCanonicalPath = mutateSharedReason("infrastructure-failure");
  const terminal = laterCanonicalPath.requests.data.items.at(-1);
  terminal.requestedUrl = rawUrl("react/react", REACT, "0003.ts");
  terminal.finalUrl = terminal.requestedUrl;
  assert.doesNotThrow(() => createEvidencePacket(laterCanonicalPath, BINDING));

  const regressedPath = mutateSharedReason("infrastructure-failure");
  const regressed = regressedPath.requests.data.items.at(-1);
  regressed.requestedUrl = rawUrl("react/react", REACT, "0000.ts");
  regressed.finalUrl = regressed.requestedUrl;
  expectInvalid(() => createEvidencePacket(regressedPath, BINDING));

  const wrongRevision = mutateSharedReason("infrastructure-failure");
  const wrong = wrongRevision.requests.data.items.at(-1);
  wrong.requestedUrl = rawUrl("react/react", "9".repeat(40), "0002.ts");
  wrong.finalUrl = wrong.requestedUrl;
  expectInvalid(() => createEvidencePacket(wrongRevision, BINDING));

  const laterActivity = mutateSharedReason("infrastructure-failure");
  const later = directArtifactRequest(laterActivity.requests.data.items.length + 1);
  later.startedMs = 11.5; later.endedMs = 11.5001;
  laterActivity.requests.data.items.push(later);
  expectInvalid(() => createEvidencePacket(laterActivity, BINDING));
});

test("shared invalid-candidate evidence remains reason-specific and cannot coexist with an extra terminal raw GET", () => {
  for (const [reason, field] of [["content-invalid", "contentValid"], ["hash-mismatch", "hashMatched"]]) {
    const invalidFinal = mutateSharedReason(reason);
    invalidFinal.requests.data.items.pop();
    invalidFinal.capacity.data.rawRequestCount = 1;
    invalidFinal.qualification.data.candidates[0][field] = false;
    invalidFinal.capacity.data.candidates[0][field] = false;
    assert.doesNotThrow(() => createEvidencePacket(invalidFinal, BINDING), reason);

    const invalidWithTerminal = mutateSharedReason(reason);
    invalidWithTerminal.qualification.data.candidates[0][field] = false;
    invalidWithTerminal.capacity.data.candidates[0][field] = false;
    expectInvalid(() => createEvidencePacket(invalidWithTerminal, BINDING));
  }
});

test("shared capacity-start failures reject native-only, mismatched, and unequal-prefix states", () => {
  const nativeOnly = mutateSharedReason("qualification-failure");
  expectInvalid(() => createEvidencePacket(nativeOnly, BINDING));
  const mismatch = sharedBrowserFailure(); mismatch.capacity.reason = "provider-failure";
  expectInvalid(() => createEvidencePacket(mismatch, BINDING));
  const unequal = sharedBrowserFailure(); unequal.capacity.data.candidates = [];
  expectInvalid(() => createEvidencePacket(unequal, BINDING));
});

test("post-qualification failures preserve qualification pass and capacity ownership", () => {
  for (const reason of ["limit-order", "stale-publication", "quiescence-failure", "cleanup-failure", "infrastructure-failure"]) {
    const payloads = postQualificationFailure(); payloads.capacity.reason = reason; payloads.requests.reason = reason; payloads.lifecycle.reason = reason;
    assert.doesNotThrow(() => createEvidencePacket(payloads, BINDING), reason);
  }
});

test("status topology rejects skipped, premature, and regressed nested phase states", () => {
  const cases = [
    () => { const p = nativeQualificationFailure(); p.capacity.status = "pass"; p.capacity.reason = "none"; return p; },
    () => { const p = sharedBrowserFailure(); p.qualification.status = "pass"; p.qualification.reason = "none"; return p; },
    () => { const p = postQualificationFailure(); p.capacity.status = "not-run"; p.capacity.reason = "blocked"; return p; },
    () => { const p = passingPayloads(); p.qualification.status = "fail"; p.qualification.reason = "provider-failure"; return p; },
  ];
  for (const make of cases) expectInvalid(() => createEvidencePacket(make(), BINDING));
});

test("lifecycle prefixes reject missing, reordered, duplicate, and post-terminal events", () => {
  const factories = [
    () => { const p = passingPayloads(); p.lifecycle.data.events.splice(5, 1); return p; },
    () => { const p = passingPayloads(); [p.lifecycle.data.events[8], p.lifecycle.data.events[9]] = [p.lifecycle.data.events[9], p.lifecycle.data.events[8]]; return p; },
    () => { const p = passingPayloads(); p.lifecycle.data.events.push(structuredClone(p.lifecycle.data.events.at(-1))); return p; },
    () => { const p = nativeQualificationFailure(); p.lifecycle.data.events.splice(-1, 0, { sequence: 8, generation: 2, event: "capacity-start", atMs: 6.5 }); return p; },
  ];
  for (const make of factories) expectInvalid(() => createEvidencePacket(make(), BINDING));
});

test("native request topology is exactly three ordered metadata GETs and no retry", () => {
  const valid = passingPayloads();
  assert.deepEqual(valid.requests.data.items.filter((item) => !item.applicationCall && item.requestedUrl.includes("/react/react/"))
    .map(({ stage }) => stage), ["revision", "commit", "tree"]);
  for (const mutate of [
    (items) => { items.splice(items.findIndex((item) => !item.applicationCall && item.stage === "commit"), 1); },
    (items) => { const item = structuredClone(items.find((value) => !value.applicationCall && value.stage === "revision")); items.push(item); },
  ]) {
    const payloads = passingPayloads(); mutate(payloads.requests.data.items); payloads.requests.data.items.forEach((item, index) => { item.sequence = index + 1; });
    expectInvalid(() => createEvidencePacket(payloads, BINDING));
  }
});

test("browser request topology is exactly 4,004 ordered application GETs", () => {
  const payloads = passingPayloads(); const browser = payloads.requests.data.items.filter((item) => item.applicationCall && item.requestedUrl.includes("/react/react/"));
  assert.equal(browser.length, 4004); assert.deepEqual(browser.slice(0, 3).map(({ stage }) => stage), ["revision", "commit", "tree"]);
  const removed = passingPayloads(); removed.requests.data.items.splice(removed.requests.data.items.findLastIndex((item) => item.applicationCall && item.stage === "raw"), 1);
  removed.requests.data.items.forEach((item, index) => { item.sequence = index + 1; }); removed.capacity.data.rawRequestCount = 4000;
  expectInvalid(() => createEvidencePacket(removed, BINDING));
});

test("request uniqueness and retry closure reject repeated routes", () => {
  const payloads = passingPayloads(); const duplicate = structuredClone(payloads.requests.data.items.at(-1));
  duplicate.sequence += 1; duplicate.startedMs += 1; duplicate.endedMs += 1; payloads.requests.data.items.push(duplicate);
  expectInvalid(() => createEvidencePacket(payloads, BINDING));
});

test("request privacy rejects credentials, unsafe headers, bodies, and URL secrets", () => {
  const factories = [
    () => { const p = passingPayloads(); p.requests.data.items[0].authorizationAbsent = false; return p; },
    () => { const p = passingPayloads(); p.requests.data.items[0].headerNames = ["authorization"]; return p; },
    () => { const p = passingPayloads(); p.requests.data.items[0].body = "secret"; return p; },
    () => { const p = passingPayloads(); p.requests.data.items[0].requestedUrl += "&token=secret"; p.requests.data.items[0].finalUrl = p.requests.data.items[0].requestedUrl; return p; },
  ];
  for (const make of factories) expectInvalid(() => createEvidencePacket(make(), BINDING));
});

test("browser CORS and preflight topology remain closed", () => {
  const cors = passingPayloads(); cors.requests.data.items.find((item) => item.applicationCall).corsAllowOrigin = null;
  expectInvalid(() => createEvidencePacket(cors, BINDING));
  const preflight = passingPayloads(); const items = preflight.requests.data.items;
  const getIndex = items.findIndex((item) => item.applicationCall && item.stage === "revision");
  const options = structuredClone(items[getIndex]); options.method = "OPTIONS"; options.applicationCall = false; options.status = 204; options.endedMs = options.startedMs;
  items.splice(getIndex, 0, options); items.forEach((item, index) => { item.sequence = index + 1; });
  assert.doesNotThrow(() => createEvidencePacket(preflight, BINDING));
  const unpaired = passingPayloads(); unpaired.requests.data.items[0].method = "OPTIONS"; unpaired.requests.data.items[0].applicationCall = false;
  expectInvalid(() => createEvidencePacket(unpaired, BINDING));
});

test("request timing rejects reversed intervals, global clock regression, and overlap", () => {
  const factories = [
    () => { const p = passingPayloads(); p.requests.data.items[0].endedMs = p.requests.data.items[0].startedMs - 1; return p; },
    () => { const p = passingPayloads(); p.requests.data.items[1].startedMs = 0; return p; },
    () => { const p = passingPayloads(); const values = p.requests.data.items.filter((item) => item.applicationCall && item.requestedUrl.includes("/react/react/")); values[1].startedMs = values[0].startedMs; values[1].endedMs = values[0].endedMs; return p; },
  ];
  for (const make of factories) expectInvalid(() => createEvidencePacket(make(), BINDING));
});

test("candidate ordering, per-file cap, aggregate cap, hash, and content facts remain closed", () => {
  const factories = [
    () => { const p = passingPayloads(); p.qualification.data.candidates[0].normalizedBytes = 2 * 1024 * 1024 + 1; p.capacity.data.candidates[0].normalizedBytes = 2 * 1024 * 1024 + 1; return p; },
    () => { const p = passingPayloads(); p.qualification.data.candidates.at(-1).runningAggregate = 40 * 1024 * 1024 + 1; p.capacity.data.candidates.at(-1).runningAggregate = 40 * 1024 * 1024 + 1; return p; },
    () => { const p = passingPayloads(); p.qualification.data.candidates[0].hashMatched = false; p.capacity.data.candidates[0].hashMatched = false; return p; },
    () => { const p = passingPayloads(); [p.qualification.data.candidates[0], p.qualification.data.candidates[1]] = [p.qualification.data.candidates[1], p.qualification.data.candidates[0]]; return p; },
  ];
  for (const make of factories) expectInvalid(() => createEvidencePacket(make(), BINDING));
});

test("direct asset topology remains unique, GET-only, redirect-free, and stage-aware", () => {
  const accepted = passingPayloads(); accepted.requests.data.items.unshift(directArtifactRequest());
  accepted.requests.data.items.forEach((item, index) => { item.sequence = index + 1; });
  assert.doesNotThrow(() => createEvidencePacket(accepted, BINDING));
  for (const mutate of [
    (item) => { item.method = "OPTIONS"; },
    (item) => { item.redirected = true; item.finalUrl = "https://felixgeisler.github.io/code-city/index.html"; },
  ]) {
    const payloads = passingPayloads(); const item = directArtifactRequest(); mutate(item); payloads.requests.data.items.unshift(item);
    payloads.requests.data.items.forEach((value, index) => { value.sequence = index + 1; }); expectInvalid(() => createEvidencePacket(payloads, BINDING));
  }
});

test("schema validation stays deterministic and offline across fresh v3 fixtures", () => {
  const a = createEvidencePacket(passingPayloads(), BINDING); const b = createEvidencePacket(passingPayloads(), BINDING);
  assert.equal(a.packetDigest, b.packetDigest);
  for (const path of a.files.keys()) assert.deepEqual(a.files.get(path), b.files.get(path));
});
