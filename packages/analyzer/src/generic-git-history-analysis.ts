import { createHash } from "node:crypto";
import { types as nodeUtilTypes } from "node:util";

import {
  DEFAULT_VERSIONED_METRIC_MAPPING,
  normalizeAssetRelativePath,
  normalizeCityIdentity,
  type CityIdentity,
  type CityModel,
  type IdentityLogo,
} from "../../core/src/index.js";

import {
  createHistoryEvolution,
  HistoryEvolutionError,
  type HistoryEvolutionRequest,
  type HistoryEvolutionResult,
} from "./evolution-analysis.js";
import {
  GENERIC_GIT_HISTORY_RENAME_POLICY_REVISION,
  validateGenericGitRef,
  withGenericGitHistoryRepository,
  type GenericGitHistoryBackend,
  type GenericGitHistoryCommit,
  type GenericGitHistoryPathChange,
  type GenericGitHistoryRequest,
  type GenericGitHistorySession,
  type GenericGitSnapshotDependencies,
  type GenericGitTransport,
} from "./git-snapshot.js";
import {
  HISTORY_CHANGED_PATH_RECORD_OVERHEAD_BYTES,
  HISTORY_SELECTION_LIMITS,
  HistorySelectionError,
  resolveHistoryAnalysisBounds,
  selectHistory,
  type CommitCountHistorySelectionRequest,
  type DateRangeHistorySelectionRequest,
  type HistoryAnalysisBounds,
  type HistorySelectionRequest,
  type HistorySelectionResult,
} from "./history-selection.js";
import { analyzeRepositorySnapshotFacts } from "./discovery.js";
import {
  DEFAULT_SNAPSHOT_LIMITS,
  type RepositorySnapshot,
} from "./snapshot.js";
import type {
  LocalAnalysisFacts,
  LocalAnalysisOptions,
} from "./types.js";

export const HISTORY_SEMANTIC_ANALYZER_FINGERPRINT =
  "code-city-semantic-facts-v1";
export const HISTORY_SEMANTIC_ANALYZER_FINGERPRINT_MAX_CHARACTERS =
  160;
const DEFAULT_METRIC_CONFIGURATION = Object.freeze({
  metricMapping: DEFAULT_VERSIONED_METRIC_MAPPING,
});
export const HISTORY_SEMANTIC_CONFIGURATION_LIMITS = Object.freeze({
  maxDepth: 64,
  maxArrayItems: 10_000,
  maxObjectKeys: 10_000,
  maxNodes: 100_000,
  maxUtf8Bytes: 1024 * 1024,
  maxTextCharacters: 65_536,
});
const CONFIGURATION_ENCODER = new TextEncoder();
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Cs}]/u;
const FORBIDDEN_CONFIGURATION_KEYS = new Set([
  "credential",
  "credentials",
  "constructor",
  "identity",
  "maxaggregatechangedpathbytes",
  "maxaggregatechangedpaths",
  "maxaggregatesemanticbytes",
  "maxaggregatetreeentries",
  "maxevolutionoutputbytes",
  "maxuniquelineages",
  "password",
  "proto",
  "prototype",
  "repositoryidentity",
  "repositoryurl",
  "secret",
  "signal",
  "timeoutms",
  "token",
  "totaldeadlinems",
]);

export interface NamedTagRangeHistorySelectionRequest
  extends HistoryAnalysisBounds {
  readonly mode: "tag-range";
  readonly oldestTagName: string;
  readonly newestTagName: string;
  readonly maxCommits: number;
  readonly sampleEvery?: number;
}

export type GenericGitHistorySelectionRequest =
  | CommitCountHistorySelectionRequest
  | DateRangeHistorySelectionRequest
  | NamedTagRangeHistorySelectionRequest;

export interface GenericGitHistoryAnalysisRequest {
  readonly repositoryUrl: string;
  /**
   * Canonical credential-free https/ssh URI. It is hashed for cache and
   * artifact provenance and is never copied into cached facts or artifacts.
   */
  readonly repositoryIdentity: string;
  readonly ref?: string;
  readonly selection: GenericGitHistorySelectionRequest;
  readonly signal?: AbortSignal;
}

export interface GenericGitHistoryAnalysisOptions {
  readonly analyzerFingerprint?: string;
  /**
   * Metric/analyzer semantics only. Credentials, repository identity, and
   * runtime limits are rejected from this object.
   */
  readonly metricConfiguration?: unknown;
  /**
   * Snapshot admission policy that can change successful semantic facts.
   * Runtime cancellation/deadlines and presentation identity are separate.
   */
  readonly analysisOptions?: HistoryAnalysisSnapshotOptions;
  /**
   * Presentation-only identity. It is attached after cache reads and never
   * participates in semantic cache keys or persisted semantic facts.
   */
  readonly identity?: {
    readonly title?: string;
    readonly version?: string;
    readonly logo?: string;
  };
}

export type HistoryAnalysisSnapshotOptions = Omit<
  LocalAnalysisOptions,
  "signal" | "timeoutMs" | "title" | "version" | "logo"
>;

export interface HistorySemanticCacheRequestLike {
  readonly repositoryIdentity: string;
  readonly commitSha: string;
  readonly analyzerFingerprint: string;
  readonly configuration: unknown;
}

export interface HistorySemanticCacheLeaseLike {
  readonly hit: boolean;
  read(): Promise<LocalAnalysisFacts>;
  release(): void;
}

export interface HistorySemanticCacheExecutionOptionsLike {
  /**
   * Called cooperatively during synchronous cache validation and
   * canonicalization so the enclosing history deadline remains enforceable.
   */
  readonly checkpoint?: () => void;
}

export interface HistorySemanticCacheLike {
  acquire(
    request: HistorySemanticCacheRequestLike,
    compute: () => Promise<LocalAnalysisFacts>,
    execution?: HistorySemanticCacheExecutionOptionsLike,
  ): Promise<HistorySemanticCacheLeaseLike>;
}

