import { describe, expect, it } from "vitest";

import { DEMO_MODEL } from "../apps/viewer/src/demo-model.js";
import {
  buildPrintableCity,
  buildPrintableCityArtifacts,
  cuboidMesh,
  PRINT_LOGO_RELIEF_FALLBACK_WARNING,
  printablePlanGeometry,
  type PrintBounds,
  type PrintSemanticAssignment,
  type PrintableCity,
} from "../packages/exporter/src/geometry.js";
import { printableTextCells } from "../packages/exporter/src/printable-font.js";
import {
  PrintGeometryValidationError,
  signedMeshVolume,
  validatePrintableCity,
} from "../packages/exporter/src/validate.js";
import {
  DEFAULT_FDM_GEOMETRY_LIMITS,
  createPrusaXLProfile,
  createSingleChannelProfile,
  encodeIdentityLogoPrintReliefMask,
  type PrinterProfile,
} from "../packages/core/src/index.js";

function assignments(
  channelIds: readonly string[] = [
    "tool-1",
    "tool-2",
    "tool-3",
    "tool-4",
    "tool-5",
  ],
): readonly PrintSemanticAssignment[] {
  return DEMO_MODEL.semanticGroups.map((group, index) => ({
    semanticGroupId: group.id,
    channelId: channelIds[Math.min(index, channelIds.length - 1)]!,
  }));
}

function demoCity(): PrintableCity {
  return buildPrintableCity(
    DEMO_MODEL,
    assignments(),
    {
      scale: 3,
      profile: createPrusaXLProfile([1, 2, 3, 4, 5]),
      labelPolicy: "off",
    },
  );
}

function sevenChannelProfile(): PrinterProfile {
  return {
    id: "generic-seven",
    name: "Generic seven-channel printer",
    printChannels: Array.from({ length: 7 }, (_, index) => ({
      id: `channel-${index + 1}`,
      label: `Channel ${index + 1}`,
      mechanism: "filament-switcher" as const,
      color: `#${(index + 1).toString(16).padStart(6, "0")}`,
    })),
    supportedFormats: ["3mf"],
    buildVolume: { x: 300, y: 300, z: 300 },
    geometryLimits: DEFAULT_FDM_GEOMETRY_LIMITS,
    overflowPolicy: "merge",
  };
}

describe("print-space cuboids", () => {
  it("uses eight vertices and twelve outward triangles", () => {
    const box: PrintBounds = {
      minimum: { x: 10, y: 20, z: 30 },
      maximum: { x: 12, y: 23, z: 34 },
      size: { x: 2, y: 3, z: 4 },
    };
    const mesh = cuboidMesh(box);

    expect(mesh.vertices).toHaveLength(8);
    expect(mesh.triangles).toHaveLength(12);
    expect(signedMeshVolume(mesh)).toBeCloseTo(24, 10);
    const edgeCounts = new Map<string, number>();
    for (const triangle of mesh.triangles) {
      for (const [left, right] of [
        [triangle.a, triangle.b],
        [triangle.b, triangle.c],
        [triangle.c, triangle.a],
      ] as const) {
        const key =
          left < right ? `${left}:${right}` : `${right}:${left}`;
        edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
      }
    }
    expect(new Set(edgeCounts.values())).toEqual(new Set([2]));
  });
});

