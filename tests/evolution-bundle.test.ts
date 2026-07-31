import { describe, expect, it, vi } from "vitest";

import {
  EVOLUTION_BUNDLE_LIMITS,
  ValidatedEvolutionReplayCursor,
  canonicalEvolutionBundleJson,
  deriveEvolutionChangeKinds,
  iterateCanonicalEvolutionBundleBytes,
  iteratePreparedEvolutionBundleBytes,
  measureEvolutionBundleBytes,
  prepareEvolutionSerialization,
  replayEvolutionBundle,
  replayValidatedEvolutionBundle,
  serializeEvolutionBundle,
  validateCityModel,
  validateEvolutionBundle,
  type CityBuilding,
  type CityModel,
  type EvolutionBundle,
  type EvolutionChanges,
  type EvolutionCommitMetadata,
  type EvolutionDeltaFrame,
} from "../packages/core/src/index.js";

function shaFor(index: number): string {
  return (index + 1).toString(16).padStart(40, "0");
}

function fingerprintFor(index: number): `sha256:${string}` {
  return `sha256:${index.toString(16).padStart(64, "0")}`;
}

function model(): CityModel {
  return validateCityModel({
    schemaVersion: "1.0",
    generator: {
      name: "code-city",
      version: "1.2.3",
    },
    repositories: [
      {
        id: "repository:one",
        name: "One",
      },
    ],
    solutions: [
      {
        id: "solution:one",
        repositoryId: "repository:one",
        name: "One",
        path: "one.sln",
        moduleIds: ["module:one"],
      },
    ],
    modules: [
      {
        id: "module:one",
        repositoryId: "repository:one",
        kind: "npm-package",
        name: "One",
        path: "src",
        solutionIds: ["solution:one"],
      },
    ],
    semanticGroups: [
      {
        id: "group:secondary",
        label: "Secondary",
        color: "#224466",
        priority: 2,
      },
      {
        id: "group:primary",
        label: "Primary",
        color: "#112233",
        priority: 1,
      },
    ],
    analysis: {
      warnings: ["z warning", "a warning"],
    },
    districts: [
      {
        id: "district:one",
        repositoryId: "repository:one",
        moduleId: "module:one",
        name: "One",
        path: "src",
        position: { x: 0, y: 0.5, z: 0 },
        size: { x: 10, y: 1, z: 10 },
      },
    ],
    buildings: [
      {
        id: "building:one",
        repositoryId: "repository:one",
        moduleId: "module:one",
        districtId: "district:one",
        name: "one.ts",
        path: "src/one.ts",
        language: "typescript",
        metrics: {
          sloc: 10,
          decisionLoad: 1,
          maximumComplexity: 1,
          executableUnitCount: 0,
        },
        risk: "low",
        semanticGroupId: "group:primary",
        position: { x: 0, y: 2, z: 0 },
        size: { x: 1, y: 2, z: 1 },
      },
    ],
    dependencies: [
      {
        id: "dependency:one",
        repositoryId: "repository:one",
        sourceId: "module:one",
        externalTarget: "typescript",
        resolution: "external",
        kind: "package-reference",
        version: "5",
        weight: 1,
      },
    ],
    bounds: { x: 10, y: 4, z: 10 },
  });
}

function emptyChanges(): EvolutionChanges {
  return {
    model: {},
    repositories: { added: [], removed: [], changed: [] },
    solutions: { added: [], removed: [], changed: [] },
    modules: { added: [], removed: [], changed: [] },
    semanticGroups: { added: [], removed: [], changed: [] },
    districts: { added: [], removed: [], changed: [] },
    buildings: { added: [], removed: [], changed: [] },
    dependencies: { added: [], removed: [], changed: [] },
  };
}

function commit(
  index: number,
  parentShas: readonly string[] =
    index === 0 ? [] : [shaFor(index - 1)],
): EvolutionCommitMetadata {
  return {
    index,
    sha: shaFor(index),
    committedAt: new Date(
      Date.UTC(2026, 0, index + 1),
    ).toISOString(),
    parentShas,
    analyzerVersion: "1.2.3",
    analysisFingerprint: fingerprintFor(index + 100),
  };
}

function changedBuilding(): CityBuilding {
  return {
    ...model().buildings[0]!,
    name: "renamed.ts",
    path: "src/moved/renamed.ts",
    metrics: {
      sloc: 25,
      decisionLoad: 4,
      maximumComplexity: 4,
      executableUnitCount: 0,
    },
    risk: "moderate",
    semanticGroupId: "group:secondary",
    position: { x: 1, y: 3, z: 1 },
  };
}

