import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify, types as utilTypes } from "node:util";

import {
  connectCdp,
  discoverInstalledChrome,
  launchInstalledChrome,
  readInstalledChromeVersion,
} from "./chrome-cdp.mjs";
import { readValidatedEvidencePacket, writeValidatedEvidencePacket } from "./evidence-packet-files.mjs";
import { parsePackageManifest } from "./package-manifest.mjs";
import { createEvidencePacket } from "./production-evidence-schema.mjs";
import { validatePublicationRecord } from "./publication-record.mjs";

const execFile = promisify(execFileCallback);
const ENCODER = new TextEncoder();
const JSON_DECODER = new TextDecoder("utf-8", { fatal: true });
const SOURCE_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export const PRODUCTION_ORIGIN = "https://felixgeisler.github.io/code-city/";
export const PARENT_ISSUE_BODY_SHA256 = "f06369b3eef5e62631ee8f61ddfd7679b00a3d2139dd83a2f6472820e62864e6";
export const COLLECTOR_INVOCATION = Object.freeze([
  "node", "tools/collect-production-evidence.mjs", "--origin", "$ORIGIN",
  "--manifest", "$MANIFEST", "--output", "$OUTPUT",
]);
const CODE_CITY_REPOSITORY = "FelixGeisler/code-city";
const CODE_CITY_URL = "https://github.com/FelixGeisler/code-city";
const REACT_REPOSITORY = "facebook/react";
const REACT_URL = "https://github.com/facebook/react";
export const RESPONSE_CAPS = Object.freeze({
  revision: 1_048_576,
  deployment: 1_048_576,
  commit: 4 * 1_048_576,
  tree: 8 * 1_048_576,
  raw: 4_194_307,
});
const API_CAP = RESPONSE_CAPS.revision;
const COMMIT_CAP = RESPONSE_CAPS.commit;
const TREE_CAP = RESPONSE_CAPS.tree;
const RAW_CAP = RESPONSE_CAPS.raw;
const MAX_NORMALIZED_BYTES = 2 * 1_048_576;
const MAX_AGGREGATE_BYTES = 40 * 1_048_576;
const SAFE_HEADERS = new Set([
  "accept", "access-control-allow-origin", "cache-control", "content-type", "origin", "pragma",
  "x-github-api-version", "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset",
]);
const SOURCE_SUFFIXES = [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"];
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function invariant(condition, message = "collector invariant failed") {
  if (!condition) throw new Error(message);
}

function childIsTerminal(child) {
  return [child.exitCode, child.signalCode].some((value) => value !== null && value !== undefined);
}

export class CollectorFailure extends Error {
  constructor(stage, reason) {
    super("production evidence collection failed");
    this.name = "CollectorFailure";
    this.stage = stage;
    this.reason = reason;
  }
}

function fail(stage, reason) {
  throw new CollectorFailure(stage, reason);
}

function digest(bytes, algorithm = "sha256") {
  return createHash(algorithm).update(bytes).digest("hex");
}

function wholeBytes(value) {
  return new Uint8Array(value);
}

function ownData(value, key) {
  if (value === null || typeof value !== "object" || utilTypes.isProxy(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, "value") && descriptor.enumerable ? descriptor.value : undefined;
}

function ownString(value, key) {
  const result = ownData(value, key);
  return typeof result === "string" ? result : undefined;
}

function denseOwnArray(value, { nonempty = false } = {}) {
  if (!Array.isArray(value) || utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype
      || (nonempty && value.length === 0)) return undefined;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || keys.at(-1) !== "length") return undefined;
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (keys[index] !== String(index) || !descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) return undefined;
  }
  return value;
}

function strictJson(bytes) {
  return JSON.parse(JSON_DECODER.decode(bytes));
}

