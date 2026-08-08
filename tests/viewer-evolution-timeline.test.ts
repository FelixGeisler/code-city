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
  compareEvolutionDependencies,
  compareEvolutionFrames,
  createEvolutionBuildingLineageSelection,
  evolutionDependencyEndpointKey,
  EvolutionDeferredSeekController,
  evolutionPlaybackStartIndex,
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
  it("starts normal playback at project start while retaining the baseline", () => {
    const bundle = fixture();
    const projectStartBundle = {
      ...bundle,
      selection: {
        mode: "root-to-tip",
        sampledCommitShas: [
          bundle.baseline.commit.sha,
          bundle.deltas[0]!.commit.sha,
          bundle.deltas[1]!.commit.sha,
        ],
        projectStartSha: bundle.deltas[0]!.commit.sha,
      },
    } as unknown as EvolutionBundle;

    expect(evolutionPlaybackStartIndex(projectStartBundle)).toBe(1);
    expect(
      evolutionPlaybackStartIndex({
        ...bundle,
        selection: { mode: "tag-range" },
      } as unknown as EvolutionBundle),
    ).toBe(0);
  });

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

  it("compares dependency-only transitions deterministically in either direction", () => {
    const dependency = (id: string): CityDependency =>
      DEMO_MODEL.dependencies.find((candidate) => candidate.id === id)!;
    const added: CityDependency = {
      id: "dependency:added-package",
      repositoryId: "repository:demo",
      sourceId: "module:viewer",
      externalTarget: "  @scope/new-package  ",
      resolution: "external",
      kind: "package-reference",
      version: "1.0.0",
      weight: 2,
    };
    const changed = {
      ...dependency("dependency:main-model"),
      resolution: "internal" as const,
      weight: 3,
    };
    const retargeted = {
      ...dependency("dependency:validation-model"),
      targetId: "building:schema",
    };
    const targetDependencies = [
      ...DEMO_MODEL.dependencies.filter(
        ({ id }) =>
          id !== "dependency:core-typescript-package" &&
          id !== changed.id &&
          id !== retargeted.id,
      ),
      added,
      changed,
      retargeted,
    ];
    const target = {
      ...DEMO_MODEL,
      dependencies: [...targetDependencies].reverse(),
    };

    const forward = compareEvolutionFrames(DEMO_MODEL, target, 0, 9);
    expect(forward.addedBuildingIds).toEqual([]);
    expect(forward.removedBuildings).toEqual([]);
    expect(forward.changedBuildingIds).toEqual([]);
    expect(
      forward.dependencyChanges.added.map(({ dependencyId }) => dependencyId),
    ).toEqual(["dependency:added-package"]);
    expect(
      forward.dependencyChanges.removed.map(
        ({ dependencyId }) => dependencyId,
      ),
    ).toEqual(["dependency:core-typescript-package"]);
    expect(
      forward.dependencyChanges.changed.map(
        ({ dependencyId }) => dependencyId,
      ),
    ).toEqual(["dependency:main-model"]);
    expect(
      forward.dependencyChanges.retargeted.map(
        ({ dependencyId }) => dependencyId,
      ),
    ).toEqual(["dependency:validation-model"]);
    expect(
      forward.dependencyChanges.retargeted[0],
    ).toMatchObject({
      before: {
        source: {
          kind: "entity",
          entityKind: "building",
          id: "building:validation",
        },
        target: {
          kind: "entity",
          entityKind: "building",
          id: "building:model",
        },
      },
      after: {
        source: {
          kind: "entity",
          entityKind: "building",
          id: "building:validation",
        },
        target: {
          kind: "entity",
          entityKind: "building",
          id: "building:schema",
        },
      },
    });
    expect(
      forward.dependencyChanges.added[0]?.target,
    ).toEqual({
      kind: "external",
      target: "@scope/new-package",
      key: evolutionDependencyEndpointKey({
        kind: "external",
        target: "@scope/new-package",
      }),
    });
    expect(
      forward.dependencyChanges.affectedEndpoints.map(({ key }) => key),
    ).toEqual([
      evolutionDependencyEndpointKey({
        kind: "entity",
        entityKind: "module",
        id: "module:viewer",
      }),
      evolutionDependencyEndpointKey({
        kind: "external",
        target: "@scope/new-package",
      }),
      evolutionDependencyEndpointKey({
        kind: "entity",
        entityKind: "module",
        id: "module:core",
      }),
      evolutionDependencyEndpointKey({
        kind: "external",
        target: "typescript",
      }),
      evolutionDependencyEndpointKey({
        kind: "entity",
        entityKind: "building",
        id: "building:main",
      }),
      evolutionDependencyEndpointKey({
        kind: "entity",
        entityKind: "building",
        id: "building:model",
      }),
      evolutionDependencyEndpointKey({
        kind: "entity",
        entityKind: "building",
        id: "building:validation",
      }),
      evolutionDependencyEndpointKey({
        kind: "entity",
        entityKind: "building",
        id: "building:schema",
      }),
    ]);
    expect(forward.dependencyChanges.affectedRouteKeys).toHaveLength(5);
    expect(
      new Set(forward.dependencyChanges.affectedRouteKeys).size,
    ).toBe(5);

    const reorderedBaseline = {
      ...DEMO_MODEL,
      dependencies: [...DEMO_MODEL.dependencies].reverse(),
    };
    const reorderedTarget = {
      ...target,
      dependencies: [...targetDependencies].sort(
        (left, right) => left.id.localeCompare(right.id),
      ),
    };
    const reordered = compareEvolutionFrames(
      reorderedBaseline,
      reorderedTarget,
      0,
      9,
    );
    expect(reordered).toEqual(forward);

    const backward = compareEvolutionFrames(target, DEMO_MODEL, 9, 0);
    expect(
      backward.dependencyChanges.added.map(({ dependencyId }) => dependencyId),
    ).toEqual(["dependency:core-typescript-package"]);
    expect(
      backward.dependencyChanges.removed.map(
        ({ dependencyId }) => dependencyId,
      ),
    ).toEqual(["dependency:added-package"]);
    expect(backward.dependencyChanges.changed).toEqual(
      forward.dependencyChanges.changed,
    );
    expect(backward.dependencyChanges.retargeted[0]).toMatchObject({
      before: {
        target: {
          kind: "entity",
          entityKind: "building",
          id: "building:schema",
        },
      },
      after: {
        target: {
          kind: "entity",
          entityKind: "building",
          id: "building:model",
        },
      },
    });
  });

  it("keeps building and module endpoint namespaces distinct", () => {
    const before: CityDependency = {
      id: "dependency:shared-ids",
      repositoryId: "repository:demo",
      sourceId: "shared:source",
      targetId: "shared:target",
      resolution: "internal",
      kind: "typescript-import",
      weight: 1,
    };
    const after: CityDependency = {
      ...before,
      kind: "project-reference",
    };

    const changes = compareEvolutionDependencies([before], [after]);

    expect(changes.changed).toEqual([]);
    expect(changes.retargeted).toHaveLength(1);
    expect(changes.retargeted[0]).toMatchObject({
      before: {
        source: {
          entityKind: "building",
          id: "shared:source",
        },
        target: {
          entityKind: "building",
          id: "shared:target",
        },
      },
      after: {
        source: {
          entityKind: "module",
          id: "shared:source",
        },
        target: {
          entityKind: "module",
          id: "shared:target",
        },
      },
    });
    expect(changes.retargeted[0]!.before.routeKey).not.toBe(
      changes.retargeted[0]!.after.routeKey,
    );
  });
});
