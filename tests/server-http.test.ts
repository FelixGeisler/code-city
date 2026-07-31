import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import type { JobRecord } from "../apps/server/src/job-queue.js";
import {
  startCodeCityServer,
  type CodeCityServerHandle,
} from "../apps/server/src/server.js";
import type { EvolutionBundle } from "../packages/core/src/index.js";

interface ResponseSnapshot {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}

const temporaryDirectories: string[] = [];
const servers: CodeCityServerHandle[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function fixture(): Promise<{
  readonly dataDirectory: string;
  readonly viewerRoot: string;
}> {
  const root = await temporaryDirectory("code-city-server-");
  const viewerRoot = path.join(root, "viewer");
  const dataDirectory = path.join(root, "data");
  await fs.mkdir(path.join(viewerRoot, "assets"), { recursive: true });
  await fs.writeFile(
    path.join(viewerRoot, "index.html"),
    '<!doctype html><title>Code City hosted</title>',
    "utf8",
  );
  await fs.writeFile(
    path.join(viewerRoot, "assets", "app.12345678.js"),
    "globalThis.codeCity = true;\n",
    "utf8",
  );
  return { dataDirectory, viewerRoot };
}

function cityModelFixture(): {
  readonly schemaVersion: "1.0";
  readonly generator: {
    readonly name: "code-city";
    readonly version: string;
  };
  readonly repositories: readonly [];
  readonly solutions: readonly [];
  readonly modules: readonly [];
  readonly semanticGroups: readonly [];
  readonly districts: readonly [];
  readonly buildings: readonly [];
  readonly dependencies: readonly [];
  readonly bounds: { readonly x: 0; readonly y: 0; readonly z: 0 };
} {
  return {
    schemaVersion: "1.0",
    generator: { name: "code-city", version: "test" },
    repositories: [],
    solutions: [],
    modules: [],
    semanticGroups: [],
    districts: [],
    buildings: [],
    dependencies: [],
    bounds: { x: 0, y: 0, z: 0 },
  };
}

function historyCityModelFixture() {
  return {
    ...cityModelFixture(),
    repositories: [{ id: "repository:one", name: "One" }],
  } as const;
}

function evolutionBundleFixture(): EvolutionBundle {
  const sha = "1".repeat(40);
  const fingerprint = (
    digit: string,
  ): `sha256:${string}` => `sha256:${digit.repeat(64)}`;
  const model = historyCityModelFixture();
  return {
    schemaVersion: "1.0",
    generator: model.generator,
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
      model,
    },
    deltas: [],
  };
}

