import { describe, expect, it } from "vitest";

import {
  createDependencyExplorerIndex,
  DEPENDENCY_ROUTES_PER_DIRECTION,
  dependencyRoutesForBuilding,
  dependencyRoutesForBuildings,
  INITIAL_DEPENDENCY_ROUTE_STATE,
  MAXIMUM_MULTI_SELECTION_DEPENDENCY_ROUTES,
  projectDependencyRoute,
  resetDependencyRouteState,
  toggleDependencyRouteDirection,
} from "../apps/viewer/src/dependency-explorer.js";
import { createLargeCityFixture } from "../apps/viewer/src/large-city-fixture.js";
import type {
  CityBuilding,
  CityDependency,
  CityDistrict,
  CityModel,
} from "../packages/core/src/model.js";

describe("dependency explorer index", () => {
  it("indexes only file-level TypeScript imports with consumer direction", () => {
    const model = fixtureModel({
      dependencies: [
        internalDependency("a-to-b", "building-a", "building-b", 2),
        internalDependency("c-to-a", "building-c", "building-a", 3),
        externalDependency("a-to-rxjs", "building-a", "rxjs", 4),
        {
          id: "module-reference",
          repositoryId: "repository",
          sourceId: "module-a",
          targetId: "module-b",
          kind: "project-reference",
          weight: 99,
        },
      ],
    });
    const index = createDependencyExplorerIndex(model);

    const summary = dependencyRoutesForBuilding(index, "building-a");

    expect(index.dependencyCount).toBe(3);
    expect(summary?.outgoing).toMatchObject({
      totalCount: 2,
      visibleCount: 2,
      hiddenCount: 0,
      totalWeight: 6,
    });
    expect(
      summary?.outgoing.routes.map((route) => [
        route.dependencyId,
        route.direction,
        route.counterpart,
      ]),
    ).toEqual([
      [
        "a-to-rxjs",
        "outgoing",
        { kind: "external", target: "rxjs" },
      ],
      [
        "a-to-b",
        "outgoing",
        {
          kind: "building",
          buildingId: "building-b",
          districtId: "district-a",
          name: "Beta.ts",
          path: "src/Beta.ts",
        },
      ],
    ]);
    expect(summary?.incoming.routes).toEqual([
      expect.objectContaining({
        dependencyId: "c-to-a",
        direction: "incoming",
        sourceBuildingId: "building-c",
        targetBuildingId: "building-a",
        counterpart: expect.objectContaining({
          buildingId: "building-c",
        }),
      }),
    ]);
  });

  it("normalizes external aliases before route indexing and projection", () => {
    const dependencies = [
      externalDependency(
        "a-to-decomposed",
        "building-a",
        "  Cafe\u0301  ",
        2,
      ),
      externalDependency(
        "a-to-composed",
        "building-a",
        "Caf\u00e9",
        3,
      ),
    ];
    const forward = createDependencyExplorerIndex(
      fixtureModel({ dependencies }),
    );
    const reversed = createDependencyExplorerIndex(
      fixtureModel({ dependencies: dependencies.toReversed() }),
    );

    const routes = dependencyRoutesForBuilding(
      forward,
      "building-a",
    )!.outgoing.routes;
    const reversedRoutes = dependencyRoutesForBuilding(
      reversed,
      "building-a",
    )!.outgoing.routes;

    expect(
      routes.map((route) => {
        if (
          route.counterpart.kind !== "external" ||
          !("externalTarget" in route)
        ) {
          throw new TypeError("Expected external dependency routes.");
        }
        return {
          externalTarget: route.externalTarget,
          counterpart: route.counterpart,
        };
      }),
    ).toEqual([
      {
        externalTarget: "Caf\u00e9",
        counterpart: { kind: "external", target: "Caf\u00e9" },
      },
      {
        externalTarget: "Caf\u00e9",
        counterpart: { kind: "external", target: "Caf\u00e9" },
      },
    ]);
    expect(reversedRoutes).toEqual(routes);
    expect(
      projectDependencyRoute(
        forward,
        "building-a",
        routes[0]!,
      ).target,
    ).toEqual({ kind: "external", target: "Caf\u00e9" });
  });

  it("returns empty directions for a known disconnected building", () => {
    const index = createDependencyExplorerIndex(fixtureModel());

    expect(dependencyRoutesForBuilding(index, "building-a")).toEqual({
      buildingId: "building-a",
      incoming: {
        direction: "incoming",
        totalCount: 0,
        visibleCount: 0,
        hiddenCount: 0,
        totalWeight: 0,
        visibleWeight: 0,
        hiddenWeight: 0,
        routes: [],
      },
      outgoing: {
        direction: "outgoing",
        totalCount: 0,
        visibleCount: 0,
        hiddenCount: 0,
        totalWeight: 0,
        visibleWeight: 0,
        hiddenWeight: 0,
        routes: [],
      },
    });
    expect(
      dependencyRoutesForBuilding(index, "missing-building"),
    ).toBeNull();
  });

  it("ranks by weight, counterpart path/name, and stable identity", () => {
    const model = fixtureModel({
      buildings: [
        fixtureBuilding(),
        fixtureBuilding({
          id: "z-id",
          name: "Same.ts",
          path: "src/A.ts",
        }),
        fixtureBuilding({
          id: "a-id",
          name: "Same.ts",
          path: "src/A.ts",
        }),
        fixtureBuilding({
          id: "path-first",
          name: "Zulu.ts",
          path: "src/0.ts",
        }),
        fixtureBuilding({
          id: "heavy",
          name: "Heavy.ts",
          path: "src/Z.ts",
        }),
      ],
      dependencies: [
        internalDependency("to-z", "building-a", "z-id", 2),
        internalDependency("to-a", "building-a", "a-id", 2),
        internalDependency("to-path", "building-a", "path-first", 2),
        internalDependency("to-heavy", "building-a", "heavy", 9),
      ],
    });
    const index = createDependencyExplorerIndex(model);

    expect(
      dependencyRoutesForBuilding(
        index,
        "building-a",
      )?.outgoing.routes.map(({ dependencyId }) => dependencyId),
    ).toEqual(["to-heavy", "to-path", "to-a", "to-z"]);
  });

  it("caps each direction and reports exact counts and weights", () => {
    const routeCount = DEPENDENCY_ROUTES_PER_DIRECTION + 5;
    const targets = Array.from({ length: routeCount }, (_, offset) => {
      const index = routeCount - offset - 1;
      const suffix = index.toString().padStart(2, "0");
      return fixtureBuilding({
        id: `target-${suffix}`,
        name: `Target${suffix}.ts`,
        path: `src/Target${suffix}.ts`,
      });
    });
    const dependencies = targets.flatMap((target, index) => [
      internalDependency(
        `outgoing-${target.id}`,
        "building-a",
        target.id,
        index + 1,
      ),
      internalDependency(
        `incoming-${target.id}`,
        target.id,
        "building-a",
        index + 1,
      ),
    ]);
    const forward = createDependencyExplorerIndex(
      fixtureModel({
        buildings: [fixtureBuilding(), ...targets],
        dependencies,
      }),
    );
    const reversed = createDependencyExplorerIndex(
      fixtureModel({
        buildings: [fixtureBuilding(), ...targets.toReversed()],
        dependencies: dependencies.toReversed(),
      }),
    );

    const result = dependencyRoutesForBuilding(
      forward,
      "building-a",
    )!.outgoing;
    const reversedResult = dependencyRoutesForBuilding(
      reversed,
      "building-a",
    )!.outgoing;
    const incomingResult = dependencyRoutesForBuilding(
      forward,
      "building-a",
    )!.incoming;

    expect(result).toMatchObject({
      totalCount: routeCount,
      visibleCount: DEPENDENCY_ROUTES_PER_DIRECTION,
      hiddenCount: 5,
      totalWeight: 325,
      visibleWeight: 310,
      hiddenWeight: 15,
    });
    expect(result.routes.map(({ weight }) => weight)).toEqual(
      Array.from(
        { length: DEPENDENCY_ROUTES_PER_DIRECTION },
        (_, index) => routeCount - index,
      ),
    );
    expect(reversedResult).toEqual(result);
    expect(incomingResult).toMatchObject({
      totalCount: routeCount,
      visibleCount: DEPENDENCY_ROUTES_PER_DIRECTION,
      hiddenCount: 5,
      totalWeight: 325,
      visibleWeight: 310,
      hiddenWeight: 15,
    });
    expect(incomingResult.routes.map(({ weight }) => weight)).toEqual(
      result.routes.map(({ weight }) => weight),
    );
  });

  it("combines routes from selected endpoints across districts without duplicates", () => {
    const index = routeProjectionIndex();

    const summary = dependencyRoutesForBuildings(index, [
      "building-a",
      "missing",
      "building-c",
      "building-a",
    ]);

    expect(summary).toMatchObject({
      totalCount: 4,
      truncated: false,
    });
    expect(
      summary.routes.map(({ selectedBuildingId, route }) => [
        route.dependencyId,
        selectedBuildingId,
        route.direction,
      ]),
    ).toEqual([
      ["a-to-rxjs", "building-a", "outgoing"],
      ["a-to-c", "building-a", "outgoing"],
      ["c-to-a", "building-c", "outgoing"],
      ["a-to-b", "building-a", "outgoing"],
    ]);
  });

  it("enforces one global bound for multi-selection routes", () => {
    const dependencies = Array.from(
      { length: MAXIMUM_MULTI_SELECTION_DEPENDENCY_ROUTES + 5 },
      (_, index) =>
        externalDependency(
          `external-${index.toString().padStart(3, "0")}`,
          "building-a",
          `package-${index.toString().padStart(3, "0")}`,
          index + 1,
        ),
    );
    const index = createDependencyExplorerIndex(
      fixtureModel({ dependencies }),
    );

    const summary = dependencyRoutesForBuildings(
      index,
      ["building-a"],
      { incoming: true, outgoing: true },
      10_000,
    );

    expect(summary.routes).toHaveLength(
      MAXIMUM_MULTI_SELECTION_DEPENDENCY_ROUTES,
    );
    expect(summary.totalCount).toBe(
      MAXIMUM_MULTI_SELECTION_DEPENDENCY_ROUTES + 5,
    );
    expect(summary.truncated).toBe(true);
    expect(() =>
      dependencyRoutesForBuildings(index, ["building-a"], undefined, 0),
    ).toThrow(/positive safe integer/u);
  });

  it("stays deduplicated and globally bounded on the 25k fixture", () => {
    const fixture = createLargeCityFixture();
    const dependencyCount =
      MAXIMUM_MULTI_SELECTION_DEPENDENCY_ROUTES + 40;
    const dependencies = Array.from(
      { length: dependencyCount },
      (_, index) =>
        internalDependency(
          `large-route-${index.toString().padStart(3, "0")}`,
          `building:${index.toString().padStart(5, "0")}`,
          "building:24999",
          index + 1,
        ),
    );
    const index = createDependencyExplorerIndex({
      ...fixture,
      dependencies,
    });
    const selected = [
      ...dependencies.map(({ sourceId }) => sourceId),
      "building:24999",
    ];

    const summary = dependencyRoutesForBuildings(index, selected);

    expect(index.buildingCount).toBe(25_000);
    expect(summary.totalCount).toBe(dependencyCount);
    expect(summary.routes).toHaveLength(
      MAXIMUM_MULTI_SELECTION_DEPENDENCY_ROUTES,
    );
    expect(summary.truncated).toBe(true);
    expect(
      new Set(
        summary.routes.map(({ route }) => route.dependencyId),
      ).size,
    ).toBe(summary.routes.length);
  });

  it("is an immutable snapshot of model presentation data", () => {
    const model = fixtureModel({
      dependencies: [
        internalDependency("a-to-b", "building-a", "building-b", 2),
      ],
    });
    const index = createDependencyExplorerIndex(model);

    (model.buildings as CityBuilding[]).splice(
      1,
      1,
      fixtureBuilding({
        id: "replacement",
        name: "Replacement.ts",
        path: "src/Replacement.ts",
      }),
    );
    (model.dependencies as CityDependency[]).splice(0);

    const summary = dependencyRoutesForBuilding(index, "building-a");
    expect(Object.isFrozen(index)).toBe(true);
    expect(Object.isFrozen(summary?.outgoing.routes)).toBe(true);
    expect(summary?.outgoing.routes[0]?.counterpart).toEqual({
      kind: "building",
      buildingId: "building-b",
      districtId: "district-a",
      name: "Beta.ts",
      path: "src/Beta.ts",
    });
  });

  it("rejects malformed TypeScript endpoints instead of leaking them", () => {
    expect(() =>
      createDependencyExplorerIndex(
        fixtureModel({
          dependencies: [
            internalDependency(
              "missing-target",
              "building-a",
              "missing",
              1,
            ),
          ],
        }),
      ),
    ).toThrow(/unknown target/u);
    expect(() =>
      createDependencyExplorerIndex(
        fixtureModel({
          dependencies: [
            {
              ...externalDependency(
                "ambiguous",
                "building-a",
                "rxjs",
                1,
              ),
              targetId: "building-b",
            },
          ],
        }),
      ),
    ).toThrow(/exactly one target/u);
    expect(() =>
      createDependencyExplorerIndex(
        fixtureModel({
          dependencies: [
            externalDependency(
              "blank-external",
              "building-a",
              "   ",
              1,
            ),
          ],
        }),
      ),
    ).toThrow(/external dependency target must not be empty/iu);
  });
});

