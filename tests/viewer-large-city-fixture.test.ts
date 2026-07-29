import { describe, expect, it } from "vitest";

import {
  createLargeCityFixture,
  LARGE_CITY_BUILDING_COUNT,
  LARGE_CITY_DISTRICT_COUNT,
  LARGE_CITY_VISUAL_STYLE_COUNT,
} from "../apps/viewer/src/large-city-fixture.js";
import { validateCityModel } from "../apps/viewer/src/model-validation.js";

describe("large city performance fixture", () => {
  it("is deterministic, valid, and reaches the public renderer budget", () => {
    const first = createLargeCityFixture();
    const second = createLargeCityFixture();

    expect(first).toEqual(second);
    expect(first.buildings).toHaveLength(LARGE_CITY_BUILDING_COUNT);
    expect(first.districts).toHaveLength(LARGE_CITY_DISTRICT_COUNT);
    expect(
      new Set(first.buildings.map(({ semanticGroupId }) => semanticGroupId))
        .size,
    ).toBe(LARGE_CITY_VISUAL_STYLE_COUNT);
    expect(first.dependencies).toEqual([]);
    expect(validateCityModel(first)).toEqual(first);
  });
});
