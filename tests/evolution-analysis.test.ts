import { describe, expect, it } from "vitest";

import {
  analyzeRepositorySnapshotFacts,
  createHistoryEvolution,
  GENERIC_GIT_HISTORY_RENAME_POLICY_REVISION,
  HistoryEvolutionError,
  selectHistory,
  type HistoryCommit,
  type HistoryEvolutionFrameInput,
  type HistorySelectionRequest,
  type LocalAnalysisFacts,
} from "../packages/analyzer/src/index.js";
import {
  replayEvolutionBundle,
  serializeEvolutionBundle,
} from "../packages/core/src/index.js";

const A = "1111111111111111111111111111111111111111";
const B = "2222222222222222222222222222222222222222";
const C = "3333333333333333333333333333333333333333";
const LARGE_SPARSE_MODULE_COUNT = 10_000;

const COMMITS = Object.freeze({
  a: Object.freeze({
    sha: A,
    parents: Object.freeze([]),
    committedAt: "2025-01-01T00:00:00.000Z",
  }),
  b: Object.freeze({
    sha: B,
    parents: Object.freeze([A]),
    committedAt: "2025-01-02T00:00:00.000Z",
  }),
  c: Object.freeze({
    sha: C,
    parents: Object.freeze([B]),
    committedAt: "2025-01-03T00:00:00.000Z",
  }),
});

async function facts(
  sources: Readonly<Record<string, string>>,
): Promise<LocalAnalysisFacts> {
  const config = '{"compilerOptions":{}}';
  return await analyzeRepositorySnapshotFacts([
    {
      name: "Example",
      files: [
        {
          path: "tsconfig.json",
          text: config,
          byteLength: Buffer.byteLength(config, "utf8"),
        },
        ...Object.entries(sources).map(([path, text]) => ({
          path,
          text,
          byteLength: Buffer.byteLength(text, "utf8"),
        })),
      ],
      diagnostics: [],
    },
  ]);
}

function sparseModuleFacts(moduleCount: number): LocalAnalysisFacts {
  const solutionIds = Object.freeze([]) as readonly string[];
  return Object.freeze({
    repositories: Object.freeze([
      Object.freeze({
        id: "raw-repository",
        name: "Large sparse repository",
      }),
    ]),
    solutions: Object.freeze([]),
    modules: Object.freeze(
      Array.from({ length: moduleCount }, (_, index) => {
        const suffix = index.toString().padStart(5, "0");
        return Object.freeze({
          id: `module-${suffix}`,
          repositoryId: "raw-repository",
          kind: "unassigned" as const,
          name: `Module ${suffix}`,
          path: `modules/${suffix}`,
          solutionIds,
        });
      }),
    ),
    sources: Object.freeze([]),
    dependencies: Object.freeze([]),
    warnings: Object.freeze([]),
  });
}

function manySmallDistrictFacts(
  districtCount: number,
  buildingCount: number,
): LocalAnalysisFacts {
  const modules = Array.from({ length: districtCount }, (_, index) => {
    const suffix = index.toString().padStart(3, "0");
    return Object.freeze({
      id: `module-${suffix}`,
      repositoryId: "raw-repository",
      kind: "unassigned" as const,
      name: `Module ${suffix}`,
      path: `modules/${suffix}`,
      solutionIds: Object.freeze([]) as readonly string[],
    });
  });
  return Object.freeze({
    repositories: Object.freeze([
      Object.freeze({
        id: "raw-repository",
        name: "Many-district repository",
      }),
    ]),
    solutions: Object.freeze([]),
    modules: Object.freeze(modules),
    sources: Object.freeze(
      modules.flatMap((module) =>
        Array.from({ length: buildingCount }, (_, index) => {
          const suffix = index.toString().padStart(2, "0");
          return Object.freeze({
            id: `${module.id}-source-${suffix}`,
            repositoryId: module.repositoryId,
            moduleId: module.id,
            districtId: module.id,
            districtName: module.name,
            districtPath: module.path,
            name: `${suffix}.ts`,
            path: `${module.path}/${suffix}.ts`,
            language: "typescript" as const,
            metrics: Object.freeze({
              sloc: 1,
              decisionLoad: 0,
              maximumComplexity: 1,
              executableUnitCount: 1,
            }),
            metricMethod: "typescript-compiler-api-v1" as const,
            units: Object.freeze([
              Object.freeze({
                name: "module",
                line: 1,
                complexity: 1,
              }),
            ]),
            risk: "low" as const,
            semanticGroupId: "risk-low",
            imports: Object.freeze([]),
          });
        }),
      ),
    ),
    dependencies: Object.freeze([]),
    warnings: Object.freeze([]),
  });
}

