import { describe, expect, it } from "vitest";

import {
  cuboidMesh,
  type PrintMesh,
  type PrintPart,
  type PrintableCity,
  type PrintPoint,
  type PrintTriangle,
} from "../packages/exporter/src/geometry.js";
import {
  BINARY_STL_COUNT_SIZE,
  BINARY_STL_FACET_SIZE,
  BINARY_STL_HEADER_SIZE,
  BINARY_STL_TRIANGLE_LIMIT,
  BINARY_STL_VERTEX_LIMIT,
  binaryStlResourceEnvelope,
  serializeBinaryStl,
} from "../packages/exporter/src/stl.js";

const FIRST_FACET_OFFSET =
  BINARY_STL_HEADER_SIZE + BINARY_STL_COUNT_SIZE;

function cube(
  minimum: PrintPoint = { x: 0, y: 0, z: 0 },
  maximum: PrintPoint = { x: 1, y: 1, z: 1 },
): PrintMesh {
  return cuboidMesh({
    minimum,
    maximum,
    size: {
      x: maximum.x - minimum.x,
      y: maximum.y - minimum.y,
      z: maximum.z - minimum.z,
    },
  });
}

function part(
  channelId = "tool-1",
  id = "part:tool-1",
  mesh: PrintMesh = cube(),
): PrintPart {
  return {
    id,
    channelId,
    name: "Private material name",
    displayColor: "#123456",
    semanticGroupIds: ["private/path"],
    primitives: [],
    mesh,
  };
}

function city(parts: readonly PrintPart[] = [part()]): PrintableCity {
  return {
    application: {
      name: "Private application",
      version: "private-version",
    },
    profileId: "private-profile",
    title: "Private repository title",
    version: "private-revision",
    unit: "millimeter",
    scale: 1,
    bounds: {
      minimum: { x: 0, y: 0, z: 0 },
      maximum: { x: 1, y: 1, z: 1 },
      size: { x: 1, y: 1, z: 1 },
    },
    measurements: {
      baseThickness: 1,
      wallThickness: 1,
      minimumFeatureSize: 1,
      minimumGap: null,
    },
    parts,
  };
}

