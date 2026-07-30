import {
  analyzeRepositorySnapshots,
  DEFAULT_SNAPSHOT_LIMITS,
  DEFAULT_ZIP_SNAPSHOT_LIMITS,
  materializeRepositorySnapshot,
  openZipSnapshotSource,
  SnapshotDeadlineError,
  SnapshotLimitError,
  SnapshotPathError,
  SnapshotPolicyError,
  type LocalAnalysisOptions,
  type RepositorySnapshot,
} from "../../../packages/analyzer/src/index.js";
import {
  validateCityModel,
  type CityModel,
} from "../../../packages/core/src/index.js";

import {
  type JobRecord,
  type JobTaskContext,
  JobTaskFailure,
  PersistentJobQueue,
} from "./job-queue.js";
import {
  IMPORT_CITY_MODEL_MAX_BYTES,
  ImportArtifactStore,
  type ImportStagingDirectory,
} from "./import-artifacts.js";
import {
  parseExactImportJsonValue,
  parseImportAnalysis,
  parseImportIdentity,
  RemoteImportRequestError,
  type RemoteImportAnalysis,
  type RemoteImportFieldErrorCode,
  type RemoteImportIdentity,
} from "./remote-import.js";
import {
  attachSourceProvenance,
  createSourceArtifact,
  uploadedSnapshotProvenance,
  type SourceRetentionPolicy,
} from "./source-artifact.js";
import { SourceArtifactStore } from "./source-artifact-store.js";

const MEBIBYTE = 1024 * 1024;
const IMPORT_JOB_KIND = "project-import";
const MODEL_PROGRESS_TOTAL = 3;
const ZIP_PROGRESS_TOTAL = 4;
const ROOT_KEYS = ["analysis", "identity", "source"] as const;
const SOURCE_KEYS = [
  "kind",
  "repositoryName",
  "rootMode",
  "sizeBytes",
] as const;
const PROTOTYPE_LIKE_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Cs}]/u;

export const UPLOAD_IMPORT_LIMITS = Object.freeze({
  maximumActiveUploads: 4,
  maximumStagedBytes: 256 * MEBIBYTE,
  cityModelBytes: IMPORT_CITY_MODEL_MAX_BYTES,
  repositoryZipBytes: DEFAULT_ZIP_SNAPSHOT_LIMITS.maxArchiveBytes,
  repositoryZipExpandedBytes: 512 * MEBIBYTE,
  reservationTtlMs: 5 * 60_000,
  bodyIdleTimeoutMs: 30_000,
  bodyTotalTimeoutMs: 10 * 60_000,
});

export type UploadImportSource =
  | {
      readonly kind: "city-model";
      readonly sizeBytes: number;
    }
  | {
      readonly kind: "repository-zip";
      readonly sizeBytes: number;
      readonly repositoryName: string;
      readonly rootMode: "single-directory" | "archive-root";
    };

export interface UploadImportRequest {
  readonly source: UploadImportSource;
  readonly identity?: RemoteImportIdentity;
  readonly analysis?: RemoteImportAnalysis;
}

export interface UploadReservation {
  readonly token: string;
  readonly uploadUrl: string;
  readonly mediaType: "application/json" | "application/zip";
  readonly sizeBytes: number;
  readonly expiresAt: string;
}

export interface UploadReservationRegistryOptions {
  readonly maximumActiveUploads?: number;
  readonly maximumStagedBytes?: number;
  readonly reservationTtlMs?: number;
  readonly now?: () => Date;
}

export type UploadReservationFailureCode =
  | "closed"
  | "not-found"
  | "quota-exceeded"
  | "unavailable";

export class UploadReservationFailure extends Error {
  public override readonly name = "UploadReservationFailure";

  public constructor(public readonly code: UploadReservationFailureCode) {
    super(code);
  }
}

class UploadReservationCleanupFailure extends Error {
  public override readonly name = "UploadReservationCleanupFailure";

  public constructor() {
    super("Upload reservation cleanup did not complete.");
  }
}

