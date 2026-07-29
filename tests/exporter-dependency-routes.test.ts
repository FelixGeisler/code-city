import { describe, expect, it } from "vitest";

import {
  dependencyRouteWidthClass,
  planPrintableDependencyRoutes,
  type PlanPrintableDependencyRoutesRequest,
  type PrintRouteBounds2D,
} from "../packages/exporter/src/dependency-routes.js";
import type {
  PrintBounds,
  PrintPrimitive,
} from "../packages/exporter/src/geometry.js";
import { signedMeshVolume } from "../packages/exporter/src/validate.js";

const baseBounds: PrintBounds = {
  minimum: { x: 0, y: 0, z: 0 },
  maximum: { x: 120, y: 70, z: 2 },
  size: { x: 120, y: 70, z: 2 },
};

const geometryLimits = {
  minimumFeatureSize: 0.8,
  minimumGap: 0.4,
  minimumWallThickness: 0.45,
};

function rectangle(
  minimumX: number,
  minimumY: number,
  maximumX: number,
  maximumY: number,
): PrintRouteBounds2D {
  return {
    minimum: { x: minimumX, y: minimumY },
    maximum: { x: maximumX, y: maximumY },
  };
}

function request(
  overrides: Partial<PlanPrintableDependencyRoutesRequest> = {},
): PlanPrintableDependencyRoutesRequest {
  return {
    bundles: [
      {
        id: "private-bundle",
        sourceEndpointId: "private-consumer",
        targetEndpointId: "private-provider",
        weight: 4,
      },
    ],
    endpoints: [
      {
        id: "private-consumer",
        bounds: rectangle(5, 25, 15, 35),
      },
      {
        id: "private-provider",
        bounds: rectangle(105, 25, 115, 35),
      },
    ],
    baseBounds,
    geometryLimits,
    channelId: "route-channel",
    ...overrides,
  };
}

function footprint(item: PrintPrimitive): PrintRouteBounds2D {
  return {
    minimum: {
      x: item.bounds.minimum.x,
      y: item.bounds.minimum.y,
    },
    maximum: {
      x: item.bounds.maximum.x,
      y: item.bounds.maximum.y,
    },
  };
}

function positiveOverlap(
  left: PrintRouteBounds2D,
  right: PrintRouteBounds2D,
): boolean {
  return (
    Math.min(left.maximum.x, right.maximum.x) -
      Math.max(left.minimum.x, right.minimum.x) >
      1e-7 &&
    Math.min(left.maximum.y, right.maximum.y) -
      Math.max(left.minimum.y, right.minimum.y) >
      1e-7
  );
}

