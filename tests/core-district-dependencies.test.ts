import { describe, expect, it } from "vitest";

import {
  createDistrictDependencyExplorerIndex,
  DISTRICT_DEPENDENCY_BUNDLES_LIMIT,
  INITIAL_DISTRICT_DEPENDENCY_FILTERS,
  summarizeDistrictDependencies,
} from "../packages/core/src/district-dependencies.js";
import {
  EXTERNAL_DEPENDENCY_OVERFLOW_ID,
  selectExternalDependencies,
} from "../packages/core/src/external-dependencies.js";
import type {
  CityBuilding,
  CityDependency,
  CityDistrict,
  CityModel,
  CityModule,
  DependencyKind,
} from "../packages/core/src/model.js";
describe("core district dependency aggregation", () => {
  it("preserves viewer behavior and deterministically ranks immutable district bundles", () => {
    const model = aggregationModel();
    const inputsBefore = structuredClone({
      modules: model.modules,
      districts: model.districts,
      buildings: model.buildings,
      dependencies: model.dependencies,
    });

    const index = createDistrictDependencyExplorerIndex(model);
    const summary = summarizeDistrictDependencies(
      index,
      INITIAL_DISTRICT_DEPENDENCY_FILTERS,
    );
    const reversedModel: CityModel = {
      ...model,
      modules: model.modules.toReversed(),
      districts: model.districts.toReversed(),
      buildings: model.buildings.toReversed(),
      dependencies: model.dependencies.toReversed(),
    };
    const reversedSummary = summarizeDistrictDependencies(
      createDistrictDependencyExplorerIndex(reversedModel),
      INITIAL_DISTRICT_DEPENDENCY_FILTERS,
    );

    expect(reversedSummary).toEqual(summary);
    expect({
      modules: model.modules,
      districts: model.districts,
      buildings: model.buildings,
      dependencies: model.dependencies,
    }).toEqual(inputsBefore);
    expect(index).toMatchObject({
      districtCount: 3,
      dependencyCount: 33,
      bundleCount: 29,
    });
    expect(summary).toMatchObject({
      totalBundleCount: 29,
      visibleBundleCount: DISTRICT_DEPENDENCY_BUNDLES_LIMIT,
      hiddenBundleCount: 5,
      totalReferenceWeight: 378,
      visibleReferenceWeight: 364,
      hiddenReferenceWeight: 14,
    });
    expect(summary.availableKinds).toEqual([
      { kind: "typescript-import", edgeCount: 3, weight: 13 },
      { kind: "project-reference", edgeCount: 1, weight: 7 },
      { kind: "package-reference", edgeCount: 28, weight: 358 },
    ]);

    const internal = summary.bundles.find(
      ({ target }) =>
        target.kind === "district" &&
        target.districtId === "district-b",
    );
    expect(internal).toMatchObject({
      source: { kind: "district", districtId: "district-a" },
      target: { kind: "district", districtId: "district-b" },
      edgeCount: 4,
      weight: 17,
      kinds: [
        { kind: "typescript-import", edgeCount: 2, weight: 7 },
        { kind: "project-reference", edgeCount: 1, weight: 7 },
        { kind: "package-reference", edgeCount: 1, weight: 3 },
      ],
    });
    expect(
      summary.bundles.some(
        ({ target }) =>
          target.kind === "external" && target.target === "rxjs",
      ),
    ).toBe(true);
    expect(
      summary.bundles.some(
        ({ target }) =>
          target.kind === "external" && target.target === "react",
      ),
    ).toBe(false);
    expect(
      summary.bundles.flatMap(({ contributors }) =>
        contributors.map(({ dependencyId }) => dependencyId),
      ),
    ).not.toContain("same-district");
  });

  it("coalesces overflow targets by physical node before the display cap", () => {
    const model = overflowAggregationModel();
    const selection = selectExternalDependencies(model.dependencies);
    const summary = summarizeDistrictDependencies(
      createDistrictDependencyExplorerIndex(model),
      INITIAL_DISTRICT_DEPENDENCY_FILTERS,
      selection,
    );
    const reversedModel: CityModel = {
      ...model,
      modules: model.modules.toReversed(),
      districts: model.districts.toReversed(),
      dependencies: model.dependencies.toReversed(),
    };
    const reversedSummary = summarizeDistrictDependencies(
      createDistrictDependencyExplorerIndex(reversedModel),
      INITIAL_DISTRICT_DEPENDENCY_FILTERS,
      selectExternalDependencies(reversedModel.dependencies),
    );

    expect(reversedSummary).toEqual(summary);
    expect(summary).toMatchObject({
      totalBundleCount: 38,
      visibleBundleCount: DISTRICT_DEPENDENCY_BUNDLES_LIMIT,
      hiddenBundleCount: 14,
      totalReferenceWeight: 2805,
      visibleReferenceWeight: 2400,
      hiddenReferenceWeight: 405,
      availableKinds: [
        { kind: "typescript-import", edgeCount: 0, weight: 0 },
        { kind: "project-reference", edgeCount: 0, weight: 0 },
        { kind: "package-reference", edgeCount: 41, weight: 2805 },
      ],
    });

    const uncappedOverflow = summarizeDistrictDependencies(
      createDistrictDependencyExplorerIndex({
        ...model,
        modules: model.modules.slice(0, 1),
        districts: model.districts.slice(0, 1),
        dependencies: model.dependencies.filter(
          ({ sourceId }) => sourceId === "module-00",
        ),
      }),
      INITIAL_DISTRICT_DEPENDENCY_FILTERS,
      selection,
    );
    const overflow = uncappedOverflow.bundles.find(
      ({ target }) =>
        target.kind === "external" &&
        target.nodeId === EXTERNAL_DEPENDENCY_OVERFLOW_ID,
    );

    expect(uncappedOverflow).toMatchObject({
      totalBundleCount: 11,
      visibleBundleCount: 11,
      hiddenBundleCount: 0,
      totalReferenceWeight: 105,
      visibleReferenceWeight: 105,
      hiddenReferenceWeight: 0,
    });
    expect(overflow).toMatchObject({
      target: {
        kind: "external",
        target: "Others",
        nodeId: EXTERNAL_DEPENDENCY_OVERFLOW_ID,
      },
      edgeCount: 4,
      weight: 10,
      kinds: [
        { kind: "package-reference", edgeCount: 4, weight: 10 },
      ],
      dependencyIds: ["weak-00", "weak-01", "weak-02", "weak-03"],
      contributors: [
        {
          dependencyId: "weak-03",
          targetLabel: "Others",
          targetPath: "Others",
          weight: 4,
        },
        {
          dependencyId: "weak-02",
          targetLabel: "Others",
          targetPath: "Others",
          weight: 3,
        },
        {
          dependencyId: "weak-01",
          targetLabel: "Others",
          targetPath: "Others",
          weight: 2,
        },
        {
          dependencyId: "weak-00",
          targetLabel: "Others",
          targetPath: "Others",
          weight: 1,
        },
      ],
    });
    expect(overflow?.id).toContain(
      encodeURIComponent(EXTERNAL_DEPENDENCY_OVERFLOW_ID),
    );
    expect(overflow?.id).not.toMatch(/weak-target/iu);
  });
});

