import { describe, expect, it } from "vitest";
import type { CityModel } from "../packages/core/src/model.js";
import {
  AdvancedQueryStore,
  advancedQueryStorageKey,
} from "../apps/viewer/src/advanced-query-storage.js";
import {
  ADVANCED_QUERY_METRIC_SCHEMA_VERSION,
  ADVANCED_QUERY_VERSION,
  type AdvancedQueryDefinition,
} from "../apps/viewer/src/advanced-query.js";
import { createAdvancedSelectionSet } from "../apps/viewer/src/advanced-selection.js";

describe("viewer advanced query storage", () => {
  it("stores versioned queries and selection sets per project", () => {
    const storage = memoryStorage();
    const store = new AdvancedQueryStore(storage);
    const city = model("project-a");

    expect(store.saveQuery(city, "Hubs", query())).toMatchObject({
      ok: true,
    });
    expect(
      store.saveSelectionSet(
        city,
        createAdvancedSelectionSet("Review", ["a", "b"]),
      ),
    ).toMatchObject({ ok: true });

    expect(store.load(city)).toEqual({
      queries: [{ name: "Hubs", definition: query() }],
      selectionSets: [
        {
          version: "codecity.selection-set/1",
          name: "Review",
          modelSchemaVersion: "1.0",
          buildingIds: ["a", "b"],
        },
      ],
    });
    expect(store.load(model("project-b"))).toEqual({
      queries: [],
      selectionSets: [],
    });
  });

  it("replaces names case-insensitively and deletes saved items", () => {
    const storage = memoryStorage();
    const store = new AdvancedQueryStore(storage);
    const city = model("project-a");
    store.saveQuery(city, "Hubs", query());
    store.saveQuery(city, "hubs", {
      ...query(),
      name: "Replacement",
      limit: 10,
    });
    expect(store.load(city).queries).toEqual([
      {
        name: "hubs",
        definition: {
          ...query(),
          name: "Replacement",
          limit: 10,
        },
      },
    ]);
    expect(store.delete(city, "query", "HUBS")).toMatchObject({
      ok: true,
    });
    expect(storage.getItem(advancedQueryStorageKey(city))).toBeNull();
  });

  it("ignores malformed or cross-project documents wholesale", () => {
    const storage = memoryStorage();
    const city = model("project-a");
    storage.setItem(
      advancedQueryStorageKey(city),
      JSON.stringify({
        version: 1,
        projectIdentity: "different-project",
        queries: [],
        selectionSets: [],
      }),
    );
    expect(new AdvancedQueryStore(storage).load(city)).toEqual({
      queries: [],
      selectionSets: [],
    });
  });
});

function query(): AdvancedQueryDefinition {
  return {
    version: ADVANCED_QUERY_VERSION,
    id: "query:hubs",
    name: "Hubs",
    match: "all",
    conditions: [
      {
        kind: "dependency-count",
        direction: "either",
        minimum: 1,
      },
    ],
    sort: { key: "dependency-count", direction: "descending" },
    limit: 50,
    capabilities: {
      modelSchemaVersion: "1.0",
      metricSchemaVersion: ADVANCED_QUERY_METRIC_SCHEMA_VERSION,
    },
  };
}

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}

function model(project: string): CityModel {
  return {
    schemaVersion: "1.0",
    generator: { name: "code-city", version: "test" },
    repositories: [{ id: `repository:${project}`, name: project }],
    solutions: [],
    modules: [
      {
        id: `module:${project}`,
        repositoryId: `repository:${project}`,
        kind: "npm-package",
        name: project,
        path: project,
        solutionIds: [],
      },
    ],
    semanticGroups: [],
    districts: [],
    buildings: [],
    dependencies: [],
    bounds: { x: 1, y: 1, z: 1 },
  };
}
