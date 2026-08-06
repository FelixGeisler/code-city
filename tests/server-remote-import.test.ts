import { promises as fs } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_SNAPSHOT_LIMITS,
  genericGitRepositoryOrigin,
  GENERIC_GIT_PRESECURED_CANONICAL_ANCESTRY,
  GENERIC_GIT_PRESECURED_WINDOWS_ACL,
  GenericGitSnapshotError,
  GitHubSnapshotError,
  HISTORY_SELECTION_LIMITS,
  HistoryEvolutionError,
  HistorySelectionError,
  SnapshotDeadlineError,
  SnapshotLimitError,
  SnapshotPathError,
  SnapshotPolicyError,
  type GenericGitAnalysisResult,
  type GenericGitHistoryAnalysisResult,
  type PublicGitHubAnalysisResult,
} from "../packages/analyzer/src/index.js";
import {
  prepareEvolutionSerialization,
  serializeEvolutionBundle,
  type CityModel,
  type EvolutionBundle,
} from "../packages/core/src/index.js";
import type { JobRecord } from "../apps/server/src/job-queue.js";
import {
  environmentAllowedGitOrigins,
  environmentWindowsGitWorkspaceTrust,
} from "../apps/server/src/main.js";
import {
  parseRemoteImportJson,
  parseRemoteImportRequest,
  enqueueRemoteImport,
  RemoteImportPolicy,
  RemoteImportRequestError,
  type RemoteImportDependencies,
} from "../apps/server/src/remote-import.js";
import {
  REMOTE_IMPORT_REQUEST_MAX_BYTES,
  startCodeCityServer,
  type CodeCityServerHandle,
} from "../apps/server/src/server.js";

const temporaryDirectories: string[] = [];
const servers: CodeCityServerHandle[] = [];
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const AUTHORIZATION_TOKEN = Buffer.alloc(32, 0x3d).toString("base64url");
const PROFILE_SECRET = "server-owned-repository-credential";

interface TestCredentialProfile {
  readonly id: string;
  readonly label: string;
  readonly provider: "github" | "azure-devops" | "generic-https";
  readonly repositories: readonly string[];
  readonly authentication:
    | {
        readonly kind: "bearer";
        readonly secretFile: string;
      }
    | {
        readonly kind: "basic";
        readonly username: string;
        readonly secretFile: string;
      };
}

function cityModelFixture(): CityModel {
  return {
    schemaVersion: "1.0",
    generator: { name: "code-city", version: "test" },
    repositories: [],
    solutions: [],
    modules: [],
    semanticGroups: [],
    districts: [],
    buildings: [],
    dependencies: [],
    bounds: { x: 0, y: 0, z: 0 },
  };
}

function historyCityModelFixture(): CityModel {
  return {
    ...cityModelFixture(),
    repositories: [{ id: "repository:one", name: "One" }],
  };
}

function evolutionBundleFixture(
  model = historyCityModelFixture(),
): EvolutionBundle {
  const fingerprint = `sha256:${"1".repeat(64)}` as const;
  return {
    schemaVersion: "1.0",
    generator: model.generator,
    authorPolicy: "omit-v1",
    selection: {
      mode: "commit-count",
      traversal: "first-parent",
      order: "oldest-first",
      sampleEvery: 1,
      requestedCommitCount: 1,
      selectedCommitCount: 1,
      sampledCommitCount: 1,
      traversedCommitCount: 1,
      resolvedOldestSha: COMMIT,
      resolvedNewestSha: COMMIT,
      sampledCommitShas: [COMMIT],
    },
    provenance: {
      repositoryId: "repository:one",
      repositoryFingerprint: fingerprint,
      analyzer: {
        name: "code-city",
        version: model.generator.version,
        fingerprint,
      },
      historyBackend: {
        name: "git",
        version: "2.47.1.windows.2",
        renamePolicyRevision: "diff-tree-renames-50-myers-v1",
      },
      metricConfigurationFingerprint: fingerprint,
      selectionFingerprint: fingerprint,
    },
    baseline: {
      commit: {
        index: 0,
        sha: COMMIT,
        committedAt: "2026-01-01T00:00:00.000Z",
        parentShas: [],
        analyzerVersion: model.generator.version,
        analysisFingerprint: fingerprint,
      },
      model,
    },
    deltas: [],
  };
}

function historyAnalysisResultFixture(
  model = historyCityModelFixture(),
): GenericGitHistoryAnalysisResult {
  const bundle = evolutionBundleFixture(model);
  const preparedSerialization =
    prepareEvolutionSerialization(bundle);
  const commit = {
    sha: COMMIT,
    parents: [] as const,
    committedAt: "2026-01-01T00:00:00.000Z",
  };
  const analysisBounds = {
    totalDeadlineMs: 60_000,
    maxAggregateChangedPaths: 500_000,
    maxAggregateChangedPathBytes: 16 * 1024 * 1024,
    maxAggregateSemanticBytes: 128 * 1024 * 1024,
    maxUniqueLineages: 100_000,
    maxEvolutionOutputBytes:
      HISTORY_SELECTION_LIMITS.maxEvolutionOutputBytes,
    maxAggregateTreeEntries: 2_000_000,
  };
  return {
    repository: "example",
    tipSha: COMMIT,
    transport: "https",
    historyBackend: {
      name: "git",
      version: "2.47.1.windows.2",
      renamePolicyRevision:
        "sampled-boundary-diff-tree-renames-50-myers-v2",
    },
    selection: {
      selectedCommits: [commit],
      sampledCommits: [commit],
      summary: bundle.selection,
      analysisBounds,
      requestedTagCount: 0,
    },
    model,
    evolution: {
      repositoryId: "repository:one",
      model,
      bundle: preparedSerialization.bundle,
      preparedSerialization,
    },
    costEstimate: {
      traversedCommitCount: 1,
      selectedCommitCount: 1,
      sampledFrameCount: 1,
      maximumChangedPathEntries:
        analysisBounds.maxAggregateChangedPaths,
      maximumChangedPathBytes:
        analysisBounds.maxAggregateChangedPathBytes,
      maximumSemanticBytes:
        analysisBounds.maxAggregateSemanticBytes,
      maximumTreeEntries: analysisBounds.maxAggregateTreeEntries,
      maximumUniqueLineages: analysisBounds.maxUniqueLineages,
      maximumOutputBytes: analysisBounds.maxEvolutionOutputBytes,
      totalDeadlineMs: analysisBounds.totalDeadlineMs,
    },
    cacheHits: 0,
    cacheMisses: 1,
  };
}

async function fixture(): Promise<{
  readonly dataDirectory: string;
  readonly viewerRoot: string;
}> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "code-city-import-api-"),
  );
  temporaryDirectories.push(root);
  const dataDirectory = path.join(root, "data");
  const viewerRoot = path.join(root, "viewer");
  await fs.mkdir(viewerRoot, { recursive: true });
  await fs.writeFile(
    path.join(viewerRoot, "index.html"),
    "<!doctype html><title>Code City</title>",
    "utf8",
  );
  return { dataDirectory, viewerRoot };
}

async function privateFile(
  file: string,
  contents: string,
): Promise<void> {
  await fs.writeFile(file, contents, { mode: 0o600 });
  if (process.platform !== "win32") await fs.chmod(file, 0o600);
}

async function credentialServerOptions(
  roots: {
    readonly dataDirectory: string;
    readonly viewerRoot: string;
  },
  profiles: readonly TestCredentialProfile[],
): Promise<{
  readonly authorization: {
    readonly tokenFile: string;
    readonly publicOrigin: string;
    readonly trustWindowsTokenFile: boolean;
  };
  readonly credentialProfiles: {
    readonly profilesFile: string;
    readonly trustWindowsCredentialFiles: boolean;
  };
}> {
  const root = path.dirname(roots.dataDirectory);
  const credentialDirectory = path.join(root, "credentials");
  await fs.mkdir(credentialDirectory, { mode: 0o700 });
  if (process.platform !== "win32") {
    await fs.chmod(credentialDirectory, 0o700);
  }
  await privateFile(
    path.join(credentialDirectory, "repository.secret"),
    `${PROFILE_SECRET}\n`,
  );
  const profilesFile = path.join(credentialDirectory, "profiles.json");
  await privateFile(
    profilesFile,
    JSON.stringify({ version: 1, profiles }),
  );
  const tokenFile = path.join(root, "authorization-token");
  await privateFile(tokenFile, `${AUTHORIZATION_TOKEN}\n`);
  return {
    authorization: {
      tokenFile,
      publicOrigin: "https://codecity.test",
      trustWindowsTokenFile: process.platform === "win32",
    },
    credentialProfiles: {
      profilesFile,
      trustWindowsCredentialFiles: process.platform === "win32",
    },
  };
}

