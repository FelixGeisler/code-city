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
  serializeSourceArtifact,
  sourceArtifactFile,
  uploadedSnapshotProvenance,
} from "../apps/server/src/source-artifact.js";
import { SourceArtifactStore } from "../apps/server/src/source-artifact-store.js";

const roots: string[] = [];
const TOKEN = "123e4567-e89b-42d3-a456-426614174000";

function snapshot(text = "export function answer() {\n  return 42;\n}\n"): RepositorySnapshot {
  return {
    name: "example",
    files: [
      {
        path: "src/answer.ts",
        text,
        byteLength: Buffer.byteLength(text),
      },
    ],
    diagnostics: [],
  };
}

async function fixture() {
  const retained = snapshot();
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
});
