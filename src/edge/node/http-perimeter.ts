import type { InvestigationStore } from "./investigation-store";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { BodyReaderPool, readBoundedBody, validateApplicationContentLength, type BodyMode } from "./body-reader";
import { canonicalAuthority, type AssetHostConfiguration, type StandaloneConfiguration } from "./config";
import { loadPublicFixtures, type PublicFixture } from "./fixture-manifest";
import { canonicalWireValue, exactWireHeaderValues, RequestWireObserver, wireValueEquals, type WireRequestHead } from "./wire-observer";

export const RESPONSE_SECURITY_HEADERS = Object.freeze({
  "Content-Security-Policy": "default-src 'none'; base-uri 'none'; connect-src 'self' https://api.github.com https://raw.githubusercontent.com; form-action 'none'; frame-ancestors 'none'; frame-src 'none'; object-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
});

const API_ROUTES = Object.freeze({
  "/_code-city/session": "session",
  "/_code-city/analyze": "command",
  "/_code-city/cancel": "command",
  "/_code-city/discard": "command",
} as const);

type ApiTarget = keyof typeof API_ROUTES;

export type FixedHandlerResult =
  | Readonly<{ kind: "empty"; status: number; close?: boolean }>
  | Readonly<{
      kind: "stream";
      status: number;
      contentType: string;
      open(request: IncomingMessage, response: ServerResponse): void;
    }>;

type FixedHandler = (value: unknown) => void | FixedHandlerResult | Promise<void | FixedHandlerResult>;

export type FixedRouteHandlers = Readonly<Partial<Record<ApiTarget, FixedHandler>>>;

export interface InactiveHttpPerimeterInput {
  readonly configuration: StandaloneConfiguration | AssetHostConfiguration;
  readonly fixtureManifestBytes: Uint8Array;
  readonly artifactRoot: string;
  readonly handlers?: FixedRouteHandlers;
  readonly store?: InvestigationStore;
}

export interface RunningInactiveHttpPerimeter {
  readonly origin: string;
  readonly close: () => Promise<void>;
  readonly closeIdleConnections: () => void;
  readonly closeAllConnections: () => void;
}

type IngressKind = "request" | "continue" | "expectation";

