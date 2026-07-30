import type {
  BuildingMetricNormalization,
  MetricChannelDefinitionV1,
  MetricColorChannelDefinitionV1,
  MetricColorPaletteEntryV1,
  MetricMapping,
  MetricMappingDefinitionV1,
  MetricSourceKey,
  RiskBand,
  SourceMetrics,
  Vector3,
} from "./model.js";
import { isDisplayColor } from "./color.js";

export const METRIC_NORMALIZATION_CAPS = Object.freeze({
  sloc: 1_000,
  decisionLoad: 100,
} as const);

export const DEFAULT_METRIC_MAPPING = Object.freeze({
  formulas: Object.freeze({
    normalization: "log1p-cap-v1",
    footprint: "sloc-footprint-side-v1",
    height: "decision-load-height-v1",
    risk: "maximum-complexity-bands-v1",
  }),
  normalizationCaps: METRIC_NORMALIZATION_CAPS,
}) satisfies MetricMapping;

export const METRIC_MAPPING_DEFINITION_LIMITS = Object.freeze({
  idCharacters: 64,
  paletteIdCharacters: 48,
  nameCharacters: 160,
  provenanceCharacters: 512,
  paletteEntries: 12,
  cap: 1_000_000_000,
  dimension: 10_000,
  exponent: 4,
} as const);

const COMPLEXITY_METRIC_MAPPING = Object.freeze({
  definitionVersion: "1.0",
  id: "complexity",
  name: "Complexity",
  provenance: Object.freeze({
    kind: "built-in",
    description:
      "Code City built-in complexity preset using source size, decision load, and maximum executable-unit complexity.",
  }),
  channels: Object.freeze({
    footprint: Object.freeze({
      metric: "sloc",
      formula: "metric-value-v1",
      normalization: Object.freeze({
        formula: "log1p-cap-v1",
        cap: 1_000,
        missing: "error",
      }),
    }),
    height: Object.freeze({
      metric: "decisionLoad",
      formula: "metric-value-v1",
      normalization: Object.freeze({
        formula: "log1p-cap-v1",
        cap: 100,
        missing: "error",
      }),
    }),
    color: Object.freeze({
      metric: "maximumComplexity",
      formula: "metric-value-v1",
      scale: "normalized-threshold-palette-v1",
      normalization: Object.freeze({
        formula: "linear-cap-v1",
        cap: 25,
        missing: "error",
      }),
      palette: Object.freeze([
        Object.freeze({
          id: "low",
          label: "Low complexity",
          color: "#22C55E",
          maximum: 0.2,
        }),
        Object.freeze({
          id: "moderate",
          label: "Moderate complexity",
          color: "#EAB308",
          maximum: 0.4,
        }),
        Object.freeze({
          id: "high",
          label: "High complexity",
          color: "#F97316",
          maximum: 0.8,
        }),
        Object.freeze({
          id: "very-high",
          label: "Very high complexity",
          color: "#DC2626",
          maximum: 1,
        }),
      ]),
    }),
  }),
  geometry: Object.freeze({
    footprint: Object.freeze({
      formula: "normalized-side-range-v1",
      minimumSide: 3,
      maximumSide: 18,
      exponent: 1.5,
    }),
    height: Object.freeze({
      formula: "normalized-height-range-v1",
      minimumHeight: 4,
      maximumHeight: 40,
      exponent: 1,
    }),
  }),
} as const satisfies MetricMappingDefinitionV1);

