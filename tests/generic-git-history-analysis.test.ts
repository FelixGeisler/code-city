import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_VERSIONED_METRIC_MAPPING,
  resolveMetricMappingPreset,
  type CityModel,
  type EvolutionBundle,
} from "../packages/core/src/index.js";
import {
  analyzeGenericGitHistory,
  HISTORY_SEMANTIC_ANALYZER_FINGERPRINT_MAX_CHARACTERS,
  type GenericGitHistoryAnalysisRequest,
  type GenericGitHistoryRepositoryProvider,
  type HistorySemanticCacheLike,
  type HistorySemanticCacheRequestLike,
} from "../packages/analyzer/src/generic-git-history-analysis.js";
import type {
  HistoryEvolutionRequest,
  HistoryEvolutionResult,
} from "../packages/analyzer/src/evolution-analysis.js";
import {
  GENERIC_GIT_HISTORY_RENAME_POLICY_REVISION,
  type GenericGitHistoryPathChange,
  type GenericGitHistoryRequest,
  type GenericGitHistorySession,
} from "../packages/analyzer/src/git-snapshot.js";
import { HISTORY_SELECTION_LIMITS } from "../packages/analyzer/src/history-selection.js";
import type { RepositorySnapshot } from "../packages/analyzer/src/snapshot.js";
import type { LocalAnalysisFacts } from "../packages/analyzer/src/types.js";

const REMOTE =
  "https://dev.azure.example/Collection/Project/_git/History";
const DAY_MS = 24 * 60 * 60 * 1_000;

function sha(value: number): string {
  return value.toString(16).padStart(40, "0");
}

function commits(count: number) {
  return Object.freeze(
    Array.from({ length: count }, (_, index) => {
      const value = count - index;
      return Object.freeze({
        sha: sha(value),
        parents: Object.freeze(value === 1 ? [] : [sha(value - 1)]),
        committedAt: new Date(
          Date.UTC(2025, 0, 1) + (value - 1) * DAY_MS,
        ).toISOString(),
      });
    }),
  );
}

function facts(
  name: string,
  options: {
    readonly identity?: boolean;
    readonly sources?: number;
    readonly units?: number;
    readonly warningCharacters?: number;
  } = {},
): LocalAnalysisFacts {
  return {
    ...(options.identity
      ? { identity: { title: `Private ${name}` } }
      : {}),
    repositories: [
      {
        id: `repository:${name}`,
        name,
      },
    ],
    solutions: [],
    modules: [],
    sources: Array.from(
      { length: options.sources ?? 0 },
      (_, index) =>
        ({
          id: `source:${name}:${index}`,
          repositoryId: `repository:${name}`,
          moduleId: `module:${name}`,
          districtId: `district:${name}`,
          districtName: "src",
          districtPath: "src",
          name: `${index}.ts`,
          path: `src/${index}.ts`,
          language: "typescript",
          metrics: {
            sloc: 1,
            decisionLoad: 0,
            maximumComplexity: 1,
            executableUnitCount: 0,
          },
          metricMethod: "typescript-compiler-api-v1",
          units: Array.from(
            { length: options.units ?? 0 },
            (_, unitIndex) => ({
              name: `unit-${unitIndex}`,
              line: unitIndex + 1,
              complexity: 1,
            }),
          ),
          risk: "low",
          semanticGroupId: "typescript",
          imports: [],
        }) as LocalAnalysisFacts["sources"][number],
    ),
    dependencies: [],
    warnings:
      options.warningCharacters === undefined
        ? []
        : ["w".repeat(options.warningCharacters)],
  };
}

function snapshot(
  commitSha: string,
  fileCount = 1,
): RepositorySnapshot {
  return {
    name: "History",
    files: Array.from({ length: fileCount }, (_, index) => ({
      path: `src/${commitSha.slice(-4)}-${index}.ts`,
      text: `export const value${index} = ${index};\n`,
      byteLength: 30,
    })),
    diagnostics: [],
  };
}

const FINAL_MODEL = Object.freeze({
  marker: "final-model",
}) as unknown as CityModel;

function evolutionResult(
  _request: HistoryEvolutionRequest,
): HistoryEvolutionResult {
  return Object.freeze({
    repositoryId: "history-repository:test",
    model: FINAL_MODEL,
    bundle: Object.freeze({}) as EvolutionBundle,
  });
}

interface SessionHarness {
  readonly session: GenericGitHistorySession;
  readonly readChanges: ReturnType<typeof vi.fn>;
  readonly readSnapshot: ReturnType<typeof vi.fn>;
}

function sessionHarness(
  count: number,
  options: {
    readonly tags?: GenericGitHistorySession["tags"];
    readonly change?: (
      commitSha: string,
    ) => readonly GenericGitHistoryPathChange[];
    readonly snapshotFiles?: number;
    readonly backendVersion?: string;
  } = {},
): SessionHarness {
  const history = commits(count);
  const readChanges = vi.fn(async (commitSha: string) =>
    Object.freeze([
      ...(options.change?.(commitSha) ?? [
        { kind: "modified" as const, path: "src/main.ts" },
      ]),
    ]),
  );
  const readSnapshot = vi.fn(async (commitSha: string) =>
    snapshot(commitSha, options.snapshotFiles),
  );
  return {
    session: Object.freeze({
      repository: "History",
      tipSha: history[0]!.sha,
      transport: "https",
      backend: Object.freeze({
        name: "git",
        version: options.backendVersion ?? "2.47.1.windows.2",
        renamePolicyRevision:
          GENERIC_GIT_HISTORY_RENAME_POLICY_REVISION,
      }),
      commits: history,
      tags: options.tags ?? Object.freeze([]),
      readChanges,
      readSnapshot,
    }),
    readChanges,
    readSnapshot,
  };
}

