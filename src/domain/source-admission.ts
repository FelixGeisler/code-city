import { automaticRootPaths, excludedDirectory, exclusionSettings, automaticRule, manuallyExcluded, recordExclusionPolicy, type ExclusionInput, type ExclusionReport, type ExclusionSettings } from "./exclusion-policy";

export const SUPPORTED_SUFFIXES = [
  ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".cs",
] as const;

export const MAX_ADMITTED_MODULES = 4_000;
export const MAX_NORMALIZED_MODULE_BYTES = 2_097_152;
export const MAX_NORMALIZED_TOTAL_BYTES = 41_943_040;

export type ProjectedTreeEntry = Readonly<{
  path: string;
  mode: string;
  type: string;
  sha?: string;
}>;

export type SourceCandidate = Readonly<{
  canonicalPath: string;
  rawPath: string;
  expectedBlobId?: string;
}>;

export type AdmittedModule = Readonly<{
  canonicalPath: string;
  normalizedSource: string;
}>;

export type AdmissionCode = "ADM-06" | "ADM-07" | "M1-ADM-1" | "M1-ADM-3" | "M1-ADM-4";

export type AdmissionFailure = Readonly<{
  kind: "failure";
  category: "No supported modules" | "Source admission failed" | "Repository exceeds Code City limits";
  code?: AdmissionCode;
}>;

export type InventoryAdmissionResult =
  | Readonly<{ kind: "candidates"; candidates: readonly SourceCandidate[] }>
  | AdmissionFailure;

const PATH_CONTROL = /\p{Cc}/u;
const DRIVE_PATH = /^[A-Za-z]:/;
const textEncoder = new TextEncoder();

type ValidatedEntry = Readonly<{
  canonicalPath: string;
  mode: string;
  rawPath: string;
  sha?: string;
  type: string;
}>;

function failure(category: AdmissionFailure["category"], code?: AdmissionCode): AdmissionFailure {
  return code === undefined ? { kind: "failure", category } : { kind: "failure", category, code };
}

export function hasSupportedSuffix(path: string): boolean {
  const finalSegment = path.slice(path.lastIndexOf("/") + 1).replace(/[A-Z]/g, (character) => (
    String.fromCharCode(character.charCodeAt(0) + 32)
  ));
  return SUPPORTED_SUFFIXES.some((suffix) => finalSegment.endsWith(suffix));
}

function validatePath(path: string): Readonly<{ rawPath: string; canonicalPath: string }> | undefined {
  if (!path.isWellFormed()
    || path.length === 0
    || path.startsWith("/")
    || DRIVE_PATH.test(path)
    || path.includes("\\")
    || path.endsWith("/")
    || /\/\//.test(path)
    || PATH_CONTROL.test(path)) {
    return undefined;
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return undefined;
  }
  return {
    rawPath: path,
    canonicalPath: segments.map((segment) => segment.normalize("NFC")).join("/"),
  };
}

export function isCanonicalPath(path: string): boolean {
  const validated = validatePath(path);
  return validated?.canonicalPath === path;
}

export function isCanonicalSourcePath(path: string): boolean {
  return isCanonicalPath(path) && hasSupportedSuffix(path);
}

export function compareUnsignedUtf8(left: string, right: string): number {
  const leftBytes = textEncoder.encode(left);
  const rightBytes = textEncoder.encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftBytes[index] ?? 0) - (rightBytes[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return leftBytes.length - rightBytes.length;
}

export function parseAdditionalExclusions(text: string): readonly string[] | undefined {
  const paths: string[] = [];
  const identities = new Set<string>();
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (line.length === 0) continue;
    if (!isCanonicalPath(line) || identities.has(line)) return undefined;
    identities.add(line);
    paths.push(line);
  }
  paths.sort(compareUnsignedUtf8);
  return Object.freeze(paths);
}

export function isCanonicalAdditionalExclusions(paths: readonly string[]): boolean {
  let prior: string | undefined;
  const identities = new Set<string>();
  for (const path of paths) {
    if (!isCanonicalPath(path) || identities.has(path)
      || (prior !== undefined && compareUnsignedUtf8(prior, path) >= 0)) return false;
    identities.add(path);
    prior = path;
  }
  return true;
}

function isSupportedKind(entry: ValidatedEntry): boolean {
  return ((entry.mode === "100644" || entry.mode === "100755") && entry.type === "blob")
    || (entry.mode === "040000" && entry.type === "tree")
    || (entry.mode === "120000" && entry.type === "blob")
    || (entry.mode === "160000" && entry.type === "commit");
}

function isTree(entry: ValidatedEntry | undefined): boolean {
  return entry?.mode === "040000" && entry.type === "tree";
}

export function isExcludedSourcePath(path: string, input: ExclusionInput): boolean {
  const settings: ExclusionSettings = Array.isArray(input) ? { manual: input, included: [] } : input as ExclusionSettings;
  if (manuallyExcluded(path, settings.manual)) return true;
  return automaticRootPaths(path).some(root => !settings.included.includes(root));
}

