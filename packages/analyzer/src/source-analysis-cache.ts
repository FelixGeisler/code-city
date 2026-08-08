import { createHash } from "node:crypto";

import type {
  ExecutableUnitMetric,
  MetricMethod,
  SourceMetrics,
  SourceStructure,
} from "../../core/src/model.js";
import type { StaticImportFact } from "./types.js";

const MEBIBYTE = 1024 * 1024;
const ENTRY_OVERHEAD_BYTES = 256;
const MAXIMUM_ESTIMATE_DEPTH = 64;

export const HISTORY_SOURCE_ANALYSIS_CACHE_LIMITS = Object.freeze({
  defaultBytes: 64 * MEBIBYTE,
  maximumBytes: 128 * MEBIBYTE,
});

export type SourceAnalysisDetailLevel = "summary" | "full";
export type SourceAnalysisLanguageMode =
  | "csharp"
  | "javascript-js"
  | "javascript-jsx"
  | "typescript-dts"
  | "typescript-ts"
  | "typescript-tsx";

export type SourceAnalysisWarning =
  | "csharp-decision-evidence-byte-limit";

export interface ValidUnboundSourceAnalysis {
  readonly status: "valid";
  readonly metrics: SourceMetrics;
  readonly metricMethod: MetricMethod;
  readonly imports: readonly StaticImportFact[];
  readonly units?: readonly ExecutableUnitMetric[];
  readonly sourceStructure?: SourceStructure;
  readonly warnings: readonly SourceAnalysisWarning[];
}

export interface SkippedUnboundSourceAnalysis {
  readonly status: "skipped";
  readonly reason:
    | "csharp-syntax-errors"
    | "csharp-unit-limit"
    | "typescript-syntax-errors";
}

export type UnboundSourceAnalysis =
  | SkippedUnboundSourceAnalysis
  | ValidUnboundSourceAnalysis;

export interface SourceAnalysisCacheKeyRequest {
  /** Used as hash input only and never retained by the cache. */
  readonly sourceText: string;
  readonly languageMode: SourceAnalysisLanguageMode;
  readonly analyzerFingerprint: string;
  readonly configurationFingerprint: string;
  readonly detailLevel: SourceAnalysisDetailLevel;
}

export interface SourceAnalysisCacheStats {
  readonly hits: number;
  readonly misses: number;
  readonly insertions: number;
  readonly evictions: number;
  readonly entries: number;
  readonly retainedBytes: number;
  readonly maximumBytes: number;
}

interface CacheEntry {
  readonly value: UnboundSourceAnalysis;
  readonly bytes: number;
}

function positiveBound(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > HISTORY_SOURCE_ANALYSIS_CACHE_LIMITS.maximumBytes
  ) {
    throw new TypeError("History source-analysis cache byte limit is invalid.");
  }
  return value;
}

function hashField(hash: ReturnType<typeof createHash>, value: string): void {
  hash.update(String(Buffer.byteLength(value, "utf8")));
  hash.update(":");
  hash.update(value, "utf8");
  hash.update("\0");
}

function retainedValueBytes(
  value: unknown,
  depth: number,
  seen: Set<object>,
  checkpoint?: () => void,
): number {
  checkpoint?.();
  if (depth > MAXIMUM_ESTIMATE_DEPTH) {
    throw new TypeError("History source-analysis cache value is too deep.");
  }
  if (value === null || value === undefined) return 8;
  if (typeof value === "boolean" || typeof value === "number") return 16;
  if (typeof value === "string") {
    return 48 + Buffer.byteLength(value, "utf8") * 2;
  }
  if (typeof value !== "object") {
    throw new TypeError("History source-analysis cache value is invalid.");
  }
  if (seen.has(value)) {
    throw new TypeError("History source-analysis cache value is cyclic.");
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return (
        40 +
        value.reduce(
          (total, item) =>
            total +
            retainedValueBytes(item, depth + 1, seen, checkpoint) +
            8,
          0,
        )
      );
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      throw new TypeError("History source-analysis cache value is invalid.");
    }
    let bytes = 64;
    for (const [key, item] of Object.entries(value)) {
      bytes +=
        32 +
        Buffer.byteLength(key, "utf8") * 2 +
        retainedValueBytes(item, depth + 1, seen, checkpoint);
    }
    return bytes;
  } finally {
    seen.delete(value);
  }
}

/**
 * Run-local byte-bounded LRU of path-independent source analysis. Keys contain
 * only fingerprints; values never contain source text, repository identity,
 * credentials, module ownership, districts, or dependency resolution.
 */
export class HistorySourceAnalysisCache {
  readonly #maximumBytes: number;
  readonly #entries = new Map<string, CacheEntry>();
  #retainedBytes = 0;
  #hits = 0;
  #misses = 0;
  #insertions = 0;
  #evictions = 0;

  public constructor(
    maximumBytes = HISTORY_SOURCE_ANALYSIS_CACHE_LIMITS.defaultBytes,
  ) {
    this.#maximumBytes = positiveBound(maximumBytes);
  }

  public key(
    request: SourceAnalysisCacheKeyRequest,
    checkpoint?: () => void,
  ): string {
    checkpoint?.();
    const hash = createHash("sha256");
    hashField(hash, "history-source-analysis-v1");
    hashField(hash, request.languageMode);
    hashField(hash, request.analyzerFingerprint);
    hashField(hash, request.configurationFingerprint);
    hashField(hash, request.detailLevel);
    hashField(hash, request.sourceText);
    const key = hash.digest("hex");
    checkpoint?.();
    return key;
  }

  public get(key: string): UnboundSourceAnalysis | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) {
      this.#misses += 1;
      return undefined;
    }
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    this.#hits += 1;
    return entry.value;
  }

  public set(
    key: string,
    value: UnboundSourceAnalysis,
    checkpoint?: () => void,
  ): boolean {
    checkpoint?.();
    const bytes =
      ENTRY_OVERHEAD_BYTES +
      Buffer.byteLength(key, "utf8") +
      retainedValueBytes(value, 0, new Set(), checkpoint);
    if (bytes > this.#maximumBytes) return false;

    const existing = this.#entries.get(key);
    let retainedBytes = this.#retainedBytes - (existing?.bytes ?? 0);
    const evictedKeys: string[] = [];
    for (const [candidateKey, candidate] of this.#entries) {
      if (retainedBytes <= this.#maximumBytes - bytes) break;
      if (candidateKey === key) continue;
      checkpoint?.();
      evictedKeys.push(candidateKey);
      retainedBytes -= candidate.bytes;
    }

    // Keep cancellation and deadline failures transactional: no cache state is
    // changed until all potentially-throwing checkpoints have completed.
    checkpoint?.();
    if (existing !== undefined) this.#entries.delete(key);
    for (const evictedKey of evictedKeys) this.#entries.delete(evictedKey);
    this.#entries.set(key, { value, bytes });
    this.#retainedBytes = retainedBytes + bytes;
    this.#insertions += 1;
    this.#evictions += evictedKeys.length;
    return true;
  }

  public stats(): SourceAnalysisCacheStats {
    return Object.freeze({
      hits: this.#hits,
      misses: this.#misses,
      insertions: this.#insertions,
      evictions: this.#evictions,
      entries: this.#entries.size,
      retainedBytes: this.#retainedBytes,
      maximumBytes: this.#maximumBytes,
    });
  }

  public clear(): void {
    this.#entries.clear();
    this.#retainedBytes = 0;
  }
}
