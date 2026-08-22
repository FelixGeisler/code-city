import { createEvidencePacket } from "../../tools/production-evidence-schema.mjs";

export const ISSUE_BODY_SHA256 = "f06369b3eef5e62631ee8f61ddfd7679b00a3d2139dd83a2f6472820e62864e6";
export const EVENT_SHA = "a".repeat(40);
export const binding = Object.freeze({ issueBodySha256: ISSUE_BODY_SHA256, eventSha: EVENT_SHA });

const empty = (keys, arrays = []) => Object.fromEntries(keys.map((key) => [key, arrays.includes(key) ? [] : null]));

export function makeEvidencePacket() {
  const payloads = {
    artifact: { schemaVersion: 1, kind: "artifact", status: "fail", reason: "infrastructure-failure", data: {
      issueBodySha256: ISSUE_BODY_SHA256, eventSha: null, repository: "FelixGeisler/code-city", runId: null,
      runAttempt: null, origin: "https://felixgeisler.github.io/code-city/", manifestSha256: null,
      publicationRecordSha256: null, deploymentId: null, deployedSha: null, nodeVersion: null,
      chromeVersion: null, chromeExecutableCategory: null, runnerOs: null, runnerArch: null,
      policyMatched: null, files: [],
    } },
    smoke: { schemaVersion: 1, kind: "smoke", status: "not-run", reason: "blocked", data: empty([
      "repositoryUrl", "revision", "rootTree", "terminal", "canvasCount", "modelSha256", "startedMs", "endedMs", "providerGetCount",
    ]) },
    qualification: { schemaVersion: 1, kind: "qualification", status: "not-run", reason: "blocked", data: empty([
      "repositoryUrl", "revision", "rootTree", "treeEntries", "truncated", "candidates",
    ], ["candidates"]) },
    capacity: { schemaVersion: 1, kind: "capacity", status: "not-run", reason: "blocked", data: empty([
      "repositoryUrl", "revision", "rootTree", "terminal", "revisionDisplayed", "cityPresent", "priorCityRemoved",
      "rawRequestCount", "maxOverlap", "noLaterRequest", "workerQuiescent", "candidates", "startedMs", "endedMs",
    ], ["candidates"]) },
    requests: { schemaVersion: 1, kind: "requests", status: "fail", reason: "infrastructure-failure", data: { items: [] } },
    lifecycle: { schemaVersion: 1, kind: "lifecycle", status: "fail", reason: "infrastructure-failure", data: {
      collectorVersion: 1, collectorCommit: null, invocation: null, nodeVersion: null, chromeVersion: null, cdpVersion: null,
      events: [
        { sequence: 1, generation: 0, event: "collector-start", atMs: 0 },
        { sequence: 2, generation: 0, event: "collector-failed", atMs: 1 },
      ],
      durations: { artifact: null, smoke: null, qualification: null, resolution: null, inventory: null,
        retrieval: null, terminal: null, capacity: null, total: 1 },
      maxOverlap: null, noRetry: null, noFallback: null, noPersistence: null, noLaterPublication: null,
    } },
  };
  return createEvidencePacket(payloads, binding);
}
