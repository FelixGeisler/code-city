import { describe, expect, it } from "vitest";

import { DEMO_MODEL } from "../apps/viewer/src/demo-model.js";
import {
  compareEvolutionFrames,
  evolutionDependencyEndpointKey,
  evolutionDependencyRouteKey,
  type EvolutionDependencyEndpointIdentity,
  type EvolutionDependencyRouteIdentity,
} from "../apps/viewer/src/evolution-timeline.js";
import { EvolutionTimelineWorkerClient } from "../apps/viewer/src/evolution-timeline-worker-client.js";
import {
  isEvolutionWorkerResponse,
  type EvolutionWorkerRequest,
} from "../apps/viewer/src/evolution-timeline-protocol.js";

class FakeEvolutionWorker extends EventTarget {
  readonly requests: EvolutionWorkerRequest[] = [];
  readonly transfers: Transferable[][] = [];
  terminated = false;

  postMessage(value: unknown, transfer: Transferable[] = []): void {
    this.requests.push(value as EvolutionWorkerRequest);
    this.transfers.push(transfer);
  }

  terminate(): void {
    this.terminated = true;
  }

  respond(value: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data: value }));
  }
}

const frame = {
  index: 0,
  sha: "a".repeat(40),
  committedAt: "2026-01-01T00:00:00.000Z",
};
const analysis = {
  ageByBuildingId: [],
  churnByBuildingId: [],
};

