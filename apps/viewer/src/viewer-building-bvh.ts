export interface BuildingBvhPoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface BuildingBvhBounds {
  readonly id: string;
  readonly districtId: string;
  readonly min: BuildingBvhPoint;
  readonly max: BuildingBvhPoint;
}

export interface BuildingBvhRay {
  readonly origin: BuildingBvhPoint;
  readonly direction: BuildingBvhPoint;
}

export interface BuildingBvhHit {
  readonly id: string;
  readonly districtId: string;
  /** World-space distance from the ray origin to the first positive hit. */
  readonly distance: number;
}

export interface BuildingBvhPickOptions {
  readonly districtId?: string;
  /**
   * Optional exact visibility filter. An empty set deliberately makes every
   * building unpickable.
   */
  readonly buildingIds?: ReadonlySet<string>;
  readonly maximumDistance?: number;
}

export interface BuildingBvhPickResult {
  readonly hit: BuildingBvhHit | null;
  /** Number of node and building AABBs tested by this query. */
  readonly aabbTests: number;
}

interface CanonicalBounds extends BuildingBvhBounds {
  readonly center: BuildingBvhPoint;
}

interface BvhNode {
  readonly min: BuildingBvhPoint;
  readonly max: BuildingBvhPoint;
  readonly districtId: string | null;
  readonly left?: BvhNode;
  readonly right?: BvhNode;
  readonly entries?: readonly CanonicalBounds[];
}

interface RayComponents {
  readonly ox: number;
  readonly oy: number;
  readonly oz: number;
  readonly dx: number;
  readonly dy: number;
  readonly dz: number;
}

interface PendingNode {
  readonly node: BvhNode;
  readonly distance: number;
}

const DEFAULT_LEAF_SIZE = 8;
/**
 * Immutable deterministic AABB index for axis-aligned code-city buildings.
 *
 * Input is canonicalized by ID before construction, so tree shape, lookup,
 * traversal, and tie-breaking do not depend on model input order.
 */
export class BuildingAabbBvh {
  private readonly root: BvhNode | null;
  private readonly boundsById: ReadonlyMap<string, CanonicalBounds>;

  public constructor(
    bounds: readonly BuildingBvhBounds[],
    leafSize = DEFAULT_LEAF_SIZE,
  ) {
    if (!Number.isSafeInteger(leafSize) || leafSize < 1) {
      throw new RangeError("BVH leaf size must be a positive safe integer.");
    }

    const canonical = bounds.map(canonicalBounds).sort(compareBoundsById);
    const byId = new Map<string, CanonicalBounds>();
    for (const entry of canonical) {
      if (byId.has(entry.id)) {
        throw new TypeError(`Duplicate building bounds ID "${entry.id}".`);
      }
      byId.set(entry.id, entry);
    }

    this.boundsById = byId;
    this.root =
      canonical.length === 0 ? null : buildNode(canonical, leafSize);
  }

  public get size(): number {
    return this.boundsById.size;
  }

  public bounds(id: string): BuildingBvhBounds | undefined {
    return this.boundsById.get(id);
  }

