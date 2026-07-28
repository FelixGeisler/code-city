import { describe, expect, it } from "vitest";

import {
  createDistrictDependencyExplorerIndex,
  DISTRICT_DEPENDENCY_BUNDLES_LIMIT,
  DISTRICT_DEPENDENCY_CONTRIBUTORS_LIMIT,
  INITIAL_DISTRICT_DEPENDENCY_FILTERS,
  resetDistrictDependencyFilters,
  summarizeDistrictDependencies,
  toggleDistrictDependencyKind,
} from "../apps/viewer/src/district-dependency-explorer.js";
import type {
  CityBuilding,
  CityDependency,
  CityDistrict,
  CityModel,
  CityModule,
  DependencyKind,
} from "../packages/core/src/model.js";

describe("district dependency aggregation", () => {
  it("bundles directed cross-district and external references across kinds", () => {
    const index = createDistrictDependencyExplorerIndex(
      aggregationModel(),
    );
    const summary = summarizeDistrictDependencies(
      index,
      INITIAL_DISTRICT_DEPENDENCY_FILTERS,
      null,
    );

    expect(index).toMatchObject({
      districtCount: 3,
      dependencyCount: 12,
      bundleCount: 4,
    });
    expect(summary.availableKinds).toEqual([
      { kind: "typescript-import", edgeCount: 5, weight: 26 },
      { kind: "project-reference", edgeCount: 3, weight: 15 },
      { kind: "package-reference", edgeCount: 3, weight: 15 },
    ]);
    expect(summary).toMatchObject({
      totalBundleCount: 4,
      visibleBundleCount: 4,
      hiddenBundleCount: 0,
      totalReferenceWeight: 56,
      visibleReferenceWeight: 56,
      hiddenReferenceWeight: 0,
    });
    expect(summary.bundles.map(({ weight }) => weight)).toEqual([
      42, 7, 4, 3,
    ]);

    const internal = summary.bundles[0]!;
    expect(internal).toMatchObject({
      source: {
        kind: "district",
        districtId: "district-a",
        name: "District A",
        path: "districts/A",
      },
      target: {
        kind: "district",
        districtId: "district-b",
        name: "District B",
        path: "districts/B",
      },
      edgeCount: 7,
      weight: 42,
      kinds: [
        { kind: "typescript-import", edgeCount: 4, weight: 24 },
        { kind: "project-reference", edgeCount: 1, weight: 8 },
        { kind: "package-reference", edgeCount: 2, weight: 10 },
      ],
    });
    expect(internal.contributors).toHaveLength(
      DISTRICT_DEPENDENCY_CONTRIBUTORS_LIMIT,
    );
    expect(
      internal.contributors.map(({ dependencyId, weight }) => [
        dependencyId,
        weight,
      ]),
    ).toEqual([
      ["ts-a-b", 9],
      ["project-a-b", 8],
      ["package-a-b", 7],
      ["ts-a2-b2", 6],
      ["ts-a-b2", 5],
    ]);
    expect(internal.contributors[0]).toEqual({
      dependencyId: "ts-a-b",
      kind: "typescript-import",
      sourceLabel: "Alpha.ts",
      sourcePath: "src/Alpha.ts",
      targetLabel: "Beta.ts",
      targetPath: "src/Beta.ts",
      weight: 9,
    });

    const external = summary.bundles[1]!;
    expect(external).toMatchObject({
      source: { kind: "district", districtId: "district-a" },
      target: { kind: "external", target: "rxjs" },
      edgeCount: 2,
      weight: 7,
      kinds: [
        { kind: "typescript-import", edgeCount: 1, weight: 2 },
        { kind: "package-reference", edgeCount: 1, weight: 5 },
      ],
    });
  });

  it("recalculates bundles and contributors while availability stays scope-wide", () => {
    const index = createDistrictDependencyExplorerIndex(
      aggregationModel(),
    );
    const typescriptOnly = {
      typescriptImport: true,
      projectReference: false,
      packageReference: false,
    };

    const summary = summarizeDistrictDependencies(
      index,
      typescriptOnly,
      null,
    );

    expect(summary.availableKinds).toEqual([
      { kind: "typescript-import", edgeCount: 5, weight: 26 },
      { kind: "project-reference", edgeCount: 3, weight: 15 },
      { kind: "package-reference", edgeCount: 3, weight: 15 },
    ]);
    expect(summary).toMatchObject({
      totalBundleCount: 2,
      totalReferenceWeight: 26,
    });
    expect(summary.bundles[0]).toMatchObject({
      edgeCount: 4,
      weight: 24,
      kinds: [
        { kind: "typescript-import", edgeCount: 4, weight: 24 },
      ],
    });
    expect(
      summary.bundles[0]!.contributors.map(
        ({ dependencyId }) => dependencyId,
      ),
    ).toEqual(["ts-a-b", "ts-a2-b2", "ts-a-b2", "ts-a2-b"]);
    expect(summary.bundles[1]).toMatchObject({
      target: { kind: "external", target: "rxjs" },
      edgeCount: 1,
      weight: 2,
    });
  });

  it("is deterministic when model collections arrive in reverse order", () => {
    const model = aggregationModel();
    const reversed = {
      ...model,
      modules: model.modules.toReversed(),
      districts: model.districts.toReversed(),
      buildings: model.buildings.toReversed(),
      dependencies: model.dependencies.toReversed(),
    };

    expect(
      summarizeDistrictDependencies(
        createDistrictDependencyExplorerIndex(reversed),
        INITIAL_DISTRICT_DEPENDENCY_FILTERS,
        null,
      ),
    ).toEqual(
      summarizeDistrictDependencies(
        createDistrictDependencyExplorerIndex(model),
        INITIAL_DISTRICT_DEPENDENCY_FILTERS,
        null,
      ),
    );
  });

  it("caps ranked bundles and reports exact hidden counts and weights", () => {
    const modules = [
      fixtureModule("module-a", "Module A"),
      ...Array.from({ length: 26 }, (_, index) =>
        fixtureModule(
          `module-${index.toString().padStart(2, "0")}`,
          `Module ${index}`,
        ),
      ),
    ];
    const districts = modules.map((module, index) =>
      fixtureDistrict(
        `district-${index.toString().padStart(2, "0")}`,
        module.id,
        `District ${index}`,
      ),
    );
    const dependencies = Array.from(
      { length: 26 },
      (_, index): CityDependency => ({
        id: `package-${index.toString().padStart(2, "0")}`,
        repositoryId: "repository",
        sourceId: "module-a",
        externalTarget: `package-${index.toString().padStart(2, "0")}`,
        kind: "package-reference",
        weight: index + 1,
      }),
    );
    const index = createDistrictDependencyExplorerIndex(
      fixtureModel({
        modules,
        districts,
        buildings: [],
        dependencies,
      }),
    );

    const summary = summarizeDistrictDependencies(
      index,
      INITIAL_DISTRICT_DEPENDENCY_FILTERS,
      null,
    );

    expect(summary).toMatchObject({
      totalBundleCount: 26,
      visibleBundleCount: DISTRICT_DEPENDENCY_BUNDLES_LIMIT,
      hiddenBundleCount: 2,
      totalReferenceWeight: 351,
      visibleReferenceWeight: 348,
      hiddenReferenceWeight: 3,
    });
    expect(summary.availableKinds).toEqual([
      { kind: "typescript-import", edgeCount: 0, weight: 0 },
      { kind: "project-reference", edgeCount: 0, weight: 0 },
      { kind: "package-reference", edgeCount: 26, weight: 351 },
    ]);
    expect(summary.bundles.map(({ weight }) => weight)).toEqual(
      Array.from(
        { length: DISTRICT_DEPENDENCY_BUNDLES_LIMIT },
        (_, index) => 26 - index,
      ),
    );
  });

  it("keeps the index and returned presentation data immutable snapshots", () => {
    const model = aggregationModel();
    const index = createDistrictDependencyExplorerIndex(model);
    (model.modules as CityModule[]).splice(0);
    (model.districts as CityDistrict[]).splice(0);
    (model.buildings as CityBuilding[]).splice(0);
    (model.dependencies as CityDependency[]).splice(0);

    const summary = summarizeDistrictDependencies(
      index,
      INITIAL_DISTRICT_DEPENDENCY_FILTERS,
      null,
    );

    expect(Object.isFrozen(index)).toBe(true);
    expect(Object.isFrozen(summary)).toBe(true);
    expect(Object.isFrozen(summary.availableKinds)).toBe(true);
    expect(Object.isFrozen(summary.bundles)).toBe(true);
    expect(Object.isFrozen(summary.bundles[0])).toBe(true);
    expect(Object.isFrozen(summary.bundles[0]!.kinds)).toBe(true);
    expect(Object.isFrozen(summary.bundles[0]!.contributors)).toBe(true);
    expect(summary.totalBundleCount).toBe(4);
  });
});

