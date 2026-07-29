import http, {
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import net from "node:net";
import path from "node:path";

import {
  collectViewerAssets,
  resolveProductionViewerRoot,
  type ViewerAsset,
} from "../../cli/src/open-server.js";
import {
  PersistentJobQueue,
  type JobRecord,
} from "./job-queue.js";

const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_PORT = 3_000;
const MAXIMUM_REQUEST_TARGET_CHARACTERS = 2_048;
const JOB_PATH_PATTERN =
  /^\/api\/v1\/jobs\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u;

const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob:",
  "connect-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "font-src 'none'",
  "media-src 'none'",
  "manifest-src 'self'",
  "frame-ancestors 'none'",
].join("; ");

export interface CodeCityServerOptions {
  readonly host?: string;
  readonly port?: number;
  readonly dataDirectory: string;
  readonly viewerRoot?: string;
  readonly allowedHosts?: readonly string[];
  readonly signal?: AbortSignal;
}

export interface CodeCityServerHandle {
  readonly host: string;
  readonly port: number;
  readonly url: URL;
  readonly jobs: PersistentJobQueue;
  readonly closed: Promise<void>;
  close(): Promise<void>;
}

interface ParsedTarget {
  readonly path: string;
}

function productionViewerRoot(): string {
  return resolveProductionViewerRoot(import.meta.url);
}

function validPort(port: number | undefined): number {
  const value = port ?? DEFAULT_PORT;
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 65_535
  ) {
    throw new Error("Server port must be 0 or an integer from 1 to 65535.");
  }
  return value;
}

function validHost(host: string | undefined): string {
  const value = host ?? DEFAULT_HOST;
  if (
    value.length === 0 ||
    value.length > 255 ||
    /[\u0000-\u0020\u007F/%\\]/u.test(value)
  ) {
    throw new Error("Server host is invalid.");
  }
  return value;
}

function normalizeHostname(hostname: string): string {
  const unwrapped =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;
  const normalized = unwrapped.toLowerCase();
  if (net.isIP(normalized) !== 0) return normalized;
  if (
    normalized.length === 0 ||
    normalized.length > 253 ||
    normalized.includes("..") ||
    !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(normalized)
  ) {
    throw new Error("Allowed server hostname is invalid.");
  }
  return normalized;
}

function allowedHostnames(
  bindHost: string,
  configured: readonly string[] | undefined,
): ReadonlySet<string> {
  const result = new Set<string>(["localhost"]);
  if (bindHost !== "0.0.0.0" && bindHost !== "::") {
    result.add(normalizeHostname(bindHost));
  }
  for (const hostname of configured ?? []) {
    result.add(normalizeHostname(hostname));
  }
  return result;
}

function hostHeaderIsAllowed(
  request: IncomingMessage,
  allowed: ReadonlySet<string>,
): boolean {
  let count = 0;
  let value: string | undefined;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === "host") {
      count += 1;
      value = request.rawHeaders[index + 1];
    }
  }
  if (
    count !== 1 ||
    value === undefined ||
    value.length === 0 ||
    value.length > 255 ||
    /[\u0000-\u0020\u007F/@%?#\\]/u.test(value)
  ) {
    return false;
  }
  try {
    const parsed = new URL(`http://${value}`);
    if (
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.pathname === "/" &&
      parsed.search === "" &&
      parsed.hash === ""
    ) {
      const hostname = normalizeHostname(parsed.hostname);
      return net.isIP(hostname) !== 0 || allowed.has(hostname);
    }
    return false;
  } catch {
    return false;
  }
}

function parseTarget(rawTarget: string | undefined): ParsedTarget | undefined {
  if (
    rawTarget === undefined ||
    rawTarget.length === 0 ||
    rawTarget.length > MAXIMUM_REQUEST_TARGET_CHARACTERS ||
    !rawTarget.startsWith("/") ||
    rawTarget.startsWith("//") ||
    rawTarget.includes("%") ||
    /[\u0000-\u001F\u007F\\]/u.test(rawTarget)
  ) {
    return undefined;
  }
  const queryIndex = rawTarget.indexOf("?");
  if (queryIndex >= 0 && queryIndex !== rawTarget.length - 1) {
    return undefined;
  }
  const rawPath =
    queryIndex < 0 ? rawTarget : rawTarget.slice(0, queryIndex);
  const segments = rawPath.split("/").slice(1);
  if (
    segments.some(
      (segment, index) =>
        segment === "." ||
        segment === ".." ||
        (segment === "" && index !== segments.length - 1),
    )
  ) {
    return undefined;
  }
  return { path: rawPath };
}

