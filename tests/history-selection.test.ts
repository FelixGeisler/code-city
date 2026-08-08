import { describe, expect, it } from "vitest";

import {
  HISTORY_CHANGED_PATH_RECORD_OVERHEAD_BYTES,
  HISTORY_SELECTION_LIMITS,
  HistorySelectionError,
  resolveHistoryAnalysisBounds,
  selectHistory,
  type HistoryCommit,
  type HistorySelectionErrorCode,
  type HistorySelectionRequest,
} from "../packages/analyzer/src/index.js";

function sha(value: number): string {
  return value.toString(16).padStart(40, "0");
}

function chain(count: number): readonly HistoryCommit[] {
  return Object.freeze(
    Array.from({ length: count }, (_, index) => {
      const value = count - index;
      return Object.freeze({
        sha: sha(value),
        parents: Object.freeze(value === 1 ? [] : [sha(value - 1)]),
        committedAt: new Date(
          Date.UTC(2026, 0, 1) + (value - 1) * 24 * 60 * 60 * 1_000,
        ).toISOString(),
      });
    }),
  );
}

function chainAtDayOffsets(
  oldestFirstDayOffsets: readonly number[],
): readonly HistoryCommit[] {
  return Object.freeze(
    oldestFirstDayOffsets
      .map((dayOffset, index) => {
        const value = index + 1;
        return Object.freeze({
          sha: sha(value),
          parents: Object.freeze(value === 1 ? [] : [sha(value - 1)]),
          committedAt: new Date(
            Date.UTC(2026, 0, 1) + dayOffset * 24 * 60 * 60 * 1_000,
          ).toISOString(),
        });
      })
      .reverse(),
  );
}

function expectSelectionError(
  operation: () => unknown,
  code: HistorySelectionErrorCode,
): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(HistorySelectionError);
    expect((error as HistorySelectionError).code).toBe(code);
    return;
  }
  throw new Error("Expected history selection to fail.");
}

