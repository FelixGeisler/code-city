import {
  DEFAULT_SNAPSHOT_LIMITS,
  materializeRepositorySnapshot,
  SnapshotDeadlineError,
  SnapshotLimitError,
  SnapshotPathError,
  SnapshotPolicyError,
  type RepositorySnapshot,
  type SnapshotOptions,
} from "./snapshot.js";
import { openZipSnapshotSource } from "./zip-snapshot-source.js";

const MEBIBYTE = 1024 * 1024;
const GITHUB_API_ORIGIN = "https://api.github.com";
const GITHUB_CODELOAD_ORIGIN = "https://codeload.github.com";
const GITHUB_API_ACCEPT = "application/vnd.github+json";
const GITHUB_API_VERSION = "2022-11-28";
const COMMIT_SHA = /^[0-9a-f]{40}$/iu;
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u;
const REPOSITORY = /^[A-Za-z0-9._-]{1,100}$/u;
const CANONICAL_REPOSITORY_URL =
  /^https:\/\/github\.com\/([^/?#]+)\/([^/?#]+)\/?$/u;
const INVALID_REF_CHARACTERS =
  /[\s\\~^:?*]|\[|\]|\p{Cc}|\p{Cf}|\p{Cs}/u;
const GITHUB_REPOSITORY_URL_MAX_CODE_UNITS = 164;
const GITHUB_REF_INPUT_MAX_CODE_UNITS = 1024;
const GITHUB_CREDENTIAL_SECRET_MAX_BYTES = 8 * 1024;

export const GITHUB_METADATA_MAX_BYTES = MEBIBYTE;
export const GITHUB_ARCHIVE_MAX_BYTES = 64 * MEBIBYTE;
export const GITHUB_ZIP_MAX_ENTRIES = 100_000;
export const GITHUB_ZIP_MAX_ENTRY_BYTES = 256 * MEBIBYTE;
export const GITHUB_ZIP_MAX_EXPANDED_BYTES = 1024 * MEBIBYTE;
export const GITHUB_REF_MAX_BYTES = 256;
export const GITHUB_SNAPSHOT_TIMEOUT_MS =
  DEFAULT_SNAPSHOT_LIMITS.timeoutMs;
export const GITHUB_SNAPSHOT_MAX_TIMEOUT_MS = 2_147_483_647;

export type GitHubSnapshotFetch = (
  input: string | URL,
  init: RequestInit,
) => Promise<Response>;

export interface GitHubSnapshotCredential {
  readonly kind: "bearer";
  readonly secret: Uint8Array;
}

export interface GitHubSnapshotCredentialProvider {
  readonly provider: "github";
  use<T>(
    signal: AbortSignal,
    operation: (
      credential: GitHubSnapshotCredential,
    ) => T | Promise<T>,
  ): Promise<T>;
}

export interface GitHubSnapshotRequest {
  readonly repositoryUrl: string;
  readonly ref?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly snapshotOptions?: SnapshotOptions;
}

export interface GitHubSnapshotDependencies {
  readonly fetch?: GitHubSnapshotFetch;
  readonly credentialProvider?: GitHubSnapshotCredentialProvider;
}

export interface GitHubSnapshotResult {
  readonly owner: string;
  readonly repository: string;
  readonly canonicalRepositoryUrl: string;
  readonly commitSha: string;
  readonly snapshot: RepositorySnapshot;
}

export type GitHubSnapshotErrorCode =
  | "GITHUB_ABORTED"
  | "GITHUB_DEADLINE_EXCEEDED"
  | "GITHUB_INVALID_REF"
  | "GITHUB_INVALID_REPOSITORY_URL"
  | "GITHUB_INVALID_REQUEST"
  | "GITHUB_INVALID_RESPONSE"
  | "GITHUB_REF_UNAVAILABLE"
  | "GITHUB_REPOSITORY_UNAVAILABLE"
  | "GITHUB_REQUEST_FAILED"
  | "GITHUB_RESPONSE_TOO_LARGE"
  | "GITHUB_SNAPSHOT_FAILED";

export class GitHubSnapshotError extends Error {
  public constructor(
    readonly code: GitHubSnapshotErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "GitHubSnapshotError";
  }
}

interface CanonicalRepository {
  readonly owner: string;
  readonly repository: string;
  readonly canonicalUrl: string;
}

function canonicalRepositoryFromFullName(
  value: unknown,
  requested: CanonicalRepository,
): CanonicalRepository | undefined {
  if (typeof value !== "string") return undefined;
  const components = value.split("/");
  if (components.length !== 2) return undefined;
  const [owner = "", repository = ""] = components;
  if (
    !OWNER.test(owner) ||
    !REPOSITORY.test(repository) ||
    repository === "." ||
    repository === ".." ||
    owner.toLocaleLowerCase("en-US") !==
      requested.owner.toLocaleLowerCase("en-US") ||
    repository.toLocaleLowerCase("en-US") !==
      requested.repository.toLocaleLowerCase("en-US")
  ) {
    return undefined;
  }
  return Object.freeze({
    owner,
    repository,
    canonicalUrl: `https://github.com/${owner}/${repository}`,
  });
}

interface CombinedDeadline {
  readonly signal: AbortSignal;
  remainingMilliseconds(): number;
}

interface JsonObject {
  readonly [key: string]: unknown;
}

const INTERNAL_ABORT = Object.freeze({ kind: "github-snapshot-abort" });

function parseCanonicalRepositoryUrl(value: string): CanonicalRepository {
  if (
    typeof value !== "string" ||
    value.length > GITHUB_REPOSITORY_URL_MAX_CODE_UNITS
  ) {
    throw new GitHubSnapshotError(
      "GITHUB_INVALID_REPOSITORY_URL",
      "GitHub repository URL must use the canonical form https://github.com/owner/repository.",
    );
  }
  const match = CANONICAL_REPOSITORY_URL.exec(value);
  if (match === null || match[0] !== value) {
    throw new GitHubSnapshotError(
      "GITHUB_INVALID_REPOSITORY_URL",
      "GitHub repository URL must use the canonical form https://github.com/owner/repository.",
    );
  }

  const owner = match[1] ?? "";
  let repository = match[2] ?? "";
  if (repository.endsWith(".git")) {
    repository = repository.slice(0, -4);
  }
  if (
    !OWNER.test(owner) ||
    !REPOSITORY.test(repository) ||
    repository === "." ||
    repository === ".."
  ) {
    throw new GitHubSnapshotError(
      "GITHUB_INVALID_REPOSITORY_URL",
      "GitHub repository URL must use the canonical form https://github.com/owner/repository.",
    );
  }

  return Object.freeze({
    owner,
    repository,
    canonicalUrl: `https://github.com/${owner}/${repository}`,
  });
}

function validateRef(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > GITHUB_REF_INPUT_MAX_CODE_UNITS
  ) {
    throw new GitHubSnapshotError(
      "GITHUB_INVALID_REF",
      `GitHub ref must be a valid reference no larger than ${GITHUB_REF_MAX_BYTES} UTF-8 bytes.`,
    );
  }
  const normalized = value.normalize("NFC");
  const byteLength = new TextEncoder().encode(normalized).byteLength;
  const components = normalized.split("/");
  if (
    normalized.length === 0 ||
    byteLength > GITHUB_REF_MAX_BYTES ||
    INVALID_REF_CHARACTERS.test(normalized) ||
    normalized === "@" ||
    normalized.startsWith("-") ||
    normalized.includes("..") ||
    normalized.includes("@{") ||
    components.some(
      (component) =>
        component.length === 0 ||
        component.startsWith(".") ||
        component.endsWith(".") ||
        component.toLowerCase().endsWith(".lock"),
    )
  ) {
    throw new GitHubSnapshotError(
      "GITHUB_INVALID_REF",
      `GitHub ref must be a valid reference no larger than ${GITHUB_REF_MAX_BYTES} UTF-8 bytes.`,
    );
  }
  return normalized;
}

/**
 * Validates and canonicalizes an anonymous public GitHub repository URL
 * without performing network or filesystem work.
 */
export function validatePublicGitHubRepositoryUrl(value: string): string {
  return parseCanonicalRepositoryUrl(value).canonicalUrl;
}

/**
 * Validates a caller-supplied GitHub ref without resolving it remotely.
 */
export function validatePublicGitHubRef(value: string): string {
  return validateRef(value);
}

function validateResponseRef(value: string): string {
  try {
    return validateRef(value);
  } catch {
    throw new GitHubSnapshotError(
      "GITHUB_INVALID_RESPONSE",
      "GitHub repository metadata did not provide a valid default branch.",
    );
  }
}

function resolveTimeout(value: number | undefined): number {
  const timeout = value ?? GITHUB_SNAPSHOT_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeout) ||
    timeout <= 0 ||
    timeout > GITHUB_SNAPSHOT_MAX_TIMEOUT_MS
  ) {
    throw new GitHubSnapshotError(
      "GITHUB_INVALID_REQUEST",
      `GitHub snapshot timeout must be between 1 and ${GITHUB_SNAPSHOT_MAX_TIMEOUT_MS.toLocaleString(
        "en-US",
      )} milliseconds.`,
    );
  }
  return timeout;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonObject(bytes: Uint8Array): JsonObject {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new GitHubSnapshotError(
      "GITHUB_INVALID_RESPONSE",
      "GitHub API returned invalid UTF-8 JSON.",
    );
  }

  try {
    const value = JSON.parse(text) as unknown;
    if (!isObject(value)) throw new TypeError("Expected an object.");
    return value;
  } catch {
    throw new GitHubSnapshotError(
      "GITHUB_INVALID_RESPONSE",
      "GitHub API returned invalid JSON.",
    );
  }
}