interface ReservationEntry {
  readonly request: UploadImportRequest;
  readonly staging: ImportStagingDirectory;
  readonly controller: AbortController;
  readonly expiresAt: string;
  readonly timer: NodeJS.Timeout;
  state:
    | "reserved"
    | "receiving"
    | "transferred"
    | "releasing"
    | "released";
  receptionDone?: Promise<void>;
  resolveReception?: () => void;
  cleanupOperation?: Promise<void>;
}

export interface UploadStagingLease {
  readonly request: UploadImportRequest;
  readonly staging: ImportStagingDirectory;
  cleanup(): Promise<void>;
}

export interface UploadReception {
  readonly request: UploadImportRequest;
  readonly staging: ImportStagingDirectory;
  readonly signal: AbortSignal;
  transfer(): UploadStagingLease;
  fail(): Promise<void>;
}

function fail(
  path: string,
  message: string,
  code: RemoteImportFieldErrorCode = "invalid-value",
): never {
  throw new RemoteImportRequestError([
    Object.freeze({ path, message, code }),
  ]);
}

function exactObject(
  value: unknown,
  path: string,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    fail(path, "Must be a JSON object.", "invalid-type");
  }
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      fail(path, "Must be a plain JSON object.", "invalid-type");
    }
    const object = value as Record<string, unknown>;
    for (const key of Object.keys(object).sort()) {
      if (
        PROTOTYPE_LIKE_KEYS.has(key) ||
        !allowedKeys.includes(key)
      ) {
        fail(path, "Unknown field.", "unknown-field");
      }
    }
    return object;
  } catch (error) {
    if (error instanceof RemoteImportRequestError) throw error;
    fail(path, "Must be a readable JSON object.", "invalid-type");
  }
}

function required(
  object: Record<string, unknown>,
  key: string,
  path: string,
): unknown {
  if (!Object.hasOwn(object, key)) {
    fail(path, "Field is required.", "required");
  }
  return object[key];
}

function safeText(
  value: unknown,
  path: string,
  maximumCharacters: number,
): string {
  if (typeof value !== "string") {
    fail(path, "Must be a string.", "invalid-type");
  }
  const normalized = value.normalize("NFC").trim();
  if (
    normalized.length === 0 ||
    normalized.length > maximumCharacters ||
    UNSAFE_TEXT.test(normalized)
  ) {
    fail(
      path,
      `Must contain 1 to ${maximumCharacters} safe characters.`,
    );
  }
  return normalized;
}

function uploadSize(
  value: unknown,
  path: string,
  maximumBytes: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > maximumBytes
  ) {
    fail(path, `Must be an integer from 1 to ${maximumBytes}.`);
  }
  return value;
}

export function parseUploadImportRequest(
  value: unknown,
): UploadImportRequest {
  try {
    const root = exactObject(value, "$", ROOT_KEYS);
    const sourceObject = exactObject(
      required(root, "source", "$.source"),
      "$.source",
      SOURCE_KEYS,
    );
    const kind = required(
      sourceObject,
      "kind",
      "$.source.kind",
    );
    let source: UploadImportSource;
    if (kind === "city-model") {
      exactObject(sourceObject, "$.source", ["kind", "sizeBytes"]);
      source = Object.freeze({
        kind,
        sizeBytes: uploadSize(
          required(
            sourceObject,
            "sizeBytes",
            "$.source.sizeBytes",
          ),
          "$.source.sizeBytes",
          UPLOAD_IMPORT_LIMITS.cityModelBytes,
        ),
      });
      if (
        Object.hasOwn(root, "identity") ||
        Object.hasOwn(root, "analysis")
      ) {
        fail(
          "$",
          "Identity and analysis options are not valid for an existing city model.",
        );
      }
      return Object.freeze({ source });
    }
    if (kind !== "repository-zip") {
      fail(
        "$.source.kind",
        'Must be "city-model" or "repository-zip".',
      );
    }
    const rootMode = required(
      sourceObject,
      "rootMode",
      "$.source.rootMode",
    );
    if (
      rootMode !== "single-directory" &&
      rootMode !== "archive-root"
    ) {
      fail(
        "$.source.rootMode",
        'Must be "single-directory" or "archive-root".',
      );
    }
    source = Object.freeze({
      kind,
      sizeBytes: uploadSize(
        required(
          sourceObject,
          "sizeBytes",
          "$.source.sizeBytes",
        ),
        "$.source.sizeBytes",
        UPLOAD_IMPORT_LIMITS.repositoryZipBytes,
      ),
      repositoryName: safeText(
        required(
          sourceObject,
          "repositoryName",
          "$.source.repositoryName",
        ),
        "$.source.repositoryName",
        256,
      ),
      rootMode,
    });
    if (
      source.repositoryName === "." ||
      source.repositoryName === ".." ||
      source.repositoryName.includes("/") ||
      source.repositoryName.includes("\\")
    ) {
      fail(
        "$.source.repositoryName",
        "Must be a portable repository name without path separators.",
      );
    }
    const identity = Object.hasOwn(root, "identity")
      ? parseImportIdentity(root["identity"])
      : undefined;
    const analysis = Object.hasOwn(root, "analysis")
      ? parseImportAnalysis(root["analysis"])
      : undefined;
    return Object.freeze({
      source,
      ...(identity === undefined ? {} : { identity }),
      ...(analysis === undefined ? {} : { analysis }),
    });
  } catch (error) {
    if (error instanceof RemoteImportRequestError) throw error;
    fail(
      "$",
      "Must be a readable exact-shape JSON object.",
      "invalid-json",
    );
  }
}

