export const CITY_MODEL_SCHEMA_VERSION = "1.0" as const;

export type SourceLanguage = "csharp" | "typescript" | "javascript";
export type RiskBand = "low" | "moderate" | "high" | "very-high";
export type MetricMethod =
  | "typescript-compiler-api-v1"
  | "csharp-lexical-v1"
  | "csharp-roslyn-v1";
export type ModuleKind =
  | "dotnet-project"
  | "angular-project"
  | "npm-package"
  | "unassigned";

export interface Vector3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface CityRepository {
  readonly id: string;
  readonly name: string;
}

export interface CitySolution {
  readonly id: string;
  readonly repositoryId: string;
  readonly name: string;
  readonly path: string;
  readonly moduleIds: readonly string[];
}

export interface CityModule {
  readonly id: string;
  readonly repositoryId: string;
  readonly parentModuleId?: string;
  readonly kind: ModuleKind;
  readonly name: string;
  readonly path: string;
  readonly solutionIds: readonly string[];
  readonly targetFrameworks?: readonly string[];
  readonly packageId?: string;
}

export interface SourceMetrics {
  readonly sloc: number;
  readonly decisionLoad: number;
  readonly maximumComplexity: number;
  readonly executableUnitCount: number;
}

/**
 * The original schema-1.0 mapping. Its exact shape and values remain part of
 * the public compatibility contract.
 */
export interface LegacyMetricMapping {
  readonly formulas: {
    readonly normalization: "log1p-cap-v1";
    readonly footprint: "sloc-footprint-side-v1";
    readonly height: "decision-load-height-v1";
    readonly risk: "maximum-complexity-bands-v1";
  };
  readonly normalizationCaps: {
    readonly sloc: 1_000;
    readonly decisionLoad: 100;
  };
}

export type MetricSourceKey = keyof SourceMetrics;
export type MetricValueFormula = "metric-value-v1";
export type MetricNormalizationFormula =
  | "linear-cap-v1"
  | "log1p-cap-v1";
export type MetricMissingBehavior = "zero" | "error";

export interface MetricChannelNormalizationV1 {
  readonly formula: MetricNormalizationFormula;
  readonly cap: number;
  readonly missing: MetricMissingBehavior;
}

export interface MetricChannelDefinitionV1 {
  readonly metric: MetricSourceKey;
  readonly formula: MetricValueFormula;
  readonly normalization: MetricChannelNormalizationV1;
}

export interface MetricColorPaletteEntryV1 {
  readonly id: string;
  readonly label: string;
  /** Stable #RRGGBB or #RRGGBBAA display color. */
  readonly color: string;
  /** Inclusive normalized upper bound. Entries must end at 1. */
  readonly maximum: number;
}

export interface MetricColorChannelDefinitionV1
  extends MetricChannelDefinitionV1 {
  readonly scale: "normalized-threshold-palette-v1";
  readonly palette: readonly MetricColorPaletteEntryV1[];
}

export interface MetricMappingDefinitionV1 {
  readonly definitionVersion: "1.0";
  readonly id: string;
  readonly name: string;
  readonly provenance: {
    readonly kind: "built-in" | "custom";
    readonly description: string;
  };
  readonly channels: {
    readonly footprint: MetricChannelDefinitionV1;
    readonly height: MetricChannelDefinitionV1;
    readonly color: MetricColorChannelDefinitionV1;
  };
  readonly geometry: {
    readonly footprint: {
      readonly formula: "normalized-side-range-v1";
      readonly minimumSide: number;
      readonly maximumSide: number;
      readonly exponent: number;
    };
    readonly height: {
      readonly formula: "normalized-height-range-v1";
      readonly minimumHeight: number;
      readonly maximumHeight: number;
      readonly exponent: number;
    };
  };
}

export type MetricMapping =
  | LegacyMetricMapping
  | MetricMappingDefinitionV1;

export type MetricNormalizationState =
  | "available"
  | "clamped"
  | "unavailable";

export type NormalizedMetric =
  | {
      readonly state: Exclude<MetricNormalizationState, "unavailable">;
      readonly normalizedValue: number;
    }
  | {
      readonly state: "unavailable";
      readonly normalizedValue?: never;
    };

