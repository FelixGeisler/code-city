import {
  DEFAULT_METRIC_MAPPING,
  describeMetricMapping,
  isVersionedMetricMapping,
  normalizeMetricChannelValue,
} from "../../../packages/core/src/metrics.js";
import type {
  CityBuilding,
  CityModel,
  SemanticGroup,
} from "../../../packages/core/src/model.js";
import { assignSemanticGroups } from "../../../packages/core/src/print.js";
import type { PrinterProfile } from "../../../packages/core/src/print.js";

export type ViewerVisualizationMode =
  | "semantic"
  | "complexity"
  | "age"
  | "churn"
  | "print";

export interface EvolutionVisualizationData {
  readonly ageByBuildingId: ReadonlyMap<string, number>;
  readonly churnByBuildingId: ReadonlyMap<string, number>;
}

export interface ViewerVisualization {
  readonly mode: ViewerVisualizationMode;
  readonly label: string;
  readonly colorsByBuildingId: ReadonlyMap<string, string>;
  readonly legend: readonly SemanticGroup[];
  readonly status: string;
  readonly available: boolean;
}

const RISK_GROUPS = Object.freeze([
  Object.freeze({
    id: "risk-low",
    label: "Low risk (maximum complexity 0–5)",
    color: "#4ade80",
    priority: 4,
  }),
  Object.freeze({
    id: "risk-moderate",
    label: "Moderate risk (maximum complexity 6–10)",
    color: "#facc15",
    priority: 3,
  }),
  Object.freeze({
    id: "risk-high",
    label: "High risk (maximum complexity 11–20)",
    color: "#fb923c",
    priority: 2,
  }),
  Object.freeze({
    id: "risk-very-high",
    label: "Very high risk (maximum complexity 21+)",
    color: "#f43f5e",
    priority: 1,
  }),
]) satisfies readonly SemanticGroup[];

const FALLBACK_CHANNEL_COLORS = Object.freeze([
  "#2563eb",
  "#dc2626",
  "#16a34a",
  "#9333ea",
  "#ea580c",
  "#0891b2",
  "#be123c",
  "#4f46e5",
]);

const AGE_GROUPS = Object.freeze([
  { id: "age-new", label: "Newest", color: "#38bdf8", priority: 4 },
  { id: "age-young", label: "Younger", color: "#34d399", priority: 3 },
  { id: "age-mature", label: "Established", color: "#facc15", priority: 2 },
  { id: "age-old", label: "Oldest", color: "#f97316", priority: 1 },
] satisfies readonly SemanticGroup[]);

const CHURN_GROUPS = Object.freeze([
  { id: "churn-none", label: "No historical changes", color: "#64748b", priority: 4 },
  { id: "churn-low", label: "Low churn", color: "#4ade80", priority: 3 },
  { id: "churn-medium", label: "Moderate churn", color: "#facc15", priority: 2 },
  { id: "churn-high", label: "High churn", color: "#f43f5e", priority: 1 },
] satisfies readonly SemanticGroup[]);

function semanticVisualization(model: CityModel): ViewerVisualization {
  const colors = new Map(
    model.semanticGroups.map(({ id, color }) => [id, color]),
  );
  return {
    mode: "semantic",
    label: "Semantic groups",
    colorsByBuildingId: new Map(
      model.buildings.map(({ id, semanticGroupId }) => [
        id,
        colors.get(semanticGroupId) ?? "#94a3b8",
      ]),
    ),
    legend: model.semanticGroups,
    status: "Colors show the model's persisted semantic groups.",
    available: true,
  };
}

function complexityVisualization(model: CityModel): ViewerVisualization {
  const colors = new Map(RISK_GROUPS.map(({ id, color }) => [id, color]));
  return {
    mode: "complexity",
    label: "Complexity risk",
    colorsByBuildingId: new Map(
      model.buildings.map(({ id, risk }) => [
        id,
        colors.get(`risk-${risk}`) ?? "#94a3b8",
      ]),
    ),
    legend: RISK_GROUPS,
    status:
      "Colors use each building's persisted risk band; analyzer facts are not reclassified.",
    available: true,
  };
}