describe("district dependency isolation", () => {
  it("keeps only touching bundles and hides the other district geometry", () => {
    const index = createDistrictDependencyExplorerIndex(
      aggregationModel(),
    );

    const summary = summarizeDistrictDependencies(
      index,
      INITIAL_DISTRICT_DEPENDENCY_FILTERS,
      "district-a",
    );

    expect(summary).toMatchObject({
      totalBundleCount: 3,
      totalReferenceWeight: 53,
      availableKinds: [
        { kind: "typescript-import", edgeCount: 5, weight: 26 },
        { kind: "project-reference", edgeCount: 2, weight: 12 },
        { kind: "package-reference", edgeCount: 3, weight: 15 },
      ],
    });
    const outgoing = summary.bundles.find(
      ({ weight }) => weight === 42,
    )!;
    expect(outgoing.source).toEqual({
      kind: "district",
      districtId: "district-a",
      name: "District A",
      path: "districts/A",
    });
    expect(outgoing.target).toEqual({
      kind: "district-boundary",
      visibleDistrictId: "district-a",
      hiddenDistrictId: "district-b",
      hiddenDistrictName: "District B",
      hiddenDistrictPath: "districts/B",
    });
    expect(outgoing.target).not.toHaveProperty("position");
    expect(outgoing.target).not.toHaveProperty("size");

    const incoming = summary.bundles.find(
      ({ weight }) => weight === 4,
    )!;
    expect(incoming.source).toMatchObject({
      kind: "district-boundary",
      visibleDistrictId: "district-a",
      hiddenDistrictId: "district-c",
    });
    expect(incoming.target).toMatchObject({
      kind: "district",
      districtId: "district-a",
    });
    expect(
      summary.bundles.some(({ weight }) => weight === 3),
    ).toBe(false);
  });

  it("rejects an unknown isolated district", () => {
    const index = createDistrictDependencyExplorerIndex(
      aggregationModel(),
    );

    expect(() =>
      summarizeDistrictDependencies(
        index,
        INITIAL_DISTRICT_DEPENDENCY_FILTERS,
        "missing",
      ),
    ).toThrow(/unknown isolated district/iu);
  });
});

