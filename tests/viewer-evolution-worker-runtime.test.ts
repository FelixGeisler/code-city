import { describe, expect, it } from "vitest";

import {
  deriveEvolutionChangeKinds,
  replayEvolutionBundle,
  serializeEvolutionBundle,
  validateCityModel,
  type CityModel,
  type CityDependency,
  type EvolutionBundle,
  type EvolutionChanges,
} from "../packages/core/src/index.js";
import { DEMO_MODEL } from "../apps/viewer/src/demo-model.js";
import {
  EVOLUTION_WORK_CHECKPOINT_INTERVAL,
  EvolutionTimelineWorkerRuntime,
  type EvolutionWorkerWorkPhase,
} from "../apps/viewer/src/evolution-timeline-worker-runtime.js";
import type {
  EvolutionWorkerRequest,
  EvolutionWorkerResponse,
} from "../apps/viewer/src/evolution-timeline-protocol.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function sha(index: number): string {
  return index.toString(16).padStart(40, "0");
}

function fingerprint(index: number): `sha256:${string}` {
  return `sha256:${index.toString(16).padStart(64, "0")}`;
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

function dependency(index: number, weight: number): CityDependency {
  const suffix = index.toString().padStart(4, "0");
  return {
    id: `dependency:checkpoint:${suffix}`,
    repositoryId: DEMO_MODEL.repositories[0]!.id,
    sourceId: DEMO_MODEL.modules[0]!.id,
    externalTarget: `checkpoint-package-${suffix}`,
    resolution: "external",
    kind: "package-reference",
    version: "1",
    weight,
  };
}

function largeBundle(): EvolutionBundle {
  const dependencies = Array.from({ length: 640 }, (_, index) =>
    dependency(index, 1),
  );
  const baseline = validateCityModel({
    ...DEMO_MODEL,
    dependencies,
  });
  const replacements = dependencies.map((before, index) => {
    const entity = dependency(index, 2);
    return {
      id: before.id,
      changeKinds: deriveEvolutionChangeKinds(
        "dependencies",
        before,
        entity,
      ),
      entity,
    };
  });
  return {
    schemaVersion: "1.0",
    generator: baseline.generator,
    authorPolicy: "omit-v1",
    selection: {
      mode: "commit-count",
      traversal: "first-parent",
      order: "oldest-first",
      requestedCommitCount: 2,
      sampleEvery: 1,
      selectedCommitCount: 2,
      sampledCommitCount: 2,
      traversedCommitCount: 2,
      resolvedOldestSha: sha(1),
      resolvedNewestSha: sha(2),
      sampledCommitShas: [sha(1), sha(2)],
    },
    provenance: {
      repositoryId: baseline.repositories[0]!.id,
      repositoryFingerprint: fingerprint(1),
      analyzer: {
        name: "code-city",
        version: baseline.generator.version,
        fingerprint: fingerprint(2),
      },
      historyBackend: {
        name: "git",
        version: "2.47.1",
        renamePolicyRevision: "diff-tree-renames-50-myers-v1",
      },
      metricConfigurationFingerprint: fingerprint(3),
      selectionFingerprint: fingerprint(4),
    },
    baseline: {
      commit: {
        index: 0,
        sha: sha(1),
        committedAt: "2026-01-01T00:00:00.000Z",
        parentShas: [],
        analyzerVersion: baseline.generator.version,
        analysisFingerprint: fingerprint(5),
      },
      model: baseline,
    },
    deltas: [
      {
        commit: {
          index: 1,
          sha: sha(2),
          committedAt: "2026-01-02T00:00:00.000Z",
          parentShas: [sha(1)],
          analyzerVersion: baseline.generator.version,
          analysisFingerprint: fingerprint(6),
        },
        changes: {
          ...emptyChanges(),
          dependencies: {
            added: [],
            removed: [],
            changed: replacements,
          },
        },
      },
    ],
  };
}

function nonCanonicalBundle(): EvolutionBundle {
  const bundle = largeBundle();
  const baseline = bundle.baseline.model;
  const descendingText = (left: string, right: string): number =>
    left < right ? 1 : left > right ? -1 : 0;
  const descendingEntity = (
    left: { readonly id: string },
    right: { readonly id: string },
  ): number => descendingText(left.id, right.id);
  const model: CityModel = {
    ...baseline,
    repositories: [...baseline.repositories].sort(descendingEntity),
    solutions: [...baseline.solutions]
      .map((solution) => ({
        ...solution,
        moduleIds: [...solution.moduleIds].sort(descendingText),
      }))
      .sort(descendingEntity),
    modules: [...baseline.modules]
      .map((module) => ({
        ...module,
        solutionIds: [...module.solutionIds].sort(descendingText),
        ...(module.targetFrameworks === undefined
          ? {}
          : {
              targetFrameworks: [
                ...module.targetFrameworks,
              ].sort(descendingText),
            }),
      }))
      .sort(descendingEntity),
    semanticGroups: [...baseline.semanticGroups].sort(descendingEntity),
    districts: [...baseline.districts].sort(descendingEntity),
    buildings: [...baseline.buildings]
      .map((building) => ({
        ...building,
        ...(building.units === undefined
          ? {}
          : { units: [...building.units].reverse() }),
      }))
      .sort(descendingEntity),
    dependencies: [...baseline.dependencies].sort(descendingEntity),
    ...(baseline.analysis === undefined
      ? {}
      : {
          analysis: {
            ...baseline.analysis,
            warnings: [...baseline.analysis.warnings].reverse(),
          },
        }),
  };
  return {
    ...bundle,
    baseline: {
      ...bundle.baseline,
      model,
    },
  };
}

async function arrayBuffer(bytes: Uint8Array): Promise<ArrayBuffer> {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

async function digest(bytes: ArrayBuffer): Promise<string> {
  const value = await crypto.subtle.digest("SHA-256", bytes.slice(0));
  return [...new Uint8Array(value)]
    .map((item) => item.toString(16).padStart(2, "0"))
    .join("");
}

const cancellablePhases: readonly EvolutionWorkerWorkPhase[] = [
  "cached-frame-clone",
  "delta-replay",
  "post-replay-clone",
  "post-replay-analysis",
  "post-replay-transition",
];

describe("evolution timeline worker runtime", () => {
  it("matches core replay for valid non-canonical artifact ordering", async () => {
    const bundle = nonCanonicalBundle();
    const serialized = new TextEncoder().encode(JSON.stringify(bundle));
    const bytes = await arrayBuffer(serialized);
    const responses: EvolutionWorkerResponse[] = [];
    const runtime = new EvolutionTimelineWorkerRuntime({
      postMessage: (response) => responses.push(response),
      yieldControl: async () => undefined,
      checkpointInterval: 8,
    });
    const expected = [...replayEvolutionBundle(bundle)];

    await runtime.handle({
      type: "load",
      requestId: 1,
      bytes: bytes.slice(0),
      expectedSize: bytes.byteLength,
      expectedSha256: await digest(bytes),
    });
    expect(responses.at(-1)).toMatchObject({
      type: "loaded",
      requestId: 1,
      model: expected[0]!.model,
    });

    await runtime.handle({
      type: "seek",
      requestId: 2,
      fromIndex: 0,
      toIndex: 1,
    });
    expect(responses.at(-1)).toMatchObject({
      type: "frame",
      requestId: 2,
      model: expected[1]!.model,
    });
  });

  it.each(cancellablePhases)(
    "cancels at a real %s checkpoint and lets the newest seek finish",
    async (phase) => {
      const bundle = largeBundle();
      const serialized = serializeEvolutionBundle(bundle);
      const bytes = await arrayBuffer(serialized);
      const responses: EvolutionWorkerResponse[] = [];
      const reached = deferred();
      const release = deferred();
      let blockedPhase: EvolutionWorkerWorkPhase | undefined;
      let blockConsumed = false;
      let blockedPhaseCheckpoints = 0;
      const observed: EvolutionWorkerWorkPhase[] = [];
      const runtime = new EvolutionTimelineWorkerRuntime({
        postMessage: (response) => responses.push(response),
        yieldControl: async (currentPhase) => {
          observed.push(currentPhase);
          if (currentPhase === blockedPhase && !blockConsumed) {
            blockedPhaseCheckpoints += 1;
            if (blockedPhaseCheckpoints > 1) {
              blockConsumed = true;
              reached.resolve();
              await release.promise;
            }
          }
        },
        checkpointInterval: 8,
      });
      const load: EvolutionWorkerRequest = {
        type: "load",
        requestId: 1,
        bytes: bytes.slice(0),
        expectedSize: bytes.byteLength,
        expectedSha256: await digest(bytes),
      };
      await runtime.handle(load);
      expect(responses.at(-1)).toMatchObject({
        type: "loaded",
        requestId: 1,
      });
      responses.length = 0;
      observed.length = 0;

      blockedPhase = phase;
      blockedPhaseCheckpoints = 0;
      const obsolete = runtime.handle({
        type: "seek",
        requestId: 2,
        fromIndex: 0,
        toIndex: 1,
      });
      await reached.promise;
      await runtime.handle({ type: "cancel", requestId: 3 });
      release.resolve();
      await obsolete;
      expect(responses).toEqual([]);

      blockedPhase = undefined;
      await runtime.handle({
        type: "seek",
        requestId: 4,
        fromIndex: 0,
        toIndex: 1,
      });
      const recovered = responses.at(-1);
      expect(recovered).toMatchObject({
        type: "frame",
        requestId: 4,
        frame: { index: 1 },
      });
      if (recovered?.type !== "frame") {
        throw new Error("Expected a recovered evolution frame.");
      }
      expect(recovered.model).toEqual(
        [...replayEvolutionBundle(bundle)][1]!.model,
      );
      expect(
        observed.filter((value) => value === "delta-replay").length,
      ).toBeGreaterThan(2);
    },
    30_000,
  );

  it("documents a bounded production checkpoint budget", () => {
    expect(EVOLUTION_WORK_CHECKPOINT_INTERVAL).toBe(256);
  });
});