describe("dependency route state", () => {
  it("starts hidden, toggles independently, and resets", () => {
    const incoming = toggleDependencyRouteDirection(
      INITIAL_DEPENDENCY_ROUTE_STATE,
      "incoming",
    );
    const both = toggleDependencyRouteDirection(incoming, "outgoing");
    const outgoingOnly = toggleDependencyRouteDirection(both, "incoming");

    expect(INITIAL_DEPENDENCY_ROUTE_STATE).toEqual({
      incoming: false,
      outgoing: false,
    });
    expect(incoming).toEqual({ incoming: true, outgoing: false });
    expect(both).toEqual({ incoming: true, outgoing: true });
    expect(outgoingOnly).toEqual({ incoming: false, outgoing: true });
    expect(resetDependencyRouteState()).toBe(
      INITIAL_DEPENDENCY_ROUTE_STATE,
    );
  });
});

describe("dependency route projection", () => {
  it("keeps internal endpoints as exact buildings across districts", () => {
    const index = routeProjectionIndex();
    const route = dependencyRoutesForBuilding(
      index,
      "building-a",
    )!.outgoing.routes.find(
      ({ dependencyId }) => dependencyId === "a-to-c",
    )!;

    expect(
      projectDependencyRoute(index, "building-a", route),
    ).toEqual({
      dependencyId: "a-to-c",
      direction: "outgoing",
      source: { kind: "building", buildingId: "building-a" },
      target: { kind: "building", buildingId: "building-c" },
    });
  });

  it("keeps external providers as external endpoints", () => {
    const index = routeProjectionIndex();
    const route = dependencyRoutesForBuilding(
      index,
      "building-a",
    )!.outgoing.routes.find(
      ({ dependencyId }) => dependencyId === "a-to-rxjs",
    )!;

    const projection = projectDependencyRoute(
      index,
      "building-a",
      route,
    );

    expect(projection.source).toEqual({
      kind: "building",
      buildingId: "building-a",
    });
    expect(projection.target).toEqual({
      kind: "external",
      target: "rxjs",
    });
  });
});

