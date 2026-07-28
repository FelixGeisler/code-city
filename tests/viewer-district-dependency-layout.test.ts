import { describe, expect, it } from "vitest";

import {
  districtBoundaryAnchor,
  districtRouteEndpoints,
  keyedBaseGateway,
  keyedIsolationGateway,
  type DistrictDependencyRectangle,
} from "../apps/viewer/src/district-dependency-layout.js";

const base: DistrictDependencyRectangle = {
  centerX: 10,
  centerZ: 20,
  sizeX: 40,
  sizeZ: 30,
};

const consumer = {
  centerX: 0,
  centerZ: 0,
  sizeX: 10,
  sizeZ: 8,
  skylineY: 12,
};

describe("district dependency layout", () => {
  it("anchors toward the other point and clears the district skyline", () => {
    expect(
      districtBoundaryAnchor(consumer, { x: 20, z: 0 }),
    ).toEqual({
      x: 5,
      y: 12.35,
      z: 0,
    });

    const diagonal = districtBoundaryAnchor(consumer, {
      x: -20,
      z: 20,
    });
    expect(diagonal.x).toBe(-4);
    expect(diagonal.z).toBe(4);
    expect(diagonal.y).toBe(12.35);
    expect(isOnBoundary(diagonal, consumer)).toBe(true);
  });

  it("uses each district skyline for directed bundle endpoints", () => {
    const provider = {
      centerX: 20,
      centerZ: 0,
      sizeX: 6,
      sizeZ: 12,
      skylineY: 4,
    };

    expect(districtRouteEndpoints(consumer, provider)).toEqual({
      consumer: { x: 5, y: 12.35, z: 0 },
      provider: { x: 17, y: 4.35, z: 0 },
    });
  });

  it("places external gateways deterministically on the city base", () => {
    const first = keyedBaseGateway(base, "package:@angular/core", 1.2);
    const repeated = keyedBaseGateway(
      base,
      "package:@angular/core",
      1.2,
    );
    const other = keyedBaseGateway(base, "package:rxjs", 1.2);

    expect(repeated).toEqual(first);
    expect(other).not.toEqual(first);
    expect(first.y).toBe(1.2);
    expect(isOnBoundary(first, base)).toBe(true);
    expect(isOnBoundary(other, base)).toBe(true);
  });

  it("projects isolation routes using only visible geometry and a key", () => {
    const first = keyedIsolationGateway(consumer, "hidden:provider");
    const repeated = keyedIsolationGateway(
      consumer,
      "hidden:provider",
    );

    expect(repeated).toEqual(first);
    expect(first.y).toBe(12.35);
    expect(isOnBoundary(first, consumer)).toBe(true);
  });

  it("uses a finite deterministic fallback for coincident centers", () => {
    expect(
      districtBoundaryAnchor(consumer, {
        x: consumer.centerX,
        z: consumer.centerZ,
      }),
    ).toEqual({
      x: 0,
      y: 12.35,
      z: -4,
    });
  });

  it("rejects non-finite or non-positive geometry", () => {
    expect(() =>
      districtBoundaryAnchor(
        { ...consumer, sizeX: 0 },
        { x: 1, z: 1 },
      ),
    ).toThrow(RangeError);
    expect(() =>
      districtBoundaryAnchor(
        { ...consumer, skylineY: Number.POSITIVE_INFINITY },
        { x: 1, z: 1 },
      ),
    ).toThrow(RangeError);
    expect(() =>
      districtBoundaryAnchor(consumer, {
        x: Number.NaN,
        z: 1,
      }),
    ).toThrow(RangeError);
    expect(() =>
      keyedBaseGateway(
        { ...base, sizeZ: -1 },
        "external",
        1,
      ),
    ).toThrow(RangeError);
    expect(() =>
      keyedBaseGateway(base, " ", 1),
    ).toThrow(TypeError);
    expect(() =>
      keyedBaseGateway(base, "external", Number.NaN),
    ).toThrow(RangeError);
  });
});

function isOnBoundary(
  point: { readonly x: number; readonly z: number },
  rectangle: DistrictDependencyRectangle,
): boolean {
  return (
    point.x === rectangle.centerX - rectangle.sizeX / 2 ||
    point.x === rectangle.centerX + rectangle.sizeX / 2 ||
    point.z === rectangle.centerZ - rectangle.sizeZ / 2 ||
    point.z === rectangle.centerZ + rectangle.sizeZ / 2
  );
}
