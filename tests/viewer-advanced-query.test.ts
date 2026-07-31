import { describe, expect, it } from "vitest";
import type {
  CityBuilding,
  CityDependency,
  CityModel,
} from "../packages/core/src/model.js";
import {
  ADVANCED_QUERY_METRIC_SCHEMA_VERSION,
  ADVANCED_QUERY_VERSION,
  createAdvancedQueryPreset,
  evaluateAdvancedQuery,
  validateAdvancedQueryDefinition,
  type AdvancedQueryDefinition,
} from "../apps/viewer/src/advanced-query.js";

describe("viewer advanced queries", () => {
  it("evaluates compound filters deterministically and explains every match", () => {
    const forward = model();
    const reverse = {
      ...forward,
      buildings: forward.buildings.toReversed(),
      dependencies: forward.dependencies.toReversed(),
    };
    const query = definition({
      name: "Risky TypeScript",
      conditions: [
        { kind: "language", values: ["typescript"] },
        { kind: "risk", values: ["high", "very-high"] },
        {
          kind: "metric",
          metric: "maximumComplexity",
          operator: "at-least",
          value: 10,
        },
        {
          kind: "dependency-count",
          direction: "either",
          minimum: 1,
        },
      ],
      sort: {
        key: "maximumComplexity",
        direction: "descending",
      },
    });

    const first = evaluateAdvancedQuery(forward, query);
    const second = evaluateAdvancedQuery(reverse, query);

    expect(first.state).toBe("results");
    expect(first.results.map(({ buildingId }) => buildingId)).toEqual([
      "building:hub",
      "building:client",
    ]);
    expect(second.results).toEqual(first.results);
    expect(first.results[0]?.reasons).toEqual([
      "language is typescript",
      "risk is very-high",
      "maximum complexity is 42",
      "2 either dependencies",
    ]);
  });

  it("provides bounded deterministic built-in rankings and neighborhoods", () => {
    const city = model();

    expect(
      evaluateAdvancedQuery(
        city,
        createAdvancedQueryPreset("highest-complexity"),
      ).results.map(({ buildingId }) => buildingId),
    ).toEqual([
      "building:hub",
      "building:client",
      "building:server",
      "building:quiet",
    ]);
    expect(
      evaluateAdvancedQuery(
        city,
        createAdvancedQueryPreset("dependency-hubs"),
      ).results.map(({ buildingId }) => buildingId),
    ).toEqual([
      "building:client",
      "building:hub",
      "building:server",
    ]);
    expect(
      evaluateAdvancedQuery(
        city,
        createAdvancedQueryPreset("outgoing-neighborhood", {
          selectedBuildingId: "building:client",
        }),
      ).results.map(({ buildingId }) => buildingId),
    ).toEqual(["building:hub", "building:server"]);
    expect(
      evaluateAdvancedQuery(
        city,
        createAdvancedQueryPreset("incoming-neighborhood", {
          selectedBuildingId: "building:hub",
        }),
      ).results.map(({ buildingId }) => buildingId),
    ).toEqual(["building:client", "building:server"]);
  });

  it("uses ordinal text ordering independent of the host locale", () => {
    const city = model();
    const renamed = {
      ...city,
      buildings: city.buildings.slice(0, 2).map((building, index) => ({
        ...building,
        name: index === 0 ? "ä.ts" : "z.ts",
        path: index === 0 ? "src/ä.ts" : "src/z.ts",
      })),
      dependencies: [],
    };
    const sorted = evaluateAdvancedQuery(
      { ...renamed, buildings: renamed.buildings.toReversed() },
      definition({
        sort: { key: "name", direction: "ascending" },
      }),
    );

    expect(sorted.results.map(({ name }) => name)).toEqual([
      "z.ts",
      "ä.ts",
    ]);
  });

  it("reports missing evolution and smell capabilities explicitly", () => {
    const query = definition({
      match: "any",
      conditions: [
        { kind: "changed", changeKinds: ["added", "changed"] },
        { kind: "smell", ruleId: "complexity/high-v1" },
      ],
      capabilities: {
        modelSchemaVersion: "1.0",
        metricSchemaVersion: ADVANCED_QUERY_METRIC_SCHEMA_VERSION,
        ruleSchemaVersion: "codecity.design-smells/1",
      },
    });

    expect(evaluateAdvancedQuery(model(), query)).toMatchObject({
      state: "unavailable",
      totalCount: 0,
      unavailableReasons: [
        "Change data is unavailable for the current model snapshot.",
        'Design-smell rule "complexity/high-v1" is unavailable.',
      ],
    });

    const evaluated = evaluateAdvancedQuery(model(), query, {
      changesByBuildingId: new Map([
        ["building:client", new Set(["changed" as const])],
      ]),
      smellRuleIdsByBuildingId: new Map([
        ["building:quiet", new Set(["complexity/high-v1"])],
      ]),
      availableSmellRuleIdsByBuildingId: new Map([
        ["building:client", new Set(["complexity/high-v1"])],
        ["building:quiet", new Set(["complexity/high-v1"])],
        ["building:server", new Set(["complexity/high-v1"])],
        ["building:hub", new Set(["complexity/high-v1"])],
      ]),
      ruleSchemaVersion: "codecity.design-smells/1",
    });
    expect(evaluated.state).toBe("results");
    expect(evaluated.results.map(({ buildingId }) => buildingId)).toEqual([
      "building:client",
      "building:quiet",
    ]);

    expect(
      evaluateAdvancedQuery(model(), query, {
        smellRuleIdsByBuildingId: new Map([
          ["building:quiet", new Set(["complexity/high-v1"])],
        ]),
        availableSmellRuleIdsByBuildingId: new Map([
          ["building:client", new Set(["complexity/high-v1"])],
          ["building:quiet", new Set(["complexity/high-v1"])],
          ["building:server", new Set(["complexity/high-v1"])],
          ["building:hub", new Set(["complexity/high-v1"])],
        ]),
        ruleSchemaVersion: "codecity.design-smells/2",
      }),
    ).toMatchObject({
      state: "unavailable",
      unavailableReasons: [
        "Change data is unavailable for the current model snapshot.",
        'Design-smell schema "codecity.design-smells/1" is unavailable.',
      ],
    });

    expect(
      evaluateAdvancedQuery(model(), query, {
        smellRuleIdsByBuildingId: new Map(),
        availableSmellRuleIdsByBuildingId: new Map(
          model().buildings.map(({ id }) => [id, new Set<string>()]),
        ),
        ruleSchemaVersion: "codecity.design-smells/1",
      }),
    ).toMatchObject({
      state: "unavailable",
      unavailableReasons: [
        "Change data is unavailable for the current model snapshot.",
        'Design-smell rule "complexity/high-v1" is unavailable.',
      ],
    });
  });

  it("truncates large matches without hiding the total", () => {
    const query = definition({ limit: 2 });
    expect(evaluateAdvancedQuery(model(), query)).toMatchObject({
      state: "results",
      evaluatedBuildingCount: 4,
      totalCount: 4,
      truncated: true,
    });
    expect(evaluateAdvancedQuery(model(), query).results).toHaveLength(2);
  });

  it("validates exact versioned definitions and resource limits", () => {
    expect(
      validateAdvancedQueryDefinition(definition()),
    ).toMatchObject({
      version: ADVANCED_QUERY_VERSION,
      capabilities: {
        modelSchemaVersion: "1.0",
        metricSchemaVersion: ADVANCED_QUERY_METRIC_SCHEMA_VERSION,
      },
    });
    expect(() =>
      validateAdvancedQueryDefinition({
        ...definition(),
        unexpected: true,
      }),
    ).toThrow(/Unexpected query definition field "unexpected"/u);
    expect(() =>
      validateAdvancedQueryDefinition({
        ...definition(),
        version: "codecity.query/2",
      }),
    ).toThrow(/query version/u);
    expect(() =>
      validateAdvancedQueryDefinition({
        ...definition(),
        limit: 501,
      }),
    ).toThrow(/1 through 500/u);
    expect(() =>
      validateAdvancedQueryDefinition(
        definition({
          conditions: [{ kind: "smell", ruleId: "complexity/high-v1" }],
        }),
      ),
    ).toThrow(/rule schema version/u);
  });

  it("requires identities for contextual built-in queries", () => {
    expect(() =>
      createAdvancedQueryPreset("incoming-neighborhood"),
    ).toThrow(/selected building/u);
    expect(() =>
      createAdvancedQueryPreset("selected-district"),
    ).toThrow(/selected district/u);
  });
});

