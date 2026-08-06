import type {
  CityBase,
  CityBuilding,
  CityDependency,
  CityDistrict,
  CityIdentity,
  CityIdentityPanel,
  CityModel,
  CityModule,
  CityRepository,
  CitySolution,
  MetricMapping,
  SemanticGroup,
  Vector3,
} from "./model.js";

export const EVOLUTION_BUNDLE_SCHEMA_VERSION = "1.0" as const;
export const EVOLUTION_AUTHOR_POLICY = "omit-v1" as const;

export const EVOLUTION_CHANGE_KINDS = Object.freeze([
  "renamed",
  "moved",
  "metrics",
  "relationships",
  "geometry",
  "metadata",
] as const);

export type EvolutionChangeKind =
  (typeof EVOLUTION_CHANGE_KINDS)[number];

export const EVOLUTION_ENTITY_COLLECTIONS = Object.freeze([
  "repositories",
  "solutions",
  "modules",
  "semanticGroups",
  "districts",
  "buildings",
  "dependencies",
] as const);

export type EvolutionEntityCollection =
  (typeof EVOLUTION_ENTITY_COLLECTIONS)[number];

export interface EvolutionEntityByCollection {
  readonly repositories: CityRepository;
  readonly solutions: CitySolution;
  readonly modules: CityModule;
  readonly semanticGroups: SemanticGroup;
  readonly districts: CityDistrict;
  readonly buildings: CityBuilding;
  readonly dependencies: CityDependency;
}

export type EvolutionFingerprint = `sha256:${string}`;
export type GitObjectSha = string;

interface NormalizedEvolutionSelectionBase {
  readonly traversal: "first-parent";
  readonly order: "oldest-first";
  readonly selectedCommitCount: number;
  readonly sampledCommitCount: number;
  readonly traversedCommitCount: number;
  readonly resolvedOldestSha: GitObjectSha;
  readonly resolvedNewestSha: GitObjectSha;
  /**
   * Exact immutable frame order. The first SHA belongs to the full baseline;
   * every later SHA belongs to the corresponding delta.
   */
  readonly sampledCommitShas: readonly GitObjectSha[];
}

export type NormalizedEvolutionSelection =
  | (NormalizedEvolutionSelectionBase & {
      readonly mode: "root-to-tip";
      readonly samplingStrategy: "evenly-spaced-v1";
      readonly maxFrames: number;
    })
  | (NormalizedEvolutionSelectionBase & {
      readonly mode: "commit-count";
      readonly sampleEvery: number;
      readonly requestedCommitCount: number;
    })
  | (NormalizedEvolutionSelectionBase & {
      readonly mode: "date-range";
      readonly sampleEvery: number;
      /** Canonical UTC instant (`Date#toISOString()`). */
      readonly fromInclusive: string;
      /** Canonical UTC instant (`Date#toISOString()`). */
      readonly toInclusive: string;
    })
  | (NormalizedEvolutionSelectionBase & {
      /**
       * Tag names are intentionally not persisted. Resolved immutable SHAs
       * above make the semantic selection reproducible if tags later move.
       */
      readonly mode: "tag-range";
      readonly sampleEvery: number;
    });

export interface EvolutionAnalyzerProvenance {
  readonly name: "code-city";
  readonly version: string;
  /**
   * Fingerprint of the analyzer implementation, including language backends.
   */
  readonly fingerprint: EvolutionFingerprint;
}

export interface EvolutionHistoryBackendProvenance {
  readonly name: "git";
  /** Validated output-affecting Git implementation version. */
  readonly version: string;
  /** Code City revision of the fully pinned diff/rename invocation. */
  readonly renamePolicyRevision: string;
}

export interface EvolutionProvenance {
  /** CityModel repository ID whose first-parent history was analyzed. */
  readonly repositoryId: string;
  /** Credential-free canonical repository identity fingerprint. */
  readonly repositoryFingerprint: EvolutionFingerprint;
  readonly analyzer: EvolutionAnalyzerProvenance;
  readonly historyBackend: EvolutionHistoryBackendProvenance;
  /** Fingerprint of all metric and layout-affecting analysis configuration. */
  readonly metricConfigurationFingerprint: EvolutionFingerprint;
  /** Fingerprint of the normalized immutable history selection. */
  readonly selectionFingerprint: EvolutionFingerprint;
}

