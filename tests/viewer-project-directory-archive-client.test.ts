import { describe, expect, it, vi } from "vitest";

import {
  ProjectDirectoryArchiveClient,
} from "../apps/viewer/src/project-directory-archive-client.js";
import type {
  ProjectDirectoryArchiveRequest,
} from "../apps/viewer/src/project-directory-archive-protocol.js";
import {
  PROJECT_DIRECTORY_ARCHIVE_LIMITS,
  PROJECT_DIRECTORY_SELECTION_MAX_PATH_CHARACTERS,
} from "../apps/viewer/src/project-directory-archive-protocol.js";

class FakeArchiveWorker extends EventTarget {
  public request: ProjectDirectoryArchiveRequest | undefined;
  public terminated = false;

  public postMessage(message: unknown): void {
    this.request = message as ProjectDirectoryArchiveRequest;
  }

  public terminate(): void {
    this.terminated = true;
  }

  public emitMessage(data: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}

function selectedFile(
  relativePath = "project/src/index.ts",
): File {
  const name = relativePath.slice(relativePath.lastIndexOf("/") + 1);
  const file = new File(["export const value = 1;\n"], name, {
    type: "text/plain",
  });
  Object.defineProperty(file, "webkitRelativePath", {
    configurable: true,
    value: relativePath,
  });
  return file;
}

const AGGREGATE_METADATA_TEST_PATH_CHARACTERS = 2_048;

function validMetadataPath(length: number, character = "a"): string {
  return `p/${character.repeat(length - 2)}`;
}

function aggregateMetadataBoundaryFiles(
  oneCharacterOver: boolean,
): readonly File[] {
  const fullPath = validMetadataPath(
    AGGREGATE_METADATA_TEST_PATH_CHARACTERS,
  );
  const fullPathCount =
    PROJECT_DIRECTORY_SELECTION_MAX_PATH_CHARACTERS /
    fullPath.length;
  if (!Number.isInteger(fullPathCount)) {
    throw new Error(
      "The aggregate metadata limit must be divisible by the test path length.",
    );
  }
  const fullFile = selectedFile(fullPath);
  if (!oneCharacterOver) {
    return Array.from({ length: fullPathCount }, () => fullFile);
  }

  const finalPath = validMetadataPath(3, "c");
  const shortenedPath = validMetadataPath(
    fullPath.length + 1 - finalPath.length,
    "b",
  );
  return [
    ...Array.from(
      { length: fullPathCount - 1 },
      () => fullFile,
    ),
    selectedFile(shortenedPath),
    selectedFile(finalPath),
  ];
}

describe("project directory archive client", () => {
  it("forwards explicit relative paths and resolves one validated result", async () => {
    const worker = new FakeArchiveWorker();
    const progress = vi.fn();
    const client = new ProjectDirectoryArchiveClient({
      createWorker: () => worker as unknown as Worker,
    });

    const resultPromise = client.start([selectedFile()], {
      onProgress: progress,
    });
    expect(worker.request).toMatchObject({
      type: "create",
      jobId: 1,
      files: [
        {
          relativePath: "project/src/index.ts",
        },
      ],
    });
    worker.emitMessage({
      type: "progress",
      jobId: 1,
      completedFiles: 1,
      totalFiles: 1,
      completedBytes: 24,
      totalBytes: 24,
    });
    const blob = new Blob(["zip"], { type: "application/zip" });
    worker.emitMessage({
      type: "result",
      jobId: 1,
      blob,
      repositoryName: "project",
      rootMode: "single-directory",
      admittedFileCount: 1,
      admittedBytes: 24,
    });

    await expect(resultPromise).resolves.toEqual({
      blob,
      repositoryName: "project",
      rootMode: "single-directory",
      admittedFileCount: 1,
      admittedBytes: 24,
    });
    expect(progress).toHaveBeenCalledOnce();
    expect(worker.terminated).toBe(true);
  });

  it("terminates and rejects active work on cancellation", async () => {
    const worker = new FakeArchiveWorker();
    const client = new ProjectDirectoryArchiveClient({
      createWorker: () => worker as unknown as Worker,
    });
    const result = client.start([selectedFile()]);

    client.cancel();

    await expect(result).rejects.toMatchObject({
      code: "aborted",
    });
    expect(worker.terminated).toBe(true);
  });

  it("fails closed on an invalid or stale worker response", async () => {
    const worker = new FakeArchiveWorker();
    const client = new ProjectDirectoryArchiveClient({
      createWorker: () => worker as unknown as Worker,
    });
    const result = client.start([selectedFile()]);

    worker.emitMessage({
      type: "result",
      jobId: 2,
      blob: new Blob(),
    });

    await expect(result).rejects.toMatchObject({
      code: "unexpected",
    });
    expect(worker.terminated).toBe(true);
  });

  it("rejects an over-limit selection before creating a worker", async () => {
    const createWorker = vi.fn();
    const client = new ProjectDirectoryArchiveClient({
      createWorker,
    });
    const file = selectedFile();
    const files = Array.from(
      { length: PROJECT_DIRECTORY_ARCHIVE_LIMITS.maxEntries },
      () => file,
    );

    await expect(client.start(files)).rejects.toMatchObject({
      code: "too-many-entries",
    });
    expect(createWorker).not.toHaveBeenCalled();
  });

  it("accepts the exact aggregate path-metadata limit and rejects one character over before creating a worker", async () => {
    const exactFiles = aggregateMetadataBoundaryFiles(false);
    const overFiles = aggregateMetadataBoundaryFiles(true);
    expect(
      exactFiles.reduce(
        (total, file) => total + file.webkitRelativePath.length,
        0,
      ),
    ).toBe(PROJECT_DIRECTORY_SELECTION_MAX_PATH_CHARACTERS);
    expect(
      overFiles.reduce(
        (total, file) => total + file.webkitRelativePath.length,
        0,
      ),
    ).toBe(PROJECT_DIRECTORY_SELECTION_MAX_PATH_CHARACTERS + 1);
    expect(
      overFiles.every(
        (file) =>
          file.webkitRelativePath.length > 0 &&
          file.webkitRelativePath.length <=
            AGGREGATE_METADATA_TEST_PATH_CHARACTERS,
      ),
    ).toBe(true);

    const exactWorker = new FakeArchiveWorker();
    const exactCreateWorker = vi.fn(
      () => exactWorker as unknown as Worker,
    );
    const exactClient = new ProjectDirectoryArchiveClient({
      createWorker: exactCreateWorker,
    });
    const exactResult = exactClient.start(exactFiles);
    expect(exactCreateWorker).toHaveBeenCalledOnce();
    expect(exactWorker.request?.files).toHaveLength(exactFiles.length);
    exactClient.cancel();
    await expect(exactResult).rejects.toMatchObject({ code: "aborted" });

    const overCreateWorker = vi.fn();
    const overClient = new ProjectDirectoryArchiveClient({
      createWorker: overCreateWorker,
    });
    await expect(overClient.start(overFiles)).rejects.toMatchObject({
      code: "metadata-too-large",
    });
    expect(overCreateWorker).not.toHaveBeenCalled();
  });

  it("does not transfer hard-excluded descendants to the worker", async () => {
    const worker = new FakeArchiveWorker();
    const client = new ProjectDirectoryArchiveClient({
      createWorker: () => worker as unknown as Worker,
    });
    const result = client.start([
      selectedFile("project/node_modules/package/A.ts"),
      selectedFile("project/node_modules/package/a.ts"),
      selectedFile("project/src/index.ts"),
    ]);

    expect(worker.request?.files.map(({ relativePath }) => relativePath))
      .toEqual(["project/src/index.ts"]);
    worker.emitMessage({
      type: "result",
      jobId: 1,
      blob: new Blob(["zip"], { type: "application/zip" }),
      repositoryName: "project",
      rootMode: "single-directory",
      admittedFileCount: 1,
      admittedBytes: 24,
    });
    await expect(result).resolves.toMatchObject({
      repositoryName: "project",
    });
  });
});
