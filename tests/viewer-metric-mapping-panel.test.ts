import { describe, expect, it } from "vitest";

import {
  DEFAULT_VERSIONED_METRIC_MAPPING,
  type MetricMappingDefinitionV1,
} from "../packages/core/src/index.js";
import {
  formatMetricMappingNumber,
  metricColorLegendRangeText,
  metricMappingWithChannels,
  namedMetricMappingDefinition,
  unnamedMetricMappingDefinition,
} from "../apps/viewer/src/metric-mapping-panel.js";

describe("viewer metric mapping panel drafts", () => {
  it("keeps tiny valid caps and exclusive palette ranges inspectable", () => {
    expect(formatMetricMappingNumber(0.000001)).toBe("0.000001");
    expect(formatMetricMappingNumber(0.0000001)).toBe("1e-7");
    expect(
      metricColorLegendRangeText(0, 0, 0, "linear-cap-v1", 100),
    ).toBe("raw ≤ 0");
    expect(
      metricColorLegendRangeText(1, 0, 0.5, "linear-cap-v1", 100),
    ).toBe("n > 0 and ≤ 0.5");
  });

  it("drops a saved configuration identity after an unsaved control edit", () => {
    const saved = {
      ...structuredClone(DEFAULT_VERSIONED_METRIC_MAPPING),
      id: "team-print",
      name: "Team print",
      provenance: {
        kind: "custom",
        description: "Project-scoped saved Team print configuration.",
      },
    } satisfies MetricMappingDefinitionV1;
    const edited = {
      ...saved,
      channels: {
        ...saved.channels,
        footprint: {
          ...saved.channels.footprint,
          normalization: {
            ...saved.channels.footprint.normalization,
            cap: 777,
          },
        },
      },
    } satisfies MetricMappingDefinitionV1;

    const dirty = unnamedMetricMappingDefinition(edited);

    expect(dirty).toMatchObject({
      id: "custom-mapping",
      name: "Custom",
      provenance: {
        kind: "custom",
        description: expect.stringMatching(/derived/iu),
      },
      channels: {
        footprint: {
          normalization: { cap: 777 },
        },
      },
    });
    expect(saved).toMatchObject({
      id: "team-print",
      name: "Team print",
      channels: {
        footprint: {
          normalization: {
            cap: DEFAULT_VERSIONED_METRIC_MAPPING.channels.footprint
              .normalization.cap,
          },
        },
      },
    });
  });

  it("preserves additive future peer channels during control reconstruction", () => {
    const futureMaterial = {
      formula: "future-material-v1",
      source: "ownership",
    };
    const extended = {
      ...structuredClone(DEFAULT_VERSIONED_METRIC_MAPPING),
      provenance: {
        ...structuredClone(
          DEFAULT_VERSIONED_METRIC_MAPPING.provenance,
        ),
        catalogVersion: 2,
      },
      channels: {
        ...structuredClone(DEFAULT_VERSIONED_METRIC_MAPPING.channels),
        material: futureMaterial,
      },
    } as MetricMappingDefinitionV1 & {
      readonly provenance: MetricMappingDefinitionV1["provenance"] & {
        readonly catalogVersion: number;
      };
      readonly channels: MetricMappingDefinitionV1["channels"] & {
        readonly material: typeof futureMaterial;
      };
    };
    const editedFootprint = {
      ...extended.channels.footprint,
      normalization: {
        ...extended.channels.footprint.normalization,
        cap: 777,
      },
    };

    const reconstructed = metricMappingWithChannels(extended, {
      footprint: editedFootprint,
      height: extended.channels.height,
      color: extended.channels.color,
    });
    const dirty = unnamedMetricMappingDefinition(reconstructed);
    const named = namedMetricMappingDefinition(dirty, "Future aware");
    const channels = dirty.channels as typeof extended.channels;
    const dirtyProvenance =
      dirty.provenance as typeof extended.provenance;
    const namedProvenance =
      named.provenance as typeof extended.provenance;

    expect(channels.footprint.normalization.cap).toBe(777);
    expect(channels.material).toEqual(futureMaterial);
    expect(channels).not.toBe(extended.channels);
    expect(dirtyProvenance.catalogVersion).toBe(2);
    expect(namedProvenance.catalogVersion).toBe(2);
    expect(named).toMatchObject({
      id: "custom-future-aware",
      name: "Future aware",
      provenance: {
        kind: "custom",
        description: expect.stringContaining("Future aware"),
      },
    });
  });
});
