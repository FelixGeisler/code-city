import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GENERIC_GIT_HISTORY_INDEX_MAX_BYTES,
  GENERIC_GIT_HISTORY_MAX_CHANGED_PATH_BYTES,
  GENERIC_GIT_ROOT_TO_TIP_HISTORY_MAX_COMMITS,
  withGenericGitHistoryRepository,
  type GenericGitSnapshotDependencies,
  type GenericGitTemporaryWorkspace,
  type GitProcessRequest,
} from "../packages/analyzer/src/git-snapshot.js";

const TIP = "1111111111111111111111111111111111111111";
const PARENT = "2222222222222222222222222222222222222222";
const ROOT = "3333333333333333333333333333333333333333";
const BLOB = "4444444444444444444444444444444444444444";
const REMOTE =
  "https://dev.azure.example/Collection/Project/_git/History";
const temporaryRoots: string[] = [];
const encoder = new TextEncoder();

function bytes(value: string): Uint8Array {
  return encoder.encode(value);
}

function operationOf(request: GitProcessRequest): string {
  return (
    request.arguments.find((argument) =>
      [
        "archive",
        "diff-tree",
        "fetch",
        "init",
        "ls-remote",
        "rev-list",
        "rev-parse",
        "--version",
      ].includes(argument),
    ) ?? ""
  );
}

function archiveOutputPath(
  arguments_: readonly string[],
): string | undefined {
  const value = arguments_.find((argument) =>
    argument.startsWith("--output="),
  );
  return value?.slice("--output=".length);
}

async function workspace(options: {
  readonly ancestorConfig?: string;
} = {}): Promise<{
  readonly value: GenericGitTemporaryWorkspace;
  readonly dispose: ReturnType<typeof vi.fn>;
  readonly measureBytes: ReturnType<typeof vi.fn>;
}> {
  const cleanupRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "code-city-history-session-"),
  );
  temporaryRoots.push(cleanupRoot);
  const root =
    options.ancestorConfig === undefined
      ? cleanupRoot
      : path.join(cleanupRoot, "private-workspace");
  if (options.ancestorConfig !== undefined) {
    await fs.mkdir(path.join(cleanupRoot, ".git"));
    await fs.writeFile(
      path.join(cleanupRoot, ".git", "config"),
      options.ancestorConfig,
      "utf8",
    );
    await fs.mkdir(root);
  }
  const repositoryDirectory = path.join(root, "repository.git");
  const templateDirectory = path.join(root, "empty-template");
  await fs.mkdir(repositoryDirectory);
  await fs.mkdir(templateDirectory);
  const dispose = vi.fn(async () => {
    await fs.rm(cleanupRoot, { recursive: true, force: true });
  });
  const measureBytes = vi.fn(async () => 4_096);
  return {
    value: {
      root,
      repositoryDirectory,
      templateDirectory,
      measureBytes,
      dispose,
    },
    dispose,
    measureBytes,
  };
}

interface FakeGitOptions {
  readonly secondTip?: string;
  readonly secondTag?: string;
  readonly changes?: Uint8Array;
  readonly history?: string;
  readonly version?: string;
  readonly fetchDiagnostics?: Uint8Array;
  readonly omitFetchDiagnostics?: boolean;
  readonly partialCloneHasMissingObjects?: boolean;
  readonly shallowFile?: string;
}

