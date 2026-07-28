export interface RoutePoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface RouteBox {
  readonly position: RoutePoint;
  readonly size: RoutePoint;
}

export interface RouteRectangle {
  readonly centerX: number;
  readonly centerZ: number;
  readonly sizeX: number;
  readonly sizeZ: number;
}

const ROOF_CLEARANCE = 0.18;
const GATEWAY_EDGE_INSET = 0.08;

export function roofRoutePoint(box: RouteBox): RoutePoint {
  assertPoint(box.position, "Route box position");
  assertPoint(box.size, "Route box size");
  if (box.size.x < 0 || box.size.y < 0 || box.size.z < 0) {
    throw new RangeError("Route box size must be non-negative.");
  }
  return {
    x: box.position.x,
    y: box.position.y + box.size.y * 0.5 + ROOF_CLEARANCE,
    z: box.position.z,
  };
}

export function keyedBoundaryGateway(
  rectangle: RouteRectangle,
  key: string,
  y: number,
): RoutePoint {
  assertRectangle(rectangle);
  if (!Number.isFinite(y)) {
    throw new RangeError("Gateway height must be finite.");
  }

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

function assertRectangle(rectangle: RouteRectangle): void {
  const values = [
    rectangle.centerX,
    rectangle.centerZ,
    rectangle.sizeX,
    rectangle.sizeZ,
  ];
  if (
    values.some((value) => !Number.isFinite(value)) ||
    rectangle.sizeX <= 0 ||
    rectangle.sizeZ <= 0
  ) {
    throw new RangeError(
      "Route rectangle must contain finite values and positive sizes.",
    );
  }
}

function assertPoint(point: RoutePoint, label: string): void {
  if (
    !Number.isFinite(point.x) ||
    !Number.isFinite(point.y) ||
    !Number.isFinite(point.z)
  ) {
    throw new RangeError(`${label} must contain finite values.`);
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
