import { validateCityPayload, type CityPayload, type ValidatedCity } from "../../application/city-payload";
import type { RetainedProjectSource } from "../../application/project-analysis";
import type { FailureCode } from "../../application/resolution";
import type { FailedFile } from "../../application/source-retrieval";
import type { RepositoryReference } from "../../domain/repository-reference";
import {
  compareUnsignedUtf8,
  isCanonicalAdditionalExclusions,
  isCanonicalSourcePath,
  MAX_ADMITTED_MODULES,
  MAX_NORMALIZED_MODULE_BYTES,
  MAX_NORMALIZED_TOTAL_BYTES,
} from "../../domain/source-admission";

export type NodeWorkerCommand =
  | Readonly<{ type: "START"; attemptId: string; generation: number; repository: RepositoryReference; additionalExclusions: readonly string[] }>
  | Readonly<{ type: "STOP"; attemptId: string; generation: number }>;

type PreSelectionCategory = "Repository unavailable for anonymous access" | "Revision unavailable" | "Provider/resolution failure";
type PostSelectionUncodedCategory = "Provider/resolution failure" | "Repository exceeds Code City limits";
type PostSelectionCodedCategory = "No supported modules" | "Source admission failed" | "Metric processing failed" | "City construction failed";

export type NodeWorkerFailure =
  | Readonly<{ type: "FAILURE"; attemptId: string; generation: number; category: PreSelectionCategory }>
  | Readonly<{ type: "FAILURE"; attemptId: string; generation: number; revision: string; category: PostSelectionUncodedCategory }>
  | Readonly<{ type: "FAILURE"; attemptId: string; generation: number; revision: string; category: PostSelectionCodedCategory; code: FailureCode }>;

export type NodeWorkerSuccess = Readonly<{
  type: "SUCCESS";
  attemptId: string;
  generation: number;
  revision: string;
  result: Readonly<{ city: CityPayload | null; notAnalyzedFiles: FailedFile[] }>;
  sources: RetainedProjectSource[];
}>;

export type NodeWorkerEvent =
  | Readonly<{ type: "REVISION_SELECTED"; attemptId: string; generation: number; revision: string }>
  | NodeWorkerFailure
  | NodeWorkerSuccess;

export type ValidatedNodeWorkerSuccess = Readonly<{
  type: "SUCCESS";
  attemptId: string;
  generation: number;
  revision: string;
  result: Readonly<{ city: ValidatedCity | null; notAnalyzedFiles: FailedFile[] }>;
  sources: RetainedProjectSource[];
}>;

export type ValidatedNodeWorkerEvent = Exclude<NodeWorkerEvent, NodeWorkerSuccess> | ValidatedNodeWorkerSuccess;
export type NodeWorkerValidation =
  | Readonly<{ kind: "valid"; event: ValidatedNodeWorkerEvent }>
  | Readonly<{ kind: "invalid"; mapping: "provider" | "city"; attemptId?: string; generation?: number; revision?: string }>;

type DataRecord = Record<string, unknown>;
type SourceByteBoundary = "sender" | "receiver";
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const preparedSenderBytes = new WeakSet<Uint8Array>();

function exactRecord(value: unknown, keys: readonly string[]): DataRecord | undefined {
  try {
    if (typeof value !== "object" || value === null || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(descriptors);
    if (ownKeys.some((key) => typeof key !== "string") || ownKeys.length !== keys.length
      || keys.some((key) => !Object.hasOwn(descriptors, key))) return undefined;
    const record: DataRecord = {};
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return undefined;
      record[key] = descriptor.value;
    }
    return record;
  } catch {
    return undefined;
  }
}

function exactArray(value: unknown): unknown[] | undefined {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key !== "string") || keys.length !== value.length + 1) return undefined;
    const length = descriptors["length"] as PropertyDescriptor | undefined;
    if (!length || !("value" in length) || length.value !== value.length || length.enumerable) return undefined;
    const rows: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return undefined;
      rows.push(descriptor.value);
    }
    return rows;
  } catch {
    return undefined;
  }
}