function bundle(): EvolutionBundle {
  const firstChanges = emptyChanges();
  const firstDelta: EvolutionDeltaFrame = {
    commit: commit(1),
    changes: {
      ...firstChanges,
      model: {
        analysis: {
          warnings: ["history warning"],
        },
        bounds: { x: 12, y: 6, z: 12 },
      },
      buildings: {
        added: [],
        removed: [],
        changed: [
          {
            id: "building:one",
            changeKinds: [
              "renamed",
              "moved",
              "metrics",
              "relationships",
              "geometry",
            ],
            entity: changedBuilding(),
          },
        ],
      },
    },
  };
  const secondChanges = emptyChanges();
  const secondDelta: EvolutionDeltaFrame = {
    commit: commit(2),
    changes: {
      ...secondChanges,
      dependencies: {
        added: [
          {
            id: "dependency:two",
            repositoryId: "repository:one",
            sourceId: "module:one",
            externalTarget: "vitest",
            resolution: "external",
            kind: "package-reference",
            weight: 1,
          },
        ],
        removed: ["dependency:one"],
        changed: [],
      },
    },
  };
  return {
    schemaVersion: "1.0",
    generator: {
      name: "code-city",
      version: "1.2.3",
    },
    authorPolicy: "omit-v1",
    selection: {
      mode: "commit-count",
      traversal: "first-parent",
      order: "oldest-first",
      requestedCommitCount: 3,
      sampleEvery: 1,
      selectedCommitCount: 3,
      sampledCommitCount: 3,
      traversedCommitCount: 3,
      resolvedOldestSha: shaFor(0),
      resolvedNewestSha: shaFor(2),
      sampledCommitShas: [shaFor(0), shaFor(1), shaFor(2)],
    },
    provenance: {
      repositoryId: "repository:one",
      repositoryFingerprint: fingerprintFor(1),
      analyzer: {
        name: "code-city",
        version: "1.2.3",
        fingerprint: fingerprintFor(2),
      },
      historyBackend: {
        name: "git",
        version: "2.47.1.windows.2",
        renamePolicyRevision: "diff-tree-renames-50-myers-v1",
      },
      metricConfigurationFingerprint: fingerprintFor(3),
      selectionFingerprint: fingerprintFor(4),
    },
    baseline: {
      commit: commit(0),
      model: model(),
    },
    deltas: [firstDelta, secondDelta],
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function mutable(value: unknown): Record<string, any> {
  return clone(value) as unknown as Record<string, any>;
}

describe("EvolutionBundle 1.0", () => {
  it("derives the validator's canonical change kinds for producers", () => {
    const before = model().buildings[0]!;
    const after = changedBuilding();
    const kinds = deriveEvolutionChangeKinds(
      "buildings",
      before,
      after,
    );

    expect(kinds).toEqual([
      "renamed",
      "moved",
      "metrics",
      "relationships",
      "geometry",
    ]);
    expect(Object.isFrozen(kinds)).toBe(true);
    expect(
      deriveEvolutionChangeKinds("buildings", before, {
        ...before,
        name: "renamed.ts",
      }),
    ).toEqual(["renamed"]);
    expect(
      deriveEvolutionChangeKinds("buildings", before, clone(before)),
    ).toEqual([]);
    expect(() =>
      deriveEvolutionChangeKinds("buildings", before, {
        ...after,
        id: "building:different",
      }),
    ).toThrow(/must match/u);
  });

  it("validates and streams an oldest full model followed by explicit deltas", () => {
    const value = bundle();

    expect(validateEvolutionBundle(value)).toBe(value);
    const frames = [...replayEvolutionBundle(value)];

    expect(frames).toHaveLength(3);
    expect(frames.map(({ commit: value }) => value.index)).toEqual([
      0, 1, 2,
    ]);
    expect(frames[0]!.model.schemaVersion).toBe("1.0");
    expect(frames[1]!.model.buildings[0]).toMatchObject({
      id: "building:one",
      name: "renamed.ts",
      path: "src/moved/renamed.ts",
      semanticGroupId: "group:secondary",
      metrics: { sloc: 25, maximumComplexity: 4 },
      position: { x: 1, y: 3, z: 1 },
    });
    expect(frames[1]!.model.bounds).toEqual({ x: 12, y: 6, z: 12 });
    expect(frames[2]!.model.dependencies.map(({ id }) => id)).toEqual([
      "dependency:two",
    ]);
    expect(validateCityModel(frames[2]!.model)).toBe(frames[2]!.model);

    (frames[0]!.model.repositories[0] as { name: string }).name =
      "mutated";
    expect(frames[1]!.model.repositories[0]!.name).toBe("One");
    expect(value.baseline.model.repositories[0]!.name).toBe("One");
  });

  it("replays the exact validator-owned bundle without accepting an unvalidated lookalike", () => {
    const unvalidated = bundle();
    expect(() => [...replayValidatedEvolutionBundle(unvalidated)]).toThrow(
      /exact result/iu,
    );

    const validated = validateEvolutionBundle(unvalidated);
    expect(
      [...replayValidatedEvolutionBundle(validated)].map(
        ({ commit: value }) => value.index,
      ),
    ).toEqual([0, 1, 2]);
  });

  it("reuses the active validated frame for near-linear sequential playback", async () => {
    const value = mutable(bundle());
    const frameCount = EVOLUTION_BUNDLE_LIMITS.frames;
    value.deltas = Array.from(
      { length: frameCount - 1 },
      (_, offset) => {
        const index = offset + 1;
        const changes = {
          ...emptyChanges(),
          model: { bounds: { x: 10 + index, y: 4, z: 10 } },
        };
        return { commit: commit(index), changes };
      },
    );
    value.selection.requestedCommitCount = frameCount;
    value.selection.selectedCommitCount = frameCount;
    value.selection.sampledCommitCount = frameCount;
    value.selection.traversedCommitCount = frameCount;
    value.selection.resolvedNewestSha = shaFor(frameCount - 1);
    value.selection.sampledCommitShas = Array.from(
      { length: frameCount },
      (_, index) => shaFor(index),
    );

    const validated = validateEvolutionBundle(value);
    const cursor = new ValidatedEvolutionReplayCursor(validated);
    let totalApplications = 0;
    for (let index = 1; index < frameCount; index += 1) {
      const result = await cursor.seek(index - 1, index);
      totalApplications += result.appliedDeltaCount;
      expect(result.model.bounds.x).toBe(10 + index);
    }

    expect(totalApplications).toBe(frameCount - 1);
    expect(cursor.activeIndex).toBe(frameCount - 1);

    const expectedFrames = [
      ...replayValidatedEvolutionBundle(validated),
    ];
    const backward = await cursor.seek(frameCount - 1, 37);
    expect(backward.appliedDeltaCount).toBe(37);
    expect(backward.model).toEqual(expectedFrames[37]!.model);
    const forward = await cursor.seek(37, frameCount - 1);
    expect(forward.appliedDeltaCount).toBe(frameCount - 1 - 37);
    expect(forward.model).toEqual(expectedFrames.at(-1)!.model);
  });

  it("keeps arbitrary seeks bounded and cancellation transactional", async () => {
    const validated = validateEvolutionBundle(bundle());
    const cursor = new ValidatedEvolutionReplayCursor(validated);
    const last = await cursor.seek(0, 2);
    expect(last.appliedDeltaCount).toBe(2);

    const baseline = await cursor.seek(2, 0);
    expect(baseline.appliedDeltaCount).toBe(0);
    expect(baseline.model).toEqual(
      [...replayValidatedEvolutionBundle(validated)][0]!.model,
    );

    const cancelled = new Error("cancel replay");
    let checkpoints = 0;
    await expect(
      cursor.seek(0, 2, {
        checkpoint: () => {
          checkpoints += 1;
          if (checkpoints === 3) throw cancelled;
        },
      }),
    ).rejects.toBe(cancelled);
    expect(cursor.activeIndex).toBe(0);

    const recovered = await cursor.seek(0, 2);
    expect(recovered.appliedDeltaCount).toBe(2);
    expect(recovered.model).toEqual(last.model);
  });

  it("accepts all normalized selection modes without persisting mutable tag names", () => {
    const count = bundle();
    expect(validateEvolutionBundle(count).selection.mode).toBe(
      "commit-count",
    );

    const dates = mutable(bundle());
    dates.selection = {
      ...dates.selection,
      mode: "date-range",
      fromInclusive: "2026-01-01T00:00:00.000Z",
      toInclusive: "2026-01-03T00:00:00.000Z",
    };
    delete dates.selection.requestedCommitCount;
    // A date filter may skip ancestry entries with timestamps outside the
    // range even when sampleEvery retains every selected commit.
    dates.deltas[0].commit.parentShas = [shaFor(9)];
    expect(validateEvolutionBundle(dates).selection.mode).toBe(
      "date-range",
    );

    const tags = mutable(bundle());
    tags.selection = {
      ...tags.selection,
      mode: "tag-range",
    };
    delete tags.selection.requestedCommitCount;
    expect(validateEvolutionBundle(tags).selection).not.toHaveProperty(
      "tag",
    );
  });

  it("rejects malformed headers, provenance, commits, and selection ordering", () => {
    const cases: readonly [
      name: string,
      mutate: (value: Record<string, any>) => void,
      message: RegExp,
    ][] = [
      [
        "unknown version",
        (value) => {
          value.schemaVersion = "2.0";
        },
        /schemaVersion/u,
      ],
      [
        "non-omitting author policy",
        (value) => {
          value.authorPolicy = "full";
        },
        /authorPolicy/u,
      ],
      [
        "author metadata hidden in a commit",
        (value) => {
          value.baseline.commit.author = { name: "Private" };
        },
        /author is not supported/u,
      ],
      [
        "wrong frame index",
        (value) => {
          value.deltas[0].commit.index = 7;
        },
        /index must be 1/u,
      ],
      [
        "frame SHA not aligned to selection",
        (value) => {
          value.deltas[0].commit.sha = shaFor(9);
        },
        /must match selection/u,
      ],
      [
        "duplicate sampled SHA",
        (value) => {
          value.selection.sampledCommitShas[1] =
            value.selection.sampledCommitShas[0];
        },
        /duplicated/u,
      ],
      [
        "broken first-parent adjacency",
        (value) => {
          value.deltas[0].commit.parentShas = [shaFor(9)];
        },
        /previous frame/u,
      ],
      [
        "noncanonical SHA",
        (value) => {
          value.baseline.commit.parentShas = ["A".repeat(40)];
        },
        /lowercase 40- or 64-character/u,
      ],
      [
        "noncanonical instant",
        (value) => {
          value.baseline.commit.committedAt = "2026-01-01";
        },
        /canonical UTC instant/u,
      ],
      [
        "invalid fingerprint",
        (value) => {
          value.provenance.selectionFingerprint = "sha256:abc";
        },
        /sha256 fingerprint/u,
      ],
      [
        "unsupported history backend",
        (value) => {
          value.provenance.historyBackend.name = "host-library";
        },
        /historyBackend\.name/u,
      ],
      [
        "mutable tag label",
        (value) => {
          value.selection.mode = "tag-range";
          delete value.selection.requestedCommitCount;
          value.selection.fromTag = "v1";
        },
        /fromTag is not supported/u,
      ],
      [
        "noncanonical date range",
        (value) => {
          value.selection.mode = "date-range";
          delete value.selection.requestedCommitCount;
          value.selection.fromInclusive =
            "2026-01-04T00:00:00.000Z";
          value.selection.toInclusive =
            "2026-01-03T00:00:00.000Z";
        },
        /must not be later/u,
      ],
      [
        "commit outside declared date range",
        (value) => {
          value.selection.mode = "date-range";
          delete value.selection.requestedCommitCount;
          value.selection.fromInclusive =
            "2026-01-02T00:00:00.000Z";
          value.selection.toInclusive =
            "2026-01-03T00:00:00.000Z";
        },
        /must lie within the inclusive selection date range/u,
      ],
    ];

    cases.forEach(([name, mutate, message]) => {
      const value = mutable(bundle());
      mutate(value);
      expect(
        () => validateEvolutionBundle(value),
        name,
      ).toThrow(message);
    });
  });

  it("rejects ambiguous, noncanonical, and invalid entity operations", () => {
    const cases: readonly [
      name: string,
      mutate: (value: Record<string, any>) => void,
      message: RegExp,
    ][] = [
      [
        "operation overlap",
        (value) => {
          value.deltas[0].changes.buildings.removed = [
            "building:one",
          ];
        },
        /overlaps another operation/u,
      ],
      [
        "unknown removal",
        (value) => {
          value.deltas[1].changes.dependencies.removed = [
            "dependency:missing",
          ];
        },
        /references an unknown id/u,
      ],
      [
        "existing addition",
        (value) => {
          value.deltas[1].changes.dependencies.removed = [];
          value.deltas[1].changes.dependencies.added[0].id =
            "dependency:one";
        },
        /already exists/u,
      ],
      [
        "retired lineage resurrection",
        (value) => {
          value.deltas[0].changes.dependencies.removed = [
            "dependency:one",
          ];
          value.deltas[1].changes.dependencies.removed = [];
          value.deltas[1].changes.dependencies.added[0].id =
            "dependency:one";
        },
        /retired lineage/u,
      ],
      [
        "partial replacement",
        (value) => {
          value.deltas[0].changes.buildings.changed[0].entity = {
            id: "building:one",
            name: "partial",
          };
        },
        /changeKinds must exactly describe/u,
      ],
      [
        "wrong change kinds",
        (value) => {
          value.deltas[0].changes.buildings.changed[0].changeKinds = [
            "renamed",
          ];
        },
        /must exactly describe/u,
      ],
      [
        "noncanonical kind order",
        (value) => {
          value.deltas[0].changes.buildings.changed[0].changeKinds = [
            "moved",
            "renamed",
            "metrics",
            "relationships",
            "geometry",
          ];
        },
        /canonical change-kind order/u,
      ],
      [
        "no-op replacement",
        (value) => {
          value.deltas[0].changes.buildings.changed[0].entity =
            clone(value.baseline.model.buildings[0]);
          value.deltas[0].changes.buildings.changed[0].changeKinds = [
            "renamed",
          ];
        },
        /no changes/u,
      ],
      [
        "no-op model patch",
        (value) => {
          value.deltas[0].changes.model.bounds =
            clone(value.baseline.model.bounds);
        },
        /bounds must not be a no-op/u,
      ],
      [
        "unsorted operation IDs",
        (value) => {
          value.deltas[1].changes.dependencies.added = [
            {
              ...value.deltas[1].changes.dependencies.added[0],
              id: "dependency:z",
            },
            {
              ...value.deltas[1].changes.dependencies.added[0],
              id: "dependency:a",
            },
          ];
        },
        /must be sorted by id/u,
      ],
      [
        "broken resulting cross-reference",
        (value) => {
          value.deltas[0].changes.buildings.changed[0].entity.moduleId =
            "module:missing";
        },
        /references an unknown id/u,
      ],
    ];

    cases.forEach(([name, mutate, message]) => {
      const value = mutable(bundle());
      mutate(value);
      expect(
        () => validateEvolutionBundle(value),
        name,
      ).toThrow(message);
    });
  });

  it("accepts exact frame, traversal, sampling, and parent bounds", () => {
    const exact = singleModelBundle(
      EVOLUTION_BUNDLE_LIMITS.frames,
      1,
      EVOLUTION_BUNDLE_LIMITS.traversedCommits,
    );
    const parents = Array.from(
      { length: EVOLUTION_BUNDLE_LIMITS.parentsPerCommit },
      (_, index) => shaFor(index + 1_000),
    );
    exact.baseline.commit.parentShas = parents;

    expect(validateEvolutionBundle(exact)).toBe(exact);
    expect([...replayEvolutionBundle(exact)]).toHaveLength(
      EVOLUTION_BUNDLE_LIMITS.frames,
    );

    const sampled = singleModelBundle(
      2,
      EVOLUTION_BUNDLE_LIMITS.sampleEvery,
      EVOLUTION_BUNDLE_LIMITS.traversedCommits,
    );
    expect(validateEvolutionBundle(sampled)).toBe(sampled);
  });

  it("rejects each exact bound plus one", () => {
    const tooManyFrames = singleModelBundle(
      EVOLUTION_BUNDLE_LIMITS.frames,
      1,
      EVOLUTION_BUNDLE_LIMITS.frames,
    );
    tooManyFrames.selection.sampledCommitCount += 1;
    tooManyFrames.selection.selectedCommitCount += 1;
    tooManyFrames.selection.traversedCommitCount += 1;
    tooManyFrames.selection.requestedCommitCount += 1;
    tooManyFrames.selection.resolvedNewestSha = shaFor(
      EVOLUTION_BUNDLE_LIMITS.frames,
    );
    tooManyFrames.selection.sampledCommitShas.push(
      shaFor(EVOLUTION_BUNDLE_LIMITS.frames),
    );
    tooManyFrames.deltas.push({
      commit: commit(EVOLUTION_BUNDLE_LIMITS.frames),
      changes: emptyChanges(),
    });
    expect(() => validateEvolutionBundle(tooManyFrames)).toThrow(
      new RegExp(`must not exceed ${EVOLUTION_BUNDLE_LIMITS.frames}`, "u"),
    );

    const traversal = mutable(singleModelBundle(1, 1, 1));
    traversal.selection.traversedCommitCount =
      EVOLUTION_BUNDLE_LIMITS.traversedCommits + 1;
    expect(() => validateEvolutionBundle(traversal)).toThrow(
      new RegExp(
        `must not exceed ${EVOLUTION_BUNDLE_LIMITS.traversedCommits}`,
        "u",
      ),
    );

    const sampling = mutable(singleModelBundle(1, 1, 1));
    sampling.selection.sampleEvery =
      EVOLUTION_BUNDLE_LIMITS.sampleEvery + 1;
    expect(() => validateEvolutionBundle(sampling)).toThrow(
      new RegExp(
        `must not exceed ${EVOLUTION_BUNDLE_LIMITS.sampleEvery}`,
        "u",
      ),
    );

    const parentCount = mutable(singleModelBundle(1, 1, 1));
    parentCount.baseline.commit.parentShas = Array.from(
      { length: EVOLUTION_BUNDLE_LIMITS.parentsPerCommit + 1 },
      (_, index) => shaFor(index + 1_000),
    );
    expect(() => validateEvolutionBundle(parentCount)).toThrow(
      new RegExp(
        `at most ${EVOLUTION_BUNDLE_LIMITS.parentsPerCommit}`,
        "u",
      ),
    );
  });

  it("produces byte-stable canonical UTF-8 across key and set-like array order", () => {
    const first = bundle();
    const second = mutable(bundle());
    second.baseline.model.repositories =
      [...second.baseline.model.repositories].reverse();
    second.baseline.model.semanticGroups =
      [...second.baseline.model.semanticGroups].reverse();
    second.baseline.model.analysis.warnings =
      [...second.baseline.model.analysis.warnings].reverse();
    second.baseline.model = {
      bounds: second.baseline.model.bounds,
      dependencies: second.baseline.model.dependencies,
      buildings: second.baseline.model.buildings,
      districts: second.baseline.model.districts,
      analysis: second.baseline.model.analysis,
      semanticGroups: second.baseline.model.semanticGroups,
      modules: second.baseline.model.modules,
      solutions: second.baseline.model.solutions,
      repositories: second.baseline.model.repositories,
      generator: second.baseline.model.generator,
      schemaVersion: second.baseline.model.schemaVersion,
    };

    const firstBytes = serializeEvolutionBundle(first);
    const secondBytes = serializeEvolutionBundle(second);
    const stream = iterateCanonicalEvolutionBundleBytes(second);
    expect(Object.isFrozen(second)).toBe(true);
    expect(Object.isFrozen(second.baseline.model)).toBe(true);
    expect(Object.isFrozen(second.deltas[0].changes)).toBe(true);
    const streamedChunks = [...stream];
    const streamedBytes = new Uint8Array(
      streamedChunks.reduce(
        (total, chunk) => total + chunk.byteLength,
        0,
      ),
    );
    let streamedOffset = 0;
    for (const chunk of streamedChunks) {
      streamedBytes.set(chunk, streamedOffset);
      streamedOffset += chunk.byteLength;
    }
    expect(firstBytes).toBeInstanceOf(Uint8Array);
    expect([...secondBytes]).toEqual([...firstBytes]);
    expect([...streamedBytes]).toEqual([...firstBytes]);
    expect(measureEvolutionBundleBytes(second)).toBe(
      firstBytes.byteLength,
    );
    expect(streamedChunks.every((chunk) => chunk.byteLength > 0)).toBe(
      true,
    );
    expect(canonicalEvolutionBundleJson(first)).toBe(
      new TextDecoder().decode(firstBytes),
    );
    expect(canonicalEvolutionBundleJson(first)).toMatch(
      /^\{"authorPolicy":"omit-v1"/u,
    );
    expect(canonicalEvolutionBundleJson(first)).not.toContain("\n");
  });

  it("bounds canonical chunks for valid large extension strings", () => {
    const value = mutable(bundle());
    (
      value.baseline.model as unknown as Record<string, unknown>
    )["extension"] = {
      note: "x".repeat(48 * 1024),
    };
    const chunks = [
      ...iterateCanonicalEvolutionBundleBytes(value),
    ];
    expect(Math.max(...chunks.map(({ byteLength }) => byteLength))).toBeLessThan(
      EVOLUTION_BUNDLE_LIMITS.jsonStringBytes + 20 * 1024,
    );

    const oversized = mutable(bundle());
    (
      oversized.baseline.model as unknown as Record<string, unknown>
    )["extension"] = {
      note: "x".repeat(EVOLUTION_BUNDLE_LIMITS.jsonStringBytes),
    };
    expect(() =>
      iterateCanonicalEvolutionBundleBytes(oversized),
    ).toThrow(/strings and property names/u);
  });

  it("rejects accessors, proxies, and sparse arrays before serialization", () => {
    const accessor = mutable(bundle());
    let getterCalls = 0;
    Object.defineProperty(accessor, "authorPolicy", {
      configurable: true,
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return getterCalls === 1 ? "omit-v1" : "leaked-author-data";
      },
    });
    expect(() => iterateCanonicalEvolutionBundleBytes(accessor)).toThrow(
      /own data property/u,
    );
    expect(getterCalls).toBe(0);

    const proxyTarget = mutable(bundle());
    proxyTarget.authorPolicy = "leaked-author-data";
    const proxied = new Proxy(proxyTarget, {
      get: (target, key, receiver) =>
        key === "authorPolicy" && !Object.isFrozen(target)
          ? "omit-v1"
          : Reflect.get(target, key, receiver),
    });
    expect(() => measureEvolutionBundleBytes(proxied)).toThrow(
      /Proxy objects|authorPolicy/u,
    );

    const sparse = mutable(bundle());
    delete sparse.deltas[0];
    expect(() => serializeEvolutionBundle(sparse)).toThrow(
      /dense JSON array/u,
    );

    const customArray = mutable(bundle());
    Object.setPrototypeOf(
      customArray.deltas,
      Object.create(Array.prototype),
    );
    expect(() => validateEvolutionBundle(customArray)).toThrow(
      /plain JSON arrays/u,
    );
  });

  it("captures Proxy arrays without inherited reads when native inspection is unavailable", () => {
    const value = mutable(bundle());
    let inheritedReads = 0;
    value.deltas = new Proxy(value.deltas, {
      get: (target, key, receiver) => {
        if (key === "entries" || key === Symbol.iterator) {
          inheritedReads += 1;
          return function* empty(): Generator<never> {
            return;
          };
        }
        return Reflect.get(target, key, receiver);
      },
    });

    vi.stubGlobal("process", undefined);
    try {
      const validated = validateEvolutionBundle(value);
      expect(validated).not.toBe(value);
      expect(validated.deltas).not.toBe(value.deltas);
      expect(inheritedReads).toBe(0);
      expect([...replayEvolutionBundle(validated)]).toHaveLength(3);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("freezes the validated replay input before yielding its baseline", () => {
    const value = mutable(bundle());
    const replay = replayEvolutionBundle(value);

    expect(replay.next().value?.commit.index).toBe(0);
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.deltas[0].commit)).toBe(true);
    expect(Reflect.set(value.deltas[0].commit, "index", 99)).toBe(false);
    expect([...replay].map(({ commit }) => commit.index)).toEqual([1, 2]);
  });

  it("supports cooperative cancellation during large validation passes", () => {
    const largeModel = modelWithDependencies(1_024);
    const modelCancellation = new Error("cancel model validation");
    let modelCheckpoints = 0;
    expect(() =>
      validateCityModel(largeModel, {
        checkpoint: () => {
          modelCheckpoints += 1;
          if (modelCheckpoints === 4) throw modelCancellation;
        },
      }),
    ).toThrow(modelCancellation);
    expect(modelCheckpoints).toBe(4);

    const largeBundle = singleModelBundle(1, 1, 1);
    largeBundle.baseline.model = modelWithDependencies(1_024);
    const bundleCancellation = new Error("cancel bundle measurement");
    let bundleCheckpoints = 0;
    expect(() =>
      measureEvolutionBundleBytes(largeBundle, {
        checkpoint: () => {
          bundleCheckpoints += 1;
          if (bundleCheckpoints === 8) throw bundleCancellation;
        },
      }),
    ).toThrow(bundleCancellation);
    expect(bundleCheckpoints).toBe(8);

    const streamCancellation = new Error(
      "cancel bundle stream preparation",
    );
    let streamCheckpoints = 0;
    expect(() =>
      iterateCanonicalEvolutionBundleBytes(
        singleModelBundle(1, 1, 1),
        {
          checkpoint: () => {
            streamCheckpoints += 1;
            if (streamCheckpoints === 3) throw streamCancellation;
          },
        },
      ),
    ).toThrow(streamCancellation);
    expect(streamCheckpoints).toBe(3);

    const emissionBundle = singleModelBundle(1, 1, 1);
    emissionBundle.baseline.model = modelWithDependencies(1_024);
    const emissionCancellation = new Error(
      "cancel canonical bundle emission",
    );
    let emissionStarted = false;
    let emissionCheckpoints = 0;
    const chunks = iterateCanonicalEvolutionBundleBytes(
      emissionBundle,
      {
        checkpoint: () => {
          if (!emissionStarted) return;
          emissionCheckpoints += 1;
          if (emissionCheckpoints === 2) {
            throw emissionCancellation;
          }
        },
      },
    );
    emissionStarted = true;
    expect(() => chunks.next()).toThrow(emissionCancellation);
    expect(emissionCheckpoints).toBe(2);
  });

  it("authenticates and reuses prepared canonical serialization", () => {
    const prepared = prepareEvolutionSerialization(bundle());
    const emitted = [
      ...iteratePreparedEvolutionBundleBytes(prepared),
    ].flatMap((chunk) => [...chunk]);

    expect(emitted).toEqual([
      ...serializeEvolutionBundle(prepared.bundle),
    ]);
    expect(Object.isFrozen(prepared.bundle)).toBe(true);
    expect(() =>
      iteratePreparedEvolutionBundleBytes({
        bundle: prepared.bundle,
        measuredBytes: prepared.measuredBytes,
      }),
    ).toThrow(/prepared evolution serialization is invalid/u);
  });

  it("keeps checkpointed measurement exact for escaped UTF-8", () => {
    const value = mutable(bundle());
    value.baseline.model.analysis.warnings = [
      "quoted \"text\", slash \\, emoji 😀, and café",
    ];
    let checkpoints = 0;
    const measured = measureEvolutionBundleBytes(value, {
      checkpoint: () => {
        checkpoints += 1;
      },
    });
    const serialized = serializeEvolutionBundle(value);

    expect(measured).toBe(serialized.byteLength);
    expect(checkpoints).toBeGreaterThan(0);
    expect(JSON.parse(new TextDecoder().decode(serialized))).toBeTruthy();
  });
});

function modelWithDependencies(dependencyCount: number): CityModel {
  const value = mutable(model());
  value.dependencies = Array.from(
    { length: dependencyCount },
    (_, index) => ({
      id: `dependency:${index}`,
      repositoryId: "repository:one",
      sourceId: "module:one",
      externalTarget: `package-${index}`,
      resolution: "external",
      kind: "package-reference",
      version: "1",
      weight: 1,
    }),
  );
  return value as CityModel;
}

function singleModelBundle(
  frameCount: number,
  sampleEvery: number,
  traversedCommitCount: number,
): Record<string, any> {
  const selectedCommitCount =
    frameCount === 1 ? 1 : (frameCount - 2) * sampleEvery + 2;
  const sampledCommitShas = Array.from(
    { length: frameCount },
    (_, index) => shaFor(index),
  );
  return {
    schemaVersion: "1.0",
    generator: {
      name: "code-city",
      version: "1.2.3",
    },
    authorPolicy: "omit-v1",
    selection: {
      mode: "commit-count",
      traversal: "first-parent",
      order: "oldest-first",
      requestedCommitCount: selectedCommitCount,
      sampleEvery,
      selectedCommitCount,
      sampledCommitCount: frameCount,
      traversedCommitCount,
      resolvedOldestSha: sampledCommitShas[0],
      resolvedNewestSha: sampledCommitShas.at(-1),
      sampledCommitShas,
    },
    provenance: {
      repositoryId: "repository:one",
      repositoryFingerprint: fingerprintFor(1),
      analyzer: {
        name: "code-city",
        version: "1.2.3",
        fingerprint: fingerprintFor(2),
      },
      historyBackend: {
        name: "git",
        version: "2.47.1.windows.2",
        renamePolicyRevision: "diff-tree-renames-50-myers-v1",
      },
      metricConfigurationFingerprint: fingerprintFor(3),
      selectionFingerprint: fingerprintFor(4),
    },
    baseline: {
      commit: commit(0),
      model: model(),
    },
    deltas: Array.from(
      { length: frameCount - 1 },
      (_, offset) => ({
        commit: commit(offset + 1),
        changes: emptyChanges(),
      }),
    ),
  };
}