export function prepareSourceInventory(
  entries: readonly ProjectedTreeEntry[],
  additionalExclusions: ExclusionInput = Object.freeze([]),
  report: ExclusionReport = () => {},
): InventoryAdmissionResult {
  const settings = exclusionSettings(additionalExclusions);
  const rawIdentities = new Set<string>();
  const canonicalIdentities = new Set<string>();
  const rawEntries = new Map<string, ValidatedEntry>();
  const validated: ValidatedEntry[] = [];

  for (const entry of entries) {
    const path = validatePath(entry.path);
    if (!path || rawIdentities.has(path.rawPath) || canonicalIdentities.has(path.canonicalPath)) {
      return failure("Source admission failed", "M1-ADM-1");
    }
    const candidate = { ...path, mode: entry.mode, type: entry.type, ...(entry.sha === undefined ? {} : { sha: entry.sha }) };
    if (!isSupportedKind(candidate)) return failure("Source admission failed", "M1-ADM-3");
    rawIdentities.add(path.rawPath);
    canonicalIdentities.add(path.canonicalPath);
    rawEntries.set(path.rawPath, candidate);
    validated.push(candidate);
  }

  for (const entry of validated) {
    let separator = entry.rawPath.lastIndexOf("/");
    while (separator >= 0) {
      if (!isTree(rawEntries.get(entry.rawPath.slice(0, separator)))) {
        return failure("Source admission failed", "M1-ADM-3");
      }
      separator = entry.rawPath.lastIndexOf("/", separator - 1);
    }
  }

  const roots: [string, string][] = [];
  const pruned: string[] = [];
  for (const entry of [...validated].sort((a, b) => compareUnsignedUtf8(a.canonicalPath, b.canonicalPath))) {
    if (!isTree(entry) || pruned.some(root => entry.canonicalPath.startsWith(`${root}/`))) continue;
    const rule = automaticRule(entry.canonicalPath);
    if (rule) roots.push([entry.canonicalPath, rule.id]);
    if (excludedDirectory(entry.canonicalPath, settings)) pruned.push(entry.canonicalPath);
  }
  report(recordExclusionPolicy(settings, roots), true);
  const candidates: SourceCandidate[] = [];
  let qualifyingSkippedEntry = false;
  for (const entry of validated) {
    if (isExcludedSourcePath(entry.canonicalPath, additionalExclusions)) continue;
    const supported = hasSupportedSuffix(entry.canonicalPath);
    if ((entry.mode === "100644" || entry.mode === "100755") && entry.type === "blob") {
      if (supported) {
        candidates.push({
          canonicalPath: entry.canonicalPath,
          rawPath: entry.rawPath,
          ...(entry.sha === undefined ? {} : { expectedBlobId: entry.sha }),
        });
      }
      continue;
    }
    if ((entry.mode === "040000" && entry.type === "tree")
      || (entry.mode === "120000" && entry.type === "blob")) {
      qualifyingSkippedEntry ||= supported;
    }
  }

  candidates.sort((left, right) => compareUnsignedUtf8(left.canonicalPath, right.canonicalPath));
  return candidates.length === 0
    ? failure("No supported modules", qualifyingSkippedEntry ? "ADM-07" : "ADM-06")
    : { kind: "candidates", candidates };
}

export type NormalizedSourceText = Readonly<{
  normalizedSource: string;
  normalizedUtf8: Uint8Array;
}>;

export function normalizeSourceText(decodedSource: string): NormalizedSourceText | undefined {
  let normalizedSource = decodedSource.startsWith("\uFEFF") ? decodedSource.slice(1) : decodedSource;
  if (normalizedSource.includes("\0")) return undefined;
  normalizedSource = normalizedSource.replace(/\r\n?/g, "\n");
  const normalizedUtf8 = new Uint8Array(textEncoder.encode(normalizedSource));
  return { normalizedSource, normalizedUtf8 };
}

export type SourceAdmissionSession = Readonly<{
  add(candidate: SourceCandidate, decodedSource: string): AdmissionFailure | undefined;
  complete(): AdmittedModule[];
}>;

export function createSourceAdmissionSession(): SourceAdmissionSession {
  const modules: AdmittedModule[] = [];
  let normalizedTotalBytes = 0;

  return {
    add(candidate, decodedSource) {
      const normalized = normalizeSourceText(decodedSource);
      if (!normalized) return failure("Source admission failed", "M1-ADM-4");
      const normalizedBytes = normalized.normalizedUtf8.byteLength;
      if (normalizedBytes > MAX_NORMALIZED_MODULE_BYTES
        || normalizedTotalBytes + normalizedBytes > MAX_NORMALIZED_TOTAL_BYTES
        || modules.length >= MAX_ADMITTED_MODULES) {
        return failure("Repository exceeds Code City limits");
      }
      normalizedTotalBytes += normalizedBytes;
      modules.push({ canonicalPath: candidate.canonicalPath, normalizedSource: normalized.normalizedSource });
      return undefined;
    },
    complete: () => modules,
  };
}