describe("printable dependency routes", () => {
  it("prints a grounded, privacy-safe trace with bounded weight and direction cues", () => {
    const planned = planPrintableDependencyRoutes(request());

    expect(planned.report).toEqual({
      totalRouteCount: 1,
      printedRouteCount: 1,
      omittedRouteCount: 0,
      cappedRouteCount: 0,
      unresolvedEndpointRouteCount: 0,
      unroutableRouteCount: 0,
      totalWeight: 4,
      printedWeight: 4,
      omittedWeight: 0,
    });
    expect(planned.routes).toHaveLength(1);
    expect(planned.routes[0]?.widthClass).toBe(3);
    expect(planned.primitives.length).toBeGreaterThanOrEqual(4);
    expect(
      planned.primitives.every(
        (item) =>
          item.kind === "dependency-trace" &&
          item.semanticGroupId === "routes" &&
          item.channelId === "route-channel" &&
          item.bounds.minimum.z === baseBounds.maximum.z &&
          Math.abs(
            item.bounds.size.z - geometryLimits.minimumFeatureSize,
          ) < 1e-7 &&
          signedMeshVolume(item.mesh) > 0,
      ),
    ).toBe(true);

    const serialized = JSON.stringify(planned.primitives);
    expect(serialized).not.toContain("private-bundle");
    expect(serialized).not.toContain("private-consumer");
    expect(serialized).not.toContain("private-provider");
    expect(
      planned.primitives.every(({ id }) =>
        /^dependency-route:\d{3}:(?:trace|arrow):\d{3}$/u.test(id),
      ),
    ).toBe(true);

    const arrows = planned.primitives.filter(({ id }) =>
      id.includes(":arrow:"),
    );
    expect(arrows).toHaveLength(3);
    expect(arrows[0]?.bounds.size.y).toBeCloseTo(2.4);
    expect(arrows[1]?.bounds.size.y).toBeCloseTo(1.6);
    expect(arrows[2]?.bounds.size.y).toBeCloseTo(0.8);
    expect(arrows.at(-1)?.bounds.maximum.x).toBe(105);
  });

  it("detours around obstacles without positive-volume crossings", () => {
    const obstacle = rectangle(50, 20, 70, 40);
    const planned = planPrintableDependencyRoutes(
      request({
        obstacles: [{ bounds: obstacle }],
      }),
    );

    expect(planned.report.printedRouteCount).toBe(1);
    expect(
      planned.primitives.some(
        ({ bounds }) =>
          bounds.maximum.y <= obstacle.minimum.y - geometryLimits.minimumGap,
      ),
    ).toBe(true);
    expect(
      planned.primitives.every(
        (item) => !positiveOverlap(footprint(item), obstacle),
      ),
    ).toBe(true);
    for (let left = 0; left < planned.primitives.length; left += 1) {
      for (
        let right = left + 1;
        right < planned.primitives.length;
        right += 1
      ) {
        expect(
          positiveOverlap(
            footprint(planned.primitives[left]!),
            footprint(planned.primitives[right]!),
          ),
        ).toBe(false);
      }
    }
  });

  it("shares one base-anchored lane grid across differently sized endpoints", () => {
    const planned = planPrintableDependencyRoutes(
      request({
        bundles: [
          {
            id: "aligned",
            sourceEndpointId: "wide",
            targetEndpointId: "narrow",
            weight: 1,
          },
        ],
        endpoints: [
          { id: "wide", bounds: rectangle(5, 5, 45, 35) },
          { id: "narrow", bounds: rectangle(8, 44, 20, 50) },
        ],
      }),
    );

    expect(planned.report).toMatchObject({
      printedRouteCount: 1,
      omittedRouteCount: 0,
    });
  });

  it.each([
    {
      name: "right to left",
      endpoints: [
        { id: "source", bounds: rectangle(105, 25, 115, 35) },
        { id: "target", bounds: rectangle(5, 25, 15, 35) },
      ],
      obstacle: rectangle(50, 20, 70, 40),
    },
    {
      name: "top to bottom",
      endpoints: [
        { id: "source", bounds: rectangle(55, 55, 65, 65) },
        { id: "target", bounds: rectangle(55, 5, 65, 15) },
      ],
      obstacle: rectangle(50, 30, 70, 40),
    },
  ])("keeps decreasing-coordinate bends connected ($name)", ({
    endpoints,
    obstacle,
  }) => {
    const planned = planPrintableDependencyRoutes(
      request({
        bundles: [
          {
            id: "reversed",
            sourceEndpointId: "source",
            targetEndpointId: "target",
            weight: 4,
          },
        ],
        endpoints,
        obstacles: [{ bounds: obstacle }],
      }),
    );

    expect(planned.report.printedRouteCount).toBe(1);
    for (let left = 0; left < planned.primitives.length; left += 1) {
      expect(
        positiveOverlap(
          footprint(planned.primitives[left]!),
          obstacle,
        ),
      ).toBe(false);
      for (
        let right = left + 1;
        right < planned.primitives.length;
        right += 1
      ) {
        expect(
          positiveOverlap(
            footprint(planned.primitives[left]!),
            footprint(planned.primitives[right]!),
          ),
        ).toBe(false);
      }
    }
  });

  it("is deterministic across bundle and endpoint input order", () => {
    const endpoints = [
      { id: "s1", bounds: rectangle(5, 5, 15, 15) },
      { id: "t1", bounds: rectangle(105, 5, 115, 15) },
      { id: "s2", bounds: rectangle(5, 55, 15, 65) },
      { id: "t2", bounds: rectangle(105, 55, 115, 65) },
    ];
    const bundles = [
      {
        id: "z",
        sourceEndpointId: "s1",
        targetEndpointId: "t1",
        weight: 2,
      },
      {
        id: "a",
        sourceEndpointId: "s2",
        targetEndpointId: "t2",
        weight: 1,
      },
    ];
    const first = planPrintableDependencyRoutes(
      request({ bundles, endpoints }),
    );
    const second = planPrintableDependencyRoutes(
      request({
        bundles: [...bundles].reverse(),
        endpoints: [...endpoints].reverse(),
      }),
    );

    expect(first).toEqual(second);
    expect(first.report.printedRouteCount).toBe(2);
    for (let left = 0; left < first.primitives.length; left += 1) {
      for (
        let right = left + 1;
        right < first.primitives.length;
        right += 1
      ) {
        expect(
          positiveOverlap(
            footprint(first.primitives[left]!),
            footprint(first.primitives[right]!),
          ),
        ).toBe(false);
      }
    }
  });

  it("caps strongest bundles and reports capped and unresolved omissions", () => {
    const endpoints = [
      { id: "s1", bounds: rectangle(5, 5, 15, 15) },
      { id: "t1", bounds: rectangle(105, 5, 115, 15) },
      { id: "s2", bounds: rectangle(5, 30, 15, 40) },
      { id: "t2", bounds: rectangle(105, 30, 115, 40) },
    ];
    const planned = planPrintableDependencyRoutes(
      request({
        endpoints,
        maximumRoutes: 2,
        bundles: [
          {
            id: "low-capped",
            sourceEndpointId: "missing",
            targetEndpointId: "also-missing",
            weight: 1,
          },
          {
            id: "high",
            sourceEndpointId: "s1",
            targetEndpointId: "t1",
            weight: 8,
          },
          {
            id: "middle-unresolved",
            sourceEndpointId: "s2",
            targetEndpointId: "missing",
            weight: 4,
          },
        ],
      }),
    );

    expect(planned.report).toEqual({
      totalRouteCount: 3,
      printedRouteCount: 1,
      omittedRouteCount: 2,
      cappedRouteCount: 1,
      unresolvedEndpointRouteCount: 1,
      unroutableRouteCount: 0,
      totalWeight: 13,
      printedWeight: 8,
      omittedWeight: 5,
    });
  });

  it("uses only the three documented logarithmic width classes", () => {
    expect([1, 1.99, 2, 3.99, 4, 1_000_000].map(
      dependencyRouteWidthClass,
    )).toEqual([1, 1, 2, 2, 3, 3]);
    expect(() => dependencyRouteWidthClass(0)).toThrow(
      "Dependency route weight must be positive.",
    );
  });

  it("preserves omitted weight when finite sums saturate", () => {
    const halfMaximum = Number.MAX_VALUE / 2;
    const planned = planPrintableDependencyRoutes(
      request({
        maximumRoutes: 2,
        bundles: [
          {
            id: "a-printable",
            sourceEndpointId: "private-consumer",
            targetEndpointId: "private-provider",
            weight: halfMaximum,
          },
          {
            id: "b-unresolved",
            sourceEndpointId: "missing",
            targetEndpointId: "private-provider",
            weight: halfMaximum,
          },
          {
            id: "z-capped",
            sourceEndpointId: "private-consumer",
            targetEndpointId: "private-provider",
            weight: halfMaximum,
          },
        ],
      }),
    );

    expect(planned.report).toMatchObject({
      totalRouteCount: 3,
      printedRouteCount: 1,
      omittedRouteCount: 2,
      cappedRouteCount: 1,
      unresolvedEndpointRouteCount: 1,
      totalWeight: Number.MAX_VALUE,
      printedWeight: halfMaximum,
      omittedWeight: Number.MAX_VALUE,
    });
  });

  it(
    "omits over-budget obstacle grids before allocating route state",
    { timeout: 1_000 },
    () => {
      const obstacles = Array.from({ length: 300 }, (_, index) => ({
        bounds: rectangle(
          20 + (index % 20) * 4,
          2 + Math.floor(index / 20) * 4,
          22 + (index % 20) * 4,
          4 + Math.floor(index / 20) * 4,
        ),
      }));
      const first = planPrintableDependencyRoutes(
        request({ obstacles }),
      );
      const second = planPrintableDependencyRoutes(
        request({ obstacles: [...obstacles].reverse() }),
      );

      expect(first).toEqual(second);
      expect(first.primitives).toEqual([]);
      expect(first.report).toMatchObject({
        printedRouteCount: 0,
        omittedRouteCount: 1,
        unroutableRouteCount: 1,
      });
    },
  );
});