describe("bounded history selection", () => {
  it("exports the reviewed hard resource ceilings", () => {
    expect(HISTORY_CHANGED_PATH_RECORD_OVERHEAD_BYTES).toBe(128);
    expect(HISTORY_SELECTION_LIMITS).toEqual({
      maxTraversedCommits: 500,
      maxIndexedCommits: 100_000,
      maxSampledFrames: 100,
      maxRequestedTags: 64,
      maxParentsPerCommit: 64,
      maxSampleEvery: 500,
      maxTagNameBytes: 246,
      minTotalDeadlineMs: 1_000,
      defaultTotalDeadlineMs: 1_800_000,
      maxTotalDeadlineMs: 7_200_000,
      maxAggregateChangedPaths: 500_000,
      maxAggregateChangedPathBytes: 16 * 1024 * 1024,
      maxAggregateSemanticBytes: 128 * 1024 * 1024,
      maxUniqueLineages: 100_000,
      maxEvolutionOutputBytes: 64 * 1024 * 1024,
      maxAggregateTreeEntries: 2_000_000,
    });
    expect(Object.isFrozen(HISTORY_SELECTION_LIMITS)).toBe(true);
  });

  it("selects the entire mainline with elapsed-time root and tip frames", () => {
    const result = selectHistory(chain(109), {
      mode: "root-to-tip",
      maxFrames: 20,
    });

    const expectedValues = Array.from({ length: 20 }, (_, index) => {
      const numerator = index * 108;
      const denominator = 19;
      const nearestIndexWithLowerTie = Math.floor(
        (2 * numerator + denominator - 1) / (2 * denominator),
      );
      return 1 + nearestIndexWithLowerTie;
    });

    expect(result.selectedCommits).toHaveLength(109);
    expect(result.sampledCommits).toHaveLength(20);
    expect(result.sampledCommits.map(({ sha: value }) => value)).toEqual(
      expectedValues.map(sha),
    );
    expect(new Set(result.summary.sampledCommitShas)).toHaveProperty(
      "size",
      20,
    );
    expect(result.summary).toEqual({
      mode: "root-to-tip",
      traversal: "first-parent",
      order: "oldest-first",
      samplingStrategy: "elapsed-time-v1",
      maxFrames: 20,
      selectedCommitCount: 109,
      sampledCommitCount: 20,
      traversedCommitCount: 109,
      resolvedOldestSha: sha(1),
      resolvedNewestSha: sha(109),
      sampledCommitShas: expectedValues.map(sha),
    });
  });

  it("always retains a detected project start without exceeding the frame bound", () => {
    const result = selectHistory(chain(11), {
      mode: "root-to-tip",
      maxFrames: 4,
      projectStartDetectionPolicy: "analyzer-candidate-source-path-v1",
      projectStartSha: sha(6),
    });

    expect(result.summary).toMatchObject({
      samplingStrategy: "elapsed-time-project-start-v1",
      projectStartDetectionPolicy: "analyzer-candidate-source-path-v1",
      projectStartSha: sha(6),
      sampledCommitCount: 4,
    });
    expect(result.summary.sampledCommitShas).toEqual([
      sha(1),
      sha(6),
      sha(8),
      sha(11),
    ]);
  });

  it("records a deterministic no-project result without inventing a frame", () => {
    const result = selectHistory(chain(5), {
      mode: "root-to-tip",
      maxFrames: 3,
      projectStartDetectionPolicy: "analyzer-candidate-source-path-v1",
    });

    expect(result.summary).toMatchObject({
      samplingStrategy: "elapsed-time-project-start-v1",
      projectStartDetectionPolicy: "analyzer-candidate-source-path-v1",
    });
    expect("projectStartSha" in result.summary).toBe(false);
  });

  it("rejects an unretained or foreign detected project start", () => {
    expectSelectionError(
      () =>
        selectHistory(chain(5), {
          mode: "root-to-tip",
          maxFrames: 2,
          projectStartDetectionPolicy: "analyzer-candidate-source-path-v1",
          projectStartSha: sha(3),
        }),
      "invalid-request",
    );
    expectSelectionError(
      () =>
        selectHistory(chain(5), {
          mode: "root-to-tip",
          maxFrames: 3,
          projectStartDetectionPolicy: "analyzer-candidate-source-path-v1",
          projectStartSha: sha(99),
        }),
      "invalid-request",
    );
  });

  it("uses elapsed time before commit rank for uneven histories", () => {
    const result = selectHistory(
      chainAtDayOffsets([0, 0, 0, 0, 0, 90, 100]),
      {
        mode: "root-to-tip",
        maxFrames: 3,
      },
    );

    expect(result.summary.sampledCommitShas).toEqual([
      sha(1),
      sha(6),
      sha(7),
    ]);
  });

  it("breaks equal elapsed-time and rank distances by lower ancestry index", () => {
    const result = selectHistory(chainAtDayOffsets([0, 40, 60, 100]), {
      mode: "root-to-tip",
      maxFrames: 3,
    });

    expect(result.summary.sampledCommitShas).toEqual([
      sha(1),
      sha(2),
      sha(4),
    ]);
  });

  it("clamps anomalous commit times to the root-to-tip interval", () => {
    const result = selectHistory(
      chainAtDayOffsets([0, -1_000, -1, -999, 1_000, 1_001, 100]),
      {
        mode: "root-to-tip",
        maxFrames: 3,
      },
    );

    expect(result.summary.sampledCommitShas).toEqual([
      sha(1),
      sha(4),
      sha(7),
    ]);
  });

  it("falls back to commit rank when the tip is not later than the root", () => {
    const result = selectHistory(
      chainAtDayOffsets([100, 0, 90, 80, 70, 60, 50]),
      {
        mode: "root-to-tip",
        maxFrames: 3,
      },
    );

    expect(result.summary.sampledCommitShas).toEqual([
      sha(1),
      sha(4),
      sha(7),
    ]);
  });

  it.each([1, 2, 20, 100])(
    "retains all %i commits when the entire mainline fits the frame maximum",
    (count) => {
      const result = selectHistory(chain(count), {
        mode: "root-to-tip",
        maxFrames: 100,
      });
      expect(result.sampledCommits.map(({ sha: value }) => value)).toEqual(
        Array.from({ length: count }, (_, index) => sha(index + 1)),
      );
    },
  );

  it("requires complete root ancestry and at least two available frame slots", () => {
    expectSelectionError(
      () =>
        selectHistory(chain(2).slice(0, 1), {
          mode: "root-to-tip",
          maxFrames: 2,
        }),
      "selection-unavailable",
    );
    expectSelectionError(
      () =>
        selectHistory(chain(2), {
          mode: "root-to-tip",
          maxFrames: 1,
        }),
      "invalid-request",
    );
  });

  it("selects recent commits including the tip and samples oldest-first", () => {
    const result = selectHistory(chain(6), {
      mode: "commit-count",
      commitCount: 4,
      sampleEvery: 2,
    });

    expect(result.selectedCommits.map(({ sha: value }) => value)).toEqual([
      sha(3),
      sha(4),
      sha(5),
      sha(6),
    ]);
    expect(result.sampledCommits.map(({ sha: value }) => value)).toEqual([
      sha(3),
      sha(5),
      sha(6),
    ]);
    expect(result.summary).toEqual({
      mode: "commit-count",
      traversal: "first-parent",
      order: "oldest-first",
      sampleEvery: 2,
      requestedCommitCount: 4,
      selectedCommitCount: 4,
      sampledCommitCount: 3,
      traversedCommitCount: 6,
      resolvedOldestSha: sha(3),
      resolvedNewestSha: sha(6),
      sampledCommitShas: [sha(3), sha(5), sha(6)],
    });
  });

  it("returns all available commits when a recent request exceeds repository history", () => {
    const result = selectHistory(chain(2), {
      mode: "commit-count",
      commitCount: 5,
    });

    expect(result.selectedCommits.map(({ sha: value }) => value)).toEqual([
      sha(1),
      sha(2),
    ]);
    expect(result.summary).toMatchObject({
      requestedCommitCount: 5,
      selectedCommitCount: 2,
      resolvedNewestSha: sha(2),
    });
  });

  it("selects an inclusive date range and normalizes its boundaries to UTC", () => {
    const result = selectHistory(chain(5), {
      mode: "date-range",
      fromInclusive: "2026-01-02T01:00:00+01:00",
      toInclusive: "2026-01-04T00:00:00Z",
      maxCommits: 3,
      sampleEvery: 2,
    });

    expect(result.selectedCommits.map(({ sha: value }) => value)).toEqual([
      sha(2),
      sha(3),
      sha(4),
    ]);
    expect(result.summary).toEqual({
      mode: "date-range",
      traversal: "first-parent",
      order: "oldest-first",
      sampleEvery: 2,
      selectedCommitCount: 3,
      sampledCommitCount: 2,
      traversedCommitCount: 5,
      resolvedOldestSha: sha(2),
      resolvedNewestSha: sha(4),
      sampledCommitShas: [sha(2), sha(4)],
      fromInclusive: "2026-01-02T00:00:00.000Z",
      toInclusive: "2026-01-04T00:00:00.000Z",
    });
  });

  it("selects only an ancestor-checked inclusive tag range", () => {
    const result = selectHistory(chain(7), {
      mode: "tag-range",
      resolvedOldestSha: sha(2),
      resolvedNewestSha: sha(6),
      maxCommits: 5,
      sampleEvery: 3,
      requestedTagCount: 64,
    });

    expect(result.selectedCommits.map(({ sha: value }) => value)).toEqual([
      sha(2),
      sha(3),
      sha(4),
      sha(5),
      sha(6),
    ]);
    expect(result.sampledCommits.map(({ sha: value }) => value)).toEqual([
      sha(2),
      sha(5),
      sha(6),
    ]);
    expect(result.requestedTagCount).toBe(64);
    expect(result.summary).toEqual({
      mode: "tag-range",
      traversal: "first-parent",
      order: "oldest-first",
      sampleEvery: 3,
      selectedCommitCount: 5,
      sampledCommitCount: 3,
      traversedCommitCount: 7,
      resolvedOldestSha: sha(2),
      resolvedNewestSha: sha(6),
      sampledCommitShas: [sha(2), sha(5), sha(6)],
    });
    expect(Object.keys(result.summary)).not.toContain("tagName");
  });

  it("deduplicates coincident endpoints for a one-commit tag range", () => {
    const result = selectHistory(chain(3), {
      mode: "tag-range",
      resolvedOldestSha: sha(2),
      resolvedNewestSha: sha(2),
      maxCommits: 1,
      sampleEvery: 500,
    });

    expect(result.sampledCommits).toHaveLength(1);
    expect(result.summary.sampledCommitShas).toEqual([sha(2)]);
    expect(result.requestedTagCount).toBe(2);
  });

  it("preserves every parent while traversing only the first parent", () => {
    const mergeParent = sha(99);
    const history: readonly HistoryCommit[] = [
      {
        sha: sha(3),
        parents: [sha(2), mergeParent],
        committedAt: "2026-01-03T00:00:00.000Z",
      },
      {
        sha: sha(2),
        parents: [sha(1)],
        committedAt: "2026-01-02T00:00:00.000Z",
      },
      {
        sha: sha(1),
        parents: [],
        committedAt: "2026-01-01T00:00:00.000Z",
      },
    ];

    const result = selectHistory(history, {
      mode: "commit-count",
      commitCount: 3,
    });

    expect(result.selectedCommits[2]?.parents).toEqual([
      sha(2),
      mergeParent,
    ]);
    expect(result.selectedCommits[2]).not.toBe(history[0]);
    expect(Object.isFrozen(result.selectedCommits[2]?.parents)).toBe(true);
  });

  it("returns immutable summaries, commit copies, arrays, and resolved bounds", () => {
    const result = selectHistory(chain(2), {
      mode: "commit-count",
      commitCount: 2,
      totalDeadlineMs: 1_000,
      maxAggregateChangedPaths: 10,
      maxAggregateChangedPathBytes: 14,
      maxAggregateSemanticBytes:
        HISTORY_SELECTION_LIMITS.maxAggregateSemanticBytes,
      maxUniqueLineages: 11,
      maxEvolutionOutputBytes: 12,
      maxAggregateTreeEntries: 13,
    });

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.summary)).toBe(true);
    expect(Object.isFrozen(result.summary.sampledCommitShas)).toBe(true);
    expect(Object.isFrozen(result.selectedCommits)).toBe(true);
    expect(Object.isFrozen(result.sampledCommits)).toBe(true);
    expect(Object.isFrozen(result.selectedCommits[0])).toBe(true);
    expect(Object.isFrozen(result.analysisBounds)).toBe(true);
    expect(result.analysisBounds).toEqual({
      totalDeadlineMs: 1_000,
      maxAggregateChangedPaths: 10,
      maxAggregateChangedPathBytes: 14,
      maxAggregateSemanticBytes:
        HISTORY_SELECTION_LIMITS.maxAggregateSemanticBytes,
      maxUniqueLineages: 11,
      maxEvolutionOutputBytes: 12,
      maxAggregateTreeEntries: 13,
    });
  });

  it("resolves default analysis bounds independently", () => {
    expect(resolveHistoryAnalysisBounds()).toEqual({
      totalDeadlineMs: HISTORY_SELECTION_LIMITS.defaultTotalDeadlineMs,
      maxAggregateChangedPaths:
        HISTORY_SELECTION_LIMITS.maxAggregateChangedPaths,
      maxAggregateChangedPathBytes:
        HISTORY_SELECTION_LIMITS.maxAggregateChangedPathBytes,
      maxAggregateSemanticBytes:
        HISTORY_SELECTION_LIMITS.maxAggregateSemanticBytes,
      maxUniqueLineages: HISTORY_SELECTION_LIMITS.maxUniqueLineages,
      maxEvolutionOutputBytes:
        HISTORY_SELECTION_LIMITS.maxEvolutionOutputBytes,
      maxAggregateTreeEntries:
        HISTORY_SELECTION_LIMITS.maxAggregateTreeEntries,
    });
  });

  it("rejects traversal max+1 before inspecting commit metadata", () => {
    const inaccessible = {
      get sha(): string {
        throw new Error("commit metadata was inspected");
      },
      parents: [],
      committedAt: "2026-01-01T00:00:00.000Z",
    };
    const oversized = Array.from(
      { length: HISTORY_SELECTION_LIMITS.maxTraversedCommits + 1 },
      () => inaccessible,
    );

    expectSelectionError(
      () =>
        selectHistory(oversized, {
          mode: "commit-count",
          commitCount: 1,
        }),
      "limit-exceeded",
    );
  });

  it("accepts an indexed complete history at 100,000 and rejects max+1 before metadata", () => {
    const exact = selectHistory(
      chain(HISTORY_SELECTION_LIMITS.maxIndexedCommits),
      {
        mode: "root-to-tip",
        maxFrames: 2,
      },
    );
    expect(exact.selectedCommits).toHaveLength(100_000);
    expect(exact.summary.sampledCommitShas).toEqual([
      sha(1),
      sha(100_000),
    ]);

    const inaccessible = {
      get sha(): string {
        throw new Error("commit metadata was inspected");
      },
      parents: [],
      committedAt: "2026-01-01T00:00:00.000Z",
    };
    const oversized = Array.from(
      { length: HISTORY_SELECTION_LIMITS.maxIndexedCommits + 1 },
      () => inaccessible,
    );
    expectSelectionError(
      () =>
        selectHistory(oversized, {
          mode: "root-to-tip",
          maxFrames: 20,
        }),
      "limit-exceeded",
    );
  });

  it("rejects more than 100 sampled frames", () => {
    expectSelectionError(
      () =>
        selectHistory(chain(101), {
          mode: "commit-count",
          commitCount: 101,
          sampleEvery: 1,
        }),
      "limit-exceeded",
    );
  });

  it("accepts exactly 100 sampled frames", () => {
    const result = selectHistory(chain(100), {
      mode: "commit-count",
      commitCount: 100,
      sampleEvery: 1,
    });

    expect(result.sampledCommits).toHaveLength(100);
  });

  it("accepts every hard limit at its exact boundary", () => {
    const result = selectHistory(chain(500), {
      mode: "commit-count",
      commitCount: 500,
      sampleEvery: 500,
      requestedTagCount: 64,
      totalDeadlineMs: 7_200_000,
      maxAggregateChangedPaths: 500_000,
      maxAggregateChangedPathBytes: 16 * 1024 * 1024,
      maxUniqueLineages: 100_000,
      maxEvolutionOutputBytes:
        HISTORY_SELECTION_LIMITS.maxEvolutionOutputBytes,
      maxAggregateTreeEntries: 2_000_000,
    });

    expect(result.selectedCommits).toHaveLength(500);
    expect(result.sampledCommits.map(({ sha: value }) => value)).toEqual([
      sha(1),
      sha(500),
    ]);
  });

  it("rejects malformed, duplicate, and nonlinear commit chains", () => {
    const validRequest: HistorySelectionRequest = {
      mode: "commit-count",
      commitCount: 2,
    };
    const malformedChains: readonly (readonly HistoryCommit[])[] = [
      [
        {
          sha: "A".repeat(40),
          parents: [sha(1)],
          committedAt: "2026-01-02T00:00:00.000Z",
        },
      ],
      [
        {
          sha: sha(2),
          parents: [sha(1), sha(1)],
          committedAt: "2026-01-02T00:00:00.000Z",
        },
      ],
      [
        {
          sha: sha(2),
          parents: [sha(2)],
          committedAt: "2026-01-02T00:00:00.000Z",
        },
      ],
      [
        {
          sha: sha(2),
          parents: [sha(1)],
          committedAt: "2026-01-02T00:00:00Z",
        },
      ],
      [
        {
          sha: sha(2),
          parents: [sha(1)],
          committedAt: "+010000-01-01T00:00:00.000Z",
        },
      ],
      [
        {
          sha: sha(2),
          parents: [sha(1)],
          committedAt: "2026-01-02T00:00:00.000Z",
        },
        {
          sha: sha(2),
          parents: [],
          committedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      [
        {
          sha: sha(3),
          parents: [sha(1)],
          committedAt: "2026-01-03T00:00:00.000Z",
        },
        {
          sha: sha(2),
          parents: [sha(1)],
          committedAt: "2026-01-02T00:00:00.000Z",
        },
      ],
    ];

    for (const malformed of malformedChains) {
      expectSelectionError(
        () => selectHistory(malformed, validRequest),
        "invalid-request",
      );
    }
  });

  it("rejects inherited commit records and excessive parent metadata", () => {
    const inherited = Object.create({
      sha: sha(1),
      parents: [],
      committedAt: "2026-01-01T00:00:00.000Z",
    }) as HistoryCommit;
    expectSelectionError(
      () =>
        selectHistory([inherited], {
          mode: "commit-count",
          commitCount: 1,
        }),
      "invalid-request",
    );
    expectSelectionError(
      () =>
        selectHistory(
          [
            {
              sha: sha(100),
              parents: Array.from({ length: 65 }, (_, index) =>
                sha(index + 1),
              ),
              committedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
          {
            mode: "commit-count",
            commitCount: 1,
          },
        ),
      "limit-exceeded",
    );
  });

  it("rejects missing, nonancestor, and reversed tag boundaries", () => {
    const history = chain(4);
    const unavailable: readonly HistorySelectionRequest[] = [
      {
        mode: "tag-range",
        resolvedOldestSha: sha(99),
        resolvedNewestSha: sha(4),
        maxCommits: 4,
      },
      {
        mode: "tag-range",
        resolvedOldestSha: sha(4),
        resolvedNewestSha: sha(2),
        maxCommits: 4,
      },
      {
        mode: "tag-range",
        resolvedOldestSha: sha(2),
        resolvedNewestSha: sha(99),
        maxCommits: 4,
      },
    ];

    for (const request of unavailable) {
      expectSelectionError(
        () => selectHistory(history, request),
        "selection-unavailable",
      );
    }
  });

  it("rejects empty date selections and reversed date bounds", () => {
    expectSelectionError(
      () =>
        selectHistory(chain(3), {
          mode: "date-range",
          fromInclusive: "2027-01-01T00:00:00Z",
          toInclusive: "2027-01-02T00:00:00Z",
          maxCommits: 3,
        }),
      "selection-unavailable",
    );
    expectSelectionError(
      () =>
        selectHistory(chain(3), {
          mode: "date-range",
          fromInclusive: "2026-01-03T00:00:00Z",
          toInclusive: "2026-01-02T00:00:00Z",
          maxCommits: 3,
        }),
      "invalid-request",
    );
  });

  it("rejects date and tag selections that exceed their mandatory maxCommits", () => {
    expectSelectionError(
      () =>
        selectHistory(chain(4), {
          mode: "date-range",
          fromInclusive: "2026-01-01T00:00:00Z",
          toInclusive: "2026-01-04T00:00:00Z",
          maxCommits: 3,
        }),
      "limit-exceeded",
    );
    expectSelectionError(
      () =>
        selectHistory(chain(4), {
          mode: "tag-range",
          resolvedOldestSha: sha(1),
          resolvedNewestSha: sha(4),
          maxCommits: 3,
        }),
      "limit-exceeded",
    );
  });

  it("rejects nonsensical and over-ceiling numeric bounds", () => {
    const invalidRequests: readonly {
      readonly request: HistorySelectionRequest;
      readonly code: HistorySelectionErrorCode;
    }[] = [
      {
        request: {
          mode: "commit-count",
          commitCount: 0,
        },
        code: "invalid-request",
      },
      {
        request: {
          mode: "commit-count",
          commitCount: 501,
        },
        code: "limit-exceeded",
      },
      {
        request: {
          mode: "commit-count",
          commitCount: 1,
          sampleEvery: 0,
        },
        code: "invalid-request",
      },
      {
        request: {
          mode: "commit-count",
          commitCount: 1,
          sampleEvery: 501,
        },
        code: "limit-exceeded",
      },
      {
        request: {
          mode: "commit-count",
          commitCount: 1,
          requestedTagCount: -1,
        },
        code: "invalid-request",
      },
      {
        request: {
          mode: "commit-count",
          commitCount: 1,
          requestedTagCount: 65,
        },
        code: "limit-exceeded",
      },
      {
        request: {
          mode: "commit-count",
          commitCount: 1,
          totalDeadlineMs: 999,
        },
        code: "invalid-request",
      },
      {
        request: {
          mode: "commit-count",
          commitCount: 1,
          totalDeadlineMs: 7_200_001,
        },
        code: "limit-exceeded",
      },
      {
        request: {
          mode: "commit-count",
          commitCount: 1,
          maxAggregateChangedPaths: 500_001,
        },
        code: "limit-exceeded",
      },
      {
        request: {
          mode: "commit-count",
          commitCount: 1,
          maxAggregateChangedPathBytes: 16 * 1024 * 1024 + 1,
        },
        code: "limit-exceeded",
      },
      {
        request: {
          mode: "commit-count",
          commitCount: 1,
          maxAggregateSemanticBytes: 128 * 1024 * 1024 + 1,
        },
        code: "limit-exceeded",
      },
      {
        request: {
          mode: "commit-count",
          commitCount: 1,
          maxUniqueLineages: 0,
        },
        code: "invalid-request",
      },
      {
        request: {
          mode: "commit-count",
          commitCount: 1,
          maxEvolutionOutputBytes:
            HISTORY_SELECTION_LIMITS.maxEvolutionOutputBytes + 1,
        },
        code: "limit-exceeded",
      },
      {
        request: {
          mode: "commit-count",
          commitCount: 1,
          maxAggregateTreeEntries: 2_000_001,
        },
        code: "limit-exceeded",
      },
    ];

    for (const { request, code } of invalidRequests) {
      expectSelectionError(() => selectHistory(chain(1), request), code);
    }
  });

  it("requires maxCommits for date and tag modes at runtime", () => {
    expectSelectionError(
      () =>
        selectHistory(chain(1), {
          mode: "date-range",
          fromInclusive: "2026-01-01T00:00:00Z",
          toInclusive: "2026-01-01T00:00:00Z",
        } as HistorySelectionRequest),
      "invalid-request",
    );
    expectSelectionError(
      () =>
        selectHistory(chain(1), {
          mode: "tag-range",
          resolvedOldestSha: sha(1),
          resolvedNewestSha: sha(1),
        } as HistorySelectionRequest),
      "invalid-request",
    );
  });

  it("rejects noncanonical commit dates and invalid range instants", () => {
    const invalidRanges = [
      "2026-02-31T00:00:00Z",
      "2026-01-01",
      "2026-01-01T00:00:00",
      "not-a-date",
    ];
    for (const value of invalidRanges) {
      expectSelectionError(
        () =>
          selectHistory(chain(1), {
            mode: "date-range",
            fromInclusive: value,
            toInclusive: "2026-03-01T00:00:00Z",
            maxCommits: 1,
          }),
        "invalid-request",
      );
    }
    expectSelectionError(
      () =>
        selectHistory(chain(1), {
          mode: "date-range",
          fromInclusive: "9999-12-31T23:59:59Z",
          toInclusive: "9999-12-31T23:00:00-23:00",
          maxCommits: 1,
        }),
      "invalid-request",
    );
  });
});
