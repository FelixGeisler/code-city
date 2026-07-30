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
import { ImportArtifactStore } from "./import-artifacts.js";
import {
  InboundAuthorization,
  type InboundAuthorizationMethod,
  type InboundAuthorizationOptions,
} from "./inbound-authorization.js";
import {
  CredentialProfileRegistry,
  type CredentialProfileRegistryOptions,
} from "./credential-profiles.js";
import {
  enqueueRemoteImport,
  parseRemoteImportJson,
  RemoteImportPolicy,
  RemoteImportRequestError,
  type RemoteImportDependencies,
} from "./remote-import.js";
import {
  enqueueUploadedImport,
  parseUploadImportJson,
  UPLOAD_IMPORT_LIMITS,
  UploadReservationFailure,
  UploadReservationRegistry,
  type UploadReception,
} from "./upload-import.js";

const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_PORT = 3_000;
const MAXIMUM_REQUEST_TARGET_CHARACTERS = 2_048;
export const REMOTE_IMPORT_REQUEST_MAX_BYTES = 32 * 1024;
export const REMOTE_IMPORT_REQUEST_DEADLINE_MS = 5_000;
const JOB_PATH_PATTERN =
  /^\/api\/v1\/jobs\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u;
const CITY_MODEL_ARTIFACT_PATH_PATTERN =
  /^\/api\/v1\/artifacts\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/city-model\.json$/u;
const UPLOAD_IMPORT_PATH_PATTERN =
  /^\/api\/v1\/imports\/uploads\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u;
const AUTHORIZATION_SESSION_PATH = "/api/v1/auth/session";

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
  readonly allowedGitOrigins?: readonly string[];
  readonly trustWindowsGitWorkspace?: boolean;
  readonly authorization?: InboundAuthorizationOptions;
  readonly credentialProfiles?: CredentialProfileRegistryOptions;
  readonly importDependencies?: RemoteImportDependencies;
  readonly signal?: AbortSignal;
}

export interface CodeCityServerHandle {
  readonly host: string;
  readonly port: number;
  readonly url: URL;
  readonly jobs: PersistentJobQueue;
  readonly artifacts: ImportArtifactStore;
  readonly closed: Promise<void>;
  close(): Promise<void>;
}

interface ParsedTarget {
  readonly path: string;
}

type RequestBodyResult =
  | { readonly kind: "ok"; readonly text: string }
  | {
      readonly kind:
        | "disconnected"
        | "invalid-utf8"
        | "timed-out"
        | "too-large";
    };

class UploadBodyError extends Error {
  public override readonly name = "UploadBodyError";

  public constructor(
    public readonly code:
      | "aborted"
      | "disconnected"
      | "idle-timeout"
      | "total-timeout",
  ) {
    super(code);
  }
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

function completedCityModelArtifactTokens(
  jobs: PersistentJobQueue,
): ReadonlySet<string> {
  const tokens = new Set<string>();
  for (const job of jobs.list()) {
    if (
      job.state === "completed" &&
      job.result?.kind === "city-model" &&
      job.result.artifactToken === job.id &&
      job.result.artifactUrl ===
        `/api/v1/artifacts/${job.id}/city-model.json`
    ) {
      tokens.add(job.id);
    }
  }
  return tokens;
}

function completedJobOwnsCityModelArtifact(
  jobs: PersistentJobQueue,
  token: string,
): boolean {
  const job = jobs.get(token);
  return (
    job?.state === "completed" &&
    job.result?.kind === "city-model" &&
    job.result.artifactToken === token &&
    job.result.artifactUrl ===
      `/api/v1/artifacts/${token}/city-model.json`
  );
}

function rawHeaderValues(
  request: IncomingMessage,
  name: string,
): readonly string[] {
  const normalizedName = name.toLowerCase();
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (
      request.rawHeaders[index]?.toLowerCase() === normalizedName
    ) {
      values.push(request.rawHeaders[index + 1] ?? "");
    }
  }
  return values;
}

function validJsonContentType(value: string): boolean {
  return /^application\/json(?:\s*;\s*charset\s*=\s*(?:"utf-8"|utf-8))?$/iu.test(
    value,
  );
}

function declaredRequestBytes(
  request: IncomingMessage,
): number | "invalid" | undefined {
  const values = rawHeaderValues(request, "content-length");
  if (values.length === 0) return undefined;
  if (values.length !== 1 || !/^(?:0|[1-9][0-9]*)$/u.test(values[0]!)) {
    return "invalid";
  }
  const value = Number(values[0]);
  return Number.isSafeInteger(value) ? value : "invalid";
}

function hasUnexpectedRequestBody(
  request: IncomingMessage,
): boolean {
  const transferEncodings = rawHeaderValues(
    request,
    "transfer-encoding",
  );
  const declaredBytes = declaredRequestBytes(request);
  return (
    transferEncodings.length !== 0 ||
    declaredBytes === "invalid" ||
    (declaredBytes !== undefined && declaredBytes !== 0)
  );
}

function routeConsumesRequestBody(
  method: string | undefined,
  path: string,
): boolean {
  return (
    (method === "POST" && path === "/api/v1/imports") ||
    (method === "POST" &&
      path === "/api/v1/imports/uploads") ||
    (method === "PUT" &&
      UPLOAD_IMPORT_PATH_PATTERN.test(path))
  );
}

