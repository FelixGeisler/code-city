import { describe, expect, it } from "vitest";

import type {
  CityDependency,
  EvolutionBundle,
  EvolutionChanges,
} from "../packages/core/src/index.js";
import { DEMO_MODEL } from "../apps/viewer/src/demo-model.js";
import {
  analyzeEvolutionBuildingHistory,
  analyzeEvolutionFrame,
  compareEvolutionFrames,
  createEvolutionBuildingLineageSelection,
  EvolutionDeferredSeekController,
  EvolutionSeekGate,
  resolveEvolutionBuildingLineage,
  summarizeEvolutionFrames,
  type EvolutionBuildingHistory,
} from "../apps/viewer/src/evolution-timeline.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function commit(index: number) {
  return {
    index,
    sha: String(index).repeat(40),
    committedAt: `2026-01-0${index + 1}T00:00:00.000Z`,
    parentShas: [],
    analyzerVersion: "1.0.0",
    analysisFingerprint: `sha256:${String(index).repeat(64)}` as const,
  };
}

function emptyChanges(): EvolutionChanges {
  const empty = () => ({ added: [], removed: [], changed: [] });
  return {
    model: {},
    repositories: empty(),
    solutions: empty(),
    modules: empty(),
    semanticGroups: empty(),
    districts: empty(),
    buildings: empty(),
    dependencies: empty(),
  };
}

function fixture(): EvolutionBundle {
  const original = DEMO_MODEL.buildings[0]!;
  const added = {
    ...original,
    id: "building:timeline-added",
    name: "Added",
    path: "src/added.ts",
  };
  const renamed = {
    ...original,
    name: `${original.name} renamed`,
    path: `${original.path}.renamed`,
    size: { ...original.size, y: original.size.y + 1 },
  };
  return {
    baseline: { commit: commit(0), model: DEMO_MODEL },
    deltas: [
      {
        commit: commit(1),
        changes: {
          ...emptyChanges(),
          buildings: {
            added: [added],
            removed: [],
            changed: [
              {
                id: original.id,
                changeKinds: ["renamed", "geometry"],
                entity: renamed,
              },
            ],
          },
        },
      },
      {
        commit: commit(2),
        changes: {
          ...emptyChanges(),
          buildings: {
            added: [],
            removed: [original.id],
            changed: [],
          },
        },
      },
    ],
  } as unknown as EvolutionBundle;
}

