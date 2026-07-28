import { describe, expect, it } from "vitest";

import {
  DEFAULT_FOG_DENSITY,
  fogDensityForCameraDistance,
  MINIMUM_TARGET_TRANSMITTANCE,
} from "../apps/viewer/src/scene-environment.js";

describe("viewer scene environment", () => {
  it("keeps the demo fog density for small scenes", () => {
    expect(fogDensityForCameraDistance(54)).toBe(DEFAULT_FOG_DENSITY);
  });

  it("keeps a FLOW-sized city visible at the framing target", () => {
    const distance = 2_815.94;
    const density = fogDensityForCameraDistance(distance);
    const transmittance = Math.exp(-((density * distance) ** 2));

    expect(density).toBeCloseTo(0.000_168, 6);
    expect(transmittance).toBeCloseTo(
      MINIMUM_TARGET_TRANSMITTANCE,
      12,
    );
  });

  it("adapts while the camera zooms away from a large city", () => {
    const initialDistance = 2_815.94;
    const densities = [1, 2, 5].map((zoom) => {
      const distance = initialDistance * zoom;
      const density = fogDensityForCameraDistance(distance);
      const transmittance = Math.exp(-((density * distance) ** 2));

      expect(transmittance).toBeCloseTo(
        MINIMUM_TARGET_TRANSMITTANCE,
        12,
      );
      return density;
    });

    expect(densities[2]).toBeLessThan(densities[0]!);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "falls back safely for an invalid distance %s",
    (distance) => {
      expect(fogDensityForCameraDistance(distance)).toBe(
        DEFAULT_FOG_DENSITY,
      );
    },
  );
});
