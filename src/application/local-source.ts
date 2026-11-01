import {
  compareUnsignedUtf8,
  FIXED_EXCLUDED_SEGMENTS,
  hasSupportedSuffix,
  isCanonicalAdditionalExclusions,
  isCanonicalPath,
  isExcludedSourcePath,
  MAX_ADMITTED_MODULES,
  MAX_NORMALIZED_MODULE_BYTES,
  MAX_NORMALIZED_TOTAL_BYTES,
  normalizeSourceText,
  SUPPORTED_SUFFIXES,
} from "../domain/source-admission";
import { validWorkingTreeName, type WorkingTreeInvestigationOrigin } from "./investigation-origin";
import type { AcquiredProjectSources, SourceFailure } from "./source-retrieval";

export const MAX_LOCAL_RAW_BYTES = 4_194_307;
export type LocalSourceFailure = SourceFailure | Readonly<{ kind: "failure"; category: "Local working tree unavailable" }>;
export type LocalRawReadResult =
  | Readonly<{ kind: "source"; rawBytes: Uint8Array }>
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{ kind: "product-limit" }>;

/** A per-inventory capability: implementations must settle on abort and retain no shared mutable capture state. */
export type LocalSourceCandidate = Readonly<{
  rawPath: string;
  canonicalPath: string;
  readRawSource(signal: AbortSignal): Promise<LocalRawReadResult>;
}>;

/** Pure application port; no native handles, repository URLs or Git object identities. */
export type LocalWorkingTreeGateway = Readonly<{
  loadInventory(exclusions: readonly string[], signal: AbortSignal): Promise<
    | Readonly<{ kind: "inventory"; candidates: readonly LocalSourceCandidate[] }>
    | LocalSourceFailure
  >;
}>;
export type LocalWorkingTreeResult =
  | Readonly<{ kind: "success"; origin: WorkingTreeInvestigationOrigin; acquired: AcquiredProjectSources }>
  | Readonly<{ kind: "cancelled" }>
  | LocalSourceFailure;

const unavailable = (): LocalSourceFailure => ({ kind: "failure", category: "Local working tree unavailable" });
const limit = (): LocalSourceFailure => ({ kind: "failure", category: "Repository exceeds Code City limits" });
const invalidPath = (): LocalSourceFailure => ({ kind: "failure", category: "Source admission failed", code: "M1-ADM-1" });