function validAttemptId(value: unknown): value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(value)) return false;
  try {
    const bytes = Buffer.from(value, "base64url");
    return bytes.byteLength === 16 && bytes.toString("base64url") === value;
  } catch {
    return false;
  }
}

function validGeneration(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function validNodeRevision(value: unknown): value is string {
  return typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
}

function parseRepository(value: unknown): RepositoryReference | undefined {
  const record = exactRecord(value, ["owner", "repository", "branch"]);
  if (!record || typeof record.owner !== "string" || typeof record.repository !== "string"
    || (typeof record.branch !== "string" && record.branch !== null)) return undefined;
  return { owner: record.owner, repository: record.repository, branch: record.branch };
}

function parseExclusions(value: unknown): readonly string[] | undefined {
  const rows = exactArray(value);
  if (!rows || rows.some((row) => typeof row !== "string")) return undefined;
  const paths = rows as string[];
  return isCanonicalAdditionalExclusions(paths) ? Object.freeze([...paths]) : undefined;
}

export function parseNodeWorkerCommand(value: unknown): NodeWorkerCommand | undefined {
  const start = exactRecord(value, ["type", "attemptId", "generation", "repository", "additionalExclusions"]);
  if (start?.type === "START" && validAttemptId(start.attemptId) && validGeneration(start.generation)) {
    const repository = parseRepository(start.repository);
    const additionalExclusions = parseExclusions(start.additionalExclusions);
    if (repository && additionalExclusions) {
      return { type: "START", attemptId: start.attemptId, generation: start.generation, repository, additionalExclusions };
    }
  }
  const stop = exactRecord(value, ["type", "attemptId", "generation"]);
  return stop?.type === "STOP" && validAttemptId(stop.attemptId) && validGeneration(stop.generation)
    ? { type: "STOP", attemptId: stop.attemptId, generation: stop.generation }
    : undefined;
}

function validCode(category: unknown, code: unknown): code is FailureCode {
  if (typeof code !== "string") return false;
  if (category === "No supported modules") return code === "ADM-06" || code === "ADM-07";
  if (category === "Source admission failed") return code === "M1-ADM-1" || code === "M1-ADM-3" || code === "M1-ADM-4";
  if (category === "Metric processing failed") return code === "M1-MET-1";
  return category === "City construction failed" && code === "M1-CITY-1";
}

function correlation(record: DataRecord): boolean {
  return validAttemptId(record.attemptId) && validGeneration(record.generation);
}

function plainWholeBytes(value: unknown, boundary: SourceByteBoundary): Uint8Array | undefined {
  try {
    if (typeof value !== "object" || value === null || !ArrayBuffer.isView(value)
      || Object.getPrototypeOf(value) !== Uint8Array.prototype) return undefined;
    const bytes = value as Uint8Array;
    if (Object.getPrototypeOf(bytes.buffer) !== ArrayBuffer.prototype || bytes.byteOffset !== 0
      || bytes.byteLength !== bytes.buffer.byteLength) return undefined;
    const buffer = bytes.buffer as ArrayBuffer & { resizable?: boolean };
    if (buffer.resizable === true || Reflect.ownKeys(buffer).length !== 0) return undefined;
    buffer.slice(0, 0);
    if (Object.getOwnPropertySymbols(bytes).length !== 0) return undefined;
    if (boundary === "sender" && (!preparedSenderBytes.has(bytes) || Object.isExtensible(bytes))) return undefined;
    return bytes;
  } catch {
    return undefined;
  }
}

export function prepareNodeWorkerSuccessForPublication(event: NodeWorkerSuccess): NodeWorkerSuccess {
  for (const source of event.sources) {
    const bytes = plainWholeBytes(source.normalizedUtf8, "receiver");
    if (!bytes) throw new Error("Worker source bytes are invalid");
    Object.preventExtensions(bytes);
    preparedSenderBytes.add(bytes);
  }
  return event;
}

function sortedUniquePaths(rows: readonly { canonicalPath: string }[]): boolean {
  let prior: string | undefined;
  for (const row of rows) {
    if (!isCanonicalSourcePath(row.canonicalPath)
      || (prior !== undefined && compareUnsignedUtf8(prior, row.canonicalPath) >= 0)) return false;
    prior = row.canonicalPath;
  }
  return true;
}

function parseFailures(value: unknown): FailedFile[] | undefined {
  const rows = exactArray(value);
  if (!rows) return undefined;
  const failures: FailedFile[] = [];
  for (const row of rows) {
    const record = exactRecord(row, ["canonicalPath", "category"]);
    if (!record || typeof record.canonicalPath !== "string"
      || (record.category !== "Source text is not supported" && record.category !== "Syntax could not be analyzed"
        && record.category !== "Metrics could not be computed")) return undefined;
    failures.push({ canonicalPath: record.canonicalPath, category: record.category });
  }
  return sortedUniquePaths(failures) ? failures : undefined;
}

function parseSources(value: unknown, boundary: SourceByteBoundary): RetainedProjectSource[] | undefined {
  const rows = exactArray(value);
  if (!rows) return undefined;
  const sources: RetainedProjectSource[] = [];
  const buffers = new Set<ArrayBuffer>();
  let totalBytes = 0;
  for (const row of rows) {
    const record = exactRecord(row, ["canonicalPath", "normalizedUtf8"]);
    if (!record || typeof record.canonicalPath !== "string") return undefined;
    const candidate = record.normalizedUtf8;
    if (typeof candidate !== "object" || candidate === null || !ArrayBuffer.isView(candidate)
      || candidate.byteLength > MAX_NORMALIZED_MODULE_BYTES) return undefined;
    const bytes = plainWholeBytes(candidate, boundary);
    if (!bytes || buffers.has(bytes.buffer as ArrayBuffer)) return undefined;
    let decoded: string;
    try { decoded = decoder.decode(bytes); } catch { return undefined; }
    if (decoded.startsWith("\uFEFF") || decoded.includes("\0") || decoded.includes("\r")) return undefined;
    const reencoded = encoder.encode(decoded);
    if (reencoded.byteLength !== bytes.byteLength || reencoded.some((byte, index) => byte !== bytes[index])) return undefined;
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_NORMALIZED_TOTAL_BYTES) return undefined;
    buffers.add(bytes.buffer as ArrayBuffer);
    sources.push({ canonicalPath: record.canonicalPath, normalizedUtf8: new Uint8Array(bytes) });
  }
  return sortedUniquePaths(sources) ? sources : undefined;
}