const MAINTENANCE_METRIC_MAPPING = Object.freeze({
  definitionVersion: "1.0",
  id: "maintenance",
  name: "Maintenance",
  provenance: Object.freeze({
    kind: "built-in",
    description:
      "Code City built-in maintenance preset emphasizing executable-unit count, peak complexity, and aggregate decision load.",
  }),
  channels: Object.freeze({
    footprint: Object.freeze({
      metric: "executableUnitCount",
      formula: "metric-value-v1",
      normalization: Object.freeze({
        formula: "log1p-cap-v1",
        cap: 100,
        missing: "error",
      }),
    }),
    height: Object.freeze({
      metric: "maximumComplexity",
      formula: "metric-value-v1",
      normalization: Object.freeze({
        formula: "log1p-cap-v1",
        cap: 25,
        missing: "error",
      }),
    }),
    color: Object.freeze({
      metric: "decisionLoad",
      formula: "metric-value-v1",
      scale: "normalized-threshold-palette-v1",
      normalization: Object.freeze({
        formula: "log1p-cap-v1",
        cap: 100,
        missing: "error",
      }),
      palette: Object.freeze([
        Object.freeze({
          id: "low",
          label: "Low maintenance load",
          color: "#0EA5E9",
          maximum: 0.25,
        }),
        Object.freeze({
          id: "moderate",
          label: "Moderate maintenance load",
          color: "#6366F1",
          maximum: 0.5,
        }),
        Object.freeze({
          id: "high",
          label: "High maintenance load",
          color: "#A855F7",
          maximum: 0.75,
        }),
        Object.freeze({
          id: "very-high",
          label: "Very high maintenance load",
          color: "#DB2777",
          maximum: 1,
        }),
      ]),
    }),
  }),
  geometry: Object.freeze({
    footprint: Object.freeze({
      formula: "normalized-side-range-v1",
      minimumSide: 3,
      maximumSide: 18,
      exponent: 1.25,
    }),
    height: Object.freeze({
      formula: "normalized-height-range-v1",
      minimumHeight: 4,
      maximumHeight: 40,
      exponent: 1.1,
    }),
  }),
} as const satisfies MetricMappingDefinitionV1);

const PRINT_METRIC_MAPPING = Object.freeze({
  definitionVersion: "1.0",
  id: "print",
  name: "Print",
  provenance: Object.freeze({
    kind: "built-in",
    description:
      "Code City built-in print preset with stronger minimum features, a restrained height range, and a four-color discrete palette.",
  }),
  channels: Object.freeze({
    footprint: Object.freeze({
      metric: "sloc",
      formula: "metric-value-v1",
      normalization: Object.freeze({
        formula: "log1p-cap-v1",
        cap: 1_000,
        missing: "error",
      }),
    }),
    height: Object.freeze({
      metric: "decisionLoad",
      formula: "metric-value-v1",
      normalization: Object.freeze({
        formula: "log1p-cap-v1",
        cap: 100,
        missing: "error",
      }),
    }),
    color: Object.freeze({
      metric: "maximumComplexity",
      formula: "metric-value-v1",
      scale: "normalized-threshold-palette-v1",
      normalization: Object.freeze({
        formula: "linear-cap-v1",
        cap: 25,
        missing: "error",
      }),
      palette: Object.freeze([
        Object.freeze({
          id: "low",
          label: "Low complexity",
          color: "#16A34A",
          maximum: 0.2,
        }),
        Object.freeze({
          id: "moderate",
          label: "Moderate complexity",
          color: "#EAB308",
          maximum: 0.4,
        }),
        Object.freeze({
          id: "high",
          label: "High complexity",
          color: "#EA580C",
          maximum: 0.8,
        }),
        Object.freeze({
          id: "very-high",
          label: "Very high complexity",
          color: "#B91C1C",
          maximum: 1,
        }),
      ]),
    }),
  }),
  geometry: Object.freeze({
    footprint: Object.freeze({
      formula: "normalized-side-range-v1",
      minimumSide: 4,
      maximumSide: 18,
      exponent: 1.35,
    }),
    height: Object.freeze({
      formula: "normalized-height-range-v1",
      minimumHeight: 4,
      maximumHeight: 30,
      exponent: 1,
    }),
  }),
} as const satisfies MetricMappingDefinitionV1);

export const DEFAULT_VERSIONED_METRIC_MAPPING =
  COMPLEXITY_METRIC_MAPPING;

