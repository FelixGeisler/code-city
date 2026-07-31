import { EVOLUTION_BUNDLE_LIMITS } from "../../../packages/core/src/evolution.js";

const API_RESPONSE_MAX_BYTES = 256 * 1024;
const SOURCE_RESPONSE_MAX_BYTES = 16 * 1024 * 1024 * 6 + 64 * 1024;
const API_REQUEST_DEADLINE_MS = 30_000;
const API_UPLOAD_DEADLINE_MS = 11 * 60_000;
const API_RESULT_REMOVAL_DEADLINE_MS = 31 * 60_000;
const EVOLUTION_ARTIFACT_DEADLINE_MS = 31 * 60_000;
const MAXIMUM_ERROR_FIELDS = 64;
const MAXIMUM_TEXT_CHARACTERS = 2_048;
const MAXIMUM_EVOLUTION_ARTIFACT_BYTES =
  EVOLUTION_BUNDLE_LIMITS.serializedBytes;
const MAXIMUM_EVOLUTION_ARTIFACT_MEBIBYTES =
  MAXIMUM_EVOLUTION_ARTIFACT_BYTES / (1024 * 1024);
const MAXIMUM_SOURCE_ARTIFACT_BYTES = 128 * 1024 * 1024;

export const IMPORT_JOB_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PROFILE_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;
const ERROR_CODE_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;
const AUTHORIZATION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const FIELD_PATH_PATTERN =
  /^\$(?:\.[A-Za-z][A-Za-z0-9]*|\[[0-9]+\])*$/u;
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Cs}]/u;

export type ImportAuthorizationMode =
  | "shared-secret"
  | "trusted-network";

export interface ImportAuthorizationStatus {
  readonly mode: ImportAuthorizationMode;
  readonly required: boolean;
  readonly authenticated: boolean;
}

export type ImportCredentialProvider =
  | "github"
  | "azure-devops"
  | "generic-https";

export interface ImportCredentialProfile {
  readonly id: string;
  readonly label: string;
  readonly provider: ImportCredentialProvider;
}

export type ImportRevision =
  | {
      readonly kind: "branch" | "tag";
      readonly name: string;
    }
  | {
      readonly kind: "commit";
      readonly sha: string;
    };

export interface ImportIdentityOptions {
  readonly title?: string;
  readonly version?: string;
  readonly logo?: string;
}

export interface ImportAnalysisOptions {
  readonly maxRetainedFiles?: number;
  readonly maxFileBytes?: number;
  readonly maxTotalBytes?: number;
  readonly timeoutMs?: number;
}

export interface RemoteImportHistoryBounds {
  readonly sampleEvery?: number;
  readonly totalDeadlineMs?: number;
  readonly maxAggregateChangedPaths?: number;
  readonly maxAggregateChangedPathBytes?: number;
  readonly maxAggregateSemanticBytes?: number;
  readonly maxAggregateTreeEntries?: number;
  readonly maxUniqueLineages?: number;
  readonly maxEvolutionOutputBytes?: number;
}

export type RemoteImportHistorySelection =
  | (RemoteImportHistoryBounds & {
      readonly mode: "commit-count";
      readonly commitCount: number;
    })
  | (RemoteImportHistoryBounds & {
      readonly mode: "date-range";
      readonly fromInclusive: string;
      readonly toInclusive: string;
      readonly maxCommits: number;
    })
  | (RemoteImportHistoryBounds & {
      readonly mode: "tag-range";
      readonly oldestTagName: string;
      readonly newestTagName: string;
      readonly maxCommits: number;
    });

export interface RemoteImportSubmission {
  readonly source: {
    readonly kind: "github" | "git";
    readonly repositoryUrl: string;
    readonly credentialProfileId?: string;
    readonly revision?: ImportRevision;
  };
  readonly history?: RemoteImportHistorySelection;
  readonly identity?: ImportIdentityOptions;
  readonly analysis?: ImportAnalysisOptions;
}

export type UploadImportSubmission =
  | {
      readonly source: {
        readonly kind: "city-model";
        readonly sizeBytes: number;
      };
    }
  | {
      readonly source: {
        readonly kind: "repository-zip";
        readonly sizeBytes: number;
        readonly repositoryName: string;
        readonly rootMode: "single-directory" | "archive-root";
      };
      readonly identity?: ImportIdentityOptions;
      readonly analysis?: ImportAnalysisOptions;
    };

export type ImportJobState =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface ImportJobProgress {
  readonly phase: string;
  readonly current?: number;
  readonly total?: number;
}

export type ImportJobErrorCode =
  | "analysis-failed"
  | "cancelled"
  | "city-model-invalid"
  | "deadline-exceeded"
  | "failed"
  | "import-limit-exceeded"
  | "interrupted"
  | "repository-content-rejected"
  | "repository-unavailable"
  | "revision-unavailable";

export interface ImportJobError {
  readonly code: ImportJobErrorCode;
  readonly message: string;
}

export interface ImportJobResult {
  readonly kind: "city-model";
  readonly artifactToken: string;
  readonly artifactUrl: string;
  readonly evolution?: {
    readonly artifactUrl: string;
    readonly size: number;
    readonly sha256: string;
  };
  readonly source?:
    | {
        readonly availability: "disabled";
      }
    | {
        readonly availability: "not-captured";
      }
    | {
        readonly availability: "retained";
        readonly artifactUrl: string;
        readonly size: number;
        readonly sha256: string;
        readonly indexSha256: string;
      };
}

