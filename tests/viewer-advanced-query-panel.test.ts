import { describe, expect, it } from "vitest";

import {
  boundedAdvancedComparisonBuildings,
  MAXIMUM_ADVANCED_COMPARISON_ROWS,
} from "../apps/viewer/src/advanced-query-panel.js";
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
});
