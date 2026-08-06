import { readFileSync } from "node:fs";
import { unzipSync } from "fflate";

import {
  describe,
  expect,
  it,
} from "vitest";

import { DEMO_MODEL } from "../apps/viewer/src/demo-model.js";
import {
  createPrusaXLProfile,
  createSingleChannelProfile,
  parsePrinterProfileJson,
  PRINT_FIDELITY_EPSILON,
  PrintLayoutError,
  resolvePrinterGeometryLimits,
  validateCityModel,
  type CityDependency,
  type CityModel,
  type PrinterProfile,
} from "../packages/core/src/index.js";
import {
  generatePrintPlateBundle,
  preparePrintPlateBundle,
  serializePreparedPrintPlateBundle,
  serializePreparedSinglePrintPlateExport,
} from "../packages/exporter/src/print-plates.js";
import {
  PRINT_LOGO_RELIEF_FALLBACK_WARNING,
} from "../packages/exporter/src/geometry.js";
import {
  validatePrintableCity,
} from "../packages/exporter/src/validate.js";

interface DistrictShape {
  readonly width: number;
  readonly depth: number;
  readonly height?: number;
}

function syntheticCity(
  shapes: readonly DistrictShape[],
  dependencies: readonly CityDependency[] = [],
  title = "Synthetic City",
): CityModel {
  const repositoryId = "repository:synthetic";
  const moduleIds = shapes.map(
    (_, index) => `module:${String(index).padStart(3, "0")}`,
  );
  const columns = Math.max(1, Math.ceil(Math.sqrt(shapes.length)));
  const districts = shapes.map((shape, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x = column * 300;
    const z = row * 300;
    return {
      id: `district:${String(index).padStart(3, "0")}`,
      repositoryId,
      moduleId: moduleIds[index]!,
      name: `District ${String(index).padStart(3, "0")}`,
      path: `modules/${String(index).padStart(3, "0")}`,
      position: { x, y: 1, z },
      size: { x: shape.width, y: 1, z: shape.depth },
    };
  });
  const buildings = districts.map((district, index) => {
    const height = shapes[index]!.height ?? 8;
    return {
      id: `building:${String(index).padStart(3, "0")}`,
      repositoryId,
      moduleId: district.moduleId,
      districtId: district.id,
      name: `building-${String(index).padStart(3, "0")}.ts`,
      path: `${district.path}/building.ts`,
      language: "typescript" as const,
      metrics: {
        sloc: 100 + index,
        decisionLoad: 10,
        maximumComplexity: 4,
        executableUnitCount: 5,
      },
      risk: "low" as const,
      semanticGroupId: "group:viewer",
      position: {
        x: district.position.x,
        y: 1.5 + height / 2,
        z: district.position.z,
      },
      size: {
        x: Math.min(20, district.size.x / 2),
        y: height,
        z: Math.min(20, district.size.z / 2),
      },
    };
  });
  const maximumColumn = Math.max(0, columns - 1);
  const rows = Math.max(1, Math.ceil(shapes.length / columns));
  const baseWidth = maximumColumn * 300 + 300;
  const baseDepth = Math.max(0, rows - 1) * 300 + 300;
  return validateCityModel({
    schemaVersion: "1.0",
    generator: { name: "code-city", version: "test" },
    repositories: [{ id: repositoryId, name: title }],
    solutions: [
      {
        id: "solution:synthetic",
        repositoryId,
        name: title,
        path: ".",
        moduleIds,
      },
    ],
    modules: moduleIds.map((id, index) => ({
      id,
      repositoryId,
      kind: "npm-package" as const,
      name: `Module ${index}`,
      path: `modules/${index}`,
      solutionIds: ["solution:synthetic"],
      packageId: `synthetic-${index}`,
    })),
    semanticGroups: DEMO_MODEL.semanticGroups,
    identity: { title, version: "v1" },
    base: {
      id: "base:synthetic",
      semanticGroupId: "base",
      position: {
        x: baseWidth / 2 - 150,
        y: 0.5,
        z: baseDepth / 2 - 150,
      },
      size: { x: baseWidth, y: 1, z: baseDepth },
    },
    districts,
    buildings,
    dependencies,
    bounds: {
      x: baseWidth,
      y: Math.max(10, ...buildings.map(({ position, size }) => position.y + size.y / 2)),
      z: baseDepth,
    },
  });
}

function syntheticUnassignedCity(buildingCount = 315): CityModel {
  const source = syntheticCity(
    [{ width: 240, depth: 200 }],
    [],
    "Unassigned City",
  );
  const district = {
    ...source.districts[0]!,
    name: "Unassigned",
    path: "unassigned",
  };
  const template = source.buildings[0]!;
  const columns = 21;
  const rows = Math.ceil(buildingCount / columns);
  const buildings = Array.from({ length: buildingCount }, (_, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const height = 4 + (index % 5);
    const suffix = String(index).padStart(3, "0");
    return {
      ...template,
      id: `building:unassigned-${suffix}`,
      name: `unassigned-${suffix}.ts`,
      path: `unassigned/unassigned-${suffix}.ts`,
      position: {
        x: (column - (columns - 1) / 2) * 10,
        y:
          district.position.y + district.size.y / 2 + height / 2,
        z: (row - (rows - 1) / 2) * 10,
      },
      size: { x: 8, y: height, z: 8 },
    };
  });
  return validateCityModel({
    ...source,
    modules: source.modules.map((module) => ({
      ...module,
      kind: "unassigned" as const,
      name: "Unassigned",
    })),
    districts: [district],
    buildings,
  });
}