async function waitForTerminal(
  server: CodeCityServerHandle,
  id: string,
): Promise<JobRecord> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const record = server.jobs.get(id);
    if (
      record?.state === "completed" ||
      record?.state === "failed" ||
      record?.state === "cancelled"
    ) {
      return record;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for import job '${id}'.`);
}

async function request(
  url: URL,
  options: {
    readonly method?: string;
    readonly headers?: http.OutgoingHttpHeaders;
    readonly body?: string | Buffer;
    readonly chunked?: boolean;
  } = {},
): Promise<{
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}> {
  return new Promise((resolve, reject) => {
    const outgoing = http.request(
      {
        hostname: url.hostname,
        port: Number(url.port),
        path: url.pathname,
        method: options.method ?? "GET",
        headers: options.headers,
        agent: false,
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.on("end", () => {
          resolve({
            status: incoming.statusCode ?? 0,
            headers: incoming.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    outgoing.on("error", reject);
    if (options.chunked && options.body !== undefined) {
      outgoing.write(options.body);
      outgoing.end();
    } else {
      outgoing.end(options.body);
    }
  });
}

function importHeaders(): http.OutgoingHttpHeaders {
  return {
    "Content-Type": "application/json",
    "X-Code-City-Request": "1",
  };
}

function authorizedImportHeaders(): http.OutgoingHttpHeaders {
  return {
    ...importHeaders(),
    Authorization: `Bearer ${AUTHORIZATION_TOKEN}`,
    Host: "codecity.test",
  };
}

function rawHttpExchange(
  port: number,
  bytes: string,
  timeoutMs = 2_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({
      host: "127.0.0.1",
      port,
    });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Raw HTTP exchange timed out."));
    }, timeoutMs);
    const settle = (): void => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    socket.on("connect", () => socket.write(bytes));
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.once("end", settle);
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function importBody(
  source: unknown = {
    kind: "github",
    repositoryUrl: "https://github.com/openai/example",
  },
): string {
  return JSON.stringify({ source });
}

function successfulDependencies(
  model = cityModelFixture(),
): {
  readonly dependencies: RemoteImportDependencies;
  readonly github: ReturnType<typeof vi.fn>;
  readonly git: ReturnType<typeof vi.fn>;
} {
  const github = vi.fn(
    async (): Promise<PublicGitHubAnalysisResult> => ({
      owner: "openai",
      repository: "example",
      canonicalRepositoryUrl: "https://github.com/openai/example",
      commitSha: COMMIT,
      model,
    }),
  );
  const git = vi.fn(
    async (): Promise<GenericGitAnalysisResult> => ({
      repository: "example",
      commitSha: COMMIT,
      transport: "https",
      model,
    }),
  );
  return {
    dependencies: {
      analyzePublicGitHubRepository: github,
      analyzeGenericGitRepository: git,
    } as RemoteImportDependencies,
    github,
    git,
  };
}

afterEach(async () => {
  await Promise.allSettled(servers.splice(0).map((server) => server.close()));
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
  vi.restoreAllMocks();
});

describe("remote import request parsing", () => {
  it("derives exact normalized origins from every Generic Git remote form", () => {
    expect(
      genericGitRepositoryOrigin("https://Example.COM/group/repo.git"),
    ).toEqual({ scheme: "https", hostname: "example.com", port: 443 });
    expect(
      genericGitRepositoryOrigin(
        "https://example.com:8443/group/repo.git",
      ),
    ).toEqual({
      scheme: "https",
      hostname: "example.com",
      port: 8443,
    });
    expect(
      genericGitRepositoryOrigin("ssh://git@Example.COM/group/repo.git"),
    ).toEqual({ scheme: "ssh", hostname: "example.com", port: 22 });
    expect(
      genericGitRepositoryOrigin("git@Example.COM:group/repo.git"),
    ).toEqual({ scheme: "ssh", hostname: "example.com", port: 22 });
    expect(
      genericGitRepositoryOrigin(
        "ssh://git@[2001:DB8::1]:2222/group/repo.git",
      ),
    ).toEqual({
      scheme: "ssh",
      hostname: "2001:db8::1",
      port: 2222,
    });
    expect(() =>
      genericGitRepositoryOrigin(
        "https://example.com:0/group/repo.git",
      ),
    ).toThrow();
  });

  it("normalizes discriminated revisions without weakening exact input checks", () => {
    expect(
      parseRemoteImportJson(
        JSON.stringify({
          source: {
            kind: "github",
            repositoryUrl: "https://github.com/openai/example.git",
            credentialProfileId: "github-private",
            revision: { kind: "branch", name: "feature/demo" },
          },
          identity: { title: "Demo", version: "1", logo: "art/logo.svg" },
          analysis: {
            maxRetainedFiles: 12,
            maxFileBytes: 100,
            maxTotalBytes: 200,
            timeoutMs: 1_000,
          },
        }),
      ),
    ).toEqual({
      source: {
        kind: "github",
        repositoryUrl: "https://github.com/openai/example",
        credentialProfileId: "github-private",
        revision: { kind: "branch", name: "feature/demo" },
        ref: "heads/feature/demo",
      },
      identity: { title: "Demo", version: "1", logo: "art/logo.svg" },
      analysis: {
        maxRetainedFiles: 12,
        maxFileBytes: 100,
        maxTotalBytes: 200,
        timeoutMs: 1_000,
      },
    });

    expect(
      parseRemoteImportRequest({
        source: {
          kind: "git",
          repositoryUrl: "https://example.test/repository.git",
          revision: { kind: "commit", sha: COMMIT.toUpperCase() },
        },
      }).source,
    ).toMatchObject({
      revision: { kind: "commit", sha: COMMIT },
      ref: COMMIT,
    });

    const sameNameBranch = parseRemoteImportRequest({
      source: {
        kind: "github",
        repositoryUrl: "https://github.com/openai/example",
        revision: { kind: "branch", name: "release" },
      },
    });
    const sameNameTag = parseRemoteImportRequest({
      source: {
        kind: "github",
        repositoryUrl: "https://github.com/openai/example",
        revision: { kind: "tag", name: "release" },
      },
    });
    expect(sameNameBranch.source.ref).toBe("heads/release");
    expect(sameNameTag.source.ref).toBe("tags/release");
  });

  it("normalizes full-mainline, commit, date, and tag history selections", () => {
    expect(
      parseRemoteImportRequest({
        source: {
          kind: "github",
          repositoryUrl: "https://github.com/openai/example",
        },
        history: {
          mode: "root-to-tip",
          maxFrames: 20,
          totalDeadlineMs: 60_000,
        },
      }).history,
    ).toEqual({
      mode: "root-to-tip",
      maxFrames: 20,
      totalDeadlineMs: 60_000,
    });

    expect(
      parseRemoteImportRequest({
        source: {
          kind: "github",
          repositoryUrl: "https://github.com/openai/example",
        },
        history: {
          mode: "commit-count",
          commitCount: 500,
          sampleEvery: 6,
          totalDeadlineMs: 60_000,
          maxAggregateChangedPaths: 10_000,
          maxAggregateChangedPathBytes: 250_000,
          maxAggregateSemanticBytes: 750_000,
          maxAggregateTreeEntries: 20_000,
          maxUniqueLineages: 5_000,
          maxEvolutionOutputBytes: 1_000_000,
        },
      }).history,
    ).toEqual({
      mode: "commit-count",
      commitCount: 500,
      sampleEvery: 6,
      totalDeadlineMs: 60_000,
      maxAggregateChangedPaths: 10_000,
      maxAggregateChangedPathBytes: 250_000,
      maxAggregateSemanticBytes: 750_000,
      maxAggregateTreeEntries: 20_000,
      maxUniqueLineages: 5_000,
      maxEvolutionOutputBytes: 1_000_000,
    });

    expect(
      parseRemoteImportRequest({
        source: {
          kind: "git",
          repositoryUrl: "https://example.test/repository.git",
        },
        history: {
          mode: "date-range",
          fromInclusive: "2025-01-01T01:00:00+01:00",
          toInclusive: "2025-01-03T00:00:00Z",
          maxCommits: 100,
        },
      }).history,
    ).toEqual({
      mode: "date-range",
      fromInclusive: "2025-01-01T00:00:00.000Z",
      toInclusive: "2025-01-03T00:00:00.000Z",
      maxCommits: 100,
    });

    expect(
      parseRemoteImportRequest({
        source: {
          kind: "github",
          repositoryUrl: "https://github.com/openai/example",
        },
        history: {
          mode: "tag-range",
          oldestTagName: "rele\u0301ase/v1.0.0",
          newestTagName: "release/v2.0.0",
          maxCommits: 100,
        },
      }).history,
    ).toEqual({
      mode: "tag-range",
      oldestTagName: "reléase/v1.0.0",
      newestTagName: "release/v2.0.0",
      maxCommits: 100,
    });
  });

  it("rejects history selections that cannot be bounded before analysis", () => {
    const source = {
      kind: "github",
      repositoryUrl: "https://github.com/openai/example",
    };
    for (const history of [
      {
        mode: "root-to-tip",
        maxFrames: 1,
      },
      {
        mode: "root-to-tip",
        maxFrames: 20,
        sampleEvery: 2,
      },
      {
        mode: "commit-count",
        commitCount: 101,
      },
      {
        mode: "commit-count",
        commitCount: 501,
        sampleEvery: 6,
      },
      {
        mode: "commit-count",
        commitCount: 1,
        maxAggregateSemanticBytes:
          HISTORY_SELECTION_LIMITS.maxAggregateSemanticBytes + 1,
      },
      {
        mode: "date-range",
        fromInclusive: "2025-01-03T00:00:00Z",
        toInclusive: "2025-01-01T00:00:00Z",
        maxCommits: 100,
      },
      {
        mode: "date-range",
        fromInclusive: "2025-01-01",
        toInclusive: "2025-01-03T00:00:00Z",
        maxCommits: 100,
      },
      {
        mode: "date-range",
        fromInclusive: "2025-02-30T00:00:00Z",
        toInclusive: "2025-03-03T00:00:00Z",
        maxCommits: 100,
      },
      {
        mode: "date-range",
        fromInclusive: "2025-01-01T24:00:00Z",
        toInclusive: "2025-01-03T00:00:00Z",
        maxCommits: 100,
      },
      {
        mode: "date-range",
        fromInclusive: "9999-12-31T23:00:00-23:00",
        toInclusive: "9999-12-31T23:59:59Z",
        maxCommits: 100,
      },
      {
        mode: "date-range",
        fromInclusive: "9999-12-31T23:59:59Z",
        toInclusive: "9999-12-31T23:00:00-23:00",
        maxCommits: 100,
      },
      {
        mode: "tag-range",
        oldestTagName: "refs/tags/v1",
        newestTagName: "v2",
        maxCommits: 100,
      },
      {
        mode: "tag-range",
        oldestTagName: "v1",
        newestTagName: "v2",
        maxCommits: 100,
        unexpected: true,
      },
    ]) {
      expect(() =>
        parseRemoteImportRequest({ source, history }),
      ).toThrow(RemoteImportRequestError);
    }

    expect(() =>
      parseRemoteImportRequest({
        source: {
          ...source,
          revision: { kind: "branch", name: "main" },
        },
        history: {
          mode: "tag-range",
          oldestTagName: "v1",
          newestTagName: "v2",
          maxCommits: 100,
        },
      }),
    ).toThrowError(
      expect.objectContaining({
        fields: [
          expect.objectContaining({
            path: "$.source.revision",
          }),
        ],
      }),
    );
  });

  it("accepts only tag names that fit after the exact refs/tags prefix", () => {
    const maximumTag = "a".repeat(
      HISTORY_SELECTION_LIMITS.maxTagNameBytes,
    );
    expect(
      parseRemoteImportRequest({
        source: {
          kind: "github",
          repositoryUrl: "https://github.com/openai/example",
        },
        history: {
          mode: "tag-range",
          oldestTagName: maximumTag,
          newestTagName: maximumTag,
          maxCommits: 1,
        },
      }).history,
    ).toMatchObject({
      oldestTagName: maximumTag,
      newestTagName: maximumTag,
    });
    expect(() =>
      parseRemoteImportRequest({
        source: {
          kind: "github",
          repositoryUrl: "https://github.com/openai/example",
        },
        history: {
          mode: "tag-range",
          oldestTagName: `${maximumTag}a`,
          newestTagName: "v2",
          maxCommits: 1,
        },
      }),
    ).toThrowError(
      expect.objectContaining({
        fields: [
          expect.objectContaining({
            path: "$.history.oldestTagName",
          }),
        ],
      }),
    );
  });

  it("rejects a snapshot timeout too short to supply the history deadline", () => {
    try {
      parseRemoteImportRequest({
        source: {
          kind: "github",
          repositoryUrl: "https://github.com/openai/example",
        },
        history: {
          mode: "commit-count",
          commitCount: 1,
        },
        analysis: {
          timeoutMs:
            HISTORY_SELECTION_LIMITS.minTotalDeadlineMs - 1,
        },
      });
      throw new Error("Expected parsing to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(RemoteImportRequestError);
      expect((error as RemoteImportRequestError).fields).toEqual([
        expect.objectContaining({
          path: "$.analysis.timeoutMs",
          message: expect.stringContaining(
            String(HISTORY_SELECTION_LIMITS.minTotalDeadlineMs),
          ),
        }),
      ]);
    }
  });

  it("rejects ambiguous analysis and history deadlines", () => {
    expect(() =>
      parseRemoteImportRequest({
        source: {
          kind: "github",
          repositoryUrl: "https://github.com/openai/example",
        },
        history: {
          mode: "commit-count",
          commitCount: 1,
          totalDeadlineMs: 60_000,
        },
        analysis: { timeoutMs: 30_000 },
      }),
    ).toThrowError(
      expect.objectContaining({
        fields: [
          expect.objectContaining({
            path: "$.analysis.timeoutMs",
            message: expect.stringContaining(
              "history.totalDeadlineMs",
            ),
          }),
        ],
      }),
    );
  });

  it("accepts only an exact bounded credential profile identifier", () => {
    const maximumIdentifier = `a${"0".repeat(63)}`;
    expect(
      parseRemoteImportRequest({
        source: {
          kind: "github",
          repositoryUrl: "https://github.com/openai/example",
          credentialProfileId: maximumIdentifier,
        },
      }).source.credentialProfileId,
    ).toBe(maximumIdentifier);

    for (const credentialProfileId of [
      undefined,
      null,
      1,
      "",
      "1github",
      "GitHub",
      "github_profile",
      " github",
      "github ",
      "github\nprofile",
      `a${"0".repeat(64)}`,
    ]) {
      try {
        parseRemoteImportRequest({
          source: {
            kind: "github",
            repositoryUrl: "https://github.com/openai/example",
            credentialProfileId,
          },
        });
        throw new Error("Expected credential profile parsing to fail.");
      } catch (error) {
        expect(error).toBeInstanceOf(RemoteImportRequestError);
        expect(
          (error as RemoteImportRequestError).fields,
        ).toEqual([
          expect.objectContaining({
            path: "$.source.credentialProfileId",
          }),
        ]);
      }
    }
  });

  it.each([
    [
      '{"source":{"kind":"github","repositoryUrl":"https://github.com/openai/example"},"source":{}}',
      "duplicate-field",
    ],
    [
      '{"source":{"kind":"github","repositoryUrl":"https://github.com/openai/example","\\u006bind":"github"}}',
      "duplicate-field",
    ],
    [
      '{"source":{"kind":"github","repositoryUrl":"https://github.com/openai/example"},"__proto__":{}}',
      "unknown-field",
    ],
    [
      '{"source":{"kind":"github","repositoryUrl":"https://github.com/openai/example","extra":true}}',
      "unknown-field",
    ],
  ])("rejects duplicate, escaped-equivalent, and unknown members", (json, code) => {
    expect(() => parseRemoteImportJson(json)).toThrowError(
      expect.objectContaining({
        fields: [expect.objectContaining({ code })],
      }),
    );
  });

  it("rejects non-plain objects and prototype-mutating literals", () => {
    const source = {
      kind: "github",
      repositoryUrl: "https://github.com/openai/example",
    };
    const changedPrototype = {
      source,
      __proto__: { polluted: true },
    };
    expect(() => parseRemoteImportRequest(changedPrototype)).toThrow(
      RemoteImportRequestError,
    );
    expect(() =>
      parseRemoteImportRequest(Object.create(null) as unknown),
    ).toThrow(RemoteImportRequestError);
  });

  it("never reflects an unknown member name into field errors", () => {
    const secretKey =
      "https://user:secret@example.test/C:/private/source";
    try {
      parseRemoteImportRequest({
        source: {
          kind: "github",
          repositoryUrl: "https://github.com/openai/example",
          [secretKey]: true,
        },
      });
      throw new Error("Expected parsing to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(RemoteImportRequestError);
      expect(JSON.stringify(error)).not.toContain(secretKey);
      expect(
        (error as RemoteImportRequestError).fields,
      ).toEqual([
        {
          code: "unknown-field",
          path: "$.source",
          message: "Unknown field.",
        },
      ]);
    }
  });

  it.each([
    {
      source: {
        kind: "github",
        repositoryUrl: " https://github.com/openai/example",
      },
    },
    {
      source: {
        kind: "git",
        repositoryUrl: "https://user:secret@example.test/repository",
      },
    },
    {
      source: {
        kind: "git",
        repositoryUrl: "https://example.test/repository?token=secret",
      },
    },
    {
      source: {
        kind: "git",
        repositoryUrl: "https://example.test/repository#fragment",
      },
    },
    {
      source: {
        kind: "git",
        repositoryUrl: "https://example.test/repository?",
      },
    },
    {
      source: {
        kind: "git",
        repositoryUrl: "https://example.test/repository#",
      },
    },
    {
      source: {
        kind: "git",
        repositoryUrl: "https://example.test/repository",
        revision: { kind: "branch", name: "refs/heads/main" },
      },
    },
    {
      source: {
        kind: "github",
        repositoryUrl: "https://github.com/openai/example",
      },
      identity: { version: "1" },
    },
    {
      source: {
        kind: "github",
        repositoryUrl: "https://github.com/openai/example",
      },
      analysis: {
        maxEntries: DEFAULT_SNAPSHOT_LIMITS.maxEntries,
      },
    },
    {
      source: {
        kind: "github",
        repositoryUrl: "https://github.com/openai/example",
      },
      analysis: {
        timeoutMs: DEFAULT_SNAPSHOT_LIMITS.timeoutMs + 1,
      },
    },
  ])("rejects unsafe or out-of-contract request values", (value) => {
    expect(() => parseRemoteImportRequest(value)).toThrow(
      RemoteImportRequestError,
    );
  });
});

describe("Generic Git outbound policy", () => {
  it("normalizes exact configured origins and keeps scheme and port significant", () => {
    const policy = new RemoteImportPolicy(
      [
        "https://Git.Example",
        "ssh://git.example:22",
        "https://127.0.0.1:8443",
      ],
      { platform: "linux" },
    );
    expect(() =>
      policy.assertAllowed(
        parseRemoteImportRequest({
          source: {
            kind: "git",
            repositoryUrl: "https://git.example/repository.git",
          },
        }),
      ),
    ).not.toThrow();
    expect(() =>
      policy.assertAllowed(
        parseRemoteImportRequest({
          source: {
            kind: "git",
            repositoryUrl: "git@git.example:group/repository.git",
          },
        }),
      ),
    ).not.toThrow();
    for (const repositoryUrl of [
      "https://git.example:8443/repository.git",
      "ssh://git@git.example:2222/repository.git",
      "https://127.0.0.1/repository.git",
      "https://10.0.0.5/repository.git",
    ]) {
      expect(() =>
        policy.assertAllowed(
          parseRemoteImportRequest({
            source: { kind: "git", repositoryUrl },
          }),
        ),
      ).toThrow(
        expect.objectContaining({
          status: 403,
          fields: [
            expect.objectContaining({ code: "source-not-allowed" }),
          ],
        }),
      );
    }
    expect(() =>
      policy.assertAllowed(
        parseRemoteImportRequest({
          source: {
            kind: "git",
            repositoryUrl: "https://127.0.0.1:8443/repository.git",
          },
        }),
      ),
    ).not.toThrow();
  });

  it("rejects invalid config and requires an explicit Windows ACL attestation", () => {
    for (const origin of [
      "https://*.example.test",
      "https://user@example.test",
      "https://example.test/path",
      "https://example.test?query",
      "https://example.test?",
      "https://example.test#",
      "ftp://example.test",
      "ssh://example.test:0",
    ]) {
      expect(
        () =>
          new RemoteImportPolicy([origin], {
            platform: "linux",
          }),
      ).toThrow();
    }
    expect(
      () =>
        new RemoteImportPolicy(["https://example.test"], {
          platform: "win32",
        }),
    ).toThrow("explicit private workspace ACL");
    expect(
      () =>
        new RemoteImportPolicy(["https://example.test"], {
          platform: "win32",
          trustWindowsGitWorkspace: true,
        }),
    ).not.toThrow();
    expect(
      () => new RemoteImportPolicy([], { platform: "win32" }),
    ).not.toThrow();

    const githubHistory = parseRemoteImportRequest({
      source: {
        kind: "github",
        repositoryUrl: "https://github.com/openai/example",
      },
      history: {
        mode: "commit-count",
        commitCount: 1,
      },
    });
    let missingTrust: unknown;
    try {
      new RemoteImportPolicy([], {
        platform: "win32",
      }).assertAllowed(githubHistory);
    } catch (error) {
      missingTrust = error;
    }
    expect(missingTrust).toBeInstanceOf(RemoteImportRequestError);
    expect(
      (missingTrust as RemoteImportRequestError).fields[0]?.message,
    ).toContain("CODECITY_TRUST_WINDOWS_GIT_WORKSPACE");
    expect(() =>
      new RemoteImportPolicy([], {
        platform: "win32",
        trustWindowsGitWorkspace: true,
      }).assertAllowed(githubHistory),
    ).not.toThrow();
  });

  it("preserves the Windows history trust guidance for credentialed imports", async () => {
    const createStagingDirectory = vi.fn();
    const request = parseRemoteImportRequest({
      source: {
        kind: "github",
        repositoryUrl: "https://github.com/openai/private",
        credentialProfileId: "github-private",
      },
      history: {
        mode: "commit-count",
        commitCount: 1,
      },
    });

    await expect(
      enqueueRemoteImport(request, {
        jobs: undefined as never,
        artifacts: { createStagingDirectory } as never,
        policy: new RemoteImportPolicy([], {
          platform: "win32",
        }),
        credentialProfiles: undefined as never,
      }),
    ).rejects.toMatchObject({
      status: 403,
      fields: [
        {
          path: "$.history",
          message: expect.stringContaining(
            "CODECITY_TRUST_WINDOWS_GIT_WORKSPACE",
          ),
        },
      ],
    });
    expect(createStagingDirectory).not.toHaveBeenCalled();
  });

  it("parses fixed environment configuration without permissive fallbacks", () => {
    expect(environmentAllowedGitOrigins(undefined)).toBeUndefined();
    expect(environmentAllowedGitOrigins("")).toBeUndefined();
    expect(
      environmentAllowedGitOrigins(
        "https://git.example, ssh://git.example:22",
      ),
    ).toEqual([
      "https://git.example",
      "ssh://git.example:22",
    ]);
    expect(() =>
      environmentAllowedGitOrigins("https://git.example,"),
    ).toThrow("CODECITY_ALLOWED_GIT_ORIGINS");
    expect(environmentWindowsGitWorkspaceTrust(undefined)).toBe(false);
    expect(environmentWindowsGitWorkspaceTrust("1")).toBe(true);
    expect(() =>
      environmentWindowsGitWorkspaceTrust("true"),
    ).toThrow("CODECITY_TRUST_WINDOWS_GIT_WORKSPACE");
  });
});

describe("remote import HTTP API", () => {
  it("denies Generic Git by default before staging or analyzer work", async () => {
    const roots = await fixture();
    const fakes = successfulDependencies();
    const createStaging = vi.fn();
    const server = await startCodeCityServer({
      host: "127.0.0.1",
      port: 0,
      ...roots,
      importDependencies: fakes.dependencies,
    });
    servers.push(server);
    const originalCreateStaging =
      server.artifacts.createStagingDirectory.bind(server.artifacts);
    vi.spyOn(
      server.artifacts,
      "createStagingDirectory",
    ).mockImplementation(async () => {
      createStaging();
      return originalCreateStaging();
    });

    const response = await request(
      new URL("/api/v1/imports", server.url),
      {
        method: "POST",
        headers: importHeaders(),
        body: importBody({
          kind: "git",
          repositoryUrl: "https://127.0.0.1/repository.git",
        }),
      },
    );
    expect(response.status).toBe(403);
    expect(JSON.parse(response.body)).toMatchObject({
      error: {
        code: "invalid-import-request",
        fields: [
          {
            code: "source-not-allowed",
            path: "$.source.repositoryUrl",
          },
        ],
      },
    });
    expect(createStaging).not.toHaveBeenCalled();
    expect(fakes.git).not.toHaveBeenCalled();
    expect(server.jobs.list()).toEqual([]);
  });

  it("queues public GitHub analysis, publishes its artifact, and persists no source locator", async () => {
    const roots = await fixture();
    const fakes = successfulDependencies();
    const server = await startCodeCityServer({
      host: "127.0.0.1",
      port: 0,
      ...roots,
      importDependencies: fakes.dependencies,
    });
    servers.push(server);

    const repositoryUrl = "https://github.com/openai/example";
    const response = await request(
      new URL("/api/v1/imports", server.url),
      {
        method: "POST",
        headers: importHeaders(),
        body: JSON.stringify({
          source: {
            kind: "github",
            repositoryUrl,
            revision: { kind: "tag", name: "v1.0.0" },
          },
          identity: { title: "Imported city" },
          analysis: { maxRetainedFiles: 100, timeoutMs: 10_000 },
        }),
      },
    );
    expect(response.status).toBe(202);
    const queued = (JSON.parse(response.body) as { job: JobRecord }).job;
    expect(response.headers.location).toBe(
      `/api/v1/jobs/${queued.id}`,
    );
    expect(queued).toMatchObject({
      id: expect.any(String),
      kind: "project-import",
      state: "queued",
    });
    expect(JSON.stringify(queued)).not.toContain(repositoryUrl);

    const terminal = await waitForTerminal(server, queued.id);
    expect(terminal).toMatchObject({
      state: "completed",
      progress: { phase: "ready", current: 3, total: 3 },
      result: {
        kind: "city-model",
        artifactToken: queued.id,
        artifactUrl: `/api/v1/artifacts/${queued.id}/city-model.json`,
      },
    });
    expect(fakes.github).toHaveBeenCalledTimes(1);
    expect(fakes.github.mock.calls[0]).toHaveLength(2);
    const [analyzerRequest, analyzerOptions] =
      fakes.github.mock.calls[0]!;
    expect(analyzerRequest).toEqual({
      repositoryUrl,
      ref: "tags/v1.0.0",
    });
    expect(analyzerOptions).toMatchObject({
      title: "Imported city",
      maxRetainedFiles: 100,
      timeoutMs: 10_000,
      signal: expect.any(AbortSignal),
    });

    const artifact = await request(
      new URL(terminal.result!.artifactUrl, server.url),
    );
    expect(artifact.status).toBe(200);
    expect(JSON.parse(artifact.body)).toEqual(cityModelFixture());
    const persisted = await fs.readFile(
      path.join(roots.dataDirectory, "jobs", `${queued.id}.json`),
      "utf8",
    );
    expect(persisted).not.toContain(repositoryUrl);
    expect(persisted).not.toContain("v1.0.0");
    expect(
      await fs.readdir(
        path.join(roots.dataDirectory, "tmp", "imports"),
      ),
    ).toEqual([]);
  });

  it("runs bounded GitHub history analysis and publishes both artifacts", async () => {
    const roots = await fixture();
    const model = historyCityModelFixture();
    const historyResult = historyAnalysisResultFixture(model);
    const historyImplementation: NonNullable<
      RemoteImportDependencies["analyzeGenericGitHistory"]
    > = async (): Promise<GenericGitHistoryAnalysisResult> =>
      historyResult;
    const history = vi.fn(historyImplementation);
    const server = await startCodeCityServer({
      host: "127.0.0.1",
      port: 0,
      ...roots,
      trustWindowsGitWorkspace: true,
      importDependencies: {
        analyzeGenericGitHistory: history,
      },
    });
    servers.push(server);
    const publishHistory = vi.spyOn(
      server.artifacts,
      "publishHistoryArtifacts",
    );

    const repositoryUrl = "https://github.com/openai/example";
    const response = await request(
      new URL("/api/v1/imports", server.url),
      {
        method: "POST",
        headers: importHeaders(),
        body: JSON.stringify({
          source: {
            kind: "github",
            repositoryUrl,
            revision: { kind: "branch", name: "main" },
          },
          history: {
            mode: "root-to-tip",
            maxFrames: 20,
          },
          identity: { title: "Evolution city" },
          analysis: {
            maxRetainedFiles: 1_000,
            timeoutMs: 60_000,
          },
        }),
      },
    );
    expect(response.status).toBe(202);
    const queued = (JSON.parse(response.body) as { job: JobRecord }).job;
    const terminal = await waitForTerminal(server, queued.id);
    expect(terminal).toMatchObject({
      state: "completed",
      progress: { phase: "ready", current: 3, total: 3 },
      result: {
        kind: "city-model",
        artifactToken: queued.id,
        artifactUrl: `/api/v1/artifacts/${queued.id}/city-model.json`,
        evolution: {
          artifactUrl:
            `/api/v1/artifacts/${queued.id}/evolution.json`,
          size: expect.any(Number),
          sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
        },
      },
    });

    expect(history).toHaveBeenCalledTimes(1);
    expect(
      publishHistory.mock.calls[0]?.[3]?.preparedSerialization,
    ).toBe(historyResult.evolution.preparedSerialization);
    expect(history.mock.calls[0]).toHaveLength(3);
    const [historyRequest, historyOptions, historyDependencies] =
      history.mock.calls[0]!;
    expect(historyRequest).toMatchObject({
      repositoryUrl,
      repositoryIdentity: repositoryUrl,
      ref: "refs/heads/main",
      selection: {
        mode: "root-to-tip",
        maxFrames: 20,
        totalDeadlineMs: 60_000,
      },
      signal: expect.any(AbortSignal),
    });
    expect(historyOptions).toEqual({
      identity: { title: "Evolution city" },
      analysisOptions: { maxRetainedFiles: 1_000 },
    });
    expect(historyDependencies).toMatchObject({
      semanticCache: expect.objectContaining({
        acquire: expect.any(Function),
      }),
      git: {
        isolateCredentials: true,
        temporaryWorkspaceOptions: {
          trustedPrivateParent: {
            directory: expect.any(String),
            windowsAclProtection:
              GENERIC_GIT_PRESECURED_WINDOWS_ACL,
            canonicalAncestryProtection:
              GENERIC_GIT_PRESECURED_CANONICAL_ANCESTRY,
          },
        },
      },
    });

    const cityArtifact = await request(
      new URL(terminal.result!.artifactUrl, server.url),
    );
    expect(cityArtifact.status).toBe(200);
    expect(JSON.parse(cityArtifact.body)).toMatchObject({
      ...model,
      sourceProvenance: {
        version: "codecity.source-navigation/1",
        repositories: [
          {
            repositoryId: "repository:one",
            provider: "github",
            revision: { kind: "commit", value: COMMIT },
            repositoryUrl: "https://github.com/openai/example",
          },
        ],
      },
    });

    const evolutionUrl = terminal.result!.evolution!.artifactUrl;
    const evolutionArtifact = await request(
      new URL(evolutionUrl, server.url),
    );
    expect(evolutionArtifact.status).toBe(200);
    expect(evolutionArtifact.headers["cache-control"]).toBe(
      "no-store",
    );
    expect(JSON.parse(evolutionArtifact.body)).toEqual(
      JSON.parse(
        new TextDecoder().decode(
          serializeEvolutionBundle(historyResult.evolution.bundle),
        ),
      ),
    );

    const persisted = await fs.readFile(
      path.join(roots.dataDirectory, "jobs", `${queued.id}.json`),
      "utf8",
    );
    expect(persisted).not.toContain(repositoryUrl);
    expect(persisted).not.toContain("refs/heads/main");
    expect(persisted).not.toContain("Evolution city");
  });

  it("maps history capacity failures to safe actionable job errors", async () => {
    const roots = await fixture();
    const history = vi.fn(
      async (requestValue: { readonly repositoryUrl: string }) => {
        if (requestValue.repositoryUrl.endsWith("/too-long")) {
          throw new HistorySelectionError(
            "history-too-long",
            "secret C:\\private\\repository has 501 commits",
          );
        }
        if (requestValue.repositoryUrl.endsWith("/shallow")) {
          throw new HistorySelectionError(
            "history-incomplete",
            "secret shallow boundary diagnostics",
          );
        }
        if (requestValue.repositoryUrl.endsWith("/no-filter")) {
          throw new GenericGitSnapshotError(
            "GIT_PARTIAL_CLONE_UNAVAILABLE",
            "secret remote diagnostics",
          );
        }
        throw new HistoryEvolutionError(
          "limit-exceeded",
          "secret retained semantic internals",
        );
      },
    );
    const server = await startCodeCityServer({
      host: "127.0.0.1",
      port: 0,
      ...roots,
      trustWindowsGitWorkspace: true,
      importDependencies: {
        analyzeGenericGitHistory:
          history as NonNullable<
            RemoteImportDependencies["analyzeGenericGitHistory"]
          >,
      },
    });
    servers.push(server);

    for (const expected of [
      {
        repository: "too-long",
        code: "history-too-long",
        message:
          "This mainline has more than 100,000 commits. Choose a bounded custom history range.",
      },
      {
        repository: "shallow",
        code: "history-incomplete",
        message:
          "The selected history cannot be proven complete because the Git server supplied a shallow boundary. Choose an available bounded range or use a complete remote.",
      },
      {
        repository: "no-filter",
        code: "history-capability-unavailable",
        message:
          "Complete mainline history requires a Git server with filtered history fetch support. Choose a bounded custom history range.",
      },
      {
        repository: "too-detailed",
        code: "history-limit-exceeded",
        message:
          "This repository is too detailed for the selected history. Reduce the maximum animation frames or choose a custom range.",
      },
    ] as const) {
      const response = await request(
        new URL("/api/v1/imports", server.url),
        {
          method: "POST",
          headers: importHeaders(),
          body: JSON.stringify({
            source: {
              kind: "github",
              repositoryUrl:
                `https://github.com/openai/${expected.repository}`,
            },
            history: { mode: "root-to-tip", maxFrames: 20 },
          }),
        },
      );
      const queued = (JSON.parse(response.body) as { job: JobRecord })
        .job;
      const terminal = await waitForTerminal(server, queued.id);
      expect(terminal.error).toEqual({
        code: expected.code,
        message: expected.message,
      });
      expect(JSON.stringify(terminal)).not.toContain("secret");
      expect(JSON.stringify(terminal)).not.toContain("private");
    }
  });

  it("applies the history deadline to artifact publication", async () => {
    const roots = await fixture();
    const history = vi.fn(
      async (): Promise<GenericGitHistoryAnalysisResult> =>
        historyAnalysisResultFixture(),
    );
    const server = await startCodeCityServer({
      host: "127.0.0.1",
      port: 0,
      ...roots,
      trustWindowsGitWorkspace: true,
      importDependencies: {
        analyzeGenericGitHistory: history,
      },
    });
    servers.push(server);

    const publish = vi.spyOn(
      server.artifacts,
      "publishHistoryArtifacts",
    );
    publish.mockImplementation(
      async (_token, _model, _evolution, options = {}) => {
        const signal = options.signal;
        if (signal === undefined) {
          throw new Error("Expected a publication deadline signal.");
        }
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve();
            return;
          }
          signal.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
        signal.throwIfAborted();
        throw new Error("Expected the deadline signal to abort.");
      },
    );

    const response = await request(
      new URL("/api/v1/imports", server.url),
      {
        method: "POST",
        headers: importHeaders(),
        body: JSON.stringify({
          source: {
            kind: "github",
            repositoryUrl: "https://github.com/openai/example",
          },
          history: {
            mode: "commit-count",
            commitCount: 1,
            totalDeadlineMs:
              HISTORY_SELECTION_LIMITS.minTotalDeadlineMs,
          },
        }),
      },
    );
    expect(response.status).toBe(202);
    const queued = (JSON.parse(response.body) as { job: JobRecord }).job;
    const terminal = await waitForTerminal(server, queued.id);
    expect(terminal).toMatchObject({
      state: "failed",
      error: {
        code: "deadline-exceeded",
        message: "The repository import exceeded its time limit.",
      },
    });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(
      await fs.readdir(path.join(roots.dataDirectory, "artifacts")),
    ).toEqual([]);
    expect(
      await fs.readdir(
        path.join(roots.dataDirectory, "tmp", "imports"),
      ),
    ).toEqual([]);
  });

  it("checks the history deadline during temporary-data cleanup", async () => {
    const roots = await fixture();
    const history = vi.fn(
      async (): Promise<GenericGitHistoryAnalysisResult> =>
        historyAnalysisResultFixture(),
    );
    const server = await startCodeCityServer({
      host: "127.0.0.1",
      port: 0,
      ...roots,
      trustWindowsGitWorkspace: true,
      importDependencies: {
        analyzeGenericGitHistory: history,
      },
    });
    servers.push(server);

    const cleanupOriginal =
      server.artifacts.cleanupStagingDirectory.bind(
        server.artifacts,
      );
    let guardedCleanupCalls = 0;
    const cleanup = vi.spyOn(
      server.artifacts,
      "cleanupStagingDirectory",
    );
    cleanup.mockImplementation(async (token, options = {}) => {
      if (
        options.signal !== undefined &&
        options.checkpoint !== undefined
      ) {
        guardedCleanupCalls += 1;
        await new Promise<void>((resolve) => {
          if (options.signal!.aborted) {
            resolve();
            return;
          }
          options.signal!.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
        options.checkpoint();
      }
      await cleanupOriginal(token, options);
    });

    const response = await request(
      new URL("/api/v1/imports", server.url),
      {
        method: "POST",
        headers: importHeaders(),
        body: JSON.stringify({
          source: {
            kind: "github",
            repositoryUrl: "https://github.com/openai/example",
          },
          history: {
            mode: "commit-count",
            commitCount: 1,
            totalDeadlineMs:
              HISTORY_SELECTION_LIMITS.minTotalDeadlineMs,
          },
        }),
      },
    );
    expect(response.status).toBe(202);
    const queued = (JSON.parse(response.body) as { job: JobRecord }).job;
    const terminal = await waitForTerminal(server, queued.id);
    expect(terminal).toMatchObject({
      state: "failed",
      error: {
        code: "deadline-exceeded",
        message: "The repository import exceeded its time limit.",
      },
    });
    expect(guardedCleanupCalls).toBe(1);
    expect(
      await fs.readdir(path.join(roots.dataDirectory, "artifacts")),
    ).toEqual([]);
    expect(
      await fs.readdir(
        path.join(roots.dataDirectory, "tmp", "imports"),
      ),
    ).toEqual([]);
  });

  it("uses an exact GitHub credential binding without persisting its selector or secret", async () => {
    const roots = await fixture();
    const profileId = "github-private";
    const repositoryUrl = "https://github.com/openai/private";
    const serverOptions = await credentialServerOptions(roots, [
      {
        id: profileId,
        label: "Private GitHub repository",
        provider: "github",
        repositories: [repositoryUrl],
        authentication: {
          kind: "bearer",
          secretFile: "repository.secret",
        },
      },
    ]);
    let retainedSecret: Uint8Array | undefined;
    let credentialUseCount = 0;
    let sawExpectedSecret = false;
    const githubImplementation: NonNullable<
      RemoteImportDependencies["analyzePublicGitHubRepository"]
    > = async (
      analyzerRequest,
      analyzerOptions,
      analyzerDependencies,
    ): Promise<PublicGitHubAnalysisResult> => {
      expect(analyzerRequest).toEqual({ repositoryUrl });
      expect(analyzerDependencies?.credentialProvider?.provider).toBe(
        "github",
      );
      const provider = analyzerDependencies?.credentialProvider;
      const signal = analyzerOptions?.signal;
      if (provider === undefined || signal === undefined) {
        throw new Error("The credential provider was not supplied.");
      }
      await provider.use(signal, async (credential) => {
        credentialUseCount += 1;
        retainedSecret = credential.secret;
        expect(credential.kind).toBe("bearer");
        sawExpectedSecret =
          Buffer.from(credential.secret).toString("utf8") ===
            PROFILE_SECRET;
      });
      return {
        owner: "openai",
        repository: "private",
        canonicalRepositoryUrl: repositoryUrl,
        commitSha: COMMIT,
        model: cityModelFixture(),
      };
    };
    const github = vi.fn(githubImplementation);
    const server = await startCodeCityServer({
      host: "127.0.0.1",
      port: 0,
      ...roots,
      ...serverOptions,
      importDependencies: {
        analyzePublicGitHubRepository: github,
      },
    });
    servers.push(server);

    const response = await request(
      new URL("/api/v1/imports", server.url),
      {
        method: "POST",
        headers: authorizedImportHeaders(),
        body: importBody({
          kind: "github",
          repositoryUrl,
          credentialProfileId: profileId,
        }),
      },
    );
    expect(response.status).toBe(202);
    const queued = (JSON.parse(response.body) as { job: JobRecord }).job;
    const terminal = await waitForTerminal(server, queued.id);
    expect(terminal.state).toBe("completed");
    expect(github).toHaveBeenCalledTimes(1);
    expect(credentialUseCount).toBe(1);
    expect(sawExpectedSecret).toBe(true);
    expect(retainedSecret).toBeDefined();
    expect(retainedSecret?.every((byte) => byte === 0)).toBe(true);

    const artifact = await request(
      new URL(terminal.result!.artifactUrl, server.url),
      { headers: authorizedImportHeaders() },
    );
    expect(artifact.status).toBe(200);
    const persisted = await fs.readFile(
      path.join(roots.dataDirectory, "jobs", `${queued.id}.json`),
      "utf8",
    );
    for (const representation of [
      response.body,
      JSON.stringify(terminal),
      JSON.stringify(github.mock.calls[0]),
      persisted,
      artifact.body,
    ]) {
      expect(representation).not.toContain(profileId);
      expect(representation).not.toContain(PROFILE_SECRET);
    }
    expect(
      await fs.readdir(
        path.join(roots.dataDirectory, "tmp", "imports"),
      ),
    ).toEqual([]);
  });

  it.each(
    [
      {
        name: "Generic HTTPS",
        profileId: "generic-private",
        provider: "generic-https",
        repositoryUrl:
          "https://git.example.test/group/repository.git",
        allowedOrigin: "https://git.example.test",
        username: "generic-build-user",
      },
      {
        name: "Azure DevOps cloud",
        profileId: "azure-cloud-private",
        provider: "azure-devops",
        repositoryUrl:
          "https://dev.azure.com/Org/Project/_git/Repository",
        allowedOrigin: "https://dev.azure.com",
        username: "azure-cloud-user",
      },
      {
        name: "Azure DevOps Server",
        profileId: "azure-server-private",
        provider: "azure-devops",
        repositoryUrl:
          "https://azure.example.test/prefix/Project/_git/OnPremRepository.git",
        allowedOrigin: "https://azure.example.test",
        username: "azure-server-user",
      },
    ] as const,
  )(
    "uses an exact $name Basic binding only through the analyzer callback",
    async ({
      profileId,
      provider,
      repositoryUrl,
      allowedOrigin,
      username,
    }) => {
      const roots = await fixture();
      const serverOptions = await credentialServerOptions(roots, [
        {
          id: profileId,
          label: `${provider} private repository`,
          provider,
          repositories: [repositoryUrl],
          authentication: {
            kind: "basic",
            username,
            secretFile: "repository.secret",
          },
        },
      ]);
      let retainedSecret: Uint8Array | undefined;
      let credentialUseCount = 0;
      let sawExpectedMaterial = false;
      const gitImplementation: NonNullable<
        RemoteImportDependencies["analyzeGenericGitRepository"]
      > = async (
        analyzerRequest,
        analyzerOptions,
        analyzerDependencies,
      ): Promise<GenericGitAnalysisResult> => {
        expect(analyzerRequest).toEqual({ repositoryUrl });
        const credentialProvider =
          analyzerDependencies?.credentialProvider;
        const signal = analyzerOptions?.signal;
        if (credentialProvider === undefined || signal === undefined) {
          throw new Error("The credential provider was not supplied.");
        }
        expect(credentialProvider).toMatchObject({
          provider: "basic",
          use: expect.any(Function),
        });
        expect(Object.keys(credentialProvider).sort()).toEqual([
          "provider",
          "use",
        ]);
        expect(Object.isFrozen(credentialProvider)).toBe(true);
        const stagingDirectory =
          analyzerDependencies?.temporaryWorkspaceOptions
            ?.trustedPrivateParent?.directory;
        expect(stagingDirectory).toBeDefined();
        expect(await fs.readdir(stagingDirectory!)).toEqual([]);
        await credentialProvider.use(
          signal,
          async (credential) => {
            credentialUseCount += 1;
            retainedSecret = credential.secret;
            expect(credential.kind).toBe("basic");
            sawExpectedMaterial =
              credential.username === username &&
              Buffer.from(credential.secret).toString("utf8") ===
                PROFILE_SECRET;
            expect(await fs.readdir(stagingDirectory!)).toEqual([]);
          },
        );
        return {
          repository: "private",
          commitSha: COMMIT,
          transport: "https",
          model: cityModelFixture(),
        };
      };
      const git = vi.fn(gitImplementation);
      const server = await startCodeCityServer({
        host: "127.0.0.1",
        port: 0,
        ...roots,
        ...serverOptions,
        allowedGitOrigins: [allowedOrigin],
        trustWindowsGitWorkspace: true,
        importDependencies: {
          analyzeGenericGitRepository: git,
        },
      });
      servers.push(server);

      const response = await request(
        new URL("/api/v1/imports", server.url),
        {
          method: "POST",
          headers: authorizedImportHeaders(),
          body: importBody({
            kind: "git",
            repositoryUrl,
            credentialProfileId: profileId,
          }),
        },
      );
      expect(response.status).toBe(202);
      const queued = (
        JSON.parse(response.body) as { job: JobRecord }
      ).job;
      const terminal = await waitForTerminal(server, queued.id);
      expect(terminal.state).toBe("completed");
      expect(git).toHaveBeenCalledTimes(1);
      expect(credentialUseCount).toBe(1);
      expect(sawExpectedMaterial).toBe(true);
      expect(retainedSecret).toBeDefined();
      expect(retainedSecret?.every((byte) => byte === 0)).toBe(true);

      const artifact = await request(
        new URL(terminal.result!.artifactUrl, server.url),
        { headers: authorizedImportHeaders() },
      );
      expect(artifact.status).toBe(200);
      const persisted = await fs.readFile(
        path.join(
          roots.dataDirectory,
          "jobs",
          `${queued.id}.json`,
        ),
        "utf8",
      );
      for (const representation of [
        response.body,
        JSON.stringify(terminal),
        JSON.stringify(git.mock.calls[0]),
        persisted,
        artifact.body,
      ]) {
        expect(representation).not.toContain(profileId);
        expect(representation).not.toContain(username);
        expect(representation).not.toContain(PROFILE_SECRET);
      }
      expect(
        await fs.readdir(
          path.join(roots.dataDirectory, "tmp", "imports"),
        ),
      ).toEqual([]);
    },
  );

  it("zeros selected Generic Git credential bytes when the analyzer callback fails", async () => {
    const roots = await fixture();
    const profileId = "generic-failing";
    const repositoryUrl =
      "https://git.example.test/group/failing.git";
    const username = "failing-build-user";
    const serverOptions = await credentialServerOptions(roots, [
      {
        id: profileId,
        label: "Failing private repository",
        provider: "generic-https",
        repositories: [repositoryUrl],
        authentication: {
          kind: "basic",
          username,
          secretFile: "repository.secret",
        },
      },
    ]);
    let retainedSecret: Uint8Array | undefined;
    let sawExpectedMaterial = false;
    const gitImplementation: NonNullable<
      RemoteImportDependencies["analyzeGenericGitRepository"]
    > = async (
      _analyzerRequest,
      analyzerOptions,
      analyzerDependencies,
    ): Promise<GenericGitAnalysisResult> => {
      const credentialProvider =
        analyzerDependencies?.credentialProvider;
      const signal = analyzerOptions?.signal;
      if (credentialProvider === undefined || signal === undefined) {
        throw new Error("The credential provider was not supplied.");
      }
      await credentialProvider.use(signal, async (credential) => {
        retainedSecret = credential.secret;
        sawExpectedMaterial =
          credential.kind === "basic" &&
          credential.username === username &&
          Buffer.from(credential.secret).toString("utf8") ===
            PROFILE_SECRET;
        throw new Error("The analyzer callback failed.");
      });
      throw new Error("The credential callback unexpectedly returned.");
    };
    const git = vi.fn(gitImplementation);
    const server = await startCodeCityServer({
      host: "127.0.0.1",
      port: 0,
      ...roots,
      ...serverOptions,
      allowedGitOrigins: ["https://git.example.test"],
      trustWindowsGitWorkspace: true,
      importDependencies: {
        analyzeGenericGitRepository: git,
      },
    });
    servers.push(server);

    const response = await request(
      new URL("/api/v1/imports", server.url),
      {
        method: "POST",
        headers: authorizedImportHeaders(),
        body: importBody({
          kind: "git",
          repositoryUrl,
          credentialProfileId: profileId,
        }),
      },
    );
    expect(response.status).toBe(202);
    const queued = (
      JSON.parse(response.body) as { job: JobRecord }
    ).job;
    const terminal = await waitForTerminal(server, queued.id);
    expect(terminal.state).toBe("failed");
    expect(git).toHaveBeenCalledTimes(1);
    expect(retainedSecret).toBeDefined();
    expect(sawExpectedMaterial).toBe(true);
    expect(retainedSecret?.every((byte) => byte === 0)).toBe(true);

    const persisted = await fs.readFile(
      path.join(roots.dataDirectory, "jobs", `${queued.id}.json`),
      "utf8",
    );
    for (const representation of [
      response.body,
      JSON.stringify(terminal),
      JSON.stringify(git.mock.calls[0]),
      persisted,
    ]) {
      expect(representation).not.toContain(profileId);
      expect(representation).not.toContain(username);
      expect(representation).not.toContain(PROFILE_SECRET);
    }
    expect(
      await fs.readdir(
        path.join(roots.dataDirectory, "tmp", "imports"),
      ),
    ).toEqual([]);
    expect(
      await fs.readdir(path.join(roots.dataDirectory, "artifacts")),
    ).toEqual([]);
  });

  it("zeros selected Generic Git credential bytes when active analysis is cancelled", async () => {
    const roots = await fixture();
    const profileId = "generic-cancelled";
    const repositoryUrl =
      "https://git.example.test/group/cancelled.git";
    const username = "cancelled-build-user";
    const serverOptions = await credentialServerOptions(roots, [
      {
        id: profileId,
        label: "Cancelled private repository",
        provider: "generic-https",
        repositories: [repositoryUrl],
        authentication: {
          kind: "basic",
          username,
          secretFile: "repository.secret",
        },
      },
    ]);
    let signalCallbackStarted: (() => void) | undefined;
    const callbackStarted = new Promise<void>((resolve) => {
      signalCallbackStarted = resolve;
    });
    let retainedSecret: Uint8Array | undefined;
    let sawExpectedMaterial = false;
    const gitImplementation: NonNullable<
      RemoteImportDependencies["analyzeGenericGitRepository"]
    > = async (
      _analyzerRequest,
      analyzerOptions,
      analyzerDependencies,
    ): Promise<GenericGitAnalysisResult> => {
      const credentialProvider =
        analyzerDependencies?.credentialProvider;
      const signal = analyzerOptions?.signal;
      if (credentialProvider === undefined || signal === undefined) {
        throw new Error("The credential provider was not supplied.");
      }
      await credentialProvider.use(signal, async (credential) => {
        retainedSecret = credential.secret;
        sawExpectedMaterial =
          credential.kind === "basic" &&
          credential.username === username &&
          Buffer.from(credential.secret).toString("utf8") ===
            PROFILE_SECRET;
        signalCallbackStarted?.();
        await new Promise<never>(() => undefined);
      });
      throw new Error("The credential callback unexpectedly returned.");
    };
    const git = vi.fn(gitImplementation);
    const server = await startCodeCityServer({
      host: "127.0.0.1",
      port: 0,
      ...roots,
      ...serverOptions,
      allowedGitOrigins: ["https://git.example.test"],
      trustWindowsGitWorkspace: true,
      importDependencies: {
        analyzeGenericGitRepository: git,
      },
    });
    servers.push(server);

    const response = await request(
      new URL("/api/v1/imports", server.url),
      {
        method: "POST",
        headers: authorizedImportHeaders(),
        body: importBody({
          kind: "git",
          repositoryUrl,
          credentialProfileId: profileId,
        }),
      },
    );
    expect(response.status).toBe(202);
    const queued = (
      JSON.parse(response.body) as { job: JobRecord }
    ).job;
    await callbackStarted;
    const cancelled = await request(
      new URL(`/api/v1/jobs/${queued.id}`, server.url),
      {
        method: "DELETE",
        headers: authorizedImportHeaders(),
      },
    );
    expect(cancelled.status).toBe(200);
    const terminal = await waitForTerminal(server, queued.id);
    expect(terminal.state).toBe("cancelled");
    expect(git).toHaveBeenCalledTimes(1);
    expect(retainedSecret).toBeDefined();
    expect(sawExpectedMaterial).toBe(true);
    expect(retainedSecret?.every((byte) => byte === 0)).toBe(true);

    const persisted = await fs.readFile(
      path.join(roots.dataDirectory, "jobs", `${queued.id}.json`),
      "utf8",
    );
    for (const representation of [
      response.body,
      cancelled.body,
      JSON.stringify(terminal),
      JSON.stringify(git.mock.calls[0]),
      persisted,
    ]) {
      expect(representation).not.toContain(profileId);
      expect(representation).not.toContain(username);
      expect(representation).not.toContain(PROFILE_SECRET);
    }
    expect(
      await fs.readdir(
        path.join(roots.dataDirectory, "tmp", "imports"),
      ),
    ).toEqual([]);
    expect(
      await fs.readdir(path.join(roots.dataDirectory, "artifacts")),
    ).toEqual([]);
  });

  it("rejects unavailable credential selections uniformly before staging or analyzer work", async () => {
    const roots = await fixture();
    const githubRepository = "https://github.com/openai/private";
    const genericRepository =
      "https://git.example.test/group/repository.git";
    const serverOptions = await credentialServerOptions(roots, [
      {
        id: "github-private",
        label: "Private GitHub repository",
        provider: "github",
        repositories: [githubRepository],
        authentication: {
          kind: "bearer",
          secretFile: "repository.secret",
        },
      },
      {
        id: "generic-private",
        label: "Private generic repository",
        provider: "generic-https",
        repositories: [genericRepository],
        authentication: {
          kind: "basic",
          username: "build-user",
          secretFile: "repository.secret",
        },
      },
    ]);
    const fakes = successfulDependencies();
    const server = await startCodeCityServer({
      host: "127.0.0.1",
      port: 0,
      ...roots,
      ...serverOptions,
      allowedGitOrigins: [
        "https://git.example.test",
        "ssh://git.example.test",
      ],
      trustWindowsGitWorkspace: true,
      importDependencies: fakes.dependencies,
    });
    servers.push(server);
    const createStaging = vi.fn();
    const originalCreateStaging =
      server.artifacts.createStagingDirectory.bind(server.artifacts);
    vi.spyOn(
      server.artifacts,
      "createStagingDirectory",
    ).mockImplementation(async () => {
      createStaging();
      return originalCreateStaging();
    });
    const expectedResponse = {
      error: {
        code: "invalid-import-request",
        message: "The import request is invalid.",
        fields: [
          {
            code: "source-not-allowed",
            path: "$.source.credentialProfileId",
            message:
              "This credential profile is not available for the requested source.",
          },
        ],
      },
    };
    const unavailableSources = [
      {
        kind: "github",
        repositoryUrl: githubRepository,
        credentialProfileId: "missing-profile",
      },
      {
        kind: "github",
        repositoryUrl: "https://github.com/openai/other",
        credentialProfileId: "github-private",
      },
      {
        kind: "github",
        repositoryUrl: githubRepository,
        credentialProfileId: "generic-private",
      },
      {
        kind: "git",
        repositoryUrl: genericRepository,
        credentialProfileId: "github-private",
      },
      {
        kind: "git",
        repositoryUrl:
          "https://git.example.test/group/other.git",
        credentialProfileId: "generic-private",
      },
      {
        kind: "git",
        repositoryUrl: "https://denied.example.test/repository.git",
        credentialProfileId: "github-private",
      },
      {
        kind: "git",
        repositoryUrl: "git@git.example.test:group/repository.git",
        credentialProfileId: "generic-private",
      },
    ] as const;

    for (const source of unavailableSources) {
      const response = await request(
        new URL("/api/v1/imports", server.url),
        {
          method: "POST",
          headers: authorizedImportHeaders(),
          body: importBody(source),
        },
      );
      expect(response.status).toBe(403);
      expect(JSON.parse(response.body)).toEqual(expectedResponse);
    }
    expect(createStaging).not.toHaveBeenCalled();
    expect(fakes.github).not.toHaveBeenCalled();
    expect(fakes.git).not.toHaveBeenCalled();
    expect(server.jobs.list()).toEqual([]);
  });

  it("uses a per-import trusted workspace parent for Generic Git", async () => {
    const roots = await fixture();
    const fakes = successfulDependencies();
    const server = await startCodeCityServer({
      host: "127.0.0.1",
      port: 0,
      ...roots,
      allowedGitOrigins: ["https://example.test"],
      trustWindowsGitWorkspace: true,
      importDependencies: fakes.dependencies,
    });
    servers.push(server);

    const response = await request(
      new URL("/api/v1/imports", server.url),
      {
        method: "POST",
        headers: importHeaders(),
        body: importBody({
          kind: "git",
          repositoryUrl: "https://example.test/example.git",
          revision: { kind: "branch", name: "main" },
        }),
      },
    );
    const queued = (JSON.parse(response.body) as { job: JobRecord }).job;
    expect((await waitForTerminal(server, queued.id)).state).toBe(
      "completed",
    );
    expect(fakes.git).toHaveBeenCalledTimes(1);
    const [analyzerRequest, , dependencies] = fakes.git.mock.calls[0]!;
    expect(analyzerRequest).toEqual({
      repositoryUrl: "https://example.test/example.git",
      ref: "refs/heads/main",
    });
    expect(dependencies.credentialProvider).toBeUndefined();
    expect(
      dependencies.temporaryWorkspaceOptions.trustedPrivateParent,
    ).toEqual({
      directory: expect.stringContaining(
        path.join("tmp", "imports"),
      ),
      windowsAclProtection: GENERIC_GIT_PRESECURED_WINDOWS_ACL,
      canonicalAncestryProtection:
        GENERIC_GIT_PRESECURED_CANONICAL_ANCESTRY,
    });
  });

  it("treats allowed SSH and scp-style remotes as the same exact origin", async () => {
    const roots = await fixture();
    const fakes = successfulDependencies();
    const server = await startCodeCityServer({
      host: "127.0.0.1",
      port: 0,
      ...roots,
      allowedGitOrigins: ["ssh://git.example:22"],
      trustWindowsGitWorkspace: true,
      importDependencies: fakes.dependencies,
    });
    servers.push(server);

    for (const repositoryUrl of [
      "ssh://git@git.example/group/example.git",
      "git@git.example:group/example.git",
    ]) {
      const response = await request(
        new URL("/api/v1/imports", server.url),
        {
          method: "POST",
          headers: importHeaders(),
          body: importBody({
            kind: "git",
            repositoryUrl,
          }),
        },
      );
      expect(response.status).toBe(202);
      const queued = (JSON.parse(response.body) as { job: JobRecord })
        .job;
      expect((await waitForTerminal(server, queued.id)).state).toBe(
        "completed",
      );
    }
    expect(fakes.git).toHaveBeenCalledTimes(2);
  });

  it("enforces method, CSRF, media type, framing, malformed JSON, and body limits", async () => {
    const roots = await fixture();
    const fakes = successfulDependencies();
    const server = await startCodeCityServer({
      host: "127.0.0.1",
      port: 0,
      ...roots,
      importDependencies: fakes.dependencies,
    });
    servers.push(server);
    const url = new URL("/api/v1/imports", server.url);

    const method = await request(url);
    expect(method.status).toBe(405);
    expect(method.headers.allow).toBe("POST");
    expect(
      (
        await request(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: importBody(),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(url, {
          method: "POST",
          headers: {
            "Content-Type": "text/plain",
            "X-Code-City-Request": "1",
          },
          body: importBody(),
        })
      ).status,
    ).toBe(415);
    expect(
      (
        await request(url, {
          method: "POST",
          headers: {
            ...importHeaders(),
            "Content-Encoding": "gzip",
          },
          body: importBody(),
        })
      ).status,
    ).toBe(415);
    expect(
      (
        await request(url, {
          method: "POST",
          headers: {
            "Content-Type": ["application/json", "application/json"],
            "X-Code-City-Request": "1",
          },
          body: importBody(),
        })
      ).status,
    ).toBe(415);
    expect(
      (
        await request(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Code-City-Request": ["1", "1"],
          },
          body: importBody(),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(url, {
          method: "POST",
          headers: importHeaders(),
          body: "{",
        })
      ).status,
    ).toBe(400);
    const invalidUtf8 = await request(url, {
      method: "POST",
      headers: importHeaders(),
      body: Buffer.from([0xff]),
    });
    expect(invalidUtf8.status).toBe(400);
    expect(JSON.parse(invalidUtf8.body)).toMatchObject({
      error: {
        fields: [{ code: "invalid-json", path: "$" }],
      },
    });
    expect(
      (
        await request(url, {
          method: "POST",
          headers: importHeaders(),
          body: Buffer.alloc(
            REMOTE_IMPORT_REQUEST_MAX_BYTES + 1,
            0x20,
          ),
          chunked: true,
        })
      ).status,
    ).toBe(413);
    expect(fakes.github).not.toHaveBeenCalled();
    expect(fakes.git).not.toHaveBeenCalled();
  });

  it("closes a rejected keep-alive request without waiting for its incomplete body", async () => {
    const roots = await fixture();
    const fakes = successfulDependencies();
    const server = await startCodeCityServer({
      host: "127.0.0.1",
      port: 0,
      ...roots,
      importDependencies: fakes.dependencies,
    });
    servers.push(server);

    const raw = await rawHttpExchange(
      server.port,
      [
        "POST /api/v1/imports HTTP/1.1",
        `Host: 127.0.0.1:${server.port}`,
        "Content-Type: application/json",
        "Transfer-Encoding: chunked",
        "Connection: keep-alive",
        "",
        "1",
        "{",
        "",
      ].join("\r\n"),
    );
    expect(raw).toMatch(/^HTTP\/1\.1 403 /u);
    expect(raw.toLowerCase()).toContain("connection: close");
    expect(fakes.github).not.toHaveBeenCalled();
  });

  it("rejects a declared oversized incomplete body immediately and closes the connection", async () => {
    const roots = await fixture();
    const server = await startCodeCityServer({
      host: "127.0.0.1",
      port: 0,
      ...roots,
    });
    servers.push(server);
    const raw = await rawHttpExchange(
      server.port,
      [
        "POST /api/v1/imports HTTP/1.1",
        `Host: 127.0.0.1:${server.port}`,
        "Content-Type: application/json",
        "X-Code-City-Request: 1",
        `Content-Length: ${REMOTE_IMPORT_REQUEST_MAX_BYTES + 1}`,
        "Connection: keep-alive",
        "",
        "{",
      ].join("\r\n"),
    );
    expect(raw).toMatch(/^HTTP\/1\.1 413 /u);
    expect(raw.toLowerCase()).toContain("connection: close");
    expect(server.jobs.list()).toEqual([]);
  });

  it("rejects ambiguous Transfer-Encoding plus Content-Length framing", async () => {
    const roots = await fixture();
    const server = await startCodeCityServer({
      host: "127.0.0.1",
      port: 0,
      ...roots,
    });
    servers.push(server);
    const raw = await rawHttpExchange(
      server.port,
      [
        "POST /api/v1/imports HTTP/1.1",
        `Host: 127.0.0.1:${server.port}`,
        "Content-Type: application/json",
        "X-Code-City-Request: 1",
        "Content-Length: 1",
        "Transfer-Encoding: chunked",
        "Connection: keep-alive",
        "",
        "0",
        "",
        "",
      ].join("\r\n"),
    );
    expect(raw).toMatch(/^HTTP\/1\.1 400 /u);
    expect(server.jobs.list()).toEqual([]);
  });

  it("times out and closes a valid but slow incomplete body", async () => {
    const roots = await fixture();
    const fakes = successfulDependencies();
    const server = await startCodeCityServer({
      host: "127.0.0.1",
      port: 0,
      ...roots,
      importDependencies: fakes.dependencies,
    });
    servers.push(server);

    const raw = await rawHttpExchange(
      server.port,
      [
        "POST /api/v1/imports HTTP/1.1",
        `Host: 127.0.0.1:${server.port}`,
        "Content-Type: application/json",
        "X-Code-City-Request: 1",
        "Transfer-Encoding: chunked",
        "Connection: keep-alive",
        "",
        "1",
        "{",
        "",
      ].join("\r\n"),
      7_000,
    );
    expect(raw).toMatch(/^HTTP\/1\.1 408 /u);
    expect(raw.toLowerCase()).toContain("connection: close");
    expect(fakes.github).not.toHaveBeenCalled();
    expect(server.jobs.list()).toEqual([]);
  }, 8_000);

  it("does not enqueue a disconnected partial body", async () => {
    const roots = await fixture();
    const fakes = successfulDependencies();
    const server = await startCodeCityServer({
      host: "127.0.0.1",
      port: 0,
      ...roots,
      importDependencies: fakes.dependencies,
    });
    servers.push(server);

    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection({
        host: "127.0.0.1",
        port: server.port,
      });
      socket.once("connect", () => {
        socket.write(
          [
            "POST /api/v1/imports HTTP/1.1",
            `Host: 127.0.0.1:${server.port}`,
            "Content-Type: application/json",
            "X-Code-City-Request: 1",
            "Transfer-Encoding: chunked",
            "",
            "1",
            "{",
            "",
          ].join("\r\n"),
          () => socket.destroy(),
        );
      });
      socket.once("close", () => resolve());
      socket.once("error", reject);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(server.jobs.list()).toEqual([]);
    expect(fakes.github).not.toHaveBeenCalled();
    expect(
      await fs.readdir(
        path.join(roots.dataDirectory, "tmp", "imports"),
      ),
    ).toEqual([]);
  });

  it("cancels and cleans a post-parse import when the client disconnects", async () => {
    const roots = await fixture();
    let signalStagingStarted: (() => void) | undefined;
    let releaseStaging: (() => void) | undefined;
    const stagingStarted = new Promise<void>((resolve) => {
      signalStagingStarted = resolve;
    });
    const stagingReleased = new Promise<void>((resolve) => {
      releaseStaging = resolve;
    });
    const analyzerStarted = vi.fn();
    const server = await startCodeCityServer({
      host: "127.0.0.1",
      port: 0,
      ...roots,
      importDependencies: {
        analyzePublicGitHubRepository: vi.fn(
          async (
            _request: unknown,
            options: { readonly signal?: AbortSignal },
          ): Promise<PublicGitHubAnalysisResult> => {
            analyzerStarted();
            await new Promise<void>((resolve) => {
              options.signal?.addEventListener("abort", () => resolve(), {
                once: true,
              });
            });
            throw new Error("aborted analyzer");
          },
        ) as NonNullable<
          RemoteImportDependencies["analyzePublicGitHubRepository"]
        >,
      },
    });
    servers.push(server);
    const originalCreateStaging =
      server.artifacts.createStagingDirectory.bind(server.artifacts);
    vi.spyOn(
      server.artifacts,
      "createStagingDirectory",
    ).mockImplementationOnce(async () => {
      signalStagingStarted?.();
      await stagingReleased;
      return originalCreateStaging();
    });

    const body = importBody();
    const socket = net.createConnection({
      host: "127.0.0.1",
      port: server.port,
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => {
        socket.write(
          [
            "POST /api/v1/imports HTTP/1.1",
            `Host: 127.0.0.1:${server.port}`,
            "Content-Type: application/json",
            "X-Code-City-Request: 1",
            `Content-Length: ${Buffer.byteLength(body, "utf8")}`,
            "Connection: keep-alive",
            "",
            body,
          ].join("\r\n"),
          () => resolve(),
        );
      });
      socket.once("error", reject);
    });
    await stagingStarted;
    socket.destroy();
    releaseStaging?.();

    const deadline = Date.now() + 5_000;
    let queued: JobRecord | undefined;
    while (Date.now() < deadline) {
      queued = server.jobs.list()[0];
      if (queued !== undefined) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(queued).toBeDefined();
    const terminal = await waitForTerminal(server, queued!.id);
    expect(terminal.state).toBe("cancelled");
    expect(analyzerStarted.mock.calls.length).toBeLessThanOrEqual(1);
    expect(
      await fs.readdir(
        path.join(roots.dataDirectory, "tmp", "imports"),
      ),
    ).toEqual([]);
    expect(
      await fs.readdir(path.join(roots.dataDirectory, "artifacts")),
    ).toEqual([]);
  });

  it("cancels active analysis and cleans private staging data", async () => {
    const roots = await fixture();
    let resolveStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const github = vi.fn(
      async (
        _request: unknown,
        options: { readonly signal?: AbortSignal },
      ): Promise<PublicGitHubAnalysisResult> => {
        resolveStarted?.();
        await new Promise<void>((resolve) => {
          options.signal?.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
        throw new Error(
          "sensitive https://user:secret@example.test/private path C:\\secret",
        );
      },
    );
    const server = await startCodeCityServer({
      host: "127.0.0.1",
      port: 0,
      ...roots,
      importDependencies: {
        analyzePublicGitHubRepository:
          github as NonNullable<
            RemoteImportDependencies["analyzePublicGitHubRepository"]
          >,
      },
    });
    servers.push(server);

    const response = await request(
      new URL("/api/v1/imports", server.url),
      {
        method: "POST",
        headers: importHeaders(),
        body: importBody(),
      },
    );
    const queued = (JSON.parse(response.body) as { job: JobRecord }).job;
    await started;
    const cancelled = await request(
      new URL(`/api/v1/jobs/${queued.id}`, server.url),
      {
        method: "DELETE",
        headers: { "X-Code-City-Request": "1" },
      },
    );
    expect(cancelled.status).toBe(200);
    const terminal = await waitForTerminal(server, queued.id);
    expect(terminal.state).toBe("cancelled");
    expect(JSON.stringify(terminal)).not.toContain("secret");
    expect(
      await fs.readdir(
        path.join(roots.dataDirectory, "tmp", "imports"),
      ),
    ).toEqual([]);
    expect(
      await fs.readdir(path.join(roots.dataDirectory, "artifacts")),
    ).toEqual([]);
  });

  it("cleans staging and returns a fixed error when enqueue fails", async () => {
    const roots = await fixture();
    const fakes = successfulDependencies();
    const server = await startCodeCityServer({
      host: "127.0.0.1",
      port: 0,
      ...roots,
      importDependencies: fakes.dependencies,
    });
    servers.push(server);
    vi.spyOn(server.jobs, "enqueue").mockRejectedValueOnce(
      new Error(
        "never-return https://user:secret@example.test/C:/private",
      ),
    );

    const response = await request(
      new URL("/api/v1/imports", server.url),
      {
        method: "POST",
        headers: importHeaders(),
        body: importBody(),
      },
    );
    expect(response.status).toBe(500);
    expect(response.body).not.toContain("secret");
    expect(server.jobs.list()).toEqual([]);
    expect(
      await fs.readdir(
        path.join(roots.dataDirectory, "tmp", "imports"),
      ),
    ).toEqual([]);
  });

  it("maps only known analyzer failures to fixed actionable job errors", async () => {
    const roots = await fixture();
    const cases = [
      {
        repository: "repository-unavailable",
        error: new GitHubSnapshotError(
          "GITHUB_REPOSITORY_UNAVAILABLE",
          "secret repository URL and auth diagnostics",
        ),
        code: "repository-unavailable",
        message:
          "The repository is unavailable to the server identity.",
      },
      {
        repository: "revision-unavailable",
        error: new GitHubSnapshotError(
          "GITHUB_REF_UNAVAILABLE",
          "secret ref diagnostics",
        ),
        code: "revision-unavailable",
        message: "The requested repository revision is unavailable.",
      },
      {
        repository: "deadline",
        error: new SnapshotDeadlineError("secret timeout internals"),
        code: "deadline-exceeded",
        message: "The repository import exceeded its time limit.",
      },
      {
        repository: "limit",
        error: new SnapshotLimitError("entries", 1, 2),
        code: "import-limit-exceeded",
        message:
          "The repository import exceeded a configured limit.",
      },
      {
        repository: "content",
        error: new SnapshotPathError("C:\\private\\unsafe"),
        code: "repository-content-rejected",
        message:
          "Repository content violates the import safety policy.",
      },
      {
        repository: "policy",
        error: new SnapshotPolicyError(
          "C:\\private\\.codecityignore",
          "secret policy reason",
        ),
        code: "repository-content-rejected",
        message:
          "Repository content violates the import safety policy.",
      },
      {
        repository: "unknown",
        error: new Error(
          "secret https://user:password@example.test/C:/private",
        ),
        code: "analysis-failed",
        message: "Repository analysis failed.",
      },
    ] as const;
    const failures = new Map(
      cases.map((entry) => [
        `https://github.com/openai/${entry.repository}`,
        entry.error,
      ]),
    );
    const github = vi.fn(
      async (analyzerRequest: { readonly repositoryUrl: string }) => {
        throw failures.get(analyzerRequest.repositoryUrl) ??
          new Error("Unexpected test repository.");
      },
    );
    const git = vi.fn(async () => {
      throw new GenericGitSnapshotError(
        "GIT_REF_UNAVAILABLE",
        "secret generic Git diagnostics",
      );
    });
    const server = await startCodeCityServer({
      host: "127.0.0.1",
      port: 0,
      ...roots,
      allowedGitOrigins: ["https://git.example"],
      trustWindowsGitWorkspace: true,
      importDependencies: {
        analyzePublicGitHubRepository:
          github as NonNullable<
            RemoteImportDependencies["analyzePublicGitHubRepository"]
          >,
        analyzeGenericGitRepository:
          git as NonNullable<
            RemoteImportDependencies["analyzeGenericGitRepository"]
          >,
      },
    });
    servers.push(server);

    for (const expected of cases) {
      const response = await request(
        new URL("/api/v1/imports", server.url),
        {
          method: "POST",
          headers: importHeaders(),
          body: importBody({
            kind: "github",
            repositoryUrl:
              `https://github.com/openai/${expected.repository}`,
          }),
        },
      );
      const queued = (JSON.parse(response.body) as { job: JobRecord })
        .job;
      const terminal = await waitForTerminal(server, queued.id);
      expect(terminal.error).toEqual({
        code: expected.code,
        message: expected.message,
      });
      expect(JSON.stringify(terminal)).not.toContain("secret");
      expect(JSON.stringify(terminal)).not.toContain("private");
    }

    const genericResponse = await request(
      new URL("/api/v1/imports", server.url),
      {
        method: "POST",
        headers: importHeaders(),
        body: importBody({
          kind: "git",
          repositoryUrl: "https://git.example/repository.git",
        }),
      },
    );
    const genericJob = (
      JSON.parse(genericResponse.body) as { job: JobRecord }
    ).job;
    expect((await waitForTerminal(server, genericJob.id)).error).toEqual({
      code: "revision-unavailable",
      message: "The requested repository revision is unavailable.",
    });
  }, 15_000);

  it("persists only a fixed failure when analysis rejects", async () => {
    const roots = await fixture();
    const repositoryUrl = "https://github.com/openai/private-name";
    const server = await startCodeCityServer({
      host: "127.0.0.1",
      port: 0,
      ...roots,
      importDependencies: {
        analyzePublicGitHubRepository: vi.fn(async () => {
          throw new Error(
            `secret diagnostics for ${repositoryUrl} at C:\\private\\source`,
          );
        }),
      },
    });
    servers.push(server);

    const response = await request(
      new URL("/api/v1/imports", server.url),
      {
        method: "POST",
        headers: importHeaders(),
        body: importBody({
          kind: "github",
          repositoryUrl,
        }),
      },
    );
    const queued = (JSON.parse(response.body) as { job: JobRecord }).job;
    const terminal = await waitForTerminal(server, queued.id);
    expect(terminal).toMatchObject({
      state: "failed",
      error: {
        code: "analysis-failed",
        message: "Repository analysis failed.",
      },
    });
    const persisted = await fs.readFile(
      path.join(roots.dataDirectory, "jobs", `${queued.id}.json`),
      "utf8",
    );
    expect(persisted).not.toContain("secret");
    expect(persisted).not.toContain(repositoryUrl);
    expect(persisted).not.toContain("private");
    expect(
      await fs.readdir(path.join(roots.dataDirectory, "artifacts")),
    ).toEqual([]);
    expect(
      await fs.readdir(
        path.join(roots.dataDirectory, "tmp", "imports"),
      ),
    ).toEqual([]);
  });

  it("cleans all owned paths when artifact publication rejects", async () => {
    const roots = await fixture();
    const fakes = successfulDependencies();
    const server = await startCodeCityServer({
      host: "127.0.0.1",
      port: 0,
      ...roots,
      importDependencies: fakes.dependencies,
    });
    servers.push(server);
    vi.spyOn(server.artifacts, "publishCityModel").mockRejectedValueOnce(
      new Error("secret publication path"),
    );

    const response = await request(
      new URL("/api/v1/imports", server.url),
      {
        method: "POST",
        headers: importHeaders(),
        body: importBody(),
      },
    );
    const queued = (JSON.parse(response.body) as { job: JobRecord }).job;
    const terminal = await waitForTerminal(server, queued.id);
    expect(terminal).toMatchObject({
      state: "failed",
      error: { message: "Repository import failed." },
    });
    expect(JSON.stringify(terminal)).not.toContain("secret");
    expect(
      await server.artifacts.readCityModel(queued.id),
    ).toBeUndefined();
    expect(
      await fs.readdir(
        path.join(roots.dataDirectory, "tmp", "imports"),
      ),
    ).toEqual([]);
  });

  it("rolls back the artifact when terminal finalization fails", async () => {
    const roots = await fixture();
    const fakes = successfulDependencies();
    const server = await startCodeCityServer({
      host: "127.0.0.1",
      port: 0,
      ...roots,
      importDependencies: fakes.dependencies,
    });
    servers.push(server);
    const originalCleanup =
      server.artifacts.cleanupStagingDirectory.bind(server.artifacts);
    let cleanupCalls = 0;
    vi.spyOn(
      server.artifacts,
      "cleanupStagingDirectory",
    ).mockImplementation(async (token) => {
      cleanupCalls += 1;
      if (cleanupCalls === 2) {
        throw new Error("secret finalizer path");
      }
      await originalCleanup(token);
    });

    const response = await request(
      new URL("/api/v1/imports", server.url),
      {
        method: "POST",
        headers: importHeaders(),
        body: importBody(),
      },
    );
    const queued = (JSON.parse(response.body) as { job: JobRecord }).job;
    const terminal = await waitForTerminal(server, queued.id);
    expect(terminal).toMatchObject({
      state: "failed",
      error: {
        code: "failed",
        message: "The job cleanup did not complete.",
      },
    });
    expect(cleanupCalls).toBeGreaterThanOrEqual(3);
    expect(
      await server.artifacts.readCityModel(queued.id),
    ).toBeUndefined();
    expect(JSON.stringify(terminal)).not.toContain("secret");
  });

  it("rolls back the artifact when terminal persistence fails", async () => {
    const roots = await fixture();
    const fakes = successfulDependencies();
    const server = await startCodeCityServer({
      host: "127.0.0.1",
      port: 0,
      ...roots,
      importDependencies: fakes.dependencies,
    });
    servers.push(server);
    const originalCleanup =
      server.artifacts.cleanupStagingDirectory.bind(server.artifacts);
    let cleanupCalls = 0;
    let signalFinalizerReady: (() => void) | undefined;
    let releaseFinalizer: (() => void) | undefined;
    const finalizerReady = new Promise<void>((resolve) => {
      signalFinalizerReady = resolve;
    });
    const finalizerReleased = new Promise<void>((resolve) => {
      releaseFinalizer = resolve;
    });
    vi.spyOn(
      server.artifacts,
      "cleanupStagingDirectory",
    ).mockImplementation(async (token) => {
      cleanupCalls += 1;
      await originalCleanup(token);
      if (cleanupCalls === 2) {
        signalFinalizerReady?.();
        await finalizerReleased;
      }
    });

    const response = await request(
      new URL("/api/v1/imports", server.url),
      {
        method: "POST",
        headers: importHeaders(),
        body: importBody(),
      },
    );
    const queued = (JSON.parse(response.body) as { job: JobRecord }).job;
    await finalizerReady;
    vi.spyOn(fs, "open").mockRejectedValueOnce(
      new Error("secret terminal persistence path"),
    );
    releaseFinalizer?.();

    const terminal = await waitForTerminal(server, queued.id);
    expect(terminal).toMatchObject({
      state: "failed",
      error: {
        code: "failed",
        message: "The job terminal state could not be persisted.",
      },
    });
    expect(
      await server.artifacts.readCityModel(queued.id),
    ).toBeUndefined();
    expect(JSON.stringify(terminal)).not.toContain("secret");
  });

  it("rolls back a published artifact when post-publication cleanup fails", async () => {
    const roots = await fixture();
    const fakes = successfulDependencies();
    const server = await startCodeCityServer({
      host: "127.0.0.1",
      port: 0,
      ...roots,
      importDependencies: fakes.dependencies,
    });
    servers.push(server);
    vi.spyOn(server.artifacts, "cleanupStagingDirectory")
      .mockRejectedValueOnce(new Error("private path"))
      .mockResolvedValue(undefined);

    const response = await request(
      new URL("/api/v1/imports", server.url),
      {
        method: "POST",
        headers: importHeaders(),
        body: importBody(),
      },
    );
    const queued = (JSON.parse(response.body) as { job: JobRecord }).job;
    const terminal = await waitForTerminal(server, queued.id);
    expect(terminal.state).toBe("failed");
    expect(terminal.error?.message).toBe("Repository import failed.");
    expect(
      await server.artifacts.readCityModel(queued.id),
    ).toBeUndefined();
  });
});