export interface BuildingMetricNormalization {
  readonly sloc: NormalizedMetric;
  readonly decisionLoad: NormalizedMetric;
}

export interface ExecutableUnitMetric {
  readonly name: string;
  readonly line: number;
  /** Inclusive end line when the analyzer can determine it. */
  readonly endLine?: number;
  readonly complexity: number;
}

export interface SourceLocation {
  readonly startLine: number;
  readonly endLine: number;
}

/** An exact, one-based, inclusive source range for a declared code entity. */
export interface SourceRange extends SourceLocation {
  readonly startColumn: number;
  readonly endColumn: number;
}

export type SourceTypeKind = "class" | "interface" | "enum" | "type" | "struct" | "record" | "delegate";
export type SourceCallableKind = "function" | "method" | "constructor" | "accessor" | "lambda" | "local-function";

/**
 * Source-level facts are deliberately syntactic. A relation is emitted only
 * where the analyzer can identify both endpoints without guessing; everything
 * else is explained in `unavailable`.
 */
export interface SourceTypeFact {
  readonly id: string;
  readonly name: string;
  readonly kind: SourceTypeKind;
  readonly range: SourceRange;
  readonly parentTypeId?: string;
}

export interface SourceCallableFact {
  readonly id: string;
  readonly name: string;
  readonly kind: SourceCallableKind;
  readonly range: SourceRange;
  readonly enclosingTypeId?: string;
  readonly complexity?: number;
}

export interface SourceRelationFact {
  readonly id: string;
  readonly kind: "extends" | "implements" | "calls" | "type-reference";
  readonly sourceId: string;
  readonly targetId: string;
  readonly provenance: "syntax";
}

export interface SourceStructure {
  readonly version: "codecity.source-structure/1";
  readonly availability: "available" | "unavailable";
  readonly types: readonly SourceTypeFact[];
  readonly callables: readonly SourceCallableFact[];
  readonly relations: readonly SourceRelationFact[];
  /** Per-language, feature-specific facts intentionally not inferred. */
  readonly unavailable: readonly string[];
}

export type SourceRevision =
  | {
      readonly kind: "commit";
      readonly value: string;
    }
  | {
      readonly kind: "snapshot";
      readonly value: `sha256:${string}`;
    };

export type SourceRepositoryProvider =
  | "azure-devops"
  | "generic-git"
  | "github"
  | "uploaded-archive";

export interface SourceRepositoryProvenance {
  readonly repositoryId: string;
  readonly provider: SourceRepositoryProvider;
  readonly revision: SourceRevision;
  /** Canonical credential-free remote URL. Omitted for uploaded archives. */
  readonly repositoryUrl?: string;
}

export interface SourceNavigationProvenance {
  readonly version: "codecity.source-navigation/1";
  readonly repositories: readonly SourceRepositoryProvenance[];
}

export interface SemanticGroup {
  readonly id: string;
  readonly label: string;
  /** Stable #RRGGBB or #RRGGBBAA display color. */
  readonly color: string;
  readonly priority: number;
  readonly mergeInto?: string;
}

export type IdentityLogoFormat = "svg" | "png";

export interface IdentityLogoPrintRelief {
  readonly version: "codecity.logo-relief/1";
  readonly width: number;
  readonly height: number;
  /** Row-major 1bpp mask, most-significant bit first, as unpadded base64url. */
  readonly mask: string;
}

/**
 * A reference to a logo asset, never inline markup or an absolute filesystem
 * path. Consumers must resolve the normalized, repository-relative path from
 * their own trusted asset root.
 */
export interface IdentityLogo {
  readonly relativePath: string;
  readonly format: IdentityLogoFormat;
  readonly alt?: string;
  readonly printRelief?: IdentityLogoPrintRelief;
}

export interface RepositoryIdentity {
  readonly repositoryId: string;
  readonly title?: string;
  readonly version?: string;
  readonly logo?: IdentityLogo;
}

