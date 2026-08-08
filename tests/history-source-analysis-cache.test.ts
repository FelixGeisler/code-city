import { describe, expect, it } from "vitest";

import {
  analyzeRepositorySnapshotFacts,
  HistorySourceAnalysisCache,
  type RepositorySnapshotSourceAnalysisExecution,
} from "../packages/analyzer/src/index.js";
import type { RepositorySnapshot } from "../packages/analyzer/src/snapshot.js";

function snapshot(
  path: string,
  text: string,
  additionalFiles: RepositorySnapshot["files"] = [],
): RepositorySnapshot {
  return {
    name: "History",
    files: [
      {
        path,
        text,
        byteLength: Buffer.byteLength(text, "utf8"),
      },
      ...additionalFiles,
    ],
    diagnostics: [],
  };
}

function execution(
  cache: HistorySourceAnalysisCache,
  detailLevel: "summary" | "full" = "summary",
  configurationFingerprint = "configuration-a",
): RepositorySnapshotSourceAnalysisExecution {
  return {
    cache,
    analyzerFingerprint: "analyzer-a",
    configurationFingerprint,
    detailLevel,
  };
}

describe("run-local history source-analysis cache", () => {
  it("keys content with language mode, analyzer, configuration, and detail", () => {
    const cache = new HistorySourceAnalysisCache(4_096);
    const base = {
      sourceText: "export const value = <div />;",
      analyzerFingerprint: "analyzer-a",
      configurationFingerprint: "configuration-a",
      detailLevel: "summary" as const,
    };
    const key = cache.key({ ...base, languageMode: "typescript-tsx" });

    expect(key).toMatch(/^[0-9a-f]{64}$/u);
    expect(key).not.toContain(base.sourceText);
    expect(
      new Set([
        key,
        cache.key({ ...base, languageMode: "typescript-ts" }),
        cache.key({ ...base, languageMode: "typescript-dts" }),
        cache.key({
          ...base,
          languageMode: "typescript-tsx",
          analyzerFingerprint: "analyzer-b",
        }),
        cache.key({
          ...base,
          languageMode: "typescript-tsx",
          configurationFingerprint: "configuration-b",
        }),
        cache.key({
          ...base,
          languageMode: "typescript-tsx",
          detailLevel: "full",
        }),
        cache.key({
          ...base,
          sourceText: `${base.sourceText}\nexport const changed = true;`,
          languageMode: "typescript-tsx",
        }),
      ]).size,
    ).toBe(7);
  });

  it("evicts least-recently-used entries within its byte bound", () => {
    const cache = new HistorySourceAnalysisCache(1_000);
    const value = Object.freeze({
      status: "skipped" as const,
      reason: "typescript-syntax-errors" as const,
    });

    expect(cache.set("a".repeat(64), value)).toBe(true);
    expect(cache.get("a".repeat(64))).toBe(value);
    expect(cache.set("b".repeat(64), value)).toBe(true);
    expect(cache.stats()).toMatchObject({
      evictions: 1,
      entries: 1,
      maximumBytes: 1_000,
    });
    expect(cache.stats().retainedBytes).toBeLessThanOrEqual(1_000);
    expect(cache.get("a".repeat(64))).toBeUndefined();
  });

  it("reuses renamed TypeScript while rebinding identity and matches uncached facts", async () => {
    const text = "export function choose(value: boolean) { return value ? 1 : 0; }";
    const cache = new HistorySourceAnalysisCache();
    const first = await analyzeRepositorySnapshotFacts(
      [snapshot("src/old.ts", text)],
      {},
      { sourceAnalysis: execution(cache) },
    );
    const renamed = snapshot("src/new.ts", text, [
      {
        path: "package.json",
        text: '{"name":"history"}',
        byteLength: 18,
      },
    ]);
    const second = await analyzeRepositorySnapshotFacts(
      [renamed],
      {},
      { sourceAnalysis: execution(cache) },
    );
    const uncached = await analyzeRepositorySnapshotFacts(
      [renamed],
      {},
      {
        sourceAnalysis: execution(
          new HistorySourceAnalysisCache(1),
        ),
      },
    );

    expect(cache.stats()).toMatchObject({ hits: 1, misses: 1 });
    expect(first.sources[0]?.path).toBe("src/old.ts");
    expect(second.sources[0]?.path).toBe("src/new.ts");
    expect(second.sources[0]?.id).not.toBe(first.sources[0]?.id);
    expect(second.modules[0]).toMatchObject({
      kind: "npm-package",
      name: "history",
    });
    expect(second).toEqual(uncached);
  });

  it("recomputes dependency resolution when project configuration changes", async () => {
    const main = 'import { target } from "@target"; export const value = target;';
    const target = "export const target = 1;";
    const file = (path: string, text: string) => ({
      path,
      text,
      byteLength: Buffer.byteLength(text, "utf8"),
    });
    const cache = new HistorySourceAnalysisCache();
    const configured = await analyzeRepositorySnapshotFacts(
      [
        snapshot("src/main.ts", main, [
          file("src/target.ts", target),
          file(
            "tsconfig.json",
            '{"compilerOptions":{"baseUrl":".","paths":{"@target":["src/target.ts"]}}}',
          ),
        ]),
      ],
      {},
      { sourceAnalysis: execution(cache) },
    );
    const changedConfiguration = await analyzeRepositorySnapshotFacts(
      [
        snapshot("src/main.ts", main, [
          file("src/target.ts", target),
          file("tsconfig.json", '{"compilerOptions":{}}'),
        ]),
      ],
      {},
      { sourceAnalysis: execution(cache) },
    );

    expect(cache.stats()).toMatchObject({ hits: 2, misses: 2 });
    expect(configured.dependencies).toEqual([
      expect.objectContaining({
        resolution: "internal",
        targetId: configured.sources.find(
          ({ path }) => path === "src/target.ts",
        )!.id,
      }),
    ]);
    expect(changedConfiguration.dependencies).toEqual([
      expect.objectContaining({
        resolution: "external",
        externalTarget: "@target",
      }),
    ]);
  });

  it("separates compact historical and full newest inspection facts", async () => {
    const text = "export function choose(value: boolean) { return value ? 1 : 0; }";
    const source = snapshot("src/main.ts", text);
    const cache = new HistorySourceAnalysisCache();
    const summary = await analyzeRepositorySnapshotFacts(
      [source],
      {},
      { sourceAnalysis: execution(cache, "summary") },
    );
    const full = await analyzeRepositorySnapshotFacts(
      [source],
      {},
      { sourceAnalysis: execution(cache, "full") },
    );

    expect(cache.stats()).toMatchObject({ hits: 0, misses: 2 });
    expect(summary.sources[0]?.units).toEqual([]);
    expect(summary.sources[0]?.sourceStructure).toBeUndefined();
    expect(full.sources[0]?.units.length).toBeGreaterThan(0);
    expect(full.sources[0]?.sourceStructure).toBeDefined();
  });

  it("reuses JavaScript, JSX, and TSX parsing with distinct source modes", async () => {
    const files = [
      {
        path: "src/value.js",
        text: "export const value = 1;",
        byteLength: 23,
      },
      {
        path: "src/Legacy.jsx",
        text: "export const Legacy = () => <aside>Legacy</aside>;",
        byteLength: 50,
      },
    ];
    const source = snapshot(
      "src/Component.tsx",
      "export const Component = () => <section>City</section>;",
      files,
    );
    const cache = new HistorySourceAnalysisCache();
    const first = await analyzeRepositorySnapshotFacts(
      [source],
      {},
      { sourceAnalysis: execution(cache) },
    );
    const second = await analyzeRepositorySnapshotFacts(
      [source],
      {},
      { sourceAnalysis: execution(cache) },
    );

    expect(cache.stats()).toMatchObject({ hits: 3, misses: 3 });
    expect(first).toEqual(second);
    expect(second.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          language: "javascript",
          path: "src/value.js",
        }),
        expect.objectContaining({
          language: "javascript",
          path: "src/Legacy.jsx",
        }),
        expect.objectContaining({
          language: "typescript",
          path: "src/Component.tsx",
        }),
      ]),
    );
  });

  it("reanalyzes changed content", async () => {
    const cache = new HistorySourceAnalysisCache();
    const first = await analyzeRepositorySnapshotFacts(
      [snapshot("src/value.js", "export const value = 1;")],
      {},
      { sourceAnalysis: execution(cache) },
    );
    const changed = await analyzeRepositorySnapshotFacts(
      [snapshot("src/value.js", "export const value = true;")],
      {},
      { sourceAnalysis: execution(cache) },
    );

    expect(cache.stats()).toMatchObject({ hits: 0, misses: 2, entries: 2 });
    expect(first.sources[0]?.metrics.sloc).toBe(1);
    expect(changed.sources[0]?.metrics.sloc).toBe(1);
  });

  it("reuses deterministic parse failures without retaining source", async () => {
    const source = snapshot(
      "src/broken.ts",
      "export function broken( {",
    );
    const cache = new HistorySourceAnalysisCache();
    const first = await analyzeRepositorySnapshotFacts(
      [source],
      {},
      { sourceAnalysis: execution(cache) },
    );
    const second = await analyzeRepositorySnapshotFacts(
      [source],
      {},
      { sourceAnalysis: execution(cache) },
    );

    expect(cache.stats()).toMatchObject({ hits: 1, misses: 1 });
    expect(first).toEqual(second);
    expect(first.sources).toEqual([]);
    expect(first.warnings.join("\n")).toContain("syntax errors");
  });

  it("reuses C# semantic summaries and syntax failures", async () => {
    const source = snapshot(
      "src/Choice.cs",
      "public sealed class Choice { public int Pick(bool value) => value ? 1 : 0; }",
    );
    const cache = new HistorySourceAnalysisCache();
    const first = await analyzeRepositorySnapshotFacts(
      [source],
      {},
      { sourceAnalysis: execution(cache) },
    );
    const second = await analyzeRepositorySnapshotFacts(
      [source],
      {},
      { sourceAnalysis: execution(cache) },
    );

    expect(cache.stats()).toMatchObject({ hits: 1, misses: 1 });
    expect(first).toEqual(second);
    expect(second.sources[0]).toMatchObject({
      language: "csharp",
      path: "src/Choice.cs",
    });

    const broken = snapshot(
      "src/Broken.cs",
      "public sealed class Broken { public int Value( {",
    );
    const brokenCache = new HistorySourceAnalysisCache();
    const brokenFirst = await analyzeRepositorySnapshotFacts(
      [broken],
      {},
      { sourceAnalysis: execution(brokenCache) },
    );
    const brokenSecond = await analyzeRepositorySnapshotFacts(
      [broken],
      {},
      { sourceAnalysis: execution(brokenCache) },
    );
    expect(brokenCache.stats()).toMatchObject({ hits: 1, misses: 1 });
    expect(brokenFirst).toEqual(brokenSecond);
    expect(brokenSecond.sources).toEqual([]);
    expect(brokenSecond.warnings.join("\n")).toContain("syntax errors");
  });

  it("does not publish entries after analysis cancellation", async () => {
    const cache = new HistorySourceAnalysisCache();
    const controller = new AbortController();
    controller.abort();

    await expect(
      analyzeRepositorySnapshotFacts(
        [snapshot("src/main.ts", "export const value = 1;")],
        { signal: controller.signal },
        { sourceAnalysis: execution(cache) },
      ),
    ).rejects.toThrow(/aborted/u);
    expect(cache.stats()).toMatchObject({
      entries: 0,
      hits: 0,
      misses: 0,
    });
  });

  it("checks cancellation during hashing", () => {
    const cache = new HistorySourceAnalysisCache(1_000);
    let checks = 0;
    expect(() =>
      cache.key(
        {
          sourceText: "private source",
          languageMode: "typescript-ts",
          analyzerFingerprint: "analyzer",
          configurationFingerprint: "configuration",
          detailLevel: "summary",
        },
        () => {
          checks += 1;
          if (checks === 2) throw new Error("cancelled");
        },
      ),
    ).toThrow(/cancelled/u);
    expect(cache.stats()).toMatchObject({ entries: 0, retainedBytes: 0 });
  });

  it("checks deadlines during retained-size accounting", () => {
    const cache = new HistorySourceAnalysisCache(4_096);
    let remainingChecks = 3;

    expect(() =>
      cache.set(
        "d".repeat(64),
        Object.freeze({
          status: "skipped" as const,
          reason: "typescript-syntax-errors" as const,
        }),
        () => {
          remainingChecks -= 1;
          if (remainingChecks === 0) throw new Error("deadline exceeded");
        },
      ),
    ).toThrow(/deadline/u);
    expect(cache.stats()).toMatchObject({
      insertions: 0,
      entries: 0,
      retainedBytes: 0,
    });
  });

  it("keeps cache publication and eviction transactional on cancellation", () => {
    const cache = new HistorySourceAnalysisCache(1_000);
    const value = Object.freeze({
      status: "skipped" as const,
      reason: "typescript-syntax-errors" as const,
    });
    const firstKey = "a".repeat(64);
    const secondKey = "b".repeat(64);
    cache.set(firstKey, value);

    let checks = 0;
    expect(() =>
      cache.set(secondKey, value, () => {
        checks += 1;
        if (checks === 5) throw new Error("cancelled");
      }),
    ).toThrow(/cancelled/u);
    expect(cache.get(firstKey)).toBe(value);
    expect(cache.get(secondKey)).toBeUndefined();
    expect(cache.stats()).toMatchObject({
      insertions: 1,
      evictions: 0,
      entries: 1,
    });
  });
});
