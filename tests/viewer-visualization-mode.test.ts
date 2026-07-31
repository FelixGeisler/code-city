import { describe, expect, it } from "vitest";

import { createSingleChannelProfile } from "../packages/core/src/printer-profiles.js";
import {
  applyMetricMapping,
  DEFAULT_VERSIONED_METRIC_MAPPING,
} from "../packages/core/src/index.js";
import { DEMO_MODEL } from "../apps/viewer/src/demo-model.js";
import {
  createViewerVisualization,
  describeBuildingMetrics,
} from "../apps/viewer/src/visualization-mode.js";

describe("viewer visualization modes", () => {
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

  it("explains raw facts, formula provenance, caps, and states", () => {
    const explanation = describeBuildingMetrics(
      DEMO_MODEL,
      DEMO_MODEL.buildings[0]!,
    );

    expect(explanation).toMatch(/Raw SLOC/iu);
    expect(explanation).toMatch(/executable units/iu);
    expect(explanation).toMatch(/Formula IDs/iu);
    expect(explanation).toMatch(/Normalization caps/iu);
    expect(explanation).toMatch(/Normalization state/iu);
    expect(explanation).toMatch(/Mapping provenance/iu);
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

  it("explains selected versioned channels, normalized values, geometry, color scale, and provenance", () => {
    const model = applyMetricMapping(
      DEMO_MODEL,
      DEFAULT_VERSIONED_METRIC_MAPPING,
    );
    const building = model.buildings[0]!;
    const explanation = describeBuildingMetrics(model, building);
    const semantic = createViewerVisualization(model, "semantic");

    expect(explanation).toMatch(/footprint sloc raw \d+/iu);
    expect(explanation).toMatch(/normalized \d+\.\d{4}/iu);
    expect(explanation).toMatch(/(?:available|clamped)/iu);
    expect(explanation).toMatch(/log1p-cap-v1/iu);
    expect(explanation).toMatch(/missing error/iu);
    expect(explanation).toMatch(/normalized-side-range-v1/iu);
    expect(explanation).toMatch(/normalized-height-range-v1/iu);
    expect(explanation).toMatch(/normalized-threshold-palette-v1/iu);
    expect(explanation).toMatch(/Mapping provenance: Complexity/iu);
    expect(
      semantic.colorsByBuildingId.get(building.id),
    ).not.toBe("#94a3b8");
  });
});