function routeProjectionIndex() {
  return createDependencyExplorerIndex(
    fixtureModel({
      dependencies: [
        internalDependency("a-to-b", "building-a", "building-b", 1),
        internalDependency("a-to-c", "building-a", "building-c", 3),
        internalDependency("c-to-a", "building-c", "building-a", 2),
        externalDependency("a-to-rxjs", "building-a", "rxjs", 4),
      ],
    }),
  );
}

function fixtureModel(
  overrides: {
    readonly buildings?: readonly CityBuilding[];
    readonly dependencies?: readonly CityDependency[];
    readonly districts?: readonly CityDistrict[];
  } = {},
): CityModel {
  return {
    schemaVersion: "1.0",
    generator: { name: "code-city", version: "test" },
    repositories: [{ id: "repository", name: "Repository" }],
    solutions: [],
    modules: [
      module("module-a", "Module A"),
      module("module-b", "Module B"),
    ],
    semanticGroups: [],
    districts: overrides.districts ?? [
      district("district-a", "module-a", 0, 0, 10, 8),
      district("district-b", "module-b", 20, 10, 10, 8),
    ],
    buildings: overrides.buildings ?? [
      fixtureBuilding(),
      fixtureBuilding({
        id: "building-b",
        name: "Beta.ts",
        path: String.raw`src\Beta.ts`,
        position: { x: 2, y: 2, z: 1 },
      }),
      fixtureBuilding({
        id: "building-c",
        districtId: "district-b",
        moduleId: "module-b",
        name: "Gamma.ts",
        path: "src/Gamma.ts",
        position: { x: 20, y: 2, z: 10 },
      }),
    ],
    dependencies: overrides.dependencies ?? [],
    bounds: { x: 30, y: 5, z: 20 },
  };
}

