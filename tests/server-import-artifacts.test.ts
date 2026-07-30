import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import {
  IMPORT_CITY_MODEL_MAX_BYTES,
  IMPORT_EVOLUTION_MAX_BYTES,
  ImportArtifactStore,
  isImportArtifactToken,
} from "../apps/server/src/import-artifacts.js";
import {
  prepareEvolutionSerialization,
  serializeEvolutionBundle,
  type EvolutionBundle,
} from "../packages/core/src/index.js";

const temporaryDirectories: string[] = [];

const minimalCityModel = Object.freeze({
  schemaVersion: "1.0",
  generator: {
    name: "code-city" as const,
    version: "test",
  },
  repositories: [],
  solutions: [],
  modules: [],
  semanticGroups: [],
  districts: [],
  buildings: [],
  dependencies: [],
  bounds: { x: 0, y: 0, z: 0 },
});

const historyCityModel = Object.freeze({
  ...minimalCityModel,
  repositories: Object.freeze([
    Object.freeze({ id: "repository:one", name: "One" }),
  ]),
});

function minimalEvolutionBundle(): EvolutionBundle {
  const sha = "1".repeat(40);
  const fingerprint = (
    digit: string,
  ): `sha256:${string}` => `sha256:${digit.repeat(64)}`;
  return {
    schemaVersion: "1.0",
    generator: historyCityModel.generator,
    authorPolicy: "omit-v1",
    selection: {
      mode: "commit-count",
      traversal: "first-parent",
      order: "oldest-first",
      requestedCommitCount: 1,
      sampleEvery: 1,
      selectedCommitCount: 1,
      sampledCommitCount: 1,
      traversedCommitCount: 1,
      resolvedOldestSha: sha,
      resolvedNewestSha: sha,
      sampledCommitShas: [sha],
    },
    provenance: {
      repositoryId: "repository:one",
      repositoryFingerprint: fingerprint("2"),
      analyzer: {
        name: "code-city",
        version: "test",
        fingerprint: fingerprint("3"),
      },
      historyBackend: {
        name: "git",
        version: "2.47.1.windows.2",
        renamePolicyRevision: "diff-tree-renames-50-myers-v1",
      },
      metricConfigurationFingerprint: fingerprint("4"),
      selectionFingerprint: fingerprint("5"),
    },
    baseline: {
      commit: {
        index: 0,
        sha,
        committedAt: "2026-07-30T00:00:00.000Z",
        parentShas: [],
        analyzerVersion: "test",
        analysisFingerprint: fingerprint("6"),
      },
      model: historyCityModel,
    },
    deltas: [],
  };
}

function largeEvolutionBundle(): EvolutionBundle {
  const bundle = minimalEvolutionBundle();
  return {
    ...bundle,
    baseline: {
      ...bundle.baseline,
      model: {
        ...bundle.baseline.model,
        repositories: [
          { id: "repository:one", name: "One" },
          ...Array.from({ length: 999 }, (_, index) => ({
            id: `repository:stream-${index.toString().padStart(3, "0")}`,
            name:
              `Streaming repository ${index}: ` +
              "x".repeat(200),
          })),
        ],
      },
    },
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "code-city-import-artifacts-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

async function createDirectoryLink(
  target: string,
  link: string,
): Promise<boolean> {
  try {
    await fs.symlink(
      target,
      link,
      process.platform === "win32" ? "junction" : "dir",
    );
    return true;
  } catch (error) {
    const code =
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : undefined;
    if (code === "EPERM" || code === "EACCES" || code === "ENOSYS") {
      return false;
    }
    throw error;
  }
}

function expectPrivateMode(mode: number, expected: number): void {
  if (process.platform !== "win32") {
    expect(mode & 0o777).toBe(expected);
  }
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0).reverse()) {
    await fs.rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
});

it("creates private fixed-shape storage and publishes a validated model", async () => {
  const root = await temporaryDirectory();
  const dataDirectory = path.join(root, "data");
  const store = await ImportArtifactStore.open({ dataDirectory });
  const staging = await store.createStagingDirectory();

  expect(isImportArtifactToken(staging.token)).toBe(true);
  expect(staging.directory).toBe(
    await fs.realpath(
      path.join(dataDirectory, "tmp", "imports", staging.token),
    ),
  );
  await fs.writeFile(
    path.join(staging.directory, "source.zip"),
    "staged",
    "utf8",
  );

  const published = await store.publishCityModel(
    staging.token,
    minimalCityModel,
  );
  const storedPath = path.join(
    dataDirectory,
    "artifacts",
    staging.token,
    "city-model.json",
  );
  const expectedBytes = await fs.readFile(storedPath);

  expect(published).toEqual({
    token: staging.token,
    size: expectedBytes.byteLength,
    lastModified: expect.any(String),
  });
  expect(Object.isFrozen(published)).toBe(true);
  expect(JSON.parse(expectedBytes.toString("utf8"))).toEqual(
    minimalCityModel,
  );

  const stated = await store.statCityModel(staging.token);
  const read = await store.readCityModel(staging.token);
  expect(stated).toEqual(published);
  expect(read).toMatchObject(published);
  expect(read?.bytes).toEqual(expectedBytes);
  expect(await store.statCityModel(randomUUID())).toBeUndefined();
  expect(await store.readCityModel(randomUUID())).toBeUndefined();

  for (const directory of [
    dataDirectory,
    path.join(dataDirectory, "artifacts"),
    path.join(dataDirectory, "artifacts", staging.token),
    path.join(dataDirectory, "tmp"),
    path.join(dataDirectory, "tmp", "imports"),
    staging.directory,
  ]) {
    expectPrivateMode((await fs.stat(directory)).mode, 0o700);
  }
  expectPrivateMode((await fs.stat(storedPath)).mode, 0o600);

  await store.cleanupStagingDirectory(staging.token);
  await store.cleanupStagingDirectory(staging.token);
  await expect(fs.lstat(staging.directory)).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(await fs.readFile(storedPath, "utf8")).toContain(
    '"schemaVersion": "1.0"',
  );
});