function unavailableEvolutionVisualization(
  model: CityModel,
  mode: "age" | "churn",
): ViewerVisualization {
  return {
    ...semanticVisualization(model),
    mode,
    label: mode === "age" ? "Building age" : "Historical churn",
    status:
      "This mode requires a repository import with evolution history.",
    available: false,
  };
}

function bucketVisualization(
  model: CityModel,
  mode: "age" | "churn",
  values: ReadonlyMap<string, number>,
  groups: readonly SemanticGroup[],
): ViewerVisualization {
  let maximum = 0;
  for (const value of values.values()) {
    maximum = Math.max(maximum, value);
  }
  const groupFor = (value: number): SemanticGroup => {
    if (mode === "churn" && value === 0) return groups[0]!;
    if (maximum === 0) return groups[0]!;
    const ratio = value / maximum;
    if (ratio <= 0.25) return groups[mode === "age" ? 0 : 1]!;
    if (ratio <= 0.6) return groups[mode === "age" ? 1 : 2]!;
    if (ratio < 1) return groups[mode === "age" ? 2 : 3]!;
    return groups[3]!;
  };
  return {
    mode,
    label: mode === "age" ? "Building age" : "Historical churn",
    colorsByBuildingId: new Map(
      model.buildings.map(({ id }) => [
        id,
        bucketVisualizationColor(values.get(id), groupFor),
      ]),
    ),
    legend: groups,
    status:
      mode === "age"
        ? "Colors show frames elapsed since each building first appeared."
        : "Colors show additions, removals, and replacements through this commit.",
    available: true,
  };
}

function bucketVisualizationColor(
  value: number | undefined,
  groupFor: (value: number) => SemanticGroup,
): string {
  return value === undefined ? "#94a3b8" : groupFor(value).color;
}

function unavailablePrintVisualization(
  model: CityModel,
  status: string,
): ViewerVisualization {
  return {
    ...semanticVisualization(model),
    mode: "print",
    label: "Printer-profile assignment preview",
    status,
    available: false,
  };
}

function printVisualization(
  model: CityModel,
  profile: PrinterProfile | undefined,
): ViewerVisualization {
  if (profile === undefined) {
    return unavailablePrintVisualization(
      model,
      "Print preview unavailable: choose a valid printer profile in Export print file.",
    );
  }
  try {
    const assignments = assignSemanticGroups(
      profile,
      model.semanticGroups,
    );
    let usedFallback = false;
    const channelColors = new Map(
      profile.printChannels.map((channel, index) => {
        if (channel.color === undefined) usedFallback = true;
        return [
          channel.id,
          channel.color ??
            FALLBACK_CHANNEL_COLORS[
              index % FALLBACK_CHANNEL_COLORS.length
            ]!,
        ];
      }),
    );
    const groupColors = new Map(
      assignments.map(({ semanticGroupId, channelId }) => [
        semanticGroupId,
        channelColors.get(channelId) ?? "#94a3b8",
      ]),
    );
    return {
      mode: "print",
      label: "Printer-profile assignment preview",
      colorsByBuildingId: new Map(
        model.buildings.map(({ id, semanticGroupId }) => [
          id,
          groupColors.get(semanticGroupId) ?? "#94a3b8",
        ]),
      ),
      legend: profile.printChannels.map((channel, index) => ({
        id: channel.id,
        label: channel.label,
        color:
          channel.color ??
          FALLBACK_CHANNEL_COLORS[
            index % FALLBACK_CHANNEL_COLORS.length
          ]!,
        priority: profile.printChannels.length - index,
      })),
      status:
        `Previewing ${profile.name} channel assignments only; this does not claim printability or filament properties.` +
        (usedFallback
          ? " Some channels have no profile color, so stable fallback colors are shown."
          : ""),
      available: true,
    };
  } catch {
    return unavailablePrintVisualization(
      model,
      "Print preview unavailable: the current printer profile cannot assign this model.",
    );
  }
}

