import { createHash } from "node:crypto";
import path from "node:path";

import {
  EVOLUTION_AUTHOR_POLICY,
  EVOLUTION_BUNDLE_SCHEMA_VERSION,
  EVOLUTION_PROJECT_START_POLICY,
  DEFAULT_METRIC_MAPPING,
  DEFAULT_VERSIONED_METRIC_MAPPING,
  DEFAULT_SEMANTIC_GROUPS,
  LEGACY_BUILDING_METRIC_SEMANTIC_GROUP_IDS,
  deriveEvolutionChangeKinds,
  layoutCity,
  prepareEvolutionSerialization,
  projectBuildingMetricMapping,
  semanticGroupsForMetricMapping,
  stableId,
  validateLegacyMetricMapping,
  validateMetricMappingDefinition,
  validateCityModel,
  type CityBuilding,
  type CityDependency,
  type CityDistrict,
  type CityModel,
  type CityModule,
  type CityRepository,
  type CitySolution,
  type EvolutionBundle,
  type EvolutionChanges,
  type EvolutionEntityCollection,
  type EvolutionEntityDelta,
  type EvolutionFingerprint,
  type EvolutionModelChanges,
  type MetricMapping,
  type MetricMappingDefinitionV1,
  type PreparedEvolutionSerialization,
  type SemanticGroup,
  type SourceMetrics,
} from "../../core/src/index.js";

import {
  GENERIC_GIT_HISTORY_RENAME_POLICY_REVISION,
  type GenericGitHistoryBackend,
  type GenericGitHistoryPathChange,
} from "./git-snapshot.js";
import {
  HISTORY_CHANGED_PATH_RECORD_OVERHEAD_BYTES,
  type HistoryCommit,
  type HistorySelectionResult,
} from "./history-selection.js";
import {
  safeRelativeInputPath,
  sanitizeExternalReference,
} from "./sanitization.js";
import { cityModelFromFacts } from "./city-model.js";
import type {
  HistoryAnalysisFacts,
  HistorySourceFileFact,
  LocalAnalysisFacts,
} from "./types.js";

const GENERATOR_VERSION = "0.1.0";
const SOURCE_LINEAGE_PREFIX = "history-building";
const MODULE_LINEAGE_PREFIX = "history-module";
const SOLUTION_LINEAGE_PREFIX = "history-solution";
const DEPENDENCY_LINEAGE_PREFIX = "history-dependency";
const REPOSITORY_LINEAGE_PREFIX = "history-repository";
const SLOT_PREFIX = "history-slot";
const IDENTITY_DEADLINE_CHECK_INTERVAL = 256;
const IDENTITY_WORK_MULTIPLIER = 8;
const EVOLUTION_WORK_MULTIPLIER = 64;
const HISTORY_METRIC_CONFIGURATION_MAX_WRAPPER_DEPTH = 64;
const CHANGE_KINDS = new Set([
  "added",
  "deleted",
  "modified",
  "type-changed",
  "renamed",
]);

export type HistoryEvolutionErrorCode =
  | "deadline-exceeded"
  | "invalid-input"
  | "lineage-collision"
  | "limit-exceeded";

export class HistoryEvolutionError extends Error {
  constructor(
    readonly code: HistoryEvolutionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "HistoryEvolutionError";
  }
}

export interface HistoryEvolutionFrameInput {
  readonly commit: HistoryCommit;
  readonly facts: HistoryAnalysisFacts;
}

export interface HistoryEvolutionRequest {
  /**
   * Credential-free canonical repository identity. The clear text is used
   * only as in-memory fingerprint input and is never copied into the bundle.
   */
  readonly repositoryIdentity: string;
  readonly selection: HistorySelectionResult;
  /**
   * One direct boundary diff for every sampled frame after the oldest frame,
   * keyed by that newer frame SHA. Empty change lists are significant and
   * must therefore still be present.
   */
  readonly boundaryChangesByCommit: ReadonlyMap<
    string,
    readonly GenericGitHistoryPathChange[]
  >;
  /** Exactly the sampled frames selected by `selectHistory`. */
  readonly frames: readonly HistoryEvolutionFrameInput[];
  readonly analyzerFingerprint: string;
  readonly historyBackend: GenericGitHistoryBackend;
  /** Metric/layout-affecting analyzer configuration only. */
  readonly metricConfiguration: unknown;
  readonly now?: () => number;
  readonly signal?: AbortSignal;
}

export interface HistoryEvolutionResult {
  readonly repositoryId: string;
  readonly model: CityModel;
  readonly bundle: EvolutionBundle;
  /**
   * Present on production results so a trusted artifact writer can reuse the
   * completed validation/replay instead of repeating it.
   */
  readonly preparedSerialization?: PreparedEvolutionSerialization;
}

interface PathLineageState {
  readonly tokens: Map<string, string>;
  readonly materials: Map<string, string>;
}

interface EntityIdentityInput {
  readonly rawId: string;
  readonly pathToken?: string;
  readonly memberIds: ReadonlySet<string>;
  readonly discriminator: string;
}

interface AssignedEntityIdentity extends EntityIdentityInput {
  readonly id: string;
}

interface DependencyIdentityCandidate {
  readonly rawId: string;
  readonly edgeKey: string;
  readonly edgeMaterial: Readonly<Record<string, unknown>>;
  readonly logicalReferenceKey?: string;
  readonly logicalReferenceRequiresUniqueMatch: boolean;
  readonly logicalMatchFingerprint: string;
  readonly mutableFingerprint: string;
  readonly entity: CityDependency;
}

interface DependencyIdentityInput {
  readonly entity: CityDependency;
  readonly logicalReferenceKey?: string;
  readonly logicalReferenceRequiresUniqueMatch: boolean;
}

interface DependencyLogicalReference {
  readonly key: string;
  readonly requiresUniqueMatch: boolean;
}

interface AssignedDependencyIdentity
  extends DependencyIdentityCandidate {
  readonly id: string;
}

interface DependencyIdentityState {
  active: readonly AssignedDependencyIdentity[];
}

interface AssignedFrame {
  readonly commit: HistoryCommit;
  readonly facts: HistoryAnalysisFacts;
}

interface PreparedFrame {
  readonly input: HistoryEvolutionFrameInput;
  readonly sourceIds: ReadonlyMap<string, string>;
  readonly sourceIdsByPath: ReadonlyMap<string, string>;
  readonly moduleIds: ReadonlyMap<string, string>;
  readonly solutionIds: ReadonlyMap<string, string>;
}

interface UnionSlot {
  readonly id: string;
  readonly buildingId: string;
  readonly moduleId: string;
  readonly representative: HistorySourceFileFact;
  readonly metrics: SourceMetrics;
}

function fail(
  code: HistoryEvolutionErrorCode,
  message: string,
): never {
  throw new HistoryEvolutionError(code, message);
}

function mappingValidation<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    fail(
      "invalid-input",
      error instanceof Error
        ? error.message
        : "metricConfiguration.metricMapping is invalid.",
    );
  }
}

