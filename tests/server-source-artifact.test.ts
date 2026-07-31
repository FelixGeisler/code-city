import { createHash } from "node:crypto";
import {
  existsSync,
  promises as fs,
  readdirSync,
  statSync,
  type BigIntStats,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { analyzeRepositorySnapshots } from "../packages/analyzer/src/index.js";
import type { RepositorySnapshot } from "../packages/analyzer/src/snapshot.js";
import {
  attachSourceProvenance,
  createSourceArtifact,
  parseSourceArtifact,
  parseSourceArtifactIndex,
  serializeSourceArtifact,
  SOURCE_ARTIFACT_MAX_FILE_BYTES,
  SOURCE_ARTIFACT_VERSION,
  SOURCE_ARTIFACT_PREFIX_BYTES,
  sourceArtifactIndexLength,
  sourceArtifactFile,
  uploadedSnapshotProvenance,
  type SourceArtifact,
} from "../apps/server/src/source-artifact.js";
import { SourceArtifactStore } from "../apps/server/src/source-artifact-store.js";

const roots: string[] = [];
const TOKEN = "123e4567-e89b-42d3-a456-426614174000";

function snapshot(
  text = "export function answer() {\n  return 42;\n}\n",
  byteLength = Buffer.byteLength(text),
): RepositorySnapshot {
  return {
    name: "example",
    files: [
      {
        path: "src/answer.ts",
        text,
        byteLength,
      },
    ],
    diagnostics: [],
  };
}

async function fixture(
  text = "export function answer() {\n  return 42;\n}\n",
  byteLength = Buffer.byteLength(text),
) {
  const retained = snapshot(text, byteLength);
  const analyzed = await analyzeRepositorySnapshots([retained]);
  const repository = analyzed.repositories[0]!;
  const model = attachSourceProvenance(analyzed, [
    uploadedSnapshotProvenance(repository.id, retained),
  ]);
  return {
    model,
    artifact: createSourceArtifact(model, [
      { repositoryId: repository.id, snapshot: retained },
    ]),
  };
}

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "code-city-source-"),
  );
  roots.push(root);
  await fs.chmod(root, 0o700);
  return root;
}

