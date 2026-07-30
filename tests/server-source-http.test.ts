import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { analyzeRepositorySnapshots } from "../packages/analyzer/src/index.js";
import type { RepositorySnapshot } from "../packages/analyzer/src/snapshot.js";
import {
  attachSourceProvenance,
  createSourceArtifact,
  uploadedSnapshotProvenance,
} from "../apps/server/src/source-artifact.js";
import {
  startCodeCityServer,
  type CodeCityServerHandle,
} from "../apps/server/src/server.js";

const roots: string[] = [];
const servers: CodeCityServerHandle[] = [];

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "code-city-source-http-"));
  roots.push(root);
  const viewerRoot = path.join(root, "viewer");
  const dataDirectory = path.join(root, "data");
  await fs.mkdir(viewerRoot, { recursive: true });
  await fs.writeFile(
    path.join(viewerRoot, "index.html"),
    "<!doctype html><title>Code City</title>",
  );
  const server = await startCodeCityServer({
    host: "127.0.0.1",
    port: 0,
    viewerRoot,
    dataDirectory,
    sourceRetention: "retain",
  });
  servers.push(server);
  return server;
}

function snapshot(name: string): RepositorySnapshot {
  const text = `export function ${name}() {\n  return "${name}";\n}\n`;
  return {
    name,
    files: [
      {
        path: `src/${name}.ts`,
        text,
        byteLength: Buffer.byteLength(text),
      },
    ],
    diagnostics: [],
  };
}

async function publish(server: CodeCityServerHandle, name: string) {
  const retained = snapshot(name);
  const analyzed = await analyzeRepositorySnapshots([retained]);
  const repository = analyzed.repositories[0]!;
  const model = attachSourceProvenance(analyzed, [
    uploadedSnapshotProvenance(repository.id, retained),
  ]);
  const queued = await server.jobs.enqueue(
    "project-import",
    async ({ id }) => {
      const source = await server.sources.publish(
        id,
        createSourceArtifact(model, [
          { repositoryId: repository.id, snapshot: retained },
        ]),
      );
      await server.artifacts.publishCityModel(id, model);
      return {
        kind: "city-model",
        artifactToken: id,
        artifactUrl: `/api/v1/artifacts/${id}/city-model.json`,
        source: {
          availability: "retained",
          artifactUrl: `/api/v1/artifacts/${id}/source`,
          size: source.size,
          sha256: source.sha256,
        },
      };
    },
    {
      rollback: async ({ id }) => {
        await Promise.all([
          server.sources.cleanup(id),
          server.artifacts.cleanupCityModelArtifact(id),
        ]);
      },
    },
  );
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const job = server.jobs.get(queued.id)!;
    if (job.state === "completed") {
      return { job, model, building: model.buildings[0]! };
    }
    if (job.state === "failed" || job.state === "cancelled") {
      throw new Error(`Source fixture job ${job.state}.`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Source fixture job timed out.");
}

function request(
  url: URL,
  options: {
    readonly method?: string;
    readonly headers?: http.OutgoingHttpHeaders;
  } = {},
): Promise<{ readonly status: number; readonly body: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = http.request(
      url,
      {
        method: options.method ?? "GET",
        headers: options.headers,
        agent: false,
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.on("end", () =>
          resolve({
            status: incoming.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
}

afterEach(async () => {
  await Promise.allSettled(servers.splice(0).map((server) => server.close()));
  await Promise.all(
    roots.splice(0).map((root) =>
      fs.rm(root, { recursive: true, force: true }),
    ),
  );
});

describe("source navigation HTTP API", () => {
  it("serves only the selected job's exact building and removes source with the job", async () => {
    const server = await fixture();
    const first = await publish(server, "alpha");
    const second = await publish(server, "beta");

    const selected = await request(
      new URL(
        `/api/v1/artifacts/${first.job.id}/sources/${first.building.id}`,
        server.url,
      ),
    );
    expect(selected.status).toBe(200);
    expect(JSON.parse(selected.body)).toMatchObject({
      source: {
        buildingId: first.building.id,
        path: first.building.path,
        text: expect.stringContaining("alpha"),
      },
    });

    const crossed = await request(
      new URL(
        `/api/v1/artifacts/${second.job.id}/sources/${first.building.id}`,
        server.url,
      ),
    );
    expect(crossed.status).toBe(404);

    const removed = await request(
      new URL(`/api/v1/imports/${first.job.id}/result`, server.url),
      {
        method: "DELETE",
        headers: { "X-Code-City-Request": "1" },
      },
    );
    expect(removed.status).toBe(200);
    expect(await server.sources.read(first.job.id)).toBeUndefined();
  });
});