function isApiMutationMethod(method: string | undefined): boolean {
  return (
    method === "POST" ||
    method === "PUT" ||
    method === "PATCH" ||
    method === "DELETE"
  );
}

function rejectUnexpectedRequestBody(
  request: IncomingMessage,
  response: ServerResponse,
): void {
  response.setHeader("Connection", "close");
  closePausedRequestAfterResponse(request, response);
  sendJson(request, response, 400, {
    error: {
      code: "unexpected-request-body",
      message: "This endpoint does not accept a request body.",
    },
  });
}

function readBoundedRequestBody(
  request: IncomingMessage,
): Promise<RequestBodyResult> {
  if (request.destroyed || request.readableAborted) {
    return Promise.resolve({ kind: "disconnected" });
  }
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let settled = false;
    const timer = setTimeout(
      () => finish({ kind: "timed-out" }, true),
      REMOTE_IMPORT_REQUEST_DEADLINE_MS,
    );
    timer.unref();

    const cleanup = (): void => {
      clearTimeout(timer);
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("aborted", onAborted);
      request.off("close", onClose);
      request.off("error", onError);
    };
    const finish = (
      result: RequestBodyResult,
      drain = false,
    ): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (drain && !request.destroyed) request.resume();
      resolve(result);
    };
    const onData = (chunk: Buffer): void => {
      received += chunk.byteLength;
      if (received > REMOTE_IMPORT_REQUEST_MAX_BYTES) {
        finish({ kind: "too-large" }, true);
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(
          Buffer.concat(chunks, received),
        );
      } catch {
        finish({ kind: "invalid-utf8" });
        return;
      }
      finish({ kind: "ok", text });
    };
    const onAborted = (): void => {
      finish({ kind: "disconnected" });
    };
    const onClose = (): void => {
      if (!request.complete) finish({ kind: "disconnected" });
    };
    const onError = (): void => {
      finish({ kind: "disconnected" });
    };
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("aborted", onAborted);
    request.once("close", onClose);
    request.once("error", onError);
  });
}

async function* uploadBodyChunks(
  request: IncomingMessage,
  signal: AbortSignal,
): AsyncGenerator<Uint8Array> {
  if (request.destroyed || request.readableAborted) {
    throw new UploadBodyError("disconnected");
  }
  if (signal.aborted) throw new UploadBodyError("aborted");
  const queued: Buffer[] = [];
  let ended = false;
  let failure: UploadBodyError | undefined;
  let wake: (() => void) | undefined;
  let idleTimer: NodeJS.Timeout | undefined;

  const notify = (): void => {
    const current = wake;
    wake = undefined;
    current?.();
  };
  const fail = (code: UploadBodyError["code"]): void => {
    if (failure !== undefined) return;
    failure = new UploadBodyError(code);
    request.pause();
    notify();
  };
  const resetIdle = (): void => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(
      () => fail("idle-timeout"),
      UPLOAD_IMPORT_LIMITS.bodyIdleTimeoutMs,
    );
    idleTimer.unref();
  };
  const onData = (chunk: Buffer): void => {
    request.pause();
    queued.push(chunk);
    resetIdle();
    notify();
  };
  const onEnd = (): void => {
    ended = true;
    notify();
  };
  const onAborted = (): void => fail("disconnected");
  const onClose = (): void => {
    if (!request.complete) fail("disconnected");
  };
  const onError = (): void => fail("disconnected");
  const onSignal = (): void => fail("aborted");
  const totalTimer = setTimeout(
    () => fail("total-timeout"),
    UPLOAD_IMPORT_LIMITS.bodyTotalTimeoutMs,
  );
  totalTimer.unref();

  request.on("data", onData);
  request.once("end", onEnd);
  request.once("aborted", onAborted);
  request.once("close", onClose);
  request.once("error", onError);
  signal.addEventListener("abort", onSignal, { once: true });
  resetIdle();
  request.resume();
  try {
    while (true) {
      if (failure !== undefined) throw failure;
      const chunk = queued.shift();
      if (chunk !== undefined) {
        yield chunk;
        if (failure === undefined && !ended) request.resume();
        continue;
      }
      if (ended) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
        if (
          queued.length > 0 ||
          failure !== undefined ||
          ended
        ) {
          notify();
        }
      });
    }
  } finally {
    clearTimeout(totalTimer);
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    request.off("data", onData);
    request.off("end", onEnd);
    request.off("aborted", onAborted);
    request.off("close", onClose);
    request.off("error", onError);
    signal.removeEventListener("abort", onSignal);
  }
}

class ImportRequestOperations {
  readonly #active = new Set<Promise<void>>();

  public start(operation: Promise<void>): void {
    this.#active.add(operation);
    void operation.finally(() => this.#active.delete(operation)).catch(
      () => undefined,
    );
  }