function dependencyFixture(
  id: string,
  sourceIndex: number,
  targetIndex: number,
): CityDependency {
  return {
    id,
    repositoryId: "repository:synthetic",
    sourceId: `building:${String(sourceIndex).padStart(3, "0")}`,
    targetId: `building:${String(targetIndex).padStart(3, "0")}`,
    resolution: "internal",
    kind: "typescript-import",
    weight: 3,
  };
}

function externalFixture(
  id: string,
  sourceIndex: number,
): CityDependency {
  return {
    id,
    repositoryId: "repository:synthetic",
    sourceId: `module:${String(sourceIndex).padStart(3, "0")}`,
    externalTarget: "shared-sdk",
    resolution: "external",
    kind: "package-reference",
    weight: 2,
  };
}

function reversedModel(model: CityModel): CityModel {
  return validateCityModel({
    ...model,
    solutions: model.solutions.map((solution) => ({
      ...solution,
      moduleIds: [...solution.moduleIds].reverse(),
    })),
    modules: [...model.modules].reverse(),
    districts: [...model.districts].reverse(),
    buildings: [...model.buildings].reverse(),
    dependencies: [...model.dependencies].reverse(),
    semanticGroups: [...model.semanticGroups].reverse(),
  });
}

function withinBuildVolume(
  result: {
    readonly preflight: {
      readonly plates: readonly {
        readonly dimensions: {
          readonly width: number;
          readonly depth: number;
          readonly height: number;
        };
      }[];
    };
  },
  profile: PrinterProfile,
): void {
  for (const { dimensions } of result.preflight.plates) {
    expect(dimensions.width).toBeLessThanOrEqual(
      profile.buildVolume.x + 1e-7,
    );
    expect(dimensions.depth).toBeLessThanOrEqual(
      profile.buildVolume.z + 1e-7,
    );
    expect(dimensions.height).toBeLessThanOrEqual(
      profile.buildVolume.y + 1e-7,
    );
  }
}

