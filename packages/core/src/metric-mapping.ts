import {
  layoutCity,
  type CityLayoutExecutionOptions,
  type UnpositionedBuilding,
} from "./layout.js";
import {
  metricColorPaletteEntry,
  metricMappingProvenanceDescription,
  metricNormalizationForMapping,
  normalizeMetricChannelValue,
  validateMetricMappingDefinition,
} from "./metrics.js";
import type {
  CityModel,
  MetricChannelDefinitionV1,
  MetricColorChannelDefinitionV1,
  MetricMappingDefinitionV1,
  SemanticGroup,
  Vector3,
} from "./model.js";
import { validateCityModel } from "./model-validation.js";

const GENERATED_METRIC_GROUP_PREFIX = "metric-color-";
export const LEGACY_BUILDING_METRIC_SEMANTIC_GROUP_IDS = Object.freeze([
    "risk-low",
    "risk-moderate",
    "risk-high",
    "risk-very-high",
  ] as const);
const LEGACY_BUILDING_METRIC_SEMANTIC_GROUP_ID_SET =
  new Set<string>(LEGACY_BUILDING_METRIC_SEMANTIC_GROUP_IDS);
const STRUCTURAL_SEMANTIC_GROUP_IDS = new Set([
  "base",
  "identity",
  "external",
  "routes",
]);

export interface ApplyMetricMappingExecutionOptions
  extends CityLayoutExecutionOptions {
  /**
   * The same bounded layout checkpoint used by layoutCity. Throwing cancels
   * projection before a partially rebuilt model can escape.
   */
  readonly checkpoint?: (operations: number) => void;
}

export interface MetricMappingLegend {
  readonly id: string;
  readonly name: string;
  readonly definitionVersion: "1.0";
  readonly provenance: string;
  readonly footprint: {
    readonly metric: string;
    readonly valueFormula: "metric-value-v1";
    readonly normalizationFormula: "linear-cap-v1" | "log1p-cap-v1";
    readonly cap: number;
    readonly missing: "zero" | "error";
    readonly geometryFormula: "normalized-side-range-v1";
    readonly minimumSide: number;
    readonly maximumSide: number;
    readonly exponent: number;
  };
  readonly height: {
    readonly metric: string;
    readonly valueFormula: "metric-value-v1";
    readonly normalizationFormula: "linear-cap-v1" | "log1p-cap-v1";
    readonly cap: number;
    readonly missing: "zero" | "error";
    readonly geometryFormula: "normalized-height-range-v1";
    readonly minimumHeight: number;
    readonly maximumHeight: number;
    readonly exponent: number;
  };
  readonly color: {
    readonly metric: string;
    readonly valueFormula: "metric-value-v1";
    readonly normalizationFormula: "linear-cap-v1" | "log1p-cap-v1";
    readonly cap: number;
    readonly missing: "zero" | "error";
    readonly scale: "normalized-threshold-palette-v1";
    readonly palette: readonly {
      readonly id: string;
      readonly label: string;
      readonly color: string;
      readonly maximum: number;
      readonly semanticGroupId: string;
    }[];
  };
}

export interface MetricMappingSummary {
  readonly mappingId: string;
  readonly buildingCount: number;
  readonly clamped: {
    readonly footprint: number;
    readonly height: number;
    readonly color: number;
  };
  readonly paletteCounts: Readonly<Record<string, number>>;
}

function generatedSemanticGroupId(
  definitionId: string,
  paletteEntryId: string,
): string {
  return `${GENERATED_METRIC_GROUP_PREFIX}${definitionId}-${paletteEntryId}`;
}

function channelLegend(channel: MetricChannelDefinitionV1) {
  return {
    metric: channel.metric,
    valueFormula: channel.formula,
    normalizationFormula: channel.normalization.formula,
    cap: channel.normalization.cap,
    missing: channel.normalization.missing,
  } as const;
}

