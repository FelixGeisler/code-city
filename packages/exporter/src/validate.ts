import {
  resolvePrinterGeometryLimits,
  type PrinterProfile,
} from "../../core/src/print.js";
import type {
  PrintBounds,
  PrintMesh,
  PrintableCity,
  PrintPoint,
  PrintPrimitive,
  PrintTriangle,
} from "./geometry.js";
import {
  minimumPositiveHorizontalGap,
  potentialPrintPairs,
} from "./spatial.js";

const GEOMETRY_EPSILON = 1e-7;
const SERIALIZATION_GEOMETRY_EPSILON = 1e-12;

export class PrintGeometryValidationError extends Error {
  public readonly issues: readonly string[];

  public constructor(issues: readonly string[]) {
    super(`Invalid printable geometry: ${issues.join(" ")}`);
    this.name = "PrintGeometryValidationError";
    this.issues = [...issues];
  }
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function close(left: number, right: number): boolean {
  const scale = Math.max(1, Math.abs(left), Math.abs(right));
  return Math.abs(left - right) <= GEOMETRY_EPSILON * scale;
}

function subtract(left: PrintPoint, right: PrintPoint): PrintPoint {
  return {
    x: left.x - right.x,
    y: left.y - right.y,
    z: left.z - right.z,
  };
}

function cross(left: PrintPoint, right: PrintPoint): PrintPoint {
  return {
    x: left.y * right.z - left.z * right.y,
    y: left.z * right.x - left.x * right.z,
    z: left.x * right.y - left.y * right.x,
  };
}

function dot(left: PrintPoint, right: PrintPoint): number {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

function length(vector: PrintPoint): number {
  return Math.hypot(vector.x, vector.y, vector.z);
}

function triangleVertices(
  mesh: PrintMesh,
  triangle: PrintTriangle,
): readonly [PrintPoint, PrintPoint, PrintPoint] | undefined {
  const a = mesh.vertices[triangle.a];
  const b = mesh.vertices[triangle.b];
  const c = mesh.vertices[triangle.c];
  return a && b && c ? [a, b, c] : undefined;
}

export function triangleArea(
  mesh: PrintMesh,
  triangle: PrintTriangle,
): number {
  const vertices = triangleVertices(mesh, triangle);
  if (!vertices) return Number.NaN;
  const [a, b, c] = vertices;
  return length(cross(subtract(b, a), subtract(c, a))) / 2;
}

export function signedMeshVolume(mesh: PrintMesh): number {
  let volume = 0;
  for (const triangle of mesh.triangles) {
    const vertices = triangleVertices(mesh, triangle);
    if (!vertices) return Number.NaN;
    const [a, b, c] = vertices;
    volume += dot(a, cross(b, c)) / 6;
  }
  return volume;
}

interface SerializationMeshEdge {
  count: number;
  directionSum: number;
  readonly firstTriangle: number;
}

/**
 * Geometry normalized to the selected target coordinate encoding. One outward
 * unit normal is returned for every input triangle.
 */
export interface ValidatedSerializationMesh {
  readonly vertices: readonly PrintPoint[];
  readonly normals: readonly PrintPoint[];
}

export type SerializationCoordinateEncoding = "decimal" | "float32";

function findSerializationComponent(
  parents: Int32Array,
  index: number,
): number {
  let root = index;
  while (parents[root] !== root) root = parents[root]!;
  let current = index;
  while (parents[current] !== current) {
    const next = parents[current]!;
    parents[current] = root;
    current = next;
  }
  return root;
}

function joinSerializationComponents(
  parents: Int32Array,
  ranks: Uint8Array,
  left: number,
  right: number,
): void {
  let leftRoot = findSerializationComponent(parents, left);
  let rightRoot = findSerializationComponent(parents, right);
  if (leftRoot === rightRoot) return;
  if (ranks[leftRoot]! < ranks[rightRoot]!) {
    [leftRoot, rightRoot] = [rightRoot, leftRoot];
  }
  parents[rightRoot] = leftRoot;
  if (ranks[leftRoot] === ranks[rightRoot]) {
    ranks[leftRoot] = ranks[leftRoot]! + 1;
  }
}

function serializationCoordinate(
  value: number,
  field: string,
  encoding: SerializationCoordinateEncoding,
): number {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${field} must be finite.`);
  }
  const encoded = encoding === "float32" ? Math.fround(value) : value;
  if (!Number.isFinite(encoded)) {
    throw new TypeError(
      `${field} must be finite and representable as a Float32 value.`,
    );
  }
  return Object.is(encoded, -0) ? 0 : encoded;
}

function serializationTriangleIndex(
  value: number,
  vertexCount: number,
  field: string,
): void {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value >= vertexCount
  ) {
    throw new TypeError(
      `${field} must reference a vertex in the same mesh.`,
    );
  }
}

/**
 * Validates the invariants shared by triangle-mesh serializers.
 *
 * Validation uses the coordinate representation written by the target format.
 * Binary STL selects Float32 so geometry that collapses during encoding is
 * rejected; decimal 3MF keeps JavaScript's finite number values. Disconnected
 * shells are supported, but each shell must independently be closed,
 * consistently wound, and have positive outward volume.
 */
export function validateMeshForSerialization(
  mesh: PrintMesh,
  field = "mesh",
  coordinateEncoding: SerializationCoordinateEncoding,
): ValidatedSerializationMesh {
  if (mesh.vertices.length < 3) {
    throw new TypeError(`${field} must contain at least three vertices.`);
  }
  if (mesh.triangles.length < 4) {
    throw new TypeError(`${field} must contain at least four triangles.`);
  }

  const vertices = new Array<PrintPoint>(mesh.vertices.length);
  for (let index = 0; index < mesh.vertices.length; index += 1) {
    const vertex = mesh.vertices[index];
    if (vertex === undefined || vertex === null) {
      throw new TypeError(`${field}.vertices[${index}] must be a point.`);
    }
    vertices[index] = {
      x: serializationCoordinate(
        vertex.x,
        `${field}.vertices[${index}].x`,
        coordinateEncoding,
      ),
      y: serializationCoordinate(
        vertex.y,
        `${field}.vertices[${index}].y`,
        coordinateEncoding,
      ),
      z: serializationCoordinate(
        vertex.z,
        `${field}.vertices[${index}].z`,
        coordinateEncoding,
      ),
    };
  }
  const normals = new Array<PrintPoint>(mesh.triangles.length);
  const edges = new Map<string, SerializationMeshEdge>();
  const parents = new Int32Array(mesh.triangles.length);
  const ranks = new Uint8Array(mesh.triangles.length);
  for (let index = 0; index < parents.length; index += 1) {
    parents[index] = index;
  }

  for (let index = 0; index < mesh.triangles.length; index += 1) {
    const triangle = mesh.triangles[index];
    if (triangle === undefined || triangle === null) {
      throw new TypeError(`${field}.triangles[${index}] must be a triangle.`);
    }
    serializationTriangleIndex(
      triangle.a,
      vertices.length,
      `${field}.triangles[${index}].a`,
    );
    serializationTriangleIndex(
      triangle.b,
      vertices.length,
      `${field}.triangles[${index}].b`,
    );
    serializationTriangleIndex(
      triangle.c,
      vertices.length,
      `${field}.triangles[${index}].c`,
    );
    if (
      triangle.a === triangle.b ||
      triangle.b === triangle.c ||
      triangle.c === triangle.a
    ) {
      throw new TypeError(`${field}.triangles[${index}] is degenerate.`);
    }

    const a = vertices[triangle.a]!;
    const b = vertices[triangle.b]!;
    const c = vertices[triangle.c]!;
    const normal = cross(subtract(b, a), subtract(c, a));
    const magnitude = length(normal);
    if (
      !Number.isFinite(normal.x) ||
      !Number.isFinite(normal.y) ||
      !Number.isFinite(normal.z) ||
      !Number.isFinite(magnitude) ||
      magnitude <= SERIALIZATION_GEOMETRY_EPSILON
    ) {
      throw new TypeError(
        `${field}.triangles[${index}] has no positive area.`,
      );
    }
    normals[index] = {
      x: normal.x / magnitude,
      y: normal.y / magnitude,
      z: normal.z / magnitude,
    };

    for (const [left, right] of [
      [triangle.a, triangle.b],
      [triangle.b, triangle.c],
      [triangle.c, triangle.a],
    ] as const) {
      const key =
        left < right ? `${left}:${right}` : `${right}:${left}`;
      const direction = left < right ? 1 : -1;
      const edge = edges.get(key);
      if (edge === undefined) {
        edges.set(key, {
          count: 1,
          directionSum: direction,
          firstTriangle: index,
        });
      } else {
        edge.count += 1;
        edge.directionSum += direction;
        joinSerializationComponents(
          parents,
          ranks,
          edge.firstTriangle,
          index,
        );
      }
    }
  }

  for (const edge of edges.values()) {
    if (edge.count !== 2 || edge.directionSum !== 0) {
      throw new TypeError(
        `${field} must be watertight with consistently wound edges.`,
      );
    }
  }

  const componentOrigins = new Int32Array(mesh.triangles.length);
  componentOrigins.fill(-1);
  const componentVolumes = new Float64Array(mesh.triangles.length);
  for (let index = 0; index < mesh.triangles.length; index += 1) {
    const root = findSerializationComponent(parents, index);
    if (componentOrigins[root] === -1) componentOrigins[root] = index;
    const originTriangle = mesh.triangles[componentOrigins[root]!]!;
    const origin = vertices[originTriangle.a]!;
    const triangle = mesh.triangles[index]!;
    const a = subtract(vertices[triangle.a]!, origin);
    const b = subtract(vertices[triangle.b]!, origin);
    const c = subtract(vertices[triangle.c]!, origin);
    componentVolumes[root] =
      componentVolumes[root]! + dot(a, cross(b, c)) / 6;
  }
  for (let root = 0; root < componentOrigins.length; root += 1) {
    if (componentOrigins[root] === -1) continue;
    const volume = componentVolumes[root]!;
    if (
      !Number.isFinite(volume) ||
      volume <= SERIALIZATION_GEOMETRY_EPSILON
    ) {
      throw new TypeError(
        `${field} must contain only outward-wound positive-volume shells.`,
      );
    }
  }

  return { vertices, normals };
}

export function measureMeshBounds(mesh: PrintMesh): PrintBounds | undefined {
  if (mesh.vertices.length === 0) return undefined;
  const minimum = {
    x: Number.POSITIVE_INFINITY,
    y: Number.POSITIVE_INFINITY,
    z: Number.POSITIVE_INFINITY,
  };
  const maximum = {
    x: Number.NEGATIVE_INFINITY,
    y: Number.NEGATIVE_INFINITY,
    z: Number.NEGATIVE_INFINITY,
  };
  for (const vertex of mesh.vertices) {
    minimum.x = Math.min(minimum.x, vertex.x);
    minimum.y = Math.min(minimum.y, vertex.y);
    minimum.z = Math.min(minimum.z, vertex.z);
    maximum.x = Math.max(maximum.x, vertex.x);
    maximum.y = Math.max(maximum.y, vertex.y);
    maximum.z = Math.max(maximum.z, vertex.z);
  }
  return {
    minimum,
    maximum,
    size: {
      x: maximum.x - minimum.x,
      y: maximum.y - minimum.y,
      z: maximum.z - minimum.z,
    },
  };
}

function sameBounds(left: PrintBounds, right: PrintBounds): boolean {
  return (["x", "y", "z"] as const).every(
    (axis) =>
      close(left.minimum[axis], right.minimum[axis]) &&
      close(left.maximum[axis], right.maximum[axis]) &&
      close(left.size[axis], right.size[axis]),
  );
}

function meshIssues(
  mesh: PrintMesh,
  path: string,
  expectedBounds?: PrintBounds,
): readonly string[] {
  const issues: string[] = [];
  if (mesh.vertices.length === 0) {
    issues.push(`${path} must contain vertices.`);
  }
  if (mesh.triangles.length === 0) {
    issues.push(`${path} must contain triangles.`);
  }
  mesh.vertices.forEach((vertex, index) => {
    for (const axis of ["x", "y", "z"] as const) {
      if (!Number.isFinite(vertex[axis])) {
        issues.push(`${path}.vertices[${index}].${axis} must be finite.`);
      }
    }
  });

  const edgeCounts = new Map<
    string,
    { count: number; direction: number }
  >();
  mesh.triangles.forEach((triangle, index) => {
    const indices = [triangle.a, triangle.b, triangle.c];
    if (
      !indices.every(
        (value) =>
          Number.isSafeInteger(value) &&
          value >= 0 &&
          value < mesh.vertices.length,
      )
    ) {
      issues.push(`${path}.triangles[${index}] has an invalid vertex index.`);
      return;
    }
    if (new Set(indices).size !== 3) {
      issues.push(`${path}.triangles[${index}] repeats a vertex.`);
      return;
    }
    const area = triangleArea(mesh, triangle);
    if (!Number.isFinite(area) || area <= GEOMETRY_EPSILON) {
      issues.push(`${path}.triangles[${index}] has no positive area.`);
    }
    for (const [left, right] of [
      [triangle.a, triangle.b],
      [triangle.b, triangle.c],
      [triangle.c, triangle.a],
    ] as const) {
      const key =
        left < right ? `${left}:${right}` : `${right}:${left}`;
      const edge = edgeCounts.get(key) ?? { count: 0, direction: 0 };
      edge.count += 1;
      edge.direction += left < right ? 1 : -1;
      edgeCounts.set(key, edge);
    }
  });
  const openEdges = [...edgeCounts.values()].filter(
    ({ count }) => count !== 2,
  );
  if (openEdges.length > 0) {
    issues.push(
      `${path} is not watertight; ${openEdges.length} edge(s) do not have exactly two faces.`,
    );
  }
  const inconsistentEdges = [...edgeCounts.values()].filter(
    ({ count, direction }) => count === 2 && direction !== 0,
  );
  if (inconsistentEdges.length > 0) {
    issues.push(
      `${path} is not wound outward consistently; ${inconsistentEdges.length} edge(s) use the same direction twice.`,
    );
  }
  const volume = signedMeshVolume(mesh);
  if (!Number.isFinite(volume) || volume <= GEOMETRY_EPSILON) {
    issues.push(`${path} must have positive outward volume.`);
  }
  const measured = measureMeshBounds(mesh);
  if (
    expectedBounds !== undefined &&
    (measured === undefined || !sameBounds(measured, expectedBounds))
  ) {
    issues.push(`${path} bounds do not match its vertices.`);
  }
  return issues;
}

function outwardPrimitiveIssues(
  item: PrintPrimitive,
  path: string,
): readonly string[] {
  const issues: string[] = [];
  const adjacency = item.mesh.triangles.map(() => new Set<number>());
  const edges = new Map<string, number[]>();
  item.mesh.triangles.forEach((triangle, triangleIndex) => {
    for (const [left, right] of [
      [triangle.a, triangle.b],
      [triangle.b, triangle.c],
      [triangle.c, triangle.a],
    ] as const) {
      if (
        left < 0 ||
        right < 0 ||
        left >= item.mesh.vertices.length ||
        right >= item.mesh.vertices.length
      ) {
        continue;
      }
      const key = left < right ? `${left}:${right}` : `${right}:${left}`;
      const triangles = edges.get(key) ?? [];
      triangles.push(triangleIndex);
      edges.set(key, triangles);
    }
  });
  for (const triangles of edges.values()) {
    for (const left of triangles) {
      for (const right of triangles) {
        if (left !== right) adjacency[left]!.add(right);
      }
    }
  }
  const visited = new Set<number>();
  for (
    let firstTriangle = 0;
    firstTriangle < item.mesh.triangles.length;
    firstTriangle += 1
  ) {
    if (visited.has(firstTriangle)) continue;
    const component: number[] = [];
    const queue = [firstTriangle];
    visited.add(firstTriangle);
    while (queue.length > 0) {
      const triangleIndex = queue.shift()!;
      component.push(triangleIndex);
      for (const adjacent of adjacency[triangleIndex]!) {
        if (visited.has(adjacent)) continue;
        visited.add(adjacent);
        queue.push(adjacent);
      }
    }
    let volume = 0;
    for (const triangleIndex of component) {
      const triangle = item.mesh.triangles[triangleIndex]!;
      const trianglePoints = triangleVertices(item.mesh, triangle);
      if (!trianglePoints) continue;
      const [a, b, c] = trianglePoints;
      volume += dot(a, cross(b, c)) / 6;
    }
    if (!Number.isFinite(volume) || volume <= GEOMETRY_EPSILON) {
      issues.push(
        `${path} component containing triangle ${firstTriangle} is not wound outward.`,
      );
    }
  }
  return issues;
}

function positiveOverlap(left: PrintBounds, right: PrintBounds): boolean {
  return (["x", "y", "z"] as const).every(
    (axis) =>
      Math.min(left.maximum[axis], right.maximum[axis]) -
        Math.max(left.minimum[axis], right.minimum[axis]) >
      GEOMETRY_EPSILON,
  );
}

function positiveFaceContact(left: PrintBounds, right: PrintBounds): boolean {
  for (const axis of ["x", "y", "z"] as const) {
    const touches =
      close(left.maximum[axis], right.minimum[axis]) ||
      close(right.maximum[axis], left.minimum[axis]);
    if (!touches) continue;
    const otherAxes = (["x", "y", "z"] as const).filter(
      (candidate) => candidate !== axis,
    );
    if (
      otherAxes.every(
        (other) =>
          Math.min(left.maximum[other], right.maximum[other]) -
            Math.max(left.minimum[other], right.minimum[other]) >
          GEOMETRY_EPSILON,
      )
    ) {
      return true;
    }
  }
  return false;
}

function primitiveTopologyIssues(
  primitives: readonly PrintPrimitive[],
): readonly string[] {
  const issues: string[] = [];
  const structuralGraph = primitives.map(() => new Set<number>());
  const indexByPrimitive = new Map(
    primitives.map((item, index) => [item, index]),
  );
  for (const [left, right] of potentialPrintPairs(
    primitives,
    GEOMETRY_EPSILON,
  )) {
    const leftIndex = indexByPrimitive.get(left)!;
    const rightIndex = indexByPrimitive.get(right)!;
    if (positiveOverlap(left.bounds, right.bounds)) {
      issues.push(
        `Primitives '${left.id}' and '${right.id}' overlap with positive volume.`,
      );
    }
    if (positiveFaceContact(left.bounds, right.bounds)) {
      if (
        left.semanticGroupId !== "routes" &&
        right.semanticGroupId !== "routes"
      ) {
        structuralGraph[leftIndex]!.add(rightIndex);
        structuralGraph[rightIndex]!.add(leftIndex);
      }
    }
  }
  const baseIndices = primitives
    .map((item, index) => (item.kind === "base" ? index : -1))
    .filter((index) => index >= 0);
  if (baseIndices.length !== 1) {
    issues.push("Printable city must contain exactly one shared-base primitive.");
    return issues;
  }
  const reached = new Set<number>(baseIndices);
  const queue = [...baseIndices];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const adjacent of structuralGraph[current]!) {
      if (reached.has(adjacent)) continue;
      reached.add(adjacent);
      queue.push(adjacent);
    }
  }
  const base = primitives[baseIndices[0]!]!;
  primitives.forEach((item, index) => {
    if (
      item.semanticGroupId !== "routes" &&
      !reached.has(index)
    ) {
      issues.push(
        `Primitive '${item.id}' has no positive-area face connection to the shared base.`,
      );
    }
    if (
      item.semanticGroupId === "routes" &&
      (!close(item.bounds.minimum.z, base.bounds.maximum.z) ||
        item.bounds.minimum.x < base.bounds.minimum.x - GEOMETRY_EPSILON ||
        item.bounds.maximum.x > base.bounds.maximum.x + GEOMETRY_EPSILON ||
        item.bounds.minimum.y < base.bounds.minimum.y - GEOMETRY_EPSILON ||
        item.bounds.maximum.y > base.bounds.maximum.y + GEOMETRY_EPSILON)
    ) {
      issues.push(
        `Route primitive '${item.id}' must rest on top of and remain inside the shared base.`,
      );
    }
  });
  return issues;
}

function measuredPrimitiveBounds(
  primitives: readonly PrintPrimitive[],
): PrintBounds | undefined {
  if (primitives.length === 0) return undefined;
  const minimum = {
    x: Math.min(...primitives.map((item) => item.bounds.minimum.x)),
    y: Math.min(...primitives.map((item) => item.bounds.minimum.y)),
    z: Math.min(...primitives.map((item) => item.bounds.minimum.z)),
  };
  const maximum = {
    x: Math.max(...primitives.map((item) => item.bounds.maximum.x)),
    y: Math.max(...primitives.map((item) => item.bounds.maximum.y)),
    z: Math.max(...primitives.map((item) => item.bounds.maximum.z)),
  };
  return {
    minimum,
    maximum,
    size: {
      x: maximum.x - minimum.x,
      y: maximum.y - minimum.y,
      z: maximum.z - minimum.z,
    },
  };
}

function minimumPrimitiveFeature(
  primitives: readonly PrintPrimitive[],
): number {
  return Math.min(
    ...primitives.flatMap((item) => [
      item.bounds.size.x,
      item.bounds.size.y,
      item.bounds.size.z,
    ]),
  );
}

function minimumHorizontalGap(
  primitives: readonly PrintPrimitive[],
): number | null {
  return minimumPositiveHorizontalGap(primitives, GEOMETRY_EPSILON);
}

export function validatePrintableCity(
  city: PrintableCity,
  profile: PrinterProfile,
): readonly string[] {
  const issues: string[] = [];
  if (!Number.isFinite(city.scale) || city.scale <= 0) {
    issues.push("Print scale must be a positive finite number.");
  }
  if (city.profileId !== profile.id) {
    issues.push(
      `Printable city profile '${city.profileId}' does not match '${profile.id}'.`,
    );
  }
  if (city.parts.length === 0) {
    issues.push("Printable city must contain at least one channel part.");
  }
  const knownChannels = new Set(
    profile.printChannels.map(({ id }) => id),
  );
  const partIds = new Set<string>();
  const partChannels = new Set<string>();
  const primitiveIds = new Set<string>();
  const primitives: PrintPrimitive[] = [];

  city.parts.forEach((part, partIndex) => {
    const path = `parts[${partIndex}]`;
    if (partIds.has(part.id)) {
      issues.push(`Duplicate print part id '${part.id}'.`);
    }
    partIds.add(part.id);
    if (partChannels.has(part.channelId)) {
      issues.push(`Duplicate print part channel '${part.channelId}'.`);
    }
    partChannels.add(part.channelId);
    if (!knownChannels.has(part.channelId)) {
      issues.push(`${path} references unknown channel '${part.channelId}'.`);
    }
    if (part.primitives.length === 0) {
      issues.push(`${path} must contain at least one primitive.`);
    }
    const expectedVertexCount = part.primitives.reduce(
      (sum, item) => sum + item.mesh.vertices.length,
      0,
    );
    const expectedTriangleCount = part.primitives.reduce(
      (sum, item) => sum + item.mesh.triangles.length,
      0,
    );
    if (
      part.mesh.vertices.length !== expectedVertexCount ||
      part.mesh.triangles.length !== expectedTriangleCount
    ) {
      issues.push(`${path}.mesh does not concatenate its primitive meshes.`);
    }
    issues.push(...meshIssues(part.mesh, `${path}.mesh`));
    const actualSemanticGroups = [
      ...new Set(
        part.primitives.map(({ semanticGroupId }) => semanticGroupId),
      ),
    ].sort(compare);
    if (
      actualSemanticGroups.length !== part.semanticGroupIds.length ||
      actualSemanticGroups.some(
        (id, index) => id !== part.semanticGroupIds[index],
      )
    ) {
      issues.push(`${path}.semanticGroupIds do not match its primitives.`);
    }
    part.primitives.forEach((item, primitiveIndex) => {
      const primitivePath = `${path}.primitives[${primitiveIndex}]`;
      primitives.push(item);
      if (primitiveIds.has(item.id)) {
        issues.push(`Duplicate print primitive id '${item.id}'.`);
      }
      primitiveIds.add(item.id);
      if (item.channelId !== part.channelId) {
        issues.push(
          `${primitivePath} channel '${item.channelId}' does not match its part.`,
        );
      }
      issues.push(
        ...meshIssues(item.mesh, `${primitivePath}.mesh`, item.bounds),
        ...outwardPrimitiveIssues(item, primitivePath),
      );
    });
  });

  issues.push(...primitiveTopologyIssues(primitives));
  const measuredBounds = measuredPrimitiveBounds(primitives);
  if (
    measuredBounds === undefined ||
    !sameBounds(measuredBounds, city.bounds)
  ) {
    issues.push("Printable city bounds do not match its primitive geometry.");
  }
  const printBuildVolume = {
    x: profile.buildVolume.x,
    y: profile.buildVolume.z,
    z: profile.buildVolume.y,
  };
  const geometryLimits = resolvePrinterGeometryLimits(profile);
  // CityModel X/Y/Z (width/height/depth) maps to print X/Z/Y.
  const printBuildMargins = {
    x: geometryLimits.buildMargins.x,
    y: geometryLimits.buildMargins.z,
    z: geometryLimits.buildMargins.y,
  };
  for (const axis of ["x", "y", "z"] as const) {
    if (city.bounds.minimum[axis] < -GEOMETRY_EPSILON) {
      issues.push(
        `Printable city minimum ${axis.toUpperCase()} must be non-negative.`,
      );
    }
    if (
      city.bounds.size[axis] >
      printBuildVolume[axis] + GEOMETRY_EPSILON
    ) {
      issues.push(
        `Printable city ${axis.toUpperCase()} size (${city.bounds.size[axis]}) exceeds build volume (${printBuildVolume[axis]}).`,
      );
    }
    const margin = printBuildMargins[axis];
    const usableSpan = printBuildVolume[axis] - margin * 2;
    if (
      margin > GEOMETRY_EPSILON &&
      city.bounds.size[axis] > usableSpan + GEOMETRY_EPSILON
    ) {
      issues.push(
        `Printable city ${axis.toUpperCase()} size (${city.bounds.size[axis]}) exceeds the usable build span (${usableSpan}) after margins.`,
      );
    }
  }
  if (
    city.bounds.size.z >
    geometryLimits.maximumModelHeight + GEOMETRY_EPSILON
  ) {
    issues.push(
      `Printable city model height (${city.bounds.size.z}) exceeds profile maximum (${geometryLimits.maximumModelHeight}).`,
    );
  }
  const base = primitives.find(({ kind }) => kind === "base");
  const measuredBaseThickness = base?.bounds.size.z ?? Number.NaN;
  if (
    !close(
      city.measurements.baseThickness,
      measuredBaseThickness,
    )
  ) {
    issues.push("Measured base thickness does not match base geometry.");
  }
  if (
    city.measurements.baseThickness + GEOMETRY_EPSILON <
    geometryLimits.minimumBaseThickness
  ) {
    issues.push(
      `Base thickness (${city.measurements.baseThickness}) is below profile minimum (${geometryLimits.minimumBaseThickness}).`,
    );
  }
  const measuredFeature = minimumPrimitiveFeature(primitives);
  if (
    !close(city.measurements.wallThickness, measuredFeature)
  ) {
    issues.push("Measured wall thickness does not match geometry.");
  }
  if (
    city.measurements.wallThickness + GEOMETRY_EPSILON <
    geometryLimits.minimumWallThickness
  ) {
    issues.push(
      `Wall thickness (${city.measurements.wallThickness}) is below profile minimum (${geometryLimits.minimumWallThickness}).`,
    );
  }
  if (
    !close(city.measurements.minimumFeatureSize, measuredFeature)
  ) {
    issues.push("Measured minimum feature size does not match geometry.");
  }
  if (
    city.measurements.minimumFeatureSize + GEOMETRY_EPSILON <
    geometryLimits.minimumFeatureSize
  ) {
    issues.push(
      `Minimum feature size (${city.measurements.minimumFeatureSize}) is below profile minimum (${geometryLimits.minimumFeatureSize}).`,
    );
  }
  const measuredGap = minimumHorizontalGap(primitives);
  const reportedGap = city.measurements.minimumGap;
  if (
    (measuredGap === null) !== (reportedGap === null) ||
    (measuredGap !== null &&
      reportedGap !== null &&
      !close(measuredGap, reportedGap))
  ) {
    issues.push("Measured minimum gap does not match geometry.");
  }
  if (
    measuredGap !== null &&
    measuredGap + GEOMETRY_EPSILON <
      geometryLimits.minimumGap
  ) {
    issues.push(
      `Minimum gap (${measuredGap}) is below profile minimum (${geometryLimits.minimumGap}).`,
    );
  }
  return [...new Set(issues)];
}