it("checks cancellation before and after staging cleanup operations", async () => {
  const root = await temporaryDirectory();
  const dataDirectory = path.join(root, "data");
  const store = await ImportArtifactStore.open({ dataDirectory });
  const staging = await store.createStagingDirectory();
  const deadline = new Error("cleanup deadline");

  await expect(
    store.cleanupStagingDirectory(staging.token, {
      checkpoint: () => {
        throw deadline;
      },
    }),
  ).rejects.toBe(deadline);
  expect((await fs.stat(staging.directory)).isDirectory()).toBe(true);

  await store.cleanupStagingDirectory(staging.token);
  await expect(fs.lstat(staging.directory)).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("transactionally publishes canonical city and evolution artifacts with digest metadata", async () => {
  const root = await temporaryDirectory();
  const dataDirectory = path.join(root, "data");
  const store = await ImportArtifactStore.open({ dataDirectory });
  const token = randomUUID();
  const prepared = prepareEvolutionSerialization(
    minimalEvolutionBundle(),
  );
  const evolution = prepared.bundle;
  const canonicalEvolution = Buffer.from(
    serializeEvolutionBundle(evolution),
  );

  const published = await store.publishHistoryArtifacts(
    token,
    historyCityModel,
    evolution,
    { preparedSerialization: prepared },
  );
  const artifactDirectory = path.join(
    dataDirectory,
    "artifacts",
    token,
  );
  expect((await fs.readdir(artifactDirectory)).sort()).toEqual([
    "city-model.json",
    "evolution.json",
  ]);
  expect(await fs.readFile(path.join(
    artifactDirectory,
    "evolution.json",
  ))).toEqual(canonicalEvolution);
  expect(published.evolution).toEqual({
    token,
    size: canonicalEvolution.byteLength,
    sha256: createHash("sha256")
      .update(canonicalEvolution)
      .digest("hex"),
    lastModified: expect.any(String),
  });
  expect(Object.isFrozen(published)).toBe(true);
  expect(Object.isFrozen(published.evolution)).toBe(true);

  expect(await store.statEvolution(token)).toEqual(
    published.evolution,
  );
  const openedEvolution = await store.readEvolution(
    token,
    published.evolution,
  );
  expect(openedEvolution).toMatchObject(published.evolution);
  const evolutionChunks: Buffer[] = [];
  for await (const chunk of openedEvolution!.chunks()) {
    evolutionChunks.push(chunk);
  }
  expect(Buffer.concat(evolutionChunks)).toEqual(canonicalEvolution);
  await openedEvolution!.close();

  await store.reconcileImportArtifacts(
    new Map([
      [
        token,
        {
          evolution: {
            size: published.evolution.size,
            sha256: published.evolution.sha256,
          },
        },
      ],
    ]),
  );
  await store.cleanupCityModelArtifact(token);
  expect(await store.statCityModel(token)).toBeUndefined();
  expect(await store.statEvolution(token)).toBeUndefined();
});

it("rejects a prepared evolution handle paired with a different bundle identity", async () => {
  const root = await temporaryDirectory();
  const dataDirectory = path.join(root, "data");
  const store = await ImportArtifactStore.open({ dataDirectory });
  const token = randomUUID();
  const prepared = prepareEvolutionSerialization(
    minimalEvolutionBundle(),
  );

  await expect(
    store.publishHistoryArtifacts(
      token,
      historyCityModel,
      minimalEvolutionBundle(),
      { preparedSerialization: prepared },
    ),
  ).rejects.toMatchObject({ code: "EVOLUTION_INVALID" });
  expect(await store.statCityModel(token)).toBeUndefined();
  expect(await store.statEvolution(token)).toBeUndefined();
});

it("checks a direct wall-clock guard during synchronous history serialization", async () => {
  const root = await temporaryDirectory();
  const dataDirectory = path.join(root, "data");
  const store = await ImportArtifactStore.open({ dataDirectory });
  const token = randomUUID();
  const deadline = new Error("history wall-clock deadline");
  let checkpoints = 0;

  await expect(
    store.publishHistoryArtifacts(
      token,
      historyCityModel,
      minimalEvolutionBundle(),
      {
        checkpoint: () => {
          checkpoints += 1;
          if (checkpoints >= 3) throw deadline;
        },
      },
    ),
  ).rejects.toBe(deadline);
  expect(checkpoints).toBeGreaterThanOrEqual(3);
  expect(await store.statCityModel(token)).toBeUndefined();
  expect(await store.statEvolution(token)).toBeUndefined();
});

it("publishes a large canonical evolution artifact in bounded chunks", async () => {
  const root = await temporaryDirectory();
  const dataDirectory = path.join(root, "data");
  const store = await ImportArtifactStore.open({ dataDirectory });
  const token = randomUUID();
  const encoding = new AsyncLocalStorage<boolean>();
  const originalEncode = TextEncoder.prototype.encode;
  const encodedChunkSizes: number[] = [];
  vi.spyOn(TextEncoder.prototype, "encode").mockImplementation(
    function (this: TextEncoder, input) {
      const bytes = originalEncode.call(this, input);
      if (encoding.getStore() === true) {
        encodedChunkSizes.push(bytes.byteLength);
      }
      return bytes;
    },
  );

  const evolution = largeEvolutionBundle();
  const published = await encoding.run(true, () =>
    store.publishHistoryArtifacts(
      token,
      evolution.baseline.model,
      evolution,
    ),
  );
  const stored = await fs.readFile(
    path.join(
      dataDirectory,
      "artifacts",
      token,
      "evolution.json",
    ),
  );

  expect(stored.byteLength).toBeGreaterThan(128 * 1024);
  expect(published.evolution.size).toBe(stored.byteLength);
  expect(published.evolution.sha256).toBe(
    createHash("sha256").update(stored).digest("hex"),
  );
  expect(
    encodedChunkSizes.filter((size) => size >= 8 * 1024).length,
  ).toBeGreaterThan(1);
  expect(Math.max(...encodedChunkSizes)).toBeLessThan(
    stored.byteLength / 4,
  );
});

it("withholds the final evolution chunk until the streaming digest is verified", async () => {
  const root = await temporaryDirectory();
  const dataDirectory = path.join(root, "data");
  const store = await ImportArtifactStore.open({ dataDirectory });
  const token = randomUUID();
  const evolution = largeEvolutionBundle();
  const published = await store.publishHistoryArtifacts(
    token,
    evolution.baseline.model,
    evolution,
  );
  const artifact = await store.readEvolution(
    token,
    published.evolution,
  );
  expect(artifact).toBeDefined();

  const artifactPath = path.join(
    dataDirectory,
    "artifacts",
    token,
    "evolution.json",
  );
  const mutationOffset = Math.floor(published.evolution.size / 2);
  const mutation = Buffer.alloc(1);
  const mutationHandle = await fs.open(artifactPath, "r+");
  try {
    await mutationHandle.read(mutation, 0, 1, mutationOffset);
    mutation[0] = mutation[0]! ^ 1;
    await mutationHandle.write(mutation, 0, 1, mutationOffset);
    await mutationHandle.sync();
  } finally {
    await mutationHandle.close();
  }

  let yieldedBytes = 0;
  await expect(
    (async () => {
      for await (const chunk of artifact!.chunks()) {
        yieldedBytes += chunk.byteLength;
      }
    })(),
  ).rejects.toThrow(/changed|verification/iu);
  expect(yieldedBytes).toBeGreaterThan(0);
  expect(yieldedBytes).toBeLessThan(published.evolution.size);
  expect(published.evolution.size - yieldedBytes).toBeLessThanOrEqual(
    64 * 1024,
  );
});

it("aborts a partial streamed evolution stage without leaving files", async () => {
  const root = await temporaryDirectory();
  const dataDirectory = path.join(root, "data");
  const store = await ImportArtifactStore.open({ dataDirectory });
  const token = randomUUID();
  const controller = new AbortController();
  const encoding = new AsyncLocalStorage<boolean>();
  const originalEncode = TextEncoder.prototype.encode;
  let serializedChunks = 0;
  vi.spyOn(TextEncoder.prototype, "encode").mockImplementation(
    function (this: TextEncoder, input) {
      const bytes = originalEncode.call(this, input);
      if (
        encoding.getStore() === true &&
        bytes.byteLength >= 8 * 1024
      ) {
        serializedChunks += 1;
        if (serializedChunks === 2) controller.abort();
      }
      return bytes;
    },
  );
  const evolution = largeEvolutionBundle();

  await expect(
    encoding.run(true, () =>
      store.publishHistoryArtifacts(
        token,
        evolution.baseline.model,
        evolution,
        { signal: controller.signal },
      ),
    ),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(serializedChunks).toBeGreaterThanOrEqual(2);
  expect(
    await fs.readdir(
      path.join(dataDirectory, "artifacts", token),
    ),
  ).toEqual([]);
  expect(await store.statCityModel(token)).toBeUndefined();
  expect(await store.statEvolution(token)).toBeUndefined();
});

it("preserves AbortError when cancellation interrupts evolution prevalidation", async () => {
  const root = await temporaryDirectory();
  const dataDirectory = path.join(root, "data");
  const store = await ImportArtifactStore.open({ dataDirectory });
  const token = randomUUID();
  const controller = new AbortController();
  const originalThrowIfAborted =
    AbortSignal.prototype.throwIfAborted;
  let checks = 0;
  vi.spyOn(
    AbortSignal.prototype,
    "throwIfAborted",
  ).mockImplementation(function (this: AbortSignal) {
    if (this === controller.signal) {
      checks += 1;
      if (checks === 5) controller.abort();
    }
    return originalThrowIfAborted.call(this);
  });

  await expect(
    store.publishHistoryArtifacts(
      token,
      historyCityModel,
      largeEvolutionBundle(),
      { signal: controller.signal },
    ),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(checks).toBeGreaterThanOrEqual(5);
  const artifactDirectory = path.join(
    dataDirectory,
    "artifacts",
    token,
  );
  let artifactEntries: string[] = [];
  try {
    artifactEntries = await fs.readdir(artifactDirectory);
  } catch (error) {
    if (
      error === null ||
      typeof error !== "object" ||
      !("code" in error) ||
      error.code !== "ENOENT"
    ) {
      throw error;
    }
  }
  expect(artifactEntries).toEqual([]);
  expect(await store.statCityModel(token)).toBeUndefined();
  expect(await store.statEvolution(token)).toBeUndefined();
});

it("rolls back both fixed history filenames when dual publication fails", async () => {
  const root = await temporaryDirectory();
  const dataDirectory = path.join(root, "data");
  const store = await ImportArtifactStore.open({ dataDirectory });
  const token = randomUUID();
  const originalLink = fs.link.bind(fs);
  vi.spyOn(fs, "link").mockImplementation(async (source, destination) => {
    if (path.basename(String(destination)) === "evolution.json") {
      throw Object.assign(new Error("simulated link failure"), {
        code: "EIO",
      });
    }
    return originalLink(source, destination);
  });

  await expect(
    store.publishHistoryArtifacts(
      token,
      historyCityModel,
      minimalEvolutionBundle(),
    ),
  ).rejects.toThrow(/simulated link failure/u);

  const artifactDirectory = path.join(
    dataDirectory,
    "artifacts",
    token,
  );
  expect(await fs.readdir(artifactDirectory)).toEqual([]);
  const restarted = await ImportArtifactStore.open({ dataDirectory });
  expect(await restarted.statCityModel(token)).toBeUndefined();
  expect(await restarted.statEvolution(token)).toBeUndefined();
});

it("rolls back both fixed files when final evolution stage cleanup fails", async () => {
  const root = await temporaryDirectory();
  const dataDirectory = path.join(root, "data");
  const store = await ImportArtifactStore.open({ dataDirectory });
  const token = randomUUID();
  const originalUnlink = fs.unlink.bind(fs);
  const unlink = vi.spyOn(fs, "unlink").mockImplementation(async (file) => {
    if (
      path.basename(String(file)).startsWith(".evolution-") &&
      path.basename(String(file)).endsWith(".tmp")
    ) {
      throw Object.assign(new Error("simulated stage cleanup failure"), {
        code: "EIO",
      });
    }
    return originalUnlink(file);
  });

  await expect(
    store.publishHistoryArtifacts(
      token,
      historyCityModel,
      minimalEvolutionBundle(),
    ),
  ).rejects.toThrow(/simulated stage cleanup failure/u);
  const artifactDirectory = path.join(
    dataDirectory,
    "artifacts",
    token,
  );
  expect(await fs.readdir(artifactDirectory)).not.toContain(
    "city-model.json",
  );
  expect(await fs.readdir(artifactDirectory)).not.toContain(
    "evolution.json",
  );

  unlink.mockRestore();
  const restarted = await ImportArtifactStore.open({ dataDirectory });
  expect(await fs.readdir(artifactDirectory)).toEqual([]);
  expect(await restarted.statCityModel(token)).toBeUndefined();
  expect(await restarted.statEvolution(token)).toBeUndefined();
});

it("rejects noncanonical or oversized persisted evolution artifacts", async () => {
  const root = await temporaryDirectory();
  const dataDirectory = path.join(root, "data");
  const store = await ImportArtifactStore.open({ dataDirectory });
  const token = randomUUID();
  const published = await store.publishHistoryArtifacts(
    token,
    historyCityModel,
    minimalEvolutionBundle(),
  );
  const evolutionPath = path.join(
    dataDirectory,
    "artifacts",
    token,
    "evolution.json",
  );
  const canonical = await fs.readFile(evolutionPath, "utf8");
  await fs.writeFile(evolutionPath, `${canonical}\n`, { mode: 0o600 });
  await expect(
    store.readEvolution(token, published.evolution),
  ).rejects.toMatchObject({
    code: "EVOLUTION_INVALID",
  });

  await fs.truncate(evolutionPath, IMPORT_EVOLUTION_MAX_BYTES + 1);
  await expect(store.statEvolution(token)).rejects.toMatchObject({
    code: "EVOLUTION_TOO_LARGE",
  });
  expect(published.evolution.size).toBeLessThan(
    IMPORT_EVOLUTION_MAX_BYTES,
  );
});

it("reads into one exact-size buffer without concatenating chunks", async () => {
  const root = await temporaryDirectory();
  const dataDirectory = path.join(root, "data");
  const store = await ImportArtifactStore.open({ dataDirectory });
  const token = randomUUID();
  await store.publishCityModel(token, minimalCityModel);
  const expected = await fs.readFile(
    path.join(
      dataDirectory,
      "artifacts",
      token,
      "city-model.json",
    ),
  );
  const allocUnsafe = Buffer.allocUnsafe.bind(Buffer);
  const concat = Buffer.concat.bind(Buffer);
  const artifactRead = new AsyncLocalStorage<boolean>();
  const allocations: number[] = [];
  let concatenations = 0;
  vi.spyOn(Buffer, "allocUnsafe").mockImplementation((size) => {
    if (artifactRead.getStore() === true) {
      allocations.push(size);
    }
    return allocUnsafe(size);
  });
  vi.spyOn(Buffer, "concat").mockImplementation(
    (list, totalLength) => {
      if (artifactRead.getStore() === true) {
        concatenations += 1;
      }
      return totalLength === undefined
        ? concat(list)
        : concat(list, totalLength);
    },
  );

  const artifact = await artifactRead.run(
    true,
    () => store.readCityModel(token),
  );

  expect(artifact?.bytes).toEqual(expected);
  expect(allocations).toEqual([expected.byteLength]);
  expect(concatenations).toBe(0);
});

it("rejects arbitrary paths and malformed artifact tokens", async () => {
  const root = await temporaryDirectory();
  const dataDirectory = path.join(root, "data");
  const sentinel = path.join(root, "sentinel.txt");
  await fs.writeFile(sentinel, "untouched", "utf8");
  const store = await ImportArtifactStore.open({ dataDirectory });

  for (const token of [
    "",
    ".",
    "..",
    "../sentinel.txt",
    "00000000-0000-0000-0000-000000000000",
    randomUUID().toUpperCase(),
    `${randomUUID()}/city-model.json`,
    `${randomUUID()}%2f..`,
  ]) {
    expect(isImportArtifactToken(token)).toBe(false);
    await expect(store.statCityModel(token)).rejects.toMatchObject({
      code: "INVALID_TOKEN",
    });
    await expect(store.readCityModel(token)).rejects.toMatchObject({
      code: "INVALID_TOKEN",
    });
    await expect(
      store.publishCityModel(token, minimalCityModel),
    ).rejects.toMatchObject({ code: "INVALID_TOKEN" });
    await expect(
      store.cleanupStagingDirectory(token),
    ).rejects.toMatchObject({ code: "INVALID_TOKEN" });
    await expect(
      store.cleanupCityModelArtifact(token),
    ).rejects.toMatchObject({ code: "INVALID_TOKEN" });
    await expect(
      store.reconcileCityModelArtifacts(new Set([token])),
    ).rejects.toMatchObject({ code: "INVALID_TOKEN" });
  }

  expect(await fs.readFile(sentinel, "utf8")).toBe("untouched");
});

it("rejects symlink and non-directory storage components", async () => {
  const root = await temporaryDirectory();
  const external = await temporaryDirectory();
  await fs.writeFile(path.join(external, "sentinel.txt"), "safe", "utf8");

  const cases = [
    {
      name: "data root",
      prepare: async (dataDirectory: string) =>
        createDirectoryLink(external, dataDirectory),
    },
    {
      name: "artifacts",
      prepare: async (dataDirectory: string) => {
        await fs.mkdir(dataDirectory, { recursive: true });
        return createDirectoryLink(
          external,
          path.join(dataDirectory, "artifacts"),
        );
      },
    },
    {
      name: "tmp",
      prepare: async (dataDirectory: string) => {
        await fs.mkdir(dataDirectory, { recursive: true });
        return createDirectoryLink(
          external,
          path.join(dataDirectory, "tmp"),
        );
      },
    },
    {
      name: "tmp/imports",
      prepare: async (dataDirectory: string) => {
        await fs.mkdir(path.join(dataDirectory, "tmp"), {
          recursive: true,
        });
        return createDirectoryLink(
          external,
          path.join(dataDirectory, "tmp", "imports"),
        );
      },
    },
  ] as const;

  let linksSupported = true;
  for (const [index, testCase] of cases.entries()) {
    const dataDirectory = path.join(root, `data-${index}`);
    if (!(await testCase.prepare(dataDirectory))) {
      linksSupported = false;
      break;
    }
    await expect(
      ImportArtifactStore.open({ dataDirectory }),
      testCase.name,
    ).rejects.toMatchObject({ code: "FILESYSTEM_POLICY" });
  }

  if (linksSupported) {
    expect(await fs.readFile(path.join(external, "sentinel.txt"), "utf8")).toBe(
      "safe",
    );
  }

  const fileComponent = path.join(root, "file-component");
  await fs.mkdir(fileComponent);
  await fs.writeFile(path.join(fileComponent, "artifacts"), "file", "utf8");
  await expect(
    ImportArtifactStore.open({ dataDirectory: fileComponent }),
  ).rejects.toMatchObject({ code: "FILESYSTEM_POLICY" });
});

it("rejects a token directory symlink without reading its target", async () => {
  const root = await temporaryDirectory();
  const external = await temporaryDirectory();
  const dataDirectory = path.join(root, "data");
  const store = await ImportArtifactStore.open({ dataDirectory });
  const token = randomUUID();
  await fs.writeFile(
    path.join(external, "city-model.json"),
    JSON.stringify(minimalCityModel),
    "utf8",
  );
  const supported = await createDirectoryLink(
    external,
    path.join(dataDirectory, "artifacts", token),
  );
  if (!supported) return;

  await expect(store.statCityModel(token)).rejects.toMatchObject({
    code: "FILESYSTEM_POLICY",
  });
  await expect(store.readCityModel(token)).rejects.toMatchObject({
    code: "FILESYSTEM_POLICY",
  });
});

it("publishes atomically and never replaces an existing artifact", async () => {
  const root = await temporaryDirectory();
  const dataDirectory = path.join(root, "data");
  const store = await ImportArtifactStore.open({ dataDirectory });

  const invalidToken = randomUUID();
  await expect(
    store.publishCityModel(invalidToken, {
      ...minimalCityModel,
      schemaVersion: "unsupported",
    }),
  ).rejects.toMatchObject({ code: "CITY_MODEL_INVALID" });
  await expect(
    fs.lstat(path.join(dataDirectory, "artifacts", invalidToken)),
  ).rejects.toMatchObject({ code: "ENOENT" });

  const failedToken = randomUUID();
  const link = vi
    .spyOn(fs, "link")
    .mockRejectedValueOnce(new Error("injected atomic link failure"));
  await expect(
    store.publishCityModel(failedToken, minimalCityModel),
  ).rejects.toThrow("injected atomic link failure");
  link.mockRestore();
  const failedDirectory = path.join(
    dataDirectory,
    "artifacts",
    failedToken,
  );
  expect(await fs.readdir(failedDirectory)).toEqual([]);

  const publishedToken = randomUUID();
  await store.publishCityModel(publishedToken, minimalCityModel);
  const storedPath = path.join(
    dataDirectory,
    "artifacts",
    publishedToken,
    "city-model.json",
  );
  const before = await fs.readFile(storedPath);
  await expect(
    store.publishCityModel(publishedToken, {
      ...minimalCityModel,
      generator: { name: "code-city", version: "replacement" },
    }),
  ).rejects.toMatchObject({ code: "ARTIFACT_ALREADY_EXISTS" });
  expect(await fs.readFile(storedPath)).toEqual(before);
});

it("refuses to link a stage without a stable filesystem identity", async () => {
  const root = await temporaryDirectory();
  const dataDirectory = path.join(root, "data");
  const store = await ImportArtifactStore.open({ dataDirectory });
  const token = randomUUID();
  const open = fs.open.bind(fs);
  const openSpy = vi
    .spyOn(fs, "open")
    .mockImplementation(async (candidate, flags, mode) => {
      const handle =
        mode === undefined
          ? await open(candidate, flags)
          : await open(candidate, flags, mode);
      if (
        !path.basename(String(candidate)).startsWith(".city-model-") ||
        !String(candidate).endsWith(".tmp")
      ) {
        return handle;
      }
      return new Proxy(handle, {
        get(target, property) {
          if (property === "stat") {
            return async () => {
              const status = await target.stat({ bigint: true });
              return new Proxy(status, {
                get(statusTarget, statusProperty) {
                  if (
                    statusProperty === "dev" ||
                    statusProperty === "ino"
                  ) {
                    return 0n;
                  }
                  const value = Reflect.get(
                    statusTarget,
                    statusProperty,
                    statusTarget,
                  ) as unknown;
                  return typeof value === "function"
                    ? value.bind(statusTarget)
                    : value;
                },
              });
            };
          }
          const value = Reflect.get(
            target,
            property,
            target,
          ) as unknown;
          return typeof value === "function"
            ? value.bind(target)
            : value;
        },
      }) as FileHandle;
    });
  const linkSpy = vi.spyOn(fs, "link");

  await expect(
    store.publishCityModel(token, minimalCityModel),
  ).rejects.toMatchObject({ code: "FILESYSTEM_POLICY" });
  expect(linkSpy).not.toHaveBeenCalled();
  openSpy.mockRestore();
  linkSpy.mockRestore();
  expect(
    await fs.readdir(
      path.join(dataDirectory, "artifacts", token),
    ),
  ).toEqual([]);
});

it("keeps artifact insertion no-replace under accidental overlapping publication", async () => {
  const root = await temporaryDirectory();
  const dataDirectory = path.join(root, "data");
  const first = await ImportArtifactStore.open({ dataDirectory });
  const second = await ImportArtifactStore.open({ dataDirectory });
  const token = randomUUID();
  const attempts = await Promise.allSettled([
    first.publishCityModel(token, minimalCityModel),
    second.publishCityModel(token, {
      ...minimalCityModel,
      generator: { name: "code-city", version: "concurrent" },
    }),
  ]);

  expect(
    attempts.filter(({ status }) => status === "fulfilled"),
  ).toHaveLength(1);
  const rejected = attempts.find(({ status }) => status === "rejected");
  expect(rejected).toMatchObject({
    status: "rejected",
    reason: { code: "ARTIFACT_ALREADY_EXISTS" },
  });
  const stored = JSON.parse(
    (
      await fs.readFile(
        path.join(
          dataDirectory,
          "artifacts",
          token,
          "city-model.json",
        ),
        "utf8",
      )
    ).trim(),
  ) as { generator: { version: string } };
  expect(["test", "concurrent"]).toContain(stored.generator.version);
});

it("rolls back a linked artifact when fixed-name validation fails", async () => {
  const root = await temporaryDirectory();
  const dataDirectory = path.join(root, "data");
  const store = await ImportArtifactStore.open({ dataDirectory });
  const token = randomUUID();
  const open = fs.open.bind(fs);
  let injected = false;
  const openSpy = vi
    .spyOn(fs, "open")
    .mockImplementation(async (candidate, flags, mode) => {
      if (
        !injected &&
        path.basename(String(candidate)) === "city-model.json"
      ) {
        injected = true;
        throw new Error("injected post-link validation failure");
      }
      return mode === undefined
        ? open(candidate, flags)
        : open(candidate, flags, mode);
    });

  await expect(
    store.publishCityModel(token, minimalCityModel),
  ).rejects.toThrow("injected post-link validation failure");
  openSpy.mockRestore();

  const artifactDirectory = path.join(
    dataDirectory,
    "artifacts",
    token,
  );
  expect(await fs.readdir(artifactDirectory)).toEqual([]);
  expect(await store.statCityModel(token)).toBeUndefined();
});

it("rolls back after permanent stage-name cleanup failure and repairs the orphan on restart", async () => {
  const root = await temporaryDirectory();
  const dataDirectory = path.join(root, "data");
  const store = await ImportArtifactStore.open({ dataDirectory });
  const token = randomUUID();
  const unlink = fs.unlink.bind(fs);
  const isPublicationStage = (candidate: unknown): boolean => {
    const name = path.basename(String(candidate));
    return name.startsWith(".city-model-") && name.endsWith(".tmp");
  };
  const unlinkSpy = vi
    .spyOn(fs, "unlink")
    .mockImplementation(async (candidate) => {
      if (isPublicationStage(candidate)) {
        throw new Error("injected stage unlink failure");
      }
      await unlink(candidate);
    });

  await expect(
    store.publishCityModel(token, minimalCityModel),
  ).rejects.toThrow("injected stage unlink failure");
  unlinkSpy.mockRestore();

  const artifactDirectory = path.join(
    dataDirectory,
    "artifacts",
    token,
  );
  const afterFailure = await fs.readdir(artifactDirectory);
  expect(afterFailure).toHaveLength(1);
  expect(afterFailure[0]).toMatch(/^\.city-model-.*\.tmp$/u);
  expect(afterFailure).not.toContain("city-model.json");

  const restarted = await ImportArtifactStore.open({ dataDirectory });
  expect(await fs.readdir(artifactDirectory)).toEqual([]);
  expect(await restarted.statCityModel(token)).toBeUndefined();
});

it("rolls back an identity-matching crash marker during startup", async () => {
  const root = await temporaryDirectory();
  const dataDirectory = path.join(root, "data");
  const token = randomUUID();
  const artifactDirectory = path.join(
    dataDirectory,
    "artifacts",
    token,
  );
  await fs.mkdir(artifactDirectory, { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(
    artifactDirectory,
    `.city-model-${randomUUID()}.tmp`,
  );
  const destination = path.join(artifactDirectory, "city-model.json");
  await fs.writeFile(
    temporaryPath,
    `${JSON.stringify(minimalCityModel, null, 2)}\n`,
    { mode: 0o600 },
  );
  await fs.link(temporaryPath, destination);
  expect((await fs.lstat(destination)).nlink).toBe(2);

  const restarted = await ImportArtifactStore.open({ dataDirectory });

  expect(await fs.readdir(artifactDirectory)).toEqual([]);
  await expect(fs.lstat(destination)).rejects.toMatchObject({
    code: "ENOENT",
  });
  await expect(fs.lstat(temporaryPath)).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(await restarted.statCityModel(token)).toBeUndefined();
});

it("rejects a publication crash marker with a third hard link", async () => {
  const root = await temporaryDirectory();
  const dataDirectory = path.join(root, "data");
  const token = randomUUID();
  const artifactDirectory = path.join(
    dataDirectory,
    "artifacts",
    token,
  );
  await fs.mkdir(artifactDirectory, { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(
    artifactDirectory,
    `.city-model-${randomUUID()}.tmp`,
  );
  const destination = path.join(artifactDirectory, "city-model.json");
  const unknownLink = path.join(artifactDirectory, "unknown-hard-link");
  await fs.writeFile(
    temporaryPath,
    `${JSON.stringify(minimalCityModel, null, 2)}\n`,
    { mode: 0o600 },
  );
  await fs.link(temporaryPath, destination);
  await fs.link(temporaryPath, unknownLink);
  expect((await fs.lstat(temporaryPath)).nlink).toBe(3);
  expect((await fs.lstat(destination)).nlink).toBe(3);

  await expect(
    ImportArtifactStore.open({ dataDirectory }),
  ).rejects.toMatchObject({ code: "FILESYSTEM_POLICY" });

  expect((await fs.lstat(temporaryPath)).nlink).toBe(3);
  expect((await fs.lstat(destination)).nlink).toBe(3);
  expect((await fs.lstat(unknownLink)).nlink).toBe(3);
});

it("cleans a published artifact idempotently without touching other tokens", async () => {
  const root = await temporaryDirectory();
  const dataDirectory = path.join(root, "data");
  const store = await ImportArtifactStore.open({ dataDirectory });
  const removedToken = randomUUID();
  const retainedToken = randomUUID();
  await store.publishCityModel(removedToken, minimalCityModel);
  await store.publishCityModel(retainedToken, {
    ...minimalCityModel,
    generator: { name: "code-city", version: "retained" },
  });

  await Promise.all([
    store.cleanupCityModelArtifact(removedToken),
    store.cleanupCityModelArtifact(removedToken),
  ]);
  await store.cleanupCityModelArtifact(removedToken);

  expect(await store.statCityModel(removedToken)).toBeUndefined();
  await expect(
    fs.lstat(
      path.join(dataDirectory, "artifacts", removedToken),
    ),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(await store.statCityModel(retainedToken)).toMatchObject({
    token: retainedToken,
  });
});

it("reconciles orphan artifacts while retaining validated completed-job artifacts", async () => {
  const root = await temporaryDirectory();
  const dataDirectory = path.join(root, "data");
  const store = await ImportArtifactStore.open({ dataDirectory });
  const orphanToken = randomUUID();
  const retainedToken = randomUUID();
  await store.publishCityModel(orphanToken, minimalCityModel);
  await store.publishCityModel(retainedToken, {
    ...minimalCityModel,
    generator: { name: "code-city", version: "retained" },
  });
  const retainedPath = path.join(
    dataDirectory,
    "artifacts",
    retainedToken,
    "city-model.json",
  );
  const retainedBytes = await fs.readFile(retainedPath);

  await store.reconcileCityModelArtifacts(new Set([retainedToken]));

  await expect(
    fs.lstat(path.join(dataDirectory, "artifacts", orphanToken)),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(await fs.readFile(retainedPath)).toEqual(retainedBytes);
  expect(await store.readCityModel(retainedToken)).toMatchObject({
    token: retainedToken,
    bytes: retainedBytes,
  });

  const restarted = await ImportArtifactStore.open({ dataDirectory });
  await restarted.reconcileCityModelArtifacts(new Set([retainedToken]));
  expect(await restarted.readCityModel(retainedToken)).toMatchObject({
    token: retainedToken,
    bytes: retainedBytes,
  });
});

it("fails reconciliation for missing or corrupt retained artifacts", async () => {
  const root = await temporaryDirectory();
  const dataDirectory = path.join(root, "data");
  const store = await ImportArtifactStore.open({ dataDirectory });
  const missingToken = randomUUID();

  await expect(
    store.reconcileCityModelArtifacts(new Set([missingToken])),
  ).rejects.toMatchObject({ code: "FILESYSTEM_POLICY" });

  const corruptToken = randomUUID();
  await store.publishCityModel(corruptToken, minimalCityModel);
  await fs.writeFile(
    path.join(
      dataDirectory,
      "artifacts",
      corruptToken,
      "city-model.json",
    ),
    '{"schemaVersion":"not-supported"}\n',
    "utf8",
  );

  await expect(
    store.reconcileCityModelArtifacts(new Set([corruptToken])),
  ).rejects.toMatchObject({ code: "CITY_MODEL_INVALID" });
});

it("fails closed when a missing artifact leaves unknown bytes in its token directory", async () => {
  const root = await temporaryDirectory();
  const dataDirectory = path.join(root, "data");
  const store = await ImportArtifactStore.open({ dataDirectory });
  const token = randomUUID();
  const artifactDirectory = path.join(
    dataDirectory,
    "artifacts",
    token,
  );
  const unknownPath = path.join(artifactDirectory, "unknown-data");
  await fs.mkdir(artifactDirectory, { mode: 0o700 });
  await fs.writeFile(unknownPath, "must survive\n", { mode: 0o600 });

  await expect(
    store.cleanupCityModelArtifact(token),
  ).rejects.toMatchObject({ code: "FILESYSTEM_POLICY" });
  await expect(
    store.reconcileCityModelArtifacts(new Set()),
  ).rejects.toMatchObject({ code: "FILESYSTEM_POLICY" });

  expect(await fs.readFile(unknownPath, "utf8")).toBe("must survive\n");
});

it("rejects an identity-mismatched standalone deletion marker without removing it", async () => {
  const root = await temporaryDirectory();
  const dataDirectory = path.join(root, "data");
  const store = await ImportArtifactStore.open({ dataDirectory });
  const token = randomUUID();
  const artifactDirectory = path.join(
    dataDirectory,
    "artifacts",
    token,
  );
  const markerSource = path.join(artifactDirectory, "marker-source");
  await fs.mkdir(artifactDirectory, { mode: 0o700 });
  await fs.writeFile(markerSource, "unknown marker bytes\n", {
    mode: 0o600,
  });
  const markerStatus = await fs.lstat(markerSource, { bigint: true });
  const mismatchedDevice = markerStatus.dev === 0n ? 1n : 0n;
  const markerPath = path.join(
    artifactDirectory,
    [
      ".city-model-delete",
      mismatchedDevice.toString(16),
      markerStatus.ino.toString(16),
      randomUUID(),
    ].join("-") + ".tmp",
  );
  await fs.rename(markerSource, markerPath);

  await expect(
    store.cleanupCityModelArtifact(token),
  ).rejects.toMatchObject({ code: "FILESYSTEM_POLICY" });
  await expect(
    store.reconcileCityModelArtifacts(new Set()),
  ).rejects.toMatchObject({ code: "FILESYSTEM_POLICY" });

  expect(await fs.readFile(markerPath, "utf8")).toBe(
    "unknown marker bytes\n",
  );
});

it("fails closed when an artifact disappears during cleanup and unknown bytes remain", async () => {
  const root = await temporaryDirectory();
  const dataDirectory = path.join(root, "data");
  const store = await ImportArtifactStore.open({ dataDirectory });
  const token = randomUUID();
  await store.publishCityModel(token, minimalCityModel);
  const artifactDirectory = path.join(
    dataDirectory,
    "artifacts",
    token,
  );
  const preservedPath = path.join(
    artifactDirectory,
    "disappeared-artifact",
  );
  const rename = fs.rename.bind(fs);
  let injected = false;
  const renameSpy = vi
    .spyOn(fs, "rename")
    .mockImplementation(async (source, target) => {
      if (
        !injected &&
        path.basename(String(source)) === "city-model.json"
      ) {
        injected = true;
        await rename(source, preservedPath);
        throw Object.assign(new Error("injected disappearance"), {
          code: "ENOENT",
        });
      }
      await rename(source, target);
    });

  await expect(
    store.cleanupCityModelArtifact(token),
  ).rejects.toMatchObject({ code: "FILESYSTEM_POLICY" });
  renameSpy.mockRestore();
  await expect(
    store.reconcileCityModelArtifacts(new Set()),
  ).rejects.toMatchObject({ code: "FILESYSTEM_POLICY" });

  expect(await fs.readFile(preservedPath, "utf8")).toContain(
    '"schemaVersion": "1.0"',
  );
});

it("preserves a replacement introduced while reconciling an orphan", async () => {
  const root = await temporaryDirectory();
  const dataDirectory = path.join(root, "data");
  const store = await ImportArtifactStore.open({ dataDirectory });
  const token = randomUUID();
  await store.publishCityModel(token, minimalCityModel);
  const artifactDirectory = path.join(
    dataDirectory,
    "artifacts",
    token,
  );
  const destination = path.join(artifactDirectory, "city-model.json");
  const originalBackup = path.join(artifactDirectory, "original-backup");
  const replacement = "reconciliation replacement must survive\n";
  const rename = fs.rename.bind(fs);
  let injected = false;
  const renameSpy = vi
    .spyOn(fs, "rename")
    .mockImplementation(async (source, target) => {
      if (
        !injected &&
        path.basename(String(source)) === "city-model.json"
      ) {
        injected = true;
        await rename(source, originalBackup);
        await fs.writeFile(source, replacement, { mode: 0o600 });
      }
      await rename(source, target);
    });

  await expect(
    store.reconcileCityModelArtifacts(new Set()),
  ).rejects.toMatchObject({ code: "FILESYSTEM_POLICY" });
  renameSpy.mockRestore();

  expect(await fs.readFile(destination, "utf8")).toBe(replacement);
  expect(await fs.readFile(originalBackup, "utf8")).toContain(
    '"schemaVersion": "1.0"',
  );
});

it("retries an identity-marked artifact deletion safely", async () => {
  const root = await temporaryDirectory();
  const dataDirectory = path.join(root, "data");
  const store = await ImportArtifactStore.open({ dataDirectory });
  const token = randomUUID();
  await store.publishCityModel(token, minimalCityModel);
  const artifactDirectory = path.join(
    dataDirectory,
    "artifacts",
    token,
  );
  const unlink = fs.unlink.bind(fs);
  let injected = false;
  const unlinkSpy = vi
    .spyOn(fs, "unlink")
    .mockImplementation(async (candidate) => {
      if (
        !injected &&
        path.basename(String(candidate)).startsWith(
          ".city-model-delete-",
        )
      ) {
        injected = true;
        throw new Error("injected deletion unlink failure");
      }
      await unlink(candidate);
    });

  await expect(
    store.cleanupCityModelArtifact(token),
  ).rejects.toThrow("injected deletion unlink failure");
  unlinkSpy.mockRestore();
  expect(
    (await fs.readdir(artifactDirectory)).some((name) =>
      name.startsWith(".city-model-delete-"),
    ),
  ).toBe(true);

  await store.cleanupCityModelArtifact(token);
  await expect(fs.lstat(artifactDirectory)).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("restores a regular-file replacement instead of deleting it during cleanup", async () => {
  const root = await temporaryDirectory();
  const dataDirectory = path.join(root, "data");
  const store = await ImportArtifactStore.open({ dataDirectory });
  const token = randomUUID();
  await store.publishCityModel(token, minimalCityModel);
  const artifactDirectory = path.join(
    dataDirectory,
    "artifacts",
    token,
  );
  const destination = path.join(artifactDirectory, "city-model.json");
  const originalBackup = path.join(artifactDirectory, "original-backup");
  const replacement = "replacement must survive\n";
  const rename = fs.rename.bind(fs);
  let injected = false;
  const renameSpy = vi
    .spyOn(fs, "rename")
    .mockImplementation(async (source, target) => {
      if (
        !injected &&
        path.basename(String(source)) === "city-model.json"
      ) {
        injected = true;
        await rename(source, originalBackup);
        await fs.writeFile(source, replacement, { mode: 0o600 });
      }
      await rename(source, target);
    });

  await expect(
    store.cleanupCityModelArtifact(token),
  ).rejects.toMatchObject({ code: "FILESYSTEM_POLICY" });
  renameSpy.mockRestore();

  expect(await fs.readFile(destination, "utf8")).toBe(replacement);
  expect(await fs.readFile(originalBackup, "utf8")).toContain(
    '"schemaVersion": "1.0"',
  );
  expect(
    (await fs.readdir(artifactDirectory)).some((name) =>
      name.startsWith(".city-model-delete-"),
    ),
  ).toBe(false);
});

it("repairs an interrupted replacement restoration by actual inode", async () => {
  const root = await temporaryDirectory();
  const dataDirectory = path.join(root, "data");
  const store = await ImportArtifactStore.open({ dataDirectory });
  const token = randomUUID();
  await store.publishCityModel(token, minimalCityModel);
  const artifactDirectory = path.join(
    dataDirectory,
    "artifacts",
    token,
  );
  const destination = path.join(artifactDirectory, "city-model.json");
  const originalBackup = path.join(artifactDirectory, "original-backup");
  const original = await fs.lstat(destination, { bigint: true });
  const replacement = "replacement must survive recovery\n";
  const rename = fs.rename.bind(fs);
  const unlink = fs.unlink.bind(fs);
  let replacementInjected = false;
  let unlinkFailureInjected = false;
  const renameSpy = vi
    .spyOn(fs, "rename")
    .mockImplementation(async (source, target) => {
      if (
        !replacementInjected &&
        path.basename(String(source)) === "city-model.json"
      ) {
        replacementInjected = true;
        await rename(source, originalBackup);
        await fs.writeFile(source, replacement, { mode: 0o600 });
      }
      await rename(source, target);
    });
  const unlinkSpy = vi
    .spyOn(fs, "unlink")
    .mockImplementation(async (candidate) => {
      if (
        !unlinkFailureInjected &&
        path.basename(String(candidate)).startsWith(
          ".city-model-delete-",
        )
      ) {
        unlinkFailureInjected = true;
        throw new Error("injected restoration unlink failure");
      }
      await unlink(candidate);
    });

  await expect(
    store.cleanupCityModelArtifact(token),
  ).rejects.toMatchObject({ code: "FILESYSTEM_POLICY" });
  renameSpy.mockRestore();
  unlinkSpy.mockRestore();

  const markerName = (await fs.readdir(artifactDirectory)).find((name) =>
    name.startsWith(".city-model-delete-"),
  );
  expect(markerName).toBeDefined();
  const markerPath = path.join(artifactDirectory, markerName!);
  const marker = await fs.lstat(markerPath, { bigint: true });
  const fixed = await fs.lstat(destination, { bigint: true });
  expect(marker.dev).toBe(fixed.dev);
  expect(marker.ino).toBe(fixed.ino);
  expect(marker.nlink).toBe(2n);
  expect(fixed.nlink).toBe(2n);
  expect(marker.ino).not.toBe(original.ino);

  const restarted = await ImportArtifactStore.open({ dataDirectory });

  await expect(fs.lstat(markerPath)).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(await fs.readFile(destination, "utf8")).toBe(replacement);
  expect((await fs.lstat(destination)).nlink).toBe(1);
  expect(await restarted.statCityModel(token)).toMatchObject({ token });
  expect(await fs.readFile(originalBackup, "utf8")).toContain(
    '"schemaVersion": "1.0"',
  );
});

it("reports cleanup failure when a late fixed-name replacement appears", async () => {
  const root = await temporaryDirectory();
  const dataDirectory = path.join(root, "data");
  const store = await ImportArtifactStore.open({ dataDirectory });
  const token = randomUUID();
  await store.publishCityModel(token, minimalCityModel);
  const artifactDirectory = path.join(
    dataDirectory,
    "artifacts",
    token,
  );
  const destination = path.join(artifactDirectory, "city-model.json");
  const replacement = "late replacement must survive\n";
  const unlink = fs.unlink.bind(fs);
  let injected = false;
  const unlinkSpy = vi
    .spyOn(fs, "unlink")
    .mockImplementation(async (candidate) => {
      if (
        !injected &&
        path.basename(String(candidate)).startsWith(
          ".city-model-delete-",
        )
      ) {
        injected = true;
        await fs.writeFile(destination, replacement, { mode: 0o600 });
      }
      await unlink(candidate);
    });

  await expect(
    store.cleanupCityModelArtifact(token),
  ).rejects.toMatchObject({ code: "FILESYSTEM_POLICY" });
  unlinkSpy.mockRestore();

  expect(await fs.readFile(destination, "utf8")).toBe(replacement);
  expect(
    (await fs.readdir(artifactDirectory)).some((name) =>
      name.startsWith(".city-model-delete-"),
    ),
  ).toBe(false);
});

it("preserves a symlink replacement introduced during artifact cleanup", async () => {
  const root = await temporaryDirectory();
  const external = await temporaryDirectory();
  const probe = path.join(root, "link-probe");
  if (!(await createDirectoryLink(external, probe))) return;
  await fs.rm(probe, { force: true });
  await fs.writeFile(path.join(external, "sentinel.txt"), "safe", "utf8");

  const dataDirectory = path.join(root, "data");
  const store = await ImportArtifactStore.open({ dataDirectory });
  const token = randomUUID();
  await store.publishCityModel(token, minimalCityModel);
  const artifactDirectory = path.join(
    dataDirectory,
    "artifacts",
    token,
  );
  const destination = path.join(artifactDirectory, "city-model.json");
  const originalBackup = path.join(artifactDirectory, "original-backup");
  const rename = fs.rename.bind(fs);
  let injected = false;
  const renameSpy = vi
    .spyOn(fs, "rename")
    .mockImplementation(async (source, target) => {
      if (
        !injected &&
        path.basename(String(source)) === "city-model.json"
      ) {
        injected = true;
        await rename(source, originalBackup);
        await fs.symlink(
          external,
          source,
          process.platform === "win32" ? "junction" : "dir",
        );
      }
      await rename(source, target);
    });

  await expect(
    store.cleanupCityModelArtifact(token),
  ).rejects.toMatchObject({ code: "FILESYSTEM_POLICY" });
  renameSpy.mockRestore();

  expect(await fs.readFile(path.join(external, "sentinel.txt"), "utf8")).toBe(
    "safe",
  );
  expect(await fs.readFile(originalBackup, "utf8")).toContain(
    '"schemaVersion": "1.0"',
  );
  const preserved = (await fs.readdir(artifactDirectory)).find((name) =>
    name.startsWith(".city-model-preserved-"),
  );
  expect(preserved).toBeDefined();
  expect(
    (
      await fs.lstat(path.join(artifactDirectory, preserved!))
    ).isSymbolicLink(),
  ).toBe(true);
});

it("sweeps only abandoned UUIDv4 import directories at startup", async () => {
  const root = await temporaryDirectory();
  const dataDirectory = path.join(root, "data");
  const importsDirectory = path.join(dataDirectory, "tmp", "imports");
  await fs.mkdir(importsDirectory, { recursive: true });

  const staleToken = randomUUID();
  const recentToken = randomUUID();
  const staleDirectory = path.join(importsDirectory, staleToken);
  const recentDirectory = path.join(importsDirectory, recentToken);
  const unrelatedDirectory = path.join(importsDirectory, "keep-me");
  const tokenShapedFile = path.join(importsDirectory, randomUUID());
  const neighboringTemporaryData = path.join(
    dataDirectory,
    "tmp",
    "unrelated",
  );
  await fs.mkdir(staleDirectory);
  await fs.mkdir(recentDirectory);
  await fs.mkdir(unrelatedDirectory);
  await fs.mkdir(neighboringTemporaryData);
  await fs.writeFile(path.join(staleDirectory, "upload.zip"), "old", "utf8");
  await fs.writeFile(path.join(recentDirectory, "upload.zip"), "new", "utf8");
  await fs.writeFile(tokenShapedFile, "not a staging directory", "utf8");
  await fs.writeFile(
    path.join(neighboringTemporaryData, "sentinel"),
    "safe",
    "utf8",
  );
  if (process.platform !== "win32") {
    await fs.chmod(recentDirectory, 0o755);
  }

  const staleDate = new Date(Date.now() - 48 * 60 * 60 * 1_000);
  await fs.utimes(staleDirectory, staleDate, staleDate);
  await fs.utimes(unrelatedDirectory, staleDate, staleDate);
  await fs.utimes(tokenShapedFile, staleDate, staleDate);

  await ImportArtifactStore.open({ dataDirectory });

  await expect(fs.lstat(staleDirectory)).rejects.toMatchObject({
    code: "ENOENT",
  });
  await expect(fs.lstat(recentDirectory)).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect((await fs.lstat(unrelatedDirectory)).isDirectory()).toBe(true);
  expect((await fs.lstat(tokenShapedFile)).isFile()).toBe(true);
  expect(
    await fs.readFile(
      path.join(neighboringTemporaryData, "sentinel"),
      "utf8",
    ),
  ).toBe("safe");
});

it("enforces the fixed city-model size limit before stat or read", async () => {
  expect(IMPORT_CITY_MODEL_MAX_BYTES).toBe(128 * 1024 * 1024);
  const root = await temporaryDirectory();
  const dataDirectory = path.join(root, "data");
  const store = await ImportArtifactStore.open({ dataDirectory });
  const token = randomUUID();
  const artifactDirectory = path.join(
    dataDirectory,
    "artifacts",
    token,
  );
  const artifactPath = path.join(artifactDirectory, "city-model.json");
  await fs.mkdir(artifactDirectory, { mode: 0o700 });
  await fs.writeFile(artifactPath, "", { mode: 0o600 });
  await fs.truncate(artifactPath, IMPORT_CITY_MODEL_MAX_BYTES + 1);

  await expect(store.statCityModel(token)).rejects.toMatchObject({
    code: "CITY_MODEL_TOO_LARGE",
  });
  await expect(store.readCityModel(token)).rejects.toMatchObject({
    code: "CITY_MODEL_TOO_LARGE",
  });
});

it("flushes artifact directory mutations on POSIX", async () => {
  if (process.platform === "win32") return;

  const root = await temporaryDirectory();
  const dataDirectory = path.join(root, "data");
  const store = await ImportArtifactStore.open({ dataDirectory });
  const token = randomUUID();
  const artifactsDirectory = await fs.realpath(
    path.join(dataDirectory, "artifacts"),
  );
  const artifactDirectory = path.join(artifactsDirectory, token);
  const directorySyncs: string[] = [];
  const open = fs.open.bind(fs);
  const openSpy = vi
    .spyOn(fs, "open")
    .mockImplementation(async (candidate, flags, mode) => {
      const handle =
        mode === undefined
          ? await open(candidate, flags)
          : await open(candidate, flags, mode);
      const openedPath = path.resolve(String(candidate));
      if (
        openedPath !== artifactsDirectory &&
        openedPath !== artifactDirectory
      ) {
        return handle;
      }
      return new Proxy(handle, {
        get(target, property) {
          if (property === "sync") {
            return async () => {
              directorySyncs.push(openedPath);
              await target.sync();
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function"
            ? value.bind(target)
            : value;
        },
      }) as FileHandle;
    });

  await store.publishCityModel(token, minimalCityModel);
  await store.cleanupCityModelArtifact(token);
  openSpy.mockRestore();

  expect(directorySyncs).toContain(artifactDirectory);
  expect(directorySyncs).toContain(artifactsDirectory);
});