export type MetricMappingPreset =
  | {
      readonly id: string;
      readonly name: string;
      readonly availability: "available";
      readonly definition: MetricMappingDefinitionV1;
    }
  | {
      readonly id: string;
      readonly name: string;
      readonly availability: "unavailable";
      readonly reason: string;
    };

export const METRIC_MAPPING_PRESET_CATALOG = Object.freeze([
  Object.freeze({
    id: "complexity",
    name: "Complexity",
    availability: "available",
    definition: COMPLEXITY_METRIC_MAPPING,
  }),
  Object.freeze({
    id: "maintenance",
    name: "Maintenance",
    availability: "available",
    definition: MAINTENANCE_METRIC_MAPPING,
  }),
  Object.freeze({
    id: "print",
    name: "Print",
    availability: "available",
    definition: PRINT_METRIC_MAPPING,
  }),
  Object.freeze({
    id: "dependencies",
    name: "Dependencies",
    availability: "unavailable",
    reason:
      "Dependency metrics are not yet present on every building in CityModel 1.0.",
  }),
  Object.freeze({
    id: "ownership",
    name: "Ownership",
    availability: "unavailable",
    reason:
      "Ownership and contributor metrics are not yet available in CityModel 1.0.",
  }),
  Object.freeze({
    id: "evolution",
    name: "Evolution",
    availability: "unavailable",
    reason:
      "Evolution metrics require derived per-frame churn data that is not yet stored on buildings.",
  }),
] as const satisfies readonly MetricMappingPreset[]);

export const METRIC_MAPPING_PRESETS = METRIC_MAPPING_PRESET_CATALOG;

export function resolveMetricMappingPreset(
  id: string,
): MetricMappingDefinitionV1 {
  const preset = METRIC_MAPPING_PRESET_CATALOG.find(
    (candidate) => candidate.id === id,
  );
  if (preset === undefined) {
    throw new TypeError(
      `metricMappingPreset '${id}' is not recognized.`,
    );
  }
  if (preset.availability === "unavailable") {
    throw new TypeError(
      `metricMappingPreset '${id}' is unavailable: ${preset.reason}`,
    );
  }
  return preset.definition;
}

export const MAPPABLE_BUILDING_METRICS = Object.freeze([
  "sloc",
  "decisionLoad",
  "maximumComplexity",
  "executableUnitCount",
] as const satisfies readonly MetricSourceKey[]);
const METRIC_SOURCE_KEYS = new Set<MetricSourceKey>(
  MAPPABLE_BUILDING_METRICS,
);
const METRIC_ID = /^[a-z][a-z0-9-]*$/u;
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Cs}]/u;

type JsonObject = Record<string, unknown>;