function module(id: string, name: string) {
  return {
    id,
    repositoryId: "repository",
    kind: "angular-project" as const,
    name,
    path: name,
    solutionIds: [],
  };
}

function district(
  id: string,
  moduleId: string,
  x: number,
  z: number,
  width: number,
  depth: number,
): CityDistrict {
  return {
    id,
    repositoryId: "repository",
    moduleId,
    name: id,
    path: id,
    position: { x, y: 0.5, z },
    size: { x: width, y: 1, z: depth },
  };
}

function fixtureBuilding(
  overrides: {
    readonly id?: string;
    readonly districtId?: string;
    readonly moduleId?: string;
    readonly name?: string;
    readonly path?: string;
    readonly position?: { readonly x: number; readonly y: number; readonly z: number };
  } = {},
): CityBuilding {
  return {
    id: overrides.id ?? "building-a",
    repositoryId: "repository",
    moduleId: overrides.moduleId ?? "module-a",
    districtId: overrides.districtId ?? "district-a",
    name: overrides.name ?? "Alpha.ts",
    path: overrides.path ?? "src/Alpha.ts",
    language: "typescript",
    metrics: {
      sloc: 1,
      decisionLoad: 1,
      maximumComplexity: 1,
      executableUnitCount: 1,
    },
    risk: "low",
    semanticGroupId: "low-risk",
    position: overrides.position ?? { x: 0, y: 2, z: 0 },
    size: { x: 1, y: 3, z: 1 },
  };
}

function internalDependency(
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

function externalDependency(
  id: string,
  sourceId: string,
  externalTarget: string,
  weight: number,
): CityDependency {
  return {
    id,
    repositoryId: "repository",
    sourceId,
    externalTarget,
    kind: "typescript-import",
    weight,
  };
}
