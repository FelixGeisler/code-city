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
  /** Highest visible point in this district, in scene coordinates. */
  readonly skylineY: number;
}

export interface DistrictDependencyEndpoints {
  readonly consumer: DistrictDependencyPoint;
  readonly provider: DistrictDependencyPoint;
}

const SKYLINE_CLEARANCE = 0.35;
const GATEWAY_EDGE_INSET = 0.08;

/**
 * Places an endpoint on the district edge facing another point and above the
 * visible district skyline. The target only determines direction; even a
 * target inside the rectangle still produces a boundary endpoint.
 */
export function districtBoundaryAnchor(
  district: DistrictDependencyFootprint,
  toward: DistrictDependencyTarget,
): DistrictDependencyPoint {
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

  return {
    x: district.centerX + deltaX * scale,
    y: district.skylineY + SKYLINE_CLEARANCE,
    z: district.centerZ + deltaZ * scale,
  };
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
  y: number,
): DistrictDependencyPoint {
  assertRectangle(base, "City base");
  assertKey(externalKey);
  assertFinite(y, "Gateway height");
  return keyedBoundaryPoint(base, externalKey, y);
}

/**
 * Projects a hidden isolation endpoint onto the visible district boundary.
 * No hidden district coordinates are accepted, so this function cannot leak
 * hidden geometry into the isolated view.
 */
export function keyedIsolationGateway(
  visibleDistrict: DistrictDependencyFootprint,
  hiddenDistrictKey: string,
): DistrictDependencyPoint {
  assertFootprint(visibleDistrict, "Visible district");
  assertKey(hiddenDistrictKey);
  return keyedBoundaryPoint(
    visibleDistrict,
    hiddenDistrictKey,
    visibleDistrict.skylineY + SKYLINE_CLEARANCE,
  );
}

function keyedBoundaryPoint(
  rectangle: DistrictDependencyRectangle,
  key: string,
  y: number,
): DistrictDependencyPoint {
  const hash = stableHash(key);
  const side = hash % 4;
  const fraction =
    GATEWAY_EDGE_INSET +
    hashFraction(`${key}\u0000position`) *
      (1 - GATEWAY_EDGE_INSET * 2);
  const halfX = rectangle.sizeX * 0.5;
  const halfZ = rectangle.sizeZ * 0.5;

  switch (side) {
    case 0:
      return {
        x: rectangle.centerX - halfX + rectangle.sizeX * fraction,
        y,
        z: rectangle.centerZ - halfZ,
      };
    case 1:
      return {
        x: rectangle.centerX + halfX,
        y,
        z: rectangle.centerZ - halfZ + rectangle.sizeZ * fraction,
      };
    case 2:
      return {
        x: rectangle.centerX + halfX - rectangle.sizeX * fraction,
        y,
        z: rectangle.centerZ + halfZ,
      };
    default:
      return {
        x: rectangle.centerX - halfX,
        y,
        z: rectangle.centerZ + halfZ - rectangle.sizeZ * fraction,
      };
  }
}

function assertFootprint(
  district: DistrictDependencyFootprint,
  label: string,
): void {
  assertRectangle(district, label);
  assertFinite(district.skylineY, `${label} skyline`);
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

function hashFraction(value: string): number {
  return stableHash(value) / 0xffff_ffff;
}

function stableHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