function largeEvolutionBundleFixture(): EvolutionBundle {
  const bundle = evolutionBundleFixture();
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

async function waitForJob(
  server: CodeCityServerHandle,
  id: string,
  predicate: (record: JobRecord) => boolean,
): Promise<JobRecord> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const record = server.jobs.get(id);
    if (record && predicate(record)) return record;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for job ${id}.`);
}

async function publishCompletedCityModel(
  server: CodeCityServerHandle,
  model = cityModelFixture(),
  kind = "analysis",
): Promise<JobRecord> {
  const queued = await server.jobs.enqueue(
    kind,
    async ({ id }) => {
      await server.artifacts.publishCityModel(id, model);
      return {
        kind: "city-model",
        artifactToken: id,
        artifactUrl: `/api/v1/artifacts/${id}/city-model.json`,
      };
    },
    {
      rollback: async ({ id }) => {
        await server.artifacts.cleanupCityModelArtifact(id);
      },
    },
  );
  const terminal = await waitForJob(
    server,
    queued.id,
    ({ state }) =>
      state === "completed" ||
      state === "failed" ||
      state === "cancelled",
  );
  expect(terminal.state).toBe("completed");
  expect(terminal.result).toEqual({
    kind: "city-model",
    artifactToken: queued.id,
    artifactUrl: `/api/v1/artifacts/${queued.id}/city-model.json`,
  });
  return terminal;
}

async function publishCompletedHistory(
  server: CodeCityServerHandle,
  evolution = evolutionBundleFixture(),
  kind = "history-analysis",
): Promise<JobRecord> {
  const model = evolution.baseline.model;
  const queued = await server.jobs.enqueue(
    kind,
    async ({ id }) => {
      const published = await server.artifacts.publishHistoryArtifacts(
        id,
        model,
        evolution,
      );
      return {
        kind: "city-model",
        artifactToken: id,
        artifactUrl: `/api/v1/artifacts/${id}/city-model.json`,
        evolution: {
          artifactUrl: `/api/v1/artifacts/${id}/evolution.json`,
          size: published.evolution.size,
          sha256: published.evolution.sha256,
        },
      };
    },
    {
      rollback: async ({ id }) => {
        await server.artifacts.cleanupCityModelArtifact(id);
      },
    },
  );
  const terminal = await waitForJob(
    server,
    queued.id,
    ({ state }) =>
      state === "completed" ||
      state === "failed" ||
      state === "cancelled",
  );
  expect(terminal.state).toBe("completed");
  return terminal;
}

function request(
  url: URL,
  options: {
    readonly method?: string;
    readonly host?: string;
    readonly headers?: http.OutgoingHttpHeaders;
    readonly signal?: AbortSignal;
    readonly body?: string;
  } = {},
): Promise<ResponseSnapshot> {
  const hostname =
    url.hostname.startsWith("[") && url.hostname.endsWith("]")
      ? url.hostname.slice(1, -1)
      : url.hostname;

  return new Promise((resolve, reject) => {
    const outgoing = http.request(
      {
        hostname,
        port: Number(url.port),
        path: `${url.pathname}${url.search}`,
        method: options.method ?? "GET",
        headers: {
          ...options.headers,
          ...(options.host === undefined ? {} : { Host: options.host }),
        },
        agent: false,
        signal: options.signal,
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.on("end", () => {
          resolve({
            status: incoming.statusCode ?? 0,
            headers: incoming.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    outgoing.setTimeout(2_000, () =>
      outgoing.destroy(new Error("Hosted server request timed out.")),
    );
    outgoing.on("error", reject);
    outgoing.end(options.body);
  });
}

type RequestOptions = NonNullable<Parameters<typeof request>[1]>;

async function waitForArtifactResponseGate(
  url: URL,
  options: RequestOptions = {},
): Promise<ResponseSnapshot> {
  const deadline = Date.now() + 1_000;
  let response: ResponseSnapshot;
  do {
    response = await request(url, options);
    if (response.status !== 503) return response;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  } while (Date.now() < deadline);
  return response;
}

function rejectWhenAborted(
  signal: AbortSignal | undefined,
): Promise<never> {
  if (signal === undefined) {
    return Promise.reject(new Error("Expected an abort signal."));
  }
  return new Promise<never>((_resolve, reject) => {
    const abort = (): void =>
      reject(signal.reason ?? new Error("aborted"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

afterEach(async () => {
  await Promise.allSettled(servers.splice(0).map((server) => server.close()));
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

it("serves the viewer and a versioned health API with secure defaults", async () => {
  const roots = await fixture();
  const server = await startCodeCityServer({
    host: "127.0.0.1",
    port: 0,
    ...roots,
  });
  servers.push(server);

  const viewer = await request(server.url);
  expect(viewer.status).toBe(200);
  expect(viewer.body).toContain("Code City hosted");
  expect(viewer.headers["content-security-policy"]).toContain(
    "default-src 'none'",
  );
  expect(viewer.headers["x-frame-options"]).toBe("DENY");
  expect(viewer.headers["access-control-allow-origin"]).toBeUndefined();

  const health = await request(new URL("/api/v1/health", server.url));
  expect(health.status).toBe(200);
  expect(health.headers["cache-control"]).toBe("no-store");
  expect(JSON.parse(health.body)).toEqual({
    status: "ok",
    service: "code-city",
    apiVersion: "v1",
  });

  const asset = await request(
    new URL("/assets/app.12345678.js", server.url),
  );
  expect(asset.status).toBe(200);
  expect(asset.headers["cache-control"]).toBe(
    "public, max-age=31536000, immutable",
  );
});

it("exposes persisted job state and supports cancellation", async () => {
  const server = await startCodeCityServer({
    host: "127.0.0.1",
    port: 0,
    ...(await fixture()),
  });
  servers.push(server);
  const queued = await server.jobs.enqueue(
    "analysis",
    ({ signal }) =>
      new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      }),
  );

  const listed = await request(new URL("/api/v1/jobs", server.url));
  expect(listed.status).toBe(200);
  expect(
    (
      JSON.parse(listed.body) as {
        jobs: { id: string }[];
      }
    ).jobs.map(({ id }) => id),
  ).toContain(queued.id);

  const cancelled = await request(
    new URL(`/api/v1/jobs/${queued.id}`, server.url),
    {
      method: "DELETE",
      headers: { "X-Code-City-Request": "1" },
    },
  );
  expect(cancelled.status).toBe(200);
  expect(
    (
      JSON.parse(cancelled.body) as {
        job: { state: string };
      }
    ).job.state,
  ).toBe("cancelled");
});

it("deletes completed snapshot and history jobs with their owned artifacts", async () => {
  const roots = await fixture();
  const server = await startCodeCityServer({
    host: "127.0.0.1",
    port: 0,
    ...roots,
  });
  servers.push(server);
  const snapshot = await publishCompletedCityModel(
    server,
    cityModelFixture(),
    "project-import",
  );
  const history = await publishCompletedHistory(
    server,
    evolutionBundleFixture(),
    "project-import",
  );

  const resultUrl = new URL(
    `/api/v1/imports/${snapshot.id}/result`,
    server.url,
  );
  const missingHeader = await request(resultUrl, { method: "DELETE" });
  expect(missingHeader.status).toBe(403);
  expect(missingHeader.headers["cache-control"]).toBe("no-store");
  expect(server.jobs.get(snapshot.id)).toEqual(snapshot);
  const unexpectedBody = await request(resultUrl, {
    method: "DELETE",
    headers: {
      "Content-Length": "2",
      "Content-Type": "application/json",
      "X-Code-City-Request": "1",
    },
    body: "{}",
  });
  expect(unexpectedBody.status).toBe(400);
  expect(unexpectedBody.headers["cache-control"]).toBe("no-store");
  expect(JSON.parse(unexpectedBody.body)).toMatchObject({
    error: { code: "unexpected-request-body" },
  });
  expect(server.jobs.get(snapshot.id)).toEqual(snapshot);

  const legacyCancellation = await request(
    new URL(`/api/v1/jobs/${snapshot.id}`, server.url),
    {
      method: "DELETE",
      headers: { "X-Code-City-Request": "1" },
    },
  );
  expect(legacyCancellation.status).toBe(200);
  expect(JSON.parse(legacyCancellation.body)).toEqual({
    job: snapshot,
  });
  expect(server.jobs.get(snapshot.id)).toEqual(snapshot);
  expect(
    await server.artifacts.statCityModel(snapshot.id),
  ).toBeDefined();

  for (const completed of [snapshot, history]) {
    const deleted = await request(
      new URL(`/api/v1/imports/${completed.id}/result`, server.url),
      {
        method: "DELETE",
        headers: { "X-Code-City-Request": "1" },
      },
    );
    expect(deleted.status).toBe(200);
    expect(deleted.headers["cache-control"]).toBe("no-store");
    expect(JSON.parse(deleted.body)).toEqual({
      deleted: true,
      job: completed,
    });
    expect(server.jobs.get(completed.id)).toBeUndefined();
    expect(
      await server.artifacts.statCityModel(completed.id),
    ).toBeUndefined();
    expect(
      await server.artifacts.statEvolution(completed.id),
    ).toBeUndefined();

    const missingJob = await request(
      new URL(`/api/v1/jobs/${completed.id}`, server.url),
    );
    expect(missingJob.status).toBe(404);
    const missingArtifact = await request(
      new URL(
        `/api/v1/artifacts/${completed.id}/city-model.json`,
        server.url,
      ),
    );
    expect(missingArtifact.status).toBe(404);
  }

  const unknown = await request(
    new URL(
      "/api/v1/imports/00000000-0000-4000-8000-000000000000/result",
      server.url,
    ),
    {
      method: "DELETE",
      headers: { "X-Code-City-Request": "1" },
    },
  );
  expect(unknown.status).toBe(404);
  expect(JSON.parse(unknown.body)).toMatchObject({
    error: { code: "job-not-found" },
  });

  const nonProject = await publishCompletedCityModel(server);
  const rejectedCompleted = await request(
    new URL(`/api/v1/imports/${nonProject.id}/result`, server.url),
    {
      method: "DELETE",
      headers: { "X-Code-City-Request": "1" },
    },
  );
  expect(rejectedCompleted.status).toBe(409);
  expect(server.jobs.get(nonProject.id)).toEqual(nonProject);
  expect(
    await server.artifacts.statCityModel(nonProject.id),
  ).toBeDefined();

  const live = await server.jobs.enqueue(
    "project-import",
    ({ signal }) =>
      new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), {
          once: true,
        });
      }),
  );
  await waitForJob(server, live.id, ({ state }) => state === "running");
  const rejectedLive = await request(
    new URL(`/api/v1/imports/${live.id}/result`, server.url),
    {
      method: "DELETE",
      headers: { "X-Code-City-Request": "1" },
    },
  );
  expect(rejectedLive.status).toBe(409);
  expect(server.jobs.get(live.id)?.state).toBe("running");
  await server.jobs.cancel(live.id);

  const orphanToken = randomUUID();
  await server.artifacts.publishCityModel(
    orphanToken,
    cityModelFixture(),
  );
  const orphanDeletion = await request(
    new URL(`/api/v1/imports/${orphanToken}/result`, server.url),
    {
      method: "DELETE",
      headers: { "X-Code-City-Request": "1" },
    },
  );
  expect(orphanDeletion.status).toBe(404);
  expect(
    await server.artifacts.statCityModel(orphanToken),
  ).toBeDefined();
  await server.artifacts.cleanupCityModelArtifact(orphanToken);

  await server.close();
  const restarted = await startCodeCityServer({
    host: "127.0.0.1",
    port: 0,
    ...roots,
  });
  servers.push(restarted);
  expect(restarted.jobs.get(snapshot.id)).toBeUndefined();
  expect(restarted.jobs.get(history.id)).toBeUndefined();
}, 15_000);

it("revokes ownership before waiting for an active artifact response", async () => {
  const server = await startCodeCityServer({
    host: "127.0.0.1",
    port: 0,
    ...(await fixture()),
  });
  servers.push(server);
  const completed = await publishCompletedHistory(
    server,
    largeEvolutionBundleFixture(),
    "project-import",
  );
  const expected = completed.result!.evolution!;
  const held = await server.artifacts.readEvolution(
    completed.id,
    expected,
  );
  expect(held).toBeDefined();
  let signalReadStarted: (() => void) | undefined;
  let releaseRead: (() => void) | undefined;
  const readStarted = new Promise<void>((resolve) => {
    signalReadStarted = resolve;
  });
  const readReleased = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  vi.spyOn(server.artifacts, "readEvolution").mockResolvedValueOnce(
    Object.freeze({
      ...held!,
      chunks: async function* (
        signal?: AbortSignal,
      ): AsyncGenerator<Buffer, void, undefined> {
        const iterator = held!.chunks(signal);
        const first = await iterator.next();
        signalReadStarted?.();
        await readReleased;
        if (!first.done) yield first.value;
        for (;;) {
          const next = await iterator.next();
          if (next.done) return;
          yield next.value;
        }
      },
    }),
  );
  const cleanup = vi.spyOn(
    server.artifacts,
    "cleanupCityModelArtifact",
  );

  const artifactUrl = new URL(
    completed.result!.evolution!.artifactUrl,
    server.url,
  );
  const activeRead = request(artifactUrl);
  await readStarted;
  let deletionSettled = false;
  const deletion = request(
    new URL(`/api/v1/imports/${completed.id}/result`, server.url),
    {
      method: "DELETE",
      headers: { "X-Code-City-Request": "1" },
    },
  ).finally(() => {
    deletionSettled = true;
  });
  const deadline = Date.now() + 1_000;
  while (server.jobs.get(completed.id) !== undefined) {
    if (Date.now() >= deadline) {
      throw new Error("Completed job ownership was not revoked.");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }

  const rejectedRead = await request(artifactUrl);
  expect(rejectedRead.status).toBe(404);
  expect(deletionSettled).toBe(false);
  expect(cleanup).not.toHaveBeenCalled();
  releaseRead?.();
  expect((await activeRead).status).toBe(200);
  expect((await deletion).status).toBe(200);
  expect(cleanup).toHaveBeenCalledWith(completed.id);
  expect(
    await server.artifacts.statEvolution(completed.id),
  ).toBeUndefined();
});

it("drains an active city-model HEAD lease before artifact cleanup", async () => {
  const server = await startCodeCityServer({
    host: "127.0.0.1",
    port: 0,
    ...(await fixture()),
  });
  servers.push(server);
  const completed = await publishCompletedCityModel(
    server,
    cityModelFixture(),
    "project-import",
  );
  const originalStat = server.artifacts.statCityModel.bind(
    server.artifacts,
  );
  let signalStatStarted: (() => void) | undefined;
  let releaseStat: (() => void) | undefined;
  const statStarted = new Promise<void>((resolve) => {
    signalStatStarted = resolve;
  });
  const statReleased = new Promise<void>((resolve) => {
    releaseStat = resolve;
  });
  vi.spyOn(server.artifacts, "statCityModel").mockImplementationOnce(
    async (token, signal) => {
      signalStatStarted?.();
      await statReleased;
      return originalStat(token, signal);
    },
  );
  const cleanup = vi.spyOn(
    server.artifacts,
    "cleanupCityModelArtifact",
  );
  const artifactUrl = new URL(
    completed.result!.artifactUrl,
    server.url,
  );
  const activeHead = request(artifactUrl, { method: "HEAD" });
  await statStarted;
  const deletion = request(
    new URL(`/api/v1/imports/${completed.id}/result`, server.url),
    {
      method: "DELETE",
      headers: { "X-Code-City-Request": "1" },
    },
  );
  const deadline = Date.now() + 1_000;
  while (server.jobs.get(completed.id) !== undefined) {
    if (Date.now() >= deadline) {
      throw new Error("Completed job ownership was not revoked.");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  expect(cleanup).not.toHaveBeenCalled();

  releaseStat?.();
  expect((await activeHead).status).toBe(200);
  expect((await deletion).status).toBe(200);
  expect(cleanup).toHaveBeenCalledWith(completed.id);
});

it("reports post-revocation cleanup failure and resumes it on retry", async () => {
  const roots = await fixture();
  const server = await startCodeCityServer({
    host: "127.0.0.1",
    port: 0,
    ...roots,
  });
  servers.push(server);
  const completed = await publishCompletedHistory(
    server,
    evolutionBundleFixture(),
    "project-import",
  );
  vi.spyOn(
    server.artifacts,
    "cleanupCityModelArtifact",
  ).mockRejectedValueOnce(new Error("Simulated cleanup failure."));

  const deleted = await request(
    new URL(`/api/v1/imports/${completed.id}/result`, server.url),
    {
      method: "DELETE",
      headers: { "X-Code-City-Request": "1" },
    },
  );
  expect(deleted.status).toBe(500);
  expect(JSON.parse(deleted.body)).toMatchObject({
    error: { code: "job-delete-incomplete" },
  });
  expect(server.jobs.get(completed.id)).toBeUndefined();
  expect(
    await server.artifacts.statCityModel(completed.id),
  ).toBeDefined();
  expect(await server.artifacts.statEvolution(completed.id)).toBeDefined();
  expect(
    (
      await request(
        new URL(
          `/api/v1/artifacts/${completed.id}/city-model.json`,
          server.url,
        ),
      )
    ).status,
  ).toBe(404);

  const retried = await request(
    new URL(`/api/v1/imports/${completed.id}/result`, server.url),
    {
      method: "DELETE",
      headers: { "X-Code-City-Request": "1" },
    },
  );
  expect(retried.status).toBe(200);
  expect(JSON.parse(retried.body)).toEqual({
    deleted: true,
    job: completed,
  });
  expect(
    await server.artifacts.statCityModel(completed.id),
  ).toBeUndefined();
  expect(
    await server.artifacts.statEvolution(completed.id),
  ).toBeUndefined();

  await server.close();
  const restarted = await startCodeCityServer({
    host: "127.0.0.1",
    port: 0,
    ...roots,
  });
  servers.push(restarted);
  expect(restarted.jobs.get(completed.id)).toBeUndefined();
  expect(
    await restarted.artifacts.statCityModel(completed.id),
  ).toBeUndefined();
  expect(
    await restarted.artifacts.statEvolution(completed.id),
  ).toBeUndefined();
});

it("coalesces concurrent completed-result removals idempotently", async () => {
  const server = await startCodeCityServer({
    host: "127.0.0.1",
    port: 0,
    ...(await fixture()),
  });
  servers.push(server);
  const completed = await publishCompletedCityModel(
    server,
    cityModelFixture(),
    "project-import",
  );
  const originalCleanup =
    server.artifacts.cleanupCityModelArtifact.bind(server.artifacts);
  let signalCleanupStarted: (() => void) | undefined;
  let releaseCleanup: (() => void) | undefined;
  const cleanupStarted = new Promise<void>((resolve) => {
    signalCleanupStarted = resolve;
  });
  const cleanupReleased = new Promise<void>((resolve) => {
    releaseCleanup = resolve;
  });
  vi.spyOn(
    server.artifacts,
    "cleanupCityModelArtifact",
  ).mockImplementationOnce(async (token) => {
    signalCleanupStarted?.();
    await cleanupReleased;
    await originalCleanup(token);
  });
  const url = new URL(
    `/api/v1/imports/${completed.id}/result`,
    server.url,
  );
  const options = {
    method: "DELETE",
    headers: { "X-Code-City-Request": "1" },
  } as const;
  const first = request(url, options);
  await cleanupStarted;
  const second = request(url, options);
  releaseCleanup?.();

  const responses = await Promise.all([first, second]);
  expect(responses.map(({ status }) => status)).toEqual([200, 200]);
  for (const response of responses) {
    expect(JSON.parse(response.body)).toEqual({
      deleted: true,
      job: completed,
    });
  }
});

it("waits for an accepted completed-result removal during server close", async () => {
  const server = await startCodeCityServer({
    host: "127.0.0.1",
    port: 0,
    ...(await fixture()),
  });
  servers.push(server);
  const completed = await publishCompletedCityModel(
    server,
    cityModelFixture(),
    "project-import",
  );
  const originalCleanup =
    server.artifacts.cleanupCityModelArtifact.bind(server.artifacts);
  let signalCleanupStarted: (() => void) | undefined;
  let releaseCleanup: (() => void) | undefined;
  const cleanupStarted = new Promise<void>((resolve) => {
    signalCleanupStarted = resolve;
  });
  const cleanupReleased = new Promise<void>((resolve) => {
    releaseCleanup = resolve;
  });
  vi.spyOn(
    server.artifacts,
    "cleanupCityModelArtifact",
  ).mockImplementationOnce(async (token) => {
    signalCleanupStarted?.();
    await cleanupReleased;
    await originalCleanup(token);
  });
  const deletion = request(
    new URL(`/api/v1/imports/${completed.id}/result`, server.url),
    {
      method: "DELETE",
      headers: { "X-Code-City-Request": "1" },
    },
  ).catch(() => undefined);
  await cleanupStarted;

  let closeSettled = false;
  const closing = server.close().finally(() => {
    closeSettled = true;
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(closeSettled).toBe(false);
  releaseCleanup?.();
  await closing;
  await deletion;
  expect(
    await server.artifacts.statCityModel(completed.id),
  ).toBeUndefined();
});

it("reconciles artifacts for a committed removal tombstone on restart", async () => {
  const roots = await fixture();
  const server = await startCodeCityServer({
    host: "127.0.0.1",
    port: 0,
    ...roots,
  });
  servers.push(server);
  const completed = await publishCompletedHistory(
    server,
    evolutionBundleFixture(),
    "project-import",
  );
  await expect(
    server.jobs.removeCompleted(completed.id),
  ).resolves.toEqual(completed);
  expect(server.jobs.get(completed.id)).toBeUndefined();
  const tombstone = path.join(
    roots.dataDirectory,
    "jobs",
    `${completed.id}.json.delete`,
  );
  await expect(fs.lstat(tombstone)).resolves.toBeDefined();
  await server.close();

  const restarted = await startCodeCityServer({
    host: "127.0.0.1",
    port: 0,
    ...roots,
  });
  servers.push(restarted);
  expect(restarted.jobs.get(completed.id)).toBeUndefined();
  expect(
    await restarted.artifacts.statCityModel(completed.id),
  ).toBeUndefined();
  expect(
    await restarted.artifacts.statEvolution(completed.id),
  ).toBeUndefined();
  await expect(fs.lstat(tombstone)).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("serves immutable city-model job artifacts from fixed UUID paths", async () => {
  const roots = await fixture();
  const server = await startCodeCityServer({
    host: "127.0.0.1",
    port: 0,
    ...roots,
  });
  servers.push(server);
  const model = cityModelFixture();
  const completed = await publishCompletedCityModel(server, model);
  const artifactUrl = new URL(
    completed.result!.artifactUrl,
    server.url,
  );

  const loaded = await request(artifactUrl);
  expect(loaded.status).toBe(200);
  expect(loaded.headers["content-type"]).toBe(
    "application/json; charset=utf-8",
  );
  expect(loaded.headers["cache-control"]).toBe("no-store");
  expect(JSON.parse(loaded.body)).toEqual(model);

  const head = await request(artifactUrl, { method: "HEAD" });
  expect(head.status).toBe(200);
  expect(head.body).toBe("");
  expect(head.headers["content-length"]).toBe(
    loaded.headers["content-length"],
  );

  const missing = await request(
    new URL(
      "/api/v1/artifacts/00000000-0000-4000-8000-000000000000/city-model.json",
      server.url,
    ),
  );
  expect(missing.status).toBe(404);
  expect(JSON.parse(missing.body)).toMatchObject({
    error: { code: "artifact-not-found" },
  });

  const method = await request(artifactUrl, { method: "DELETE" });
  expect(method.status).toBe(405);
  expect(method.headers.allow).toBe("GET, HEAD");

  await server.close();
  const restarted = await startCodeCityServer({
    host: "127.0.0.1",
    port: 0,
    ...roots,
  });
  servers.push(restarted);
  const retained = await request(
    new URL(completed.result!.artifactUrl, restarted.url),
  );
  expect(retained.status).toBe(200);
  expect(JSON.parse(retained.body)).toEqual(model);
});

it("serves an owned evolution companion with exact metadata and no-store", async () => {
  const roots = await fixture();
  const server = await startCodeCityServer({
    host: "127.0.0.1",
    port: 0,
    ...roots,
  });
  servers.push(server);
  const completed = await publishCompletedHistory(server);
  const result = completed.result!;
  expect(result.evolution).toMatchObject({
    artifactUrl:
      `/api/v1/artifacts/${completed.id}/evolution.json`,
    size: expect.any(Number),
    sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
  });
  const evolutionUrl = new URL(
    result.evolution!.artifactUrl,
    server.url,
  );

  const loaded = await request(evolutionUrl);
  expect(loaded.status).toBe(200);
  expect(loaded.headers["content-type"]).toBe(
    "application/json; charset=utf-8",
  );
  expect(loaded.headers["cache-control"]).toBe("no-store");
  expect(Number(loaded.headers["content-length"])).toBe(
    result.evolution!.size,
  );
  expect(JSON.parse(loaded.body)).toEqual(
    JSON.parse(JSON.stringify(evolutionBundleFixture())),
  );

  const head = await waitForArtifactResponseGate(evolutionUrl, {
    method: "HEAD",
  });
  expect(head.status).toBe(200);
  expect(head.body).toBe("");
  expect(head.headers["content-length"]).toBe(
    loaded.headers["content-length"],
  );
  const method = await request(evolutionUrl, { method: "DELETE" });
  expect(method.status).toBe(405);
  expect(method.headers.allow).toBe("GET, HEAD");

  const legacy = await publishCompletedCityModel(server);
  const unowned = await request(
    new URL(
      `/api/v1/artifacts/${legacy.id}/evolution.json`,
      server.url,
    ),
  );
  expect(unowned.status).toBe(404);

  await server.close();
  const restarted = await startCodeCityServer({
    host: "127.0.0.1",
    port: 0,
    ...roots,
  });
  servers.push(restarted);
  expect(
    (
      await request(
        new URL(result.evolution!.artifactUrl, restarted.url),
      )
    ).status,
  ).toBe(200);
});

it("streams a large verified evolution companion in bounded chunks", async () => {
  const server = await startCodeCityServer({
    host: "127.0.0.1",
    port: 0,
    ...(await fixture()),
  });
  servers.push(server);
  const completed = await publishCompletedHistory(
    server,
    largeEvolutionBundleFixture(),
  );
  const artifactUrl = new URL(
    completed.result!.evolution!.artifactUrl,
    server.url,
  );
  const originalRead = server.artifacts.readEvolution.bind(
    server.artifacts,
  );
  const servedChunkSizes: number[] = [];
  vi.spyOn(server.artifacts, "readEvolution").mockImplementation(
    async (token, expected, signal) => {
      const artifact = await originalRead(token, expected, signal);
      if (artifact === undefined) return undefined;
      return {
        ...artifact,
        chunks: async function* (chunkSignal?: AbortSignal) {
          for await (const chunk of artifact.chunks(chunkSignal)) {
            servedChunkSizes.push(chunk.byteLength);
            yield chunk;
          }
        },
      };
    },
  );

  const loaded = await request(artifactUrl);
  expect(loaded.status).toBe(200);
  expect(servedChunkSizes.length).toBeGreaterThan(2);
  expect(Math.max(...servedChunkSizes)).toBeLessThanOrEqual(
    64 * 1024,
  );
  expect(
    servedChunkSizes.reduce((sum, size) => sum + size, 0),
  ).toBe(completed.result!.evolution!.size);
  expect(JSON.parse(loaded.body)).toEqual(
    JSON.parse(JSON.stringify(largeEvolutionBundleFixture())),
  );
});

it("refuses corrupted evolution bytes before starting GET or HEAD", async () => {
  const roots = await fixture();
  const server = await startCodeCityServer({
    host: "127.0.0.1",
    port: 0,
    ...roots,
  });
  servers.push(server);
  const completed = await publishCompletedHistory(server);
  const artifactUrl = new URL(
    completed.result!.evolution!.artifactUrl,
    server.url,
  );
  const artifactPath = path.join(
    roots.dataDirectory,
    "artifacts",
    completed.id,
    "evolution.json",
  );
  const corrupted = await fs.readFile(artifactPath);
  corrupted[Math.floor(corrupted.byteLength / 2)]! ^= 1;
  await fs.writeFile(artifactPath, corrupted, { mode: 0o600 });

  for (const method of ["GET", "HEAD"]) {
    const response = await request(artifactUrl, { method });
    expect(response.status).toBe(500);
    expect(response.headers["cache-control"]).toBe("no-store");
    if (method === "GET") {
      expect(JSON.parse(response.body)).toMatchObject({
        error: { code: "artifact-read-failed" },
      });
    } else {
      expect(response.body).toBe("");
    }
  }
});

it("cancels evolution verification when the client disconnects", async () => {
  const server = await startCodeCityServer({
    host: "127.0.0.1",
    port: 0,
    ...(await fixture()),
  });
  servers.push(server);
  const completed = await publishCompletedHistory(server);
  const artifactUrl = new URL(
    completed.result!.evolution!.artifactUrl,
    server.url,
  );
  const originalRead = server.artifacts.readEvolution.bind(
    server.artifacts,
  );
  let announceStarted!: () => void;
  let announceCancelled!: () => void;
  const started = new Promise<void>((resolve) => {
    announceStarted = resolve;
  });
  const cancelled = new Promise<void>((resolve) => {
    announceCancelled = resolve;
  });
  let calls = 0;
  vi.spyOn(server.artifacts, "readEvolution").mockImplementation(
    async (token, expected, signal) => {
      calls += 1;
      if (calls === 1) {
        announceStarted();
        try {
          await new Promise<never>((_resolve, reject) => {
            const abort = (): void =>
              reject(signal?.reason ?? new Error("aborted"));
            signal?.addEventListener("abort", abort, { once: true });
            if (signal?.aborted) abort();
          });
        } finally {
          announceCancelled();
        }
      }
      return originalRead(token, expected, signal);
    },
  );

  const controller = new AbortController();
  const disconnected = request(artifactUrl, {
    signal: controller.signal,
  }).catch(() => undefined);
  await started;
  controller.abort();
  await disconnected;
  await cancelled;
  expect((await waitForArtifactResponseGate(artifactUrl)).status).toBe(
    200,
  );
});

it("times out an idle evolution stream and releases the artifact response gate", async () => {
  const server = await startCodeCityServer({
    host: "127.0.0.1",
    port: 0,
    artifactResponseTimeouts: {
      idleMs: 25,
      totalMs: 1_000,
    },
    ...(await fixture()),
  });
  servers.push(server);
  const completed = await publishCompletedHistory(server);
  const artifactUrl = new URL(
    completed.result!.evolution!.artifactUrl,
    server.url,
  );
  const originalRead = server.artifacts.readEvolution.bind(
    server.artifacts,
  );
  let announceStarted!: () => void;
  let announceAborted!: () => void;
  const started = new Promise<void>((resolve) => {
    announceStarted = resolve;
  });
  const aborted = new Promise<void>((resolve) => {
    announceAborted = resolve;
  });
  const read = vi.spyOn(
    server.artifacts,
    "readEvolution",
  ).mockImplementation(async (token, expected, signal) => {
    const artifact = await originalRead(token, expected, signal);
    if (artifact === undefined) return undefined;
    return {
      ...artifact,
      chunks: async function* (chunkSignal?: AbortSignal) {
        announceStarted();
        try {
          await rejectWhenAborted(chunkSignal);
        } finally {
          announceAborted();
        }
      },
    };
  });

  const stalled = request(artifactUrl).then(
    () => undefined,
    (error: unknown) => error,
  );
  await started;
  const outcome = await stalled;
  expect(outcome).toBeInstanceOf(Error);
  await aborted;
  read.mockRestore();
  expect((await waitForArtifactResponseGate(artifactUrl)).status).toBe(
    200,
  );
});

it("times out evolution preverification and releases the artifact response gate", async () => {
  const server = await startCodeCityServer({
    host: "127.0.0.1",
    port: 0,
    artifactResponseTimeouts: {
      idleMs: 50,
      totalMs: 250,
    },
    ...(await fixture()),
  });
  servers.push(server);
  const completed = await publishCompletedHistory(server);
  const artifactUrl = new URL(
    completed.result!.evolution!.artifactUrl,
    server.url,
  );
  const originalRead = server.artifacts.readEvolution.bind(
    server.artifacts,
  );
  let announceStarted!: () => void;
  let announceAborted!: () => void;
  const started = new Promise<void>((resolve) => {
    announceStarted = resolve;
  });
  const aborted = new Promise<void>((resolve) => {
    announceAborted = resolve;
  });
  const read = vi.spyOn(
    server.artifacts,
    "readEvolution",
  ).mockImplementation(async (_token, _expected, signal) => {
    announceStarted();
    try {
      await rejectWhenAborted(signal);
    } finally {
      announceAborted();
    }
    return undefined;
  });

  const stalled = request(artifactUrl).then(
    () => undefined,
    (error: unknown) => error,
  );
  await started;
  const outcome = await stalled;
  expect(outcome).toBeInstanceOf(Error);
  await aborted;
  read.mockRestore();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const verified = await originalRead(
    completed.id,
    completed.result!.evolution,
  );
  expect(verified?.size).toBe(completed.result!.evolution!.size);
  await verified?.close();
  expect((await request(artifactUrl)).status).toBe(200);
});

it("cancels a timed-out city-model GET and releases the artifact response gate", async () => {
  const server = await startCodeCityServer({
    host: "127.0.0.1",
    port: 0,
    artifactResponseTimeouts: {
      idleMs: 50,
      totalMs: 250,
    },
    ...(await fixture()),
  });
  servers.push(server);
  const completed = await publishCompletedCityModel(server);
  const artifactUrl = new URL(completed.result!.artifactUrl, server.url);
  const originalRead = server.artifacts.readCityModel.bind(
    server.artifacts,
  );
  let announceStarted!: () => void;
  let announceAborted!: () => void;
  const started = new Promise<void>((resolve) => {
    announceStarted = resolve;
  });
  const aborted = new Promise<void>((resolve) => {
    announceAborted = resolve;
  });
  const read = vi.spyOn(
    server.artifacts,
    "readCityModel",
  ).mockImplementation(async (_token, signal) => {
    announceStarted();
    try {
      await rejectWhenAborted(signal);
    } finally {
      announceAborted();
    }
    return undefined;
  });

  const stalled = request(artifactUrl).then(
    () => undefined,
    (error: unknown) => error,
  );
  await started;
  const outcome = await stalled;
  expect(outcome).toBeInstanceOf(Error);
  await aborted;
  read.mockRestore();
  expect((await waitForArtifactResponseGate(artifactUrl)).status).toBe(
    200,
  );
  expect(await originalRead(completed.id)).toBeDefined();
});

it("cancels a timed-out city-model HEAD before server close waits for the gate", async () => {
  const server = await startCodeCityServer({
    host: "127.0.0.1",
    port: 0,
    artifactResponseTimeouts: {
      idleMs: 50,
      totalMs: 250,
    },
    ...(await fixture()),
  });
  servers.push(server);
  const completed = await publishCompletedCityModel(server);
  const artifactUrl = new URL(completed.result!.artifactUrl, server.url);
  let announceStarted!: () => void;
  let announceAborted!: () => void;
  const started = new Promise<void>((resolve) => {
    announceStarted = resolve;
  });
  const aborted = new Promise<void>((resolve) => {
    announceAborted = resolve;
  });
  const stat = vi.spyOn(
    server.artifacts,
    "statCityModel",
  ).mockImplementation(async (_token, signal) => {
    announceStarted();
    try {
      await rejectWhenAborted(signal);
    } finally {
      announceAborted();
    }
    return undefined;
  });

  const stalled = request(artifactUrl, { method: "HEAD" }).then(
    () => undefined,
    (error: unknown) => error,
  );
  await started;
  const outcome = await stalled;
  expect(outcome).toBeInstanceOf(Error);
  await aborted;
  stat.mockRestore();
  await expect(server.close()).resolves.toBeUndefined();
});

it("does not expose or retain artifacts without a completed owning job", async () => {
  const roots = await fixture();
  const server = await startCodeCityServer({
    host: "127.0.0.1",
    port: 0,
    ...roots,
  });
  servers.push(server);
  const orphanToken = randomUUID();
  await server.artifacts.publishCityModel(
    orphanToken,
    cityModelFixture(),
  );
  const artifactUrl = new URL(
    `/api/v1/artifacts/${orphanToken}/city-model.json`,
    server.url,
  );

  expect((await request(artifactUrl)).status).toBe(404);
  expect((await request(artifactUrl, { method: "HEAD" })).status).toBe(
    404,
  );

  await server.close();
  const restarted = await startCodeCityServer({
    host: "127.0.0.1",
    port: 0,
    ...roots,
  });
  servers.push(restarted);
  expect(
    await restarted.artifacts.statCityModel(orphanToken),
  ).toBeUndefined();
});

it("refuses startup when a completed job references a missing artifact", async () => {
  const roots = await fixture();
  const server = await startCodeCityServer({
    host: "127.0.0.1",
    port: 0,
    ...roots,
  });
  servers.push(server);
  const completed = await publishCompletedCityModel(server);
  await server.artifacts.cleanupCityModelArtifact(completed.id);
  await server.close();

  await expect(
    startCodeCityServer({
      host: "127.0.0.1",
      port: 0,
      ...roots,
    }),
  ).rejects.toThrow(/artifact/iu);
});

it("refuses startup when a completed history job loses its evolution companion", async () => {
  const roots = await fixture();
  const server = await startCodeCityServer({
    host: "127.0.0.1",
    port: 0,
    ...roots,
  });
  servers.push(server);
  const completed = await publishCompletedHistory(server);
  await server.close();
  await fs.unlink(
    path.join(
      roots.dataDirectory,
      "artifacts",
      completed.id,
      "evolution.json",
    ),
  );

  await expect(
    startCodeCityServer({
      host: "127.0.0.1",
      port: 0,
      ...roots,
    }),
  ).rejects.toThrow(/evolution artifact/iu);
});

it("holds the artifact response gate until a disconnected read settles", async () => {
  const server = await startCodeCityServer({
    host: "127.0.0.1",
    port: 0,
    ...(await fixture()),
  });
  servers.push(server);
  const completed = await publishCompletedCityModel(server);
  const artifactUrl = new URL(completed.result!.artifactUrl, server.url);
  const originalRead = server.artifacts.readCityModel.bind(
    server.artifacts,
  );
  let announceRead!: () => void;
  let announceReadFinished!: () => void;
  let releaseRead!: () => void;
  const readStarted = new Promise<void>((resolve) => {
    announceRead = resolve;
  });
  const readFinished = new Promise<void>((resolve) => {
    announceReadFinished = resolve;
  });
  const readReleased = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  vi.spyOn(server.artifacts, "readCityModel").mockImplementation(
    async (token) => {
      announceRead();
      await readReleased;
      try {
        return await originalRead(token);
      } finally {
        announceReadFinished();
      }
    },
  );

  const controller = new AbortController();
  const first = request(artifactUrl, {
    signal: controller.signal,
  }).catch(() => undefined);
  await readStarted;
  try {
    const concurrent = await request(artifactUrl);
    expect(concurrent.status).toBe(503);
    expect(concurrent.headers["retry-after"]).toBe("1");
    expect(JSON.parse(concurrent.body)).toMatchObject({
      error: { code: "artifact-busy" },
    });
    controller.abort();
    await first;
    const afterDisconnect = await request(artifactUrl);
    expect(afterDisconnect.status).toBe(503);
    expect(afterDisconnect.headers["retry-after"]).toBe("1");
  } finally {
    controller.abort();
    releaseRead();
  }
  await readFinished;
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect((await request(artifactUrl)).status).toBe(200);
});

it("does not report server closure until an artifact read settles", async () => {
  const server = await startCodeCityServer({
    host: "127.0.0.1",
    port: 0,
    ...(await fixture()),
  });
  servers.push(server);
  const completed = await publishCompletedCityModel(server);
  const artifactUrl = new URL(completed.result!.artifactUrl, server.url);
  const originalRead = server.artifacts.readCityModel.bind(
    server.artifacts,
  );
  let announceRead!: () => void;
  let announceReadFinished!: () => void;
  let releaseRead!: () => void;
  const readStarted = new Promise<void>((resolve) => {
    announceRead = resolve;
  });
  const readFinished = new Promise<void>((resolve) => {
    announceReadFinished = resolve;
  });
  const readReleased = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  vi.spyOn(server.artifacts, "readCityModel").mockImplementation(
    async (token) => {
      announceRead();
      await readReleased;
      try {
        return await originalRead(token);
      } finally {
        announceReadFinished();
      }
    },
  );

  const inFlightRequest = request(artifactUrl).catch(() => undefined);
  await readStarted;
  let closeSettled = false;
  const closing = server.close().then(() => {
    closeSettled = true;
  });
  try {
    await inFlightRequest;
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closeSettled).toBe(false);
  } finally {
    releaseRead();
  }

  await readFinished;
  await closing;
  await server.closed;
  expect(closeSettled).toBe(true);
});

it("does not report server closure until an artifact HEAD settles", async () => {
  const server = await startCodeCityServer({
    host: "127.0.0.1",
    port: 0,
    ...(await fixture()),
  });
  servers.push(server);
  const completed = await publishCompletedCityModel(server);
  const artifactUrl = new URL(completed.result!.artifactUrl, server.url);
  const originalStat = server.artifacts.statCityModel.bind(
    server.artifacts,
  );
  let announceStat!: () => void;
  let announceStatFinished!: () => void;
  let releaseStat!: () => void;
  const statStarted = new Promise<void>((resolve) => {
    announceStat = resolve;
  });
  const statFinished = new Promise<void>((resolve) => {
    announceStatFinished = resolve;
  });
  const statReleased = new Promise<void>((resolve) => {
    releaseStat = resolve;
  });
  vi.spyOn(server.artifacts, "statCityModel").mockImplementation(
    async (token) => {
      announceStat();
      await statReleased;
      try {
        return await originalStat(token);
      } finally {
        announceStatFinished();
      }
    },
  );

  const inFlightRequest = request(artifactUrl, {
    method: "HEAD",
  }).catch(() => undefined);
  await statStarted;
  let closeSettled = false;
  const closing = server.close().then(() => {
    closeSettled = true;
  });
  try {
    await inFlightRequest;
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closeSettled).toBe(false);
  } finally {
    releaseStat();
  }

  await statFinished;
  await closing;
  await server.closed;
  expect(closeSettled).toBe(true);
});

it("rejects malformed hosts, encoded targets, and unsupported API methods", async () => {
  const server = await startCodeCityServer({
    host: "127.0.0.1",
    port: 0,
    ...(await fixture()),
  });
  servers.push(server);

  for (const host of [
    "bad host",
    "@localhost",
    ":@localhost",
    "localhost?",
    "localhost#",
    "localhost?#",
    "localhost%",
  ]) {
    expect((await request(server.url, { host })).status).toBe(400);
  }

  const untrustedHost = await request(server.url, {
    host: "attacker.example",
  });
  expect(untrustedHost.status).toBe(400);

  const encoded = await request(
    new URL("/assets/%252e%252e/secret", server.url),
  );
  expect(encoded.status).toBe(400);

  const method = await request(
    new URL("/api/v1/health", server.url),
    { method: "POST" },
  );
  expect(method.status).toBe(405);
  expect(method.headers.allow).toBe("GET, HEAD");
});

it("allows an explicitly configured DNS hostname", async () => {
  const server = await startCodeCityServer({
    host: "127.0.0.1",
    port: 0,
    allowedHosts: ["codecity.lan"],
    ...(await fixture()),
  });
  servers.push(server);

  const response = await request(server.url, {
    host: "codecity.lan",
  });
  expect(response.status).toBe(200);
});

it("formats a concrete IPv6 bind address as a valid URL", async () => {
  const server = await startCodeCityServer({
    host: "::1",
    port: 0,
    ...(await fixture()),
  });
  servers.push(server);

  expect(server.url.hostname).toBe("[::1]");
  expect((await request(server.url)).status).toBe(200);
});

it("does not load retained source for a disabled AI preview", async () => {
  const server = await startCodeCityServer({
    host: "127.0.0.1",
    port: 0,
    aiGuidance: { version: 1, enabled: false, providers: [] },
    ...(await fixture()),
  });
  servers.push(server);
  const response = await request(
    new URL(
      "/api/v1/ai/preview/00000000-0000-4000-8000-000000000000/typescript:0123456789abcdef/local",
      server.url,
    ),
    { method: "POST", headers: { "X-Code-City-Request": "1" } },
  );
  expect(response.status).toBe(200);
  expect(JSON.parse(response.body)).toEqual({
    preview: expect.objectContaining({ enabled: false }),
  });
});