export function createViewerVisualization(
  model: CityModel,
  mode: ViewerVisualizationMode,
  profile?: PrinterProfile,
  evolution?: EvolutionVisualizationData,
): ViewerVisualization {
  switch (mode) {
    case "semantic":
      return semanticVisualization(model);
    case "complexity":
      return complexityVisualization(model);
    case "age":
      return evolution === undefined
        ? unavailableEvolutionVisualization(model, mode)
        : bucketVisualization(
            model,
            mode,
            evolution.ageByBuildingId,
            AGE_GROUPS,
          );
    case "churn":
      return evolution === undefined
        ? unavailableEvolutionVisualization(model, mode)
        : bucketVisualization(
            model,
            mode,
            evolution.churnByBuildingId,
            CHURN_GROUPS,
          );
    case "print":
      return printVisualization(model, profile);
  }
}

export function describeBuildingMetrics(
  model: CityModel,
  building: CityBuilding,
): string {
  const mapping = model.metricMapping ?? DEFAULT_METRIC_MAPPING;
  if (isVersionedMetricMapping(mapping)) {
    const channel = (
      name: "footprint" | "height" | "color",
    ): string => {
      const definition = mapping.channels[name];
      const value = building.metrics[definition.metric];
      const normalized = normalizeMetricChannelValue(
        building.metrics,
        definition,
      );
      return `${name} ${definition.metric} raw ${value}, normalized ${normalized.value.toFixed(4)} (${normalized.clamped ? "clamped" : "available"}), ${definition.formula} → ${definition.normalization.formula} (cap ${definition.normalization.cap}, missing ${definition.normalization.missing})`;
    };
    return [
      `Raw SLOC ${building.metrics.sloc}; decision load ${building.metrics.decisionLoad}; maximum per-unit complexity ${building.metrics.maximumComplexity}; executable units ${building.metrics.executableUnitCount}.`,
      `Metric method ${building.metricMethod ?? "not recorded"}.`,
      `Metric channels: ${channel("footprint")}; ${channel("height")}; ${channel("color")}.`,
      `Geometry formulas: footprint ${mapping.geometry.footprint.formula} (${mapping.geometry.footprint.minimumSide}–${mapping.geometry.footprint.maximumSide}); height ${mapping.geometry.height.formula} (${mapping.geometry.height.minimumHeight}–${mapping.geometry.height.maximumHeight}); color ${mapping.channels.color.scale}.`,
      `Mapping provenance: ${describeMetricMapping(mapping)}`,
    ].join(" ");
  }
  const normalization = building.metricNormalization;
  const state = (metric: "sloc" | "decisionLoad"): string => {
    const persisted = normalization?.[metric].state;
    if (persisted !== undefined) return persisted;
    const value = building.metrics[metric];
    const cap = mapping.normalizationCaps[metric];
    return `${value > cap ? "clamped" : "available"} (derived from the schema-default mapping)`;
  };
  return [
    `Raw SLOC ${building.metrics.sloc}; decision load ${building.metrics.decisionLoad}; maximum per-unit complexity ${building.metrics.maximumComplexity}; executable units ${building.metrics.executableUnitCount}.`,
    `Metric method ${building.metricMethod ?? "not recorded"}.`,
    `Formula IDs: footprint ${mapping.formulas.footprint}; height ${mapping.formulas.height}; risk ${mapping.formulas.risk}; normalization ${mapping.formulas.normalization}.`,
    `Normalization caps: SLOC ${mapping.normalizationCaps.sloc}; decision load ${mapping.normalizationCaps.decisionLoad}.`,
    `Normalization state: SLOC ${state("sloc")}; decision load ${state("decisionLoad")}.`,
    model.metricMapping === undefined
      ? "Mapping provenance: schema-default mapping derived for a legacy model."
      : "Mapping provenance: persisted in the CityModel.",
  ].join(" ");
}
