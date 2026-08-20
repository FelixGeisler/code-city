export const SUPPORTED_SUFFIXES = [
  ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts",
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

function compareUnsignedUtf8(left: string, right: string): number {
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

function hasAncestor(path: string, ancestors: ReadonlySet<string>): boolean {
  let separator = path.lastIndexOf("/");
  while (separator >= 0) {
    if (ancestors.has(path.slice(0, separator))) {
      return true;
    }
    separator = path.lastIndexOf("/", separator - 1);
  }
  return false;
}

export function prepareSourceInventory(entries: readonly ProjectedTreeEntry[]): InventoryAdmissionResult {
  const rawIdentities = new Set<string>();
  const canonicalIdentities = new Set<string>();
  const validated: ValidatedEntry[] = [];

  for (const entry of entries) {
    const path = validatePath(entry.path);
    if (!path || rawIdentities.has(path.rawPath) || canonicalIdentities.has(path.canonicalPath)) {
      return failure("Source admission failed", "M1-ADM-1");
    }
    rawIdentities.add(path.rawPath);
    canonicalIdentities.add(path.canonicalPath);
    validated.push({ ...path, mode: entry.mode, type: entry.type, ...(entry.sha === undefined ? {} : { sha: entry.sha }) });
  }

  const boundaries = new Set<string>();
  const regularFiles = new Set<string>();
  for (const entry of validated) {
    if ((entry.mode === "120000" && entry.type === "blob")
      || (entry.mode === "160000" && entry.type === "commit")) {
      boundaries.add(entry.canonicalPath);
    } else if ((entry.mode === "100644" || entry.mode === "100755") && entry.type === "blob") {
      regularFiles.add(entry.canonicalPath);
    }
  }

  const candidates: SourceCandidate[] = [];
  let qualifyingSkippedEntry = false;
  for (const entry of validated) {
    if (hasAncestor(entry.canonicalPath, boundaries)) {
      continue;
    }
    if (hasAncestor(entry.canonicalPath, regularFiles)) {
      return failure("Source admission failed", "M1-ADM-3");
    }

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
    if (entry.mode === "040000" && entry.type === "tree") {
      qualifyingSkippedEntry ||= supported;
      continue;
    }
    if (entry.mode === "120000" && entry.type === "blob") {
      qualifyingSkippedEntry ||= supported;
      continue;
    }
    if (entry.mode === "160000" && entry.type === "commit") {
      continue;
    }
    return failure("Source admission failed", "M1-ADM-3");
  }

  candidates.sort((left, right) => compareUnsignedUtf8(left.canonicalPath, right.canonicalPath));
  return candidates.length === 0
    ? failure("No supported modules", qualifyingSkippedEntry ? "ADM-07" : "ADM-06")
    : { kind: "candidates", candidates };
}

export type SourceAdmissionSession = Readonly<{
  add(candidate: SourceCandidate, decodedSource: string): AdmissionFailure | undefined;
  complete(): readonly AdmittedModule[];
}>;

export function createSourceAdmissionSession(): SourceAdmissionSession {
  const modules: AdmittedModule[] = [];
  let normalizedTotalBytes = 0;

  return {
    add(candidate, decodedSource) {
      let normalizedSource = decodedSource.startsWith("\uFEFF") ? decodedSource.slice(1) : decodedSource;
      if (normalizedSource.includes("\0")) {
        return failure("Source admission failed", "M1-ADM-4");
      }
      normalizedSource = normalizedSource.replace(/\r\n?/g, "\n");
      const normalizedBytes = textEncoder.encode(normalizedSource).byteLength;
      if (normalizedBytes > MAX_NORMALIZED_MODULE_BYTES
        || normalizedTotalBytes + normalizedBytes > MAX_NORMALIZED_TOTAL_BYTES
        || modules.length >= MAX_ADMITTED_MODULES) {
        return failure("Repository exceeds Code City limits");
      }
      normalizedTotalBytes += normalizedBytes;
      modules.push({ canonicalPath: candidate.canonicalPath, normalizedSource });
      return undefined;
    },
    complete: () => modules,
  };
}
