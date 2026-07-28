import { describe, expect, it } from "vitest";

import {
  keyedBoundaryGateway,
  roofRoutePoint,
} from "../apps/viewer/src/dependency-route-layout.js";

const rectangle = {
  centerX: 10,
  centerZ: 20,
  sizeX: 20,
  sizeZ: 10,
};

describe("dependency route layout", () => {
  it("places a route point just above a building roof", () => {
    expect(
      roofRoutePoint({
        position: { x: 4, y: 6, z: -2 },
        size: { x: 3, y: 8, z: 5 },
      }),
    ).toEqual({ x: 4, y: 10.18, z: -2 });
  });

  it("places external gateways deterministically on an outer edge", () => {
    const first = keyedBoundaryGateway(rectangle, "@angular/core", 1.5);
    const repeated = keyedBoundaryGateway(
      rectangle,
      "@angular/core",
      1.5,
    );

    expect(repeated).toEqual(first);
    expect(isOnBoundary(first)).toBe(true);
    expect(first.y).toBe(1.5);
  });

  it("rejects invalid geometry", () => {
    expect(() =>
      keyedBoundaryGateway(
        { ...rectangle, sizeX: 0 },
        "invalid",
        1,
      ),
    ).toThrow(RangeError);
    expect(() =>
      roofRoutePoint({
        position: { x: 0, y: 0, z: 0 },
        size: { x: 1, y: -1, z: 1 },
      }),
    ).toThrow(RangeError);
  });
});

function isOnBoundary(point: { readonly x: number; readonly z: number }) {
  return (
    point.x === rectangle.centerX - rectangle.sizeX / 2 ||
    point.x === rectangle.centerX + rectangle.sizeX / 2 ||
    point.z === rectangle.centerZ - rectangle.sizeZ / 2 ||
    point.z === rectangle.centerZ + rectangle.sizeZ / 2
  );
}