  public pick(
    ray: BuildingBvhRay,
    options: BuildingBvhPickOptions = {},
  ): BuildingBvhPickResult {
    const components = normalizeRay(ray);
    const districtId = normalizedOptionalId(
      options.districtId,
      "District filter",
    );
    const maximumDistance =
      options.maximumDistance === undefined
        ? Number.POSITIVE_INFINITY
        : positiveDistance(options.maximumDistance);
    const buildingIds = options.buildingIds;
    const root = this.root;
    if (root === null || buildingIds?.size === 0) {
      return Object.freeze({ hit: null, aabbTests: 0 });
    }
    if (
      districtId !== undefined &&
      root.districtId !== null &&
      root.districtId !== districtId
    ) {
      return Object.freeze({ hit: null, aabbTests: 0 });
    }

    let aabbTests = 1;
    const rootDistance = rayNodeEntryDistance(
      components,
      root.min,
      root.max,
    );
    if (rootDistance === null || rootDistance > maximumDistance) {
      return Object.freeze({ hit: null, aabbTests });
    }

    let best: CanonicalBounds | null = null;
    let bestDistance = maximumDistance;
    const pending: PendingNode[] = [{ node: root, distance: rootDistance }];

    while (pending.length > 0) {
      const current = pending.pop()!;
      if (current.distance > bestDistance) {
        continue;
      }
      const node = current.node;
      if (
        districtId !== undefined &&
        node.districtId !== null &&
        node.districtId !== districtId
      ) {
        continue;
      }

      if (node.entries !== undefined) {
        for (const entry of node.entries) {
          if (
            (districtId !== undefined &&
              entry.districtId !== districtId) ||
            (buildingIds !== undefined && !buildingIds.has(entry.id))
          ) {
            continue;
          }
          aabbTests += 1;
          const distance = rayBuildingHitDistance(
            components,
            entry.min,
            entry.max,
          );
          if (
            distance !== null &&
            distance <= bestDistance &&
            isBetterHit(entry, distance, best, bestDistance)
          ) {
            best = entry;
            bestDistance = distance;
          }
        }
        continue;
      }

      const candidates: PendingNode[] = [];
      for (const child of [node.left, node.right]) {
        if (
          child === undefined ||
          (districtId !== undefined &&
            child.districtId !== null &&
            child.districtId !== districtId)
        ) {
          continue;
        }
        aabbTests += 1;
        const distance = rayNodeEntryDistance(
          components,
          child.min,
          child.max,
        );
        if (distance !== null && distance <= bestDistance) {
          candidates.push({ node: child, distance });
        }
      }
      candidates.sort(comparePendingNodes);
      for (let index = candidates.length - 1; index >= 0; index -= 1) {
        pending.push(candidates[index]!);
      }
    }

    return Object.freeze({
      hit:
        best === null
          ? null
          : Object.freeze({
              id: best.id,
              districtId: best.districtId,
              distance: bestDistance,
            }),
      aabbTests,
    });
  }
}

function canonicalBounds(value: BuildingBvhBounds): CanonicalBounds {
  const id = requiredId(value?.id, "Building bounds ID");
  const districtId = requiredId(
    value?.districtId,
    `District ID for building "${id}"`,
  );
  const min = canonicalPoint(value?.min, `Minimum bounds for "${id}"`);
  const max = canonicalPoint(value?.max, `Maximum bounds for "${id}"`);
  if (min.x > max.x || min.y > max.y || min.z > max.z) {
    throw new RangeError(
      `Building bounds for "${id}" must have min <= max on every axis.`,
    );
  }
  return Object.freeze({
    id,
    districtId,
    min,
    max,
    center: Object.freeze({
      x: min.x + (max.x - min.x) * 0.5,
      y: min.y + (max.y - min.y) * 0.5,
      z: min.z + (max.z - min.z) * 0.5,
    }),
  });
}

function canonicalPoint(
  value: BuildingBvhPoint,
  label: string,
): BuildingBvhPoint {
  if (
    value === null ||
    typeof value !== "object" ||
    !Number.isFinite(value.x) ||
    !Number.isFinite(value.y) ||
    !Number.isFinite(value.z)
  ) {
    throw new RangeError(`${label} must contain finite coordinates.`);
  }
  return Object.freeze({ x: value.x, y: value.y, z: value.z });
}

function buildNode(
  entries: readonly CanonicalBounds[],
  leafSize: number,
): BvhNode {
  const nodeBounds = enclosingBounds(entries);
  const districtId = commonDistrict(entries);
  if (entries.length <= leafSize) {
    return Object.freeze({
      ...nodeBounds,
      districtId,
      entries: Object.freeze([...entries].sort(compareBoundsById)),
    });
  }

  const axis = longestCenterAxis(entries);
  const ordered = [...entries].sort((left, right) => {
    const difference = left.center[axis] - right.center[axis];
    return difference === 0 ? compareBoundsById(left, right) : difference;
  });
  const middle = Math.floor(ordered.length / 2);
  return Object.freeze({
    ...nodeBounds,
    districtId,
    left: buildNode(ordered.slice(0, middle), leafSize),
    right: buildNode(ordered.slice(middle), leafSize),
  });
}

function enclosingBounds(
  entries: readonly CanonicalBounds[],
): Pick<BvhNode, "min" | "max"> {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (const entry of entries) {
    minX = Math.min(minX, entry.min.x);
    minY = Math.min(minY, entry.min.y);
    minZ = Math.min(minZ, entry.min.z);
    maxX = Math.max(maxX, entry.max.x);
    maxY = Math.max(maxY, entry.max.y);
    maxZ = Math.max(maxZ, entry.max.z);
  }
  return {
    min: Object.freeze({ x: minX, y: minY, z: minZ }),
    max: Object.freeze({ x: maxX, y: maxY, z: maxZ }),
  };
}

