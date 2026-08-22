import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";

const PARENT_DIGEST = "f06369b3eef5e62631ee8f61ddfd7679b00a3d2139dd83a2f6472820e62864e6";
const REPOSITORY = "FelixGeisler/code-city";
const ORIGIN = "https://felixgeisler.github.io/code-city/";
const CODE_CITY_URL = "https://github.com/FelixGeisler/code-city";
const REACT_URL = "https://github.com/facebook/react";
const MEDIA_TYPE = "application/json";
const ENCODER = new TextEncoder();
const DECODER = new TextDecoder("utf-8", { fatal: true });
const MAP_PROTOTYPE = Map.prototype;
const MAP_SIZE = Object.getOwnPropertyDescriptor(MAP_PROTOTYPE, "size").get;
const MAP_HAS = MAP_PROTOTYPE.has;
const MAP_GET = MAP_PROTOTYPE.get;
const MAP_ENTRIES = MAP_PROTOTYPE.entries;
const ARRAY_BUFFER_BYTE_LENGTH = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength").get;
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype);
const TYPED_ARRAY_BUFFER = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "buffer").get;
const TYPED_ARRAY_BYTE_LENGTH = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "byteLength").get;
const TYPED_ARRAY_BYTE_OFFSET = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "byteOffset").get;
const TYPED_ARRAY_LENGTH = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "length").get;
const TYPED_ARRAY_SET = TYPED_ARRAY_PROTOTYPE.set;

const PAYLOAD_NAMES = ["artifact", "smoke", "qualification", "capacity", "requests", "lifecycle"];
const FILE_ORDER = PAYLOAD_NAMES.map((name) => `${name}.json`);
const MAP_ORDER = [...FILE_ORDER, "index.json"];
const INDEX_ORDER = [...FILE_ORDER].sort();
const CAPS = new Map([
  ["artifact.json", 64 * 1024],
  ["smoke.json", 64 * 1024],
  ["qualification.json", 4 * 1024 * 1024],
  ["capacity.json", 4 * 1024 * 1024],
  ["requests.json", 8 * 1024 * 1024],
  ["lifecycle.json", 1024 * 1024],
  ["index.json", 16 * 1024],
]);
const FAIL_REASONS = Object.freeze({
  artifact: ["artifact-mismatch", "production-unreachable", "infrastructure-failure"],
  smoke: ["smoke-failure", "provider-failure", "cors-failure", "request-sequence", "request-overlap", "unexpected-request", "credential-header", "stale-publication", "quiescence-failure", "cleanup-failure", "infrastructure-failure"],
  qualification: ["qualification-failure", "identity-mismatch", "provider-failure", "cors-failure", "tree-incomplete", "hash-mismatch", "content-invalid", "request-sequence", "request-overlap", "unexpected-request", "credential-header", "infrastructure-failure"],
  capacity: ["identity-mismatch", "provider-failure", "cors-failure", "tree-incomplete", "hash-mismatch", "content-invalid", "limit-order", "request-sequence", "request-overlap", "unexpected-request", "credential-header", "stale-publication", "quiescence-failure", "cleanup-failure", "infrastructure-failure"],
});
const ERROR_CODES = new Set(["invalid-payload", "invalid-binding", "noncanonical-bytes", "filesystem-safety", "io-failure"]);
const ENVELOPE_KEYS = ["schemaVersion", "kind", "status", "reason", "data"];
const BINDING_KEYS = ["issueBodySha256", "eventSha"];
const WRAPPER_BINDING_KEYS = ["artifactId", "platformDigest", "packetDigest", "eventSha", "runId", "runAttempt"];
const SAFE_HEADERS = ["accept", "access-control-allow-origin", "cache-control", "content-type", "origin", "pragma", "x-github-api-version", "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset"];
const SAFE_HEADER_SET = new Set(SAFE_HEADERS);
const CORS_VALUES = new Set(["*", "https://felixgeisler.github.io"]);
const INVOCATION = ["node", "tools/collect-production-evidence.mjs", "--origin", "$ORIGIN", "--manifest", "$MANIFEST", "--output", "$OUTPUT"];
const PASS_EVENTS = [
  ["collector-start", 0], ["artifact-verified", 0], ["smoke-start", 1],
  ["revision-selected", 1], ["city-published", 1], ["trace-reset", 0],
  ["qualification-start", 0], ["qualification-complete", 0], ["capacity-start", 2],
  ["revision-selected", 2], ["inventory-complete", 2], ["limit-failure", 2],
  ["request-quiescent", 2], ["worker-quiescent", 2], ["collector-complete", 0],
];
const EVENT_NAMES = new Set([...PASS_EVENTS.map(([name]) => name), "collector-failed"]);
const DATA_KEYS = Object.freeze({
  artifact: ["issueBodySha256", "eventSha", "repository", "runId", "runAttempt", "origin", "manifestSha256", "publicationRecordSha256", "deploymentId", "deployedSha", "nodeVersion", "chromeVersion", "chromeExecutableCategory", "runnerOs", "runnerArch", "policyMatched", "files"],
  smoke: ["repositoryUrl", "revision", "rootTree", "terminal", "canvasCount", "modelSha256", "startedMs", "endedMs", "providerGetCount"],
  qualification: ["repositoryUrl", "revision", "rootTree", "treeEntries", "truncated", "candidates"],
  capacity: ["repositoryUrl", "revision", "rootTree", "terminal", "revisionDisplayed", "cityPresent", "priorCityRemoved", "rawRequestCount", "maxOverlap", "noLaterRequest", "workerQuiescent", "candidates", "startedMs", "endedMs"],
  requests: ["items"],
  lifecycle: ["collectorVersion", "collectorCommit", "invocation", "nodeVersion", "chromeVersion", "cdpVersion", "events", "durations", "maxOverlap", "noRetry", "noFallback", "noPersistence", "noLaterPublication"],
});

class ContractFailure extends Error {}
function reject() { throw new ContractFailure(); }
function requireValue(value) { if (!value) reject(); }
function isObject(value) { return typeof value === "object" && value !== null; }

function exactObject(value, keys) {
  requireValue(isObject(value) && !utilTypes.isProxy(value) && !Array.isArray(value));
  requireValue(Object.getPrototypeOf(value) === Object.prototype);
  const ownKeys = Reflect.ownKeys(value);
  requireValue(ownKeys.length === keys.length && ownKeys.every((key, index) => key === keys[index]));
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    requireValue(descriptor && "value" in descriptor && descriptor.enumerable);
  }
  return value;
}

function exactArray(value, max = Number.MAX_SAFE_INTEGER) {
  requireValue(!utilTypes.isProxy(value) && Array.isArray(value) && value.length <= max && Object.getPrototypeOf(value) === Array.prototype);
  const ownKeys = Reflect.ownKeys(value);
  requireValue(ownKeys.length === value.length + 1 && ownKeys[value.length] === "length");
  for (let index = 0; index < value.length; index += 1) {
    requireValue(ownKeys[index] === String(index));
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    requireValue(descriptor && "value" in descriptor && descriptor.enumerable);
  }
  return value;
}

