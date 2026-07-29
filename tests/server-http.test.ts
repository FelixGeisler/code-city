import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, it } from "vitest";

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

function request(
  url: URL,
  options: {
    readonly method?: string;
    readonly host?: string;
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
        headers:
          options.host === undefined ? undefined : { Host: options.host },
        agent: false,
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
    { method: "DELETE" },
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
