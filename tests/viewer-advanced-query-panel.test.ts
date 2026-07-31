import { describe, expect, it } from "vitest";

import {
  boundedAdvancedComparisonBuildings,
  MAXIMUM_ADVANCED_COMPARISON_ROWS,
  retainsAdvancedQueryProjectContext,
} from "../apps/viewer/src/advanced-query-panel.js";
import { DEMO_MODEL } from "../apps/viewer/src/demo-model.js";
import { metricMappingProjectIdentity } from "../apps/viewer/src/metric-mapping-storage.js";
import type { CityBuilding } from "../packages/core/src/model.js";

describe("advanced-query comparison", () => {
  it("keeps per-building rows ordered and globally bounded", () => {
    const buildings = Array.from(
      { length: MAXIMUM_ADVANCED_COMPARISON_ROWS + 25 },
      (_, index) =>
        ({
          id: `building:${index}`,
          name: `File${index}.ts`,
        }) as CityBuilding,
    );

    const rows = boundedAdvancedComparisonBuildings(buildings);

    expect(rows).toHaveLength(MAXIMUM_ADVANCED_COMPARISON_ROWS);
    expect(rows[0]?.id).toBe("building:0");
    expect(rows.at(-1)?.id).toBe(
      `building:${MAXIMUM_ADVANCED_COMPARISON_ROWS - 1}`,
    );
    expect(Object.isFrozen(rows)).toBe(true);
    expect(buildings).toHaveLength(
      MAXIMUM_ADVANCED_COMPARISON_ROWS + 25,
    );
  });

  it("retains explicit evolution continuity across topology changes", () => {
    const currentIdentity =
      metricMappingProjectIdentity(DEMO_MODEL);
    const topologyChanged = {
      ...DEMO_MODEL,
      modules: DEMO_MODEL.modules.slice(0, -1),
    };
    const changedIdentity =
      metricMappingProjectIdentity(topologyChanged);

    expect(
      retainsAdvancedQueryProjectContext(
        currentIdentity,
        currentIdentity,
      ),
    ).toBe(true);
    expect(
      retainsAdvancedQueryProjectContext(
        currentIdentity,
        changedIdentity,
      ),
    ).toBe(false);
    expect(
      retainsAdvancedQueryProjectContext(
        currentIdentity,
        changedIdentity,
        true,
      ),
    ).toBe(true);
  });
});