export interface HistorySnapshotAnalysisContext {
  readonly metricConfiguration: unknown;
  readonly analysisOptions: Readonly<
    Required<HistoryAnalysisSnapshotOptions>
  >;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export type AnalyzeHistorySnapshot = (
  snapshot: RepositorySnapshot,
  context: HistorySnapshotAnalysisContext,
) => Promise<LocalAnalysisFacts>;

export type GenericGitHistoryRepositoryProvider = <T>(
  request: GenericGitHistoryRequest,
  consumer: (session: GenericGitHistorySession) => Promise<T>,
  dependencies?: GenericGitSnapshotDependencies,
) => Promise<T>;

export interface GenericGitHistoryAnalysisDependencies {
  readonly withHistoryRepository?: GenericGitHistoryRepositoryProvider;
  readonly git?: GenericGitSnapshotDependencies;
  readonly semanticCache?: HistorySemanticCacheLike;
  readonly analyzeSnapshot?: AnalyzeHistorySnapshot;
  readonly createEvolution?: (
    request: HistoryEvolutionRequest,
  ) => HistoryEvolutionResult;
  readonly now?: () => number;
}

export interface GenericGitHistoryAnalysisResult {
  readonly repository: string;
  readonly tipSha: string;
  readonly transport: GenericGitTransport;
  readonly historyBackend: GenericGitHistoryBackend;
  readonly selection: HistorySelectionResult;
  readonly model: CityModel;
  readonly evolution: HistoryEvolutionResult;
  readonly costEstimate: GenericGitHistoryCostEstimate;
  readonly cacheHits: number;
  readonly cacheMisses: number;
}

export interface GenericGitHistoryCostEstimate {
  readonly traversedCommitCount: number;
  readonly selectedCommitCount: number;
  readonly sampledFrameCount: number;
  readonly maximumChangedPathEntries: number;
  /** UTF-8 path bytes plus fixed per-change retention overhead. */
  readonly maximumChangedPathBytes: number;
  /** Conservative retained-memory charge for all sampled semantic facts. */
  readonly maximumSemanticBytes: number;
  readonly maximumTreeEntries: number;
  readonly maximumUniqueLineages: number;
  readonly maximumOutputBytes: number;
  readonly totalDeadlineMs: number;
}

interface ResolvedAnalysisOptions {
  readonly analyzerFingerprint: string;
  readonly metricConfiguration: unknown;
  readonly snapshotOptions: Readonly<
    Required<HistoryAnalysisSnapshotOptions>
  >;
  readonly semanticConfiguration: unknown;
  readonly identity?: CityIdentity;
}

interface AnalysisClock {
  readonly startedAt: number;
  readonly deadlineMs: number;
  readonly now: () => number;
  readonly signal?: AbortSignal;
}

interface ConfigurationBudget {
  nodes: number;
  utf8Bytes: number;
}

interface SessionAnalysisResult extends GenericGitHistoryAnalysisResult {}

type SessionOutcome =
  | {
      readonly ok: true;
      readonly value: SessionAnalysisResult;
    }
  | {
      readonly ok: false;
      readonly error: unknown;
    };

function invalid(message: string): never {
  throw new HistorySelectionError("invalid-request", message);
}

function backendAwareAnalyzerFingerprint(
  analyzerFingerprint: string,
  backend: GenericGitHistoryBackend,
): string {
  if (
    typeof backend !== "object" ||
    backend === null ||
    backend.name !== "git" ||
    typeof backend.version !== "string" ||
    backend.version.length === 0 ||
    backend.version.length > 160 ||
    backend.version !== backend.version.trim() ||
    backend.version !== backend.version.normalize("NFC") ||
    !/^[\u0020-\u007e]+$/u.test(backend.version) ||
    backend.renamePolicyRevision !==
      GENERIC_GIT_HISTORY_RENAME_POLICY_REVISION ||
    Object.keys(backend).length !== 3
  ) {
    invalid("Generic Git history backend provenance is invalid.");
  }
  return `sha256:${createHash("sha256")
    .update(
      JSON.stringify({
        analyzerFingerprint,
        backend: {
          name: "git",
          renamePolicyRevision: backend.renamePolicyRevision,
          version: backend.version,
        },
      }),
      "utf8",
    )
    .digest("hex")}`;
}

function limit(message: string): never {
  throw new HistorySelectionError("limit-exceeded", message);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function chargeConfiguration(
  budget: ConfigurationBudget,
  nodes: number,
  utf8Bytes: number,
): void {
  budget.nodes += nodes;
  budget.utf8Bytes += utf8Bytes;
  if (budget.nodes > HISTORY_SEMANTIC_CONFIGURATION_LIMITS.maxNodes) {
    limit("Metric configuration contains too many values.");
  }
  if (
    budget.utf8Bytes >
    HISTORY_SEMANTIC_CONFIGURATION_LIMITS.maxUtf8Bytes
  ) {
    limit("Metric configuration is too large.");
  }
}

function jsonBytes(value: string | number | boolean | null): number {
  return CONFIGURATION_ENCODER.encode(JSON.stringify(value)).byteLength;
}

function canonicalConfiguration(
  value: unknown,
  depth = 0,
  seen = new Set<object>(),
  budget: ConfigurationBudget = { nodes: 0, utf8Bytes: 0 },
): unknown {
  if (depth > HISTORY_SEMANTIC_CONFIGURATION_LIMITS.maxDepth) {
    invalid("Metric configuration is too deeply nested.");
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    if (
      typeof value === "string" &&
      (value.length >
        HISTORY_SEMANTIC_CONFIGURATION_LIMITS.maxTextCharacters ||
        UNSAFE_TEXT.test(value))
    ) {
      invalid("Metric configuration text is invalid.");
    }
    chargeConfiguration(budget, 1, jsonBytes(value));
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      invalid("Metric configuration numbers must be finite.");
    }
    const normalized = Object.is(value, -0) ? 0 : value;
    chargeConfiguration(budget, 1, jsonBytes(normalized));
    return normalized;
  }
  if (typeof value !== "object" || value === undefined) {
    invalid("Metric configuration must be JSON-safe.");
  }
  if (seen.has(value)) {
    invalid("Metric configuration must not contain cycles.");
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (
        value.length >
        HISTORY_SEMANTIC_CONFIGURATION_LIMITS.maxArrayItems
      ) {
        limit("Metric configuration contains too many array items.");
      }
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          invalid("Metric configuration arrays must not be sparse.");
        }
      }
      chargeConfiguration(
        budget,
        1,
        2 + Math.max(0, value.length - 1),
      );
      return Object.freeze(
        value.map((item) =>
          canonicalConfiguration(item, depth + 1, seen, budget),
        ),
      );
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      invalid("Metric configuration must use plain objects.");
    }
    const keys = Object.keys(value);
    if (
      keys.length >
      HISTORY_SEMANTIC_CONFIGURATION_LIMITS.maxObjectKeys
    ) {
      limit("Metric configuration contains too many object keys.");
    }
    chargeConfiguration(
      budget,
      1,
      2 + Math.max(0, keys.length - 1),
    );
    const result: Record<string, unknown> = {};
    for (const key of keys.sort(compareText)) {
      if (
        key.length === 0 ||
        key.length > 256 ||
        UNSAFE_TEXT.test(key)
      ) {
        invalid("Metric configuration contains an invalid key.");
      }
      if (
        FORBIDDEN_CONFIGURATION_KEYS.has(
          key.toLocaleLowerCase("en-US").replaceAll(/[-_]/gu, ""),
        )
      ) {
        invalid(
          `Metric configuration may not contain runtime or identity key ${key}.`,
        );
      }
      chargeConfiguration(budget, 0, jsonBytes(key) + 1);
      result[key] = canonicalConfiguration(
        (value as Readonly<Record<string, unknown>>)[key],
        depth + 1,
        seen,
        budget,
      );
    }
    return Object.freeze(result);
  } finally {
    seen.delete(value);
  }
}