describe("evolution timeline worker client", () => {
  it(
    "accepts dependency transition sets beyond the model dependency bound",
    { timeout: 30_000 },
    () => {
      const maximumModelDependencies = 100_000;
      const affectedRouteCount = maximumModelDependencies + 1;
      const source = {
        kind: "entity",
        entityKind: "module",
        id: "module:shared-source",
      } as const;
      const sourceIdentity: Extract<
        EvolutionDependencyEndpointIdentity,
        { readonly kind: "entity" }
      > = {
        ...source,
        key: evolutionDependencyEndpointKey(source),
      };
      const added: EvolutionDependencyRouteIdentity[] = [];
      const removed: EvolutionDependencyRouteIdentity[] = [];
      const affectedEndpoints: EvolutionDependencyEndpointIdentity[] = [
        sourceIdentity,
      ];
      const affectedRouteKeys: string[] = [];

      for (let index = 0; index < affectedRouteCount; index += 1) {
        const suffix = index.toString().padStart(6, "0");
        const target = {
          kind: "external",
          target: `package-${suffix}`,
        } as const;
        const targetIdentity: Extract<
          EvolutionDependencyEndpointIdentity,
          { readonly kind: "external" }
        > = {
          ...target,
          key: evolutionDependencyEndpointKey(target),
        };
        const route: EvolutionDependencyRouteIdentity = {
          dependencyId:
            index < maximumModelDependencies
              ? `dependency:${suffix}`
              : "dependency:removed",
          routeKey: evolutionDependencyRouteKey(
            sourceIdentity,
            targetIdentity,
          ),
          source: sourceIdentity,
          target: targetIdentity,
        };
        if (index < maximumModelDependencies) {
          added.push(route);
        } else {
          removed.push(route);
        }
        affectedEndpoints.push(targetIdentity);
        affectedRouteKeys.push(route.routeKey);
      }

      expect(affectedRouteKeys).toHaveLength(100_001);
      expect(affectedEndpoints).toHaveLength(100_002);
      expect(
        isEvolutionWorkerResponse({
          type: "frame",
          requestId: 1,
          frame: { ...frame, index: 1 },
          model: {},
          analysis,
          transition: {
            fromIndex: 0,
            toIndex: 1,
            addedBuildingIds: [],
            removedBuildings: [],
            renamedBuildingIds: [],
            resizedBuildingIds: [],
            changedBuildingIds: [],
            interpolatedBuildings: [],
            dependencyChanges: {
              added,
              removed,
              changed: [],
              retargeted: [],
              affectedEndpoints,
              affectedRouteKeys,
            },
          },
        }),
      ).toBe(true);
    },
  );

  it("rejects inconsistent dependency identities at the worker boundary", () => {
    const changedDependency = {
      ...DEMO_MODEL.dependencies[0]!,
      weight: DEMO_MODEL.dependencies[0]!.weight + 1,
    };
    const target = {
      ...DEMO_MODEL,
      dependencies: DEMO_MODEL.dependencies.map((dependency) =>
        dependency.id === changedDependency.id
          ? changedDependency
          : dependency,
      ),
    };
    const response = {
      type: "frame",
      requestId: 1,
      frame: { ...frame, index: 1 },
      model: target,
      analysis,
      transition: compareEvolutionFrames(DEMO_MODEL, target, 0, 1),
    } as const;

    expect(isEvolutionWorkerResponse(response)).toBe(true);
    expect(
      isEvolutionWorkerResponse({
        ...response,
        transition: {
          ...response.transition,
          dependencyChanges: {
            ...response.transition.dependencyChanges,
            affectedRouteKeys: [],
          },
        },
      }),
    ).toBe(false);
    expect(
      isEvolutionWorkerResponse({
        ...response,
        transition: {
          ...response.transition,
          dependencyChanges: {
            ...response.transition.dependencyChanges,
            changed: [
              {
                ...response.transition.dependencyChanges.changed[0]!,
                routeKey: "forged-route",
              },
            ],
          },
        },
      }),
    ).toBe(false);
    const validChangedRoute =
      response.transition.dependencyChanges.changed[0]!;
    expect(
      isEvolutionWorkerResponse({
        ...response,
        transition: {
          ...response.transition,
          dependencyChanges: {
            ...response.transition.dependencyChanges,
            changed: [
              {
                ...validChangedRoute,
                source: {
                  kind: "entity",
                  id: validChangedRoute.source.id,
                  key: validChangedRoute.source.key,
                },
              },
            ],
          },
        },
      }),
    ).toBe(false);

    const externalDependency = DEMO_MODEL.dependencies.find(
      ({ externalTarget }) => externalTarget !== undefined,
    )!;
    const externalTarget = {
      ...DEMO_MODEL,
      dependencies: DEMO_MODEL.dependencies.map((dependency) =>
        dependency.id === externalDependency.id
          ? { ...dependency, weight: dependency.weight + 1 }
          : dependency,
      ),
    };
    const externalResponse = {
      ...response,
      model: externalTarget,
      transition: compareEvolutionFrames(
        DEMO_MODEL,
        externalTarget,
        0,
        1,
      ),
    };
    const externalRoute =
      externalResponse.transition.dependencyChanges.changed[0]!;
    expect(externalRoute.target.kind).toBe("external");
    if (externalRoute.target.kind !== "external") {
      throw new Error("Expected an external dependency route.");
    }
    expect(
      isEvolutionWorkerResponse({
        ...externalResponse,
        transition: {
          ...externalResponse.transition,
          dependencyChanges: {
            ...externalResponse.transition.dependencyChanges,
            changed: [
              {
                ...externalRoute,
                target: {
                  ...externalRoute.target,
                  target: ` ${externalRoute.target.target} `,
                },
              },
            ],
          },
        },
      }),
    ).toBe(false);

    const changedIds = new Set(
      DEMO_MODEL.dependencies
        .slice(0, 2)
        .map((dependency) => dependency.id),
    );
    const multiTarget = {
      ...DEMO_MODEL,
      dependencies: DEMO_MODEL.dependencies.map((dependency) =>
        changedIds.has(dependency.id)
          ? { ...dependency, weight: dependency.weight + 1 }
          : dependency,
      ),
    };
    const multiResponse = {
      ...response,
      model: multiTarget,
      transition: compareEvolutionFrames(
        DEMO_MODEL,
        multiTarget,
        0,
        1,
      ),
    };
    const multiChanges = multiResponse.transition.dependencyChanges;
    expect(multiChanges.affectedEndpoints.length).toBeGreaterThan(1);
    expect(multiChanges.affectedRouteKeys.length).toBeGreaterThan(1);
    for (const key of [
      "affectedEndpoints",
      "affectedRouteKeys",
    ] as const) {
      expect(
        isEvolutionWorkerResponse({
          ...multiResponse,
          transition: {
            ...multiResponse.transition,
            dependencyChanges: {
              ...multiChanges,
              [key]: [...multiChanges[key]].reverse(),
            },
          },
        }),
      ).toBe(false);
    }
  });

  it("loads once, keeps the worker, and validates returned models", async () => {
    const worker = new FakeEvolutionWorker();
    const client = new EvolutionTimelineWorkerClient({
      createWorker: () => worker as unknown as Worker,
    });
    const bytes = new ArrayBuffer(8);
    const loaded = client.load(bytes, {
      size: 8,
      sha256: "a".repeat(64),
    });
    const request = worker.requests[0]!;
    worker.respond({
      type: "loaded",
      requestId: request.requestId,
      frames: [frame],
      histories: [],
      model: DEMO_MODEL,
      analysis,
    });

    await expect(loaded).resolves.toMatchObject({ frames: [frame] });
    expect(request).toMatchObject({ bytes });
    expect(worker.transfers[0]).toEqual([bytes]);
    expect(worker.terminated).toBe(false);
  });

  it("rejects a superseded seek and ignores its stale response", async () => {
    const worker = new FakeEvolutionWorker();
    const client = new EvolutionTimelineWorkerClient({
      createWorker: () => worker as unknown as Worker,
    });
    const loading = client.load(new ArrayBuffer(1), {
      size: 1,
      sha256: "b".repeat(64),
    });
    worker.respond({
      type: "loaded",
      requestId: worker.requests[0]!.requestId,
      frames: [frame, { ...frame, index: 1 }],
      histories: [],
      model: DEMO_MODEL,
      analysis,
    });
    await loading;

    const first = client.seek(0, 1);
    const firstRequest = worker.requests.at(-1)!;
    const second = client.seek(0, 0);
    const secondRequest = worker.requests.at(-1)!;
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    worker.respond({
      type: "frame",
      requestId: firstRequest.requestId,
      frame,
      model: DEMO_MODEL,
      analysis,
      transition: {
        fromIndex: 0,
        toIndex: 1,
        addedBuildingIds: [],
        removedBuildings: [],
        renamedBuildingIds: [],
        resizedBuildingIds: [],
        changedBuildingIds: [],
        interpolatedBuildings: [],
        dependencyChanges: {
          added: [],
          removed: [],
          changed: [],
          retargeted: [],
          affectedEndpoints: [],
          affectedRouteKeys: [],
        },
      },
    });
    worker.respond({
      type: "frame",
      requestId: secondRequest.requestId,
      frame,
      model: DEMO_MODEL,
      analysis,
      transition: {
        fromIndex: 0,
        toIndex: 0,
        addedBuildingIds: [],
        removedBuildings: [],
        renamedBuildingIds: [],
        resizedBuildingIds: [],
        changedBuildingIds: [],
        interpolatedBuildings: [],
        dependencyChanges: {
          added: [],
          removed: [],
          changed: [],
          retargeted: [],
          affectedEndpoints: [],
          affectedRouteKeys: [],
        },
      },
    });
    await expect(second).resolves.toMatchObject({
      requestId: secondRequest.requestId,
    });
  });

  it("sends cooperative cancellation and recovers with a later seek", async () => {
    const worker = new FakeEvolutionWorker();
    const client = new EvolutionTimelineWorkerClient({
      createWorker: () => worker as unknown as Worker,
    });
    const loading = client.load(new ArrayBuffer(1), {
      size: 1,
      sha256: "c".repeat(64),
    });
    worker.respond({
      type: "loaded",
      requestId: worker.requests[0]!.requestId,
      frames: [frame, { ...frame, index: 1 }],
      histories: [],
      model: DEMO_MODEL,
      analysis,
    });
    await loading;

    const cancelled = client.seek(0, 1);
    const cancelledRequest = worker.requests.at(-1)!;
    client.cancel();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    expect(worker.requests.at(-1)).toMatchObject({
      type: "cancel",
      requestId: cancelledRequest.requestId + 1,
    });

    const recovered = client.seek(0, 1);
    const recoveredRequest = worker.requests.at(-1)!;
    worker.respond({
      type: "frame",
      requestId: cancelledRequest.requestId,
      frame,
      model: DEMO_MODEL,
      analysis,
      transition: {
        fromIndex: 0,
        toIndex: 1,
        addedBuildingIds: [],
        removedBuildings: [],
        renamedBuildingIds: [],
        resizedBuildingIds: [],
        changedBuildingIds: [],
        interpolatedBuildings: [],
        dependencyChanges: {
          added: [],
          removed: [],
          changed: [],
          retargeted: [],
          affectedEndpoints: [],
          affectedRouteKeys: [],
        },
      },
    });
    worker.respond({
      type: "frame",
      requestId: recoveredRequest.requestId,
      frame: { ...frame, index: 1 },
      model: DEMO_MODEL,
      analysis,
      transition: {
        fromIndex: 0,
        toIndex: 1,
        addedBuildingIds: [],
        removedBuildings: [],
        renamedBuildingIds: [],
        resizedBuildingIds: [],
        changedBuildingIds: [],
        interpolatedBuildings: [],
        dependencyChanges: {
          added: [],
          removed: [],
          changed: [],
          retargeted: [],
          affectedEndpoints: [],
          affectedRouteKeys: [],
        },
      },
    });
    await expect(recovered).resolves.toMatchObject({
      requestId: recoveredRequest.requestId,
    });
  });
});