export interface CityIdentity {
  readonly title: string;
  readonly version?: string;
  readonly logo?: IdentityLogo;
  readonly repositories?: readonly RepositoryIdentity[];
}

/**
 * Reserved printable geometry at the city's front (-Z) edge. Positions use
 * center coordinates and Y is the vertical axis, like buildings.
 */
export interface CityIdentityPanel {
  readonly id: string;
  readonly edge: "front";
  readonly semanticGroupId: "identity";
  readonly position: Vector3;
  readonly size: Vector3;
  readonly relief: "embossed";
  readonly reliefDepth: number;
}

/**
 * One connected lower layer beneath the district parcels. Its exposed surface
 * in configured district and repository gaps forms the physical roads.
 */
export interface CityBase {
  readonly id: string;
  readonly semanticGroupId: "base";
  readonly position: Vector3;
  readonly size: Vector3;
}

export interface CityDistrict {
  readonly id: string;
  readonly repositoryId: string;
  readonly moduleId: string;
  readonly name: string;
  readonly path: string;
  readonly position: Vector3;
  readonly size: Vector3;
}

export interface CityBuilding {
  readonly id: string;
  readonly repositoryId: string;
  readonly moduleId: string;
  readonly districtId: string;
  readonly name: string;
  readonly path: string;
  readonly language: SourceLanguage;
  readonly metrics: SourceMetrics;
  /**
   * Present on analyzer-produced models. Optional for hand-authored and older
   * schema-1.0 fixtures, which keeps the extension backwards-compatible.
   */
  readonly metricMethod?: MetricMethod;
  /**
   * Persisted explanation inputs for schema-1.0 consumers. Older models may
   * omit them and derive the values from metrics plus the default mapping.
   */
  readonly metricNormalization?: BuildingMetricNormalization;
  readonly units?: readonly ExecutableUnitMetric[];
  readonly sourceLocation?: SourceLocation;
  /** Optional additive detail contract. Older schema-1.0 models remain valid. */
  readonly sourceStructure?: SourceStructure;
  readonly risk: RiskBand;
  readonly semanticGroupId: string;
  readonly position: Vector3;
  readonly size: Vector3;
}

export type DependencyKind =
  | "typescript-import"
  | "project-reference"
  | "package-reference";

export type DependencyResolution =
  | "internal"
  | "external"
  | "unresolved";

export interface CityDependency {
  readonly id: string;
  readonly repositoryId: string;
  readonly sourceId: string;
  readonly targetId?: string;
  readonly externalTarget?: string;
  /**
   * Optional for legacy schema-1.0 models. Consumers infer `internal` from
   * targetId and `external` from externalTarget when this field is absent.
   */
  readonly resolution?: DependencyResolution;
  readonly kind: DependencyKind;
  readonly version?: string;
  readonly weight: number;
}

export interface CityModel {
  readonly schemaVersion: typeof CITY_MODEL_SCHEMA_VERSION;
  readonly generator: {
    readonly name: "code-city";
    readonly version: string;
  };
  readonly repositories: readonly CityRepository[];
  readonly solutions: readonly CitySolution[];
  readonly modules: readonly CityModule[];
  readonly semanticGroups: readonly SemanticGroup[];
  /**
   * Formula provenance for analyzer-produced models. Older schema-1.0 models
   * use the documented default mapping when this extension is absent.
   */
  readonly metricMapping?: MetricMapping;
  /**
   * Analyzer diagnostics are persisted without leaking absolute local paths.
   */
  readonly analysis?: {
    readonly warnings: readonly string[];
  };
  /**
   * Immutable, credential-free provenance used by authorized source reads.
   * Source text is deliberately stored outside the city model.
   */
  readonly sourceProvenance?: SourceNavigationProvenance;
  readonly identity?: CityIdentity;
  readonly identityPanel?: CityIdentityPanel;
  /**
   * Optional for compatibility with schema-1.0 models created before the
   * shared-base extension.
   */
  readonly base?: CityBase;
  readonly districts: readonly CityDistrict[];
  readonly buildings: readonly CityBuilding[];
  readonly dependencies: readonly CityDependency[];
  readonly bounds: Vector3;
}