function denseSolutionFacts(solutionCount: number): LocalAnalysisFacts {
  const solutionIds = Object.freeze(
    Array.from(
      { length: solutionCount },
      (_, index) => `solution-${index.toString().padStart(3, "0")}`,
    ),
  );
  return Object.freeze({
    repositories: Object.freeze([
      Object.freeze({
        id: "raw-repository",
        name: "Dense solution repository",
      }),
    ]),
    solutions: Object.freeze(
      solutionIds.map((id) =>
        Object.freeze({
          id,
          repositoryId: "raw-repository",
          name: id,
          path: `${id}.sln`,
          moduleIds: Object.freeze(["shared-module"]),
        }),
      ),
    ),
    modules: Object.freeze([
      Object.freeze({
        id: "shared-module",
        repositoryId: "raw-repository",
        kind: "unassigned" as const,
        name: "Shared module",
        path: "shared-module",
        solutionIds,
      }),
    ]),
    sources: Object.freeze([]),
    dependencies: Object.freeze([]),
    warnings: Object.freeze([]),
  });
}

function relationshipHeavyFacts(
  referenceCount: number,
): LocalAnalysisFacts {
  const repeatedSolutionIds = Object.freeze(
    Array.from({ length: referenceCount }, () => "solution"),
  );
  return Object.freeze({
    repositories: Object.freeze([
      Object.freeze({
        id: "raw-repository",
        name: "Relationship-heavy repository",
      }),
    ]),
    solutions: Object.freeze([
      Object.freeze({
        id: "solution",
        repositoryId: "raw-repository",
        name: "Solution",
        path: "solution.sln",
        moduleIds: Object.freeze(["module"]),
      }),
    ]),
    modules: Object.freeze([
      Object.freeze({
        id: "module",
        repositoryId: "raw-repository",
        kind: "unassigned" as const,
        name: "Module",
        path: "module",
        solutionIds: repeatedSolutionIds,
      }),
    ]),
    sources: Object.freeze([]),
    dependencies: Object.freeze([]),
    warnings: Object.freeze([]),
  });
}

function selection(
  newestFirst: readonly HistoryCommit[],
  request: HistorySelectionRequest,
) {
  return selectHistory(newestFirst, request);
}

function evolve(
  selected: ReturnType<typeof selectHistory>,
  frames: readonly HistoryEvolutionFrameInput[],
  changesByCommit: ReadonlyMap<
    string,
    readonly (
      | {
          readonly kind:
            | "added"
            | "deleted"
            | "modified"
            | "type-changed";
          readonly path: string;
        }
      | {
          readonly kind: "renamed";
          readonly previousPath: string;
          readonly path: string;
        }
    )[]
  >,
  now?: () => number,
  signal?: AbortSignal,
) {
  return createHistoryEvolution({
    repositoryIdentity: "https://example.invalid/org/example.git",
    selection: selected,
    changesByCommit,
    frames,
    analyzerFingerprint: "semantic-analyzer-test-v1",
    historyBackend: {
      name: "git",
      version: "2.47.1.windows.2",
      renamePolicyRevision:
        GENERIC_GIT_HISTORY_RENAME_POLICY_REVISION,
    },
    metricConfiguration: {
      geometry: "default-v1",
      metrics: "default-v1",
    },
    ...(now === undefined ? {} : { now }),
    ...(signal === undefined ? {} : { signal }),
  });
}

