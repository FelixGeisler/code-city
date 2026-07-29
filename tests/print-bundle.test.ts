import {
  strToU8,
  unzipSync,
} from "fflate";
import {
  describe,
  expect,
  it,
} from "vitest";

import type {
  PrintLabelReport,
  PrintMesh,
  PrintPart,
  PrintPrimitive,
  PrintableCity,
  PrintRouteReport,
} from "../packages/exporter/src/geometry.js";
import { cuboidMesh } from "../packages/exporter/src/geometry.js";
import {
  PRINT_BUNDLE_MANIFEST_BYTE_LIMIT,
  PRINT_BUNDLE_SCHEMA,
  serializePrintBundle,
  type PrintBundleDistrictTransform,
  type PrintBundlePlateRequest,
  type PrintBundleRequest,
  type PrintBundleRouteOmission,
} from "../packages/exporter/src/print-bundle.js";

const decoder = new TextDecoder();

const LABELS: PrintLabelReport = {
  printedBuildings: 0,
  skippedBuildings: 0,
  printedDistricts: 1,
  skippedDistricts: 0,
};

const ROUTES: PrintRouteReport = {
  policy: "auto",
  totalCount: 2,
  printedCount: 1,
  omittedCount: 1,
  totalWeight: 5,
  printedWeight: 3,
  omittedWeight: 2,
};

function bounds(
  x: number,
  y: number,
  z: number,
  width: number,
  depth: number,
  height: number,
) {
  return {
    minimum: { x, y, z },
    maximum: {
      x: x + width,
      y: y + depth,
      z: z + height,
    },
    size: { x: width, y: depth, z: height },
  };
}

function primitive(
  id: string,
  kind: "base" | "district",
  itemBounds: ReturnType<typeof bounds>,
): PrintPrimitive {
  return {
    id,
    kind,
    semanticGroupId: "base",
    channelId: "tool-1",
    bounds: itemBounds,
    mesh: cuboidMesh(itemBounds),
  };
}

function combine(meshes: readonly PrintMesh[]): PrintMesh {
  const vertices: PrintMesh["vertices"][number][] = [];
  const triangles: PrintMesh["triangles"][number][] = [];
  for (const mesh of meshes) {
    const offset = vertices.length;
    vertices.push(...mesh.vertices);
    triangles.push(
      ...mesh.triangles.map(({ a, b, c }) => ({
        a: a + offset,
        b: b + offset,
        c: c + offset,
      })),
    );
  }
  return { vertices, triangles };
}

function city(
  plateNumber: number,
  reverseParts = false,
): PrintableCity {
  const base = primitive(
    `plate-base-${plateNumber}`,
    "base",
    bounds(0, 0, 0, 40, 30, 1),
  );
  const district = primitive(
    `district-${plateNumber}`,
    "district",
    bounds(4, 5, 1, 12, 10, 1),
  );
  const basePart: PrintPart = {
    id: "part:tool-1",
    channelId: "tool-1",
    name: "Base",
    displayColor: "#6B7280",
    semanticGroupIds: ["base"],
    primitives: [base, district],
    mesh: combine([base.mesh, district.mesh]),
  };
  const markerBounds = bounds(6, 7, 2, 2, 2, 4 + plateNumber);
  const marker: PrintPrimitive = {
    id: `marker-${plateNumber}`,
    kind: "district",
    semanticGroupId: "risk",
    channelId: "tool-2",
    bounds: markerBounds,
    mesh: cuboidMesh(markerBounds),
  };
  const markerPart: PrintPart = {
    id: "part:tool-2",
    channelId: "tool-2",
    name: "Risk",
    displayColor: "#F59E0B",
    semanticGroupIds: ["risk"],
    primitives: [marker],
    mesh: marker.mesh,
  };
  const parts = reverseParts
    ? [markerPart, basePart]
    : [basePart, markerPart];
  return {
    application: { name: "Code City", version: "0.1.0-test" },
    profileId: "test-printer",
    title: "Äwesome City",
    version: "v1",
    unit: "millimeter",
    scale: 2,
    bounds: bounds(0, 0, 0, 40, 30, 6 + plateNumber),
    measurements: {
      baseThickness: 1,
      wallThickness: 1,
      minimumFeatureSize: 1,
      minimumGap: 1,
    },
    parts,
  };
}

