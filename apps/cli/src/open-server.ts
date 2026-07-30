import {
  constants,
  promises as fs,
  type BigIntStats,
} from "node:fs";
import type { FileHandle } from "node:fs/promises";
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

export interface ViewerAsset {
  readonly body: Buffer;
  readonly contentType?: string;
}

export interface ViewerAssetFilesystemEntry {
  readonly kind: "directory" | "file";
  readonly path: string;
  readonly canonicalPath: string;
  readonly device: bigint;
  readonly inode: bigint;
}

export interface CollectViewerAssetsOptions {
  readonly guard?: (
    entry: ViewerAssetFilesystemEntry,
  ) => void | Promise<void>;
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

interface OpenedViewerEntry {
  readonly kind: "directory" | "file";
  readonly path: string;
  readonly canonicalPath: string;
  readonly status: BigIntStats;
  readonly handle: FileHandle;
}

class ViewerAssetGuardFailure {
  public constructor(readonly reason: unknown) {}
}

function sameFilesystemIdentity(
  left: BigIntStats,
  right: BigIntStats,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFilesystemSnapshot(
  left: BigIntStats,
  right: BigIntStats,
): boolean {
  return (
    sameFilesystemIdentity(left, right) &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function sameCanonicalPath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLocaleLowerCase("en-US") ===
        normalizedRight.toLocaleLowerCase("en-US")
    : normalizedLeft === normalizedRight;
}

function viewerEntryKind(
  status: BigIntStats,
): "directory" | "file" | undefined {
  if (status.isDirectory()) return "directory";
  if (status.isFile()) return "file";
  return undefined;
}

async function openViewerEntry(
  candidate: string,
  requiredKind: "directory" | "file" | undefined,
  canonicalRoot: string | undefined,
  requireReliableIdentity: boolean,
): Promise<OpenedViewerEntry> {
  const before = await fs.lstat(candidate, { bigint: true });
  const kind = viewerEntryKind(before);
  if (
    kind === undefined ||
    kind !== (requiredKind ?? kind) ||
    before.isSymbolicLink()
  ) {
    throw new Error();
  }
  const canonicalBefore = await fs.realpath(candidate);
  if (
    canonicalRoot !== undefined &&
    !isWithin(canonicalRoot, canonicalBefore)
  ) {
    throw new Error();
  }
  const flags =
    constants.O_RDONLY |
    (constants.O_NOFOLLOW ?? 0) |
    (constants.O_NONBLOCK ?? 0) |
    (kind === "directory" ? (constants.O_DIRECTORY ?? 0) : 0);
  const handle = await fs.open(candidate, flags);
  try {
    const opened = await handle.stat({ bigint: true });
    const after = await fs.lstat(candidate, { bigint: true });
    const canonicalAfter = await fs.realpath(candidate);
    if (
      viewerEntryKind(opened) !== kind ||
      viewerEntryKind(after) !== kind ||
      after.isSymbolicLink() ||
      !sameFilesystemSnapshot(before, opened) ||
      !sameFilesystemSnapshot(opened, after) ||
      !sameCanonicalPath(canonicalBefore, canonicalAfter) ||
      (
        requireReliableIdentity &&
        opened.dev === 0n &&
        opened.ino === 0n
      )
    ) {
      throw new Error();
    }
    return {
      kind,
      path: candidate,
      canonicalPath: canonicalAfter,
      status: opened,
      handle,
    };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function assertViewerEntryStable(
  entry: OpenedViewerEntry,
): Promise<void> {
  const opened = await entry.handle.stat({ bigint: true });
  const current = await fs.lstat(entry.path, { bigint: true });
  const canonical = await fs.realpath(entry.path);
  if (
    viewerEntryKind(opened) !== entry.kind ||
    viewerEntryKind(current) !== entry.kind ||
    current.isSymbolicLink() ||
    !sameFilesystemSnapshot(entry.status, opened) ||
    !sameFilesystemSnapshot(opened, current) ||
    !sameCanonicalPath(entry.canonicalPath, canonical)
  ) {
    throw new Error();
  }
}

async function applyViewerAssetGuard(
  guard: CollectViewerAssetsOptions["guard"],
  entry: OpenedViewerEntry,
): Promise<void> {
  if (guard === undefined) return;
  try {
    await guard(Object.freeze({
      kind: entry.kind,
      path: entry.path,
      canonicalPath: entry.canonicalPath,
      device: entry.status.dev,
      inode: entry.status.ino,
    }));
  } catch (error) {
    throw new ViewerAssetGuardFailure(error);
  }
}

export async function collectViewerAssets(
  requestedRoot: string,
  options: CollectViewerAssetsOptions = {},
): Promise<ReadonlyMap<string, ViewerAsset>> {
  let rootEntry: OpenedViewerEntry | undefined;
  const assets = new Map<string, ViewerAsset>();
  try {
    const absoluteRoot = path.resolve(requestedRoot);
    rootEntry = await openViewerEntry(
      absoluteRoot,
      "directory",
      undefined,
      options.guard !== undefined,
    );
    const root = rootEntry.canonicalPath;
    let totalBytes = 0;
    let visitedEntries = 0;

    async function assertTraversalStable(
      directory: OpenedViewerEntry,
    ): Promise<void> {
      await assertViewerEntryStable(rootEntry!);
      if (directory !== rootEntry) {
        await assertViewerEntryStable(directory);
      }
    }

    async function visit(
      directory: OpenedViewerEntry,
      relativeDirectory: string,
    ): Promise<void> {
      await applyViewerAssetGuard(options.guard, directory);
      await assertTraversalStable(directory);
      const entries = await fs.readdir(directory.path, {
        withFileTypes: true,
      });
      await assertTraversalStable(directory);
      entries.sort((left, right) =>
        left.name.localeCompare(right.name, "en-US"),
      );
      for (const entry of entries) {
        await assertTraversalStable(directory);
        visitedEntries += 1;
        if (visitedEntries > MAX_ASSET_FILES) throw new Error();
        if (entry.isSymbolicLink()) throw new Error();
        const relative = relativeDirectory
          ? path.join(relativeDirectory, entry.name)
          : entry.name;
        const candidate = path.join(directory.path, entry.name);
        const opened = await openViewerEntry(
          candidate,
          undefined,
          root,
          options.guard !== undefined,
        );
        try {
          if (opened.kind === "directory") {
            await visit(opened, relative);
            continue;
          }
          if (assets.size >= MAX_ASSET_FILES) throw new Error();
          await applyViewerAssetGuard(options.guard, opened);
          await assertTraversalStable(directory);
          await assertViewerEntryStable(opened);
          const size = Number(opened.status.size);
          if (
            !Number.isSafeInteger(size) ||
            size < 0 ||
            size > MAX_ASSET_BYTES - totalBytes
          ) {
            throw new Error();
          }
          let body: Buffer | undefined;
          try {
            body = await opened.handle.readFile();
            await assertViewerEntryStable(opened);
            await assertTraversalStable(directory);
            if (body.byteLength !== size) throw new Error();
            totalBytes += body.byteLength;
            if (totalBytes > MAX_ASSET_BYTES) throw new Error();
            const requestPath =
              `/${relative.split(path.sep).join("/")}`;
            const contentType = MIME_TYPES.get(
              path.extname(entry.name).toLocaleLowerCase("en-US"),
            );
            assets.set(requestPath, {
              body,
              ...(contentType === undefined ? {} : { contentType }),
            });
            body = undefined;
          } finally {
            body?.fill(0);
          }
        } finally {
          await opened.handle.close().catch(() => undefined);
        }
      }
      await assertTraversalStable(directory);
    }

    await visit(rootEntry, "");
    const index = assets.get("/index.html");
    if (!index || index.contentType !== MIME_TYPES.get(".html")) {
      throw new Error();
    }
    return assets;
  } catch (error) {
    for (const asset of assets.values()) asset.body.fill(0);
    assets.clear();
    if (error instanceof ViewerAssetGuardFailure) throw error.reason;
    throw new Error(
      "Production viewer assets are unavailable. Run 'npm run viewer:build' first.",
    );
  } finally {
    await rootEntry?.handle.close().catch(() => undefined);
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
