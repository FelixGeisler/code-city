import { promises as fs } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ImportArtifactStore,
  type ImportStagingDirectory,
} from "../apps/server/src/import-artifacts.js";
import type { JobRecord } from "../apps/server/src/job-queue.js";
import {
  startCodeCityServer,
  type CodeCityServerHandle,
} from "../apps/server/src/server.js";
import {
  parseUploadImportJson,
  parseUploadImportRequest,
  UploadReservationFailure,
  UploadReservationRegistry,
} from "../apps/server/src/upload-import.js";
import { RemoteImportRequestError } from "../apps/server/src/remote-import.js";

const temporaryDirectories: string[] = [];
const servers: CodeCityServerHandle[] = [];

const minimalCityModel = Object.freeze({
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
});

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "code-city-upload-import-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

async function fixture(): Promise<{
  readonly dataDirectory: string;
  readonly viewerRoot: string;
}> {
  const root = await temporaryDirectory();
  const viewerRoot = path.join(root, "viewer");
  await fs.mkdir(viewerRoot);
  await fs.writeFile(
    path.join(viewerRoot, "index.html"),
    "<!doctype html><title>Code City</title>",
    "utf8",
  );
  return {
    dataDirectory: path.join(root, "data"),
    viewerRoot,
  };
}

async function request(
  url: URL,
  options: {
    readonly method: string;
    readonly body?: Buffer;
    readonly headers?: http.OutgoingHttpHeaders;
  },
): Promise<{
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}> {
  return new Promise((resolve, reject) => {
    const outgoing = http.request(
      {
        hostname: url.hostname,
        port: Number(url.port),
        path: url.pathname,
        method: options.method,
        headers: options.headers,
        agent: false,
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.on("end", () =>
          resolve({
            status: incoming.statusCode ?? 0,
            headers: incoming.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    outgoing.on("error", reject);
    outgoing.end(options.body);
  });
}

async function reserve(
  server: CodeCityServerHandle,
  metadata: unknown,
): Promise<{
  readonly token: string;
  readonly uploadUrl: string;
}> {
  const body = Buffer.from(JSON.stringify(metadata), "utf8");
  const response = await request(
    new URL("/api/v1/imports/uploads", server.url),
    {
      method: "POST",
      body,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": body.byteLength,
        "X-Code-City-Request": "1",
      },
    },
  );
  expect(response.status).toBe(201);
  return JSON.parse(response.body).upload as {
    readonly token: string;
    readonly uploadUrl: string;
  };
}

async function put(
  server: CodeCityServerHandle,
  uploadUrl: string,
  body: Buffer,
  mediaType: string,
): Promise<{
  readonly status: number;
  readonly body: string;
}> {
  return request(new URL(uploadUrl, server.url), {
    method: "PUT",
    body,
    headers: {
      "Content-Type": mediaType,
      "Content-Length": body.byteLength,
      "X-Code-City-Request": "1",
    },
  });
}

async function waitForTerminal(
  server: CodeCityServerHandle,
  id: string,
): Promise<JobRecord> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const record = server.jobs.get(id);
    if (
      record?.state === "completed" ||
      record?.state === "failed" ||
      record?.state === "cancelled"
    ) {
      return record;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for upload job ${id}.`);
}

async function waitForMissing(filePath: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      await fs.lstat(filePath);
    } catch (error) {
      if (
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return;
      }
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${filePath} to be removed.`);
}

function rawExchange(port: number, bytes: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Raw upload exchange timed out."));
    }, 2_000);
    socket.on("connect", () => socket.write(bytes));
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.once("end", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

afterEach(async () => {
  await Promise.allSettled(servers.splice(0).map((server) => server.close()));
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
  vi.restoreAllMocks();
});

describe("upload import metadata", () => {
  it("parses exact model and repository archive shapes", () => {
    expect(
      parseUploadImportRequest({
        source: { kind: "city-model", sizeBytes: 42 },
      }),
    ).toEqual({
      source: { kind: "city-model", sizeBytes: 42 },
    });
    expect(
      parseUploadImportRequest({
        source: {
          kind: "repository-zip",
          sizeBytes: 100,
          repositoryName: "Example",
          rootMode: "archive-root",
        },
        identity: { title: "Example city" },
        analysis: { maxRetainedFiles: 100 },
      }),
    ).toEqual({
      source: {
        kind: "repository-zip",
        sizeBytes: 100,
        repositoryName: "Example",
        rootMode: "archive-root",
      },
      identity: { title: "Example city" },
      analysis: { maxRetainedFiles: 100 },
    });
  });

  it("rejects duplicate members, path-like repository names, and model options", () => {
    expect(() =>
      parseUploadImportJson(
        '{"source":{"kind":"city-model","sizeBytes":1},"sour\\u0063e":{}}',
      ),
    ).toThrow(RemoteImportRequestError);
    for (const repositoryName of [".", "..", "a/b", "a\\b"]) {
      expect(() =>
        parseUploadImportRequest({
          source: {
            kind: "repository-zip",
            sizeBytes: 1,
            repositoryName,
            rootMode: "archive-root",
          },
        }),
      ).toThrow(RemoteImportRequestError);
    }
    expect(() =>
      parseUploadImportRequest({
        source: { kind: "city-model", sizeBytes: 1 },
        identity: { title: "No override" },
      }),
    ).toThrow(RemoteImportRequestError);
  });
});

describe("upload reservations and staging", () => {
  it("admits only one receiver and holds quota until private staging is removed", async () => {
    const dataDirectory = path.join(await temporaryDirectory(), "data");
    const artifacts = await ImportArtifactStore.open({ dataDirectory });
    const registry = new UploadReservationRegistry(artifacts, {
      maximumActiveUploads: 1,
      maximumStagedBytes: 10,
    });
    const requestValue = parseUploadImportRequest({
      source: { kind: "city-model", sizeBytes: 5 },
    });
    const reservation = await registry.reserve(requestValue);
    const reception = registry.begin(reservation.token);
    expect(() => registry.begin(reservation.token)).toThrow(
      UploadReservationFailure,
    );
    await expect(registry.reserve(requestValue)).rejects.toMatchObject({
      code: "quota-exceeded",
    });

    await artifacts.writeStagedUpload(
      reception.staging.token,
      (async function* () {
        yield Buffer.from("12345");
      })(),
      { expectedBytes: 5, maximumBytes: 5, signal: reception.signal },
    );
    expect(
      await artifacts.readStagedUpload(reception.staging.token, 5),
    ).toEqual(Buffer.from("12345"));
    const lease = reception.transfer();
    await lease.cleanup();
    await expect(fs.lstat(reception.staging.directory)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await registry.close();
  });

  it("marks an active reception unavailable before waiting for its writer", async () => {
    const dataDirectory = path.join(await temporaryDirectory(), "data");
    const artifacts = await ImportArtifactStore.open({ dataDirectory });
    const registry = new UploadReservationRegistry(artifacts);
    const reservation = await registry.reserve(
      parseUploadImportRequest({
        source: { kind: "city-model", sizeBytes: 1 },
      }),
    );
    const reception = registry.begin(reservation.token);
    let abandoned = false;
    const abandonment = registry.abandon(reservation.token).then(() => {
      abandoned = true;
    });
    await Promise.resolve();
    expect(abandoned).toBe(false);
    expect(reception.signal.aborted).toBe(true);
    expect(() => registry.begin(reservation.token)).toThrow(
      UploadReservationFailure,
    );
    await reception.fail();
    await abandonment;
    expect(abandoned).toBe(true);
    await registry.close();
  });

  it("rejects short, long, aborted, and concurrent staged writers", async () => {
    const dataDirectory = path.join(await temporaryDirectory(), "data");
    const artifacts = await ImportArtifactStore.open({ dataDirectory });
    for (const [chunks, expected] of [
      [[Buffer.from("a")], 2],
      [[Buffer.from("ab")], 1],
    ] as const) {
      const staging = await artifacts.createStagingDirectory();
      await expect(
        artifacts.writeStagedUpload(
          staging.token,
          (async function* () {
            yield* chunks;
          })(),
          { expectedBytes: expected, maximumBytes: 2 },
        ),
      ).rejects.toBeDefined();
      await artifacts.cleanupStagingDirectory(staging.token);
    }

    const staging = await artifacts.createStagingDirectory();
    const controller = new AbortController();
    controller.abort();
    await expect(
      artifacts.writeStagedUpload(
        staging.token,
        (async function* () {
          yield Buffer.from("a");
        })(),
        {
          expectedBytes: 1,
          maximumBytes: 1,
          signal: controller.signal,
        },
      ),
    ).rejects.toBeDefined();

    await fs.writeFile(
      path.join(staging.directory, "upload.bin"),
      "existing",
      { mode: 0o600 },
    );
    await expect(
      artifacts.writeStagedUpload(
        staging.token,
        (async function* () {
          yield Buffer.from("a");
        })(),
        { expectedBytes: 1, maximumBytes: 1 },
      ),
    ).rejects.toBeDefined();
    expect(
      await fs.readFile(path.join(staging.directory, "upload.bin"), "utf8"),
    ).toBe("existing");
    await artifacts.cleanupStagingDirectory(staging.token);
  });
});

describe("upload import HTTP jobs", () => {
  it("validates and republishes an existing city model through a durable job", async () => {
    const server = await startCodeCityServer({
      host: "127.0.0.1",
      port: 0,
      ...(await fixture()),
    });
    servers.push(server);
    const bytes = Buffer.from(JSON.stringify(minimalCityModel), "utf8");
    const reservation = await reserve(server, {
      source: { kind: "city-model", sizeBytes: bytes.byteLength },
    });
    const queued = await put(
      server,
      reservation.uploadUrl,
      bytes,
      "application/json",
    );
    expect(queued.status).toBe(202);
    const job = (JSON.parse(queued.body) as { job: JobRecord }).job;
    const terminal = await waitForTerminal(server, job.id);
    expect(terminal.state).toBe("completed");
    expect(terminal.result?.source).toEqual({
      availability: "not-captured",
    });
    const artifact = await request(
      new URL(terminal.result!.artifactUrl, server.url),
      { method: "GET" },
    );
    expect(artifact.status).toBe(200);
    expect(JSON.parse(artifact.body)).toEqual(minimalCityModel);
    const source = await request(
      new URL(
        `/api/v1/artifacts/${job.id}/sources/building:1234567890abcdef`,
        server.url,
      ),
      { method: "GET" },
    );
    expect(source.status).toBe(409);
    expect(JSON.parse(source.body)).toMatchObject({
      error: { code: "source-not-captured" },
    });
  });

  it.each([
    [
      "single-directory",
      "Example/src/main.ts",
    ],
    [
      "archive-root",
      "src/main.ts",
    ],
  ] as const)(
    "analyzes a bounded repository ZIP in %s root mode",
    async (rootMode, sourcePath) => {
      const server = await startCodeCityServer({
        host: "127.0.0.1",
        port: 0,
        ...(await fixture()),
      });
      servers.push(server);
      const bytes = Buffer.from(zipSync({
        [sourcePath]: strToU8("export const value = 1;\n"),
      }));
      const reservation = await reserve(server, {
        source: {
          kind: "repository-zip",
          sizeBytes: bytes.byteLength,
          repositoryName: `Example-${rootMode}`,
          rootMode,
        },
      });
      const queued = await put(
        server,
        reservation.uploadUrl,
        bytes,
        "application/zip",
      );
      expect(queued.status).toBe(202);
      const job = (JSON.parse(queued.body) as { job: JobRecord }).job;
      const terminal = await waitForTerminal(server, job.id);
      expect(terminal.state).toBe("completed");
      const artifact = await server.artifacts.readCityModel(job.id);
      expect(
        (
          JSON.parse(artifact!.bytes.toString("utf8")) as {
            repositories: readonly { name: string }[];
          }
        ).repositories[0]?.name,
      ).toBe(`Example-${rootMode}`);
    },
  );

  it("keeps cancellation classification while retained-source publication is active", async () => {
    const roots = await fixture();
    const server = await startCodeCityServer({
      host: "127.0.0.1",
      port: 0,
      ...roots,
      sourceRetention: "retain",
    });
    servers.push(server);
    const bytes = Buffer.from(
      zipSync({
        "src/main.ts": strToU8("export const value = 1;\n"),
      }),
    );
    const reservation = await reserve(server, {
      source: {
        kind: "repository-zip",
        sizeBytes: bytes.byteLength,
        repositoryName: "Cancellation",
        rootMode: "archive-root",
      },
    });
    let announcePublication!: () => void;
    const publicationStarted = new Promise<void>((resolve) => {
      announcePublication = resolve;
    });
    let observedSignal: AbortSignal | undefined;
    vi.spyOn(server.sources, "publish").mockImplementation(
      async (_token, _artifact, options = {}) => {
        observedSignal = options.signal;
        if (observedSignal === undefined) {
          throw new Error("Retained-source publication needs the job signal.");
        }
        announcePublication();
        await new Promise<void>((resolve) => {
          if (observedSignal?.aborted) {
            resolve();
            return;
          }
          observedSignal?.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
        observedSignal.throwIfAborted();
        throw new Error("Expected retained-source publication to abort.");
      },
    );

    const queued = await put(
      server,
      reservation.uploadUrl,
      bytes,
      "application/zip",
    );
    expect(queued.status).toBe(202);
    const job = (JSON.parse(queued.body) as { job: JobRecord }).job;
    await publicationStarted;
    const cancelled = await server.jobs.cancel(job.id);
    expect(cancelled?.state).toBe("cancelled");
    expect((await waitForTerminal(server, job.id)).state).toBe(
      "cancelled",
    );
    expect(observedSignal?.aborted).toBe(true);
    expect(await server.sources.read(job.id)).toBeUndefined();
    expect(await server.artifacts.statCityModel(job.id)).toBeUndefined();
    await waitForMissing(
      path.join(roots.dataDirectory, "sources", job.id),
    );
    await waitForMissing(
      path.join(
        roots.dataDirectory,
        "tmp",
        "imports",
        reservation.token,
      ),
    );
  });

  it("fails invalid model content safely and consumes each reservation once", async () => {
    const roots = await fixture();
    const server = await startCodeCityServer({
      host: "127.0.0.1",
      port: 0,
      ...roots,
    });
    servers.push(server);
    const bytes = Buffer.from('{"schemaVersion":"wrong"}', "utf8");
    const reservation = await reserve(server, {
      source: { kind: "city-model", sizeBytes: bytes.byteLength },
    });
    const queued = await put(
      server,
      reservation.uploadUrl,
      bytes,
      "application/json",
    );
    expect(queued.status).toBe(202);
    const job = (JSON.parse(queued.body) as { job: JobRecord }).job;
    const terminal = await waitForTerminal(server, job.id);
    expect(terminal).toMatchObject({
      state: "failed",
      error: {
        code: "city-model-invalid",
        message: "The uploaded city model is invalid.",
      },
    });
    expect(await server.artifacts.statCityModel(job.id)).toBeUndefined();
    expect(
      (
        await put(
          server,
          reservation.uploadUrl,
          bytes,
          "application/json",
        )
      ).status,
    ).toBe(404);
    expect(
      await fs.readdir(path.join(roots.dataDirectory, "tmp", "imports")),
    ).toEqual([]);
  });

  it("treats fatal UTF-8 and malformed repository archives as fixed job failures", async () => {
    const server = await startCodeCityServer({
      host: "127.0.0.1",
      port: 0,
      ...(await fixture()),
    });
    servers.push(server);
    const invalidUtf8 = Buffer.from([0xff]);
    const modelReservation = await reserve(server, {
      source: { kind: "city-model", sizeBytes: 1 },
    });
    const modelQueued = await put(
      server,
      modelReservation.uploadUrl,
      invalidUtf8,
      "application/json",
    );
    const modelJob = (JSON.parse(modelQueued.body) as { job: JobRecord }).job;
    expect(await waitForTerminal(server, modelJob.id)).toMatchObject({
      state: "failed",
      error: { code: "city-model-invalid" },
    });

    const invalidZip = Buffer.from("not a zip", "utf8");
    const zipReservation = await reserve(server, {
      source: {
        kind: "repository-zip",
        sizeBytes: invalidZip.byteLength,
        repositoryName: "Example",
        rootMode: "archive-root",
      },
    });
    const zipQueued = await put(
      server,
      zipReservation.uploadUrl,
      invalidZip,
      "application/zip",
    );
    const zipJob = (JSON.parse(zipQueued.body) as { job: JobRecord }).job;
    expect(await waitForTerminal(server, zipJob.id)).toMatchObject({
      state: "failed",
      error: { code: "repository-content-rejected" },
    });
  });

  it("cancellation and publication failure remove staged and partial artifacts", async () => {
    const roots = await fixture();
    const server = await startCodeCityServer({
      host: "127.0.0.1",
      port: 0,
      ...roots,
    });
    servers.push(server);
    const bytes = Buffer.from(JSON.stringify(minimalCityModel), "utf8");
    const reservation = await reserve(server, {
      source: { kind: "city-model", sizeBytes: bytes.byteLength },
    });
    let signalReadStarted: (() => void) | undefined;
    const readStarted = new Promise<void>((resolve) => {
      signalReadStarted = resolve;
    });
    vi.spyOn(server.artifacts, "readStagedUpload").mockImplementation(
      async (_token, _maximum, signal) => {
        signalReadStarted?.();
        await new Promise<void>((resolve) => {
          if (signal?.aborted) resolve();
          else signal?.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
        signal?.throwIfAborted();
        return bytes;
      },
    );
    const queued = await put(
      server,
      reservation.uploadUrl,
      bytes,
      "application/json",
    );
    const job = (JSON.parse(queued.body) as { job: JobRecord }).job;
    await readStarted;
    const cancelled = await server.jobs.cancel(job.id);
    expect(cancelled?.state).toBe("cancelled");
    await expect(
      fs.lstat(
        path.join(
          roots.dataDirectory,
          "tmp",
          "imports",
          reservation.token,
        ),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    vi.restoreAllMocks();

    const second = await reserve(server, {
      source: { kind: "city-model", sizeBytes: bytes.byteLength },
    });
    vi.spyOn(server.artifacts, "publishCityModel").mockRejectedValueOnce(
      new Error("never expose this path"),
    );
    const failedQueued = await put(
      server,
      second.uploadUrl,
      bytes,
      "application/json",
    );
    const failedJob = (
      JSON.parse(failedQueued.body) as { job: JobRecord }
    ).job;
    const failed = await waitForTerminal(server, failedJob.id);
    expect(failed.state).toBe("failed");
    expect(failed.error?.message).not.toContain("never expose");
    expect(await server.artifacts.statCityModel(failedJob.id)).toBeUndefined();
  });

  it("cleans unused reservations during graceful shutdown", async () => {
    const roots = await fixture();
    const server = await startCodeCityServer({
      host: "127.0.0.1",
      port: 0,
      ...roots,
    });
    const reservation = await reserve(server, {
      source: { kind: "city-model", sizeBytes: 1 },
    });
    await server.close();
    await expect(
      fs.lstat(
        path.join(
          roots.dataDirectory,
          "tmp",
          "imports",
          reservation.token,
        ),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("serializes DELETE with an active writer and reports cleanup failure safely", async () => {
    const roots = await fixture();
    const server = await startCodeCityServer({
      host: "127.0.0.1",
      port: 0,
      ...roots,
    });
    servers.push(server);
    const bytes = Buffer.from(JSON.stringify(minimalCityModel), "utf8");
    const reservation = await reserve(server, {
      source: { kind: "city-model", sizeBytes: bytes.byteLength },
    });
    let signalWriterStarted: (() => void) | undefined;
    const writerStarted = new Promise<void>((resolve) => {
      signalWriterStarted = resolve;
    });
    vi.spyOn(server.artifacts, "writeStagedUpload").mockImplementation(
      async (_token, chunks, options) => {
        for await (const _chunk of chunks) {
          // Consume the complete HTTP body before deferring the disk flush.
        }
        signalWriterStarted?.();
        await new Promise<void>((resolve) => {
          if (options.signal?.aborted) resolve();
          else options.signal?.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
        options.signal?.throwIfAborted();
      },
    );
    const uploading = put(
      server,
      reservation.uploadUrl,
      bytes,
      "application/json",
    );
    await writerStarted;
    let deletionFinished = false;
    const deletion = request(
      new URL(reservation.uploadUrl, server.url),
      {
        method: "DELETE",
        headers: {
          "Content-Length": 0,
          "X-Code-City-Request": "1",
        },
      },
    ).then((response) => {
      deletionFinished = true;
      return response;
    });
    await Promise.resolve();
    expect(deletionFinished).toBe(false);
    const [uploadResponse, deleteResponse] = await Promise.all([
      uploading,
      deletion,
    ]);
    expect([400, 409]).toContain(uploadResponse.status);
    expect(deleteResponse.status).toBe(200);
    expect(server.jobs.list()).toEqual([]);
    await waitForMissing(
      path.join(
        roots.dataDirectory,
        "tmp",
        "imports",
        reservation.token,
      ),
    );
    vi.restoreAllMocks();

    const second = await reserve(server, {
      source: { kind: "city-model", sizeBytes: 1 },
    });
    vi.spyOn(server.artifacts, "cleanupStagingDirectory")
      .mockRejectedValueOnce(new Error("secret cleanup path"))
      .mockImplementation(
        async (token) =>
          ImportArtifactStore.prototype.cleanupStagingDirectory.call(
            server.artifacts,
            token,
          ),
      );
    const failedDelete = await request(
      new URL(second.uploadUrl, server.url),
      {
        method: "DELETE",
        headers: {
          "Content-Length": 0,
          "X-Code-City-Request": "1",
        },
      },
    );
    expect(failedDelete.status).toBe(500);
    expect(failedDelete.body).not.toContain("secret cleanup");
  });

  it("cleans a disconnected active PUT and an active PUT during shutdown", async () => {
    const roots = await fixture();
    const server = await startCodeCityServer({
      host: "127.0.0.1",
      port: 0,
      ...roots,
    });
    const first = await reserve(server, {
      source: { kind: "city-model", sizeBytes: 10 },
    });
    const disconnected = net.createConnection({
      host: "127.0.0.1",
      port: server.port,
    });
    await new Promise<void>((resolve) =>
      disconnected.once("connect", resolve),
    );
    disconnected.write(
      [
        `PUT ${first.uploadUrl} HTTP/1.1`,
        `Host: 127.0.0.1:${server.port}`,
        "Content-Type: application/json",
        "Content-Length: 10",
        "X-Code-City-Request: 1",
        "",
        "a",
      ].join("\r\n"),
    );
    disconnected.destroy();
    await waitForMissing(
      path.join(
        roots.dataDirectory,
        "tmp",
        "imports",
        first.token,
      ),
    );

    const second = await reserve(server, {
      source: { kind: "city-model", sizeBytes: 10 },
    });
    const active = net.createConnection({
      host: "127.0.0.1",
      port: server.port,
    });
    await new Promise<void>((resolve) => active.once("connect", resolve));
    active.write(
      [
        `PUT ${second.uploadUrl} HTTP/1.1`,
        `Host: 127.0.0.1:${server.port}`,
        "Content-Type: application/json",
        "Content-Length: 10",
        "X-Code-City-Request: 1",
        "",
        "a",
      ].join("\r\n"),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    await server.close();
    active.destroy();
    await waitForMissing(
      path.join(
        roots.dataDirectory,
        "tmp",
        "imports",
        second.token,
      ),
    );
  });

  it("enforces idle and total upload deadlines without leaving staging", async () => {
    const roots = await fixture();
    const server = await startCodeCityServer({
      host: "127.0.0.1",
      port: 0,
      ...roots,
    });
    servers.push(server);
    const nativeSetTimeout = globalThis.setTimeout;
    for (const acceleratedDelay of [30_000, 10 * 60_000]) {
      const reservation = await reserve(server, {
        source: { kind: "city-model", sizeBytes: 10 },
      });
      vi.spyOn(globalThis, "setTimeout").mockImplementation(
        ((
          callback: (...arguments_: unknown[]) => void,
          delay?: number,
          ...arguments_: unknown[]
        ) =>
          nativeSetTimeout(
            callback,
            delay === acceleratedDelay ? 20 : delay,
            ...arguments_,
          )) as typeof setTimeout,
      );
      const response = await rawExchange(
        server.port,
        [
          `PUT ${reservation.uploadUrl} HTTP/1.1`,
          `Host: 127.0.0.1:${server.port}`,
          "Content-Type: application/json",
          "Content-Length: 10",
          "X-Code-City-Request: 1",
          "Connection: close",
          "",
          "a",
        ].join("\r\n"),
      );
      expect(response).toMatch(/^HTTP\/1\.1 408 /u);
      vi.restoreAllMocks();
      await waitForMissing(
        path.join(
          roots.dataDirectory,
          "tmp",
          "imports",
          reservation.token,
        ),
      );
    }
  });

  it("rejects missing length, mismatched length, and transfer encoding before enqueue", async () => {
    const server = await startCodeCityServer({
      host: "127.0.0.1",
      port: 0,
      ...(await fixture()),
    });
    servers.push(server);
    const reservation = await reserve(server, {
      source: { kind: "city-model", sizeBytes: 3 },
    });
    const mismatched = await request(
      new URL(reservation.uploadUrl, server.url),
      {
        method: "PUT",
        body: Buffer.from("ab"),
        headers: {
          "Content-Type": "application/json",
          "Content-Length": 2,
          "X-Code-City-Request": "1",
        },
      },
    );
    expect(mismatched.status).toBe(400);
    expect(server.jobs.list()).toEqual([]);

    const second = await reserve(server, {
      source: { kind: "city-model", sizeBytes: 3 },
    });
    const noLength = await rawExchange(
      server.port,
      [
        `PUT ${second.uploadUrl} HTTP/1.1`,
        `Host: 127.0.0.1:${server.port}`,
        "Content-Type: application/json",
        "X-Code-City-Request: 1",
        "Connection: close",
        "",
        "abc",
      ].join("\r\n"),
    );
    expect(noLength).toMatch(/^HTTP\/1\.1 411 /u);

    const third = await reserve(server, {
      source: { kind: "city-model", sizeBytes: 3 },
    });
    const ambiguous = await rawExchange(
      server.port,
      [
        `PUT ${third.uploadUrl} HTTP/1.1`,
        `Host: 127.0.0.1:${server.port}`,
        "Content-Type: application/json",
        "Content-Length: 3",
        "Transfer-Encoding: chunked",
        "X-Code-City-Request: 1",
        "Connection: close",
        "",
        "3",
        "abc",
        "0",
        "",
        "",
      ].join("\r\n"),
    );
    expect(ambiguous).toMatch(/^HTTP\/1\.1 400 /u);
    expect(server.jobs.list()).toEqual([]);
  });

  it("promptly closes slow bodies on unknown and invalid-token routes", async () => {
    const roots = await fixture();
    const server = await startCodeCityServer({
      host: "127.0.0.1",
      port: 0,
      ...roots,
    });
    servers.push(server);
    for (const target of [
      "/api/v1/unknown",
      "/api/v1/imports/uploads/not-a-token",
    ]) {
      const response = await rawExchange(
        server.port,
        [
          `PUT ${target} HTTP/1.1`,
          `Host: 127.0.0.1:${server.port}`,
          "Content-Type: application/json",
          "Content-Length: 1000000",
          "X-Code-City-Request: 1",
          "Connection: keep-alive",
          "",
          "a",
        ].join("\r\n"),
      );
      expect(response).toMatch(/^HTTP\/1\.1 400 /u);
      expect(response).toContain("unexpected-request-body");
    }
    expect(server.jobs.list()).toEqual([]);
    expect(
      await fs.readdir(path.join(roots.dataDirectory, "tmp", "imports")),
    ).toEqual([]);
  });

  it("allows exactly one of two concurrent PUTs to consume a reservation", async () => {
    const server = await startCodeCityServer({
      host: "127.0.0.1",
      port: 0,
      ...(await fixture()),
    });
    servers.push(server);
    const bytes = Buffer.from(JSON.stringify(minimalCityModel), "utf8");
    const reservation = await reserve(server, {
      source: { kind: "city-model", sizeBytes: bytes.byteLength },
    });
    const responses = await Promise.all([
      put(server, reservation.uploadUrl, bytes, "application/json"),
      put(server, reservation.uploadUrl, bytes, "application/json"),
    ]);
    expect(responses.filter(({ status }) => status === 202)).toHaveLength(1);
    expect(
      responses.filter(({ status }) => status === 404 || status === 409),
    ).toHaveLength(1);
    expect(server.jobs.list()).toHaveLength(1);
  });

  it("reports persistent reservation cleanup failure but still settles server.closed", async () => {
    const server = await startCodeCityServer({
      host: "127.0.0.1",
      port: 0,
      ...(await fixture()),
    });
    await reserve(server, {
      source: { kind: "city-model", sizeBytes: 1 },
    });
    vi.spyOn(
      server.artifacts,
      "cleanupStagingDirectory",
    ).mockRejectedValue(new Error("never expose shutdown path"));

    await expect(server.close()).rejects.toThrow(
      "Upload reservation cleanup did not complete.",
    );
    await expect(server.closed).resolves.toBeUndefined();

    vi.restoreAllMocks();
    const controller = new AbortController();
    const signalServer = await startCodeCityServer({
      host: "127.0.0.1",
      port: 0,
      signal: controller.signal,
      ...(await fixture()),
    });
    await reserve(signalServer, {
      source: { kind: "city-model", sizeBytes: 1 },
    });
    vi.spyOn(
      signalServer.artifacts,
      "cleanupStagingDirectory",
    ).mockRejectedValue(new Error("never expose abort cleanup path"));
    controller.abort();
    await expect(signalServer.closed).resolves.toBeUndefined();
  });

  it("reports cleanup failure for a reservation created during shutdown", async () => {
    const server = await startCodeCityServer({
      host: "127.0.0.1",
      port: 0,
      ...(await fixture()),
    });
    const originalCreate =
      server.artifacts.createStagingDirectory.bind(server.artifacts);
    let signalCreateStarted: (() => void) | undefined;
    const createStarted = new Promise<void>((resolve) => {
      signalCreateStarted = resolve;
    });
    let releaseCreate: (() => void) | undefined;
    const createReleased = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    let created: ImportStagingDirectory | undefined;
    vi.spyOn(
      server.artifacts,
      "createStagingDirectory",
    ).mockImplementation(async () => {
      signalCreateStarted?.();
      await createReleased;
      created = await originalCreate();
      return created;
    });
    vi.spyOn(
      server.artifacts,
      "cleanupStagingDirectory",
    ).mockRejectedValue(new Error("never expose pending cleanup path"));

    const body = Buffer.from(
      JSON.stringify({
        source: { kind: "city-model", sizeBytes: 1 },
      }),
      "utf8",
    );
    const reservationRequest = request(
      new URL("/api/v1/imports/uploads", server.url),
      {
        method: "POST",
        body,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": body.byteLength,
          "X-Code-City-Request": "1",
        },
      },
    ).catch(() => undefined);
    await createStarted;

    const closing = server.close();
    let closeSettled = false;
    void closing
      .finally(() => {
        closeSettled = true;
      })
      .catch(() => undefined);
    await Promise.resolve();
    expect(closeSettled).toBe(false);

    releaseCreate?.();
    await expect(closing).rejects.toThrow(
      "Upload reservation cleanup did not complete.",
    );
    await expect(server.closed).resolves.toBeUndefined();
    await reservationRequest;
    expect(created).toBeDefined();
    expect((await fs.lstat(created!.directory)).isDirectory()).toBe(true);
  });
});
