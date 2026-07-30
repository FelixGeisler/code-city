import {
  captureProjectDirectoryArchiveFiles,
  ProjectDirectoryArchiveError,
} from "./project-directory-archive.js";
import {
  isProjectDirectoryArchiveRequest,
  isProjectDirectoryArchiveWorkerResponse,
  PROJECT_DIRECTORY_ARCHIVE_LIMITS,
  type ProjectDirectoryArchiveArtifact,
  type ProjectDirectoryArchiveProgress,
  type ProjectDirectoryArchiveRequest,
} from "./project-directory-archive-protocol.js";

export interface ProjectDirectoryArchiveClientOptions {
  readonly createWorker?: () => Worker;
}

export interface ProjectDirectoryArchiveClientStartOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (
    progress: ProjectDirectoryArchiveProgress,
  ) => void;
}

interface ActiveArchive {
  readonly jobId: number;
  readonly worker: Worker;
  readonly reject: (error: unknown) => void;
  readonly cleanup: () => void;
}

function cancelledError(): ProjectDirectoryArchiveError {
  return new ProjectDirectoryArchiveError(
    "aborted",
    "Project directory archiving was cancelled.",
  );
}

/**
 * Owns one short-lived module worker per directory archive. Terminating the
 * worker is the hard cleanup boundary for cancellation and stale reads.
 */
export class ProjectDirectoryArchiveClient {
  private readonly createWorker: () => Worker;
  private nextJobId = 0;
  private active: ActiveArchive | undefined;
  private disposed = false;

  public constructor(options: ProjectDirectoryArchiveClientOptions = {}) {
    this.createWorker =
      options.createWorker ??
      (() =>
        new Worker(
          new URL("./project-directory-archive-worker.ts", import.meta.url),
          {
            type: "module",
            name: "code-city-project-directory-archive",
          },
        ));
  }

  public start(
    files: Iterable<File>,
    options: ProjectDirectoryArchiveClientStartOptions = {},
  ): Promise<ProjectDirectoryArchiveArtifact> {
    if (this.disposed) {
      return Promise.reject(
        new Error("The project archive client has been disposed."),
      );
    }
    if (this.active !== undefined) {
      return Promise.reject(
        new Error("A project directory is already being archived."),
      );
    }
    if (options.signal?.aborted === true) {
      return Promise.reject(cancelledError());
    }

    const jobId = this.nextJobId + 1;
    this.nextJobId = jobId;
    let capturedFiles: ProjectDirectoryArchiveRequest["files"];
    try {
      capturedFiles = captureProjectDirectoryArchiveFiles(files);
    } catch (error) {
      return Promise.reject(error);
    }
    const request: ProjectDirectoryArchiveRequest = {
      type: "create",
      jobId,
      files: capturedFiles,
    };
    if (!isProjectDirectoryArchiveRequest(request as unknown)) {
      const tooManyEntries =
        request.files.length + 1 >
        PROJECT_DIRECTORY_ARCHIVE_LIMITS.maxEntries;
      return Promise.reject(
        new ProjectDirectoryArchiveError(
          tooManyEntries ? "too-many-entries" : "invalid-selection",
          tooManyEntries
            ? "The selected project exceeds the upload entry-count limit."
            : "The selected project directory request is invalid.",
        ),
      );
    }
    const worker = this.createWorker();

    return new Promise<ProjectDirectoryArchiveArtifact>(
      (resolve, reject) => {
        let settled = false;
        const finish = (
          action: () => void,
        ): void => {
          if (settled) return;
          settled = true;
          cleanup();
          worker.terminate();
          if (this.active?.jobId === jobId) this.active = undefined;
          action();
        };
        const onMessage = (event: MessageEvent<unknown>): void => {
          const response = event.data;
          if (
            !isProjectDirectoryArchiveWorkerResponse(response) ||
            response.jobId !== jobId
          ) {
            finish(() =>
              reject(
                new ProjectDirectoryArchiveError(
                  "unexpected",
                  "The project archive worker returned an invalid response.",
                ),
              ),
            );
            return;
          }
          if (response.type === "progress") {
            options.onProgress?.({
              completedFiles: response.completedFiles,
              totalFiles: response.totalFiles,
              completedBytes: response.completedBytes,
              totalBytes: response.totalBytes,
            });
            return;
          }
          if (response.type === "failure") {
            finish(() =>
              reject(
                new ProjectDirectoryArchiveError(
                  response.error.code,
                  response.error.message,
                ),
              ),
            );
            return;
          }
          finish(() =>
            resolve(
              Object.freeze({
                blob: response.blob,
                repositoryName: response.repositoryName,
                rootMode: response.rootMode,
                admittedFileCount: response.admittedFileCount,
                admittedBytes: response.admittedBytes,
              }),
            ),
          );
        };
        const onWorkerError = (): void => {
          finish(() =>
            reject(
              new ProjectDirectoryArchiveError(
                "unexpected",
                "The project archive worker stopped unexpectedly.",
              ),
            ),
          );
        };
        const onAbort = (): void => {
          finish(() => reject(cancelledError()));
        };
        const cleanup = (): void => {
          worker.removeEventListener("message", onMessage);
          worker.removeEventListener("error", onWorkerError);
          worker.removeEventListener("messageerror", onWorkerError);
          options.signal?.removeEventListener("abort", onAbort);
        };

        worker.addEventListener("message", onMessage);
        worker.addEventListener("error", onWorkerError);
        worker.addEventListener("messageerror", onWorkerError);
        options.signal?.addEventListener("abort", onAbort, { once: true });
        this.active = {
          jobId,
          worker,
          reject,
          cleanup,
        };
        try {
          worker.postMessage(request);
        } catch {
          finish(() =>
            reject(
              new ProjectDirectoryArchiveError(
                "unexpected",
                "The selected project files could not be sent to the archive worker.",
              ),
            ),
          );
        }
      },
    );
  }

  public cancel(): void {
    const active = this.active;
    if (active === undefined) return;
    this.active = undefined;
    active.cleanup();
    active.worker.terminate();
    active.reject(cancelledError());
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancel();
  }
}
