import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { analyzeRepositorySnapshots } from "../packages/analyzer/src/index.js";
import type { RepositorySnapshot } from "../packages/analyzer/src/snapshot.js";
import type { SourceRepositoryProvenance } from "../packages/core/src/model.js";
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

async function fixture(
  options: {
    readonly editorUrlTemplate?: string;
    readonly artifactResponseTimeouts?: {
      readonly idleMs: number;
      readonly totalMs: number;
    };
  } = {},
) {
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
    ...(options.editorUrlTemplate === undefined
      ? {}
      : { editorUrlTemplate: options.editorUrlTemplate }),
    ...(options.artifactResponseTimeouts === undefined
      ? {}
      : {
          artifactResponseTimeouts:
            options.artifactResponseTimeouts,
        }),
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

async function publish(
  server: CodeCityServerHandle,
  name: string,
  retained = snapshot(name),
  provenance?: (
    repositoryId: string,
  ) => SourceRepositoryProvenance,
) {
  const analyzed = await analyzeRepositorySnapshots([retained]);
  const repository = analyzed.repositories[0]!;
  const model = attachSourceProvenance(analyzed, [
    provenance?.(repository.id) ??
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
          indexSha256: source.indexSha256,
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

function stallResponse(
  url: URL,
): Promise<{
  readonly closed: Promise<void>;
  destroy(): void;
}> {
  return new Promise((resolve, reject) => {
    const outgoing = http.request(
      url,
      { method: "GET", agent: false },
      (incoming) => {
        let announceClosed!: () => void;
        const closed = new Promise<void>((closeResolve) => {
          announceClosed = closeResolve;
        });
        incoming.once("aborted", announceClosed);
        incoming.once("close", announceClosed);
        incoming.pause();
        resolve({
          closed,
          destroy: () => {
            incoming.destroy();
            outgoing.destroy();
          },
        });
      },
    );
    outgoing.setTimeout(5_000, () =>
      outgoing.destroy(new Error("Stalled source request timed out.")),
    );
    outgoing.once("error", reject);
    outgoing.end();
  });
}

async function waitForSourceGate(
  url: URL,
): Promise<{ readonly status: number; readonly body: string }> {
  const deadline = Date.now() + 5_000;
  let response;
  do {
    response = await request(url, { method: "HEAD" });
    if (response.status !== 503) return response;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  } while (Date.now() < deadline);
  return response;
}

async function expectStalledSourceResponse(
  url: URL,
  expectedStatus: number,
): Promise<void> {
  const originalEnd = http.ServerResponse.prototype.end;
  let intercepted = false;
  const endSpy = vi
    .spyOn(http.ServerResponse.prototype, "end")
    .mockImplementation(function (
      this: http.ServerResponse,
      ...arguments_: unknown[]
    ) {
      if (
        !intercepted &&
        this.statusCode === expectedStatus &&
        this.getHeader("Content-Type") ===
          "application/json; charset=utf-8"
      ) {
        intercepted = true;
        this.flushHeaders();
        return this;
      }
      return Reflect.apply(
        originalEnd,
        this,
        arguments_,
      ) as http.ServerResponse;
    });
  let stalled:
    | Awaited<ReturnType<typeof stallResponse>>
    | undefined;
  try {
    stalled = await stallResponse(url);
    await Promise.race([
      stalled.closed,
      new Promise<never>((_resolve, reject) =>
        setTimeout(
          () => reject(new Error("Source idle timeout did not fire.")),
          5_000,
        ),
      ),
    ]);
  } finally {
    endSpy.mockRestore();
    stalled?.destroy();
  }
  expect(intercepted).toBe(true);
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
    const cityModelRead = vi.spyOn(
      server.artifacts,
      "readCityModel",
    );

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
    expect(cityModelRead).not.toHaveBeenCalled();

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

  it("times out a stalled source response and releases the artifact gate", async () => {
    const server = await fixture({
      artifactResponseTimeouts: {
        idleMs: 100,
        totalMs: 3_000,
      },
    });
    const imported = await publish(server, "stalled");
    const sourceUrl = new URL(
      `/api/v1/artifacts/${imported.job.id}/sources/${imported.building.id}`,
      server.url,
    );
    await expectStalledSourceResponse(sourceUrl, 200);
    const released = await waitForSourceGate(sourceUrl);
    expect(released.status).toBe(200);
    expect(released.body).toBe("");

    for (const failure of ["missing", "failed"] as const) {
      const read = vi.spyOn(server.sources, "readFile");
      if (failure === "missing") {
        read.mockResolvedValueOnce(undefined);
      } else {
        read.mockRejectedValueOnce(
          new Error("Injected source read failure."),
        );
      }
      try {
        await expectStalledSourceResponse(
          sourceUrl,
          failure === "missing" ? 404 : 500,
        );
      } finally {
        read.mockRestore();
      }
      expect((await waitForSourceGate(sourceUrl)).status).toBe(200);
    }

    const removed = await request(
      new URL(`/api/v1/imports/${imported.job.id}/result`, server.url),
      {
        method: "DELETE",
        headers: { "X-Code-City-Request": "1" },
      },
    );
    expect(removed.status).toBe(200);
  });

  it.each([
    "{path}://editor.example/open",
    "https{line}://editor.example/open/{path}",
    "https://{path}/open",
    "https://safe.example@{path}/open",
    "https://safe.example:{line}/open/{path}",
    "vscode://{path}/open",
  ])(
    "rejects an editor template whose placeholder can change its scheme or authority: %s",
    async (editorUrlTemplate) => {
      await expect(
        fixture({ editorUrlTemplate }),
      ).rejects.toThrow(/editor URL template/iu);
    },
  );

  it("rejects an oversized editor template at startup", async () => {
    await expect(
      fixture({
        editorUrlTemplate: `https://editor.example/${"a".repeat(4_096)}/{path}`,
      }),
    ).rejects.toThrow(/editor URL template/iu);
  });

  it("serves safe editor links but omits an expansion beyond the response limit", async () => {
    const editorUrlTemplate =
      "https://editor.example/open/{path}?line={line}#L{line}";
    const server = await fixture({ editorUrlTemplate });
    const normal = await publish(server, "editor");
    const normalResponse = await request(
      new URL(
        `/api/v1/artifacts/${normal.job.id}/sources/${normal.building.id}`,
        server.url,
      ),
    );
    expect(normalResponse.status).toBe(200);
    expect(JSON.parse(normalResponse.body).source.editorUrl).toBe(
      "https://editor.example/open/src/editor.ts?line=1#L1",
    );

    const longPath = `src/${"ü".repeat(700)}.ts`;
    const longText = "export const longPath = true;\n";
    const imported = await publish(
      server,
      "longEditor",
      {
        name: "longEditor",
        files: [
          {
            path: longPath,
            text: longText,
            byteLength: Buffer.byteLength(longText),
          },
        ],
        diagnostics: [],
      },
      (repositoryId) => ({
        repositoryId,
        provider: "github",
        revision: {
          kind: "commit",
          value: "a".repeat(40),
        },
        repositoryUrl: "https://github.com/example/long-source",
      }),
    );
    const longResponse = await request(
      new URL(
        `/api/v1/artifacts/${imported.job.id}/sources/${imported.building.id}`,
        server.url,
      ),
    );
    expect(longResponse.status).toBe(200);
    const longSource = JSON.parse(longResponse.body).source;
    expect(longSource).not.toHaveProperty("editorUrl");
    expect(longSource.externalUrl).toBe(
      `https://github.com/example/long-source/blob/${"a".repeat(40)}/${longPath
        .split("/")
        .map((segment) => encodeURIComponent(segment))
        .join("/")}#L1`,
    );
    expect(longSource.externalUrl.length).toBeGreaterThan(4_096);
  });

  it("accepts a fixed vscode authority and preserves an Azure DevOps source link", async () => {
    const server = await fixture({
      editorUrlTemplate: "vscode://file/{path}:{line}",
    });
    const revision = "b".repeat(40);
    const repositoryUrl =
      "https://dev.azure.com/example/Project/_git/Repository";
    const imported = await publish(
      server,
      "azureEditor",
      snapshot("azureEditor"),
      (repositoryId) => ({
        repositoryId,
        provider: "azure-devops",
        revision: { kind: "commit", value: revision },
        repositoryUrl,
      }),
    );
    const response = await request(
      new URL(
        `/api/v1/artifacts/${imported.job.id}/sources/${imported.building.id}`,
        server.url,
      ),
    );
    expect(response.status).toBe(200);
    const source = JSON.parse(response.body).source;
    expect(source.editorUrl).toBe(
      "vscode://file/src/azureEditor.ts:1",
    );
    const expectedExternal = new URL(repositoryUrl);
    expectedExternal.searchParams.set("path", "/src/azureEditor.ts");
    expectedExternal.searchParams.set("version", `GC${revision}`);
    expectedExternal.searchParams.set("line", "1");
    expectedExternal.searchParams.set("_a", "contents");
    expect(source.externalUrl).toBe(expectedExternal.toString());
  });
});
