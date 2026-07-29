import type {
  BuildingMetricNormalization,
  MetricMapping,
  RiskBand,
  SourceMetrics,
  Vector3,
} from "./model.js";

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

export const riskBandForComplexity = classifyRisk;
export const buildingGeometry = calculateBuildingGeometry;
