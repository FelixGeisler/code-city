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

function productionViewerRoot(): string {
  return fileURLToPath(new URL("../../../../viewer/", import.meta.url));
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
  const expectedHost = `${LOOPBACK_HOST}:${port}`;
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
    let listenStarted = false;
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
      if (listenStarted) server.close();
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
    listenStarted = true;
    server.listen({ host: LOOPBACK_HOST, port, exclusive: true });
  });
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
  const modelBytes = Buffer.from(JSON.stringify(model), "utf8");
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
  const port = await listen(server, validPort(options.port), options.signal);
  activeHandler = requestHandler(assets, modelBytes, port);

  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  let closePromise: Promise<void> | undefined;
  const onSignal = (): void => {
    void close().catch(() => undefined);
  };
  const cleanup = (): void => {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    options.signal?.removeEventListener("abort", onSignal);
  };
  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    cleanup();
    closePromise = new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(new Error("The local viewer did not close cleanly."));
        else resolve();
      });
      server.closeAllConnections();
    });
    return closePromise;
  };
  server.once("close", () => {
    cleanup();
    resolveClosed();
  });
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  options.signal?.addEventListener("abort", onSignal, { once: true });
  if (options.signal?.aborted) {
    void close().catch(() => undefined);
  }

  const origin = `http://${LOOPBACK_HOST}:${port}`;
  const modelUrl = new URL(MODEL_PATH, origin);
  const url = new URL("/", origin);
  url.searchParams.set("model", MODEL_PATH);
  return { url, modelUrl, closed, close };
}