function resolveOptions(
  options: GenericGitHistoryAnalysisOptions,
): ResolvedAnalysisOptions {
  if (
    typeof options !== "object" ||
    options === null ||
    Array.isArray(options)
  ) {
    invalid("Generic Git history analysis options are invalid.");
  }
  const analyzerFingerprint =
    options.analyzerFingerprint ??
    HISTORY_SEMANTIC_ANALYZER_FINGERPRINT;
  if (
    typeof analyzerFingerprint !== "string" ||
    analyzerFingerprint.length === 0 ||
    analyzerFingerprint.length >
      HISTORY_SEMANTIC_ANALYZER_FINGERPRINT_MAX_CHARACTERS ||
    UNSAFE_TEXT.test(analyzerFingerprint)
  ) {
    invalid("History analyzer fingerprint is invalid.");
  }
  const metricConfiguration = canonicalConfiguration(
    options.metricConfiguration ?? DEFAULT_METRIC_CONFIGURATION,
  );
  const snapshotOptions = resolveAnalysisSnapshotOptions(
    options.analysisOptions,
  );
  const identity = presentationIdentity(options.identity);
  return Object.freeze({
    analyzerFingerprint,
    metricConfiguration,
    snapshotOptions,
    semanticConfiguration: Object.freeze({
      metricConfiguration,
      snapshotOptions,
    }),
    ...(identity === undefined ? {} : { identity }),
  });
}

function nonNegativeSnapshotLimit(
  value: unknown,
  fallback: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (
    typeof resolved !== "number" ||
    !Number.isSafeInteger(resolved) ||
    resolved < 0
  ) {
    invalid(`${name} must be a non-negative safe integer.`);
  }
  return resolved;
}

function resolveAnalysisSnapshotOptions(
  value: HistoryAnalysisSnapshotOptions | undefined,
): Readonly<Required<HistoryAnalysisSnapshotOptions>> {
  const options = value ?? {};
  if (
    typeof options !== "object" ||
    options === null ||
    Array.isArray(options) ||
    Object.getPrototypeOf(options) !== Object.prototype
  ) {
    invalid("History snapshot analysis options are invalid.");
  }
  const allowed = new Set([
    "maxDiagnostics",
    "maxEntries",
    "maxFileBytes",
    "maxRetainedFiles",
    "maxSourceBuildings",
    "maxTotalBytes",
  ]);
  if (Object.keys(options).some((key) => !allowed.has(key))) {
    invalid(
      "History snapshot analysis options contain an unsupported field.",
    );
  }
  return Object.freeze({
    maxEntries: nonNegativeSnapshotLimit(
      options.maxEntries,
      DEFAULT_SNAPSHOT_LIMITS.maxEntries,
      "analysisOptions.maxEntries",
    ),
    maxRetainedFiles: nonNegativeSnapshotLimit(
      options.maxRetainedFiles,
      DEFAULT_SNAPSHOT_LIMITS.maxRetainedFiles,
      "analysisOptions.maxRetainedFiles",
    ),
    maxSourceBuildings: nonNegativeSnapshotLimit(
      options.maxSourceBuildings,
      DEFAULT_SNAPSHOT_LIMITS.maxSourceBuildings,
      "analysisOptions.maxSourceBuildings",
    ),
    maxFileBytes: nonNegativeSnapshotLimit(
      options.maxFileBytes,
      DEFAULT_SNAPSHOT_LIMITS.maxFileBytes,
      "analysisOptions.maxFileBytes",
    ),
    maxTotalBytes: nonNegativeSnapshotLimit(
      options.maxTotalBytes,
      DEFAULT_SNAPSHOT_LIMITS.maxTotalBytes,
      "analysisOptions.maxTotalBytes",
    ),
    maxDiagnostics: nonNegativeSnapshotLimit(
      options.maxDiagnostics,
      DEFAULT_SNAPSHOT_LIMITS.maxDiagnostics,
      "analysisOptions.maxDiagnostics",
    ),
  });
}

function presentationIdentity(
  value: GenericGitHistoryAnalysisOptions["identity"],
): CityIdentity | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    invalid("History presentation identity is invalid.");
  }
  let logo: IdentityLogo | undefined;
  if (value.logo !== undefined) {
    if (typeof value.logo !== "string") {
      invalid("History presentation logo must be a string.");
    }
    let relativePath: string;
    try {
      relativePath = normalizeAssetRelativePath(value.logo);
    } catch {
      invalid(
        "History presentation logo must be a safe relative asset path.",
      );
    }
    const lower = relativePath.toLocaleLowerCase("en-US");
    if (!lower.endsWith(".svg") && !lower.endsWith(".png")) {
      invalid("History presentation logo must use .svg or .png.");
    }
    logo = Object.freeze({
      relativePath,
      format: lower.endsWith(".svg") ? "svg" : "png",
    });
  }
  if (value.title === undefined) {
    if (value.version !== undefined || logo !== undefined) {
      invalid(
        "History presentation title is required with version or logo.",
      );
    }
    return undefined;
  }
  try {
    return Object.freeze(
      normalizeCityIdentity({
        title: value.title,
        ...(value.version === undefined
          ? {}
          : { version: value.version }),
        ...(logo === undefined ? {} : { logo }),
      }),
    );
  } catch {
    invalid("History presentation identity is invalid.");
  }
}

