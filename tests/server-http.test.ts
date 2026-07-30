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
  readonly generator: { readonly name: string; readonly version: string };
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
): Promise<JobRecord> {
  const queued = await server.jobs.enqueue(
    "analysis",
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

function request(
  url: URL,
  options: {
    readonly method?: string;
    readonly host?: string;
    readonly headers?: http.OutgoingHttpHeaders;
    readonly signal?: AbortSignal;
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
    outgoing.end();
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
