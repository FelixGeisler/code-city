import { EVOLUTION_BUNDLE_LIMITS } from "../../core/src/evolution.js";

const MEBIBYTE = 1024 * 1024;
const COMMIT_SHA = /^[0-9a-f]{40}$/u;
const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/u;

/**
 * Conservative retained object/array/index allowance charged for every
 * parsed changed-path record in addition to its UTF-8 path strings.
 */
export const HISTORY_CHANGED_PATH_RECORD_OVERHEAD_BYTES = 128;

/**
 * Hard resource ceilings for repository-history analysis.
 *
 * Callers may choose lower execution bounds, but may not raise these values.
 * The selector enforces the traversal, frame, tag, sampling, and deadline
 * ceilings before any commit analysis begins. The remaining ceilings are
 * exported for the streaming lineage and artifact writers.
 */
export const HISTORY_SELECTION_LIMITS = Object.freeze({
  maxTraversedCommits: 500,
  maxSampledFrames: 100,
  maxRequestedTags: 64,
  maxParentsPerCommit: 64,
  maxSampleEvery: 500,
  /** 256-byte Git ref ceiling minus the UTF-8 `refs/tags/` prefix. */
  maxTagNameBytes: 246,
  minTotalDeadlineMs: 1_000,
  defaultTotalDeadlineMs: 30 * 60 * 1_000,
  maxTotalDeadlineMs: 2 * 60 * 60 * 1_000,
  maxAggregateChangedPaths: 500_000,
  maxAggregateChangedPathBytes: 16 * MEBIBYTE,
  maxAggregateSemanticBytes: 128 * MEBIBYTE,
  maxUniqueLineages: 100_000,
  maxEvolutionOutputBytes: EVOLUTION_BUNDLE_LIMITS.serializedBytes,
  maxAggregateTreeEntries: 2_000_000,
});

export interface HistoryCommit {
  /** Full, lowercase SHA-1 object name. */
  readonly sha: string;
  /** All commit parents in Git order; index zero is the first parent. */
  readonly parents: readonly string[];
  /** Canonical UTC instant, exactly as produced by Date#toISOString. */
  readonly committedAt: string;
}

export interface HistoryAnalysisBounds {
  readonly totalDeadlineMs?: number;
  readonly maxAggregateChangedPaths?: number;
  /**
   * UTF-8 bytes across retained current/previous paths plus the exported
   * conservative per-record retention overhead.
   */
  readonly maxAggregateChangedPathBytes?: number;
  /**
   * Conservative retained-memory charge across sampled semantic facts,
   * including nested units/imports, strings, arrays, and indexes/copies.
   */
  readonly maxAggregateSemanticBytes?: number;
  readonly maxUniqueLineages?: number;
  readonly maxEvolutionOutputBytes?: number;
  readonly maxAggregateTreeEntries?: number;
}

export interface ResolvedHistoryAnalysisBounds {
  readonly totalDeadlineMs: number;
  readonly maxAggregateChangedPaths: number;
  readonly maxAggregateChangedPathBytes: number;
  readonly maxAggregateSemanticBytes: number;
  readonly maxUniqueLineages: number;
  readonly maxEvolutionOutputBytes: number;
  readonly maxAggregateTreeEntries: number;
}

interface CommonHistorySelectionRequest extends HistoryAnalysisBounds {
  /**
   * Sample from the oldest selected commit in fixed commit intervals.
   * The oldest and newest commits are included independently of this value.
   */
  readonly sampleEvery?: number;
  /**
   * Number of tag names the acquisition layer had to resolve. Names do not
   * enter this module and are never copied into the normalized summary.
   */
  readonly requestedTagCount?: number;
}

export interface CommitCountHistorySelectionRequest
  extends CommonHistorySelectionRequest {
  readonly mode: "commit-count";
  /** Number of recent commits requested. The supplied tip is always included. */
  readonly commitCount: number;
}

/**
 * Selects the complete available first-parent ancestry from the repository
 * root through the immutable requested tip. The acquisition layer must prove
 * that the root is inside the hard traversal ceiling before calling the
 * selector.
 */
