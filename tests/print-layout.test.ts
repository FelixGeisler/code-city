import { describe, expect, it } from "vitest";

import {
  PrintLayoutError,
  createPrusaXLProfile,
  createSingleChannelProfile,
  planPrintLayout,
  type PrintLayoutBounds,
  type PrintLayoutDistrictInput,
  type PrintLayoutFeatureMeasurements,
  type PrintLayoutTransform,
  type PrinterProfile,
  type Vector3,
} from "../packages/core/src/index.js";

const features: PrintLayoutFeatureMeasurements = {
  wallThickness: 1,
  gap: 1,
  minimumFeatureSize: 1,
  baseThickness: 1,
  labelStrokeWidth: 1,
  raisedFeatureHeight: 1,
  recessedFeatureDepth: 1,
  routeWidth: 1,
  connectorWidth: 1,
};

function profile(
  buildVolume: Vector3 = { x: 60, y: 30, z: 45 },
  margins: Vector3 = { x: 0, y: 0, z: 0 },
): PrinterProfile {
  return createSingleChannelProfile({
    buildVolume,
    geometryLimits: {
      minimumWallThickness: 1,
      minimumGap: 1,
      minimumFeatureSize: 1,
      minimumBaseThickness: 1,
      nozzleDiameter: 1,
      lineWidth: 1,
      buildMargins: margins,
      minimumRaisedFeatureHeight: 1,
      minimumRecessedFeatureDepth: 1,
      minimumLabelStrokeWidth: 1,
      minimumRouteWidth: 1,
      maximumModelHeight: buildVolume.y - margins.y * 2,
    },
  });
}

function bounds(
  width: number,
  height: number,
  depth: number,
  minimum: Vector3 = { x: 0, y: 0, z: 0 },
): PrintLayoutBounds {
  return {
    minimum,
    maximum: {
      x: minimum.x + width,
      y: minimum.y + height,
      z: minimum.z + depth,
    },
  };
}

function district(
  id: string,
  width: number,
  depth: number,
  height = 5,
  minimum?: Vector3,
): PrintLayoutDistrictInput {
  return {
    id,
    name: `District ${id}`,
    sourceBounds: bounds(width, height, depth, minimum),
    channelIds: ["channel-1"],
  };
}

function transformPoint(
  point: Vector3,
  transform: PrintLayoutTransform,
): Vector3 {
  const { scale, rotation, translation } = transform;
  return rotation === 0
    ? {
        x: point.x * scale + translation.x,
        y: point.y * scale + translation.y,
        z: point.z * scale + translation.z,
      }
    : {
        x: -point.z * scale + translation.x,
        y: point.y * scale + translation.y,
        z: point.x * scale + translation.z,
      };
}