function validTarget(target: string | undefined): target is string {
  if (target === undefined || !/^\/(?:[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*)?$/u.test(target)) return false;
  if (target.length > 1 && target.endsWith("/")) return false;
  return !target.split("/").some((segment) => segment === "." || segment === "..");
}

function statusLine(status: number): string {
  if (status === 400) return "400 Bad Request";
  if (status === 403) return "403 Forbidden";
  if (status === 404) return "404 Not Found";
  if (status === 405) return "405 Method Not Allowed";
  if (status === 413) return "413 Payload Too Large";
  if (status === 415) return "415 Unsupported Media Type";
  if (status === 417) return "417 Expectation Failed";
  if (status === 500) return "500 Internal Server Error";
  if (status === 503) return "503 Service Unavailable";
  throw new Error("Unsupported status");
}

function applySecurityHeaders(response: ServerResponse): void {
  for (const [name, value] of Object.entries(RESPONSE_SECURITY_HEADERS)) response.setHeader(name, value);
}

function createPerimeterServer(
  configuration: StandaloneConfiguration | AssetHostConfiguration,
  routes: ReadonlyMap<string, PublicFixture>,
  handlers: FixedRouteHandlers,
  store?: InvestigationStore,
) {
  const closingSockets = new WeakSet<Duplex>();
  const wireObservers = new WeakMap<Duplex, RequestWireObserver>();
  const commandConfiguration = "maxCommandBodyReaders" in configuration ? configuration : undefined;
  const readers = commandConfiguration ? new BodyReaderPool(commandConfiguration.maxCommandBodyReaders) : undefined;
  let authority: string | undefined;
  let origin: string | undefined;

  const markClosing = (socket: Duplex): boolean => {
    if (closingSockets.has(socket)) return false;
    closingSockets.add(socket);
    return true;
  };

  const reject = (request: IncomingMessage, response: ServerResponse, status: number): void => {
    const socket = request.socket;
    if (!markClosing(socket)) {
      socket.destroy();
      return;
    }
    response.statusCode = status;
    response.shouldKeepAlive = false;
    applySecurityHeaders(response);
    response.setHeader("Connection", "close");
    response.setHeader("Content-Length", "0");
    response.once("finish", () => socket.end());
    response.end();
  };

  const rejectSocket = (socket: Duplex, status: number): void => {
    if (!markClosing(socket)) {
      socket.destroy();
      return;
    }
    if (!socket.writable || socket.destroyed) {
      socket.destroy();
      return;
    }
    const headers = Object.entries(RESPONSE_SECURITY_HEADERS).map(([name, value]) => `${name}: ${value}`).join("\r\n");
    socket.end(`HTTP/1.1 ${statusLine(status)}\r\n${headers}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  };

  const validHostAndTarget = (request: IncomingMessage, wireHead: WireRequestHead): request is IncomingMessage & { url: string } => {
    const hosts = exactWireHeaderValues(wireHead, "host");
    return authority !== undefined && hosts.length === 1 && wireValueEquals(hosts[0] as Buffer, authority) && validTarget(request.url);
  };

  const originAccepted = (wireHead: WireRequestHead, required: boolean): boolean => {
    const origins = exactWireHeaderValues(wireHead, "origin");
    if (!required && origins.length === 0) return true;
    return origin !== undefined && origins.length === 1 && wireValueEquals(origins[0] as Buffer, origin);
  };

  const sendStatic = (response: ServerResponse, fixture: PublicFixture, head: boolean): void => {
    response.statusCode = 200;
    applySecurityHeaders(response);
    response.setHeader("Content-Type", fixture.mediaType);
    response.setHeader("Content-Length", String(fixture.bytes.byteLength));
    response.end(head ? undefined : fixture.bytes);
  };

  const sendEmpty = (request: IncomingMessage, response: ServerResponse, status: number, close = false): void => {
    response.statusCode = status;
    applySecurityHeaders(response);
    response.setHeader("Content-Length", "0");
    if (close) {
      const socket = request.socket;
      markClosing(socket);
      response.shouldKeepAlive = false;
      response.setHeader("Connection", "close");
      response.once("finish", () => socket.end());
    }
    response.end();
  };

  const processBody = async (
    request: IncomingMessage,
    response: ServerResponse,
    kind: IngressKind,
    mode: BodyMode,
    handler: FixedHandler,
    wireHead: WireRequestHead,
  ): Promise<void> => {
    if (!commandConfiguration || !readers) { reject(request, response, 404); return; }
    const contentLength = validateApplicationContentLength(
      exactWireHeaderValues(wireHead, "content-length").map(canonicalWireValue),
      commandConfiguration.maxCommandBodyBytes,
    );
    if (contentLength === "bad-request") {
      reject(request, response, 400);
      return;
    }
    const release = readers.reserve();
    if (release === undefined) {
      reject(request, response, 503);
      return;
    }
    if (contentLength === "too-large") {
      release();
      reject(request, response, 413);
      return;
    }
    if (kind === "continue") response.writeContinue();

    const result = await readBoundedBody(request, commandConfiguration.maxCommandBodyBytes, mode, release);
    if (result.kind === "aborted") {
      request.socket.destroy();
      return;
    }
    if (result.kind === "too-large") {
      reject(request, response, 413);
      return;
    }
    if (result.kind === "bad-request") {
      reject(request, response, 400);
      return;
    }
    if (closingSockets.has(request.socket) || request.socket.destroyed) return;
    let handled: void | FixedHandlerResult;
    try {
      handled = await handler(result.value);
    } catch {
      reject(request, response, 500);
      return;
    }
    if (handled?.kind === "stream") {
      if (closingSockets.has(request.socket) || request.socket.destroyed) {
        handled.open(request, response);
        return;
      }
      response.statusCode = handled.status;
      applySecurityHeaders(response);
      response.setHeader("Content-Type", handled.contentType);
      try { handled.open(request, response); }
      catch { response.destroy(); }
      return;
    }
    if (closingSockets.has(request.socket) || request.socket.destroyed) return;
    sendEmpty(request, response, handled?.kind === "empty" ? handled.status : 204, handled?.kind === "empty" && handled.close === true);
  };

  const dispatch = (request: IncomingMessage, response: ServerResponse, kind: IngressKind): void => {
    if (closingSockets.has(request.socket)) {
      request.socket.destroy();
      return;
    }
    const wireHead = wireObservers.get(request.socket)?.shift();
    if (wireHead === undefined || !validHostAndTarget(request, wireHead)) {
      reject(request, response, 400);
      return;
    }

    if (store && (request.url === "/api/investigations" || /^\/api\/investigations\/[A-Za-z0-9_-]{43}(?:\/record)?$/u.test(request.url))) {
      if (!originAccepted(wireHead, request.method === "POST")) { reject(request, response, 403); return; }
      if (kind !== "request") { reject(request, response, 417); return; }
      if (request.method !== "GET" && !(request.method === "POST" && request.url === "/api/investigations")) { reject(request, response, 405); return; }
      if (request.method === "POST") {
        const mediaTypes = exactWireHeaderValues(wireHead, "content-type");
        if (mediaTypes.length !== 1 || canonicalWireValue(mediaTypes[0]) !== "application/octet-stream") { reject(request, response, 415); return; }
      }
      applySecurityHeaders(response);
      void store.handle(request, response, status => reject(request, response, status)).catch(() => { if (!response.headersSent) reject(request, response, 500); else response.destroy(); });
      return;
    }
    const staticFixture = routes.get(/^\/saved\/[A-Za-z0-9_-]{43}$/u.test(request.url) ? "/" : request.url);
    const apiMode = commandConfiguration ? API_ROUTES[request.url as ApiTarget] : undefined;
    if (staticFixture === undefined && apiMode === undefined) {
      reject(request, response, 404);
      return;
    }

    if (staticFixture !== undefined) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        reject(request, response, 405);
        return;
      }
      if (!originAccepted(wireHead, false)) {
        reject(request, response, 403);
        return;
      }
      if (kind === "expectation") {
        reject(request, response, 417);
        return;
      }
      sendStatic(response, staticFixture, request.method === "HEAD");
      return;
    }

    if (apiMode === undefined) { reject(request, response, 404); return; }
    if (request.method !== "POST") {
      reject(request, response, 405);
      return;
    }
    if (!originAccepted(wireHead, true)) {
      reject(request, response, 403);
      return;
    }
    if (apiMode === "command") {
      const mediaTypes = exactWireHeaderValues(wireHead, "content-type");
      if (mediaTypes.length !== 1 || !wireValueEquals(mediaTypes[0] as Buffer, "application/json")) {
        reject(request, response, 415);
        return;
      }
    }
    if (kind === "expectation") {
      reject(request, response, 417);
      return;
    }

    const handler = handlers[request.url as ApiTarget];
    if (handler === undefined) {
      reject(request, response, 404);
      return;
    }
    void processBody(request, response, kind, apiMode, handler, wireHead);
  };

  const server = createServer({ requireHostHeader: false }, (request, response) => dispatch(request, response, "request"));
  server.on("connection", (socket) => {
    const observer = new RequestWireObserver();
    wireObservers.set(socket, observer);
    socket.prependListener("data", (chunk: Buffer) => observer.feed(chunk));
  });
  server.on("checkContinue", (request, response) => dispatch(request, response, "continue"));
  server.on("checkExpectation", (request, response) => dispatch(request, response, "expectation"));
  server.on("upgrade", (request, socket) => {
    if (closingSockets.has(socket)) {
      socket.destroy();
      return;
    }
    const wireHead = wireObservers.get(socket)?.shift();
    rejectSocket(socket, wireHead !== undefined && validHostAndTarget(request, wireHead) ? 400 : 400);
  });
  server.on("connect", (request, socket) => {
    if (closingSockets.has(socket)) {
      socket.destroy();
      return;
    }
    const wireHead = wireObservers.get(socket)?.shift();
    rejectSocket(socket, wireHead !== undefined && validHostAndTarget(request, wireHead) ? 400 : 400);
  });
  server.on("clientError", (_error, socket) => rejectSocket(socket, 400));

  return {
    server,
    setAuthority(actualPort: number): string {
      authority = canonicalAuthority(configuration.canonicalHost, actualPort);
      origin = `http://${authority}`;
      return origin;
    },
  };
}

/** Repository-internal inactive perimeter construction boundary. */
export async function startInactiveHttpPerimeter(input: InactiveHttpPerimeterInput): Promise<RunningInactiveHttpPerimeter> {
  const fixtures = await loadPublicFixtures(input.fixtureManifestBytes, input.artifactRoot);
  const perimeter = createPerimeterServer(input.configuration, fixtures.routes, input.handlers ?? Object.freeze({}), input.store);
  const server = perimeter.server;

  const origin = await new Promise<string>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(input.configuration.port, input.configuration.host, () => {
      server.off("error", onError);
      const address = server.address() as AddressInfo | null;
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Standalone listener has no TCP address"));
        return;
      }
      resolve(perimeter.setAuthority(address.port));
    });
  });

  let closePromise: Promise<void> | undefined;
  return Object.freeze({
    origin,
    close(): Promise<void> {
      closePromise ??= new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeIdleConnections();
      });
      return closePromise;
    },
    closeIdleConnections(): void {
      server.closeIdleConnections();
    },
    closeAllConnections(): void {
      server.closeAllConnections();
    },
  });
}