function wholeUint8ArrayLength(value) {
  if (!isObject(value) || utilTypes.isProxy(value) || !utilTypes.isUint8Array(value) || Object.getPrototypeOf(value) !== Uint8Array.prototype) return null;
  const length = TYPED_ARRAY_LENGTH.call(value);
  const byteLength = TYPED_ARRAY_BYTE_LENGTH.call(value);
  const buffer = TYPED_ARRAY_BUFFER.call(value);
  if (!utilTypes.isArrayBuffer(buffer) || TYPED_ARRAY_BYTE_OFFSET.call(value) !== 0
    || byteLength !== length || byteLength !== ARRAY_BUFFER_BYTE_LENGTH.call(buffer)) return null;
  return byteLength;
}

function hasByteViewOverrides(value) {
  return ["buffer", "byteLength", "byteOffset", "length", "every", Symbol.iterator].some((key) => Object.hasOwn(value, key));
}

function copyBytes(value) {
  const copy = new Uint8Array(TYPED_ARRAY_BYTE_LENGTH.call(value));
  TYPED_ARRAY_SET.call(copy, value);
  return copy;
}

function oneOf(value, values) { requireValue(values.includes(value)); }
function nullable(value, validator) { if (value !== null) validator(value); }
function boolean(value) { requireValue(typeof value === "boolean"); }
function nullableBoolean(value) { nullable(value, boolean); }
function count(value) { requireValue(Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)); }
function positiveCount(value) { count(value); requireValue(value >= 1); }
function milliseconds(value) { requireValue(typeof value === "number" && Number.isFinite(value) && value >= 0 && !Object.is(value, -0)); }
function sha256(value) { requireValue(typeof value === "string" && /^[0-9a-f]{64}$/.test(value)); }
function gitId(value) { requireValue(typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)); }
function ascii(value, max = 256) { requireValue(typeof value === "string" && value.length > 0 && value.length <= max && /^[\x20-\x7e]+$/.test(value) && ENCODER.encode(value).length <= max); }
function fixedOrNull(value, fixed) { requireValue(value === null || value === fixed); }
function nullablePattern(value, pattern, max = 256) {
  if (value !== null) requireValue(typeof value === "string" && value.length > 0 && value.length <= max && pattern.test(value) && ENCODER.encode(value).length <= max);
}

function canonicalPath(value, source = false) {
  requireValue(typeof value === "string" && value.length > 0 && value.length <= 4096 && value.isWellFormed() && ENCODER.encode(value).length <= 4096);
  requireValue(!value.startsWith("/") && !/^[A-Za-z]:/.test(value) && !value.includes("\\") && !value.endsWith("/") && !value.includes("//") && !/[\p{Cc}]/u.test(value));
  const segments = value.split("/");
  requireValue(segments.every((segment) => segment !== "." && segment !== ".." && segment.normalize("NFC") === segment));
  if (source) requireValue(/\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts)$/i.test(segments.at(-1)));
}

function compareUtf8(left, right) {
  const a = ENCODER.encode(left);
  const b = ENCODER.encode(right);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}