export function parseUploadImportJson(text: string): UploadImportRequest {
  return parseUploadImportRequest(parseExactImportJsonValue(text));
}

function positiveLimit(
  value: number | undefined,
  fallback: number,
  maximum: number,
  description: string,
): number {
  const resolved = value ?? fallback;
  if (
    !Number.isSafeInteger(resolved) ||
    resolved < 1 ||
    resolved > maximum
  ) {
    throw new TypeError(`${description} is invalid.`);
  }
  return resolved;
}

export class UploadReservationRegistry {
  readonly #entries = new Map<string, ReservationEntry>();
  readonly #maximumActiveUploads: number;
  readonly #maximumStagedBytes: number;
  readonly #reservationTtlMs: number;
  readonly #now: () => Date;
  readonly #reservationOperations = new Set<
    Promise<UploadReservation>
  >();
  #reservedBytes = 0;
  #pendingReservations = 0;
  #closed = false;

  public constructor(
    private readonly artifacts: ImportArtifactStore,
    options: UploadReservationRegistryOptions = {},
  ) {
    this.#maximumActiveUploads = positiveLimit(
      options.maximumActiveUploads,
      UPLOAD_IMPORT_LIMITS.maximumActiveUploads,
      64,
      "Maximum active uploads",
    );
    this.#maximumStagedBytes = positiveLimit(
      options.maximumStagedBytes,
      UPLOAD_IMPORT_LIMITS.maximumStagedBytes,
      4 * 1024 * MEBIBYTE,
      "Maximum staged upload bytes",
    );
    this.#reservationTtlMs = positiveLimit(
      options.reservationTtlMs,
      UPLOAD_IMPORT_LIMITS.reservationTtlMs,
      24 * 60 * 60_000,
      "Upload reservation lifetime",
    );
    this.#now = options.now ?? (() => new Date());
  }

  public async reserve(
    request: UploadImportRequest,
  ): Promise<UploadReservation> {
    const operation = this.reserveEntry(request);
    this.#reservationOperations.add(operation);
    try {
      return await operation;
    } finally {
      this.#reservationOperations.delete(operation);
    }
  }

  private async reserveEntry(
    request: UploadImportRequest,
  ): Promise<UploadReservation> {
    const sizeBytes = request.source.sizeBytes;
    if (this.#closed) throw new UploadReservationFailure("closed");
    if (
      this.#entries.size + this.#pendingReservations >=
        this.#maximumActiveUploads ||
      this.#reservedBytes > this.#maximumStagedBytes - sizeBytes
    ) {
      throw new UploadReservationFailure("quota-exceeded");
    }
    this.#pendingReservations += 1;
    this.#reservedBytes += sizeBytes;
    let staging: ImportStagingDirectory | undefined;
    try {
      staging = await this.artifacts.createStagingDirectory();
      if (this.#closed) throw new UploadReservationFailure("closed");
      const expiresAtDate = new Date(
        this.#now().getTime() + this.#reservationTtlMs,
      );
      const controller = new AbortController();
      const entry = {
        request,
        staging,
        controller,
        expiresAt: expiresAtDate.toISOString(),
        state: "reserved" as const,
        timer: setTimeout(() => {
          void this.release(entry).catch(() => undefined);
        }, this.#reservationTtlMs),
      };
      entry.timer.unref();
      this.#entries.set(staging.token, entry);
      return Object.freeze({
        token: staging.token,
        uploadUrl: `/api/v1/imports/uploads/${staging.token}`,
        mediaType:
          request.source.kind === "city-model"
            ? "application/json"
            : "application/zip",
        sizeBytes,
        expiresAt: entry.expiresAt,
      });
    } catch (error) {
      let cleanupFailed = false;
      if (staging !== undefined) {
        try {
          await this.artifacts.cleanupStagingDirectory(staging.token);
        } catch {
          cleanupFailed = true;
        }
      }
      this.#reservedBytes -= sizeBytes;
      if (cleanupFailed) {
        throw new UploadReservationCleanupFailure();
      }
      throw error;
    } finally {
      this.#pendingReservations -= 1;
    }
  }

  public begin(token: string): UploadReception {
    const entry = this.#entries.get(token);
    if (entry === undefined) {
      throw new UploadReservationFailure("not-found");
    }
    if (entry.state !== "reserved" || this.#closed) {
      throw new UploadReservationFailure("unavailable");
    }
    entry.state = "receiving";
    clearTimeout(entry.timer);
    let resolveReception: (() => void) | undefined;
    entry.receptionDone = new Promise<void>((resolve) => {
      resolveReception = resolve;
    });
    entry.resolveReception = () => resolveReception!();
    let transferred = false;
    const settleReception = (): void => {
      entry.resolveReception?.();
      delete entry.resolveReception;
    };
    return Object.freeze({
      request: entry.request,
      staging: entry.staging,
      signal: entry.controller.signal,
      transfer: () => {
        if (transferred || entry.state !== "receiving") {
          throw new UploadReservationFailure("unavailable");
        }
        transferred = true;
        entry.state = "transferred";
        settleReception();
        return Object.freeze({
          request: entry.request,
          staging: entry.staging,
          cleanup: () => this.release(entry),
        });
      },
      fail: () => {
        settleReception();
        return this.release(entry);
      },
    });
  }

  public async abandon(token: string): Promise<boolean> {
    const entry = this.#entries.get(token);
    if (
      entry === undefined ||
      entry.state === "transferred" ||
      entry.state === "released"
    ) {
      return false;
    }
    await this.release(entry);
    return true;
  }

  public async close(): Promise<void> {
    this.#closed = true;
    const pending = await Promise.allSettled([
      ...this.#reservationOperations,
    ]);
    const releasable = [...this.#entries.values()].filter(
      ({ state }) => state !== "transferred",
    );
    for (const entry of releasable) entry.controller.abort();
    const settled = await Promise.allSettled(
      releasable.map((entry) => this.release(entry)),
    );
    if (
      pending.some(
        (result) =>
          result.status === "rejected" &&
          result.reason instanceof UploadReservationCleanupFailure,
      ) ||
      settled.some(({ status }) => status === "rejected")
    ) {
      throw new Error(
        "Upload reservation cleanup did not complete.",
      );
    }
  }

  private release(entry: ReservationEntry): Promise<void> {
    if (entry.state === "released") return Promise.resolve();
    if (entry.cleanupOperation !== undefined) {
      return entry.cleanupOperation;
    }
    clearTimeout(entry.timer);
    entry.controller.abort();
    const receptionDone =
      entry.state === "receiving"
        ? entry.receptionDone ?? Promise.resolve()
        : Promise.resolve();
    entry.state = "releasing";
    const operation = receptionDone
      .then(() =>
        this.artifacts.cleanupStagingDirectory(entry.staging.token),
      )
      .then(() => {
        if (entry.state === "released") return;
        entry.state = "released";
        this.#entries.delete(entry.staging.token);
        this.#reservedBytes -= entry.request.source.sizeBytes;
      });
    entry.cleanupOperation = operation;
    void operation.finally(() => {
      delete entry.cleanupOperation;
    }).catch(() => undefined);
    return operation;
  }
}

function analyzerOptions(
  request: UploadImportRequest,
  signal: AbortSignal,
  timeoutMs?: number,
): LocalAnalysisOptions {
  return Object.freeze({
    ...(request.identity ?? {}),
    ...(request.analysis ?? {}),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    signal,
  });
}

function uploadedModel(bytes: Uint8Array): CityModel {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return validateCityModel(parseExactImportJsonValue(text));
  } catch {
    throw new JobTaskFailure("city-model-invalid");
  }
}

async function uploadedZipModel(
  request: UploadImportRequest & {
    readonly source: Extract<
      UploadImportSource,
      { readonly kind: "repository-zip" }
    >;
  },
  bytes: Uint8Array,
  context: JobTaskContext,
): Promise<{
  readonly model: CityModel;
  readonly snapshot: RepositorySnapshot;
}> {
  const startedAt = Date.now();
  const timeoutMs =
    request.analysis?.timeoutMs ?? DEFAULT_SNAPSHOT_LIMITS.timeoutMs;
  const source = openZipSnapshotSource(
    bytes,
    request.source.repositoryName,
    {
      maxArchiveBytes: UPLOAD_IMPORT_LIMITS.repositoryZipBytes,
      maxEntries: DEFAULT_SNAPSHOT_LIMITS.maxEntries,
      maxEntryBytes: DEFAULT_ZIP_SNAPSHOT_LIMITS.maxEntryBytes,
      maxExpandedBytes:
        UPLOAD_IMPORT_LIMITS.repositoryZipExpandedBytes,
      rootMode: request.source.rootMode,
      signal: context.signal,
    },
  );
  const materializationTimeout = timeoutMs - (Date.now() - startedAt);
  if (materializationTimeout <= 0) {
    source.dispose();
    throw new SnapshotDeadlineError();
  }
  let snapshot;
  try {
    snapshot = await materializeRepositorySnapshot(
      source,
      analyzerOptions(
        request,
        context.signal,
        materializationTimeout,
      ),
    );
  } finally {
    source.dispose();
  }
  const remaining = timeoutMs - (Date.now() - startedAt);
  if (remaining <= 0) throw new SnapshotDeadlineError();
  await context.report({
    phase: "analyzing-repository",
    current: 1,
    total: ZIP_PROGRESS_TOTAL,
  });
  const model = await analyzeRepositorySnapshots(
    [snapshot],
    analyzerOptions(request, context.signal, remaining),
  );
  return Object.freeze({ model, snapshot });
}

function uploadTaskFailure(error: unknown): JobTaskFailure {
  if (error instanceof JobTaskFailure) return error;
  if (error instanceof SnapshotDeadlineError) {
    return new JobTaskFailure("deadline-exceeded");
  }
  if (error instanceof SnapshotLimitError) {
    return new JobTaskFailure("import-limit-exceeded");
  }
  if (
    error instanceof SnapshotPathError ||
    error instanceof SnapshotPolicyError
  ) {
    return new JobTaskFailure("repository-content-rejected");
  }
  return new JobTaskFailure("analysis-failed");
}

async function cleanupAll(
  operations: readonly Promise<void>[],
): Promise<void> {
  const settled = await Promise.allSettled(operations);
  if (settled.some(({ status }) => status === "rejected")) {
    throw new Error("Uploaded import cleanup failed.");
  }
}

export async function enqueueUploadedImport(
  lease: UploadStagingLease,
  runtime: {
    readonly jobs: PersistentJobQueue;
    readonly artifacts: ImportArtifactStore;
    readonly sources?: SourceArtifactStore;
    readonly sourceRetention?: SourceRetentionPolicy;
  },
): Promise<JobRecord> {
  const request = lease.request;
  try {
    return await runtime.jobs.enqueue(
      IMPORT_JOB_KIND,
      async (context) => {
        try {
          context.signal.throwIfAborted();
          const zip = request.source.kind === "repository-zip";
          await context.report({
            phase: zip
              ? "reading-repository-archive"
              : "validating-city-model",
            current: 0,
            total: zip ? ZIP_PROGRESS_TOTAL : MODEL_PROGRESS_TOTAL,
          });
          const bytes = await runtime.artifacts.readStagedUpload(
            lease.staging.token,
            request.source.sizeBytes,
            context.signal,
          );
          let model: CityModel;
          let sourceSnapshot: RepositorySnapshot | undefined;
          try {
            if (request.source.kind === "city-model") {
              model = uploadedModel(bytes);
            } else {
              const analyzed = await uploadedZipModel(
                    request as UploadImportRequest & {
                      readonly source: Extract<
                        UploadImportSource,
                        { readonly kind: "repository-zip" }
                      >;
                    },
                    bytes,
                    context,
                  );
              sourceSnapshot = analyzed.snapshot;
              const repository = analyzed.model.repositories[0];
              if (
                repository === undefined ||
                analyzed.model.repositories.length !== 1
              ) {
                throw new JobTaskFailure("analysis-failed");
              }
              model = attachSourceProvenance(analyzed.model, [
                uploadedSnapshotProvenance(
                  repository.id,
                  analyzed.snapshot,
                ),
              ]);
            }
          } catch (error) {
            throw uploadTaskFailure(error);
          }
          context.signal.throwIfAborted();
          await context.report({
            phase: "publishing-city-model",
            current: zip ? 2 : 1,
            total: zip ? ZIP_PROGRESS_TOTAL : MODEL_PROGRESS_TOTAL,
          });
          const repository = model.repositories[0];
          const publishedSource =
            runtime.sourceRetention === "retain" &&
            runtime.sources !== undefined &&
            sourceSnapshot !== undefined &&
            repository !== undefined
              ? await runtime.sources.publish(
                  context.id,
                  createSourceArtifact(model, [
                    {
                      repositoryId: repository.id,
                      snapshot: sourceSnapshot,
                    },
                  ]),
                )
              : undefined;
          await runtime.artifacts.publishCityModel(context.id, model);
          context.signal.throwIfAborted();
          await context.report({
            phase: "cleaning-temporary-data",
            current: zip ? 3 : 2,
            total: zip ? ZIP_PROGRESS_TOTAL : MODEL_PROGRESS_TOTAL,
          });
          await lease.cleanup();
          context.signal.throwIfAborted();
          await context.report({
            phase: "ready",
            current: zip ? ZIP_PROGRESS_TOTAL : MODEL_PROGRESS_TOTAL,
            total: zip ? ZIP_PROGRESS_TOTAL : MODEL_PROGRESS_TOTAL,
          });
          return {
            kind: "city-model",
            artifactToken: context.id,
            artifactUrl:
              `/api/v1/artifacts/${context.id}/city-model.json`,
            source:
              publishedSource === undefined
                ? { availability: "disabled" as const }
                : {
                    availability: "retained" as const,
                    artifactUrl:
                      `/api/v1/artifacts/${context.id}/source`,
                    size: publishedSource.size,
                    sha256: publishedSource.sha256,
                  },
          };
        } catch (error) {
          await lease.cleanup().catch(() => undefined);
          if (error instanceof JobTaskFailure) throw error;
          throw new Error("Uploaded import failed.");
        }
      },
      {
        finalize: async (record) => {
          await cleanupAll([
            lease.cleanup(),
            ...(record.state === "completed"
              ? []
              : [
                  runtime.artifacts.cleanupCityModelArtifact(record.id),
                  ...(runtime.sources === undefined
                    ? []
                    : [runtime.sources.cleanup(record.id)]),
                ]),
          ]);
        },
        rollback: async (record) => {
          await cleanupAll([
            runtime.artifacts.cleanupCityModelArtifact(record.id),
            ...(runtime.sources === undefined
              ? []
              : [runtime.sources.cleanup(record.id)]),
            lease.cleanup(),
          ]);
        },
      },
    );
  } catch {
    await lease.cleanup().catch(() => undefined);
    throw new Error("Uploaded import could not be queued.");
  }
}