export function isLocalMetadataPath(path: string): boolean {
  return path.split("/").some(segment => segment.toLowerCase() === ".git");
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

type Slot = {
  controller: AbortController;
  settled: Promise<void>;
  outcome?: LocalRawReadResult;
};

/**
 * Captures a non-atomic working tree before parsing. Progress is canonical consumed candidates,
 * including unsupported text, from (0,total) to (total,total); total never exceeds 4,000.
 *
 * Identity v1 is SHA-256 of UTF-8 JSON {version,policy,files}. files are canonical-order
 * [NFC path, actual raw byte length, SHA-256(raw bytes)] tuples, including unsupported text.
 * Policy includes suffixes, fixed exclusions, case-insensitive .git pruning and user exclusions.
 * Root display name and file timestamps are deliberately not content identity.
 */
export async function acquireLocalWorkingTree(
  name: string,
  exclusions: readonly string[],
  signal: AbortSignal,
  gateway: LocalWorkingTreeGateway,
  onProgress: (completed: number, total: number) => void = () => {},
): Promise<LocalWorkingTreeResult> {
  if (signal.aborted) return { kind: "cancelled" };
  if (!validWorkingTreeName(name) || !isCanonicalAdditionalExclusions(exclusions)) return unavailable();
  const policyExclusions = Object.freeze([...exclusions]);
  const modules: AcquiredProjectSources["modules"] = [];
  const notAnalyzedFiles: AcquiredProjectSources["notAnalyzedFiles"] = [];
  const files: [string, number, string][] = [];
  const slots = new Map<number, Slot>();
  let stopped = false;
  let failureHorizon = Infinity;
  const abortOwned = (): void => {
    stopped = true;
    for (const slot of slots.values()) slot.controller.abort();
  };
  signal.addEventListener("abort", abortOwned, { once: true });
  let result: LocalWorkingTreeResult = unavailable();
  const capture = async (): Promise<LocalWorkingTreeResult> => {
    const inventory = await gateway.loadInventory(policyExclusions, signal);
    if (signal.aborted) return { kind: "cancelled" };
    if (inventory.kind !== "inventory") return inventory;
    const candidates: LocalSourceCandidate[] = [];
    const rawPaths = new Set<string>();
    const canonicalPaths = new Set<string>();
    for (const candidate of inventory.candidates) {
      if (typeof candidate.rawPath !== "string" || typeof candidate.canonicalPath !== "string"
        || !isCanonicalPath(candidate.rawPath.normalize("NFC"))
        || candidate.rawPath.normalize("NFC") !== candidate.canonicalPath
        || rawPaths.has(candidate.rawPath) || canonicalPaths.has(candidate.canonicalPath)) return invalidPath();
      rawPaths.add(candidate.rawPath);
      canonicalPaths.add(candidate.canonicalPath);
      if (!hasSupportedSuffix(candidate.canonicalPath) || isLocalMetadataPath(candidate.canonicalPath)
        || isExcludedSourcePath(candidate.canonicalPath, policyExclusions)) continue;
      candidates.push(candidate);
    }
    candidates.sort((a, b) => compareUnsignedUtf8(a.canonicalPath, b.canonicalPath));
    if (candidates.length > MAX_ADMITTED_MODULES) return limit();
    if (candidates.length === 0) return { kind: "failure", category: "No supported modules", code: "ADM-06" };
    let next = 0;
    let normalizedTotal = 0;
    const fill = (): void => {
      while (!stopped && !signal.aborted && next < candidates.length && slots.size < 8) {
        const index = next++;
        const slot: Slot = { controller: new AbortController(), settled: Promise.resolve() };
        slots.set(index, slot);
        const settle = (outcome: LocalRawReadResult): void => {
          if (signal.aborted || index > failureHorizon) return;
          slot.outcome = outcome;
          if (outcome.kind !== "source") {
            stopped = true;
            failureHorizon = Math.min(failureHorizon, index);
            for (const [later, owned] of slots) {
              if (later > failureHorizon) {
                owned.outcome = undefined;
                owned.controller.abort();
              }
            }
          }
        };
        // Install the slot before calling even synchronously throwing implementations.
        try {
          slot.settled = Promise.resolve(candidates[index]!.readRawSource(slot.controller.signal))
            .then(value => {
              if (value.kind === "source" && value.rawBytes instanceof Uint8Array) {
                settle(value.rawBytes.byteLength > MAX_LOCAL_RAW_BYTES ? { kind: "product-limit" } : value);
              } else settle(value.kind === "product-limit" ? value : { kind: "unavailable" });
            }, () => settle({ kind: "unavailable" }))
            .catch(() => settle({ kind: "unavailable" }));
        } catch {
          settle({ kind: "unavailable" });
        }
      }
    };
    onProgress(0, candidates.length);
    fill();
    let completed = 0;
    for (let index = 0; index < candidates.length; index++) {
      if (signal.aborted) break;
      const slot = slots.get(index);
      if (!slot) break;
      await slot.settled;
      if (signal.aborted) break;
      const outcome = slot.outcome;
      slot.outcome = undefined;
      if (!outcome || outcome.kind !== "source") {
        result = outcome?.kind === "product-limit" ? limit() : unavailable();
        break;
      }
      const path = candidates[index]!.canonicalPath;
      files.push([path, outcome.rawBytes.byteLength, await sha256(outcome.rawBytes)]);
      if (signal.aborted) break;
      let normalized;
      try {
        normalized = normalizeSourceText(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(outcome.rawBytes));
      } catch { /* Invalid UTF-8 is a supported per-file continuation. */ }
      if (!normalized) {
        notAnalyzedFiles.push({ canonicalPath: path, category: "Source text is not supported" });
      } else {
        const length = normalized.normalizedUtf8.byteLength;
        if (length > MAX_NORMALIZED_MODULE_BYTES || normalizedTotal + length > MAX_NORMALIZED_TOTAL_BYTES) {
          result = limit();
          break;
        }
        normalizedTotal += length;
        modules.push({ canonicalPath: path, ...normalized });
      }
      slots.delete(index);
      completed++;
      onProgress(completed, candidates.length);
      fill();
    }
    if (completed === candidates.length && !signal.aborted) {
      const manifest = {
        version: "code-city-working-tree-v1",
        policy: {
          supportedSuffixes: SUPPORTED_SUFFIXES,
          fixedExcludedSegments: FIXED_EXCLUDED_SEGMENTS,
          metadata: "case-insensitive-.git-at-every-depth",
          exclusions: policyExclusions,
        },
        files,
      };
      const captureId = await sha256(new TextEncoder().encode(JSON.stringify(manifest)));
      result = {
        kind: "success", origin: { kind: "working-tree", name, captureId },
        acquired: { kind: "acquired", selected: captureId, modules, notAnalyzedFiles },
      };
    }
    return result;
  };
  try {
    result = await capture();
  } catch {
    result = unavailable();
  } finally {
    abortOwned();
    await Promise.all([...slots.values()].map(slot => slot.settled));
    slots.clear();
    signal.removeEventListener("abort", abortOwned);
  }
  if (signal.aborted) result = { kind: "cancelled" };
  if (result.kind !== "success") {
    modules.length = 0;
    notAnalyzedFiles.length = 0;
  }
  return result;
}
