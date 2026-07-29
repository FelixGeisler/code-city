import { promises as fs } from "node:fs";
import http, {
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  analyzeLocalRepositories,
  type LocalAnalysisOptions,
} from "../../../packages/analyzer/src/index.js";
import { CLI_JSON_LIMITS } from "./json-file.js";

const LOOPBACK_HOST = "127.0.0.1";
const MODEL_PATH = "/__codecity/model.json";
const MAX_ASSET_FILES = 4_096;
const MAX_ASSET_BYTES = 64 * 1024 * 1024;
const MAX_REQUEST_TARGET_CHARACTERS = 2_048;

const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob:",
  "connect-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "font-src 'none'",
  "media-src 'none'",
  "manifest-src 'none'",
].join("; ");

const MIME_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".svg", "image/svg+xml; charset=utf-8"],
]);

interface ViewerAsset {
  readonly body: Buffer;
  readonly contentType?: string;
}

export interface LocalOpenServerOptions {
  readonly roots: readonly string[];
  readonly port?: number;
  readonly viewerRoot?: string;
  readonly signal?: AbortSignal;
  readonly analysis?: Omit<LocalAnalysisOptions, "signal">;
}

export interface LocalOpenServerHandle {
  readonly url: URL;
  readonly modelUrl: URL;
  readonly closed: Promise<void>;
  close(): Promise<void>;
}

export function resolveProductionViewerRoot(
  moduleUrl: string | URL,
): string {
  return path.resolve(
    fileURLToPath(new URL("../../../../viewer/", moduleUrl)),
  );
}

function productionViewerRoot(): string {
  return resolveProductionViewerRoot(import.meta.url);
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

async function collectViewerAssets(
  requestedRoot: string,
): Promise<ReadonlyMap<string, ViewerAsset>> {
  try {
    const absoluteRoot = path.resolve(requestedRoot);
    const rootStatus = await fs.lstat(absoluteRoot);
    if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink()) {
      throw new Error();
    }
    const root = await fs.realpath(absoluteRoot);
    const assets = new Map<string, ViewerAsset>();
    let totalBytes = 0;
    let visitedEntries = 0;

    async function visit(directory: string, relativeDirectory: string): Promise<void> {
      const entries = await fs.readdir(directory, { withFileTypes: true });
      entries.sort((left, right) =>
        left.name.localeCompare(right.name, "en-US"),
      );
      for (const entry of entries) {
        visitedEntries += 1;
        if (visitedEntries > MAX_ASSET_FILES) throw new Error();
        if (entry.isSymbolicLink()) throw new Error();
        const relative = relativeDirectory
          ? path.join(relativeDirectory, entry.name)
          : entry.name;
        const candidate = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          await visit(candidate, relative);
          continue;
        }
        if (!entry.isFile()) throw new Error();
        if (assets.size >= MAX_ASSET_FILES) throw new Error();
        const status = await fs.lstat(candidate);
        const real = await fs.realpath(candidate);
        if (
          !status.isFile() ||
          status.isSymbolicLink() ||
          !isWithin(root, real)
        ) {
          throw new Error();
        }
        if (
          !Number.isSafeInteger(status.size) ||
          status.size < 0 ||
          status.size > MAX_ASSET_BYTES - totalBytes
        ) {
          throw new Error();
        }
        const body = await fs.readFile(real);
        if (body.byteLength !== status.size) throw new Error();
        totalBytes += body.byteLength;
        if (totalBytes > MAX_ASSET_BYTES) throw new Error();
        const requestPath = `/${relative.split(path.sep).join("/")}`;
        const contentType = MIME_TYPES.get(
          path.extname(entry.name).toLocaleLowerCase("en-US"),
        );
        assets.set(requestPath, {
          body,
          ...(contentType === undefined ? {} : { contentType }),
        });
      }
    }

    await visit(root, "");
    const index = assets.get("/index.html");
    if (!index || index.contentType !== MIME_TYPES.get(".html")) {
      throw new Error();
    }
    return assets;
  } catch {
    throw new Error(
      "Production viewer assets are unavailable. Run 'npm run viewer:build' first.",
    );
  }
}

function validPort(port: number | undefined): number {
  const value = port ?? 0;
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 65_535
  ) {
    throw new Error("Open-server port must be 0 or an integer from 1 to 65535.");
  }
  return value;
}

