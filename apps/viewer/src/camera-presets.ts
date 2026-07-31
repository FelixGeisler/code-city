import * as THREE from "three";

import type { BoundsSize } from "./scene-navigation.js";

export type CameraProjection = "orthographic" | "perspective";
export type CameraPreset =
  | "isometric"
  | "selected-entity"
  | "top-down"
  | "whole-city";

export interface CameraOrientation {
  readonly direction: THREE.Vector3;
  readonly up: THREE.Vector3;
}

const MINIMUM_RADIUS = 0.5;
const DEFAULT_PADDING = 1.18;
const FALLBACK_DIRECTION = new THREE.Vector3(1, 1, 1).normalize();
const FALLBACK_UP = new THREE.Vector3(0, 1, 0);

export function cameraOrientationForPreset(
  preset: CameraPreset,
  currentDirection: THREE.Vector3,
  currentUp: THREE.Vector3,
): CameraOrientation {
  const current = normalizedVector(
    currentDirection,
    FALLBACK_DIRECTION,
    "Camera direction",
  );
  const up = normalizedVector(currentUp, FALLBACK_UP, "Camera up vector");
  switch (preset) {
    case "isometric":
      return {
        direction: new THREE.Vector3(1, 1, 1).normalize(),
        up: new THREE.Vector3(0, 1, 0),
      };
    case "top-down":
      return {
        direction: new THREE.Vector3(0, 1, 0),
        up: new THREE.Vector3(0, 0, -1),
      };
    case "selected-entity":
    case "whole-city":
      return { direction: current, up };
  }
}

export function orthographicViewHeightForBounds(
  size: BoundsSize,
  aspect: number,
  padding = DEFAULT_PADDING,
): number {
  validateBounds(size);
  validateAspect(aspect);
  validatePadding(padding);
  const diameter =
    Math.max(Math.hypot(size.x, size.y, size.z) * 0.5, MINIMUM_RADIUS) *
    2;
  return diameter * padding * Math.max(1, 1 / aspect);
}

export function orthographicViewHeightForOrientedBounds(
  size: BoundsSize,
  aspect: number,
  direction: THREE.Vector3,
  up: THREE.Vector3,
  padding = DEFAULT_PADDING,
): number {
  validateBounds(size);
  validateAspect(aspect);
  validatePadding(padding);
  const cameraDirection = normalizedVector(
    direction,
    FALLBACK_DIRECTION,
    "Camera direction",
  );
  const requestedUp = normalizedVector(
    up,
    FALLBACK_UP,
    "Camera up vector",
  );
  let right = requestedUp.clone().cross(cameraDirection);
  if (right.lengthSq() < 1e-12) {
    const fallbackUp =
      Math.abs(cameraDirection.y) < 0.9
        ? new THREE.Vector3(0, 1, 0)
        : new THREE.Vector3(0, 0, -1);
    right = fallbackUp.cross(cameraDirection);
  }
  right.normalize();
  const cameraUp = cameraDirection.clone().cross(right).normalize();
  const halfWidth =
    (Math.abs(right.x) * size.x +
      Math.abs(right.y) * size.y +
      Math.abs(right.z) * size.z) /
    2;
  const halfHeight =
    (Math.abs(cameraUp.x) * size.x +
      Math.abs(cameraUp.y) * size.y +
      Math.abs(cameraUp.z) * size.z) /
    2;
  return (
    Math.max(
      halfHeight * 2,
      (halfWidth * 2) / aspect,
      MINIMUM_RADIUS * 2,
    ) * padding
  );
}

export function perspectiveViewHeightAtDistance(
  distance: number,
  verticalFovDegrees: number,
): number {
  validateDistance(distance);
  const halfFov = verticalHalfFov(verticalFovDegrees);
  return 2 * distance * Math.tan(halfFov);
}

export function perspectiveDistanceForViewHeight(
  viewHeight: number,
  verticalFovDegrees: number,
): number {
  validateDistance(viewHeight);
  const halfFov = verticalHalfFov(verticalFovDegrees);
  return viewHeight / (2 * Math.tan(halfFov));
}

export function orthographicCameraDistanceForBounds(
  size: BoundsSize,
): number {
  validateBounds(size);
  return Math.max(Math.hypot(size.x, size.y, size.z) * 2, 10);
}

function normalizedVector(
  value: THREE.Vector3,
  fallback: THREE.Vector3,
  label: string,
): THREE.Vector3 {
  if (![value.x, value.y, value.z].every(Number.isFinite)) {
    throw new RangeError(`${label} must be finite.`);
  }
  return value.lengthSq() < 1e-12
    ? fallback.clone()
    : value.clone().normalize();
}

function validateBounds(size: BoundsSize): void {
  if (
    ![size.x, size.y, size.z].every(Number.isFinite) ||
    size.x < 0 ||
    size.y < 0 ||
    size.z < 0
  ) {
    throw new RangeError(
      "Bounds size must contain finite non-negative values.",
    );
  }
}

function validateAspect(aspect: number): void {
  if (!Number.isFinite(aspect) || aspect <= 0) {
    throw new RangeError("Camera aspect ratio must be positive.");
  }
}

function validatePadding(padding: number): void {
  if (!Number.isFinite(padding) || padding < 1) {
    throw new RangeError("Camera padding must be at least 1.");
  }
}

function validateDistance(value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError("Camera distance must be finite and positive.");
  }
}

function verticalHalfFov(verticalFovDegrees: number): number {
  if (
    !Number.isFinite(verticalFovDegrees) ||
    verticalFovDegrees <= 0 ||
    verticalFovDegrees >= 180
  ) {
    throw new RangeError("Vertical field of view must be between 0 and 180.");
  }
  return (verticalFovDegrees * Math.PI) / 360;
}