function withInode(status: BigIntStats, inode: bigint): BigIntStats {
  return new Proxy(status, {
    get(target, property) {
      if (property === "ino") return inode;
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function multipleFileFixture() {
  const firstText = "export const alpha = 1;\n";
  const secondText = `// large unrelated file\n${"// filler\n".repeat(200_000)}`;
  const retained: RepositorySnapshot = {
    name: "multiple",
    files: [
      {
        path: "src/alpha.ts",
        text: firstText,
        byteLength: Buffer.byteLength(firstText),
      },
      {
        path: "src/beta.ts",
        text: secondText,
        byteLength: Buffer.byteLength(secondText),
      },
    ],
    diagnostics: [],
  };
  const model = await analyzeRepositorySnapshots([retained]);
  const repository = model.repositories[0]!;
  const retainedModel = attachSourceProvenance(model, [
    uploadedSnapshotProvenance(repository.id, retained),
  ]);
  return {
    model: retainedModel,
    artifact: createSourceArtifact(retainedModel, [
      { repositoryId: repository.id, snapshot: retained },
    ]),
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) =>
      fs.rm(root, { recursive: true, force: true }),
    ),
  );
});

describe("source artifacts", () => {
  it("preserves the byte-for-byte v2 pack golden and both digests", () => {
    const text = "export const answer = 42;\n";
    const artifact: SourceArtifact = {
      version: SOURCE_ARTIFACT_VERSION,
      provenance: {
        version: "codecity.source-navigation/1",
        repositories: [
          {
            repositoryId: "repo",
            provider: "uploaded-archive",
            revision: {
              kind: "snapshot",
              value:
                "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            },
          },
        ],
      },
      files: [
        {
          buildingId: "building",
          repositoryId: "repo",
          path: "src/answer.ts",
          language: "typescript",
          location: { startLine: 1, endLine: 2 },
          text,
        },
      ],
    };
    const expectedPrefix = Buffer.from(
      "434353524330320a00000209",
      "hex",
    );
    const expectedIndex = Buffer.from(
      '{"version":"codecity.source-artifact/2",' +
        '"provenance":{"version":"codecity.source-navigation/1",' +
        '"repositories":[{"repositoryId":"repo",' +
        '"provider":"uploaded-archive",' +
        '"revision":{"kind":"snapshot",' +
        '"value":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}]},' +
        '"files":[{"buildingId":"building","repositoryId":"repo",' +
        '"path":"src/answer.ts","language":"typescript",' +
        '"location":{"startLine":1,"endLine":2},' +
        '"offset":0,"size":26,' +
        '"sha256":"a2098bd92b10bf8b816d24b7556b1ce8c49a879d130489065ef1051c17e042f6"}]}',
      "utf8",
    );
    const expected = Buffer.concat([
      expectedPrefix,
      expectedIndex,
      Buffer.from(text, "utf8"),
    ]);
    const serialized = serializeSourceArtifact(artifact);

    expect(expectedIndex.byteLength).toBe(521);
    expect(expected.byteLength).toBe(559);
    expect(serialized).toEqual(expected);
    expect(
      serialized.subarray(0, SOURCE_ARTIFACT_PREFIX_BYTES),
    ).toEqual(expectedPrefix);
    expect(
      serialized.subarray(
        SOURCE_ARTIFACT_PREFIX_BYTES,
        SOURCE_ARTIFACT_PREFIX_BYTES + expectedIndex.byteLength,
      ),
    ).toEqual(expectedIndex);
    expect(
      serialized.subarray(
        SOURCE_ARTIFACT_PREFIX_BYTES + expectedIndex.byteLength,
      ),
    ).toEqual(Buffer.from(text, "utf8"));
    expect(createHash("sha256").update(serialized).digest("hex")).toBe(
      "7776f3510c55b1f01b27085c738282b2975adb218aeedb428a65fea6fde6aa2f",
    );
    expect(createHash("sha256").update(expectedIndex).digest("hex")).toBe(
      "6c91817958273857d9fc360fc74e30e2ce97fa484a3f6b3585078318eea28d88",
    );
  });

  it("keeps UTF-8 bytes exact when a surrogate pair crosses a work boundary", () => {
    const text = `${"a".repeat(16 * 1024 - 1)}😀tail`;
    const artifact: SourceArtifact = {
      version: SOURCE_ARTIFACT_VERSION,
      provenance: {
        version: "codecity.source-navigation/1",
        repositories: [
          {
            repositoryId: "repo",
            provider: "uploaded-archive",
            revision: {
              kind: "snapshot",
              value:
                "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            },
          },
        ],
      },
      files: [
        {
          buildingId: "building",
          repositoryId: "repo",
          path: "src/unicode.ts",
          language: "typescript",
          location: { startLine: 1, endLine: 1 },
          text,
        },
      ],
    };
    const serialized = serializeSourceArtifact(artifact);
    const indexLength = sourceArtifactIndexLength(
      serialized.subarray(0, SOURCE_ARTIFACT_PREFIX_BYTES),
    );
    expect(
      serialized.subarray(
        SOURCE_ARTIFACT_PREFIX_BYTES + indexLength,
      ),
    ).toEqual(Buffer.from(text, "utf8"));
    expect(parseSourceArtifact(serialized).files[0]?.text).toBe(text);
  });

  it("serializes deterministically and binds a file to its exact model identity", async () => {
    const { model, artifact } = await fixture();
    const bytes = serializeSourceArtifact(artifact);
    expect(serializeSourceArtifact(parseSourceArtifact(bytes))).toEqual(
      bytes,
    );
    const building = model.buildings[0]!;
    expect(sourceArtifactFile(artifact, model, building.id)?.text).toContain(
      "return 42",
    );
    expect(
      sourceArtifactFile(
        artifact,
        {
          ...model,
          buildings: [{ ...building, path: "src/other.ts" }],
        },
        building.id,
      ),
    ).toBeUndefined();
  });

  it("publishes privately, verifies reads, reconciles, and removes a source artifact", async () => {
    const root = await temporaryRoot();
    const store = await SourceArtifactStore.open({
      dataDirectory: root,
    });
    const { artifact } = await fixture();
    const published = await store.publish(TOKEN, artifact);
    const bytes = serializeSourceArtifact(artifact);
    const indexLength = sourceArtifactIndexLength(
      bytes.subarray(0, SOURCE_ARTIFACT_PREFIX_BYTES),
    );
    expect(published).toMatchObject({
      size: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      indexSha256: createHash("sha256")
        .update(
          bytes.subarray(
            SOURCE_ARTIFACT_PREFIX_BYTES,
            SOURCE_ARTIFACT_PREFIX_BYTES + indexLength,
          ),
        )
        .digest("hex"),
    });
    const read = await store.read(TOKEN);
    expect(read).toMatchObject({
      token: TOKEN,
      size: published.size,
      sha256: published.sha256,
    });
    await store.reconcile(
      new Map([[TOKEN, published]]),
    );
    await store.cleanup(TOKEN);
    expect(await store.read(TOKEN)).toBeUndefined();
  });

  it("rejects a pre-existing source-directory link without chmodding its target", async () => {
    const root = await temporaryRoot();
    const target = path.join(root, "linked-source-target");
    await fs.mkdir(target, { mode: 0o755 });
    if (process.platform !== "win32") {
      await fs.chmod(target, 0o755);
    }
    const beforeMode = (await fs.stat(target)).mode & 0o777;
    await fs.symlink(
      target,
      path.join(root, "sources"),
      process.platform === "win32" ? "junction" : "dir",
    );

    await expect(
      SourceArtifactStore.open({ dataDirectory: root }),
    ).rejects.toThrow(/private regular directory|escaped its private parent/u);
    if (process.platform !== "win32") {
      expect((await fs.stat(target)).mode & 0o777).toBe(beforeMode);
    }
  });

  it.skipIf(process.platform === "win32")(
    "rejects a child-directory swap before handle-pinned chmod",
    async () => {
      const root = await temporaryRoot();
      const sources = path.join(root, "sources");
      const displaced = path.join(root, "sources-before-swap");
      const open = fs.open.bind(fs);
      let swapped = false;
      vi.spyOn(fs, "open").mockImplementation(
        async (candidate, flags, mode) => {
          if (
            !swapped &&
            path.resolve(String(candidate)) === path.resolve(sources)
          ) {
            swapped = true;
            await fs.rename(sources, displaced);
            await fs.mkdir(sources, { mode: 0o755 });
            await fs.chmod(sources, 0o755);
          }
          return mode === undefined
            ? open(candidate, flags)
            : open(candidate, flags, mode);
        },
      );

      await expect(
        SourceArtifactStore.open({ dataDirectory: root }),
      ).rejects.toThrow(/changed while it was initialized/u);
      expect(swapped).toBe(true);
      expect((await fs.stat(sources)).mode & 0o777).toBe(0o755);
    },
  );

  it("rejects a child-directory swap during final canonical resolution", async () => {
    const root = await temporaryRoot();
    const canonicalRoot = await fs.realpath(root);
    const sources = path.join(canonicalRoot, "sources");
    const displaced = path.join(
      canonicalRoot,
      "sources-during-realpath",
    );
    const realpath = fs.realpath.bind(fs);
    let sourceResolutions = 0;
    let swapped = false;
    vi.spyOn(fs, "realpath").mockImplementation(
      async (...arguments_) => {
        const resolved = await realpath(...arguments_);
        if (
          path.resolve(String(arguments_[0])) === path.resolve(sources)
        ) {
          sourceResolutions += 1;
          if (sourceResolutions === 2) {
            await fs.rename(sources, displaced);
            await fs.mkdir(sources, { mode: 0o755 });
            if (process.platform !== "win32") {
              await fs.chmod(sources, 0o755);
            }
            swapped = true;
          }
        }
        return resolved;
      },
    );

    await expect(
      SourceArtifactStore.open({ dataDirectory: root }),
    ).rejects.toThrow(/changed while it was initialized/u);
    expect(swapped).toBe(true);
    if (process.platform !== "win32") {
      expect((await fs.stat(sources)).mode & 0o777).toBe(0o755);
    }
  });

  it.skipIf(process.platform !== "win32")(
    "rejects an unavailable child-directory file ID on Windows",
    async () => {
      const root = await temporaryRoot();
      const sources = path.join(await fs.realpath(root), "sources");
      const lstat = fs.lstat.bind(fs);
      let sourceStats = 0;
      vi.spyOn(fs, "lstat").mockImplementation(
        async (candidate, options) => {
          expect(options).toEqual({ bigint: true });
          const status = await lstat(candidate, { bigint: true });
          if (
            path.resolve(String(candidate)) !== path.resolve(sources)
          ) {
            return status;
          }
          sourceStats += 1;
          return withInode(status, 0n);
        },
      );

      await expect(
        SourceArtifactStore.open({ dataDirectory: root }),
      ).rejects.toThrow(/private regular directory/u);
      expect(sourceStats).toBe(1);
    },
  );

  it.skipIf(process.platform !== "win32")(
    "compares exact 64-bit child-directory identities on Windows",
    async () => {
      const root = await temporaryRoot();
      const sources = path.join(await fs.realpath(root), "sources");
      const lstat = fs.lstat.bind(fs);
      const firstInode = 2n ** 54n;
      const secondInode = firstInode + 1n;
      let sourceStats = 0;

      expect(Number(firstInode)).toBe(Number(secondInode));
      vi.spyOn(fs, "lstat").mockImplementation(
        async (candidate, options) => {
          expect(options).toEqual({ bigint: true });
          const status = await lstat(candidate, { bigint: true });
          if (
            path.resolve(String(candidate)) !== path.resolve(sources)
          ) {
            return status;
          }
          sourceStats += 1;
          return withInode(
            status,
            sourceStats === 1 ? firstInode : secondInode,
          );
        },
      );

      await expect(
        SourceArtifactStore.open({ dataDirectory: root }),
      ).rejects.toThrow(/changed while it was initialized/u);
      expect(sourceStats).toBe(2);
    },
  );

  it("cancels a partial staged write promptly and releases the token", async () => {
    const root = await temporaryRoot();
    const store = await SourceArtifactStore.open({
      dataDirectory: root,
    });
    const { artifact } = await fixture();
    const artifactDirectory = path.join(root, "sources", TOKEN);
    const controller = new AbortController();
    let observedStageBytes = 0;

    await expect(
      store.publish(TOKEN, artifact, {
        signal: controller.signal,
        checkpoint: () => {
          if (!existsSync(artifactDirectory)) return;
          const stage = readdirSync(artifactDirectory).find((name) =>
            /^\.source-.*\.tmp$/u.test(name),
          );
          if (stage === undefined) return;
          observedStageBytes = statSync(
            path.join(artifactDirectory, stage),
          ).size;
          if (observedStageBytes > 0) controller.abort();
        },
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(observedStageBytes).toBeGreaterThan(0);
    expect(observedStageBytes).toBeLessThanOrEqual(64 * 1024);
    expect(existsSync(artifactDirectory)).toBe(false);
    expect(await store.read(TOKEN)).toBeUndefined();

    await expect(store.publish(TOKEN, artifact)).resolves.toMatchObject({
      token: TOKEN,
    });
  });

  it("cancels bounded source preparation before creating a stage", async () => {
    const root = await temporaryRoot();
    const store = await SourceArtifactStore.open({
      dataDirectory: root,
    });
    const { artifact } = await fixture();
    const source = artifact.files[0]!;
    const largeArtifact: SourceArtifact = {
      ...artifact,
      files: [
        {
          ...source,
          location: { startLine: 1, endLine: 1 },
          text: "x".repeat(2 * 1024 * 1024),
        },
      ],
    };
    const artifactDirectory = path.join(root, "sources", TOKEN);
    const controller = new AbortController();
    let preparationCheckpoints = 0;

    await expect(
      store.publish(TOKEN, largeArtifact, {
        signal: controller.signal,
        checkpoint: () => {
          if (!existsSync(artifactDirectory)) return;
          const stage = readdirSync(artifactDirectory).find((name) =>
            /^\.source-.*\.tmp$/u.test(name),
          );
          if (stage !== undefined) return;
          preparationCheckpoints += 1;
          if (preparationCheckpoints === 100) controller.abort();
        },
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(preparationCheckpoints).toBe(100);
    expect(existsSync(artifactDirectory)).toBe(false);
  });

  it("removes both links when cancellation lands after publication linking", async () => {
    const root = await temporaryRoot();
    const store = await SourceArtifactStore.open({
      dataDirectory: root,
    });
    const { artifact } = await fixture();
    const artifactDirectory = path.join(root, "sources", TOKEN);
    const controller = new AbortController();
    const link = fs.link.bind(fs);
    vi.spyOn(fs, "link").mockImplementation(
      async (existingPath, newPath) => {
        await link(existingPath, newPath);
        controller.abort();
      },
    );

    await expect(
      store.publish(TOKEN, artifact, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(existsSync(artifactDirectory)).toBe(false);
    expect(await store.read(TOKEN)).toBeUndefined();
  });

  it("rejects and removes a pack changed before post-write verification", async () => {
    const root = await temporaryRoot();
    const store = await SourceArtifactStore.open({
      dataDirectory: root,
    });
    const { artifact } = await fixture();
    const artifactDirectory = path.join(root, "sources", TOKEN);
    const pack = path.join(artifactDirectory, "source.pack");
    const unlink = fs.unlink.bind(fs);
    let corrupted = false;
    vi.spyOn(fs, "unlink").mockImplementation(async (candidate) => {
      await unlink(candidate);
      if (
        corrupted ||
        !/^\.source-.*\.tmp$/u.test(path.basename(String(candidate)))
      ) {
        return;
      }
      corrupted = true;
      const handle = await fs.open(pack, "r+");
      try {
        const status = await handle.stat();
        const byte = Buffer.alloc(1);
        await handle.read(byte, 0, 1, status.size - 1);
        byte[0] = byte[0]! ^ 1;
        await handle.write(byte, 0, 1, status.size - 1);
        await handle.sync();
      } finally {
        await handle.close();
      }
    });

    await expect(store.publish(TOKEN, artifact)).rejects.toThrow(/digest/u);
    expect(corrupted).toBe(true);
    expect(existsSync(artifactDirectory)).toBe(false);
  });

  it("rejects a snapshot whose line count no longer matches the model", async () => {
    const { model } = await fixture();
    const repositoryId = model.repositories[0]!.id;
    expect(() =>
      createSourceArtifact(model, [
        { repositoryId, snapshot: snapshot("export const answer = 42;\n") },
      ]),
    ).toThrow(/source location does not match/u);
  });

  it("accepts the normalized file maximum and rejects raw overflow or forged deltas", async () => {
    const { model } = await fixture();
    const repositoryId = model.repositories[0]!.id;
    const maximumText = "x".repeat(SOURCE_ARTIFACT_MAX_FILE_BYTES);
    const boundaryModel = {
      ...model,
      buildings: model.buildings.map((building) => ({
        ...building,
        sourceLocation: { startLine: 1, endLine: 1 },
      })),
    };
    const maximumSnapshot = snapshot(maximumText);
    expect(
      createSourceArtifact(boundaryModel, [
        { repositoryId, snapshot: maximumSnapshot },
      ]).files[0]?.text.length,
    ).toBe(SOURCE_ARTIFACT_MAX_FILE_BYTES);

    expect(() =>
      createSourceArtifact(boundaryModel, [
        {
          repositoryId,
          snapshot: {
            ...maximumSnapshot,
            files: [
              {
                ...maximumSnapshot.files[0]!,
                byteLength: SOURCE_ARTIFACT_MAX_FILE_BYTES + 3,
              },
            ],
          },
        },
      ]),
    ).toThrow(/outside its limits/u);

    const retained = snapshot();
    expect(() =>
      createSourceArtifact(model, [
        {
          repositoryId,
          snapshot: {
            ...retained,
            files: [
              {
                ...retained.files[0]!,
                byteLength: retained.files[0]!.byteLength + 1,
              },
            ],
          },
        },
      ]),
    ).toThrow(/outside its limits/u);
  });

  it("rejects malformed offsets, truncation, and selected payload digest changes", async () => {
    const { artifact } = await fixture();
    const bytes = serializeSourceArtifact(artifact);
    const indexLength = sourceArtifactIndexLength(
      bytes.subarray(0, SOURCE_ARTIFACT_PREFIX_BYTES),
    );
    const payloadOffset = SOURCE_ARTIFACT_PREFIX_BYTES + indexLength;
    const malformed = Buffer.from(bytes);
    const index = JSON.parse(
      malformed
        .subarray(SOURCE_ARTIFACT_PREFIX_BYTES, payloadOffset)
        .toString("utf8"),
    ) as { files: Array<{ offset: number }> };
    index.files[0]!.offset = 1;
    const malformedIndex = Buffer.from(JSON.stringify(index), "utf8");
    expect(malformedIndex.byteLength).toBe(indexLength);
    malformedIndex.copy(malformed, SOURCE_ARTIFACT_PREFIX_BYTES);
    expect(() => parseSourceArtifact(malformed)).toThrow(/offset|bounds/u);
    expect(() => parseSourceArtifact(bytes.subarray(0, -1))).toThrow(
      /bounds|truncated/u,
    );
    const corrupt = Buffer.from(bytes);
    corrupt[payloadOffset] = corrupt[payloadOffset]! ^ 1;
    expect(() => parseSourceArtifact(corrupt)).toThrow(/digest/u);
  });

  it("rejects malformed payload UTF-8 after its digest is recomputed", async () => {
    const { artifact } = await fixture();
    const malformed = Buffer.from(serializeSourceArtifact(artifact));
    const indexLength = sourceArtifactIndexLength(
      malformed.subarray(0, SOURCE_ARTIFACT_PREFIX_BYTES),
    );
    const payloadOffset = SOURCE_ARTIFACT_PREFIX_BYTES + indexLength;
    malformed[payloadOffset] = 0xc3;
    malformed[payloadOffset + 1] = 0x28;
    const index = JSON.parse(
      malformed
        .subarray(SOURCE_ARTIFACT_PREFIX_BYTES, payloadOffset)
        .toString("utf8"),
    ) as { files: Array<{ sha256: string }> };
    index.files[0]!.sha256 = createHash("sha256")
      .update(malformed.subarray(payloadOffset))
      .digest("hex");
    const indexBytes = Buffer.from(JSON.stringify(index), "utf8");
    expect(indexBytes.byteLength).toBe(indexLength);
    indexBytes.copy(malformed, SOURCE_ARTIFACT_PREFIX_BYTES);

    expect(() => parseSourceArtifact(malformed)).toThrow(/valid UTF-8/u);
  });

  it("reads only the selected file while reconciliation detects a corrupt large sibling", async () => {
    const root = await temporaryRoot();
    const store = await SourceArtifactStore.open({ dataDirectory: root });
    const { model, artifact } = await multipleFileFixture();
    const published = await store.publish(TOKEN, artifact);
    const bytes = serializeSourceArtifact(artifact);
    const indexLength = sourceArtifactIndexLength(
      bytes.subarray(0, SOURCE_ARTIFACT_PREFIX_BYTES),
    );
    const index = parseSourceArtifactIndex(
      bytes.subarray(
        SOURCE_ARTIFACT_PREFIX_BYTES,
        SOURCE_ARTIFACT_PREFIX_BYTES + indexLength,
      ),
    );
    const sibling = index.files[1]!;
    const siblingPosition =
      SOURCE_ARTIFACT_PREFIX_BYTES + indexLength + sibling.offset;
    const packPath = path.join(
      root,
      "sources",
      TOKEN,
      "source.pack",
    );
    const handle = await fs.open(packPath, "r+");
    try {
      const byte = Buffer.alloc(1);
      await handle.read(byte, 0, 1, siblingPosition);
      byte[0] = byte[0]! ^ 1;
      await handle.write(byte, 0, 1, siblingPosition);
      await handle.sync();
    } finally {
      await handle.close();
    }

    const selected = await store.readFile(
      TOKEN,
      model.buildings[0]!.id,
      published,
    );
    expect(selected?.file.text).toContain("alpha");
    await expect(
      store.reconcile(new Map([[TOKEN, published]])),
    ).rejects.toThrow(/digest/u);
  });

  it.skipIf(process.platform === "win32")(
    "rejects replacement of the fixed source-pack pathname during a read",
    async () => {
      const root = await temporaryRoot();
      const store = await SourceArtifactStore.open({
        dataDirectory: root,
      });
      const { artifact, model } = await fixture();
      const published = await store.publish(TOKEN, artifact);
      const pack = path.join(
        root,
        "sources",
        TOKEN,
        "source.pack",
      );
      const displaced = `${pack}.displaced`;
      const realpath = fs.realpath.bind(fs);
      let packResolutions = 0;
      let replaced = false;
      vi.spyOn(fs, "realpath").mockImplementation(async (...arguments_) => {
        const resolved = await realpath(...arguments_);
        if (
          path.resolve(String(arguments_[0])) === path.resolve(pack)
        ) {
          packResolutions += 1;
          if (packResolutions === 2) {
            await fs.rename(pack, displaced);
            await fs.copyFile(displaced, pack);
            await fs.chmod(pack, 0o600);
            replaced = true;
          }
        }
        return resolved;
      });

      await expect(
        store.readFile(
          TOKEN,
          model.buildings[0]!.id,
          published,
        ),
      ).rejects.toThrow(/changed while it was read/u);
      expect(replaced).toBe(true);
    },
  );

  it("closes the publication handle when fixed-path resolution fails", async () => {
    const root = await temporaryRoot();
    const store = await SourceArtifactStore.open({
      dataDirectory: root,
    });
    const { artifact } = await fixture();
    const open = fs.open.bind(fs);
    const realpath = fs.realpath.bind(fs);
    const sentinel = new Error("injected source-pack realpath failure");
    let sourceHandleClosed = false;
    vi.spyOn(fs, "open").mockImplementation(
      async (candidate, flags, mode) => {
        const handle =
          mode === undefined
            ? await open(candidate, flags)
            : await open(candidate, flags, mode);
        if (path.basename(String(candidate)) !== "source.pack") {
          return handle;
        }
        return new Proxy(handle, {
          get(target, property) {
            if (property === "close") {
              return async () => {
                sourceHandleClosed = true;
                await target.close();
              };
            }
            const value = Reflect.get(target, property, target) as unknown;
            return typeof value === "function"
              ? value.bind(target)
              : value;
          },
        });
      },
    );
    vi.spyOn(fs, "realpath").mockImplementation(
      async (...arguments_) => {
        if (path.basename(String(arguments_[0])) === "source.pack") {
          throw sentinel;
        }
        return realpath(...arguments_);
      },
    );

    await expect(store.publish(TOKEN, artifact)).rejects.toBe(sentinel);
    expect(sourceHandleClosed).toBe(true);
    expect(existsSync(path.join(root, "sources", TOKEN))).toBe(false);
  });

  it("removes the stage when its initial identity read fails", async () => {
    const root = await temporaryRoot();
    const store = await SourceArtifactStore.open({
      dataDirectory: root,
    });
    const { artifact } = await fixture();
    const open = fs.open.bind(fs);
    const sentinel = new Error("injected staged source identity failure");
    let stageHandleClosed = false;
    vi.spyOn(fs, "open").mockImplementation(
      async (candidate, flags, mode) => {
        const handle =
          mode === undefined
            ? await open(candidate, flags)
            : await open(candidate, flags, mode);
        if (!/^\.source-.*\.tmp$/u.test(path.basename(String(candidate)))) {
          return handle;
        }
        return new Proxy(handle, {
          get(target, property) {
            if (property === "stat") {
              return async () => {
                throw sentinel;
              };
            }
            if (property === "close") {
              return async () => {
                stageHandleClosed = true;
                await target.close();
              };
            }
            const value = Reflect.get(target, property, target) as unknown;
            return typeof value === "function"
              ? value.bind(target)
              : value;
          },
        });
      },
    );

    await expect(store.publish(TOKEN, artifact)).rejects.toBe(sentinel);
    expect(stageHandleClosed).toBe(true);
    expect(existsSync(path.join(root, "sources", TOKEN))).toBe(false);
  });

  it("retains empty, BOM-normalized, and leading U+FEFF source exactly", async () => {
    const regular = "export const bom = true;\n";
    // Two physical UTF-8 BOMs become one intentional leading U+FEFF plus
    // three omitted raw bytes during snapshot ingestion.
    const leadingByteOrderMark =
      "\uFEFFexport const leadingBom = true;\n";
    const retained: RepositorySnapshot = {
      name: "example",
      files: [
        {
          path: "src/bom-leading.ts",
          text: leadingByteOrderMark,
          byteLength: Buffer.byteLength(leadingByteOrderMark) + 3,
        },
        {
          path: "src/bom.ts",
          text: regular,
          byteLength: Buffer.byteLength(regular) + 3,
        },
        {
          path: "src/bom-only.ts",
          text: "",
          byteLength: 3,
        },
        {
          path: "src/empty.ts",
          text: "",
          byteLength: 0,
        },
      ],
      diagnostics: [],
    };
    const model = await analyzeRepositorySnapshots([retained]);
    const repository = model.repositories[0]!;
    const retainedModel = attachSourceProvenance(model, [
      uploadedSnapshotProvenance(repository.id, retained),
    ]);
    const artifact = createSourceArtifact(retainedModel, [
      { repositoryId: repository.id, snapshot: retained },
    ]);
    const parsed = parseSourceArtifact(
      serializeSourceArtifact(artifact),
    );
    expect(
      parsed.files.map(({ path: sourcePath, text }) => ({
        path: sourcePath,
        text,
      })),
    ).toEqual([
      {
        path: "src/bom-leading.ts",
        text: leadingByteOrderMark,
      },
      { path: "src/bom-only.ts", text: "" },
      { path: "src/bom.ts", text: regular },
      { path: "src/empty.ts", text: "" },
    ]);
    expect(
      parsed.files.find(({ path: sourcePath }) =>
        sourcePath === "src/bom-only.ts"
      ),
    ).toMatchObject({
      text: "",
      location: { startLine: 1, endLine: 1 },
    });

    const root = await temporaryRoot();
    const store = await SourceArtifactStore.open({
      dataDirectory: root,
    });
    const published = await store.publish(TOKEN, artifact);
    const leadingBuilding = retainedModel.buildings.find(
      ({ path: sourcePath }) =>
        sourcePath === "src/bom-leading.ts",
    )!;
    const emptyBuilding = retainedModel.buildings.find(
      ({ path: sourcePath }) => sourcePath === "src/empty.ts",
    )!;
    expect(
      (
        await store.readFile(
          TOKEN,
          leadingBuilding.id,
          published,
        )
      )?.file.text,
    ).toBe(leadingByteOrderMark);
    expect(
      (
        await store.readFile(
          TOKEN,
          emptyBuilding.id,
          published,
        )
      )?.file.text,
    ).toBe("");
    await expect(
      store.reconcile(new Map([[TOKEN, published]])),
    ).resolves.toBeUndefined();
  });
});
