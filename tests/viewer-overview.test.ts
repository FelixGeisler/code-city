import { describe, expect, it } from "vitest";

import {
  summarizeViewerOverview,
  type ViewerOverviewModel,
} from "../apps/viewer/src/viewer-overview.js";
import type {
  CityBuilding,
  CityDependency,
  CityDistrict,
  CityModule,
  CityRepository,
  CitySolution,
  RiskBand,
} from "../packages/core/src/model.js";

describe("viewer city overview", () => {
  it("summarizes the whole city with an odd complexity median", () => {
    const model = overviewModel({
      buildings: [
        building("building:a", "district:a", "module:a", "repository:a", 10, 9, "low"),
        building("building:b", "district:b", "module:b", "repository:b", 20, 1, "moderate"),
        building("building:c", "district:b", "module:b", "repository:b", 30, 5, "very-high"),
      ],
      dependencies: [
        dependency("dependency:a", "building:a", 2),
        dependency("dependency:b", "module:b", 3),
      ],
      districts: [
        district("district:a", "module:a", "repository:a", "Application"),
        district("district:b", "module:b", "repository:b", "Library"),
      ],
      modules: [
        module("module:a", "repository:a"),
        module("module:b", "repository:b"),
      ],
      repositories: [
        repository("repository:a"),
        repository("repository:b"),
      ],
      solutions: [
        solution("solution:a", "repository:a", ["module:a"]),
        solution("solution:b", "repository:b", ["module:b"]),
      ],
    });

    expect(summarizeViewerOverview(model)).toEqual({
      counts: {
        repositories: 2,
        solutions: 2,
        modules: 2,
        districts: 2,
        buildings: 3,
      },
      complexity: {
        totalSloc: 60,
        medianMaximumComplexity: 5,
        maximumComplexity: 9,
      },
      risks: {
        low: 1,
        moderate: 1,
        high: 0,
        "very-high": 1,
      },
      dependencies: {
        edgeCount: 2,
        totalReferenceWeight: 5,
      },
    });
  });

  it("summarizes every district and deduplicates city entities", () => {
    const model = overviewModel({
      buildings: [
        building("building:a", "district:a", "module:a", "repository:a", 11, 2, "low"),
        building("building:b", "district:a", "module:a", "repository:a", 13, 8, "high"),
        building("building:c", "district:a", "module:b", "repository:a", 17, 4, "moderate"),
        building("building:d", "district:a", "module:b", "repository:a", 19, 6, "high"),
        building("building:outside", "district:b", "module:c", "repository:b", 19, 20, "very-high"),
      ],
      districts: [
        district("district:a", "module:a", "repository:a", "Frontend"),
        district("district:b", "module:c", "repository:b", "Backend"),
      ],
      modules: [
        module("module:a", "repository:a"),
        module("module:b", "repository:a"),
        module("module:c", "repository:b"),
      ],
      repositories: [
        repository("repository:a"),
        repository("repository:b"),
      ],
      solutions: [
        solution("solution:a", "repository:a", [
          "module:a",
          "module:a",
        ]),
        solution("solution:b", "repository:a", ["module:b"]),
        solution("solution:outside", "repository:b", ["module:c"]),
      ],
    });

    const summary = summarizeViewerOverview(model);

    expect(summary.counts).toEqual({
      repositories: 2,
      solutions: 3,
      modules: 3,
      districts: 2,
      buildings: 5,
    });
    expect(summary.complexity).toEqual({
      totalSloc: 79,
      medianMaximumComplexity: 6,
      maximumComplexity: 20,
    });
    expect(summary.risks).toEqual({
      low: 1,
      moderate: 1,
      high: 2,
      "very-high": 1,
    });
  });

  it("counts every city dependency", () => {
    const model = overviewModel({
      buildings: [
        building("building:inside", "district:a", "module:a", "repository:a", 10, 1, "low"),
        building("building:outside", "district:b", "module:b", "repository:b", 10, 1, "low"),
      ],
      dependencies: [
        dependency("dependency:building-source", "building:inside", 2, "building:outside"),
        dependency("dependency:module-source", "module:a", 3, "module:b"),
        dependency("dependency:building-inbound", "building:outside", 5, "building:inside"),
        dependency("dependency:module-inbound", "module:b", 7, "module:a"),
      ],
      districts: [
        district("district:a", "module:a", "repository:a", "Inside"),
        district("district:b", "module:b", "repository:b", "Outside"),
      ],
      modules: [
        module("module:a", "repository:a"),
        module("module:b", "repository:b"),
      ],
      repositories: [
        repository("repository:a"),
        repository("repository:b"),
      ],
      solutions: [
        solution("solution:a", "repository:a", ["module:a"]),
        solution("solution:b", "repository:b", ["module:b"]),
      ],
    });

    expect(
      summarizeViewerOverview(model).dependencies,
    ).toEqual({
      edgeCount: 4,
      totalReferenceWeight: 17,
    });
  });

  it("returns zero building metrics for an empty city", () => {
    const model = overviewModel({
      dependencies: [
        dependency("dependency:unscoped-module", "module:empty", 4),
      ],
      districts: [
        district(
          "district:empty",
          "module:empty",
          "repository:a",
          "Empty",
        ),
      ],
      modules: [module("module:empty", "repository:a")],
      repositories: [repository("repository:a")],
      solutions: [
        solution("solution:empty", "repository:a", ["module:empty"]),
      ],
    });

    const summary = summarizeViewerOverview(model);

    expect(summary.counts).toEqual({
      repositories: 1,
      solutions: 1,
      modules: 1,
      districts: 1,
      buildings: 0,
    });
    expect(summary.complexity).toEqual({
      totalSloc: 0,
      medianMaximumComplexity: 0,
      maximumComplexity: 0,
    });
    expect(summary.risks).toEqual({
      low: 0,
      moderate: 0,
      high: 0,
      "very-high": 0,
    });
    expect(summary.dependencies).toEqual({
      edgeCount: 1,
      totalReferenceWeight: 4,
    });
  });

  it("freezes the whole-city result", () => {
    const model = overviewModel({
      buildings: [
        building("building:a", "district:a", "module:a", "repository:a", 5, 3, "low"),
      ],
      dependencies: [
        dependency("dependency:a", "building:a", 2),
      ],
      districts: [
        district("district:a", "module:a", "repository:a", "Application"),
      ],
      modules: [module("module:a", "repository:a")],
      repositories: [repository("repository:a")],
      solutions: [
        solution("solution:a", "repository:a", ["module:a"]),
      ],
    });

    const summary = summarizeViewerOverview(model);

    expect(Object.isFrozen(summary)).toBe(true);
    expect(Object.isFrozen(summary.counts)).toBe(true);
    expect(Object.isFrozen(summary.complexity)).toBe(true);
    expect(Object.isFrozen(summary.risks)).toBe(true);
    expect(Object.isFrozen(summary.dependencies)).toBe(true);
  });
});