export function createMetricMappingLegend(
  definition: MetricMappingDefinitionV1,
): MetricMappingLegend {
  const mapping = validateMetricMappingDefinition(definition);
  return Object.freeze({
    id: mapping.id,
    name: mapping.name,
    definitionVersion: mapping.definitionVersion,
    provenance: metricMappingProvenanceDescription(mapping),
    footprint: Object.freeze({
      ...channelLegend(mapping.channels.footprint),
      geometryFormula: mapping.geometry.footprint.formula,
      minimumSide: mapping.geometry.footprint.minimumSide,
      maximumSide: mapping.geometry.footprint.maximumSide,
      exponent: mapping.geometry.footprint.exponent,
    }),
    height: Object.freeze({
      ...channelLegend(mapping.channels.height),
      geometryFormula: mapping.geometry.height.formula,
      minimumHeight: mapping.geometry.height.minimumHeight,
      maximumHeight: mapping.geometry.height.maximumHeight,
      exponent: mapping.geometry.height.exponent,
    }),
    color: Object.freeze({
      ...channelLegend(mapping.channels.color),
      scale: mapping.channels.color.scale,
      palette: Object.freeze(
        mapping.channels.color.palette.map((entry) =>
          Object.freeze({
            ...entry,
            semanticGroupId: generatedSemanticGroupId(
              mapping.id,
              entry.id,
            ),
          }),
        ),
      ),
    }),
  });
}

export const metricMappingLegend = createMetricMappingLegend;

function projectedSize(
  metrics: UnpositionedBuilding["metrics"],
  definition: MetricMappingDefinitionV1,
  path: string,
): Vector3 {
  const footprint = normalizeMetricChannelValue(
    metrics,
    definition.channels.footprint,
    `${path}.channels.footprint`,
  ).value;
  const height = normalizeMetricChannelValue(
    metrics,
    definition.channels.height,
    `${path}.channels.height`,
  ).value;
  const footprintGeometry = definition.geometry.footprint;
  const heightGeometry = definition.geometry.height;
  const side =
    footprintGeometry.minimumSide +
    (footprintGeometry.maximumSide - footprintGeometry.minimumSide) *
      footprint ** footprintGeometry.exponent;
  return Object.freeze({
    x: side,
    y:
      heightGeometry.minimumHeight +
      (heightGeometry.maximumHeight - heightGeometry.minimumHeight) *
        height ** heightGeometry.exponent,
    z: side,
  });
}

function projectedColorGroup(
  metrics: UnpositionedBuilding["metrics"],
  definition: MetricMappingDefinitionV1,
  path: string,
): string {
  const normalized = normalizeMetricChannelValue(
    metrics,
    definition.channels.color,
    `${path}.channels.color`,
  ).value;
  const entry = metricColorPaletteEntry(
    normalized,
    definition.channels.color.palette,
  );
  return generatedSemanticGroupId(definition.id, entry.id);
}

export function projectBuildingMetricMapping(
  metrics: UnpositionedBuilding["metrics"],
  definition: MetricMappingDefinitionV1,
  path = "building",
): {
  readonly size: Vector3;
  readonly semanticGroupId: string;
} {
  return Object.freeze({
    size: projectedSize(metrics, definition, path),
    semanticGroupId: projectedColorGroup(metrics, definition, path),
  });
}

export function semanticGroupsForMetricMapping(
  definition: MetricMappingDefinitionV1,
  mergeInto?: string,
): readonly SemanticGroup[] {
  const mapping = validateMetricMappingDefinition(definition);
  return Object.freeze(
    mapping.channels.color.palette.map((entry, index, palette) => {
      const next = palette[index + 1];
      return Object.freeze({
        id: generatedSemanticGroupId(mapping.id, entry.id),
        label: entry.label,
        color: entry.color,
        // Higher normalized bands win scarce print channels. The complete
        // bounded palette remains below structural identity/base priorities.
        priority: 94 - (palette.length - 1 - index),
        ...(next !== undefined
          ? {
              mergeInto: generatedSemanticGroupId(
                mapping.id,
                next.id,
              ),
            }
          : mergeInto === undefined
            ? {}
            : { mergeInto }),
      });
    }),
  );
}

