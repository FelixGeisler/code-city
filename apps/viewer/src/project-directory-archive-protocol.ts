import {
  DEFAULT_SNAPSHOT_LIMITS,
  normalizeSnapshotRepositoryName,
} from "../../../packages/analyzer/src/snapshot.js";
import {
  DEFAULT_ZIP_SNAPSHOT_LIMITS,
} from "../../../packages/analyzer/src/zip-snapshot-source.js";

const MEBIBYTE = 1024 * 1024;
// The strict server reader rejects 0xffff as the ZIP64 EOCD sentinel.
const MAX_NON_ZIP64_ENTRIES = 0xfffe;

export const PROJECT_DIRECTORY_SELECTION_MAX_FILES =
  DEFAULT_SNAPSHOT_LIMITS.maxEntries;
export const PROJECT_DIRECTORY_SELECTION_MAX_PATH_CHARACTERS =
  8 * 1024 * 1024;

/**
 * Browser imports deliberately use the server's stricter expanded-size limit
 * instead of the ZIP reader's generic one-gibibyte default.
 */
export const PROJECT_DIRECTORY_ARCHIVE_LIMITS = Object.freeze({
  maxArchiveBytes: DEFAULT_ZIP_SNAPSHOT_LIMITS.maxArchiveBytes,
  maxEntries: Math.min(
    DEFAULT_SNAPSHOT_LIMITS.maxEntries,
    MAX_NON_ZIP64_ENTRIES,
  ),
  maxEntryBytes: DEFAULT_ZIP_SNAPSHOT_LIMITS.maxEntryBytes,
  maxExpandedBytes: 512 * MEBIBYTE,
});

export interface ProjectDirectoryArchiveFile {
  readonly file: File;
  /**
   * Captured before crossing the worker boundary. Some browser structured
   * clone implementations do not retain File.webkitRelativePath.
   */
  readonly relativePath: string;
}

export interface ProjectDirectoryArchiveRequest {
  readonly type: "create";
  readonly jobId: number;
  readonly files: readonly ProjectDirectoryArchiveFile[];
}

export interface ProjectDirectoryArchiveProgress {
  readonly completedFiles: number;
  readonly totalFiles: number;
  readonly completedBytes: number;
  readonly totalBytes: number;
}

export interface ProjectDirectoryArchiveProgressResponse
  extends ProjectDirectoryArchiveProgress {
  readonly type: "progress";
  readonly jobId: number;
}

export interface ProjectDirectoryArchiveArtifact {
  readonly blob: Blob;
  readonly repositoryName: string;
  readonly rootMode: "single-directory";
  readonly admittedFileCount: number;
  readonly admittedBytes: number;
}

export interface ProjectDirectoryArchiveResultResponse
  extends ProjectDirectoryArchiveArtifact {
  readonly type: "result";
  readonly jobId: number;
}

export type ProjectDirectoryArchiveErrorCode =
  | "aborted"
  | "archive-too-large"
  | "entry-too-large"
  | "expanded-too-large"
  | "invalid-selection"
  | "metadata-too-large"
  | "read-failed"
  | "too-many-entries"
  | "unexpected";

export type ProjectDirectoryArchiveFailureKind =
  | "aborted"
  | "limit"
  | "read"
  | "validation"
  | "unexpected";

export interface ProjectDirectoryArchiveFailure {
  readonly kind: ProjectDirectoryArchiveFailureKind;
  readonly code: ProjectDirectoryArchiveErrorCode;
  readonly message: string;
}

export interface ProjectDirectoryArchiveFailureResponse {
  readonly type: "failure";
  readonly jobId: number;
  readonly error: ProjectDirectoryArchiveFailure;
}

export type ProjectDirectoryArchiveWorkerResponse =
  | ProjectDirectoryArchiveProgressResponse
  | ProjectDirectoryArchiveResultResponse
  | ProjectDirectoryArchiveFailureResponse;

const FAILURE_CODES: ReadonlySet<ProjectDirectoryArchiveErrorCode> = new Set([
  "aborted",
  "archive-too-large",
  "entry-too-large",
  "expanded-too-large",
  "invalid-selection",
  "metadata-too-large",
  "read-failed",
  "too-many-entries",
  "unexpected",
]);
const FAILURE_KINDS: ReadonlySet<ProjectDirectoryArchiveFailureKind> = new Set([
  "aborted",
  "limit",
  "read",
  "validation",
  "unexpected",
]);
const MAX_FAILURE_MESSAGE_CHARACTERS = 512;
const MAX_RELATIVE_PATH_CHARACTERS = 8_192;

