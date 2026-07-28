export interface RoutePoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface RouteBox {
  readonly position: RoutePoint;
  readonly size: RoutePoint;
}

export interface RouteEndpointGeometry {
  readonly contact: RoutePoint;
  readonly anchor: RoutePoint;
}

export interface RouteRectangle {
  readonly centerX: number;
  readonly centerZ: number;
  readonly sizeX: number;
  readonly sizeZ: number;
}

const GATEWAY_EDGE_INSET = 0.08;

export function buildingRouteEndpoint(
  box: RouteBox,
): RouteEndpointGeometry {
  assertPoint(box.position, "Route box position");
  assertPoint(box.size, "Route box size");
  if (box.size.x < 0 || box.size.y < 0 || box.size.z < 0) {
    throw new RangeError("Route box size must be non-negative.");
  }
  const roof = Object.freeze({
    x: box.position.x,
    y: box.position.y + box.size.y * 0.5,
    z: box.position.z,
  });
  return Object.freeze({ contact: roof, anchor: roof });
}

export function routeEndpointKey(
  kind: "building" | "district" | "external",
  stableId: string,
): string {
  if (stableId.trim() === "") {
    throw new TypeError("Route endpoint stable id must not be empty.");
  }
  return `${kind}\u0000${stableId}`;
}

export function keyedBoundaryGateway(
  rectangle: RouteRectangle,
  key: string,
  surfaceY: number,
  anchorY: number,
): RouteEndpointGeometry {
  assertRectangle(rectangle);
  if (key.trim() === "") {
    throw new TypeError("Gateway key must not be empty.");
  }
  if (!Number.isFinite(surfaceY) || !Number.isFinite(anchorY)) {
    throw new RangeError("Gateway heights must be finite.");
  }
  if (anchorY < surfaceY) {
    throw new RangeError(
      "Gateway anchor must not be below its surface contact.",
    );
  }

  const hash = stableHash(key);
  const side = hash % 4;
  const fraction =
    GATEWAY_EDGE_INSET +
    hashFraction(`${key}\u0000position`) *
      (1 - GATEWAY_EDGE_INSET * 2);
  const halfX = rectangle.sizeX * 0.5;
  const halfZ = rectangle.sizeZ * 0.5;

  let x: number;
  let z: number;
  switch (side) {
    case 0:
      x = rectangle.centerX - halfX + rectangle.sizeX * fraction;
      z = rectangle.centerZ - halfZ;
      break;
    case 1:
      x = rectangle.centerX + halfX;
      z = rectangle.centerZ - halfZ + rectangle.sizeZ * fraction;
      break;
    case 2:
      x = rectangle.centerX + halfX - rectangle.sizeX * fraction;
      z = rectangle.centerZ + halfZ;
      break;
    default:
      x = rectangle.centerX - halfX;
      z = rectangle.centerZ + halfZ - rectangle.sizeZ * fraction;
      break;
  }
  return Object.freeze({
    contact: Object.freeze({ x, y: surfaceY, z }),
    anchor: Object.freeze({ x, y: anchorY, z }),
  });
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