interface ProviderHarness {
  readonly provider: GenericGitHistoryRepositoryProvider;
  readonly requests: GenericGitHistoryRequest[];
}

function providerHarness(
  session: GenericGitHistorySession,
  beforeConsumer?: () => void,
): ProviderHarness {
  const requests: GenericGitHistoryRequest[] = [];
  const provider: GenericGitHistoryRepositoryProvider = async <T>(
    request: GenericGitHistoryRequest,
    consumer: (value: GenericGitHistorySession) => Promise<T>,
  ): Promise<T> => {
    requests.push(request);
    beforeConsumer?.();
    return await consumer(session);
  };
  return { provider, requests };
}

function request(
  selection: GenericGitHistoryAnalysisRequest["selection"] = {
    mode: "commit-count",
    commitCount: 3,
  },
): GenericGitHistoryAnalysisRequest {
  return {
    repositoryUrl: REMOTE,
    repositoryIdentity: REMOTE,
    selection,
  };
}

interface CacheLeaseState {
  readonly commitSha: string;
  released: boolean;
}

function cacheHarness(
  initial: ReadonlyMap<string, LocalAnalysisFacts> = new Map(),
): {
  readonly cache: HistorySemanticCacheLike;
  readonly values: Map<string, LocalAnalysisFacts>;
  readonly requests: HistorySemanticCacheRequestLike[];
  readonly leases: CacheLeaseState[];
  readonly active: () => number;
} {
  const values = new Map(initial);
  const requests: HistorySemanticCacheRequestLike[] = [];
  const leases: CacheLeaseState[] = [];
  const cache: HistorySemanticCacheLike = {
    async acquire(cacheRequest, compute) {
      requests.push(cacheRequest);
      const hit = values.has(cacheRequest.commitSha);
      if (!hit) values.set(cacheRequest.commitSha, await compute());
      const state: CacheLeaseState = {
        commitSha: cacheRequest.commitSha,
        released: false,
      };
      leases.push(state);
      return {
        hit,
        read: async () => values.get(cacheRequest.commitSha)!,
        release: () => {
          state.released = true;
        },
      };
    },
  };
  return {
    cache,
    values,
    requests,
    leases,
    active: () => leases.filter(({ released }) => !released).length,
  };
}

