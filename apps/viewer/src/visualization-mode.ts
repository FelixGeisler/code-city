import {
  DEFAULT_METRIC_MAPPING,
  describeMetricMapping,
  isVersionedMetricMapping,
  metricColorPaletteEntry,
  normalizeMetricChannelValue,
} from "../../../packages/core/src/metrics.js";
import type {
  CityBuilding,
  CityModel,
  MetricMethod,
  MetricNormalizationState,
  MetricSourceKey,
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

export interface BuildingMetricPresentationRow {
  readonly id: "footprint" | "height" | "color" | "method";
  readonly label: string;
  readonly value: string;
  readonly description: string;
  readonly state: MetricNormalizationState;
}

export interface BuildingMetricTechnicalEntry {
  readonly label: string;
  readonly value: string;
}

export interface BuildingMetricPresentation {
  readonly buildingId: string;
  readonly rows: readonly BuildingMetricPresentationRow[];
  readonly technical: readonly BuildingMetricTechnicalEntry[];
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

export function presentBuildingMetrics(
  model: CityModel,
  building: CityBuilding,
): BuildingMetricPresentation {
  const mapping = model.metricMapping ?? DEFAULT_METRIC_MAPPING;
  const method = metricMethodPresentation(building.metricMethod);
  if (isVersionedMetricMapping(mapping)) {
    const channelRow = (
      id: "footprint" | "height" | "color",
      label: string,
      purpose: string,
    ): BuildingMetricPresentationRow => {
      const definition = mapping.channels[id];
      const raw = building.metrics[definition.metric];
      const normalized = normalizeMetricChannelValue(
        building.metrics,
        definition,
      );
      const palette =
        id === "color"
          ? metricColorPaletteEntry(
              normalized.value,
              mapping.channels.color.palette,
            ).label
          : undefined;
      return {
        id,
        label,
        value:
          formatMetricValue(definition.metric, raw) +
          (palette === undefined ? "" : ` · ${palette}`),
        description:
          `${purpose} ${metricMeaning(definition.metric)}` +
          (normalized.clamped
            ? ` Values above ${definition.normalization.cap.toLocaleString()} share the display maximum.`
            : ""),
        state: normalized.clamped ? "clamped" : "available",
      };
    };
    return {
      buildingId: building.id,
      rows: [
        channelRow(
          "footprint",
          "Footprint",
          "Controls the building's width and depth.",
        ),
        channelRow(
          "height",
          "Height",
          "Controls how tall the building appears.",
        ),
        channelRow(
          "color",
          "Color",
          "Selects the building's color band.",
        ),
        {
          id: "method",
          label: "Measured with",
          value: method.label,
          description: method.description,
          state:
            building.metricMethod === undefined
              ? "unavailable"
              : "available",
        },
      ],
      technical: versionedMetricTechnicalEntries(
        mapping,
        building,
      ),
    };
  }

  const normalizationState = (
    metric: "sloc" | "decisionLoad",
  ): MetricNormalizationState => {
    const persisted = building.metricNormalization?.[metric].state;
    if (persisted !== undefined) return persisted;
    return building.metrics[metric] > mapping.normalizationCaps[metric]
      ? "clamped"
      : "available";
  };
  const legacyRow = (
    id: "footprint" | "height",
    label: string,
    purpose: string,
    metric: "sloc" | "decisionLoad",
  ): BuildingMetricPresentationRow => {
    const state = normalizationState(metric);
    return {
      id,
      label,
      value: formatMetricValue(metric, building.metrics[metric]),
      description:
        `${purpose} ${metricMeaning(metric)}` +
        (state === "clamped"
          ? ` Values above ${mapping.normalizationCaps[metric].toLocaleString()} share the display maximum.`
          : state === "unavailable"
            ? " Display normalization was not recorded."
            : ""),
      state,
    };
  };
  return {
    buildingId: building.id,
    rows: [
      legacyRow(
        "footprint",
        "Footprint",
        "Controls the building's width and depth.",
        "sloc",
      ),
      legacyRow(
        "height",
        "Height",
        "Controls how tall the building appears.",
        "decisionLoad",
      ),
      {
        id: "color",
        label: "Color",
        value:
          formatMetricValue(
            "maximumComplexity",
            building.metrics.maximumComplexity,
          ) + ` · ${riskLabel(building.risk)}`,
        description:
          "Selects the building's complexity-risk color band. Maximum complexity is the highest measured executable unit.",
        state: "available",
      },
      {
        id: "method",
        label: "Measured with",
        value: method.label,
        description: method.description,
        state:
          building.metricMethod === undefined
            ? "unavailable"
            : "available",
      },
    ],
    technical: legacyMetricTechnicalEntries(
      model,
      mapping,
      building,
    ),
  };
}

function metricMethodPresentation(
  method: MetricMethod | undefined,
): { readonly label: string; readonly description: string } {
  switch (method) {
    case "typescript-compiler-api-v1":
      return {
        label: "TypeScript compiler analysis",
        description:
          "Static TypeScript/JavaScript syntax analysis calculated these values.",
      };
    case "csharp-roslyn-v1":
      return {
        label: "Roslyn analysis (C#)",
        description:
          "Microsoft Roslyn syntax analysis calculated these values.",
      };
    case "csharp-lexical-v1":
      return {
        label: "C# lexical analysis",
        description:
          "A deterministic lexical fallback calculated these values.",
      };
    case undefined:
      return {
        label: "Not recorded",
        description:
          "This older or model-only city does not identify the analyzer used.",
      };
  }
}

function metricMeaning(metric: MetricSourceKey): string {
  switch (metric) {
    case "sloc":
      return "More source lines produce a larger footprint.";
    case "decisionLoad":
      return "More decision points produce more height.";
    case "maximumComplexity":
      return "The most complex executable unit determines this channel.";
    case "executableUnitCount":
      return "More functions, methods, and other executable units increase this channel.";
  }
}

function formatMetricValue(
  metric: MetricSourceKey,
  value: number,
): string {
  const formatted = value.toLocaleString();
  switch (metric) {
    case "sloc":
      return `${formatted} SLOC`;
    case "decisionLoad":
      return `${formatted} decision points`;
    case "maximumComplexity":
      return `CC ${formatted}`;
    case "executableUnitCount":
      return `${formatted} executable units`;
  }
}

function riskLabel(risk: CityBuilding["risk"]): string {
  return `${risk === "very-high" ? "Very high" : risk[0]!.toUpperCase() + risk.slice(1)} risk`;
}

function rawMetricFacts(building: CityBuilding): string {
  return (
    `SLOC ${building.metrics.sloc}; decision load ${building.metrics.decisionLoad}; ` +
    `maximum per-unit complexity ${building.metrics.maximumComplexity}; ` +
    `executable units ${building.metrics.executableUnitCount}`
  );
}

function versionedMetricTechnicalEntries(
  mapping: Extract<CityModel["metricMapping"], { readonly definitionVersion: "1.0" }>,
  building: CityBuilding,
): readonly BuildingMetricTechnicalEntry[] {
  const channel = (
    name: "footprint" | "height" | "color",
  ): string => {
    const definition = mapping.channels[name];
    const value = building.metrics[definition.metric];
    const normalized = normalizeMetricChannelValue(
      building.metrics,
      definition,
    );
    return (
      `${definition.metric}: raw ${value}, normalized ${normalized.value.toFixed(4)} ` +
      `(${normalized.clamped ? "clamped" : "available"}); ` +
      `${definition.formula} → ${definition.normalization.formula}; ` +
      `cap ${definition.normalization.cap}; missing ${definition.normalization.missing}` +
      (name === "color" ? `; scale ${mapping.channels.color.scale}` : "")
    );
  };
  return [
    {
      label: "Analyzer ID",
      value: building.metricMethod ?? "not recorded",
    },
    { label: "Raw facts", value: rawMetricFacts(building) },
    { label: "Footprint channel", value: channel("footprint") },
    { label: "Height channel", value: channel("height") },
    { label: "Color channel", value: channel("color") },
    {
      label: "Geometry",
      value:
        `footprint ${mapping.geometry.footprint.formula} ` +
        `(${mapping.geometry.footprint.minimumSide}–${mapping.geometry.footprint.maximumSide}); ` +
        `height ${mapping.geometry.height.formula} ` +
        `(${mapping.geometry.height.minimumHeight}–${mapping.geometry.height.maximumHeight})`,
    },
    {
      label: "Mapping provenance",
      value: describeMetricMapping(mapping),
    },
  ];
}

function legacyMetricTechnicalEntries(
  model: CityModel,
  mapping: typeof DEFAULT_METRIC_MAPPING,
  building: CityBuilding,
): readonly BuildingMetricTechnicalEntry[] {
  const state = (metric: "sloc" | "decisionLoad"): string => {
    const persisted = building.metricNormalization?.[metric].state;
    if (persisted !== undefined) return persisted;
    const value = building.metrics[metric];
    const cap = mapping.normalizationCaps[metric];
    return `${value > cap ? "clamped" : "available"} (derived from the schema-default mapping)`;
  };
  return [
    {
      label: "Analyzer ID",
      value: building.metricMethod ?? "not recorded",
    },
    { label: "Raw facts", value: rawMetricFacts(building) },
    {
      label: "Formula IDs",
      value:
        `footprint ${mapping.formulas.footprint}; height ${mapping.formulas.height}; ` +
        `risk ${mapping.formulas.risk}; normalization ${mapping.formulas.normalization}`,
    },
    {
      label: "Normalization",
      value:
        `SLOC cap ${mapping.normalizationCaps.sloc}, ${state("sloc")}; ` +
        `decision-load cap ${mapping.normalizationCaps.decisionLoad}, ${state("decisionLoad")}`,
    },
    {
      label: "Mapping provenance",
      value:
        model.metricMapping === undefined
          ? "Schema-default mapping derived for a legacy model."
          : "Persisted in the CityModel.",
    },
  ];
}

export function describeBuildingMetrics(
  model: CityModel,
  building: CityBuilding,
): string {
  return presentBuildingMetrics(model, building).technical
    .map(({ label, value }) => `${label}: ${value}.`)
    .join(" ");
}