export interface ImportJob {
  readonly id: string;
  readonly kind: "project-import";
  readonly state: ImportJobState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly progress?: ImportJobProgress;
  readonly error?: ImportJobError;
  readonly result?: ImportJobResult;
}

export interface ImportUploadReservation {
  readonly token: string;
  readonly uploadUrl: string;
  readonly mediaType: "application/json" | "application/zip";
  readonly sizeBytes: number;
  readonly expiresAt: string;
}

export interface ImportFieldError {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export type ImportApiErrorKind =
  | "aborted"
  | "deadline"
  | "http"
  | "network"
  | "protocol";

export class ImportApiError extends Error {
  public override readonly name = "ImportApiError";

  public constructor(
    public readonly kind: ImportApiErrorKind,
    message: string,
    public readonly details: {
      readonly status?: number;
      readonly code?: string;
      readonly fields?: readonly ImportFieldError[];
      readonly retryAfterMs?: number;
    } = {},
  ) {
    super(message);
  }

  public get retryable(): boolean {
    if (this.kind === "network" || this.kind === "deadline") return true;
    const status = this.details.status;
    return (
      this.kind === "http" &&
      status !== undefined &&
      (status === 408 || status === 429 || status >= 500)
    );
  }
}

export type ImportApiFetch = (
  input: string | URL,
  init: RequestInit,
) => Promise<Response>;

export interface ViewerImportApiClientOptions {
  readonly fetch?: ImportApiFetch;
  readonly requestDeadlineMs?: number;
  readonly uploadDeadlineMs?: number;
  readonly removalDeadlineMs?: number;
  readonly scheduleDeadline?: (
    callback: () => void,
    milliseconds: number,
  ) => unknown;
  readonly clearDeadline?: (handle: unknown) => void;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function exactObject(
  value: unknown,
  keys: readonly string[],
  description: string,
): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw protocolError(`${description} is not a JSON object.`);
  }
  const object = value as Record<string, unknown>;
  const actual = Object.keys(object).sort(compareText);
  const expected = [...keys].sort(compareText);
  if (
    actual.length !== expected.length ||
    !actual.every((key, index) => key === expected[index])
  ) {
    throw protocolError(`${description} has an invalid shape.`);
  }
  return object;
}

function safeText(
  value: unknown,
  description: string,
  maximum = MAXIMUM_TEXT_CHARACTERS,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    UNSAFE_TEXT.test(value)
  ) {
    throw protocolError(`${description} is invalid.`);
  }
  return value;
}

function safeIsoDate(value: unknown, description: string): string {
  const date = safeText(value, description, 40);
  if (Number.isNaN(Date.parse(date))) {
    throw protocolError(`${description} is invalid.`);
  }
  return date;
}

function protocolError(message: string): ImportApiError {
  return new ImportApiError("protocol", message);
}

function evolutionArtifactTooLargeFailure(): ImportApiError {
  return protocolError(
    `Evolution artifact exceeds the browser-safe ${MAXIMUM_EVOLUTION_ARTIFACT_MEBIBYTES} MiB limit. Re-import with fewer history frames or a lower maxEvolutionOutputBytes.`,
  );
}

function parseAuthorizationStatus(value: unknown): ImportAuthorizationStatus {
  const object = exactObject(
    value,
    ["authenticated", "mode", "required"],
    "Authorization status",
  );
  const mode = object["mode"];
  const required = object["required"];
  const authenticated = object["authenticated"];
  if (
    (mode !== "shared-secret" && mode !== "trusted-network") ||
    typeof required !== "boolean" ||
    typeof authenticated !== "boolean" ||
    (mode === "shared-secret" && !required) ||
    (mode === "trusted-network" && (required || authenticated))
  ) {
    throw protocolError("Authorization status is inconsistent.");
  }
  return Object.freeze({ mode, required, authenticated });
}

export function parseAuthorizationResponse(
  value: unknown,
): ImportAuthorizationStatus {
  const root = exactObject(
    value,
    ["authorization"],
    "Authorization response",
  );
  return parseAuthorizationStatus(root["authorization"]);
}

function parseCredentialProfile(value: unknown): ImportCredentialProfile {
  const object = exactObject(
    value,
    ["id", "label", "provider"],
    "Credential profile",
  );
  const id = safeText(object["id"], "Credential profile id", 64);
  const label = safeText(object["label"], "Credential profile label", 80);
  const provider = object["provider"];
  if (
    !PROFILE_ID_PATTERN.test(id) ||
    (provider !== "github" &&
      provider !== "azure-devops" &&
      provider !== "generic-https")
  ) {
    throw protocolError("Credential profile is invalid.");
  }
  return Object.freeze({ id, label, provider });
}

export function parseCapabilitiesResponse(
  value: unknown,
): readonly ImportCredentialProfile[] {
  const root = exactObject(
    value,
    ["credentialProfiles"],
    "Import capability response",
  );
  const profiles = root["credentialProfiles"];
  if (!Array.isArray(profiles) || profiles.length > 64) {
    throw protocolError("Credential profile list is invalid.");
  }
  const parsed = profiles.map(parseCredentialProfile);
  const ids = new Set<string>();
  for (let index = 0; index < parsed.length; index += 1) {
    const profile = parsed[index]!;
    if (
      ids.has(profile.id) ||
      (index > 0 && parsed[index - 1]!.id >= profile.id)
    ) {
      throw protocolError(
        "Credential profiles must have unique, sorted identifiers.",
      );
    }
    ids.add(profile.id);
  }
  return Object.freeze(parsed);
}