function checkedContentLength(
  response: Response,
  maxBytes: number,
  purpose: "API response" | "repository archive",
): void {
  const header = response.headers.get("content-length");
  if (header === null) return;
  if (!/^\d+$/u.test(header)) {
    throw new GitHubSnapshotError(
      "GITHUB_INVALID_RESPONSE",
      `GitHub ${purpose} returned an invalid Content-Length.`,
    );
  }
  const byteLength = Number(header);
  if (!Number.isSafeInteger(byteLength)) {
    throw new GitHubSnapshotError(
      "GITHUB_INVALID_RESPONSE",
      `GitHub ${purpose} returned an invalid Content-Length.`,
    );
  }
  if (byteLength > maxBytes) {
    throw new GitHubSnapshotError(
      "GITHUB_RESPONSE_TOO_LARGE",
      `GitHub ${purpose} exceeds the ${maxBytes.toLocaleString(
        "en-US",
      )}-byte download limit.`,
    );
  }
}

function cancelUnusedBody(response: Response): void {
  if (response.body === null) return;
  void response.body.cancel().catch(() => {
    // Preserve the boundary error instead of transport cleanup details.
  });
}

async function cancelUnusedBodyBeforeFollowup(
  response: Response,
  signal: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  if (response.body === null) return;
  try {
    await raceWithAbort(response.body.cancel(), signal);
  } catch (error) {
    if (error === INTERNAL_ABORT) throw error;
    // Preserve the validated redirect boundary instead of cleanup details.
  }
  throwIfAborted(signal);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw INTERNAL_ABORT;
}