function mappingObject(value: unknown, path: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object.`);
  }
  return value as JsonObject;
}

function mappingString(
  value: unknown,
  path: string,
  maximum: number,
): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maximum ||
    UNSAFE_TEXT.test(value)
  ) {
    throw new TypeError(
      `${path} must be a non-empty safe string of at most ${maximum} characters.`,
    );
  }
  return value;
}

function mappingId(
  value: unknown,
  path: string,
  maximum: number,
): string {
  const id = mappingString(value, path, maximum);
  if (!METRIC_ID.test(id)) {
    throw new TypeError(
      `${path} must use lower-case kebab-case and start with a letter.`,
    );
  }
  return id;
}

function boundedNumber(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
  exclusiveMinimum = false,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    (exclusiveMinimum ? value <= minimum : value < minimum) ||
    value > maximum
  ) {
    throw new RangeError(
      `${path} must be a finite number ${exclusiveMinimum ? "greater than" : "at least"} ${minimum} and at most ${maximum}.`,
    );
  }
  return value;
}

function validateMetricChannel(
  value: unknown,
  path: string,
): MetricChannelDefinitionV1 {
  const channel = mappingObject(value, path);
  if (!METRIC_SOURCE_KEYS.has(channel.metric as MetricSourceKey)) {
    throw new TypeError(
      `${path}.metric must be one of sloc, decisionLoad, maximumComplexity, or executableUnitCount.`,
    );
  }
  if (channel.formula !== "metric-value-v1") {
    throw new TypeError(
      `${path}.formula must be the monotone formula "metric-value-v1".`,
    );
  }
  const normalization = mappingObject(
    channel.normalization,
    `${path}.normalization`,
  );
  if (
    normalization.formula !== "linear-cap-v1" &&
    normalization.formula !== "log1p-cap-v1"
  ) {
    throw new TypeError(
      `${path}.normalization.formula must be "linear-cap-v1" or "log1p-cap-v1".`,
    );
  }
  boundedNumber(
    normalization.cap,
    `${path}.normalization.cap`,
    0,
    METRIC_MAPPING_DEFINITION_LIMITS.cap,
    true,
  );
  if (
    normalization.missing !== "zero" &&
    normalization.missing !== "error"
  ) {
    throw new TypeError(
      `${path}.normalization.missing must be "zero" or "error".`,
    );
  }
  return value as MetricChannelDefinitionV1;
}

/**
 * Validates the complete, bounded 1.0 definition and returns the same value so
 * callers can preserve canonical caller-owned provenance.
 */
export function validateMetricMappingDefinition(
  value: unknown,
  path = "metricMapping",
): MetricMappingDefinitionV1 {
  const definition = mappingObject(value, path);
  if (definition.definitionVersion !== "1.0") {
    throw new TypeError(`${path}.definitionVersion must be "1.0".`);
  }
  mappingId(
    definition.id,
    `${path}.id`,
    METRIC_MAPPING_DEFINITION_LIMITS.idCharacters,
  );
  mappingString(
    definition.name,
    `${path}.name`,
    METRIC_MAPPING_DEFINITION_LIMITS.nameCharacters,
  );
  const provenance = mappingObject(
    definition.provenance,
    `${path}.provenance`,
  );
  if (
    provenance.kind !== "built-in" &&
    provenance.kind !== "custom"
  ) {
    throw new TypeError(
      `${path}.provenance.kind must be "built-in" or "custom".`,
    );
  }
  mappingString(
    provenance.description,
    `${path}.provenance.description`,
    METRIC_MAPPING_DEFINITION_LIMITS.provenanceCharacters,
  );
  const channels = mappingObject(definition.channels, `${path}.channels`);
  validateMetricChannel(channels.footprint, `${path}.channels.footprint`);
  validateMetricChannel(channels.height, `${path}.channels.height`);
  const color = validateMetricChannel(
    channels.color,
    `${path}.channels.color`,
  ) as MetricColorChannelDefinitionV1;
  if (color.scale !== "normalized-threshold-palette-v1") {
    throw new TypeError(
      `${path}.channels.color.scale must be "normalized-threshold-palette-v1".`,
    );
  }
  if (
    !Array.isArray(color.palette) ||
    color.palette.length < 2 ||
    color.palette.length > METRIC_MAPPING_DEFINITION_LIMITS.paletteEntries
  ) {
    throw new TypeError(
      `${path}.channels.color.palette must contain between 2 and ${METRIC_MAPPING_DEFINITION_LIMITS.paletteEntries} entries.`,
    );
  }
  const paletteIds = new Set<string>();
  let previousMaximum = -1;
  color.palette.forEach((candidate, index) => {
    const entryPath = `${path}.channels.color.palette[${index}]`;
    const entry = mappingObject(candidate, entryPath);
    const id = mappingId(
      entry.id,
      `${entryPath}.id`,
      METRIC_MAPPING_DEFINITION_LIMITS.paletteIdCharacters,
    );
    if (paletteIds.has(id)) {
      throw new TypeError(`${entryPath}.id must be unique.`);
    }
    paletteIds.add(id);
    mappingString(
      entry.label,
      `${entryPath}.label`,
      METRIC_MAPPING_DEFINITION_LIMITS.nameCharacters,
    );
    if (
      typeof entry.color !== "string" ||
      entry.color.trim() !== entry.color ||
      !isDisplayColor(entry.color)
    ) {
      throw new TypeError(
        `${entryPath}.color must be a #RRGGBB or #RRGGBBAA color.`,
      );
    }
    const maximum = boundedNumber(
      entry.maximum,
      `${entryPath}.maximum`,
      0,
      1,
    );
    if (maximum <= previousMaximum) {
      throw new RangeError(
        `${entryPath}.maximum must be greater than the previous palette maximum.`,
      );
    }
    previousMaximum = maximum;
  });
  if (previousMaximum !== 1) {
    throw new RangeError(
      `${path}.channels.color.palette must end with maximum 1.`,
    );
  }
  const geometry = mappingObject(
    definition.geometry,
    `${path}.geometry`,
  );
  const footprint = mappingObject(
    geometry.footprint,
    `${path}.geometry.footprint`,
  );
  if (footprint.formula !== "normalized-side-range-v1") {
    throw new TypeError(
      `${path}.geometry.footprint.formula must be "normalized-side-range-v1".`,
    );
  }
  const minimumSide = boundedNumber(
    footprint.minimumSide,
    `${path}.geometry.footprint.minimumSide`,
    0,
    METRIC_MAPPING_DEFINITION_LIMITS.dimension,
    true,
  );
  const maximumSide = boundedNumber(
    footprint.maximumSide,
    `${path}.geometry.footprint.maximumSide`,
    0,
    METRIC_MAPPING_DEFINITION_LIMITS.dimension,
    true,
  );
  if (maximumSide < minimumSide) {
    throw new RangeError(
      `${path}.geometry.footprint.maximumSide must be at least minimumSide.`,
    );
  }
  boundedNumber(
    footprint.exponent,
    `${path}.geometry.footprint.exponent`,
    0,
    METRIC_MAPPING_DEFINITION_LIMITS.exponent,
    true,
  );
  const height = mappingObject(
    geometry.height,
    `${path}.geometry.height`,
  );
  if (height.formula !== "normalized-height-range-v1") {
    throw new TypeError(
      `${path}.geometry.height.formula must be "normalized-height-range-v1".`,
    );
  }
  const minimumHeight = boundedNumber(
    height.minimumHeight,
    `${path}.geometry.height.minimumHeight`,
    0,
    METRIC_MAPPING_DEFINITION_LIMITS.dimension,
    true,
  );
  const maximumHeight = boundedNumber(
    height.maximumHeight,
    `${path}.geometry.height.maximumHeight`,
    0,
    METRIC_MAPPING_DEFINITION_LIMITS.dimension,
    true,
  );
  if (maximumHeight < minimumHeight) {
    throw new RangeError(
      `${path}.geometry.height.maximumHeight must be at least minimumHeight.`,
    );
  }
  boundedNumber(
    height.exponent,
    `${path}.geometry.height.exponent`,
    0,
    METRIC_MAPPING_DEFINITION_LIMITS.exponent,
    true,
  );
  return value as MetricMappingDefinitionV1;
}