function boundedJsonBuffer(value: unknown, maximumBytes: number): Buffer {
  let bytes = 0;
  const active = new WeakSet<object>();
  const add = (count: number): void => {
    bytes += count;
    if (bytes > maximumBytes) {
      throw new Error(
        "The analyzed city model exceeds the local viewer's 128 MiB limit.",
      );
    }
  };
  const visit = (item: unknown, inArray = false): void => {
    if (item === null) {
      add(4);
      return;
    }
    if (
      item === undefined ||
      typeof item === "function" ||
      typeof item === "symbol"
    ) {
      if (inArray) add(4);
      return;
    }
    if (typeof item !== "object") {
      const encoded = JSON.stringify(item);
      if (encoded === undefined) throw new Error("City model is not JSON-safe.");
      add(Buffer.byteLength(encoded, "utf8"));
      return;
    }
    if (active.has(item)) throw new Error("City model is not JSON-safe.");
    active.add(item);
    if (Array.isArray(item)) {
      add(2);
      item.forEach((entry, index) => {
        if (index > 0) add(1);
        visit(entry, true);
      });
    } else {
      add(2);
      let emitted = 0;
      for (const [key, entry] of Object.entries(item)) {
        if (
          entry === undefined ||
          typeof entry === "function" ||
          typeof entry === "symbol"
        ) {
          continue;
        }
        if (emitted > 0) add(1);
        add(Buffer.byteLength(JSON.stringify(key), "utf8") + 1);
        visit(entry);
        emitted += 1;
      }
    }
    active.delete(item);
  };
  visit(value);
  const result = Buffer.from(JSON.stringify(value), "utf8");
  if (result.byteLength !== bytes || result.byteLength > maximumBytes) {
    throw new Error("City model is not JSON-safe.");
  }
  return result;
}

function securityHeaders(
  response: ServerResponse,
  contentType: string,
  cacheControl = "no-cache",
): void {
  response.setHeader("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("Cache-Control", cacheControl);
  response.setHeader("Content-Type", contentType);
}

function send(
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  body: Buffer | string,
  contentType: string,
  cacheControl?: string,
): void {
  const bytes = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  response.statusCode = status;
  securityHeaders(response, contentType, cacheControl);
  response.setHeader("Content-Length", bytes.byteLength);
  if (request.method === "HEAD") response.end();
  else response.end(bytes);
}

function hostHeaderIsValid(request: IncomingMessage, expected: string): boolean {
  let count = 0;
  let value: string | undefined;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLocaleLowerCase("en-US") === "host") {
      count += 1;
      value = request.rawHeaders[index + 1];
    }
  }
  return count === 1 && value === expected;
}

function requestPath(
  rawTarget: string | undefined,
): { readonly path: string; readonly modelQuery: boolean } | undefined {
  if (
    rawTarget === undefined ||
    rawTarget.length === 0 ||
    rawTarget.length > MAX_REQUEST_TARGET_CHARACTERS ||
    !rawTarget.startsWith("/") ||
    rawTarget.startsWith("//") ||
    /[\u0000-\u001F\u007F\\]/u.test(rawTarget)
  ) {
    return undefined;
  }
  const queryIndex = rawTarget.indexOf("?");
  const rawPath =
    queryIndex < 0 ? rawTarget : rawTarget.slice(0, queryIndex);
  if (rawPath.includes("%")) return undefined;
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
  const search = queryIndex < 0 ? "" : rawTarget.slice(queryIndex + 1);
  if (search === "") return { path: rawPath, modelQuery: false };
  if (rawPath !== "/" && rawPath !== "/index.html") return undefined;
  const parameters = new URLSearchParams(search);
  if (
    [...parameters.keys()].length !== 1 ||
    parameters.get("model") !== MODEL_PATH
  ) {
    return undefined;
  }
  return { path: rawPath, modelQuery: true };
}

function requestHandler(
  assets: ReadonlyMap<string, ViewerAsset>,
  model: Buffer,
  port: number,
): (request: IncomingMessage, response: ServerResponse) => void {
  const expectedHost =
    port === 80 ? LOOPBACK_HOST : `${LOOPBACK_HOST}:${port}`;
  return (request, response) => {
    if (!hostHeaderIsValid(request, expectedHost)) {
      send(request, response, 400, "Bad request.\n", "text/plain; charset=utf-8");
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.setHeader("Allow", "GET, HEAD");
      send(
        request,
        response,
        405,
        "Method not allowed.\n",
        "text/plain; charset=utf-8",
      );
      return;
    }
    const target = requestPath(request.url);
    if (!target) {
      send(request, response, 400, "Bad request.\n", "text/plain; charset=utf-8");
      return;
    }
    if (target.path === MODEL_PATH && !target.modelQuery) {
      send(
        request,
        response,
        200,
        model,
        "application/json; charset=utf-8",
        "no-store",
      );
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
    send(request, response, 200, asset.body, asset.contentType);
  };
}

function listen(
  server: http.Server,
  port: number,
  signal?: AbortSignal,
): Promise<number> {
  if (signal?.aborted) {
    throw new Error("Local viewer startup was aborted.");
  }
  return new Promise((resolve, reject) => {
    const onError = (): void => {
      cleanup();
      reject(new Error("The local viewer could not bind to loopback."));
    };
    const onListening = (): void => {
      cleanup();
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("The local viewer returned an invalid address."));
        return;
      }
      resolve(address.port);
    };
    const onAbort = (): void => {
      cleanup();
      reject(new Error("Local viewer startup was aborted."));
    };
    const cleanup = (): void => {
      server.off("error", onError);
      server.off("listening", onListening);
      signal?.removeEventListener("abort", onAbort);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    server.listen({ host: LOOPBACK_HOST, port, exclusive: true });
  });
}