async function raceWithAbort<T>(
  pending: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  throwIfAborted(signal);
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", aborted);
      callback();
    };
    const aborted = (): void => {
      finish(() => reject(INTERNAL_ABORT));
    };
    signal.addEventListener("abort", aborted, { once: true });
    Promise.resolve(pending).then(
      (value) => {
        finish(() => resolve(value));
      },
      (error: unknown) => {
        finish(() => reject(error));
      },
    );
    if (signal.aborted) aborted();
  });
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
  purpose: "API response" | "repository archive",
  signal: AbortSignal,
): Promise<Uint8Array> {
  try {
    checkedContentLength(response, maxBytes, purpose);
  } catch (error) {
    cancelUnusedBody(response);
    throw error;
  }
  if (response.body === null) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  let completed = false;
  try {
    for (;;) {
      const item = await raceWithAbort(reader.read(), signal);
      if (item.done) {
        completed = true;
        break;
      }
      if (!(item.value instanceof Uint8Array)) {
        throw new GitHubSnapshotError(
          "GITHUB_INVALID_RESPONSE",
          `GitHub ${purpose} returned an invalid byte stream.`,
        );
      }
      if (item.value.byteLength > maxBytes - byteLength) {
        throw new GitHubSnapshotError(
          "GITHUB_RESPONSE_TOO_LARGE",
          `GitHub ${purpose} exceeds the ${maxBytes.toLocaleString(
            "en-US",
          )}-byte download limit.`,
        );
      }
      byteLength += item.value.byteLength;
      chunks.push(item.value);
    }
  } finally {
    if (completed) {
      reader.releaseLock();
    } else {
      void reader
        .cancel()
        .catch(() => {
          // Preserve the boundary error that caused cancellation.
        })
        .finally(() => {
          try {
            reader.releaseLock();
          } catch {
            // Cancellation may retain the lock until the pending read settles.
          }
        });
    }
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function invalidCredential(): GitHubSnapshotError {
  return new GitHubSnapshotError(
    "GITHUB_INVALID_REQUEST",
    "GitHub credential material is invalid.",
  );
}

function validBearerSecret(secret: Uint8Array): boolean {
  if (
    secret.byteLength === 0 ||
    secret.byteLength > GITHUB_CREDENTIAL_SECRET_MAX_BYTES
  ) {
    return false;
  }
  let padding = false;
  let content = false;
  for (const byte of secret) {
    if (byte === 0x3d) {
      padding = true;
      continue;
    }
    const allowed =
      (byte >= 0x30 && byte <= 0x39) ||
      (byte >= 0x41 && byte <= 0x5a) ||
      (byte >= 0x61 && byte <= 0x7a) ||
      byte === 0x2d ||
      byte === 0x2e ||
      byte === 0x2f ||
      byte === 0x5f ||
      byte === 0x7e ||
      byte === 0x2b;
    if (padding || !allowed) return false;
    content = true;
  }
  return content;
}

function authorizationHeader(
  credential: GitHubSnapshotCredential,
): string {
  if (
    typeof credential !== "object" ||
    credential === null ||
    credential.kind !== "bearer" ||
    !(credential.secret instanceof Uint8Array) ||
    !validBearerSecret(credential.secret)
  ) {
    throw invalidCredential();
  }

  const bytes = new Uint8Array(7 + credential.secret.byteLength);
  try {
    bytes[0] = 0x42;
    bytes[1] = 0x65;
    bytes[2] = 0x61;
    bytes[3] = 0x72;
    bytes[4] = 0x65;
    bytes[5] = 0x72;
    bytes[6] = 0x20;
    bytes.set(credential.secret, 7);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } finally {
    bytes.fill(0);
  }
}

function credentialEndpoint(url: URL): boolean {
  return (
    url.origin === GITHUB_API_ORIGIN &&
    url.username === "" &&
    url.password === "" &&
    url.search === "" &&
    url.hash === ""
  );
}

function requestInit(
  url: URL,
  signal: AbortSignal,
  accept: string,
  authorization: string | undefined,
  redirect: RequestRedirect = "error",
): RequestInit {
  if (authorization !== undefined && !credentialEndpoint(url)) {
    throw new GitHubSnapshotError(
      "GITHUB_INVALID_REQUEST",
      "GitHub credentials may only be sent to exact GitHub endpoints.",
    );
  }
  return {
    method: "GET",
    cache: "no-store",
    credentials: "omit",
    redirect,
    referrerPolicy: "no-referrer",
    headers: {
      Accept: accept,
      ...(accept === GITHUB_API_ACCEPT
        ? { "X-GitHub-Api-Version": GITHUB_API_VERSION }
        : {}),
      ...(authorization === undefined
        ? {}
        : { Authorization: authorization }),
    },
    signal,
  };
}

function validateExactResponseUrl(
  response: Response,
  requestedUrl: URL,
): void {
  if (
    response.redirected ||
    response.type === "opaqueredirect" ||
    response.url === ""
  ) {
    throw new GitHubSnapshotError(
      "GITHUB_INVALID_RESPONSE",
      "GitHub response redirects are not allowed.",
    );
  }
  if (response.url !== requestedUrl.href) {
    throw new GitHubSnapshotError(
      "GITHUB_INVALID_RESPONSE",
      "GitHub response URL did not match the requested endpoint.",
    );
  }

  let responseUrl: URL;
  try {
    responseUrl = new URL(response.url);
  } catch {
    throw new GitHubSnapshotError(
      "GITHUB_INVALID_RESPONSE",
      "GitHub response URL is invalid.",
    );
  }
  if (
    responseUrl.href !== requestedUrl.href ||
    responseUrl.username !== "" ||
    responseUrl.password !== "" ||
    responseUrl.hash !== ""
  ) {
    throw new GitHubSnapshotError(
      "GITHUB_INVALID_RESPONSE",
      "GitHub response URL did not match the requested endpoint.",
    );
  }
}

async function fetchResponse(
  fetchImplementation: GitHubSnapshotFetch,
  url: URL,
  accept: string,
  signal: AbortSignal,
  authorization: string | undefined,
  redirect: RequestRedirect,
): Promise<Response> {
  let pending: Promise<Response>;
  try {
    pending = fetchImplementation(
      url.href,
      requestInit(url, signal, accept, authorization, redirect),
    );
  } catch {
    throw new GitHubSnapshotError(
      "GITHUB_REQUEST_FAILED",
      authorization === undefined
        ? "Anonymous GitHub request failed."
        : "GitHub request failed.",
    );
  }

  let response: Response;
  try {
    response = await raceWithAbort(pending, signal);
  } catch (error) {
    if (error === INTERNAL_ABORT) throw error;
    throw new GitHubSnapshotError(
      "GITHUB_REQUEST_FAILED",
      authorization === undefined
        ? "Anonymous GitHub request failed."
        : "GitHub request failed.",
    );
  }
  return response;
}

async function fetchExact(
  fetchImplementation: GitHubSnapshotFetch,
  url: URL,
  accept: string,
  signal: AbortSignal,
  authorization: string | undefined,
): Promise<Response> {
  const response = await fetchResponse(
    fetchImplementation,
    url,
    accept,
    signal,
    authorization,
    "error",
  );
  try {
    validateExactResponseUrl(response, url);
  } catch (error) {
    cancelUnusedBody(response);
    throw error;
  }
  return response;
}

async function fetchJson(
  fetchImplementation: GitHubSnapshotFetch,
  url: URL,
  signal: AbortSignal,
  unavailableCode:
    | "GITHUB_REF_UNAVAILABLE"
    | "GITHUB_REPOSITORY_UNAVAILABLE",
  authorization: string | undefined,
): Promise<JsonObject> {
  const response = await fetchExact(
    fetchImplementation,
    url,
    GITHUB_API_ACCEPT,
    signal,
    authorization,
  );
  if (
    response.status === 404 ||
    (unavailableCode === "GITHUB_REF_UNAVAILABLE" &&
      response.status === 422)
  ) {
    cancelUnusedBody(response);
    throw new GitHubSnapshotError(
      unavailableCode,
      unavailableCode === "GITHUB_REPOSITORY_UNAVAILABLE"
        ? authorization === undefined
          ? "Public GitHub repository is unavailable."
          : "GitHub repository is unavailable."
        : "Requested GitHub ref is unavailable.",
    );
  }
  if (response.status !== 200) {
    cancelUnusedBody(response);
    throw new GitHubSnapshotError(
      "GITHUB_REQUEST_FAILED",
      authorization === undefined
        ? `Anonymous GitHub API request failed with HTTP ${response.status}.`
        : `GitHub API request failed with HTTP ${response.status}.`,
    );
  }
  return parseJsonObject(
    await readBoundedBody(
      response,
      GITHUB_METADATA_MAX_BYTES,
      "API response",
      signal,
    ),
  );
}

async function fetchArchive(
  fetchImplementation: GitHubSnapshotFetch,
  url: URL,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const response = await fetchExact(
    fetchImplementation,
    url,
    "application/zip",
    signal,
    undefined,
  );
  if (response.status !== 200) {
    cancelUnusedBody(response);
    throw new GitHubSnapshotError(
      "GITHUB_REQUEST_FAILED",
      `Anonymous GitHub archive request failed with HTTP ${response.status}.`,
    );
  }
  return await readBoundedBody(
    response,
    GITHUB_ARCHIVE_MAX_BYTES,
    "repository archive",
    signal,
  );
}

function validatedCodeloadLocation(
  value: string | null,
  repository: CanonicalRepository,
  commitSha: string,
): URL {
  if (
    value === null ||
    value.length === 0 ||
    value.trim() !== value
  ) {
    throw new GitHubSnapshotError(
      "GITHUB_INVALID_RESPONSE",
      "GitHub archive redirect target was invalid.",
    );
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new GitHubSnapshotError(
      "GITHUB_INVALID_RESPONSE",
      "GitHub archive redirect target was invalid.",
    );
  }
  const rawLocation =
    /^https:\/\/codeload\.github\.com(\/[^?#]*)(?:\?[^#]*)?$/iu.exec(
      value,
    );
  const path = rawLocation?.[1];
  const components = path?.split("/");
  if (
    path === undefined ||
    components === undefined ||
    components.length !== 5 ||
    components[0] !== "" ||
    !OWNER.test(components[1] ?? "") ||
    !REPOSITORY.test(components[2] ?? "") ||
    components[1]?.toLocaleLowerCase("en-US") !==
      repository.owner.toLocaleLowerCase("en-US") ||
    components[2]?.toLocaleLowerCase("en-US") !==
      repository.repository.toLocaleLowerCase("en-US") ||
    components[3] !== "legacy.zip" ||
    components[4] !== commitSha ||
    url.protocol !== "https:" ||
    url.hostname !== "codeload.github.com" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== ""
  ) {
    throw new GitHubSnapshotError(
      "GITHUB_INVALID_RESPONSE",
      "GitHub archive redirect target was invalid.",
    );
  }
  return url;
}

async function fetchAuthenticatedArchive(
  fetchImplementation: GitHubSnapshotFetch,
  url: URL,
  signal: AbortSignal,
  authorization: string,
  repository: CanonicalRepository,
  commitSha: string,
): Promise<Uint8Array> {
  const response = await fetchResponse(
    fetchImplementation,
    url,
    GITHUB_API_ACCEPT,
    signal,
    authorization,
    "manual",
  );
  let location: URL;
  try {
    validateExactResponseUrl(response, url);
    if (response.status !== 302) {
      throw new GitHubSnapshotError(
        "GITHUB_REQUEST_FAILED",
        `GitHub archive request failed with HTTP ${response.status}.`,
      );
    }
    location = validatedCodeloadLocation(
      response.headers.get("location"),
      repository,
      commitSha,
    );
  } finally {
    await cancelUnusedBodyBeforeFollowup(response, signal);
  }
  throwIfAborted(signal);
  return await fetchArchive(fetchImplementation, location, signal);
}

function apiUrl(path: string): URL {
  const url = new URL(path, GITHUB_API_ORIGIN);
  if (url.origin !== GITHUB_API_ORIGIN) {
    throw new GitHubSnapshotError(
      "GITHUB_INVALID_RESPONSE",
      "GitHub API endpoint was rejected.",
    );
  }
  return url;
}

function codeloadUrl(path: string): URL {
  const url = new URL(path, GITHUB_CODELOAD_ORIGIN);
  if (url.origin !== GITHUB_CODELOAD_ORIGIN) {
    throw new GitHubSnapshotError(
      "GITHUB_INVALID_RESPONSE",
      "GitHub archive endpoint was rejected.",
    );
  }
  return url;
}

function safeSnapshotError(error: unknown): boolean {
  return (
    error instanceof GitHubSnapshotError ||
    error instanceof SnapshotDeadlineError ||
    error instanceof SnapshotLimitError ||
    error instanceof SnapshotPathError ||
    error instanceof SnapshotPolicyError
  );
}

async function withCombinedDeadline<T>(
  timeoutMs: number,
  callerSignals: readonly (AbortSignal | undefined)[],
  operation: (deadline: CombinedDeadline) => Promise<T>,
): Promise<T> {
  const signals = [
    ...new Set(callerSignals.filter((signal) => signal !== undefined)),
  ] as AbortSignal[];
  if (signals.some((signal) => signal.aborted)) {
    throw new GitHubSnapshotError(
      "GITHUB_ABORTED",
      "GitHub snapshot request was cancelled.",
    );
  }

  const controller = new AbortController();
  const deadlineAt = Date.now() + timeoutMs;
  let abortReason: "caller" | "deadline" | undefined;
  const abortFromCaller = (): void => {
    abortReason ??= "caller";
    controller.abort();
  };
  for (const signal of signals) {
    signal.addEventListener("abort", abortFromCaller, { once: true });
  }
  if (signals.some((signal) => signal.aborted)) {
    abortFromCaller();
  }
  const timer = globalThis.setTimeout(() => {
    abortReason ??= "deadline";
    controller.abort();
  }, timeoutMs);

  const deadline: CombinedDeadline = {
    signal: controller.signal,
    remainingMilliseconds: () => {
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) {
        abortReason ??= "deadline";
        controller.abort();
        throw INTERNAL_ABORT;
      }
      return remaining;
    },
  };

  try {
    const result = await operation(deadline);
    throwIfAborted(controller.signal);
    return result;
  } catch (error) {
    if (abortReason === "deadline") {
      throw new GitHubSnapshotError(
        "GITHUB_DEADLINE_EXCEEDED",
        `GitHub snapshot exceeded the ${timeoutMs.toLocaleString(
          "en-US",
        )} ms deadline.`,
      );
    }
    if (abortReason === "caller" || error === INTERNAL_ABORT) {
      throw new GitHubSnapshotError(
        "GITHUB_ABORTED",
        "GitHub snapshot request was cancelled.",
      );
    }
    throw error;
  } finally {
    globalThis.clearTimeout(timer);
    for (const signal of signals) {
      signal.removeEventListener("abort", abortFromCaller);
    }
  }
}

function materializationOptions(
  options: SnapshotOptions | undefined,
  deadline: CombinedDeadline,
): SnapshotOptions {
  const remaining = deadline.remainingMilliseconds();
  const requestedTimeout = options?.timeoutMs;
  const timeoutMs =
    requestedTimeout === undefined
      ? remaining
      : Math.min(requestedTimeout, remaining);
  const {
    signal: _callerSignal,
    timeoutMs: _callerTimeout,
    ...otherOptions
  } = options ?? {};
  return {
    ...otherOptions,
    timeoutMs,
    signal: deadline.signal,
  };
}

interface GitHubNetworkSnapshot {
  readonly canonicalRepository: CanonicalRepository;
  readonly commitSha: string;
  readonly archive: Uint8Array;
}

async function fetchGitHubNetworkSnapshot(
  repository: CanonicalRepository,
  requestedRef: string | undefined,
  fetchImplementation: GitHubSnapshotFetch,
  signal: AbortSignal,
  authorization: string | undefined,
): Promise<GitHubNetworkSnapshot> {
  const metadataUrl = apiUrl(
    `/repos/${repository.owner}/${repository.repository}`,
  );
  const metadata = await fetchJson(
    fetchImplementation,
    metadataUrl,
    signal,
    "GITHUB_REPOSITORY_UNAVAILABLE",
    authorization,
  );
  const canonicalRepository = canonicalRepositoryFromFullName(
    metadata["full_name"],
    repository,
  );
  const publicRepository =
    metadata["private"] === false &&
    metadata["visibility"] === "public";
  const privateRepository =
    metadata["private"] === true &&
    metadata["visibility"] === "private";
  const internalRepository =
    typeof metadata["private"] === "boolean" &&
    metadata["visibility"] === "internal";
  const authenticatedRestrictedRepository =
    authorization !== undefined &&
    (privateRepository || internalRepository);
  if (
    canonicalRepository === undefined ||
    (!publicRepository && !authenticatedRestrictedRepository)
  ) {
    throw new GitHubSnapshotError(
      "GITHUB_REPOSITORY_UNAVAILABLE",
      authorization === undefined
        ? "Public GitHub repository is unavailable."
        : "GitHub repository is unavailable.",
    );
  }

  const selectedRef =
    requestedRef ??
    (typeof metadata["default_branch"] === "string"
      ? validateResponseRef(metadata["default_branch"])
      : undefined);
  if (selectedRef === undefined) {
    throw new GitHubSnapshotError(
      "GITHUB_INVALID_RESPONSE",
      "GitHub repository metadata did not provide a valid default branch.",
    );
  }

  const commitUrl = apiUrl(
    `/repos/${canonicalRepository.owner}/${canonicalRepository.repository}/commits/${encodeURIComponent(
      selectedRef,
    )}`,
  );
  const commit = await fetchJson(
    fetchImplementation,
    commitUrl,
    signal,
    "GITHUB_REF_UNAVAILABLE",
    authorization,
  );
  const commitValue = commit["sha"];
  if (
    typeof commitValue !== "string" ||
    !COMMIT_SHA.test(commitValue)
  ) {
    throw new GitHubSnapshotError(
      "GITHUB_INVALID_RESPONSE",
      "GitHub API did not return an exact commit SHA.",
    );
  }
  const commitSha = commitValue.toLowerCase();

  const archive =
    authorization === undefined
      ? await fetchArchive(
          fetchImplementation,
          codeloadUrl(
            `/${canonicalRepository.owner}/${canonicalRepository.repository}/zip/${commitSha}`,
          ),
          signal,
        )
      : await fetchAuthenticatedArchive(
          fetchImplementation,
          apiUrl(
            `/repos/${canonicalRepository.owner}/${canonicalRepository.repository}/zipball/${commitSha}`,
          ),
          signal,
          authorization,
          canonicalRepository,
          commitSha,
        );
  return { canonicalRepository, commitSha, archive };
}

export async function snapshotPublicGitHubRepository(
  request: GitHubSnapshotRequest,
  dependencies: GitHubSnapshotDependencies = {},
): Promise<GitHubSnapshotResult> {
  const repository = parseCanonicalRepositoryUrl(request.repositoryUrl);
  const requestedRef =
    request.ref === undefined ? undefined : validateRef(request.ref);
  const timeoutMs = resolveTimeout(request.timeoutMs);
  const fetchImplementation =
    dependencies.fetch ??
    ((input, init) => globalThis.fetch(input, init));
  const credentialProvider = dependencies.credentialProvider;
  if (
    credentialProvider !== undefined &&
    (credentialProvider.provider !== "github" ||
      typeof credentialProvider.use !== "function")
  ) {
    throw new GitHubSnapshotError(
      "GITHUB_INVALID_REQUEST",
      "GitHub credential provider is invalid.",
    );
  }

  try {
    return await withCombinedDeadline(
      timeoutMs,
      [request.signal, request.snapshotOptions?.signal],
      async (deadline) => {
        const network =
          credentialProvider === undefined
            ? await fetchGitHubNetworkSnapshot(
                repository,
                requestedRef,
                fetchImplementation,
                deadline.signal,
                undefined,
              )
            : await credentialProvider.use(
                deadline.signal,
                async (credential) => {
                  let authorization: string | undefined =
                    authorizationHeader(credential);
                  try {
                    return await fetchGitHubNetworkSnapshot(
                      repository,
                      requestedRef,
                      fetchImplementation,
                      deadline.signal,
                      authorization,
                    );
                  } finally {
                    authorization = undefined;
                  }
                },
              );
        const { canonicalRepository, commitSha, archive } = network;
        const source = openZipSnapshotSource(
          archive,
          canonicalRepository.repository,
          {
            maxArchiveBytes: GITHUB_ARCHIVE_MAX_BYTES,
            maxEntries: GITHUB_ZIP_MAX_ENTRIES,
            maxEntryBytes: GITHUB_ZIP_MAX_ENTRY_BYTES,
            maxExpandedBytes: GITHUB_ZIP_MAX_EXPANDED_BYTES,
            signal: deadline.signal,
          },
        );
        try {
          const snapshot = await materializeRepositorySnapshot(
            source,
            materializationOptions(request.snapshotOptions, deadline),
          );
          return Object.freeze({
            owner: canonicalRepository.owner,
            repository: canonicalRepository.repository,
            canonicalRepositoryUrl: canonicalRepository.canonicalUrl,
            commitSha,
            snapshot,
          });
        } finally {
          await source.dispose();
        }
      },
    );
  } catch (error) {
    if (safeSnapshotError(error)) throw error;
    throw new GitHubSnapshotError(
      "GITHUB_SNAPSHOT_FAILED",
      "GitHub repository archive could not be processed safely.",
    );
  }
}
