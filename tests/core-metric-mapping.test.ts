import { describe, expect, it } from "vitest";

import { DEMO_MODEL } from "../apps/viewer/src/demo-model.js";
import {
  applyMetricMapping,
  assignSemanticGroups,
  createMetricMappingLegend,
  createPrusaXLProfile,
  DEFAULT_METRIC_MAPPING,
  DEFAULT_VERSIONED_METRIC_MAPPING,
  inspectMetricMapping,
  isMetricMappingDefinition,
  MAPPABLE_BUILDING_METRICS,
  METRIC_MAPPING_PRESET_CATALOG,
  resolveMetricMappingPreset,
  summarizeMetricMapping,
  validateCityModel,
  validateMetricMapping,
  validateMetricMappingDefinition,
  type CityModel,
  type MetricMappingDefinitionV1,
} from "../packages/core/src/index.js";

function availablePreset(id: string): MetricMappingDefinitionV1 {
  const preset = METRIC_MAPPING_PRESET_CATALOG.find(
    (candidate) => candidate.id === id,
  );
  if (preset?.availability !== "available") {
    throw new Error(`Expected available preset '${id}'.`);
  }
  return preset.definition;
}

function customMapping(): MetricMappingDefinitionV1 {
  return {
    ...DEFAULT_VERSIONED_METRIC_MAPPING,
    id: "test-maintenance",
    name: "Test maintenance",
    provenance: {
      kind: "custom",
      description: "Focused deterministic projection test.",
    },
    channels: {
      footprint: {
        metric: "executableUnitCount",
        formula: "metric-value-v1",
        normalization: {
          formula: "linear-cap-v1",
          cap: 20,
          missing: "zero",
        },
      },
      height: {
        metric: "maximumComplexity",
        formula: "metric-value-v1",
        normalization: {
          formula: "log1p-cap-v1",
          cap: 25,
          missing: "error",
        },
      },
      color: {
        metric: "decisionLoad",
        formula: "metric-value-v1",
        normalization: {
          formula: "linear-cap-v1",
          cap: 100,
          missing: "error",
        },
        scale: "normalized-threshold-palette-v1",
        palette: [
          {
            id: "calm",
            label: "Calm",
            color: "#2563EB",
            maximum: 0.5,
          },
          {
            id: "busy",
            label: "Busy",
            color: "#DC2626",
            maximum: 1,
          },
        ],
      },
    },
    geometry: {
      footprint: {
        formula: "normalized-side-range-v1",
        minimumSide: 2,
        maximumSide: 12,
        exponent: 2,
      },
      height: {
        formula: "normalized-height-range-v1",
        minimumHeight: 3,
        maximumHeight: 30,
        exponent: 1.25,
      },
    },
  };
}

