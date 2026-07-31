import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { analyzeRepositorySnapshots } from "../packages/analyzer/src/index.js";
import type { RepositorySnapshot } from "../packages/analyzer/src/snapshot.js";
import {
  attachSourceProvenance,
  createSourceArtifact,
  parseSourceArtifact,
  parseSourceArtifactIndex,
  serializeSourceArtifact,
  SOURCE_ARTIFACT_MAX_FILE_BYTES,
  SOURCE_ARTIFACT_PREFIX_BYTES,
  sourceArtifactIndexLength,
  sourceArtifactFile,
  uploadedSnapshotProvenance,
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
  await Promise.all(
    roots.splice(0).map((root) =>
      fs.rm(root, { recursive: true, force: true }),
    ),
  );
});

describe("source artifacts", () => {
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
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "code-city-source-"));
    roots.push(root);
    await fs.chmod(root, 0o700);
    const store = await SourceArtifactStore.open({
      dataDirectory: root,
    });
    const { artifact } = await fixture();
    const published = await store.publish(TOKEN, artifact);
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

  it("rejects a snapshot whose line count no longer matches the model", async () => {
    const { model } = await fixture();
    const repositoryId = model.repositories[0]!.id;
    expect(() =>
      createSourceArtifact(model, [
        { repositoryId, snapshot: snapshot("export const answer = 42;\n") },
      ]),
    ).toThrow(/source location does not match/u);
  });

  it("retains normalized BOM-prefixed and BOM-only source text", async () => {
    const source = "export const answer = 42;\n";
    const bom = await fixture(source, Buffer.byteLength(source) + 3);
    expect(bom.artifact.files[0]?.text).toBe(source);
    expect(parseSourceArtifact(serializeSourceArtifact(bom.artifact)).files[0])
      .toMatchObject({ text: source });

    const empty = await fixture("", 3);
    const bytes = serializeSourceArtifact(empty.artifact);
    const parsed = parseSourceArtifact(bytes);
    expect(parsed.files[0]).toMatchObject({
      location: { startLine: 1, endLine: 1 },
      text: "",
    });

    const root = await fs.mkdtemp(path.join(os.tmpdir(), "code-city-source-"));
    roots.push(root);
    await fs.chmod(root, 0o700);
    const store = await SourceArtifactStore.open({ dataDirectory: root });
    const published = await store.publish(TOKEN, empty.artifact);
    await expect(
      store.readFile(
        TOKEN,
        empty.model.buildings[0]!.id,
        published,
      ),
    ).resolves.toMatchObject({
      file: {
        location: { startLine: 1, endLine: 1 },
        size: 0,
        text: "",
      },
    });
  });

  it("enforces raw and retained source byte boundaries independently", async () => {
    const { model } = await fixture();
    const oneLineModel = {
      ...model,
      buildings: model.buildings.map((building) => ({
        ...building,
        sourceLocation: { startLine: 1, endLine: 1 },
      })),
    };
    const atLimit = "x".repeat(SOURCE_ARTIFACT_MAX_FILE_BYTES);
    expect(
      createSourceArtifact(oneLineModel, [
        {
          repositoryId: model.repositories[0]!.id,
          snapshot: snapshot(atLimit),
        },
      ]).files[0]?.text.length,
    ).toBe(SOURCE_ARTIFACT_MAX_FILE_BYTES);
    expect(() =>
      createSourceArtifact(oneLineModel, [
        {
          repositoryId: model.repositories[0]!.id,
          snapshot: snapshot(`${atLimit}x`),
        },
      ]),
    ).toThrow(/outside its limits/u);
    expect(() =>
      createSourceArtifact(oneLineModel, [
        {
          repositoryId: model.repositories[0]!.id,
          snapshot: snapshot("x", SOURCE_ARTIFACT_MAX_FILE_BYTES + 1),
        },
      ]),
    ).toThrow(/outside its limits/u);
    expect(() =>
      createSourceArtifact(oneLineModel, [
        {
          repositoryId: model.repositories[0]!.id,
          snapshot: snapshot("\u00e9", 1),
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

  it("reads only the selected file while reconciliation detects a corrupt large sibling", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "code-city-source-"));
    roots.push(root);
    await fs.chmod(root, 0o700);
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
});
