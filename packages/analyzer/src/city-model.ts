import {
  CITY_MODEL_SCHEMA_VERSION,
  DEFAULT_METRIC_MAPPING,
  DEFAULT_SEMANTIC_GROUPS,
  layoutCity,
  validateCityModel,
  type CityModel,
  type RectanglePackingSearchMode,
} from "../../core/src/index.js";

import type { LocalAnalysisFacts } from "./types.js";

export interface CityModelFromFactsExecutionOptions {
  readonly layoutCheckpoint?: (operations: number) => void;
  readonly layoutPackingSearchMode?: RectanglePackingSearchMode;
  readonly validationCheckpoint?: () => void;
}

export function cityModelFromFacts(
  facts: LocalAnalysisFacts,
  execution: CityModelFromFactsExecutionOptions = {},
): CityModel {
  const layout = layoutCity(
    {
      repositories: facts.repositories,
      modules: facts.modules,
      buildings: facts.sources.map((source) => ({
        id: source.id,
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
    },
    {},
    {
      ...(execution.layoutCheckpoint === undefined
        ? {}
        : { checkpoint: execution.layoutCheckpoint }),
      ...(execution.layoutPackingSearchMode === undefined
        ? {}
        : {
            packingSearchMode: execution.layoutPackingSearchMode,
          }),
    },
  );

  return validateCityModel(
    {
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
    },
    execution.validationCheckpoint === undefined
      ? {}
      : { checkpoint: execution.validationCheckpoint },
  );
}