export function isMetricMappingDefinition(
  value: unknown,
): value is MetricMappingDefinitionV1 {
  try {
    validateMetricMappingDefinition(value);
    return true;
  } catch {
    return false;
  }
}

export const isVersionedMetricMapping = isMetricMappingDefinition;

export function validateLegacyMetricMapping(
  value: unknown,
  path = "metricMapping",
): typeof DEFAULT_METRIC_MAPPING {
  const mapping = mappingObject(value, path);
  const formulas = mappingObject(mapping.formulas, `${path}.formulas`);
  for (const [name, expected] of Object.entries(
    DEFAULT_METRIC_MAPPING.formulas,
  )) {
    if (formulas[name] !== expected) {
      throw new TypeError(
        `${path}.formulas.${name} must be "${expected}".`,
      );
    }
  }
  const caps = mappingObject(
    mapping.normalizationCaps,
    `${path}.normalizationCaps`,
  );
  for (const [name, expected] of Object.entries(
    DEFAULT_METRIC_MAPPING.normalizationCaps,
  )) {
    if (caps[name] !== expected) {
      throw new TypeError(
        `${path}.normalizationCaps.${name} must be ${expected}.`,
      );
    }
  }
  return value as typeof DEFAULT_METRIC_MAPPING;
}

export function isLegacyMetricMapping(
  value: unknown,
): value is typeof DEFAULT_METRIC_MAPPING {
  try {
    validateLegacyMetricMapping(value);
    return true;
  } catch {
    return false;
  }
}

