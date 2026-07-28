import { describe, expect, it } from "vitest";

import {
  buildingRouteEndpoint,
  keyedBoundaryGateway,
  routeEndpointKey,
} from "../apps/viewer/src/dependency-route-layout.js";

const rectangle = {
  centerX: 10,
  centerZ: 20,
  sizeX: 20,
  sizeZ: 10,
};

describe("dependency route layout", () => {
  it("uses the exact building roof as contact and anchor", () => {
    expect(
      buildingRouteEndpoint({
        position: { x: 4, y: 6, z: -2 },
        size: { x: 3, y: 8, z: 5 },
      }),
    ).toEqual({
      contact: { x: 4, y: 10, z: -2 },
      anchor: { x: 4, y: 10, z: -2 },
    });
  });

  it("grounds deterministic boundary gateways on an outer edge", () => {
    const first = keyedBoundaryGateway(
      rectangle,
      "@angular/core",
      1.5,
      4.5,
    );
    const repeated = keyedBoundaryGateway(
      rectangle,
      "@angular/core",
      1.5,
      4.5,
    );

    expect(repeated).toEqual(first);
    expect(isOnBoundary(first.contact)).toBe(true);
    expect(first.contact.y).toBe(1.5);
    expect(first.anchor.y).toBe(4.5);
    expect(first.anchor.x).toBe(first.contact.x);
    expect(first.anchor.z).toBe(first.contact.z);
  });

  it("creates documented NUL-separated endpoint keys", () => {
    expect(routeEndpointKey("building", "building-a")).toBe(
      "building\u0000building-a",
    );
    expect(routeEndpointKey("district", "district-a")).toBe(
      "district\u0000district-a",
    );
    expect(routeEndpointKey("external", "@scope/package")).toBe(
      "external\u0000@scope/package",
    );
    expect(() => routeEndpointKey("building", " ")).toThrow(TypeError);
  });

  it("rejects invalid geometry", () => {
    expect(() =>
      keyedBoundaryGateway(
        { ...rectangle, sizeX: 0 },
        "invalid",
        1,
        2,
      ),
    ).toThrow(RangeError);
    expect(() =>
      buildingRouteEndpoint({
        position: { x: 0, y: 0, z: 0 },
        size: { x: 1, y: -1, z: 1 },
      }),
    ).toThrow(RangeError);
    expect(() =>
      keyedBoundaryGateway(rectangle, "valid", 2, 1),
    ).toThrow(/below/u);
    expect(() =>
      keyedBoundaryGateway(rectangle, " ", 1, 2),
    ).toThrow(TypeError);
    expect(() =>
      keyedBoundaryGateway(rectangle, "valid", 1, Number.NaN),
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
