import { describe, expect, it } from "vitest";

import {
  LEGACY_CITY_BASE_HEIGHT,
  cityBaseForModel,
} from "../apps/viewer/src/city-surface.js";
import { DEMO_MODEL } from "../apps/viewer/src/demo-model.js";
import type { CityDistrict } from "../packages/core/src/model.js";

function district(
  id: string,
  x: number,
  z: number,
): CityDistrict {
  return {
    id,
    repositoryId: "repository",
    moduleId: `module:${id}`,
    name: id,
    path: id,
    position: { x, y: 0.5, z },
    size: { x: 4, y: 1, z: 4 },
  };
}

describe("viewer city surface", () => {
  it("uses explicit shared-base geometry unchanged", () => {
    expect(cityBaseForModel(DEMO_MODEL)).toBe(DEMO_MODEL.base);
  });

  it("derives a legacy base across negative coordinates and panel relief", () => {
    const {
      base: _base,
      ...legacyModel
    } = DEMO_MODEL;
    const base = cityBaseForModel(legacyModel)!;

    expect(base.semanticGroupId).toBe("base");
    expect(base.position).toMatchObject({
      x: -0.5,
      y: LEGACY_CITY_BASE_HEIGHT / 2,
    });
    expect(base.position.z).toBeCloseTo(-0.98, 12);
    expect(base.size).toMatchObject({
      x: 31,
      y: LEGACY_CITY_BASE_HEIGHT,
    });
    expect(base.size.z).toBeCloseTo(13.96, 12);
    expect(base.position.z - base.size.z / 2).toBeCloseTo(-7.96, 12);
  });

  it("fills the configured gap between legacy districts as a road", () => {
    const left = district("left", 0, 0);
    const right = district("right", 10, 0);
    const base = cityBaseForModel({
      districts: [left, right],
    })!;
    const roadX = 5;

    expect(base.position).toEqual({ x: 5, y: 0.25, z: 0 });
    expect(base.size).toEqual({ x: 14, y: 0.5, z: 4 });
    expect(
      Math.abs(roadX - base.position.x) <= base.size.x / 2,
    ).toBe(true);
    for (const parcel of [left, right]) {
      expect(
        Math.abs(roadX - parcel.position.x) < parcel.size.x / 2,
      ).toBe(false);
    }
  });

  it("does not invent a base for an empty legacy model", () => {
    expect(cityBaseForModel({ districts: [] })).toBeUndefined();
  });
});
