import type {
  PrintPart,
  PrintPoint,
  PrintableCity,
} from "./geometry.js";
import {
  validateMeshForSerialization,
  type ValidatedSerializationMesh,
} from "./validate.js";

export const BINARY_STL_HEADER_SIZE = 80;
export const BINARY_STL_COUNT_SIZE = 4;
export const BINARY_STL_FACET_SIZE = 50;
export const BINARY_STL_TRIANGLE_LIMIT = 500_000;
export const BINARY_STL_VERTEX_LIMIT = 500_000;
export const BINARY_STL_BYTE_LIMIT =
  BINARY_STL_HEADER_SIZE +
  BINARY_STL_COUNT_SIZE +
  BINARY_STL_TRIANGLE_LIMIT * BINARY_STL_FACET_SIZE;

const BINARY_STL_HEADER = "CODECITY BINARY STL 1.0";

interface SerializedStlPart {
  readonly part: PrintPart;
  readonly mesh: ValidatedSerializationMesh;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function requiredText(value: string, field: string): string {
  const normalized = value.normalize("NFC").trim();
  if (normalized === "") {
    throw new TypeError(`${field} must not be empty.`);
  }
  return normalized;
}

export interface BinaryStlResourceEnvelope {
  readonly triangleCount: number;
  readonly vertexCount: number;
  readonly byteLength: number;
}

export function binaryStlResourceEnvelope(
  parts: readonly PrintPart[],
): BinaryStlResourceEnvelope {
  let triangleCount = 0;
  let vertexCount = 0;
  for (const [index, part] of parts.entries()) {
    const triangles = part.mesh.triangles.length;
    const vertices = part.mesh.vertices.length;
    if (!Number.isSafeInteger(triangles) || triangles < 0) {
      throw new TypeError(
        `parts[${index}].mesh has an invalid triangle count.`,
      );
    }
    if (!Number.isSafeInteger(vertices) || vertices < 0) {
      throw new TypeError(
        `parts[${index}].mesh has an invalid vertex count.`,
      );
    }
    if (
      triangles > BINARY_STL_TRIANGLE_LIMIT ||
      triangleCount > BINARY_STL_TRIANGLE_LIMIT - triangles
    ) {
      throw new RangeError(
        `Binary STL triangle count exceeds the ${BINARY_STL_TRIANGLE_LIMIT} triangle safety limit.`,
      );
    }
    if (
      vertices > BINARY_STL_VERTEX_LIMIT ||
      vertexCount > BINARY_STL_VERTEX_LIMIT - vertices
    ) {
      throw new RangeError(
        `Binary STL vertex count exceeds the ${BINARY_STL_VERTEX_LIMIT} vertex safety limit.`,
      );
    }
    triangleCount += triangles;
    vertexCount += vertices;
  }
  const byteLength =
    BINARY_STL_HEADER_SIZE +
    BINARY_STL_COUNT_SIZE +
    triangleCount * BINARY_STL_FACET_SIZE;
  if (
    !Number.isSafeInteger(byteLength) ||
    byteLength > BINARY_STL_BYTE_LIMIT
  ) {
    throw new RangeError(
      `Binary STL byte size exceeds the ${BINARY_STL_BYTE_LIMIT} byte safety limit.`,
    );
  }
  return { triangleCount, vertexCount, byteLength };
}

function serializedParts(
  parts: readonly PrintPart[],
): readonly SerializedStlPart[] {
  const ordered = [...parts].sort(
    (left, right) =>
      compare(left.channelId, right.channelId) ||
      compare(left.id, right.id),
  );
  const ids = new Set<string>();
  const channelIds = new Set<string>();
  return ordered.map((part, index): SerializedStlPart => {
    const id = requiredText(part.id, `parts[${index}].id`);
    const channelId = requiredText(
      part.channelId,
      `parts[${index}].channelId`,
    );
    if (ids.has(id)) {
      throw new TypeError(`Duplicate printable part id '${id}'.`);
    }
    if (channelIds.has(channelId)) {
      throw new TypeError(
        `Printable channel '${channelId}' has more than one mesh part.`,
      );
    }
    ids.add(id);
    channelIds.add(channelId);
    return {
      part,
      mesh: validateMeshForSerialization(
        part.mesh,
        `parts[${index}].mesh`,
        "float32",
      ),
    };
  });
}

function writePoint(
  view: DataView,
  offset: number,
  point: PrintPoint,
): void {
  view.setFloat32(offset, point.x, true);
  view.setFloat32(offset + 4, point.y, true);
  view.setFloat32(offset + 8, point.z, true);
}

/**
 * Serializes all channel meshes as one deterministic binary STL artifact.
 *
 * STL has no material, tool, or metadata model. Parts therefore remain
 * separate, unwelded shells in stable channel/id order, while the fixed header
 * deliberately contains no repository, title, path, or profile information.
 */
export function serializeBinaryStl(city: PrintableCity): Uint8Array {
  if (city.unit !== "millimeter") {
    throw new TypeError("STL export requires millimeter print geometry.");
  }
  if (city.parts.length === 0) {
    throw new TypeError("Printable city must contain at least one used channel.");
  }

  // Enforce resource limits before mesh validation or output allocation.
  const resources = binaryStlResourceEnvelope(city.parts);

  const parts = serializedParts(city.parts);
  const bytes = new Uint8Array(resources.byteLength);
  const header = new TextEncoder().encode(BINARY_STL_HEADER);
  bytes.set(header, 0);
  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  );
  view.setUint32(
    BINARY_STL_HEADER_SIZE,
    resources.triangleCount,
    true,
  );

  let facetOffset = BINARY_STL_HEADER_SIZE + BINARY_STL_COUNT_SIZE;
  for (const { part, mesh } of parts) {
    part.mesh.triangles.forEach((triangle, index) => {
      writePoint(view, facetOffset, mesh.normals[index]!);
      writePoint(view, facetOffset + 12, mesh.vertices[triangle.a]!);
      writePoint(view, facetOffset + 24, mesh.vertices[triangle.b]!);
      writePoint(view, facetOffset + 36, mesh.vertices[triangle.c]!);
      view.setUint16(facetOffset + 48, 0, true);
      facetOffset += BINARY_STL_FACET_SIZE;
    });
  }
  return bytes;
}
