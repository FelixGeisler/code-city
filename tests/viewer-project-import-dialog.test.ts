import { describe, expect, it } from "vitest";

import {
  PROJECT_IMPORT_ANALYSIS_LIMITS,
  PROJECT_IMPORT_SOURCE_CHOICES,
  projectImportAnalysisOptions,
  projectImportCityModelSubmission,
  projectImportFieldForServerPath,
  projectImportIdentityOptions,
  projectImportNavigationLocked,
  projectImportPersistenceWarning,
  projectImportProvidersForSource,
  projectImportRemoteSubmission,
  projectImportRepositoryZipSubmission,
  projectImportRevision,
  projectImportShouldResetOnOpen,
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
      "terminal",
      "unavailable",
    ] as const) {
      expect(projectImportNavigationLocked(status)).toBe(true);
    }
    expect(projectImportNavigationLocked("idle")).toBe(false);
    expect(projectImportNavigationLocked("request-failed")).toBe(false);
  });

  it("starts fresh after success but preserves terminal failures on reopen", () => {
    expect(projectImportShouldResetOnOpen("completed")).toBe(true);
    expect(projectImportShouldResetOnOpen("terminal")).toBe(false);
    expect(projectImportShouldResetOnOpen("artifact-failed")).toBe(false);
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
