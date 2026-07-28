import {
  CITY_MODEL_SCHEMA_VERSION,
  DEFAULT_SEMANTIC_GROUPS,
  layoutCity,
} from "../../core/src/index.js";
import type { CityModel } from "../../core/src/index.js";

import { analyzeLocalFacts } from "./discovery.js";
import type { LocalAnalysisOptions } from "./types.js";

export * from "./csharp-lexical.js";
export * from "./discovery.js";
export * from "./filesystem.js";
export * from "./typescript-metrics.js";
export * from "./types.js";

export async function analyzeLocalRepositories(
  roots: readonly string[],
  options: LocalAnalysisOptions = {},
): Promise<CityModel> {
  const facts = await analyzeLocalFacts(roots, options);
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

  return {
    schemaVersion: CITY_MODEL_SCHEMA_VERSION,
    generator: {
      name: "code-city",
      version: "0.1.0",
    },
    repositories: facts.repositories,
    solutions: facts.solutions,
    modules: facts.modules,
    semanticGroups: DEFAULT_SEMANTIC_GROUPS,
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
  };
}
