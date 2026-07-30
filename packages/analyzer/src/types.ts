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
import type { SnapshotOptions } from "./snapshot.js";

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

export interface LocalAnalysisOptions extends SnapshotOptions {
  readonly title?: string;
  readonly version?: string;
  /**
   * A repository-relative SVG or PNG. Local analysis may read exactly one
   * matching regular non-symlink file beneath the explicitly supplied roots
   * to derive a bounded printable mask; original image bytes are never
   * embedded.
   */
  readonly logo?: string;
}
