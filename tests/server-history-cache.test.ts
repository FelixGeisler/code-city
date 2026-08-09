import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  analyzeRepositorySnapshotFacts,
  type LocalAnalysisFacts,
} from "../packages/analyzer/src/index.js";
import {
  HISTORY_SEMANTIC_ANALYZER_FINGERPRINT,
  HistorySemanticCache,
} from "../apps/server/src/history-cache.js";

const COMMIT = "1111111111111111111111111111111111111111";
const OTHER_COMMIT =
  "2222222222222222222222222222222222222222";
const SOURCE_SENTINEL = "PRIVATE_SOURCE_SENTINEL_DO_NOT_CACHE";
const roots: string[] = [];

async function temporaryData(): Promise<string> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "code-city-history-cache-"),
  );
  roots.push(root);
  return root;
}

async function facts(): Promise<LocalAnalysisFacts> {
  const sourceText =
    `export const privateValue = "${SOURCE_SENTINEL}";\n` +
    "export function answer(flag: boolean) {\n" +
    "  return flag ? 42 : 0;\n" +
    "}\n";
  const configText = JSON.stringify({
    compilerOptions: {},
  });
  return await analyzeRepositorySnapshotFacts([
    {
      name: "Example",
      files: [
        {
          path: "src/main.ts",
          text: sourceText,
          byteLength: Buffer.byteLength(sourceText, "utf8"),
        },
        {
          path: "tsconfig.json",
          text: configText,
          byteLength: Buffer.byteLength(configText, "utf8"),
        },
      ],
      diagnostics: [],
    },
  ]);
}

function scaledFacts(
  base: LocalAnalysisFacts,
  count: number,
): LocalAnalysisFacts {
  const moduleTemplate = base.modules[0]!;
  const sourceTemplate = base.sources[0]!;
  const modules = Array.from({ length: count }, (_, index) => ({
    ...moduleTemplate,
    id: `module-${index}`,
    name: `Module ${index}`,
    path: `modules/${index}`,
    solutionIds: [],
  }));
  const sources = Array.from({ length: count }, (_, index) => ({
    ...sourceTemplate,
    id: `source-${index}`,
    moduleId: modules[index]!.id,
    districtId: `district-${index}`,
    districtName: modules[index]!.name,
    districtPath: modules[index]!.path,
    name: `source-${index}.ts`,
    path: `modules/${index}/source.ts`,
  }));
  return {
    repositories: base.repositories,
    solutions: [],
    modules,
    sources,
    dependencies: [],
    warnings: [],
  };
}

function request(
  commitSha = COMMIT,
  configuration: unknown = {
    maxFileBytes: 2 * 1024 * 1024,
    metricMapping: "default-v1",
  },
) {
  return {
    repositoryIdentity:
      "https://example.invalid/private/team/repository.git",
    commitSha,
    analyzerFingerprint:
      HISTORY_SEMANTIC_ANALYZER_FINGERPRINT,
    configuration,
  } as const;
}

async function cacheFiles(dataDirectory: string): Promise<string[]> {
  const directory = path.join(dataDirectory, "history-cache-v1");
  return (await fs.readdir(directory))
    .filter((name) => name.endsWith(".json"))
    .sort();
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) =>
      fs.rm(root, { recursive: true, force: true }),
    ),
  );
});