function mappingRecord(
  value: unknown,
): Record<string, unknown> | undefined {
  return typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function claimedHistoryMetricMapping(
  value: unknown,
  path = "metricConfiguration",
  depth = 0,
  seen = new Set<object>(),
): MetricMapping | undefined {
  if (depth > HISTORY_METRIC_CONFIGURATION_MAX_WRAPPER_DEPTH) {
    fail(
      "invalid-input",
      `${path} is too deeply nested; metricConfiguration wrappers must not exceed ${HISTORY_METRIC_CONFIGURATION_MAX_WRAPPER_DEPTH} levels.`,
    );
  }
  const configuration = mappingRecord(value);
  if (configuration === undefined) return undefined;
  if (seen.has(configuration)) {
    fail(
      "invalid-input",
      `${path} must not contain a metricConfiguration wrapper cycle.`,
    );
  }
  seen.add(configuration);

  try {
    if (configuration["definitionVersion"] !== undefined) {
      return mappingValidation(() =>
        validateMetricMappingDefinition(configuration, path),
      );
    }
    if (
      configuration["formulas"] !== undefined ||
      configuration["normalizationCaps"] !== undefined
    ) {
      return mappingValidation(() =>
        validateLegacyMetricMapping(configuration, path),
      );
    }
    if (Object.prototype.hasOwnProperty.call(configuration, "metricMapping")) {
      const claim = configuration["metricMapping"];
      const claimPath = `${path}.metricMapping`;
      if (claim === "default-v1") return DEFAULT_METRIC_MAPPING;
      if (typeof claim === "string") {
        fail(
          "invalid-input",
          `${claimPath} must be exactly "default-v1" or a complete versioned metric mapping definition; other string aliases are not reproducible.`,
        );
      }
      const record = mappingRecord(claim);
      if (record === undefined) {
        fail(
          "invalid-input",
          `${claimPath} must be "default-v1" or a recognized metric mapping definition.`,
        );
      }
      if (record["definitionVersion"] !== undefined) {
        return mappingValidation(() =>
          validateMetricMappingDefinition(record, claimPath),
        );
      }
      return mappingValidation(() =>
        validateLegacyMetricMapping(record, claimPath),
      );
    }

    // Generic Git history wraps the caller's complete metric configuration in
    // its semantic cache configuration. Only this known wrapper is traversed.
    if (
      Object.prototype.hasOwnProperty.call(
        configuration,
        "metricConfiguration",
      )
    ) {
      return claimedHistoryMetricMapping(
        configuration["metricConfiguration"],
        `${path}.metricConfiguration`,
        depth + 1,
        seen,
      );
    }
    return undefined;
  } finally {
    seen.delete(configuration);
  }
}

function resolveHistoryMetricMapping(value: unknown): MetricMapping {
  return (
    claimedHistoryMetricMapping(value) ??
    DEFAULT_VERSIONED_METRIC_MAPPING
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalValue(
  value: unknown,
  seen = new Set<object>(),
  checkpoint?: () => void,
): unknown {
  checkpoint?.();
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      fail("invalid-input", "Evolution fingerprint input is not finite.");
    }
    return value;
  }
  if (typeof value !== "object" || value === undefined) {
    fail("invalid-input", "Evolution fingerprint input is not JSON-safe.");
  }
  if (seen.has(value)) {
    fail("invalid-input", "Evolution fingerprint input is cyclic.");
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) =>
        canonicalValue(item, seen, checkpoint),
      );
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      fail(
        "invalid-input",
        "Evolution fingerprint input must use plain objects.",
      );
    }
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort(compareText)) {
      result[key] = canonicalValue(
        (value as Record<string, unknown>)[key],
        seen,
        checkpoint,
      );
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

function canonicalJson(
  value: unknown,
  checkpoint?: () => void,
): string {
  return JSON.stringify(
    canonicalValue(value, new Set<object>(), checkpoint),
  );
}

function fingerprint(
  value: unknown,
  checkpoint?: () => void,
): EvolutionFingerprint {
  return `sha256:${sha256(canonicalJson(value, checkpoint))}`;
}

class LineageRegistry {
  readonly #materials = new Map<string, string>();

  public constructor(
    private readonly checkpoint?: () => void,
  ) {}

  public id(prefix: string, material: unknown): string {
    const canonical = canonicalJson(material, this.checkpoint);
    const id = `${prefix}-${sha256(canonical)}`;
    const existing = this.#materials.get(id);
    if (existing !== undefined && existing !== canonical) {
      fail(
        "lineage-collision",
        `A cryptographic ${prefix} lineage collision was detected.`,
      );
    }
    this.#materials.set(id, canonical);
    return id;
  }
}

class EntityLineageBudget {
  readonly #ids = new Set<string>();

  public constructor(private readonly maximum: number) {}

  public add(
    collection: EvolutionEntityCollection,
    id: string,
  ): void {
    this.#ids.add(`${collection}\u0000${id}`);
    if (this.#ids.size > this.maximum) {
      fail(
        "limit-exceeded",
        `History analysis exceeded ${this.maximum} unique entity lineages.`,
      );
    }
  }

  public addAll(
    collection: EvolutionEntityCollection,
    entities: readonly { readonly id: string }[],
  ): void {
    for (const { id } of entities) this.add(collection, id);
  }
}

class IdentityMatchBudget {
  readonly #maximumCandidateEdges: number;
  readonly #maximumOperations: number;
  readonly #startedAt: number;
  readonly #maximumMilliseconds: number;
  readonly #now: () => number;
  readonly #signal: AbortSignal | undefined;
  #candidateEdges = 0;
  #operations = 0;
  #nextDeadlineCheck = IDENTITY_DEADLINE_CHECK_INTERVAL;

  public constructor(
    maximumCandidateEdges: number,
    maximumOperations: number,
    startedAt: number,
    maximumMilliseconds: number,
    now: () => number,
    signal: AbortSignal | undefined,
  ) {
    this.#maximumCandidateEdges = maximumCandidateEdges;
    this.#maximumOperations = maximumOperations;
    this.#startedAt = startedAt;
    this.#maximumMilliseconds = maximumMilliseconds;
    this.#now = now;
    this.#signal = signal;
  }

  public checkpoint(): void {
    checkDeadline(
      this.#startedAt,
      this.#maximumMilliseconds,
      this.#now,
      this.#signal,
    );
  }

  public consume(operations = 1): void {
    this.#operations += operations;
    if (this.#operations > this.#maximumOperations) {
      fail(
        "limit-exceeded",
        `History analysis exceeded ${this.#maximumOperations} bounded identity-matching operations.`,
      );
    }
    if (this.#operations >= this.#nextDeadlineCheck) {
      this.checkpoint();
      this.#nextDeadlineCheck =
        (Math.floor(
          this.#operations / IDENTITY_DEADLINE_CHECK_INTERVAL,
        ) +
          1) *
        IDENTITY_DEADLINE_CHECK_INTERVAL;
    }
  }

  public addCandidate(): void {
    this.#candidateEdges += 1;
    if (this.#candidateEdges > this.#maximumCandidateEdges) {
      fail(
        "limit-exceeded",
        `History analysis exceeded ${this.#maximumCandidateEdges} aggregate identity-matching candidates.`,
      );
    }
  }
}

class EvolutionWorkBudget {
  #operations = 0;
  #nextDeadlineCheck = IDENTITY_DEADLINE_CHECK_INTERVAL;

  public constructor(
    private readonly maximumOperations: number,
    private readonly startedAt: number,
    private readonly maximumMilliseconds: number,
    private readonly now: () => number,
    private readonly signal: AbortSignal | undefined,
  ) {}

  public checkpoint(): void {
    checkDeadline(
      this.startedAt,
      this.maximumMilliseconds,
      this.now,
      this.signal,
    );
  }

  public consume(operations = 1): void {
    this.#operations += operations;
    if (this.#operations > this.maximumOperations) {
      fail(
        "limit-exceeded",
        `History analysis exceeded ${this.maximumOperations} bounded synchronous evolution operations.`,
      );
    }
    if (this.#operations >= this.#nextDeadlineCheck) {
      this.checkpoint();
      this.#nextDeadlineCheck =
        (Math.floor(
          this.#operations / IDENTITY_DEADLINE_CHECK_INTERVAL,
        ) +
          1) *
        IDENTITY_DEADLINE_CHECK_INTERVAL;
    }
  }
}

function checkDeadline(
  startedAt: number,
  maximumMilliseconds: number,
  now: () => number,
  signal?: AbortSignal,
): void {
  if (signal?.aborted) {
    fail(
      "deadline-exceeded",
      "Repository history analysis was cancelled.",
    );
  }
  if (now() - startedAt > maximumMilliseconds) {
    fail(
      "deadline-exceeded",
      "Repository history analysis exceeded its total deadline.",
    );
  }
}

function validateRequest(
  request: HistoryEvolutionRequest,
  budget: EvolutionWorkBudget,
): void {
  budget.checkpoint();
  if (
    typeof request.repositoryIdentity !== "string" ||
    request.repositoryIdentity.length === 0 ||
    request.repositoryIdentity.length > 4_096 ||
    typeof request.analyzerFingerprint !== "string" ||
    request.analyzerFingerprint.length === 0 ||
    request.analyzerFingerprint.length > 256 ||
    typeof request.historyBackend !== "object" ||
    request.historyBackend === null ||
    request.historyBackend.name !== "git" ||
    typeof request.historyBackend.version !== "string" ||
    request.historyBackend.version.length === 0 ||
    request.historyBackend.version.length > 160 ||
    request.historyBackend.version !==
      request.historyBackend.version.trim() ||
    request.historyBackend.version !==
      request.historyBackend.version.normalize("NFC") ||
    !/^[\u0020-\u007e]+$/u.test(request.historyBackend.version) ||
    request.historyBackend.renamePolicyRevision !==
      GENERIC_GIT_HISTORY_RENAME_POLICY_REVISION ||
    Object.keys(request.historyBackend).length !== 3 ||
    !(request.boundaryChangesByCommit instanceof Map) ||
    !Array.isArray(request.frames)
  ) {
    fail("invalid-input", "Evolution history request is invalid.");
  }

  const { selectedCommits, sampledCommits, summary } = request.selection;
  if (
    selectedCommits.length === 0 ||
    sampledCommits.length !== request.frames.length ||
    summary.sampledCommitCount !== request.frames.length
  ) {
    fail(
      "invalid-input",
      "Evolution frames do not match the normalized history selection.",
    );
  }
  request.frames.forEach((frame, index) => {
    budget.consume();
    const selected = sampledCommits[index];
    if (
      selected === undefined ||
      frame.commit.sha !== selected.sha ||
      frame.commit.committedAt !== selected.committedAt ||
      canonicalJson(frame.commit.parents, () => budget.consume()) !==
        canonicalJson(selected.parents, () => budget.consume()) ||
      frame.facts.repositories.length !== 1
    ) {
      fail(
        "invalid-input",
        "An evolution frame does not match its sampled commit.",
      );
    }
  });
  sampledCommits.slice(1).forEach((commit) => {
    budget.consume();
    if (!request.boundaryChangesByCommit.has(commit.sha)) {
      fail(
        "invalid-input",
        `History changes are missing for sampled frame ${commit.sha}.`,
      );
    }
  });
}

function pathToken(
  state: PathLineageState,
  registry: LineageRegistry,
  path: string,
  material: unknown,
): string {
  const canonical = canonicalJson(material);
  const token = registry.id("history-path", material);
  const existing = state.materials.get(token);
  if (existing !== undefined && existing !== canonical) {
    fail("lineage-collision", "A history path collision was detected.");
  }
  state.materials.set(token, canonical);
  state.tokens.set(path, token);
  return token;
}

function seedFramePaths(
  state: PathLineageState,
  registry: LineageRegistry,
  frame: HistoryEvolutionFrameInput,
  budget: EvolutionWorkBudget,
): void {
  const paths = new Set<string>();
  frame.facts.sources.forEach(({ path }) => {
    budget.consume();
    paths.add(path);
  });
  frame.facts.solutions.forEach(({ path }) => {
    budget.consume();
    paths.add(path);
  });
  frame.facts.modules.forEach((module) => {
    budget.consume();
    if (
      module.kind === "dotnet-project" ||
      module.kind === "angular-project" ||
      module.kind === "npm-package"
    ) {
      paths.add(module.path);
    }
  });
  budget.checkpoint();
  const sortedPaths = [...paths].sort(compareText);
  budget.checkpoint();
  sortedPaths.forEach((path) => {
    budget.consume();
    if (!state.tokens.has(path)) {
      pathToken(state, registry, path, {
        firstObservedAt: frame.commit.sha,
        path,
      });
    }
  });
}

function validateChange(change: GenericGitHistoryPathChange): void {
  if (
    typeof change !== "object" ||
    change === null ||
    !CHANGE_KINDS.has(change.kind) ||
    typeof change.path !== "string" ||
    change.path.length === 0 ||
    (change.kind === "renamed" &&
      (typeof change.previousPath !== "string" ||
        change.previousPath.length === 0))
  ) {
    fail("invalid-input", "A history path change is invalid.");
  }
}

function applyPathChanges(
  state: PathLineageState,
  registry: LineageRegistry,
  commitSha: string,
  changes: readonly GenericGitHistoryPathChange[],
  budget: EvolutionWorkBudget,
): void {
  const seenDestinations = new Set<string>();
  const seenSources = new Set<string>();
  const renameTokens = new Map<string, string>();

  for (const change of changes) {
    budget.consume();
    validateChange(change);
    if (seenDestinations.has(change.path)) {
      fail(
        "invalid-input",
        `History contains duplicate changes for ${change.path}.`,
      );
    }
    seenDestinations.add(change.path);
    if (change.kind === "renamed") {
      if (seenSources.has(change.previousPath)) {
        fail(
          "invalid-input",
          `History contains duplicate rename sources for ${change.previousPath}.`,
        );
      }
      seenSources.add(change.previousPath);
      renameTokens.set(
        change.path,
        state.tokens.get(change.previousPath) ??
          registry.id("history-path", {
            firstObservedAt: commitSha,
            path: change.previousPath,
            reason: "rename-origin",
          }),
      );
    }
  }

  for (const change of changes) {
    budget.consume();
    if (change.kind === "deleted" || change.kind === "type-changed") {
      state.tokens.delete(change.path);
    } else if (change.kind === "renamed") {
      state.tokens.delete(change.previousPath);
    }
  }
  for (const change of changes) {
    budget.consume();
    switch (change.kind) {
      case "added":
      case "type-changed":
        pathToken(state, registry, change.path, {
          firstObservedAt: commitSha,
          path: change.path,
          reason: change.kind,
        });
        break;
      case "renamed": {
        const token = renameTokens.get(change.path);
        if (token === undefined) {
          fail("invalid-input", "A rename token could not be resolved.");
        }
        state.tokens.set(change.path, token);
        break;
      }
      case "deleted":
      case "modified":
        break;
    }
  }
}

function assignEntityIdentities(
  prefix: string,
  commitSha: string,
  current: readonly EntityIdentityInput[],
  previous: readonly AssignedEntityIdentity[],
  registry: LineageRegistry,
  maximumCandidateEdges: number,
  budget: IdentityMatchBudget,
): readonly AssignedEntityIdentity[] {
  const edges: Array<{
    readonly current: EntityIdentityInput;
    readonly previous: AssignedEntityIdentity;
    readonly score: number;
  }> = [];
  // A pair can score only through one of these three keys. Enumerating their
  // postings preserves the former greedy scoring order without a Cartesian
  // current-by-previous scan for sparse frames.
  const previousByRawId = new Map<
    string,
    AssignedEntityIdentity[]
  >();
  const previousByPathToken = new Map<
    string,
    AssignedEntityIdentity[]
  >();
  const previousByMemberId = new Map<
    string,
    AssignedEntityIdentity[]
  >();
  const addToIndex = (
    index: Map<string, AssignedEntityIdentity[]>,
    key: string,
    value: AssignedEntityIdentity,
  ): void => {
    const entries = index.get(key);
    if (entries === undefined) index.set(key, [value]);
    else entries.push(value);
  };

  budget.checkpoint();
  previous.forEach((prior) => {
    budget.consume();
    addToIndex(previousByRawId, prior.rawId, prior);
    if (prior.pathToken !== undefined) {
      addToIndex(previousByPathToken, prior.pathToken, prior);
    }
    prior.memberIds.forEach((memberId) => {
      budget.consume();
      addToIndex(previousByMemberId, memberId, prior);
    });
  });

  let candidateEdgeCount = 0;
  current.forEach((candidate) => {
    budget.consume();
    const overlaps = new Map<AssignedEntityIdentity, number>();
    const observe = (
      prior: AssignedEntityIdentity,
      overlapsMember: boolean,
    ): void => {
      budget.consume();
      const existing = overlaps.get(prior);
      if (existing === undefined) {
        candidateEdgeCount += 1;
        if (candidateEdgeCount > maximumCandidateEdges) {
          fail(
            "limit-exceeded",
            `A history frame exceeded ${maximumCandidateEdges} identity-matching candidates.`,
          );
        }
        budget.addCandidate();
        overlaps.set(prior, overlapsMember ? 1 : 0);
      } else if (overlapsMember) {
        overlaps.set(prior, existing + 1);
      }
    };

    previousByRawId
      .get(candidate.rawId)
      ?.forEach((prior) => observe(prior, false));
    if (candidate.pathToken !== undefined) {
      previousByPathToken
        .get(candidate.pathToken)
        ?.forEach((prior) => observe(prior, false));
    }
    candidate.memberIds.forEach((memberId) => {
      previousByMemberId
        .get(memberId)
        ?.forEach((prior) => observe(prior, true));
    });

    overlaps.forEach((overlap, prior) => {
      budget.consume();
      const samePathToken =
        candidate.pathToken !== undefined &&
        candidate.pathToken === prior.pathToken;
      const exactRaw =
        candidate.rawId === prior.rawId &&
        (candidate.pathToken === undefined || samePathToken);
      const score =
        (exactRaw ? 1_000_000_000 : 0) +
        (samePathToken ? 100_000_000 : 0) +
        overlap;
      if (score > 0) edges.push({ current: candidate, previous: prior, score });
    });
  });
  budget.checkpoint();
  edges.sort(
    (left, right) =>
      right.score - left.score ||
      compareText(left.current.rawId, right.current.rawId) ||
      compareText(left.previous.id, right.previous.id),
  );

  const assignedCurrent = new Map<string, string>();
  const assignedPrevious = new Set<string>();
  edges.forEach((edge) => {
    budget.consume();
    if (
      !assignedCurrent.has(edge.current.rawId) &&
      !assignedPrevious.has(edge.previous.id)
    ) {
      assignedCurrent.set(edge.current.rawId, edge.previous.id);
      assignedPrevious.add(edge.previous.id);
    }
  });
  budget.checkpoint();

  return Object.freeze(
    [...current]
      .sort((left, right) => compareText(left.rawId, right.rawId))
      .map((candidate) => {
        budget.consume();
        return Object.freeze({
          ...candidate,
          id:
            assignedCurrent.get(candidate.rawId) ??
            registry.id(prefix, {
              discriminator: candidate.discriminator,
              firstObservedAt: commitSha,
              members: [...candidate.memberIds].sort(compareText),
              pathToken: candidate.pathToken ?? null,
              rawId: candidate.rawId,
            }),
        });
      }),
  );
}

function modulePathToken(
  module: CityModule,
  state: PathLineageState,
): string | undefined {
  if (
    module.kind === "dotnet-project" ||
    module.kind === "angular-project" ||
    module.kind === "npm-package"
  ) {
    return state.tokens.get(module.path);
  }
  return undefined;
}

function normalizedLogicalPackageId(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase("en-US");
}

function typescriptPackageGateway(specifier: string): string {
  if (specifier.startsWith(".")) {
    return sanitizeExternalReference(specifier, "unresolved-module");
  }
  const redacted = sanitizeExternalReference(specifier, "external-module");
  if (redacted !== specifier) return redacted;
  if (specifier.startsWith("@")) {
    return specifier.split("/").slice(0, 2).join("/");
  }
  return specifier.split("/")[0] ?? specifier;
}

function normalizedTypeScriptModulePath(value: string): string | undefined {
  const normalized = path.posix.normalize(
    value.normalize("NFC").replaceAll("\\", "/"),
  );
  if (
    normalized === ".." ||
    normalized.startsWith("../") ||
    path.posix.isAbsolute(normalized)
  ) {
    return undefined;
  }
  const withoutExtension = normalized.replace(
    /(?:\.d)?\.[cm]?[jt]sx?$/iu,
    "",
  );
  return withoutExtension.endsWith("/index")
    ? withoutExtension.slice(0, -"/index".length)
    : withoutExtension;
}

function resolvedTypeScriptSpecifierPath(
  sourcePath: string,
  specifier: string,
): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  let safeSpecifier: string;
  try {
    safeSpecifier = safeRelativeInputPath(specifier);
  } catch {
    return undefined;
  }
  return normalizedTypeScriptModulePath(
    path.posix.join(path.posix.dirname(sourcePath), safeSpecifier),
  );
}