export function validateMetricMapping(
  value: unknown,
  path = "metricMapping",
): MetricMapping {
  const mapping = mappingObject(value, path);
  return mapping.definitionVersion === undefined
    ? validateLegacyMetricMapping(mapping, path)
    : validateMetricMappingDefinition(mapping, path);
}

export function metricMappingProvenanceDescription(
  definition: MetricMappingDefinitionV1,
): string {
  const validated = validateMetricMappingDefinition(definition);
  return `${validated.name} (${validated.id}, definition ${validated.definitionVersion}; ${validated.provenance.kind}): ${validated.provenance.description}`;
}

export const describeMetricMapping = metricMappingProvenanceDescription;

export function normalizeMetricChannelValue(
  metrics: Partial<SourceMetrics>,
  channel: MetricChannelDefinitionV1,
  path = "metricChannel",
): { readonly value: number; readonly clamped: boolean } {
  const raw = metrics[channel.metric];
  let value: number;
  if (raw === undefined) {
    if (channel.normalization.missing === "error") {
      throw new TypeError(
        `${path}.metric "${channel.metric}" is unavailable.`,
      );
    }
    value = 0;
  } else {
    count(raw, `${path}.metric.${channel.metric}`);
    value = raw;
  }
  const { cap, formula } = channel.normalization;
  const normalized =
    formula === "linear-cap-v1"
      ? Math.min(1, value / cap)
      : normalizeLogarithmically(value, cap);
  return Object.freeze({
    value: normalized,
    clamped: value > cap,
  });
}

export function metricColorPaletteEntry(
  normalized: number,
  palette: readonly MetricColorPaletteEntryV1[],
): MetricColorPaletteEntryV1 {
  return (
    palette.find(({ maximum }) => normalized <= maximum) ??
    palette[palette.length - 1]!
  );
}

export const BUILDING_FOOTPRINT_SCALE = Object.freeze({
  minimumSide: 3,
  sideRange: 15,
  distributionExponent: 1.5,
});

export interface BuildingGeometry {
  readonly footprintArea: number;
  readonly normalizedSloc: number;
  readonly normalizedDecisionLoad: number;
  readonly slocClamped: boolean;
  readonly decisionLoadClamped: boolean;
  readonly size: Vector3;
}

