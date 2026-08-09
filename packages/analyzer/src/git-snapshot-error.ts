export type GenericGitSnapshotErrorCode =
  | "GIT_ABORTED"
  | "GIT_ARCHIVE_TOO_LARGE"
  | "GIT_CLEANUP_FAILED"
  | "GIT_COMMAND_FAILED"
  | "GIT_DEADLINE_EXCEEDED"
  | "GIT_INVALID_REQUEST"
  | "GIT_INVALID_REF"
  | "GIT_INVALID_REMOTE"
  | "GIT_INVALID_RESPONSE"
  | "GIT_HISTORY_FAILED"
  | "GIT_OUTPUT_TOO_LARGE"
  | "GIT_PARTIAL_CLONE_UNAVAILABLE"
  | "GIT_REF_AMBIGUOUS"
  | "GIT_REF_CHANGED"
  | "GIT_REF_UNAVAILABLE"
  | "GIT_SNAPSHOT_FAILED"
  | "GIT_TEMPORARY_LIMIT"
  | "GIT_TEMPORARY_WORKSPACE_INVALID";

export class GenericGitSnapshotError extends Error {
  public constructor(
    readonly code: GenericGitSnapshotErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "GenericGitSnapshotError";
  }
}