function aggregationModel(): CityModel {
  const modules = Object.freeze([
    moduleFixture("module-a", "Module A"),
    moduleFixture("module-b", "Module B"),
    moduleFixture("module-c", "Module C"),
  ]);
  const districts = Object.freeze([
    districtFixture("district-a", "module-a", "District A"),
    districtFixture("district-b", "module-b", "District B"),
    districtFixture("district-c", "module-c", "District C"),
  ]);
  const buildings = Object.freeze([
    buildingFixture("building-a1", "module-a", "district-a"),
    buildingFixture("building-a2", "module-a", "district-a"),
    buildingFixture("building-b", "module-b", "district-b"),
  ]);
  const dependencies = Object.freeze([
    dependencyFixture(
      "typescript-a1-b",
      "building-a1",
      "typescript-import",
      5,
      "building-b",
    ),
    dependencyFixture(
      "typescript-a2-b",
      "building-a2",
      "typescript-import",
      2,
      "building-b",
    ),
    dependencyFixture(
      "project-a-b",
      "module-a",
      "project-reference",
      7,
      "module-b",
    ),
    dependencyFixture(
      "package-a-b",
      "module-a",
      "package-reference",
      3,
      "module-b",
    ),
    dependencyFixture(
      "same-district",
      "building-a1",
      "typescript-import",
      99,
      "building-a2",
    ),
    externalDependencyFixture(
      "typescript-rxjs",
      "building-a1",
      "typescript-import",
      6,
      "rxjs",
    ),
    externalDependencyFixture(
      "package-react",
      "module-a",
      "package-reference",
      4,
      "react",
    ),
    ...Array.from({ length: 26 }, (_, index) =>
      externalDependencyFixture(
        `package-${index.toString().padStart(2, "0")}`,
        "module-c",
        "package-reference",
        index + 1,
        `dependency-${index.toString().padStart(2, "0")}`,
      ),
    ),
  ]);

  return {
    schemaVersion: "1.0",
    generator: { name: "code-city", version: "test" },
    repositories: [{ id: "repository", name: "Repository" }],
    solutions: [],
    modules,
    semanticGroups: [],
    districts,
    buildings,
    dependencies,
    bounds: { x: 30, y: 5, z: 10 },
  };
}