function serverWasNotRunning(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "ERR_SERVER_NOT_RUNNING"
  );
}

export async function startLocalOpenServer(
  options: LocalOpenServerOptions,
): Promise<LocalOpenServerHandle> {
  if (options.roots.length === 0) {
    throw new Error("The open command requires at least one local root.");
  }
  if (options.signal?.aborted) {
    throw new Error("Local viewer startup was aborted.");
  }
  const assets = await collectViewerAssets(
    options.viewerRoot ?? productionViewerRoot(),
  );
  const model = await analyzeLocalRepositories(options.roots, {
    ...options.analysis,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const modelBytes = boundedJsonBuffer(
    model,
    CLI_JSON_LIMITS.cityModelBytes,
  );
  const server = http.createServer();
  server.requestTimeout = 5_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 1_000;
  server.maxHeadersCount = 32;

  let activeHandler:
    | ((request: IncomingMessage, response: ServerResponse) => void)
    | undefined;
  server.on("request", (request, response) => {
    if (activeHandler) {
      activeHandler(request, response);
      return;
    }
    send(
      request,
      response,
      503,
      "Viewer starting.\n",
      "text/plain; charset=utf-8",
      "no-store",
    );
  });

  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  let closePromise: Promise<void> | undefined;
  let listenStarted = false;
  let shutdownRequested = false;
  let sigintInstalled = false;
  let sigtermInstalled = false;
  let abortInstalled = false;
  const startup = new AbortController();
  const cleanup = (): void => {
    if (sigintInstalled) {
      sigintInstalled = false;
      process.off("SIGINT", onShutdown);
    }
    if (sigtermInstalled) {
      sigtermInstalled = false;
      process.off("SIGTERM", onShutdown);
    }
    if (abortInstalled) {
      abortInstalled = false;
      options.signal?.removeEventListener("abort", onShutdown);
    }
  };
  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    cleanup();
    startup.abort();
    closePromise = new Promise<void>((resolve, reject) => {
      const finish = (error?: Error): void => {
        if (error && !serverWasNotRunning(error)) {
          reject(new Error("The local viewer did not close cleanly."));
          return;
        }
        resolveClosed();
        resolve();
      };
      if (!listenStarted) {
        finish();
        return;
      }
      try {
        server.close(finish);
        server.closeAllConnections();
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    return closePromise;
  };
  function onShutdown(): void {
    shutdownRequested = true;
    void close().catch(() => undefined);
  }
  server.once("close", () => {
    cleanup();
    resolveClosed();
  });

  let port: number;
  try {
    process.once("SIGINT", onShutdown);
    sigintInstalled = true;
    process.once("SIGTERM", onShutdown);
    sigtermInstalled = true;
    if (options.signal) {
      options.signal.addEventListener("abort", onShutdown, {
        once: true,
      });
      abortInstalled = true;
    }
    if (options.signal?.aborted) onShutdown();
    if (shutdownRequested) {
      throw new Error("Local viewer startup was aborted.");
    }
    listenStarted = true;
    port = await listen(
      server,
      validPort(options.port),
      startup.signal,
    );
    if (shutdownRequested) {
      await close();
      throw new Error("Local viewer startup was aborted.");
    }
  } catch (error) {
    cleanup();
    await close().catch(() => undefined);
    throw error;
  }
  activeHandler = requestHandler(assets, modelBytes, port);

  const origin = `http://${LOOPBACK_HOST}:${port}`;
  const modelUrl = new URL(MODEL_PATH, origin);
  const url = new URL("/", origin);
  url.searchParams.set("model", MODEL_PATH);
  return { url, modelUrl, closed, close };
}