describe("district dependency filters", () => {
  it("start enabled, toggle independently, and reset", () => {
    const withoutProjects = toggleDistrictDependencyKind(
      INITIAL_DISTRICT_DEPENDENCY_FILTERS,
      "project-reference",
    );
    const withoutProjectsOrImports = toggleDistrictDependencyKind(
      withoutProjects,
      "typescript-import",
    );

    expect(INITIAL_DISTRICT_DEPENDENCY_FILTERS).toEqual({
      typescriptImport: true,
      projectReference: true,
      packageReference: true,
    });
    expect(withoutProjects).toEqual({
      typescriptImport: true,
      projectReference: false,
      packageReference: true,
    });
    expect(withoutProjectsOrImports).toEqual({
      typescriptImport: false,
      projectReference: false,
      packageReference: true,
    });
    expect(resetDistrictDependencyFilters()).toBe(
      INITIAL_DISTRICT_DEPENDENCY_FILTERS,
    );
  });

  it("returns an empty summary when every kind is disabled", () => {
    const index = createDistrictDependencyExplorerIndex(
      aggregationModel(),
    );

    const summary = summarizeDistrictDependencies(
      index,
      {
        typescriptImport: false,
        projectReference: false,
        packageReference: false,
      },
      null,
    );

    expect(summary).toMatchObject({
      totalBundleCount: 0,
      visibleBundleCount: 0,
      hiddenBundleCount: 0,
      totalReferenceWeight: 0,
      visibleReferenceWeight: 0,
      hiddenReferenceWeight: 0,
      bundles: [],
    });
    expect(summary.availableKinds).toEqual([
      { kind: "typescript-import", edgeCount: 5, weight: 26 },
      { kind: "project-reference", edgeCount: 3, weight: 15 },
      { kind: "package-reference", edgeCount: 3, weight: 15 },
    ]);
  });
});