export interface EvolutionCommitMetadata {
  /** Zero-based position in oldest-first sampled frame order. */
  readonly index: number;
  readonly sha: GitObjectSha;
  /** Canonical UTC commit instant (`Date#toISOString()`). */
  readonly committedAt: string;
  /**
   * Git parent order is significant: the first item is the first parent.
   * Parent commits need not be sampled frames.
   */
  readonly parentShas: readonly GitObjectSha[];
  readonly analyzerVersion: string;
  /**
   * Cache/result fingerprint for this immutable commit plus analyzer and
   * metric configuration.
   */
  readonly analysisFingerprint: EvolutionFingerprint;
}

export interface EvolutionEntityReplacement<T> {
  readonly id: string;
  readonly changeKinds: readonly EvolutionChangeKind[];
  /** Complete replacement, never a partial entity patch. */
  readonly entity: T;
}

export interface EvolutionEntityDelta<T> {
  readonly added: readonly T[];
  readonly removed: readonly string[];
  readonly changed: readonly EvolutionEntityReplacement<T>[];
}

export interface EvolutionModelChanges {
  readonly metricMapping?: MetricMapping | null;
  readonly analysis?: NonNullable<CityModel["analysis"]> | null;
  readonly identity?: CityIdentity | null;
  readonly identityPanel?: CityIdentityPanel | null;
  readonly base?: CityBase | null;
  readonly bounds?: Vector3;
}

/**
 * Every entity collection is present, even when its three operation arrays
 * are empty. This keeps additions, removals, and full replacements explicit.
 */
export interface EvolutionChanges {
  readonly model: EvolutionModelChanges;
  readonly repositories: EvolutionEntityDelta<CityRepository>;
  readonly solutions: EvolutionEntityDelta<CitySolution>;
  readonly modules: EvolutionEntityDelta<CityModule>;
  readonly semanticGroups: EvolutionEntityDelta<SemanticGroup>;
  readonly districts: EvolutionEntityDelta<CityDistrict>;
  readonly buildings: EvolutionEntityDelta<CityBuilding>;
  readonly dependencies: EvolutionEntityDelta<CityDependency>;
}

export interface EvolutionBaseline {
  readonly commit: EvolutionCommitMetadata;
  /** Oldest selected frame, stored as a complete CityModel 1.0. */
  readonly model: CityModel;
}

export interface EvolutionDeltaFrame {
  readonly commit: EvolutionCommitMetadata;
  readonly changes: EvolutionChanges;
}

export interface EvolutionBundle {
  readonly schemaVersion: typeof EVOLUTION_BUNDLE_SCHEMA_VERSION;
  readonly generator: CityModel["generator"];
  /**
   * Versioned privacy policy: v1 intentionally persists no author names,
   * emails, IDs, or avatars.
   */
  readonly authorPolicy: typeof EVOLUTION_AUTHOR_POLICY;
  readonly selection: NormalizedEvolutionSelection;
  readonly provenance: EvolutionProvenance;
  readonly baseline: EvolutionBaseline;
  readonly deltas: readonly EvolutionDeltaFrame[];
}

export interface EvolutionReplayFrame {
  readonly commit: EvolutionCommitMetadata;
  readonly model: CityModel;
}

export const EVOLUTION_BUNDLE_LIMITS = Object.freeze({
  frames: 100,
  traversedCommits: 500,
  sampleEvery: 500,
  parentsPerCommit: 64,
  uniqueEntityLineages: 100_000,
  deltaOperations: 500_000,
  /**
   * Browser-facing artifacts are deliberately capped below the format's
   * theoretical capacity. Loading also needs the UTF-8 text, parsed graph,
   * validation indexes, and replay state, so a 64 MiB artifact is the largest
   * practical input within the documented 512 MiB transient-memory budget.
   */
  serializedBytes: 64 * 1024 * 1024,
  jsonStringBytes: 64 * 1024,
  jsonValues: 2_000_000,
  jsonDepth: 64,
  versionCharacters: 256,
  identifierCharacters: 256,
});
