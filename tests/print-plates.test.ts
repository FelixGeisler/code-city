import { readFileSync } from "node:fs";

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
  validateCityModel,
  type CityDependency,
  type CityModel,
  type PrinterProfile,
} from "../packages/core/src/index.js";
import {
  generatePrintPlateBundle,
  preparePrintPlateBundle,
  serializePreparedSinglePrintPlateExport,
} from "../packages/exporter/src/print-plates.js";
import {
  PRINT_LOGO_RELIEF_FALLBACK_WARNING,
} from "../packages/exporter/src/geometry.js";

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

  it("rejects direct serialization of a non-error fit policy", () => {
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

    expect(() =>
      serializePreparedSinglePrintPlateExport(prepared),
    ).toThrow(/requires fit policy 'error'/u);
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
      { width: 80, depth: 80 },
      { width: 80, depth: 80 },
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