function hash(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function canonicalBytes(value) { return ENCODER.encode(`${JSON.stringify(value)}\n`); }
function equalBytes(left, right) {
  const leftLength = TYPED_ARRAY_BYTE_LENGTH.call(left);
  const rightLength = TYPED_ARRAY_BYTE_LENGTH.call(right);
  if (leftLength !== rightLength) return false;
  for (let index = 0; index < leftLength; index += 1) if (left[index] !== right[index]) return false;
  return true;
}

function validateBindingValue(value) {
  exactObject(value, BINDING_KEYS);
  sha256(value.issueBodySha256);
  requireValue(value.issueBodySha256 === PARENT_DIGEST);
  gitId(value.eventSha);
}

function validateEnvelope(envelope, kind) {
  exactObject(envelope, ENVELOPE_KEYS);
  requireValue(envelope.schemaVersion === 1 && envelope.kind === kind);
  oneOf(envelope.status, ["pass", "fail", "not-run"]);
  if (envelope.status === "pass") requireValue(envelope.reason === "none");
  if (envelope.status === "not-run") requireValue(envelope.reason === "blocked");
  if (envelope.status === "fail" && kind !== "requests" && kind !== "lifecycle") oneOf(envelope.reason, FAIL_REASONS[kind]);
  exactObject(envelope.data, DATA_KEYS[kind]);
}

function requireNotRunData(data) {
  for (const value of Object.values(data)) {
    if (Array.isArray(value)) requireValue(value.length === 0);
    else requireValue(value === null);
  }
}

function validateArtifactFile(record) {
  exactObject(record, ["path", "expectedMediaType", "observedMediaType", "expectedBytes", "observedBytes", "expectedSha256", "observedSha256", "match"]);
  canonicalPath(record.path);
  requireValue(typeof record.expectedMediaType === "string" && record.expectedMediaType.length <= 256
    && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(record.expectedMediaType) && ENCODER.encode(record.expectedMediaType).length <= 256);
  requireValue(typeof record.observedMediaType === "string" && record.observedMediaType.length <= 256
    && /^ *[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+ *(?:; *[A-Za-z0-9!#$&^_.+-]+=(?:[A-Za-z0-9!#$&^_.+*-]+|"[\x20-\x21\x23-\x7e]*") *)*$/.test(record.observedMediaType));
  nullable(record.expectedBytes, count); nullable(record.observedBytes, count);
  nullable(record.expectedSha256, sha256); nullable(record.observedSha256, sha256); nullableBoolean(record.match);
  const normalized = record.observedMediaType.split(";", 1)[0].trim().toLowerCase();
  const complete = record.expectedBytes !== null && record.observedBytes !== null && record.expectedSha256 !== null && record.observedSha256 !== null;
  const derived = complete && normalized === record.expectedMediaType
    && record.expectedBytes === record.observedBytes
    && record.expectedSha256 === record.observedSha256;
  requireValue(complete ? record.match === derived : record.match === null);
}

function validateArtifact(envelope) {
  const data = envelope.data;
  if (envelope.status === "not-run") reject();
  sha256(data.issueBodySha256); nullable(data.eventSha, gitId); fixedOrNull(data.repository, REPOSITORY);
  nullable(data.runId, positiveCount); nullable(data.runAttempt, positiveCount); fixedOrNull(data.origin, ORIGIN);
  nullable(data.manifestSha256, sha256); nullable(data.publicationRecordSha256, sha256);
  nullable(data.deploymentId, positiveCount); nullable(data.deployedSha, gitId);
  nullablePattern(data.nodeVersion, /^v24\.\d+\.\d+$/);
  nullablePattern(data.chromeVersion, /^\d+\.\d+\.\d+\.\d+$/);
  if (data.chromeExecutableCategory !== null) oneOf(data.chromeExecutableCategory, ["windows-program-files", "linux-path", "macos-application"]);
  if (data.runnerOs !== null) oneOf(data.runnerOs, ["Linux", "Windows", "macOS"]);
  if (data.runnerArch !== null) oneOf(data.runnerArch, ["X64", "ARM64"]);
  nullableBoolean(data.policyMatched);
  exactArray(data.files, 32); data.files.forEach(validateArtifactFile);
  for (let index = 1; index < data.files.length; index += 1) requireValue(compareUtf8(data.files[index - 1].path, data.files[index].path) < 0);
  requireValue(data.issueBodySha256 === PARENT_DIGEST);
  if (envelope.status === "pass") {
    for (const [key, value] of Object.entries(data)) if (key !== "files") requireValue(value !== null);
    requireValue(data.eventSha === data.deployedSha && data.files.length > 0 && data.policyMatched === true && data.files.every((file) => file.match === true));
  }
}

function validateSmoke(envelope) {
  const data = envelope.data;
  if (envelope.status === "not-run") { requireNotRunData(data); return; }
  fixedOrNull(data.repositoryUrl, CODE_CITY_URL); nullable(data.revision, gitId); nullable(data.rootTree, gitId);
  fixedOrNull(data.terminal, "success"); nullable(data.canvasCount, count); nullable(data.modelSha256, sha256);
  nullable(data.startedMs, milliseconds); nullable(data.endedMs, milliseconds); nullable(data.providerGetCount, count);
  if (data.startedMs !== null && data.endedMs !== null) requireValue(data.endedMs >= data.startedMs);
  if (envelope.status === "pass") {
    requireValue(Object.values(data).every((value) => value !== null));
    requireValue(data.terminal === "success" && data.canvasCount === 1 && data.providerGetCount >= 4);
  }
}

function validateCandidate(record, index, prior) {
  exactObject(record, ["index", "path", "blobId", "normalizedBytes", "runningAggregate", "hashMatched", "contentValid"]);
  requireValue(record.index === index + 1); canonicalPath(record.path, true); gitId(record.blobId);
  count(record.normalizedBytes); count(record.runningAggregate); boolean(record.hashMatched); boolean(record.contentValid);
  requireValue(record.normalizedBytes <= 2 * 1024 * 1024 && record.runningAggregate === prior + record.normalizedBytes && record.runningAggregate <= 40 * 1024 * 1024);
  return record.runningAggregate;
}

function validateCandidates(value) {
  exactArray(value, 4001);
  let aggregate = 0;
  for (let index = 0; index < value.length; index += 1) {
    aggregate = validateCandidate(value[index], index, aggregate);
    if (index > 0) requireValue(compareUtf8(value[index - 1].path, value[index].path) < 0);
  }
}

function validateQualification(envelope) {
  const data = envelope.data;
  if (envelope.status === "not-run") { requireNotRunData(data); return; }
  fixedOrNull(data.repositoryUrl, REACT_URL); nullable(data.revision, gitId); nullable(data.rootTree, gitId);
  nullable(data.treeEntries, count); nullableBoolean(data.truncated); validateCandidates(data.candidates);
  if (data.revision !== null && data.rootTree !== null) requireValue(data.revision.length === data.rootTree.length);
  if (data.revision !== null) for (const candidate of data.candidates) requireValue(candidate.blobId.length === data.revision.length);
  if (envelope.status === "pass") {
    requireValue(data.repositoryUrl !== null && data.revision !== null && data.rootTree !== null && data.treeEntries !== null && data.truncated === false);
    requireValue(data.treeEntries >= 4001 && data.candidates.length === 4001 && data.candidates.every((candidate) => candidate.hashMatched && candidate.contentValid));
  }
}

function validateCapacity(envelope) {
  const data = envelope.data;
  if (envelope.status === "not-run") { requireNotRunData(data); return; }
  fixedOrNull(data.repositoryUrl, REACT_URL); nullable(data.revision, gitId); nullable(data.rootTree, gitId);
  fixedOrNull(data.terminal, "Repository exceeds Code City limits");
  for (const key of ["revisionDisplayed", "cityPresent", "priorCityRemoved", "noLaterRequest", "workerQuiescent"]) nullableBoolean(data[key]);
  nullable(data.rawRequestCount, count); nullable(data.maxOverlap, count); validateCandidates(data.candidates);
  nullable(data.startedMs, milliseconds); nullable(data.endedMs, milliseconds);
  if (data.startedMs !== null && data.endedMs !== null) requireValue(data.endedMs >= data.startedMs);
  if (data.revision !== null && data.rootTree !== null) requireValue(data.revision.length === data.rootTree.length);
  if (data.revision !== null) for (const candidate of data.candidates) requireValue(candidate.blobId.length === data.revision.length);
  if (envelope.status === "pass") {
    requireValue(data.repositoryUrl !== null && data.revision !== null && data.rootTree !== null && data.startedMs !== null && data.endedMs !== null);
    requireValue(data.terminal === "Repository exceeds Code City limits" && data.revisionDisplayed === true && data.cityPresent === false && data.priorCityRemoved === true);
    requireValue(data.rawRequestCount === 4001 && data.maxOverlap === 1 && data.noLaterRequest === true && data.workerQuiescent === true);
    requireValue(data.candidates.length === 4001 && data.candidates.every((candidate) => candidate.hashMatched && candidate.contentValid));
  }
}

function validateRateLimit(value) {
  exactObject(value, ["limit", "remaining", "reset"]);
  for (const key of ["limit", "remaining", "reset"]) nullable(value[key], count);
  const nullCount = [value.limit, value.remaining, value.reset].filter((item) => item === null).length;
  requireValue(nullCount === 0 || nullCount === 3);
  if (nullCount === 0) requireValue(value.remaining <= value.limit);
}

function validateRequestRecord(record, index) {
  exactObject(record, ["sequence", "stage", "method", "requestedUrl", "finalUrl", "applicationCall", "status", "startedMs", "endedMs", "headerNames", "corsAllowOrigin", "rateLimit", "authorizationAbsent", "cookieAbsent", "refererAbsent", "redirected"]);
  requireValue(record.sequence === index + 1); oneOf(record.stage, ["revision", "commit", "tree", "raw", "asset", "deployment", "issue"]); oneOf(record.method, ["GET", "OPTIONS"]);
  validateAllowedUrl(record.requestedUrl, record.stage); validateAllowedUrl(record.finalUrl, record.stage);
  boolean(record.applicationCall); requireValue(Number.isInteger(record.status) && record.status >= 100 && record.status <= 599);
  milliseconds(record.startedMs); milliseconds(record.endedMs); requireValue(record.endedMs >= record.startedMs);
  exactArray(record.headerNames, SAFE_HEADERS.length);
  let prior = "";
  for (const name of record.headerNames) {
    requireValue(typeof name === "string" && /^[a-z0-9-]+$/.test(name) && SAFE_HEADER_SET.has(name) && name > prior);
    prior = name;
  }
  requireValue(record.corsAllowOrigin === null || CORS_VALUES.has(record.corsAllowOrigin));
  requireValue(record.headerNames.includes("access-control-allow-origin") === (record.corsAllowOrigin !== null));
  validateRateLimit(record.rateLimit);
  const rateNames = ["x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset"];
  const namedRates = rateNames.filter((name) => record.headerNames.includes(name)).length;
  const hasRates = record.rateLimit.limit !== null;
  requireValue(hasRates ? namedRates === 3 : namedRates === 0);
  boolean(record.authorizationAbsent); boolean(record.cookieAbsent); boolean(record.refererAbsent); boolean(record.redirected);
  requireValue(record.redirected === (record.requestedUrl !== record.finalUrl));
  if (record.method === "OPTIONS") requireValue(record.applicationCall === false && record.stage !== "raw");
  return routeOf(record.requestedUrl, record.stage);
}

function parseRepositoryRoute(url) {
  const revision = /^https:\/\/api\.github\.com\/repos\/(FelixGeisler\/code-city|facebook\/react)\/commits\?per_page=1&page=1$/u.exec(url);
  if (revision) return { repository: revision[1], stage: "revision", identity: "" };
  const commit = /^https:\/\/api\.github\.com\/repos\/(FelixGeisler\/code-city|facebook\/react)\/git\/commits\/([0-9a-f]{40}|[0-9a-f]{64})$/u.exec(url);
  if (commit) return { repository: commit[1], stage: "commit", identity: commit[2] };
  const tree = /^https:\/\/api\.github\.com\/repos\/(FelixGeisler\/code-city|facebook\/react)\/git\/trees\/([0-9a-f]{40}|[0-9a-f]{64})\?recursive=1$/u.exec(url);
  if (tree) return { repository: tree[1], stage: "tree", identity: tree[2] };
  const raw = /^https:\/\/raw\.githubusercontent\.com\/(FelixGeisler\/code-city|facebook\/react)\/([0-9a-f]{40}|[0-9a-f]{64})\/(.+)$/u.exec(url);
  if (raw) {
    let path;
    try { path = decodeURIComponent(raw[3]); } catch { reject(); }
    canonicalPath(path, true);
    requireValue(raw[3] === path.split("/").map((segment) => encodeURIComponent(segment).replace(/[!'()*]/g, (character) => `%${character.codePointAt(0).toString(16).toUpperCase()}`)).join("/"));
    return { repository: raw[1], stage: "raw", identity: raw[2], path };
  }
  return null;
}

function routeOf(url, stage) {
  const route = parseRepositoryRoute(url);
  if (route) { requireValue(route.stage === stage); return route; }
  if (stage === "asset") {
    requireValue(url.startsWith(ORIGIN));
    let path;
    try { path = decodeURIComponent(url.slice(ORIGIN.length)); } catch { reject(); }
    canonicalPath(path);
    requireValue(url === `${ORIGIN}${path.split("/").map((segment) => encodeURIComponent(segment).replace(/[!'()*]/g, (character) => `%${character.codePointAt(0).toString(16).toUpperCase()}`)).join("/")}`);
    return { repository: "asset", stage, path };
  }
  if (stage === "deployment") {
    const list = /^https:\/\/api\.github\.com\/repos\/FelixGeisler\/code-city\/deployments\?sha=([0-9a-f]{40}|[0-9a-f]{64})&environment=github-pages&per_page=100&page=1$/u.exec(url);
    if (list) return { repository: "deployment", stage, kind: "list", identity: list[1] };
    const statuses = /^https:\/\/api\.github\.com\/repos\/FelixGeisler\/code-city\/deployments\/([1-9][0-9]{0,15})\/statuses\?per_page=100&page=1$/u.exec(url);
    if (statuses && Number.isSafeInteger(Number(statuses[1]))) return { repository: "deployment", stage, kind: "statuses", deploymentId: Number(statuses[1]) };
    reject();
  }
  if (stage === "issue") {
    requireValue(url === "https://api.github.com/repos/FelixGeisler/code-city/issues/460");
    return { repository: "issue", stage };
  }
  reject();
}

function validateAllowedUrl(value, stage) {
  requireValue(typeof value === "string" && value.length <= 8192 && value.isWellFormed() && ENCODER.encode(value).length <= 8192 && !/[\p{Cc}]/u.test(value));
  let parsed;
  try { parsed = new URL(value); } catch { reject(); }
  requireValue(parsed.href === value);
  routeOf(value, stage);
}

function requestGroups(items) {
  const groups = { smoke: [], qualification: [], capacity: [], other: [] };
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const route = routeOf(item.requestedUrl, item.stage);
    let group = "other";
    if (route.repository === REPOSITORY) group = "smoke";
    else if (route.repository === "facebook/react") {
      if (item.method === "OPTIONS") {
        const next = items[index + 1];
        requireValue(next && next.method === "GET" && next.requestedUrl === item.requestedUrl);
        group = next.applicationCall ? "capacity" : "qualification";
      } else group = item.applicationCall ? "capacity" : "qualification";
    }
    groups[group].push(item);
  }
  return groups;
}

function validateDirectExchanges(items, requireSuccess) {
  const urls = new Set();
  for (const record of items) {
    const route = routeOf(record.requestedUrl, record.stage);
    requireValue(["asset", "deployment", "issue"].includes(route.repository));
    requireValue(record.method === "GET" && record.applicationCall === false && record.redirected === false && record.requestedUrl === record.finalUrl);
    requireValue(record.authorizationAbsent && record.cookieAbsent && record.refererAbsent);
    requireValue(!urls.has(record.requestedUrl));
    urls.add(record.requestedUrl);
    if (requireSuccess) requireValue(record.status === 200);
  }
}

function validateExchangeSequence(items, repository, applicationCall, complete) {
  const gets = [];
  const getUrls = new Set();
  const stages = ["revision", "commit", "tree"];
  let priorGet = -1;
  for (let index = 0; index < items.length; index += 1) {
    const record = items[index];
    const route = routeOf(record.requestedUrl, record.stage);
    requireValue(route.repository === repository && record.redirected === false && record.requestedUrl === record.finalUrl);
    if (record.method === "OPTIONS") {
      requireValue(index + 1 < items.length);
      const next = items[index + 1];
      requireValue(next.method === "GET" && next.stage === record.stage && next.requestedUrl === record.requestedUrl && stages.includes(record.stage));
      if (index > 0) requireValue(items[index - 1].method !== "OPTIONS" || items[index - 1].stage !== record.stage);
      continue;
    }
    requireValue(record.applicationCall === applicationCall && !getUrls.has(record.requestedUrl));
    getUrls.add(record.requestedUrl); gets.push(record); priorGet += 1;
    const expected = priorGet < 3 ? stages[priorGet] : "raw";
    requireValue(record.stage === expected);
    if (record.stage === "raw" && gets.length > 4) {
      const previous = routeOf(gets.at(-2).requestedUrl, "raw");
      requireValue(compareUtf8(previous.path, route.path) < 0);
    }
  }
  if (complete) requireValue(gets.length >= 4 && gets.slice(0, 3).every((item, index) => item.stage === stages[index]) && gets.slice(3).every((item) => item.stage === "raw"));
  return gets;
}

function validateGetBindings(gets, data, candidateValues, complete) {
  if (!complete) return;
  const routes = gets.map((item) => routeOf(item.requestedUrl, item.stage));
  requireValue(routes[1].identity === data.revision && routes[2].identity === data.rootTree);
  for (let index = 3; index < routes.length; index += 1) {
    requireValue(routes[index].identity === data.revision);
    if (candidateValues) requireValue(routes[index].path === candidateValues[index - 3].path);
  }
}

function maximumOverlap(items) {
  const points = [];
  for (const item of items) {
    if (item.endedMs === item.startedMs) continue;
    points.push([item.startedMs, 1], [item.endedMs, -1]);
  }
  points.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  let active = 0; let maximum = 0;
  for (const [, delta] of points) { active += delta; maximum = Math.max(maximum, active); }
  return maximum;
}

function validateRequests(envelope, payloads, overallPass, primaryReason) {
  const items = envelope.data.items;
  exactArray(items, 8200);
  const routes = [];
  for (let index = 0; index < items.length; index += 1) {
    routes.push(validateRequestRecord(items[index], index));
    if (routes[index].repository === "asset" || routes[index].repository === "deployment" || routes[index].repository === "issue") requireValue(items[index].applicationCall === false);
    if (index > 0) requireValue(items[index].startedMs >= items[index - 1].startedMs);
  }
  if (envelope.status === "pass") requireValue(overallPass && envelope.reason === "none");
  else requireValue(!overallPass && envelope.status === "fail" && envelope.reason === primaryReason);
  const groups = requestGroups(items);
  const smokePass = payloads.smoke.status === "pass";
  const qualificationPass = payloads.qualification.status === "pass";
  const capacityPass = payloads.capacity.status === "pass";
  const smokeGets = validateExchangeSequence(groups.smoke, REPOSITORY, true, smokePass);
  const qualificationGets = validateExchangeSequence(groups.qualification, "facebook/react", false, qualificationPass);
  const capacityGets = validateExchangeSequence(groups.capacity, "facebook/react", true, capacityPass);
  validateDirectExchanges(groups.other, payloads.artifact.status === "pass");
  if (smokePass) requireValue(smokeGets.length >= 4);
  if (qualificationPass) requireValue(qualificationGets.length === 4004 && qualificationGets.slice(3).length === 4001);
  if (capacityPass) requireValue(capacityGets.length === 4004 && capacityGets.slice(3).length === 4001);
  validateGetBindings(smokeGets, payloads.smoke.data, null, smokePass);
  validateGetBindings(qualificationGets, payloads.qualification.data, payloads.qualification.data.candidates, qualificationPass);
  validateGetBindings(capacityGets, payloads.capacity.data, payloads.capacity.data.candidates, capacityPass);
  const passingGroups = [...(smokePass ? groups.smoke : []), ...(qualificationPass ? groups.qualification : []), ...(capacityPass ? groups.capacity : [])];
  requireValue(passingGroups.every((item) => (item.method === "GET" ? item.status === 200 : item.status >= 200 && item.status <= 299)
    && item.redirected === false && item.authorizationAbsent && item.cookieAbsent && item.refererAbsent));
  for (const item of [...(smokePass ? groups.smoke : []), ...(capacityPass ? groups.capacity : [])]) requireValue(item.corsAllowOrigin !== null);
  const phaseOverlaps = [groups.smoke, groups.qualification, groups.capacity].map((group) => maximumOverlap(group.filter((item) => item.method === "GET")));
  if (smokePass) requireValue(phaseOverlaps[0] <= 1);
  if (qualificationPass) requireValue(phaseOverlaps[1] <= 1);
  if (capacityPass) requireValue(phaseOverlaps[2] === 1);
  const credentialFailure = items.some((item) => !item.authorizationAbsent || !item.cookieAbsent || !item.refererAbsent);
  requireValue(!credentialFailure || primaryReason === "credential-header");
  const observedOverlap = phaseOverlaps.some((overlap) => overlap > 1);
  requireValue(!observedOverlap || primaryReason === "request-overlap");
  return { groups, smokeGets, qualificationGets, capacityGets, capacityOverlap: maximumOverlap(groups.capacity.filter((item) => item.method === "GET" && item.applicationCall)) };
}

function validateDurations(value) {
  exactObject(value, ["artifact", "smoke", "qualification", "resolution", "inventory", "retrieval", "terminal", "capacity", "total"]);
  for (const key of Object.keys(value)) nullable(value[key], milliseconds);
}

function eventIndex(events, name, generation) { return events.find((event) => event.event === name && event.generation === generation); }
function difference(events, endName, endGeneration, startName, startGeneration) {
  const end = eventIndex(events, endName, endGeneration); const start = eventIndex(events, startName, startGeneration);
  return end && start ? end.atMs - start.atMs : null;
}

function derivedDurations(events) {
  return {
    artifact: difference(events, "artifact-verified", 0, "collector-start", 0),
    smoke: difference(events, "trace-reset", 0, "smoke-start", 1),
    qualification: difference(events, "qualification-complete", 0, "qualification-start", 0),
    resolution: difference(events, "revision-selected", 2, "capacity-start", 2),
    inventory: difference(events, "inventory-complete", 2, "revision-selected", 2),
    retrieval: difference(events, "limit-failure", 2, "inventory-complete", 2),
    terminal: difference(events, "worker-quiescent", 2, "limit-failure", 2),
    capacity: difference(events, "worker-quiescent", 2, "capacity-start", 2),
    total: events.length === 0 ? null : events.at(-1).atMs,
  };
}

function validateLifecycle(envelope, overallPass, primaryReason, failedStage, requestInfo) {
  const data = envelope.data;
  requireValue(envelope.status === (overallPass ? "pass" : "fail") && envelope.reason === (overallPass ? "none" : primaryReason));
  requireValue(data.collectorVersion === 1);
  nullable(data.collectorCommit, gitId);
  if (data.invocation !== null) {
    exactArray(data.invocation, 8);
    requireValue(data.invocation.length === 8 && data.invocation.every((value, index) => value === INVOCATION[index]));
  }
  nullablePattern(data.nodeVersion, /^v24\.\d+\.\d+$/);
  nullablePattern(data.chromeVersion, /^\d+\.\d+\.\d+\.\d+$/);
  if (data.cdpVersion !== null) ascii(data.cdpVersion, 32);
  exactArray(data.events, 20000);
  for (let index = 0; index < data.events.length; index += 1) {
    const event = data.events[index];
    exactObject(event, ["sequence", "generation", "event", "atMs"]);
    requireValue(event.sequence === index + 1); count(event.generation); requireValue(EVENT_NAMES.has(event.event)); milliseconds(event.atMs);
    if (index === 0) requireValue(event.event === "collector-start" && event.generation === 0 && event.atMs === 0);
    if (index > 0) requireValue(event.atMs >= data.events[index - 1].atMs);
  }
  if (overallPass) {
    requireValue(data.events.length === PASS_EVENTS.length);
    data.events.forEach((event, index) => requireValue(event.event === PASS_EVENTS[index][0] && event.generation === PASS_EVENTS[index][1]));
  } else {
    requireValue(data.events.length >= 2 && data.events.at(-1).event === "collector-failed" && data.events.at(-1).generation === 0);
    const prefix = data.events.slice(0, -1);
    prefix.forEach((event, index) => requireValue(index < PASS_EVENTS.length - 1 && event.event === PASS_EVENTS[index][0] && event.generation === PASS_EVENTS[index][1]));
    const completed = prefix.length;
    const ranges = { artifact: [1, 1], smoke: [2, 5], qualification: [6, 7], capacity: [8, 14] };
    requireValue(completed >= ranges[failedStage][0] && completed <= ranges[failedStage][1]);
  }
  validateDurations(data.durations);
  const derived = derivedDurations(data.events);
  for (const key of Object.keys(derived)) requireValue(data.durations[key] === derived[key]);
  const capacityStarted = eventIndex(data.events, "capacity-start", 2) !== undefined;
  nullable(data.maxOverlap, count);
  requireValue(capacityStarted ? data.maxOverlap === requestInfo.capacityOverlap : data.maxOverlap === null);
  for (const key of ["noRetry", "noFallback", "noPersistence", "noLaterPublication"]) {
    nullableBoolean(data[key]);
    requireValue(data[key] === null || data[key] === true);
  }
  const browserStarted = eventIndex(data.events, "smoke-start", 1) !== undefined;
  if (browserStarted) requireValue(data.chromeVersion !== null && data.cdpVersion !== null);
  if (overallPass) {
    requireValue(data.collectorCommit !== null && data.invocation !== null && data.nodeVersion !== null);
    requireValue(data.chromeVersion !== null && data.cdpVersion !== null && data.maxOverlap !== null);
    requireValue([data.noRetry, data.noFallback, data.noPersistence, data.noLaterPublication].every((value) => value === true));
    requireValue(Object.values(data.durations).every((value) => value !== null));
  }
  const total = data.durations.total;
  if (total !== null) for (const item of requestInfo.groups.smoke.concat(requestInfo.groups.qualification, requestInfo.groups.capacity, requestInfo.groups.other)) requireValue(item.endedMs <= total);
}

function deriveStatus(payloads) {
  let failed = null;
  for (let index = 0; index < 4; index += 1) {
    const kind = PAYLOAD_NAMES[index]; const envelope = payloads[kind];
    if (failed === null) {
      if (envelope.status === "fail") failed = { stage: kind, reason: envelope.reason, index };
      else requireValue(envelope.status === "pass");
    } else requireValue(envelope.status === "not-run" && envelope.reason === "blocked");
  }
  return failed ?? { stage: null, reason: "none", index: -1 };
}

function failureGroup(stage, requestInfo) {
  if (stage === "smoke") return { items: requestInfo.groups.smoke, gets: requestInfo.smokeGets, completeCount: 4 };
  if (stage === "qualification") return { items: requestInfo.groups.qualification, gets: requestInfo.qualificationGets, completeCount: 4004 };
  if (stage === "capacity") return { items: requestInfo.groups.capacity, gets: requestInfo.capacityGets, completeCount: 4004 };
  return { items: requestInfo.groups.other, gets: requestInfo.groups.other.filter((item) => item.method === "GET"), completeCount: 1 };
}

function validateFailureEvidence(payloads, failure, requestInfo, events) {
  if (failure.stage === null) return;
  const { stage, reason } = failure;
  const data = payloads[stage].data;
  const group = failureGroup(stage, requestInfo);
  const hasCredential = group.items.some((item) => !item.authorizationAbsent || !item.cookieAbsent || !item.refererAbsent);
  const hasOverlap = maximumOverlap(group.items.filter((item) => item.method === "GET")) > 1;
  const hasProviderFailure = group.items.some((item) => item.method === "GET" ? item.status !== 200 : item.status < 200 || item.status > 299);
  const hasUnexpectedRequest = group.gets.length > group.completeCount;
  const candidatesValue = stage === "qualification" || stage === "capacity" ? data.candidates : [];
  const hasHashMismatch = candidatesValue.some((candidate) => candidate.hashMatched === false);
  const hasInvalidContent = candidatesValue.some((candidate) => candidate.contentValid === false);
  const artifact = payloads.artifact.data;
  const qualification = payloads.qualification.data;
  const hasStalePublication = stage === "smoke"
    ? data.revision !== null && artifact.eventSha !== null && data.revision !== artifact.eventSha
    : stage === "capacity" && data.revision !== null && data.revision !== qualification.revision;
  const hasTreeIncomplete = stage === "qualification"
    ? data.truncated === true
    : stage === "capacity" && eventIndex(events, "inventory-complete", 2) !== undefined && data.candidates.length < 4001;
  const hasQuiescenceFailure = stage === "smoke"
    ? eventIndex(events, "city-published", 1) !== undefined
    : stage === "capacity" && (data.noLaterRequest === false || data.workerQuiescent === false);
  const hasCleanupFailure = stage === "smoke"
    ? eventIndex(events, "city-published", 1) !== undefined
    : stage === "capacity" && (data.cityPresent === true || data.priorCityRemoved === false);
  const hasStageFailure = stage === "smoke"
    ? data.canvasCount !== null && data.canvasCount !== 1
    : stage === "qualification" && data.truncated === false && data.treeEntries !== null && data.candidates.length < 4001;
  const hasArtifactMismatch = stage === "artifact" && (data.policyMatched === false || data.files.some((file) => file.match === false)
    || (data.eventSha !== null && data.deployedSha !== null && data.eventSha !== data.deployedSha));

  // #495 owns the raw runtime-to-reason mapping. Persisted facts can disprove a
  // caller-selected reason, but their absence cannot prove that a closed
  // allow-listed failure did not occur before minimization.
  if (hasCredential) requireValue(reason === "credential-header");
  if (hasOverlap) requireValue(reason === "request-overlap");
  if (stage !== "artifact" && hasProviderFailure) requireValue(reason === "provider-failure");
  if (hasHashMismatch) requireValue(reason === "hash-mismatch");
  if (hasInvalidContent) requireValue(reason === "content-invalid");
  if (hasTreeIncomplete) requireValue(reason === "tree-incomplete");
  if (hasArtifactMismatch) requireValue(reason === "artifact-mismatch");
  if (hasStalePublication) requireValue(reason === "stale-publication" || reason === "identity-mismatch");
  if (stage !== "artifact" && hasUnexpectedRequest) requireValue(reason === "unexpected-request");
  if (hasStageFailure) requireValue(reason === (stage === "smoke" ? "smoke-failure" : "qualification-failure"));
  if (hasQuiescenceFailure) requireValue(reason === "quiescence-failure" || reason === "cleanup-failure");
  if (hasCleanupFailure) requireValue(reason === "cleanup-failure" || reason === "quiescence-failure");
}

function validatePayloadSet(payloads, binding) {
  exactObject(payloads, PAYLOAD_NAMES);
  for (const kind of PAYLOAD_NAMES) validateEnvelope(payloads[kind], kind);
  validateArtifact(payloads.artifact); validateSmoke(payloads.smoke); validateQualification(payloads.qualification); validateCapacity(payloads.capacity);
  const failure = deriveStatus(payloads); const overallPass = failure.stage === null;
  const requestInfo = validateRequests(payloads.requests, payloads, overallPass, failure.reason);
  validateLifecycle(payloads.lifecycle, overallPass, failure.reason, failure.stage, requestInfo);
  const artifact = payloads.artifact.data; const lifecycle = payloads.lifecycle.data;
  requireValue(artifact.issueBodySha256 === binding.issueBodySha256);
  if (artifact.eventSha !== null) requireValue(artifact.eventSha === binding.eventSha);
  if (payloads.artifact.status === "pass") requireValue(lifecycle.collectorCommit === artifact.eventSha && artifact.eventSha === artifact.deployedSha);
  const smokeStarted = eventIndex(payloads.lifecycle.data.events, "smoke-start", 1) !== undefined;
  requireValue(smokeStarted
    ? payloads.smoke.data.providerGetCount === requestInfo.smokeGets.length
    : payloads.smoke.data.providerGetCount === null);
  if (payloads.qualification.status === "pass" && payloads.capacity.status !== "not-run") {
    const capacity = payloads.capacity.data; const qualification = payloads.qualification.data;
    const reason = payloads.capacity.reason;
    if (capacity.repositoryUrl !== null && capacity.repositoryUrl !== qualification.repositoryUrl) requireValue(reason === "identity-mismatch");
    if (capacity.revision !== null && capacity.revision !== qualification.revision) requireValue(reason === "identity-mismatch" || reason === "stale-publication");
    if (capacity.rootTree !== null && capacity.rootTree !== qualification.rootTree) requireValue(reason === "identity-mismatch");
    if (reason !== "hash-mismatch" && reason !== "content-invalid") {
      requireValue(JSON.stringify(capacity.candidates) === JSON.stringify(qualification.candidates.slice(0, capacity.candidates.length)));
    }
  }
  if (payloads.qualification.status === "pass" && payloads.capacity.status === "pass") {
    requireValue(JSON.stringify(payloads.capacity.data.candidates) === JSON.stringify(payloads.qualification.data.candidates));
  }
  const capacityStarted = eventIndex(payloads.lifecycle.data.events, "capacity-start", 2) !== undefined;
  const capacityRawCount = requestInfo.capacityGets.filter((item) => item.stage === "raw").length;
  if (capacityStarted) {
    requireValue(payloads.capacity.data.rawRequestCount === capacityRawCount);
    requireValue(payloads.capacity.data.maxOverlap === requestInfo.capacityOverlap);
  } else if (payloads.capacity.status !== "not-run") {
    requireValue(payloads.capacity.data.rawRequestCount === null && payloads.capacity.data.maxOverlap === null);
  }
  const capacityTreeRequest = requestInfo.capacityGets.find((item) => item.stage === "tree");
  const capacityRawRequests = requestInfo.capacityGets.filter((item) => item.stage === "raw");
  for (const item of requestInfo.groups.other) {
    const route = routeOf(item.requestedUrl, item.stage);
    if (route.repository === "asset") requireValue(route.path === "package-manifest.json" || artifact.files.some((file) => file.path === route.path));
  }
  if (lifecycle.collectorCommit !== null) requireValue(lifecycle.collectorCommit === binding.eventSha);
  if (artifact.nodeVersion !== null && lifecycle.nodeVersion !== null) requireValue(artifact.nodeVersion === lifecycle.nodeVersion);
  if (artifact.chromeVersion !== null && lifecycle.chromeVersion !== null) requireValue(artifact.chromeVersion === lifecycle.chromeVersion);
  const events = payloads.lifecycle.data.events;
  const finalEvent = events.at(-1);
  const artifactVerified = eventIndex(events, "artifact-verified", 0);
  const smokeStart = eventIndex(events, "smoke-start", 1);
  const smokeRevisionSelected = eventIndex(events, "revision-selected", 1);
  const cityPublished = eventIndex(events, "city-published", 1);
  const traceReset = eventIndex(events, "trace-reset", 0);
  const smokeRevisionExchanges = requestInfo.groups.smoke.filter((item) => item.stage === "revision");
  const smokeRetrievalExchanges = requestInfo.groups.smoke.filter((item) => ["commit", "tree", "raw"].includes(item.stage));
  if (payloads.smoke.data.startedMs !== null) {
    requireValue(smokeStart !== undefined && payloads.smoke.data.startedMs >= smokeStart.atMs);
    if (traceReset) requireValue(payloads.smoke.data.startedMs <= traceReset.atMs);
  }
  if (smokeRevisionSelected) {
    requireValue(smokeRevisionExchanges.every((item) => item.endedMs <= smokeRevisionSelected.atMs));
    requireValue(smokeRetrievalExchanges.every((item) => item.startedMs >= smokeRevisionSelected.atMs));
  } else requireValue(smokeRetrievalExchanges.length === 0);
  if (cityPublished) {
    requireValue(requestInfo.groups.smoke.every((item) => item.endedMs <= cityPublished.atMs));
    if (payloads.smoke.data.endedMs !== null) requireValue(payloads.smoke.data.endedMs <= cityPublished.atMs);
  }
  if (payloads.smoke.status === "pass") {
    requireValue(payloads.smoke.data.startedMs === smokeStart.atMs && payloads.smoke.data.endedMs === cityPublished.atMs);
    requireValue(payloads.smoke.data.revision === artifact.eventSha);
  }
  const capacityStart = eventIndex(events, "capacity-start", 2);
  const capacityRevisionSelected = eventIndex(events, "revision-selected", 2);
  const workerQuiescent = eventIndex(events, "worker-quiescent", 2);
  const inventoryComplete = eventIndex(events, "inventory-complete", 2);
  const limitFailure = eventIndex(events, "limit-failure", 2);
  const capacityRevisionExchanges = requestInfo.groups.capacity.filter((item) => item.stage === "revision");
  const capacityInventoryExchanges = requestInfo.groups.capacity.filter((item) => item.stage === "commit" || item.stage === "tree");
  if (payloads.capacity.status === "pass") requireValue(payloads.capacity.data.startedMs === capacityStart.atMs && payloads.capacity.data.endedMs === workerQuiescent.atMs);
  if (capacityRevisionSelected) {
    requireValue(capacityRevisionExchanges.every((item) => item.endedMs <= capacityRevisionSelected.atMs));
    requireValue(capacityInventoryExchanges.every((item) => item.startedMs >= capacityRevisionSelected.atMs));
  } else requireValue(capacityInventoryExchanges.length === 0 && capacityRawRequests.length === 0);
  if (capacityRawRequests.length > 0) requireValue(inventoryComplete !== undefined);
  if (inventoryComplete) {
    requireValue(capacityTreeRequest !== undefined && capacityInventoryExchanges.every((item) => item.endedMs <= inventoryComplete.atMs));
    if (capacityRawRequests.length > 0) requireValue(capacityRawRequests.every((item) => item.startedMs >= inventoryComplete.atMs));
  }
  if (limitFailure) {
    requireValue(capacityRawRequests.length === 4001);
    requireValue(capacityRawRequests.every((item) => item.endedMs <= limitFailure.atMs));
  }
  const stageWindows = [
    ["artifact", requestInfo.groups.other, events[0], artifactVerified],
    ["smoke", requestInfo.groups.smoke, smokeStart, eventIndex(events, "trace-reset", 0)],
    ["qualification", requestInfo.groups.qualification, eventIndex(events, "qualification-start", 0), eventIndex(events, "qualification-complete", 0)],
    ["capacity", requestInfo.groups.capacity, capacityStart, eventIndex(events, "request-quiescent", 2)],
  ];
  for (const [stage, items, start, completedEnd] of stageWindows) {
    const stageEnvelope = payloads[stage];
    if (stageEnvelope.status === "not-run") { requireValue(items.length === 0); continue; }
    if (!start) { requireValue(stageEnvelope.status === "fail" && items.length === 0); continue; }
    const end = stageEnvelope.status === "pass" ? completedEnd : finalEvent;
    requireValue(end);
    for (const item of items) requireValue(item.startedMs >= start.atMs && item.endedMs <= end.atMs);
  }
  const requestQuiescent = eventIndex(events, "request-quiescent", 2);
  if (requestQuiescent) {
    requireValue(payloads.requests.data.items.every((item) => item.endedMs <= requestQuiescent.atMs));
    requireValue(payloads.capacity.data.noLaterRequest === true);
  }
  for (const item of requestInfo.groups.other) {
    const route = routeOf(item.requestedUrl, item.stage);
    if (route.repository === "deployment" && route.kind === "list") requireValue(artifact.eventSha === null || route.identity === artifact.eventSha);
    if (route.repository === "deployment" && route.kind === "statuses") requireValue(artifact.deploymentId === null || route.deploymentId === artifact.deploymentId);
  }
  validateFailureEvidence(payloads, failure, requestInfo, events);
  return { overallStatus: overallPass ? "pass" : "fail", firstFailure: failure.reason };
}

function buildIndex(binding, status, payloadBytes) {
  return {
    schemaVersion: 1,
    issueBodySha256: PARENT_DIGEST,
    eventSha: binding.eventSha,
    overallStatus: status.overallStatus,
    firstFailure: status.firstFailure,
    files: INDEX_ORDER.map((path) => ({ path, mediaType: MEDIA_TYPE, byteLength: payloadBytes.get(path).byteLength, sha256: hash(payloadBytes.get(path)) })),
  };
}

function createPacketInternal(payloads, binding) {
  const status = validatePayloadSet(payloads, binding);
  const bytes = new Map();
  for (const name of PAYLOAD_NAMES) {
    const path = `${name}.json`; const value = canonicalBytes(payloads[name]);
    requireValue(value.byteLength <= CAPS.get(path)); bytes.set(path, value);
  }
  const index = buildIndex(binding, status, bytes); const indexBytes = canonicalBytes(index);
  requireValue(indexBytes.byteLength <= CAPS.get("index.json")); bytes.set("index.json", indexBytes);
  return packet(binding, bytes, hash(indexBytes));
}

function packet(binding, bytes, packetDigest) {
  const copiedBinding = Object.freeze({ issueBodySha256: binding.issueBodySha256, eventSha: binding.eventSha });
  const copiedFiles = new Map(MAP_ORDER.map((path) => [path, new Uint8Array(bytes.get(path))]));
  return Object.freeze({ binding: copiedBinding, files: copiedFiles, packetDigest });
}

function parseCanonical(bytes, cap) {
  const byteLength = wholeUint8ArrayLength(bytes);
  requireValue(byteLength !== null);
  if (byteLength > cap) throw new EvidenceContractError("noncanonical-bytes");
  requireValue(!hasByteViewOverrides(bytes));
  let text; let parsed;
  try { text = DECODER.decode(bytes); parsed = JSON.parse(text); } catch { throw new EvidenceContractError("noncanonical-bytes"); }
  let canonical;
  try { canonical = canonicalBytes(parsed); } catch { throw new EvidenceContractError("noncanonical-bytes"); }
  if (!equalBytes(bytes, canonical)) throw new EvidenceContractError("noncanonical-bytes");
  return parsed;
}

function validateFilesMap(files) {
  requireValue(isObject(files) && !utilTypes.isProxy(files) && utilTypes.isMap(files) && Object.getPrototypeOf(files) === MAP_PROTOTYPE);
  requireValue(MAP_SIZE.call(files) === MAP_ORDER.length);
  requireValue(Reflect.ownKeys(files).length === 0);
  for (const path of MAP_ORDER) requireValue(MAP_HAS.call(files, path));
  for (const [path, bytes] of MAP_ENTRIES.call(files)) requireValue(MAP_ORDER.includes(path) && wholeUint8ArrayLength(bytes) !== null);
}

function validatePacketInternal(files, binding) {
  validateFilesMap(files);
  const parsed = {}; const copied = new Map();
  for (const name of PAYLOAD_NAMES) {
    const path = `${name}.json`; const source = MAP_GET.call(files, path); const value = parseCanonical(source, CAPS.get(path));
    parsed[name] = value; copied.set(path, copyBytes(source));
  }
  const status = validatePayloadSet(parsed, binding);
  const indexSource = MAP_GET.call(files, "index.json"); const index = parseCanonical(indexSource, CAPS.get("index.json"));
  exactObject(index, ["schemaVersion", "issueBodySha256", "eventSha", "overallStatus", "firstFailure", "files"]);
  requireValue(index.schemaVersion === 1 && index.issueBodySha256 === PARENT_DIGEST && index.eventSha === binding.eventSha && index.overallStatus === status.overallStatus && index.firstFailure === status.firstFailure);
  exactArray(index.files, 6);
  const expected = buildIndex(binding, status, copied);
  requireValue(JSON.stringify(index) === JSON.stringify(expected));
  copied.set("index.json", copyBytes(indexSource));
  return packet(binding, copied, hash(indexSource));
}

function validateWrapperBinding(value) {
  exactObject(value, WRAPPER_BINDING_KEYS);
  requireValue(typeof value.artifactId === "string" && /^[1-9][0-9]{0,19}$/.test(value.artifactId));
  sha256(value.platformDigest); sha256(value.packetDigest); gitId(value.eventSha); positiveCount(value.runId); positiveCount(value.runAttempt);
}

function wrapperObject(input) {
  return {
    schemaVersion: 1,
    artifactId: input.artifactId,
    artifactUrl: `https://github.com/FelixGeisler/code-city/actions/runs/${input.runId}/artifacts/${input.artifactId}`,
    platformDigest: input.platformDigest,
    packetDigest: input.packetDigest,
    eventSha: input.eventSha,
    runId: input.runId,
    runAttempt: input.runAttempt,
    retentionDays: 90,
  };
}

function validateWrapperObject(value) {
  exactObject(value, ["schemaVersion", "artifactId", "artifactUrl", "platformDigest", "packetDigest", "eventSha", "runId", "runAttempt", "retentionDays"]);
  requireValue(value.schemaVersion === 1 && value.retentionDays === 90);
  validateWrapperBinding({ artifactId: value.artifactId, platformDigest: value.platformDigest, packetDigest: value.packetDigest, eventSha: value.eventSha, runId: value.runId, runAttempt: value.runAttempt });
  requireValue(value.artifactUrl === `https://github.com/FelixGeisler/code-city/actions/runs/${value.runId}/artifacts/${value.artifactId}` && ENCODER.encode(value.artifactUrl).length <= 2048);
}

function publicFailure(error, fallback, preservedCodes = []) {
  if (error instanceof EvidenceContractError && preservedCodes.includes(error.code)) throw error;
  throw new EvidenceContractError(fallback);
}

export class EvidenceContractError extends Error {
  constructor(code) {
    if (arguments.length !== 1 || !ERROR_CODES.has(code)) throw new TypeError("invalid EvidenceContractError code");
    super(code);
    this.name = "EvidenceContractError";
    this.code = code;
  }
}

export function createEvidencePacket(payloads, binding) {
  try { validateBindingValue(binding); }
  catch (error) { publicFailure(error, "invalid-binding"); }
  try { return createPacketInternal(payloads, binding); }
  catch (error) { publicFailure(error, "invalid-payload"); }
}

export function validateEvidencePacket(files, binding) {
  try { validateBindingValue(binding); }
  catch (error) { publicFailure(error, "invalid-binding"); }
  try { return validatePacketInternal(files, binding); }
  catch (error) { publicFailure(error, "invalid-payload", ["noncanonical-bytes"]); }
}

export function createExternalWrapper(input) {
  try {
    validateWrapperBinding(input);
    const bytes = canonicalBytes(wrapperObject(input)); requireValue(bytes.byteLength <= 4096);
    return new Uint8Array(bytes);
  } catch (error) { publicFailure(error, "invalid-payload"); }
}

export function validateExternalWrapper(bytes, binding) {
  try { validateWrapperBinding(binding); }
  catch (error) { publicFailure(error, "invalid-binding"); }
  let parsed;
  try { parsed = parseCanonical(bytes, 4096); }
  catch (error) { publicFailure(error, "noncanonical-bytes", ["noncanonical-bytes"]); }
  try { validateWrapperObject(parsed); }
  catch (error) { publicFailure(error, "invalid-payload"); }
  try {
    for (const key of WRAPPER_BINDING_KEYS) if (parsed[key] !== binding[key]) throw new EvidenceContractError("invalid-binding");
    return Object.freeze(parsed);
  } catch (error) { publicFailure(error, "invalid-binding", ["invalid-binding"]); }
}
