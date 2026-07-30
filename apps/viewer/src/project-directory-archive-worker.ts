import {
  createProjectDirectoryArchive,
} from "./project-directory-archive.js";
import {
  isProjectDirectoryArchiveRequest,
  projectDirectoryArchiveFailureForInvalidRequest,
  serializeProjectDirectoryArchiveError,
  type ProjectDirectoryArchiveRequest,
  type ProjectDirectoryArchiveWorkerResponse,
} from "./project-directory-archive-protocol.js";

export type ProjectDirectoryArchiveWorkerEmitter = (
  response: ProjectDirectoryArchiveWorkerResponse,
) => void;

export interface ProjectDirectoryArchiveWorkerScope {
  readonly document?: unknown;
  readonly clients?: unknown;
  readonly onconnect?: unknown;
  readonly importScripts?: unknown;
  readonly postMessage: (
    message: ProjectDirectoryArchiveWorkerResponse,
  ) => void;
  readonly addEventListener: (
    type: "message",
    listener: (event: { readonly data: unknown }) => void,
  ) => void;
  readonly removeEventListener: (
    type: "message",
    listener: (event: { readonly data: unknown }) => void,
  ) => void;
}

export async function runProjectDirectoryArchiveRequest(
  request: ProjectDirectoryArchiveRequest,
  emit: ProjectDirectoryArchiveWorkerEmitter,
  signal?: AbortSignal,
): Promise<void> {
  try {
    const result = await createProjectDirectoryArchive(request.files, {
      ...(signal === undefined ? {} : { signal }),
      onProgress: (progress) => {
        emit({
          type: "progress",
          jobId: request.jobId,
          ...progress,
        });
      },
    });
    emit({
      type: "result",
      jobId: request.jobId,
      ...result,
    });
  } catch (error) {
    emit({
      type: "failure",
      jobId: request.jobId,
      error: serializeProjectDirectoryArchiveError(error),
    });
  }
}

export function isDedicatedProjectDirectoryArchiveWorkerScope(
  value: unknown,
): value is ProjectDirectoryArchiveWorkerScope {
  if (typeof value !== "object" || value === null) return false;
  const scope = value as Record<string, unknown>;
  return (
    typeof scope["importScripts"] === "function" &&
    typeof scope["postMessage"] === "function" &&
    typeof scope["addEventListener"] === "function" &&
    typeof scope["removeEventListener"] === "function" &&
    !("document" in scope) &&
    !("clients" in scope) &&
    !("onconnect" in scope)
  );
}

export function installProjectDirectoryArchiveWorker(
  scope: ProjectDirectoryArchiveWorkerScope,
): () => void {
  let active: AbortController | undefined;
  const listener = (event: { readonly data: unknown }): void => {
    if (!isProjectDirectoryArchiveRequest(event.data)) {
      const failure =
        projectDirectoryArchiveFailureForInvalidRequest(event.data);
      if (failure !== undefined) scope.postMessage(failure);
      return;
    }
    if (active !== undefined) {
      scope.postMessage({
        type: "failure",
        jobId: event.data.jobId,
        error: {
          kind: "validation",
          code: "invalid-selection",
          message: "The project archive worker is already processing a request.",
        },
      });
      return;
    }

    const controller = new AbortController();
    active = controller;
    void runProjectDirectoryArchiveRequest(
      event.data,
      (response) => {
        scope.postMessage(response);
      },
      controller.signal,
    ).finally(() => {
      if (active === controller) active = undefined;
    });
  };
  scope.addEventListener("message", listener);
  return () => {
    scope.removeEventListener("message", listener);
    active?.abort();
    active = undefined;
  };
}

if (isDedicatedProjectDirectoryArchiveWorkerScope(globalThis)) {
  installProjectDirectoryArchiveWorker(
    globalThis as unknown as ProjectDirectoryArchiveWorkerScope,
  );
}