function securityHeaders(
  response: ServerResponse,
  contentType: string,
  cacheControl: string,
): void {
  response.setHeader("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Cache-Control", cacheControl);
  response.setHeader("Content-Type", contentType);
}

function send(
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  body: Buffer | string,
  contentType: string,
  cacheControl = "no-store",
): void {
  const bytes = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  response.statusCode = status;
  securityHeaders(response, contentType, cacheControl);
  response.setHeader("Content-Length", bytes.byteLength);
  if (request.method === "HEAD") response.end();
  else response.end(bytes);
}

function sendJson(
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  send(
    request,
    response,
    status,
    `${JSON.stringify(value)}\n`,
    "application/json; charset=utf-8",
  );
}

function sendMethodNotAllowed(
  request: IncomingMessage,
  response: ServerResponse,
  methods: readonly string[],
): void {
  response.setHeader("Allow", methods.join(", "));
  send(
    request,
    response,
    405,
    "Method not allowed.\n",
    "text/plain; charset=utf-8",
  );
}

function publicJob(record: JobRecord): JobRecord {
  return record;
}

function apiHandler(
  request: IncomingMessage,
  response: ServerResponse,
  target: ParsedTarget,
  jobs: PersistentJobQueue,
): boolean {
  if (target.path === "/api/v1/health") {
    if (request.method !== "GET" && request.method !== "HEAD") {
      sendMethodNotAllowed(request, response, ["GET", "HEAD"]);
      return true;
    }
    sendJson(request, response, 200, {
      status: "ok",
      service: "code-city",
      apiVersion: "v1",
    });
    return true;
  }
  if (target.path === "/api/v1/jobs") {
    if (request.method !== "GET" && request.method !== "HEAD") {
      sendMethodNotAllowed(request, response, ["GET", "HEAD"]);
      return true;
    }
    sendJson(request, response, 200, {
      jobs: jobs.list().map(publicJob),
    });
    return true;
  }
  const match = JOB_PATH_PATTERN.exec(target.path);
  if (!match) return false;
  const id = match[1]!;
  if (request.method === "DELETE") {
    void jobs.cancel(id).then(
      (job) => {
        if (response.destroyed) return;
        if (!job) {
          sendJson(request, response, 404, {
            error: { code: "job-not-found", message: "Job not found." },
          });
          return;
        }
        sendJson(request, response, 200, { job: publicJob(job) });
      },
      () => {
        if (!response.destroyed) {
          sendJson(request, response, 500, {
            error: {
              code: "job-cancel-failed",
              message: "The job could not be cancelled.",
            },
          });
        }
      },
    );
    return true;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendMethodNotAllowed(request, response, ["GET", "HEAD", "DELETE"]);
    return true;
  }
  const job = jobs.get(id);
  if (!job) {
    sendJson(request, response, 404, {
      error: { code: "job-not-found", message: "Job not found." },
    });
    return true;
  }
  sendJson(request, response, 200, { job: publicJob(job) });
  return true;
}

function staticHandler(
  request: IncomingMessage,
  response: ServerResponse,
  target: ParsedTarget,
  assets: ReadonlyMap<string, ViewerAsset>,
): void {
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendMethodNotAllowed(request, response, ["GET", "HEAD"]);
    return;
  }
  const assetPath =
    target.path === "/" || target.path === "/index.html"
      ? "/index.html"
      : target.path;
  const asset = assets.get(assetPath);
  if (!asset) {
    send(request, response, 404, "Not found.\n", "text/plain; charset=utf-8");
    return;
  }
  if (!asset.contentType) {
    send(
      request,
      response,
      415,
      "Unsupported media type.\n",
      "text/plain; charset=utf-8",
    );
    return;
  }
  const immutable =
    assetPath.startsWith("/assets/") &&
    /\.[A-Za-z0-9_-]{8,}\./u.test(path.basename(assetPath));
  send(
    request,
    response,
    200,
    asset.body,
    asset.contentType,
    immutable ? "public, max-age=31536000, immutable" : "no-cache",
  );
}

