import { describe, expect, it } from "vitest";

import { groundGridLayout } from "../apps/viewer/src/scene-grid.js";

describe("groundGridLayout", () => {
  it("centers the grid on offset city bounds", () => {
    const layout = groundGridLayout({
      minX: 100,
      maxX: 160,
      minZ: -20,
      maxZ: 20,
    });

    expect(layout).toEqual({
      centerX: 130,
      centerZ: 0,
      size: 70,
      divisions: 35,
    });
  });

  it("contains the complete footprint with padding on every side", () => {
    const bounds = {
      minX: -13.5,
      maxX: 72.25,
      minZ: 40,
      maxZ: 59,
    };
    const layout = groundGridLayout(bounds);
    const halfSize = layout.size * 0.5;

    expect(layout.centerX - halfSize).toBeLessThan(bounds.minX);
    expect(layout.centerX + halfSize).toBeGreaterThan(bounds.maxX);
    expect(layout.centerZ - halfSize).toBeLessThan(bounds.minZ);
    expect(layout.centerZ + halfSize).toBeGreaterThan(bounds.maxZ);
  });

  it("keeps tiny and empty footprints useful", () => {
    expect(
      groundGridLayout({
        minX: 8,
        maxX: 8,
        minZ: -4,
        maxZ: -4,
      }),
    ).toEqual({
      centerX: 8,
      centerZ: -4,
      size: 20,
      divisions: 20,
    });
  });

  it("caps line density for very large cities", () => {
    const layout = groundGridLayout({
      minX: -2_500,
      maxX: 2_500,
      minZ: -500,
      maxZ: 500,
    });

    expect(layout.size).toBe(5_032);
    expect(layout.divisions).toBe(64);
  });

  it("changes only the center when bounds are translated", () => {
    const original = groundGridLayout({
      minX: -10,
      maxX: 50,
      minZ: -20,
      maxZ: 20,
    });
    const translated = groundGridLayout({
      minX: 990,
      maxX: 1_050,
      minZ: -520,
      maxZ: -480,
    });

    expect(translated).toEqual({
      ...original,
      centerX: original.centerX + 1_000,
      centerZ: original.centerZ - 500,
    });
  });

  it("rejects invalid bounds", () => {
    expect(() =>
      groundGridLayout({
        minX: Number.NaN,
        maxX: 1,
        minZ: 0,
        maxZ: 1,
      }),
    ).toThrow(RangeError);
    expect(() =>
      groundGridLayout({
        minX: 2,
        maxX: 1,
        minZ: 0,
        maxZ: 1,
      }),
    ).toThrow(RangeError);
  });
});
