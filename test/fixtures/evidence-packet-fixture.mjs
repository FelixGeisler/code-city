import { createEvidencePacket } from "../../tools/production-evidence-schema.mjs";

export const ISSUE_BODY_SHA256 = "62e24a6d2ba751a44a515a8402911a1de0fc811db62a80337bdc9a0518b1f300";
export const EVENT_SHA = "a".repeat(40);
export const binding = Object.freeze({ issueBodySha256: ISSUE_BODY_SHA256, eventSha: EVENT_SHA });

const empty = (keys, arrays = []) => Object.fromEntries(keys.map((key) => [key, arrays.includes(key) ? [] : null]));

export function makeEvidencePacket() {
  const payloads = {
    artifact: { schemaVersion: 3, kind: "artifact", status: "fail", reason: "infrastructure-failure", data: {
      issueBodySha256: ISSUE_BODY_SHA256, eventSha: null, repository: "FelixGeisler/code-city", runId: null,
      runAttempt: null, origin: "https://felixgeisler.github.io/code-city/", manifestSha256: null,
      publicationRecordSha256: null, deploymentId: null, deployedSha: null, nodeVersion: null,
      chromeVersion: null, chromeExecutableCategory: null, runnerOs: null, runnerArch: null,
      policyMatched: null, files: [],
    } },
    smoke: { schemaVersion: 3, kind: "smoke", status: "not-run", reason: "blocked", data: empty([
      "repositoryUrl", "revision", "rootTree", "terminal", "canvasCount", "modelSha256", "startedMs", "endedMs", "providerGetCount",
    ]) },
    qualification: { schemaVersion: 3, kind: "qualification", status: "not-run", reason: "blocked", data: empty([
      "repositoryUrl", "revision", "rootTree", "treeEntries", "truncated", "candidates",
    ], ["candidates"]) },
    capacity: { schemaVersion: 3, kind: "capacity", status: "not-run", reason: "blocked", data: empty([
      "repositoryUrl", "revision", "rootTree", "terminal", "revisionDisplayed", "cityPresent", "priorCityRemoved",
      "rawRequestCount", "maxOverlap", "noLaterRequest", "workerQuiescent", "candidates", "startedMs", "endedMs",
    ], ["candidates"]) },
    requests: { schemaVersion: 3, kind: "requests", status: "fail", reason: "infrastructure-failure", data: { items: [] } },
    lifecycle: { schemaVersion: 3, kind: "lifecycle", status: "fail", reason: "infrastructure-failure", data: {
      collectorVersion: 3, collectorCommit: null, invocation: null, nodeVersion: null, chromeVersion: null, cdpVersion: null,
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
