import { describe, expect, it } from "vitest";

import {
  DEFAULT_VERSIONED_METRIC_MAPPING,
  type CityModel,
} from "../packages/core/src/index.js";
import {
  MAXIMUM_METRIC_MAPPING_CONFIGURATIONS,
  METRIC_MAPPING_STORAGE_PREFIX,
  MetricMappingConfigurationStore,
  metricMappingProjectIdentity,
  metricMappingStorageKey,
} from "../apps/viewer/src/metric-mapping-storage.js";
import { DEMO_MODEL } from "../apps/viewer/src/demo-model.js";

class FakeStorage {
  readonly values = new Map<string, string>();
  failWrites = false;

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.failWrites) {
      throw new DOMException("full", "QuotaExceededError");
    }
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

describe("viewer metric mapping storage", () => {
  it("uses only stable model project identity, never transport metadata", () => {
    const transportDecorated = {
      ...DEMO_MODEL,
      jobId: "job-secret",
      repositoryUrl: "https://token@example.invalid/private.git",
      credential: "secret",
    } as CityModel;
    expect(metricMappingProjectIdentity(transportDecorated)).toBe(
      metricMappingProjectIdentity(DEMO_MODEL),
    );
    expect(metricMappingStorageKey(DEMO_MODEL)).toMatch(
      new RegExp(`^${METRIC_MAPPING_STORAGE_PREFIX}`),
    );
    expect(metricMappingStorageKey(DEMO_MODEL)).not.toContain("http");
    expect(metricMappingStorageKey(DEMO_MODEL)).not.toContain("secret");

    const differentProject = {
      ...DEMO_MODEL,
      repositories: [{ id: "different", name: "Different" }],
    } satisfies CityModel;
    expect(metricMappingProjectIdentity(differentProject)).not.toBe(
      metricMappingProjectIdentity(DEMO_MODEL),
    );
  });

  it("uses stable project topology to separate unrelated same-named repositories", () => {
    const unrelatedProject = {
      ...DEMO_MODEL,
      solutions: DEMO_MODEL.solutions.map((solution) => ({
        ...solution,
        path: `unrelated/${solution.path}`,
      })),
      modules: DEMO_MODEL.modules.map((module) => ({
        ...module,
        path: `unrelated/${module.path}`,
      })),
    } satisfies CityModel;
    expect(unrelatedProject.repositories).toEqual(DEMO_MODEL.repositories);
    expect(metricMappingProjectIdentity(unrelatedProject)).not.toBe(
      metricMappingProjectIdentity(DEMO_MODEL),
    );

    const evolvedProject = {
      ...DEMO_MODEL,
      ...(DEMO_MODEL.identity === undefined
        ? {}
        : {
            identity: {
              ...DEMO_MODEL.identity,
              version: "next-revision",
            },
          }),
      buildings: DEMO_MODEL.buildings.map((building) => ({
        ...building,
        metrics: {
          ...building.metrics,
          sloc: building.metrics.sloc + 1,
        },
      })),
      dependencies: [],
    } satisfies CityModel;
    expect(metricMappingProjectIdentity(evolvedProject)).toBe(
      metricMappingProjectIdentity(DEMO_MODEL),
    );
  });

  it("saves, replaces, clones, and deletes named project configurations", () => {
    const storage = new FakeStorage();
    const store = new MetricMappingConfigurationStore(storage);
    expect(
      store.save(
        DEMO_MODEL,
        "Team default",
        DEFAULT_VERSIONED_METRIC_MAPPING,
      ),
    ).toMatchObject({ ok: true });
    const listed = store.list(DEMO_MODEL);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toEqual({
      name: "Team default",
      mapping: DEFAULT_VERSIONED_METRIC_MAPPING,
    });
    expect(listed[0]?.mapping).not.toBe(DEFAULT_VERSIONED_METRIC_MAPPING);

    expect(
      store.save(
        DEMO_MODEL,
        "team default",
        DEFAULT_VERSIONED_METRIC_MAPPING,
      ),
    ).toMatchObject({ ok: true });
    expect(store.list(DEMO_MODEL)).toHaveLength(1);
    expect(store.list(DEMO_MODEL)[0]?.name).toBe("team default");
    expect(store.delete(DEMO_MODEL, "TEAM DEFAULT")).toMatchObject({
      ok: true,
    });
    expect(store.list(DEMO_MODEL)).toEqual([]);
  });

  it("ignores corrupt, oversized, and cross-project documents wholesale", () => {
    const storage = new FakeStorage();
    const store = new MetricMappingConfigurationStore(storage);
    const key = metricMappingStorageKey(DEMO_MODEL);
    storage.values.set(key, "{");
    expect(store.list(DEMO_MODEL)).toEqual([]);
    storage.values.set(
      key,
      JSON.stringify({
        version: 1,
        projectIdentity: "another-project",
        configurations: [],
      }),
    );
    expect(store.list(DEMO_MODEL)).toEqual([]);
    storage.values.set(key, "x".repeat(128 * 1024 + 1));
    expect(store.list(DEMO_MODEL)).toEqual([]);
  });

  it("enforces the project count bound and contains quota failures", () => {
    const storage = new FakeStorage();
    const store = new MetricMappingConfigurationStore(storage);
    for (
      let index = 0;
      index < MAXIMUM_METRIC_MAPPING_CONFIGURATIONS;
      index += 1
    ) {
      expect(
        store.save(
          DEMO_MODEL,
          `Mapping ${index}`,
          DEFAULT_VERSIONED_METRIC_MAPPING,
        ).ok,
      ).toBe(true);
    }
    expect(store.list(DEMO_MODEL)).toHaveLength(
      MAXIMUM_METRIC_MAPPING_CONFIGURATIONS,
    );
    expect(
      store.save(
        DEMO_MODEL,
        "One too many",
        DEFAULT_VERSIONED_METRIC_MAPPING,
      ),
    ).toMatchObject({ ok: false });

    storage.failWrites = true;
    expect(
      store.save(
        {
          ...DEMO_MODEL,
          repositories: [{ id: "quota", name: "Quota" }],
        },
        "Will fail",
        DEFAULT_VERSIONED_METRIC_MAPPING,
      ),
    ).toMatchObject({
      ok: false,
      message: expect.stringMatching(/unavailable or full/iu),
    });
  });
});