function plate(
  number: number,
  reverseParts = false,
): PrintBundlePlateRequest {
  return {
    number,
    id: `physical-plate-${number}`,
    city: city(number, reverseParts),
    utilization: number === 1 ? 0.52 : 0.24,
    districts: ([
      {
        districtId: `marker-${number}`,
        translation: { x: 2, y: 3 },
        rotation: number === 1 ? 0 : 90,
      },
      {
        districtId: `district-${number}`,
        translation: { x: 1, y: 2 },
        rotation: 0,
      },
    ] satisfies PrintBundleDistrictTransform[]).reverse(),
    externalDependencies: [
      {
        target: "typescript",
        weight: number + 1,
        role: number === 1 ? "original" : "replica",
        consumer: {
          kind: "district",
          id: `D00${number}`,
          label: `District ${number}`,
          plateNumber: number,
        },
      },
    ],
    warnings: number === 1 ? ["Z warning", "A warning"] : [],
    labels: LABELS,
    routes: ROUTES,
  };
}

function request(
  format: "3mf" | "stl" = "3mf",
  reverse = false,
): PrintBundleRequest {
  const plates = [
    plate(1, reverse),
    plate(2, reverse),
  ];
  return {
    format,
    title: "Äwesome City",
    version: "v1",
    profile: { id: "test-printer", name: "Test Printer" },
    fitPolicy: "tile",
    requestedScale: 3,
    appliedScale: 2,
    warnings: reverse
      ? ["Scaled to preserve minimum features.", "Two plates."]
      : ["Two plates.", "Scaled to preserve minimum features."],
    unplacedObjects: [],
    routeOmissions: ([
      {
        routeId: "route-b",
        weight: 2,
        reason: "cross-plate",
        consumer: {
          kind: "district",
          id: "D001",
          label: "District 1",
          plateNumber: 1,
        },
        provider: {
          kind: "district",
          id: "D002",
          label: "District 2",
          plateNumber: 2,
        },
      },
      {
        routeId: "route-a",
        weight: 1,
        reason: "unroutable",
        consumer: {
          kind: "building",
          id: "B001",
          label: "Consumer",
          plateNumber: 1,
        },
        provider: {
          kind: "external",
          id: "typescript",
          label: "typescript",
        },
      },
    ] satisfies PrintBundleRouteOmission[]).reverse(),
    plates: reverse ? plates.reverse() : plates,
    legendBytes: strToU8('{"title":"Äwesome City"}\n'),
  };
}

