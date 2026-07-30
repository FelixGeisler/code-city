import { promises as fs } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import {
  afterEach,
  describe,
  expect,
  it,
} from "vitest";

import type { JobRecord } from "../apps/server/src/job-queue.js";
import {
  environmentAuthorizationTokenFile,
  environmentPublicOrigin,
  environmentWindowsAuthTokenFileTrust,
} from "../apps/server/src/main.js";
import {
  startCodeCityServer,
  type CodeCityServerHandle,
} from "../apps/server/src/server.js";

interface ResponseSnapshot {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}

const AUTHORITY = "codecity.test";
const PUBLIC_ORIGIN = `https://${AUTHORITY}`;
const TOKEN = Buffer.alloc(32, 0xa5).toString("base64url");
const WRONG_TOKEN = Buffer.alloc(32, 0x5a).toString("base64url");
const temporaryDirectories: string[] = [];
const servers: CodeCityServerHandle[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function fixture(): Promise<{
  readonly root: string;
  readonly dataDirectory: string;
  readonly viewerRoot: string;
}> {
  const root = await temporaryDirectory("code-city-auth-");
  const viewerRoot = path.join(root, "viewer");
  await fs.mkdir(path.join(viewerRoot, "assets"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(viewerRoot, "index.html"),
    "<!doctype html><title>Authorized Code City</title>",
    "utf8",
  );
  return {
    root,
    dataDirectory: path.join(root, "data"),
    viewerRoot,
  };
}

async function privateTokenFile(
  root: string,
  token = TOKEN,
): Promise<string> {
  const tokenFile = path.join(root, "authorization-token");
  await fs.writeFile(tokenFile, `${token}\n`, {
    encoding: "ascii",
    mode: 0o600,
  });
  if (process.platform !== "win32") {
    await fs.chmod(tokenFile, 0o600);
  }
  return tokenFile;
}

async function authorizedServer(
  options: {
    readonly now?: () => number;
    readonly publicOrigin?: string;
    readonly randomBytes?: (size: number) => Buffer;
  } = {},
): Promise<{
  readonly roots: Awaited<ReturnType<typeof fixture>>;
  readonly server: CodeCityServerHandle;
  readonly tokenFile: string;
}> {
  const roots = await fixture();
  const tokenFile = await privateTokenFile(roots.root);
  const server = await startCodeCityServer({
    host: "127.0.0.1",
    port: 0,
    dataDirectory: roots.dataDirectory,
    viewerRoot: roots.viewerRoot,
    authorization: {
      tokenFile,
      publicOrigin: options.publicOrigin ?? PUBLIC_ORIGIN,
      trustWindowsTokenFile: process.platform === "win32",
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.randomBytes === undefined
        ? {}
        : { randomBytes: options.randomBytes }),
    },
  });
  servers.push(server);
  return { roots, server, tokenFile };
}

function request(
  url: URL,
  options: {
    readonly method?: string;
    readonly host?: string;
    readonly headers?: http.OutgoingHttpHeaders;
    readonly body?: Buffer | string;
  } = {},
): Promise<ResponseSnapshot> {
  const hostname =
    url.hostname.startsWith("[") && url.hostname.endsWith("]")
      ? url.hostname.slice(1, -1)
      : url.hostname;
  const body =
    typeof options.body === "string"
      ? Buffer.from(options.body, "utf8")
      : options.body;
  return new Promise((resolve, reject) => {
    const outgoing = http.request(
      {
        hostname,
        port: Number(url.port),
        path: `${url.pathname}${url.search}`,
        method: options.method ?? "GET",
        headers: {
          ...options.headers,
          ...(options.host === undefined
            ? {}
            : { Host: options.host }),
          ...(body === undefined
            ? {}
            : { "Content-Length": body.byteLength }),
        },
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
      outgoing.destroy(new Error("Authorization request timed out.")),
    );
    outgoing.on("error", reject);
    if (body !== undefined) outgoing.write(body);
    outgoing.end();
  });
}

function bearer(token = TOKEN): http.OutgoingHttpHeaders {
  return { Authorization: `Bearer ${token}` };
}

function mutationHeaders(
  token = TOKEN,
): http.OutgoingHttpHeaders {
  return {
    ...bearer(token),
    "X-Code-City-Request": "1",
  };
}

function cookieFrom(response: ResponseSnapshot): string {
  const setCookie = response.headers["set-cookie"];
  expect(setCookie).toHaveLength(1);
  return setCookie![0]!.split(";", 1)[0]!;
}

function rawHeadersOnlyRequest(
  port: number,
  requestHead: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({
      host: "127.0.0.1",
      port,
    });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Raw authorization request timed out."));
    }, 2_000);
    const finish = (): void => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("latin1"));
    };
    socket.once("connect", () => socket.write(requestHead, "latin1"));
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.once("end", finish);
    socket.once("close", () => {
      if (chunks.length > 0) finish();
    });
    socket.once("error", reject);
  });
}

