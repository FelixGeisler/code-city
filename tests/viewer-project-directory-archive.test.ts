import { unzipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";

import {
  captureProjectDirectoryArchiveFiles,
  createProjectDirectoryArchive,
  planProjectDirectoryArchive,
  ProjectDirectoryArchiveError,
} from "../apps/viewer/src/project-directory-archive.js";
import {
  isProjectDirectoryArchiveRequest,
  isProjectDirectoryArchiveWorkerResponse,
  projectDirectoryArchiveFailureForInvalidRequest,
  PROJECT_DIRECTORY_ARCHIVE_LIMITS,
  PROJECT_DIRECTORY_SELECTION_MAX_FILES,
  PROJECT_DIRECTORY_SELECTION_MAX_PATH_CHARACTERS,
  serializeProjectDirectoryArchiveError,
  type ProjectDirectoryArchiveFile,
  type ProjectDirectoryArchiveRequest,
  type ProjectDirectoryArchiveWorkerResponse,
} from "../apps/viewer/src/project-directory-archive-protocol.js";
import {
  installProjectDirectoryArchiveWorker,
  isDedicatedProjectDirectoryArchiveWorkerScope,
  runProjectDirectoryArchiveRequest,
  type ProjectDirectoryArchiveWorkerScope,
} from "../apps/viewer/src/project-directory-archive-worker.js";
import { UPLOAD_IMPORT_LIMITS } from "../apps/server/src/upload-import.js";
import {
  DEFAULT_SNAPSHOT_LIMITS,
  materializeRepositorySnapshot,
} from "../packages/analyzer/src/snapshot.js";
import {
  DEFAULT_ZIP_SNAPSHOT_LIMITS,
  openZipSnapshotSource,
} from "../packages/analyzer/src/zip-snapshot-source.js";

function selectedFile(
  relativePath: string,
  contents: BlobPart = "",
  options: {
    readonly name?: string;
    readonly lastModified?: number;
  } = {},
): ProjectDirectoryArchiveFile {
  const pathName = relativePath.slice(relativePath.lastIndexOf("/") + 1);
  return {
    file: new File([contents], options.name ?? pathName, {
      lastModified: options.lastModified ?? 1_700_000_000_000,
    }),
    relativePath,
  };
}

const AGGREGATE_METADATA_TEST_PATH_CHARACTERS = 2_048;

function validMetadataPath(length: number, character = "a"): string {
  return `p/${character.repeat(length - 2)}`;
}

function aggregateMetadataBoundaryPaths(
  oneCharacterOver: boolean,
): readonly string[] {
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
  if (!oneCharacterOver) {
    return Array.from({ length: fullPathCount }, () => fullPath);
  }

  const finalPath = validMetadataPath(3, "c");
  const shortenedPath = validMetadataPath(
    fullPath.length + 1 - finalPath.length,
    "b",
  );
  return [
    ...Array.from(
      { length: fullPathCount - 1 },
      () => fullPath,
    ),
    shortenedPath,
    finalPath,
  ];
}

function browserFilesForPaths(paths: readonly string[]): readonly File[] {
  const filesByPath = new Map<string, File>();
  return paths.map((relativePath) => {
    const existing = filesByPath.get(relativePath);
    if (existing !== undefined) return existing;
    const file = selectedFile(relativePath).file;
    Object.defineProperty(file, "webkitRelativePath", {
      configurable: true,
      value: relativePath,
    });
    filesByPath.set(relativePath, file);
    return file;
  });
}

async function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

function expectPlanError(
  operation: () => unknown,
  code: ProjectDirectoryArchiveError["code"],
): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(ProjectDirectoryArchiveError);
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected project archive error ${code}.`);
}

describe("viewer project directory archive", () => {
  it("matches the server's repository ZIP admission limits", () => {
    expect(PROJECT_DIRECTORY_SELECTION_MAX_FILES).toBe(
      DEFAULT_SNAPSHOT_LIMITS.maxEntries,
    );
    expect(PROJECT_DIRECTORY_ARCHIVE_LIMITS).toEqual({
      maxArchiveBytes: DEFAULT_ZIP_SNAPSHOT_LIMITS.maxArchiveBytes,
      maxEntries: Math.min(DEFAULT_SNAPSHOT_LIMITS.maxEntries, 0xfffe),
      maxEntryBytes: DEFAULT_ZIP_SNAPSHOT_LIMITS.maxEntryBytes,
      maxExpandedBytes:
        UPLOAD_IMPORT_LIMITS.repositoryZipExpandedBytes,
    });
    expect(PROJECT_DIRECTORY_ARCHIVE_LIMITS.maxArchiveBytes).toBe(
      UPLOAD_IMPORT_LIMITS.repositoryZipBytes,
    );
  });

  it("admits only analyzer inputs and policy controls, with hard exclusions first", () => {
    const plan = planProjectDirectoryArchive([
      selectedFile("Project/src/z.ts", "z"),
      selectedFile("Project/README.md", "not analyzed"),
      selectedFile("Project/.gitignore", "ignored.ts\n"),
      selectedFile("Project/src/.gitignore", "nested.ts\n"),
      selectedFile("Project/.codecityignore", "src/z.ts\n"),
      selectedFile("Project/src/ignored.ts", "ignored"),
      selectedFile("Project/node_modules/vendor.ts", "excluded"),
      selectedFile("Project/src/value.generated.cs", "excluded"),
      selectedFile("Project/App.csproj", "<Project />"),
    ]);

    expect(plan).toMatchObject({
      repositoryName: "Project",
      rootMode: "single-directory",
      admittedFileCount: 6,
    });
    expect(plan.entries.map(({ path }) => path)).toEqual([
      ".codecityignore",
      ".gitignore",
      "App.csproj",
      "src/.gitignore",
      "src/ignored.ts",
      "src/z.ts",
    ]);
    expect(plan.admittedBytes).toBe(
      plan.entries.reduce((total, entry) => total + entry.size, 0),
    );
  });

  it("streams a deterministic strict ZIP independent of input order and file metadata", async () => {
    const definitions = [
      ["Project/src/z.ts", "export const z = 1;\n"],
      ["Project/src/a.ts", "export const a = 1;\n"],
      ["Project/src/ignored.ts", "export const ignored = true;\n"],
      ["Project/.gitignore", "src/ignored.ts\n"],
      ["Project/.codecityignore", "src/z.ts\n"],
      ["Project/README.md", "filtered before upload"],
      ["Project/node_modules/vendor.ts", "hard excluded"],
    ] as const;
    const first = await createProjectDirectoryArchive(
      definitions.map(([path, contents]) =>
        selectedFile(path, contents, { lastModified: 100 }),
      ),
    );
    const second = await createProjectDirectoryArchive(
      [...definitions].reverse().map(([path, contents]) =>
        selectedFile(path, contents, { lastModified: 9_999_999 }),
      ),
    );
    const firstBytes = await blobBytes(first.blob);
    const secondBytes = await blobBytes(second.blob);

    expect(secondBytes).toEqual(firstBytes);
    expect(first).toMatchObject({
      repositoryName: "Project",
      rootMode: "single-directory",
      admittedFileCount: 5,
    });
    expect(first.blob.type).toBe("application/zip");
    expect(Object.keys(unzipSync(firstBytes)).sort()).toEqual([
      "Project/",
      "Project/.codecityignore",
      "Project/.gitignore",
      "Project/src/a.ts",
      "Project/src/ignored.ts",
      "Project/src/z.ts",
    ]);

    const source = openZipSnapshotSource(firstBytes, first.repositoryName, {
      rootMode: first.rootMode,
      maxExpandedBytes:
        PROJECT_DIRECTORY_ARCHIVE_LIMITS.maxExpandedBytes,
    });
    try {
      const snapshot = await materializeRepositorySnapshot(source);
      expect(snapshot.name).toBe("Project");
      expect(snapshot.files.map(({ path }) => path)).toEqual([
        "src/a.ts",
      ]);
    } finally {
      source.dispose();
    }
  });

  it("creates a valid root-only archive when the directory has no analyzer inputs", async () => {
    const result = await createProjectDirectoryArchive([
      selectedFile("Project/README.md", "documentation"),
    ]);
    expect(result).toMatchObject({
      repositoryName: "Project",
      admittedFileCount: 0,
      admittedBytes: 0,
    });
    const bytes = await blobBytes(result.blob);
    expect(Object.keys(unzipSync(bytes))).toEqual([
      "Project/",
    ]);
    const source = openZipSnapshotSource(bytes, result.repositoryName, {
      rootMode: result.rootMode,
    });
    try {
      expect((await materializeRepositorySnapshot(source)).files).toEqual([]);
    } finally {
      source.dispose();
    }
  });

  it("normalizes NFC but rejects unsafe roots, forged names, and portable collisions", () => {
    const normalized = planProjectDirectoryArchive([
      selectedFile("Re\u0301po/src/cafe\u0301.ts", "value"),
    ]);
    expect(normalized.repositoryName).toBe("Répo");
    expect(normalized.entries[0]?.path).toBe("src/café.ts");

    expectPlanError(
      () =>
        planProjectDirectoryArchive([
          selectedFile("One/a.ts"),
          selectedFile("Two/b.ts"),
        ]),
      "invalid-selection",
    );
    expectPlanError(
      () =>
        planProjectDirectoryArchive([
          selectedFile("Project/src/a.ts"),
          selectedFile("Project/src/A.ts"),
        ]),
      "invalid-selection",
    );
    expectPlanError(
      () =>
        planProjectDirectoryArchive([
          selectedFile("Project/a.ts"),
          selectedFile("Project/a.ts/b.ts"),
        ]),
      "invalid-selection",
    );
    expectPlanError(
      () =>
        planProjectDirectoryArchive([
          selectedFile("Scheme:Project/a.ts"),
        ]),
      "invalid-selection",
    );
    expectPlanError(
      () =>
        planProjectDirectoryArchive([
          selectedFile("Project/src/a.ts", "", { name: "forged.ts" }),
        ]),
      "invalid-selection",
    );
    expectPlanError(
      () =>
        planProjectDirectoryArchive([
          selectedFile("Project/../outside.ts"),
        ]),
      "invalid-selection",
    );
    expectPlanError(
      () =>
        planProjectDirectoryArchive([
          selectedFile("Project\\src\\a.ts"),
        ]),
      "invalid-selection",
    );
    expectPlanError(
      () => planProjectDirectoryArchive([]),
      "invalid-selection",
    );
  });

  it("prunes hard-excluded descendants before entry and collision checks", () => {
    const plan = planProjectDirectoryArchive(
      [
        selectedFile("Project/node_modules/package/A.ts", "excluded"),
        selectedFile("Project/node_modules/package/a.ts", "excluded"),
        selectedFile("Project/src/main.ts", "included"),
      ],
      { maxEntries: 2 },
    );

    expect(plan.entries.map(({ path }) => path)).toEqual([
      "src/main.ts",
    ]);
    expect(plan.admittedFileCount).toBe(1);
  });

  it("enforces entry, expanded, central-directory, and compressed limits", async () => {
    expectPlanError(
      () =>
        planProjectDirectoryArchive(
          [selectedFile("Project/a.ts", "1234")],
          { maxEntryBytes: 3 },
        ),
      "entry-too-large",
    );
    expectPlanError(
      () =>
        planProjectDirectoryArchive(
          [
            selectedFile("Project/a.ts", "123"),
            selectedFile("Project/b.ts", "456"),
          ],
          { maxExpandedBytes: 5 },
        ),
      "expanded-too-large",
    );
    expectPlanError(
      () =>
        planProjectDirectoryArchive(
          [
            selectedFile("Project/a.ts", "a"),
            selectedFile("Project/b.ts", "b"),
          ],
          { maxEntries: 2 },
      ),
      "too-many-entries",
    );
    expect(
      planProjectDirectoryArchive(
        [
          selectedFile("Project/node_modules/a.ts", "excluded"),
          selectedFile("Project/node_modules/b.ts", "excluded"),
        ],
        { maxEntries: 1 },
      ),
    ).toMatchObject({ admittedFileCount: 0 });
    await expect(
      createProjectDirectoryArchive(
        [selectedFile("Project/a.ts", "a")],
        { limits: { maxArchiveBytes: 1 } },
      ),
    ).rejects.toMatchObject({ code: "archive-too-large" });
  });

  it("bounds the original browser selection while pruning hard exclusions", () => {
    const source = selectedFile(
      "Project/node_modules/package/index.ts",
      "excluded",
    ).file;
    Object.defineProperty(source, "webkitRelativePath", {
      configurable: true,
      value: "Project/node_modules/package/index.ts",
    });
    expect(captureProjectDirectoryArchiveFiles([source])).toHaveLength(1);

    const tooMany = {
      *[Symbol.iterator](): Iterator<File> {
        for (
          let index = 0;
          index <= PROJECT_DIRECTORY_SELECTION_MAX_FILES;
          index += 1
        ) {
          yield source;
        }
      },
    };
    expectPlanError(
      () => captureProjectDirectoryArchiveFiles(tooMany),
      "too-many-entries",
    );
  });

  it("accepts the exact aggregate path-metadata limit and rejects one character over while capturing", () => {
    const exactPaths = aggregateMetadataBoundaryPaths(false);
    const overPaths = aggregateMetadataBoundaryPaths(true);
    expect(
      exactPaths.reduce((total, path) => total + path.length, 0),
    ).toBe(PROJECT_DIRECTORY_SELECTION_MAX_PATH_CHARACTERS);
    expect(
      overPaths.reduce((total, path) => total + path.length, 0),
    ).toBe(PROJECT_DIRECTORY_SELECTION_MAX_PATH_CHARACTERS + 1);
    expect(overPaths.length).toBeLessThanOrEqual(
      PROJECT_DIRECTORY_SELECTION_MAX_FILES,
    );
    expect(
      overPaths.every(
        (path) =>
          path.length > 0 &&
          path.length <= AGGREGATE_METADATA_TEST_PATH_CHARACTERS,
      ),
    ).toBe(true);

    expect(
      captureProjectDirectoryArchiveFiles(
        browserFilesForPaths(exactPaths),
      ),
    ).toHaveLength(exactPaths.length);
    expectPlanError(
      () =>
        captureProjectDirectoryArchiveFiles(
          browserFilesForPaths(overPaths),
        ),
      "metadata-too-large",
    );
  });

  it("reports bounded progress, cancels between chunks, and redacts read failures", async () => {
    const progress: Array<{
      readonly completedFiles: number;
      readonly completedBytes: number;
    }> = [];
    const successful = await createProjectDirectoryArchive(
      [
        selectedFile("Project/a.ts", "a"),
        selectedFile("Project/empty.ts"),
      ],
      {
        onProgress: (value) => progress.push(value),
      },
    );
    expect(successful.admittedBytes).toBe(1);
    expect(progress[0]).toEqual({
      completedFiles: 0,
      completedBytes: 0,
      totalFiles: 2,
      totalBytes: 1,
    });
    expect(progress.at(-1)).toEqual({
      completedFiles: 2,
      completedBytes: 1,
      totalFiles: 2,
      totalBytes: 1,
    });

    const controller = new AbortController();
    const large = new Uint8Array(2 * 64 * 1024);
    await expect(
      createProjectDirectoryArchive(
        [selectedFile("Project/large.ts", large)],
        {
          signal: controller.signal,
          onProgress: (value) => {
            if (value.completedBytes >= 64 * 1024) controller.abort();
          },
        },
      ),
    ).rejects.toMatchObject({ code: "aborted" });

    const unreadable = selectedFile("Project/unreadable.ts", "value");
    Object.defineProperty(unreadable.file, "slice", {
      value: () => ({
        arrayBuffer: async () => {
          throw new Error("sensitive local path");
        },
      }),
    });
    await expect(
      createProjectDirectoryArchive([unreadable]),
    ).rejects.toMatchObject({
      code: "read-failed",
      message: "A selected project file could not be read.",
    });
  });
});

describe("project directory archive worker protocol", () => {
  it("validates exact request/response shapes and serializes safe failures", () => {
    const file = selectedFile("Project/a.ts", "a");
    const request: ProjectDirectoryArchiveRequest = {
      type: "create",
      jobId: 7,
      files: [file],
    };
    expect(isProjectDirectoryArchiveRequest(request)).toBe(true);
    expect(
      isProjectDirectoryArchiveRequest({ ...request, unexpected: true }),
    ).toBe(false);
    expect(
      isProjectDirectoryArchiveRequest({
        ...request,
        files: [{ file: file.file, relativePath: "" }],
      }),
    ).toBe(false);
    expect(
      isProjectDirectoryArchiveWorkerResponse({
        type: "progress",
        jobId: 7,
        completedFiles: 1,
        totalFiles: 1,
        completedBytes: 1,
        totalBytes: 1,
      }),
    ).toBe(true);
    expect(
      isProjectDirectoryArchiveWorkerResponse({
        type: "progress",
        jobId: 7,
        completedFiles: 2,
        totalFiles: 1,
        completedBytes: 1,
        totalBytes: 1,
      }),
    ).toBe(false);
    expect(
      serializeProjectDirectoryArchiveError(
        new Error("C:\\private\\secret.ts"),
      ),
    ).toEqual({
      kind: "unexpected",
      code: "unexpected",
      message: "The project directory could not be archived.",
    });
    expect(
      projectDirectoryArchiveFailureForInvalidRequest({
        type: "create",
        jobId: 8,
        files: new Array(
          PROJECT_DIRECTORY_ARCHIVE_LIMITS.maxEntries,
        ),
      }),
    ).toMatchObject({
      type: "failure",
      jobId: 8,
      error: {
        kind: "limit",
        code: "too-many-entries",
      },
    });
    const exactMetadataFiles = aggregateMetadataBoundaryPaths(false)
      .map((relativePath) => selectedFile(relativePath));
    const overMetadataFiles = aggregateMetadataBoundaryPaths(true)
      .map((relativePath) => selectedFile(relativePath));
    expect(exactMetadataFiles.length + 1).toBeLessThanOrEqual(
      PROJECT_DIRECTORY_ARCHIVE_LIMITS.maxEntries,
    );
    expect(overMetadataFiles.length + 1).toBeLessThanOrEqual(
      PROJECT_DIRECTORY_ARCHIVE_LIMITS.maxEntries,
    );
    expect(
      isProjectDirectoryArchiveRequest({
        type: "create",
        jobId: 9,
        files: exactMetadataFiles,
      }),
    ).toBe(true);
    expect(
      isProjectDirectoryArchiveRequest({
        type: "create",
        jobId: 10,
        files: overMetadataFiles,
      }),
    ).toBe(false);
    expect(
      projectDirectoryArchiveFailureForInvalidRequest({
        type: "create",
        jobId: 10,
        files: overMetadataFiles,
      }),
    ).toMatchObject({
      type: "failure",
      jobId: 10,
      error: {
        kind: "limit",
        code: "metadata-too-large",
      },
    });
  });

  it("runs without network access and emits only validated progress and result messages", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("The archive worker must not access the network.");
    });
    const emitted: ProjectDirectoryArchiveWorkerResponse[] = [];
    try {
      await runProjectDirectoryArchiveRequest(
        {
          type: "create",
          jobId: 17,
          files: [selectedFile("Project/a.ts", "a")],
        },
        (response) => emitted.push(response),
      );
    } finally {
      fetch.mockRestore();
    }

    expect(fetch).not.toHaveBeenCalled();
    expect(emitted.length).toBeGreaterThanOrEqual(3);
    expect(
      emitted.every(isProjectDirectoryArchiveWorkerResponse),
    ).toBe(true);
    expect(emitted.at(-1)).toMatchObject({
      type: "result",
      jobId: 17,
      repositoryName: "Project",
      rootMode: "single-directory",
      admittedFileCount: 1,
      admittedBytes: 1,
    });
  });

  it("installs only in a dedicated worker scope, rejects concurrent jobs, and aborts on uninstall", async () => {
    let listener:
      | ((event: { readonly data: unknown }) => void)
      | undefined;
    const posted: ProjectDirectoryArchiveWorkerResponse[] = [];
    const scope: ProjectDirectoryArchiveWorkerScope = {
      importScripts: () => undefined,
      postMessage: (message) => posted.push(message),
      addEventListener: (_type, value) => {
        listener = value;
      },
      removeEventListener: (_type, value) => {
        if (listener === value) listener = undefined;
      },
    };
    expect(isDedicatedProjectDirectoryArchiveWorkerScope(scope)).toBe(true);
    expect(
      isDedicatedProjectDirectoryArchiveWorkerScope({
        ...scope,
        clients: {},
      }),
    ).toBe(false);

    const blocked = selectedFile("Project/blocked.ts", "value");
    Object.defineProperty(blocked.file, "slice", {
      value: () => ({
        arrayBuffer: () => new Promise<ArrayBuffer>(() => undefined),
      }),
    });
    const uninstall = installProjectDirectoryArchiveWorker(scope);
    listener?.({
      data: { type: "invalid", jobId: 99 },
    });
    expect(posted.at(-1)).toMatchObject({
      type: "failure",
      jobId: 99,
      error: { code: "invalid-selection" },
    });
    listener?.({
      data: { type: "create", jobId: 1, files: [blocked] },
    });
    listener?.({
      data: {
        type: "create",
        jobId: 2,
        files: [selectedFile("Project/other.ts", "other")],
      },
    });

    expect(posted.some((response) => response.jobId === 2)).toBe(true);
    expect(
      posted.find((response) => response.jobId === 2),
    ).toMatchObject({
      type: "failure",
      error: { code: "invalid-selection" },
    });
    uninstall();
    expect(listener).toBeUndefined();
    await vi.waitFor(() => {
      expect(
        posted.find(
          (response) =>
            response.jobId === 1 && response.type === "failure",
        ),
      ).toMatchObject({
        error: { code: "aborted" },
      });
    });
  });
});