describe("district dependency model safety", () => {
  it("rejects duplicate relevant ids and ambiguous module mappings", () => {
    const base = fixtureModel();
    expect(() =>
      createDistrictDependencyExplorerIndex({
        ...base,
        modules: [base.modules[0]!, base.modules[0]!],
      }),
    ).toThrow(/duplicate module id/iu);
    expect(() =>
      createDistrictDependencyExplorerIndex({
        ...base,
        districts: [base.districts[0]!, base.districts[0]!],
      }),
    ).toThrow(/duplicate district id/iu);
    expect(() =>
      createDistrictDependencyExplorerIndex({
        ...base,
        districts: [
          base.districts[0]!,
          fixtureDistrict(
            "second-district",
            base.modules[0]!.id,
            "Second",
          ),
        ],
      }),
    ).toThrow(/maps to multiple districts/u);
    expect(() =>
      createDistrictDependencyExplorerIndex({
        ...base,
        buildings: [base.buildings[0]!, base.buildings[0]!],
      }),
    ).toThrow(/duplicate building id/iu);
    const duplicate = projectDependency(
      "duplicate",
      "module-a",
      "module-b",
      1,
    );
    expect(() =>
      createDistrictDependencyExplorerIndex({
        ...base,
        dependencies: [duplicate, duplicate],
      }),
    ).toThrow(/duplicate dependency id/iu);
  });

  it("rejects malformed, unknown, and unmapped dependency endpoints", () => {
    const base = fixtureModel();
    const cases: readonly {
      readonly dependency: CityDependency;
      readonly pattern: RegExp;
    }[] = [
      {
        dependency: typescriptDependency(
          "unknown-source",
          "missing",
          "building-b",
          1,
        ),
        pattern: /unknown or unmapped source/u,
      },
      {
        dependency: projectDependency(
          "unknown-target",
          "module-a",
          "missing",
          1,
        ),
        pattern: /unknown or unmapped target/u,
      },
      {
        dependency: {
          ...projectDependency(
            "ambiguous",
            "module-a",
            "module-b",
            1,
          ),
          externalTarget: "external",
        },
        pattern: /exactly one target/u,
      },
      {
        dependency: {
          id: "no-target",
          repositoryId: "repository",
          sourceId: "module-a",
          kind: "project-reference",
          weight: 1,
        },
        pattern: /exactly one target/u,
      },
      {
        dependency: externalDependency(
          "blank-external",
          "module-a",
          "package-reference",
          "   ",
          1,
        ),
        pattern: /empty external target/u,
      },
      {
        dependency: projectDependency(
          "bad-weight",
          "module-a",
          "module-b",
          0,
        ),
        pattern: /invalid weight/u,
      },
    ];

    for (const { dependency, pattern } of cases) {
      expect(() =>
        createDistrictDependencyExplorerIndex({
          ...base,
          dependencies: [dependency],
        }),
      ).toThrow(pattern);
    }

    const orphan = fixtureModule("orphan", "Orphan");
    expect(() =>
      createDistrictDependencyExplorerIndex({
        ...base,
        modules: [...base.modules, orphan],
        dependencies: [
          projectDependency(
            "unmapped-source",
            "orphan",
            "module-a",
            1,
          ),
        ],
      }),
    ).toThrow(/unknown or unmapped source/u);
  });

  it("rejects inconsistent building-to-district mappings", () => {
    const base = fixtureModel();
    expect(() =>
      createDistrictDependencyExplorerIndex({
        ...base,
        buildings: [
          {
            ...base.buildings[0]!,
            moduleId: "module-b",
          },
        ],
      }),
    ).toThrow(/ambiguous module and district mapping/u);
  });

  it("keeps accepted finite weights finite when bundles aggregate", () => {
    const base = fixtureModel();
    const maximum = Number.MAX_VALUE;
    const index = createDistrictDependencyExplorerIndex({
      ...base,
      dependencies: [
        projectDependency(
          "maximum-a",
          "module-a",
          "module-b",
          maximum,
        ),
        projectDependency(
          "maximum-b",
          "module-a",
          "module-b",
          maximum,
        ),
      ],
    });

    const summary = summarizeDistrictDependencies(
      index,
      INITIAL_DISTRICT_DEPENDENCY_FILTERS,
      null,
    );

    expect(summary.totalReferenceWeight).toBe(maximum);
    expect(summary.visibleReferenceWeight).toBe(maximum);
    expect(summary.bundles[0]?.weight).toBe(maximum);
    expect(summary.availableKinds[1]?.weight).toBe(maximum);
  });
});

