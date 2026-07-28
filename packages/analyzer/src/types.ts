import type {
  CityDependency,
  CityIdentity,
  CityModule,
  CityRepository,
  CitySolution,
  ExecutableUnitMetric,
  MetricMethod,
  RiskBand,
  SourceLanguage,
  SourceMetrics,
} from "../../core/src/model.js";

export type {
  ExecutableUnitMetric,
  MetricMethod,
} from "../../core/src/model.js";

export interface StaticImportFact {
  readonly specifier: string;
  readonly count: number;
}

export interface SourceFileFact {
  readonly id: string;
  readonly repositoryId: string;
  readonly moduleId: string;
  readonly districtId: string;
  readonly districtName: string;
  readonly districtPath: string;
  readonly name: string;
  readonly path: string;
  readonly language: SourceLanguage;
  readonly metrics: SourceMetrics;
  readonly metricMethod: MetricMethod;
  readonly units: readonly ExecutableUnitMetric[];
  readonly risk: RiskBand;
  readonly semanticGroupId: string;
  readonly imports: readonly StaticImportFact[];
}

export interface LocalAnalysisFacts {
  readonly identity?: CityIdentity;
  readonly repositories: readonly CityRepository[];
  readonly solutions: readonly CitySolution[];
  readonly modules: readonly CityModule[];
  readonly sources: readonly SourceFileFact[];
  readonly dependencies: readonly CityDependency[];
  readonly warnings: readonly string[];
}

export interface LocalAnalysisOptions {
  readonly title?: string;
  readonly version?: string;
  /**
   * A repository-relative path or portable reference. Absolute paths are rejected.
   * The analyzer never reads or embeds the referenced image.
   */
  readonly logo?: string;
}
