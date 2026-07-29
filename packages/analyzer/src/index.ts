import {
  CITY_MODEL_SCHEMA_VERSION,
  DEFAULT_METRIC_MAPPING,
  DEFAULT_SEMANTIC_GROUPS,
  layoutCity,
  validateCityModel,
} from "../../core/src/index.js";
import type { CityModel } from "../../core/src/index.js";

import {
  analyzeLocalFacts,
  analyzeRepositorySnapshotFacts,
} from "./discovery.js";
import type { RepositorySnapshot } from "./snapshot.js";
import type {
  LocalAnalysisFacts,
  LocalAnalysisOptions,
} from "./types.js";

export * from "./csharp-lexical.js";
export * from "./discovery.js";
export * from "./filesystem.js";
export * from "./local-snapshot.js";
export * from "./snapshot.js";
export * from "./typescript-metrics.js";
export * from "./types.js";

function cityModelFromFacts(facts: LocalAnalysisFacts): CityModel {
  const layout = layoutCity({
    repositories: facts.repositories,
    modules: facts.modules,
    buildings: facts.sources.map((source) => ({
      repositoryId: source.repositoryId,
      moduleId: source.moduleId,
      name: source.name,
      path: source.path,
      language: source.language,
      metrics: source.metrics,
      metricMethod: source.metricMethod,
      units: source.units,
      semanticGroupId: source.semanticGroupId,
    })),
    ...(facts.identity === undefined ? {} : { identity: facts.identity }),
  });

  return validateCityModel({
    schemaVersion: CITY_MODEL_SCHEMA_VERSION,
    generator: {
      name: "code-city",
      version: "0.1.0",
    },
    repositories: facts.repositories,
    solutions: facts.solutions,
    modules: facts.modules,
    semanticGroups: DEFAULT_SEMANTIC_GROUPS,
    metricMapping: DEFAULT_METRIC_MAPPING,
    analysis: { warnings: facts.warnings },
    ...(layout.identity === undefined ? {} : { identity: layout.identity }),
    ...(layout.identityPanel === undefined
      ? {}
      : { identityPanel: layout.identityPanel }),
    ...(layout.base === undefined ? {} : { base: layout.base }),
    districts: layout.districts,
    buildings: layout.buildings,
    dependencies: facts.dependencies,
    bounds: layout.bounds,
  });
}

export async function analyzeRepositorySnapshots(
  snapshots: readonly RepositorySnapshot[],
  options: LocalAnalysisOptions = {},
): Promise<CityModel> {
  return cityModelFromFacts(
    await analyzeRepositorySnapshotFacts(snapshots, options),
  );
}

export async function analyzeLocalRepositories(
  roots: readonly string[],
  options: LocalAnalysisOptions = {},
): Promise<CityModel> {
  return cityModelFromFacts(await analyzeLocalFacts(roots, options));
}
