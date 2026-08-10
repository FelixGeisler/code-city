import { describe, expect, it } from "vitest";

import {
  PROJECT_IMPORT_ANALYSIS_LIMITS,
  PROJECT_IMPORT_HISTORY_DEFAULT_MAX_FRAMES,
  PROJECT_IMPORT_HISTORY_LIMITS,
  PROJECT_IMPORT_SOURCE_CHOICES,
  projectImportAnalysisOptions,
  projectImportCityModelSubmission,
  projectImportFieldForServerPath,
  projectImportHistoryRevisionError,
  projectImportHistorySelection,
  projectImportGitSource,
  projectImportIdentityOptions,
  projectImportNavigationLocked,
  projectImportPersistenceWarning,
  projectImportProvidersForSource,
  projectImportRemoteSubmission,
  projectImportRepositoryZipSubmission,
  projectImportRevision,
  projectImportShouldResetOnOpen,
  projectImportTerminalMessages,
  projectImportUploadSizeError,
} from "../apps/viewer/src/project-import-dialog.js";
import type {
  ImportControllerState,
} from "../apps/viewer/src/import-controller.js";

describe("viewer project import dialog state", () => {
  it("derives accepted analysis bounds from the server contract", () => {
    expect(PROJECT_IMPORT_ANALYSIS_LIMITS).toEqual({
      maxRetainedFiles: 50_000,
      maxFileMib: 2,
      maxTotalMib: 256,
      timeoutSeconds: 300,
    });
    expect(
      projectImportAnalysisOptions({
        maxRetainedFiles: "50000",
        maxFileMib: "2",
        maxTotalMib: "256",
        timeoutSeconds: "300",
      }),
    ).toEqual({
      maxRetainedFiles: 50_000,
      maxFileBytes: 2 * 1024 * 1024,
      maxTotalBytes: 256 * 1024 * 1024,
      timeoutMs: 300_000,
    });
    expect(() =>
      projectImportAnalysisOptions({
        maxRetainedFiles: "50001",
        maxFileMib: "",
        maxTotalMib: "",
        timeoutSeconds: "",
      }),
    ).toThrow(/50,?000/u);
    expect(() =>
      projectImportAnalysisOptions({
        maxRetainedFiles: "",
        maxFileMib: "3",
        maxTotalMib: "",
        timeoutSeconds: "",
      }),
    ).toThrow(/1 to 2/u);
    expect(() =>
      projectImportAnalysisOptions({
        maxRetainedFiles: "",
        maxFileMib: "",
        maxTotalMib: "257",
        timeoutSeconds: "",
      }),
    ).toThrow(/256/u);
    expect(() =>
      projectImportAnalysisOptions({
        maxRetainedFiles: "",
        maxFileMib: "",
        maxTotalMib: "",
        timeoutSeconds: "301",
      }),
    ).toThrow(/300/u);
    expect(() =>
      projectImportAnalysisOptions({
        maxRetainedFiles: "",
        maxFileMib: "2",
        maxTotalMib: "1",
        timeoutSeconds: "",
      }),
    ).toThrow(/must not exceed/u);
  });

  it("keeps repository history within the acquisition and frame bounds", () => {
    expect(PROJECT_IMPORT_HISTORY_LIMITS).toEqual({
      maxCommits: 500,
      maxSampleEvery: 500,
      maxFrames: 100,
      maxTagNameBytes: 246,
    });
    expect(PROJECT_IMPORT_HISTORY_DEFAULT_MAX_FRAMES).toBe(20);
  });

  it("keeps every accepted project source explicit", () => {
    expect(PROJECT_IMPORT_SOURCE_CHOICES).toEqual([
      "directory",
      "zip",
      "github-public",
      "github-authenticated",
      "azure-devops",
      "git",
      "city-model",
    ]);
  });

  it("detects repository providers without treating lookalike hosts as trusted providers", () => {
    expect(
      projectImportGitSource("https://github.com/example/project", false),
    ).toBe("github-public");
    expect(
      projectImportGitSource("https://GITHUB.COM/example/project", true),
    ).toBe("github-authenticated");
    expect(
      projectImportGitSource(
        "https://dev.azure.com/example/project/_git/repository",
        true,
      ),
    ).toBe("azure-devops");
    expect(
      projectImportGitSource(
        "https://example.visualstudio.com/project/_git/repository",
        false,
      ),
    ).toBe("azure-devops");
    expect(
      projectImportGitSource("https://github.com.evil.example/project", true),
    ).toBe("git");
    expect(projectImportGitSource("git@example:project.git", false)).toBe(
      "git",
    );
  });

  it("exposes only provider-appropriate credential profiles", () => {
    expect(
      projectImportProvidersForSource("github-authenticated"),
    ).toEqual(["github"]);
    expect(projectImportProvidersForSource("azure-devops")).toEqual([
      "azure-devops",
    ]);
    expect(
      projectImportProvidersForSource(
        "git",
        "https://git.example/repository.git",
      ),
    ).toEqual(["generic-https"]);
    expect(
      projectImportProvidersForSource(
        "git",
        "ssh://git.example/repository.git",
      ),
    ).toEqual([]);
    expect(
      projectImportProvidersForSource(
        "git",
        "git@example:repository.git",
      ),
    ).toEqual([]);
    expect(projectImportProvidersForSource("github-public")).toEqual([]);
  });

  it.each([
    {
      name: "public GitHub",
      values: {
        source: "github-public" as const,
        repositoryUrl: " https://github.com/example/public ",
        credentialProfileId: "ignored",
        revisionKind: "default",
        revisionValue: "",
      },
      expected: {
        kind: "github",
        repositoryUrl: "https://github.com/example/public",
      },
    },
    {
      name: "authenticated GitHub",
      values: {
        source: "github-authenticated" as const,
        repositoryUrl: "https://github.com/example/private",
        credentialProfileId: "github-main",
        revisionKind: "branch",
        revisionValue: "main",
      },
      expected: {
        kind: "github",
        repositoryUrl: "https://github.com/example/private",
        credentialProfileId: "github-main",
        revision: { kind: "branch", name: "main" },
      },
    },
    {
      name: "Azure DevOps",
      values: {
        source: "azure-devops" as const,
        repositoryUrl: "https://dev.azure.com/org/project/_git/repository",
        credentialProfileId: "ado-main",
        revisionKind: "tag",
        revisionValue: "release",
      },
      expected: {
        kind: "git",
        repositoryUrl:
          "https://dev.azure.com/org/project/_git/repository",
        credentialProfileId: "ado-main",
        revision: { kind: "tag", name: "release" },
      },
    },
    {
      name: "generic HTTPS Git",
      values: {
        source: "git" as const,
        repositoryUrl: "https://git.example/repository.git",
        credentialProfileId: "generic-main",
        revisionKind: "commit",
        revisionValue: "0123456789abcdef0123456789abcdef01234567",
      },
      expected: {
        kind: "git",
        repositoryUrl: "https://git.example/repository.git",
        credentialProfileId: "generic-main",
        revision: {
          kind: "commit",
          sha: "0123456789abcdef0123456789abcdef01234567",
        },
      },
    },
    {
      name: "generic SSH Git",
      values: {
        source: "git" as const,
        repositoryUrl: "git@example:repository.git",
        credentialProfileId: "must-not-leak",
        revisionKind: "default",
        revisionValue: "",
      },
      expected: {
        kind: "git",
        repositoryUrl: "git@example:repository.git",
      },
    },
  ])("serializes the $name source contract", ({ values, expected }) => {
    expect(projectImportRemoteSubmission(values).source).toEqual(expected);
    expect(projectImportRemoteSubmission(values)).not.toHaveProperty(
      "history",
    );
  });

  it("serializes each opt-in history mode as an exact root request", () => {
    const common = {
      enabled: true,
      mode: "commit-count",
      maxFrames: "20",
      commitCount: "500",
      fromInclusive: "",
      toInclusive: "",
      dateMaxCommits: "",
      oldestTagName: "",
      newestTagName: "",
      tagMaxCommits: "",
      sampleEvery: "6",
    };
    expect(
      projectImportHistorySelection({
        ...common,
        mode: "root-to-tip",
        sampleEvery: "not used for the recommended range",
      }),
    ).toEqual({
      mode: "root-to-tip",
      maxFrames: 20,
    });
    const commitCount = projectImportHistorySelection(common);
    expect(commitCount).toEqual({
      mode: "commit-count",
      commitCount: 500,
      sampleEvery: 6,
    });
    expect(
      projectImportHistorySelection({
        ...common,
        mode: "date-range",
        fromInclusive: "2026-01-02T03:04",
        toInclusive: "2026-02-03T04:05:06",
        dateMaxCommits: "100",
        sampleEvery: "",
      }),
    ).toEqual({
      mode: "date-range",
      fromInclusive: "2026-01-02T03:04:00.000Z",
      toInclusive: "2026-02-03T04:05:06.000Z",
      maxCommits: 100,
    });
    const tagRange = projectImportHistorySelection({
      ...common,
      mode: "tag-range",
      oldestTagName: "releases/v1.0.0",
      newestTagName: "v2.0.0",
      tagMaxCommits: "250",
      sampleEvery: "3",
    });
    expect(tagRange).toEqual({
      mode: "tag-range",
      oldestTagName: "releases/v1.0.0",
      newestTagName: "v2.0.0",
      maxCommits: 250,
      sampleEvery: 3,
    });
    if (tagRange === undefined) {
      throw new Error("Expected an enabled tag-range history selection.");
    }
    expect(
      projectImportRemoteSubmission({
        source: "github-public",
        repositoryUrl: "https://github.com/example/history",
        credentialProfileId: "",
        revisionKind: "default",
        revisionValue: "",
        history: tagRange,
      }),
    ).toEqual({
      source: {
        kind: "github",
        repositoryUrl: "https://github.com/example/history",
      },
      history: tagRange,
    });
    expect(
      projectImportHistorySelection({
        ...common,
        enabled: false,
        commitCount: "not validated while disabled",
      }),
    ).toBeUndefined();
  });

  it("rejects unbounded, oversampled, unordered, and inexact history input", () => {
    const common = {
      enabled: true,
      mode: "commit-count",
      maxFrames: "20",
      commitCount: "1",
      fromInclusive: "",
      toInclusive: "",
      dateMaxCommits: "1",
      oldestTagName: "v1",
      newestTagName: "v2",
      tagMaxCommits: "1",
      sampleEvery: "1",
    };
    for (const values of [
      { ...common, commitCount: "0" },
      { ...common, commitCount: "501" },
      { ...common, sampleEvery: "0" },
      { ...common, sampleEvery: "501" },
      { ...common, commitCount: "101", sampleEvery: "1" },
      { ...common, commitCount: "500", sampleEvery: "5" },
      { ...common, mode: "root-to-tip", maxFrames: "0" },
      { ...common, mode: "root-to-tip", maxFrames: "1" },
      { ...common, mode: "root-to-tip", maxFrames: "2" },
      { ...common, mode: "root-to-tip", maxFrames: "101" },
    ]) {
      expect(() => projectImportHistorySelection(values)).toThrow();
    }
    expect(() =>
      projectImportHistorySelection({
        ...common,
        mode: "date-range",
        fromInclusive: "2026-02-30T00:00",
        toInclusive: "2026-03-01T00:00",
      }),
    ).toThrow(/valid starting UTC/iu);
    expect(() =>
      projectImportHistorySelection({
        ...common,
        mode: "date-range",
        fromInclusive: "2026-03-02T00:00",
        toInclusive: "2026-03-01T00:00",
      }),
    ).toThrow(/must not be later/iu);
    for (const oldestTagName of [
      "",
      " v1",
      "refs/heads/main",
      "refs/tags/v1",
      "release..candidate",
    ]) {
      expect(() =>
        projectImportHistorySelection({
          ...common,
          mode: "tag-range",
          oldestTagName,
        }),
      ).toThrow(/oldest tag/iu);
    }
    expect(
      projectImportHistorySelection({
        ...common,
        mode: "tag-range",
        oldestTagName: "a".repeat(
          PROJECT_IMPORT_HISTORY_LIMITS.maxTagNameBytes,
        ),
      }),
    ).toMatchObject({
      oldestTagName: "a".repeat(
        PROJECT_IMPORT_HISTORY_LIMITS.maxTagNameBytes,
      ),
    });
    expect(() =>
      projectImportHistorySelection({
        ...common,
        mode: "tag-range",
        oldestTagName: "a".repeat(
          PROJECT_IMPORT_HISTORY_LIMITS.maxTagNameBytes + 1,
        ),
      }),
    ).toThrow(/246 UTF-8 bytes/iu);
  });

  it("requires the default revision for an exact tag-range history", () => {
    const history = {
      mode: "tag-range",
      oldestTagName: "v1",
      newestTagName: "v2",
      maxCommits: 100,
    } as const;
    const revision = { kind: "branch", name: "main" } as const;
    expect(
      projectImportHistoryRevisionError(history, revision),
    ).toMatch(/default revision/iu);
    expect(
      projectImportHistoryRevisionError(history, undefined),
    ).toBeUndefined();
    expect(
      projectImportHistoryRevisionError(
        { mode: "commit-count", commitCount: 10 },
        revision,
      ),
    ).toBeUndefined();
    expect(() =>
      projectImportRemoteSubmission({
        source: "github-public",
        repositoryUrl: "https://github.com/example/history",
        credentialProfileId: "",
        revisionKind: "branch",
        revisionValue: "main",
        history,
      }),
    ).toThrow(/default revision/iu);
  });

  it("serializes directory, ZIP, and city-model uploads distinctly", () => {
    expect(
      projectImportRepositoryZipSubmission(
        123,
        "Directory",
        "single-directory",
        { title: "Directory city" },
        { maxRetainedFiles: 10 },
      ),
    ).toEqual({
      source: {
        kind: "repository-zip",
        sizeBytes: 123,
        repositoryName: "Directory",
        rootMode: "single-directory",
      },
      identity: { title: "Directory city" },
      analysis: { maxRetainedFiles: 10 },
    });
    expect(
      projectImportRepositoryZipSubmission(
        456,
        "Archive",
        "archive-root",
      ),
    ).toEqual({
      source: {
        kind: "repository-zip",
        sizeBytes: 456,
        repositoryName: "Archive",
        rootMode: "archive-root",
      },
    });
    expect(projectImportCityModelSubmission(789)).toEqual({
      source: { kind: "city-model", sizeBytes: 789 },
    });
  });

  it("requires a city title whenever a city version is supplied", () => {
    expect(
      projectImportIdentityOptions({
        title: "  Example city  ",
        version: "  release-1  ",
      }),
    ).toEqual({
      title: "Example city",
      version: "release-1",
    });
    expect(
      projectImportIdentityOptions({ title: "", version: "" }),
    ).toBeUndefined();
    expect(() =>
      projectImportIdentityOptions({
        title: "",
        version: "release-1",
      }),
    ).toThrow(/city title/iu);
  });

  it("creates discriminated branch, tag, and exact-commit revisions", () => {
    expect(projectImportRevision("default", "")).toBeUndefined();
    expect(projectImportRevision("branch", " main ")).toEqual({
      kind: "branch",
      name: "main",
    });
    expect(projectImportRevision("tag", "v1.2.3")).toEqual({
      kind: "tag",
      name: "v1.2.3",
    });
    expect(
      projectImportRevision(
        "commit",
        "ABCDEF0123456789ABCDEF0123456789ABCDEF01",
      ),
    ).toEqual({
      kind: "commit",
      sha: "abcdef0123456789abcdef0123456789abcdef01",
    });
    expect(() => projectImportRevision("commit", "abc")).toThrow(
      /40-character/iu,
    );
    expect(() => projectImportRevision("branch", "")).toThrow(
      /branch/iu,
    );
  });

  it("maps server validation paths to actionable form fields", () => {
    expect(
      projectImportFieldForServerPath("$.source.repositoryUrl"),
    ).toBe("repositoryUrl");
    expect(
      projectImportFieldForServerPath(
        "$.source.revision.sha",
      ),
    ).toBe("revision");
    expect(
      projectImportFieldForServerPath(
        "$.source.credentialProfileId",
      ),
    ).toBe("credentialProfileId");
    expect(
      projectImportFieldForServerPath(
        "$.analysis.maxTotalBytes",
      ),
    ).toBe("analysis");
    expect(
      projectImportFieldForServerPath("$.history.oldestTagName"),
    ).toBe("history");
    expect(
      projectImportFieldForServerPath("$.history.sampleEvery"),
    ).toBe("history");
    expect(
      projectImportFieldForServerPath("$.history.maxFrames"),
    ).toBe("history");
    expect(
      projectImportFieldForServerPath("$.identity.title"),
    ).toBe("title");
    expect(
      projectImportFieldForServerPath("$.source.sizeBytes", "city-model"),
    ).toBe("model");
    expect(
      projectImportFieldForServerPath("$.source.sizeBytes", "directory"),
    ).toBe("directory");
    expect(
      projectImportFieldForServerPath("$.source.sizeBytes", "zip"),
    ).toBe("zip");
    expect(projectImportFieldForServerPath("$.unexpected")).toBeUndefined();
  });

  it("rejects empty uploads before submitting them", () => {
    expect(projectImportUploadSizeError("city-model", 0)).toMatch(
      /must not be empty/u,
    );
    expect(projectImportUploadSizeError("zip", 0)).toMatch(
      /must not be empty/u,
    );
    expect(projectImportUploadSizeError("city-model", 1)).toBeUndefined();
    expect(projectImportUploadSizeError("zip", 1)).toBeUndefined();
  });

  it("locks generic navigation while attention-only actions are visible", () => {
    for (const status of [
      "artifact-failed",
      "completed",
      "opening-artifact",
      "removal-failed",
      "removing-result",
      "terminal",
      "unavailable",
    ] as const) {
      expect(projectImportNavigationLocked(status)).toBe(true);
    }
    expect(projectImportNavigationLocked("idle")).toBe(false);
    expect(projectImportNavigationLocked("request-failed")).toBe(false);
  });

  it("preserves completed results so their removal action remains reachable", () => {
    expect(projectImportShouldResetOnOpen("completed")).toBe(false);
    expect(projectImportShouldResetOnOpen("terminal")).toBe(false);
    expect(projectImportShouldResetOnOpen("artifact-failed")).toBe(false);
  });

  it("shows a stable safe diagnostic code with terminal failures", () => {
    expect(projectImportTerminalMessages({
      id: "11111111-1111-4111-8111-111111111111",
      kind: "project-import",
      state: "failed",
      createdAt: "2026-08-09T00:00:00.000Z",
      updatedAt: "2026-08-09T00:00:01.000Z",
      error: {
        code: "history-response-invalid",
        message: "Git returned unsupported history metadata.",
      },
    })).toEqual([
      "Git returned unsupported history metadata.",
      "Diagnostic code: history-response-invalid",
    ]);
  });

  it("keeps persistence warnings visible throughout accepted job states", () => {
    const queuedJob = {
      id: "11111111-1111-4111-8111-111111111111",
      kind: "project-import",
      state: "queued",
      createdAt: "2026-07-30T10:00:00.000Z",
      updatedAt: "2026-07-30T10:00:00.000Z",
    } as const;
    const completedJob = {
      ...queuedJob,
      state: "completed",
      result: {
        kind: "city-model",
        artifactToken: queuedJob.id,
        artifactUrl:
          `/api/v1/artifacts/${queuedJob.id}/city-model.json`,
      },
    } as const;
    const terminalJob = {
      ...queuedJob,
      state: "failed",
      error: {
        code: "analysis-failed",
        message: "Repository analysis failed.",
      },
    } as const;
    const states = [
      {
        status: "job",
        job: queuedJob,
        cancelling: false,
        persistenceAvailable: false,
      },
      {
        status: "recovering",
        jobId: queuedJob.id,
        job: queuedJob,
        message: "Disconnected.",
        retryAt: 1,
        persistenceAvailable: false,
      },
      {
        status: "opening-artifact",
        job: completedJob,
        persistenceAvailable: false,
      },
      {
        status: "artifact-failed",
        job: completedJob,
        message: "Could not open the city.",
        persistenceAvailable: false,
      },
      {
        status: "completed",
        job: completedJob,
        persistenceAvailable: false,
      },
      {
        status: "removing-result",
        job: completedJob,
        persistenceAvailable: false,
      },
      {
        status: "removal-failed",
        job: completedJob,
        message: "Cleanup failed.",
        persistenceAvailable: false,
      },
      {
        status: "terminal",
        job: terminalJob,
        persistenceAvailable: false,
      },
    ] satisfies readonly ImportControllerState[];

    for (const state of states) {
      expect(projectImportPersistenceWarning(state)).toMatch(
        /cannot save import recovery state/iu,
      );
    }
    expect(
      projectImportPersistenceWarning({
        status: "job",
        job: queuedJob,
        cancelling: false,
        persistenceAvailable: true,
      }),
    ).toBeUndefined();
  });
});