function projectReferenceMaterial(
  dependency: CityDependency,
  modulesById: ReadonlyMap<string, CityModule>,
  budget: EvolutionWorkBudget,
): DependencyLogicalReference | undefined {
  const source = modulesById.get(dependency.sourceId);
  if (source === undefined) return undefined;
  const target =
    dependency.targetId === undefined
      ? undefined
      : modulesById.get(dependency.targetId);
  let referenceName: string;
  let resolvedPath: string | undefined;
  if (target !== undefined) {
    referenceName = path.posix.basename(target.path);
    resolvedPath = path.posix.normalize(target.path.replaceAll("\\", "/"));
  } else if (dependency.externalTarget !== undefined) {
    let externalPath: string;
    try {
      externalPath = safeRelativeInputPath(dependency.externalTarget);
    } catch {
      return undefined;
    }
    referenceName = path.posix.basename(externalPath);
    const candidate = path.posix.normalize(
      path.posix.join(path.posix.dirname(source.path), externalPath),
    );
    if (
      candidate !== ".." &&
      !candidate.startsWith("../") &&
      !path.posix.isAbsolute(candidate)
    ) {
      resolvedPath = candidate;
    }
  } else {
    return undefined;
  }

  let matchingProjectNames = 0;
  for (const module of modulesById.values()) {
    budget.consume();
    if (
      module.id !== source.id &&
      module.kind === "dotnet-project" &&
      path.posix.basename(module.path) === referenceName
    ) {
      matchingProjectNames += 1;
    }
  }
  if (target === undefined && matchingProjectNames > 0) {
    return undefined;
  }
  if (matchingProjectNames <= 1) {
    return Object.freeze({
      key: `project-name:${referenceName.normalize("NFC")}`,
      requiresUniqueMatch: true,
    });
  }
  return resolvedPath === undefined
    ? undefined
    : Object.freeze({
        key: `project-path:${resolvedPath.normalize("NFC")}`,
        requiresUniqueMatch: false,
      });
}