describe("deterministic multi-plate print bundles", () => {
  it.each(["3mf", "stl"] as const)(
    "writes exactly one %s artifact per plate plus manifest and legend",
    (format) => {
      const result = serializePrintBundle(request(format));
      const archive = unzipSync(result.bytes);

      expect(Object.keys(archive).sort()).toEqual([
        "legend.json",
        "manifest.json",
        `plate-01.${format}`,
        `plate-02.${format}`,
      ]);
      expect(result.artifacts.map(({ fileName }) => fileName)).toEqual([
        `plate-01.${format}`,
        `plate-02.${format}`,
      ]);
      expect(result.fileName).toBe("awesome-city-print-bundle.zip");
      expect(result.mimeType).toBe("application/zip");
      expect(archive[`plate-01.${format}`]).toEqual(
        result.artifacts[0]?.bytes,
      );
      expect(archive["manifest.json"]).toEqual(result.manifestBytes);

      if (format === "3mf") {
        expect(Object.keys(unzipSync(result.artifacts[0]!.bytes))).toContain(
          "3D/3dmodel.model",
        );
      } else {
        expect(
          new DataView(
            result.artifacts[0]!.bytes.buffer,
            result.artifacts[0]!.bytes.byteOffset,
            result.artifacts[0]!.bytes.byteLength,
          ).getUint32(80, true),
        ).toBeGreaterThan(0);
      }
    },
  );

  it("publishes exact fit, layout, preflight, route identities, and repeated external metadata", () => {
    const result = serializePrintBundle(request());
    const manifest = JSON.parse(
      decoder.decode(result.manifestBytes),
    ) as typeof result.manifest;

    expect(manifest).toEqual(result.manifest);
    expect(manifest.schema).toBe(PRINT_BUNDLE_SCHEMA);
    expect(manifest.fit).toEqual({
      policy: "tile",
      requestedScale: 3,
      appliedScale: 2,
    });
    expect(manifest.plateCount).toBe(2);
    expect(manifest.plates[0]?.layout).toMatchObject({
      bounds: {
        size: { width: 40, depth: 30, height: 7 },
      },
      base: {
        size: { width: 40, depth: 30, height: 1 },
      },
      utilization: 0.52,
      districts: [
        {
          districtId: "district-1",
          translation: { x: 1, y: 2 },
          rotation: 0,
        },
        {
          districtId: "marker-1",
          translation: { x: 2, y: 3 },
          rotation: 0,
        },
      ],
    });
    expect(manifest.plates[0]?.preflight).toMatchObject({
      dimensions: { width: 40, depth: 30, height: 7 },
      partCount: 2,
      triangleCount: 36,
      routeOmissionCount: 2,
      externalDependencyCount: 1,
    });
    expect(manifest.plates[0]?.preflight.channels).toEqual([
      {
        id: "tool-1",
        partId: "part:tool-1",
        label: "Base",
        displayColor: "#6B7280",
        semanticGroupIds: ["base"],
        primitiveCount: 2,
        triangleCount: 24,
      },
      {
        id: "tool-2",
        partId: "part:tool-2",
        label: "Risk",
        displayColor: "#F59E0B",
        semanticGroupIds: ["risk"],
        primitiveCount: 1,
        triangleCount: 12,
      },
    ]);
    expect(
      manifest.plates.map(({ externalDependencies }) =>
        externalDependencies.map(({ target, role }) => ({
          target,
          role,
        })),
      ),
    ).toEqual([
      [{ target: "typescript", role: "original" }],
      [{ target: "typescript", role: "replica" }],
    ]);
    expect(manifest.routeOmissions).toEqual([
      expect.objectContaining({
        routeId: "route-a",
        consumer: expect.objectContaining({
          kind: "building",
          id: "B001",
        }),
        provider: expect.objectContaining({
          kind: "external",
          id: "typescript",
        }),
      }),
      expect.objectContaining({
        routeId: "route-b",
        reason: "cross-plate",
        consumer: expect.objectContaining({ plateNumber: 1 }),
        provider: expect.objectContaining({ plateNumber: 2 }),
      }),
    ]);
    expect(manifest.routeOmissionSummary).toEqual({
      count: 2,
      totalWeight: 3,
      byReason: {
        "cross-plate": 1,
        "route-limit": 0,
        unroutable: 1,
        policy: 0,
        "unplaced-endpoint": 0,
      },
    });
  });

  it("is byte-identical across plate, part, warning, transform, and omission input order", () => {
    const first = serializePrintBundle(request("3mf", false));
    const reordered = serializePrintBundle(request("3mf", true));

    expect(reordered.manifest).toEqual(first.manifest);
    expect(reordered.manifestBytes).toEqual(first.manifestBytes);
    expect(reordered.artifacts.map(({ bytes }) => bytes)).toEqual(
      first.artifacts.map(({ bytes }) => bytes),
    );
    expect(reordered.bytes).toEqual(first.bytes);
  });

  it("does not mutate or retain mutable request buffers and arrays", () => {
    const input = request();
    const originalJson = JSON.stringify(input);
    const originalLegend = [...input.legendBytes!];
    const result = serializePrintBundle(input);

    expect(JSON.stringify(input)).toBe(originalJson);
    expect([...input.legendBytes!]).toEqual(originalLegend);

    (input.warnings as string[]).push("late mutation");
    input.legendBytes![0] = 0;
    expect(result.manifest.warnings).not.toContain("late mutation");
    expect(unzipSync(result.bytes)["legend.json"]).toEqual(
      Uint8Array.from(originalLegend),
    );
  });

  it("preserves finite fractional weights and saturates aggregate weight metadata", () => {
    const input = request();
    const first = input.plates[0]!;
    const second = input.plates[1]!;
    const result = serializePrintBundle({
      ...input,
      routeOmissions: input.routeOmissions.map((omission) => ({
        ...omission,
        weight:
          omission.routeId === "route-a" ? 0.25 : Number.MAX_VALUE,
      })),
      plates: [
        {
          ...first,
          routes: {
            ...first.routes,
            totalWeight: 0.3,
            printedWeight: 0.1,
            omittedWeight: 0.2,
          },
          externalDependencies: first.externalDependencies.map(
            (dependency) => ({
              ...dependency,
              weight: 0.5,
            }),
          ),
        },
        {
          ...second,
          routes: {
            ...second.routes,
            totalWeight: Number.MAX_VALUE,
            printedWeight: Number.MAX_VALUE,
            omittedWeight: Number.MAX_VALUE,
          },
          externalDependencies: second.externalDependencies.map(
            (dependency) => ({
              ...dependency,
              weight: Number.MAX_VALUE,
            }),
          ),
        },
      ],
    });

    expect(result.manifest.plates[0]!.preflight.routes).toMatchObject({
      totalWeight: 0.3,
      printedWeight: 0.1,
      omittedWeight: 0.2,
    });
    expect(
      result.manifest.plates[0]!.externalDependencies[0]!.weight,
    ).toBe(0.5);
    expect(
      result.manifest.plates[1]!.externalDependencies[0]!.weight,
    ).toBe(Number.MAX_VALUE);
    expect(result.manifest.routeOmissionSummary.totalWeight).toBe(
      Number.MAX_VALUE,
    );
  });

  it("rejects ambiguous plates and inconsistent plate geometry instead of omitting it", () => {
    const base = request();

    expect(() =>
      serializePrintBundle({
        ...base,
        plates: [
          { ...base.plates[0]!, number: 2 },
          { ...base.plates[1]!, number: 3 },
        ],
      }),
    ).toThrow(/contiguous integers starting at 1/u);

    expect(() =>
      serializePrintBundle({
        ...base,
        plates: [
          {
            ...base.plates[0]!,
            city: { ...base.plates[0]!.city, scale: 1 },
          },
          base.plates[1]!,
        ],
      }),
    ).toThrow(/applied bundle scale/u);

    expect(() =>
      serializePrintBundle({
        ...base,
        plates: [
          {
            ...base.plates[0]!,
            districts: [],
          },
          base.plates[1]!,
        ],
      }),
    ).toThrow(/missing the transform/u);
  });

  it("supports small byte ceilings and rejects before geometry normalization", () => {
    const result = serializePrintBundle(request("3mf"), {
      maximumBytes: 250_000,
    });
    expect(result.bytes.byteLength).toBeLessThanOrEqual(250_000);

    const overBudget = request("3mf");
    let vertexCoordinateRead = false;
    const firstVertex = overBudget.plates[0]!.city.parts[0]!.mesh.vertices[0]!;
    const firstX = firstVertex.x;
    Object.defineProperty(firstVertex, "x", {
      configurable: true,
      enumerable: true,
      get() {
        vertexCoordinateRead = true;
        return firstX;
      },
    });
    expect(() =>
      serializePrintBundle(overBudget, {
        maximumBytes: 140_000,
      }),
    ).toThrow(/before normalizing plate 2/u);
    expect(vertexCoordinateRead).toBe(false);
  });

  it("rejects a guaranteed oversized manifest before record normalization or JSON encoding", () => {
    const base = request("stl");
    const omissionCount =
      Math.floor(PRINT_BUNDLE_MANIFEST_BYTE_LIMIT / 192) + 1;
    const routeOmissions = Array.from(
      { length: omissionCount },
      (_, index): PrintBundleRouteOmission => ({
        routeId: `route-${index}`,
        weight: 1,
        reason: "policy",
        consumer: {
          kind: "district",
          id: "consumer",
          label: "Consumer",
          plateNumber: 1,
        },
        provider: {
          kind: "district",
          id: "provider",
          label: "Provider",
          plateNumber: 2,
        },
      }),
    );
    const input: PrintBundleRequest = {
      ...base,
      routeOmissions,
    };
    let routeIdRead = false;
    const first = input.routeOmissions[0]!;
    Object.defineProperty(first, "routeId", {
      configurable: true,
      enumerable: true,
      get() {
        routeIdRead = true;
        return "route-0";
      },
    });

    expect(() => serializePrintBundle(input)).toThrow(
      /manifest.*minimum envelope.*before normalization/iu,
    );
    expect(routeIdRead).toBe(false);
  });
});