describe("viewer evolution timeline analysis", () => {
  it("returns to idle after cancelling a seek and accepts the next navigation", () => {
    const gate = new EvolutionSeekGate();
    const cancelled = gate.begin();
    expect(gate.busy).toBe(true);

    expect(gate.cancel()).toBe(true);
    expect(gate.busy).toBe(false);
    expect(gate.isCurrent(cancelled)).toBe(false);

    const next = gate.begin();
    expect(gate.settle(cancelled)).toBe(false);
    expect(gate.busy).toBe(true);
    expect(gate.settle(next)).toBe(true);
    expect(gate.busy).toBe(false);

    const failed = gate.begin();
    expect(gate.fail(failed, "Frame replay failed.")).toBe(true);
    expect(gate.failure).toBe("Frame replay failed.");
    const recovered = gate.begin();
    expect(gate.failure).toBeUndefined();
    expect(gate.settle(recovered)).toBe(true);
  });

  it("executes pause and A to B to A through the deferred render seam", async () => {
    let currentIndex = 0;
    let cancelled = 0;
    const first = deferred<number>();
    const second = deferred<number>();
    const requests = [first, second];
    const statuses: string[] = [];
    let controller!: EvolutionDeferredSeekController<number>;
    controller = new EvolutionDeferredSeekController({
      currentIndex: () => currentIndex,
      request: () => requests.shift()!.promise,
      cancelRequest: () => {
        cancelled += 1;
      },
      render: () => {
        statuses.push(
          controller.busy
            ? `Seeking ${controller.targetIndex}\u2026`
            : controller.failure ?? `Frame ${currentIndex}`,
        );
      },
    });
    const apply = ({ result }: { readonly result: number }): void => {
      currentIndex = result;
    };

    const paused = controller.seek(1, apply);
    expect(statuses.at(-1)).toBe("Seeking 1\u2026");
    expect(controller.cancel()).toBe(true);
    expect(statuses.at(-1)).toBe("Frame 0");
    first.resolve(1);
    await expect(paused).resolves.toBe(false);
    expect(currentIndex).toBe(0);

    const toB = controller.seek(1, apply);
    expect(statuses.at(-1)).toBe("Seeking 1\u2026");
    await expect(controller.seek(0, apply)).resolves.toBe(true);
    expect(statuses.at(-1)).toBe("Frame 0");
    second.resolve(1);
    await expect(toB).resolves.toBe(false);
    expect(currentIndex).toBe(0);
    expect(cancelled).toBe(2);
  });

  it("retains C while stale B completes in A to B to C navigation", async () => {
    let currentIndex = 0;
    const toB = deferred<number>();
    const toC = deferred<number>();
    const requests = [toB, toC];
    const renderedTargets: (number | undefined)[] = [];
    let controller!: EvolutionDeferredSeekController<number>;
    controller = new EvolutionDeferredSeekController({
      currentIndex: () => currentIndex,
      request: () => requests.shift()!.promise,
      cancelRequest: () => undefined,
      render: () => renderedTargets.push(controller.targetIndex),
    });
    const apply = ({ result }: { readonly result: number }): void => {
      currentIndex = result;
    };

    const first = controller.seek(1, apply);
    const newest = controller.seek(2, apply);
    expect(controller.busy).toBe(true);
    expect(renderedTargets.at(-1)).toBe(2);

    toB.resolve(1);
    await expect(first).resolves.toBe(false);
    expect(currentIndex).toBe(0);
    expect(controller.busy).toBe(true);
    expect(controller.targetIndex).toBe(2);

    toC.resolve(2);
    await expect(newest).resolves.toBe(true);
    expect(currentIndex).toBe(2);
    expect(controller.busy).toBe(false);
    expect(controller.targetIndex).toBeUndefined();
  });

  it("keeps failure visible and shows Seeking until recovery settles", async () => {
    let currentIndex = 0;
    const failed = deferred<number>();
    const recovered = deferred<number>();
    const requests = [failed, recovered];
    const statuses: string[] = [];
    let controller!: EvolutionDeferredSeekController<number>;
    controller = new EvolutionDeferredSeekController({
      currentIndex: () => currentIndex,
      request: () => requests.shift()!.promise,
      cancelRequest: () => undefined,
      render: () => {
        statuses.push(
          controller.busy
            ? "Seeking\u2026"
            : controller.failure ?? `Frame ${currentIndex}`,
        );
      },
    });
    const apply = ({ result }: { readonly result: number }): void => {
      currentIndex = result;
    };

    const first = controller.seek(1, apply);
    expect(statuses.at(-1)).toBe("Seeking\u2026");
    failed.reject(new Error("Frame replay failed."));
    await expect(first).resolves.toBe(false);
    expect(statuses.at(-1)).toBe("Frame replay failed.");
    expect(controller.failure).toBe("Frame replay failed.");

    const second = controller.seek(2, apply);
    expect(statuses.at(-1)).toBe("Seeking\u2026");
    recovered.resolve(2);
    await expect(second).resolves.toBe(true);
    expect(statuses.at(-1)).toBe("Frame 2");
    expect(controller.failure).toBeUndefined();
  });

  it("summarizes frames and stable-lineage history deterministically", () => {
    const bundle = fixture();
    const frames = summarizeEvolutionFrames(bundle);
    const histories = analyzeEvolutionBuildingHistory(bundle);
    const original = histories.find(
      ({ id }) => id === DEMO_MODEL.buildings[0]!.id,
    )!;
    const added = histories.find(
      ({ id }) => id === "building:timeline-added",
    )!;

    expect(frames.map(({ index }) => index)).toEqual([0, 1, 2]);
    expect(original).toMatchObject({
      firstFrame: 0,
      lastFrame: 1,
      removedAtFrame: 2,
      changeCount: 2,
      changeKinds: ["geometry", "renamed"],
    });
    expect(added).toMatchObject({ firstFrame: 1, lastFrame: 2 });
  });

  it("retains an introduced-later lineage before creation and restores its actual building", () => {
    const future = {
      ...DEMO_MODEL.buildings[0]!,
      id: "building:future-lineage",
      name: "future-lineage.ts",
      path: "src/future-lineage.ts",
    };
    const history: EvolutionBuildingHistory = {
      id: future.id,
      firstFrame: 2,
      lastFrame: 3,
      changeCount: 1,
      changeKinds: [],
    };
    const selected =
      createEvolutionBuildingLineageSelection(future);

    const beforeCreation = resolveEvolutionBuildingLineage(
      selected,
      history,
      1,
    );
    expect(beforeCreation).toMatchObject({
      selection: selected,
      state: { kind: "not-yet-created", creationFrame: 2 },
    });
    const stillBeforeCreation = resolveEvolutionBuildingLineage(
      beforeCreation!.selection,
      history,
      0,
    );
    expect(stillBeforeCreation).toMatchObject({
      selection: selected,
      state: { kind: "not-yet-created", creationFrame: 2 },
    });

    const actualAtCreation = {
      ...future,
      metrics: { ...future.metrics, sloc: future.metrics.sloc + 1 },
    };
    const restored = resolveEvolutionBuildingLineage(
      stillBeforeCreation!.selection,
      history,
      2,
      actualAtCreation,
    );
    expect(restored).toMatchObject({
      building: actualAtCreation,
      state: { kind: "present" },
      selection: {
        id: future.id,
        lastKnownBuilding: actualAtCreation,
      },
    });
  });

  it("retains a removed-lineage tombstone and restores its actual earlier building", () => {
    const original = DEMO_MODEL.buildings[2]!;
    const history: EvolutionBuildingHistory = {
      id: original.id,
      firstFrame: 0,
      lastFrame: 1,
      removedAtFrame: 2,
      changeCount: 1,
      changeKinds: [],
    };
    const selected =
      createEvolutionBuildingLineageSelection(original);

    const removed = resolveEvolutionBuildingLineage(
      selected,
      history,
      2,
    );
    expect(removed).toMatchObject({
      selection: selected,
      state: { kind: "removed", removalFrame: 2 },
    });
    const stillRemoved = resolveEvolutionBuildingLineage(
      removed!.selection,
      history,
      3,
    );
    expect(stillRemoved).toMatchObject({
      selection: selected,
      state: { kind: "removed", removalFrame: 2 },
    });

    const actualBeforeRemoval = {
      ...original,
      metrics: {
        ...original.metrics,
        maximumComplexity:
          original.metrics.maximumComplexity + 1,
      },
    };
    const restored = resolveEvolutionBuildingLineage(
      stillRemoved!.selection,
      history,
      1,
      actualBeforeRemoval,
    );
    expect(restored).toMatchObject({
      building: actualBeforeRemoval,
      state: { kind: "present" },
      selection: {
        id: original.id,
        lastKnownBuilding: actualBeforeRemoval,
      },
    });
  });

  it("computes age and churn only for buildings present at the target", () => {
    const analysis = analyzeEvolutionFrame(fixture(), 2);
    const ages = new Map(analysis.ageByBuildingId);
    const churn = new Map(analysis.churnByBuildingId);

    expect(ages.has(DEMO_MODEL.buildings[0]!.id)).toBe(false);
    expect(ages.get("building:timeline-added")).toBe(1);
    expect(churn.get("building:timeline-added")).toBe(1);
  });

  it("distinguishes additions, removals, renames, and resizing", () => {
    const original = DEMO_MODEL.buildings[0]!;
    const target = {
      ...DEMO_MODEL,
      buildings: [
        {
          ...original,
          name: "Renamed",
          size: { ...original.size, y: original.size.y + 1 },
        },
        {
          ...DEMO_MODEL.buildings[1]!,
          id: "building:new",
        },
      ],
    };
    const transition = compareEvolutionFrames(DEMO_MODEL, target, 0, 7);

    expect(transition.fromIndex).toBe(0);
    expect(transition.toIndex).toBe(7);
    expect(transition.addedBuildingIds).toContain("building:new");
    expect(transition.renamedBuildingIds).toContain(original.id);
    expect(transition.resizedBuildingIds).toContain(original.id);
    expect(transition.interpolatedBuildings).toContainEqual({
      id: original.id,
      position: original.position,
      size: original.size,
    });
    expect(transition.removedBuildings.length).toBe(
      DEMO_MODEL.buildings.length - 1,
    );
    expect(
      transition.removedBuildings.every(
        (building) =>
          building.districtId ===
          DEMO_MODEL.buildings.find(({ id }) => id === building.id)
            ?.districtId,
      ),
    ).toBe(true);
  });

  it("reports dependency-only route and endpoint changes deterministically", () => {
    const dependency = (
      id: string,
      overrides: Partial<CityDependency> = {},
    ): CityDependency => ({
      id,
      repositoryId: "repository:demo",
      sourceId: "building:main",
      targetId: "building:model",
      kind: "typescript-import",
      weight: 1,
      ...overrides,
    });
    const removed = dependency("dependency:removed");
    const changed: CityDependency = {
      id: "dependency:changed",
      repositoryId: "repository:demo",
      sourceId: "module:viewer",
      externalTarget: "three",
      kind: "package-reference",
      weight: 1,
    };
    const retargeted = dependency("dependency:retargeted");
    const added: CityDependency = {
      id: "dependency:added",
      repositoryId: "repository:demo",
      sourceId: "module:core",
      externalTarget: "vitest",
      kind: "package-reference",
      weight: 1,
    };
    const from = {
      ...DEMO_MODEL,
      dependencies: [removed, changed, retargeted],
    };
    const to = {
      ...DEMO_MODEL,
      dependencies: [
        added,
        { ...retargeted, targetId: "building:schema" },
        { ...changed, weight: 2 },
      ].toReversed(),
    };

    const transition = compareEvolutionFrames(from, to, 4, 5);

    expect(transition.addedBuildingIds).toEqual([]);
    expect(transition.changedBuildingIds).toEqual([]);
    expect(transition.addedDependencyIds).toEqual([
      "dependency:added",
    ]);
    expect(transition.removedDependencyIds).toEqual([
      "dependency:removed",
    ]);
    expect(transition.changedDependencyIds).toEqual([
      "dependency:changed",
      "dependency:retargeted",
    ]);
    expect(transition.retargetedDependencyIds).toEqual([
      "dependency:retargeted",
    ]);
    expect(transition.affectedDependencyRouteIds).toEqual([
      "dependency:added",
      "dependency:changed",
      "dependency:removed",
      "dependency:retargeted",
    ]);
    expect(transition.affectedDependencyEndpointKeys).toEqual([
      "entity:building:main",
      "entity:building:model",
      "entity:building:schema",
      "entity:module:core",
      "entity:module:viewer",
      "external:three",
      "external:vitest",
    ]);
  });
});