function typescriptReferenceMaterial(
  dependency: CityDependency,
  modulesById: ReadonlyMap<string, CityModule>,
  sourcesById: ReadonlyMap<string, HistorySourceFileFact>,
  budget: EvolutionWorkBudget,
): DependencyLogicalReference | undefined {
  const source = sourcesById.get(dependency.sourceId);
  if (source === undefined) return undefined;
  const target =
    dependency.targetId === undefined
      ? undefined
      : sourcesById.get(dependency.targetId);
  const targetPath =
    target === undefined
      ? undefined
      : normalizedTypeScriptModulePath(target.path);
  const targetModule =
    target === undefined ? undefined : modulesById.get(target.moduleId);
  const targetPackageId =
    targetModule?.packageId === undefined
      ? undefined
      : normalizedLogicalPackageId(targetModule.packageId);
  const references = new Set<string>();
  const aliasGateways = new Map<string, number>();

  for (const imported of source.imports) {
    budget.consume();
    const gateway = typescriptPackageGateway(imported.specifier);
    if (target !== undefined) {
      if (imported.specifier.startsWith(".")) {
        const resolved = resolvedTypeScriptSpecifierPath(
          source.path,
          imported.specifier,
        );
        if (resolved !== undefined && resolved === targetPath) {
          references.add(`typescript-path:${resolved}`);
        }
      } else if (
        targetPackageId !== undefined &&
        normalizedLogicalPackageId(gateway) === targetPackageId
      ) {
        references.add(`typescript-package:${targetPackageId}`);
      } else {
        const key = `typescript-package:${normalizedLogicalPackageId(
          gateway,
        )}`;
        aliasGateways.set(
          key,
          (aliasGateways.get(key) ?? 0) + imported.count,
        );
      }
    } else if (
      dependency.externalTarget !== undefined &&
      gateway === dependency.externalTarget
    ) {
      if (imported.specifier.startsWith(".")) {
        const resolved = resolvedTypeScriptSpecifierPath(
          source.path,
          imported.specifier,
        );
        if (resolved !== undefined) {
          references.add(`typescript-path:${resolved}`);
        }
      } else {
        references.add(
          `typescript-package:${normalizedLogicalPackageId(gateway)}`,
        );
      }
    }
  }
  if (references.size === 0 && target !== undefined) {
    const aliases = [...aliasGateways.entries()];
    if (
      aliases.length === 1 &&
      aliases[0]![1] === dependency.weight
    ) {
      references.add(aliases[0]![0]);
    }
  }
  if (references.size !== 1) return undefined;
  return Object.freeze({
    key: references.values().next().value!,
    requiresUniqueMatch: false,
  });
}

function dependencyLogicalReference(
  dependency: CityDependency,
  modulesById: ReadonlyMap<string, CityModule>,
  sourcesById: ReadonlyMap<string, HistorySourceFileFact>,
  budget: EvolutionWorkBudget,
): DependencyLogicalReference | undefined {
  let reference: DependencyLogicalReference | undefined;
  switch (dependency.kind) {
    case "package-reference": {
      const target =
        dependency.targetId === undefined
          ? undefined
          : modulesById.get(dependency.targetId);
      const packageId = target?.packageId ?? dependency.externalTarget;
      if (packageId !== undefined) {
        reference = Object.freeze({
          key: `package:${normalizedLogicalPackageId(packageId)}`,
          requiresUniqueMatch: false,
        });
      }
      break;
    }
    case "project-reference":
      reference = projectReferenceMaterial(
        dependency,
        modulesById,
        budget,
      );
      break;
    case "typescript-import":
      reference = typescriptReferenceMaterial(
        dependency,
        modulesById,
        sourcesById,
        budget,
      );
      break;
  }
  if (reference === undefined) return undefined;
  return Object.freeze({
    key: canonicalJson(
      {
        kind: dependency.kind,
        reference: reference.key,
        repositoryId: dependency.repositoryId,
        sourceId: dependency.sourceId,
      },
      () => budget.consume(),
    ),
    requiresUniqueMatch: reference.requiresUniqueMatch,
  });
}

function dependencyEdgeMaterial(
  dependency: CityDependency,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    externalTarget: dependency.externalTarget ?? null,
    kind: dependency.kind,
    repositoryId: dependency.repositoryId,
    sourceId: dependency.sourceId,
    targetId: dependency.targetId ?? null,
  });
}

function dependencyMutableFingerprint(
  dependency: CityDependency,
  budget: EvolutionWorkBudget,
): string {
  return canonicalJson(
    {
      resolution: dependency.resolution ?? null,
      version: dependency.version ?? null,
      weight: dependency.weight,
    },
    () => budget.consume(),
  );
}

function dependencyLogicalMatchFingerprint(
  dependency: CityDependency,
  budget: EvolutionWorkBudget,
): string {
  return canonicalJson(
    {
      version: dependency.version ?? null,
      weight: dependency.weight,
    },
    () => budget.consume(),
  );
}