function overflowAggregationModel(): CityModel {
  const modules = Object.freeze(
    Array.from({ length: 28 }, (_, index) =>
      moduleFixture(
        `module-${index.toString().padStart(2, "0")}`,
        `Module ${index}`,
      ),
    ),
  );
  const districts = Object.freeze(
    modules.map((module, index) =>
      districtFixture(
        `district-${index.toString().padStart(2, "0")}`,
        module.id,
        `District ${index}`,
      ),
    ),
  );
  const weak = Array.from({ length: 14 }, (_, index) =>
    externalDependencyFixture(
      `weak-${index.toString().padStart(2, "0")}`,
      "module-00",
      "package-reference",
      index + 1,
      `weak-target-${index.toString().padStart(2, "0")}`,
    ),
  );
  const shared = Array.from({ length: 27 }, (_, index) =>
    externalDependencyFixture(
      `shared-${index.toString().padStart(2, "0")}`,
      `module-${(index + 1).toString().padStart(2, "0")}`,
      "package-reference",
      100,
      "shared-provider",
    ),
  );

  return {
    schemaVersion: "1.0",
    generator: { name: "code-city", version: "test" },
    repositories: [{ id: "repository", name: "Repository" }],
    solutions: [],
    modules,
    semanticGroups: [],
    districts,
    buildings: [],
    dependencies: Object.freeze([...weak, ...shared]),
    bounds: { x: 280, y: 5, z: 10 },
  };
}

function moduleFixture(id: string, name: string): CityModule {
  return {
    id,
    repositoryId: "repository",
    kind: "dotnet-project",
    name,
    path: `modules/${id}`,
    solutionIds: [],
  };
}

function districtFixture(
  id: string,
  moduleId: string,
  name: string,
): CityDistrict {
  return {
    id,
    repositoryId: "repository",
    moduleId,
    name,
    path: `districts/${id}`,
    position: { x: 0, y: 0.5, z: 0 },
    size: { x: 8, y: 1, z: 8 },
  };
}

function buildingFixture(
  id: string,
  moduleId: string,
  districtId: string,
): CityBuilding {
  return {
    id,
    repositoryId: "repository",
    moduleId,
    districtId,
    name: `${id}.ts`,
    path: `src/${id}.ts`,
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

function dependencyFixture(
  id: string,
  sourceId: string,
  kind: DependencyKind,
  weight: number,
  targetId: string,
): CityDependency {
  return {
    id,
    repositoryId: "repository",
    sourceId,
    targetId,
    kind,
    weight,
  };
}

function externalDependencyFixture(
  id: string,
  sourceId: string,
  kind: DependencyKind,
  weight: number,
  externalTarget: string,
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