function fakeGit(options: FakeGitOptions = {}): {
  readonly calls: GitProcessRequest[];
  readonly runGit: NonNullable<
    GenericGitSnapshotDependencies["runGit"]
  >;
} {
  const calls: GitProcessRequest[] = [];
  let tipReads = 0;
  let tagReads = 0;
  const runGit: NonNullable<
    GenericGitSnapshotDependencies["runGit"]
  > = async (request) => {
    calls.push(request);
    const operation = operationOf(request);
    if (operation === "--version") {
      return {
        exitCode: 0,
        stdout: bytes(
          options.version ?? "git version 2.47.1.windows.2\n",
        ),
      };
    }
    if (operation === "ls-remote") {
      const tagRef = request.arguments.find((argument) =>
        argument.startsWith("refs/tags/"),
      );
      if (tagRef !== undefined) {
        tagReads += 1;
        const sha =
          tagReads > 1
            ? (options.secondTag ?? PARENT)
            : PARENT;
        return {
          exitCode: 0,
          stdout: bytes(`${sha}\trefs/tags/v1\n`),
        };
      }
      tipReads += 1;
      const sha =
        tipReads > 1 ? (options.secondTip ?? TIP) : TIP;
      return {
        exitCode: 0,
        stdout: bytes(
          `ref: refs/heads/main\tHEAD\n${sha}\tHEAD\n`,
        ),
      };
    }
    if (operation === "rev-parse") {
      return { exitCode: 0, stdout: bytes(`${TIP}\n`) };
    }
    if (operation === "rev-list") {
      if (request.arguments.includes("--objects")) {
        const omitted = request.arguments.includes(
          "--filter-print-omitted",
        );
        const marker = omitted
          ? "~"
          : options.partialCloneHasMissingObjects === false
            ? ""
            : "?";
        return {
          exitCode: 0,
          stdout: bytes(`${TIP}\n${marker}${BLOB}\n`),
        };
      }
      return {
        exitCode: 0,
        stdout: bytes(
          options.history ??
            `1735862400 ${TIP} ${PARENT}\n` +
              `1735776000 ${PARENT} ${ROOT}\n` +
              `1735689600 ${ROOT}\n`,
        ),
      };
    }
    if (operation === "fetch") {
      if (options.shallowFile !== undefined) {
        const repositoryIndex = request.arguments.indexOf("-C");
        const repositoryDirectory =
          request.arguments[repositoryIndex + 1];
        if (repositoryIndex < 0 || repositoryDirectory === undefined) {
          throw new Error("Missing fake repository directory.");
        }
        await fs.writeFile(
          path.join(repositoryDirectory, "shallow"),
          options.shallowFile,
          "utf8",
        );
      }
      return {
        exitCode: 0,
        stdout: new Uint8Array(),
        ...(options.omitFetchDiagnostics === true
          ? {}
          : {
              stderr:
                options.fetchDiagnostics ?? new Uint8Array(),
            }),
      };
    }
    if (operation === "diff-tree") {
      return {
        exitCode: 0,
        stdout:
          options.changes ??
          bytes(
            "R100\0src/old.ts\0src/new.ts\0" +
              "M\0package.json\0",
          ),
      };
    }
    if (operation === "archive") {
      const output = archiveOutputPath(request.arguments);
      if (output === undefined) {
        throw new Error("Missing fake archive output.");
      }
      await fs.writeFile(
        output,
        zipSync({
          "snapshot/src/main.ts": strToU8(
            "export const answer = 42;\n",
          ),
        }),
      );
    }
    return { exitCode: 0, stdout: new Uint8Array() };
  };
  return { calls, runGit };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      fs.rm(root, { recursive: true, force: true }),
    ),
  );
});

