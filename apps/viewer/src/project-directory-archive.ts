import {
  Zip,
  ZipDeflate,
  ZipPassThrough,
} from "fflate";

import {
  isAnalyzerInputPath,
  isHardExcludedSnapshotPath,
  isSnapshotIgnoreControlPath,
  normalizeSnapshotPath,
  normalizeSnapshotRepositoryName,
  SnapshotPathError,
} from "../../../packages/analyzer/src/snapshot.js";
import {
  PROJECT_DIRECTORY_ARCHIVE_LIMITS,
  PROJECT_DIRECTORY_SELECTION_MAX_FILES,
  PROJECT_DIRECTORY_SELECTION_MAX_PATH_CHARACTERS,
  type ProjectDirectoryArchiveArtifact,
  type ProjectDirectoryArchiveErrorCode,
  type ProjectDirectoryArchiveFile,
  type ProjectDirectoryArchiveProgress,
} from "./project-directory-archive-protocol.js";

const ZIP_INPUT_CHUNK_BYTES = 64 * 1024;
const ZIP_COMPRESSION_LEVEL = 6;
const ZIP_UNIX_CREATOR = 3;
const ZIP_DIRECTORY_ATTRIBUTES = (0o040755 << 16) >>> 0;
const ZIP_FILE_ATTRIBUTES = (0o100644 << 16) >>> 0;
const FIXED_ZIP_TIMESTAMP = new Date(1980, 0, 1, 0, 0, 0, 0);
const EMPTY_BYTES = new Uint8Array();

export interface ProjectDirectoryArchiveLimits {
  readonly maxArchiveBytes: number;
  readonly maxEntries: number;
  readonly maxEntryBytes: number;
  readonly maxExpandedBytes: number;
}

export interface ProjectDirectoryArchiveOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: ProjectDirectoryArchiveProgress) => void;
  /**
   * Test and embedding seam. Every override must be at least one and may only
   * make the public production limits stricter.
   */
  readonly limits?: Partial<ProjectDirectoryArchiveLimits>;
}

export interface ProjectDirectoryArchivePlanEntry {
  readonly file: File;
  readonly path: string;
  readonly size: number;
}

export interface ProjectDirectoryArchivePlan {
  readonly repositoryName: string;
  readonly rootMode: "single-directory";
  readonly entries: readonly ProjectDirectoryArchivePlanEntry[];
  readonly admittedFileCount: number;
  readonly admittedBytes: number;
  readonly limits: ProjectDirectoryArchiveLimits;
}

export class ProjectDirectoryArchiveError extends Error {
  public readonly code: ProjectDirectoryArchiveErrorCode;

  public constructor(
    code: ProjectDirectoryArchiveErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ProjectDirectoryArchiveError";
    this.code = code;
  }
}

function archiveError(
  code: ProjectDirectoryArchiveErrorCode,
  message: string,
): ProjectDirectoryArchiveError {
  return new ProjectDirectoryArchiveError(code, message);
}

function invalidSelection(message: string): ProjectDirectoryArchiveError {
  return archiveError("invalid-selection", message);
}