describe("persistent history semantic cache", () => {
  it("reuses validated facts across retries without persisting source or repository identity", async () => {
    const dataDirectory = await temporaryData();
    const cache = await HistorySemanticCache.open({ dataDirectory });
    const compute = vi.fn(async () => await facts());

    const cold = await cache.acquire(request(), compute);
    expect(cold.hit).toBe(false);
    const coldFacts = await cold.read();
    expect(coldFacts.sources.map(({ path }) => path)).toEqual([
      "src/main.ts",
    ]);
    expect(coldFacts.sources[0]?.sourceStructure?.availability).toBe("available");
    expect(coldFacts.sources[0]?.sourceStructure?.callables.some(({ name }) => name === "answer")).toBe(true);
    cold.release();

    const warm = await cache.acquire(request(), compute);
    expect(warm.hit).toBe(true);
    expect(await warm.read()).toEqual(coldFacts);
    warm.release();
    expect(compute).toHaveBeenCalledOnce();

    const files = await cacheFiles(dataDirectory);
    expect(files).toHaveLength(1);
    const persisted = await fs.readFile(
      path.join(dataDirectory, "history-cache-v1", files[0]!),
      "utf8",
    );
    expect(persisted).not.toContain(SOURCE_SENTINEL);
    expect(persisted).not.toContain(
      "https://example.invalid/private/team/repository.git",
    );
    expect(persisted).not.toContain('"identity"');
  });

  it("accepts compact historical facts without inventing inspection units", async () => {
    const dataDirectory = await temporaryData();
    const cache = await HistorySemanticCache.open({ dataDirectory });
    const full = await facts();
    const compact: LocalAnalysisFacts = {
      ...full,
      sources: full.sources.map((source) => {
        const { sourceStructure: _sourceStructure, ...aggregate } = source;
        return { ...aggregate, units: [] };
      }),
    };

    const cold = await cache.acquire(request(), async () => compact);
    const sanitized = await cold.read();
    expect(sanitized.sources[0]?.metrics.executableUnitCount).toBeGreaterThan(0);
    expect(sanitized.sources[0]?.units).toBeUndefined();
    expect(sanitized.sources[0]?.metricMethod).toBeUndefined();
    cold.release();

    const warm = await cache.acquire(request(), async () => full);
    expect(warm.hit).toBe(true);
    expect((await warm.read()).sources[0]?.units).toBeUndefined();
    warm.release();
  });

  it("keeps commit and semantic configurations in distinct cryptographic keys", async () => {
    const dataDirectory = await temporaryData();
    const cache = await HistorySemanticCache.open({ dataDirectory });
    const semanticFacts = await facts();

    for (const candidate of [
      request(),
      request(OTHER_COMMIT),
      request(COMMIT, {
        maxFileBytes: 4 * 1024 * 1024,
        metricMapping: "default-v1",
      }),
    ]) {
      const lease = await cache.acquire(
        candidate,
        async () => semanticFacts,
      );
      lease.release();
    }

    const files = await cacheFiles(dataDirectory);
    expect(files).toHaveLength(3);
    expect(new Set(files).size).toBe(3);
    expect(
      files.every((name) => /^[0-9a-f]{64}\.json$/u.test(name)),
    ).toBe(true);
  });

  it("repairs corrupt entries and preserves earlier commits when later analysis is interrupted", async () => {
    const dataDirectory = await temporaryData();
    const first = await HistorySemanticCache.open({ dataDirectory });
    const semanticFacts = await facts();
    const original = await first.acquire(
      request(),
      async () => semanticFacts,
    );
    original.release();
    const [file] = await cacheFiles(dataDirectory);
    await fs.writeFile(
      path.join(dataDirectory, "history-cache-v1", file!),
      "{\"corrupt\":true}\n",
      "utf8",
    );

    const restarted = await HistorySemanticCache.open({
      dataDirectory,
    });
    const repair = vi.fn(async () => semanticFacts);
    const repaired = await restarted.acquire(request(), repair);
    expect(repaired.hit).toBe(false);
    expect((await repaired.read()).sources).toHaveLength(1);
    repaired.release();
    expect(repair).toHaveBeenCalledOnce();

    await expect(
      restarted.acquire(request(OTHER_COMMIT), async () => {
        throw new Error("interrupted");
      }),
    ).rejects.toThrow("interrupted");
    const warm = await restarted.acquire(
      request(),
      async () => {
        throw new Error("must not recompute");
      },
    );
    expect(warm.hit).toBe(true);
    warm.release();
    expect(await cacheFiles(dataDirectory)).toHaveLength(1);
  });

  it("preserves a valid warm entry when deadline cancellation interrupts cache sanitation", async () => {
    const dataDirectory = await temporaryData();
    const cache = await HistorySemanticCache.open({ dataDirectory });
    const semanticFacts = scaledFacts(await facts(), 768);
    const cold = await cache.acquire(
      request(),
      async () => semanticFacts,
    );
    cold.release();

    const deadline = new Error("history deadline sentinel");
    let checkpoints = 0;
    await expect(
      cache.acquire(
        request(),
        async () => {
          throw new Error("must not recompute");
        },
        {
          checkpoint: () => {
            checkpoints += 1;
            if (checkpoints === 7) throw deadline;
          },
        },
      ),
    ).rejects.toBe(deadline);
    expect(checkpoints).toBe(7);
    expect(await cacheFiles(dataDirectory)).toHaveLength(1);

    const warm = await cache.acquire(request(), async () => {
      throw new Error("must not recompute");
    });
    expect(warm.hit).toBe(true);
    expect((await warm.read()).sources).toHaveLength(768);
    warm.release();
  });

  it("cancels a cold cache-capacity scan without removing warm entries", async () => {
    const dataDirectory = await temporaryData();
    const cache = await HistorySemanticCache.open({ dataDirectory });
    const semanticFacts = await facts();
    const original = await cache.acquire(
      request(),
      async () => semanticFacts,
    );
    original.release();

    const originalLstat = fs.lstat.bind(fs);
    let scanningEntry = false;
    vi.spyOn(fs, "lstat").mockImplementation(async (...arguments_) => {
      const result = await originalLstat(...arguments_);
      if (
        /^[0-9a-f]{64}\.json$/u.test(
          path.basename(String(arguments_[0])),
        )
      ) {
        scanningEntry = true;
      }
      return result;
    });
    const deadline = new Error("cache scan deadline sentinel");
    await expect(
      cache.acquire(
        request(OTHER_COMMIT),
        async () => semanticFacts,
        {
          checkpoint: () => {
            if (scanningEntry) throw deadline;
          },
        },
      ),
    ).rejects.toBe(deadline);
    expect(await cacheFiles(dataDirectory)).toHaveLength(1);

    vi.restoreAllMocks();
    const warm = await cache.acquire(request(), async () => {
      throw new Error("must not recompute");
    });
    expect(warm.hit).toBe(true);
    warm.release();
  });

  it("sweeps only recognized partial-write markers on startup", async () => {
    const dataDirectory = await temporaryData();
    await HistorySemanticCache.open({ dataDirectory });
    const directory = path.join(dataDirectory, "history-cache-v1");
    const recognized =
      ".history-cache-" +
      "a".repeat(64) +
      "-12345678-1234-4123-8123-123456789abc.tmp";
    const unrelated = "administrator-note.tmp";
    await fs.writeFile(path.join(directory, recognized), "partial");
    await fs.writeFile(path.join(directory, unrelated), "keep");

    await HistorySemanticCache.open({ dataDirectory });

    await expect(
      fs.access(path.join(directory, recognized)),
    ).rejects.toThrow();
    await expect(
      fs.access(path.join(directory, unrelated)),
    ).resolves.toBeUndefined();
  });

  it("coalesces concurrent misses without exposing a partial final entry", async () => {
    const dataDirectory = await temporaryData();
    const cache = await HistorySemanticCache.open({ dataDirectory });
    const semanticFacts = await facts();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const compute = vi.fn(async () => {
      await gate;
      return semanticFacts;
    });

    const firstPending = cache.acquire(request(), compute);
    const secondPending = cache.acquire(request(), compute);
    release();
    const [first, second] = await Promise.all([
      firstPending,
      secondPending,
    ]);

    expect(compute).toHaveBeenCalledOnce();
    expect(first.hit).toBe(false);
    expect(second.hit).toBe(true);
    expect(await first.read()).toEqual(await second.read());
    expect(await cacheFiles(dataDirectory)).toHaveLength(1);
    first.release();
    second.release();
  });

  it("keeps sanitized static-import facts across cold and warm reads", async () => {
    const dataDirectory = await temporaryData();
    const cache = await HistorySemanticCache.open({ dataDirectory });
    const semanticFacts = await facts();
    const withImports: LocalAnalysisFacts = {
      ...semanticFacts,
      sources: semanticFacts.sources.map((source) => ({
        ...source,
        imports: [{ specifier: "@example/package", count: 2 }],
      })),
    };

    const cold = await cache.acquire(request(), async () => withImports);
    expect((await cold.read()).sources[0]!.imports).toEqual([
      { specifier: "@example/package", count: 2 },
    ]);
    cold.release();
    const warm = await cache.acquire(request(), async () => {
      throw new Error("must not recompute");
    });
    expect((await warm.read()).sources[0]!.imports).toEqual([
      { specifier: "@example/package", count: 2 },
    ]);
    warm.release();
  });

  it("never exceeds the entry cap when all persisted entries are pinned", async () => {
    const dataDirectory = await temporaryData();
    const cache = await HistorySemanticCache.open({
      dataDirectory,
      maximumEntries: 1,
    });
    const semanticFacts = await facts();
    const first = await cache.acquire(
      request(),
      async () => semanticFacts,
    );
    const secondCompute = vi.fn(async () => semanticFacts);
    const second = await cache.acquire(
      request(OTHER_COMMIT),
      secondCompute,
    );

    expect(await second.read()).toEqual(await first.read());
    expect(await cacheFiles(dataDirectory)).toHaveLength(1);
    first.release();
    second.release();

    const retry = await cache.acquire(
      request(OTHER_COMMIT),
      secondCompute,
    );
    retry.release();
    expect(secondCompute).toHaveBeenCalledTimes(2);
    expect(await cacheFiles(dataDirectory)).toHaveLength(1);
  });
});