function parseJobProgress(value: unknown): ImportJobProgress {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw protocolError("Import job progress is invalid.");
  }
  const candidate = value as Record<string, unknown>;
  const currentPresent = Object.hasOwn(candidate, "current");
  const totalPresent = Object.hasOwn(candidate, "total");
  const object = exactObject(
    value,
    [
      "phase",
      ...(currentPresent ? ["current"] : []),
      ...(totalPresent ? ["total"] : []),
    ],
    "Import job progress",
  );
  const phase = safeText(object["phase"], "Import job phase", 160);
  const current = object["current"];
  const total = object["total"];
  if (
    (currentPresent &&
      (!Number.isSafeInteger(current) || (current as number) < 0)) ||
    (totalPresent &&
      (!Number.isSafeInteger(total) || (total as number) < 0)) ||
    (currentPresent &&
      totalPresent &&
      (current as number) > (total as number))
  ) {
    throw protocolError("Import job progress is invalid.");
  }
  return Object.freeze({
    phase,
    ...(currentPresent ? { current: current as number } : {}),
    ...(totalPresent ? { total: total as number } : {}),
  });
}

function isJobErrorCode(value: unknown): value is ImportJobErrorCode {
  return (
    value === "analysis-failed" ||
    value === "cancelled" ||
    value === "city-model-invalid" ||
    value === "deadline-exceeded" ||
    value === "failed" ||
    value === "import-limit-exceeded" ||
    value === "interrupted" ||
    value === "repository-content-rejected" ||
    value === "repository-unavailable" ||
    value === "revision-unavailable"
  );
}

function parseJobError(value: unknown): ImportJobError {
  const object = exactObject(
    value,
    ["code", "message"],
    "Import job error",
  );
  const code = object["code"];
  if (!isJobErrorCode(code)) {
    throw protocolError("Import job error code is invalid.");
  }
  return Object.freeze({
    code,
    message: safeText(object["message"], "Import job error message", 1_024),
  });
}

function parseJobResult(value: unknown, jobId: string): ImportJobResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw protocolError("Import job result is invalid.");
  }
  const candidate = value as Record<string, unknown>;
  const evolutionPresent = Object.hasOwn(candidate, "evolution");
  const sourcePresent = Object.hasOwn(candidate, "source");
  const object = exactObject(
    value,
    [
      "artifactToken",
      "artifactUrl",
      "kind",
      ...(evolutionPresent ? ["evolution"] : []),
      ...(sourcePresent ? ["source"] : []),
    ],
    "Import job result",
  );
  const token = object["artifactToken"];
  const artifactUrl = object["artifactUrl"];
  if (
    object["kind"] !== "city-model" ||
    token !== jobId ||
    artifactUrl !== `/api/v1/artifacts/${jobId}/city-model.json`
  ) {
    throw protocolError("Import job result is invalid.");
  }
  let evolution: ImportJobResult["evolution"];
  if (evolutionPresent) {
    const evolutionObject = exactObject(
      object["evolution"],
      ["artifactUrl", "sha256", "size"],
      "Import evolution result",
    );
    const size = evolutionObject["size"];
    const sha256 = evolutionObject["sha256"];
    if (
      Number.isSafeInteger(size) &&
      (size as number) > MAXIMUM_EVOLUTION_ARTIFACT_BYTES
    ) {
      throw evolutionArtifactTooLargeFailure();
    }
    if (
      evolutionObject["artifactUrl"] !==
        `/api/v1/artifacts/${jobId}/evolution.json` ||
      !Number.isSafeInteger(size) ||
      (size as number) < 1 ||
      typeof sha256 !== "string" ||
      !/^[0-9a-f]{64}$/u.test(sha256)
    ) {
      throw protocolError("Import evolution result is invalid.");
    }
    evolution = Object.freeze({
      artifactUrl: evolutionObject["artifactUrl"],
      size: size as number,
      sha256,
    });
  }
  let source: ImportJobResult["source"];
  if (sourcePresent) {
    if (
      typeof object["source"] !== "object" ||
      object["source"] === null ||
      Array.isArray(object["source"])
    ) {
      throw protocolError("Import source result is invalid.");
    }
    const sourceCandidate = object["source"] as Record<string, unknown>;
    if (
      sourceCandidate["availability"] === "disabled" ||
      sourceCandidate["availability"] === "not-captured"
    ) {
      exactObject(
        sourceCandidate,
        ["availability"],
        "Import source result",
      );
      source = Object.freeze({
        availability: sourceCandidate["availability"],
      });
    } else {
      const sourceObject = exactObject(
        sourceCandidate,
        [
          "artifactUrl",
          "availability",
          "indexSha256",
          "sha256",
          "size",
        ],
        "Import source result",
      );
      const size = sourceObject["size"];
      const sha256 = sourceObject["sha256"];
      const indexSha256 = sourceObject["indexSha256"];
      if (
        sourceObject["availability"] !== "retained" ||
        sourceObject["artifactUrl"] !==
          `/api/v1/artifacts/${jobId}/source` ||
        !Number.isSafeInteger(size) ||
        (size as number) < 1 ||
        (size as number) > MAXIMUM_SOURCE_ARTIFACT_BYTES ||
        typeof sha256 !== "string" ||
        !/^[0-9a-f]{64}$/u.test(sha256) ||
        typeof indexSha256 !== "string" ||
        !/^[0-9a-f]{64}$/u.test(indexSha256)
      ) {
        throw protocolError("Import source result is invalid.");
      }
      source = Object.freeze({
        availability: "retained",
        artifactUrl: sourceObject["artifactUrl"],
        size: size as number,
        sha256,
        indexSha256,
      });
    }
  }
  return Object.freeze({
    kind: "city-model",
    artifactToken: jobId,
    artifactUrl,
    ...(evolution === undefined ? {} : { evolution }),
    ...(source === undefined ? {} : { source }),
  });
}