function validateSuccess(record: DataRecord, boundary: SourceByteBoundary): NodeWorkerValidation {
  const revision = validNodeRevision(record.revision) ? record.revision : undefined;
  if (!correlation(record) || !revision) return { kind: "invalid", mapping: "provider" };
  const identity = { attemptId: record.attemptId as string, generation: record.generation as number, revision };
  const result = exactRecord(record.result, ["city", "notAnalyzedFiles"]);
  if (!result) return { kind: "invalid", mapping: "provider", ...identity };
  let city: ValidatedCity | null;
  if (result.city === null) city = null;
  else {
    try { city = validateCityPayload(result.city); }
    catch { return { kind: "invalid", mapping: "city", ...identity }; }
  }
  const failures = parseFailures(result.notAnalyzedFiles);
  const sources = parseSources(record.sources, boundary);
  if (!failures || !sources) return { kind: "invalid", mapping: "provider", ...identity };
  const successfulPaths = city?.inspection.map(({ canonicalPath }) => canonicalPath) ?? [];
  if ((city === null && (successfulPaths.length !== 0 || failures.length === 0))
    || successfulPaths.length + failures.length > MAX_ADMITTED_MODULES) {
    return { kind: "invalid", mapping: "provider", ...identity };
  }
  const successful = new Set(successfulPaths);
  const failed = new Set(failures.map(({ canonicalPath }) => canonicalPath));
  if (successful.size !== successfulPaths.length || [...successful].some((path) => failed.has(path))) {
    return { kind: "invalid", mapping: "provider", ...identity };
  }
  const expectedSources = [...successfulPaths, ...failures
    .filter(({ category }) => category !== "Source text is not supported")
    .map(({ canonicalPath }) => canonicalPath)].sort(compareUnsignedUtf8);
  const sourcePaths = sources.map(({ canonicalPath }) => canonicalPath);
  if (expectedSources.length !== sourcePaths.length || expectedSources.some((path, index) => path !== sourcePaths[index])) {
    return { kind: "invalid", mapping: "provider", ...identity };
  }
  return {
    kind: "valid",
    event: {
      type: "SUCCESS", attemptId: record.attemptId as string, generation: record.generation as number, revision,
      result: { city, notAnalyzedFiles: failures }, sources,
    },
  };
}