function assignDependencyIdentities(
  commitSha: string,
  inputs: readonly DependencyIdentityInput[],
  previous: readonly AssignedDependencyIdentity[],
  registry: LineageRegistry,
  lineageBudget: EntityLineageBudget,
  budget: EvolutionWorkBudget,
): readonly AssignedDependencyIdentity[] {
  const candidates = inputs.map(
    (input): DependencyIdentityCandidate => {
      budget.consume();
      const { entity: dependency } = input;
      const edgeMaterial = dependencyEdgeMaterial(dependency);
      return Object.freeze({
        rawId: dependency.id,
        edgeKey: canonicalJson(edgeMaterial, () => budget.consume()),
        edgeMaterial,
        ...(input.logicalReferenceKey === undefined
          ? {}
          : { logicalReferenceKey: input.logicalReferenceKey }),
        logicalReferenceRequiresUniqueMatch:
          input.logicalReferenceRequiresUniqueMatch,
        logicalMatchFingerprint: dependencyLogicalMatchFingerprint(
          dependency,
          budget,
        ),
        mutableFingerprint: dependencyMutableFingerprint(
          dependency,
          budget,
        ),
        entity: dependency,
      });
    },
  );
  const assigned = new Map<DependencyIdentityCandidate, string>();
  const claimed = new Set<string>();
  const currentByEdge = new Map<
    string,
    DependencyIdentityCandidate[]
  >();
  const previousByEdge = new Map<
    string,
    AssignedDependencyIdentity[]
  >();
  for (const candidate of candidates) {
    budget.consume();
    const entries = currentByEdge.get(candidate.edgeKey);
    if (entries === undefined) {
      currentByEdge.set(candidate.edgeKey, [candidate]);
    } else {
      entries.push(candidate);
    }
  }
  for (const prior of previous) {
    budget.consume();
    const entries = previousByEdge.get(prior.edgeKey);
    if (entries === undefined) {
      previousByEdge.set(prior.edgeKey, [prior]);
    } else {
      entries.push(prior);
    }
  }

  const compareCandidate = (
    left: DependencyIdentityCandidate,
    right: DependencyIdentityCandidate,
  ): number =>
    compareText(left.rawId, right.rawId) ||
    compareText(left.mutableFingerprint, right.mutableFingerprint) ||
    compareText(left.edgeKey, right.edgeKey);
  const comparePrior = (
    left: AssignedDependencyIdentity,
    right: AssignedDependencyIdentity,
  ): number => compareText(left.id, right.id);
  const assignWithinGroup = (
    current: readonly DependencyIdentityCandidate[],
    prior: readonly AssignedDependencyIdentity[],
    matchFingerprint: (
      entry: DependencyIdentityCandidate,
    ) => string = (entry) => entry.mutableFingerprint,
  ): void => {
    const orderedCurrent = [...current]
      .filter((candidate) => !assigned.has(candidate))
      .sort(compareCandidate);
    const orderedPrior = [...prior]
      .filter((entry) => !claimed.has(entry.id))
      .sort(comparePrior);
    if (orderedCurrent.length === 0 || orderedPrior.length === 0) return;

    const indexPrevious = (
      key: (entry: AssignedDependencyIdentity) => string,
    ): Map<string, AssignedDependencyIdentity[]> => {
      const index = new Map<string, AssignedDependencyIdentity[]>();
      for (const entry of orderedPrior) {
        budget.consume();
        const value = key(entry);
        const entries = index.get(value);
        if (entries === undefined) index.set(value, [entry]);
        else entries.push(entry);
      }
      return index;
    };
    const previousByRawId = indexPrevious((entry) => entry.rawId);
    const previousByMatchFingerprint = indexPrevious(
      (entry) => matchFingerprint(entry),
    );
    const rawOffsets = new Map<string, number>();
    const mutableOffsets = new Map<string, number>();
    const claimIndexed = (
      candidate: DependencyIdentityCandidate,
      index: ReadonlyMap<string, readonly AssignedDependencyIdentity[]>,
      key: string,
      offsets: Map<string, number>,
    ): void => {
      if (assigned.has(candidate)) return;
      const entries = index.get(key);
      if (entries === undefined) return;
      let offset = offsets.get(key) ?? 0;
      while (offset < entries.length && claimed.has(entries[offset]!.id)) {
        budget.consume();
        offset += 1;
      }
      const match = entries[offset];
      if (match === undefined) return;
      offsets.set(key, offset + 1);
      assigned.set(candidate, match.id);
      claimed.add(match.id);
    };

    for (const candidate of orderedCurrent) {
      budget.consume();
      claimIndexed(
        candidate,
        previousByRawId,
        candidate.rawId,
        rawOffsets,
      );
    }
    for (const candidate of orderedCurrent) {
      budget.consume();
      claimIndexed(
        candidate,
        previousByMatchFingerprint,
        matchFingerprint(candidate),
        mutableOffsets,
      );
    }
    const remainingPrior = orderedPrior.filter((entry) => {
      budget.consume();
      return !claimed.has(entry.id);
    });
    let remainingIndex = 0;
    for (const candidate of orderedCurrent) {
      budget.consume();
      if (assigned.has(candidate)) continue;
      const match = remainingPrior[remainingIndex];
      if (match === undefined) break;
      remainingIndex += 1;
      assigned.set(candidate, match.id);
      claimed.add(match.id);
    }
  };

  const edgeKeys = [...currentByEdge.keys()].sort((left, right) => {
    budget.consume();
    return compareText(left, right);
  });
  budget.checkpoint();
  for (const edgeKey of edgeKeys) {
    budget.consume();
    assignWithinGroup(
      currentByEdge.get(edgeKey)!,
      previousByEdge.get(edgeKey) ?? [],
    );
  }

  const currentByLogicalReference = new Map<
    string,
    DependencyIdentityCandidate[]
  >();
  const previousByLogicalReference = new Map<
    string,
    AssignedDependencyIdentity[]
  >();
  for (const candidate of candidates) {
    budget.consume();
    if (candidate.logicalReferenceKey === undefined) continue;
    const entries = currentByLogicalReference.get(
      candidate.logicalReferenceKey,
    );
    if (entries === undefined) {
      currentByLogicalReference.set(candidate.logicalReferenceKey, [
        candidate,
      ]);
    } else {
      entries.push(candidate);
    }
  }
  for (const prior of previous) {
    budget.consume();
    if (prior.logicalReferenceKey === undefined) continue;
    const entries = previousByLogicalReference.get(
      prior.logicalReferenceKey,
    );
    if (entries === undefined) {
      previousByLogicalReference.set(prior.logicalReferenceKey, [prior]);
    } else {
      entries.push(prior);
    }
  }
  const logicalReferenceKeys = [...currentByLogicalReference.keys()].sort(
    (left, right) => {
      budget.consume();
      return compareText(left, right);
    },
  );
  budget.checkpoint();
  for (const logicalReferenceKey of logicalReferenceKeys) {
    budget.consume();
    const current = currentByLogicalReference.get(logicalReferenceKey)!;
    const prior =
      previousByLogicalReference.get(logicalReferenceKey) ?? [];
    if (prior.length === 0) continue;
    const requiresUniqueMatch =
      current.some((entry) => {
        budget.consume();
        return entry.logicalReferenceRequiresUniqueMatch;
      }) ||
      prior.some((entry) => {
        budget.consume();
        return entry.logicalReferenceRequiresUniqueMatch;
      });
    // Project-reference display names are a deliberately weak fallback when
    // an unresolved path has been redacted to a leaf name. Use that fallback
    // only for a globally one-to-one logical reference in both active frames;
    // exact edge matches above remain safe even when names are ambiguous.
    if (
      requiresUniqueMatch &&
      (current.length !== 1 || prior.length !== 1)
    ) {
      continue;
    }
    assignWithinGroup(
      current,
      prior,
      (entry) => entry.logicalMatchFingerprint,
    );
  }

  const result: AssignedDependencyIdentity[] = [];
  for (const edgeKey of edgeKeys) {
    budget.consume();
    const current = currentByEdge.get(edgeKey)!;
    current.sort(compareCandidate);
    current.forEach((candidate, occurrence) => {
      budget.consume();
      const id =
        assigned.get(candidate) ??
        registry.id(DEPENDENCY_LINEAGE_PREFIX, {
          edge: candidate.edgeMaterial,
          firstObservedAt: commitSha,
          occurrence,
        });
      lineageBudget.add("dependencies", id);
      result.push(
        Object.freeze({
          ...candidate,
          id,
        }),
      );
    });
  }
  budget.checkpoint();
  return Object.freeze(
    result.sort((left, right) => {
      budget.consume();
      return compareText(left.id, right.id);
    }),
  );
}

function prepareFrames(
  request: HistoryEvolutionRequest,
  registry: LineageRegistry,
  lineageBudget: EntityLineageBudget,
  repositoryId: string,
  identityMatchBudget: IdentityMatchBudget,
  workBudget: EvolutionWorkBudget,
): readonly PreparedFrame[] {
  const pathState: PathLineageState = {
    tokens: new Map(),
    materials: new Map(),
  };
  const prepared: PreparedFrame[] = [];
  let previousModules: readonly AssignedEntityIdentity[] = [];
  let previousSolutions: readonly AssignedEntityIdentity[] = [];

  seedFramePaths(
    pathState,
    registry,
    request.frames[0]!,
    workBudget,
  );
  for (const [frameIndex, frame] of request.frames.entries()) {
    workBudget.consume();
    workBudget.checkpoint();
    const commit = frame.commit;
    if (frameIndex > 0) {
      applyPathChanges(
        pathState,
        registry,
        commit.sha,
        request.boundaryChangesByCommit.get(commit.sha)!,
        workBudget,
      );
    }
    seedFramePaths(pathState, registry, frame, workBudget);

    const sourceIds = new Map<string, string>();
    const sourceIdsByPath = new Map<string, string>();
    workBudget.checkpoint();
    const orderedSources = [...frame.facts.sources].sort(
      (left, right) => compareText(left.path, right.path),
    );
    workBudget.checkpoint();
    orderedSources.forEach((source) => {
      workBudget.consume();
      const token =
        pathState.tokens.get(source.path) ??
        pathToken(pathState, registry, source.path, {
          firstObservedAt: commit.sha,
          path: source.path,
          reason: "semantic-observation",
        });
      const id = registry.id(SOURCE_LINEAGE_PREFIX, {
        repositoryId,
        token,
      });
      if (
        sourceIds.has(source.id) ||
        sourceIdsByPath.has(source.path)
      ) {
        fail(
          "invalid-input",
          "A sampled frame contains duplicate source identities.",
        );
      }
      sourceIds.set(source.id, id);
      sourceIdsByPath.set(source.path, id);
      lineageBudget.add("buildings", id);
    });

    const moduleMembers = new Map<string, Set<string>>();
    frame.facts.sources.forEach((source) => {
      workBudget.consume();
      const members =
        moduleMembers.get(source.moduleId) ?? new Set<string>();
      members.add(sourceIds.get(source.id)!);
      moduleMembers.set(source.moduleId, members);
    });
    const currentModules = frame.facts.modules.map(
      (module): EntityIdentityInput => {
        workBudget.consume();
        const resolvedPathToken = modulePathToken(module, pathState);
        return Object.freeze({
          rawId: module.id,
          ...(resolvedPathToken === undefined
            ? {}
            : { pathToken: resolvedPathToken }),
          memberIds: moduleMembers.get(module.id) ?? new Set<string>(),
          discriminator: `${module.kind}\u0000${module.path}`,
        });
      },
    );
    const assignedModules = assignEntityIdentities(
      MODULE_LINEAGE_PREFIX,
      commit.sha,
      currentModules,
      previousModules,
      registry,
      request.selection.analysisBounds.maxUniqueLineages,
      identityMatchBudget,
    );
    for (const module of assignedModules) {
      workBudget.consume();
      lineageBudget.add("modules", module.id);
      lineageBudget.add(
        "districts",
        stableId("district", repositoryId, module.id),
      );
    }
    const moduleIds = new Map(
      assignedModules.map((module) => {
        workBudget.consume();
        return [module.rawId, module.id];
      }),
    );

    const currentSolutions = frame.facts.solutions.map(
      (solution): EntityIdentityInput => {
        workBudget.consume();
        const resolvedPathToken = pathState.tokens.get(solution.path);
        return Object.freeze({
          rawId: solution.id,
          ...(resolvedPathToken === undefined
            ? {}
            : { pathToken: resolvedPathToken }),
          memberIds: new Set(
            solution.moduleIds
              .map((id) => {
                workBudget.consume();
                return moduleIds.get(id);
              })
              .filter((id): id is string => id !== undefined),
          ),
          discriminator: solution.path,
        });
      },
    );
    const assignedSolutions = assignEntityIdentities(
      SOLUTION_LINEAGE_PREFIX,
      commit.sha,
      currentSolutions,
      previousSolutions,
      registry,
      request.selection.analysisBounds.maxUniqueLineages,
      identityMatchBudget,
    );
    lineageBudget.addAll("solutions", assignedSolutions);
    const solutionIds = new Map(
      assignedSolutions.map((solution) => {
        workBudget.consume();
        return [solution.rawId, solution.id];
      }),
    );

    prepared.push(
      Object.freeze({
        input: frame,
        sourceIds,
        sourceIdsByPath,
        moduleIds,
        solutionIds,
      }),
    );
    previousModules = assignedModules;
    previousSolutions = assignedSolutions;
  }
  if (prepared.length !== request.frames.length) {
    fail(
      "invalid-input",
      "Not every sampled frame belongs to the selected history.",
    );
  }
  return Object.freeze(prepared);
}