describe("Generic Git history analysis orchestration", () => {
  it("resumes from semantic cache hits and pins every lease through evolution", async () => {
    const session = sessionHarness(3);
    const provider = providerHarness(session.session);
    const cache = cacheHarness(
      new Map([[sha(1), facts("cached-oldest", { identity: true })]]),
    );
    const analyzeSnapshot = vi.fn(async (value: RepositorySnapshot) =>
      facts(value.files[0]!.path, { identity: true }),
    );
    const createEvolution = vi.fn(
      (value: HistoryEvolutionRequest) => {
        expect(cache.active()).toBe(3);
        expect(
          value.frames.every(({ facts: semanticFacts }) =>
            semanticFacts.identity?.title === "History City",
          ),
        ).toBe(true);
        return evolutionResult(value);
      },
    );

    const first = await analyzeGenericGitHistory(
      request(),
      {
        analyzerFingerprint: "test-semantic-v1",
        metricConfiguration: { metrics: ["loc", "complexity"] },
        identity: {
          title: "  History City  ",
          version: " v1 ",
          logo: "assets/logo.svg",
        },
      },
      {
        withHistoryRepository: provider.provider,
        semanticCache: cache.cache,
        analyzeSnapshot,
        createEvolution,
      },
    );

    expect(first.model).toBe(FINAL_MODEL);
    expect(first.cacheHits).toBe(1);
    expect(first.cacheMisses).toBe(2);
    expect(session.readSnapshot).toHaveBeenCalledTimes(2);
    expect(analyzeSnapshot).toHaveBeenCalledTimes(2);
    expect(cache.leases.every(({ released }) => released)).toBe(true);
    expect(
      cache.values.get(sha(2)),
    ).not.toHaveProperty("identity");
    expect(cache.requests[0]).toMatchObject({
      repositoryIdentity: REMOTE,
      analyzerFingerprint: expect.stringMatching(
        /^sha256:[0-9a-f]{64}$/u,
      ),
      configuration: {
        metricConfiguration: {
          metrics: ["loc", "complexity"],
        },
        snapshotOptions: {
          maxEntries: 100_000,
          maxRetainedFiles: 50_000,
          maxSourceBuildings: 25_000,
          maxFileBytes: 2 * 1024 * 1024,
          maxTotalBytes: 256 * 1024 * 1024,
          maxDiagnostics: 1_000,
        },
      },
    });
    const cachedConfiguration = JSON.stringify(
      cache.requests[0]!.configuration,
    );
    expect(cachedConfiguration).not.toContain(REMOTE);
    expect(cachedConfiguration).not.toContain("totalDeadline");
    expect(cachedConfiguration).not.toContain("History City");

    session.readSnapshot.mockClear();
    analyzeSnapshot.mockClear();
    const second = await analyzeGenericGitHistory(
      request(),
      {
        analyzerFingerprint: "test-semantic-v1",
        metricConfiguration: { metrics: ["loc", "complexity"] },
        identity: {
          title: "History City",
          version: "v1",
          logo: "assets/logo.svg",
        },
      },
      {
        withHistoryRepository: provider.provider,
        semanticCache: cache.cache,
        analyzeSnapshot,
        createEvolution,
      },
    );

    expect(second.cacheHits).toBe(3);
    expect(second.cacheMisses).toBe(0);
    expect(session.readSnapshot).not.toHaveBeenCalled();
    expect(analyzeSnapshot).not.toHaveBeenCalled();
    expect(cache.leases.every(({ released }) => released)).toBe(true);
  });

  it("separates semantic cache provenance across Git backend versions", async () => {
    const cache = cacheHarness();
    for (const backendVersion of ["2.46.0", "2.47.0"]) {
      const session = sessionHarness(1, { backendVersion });
      const provider = providerHarness(session.session);
      await analyzeGenericGitHistory(
        request({
          mode: "commit-count",
          commitCount: 1,
        }),
        {
          analyzerFingerprint: "semantic-v1",
        },
        {
          withHistoryRepository: provider.provider,
          semanticCache: cache.cache,
          analyzeSnapshot: async () => facts(backendVersion),
          createEvolution: evolutionResult,
        },
      );
    }

    expect(cache.requests).toHaveLength(2);
    expect(cache.requests[0]!.analyzerFingerprint).toMatch(
      /^sha256:[0-9a-f]{64}$/u,
    );
    expect(cache.requests[1]!.analyzerFingerprint).toMatch(
      /^sha256:[0-9a-f]{64}$/u,
    );
    expect(cache.requests[0]!.analyzerFingerprint).not.toBe(
      cache.requests[1]!.analyzerFingerprint,
    );
  });

  it("separates semantic cache configuration across metric mappings", async () => {
    const configurations: unknown[] = [];
    const semanticCache: HistorySemanticCacheLike = {
      async acquire(cacheRequest, compute) {
        configurations.push(cacheRequest.configuration);
        const value = await compute();
        return {
          hit: false,
          read: async () => value,
          release: () => undefined,
        };
      },
    };
    for (const mapping of [
      DEFAULT_VERSIONED_METRIC_MAPPING,
      resolveMetricMappingPreset("maintenance"),
    ]) {
      const session = sessionHarness(1);
      const provider = providerHarness(session.session);
      await analyzeGenericGitHistory(
        request({
          mode: "commit-count",
          commitCount: 1,
        }),
        { metricConfiguration: { metricMapping: mapping } },
        {
          withHistoryRepository: provider.provider,
          semanticCache,
          analyzeSnapshot: async () => facts(mapping.id),
          createEvolution: evolutionResult,
        },
      );
    }

    expect(configurations).toHaveLength(2);
    expect(configurations[0]).toMatchObject({
      metricConfiguration: {
        metricMapping: { id: "complexity" },
      },
    });
    expect(configurations[1]).toMatchObject({
      metricConfiguration: {
        metricMapping: { id: "maintenance" },
      },
    });
    expect(JSON.stringify(configurations[0])).not.toBe(
      JSON.stringify(configurations[1]),
    );
  });

  it("reads unsampled commit changes while snapshotting only sampled frames", async () => {
    const session = sessionHarness(5);
    const provider = providerHarness(session.session);
    let evolutionRequest: HistoryEvolutionRequest | undefined;

    const result = await analyzeGenericGitHistory(
      request({
        mode: "commit-count",
        commitCount: 5,
        sampleEvery: 2,
        totalDeadlineMs: 2_000,
        maxAggregateChangedPaths: 20,
        maxAggregateChangedPathBytes: 1_000,
        maxAggregateTreeEntries: 30,
        maxUniqueLineages: 40,
        maxEvolutionOutputBytes: 50,
      }),
      {},
      {
        withHistoryRepository: provider.provider,
        analyzeSnapshot: async (_, context) => {
          expect(context.metricConfiguration).toEqual({
            metricMapping: DEFAULT_VERSIONED_METRIC_MAPPING,
          });
          expect(context.analysisOptions.maxFileBytes).toBe(
            2 * 1024 * 1024,
          );
          return facts("frame");
        },
        createEvolution: (value) => {
          evolutionRequest = value;
          return evolutionResult(value);
        },
      },
    );

    expect(
      session.readChanges.mock.calls.map(([commitSha]) => commitSha),
    ).toEqual([sha(2), sha(3), sha(4), sha(5)]);
    expect(
      session.readSnapshot.mock.calls.map(([commitSha]) => commitSha),
    ).toEqual([sha(1), sha(3), sha(5)]);
    expect(evolutionRequest?.changesByCommit.size).toBe(4);
    expect(evolutionRequest?.historyBackend).toEqual(
      session.session.backend,
    );
    expect(evolutionRequest?.analyzerFingerprint).toMatch(
      /^sha256:[0-9a-f]{64}$/u,
    );
    expect(result.selection.summary.sampledCommitShas).toEqual([
      sha(1),
      sha(3),
      sha(5),
    ]);
    expect(result.cacheHits).toBe(0);
    expect(result.cacheMisses).toBe(3);
    expect(result.historyBackend).toBe(session.session.backend);
    expect(result.costEstimate).toEqual({
      traversedCommitCount: 5,
      selectedCommitCount: 5,
      sampledFrameCount: 3,
      maximumChangedPathEntries: 20,
      maximumChangedPathBytes: 1_000,
      maximumSemanticBytes:
        HISTORY_SELECTION_LIMITS.maxAggregateSemanticBytes,
      maximumTreeEntries: 30,
      maximumUniqueLineages: 40,
      maximumOutputBytes: 50,
      totalDeadlineMs: 2_000,
    });
    expect(Object.isFrozen(result.costEstimate)).toBe(true);
  });

  it("snapshots mutable selection input before asynchronous acquisition", async () => {
    const selection = {
      mode: "commit-count" as const,
      commitCount: 2,
      sampleEvery: 1,
      maxAggregateChangedPaths: 10,
    };
    const session = sessionHarness(2);
    const provider = providerHarness(session.session, () => {
      selection.commitCount = 1;
      selection.sampleEvery = 500;
      selection.maxAggregateChangedPaths = 1;
    });

    const result = await analyzeGenericGitHistory(
      request(selection),
      {},
      {
        withHistoryRepository: provider.provider,
        analyzeSnapshot: async () => facts("immutable"),
        createEvolution: evolutionResult,
      },
    );

    expect(provider.requests[0]?.maximumCommits).toBe(2);
    expect(provider.requests[0]?.maximumChangedPathEntries).toBe(10);
    expect(provider.requests[0]?.maximumChangedPathBytes).toBe(
      HISTORY_SELECTION_LIMITS.maxAggregateChangedPathBytes,
    );
    expect(result.selection.selectedCommits).toHaveLength(2);
    expect(result.selection.sampledCommits).toHaveLength(2);
    expect(
      result.selection.analysisBounds.maxAggregateChangedPaths,
    ).toBe(10);
  });

  it("forwards normalized snapshot policy and includes it in semantic cache configuration", async () => {
    const session = sessionHarness(1);
    const provider = providerHarness(session.session);
    const configurations: unknown[] = [];
    const contexts: {
      readonly maxFileBytes: number;
      readonly maxRetainedFiles: number;
    }[] = [];
    const cache: HistorySemanticCacheLike = {
      async acquire(cacheRequest, compute) {
        configurations.push(cacheRequest.configuration);
        const value = await compute();
        return {
          hit: false,
          read: async () => value,
          release: () => undefined,
        };
      },
    };

    for (const maxFileBytes of [1_024, 2_048]) {
      await analyzeGenericGitHistory(
        request({
          mode: "commit-count",
          commitCount: 1,
          totalDeadlineMs: 1_000,
        }),
        {
          metricConfiguration: { metric: "default" },
          analysisOptions: {
            maxEntries: 10,
            maxRetainedFiles: 9,
            maxSourceBuildings: 8,
            maxFileBytes,
            maxTotalBytes: 4_096,
            maxDiagnostics: 7,
          },
        },
        {
          withHistoryRepository: provider.provider,
          semanticCache: cache,
          analyzeSnapshot: async (_, context) => {
            contexts.push({
              maxFileBytes: context.analysisOptions.maxFileBytes,
              maxRetainedFiles:
                context.analysisOptions.maxRetainedFiles,
            });
            return facts("policy");
          },
          createEvolution: evolutionResult,
          now: () => 0,
        },
      );
    }

    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[0]?.snapshotOptions).toEqual({
      maxEntries: 10,
      maxRetainedFiles: 9,
      maxSourceBuildings: 8,
      maxFileBytes: 1_024,
      maxTotalBytes: 4_096,
      maxDiagnostics: 7,
    });
    expect(provider.requests[1]?.snapshotOptions).toEqual({
      maxEntries: 10,
      maxRetainedFiles: 9,
      maxSourceBuildings: 8,
      maxFileBytes: 2_048,
      maxTotalBytes: 4_096,
      maxDiagnostics: 7,
    });
    expect(contexts).toEqual([
      { maxFileBytes: 1_024, maxRetainedFiles: 9 },
      { maxFileBytes: 2_048, maxRetainedFiles: 9 },
    ]);
    expect(configurations).toHaveLength(2);
    expect(configurations[0]).toMatchObject({
      metricConfiguration: { metric: "default" },
      snapshotOptions: { maxFileBytes: 1_024 },
    });
    expect(configurations[1]).toMatchObject({
      metricConfiguration: { metric: "default" },
      snapshotOptions: { maxFileBytes: 2_048 },
    });
    expect(JSON.stringify(configurations[0])).not.toBe(
      JSON.stringify(configurations[1]),
    );
    expect(JSON.stringify(configurations)).not.toContain(
      "totalDeadlineMs",
    );
  });

  it("resolves exact tag names to immutable ancestry boundaries without persisting names", async () => {
    const session = sessionHarness(5, {
      tags: Object.freeze([
        { name: "old", commitSha: sha(2) },
        { name: "new", commitSha: sha(4) },
      ]),
    });
    const provider = providerHarness(session.session);

    const result = await analyzeGenericGitHistory(
      request({
        mode: "tag-range",
        oldestTagName: "old",
        newestTagName: "new",
        maxCommits: 5,
        sampleEvery: 2,
      }),
      {},
      {
        withHistoryRepository: provider.provider,
        analyzeSnapshot: async () => facts("tag-frame"),
        createEvolution: evolutionResult,
      },
    );

    expect(provider.requests[0]?.tagNames).toEqual(["old", "new"]);
    expect(result.selection.selectedCommits.map(({ sha: value }) => value))
      .toEqual([sha(2), sha(3), sha(4)]);
    expect(result.selection.summary).toMatchObject({
      mode: "tag-range",
      resolvedOldestSha: sha(2),
      resolvedNewestSha: sha(4),
    });
    const normalized = JSON.stringify(result.selection.summary);
    expect(normalized).not.toContain('"old"');
    expect(normalized).not.toContain('"new"');
  });

  it("canonicalizes equivalent tag spellings before requesting a same-tag range", async () => {
    const session = sessionHarness(3, {
      tags: Object.freeze([
        { name: "samé", commitSha: sha(2) },
      ]),
    });
    const provider = providerHarness(session.session);

    const result = await analyzeGenericGitHistory(
      request({
        mode: "tag-range",
        oldestTagName: "same\u0301",
        newestTagName: "refs/tags/samé",
        maxCommits: 3,
      }),
      {},
      {
        withHistoryRepository: provider.provider,
        analyzeSnapshot: async () => facts("same-tag"),
        createEvolution: evolutionResult,
      },
    );

    expect(provider.requests[0]?.tagNames).toEqual(["samé"]);
    expect(result.selection.selectedCommits).toHaveLength(1);
    expect(result.selection.summary).toMatchObject({
      mode: "tag-range",
      resolvedOldestSha: sha(2),
      resolvedNewestSha: sha(2),
    });
  });

  it("carries intervening non-date-matching ancestry changes into evolution without changing the public selection", async () => {
    const base = sessionHarness(3, {
      change: (commitSha) =>
        commitSha === sha(2)
          ? [
              {
                kind: "renamed",
                previousPath: "src/old.ts",
                path: "src/middle.ts",
              },
            ]
          : [
              {
                kind: "renamed",
                previousPath: "src/middle.ts",
                path: "src/new.ts",
              },
            ],
    });
    const nonMonotonicCommits = Object.freeze([
      {
        sha: sha(3),
        parents: Object.freeze([sha(2)]),
        committedAt: "2025-01-03T00:00:00.000Z",
      },
      {
        sha: sha(2),
        parents: Object.freeze([sha(1)]),
        committedAt: "2025-01-01T00:00:00.000Z",
      },
      {
        sha: sha(1),
        parents: Object.freeze([]),
        committedAt: "2025-01-02T00:00:00.000Z",
      },
    ]);
    const session = Object.freeze({
      ...base.session,
      commits: nonMonotonicCommits,
    });
    const provider = providerHarness(session);
    let internalSelection:
      | HistoryEvolutionRequest["selection"]
      | undefined;

    const result = await analyzeGenericGitHistory(
      request({
        mode: "date-range",
        fromInclusive: "2025-01-02T00:00:00Z",
        toInclusive: "2025-01-03T00:00:00Z",
        maxCommits: 3,
      }),
      {},
      {
        withHistoryRepository: provider.provider,
        analyzeSnapshot: async () => facts("date-frame"),
        createEvolution: (value) => {
          internalSelection = value.selection;
          return evolutionResult(value);
        },
      },
    );

    expect(
      result.selection.selectedCommits.map(({ sha: value }) => value),
    ).toEqual([sha(1), sha(3)]);
    expect(
      internalSelection?.selectedCommits.map(({ sha: value }) => value),
    ).toEqual([sha(1), sha(2), sha(3)]);
    expect(
      base.readChanges.mock.calls.map(([commitSha]) => commitSha),
    ).toEqual([sha(2), sha(3)]);
    expect(
      base.readSnapshot.mock.calls.map(([commitSha]) => commitSha),
    ).toEqual([sha(1), sha(3)]);
  });

  it("uses the overflow probe without rejecting the maximum commit-count selection", async () => {
    const overflowSession = sessionHarness(501);
    const overflowProvider = providerHarness(overflowSession.session);
    const createEvolution = vi.fn(evolutionResult);

    const result = await analyzeGenericGitHistory(
      request({
        mode: "commit-count",
        commitCount: 500,
        sampleEvery: 500,
      }),
      {},
      {
        withHistoryRepository: overflowProvider.provider,
        analyzeSnapshot: async () => facts("overflow-frame"),
        createEvolution,
      },
    );

    expect(result.selection.summary).toMatchObject({
      requestedCommitCount: 500,
      selectedCommitCount: 500,
      traversedCommitCount: 500,
    });
    expect(result.selection.sampledCommits).toHaveLength(2);
    expect(overflowSession.readChanges).toHaveBeenCalledTimes(499);
    expect(overflowSession.readSnapshot).toHaveBeenCalledTimes(2);
    expect(createEvolution).toHaveBeenCalledOnce();
  });

  it("rejects incomplete bounded date and tag ranges before reading repository data", async () => {
    const dateSession = sessionHarness(4);
    const dateProvider = providerHarness(dateSession.session);
    const createEvolution = vi.fn(evolutionResult);
    await expect(
      analyzeGenericGitHistory(
        request({
          mode: "date-range",
          fromInclusive: "2025-01-03T00:00:00Z",
          toInclusive: "2025-01-04T00:00:00Z",
          maxCommits: 3,
        }),
        {},
        {
          withHistoryRepository: dateProvider.provider,
          analyzeSnapshot: async () => facts("never"),
          createEvolution,
        },
      ),
    ).rejects.toMatchObject({ code: "limit-exceeded" });
    expect(dateSession.readChanges).not.toHaveBeenCalled();
    expect(dateSession.readSnapshot).not.toHaveBeenCalled();

    const tagSession = sessionHarness(4, {
      tags: Object.freeze([
        Object.freeze({ name: "old", commitSha: sha(1) }),
        Object.freeze({ name: "new", commitSha: sha(4) }),
      ]),
    });
    const tagProvider = providerHarness(tagSession.session);
    await expect(
      analyzeGenericGitHistory(
        request({
          mode: "tag-range",
          oldestTagName: "old",
          newestTagName: "new",
          maxCommits: 3,
        }),
        {},
        {
          withHistoryRepository: tagProvider.provider,
          analyzeSnapshot: async () => facts("never"),
          createEvolution,
        },
      ),
    ).rejects.toMatchObject({ code: "limit-exceeded" });
    expect(tagSession.readChanges).not.toHaveBeenCalled();
    expect(tagSession.readSnapshot).not.toHaveBeenCalled();
    expect(createEvolution).not.toHaveBeenCalled();
  });

  it("rejects lowered changed-path bounds before reading snapshots", async () => {
    const createEvolution = vi.fn(evolutionResult);
    const changedSession = sessionHarness(2, {
      change: () => [
        {
          kind: "renamed",
          previousPath: "src/old.ts",
          path: "src/new.ts",
        },
      ],
    });
    const changedProvider = providerHarness(changedSession.session);
    await expect(
      analyzeGenericGitHistory(
        request({
          mode: "commit-count",
          commitCount: 2,
          maxAggregateChangedPaths: 1,
        }),
        {},
        {
          withHistoryRepository: changedProvider.provider,
          analyzeSnapshot: async () => facts("never"),
          createEvolution,
        },
      ),
    ).rejects.toMatchObject({ code: "limit-exceeded" });
    expect(changedSession.readChanges).toHaveBeenCalledOnce();
    expect(changedSession.readSnapshot).not.toHaveBeenCalled();
    expect(createEvolution).not.toHaveBeenCalled();
  });

  it("bounds retained changed paths by aggregate UTF-8 bytes across commits", async () => {
    const createEvolution = vi.fn(evolutionResult);
    const changedSession = sessionHarness(6, {
      change: (commitSha) => [
        {
          kind: "modified",
          path: `src/${"é".repeat(100)}-${commitSha}`,
        },
      ],
    });
    const changedProvider = providerHarness(changedSession.session);

    await expect(
      analyzeGenericGitHistory(
        request({
          mode: "commit-count",
          commitCount: 6,
          maxAggregateChangedPathBytes: 600,
        }),
        {},
        {
          withHistoryRepository: changedProvider.provider,
          analyzeSnapshot: async () => facts("never"),
          createEvolution,
        },
      ),
    ).rejects.toMatchObject({ code: "limit-exceeded" });
    expect(changedSession.readChanges).toHaveBeenCalledTimes(2);
    expect(changedSession.readSnapshot).not.toHaveBeenCalled();
    expect(createEvolution).not.toHaveBeenCalled();
  });

  it("bounds retained nested semantic facts before accumulating frames", async () => {
    const createEvolution = vi.fn(evolutionResult);
    const boundedSession = sessionHarness(3);
    const boundedProvider = providerHarness(boundedSession.session);

    await expect(
      analyzeGenericGitHistory(
        request({
          mode: "commit-count",
          commitCount: 3,
          maxAggregateSemanticBytes: 50_000,
        }),
        {},
        {
          withHistoryRepository: boundedProvider.provider,
          analyzeSnapshot: async () =>
            facts("nested", {
              sources: 1,
              units: 64,
              warningCharacters: 2_048,
            }),
          createEvolution,
        },
      ),
    ).rejects.toMatchObject({
      code: "limit-exceeded",
      message: expect.stringContaining(
        "aggregate retained semantic bytes",
      ),
    });
    expect(boundedSession.readSnapshot).toHaveBeenCalledOnce();
    expect(createEvolution).not.toHaveBeenCalled();
  });

  it("enforces the semantic bound across individually admissible frames", async () => {
    const createEvolution = vi.fn(evolutionResult);
    const boundedSession = sessionHarness(3);
    const boundedProvider = providerHarness(boundedSession.session);

    await expect(
      analyzeGenericGitHistory(
        request({
          mode: "commit-count",
          commitCount: 3,
          maxAggregateSemanticBytes: 15_000,
        }),
        {},
        {
          withHistoryRepository: boundedProvider.provider,
          analyzeSnapshot: async () =>
            facts("aggregate", { warningCharacters: 500 }),
          createEvolution,
        },
      ),
    ).rejects.toMatchObject({ code: "limit-exceeded" });
    expect(boundedSession.readSnapshot.mock.calls.length).toBeGreaterThan(
      1,
    );
    expect(createEvolution).not.toHaveBeenCalled();
  });

  it("owns immutable semantic facts before metering and evolution", async () => {
    const mutable = facts("mutable");
    const boundedSession = sessionHarness(1);
    const boundedProvider = providerHarness(boundedSession.session);
    const createEvolution = vi.fn(
      (evolutionRequest: HistoryEvolutionRequest) => {
        (mutable.warnings as string[]).push("late mutation");
        const retained = evolutionRequest.frames[0]!.facts;
        expect(retained).not.toBe(mutable);
        expect(retained.warnings).toEqual([]);
        expect(Object.isFrozen(retained)).toBe(true);
        expect(Object.isFrozen(retained.warnings)).toBe(true);
        return evolutionResult(evolutionRequest);
      },
    );

    await analyzeGenericGitHistory(
      request({
        mode: "commit-count",
        commitCount: 1,
      }),
      {},
      {
        withHistoryRepository: boundedProvider.provider,
        analyzeSnapshot: async () => mutable,
        createEvolution,
      },
    );
    expect(createEvolution).toHaveBeenCalledOnce();
  });

  it("rejects accessors, proxies, and exotic semantic storage before retention", async () => {
    const accessorFacts = facts("accessor") as unknown as Record<
      string,
      unknown
    >;
    let accessorReads = 0;
    Object.defineProperty(accessorFacts, "warnings", {
      enumerable: true,
      get: () => {
        accessorReads += 1;
        return [];
      },
    });
    let proxyReads = 0;
    const proxiedFacts = new Proxy(facts("proxy"), {
      getOwnPropertyDescriptor: (target, key) => {
        proxyReads += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    const exoticFacts = {
      ...facts("exotic"),
      warnings: new Uint8Array(32),
    };

    for (const candidate of [
      accessorFacts,
      proxiedFacts,
      exoticFacts,
    ]) {
      const boundedSession = sessionHarness(1);
      const boundedProvider = providerHarness(
        boundedSession.session,
      );
      const createEvolution = vi.fn(evolutionResult);
      await expect(
        analyzeGenericGitHistory(
          request({
            mode: "commit-count",
            commitCount: 1,
            maxAggregateSemanticBytes: 10_000,
          }),
          {},
          {
            withHistoryRepository: boundedProvider.provider,
            analyzeSnapshot: async () =>
              candidate as LocalAnalysisFacts,
            createEvolution,
          },
        ),
      ).rejects.toMatchObject({ code: "invalid-input" });
      expect(createEvolution).not.toHaveBeenCalled();
    }
    expect(accessorReads).toBe(0);
    expect(proxyReads).toBe(0);
  });

  it("sanitizes custom cache hits and cache-miss values", async () => {
    const unsafeHit = facts("unsafe-hit") as unknown as Record<
      string,
      unknown
    >;
    Object.defineProperty(unsafeHit, "warnings", {
      enumerable: true,
      get: () => [],
    });
    const hitSession = sessionHarness(1);
    const hitProvider = providerHarness(hitSession.session);
    const hitCache = cacheHarness(
      new Map([
        [
          sha(1),
          unsafeHit as unknown as LocalAnalysisFacts,
        ],
      ]),
    );
    await expect(
      analyzeGenericGitHistory(
        request({ mode: "commit-count", commitCount: 1 }),
        {},
        {
          withHistoryRepository: hitProvider.provider,
          semanticCache: hitCache.cache,
          analyzeSnapshot: async () => facts("never"),
          createEvolution: vi.fn(evolutionResult),
        },
      ),
    ).rejects.toMatchObject({ code: "invalid-input" });
    expect(hitCache.leases[0]?.released).toBe(true);

    const missSession = sessionHarness(1);
    const missProvider = providerHarness(missSession.session);
    const missCache = cacheHarness();
    await analyzeGenericGitHistory(
      request({ mode: "commit-count", commitCount: 1 }),
      {},
      {
        withHistoryRepository: missProvider.provider,
        semanticCache: missCache.cache,
        analyzeSnapshot: async () => facts("owned-miss"),
        createEvolution: vi.fn(evolutionResult),
      },
    );
    const cached = missCache.values.get(sha(1));
    expect(Object.isFrozen(cached)).toBe(true);
    expect(Object.isFrozen(cached?.repositories)).toBe(true);
  });

  it("charges snapshot files on misses and semantic entities on cache hits", async () => {
    const missSession = sessionHarness(1, { snapshotFiles: 2 });
    const missProvider = providerHarness(missSession.session);
    const createEvolution = vi.fn(evolutionResult);
    await expect(
      analyzeGenericGitHistory(
        request({
          mode: "commit-count",
          commitCount: 1,
          maxAggregateTreeEntries: 1,
        }),
        {},
        {
          withHistoryRepository: missProvider.provider,
          analyzeSnapshot: async () => facts("miss"),
          createEvolution,
        },
      ),
    ).rejects.toMatchObject({ code: "limit-exceeded" });
    expect(missSession.readSnapshot).toHaveBeenCalledOnce();
    expect(createEvolution).not.toHaveBeenCalled();

    const hitSession = sessionHarness(1);
    const hitProvider = providerHarness(hitSession.session);
    const cache = cacheHarness(
      new Map([[sha(1), facts("hit", { sources: 1 })]]),
    );
    await expect(
      analyzeGenericGitHistory(
        request({
          mode: "commit-count",
          commitCount: 1,
          maxAggregateTreeEntries: 1,
        }),
        {},
        {
          withHistoryRepository: hitProvider.provider,
          semanticCache: cache.cache,
          analyzeSnapshot: async () => facts("never"),
          createEvolution,
        },
      ),
    ).rejects.toMatchObject({ code: "limit-exceeded" });
    expect(hitSession.readSnapshot).not.toHaveBeenCalled();
    expect(cache.leases[0]?.released).toBe(true);
  });

  it("releases every acquired lease when evolution or a later acquisition fails", async () => {
    const evolutionSession = sessionHarness(2);
    const evolutionProvider = providerHarness(
      evolutionSession.session,
    );
    const evolutionCache = cacheHarness();
    await expect(
      analyzeGenericGitHistory(request({
        mode: "commit-count",
        commitCount: 2,
      }), {}, {
        withHistoryRepository: evolutionProvider.provider,
        semanticCache: evolutionCache.cache,
        analyzeSnapshot: async () => facts("frame"),
        createEvolution: () => {
          throw new Error("two-pass failure");
        },
      }),
    ).rejects.toThrow("two-pass failure");
    expect(
      evolutionCache.leases.every(({ released }) => released),
    ).toBe(true);

    const acquireSession = sessionHarness(2);
    const acquireProvider = providerHarness(acquireSession.session);
    const lease = { released: false };
    let acquisitions = 0;
    const failingCache: HistorySemanticCacheLike = {
      async acquire(_, compute) {
        acquisitions += 1;
        if (acquisitions === 2) {
          throw new Error("cache unavailable");
        }
        const value = await compute();
        return {
          hit: false,
          read: async () => value,
          release: () => {
            lease.released = true;
          },
        };
      },
    };
    await expect(
      analyzeGenericGitHistory(request({
        mode: "commit-count",
        commitCount: 2,
      }), {}, {
        withHistoryRepository: acquireProvider.provider,
        semanticCache: failingCache,
        analyzeSnapshot: async () => facts("frame"),
        createEvolution: evolutionResult,
      }),
    ).rejects.toThrow("cache unavailable");
    expect(lease.released).toBe(true);
  });

  it("releases earlier leases when a later cache acquisition never settles past the deadline", async () => {
    vi.useFakeTimers();
    try {
      const session = sessionHarness(2);
      const provider = providerHarness(session.session);
      let acquisitions = 0;
      const firstLease = { released: false };
      const cache: HistorySemanticCacheLike = {
        async acquire(_, compute) {
          acquisitions += 1;
          if (acquisitions === 2) {
            return await new Promise(() => undefined);
          }
          const value = await compute();
          return {
            hit: false,
            read: async () => value,
            release: () => {
              firstLease.released = true;
            },
          };
        },
      };

      const pending = analyzeGenericGitHistory(
        request({
          mode: "commit-count",
          commitCount: 2,
          totalDeadlineMs: 1_000,
        }),
        {},
        {
          withHistoryRepository: provider.provider,
          semanticCache: cache,
          analyzeSnapshot: async () => facts("deadline"),
          createEvolution: evolutionResult,
        },
      );
      const rejection = expect(pending).rejects.toMatchObject({
        code: "deadline-exceeded",
      });
      await vi.advanceTimersByTimeAsync(1_001);

      await rejection;
      expect(firstLease.released).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes only the remaining total deadline into synchronous evolution", async () => {
    const session = sessionHarness(1);
    const provider = providerHarness(session.session);
    let currentTime = 0;
    let evolutionDeadline: number | undefined;

    const result = await analyzeGenericGitHistory(
      request({
        mode: "commit-count",
        commitCount: 1,
        totalDeadlineMs: 1_000,
      }),
      {},
      {
        withHistoryRepository: provider.provider,
        analyzeSnapshot: async () => {
          currentTime = 900;
          return facts("near-deadline");
        },
        createEvolution: (value) => {
          evolutionDeadline =
            value.selection.analysisBounds.totalDeadlineMs;
          return evolutionResult(value);
        },
        now: () => currentTime,
      },
    );

    expect(evolutionDeadline).toBe(100);
    expect(result.costEstimate.totalDeadlineMs).toBe(1_000);
  });

  it("rejects credential-bearing identities, runtime cache keys, and expired deadlines before semantic analysis", async () => {
    const session = sessionHarness(1);
    let currentTime = 0;
    const provider = providerHarness(session.session, () => {
      currentTime = 1_001;
    });
    const analyzeSnapshot = vi.fn(async () => facts("never"));

    await expect(
      analyzeGenericGitHistory(
        {
          ...request(),
          repositoryIdentity:
            "https://user:secret@dev.azure.example/Collection/Project/_git/History",
        },
        {},
        {
          withHistoryRepository: provider.provider,
          analyzeSnapshot,
          createEvolution: evolutionResult,
        },
      ),
    ).rejects.toMatchObject({ code: "invalid-request" });
    expect(provider.requests).toHaveLength(0);

    await expect(
      analyzeGenericGitHistory(
        request(),
        {
          metricConfiguration: Array(1),
        },
        {
          withHistoryRepository: provider.provider,
          analyzeSnapshot,
          createEvolution: evolutionResult,
        },
      ),
    ).rejects.toMatchObject({ code: "invalid-request" });
    expect(provider.requests).toHaveLength(0);

    await expect(
      analyzeGenericGitHistory(
        request(),
        {
          metricConfiguration: Array.from(
            { length: 17 },
            () => "x".repeat(65_536),
          ),
        },
        {
          withHistoryRepository: provider.provider,
          analyzeSnapshot,
          createEvolution: evolutionResult,
        },
      ),
    ).rejects.toMatchObject({ code: "limit-exceeded" });
    expect(provider.requests).toHaveLength(0);

    await expect(
      analyzeGenericGitHistory(
        request(),
        {
          metricConfiguration: JSON.parse(
            '{"__proto__":{"polluted":true}}',
          ) as unknown,
        },
        {
          withHistoryRepository: provider.provider,
          analyzeSnapshot,
          createEvolution: evolutionResult,
        },
      ),
    ).rejects.toMatchObject({ code: "invalid-request" });
    expect(provider.requests).toHaveLength(0);

    await expect(
      analyzeGenericGitHistory(
        request(),
        {
          analyzerFingerprint: "a".repeat(
            HISTORY_SEMANTIC_ANALYZER_FINGERPRINT_MAX_CHARACTERS + 1,
          ),
        },
        {
          withHistoryRepository: provider.provider,
          analyzeSnapshot,
          createEvolution: evolutionResult,
        },
      ),
    ).rejects.toMatchObject({ code: "invalid-request" });
    expect(provider.requests).toHaveLength(0);

    await expect(
      analyzeGenericGitHistory(
        request(),
        {
          metricConfiguration: {
            metric: "default",
            timeoutMs: 1_000,
          },
        },
        {
          withHistoryRepository: provider.provider,
          analyzeSnapshot,
          createEvolution: evolutionResult,
        },
      ),
    ).rejects.toMatchObject({ code: "invalid-request" });
    expect(provider.requests).toHaveLength(0);

    await expect(
      analyzeGenericGitHistory(
        request({
          mode: "commit-count",
          commitCount: 1,
          totalDeadlineMs: 1_000,
        }),
        {},
        {
          withHistoryRepository: provider.provider,
          analyzeSnapshot,
          createEvolution: evolutionResult,
          now: () => currentTime,
        },
      ),
    ).rejects.toMatchObject({ code: "deadline-exceeded" });
    expect(session.readSnapshot).not.toHaveBeenCalled();
    expect(analyzeSnapshot).not.toHaveBeenCalled();
  });

  it("accepts the production cache analyzer-fingerprint boundary", async () => {
    const session = sessionHarness(1);
    const provider = providerHarness(session.session);
    const result = await analyzeGenericGitHistory(
      request({
        mode: "commit-count",
        commitCount: 1,
      }),
      {
        analyzerFingerprint: "a".repeat(
          HISTORY_SEMANTIC_ANALYZER_FINGERPRINT_MAX_CHARACTERS,
        ),
      },
      {
        withHistoryRepository: provider.provider,
        analyzeSnapshot: async () => facts("fingerprint"),
        createEvolution: evolutionResult,
      },
    );

    expect(result.model).toBe(FINAL_MODEL);
  });
});