export interface RootToTipHistorySelectionRequest
  extends HistoryAnalysisBounds {
  readonly mode: "root-to-tip";
  /** Maximum number of evenly distributed animation frames to retain. */
  readonly maxFrames: number;
}

export interface DateRangeHistorySelectionRequest
  extends CommonHistorySelectionRequest {
  readonly mode: "date-range";
  /** Inclusive ISO-8601 instant. It is normalized to UTC in the summary. */
  readonly fromInclusive: string;
  /** Inclusive ISO-8601 instant. It is normalized to UTC in the summary. */
  readonly toInclusive: string;
  /** Mandatory cost bound for the matching commits. */
  readonly maxCommits: number;
}

export interface TagRangeHistorySelectionRequest
  extends CommonHistorySelectionRequest {
  readonly mode: "tag-range";
  /** Resolved commit SHA of the older tag boundary. */
  readonly resolvedOldestSha: string;
  /** Resolved commit SHA of the newer tag boundary. */
  readonly resolvedNewestSha: string;
  /** Mandatory cost bound for the inclusive ancestry range. */
  readonly maxCommits: number;
}

export type HistorySelectionRequest =
  | RootToTipHistorySelectionRequest
  | CommitCountHistorySelectionRequest
  | DateRangeHistorySelectionRequest
  | TagRangeHistorySelectionRequest;

interface NormalizedHistorySelectionBase {
  readonly traversal: "first-parent";
  readonly order: "oldest-first";
  readonly selectedCommitCount: number;
  readonly sampledCommitCount: number;
  readonly traversedCommitCount: number;
  readonly resolvedOldestSha: string;
  readonly resolvedNewestSha: string;
  readonly sampledCommitShas: readonly string[];
}

export interface NormalizedRootToTipHistorySelection
  extends NormalizedHistorySelectionBase {
  readonly mode: "root-to-tip";
  readonly samplingStrategy: "evenly-spaced-v1";
  readonly maxFrames: number;
}

interface NormalizedFixedIntervalHistorySelection
  extends NormalizedHistorySelectionBase {
  readonly sampleEvery: number;
}

export interface NormalizedCommitCountHistorySelection
  extends NormalizedFixedIntervalHistorySelection {
  readonly mode: "commit-count";
  readonly requestedCommitCount: number;
}

export interface NormalizedDateRangeHistorySelection
  extends NormalizedFixedIntervalHistorySelection {
  readonly mode: "date-range";
  readonly fromInclusive: string;
  readonly toInclusive: string;
}

export interface NormalizedTagRangeHistorySelection
  extends NormalizedFixedIntervalHistorySelection {
  readonly mode: "tag-range";
}

export type NormalizedHistorySelection =
  | NormalizedRootToTipHistorySelection
  | NormalizedCommitCountHistorySelection
  | NormalizedDateRangeHistorySelection
  | NormalizedTagRangeHistorySelection;

export interface HistorySelectionResult {
  /** Complete selected ancestry segment, in deterministic oldest-first order. */
  readonly selectedCommits: readonly HistoryCommit[];
  /** Bounded frames to analyze, in deterministic oldest-first order. */
  readonly sampledCommits: readonly HistoryCommit[];
  readonly summary: NormalizedHistorySelection;
  readonly analysisBounds: ResolvedHistoryAnalysisBounds;
  readonly requestedTagCount: number;
}

export type HistorySelectionErrorCode =
  | "invalid-request"
  | "selection-unavailable"
  | "history-too-long"
  | "limit-exceeded";

export class HistorySelectionError extends Error {
  constructor(
    readonly code: HistorySelectionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "HistorySelectionError";
  }
}

interface ValidatedHistoryCommit {
  readonly commit: HistoryCommit;
  readonly committedAtMs: number;
}

interface ResolvedSelectionBase {
  readonly requestedTagCount: number;
  readonly analysisBounds: ResolvedHistoryAnalysisBounds;
}

interface ResolvedCommonSelection extends ResolvedSelectionBase {
  readonly sampleEvery: number;
}

interface ResolvedRootToTipSelection extends ResolvedSelectionBase {
  readonly mode: "root-to-tip";
  readonly maxFrames: number;
}