function requestHandler(
  assets: ReadonlyMap<string, ViewerAsset>,
  jobs: PersistentJobQueue,
  allowedHosts: ReadonlySet<string>,
): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
    if (!hostHeaderIsAllowed(request, allowedHosts)) {
      send(request, response, 400, "Bad request.\n", "text/plain; charset=utf-8");
      return;
    }
    const target = parseTarget(request.url);
    if (!target) {
      send(request, response, 400, "Bad request.\n", "text/plain; charset=utf-8");
      return;
    }
    if (target.path.startsWith("/api/")) {
      if (!apiHandler(request, response, target, jobs)) {
        sendJson(request, response, 404, {
          error: { code: "not-found", message: "API endpoint not found." },
        });
      }
      return;
    }
    staticHandler(request, response, target, assets);
  };
}

function listen(
  server: http.Server,
  host: string,
  port: number,
  signal?: AbortSignal,
): Promise<number> {
  if (signal?.aborted) throw new Error("Server startup was aborted.");
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      server.off("error", onError);
      server.off("listening", onListening);
      signal?.removeEventListener("abort", onAbort);
    };
    const onError = (): void => {
      cleanup();
      reject(new Error("Code City could not bind its web server."));
    };
    const onListening = (): void => {
      cleanup();
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Code City returned an invalid server address."));
        return;
      }
      resolve(address.port);
    };
    const onAbort = (): void => {
      cleanup();
      reject(new Error("Server startup was aborted."));
    };
    server.once("error", onError);
    server.once("listening", onListening);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    server.listen({ host, port, exclusive: true });
  });
}

function serverWasNotRunning(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "ERR_SERVER_NOT_RUNNING"
  );
}

export async function startCodeCityServer(
  options: CodeCityServerOptions,
): Promise<CodeCityServerHandle> {
  const host = validHost(options.host);
  const requestedPort = validPort(options.port);
  if (options.signal?.aborted) throw new Error("Server startup was aborted.");
  const assets = await collectViewerAssets(
    options.viewerRoot ?? productionViewerRoot(),
  );
  const jobs = await PersistentJobQueue.open({
    dataDirectory: options.dataDirectory,
    concurrency: 1,
  });
  const allowedHosts = allowedHostnames(host, options.allowedHosts);
  const server = http.createServer(
    requestHandler(assets, jobs, allowedHosts),
  );
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 64;

  let closed = false;
  let resolveClosed: (() => void) | undefined;
  const closedPromise = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  server.once("close", () => {
    closed = true;
    resolveClosed?.();
  });

  const close = async (): Promise<void> => {
    if (closed) return closedPromise;
    await jobs.close();
    try {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error && !serverWasNotRunning(error)) reject(error);
          else resolve();
        });
        server.closeAllConnections();
      });
    } catch (error) {
      if (!serverWasNotRunning(error)) throw error;
    }
    if (!closed) {
      closed = true;
      resolveClosed?.();
    }
    await closedPromise;
  };

  const onAbort = (): void => {
    void close();
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const port = await listen(server, host, requestedPort, options.signal);
    if (options.signal?.aborted) {
      await close();
      throw new Error("Server startup was aborted.");
    }
    const displayHost =
      host === "0.0.0.0" || host === "::" ? "localhost" : host;
    const urlHost =
      net.isIP(displayHost) === 6 ? `[${displayHost}]` : displayHost;
    return {
      host,
      port,
      url: new URL(`http://${urlHost}:${port}/`),
      jobs,
      closed: closedPromise,
      close: async () => {
        options.signal?.removeEventListener("abort", onAbort);
        await close();
      },
    };
  } catch (error) {
    options.signal?.removeEventListener("abort", onAbort);
    await close().catch(() => undefined);
    throw error;
  }
}