function compareText(left: string, right: string): number {
  const foldedLeft = left.toLocaleLowerCase("en-US");
  const foldedRight = right.toLocaleLowerCase("en-US");
  if (foldedLeft < foldedRight) return -1;
  if (foldedLeft > foldedRight) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

function portablePathKey(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase("en-US");
}

function resolveLimit(
  value: number | undefined,
  maximum: number,
): number {
  const resolved = value ?? maximum;
  if (
    !Number.isSafeInteger(resolved) ||
    resolved < 1 ||
    resolved > maximum
  ) {
    throw invalidSelection("Project archive limits are invalid.");
  }
  return resolved;
}

function resolveLimits(
  value: Partial<ProjectDirectoryArchiveLimits> | undefined,
): ProjectDirectoryArchiveLimits {
  return Object.freeze({
    maxArchiveBytes: resolveLimit(
      value?.maxArchiveBytes,
      PROJECT_DIRECTORY_ARCHIVE_LIMITS.maxArchiveBytes,
    ),
    maxEntries: resolveLimit(
      value?.maxEntries,
      PROJECT_DIRECTORY_ARCHIVE_LIMITS.maxEntries,
    ),
    maxEntryBytes: resolveLimit(
      value?.maxEntryBytes,
      PROJECT_DIRECTORY_ARCHIVE_LIMITS.maxEntryBytes,
    ),
    maxExpandedBytes: resolveLimit(
      value?.maxExpandedBytes,
      PROJECT_DIRECTORY_ARCHIVE_LIMITS.maxExpandedBytes,
    ),
  });
}

function normalizedSelectionPath(relativePath: string): {
  readonly repositoryName: string;
  readonly path: string;
} {
  const normalizedRelativePath = relativePath.normalize("NFC");
  if (
    normalizedRelativePath.length === 0 ||
    normalizedRelativePath.startsWith("/") ||
    normalizedRelativePath.includes("\\")
  ) {
    throw invalidSelection("The selected directory contains an unsafe path.");
  }
  const segments = normalizedRelativePath.split("/");
  if (
    segments.length < 2 ||
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    throw invalidSelection("The selected directory contains an unsafe path.");
  }
  try {
    const repositoryName = normalizeSnapshotRepositoryName(segments[0]!);
    const path = normalizeSnapshotPath(segments.slice(1).join("/"));
    // The strict server reader validates the full archive path before
    // stripping its common root, so validate that exact representation here.
    normalizeSnapshotPath(`${repositoryName}/${path}`);
    return { repositoryName, path };
  } catch (error) {
    if (error instanceof SnapshotPathError) {
      throw invalidSelection("The selected directory contains an unsafe path.");
    }
    throw error;
  }
}

function assertFileMetadata(
  selected: ProjectDirectoryArchiveFile,
  normalizedPath: string,
): void {
  const expectedName = normalizedPath.slice(
    normalizedPath.lastIndexOf("/") + 1,
  );
  if (
    selected.file.name.normalize("NFC") !== expectedName ||
    !Number.isSafeInteger(selected.file.size) ||
    selected.file.size < 0
  ) {
    throw invalidSelection(
      "The selected directory contains inconsistent file metadata.",
    );
  }
}

function isAdmittedPath(path: string): boolean {
  return (
    !isHardExcludedSnapshotPath(path) &&
    (isAnalyzerInputPath(path) || isSnapshotIgnoreControlPath(path))
  );
}

export function captureProjectDirectoryArchiveFiles(
  files: Iterable<File>,
): readonly ProjectDirectoryArchiveFile[] {
  const captured: ProjectDirectoryArchiveFile[] = [];
  let excludedRootWitness: ProjectDirectoryArchiveFile | undefined;
  let repositoryName: string | undefined;
  let selectedCount = 0;
  let selectedPathCharacters = 0;
  for (const file of files) {
    selectedCount += 1;
    if (selectedCount > PROJECT_DIRECTORY_SELECTION_MAX_FILES) {
      throw archiveError(
        "too-many-entries",
        "The selected project exceeds the browser selection limit.",
      );
    }
    const relativePath = file.webkitRelativePath;
    if (typeof relativePath !== "string") {
      throw invalidSelection(
        "The selected directory contains invalid file metadata.",
      );
    }
    selectedPathCharacters += relativePath.length;
    if (
      !Number.isSafeInteger(selectedPathCharacters) ||
      selectedPathCharacters >
        PROJECT_DIRECTORY_SELECTION_MAX_PATH_CHARACTERS
    ) {
      throw archiveError(
        "metadata-too-large",
        "The selected project exceeds the path-metadata limit.",
      );
    }
    const selected = Object.freeze({
      file,
      relativePath,
    });
    try {
      const normalized = normalizedSelectionPath(selected.relativePath);
      if (repositoryName === undefined) {
        repositoryName = normalized.repositoryName;
      } else if (normalized.repositoryName !== repositoryName) {
        throw invalidSelection("Choose exactly one project directory.");
      }
      if (isHardExcludedSnapshotPath(normalized.path)) {
        excludedRootWitness ??= selected;
        continue;
      }
    } catch (error) {
      if (error instanceof ProjectDirectoryArchiveError) throw error;
    }
    captured.push(selected);
  }
  if (captured.length === 0 && excludedRootWitness !== undefined) {
    captured.push(excludedRootWitness);
  }
  return Object.freeze(captured);
}

export function planProjectDirectoryArchive(
  selectedFiles: readonly ProjectDirectoryArchiveFile[],
  limitOverrides?: Partial<ProjectDirectoryArchiveLimits>,
): ProjectDirectoryArchivePlan {
  const limits = resolveLimits(limitOverrides);
  if (selectedFiles.length === 0) {
    throw invalidSelection("Choose a project directory that contains files.");
  }
  let repositoryName: string | undefined;
  let admittedBytes = 0;
  const portablePaths = new Set<string>();
  const entries: ProjectDirectoryArchivePlanEntry[] = [];

  for (const selected of selectedFiles) {
    if (!(selected.file instanceof Blob)) {
      throw invalidSelection(
        "The selected directory contains invalid file metadata.",
      );
    }
    const normalized = normalizedSelectionPath(selected.relativePath);
    if (repositoryName === undefined) {
      repositoryName = normalized.repositoryName;
    } else if (normalized.repositoryName !== repositoryName) {
      throw invalidSelection("Choose exactly one project directory.");
    }
    assertFileMetadata(selected, normalized.path);
    if (isHardExcludedSnapshotPath(normalized.path)) continue;

    const key = portablePathKey(normalized.path);
    if (portablePaths.has(key)) {
      throw invalidSelection(
        "The selected directory contains colliding portable paths.",
      );
    }
    portablePaths.add(key);

    if (!isAdmittedPath(normalized.path)) continue;
    if (selected.file.size > limits.maxEntryBytes) {
      throw archiveError(
        "entry-too-large",
        "A project file exceeds the upload entry-size limit.",
      );
    }
    admittedBytes += selected.file.size;
    if (
      !Number.isSafeInteger(admittedBytes) ||
      admittedBytes > limits.maxExpandedBytes
    ) {
      throw archiveError(
        "expanded-too-large",
        "The selected project exceeds the expanded upload-size limit.",
      );
    }
    entries.push(
      Object.freeze({
        file: selected.file,
        path: normalized.path,
        size: selected.file.size,
      }),
    );
  }

  if (repositoryName === undefined) {
    throw invalidSelection("Choose a project directory that contains files.");
  }
  for (const candidate of portablePaths) {
    let separator = candidate.lastIndexOf("/");
    while (separator !== -1) {
      if (portablePaths.has(candidate.slice(0, separator))) {
        throw invalidSelection(
          "The selected directory contains conflicting file paths.",
        );
      }
      separator = candidate.lastIndexOf("/", separator - 1);
    }
  }
  if (entries.length + 1 > limits.maxEntries) {
    throw archiveError(
      "too-many-entries",
      "The selected project exceeds the upload entry-count limit.",
    );
  }

  entries.sort((left, right) => compareText(left.path, right.path));
  return Object.freeze({
    repositoryName,
    rootMode: "single-directory" as const,
    entries: Object.freeze(entries),
    admittedFileCount: entries.length,
    admittedBytes,
    limits,
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw archiveError("aborted", "Project directory archiving was cancelled.");
  }
}

async function readFileSlice(
  file: File,
  start: number,
  end: number,
  signal: AbortSignal | undefined,
): Promise<Uint8Array> {
  throwIfAborted(signal);
  try {
    const reading = file.slice(start, end).arrayBuffer();
    const buffer =
      signal === undefined
        ? await reading
        : await new Promise<ArrayBuffer>((resolve, reject) => {
            let settled = false;
            const onAbort = (): void => {
              if (settled) return;
              settled = true;
              reject(
                archiveError(
                  "aborted",
                  "Project directory archiving was cancelled.",
                ),
              );
            };
            signal.addEventListener("abort", onAbort, { once: true });
            if (signal.aborted) onAbort();
            void reading.then(
              (value) => {
                if (settled) return;
                settled = true;
                resolve(value);
              },
              (error: unknown) => {
                if (settled) return;
                settled = true;
                reject(error);
              },
            ).finally(() => {
              signal.removeEventListener("abort", onAbort);
            });
          });
    throwIfAborted(signal);
    return new Uint8Array(buffer);
  } catch (error) {
    if (error instanceof ProjectDirectoryArchiveError) throw error;
    throw archiveError(
      "read-failed",
      "A selected project file could not be read.",
    );
  }
}

function configureZipEntry(
  entry: ZipDeflate | ZipPassThrough,
  attributes: number,
): void {
  entry.mtime = FIXED_ZIP_TIMESTAMP;
  entry.os = ZIP_UNIX_CREATOR;
  entry.attrs = attributes;
}

function emitProgress(
  onProgress: ProjectDirectoryArchiveOptions["onProgress"],
  completedFiles: number,
  totalFiles: number,
  completedBytes: number,
  totalBytes: number,
): void {
  onProgress?.({
    completedFiles,
    totalFiles,
    completedBytes,
    totalBytes,
  });
}

export async function createProjectDirectoryArchive(
  selectedFiles: readonly ProjectDirectoryArchiveFile[],
  options: ProjectDirectoryArchiveOptions = {},
): Promise<ProjectDirectoryArchiveArtifact> {
  throwIfAborted(options.signal);
  const plan = planProjectDirectoryArchive(selectedFiles, options.limits);
  throwIfAborted(options.signal);

  const outputParts: ArrayBuffer[] = [];
  let outputBytes = 0;
  let outputError: ProjectDirectoryArchiveError | undefined;
  let resolveCompletion: (() => void) | undefined;
  let rejectCompletion: ((error: unknown) => void) | undefined;
  const completion = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  void completion.catch(() => undefined);

  const zip = new Zip((error, chunk, final) => {
    if (outputError !== undefined) return;
    if (error !== null) {
      outputError = archiveError(
        "unexpected",
        "The project directory could not be archived.",
      );
      rejectCompletion?.(outputError);
      return;
    }
    if (
      !Number.isSafeInteger(outputBytes + chunk.byteLength) ||
      outputBytes + chunk.byteLength > plan.limits.maxArchiveBytes
    ) {
      outputError = archiveError(
        "archive-too-large",
        "The compressed project exceeds the upload-size limit.",
      );
      rejectCompletion?.(outputError);
      return;
    }
    outputBytes += chunk.byteLength;
    outputParts.push(chunk.slice().buffer);
    if (final) resolveCompletion?.();
  });

  const throwOutputError = (): void => {
    if (outputError !== undefined) throw outputError;
  };

  let completedFiles = 0;
  let completedBytes = 0;
  try {
    const root = new ZipPassThrough(`${plan.repositoryName}/`);
    configureZipEntry(root, ZIP_DIRECTORY_ATTRIBUTES);
    zip.add(root);
    root.push(EMPTY_BYTES, true);
    throwOutputError();

    emitProgress(
      options.onProgress,
      completedFiles,
      plan.admittedFileCount,
      completedBytes,
      plan.admittedBytes,
    );
    throwIfAborted(options.signal);

    for (const planned of plan.entries) {
      throwIfAborted(options.signal);
      const entry = new ZipDeflate(
        `${plan.repositoryName}/${planned.path}`,
        { level: ZIP_COMPRESSION_LEVEL },
      );
      configureZipEntry(entry, ZIP_FILE_ATTRIBUTES);
      zip.add(entry);

      if (planned.size === 0) {
        entry.push(EMPTY_BYTES, true);
        completedFiles += 1;
        throwOutputError();
        emitProgress(
          options.onProgress,
          completedFiles,
          plan.admittedFileCount,
          completedBytes,
          plan.admittedBytes,
        );
        throwIfAborted(options.signal);
        continue;
      }

      for (
        let offset = 0;
        offset < planned.size;
        offset += ZIP_INPUT_CHUNK_BYTES
      ) {
        const end = Math.min(offset + ZIP_INPUT_CHUNK_BYTES, planned.size);
        const chunk = await readFileSlice(
          planned.file,
          offset,
          end,
          options.signal,
        );
        if (chunk.byteLength !== end - offset) {
          throw archiveError(
            "read-failed",
            "A selected project file could not be read.",
          );
        }
        const final = end === planned.size;
        entry.push(chunk, final);
        completedBytes += chunk.byteLength;
        if (final) completedFiles += 1;
        throwOutputError();
        emitProgress(
          options.onProgress,
          completedFiles,
          plan.admittedFileCount,
          completedBytes,
          plan.admittedBytes,
        );
        throwIfAborted(options.signal);
      }
    }

    zip.end();
    throwOutputError();
    await completion;
    throwOutputError();
    throwIfAborted(options.signal);

    const blob = new Blob(outputParts, { type: "application/zip" });
    if (blob.size !== outputBytes) {
      throw archiveError(
        "unexpected",
        "The project directory could not be archived.",
      );
    }
    return Object.freeze({
      blob,
      repositoryName: plan.repositoryName,
      rootMode: plan.rootMode,
      admittedFileCount: plan.admittedFileCount,
      admittedBytes: plan.admittedBytes,
    });
  } catch (error) {
    zip.terminate();
    if (error instanceof ProjectDirectoryArchiveError) throw error;
    throw archiveError(
      "unexpected",
      "The project directory could not be archived.",
    );
  }
}