function retainedSemanticGroups(
  model: CityModel,
  generated: readonly SemanticGroup[],
): readonly SemanticGroup[] {
  const generatedIds = new Set(generated.map(({ id }) => id));
  const previousBuildingGroupIds = new Set(
    model.buildings.map(({ semanticGroupId }) => semanticGroupId),
  );
  const removable = new Set(
    model.semanticGroups
      .filter(
        ({ id }) =>
          id.startsWith(GENERATED_METRIC_GROUP_PREFIX) ||
          LEGACY_BUILDING_METRIC_SEMANTIC_GROUP_ID_SET.has(id) ||
          (previousBuildingGroupIds.has(id) &&
            !STRUCTURAL_SEMANTIC_GROUP_IDS.has(id)),
      )
      .map(({ id }) => id),
  );

  // A caller-owned group may deliberately target a previous metric group.
  // Preserve that target and its merge chain instead of creating a dangling
  // reference while removing stale, building-only generated groups.
  const protectedIds = new Set<string>();
  for (const group of model.semanticGroups) {
    if (
      !removable.has(group.id) &&
      group.mergeInto !== undefined &&
      removable.has(group.mergeInto) &&
      !generatedIds.has(group.mergeInto)
    ) {
      protectedIds.add(group.mergeInto);
    }
  }
  for (const id of [
    model.base?.semanticGroupId,
    model.identityPanel?.semanticGroupId,
  ]) {
    if (id !== undefined && removable.has(id)) protectedIds.add(id);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const group of model.semanticGroups) {
      if (
        protectedIds.has(group.id) &&
        group.mergeInto !== undefined &&
        removable.has(group.mergeInto) &&
        !generatedIds.has(group.mergeInto) &&
        !protectedIds.has(group.mergeInto)
      ) {
        protectedIds.add(group.mergeInto);
        changed = true;
      }
    }
  }

  const retained = model.semanticGroups
    .filter(({ id }) => !removable.has(id) || protectedIds.has(id))
    .map((group) => {
      const minimumPriority =
        group.id === "base" ? 100 : group.id === "identity" ? 95 : undefined;
      return minimumPriority !== undefined &&
        group.priority < minimumPriority
        ? Object.freeze({ ...group, priority: minimumPriority })
        : group;
    });
  for (const group of retained) {
    if (generatedIds.has(group.id)) {
      throw new TypeError(
        `metricMapping generated semantic group '${group.id}' conflicts with a retained model group.`,
      );
    }
  }
  return Object.freeze([...retained, ...generated]);
}

function mergeStableRelayoutEntities<
  T extends { readonly id: string },
>(
  originals: readonly T[],
  relaid: readonly T[],
): readonly T[] {
  const originalsById = new Map(
    originals.map((entity) => [entity.id, entity] as const),
  );
  return relaid.map((entity) => {
    const original = originalsById.get(entity.id);
    return original === undefined
      ? entity
      : ({ ...original, ...entity } as T);
  });
}

function mergeStableRelayoutEntity<
  T extends { readonly id: string },
>(
  original: T | undefined,
  relaid: T | undefined,
): T | undefined {
  if (relaid === undefined) return undefined;
  return original?.id === relaid.id
    ? ({ ...original, ...relaid } as T)
    : relaid;
}

function mergeRelayoutBuildings(
  originals: CityModel["buildings"],
  relaid: CityModel["buildings"],
): CityModel["buildings"] {
  const originalsById = new Map(
    originals.map((building) => [building.id, building] as const),
  );
  return relaid.map((building) => {
    const original = originalsById.get(building.id);
    if (original === undefined) return building;
    const merged = {
      ...original,
      ...building,
    } as Record<string, unknown>;
    // A different footprint/height definition invalidates the legacy
    // explanation extension. Do not let an absent freshly computed value be
    // filled back in by the additive-field merge.
    if (building.metricNormalization === undefined) {
      delete merged["metricNormalization"];
    }
    return merged as unknown as CityModel["buildings"][number];
  });
}

/**
 * Deterministically rebuilds all layout-affecting geometry and color groups.
 * The source model is validated and never mutated; throwing from checkpoint
 * cancels without returning a partially projected model.
 */