function commonDistrict(
  entries: readonly CanonicalBounds[],
): string | null {
  const first = entries[0]!.districtId;
  return entries.every(({ districtId }) => districtId === first)
    ? first
    : null;
}

function longestCenterAxis(
  entries: readonly CanonicalBounds[],
): "x" | "y" | "z" {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (const { center } of entries) {
    minX = Math.min(minX, center.x);
    minY = Math.min(minY, center.y);
    minZ = Math.min(minZ, center.z);
    maxX = Math.max(maxX, center.x);
    maxY = Math.max(maxY, center.y);
    maxZ = Math.max(maxZ, center.z);
  }
  const xExtent = maxX - minX;
  const yExtent = maxY - minY;
  const zExtent = maxZ - minZ;
  if (xExtent >= yExtent && xExtent >= zExtent) return "x";
  return yExtent >= zExtent ? "y" : "z";
}

function normalizeRay(ray: BuildingBvhRay): RayComponents {
  const origin = canonicalPoint(ray?.origin, "Ray origin");
  const direction = canonicalPoint(ray?.direction, "Ray direction");
  const length = Math.hypot(direction.x, direction.y, direction.z);
  if (length === 0) {
    throw new RangeError("Ray direction must be non-zero.");
  }
  return {
    ox: origin.x,
    oy: origin.y,
    oz: origin.z,
    dx: direction.x / length,
    dy: direction.y / length,
    dz: direction.z / length,
  };
}

/**
 * Returns the earliest non-negative distance at which the ray occupies a
 * node's bounds. A ray that begins inside therefore enters at distance zero.
 */
function rayNodeEntryDistance(
  ray: RayComponents,
  min: BuildingBvhPoint,
  max: BuildingBvhPoint,
): number | null {
  return rayBoundsDistance(ray, min, max, "node-entry");
}

/**
 * Returns the first strictly positive surface hit for an actual building.
 * A ray that begins inside the building hits its positive exit surface.
 */
function rayBuildingHitDistance(
  ray: RayComponents,
  min: BuildingBvhPoint,
  max: BuildingBvhPoint,
): number | null {
  return rayBoundsDistance(ray, min, max, "building-hit");
}

function rayBoundsDistance(
  ray: RayComponents,
  min: BuildingBvhPoint,
  max: BuildingBvhPoint,
  purpose: "node-entry" | "building-hit",
): number | null {
  let entry = Number.NEGATIVE_INFINITY;
  let exit = Number.POSITIVE_INFINITY;
  for (const [origin, direction, lower, upper] of [
    [ray.ox, ray.dx, min.x, max.x],
    [ray.oy, ray.dy, min.y, max.y],
    [ray.oz, ray.dz, min.z, max.z],
  ] as const) {
    if (direction === 0) {
      if (origin < lower || origin > upper) return null;
      continue;
    }
    let near = (lower - origin) / direction;
    let far = (upper - origin) / direction;
    if (near > far) [near, far] = [far, near];
    entry = Math.max(entry, near);
    exit = Math.min(exit, far);
    if (exit < entry) return null;
  }
  if (exit <= 0) return null;
  if (entry > 0) return entry;
  return purpose === "node-entry" ? 0 : exit;
}

function isBetterHit(
  candidate: CanonicalBounds,
  distance: number,
  current: CanonicalBounds | null,
  currentDistance: number,
): boolean {
  if (current === null) return true;
  if (distance < currentDistance) return true;
  return (
    distance === currentDistance &&
    compareText(candidate.id, current.id) < 0
  );
}

function comparePendingNodes(left: PendingNode, right: PendingNode): number {
  return left.distance - right.distance;
}

function compareBoundsById(
  left: Pick<BuildingBvhBounds, "id">,
  right: Pick<BuildingBvhBounds, "id">,
): number {
  return compareText(left.id, right.id);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function requiredId(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return value;
}

function normalizedOptionalId(
  value: unknown,
  label: string,
): string | undefined {
  return value === undefined ? undefined : requiredId(value, label);
}

function positiveDistance(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError("Maximum pick distance must be finite and positive.");
  }
  return value;
}
