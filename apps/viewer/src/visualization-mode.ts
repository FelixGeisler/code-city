import { DEFAULT_METRIC_MAPPING } from "../../../packages/core/src/metrics.js";
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
  | "print";

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
): ViewerVisualization {
  switch (mode) {
    case "semantic":
      return semanticVisualization(model);
    case "complexity":
      return complexityVisualization(model);
    case "print":
      return printVisualization(model, profile);
  }
}

export function describeBuildingMetrics(
  model: CityModel,
  building: CityBuilding,
): string {
  const mapping = model.metricMapping ?? DEFAULT_METRIC_MAPPING;
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