/**
 * Validates and canonicalizes the identity used for semantic cache keys and
 * evolution provenance. Userinfo, query strings, and fragments are forbidden.
 */
export function credentialFreeRepositoryIdentity(
  value: string,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4_096 ||
    UNSAFE_TEXT.test(value)
  ) {
    invalid("Repository identity is invalid.");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    invalid("Repository identity must be an absolute https or ssh URI.");
  }
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "ssh:") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.hostname === "" ||
    parsed.pathname === "/"
  ) {
    invalid(
      "Repository identity must be a credential-free https or ssh repository URI.",
    );
  }
  const canonical = parsed.toString();
  if (canonical !== value) {
    invalid("Repository identity must use canonical URI spelling.");
  }
  return canonical;
}

function traversalMaximum(
  selection: GenericGitHistorySelectionRequest,
): number {
  const value =
    selection.mode === "commit-count"
      ? selection.commitCount
      : selection.maxCommits;
  if (!Number.isSafeInteger(value) || value <= 0) {
    invalid("History traversal maximum must be a positive safe integer.");
  }
  if (value > HISTORY_SELECTION_LIMITS.maxTraversedCommits) {
    limit(
      `History traversal maximum may not exceed ${HISTORY_SELECTION_LIMITS.maxTraversedCommits}.`,
    );
  }
  return value;
}

function canonicalRequestedTagName(value: string): string {
  if (typeof value !== "string") {
    invalid("Tag range names must be strings.");
  }
  const name = value.startsWith("refs/tags/")
    ? value.slice("refs/tags/".length)
    : value;
  try {
    return validateGenericGitRef(`refs/tags/${name}`).slice(
      "refs/tags/".length,
    );
  } catch {
    invalid("Tag range names must be valid exact Git tag names.");
  }
}

function requestedTagNames(
  selection: GenericGitHistorySelectionRequest,
): readonly string[] {
  if (selection.mode !== "tag-range") return Object.freeze([]);
  const oldest = canonicalRequestedTagName(
    selection.oldestTagName,
  );
  const newest = canonicalRequestedTagName(
    selection.newestTagName,
  );
  const names =
    oldest === newest ? [oldest] : [oldest, newest];
  return Object.freeze(names);
}

function explicitBounds(
  selection: GenericGitHistorySelectionRequest,
): HistoryAnalysisBounds {
  return {
    ...(selection.totalDeadlineMs === undefined
      ? {}
      : { totalDeadlineMs: selection.totalDeadlineMs }),
    ...(selection.maxAggregateChangedPaths === undefined
      ? {}
      : {
          maxAggregateChangedPaths:
            selection.maxAggregateChangedPaths,
        }),
    ...(selection.maxAggregateChangedPathBytes === undefined
      ? {}
      : {
          maxAggregateChangedPathBytes:
            selection.maxAggregateChangedPathBytes,
        }),
    ...(selection.maxAggregateSemanticBytes === undefined
      ? {}
      : {
          maxAggregateSemanticBytes:
            selection.maxAggregateSemanticBytes,
        }),
    ...(selection.maxUniqueLineages === undefined
      ? {}
      : { maxUniqueLineages: selection.maxUniqueLineages }),
    ...(selection.maxEvolutionOutputBytes === undefined
      ? {}
      : {
          maxEvolutionOutputBytes:
            selection.maxEvolutionOutputBytes,
        }),
    ...(selection.maxAggregateTreeEntries === undefined
      ? {}
      : {
          maxAggregateTreeEntries:
            selection.maxAggregateTreeEntries,
        }),
  };
}

function copiedCommonSelectionFields(
  selection:
    | CommitCountHistorySelectionRequest
    | DateRangeHistorySelectionRequest,
): object {
  return {
    ...(selection.sampleEvery === undefined
      ? {}
      : { sampleEvery: selection.sampleEvery }),
    ...(selection.requestedTagCount === undefined
      ? {}
      : { requestedTagCount: selection.requestedTagCount }),
    ...explicitBounds(selection),
  };
}

function immutableSelectionRequest(
  selection: GenericGitHistorySelectionRequest,
): GenericGitHistorySelectionRequest {
  if (
    typeof selection !== "object" ||
    selection === null ||
    Array.isArray(selection) ||
    Object.getPrototypeOf(selection) !== Object.prototype
  ) {
    invalid("Generic Git history selection must be a plain object.");
  }
  if (selection.mode === "commit-count") {
    return Object.freeze({
      mode: selection.mode,
      commitCount: selection.commitCount,
      ...copiedCommonSelectionFields(selection),
    });
  }
  if (selection.mode === "date-range") {
    return Object.freeze({
      mode: selection.mode,
      fromInclusive: selection.fromInclusive,
      toInclusive: selection.toInclusive,
      maxCommits: selection.maxCommits,
      ...copiedCommonSelectionFields(selection),
    });
  }
  if (selection.mode === "tag-range") {
    return Object.freeze({
      mode: selection.mode,
      oldestTagName: selection.oldestTagName,
      newestTagName: selection.newestTagName,
      maxCommits: selection.maxCommits,
      ...(selection.sampleEvery === undefined
        ? {}
        : { sampleEvery: selection.sampleEvery }),
      ...explicitBounds(selection),
    });
  }
  invalid(
    "Generic Git history selection mode must be commit-count, date-range, or tag-range.",
  );
}

function resolvedSelectionRequest(
  request: GenericGitHistorySelectionRequest,
  session: GenericGitHistorySession,
): HistorySelectionRequest {
  if (request.mode !== "tag-range") return request;
  const tags = new Map(
    session.tags.map(({ name, commitSha }) => [name, commitSha]),
  );
  const oldestName = canonicalRequestedTagName(
    request.oldestTagName,
  );
  const newestName = canonicalRequestedTagName(
    request.newestTagName,
  );
  const resolvedOldestSha = tags.get(oldestName);
  const resolvedNewestSha = tags.get(newestName);
  if (
    resolvedOldestSha === undefined ||
    resolvedNewestSha === undefined
  ) {
    throw new HistorySelectionError(
      "selection-unavailable",
      "Both tag range boundaries must resolve to immutable commit SHAs.",
    );
  }
  return Object.freeze({
    mode: "tag-range",
    resolvedOldestSha,
    resolvedNewestSha,
    maxCommits: request.maxCommits,
    ...(request.sampleEvery === undefined
      ? {}
      : { sampleEvery: request.sampleEvery }),
    requestedTagCount: new Set([oldestName, newestName]).size,
    ...explicitBounds(request),
  });
}