function definition(
  overrides: Partial<AdvancedQueryDefinition> = {},
): AdvancedQueryDefinition {
  return {
    version: ADVANCED_QUERY_VERSION,
    id: "query:test",
    name: "Test query",
    match: "all",
    conditions: [],
    sort: { key: "path", direction: "ascending" },
    limit: 50,
    capabilities: {
      modelSchemaVersion: "1.0",
      metricSchemaVersion: ADVANCED_QUERY_METRIC_SCHEMA_VERSION,
    },
    ...overrides,
  };
}

function model(): CityModel {
  const buildings = [
    building({
      id: "building:client",
      name: "client.ts",
      path: "src/client.ts",
      risk: "high",
      complexity: 12,
    }),
    building({
      id: "building:hub",
      name: "hub.ts",
      path: "src/hub.ts",
      risk: "very-high",
      complexity: 42,
    }),
    building({
      id: "building:server",
      name: "server.cs",
      path: "src/server.cs",
      language: "csharp",
      risk: "moderate",
      complexity: 8,
    }),
    building({
      id: "building:quiet",
      name: "quiet.ts",
      path: "src/quiet.ts",
      risk: "low",
      complexity: 1,
    }),
  ];
  const dependencies: CityDependency[] = [
    dependency("client-hub", "building:client", "building:hub"),
    dependency("client-server", "building:client", "building:server"),
    dependency("server-hub", "building:server", "building:hub"),
  ];
  return {
    schemaVersion: "1.0",
    generator: { name: "code-city", version: "test" },
    repositories: [{ id: "repository:test", name: "Test" }],
    solutions: [],
    modules: [
      {
        id: "module:test",
        repositoryId: "repository:test",
        kind: "npm-package",
        name: "Test",
        path: ".",
        solutionIds: [],
      },
    ],
    semanticGroups: [],
    districts: [
      {
        id: "district:test",
        repositoryId: "repository:test",
        moduleId: "module:test",
        name: "src",
        path: "src",
        position: { x: 0, y: 0, z: 0 },
        size: { x: 10, y: 1, z: 10 },
      },
    ],
    buildings,
    dependencies,
    bounds: { x: 10, y: 10, z: 10 },
  };
}

function building(
  options: {
    readonly id: string;
    readonly name: string;
    readonly path: string;
    readonly language?: "csharp" | "typescript";
    readonly risk: "low" | "moderate" | "high" | "very-high";
    readonly complexity: number;
  },
): CityBuilding {
  return {
    id: options.id,
    repositoryId: "repository:test",
    moduleId: "module:test",
    districtId: "district:test",
    name: options.name,
    path: options.path,
    language: options.language ?? "typescript",
    metrics: {
      sloc: options.complexity * 10,
      decisionLoad: options.complexity,
      maximumComplexity: options.complexity,
      executableUnitCount: 1,
    },
    risk: options.risk,
    semanticGroupId: "source",
    position: { x: 0, y: 1, z: 0 },
    size: { x: 1, y: 2, z: 1 },
  };
}

function dependency(
  id: string,
  sourceId: string,
  targetId: string,
): CityDependency {
  return {
    id: `dependency:${id}`,
    repositoryId: "repository:test",
    sourceId,
    targetId,
    resolution: "internal",
    kind: "typescript-import",
    weight: 1,
  };
}