export function parseImportJob(
  value: unknown,
  expectedId?: string,
): ImportJob {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw protocolError("Import job is invalid.");
  }
  const candidate = value as Record<string, unknown>;
  const progressPresent = Object.hasOwn(candidate, "progress");
  const errorPresent = Object.hasOwn(candidate, "error");
  const resultPresent = Object.hasOwn(candidate, "result");
  const object = exactObject(
    value,
    [
      "createdAt",
      "id",
      "kind",
      "state",
      "updatedAt",
      ...(progressPresent ? ["progress"] : []),
      ...(errorPresent ? ["error"] : []),
      ...(resultPresent ? ["result"] : []),
    ],
    "Import job",
  );
  const id = safeText(object["id"], "Import job id", 36);
  const state = object["state"];
  if (
    !IMPORT_JOB_ID_PATTERN.test(id) ||
    (expectedId !== undefined && id !== expectedId) ||
    object["kind"] !== "project-import" ||
    (state !== "queued" &&
      state !== "running" &&
      state !== "completed" &&
      state !== "failed" &&
      state !== "cancelled")
  ) {
    throw protocolError("Import job identity or state is invalid.");
  }
  if (
    ((state === "queued" || state === "running") &&
      (errorPresent || resultPresent)) ||
    (state === "completed" && (!resultPresent || errorPresent)) ||
    ((state === "failed" || state === "cancelled") &&
      (!errorPresent || resultPresent))
  ) {
    throw protocolError("Import job terminal data is inconsistent.");
  }
  const progress = progressPresent
    ? parseJobProgress(object["progress"])
    : undefined;
  const error = errorPresent ? parseJobError(object["error"]) : undefined;
  const result = resultPresent
    ? parseJobResult(object["result"], id)
    : undefined;
  return Object.freeze({
    id,
    kind: "project-import",
    state,
    createdAt: safeIsoDate(object["createdAt"], "Import job creation time"),
    updatedAt: safeIsoDate(object["updatedAt"], "Import job update time"),
    ...(progress === undefined ? {} : { progress }),
    ...(error === undefined ? {} : { error }),
    ...(result === undefined ? {} : { result }),
  });
}

export function parseImportJobResponse(
  value: unknown,
  expectedId?: string,
): ImportJob {
  const root = exactObject(value, ["job"], "Import job response");
  return parseImportJob(root["job"], expectedId);
}

export function parseUploadReservationResponse(
  value: unknown,
  request: UploadImportSubmission,
): ImportUploadReservation {
  const root = exactObject(
    value,
    ["upload"],
    "Upload reservation response",
  );
  const object = exactObject(
    root["upload"],
    ["expiresAt", "mediaType", "sizeBytes", "token", "uploadUrl"],
    "Upload reservation",
  );
  const token = safeText(object["token"], "Upload reservation token", 36);
  const expectedMediaType =
    request.source.kind === "city-model"
      ? "application/json"
      : "application/zip";
  if (
    !IMPORT_JOB_ID_PATTERN.test(token) ||
    object["uploadUrl"] !== `/api/v1/imports/uploads/${token}` ||
    object["mediaType"] !== expectedMediaType ||
    object["sizeBytes"] !== request.source.sizeBytes
  ) {
    throw protocolError("Upload reservation is inconsistent.");
  }
  return Object.freeze({
    token,
    uploadUrl: object["uploadUrl"],
    mediaType: expectedMediaType,
    sizeBytes: request.source.sizeBytes,
    expiresAt: safeIsoDate(
      object["expiresAt"],
      "Upload reservation expiry",
    ),
  });
}

function parseFieldError(value: unknown): ImportFieldError {
  const object = exactObject(
    value,
    ["code", "message", "path"],
    "Import field error",
  );
  const code = safeText(object["code"], "Import field error code", 64);
  const path = safeText(object["path"], "Import field path", 256);
  if (!ERROR_CODE_PATTERN.test(code) || !FIELD_PATH_PATTERN.test(path)) {
    throw protocolError("Import field error is invalid.");
  }
  return Object.freeze({
    code,
    path,
    message: safeText(
      object["message"],
      "Import field error message",
      1_024,
    ),
  });
}

function retryAfterMilliseconds(response: Response): number | undefined {
  const raw = response.headers.get("retry-after");
  if (raw === null || !/^(?:[1-9]|[1-5][0-9]|60)$/u.test(raw)) {
    return undefined;
  }
  return Number(raw) * 1_000;
}

