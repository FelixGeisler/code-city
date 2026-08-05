import { describe, expect, it } from "vitest";

import { createSingleChannelProfile } from "../packages/core/src/printer-profiles.js";
import {
  applyMetricMapping,
  DEFAULT_VERSIONED_METRIC_MAPPING,
} from "../packages/core/src/index.js";
import { DEMO_MODEL } from "../apps/viewer/src/demo-model.js";
import {
  availableViewerVisualizationModes,
  createViewerVisualization,
  describeBuildingMetrics,
  presentBuildingMetrics,
} from "../apps/viewer/src/visualization-mode.js";

describe("viewer visualization modes", () => {
  it("only offers modes backed by the current project context", () => {
    expect(
      availableViewerVisualizationModes({
        evolution: false,
        printProfile: false,
      }),
    ).toEqual(["semantic", "complexity"]);
    expect(
      availableViewerVisualizationModes({
        evolution: true,
        printProfile: false,
      }),
    ).toEqual(["semantic", "complexity", "age", "churn"]);
    expect(
      availableViewerVisualizationModes({
        evolution: false,
        printProfile: true,
      }),
    ).toEqual(["semantic", "complexity", "print"]);
  });

  it("uses persisted risk metadata without reclassifying metrics", () => {
    const model = {
      ...DEMO_MODEL,
      buildings: DEMO_MODEL.buildings.map((building, index) =>
        index === 0
          ? {
              ...building,
              risk: "low" as const,
              metrics: { ...building.metrics, maximumComplexity: 999 },
            }
          : building,
      ),
    };

    const view = createViewerVisualization(model, "complexity");

    expect(view.colorsByBuildingId.get(model.buildings[0]!.id)).toBe(
      "#4ade80",
    );
    expect(view.status).toMatch(/persisted risk band/iu);
    expect(view.legend.map(({ label }) => label)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/0–5/u),
        expect.stringMatching(/21\+/u),
      ]),
    );
  });

  it("previews assignments and explicitly reports fallback colors", () => {
    const profile = createSingleChannelProfile();

    const view = createViewerVisualization(DEMO_MODEL, "print", profile);

    expect(view.available).toBe(true);
    expect(new Set(view.colorsByBuildingId.values()).size).toBe(1);
    expect(view.status).toMatch(/does not claim printability/iu);
    expect(view.status).toMatch(/fallback colors/iu);
  });

  it("makes an invalid or pending print profile unavailable", () => {
    const view = createViewerVisualization(DEMO_MODEL, "print");

    expect(view.available).toBe(false);
    expect(view.status).toMatch(/choose a valid printer profile/iu);
  });

  it("renders repository age and churn only when evolution facts exist", () => {
    const firstId = DEMO_MODEL.buildings[0]!.id;
    const unavailable = createViewerVisualization(DEMO_MODEL, "age");
    const data = {
      ageByBuildingId: new Map([[firstId, 9]]),
      churnByBuildingId: new Map([[firstId, 4]]),
    };
    const age = createViewerVisualization(
      DEMO_MODEL,
      "age",
      undefined,
      data,
    );
    const churn = createViewerVisualization(
      DEMO_MODEL,
      "churn",
      undefined,
      data,
    );

    expect(unavailable.available).toBe(false);
    expect(age.available).toBe(true);
    expect(churn.available).toBe(true);
    expect(age.colorsByBuildingId.get(firstId)).not.toBe("#94a3b8");
    expect(churn.colorsByBuildingId.get(firstId)).not.toBe("#94a3b8");
  });

  it("puts plain footprint, height, color, and analyzer meanings first", () => {
    const presentation = presentBuildingMetrics(
      DEMO_MODEL,
      DEMO_MODEL.buildings[0]!,
    );

    expect(presentation.buildingId).toBe(DEMO_MODEL.buildings[0]!.id);
    expect(presentation.rows.map(({ label }) => label)).toEqual([
      "Footprint",
      "Height",
      "Color",
      "Measured with",
    ]);
    expect(presentation.rows[0]).toMatchObject({
      value: expect.stringMatching(/SLOC/iu),
      description: expect.stringMatching(/width and depth/iu),
    });
    expect(presentation.rows[1]).toMatchObject({
      value: expect.stringMatching(/decision points/iu),
      description: expect.stringMatching(/tall/iu),
    });
    expect(presentation.rows[2]).toMatchObject({
      value: expect.stringMatching(/CC \d+/u),
      description: expect.stringMatching(/color band/iu),
    });
    expect(presentation.rows[3]?.value).not.toMatch(/-v\d/iu);
    expect(presentation.technical.map(({ label }) => label)).toEqual(
      expect.arrayContaining([
        "Analyzer ID",
        "Raw facts",
        "Formula IDs",
        "Normalization",
        "Mapping provenance",
      ]),
    );
  });

  it("labels legacy normalization states as schema-default derivations", () => {
    const {
      metricNormalization: _normalization,
      ...building
    } = DEMO_MODEL.buildings[0]!;
    const {
      metricMapping: _mapping,
      buildings: _buildings,
      ...modelWithoutMetricExtensions
    } = DEMO_MODEL;
    const model = {
      ...modelWithoutMetricExtensions,
      buildings: [building],
    };

    const explanation = describeBuildingMetrics(model, building);

    expect(explanation).toMatch(
      /(?:available|clamped) \(derived from the schema-default mapping\)/iu,
    );
    expect(explanation).not.toMatch(/unavailable \(legacy derivation\)/iu);
  });

  it("turns a clamped Roslyn metric dump into readable drawing guidance", () => {
    const mapped = applyMetricMapping(
      DEMO_MODEL,
      DEFAULT_VERSIONED_METRIC_MAPPING,
    );
    const building = {
      ...mapped.buildings[0]!,
      language: "csharp" as const,
      metricMethod: "csharp-roslyn-v1" as const,
      metrics: {
        sloc: 742,
        decisionLoad: 110,
        maximumComplexity: 47,
        executableUnitCount: 53,
      },
      risk: "very-high" as const,
    };
    const presentation = presentBuildingMetrics(
      { ...mapped, buildings: [building] },
      building,
    );

    expect(presentation.rows).toEqual([
      expect.objectContaining({
        label: "Footprint",
        value: "742 SLOC",
        state: "available",
      }),
      expect.objectContaining({
        label: "Height",
        value: "110 decision points",
        state: "clamped",
        description: expect.stringMatching(/above 100.*display maximum/iu),
      }),
      expect.objectContaining({
        label: "Color",
        value: expect.stringMatching(/^CC 47 · Very high complexity$/u),
        state: "clamped",
        description: expect.stringMatching(/above 25.*display maximum/iu),
      }),
      expect.objectContaining({
        label: "Measured with",
        value: "Roslyn analysis (C#)",
      }),
    ]);
    expect(JSON.stringify(presentation.rows)).not.toMatch(
      /csharp-roslyn-v1|log1p-cap-v1|normalized-height-range-v1/u,
    );
    expect(JSON.stringify(presentation.technical)).toMatch(
      /csharp-roslyn-v1.*log1p-cap-v1.*normalized-height-range-v1/su,
    );
  });

  it("explains selected versioned channels, normalized values, geometry, color scale, and provenance", () => {
    const model = applyMetricMapping(
      DEMO_MODEL,
      DEFAULT_VERSIONED_METRIC_MAPPING,
    );
    const building = model.buildings[0]!;
    const explanation = describeBuildingMetrics(model, building);
    const presentation = presentBuildingMetrics(model, building);
    const semantic = createViewerVisualization(model, "semantic");

    expect(explanation).toMatch(/Footprint channel: sloc: raw \d+/iu);
    expect(explanation).toMatch(/normalized \d+\.\d{4}/iu);
    expect(explanation).toMatch(/(?:available|clamped)/iu);
    expect(explanation).toMatch(/log1p-cap-v1/iu);
    expect(explanation).toMatch(/missing error/iu);
    expect(explanation).toMatch(/normalized-side-range-v1/iu);
    expect(explanation).toMatch(/normalized-height-range-v1/iu);
    expect(explanation).toMatch(/normalized-threshold-palette-v1/iu);
    expect(explanation).toMatch(/Mapping provenance: Complexity/iu);
    expect(presentation.rows.map(({ label }) => label)).toEqual([
      "Footprint",
      "Height",
      "Color",
      "Measured with",
    ]);
    expect(presentation.rows[0]?.description).toMatch(
      /width and depth/iu,
    );
    expect(presentation.rows[2]?.value).toMatch(/complexity/iu);
    expect(presentation.technical[0]).toEqual({
      label: "Analyzer ID",
      value: building.metricMethod ?? "not recorded",
    });
    expect(
      semantic.colorsByBuildingId.get(building.id),
    ).not.toBe("#94a3b8");
  });
});