describe("physical print-plate orchestration", () => {
  it("reserves and documents an empty rear strip for the PrusaSlicer wipe tower", () => {
    const options = {
      scale: 1,
      fitPolicy: "error" as const,
      wipeTowerReserveDepth: 30,
      labelPolicy: "off" as const,
      routePolicy: "off" as const,
      includeLegend: false,
    };
    const prepared = preparePrintPlateBundle({
      format: "3mf",
      model: syntheticCity([{ width: 80, depth: 80 }]),
      profile: createPrusaXLProfile([1, 2]),
      options,
    });
    const warning =
      "Reserved an empty 30 mm rear strip on every plate for the wipe tower. " +
      "PrusaSlicer centers imported geometry, so first move the complete city flush to the front edge, do not run Arrange afterward, then place the wipe tower in the revealed rear strip and verify the sliced G-code preview before printing.";

    expect(prepared.layout.reservedRearDepth).toBe(30);
    expect(prepared.preflight.wipeTowerReserveDepth).toBe(30);
    expect(prepared.layout.plates).toHaveLength(1);
    expect(prepared.layout.plates[0]!.base.bounds.maximum.z).toBeLessThanOrEqual(
      330 + 1e-9,
    );
    expect(prepared.layout.warnings).toContain(warning);
    expect(prepared.preflight.warnings).toContain(warning);
    expect(prepared.preview.warnings).toContain(warning);
    expect(prepared.bundleRequest.warnings).toContain(warning);

    options.wipeTowerReserveDepth = 45;
    expect(prepared.options.wipeTowerReserveDepth).toBe(30);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid wipe-tower reserve depth %s before layout",
    (wipeTowerReserveDepth) => {
      expect(() =>
        preparePrintPlateBundle({
          format: "3mf",
          model: DEMO_MODEL,
          profile: createPrusaXLProfile([1, 2]),
          options: {
            scale: 1,
            fitPolicy: "error",
            wipeTowerReserveDepth,
            labelPolicy: "off",
            routePolicy: "off",
            includeLegend: false,
          },
        }),
      ).toThrow(/Wipe tower reserve depth must be a non-negative finite number/u);
    },
  );

  it("records one manifest-level warning for fixed-icon logo fallback", () => {
    const prepared = preparePrintPlateBundle({
      format: "3mf",
      model: {
        ...DEMO_MODEL,
        identity: {
          ...DEMO_MODEL.identity!,
          logo: {
            relativePath: "assets/logo.svg",
            format: "svg",
          },
        },
      },
      profile: createSingleChannelProfile(),
      options: {
        scale: 3,
        fitPolicy: "error",
        labelPolicy: "off",
        routePolicy: "off",
        includeLegend: false,
      },
    });

    expect(
      prepared.bundleRequest.warnings.filter(
        (warning) => warning === PRINT_LOGO_RELIEF_FALLBACK_WARNING,
      ),
    ).toEqual([PRINT_LOGO_RELIEF_FALLBACK_WARNING]);
    expect(
      prepared.preflight.warnings.filter(
        (warning) => warning === PRINT_LOGO_RELIEF_FALLBACK_WARNING,
      ),
    ).toEqual([PRINT_LOGO_RELIEF_FALLBACK_WARNING]);
    expect(
      prepared.bundleRequest.plates.flatMap(({ warnings }) => warnings),
    ).not.toContain(PRINT_LOGO_RELIEF_FALLBACK_WARNING);
  });

  it.each(["3mf", "stl"] as const)(
    "serializes the exact compact numbered error-policy plate directly as %s",
    (format) => {
      const prepared = preparePrintPlateBundle({
        format,
        model: DEMO_MODEL,
        profile: createSingleChannelProfile(),
        options: {
          scale: 3,
          fitPolicy: "error",
          labelPolicy: "off",
          routePolicy: "off",
          includeLegend: true,
        },
      });
      const result = serializePreparedSinglePrintPlateExport(prepared);

      expect(result.layout).toBe(prepared.layout);
      expect(result.preflight).toBe(prepared.preflight);
      expect(result.preview).toBe(prepared.preview);
      expect(result.artifact.format).toBe(format);
      expect(result.artifact.fileExtension).toBe(`.${format}`);
      expect(result.artifact.bytes.byteLength).toBeGreaterThan(100);
      expect(result.manifest).toMatchObject({
        format,
        fit: {
          policy: "error",
          requestedScale: 3,
          appliedScale: 3,
          minimumSafeScale: 0.4,
          belowProfileScaleAcknowledged: false,
          featureViolations: [],
        },
      });
      expect(
        JSON.parse(new TextDecoder().decode(result.manifestBytes)),
      ).toEqual(result.manifest);
      expect(result.legendBytes).toEqual(
        prepared.bundleRequest.legendBytes,
      );
      expect(
        prepared.plates[0]!.artifacts.city.parts
          .flatMap(({ primitives }) => primitives)
          .some(({ kind }) => kind === "plate-number"),
      ).toBe(true);
    },
  );

  it("serializes a complete one-plate non-error fit policy directly", () => {
    const prepared = preparePrintPlateBundle({
      format: "3mf",
      model: DEMO_MODEL,
      profile: createSingleChannelProfile(),
      options: {
        scale: 3,
        fitPolicy: "scale",
        labelPolicy: "off",
        routePolicy: "off",
        includeLegend: false,
      },
    });

    const result = serializePreparedSinglePrintPlateExport(prepared);

    expect(result.layout.plates).toHaveLength(1);
    expect(result.manifest.fit.policy).toBe("scale");
    expect(result.artifact.format).toBe("3mf");
  });

  it.each(["3mf", "stl"] as const)(
    "auto-fits one oversized 315-building Unassigned district into a complete direct %s artifact",
    (format) => {
      const prepared = preparePrintPlateBundle({
        format,
        model: syntheticUnassignedCity(),
        profile: createSingleChannelProfile(),
        options: {
          scale: 3,
          fitPolicy: "scale",
          labelPolicy: "off",
          routePolicy: "off",
          includeLegend: false,
        },
      });

      expect(prepared.layout.plates).toHaveLength(1);
      expect(prepared.layout.unplaced).toEqual([]);
      expect(prepared.layout.appliedScale).toBeLessThan(3);
      expect(prepared.layout.plates[0]!.districts).toHaveLength(1);
      expect(prepared.model.buildings).toHaveLength(315);
      const city = prepared.plates[0]!.artifacts.city;
      expect(
        city.parts
          .flatMap(({ primitives }) => primitives)
          .filter(({ kind }) => kind === "building"),
      ).toHaveLength(315);
      expect(validatePrintableCity(city, prepared.profile)).toEqual([]);
      const result = serializePreparedSinglePrintPlateExport(prepared);
      expect(result.manifest.fit.policy).toBe("scale");
      expect(result.artifact.format).toBe(format);
      expect(result.artifact.bytes.byteLength).toBeGreaterThan(100);
    },
  );

  it("rejects incomplete capped tiling before geometry and serialization", () => {
    const phases: string[] = [];
    let error: unknown;
    try {
      preparePrintPlateBundle(
        {
          format: "3mf",
          model: syntheticCity([
            { width: 140, depth: 140 },
            { width: 140, depth: 140 },
          ]),
          profile: createPrusaXLProfile([1, 2, 3, 4, 5]),
          options: {
            scale: 2,
            fitPolicy: "tile",
            labelPolicy: "off",
            routePolicy: "off",
            includeLegend: false,
            maximumPlateCount: 1,
          },
        },
        ({ phase }) => phases.push(phase),
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(PrintLayoutError);
    expect((error as PrintLayoutError).issues).toEqual([
      expect.objectContaining({
        code: "resource-limit",
        objectId: "district:001",
      }),
    ]);
    expect(phases).not.toContain("geometry");

    const complete = preparePrintPlateBundle({
      format: "3mf",
      model: syntheticCity([{ width: 80, depth: 80 }]),
      profile: createSingleChannelProfile(),
      options: {
        scale: 1,
        fitPolicy: "error",
        labelPolicy: "off",
        routePolicy: "off",
        includeLegend: false,
      },
    });
    const incomplete = {
      ...complete,
      layout: {
        ...complete.layout,
        unplaced: [
          {
            kind: "district" as const,
            id: "district:missing",
            name: "Missing district",
            reason: "plate-limit" as const,
            required: { x: 10, y: 10, z: 10 },
          },
        ],
      },
    };
    expect(() => serializePreparedPrintPlateBundle(incomplete)).toThrow(
      PrintLayoutError,
    );
    expect(() =>
      serializePreparedSinglePrintPlateExport(incomplete),
    ).toThrow(PrintLayoutError);
  });

  it("clamps plate foundations while keeping buildings on their exposed tops", () => {
    const profile = createPrusaXLProfile([1, 2, 3, 4, 5]);
    const limits = resolvePrinterGeometryLimits(profile);
    const prepared = preparePrintPlateBundle({
      format: "3mf",
      model: syntheticCity([{ width: 80, depth: 80 }]),
      profile,
      options: {
        scale: 0.5,
        fitPolicy: "error",
        labelPolicy: "off",
        routePolicy: "off",
        includeLegend: false,
      },
    });
    const placement = prepared.layout.plates[0]!.districts[0]!;
    const primitives = prepared.plates[0]!.artifacts.city.parts.flatMap(
      ({ primitives }) => primitives,
    );
    const base = primitives.find(({ kind }) => kind === "base")!;
    const district = primitives.find(({ kind }) => kind === "district")!;
    const building = primitives.find(({ kind }) => kind === "building")!;
    const foundationFloor = Math.max(
      limits.minimumBaseThickness,
      limits.minimumRaisedFeatureHeight,
    );

    expect(prepared.layout.minimumSafeScale).toBeCloseTo(0.1, 12);
    expect(prepared.layout.featureViolations).toEqual([]);
    expect(placement.foundationThickness).toBe(foundationFloor);
    expect(placement.foundationLift).toBeCloseTo(
      foundationFloor - 0.25,
      12,
    );
    expect(base.bounds.size.z).toBe(limits.minimumBaseThickness);
    expect(district.bounds.size.z).toBe(foundationFloor);
    expect(district.bounds.minimum.z).toBe(base.bounds.maximum.z);
    expect(building.bounds.minimum.z).toBe(district.bounds.maximum.z);
    expect(
      prepared.plates[0]!.artifacts.city.measurements.wallThickness,
    ).toBeCloseTo(4, 12);
    expect(
      prepared.plates[0]!.artifacts.city.measurements.minimumGap,
    ).toBeNull();
  });

  it("keeps zero-building detail metrics finite and constraint-neutral", () => {
    const source = syntheticCity(
      [{ width: 240, depth: 80 }],
      [],
      "A",
    );
    const model = validateCityModel({ ...source, buildings: [] });
    const profile = createSingleChannelProfile({
      buildVolume: { x: 120, y: 120, z: 120 },
    });
    const prepared = preparePrintPlateBundle({
      format: "3mf",
      model,
      profile,
      options: {
        scale: 1,
        fitPolicy: "scale",
        labelPolicy: "off",
        routePolicy: "off",
        includeLegend: false,
      },
    });
    const measurements = prepared.plates[0]!.artifacts.city.measurements;

    expect(prepared.layout.appliedScale).toBeLessThan(1);
    expect(prepared.layout.minimumSafeScale).toBeGreaterThan(0);
    expect(prepared.layout.minimumSafeScale).toBeLessThan(1e-100);
    expect(prepared.layout.featureViolations).toEqual([]);
    expect(Number.isFinite(measurements.wallThickness)).toBe(true);
    expect(Number.isFinite(measurements.minimumFeatureSize)).toBe(true);
    expect(measurements.minimumGap).toBeNull();
    expect(
      validatePrintableCity(
        prepared.plates[0]!.artifacts.city,
        profile,
      ),
    ).toEqual([]);
  });

  it("retains sub-epsilon building detail in structured safe-scale checks", () => {
    const source = syntheticCity([{ width: 80, depth: 80 }]);
    const model = validateCityModel({
      ...source,
      buildings: source.buildings.map((building) => ({
        ...building,
        size: { ...building.size, x: 1e-10 },
      })),
    });
    const phases: string[] = [];
    let error: unknown;
    try {
      preparePrintPlateBundle(
        {
          format: "3mf",
          model,
          profile: createSingleChannelProfile(),
          options: {
            scale: 1,
            fitPolicy: "scale",
            labelPolicy: "off",
            routePolicy: "off",
            includeLegend: false,
          },
        },
        ({ phase }) => phases.push(phase),
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(PrintLayoutError);
    expect((error as PrintLayoutError).issues).toEqual([
      expect.objectContaining({ code: "unsafe-scale" }),
    ]);
    expect((error as Error).message).toContain(
      "minimum profile-safe scale 8000000000",
    );
    expect(phases).toEqual(["validating"]);
  });

  it.each([
    [
      "generic STL",
      "stl" as const,
      createSingleChannelProfile(),
    ],
    [
      "Prusa XL 5-tool 3MF",
      "3mf" as const,
      createPrusaXLProfile([1, 2, 3, 4, 5]),
    ],
    [
      "checked-in generic multi-channel 3MF",
      "3mf" as const,
      parsePrinterProfileJson(
        readFileSync("profiles/generic-multi-channel.json", "utf8"),
      ),
    ],
  ])(
    "generates deterministic %s bundles through the same printer-neutral API",
    (_name, format, profile) => {
      const request = {
        format,
        model: DEMO_MODEL,
        profile,
        options: {
          scale: 3,
          fitPolicy: "tile" as const,
          labelPolicy: "off" as const,
          routePolicy: "auto" as const,
          includeLegend: true,
        },
      };
      const first = generatePrintPlateBundle(request);
      const second = generatePrintPlateBundle(request);

      expect(second.bytes).toEqual(first.bytes);
      expect(second.manifest).toEqual(first.manifest);
      expect(first.artifacts).toHaveLength(first.layout.plates.length);
      expect(first.manifest.plates.map(({ file }) => file)).toEqual(
        first.manifest.plates.map(
          ({ number }) =>
            `plate-${String(number).padStart(2, "0")}.${format}`,
        ),
      );
      expect(first.preflight.profileId).toBe(profile.id);
      expect(first.preflight.legendIncluded).toBe(true);
      withinBuildVolume(first, profile);
    },
    25_000,
  );

  it("is independent of input order and preserves stable ties and required rotation", () => {
    const profile = createSingleChannelProfile({
      buildVolume: { x: 130, y: 110, z: 220 },
      geometryLimits: {
        minimumWallThickness: 0.45,
        minimumGap: 0.4,
        minimumFeatureSize: 0.8,
        minimumBaseThickness: 0.8,
      },
    });
    const model = syntheticCity([
      { width: 80, depth: 40 },
      { width: 20, depth: 20 },
      { width: 20, depth: 20 },
    ]);
    const request = {
      format: "stl" as const,
      profile,
      options: {
        scale: 2,
        fitPolicy: "tile" as const,
        labelPolicy: "off" as const,
        routePolicy: "off" as const,
        includeLegend: false,
      },
    };
    const first = preparePrintPlateBundle({ ...request, model });
    const reordered = preparePrintPlateBundle({
      ...request,
      model: reversedModel(model),
    });

    expect(reordered.layout).toEqual(first.layout);
    expect(reordered.bundleRequest).toEqual(first.bundleRequest);
    expect(
      first.layout.plates
        .flatMap(({ districts }) => districts)
        .find(({ districtId }) => districtId === "district:000")
        ?.transform.rotation,
    ).toBe(90);
  });

  it("rejects unsafe scale, scales one plate conservatively, and tiles without oversized artifacts", () => {
    const profile = createPrusaXLProfile([1, 2, 3, 4, 5]);
    const model = syntheticCity([
      { width: 80, depth: 80, height: 0.5 },
      { width: 80, depth: 80, height: 0.5 },
    ]);
    const common = {
      format: "3mf" as const,
      model,
      profile,
      options: {
        labelPolicy: "off" as const,
        routePolicy: "off" as const,
        includeLegend: false,
      },
    };

    expect(() =>
      preparePrintPlateBundle({
        ...common,
        options: {
          ...common.options,
          scale: 0.5,
          fitPolicy: "scale",
        },
      }),
    ).toThrow(/minimum profile-safe scale/u);

    const acknowledged = preparePrintPlateBundle({
      ...common,
      options: {
        ...common.options,
        scale: 0.5,
        fitPolicy: "error",
        acknowledgeBelowProfileScale: true,
      },
    });
    expect(acknowledged.preflight).toMatchObject({
      requestedScale: 0.5,
      appliedScale: 0.5,
      minimumSafeScale: 1.6,
      belowProfileScaleAcknowledged: true,
    });
    expect(acknowledged.preflight.featureViolations.length).toBeGreaterThan(0);
    expect(acknowledged.preview.featureViolations).toEqual(
      acknowledged.preflight.featureViolations,
    );
    const direct = serializePreparedSinglePrintPlateExport(acknowledged);
    expect(direct.manifest.fit).toEqual({
      policy: "error",
      requestedScale: 0.5,
      appliedScale: 0.5,
      minimumSafeScale: 1.6,
      belowProfileScaleAcknowledged: true,
      featureViolations: acknowledged.layout.featureViolations,
    });
    expect(JSON.parse(new TextDecoder().decode(direct.manifestBytes))).toEqual(
      direct.manifest,
    );
    const acknowledgedCity = acknowledged.plates[0]!.artifacts.city;
    expect(validatePrintableCity(acknowledgedCity, profile)).toEqual([]);
    expect(
      validatePrintableCity(
        {
          ...acknowledgedCity,
          scaleFidelity: {
            ...acknowledgedCity.scaleFidelity!,
            belowProfileScaleAcknowledged: false,
          },
        },
        profile,
      ).join(" "),
    ).toContain("requires explicit acknowledgement");
    expect(
      validatePrintableCity(
        acknowledgedCity,
        profile,
        {
          ...acknowledgedCity.scaleFidelity!,
          minimumSafeScale:
            acknowledgedCity.scaleFidelity!.minimumSafeScale + 0.1,
        },
      ).join(" "),
    ).toContain("does not match the printable city's embedded metadata");
    const firstViolation = acknowledgedCity.scaleFidelity!
      .featureViolations[0]!;
    expect(
      validatePrintableCity({
        ...acknowledgedCity,
        scaleFidelity: {
          ...acknowledgedCity.scaleFidelity!,
          featureViolations: [
            {
              ...firstViolation,
              resultingValue:
                firstViolation.minimum - PRINT_FIDELITY_EPSILON / 2,
            },
            ...acknowledgedCity.scaleFidelity!.featureViolations.slice(1),
          ],
        },
      }, profile).join(" "),
    ).toContain("Print fidelity violations are invalid");
    const nullViolationCity = {
      ...acknowledgedCity,
      scaleFidelity: {
        ...acknowledgedCity.scaleFidelity!,
        featureViolations: [null, firstViolation],
      },
    } as unknown as typeof acknowledgedCity;
    expect(() =>
      validatePrintableCity(nullViolationCity, profile)
    ).not.toThrow();
    expect(
      validatePrintableCity(nullViolationCity, profile).join(" "),
    ).toContain("Print fidelity violations are invalid");
    expect(
      validatePrintableCity(acknowledgedCity, {
        ...profile,
        buildVolume: { x: 10, y: 10, z: 10 },
      }).join(" "),
    ).toMatch(/exceeds (?:the usable )?build/u);
    const firstPart = acknowledgedCity.parts[0]!;
    const firstPrimitive = firstPart.primitives[0]!;
    const structurallyBroken = {
      ...acknowledgedCity,
      parts: [
        {
          ...firstPart,
          primitives: [
            {
              ...firstPrimitive,
              mesh: {
                ...firstPrimitive.mesh,
                triangles: firstPrimitive.mesh.triangles.slice(0, -1),
              },
            },
            ...firstPart.primitives.slice(1),
          ],
        },
        ...acknowledgedCity.parts.slice(1),
      ],
    };
    expect(
      validatePrintableCity(structurallyBroken, profile).join(" "),
    ).toMatch(/watertight|exactly twice|triangle count/u);

    const scaled = preparePrintPlateBundle({
      ...common,
      options: {
        ...common.options,
        scale: 3,
        fitPolicy: "scale",
      },
    });
    expect(scaled.layout.plates).toHaveLength(1);
    expect(scaled.layout.appliedScale).toBeGreaterThanOrEqual(
      scaled.layout.minimumSafeScale,
    );
    expect(scaled.layout.appliedScale).toBeLessThan(3);
    withinBuildVolume(scaled, profile);

    const tiled = preparePrintPlateBundle({
      ...common,
      options: {
        ...common.options,
        scale: 3,
        fitPolicy: "tile",
      },
    });
    expect(tiled.layout.plates.length).toBeGreaterThan(1);
    expect(tiled.layout.appliedScale).toBe(3);
    withinBuildVolume(tiled, profile);
  });

  it("auto-scales below the safe floor only with acknowledgement and serializes exact fidelity", () => {
    const profile = createPrusaXLProfile([1, 2, 3, 4, 5]);
    const model = syntheticCity([
      { width: 140, depth: 140, height: 0.5 },
      { width: 140, depth: 140, height: 0.5 },
    ]);
    const prepared = preparePrintPlateBundle({
      format: "3mf",
      model,
      profile,
      options: {
        scale: 3,
        fitPolicy: "scale",
        acknowledgeBelowProfileScale: true,
        labelPolicy: "off",
        routePolicy: "off",
        includeLegend: false,
      },
    });

    expect(prepared.layout.plates).toHaveLength(1);
    expect(prepared.layout.appliedScale).toBeLessThan(
      prepared.layout.minimumSafeScale,
    );
    expect(prepared.layout.appliedScale).toBeGreaterThan(0);
    expect(prepared.layout.belowProfileScaleAcknowledged).toBe(true);
    expect(prepared.layout.featureViolations.length).toBeGreaterThan(0);
    expect(prepared.layout.warnings.join(" ")).toContain(
      "print fidelity",
    );
    expect(prepared.layout.warnings.join(" ")).not.toContain(
      "to fit one plate safely",
    );
    withinBuildVolume(prepared, profile);

    const exported = serializePreparedPrintPlateBundle(prepared);
    expect(exported.manifest.fit).toEqual({
      policy: "scale",
      requestedScale: prepared.layout.requestedScale,
      appliedScale: prepared.layout.appliedScale,
      minimumSafeScale: prepared.layout.minimumSafeScale,
      belowProfileScaleAcknowledged: true,
      featureViolations: prepared.layout.featureViolations,
    });
    const archive = unzipSync(exported.bytes);
    const plateBytes = archive["plate-01.3mf"]!;
    const plateArchive = unzipSync(plateBytes);
    const xml = new TextDecoder().decode(
      plateArchive["3D/3dmodel.model"],
    );
    expect(xml).toContain(
      `<metadata name="codecity:AppliedScale" preserve="1">${prepared.layout.appliedScale}</metadata>`,
    );
    expect(xml).toContain(
      '<metadata name="codecity:BelowProfileScaleAcknowledged" preserve="1">true</metadata>',
    );
  });

  it("records cross-plate endpoint identities and relevant external replicas on compact continuous bases", () => {
    const model = syntheticCity(
      [
        { width: 140, depth: 140 },
        { width: 140, depth: 140 },
      ],
      [
        dependencyFixture("dependency:cross", 0, 1),
        externalFixture("dependency:external-a", 0),
        externalFixture("dependency:external-b", 1),
      ],
    );
    const prepared = preparePrintPlateBundle({
      format: "3mf",
      model,
      profile: createPrusaXLProfile([1, 2, 3, 4, 5]),
      options: {
        scale: 2,
        fitPolicy: "tile",
        labelPolicy: "off",
        routePolicy: "auto",
        includeLegend: true,
      },
    });

    expect(prepared.layout.plates).toHaveLength(2);
    expect(prepared.bundleRequest.routeOmissions).toContainEqual(
      expect.objectContaining({
        routeId: "dependency:cross",
        reason: "cross-plate",
        consumer: expect.objectContaining({
          kind: "building",
          id: "building:000",
          plateNumber: expect.any(Number),
        }),
        provider: expect.objectContaining({
          kind: "building",
          id: "building:001",
          plateNumber: expect.any(Number),
        }),
      }),
    );
    const external = prepared.bundleRequest.plates.map(
      ({ externalDependencies }) => externalDependencies,
    );
    expect(external.every((items) => items.length === 1)).toBe(true);
    expect(external.flat().map(({ target }) => target)).toEqual([
      "shared-sdk",
      "shared-sdk",
    ]);
    expect(external.flat().map(({ role }) => role).sort()).toEqual([
      "original",
      "replica",
    ]);

    prepared.plates.forEach(({ layout, artifacts }, index) => {
      const primitives = artifacts.city.parts.flatMap(
        ({ primitives }) => primitives,
      );
      const bases = primitives.filter(({ kind }) => kind === "base");
      expect(bases).toHaveLength(1);
      expect(primitives.some(({ kind }) => kind === "plate-number")).toBe(
        true,
      );
      expect(
        primitives.some(({ kind }) => kind === "dependency-endpoint"),
      ).toBe(true);
      expect(
        primitives.some(({ kind }) => kind === "identity-panel"),
      ).toBe(index === 0);
      expect(bases[0]!.bounds.minimum.x).toBe(
        artifacts.city.bounds.minimum.x,
      );
      expect(bases[0]!.bounds.maximum.x).toBe(
        artifacts.city.bounds.maximum.x,
      );
      expect(bases[0]!.bounds.minimum.y).toBe(
        artifacts.city.bounds.minimum.y,
      );
      expect(bases[0]!.bounds.maximum.y).toBe(
        artifacts.city.bounds.maximum.y,
      );
      expect(layout.base.size.x).toBeLessThan(
        prepared.layout.usableBuildSpan.x,
      );
      expect(layout.base.size.z).toBeLessThan(
        prepared.layout.usableBuildSpan.z,
      );
    });
  });

  it("assigns one original plate per normalized or overflow physical external box", () => {
    const overflowTargets = Array.from(
      { length: 13 },
      (_, index) => `target-${String(index).padStart(2, "0")}`,
    );
    const dependencies: CityDependency[] = [
      {
        ...externalFixture("dependency:alias-a", 0),
        externalTarget: "Cafe\u0301",
      },
      {
        ...externalFixture("dependency:alias-b", 1),
        externalTarget: "Caf\u00e9",
      },
      ...overflowTargets.map((externalTarget, index) => ({
        ...externalFixture(`dependency:overflow-${index}`, index === 12 ? 1 : 0),
        externalTarget,
      })),
    ];
    const prepared = preparePrintPlateBundle({
      format: "3mf",
      model: syntheticCity(
        [
          { width: 140, depth: 140 },
          { width: 140, depth: 140 },
        ],
        dependencies,
      ),
      profile: createPrusaXLProfile([1, 2, 3, 4, 5]),
      options: {
        scale: 2,
        fitPolicy: "tile",
        labelPolicy: "off",
        routePolicy: "off",
        includeLegend: false,
      },
    });

    expect(prepared.layout.plates).toHaveLength(2);
    const metadata = prepared.bundleRequest.plates.flatMap(
      ({ number, externalDependencies }) =>
        externalDependencies.map((dependency) => ({
          plate: number,
          ...dependency,
        })),
    );
    const aliases = metadata.filter(({ target }) =>
      target.normalize("NFC") === "Caf\u00e9",
    );
    expect(aliases.map(({ plate, role }) => ({ plate, role }))).toEqual([
      { plate: 1, role: "original" },
      { plate: 2, role: "replica" },
    ]);
    const overflow = metadata.filter(({ target }) =>
      target === "target-11" || target === "target-12",
    );
    expect(overflow.map(({ plate, role, target }) => ({
      plate,
      role,
      target,
    }))).toEqual([
      { plate: 1, role: "original", target: "target-11" },
      { plate: 2, role: "replica", target: "target-12" },
    ]);
  });

  it("collapses canonical aliases from one consumer before manifest normalization", () => {
    const model = syntheticCity(
      [{ width: 80, depth: 80 }],
      [
        {
          ...externalFixture("dependency:alias-a", 0),
          externalTarget: "Cafe\u0301",
          weight: Number.MAX_VALUE,
        },
        {
          ...externalFixture("dependency:alias-b", 0),
          externalTarget: "Caf\u00e9",
          weight: 0.5,
        },
      ],
    );
    const result = generatePrintPlateBundle({
      format: "3mf",
      model,
      profile: createPrusaXLProfile([1, 2, 3, 4, 5]),
      options: {
        scale: 2,
        fitPolicy: "tile",
        labelPolicy: "off",
        routePolicy: "auto",
        includeLegend: false,
      },
    });

    expect(result.manifest.plates).toHaveLength(1);
    expect(result.manifest.plates[0]!.externalDependencies).toEqual([
      expect.objectContaining({
        target: "Caf\u00e9",
        weight: Number.MAX_VALUE,
        role: "original",
      }),
    ]);
    expect(result.preflight.routes.totalWeight).toBe(Number.MAX_VALUE);
  });

  it("excludes intra-district self edges from route outcomes and omissions", () => {
    const model = syntheticCity(
      [{ width: 80, depth: 80 }],
      [dependencyFixture("dependency:self", 0, 0)],
    );
    const prepared = preparePrintPlateBundle({
      format: "3mf",
      model,
      profile: createSingleChannelProfile(),
      options: {
        scale: 2,
        fitPolicy: "tile",
        labelPolicy: "off",
        routePolicy: "auto",
        includeLegend: false,
      },
    });

    expect(prepared.preflight.routes).toMatchObject({
      totalCount: 0,
      printedCount: 0,
      omittedCount: 0,
      totalWeight: 0,
      printedWeight: 0,
      omittedWeight: 0,
    });
    expect(prepared.bundleRequest.routeOmissions).toEqual([]);
    expect(prepared.plates[0]!.artifacts.routeOutcomes).toEqual([]);
  });

  it("saturates route totals across physical plates", () => {
    const dependencies = [
      {
        ...externalFixture("dependency:max-a", 0),
        weight: Number.MAX_VALUE,
      },
      {
        ...externalFixture("dependency:max-b", 1),
        weight: Number.MAX_VALUE,
      },
    ];
    const prepared = preparePrintPlateBundle({
      format: "3mf",
      model: syntheticCity(
        [
          { width: 140, depth: 140 },
          { width: 140, depth: 140 },
        ],
        dependencies,
      ),
      profile: createPrusaXLProfile([1, 2, 3, 4, 5]),
      options: {
        scale: 2,
        fitPolicy: "tile",
        labelPolicy: "off",
        routePolicy: "auto",
        includeLegend: false,
      },
    });

    expect(prepared.layout.plates).toHaveLength(2);
    expect(prepared.preflight.routes.totalWeight).toBe(Number.MAX_VALUE);
    expect(prepared.preflight.routes.printedWeight).toBe(Number.MAX_VALUE);
    expect(Number.isFinite(prepared.preflight.routes.totalWeight)).toBe(true);
  });

  it(
    "keeps a FLOW-sized synthetic city inside every Prusa XL artifact",
    { timeout: 25_000 },
    () => {
      const profile = createPrusaXLProfile([1, 2, 3, 4, 5]);
      const model = syntheticCity(
        Array.from({ length: 48 }, (_, index) => ({
          width: 42 + (index % 4) * 4,
          depth: 32 + (index % 3) * 5,
          height: 8 + (index % 5) * 2,
        })),
        [],
        "FLOW Synthetic",
      );
      const prepared = preparePrintPlateBundle({
        format: "3mf",
        model,
        profile,
        options: {
          scale: 2,
          fitPolicy: "tile",
          labelPolicy: "off",
          routePolicy: "off",
          includeLegend: false,
        },
      });

      expect(prepared.layout.unplaced).toEqual([]);
      expect(
        prepared.layout.plates.flatMap(({ districts }) => districts),
      ).toHaveLength(48);
      withinBuildVolume(prepared, profile);
      for (const { artifacts } of prepared.plates) {
        expect(artifacts.city.bounds.minimum).toEqual({
          x: 0,
          y: 0,
          z: 0,
        });
      }
    },
  );
});