function aggregationModel(): CityModel {
  const modules = [
    fixtureModule("module-a", "Module A"),
    fixtureModule("module-b", "Module B"),
    fixtureModule("module-c", "Module C"),
  ];
  const districts = [
    fixtureDistrict("district-a", "module-a", "District A"),
    fixtureDistrict("district-b", "module-b", "District B"),
    fixtureDistrict("district-c", "module-c", "District C"),
  ];
  const buildings = [
    fixtureBuilding("building-a", "module-a", "district-a", "Alpha.ts"),
    fixtureBuilding(
      "building-a2",
      "module-a",
      "district-a",
      "AlphaTwo.ts",
    ),
    fixtureBuilding("building-b", "module-b", "district-b", "Beta.ts"),
    fixtureBuilding(
      "building-b2",
      "module-b",
      "district-b",
      "BetaTwo.ts",
    ),
    fixtureBuilding("building-c", "module-c", "district-c", "Gamma.ts"),
  ];
  const dependencies: readonly CityDependency[] = [
    typescriptDependency(
      "ts-a-b",
      "building-a",
      "building-b",
      9,
    ),
    projectDependency("project-a-b", "module-a", "module-b", 8),
    packageDependency("package-a-b", "module-a", "module-b", 7),
    typescriptDependency(
      "ts-a2-b2",
      "building-a2",
      "building-b2",
      6,
    ),
    typescriptDependency(
      "ts-a-b2",
      "building-a",
      "building-b2",
      5,
    ),
    typescriptDependency(
      "ts-a2-b",
      "building-a2",
      "building-b",
      4,
    ),
    packageDependency("package-a-b-extra", "module-a", "module-b", 3),
    externalDependency(
      "ts-a-rxjs",
      "building-a",
      "typescript-import",
      "rxjs",
      2,
    ),
    externalDependency(
      "package-a-rxjs",
      "module-a",
      "package-reference",
      "rxjs",
      5,
    ),
    typescriptDependency(
      "same-district",
      "building-a",
      "building-a2",
      100,
    ),
    projectDependency("project-c-a", "module-c", "module-a", 4),
    projectDependency("project-b-c", "module-b", "module-c", 3),
  ];
  return fixtureModel({ modules, districts, buildings, dependencies });
}

