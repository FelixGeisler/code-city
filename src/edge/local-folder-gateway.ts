import {
  isLocalMetadataPath,
  MAX_LOCAL_RAW_BYTES,
  type LocalRawReadResult,
  type LocalSourceCandidate,
  type LocalSourceFailure,
  type LocalWorkingTreeGateway,
} from "../application/local-source";
import {
  hasSupportedSuffix,
  isCanonicalAdditionalExclusions,
  isCanonicalPath,
  isExcludedSourcePath,
  MAX_ADMITTED_MODULES,
} from "../domain/source-admission";

// Structural native API boundary: do not require a realm-specific instanceof check.
// Only these read capabilities are used; no permission requests, writes or network fallback.
type Directory = { kind: "directory"; values(): AsyncIterableIterator<unknown> };
type FileHandle = { kind: "file"; getFile(): Promise<File> };
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function directory(value: unknown): value is Directory {
  return object(value) && value.kind === "directory" && typeof value.values === "function";
}
const unavailable = (): LocalSourceFailure => ({ kind: "failure", category: "Local working tree unavailable" });
const limit = (): LocalSourceFailure => ({ kind: "failure", category: "Repository exceeds Code City limits" });
const invalidPath = (): LocalSourceFailure => ({ kind: "failure", category: "Source admission failed", code: "M1-ADM-1" });

/** getFile snapshots can report OS changes through stream errors; also reject changed size/mtime after reading. */
async function readFile(handle: FileHandle, signal: AbortSignal): Promise<LocalRawReadResult> {
  if (signal.aborted) return { kind: "unavailable" };
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let cancellation: Promise<void> | undefined;
  let complete = false;
  const cancel = (): void => {
    if (reader && !cancellation) {
      try { cancellation = Promise.resolve(reader.cancel()).catch(() => {}); }
      catch { cancellation = Promise.resolve(); }
    }
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const file = await handle.getFile();
    if (signal.aborted) return { kind: "unavailable" };
    const size = file.size;
    const modified = file.lastModified;
    if (!Number.isSafeInteger(size) || size < 0 || !Number.isFinite(modified)) return { kind: "unavailable" };
    if (size > MAX_LOCAL_RAW_BYTES) return { kind: "product-limit" };
    reader = file.stream().getReader();
    if (signal.aborted) { cancel(); return { kind: "unavailable" }; }
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const next = await reader.read();
      if (signal.aborted) return { kind: "unavailable" };
      if (next.done) { complete = true; break; }
      if (!(next.value instanceof Uint8Array)) return { kind: "unavailable" };
      if (next.value.byteLength > MAX_LOCAL_RAW_BYTES - total) return { kind: "product-limit" };
      total += next.value.byteLength;
      chunks.push(next.value);
    }
    if (total !== size) return { kind: "unavailable" };
    const after = await handle.getFile();
    if (signal.aborted || after.size !== size || after.lastModified !== modified) return { kind: "unavailable" };
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return { kind: "source", rawBytes: bytes };
  } catch {
    return { kind: "unavailable" };
  } finally {
    if (!complete) cancel();
    await cancellation;
    reader?.releaseLock();
    signal.removeEventListener("abort", cancel);
  }
}

type Frame = {
  rawPath: string;
  iterator: AsyncIterableIterator<unknown>;
  names: Set<string>;
};

/**
 * Iterative, read-only native directory traversal. Excluded directories are never entered:
 * values() and getFile() are not called for .git (any case), fixed or user exclusions.
 * Only eligible file capabilities are retained, bounded by 4,000; never materializes a FileList.
 * Each inventory owns independent read closures, so replacement cannot alias an earlier capture.
 * Native File System Access controls physical/link visibility; this gateway never resolves links.
 */
export function createLocalFolderGateway(root: unknown): LocalWorkingTreeGateway {
  return {
    async loadInventory(exclusions, signal) {
      const stack: Frame[] = [];
      const candidates: LocalSourceCandidate[] = [];
      let skippedSupportedDirectory = false;
      try {
        if (signal.aborted || !directory(root) || !isCanonicalAdditionalExclusions(exclusions)) return unavailable();
        stack.push({ rawPath: "", iterator: root.values(), names: new Set() });
        while (stack.length > 0) {
          if (signal.aborted) return unavailable();
          const frame = stack[stack.length - 1]!;
          const next = await frame.iterator.next();
          if (signal.aborted) return unavailable();
          if (next.done) { stack.pop(); continue; }
          const entry = next.value;
          if (!object(entry) || typeof entry.name !== "string") return invalidPath();
          const name = entry.name;
          const canonicalName = name.normalize("NFC");
          const rawPath = frame.rawPath ? `${frame.rawPath}/${name}` : name;
          const canonicalPath = rawPath.normalize("NFC");
          // A drive prefix is invalid only at the start of the complete relative path.
          // Native nested names such as src/C:example.ts remain ordinary segments.
          if (name.length === 0 || name.includes("/") || !isCanonicalPath(canonicalPath)
            || frame.names.has(canonicalName)) return invalidPath();
          frame.names.add(canonicalName);
          if (isLocalMetadataPath(canonicalPath) || isExcludedSourcePath(canonicalPath, exclusions)) continue;
          if (entry.kind === "directory") {
            if (!directory(entry)) return unavailable();
            skippedSupportedDirectory ||= hasSupportedSuffix(canonicalPath);
            stack.push({ rawPath, iterator: entry.values(), names: new Set() });
          } else if (entry.kind === "file") {
            if (!hasSupportedSuffix(canonicalPath)) continue;
            if (typeof entry.getFile !== "function") return unavailable();
            const handle = entry as unknown as FileHandle;
            candidates.push({ rawPath, canonicalPath, readRawSource: signal => readFile(handle, signal) });
            if (candidates.length > MAX_ADMITTED_MODULES) return limit();
          } else return unavailable();
        }
        if (candidates.length === 0) return {
          kind: "failure", category: "No supported modules", code: skippedSupportedDirectory ? "ADM-07" : "ADM-06",
        };
        return { kind: "inventory", candidates };
      } catch {
        return unavailable();
      } finally {
        // Close even on invalid paths, enumeration errors, limits or cancellation; no iterator is abandoned.
        for (const frame of stack.reverse()) {
          try { await frame.iterator.return?.(); } catch { /* Preserve the original sanitized failure. */ }
        }
      }
    },
  };
}