function parseErrorResponse(
  value: unknown,
  response: Response,
): ImportApiError {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw protocolError("API error response is invalid.");
    }
    const rootCandidate = value as Record<string, unknown>;
    const errorValue = rootCandidate["error"];
    if (
      typeof errorValue !== "object" ||
      errorValue === null ||
      Array.isArray(errorValue)
    ) {
      throw protocolError("API error response is invalid.");
    }
    const errorCandidate = errorValue as Record<string, unknown>;
    const fieldsPresent = Object.hasOwn(errorCandidate, "fields");
    const root = exactObject(value, ["error"], "API error response");
    const object = exactObject(
      root["error"],
      ["code", "message", ...(fieldsPresent ? ["fields"] : [])],
      "API error",
    );
    const code = safeText(object["code"], "API error code", 64);
    const message = safeText(object["message"], "API error message", 1_024);
    if (!ERROR_CODE_PATTERN.test(code)) {
      throw protocolError("API error code is invalid.");
    }
    let fields: readonly ImportFieldError[] | undefined;
    if (fieldsPresent) {
      if (
        !Array.isArray(object["fields"]) ||
        object["fields"].length > MAXIMUM_ERROR_FIELDS
      ) {
        throw protocolError("API field errors are invalid.");
      }
      fields = Object.freeze(object["fields"].map(parseFieldError));
    }
    const retryAfterMs = retryAfterMilliseconds(response);
    return new ImportApiError("http", message, {
      status: response.status,
      code,
      ...(fields === undefined ? {} : { fields }),
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    });
  } catch {
    const retryAfterMs = retryAfterMilliseconds(response);
    return new ImportApiError(
      "http",
      `Code City request failed with HTTP ${response.status}.`,
      {
        status: response.status,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      },
    );
  }
}

function abortFailure(): DOMException {
  return new DOMException("The import request was cancelled.", "AbortError");
}

async function waitForAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw abortFailure();
  return await new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(abortFailure());
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

