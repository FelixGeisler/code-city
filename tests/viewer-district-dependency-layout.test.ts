import { describe, expect, it } from "vitest";

import {
  districtBoundaryAnchor,
  districtRouteEndpoints,
  keyedBaseGateway,
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
  surfaceY: 1,
  skylineY: 12,
};

describe("district dependency layout", () => {
  it("anchors toward the other point and clears the district skyline", () => {
    expect(
      districtBoundaryAnchor(consumer, { x: 20, z: 0 }),
    ).toEqual({
      contact: { x: 5, y: 1, z: 0 },
      anchor: { x: 5, y: 12.35, z: 0 },
    });

    const diagonal = districtBoundaryAnchor(consumer, {
      x: -20,
      z: 20,
    });
    expect(diagonal.contact).toEqual({ x: -4, y: 1, z: 4 });
    expect(diagonal.anchor).toEqual({ x: -4, y: 12.35, z: 4 });
    expect(isOnBoundary(diagonal.contact, consumer)).toBe(true);
  });

  it("uses each district skyline for directed bundle endpoints", () => {
    const provider = {
      centerX: 20,
      centerZ: 0,
      sizeX: 6,
      sizeZ: 12,
      surfaceY: 1.5,
      skylineY: 4,
    };

    expect(districtRouteEndpoints(consumer, provider)).toEqual({
      consumer: {
        contact: { x: 5, y: 1, z: 0 },
        anchor: { x: 5, y: 12.35, z: 0 },
      },
      provider: {
        contact: { x: 17, y: 1.5, z: 0 },
        anchor: { x: 17, y: 4.35, z: 0 },
      },
    });
  });

  it("grounds external gateways deterministically on the city base", () => {
    const first = keyedBaseGateway(
      base,
      "package:@angular/core",
      0.5,
      4.2,
    );
    const repeated = keyedBaseGateway(
      base,
      "package:@angular/core",
      0.5,
      4.2,
    );
    const other = keyedBaseGateway(
      base,
      "package:rxjs",
      0.5,
      4.2,
    );

    expect(repeated).toEqual(first);
    expect(other).not.toEqual(first);
    expect(first.contact.y).toBe(0.5);
    expect(first.anchor.y).toBe(4.2);
    expect(isOnBoundary(first.contact, base)).toBe(true);
    expect(isOnBoundary(other.contact, base)).toBe(true);
  });

  it("uses a finite deterministic fallback for coincident centers", () => {
    expect(
      districtBoundaryAnchor(consumer, {
        x: consumer.centerX,
        z: consumer.centerZ,
      }),
    ).toEqual({
      contact: { x: 0, y: 1, z: -4 },
      anchor: { x: 0, y: 12.35, z: -4 },
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
        2,
      ),
    ).toThrow(RangeError);
    expect(() =>
      keyedBaseGateway(base, " ", 1, 2),
    ).toThrow(TypeError);
    expect(() =>
      keyedBaseGateway(base, "external", 1, Number.NaN),
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
