import {
  CITY_MODEL_SCHEMA_VERSION,
  DEFAULT_VERSIONED_METRIC_MAPPING,
  DEFAULT_SEMANTIC_GROUPS,
  LEGACY_BUILDING_METRIC_SEMANTIC_GROUP_IDS,
  layoutCity,
  metricNormalizationForMapping,
  projectBuildingMetricMapping,
  semanticGroupsForMetricMapping,
  validateMetricMapping,
  validateCityModel,
  type CityModel,
  type MetricMapping,
  type RectanglePackingSearchMode,
} from "../../core/src/index.js";

import type { LocalAnalysisFacts } from "./types.js";

export interface CityModelFromFactsExecutionOptions {
  readonly layoutCheckpoint?: (operations: number) => void;
  readonly layoutPackingSearchMode?: RectanglePackingSearchMode;
  readonly validationCheckpoint?: () => void;
  /**
   * Defaults to the versioned Complexity definition. Supplying the exact
   * legacy mapping preserves the original fixed schema-1.0 projection.
   */
  readonly metricMapping?: MetricMapping;
}

export function cityModelFromFacts(
  facts: LocalAnalysisFacts,
  execution: CityModelFromFactsExecutionOptions = {},
): CityModel {
  const metricMapping =
    execution.metricMapping === undefined
      ? DEFAULT_VERSIONED_METRIC_MAPPING
      : validateMetricMapping(
          execution.metricMapping,
          "metricMapping",
        );
  const versionedMapping =
    "definitionVersion" in metricMapping
      ? metricMapping
      : undefined;
  const layout = layoutCity(
    {
      repositories: facts.repositories,
      modules: facts.modules,
      buildings: facts.sources.map((source, index) => {
        const projection =
          versionedMapping === undefined
            ? undefined
            : projectBuildingMetricMapping(
                source.metrics,
                versionedMapping,
                `sources[${index}]`,
              );
        const metricNormalization =
          versionedMapping === undefined
            ? undefined
            : metricNormalizationForMapping(
                source.metrics,
                versionedMapping,
              );
        return {
          id: source.id,
          repositoryId: source.repositoryId,
          moduleId: source.moduleId,
          name: source.name,
          path: source.path,
          language: source.language,
          metrics: source.metrics,
          metricMethod: source.metricMethod,
          units: source.units,
          ...(source.sourceStructure === undefined
            ? {}
            : { sourceStructure: source.sourceStructure }),
          ...(source.sourceLocation === undefined
            ? {}
            : { sourceLocation: source.sourceLocation }),
          semanticGroupId:
            projection?.semanticGroupId ?? source.semanticGroupId,
          ...(metricNormalization === undefined
            ? {}
            : { metricNormalization }),
          ...(projection === undefined ? {} : { size: projection.size }),
        };
      }),
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
      semanticGroups:
        versionedMapping === undefined
          ? DEFAULT_SEMANTIC_GROUPS
          : Object.freeze([
              ...DEFAULT_SEMANTIC_GROUPS.filter(
                ({ id }) =>
                  !LEGACY_BUILDING_METRIC_SEMANTIC_GROUP_IDS.some(
                    (legacyId) => legacyId === id,
                  ),
              ),
              ...semanticGroupsForMetricMapping(
                versionedMapping,
                "base",
              ),
            ]),
      metricMapping,
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