function fixtureModel(
  overrides: {
    readonly modules?: readonly CityModule[];
    readonly districts?: readonly CityDistrict[];
    readonly buildings?: readonly CityBuilding[];
    readonly dependencies?: readonly CityDependency[];
  } = {},
): CityModel {
  return {
    schemaVersion: "1.0",
    generator: { name: "code-city", version: "test" },
    repositories: [{ id: "repository", name: "Repository" }],
    solutions: [],
    modules: overrides.modules ?? [
      fixtureModule("module-a", "Module A"),
      fixtureModule("module-b", "Module B"),
    ],
    semanticGroups: [],
    districts: overrides.districts ?? [
      fixtureDistrict("district-a", "module-a", "District A"),
      fixtureDistrict("district-b", "module-b", "District B"),
    ],
    buildings: overrides.buildings ?? [
      fixtureBuilding(
        "building-a",
        "module-a",
        "district-a",
        "Alpha.ts",
      ),
      fixtureBuilding(
        "building-b",
        "module-b",
        "district-b",
        "Beta.ts",
      ),
    ],
    dependencies: overrides.dependencies ?? [],
    bounds: { x: 20, y: 5, z: 20 },
  };
}

function fixtureModule(id: string, name: string): CityModule {
  return {
    id,
    repositoryId: "repository",
    kind: "dotnet-project",
    name,
    path: `modules\\${name}`,
    solutionIds: [],
  };
}

function fixtureDistrict(
  id: string,
  moduleId: string,
  name: string,
): CityDistrict {
  return {
    id,
    repositoryId: "repository",
    moduleId,
    name,
    path: `districts\\${name.slice(-1)}`,
    position: { x: 0, y: 0.5, z: 0 },
    size: { x: 10, y: 1, z: 10 },
  };
}

function fixtureBuilding(
  id: string,
  moduleId: string,
  districtId: string,
  name: string,
): CityBuilding {
  return {
    id,
    repositoryId: "repository",
    moduleId,
    districtId,
    name,
    path: `src\\${name.replace("Two", "2")}`,
    language: "typescript",
    metrics: {
      sloc: 1,
      decisionLoad: 1,
      maximumComplexity: 1,
      executableUnitCount: 1,
    },
    risk: "low",
    semanticGroupId: "low-risk",
    position: { x: 0, y: 2, z: 0 },
    size: { x: 1, y: 3, z: 1 },
  };
}

function typescriptDependency(
  id: string,
  sourceId: string,
  targetId: string,
  weight: number,
): CityDependency {
  return {
    id,
    repositoryId: "repository",
    sourceId,
    targetId,
    kind: "typescript-import",
    weight,
  };
}

function projectDependency(
  id: string,
  sourceId: string,
  targetId: string,
  weight: number,
): CityDependency {
  return {
    id,
    repositoryId: "repository",
    sourceId,
    targetId,
    kind: "project-reference",
    weight,
  };
}

function packageDependency(
  id: string,
  sourceId: string,
  targetId: string,
  weight: number,
): CityDependency {
  return {
    id,
    repositoryId: "repository",
    sourceId,
    targetId,
    kind: "package-reference",
    weight,
  };
}

function externalDependency(
  id: string,
  sourceId: string,
  kind: DependencyKind,
  externalTarget: string,
  weight: number,
): CityDependency {
  return {
    id,
    repositoryId: "repository",
    sourceId,
    externalTarget,
    kind,
    weight,
  };
}