describe("deterministic physical print layout", () => {
  it("creates a compact, attached two-digit plate marker for an empty city", () => {
    const plan = planPrintLayout(profile(), {
      features,
      districts: [],
    });

    expect(plan.fitPolicy).toBe("error");
    expect(plan.plates).toHaveLength(1);
    expect(plan.plates[0]).toMatchObject({
      id: "plate-01",
      dimensions: { x: 10, y: 2, z: 9 },
      base: { size: { x: 10, y: 1, z: 9 } },
      reservations: [
        {
          kind: "plate-number",
          label: "01",
          plateId: "plate-01",
        },
      ],
    });
  });

  it("keeps an exporter-measured identity envelope fixed in physical millimetres", () => {
    const plan = planPrintLayout(
      profile({ x: 65, y: 30, z: 50 }),
      {
        requestedScale: 3,
        features: {
          ...features,
          wallThickness: 1 / 3,
          gap: 1 / 3,
          minimumFeatureSize: 1 / 3,
          baseThickness: 1 / 3,
          labelStrokeWidth: 1 / 3,
          raisedFeatureHeight: 1 / 3,
          recessedFeatureDepth: 1 / 3,
          routeWidth: 1 / 3,
          connectorWidth: 1 / 3,
        },
        identity: {
          id: "physical-identity",
          sourceBounds: bounds(39.2, 3, 5),
          scaleMode: "physical",
        },
        districts: [],
      },
    );

    const identity = plan.plates[0]!.reservations.find(
      ({ kind }) => kind === "identity",
    )!;
    expect(identity.bounds.maximum.x - identity.bounds.minimum.x).toBe(
      39.2,
    );
    expect(identity.transform?.scale).toBe(1);
    expect(plan.plates[0]!.base.size.x).toBeLessThan(65);
  });

  it("scales shared and district foundations normally above their profile floors", () => {
    const plan = planPrintLayout(
      profile({ x: 80, y: 50, z: 60 }),
      {
        requestedScale: 3,
        features: { ...features, baseThickness: 0.4 },
        districts: [
          {
            ...district("founded", 4, 4, 4),
            sourceFoundationThickness: 0.4,
          },
        ],
      },
    );

    const placement = plan.plates[0]!.districts[0]!;
    expect(plan.plates[0]!.base.size.y).toBeCloseTo(1.2, 12);
    expect(placement.foundationThickness).toBeCloseTo(1.2, 12);
    expect(placement.foundationLift).toBe(0);
    expect(
      placement.bounds.maximum.y - placement.bounds.minimum.y,
    ).toBe(12);
    expect(
      transformPoint(placement.sourceBounds.minimum, placement.transform).y,
    ).toBe(placement.bounds.minimum.y);
  });

  it("clamps thin physical foundations and lifts uniformly scaled contents", () => {
    const scale = 0.4;
    const safeFeatures: PrintLayoutFeatureMeasurements = {
      wallThickness: 2.5,
      gap: 2.5,
      minimumFeatureSize: 2.5,
      baseThickness: 1,
      labelStrokeWidth: 2.5,
      raisedFeatureHeight: 2.5,
      recessedFeatureDepth: 2.5,
      routeWidth: 2.5,
      connectorWidth: 2.5,
    };
    const plan = planPrintLayout(profile({ x: 30, y: 20, z: 30 }), {
      requestedScale: scale,
      features: safeFeatures,
      districts: [
        {
          ...district("founded", 5, 5, 5, { x: 10, y: 2, z: 20 }),
          sourceFoundationThickness: 1,
        },
      ],
    });

    const plate = plan.plates[0]!;
    const placement = plate.districts[0]!;
    expect(plan.minimumSafeScale).toBe(scale);
    expect(plan.featureViolations).toEqual([]);
    expect(plate.base.size.y).toBe(1);
    expect(placement.foundationThickness).toBe(1);
    expect(placement.foundationLift).toBeCloseTo(0.6, 12);
    expect(placement.bounds.minimum.y).toBe(1);
    expect(placement.bounds.maximum.y).toBeCloseTo(3.6, 12);

    const transformedSourceBottom = transformPoint(
      placement.sourceBounds.minimum,
      placement.transform,
    );
    expect(transformedSourceBottom.y).toBeCloseTo(1.6, 12);
    expect(
      transformPoint(
        {
          ...placement.sourceBounds.minimum,
          y: placement.sourceBounds.minimum.y + 1,
        },
        placement.transform,
      ).y,
    ).toBeCloseTo(
      placement.bounds.minimum.y + placement.foundationThickness,
      12,
    );
    expect(
      transformPoint(placement.sourceBounds.maximum, placement.transform).y,
    ).toBeCloseTo(placement.bounds.maximum.y, 12);
  });

  it("auto-fits a founded district while preserving physical foundation floors", () => {
    const plan = planPrintLayout(profile(), {
      fitPolicy: "scale",
      requestedScale: 1.6,
      features: {
        wallThickness: 2.5,
        gap: 2.5,
        minimumFeatureSize: 2.5,
        baseThickness: 1,
        labelStrokeWidth: 2.5,
        raisedFeatureHeight: 2.5,
        recessedFeatureDepth: 2.5,
        routeWidth: 2.5,
        connectorWidth: 2.5,
      },
      districts: [
        {
          ...district("auto-fit", 80, 40, 5, { x: 10, y: 2, z: 20 }),
          sourceFoundationThickness: 1,
        },
      ],
    });

    expect(plan.plates).toHaveLength(1);
    expect(plan.appliedScale).toBeLessThan(plan.requestedScale);
    expect(plan.appliedScale).toBeGreaterThanOrEqual(plan.minimumSafeScale);
    expect(plan.appliedScale).toBeLessThan(1);
    expect(plan.minimumSafeScale).toBe(0.4);
    expect(plan.featureViolations).toEqual([]);

    const plate = plan.plates[0]!;
    const placement = plate.districts[0]!;
    expect(plate.base.size.y).toBe(1);
    expect(placement.foundationThickness).toBe(1);
    expect(placement.foundationLift).toBeCloseTo(
      1 - plan.appliedScale,
      12,
    );
    expect(
      placement.bounds.maximum.y - placement.bounds.minimum.y,
    ).toBeCloseTo(1 + 4 * plan.appliedScale, 12);
    expect(
      transformPoint(
        {
          ...placement.sourceBounds.minimum,
          y: placement.sourceBounds.minimum.y + 1,
        },
        placement.transform,
      ).y,
    ).toBeCloseTo(
      placement.bounds.minimum.y + placement.foundationThickness,
      12,
    );
  });

  it("keeps base and district heights continuous at their clamp breakpoints", () => {
    const breakpoint = 2.5;
    const delta = 1e-6;
    const run = (scale: number) =>
      planPrintLayout(profile({ x: 80, y: 30, z: 60 }), {
        requestedScale: scale,
        features: {
          wallThickness: 10,
          gap: 10,
          minimumFeatureSize: 10,
          baseThickness: 0.4,
          labelStrokeWidth: 10,
          raisedFeatureHeight: 10,
          recessedFeatureDepth: 10,
          routeWidth: 10,
          connectorWidth: 10,
        },
        districts: [
          {
            ...district("breakpoint", 2, 2, 2),
            sourceFoundationThickness: 0.4,
          },
        ],
      });
    const below = run(breakpoint - delta);
    const exact = run(breakpoint);
    const above = run(breakpoint + delta);
    const districtHeight = (plan: ReturnType<typeof run>) => {
      const bounds = plan.plates[0]!.districts[0]!.bounds;
      return bounds.maximum.y - bounds.minimum.y;
    };

    expect(below.plates[0]!.base.size.y).toBe(1);
    expect(exact.plates[0]!.base.size.y).toBe(1);
    expect(above.plates[0]!.base.size.y).toBeCloseTo(
      0.4 * (breakpoint + delta),
      12,
    );
    expect(districtHeight(below)).toBeCloseTo(
      1 + 1.6 * (breakpoint - delta),
      12,
    );
    expect(districtHeight(exact)).toBe(5);
    expect(districtHeight(above)).toBeCloseTo(
      2 * (breakpoint + delta),
      12,
    );
  });

  it("accepts the exact adjusted height boundary and reports the same height below it", () => {
    const request = {
      fitPolicy: "tile" as const,
      requestedScale: 0.4,
      features: {
        wallThickness: 2.5,
        gap: 2.5,
        minimumFeatureSize: 2.5,
        baseThickness: 1,
        labelStrokeWidth: 2.5,
        raisedFeatureHeight: 2.5,
        recessedFeatureDepth: 2.5,
        routeWidth: 2.5,
        connectorWidth: 2.5,
      },
      districts: [
        {
          ...district("boundary", 5, 5, 5),
          sourceFoundationThickness: 1,
        },
      ],
    };
    const exact = planPrintLayout(
      profile({ x: 30, y: 3.6, z: 30 }),
      request,
    );
    expect(exact.plates[0]!.dimensions.y).toBeCloseTo(3.6, 12);

    try {
      planPrintLayout(
        profile({ x: 30, y: 3.6 - 2e-9, z: 30 }),
        request,
      );
      throw new Error("Expected adjusted district height to exceed the plate.");
    } catch (error) {
      expect(error).toBeInstanceOf(PrintLayoutError);
      expect((error as PrintLayoutError).issues[0]).toMatchObject({
        code: "district-does-not-fit",
        objectId: "boundary",
        required: { x: 2, y: 3.6, z: 2 },
      });
    }
  });

  it("uses custom base and raised-feature floors for physical foundations", () => {
    const customProfile = createSingleChannelProfile({
      buildVolume: { x: 30, y: 10, z: 30 },
      geometryLimits: {
        minimumWallThickness: 0.6,
        minimumGap: 0.5,
        minimumFeatureSize: 0.7,
        minimumBaseThickness: 0.8,
        nozzleDiameter: 0.4,
        lineWidth: 0.45,
        buildMargins: { x: 0, y: 0, z: 0 },
        minimumRaisedFeatureHeight: 1.3,
        minimumRecessedFeatureDepth: 0.6,
        minimumLabelStrokeWidth: 0.5,
        minimumRouteWidth: 0.7,
        maximumModelHeight: 10,
      },
    });
    const plan = planPrintLayout(customProfile, {
      requestedScale: 0.4,
      features: {
        wallThickness: 10,
        gap: 10,
        minimumFeatureSize: 10,
        baseThickness: 1,
        labelStrokeWidth: 10,
        raisedFeatureHeight: 10,
        recessedFeatureDepth: 10,
        routeWidth: 10,
        connectorWidth: 10,
      },
      districts: [
        {
          ...district("custom", 5, 5, 5),
          sourceFoundationThickness: 1,
        },
      ],
    });

    const placement = plan.plates[0]!.districts[0]!;
    expect(plan.minimumSafeScale).toBeCloseTo(0.13, 12);
    expect(plan.featureViolations).toEqual([]);
    expect(plan.plates[0]!.base.size.y).toBe(0.8);
    expect(placement.foundationThickness).toBe(1.3);
    expect(placement.foundationLift).toBeCloseTo(0.9, 12);
    expect(plan.plates[0]!.dimensions.y).toBeCloseTo(3.7, 12);
  });

  it("reports usable X/Y/Z spans and keeps every object attached to one continuous plate base", () => {
    const plan = planPrintLayout(
      profile({ x: 80, y: 35, z: 60 }, { x: 2, y: 3, z: 4 }),
      {
        requestedScale: 1,
        fitPolicy: "error",
        features,
        identity: {
          id: "identity",
          sourceBounds: bounds(18, 3, 6),
          channelIds: ["channel-1"],
        },
        districts: [
          district("a", 15, 12, 8, { x: 100, y: 4, z: 200 }),
          district("b", 10, 10),
        ],
      },
    );

    expect(plan.usableBuildBounds).toEqual({
      minimum: { x: 2, y: 3, z: 4 },
      maximum: { x: 78, y: 32, z: 56 },
    });
    expect(plan.usableBuildSpan).toEqual({ x: 76, y: 29, z: 52 });
    expect(plan.plates).toHaveLength(1);
    const plate = plan.plates[0]!;
    expect(plate.id).toBe("plate-01");
    expect(plate.base.size.y).toBe(1);
    expect(plate.reservations.map(({ kind }) => kind)).toEqual([
      "identity",
      "plate-number",
    ]);
    for (const item of [...plate.districts, ...plate.reservations]) {
      expect(item.bounds.minimum.y).toBe(plate.base.bounds.maximum.y);
      expect(item.bounds.minimum.x).toBeGreaterThanOrEqual(
        plate.base.bounds.minimum.x,
      );
      expect(item.bounds.maximum.x).toBeLessThanOrEqual(
        plate.base.bounds.maximum.x,
      );
      expect(item.bounds.minimum.z).toBeGreaterThanOrEqual(
        plate.base.bounds.minimum.z,
      );
      expect(item.bounds.maximum.z).toBeLessThanOrEqual(
        plate.base.bounds.maximum.z,
      );
    }
    expect(plate.utilization).toBeGreaterThan(0);
    expect(plate.utilization).toBeLessThanOrEqual(1);

    const placed = plate.districts.find(
      ({ districtId }) => districtId === "a",
    )!;
    const source = placed.sourceBounds;
    const first = transformPoint(source.minimum, placed.transform);
    expect(first.y).toBe(placed.bounds.minimum.y);
    if (placed.transform.rotation === 0) {
      expect(first.x).toBe(placed.bounds.minimum.x);
      expect(first.z).toBe(placed.bounds.minimum.z);
    } else {
      const rotatedMinimum = transformPoint(
        {
          x: source.minimum.x,
          y: source.minimum.y,
          z: source.maximum.z,
        },
        placed.transform,
      );
      expect(rotatedMinimum.x).toBe(placed.bounds.minimum.x);
      expect(rotatedMinimum.z).toBe(placed.bounds.minimum.z);
    }
  });

  it("is independent of district input order and uses stable 90-degree rotation", () => {
    const request = {
      fitPolicy: "tile" as const,
      requestedScale: 1,
      features,
      districts: [
        district("rotated", 15, 31),
        district("square", 18, 18),
        district("small", 8, 8),
      ],
    };
    const first = planPrintLayout(
      profile({ x: 45, y: 30, z: 30 }),
      request,
    );
    const second = planPrintLayout(
      profile({ x: 45, y: 30, z: 30 }),
      {
        ...request,
        districts: [...request.districts].reverse(),
      },
    );

    expect(second).toEqual(first);
    const rotated = first.plates
      .flatMap(({ districts }) => districts)
      .find(({ districtId }) => districtId === "rotated")!;
    expect(rotated.transform.rotation).toBe(90);
    expect(rotated.bounds.maximum.x - rotated.bounds.minimum.x).toBe(31);
    expect(rotated.bounds.maximum.z - rotated.bounds.minimum.z).toBe(15);
  });

  it("tiles complete districts onto stable numbered plates", () => {
    const plan = planPrintLayout(profile(), {
      fitPolicy: "tile",
      requestedScale: 1,
      features,
      districts: [
        district("a", 40, 30),
        district("b", 40, 30),
        district("c", 35, 28),
      ],
    });

    expect(plan.plates.length).toBeGreaterThan(1);
    expect(plan.plates.map(({ id }) => id)).toEqual(
      plan.plates.map((_, index) =>
        `plate-${String(index + 1).padStart(2, "0")}`,
      ),
    );
    expect(
      plan.plates.flatMap(({ districts }) =>
        districts.map(({ districtId }) => districtId),
      ).sort(),
    ).toEqual(["a", "b", "c"]);
    for (const plate of plan.plates) {
      expect(
        plate.reservations.some(({ kind }) => kind === "plate-number"),
      ).toBe(true);
    }
    expect(plan.warnings).toContain(
      `Complete districts were distributed across ${plan.plates.length} plates.`,
    );
  });

  it("keeps error as the default instead of silently scaling or tiling", () => {
    expect(() =>
      planPrintLayout(profile(), {
        requestedScale: 1,
        features,
        districts: [
          district("a", 45, 30),
          district("b", 45, 30),
        ],
      }),
    ).toThrow(
      /Fit policy.*"Scale to one plate".*"Tile complete districts \(multi-plate\)"/u,
    );
    try {
      planPrintLayout(profile(), {
        requestedScale: 1,
        features,
        districts: [
          district("a", 45, 30),
          district("b", 45, 30),
        ],
      });
    } catch (error) {
      expect((error as Error).message).not.toMatch(
        /fitPolicy|'scale'|'tile'/u,
      );
    }
  });

  it("scales only as far as all supplied printer features remain safe", () => {
    const printer = profile({ x: 70, y: 30, z: 50 });
    const districts = [
      district("a", 25, 20),
      district("b", 25, 20),
      district("c", 25, 20),
    ];
    const knownFeasible = planPrintLayout(printer, {
      fitPolicy: "error",
      requestedScale: 1.2,
      features,
      districts,
    });
    const plan = planPrintLayout(printer, {
      fitPolicy: "scale",
      requestedScale: 2,
      features,
      districts,
    });

    expect(plan.minimumSafeScale).toBe(1);
    expect(knownFeasible.plates).toHaveLength(1);
    expect(plan.appliedScale).toBeGreaterThanOrEqual(1.2);
    expect(plan.appliedScale).toBeLessThan(2);
    expect(plan.plates).toHaveLength(1);
    expect(plan.warnings.some((warning) =>
      /scaled from 2.*to fit one plate safely\./u.test(warning)
    ))
      .toBe(true);
  });

  it("repacks and rotates districts while searching for the largest one-plate scale", () => {
    const printer = profile();
    const districts = [district("rotating", 2, 24)];
    const request = {
      fitPolicy: "scale" as const,
      requestedScale: 3,
      features,
      districts,
    };
    const knownFeasible = planPrintLayout(printer, {
      ...request,
      fitPolicy: "error",
      requestedScale: 2.5,
    });
    const plan = planPrintLayout(printer, request);

    expect(knownFeasible.plates).toHaveLength(1);
    expect(
      knownFeasible.plates[0]!.districts[0]!.transform.rotation,
    ).toBe(90);
    expect(plan.appliedScale).toBeCloseTo(
      knownFeasible.appliedScale,
      7,
    );
    expect(plan.appliedScale).toBeLessThan(3);
    expect(plan.plates).toHaveLength(1);
    expect(plan.plates[0]!.districts[0]!.transform.rotation).toBe(90);
    expect(planPrintLayout(printer, request)).toEqual(plan);
  });

  it("discovers the highest sampled fit across non-monotone greedy packing islands", () => {
    const printer = profile();
    const districts = [district("a", 22, 6), district("b", 25, 4)];
    const request = {
      fitPolicy: "scale" as const,
      requestedScale: 3,
      features,
      districts,
    };
    const knownFeasible = planPrintLayout(printer, {
      ...request,
      fitPolicy: "error",
      requestedScale: 2.4,
    });
    const plan = planPrintLayout(printer, request);

    expect(knownFeasible.plates).toHaveLength(1);
    expect(plan.appliedScale).toBeCloseTo(
      knownFeasible.appliedScale,
      7,
    );
    expect(plan.appliedScale).toBeLessThan(3);
    expect(plan.plates).toHaveLength(1);
    expect(planPrintLayout(printer, request)).toEqual(plan);
  });

  it("discovers a narrow higher-scale packing island", () => {
    const printer = profile({ x: 80, y: 20, z: 43 });
    const districts = [
      district("a", 18.2, 12.6, 1),
      district("b", 19.7, 4.8, 1),
      district("c", 25.9, 14.4, 1),
    ];
    const request = {
      fitPolicy: "scale" as const,
      requestedScale: 3.4,
      districtGap: 1.5,
      features,
      districts,
    };
    const knownFeasible = planPrintLayout(printer, {
      ...request,
      fitPolicy: "error",
      requestedScale: 1.87,
    });
    const plan = planPrintLayout(printer, request);

    expect(knownFeasible.plates).toHaveLength(1);
    expect(plan.appliedScale).toBeGreaterThanOrEqual(1.87);
    expect(plan.appliedScale).toBeLessThan(3.4);
    expect(plan.plates).toHaveLength(1);
    expect(planPrintLayout(printer, request)).toEqual(plan);
  });

  it("discovers a sub-milliscale higher packing island", () => {
    const printer = profile();
    const districts = [
      district("a", 21.9102400206, 18.1830263007),
      district("b", 13.105355287, 22.6733841728),
      district("c", 4.8652528599, 22.2512963507),
      district("d", 5.1778066512, 9.9080212172),
      district("e", 21.4625798352, 13.4086571056),
      district("f", 2.7401287425, 23.7757696193),
    ];
    const request = {
      fitPolicy: "scale" as const,
      requestedScale: 3,
      features,
      districts,
    };
    const knownFeasible = planPrintLayout(printer, {
      ...request,
      fitPolicy: "error",
      requestedScale: 1.3295,
    });
    const plan = planPrintLayout(printer, request);

    expect(knownFeasible.plates).toHaveLength(1);
    expect(plan.appliedScale).toBeGreaterThanOrEqual(1.3295);
    expect(plan.appliedScale).toBeLessThan(3);
    expect(plan.plates).toHaveLength(1);
    expect(planPrintLayout(printer, request)).toEqual(plan);
  });

  it("discovers a higher-scale topology when the safe-scale greedy attempt fails", () => {
    const printer = profile({ x: 60, y: 100, z: 45 });
    const districts = [
      district("a", 30, 29),
      district("b", 24, 11),
      district("c", 34, 6),
    ];
    const request = {
      fitPolicy: "scale" as const,
      requestedScale: 1.3,
      features,
      districts,
    };
    const knownFeasible = planPrintLayout(printer, {
      ...request,
      fitPolicy: "error",
      requestedScale: 1.2,
    });
    const plan = planPrintLayout(printer, request);

    expect(knownFeasible.plates).toHaveLength(1);
    expect(plan.appliedScale).toBeGreaterThanOrEqual(1.2);
    expect(plan.appliedScale).toBeLessThan(1.3);
    expect(plan.plates).toHaveLength(1);
    expect(planPrintLayout(printer, request)).toEqual(plan);
  });

  it("caps enormous scale targets before multiplying model dimensions", () => {
    const printer = profile();
    const request = {
      fitPolicy: "scale" as const,
      requestedScale: Number.MAX_VALUE,
      features,
      districts: [district("finite", 10, 10)],
    };
    const plan = planPrintLayout(printer, request);

    expect(Number.isFinite(plan.appliedScale)).toBe(true);
    expect(plan.appliedScale).toBeGreaterThanOrEqual(plan.minimumSafeScale);
    expect(plan.appliedScale).toBeLessThan(Number.MAX_VALUE);
    expect(plan.plates).toHaveLength(1);
    expect(planPrintLayout(printer, request)).toEqual(plan);
  });

  it("can search below an enormous safe scale only after acknowledgement", () => {
    const tinyFeatures: PrintLayoutFeatureMeasurements = {
      wallThickness: 1e-200,
      gap: 1e-200,
      minimumFeatureSize: 1e-200,
      baseThickness: 1e-200,
      labelStrokeWidth: 1e-200,
      raisedFeatureHeight: 1e-200,
      recessedFeatureDepth: 1e-200,
      routeWidth: 1e-200,
      connectorWidth: 1e-200,
    };
    const printer = profile();
    const request = {
      fitPolicy: "scale" as const,
      requestedScale: Number.MAX_VALUE,
      acknowledgeBelowProfileScale: true,
      features: tinyFeatures,
      districts: [district("finite", 10, 10)],
    };
    expect(() =>
      planPrintLayout(printer, {
        ...request,
        acknowledgeBelowProfileScale: false,
      }),
    ).toThrow(/minimum profile-safe scale|requires.*packing span/u);
    const plan = planPrintLayout(printer, request);

    expect(Number.isFinite(plan.appliedScale)).toBe(true);
    expect(plan.appliedScale).toBeGreaterThan(0);
    expect(plan.appliedScale).toBeLessThan(plan.minimumSafeScale);
    expect(plan.belowProfileScaleAcknowledged).toBe(true);
    expect(plan.featureViolations.length).toBeGreaterThan(0);
    expect(plan.plates).toHaveLength(1);
    expect(planPrintLayout(printer, request)).toEqual(plan);
  });

  it("names the visible tile option when one-plate scaling is impossible", () => {
    expect(() =>
      planPrintLayout(profile({ x: 60, y: 30, z: 40 }), {
        fitPolicy: "scale",
        requestedScale: 2,
        features,
        districts: [
          district("a", 45, 30),
          district("b", 45, 30),
        ],
      }),
    ).toThrow(
      /minimum profile-safe scale 1.*Fit policy.*"Tile complete districts \(multi-plate\)"/u,
    );
  });

  it("rejects a requested scale below the strictest feature constraint", () => {
    expect(() =>
      planPrintLayout(profile(), {
        fitPolicy: "scale",
        requestedScale: 0.9,
        features,
        districts: [district("a", 5, 5)],
      }),
    ).toThrow(/minimum profile-safe scale 1/u);
  });

  it("allows an explicitly acknowledged lower scale with exact ordered fidelity violations", () => {
    const plan = planPrintLayout(profile(), {
      fitPolicy: "error",
      requestedScale: 0.75,
      acknowledgeBelowProfileScale: true,
      features,
      districts: [district("a", 5, 5)],
    });

    expect(plan).toMatchObject({
      requestedScale: 0.75,
      appliedScale: 0.75,
      minimumSafeScale: 1,
      belowProfileScaleAcknowledged: true,
    });
    expect(plan.featureViolations.map(({ category }) => category)).toEqual([
      "wall-thickness",
      "gap",
      "minimum-feature-size",
      "label-stroke-width",
      "raised-feature-height",
      "recessed-feature-depth",
      "route-width",
      "connector-width",
    ]);
    expect(plan.featureViolations).toEqual(
      plan.featureViolations.map(({ category }) => ({
        category,
        resultingValue: 0.75,
        minimum: 1,
      })),
    );
    expect(plan.warnings.join(" ")).toMatch(
      /print fidelity, not printer hardware danger.*wall-thickness 0\.75 mm < 1 mm/u,
    );
  });

  it("preserves an explicitly requested positive sub-epsilon scale", () => {
    const plan = planPrintLayout(profile(), {
      fitPolicy: "scale",
      requestedScale: 5e-10,
      acknowledgeBelowProfileScale: true,
      features,
      districts: [],
    });

    expect(plan.appliedScale).toBe(5e-10);
    expect(plan.belowProfileScaleAcknowledged).toBe(true);
    expect(plan.featureViolations.length).toBeGreaterThan(0);
    expect(plan.plates).toHaveLength(1);
  });

  it("uses a valid positive sub-epsilon geometric ceiling", () => {
    const printer = profile();
    const districts = [district("wide", 120_000_000_002, 1, 1)];
    const knownFeasible = planPrintLayout(printer, {
      fitPolicy: "error",
      requestedScale: 4.9e-10,
      acknowledgeBelowProfileScale: true,
      features,
      districts,
    });
    const plan = planPrintLayout(printer, {
      fitPolicy: "scale",
      requestedScale: 2e-9,
      acknowledgeBelowProfileScale: true,
      features,
      districts,
    });

    expect(plan.appliedScale).toBeGreaterThanOrEqual(
      knownFeasible.appliedScale,
    );
    expect(plan.appliedScale).toBeLessThanOrEqual(2e-9);
    expect(plan.featureViolations.length).toBeGreaterThan(0);
    expect(plan.plates).toHaveLength(1);
  });

  it("searches below the safe floor only after acknowledgement and remains bounded", () => {
    const request = {
      fitPolicy: "scale" as const,
      requestedScale: 2,
      features,
      districts: [district("a", 45, 30), district("b", 45, 30)],
    };
    expect(() =>
      planPrintLayout(profile({ x: 60, y: 30, z: 40 }), request),
    ).toThrow(/minimum profile-safe scale 1/u);

    const first = planPrintLayout(profile({ x: 60, y: 30, z: 40 }), {
      ...request,
      acknowledgeBelowProfileScale: true,
    });
    const second = planPrintLayout(profile({ x: 60, y: 30, z: 40 }), {
      ...request,
      acknowledgeBelowProfileScale: true,
    });
    expect(second).toEqual(first);
    expect(first.appliedScale).toBeLessThan(1);
    expect(first.appliedScale).toBeGreaterThan(0);
    expect(first.plates).toHaveLength(1);
    expect(first.featureViolations.length).toBeGreaterThan(0);
    expect(first.warnings.join(" ")).not.toContain(
      "to fit one plate safely",
    );
    expect(first.warnings.join(" ")).toMatch(
      /print fidelity, not printer hardware danger/u,
    );
  });

  it("never treats acknowledgement as a physical build-volume override", () => {
    expect(() =>
      planPrintLayout(profile({ x: 60, y: 30, z: 40 }), {
        fitPolicy: "scale",
        requestedScale: 0.5,
        acknowledgeBelowProfileScale: true,
        features,
        identity: {
          id: "physical-identity",
          sourceBounds: bounds(61, 2, 5),
          scaleMode: "physical",
        },
        districts: [district("a", 5, 5)],
      }),
    ).toThrow(/reservation|does not fit|usable/u);
  });

  it("finds a deterministic positive acknowledged fit for astronomical districts", () => {
    const request = {
      fitPolicy: "scale" as const,
      requestedScale: 2,
      acknowledgeBelowProfileScale: true,
      features,
      districts: [district("astronomical", 1e15, 1e15)],
    };
    const first = planPrintLayout(
      profile({ x: 60, y: 30, z: 40 }),
      request,
    );
    const second = planPrintLayout(
      profile({ x: 60, y: 30, z: 40 }),
      request,
    );

    expect(first.appliedScale).toBeGreaterThan(0);
    expect(first.appliedScale).toBeLessThan(1e-9);
    expect(first.featureViolations.length).toBeGreaterThan(0);
    expect(first.plates).toHaveLength(1);
    expect(second).toEqual(first);
  });

  it("uses the shared fidelity tolerance at the safe threshold", () => {
    const plan = planPrintLayout(profile(), {
      fitPolicy: "error",
      requestedScale: 1 - 5e-10,
      features,
      districts: [district("a", 5, 5)],
    });
    expect(plan.featureViolations).toEqual([]);
    expect(plan.belowProfileScaleAcknowledged).toBe(false);
  });

  it("names the exact district and W/D/H when it cannot fit alone", () => {
    try {
      planPrintLayout(profile({ x: 40, y: 20, z: 30 }), {
        fitPolicy: "tile",
        requestedScale: 1,
        features,
        districts: [district("oversized", 41, 10, 5)],
      });
      throw new Error("Expected planPrintLayout to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(PrintLayoutError);
      const issue = (error as PrintLayoutError).issues[0]!;
      expect(issue).toMatchObject({
        code: "district-does-not-fit",
        objectId: "oversized",
        required: { x: 41, y: 6, z: 10 },
        available: { x: 40, y: 20, z: 30 },
      });
      expect(issue.message).toMatch(
        /District 'District oversized' \(oversized\) requires 41 x 10 x 6 mm \(W x D x H\).*90-degree rotation/u,
      );
    }
  });

  it("names a height-only district failure including base thickness", () => {
    try {
      planPrintLayout(profile({ x: 80, y: 20, z: 60 }), {
        fitPolicy: "tile",
        requestedScale: 1,
        features,
        districts: [district("too-tall", 10, 10, 20)],
      });
      throw new Error("Expected planPrintLayout to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(PrintLayoutError);
      expect((error as PrintLayoutError).issues[0]).toMatchObject({
        code: "district-does-not-fit",
        objectId: "too-tall",
        required: { x: 10, y: 21, z: 10 },
        available: { x: 80, y: 20, z: 60 },
      });
    }
  });

  it("keeps only used channels in profile order for a multi-tool printer", () => {
    const plan = planPrintLayout(createPrusaXLProfile([5, 1, 3]), {
      fitPolicy: "error",
      requestedScale: 1,
      features: {
        ...features,
        wallThickness: 0.45,
        gap: 0.4,
        minimumFeatureSize: 0.8,
        baseThickness: 0.8,
        labelStrokeWidth: 0.45,
        raisedFeatureHeight: 0.8,
        recessedFeatureDepth: 0.8,
        routeWidth: 0.8,
        connectorWidth: 0.8,
      },
      baseChannelId: "tool-1",
      identity: {
        id: "identity",
        sourceBounds: bounds(20, 3, 5),
        channelIds: ["tool-3"],
      },
      districts: [
        {
          ...district("a", 20, 20),
          channelIds: ["tool-5", "tool-3"],
        },
      ],
    });

    expect(plan.plates[0]!.channelIds).toEqual([
      "tool-1",
      "tool-3",
      "tool-5",
    ]);
  });

  it("reserves a deterministic rear apron on every plate for duplicated external boxes", () => {
    const rearReservation = {
      id: "external-apron",
      depth: 12,
      height: 5,
      channelIds: ["channel-1"],
      boxes: Array.from({ length: 12 }, (_, index) => ({
        id: `external-${String(index + 1).padStart(2, "0")}`,
        size: { x: 4, y: 5, z: 2 },
        channelIds: ["channel-1"],
      })),
    };
    const request = {
      fitPolicy: "tile",
      requestedScale: 1,
      features,
      rearReservation,
      districts: [
        district("a", 45, 30),
        district("b", 45, 30),
      ],
    } as const;
    const plan = planPrintLayout(
      profile({ x: 70, y: 30, z: 55 }),
      request,
    );
    expect(
      planPrintLayout(profile({ x: 70, y: 30, z: 55 }), {
        ...request,
        rearReservation: {
          ...rearReservation,
          boxes: [...rearReservation.boxes].reverse(),
        },
      }),
    ).toEqual(plan);

    expect(plan.plates.length).toBeGreaterThan(1);
    for (const plate of plan.plates) {
      const apron = plate.reservations.find(
        ({ kind }) => kind === "external-apron",
      )!;
      expect(apron.virtual).toBe(true);
      expect(apron.bounds.maximum.z - apron.bounds.minimum.z).toBe(12);
      expect(plate.base.bounds.maximum.z).toBe(apron.bounds.maximum.z);
      expect(plate.base.size.z).toBeLessThan(plan.usableBuildSpan.z);
      expect(plate.base.size.x).toBeLessThan(plan.usableBuildSpan.x);
      const externalBoxes = plate.reservations.filter(
        ({ kind }) => kind === "external-box",
      );
      expect(externalBoxes).toHaveLength(12);
      for (const box of externalBoxes) {
        expect(box.bounds.minimum.x).toBeGreaterThanOrEqual(
          apron.bounds.minimum.x,
        );
        expect(box.bounds.maximum.x).toBeLessThanOrEqual(
          apron.bounds.maximum.x,
        );
        expect(box.bounds.minimum.z).toBeGreaterThanOrEqual(
          apron.bounds.minimum.z,
        );
        expect(box.bounds.maximum.z).toBeLessThanOrEqual(
          apron.bounds.maximum.z,
        );
        expect(box.bounds.minimum.y).toBe(
          plate.base.bounds.maximum.y,
        );
      }
      for (let left = 0; left < externalBoxes.length; left += 1) {
        for (
          let right = left + 1;
          right < externalBoxes.length;
          right += 1
        ) {
          const a = externalBoxes[left]!.bounds;
          const b = externalBoxes[right]!.bounds;
          expect(
            a.maximum.x + plan.districtGap <= b.minimum.x ||
              b.maximum.x + plan.districtGap <= a.minimum.x ||
              a.maximum.z + plan.districtGap <= b.minimum.z ||
              b.maximum.z + plan.districtGap <= a.minimum.z,
          ).toBe(true);
        }
      }
      for (const districtPlacement of plate.districts) {
        expect(
          districtPlacement.bounds.maximum.z + plan.districtGap,
        ).toBeLessThanOrEqual(apron.bounds.minimum.z);
      }
    }
  });

  it("distinguishes rear capacity and plate-number reservation failures", () => {
    try {
      planPrintLayout(profile(), {
        fitPolicy: "tile",
        features,
        districts: [],
        rearReservation: {
          id: "too-shallow",
          depth: 1,
          height: 5,
          boxes: [
            {
              id: "external",
              size: { x: 4, y: 5, z: 2 },
            },
          ],
        },
      });
      throw new Error("Expected rear capacity failure.");
    } catch (error) {
      expect(error).toBeInstanceOf(PrintLayoutError);
      expect((error as PrintLayoutError).issues[0]).toMatchObject({
        code: "reservation-does-not-fit",
        objectId: "too-shallow",
      });
      expect((error as Error).message).toMatch(/Fixed external boxes/u);
    }

    try {
      planPrintLayout(profile({ x: 9, y: 20, z: 20 }), {
        features,
        districts: [],
      });
      throw new Error("Expected plate-number failure.");
    } catch (error) {
      expect(error).toBeInstanceOf(PrintLayoutError);
      expect((error as PrintLayoutError).issues[0]).toMatchObject({
        code: "reservation-does-not-fit",
        objectId: "plate-01-number",
      });
      expect((error as Error).message).toMatch(/Plate-number reservation/u);
    }
  });

  it("enforces bounded district and two-digit plate resources", () => {
    expect(() =>
      planPrintLayout(profile(), {
        features,
        districts: [],
        maximumPlateCount: 100,
      }),
    ).toThrow(/must not exceed 99/u);

    expect(() =>
      planPrintLayout(profile(), {
        features,
        districts: Array.from({ length: 513 }, (_, index) =>
          district(`d-${index}`, 1, 1),
        ),
      }),
    ).toThrow(/at most 512 complete districts/u);
  });

  it("never returns non-finite layout products or JSON-null numeric fields", () => {
    const regular = planPrintLayout(profile(), {
      features,
      districts: [district("finite", 10, 10)],
    });
    const roundTripped = JSON.parse(JSON.stringify(regular)) as unknown;
    const pending: unknown[] = [roundTripped];
    while (pending.length > 0) {
      const value = pending.pop();
      if (typeof value === "number") {
        expect(Number.isFinite(value)).toBe(true);
      } else if (Array.isArray(value)) {
        pending.push(...value);
      } else if (typeof value === "object" && value !== null) {
        pending.push(...Object.values(value));
      }
    }

    const enormousProfile = profile({
      x: 1e308,
      y: 30,
      z: 1e308,
    });
    expect(() =>
      planPrintLayout(enormousProfile, {
        features,
        districts: [],
      }),
    ).toThrow(PrintLayoutError);
    try {
      planPrintLayout(enormousProfile, {
        features,
        districts: [],
      });
    } catch (error) {
      expect((error as PrintLayoutError).issues[0]).toMatchObject({
        code: "resource-limit",
      });
      expect((error as Error).message).toMatch(/build-surface area/iu);
    }

    expect(() =>
      planPrintLayout(enormousProfile, {
        features,
        districts: [
          district("overflow-area", 1e200, 1e200),
        ],
      }),
    ).toThrow(/footprint area|build-surface area/iu);
  });

  it("raises a requested street gap to the printer-safe minimum", () => {
    const plan = planPrintLayout(profile(), {
      features,
      districtGap: 0.25,
      districts: [district("a", 10, 10)],
    });

    expect(plan.districtGap).toBe(1);
    expect(plan.warnings).toContain(
      "District gap was raised from 0.25 mm to the profile minimum 1 mm.",
    );
  });

  it("reports deterministic unplaced districts when an explicit plate cap is reached", () => {
    const plan = planPrintLayout(profile(), {
      fitPolicy: "tile",
      requestedScale: 1,
      maximumPlateCount: 1,
      features,
      districts: [
        district("a", 40, 30),
        district("b", 40, 30),
      ],
    });

    expect(plan.plates).toHaveLength(1);
    expect(plan.unplaced).toEqual([
      {
        kind: "district",
        id: "b",
        name: "District b",
        reason: "plate-limit",
        required: { x: 40, y: 6, z: 30 },
      },
    ]);
    expect(plan.warnings).toContain(
      "1 district was not placed because maximumPlateCount is 1.",
    );
  });

  it("fails when the identity reservation exceeds plate 1 height", () => {
    expect(() =>
      planPrintLayout(profile({ x: 80, y: 20, z: 50 }), {
        fitPolicy: "tile",
        requestedScale: 1,
        features,
        identity: {
          id: "identity",
          sourceBounds: bounds(20, 20, 5),
        },
        districts: [],
      }),
    ).toThrow(/Identity reservation 'identity'/u);
  });
});