  public async waitForIdle(): Promise<void> {
    while (this.#active.size > 0) {
      await Promise.allSettled([...this.#active]);
    }
  }
}

class ArtifactResponseGate {
  #active = false;
  #idle: Promise<void> = Promise.resolve();
  #resolveIdle: (() => void) | undefined;

  public tryAcquire(
    response: ServerResponse,
  ): (() => void) | undefined {
    if (this.#active) return undefined;
    this.#active = true;
    this.#idle = new Promise<void>((resolve) => {
      this.#resolveIdle = resolve;
    });
    let operationSettled = false;
    let responseCompleted = false;
    let released = false;
    const releaseIfComplete = (): void => {
      if (released || !operationSettled || !responseCompleted) return;
      released = true;
      response.off("finish", completeResponse);
      response.off("close", completeResponse);
      this.#active = false;
      const resolveIdle = this.#resolveIdle;
      this.#resolveIdle = undefined;
      resolveIdle?.();
    };
    const completeResponse = (): void => {
      responseCompleted = true;
      releaseIfComplete();
    };
    response.once("finish", completeResponse);
    response.once("close", completeResponse);
    return () => {
      operationSettled = true;
      releaseIfComplete();
    };
  }

  public waitForIdle(): Promise<void> {
    return this.#idle;
  }
}

async function remoteImportHandler(
  request: IncomingMessage,
  response: ServerResponse,
  jobs: PersistentJobQueue,
  artifacts: ImportArtifactStore,
  policy: RemoteImportPolicy,
  dependencies: RemoteImportDependencies | undefined,
): Promise<void> {
  if (request.method !== "POST") {
    response.setHeader("Connection", "close");
    request.resume();
    sendMethodNotAllowed(request, response, ["POST"]);
    return;
  }

  const csrfValues = rawHeaderValues(
    request,
    "x-code-city-request",
  );
  if (csrfValues.length !== 1 || csrfValues[0] !== "1") {
    response.setHeader("Connection", "close");
    request.resume();
    sendJson(request, response, 403, {
      error: {
        code: "request-header-required",
        message: "X-Code-City-Request: 1 is required.",
      },
    });
    return;
  }

  const contentTypes = rawHeaderValues(request, "content-type");
  const contentEncodings = rawHeaderValues(
    request,
    "content-encoding",
  );
  if (
    contentTypes.length !== 1 ||
    !validJsonContentType(contentTypes[0]!) ||
    contentEncodings.length !== 0
  ) {
    response.setHeader("Connection", "close");
    request.resume();
    sendJson(request, response, 415, {
      error: {
        code: "unsupported-media-type",
        message: "The import request must be unencoded application/json using UTF-8.",
      },
    });
    return;
  }

  const transferEncodings = rawHeaderValues(
    request,
    "transfer-encoding",
  );
  const declaredBytes = declaredRequestBytes(request);
  if (
    transferEncodings.length > 1 ||
    (transferEncodings.length === 1 &&
      transferEncodings[0]!.toLowerCase() !== "chunked") ||
    (transferEncodings.length > 0 &&
      declaredBytes !== undefined)
  ) {
    response.setHeader("Connection", "close");
    request.resume();
    sendJson(request, response, 400, {
      error: {
        code: "invalid-request-framing",
        message: "The import request framing is invalid.",
      },
    });
    return;
  }

  if (declaredBytes === "invalid") {
    response.setHeader("Connection", "close");
    request.resume();
    sendJson(request, response, 400, {
      error: {
        code: "invalid-request-framing",
        message: "The import request framing is invalid.",
      },
    });
    return;
  }
  if (declaredBytes !== undefined && declaredBytes > REMOTE_IMPORT_REQUEST_MAX_BYTES) {
    response.setHeader("Connection", "close");
    request.resume();
    sendJson(request, response, 413, {
      error: {
        code: "request-too-large",
        message: `The import request must not exceed ${REMOTE_IMPORT_REQUEST_MAX_BYTES} bytes.`,
      },
    });
    return;
  }

  let clientDisconnected = false;
  const onResponseClose = (): void => {
    if (!response.writableEnded) clientDisconnected = true;
  };
  response.once("close", onResponseClose);
  try {
    const body = await readBoundedRequestBody(request);
    if (body.kind === "disconnected" || clientDisconnected) return;
    if (body.kind === "too-large") {
      response.setHeader("Connection", "close");
      sendJson(request, response, 413, {
        error: {
          code: "request-too-large",
          message: `The import request must not exceed ${REMOTE_IMPORT_REQUEST_MAX_BYTES} bytes.`,
        },
      });
      return;
    }
    if (body.kind === "timed-out") {
      response.setHeader("Connection", "close");
      sendJson(request, response, 408, {
        error: {
          code: "request-timeout",
          message: "The import request body was not received in time.",
        },
      });
      return;
    }
    if (body.kind === "invalid-utf8") {
      sendJson(request, response, 400, {
        error: {
          code: "invalid-import-request",
          message: "The import request is invalid.",
          fields: [
            {
              code: "invalid-json",
              path: "$",
              message: "Must be valid UTF-8 JSON.",
            },
          ],
        },
      });
      return;
    }
    if (body.kind !== "ok") return;

    let parsed;
    try {
      parsed = parseRemoteImportJson(body.text);
    } catch (error) {
      if (!(error instanceof RemoteImportRequestError)) throw error;
      sendJson(request, response, 400, {
        error: {
          code: "invalid-import-request",
          message: error.message,
          fields: error.fields,
        },
      });
      return;
    }
    try {
      policy.assertAllowed(parsed);
    } catch (error) {
      if (!(error instanceof RemoteImportRequestError)) throw error;
      sendJson(request, response, error.status, {
        error: {
          code: "invalid-import-request",
          message: error.message,
          fields: error.fields,
        },
      });
      return;
    }
    if (clientDisconnected || response.destroyed) return;

    let queued: JobRecord;
    try {
      queued = await enqueueRemoteImport(parsed, {
        jobs,
        artifacts,
        policy,
        ...(dependencies === undefined ? {} : { dependencies }),
      });
    } catch {
      if (!clientDisconnected && !response.destroyed) {
        sendJson(request, response, 500, {
          error: {
            code: "import-enqueue-failed",
            message: "The repository import could not be queued.",
          },
        });
      }
      return;
    }
    if (clientDisconnected || response.destroyed) {
      await jobs.cancel(queued.id).catch(() => undefined);
      return;
    }
    response.setHeader("Location", `/api/v1/jobs/${queued.id}`);
    sendJson(request, response, 202, {
      job: publicJob(queued),
    });
  } finally {
    response.off("close", onResponseClose);
  }
}

function hasMutationHeader(request: IncomingMessage): boolean {
  const values = rawHeaderValues(request, "x-code-city-request");
  return values.length === 1 && values[0] === "1";
}

function rejectMissingMutationHeader(
  request: IncomingMessage,
  response: ServerResponse,
): void {
  response.setHeader("Connection", "close");
  closePausedRequestAfterResponse(request, response);
  sendJson(request, response, 403, {
    error: {
      code: "request-header-required",
      message: "X-Code-City-Request: 1 is required.",
    },
  });
}

function rejectMutationOrigin(
  request: IncomingMessage,
  response: ServerResponse,
): void {
  response.setHeader("Connection", "close");
  closePausedRequestAfterResponse(request, response);
  sendJson(request, response, 403, {
    error: {
      code: "request-origin-rejected",
      message: "The request origin is not allowed.",
    },
  });
}

function rejectUnauthorized(
  request: IncomingMessage,
  response: ServerResponse,
  closeConnection = false,
): void {
  response.setHeader(
    "WWW-Authenticate",
    'Bearer realm="Code City"',
  );
  if (closeConnection) {
    response.setHeader("Connection", "close");
    closePausedRequestAfterResponse(request, response);
  }
  sendJson(request, response, 401, {
    error: {
      code: "authorization-required",
      message: "Authorization is required.",
    },
  });
}

function closePausedRequestAfterResponse(
  request: IncomingMessage,
  response: ServerResponse,
): void {
  if (request.destroyed) return;
  if (response.destroyed) {
    request.destroy();
    return;
  }
  response.once("finish", () => request.destroy());
}

function sendEmpty(
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
): void {
  send(
    request,
    response,
    status,
    Buffer.alloc(0),
    "text/plain; charset=utf-8",
  );
}

function authorizationSessionHandler(
  request: IncomingMessage,
  response: ServerResponse,
  authorization: InboundAuthorization,
): void {
  if (request.method === "GET" || request.method === "HEAD") {
    sendJson(request, response, 200, {
      authorization: authorization.status(request),
    });
    return;
  }
  if (request.method !== "POST" && request.method !== "DELETE") {
    sendMethodNotAllowed(request, response, [
      "GET",
      "HEAD",
      "POST",
      "DELETE",
    ]);
    return;
  }
  if (!hasMutationHeader(request)) {
    rejectMissingMutationHeader(request, response);
    return;
  }
  if (authorization.mode === "trusted-network") {
    if (request.method === "DELETE") {
      response.setHeader("Set-Cookie", authorization.clearSessionCookie());
      sendEmpty(request, response, 204);
      return;
    }
    sendJson(request, response, 409, {
      error: {
        code: "authorization-not-configured",
        message: "Inbound authorization is not configured.",
      },
    });
    return;
  }
  if (request.method === "POST") {
    if (
      !authorization.mutationOriginAllowed(request, "bearer")
    ) {
      rejectMutationOrigin(request, response);
      return;
    }
    if (!authorization.authenticateBearer(request)) {
      rejectUnauthorized(request, response);
      return;
    }
    let cookie: string;
    try {
      cookie = authorization.createSession();
    } catch {
      sendJson(request, response, 503, {
        error: {
          code: "authorization-session-unavailable",
          message: "An authorization session could not be created.",
        },
      });
      return;
    }
    response.setHeader("Set-Cookie", cookie);
    sendEmpty(request, response, 204);
    return;
  }
  const result = authorization.authorize(request);
  const method: InboundAuthorizationMethod =
    result.method === "bearer" ? "bearer" : "session";
  if (!authorization.mutationOriginAllowed(request, method)) {
    rejectMutationOrigin(request, response);
    return;
  }
  authorization.revokeSession(request);
  response.setHeader("Set-Cookie", authorization.clearSessionCookie());
  sendEmpty(request, response, 204);
}

async function uploadReservationHandler(
  request: IncomingMessage,
  response: ServerResponse,
  uploads: UploadReservationRegistry,
): Promise<void> {
  if (request.method !== "POST") {
    response.setHeader("Connection", "close");
    request.resume();
    sendMethodNotAllowed(request, response, ["POST"]);
    return;
  }
  if (!hasMutationHeader(request)) {
    rejectMissingMutationHeader(request, response);
    return;
  }
  const contentTypes = rawHeaderValues(request, "content-type");
  const contentEncodings = rawHeaderValues(
    request,
    "content-encoding",
  );
  if (
    contentTypes.length !== 1 ||
    !validJsonContentType(contentTypes[0]!) ||
    contentEncodings.length !== 0
  ) {
    response.setHeader("Connection", "close");
    request.resume();
    sendJson(request, response, 415, {
      error: {
        code: "unsupported-media-type",
        message:
          "The upload reservation must be unencoded application/json using UTF-8.",
      },
    });
    return;
  }
  const transferEncodings = rawHeaderValues(
    request,
    "transfer-encoding",
  );
  const declaredBytes = declaredRequestBytes(request);
  if (
    transferEncodings.length > 1 ||
    (transferEncodings.length === 1 &&
      transferEncodings[0]!.toLowerCase() !== "chunked") ||
    (transferEncodings.length > 0 &&
      declaredBytes !== undefined) ||
    declaredBytes === "invalid"
  ) {
    response.setHeader("Connection", "close");
    request.resume();
    sendJson(request, response, 400, {
      error: {
        code: "invalid-request-framing",
        message: "The upload reservation framing is invalid.",
      },
    });
    return;
  }
  if (
    declaredBytes !== undefined &&
    declaredBytes > REMOTE_IMPORT_REQUEST_MAX_BYTES
  ) {
    response.setHeader("Connection", "close");
    request.resume();
    sendJson(request, response, 413, {
      error: {
        code: "request-too-large",
        message: `The upload reservation must not exceed ${REMOTE_IMPORT_REQUEST_MAX_BYTES} bytes.`,
      },
    });
    return;
  }
  const body = await readBoundedRequestBody(request);
  if (body.kind === "disconnected") return;
  if (body.kind === "too-large") {
    response.setHeader("Connection", "close");
    sendJson(request, response, 413, {
      error: {
        code: "request-too-large",
        message: `The upload reservation must not exceed ${REMOTE_IMPORT_REQUEST_MAX_BYTES} bytes.`,
      },
    });
    return;
  }
  if (body.kind === "timed-out") {
    response.setHeader("Connection", "close");
    sendJson(request, response, 408, {
      error: {
        code: "request-timeout",
        message: "The upload reservation was not received in time.",
      },
    });
    return;
  }
  if (body.kind === "invalid-utf8") {
    sendJson(request, response, 400, {
      error: {
        code: "invalid-import-request",
        message: "The import request is invalid.",
        fields: [
          {
            code: "invalid-json",
            path: "$",
            message: "Must be valid UTF-8 JSON.",
          },
        ],
      },
    });
    return;
  }
  if (body.kind !== "ok") return;
  let parsed;
  try {
    parsed = parseUploadImportJson(body.text);
  } catch (error) {
    if (!(error instanceof RemoteImportRequestError)) throw error;
    sendJson(request, response, 400, {
      error: {
        code: "invalid-import-request",
        message: error.message,
        fields: error.fields,
      },
    });
    return;
  }
  try {
    const reservation = await uploads.reserve(parsed);
    if (response.destroyed) {
      await uploads.abandon(reservation.token).catch(() => undefined);
      return;
    }
    response.setHeader("Location", reservation.uploadUrl);
    sendJson(request, response, 201, { upload: reservation });
  } catch (error) {
    if (
      error instanceof UploadReservationFailure &&
      error.code === "quota-exceeded"
    ) {
      response.setHeader("Retry-After", "5");
      sendJson(request, response, 429, {
        error: {
          code: "upload-capacity-reached",
          message: "The server has no upload capacity available.",
        },
      });
      return;
    }
    sendJson(request, response, 500, {
      error: {
        code: "upload-reservation-failed",
        message: "The upload reservation could not be created.",
      },
    });
  }
}

async function deleteUploadReservation(
  request: IncomingMessage,
  response: ServerResponse,
  token: string,
  uploads: UploadReservationRegistry,
): Promise<void> {
  if (!hasMutationHeader(request)) {
    rejectMissingMutationHeader(request, response);
    return;
  }
  const transferEncodings = rawHeaderValues(
    request,
    "transfer-encoding",
  );
  const declaredBytes = declaredRequestBytes(request);
  if (
    transferEncodings.length !== 0 ||
    declaredBytes === "invalid" ||
    (declaredBytes !== undefined && declaredBytes !== 0)
  ) {
    response.setHeader("Connection", "close");
    request.resume();
    sendJson(request, response, 400, {
      error: {
        code: "invalid-request-framing",
        message: "Upload deletion must not contain a request body.",
      },
    });
    return;
  }
  let removed: boolean;
  try {
    removed = await uploads.abandon(token);
  } catch {
    sendJson(request, response, 500, {
      error: {
        code: "upload-delete-failed",
        message: "Upload reservation could not be removed.",
      },
    });
    return;
  }
  if (!removed) {
    sendJson(request, response, 404, {
      error: {
        code: "upload-not-found",
        message: "Upload reservation not found.",
      },
    });
    return;
  }
  sendJson(request, response, 200, { deleted: true });
}

async function uploadContentHandler(
  request: IncomingMessage,
  response: ServerResponse,
  token: string,
  jobs: PersistentJobQueue,
  artifacts: ImportArtifactStore,
  uploads: UploadReservationRegistry,
): Promise<void> {
  if (request.method === "DELETE") {
    await deleteUploadReservation(request, response, token, uploads);
    return;
  }
  if (request.method !== "PUT") {
    response.setHeader("Connection", "close");
    request.resume();
    sendMethodNotAllowed(request, response, ["PUT", "DELETE"]);
    return;
  }
  if (!hasMutationHeader(request)) {
    rejectMissingMutationHeader(request, response);
    return;
  }
  const transferEncodings = rawHeaderValues(
    request,
    "transfer-encoding",
  );
  const declaredBytes = declaredRequestBytes(request);
  if (
    transferEncodings.length !== 0 ||
    declaredBytes === "invalid"
  ) {
    response.setHeader("Connection", "close");
    request.resume();
    sendJson(request, response, 400, {
      error: {
        code: "invalid-request-framing",
        message:
          "Upload content requires one exact Content-Length and no Transfer-Encoding.",
      },
    });
    return;
  }
  if (declaredBytes === undefined) {
    response.setHeader("Connection", "close");
    request.resume();
    sendJson(request, response, 411, {
      error: {
        code: "content-length-required",
        message: "Upload content requires Content-Length.",
      },
    });
    return;
  }

  let reception: UploadReception;
  try {
    reception = uploads.begin(token);
  } catch (error) {
    response.setHeader("Connection", "close");
    request.resume();
    const unavailable =
      error instanceof UploadReservationFailure &&
      error.code === "unavailable";
    sendJson(request, response, unavailable ? 409 : 404, {
      error: {
        code: unavailable ? "upload-unavailable" : "upload-not-found",
        message: unavailable
          ? "Upload reservation is no longer available."
          : "Upload reservation not found.",
      },
    });
    return;
  }

  let transferred = false;
  let clientDisconnected = false;
  const onResponseClose = (): void => {
    if (!response.writableEnded) clientDisconnected = true;
  };
  response.once("close", onResponseClose);
  try {
    const expectedMedia =
      reception.request.source.kind === "city-model"
        ? "application/json"
        : "application/zip";
    const contentTypes = rawHeaderValues(request, "content-type");
    const contentEncodings = rawHeaderValues(
      request,
      "content-encoding",
    );
    const validMedia =
      contentTypes.length === 1 &&
      (expectedMedia === "application/json"
        ? validJsonContentType(contentTypes[0]!)
        : /^application\/zip$/iu.test(contentTypes[0]!));
    if (!validMedia || contentEncodings.length !== 0) {
      response.setHeader("Connection", "close");
      request.resume();
      sendJson(request, response, 415, {
        error: {
          code: "unsupported-media-type",
          message: `Upload content must be unencoded ${expectedMedia}.`,
        },
      });
      return;
    }
    if (declaredBytes !== reception.request.source.sizeBytes) {
      response.setHeader("Connection", "close");
      request.resume();
      sendJson(request, response, 400, {
        error: {
          code: "upload-size-mismatch",
          message:
            "Content-Length does not match the reserved upload size.",
        },
      });
      return;
    }
    try {
      await artifacts.writeStagedUpload(
        reception.staging.token,
        uploadBodyChunks(request, reception.signal),
        {
          expectedBytes: declaredBytes,
          maximumBytes: reception.request.source.sizeBytes,
          signal: reception.signal,
        },
      );
    } catch (error) {
      closePausedRequestAfterResponse(request, response);
      if (
        error instanceof UploadBodyError &&
        error.code === "disconnected"
      ) {
        return;
      }
      if (
        error instanceof UploadBodyError &&
        (error.code === "idle-timeout" ||
          error.code === "total-timeout")
      ) {
        if (!response.destroyed) {
          response.setHeader("Connection", "close");
          sendJson(request, response, 408, {
            error: {
              code: "upload-timeout",
              message: "Upload content was not received in time.",
            },
          });
        }
        return;
      }
      if (!response.destroyed && !clientDisconnected) {
        response.setHeader("Connection", "close");
        sendJson(request, response, 400, {
          error: {
            code: "upload-invalid",
            message:
              "Upload content did not match the reserved request.",
          },
        });
      }
      return;
    }
    if (
      reception.signal.aborted ||
      clientDisconnected ||
      response.destroyed
    ) {
      return;
    }
    let lease;
    try {
      lease = reception.transfer();
    } catch {
      if (!response.destroyed && !clientDisconnected) {
        response.setHeader("Connection", "close");
        sendJson(request, response, 409, {
          error: {
            code: "upload-unavailable",
            message: "Upload reservation is no longer available.",
          },
        });
      }
      return;
    }
    transferred = true;
    let queued: JobRecord;
    try {
      queued = await enqueueUploadedImport(lease, {
        jobs,
        artifacts,
      });
    } catch {
      if (!response.destroyed && !clientDisconnected) {
        sendJson(request, response, 500, {
          error: {
            code: "import-enqueue-failed",
            message: "The uploaded import could not be queued.",
          },
        });
      }
      return;
    }
    if (clientDisconnected || response.destroyed) {
      await jobs.cancel(queued.id).catch(() => undefined);
      return;
    }
    response.setHeader("Location", `/api/v1/jobs/${queued.id}`);
    sendJson(request, response, 202, {
      job: publicJob(queued),
    });
  } finally {
    response.off("close", onResponseClose);
    if (!transferred) {
      await reception.fail().catch(() => undefined);
    }
  }
}

function apiHandler(
  request: IncomingMessage,
  response: ServerResponse,
  target: ParsedTarget,
  jobs: PersistentJobQueue,
  artifacts: ImportArtifactStore,
  artifactResponses: ArtifactResponseGate,
  importRequests: ImportRequestOperations,
  uploads: UploadReservationRegistry,
  importPolicy: RemoteImportPolicy,
  credentialProfiles: CredentialProfileRegistry,
  importDependencies: RemoteImportDependencies | undefined,
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
  if (target.path === "/api/v1/imports/capabilities") {
    if (request.method !== "GET" && request.method !== "HEAD") {
      sendMethodNotAllowed(request, response, ["GET", "HEAD"]);
      return true;
    }
    sendJson(request, response, 200, {
      credentialProfiles: credentialProfiles.capabilities(),
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
  if (target.path === "/api/v1/imports") {
    importRequests.start(
      remoteImportHandler(
        request,
        response,
        jobs,
        artifacts,
        importPolicy,
        importDependencies,
      ),
    );
    return true;
  }
  if (target.path === "/api/v1/imports/uploads") {
    importRequests.start(
      uploadReservationHandler(request, response, uploads),
    );
    return true;
  }
  const uploadMatch = UPLOAD_IMPORT_PATH_PATTERN.exec(target.path);
  if (uploadMatch) {
    importRequests.start(
      uploadContentHandler(
        request,
        response,
        uploadMatch[1]!,
        jobs,
        artifacts,
        uploads,
      ),
    );
    return true;
  }
  const artifactMatch = CITY_MODEL_ARTIFACT_PATH_PATTERN.exec(target.path);
  if (artifactMatch) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      sendMethodNotAllowed(request, response, ["GET", "HEAD"]);
      return true;
    }
    const token = artifactMatch[1]!;
    if (!completedJobOwnsCityModelArtifact(jobs, token)) {
      sendJson(request, response, 404, {
        error: {
          code: "artifact-not-found",
          message: "City-model artifact not found.",
        },
      });
      return true;
    }
    const completeArtifactOperation =
      artifactResponses.tryAcquire(response);
    if (!completeArtifactOperation) {
      response.setHeader("Retry-After", "1");
      sendJson(request, response, 503, {
        error: {
          code: "artifact-busy",
          message: "Another city-model artifact response is in progress.",
        },
      });
      return true;
    }
    if (request.method === "HEAD") {
      void artifacts
        .statCityModel(token)
        .then(
          (artifact) => {
            if (response.destroyed) return;
            if (!artifact) {
              sendJson(request, response, 404, {
                error: {
                  code: "artifact-not-found",
                  message: "City-model artifact not found.",
                },
              });
              return;
            }
            response.statusCode = 200;
            securityHeaders(
              response,
              "application/json; charset=utf-8",
              "no-store",
            );
            response.setHeader("Content-Length", artifact.size);
            response.end();
          },
          () => {
            if (!response.destroyed) {
              sendJson(request, response, 500, {
                error: {
                  code: "artifact-read-failed",
                  message: "The city-model artifact could not be read.",
                },
              });
            }
          },
        )
        .then(
          completeArtifactOperation,
          completeArtifactOperation,
        );
      return true;
    }
    void artifacts
      .readCityModel(token)
      .then(
        (artifact) => {
          if (response.destroyed) return;
          if (!artifact) {
            sendJson(request, response, 404, {
              error: {
                code: "artifact-not-found",
                message: "City-model artifact not found.",
              },
            });
            return;
          }
          send(
            request,
            response,
            200,
            artifact.bytes,
            "application/json; charset=utf-8",
          );
        },
        () => {
          if (!response.destroyed) {
            sendJson(request, response, 500, {
              error: {
                code: "artifact-read-failed",
                message: "The city-model artifact could not be read.",
              },
            });
          }
        },
      )
      .then(
        completeArtifactOperation,
        completeArtifactOperation,
      );
    return true;
  }
  const match = JOB_PATH_PATTERN.exec(target.path);
  if (!match) return false;
  const id = match[1]!;
  if (request.method === "DELETE") {
    if (!hasMutationHeader(request)) {
      rejectMissingMutationHeader(request, response);
      return true;
    }
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
  artifacts: ImportArtifactStore,
  artifactResponses: ArtifactResponseGate,
  importRequests: ImportRequestOperations,
  uploads: UploadReservationRegistry,
  importPolicy: RemoteImportPolicy,
  credentialProfiles: CredentialProfileRegistry,
  importDependencies: RemoteImportDependencies | undefined,
  allowedHosts: ReadonlySet<string>,
  authorization: InboundAuthorization,
): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
    if (!hostHeaderIsAllowed(request, allowedHosts)) {
      if (hasUnexpectedRequestBody(request)) {
        rejectUnexpectedRequestBody(request, response);
        return;
      }
      send(request, response, 400, "Bad request.\n", "text/plain; charset=utf-8");
      return;
    }
    const target = parseTarget(request.url);
    if (!target) {
      if (hasUnexpectedRequestBody(request)) {
        rejectUnexpectedRequestBody(request, response);
        return;
      }
      send(request, response, 400, "Bad request.\n", "text/plain; charset=utf-8");
      return;
    }
    let authorizationMethod:
      | InboundAuthorizationMethod
      | undefined;
    const publicHealthRead =
      target.path === "/api/v1/health" &&
      (request.method === "GET" || request.method === "HEAD");
    const apiNamespace =
      target.path === "/api" || target.path.startsWith("/api/");
    const protectedApi =
      apiNamespace &&
      target.path !== AUTHORIZATION_SESSION_PATH &&
      !publicHealthRead;
    if (protectedApi) {
      const authorized = authorization.authorize(request);
      if (!authorized.authorized || authorized.method === undefined) {
        rejectUnauthorized(
          request,
          response,
          routeConsumesRequestBody(request.method, target.path) ||
            hasUnexpectedRequestBody(request),
        );
        return;
      }
      authorizationMethod = authorized.method;
    }
    if (
      !routeConsumesRequestBody(request.method, target.path) &&
      hasUnexpectedRequestBody(request)
    ) {
      rejectUnexpectedRequestBody(request, response);
      return;
    }
    if (apiNamespace) {
      if (target.path === AUTHORIZATION_SESSION_PATH) {
        authorizationSessionHandler(
          request,
          response,
          authorization,
        );
        return;
      }
      if (protectedApi && authorizationMethod !== undefined) {
        if (
          isApiMutationMethod(request.method) &&
          !authorization.mutationOriginAllowed(
            request,
            authorizationMethod,
          )
        ) {
          rejectMutationOrigin(request, response);
          return;
        }
      }
      if (
        !apiHandler(
          request,
          response,
          target,
          jobs,
          artifacts,
          artifactResponses,
          importRequests,
          uploads,
          importPolicy,
          credentialProfiles,
          importDependencies,
        )
      ) {
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
  const importPolicy = new RemoteImportPolicy(
    options.allowedGitOrigins,
    {
      trustWindowsGitWorkspace:
        options.trustWindowsGitWorkspace ?? false,
    },
  );
  const configuredAllowedHosts = allowedHostnames(
    host,
    options.allowedHosts,
  );
  if (options.signal?.aborted) throw new Error("Server startup was aborted.");
  const authorization = await InboundAuthorization.open(
    options.authorization ?? {},
    host,
  );
  if (options.signal?.aborted) {
    authorization.close();
    throw new Error("Server startup was aborted.");
  }
  if (
    options.credentialProfiles?.profilesFile !== undefined &&
    authorization.mode !== "shared-secret"
  ) {
    authorization.close();
    throw new Error(
      "CODECITY_CREDENTIAL_PROFILES_FILE requires configured inbound authorization.",
    );
  }
  let credentialProfiles: CredentialProfileRegistry;
  try {
    credentialProfiles = await CredentialProfileRegistry.open(
      options.credentialProfiles ?? {},
    );
  } catch (error) {
    authorization.close();
    throw error;
  }
  if (options.signal?.aborted) {
    credentialProfiles.close();
    authorization.close();
    throw new Error("Server startup was aborted.");
  }
  let assets: ReadonlyMap<string, ViewerAsset>;
  let artifacts: ImportArtifactStore;
  let jobs: PersistentJobQueue;
  try {
    assets = await collectViewerAssets(
      options.viewerRoot ?? productionViewerRoot(),
    );
    artifacts = await ImportArtifactStore.open({
      dataDirectory: options.dataDirectory,
    });
    jobs = await PersistentJobQueue.open({
      dataDirectory: options.dataDirectory,
      concurrency: 1,
    });
  } catch (error) {
    credentialProfiles.close();
    authorization.close();
    throw error;
  }
  try {
    await artifacts.reconcileCityModelArtifacts(
      completedCityModelArtifactTokens(jobs),
    );
  } catch (error) {
    await jobs.close().catch(() => undefined);
    credentialProfiles.close();
    authorization.close();
    throw error;
  }
  const allowedHosts = new Set(configuredAllowedHosts);
  if (authorization.publicHostname !== undefined) {
    allowedHosts.add(authorization.publicHostname);
  }
  let artifactResponses: ArtifactResponseGate;
  let importRequests: ImportRequestOperations;
  let uploads: UploadReservationRegistry;
  let server: http.Server;
  try {
    artifactResponses = new ArtifactResponseGate();
    importRequests = new ImportRequestOperations();
    uploads = new UploadReservationRegistry(artifacts);
    server = http.createServer(
      requestHandler(
        assets,
        jobs,
        artifacts,
        artifactResponses,
        importRequests,
        uploads,
        importPolicy,
        credentialProfiles,
        options.importDependencies,
        allowedHosts,
        authorization,
      ),
    );
    server.requestTimeout =
      UPLOAD_IMPORT_LIMITS.bodyTotalTimeoutMs + 5_000;
    server.headersTimeout = 10_000;
    server.keepAliveTimeout = 5_000;
    server.maxHeadersCount = 64;
  } catch (error) {
    await jobs.close().catch(() => undefined);
    credentialProfiles.close();
    authorization.close();
    throw error;
  }

  let closePromise: Promise<void> | undefined;
  let resolveClosed: (() => void) | undefined;
  const closedPromise = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      try {
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
        await artifactResponses.waitForIdle();
        const uploadClose = uploads.close().then(
          () => ({ ok: true as const }),
          (error: unknown) => ({ ok: false as const, error }),
        );
        await importRequests.waitForIdle();
        const uploadCloseResult = await uploadClose;
        if (!uploadCloseResult.ok) throw uploadCloseResult.error;
      } finally {
        credentialProfiles.close();
        authorization.close();
        resolveClosed?.();
        await closedPromise;
      }
    })();
    return closePromise;
  };

  const onAbort = (): void => {
    void close().catch(() => undefined);
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
      artifacts,
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
