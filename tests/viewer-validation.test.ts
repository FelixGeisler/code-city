import { describe, expect, it } from "vitest";

import { DEMO_MODEL } from "../apps/viewer/src/demo-model.js";
import {
  calculateBuildingGeometry,
  DEFAULT_METRIC_MAPPING,
  metricNormalizationForGeometry,
} from "../packages/core/src/index.js";
import {
  CITY_MODEL_LIMITS,
  validateCityModel,
} from "../apps/viewer/src/model-validation.js";

describe("viewer model validation", () => {
  it("accepts legacy module-level project and package dependencies", () => {
    const [source, target] = DEMO_MODEL.modules;
    expect(source).toBeDefined();
    expect(target).toBeDefined();

    const model = {
      ...DEMO_MODEL,
      dependencies: [
        {
          id: "dependency:project",
          repositoryId: source!.repositoryId,
          sourceId: source!.id,
          targetId: target!.id,
          kind: "project-reference" as const,
          weight: 1,
        },
        {
          id: "dependency:package",
          repositoryId: source!.repositoryId,
          sourceId: source!.id,
          externalTarget: "example.package",
          kind: "package-reference" as const,
          version: "1.0.0",
          weight: 1,
        },
      ],
    };

    expect(validateCityModel(model)).toBe(model);
  });

  it("accepts additive metric provenance and the reserved Roslyn method", () => {
    const template = DEMO_MODEL.buildings[0]!;
    const geometry = calculateBuildingGeometry(template.metrics);
    const extendedBuilding = {
      ...template,
      metrics: {
        ...template.metrics,
        maximumComplexity: 1,
        executableUnitCount: 1,
      },
      metricMethod: "csharp-roslyn-v1",
      metricNormalization: metricNormalizationForGeometry(geometry),
      units: [{ name: "Reserved", line: 1, complexity: 1 }],
      risk: "low",
    };
    const model = {
      ...DEMO_MODEL,
      metricMapping: DEFAULT_METRIC_MAPPING,
      buildings: [extendedBuilding, ...DEMO_MODEL.buildings.slice(1)],
    };

    expect(validateCityModel(model)).toBe(model);

    const unavailableModel = {
      ...model,
      buildings: [
        {
          ...extendedBuilding,
          metricNormalization: {
            ...extendedBuilding.metricNormalization,
            decisionLoad: { state: "unavailable" },
          },
        },
        ...DEMO_MODEL.buildings.slice(1),
      ],
    };
    expect(validateCityModel(unavailableModel)).toBe(unavailableModel);
  });

  it("rejects unsupported metric mapping and misleading normalized values", () => {
    expect(() =>
      validateCityModel({
        ...DEMO_MODEL,
        metricMapping: {
          ...DEFAULT_METRIC_MAPPING,
          formulas: {
            ...DEFAULT_METRIC_MAPPING.formulas,
            normalization: "linear-v1",
          },
        },
      }),
    ).toThrow(/metricMapping\.formulas\.normalization/u);
    expect(() =>
      validateCityModel({
        ...DEMO_MODEL,
        metricMapping: {
          ...DEFAULT_METRIC_MAPPING,
          normalizationCaps: {
            ...DEFAULT_METRIC_MAPPING.normalizationCaps,
            sloc: 999,
          },
        },
      }),
    ).toThrow(/metricMapping\.normalizationCaps\.sloc/u);

    const template = DEMO_MODEL.buildings[0]!;
    const normalization = metricNormalizationForGeometry(
      calculateBuildingGeometry(template.metrics),
    );
    expect(() =>
      validateCityModel({
        ...DEMO_MODEL,
        buildings: [
          {
            ...template,
            metricNormalization: {
              ...normalization,
              sloc: {
                state: "available",
                normalizedValue: 0,
              },
            },
          },
          ...DEMO_MODEL.buildings.slice(1),
        ],
      }),
    ).toThrow(/normalizedValue must match log1p-cap-v1/u);
  });

  it("accepts explicit dependency resolutions and enforces their endpoints", () => {
    const [source, target] = DEMO_MODEL.modules;
    expect(source).toBeDefined();
    expect(target).toBeDefined();
    const model = {
      ...DEMO_MODEL,
      dependencies: [
        {
          id: "dependency:explicit-internal",
          repositoryId: source!.repositoryId,
          sourceId: source!.id,
          targetId: target!.id,
          resolution: "internal",
          kind: "project-reference",
          weight: 1,
        },
        {
          id: "dependency:explicit-external",
          repositoryId: source!.repositoryId,
          sourceId: source!.id,
          externalTarget: "example.package",
          resolution: "external",
          kind: "package-reference",
          weight: 1,
        },
        {
          id: "dependency:explicit-unresolved",
          repositoryId: source!.repositoryId,
          sourceId: source!.id,
          externalTarget: "../missing/missing.csproj",
          resolution: "unresolved",
          kind: "project-reference",
          weight: 1,
        },
      ],
    };

    expect(validateCityModel(model)).toBe(model);

    for (const dependency of [
      {
        ...model.dependencies[0],
        targetId: undefined,
        externalTarget: "wrong",
      },
      {
        ...model.dependencies[1],
        targetId: target!.id,
        externalTarget: undefined,
      },
      {
        ...model.dependencies[2],
        targetId: target!.id,
        externalTarget: undefined,
      },
    ]) {
      expect(() =>
        validateCityModel({
          ...DEMO_MODEL,
          dependencies: [dependency],
        }),
      ).toThrow(/resolution.*requires/u);
    }
  });

  it("rejects unknown schema versions without rewriting the model", () => {
    expect(() =>
      validateCityModel({
        ...DEMO_MODEL,
        schemaVersion: "2.0",
      }),
    ).toThrow(/schemaVersion must be "1\.0"/u);
  });

  it.each(["", " \t "])(
    "rejects an empty external dependency target",
    (externalTarget) => {
      const source = DEMO_MODEL.modules[0]!;
      expect(() =>
        validateCityModel({
          ...DEMO_MODEL,
          dependencies: [
            {
              id: "dependency:empty-external",
              repositoryId: source.repositoryId,
              sourceId: source.id,
              externalTarget,
              kind: "package-reference",
              weight: 1,
            },
          ],
        }),
      ).toThrow(/dependencies\[0\]\.externalTarget must not be empty/u);
    },
  );

  it("accepts a deterministic empty-city result", () => {
    const {
      base: _base,
      ...demoWithoutBase
    } = DEMO_MODEL;
    const model = {
      ...demoWithoutBase,
      districts: [],
      buildings: [],
      dependencies: [],
      bounds: { x: 0, y: 0, z: 0 },
    };

    expect(validateCityModel(model)).toBe(model);
  });

  it("accepts legacy schema-1.0 models without explicit base geometry", () => {
    const {
      base: _base,
      ...legacyModel
    } = DEMO_MODEL;

    expect(validateCityModel(legacyModel)).toBe(legacyModel);
  });

  it("validates shared-base semantics and geometry", () => {
    expect(validateCityModel(DEMO_MODEL)).toBe(DEMO_MODEL);
    const base = DEMO_MODEL.base!;
    const panel = DEMO_MODEL.identityPanel!;
    expect(panel.size.x).toBeLessThan(base.size.x);
    expect(panel.position.x).toBe(base.position.x);
    expect(
      Math.min(
        base.position.y + base.size.y / 2,
        panel.position.y + panel.size.y / 2,
      ) -
        Math.max(
          base.position.y - base.size.y / 2,
          panel.position.y - panel.size.y / 2,
        ),
    ).toBeGreaterThan(0);
    expect(
      panel.position.z - panel.size.z / 2 - panel.reliefDepth,
    ).toBeGreaterThanOrEqual(base.position.z - base.size.z / 2);

    expect(() =>
      validateCityModel({
        ...DEMO_MODEL,
        base: {
          ...DEMO_MODEL.base!,
          semanticGroupId: "identity",
        },
      }),
    ).toThrow(/base\.semanticGroupId must be "base"/u);
    expect(() =>
      validateCityModel({
        ...DEMO_MODEL,
        semanticGroups: DEMO_MODEL.semanticGroups
          .filter(({ id }) => id !== "base")
          .map((group) =>
            group.mergeInto === "base"
              ? {
                  id: group.id,
                  label: group.label,
                  color: group.color,
                  priority: group.priority,
                }
              : group,
          ),
      }),
    ).toThrow(/base\.semanticGroupId references unknown id "base"/u);
    expect(() =>
      validateCityModel({
        ...DEMO_MODEL,
        base: {
          ...DEMO_MODEL.base!,
          size: { ...DEMO_MODEL.base!.size, y: 0 },
        },
      }),
    ).toThrow(/base\.size components must be greater than zero/u);
    expect(() =>
      validateCityModel({
        ...DEMO_MODEL,
        base: {
          ...base,
          size: { ...base.size, x: base.size.x - 1 },
        },
      }),
    ).toThrow(/base\.size\.x\/z must equal bounds\.x\/z/u);
    expect(() =>
      validateCityModel({
        ...DEMO_MODEL,
        base: {
          ...base,
          position: { ...base.position, x: base.position.x + 100 },
        },
      }),
    ).toThrow(/base must horizontally cover districts\[0\]/u);
    expect(() =>
      validateCityModel({
        ...DEMO_MODEL,
        base: {
          ...base,
          position: { ...base.position, y: base.position.y + 2 },
        },
      }),
    ).toThrow(/base must overlap districts\[0\] from below/u);
    expect(() =>
      validateCityModel({
        ...DEMO_MODEL,
        identityPanel: {
          ...panel,
          position: { ...panel.position, x: panel.position.x + 100 },
        },
      }),
    ).toThrow(/base must horizontally cover identityPanel and its relief/u);
  });

  it("requires buildings to sit inside and directly on their districts", () => {
    const firstBuilding = DEMO_MODEL.buildings[0]!;
    expect(() =>
      validateCityModel({
        ...DEMO_MODEL,
        buildings: DEMO_MODEL.buildings.map((building, index) =>
          index === 0
            ? {
                ...building,
                position: { ...building.position, x: 0 },
              }
            : building,
        ),
      }),
    ).toThrow(
      /buildings\[0\] must be horizontally contained by its referenced district/u,
    );
    expect(() =>
      validateCityModel({
        ...DEMO_MODEL,
        buildings: DEMO_MODEL.buildings.map((building, index) =>
          index === 0
            ? {
                ...building,
                position: {
                  ...firstBuilding.position,
                  y: firstBuilding.position.y + 1,
                },
              }
            : building,
        ),
      }),
    ).toThrow(/buildings\[0\] must rest on its referenced district/u);
  });

  it.each([
    "%2e%2e/private/logo.svg",
    "assets/.%2e/private/logo.svg",
    "assets%2flogo.svg",
    "assets/%255cprivate/logo.svg",
  ])("rejects encoded logo traversal %s", (relativePath) => {
    const model = {
      ...DEMO_MODEL,
      identity: {
        title: "Code City",
        logo: { relativePath, format: "svg" },
      },
    };

    expect(() => validateCityModel(model)).toThrow(
      /normalized repository-relative path/u,
    );
  });

  it.each([
    "C:\\private\\source.ts",
    "//server/share/source.ts",
    "/home/private/source.ts",
    "../private/source.ts",
  ])("rejects non-repository-relative source path %s", (path) => {
    expect(() =>
      validateCityModel({
        ...DEMO_MODEL,
        buildings: DEMO_MODEL.buildings.map((building, index) =>
          index === 0 ? { ...building, path } : building,
        ),
      }),
    ).toThrow(/normalized repository-relative path/u);
  });

  it("requires every source-structure path to be normalized", () => {
    for (const model of [
      {
        ...DEMO_MODEL,
        solutions: DEMO_MODEL.solutions.map((solution, index) =>
          index === 0 ? { ...solution, path: "src\\solution.sln" } : solution,
        ),
      },
      {
        ...DEMO_MODEL,
        modules: DEMO_MODEL.modules.map((module, index) =>
          index === 0 ? { ...module, path: "src\\module" } : module,
        ),
      },
      {
        ...DEMO_MODEL,
        districts: DEMO_MODEL.districts.map((district, index) =>
          index === 0 ? { ...district, path: "src\\district" } : district,
        ),
      },
    ]) {
      expect(() => validateCityModel(model)).toThrow(
        /normalized repository-relative path/u,
      );
    }
  });

  it("rejects inconsistent repository and module ownership", () => {
    const repositories = [
      ...DEMO_MODEL.repositories,
      { id: "repository:other", name: "other" },
    ];
    expect(() =>
      validateCityModel({
        ...DEMO_MODEL,
        repositories,
        districts: DEMO_MODEL.districts.map((district, index) =>
          index === 0
            ? { ...district, repositoryId: "repository:other" }
            : district,
        ),
      }),
    ).toThrow(/referenced module repository/u);

    expect(() =>
      validateCityModel({
        ...DEMO_MODEL,
        buildings: DEMO_MODEL.buildings.map((building, index) =>
          index === 0
            ? {
                ...building,
                moduleId: DEMO_MODEL.modules[1]!.id,
              }
            : building,
        ),
      }),
    ).toThrow(/ownership must match/u);
  });

  it("rejects cross-repository solution and module membership", () => {
    const otherRepository = {
      id: "repository:other",
      name: "Other",
    };
    const otherModule = {
      ...DEMO_MODEL.modules[0]!,
      id: "module:other",
      repositoryId: otherRepository.id,
      name: "Other module",
      path: "other",
      solutionIds: [],
    };

    expect(() =>
      validateCityModel({
        ...DEMO_MODEL,
        repositories: [...DEMO_MODEL.repositories, otherRepository],
        modules: [...DEMO_MODEL.modules, otherModule],
        solutions: DEMO_MODEL.solutions.map((solution, index) =>
          index === 0
            ? {
                ...solution,
                moduleIds: [...solution.moduleIds, otherModule.id],
              }
            : solution,
        ),
      }),
    ).toThrow(/solutions\[0\]\.moduleIds\[2\].*repository "repository:demo"/u);

    expect(() =>
      validateCityModel({
        ...DEMO_MODEL,
        repositories: [...DEMO_MODEL.repositories, otherRepository],
        modules: [
          ...DEMO_MODEL.modules,
          {
            ...otherModule,
            solutionIds: [DEMO_MODEL.solutions[0]!.id],
          },
        ],
      }),
    ).toThrow(/modules\[2\]\.solutionIds\[0\].*repository "repository:other"/u);
  });

  it("rejects a parent module owned by another repository", () => {
    const otherRepository = {
      id: "repository:other",
      name: "Other",
    };
    const otherModule = {
      ...DEMO_MODEL.modules[0]!,
      id: "module:other",
      repositoryId: otherRepository.id,
      name: "Other module",
      path: "other",
      solutionIds: [],
    };

    expect(() =>
      validateCityModel({
        ...DEMO_MODEL,
        repositories: [...DEMO_MODEL.repositories, otherRepository],
        modules: [
          {
            ...DEMO_MODEL.modules[0]!,
            parentModuleId: otherModule.id,
          },
          ...DEMO_MODEL.modules.slice(1),
          otherModule,
        ],
      }),
    ).toThrow(/modules\[0\]\.parentModuleId.*repository "repository:demo"/u);
  });

  it.each([
    {
      kind: "typescript-import" as const,
      sourceId: DEMO_MODEL.buildings[0]!.id,
      targetId: DEMO_MODEL.buildings[1]!.id,
    },
    {
      kind: "project-reference" as const,
      sourceId: DEMO_MODEL.modules[0]!.id,
      targetId: DEMO_MODEL.modules[1]!.id,
    },
    {
      kind: "package-reference" as const,
      sourceId: DEMO_MODEL.modules[0]!.id,
      targetId: DEMO_MODEL.modules[1]!.id,
    },
  ])("requires $kind dependencies to be owned by their source", (dependency) => {
    expect(() =>
      validateCityModel({
        ...DEMO_MODEL,
        repositories: [
          ...DEMO_MODEL.repositories,
          { id: "repository:other", name: "Other" },
        ],
        dependencies: [
          {
            id: `dependency:wrong-owner:${dependency.kind}`,
            repositoryId: "repository:other",
            ...dependency,
            weight: 1,
          },
        ],
      }),
    ).toThrow(/dependencies\[0\]\.repositoryId must match its source repository/u);
  });

  it("allows internal dependency targets in another repository", () => {
    const otherRepository = {
      id: "repository:other",
      name: "Other",
    };
    const districtTemplate = DEMO_MODEL.districts[0]!;
    const buildingTemplate = DEMO_MODEL.buildings.find(
      ({ districtId }) => districtId === districtTemplate.id,
    )!;
    const otherModule = {
      ...DEMO_MODEL.modules[0]!,
      id: "module:other",
      repositoryId: otherRepository.id,
      name: "Other module",
      path: "other",
      solutionIds: [],
    };
    const otherDistrict = {
      ...districtTemplate,
      id: "district:other",
      repositoryId: otherRepository.id,
      moduleId: otherModule.id,
      name: "Other district",
      path: "other",
    };
    const otherBuilding = {
      ...buildingTemplate,
      id: "building:other",
      repositoryId: otherRepository.id,
      moduleId: otherModule.id,
      districtId: otherDistrict.id,
      name: "other.ts",
      path: "other/other.ts",
    };
    const sourceBuilding = DEMO_MODEL.buildings[0]!;
    const sourceModule = DEMO_MODEL.modules[0]!;
    const model = {
      ...DEMO_MODEL,
      repositories: [...DEMO_MODEL.repositories, otherRepository],
      modules: [...DEMO_MODEL.modules, otherModule],
      districts: [...DEMO_MODEL.districts, otherDistrict],
      buildings: [...DEMO_MODEL.buildings, otherBuilding],
      dependencies: [
        {
          id: "dependency:cross-repository:typescript",
          repositoryId: sourceBuilding.repositoryId,
          sourceId: sourceBuilding.id,
          targetId: otherBuilding.id,
          kind: "typescript-import" as const,
          weight: 1,
        },
        {
          id: "dependency:cross-repository:project",
          repositoryId: sourceModule.repositoryId,
          sourceId: sourceModule.id,
          targetId: otherModule.id,
          kind: "project-reference" as const,
          weight: 1,
        },
        {
          id: "dependency:cross-repository:package",
          repositoryId: sourceModule.repositoryId,
          sourceId: sourceModule.id,
          targetId: otherModule.id,
          kind: "package-reference" as const,
          weight: 1,
        },
      ],
    };

    expect(validateCityModel(model)).toBe(model);
  });

  it.each(["red", "#123", "#12345", "#123456789"])(
    "rejects non-portable semantic color %s",
    (color) => {
      expect(() =>
        validateCityModel({
          ...DEMO_MODEL,
          semanticGroups: DEMO_MODEL.semanticGroups.map((group, index) =>
            index === 0 ? { ...group, color } : group,
          ),
        }),
      ).toThrow(/#RRGGBB or #RRGGBBAA/u);
    },
  );

  it("accepts an eight-digit semantic color", () => {
    expect(() =>
      validateCityModel({
        ...DEMO_MODEL,
        semanticGroups: DEMO_MODEL.semanticGroups.map((group, index) =>
          index === 0 ? { ...group, color: "#11223380" } : group,
        ),
      }),
    ).not.toThrow();
  });

  it("rejects top-level collections beyond viewer safety limits", () => {
    const model = {
      ...DEMO_MODEL,
      semanticGroups: Array.from(
        { length: CITY_MODEL_LIMITS.semanticGroups + 1 },
        () => DEMO_MODEL.semanticGroups[0],
      ),
    };

    expect(() => validateCityModel(model)).toThrow(
      `semanticGroups must contain at most ${CITY_MODEL_LIMITS.semanticGroups} items`,
    );
  });

  it("rejects geometry beyond the finite viewer coordinate limit", () => {
    const model = {
      ...DEMO_MODEL,
      buildings: DEMO_MODEL.buildings.map((building, index) =>
        index === 0
          ? {
              ...building,
              size: {
                ...building.size,
                x: CITY_MODEL_LIMITS.coordinateMagnitude + 1,
              },
            }
          : building,
      ),
    };

    expect(() => validateCityModel(model)).toThrow(
      `must not exceed ${CITY_MODEL_LIMITS.coordinateMagnitude} model units`,
    );
  });
});