function remapIdentity(
  identity: LocalAnalysisFacts["identity"],
  repositoryId: string,
  budget: EvolutionWorkBudget,
): LocalAnalysisFacts["identity"] {
  if (identity === undefined) return undefined;
  return Object.freeze({
    ...identity,
    ...(identity.repositories === undefined
      ? {}
      : {
          repositories: Object.freeze(
            identity.repositories.map((entry) => {
              budget.consume();
              return Object.freeze({
                ...entry,
                repositoryId,
              });
            }),
          ),
        }),
  });
}

function remapSourceBoundId(
  value: string,
  sourceId: string,
  lineageId: string,
): string {
  const prefix = `${sourceId}:`;
  return value.startsWith(prefix)
    ? `${lineageId}:${value.slice(prefix.length)}`
    : value;
}

/**
 * Fine-grained analyzer identities are namespaced by the path-derived source
 * id. History replaces that id with a stable lineage id, so the nested
 * identities must follow the same replacement. Otherwise an exact rename
 * would make unchanged callable evidence look like a metric change.
 */
function remapSourceBoundIdentities(
  source: HistorySourceFileFact,
  lineageId: string,
  budget: EvolutionWorkBudget,
): Partial<
  Pick<
    LocalAnalysisFacts["sources"][number],
    "units" | "sourceStructure"
  >
> {
  if (source.units === undefined) return Object.freeze({});
  const remapId = (value: string): string =>
    remapSourceBoundId(value, source.id, lineageId);
  const units = Object.freeze(
    source.units.map((unit) => {
      budget.consume();
      const evidence = unit.decisionEvidence;
      if (evidence === undefined) return unit;
      return Object.freeze({
        ...unit,
        decisionEvidence: Object.freeze({
          ...evidence,
          unitId: remapId(evidence.unitId),
          ...(evidence.callableId === undefined
            ? {}
            : { callableId: remapId(evidence.callableId) }),
        }),
      });
    }),
  );
  const structure = source.sourceStructure;
  if (structure === undefined) return Object.freeze({ units });
  return Object.freeze({
    units,
    sourceStructure: Object.freeze({
      ...structure,
      types: Object.freeze(
        structure.types.map((item) => {
          budget.consume();
          return Object.freeze({
            ...item,
            id: remapId(item.id),
            ...(item.parentTypeId === undefined
              ? {}
              : { parentTypeId: remapId(item.parentTypeId) }),
          });
        }),
      ),
      callables: Object.freeze(
        structure.callables.map((item) => {
          budget.consume();
          return Object.freeze({
            ...item,
            id: remapId(item.id),
            ...(item.enclosingTypeId === undefined
              ? {}
              : { enclosingTypeId: remapId(item.enclosingTypeId) }),
          });
        }),
      ),
      relations: Object.freeze(
        structure.relations.map((item) => {
          budget.consume();
          return Object.freeze({
            ...item,
            id: remapId(item.id),
            sourceId: remapId(item.sourceId),
            targetId: remapId(item.targetId),
          });
        }),
      ),
    }),
  });
}

function remapFrame(
  prepared: PreparedFrame,
  repositoryId: string,
  registry: LineageRegistry,
  lineageBudget: EntityLineageBudget,
  dependencyState: DependencyIdentityState,
  budget: EvolutionWorkBudget,
): AssignedFrame {
  const { facts } = prepared.input;
  const modules = facts.modules.map((module): CityModule => {
    budget.consume();
    const id = prepared.moduleIds.get(module.id);
    if (id === undefined) {
      fail("invalid-input", "A module lineage could not be resolved.");
    }
    const solutionIds = module.solutionIds.map((solutionId) => {
      budget.consume();
      const mapped = prepared.solutionIds.get(solutionId);
      if (mapped === undefined) {
        fail("invalid-input", "A module solution lineage is missing.");
      }
      return mapped;
    });
    const parentModuleId =
      module.parentModuleId === undefined
        ? undefined
        : prepared.moduleIds.get(module.parentModuleId);
    if (
      module.parentModuleId !== undefined &&
      parentModuleId === undefined
    ) {
      fail("invalid-input", "A parent module lineage is missing.");
    }
    return Object.freeze({
      ...module,
      id,
      repositoryId,
      ...(parentModuleId === undefined ? {} : { parentModuleId }),
      solutionIds: Object.freeze(solutionIds.sort(compareText)),
    });
  });
  const solutions = facts.solutions.map((solution): CitySolution => {
    budget.consume();
    const id = prepared.solutionIds.get(solution.id);
    if (id === undefined) {
      fail("invalid-input", "A solution lineage could not be resolved.");
    }
    return Object.freeze({
      ...solution,
      id,
      repositoryId,
      moduleIds: Object.freeze(
        solution.moduleIds
          .map((moduleId) => {
            budget.consume();
            const mapped = prepared.moduleIds.get(moduleId);
            if (mapped === undefined) {
              fail(
                "invalid-input",
                "A solution module lineage is missing.",
              );
            }
            return mapped;
          })
          .sort(compareText),
      ),
    });
  });
  const sources = facts.sources.map((source): HistorySourceFileFact => {
    budget.consume();
    const id = prepared.sourceIds.get(source.id);
    const moduleId = prepared.moduleIds.get(source.moduleId);
    if (id === undefined || moduleId === undefined) {
      fail("invalid-input", "A source lineage could not be resolved.");
    }
    const districtId = stableId(
      "district",
      repositoryId,
      moduleId,
    );
    if (source.units === undefined) {
      return Object.freeze({
        ...source,
        id,
        repositoryId,
        moduleId,
        districtId,
      });
    }
    const boundIdentities = remapSourceBoundIdentities(
      source,
      id,
      budget,
    );
    return Object.freeze({
      ...source,
      ...boundIdentities,
      id,
      repositoryId,
      moduleId,
      districtId,
    });
  });
  const endpointIds = new Map<string, string>([
    ...prepared.sourceIds,
    ...prepared.moduleIds,
  ]);
  const remappedDependencies = facts.dependencies.map(
    (dependency): CityDependency => {
      budget.consume();
      const sourceId = endpointIds.get(dependency.sourceId);
      const targetId =
        dependency.targetId === undefined
          ? undefined
          : endpointIds.get(dependency.targetId);
      if (
        sourceId === undefined ||
        (dependency.targetId !== undefined && targetId === undefined)
      ) {
        fail(
          "invalid-input",
          "A dependency endpoint lineage could not be resolved.",
        );
      }
      return Object.freeze({
        ...dependency,
        repositoryId,
        sourceId,
        ...(targetId === undefined ? {} : { targetId }),
      });
    },
  );
  const modulesById = new Map(
    modules.map((module) => {
      budget.consume();
      return [module.id, module] as const;
    }),
  );
  const sourcesById = new Map(
    sources.map((source) => {
      budget.consume();
      return [source.id, source] as const;
    }),
  );
  const dependencyInputs = remappedDependencies.map(
    (dependency): DependencyIdentityInput => {
      budget.consume();
      const logicalReference = dependencyLogicalReference(
        dependency,
        modulesById,
        sourcesById,
        budget,
      );
      return Object.freeze({
        entity: dependency,
        ...(logicalReference === undefined
          ? {}
          : { logicalReferenceKey: logicalReference.key }),
        logicalReferenceRequiresUniqueMatch:
          logicalReference?.requiresUniqueMatch ?? false,
      });
    },
  );
  const assignedDependencies = assignDependencyIdentities(
    prepared.input.commit.sha,
    dependencyInputs,
    dependencyState.active,
    registry,
    lineageBudget,
    budget,
  );
  dependencyState.active = assignedDependencies;
  const dependencies = assignedDependencies.map(({ entity, id }) => {
    budget.consume();
    return Object.freeze({
      ...entity,
      id,
    });
  });
  const identity = remapIdentity(facts.identity, repositoryId, budget);
  const warnings = facts.warnings.map((warning) => {
    budget.consume();
    return warning;
  });
  budget.checkpoint();
  solutions.sort((left, right) => compareText(left.id, right.id));
  modules.sort((left, right) => compareText(left.id, right.id));
  sources.sort((left, right) => compareText(left.id, right.id));
  dependencies.sort((left, right) =>
    compareText(left.id, right.id),
  );
  budget.checkpoint();
  const assigned = Object.freeze({
    commit: prepared.input.commit,
    facts: Object.freeze({
      ...(identity === undefined ? {} : { identity }),
      repositories: Object.freeze([
        Object.freeze({
          ...facts.repositories[0]!,
          id: repositoryId,
        }),
      ]),
      solutions: Object.freeze(solutions),
      modules: Object.freeze(modules),
      sources: Object.freeze(sources),
      dependencies: Object.freeze(dependencies),
      warnings: Object.freeze(warnings),
    }),
  });
  budget.checkpoint();
  return assigned;
}