describe("bounded Generic Git history sessions", () => {
  it("streams metadata, rename events, and one snapshot in one guarded session", async () => {
    const git = fakeGit();
    const harness = await workspace();
    let escapedRead:
      | (() => Promise<unknown>)
      | undefined;

    const result = await withGenericGitHistoryRepository(
      {
        repositoryUrl: REMOTE,
        maximumCommits: 2,
      },
      async (session) => {
        expect(session).toMatchObject({
          repository: "History",
          tipSha: TIP,
          transport: "https",
          oldestCommitIsShallow: false,
          backend: {
            name: "git",
            version: "2.47.1.windows.2",
            renamePolicyRevision:
              "sampled-boundary-diff-tree-renames-50-myers-v2",
          },
          tags: [],
        });
        expect(session.commits).toEqual([
          {
            sha: TIP,
            parents: [PARENT],
            committedAtSeconds: 1_735_862_400,
            committedAt: "2025-01-03T00:00:00.000Z",
          },
          {
            sha: PARENT,
            parents: [ROOT],
            committedAtSeconds: 1_735_776_000,
            committedAt: "2025-01-02T00:00:00.000Z",
          },
          {
            sha: ROOT,
            parents: [],
            committedAtSeconds: 1_735_689_600,
            committedAt: "2025-01-01T00:00:00.000Z",
          },
        ]);
        harness.measureBytes.mockClear();
        expect(await session.readChanges(TIP)).toEqual([
          {
            kind: "renamed",
            previousPath: "src/old.ts",
            path: "src/new.ts",
          },
          { kind: "modified", path: "package.json" },
        ]);
        expect(harness.measureBytes).toHaveBeenCalled();
        const snapshot = await session.readSnapshot(TIP);
        expect(snapshot.name).toBe("History");
        expect(snapshot.files.map(({ path }) => path)).toEqual([
          "src/main.ts",
        ]);
        escapedRead = () => session.readSnapshot(TIP);
        return "consumed";
      },
      {
        runGit: git.runGit,
        createTemporaryWorkspace: async () => harness.value,
      },
    );

    expect(result).toBe("consumed");
    await expect(escapedRead?.()).rejects.toMatchObject({
      code: "GIT_INVALID_REQUEST",
    });
    expect(harness.dispose).toHaveBeenCalledOnce();
    expect(
      git.calls.find(
        (request) => operationOf(request) === "fetch",
      )?.arguments,
    ).toContain("--depth=3");
    expect(
      git.calls.filter(
        (request) => operationOf(request) === "ls-remote",
      ),
    ).toHaveLength(2);
    const diffRequest = git.calls.find(
      (request) => operationOf(request) === "diff-tree",
    );
    expect(diffRequest?.maximumStdoutBytes).toBe(
      GENERIC_GIT_HISTORY_MAX_CHANGED_PATH_BYTES,
    );
    const diffArguments = diffRequest?.arguments;
    expect(diffArguments).toEqual(
      expect.arrayContaining([
        "core.bigFileThreshold=512m",
        "diff.algorithm=myers",
        "diff.indentHeuristic=false",
        "diff.orderFile=",
        "diff.renameFromRewrite=false",
        "diff.renameLimit=10000",
        "diff.renames=false",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--diff-algorithm=myers",
        "--no-indent-heuristic",
        "--find-renames=50%",
        "--ignore-submodules=none",
      ]),
    );
  });

  it("acquires root-to-tip metadata through a verified treeless promisor fetch", async () => {
    const git = fakeGit();
    const harness = await workspace();

    await withGenericGitHistoryRepository(
      {
        repositoryUrl: REMOTE,
        traversal: "root-to-tip",
        maximumCommits:
          GENERIC_GIT_ROOT_TO_TIP_HISTORY_MAX_COMMITS,
      },
      async (session) => {
        expect(
          session.commits.map(
            ({ committedAtSeconds }) => committedAtSeconds,
          ),
        ).toEqual([
          1_735_862_400,
          1_735_776_000,
          1_735_689_600,
        ]);
      },
      {
        runGit: git.runGit,
        createTemporaryWorkspace: async () => harness.value,
      },
    );

    const fetch = git.calls.find(
      (request) => operationOf(request) === "fetch",
    );
    expect(fetch?.arguments).toEqual(
      expect.arrayContaining([
        `--depth=${GENERIC_GIT_ROOT_TO_TIP_HISTORY_MAX_COMMITS + 1}`,
        "--filter=tree:0",
        "codecity-history",
        TIP,
      ]),
    );
    expect(
      git.calls.some(
        ({ arguments: arguments_ }) =>
          arguments_.includes("remote") &&
          arguments_.includes("codecity-history") &&
          arguments_.includes(REMOTE),
      ),
    ).toBe(true);
    const historyIndex = git.calls.find(
      ({ arguments: arguments_ }) =>
        arguments_.includes("rev-list") &&
        arguments_.includes("--first-parent"),
    );
    expect(historyIndex?.maximumStdoutBytes).toBe(
      GENERIC_GIT_HISTORY_INDEX_MAX_BYTES,
    );
    const inventories = git.calls.filter(
      ({ arguments: arguments_ }) =>
        arguments_.includes("rev-list") &&
        arguments_.includes("--objects"),
    );
    expect(inventories).toHaveLength(2);
    expect(
      inventories.every(
        ({ maximumStdoutBytes }) =>
          maximumStdoutBytes ===
          GENERIC_GIT_HISTORY_INDEX_MAX_BYTES,
      ),
    ).toBe(true);
    expect(harness.dispose).toHaveBeenCalledOnce();
  });

  it("identifies only the indexed first-parent boundary in validated shallow metadata", async () => {
    const cases = [
      { shallowFile: `${BLOB}\n`, expected: false },
      { shallowFile: `${BLOB}\n${ROOT}\n`, expected: true },
    ] as const;
    for (const { shallowFile, expected } of cases) {
      const git = fakeGit({ shallowFile });
      const harness = await workspace();
      await withGenericGitHistoryRepository(
        { repositoryUrl: REMOTE, maximumCommits: 3 },
        async (session) => {
          expect(session.oldestCommitIsShallow).toBe(expected);
        },
        {
          runGit: git.runGit,
          createTemporaryWorkspace: async () => harness.value,
        },
      );
      expect(harness.dispose).toHaveBeenCalledOnce();
    }

    const malformed = fakeGit({ shallowFile: `${ROOT}\r\n` });
    const malformedHarness = await workspace();
    await expect(
      withGenericGitHistoryRepository(
        { repositoryUrl: REMOTE, maximumCommits: 3 },
        async () => undefined,
        {
          runGit: malformed.runGit,
          createTemporaryWorkspace: async () =>
            malformedHarness.value,
        },
      ),
    ).rejects.toMatchObject({ code: "GIT_INVALID_RESPONSE" });
    expect(malformedHarness.dispose).toHaveBeenCalledOnce();
  });

  it("fails closed when a remote ignores or cannot prove the partial-clone filter", async () => {
    const cases: readonly FakeGitOptions[] = [
      {
        fetchDiagnostics: bytes(
          "warning: filtering not recognized by server, ignoring\n",
        ),
      },
      { omitFetchDiagnostics: true },
      { partialCloneHasMissingObjects: false },
    ];
    for (const options of cases) {
      const git = fakeGit(options);
      const harness = await workspace();
      await expect(
        withGenericGitHistoryRepository(
          {
            repositoryUrl: REMOTE,
            traversal: "root-to-tip",
            maximumCommits: 3,
          },
          async () => undefined,
          {
            runGit: git.runGit,
            createTemporaryWorkspace: async () => harness.value,
          },
        ),
      ).rejects.toMatchObject({
        code: "GIT_PARTIAL_CLONE_UNAVAILABLE",
      });
      expect(harness.dispose).toHaveBeenCalledOnce();
    }
  });

  it("diffs only requested sampled boundaries and validates ancestry order", async () => {
    const git = fakeGit();
    const harness = await workspace();

    await withGenericGitHistoryRepository(
      {
        repositoryUrl: REMOTE,
        maximumCommits: 3,
      },
      async (session) => {
        harness.measureBytes.mockClear();
        const expected = [
          {
            kind: "renamed",
            previousPath: "src/old.ts",
            path: "src/new.ts",
          },
          { kind: "modified", path: "package.json" },
        ];
        expect(await session.readChangesBetween(ROOT, TIP)).toEqual(
          expected,
        );
        expect(harness.measureBytes).toHaveBeenCalled();
        await expect(
          session.readChangesBetween(TIP, ROOT),
        ).rejects.toMatchObject({ code: "GIT_INVALID_REQUEST" });
        await expect(
          session.readChangesBetween(TIP, TIP),
        ).rejects.toMatchObject({ code: "GIT_INVALID_REQUEST" });
        await expect(
          session.readChangesBetween("f".repeat(40), TIP),
        ).rejects.toMatchObject({ code: "GIT_INVALID_REQUEST" });
        expect(await session.readChangesBetween(ROOT, TIP)).toEqual(
          expected,
        );
      },
      {
        runGit: git.runGit,
        createTemporaryWorkspace: async () => harness.value,
      },
    );

    const diffs = git.calls.filter(
      (request) => operationOf(request) === "diff-tree",
    );
    expect(diffs).toHaveLength(2);
    for (const diff of diffs) {
      expect(diff.arguments.indexOf(ROOT)).toBeLessThan(
        diff.arguments.indexOf(TIP),
      );
      expect(diff.arguments).not.toContain("--root");
    }
  });

  it("admits multi-mebibyte boundary diffs within the remaining changed-path budget", async () => {
    const pathCount = 10_000;
    const largeChanges = bytes(
      Array.from(
        { length: pathCount },
        (_, index) =>
          `M\0src/${String(index).padStart(6, "0")}-${"x".repeat(160)}.ts\0`,
      ).join(""),
    );
    expect(largeChanges.byteLength).toBeGreaterThan(1024 * 1024);
    const git = fakeGit({ changes: largeChanges });
    const harness = await workspace();
    const configuredBytes = 4 * 1024 * 1024;

    await withGenericGitHistoryRepository(
      {
        repositoryUrl: REMOTE,
        maximumCommits: 3,
        maximumChangedPathBytes: configuredBytes,
      },
      async (session) => {
        expect(
          await session.readChangesBetween(ROOT, TIP),
        ).toHaveLength(pathCount);
        await expect(
          session.readChangesBetween(ROOT, TIP),
        ).rejects.toMatchObject({ code: "GIT_OUTPUT_TOO_LARGE" });
      },
      {
        runGit: git.runGit,
        createTemporaryWorkspace: async () => harness.value,
      },
    );

    const diffRequests = git.calls.filter(
      (request) => operationOf(request) === "diff-tree",
    );
    expect(diffRequests).toHaveLength(2);
    expect(diffRequests[0]?.maximumStdoutBytes).toBe(
      configuredBytes,
    );
    expect(diffRequests[1]?.maximumStdoutBytes).toBeLessThan(
      largeChanges.byteLength,
    );
    expect(
      diffRequests.every(
        ({ maximumStdoutBytes }) =>
          maximumStdoutBytes <=
          GENERIC_GIT_HISTORY_MAX_CHANGED_PATH_BYTES,
      ),
    ).toBe(true);
  });

  it("isolates ambient and ancestor Git configuration for anonymous GitHub history acquisition", async () => {
    const git = fakeGit();
    const harness = await workspace({
      ancestorConfig:
        '[url "https://attacker.invalid/"]\n' +
        "\tinsteadOf = https://github.com/\n" +
        "[credential]\n\thelper = attacker-helper\n" +
        "[http]\n\textraHeader = Authorization: secret\n" +
        "\tcookieFile = secret.cookies\n" +
        "[core]\n\taskPass = attacker-askpass\n",
    });

    await withGenericGitHistoryRepository(
      {
        repositoryUrl: "https://github.com/example/history.git",
        maximumCommits: 2,
      },
      async () => undefined,
      {
        runGit: git.runGit,
        createTemporaryWorkspace: async () => harness.value,
        isolateCredentials: true,
        environment: {
          HOME: "C:\\ambient-home",
          USERPROFILE: "C:\\ambient-profile",
          XDG_CONFIG_HOME: "C:\\ambient-xdg",
          APPDATA: "C:\\ambient-app-data",
          LOCALAPPDATA: "C:\\ambient-local-data",
          SSH_AGENT_PID: "123",
          SSH_AUTH_SOCK: "ambient-agent",
        },
      },
    );

    expect(git.calls.length).toBeGreaterThan(0);
    for (const request of git.calls) {
      expect(request.env["HOME"]).not.toBe("C:\\ambient-home");
      expect(request.env["USERPROFILE"]).not.toBe(
        "C:\\ambient-profile",
      );
      expect(request.env["XDG_CONFIG_HOME"]).not.toBe(
        "C:\\ambient-xdg",
      );
      expect(request.env["APPDATA"]).not.toBe(
        "C:\\ambient-app-data",
      );
      expect(request.env["LOCALAPPDATA"]).not.toBe(
        "C:\\ambient-local-data",
      );
      expect(request.env["SSH_AGENT_PID"]).toBeUndefined();
      expect(request.env["SSH_AUTH_SOCK"]).toBeUndefined();
      expect(request.env["GIT_CONFIG_NOSYSTEM"]).toBe("1");
      expect(request.env["GIT_CONFIG_GLOBAL"]).toMatch(
        /global\.gitconfig$/u,
      );
      expect(request.env["GIT_CONFIG_GLOBAL"]?.startsWith(
        harness.value.root,
      )).toBe(true);
      expect(request.env["GIT_CEILING_DIRECTORIES"]).toBe(
        path.resolve(harness.value.root),
      );
      expect(request.env["GIT_CONFIG_COUNT"]).toBeUndefined();
      expect(request.arguments).toEqual(
        expect.arrayContaining([
          "credential.helper=",
          "http.extraHeader=",
          "http.cookieFile=",
          "core.askPass=",
        ]),
      );
    }
    expect(harness.dispose).toHaveBeenCalledOnce();
  });

  it("resolves requested tags in memory and rejects a tag that moves during analysis", async () => {
    const git = fakeGit({ secondTag: ROOT });
    const harness = await workspace();

    await expect(
      withGenericGitHistoryRepository(
        {
          repositoryUrl: REMOTE,
          maximumCommits: 3,
          tagNames: ["v1"],
        },
        async (session) => {
          expect(session.tags).toEqual([
            { name: "v1", commitSha: PARENT },
          ]);
          return undefined;
        },
        {
          runGit: git.runGit,
          createTemporaryWorkspace: async () => harness.value,
        },
      ),
    ).rejects.toMatchObject({ code: "GIT_REF_CHANGED" });
    expect(harness.dispose).toHaveBeenCalledOnce();
  });

  it("rejects non-linear metadata and non-portable changed paths", async () => {
    const cases: readonly FakeGitOptions[] = [
      {
        history:
          `1735862400 ${TIP} ${PARENT}\n` +
          `1735776000 ${ROOT}\n`,
      },
      { changes: bytes("M\0../escape.ts\0") },
      {
        history: `253402300800 ${TIP}\n`,
      },
    ];
    for (const options of cases) {
      const git = fakeGit(options);
      const harness = await workspace();
      await expect(
        withGenericGitHistoryRepository(
          {
            repositoryUrl: REMOTE,
            maximumCommits: 3,
          },
          async (session) => {
            if (options.changes !== undefined) {
              await session.readChanges(TIP);
            }
            return undefined;
          },
          {
            runGit: git.runGit,
            createTemporaryWorkspace: async () => harness.value,
          },
        ),
      ).rejects.toThrow();
      expect(harness.dispose).toHaveBeenCalledOnce();
    }
  });

  it("rejects invalid bounds and duplicate tag spellings before creating a workspace", async () => {
    const createTemporaryWorkspace = vi.fn();
    const runGit = vi.fn<
      NonNullable<GenericGitSnapshotDependencies["runGit"]>
    >();

    await expect(
      withGenericGitHistoryRepository(
        {
          repositoryUrl: REMOTE,
          maximumCommits: 501,
        },
        async () => undefined,
        { runGit, createTemporaryWorkspace },
      ),
    ).rejects.toMatchObject({ code: "GIT_INVALID_REQUEST" });
    await expect(
      withGenericGitHistoryRepository(
        {
          repositoryUrl: REMOTE,
          traversal: "root-to-tip",
          maximumCommits:
            GENERIC_GIT_ROOT_TO_TIP_HISTORY_MAX_COMMITS + 1,
        },
        async () => undefined,
        { runGit, createTemporaryWorkspace },
      ),
    ).rejects.toMatchObject({ code: "GIT_INVALID_REQUEST" });
    await expect(
      withGenericGitHistoryRepository(
        {
          repositoryUrl: REMOTE,
          maximumCommits: 3,
          tagNames: ["v1", "refs/tags/v1"],
        },
        async () => undefined,
        { runGit, createTemporaryWorkspace },
      ),
    ).rejects.toMatchObject({ code: "GIT_INVALID_REQUEST" });
    await expect(
      withGenericGitHistoryRepository(
        {
          repositoryUrl: REMOTE,
          maximumCommits: 3,
          maximumChangedPathEntries: 0,
        },
        async () => undefined,
        { runGit, createTemporaryWorkspace },
      ),
    ).rejects.toMatchObject({ code: "GIT_INVALID_REQUEST" });
    expect(runGit).not.toHaveBeenCalled();
    expect(createTemporaryWorkspace).not.toHaveBeenCalled();
  });

  it("enforces the dedicated history index output bound against custom runners", async () => {
    const base = fakeGit();
    const harness = await workspace();
    const runGit: NonNullable<
      GenericGitSnapshotDependencies["runGit"]
    > = async (request) => {
      if (
        operationOf(request) === "rev-list" &&
        request.arguments.includes("--first-parent")
      ) {
        expect(request.maximumStdoutBytes).toBe(
          GENERIC_GIT_HISTORY_INDEX_MAX_BYTES,
        );
        return {
          exitCode: 0,
          stdout: new Uint8Array(
            GENERIC_GIT_HISTORY_INDEX_MAX_BYTES + 1,
          ),
        };
      }
      return await base.runGit(request);
    };

    await expect(
      withGenericGitHistoryRepository(
        {
          repositoryUrl: REMOTE,
          maximumCommits: 3,
        },
        async () => undefined,
        {
          runGit,
          createTemporaryWorkspace: async () => harness.value,
        },
      ),
    ).rejects.toMatchObject({ code: "GIT_OUTPUT_TOO_LARGE" });
    expect(harness.dispose).toHaveBeenCalledOnce();
  });

  it("rejects lowered changed-path caps while parsing Git output", async () => {
    const git = fakeGit();
    const harness = await workspace();

    await expect(
      withGenericGitHistoryRepository(
        {
          repositoryUrl: REMOTE,
          maximumCommits: 3,
          maximumChangedPathEntries: 1,
          maximumChangedPathBytes: 1_024,
        },
        async (session) => {
          await session.readChanges(TIP);
        },
        {
          runGit: git.runGit,
          createTemporaryWorkspace: async () => harness.value,
        },
      ),
    ).rejects.toMatchObject({ code: "GIT_OUTPUT_TOO_LARGE" });
    expect(
      git.calls.filter(
        (request) => operationOf(request) === "diff-tree",
      ),
    ).toHaveLength(1);
    expect(harness.dispose).toHaveBeenCalledOnce();
  });

  it("rejects malformed Git backend provenance before history acquisition", async () => {
    const git = fakeGit({
      version: "git version 2.47.1\ninjected\n",
    });
    const harness = await workspace();

    await expect(
      withGenericGitHistoryRepository(
        {
          repositoryUrl: REMOTE,
          maximumCommits: 3,
        },
        async () => undefined,
        {
          runGit: git.runGit,
          createTemporaryWorkspace: async () => harness.value,
        },
      ),
    ).rejects.toMatchObject({ code: "GIT_INVALID_RESPONSE" });
    expect(
      git.calls.some(
        (request) => operationOf(request) === "ls-remote",
      ),
    ).toBe(false);
    expect(harness.dispose).toHaveBeenCalledOnce();
  });

  it("aborts and drains a floating session operation before workspace disposal", async () => {
    const base = fakeGit();
    const harness = await workspace();
    const events: string[] = [];
    let started!: () => void;
    const operationStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const runGit: NonNullable<
      GenericGitSnapshotDependencies["runGit"]
    > = async (request) => {
      if (operationOf(request) !== "diff-tree") {
        return await base.runGit(request);
      }
      events.push("operation-started");
      started();
      return await new Promise<never>((_resolve, reject) => {
        const abort = () => {
          events.push("operation-aborted");
          reject(new Error("cancelled"));
        };
        request.signal.addEventListener("abort", abort, {
          once: true,
        });
        if (request.signal.aborted) abort();
      });
    };
    const dispose = vi.fn(async () => {
      events.push("disposed");
      await harness.value.dispose();
    });

    await expect(
      withGenericGitHistoryRepository(
        {
          repositoryUrl: REMOTE,
          maximumCommits: 3,
        },
        async (session) => {
          void session.readChanges(TIP);
          await operationStarted;
          return undefined;
        },
        {
          runGit,
          createTemporaryWorkspace: async () => ({
            ...harness.value,
            dispose,
          }),
        },
      ),
    ).rejects.toMatchObject({ code: "GIT_INVALID_REQUEST" });

    expect(events).toEqual([
      "operation-started",
      "operation-aborted",
      "disposed",
    ]);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("drains an awaited operation after a total deadline before disposal", async () => {
    const base = fakeGit();
    const harness = await workspace();
    const events: string[] = [];
    const runGit: NonNullable<
      GenericGitSnapshotDependencies["runGit"]
    > = async (request) => {
      if (operationOf(request) !== "diff-tree") {
        return await base.runGit(request);
      }
      events.push("operation-started");
      return await new Promise<never>((_resolve, reject) => {
        const abort = () => {
          events.push("operation-aborted");
          reject(new Error("cancelled"));
        };
        request.signal.addEventListener("abort", abort, {
          once: true,
        });
        if (request.signal.aborted) abort();
      });
    };
    const dispose = vi.fn(async () => {
      events.push("disposed");
      await harness.value.dispose();
    });

    await expect(
      withGenericGitHistoryRepository(
        {
          repositoryUrl: REMOTE,
          maximumCommits: 3,
          timeoutMs: 50,
        },
        async (session) => {
          await session.readChanges(TIP);
        },
        {
          runGit,
          createTemporaryWorkspace: async () => ({
            ...harness.value,
            dispose,
          }),
        },
      ),
    ).rejects.toMatchObject({ code: "GIT_DEADLINE_EXCEEDED" });

    expect(events).toEqual([
      "operation-started",
      "operation-aborted",
      "disposed",
    ]);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("batches maximum-size tag lookups below the Windows command-line limit", async () => {
    const base = fakeGit();
    const harness = await workspace();
    const tags = Array.from(
      { length: 64 },
      (_, index) =>
        `release-${String(index).padStart(2, "0")}-${"x".repeat(230)}`,
    );
    const tagCalls: GitProcessRequest[] = [];
    const runGit: NonNullable<
      GenericGitSnapshotDependencies["runGit"]
    > = async (request) => {
      const references = request.arguments.filter(
        (argument) =>
          argument.startsWith("refs/tags/") &&
          !argument.endsWith("^{}"),
      );
      if (references.length === 0) return await base.runGit(request);
      tagCalls.push(request);
      return {
        exitCode: 0,
        stdout: bytes(
          references
            .map((reference) => `${PARENT}\t${reference}\n`)
            .join(""),
        ),
      };
    };

    await withGenericGitHistoryRepository(
      {
        repositoryUrl: REMOTE,
        maximumCommits: 3,
        tagNames: tags,
      },
      async (session) => {
        expect(session.tags).toHaveLength(64);
      },
      {
        runGit,
        createTemporaryWorkspace: async () => harness.value,
      },
    );

    expect(tagCalls).toHaveLength(16);
    for (const call of tagCalls) {
      expect(
        call.arguments.filter(
          (argument) =>
            argument.startsWith("refs/tags/") &&
            !argument.endsWith("^{}"),
        ).length,
      ).toBeLessThanOrEqual(8);
      expect(
        call.arguments.reduce(
          (length, argument) => length + argument.length + 3,
          0,
        ),
      ).toBeLessThan(32_767);
    }
  });
});