async function readBoundedBytes(
  response: Response,
  signal: AbortSignal,
  maximumBytes = API_RESPONSE_MAX_BYTES,
): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^\d+$/u.test(contentLength)) {
      throw protocolError("API response Content-Length is invalid.");
    }
    const length = Number(contentLength);
    if (
      !Number.isSafeInteger(length) ||
      length > maximumBytes
    ) {
      throw protocolError("API response exceeds the viewer limit.");
    }
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let complete = false;
  try {
    for (;;) {
      const item = await waitForAbort(reader.read(), signal);
      if (item.done) {
        complete = true;
        break;
      }
      if (item.value.byteLength > maximumBytes - size) {
        throw protocolError("API response exceeds the viewer limit.");
      }
      size += item.value.byteLength;
      chunks.push(item.value);
    }
  } finally {
    if (!complete) {
      void reader.cancel().catch(() => undefined);
    } else {
      reader.releaseLock();
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export type EvolutionArtifactBufferAllocator = (
  byteLength: number,
) => ArrayBuffer;

/**
 * Reads an evolution response into its one final, owned transfer buffer.
 *
 * The declared length is authenticated metadata from the completed job. A
 * single exact allocation means the number of response chunks cannot multiply
 * retained binary memory, while copying each chunk protects the result from
 * response-owned storage before the buffer is transferred to the worker.
 */
export async function readExactEvolutionArtifact(
  response: Response,
  signal: AbortSignal,
  expectedBytes: number,
  allocate: EvolutionArtifactBufferAllocator = (byteLength) =>
    new ArrayBuffer(byteLength),
): Promise<ArrayBuffer> {
  if (
    !Number.isSafeInteger(expectedBytes) ||
    expectedBytes < 1
  ) {
    throw protocolError("Evolution artifact size is invalid.");
  }
  if (expectedBytes > MAXIMUM_EVOLUTION_ARTIFACT_BYTES) {
    throw evolutionArtifactTooLargeFailure();
  }
  const body = response.body;
  if (
    response.headers.get("content-length") !== String(expectedBytes) ||
    body === null
  ) {
    if (body !== null) {
      void body.cancel().catch(() => undefined);
    }
    throw protocolError("Evolution artifact size does not match.");
  }
  if (signal.aborted) {
    void body.cancel().catch(() => undefined);
    throw abortFailure();
  }

  let buffer: ArrayBuffer;
  try {
    buffer = allocate(expectedBytes);
    if (
      !(buffer instanceof ArrayBuffer) ||
      buffer.byteLength !== expectedBytes
    ) {
      throw new TypeError("The artifact allocator returned an invalid buffer.");
    }
  } catch {
    void body.cancel().catch(() => undefined);
    throw protocolError(
      `The evolution artifact could not fit in browser memory. Re-import with fewer history frames or a lower maxEvolutionOutputBytes (maximum ${MAXIMUM_EVOLUTION_ARTIFACT_MEBIBYTES} MiB).`,
    );
  }

  const destination = new Uint8Array(buffer);
  const reader = body.getReader();
  let offset = 0;
  let complete = false;
  try {
    for (;;) {
      const item = await waitForAbort(reader.read(), signal);
      if (item.done) {
        complete = true;
        break;
      }
      if (item.value.byteLength > expectedBytes - offset) {
        throw protocolError("Evolution artifact size does not match.");
      }
      destination.set(item.value, offset);
      offset += item.value.byteLength;
    }
  } finally {
    if (!complete) {
      void reader.cancel().catch(() => undefined);
    } else {
      reader.releaseLock();
    }
  }
  if (offset !== expectedBytes) {
    throw protocolError("Evolution artifact size does not match.");
  }
  return buffer;
}

async function readJsonResponse(
  response: Response,
  signal: AbortSignal,
  maximumBytes = API_RESPONSE_MAX_BYTES,
): Promise<unknown> {
  const contentType = response.headers.get("content-type");
  if (
    contentType === null ||
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(contentType)
  ) {
    throw protocolError("API response is not UTF-8 JSON.");
  }
  const bytes = await readBoundedBytes(response, signal, maximumBytes);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw protocolError("API response is not valid UTF-8.");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw protocolError("API response is not valid JSON.");
  }
}

export class ViewerImportApiClient {
  private readonly origin: string;
  private readonly fetchImplementation: ImportApiFetch;
  private readonly requestDeadlineMs: number;
  private readonly uploadDeadlineMs: number;
  private readonly removalDeadlineMs: number;
  private readonly scheduleDeadline: (
    callback: () => void,
    milliseconds: number,
  ) => unknown;
  private readonly clearDeadline: (handle: unknown) => void;

  public constructor(
    viewerUrl: URL,
    options: ViewerImportApiClientOptions = {},
  ) {
    const base = new URL(viewerUrl.href);
    if (
      (base.protocol !== "http:" && base.protocol !== "https:") ||
      base.username !== "" ||
      base.password !== ""
    ) {
      throw new TypeError(
        "The import API requires a credential-free HTTP(S) viewer URL.",
      );
    }
    this.origin = base.origin;
    this.fetchImplementation =
      options.fetch ??
      ((input, init) => globalThis.fetch(input, init));
    this.requestDeadlineMs =
      options.requestDeadlineMs ?? API_REQUEST_DEADLINE_MS;
    this.uploadDeadlineMs =
      options.uploadDeadlineMs ?? API_UPLOAD_DEADLINE_MS;
    this.removalDeadlineMs =
      options.removalDeadlineMs ?? API_RESULT_REMOVAL_DEADLINE_MS;
    for (const [name, value] of [
      ["request", this.requestDeadlineMs],
      ["upload", this.uploadDeadlineMs],
      ["removal", this.removalDeadlineMs],
    ] as const) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new TypeError(
          `The import API ${name} deadline must be a positive integer.`,
        );
      }
    }
    this.scheduleDeadline =
      options.scheduleDeadline ??
      ((callback, milliseconds) =>
        globalThis.setTimeout(callback, milliseconds));
    this.clearDeadline =
      options.clearDeadline ??
      ((handle) => globalThis.clearTimeout(handle as number));
  }

  public async authorizationStatus(
    signal?: AbortSignal,
  ): Promise<ImportAuthorizationStatus> {
    const response = await this.jsonRequest(
      "/api/v1/auth/session",
      { method: "GET" },
      signal,
    );
    if (response.response.status !== 200) {
      throw protocolError(
        "Authorization API returned an unexpected success status.",
      );
    }
    return parseAuthorizationResponse(response.value);
  }

  public async createSession(
    token: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (
      typeof token !== "string" ||
      !AUTHORIZATION_TOKEN_PATTERN.test(token)
    ) {
      throw new ImportApiError(
        "protocol",
        "Enter the canonical Code City authorization token.",
      );
    }
    await this.emptyRequest(
      "/api/v1/auth/session",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Code-City-Request": "1",
        },
      },
      204,
      signal,
    );
  }

  public async logout(signal?: AbortSignal): Promise<void> {
    await this.emptyRequest(
      "/api/v1/auth/session",
      {
        method: "DELETE",
        headers: { "X-Code-City-Request": "1" },
        keepalive: true,
      },
      204,
      signal,
    );
  }

  public async capabilities(
    signal?: AbortSignal,
  ): Promise<readonly ImportCredentialProfile[]> {
    const response = await this.jsonRequest(
      "/api/v1/imports/capabilities",
      { method: "GET" },
      signal,
    );
    if (response.response.status !== 200) {
      throw protocolError(
        "Import capability API returned an unexpected success status.",
      );
    }
    return parseCapabilitiesResponse(response.value);
  }

  public async buildingSource(
    jobId: string,
    buildingId: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const response = await this.jsonRequest(
      `/api/v1/artifacts/${jobId}/sources/${buildingId}`,
      { method: "GET" },
      signal,
      this.requestDeadlineMs,
      SOURCE_RESPONSE_MAX_BYTES,
    );
    if (response.response.status === 409) {
      throw new ImportApiError(
        "protocol",
        "Source retention is disabled for this imported model.",
      );
    }
    if (response.response.status !== 200) {
      throw protocolError("Source code could not be loaded.");
    }
    return response.value;
  }

  /** The request names a retained unit only; source text is never posted by the browser. */
  public async aiGuidancePreview(jobId: string, buildingId: string, signal?: AbortSignal): Promise<unknown> {
    return (await this.jsonRequest(`/api/v1/ai/preview/${jobId}/${buildingId}`, { method: "GET" }, signal, this.requestDeadlineMs, SOURCE_RESPONSE_MAX_BYTES)).value;
  }

  public async aiGuidanceRequest(
    jobId: string,
    buildingId: string,
    metrics: { readonly sloc: number; readonly maximumComplexity: number; readonly decisionLoad: number },
    signal?: AbortSignal,
  ): Promise<unknown> {
    return (await this.jsonRequest("/api/v1/ai/requests", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ approval: "once", jobId, buildingId, metrics }) }, signal, this.requestDeadlineMs, API_RESPONSE_MAX_BYTES)).value;
  }

  public async evolutionArtifact(
    jobId: string,
    artifact: NonNullable<ImportJobResult["evolution"]>,
    signal?: AbortSignal,
  ): Promise<ArrayBuffer> {
    this.requireJobId(jobId);
    const expectedPath = `/api/v1/artifacts/${jobId}/evolution.json`;
    if (
      Number.isSafeInteger(artifact.size) &&
      artifact.size > MAXIMUM_EVOLUTION_ARTIFACT_BYTES
    ) {
      throw evolutionArtifactTooLargeFailure();
    }
    if (
      artifact.artifactUrl !== expectedPath ||
      !Number.isSafeInteger(artifact.size) ||
      artifact.size < 1 ||
      !/^[0-9a-f]{64}$/u.test(artifact.sha256)
    ) {
      throw protocolError("Evolution artifact metadata is invalid.");
    }
    return await this.withDeadline(
      signal,
      EVOLUTION_ARTIFACT_DEADLINE_MS,
      async (requestSignal) => {
        const response = await this.fetchResponse(
          expectedPath,
          { method: "GET" },
          requestSignal,
        );
        if (response.status !== 200) {
          if (response.body !== null) {
            await readBoundedBytes(
              response,
              requestSignal,
              API_RESPONSE_MAX_BYTES,
            );
          }
          throw protocolError("Evolution artifact could not be loaded.");
        }
        const contentType = response.headers.get("content-type");
        if (
          contentType === null ||
          !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(contentType)
        ) {
          throw protocolError("Evolution artifact is not UTF-8 JSON.");
        }
        return await readExactEvolutionArtifact(
          response,
          requestSignal,
          artifact.size,
        );
      },
    );
  }

  public async createRemoteImport(
    request: RemoteImportSubmission,
    signal?: AbortSignal,
  ): Promise<ImportJob> {
    const response = await this.jsonRequest(
      "/api/v1/imports",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Code-City-Request": "1",
        },
        body: JSON.stringify(request),
      },
      signal,
    );
    if (response.response.status !== 202) {
      throw protocolError("Import API returned an unexpected success status.");
    }
    const job = parseImportJobResponse(response.value);
    this.requireLocation(response.response, `/api/v1/jobs/${job.id}`);
    return job;
  }

  public async reserveUpload(
    request: UploadImportSubmission,
    signal?: AbortSignal,
  ): Promise<ImportUploadReservation> {
    const response = await this.jsonRequest(
      "/api/v1/imports/uploads",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Code-City-Request": "1",
        },
        body: JSON.stringify(request),
      },
      signal,
    );
    if (response.response.status !== 201) {
      throw protocolError("Upload API returned an unexpected success status.");
    }
    const reservation = parseUploadReservationResponse(
      response.value,
      request,
    );
    this.requireLocation(response.response, reservation.uploadUrl);
    return reservation;
  }

  public async upload(
    reservation: ImportUploadReservation,
    body: Blob,
    signal?: AbortSignal,
  ): Promise<ImportJob> {
    if (
      !(body instanceof Blob) ||
      body.size !== reservation.sizeBytes ||
      !IMPORT_JOB_ID_PATTERN.test(reservation.token) ||
      reservation.uploadUrl !==
        `/api/v1/imports/uploads/${reservation.token}`
    ) {
      throw new ImportApiError(
        "protocol",
        "Upload bytes do not match their reservation.",
      );
    }
    const response = await this.jsonRequest(
      reservation.uploadUrl,
      {
        method: "PUT",
        headers: {
          "Content-Type": reservation.mediaType,
          "X-Code-City-Request": "1",
        },
        body,
      },
      signal,
      this.uploadDeadlineMs,
    );
    if (response.response.status !== 202) {
      throw protocolError("Upload API returned an unexpected success status.");
    }
    const job = parseImportJobResponse(response.value);
    this.requireLocation(response.response, `/api/v1/jobs/${job.id}`);
    return job;
  }

  public async abandonUpload(
    reservation: ImportUploadReservation,
    signal?: AbortSignal,
  ): Promise<void> {
    if (
      !IMPORT_JOB_ID_PATTERN.test(reservation.token) ||
      reservation.uploadUrl !==
        `/api/v1/imports/uploads/${reservation.token}`
    ) {
      throw new ImportApiError(
        "protocol",
        "Upload reservation is invalid.",
      );
    }
    const response = await this.jsonRequest(
      reservation.uploadUrl,
      {
        method: "DELETE",
        headers: { "X-Code-City-Request": "1" },
      },
      signal,
    );
    if (response.response.status !== 200) {
      throw protocolError("Upload deletion returned an unexpected status.");
    }
    const root = exactObject(
      response.value,
      ["deleted"],
      "Upload deletion response",
    );
    if (root["deleted"] !== true) {
      throw protocolError("Upload deletion response is invalid.");
    }
  }

  public async getJob(
    id: string,
    signal?: AbortSignal,
  ): Promise<ImportJob> {
    this.requireJobId(id);
    const response = await this.jsonRequest(
      `/api/v1/jobs/${id}`,
      { method: "GET" },
      signal,
    );
    if (response.response.status !== 200) {
      throw protocolError("Job API returned an unexpected success status.");
    }
    return parseImportJobResponse(response.value, id);
  }

  public async cancelJob(
    id: string,
    signal?: AbortSignal,
  ): Promise<ImportJob> {
    this.requireJobId(id);
    const response = await this.jsonRequest(
      `/api/v1/jobs/${id}`,
      {
        method: "DELETE",
        headers: { "X-Code-City-Request": "1" },
      },
      signal,
      this.uploadDeadlineMs,
    );
    if (response.response.status !== 200) {
      throw protocolError(
        "Job cancellation returned an unexpected success status.",
      );
    }
    return parseImportJobResponse(response.value, id);
  }

  public async removeCompletedJob(
    id: string,
    signal?: AbortSignal,
  ): Promise<ImportJob & { readonly state: "completed" }> {
    this.requireJobId(id);
    const response = await this.jsonRequest(
      `/api/v1/imports/${id}/result`,
      {
        method: "DELETE",
        headers: { "X-Code-City-Request": "1" },
      },
      signal,
      this.removalDeadlineMs,
    );
    if (response.response.status !== 200) {
      throw protocolError(
        "Completed import removal returned an unexpected success status.",
      );
    }
    const root = exactObject(
      response.value,
      ["deleted", "job"],
      "Completed import removal response",
    );
    if (root["deleted"] !== true) {
      throw protocolError(
        "Completed import removal was not confirmed.",
      );
    }
    const job = parseImportJob(root["job"], id);
    if (job.state !== "completed") {
      throw protocolError(
        "Completed import removal returned a non-completed job.",
      );
    }
    return job as ImportJob & { readonly state: "completed" };
  }

  private requireJobId(id: string): void {
    if (!IMPORT_JOB_ID_PATTERN.test(id)) {
      throw new ImportApiError("protocol", "Import job id is invalid.");
    }
  }

  private requireLocation(response: Response, expected: string): void {
    if (response.headers.get("location") !== expected) {
      throw protocolError("Import API returned an invalid Location.");
    }
  }

  private url(path: string): URL {
    if (
      !path.startsWith("/api/v1/") ||
      path.includes("?") ||
      path.includes("#") ||
      path.includes("%") ||
      path.includes("\\")
    ) {
      throw new ImportApiError("protocol", "Import API path is invalid.");
    }
    const url = new URL(path, `${this.origin}/`);
    if (url.origin !== this.origin || url.username !== "" || url.password !== "") {
      throw new ImportApiError("protocol", "Import API path is invalid.");
    }
    return url;
  }

  private async jsonRequest(
    path: string,
    init: RequestInit,
    signal?: AbortSignal,
    deadlineMs = this.requestDeadlineMs,
    maximumResponseBytes = API_RESPONSE_MAX_BYTES,
  ): Promise<{ readonly response: Response; readonly value: unknown }> {
    return await this.withDeadline(signal, deadlineMs, async (requestSignal) => {
      const response = await this.fetchResponse(path, init, requestSignal);
      const value = await readJsonResponse(
        response,
        requestSignal,
        maximumResponseBytes,
      );
      if (!response.ok) throw parseErrorResponse(value, response);
      return { response, value };
    });
  }

  private async emptyRequest(
    path: string,
    init: RequestInit,
    expectedStatus: number,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.withDeadline(
      signal,
      this.requestDeadlineMs,
      async (requestSignal) => {
        const response = await this.fetchResponse(path, init, requestSignal);
        if (!response.ok) {
          const value = await readJsonResponse(response, requestSignal);
          throw parseErrorResponse(value, response);
        }
        if (response.status !== expectedStatus) {
          throw protocolError("Import API returned an unexpected status.");
        }
        const length = response.headers.get("content-length");
        if (length !== null && length !== "0") {
          throw protocolError("Import API returned an unexpected body.");
        }
        if (response.body !== null) {
          const bytes = await readBoundedBytes(response, requestSignal);
          if (bytes.byteLength !== 0) {
            throw protocolError("Import API returned an unexpected body.");
          }
        }
      },
    );
  }

  private async fetchResponse(
    path: string,
    init: RequestInit,
    signal: AbortSignal,
  ): Promise<Response> {
    const requested = this.url(path);
    let response: Response;
    try {
      response = await waitForAbort(
        this.fetchImplementation(requested, {
          ...init,
          cache: "no-store",
          credentials: "same-origin",
          redirect: "error",
          referrerPolicy: "no-referrer",
          mode: "same-origin",
          signal,
        }),
        signal,
      );
    } catch (error) {
      if (signal.aborted) throw error;
      throw new ImportApiError(
        "network",
        "The Code City server could not be reached.",
      );
    }
    let responseUrl: URL;
    try {
      responseUrl =
        response.url === "" ? requested : new URL(response.url);
    } catch {
      throw protocolError("Import API returned an invalid response URL.");
    }
    if (
      response.redirected ||
      response.type === "opaqueredirect" ||
      responseUrl.href !== requested.href ||
      responseUrl.origin !== this.origin
    ) {
      throw protocolError("Import API redirects are not allowed.");
    }
    return response;
  }

  private async withDeadline<T>(
    externalSignal: AbortSignal | undefined,
    deadlineMs: number,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    let deadlineExceeded = false;
    const abort = (): void => controller.abort();
    if (externalSignal?.aborted) controller.abort();
    else externalSignal?.addEventListener("abort", abort, { once: true });
    const deadline = this.scheduleDeadline(() => {
      deadlineExceeded = true;
      controller.abort();
    }, deadlineMs);
    try {
      if (controller.signal.aborted) throw abortFailure();
      return await waitForAbort(
        operation(controller.signal),
        controller.signal,
      );
    } catch (error) {
      if (deadlineExceeded) {
        throw new ImportApiError(
          "deadline",
          "The Code City server did not respond in time.",
        );
      }
      if (controller.signal.aborted) throw abortFailure();
      throw error;
    } finally {
      this.clearDeadline(deadline);
      externalSignal?.removeEventListener("abort", abort);
    }
  }
}