async function queuedJob(
  server: CodeCityServerHandle,
): Promise<JobRecord> {
  return server.jobs.enqueue(
    "authorization-test",
    ({ signal }) =>
      new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), {
          once: true,
        });
      }),
  );
}

afterEach(async () => {
  await Promise.allSettled(servers.splice(0).map((server) => server.close()));
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("trusted-network compatibility", () => {
  it("preserves open reads while exposing an explicit session capability", async () => {
    const roots = await fixture();
    const server = await startCodeCityServer({
      host: "127.0.0.1",
      port: 0,
      dataDirectory: roots.dataDirectory,
      viewerRoot: roots.viewerRoot,
    });
    servers.push(server);

    const status = await request(
      new URL("/api/v1/auth/session", server.url),
    );
    expect(status.status).toBe(200);
    expect(JSON.parse(status.body)).toEqual({
      authorization: {
        mode: "trusted-network",
        required: false,
        authenticated: false,
      },
    });
    expect(
      (await request(new URL("/api/v1/jobs", server.url))).status,
    ).toBe(200);

    const login = await request(
      new URL("/api/v1/auth/session", server.url),
      {
        method: "POST",
        headers: { "X-Code-City-Request": "1" },
      },
    );
    expect(login.status).toBe(409);

    const logout = await request(
      new URL("/api/v1/auth/session", server.url),
      {
        method: "DELETE",
        headers: { "X-Code-City-Request": "1" },
      },
    );
    expect(logout.status).toBe(204);
    expect(logout.headers["set-cookie"]?.[0]).toContain("Max-Age=0");
  });

  it("requires the mutation header for job cancellation in both modes", async () => {
    const roots = await fixture();
    const server = await startCodeCityServer({
      host: "127.0.0.1",
      port: 0,
      dataDirectory: roots.dataDirectory,
      viewerRoot: roots.viewerRoot,
    });
    servers.push(server);
    const job = await queuedJob(server);
    const url = new URL(`/api/v1/jobs/${job.id}`, server.url);

    const missing = await request(url, { method: "DELETE" });
    expect(missing.status).toBe(403);
    expect(JSON.parse(missing.body)).toMatchObject({
      error: { code: "request-header-required" },
    });

    const cancelled = await request(url, {
      method: "DELETE",
      headers: { "X-Code-City-Request": "1" },
    });
    expect(cancelled.status).toBe(200);
  });
});

describe("strict startup configuration", () => {
  it("parses authorization environment values without normalization", () => {
    expect(environmentAuthorizationTokenFile(undefined)).toBeUndefined();
    expect(environmentAuthorizationTokenFile("")).toBeUndefined();
    expect(
      environmentAuthorizationTokenFile("C:\\private\\token"),
    ).toBe("C:\\private\\token");
    expect(() =>
      environmentAuthorizationTokenFile(" /private/token"),
    ).toThrow("CODECITY_AUTH_TOKEN_FILE");

    expect(environmentPublicOrigin(undefined)).toBeUndefined();
    expect(environmentPublicOrigin("")).toBeUndefined();
    expect(environmentPublicOrigin(PUBLIC_ORIGIN)).toBe(PUBLIC_ORIGIN);
    expect(() => environmentPublicOrigin(`${PUBLIC_ORIGIN} `)).toThrow(
      "CODECITY_PUBLIC_ORIGIN",
    );

    expect(environmentWindowsAuthTokenFileTrust(undefined)).toBe(false);
    expect(environmentWindowsAuthTokenFileTrust("")).toBe(false);
    expect(environmentWindowsAuthTokenFileTrust("1")).toBe(true);
    expect(() => environmentWindowsAuthTokenFileTrust("true")).toThrow(
      "CODECITY_TRUST_WINDOWS_AUTH_TOKEN_FILE",
    );
  });

  it("fails authorization configuration before creating the data directory", async () => {
    const cases: readonly {
      readonly prepare?: (
        roots: Awaited<ReturnType<typeof fixture>>,
      ) => Promise<string | undefined>;
      readonly authorization: (
        tokenFile: string | undefined,
      ) => NonNullable<
        Parameters<typeof startCodeCityServer>[0]["authorization"]
      >;
    }[] = [
      {
        authorization: () => ({
          publicOrigin: PUBLIC_ORIGIN,
        }),
      },
      {
        authorization: () => ({
          trustWindowsTokenFile: true,
        }),
      },
      {
        authorization: () => ({
          tokenFile: "relative-token",
          publicOrigin: PUBLIC_ORIGIN,
        }),
      },
      {
        prepare: async (roots) => privateTokenFile(roots.root),
        authorization: (tokenFile) => ({
          tokenFile: tokenFile!,
        }),
      },
      {
        prepare: async (roots) => privateTokenFile(roots.root),
        authorization: (tokenFile) => ({
          tokenFile: tokenFile!,
          publicOrigin: "http://codecity.test",
          trustWindowsTokenFile: process.platform === "win32",
        }),
      },
      {
        prepare: async (roots) => privateTokenFile(roots.root),
        authorization: (tokenFile) => ({
          tokenFile: tokenFile!,
          publicOrigin: "https://a..b",
          trustWindowsTokenFile: process.platform === "win32",
        }),
      },
      {
        prepare: async (roots) => {
          const tokenFile = path.join(roots.root, "bad-token");
          await fs.writeFile(tokenFile, `secret-${TOKEN}\n`, {
            mode: 0o600,
          });
          if (process.platform !== "win32") {
            await fs.chmod(tokenFile, 0o600);
          }
          return tokenFile;
        },
        authorization: (tokenFile) => ({
          tokenFile: tokenFile!,
          publicOrigin: PUBLIC_ORIGIN,
          trustWindowsTokenFile: process.platform === "win32",
        }),
      },
    ];

    for (const entry of cases) {
      const roots = await fixture();
      const tokenFile = await entry.prepare?.(roots);
      await expect(
        startCodeCityServer({
          host: "127.0.0.1",
          port: 0,
          dataDirectory: roots.dataDirectory,
          viewerRoot: roots.viewerRoot,
          authorization: entry.authorization(tokenFile),
        }),
      ).rejects.toThrow(/CODECITY_/u);
      await expect(fs.stat(roots.dataDirectory)).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
  });

  it("rejects token directories, hard links, and oversized files", async () => {
    for (const kind of ["directory", "hard-link", "oversized"] as const) {
      const roots = await fixture();
      let tokenFile = path.join(roots.root, "token");
      if (kind === "directory") {
        await fs.mkdir(tokenFile);
      } else if (kind === "hard-link") {
        const source = await privateTokenFile(roots.root);
        tokenFile = path.join(roots.root, "authorization-link");
        await fs.link(source, tokenFile);
      } else {
        await fs.writeFile(tokenFile, "A".repeat(4_096), {
          mode: 0o600,
        });
        if (process.platform !== "win32") {
          await fs.chmod(tokenFile, 0o600);
        }
      }
      await expect(
        startCodeCityServer({
          host: "127.0.0.1",
          port: 0,
          dataDirectory: roots.dataDirectory,
          viewerRoot: roots.viewerRoot,
          authorization: {
            tokenFile,
            publicOrigin: PUBLIC_ORIGIN,
            trustWindowsTokenFile: process.platform === "win32",
          },
        }),
      ).rejects.toThrow(/private regular file|one token/u);
      await expect(fs.stat(roots.dataDirectory)).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
  });

  it.skipIf(process.platform === "win32")(
    "rejects a POSIX token readable by another identity",
    async () => {
      const roots = await fixture();
      const tokenFile = await privateTokenFile(roots.root);
      await fs.chmod(tokenFile, 0o644);
      await expect(
        startCodeCityServer({
          host: "127.0.0.1",
          port: 0,
          dataDirectory: roots.dataDirectory,
          viewerRoot: roots.viewerRoot,
          authorization: {
            tokenFile,
            publicOrigin: PUBLIC_ORIGIN,
          },
        }),
      ).rejects.toThrow(/0400 or 0600/u);
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects a symbolic-link token path",
    async () => {
      const roots = await fixture();
      const target = await privateTokenFile(roots.root);
      const tokenFile = path.join(roots.root, "token-link");
      await fs.symlink(target, tokenFile, "file");
      await expect(
        startCodeCityServer({
          host: "127.0.0.1",
          port: 0,
          dataDirectory: roots.dataDirectory,
          viewerRoot: roots.viewerRoot,
          authorization: {
            tokenFile,
            publicOrigin: PUBLIC_ORIGIN,
          },
        }),
      ).rejects.toThrow(/private regular file/u);
      await expect(fs.stat(roots.dataDirectory)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("requires the Windows ACL attestation before reading the token", async () => {
    const roots = await fixture();
    const tokenFile = await privateTokenFile(roots.root);
    await expect(
      startCodeCityServer({
        host: "127.0.0.1",
        port: 0,
        dataDirectory: roots.dataDirectory,
        viewerRoot: roots.viewerRoot,
        authorization: {
          tokenFile,
          publicOrigin: PUBLIC_ORIGIN,
          platform: "win32",
        },
      }),
    ).rejects.toThrow(/Windows.*ACL.*ancestry trust/iu);
    await expect(fs.stat(roots.dataDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("requires an explicit port in Host for a non-default public origin", async () => {
    const { server } = await authorizedServer({
      publicOrigin: "https://codecity.test:8443",
    });
    const url = new URL("/api/v1/jobs", server.url);
    expect(
      (
        await request(url, {
          host: AUTHORITY,
          headers: bearer(),
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await request(url, {
          host: `${AUTHORITY}:8443`,
          headers: bearer(),
        })
      ).status,
    ).toBe(200);
  });

  it("does not reinterpret an explicit HTTP Host port as the HTTPS default", async () => {
    const { server } = await authorizedServer();
    const url = new URL("/api/v1/jobs", server.url);
    expect(
      (
        await request(url, {
          host: `${AUTHORITY}:80`,
          headers: bearer(),
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await request(url, {
          host: `${AUTHORITY}:443`,
          headers: bearer(),
        })
      ).status,
    ).toBe(200);
  });
});

describe("shared-secret authorization", () => {
  it("keeps health and viewer public but protects every other API route", async () => {
    const { server } = await authorizedServer();

    const health = await request(
      new URL("/api/v1/health", server.url),
    );
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body)).toEqual({
      status: "ok",
      service: "code-city",
      apiVersion: "v1",
    });
    expect((await request(server.url)).status).toBe(200);

    const uuid = "00000000-0000-4000-8000-000000000000";
    for (const [method, pathName] of [
      ["GET", "/api"],
      ["GET", "/api/v1/jobs"],
      ["GET", `/api/v1/jobs/${uuid}`],
      ["DELETE", `/api/v1/jobs/${uuid}`],
      ["GET", `/api/v1/artifacts/${uuid}/city-model.json`],
      ["GET", `/api/v1/artifacts/${uuid}/evolution.json`],
      ["POST", "/api/v1/imports"],
      ["POST", "/api/v1/imports/uploads"],
      ["PUT", `/api/v1/imports/uploads/${uuid}`],
      ["DELETE", `/api/v1/imports/uploads/${uuid}`],
      ["GET", "/api/v1/not-a-route"],
    ] as const) {
      const unauthorized = await request(
        new URL(pathName, server.url),
        { method, host: AUTHORITY },
      );
      expect(unauthorized.status).toBe(401);
      expect(unauthorized.headers["www-authenticate"]).toBe(
        'Bearer realm="Code City"',
      );
      expect(JSON.parse(unauthorized.body)).toEqual({
        error: {
          code: "authorization-required",
          message: "Authorization is required.",
        },
      });
    }

    const healthMutation = await request(
      new URL("/api/v1/health", server.url),
      { method: "POST", host: AUTHORITY },
    );
    expect(healthMutation.status).toBe(401);

    const unexpectedBody = await request(
      new URL("/api/v1/jobs", server.url),
      {
        host: AUTHORITY,
        body: "not authorized",
      },
    );
    expect(unexpectedBody.status).toBe(401);
    expect(unexpectedBody.headers.connection).toBe("close");

    const authorized = await request(
      new URL("/api/v1/jobs", server.url),
      { host: AUTHORITY, headers: bearer() },
    );
    expect(authorized.status).toBe(200);

    const wrongAuthority = await request(
      new URL("/api/v1/jobs", server.url),
      { headers: bearer() },
    );
    expect(wrongAuthority.status).toBe(401);
  });

  it("rejects a slow unread import body immediately and closes its connection", async () => {
    const { server } = await authorizedServer();
    const response = await rawHeadersOnlyRequest(
      server.port,
      [
        "POST /api/v1/imports HTTP/1.1",
        `Host: ${AUTHORITY}`,
        "Content-Type: application/json",
        "Content-Length: 100000",
        "X-Code-City-Request: 1",
        "Connection: keep-alive",
        "",
        "",
      ].join("\r\n"),
    );
    expect(response).toMatch(/^HTTP\/1\.1 401 /u);
    expect(response).toContain("Connection: close");
    expect(response).toContain('"code":"authorization-required"');
  });

  it("returns one non-reflective failure for malformed or wrong bearer credentials", async () => {
    const { server } = await authorizedServer();
    const url = new URL("/api/v1/jobs", server.url);
    const credentials: readonly http.OutgoingHttpHeaders[] = [
      bearer(WRONG_TOKEN),
      { Authorization: "Basic secret" },
      { Authorization: "bearer secret" },
      { Authorization: `Bearer ${TOKEN} extra` },
      { Authorization: "Bearer A".repeat(100) },
      {
        Authorization: [
          `Bearer ${TOKEN}`,
          `Bearer ${TOKEN}`,
        ],
      },
    ];
    let canonicalBody: string | undefined;
    for (const headers of credentials) {
      const response = await request(url, {
        host: AUTHORITY,
        headers,
      });
      expect(response.status).toBe(401);
      canonicalBody ??= response.body;
      expect(response.body).toBe(canonicalBody);
      expect(response.body).not.toContain(TOKEN);
      expect(response.body).not.toContain(WRONG_TOKEN);
      expect(response.headers["set-cookie"]).toBeUndefined();
    }
  });

  it("rejects ambiguous cookies, Origins, and mutation headers", async () => {
    const { server } = await authorizedServer();
    const sessionUrl = new URL("/api/v1/auth/session", server.url);
    const login = await request(sessionUrl, {
      method: "POST",
      host: AUTHORITY,
      headers: mutationHeaders(),
    });
    const cookie = cookieFrom(login);
    const jobsUrl = new URL("/api/v1/jobs", server.url);

    for (const cookieHeader of [
      "codecity-session=invalid",
      `${cookie}; ${cookie}`,
      `${cookie}; codecity-session=invalid`,
    ]) {
      expect(
        (
          await request(jobsUrl, {
            host: AUTHORITY,
            headers: { Cookie: cookieHeader },
          })
        ).status,
      ).toBe(401);
    }

    const job = await queuedJob(server);
    const jobUrl = new URL(`/api/v1/jobs/${job.id}`, server.url);
    const duplicateOrigin = await request(jobUrl, {
      method: "DELETE",
      host: AUTHORITY,
      headers: {
        Cookie: cookie,
        "X-Code-City-Request": "1",
        Origin: [PUBLIC_ORIGIN, PUBLIC_ORIGIN],
      },
    });
    expect(duplicateOrigin.status).toBe(403);

    const duplicateMutationHeader = await request(jobUrl, {
      method: "DELETE",
      host: AUTHORITY,
      headers: {
        Cookie: cookie,
        "X-Code-City-Request": ["1", "1"],
        Origin: PUBLIC_ORIGIN,
      },
    });
    expect(duplicateMutationHeader.status).toBe(403);
  });

  it("exchanges the bearer for an opaque secure session and revokes it", async () => {
    const { server } = await authorizedServer();
    const sessionUrl = new URL(
      "/api/v1/auth/session",
      server.url,
    );

    const anonymous = await request(sessionUrl, {
      host: AUTHORITY,
    });
    expect(anonymous.status).toBe(200);
    expect(JSON.parse(anonymous.body)).toEqual({
      authorization: {
        mode: "shared-secret",
        required: true,
        authenticated: false,
      },
    });
    expect(anonymous.headers["set-cookie"]).toBeUndefined();

    const missingCsrf = await request(sessionUrl, {
      method: "POST",
      host: AUTHORITY,
      headers: bearer(),
    });
    expect(missingCsrf.status).toBe(403);

    const wrong = await request(sessionUrl, {
      method: "POST",
      host: AUTHORITY,
      headers: mutationHeaders(WRONG_TOKEN),
    });
    expect(wrong.status).toBe(401);
    expect(wrong.body).not.toContain(WRONG_TOKEN);

    const crossOrigin = await request(sessionUrl, {
      method: "POST",
      host: AUTHORITY,
      headers: {
        ...mutationHeaders(),
        Origin: "https://attacker.example",
      },
    });
    expect(crossOrigin.status).toBe(403);

    const login = await request(sessionUrl, {
      method: "POST",
      host: AUTHORITY,
      headers: {
        ...mutationHeaders(),
        Origin: PUBLIC_ORIGIN,
      },
    });
    expect(login.status).toBe(204);
    expect(login.body).toBe("");
    const setCookie = login.headers["set-cookie"]![0]!;
    expect(setCookie).toMatch(/^codecity-session=[A-Za-z0-9_-]{43};/u);
    expect(setCookie).toContain("Path=/api/v1");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Max-Age=28800");
    expect(setCookie).toContain("Secure");
    expect(setCookie).not.toContain(TOKEN);
    const cookie = cookieFrom(login);

    const authenticated = await request(sessionUrl, {
      host: AUTHORITY,
      headers: { Cookie: cookie },
    });
    expect(JSON.parse(authenticated.body)).toEqual({
      authorization: {
        mode: "shared-secret",
        required: true,
        authenticated: true,
      },
    });
    expect(
      (
        await request(new URL("/api/v1/jobs", server.url), {
          host: AUTHORITY,
          headers: { Cookie: cookie },
        })
      ).status,
    ).toBe(200);

    const logoutWithoutOrigin = await request(sessionUrl, {
      method: "DELETE",
      host: AUTHORITY,
      headers: {
        Cookie: cookie,
        "X-Code-City-Request": "1",
      },
    });
    expect(logoutWithoutOrigin.status).toBe(403);

    const logout = await request(sessionUrl, {
      method: "DELETE",
      host: AUTHORITY,
      headers: {
        Cookie: cookie,
        Origin: PUBLIC_ORIGIN,
        "X-Code-City-Request": "1",
      },
    });
    expect(logout.status).toBe(204);
    expect(logout.headers["set-cookie"]?.[0]).toContain("Max-Age=0");
    expect(
      (
        await request(new URL("/api/v1/jobs", server.url), {
          host: AUTHORITY,
          headers: { Cookie: cookie },
        })
      ).status,
    ).toBe(401);
  });

  it("requires same-origin proof and the mutation header for cookie mutations", async () => {
    const { server } = await authorizedServer();
    const login = await request(
      new URL("/api/v1/auth/session", server.url),
      {
        method: "POST",
        host: AUTHORITY,
        headers: mutationHeaders(),
      },
    );
    const cookie = cookieFrom(login);
    const job = await queuedJob(server);
    const jobUrl = new URL(`/api/v1/jobs/${job.id}`, server.url);

    for (const headers of [
      { Cookie: cookie },
      {
        Cookie: cookie,
        "X-Code-City-Request": "1",
      },
      {
        Cookie: cookie,
        "X-Code-City-Request": "1",
        Origin: "null",
      },
      {
        Cookie: cookie,
        "X-Code-City-Request": "1",
        Origin: "https://attacker.example",
      },
    ]) {
      const rejected = await request(jobUrl, {
        method: "DELETE",
        host: AUTHORITY,
        headers,
      });
      expect(rejected.status).toBe(403);
    }

    const accepted = await request(jobUrl, {
      method: "DELETE",
      host: AUTHORITY,
      headers: {
        Cookie: cookie,
        "X-Code-City-Request": "1",
        Origin: PUBLIC_ORIGIN,
      },
    });
    expect(accepted.status).toBe(200);
    expect(JSON.parse(accepted.body)).toMatchObject({
      job: { state: "cancelled" },
    });
  });

  it("allows bearer automation without Origin but rejects a supplied foreign Origin", async () => {
    const { server } = await authorizedServer();
    const importUrl = new URL("/api/v1/imports", server.url);
    const body = JSON.stringify({});

    const noOrigin = await request(importUrl, {
      method: "POST",
      host: AUTHORITY,
      headers: {
        ...mutationHeaders(),
        "Content-Type": "application/json",
      },
      body,
    });
    expect(noOrigin.status).toBe(400);
    expect(JSON.parse(noOrigin.body)).toMatchObject({
      error: { code: "invalid-import-request" },
    });

    const foreign = await request(importUrl, {
      method: "POST",
      host: AUTHORITY,
      headers: {
        ...mutationHeaders(),
        "Content-Type": "application/json",
        Origin: "https://attacker.example",
      },
      body,
    });
    expect(foreign.status).toBe(403);
    expect(JSON.parse(foreign.body)).toMatchObject({
      error: { code: "request-origin-rejected" },
    });
  });

  it("expires sessions and invalidates them across restart", async () => {
    let now = Date.parse("2026-07-30T00:00:00.000Z");
    const { roots, server, tokenFile } = await authorizedServer({
      now: () => now,
    });
    const login = await request(
      new URL("/api/v1/auth/session", server.url),
      {
        method: "POST",
        host: AUTHORITY,
        headers: mutationHeaders(),
      },
    );
    const cookie = cookieFrom(login);
    const jobsUrl = new URL("/api/v1/jobs", server.url);
    expect(
      (
        await request(jobsUrl, {
          host: AUTHORITY,
          headers: { Cookie: cookie },
        })
      ).status,
    ).toBe(200);

    now += 8 * 60 * 60 * 1_000;
    expect(
      (
        await request(jobsUrl, {
          host: AUTHORITY,
          headers: { Cookie: cookie },
        })
      ).status,
    ).toBe(401);

    await server.close();
    const restarted = await startCodeCityServer({
      host: "127.0.0.1",
      port: 0,
      dataDirectory: roots.dataDirectory,
      viewerRoot: roots.viewerRoot,
      authorization: {
        tokenFile,
        publicOrigin: PUBLIC_ORIGIN,
        trustWindowsTokenFile: process.platform === "win32",
      },
    });
    servers.push(restarted);
    expect(
      (
        await request(new URL("/api/v1/jobs", restarted.url), {
          host: AUTHORITY,
          headers: { Cookie: cookie },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await request(new URL("/api/v1/jobs", restarted.url), {
          host: AUTHORITY,
          headers: bearer(),
        })
      ).status,
    ).toBe(200);
  });

  it("bounds sessions and evicts the oldest capability", async () => {
    let sequence = 0;
    const { server } = await authorizedServer({
      randomBytes: () => Buffer.alloc(32, ++sequence),
    });
    const sessionUrl = new URL(
      "/api/v1/auth/session",
      server.url,
    );
    let firstCookie = "";
    let lastCookie = "";
    for (let index = 0; index < 65; index += 1) {
      const login = await request(sessionUrl, {
        method: "POST",
        host: AUTHORITY,
        headers: mutationHeaders(),
      });
      expect(login.status).toBe(204);
      const cookie = cookieFrom(login);
      if (index === 0) firstCookie = cookie;
      lastCookie = cookie;
    }
    const jobsUrl = new URL("/api/v1/jobs", server.url);
    expect(
      (
        await request(jobsUrl, {
          host: AUTHORITY,
          headers: { Cookie: firstCookie },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await request(jobsUrl, {
          host: AUTHORITY,
          headers: { Cookie: lastCookie },
        })
      ).status,
    ).toBe(200);
  });

  it("fails closed after bounded repeated session randomness", async () => {
    const repeated = Buffer.alloc(32, 0x33);
    const { server } = await authorizedServer({
      randomBytes: () => Buffer.from(repeated),
    });
    const sessionUrl = new URL(
      "/api/v1/auth/session",
      server.url,
    );
    const first = await request(sessionUrl, {
      method: "POST",
      host: AUTHORITY,
      headers: mutationHeaders(),
    });
    expect(first.status).toBe(204);

    const collision = await request(sessionUrl, {
      method: "POST",
      host: AUTHORITY,
      headers: mutationHeaders(),
    });
    expect(collision.status).toBe(503);
    expect(collision.headers["set-cookie"]).toBeUndefined();
    expect(JSON.parse(collision.body)).toEqual({
      error: {
        code: "authorization-session-unavailable",
        message: "An authorization session could not be created.",
      },
    });
    expect(collision.body).not.toContain(
      repeated.toString("base64url"),
    );
  });

  it("supports an explicitly loopback-only HTTP development origin", async () => {
    const roots = await fixture();
    const tokenFile = await privateTokenFile(roots.root);
    const server = await startCodeCityServer({
      host: "127.0.0.1",
      port: 0,
      dataDirectory: roots.dataDirectory,
      viewerRoot: roots.viewerRoot,
      authorization: {
        tokenFile,
        publicOrigin: "http://127.0.0.1",
        trustWindowsTokenFile: process.platform === "win32",
      },
    });
    servers.push(server);
    const login = await request(
      new URL("/api/v1/auth/session", server.url),
      {
        method: "POST",
        host: "127.0.0.1",
        headers: mutationHeaders(),
      },
    );
    expect(login.status).toBe(204);
    expect(login.headers["set-cookie"]?.[0]).not.toContain("Secure");
  });
});