describe("history evolution analysis", () => {
  it("keeps a building lineage and placement across an exact Git rename", async () => {
    const before = await facts({
      "src/old-name.ts": "export const answer = 42;\n",
    });
    const after = await facts({
      "src/new-name.ts": "export const answer = 42;\n",
    });
    const selected = selection([COMMITS.b, COMMITS.a], {
      mode: "commit-count",
      commitCount: 2,
    });
    const result = evolve(
      selected,
      [
        { commit: COMMITS.a, facts: before },
        { commit: COMMITS.b, facts: after },
      ],
      new Map([
        [
          B,
          [
            {
              kind: "renamed" as const,
              previousPath: "src/old-name.ts",
              path: "src/new-name.ts",
            },
          ],
        ],
      ]),
    );

    expect(result.preparedSerialization?.bundle).toBe(result.bundle);
    expect(result.preparedSerialization?.measuredBytes).toBe(
      serializeEvolutionBundle(result.bundle).byteLength,
    );
    const replayed = [...replayEvolutionBundle(result.bundle)];
    expect(replayed).toHaveLength(2);
    expect(replayed[0]!.model.buildings[0]!.id).toBe(
      replayed[1]!.model.buildings[0]!.id,
    );
    expect(replayed[0]!.model.buildings[0]!.position).toEqual(
      replayed[1]!.model.buildings[0]!.position,
    );
    expect(
      result.bundle.deltas[0]!.changes.buildings.changed[0]!
        .changeKinds,
    ).toEqual(["renamed", "moved"]);
  });

  it("reserves union-layout space so additions do not move unchanged buildings", async () => {
    const before = await facts({
      "src/a.ts": "export const a = 1;\n",
    });
    const after = await facts({
      "src/a.ts": "export const a = 1;\n",
      "src/b.ts": "export const b = 2;\n",
    });
    const selected = selection([COMMITS.b, COMMITS.a], {
      mode: "commit-count",
      commitCount: 2,
    });
    const result = evolve(
      selected,
      [
        { commit: COMMITS.a, facts: before },
        { commit: COMMITS.b, facts: after },
      ],
      new Map([
        [B, [{ kind: "added" as const, path: "src/b.ts" }]],
      ]),
    );
    const frames = [...replayEvolutionBundle(result.bundle)];
    const originalId = frames[0]!.model.buildings[0]!.id;
    const unchanged = frames[1]!.model.buildings.find(
      ({ id }) => id === originalId,
    );

    expect(unchanged?.position).toEqual(
      frames[0]!.model.buildings[0]!.position,
    );
    expect(result.bundle.deltas[0]!.changes.buildings.added).toHaveLength(
      1,
    );
    expect(result.bundle.deltas[0]!.changes.buildings.removed).toEqual(
      [],
    );
  });

  it("does not reuse a building identity after deletion and re-addition", async () => {
    const present = await facts({
      "src/value.ts": "export const value = 1;\n",
    });
    const absent = await facts({});
    const selected = selection(
      [COMMITS.c, COMMITS.b, COMMITS.a],
      {
        mode: "commit-count",
        commitCount: 3,
      },
    );
    const result = evolve(
      selected,
      [
        { commit: COMMITS.a, facts: present },
        { commit: COMMITS.b, facts: absent },
        { commit: COMMITS.c, facts: present },
      ],
      new Map([
        [B, [{ kind: "deleted" as const, path: "src/value.ts" }]],
        [C, [{ kind: "added" as const, path: "src/value.ts" }]],
      ]),
    );
    const frames = [...replayEvolutionBundle(result.bundle)];

    expect(frames[0]!.model.buildings[0]!.id).not.toBe(
      frames[2]!.model.buildings[0]!.id,
    );
    expect(result.bundle.deltas[0]!.changes.buildings.removed).toEqual([
      frames[0]!.model.buildings[0]!.id,
    ]);
    expect(result.bundle.deltas[1]!.changes.buildings.added[0]!.id).toBe(
      frames[2]!.model.buildings[0]!.id,
    );
  });

  it("applies rename lineage changes from unsampled commits", async () => {
    const before = await facts({
      "src/a.ts": "export const stable = true;\n",
    });
    const after = await facts({
      "src/b.ts": "export const stable = true;\n",
    });
    const selected = selection(
      [COMMITS.c, COMMITS.b, COMMITS.a],
      {
        mode: "commit-count",
        commitCount: 3,
        sampleEvery: 2,
      },
    );
    const result = evolve(
      selected,
      [
        { commit: COMMITS.a, facts: before },
        { commit: COMMITS.c, facts: after },
      ],
      new Map([
        [
          B,
          [
            {
              kind: "renamed" as const,
              previousPath: "src/a.ts",
              path: "src/b.ts",
            },
          ],
        ],
        [C, [{ kind: "modified" as const, path: "src/b.ts" }]],
      ]),
    );
    const frames = [...replayEvolutionBundle(result.bundle)];

    expect(frames[0]!.model.buildings[0]!.id).toBe(
      frames[1]!.model.buildings[0]!.id,
    );
  });

  it("serializes deterministically and enforces caller-lowered bounds", async () => {
    const snapshot = await facts({
      "src/a.ts": "export function value(flag: boolean) { return flag ? 1 : 0; }\n",
    });
    const ordinary = selection([COMMITS.a], {
      mode: "commit-count",
      commitCount: 1,
    });
    const first = evolve(
      ordinary,
      [{ commit: COMMITS.a, facts: snapshot }],
      new Map(),
    );
    const second = evolve(
      ordinary,
      [{ commit: COMMITS.a, facts: snapshot }],
      new Map(),
    );
    expect(Buffer.from(serializeEvolutionBundle(first.bundle))).toEqual(
      Buffer.from(serializeEvolutionBundle(second.bundle)),
    );
    expect(first.bundle.provenance.historyBackend).toEqual({
      name: "git",
      version: "2.47.1.windows.2",
      renamePolicyRevision:
        GENERIC_GIT_HISTORY_RENAME_POLICY_REVISION,
    });

    const bounded = selection([COMMITS.a], {
      mode: "commit-count",
      commitCount: 1,
      maxAggregateTreeEntries: 1,
    });
    expect(() =>
      evolve(
        bounded,
        [{ commit: COMMITS.a, facts: snapshot }],
        new Map(),
      ),
    ).toThrowError(
      expect.objectContaining<Partial<HistoryEvolutionError>>({
        code: "limit-exceeded",
      }),
    );

    const lineageBound = selection([COMMITS.a], {
      mode: "commit-count",
      commitCount: 1,
      maxUniqueLineages: 1,
    });
    expect(() =>
      evolve(
        lineageBound,
        [{ commit: COMMITS.a, facts: snapshot }],
        new Map(),
      ),
    ).toThrowError(
      expect.objectContaining<Partial<HistoryEvolutionError>>({
        code: "limit-exceeded",
      }),
    );

    const outputBound = selection([COMMITS.a], {
      mode: "commit-count",
      commitCount: 1,
      maxEvolutionOutputBytes: 1,
    });
    expect(() =>
      evolve(
        outputBound,
        [{ commit: COMMITS.a, facts: snapshot }],
        new Map(),
      ),
    ).toThrowError(
      expect.objectContaining<Partial<HistoryEvolutionError>>({
        code: "limit-exceeded",
      }),
    );

    const changedPathBound = selection(
      [COMMITS.b, COMMITS.a],
      {
        mode: "commit-count",
        commitCount: 2,
        maxAggregateChangedPaths: 1,
      },
    );
    expect(() =>
      evolve(
        changedPathBound,
        [
          { commit: COMMITS.a, facts: snapshot },
          { commit: COMMITS.b, facts: snapshot },
        ],
        new Map([
          [
            B,
            [
              {
                kind: "renamed" as const,
                previousPath: "src/a.ts",
                path: "src/b.ts",
              },
            ],
          ],
        ]),
      ),
    ).toThrowError(
      expect.objectContaining<Partial<HistoryEvolutionError>>({
        code: "limit-exceeded",
      }),
    );

    const changedPathByteBound = selection(
      [COMMITS.b, COMMITS.a],
      {
        mode: "commit-count",
        commitCount: 2,
        maxAggregateChangedPathBytes: 5,
      },
    );
    expect(() =>
      evolve(
        changedPathByteBound,
        [
          { commit: COMMITS.a, facts: snapshot },
          { commit: COMMITS.b, facts: snapshot },
        ],
        new Map([
          [B, [{ kind: "modified" as const, path: "src/a.ts" }]],
        ]),
      ),
    ).toThrowError(
      expect.objectContaining<Partial<HistoryEvolutionError>>({
        code: "limit-exceeded",
      }),
    );
  });

  it(
    "uses bounded packing for every many-district evolution layout",
    () => {
      const snapshot = manySmallDistrictFacts(24, 32);
      const selected = selection([COMMITS.a], {
        mode: "commit-count",
        commitCount: 1,
        maxAggregateTreeEntries: 5_000,
        maxUniqueLineages: 5_000,
      });
      const first = evolve(
        selected,
        [{ commit: COMMITS.a, facts: snapshot }],
        new Map(),
      );
      const second = evolve(
        selected,
        [{ commit: COMMITS.a, facts: snapshot }],
        new Map(),
      );

      expect(first.model.districts).toHaveLength(24);
      expect(first.model.buildings).toHaveLength(24 * 32);
      expect(Buffer.from(serializeEvolutionBundle(first.bundle))).toEqual(
        Buffer.from(serializeEvolutionBundle(second.bundle)),
      );
    },
    30_000,
  );

  it(
    "matches ten thousand stable sparse modules without quadratic pair scanning",
    () => {
      const snapshot = sparseModuleFacts(LARGE_SPARSE_MODULE_COUNT);
      const selected = selection([COMMITS.b, COMMITS.a], {
        mode: "commit-count",
        commitCount: 2,
        maxAggregateTreeEntries: 25_000,
        maxUniqueLineages: 25_000,
      });
      const result = evolve(
        selected,
        [
          { commit: COMMITS.a, facts: snapshot },
          { commit: COMMITS.b, facts: snapshot },
        ],
        new Map([[B, []]]),
      );

      expect(result.bundle.baseline.model.modules).toHaveLength(
        LARGE_SPARSE_MODULE_COUNT,
      );
      expect(result.bundle.deltas[0]!.changes.modules).toEqual({
        added: [],
        removed: [],
        changed: [],
      });
    },
    30_000,
  );

  it(
    "checks the total deadline from inside bounded identity matching work",
    () => {
      const snapshot = sparseModuleFacts(LARGE_SPARSE_MODULE_COUNT);
      const selected = selection([COMMITS.b, COMMITS.a], {
        mode: "commit-count",
        commitCount: 2,
        totalDeadlineMs: 1_000,
        maxAggregateTreeEntries: 25_000,
        maxUniqueLineages: 25_000,
      });
      let clock = 0;
      const now = (): number => {
        clock += 10;
        return clock;
      };

      expect(() =>
        evolve(
          selected,
          [
            { commit: COMMITS.a, facts: snapshot },
            { commit: COMMITS.b, facts: snapshot },
          ],
          new Map([[B, []]]),
          now,
        ),
      ).toThrowError(
        expect.objectContaining<Partial<HistoryEvolutionError>>({
          code: "deadline-exceeded",
        }),
      );
      expect(clock).toBeGreaterThan(1_000);
    },
    30_000,
  );

  it(
    "observes cancellation from inside large synchronous evolution work",
    () => {
      const snapshot = sparseModuleFacts(LARGE_SPARSE_MODULE_COUNT);
      const selected = selection([COMMITS.b, COMMITS.a], {
        mode: "commit-count",
        commitCount: 2,
        maxAggregateTreeEntries: 25_000,
        maxUniqueLineages: 25_000,
      });
      const controller = new AbortController();
      let checks = 0;
      const now = (): number => {
        checks += 1;
        if (checks === 50) controller.abort();
        return 0;
      };

      expect(() =>
        evolve(
          selected,
          [
            { commit: COMMITS.a, facts: snapshot },
            { commit: COMMITS.b, facts: snapshot },
          ],
          new Map([[B, []]]),
          now,
          controller.signal,
        ),
      ).toThrowError(
        expect.objectContaining<Partial<HistoryEvolutionError>>({
          code: "deadline-exceeded",
        }),
      );
      expect(checks).toBe(50);
    },
    30_000,
  );

  it("rejects a dense identity candidate graph at its derived work bound", () => {
    const snapshot = denseSolutionFacts(11);
    const selected = selection([COMMITS.b, COMMITS.a], {
      mode: "commit-count",
      commitCount: 2,
      maxAggregateTreeEntries: 100,
      maxUniqueLineages: 100,
    });

    expect(() =>
      evolve(
        selected,
        [
          { commit: COMMITS.a, facts: snapshot },
          { commit: COMMITS.b, facts: snapshot },
        ],
        new Map([[B, []]]),
      ),
    ).toThrowError(
      expect.objectContaining<Partial<HistoryEvolutionError>>({
        code: "limit-exceeded",
      }),
    );
  });

  it("caps nested synchronous relationship work not represented by tree counts", () => {
    const selected = selection([COMMITS.a], {
      mode: "commit-count",
      commitCount: 1,
      maxAggregateChangedPaths: 1,
      maxAggregateTreeEntries: 3,
      maxUniqueLineages: 100,
    });

    expect(() =>
      evolve(
        selected,
        [
          {
            commit: COMMITS.a,
            facts: relationshipHeavyFacts(3_000),
          },
        ],
        new Map(),
      ),
    ).toThrowError(
      expect.objectContaining<Partial<HistoryEvolutionError>>({
        code: "limit-exceeded",
      }),
    );
  });
});
