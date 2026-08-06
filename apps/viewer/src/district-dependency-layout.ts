import {
  keyedBoundaryGateway,
  type RouteEndpointGeometry,
} from "./dependency-route-layout.js";

export interface DistrictDependencyPoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface DistrictDependencyTarget {
  readonly x: number;
  readonly z: number;
}

export interface DistrictDependencyRectangle {
  readonly centerX: number;
  readonly centerZ: number;
  readonly sizeX: number;
  readonly sizeZ: number;
}

export interface DistrictDependencyFootprint
  extends DistrictDependencyRectangle {
  /** Top of the visible district parcel, in scene coordinates. */
  readonly surfaceY: number;
  /** Highest visible point in this district, in scene coordinates. */
  readonly skylineY: number;
}

export interface DistrictDependencyEndpoints {
  readonly consumer: RouteEndpointGeometry;
  readonly provider: RouteEndpointGeometry;
}

const SKYLINE_CLEARANCE = 0.35;

/**
 * Places an endpoint on the district edge facing another point and above the
 * visible district skyline. The target only determines direction; even a
 * target inside the rectangle still produces a boundary endpoint.
 */
export function districtBoundaryAnchor(
  district: DistrictDependencyFootprint,
  toward: DistrictDependencyTarget,
): RouteEndpointGeometry {
  assertFootprint(district, "District");
  assertTarget(toward, "District route target");

  let deltaX = toward.x - district.centerX;
  let deltaZ = toward.z - district.centerZ;
  if (!Number.isFinite(deltaX) || !Number.isFinite(deltaZ)) {
    const coordinateScale = Math.max(
      Math.abs(toward.x),
      Math.abs(toward.z),
      Math.abs(district.centerX),
      Math.abs(district.centerZ),
    );
    deltaX =
      toward.x / coordinateScale - district.centerX / coordinateScale;
    deltaZ =
      toward.z / coordinateScale - district.centerZ / coordinateScale;
  }
  if (deltaX === 0 && deltaZ === 0) {
    // A deterministic fallback keeps malformed/coincident layouts finite.
    deltaZ = -1;
  }

  const halfX = district.sizeX * 0.5;
  const halfZ = district.sizeZ * 0.5;
  const scale = Math.min(
    deltaX === 0 ? Number.POSITIVE_INFINITY : halfX / Math.abs(deltaX),
    deltaZ === 0 ? Number.POSITIVE_INFINITY : halfZ / Math.abs(deltaZ),
  );

  const x = district.centerX + deltaX * scale;
  const z = district.centerZ + deltaZ * scale;
  return Object.freeze({
    contact: Object.freeze({ x, y: district.surfaceY, z }),
    anchor: Object.freeze({
      x,
      y: district.skylineY + SKYLINE_CLEARANCE,
      z,
    }),
  });
}

/**
 * Produces consumer-to-provider endpoints without routing through district
 * centers. Each endpoint independently clears its own skyline.
 */
export function districtRouteEndpoints(
  consumer: DistrictDependencyFootprint,
  provider: DistrictDependencyFootprint,
): DistrictDependencyEndpoints {
  assertFootprint(consumer, "Consumer district");
  assertFootprint(provider, "Provider district");
  return {
    consumer: districtBoundaryAnchor(consumer, {
      x: provider.centerX,
      z: provider.centerZ,
    }),
    provider: districtBoundaryAnchor(provider, {
      x: consumer.centerX,
      z: consumer.centerZ,
    }),
  };
}

/**
 * Places an external provider gateway deterministically on the city base. The
 * external key, rather than transient route order, selects its edge position.
 */
export function keyedBaseGateway(
  base: DistrictDependencyRectangle,
  externalKey: string,
  surfaceY: number,
  anchorY: number,
): RouteEndpointGeometry {
  assertRectangle(base, "City base");
  assertKey(externalKey);
  return keyedBoundaryGateway(
    base,
    externalKey,
    surfaceY,
    anchorY,
  );
}

function assertFootprint(
  district: DistrictDependencyFootprint,
  label: string,
): void {
  assertRectangle(district, label);
  assertFinite(district.surfaceY, `${label} surface`);
  assertFinite(district.skylineY, `${label} skyline`);
  if (district.skylineY < district.surfaceY) {
    throw new RangeError(
      `${label} skyline must not be below its surface.`,
    );
  }
  assertFinite(
    district.skylineY + SKYLINE_CLEARANCE,
    `${label} route height`,
  );
}

function assertRectangle(
  rectangle: DistrictDependencyRectangle,
  label: string,
): void {
  const values = [
    rectangle.centerX,
    rectangle.centerZ,
    rectangle.sizeX,
    rectangle.sizeZ,
  ];
  if (
    values.some((value) => !Number.isFinite(value)) ||
    rectangle.sizeX <= 0 ||
    rectangle.sizeZ <= 0 ||
    !Number.isFinite(rectangle.centerX - rectangle.sizeX * 0.5) ||
    !Number.isFinite(rectangle.centerX + rectangle.sizeX * 0.5) ||
    !Number.isFinite(rectangle.centerZ - rectangle.sizeZ * 0.5) ||
    !Number.isFinite(rectangle.centerZ + rectangle.sizeZ * 0.5)
  ) {
    throw new RangeError(
      `${label} rectangle must contain finite values and positive sizes.`,
    );
  }
}

function assertTarget(
  target: DistrictDependencyTarget,
  label: string,
): void {
  if (!Number.isFinite(target.x) || !Number.isFinite(target.z)) {
    throw new RangeError(`${label} must contain finite values.`);
  }
}

function assertKey(key: string): void {
  if (typeof key !== "string" || key.trim() === "") {
    throw new TypeError("Gateway key must not be empty.");
  }
}

function assertFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${label} must be finite.`);
  }
}