function selectSessionHistory(
  request: GenericGitHistorySelectionRequest,
  session: GenericGitHistorySession,
): HistorySelectionResult {
  const maximumCommits = traversalMaximum(request);
  if (session.commits.length > maximumCommits + 1) {
    throw new HistorySelectionError(
      "limit-exceeded",
      `History provider returned ${session.commits.length} commits for a ${maximumCommits}-commit traversal bound; at most one overflow probe is allowed.`,
    );
  }

  const hasOverflowProbe = session.commits.length > maximumCommits;
  const boundedCommits = session.commits.slice(0, maximumCommits);
  const resolvedRequest = resolvedSelectionRequest(request, session);

  if (hasOverflowProbe && resolvedRequest.mode === "date-range") {
    throw new HistorySelectionError(
      "limit-exceeded",
      `The inclusive date range cannot be proven complete within maxCommits ${maximumCommits}; increase the bound or use commit-count selection.`,
    );
  }
  if (hasOverflowProbe && resolvedRequest.mode === "tag-range") {
    const boundedShas = new Set(boundedCommits.map(({ sha }) => sha));
    if (
      !boundedShas.has(resolvedRequest.resolvedOldestSha) ||
      !boundedShas.has(resolvedRequest.resolvedNewestSha)
    ) {
      throw new HistorySelectionError(
        "limit-exceeded",
        `Both tag boundaries must be available within maxCommits ${maximumCommits}.`,
      );
    }
  }

  return selectHistory(
    boundedCommits as readonly GenericGitHistoryCommit[],
    resolvedRequest,
  );
}

function checkpoint(clock: AnalysisClock): void {
  if (clock.signal?.aborted) {
    throw new HistoryEvolutionError(
      "deadline-exceeded",
      "Repository history analysis was aborted.",
    );
  }
  const elapsed = clock.now() - clock.startedAt;
  if (!Number.isFinite(elapsed) || elapsed < 0) {
    invalid("History analysis clock is invalid.");
  }
  if (elapsed > clock.deadlineMs) {
    throw new HistoryEvolutionError(
      "deadline-exceeded",
      "Repository history analysis exceeded its total deadline.",
    );
  }
}

function remainingMilliseconds(clock: AnalysisClock): number {
  checkpoint(clock);
  return Math.max(
    1,
    Math.floor(clock.deadlineMs - (clock.now() - clock.startedAt)),
  );
}

function deadlineError(): HistoryEvolutionError {
  return new HistoryEvolutionError(
    "deadline-exceeded",
    "Repository history analysis exceeded its total deadline.",
  );
}

async function withinAnalysisDeadline<T>(
  operation: () => PromiseLike<T>,
  clock: AnalysisClock,
  releaseLateValue?: (value: T) => void,
): Promise<T> {
  const remaining = remainingMilliseconds(clock);
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      clock.signal?.removeEventListener("abort", abort);
      callback();
    };
    const abort = (): void =>
      finish(() => reject(deadlineError()));
    const timer = globalThis.setTimeout(abort, remaining);
    clock.signal?.addEventListener("abort", abort, { once: true });
    if (clock.signal?.aborted) abort();
    if (settled) return;
    Promise.resolve().then(operation).then(
      (value) => {
        if (settled) {
          try {
            releaseLateValue?.(value);
          } catch {
            // A late value cannot replace the already-reported deadline.
          }
          return;
        }
        finish(() => resolve(value));
      },
      (error: unknown) => {
        if (!settled) finish(() => reject(error));
      },
    );
  });
}

function chargeChangedPaths(
  changes: readonly GenericGitHistoryPathChange[],
  priorEntries: number,
  priorBytes: number,
  maximumEntries: number,
  maximumBytes: number,
  clock: AnalysisClock,
): {
  readonly entries: number;
  readonly bytes: number;
} {
  let entries = priorEntries;
  let bytes = priorBytes;
  for (const [index, change] of changes.entries()) {
    if (index % 256 === 0) checkpoint(clock);
    entries += change.kind === "renamed" ? 2 : 1;
    bytes +=
      HISTORY_CHANGED_PATH_RECORD_OVERHEAD_BYTES +
      Buffer.byteLength(change.path, "utf8");
    if (change.kind === "renamed") {
      bytes += Buffer.byteLength(change.previousPath, "utf8");
    }
    if (entries > maximumEntries) {
      throw new HistoryEvolutionError(
        "limit-exceeded",
        `History analysis exceeded ${maximumEntries} aggregate changed paths.`,
      );
    }
    if (bytes > maximumBytes) {
      throw new HistoryEvolutionError(
        "limit-exceeded",
        `History analysis exceeded ${maximumBytes} aggregate retained changed-path bytes.`,
      );
    }
  }
  checkpoint(clock);
  return Object.freeze({ entries, bytes });
}

function semanticTreeEntries(facts: LocalAnalysisFacts): number {
  return (
    facts.repositories.length +
    facts.solutions.length +
    facts.modules.length +
    facts.sources.length +
    facts.dependencies.length
  );
}

const SEMANTIC_RETENTION_SAFETY_FACTOR = 4;
const SEMANTIC_OBJECT_OVERHEAD_BYTES = 128;
const SEMANTIC_ARRAY_OVERHEAD_BYTES = 64;
const SEMANTIC_REFERENCE_BYTES = 16;
const SEMANTIC_STRING_OVERHEAD_BYTES = 48;
const SEMANTIC_MAX_DEPTH = 64;
const SEMANTIC_MAX_VALUES = 2_000_000;
const SEMANTIC_MAX_TEXT_CHARACTERS = 65_536;
const SEMANTIC_FACT_KEYS = Object.freeze([
  "dependencies",
  "modules",
  "repositories",
  "solutions",
  "sources",
  "warnings",
] as const);

