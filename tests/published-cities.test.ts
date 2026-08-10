import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ImportArtifactStore } from "../apps/server/src/import-artifacts.js";
import type { JobRecord } from "../apps/server/src/job-queue.js";
import { PublishedCityStore } from "../apps/server/src/published-cities.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "code-city-published-"));
  temporaryDirectories.push(directory);
  return directory;
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fixture(): Promise<{
  readonly job: JobRecord;
  readonly artifacts: ImportArtifactStore;
  readonly modelBytes: Buffer;
  readonly evolutionBytes: Buffer;
}> {
  const model = JSON.parse(
    await fs.readFile(path.resolve("examples/demo-city.json"), "utf8"),
  ) as Record<string, unknown>;
  model["sourceProvenance"] = {
    version: "codecity.source-navigation/1",
    repositories: [
      {
        repositoryId: "repository:demo",
        provider: "github",
        revision: { kind: "commit", value: "a".repeat(40) },
        repositoryUrl: "https://github.com/private/repository",
      },
    ],
  };
  const modelBytes = Buffer.from(JSON.stringify(model), "utf8");
  const evolutionBytes = Buffer.from(
    JSON.stringify({ baseline: { model }, deltas: [] }),
    "utf8",
  );
  const id = randomUUID();
  const now = new Date().toISOString();
  const job: JobRecord = Object.freeze({
    id,
    kind: "analysis",
    state: "completed",
    createdAt: now,
    updatedAt: now,
    result: Object.freeze({
      kind: "city-model",
      artifactToken: id,
      artifactUrl: `/api/v1/artifacts/${id}/city-model.json`,
      evolution: Object.freeze({
        artifactUrl: `/api/v1/artifacts/${id}/evolution.json`,
        size: evolutionBytes.byteLength,
        sha256: digest(evolutionBytes),
      }),
    }),
  });
  const artifacts = {
    readCityModel: async () => ({
      token: id,
      size: modelBytes.byteLength,
      bytes: modelBytes,
    }),
    readEvolution: async () => ({
      token: id,
      size: evolutionBytes.byteLength,
      sha256: digest(evolutionBytes),
      chunks: async function* () {
        yield evolutionBytes;
      },
      close: async () => undefined,
    }),
  } as unknown as ImportArtifactStore;
  return { job, artifacts, modelBytes, evolutionBytes };
}

describe("published city store", () => {
  it("publishes immutable model and evolution versions across restart", async () => {
    const dataDirectory = await temporaryDirectory();
    const { job, artifacts, modelBytes, evolutionBytes } = await fixture();
    const store = await PublishedCityStore.open({ dataDirectory });

    const first = await store.publish(job, artifacts, {
      title: "Shared demo",
      description: "An immutable demonstration snapshot.",
    });
    expect(first.title).toBe("Shared demo");
    expect(first.versions).toHaveLength(1);
    expect(first.versions[0]).toMatchObject({
      buildingCount: 5,
      districtCount: 2,
      evolution: { frameCount: 1, deltaCount: 0 },
    });
    const firstModel = await store.readModel(first.id);
    const publishedModel = JSON.parse(firstModel!.toString("utf8"));
    expect(publishedModel).not.toHaveProperty("sourceProvenance");
    expect(firstModel!.toString("utf8")).not.toContain("github.com/private");
    const firstEvolution = await store.readEvolution(first.id);
    expect(firstEvolution!.toString("utf8")).not.toContain("github.com/private");
    expect(
      JSON.parse(firstEvolution!.toString("utf8")).baseline.model,
    ).not.toHaveProperty("sourceProvenance");

    const second = await store.publish(job, artifacts, {
      publicationId: first.id,
      title: "Shared demo",
    });
    expect(second.id).toBe(first.id);
    expect(second.latestVersionId).not.toBe(first.latestVersionId);
    expect(second.versions).toHaveLength(2);
    const immutableModel = await store.readModel(
      first.id,
      first.latestVersionId,
    );
    expect(immutableModel).toEqual(firstModel);

    const publishedRoot = path.join(dataDirectory, "published");
    const abandonedStage = path.join(
      publishedRoot,
      second.id,
      `.stage-${randomUUID()}`,
    );
    const abandonedPublication = path.join(publishedRoot, randomUUID());
    await fs.mkdir(abandonedStage);
    await fs.mkdir(abandonedPublication);

    const reopened = await PublishedCityStore.open({ dataDirectory });
    expect(reopened.list()).toEqual([second]);
    await expect(fs.stat(abandonedStage)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(abandonedPublication)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(reopened.readEvolution(second.id)).resolves.toEqual(
      firstEvolution,
    );
    await expect(reopened.remove(second.id)).resolves.toBe(true);
    expect(reopened.list()).toEqual([]);
    await expect(reopened.readModel(second.id)).resolves.toBeUndefined();
  });

  it("rejects invalid persisted metadata and never stores source submission data", async () => {
    const dataDirectory = await temporaryDirectory();
    const { job, artifacts } = await fixture();
    const store = await PublishedCityStore.open({ dataDirectory });
    await store.publish(job, artifacts, { title: "Safe publication" });
    const indexPath = path.join(dataDirectory, "published", "index.json");
    const index = await fs.readFile(indexPath, "utf8");
    expect(index).not.toContain("repositoryUrl");
    expect(index).not.toContain("credential");
    expect(index).not.toContain("source");

    const parsed = JSON.parse(index) as Record<string, unknown>;
    await fs.writeFile(
      indexPath,
      `${JSON.stringify({ ...parsed, repositoryUrl: "https://private.invalid" })}\n`,
      "utf8",
    );
    await expect(
      PublishedCityStore.open({ dataDirectory }),
    ).rejects.toThrow("Published city index is invalid.");
  });
});
