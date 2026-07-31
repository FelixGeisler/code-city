import * as THREE from "three";
import { describe, expect, it } from "vitest";

import {
  cameraOrientationForPreset,
  orthographicCameraDistanceForBounds,
  orthographicViewHeightForBounds,
  orthographicViewHeightForOrientedBounds,
  perspectiveDistanceForViewHeight,
  perspectiveViewHeightAtDistance,
} from "../apps/viewer/src/camera-presets.js";

describe("camera presets", () => {
  it("uses reproducible semantic orientations for isometric and top-down views", () => {
    const current = new THREE.Vector3(-4, 3, 8);
    const up = new THREE.Vector3(0, 1, 0);

    const isometric = cameraOrientationForPreset(
      "isometric",
      current,
      up,
    );
    const topDown = cameraOrientationForPreset("top-down", current, up);

    expect(isometric.direction.toArray()).toEqual([
      1 / Math.sqrt(3),
      1 / Math.sqrt(3),
      1 / Math.sqrt(3),
    ]);
    expect(isometric.up.toArray()).toEqual([0, 1, 0]);
    expect(topDown.direction.toArray()).toEqual([0, 1, 0]);
    expect(topDown.up.toArray()).toEqual([0, 0, -1]);
  });

  it("preserves meaningful current orientation for entity and whole-city framing", () => {
    const current = new THREE.Vector3(-4, 3, 8);
    const up = new THREE.Vector3(0.2, 1, 0.1);

    for (const preset of ["selected-entity", "whole-city"] as const) {
      const orientation = cameraOrientationForPreset(preset, current, up);
      expect(orientation.direction.length()).toBeCloseTo(1, 12);
      expect(orientation.direction.dot(current.clone().normalize())).toBeCloseTo(
        1,
        12,
      );
      expect(orientation.up.dot(up.clone().normalize())).toBeCloseTo(1, 12);
    }
  });

  it("preserves visible vertical scale across projection changes", () => {
    const distance = 42;
    const height = perspectiveViewHeightAtDistance(distance, 45);

    expect(perspectiveDistanceForViewHeight(height, 45)).toBeCloseTo(
      distance,
      12,
    );
  });

  it("fits the same bounding sphere for wide and narrow orthographic outputs", () => {
    const size = { x: 20, y: 8, z: 12 };
    const wide = orthographicViewHeightForBounds(size, 16 / 9);
    const narrow = orthographicViewHeightForBounds(size, 9 / 16);

    expect(narrow).toBeGreaterThan(wide);
    expect(orthographicCameraDistanceForBounds(size)).toBeGreaterThan(
      Math.hypot(size.x, size.y, size.z),
    );
  });

  it("fits top-down footprints without shrinking them for vertical height", () => {
    const height = orthographicViewHeightForOrientedBounds(
      { x: 20, y: 200, z: 12 },
      16 / 9,
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(0, 0, -1),
    );

    expect(height).toBeCloseTo(12 * 1.18, 12);
  });

  it("rejects invalid framing inputs", () => {
    expect(() =>
      orthographicViewHeightForBounds({ x: -1, y: 1, z: 1 }, 1),
    ).toThrow(RangeError);
    expect(() =>
      perspectiveViewHeightAtDistance(0, 45),
    ).toThrow(RangeError);
    expect(() =>
      perspectiveDistanceForViewHeight(10, 180),
    ).toThrow(RangeError);
    expect(() =>
      cameraOrientationForPreset(
        "whole-city",
        new THREE.Vector3(Number.NaN, 0, 1),
        new THREE.Vector3(0, 1, 0),
      ),
    ).toThrow(RangeError);
  });
});