export function validateNodeWorkerEvent(value: unknown, boundary: SourceByteBoundary = "receiver"): NodeWorkerValidation {
  const selected = exactRecord(value, ["type", "attemptId", "generation", "revision"]);
  if (selected?.type === "REVISION_SELECTED" && correlation(selected) && validNodeRevision(selected.revision)) {
    return { kind: "valid", event: { type: "REVISION_SELECTED", attemptId: selected.attemptId as string, generation: selected.generation as number, revision: selected.revision } };
  }
  const success = exactRecord(value, ["type", "attemptId", "generation", "revision", "result", "sources"]);
  if (success?.type === "SUCCESS") return validateSuccess(success, boundary);
  const coded = exactRecord(value, ["type", "attemptId", "generation", "revision", "category", "code"]);
  if (coded?.type === "FAILURE" && correlation(coded) && validNodeRevision(coded.revision) && validCode(coded.category, coded.code)) {
    return { kind: "valid", event: coded as NodeWorkerFailure };
  }
  const post = exactRecord(value, ["type", "attemptId", "generation", "revision", "category"]);
  if (post?.type === "FAILURE" && correlation(post) && validNodeRevision(post.revision)
    && (post.category === "Provider/resolution failure" || post.category === "Repository exceeds Code City limits")) {
    return { kind: "valid", event: post as NodeWorkerFailure };
  }
  const pre = exactRecord(value, ["type", "attemptId", "generation", "category"]);
  if (pre?.type === "FAILURE" && correlation(pre)
    && (pre.category === "Repository unavailable for anonymous access" || pre.category === "Revision unavailable"
      || pre.category === "Provider/resolution failure")) {
    return { kind: "valid", event: pre as NodeWorkerFailure };
  }
  const revision = typeof value === "object" && value !== null
    ? Object.getOwnPropertyDescriptor(value, "revision")?.value
    : undefined;
  return { kind: "invalid", mapping: "provider", ...(validNodeRevision(revision) ? { revision } : {}) };
}

export function successTransferList(event: NodeWorkerSuccess): ArrayBuffer[] | undefined {
  const validation = validateNodeWorkerEvent(event, "sender");
  if (validation.kind !== "valid" || validation.event.type !== "SUCCESS") return undefined;
  try {
    const buffers: ArrayBuffer[] = [];
    if (event.result.city) {
      const geometry = event.result.city.geometry;
      buffers.push(geometry.origins.buffer as ArrayBuffer, geometry.sizes.buffer as ArrayBuffer, geometry.rgba.buffer as ArrayBuffer, geometry.bounds.buffer as ArrayBuffer);
    }
    for (const source of event.sources) buffers.push(source.normalizedUtf8.buffer as ArrayBuffer);
    return new Set(buffers).size === buffers.length ? buffers : undefined;
  } catch {
    return undefined;
  }
}

export function validSuccessTransferList(event: NodeWorkerSuccess, transfer: readonly unknown[]): boolean {
  const expected = successTransferList(event);
  if (!expected || transfer.length !== expected.length) return false;
  return transfer.every((entry, index) => entry === expected[index]) && new Set(transfer).size === transfer.length;
}