export function applyMetricMapping(
  source: CityModel,
  definition: MetricMappingDefinitionV1,
  execution: ApplyMetricMappingExecutionOptions = {},
): CityModel {
  const mapping = validateMetricMappingDefinition(definition);
  execution.checkpoint?.(0);
  const model = validateCityModel(
    source,
    execution.checkpoint === undefined
      ? {}
      : { checkpoint: () => execution.checkpoint!(0) },
  );
  const generated = semanticGroupsForMetricMapping(mapping, "base");
  const retainedGroups = retainedSemanticGroups(model, generated);
  const semanticGroups: readonly SemanticGroup[] = Object.freeze([
    ...retainedGroups,
    ...(!retainedGroups.some(({ id }) => id === "base")
      ? [
          Object.freeze({
            id: "base",
            label: "Base",
            color: "#6B7280",
            priority: 100,
          }),
        ]
      : []),
    ...(!retainedGroups.some(({ id }) => id === "identity") &&
    model.identity !== undefined
      ? [
          Object.freeze({
            id: "identity",
            label: "Identity",
            color: "#F8FAFC",
            priority: 95,
            mergeInto: "base",
          }),
        ]
      : []),
  ]);
  const buildings = model.buildings.map((building, index) => {
    execution.checkpoint?.(1);
    const path = `buildings[${index}]`;
    const projection = projectBuildingMetricMapping(
      building.metrics,
      mapping,
      path,
    );
    const metricNormalization = metricNormalizationForMapping(
      building.metrics,
      mapping,
    );
    return {
      id: building.id,
      repositoryId: building.repositoryId,
      moduleId: building.moduleId,
      name: building.name,
      path: building.path,
      language: building.language,
      metrics: building.metrics,
      ...(building.metricMethod === undefined
        ? {}
        : { metricMethod: building.metricMethod }),
      ...(building.units === undefined ? {} : { units: building.units }),
      ...(building.sourceLocation === undefined
        ? {}
        : { sourceLocation: building.sourceLocation }),
      ...(building.sourceStructure === undefined
        ? {}
        : { sourceStructure: building.sourceStructure }),
      semanticGroupId: projection.semanticGroupId,
      ...(metricNormalization === undefined
        ? {}
        : { metricNormalization }),
      size: projection.size,
    } satisfies UnpositionedBuilding;
  });
  execution.checkpoint?.(0);
  const layout = layoutCity(
    {
      repositories: model.repositories,
      modules: model.modules,
      buildings,
      ...(model.identity === undefined ? {} : { identity: model.identity }),
    },
    {},
    execution,
  );
  execution.checkpoint?.(0);
  const candidate: Record<string, unknown> = {
    ...model,
    semanticGroups,
    metricMapping: mapping,
    districts: mergeStableRelayoutEntities(
      model.districts,
      layout.districts,
    ),
    buildings: mergeRelayoutBuildings(
      model.buildings,
      layout.buildings,
    ),
    bounds: layout.bounds,
  };
  if (layout.identity === undefined) {
    delete candidate["identity"];
  } else {
    candidate["identity"] = {
      ...model.identity,
      ...layout.identity,
    };
  }
  const identityPanel = mergeStableRelayoutEntity(
    model.identityPanel,
    layout.identityPanel,
  );
  if (identityPanel === undefined) delete candidate["identityPanel"];
  else candidate["identityPanel"] = identityPanel;
  const base = mergeStableRelayoutEntity(model.base, layout.base);
  if (base === undefined) delete candidate["base"];
  else candidate["base"] = base;

  return validateCityModel(
    candidate,
    execution.checkpoint === undefined
      ? {}
      : { checkpoint: () => execution.checkpoint!(0) },
  );
}

export function summarizeMetricMapping(
  model: CityModel,
  definition: MetricMappingDefinitionV1,
): MetricMappingSummary {
  const mapping = validateMetricMappingDefinition(definition);
  const paletteCounts: Record<string, number> = Object.fromEntries(
    mapping.channels.color.palette.map(({ id }) => [id, 0]),
  );
  let footprintClamped = 0;
  let heightClamped = 0;
  let colorClamped = 0;
  model.buildings.forEach((building, index) => {
    const path = `buildings[${index}]`;
    if (
      normalizeMetricChannelValue(
        building.metrics,
        mapping.channels.footprint,
        `${path}.channels.footprint`,
      ).clamped
    ) {
      footprintClamped += 1;
    }
    if (
      normalizeMetricChannelValue(
        building.metrics,
        mapping.channels.height,
        `${path}.channels.height`,
      ).clamped
    ) {
      heightClamped += 1;
    }
    const color = normalizeMetricChannelValue(
      building.metrics,
      mapping.channels.color,
      `${path}.channels.color`,
    );
    if (color.clamped) colorClamped += 1;
    const entry = metricColorPaletteEntry(
      color.value,
      mapping.channels.color.palette,
    );
    paletteCounts[entry.id] = (paletteCounts[entry.id] ?? 0) + 1;
  });
  return Object.freeze({
    mappingId: mapping.id,
    buildingCount: model.buildings.length,
    clamped: Object.freeze({
      footprint: footprintClamped,
      height: heightClamped,
      color: colorClamped,
    }),
    paletteCounts: Object.freeze(paletteCounts),
  });
}

export function inspectMetricMapping(
  model: CityModel,
  definition: MetricMappingDefinitionV1,
): {
  readonly legend: MetricMappingLegend;
  readonly summary: MetricMappingSummary;
} {
  return Object.freeze({
    legend: createMetricMappingLegend(definition),
    summary: summarizeMetricMapping(model, definition),
  });
}