describe("Demo printable geometry", () => {
  it("normalizes Y-up city geometry into a connected Z-up print", () => {
    const city = demoCity();

    expect(city.application).toEqual({
      name: "Code City",
      version: "0.1.0-demo",
    });
    expect(city.title).toBe("Code City");
    expect(city.version).toBe("Demo 0.1");
    expect(city.scale).toBe(3);
    expect(city.unit).toBe("millimeter");
    expect(city.bounds.minimum).toEqual({ x: 0, y: 0, z: 0 });
    expect(city.bounds.size).toEqual({ x: 93, y: 48, z: 33 });
    expect(city.measurements.baseThickness).toBe(1.5);
    expect(city.measurements.wallThickness).toBeCloseTo(0.8, 10);
    expect(city.measurements.minimumFeatureSize).toBeCloseTo(0.8, 10);
    expect(city.measurements.minimumGap).toBeCloseTo(0.8, 10);
    expect(city.parts.map(({ channelId }) => channelId)).toEqual([
      "tool-1",
      "tool-2",
      "tool-5",
    ]);

    const primitives = city.parts.flatMap(({ primitives }) => primitives);
    const base = primitives.find(({ kind }) => kind === "base")!;
    const districts = primitives.filter(({ kind }) => kind === "district");
    const main = primitives.find(({ id }) => id === "building:main")!;
    const panel = primitives.find(
      ({ kind }) => kind === "identity-panel",
    )!;

    expect(base.bounds.size).toEqual({ x: 93, y: 48, z: 1.5 });
    expect(districts).toHaveLength(2);
    expect(
      districts.every(
        (district) =>
          district.semanticGroupId === "base" &&
          district.bounds.minimum.z === base.bounds.maximum.z,
      ),
    ).toBe(true);
    expect(panel.bounds.minimum.z).toBe(base.bounds.maximum.z);
    const planned = printablePlanGeometry(city);
    expect(planned.bounds).toEqual({ x: 93, y: 33, z: 48 });
    expect(planned.identityPanel).toMatchObject({
      id: panel.id,
      semanticGroupId: "identity",
      size: {
        x: panel.bounds.size.x,
        y: panel.bounds.size.z,
        z: panel.bounds.size.y,
      },
      reliefDepth: 0.8,
    });
    expect(
      planned.identityPanel!.position.z -
        planned.identityPanel!.size.z / 2 -
        planned.identityPanel!.reliefDepth,
    ).toBeCloseTo(0, 10);
    expect(main.bounds.maximum.z).toBe(33);
    expect(main.bounds.minimum.y).toBeCloseTo(12.6, 10);
    expect(
      primitives.every(
        ({ mesh }) =>
          mesh.vertices.length === 8 && mesh.triangles.length === 12,
      ),
    ).toBe(true);
    expect(
      validatePrintableCity(
        city,
        createPrusaXLProfile([1, 2, 3, 4, 5]),
      ),
    ).toEqual([]);
  });

  it("applies model-axis margins as print X/Z/Y usable spans", () => {
    const city = demoCity();
    const baseProfile = createPrusaXLProfile([1, 2, 3, 4, 5]);
    const profile: PrinterProfile = {
      ...baseProfile,
      buildVolume: { x: 94, y: 34, z: 49 },
      geometryLimits: {
        ...baseProfile.geometryLimits,
        buildMargins: { x: 1, y: 1, z: 1 },
        maximumModelHeight: 32,
      },
    };
    const issues = validatePrintableCity(city, profile);

    expect(issues).toContain(
      "Printable city X size (93) exceeds the usable build span (92) after margins.",
    );
    expect(issues).toContain(
      "Printable city Y size (48) exceeds the usable build span (47) after margins.",
    );
    expect(issues).toContain(
      "Printable city Z size (33) exceeds the usable build span (32) after margins.",
    );
    expect(issues).toContain(
      "Printable city model height (33) exceeds profile maximum (32).",
    );
  });

  it("adds minimum-detail block text and a skyline to the plaque", () => {
    const city = demoCity();
    const identityPart = city.parts.find(
      ({ channelId }) => channelId === "tool-2",
    )!;
    const relief = identityPart.primitives.filter(
      ({ kind }) => kind === "identity-relief",
    );

    expect(
      relief.filter(({ id }) => id.startsWith("identity-relief:skyline:")),
    ).toHaveLength(3);
    expect(
      relief.some(({ id }) => id.startsWith("identity-relief:title:")),
    ).toBe(true);
    expect(
      relief.some(({ id }) => id.startsWith("identity-relief:version:")),
    ).toBe(true);
    expect(
      relief.every(
        ({ bounds }) =>
          bounds.size.x >= 0.8 - 1e-9 &&
          bounds.size.y >= 0.8 - 1e-9 &&
          bounds.size.z >= 0.8 - 1e-9,
      ),
    ).toBe(true);
  });

  it("uses the main identity logo relief instead of the fixed skyline", () => {
    const profile = createPrusaXLProfile([1, 2, 3, 4, 5]);
    const model = {
      ...DEMO_MODEL,
      identity: {
        ...DEMO_MODEL.identity!,
        logo: {
          relativePath: "assets/logo.png",
          format: "png" as const,
          printRelief: {
            version: "codecity.logo-relief/1" as const,
            width: 4,
            height: 4,
            mask: "-Z8",
          },
        },
      },
    };

    const first = buildPrintableCityArtifacts(
      model,
      assignments(),
      { scale: 3, profile, labelPolicy: "off" },
    );
    const second = buildPrintableCityArtifacts(
      model,
      assignments(),
      { scale: 3, profile, labelPolicy: "off" },
    );
    const primitives = first.city.parts.flatMap(
      ({ primitives: items }) => items,
    );
    const panel = primitives.find(
      ({ kind }) => kind === "identity-panel",
    )!;
    const logo = primitives.filter(({ id }) =>
      id.startsWith("identity-relief:logo:"),
    );

    expect(first.warnings).toEqual([]);
    expect(logo.length).toBeGreaterThan(0);
    expect(logo.length).toBeLessThanOrEqual(256);
    expect(
      primitives.some(({ id }) =>
        id.startsWith("identity-relief:skyline:"),
      ),
    ).toBe(false);
    expect(
      logo.every(
        ({ bounds }) =>
          bounds.minimum.x >= panel.bounds.minimum.x - 1e-9 &&
          bounds.maximum.x <= panel.bounds.maximum.x + 1e-9 &&
          bounds.minimum.z >= panel.bounds.minimum.z - 1e-9 &&
          bounds.maximum.z <= panel.bounds.maximum.z + 1e-9 &&
          bounds.size.x >= 0.8 - 1e-9 &&
          bounds.size.y >= 0.8 - 1e-9 &&
          bounds.size.z >= 0.8 - 1e-9,
      ),
    ).toBe(true);
    expect(first.city).toEqual(second.city);
    expect(validatePrintableCity(first.city, profile)).toEqual([]);
  });

  it("simplifies a dense 64x64 logo to at most 256 stable rectangles", () => {
    const bytes = new Uint8Array(64 * 64 / 8);
    for (let bit = 0; bit < 64 * 64; bit += 1) {
      const x = bit % 64;
      const y = Math.floor(bit / 64);
      if ((x + y) % 2 === 0) {
        bytes[Math.floor(bit / 8)]! |= 0x80 >> (bit % 8);
      }
    }
    const model = {
      ...DEMO_MODEL,
      identity: {
        ...DEMO_MODEL.identity!,
        logo: {
          relativePath: "assets/logo.svg",
          format: "svg" as const,
          printRelief: {
            version: "codecity.logo-relief/1" as const,
            width: 64,
            height: 64,
            mask: encodeIdentityLogoPrintReliefMask(bytes),
          },
        },
      },
    };
    const artifacts = buildPrintableCityArtifacts(
      model,
      assignments(),
      {
        scale: 3,
        profile: createPrusaXLProfile([1, 2, 3, 4, 5]),
        labelPolicy: "off",
      },
    );
    const logo = artifacts.city.parts
      .flatMap(({ primitives }) => primitives)
      .filter(({ id }) => id.startsWith("identity-relief:logo:"));

    expect(logo.length).toBeGreaterThan(0);
    expect(logo.length).toBeLessThanOrEqual(256);
    expect(artifacts.warnings).toEqual([]);
  });

  it("falls back once for a requested display logo without print relief", () => {
    const artifacts = buildPrintableCityArtifacts(
      {
        ...DEMO_MODEL,
        identity: {
          ...DEMO_MODEL.identity!,
          logo: {
            relativePath: "assets/logo.svg",
            format: "svg",
          },
        },
      },
      assignments(),
      {
        scale: 3,
        profile: createPrusaXLProfile([1, 2, 3, 4, 5]),
        labelPolicy: "off",
      },
    );
    const primitives = artifacts.city.parts.flatMap(
      ({ primitives: items }) => items,
    );

    expect(artifacts.warnings).toEqual([
      PRINT_LOGO_RELIEF_FALLBACK_WARNING,
    ]);
    expect(
      primitives.filter(({ id }) =>
        id.startsWith("identity-relief:skyline:"),
      ),
    ).toHaveLength(3);
  });

  it("applies explicit label-stroke and raised-feature limits to relief", () => {
    const baseProfile = createPrusaXLProfile([1, 2, 3, 4, 5]);
    const profile: PrinterProfile = {
      ...baseProfile,
      geometryLimits: {
        ...baseProfile.geometryLimits,
        minimumLabelStrokeWidth: 1.2,
        minimumRaisedFeatureHeight: 1.6,
      },
    };
    const city = buildPrintableCity(
      DEMO_MODEL,
      assignments(),
      { scale: 3, profile, labelPolicy: "off" },
    );
    const relief = city.parts
      .flatMap(({ primitives }) => primitives)
      .filter(({ kind }) => kind === "identity-relief");

    expect(relief.length).toBeGreaterThan(0);
    expect(
      relief.every(({ bounds }) =>
        bounds.size.x >= 1.2 - 1e-9 &&
        bounds.size.y >= 1.6 - 1e-9 &&
        bounds.size.z >= 1.2 - 1e-9
      ),
    ).toBe(true);
    expect(validatePrintableCity(city, profile)).toEqual([]);
  });

  it("adds fitting same-channel roof codes and ground district labels", () => {
    const profile = createPrusaXLProfile([1, 2, 3, 4, 5]);
    const artifacts = buildPrintableCityArtifacts(
      DEMO_MODEL,
      assignments(),
      { scale: 3, profile, labelPolicy: "auto" },
    );
    const primitives = artifacts.city.parts.flatMap(
      ({ primitives }) => primitives,
    );
    const buildingLabels = primitives.filter(
      ({ kind }) => kind === "building-label",
    );
    const districtLabels = primitives.filter(
      ({ kind }) => kind === "district-label",
    );

    expect(artifacts.labels).toEqual({
      printedBuildings: 5,
      skippedBuildings: 0,
      printedDistricts: 2,
      skippedDistricts: 0,
    });
    expect(buildingLabels).toHaveLength(5);
    expect(districtLabels).toHaveLength(2);
    for (const label of buildingLabels) {
      const building = primitives.find(
        ({ id }) => `building-label:${id}` === label.id,
      )!;
      expect(label.channelId).toBe(building.channelId);
      expect(label.semanticGroupId).toBe(building.semanticGroupId);
      expect(label.bounds.minimum.z).toBe(building.bounds.maximum.z);
    }
    const base = primitives.find(({ kind }) => kind === "base")!;
    expect(
      districtLabels.every(
        ({ channelId, semanticGroupId }) =>
          channelId === base.channelId && semanticGroupId === "base",
      ),
    ).toBe(true);
    expect(validatePrintableCity(artifacts.city, profile)).toEqual([]);
    expect(artifacts.city.bounds.size.z).toBeCloseTo(33.8, 10);
    const codeZero = artifacts.legend.buildings.find(
      ({ code }) => code === "000",
    )!;
    const unionedLabel = buildingLabels.find(
      ({ id }) => id === `building-label:${codeZero.buildingId}`,
    )!;
    expect(unionedLabel.mesh.triangles.length).toBeLessThan(
      printableTextCells("000", 0.8).length * 12,
    );
  });

  it("enlarges or omits labels when a profile requires wider glyph gaps", () => {
    const profile = {
      ...createPrusaXLProfile([1, 2, 3, 4, 5]),
      geometryLimits: {
        ...createPrusaXLProfile([1]).geometryLimits,
        minimumGap: 1.2,
      },
    };
    const {
      identity: _identity,
      identityPanel: _identityPanel,
      ...model
    } = DEMO_MODEL;
    const artifacts = buildPrintableCityArtifacts(
      model,
      assignments(),
      { scale: 3, profile, labelPolicy: "auto" },
    );

    expect(artifacts.labels.printedBuildings).toBe(0);
    expect(artifacts.labels.skippedBuildings).toBe(5);
    expect(validatePrintableCity(artifacts.city, profile)).toEqual([]);
  });

  it("is byte-input deterministic and independent of assignment order", () => {
    const profile = createPrusaXLProfile([1, 2, 3, 4, 5]);
    const forward = buildPrintableCity(DEMO_MODEL, assignments(), {
      scale: 3,
      profile,
    });
    const reverse = buildPrintableCity(
      DEMO_MODEL,
      [...assignments()].reverse(),
      { scale: 3, profile },
    );

    expect(reverse).toEqual(forward);
  });

  it("supports one, two, five, and more than five used channels", () => {
    const one = createSingleChannelProfile({
      buildVolume: { x: 300, y: 300, z: 300 },
    });
    const oneAssignments = DEMO_MODEL.semanticGroups.map(({ id }) => ({
      semanticGroupId: id,
      channelId: "channel-1",
    }));
    expect(
      buildPrintableCity(DEMO_MODEL, oneAssignments, {
        scale: 3,
        profile: one,
      }).parts,
    ).toHaveLength(1);

    const two = createPrusaXLProfile([1, 2]);
    expect(
      buildPrintableCity(DEMO_MODEL, assignments(["tool-1", "tool-2"]), {
        scale: 3,
        profile: two,
      }).parts,
    ).toHaveLength(2);
    expect(demoCity().parts).toHaveLength(3);

    const extraGroups = DEMO_MODEL.buildings.map((_, index) => ({
      id: `building-group-${index + 1}`,
      label: `Building ${index + 1}`,
      color: "#123456",
      priority: 10 - index,
    }));
    const sevenGroupModel = {
      ...DEMO_MODEL,
      semanticGroups: [
        DEMO_MODEL.semanticGroups[0]!,
        DEMO_MODEL.semanticGroups[1]!,
        ...extraGroups,
      ],
      buildings: DEMO_MODEL.buildings.map((building, index) => ({
        ...building,
        semanticGroupId: extraGroups[index]!.id,
      })),
    };
    const profile = sevenChannelProfile();
    const sevenAssignments =
      sevenGroupModel.semanticGroups.map((group, index) => ({
        semanticGroupId: group.id,
        channelId: profile.printChannels[index]!.id,
      }));
    expect(
      buildPrintableCity(sevenGroupModel, sevenAssignments, {
        scale: 3,
        profile,
      }).parts,
    ).toHaveLength(7);
  });

  it("rejects unsafe scale, build volume, overlap, and assignments", () => {
    const profile = createPrusaXLProfile([1, 2, 3, 4, 5]);
    expect(() =>
      buildPrintableCity(DEMO_MODEL, assignments(), {
        scale: 0,
        profile,
      }),
    ).toThrow(/scale must be a positive/u);
    expect(() =>
      buildPrintableCity(DEMO_MODEL, assignments().slice(0, 4), {
        scale: 3,
        profile,
      }),
    ).toThrow(/Missing print assignment/u);

    const exactBuildVolume: PrinterProfile = {
      ...profile,
      id: "exact-build-volume",
      buildVolume: { x: 93, y: 33, z: 48 },
    };
    expect(() =>
      buildPrintableCity(DEMO_MODEL, assignments(), {
        scale: 3,
        profile: exactBuildVolume,
      }),
    ).not.toThrow();

    const tooShallow: PrinterProfile = {
      ...exactBuildVolume,
      id: "too-shallow",
      buildVolume: { ...exactBuildVolume.buildVolume, z: 47 },
    };
    expect(() =>
      buildPrintableCity(DEMO_MODEL, assignments(), {
        scale: 3,
        profile: tooShallow,
      }),
    ).toThrow(/Y size \(48\) exceeds build volume \(47\)/u);

    const tooShort: PrinterProfile = {
      ...exactBuildVolume,
      id: "too-short",
      buildVolume: { ...exactBuildVolume.buildVolume, y: 32 },
    };
    expect(() =>
      buildPrintableCity(DEMO_MODEL, assignments(), {
        scale: 3,
        profile: tooShort,
      }),
    ).toThrow(/Z size \(33\) exceeds build volume \(32\)/u);

    const overlapModel = {
      ...DEMO_MODEL,
      buildings: DEMO_MODEL.buildings.map((building, index) =>
        index === 1
          ? {
              ...building,
              position: { ...DEMO_MODEL.buildings[0]!.position },
            }
          : building,
      ),
    };
    expect(() =>
      buildPrintableCity(overlapModel, assignments(), {
        scale: 3,
        profile,
      }),
    ).toThrow(/overlap with positive volume/u);

    expect(() =>
      buildPrintableCity(DEMO_MODEL, assignments(), {
        scale: 3,
        profile: {
          ...profile,
          geometryLimits: {
            ...profile.geometryLimits,
            minimumWallThickness: 1,
          },
        },
      }),
    ).toThrow(/Wall thickness .* below profile minimum/u);
    expect(() =>
      buildPrintableCity(DEMO_MODEL, assignments(), {
        scale: 3,
        profile: {
          ...profile,
          geometryLimits: {
            ...profile.geometryLimits,
            minimumGap: 1,
          },
        },
      }),
    ).toThrow(/Minimum gap .* below profile minimum/u);
  });

  it("rejects unsupported plaque characters instead of changing identity", () => {
    expect(() =>
      buildPrintableCity(
        {
          ...DEMO_MODEL,
          identity: {
            ...DEMO_MODEL.identity!,
            title: "CØDE CITY",
          },
        },
        assignments(),
        {
          scale: 3,
          profile: createPrusaXLProfile([1, 2, 3, 4, 5]),
        },
      ),
    ).toThrow(/unsupported character 'Ø'/u);
  });

  it("reports broken winding and disconnected primitives", () => {
    const profile = createPrusaXLProfile([1, 2, 3, 4, 5]);
    const city = demoCity();
    const mutable = structuredClone(city);
    const firstPrimitive = mutable.parts[0]!.primitives[0]!;
    const firstTriangle = firstPrimitive.mesh.triangles[0]!;
    const mutableTriangles = firstPrimitive.mesh
      .triangles as Array<{ a: number; b: number; c: number }>;
    mutableTriangles[0] = {
      a: firstTriangle.a,
      b: firstTriangle.c,
      c: firstTriangle.b,
    };

    expect(validatePrintableCity(mutable, profile).join(" ")).toMatch(
      /not wound outward/u,
    );

    const disconnected = structuredClone(city);
    const building = disconnected.parts
      .flatMap(({ primitives }) => primitives)
      .find(({ kind }) => kind === "building")!;
    const mutableBounds = building.bounds as {
      minimum: { z: number };
      maximum: { z: number };
    };
    mutableBounds.minimum.z += 1;
    mutableBounds.maximum.z += 1;
    expect(validatePrintableCity(disconnected, profile).join(" ")).toMatch(
      /no positive-area face connection/u,
    );
  });

  it("never lets dependency routes provide structural connectivity", () => {
    const profile = createPrusaXLProfile([1, 2, 3, 4, 5]);
    const city = structuredClone(demoCity());
    const primitives = city.parts.flatMap(({ primitives: items }) => items);
    const district = primitives.find(({ kind }) => kind === "district")!;
    (district as { kind: string }).kind = "dependency-trace";
    (district as { semanticGroupId: string }).semanticGroupId = "routes";

    const issues = validatePrintableCity(city, profile).join(" ");
    expect(issues).toMatch(/no positive-area face connection/u);

    const detachedRoute = structuredClone(demoCity());
    const building = detachedRoute.parts
      .flatMap(({ primitives: items }) => items)
      .find(({ kind }) => kind === "building")!;
    (building as { kind: string }).kind = "dependency-trace";
    (building as { semanticGroupId: string }).semanticGroupId = "routes";
    expect(validatePrintableCity(detachedRoute, profile).join(" ")).toMatch(
      /Route primitive .* rest on top of/u,
    );

    const overhangingRoute = structuredClone(demoCity());
    const overhang = overhangingRoute.parts
      .flatMap(({ primitives: items }) => items)
      .find(({ kind }) => kind === "district")!;
    (overhang as { kind: string }).kind = "dependency-trace";
    (overhang as { semanticGroupId: string }).semanticGroupId = "routes";
    (overhang.bounds.maximum as { x: number }).x += 1;
    expect(validatePrintableCity(overhangingRoute, profile).join(" ")).toMatch(
      /remain inside the shared base/u,
    );
  });
});