function snapshotRetainedSemanticFacts(
  value: unknown,
  identity: CityIdentity | undefined,
  accumulated: number,
  maximum: number,
  clock: AnalysisClock,
): {
  readonly facts: LocalAnalysisFacts;
  readonly bytes: number;
} {
  const active = new WeakSet<object>();
  let charged = accumulated;
  let operations = 0;
  let values = 0;
  const invalidFacts = (): never => {
    throw new HistoryEvolutionError(
      "invalid-input",
      "History semantic facts must be an exact plain immutable JSON data graph.",
    );
  };
  const step = (): void => {
    operations += 1;
    if ((operations & 0xff) === 0) checkpoint(clock);
  };
  const charge = (rawBytes: number): void => {
    if (
      !Number.isSafeInteger(rawBytes) ||
      rawBytes < 0 ||
      rawBytes >
        Math.floor(
          (maximum - charged) /
            SEMANTIC_RETENTION_SAFETY_FACTOR,
        )
    ) {
      throw new HistoryEvolutionError(
        "limit-exceeded",
        `History analysis exceeded ${maximum} aggregate retained semantic bytes.`,
      );
    }
    charged += rawBytes * SEMANTIC_RETENTION_SAFETY_FACTOR;
  };
  const descriptors = (
    item: object,
    path: string,
  ): Readonly<Record<PropertyKey, PropertyDescriptor>> => {
    step();
    if (nodeUtilTypes.isProxy(item)) invalidFacts();
    const prototype = Object.getPrototypeOf(item);
    if (
      (Array.isArray(item) && prototype !== Array.prototype) ||
      (
        !Array.isArray(item) &&
        prototype !== Object.prototype &&
        prototype !== null
      )
    ) {
      invalidFacts();
    }
    const keys = Reflect.ownKeys(item);
    if (keys.some((key) => typeof key !== "string")) {
      invalidFacts();
    }
    const result = Object.getOwnPropertyDescriptors(item);
    if (Array.isArray(item)) {
      const lengthDescriptor = result.length;
      if (
        lengthDescriptor === undefined ||
        !("value" in lengthDescriptor) ||
        typeof lengthDescriptor.value !== "number" ||
        !Number.isSafeInteger(lengthDescriptor.value) ||
        lengthDescriptor.value < 0 ||
        keys.length !== lengthDescriptor.value + 1
      ) {
        invalidFacts();
      }
      const length = (lengthDescriptor as PropertyDescriptor & {
        value: number;
      }).value;
      for (let index = 0; index < length; index += 1) {
        const descriptor = result[String(index)];
        if (
          descriptor === undefined ||
          !("value" in descriptor) ||
          descriptor.enumerable !== true
        ) {
          invalidFacts();
        }
      }
      return result;
    }
    for (const rawKey of keys) {
      if (typeof rawKey !== "string") invalidFacts();
      const key = rawKey as string;
      if (
        key.length > SEMANTIC_MAX_TEXT_CHARACTERS ||
        UNSAFE_TEXT.test(key)
      ) {
        invalidFacts();
      }
      const descriptor = result[key];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) {
        invalidFacts();
      }
    }
    return result;
  };
  const dataValue = (
    descriptor: PropertyDescriptor | undefined,
  ): unknown => {
    if (descriptor === undefined || !("value" in descriptor)) {
      invalidFacts();
    }
    return (
      descriptor as PropertyDescriptor & { value: unknown }
    ).value;
  };
  const snapshot = (
    item: unknown,
    path: string,
    depth: number,
  ): unknown => {
    step();
    values += 1;
    if (values > SEMANTIC_MAX_VALUES || depth > SEMANTIC_MAX_DEPTH) {
      invalidFacts();
    }
    charge(SEMANTIC_REFERENCE_BYTES);
    if (typeof item === "string") {
      if (
        item.length > SEMANTIC_MAX_TEXT_CHARACTERS ||
        UNSAFE_TEXT.test(item)
      ) {
        invalidFacts();
      }
      charge(
        SEMANTIC_STRING_OVERHEAD_BYTES +
          Buffer.byteLength(item, "utf8"),
      );
      return item;
    }
    if (
      item === null ||
      typeof item === "boolean"
    ) {
      return item;
    }
    if (typeof item === "number") {
      if (!Number.isFinite(item)) invalidFacts();
      return Object.is(item, -0) ? 0 : item;
    }
    if (typeof item !== "object" || item === undefined) {
      invalidFacts();
    }
    const objectItem = item as object;
    if (active.has(objectItem)) invalidFacts();
    active.add(objectItem);
    const sourceDescriptors = descriptors(objectItem, path);
    try {
      if (Array.isArray(item)) {
        const length = dataValue(sourceDescriptors.length);
        if (typeof length !== "number") invalidFacts();
        const arrayLength = length as number;
        charge(
          SEMANTIC_ARRAY_OVERHEAD_BYTES +
            arrayLength * SEMANTIC_REFERENCE_BYTES,
        );
        const result = new Array<unknown>(arrayLength);
        for (let index = 0; index < arrayLength; index += 1) {
          result[index] = snapshot(
            dataValue(sourceDescriptors[String(index)]),
            `${path}[${index}]`,
            depth + 1,
          );
        }
        return Object.freeze(result);
      }
      const keys = Reflect.ownKeys(sourceDescriptors).filter(
        (key): key is string => typeof key === "string",
      );
      charge(
        SEMANTIC_OBJECT_OVERHEAD_BYTES +
          keys.length * SEMANTIC_REFERENCE_BYTES,
      );
      const result = Object.create(
        Object.getPrototypeOf(objectItem) === null
          ? null
          : Object.prototype,
      ) as Record<string, unknown>;
      for (const key of keys) {
        charge(
          SEMANTIC_STRING_OVERHEAD_BYTES +
            Buffer.byteLength(key, "utf8"),
        );
        Object.defineProperty(result, key, {
          configurable: false,
          enumerable: true,
          value: snapshot(
            dataValue(sourceDescriptors[key]),
            `${path}.${key}`,
            depth + 1,
          ),
          writable: false,
        });
      }
      return Object.freeze(result);
    } finally {
      active.delete(objectItem);
    }
  };

  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    invalidFacts();
  }
  const rootDescriptors = descriptors(value as object, "facts");
  const rootKeys = Reflect.ownKeys(rootDescriptors);
  const allowedRootKeys = new Set<string>([
    ...SEMANTIC_FACT_KEYS,
    "identity",
  ]);
  if (
    SEMANTIC_FACT_KEYS.some(
      (key) => !Object.hasOwn(rootDescriptors, key),
    ) ||
    rootKeys.some(
      (key) =>
        typeof key !== "string" || !allowedRootKeys.has(key),
    )
  ) {
    invalidFacts();
  }
  const semanticRoot: Record<string, unknown> = {};
  for (const key of SEMANTIC_FACT_KEYS) {
    semanticRoot[key] = dataValue(rootDescriptors[key]);
  }
  if (identity !== undefined) semanticRoot["identity"] = identity;
  const facts = snapshot(
    semanticRoot,
    "facts",
    0,
  ) as LocalAnalysisFacts;
  checkpoint(clock);
  return Object.freeze({
    facts,
    bytes: charged,
  });
}

