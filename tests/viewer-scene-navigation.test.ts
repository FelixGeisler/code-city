import * as THREE from "three";
import { describe, expect, it } from "vitest";

import {
  cameraDistanceForBounds,
  cameraMaximumDistanceForFrame,
  focusedDistrictBounds,
  semanticPickingEnabled,
} from "../apps/viewer/src/scene-navigation.js";

describe("focusedDistrictBounds", () => {
  it("includes selected-district buildings and external nodes", () => {
    const district = new THREE.Mesh(
      new THREE.BoxGeometry(10, 1, 10),
    );
    district.position.y = 0.5;
    const tallBuildingBounds = new THREE.Box3(
      new THREE.Vector3(-1, 0, -1),
      new THREE.Vector3(1, 80, 1),
    );
    const external = new THREE.Mesh(new THREE.BoxGeometry(4, 4, 4));
    external.position.set(30, 2, 0);
    const requestedDistrictIds: string[] = [];

    const bounds = focusedDistrictBounds(
      "district-a",
      district,
      (districtId) => {
        requestedDistrictIds.push(districtId);
        return districtId === "district-a"
          ? tallBuildingBounds
          : undefined;
      },
      [external],
    );

    expect(requestedDistrictIds).toEqual(["district-a"]);
    expect(bounds.max.y).toBe(80);
    expect(bounds.max.x).toBe(32);
  });
});

describe("cameraDistanceForBounds", () => {
  it("uses horizontal field of view when a viewport is narrow", () => {
    const bounds = { x: 3, y: 3, z: 3 };

    const desktop = cameraDistanceForBounds(bounds, 45, 16 / 9);
    const mobile = cameraDistanceForBounds(bounds, 45, 390 / 844);

    expect(mobile).toBeGreaterThan(desktop * 1.9);
  });

  it("fits the complete bounding sphere with padding", () => {
    const bounds = { x: 8, y: 3, z: 5 };
    const aspect = 0.55;
    const padding = 1.18;
    const distance = cameraDistanceForBounds(
      bounds,
      45,
      aspect,
      padding,
    );
    const radius = Math.hypot(bounds.x, bounds.y, bounds.z) * 0.5;
    const verticalHalfFov = (45 * 0.5 * Math.PI) / 180;
    const horizontalHalfFov = Math.atan(
      Math.tan(verticalHalfFov) * aspect,
    );

    expect(radius / distance).toBeLessThanOrEqual(
      Math.sin(Math.min(verticalHalfFov, horizontalHalfFov)) / padding,
    );
  });

  it("returns a finite distance for flat and empty bounds", () => {
    expect(
      cameraDistanceForBounds({ x: 0, y: 0, z: 0 }, 45, 1),
    ).toBeGreaterThan(0);
    expect(
      cameraDistanceForBounds({ x: 0, y: 100, z: 0 }, 45, 2),
    ).toBeGreaterThan(100);
  });

  it("rejects invalid camera and bounds values", () => {
    expect(() =>
      cameraDistanceForBounds({ x: -1, y: 1, z: 1 }, 45, 1),
    ).toThrow(RangeError);
    expect(() =>
      cameraDistanceForBounds({ x: 1, y: 1, z: 1 }, 0, 1),
    ).toThrow(RangeError);
    expect(() =>
      cameraDistanceForBounds({ x: 1, y: 1, z: 1 }, 45, 0),
    ).toThrow(RangeError);
    expect(() =>
      cameraDistanceForBounds({ x: 1, y: 1, z: 1 }, 45, 1, 0.9),
    ).toThrow(RangeError);
  });
});

describe("cameraMaximumDistanceForFrame", () => {
  it("expands for a large print frame and restores the semantic range", () => {
    expect(cameraMaximumDistanceForFrame(40, 30)).toBe(150);
    expect(cameraMaximumDistanceForFrame(40, 4)).toBe(40);
  });

  it("rejects invalid distances", () => {
    expect(() => cameraMaximumDistanceForFrame(0, 4)).toThrow(RangeError);
    expect(() =>
      cameraMaximumDistanceForFrame(40, Number.NaN),
    ).toThrow(RangeError);
  });
});

describe("semanticPickingEnabled", () => {
  it("only exposes semantic city picking in city presentation mode", () => {
    expect(semanticPickingEnabled("city")).toBe(true);
    expect(semanticPickingEnabled("print")).toBe(false);
  });
});
