export interface BoundsSize {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export type ScenePresentationMode = "city" | "print";

export function semanticPickingEnabled(
  mode: ScenePresentationMode,
): boolean {
  return mode === "city";
}

const MINIMUM_RADIUS = 0.5;
const DEFAULT_PADDING = 1.18;
const MINIMUM_MAXIMUM_DISTANCE = 20;
const FRAME_DISTANCE_MULTIPLIER = 5;

export function cameraMaximumDistanceForFrame(
  semanticCityMaximumDistance: number,
  frameDistance: number,
): number {
  if (
    !Number.isFinite(semanticCityMaximumDistance) ||
    semanticCityMaximumDistance <= 0 ||
    !Number.isFinite(frameDistance) ||
    frameDistance <= 0
  ) {
    throw new RangeError("Camera distances must be finite and positive.");
  }
  return Math.max(
    semanticCityMaximumDistance,
    frameDistance * FRAME_DISTANCE_MULTIPLIER,
    MINIMUM_MAXIMUM_DISTANCE,
  );
}

export function cameraDistanceForBounds(
  size: BoundsSize,
  verticalFovDegrees: number,
  aspect: number,
  padding = DEFAULT_PADDING,
): number {
  if (
    !Number.isFinite(size.x) ||
    !Number.isFinite(size.y) ||
    !Number.isFinite(size.z) ||
    size.x < 0 ||
    size.y < 0 ||
    size.z < 0
  ) {
    throw new RangeError("Bounds size must contain finite non-negative values.");
  }
  if (
    !Number.isFinite(verticalFovDegrees) ||
    verticalFovDegrees <= 0 ||
    verticalFovDegrees >= 180
  ) {
    throw new RangeError("Vertical field of view must be between 0 and 180.");
  }
  if (!Number.isFinite(aspect) || aspect <= 0) {
    throw new RangeError("Camera aspect ratio must be positive.");
  }
  if (!Number.isFinite(padding) || padding < 1) {
    throw new RangeError("Camera padding must be at least 1.");
  }

  const radius = Math.max(
    Math.hypot(size.x, size.y, size.z) * 0.5,
    MINIMUM_RADIUS,
  );
  const verticalHalfFov = degreesToRadians(verticalFovDegrees * 0.5);
  const horizontalHalfFov = Math.atan(
    Math.tan(verticalHalfFov) * aspect,
  );
  const limitingHalfFov = Math.min(verticalHalfFov, horizontalHalfFov);

  return (radius * padding) / Math.sin(limitingHalfFov);
}

function degreesToRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}