function readPoint(view: DataView, offset: number): PrintPoint {
  return {
    x: view.getFloat32(offset, true),
    y: view.getFloat32(offset + 4, true),
    z: view.getFloat32(offset + 8, true),
  };
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

function concatenate(meshes: readonly PrintMesh[]): PrintMesh {
  const vertices: PrintPoint[] = [];
  const triangles: PrintTriangle[] = [];
  for (const mesh of meshes) {
    const offset = vertices.length;
    vertices.push(...mesh.vertices);
    triangles.push(
      ...mesh.triangles.map((triangle) => ({
        a: triangle.a + offset,
        b: triangle.b + offset,
        c: triangle.c + offset,
      })),
    );
  }
  return { vertices, triangles };
}

function includesBytes(
  bytes: Uint8Array,
  candidate: Uint8Array,
): boolean {
  outer: for (
    let offset = 0;
    offset <= bytes.length - candidate.length;
    offset += 1
  ) {
    for (let index = 0; index < candidate.length; index += 1) {
      if (bytes[offset + index] !== candidate[index]) continue outer;
    }
    return true;
  }
  return false;
}

describe("deterministic binary STL serialization", () => {
  it("writes the fixed header, little-endian count, and 50-byte facets", () => {
    const bytes = serializeBinaryStl(city());
    const view = new DataView(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength,
    );
    const header = new TextDecoder()
      .decode(bytes.subarray(0, BINARY_STL_HEADER_SIZE))
      .replace(/\0+$/u, "");

    expect(header).toBe("CODECITY BINARY STL 1.0");
    expect(header.toLowerCase().startsWith("solid")).toBe(false);
    expect(view.getUint32(BINARY_STL_HEADER_SIZE, true)).toBe(12);
    expect(view.getUint32(BINARY_STL_HEADER_SIZE, false)).not.toBe(12);
    expect(bytes).toHaveLength(
      FIRST_FACET_OFFSET + 12 * BINARY_STL_FACET_SIZE,
    );

    expect(readPoint(view, FIRST_FACET_OFFSET)).toEqual({
      x: 0,
      y: 0,
      z: -1,
    });
    expect(readPoint(view, FIRST_FACET_OFFSET + 12)).toEqual({
      x: 0,
      y: 0,
      z: 0,
    });
    expect(readPoint(view, FIRST_FACET_OFFSET + 24)).toEqual({
      x: 1,
      y: 1,
      z: 0,
    });
    expect(readPoint(view, FIRST_FACET_OFFSET + 36)).toEqual({
      x: 1,
      y: 0,
      z: 0,
    });
    expect(view.getUint16(FIRST_FACET_OFFSET + 48, true)).toBe(0);
  });

  it("writes outward unit normals for every facet", () => {
    const bytes = serializeBinaryStl(city());
    const view = new DataView(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength,
    );

    for (let index = 0; index < 12; index += 1) {
      const offset =
        FIRST_FACET_OFFSET + index * BINARY_STL_FACET_SIZE;
      const normal = readPoint(view, offset);
      const a = readPoint(view, offset + 12);
      const b = readPoint(view, offset + 24);
      const c = readPoint(view, offset + 36);
      const windingNormal = cross(subtract(b, a), subtract(c, a));

      expect(Math.hypot(normal.x, normal.y, normal.z)).toBeCloseTo(1, 6);
      expect(dot(normal, windingNormal)).toBeGreaterThan(0);
    }
  });

  it("uses stable part ordering and serializes no project metadata", () => {
    const firstPart = part(
      "tool-a",
      "part:a",
      cube({ x: 10, y: 0, z: 0 }, { x: 11, y: 1, z: 1 }),
    );
    const secondPart = part(
      "tool-b",
      "part:b",
      cube({ x: 20, y: 0, z: 0 }, { x: 21, y: 1, z: 1 }),
    );
    const forward = serializeBinaryStl(city([firstPart, secondPart]));
    const reverse = serializeBinaryStl(city([secondPart, firstPart]));
    const view = new DataView(
      forward.buffer,
      forward.byteOffset,
      forward.byteLength,
    );

    expect(reverse).toEqual(forward);
    expect(serializeBinaryStl(city([firstPart, secondPart]))).toEqual(
      forward,
    );
    expect(readPoint(view, FIRST_FACET_OFFSET + 12).x).toBe(10);
    for (const secret of [
      "Private repository title",
      "private-profile",
      "Private material name",
      "private/path",
    ]) {
      expect(
        includesBytes(forward, new TextEncoder().encode(secret)),
      ).toBe(false);
    }
  });

  it("preserves multiple disconnected shells without welding them", () => {
    const mesh = concatenate([
      cube(),
      cube({ x: 3, y: 0, z: 0 }, { x: 4, y: 1, z: 1 }),
    ]);
    const bytes = serializeBinaryStl(city([part("tool-1", "part:1", mesh)]));
    const view = new DataView(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength,
    );

    expect(view.getUint32(BINARY_STL_HEADER_SIZE, true)).toBe(24);
    expect(bytes).toHaveLength(
      FIRST_FACET_OFFSET + 24 * BINARY_STL_FACET_SIZE,
    );
    const secondShellFirstVertex = readPoint(
      view,
      FIRST_FACET_OFFSET + 12 * BINARY_STL_FACET_SIZE + 12,
    );
    expect(secondShellFirstVertex.x).toBe(3);
  });

  it("rejects an inward component and an open shell", () => {
    const twoShells = concatenate([
      cube(),
      cube({ x: 3, y: 0, z: 0 }, { x: 4, y: 1, z: 1 }),
    ]);
    const reversedSecondShell: PrintMesh = {
      vertices: twoShells.vertices,
      triangles: twoShells.triangles.map((triangle, index) =>
        index < 12
          ? triangle
          : { a: triangle.a, b: triangle.c, c: triangle.b },
      ),
    };
    expect(() =>
      serializeBinaryStl(
        city([part("tool-1", "part:1", reversedSecondShell)]),
      ),
    ).toThrow(/outward-wound/u);

    const open: PrintMesh = {
      ...cube(),
      triangles: cube().triangles.slice(0, -1),
    };
    expect(() =>
      serializeBinaryStl(city([part("tool-1", "part:1", open)])),
    ).toThrow(/watertight/u);
  });

  it("rejects unsafe indices and coordinates outside Float32", () => {
    const badIndex: PrintMesh = {
      ...cube(),
      triangles: [
        { a: Number.MAX_SAFE_INTEGER, b: 2, c: 1 },
        ...cube().triangles.slice(1),
      ],
    };
    expect(() =>
      serializeBinaryStl(city([part("tool-1", "part:1", badIndex)])),
    ).toThrow(/same mesh/u);

    const overflow: PrintMesh = {
      ...cube(),
      vertices: [
        { x: Number.MAX_VALUE, y: 0, z: 0 },
        ...cube().vertices.slice(1),
      ],
    };
    expect(() =>
      serializeBinaryStl(city([part("tool-1", "part:1", overflow)])),
    ).toThrow(/Float32/u);
  });

  it("rejects geometry that degenerates after Float32 rounding", () => {
    const precisionCollapse = cube(
      { x: 16_777_216, y: 0, z: 0 },
      { x: 16_777_217, y: 1, z: 1 },
    );

    expect(() =>
      serializeBinaryStl(
        city([part("tool-1", "part:1", precisionCollapse)]),
      ),
    ).toThrow(/positive area/u);
  });

  it("rejects the triangle safety limit before traversing the mesh", () => {
    const triangles = new Array<PrintTriangle>(
      BINARY_STL_TRIANGLE_LIMIT + 1,
    );
    const oversized: PrintMesh = {
      vertices: cube().vertices,
      triangles,
    };

    expect(() =>
      serializeBinaryStl(city([part("tool-1", "part:1", oversized)])),
    ).toThrow(/safety limit/u);
  });

  it("bounds vertices and calculates the largest accepted envelope", () => {
    const maximum: PrintMesh = {
      vertices: new Array<PrintPoint>(BINARY_STL_VERTEX_LIMIT),
      triangles: new Array<PrintTriangle>(BINARY_STL_TRIANGLE_LIMIT),
    };
    expect(
      binaryStlResourceEnvelope([
        part("tool-1", "part:1", maximum),
      ]),
    ).toEqual({
      vertexCount: BINARY_STL_VERTEX_LIMIT,
      triangleCount: BINARY_STL_TRIANGLE_LIMIT,
      byteLength:
        FIRST_FACET_OFFSET +
        BINARY_STL_TRIANGLE_LIMIT * BINARY_STL_FACET_SIZE,
    });

    const excessiveVertices: PrintMesh = {
      vertices: new Array<PrintPoint>(BINARY_STL_VERTEX_LIMIT + 1),
      triangles: cube().triangles,
    };
    expect(() =>
      serializeBinaryStl(
        city([part("tool-1", "part:1", excessiveVertices)]),
      ),
    ).toThrow(/vertex count.+safety limit/u);
  });

  it("rejects sparse vertex and triangle arrays", () => {
    const sparseTriangles = [...cube().triangles];
    delete sparseTriangles[0];
    expect(() =>
      serializeBinaryStl(
        city([
          part("tool-1", "part:1", {
            vertices: cube().vertices,
            triangles: sparseTriangles,
          }),
        ]),
      ),
    ).toThrow(/must be a triangle/u);

    const sparseVertices = [...cube().vertices];
    delete sparseVertices[0];
    expect(() =>
      serializeBinaryStl(
        city([
          part("tool-1", "part:1", {
            vertices: sparseVertices,
            triangles: cube().triangles,
          }),
        ]),
      ),
    ).toThrow(/must be a point/u);
  });
});
