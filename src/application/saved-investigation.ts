import { validateCityPayload, type CityPayload } from "./city-payload";
import { isCanonicalSourcePath, compareUnsignedUtf8, MAX_ADMITTED_MODULES, MAX_NORMALIZED_MODULE_BYTES, MAX_NORMALIZED_TOTAL_BYTES, FIXED_EXCLUDED_SEGMENTS } from "../domain/source-admission";
import { parseInvestigationOrigin, type InvestigationOrigin } from "./investigation-origin";
// Version-3 wire vocabulary is pinned, not silently widened by future analyzers.
const EXPLICIT_UNIT_FORMS = ["function", "arrow", "method", "constructor", "getter", "setter", "static-block"];
const DECISION_KINDS = ["if", "loop", "case", "catch", "ternary", "logical-and", "logical-or", "nullish", "logical-and-assign", "logical-or-assign", "nullish-assign"];
import { parseRepositoryReference } from "../domain/repository-reference";

export const SAVE_LIMITS = Object.freeze({ header: 16 * 1_048_576, snapshot: 192 * 1_048_576, storage: 2 * 1_073_741_824, count: 1024, operationMs: 120_000 });
export async function sourceSha256(bytes: Uint8Array): Promise<string> {
  if (bytes.length === 0) return "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer)), byte => byte.toString(16).padStart(2, "0")).join("");
}
export function hasSaveCapacity(count: number, usedBytes: number, uploadBytes: number): boolean {
  return [count, usedBytes, uploadBytes].every(value => Number.isSafeInteger(value) && value >= 0)
    && count < SAVE_LIMITS.count && uploadBytes <= SAVE_LIMITS.snapshot && usedBytes + uploadBytes + 16384 <= SAVE_LIMITS.storage;
}
export const SNAPSHOT_MAGIC = new Uint8Array([67, 67, 83, 65, 86, 69, 51, 0]);
export type SavedUnit = [string, number, number, number[], number];
export type SavedContribution = [number, string, number, number];
export type SourceSection = { length: number; sha256: string };
export type SavedFile = {
  path: string; normalized: SourceSection | null;
  outcome: string; fact: { canonicalPath: string; S: number; U: number; M: number } | null;
  units: SavedUnit[]; contributions: SavedContribution[];
};
export type SavedHeader = { version: 3; analyzer: string; origin: InvestigationOrigin; exclusions: string[]; fixedExcludedSegments: string[]; hierarchy: string[]; files: SavedFile[]; city: unknown };
export type SavedRecord = { kind?: InvestigationOrigin["kind"]; id: string; savedAt: string; repository: string; ref: string; revision: string; bytes: number; sha256: string };
export const validSavedId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/u.test(value);
const integer = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
function requireValue(condition: unknown): asserts condition { if (!condition) throw new Error("Invalid saved investigation"); }
function record(value: unknown, keys: string[]): Record<string, unknown> {
  requireValue(value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  requireValue(Reflect.ownKeys(descriptors).length === keys.length && keys.every(key => descriptors[key] && "value" in descriptors[key]!));
  return value as Record<string, unknown>;
}
function list(value: unknown, max: number): unknown[] { requireValue(Array.isArray(value) && value.length <= max && Object.keys(value).length === value.length); return value; }
function section(value: unknown, max: number): SourceSection {
  const entry = record(value, ["length", "sha256"]);
  requireValue(integer(entry.length, max) && typeof entry.sha256 === "string" && /^[0-9a-f]{64}$/u.test(entry.sha256));
  return entry as SourceSection;
}
export function snapshotIdentity(header: Pick<SavedHeader, "origin">): Required<Pick<SavedRecord, "kind" | "repository" | "ref" | "revision">> {
  const origin = parseInvestigationOrigin(header.origin);
  if (origin.kind === "working-tree") return { kind: origin.kind, repository: origin.name, ref: "working tree", revision: origin.captureId };
  const repository = parseRepositoryReference(origin.repositoryUrl);
  requireValue(repository);
  return { kind: origin.kind, repository: `${repository.owner}/${repository.repository}`, ref: repository.tag === undefined ? repository.branch ?? "default branch" : `tag: ${repository.tag}`, revision: origin.revision };
}
export function parseSavedRecord(value: unknown): SavedRecord {
  const tagged = value !== null && typeof value === "object" && Object.hasOwn(value, "kind");
  const item = record(value, [...(tagged ? ["kind"] : []), "id", "savedAt", "repository", "ref", "revision", "bytes", "sha256"]);
  requireValue(!tagged || item.kind === "github" || item.kind === "working-tree");
  if (item.kind === "working-tree") {
    parseInvestigationOrigin({ kind: item.kind, name: item.repository, captureId: item.revision });
    requireValue(item.ref === "working tree");
  }
  requireValue(validSavedId(item.id) && typeof item.savedAt === "string" && item.savedAt.length <= 32 && new Date(item.savedAt).toISOString() === item.savedAt);
  for (const [key, maximum] of [["repository", 1024], ["ref", 4096]] as const) requireValue(typeof item[key] === "string" && item[key].length > 0 && item[key].length <= maximum && item[key].isWellFormed() && !/[\u0000-\u001f\u007f]/u.test(item[key]));
  requireValue(typeof item.revision === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(item.revision) && typeof item.sha256 === "string" && /^[0-9a-f]{64}$/u.test(item.sha256) && integer(item.bytes, SAVE_LIMITS.snapshot) && item.bytes > 12);
  return item as SavedRecord;
}
export function snapshotCity(value: unknown): ReturnType<typeof validateCityPayload> | null {
  if (value === null) return null;
  const city = record(value, ["geometry", "inspection"]);
  const geometry = record(city.geometry, ["kind", "count", "origins", "sizes", "rgba", "bounds"]);
  requireValue(integer(geometry.count, MAX_ADMITTED_MODULES) && geometry.count > 0);
  for (const [key, length] of [["origins", geometry.count * 3], ["sizes", geometry.count * 3], ["bounds", 6], ["rgba", geometry.count * 4]] as const) {
    const values = list(geometry[key], length);
    requireValue(values.length === length && values.every(item => typeof item === "number" && Number.isFinite(item)
      && (key === "rgba" ? integer(item, 255) : Math.fround(item) === item)));
  }
  return validateCityPayload({ geometry: { ...geometry, origins: Float32Array.from(geometry.origins as number[]), sizes: Float32Array.from(geometry.sizes as number[]), rgba: Uint8Array.from(geometry.rgba as number[]), bounds: Float32Array.from(geometry.bounds as number[]) }, inspection: city.inspection });
}
export function cityForSnapshot(city: CityPayload | null): unknown {
  if (city === null) return null;
  return { geometry: { ...city.geometry, origins: Array.from(city.geometry.origins), sizes: Array.from(city.geometry.sizes), rgba: Array.from(city.geometry.rgba), bounds: Array.from(city.geometry.bounds) }, inspection: city.inspection };
}
export function validateSavedHeader(value: unknown): { header: SavedHeader; sections: SourceSection[]; payloadBytes: number } {
  const data = record(value, ["version", "analyzer", "origin", "exclusions", "fixedExcludedSegments", "hierarchy", "files", "city"]);
  requireValue(typeof data.analyzer === "string" && /^[0-9a-f]{64}$/u.test(data.analyzer));
  requireValue(data.version === 3);
  parseInvestigationOrigin(data.origin);
  for (const field of ["exclusions", "hierarchy"] as const) requireValue(list(data[field], 100_000).every(path => typeof path === "string" && (field === "hierarchy" || path.length <= 4096) && path.isWellFormed()));
  requireValue(JSON.stringify(data.fixedExcludedSegments) === JSON.stringify(FIXED_EXCLUDED_SEGMENTS));
  const files = list(data.files, MAX_ADMITTED_MODULES);
  requireValue(files.length > 0);
  const sections: SourceSection[] = [];
  let normalizedTotal = 0, prior = "";
  const successful = new Map<string, unknown>();
  for (const file of files) {
    const entry = record(file, ["path", "normalized", "outcome", "fact", "units", "contributions"]);
    requireValue(typeof entry.path === "string" && isCanonicalSourcePath(entry.path) && (!prior || compareUnsignedUtf8(prior, entry.path) < 0)); prior = entry.path;
    const normalized = entry.normalized === null ? null : section(entry.normalized, MAX_NORMALIZED_MODULE_BYTES);
    if (normalized) { normalizedTotal += normalized.length; sections.push(normalized); }
    requireValue(["success", "Source text is not supported", "Syntax could not be analyzed", "Metrics could not be computed"].includes(entry.outcome as string));
    requireValue((entry.outcome === "Source text is not supported") === (normalized === null));
    const units = list(entry.units, 500_000), contributions = list(entry.contributions, 1_000_000);
    if (entry.outcome !== "success") { requireValue(entry.fact === null && units.length === 0 && contributions.length === 0); continue; }
    requireValue(normalized !== null);
    const fact = record(entry.fact, ["canonicalPath", "S", "U", "M"]);
    requireValue(fact.canonicalPath === entry.path && [fact.S, fact.U, fact.M].every(item => integer(item)) && fact.U === units.length);
    successful.set(entry.path, entry.fact);
    for (const unit of units) {
      requireValue(Array.isArray(unit) && unit.length === 5);
      requireValue((unit[0] === "top-level" || (EXPLICIT_UNIT_FORMS as readonly unknown[]).includes(unit[0])) && integer(unit[1], normalized.length) && integer(unit[2], normalized.length) && unit[1] <= unit[2] && integer(unit[4]) && unit[4] >= 1);
      const regions = list(unit[3], 1_000_000);
      requireValue(regions.length % 2 === 0 && regions.every(item => integer(item, normalized.length)));
      for (let index = 0; index < regions.length; index += 2) requireValue((regions[index] as number) >= unit[1] && (regions[index + 1] as number) <= unit[2] && (regions[index] as number) < (regions[index + 1] as number));
    }
    for (const contribution of contributions) {
      requireValue(Array.isArray(contribution) && contribution.length === 4 && integer(contribution[0], units.length - 1) && (DECISION_KINDS as readonly unknown[]).includes(contribution[1]) && integer(contribution[2], normalized.length) && integer(contribution[3], normalized.length) && contribution[2] < contribution[3]);
      const owner = units[contribution[0]] as SavedUnit;
      requireValue(owner[0] === "top-level" || owner[3].some((start, index, regions) => index % 2 === 0 && contribution[2] >= start && contribution[3] <= regions[index + 1]!));
    }
  }
  const hierarchy = new Set<string>();
  for (const file of files as SavedFile[]) { const parts = file.path.split("/"); for (let index = 1; index < parts.length; index++) hierarchy.add(parts.slice(0, index).join("/")); }
  requireValue(JSON.stringify(data.hierarchy) === JSON.stringify([...hierarchy].sort(compareUnsignedUtf8)));
  requireValue(normalizedTotal <= MAX_NORMALIZED_TOTAL_BYTES);
  const city = snapshotCity(data.city);
  requireValue(city ? city.inspection.length === successful.size && city.inspection.every(fact => JSON.stringify(fact) === JSON.stringify(successful.get(fact.canonicalPath))) : successful.size === 0);
  return { header: data as unknown as SavedHeader, sections, payloadBytes: normalizedTotal };
}
export function snapshotPrefix(headerBytes: Uint8Array): Uint8Array<ArrayBuffer> {
  if (headerBytes.length > SAVE_LIMITS.header) throw new Error("Investigation exceeds Save limits");
  const prefix = new Uint8Array(12); prefix.set(SNAPSHOT_MAGIC); new DataView(prefix.buffer).setUint32(8, headerBytes.length, false); return prefix;
}
export function snapshotHeaderLength(prefix: Uint8Array): number {
  if (prefix.length === 12 && SNAPSHOT_MAGIC.slice(0, 6).every((byte, index) => prefix[index] === byte) && prefix[6] !== SNAPSHOT_MAGIC[6]) throw new Error("Unsupported saved investigation version");
  requireValue(prefix.length === 12 && SNAPSHOT_MAGIC.every((byte, index) => prefix[index] === byte));
  const length = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength).getUint32(8, false); requireValue(length > 0 && length <= SAVE_LIMITS.header); return length;
}
export async function decodeSnapshot(bytes: Uint8Array): Promise<{ header: SavedHeader; sourceBytes: Uint8Array[] }> {
  requireValue(bytes.length <= SAVE_LIMITS.snapshot);
  const length = snapshotHeaderLength(bytes.subarray(0, 12));
  const { header, sections, payloadBytes } = validateSavedHeader(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(12, 12 + length))));
  requireValue(bytes.length === 12 + length + payloadBytes);
  let offset = 12 + length;
  const sourceBytes: Uint8Array[] = [];
  for (const entry of sections) {
    const content = Uint8Array.from(bytes.subarray(offset, offset + entry.length)); offset += entry.length;
    const digest = await sourceSha256(content);
    requireValue(digest === entry.sha256); sourceBytes.push(content);
  }
  let sectionIndex = 0;
  for (const file of header.files) if (file.normalized) validateNormalizedSource(file, sourceBytes[sectionIndex++]!);
  return { header, sourceBytes };
}

/** Structural/text validation only; neither metric recomputation nor provenance certification. */
export function validateNormalizedSource(file: SavedFile, bytes: Uint8Array): void {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  requireValue(!text.includes("\0") && !text.includes("\r") && !(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf));
  const boundary = (index: number) => index === bytes.length || (bytes[index]! & 0xc0) !== 0x80;
  for (const unit of file.units) requireValue(boundary(unit[1]) && boundary(unit[2]) && unit[3].every(boundary));
  for (const contribution of file.contributions) requireValue(boundary(contribution[2]) && boundary(contribution[3]));
}
