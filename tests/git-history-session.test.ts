import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  withGenericGitHistoryRepository,
  type GenericGitSnapshotDependencies,
  type GenericGitTemporaryWorkspace,
  type GitProcessRequest,
} from "../packages/analyzer/src/git-snapshot.js";

const TIP = "1111111111111111111111111111111111111111";
const PARENT = "2222222222222222222222222222222222222222";
const ROOT = "3333333333333333333333333333333333333333";
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
  return {
    value: {
      root,
      repositoryDirectory,
      templateDirectory,
      measureBytes: async () => 4_096,
      dispose,
    },
    dispose,
  };
}

interface FakeGitOptions {
  readonly secondTip?: string;
  readonly secondTag?: string;
  readonly changes?: Uint8Array;
  readonly history?: string;
  readonly version?: string;
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
          backend: {
            name: "git",
            version: "2.47.1.windows.2",
            renamePolicyRevision:
              "diff-tree-renames-50-myers-v1",
          },
          tags: [],
        });
        expect(session.commits).toEqual([
          {
            sha: TIP,
            parents: [PARENT],
            committedAt: "2025-01-03T00:00:00.000Z",
          },
          {
            sha: PARENT,
            parents: [ROOT],
            committedAt: "2025-01-02T00:00:00.000Z",
          },
          {
            sha: ROOT,
            parents: [],
            committedAt: "2025-01-01T00:00:00.000Z",
          },
        ]);
        expect(await session.readChanges(TIP)).toEqual([
          {
            kind: "renamed",
            previousPath: "src/old.ts",
            path: "src/new.ts",
          },
          { kind: "modified", path: "package.json" },
        ]);
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
    const diffArguments = git.calls.find(
      (request) => operationOf(request) === "diff-tree",
    )?.arguments;
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