function failureKindForCode(
  code: ProjectDirectoryArchiveErrorCode,
): ProjectDirectoryArchiveFailureKind {
  return code === "aborted"
    ? "aborted"
    : code === "archive-too-large" ||
        code === "entry-too-large" ||
        code === "expanded-too-large" ||
        code === "metadata-too-large" ||
        code === "too-many-entries"
      ? "limit"
      : code === "read-failed"
        ? "read"
        : code === "invalid-selection"
          ? "validation"
          : "unexpected";
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function isJobId(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isProjectDirectoryArchiveFile(
  value: unknown,
): value is ProjectDirectoryArchiveFile {
  const candidate = record(value);
  return (
    candidate !== undefined &&
    hasExactKeys(candidate, ["file", "relativePath"]) &&
    candidate["file"] instanceof Blob &&
    typeof (candidate["file"] as File).name === "string" &&
    typeof candidate["relativePath"] === "string" &&
    candidate["relativePath"].length > 0 &&
    candidate["relativePath"].length <= MAX_RELATIVE_PATH_CHARACTERS
  );
}

function hasBoundedProjectDirectoryArchiveFiles(
  value: unknown,
): value is readonly ProjectDirectoryArchiveFile[] {
  if (!Array.isArray(value)) return false;
  let totalPathCharacters = 0;
  for (const candidate of value) {
    if (!isProjectDirectoryArchiveFile(candidate)) return false;
    totalPathCharacters += candidate.relativePath.length;
    if (
      totalPathCharacters >
      PROJECT_DIRECTORY_SELECTION_MAX_PATH_CHARACTERS
    ) {
      return false;
    }
  }
  return true;
}

function exceedsProjectDirectoryPathMetadata(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  let totalPathCharacters = 0;
  for (const candidate of value) {
    const object = record(candidate);
    if (typeof object?.["relativePath"] !== "string") return false;
    totalPathCharacters += object["relativePath"].length;
    if (
      totalPathCharacters >
      PROJECT_DIRECTORY_SELECTION_MAX_PATH_CHARACTERS
    ) {
      return true;
    }
  }
  return false;
}

function isRepositoryName(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return normalizeSnapshotRepositoryName(value) === value;
  } catch {
    return false;
  }
}

function isProgress(
  candidate: Record<string, unknown>,
): candidate is Record<string, unknown> & ProjectDirectoryArchiveProgress {
  return (
    isNonnegativeSafeInteger(candidate["completedFiles"]) &&
    isNonnegativeSafeInteger(candidate["totalFiles"]) &&
    candidate["totalFiles"] < PROJECT_DIRECTORY_ARCHIVE_LIMITS.maxEntries &&
    candidate["completedFiles"] <= candidate["totalFiles"] &&
    isNonnegativeSafeInteger(candidate["completedBytes"]) &&
    isNonnegativeSafeInteger(candidate["totalBytes"]) &&
    candidate["totalBytes"] <=
      PROJECT_DIRECTORY_ARCHIVE_LIMITS.maxExpandedBytes &&
    candidate["completedBytes"] <= candidate["totalBytes"]
  );
}

function isFailure(value: unknown): value is ProjectDirectoryArchiveFailure {
  const candidate = record(value);
  return (
    candidate !== undefined &&
    hasExactKeys(candidate, ["kind", "code", "message"]) &&
    typeof candidate["kind"] === "string" &&
    FAILURE_KINDS.has(
      candidate["kind"] as ProjectDirectoryArchiveFailureKind,
    ) &&
    typeof candidate["code"] === "string" &&
    FAILURE_CODES.has(candidate["code"] as ProjectDirectoryArchiveErrorCode) &&
    candidate["kind"] ===
      failureKindForCode(
        candidate["code"] as ProjectDirectoryArchiveErrorCode,
      ) &&
    typeof candidate["message"] === "string" &&
    candidate["message"].length > 0 &&
    candidate["message"].length <= MAX_FAILURE_MESSAGE_CHARACTERS
  );
}

export function isProjectDirectoryArchiveRequest(
  value: unknown,
): value is ProjectDirectoryArchiveRequest {
  const candidate = record(value);
  return (
    candidate !== undefined &&
    hasExactKeys(candidate, ["type", "jobId", "files"]) &&
    candidate["type"] === "create" &&
    isJobId(candidate["jobId"]) &&
    hasBoundedProjectDirectoryArchiveFiles(candidate["files"]) &&
    candidate["files"].length + 1 <=
      PROJECT_DIRECTORY_ARCHIVE_LIMITS.maxEntries
  );
}

export function projectDirectoryArchiveFailureForInvalidRequest(
  value: unknown,
): ProjectDirectoryArchiveFailureResponse | undefined {
  const candidate = record(value);
  if (candidate === undefined || !isJobId(candidate["jobId"])) {
    return undefined;
  }
  const tooManyEntries =
    Array.isArray(candidate["files"]) &&
    candidate["files"].length + 1 >
      PROJECT_DIRECTORY_ARCHIVE_LIMITS.maxEntries;
  const metadataTooLarge = exceedsProjectDirectoryPathMetadata(
    candidate["files"],
  );
  return {
    type: "failure",
    jobId: candidate["jobId"],
    error: tooManyEntries
      ? {
          kind: "limit",
          code: "too-many-entries",
          message:
            "The selected project exceeds the upload entry-count limit.",
        }
      : metadataTooLarge
        ? {
            kind: "limit",
            code: "metadata-too-large",
            message:
              "The selected project exceeds the path-metadata limit.",
          }
        : {
            kind: "validation",
            code: "invalid-selection",
            message:
              "The selected project directory request is invalid.",
          },
  };
}

export function isProjectDirectoryArchiveWorkerResponse(
  value: unknown,
): value is ProjectDirectoryArchiveWorkerResponse {
  const candidate = record(value);
  if (
    candidate === undefined ||
    typeof candidate["type"] !== "string" ||
    !isJobId(candidate["jobId"])
  ) {
    return false;
  }
  if (candidate["type"] === "progress") {
    return (
      hasExactKeys(candidate, [
        "type",
        "jobId",
        "completedFiles",
        "totalFiles",
        "completedBytes",
        "totalBytes",
      ]) && isProgress(candidate)
    );
  }
  if (candidate["type"] === "result") {
    return (
      hasExactKeys(candidate, [
        "type",
        "jobId",
        "blob",
        "repositoryName",
        "rootMode",
        "admittedFileCount",
        "admittedBytes",
      ]) &&
      candidate["blob"] instanceof Blob &&
      candidate["blob"].type === "application/zip" &&
      candidate["blob"].size > 0 &&
      candidate["blob"].size <=
        PROJECT_DIRECTORY_ARCHIVE_LIMITS.maxArchiveBytes &&
      isRepositoryName(candidate["repositoryName"]) &&
      candidate["rootMode"] === "single-directory" &&
      isNonnegativeSafeInteger(candidate["admittedFileCount"]) &&
      candidate["admittedFileCount"] <
        PROJECT_DIRECTORY_ARCHIVE_LIMITS.maxEntries &&
      isNonnegativeSafeInteger(candidate["admittedBytes"]) &&
      candidate["admittedBytes"] <=
        PROJECT_DIRECTORY_ARCHIVE_LIMITS.maxExpandedBytes
    );
  }
  return (
    candidate["type"] === "failure" &&
    hasExactKeys(candidate, ["type", "jobId", "error"]) &&
    isFailure(candidate["error"])
  );
}

export function serializeProjectDirectoryArchiveError(
  error: unknown,
): ProjectDirectoryArchiveFailure {
  const candidate = record(error);
  const code =
    candidate?.["name"] === "ProjectDirectoryArchiveError" &&
    typeof candidate?.["code"] === "string" &&
    FAILURE_CODES.has(candidate["code"] as ProjectDirectoryArchiveErrorCode)
      ? (candidate["code"] as ProjectDirectoryArchiveErrorCode)
      : "unexpected";
  const kind = failureKindForCode(code);
  const safeMessage =
    code !== "unexpected" &&
    typeof candidate?.["message"] === "string" &&
    candidate["message"].length > 0 &&
    candidate["message"].length <= MAX_FAILURE_MESSAGE_CHARACTERS
      ? candidate["message"]
      : "The project directory could not be archived.";
  return {
    kind,
    code,
    message: safeMessage,
  };
}