function count(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer.`);
  }
  return value;
}

export function validateSourceMetrics(metrics: SourceMetrics): void {
  count(metrics.sloc, "sloc");
  count(metrics.decisionLoad, "decisionLoad");
  count(metrics.maximumComplexity, "maximumComplexity");
  count(metrics.executableUnitCount, "executableUnitCount");
}

export function classifyRisk(maximumComplexity: number): RiskBand {
  count(maximumComplexity, "maximumComplexity");
  if (maximumComplexity <= 5) return "low";
  if (maximumComplexity <= 10) return "moderate";
  if (maximumComplexity <= 20) return "high";
  return "very-high";
}

export function normalizeLogarithmically(value: number, cap: number): number {
  count(value, "value");
  if (!Number.isFinite(cap) || cap <= 0) {
    throw new RangeError("cap must be a positive finite number.");
  }
  return Math.min(1, Math.log1p(value) / Math.log1p(cap));
}

export function buildingFootprintArea(sloc: number): number {
  const normalizedSloc = normalizeLogarithmically(
    sloc,
    METRIC_NORMALIZATION_CAPS.sloc,
  );
  const side =
    BUILDING_FOOTPRINT_SCALE.minimumSide +
    BUILDING_FOOTPRINT_SCALE.sideRange *
      normalizedSloc ** BUILDING_FOOTPRINT_SCALE.distributionExponent;
  return side * side;
}

export function buildingHeight(decisionLoad: number): number {
  return (
    4 +
    36 *
      normalizeLogarithmically(
        decisionLoad,
        METRIC_NORMALIZATION_CAPS.decisionLoad,
      )
  );
}

export function calculateBuildingGeometry(
  metrics: Pick<SourceMetrics, "sloc" | "decisionLoad">,
): BuildingGeometry {
  const normalizedSloc = normalizeLogarithmically(
    metrics.sloc,
    METRIC_NORMALIZATION_CAPS.sloc,
  );
  const normalizedDecisionLoad = normalizeLogarithmically(
    metrics.decisionLoad,
    METRIC_NORMALIZATION_CAPS.decisionLoad,
  );
  const footprintArea = buildingFootprintArea(metrics.sloc);
  const side = Math.sqrt(footprintArea);
  return {
    footprintArea,
    normalizedSloc,
    normalizedDecisionLoad,
    slocClamped: metrics.sloc > METRIC_NORMALIZATION_CAPS.sloc,
    decisionLoadClamped:
      metrics.decisionLoad > METRIC_NORMALIZATION_CAPS.decisionLoad,
    size: {
      x: side,
      y: 4 + 36 * normalizedDecisionLoad,
      z: side,
    },
  };
}

export function metricNormalizationForGeometry(
  geometry: Pick<
    BuildingGeometry,
    | "normalizedSloc"
    | "normalizedDecisionLoad"
    | "slocClamped"
    | "decisionLoadClamped"
  >,
): BuildingMetricNormalization {
  return {
    sloc: {
      state: geometry.slocClamped ? "clamped" : "available",
      normalizedValue: geometry.normalizedSloc,
    },
    decisionLoad: {
      state: geometry.decisionLoadClamped ? "clamped" : "available",
      normalizedValue: geometry.normalizedDecisionLoad,
    },
  };
}

export function metricMappingPreservesLegacyNormalization(
  definition: MetricMappingDefinitionV1,
): boolean {
  return (
    definition.channels.footprint.metric === "sloc" &&
    definition.channels.footprint.formula === "metric-value-v1" &&
    definition.channels.footprint.normalization.formula ===
      "log1p-cap-v1" &&
    definition.channels.footprint.normalization.cap === 1_000 &&
    definition.channels.footprint.normalization.missing === "error" &&
    definition.channels.height.metric === "decisionLoad" &&
    definition.channels.height.formula === "metric-value-v1" &&
    definition.channels.height.normalization.formula ===
      "log1p-cap-v1" &&
    definition.channels.height.normalization.cap === 100 &&
    definition.channels.height.normalization.missing === "error" &&
    definition.geometry.footprint.formula ===
      "normalized-side-range-v1" &&
    definition.geometry.footprint.minimumSide === 3 &&
    definition.geometry.footprint.maximumSide === 18 &&
    definition.geometry.footprint.exponent === 1.5 &&
    definition.geometry.height.formula ===
      "normalized-height-range-v1" &&
    definition.geometry.height.minimumHeight === 4 &&
    definition.geometry.height.maximumHeight === 40 &&
    definition.geometry.height.exponent === 1
  );
}

export function metricNormalizationForMapping(
  metrics: SourceMetrics,
  definition: MetricMappingDefinitionV1,
): BuildingMetricNormalization | undefined {
  return metricMappingPreservesLegacyNormalization(definition)
    ? metricNormalizationForGeometry(calculateBuildingGeometry(metrics))
    : undefined;
}

export const riskBandForComplexity = classifyRisk;
export const buildingGeometry = calculateBuildingGeometry;
