import { describe, expect, it } from "vitest";

import {
  clearExplorerSelection,
  createRepositoryExplorerIndex,
  DEFAULT_REPOSITORY_EXPLORER_RESULT_LIMIT,
  INITIAL_EXPLORER_STATE,
  isolateSelectedDistrict,
  MAXIMUM_REPOSITORY_EXPLORER_RESULT_LIMIT,
  resetExplorerState,
  searchRepositoryBuildings,
  selectExplorerBuilding,
  showAllDistricts,
} from "../apps/viewer/src/repository-explorer.js";
import type {
  CityBuilding,
  CityModel,
  CityModule,
} from "../packages/core/src/model.js";

describe("viewer repository explorer", () => {
  it("represents an empty query without returning every building", () => {
    const index = createRepositoryExplorerIndex(
      modelWith(building()),
    );
    const result = searchRepositoryBuildings(index, "  ");

    expect(result).toEqual({
      state: "empty-query",
      query: "",
      totalCount: 0,
      results: [],
    });
  });

  it("represents a non-empty query with no matches", () => {
    const index = createRepositoryExplorerIndex(
      modelWith(building()),
    );
    const result = searchRepositoryBuildings(
      index,
      "missing.ts",
    );

    expect(result).toEqual({
      state: "no-matches",
      query: "missing.ts",
      totalCount: 0,
      results: [],
    });
  });

  it("matches file names and paths without regard to case", () => {
    const model = modelWith(
      building({
        id: "controller",
        name: "HealthController.cs",
        path: "Flow.Hub.Api/Controllers/HealthController.cs",
        maximumComplexity: 12,
      }),
      building({
        id: "service",
        name: "health.service.ts",
        path: "flow.hub.web/src/app/health.service.ts",
      }),
    );
    const index = createRepositoryExplorerIndex(model);

    const byName = searchRepositoryBuildings(
      index,
      "HEALTHCONTROLLER.CS",
    );
    const byPath = searchRepositoryBuildings(
      index,
      "HUB.WEB/SRC/APP/HEALTH",
    );

    expect(byName.results.map(({ buildingId }) => buildingId)).toEqual([
      "controller",
    ]);
    expect(byName.results[0]).toMatchObject({
      moduleId: "module-a",
      moduleName: "FLOW.Hub.Web",
      maximumComplexity: 12,
    });
    expect(byPath.results.map(({ buildingId }) => buildingId)).toEqual([
      "service",
    ]);
  });

  it("normalizes Windows separators in both paths and queries", () => {
    const model = modelWith(
      building({
        id: "windows",
        name: "ReportService.ts",
        path: String.raw`FLOW.Hub.Web\ClientApp\src\ReportService.ts`,
      }),
    );
    const index = createRepositoryExplorerIndex(model);

    const result = searchRepositoryBuildings(
      index,
      String.raw`.\clientapp\src\reportservice.ts`,
    );

    expect(result.state).toBe("results");
    expect(result.query).toBe("clientapp/src/reportservice.ts");
    expect(result.results[0]?.path).toBe(
      "FLOW.Hub.Web/ClientApp/src/ReportService.ts",
    );
  });

  it("ranks exact and filename matches ahead of broader path matches", () => {
    const model = modelWith(
      building({
        id: "path-contains",
        name: "index.ts",
        path: "src/my-widget-code/index.ts",
      }),
      building({
        id: "name-contains",
        name: "prewidget.ts",
        path: "src/prewidget.ts",
      }),
      building({
        id: "segment-prefix",
        name: "index.ts",
        path: "src/widgets/index.ts",
      }),
      building({
        id: "name-boundary",
        name: "test-widget.ts",
        path: "src/test-widget.ts",
      }),
      building({
        id: "name-prefix",
        name: "widget-panel.ts",
        path: "src/widget-panel.ts",
      }),
      building({
        id: "segment-exact",
        name: "index.ts",
        path: "src/widget/index.ts",
      }),
      building({
        id: "name-exact",
        name: "widget",
        path: "src/deep/widget",
      }),
      building({
        id: "path-exact",
        name: "widget",
        path: "widget",
      }),
    );
    const index = createRepositoryExplorerIndex(model);

    const result = searchRepositoryBuildings(index, "widget");

    expect(result.results.map(({ buildingId }) => buildingId)).toEqual([
      "path-exact",
      "name-exact",
      "name-prefix",
      "name-boundary",
      "name-contains",
      "segment-exact",
      "segment-prefix",
      "path-contains",
    ]);
  });

  it("uses stable tie breakers independent of model order", () => {
    const tied = [
      building({
        id: "z-id",
        name: "Match.ts",
        path: "same/Match.ts",
      }),
      building({
        id: "a-id",
        name: "match.ts",
        path: "same/match.ts",
      }),
      building({
        id: "short",
        name: "matcher.ts",
        path: "src/matcher.ts",
      }),
      building({
        id: "long",
        name: "matcher-extra.ts",
        path: "src/matcher-extra.ts",
      }),
    ] as const;

    const forward = searchRepositoryBuildings(
      createRepositoryExplorerIndex(modelWith(...tied)),
      "match",
    );
    const reversed = searchRepositoryBuildings(
      createRepositoryExplorerIndex(modelWith(...tied.toReversed())),
      "match",
    );

    expect(forward.results.map(({ buildingId }) => buildingId)).toEqual([
      "a-id",
      "z-id",
      "short",
      "long",
    ]);
    expect(reversed.results).toEqual(forward.results);
  });

  it("caps visible results while retaining the total match count", () => {
    const buildings = Array.from({ length: 27 }, (_, index) =>
      building({
        id: `match-${index.toString().padStart(2, "0")}`,
        name: `match-${index.toString().padStart(2, "0")}.ts`,
        path: `src/match-${index.toString().padStart(2, "0")}.ts`,
      }),
    );
    const index = createRepositoryExplorerIndex(modelWith(...buildings));

    const defaultResult = searchRepositoryBuildings(
      index,
      "match",
    );
    const smallerResult = searchRepositoryBuildings(
      index,
      "match",
      { limit: 5 },
    );

    expect(defaultResult.totalCount).toBe(27);
    expect(defaultResult.results).toHaveLength(
      DEFAULT_REPOSITORY_EXPLORER_RESULT_LIMIT,
    );
    expect(smallerResult.totalCount).toBe(27);
    expect(smallerResult.results).toHaveLength(5);
  });

  it("clamps invalid and excessive result limits to a safe range", () => {
    const buildings = Array.from(
      { length: MAXIMUM_REPOSITORY_EXPLORER_RESULT_LIMIT + 5 },
      (_, index) =>
        building({
          id: `match-${index.toString().padStart(3, "0")}`,
          name: `match-${index.toString().padStart(3, "0")}.ts`,
          path: `src/match-${index.toString().padStart(3, "0")}.ts`,
        }),
    );
    const index = createRepositoryExplorerIndex(modelWith(...buildings));

    expect(
      searchRepositoryBuildings(index, "match", { limit: 0 }).results,
    ).toHaveLength(1);
    expect(
      searchRepositoryBuildings(index, "match", {
        limit: Number.POSITIVE_INFINITY,
      }).results,
    ).toHaveLength(DEFAULT_REPOSITORY_EXPLORER_RESULT_LIMIT);
    expect(
      searchRepositoryBuildings(index, "match", {
        limit: 10_000,
      }).results,
    ).toHaveLength(MAXIMUM_REPOSITORY_EXPLORER_RESULT_LIMIT);
  });

  it("keeps a reusable snapshot independent of later model changes", () => {
    const model = modelWith(
      building({
        id: "original",
        name: "Original.ts",
        path: String.raw`src\Original.ts`,
        maximumComplexity: 17,
      }),
    );
    const index = createRepositoryExplorerIndex(model);

    (model.buildings as CityBuilding[]).splice(
      0,
      1,
      building({
        id: "replacement",
        name: "Replacement.ts",
        path: "src/Replacement.ts",
      }),
    );
    const originalModule = model.modules[0];
    if (!originalModule) {
      throw new Error("Fixture module is missing");
    }
    (model.modules as CityModule[]).splice(0, 1, {
      ...originalModule,
      name: "Changed module",
    });

    expect(index.buildingCount).toBe(1);
    expect(searchRepositoryBuildings(index, "replacement").state).toBe(
      "no-matches",
    );
    expect(searchRepositoryBuildings(index, "original").results[0]).toEqual({
      buildingId: "original",
      moduleId: "module-a",
      moduleName: "FLOW.Hub.Web",
      name: "Original.ts",
      path: "src/Original.ts",
      maximumComplexity: 17,
    });
  });

  it("counts 25,000 matches while retaining only the best bounded results", () => {
    const buildingCount = 25_000;
    const buildings = Array.from({ length: buildingCount }, (_, offset) => {
      const index = buildingCount - offset - 1;
      const suffix = index.toString().padStart(5, "0");
      return building({
        id: `match-${suffix}`,
        name: `match-${suffix}.ts`,
        path: `src/match-${suffix}.ts`,
      });
    });
    const index = createRepositoryExplorerIndex(modelFrom(buildings));

    const result = searchRepositoryBuildings(index, "match", { limit: 7 });

    expect(result.state).toBe("results");
    expect(result.totalCount).toBe(buildingCount);
    expect(result.results).toHaveLength(7);
    expect(result.results.map(({ buildingId }) => buildingId)).toEqual([
      "match-00000",
      "match-00001",
      "match-00002",
      "match-00003",
      "match-00004",
      "match-00005",
      "match-00006",
    ]);
  });
});