interface ResolvedCommitCountSelection extends ResolvedCommonSelection {
  readonly mode: "commit-count";
  readonly commitCount: number;
}

interface ResolvedDateRangeSelection extends ResolvedCommonSelection {
  readonly mode: "date-range";
  readonly fromInclusive: string;
  readonly fromInclusiveMs: number;
  readonly toInclusive: string;
  readonly toInclusiveMs: number;
  readonly maxCommits: number;
}

interface ResolvedTagRangeSelection extends ResolvedCommonSelection {
  readonly mode: "tag-range";
  readonly resolvedOldestSha: string;
  readonly resolvedNewestSha: string;
  readonly maxCommits: number;
}

type ResolvedHistorySelection =
  | ResolvedRootToTipSelection
  | ResolvedCommitCountSelection
  | ResolvedDateRangeSelection
  | ResolvedTagRangeSelection;

function fail(
  code: HistorySelectionErrorCode,
  message: string,
): never {
  throw new HistorySelectionError(code, message);
}

function requireRecord(
  value: unknown,
  name: string,
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("invalid-request", `${name} must be an object.`);
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    fail("invalid-request", `${name} must be a plain object.`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function requirePositiveBound(
  value: unknown,
  name: string,
  maximum: number,
  fallback?: number,
): number {
  const resolved = value ?? fallback;
  if (
    typeof resolved !== "number" ||
    !Number.isSafeInteger(resolved) ||
    resolved <= 0
  ) {
    fail(
      "invalid-request",
      `${name} must be a positive safe integer.`,
    );
  }
  if (resolved > maximum) {
    fail(
      "limit-exceeded",
      `${name} may not exceed ${maximum}; received ${resolved}.`,
    );
  }
  return resolved;
}

function requireRequestedTagCount(
  value: unknown,
  fallback: number,
): number {
  const resolved = value ?? fallback;
  if (
    typeof resolved !== "number" ||
    !Number.isSafeInteger(resolved) ||
    resolved < 0
  ) {
    fail(
      "invalid-request",
      "requestedTagCount must be a non-negative safe integer.",
    );
  }
  if (resolved > HISTORY_SELECTION_LIMITS.maxRequestedTags) {
    fail(
      "limit-exceeded",
      `requestedTagCount may not exceed ${HISTORY_SELECTION_LIMITS.maxRequestedTags}; received ${resolved}.`,
    );
  }
  return resolved;
}

function requireTotalDeadline(value: unknown): number {
  const resolved =
    value ?? HISTORY_SELECTION_LIMITS.defaultTotalDeadlineMs;
  if (
    typeof resolved !== "number" ||
    !Number.isSafeInteger(resolved)
  ) {
    fail(
      "invalid-request",
      "totalDeadlineMs must be a safe integer.",
    );
  }
  if (resolved < HISTORY_SELECTION_LIMITS.minTotalDeadlineMs) {
    fail(
      "invalid-request",
      `totalDeadlineMs must be at least ${HISTORY_SELECTION_LIMITS.minTotalDeadlineMs}.`,
    );
  }
  if (resolved > HISTORY_SELECTION_LIMITS.maxTotalDeadlineMs) {
    fail(
      "limit-exceeded",
      `totalDeadlineMs may not exceed ${HISTORY_SELECTION_LIMITS.maxTotalDeadlineMs}; received ${resolved}.`,
    );
  }
  return resolved;
}

/**
 * Resolves caller-selected execution caps without allowing any hard ceiling to
 * be raised.
 */
export function resolveHistoryAnalysisBounds(
  options: HistoryAnalysisBounds = {},
): ResolvedHistoryAnalysisBounds {
  const record = requireRecord(options, "history analysis bounds");
  return Object.freeze({
    totalDeadlineMs: requireTotalDeadline(record["totalDeadlineMs"]),
    maxAggregateChangedPaths: requirePositiveBound(
      record["maxAggregateChangedPaths"],
      "maxAggregateChangedPaths",
      HISTORY_SELECTION_LIMITS.maxAggregateChangedPaths,
      HISTORY_SELECTION_LIMITS.maxAggregateChangedPaths,
    ),
    maxAggregateChangedPathBytes: requirePositiveBound(
      record["maxAggregateChangedPathBytes"],
      "maxAggregateChangedPathBytes",
      HISTORY_SELECTION_LIMITS.maxAggregateChangedPathBytes,
      HISTORY_SELECTION_LIMITS.maxAggregateChangedPathBytes,
    ),
    maxAggregateSemanticBytes: requirePositiveBound(
      record["maxAggregateSemanticBytes"],
      "maxAggregateSemanticBytes",
      HISTORY_SELECTION_LIMITS.maxAggregateSemanticBytes,
      HISTORY_SELECTION_LIMITS.maxAggregateSemanticBytes,
    ),
    maxUniqueLineages: requirePositiveBound(
      record["maxUniqueLineages"],
      "maxUniqueLineages",
      HISTORY_SELECTION_LIMITS.maxUniqueLineages,
      HISTORY_SELECTION_LIMITS.maxUniqueLineages,
    ),
    maxEvolutionOutputBytes: requirePositiveBound(
      record["maxEvolutionOutputBytes"],
      "maxEvolutionOutputBytes",
      HISTORY_SELECTION_LIMITS.maxEvolutionOutputBytes,
      HISTORY_SELECTION_LIMITS.maxEvolutionOutputBytes,
    ),
    maxAggregateTreeEntries: requirePositiveBound(
      record["maxAggregateTreeEntries"],
      "maxAggregateTreeEntries",
      HISTORY_SELECTION_LIMITS.maxAggregateTreeEntries,
      HISTORY_SELECTION_LIMITS.maxAggregateTreeEntries,
    ),
  });
}

function requireSha(value: unknown, name: string): string {
  if (typeof value !== "string" || !COMMIT_SHA.test(value)) {
    fail(
      "invalid-request",
      `${name} must be a full lowercase 40-character commit SHA.`,
    );
  }
  return value;
}

function canonicalCommitInstant(value: unknown, name: string): {
  readonly value: string;
  readonly milliseconds: number;
} {
  if (typeof value !== "string") {
    fail("invalid-request", `${name} must be a string.`);
  }
  const milliseconds = Date.parse(value);
  if (
    !Number.isFinite(milliseconds) ||
    value.length !== 24 ||
    new Date(milliseconds).toISOString() !== value
  ) {
    fail(
      "invalid-request",
      `${name} must be a canonical UTC ISO instant with millisecond precision.`,
    );
  }
  return Object.freeze({ value, milliseconds });
}

function normalizeRangeInstant(value: unknown, name: string): {
  readonly value: string;
  readonly milliseconds: number;
} {
  if (typeof value !== "string") {
    fail("invalid-request", `${name} must be an ISO-8601 instant.`);
  }
  const match = ISO_INSTANT.exec(value);
  if (match === null) {
    fail(
      "invalid-request",
      `${name} must be an ISO-8601 instant with an explicit UTC offset.`,
    );
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const milliseconds = Number((match[7] ?? "").padEnd(3, "0"));
  const offsetHour = match[8] === "Z" ? 0 : Number(match[10]);
  const offsetMinute = match[8] === "Z" ? 0 : Number(match[11]);

  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    fail("invalid-request", `${name} is not a valid ISO-8601 instant.`);
  }

  const local = new Date(0);
  local.setUTCFullYear(year, month - 1, day);
  local.setUTCHours(hour, minute, second, milliseconds);
  if (
    local.getUTCFullYear() !== year ||
    local.getUTCMonth() !== month - 1 ||
    local.getUTCDate() !== day ||
    local.getUTCHours() !== hour ||
    local.getUTCMinutes() !== minute ||
    local.getUTCSeconds() !== second ||
    local.getUTCMilliseconds() !== milliseconds
  ) {
    fail("invalid-request", `${name} is not a valid calendar instant.`);
  }

  const offsetMilliseconds =
    (offsetHour * 60 + offsetMinute) * 60 * 1_000;
  const signedOffset =
    match[8] === "Z" || match[9] === "+"
      ? offsetMilliseconds
      : -offsetMilliseconds;
  const utcMilliseconds = local.getTime() - signedOffset;
  if (!Number.isFinite(utcMilliseconds)) {
    fail("invalid-request", `${name} is outside the supported date range.`);
  }

  let normalized: string;
  try {
    normalized = new Date(utcMilliseconds).toISOString();
  } catch {
    fail("invalid-request", `${name} is outside the supported date range.`);
  }
  if (normalized.length !== 24) {
    fail(
      "invalid-request",
      `${name} must normalize to a supported four-digit UTC year.`,
    );
  }
  return Object.freeze({
    value: normalized,
    milliseconds: utcMilliseconds,
  });
}

function resolveCommon(
  record: Readonly<Record<string, unknown>>,
  defaultRequestedTagCount: number,
): ResolvedCommonSelection {
  const sampleEvery = requirePositiveBound(
    record["sampleEvery"],
    "sampleEvery",
    HISTORY_SELECTION_LIMITS.maxSampleEvery,
    1,
  );
  const requestedTagCount = requireRequestedTagCount(
    record["requestedTagCount"],
    defaultRequestedTagCount,
  );
  const analysisBounds = resolveHistoryAnalysisBounds({
    ...(record["totalDeadlineMs"] === undefined
      ? {}
      : { totalDeadlineMs: record["totalDeadlineMs"] as number }),
    ...(record["maxAggregateChangedPaths"] === undefined
      ? {}
      : {
          maxAggregateChangedPaths:
            record["maxAggregateChangedPaths"] as number,
        }),
    ...(record["maxAggregateChangedPathBytes"] === undefined
      ? {}
      : {
          maxAggregateChangedPathBytes:
            record["maxAggregateChangedPathBytes"] as number,
        }),
    ...(record["maxAggregateSemanticBytes"] === undefined
      ? {}
      : {
          maxAggregateSemanticBytes:
            record["maxAggregateSemanticBytes"] as number,
        }),
    ...(record["maxUniqueLineages"] === undefined
      ? {}
      : { maxUniqueLineages: record["maxUniqueLineages"] as number }),
    ...(record["maxEvolutionOutputBytes"] === undefined
      ? {}
      : {
          maxEvolutionOutputBytes:
            record["maxEvolutionOutputBytes"] as number,
        }),
    ...(record["maxAggregateTreeEntries"] === undefined
      ? {}
      : {
          maxAggregateTreeEntries:
            record["maxAggregateTreeEntries"] as number,
        }),
  });
  return Object.freeze({
    sampleEvery,
    requestedTagCount,
    analysisBounds,
  });
}

function resolveSelectionRequest(
  request: unknown,
): ResolvedHistorySelection {
  const record = requireRecord(request, "history selection request");
  const mode = record["mode"];
  if (mode === "root-to-tip") {
    const maxFrames = requirePositiveBound(
      record["maxFrames"],
      "maxFrames",
      HISTORY_SELECTION_LIMITS.maxSampledFrames,
    );
    if (maxFrames < 2) {
      fail(
        "invalid-request",
        "maxFrames must be at least 2 so root and tip can both be retained.",
      );
    }
    return Object.freeze({
      mode,
      maxFrames,
      requestedTagCount: 0,
      analysisBounds: resolveHistoryAnalysisBounds({
        ...(record["totalDeadlineMs"] === undefined
          ? {}
          : { totalDeadlineMs: record["totalDeadlineMs"] as number }),
        ...(record["maxAggregateChangedPaths"] === undefined
          ? {}
          : { maxAggregateChangedPaths: record["maxAggregateChangedPaths"] as number }),
        ...(record["maxAggregateChangedPathBytes"] === undefined
          ? {}
          : { maxAggregateChangedPathBytes: record["maxAggregateChangedPathBytes"] as number }),
        ...(record["maxAggregateSemanticBytes"] === undefined
          ? {}
          : { maxAggregateSemanticBytes: record["maxAggregateSemanticBytes"] as number }),
        ...(record["maxUniqueLineages"] === undefined
          ? {}
          : { maxUniqueLineages: record["maxUniqueLineages"] as number }),
        ...(record["maxEvolutionOutputBytes"] === undefined
          ? {}
          : { maxEvolutionOutputBytes: record["maxEvolutionOutputBytes"] as number }),
        ...(record["maxAggregateTreeEntries"] === undefined
          ? {}
          : { maxAggregateTreeEntries: record["maxAggregateTreeEntries"] as number }),
      }),
    });
  }
  if (mode === "commit-count") {
    const common = resolveCommon(record, 0);
    return Object.freeze({
      ...common,
      mode,
      commitCount: requirePositiveBound(
        record["commitCount"],
        "commitCount",
        HISTORY_SELECTION_LIMITS.maxTraversedCommits,
      ),
    });
  }
  if (mode === "date-range") {
    const common = resolveCommon(record, 0);
    const from = normalizeRangeInstant(
      record["fromInclusive"],
      "fromInclusive",
    );
    const to = normalizeRangeInstant(
      record["toInclusive"],
      "toInclusive",
    );
    if (from.milliseconds > to.milliseconds) {
      fail(
        "invalid-request",
        "fromInclusive must not be later than toInclusive.",
      );
    }
    return Object.freeze({
      ...common,
      mode,
      fromInclusive: from.value,
      fromInclusiveMs: from.milliseconds,
      toInclusive: to.value,
      toInclusiveMs: to.milliseconds,
      maxCommits: requirePositiveBound(
        record["maxCommits"],
        "maxCommits",
        HISTORY_SELECTION_LIMITS.maxTraversedCommits,
      ),
    });
  }
  if (mode === "tag-range") {
    const common = resolveCommon(record, 2);
    return Object.freeze({
      ...common,
      mode,
      resolvedOldestSha: requireSha(
        record["resolvedOldestSha"],
        "resolvedOldestSha",
      ),
      resolvedNewestSha: requireSha(
        record["resolvedNewestSha"],
        "resolvedNewestSha",
      ),
      maxCommits: requirePositiveBound(
        record["maxCommits"],
        "maxCommits",
        HISTORY_SELECTION_LIMITS.maxTraversedCommits,
      ),
    });
  }
  fail(
    "invalid-request",
    "history selection mode must be root-to-tip, commit-count, date-range, or tag-range.",
  );
}

function validateHistoryChain(
  chain: readonly HistoryCommit[],
): readonly ValidatedHistoryCommit[] {
  const commits: ValidatedHistoryCommit[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < chain.length; index += 1) {
    const record = requireRecord(
      chain[index],
      `history chain commit ${index}`,
    );
    const sha = requireSha(record["sha"], `history chain commit ${index}.sha`);
    if (seen.has(sha)) {
      fail(
        "invalid-request",
        `history chain contains duplicate commit SHA ${sha}.`,
      );
    }
    seen.add(sha);

    const rawParents = record["parents"];
    if (!Array.isArray(rawParents)) {
      fail(
        "invalid-request",
        `history chain commit ${sha}.parents must be an array.`,
      );
    }
    if (rawParents.length > HISTORY_SELECTION_LIMITS.maxParentsPerCommit) {
      fail(
        "limit-exceeded",
        `history chain commit ${sha} exceeds ${HISTORY_SELECTION_LIMITS.maxParentsPerCommit} parents.`,
      );
    }
    const parentSet = new Set<string>();
    const parents = rawParents.map((parent, parentIndex) => {
      const validated = requireSha(
        parent,
        `history chain commit ${sha}.parents[${parentIndex}]`,
      );
      if (validated === sha) {
        fail(
          "invalid-request",
          `history chain commit ${sha} may not be its own parent.`,
        );
      }
      if (parentSet.has(validated)) {
        fail(
          "invalid-request",
          `history chain commit ${sha} contains duplicate parent ${validated}.`,
        );
      }
      parentSet.add(validated);
      return validated;
    });
    const instant = canonicalCommitInstant(
      record["committedAt"],
      `history chain commit ${sha}.committedAt`,
    );
    commits.push(
      Object.freeze({
        commit: Object.freeze({
          sha,
          parents: Object.freeze(parents),
          committedAt: instant.value,
        }),
        committedAtMs: instant.milliseconds,
      }),
    );
  }

  for (let index = 0; index + 1 < commits.length; index += 1) {
    const newer = commits[index];
    const older = commits[index + 1];
    if (
      newer === undefined ||
      older === undefined ||
      newer.commit.parents[0] !== older.commit.sha
    ) {
      fail(
        "invalid-request",
        "history chain must be contiguous first-parent ancestry in newest-to-oldest order.",
      );
    }
  }
  return Object.freeze(commits);
}

function enforceSelectionCount(
  count: number,
  maximum: number,
  context: string,
): void {
  if (count > maximum) {
    fail(
      "limit-exceeded",
      `${context} selected ${count} commits, exceeding maxCommits ${maximum}.`,
    );
  }
}

function selectNewestFirst(
  chain: readonly ValidatedHistoryCommit[],
  request: ResolvedHistorySelection,
): readonly ValidatedHistoryCommit[] {
  if (request.mode === "root-to-tip") {
    const root = chain.at(-1);
    if (root === undefined || root.commit.parents.length !== 0) {
      fail(
        "selection-unavailable",
        "Complete mainline history requires a first-parent chain that reaches the repository root.",
      );
    }
    return chain;
  }
  if (request.mode === "commit-count") {
    return chain.slice(0, request.commitCount);
  }
  if (request.mode === "date-range") {
    const selected = chain.filter(
      ({ committedAtMs }) =>
        committedAtMs >= request.fromInclusiveMs &&
        committedAtMs <= request.toInclusiveMs,
    );
    if (selected.length === 0) {
      fail(
        "selection-unavailable",
        "No commit in the supplied first-parent chain is inside the requested date range.",
      );
    }
    enforceSelectionCount(
      selected.length,
      request.maxCommits,
      "Date range",
    );
    return selected;
  }

  const newestIndex = chain.findIndex(
    ({ commit }) => commit.sha === request.resolvedNewestSha,
  );
  const oldestIndex = chain.findIndex(
    ({ commit }) => commit.sha === request.resolvedOldestSha,
  );
  if (newestIndex < 0 || oldestIndex < 0) {
    fail(
      "selection-unavailable",
      "Both resolved tag boundaries must lie on the supplied first-parent chain.",
    );
  }
  if (oldestIndex < newestIndex) {
    fail(
      "selection-unavailable",
      "The resolved older tag boundary is not an ancestor of the resolved newer boundary.",
    );
  }
  const selected = chain.slice(newestIndex, oldestIndex + 1);
  enforceSelectionCount(
    selected.length,
    request.maxCommits,
    "Tag range",
  );
  return selected;
}

function sampleEvenlyOldestFirst(
  selectedOldestFirst: readonly HistoryCommit[],
  maximumFrames: number,
): readonly HistoryCommit[] {
  const frameCount = Math.min(
    selectedOldestFirst.length,
    maximumFrames,
  );
  if (frameCount === 1) {
    return Object.freeze([selectedOldestFirst[0]!]);
  }
  const lastIndex = selectedOldestFirst.length - 1;
  const sampled = Array.from({ length: frameCount }, (_, index) => {
    const selectedIndex = Math.floor(
      (index * lastIndex) / (frameCount - 1),
    );
    return selectedOldestFirst[selectedIndex]!;
  });
  return Object.freeze(sampled);
}

function sampleOldestFirst(
  selectedOldestFirst: readonly HistoryCommit[],
  sampleEvery: number,
): readonly HistoryCommit[] {
  const indexes = new Set<number>();
  for (
    let index = 0;
    index < selectedOldestFirst.length;
    index += sampleEvery
  ) {
    indexes.add(index);
  }
  indexes.add(0);
  indexes.add(selectedOldestFirst.length - 1);
  const orderedIndexes = [...indexes].sort((left, right) => left - right);
  if (orderedIndexes.length > HISTORY_SELECTION_LIMITS.maxSampledFrames) {
    fail(
      "limit-exceeded",
      `History sampling produced ${orderedIndexes.length} frames, exceeding ${HISTORY_SELECTION_LIMITS.maxSampledFrames}. Increase sampleEvery or reduce the selection.`,
    );
  }
  return Object.freeze(
    orderedIndexes.map((index) => {
      const commit = selectedOldestFirst[index];
      if (commit === undefined) {
        fail("invalid-request", "History sampling produced an invalid index.");
      }
      return commit;
    }),
  );
}

function createSummary(
  request: ResolvedHistorySelection,
  traversedCommitCount: number,
  selectedOldestFirst: readonly HistoryCommit[],
  sampledOldestFirst: readonly HistoryCommit[],
): NormalizedHistorySelection {
  const oldest = selectedOldestFirst[0];
  const newest = selectedOldestFirst[selectedOldestFirst.length - 1];
  if (oldest === undefined || newest === undefined) {
    fail("selection-unavailable", "History selection is empty.");
  }
  const base = {
    traversal: "first-parent" as const,
    order: "oldest-first" as const,
    selectedCommitCount: selectedOldestFirst.length,
    sampledCommitCount: sampledOldestFirst.length,
    traversedCommitCount,
    resolvedOldestSha: oldest.sha,
    resolvedNewestSha: newest.sha,
    sampledCommitShas: Object.freeze(
      sampledOldestFirst.map(({ sha }) => sha),
    ),
  };
  if (request.mode === "root-to-tip") {
    return Object.freeze({
      ...base,
      mode: request.mode,
      samplingStrategy: "evenly-spaced-v1" as const,
      maxFrames: request.maxFrames,
    });
  }
  const fixedIntervalBase = {
    ...base,
    sampleEvery: request.sampleEvery,
  };
  if (request.mode === "commit-count") {
    return Object.freeze({
      ...fixedIntervalBase,
      mode: request.mode,
      requestedCommitCount: request.commitCount,
    });
  }
  if (request.mode === "date-range") {
    return Object.freeze({
      ...fixedIntervalBase,
      mode: request.mode,
      fromInclusive: request.fromInclusive,
      toInclusive: request.toInclusive,
    });
  }
  return Object.freeze({
    ...fixedIntervalBase,
    mode: request.mode,
  });
}

/**
 * Selects bounded frames from a pre-acquired first-parent commit chain.
 *
 * The input chain must be newest-to-oldest. This function performs no Git I/O
 * and rejects 501 commits from the array length alone, before inspecting any
 * commit metadata.
 */
export function selectHistory(
  chain: readonly HistoryCommit[],
  request: HistorySelectionRequest,
): HistorySelectionResult {
  if (!Array.isArray(chain)) {
    fail("invalid-request", "history chain must be an array.");
  }
  if (chain.length > HISTORY_SELECTION_LIMITS.maxTraversedCommits) {
    fail(
      "limit-exceeded",
      `History traversal may not exceed ${HISTORY_SELECTION_LIMITS.maxTraversedCommits} commits; received ${chain.length}.`,
    );
  }
  if (chain.length === 0) {
    fail(
      "selection-unavailable",
      "History selection requires at least one commit.",
    );
  }

  const resolvedRequest = resolveSelectionRequest(request);
  const validatedChain = validateHistoryChain(chain);
  const selectedNewestFirst = selectNewestFirst(
    validatedChain,
    resolvedRequest,
  );
  if (selectedNewestFirst.length === 0) {
    fail("selection-unavailable", "History selection is empty.");
  }
  const selectedOldestFirst = Object.freeze(
    selectedNewestFirst
      .map(({ commit }) => commit)
      .reverse(),
  );
  const sampledOldestFirst =
    resolvedRequest.mode === "root-to-tip"
      ? sampleEvenlyOldestFirst(
          selectedOldestFirst,
          resolvedRequest.maxFrames,
        )
      : sampleOldestFirst(
          selectedOldestFirst,
          resolvedRequest.sampleEvery,
        );
  return Object.freeze({
    selectedCommits: selectedOldestFirst,
    sampledCommits: sampledOldestFirst,
    summary: createSummary(
      resolvedRequest,
      validatedChain.length,
      selectedOldestFirst,
      sampledOldestFirst,
    ),
    analysisBounds: resolvedRequest.analysisBounds,
    requestedTagCount: resolvedRequest.requestedTagCount,
  });
}
