export const CITY_MODEL_SCHEMA_VERSION = "1.0" as const;

export type SourceLanguage = "csharp" | "typescript" | "javascript";
export type RiskBand = "low" | "moderate" | "high" | "very-high";
export type MetricMethod =
  | "typescript-compiler-api-v1"
  | "csharp-lexical-v1";
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

export interface ExecutableUnitMetric {
  readonly name: string;
  readonly line: number;
  readonly complexity: number;
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

/**
 * A reference to a logo asset, never inline markup or an absolute filesystem
 * path. Consumers must resolve the normalized, repository-relative path from
 * their own trusted asset root.
 */
export interface IdentityLogo {
  readonly relativePath: string;
  readonly format: IdentityLogoFormat;
  readonly alt?: string;
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
  readonly units?: readonly ExecutableUnitMetric[];
  readonly risk: RiskBand;
  readonly semanticGroupId: string;
  readonly position: Vector3;
  readonly size: Vector3;
}

export type DependencyKind =
  | "typescript-import"
  | "project-reference"
  | "package-reference";

export interface CityDependency {
  readonly id: string;
  readonly repositoryId: string;
  readonly sourceId: string;
  readonly targetId?: string;
  readonly externalTarget?: string;
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
   * Analyzer diagnostics are persisted without leaking absolute local paths.
   */
  readonly analysis?: {
    readonly warnings: readonly string[];
  };
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