function maximumMetrics(
  left: SourceMetrics,
  right: SourceMetrics,
): SourceMetrics {
  return Object.freeze({
    sloc: Math.max(left.sloc, right.sloc),
    decisionLoad: Math.max(left.decisionLoad, right.decisionLoad),
    maximumComplexity: Math.max(
      left.maximumComplexity,
      right.maximumComplexity,
    ),
    executableUnitCount: Math.max(
      left.executableUnitCount,
      right.executableUnitCount,
    ),
  });
}

function unionSlotKey(buildingId: string, moduleId: string): string {
  return `${buildingId}\u0000${moduleId}`;
}

function createUnionLayout(
  frames: readonly AssignedFrame[],
  registry: LineageRegistry,
  budget: EvolutionWorkBudget,
  metricMapping: MetricMapping,
) {
  const repositories = new Map<string, CityRepository>();
  const modules = new Map<string, CityModule>();
  const slots = new Map<string, UnionSlot>();
  let identity: LocalAnalysisFacts["identity"];
  frames.forEach((frame) => {
    budget.consume();
    frame.facts.repositories.forEach((repository) => {
      budget.consume();
      repositories.set(repository.id, repository);
    });
    frame.facts.modules.forEach((module) => {
      budget.consume();
      modules.set(module.id, module);
    });
    if (frame.facts.identity !== undefined) identity = frame.facts.identity;
    frame.facts.sources.forEach((source) => {
      budget.consume();
      const key = unionSlotKey(source.id, source.moduleId);
      const existing = slots.get(key);
      if (existing === undefined) {
        slots.set(
          key,
          Object.freeze({
            id: registry.id(SLOT_PREFIX, {
              buildingId: source.id,
              moduleId: source.moduleId,
            }),
            buildingId: source.id,
            moduleId: source.moduleId,
            representative: source,
            metrics: source.metrics,
          }),
        );
      } else {
        slots.set(
          key,
          Object.freeze({
            ...existing,
            metrics: maximumMetrics(existing.metrics, source.metrics),
          }),
        );
      }
    });
  });
  budget.checkpoint();
  const layout = layoutCity(
    {
      repositories: [...repositories.values()],
      modules: [...modules.values()],
      buildings: [...slots.values()].map((slot, index) => {
        budget.consume();
        const projection =
          "definitionVersion" in metricMapping
            ? projectBuildingMetricMapping(
                slot.metrics,
                metricMapping,
                `union.buildings[${index}]`,
              )
            : undefined;
        return {
          id: slot.id,
          repositoryId: slot.representative.repositoryId,
          moduleId: slot.moduleId,
          name: slot.representative.name,
          path: slot.representative.path,
          language: slot.representative.language,
          metrics: slot.metrics,
          ...(slot.representative.units === undefined
            ? {}
            : {
                metricMethod: slot.representative.metricMethod,
                units: slot.representative.units,
              }),
          semanticGroupId:
            projection?.semanticGroupId ??
            slot.representative.semanticGroupId,
          ...(projection === undefined ? {} : { size: projection.size }),
        };
      }),
      ...(identity === undefined ? {} : { identity }),
    },
    {},
    {
      packingSearchMode: "bounded",
      checkpoint: (operations) => {
        budget.consume(operations);
        budget.checkpoint();
      },
    },
  );
  budget.checkpoint();
  return Object.freeze({ layout, slots });
}

function* positionFrames(
  frames: readonly AssignedFrame[],
  registry: LineageRegistry,
  budget: EvolutionWorkBudget,
  metricMapping: MetricMapping,
): Generator<CityModel, void, undefined> {
  const union = createUnionLayout(
    frames,
    registry,
    budget,
    metricMapping,
  );
  const districts = new Map(
    union.layout.districts.map((district) => {
      budget.consume();
      return [district.id, district];
    }),
  );
  const slotPositions = new Map(
    union.layout.buildings.map((building) => {
      budget.consume();
      return [building.id, building.position];
    }),
  );
  for (const frame of frames) {
    budget.consume();
    budget.checkpoint();
    const model = cityModelFromFacts(frame.facts, {
      metricMapping,
      layoutPackingSearchMode: "bounded",
      layoutCheckpoint: (operations) => {
        budget.consume(operations);
        budget.checkpoint();
      },
      validationCheckpoint: () => budget.checkpoint(),
    });
    budget.checkpoint();
    const positionedDistricts = model.districts.map((district) => {
      budget.consume();
      const geometry = districts.get(district.id);
      if (geometry === undefined) {
        fail(
          "invalid-input",
          "A union district placement could not be resolved.",
        );
      }
      return Object.freeze({
        ...district,
        position: geometry.position,
        size: geometry.size,
      });
    });
    const positionedBuildings = model.buildings.map((building) => {
      budget.consume();
      const slot = union.slots.get(
        unionSlotKey(building.id, building.moduleId),
      );
      const position =
        slot === undefined ? undefined : slotPositions.get(slot.id);
      if (position === undefined) {
        fail(
          "invalid-input",
          "A union building placement could not be resolved.",
        );
      }
      return Object.freeze({
        ...building,
        position: Object.freeze({
          x: position.x,
          y: building.position.y,
          z: position.z,
        }),
      });
    });
    const candidate = {
      ...model,
      districts: Object.freeze(positionedDistricts),
      buildings: Object.freeze(positionedBuildings),
      bounds: union.layout.bounds,
    } as Record<string, unknown>;
    if (union.layout.base === undefined) delete candidate["base"];
    else candidate["base"] = union.layout.base;
    if (model.identity === undefined) {
      delete candidate["identity"];
      delete candidate["identityPanel"];
    } else if (union.layout.identityPanel === undefined) {
      delete candidate["identityPanel"];
    } else {
      candidate["identityPanel"] = union.layout.identityPanel;
    }
    budget.checkpoint();
    const validated = validateCityModel(candidate, {
      checkpoint: () => budget.checkpoint(),
    });
    budget.checkpoint();
    yield validated;
  }
}

function deepEqual(
  left: unknown,
  right: unknown,
  budget: EvolutionWorkBudget,
): boolean {
  budget.consume();
  if (left === undefined || right === undefined) {
    return left === right;
  }
  const equal =
    canonicalJson(left, () => budget.consume()) ===
    canonicalJson(right, () => budget.consume());
  budget.checkpoint();
  return equal;
}

function entityDelta<T extends { readonly id: string }>(
  collection: EvolutionEntityCollection,
  before: readonly T[],
  after: readonly T[],
  budget: EvolutionWorkBudget,
): EvolutionEntityDelta<T> {
  const beforeById = new Map(
    before.map((entity) => {
      budget.consume();
      return [entity.id, entity] as const;
    }),
  );
  const afterById = new Map(
    after.map((entity) => {
      budget.consume();
      return [entity.id, entity] as const;
    }),
  );
  const added = [...after].filter(({ id }) => {
    budget.consume();
    return !beforeById.has(id);
  });
  budget.checkpoint();
  added.sort((left, right) => compareText(left.id, right.id));
  budget.checkpoint();
  const removed = [...beforeById.keys()].filter((id) => {
    budget.consume();
    return !afterById.has(id);
  });
  budget.checkpoint();
  removed.sort(compareText);
  budget.checkpoint();
  const changed = [...after]
    .filter(({ id }) => {
      budget.consume();
      return beforeById.has(id);
    })
    .flatMap((entity) => {
      budget.consume();
      const previous = beforeById.get(entity.id)!;
      if (deepEqual(previous, entity, budget)) return [];
      const changeKinds = deriveEvolutionChangeKinds(
        collection,
        previous as never,
        entity as never,
      );
      return [
        Object.freeze({
          id: entity.id,
          changeKinds,
          entity,
        }),
      ];
    });
  budget.checkpoint();
  changed.sort((left, right) => compareText(left.id, right.id));
  budget.checkpoint();
  return Object.freeze({
    added: Object.freeze(added),
    removed: Object.freeze(removed),
    changed: Object.freeze(changed),
  });
}

function assignModelChange(
  changes: Record<string, unknown>,
  key: keyof EvolutionModelChanges,
  before: unknown,
  after: unknown,
  budget: EvolutionWorkBudget,
): void {
  if (deepEqual(before, after, budget)) return;
  changes[key] = after === undefined ? null : after;
}

function modelDelta(
  before: CityModel,
  after: CityModel,
  budget: EvolutionWorkBudget,
): EvolutionChanges {
  const root: Record<string, unknown> = {};
  assignModelChange(
    root,
    "metricMapping",
    before.metricMapping,
    after.metricMapping,
    budget,
  );
  assignModelChange(
    root,
    "analysis",
    before.analysis,
    after.analysis,
    budget,
  );
  assignModelChange(
    root,
    "identity",
    before.identity,
    after.identity,
    budget,
  );
  assignModelChange(
    root,
    "identityPanel",
    before.identityPanel,
    after.identityPanel,
    budget,
  );
  assignModelChange(root, "base", before.base, after.base, budget);
  assignModelChange(
    root,
    "bounds",
    before.bounds,
    after.bounds,
    budget,
  );
  return Object.freeze({
    model: Object.freeze(root) as EvolutionModelChanges,
    repositories: entityDelta(
      "repositories",
      before.repositories,
      after.repositories,
      budget,
    ),
    solutions: entityDelta(
      "solutions",
      before.solutions,
      after.solutions,
      budget,
    ),
    modules: entityDelta(
      "modules",
      before.modules,
      after.modules,
      budget,
    ),
    semanticGroups: entityDelta(
      "semanticGroups",
      before.semanticGroups,
      after.semanticGroups,
      budget,
    ),
    districts: entityDelta(
      "districts",
      before.districts,
      after.districts,
      budget,
    ),
    buildings: entityDelta(
      "buildings",
      before.buildings,
      after.buildings,
      budget,
    ),
    dependencies: entityDelta(
      "dependencies",
      before.dependencies,
      after.dependencies,
      budget,
    ),
  });
}

