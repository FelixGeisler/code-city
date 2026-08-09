import { promises as fs } from "node:fs";

import {
  DEFAULT_SNAPSHOT_LIMITS,
  type SnapshotOptions,
} from "./snapshot.js";
import type { ZipSnapshotSourceOptions } from "./zip-snapshot-source.js";
import { GenericGitSnapshotError } from "./git-snapshot-error.js";

const MEBIBYTE = 1024 * 1024;
export const GENERIC_GIT_ARCHIVE_MAX_BYTES = 64 * MEBIBYTE;

export interface GitArchiveDeadline {
  readonly signal: AbortSignal;
  remainingMilliseconds(): number;
}

export type AwaitWithinGitDeadline = <T>(
  value: Promise<T>,
  deadline: GitArchiveDeadline,
) => Promise<T>;

export function gitMaterializationOptions(
  requested: SnapshotOptions | undefined,
  deadline: GitArchiveDeadline,
): SnapshotOptions {
  const remaining = deadline.remainingMilliseconds();
  const { signal: _callerSignal, timeoutMs: requestedTimeout, ...options } = requested ?? {};
  return {
    ...options,
    timeoutMs: requestedTimeout === undefined
      ? remaining
      : Math.min(requestedTimeout, remaining),
    signal: deadline.signal,
  };
}

export async function readGenericGitArchive(
  archivePath: string,
  deadline: GitArchiveDeadline,
  withinDeadline: AwaitWithinGitDeadline,
): Promise<Uint8Array> {
  const stat = await withinDeadline(fs.lstat(archivePath), deadline);
  if (
    stat.isSymbolicLink() || !stat.isFile() || stat.size < 0 ||
    stat.size > GENERIC_GIT_ARCHIVE_MAX_BYTES
  ) {
    throw new GenericGitSnapshotError(
      "GIT_ARCHIVE_TOO_LARGE",
      "Generic Git archive exceeded its size limit.",
    );
  }
  const bytes = await withinDeadline(fs.readFile(archivePath), deadline);
  if (bytes.byteLength > GENERIC_GIT_ARCHIVE_MAX_BYTES) {
    throw new GenericGitSnapshotError(
      "GIT_ARCHIVE_TOO_LARGE",
      "Generic Git archive exceeded its size limit.",
    );
  }
  return new Uint8Array(bytes);
}

export function genericGitZipOptions(
  snapshotOptions: SnapshotOptions | undefined,
  signal: AbortSignal,
): ZipSnapshotSourceOptions {
  return {
    maxArchiveBytes: GENERIC_GIT_ARCHIVE_MAX_BYTES,
    maxEntries: snapshotOptions?.maxEntries ?? DEFAULT_SNAPSHOT_LIMITS.maxEntries,
    signal,
  };
}