function contiguousEvolutionSelection(
  selection: HistorySelectionResult,
  session: GenericGitHistorySession,
): HistorySelectionResult {
  const newestIndex = session.commits.findIndex(
    ({ sha }) => sha === selection.summary.resolvedNewestSha,
  );
  const oldestIndex = session.commits.findIndex(
    ({ sha }) => sha === selection.summary.resolvedOldestSha,
  );
  if (
    newestIndex < 0 ||
    oldestIndex < newestIndex
  ) {
    throw new HistorySelectionError(
      "selection-unavailable",
      "Selected history boundaries do not form available first-parent ancestry.",
    );
  }
  const selectedCommits = Object.freeze(
    session.commits
      .slice(newestIndex, oldestIndex + 1)
      .reverse()
      .map((commit) =>
        Object.freeze({
          sha: commit.sha,
          parents: Object.freeze([...commit.parents]),
          committedAt: commit.committedAt,
        }),
      ),
  );
  return Object.freeze({
    ...selection,
    selectedCommits,
  });
}

async function defaultAnalyzeSnapshot(
  snapshot: RepositorySnapshot,
  context: HistorySnapshotAnalysisContext,
): Promise<LocalAnalysisFacts> {
  return await analyzeRepositorySnapshotFacts([snapshot], {
    ...context.analysisOptions,
    timeoutMs: context.timeoutMs,
    ...(context.signal === undefined
      ? {}
      : { signal: context.signal }),
  });
}

function releaseLeases(
  leases: readonly HistorySemanticCacheLeaseLike[],
): void {
  const errors: unknown[] = [];
  for (const lease of [...leases].reverse()) {
    try {
      lease.release();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      "One or more history semantic cache leases could not be released.",
    );
  }
}

async function analyzeSession(
  request: GenericGitHistoryAnalysisRequest,
  options: ResolvedAnalysisOptions,
  session: GenericGitHistorySession,
  bounds: ReturnType<typeof resolveHistoryAnalysisBounds>,
  clock: AnalysisClock,
  dependencies: GenericGitHistoryAnalysisDependencies,
): Promise<SessionAnalysisResult> {
  checkpoint(clock);
  const analyzerFingerprint = backendAwareAnalyzerFingerprint(
    options.analyzerFingerprint,
    session.backend,
  );
  const selection = selectSessionHistory(request.selection, session);
  const evolutionSelection = contiguousEvolutionSelection(
    selection,
    session,
  );
  checkpoint(clock);

  const changesByCommit = new Map<
    string,
    readonly GenericGitHistoryPathChange[]
  >();
  let changedPaths = 0;
  let changedPathBytes = 0;
  for (const commit of evolutionSelection.selectedCommits.slice(1)) {
    checkpoint(clock);
    const changes = await session.readChanges(commit.sha);
    checkpoint(clock);
    const charged = chargeChangedPaths(
      changes,
      changedPaths,
      changedPathBytes,
      bounds.maxAggregateChangedPaths,
      bounds.maxAggregateChangedPathBytes,
      clock,
    );
    changedPaths = charged.entries;
    changedPathBytes = charged.bytes;
    changesByCommit.set(commit.sha, changes);
  }

  const analyzeSnapshot =
    dependencies.analyzeSnapshot ?? defaultAnalyzeSnapshot;
  const createEvolutionResult =
    dependencies.createEvolution ?? createHistoryEvolution;
  const leases: HistorySemanticCacheLeaseLike[] = [];
  let cacheHits = 0;
  let cacheMisses = 0;
  let treeEntries = 0;
  let semanticBytes = 0;
  let value: SessionAnalysisResult | undefined;
  let failed = false;
  let failure: unknown;

  try {
    const frames: {
      readonly commit: GenericGitHistoryCommit;
      readonly facts: LocalAnalysisFacts;
    }[] = [];
    for (const commit of selection.sampledCommits) {
      checkpoint(clock);
      let snapshotFileCount: number | undefined;
      const compute = async (): Promise<LocalAnalysisFacts> => {
        checkpoint(clock);
        const snapshot = await session.readSnapshot(commit.sha);
        snapshotFileCount = snapshot.files.length;
        checkpoint(clock);
        const analyzed = await withinAnalysisDeadline(
          async () =>
            await analyzeSnapshot(snapshot, {
              metricConfiguration: options.metricConfiguration,
              analysisOptions: options.snapshotOptions,
              timeoutMs: remainingMilliseconds(clock),
              ...(clock.signal === undefined
                ? {}
                : { signal: clock.signal }),
            }),
          clock,
        );
        const facts = snapshotRetainedSemanticFacts(
          analyzed,
          undefined,
          0,
          HISTORY_SELECTION_LIMITS.maxAggregateSemanticBytes,
          clock,
        ).facts;
        checkpoint(clock);
        return facts;
      };

      let semanticFacts: LocalAnalysisFacts;
      if (dependencies.semanticCache === undefined) {
        cacheMisses += 1;
        semanticFacts = await compute();
      } else {
        const lease = await withinAnalysisDeadline(
          async () =>
            await dependencies.semanticCache!.acquire(
              {
                repositoryIdentity: request.repositoryIdentity,
                commitSha: commit.sha,
                analyzerFingerprint,
                configuration: options.semanticConfiguration,
              },
              compute,
              {
                checkpoint: () => checkpoint(clock),
              },
            ),
          clock,
          (lateLease) => lateLease.release(),
        );
        leases.push(lease);
        if (lease.hit) cacheHits += 1;
        else cacheMisses += 1;
        checkpoint(clock);
        semanticFacts = await withinAnalysisDeadline(
          async () => await lease.read(),
          clock,
        );
        checkpoint(clock);
      }
      const retained = snapshotRetainedSemanticFacts(
        semanticFacts,
        options.identity,
        semanticBytes,
        bounds.maxAggregateSemanticBytes,
        clock,
      );
      const facts = retained.facts;
      semanticBytes = retained.bytes;

      const chargedEntries =
        snapshotFileCount ?? Math.max(1, semanticTreeEntries(facts));
      treeEntries += chargedEntries;
      if (treeEntries > bounds.maxAggregateTreeEntries) {
        throw new HistoryEvolutionError(
          "limit-exceeded",
          `History analysis exceeded ${bounds.maxAggregateTreeEntries} aggregate tree entries.`,
        );
      }
      frames.push(Object.freeze({ commit, facts }));
    }

    checkpoint(clock);
    const executionSelection: HistorySelectionResult =
      Object.freeze({
        ...evolutionSelection,
        analysisBounds: Object.freeze({
          ...evolutionSelection.analysisBounds,
          totalDeadlineMs: remainingMilliseconds(clock),
        }),
      });
    const evolution = createEvolutionResult({
      repositoryIdentity: request.repositoryIdentity,
      selection: executionSelection,
      changesByCommit,
      frames: Object.freeze(frames),
      analyzerFingerprint,
      historyBackend: session.backend,
      metricConfiguration: options.semanticConfiguration,
      now: clock.now,
      ...(clock.signal === undefined
        ? {}
        : { signal: clock.signal }),
    });
    checkpoint(clock);
    const model = evolution.model;
    value = Object.freeze({
      repository: session.repository,
      tipSha: session.tipSha,
      transport: session.transport,
      historyBackend: session.backend,
      selection,
      model,
      evolution,
      costEstimate: Object.freeze({
        traversedCommitCount: selection.summary.traversedCommitCount,
        selectedCommitCount: selection.summary.selectedCommitCount,
        sampledFrameCount: selection.summary.sampledCommitCount,
        maximumChangedPathEntries:
          selection.analysisBounds.maxAggregateChangedPaths,
        maximumChangedPathBytes:
          selection.analysisBounds.maxAggregateChangedPathBytes,
        maximumSemanticBytes:
          selection.analysisBounds.maxAggregateSemanticBytes,
        maximumTreeEntries:
          selection.analysisBounds.maxAggregateTreeEntries,
        maximumUniqueLineages:
          selection.analysisBounds.maxUniqueLineages,
        maximumOutputBytes:
          selection.analysisBounds.maxEvolutionOutputBytes,
        totalDeadlineMs:
          selection.analysisBounds.totalDeadlineMs,
      }),
      cacheHits,
      cacheMisses,
    });
  } catch (error) {
    failed = true;
    failure = error;
  }

  try {
    releaseLeases(leases);
  } catch (releaseError) {
    if (failed) {
      failure = new AggregateError(
        [failure, releaseError],
        "History analysis and semantic cache cleanup both failed.",
      );
    } else {
      failed = true;
      failure = releaseError;
    }
  }
  if (failed) throw failure;
  if (value === undefined) {
    throw new HistoryEvolutionError(
      "invalid-input",
      "History analysis completed without a result.",
    );
  }
  return value;
}