describe("viewer repository explorer state", () => {
  const model = modelWith(
    building({ id: "district-a-building", districtId: "district-a" }),
    building({ id: "district-b-building", districtId: "district-b" }),
  );

  it("starts and resets with the whole city visible and no selection", () => {
    expect(INITIAL_EXPLORER_STATE).toEqual({
      selectedBuildingId: null,
      isolatedDistrictId: null,
    });
    expect(
      resetExplorerState(),
    ).toBe(INITIAL_EXPLORER_STATE);
  });

  it("selects only a building that belongs to the model", () => {
    const selected = selectExplorerBuilding(
      INITIAL_EXPLORER_STATE,
      model,
      "district-a-building",
    );

    expect(selected).toEqual({
      selectedBuildingId: "district-a-building",
      isolatedDistrictId: null,
    });
    expect(
      selectExplorerBuilding(selected, model, "stale-building"),
    ).toBe(selected);
  });

  it("isolates the selected building's district", () => {
    const selected = selectExplorerBuilding(
      INITIAL_EXPLORER_STATE,
      model,
      "district-a-building",
    );

    expect(isolateSelectedDistrict(selected, model)).toEqual({
      selectedBuildingId: "district-a-building",
      isolatedDistrictId: "district-a",
    });
    expect(
      isolateSelectedDistrict(INITIAL_EXPLORER_STATE, model),
    ).toBe(INITIAL_EXPLORER_STATE);
  });

  it("clears selection without changing an active isolation", () => {
    const isolated = {
      selectedBuildingId: "district-a-building",
      isolatedDistrictId: "district-a",
    };

    expect(clearExplorerSelection(isolated)).toEqual({
      selectedBuildingId: null,
      isolatedDistrictId: "district-a",
    });
  });

  it("moves active isolation when selecting another district", () => {
    const isolated = {
      selectedBuildingId: "district-a-building",
      isolatedDistrictId: "district-a",
    };

    expect(
      selectExplorerBuilding(isolated, model, "district-b-building"),
    ).toEqual({
      selectedBuildingId: "district-b-building",
      isolatedDistrictId: "district-b",
    });
  });

  it("shows all districts without clearing the selection", () => {
    const isolated = {
      selectedBuildingId: "district-a-building",
      isolatedDistrictId: "district-a",
    };

    expect(showAllDistricts(isolated)).toEqual({
      selectedBuildingId: "district-a-building",
      isolatedDistrictId: null,
    });
  });
});