function overviewModel(
  overrides: Partial<ViewerOverviewModel> = {},
): ViewerOverviewModel {
  return {
    buildings: [],
    dependencies: [],
    districts: [],
    modules: [],
    repositories: [],
    solutions: [],
    ...overrides,
  };
}

function repository(id: string): CityRepository {
  return { id, name: id };
}

function solution(
  id: string,
  repositoryId: string,
  moduleIds: readonly string[],
): CitySolution {
  return {
    id,
    repositoryId,
    name: id,
    path: `${id}.sln`,
    moduleIds,
  };
}

function module(id: string, repositoryId: string): CityModule {
  return {
    id,
    repositoryId,
    kind: "npm-package",
    name: id,
    path: id,
    solutionIds: [],
  };
}

function district(
  id: string,
  moduleId: string,
  repositoryId: string,
  name: string,
): CityDistrict {
  return {
    id,
    repositoryId,
    moduleId,
    name,
    path: id,
    position: { x: 0, y: 0, z: 0 },
    size: { x: 10, y: 1, z: 10 },
  };
}

function building(
  id: string,
  districtId: string,
  moduleId: string,
  repositoryId: string,
  sloc: number,
  maximumComplexity: number,
  risk: RiskBand,
): CityBuilding {
  return {
    id,
    repositoryId,
    moduleId,
    districtId,
    name: id,
    path: id,
    language: "typescript",
    metrics: {
      sloc,
      decisionLoad: maximumComplexity,
      maximumComplexity,
      executableUnitCount: 1,
    },
    risk,
    semanticGroupId: risk,
    position: { x: 0, y: 1, z: 0 },
    size: { x: 1, y: 2, z: 1 },
  };
}

function dependency(
  id: string,
  sourceId: string,
  weight: number,
  targetId?: string,
): CityDependency {
  return {
    id,
    repositoryId: "repository:a",
    sourceId,
    ...(targetId === undefined
      ? { externalTarget: "external-package" }
      : { targetId }),
    kind: "typescript-import",
    weight,
  };
}