describe("versioned metric mapping contract", () => {
  it("publishes bounded supported metrics and curated availability", () => {
    expect(MAPPABLE_BUILDING_METRICS).toEqual([
      "sloc",
      "decisionLoad",
      "maximumComplexity",
      "executableUnitCount",
    ]);
    expect(
      METRIC_MAPPING_PRESET_CATALOG.filter(
        ({ availability }) => availability === "available",
      ).map(({ id }) => id),
    ).toEqual(["complexity", "maintenance", "print"]);
    const unavailable = METRIC_MAPPING_PRESET_CATALOG.filter(
      ({ availability }) => availability === "unavailable",
    );
    expect(unavailable.map(({ id }) => id)).toEqual([
      "dependencies",
      "ownership",
      "evolution",
    ]);
    expect(
      unavailable.every(
        (preset) =>
          preset.availability === "unavailable" &&
          preset.reason.trim().length > 0,
      ),
    ).toBe(true);
    expect(() => resolveMetricMappingPreset("dependencies")).toThrow(
      /dependencies.*unavailable.*not yet present/u,
    );
    expect(() => resolveMetricMappingPreset("unknown")).toThrow(
      /unknown.*not recognized/u,
    );
  });

  it("keeps the exact legacy fixed mapping valid", () => {
    expect(validateMetricMapping(DEFAULT_METRIC_MAPPING)).toBe(
      DEFAULT_METRIC_MAPPING,
    );
    expect(
      validateCityModel({
        ...DEMO_MODEL,
        metricMapping: DEFAULT_METRIC_MAPPING,
      }).metricMapping,
    ).toBe(DEFAULT_METRIC_MAPPING);
  });

  it("validates every inspectable formula and reports exact field paths", () => {
    const mapping = customMapping();
    expect(validateMetricMappingDefinition(mapping)).toBe(mapping);
    expect(isMetricMappingDefinition(mapping)).toBe(true);

    expect(() =>
      validateMetricMappingDefinition({
        ...mapping,
        channels: {
          ...mapping.channels,
          footprint: {
            ...mapping.channels.footprint,
            metric: "dependencies",
          },
        },
      }),
    ).toThrow(/metricMapping\.channels\.footprint\.metric/u);
    expect(() =>
      validateMetricMappingDefinition({
        ...mapping,
        geometry: {
          ...mapping.geometry,
          height: {
            ...mapping.geometry.height,
            formula: "arbitrary-code",
          },
        },
      }),
    ).toThrow(/metricMapping\.geometry\.height\.formula/u);
    expect(() =>
      validateMetricMappingDefinition({
        ...mapping,
        channels: {
          ...mapping.channels,
          height: {
            ...mapping.channels.height,
            normalization: {
              ...mapping.channels.height.normalization,
              cap: 0,
            },
          },
        },
      }),
    ).toThrow(/metricMapping\.channels\.height\.normalization\.cap/u);
    expect(() =>
      validateMetricMappingDefinition({
        ...mapping,
        channels: {
          ...mapping.channels,
          color: {
            ...mapping.channels.color,
            palette: [
              mapping.channels.color.palette[1]!,
              mapping.channels.color.palette[0]!,
            ],
          },
        },
      }),
    ).toThrow(/palette\[1\]\.maximum/u);
    expect(() =>
      validateMetricMappingDefinition({
        ...mapping,
        channels: {
          ...mapping.channels,
          color: {
            ...mapping.channels.color,
            palette: mapping.channels.color.palette.map(
              (entry, index) =>
                index === 0
                  ? { ...entry, color: ` ${entry.color}` }
                  : entry,
            ),
          },
        },
      }),
    ).toThrow(
      /metricMapping\.channels\.color\.palette\[0\]\.color/u,
    );
  });

  it("rebuilds geometry and discrete color groups deterministically", () => {
    const mapping = customMapping();
    const sourceJson = JSON.stringify(DEMO_MODEL);
    const first = applyMetricMapping(DEMO_MODEL, mapping);
    const second = applyMetricMapping(DEMO_MODEL, mapping);

    expect(second).toEqual(first);
    expect(JSON.stringify(DEMO_MODEL)).toBe(sourceJson);
    expect(first).not.toBe(DEMO_MODEL);
    expect(first.metricMapping).toBe(mapping);
    expect(first.dependencies).toEqual(DEMO_MODEL.dependencies);
    expect(
      first.buildings.every(({ semanticGroupId }) =>
        semanticGroupId.startsWith("metric-color-test-maintenance-"),
      ),
    ).toBe(true);
    expect(
      first.semanticGroups.filter(({ id }) =>
        id.startsWith("metric-color-test-maintenance-"),
      ),
    ).toHaveLength(2);
    const printAssignments = assignSemanticGroups(
      createPrusaXLProfile([1, 2]),
      first.semanticGroups,
    );
    for (const building of first.buildings) {
      expect(
        printAssignments.some(
          ({ semanticGroupId }) =>
            semanticGroupId === building.semanticGroupId,
        ),
      ).toBe(true);
    }
    expect(
      first.semanticGroups
        .filter(({ id }) =>
          id.startsWith("metric-color-test-maintenance-"),
        )
        .map(({ id, mergeInto }) => ({ id, mergeInto })),
    ).toEqual([
      {
        id: "metric-color-test-maintenance-calm",
        mergeInto: "metric-color-test-maintenance-busy",
      },
      {
        id: "metric-color-test-maintenance-busy",
        mergeInto: "base",
      },
    ]);

    const source = DEMO_MODEL.buildings[0]!;
    const projected = first.buildings.find(({ id }) => id === source.id)!;
    const normalized = Math.min(
      1,
      source.metrics.executableUnitCount / 20,
    );
    const side = 2 + 10 * normalized ** 2;
    expect(projected.size.x).toBeCloseTo(side, 12);
    expect(projected.size.z).toBeCloseTo(side, 12);
    expect(first.bounds.y).toBeGreaterThanOrEqual(projected.size.y);
  });

  it("preserves source ranges and declaration detail while remapping geometry", () => {
    const sourceStructure = {
      version: "codecity.source-structure/1" as const,
      availability: "available" as const,
      types: [{
        id: "type:stable",
        name: "Stable",
        kind: "class" as const,
        range: {
          startLine: 1,
          startColumn: 1,
          endLine: 5,
          endColumn: 1,
        },
        provenance: "syntax" as const,
      }],
      callables: [{
        id: "callable:stable",
        name: "run",
        kind: "method" as const,
        range: {
          startLine: 2,
          startColumn: 3,
          endLine: 4,
          endColumn: 3,
        },
        provenance: "syntax" as const,
        enclosingTypeId: "type:stable",
        complexity: 2,
      }],
      relations: [],
      unavailable: [],
    };
    const source = DEMO_MODEL.buildings[0]!;
    const detailed = validateCityModel({
      ...DEMO_MODEL,
      buildings: DEMO_MODEL.buildings.map((building) =>
        building.id === source.id
          ? {
              ...building,
              sourceLocation: { startLine: 1, endLine: 5 },
              sourceStructure,
            }
          : building,
      ),
    });

    const projected = applyMetricMapping(detailed, customMapping());
    const building = projected.buildings.find(({ id }) => id === source.id)!;
    expect(building.sourceLocation).toEqual({
      startLine: 1,
      endLine: 5,
    });
    expect(building.sourceStructure).toEqual(sourceStructure);
  });

  it("removes stale generated groups when applying another mapping", () => {
    const first = applyMetricMapping(DEMO_MODEL, customMapping());
    const maintenance = availablePreset("maintenance");
    const second = applyMetricMapping(first, maintenance);

    expect(
      second.semanticGroups.some(({ id }) =>
        id.startsWith("metric-color-test-maintenance-"),
      ),
    ).toBe(false);
    expect(
      second.semanticGroups.some(({ id }) =>
        id.startsWith("metric-color-maintenance-"),
      ),
    ).toBe(true);
  });

  it("replaces generated merge targets without duplicating caller references", () => {
    const mapping = customMapping();
    const first = applyMetricMapping(DEMO_MODEL, mapping);
    const generatedTarget = "metric-color-test-maintenance-calm";
    const extended = validateCityModel({
      ...first,
      semanticGroups: [
        ...first.semanticGroups,
        {
          id: "caller-overlay",
          label: "Caller overlay",
          color: "#334155",
          priority: 1,
          mergeInto: generatedTarget,
        },
      ],
    });

    const reapplied = applyMetricMapping(extended, mapping);
    const ids = reapplied.semanticGroups.map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((id) => id === generatedTarget)).toHaveLength(1);
    expect(
      reapplied.semanticGroups.find(({ id }) => id === "caller-overlay")
        ?.mergeInto,
    ).toBe(generatedTarget);
    expect(validateCityModel(reapplied)).toBe(reapplied);
  });

  it("gives scarce print channels to higher mapped bands, not stale groups", () => {
    const model = applyMetricMapping(
      DEMO_MODEL,
      DEFAULT_VERSIONED_METRIC_MAPPING,
    );
    expect(
      model.semanticGroups.some(
        ({ id }) =>
          id.startsWith("risk-") ||
          id === "group:viewer" ||
          id === "group:analysis" ||
          id === "group:contract",
      ),
    ).toBe(false);
    const paletteGroups = model.semanticGroups.filter(({ id }) =>
      id.startsWith("metric-color-complexity-"),
    );
    expect(paletteGroups.map(({ priority }) => priority)).toEqual([
      91, 92, 93, 94,
    ]);

    const assignments = assignSemanticGroups(
      createPrusaXLProfile([1, 2, 3, 4, 5]),
      model.semanticGroups,
    );
    const byId = new Map(
      assignments.map((assignment) => [
        assignment.semanticGroupId,
        assignment,
      ]),
    );
    for (const id of [
      "metric-color-complexity-moderate",
      "metric-color-complexity-high",
      "metric-color-complexity-very-high",
    ]) {
      expect(byId.get(id)?.mergedIntoSemanticGroupId).toBeUndefined();
    }
    expect(
      byId.get("metric-color-complexity-low")
        ?.mergedIntoSemanticGroupId,
    ).toBe("metric-color-complexity-moderate");
    expect(
      new Set(
        [
          "metric-color-complexity-moderate",
          "metric-color-complexity-high",
          "metric-color-complexity-very-high",
        ].map((id) => byId.get(id)?.channelId),
      ).size,
    ).toBe(3);
  });

  it("exposes a deterministic legend, provenance, and summary", () => {
    const mapping = customMapping();
    const legend = createMetricMappingLegend(mapping);
    const summary = summarizeMetricMapping(DEMO_MODEL, mapping);

    expect(legend.provenance).toContain("Focused deterministic");
    expect(legend.footprint.geometryFormula).toBe(
      "normalized-side-range-v1",
    );
    expect(legend.color.scale).toBe(
      "normalized-threshold-palette-v1",
    );
    expect(legend.color.palette.map(({ maximum }) => maximum)).toEqual([
      0.5, 1,
    ]);
    expect(summary.buildingCount).toBe(DEMO_MODEL.buildings.length);
    expect(
      Object.values(summary.paletteCounts).reduce(
        (total, count) => total + count,
        0,
      ),
    ).toBe(DEMO_MODEL.buildings.length);
    expect(inspectMetricMapping(DEMO_MODEL, mapping)).toEqual({
      legend,
      summary,
    });
  });

  it("supports cancellation without mutating the source", () => {
    const marker = new Error("cancel mapping");
    const sourceJson = JSON.stringify(DEMO_MODEL);
    let operations = 0;
    expect(() =>
      applyMetricMapping(DEMO_MODEL, customMapping(), {
        checkpoint(completed) {
          operations += completed;
          if (operations >= 2) throw marker;
        },
      }),
    ).toThrow(marker);
    expect(JSON.stringify(DEMO_MODEL)).toBe(sourceJson);
  });

  it("adds required structural groups for a valid base-less model", () => {
    const group = {
      id: "files",
      label: "Files",
      color: "#64748B",
      priority: 1,
    } as const;
    const baseLess = validateCityModel({
      ...DEMO_MODEL,
      semanticGroups: [group],
      identity: undefined,
      identityPanel: undefined,
      base: undefined,
      buildings: DEMO_MODEL.buildings.map((building) => ({
        ...building,
        semanticGroupId: group.id,
      })),
    }) as CityModel;

    const projected = applyMetricMapping(
      baseLess,
      DEFAULT_VERSIONED_METRIC_MAPPING,
    );
    expect(projected.base).toBeDefined();
    expect(projected.semanticGroups.some(({ id }) => id === "base")).toBe(
      true,
    );
  });

  it("preserves additive entity metadata while replacing canonical layout fields", () => {
    const canonical = applyMetricMapping(
      DEMO_MODEL,
      DEFAULT_VERSIONED_METRIC_MAPPING,
    );
    expect(canonical.buildings[0]?.metricNormalization).toBeDefined();
    const extended = validateCityModel({
      ...canonical,
      extensionSentinel: "root",
      identity: {
        ...canonical.identity!,
        extensionSentinel: "identity",
      },
      identityPanel: {
        ...canonical.identityPanel!,
        extensionSentinel: "identity-panel",
      },
      base: {
        ...canonical.base!,
        extensionSentinel: "base",
      },
      districts: canonical.districts.map((district, index) => ({
        ...district,
        ...(index === 0
          ? { extensionSentinel: "district" }
          : {}),
      })),
      buildings: canonical.buildings.map((building, index) => ({
        ...building,
        ...(index === 0
          ? {
              sourceNavigation: {
                relativePath: building.path,
                symbol: "future-field",
              },
            }
          : {}),
      })),
    });

    const projected = applyMetricMapping(extended, customMapping());
    const projectedRecord = projected as unknown as Record<
      string,
      unknown
    >;
    const identityRecord = projected.identity as unknown as Record<
      string,
      unknown
    >;
    const panelRecord = projected.identityPanel as unknown as Record<
      string,
      unknown
    >;
    const baseRecord = projected.base as unknown as Record<string, unknown>;
    const districtRecord = projected.districts[0] as unknown as Record<
      string,
      unknown
    >;
    const buildingRecord = projected.buildings[0] as unknown as Record<
      string,
      unknown
    >;

    expect(projectedRecord["extensionSentinel"]).toBe("root");
    expect(identityRecord["extensionSentinel"]).toBe("identity");
    expect(panelRecord["extensionSentinel"]).toBe("identity-panel");
    expect(baseRecord["extensionSentinel"]).toBe("base");
    expect(districtRecord["extensionSentinel"]).toBe("district");
    expect(buildingRecord["sourceNavigation"]).toEqual({
      relativePath: canonical.buildings[0]!.path,
      symbol: "future-field",
    });
    expect(
      Object.prototype.hasOwnProperty.call(
        buildingRecord,
        "metricNormalization",
      ),
    ).toBe(false);
    expect(projected.buildings[0]!.size).not.toEqual(
      canonical.buildings[0]!.size,
    );
  });

  it("preserves structural route and external groups used by print geometry", () => {
    const routed = validateCityModel({
      ...DEMO_MODEL,
      buildings: DEMO_MODEL.buildings.map((building, index) => ({
        ...building,
        semanticGroupId: index === 0 ? "routes" : building.semanticGroupId,
      })),
    });
    const projected = applyMetricMapping(
      routed,
      DEFAULT_VERSIONED_METRIC_MAPPING,
    );

    expect(
      projected.semanticGroups.some(({ id }) => id === "routes"),
    ).toBe(true);
    expect(
      projected.semanticGroups.some(({ id }) => id === "external"),
    ).toBe(true);
    expect(() =>
      assignSemanticGroups(
        createPrusaXLProfile([1, 2, 3, 4, 5]),
        projected.semanticGroups,
      ),
    ).not.toThrow();
  });
});