function encodePath(value) {
  return value.split("/").map((segment) => encodeURIComponent(segment).replace(/[!'()*]/gu, (character) => (
    `%${character.codePointAt(0).toString(16).toUpperCase()}`
  ))).join("/");
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
function rawUrl(repository, revision, rawPath) {
  return `https://raw.githubusercontent.com/${repository}/${revision}/${encodePath(rawPath)}`;
}
function deploymentListUrl(eventSha) {
  return `https://api.github.com/repos/FelixGeisler/code-city/deployments?sha=${eventSha}&environment=github-pages&per_page=100&page=1`;
}
function deploymentStatusesUrl(id) {
  return `https://api.github.com/repos/FelixGeisler/code-city/deployments/${id}/statuses?per_page=100&page=1`;
}

export function parseCollectorArguments(args) {
  invariant(Array.isArray(args), "collector arguments must be an array");
  if (args.length !== 6
      || args[0] !== "--origin" || args[2] !== "--manifest" || args[4] !== "--output"
      || args[1] !== PRODUCTION_ORIGIN
      || typeof args[3] !== "string" || args[3].length === 0 || args[3].startsWith("-")
      || typeof args[5] !== "string" || args[5].length === 0 || args[5].startsWith("-")) {
    throw new Error("invalid collector invocation");
  }
  return Object.freeze({
    origin: args[1],
    manifestPath: path.resolve(args[3]),
    output: path.resolve(args[5]),
  });
}

function requestHeaderProjection(requestHeaders) {
  const requestNames = Object.keys(requestHeaders).map((name) => name.toLowerCase());
  return Object.freeze({
    headerNames: [...new Set(requestNames.filter((name) => SAFE_HEADERS.has(name)))].sort(),
    authorizationAbsent: !requestNames.includes("authorization"),
    cookieAbsent: !requestNames.includes("cookie"),
    refererAbsent: !requestNames.includes("referer"),
  });
}

function responseHeaderProjection(responseHeaders) {
  const responseNames = [...responseHeaders.keys()].map((name) => name.toLowerCase());
  const cors = responseHeaders.get("access-control-allow-origin");
  const corsAllowOrigin = cors === "*" || cors === "https://felixgeisler.github.io" ? cors : null;
  const rateValues = ["x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset"].map((name) => responseHeaders.get(name));
  let rateLimit = { limit: null, remaining: null, reset: null };
  if (rateValues.every((value) => value !== null)) {
    const values = rateValues.map((value) => Number(value));
    if (values.every((value) => Number.isSafeInteger(value) && value >= 0) && values[1] <= values[0]) {
      rateLimit = { limit: values[0], remaining: values[1], reset: values[2] };
    }
  }
  return Object.freeze({
    headerNames: [...new Set(responseNames.filter((name) => SAFE_HEADERS.has(name)))].sort(),
    corsAllowOrigin,
    rateLimit: Object.freeze(rateLimit),
  });
}

function mergeHeaderFacts(requestFacts, responseFacts) {
  return {
    headerNames: [...new Set([...requestFacts.headerNames, ...responseFacts.headerNames])].sort(),
    corsAllowOrigin: responseFacts.corsAllowOrigin,
    rateLimit: responseFacts.rateLimit,
    authorizationAbsent: requestFacts.authorizationAbsent,
    cookieAbsent: requestFacts.cookieAbsent,
    refererAbsent: requestFacts.refererAbsent,
  };
}

export function safeHeaderFacts(requestHeaders, responseHeaders) {
  return mergeHeaderFacts(requestHeaderProjection(requestHeaders), responseHeaderProjection(responseHeaders));
}

function cdpResponseProjection(response) {
  invariant(response && typeof response === "object", "browser response is malformed");
  const rawHeaders = response.headers;
  invariant(rawHeaders && typeof rawHeaders === "object", "browser response headers are malformed");
  const safeHeaders = new Headers();
  for (const name of Object.keys(rawHeaders)) {
    const normalized = name.toLowerCase();
    if (!SAFE_HEADERS.has(normalized)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(rawHeaders, name);
    invariant(descriptor && Object.hasOwn(descriptor, "value") && descriptor.enumerable,
      "browser response headers are malformed");
    safeHeaders.append(name, String(descriptor.value));
  }
  return Object.freeze({
    url: ownString(response, "url"),
    status: ownData(response, "status"),
    fromDiskCache: ownData(response, "fromDiskCache") === true,
    fromServiceWorker: ownData(response, "fromServiceWorker") === true,
    headerFacts: responseHeaderProjection(safeHeaders),
  });
}

async function releaseResponse(response) {
  if (!response.body) return;
  try { await response.body.cancel(); } catch {}
}

export async function readBoundedResponseBody(response, cap, { signal } = {}) {
  invariant(Number.isSafeInteger(cap) && cap >= 0, "invalid response cap");
  if (!response.body) throw new Error("response body is absent");
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  let rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(new Error("response body aborted by browser fatal"));
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (signal?.aborted) onAbort();
    for (;;) {
      const next = await (signal ? Promise.race([reader.read(), aborted]) : reader.read());
      if (next.done) break;
      if (!(next.value instanceof Uint8Array) || next.value.byteLength > cap - total) {
        await reader.cancel();
        throw new Error("response body exceeds cap");
      }
      chunks.push(next.value);
      total += next.value.byteLength;
    }
  } catch (error) {
    try { await reader.cancel(); } catch {}
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function appendRequest(items, value) {
  items.push({ sequence: items.length + 1, ...value });
}

async function fixedFetch(requestUrl, {
  cap,
  stage,
  applicationCall = false,
  fetchImpl,
  now,
  requestItems,
  api = true,
  corsRequired = false,
  signal,
}) {
  const headers = api ? { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10" } : {};
  const startedMs = now();
  let response;
  try {
    response = await fetchImpl(requestUrl, {
      method: "GET",
      headers,
      credentials: "omit",
      referrer: "",
      referrerPolicy: "no-referrer",
      cache: "no-store",
      redirect: "error",
      signal,
    });
  } catch {
    if (signal?.aborted) throw new Error("request aborted by browser fatal");
    throw new Error("request failed");
  }
  const facts = safeHeaderFacts(headers, response.headers);
  let recorded = false;
  const record = () => {
    if (recorded) return;
    recorded = true;
    appendRequest(requestItems, {
      stage, method: "GET", requestedUrl: requestUrl, finalUrl: response.url || requestUrl,
      applicationCall, status: response.status, startedMs, endedMs: Math.max(startedMs, now()), ...facts,
      redirected: response.redirected || response.url !== requestUrl,
    });
  };
  if (response.status !== 200 || response.redirected || response.url !== requestUrl) {
    await releaseResponse(response);
    record();
    throw new Error("request response mismatch");
  }
  if (corsRequired && facts.corsAllowOrigin === null) {
    await releaseResponse(response);
    record();
    throw new Error("CORS mismatch");
  }
  let bytes;
  try {
    bytes = await readBoundedResponseBody(response, cap, { signal });
  } catch {
    if (signal?.aborted) throw new Error("response body aborted by browser fatal");
    record();
    throw new Error("response body mismatch");
  }
  record();
  return { bytes, response, facts };
}

function projectRevision(bytes) {
  const array = denseOwnArray(strictJson(bytes), { nonempty: true });
  const revision = array && ownString(array[0], "sha");
  invariant(revision && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(revision), "invalid revision evidence");
  return revision;
}

function projectCommit(bytes, revision) {
  const value = strictJson(bytes);
  const root = ownString(ownData(value, "tree"), "sha");
  invariant(ownString(value, "sha") === revision && root && new RegExp(`^[0-9a-f]{${revision.length}}$`, "u").test(root), "invalid commit evidence");
  return root;
}

function pathProjection(rawPath) {
  if (typeof rawPath !== "string" || !rawPath.isWellFormed() || rawPath.length === 0 || rawPath.startsWith("/")
      || /^[A-Za-z]:/u.test(rawPath) || rawPath.includes("\\") || rawPath.endsWith("/") || rawPath.includes("//")
      || /\p{Cc}/u.test(rawPath)) return undefined;
  const segments = rawPath.split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) return undefined;
  return { rawPath, canonicalPath: segments.map((segment) => segment.normalize("NFC")).join("/") };
}

function utf8Compare(left, right) {
  return Buffer.compare(ENCODER.encode(left), ENCODER.encode(right));
}

function ancestorIn(value, set) {
  for (let slash = value.lastIndexOf("/"); slash >= 0; slash = value.lastIndexOf("/", slash - 1)) {
    if (set.has(value.slice(0, slash))) return true;
  }
  return false;
}

export function projectSourceCandidates(providerEntries, selectedWidth, identityLimit = 4001) {
  const entries = denseOwnArray(providerEntries);
  invariant(entries && [40, 64].includes(selectedWidth)
    && (identityLimit === Infinity || (Number.isSafeInteger(identityLimit) && identityLimit >= 0)), "tree entries are not complete");
  const raw = new Set();
  const canonical = new Set();
  const projected = [];
  for (let providerIndex = 0; providerIndex < entries.length; providerIndex += 1) {
    const providerEntry = entries[providerIndex];
    const identity = pathProjection(ownString(providerEntry, "path"));
    const mode = ownString(providerEntry, "mode");
    const type = ownString(providerEntry, "type");
    invariant(identity && mode && type && !raw.has(identity.rawPath) && !canonical.has(identity.canonicalPath), "invalid tree entry");
    raw.add(identity.rawPath); canonical.add(identity.canonicalPath);
    projected.push({ ...identity, mode, type, providerIndex });
  }
  const boundaries = new Set(projected.filter((entry) => (entry.mode === "120000" && entry.type === "blob")
    || (entry.mode === "160000" && entry.type === "commit")).map((entry) => entry.canonicalPath));
  const regular = new Set(projected.filter((entry) => ["100644", "100755"].includes(entry.mode) && entry.type === "blob")
    .map((entry) => entry.canonicalPath));
  const candidates = [];
  for (const entry of projected) {
    if (ancestorIn(entry.canonicalPath, boundaries)) continue;
    invariant(!ancestorIn(entry.canonicalPath, regular), "tree contradicts a regular file");
    const supported = SOURCE_SUFFIXES.some((suffix) => entry.canonicalPath.slice(entry.canonicalPath.lastIndexOf("/") + 1).toLowerCase().endsWith(suffix));
    if (["100644", "100755"].includes(entry.mode) && entry.type === "blob") {
      if (supported) candidates.push(entry);
      continue;
    }
    if ((entry.mode === "040000" && entry.type === "tree") || (entry.mode === "120000" && entry.type === "blob")
        || (entry.mode === "160000" && entry.type === "commit")) continue;
    invariant(false, "tree entry kind is invalid");
  }
  candidates.sort((left, right) => utf8Compare(left.canonicalPath, right.canonicalPath));
  invariant(candidates.length > 0, "tree has no supported candidates");
  return candidates.map((entry, index) => {
    const blobId = index < identityLimit ? ownString(entries[entry.providerIndex], "sha") : null;
    if (index < identityLimit) {
      invariant(blobId && new RegExp(`^[0-9a-f]{${selectedWidth}}$`, "u").test(blobId), "candidate blob identity is invalid");
    }
    return Object.freeze({
      rawPath: entry.rawPath,
      canonicalPath: entry.canonicalPath,
      mode: entry.mode,
      type: entry.type,
      blobId,
    });
  });
}

export function candidateBlobId(candidate, selectedWidth) {
  const blobId = ownString(candidate, "blobId");
  invariant(blobId && new RegExp(`^[0-9a-f]{${selectedWidth}}$`, "u").test(blobId), "candidate blob identity is invalid");
  return blobId;
}

function projectTree(bytes, expectedRoot, selectedWidth, progress, identityLimit = 4001) {
  const value = strictJson(bytes);
  const entries = denseOwnArray(ownData(value, "tree"));
  if (progress) {
    const truncated = ownData(value, "truncated");
    progress.truncated = typeof truncated === "boolean" ? truncated : null;
    progress.treeEntries = entries?.length ?? null;
  }
  invariant(ownString(value, "sha") === expectedRoot, "tree root identity mismatch");
  invariant(ownData(value, "truncated") === false && entries, "tree evidence is incomplete");
  const treeEntries = entries.length;
  const candidates = projectSourceCandidates(entries, selectedWidth, identityLimit);
  return { treeEntries, candidates };
}

export function computeGitBlobId(bytes, width) {
  invariant(width === 40 || width === 64, "invalid Git identity width");
  const prefix = ENCODER.encode(`blob ${bytes.byteLength}\0`);
  const hash = createHash(width === 40 ? "sha1" : "sha256");
  hash.update(prefix); hash.update(bytes);
  return hash.digest("hex");
}

export function normalizeSourceBytes(bytes) {
  let source = SOURCE_DECODER.decode(bytes);
  if (source.startsWith("\uFEFF")) source = source.slice(1);
  invariant(!source.includes("\0"), "source contains NUL");
  source = source.replace(/\r\n?/gu, "\n");
  return ENCODER.encode(source).byteLength;
}

function parseTreeResponse(bytes, root, width, progress) {
  return projectTree(bytes, root, width, progress);
}

export function hasNextLinkRelation(value) {
  if (typeof value !== "string" || value.trim() === "") return false;
  for (const member of value.split(/,(?=\s*<)/u)) {
    const segments = member.split(";");
    if (!/^\s*<[^>]+>\s*$/u.test(segments.shift() ?? "")) continue;
    for (const parameter of segments) {
      const match = /^\s*rel\s*=\s*(?:"([^"]*)"|([^\s;,]+))\s*$/iu.exec(parameter);
      if (match && (match[1] ?? match[2]).split(/\s+/u).some((token) => token.toLowerCase() === "next")) return true;
    }
  }
  return false;
}

export async function verifyDeploymentBinding({ eventSha, origin, fetchImpl, now, requestItems, progress }) {
  let listBytes;
  try {
    const listResult = await fixedFetch(deploymentListUrl(eventSha), {
      cap: API_CAP, stage: "deployment", fetchImpl, now, requestItems,
    });
    listBytes = listResult.bytes;
    invariant(!hasNextLinkRelation(listResult.response.headers.get("link") ?? ""), "deployment list is paginated");
    const listResponse = strictJson(listBytes);
    const deployments = denseOwnArray(listResponse);
    invariant(deployments, "deployment list is malformed");
    const matches = [];
    for (const providerRecord of deployments) {
      const id = ownData(providerRecord, "id");
      const sha = ownString(providerRecord, "sha");
      const environment = ownString(providerRecord, "environment");
      const task = ownString(providerRecord, "task");
      invariant(Number.isSafeInteger(id) && id > 0 && sha && environment && task, "deployment record is malformed");
      if (sha === eventSha && environment === "github-pages" && task === "deploy") matches.push({ id, sha });
    }
    invariant(matches.length === 1, "deployment match is ambiguous");
    const selected = matches[0];
    if (progress) Object.assign(progress, { deploymentId: selected.id, deployedSha: selected.sha });
    const statusResult = await fixedFetch(deploymentStatusesUrl(selected.id), {
      cap: API_CAP, stage: "deployment", fetchImpl, now, requestItems,
    });
    invariant(!hasNextLinkRelation(statusResult.response.headers.get("link") ?? ""), "deployment statuses are paginated");
    const statuses = denseOwnArray(strictJson(statusResult.bytes), { nonempty: true });
    invariant(statuses, "deployment statuses are malformed");
    const values = statuses.map((record) => ({ state: ownString(record, "state"), environmentUrl: ownString(record, "environment_url") }));
    invariant(values.every((value) => value.state?.length > 0 && value.environmentUrl !== undefined), "deployment status is malformed");
    invariant(values[0].state === "success" && values[0].environmentUrl === origin
      && values.slice(1).every((value) => value.state !== "inactive"), "deployment is not active at the production origin");
    return Object.freeze({ deploymentId: selected.id, deployedSha: selected.sha });
  } catch (error) {
    if (error instanceof CollectorFailure) throw error;
    fail("artifact", "artifact-mismatch");
  }
}

export async function verifyProductionAssets({ manifest, origin, fetchImpl, now, requestItems, files = [] }) {
  try {
    for (const expected of manifest.files) {
      const requestUrl = `${origin}${encodePath(expected.path)}`;
      const result = await fixedFetch(requestUrl, {
        cap: expected.byteLength + 1, stage: "asset", fetchImpl, now, requestItems, api: false,
      });
      const observedMediaType = result.response.headers.get("content-type") ?? "application/octet-stream";
      const observedSha256 = digest(result.bytes);
      const match = result.bytes.byteLength === expected.byteLength && observedSha256 === expected.sha256
        && observedMediaType.split(";", 1)[0].trim().toLowerCase() === expected.mediaType;
      files.push({
        path: expected.path,
        expectedMediaType: expected.mediaType,
        observedMediaType,
        expectedBytes: expected.byteLength,
        observedBytes: result.bytes.byteLength,
        expectedSha256: expected.sha256,
        observedSha256,
        match,
      });
      invariant(match, "production asset mismatch");
    }
    return files;
  } catch (error) {
    if (error instanceof CollectorFailure) throw error;
    fail("artifact", /request failed/iu.test(String(error?.message)) ? "production-unreachable" : "artifact-mismatch");
  }
}

export async function qualifyRepository({ fetchImpl, now, requestItems, signal, progress = {
  repositoryUrl: REACT_URL, revision: null, rootTree: null, treeEntries: null, truncated: null, candidates: [],
} }) {
  try {
    const revisionResult = await fixedFetch(revisionUrl(REACT_REPOSITORY), {
      cap: API_CAP, stage: "revision", fetchImpl, now, requestItems, corsRequired: true, signal,
    });
    const revision = projectRevision(revisionResult.bytes);
    progress.revision = revision;
    const commitResult = await fixedFetch(commitUrl(REACT_REPOSITORY, revision), {
      cap: COMMIT_CAP, stage: "commit", fetchImpl, now, requestItems, corsRequired: true, signal,
    });
    const rootTree = projectCommit(commitResult.bytes, revision);
    progress.rootTree = rootTree;
    const treeResult = await fixedFetch(treeUrl(REACT_REPOSITORY, rootTree), {
      cap: TREE_CAP, stage: "tree", fetchImpl, now, requestItems, corsRequired: true, signal,
    });
    const tree = parseTreeResponse(treeResult.bytes, rootTree, revision.length, progress);
    invariant(tree.candidates.length >= 4001, "qualification has fewer than 4,001 candidates");
    let aggregate = 0;
    for (let offset = 0; offset < 4001; offset += 1) {
      const expected = tree.candidates[offset];
      const expectedBlob = candidateBlobId(expected, revision.length);
      const result = await fixedFetch(rawUrl(REACT_REPOSITORY, revision, expected.rawPath), {
        cap: RAW_CAP, stage: "raw", fetchImpl, now, requestItems, api: false, corsRequired: true, signal,
      });
      const actualBlob = computeGitBlobId(result.bytes, revision.length);
      let normalizedBytes;
      try { normalizedBytes = normalizeSourceBytes(result.bytes); }
      catch { throw new Error("candidate content is invalid"); }
      const nextAggregate = aggregate + normalizedBytes;
      const hashMatched = actualBlob === expectedBlob;
      const contentValid = normalizedBytes <= MAX_NORMALIZED_BYTES && nextAggregate <= MAX_AGGREGATE_BYTES;
      if (contentValid) {
        progress.candidates.push({
          index: offset + 1,
          path: expected.canonicalPath,
          blobId: expectedBlob,
          normalizedBytes,
          runningAggregate: nextAggregate,
          hashMatched,
          contentValid: true,
        });
        aggregate = nextAggregate;
      }
      invariant(contentValid, "candidate content exceeds qualification bounds");
      invariant(hashMatched, "candidate blob hash differs");
    }
    return Object.freeze(progress);
  } catch (error) {
    if (error instanceof CollectorFailure) throw error;
    const message = String(error?.message);
    if (/browser fatal|aborted/iu.test(message) || signal?.aborted) fail("qualification", "infrastructure-failure");
    if (/CORS/iu.test(message)) fail("qualification", "cors-failure");
    if (/blob hash/iu.test(message)) fail("qualification", "hash-mismatch");
    if (/UTF-8|NUL|content/iu.test(message)) fail("qualification", "content-invalid");
    if (/tree evidence is incomplete/iu.test(message)) fail("qualification", "tree-incomplete");
    if (/invalid (?:revision|commit) evidence|root identity|identity mismatch/iu.test(message)) fail("qualification", "identity-mismatch");
    if (/request|response|fetch/iu.test(message)) fail("qualification", "provider-failure");
    fail("qualification", "qualification-failure");
  }
}

export function computeModelSha256(model) {
  invariant(model && Number.isSafeInteger(model.count) && model.count >= 0 && model.count <= 0xffff_ffff, "model count is invalid");
  const count = new Uint8Array(4);
  new DataView(count.buffer).setUint32(0, model.count, true);
  const hash = createHash("sha256");
  hash.update(count);
  for (const key of ["origins", "sizes", "rgba", "bounds"]) {
    const view = model[key];
    invariant(ArrayBuffer.isView(view), "model view is invalid");
    hash.update(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  }
  return hash.digest("hex");
}

export function createWorkerObserverSource(bindingName = "__codeCityCollectorEvidence") {
  invariant(/^__[A-Za-z0-9]+$/u.test(bindingName), "invalid CDP binding name");
  return `(() => {
    "use strict";
    const emit = globalThis[${JSON.stringify(bindingName)}];
    const NativeWorker = globalThis.Worker;
    const nativeAdd = NativeWorker.prototype.addEventListener;
    const nativeObjectPrototype = Object.prototype;
    const getPrototypeOf = Object.getPrototypeOf;
    const getOwnPropertyDescriptors = Object.getOwnPropertyDescriptors;
    const ownKeys = Reflect.ownKeys;
    const malformedObservation = '{"malformed":true}';
    const K = [
      0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
      0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
      0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
      0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
      0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
      0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
      0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
      0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
    ];
    const rotr = (x, n) => (x >>> n) | (x << (32 - n));
    function modelDigest(model) {
      if (!model || !Number.isSafeInteger(model.count) || model.count < 0 || model.count > 0xffffffff) throw 0;
      const h = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
      const block = new Uint8Array(64); const words = new Uint32Array(64); let used = 0; let length = 0;
      function compress() {
        for (let i=0;i<16;i++) words[i]=((block[i*4]<<24)|(block[i*4+1]<<16)|(block[i*4+2]<<8)|block[i*4+3])>>>0;
        for (let i=16;i<64;i++) { const a=words[i-15],b=words[i-2]; const s0=rotr(a,7)^rotr(a,18)^(a>>>3); const s1=rotr(b,17)^rotr(b,19)^(b>>>10); words[i]=(words[i-16]+s0+words[i-7]+s1)>>>0; }
        let [a,b,c,d,e,f,g,z]=h;
        for (let i=0;i<64;i++) { const s1=rotr(e,6)^rotr(e,11)^rotr(e,25); const ch=(e&f)^(~e&g); const t1=(z+s1+ch+K[i]+words[i])>>>0; const s0=rotr(a,2)^rotr(a,13)^rotr(a,22); const maj=(a&b)^(a&c)^(b&c); const t2=(s0+maj)>>>0; z=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0; }
        h[0]=(h[0]+a)>>>0;h[1]=(h[1]+b)>>>0;h[2]=(h[2]+c)>>>0;h[3]=(h[3]+d)>>>0;h[4]=(h[4]+e)>>>0;h[5]=(h[5]+f)>>>0;h[6]=(h[6]+g)>>>0;h[7]=(h[7]+z)>>>0;
      }
      function byte(value) { block[used++]=value; length++; if(used===64){compress();used=0;} }
      const count=model.count>>>0; byte(count&255);byte((count>>>8)&255);byte((count>>>16)&255);byte((count>>>24)&255);
      for (const key of ["origins","sizes","rgba","bounds"]) { const view=model[key]; if(!ArrayBuffer.isView(view))throw 0; const bytes=new Uint8Array(view.buffer,view.byteOffset,view.byteLength); for(let i=0;i<bytes.byteLength;i++)byte(bytes[i]); }
      const bitLength=length*8; byte(0x80); while(used!==56)byte(0); const high=Math.floor(bitLength/0x100000000); const low=bitLength>>>0;
      for(let shift=24;shift>=0;shift-=8)byte((high>>>shift)&255); for(let shift=24;shift>=0;shift-=8)byte((low>>>shift)&255);
      return h.map((word)=>word.toString(16).padStart(8,"0")).join("");
    }
    const preSelectionFailureCategories = new Set([
      "Repository unavailable for anonymous access", "Revision unavailable", "Provider/resolution failure",
    ]);
    const postSelectionFailureCategories = new Set([
      "Provider/resolution failure", "Repository exceeds Code City limits",
    ]);
    const codedFailureCombinations = new Map([
      ["No supported modules", new Set(["ADM-06", "ADM-07"])],
      ["Source admission failed", new Set(["M1-ADM-1", "M1-ADM-3", "M1-ADM-4"])],
      ["Metric processing failed", new Set(["M1-MET-1"])],
      ["City construction failed", new Set(["M1-CITY-1"])],
    ]);
    const validRevision = (value) => typeof value==="string"&&/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
    function validFailureShape(record, expected) {
      if(expected.length===3)return preSelectionFailureCategories.has(record.category);
      if(!validRevision(record.revision))return false;
      if(expected.length===4)return postSelectionFailureCategories.has(record.category);
      return codedFailureCombinations.get(record.category)?.has(record.code)===true;
    }
    function messageRecord(message) {
      if(!message || typeof message!=="object" || getPrototypeOf(message)!==nativeObjectPrototype)throw 0;
      const descriptors=getOwnPropertyDescriptors(message);
      const keys=ownKeys(descriptors);
      if(keys.some((key)=>typeof key!=="string"))throw 0;
      for(const key of keys){const descriptor=descriptors[key];if(!("value" in descriptor)||!descriptor.enumerable)throw 0;}
      const type=descriptors.type?.value;
      let expected;
      if(type==="REVISION_SELECTED")expected=["type","generation","revision"];
      else if(type==="SUCCESS")expected=["type","generation","revision","model"];
      else if(type==="FAILURE") {
        if(keys.length===3)expected=["type","generation","category"];
        else if(keys.length===4)expected=["type","generation","revision","category"];
        else if(keys.length===5)expected=["type","generation","revision","category","code"];
        else throw 0;
      } else if(type==="PROVIDER_DRAINED_STATIC_ENTERED"||type==="ATTEMPT_DRAINED")expected=["type","generation"];
      else throw 0;
      if(keys.length!==expected.length||expected.some((key)=>!descriptors[key]))throw 0;
      const record={};for(const key of expected)record[key]=descriptors[key].value;
      if(!Number.isSafeInteger(record.generation)||record.generation<=0)throw 0;
      if((type==="REVISION_SELECTED"||type==="SUCCESS")&&!validRevision(record.revision))throw 0;
      if(type==="FAILURE"&&(typeof record.category!=="string"||!validFailureShape(record,expected)))throw 0;
      return record;
    }
    function observation(message) {
      const record=messageRecord(message);
      const fact={type:record.type,generation:record.generation};
      if(typeof record.revision==="string")fact.revision=record.revision;
      if(typeof record.category==="string")fact.category=record.category;
      if(typeof record.code==="string")fact.code=record.code;
      if(record.type==="SUCCESS")fact.modelSha256=modelDigest(record.model);
      return JSON.stringify(fact);
    }
    function observe(event) {
      let payload=malformedObservation;
      try { payload=observation(event.data); } catch {}
      try { emit(payload); } catch {}
    }
    function ObservedWorker(...args) {
      if(!new.target)throw new TypeError("Worker constructor requires new");
      const worker=Reflect.construct(NativeWorker,args,NativeWorker);
      nativeAdd.call(worker,"message",observe);
      return worker;
    }
    Object.setPrototypeOf(ObservedWorker,NativeWorker);
    Object.defineProperty(ObservedWorker,"prototype",{value:NativeWorker.prototype,writable:false});
    Object.defineProperty(globalThis,"Worker",{value:ObservedWorker,writable:true,configurable:true});
  })();`;
}

function browserRoute(url, repository) {
  if (url === revisionUrl(repository)) return { stage: "revision" };
  let match = new RegExp(`^https://api\\.github\\.com/repos/${repository.replace("/", "\\/")}/git/commits/([0-9a-f]{40}|[0-9a-f]{64})$`, "u").exec(url);
  if (match) return { stage: "commit", identity: match[1] };
  match = new RegExp(`^https://api\\.github\\.com/repos/${repository.replace("/", "\\/")}/git/trees/([0-9a-f]{40}|[0-9a-f]{64})\\?recursive=1$`, "u").exec(url);
  if (match) return { stage: "tree", identity: match[1] };
  const prefix = `https://raw.githubusercontent.com/${repository}/`;
  if (url.startsWith(prefix)) {
    const raw = /^([0-9a-f]{40}|[0-9a-f]{64})\/(.+)$/u.exec(url.slice(prefix.length));
    if (!raw) return null;
    let decoded;
    try { decoded = decodeURIComponent(raw[2]); } catch { return null; }
    if (raw[2] !== encodePath(decoded)) return null;
    return { stage: "raw", identity: raw[1], path: decoded };
  }
  return null;
}

export function responseCapForRoute(route) {
  const cap = RESPONSE_CAPS[route?.stage];
  invariant(Number.isSafeInteger(cap), "browser route cap is invalid");
  return cap;
}

export function recordCdpTransferSize(entry, { dataLength = 0 } = {}) {
  invariant(Number.isFinite(dataLength) && dataLength >= 0, "browser transfer size is invalid");
  entry.dataLength = (entry.dataLength ?? 0) + dataLength;
  invariant(entry.dataLength <= entry.cap, "browser response body exceeds cap before retrieval");
}

async function cdpBody(cdp, sessionId, requestId, cap) {
  const value = await cdp.send("Network.getResponseBody", { requestId }, sessionId);
  invariant(value && typeof value.body === "string" && typeof value.base64Encoded === "boolean", "browser response body is malformed");
  const bytes = value.base64Encoded ? Uint8Array.from(Buffer.from(value.body, "base64")) : ENCODER.encode(value.body);
  invariant(bytes.byteLength <= cap, "browser response body exceeds cap");
  return bytes;
}

async function evaluate(cdp, sessionId, expression) {
  const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
  invariant(!result.exceptionDetails, "browser evaluation failed");
  return result.result.value;
}

async function waitUntil(cdp, sessionId, predicate, fatal) {
  for (;;) {
    if (fatal.value) throw fatal.value;
    const value = await evaluate(cdp, sessionId, predicate);
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function capacityUiExpression(marker) {
  return `(() => { /* ${marker} */ const hosts = [...document.querySelectorAll('[data-city]')]; return { terminal: document.querySelector('[data-status]')?.textContent ?? null, revision: document.querySelector('[data-commit]')?.textContent ?? null, hostCount: hosts.length, presentedChildCount: hosts.reduce((count, host) => count + host.childElementCount, 0), canvasCount: document.querySelectorAll('[data-city] canvas').length }; })()`;
}

export function capacityUiHasPresentation(value) {
  const presentedChildCount = ownData(value, "presentedChildCount");
  const canvasCount = ownData(value, "canvasCount");
  if (!Number.isSafeInteger(presentedChildCount) || presentedChildCount < 0
      || !Number.isSafeInteger(canvasCount) || canvasCount < 0) return null;
  return presentedChildCount > 0 || canvasCount > 0;
}

export function capacityUiIsClear(value, revision) {
  return value !== null && typeof value === "object"
    && Object.keys(value).sort().join(",") === "canvasCount,hostCount,presentedChildCount,revision,terminal"
    && ownString(value, "terminal") === "Repository exceeds Code City limits"
    && ownString(value, "revision") === revision
    && ownData(value, "hostCount") === 1
    && capacityUiHasPresentation(value) === false;
}

async function waitForClearCapacityUi(cdp, sessionId, revision, fatal) {
  for (;;) {
    if (fatal.value) throw fatal.value;
    const value = await evaluate(cdp, sessionId, capacityUiExpression("capacity-pre-detachment-state"));
    if (capacityUiIsClear(value, revision)) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export async function createBrowserEvidenceSession({
  discovery,
  chromeVersion,
  profile,
  origin,
  manifest,
  eventSha,
  now,
  requestItems,
  launchImpl = launchInstalledChrome,
  connectImpl = connectCdp,
  observeCdpVersion = () => {},
  beforeProviderProjection = async () => {},
  validateSafeTransientState = () => {},
}) {
  const launched = await launchImpl(discovery, profile);
  let cdp;
  let listener;
  let fatalListener;
  let processExitListener;
  try {
    cdp = connectImpl(launched.websocketUrl);
    const version = await cdp.send("Browser.getVersion");
    invariant(version.product === `Chrome/${chromeVersion}` && typeof version.protocolVersion === "string", "Chrome/CDP version mismatch");
    observeCdpVersion(version.protocolVersion);
    const bindingName = "__codeCityCollectorEvidence";
    const facts = [];
    const factWaiters = [];
    const factReceiptTimes = new WeakMap();
    const detachWaiters = [];
    const fatal = { value: null };
    const fatalController = new AbortController();
    const network = new Map();
    const correlations = new Map();
    const workerTargets = new Map();
    const workerReady = new Map();
    const detachedWorkers = new Set();
    let pageSessionId;
    const allowedAssets = new Set(manifest.files.map((file) => `${origin}${encodePath(file.path)}`));
    allowedAssets.add(origin);
    let mode = null;
    let processing = Promise.resolve();
    let networkEventOrder = 0;
    let traceStarted = false;
    let closePromise;

    const preSelectionFailureCategories = new Set([
      "Repository unavailable for anonymous access", "Revision unavailable", "Provider/resolution failure",
    ]);
    const postSelectionFailureCategories = new Set([
      "Provider/resolution failure", "Repository exceeds Code City limits",
    ]);
    const codedFailureCombinations = new Map([
      ["No supported modules", new Set(["ADM-06", "ADM-07"])],
      ["Source admission failed", new Set(["M1-ADM-1", "M1-ADM-3", "M1-ADM-4"])],
      ["Metric processing failed", new Set(["M1-MET-1"])],
      ["City construction failed", new Set(["M1-CITY-1"])],
    ]);
    function projectFact(value) {
      invariant(value && typeof value === "object" && !Array.isArray(value), "worker observation is malformed");
      const type = ownString(value, "type");
      const generation = ownData(value, "generation");
      invariant(type && Number.isSafeInteger(generation) && generation > 0, "worker observation is malformed");
      const keys = Object.keys(value).sort();
      const exactKeys = (expected) => invariant(keys.length === expected.length
        && keys.every((key, index) => key === [...expected].sort()[index]), "worker observation is malformed");
      if (type === "REVISION_SELECTED") {
        exactKeys(["type", "generation", "revision"]);
        const revision = ownString(value, "revision");
        invariant(revision && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(revision), "worker observation is malformed");
        return { type, generation, revision };
      }
      if (type === "SUCCESS") {
        exactKeys(["type", "generation", "revision", "modelSha256"]);
        const revision = ownString(value, "revision");
        const modelSha256 = ownString(value, "modelSha256");
        invariant(revision && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(revision)
          && modelSha256 && /^[0-9a-f]{64}$/u.test(modelSha256), "worker terminal is malformed");
        return { type, generation, revision, modelSha256 };
      }
      if (type === "FAILURE") {
        const category = ownString(value, "category");
        if (keys.length === 3) {
          exactKeys(["type", "generation", "category"]);
          invariant(category && preSelectionFailureCategories.has(category), "worker terminal is malformed");
          return { type, generation, category };
        }
        const revision = ownString(value, "revision");
        invariant(revision && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(revision), "worker terminal is malformed");
        if (keys.length === 4) {
          exactKeys(["type", "generation", "revision", "category"]);
          invariant(category && postSelectionFailureCategories.has(category), "worker terminal is malformed");
          return { type, generation, revision, category };
        }
        exactKeys(["type", "generation", "revision", "category", "code"]);
        const code = ownString(value, "code");
        invariant(category && code && codedFailureCombinations.get(category)?.has(code) === true,
          "worker terminal is malformed");
        return { type, generation, revision, category, code };
      }
      if (type === "PROVIDER_DRAINED_STATIC_ENTERED" || type === "ATTEMPT_DRAINED") {
        exactKeys(["type", "generation"]);
        return { type, generation };
      }
      return null;
    }
    function publishFact(fact, ...causalTimes) {
      const current = mode && fact.generation === mode.generation ? mode : null;
      fact.observedAtMs = Math.max(
        factReceiptTimes.get(fact) ?? now(), current?.lastPublishedFactAtMs ?? 0,
        current?.lastPublishedLifecycleAtMs ?? 0, ...causalTimes,
      );
      if (current) current.lastPublishedFactAtMs = fact.observedAtMs;
      facts.push(fact);
      for (const waiter of [...factWaiters]) {
        if (waiter.predicate(fact)) {
          factWaiters.splice(factWaiters.indexOf(waiter), 1);
          waiter.resolve(fact);
        }
      }
    }
    function nextFact(predicate) {
      if (fatal.value) return Promise.reject(fatal.value);
      const found = facts.find(predicate);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => factWaiters.push({ predicate, resolve, reject }));
    }
    function settleDeferred(deferred, kind, value) {
      if (!deferred || deferred.settled) return false;
      deferred.settled = true;
      deferred[kind](value);
      return true;
    }
    function deferredResult() {
      const result = { settled: false };
      result.promise = new Promise((resolve, reject) => Object.assign(result, { resolve, reject }));
      void result.promise.catch(() => {});
      return result;
    }
    function setFatal(error) {
      if (fatal.value) return;
      fatal.value = error instanceof Error ? error : new Error("browser observation failed");
      if (mode) {
        mode.providerAdmissionClosed = true;
        settleDeferred(mode.revisionReadiness, "reject", fatal.value);
        settleDeferred(mode.selectionResult, "reject", fatal.value);
        settleDeferred(mode.terminalResult, "reject", fatal.value);
      }
      for (const entry of network.values()) entry.bodyPromise = null;
      network.clear();
      correlations.clear();
      workerTargets.clear();
      workerReady.clear();
      detachedWorkers.clear();
      fatalController.abort(fatal.value);
      for (const waiter of factWaiters.splice(0)) waiter.reject(fatal.value);
      for (const waiter of detachWaiters.splice(0)) waiter.reject(fatal.value);
    }
    function allWorkersDetached() {
      return workerTargets.size > 0 && [...workerTargets.values()].every((targetId) => detachedWorkers.has(targetId));
    }
    function notifyDetached() {
      if (allWorkersDetached()) for (const waiter of detachWaiters.splice(0)) waiter.resolve();
    }
    async function waitForWorkerDetachment() {
      if (fatal.value) throw fatal.value;
      if (!allWorkersDetached()) await new Promise((resolve, reject) => detachWaiters.push({ resolve, reject }));
      if (fatal.value) throw fatal.value;
    }
    function enqueue(task) {
      const completion = processing.then(async () => {
        if (fatal.value) throw fatal.value;
        await task();
      });
      processing = completion.catch(setFatal);
      void completion.catch(() => {});
      return completion;
    }
    async function awaitProcessingBarrier(barrier) {
      if (barrier) await barrier;
      for (;;) {
        const observed = processing;
        await observed;
        if (observed === processing) break;
      }
      if (fatal.value) throw fatal.value;
    }
    function flushCausalMilestones(current) {
      if (!current.causalMilestonesOpen) return;
      while (current.causalMilestones.length > 0) {
        const milestone = current.causalMilestones[0];
        const observedAtMs = Math.max(
          milestone.causalAtMs, current.lastPublishedFactAtMs, current.lastPublishedLifecycleAtMs,
        );
        const published = milestone.publish(observedAtMs);
        invariant(published && Number.isSafeInteger(published.atMs), "causal lifecycle milestone differs");
        current.lastPublishedLifecycleAtMs = Math.max(observedAtMs, published.atMs);
        current.publishedCausalMilestones.add(milestone.key);
        current.causalMilestones.shift();
      }
    }
    function recordCausalMilestone(current, key, causalAtMs, publish) {
      invariant(mode === current && Number.isSafeInteger(causalAtMs)
        && !current.publishedCausalMilestones.has(key)
        && !current.causalMilestones.some((milestone) => milestone.key === key),
      "causal lifecycle milestone differs");
      current.causalMilestones.push({ key, causalAtMs, publish });
      flushCausalMilestones(current);
    }
    function openCausalMilestones(current, priorLifecycle) {
      invariant(mode === current && current.selectedFact && !current.causalMilestonesOpen
        && priorLifecycle && Number.isSafeInteger(priorLifecycle.atMs),
      "causal lifecycle milestone differs");
      current.lastPublishedLifecycleAtMs = priorLifecycle.atMs;
      current.causalMilestonesOpen = true;
      flushCausalMilestones(current);
    }
    function providerFrontierComplete(current) {
      const expected = current.expectedProviderGets;
      return Number.isSafeInteger(expected)
        && current.admittedGets === expected
        && current.exchanges.length === expected
        && current.exchanges.every((exchange) => exchange.completed)
        && network.size === 0
        && current.wireGet === null
        && current.openExchange === null;
    }
    function maybePublishTerminal(current) {
      if (fatal.value || mode !== current || current.firstTerminal || !current.pendingTerminal
          || !current.providerClosure || !providerFrontierComplete(current)) return;
      const fact = current.pendingTerminal;
      if (Object.hasOwn(fact, "revision")) {
        if (!current.selectedFact) return;
        invariant(fact.revision === current.selectedFact.revision,
          "browser terminal revision differs from selected revision");
      } else {
        invariant(fact.type === "FAILURE" && current.selectionUnavailable,
          "pre-selection terminal differs");
      }
      flushCausalMilestones(current);
      publishFact(fact, current.latestRequestEndMs);
      current.firstTerminal = fact;
      current.pendingTerminal = null;
      settleDeferred(current.terminalResult, "resolve", fact);
      if (current.pendingDrain) {
        publishFact(current.pendingDrain);
        current.firstDrain = current.pendingDrain;
        current.pendingDrain = null;
      }
    }
    function fixSuccessProviderFrontier(current) {
      if (!current.projected) return;
      invariant(current.projected.length >= 1, "smoke tree/request cardinality mismatch");
      const expected = 3 + current.projected.length;
      if (current.derivedProviderGets !== null) {
        invariant(current.derivedProviderGets === expected, "browser provider frontier changed");
      } else {
        current.derivedProviderGets = expected;
      }
      if (current.providerClosure?.kind === "provider-drained") {
        invariant(current.admittedGets === expected, "browser provider frontier cardinality differs");
        current.expectedProviderGets = expected;
      }
      maybePublishTerminal(current);
    }
    function closeProviderAdmission(current, kind, expected) {
      invariant(!current.providerClosure, "duplicate provider closure");
      current.providerClosure = { kind };
      current.providerAdmissionClosed = true;
      if (kind === "provider-drained") {
        if (current.derivedProviderGets !== null) {
          invariant(current.admittedGets === current.derivedProviderGets,
            "browser provider frontier cardinality differs");
          current.expectedProviderGets = current.derivedProviderGets;
        }
      } else {
        invariant(Number.isSafeInteger(expected) && expected >= 0,
          "browser provider frontier is invalid");
        current.expectedProviderGets = expected;
        invariant(current.admittedGets === expected, "browser provider frontier cardinality differs");
      }
      maybePublishTerminal(current);
    }
    function resolveRevisionReadiness(current, semanticFact) {
      invariant(mode === current && semanticFact.generation === current.generation
        && semanticFact.revision === current.revision && Number.isSafeInteger(current.stageEndMs.revision),
      "revision semantic readiness differs");
      settleDeferred(current.revisionReadiness, "resolve", semanticFact);
    }
    function handleProjectedFact(fact) {
      factReceiptTimes.set(fact, now());
      const current = mode && fact.generation === mode.generation ? mode : null;
      if (!current) {
        setFatal(new Error("stale worker observation"));
        return;
      }
      try {
        if (fact.type === "REVISION_SELECTED") {
          invariant(!current.pendingSelection && !current.selectedFact && !current.selectionUnavailable,
            "duplicate or conflicting revision selection");
          current.pendingSelection = fact;
          void current.revisionReadiness.promise.then((readiness) => {
            if (fatal.value || mode !== current) return;
            invariant(readiness.type === "selected-revision" && readiness.revision === fact.revision,
              "revision selection preceded matching request completion");
            publishFact(fact, readiness.observedAtMs);
            current.selectedFact = fact;
            current.pendingSelection = null;
            settleDeferred(current.selectionResult, "resolve", fact);
            maybePublishTerminal(current);
          }).catch(setFatal);
          return;
        }
        if (fact.type === "PROVIDER_DRAINED_STATIC_ENTERED") {
          closeProviderAdmission(current, "provider-drained");
          return;
        }
        if (["SUCCESS", "FAILURE"].includes(fact.type)) {
          invariant(!current.pendingTerminal && !current.firstTerminal,
            "duplicate browser terminal");
          if (current.generation === 2) {
            invariant(fact.type === "FAILURE"
              && fact.category === "Repository exceeds Code City limits",
            "capacity terminal differs");
          }
          const hasRevision = Object.hasOwn(fact, "revision");
          if (!hasRevision) {
            invariant(fact.type === "FAILURE" && !current.pendingSelection && !current.selectedFact,
              "pre-selection terminal conflicts with revision selection");
            current.selectionUnavailable = true;
            const unavailable = Object.freeze({
              type: "selection-unavailable", generation: current.generation, category: fact.category,
            });
            settleDeferred(current.revisionReadiness, "resolve", unavailable);
            settleDeferred(current.selectionResult, "resolve", unavailable);
          } else {
            const selected = current.selectedFact ?? current.pendingSelection;
            invariant(selected && selected.revision === fact.revision,
              "browser terminal revision differs from selected revision");
          }
          current.pendingTerminal = fact;
          if (fact.type === "FAILURE") {
            const expected = fact.category === "Repository exceeds Code City limits" ? 4004 : current.admittedGets;
            closeProviderAdmission(current, fact.category === "Repository exceeds Code City limits"
              ? "limit-failure" : "failure", expected);
          }
          maybePublishTerminal(current);
          return;
        }
        if (fact.type === "ATTEMPT_DRAINED") {
          invariant((current.pendingTerminal || current.firstTerminal)
            && !current.pendingDrain && !current.firstDrain,
          current.pendingDrain || current.firstDrain
            ? "duplicate attempt drain" : "attempt drained before required terminal");
          if (current.firstTerminal) {
            publishFact(fact);
            current.firstDrain = fact;
          } else {
            current.pendingDrain = fact;
          }
          return;
        }
        throw new Error("worker observation is malformed");
      } catch (error) {
        setFatal(error);
      }
    }
    function expectedStage(current, index) {
      if (current.generation === 2 && index >= 4004) throw new Error("capacity limit ordering admitted candidate 4,002");
      return index === 0 ? "revision" : index === 1 ? "commit" : index === 2 ? "tree" : "raw";
    }
    function expectedExchange(current, entry) {
      const index = current.admittedGets;
      const stage = expectedStage(current, index);
      invariant(entry.route.stage === stage, "browser request sequence differs at admission");
      const exchange = {
        generation: current.generation, index, stage, options: null, get: null,
        sealed: false, scheduled: false, completed: false,
      };
      current.exchanges.push(exchange);
      return exchange;
    }
    function expectedRoute(current, exchange) {
      const { stage, index } = exchange;
      if (stage === "revision") return { url: revisionUrl(current.repository) };
      if (stage === "commit") {
        invariant(current.revision, "browser request sequence differs before prior projection");
        return { url: commitUrl(current.repository, current.revision), identity: current.revision };
      }
      if (stage === "tree") {
        invariant(current.rootTree, "browser request sequence differs before prior projection");
        return { url: treeUrl(current.repository, current.rootTree), identity: current.rootTree };
      }
      const expected = current.projected?.[index - 3];
      invariant(expected && current.revision, "browser request sequence differs before prior projection");
      return {
        url: rawUrl(current.repository, current.revision, expected.rawPath),
        identity: current.revision,
        path: expected.rawPath,
      };
    }
    function entryMatchesExchange(entry, exchange) {
      return entry.generation === exchange.generation && entry.route.stage === exchange.stage;
    }
    function validateProjectedRoute(current, exchange, entry) {
      const expected = expectedRoute(current, exchange);
      invariant(entry.url === expected.url && entry.route.identity === expected.identity
        && entry.route.path === expected.path, "browser request sequence differs at admission");
    }
    function requestRecord(entry, startedMs = entry.startedMs, endedMs = entry.finishedMs) {
      const headerFacts = mergeHeaderFacts(entry.requestHeaderFacts, entry.response.headerFacts);
      invariant(entry.response.status === (entry.method === "OPTIONS" ? 204 : 200)
        && entry.response.url === entry.url && !entry.response.fromDiskCache && !entry.response.fromServiceWorker, "browser response mismatch");
      invariant(headerFacts.corsAllowOrigin !== null, "browser CORS evidence is absent");
      return {
        stage: entry.route.stage, method: entry.method, requestedUrl: entry.url, finalUrl: entry.response.url,
        applicationCall: entry.method === "GET", status: entry.response.status, startedMs,
        endedMs, ...headerFacts, redirected: entry.response.url !== entry.url,
      };
    }
    function providerEntryReady(entry) {
      return Boolean(entry.finished && entry.response && entry.requestHeaderFacts
        && (entry.method !== "GET" || entry.bodyPromise));
    }
    function maybeCaptureProviderBody(entry) {
      if (entry.method !== "GET" || entry.bodyPromise || !entry.response || !entry.finished) return;
      entry.bodyPromise = cdpBody(cdp, entry.sessionId, entry.requestId, entry.cap);
      void entry.bodyPromise.catch(setFatal);
    }
    function correlationComplete(correlation) {
      if (correlation.kind === "completed") return true;
      if (correlation.kind === "provider") return correlation.entry.semanticComplete === true;
      if (correlation.kind === "asset") return Boolean(correlation.request && correlation.response && correlation.finished);
      return false;
    }
    function completedCorrelation(generation, asset = false, lateExtraSeen = false) {
      return Object.freeze({ kind: "completed", generation, asset, lateExtraSeen });
    }
    function maybeCompleteAssetCorrelation(requestId, correlation) {
      if (!correlationComplete(correlation)) return correlation;
      const completed = completedCorrelation(correlation.generation, true);
      correlations.set(requestId, completed);
      validateSafeTransientState(Object.freeze({
        kind: "asset-completed", generation: correlation.generation, correlation: completed,
      }));
      return completed;
    }
    function noteWorkerOwner(correlation, sessionId) {
      if (sessionId === pageSessionId) return;
      if (correlation.workerSession && correlation.workerSession !== sessionId) {
        throw new Error("ambiguous browser request correlation");
      }
      correlation.workerSession = sessionId;
    }
    function assertCurrentCorrelation(correlation) {
      const generation = mode?.generation ?? 0;
      invariant(correlation.generation === generation, "stale browser request correlation");
    }
    function correlationId(message) {
      const requestId = ownString(message.params, "requestId");
      invariant(requestId, "browser request correlation is malformed");
      return requestId;
    }
    function classifyAsset(requestId, url, sessionId) {
      invariant(allowedAssets.has(url), "unexpected browser asset");
      let correlation = correlations.get(requestId);
      if (!correlation) {
        correlation = { kind: "asset", generation: mode?.generation ?? 0, url, workerSession: null };
        correlations.set(requestId, correlation);
      } else if (correlation.kind === "unknown-extra") {
        assertCurrentCorrelation(correlation);
        const extraOwner = correlation.owner;
        correlation = {
          kind: "asset", generation: correlation.generation, url, workerSession: null,
          requestExtra: { owner: extraOwner },
        };
        correlations.set(requestId, correlation);
        noteWorkerOwner(correlation, extraOwner);
      } else {
        assertCurrentCorrelation(correlation);
        invariant(correlation.kind === "asset" && correlation.url === url,
          "ambiguous browser request correlation");
      }
      noteWorkerOwner(correlation, sessionId);
      return correlation;
    }
    function assertProviderExtraOwner(correlation, sessionId) {
      const entry = correlation.entry;
      invariant(sessionId === pageSessionId || sessionId === entry.sessionId,
        "unexpected browser request headers owner");
      noteWorkerOwner(correlation, sessionId);
    }
    function projectRequestExtra(params) {
      const requestHeaderFacts = requestHeaderProjection(ownData(params, "headers") ?? {});
      invariant(requestHeaderFacts.authorizationAbsent && requestHeaderFacts.cookieAbsent
        && requestHeaderFacts.refererAbsent, "credential header observed");
      return requestHeaderFacts;
    }
    function attachProviderExtra(correlation, owner, params) {
      invariant(!correlation.entry.requestHeaderFacts, "duplicate browser request headers");
      assertProviderExtraOwner(correlation, owner);
      correlation.entry.requestHeaderFacts = projectRequestExtra(params);
      maybeScheduleExchange(correlation.entry.exchange);
    }
    function admitProviderRequest(message, sessionRole) {
      const requestId = correlationId(message);
      const request = ownData(message.params, "request");
      const url = ownString(request, "url");
      const method = ownString(request, "method");
      invariant(url && method, "browser request is malformed");
      if (allowedAssets.has(url)) {
        invariant(method === "GET", "unexpected browser asset request");
        const correlation = classifyAsset(requestId, url, message.sessionId);
        invariant(!correlation.request, "duplicate browser asset request");
        correlation.request = { owner: message.sessionId };
        return maybeCompleteAssetCorrelation(requestId, correlation);
      }
      invariant(mode && !mode.providerAdmissionClosed, "unexpected browser request");
      invariant((sessionRole === "page" && method === "OPTIONS")
        || (sessionRole === "worker" && method === "GET"), "unexpected browser request role");
      const priorCorrelation = correlations.get(requestId);
      invariant(!priorCorrelation || priorCorrelation.kind === "unknown-extra",
        "redirected, reused, or duplicate browser request");
      if (priorCorrelation) assertCurrentCorrelation(priorCorrelation);
      const route = browserRoute(url, mode.repository);
      invariant(route && ["GET", "OPTIONS"].includes(method) && !(route.stage === "raw" && method === "OPTIONS"),
        "unexpected browser request");

      let exchange;
      let priorWireGet = null;
      const cdpStarted = ownData(message.params, "timestamp");
      if (method === "GET") {
        if (mode.wireGet !== null) {
          invariant(Number.isFinite(cdpStarted) && Number.isFinite(mode.wireGet.cdpStarted),
            "browser application GET overlap at admission");
          priorWireGet = mode.wireGet;
        }
        exchange = mode.openExchange?.get === null
          ? mode.openExchange : expectedExchange(mode, { route });
        invariant(exchange.get === null && entryMatchesExchange({ generation: mode.generation, route }, exchange),
          "browser request sequence differs at admission");
        if (exchange.options) invariant(exchange.options.url === url, "browser request sequence differs at admission");
      } else {
        exchange = mode.wireGet?.exchange ?? mode.openExchange ?? expectedExchange(mode, { route });
        invariant(exchange.options === null && !exchange.sealed
          && entryMatchesExchange({ generation: mode.generation, route }, exchange),
        "browser request sequence differs at admission");
        if (exchange.get) invariant(exchange.get.url === url, "browser request sequence differs at admission");
      }
      const routeCanBeValidated = route.stage === "revision"
        || (route.stage === "commit" && mode.revision)
        || (route.stage === "tree" && mode.rootTree)
        || (route.stage === "raw" && mode.revision && mode.projected?.[exchange.index - 3]);
      if (routeCanBeValidated) validateProjectedRoute(mode, exchange, { url, route });
      const entry = {
        sessionId: message.sessionId, requestId, url, method, route,
        generation: mode.generation,
        cap: responseCapForRoute(route), startedMs: now(), dataLength: 0, dataEvents: 0,
        cdpStarted: Number.isFinite(cdpStarted) ? cdpStarted : null,
        cdpFinished: null, priorWireGet,
        requestHeaderFacts: null, exchange,
      };
      const correlation = { kind: "provider", generation: mode.generation, entry, workerSession: null };
      correlations.set(requestId, correlation);
      noteWorkerOwner(correlation, message.sessionId);
      if (priorCorrelation) attachProviderExtra(correlation, priorCorrelation.owner, priorCorrelation.params);
      network.set(requestId, entry);
      if (method === "GET") {
        exchange.get = entry;
        mode.admittedGets += 1;
        mode.wireGet = entry;
      } else {
        exchange.options = entry;
      }
      mode.openExchange = exchange;
      return correlation;
    }
    async function completeLogicalExchange(exchange) {
      const current = mode;
      invariant(current && current.generation === exchange.generation && exchange.sealed
        && !exchange.completed && providerEntryReady(exchange.get)
        && (!exchange.options || providerEntryReady(exchange.options)), "browser logical exchange differs");
      validateProjectedRoute(current, exchange, exchange.get);
      const get = exchange.get;
      let semanticGetEnd;
      if (exchange.options) {
        validateProjectedRoute(current, exchange, exchange.options);
        invariant(exchange.options.url === get.url && exchange.options.finishedOrder < get.finishedOrder,
          "browser preflight completed after its GET");
        invariant(exchange.options.finishedMs <= get.finishedMs,
          "browser preflight timing differs");
        const logicalOptionsStart = Math.max(exchange.options.startedMs, current.latestRequestEndMs);
        const logicalOptionsEnd = Math.max(exchange.options.finishedMs, logicalOptionsStart);
        const logicalGetStart = Math.max(get.startedMs, logicalOptionsEnd);
        semanticGetEnd = Math.max(get.finishedMs, logicalGetStart);
        appendRequest(requestItems, requestRecord(exchange.options, logicalOptionsStart, logicalOptionsEnd));
        appendRequest(requestItems, requestRecord(get, logicalGetStart, semanticGetEnd));
      } else {
        const logicalGetStart = Math.max(get.startedMs, current.latestRequestEndMs);
        semanticGetEnd = Math.max(get.finishedMs, logicalGetStart);
        appendRequest(requestItems, requestRecord(get, logicalGetStart, semanticGetEnd));
      }
      const bodyPromise = get.bodyPromise;
      invariant(bodyPromise, "browser response body was not captured");
      const bytes = await bodyPromise;
      get.bodyPromise = null;
      await beforeProviderProjection({ stage: get.route.stage });
      invariant(mode === current, "browser trace was cleared too early");
      const semanticRecord = Object.freeze({ ...get.route });
      current.gets.push(semanticRecord);
      if (get.route.stage === "revision") {
        current.revision = projectRevision(bytes);
        current.progress.revision = current.revision;
      } else if (get.route.stage === "commit") {
        invariant(get.route.identity === current.revision, "browser commit identity mismatch");
        current.rootTree = projectCommit(bytes, current.revision);
        current.progress.rootTree = current.rootTree;
      } else if (get.route.stage === "tree") {
        invariant(get.route.identity === current.rootTree, "browser tree identity mismatch");
        const tree = projectTree(bytes, current.rootTree, current.revision.length, undefined,
          current.generation === 1 ? Infinity : 4001);
        current.treeEntries = tree.treeEntries;
        current.projected = tree.candidates;
        current.onInventory?.(semanticGetEnd);
      } else {
        const index = current.rawFacts.length;
        const expected = current.projected?.[index];
        invariant(expected && get.route.identity === current.revision && get.route.path === expected.rawPath, "browser raw sequence mismatch");
        const expectedBlob = candidateBlobId(expected, current.revision.length);
        const blobId = computeGitBlobId(bytes, current.revision.length);
        let normalizedBytes;
        try { normalizedBytes = normalizeSourceBytes(bytes); }
        catch { throw new Error("browser candidate content invalid"); }
        const nextAggregate = current.aggregate + normalizedBytes;
        const fact = {
          index: index + 1, path: expected.canonicalPath, blobId: expectedBlob, normalizedBytes,
          runningAggregate: nextAggregate, hashMatched: blobId === expectedBlob,
          contentValid: normalizedBytes <= MAX_NORMALIZED_BYTES && nextAggregate <= MAX_AGGREGATE_BYTES,
        };
        if (fact.contentValid) {
          current.rawFacts.push(fact);
          if (current.generation === 2) current.progress.candidates = current.rawFacts;
          current.aggregate = nextAggregate;
        }
        invariant(fact.contentValid, "browser candidate content invalid");
        invariant(fact.hashMatched, "browser candidate blob mismatch");
      }
      current.stageEndMs[exchange.stage] = Math.max(current.stageEndMs[exchange.stage] ?? 0, semanticGetEnd);
      current.latestRequestEndMs = Math.max(current.latestRequestEndMs, semanticGetEnd);
      const completedEntries = [exchange.options, exchange.get].filter(Boolean);
      exchange.completed = true;
      for (const entry of completedEntries) {
        entry.semanticComplete = true;
        network.delete(entry.requestId);
        correlations.set(entry.requestId, completedCorrelation(entry.generation));
      }
      exchange.options = null;
      exchange.get = null;
      Object.freeze(exchange);
      validateSafeTransientState(Object.freeze({
        kind: "provider-completed",
        generation: current.generation,
        correlations: Object.freeze(completedEntries.map((entry) => correlations.get(entry.requestId))),
        exchange,
        semanticRecordKeys: Object.freeze(Object.keys(semanticRecord).sort()),
      }));
      if (semanticRecord.stage === "revision") {
        resolveRevisionReadiness(current, Object.freeze({
          type: "selected-revision", generation: current.generation,
          revision: current.revision, observedAtMs: current.stageEndMs.revision,
        }));
      }
      if (semanticRecord.stage === "tree") fixSuccessProviderFrontier(current);
      maybePublishTerminal(current);
    }
    function maybeScheduleExchange() {
      const current = mode;
      if (!current) return;
      for (;;) {
        const exchange = current.exchanges[current.nextSemanticIndex];
        if (!exchange || !exchange.sealed || exchange.scheduled || !providerEntryReady(exchange.get)
            || (exchange.options && !providerEntryReady(exchange.options))) return;
        exchange.scheduled = true;
        current.nextSemanticIndex += 1;
        enqueue(async () => completeLogicalExchange(exchange));
      }
    }
    function assetResponse(message, requestId) {
      const response = ownData(message.params, "response");
      const url = ownString(response, "url");
      invariant(url && allowedAssets.has(url), "unexpected browser request");
      const correlation = classifyAsset(requestId, url, message.sessionId);
      invariant(!correlation.response, "duplicate browser asset response");
      correlation.response = { owner: message.sessionId };
      maybeCompleteAssetCorrelation(requestId, correlation);
    }
    function assertNetworkLifecycle(sessionRole) {
      if (!mode) invariant(!traceStarted && sessionRole === "page", "unexpected browser network event");
    }
    function closedRequestIsExactAsset(message) {
      const params = message.params;
      const requestDescriptor = params && Object.getOwnPropertyDescriptor(params, "request");
      if (!requestDescriptor || !("value" in requestDescriptor)) return false;
      const request = requestDescriptor.value;
      const urlDescriptor = request && Object.getOwnPropertyDescriptor(request, "url");
      const methodDescriptor = request && Object.getOwnPropertyDescriptor(request, "method");
      return Boolean(urlDescriptor && "value" in urlDescriptor
        && methodDescriptor && "value" in methodDescriptor
        && methodDescriptor.value === "GET" && allowedAssets.has(urlDescriptor.value));
    }
    fatalListener = setFatal;
    processExitListener = () => setFatal(new Error("Chrome process exited"));
    cdp.closeListeners?.add(fatalListener);
    launched.child.on("exit", processExitListener);

    listener = (message) => {
      if (fatal.value) return;
      if (message.method === "Runtime.bindingCalled" && message.params?.name === bindingName) {
        try {
          invariant(!mode?.workerDetachedReceipt, "worker observation followed detachment");
          const fact = projectFact(JSON.parse(message.params.payload));
          if (fact) handleProjectedFact(fact);
        } catch (error) {
          setFatal(error instanceof Error ? error : new Error("worker observation is malformed"));
        }
        return;
      }
      if (message.method === "Target.attachedToTarget" && message.params?.targetInfo?.type === "worker") {
        const childSession = message.params.sessionId;
        workerTargets.set(childSession, message.params.targetInfo.targetId);
        workerReady.set(childSession, enqueue(async () => {
          await cdp.send("Runtime.enable", {}, childSession);
          await cdp.send("Network.enable", {}, childSession);
          await cdp.send("Runtime.runIfWaitingForDebugger", {}, childSession);
        }));
        return;
      }
      if (message.method === "Target.detachedFromTarget") {
        const childSession = message.params?.sessionId;
        const targetId = message.params?.targetId ?? workerTargets.get(childSession);
        if (targetId) {
          if (detachedWorkers.has(targetId)) {
            setFatal(new Error("duplicate worker detachment"));
            return;
          }
          detachedWorkers.add(targetId);
          if (mode && workerTargets.has(childSession)) {
            if (!mode.pendingTerminal && !mode.firstTerminal) {
              setFatal(new Error("worker detached before required terminal"));
              return;
            }
            mode.workerDetachedReceipt = true;
            maybePublishTerminal(mode);
          }
        }
        notifyDetached();
        return;
      }
      if (message.method.startsWith("Network.")) {
        let sessionRole;
        if (message.sessionId === pageSessionId) {
          sessionRole = "page";
        } else {
          const targetId = workerTargets.get(message.sessionId);
          if (!targetId || detachedWorkers.has(targetId)) {
            setFatal(new Error("unexpected browser network session"));
            return;
          }
          sessionRole = "worker";
        }
        try {
          assertNetworkLifecycle(sessionRole);
          if (message.method === "Network.requestWillBeSent" && mode?.providerAdmissionClosed
              && !closedRequestIsExactAsset(message)) {
            throw new Error("unexpected browser request");
          }
        } catch (error) {
          setFatal(error);
          return;
        }
        if (message.method === "Network.responseReceivedExtraInfo") {
          if (sessionRole === "page") return;
          setFatal(new Error("unexpected browser network event"));
          return;
        }
        if (message.method === "Network.policyUpdated") {
          if (sessionRole === "page") return;
          setFatal(new Error("unexpected browser network event"));
          return;
        }
        try {
          if (message.method === "Network.loadingFailed") {
            throw new Error("browser request failed");
          }
          if (message.method === "Network.requestWillBeSentExtraInfo") {
            const requestId = correlationId(message);
            const correlation = correlations.get(requestId);
            if (!correlation) {
              invariant(!mode?.providerAdmissionClosed, "unexpected browser request headers");
              const pending = {
                kind: "unknown-extra", generation: mode?.generation ?? 0,
                owner: message.sessionId, params: message.params, workerSession: null,
              };
              noteWorkerOwner(pending, message.sessionId);
              correlations.set(requestId, pending);
              return;
            }
            assertCurrentCorrelation(correlation);
            if (correlation.kind === "asset") {
              invariant(!correlation.requestExtra, "duplicate browser asset request headers");
              noteWorkerOwner(correlation, message.sessionId);
              correlation.requestExtra = { owner: message.sessionId };
              maybeCompleteAssetCorrelation(requestId, correlation);
              return;
            }
            if (correlation.kind === "completed" && correlation.asset) {
              invariant(sessionRole === "page" && !correlation.lateExtraSeen,
                "duplicate browser asset request headers");
              const completed = completedCorrelation(correlation.generation, true, true);
              correlations.set(requestId, completed);
              validateSafeTransientState(Object.freeze({
                kind: "asset-late-extra", generation: correlation.generation, correlation: completed,
              }));
              return;
            }
            invariant(correlation.kind === "provider", "duplicate browser request headers");
            attachProviderExtra(correlation, message.sessionId, message.params);
            return;
          }
          if (message.method === "Network.requestWillBeSent") {
            admitProviderRequest(message, sessionRole);
            return;
          }
          if (message.method === "Network.responseReceived") {
            const requestId = correlationId(message);
            const correlation = correlations.get(requestId);
            if (!correlation || correlation.kind === "asset") {
              assetResponse(message, requestId);
              return;
            }
            invariant(correlation.kind === "provider", "unmatched browser request fragment");
            assertCurrentCorrelation(correlation);
            const entry = correlation.entry;
            invariant((entry.method === "GET" && sessionRole === "worker" && message.sessionId === entry.sessionId)
              || (entry.method === "OPTIONS" && sessionRole === "page" && message.sessionId === entry.sessionId),
            "unexpected browser response owner");
            invariant(!entry.response, "duplicate browser response");
            entry.response = cdpResponseProjection(ownData(message.params, "response"));
            maybeCaptureProviderBody(entry);
            maybeScheduleExchange(entry.exchange);
            return;
          }
          if (message.method === "Network.dataReceived") {
            const requestId = correlationId(message);
            const correlation = correlations.get(requestId);
            invariant(correlation, "unmatched browser request fragment");
            assertCurrentCorrelation(correlation);
            noteWorkerOwner(correlation, message.sessionId);
            if (correlation.kind === "asset") {
              invariant(correlation.response && !correlation.finished, "browser asset data order differs");
              correlation.dataEvents = (correlation.dataEvents ?? 0) + 1;
              return;
            }
            invariant(correlation.kind === "provider", "unmatched browser request fragment");
            const entry = correlation.entry;
            invariant(message.sessionId === entry.sessionId && entry.response && !entry.finished,
              "browser response data order differs");
            recordCdpTransferSize(entry, message.params);
            entry.dataEvents += 1;
            return;
          }
          if (message.method === "Network.loadingFinished") {
            const requestId = correlationId(message);
            const correlation = correlations.get(requestId);
            invariant(correlation, "unmatched browser request fragment");
            assertCurrentCorrelation(correlation);
            noteWorkerOwner(correlation, message.sessionId);
            if (correlation.kind === "asset") {
              invariant(!correlation.finished && ((correlation.dataEvents ?? 0) === 0 || correlation.response),
                "browser asset finish order differs");
              correlation.finished = true;
              correlation.finishOwner = message.sessionId;
              maybeCompleteAssetCorrelation(requestId, correlation);
              return;
            }
            invariant(correlation.kind === "provider", "unmatched browser request fragment");
            const entry = correlation.entry;
            invariant(message.sessionId === entry.sessionId && !entry.finished,
              "unexpected browser finish owner");
            if (entry.dataEvents > 0) invariant(entry.response, "browser response finish order differs");
            entry.finished = true;
            entry.finishedOrder = ++networkEventOrder;
            entry.finishedMs = Math.max(entry.startedMs, now());
            const cdpFinished = ownData(message.params, "timestamp");
            entry.cdpFinished = Number.isFinite(cdpFinished) ? cdpFinished : null;
            if (entry.method === "GET") {
              const current = mode;
              invariant(current && current.generation === entry.generation,
                "browser wire request differs");
              invariant(!entry.exchange.options || entry.exchange.options.finished,
                "browser preflight completed after its GET");
              if (entry.priorWireGet?.finished) {
                invariant(Number.isFinite(entry.priorWireGet.cdpFinished)
                  && entry.priorWireGet.cdpFinished <= entry.cdpStarted,
                "browser application GET overlap at completion");
                entry.priorWireGet = null;
              }
              for (const later of current.exchanges.map((exchange) => exchange.get).filter(Boolean)) {
                if (later.priorWireGet === entry && later.finished) {
                  invariant(Number.isFinite(entry.cdpFinished)
                    && entry.cdpFinished <= later.cdpStarted,
                  "browser application GET overlap at completion");
                  later.priorWireGet = null;
                }
              }
              if (current.wireGet === entry) current.wireGet = null;
              if (current.openExchange === entry.exchange) current.openExchange = null;
              entry.exchange.sealed = true;
            }
            maybeCaptureProviderBody(entry);
            maybeScheduleExchange(entry.exchange);
            return;
          }
          throw new Error("unexpected browser network event");
        } catch (error) {
          setFatal(error);
        }
        return;
      }
      if (message.method === "Runtime.exceptionThrown") {
        setFatal(new Error("browser exception"));
      }
    };
    cdp.listeners.add(listener);
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    ({ sessionId: pageSessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true }));
    const sessionId = pageSessionId;
    await Promise.all([
      cdp.send("Page.enable", {}, sessionId),
      cdp.send("Runtime.enable", {}, sessionId),
      cdp.send("Network.enable", {}, sessionId),
      cdp.send("Runtime.addBinding", { name: bindingName }, sessionId),
    ]);
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: createWorkerObserverSource(bindingName) }, sessionId);
    await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId);
    await cdp.send("Page.navigate", { url: origin }, sessionId);
    await waitUntil(cdp, sessionId, "document.readyState==='complete'&&!!document.querySelector('form')", fatal);

    function startTrace(repository, generation, progress) {
      invariant(network.size === 0 && [...correlations.values()].every(correlationComplete),
        "browser asset correlation was not quiescent before generation");
      correlations.clear();
      workerTargets.clear();
      workerReady.clear();
      detachedWorkers.clear();
      traceStarted = true;
      mode = {
        repository, generation, progress, gets: [], rawFacts: progress.candidates ?? [], aggregate: 0,
        revision: null, rootTree: null, projected: null, treeEntries: null, admittedGets: 0,
        wireGet: null, openExchange: null, exchanges: [], nextSemanticIndex: 0,
        pendingSelection: null, selectedFact: null, selectionUnavailable: false,
        revisionReadiness: deferredResult(), selectionResult: deferredResult(), terminalResult: deferredResult(),
        pendingTerminal: null, firstTerminal: null, pendingDrain: null, firstDrain: null,
        providerClosure: null, providerAdmissionClosed: false,
        derivedProviderGets: null, expectedProviderGets: null, workerDetachedReceipt: false,
        stageEndMs: {}, latestRequestEndMs: 0, lastPublishedFactAtMs: 0,
        causalMilestones: [], publishedCausalMilestones: new Set(),
        causalMilestonesOpen: false, lastPublishedLifecycleAtMs: 0,
      };
      return mode;
    }
    async function submit(repositoryUrl) {
      await evaluate(cdp, sessionId, `(() => { const input=document.querySelector('input[name=repository]'); input.value=${JSON.stringify(repositoryUrl)}; document.querySelector('form').requestSubmit(); return true; })()`);
    }
    async function flush(requireQuiescence = false) {
      await awaitProcessingBarrier();
      if (mode) flushCausalMilestones(mode);
      if (requireQuiescence && (network.size > 0
          || [...correlations.values()].some((correlation) => !correlationComplete(correlation)))) {
        setFatal(new Error("browser request headers, response, or asset correlation are incomplete"));
      }
      if (fatal.value) throw fatal.value;
    }
    function clearTransientCorrelation() {
      invariant(network.size === 0 && [...correlations.values()].every(correlationComplete),
        "browser request correlation is not quiescent");
      const generation = mode?.generation ?? 0;
      correlations.clear();
      validateSafeTransientState(Object.freeze({
        kind: "correlations-cleared", generation, correlationCount: correlations.size,
      }));
    }
    function snapshot(kind) {
      if (kind === "smoke" && mode?.generation === 1) {
        mode.progress.providerGetCount = mode.gets.length;
        return mode.progress;
      }
      if (kind === "capacity" && mode?.generation === 2) {
        mode.progress.rawRequestCount = mode.rawFacts.length;
        mode.progress.candidates = mode.rawFacts;
        return mode.progress;
      }
      return undefined;
    }

    return Object.freeze({
      chromeVersion,
      cdpVersion: version.protocolVersion,
      fatalSignal: fatalController.signal,
      snapshot,
      async collectSmoke(emit, startedMs) {
        facts.length = 0;
        const progress = {
          repositoryUrl: CODE_CITY_URL, revision: null, rootTree: null, terminal: null, canvasCount: null,
          modelSha256: null, startedMs, endedMs: null, providerGetCount: 0,
        };
        const trace = startTrace(CODE_CITY_REPOSITORY, 1, progress);
        await submit(CODE_CITY_URL);
        const firstResult = await Promise.race([
          trace.selectionResult.promise,
          trace.terminalResult.promise,
        ]);
        const selection = ["SUCCESS", "FAILURE"].includes(firstResult.type)
          ? await trace.selectionResult.promise : firstResult;
        if (selection.type === "selection-unavailable") {
          const terminal = ["SUCCESS", "FAILURE"].includes(firstResult.type)
            ? firstResult : await trace.terminalResult.promise;
          invariant(terminal.type === "FAILURE" && !Object.hasOwn(terminal, "revision")
            && terminal.category === selection.category, "smoke pre-selection terminal differs");
          await nextFact((fact) => fact.type === "ATTEMPT_DRAINED" && fact.generation === 1);
          await waitForWorkerDetachment();
          await flush(true);
          clearTransientCorrelation();
          mode = null;
          throw new Error(`smoke pre-selection failure: ${terminal.category}`);
        }
        const selected = selection;
        progress.revision = selected.revision;
        invariant(selected.revision === eventSha, "smoke selected a stale revision");
        openCausalMilestones(trace, emit("revision-selected", 1, selected.observedAtMs));
        await flush();
        invariant(trace.revision === eventSha, "smoke revision evidence differs");
        const terminal = await trace.terminalResult.promise;
        invariant(terminal.type === "SUCCESS" && terminal.revision === selected.revision
          && terminal.revision === eventSha, "smoke terminal revision differs");
        await nextFact((fact) => fact.type === "ATTEMPT_DRAINED" && fact.generation === 1);
        await waitUntil(cdp, sessionId, `document.querySelector('[data-commit]')?.textContent===${JSON.stringify(eventSha)}&&document.querySelectorAll('[data-city] canvas').length===1`, fatal);
        await flush(true);
        invariant(workerTargets.size > 0, "smoke worker target was not observed");
        await waitForWorkerDetachment();
        invariant(trace.projected && trace.projected.length >= 1 && trace.rawFacts.length === trace.projected.length, "smoke tree/request cardinality mismatch");
        const expectedStages = ["revision", "commit", "tree", ...trace.projected.map(() => "raw")];
        invariant(trace.gets.length === expectedStages.length && trace.gets.every((item, index) => item.stage === expectedStages[index]), "smoke request sequence mismatch");
        const cityPublished = emit("city-published", 1, terminal.observedAtMs);
        Object.assign(progress, {
          revision: trace.revision, rootTree: trace.rootTree, terminal: "success", canvasCount: 1,
          modelSha256: terminal.modelSha256, endedMs: cityPublished.atMs, providerGetCount: trace.gets.length,
        });
        clearTransientCorrelation();
        mode = null;
        return progress;
      },
      clearTrace() {
        invariant(mode === null && network.size === 0 && correlations.size === 0, "browser trace is not quiescent");
      },
      async collectCapacity(qualification, emit, startedMs) {
        facts.length = 0;
        const progress = {
          ...emptyData(CAPACITY_KEYS, ["candidates"]), repositoryUrl: REACT_URL, startedMs,
          rawRequestCount: 0, candidates: [],
        };
        const trace = startTrace(REACT_REPOSITORY, 2, progress);
        trace.onInventory = (atMs) => recordCausalMilestone(
          trace, "inventory-complete", atMs,
          (observedAtMs) => emit("inventory-complete", 2, observedAtMs),
        );
        await submit(REACT_URL);
        const selected = await nextFact((fact) => fact.type === "REVISION_SELECTED" && fact.generation === 2);
        progress.revision = selected.revision;
        invariant(selected.revision === qualification.revision, "capacity revision differs from qualification");
        openCausalMilestones(trace, emit("revision-selected", 2, selected.observedAtMs));
        await flush();
        invariant(trace.revision === qualification.revision, "capacity revision evidence differs from qualification");
        const terminal = await nextFact((fact) => ["SUCCESS", "FAILURE"].includes(fact.type) && fact.generation === 2);
        invariant(terminal.type === "FAILURE" && terminal.category === "Repository exceeds Code City limits"
          && terminal.revision === qualification.revision, "capacity terminal differs");
        await flush(true);
        invariant(network.size === 0, "terminal preceded request completion");
        invariant(trace.rootTree === qualification.rootTree && trace.projected && trace.projected.length >= 4001 && trace.rawFacts.length === 4001, "capacity inventory/cardinality differs");
        invariant(JSON.stringify(trace.rawFacts) === JSON.stringify(qualification.candidates), "capacity bytes differ from qualification");
        invariant(trace.gets.length === 4004 && trace.gets.slice(0, 3).every((item, index) => item.stage === ["revision", "commit", "tree"][index])
          && trace.gets.slice(3).every((item) => item.stage === "raw"), "capacity request sequence differs");
        Object.assign(progress, {
          revision: trace.revision, rootTree: trace.rootTree, terminal: "Repository exceeds Code City limits",
          rawRequestCount: 4001, candidates: trace.rawFacts,
        });
        emit("limit-failure", 2, terminal.observedAtMs);
        const drained = await nextFact((fact) => fact.type === "ATTEMPT_DRAINED" && fact.generation === 2);
        const capacityUi = await waitForClearCapacityUi(cdp, sessionId, qualification.revision, fatal);
        Object.assign(progress, {
          revisionDisplayed: ownString(capacityUi, "revision") === qualification.revision,
          cityPresent: capacityUiHasPresentation(capacityUi),
          priorCityRemoved: capacityUiHasPresentation(capacityUi) === false,
        });
        await flush(true);
        invariant(network.size === 0, "capacity requests are not quiescent");
        progress.noLaterRequest = true;
        emit("request-quiescent", 2);
        invariant(workerTargets.size > 0, "capacity worker target was not observed");
        await waitForWorkerDetachment();
        const finalUi = await evaluate(cdp, sessionId, capacityUiExpression("capacity-final-state"));
        await flush(true);
        invariant(capacityUiIsClear(finalUi, qualification.revision)
          && capacityUiHasPresentation(finalUi) === progress.cityPresent,
        "stale publication after worker detachment");
        invariant(facts.length === 3 && facts[0] === selected && facts[1] === terminal && facts[2] === drained,
          "stale publication worker message after detachment");
        invariant(network.size === 0 && trace.gets.length === 4004 && trace.rawFacts.length === 4001,
          "capacity requests are not quiescent after worker detachment");
        progress.workerQuiescent = true;
        const workerQuiescent = emit("worker-quiescent", 2);
        progress.endedMs = workerQuiescent.atMs;
        clearTransientCorrelation();
        mode = null;
        return progress;
      },
      async close() {
        if (closePromise) return closePromise;
        closePromise = (async () => {
          cdp.listeners.delete(listener);
          cdp.closeListeners?.delete(fatalListener);
          launched.child.off("exit", processExitListener);
          const closeCommand = cdp.send("Browser.close").catch(() => {});
          cdp.close();
          if (!childIsTerminal(launched.child)) {
            const exited = new Promise((resolve) => launched.child.once("exit", resolve));
            launched.child.kill();
            if (!childIsTerminal(launched.child)) await exited;
          }
          await closeCommand;
        })();
        return closePromise;
      },
    });
  } catch (error) {
    if (listener) cdp?.listeners.delete(listener);
    if (fatalListener) cdp?.closeListeners?.delete(fatalListener);
    if (processExitListener) launched.child.off("exit", processExitListener);
    const closeCommand = cdp?.send("Browser.close").catch(() => {});
    try { cdp?.close(); } catch {}
    if (!childIsTerminal(launched.child)) {
      const exited = new Promise((resolve) => launched.child.once("exit", resolve));
      launched.child.kill();
      if (!childIsTerminal(launched.child)) await exited;
    }
    await closeCommand;
    throw error;
  }
}

function envelope(kind, status, reason, data) {
  return { schemaVersion: 1, kind, status, reason, data };
}

function emptyData(keys, arrays = []) {
  return Object.fromEntries(keys.map((key) => [key, arrays.includes(key) ? [] : null]));
}

const SMOKE_KEYS = ["repositoryUrl", "revision", "rootTree", "terminal", "canvasCount", "modelSha256", "startedMs", "endedMs", "providerGetCount"];
const QUALIFICATION_KEYS = ["repositoryUrl", "revision", "rootTree", "treeEntries", "truncated", "candidates"];
const CAPACITY_KEYS = ["repositoryUrl", "revision", "rootTree", "terminal", "revisionDisplayed", "cityPresent", "priorCityRemoved", "rawRequestCount", "maxOverlap", "noLaterRequest", "workerQuiescent", "candidates", "startedMs", "endedMs"];

function eventAt(events, name, generation) {
  return events.find((event) => event.event === name && event.generation === generation);
}
function durationBetween(events, endName, endGeneration, startName, startGeneration) {
  const end = eventAt(events, endName, endGeneration);
  const start = eventAt(events, startName, startGeneration);
  return end && start ? end.atMs - start.atMs : null;
}
function deriveDurations(events) {
  return {
    artifact: durationBetween(events, "artifact-verified", 0, "collector-start", 0),
    smoke: durationBetween(events, "trace-reset", 0, "smoke-start", 1),
    qualification: durationBetween(events, "qualification-complete", 0, "qualification-start", 0),
    resolution: durationBetween(events, "revision-selected", 2, "capacity-start", 2),
    inventory: durationBetween(events, "inventory-complete", 2, "revision-selected", 2),
    retrieval: durationBetween(events, "limit-failure", 2, "inventory-complete", 2),
    terminal: durationBetween(events, "worker-quiescent", 2, "limit-failure", 2),
    capacity: durationBetween(events, "worker-quiescent", 2, "capacity-start", 2),
    total: events.at(-1)?.atMs ?? null,
  };
}

function maximumOverlap(items) {
  const points = [];
  for (const item of items) {
    if (item.startedMs === item.endedMs) continue;
    points.push([item.startedMs, 1], [item.endedMs, -1]);
  }
  points.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  let active = 0;
  let maximum = 0;
  for (const [, change] of points) { active += change; maximum = Math.max(maximum, active); }
  return maximum;
}

function stageGetOverlap(state, stage) {
  const start = state.stageRequestStarts[stage];
  if (!Number.isSafeInteger(start)) return 0;
  const nextStart = ["smoke", "qualification", "capacity"]
    .map((name) => state.stageRequestStarts[name])
    .filter((value) => Number.isSafeInteger(value) && value > start)
    .sort((left, right) => left - right)[0] ?? state.requestItems.length;
  return maximumOverlap(state.requestItems.slice(start, nextStart).filter((item) => item.method === "GET"));
}

function enforceNoStageOverlap(state, stage) {
  if (stageGetOverlap(state, stage) > 1) fail(stage, "request-overlap");
}

function runnerPlatform() {
  const osName = { win32: "Windows", linux: "Linux", darwin: "macOS" }[process.platform];
  const arch = { x64: "X64", arm64: "ARM64" }[process.arch];
  invariant(osName && arch, "runner platform is unsupported");
  return { runnerOs: osName, runnerArch: arch };
}

export async function deriveCollectorCommit({ execFileImpl = execFile } = {}) {
  const run = async (args) => (await execFileImpl("git", args, { cwd: PROJECT_ROOT, encoding: "utf8", windowsHide: true })).stdout.trim();
  const head = await run(["rev-parse", "--verify", "HEAD^{commit}"]);
  await run(["cat-file", "-e", "HEAD:tools/collect-production-evidence.mjs"]);
  await run(["ls-files", "--error-unmatch", "tools/collect-production-evidence.mjs"]);
  const status = await run(["status", "--porcelain=v1", "--untracked-files=all"]);
  invariant(status === "" && /^[0-9a-f]{40}$/u.test(head), "collector checkout is ambiguous or dirty");
  return head;
}

function makeLifecycleData(state, status, reason, events = state.events) {
  const capacityStarted = eventAt(events, "capacity-start", 2) !== undefined;
  const capacityItems = state.requestItems.filter((item) => item.applicationCall && item.requestedUrl.includes("/facebook/react/"));
  return {
    collectorVersion: 1,
    collectorCommit: state.collectorCommit,
    invocation: state.invocation,
    nodeVersion: state.nodeVersion,
    chromeVersion: state.chromeVersion,
    cdpVersion: state.cdpVersion,
    events,
    durations: deriveDurations(events),
    maxOverlap: capacityStarted ? maximumOverlap(capacityItems.filter((item) => item.method === "GET")) : null,
    noRetry: status === "pass" ? true : null,
    noFallback: status === "pass" ? true : null,
    noPersistence: status === "pass" ? true : null,
    noLaterPublication: status === "pass" ? true : null,
  };
}

function passingPayloads(state) {
  const capacityGets = state.requestItems.filter((item) => item.applicationCall && item.method === "GET"
    && item.requestedUrl.includes("/facebook/react/"));
  const overlap = maximumOverlap(capacityGets);
  state.capacity.maxOverlap = overlap;
  return {
    artifact: envelope("artifact", "pass", "none", state.artifact),
    smoke: envelope("smoke", "pass", "none", state.smoke),
    qualification: envelope("qualification", "pass", "none", state.qualification),
    capacity: envelope("capacity", "pass", "none", state.capacity),
    requests: envelope("requests", "pass", "none", { items: state.requestItems }),
    lifecycle: envelope("lifecycle", "pass", "none", makeLifecycleData(state, "pass", "none")),
  };
}

function failurePayloads(state, failure) {
  const stages = ["artifact", "smoke", "qualification", "capacity"];
  const failedIndex = stages.indexOf(failure.stage);
  invariant(failedIndex >= 0, "invalid failed stage");
  const failureAt = Math.max(state.events.at(-1)?.atMs ?? 0, state.now());
  const events = [...state.events, {
    sequence: state.events.length + 1, generation: 0, event: "collector-failed", atMs: failureAt,
  }];
  state.events = events;

  const smokeFail = state.smoke ?? emptyData(SMOKE_KEYS);
  if (eventAt(events, "smoke-start", 1)) {
    smokeFail.repositoryUrl ??= CODE_CITY_URL;
    smokeFail.providerGetCount = state.requestItems.filter((item) => item.applicationCall
      && item.requestedUrl.includes("/FelixGeisler/code-city/") && item.method === "GET").length;
  }
  const qualificationFail = state.qualification ?? emptyData(QUALIFICATION_KEYS, ["candidates"]);
  if (eventAt(events, "qualification-start", 0)) qualificationFail.repositoryUrl ??= REACT_URL;
  const capacityFail = state.capacity ?? emptyData(CAPACITY_KEYS, ["candidates"]);
  if (eventAt(events, "capacity-start", 2)) {
    capacityFail.repositoryUrl ??= REACT_URL;
    const capacityGets = state.requestItems.filter((item) => item.applicationCall && item.method === "GET"
      && item.requestedUrl.includes("/facebook/react/"));
    capacityFail.rawRequestCount = capacityGets.filter((item) => item.stage === "raw").length;
    capacityFail.maxOverlap = maximumOverlap(capacityGets);
    capacityFail.candidates ??= [];
  }
  const failedData = { artifact: state.artifact, smoke: smokeFail, qualification: qualificationFail, capacity: capacityFail };
  const payloads = {};
  for (let index = 0; index < stages.length; index += 1) {
    const stage = stages[index];
    if (index < failedIndex) payloads[stage] = envelope(stage, "pass", "none", state[stage]);
    else if (index === failedIndex) payloads[stage] = envelope(stage, "fail", failure.reason, failedData[stage]);
    else {
      const data = stage === "smoke" ? emptyData(SMOKE_KEYS)
        : stage === "qualification" ? emptyData(QUALIFICATION_KEYS, ["candidates"])
          : emptyData(CAPACITY_KEYS, ["candidates"]);
      payloads[stage] = envelope(stage, "not-run", "blocked", data);
    }
  }
  payloads.requests = envelope("requests", "fail", failure.reason, { items: state.requestItems });
  payloads.lifecycle = envelope("lifecycle", "fail", failure.reason, makeLifecycleData(state, "fail", failure.reason, events));
  return payloads;
}

function mapBrowserFailure(stage, error) {
  if (error instanceof CollectorFailure) return error;
  const message = String(error?.message);
  if (/credential|request headers/iu.test(message)) return new CollectorFailure(stage, "credential-header");
  if (/CORS/iu.test(message)) return new CollectorFailure(stage, "cors-failure");
  if (/stale/iu.test(message)) return new CollectorFailure(stage, "stale-publication");
  if (/overlap/iu.test(message)) return new CollectorFailure(stage, "request-overlap");
  if (/unexpected browser (?:request|network (?:event|session))/iu.test(message)) {
    return new CollectorFailure(stage, "unexpected-request");
  }
  if (/sequence|cardinality|redirected|duplicate/iu.test(message)) return new CollectorFailure(stage, "request-sequence");
  if (/quiescent/iu.test(message)) return new CollectorFailure(stage, "quiescence-failure");
  if (stage === "smoke" && /tree|blob|candidate|UTF-8|NUL|content|identity|revision|commit|supported|encoded data|JSON|Unexpected token|property name/iu.test(message)) {
    return new CollectorFailure(stage, "smoke-failure");
  }
  if (/tree evidence is incomplete/iu.test(message)) return new CollectorFailure(stage, "tree-incomplete");
  if (/blob|candidate mismatch/iu.test(message)) return new CollectorFailure(stage, "hash-mismatch");
  if (/UTF-8|NUL|content/iu.test(message)) return new CollectorFailure(stage, "content-invalid");
  if (/invalid (?:revision|commit) evidence|revision differs|inventory.*differs|root identity|identity mismatch/iu.test(message)) return new CollectorFailure(stage, "identity-mismatch");
  if (/terminal|limit ordering|cardinality/iu.test(message)) return new CollectorFailure(stage, stage === "smoke" ? "smoke-failure" : "limit-order");
  if (/request failed|response|transfer size/iu.test(message)) return new CollectorFailure(stage, "provider-failure");
  return new CollectorFailure(stage, "infrastructure-failure");
}

export async function readPublicationInput(manifestPath) {
  const manifestBytes = wholeBytes(await readFile(manifestPath));
  const manifest = parsePackageManifest(manifestBytes);
  const recordPath = path.join(path.dirname(manifestPath), "publication-record.json");
  const publicationRecordBytes = wholeBytes(await readFile(recordPath));
  const publicationRecord = validatePublicationRecord(publicationRecordBytes, manifestBytes);
  return { manifestBytes, manifest, publicationRecordBytes, publicationRecord };
}

export async function collectProductionEvidence(options, seams = {}) {
  invariant(options?.origin === PRODUCTION_ORIGIN && path.isAbsolute(options.manifestPath) && path.isAbsolute(options.output), "collector options are invalid");
  const clock = seams.clock ?? (() => performance.now());
  const epoch = clock();
  let priorNow = 0;
  const now = () => {
    const observed = Math.max(0, clock() - epoch);
    priorNow = Math.max(priorNow, observed);
    return priorNow;
  };
  const state = {
    now,
    events: [{ sequence: 1, generation: 0, event: "collector-start", atMs: 0 }],
    requestItems: [],
    stageRequestStarts: { artifact: 0 },
    collectorCommit: null,
    invocation: null,
    nodeVersion: null,
    chromeVersion: null,
    cdpVersion: null,
    artifact: {
      issueBodySha256: PARENT_ISSUE_BODY_SHA256,
      eventSha: null,
      repository: CODE_CITY_REPOSITORY,
      runId: null,
      runAttempt: null,
      origin: PRODUCTION_ORIGIN,
      manifestSha256: null,
      publicationRecordSha256: null,
      deploymentId: null,
      deployedSha: null,
      nodeVersion: null,
      chromeVersion: null,
      chromeExecutableCategory: null,
      runnerOs: null,
      runnerArch: null,
      policyMatched: null,
      files: [],
    },
    smoke: null,
    qualification: null,
    capacity: null,
  };
  const emit = (event, generation, observedAtMs) => {
    const prior = state.events.at(-1)?.atMs ?? 0;
    const atMs = observedAtMs === undefined ? now() : observedAtMs;
    invariant(atMs >= prior, "lifecycle event order differs");
    const value = { sequence: state.events.length + 1, generation, event, atMs };
    state.events.push(value);
    return value;
  };
  let binding;
  let browser;
  let profile;
  let packet;
  let failure;
  let activeStage = "artifact";
  try {
    invariant(/^v24\.\d+\.\d+$/u.test(process.version), "Node 24 is required");
    state.nodeVersion = process.version;
    state.invocation = [...COLLECTOR_INVOCATION];
    state.artifact.nodeVersion = state.nodeVersion;
    Object.assign(state.artifact, runnerPlatform());
    let publication;
    try {
      publication = await (seams.readPublicationInput ?? readPublicationInput)(options.manifestPath);
    } catch {
      fail("artifact", "artifact-mismatch");
    }
    const { manifestBytes, manifest, publicationRecordBytes, publicationRecord } = publication;
    binding = Object.freeze({ issueBodySha256: PARENT_ISSUE_BODY_SHA256, eventSha: publicationRecord.eventSha });
    Object.assign(state.artifact, {
      eventSha: publicationRecord.eventSha,
      runId: publicationRecord.runId,
      runAttempt: publicationRecord.runAttempt,
      manifestSha256: digest(manifestBytes),
      publicationRecordSha256: digest(publicationRecordBytes),
      policyMatched: true,
    });
    try {
      state.collectorCommit = await (seams.deriveCollectorCommit ?? deriveCollectorCommit)();
    } catch {
      fail("artifact", "artifact-mismatch");
    }
    if (state.collectorCommit !== publicationRecord.eventSha) {
      state.collectorCommit = null;
      fail("artifact", "artifact-mismatch");
    }
    const discovery = await (seams.discoverInstalledChrome ?? discoverInstalledChrome)();
    state.artifact.chromeExecutableCategory = discovery.category;
    state.chromeVersion = await (seams.readInstalledChromeVersion ?? readInstalledChromeVersion)(discovery);
    state.artifact.chromeVersion = state.chromeVersion;
    const deployment = await (seams.verifyDeploymentBinding ?? verifyDeploymentBinding)({
      eventSha: publicationRecord.eventSha, origin: options.origin,
      fetchImpl: seams.fetchImpl ?? fetch, now, requestItems: state.requestItems, progress: state.artifact,
    });
    Object.assign(state.artifact, deployment);
    state.artifact.files = await (seams.verifyProductionAssets ?? verifyProductionAssets)({
      manifest, origin: options.origin, fetchImpl: seams.fetchImpl ?? fetch, now, requestItems: state.requestItems,
      files: state.artifact.files,
    });
    emit("artifact-verified", 0);

    profile = await (seams.mkdtemp ?? mkdtemp)(path.join(os.tmpdir(), "code-city-evidence-chrome-"));
    browser = await (seams.createBrowserEvidenceSession ?? createBrowserEvidenceSession)({
      discovery, chromeVersion: state.chromeVersion, profile, origin: options.origin, manifest,
      eventSha: publicationRecord.eventSha, now, requestItems: state.requestItems,
      observeCdpVersion(value) { state.cdpVersion = value; },
    });
    state.cdpVersion = browser.cdpVersion;
    activeStage = "smoke";
    state.stageRequestStarts.smoke = state.requestItems.length;
    const smokeStart = emit("smoke-start", 1);
    state.smoke = {
      ...emptyData(SMOKE_KEYS), repositoryUrl: CODE_CITY_URL, startedMs: smokeStart.atMs, providerGetCount: 0,
    };
    try {
      state.smoke = await browser.collectSmoke(emit, smokeStart.atMs);
      enforceNoStageOverlap(state, "smoke");
      browser.clearTrace();
    } catch (error) {
      throw mapBrowserFailure("smoke", error);
    }
    emit("trace-reset", 0);

    activeStage = "qualification";
    state.stageRequestStarts.qualification = state.requestItems.length;
    emit("qualification-start", 0);
    state.qualification = {
      ...emptyData(QUALIFICATION_KEYS, ["candidates"]), repositoryUrl: REACT_URL,
    };
    state.qualification = await (seams.qualifyRepository ?? qualifyRepository)({
      fetchImpl: seams.fetchImpl ?? fetch, now, requestItems: state.requestItems, signal: browser.fatalSignal,
      progress: state.qualification,
    });
    enforceNoStageOverlap(state, "qualification");
    emit("qualification-complete", 0);

    activeStage = "capacity";
    state.stageRequestStarts.capacity = state.requestItems.length;
    const capacityStart = emit("capacity-start", 2);
    state.capacity = {
      ...emptyData(CAPACITY_KEYS, ["candidates"]), repositoryUrl: REACT_URL,
      startedMs: capacityStart.atMs, rawRequestCount: 0,
    };
    try {
      state.capacity = await browser.collectCapacity(state.qualification, emit, capacityStart.atMs);
      enforceNoStageOverlap(state, "capacity");
    } catch (error) {
      throw mapBrowserFailure("capacity", error);
    }
    try {
      await browser.close();
      browser = null;
      await (seams.rm ?? rm)(profile, { recursive: true, force: true });
      profile = null;
    } catch {
      fail("capacity", "cleanup-failure");
    }
    emit("collector-complete", 0);
  } catch (error) {
    failure = error instanceof CollectorFailure ? error : new CollectorFailure(activeStage, "infrastructure-failure");
    if (["smoke", "qualification", "capacity"].includes(activeStage) && stageGetOverlap(state, activeStage) > 1) {
      failure = new CollectorFailure(activeStage, "request-overlap");
    }
    if (browser) {
      state.smoke = browser.snapshot?.("smoke") ?? state.smoke;
      state.capacity = browser.snapshot?.("capacity") ?? state.capacity;
      try { await browser.close(); } catch {}
      browser = null;
    }
    if (profile) {
      try { await (seams.rm ?? rm)(profile, { recursive: true, force: true }); } catch {}
      profile = null;
    }
    if (!binding) throw failure;
  }

  const createPacket = seams.createEvidencePacket ?? createEvidencePacket;
  packet = createPacket(failure ? failurePayloads(state, failure) : passingPayloads(state), binding);
  await (seams.writeValidatedEvidencePacket ?? writeValidatedEvidencePacket)(options.output, packet);
  const readback = await (seams.readValidatedEvidencePacket ?? readValidatedEvidencePacket)(options.output, packet.binding);
  invariant(readback.packetDigest === packet.packetDigest, "stored packet read-back differs");
  return Object.freeze({ packetDigest: packet.packetDigest, status: failure ? "fail" : "pass", reason: failure?.reason ?? "none" });
}

export async function runCollectorCli(args = process.argv.slice(2), seams = {}) {
  let options;
  try {
    options = parseCollectorArguments(args);
    const result = await collectProductionEvidence(options, seams);
    if (result.status !== "pass") {
      process.stderr.write("Production evidence collection failed safely.\n");
      return 1;
    }
    process.stdout.write(`${result.packetDigest}\n`);
    return 0;
  } catch {
    process.stderr.write("Production evidence collection failed safely.\n");
    return 1;
  }
}

const invokedPath = process.argv[1] && path.resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) process.exitCode = await runCollectorCli();