function modelWith(...buildings: readonly CityBuilding[]): CityModel {
  return modelFrom(buildings);
}

function modelFrom(buildings: readonly CityBuilding[]): CityModel {
  return {
    schemaVersion: "1.0",
    generator: { name: "code-city", version: "test" },
    repositories: [{ id: "repository-a", name: "FLOW.Hub" }],
    solutions: [],
    modules: [
      {
        id: "module-a",
        repositoryId: "repository-a",
        kind: "dotnet-project",
        name: "FLOW.Hub.Web",
        path: "FLOW.Hub.Web",
        solutionIds: [],
      },
    ],
    semanticGroups: [],
    districts: [],
    buildings,
    dependencies: [],
    bounds: { x: 1, y: 1, z: 1 },
  };
}

function building(
  overrides: {
    readonly id?: string;
    readonly name?: string;
    readonly path?: string;
    readonly districtId?: string;
    readonly maximumComplexity?: number;
  } = {},
): CityBuilding {
  return {
    id: overrides.id ?? "building-a",
    repositoryId: "repository-a",
    moduleId: "module-a",
    districtId: overrides.districtId ?? "district-a",
    name: overrides.name ?? "Example.ts",
    path: overrides.path ?? "src/Example.ts",
    language: "typescript",
    metrics: {
      sloc: 1,
      decisionLoad: 1,
      maximumComplexity: overrides.maximumComplexity ?? 1,
      executableUnitCount: 1,
    },
    risk: "low",
    semanticGroupId: "low-risk",
    position: { x: 0, y: 0, z: 0 },
    size: { x: 1, y: 1, z: 1 },
  };
}