function enforceAggregateTreeLimit(
  frames: readonly HistoryEvolutionFrameInput[],
  maximum: number,
  budget: EvolutionWorkBudget,
): void {
  let entries = 0;
  frames.forEach(({ facts }) => {
    budget.consume();
    entries +=
      facts.repositories.length +
      facts.solutions.length +
      facts.modules.length +
      facts.sources.length +
      facts.dependencies.length;
    if (entries > maximum) {
      fail(
        "limit-exceeded",
        `History analysis exceeded ${maximum} aggregate semantic tree entries.`,
      );
    }
  });
}

function enforceChangedPathLimit(
  request: HistoryEvolutionRequest,
  budget: EvolutionWorkBudget,
): void {
  let paths = 0;
  let pathBytes = 0;
  request.selection.sampledCommits.slice(1).forEach((commit) => {
    budget.consume();
    const changes = request.boundaryChangesByCommit.get(commit.sha)!;
    changes.forEach((change) => {
      budget.consume();
      validateChange(change);
      paths += change.kind === "renamed" ? 2 : 1;
      pathBytes +=
        HISTORY_CHANGED_PATH_RECORD_OVERHEAD_BYTES +
        Buffer.byteLength(change.path, "utf8");
      if (change.kind === "renamed") {
        pathBytes += Buffer.byteLength(change.previousPath, "utf8");
      }
      if (
        paths >
        request.selection.analysisBounds.maxAggregateChangedPaths
      ) {
        fail(
          "limit-exceeded",
          `History analysis exceeded ${request.selection.analysisBounds.maxAggregateChangedPaths} aggregate changed paths.`,
        );
      }
      if (
        pathBytes >
        request.selection.analysisBounds.maxAggregateChangedPathBytes
      ) {
        fail(
          "limit-exceeded",
          `History analysis exceeded ${request.selection.analysisBounds.maxAggregateChangedPathBytes} aggregate retained changed-path bytes.`,
        );
      }
    });
  });
}

/**
 * Produces deterministic, rename-aware CityModel frames and a canonical
 * evolution bundle. Each adjacent sampled-frame boundary contributes one
 * direct path diff, while semantic analysis and output remain bounded to the
 * sampled frames themselves.
 */
export function createHistoryEvolution(
  request: HistoryEvolutionRequest,
): HistoryEvolutionResult {
  const now = request.now ?? Date.now;
  const startedAt = now();
  const bounds = request.selection.analysisBounds;
  const workBudget = new EvolutionWorkBudget(
    bounds.maxAggregateTreeEntries * EVOLUTION_WORK_MULTIPLIER +
      bounds.maxAggregateChangedPaths * 8 +
      bounds.maxUniqueLineages * 16,
    startedAt,
    bounds.totalDeadlineMs,
    now,
    request.signal,
  );
  validateRequest(request, workBudget);
  const metricMapping = resolveHistoryMetricMapping(
    request.metricConfiguration,
  );
  enforceAggregateTreeLimit(
    request.frames,
    bounds.maxAggregateTreeEntries,
    workBudget,
  );
  enforceChangedPathLimit(request, workBudget);
  const registry = new LineageRegistry(() => workBudget.consume());
  const repositoryFingerprint = fingerprint(
    request.repositoryIdentity,
    () => workBudget.consume(),
  );
  const repositoryId = registry.id(REPOSITORY_LINEAGE_PREFIX, {
    repositoryFingerprint,
  });
  const lineageBudget = new EntityLineageBudget(
    bounds.maxUniqueLineages,
  );
  const identityMatchBudget = new IdentityMatchBudget(
    // Candidate graphs are bounded by semantic input size, while the larger
    // operation allowance covers index construction and repeated key hits.
    bounds.maxAggregateTreeEntries,
    bounds.maxAggregateTreeEntries * IDENTITY_WORK_MULTIPLIER,
    startedAt,
    bounds.totalDeadlineMs,
    now,
    request.signal,
  );
  lineageBudget.add("repositories", repositoryId);
  lineageBudget.addAll(
    "semanticGroups",
    "definitionVersion" in metricMapping
      ? DEFAULT_SEMANTIC_GROUPS.filter(
          ({ id }) =>
            !LEGACY_BUILDING_METRIC_SEMANTIC_GROUP_IDS.some(
              (legacyId) => legacyId === id,
            ),
        )
      : DEFAULT_SEMANTIC_GROUPS,
  );
  if ("definitionVersion" in metricMapping) {
    lineageBudget.addAll(
      "semanticGroups",
      semanticGroupsForMetricMapping(metricMapping, "base"),
    );
  }
  const prepared = prepareFrames(
    request,
    registry,
    lineageBudget,
    repositoryId,
    identityMatchBudget,
    workBudget,
  );
  const assigned: AssignedFrame[] = [];
  const dependencyState: DependencyIdentityState = {
    active: Object.freeze([]),
  };
  for (const frame of prepared) {
    workBudget.consume();
    workBudget.checkpoint();
    assigned.push(
      remapFrame(
        frame,
        repositoryId,
        registry,
        lineageBudget,
        dependencyState,
        workBudget,
      ),
    );
  }
  workBudget.checkpoint();

  const analyzerFingerprint = fingerprint(
    {
      semanticAnalyzer: request.analyzerFingerprint,
      historyBackend: request.historyBackend,
    },
    () => workBudget.consume(),
  );
  const metricConfigurationFingerprint = fingerprint(
    request.metricConfiguration,
    () => workBudget.consume(),
  );
  const selectionFingerprint = fingerprint(
    request.selection.summary,
    () => workBudget.consume(),
  );
  const commits = assigned.map(({ commit }, index) => {
    workBudget.consume();
    return Object.freeze({
      index,
      sha: commit.sha,
      committedAt: commit.committedAt,
      parentShas: Object.freeze([...commit.parents]),
      analyzerVersion: GENERATOR_VERSION,
      analysisFingerprint: fingerprint(
        {
          analyzerFingerprint,
          commitSha: commit.sha,
          metricConfigurationFingerprint,
          repositoryFingerprint,
        },
        () => workBudget.consume(),
      ),
    });
  });
  const positionedModels = positionFrames(
    assigned,
    registry,
    workBudget,
    metricMapping,
  );
  const baselineStep = positionedModels.next();
  if (baselineStep.done) {
    fail("invalid-input", "History evolution did not produce a baseline.");
  }
  const baselineModel = baselineStep.value;
  let previousModel = baselineModel;
  let finalModel = baselineModel;
  const deltas: EvolutionBundle["deltas"][number][] = [];
  for (let index = 1; index < commits.length; index += 1) {
    workBudget.consume();
    workBudget.checkpoint();
    const step = positionedModels.next();
    if (step.done) {
      fail(
        "invalid-input",
        "History evolution did not produce every selected frame.",
      );
    }
    const model = step.value;
    deltas.push(
      Object.freeze({
        commit: commits[index]!,
        changes: modelDelta(previousModel, model, workBudget),
      }),
    );
    previousModel = model;
    finalModel = model;
  }
  if (!positionedModels.next().done) {
    fail(
      "invalid-input",
      "History evolution produced an unexpected extra frame.",
    );
  }
  const projectStartProvenance =
    request.selection.summary.mode !== "root-to-tip" ||
    request.selection.summary.projectStartDetectionPolicy === undefined
      ? undefined
      : Object.freeze({
          detectionPolicyRevision: EVOLUTION_PROJECT_START_POLICY,
          ...(request.selection.summary.projectStartSha === undefined
            ? {}
            : {
                commitSha: request.selection.summary.projectStartSha,
              }),
        });
  const bundle: EvolutionBundle = Object.freeze({
    schemaVersion: EVOLUTION_BUNDLE_SCHEMA_VERSION,
    generator: Object.freeze({
      name: "code-city",
      version: GENERATOR_VERSION,
    }),
    authorPolicy: EVOLUTION_AUTHOR_POLICY,
    selection: request.selection.summary,
    provenance: Object.freeze({
      repositoryId,
      repositoryFingerprint,
      analyzer: Object.freeze({
        name: "code-city",
        version: GENERATOR_VERSION,
        fingerprint: analyzerFingerprint,
      }),
      historyBackend: Object.freeze({
        name: "git",
        version: request.historyBackend.version,
        renamePolicyRevision:
          request.historyBackend.renamePolicyRevision,
      }),
      metricConfigurationFingerprint,
      selectionFingerprint,
      ...(projectStartProvenance === undefined
        ? {}
        : { projectStart: projectStartProvenance }),
    }),
    baseline: Object.freeze({
      commit: commits[0]!,
      model: baselineModel,
    }),
    deltas: Object.freeze(deltas),
  });
  workBudget.checkpoint();
  const preparedSerialization = prepareEvolutionSerialization(bundle, {
    checkpoint: () => workBudget.checkpoint(),
  });
  const serializedBytes = preparedSerialization.measuredBytes;
  workBudget.checkpoint();
  if (serializedBytes > bounds.maxEvolutionOutputBytes) {
    fail(
      "limit-exceeded",
      `Evolution output exceeded ${bounds.maxEvolutionOutputBytes} bytes.`,
    );
  }
  return Object.freeze({
    repositoryId,
    model: finalModel,
    bundle: preparedSerialization.bundle,
    preparedSerialization,
  });
}