/**
 * Acquires and validates one bounded Generic Git history, analyzes only
 * sampled snapshots, then produces the final CityModel and evolution bundle.
 */
export async function analyzeGenericGitHistory(
  request: GenericGitHistoryAnalysisRequest,
  options: GenericGitHistoryAnalysisOptions = {},
  dependencies: GenericGitHistoryAnalysisDependencies = {},
): Promise<GenericGitHistoryAnalysisResult> {
  if (
    typeof request !== "object" ||
    request === null ||
    typeof request.repositoryUrl !== "string" ||
    typeof request.selection !== "object" ||
    request.selection === null
  ) {
    invalid("Generic Git history analysis request is invalid.");
  }
  const repositoryUrl = request.repositoryUrl;
  const reference = request.ref;
  const signal = request.signal;
  const selection = immutableSelectionRequest(request.selection);
  const repositoryIdentity = credentialFreeRepositoryIdentity(
    request.repositoryIdentity,
  );
  const normalizedRequest: GenericGitHistoryAnalysisRequest =
    Object.freeze({
      repositoryUrl,
      repositoryIdentity,
      ...(reference === undefined ? {} : { ref: reference }),
      selection,
      ...(signal === undefined
        ? {}
        : { signal }),
    });
  const resolvedOptions = resolveOptions(options);
  const maximumCommits = traversalMaximum(selection);
  const bounds = resolveHistoryAnalysisBounds(
    explicitBounds(selection),
  );
  const now = dependencies.now ?? Date.now;
  const clock: AnalysisClock = Object.freeze({
    startedAt: now(),
    deadlineMs: bounds.totalDeadlineMs,
    now,
    ...(signal === undefined
      ? {}
      : { signal }),
  });
  checkpoint(clock);

  const tagNames = requestedTagNames(selection);
  const historyRequest: GenericGitHistoryRequest = Object.freeze({
    repositoryUrl,
    maximumCommits,
    maximumChangedPathEntries: bounds.maxAggregateChangedPaths,
    maximumChangedPathBytes: bounds.maxAggregateChangedPathBytes,
    timeoutMs: bounds.totalDeadlineMs,
    ...(reference === undefined ? {} : { ref: reference }),
    ...(tagNames.length === 0 ? {} : { tagNames }),
    ...(signal === undefined
      ? { snapshotOptions: resolvedOptions.snapshotOptions }
      : {
          signal,
          snapshotOptions: {
            ...resolvedOptions.snapshotOptions,
            signal,
          },
        }),
  });
  const provider =
    dependencies.withHistoryRepository ??
    withGenericGitHistoryRepository;
  const outcome = await provider(
    historyRequest,
    async (session): Promise<SessionOutcome> => {
      try {
        return Object.freeze({
          ok: true,
          value: await analyzeSession(
            normalizedRequest,
            resolvedOptions,
            session,
            bounds,
            clock,
            dependencies,
          ),
        });
      } catch (error) {
        return Object.freeze({ ok: false, error });
      }
    },
    dependencies.git,
  );
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}
