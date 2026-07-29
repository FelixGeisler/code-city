import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GENERIC_GIT_ARCHIVE_MAX_BYTES,
  GENERIC_GIT_TEMPORARY_MAX_BYTES,
  snapshotGenericGitRepository,
  type GenericGitSnapshotDependencies,
  type GenericGitTemporaryWorkspace,
  type GitProcessRequest,
} from "../packages/analyzer/src/git-snapshot.js";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const MOVED_COMMIT = "89abcdef0123456789abcdef0123456789abcdef";
const TAG_OBJECT = "fedcba9876543210fedcba9876543210fedcba98";
const encoder = new TextEncoder();
const temporaryRoots: string[] = [];

function bytes(value: string): Uint8Array {
  return encoder.encode(value);
}

function successfulArchive(
  root = `Repo-${COMMIT}`,
): Uint8Array {
  return zipSync({
    [`${root}/src/main.ts`]: strToU8(
      "export const answer = 42;\n",
    ),
  });
}

function operationOf(request: GitProcessRequest): string {
  return (
    request.arguments.find((argument) =>
      [
        "archive",
        "fetch",
        "init",
        "ls-remote",
        "rev-parse",
      ].includes(argument),
    ) ?? ""
  );
}

function expectedHardenedArguments(
  transport: "https" | "ssh",
  hooksPath: string,
  operation: readonly string[],
): readonly string[] {
  return [
    "-c",
    "protocol.allow=never",
    "-c",
    `protocol.${transport}.allow=always`,
    "-c",
    "protocol.file.allow=never",
    "-c",
    "protocol.ext.allow=never",
    "-c",
    "credential.interactive=false",
    "-c",
    "http.followRedirects=false",
    "-c",
    "http.sslVerify=true",
    "-c",
    "core.fsmonitor=false",
    "-c",
    `core.hooksPath=${hooksPath}`,
    "-c",
    "maintenance.auto=false",
    "-c",
    "gc.auto=0",
    "-c",
    "fetch.recurseSubmodules=false",
    "-c",
    "submodule.recurse=false",
    "-c",
    "filter.lfs.required=false",
    "-c",
    "filter.lfs.smudge=",
    "-c",
    "filter.lfs.process=",
    ...operation,
  ];
}

function archiveOutputPath(
  arguments_: readonly string[],
): string | undefined {
  const joined = arguments_.find((argument) =>
    argument.startsWith("--output="),
  );
  if (joined !== undefined) return joined.slice("--output=".length);
  const index = arguments_.indexOf("--output");
  return index < 0 ? undefined : arguments_[index + 1];
}

interface WorkspaceHarness {
  readonly workspace: GenericGitTemporaryWorkspace;
  readonly dispose: ReturnType<typeof vi.fn>;
  readonly measureBytes: ReturnType<typeof vi.fn>;
}

async function workspaceHarness(
  measuredBytes = 4_096,
): Promise<WorkspaceHarness> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "code-city-fake-git-"),
  );
  temporaryRoots.push(root);
  const repositoryDirectory = path.join(root, "repository.git");
  const templateDirectory = path.join(root, "empty-template");
  await fs.mkdir(repositoryDirectory, { recursive: true });
  await fs.mkdir(templateDirectory, { recursive: true });
  const measureBytes = vi.fn(async () => measuredBytes);
  const dispose = vi.fn(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    workspace: {
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
  readonly archive?: Uint8Array;
  readonly defaultBranch?: string;
  readonly failAtOperation?: string;
  readonly refOutputs?: readonly string[];
  readonly revision?: string;
  readonly throwAtOperation?: string;
}

interface FakeGitHarness {
  readonly calls: GitProcessRequest[];
  readonly runGit: NonNullable<
    GenericGitSnapshotDependencies["runGit"]
  >;
}

function fakeGit(options: FakeGitOptions = {}): FakeGitHarness {
  const calls: GitProcessRequest[] = [];
  let refOutputIndex = 0;
  const revision = options.revision ?? COMMIT;
  const defaultBranch = options.defaultBranch ?? "main";
  const defaultHeadOutput =
    `ref: refs/heads/${defaultBranch}\tHEAD\n` +
    `${revision}\tHEAD\n`;

  const runGit: NonNullable<
    GenericGitSnapshotDependencies["runGit"]
  > = async (request) => {
    calls.push(request);
    const operation = operationOf(request);
    if (operation === options.throwAtOperation) {
      throw new Error("fake Git failure");
    }
    if (operation === options.failAtOperation) {
      return { exitCode: 1, stdout: new Uint8Array() };
    }
    if (operation === "ls-remote") {
      const branchPattern = request.arguments.find((argument) =>
        argument.startsWith("refs/heads/"),
      );
      const tagPattern = request.arguments.find(
        (argument) =>
          argument.startsWith("refs/tags/") &&
          !argument.endsWith("^{}"),
      );
      const automaticOutput =
        request.arguments.includes("HEAD")
          ? defaultHeadOutput
          : branchPattern !== undefined
            ? `${revision}\t${branchPattern}\n`
            : tagPattern !== undefined
              ? `${revision}\t${tagPattern}\n`
              : `${revision}\trefs/heads/${defaultBranch}\n`;
      const outputs = options.refOutputs ?? [automaticOutput];
      const output =
        outputs[Math.min(refOutputIndex, outputs.length - 1)] ??
        automaticOutput;
      refOutputIndex += 1;
      return { exitCode: 0, stdout: bytes(output) };
    }
    if (operation === "rev-parse") {
      return { exitCode: 0, stdout: bytes(`${revision}\n`) };
    }
    if (operation === "archive") {
      const output = archiveOutputPath(request.arguments);
      const archive = options.archive ?? successfulArchive();
      if (output !== undefined) {
        await fs.writeFile(output, archive);
      }
      return { exitCode: 0, stdout: archive };
    }
    return { exitCode: 0, stdout: new Uint8Array() };
  };

  return { calls, runGit };
}

async function successfulDependencies(
  gitOptions: FakeGitOptions = {},
  measuredBytes = 4_096,
): Promise<{
  readonly dependencies: GenericGitSnapshotDependencies;
  readonly git: FakeGitHarness;
  readonly workspace: WorkspaceHarness;
}> {
  const workspace = await workspaceHarness(measuredBytes);
  const git = fakeGit(gitOptions);
  return {
    dependencies: {
      runGit: git.runGit,
      createTemporaryWorkspace: async () => workspace.workspace,
    },
    git,
    workspace,
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      fs.rm(root, { recursive: true, force: true }),
    ),
  );
});

describe("generic Git snapshot remote validation", () => {
  it.each([
    [
      "HTTPS",
      "https://dev.azure.example/Collection/Project/_git/Repo",
      "https",
    ],
    [
      "SSH URL",
      "ssh://git@dev.azure.example/Collection/Project/_git/Repo",
      "ssh",
    ],
    [
      "scp-style SSH",
      "git@dev.azure.example:Collection/Project/_git/Repo.git",
      "ssh",
    ],
  ] as const)(
    "accepts a credential-free %s remote",
    async (_label, repositoryUrl, transport) => {
      const { dependencies, workspace } =
        await successfulDependencies();

      const result = await snapshotGenericGitRepository(
        { repositoryUrl },
        dependencies,
      );

      expect(result).toMatchObject({
        repository: "Repo",
        commitSha: COMMIT,
        transport,
        snapshot: {
          name: "Repo",
          files: [
            {
              path: "src/main.ts",
              text: "export const answer = 42;\n",
            },
          ],
        },
      });
      expect(workspace.dispose).toHaveBeenCalledOnce();
    },
  );

  it.each([
    "https://user:token@dev.azure.example/Project/_git/Repo",
    "https://user@dev.azure.example/Project/_git/Repo",
    "ssh://git:token@dev.azure.example/Project/_git/Repo",
    "ssh://-oProxyCommand/Project/_git/Repo",
    "ssh://-Ftmp/Project/_git/Repo",
    "ssh://-o@dev.azure.example/Project/_git/Repo",
    "-o@dev.azure.example:Project/_git/Repo",
    "https://dev.azure.example/Project/_git/Repo?token=secret",
    "https://dev.azure.example/Project/_git/Repo#secret",
    "git@dev.azure.example:Project/_git/Repo?token=secret",
    "https://dev.azure.example/Project/_git/Repo\u000a--upload-pack=evil",
    "https://dev.azure.example/Project/_git/Repo%E2%80%AEevil",
    "ssh://git@dev.azure.example/Project%0aevil/Repo",
    "ssh://git@dev.azure.example/Project%00evil/Repo",
    "ssh://git@dev.azure.example/Project%5cevil/Repo",
    "https://dev.azure.example/Project%0A/_git/Repo",
    "https://dev.azure.example/Project%5C/_git/Repo",
    " https://dev.azure.example/Project/_git/Repo",
    "-uhttps://dev.azure.example/Project/_git/Repo",
    "ext::sh -c evil",
    "file:///private/repository",
    "http://dev.azure.example/Project/_git/Repo",
    "git://dev.azure.example/Project/_git/Repo",
    "C:\\private\\repository",
    "../private/repository",
    "dev.azure.example/Project/_git/Repo",
  ])("rejects unsafe or unsupported remote %j before Git", async (repositoryUrl) => {
    const runGit = vi.fn<
      NonNullable<GenericGitSnapshotDependencies["runGit"]>
    >();
    const createTemporaryWorkspace = vi.fn<
      NonNullable<
        GenericGitSnapshotDependencies["createTemporaryWorkspace"]
      >
    >();

    await expect(
      snapshotGenericGitRepository(
        { repositoryUrl },
        { runGit, createTemporaryWorkspace },
      ),
    ).rejects.toThrow();
    expect(runGit).not.toHaveBeenCalled();
    expect(createTemporaryWorkspace).not.toHaveBeenCalled();
  });
});

describe("generic Git snapshot ref resolution", () => {
  it("uses the advertised default branch when no ref is supplied", async () => {
    const { dependencies, git } = await successfulDependencies({
      defaultBranch: "trunk",
    });

    const result = await snapshotGenericGitRepository(
      {
        repositoryUrl:
          "https://dev.azure.example/Collection/Project/_git/Repo",
      },
      dependencies,
    );

    expect(result.commitSha).toBe(COMMIT);
    expect(
      git.calls.filter(
        (request) => operationOf(request) === "ls-remote",
      ),
    ).not.toHaveLength(0);
  });

  it("peels an annotated tag to its commit", async () => {
    const tagOutput =
      `${TAG_OBJECT}\trefs/tags/v1.0.0\n` +
      `${COMMIT}\trefs/tags/v1.0.0^{}\n`;
    const { dependencies, git } = await successfulDependencies({
      refOutputs: [tagOutput, tagOutput],
      revision: COMMIT,
    });

    const result = await snapshotGenericGitRepository(
      {
        repositoryUrl:
          "https://dev.azure.example/Collection/Project/_git/Repo",
        ref: "v1.0.0",
      },
      dependencies,
    );

    expect(result.commitSha).toBe(COMMIT);
    const refRequests = git.calls.filter(
      (request) => operationOf(request) === "ls-remote",
    );
    expect(refRequests).toHaveLength(2);
    for (const request of refRequests) {
      expect(request.arguments).not.toContain("--refs");
      expect(request.arguments).toContain(
        "refs/tags/v1.0.0^{}",
      );
    }
    const fetch = git.calls.find(
      (request) => operationOf(request) === "fetch",
    );
    expect(fetch?.arguments).toContain(COMMIT);
    expect(fetch?.arguments).not.toContain(TAG_OBJECT);
  });

  it.each([
    ["fully qualified branch", "refs/heads/main"],
    ["fully qualified tag", "refs/tags/main"],
  ] as const)("resolves an explicit %s without argv interpretation", async (_label, ref) => {
    const output = `${COMMIT}\t${ref}\n`;
    const { dependencies, git } = await successfulDependencies({
      refOutputs: [output, output],
    });

    const result = await snapshotGenericGitRepository(
      {
        repositoryUrl:
          "https://dev.azure.example/Collection/Project/_git/Repo",
        ref,
      },
      dependencies,
    );
    expect(result.commitSha).toBe(COMMIT);
    expect(
      git.calls.some((request) =>
        request.arguments.includes(ref),
      ),
    ).toBe(true);
  });

  it("resolves a unique short branch", async () => {
    const output = `${COMMIT}\trefs/heads/main\n`;
    const { dependencies } = await successfulDependencies({
      refOutputs: [output, output],
    });

    const result = await snapshotGenericGitRepository(
      {
        repositoryUrl:
          "https://dev.azure.example/Collection/Project/_git/Repo",
        ref: "main",
      },
      dependencies,
    );

    expect(result.commitSha).toBe(COMMIT);
  });

  it("rejects a short ref that is ambiguous between a branch and tag", async () => {
    const output =
      `${COMMIT}\trefs/heads/release\n` +
      `${TAG_OBJECT}\trefs/tags/release\n` +
      `${COMMIT}\trefs/tags/release^{}\n`;
    const { dependencies, workspace } =
      await successfulDependencies({
        refOutputs: [output],
      });

    await expect(
      snapshotGenericGitRepository(
        {
          repositoryUrl:
            "https://dev.azure.example/Collection/Project/_git/Repo",
          ref: "release",
        },
        dependencies,
      ),
    ).rejects.toThrow(/ambiguous/iu);
    expect(workspace.dispose).toHaveBeenCalledOnce();
  });

  it.each([
    "",
    "-upload-pack=evil",
    "refs/heads/../secret",
    "refs/heads/two..dots",
    "refs/heads/double//slash",
    "refs/heads/trailing.",
    "refs/heads/main.lock",
    "refs/heads/main\u0000secret",
    "refs/heads/main:secret",
    "refs/heads/main secret",
    "refs/heads/main\\secret",
    "refs/heads/main*",
    "refs/heads/[main]",
    "refs/heads/main~1",
    "refs/heads/main^{}",
    `${"é".repeat(129)}`,
  ])("rejects malformed or oversized ref %j before Git", async (ref) => {
    const runGit = vi.fn<
      NonNullable<GenericGitSnapshotDependencies["runGit"]>
    >();
    const createTemporaryWorkspace = vi.fn<
      NonNullable<
        GenericGitSnapshotDependencies["createTemporaryWorkspace"]
      >
    >();

    await expect(
      snapshotGenericGitRepository(
        {
          repositoryUrl:
            "https://dev.azure.example/Collection/Project/_git/Repo",
          ref,
        },
        { runGit, createTemporaryWorkspace },
      ),
    ).rejects.toThrow();
    expect(runGit).not.toHaveBeenCalled();
    expect(createTemporaryWorkspace).not.toHaveBeenCalled();
  });

  it("accepts an advertised full 40-hex commit", async () => {
    const output =
      `${COMMIT}\tHEAD\n${COMMIT}\trefs/heads/main\n`;
    const { dependencies } = await successfulDependencies({
      refOutputs: [output, output],
    });

    const result = await snapshotGenericGitRepository(
      {
        repositoryUrl:
          "https://dev.azure.example/Collection/Project/_git/Repo",
        ref: COMMIT,
      },
      dependencies,
    );

    expect(result.commitSha).toBe(COMMIT);
  });

  it("detects a selected ref that moves during ingestion", async () => {
    const first =
      `${COMMIT}\trefs/heads/main\n`;
    const second =
      `${MOVED_COMMIT}\trefs/heads/main\n`;
    const { dependencies, git, workspace } =
      await successfulDependencies({
        refOutputs: [first, second],
      });

    await expect(
      snapshotGenericGitRepository(
        {
          repositoryUrl:
            "https://dev.azure.example/Collection/Project/_git/Repo",
          ref: "main",
        },
        dependencies,
      ),
    ).rejects.toThrow(/changed|moved/iu);
    expect(workspace.dispose).toHaveBeenCalledOnce();
    expect(
      workspace.measureBytes,
    ).toHaveBeenCalled();
    expect(
      git.calls.some(
        (request) => operationOf(request) === "archive",
      ),
    ).toBe(false);
  });
});

describe("generic Git reference response validation", () => {
  it.each([
    ["missing tab", bytes(`${COMMIT} refs/heads/main\n`)],
    [
      "invalid object id",
      bytes(`not-an-object\trefs/heads/main\n`),
    ],
    [
      "control character in ref",
      bytes(`${COMMIT}\trefs/heads/ma\u0000in\n`),
    ],
    [
      "duplicate requested ref",
      bytes(
        `${COMMIT}\trefs/heads/main\n` +
          `${MOVED_COMMIT}\trefs/heads/main\n`,
      ),
    ],
    [
      "duplicate symbolic HEAD",
      bytes(
        "ref: refs/heads/main\tHEAD\n" +
          "ref: refs/heads/trunk\tHEAD\n" +
          `${COMMIT}\tHEAD\n`,
      ),
    ],
  ] as const)("rejects %s output from ls-remote", async (_label, output) => {
    const workspace = await workspaceHarness();
    const base = fakeGit();
    const runGit: NonNullable<
      GenericGitSnapshotDependencies["runGit"]
    > = async (request) =>
      operationOf(request) === "ls-remote"
        ? { exitCode: 0, stdout: output }
        : base.runGit(request);
    const repositoryUrl =
      "https://dev.azure.example/Collection/Project/_git/Repo";
    const snapshotRequest =
      _label === "duplicate symbolic HEAD"
        ? { repositoryUrl }
        : { repositoryUrl, ref: "main" };

    await expect(
      snapshotGenericGitRepository(
        snapshotRequest,
        {
          runGit,
          createTemporaryWorkspace: async () =>
            workspace.workspace,
        },
      ),
    ).rejects.toThrow(/invalid|duplicate/iu);
    expect(workspace.dispose).toHaveBeenCalledOnce();
  });

  it("rejects invalid UTF-8 from ls-remote", async () => {
    const workspace = await workspaceHarness();
    const runGit: NonNullable<
      GenericGitSnapshotDependencies["runGit"]
    > = async () => ({
      exitCode: 0,
      stdout: new Uint8Array([0xc3, 0x28]),
    });

    await expect(
      snapshotGenericGitRepository(
        {
          repositoryUrl:
            "https://dev.azure.example/Collection/Project/_git/Repo",
        },
        {
          runGit,
          createTemporaryWorkspace: async () =>
            workspace.workspace,
        },
      ),
    ).rejects.toThrow(/invalid/iu);
    expect(workspace.dispose).toHaveBeenCalledOnce();
  });

  it("rejects stdout beyond the request cap even from an injected runner", async () => {
    const workspace = await workspaceHarness();
    const runGit: NonNullable<
      GenericGitSnapshotDependencies["runGit"]
    > = async (request) => ({
      exitCode: 0,
      stdout: new Uint8Array(
        request.maximumStdoutBytes + 1,
      ),
    });

    await expect(
      snapshotGenericGitRepository(
        {
          repositoryUrl:
            "https://dev.azure.example/Collection/Project/_git/Repo",
        },
        {
          runGit,
          createTemporaryWorkspace: async () =>
            workspace.workspace,
        },
      ),
    ).rejects.toThrow(/output|size|limit/iu);
    expect(workspace.dispose).toHaveBeenCalledOnce();
  });

  it("rejects a default HEAD row that conflicts with its advertised branch", async () => {
    const output =
      "ref: refs/heads/main\tHEAD\n" +
      `${COMMIT}\tHEAD\n` +
      `${MOVED_COMMIT}\trefs/heads/main\n`;
    const { dependencies, workspace } =
      await successfulDependencies({
        refOutputs: [output],
      });

    await expect(
      snapshotGenericGitRepository(
        {
          repositoryUrl:
            "https://dev.azure.example/Collection/Project/_git/Repo",
        },
        dependencies,
      ),
    ).rejects.toThrow(/invalid|verif/iu);
    expect(workspace.dispose).toHaveBeenCalledOnce();
  });

  it("rejects refs outside the exact branch/tag query", async () => {
    const output =
      `${COMMIT}\trefs/heads/main\n` +
      `${MOVED_COMMIT}\trefs/heads/unexpected\n`;
    const { dependencies, workspace } =
      await successfulDependencies({
        refOutputs: [output],
      });

    await expect(
      snapshotGenericGitRepository(
        {
          repositoryUrl:
            "https://dev.azure.example/Collection/Project/_git/Repo",
          ref: "main",
        },
        dependencies,
      ),
    ).rejects.toThrow(/invalid|unexpected/iu);
    expect(workspace.dispose).toHaveBeenCalledOnce();
  });
});

describe("generic Git process boundary", () => {
  it("uses shell-free bounded requests and a hardened inherited environment", async () => {
    const { dependencies, git, workspace } =
      await successfulDependencies();
    const gitExecutable =
      "C:\\Program Files\\Git\\cmd\\git.exe";
    const environment = {
      PATH: "trusted-git-path",
      HOME: "credential-helper-home",
      USERPROFILE: "credential-helper-profile",
      SSH_AUTH_SOCK: "agent-socket",
      GIT_SSL_CAINFO: "enterprise-ca.pem",
      HTTPS_PROXY: "http://enterprise-proxy.example",
      GIT_TRACE: "token-from-trace",
      GIT_TRACE2: "trace2-secret",
      GIT_TRACE2_EVENT: "trace2-event-secret",
      GIT_TRACE_CURL: "curl-secret",
      GIT_CURL_VERBOSE: "1",
      GIT_DIR: "attacker-controlled-repository",
      GIT_WORK_TREE: "attacker-controlled-worktree",
      GIT_OBJECT_DIRECTORY: "attacker-controlled-objects",
      GIT_ALTERNATE_OBJECT_DIRECTORIES:
        "attacker-controlled-alternates",
      GIT_SSH_COMMAND: "malicious ssh wrapper",
      GIT_ASKPASS: "malicious askpass",
      SSH_ASKPASS: "malicious ssh askpass",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "alias.fetch",
      GIT_CONFIG_VALUE_0: "!malicious",
    };

    await snapshotGenericGitRepository(
      {
        repositoryUrl:
          "https://dev.azure.example/Collection/Project/_git/Repo",
        timeoutMs: 10_000,
      },
      {
        ...dependencies,
        environment,
        gitExecutable,
      },
    );

    expect(git.calls.length).toBeGreaterThanOrEqual(5);
    for (const request of git.calls) {
      expect(request.executable).toBe(gitExecutable);
      expect(request.shell).toBe(false);
      expect(request.windowsHide).toBe(true);
      expect(request.cwd).toBe(workspace.workspace.root);
      expect(request.arguments).toEqual(
        expect.arrayContaining([
          "-c",
          "protocol.allow=never",
        ]),
      );
      expect(request.timeoutMs).toBeGreaterThan(0);
      expect(request.timeoutMs).toBeLessThanOrEqual(10_000);
      expect(request.maximumStdoutBytes).toBe(1024 * 1024);
      expect(request.maximumStderrBytes).toBe(64 * 1024);
      expect(request.signal).toBeInstanceOf(AbortSignal);
      expect(request.env["PATH"]).toBe("trusted-git-path");
      expect(request.env["HOME"]).toBe("credential-helper-home");
      expect(request.env["USERPROFILE"]).toBe(
        "credential-helper-profile",
      );
      expect(request.env["SSH_AUTH_SOCK"]).toBe("agent-socket");
      expect(request.env["GIT_SSL_CAINFO"]).toBe("enterprise-ca.pem");
      expect(request.env["HTTPS_PROXY"]).toBe(
        "http://enterprise-proxy.example",
      );
      expect(request.env["GIT_TERMINAL_PROMPT"]).toBe("0");
      expect(request.env["GIT_TRACE"]).toBeUndefined();
      expect(request.env["GIT_TRACE2"]).toBeUndefined();
      expect(request.env["GIT_TRACE2_EVENT"]).toBeUndefined();
      expect(request.env["GIT_TRACE_CURL"]).toBeUndefined();
      expect(request.env["GIT_CURL_VERBOSE"]).toBeUndefined();
      expect(request.env["GIT_DIR"]).toBeUndefined();
      expect(request.env["GIT_WORK_TREE"]).toBeUndefined();
      expect(request.env["GIT_OBJECT_DIRECTORY"]).toBeUndefined();
      expect(
        request.env["GIT_ALTERNATE_OBJECT_DIRECTORIES"],
      ).toBeUndefined();
      expect(request.env["GIT_SSH_COMMAND"]).toBeUndefined();
      expect(request.env["GIT_ASKPASS"]).toBeUndefined();
      expect(request.env["SSH_ASKPASS"]).toBeUndefined();
      expect(request.env["GIT_CONFIG_COUNT"]).toBeUndefined();
      expect(request.env["GIT_CONFIG_KEY_0"]).toBeUndefined();
      expect(request.env["GIT_CONFIG_VALUE_0"]).toBeUndefined();
    }

    const operations = git.calls.map(operationOf);
    expect(operations).toEqual([
      "ls-remote",
      "init",
      "fetch",
      "rev-parse",
      "ls-remote",
      "archive",
    ]);

    const remote =
      "https://dev.azure.example/Collection/Project/_git/Repo";
    const repositoryDirectory =
      workspace.workspace.repositoryDirectory;
    const archivePath = path.join(
      workspace.workspace.root,
      "snapshot.zip",
    );
    expect(git.calls.map(({ arguments: arguments_ }) => arguments_)).toEqual([
      expectedHardenedArguments(
        "https",
        workspace.workspace.templateDirectory,
        ["ls-remote", "--symref", remote, "HEAD"],
      ),
      expectedHardenedArguments(
        "https",
        workspace.workspace.templateDirectory,
        [
          "init",
          "--bare",
          `--template=${workspace.workspace.templateDirectory}`,
          repositoryDirectory,
        ],
      ),
      expectedHardenedArguments(
        "https",
        workspace.workspace.templateDirectory,
        [
          "-C",
          repositoryDirectory,
          "fetch",
          "--quiet",
          "--depth=1",
          "--no-tags",
          "--no-recurse-submodules",
          "--no-write-fetch-head",
          "--no-auto-maintenance",
          "--no-auto-gc",
          "--no-write-commit-graph",
          remote,
          COMMIT,
        ],
      ),
      expectedHardenedArguments(
        "https",
        workspace.workspace.templateDirectory,
        [
          "-C",
          repositoryDirectory,
          "rev-parse",
          "--verify",
          `${COMMIT}^{commit}`,
        ],
      ),
      expectedHardenedArguments(
        "https",
        workspace.workspace.templateDirectory,
        ["ls-remote", "--symref", remote, "HEAD"],
      ),
      expectedHardenedArguments(
        "https",
        workspace.workspace.templateDirectory,
        [
          "-C",
          repositoryDirectory,
          "archive",
          "--format=zip",
          "--prefix=snapshot/",
          `--output=${archivePath}`,
          COMMIT,
        ],
      ),
    ]);

    const init = git.calls.find(
      (request) => operationOf(request) === "init",
    );
    expect(init?.arguments).toEqual(
      expect.arrayContaining(["init", "--bare"]),
    );
    expect(
      init?.arguments.some(
        (argument) =>
          argument === "--template" ||
          argument.startsWith("--template="),
      ),
    ).toBe(true);

    const fetch = git.calls.find(
      (request) => operationOf(request) === "fetch",
    );
    expect(fetch?.arguments).toEqual(
      expect.arrayContaining([
        "fetch",
        "--depth=1",
        "--no-tags",
        "--no-recurse-submodules",
        COMMIT,
      ]),
    );

    const archive = git.calls.find(
      (request) => operationOf(request) === "archive",
    );
    expect(archive?.arguments).toEqual(
      expect.arrayContaining([
        "archive",
        "--format=zip",
        COMMIT,
      ]),
    );
    expect(
      archive?.arguments.some((argument) =>
        argument.startsWith("--prefix="),
      ),
    ).toBe(true);
    expect(archive?.arguments).not.toContain("--remote");

    const forbiddenCommands = new Set([
      "checkout",
      "clone",
      "lfs",
      "submodule",
    ]);
    for (const request of git.calls) {
      expect(
        request.arguments.some((argument) =>
          forbiddenCommands.has(argument),
        ),
      ).toBe(false);
      expect(
        request.arguments.some((argument) =>
          argument.startsWith("--upload-pack"),
        ),
      ).toBe(false);
    }
  });

  it("constructs deterministic argv in the same security-sensitive order", async () => {
    const first = await successfulDependencies();
    const second = await successfulDependencies();
    const request = {
      repositoryUrl:
        "ssh://git@dev.azure.example/Collection/Project/_git/Repo",
      ref: "main",
    } as const;

    const firstResult = await snapshotGenericGitRepository(
      request,
      first.dependencies,
    );
    const secondResult = await snapshotGenericGitRepository(
      request,
      second.dependencies,
    );

    const normalizeWorkspace = (
      value: string,
      workspace: GenericGitTemporaryWorkspace,
    ): string =>
      value
        .replaceAll(workspace.repositoryDirectory, "<repository>")
        .replaceAll(workspace.templateDirectory, "<template>")
        .replaceAll(workspace.root, "<workspace>");
    const transcript = (
      calls: readonly GitProcessRequest[],
      workspace: GenericGitTemporaryWorkspace,
    ) =>
      calls.map((call) => ({
        executable: call.executable,
        arguments: call.arguments.map((argument) =>
          normalizeWorkspace(argument, workspace),
        ),
        cwd: normalizeWorkspace(call.cwd, workspace),
        shell: call.shell,
        windowsHide: call.windowsHide,
        maximumStdoutBytes: call.maximumStdoutBytes,
        maximumStderrBytes: call.maximumStderrBytes,
      }));

    expect(secondResult).toEqual(firstResult);
    expect(
      transcript(second.git.calls, second.workspace.workspace),
    ).toEqual(
      transcript(first.git.calls, first.workspace.workspace),
    );
  });
});

describe("generic Git resource bounds and cleanup", () => {
  it("disposes any workspace created before initial ref discovery fails", async () => {
    const workspace = await workspaceHarness();
    const git = fakeGit({ failAtOperation: "ls-remote" });
    const createTemporaryWorkspace = vi.fn<
      NonNullable<
        GenericGitSnapshotDependencies["createTemporaryWorkspace"]
      >
    >(async () => workspace.workspace);

    await expect(
      snapshotGenericGitRepository(
        {
          repositoryUrl:
            "https://dev.azure.example/Collection/Project/_git/Repo",
        },
        {
          runGit: git.runGit,
          createTemporaryWorkspace,
        },
      ),
    ).rejects.toThrow();
    expect(workspace.dispose).toHaveBeenCalledTimes(
      createTemporaryWorkspace.mock.calls.length,
    );
  });

  it.each(["init", "fetch", "rev-parse", "archive"])(
    "disposes the temporary workspace when %s fails",
    async (failAtOperation) => {
      const { dependencies, workspace } =
        await successfulDependencies({ failAtOperation });

      await expect(
        snapshotGenericGitRepository(
          {
            repositoryUrl:
              "https://dev.azure.example/Collection/Project/_git/Repo",
          },
          dependencies,
        ),
      ).rejects.toThrow();
      expect(workspace.dispose).toHaveBeenCalledOnce();
      await expect(
        fs.access(workspace.workspace.root),
      ).rejects.toThrow();
    },
  );

  it("disposes the workspace and ZIP source when materialization fails", async () => {
    const { dependencies, workspace } =
      await successfulDependencies();
    const sourceDispose = vi.fn();
    const source = {
      repositoryName: "Repo",
      async *entries() {
        return;
      },
      dispose: sourceDispose,
    };
    const openZipSnapshotSource = vi.fn<
      NonNullable<
        GenericGitSnapshotDependencies["openZipSnapshotSource"]
      >
    >(() => source);
    const materializeRepositorySnapshot = vi.fn<
      NonNullable<
        GenericGitSnapshotDependencies["materializeRepositorySnapshot"]
      >
    >(async () => {
      throw new Error("fake materialization failure");
    });

    await expect(
      snapshotGenericGitRepository(
        {
          repositoryUrl:
            "https://dev.azure.example/Collection/Project/_git/Repo",
        },
        {
          ...dependencies,
          openZipSnapshotSource,
          materializeRepositorySnapshot,
        },
      ),
    ).rejects.toThrow();

    expect(openZipSnapshotSource).toHaveBeenCalledOnce();
    expect(materializeRepositorySnapshot).toHaveBeenCalledOnce();
    expect(sourceDispose).toHaveBeenCalledOnce();
    expect(workspace.dispose).toHaveBeenCalledOnce();
  });

  it("disposes the workspace if opening the archive source fails", async () => {
    const { dependencies, workspace } =
      await successfulDependencies();
    const openZipSnapshotSource = vi.fn<
      NonNullable<
        GenericGitSnapshotDependencies["openZipSnapshotSource"]
      >
    >(() => {
      throw new Error("fake ZIP open failure");
    });

    await expect(
      snapshotGenericGitRepository(
        {
          repositoryUrl:
            "https://dev.azure.example/Collection/Project/_git/Repo",
        },
        { ...dependencies, openZipSnapshotSource },
      ),
    ).rejects.toThrow();
    expect(workspace.dispose).toHaveBeenCalledOnce();
  });

  it("hands the bounded archive to the shared materializer and disposes its source", async () => {
    const archive = successfulArchive("safe-root");
    const { dependencies, workspace } =
      await successfulDependencies({ archive });
    const sourceDispose = vi.fn();
    const source = {
      repositoryName: "Repo",
      async *entries() {
        return;
      },
      dispose: sourceDispose,
    };
    const openZipSnapshotSource = vi.fn<
      NonNullable<
        GenericGitSnapshotDependencies["openZipSnapshotSource"]
      >
    >(() => source);
    const materializeRepositorySnapshot = vi.fn<
      NonNullable<
        GenericGitSnapshotDependencies["materializeRepositorySnapshot"]
      >
    >(async () => {
      await expect(
        fs.access(workspace.workspace.root),
      ).rejects.toThrow();
      return {
        name: "Repo",
        files: Object.freeze([]),
        diagnostics: Object.freeze([]),
      };
    });

    const result = await snapshotGenericGitRepository(
      {
        repositoryUrl:
          "https://dev.azure.example/Collection/Project/_git/Repo",
        snapshotOptions: {
          maxEntries: 123,
          maxFileBytes: 456,
          maxTotalBytes: 789,
        },
      },
      {
        ...dependencies,
        openZipSnapshotSource,
        materializeRepositorySnapshot,
      },
    );

    expect(result.snapshot).toEqual({
      name: "Repo",
      files: [],
      diagnostics: [],
    });
    expect(openZipSnapshotSource).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      "Repo",
      expect.objectContaining({
        maxArchiveBytes: GENERIC_GIT_ARCHIVE_MAX_BYTES,
        maxEntries: 123,
        signal: expect.any(AbortSignal),
      }),
    );
    const handedArchive =
      openZipSnapshotSource.mock.calls[0]?.[0];
    expect(handedArchive).toEqual(archive);
    expect(materializeRepositorySnapshot).toHaveBeenCalledWith(
      source,
      expect.objectContaining({
        maxEntries: 123,
        maxFileBytes: 456,
        maxTotalBytes: 789,
        signal: expect.any(AbortSignal),
      }),
    );
    expect(sourceDispose).toHaveBeenCalledOnce();
    expect(workspace.dispose).toHaveBeenCalledOnce();
  });

  it("enforces the measured temporary-workspace disk bound before materialization", async () => {
    const { dependencies, workspace } =
      await successfulDependencies({}, Number.MAX_SAFE_INTEGER);
    const materializeRepositorySnapshot = vi.fn<
      NonNullable<
        GenericGitSnapshotDependencies["materializeRepositorySnapshot"]
      >
    >();

    await expect(
      snapshotGenericGitRepository(
        {
          repositoryUrl:
            "https://dev.azure.example/Collection/Project/_git/Repo",
        },
        { ...dependencies, materializeRepositorySnapshot },
      ),
    ).rejects.toThrow(/disk|size|limit|large/iu);

    expect(workspace.measureBytes).toHaveBeenCalled();
    const [maximumBytes, signal] =
      workspace.measureBytes.mock.calls[0] ?? [];
    expect(maximumBytes).toEqual(expect.any(Number));
    expect(maximumBytes).toBe(
      GENERIC_GIT_TEMPORARY_MAX_BYTES,
    );
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(materializeRepositorySnapshot).not.toHaveBeenCalled();
    expect(workspace.dispose).toHaveBeenCalledOnce();
  });

  it("disposes the workspace when disk measurement itself fails", async () => {
    const { dependencies, workspace } =
      await successfulDependencies();
    workspace.measureBytes.mockRejectedValue(
      new Error("fake disk measurement failure"),
    );

    await expect(
      snapshotGenericGitRepository(
        {
          repositoryUrl:
            "https://dev.azure.example/Collection/Project/_git/Repo",
        },
        dependencies,
      ),
    ).rejects.toThrow();
    expect(workspace.dispose).toHaveBeenCalledOnce();
  });

  it("still disposes the workspace when ZIP source disposal fails", async () => {
    const { dependencies, workspace } =
      await successfulDependencies();
    const source = {
      repositoryName: "Repo",
      async *entries() {
        return;
      },
      dispose: vi.fn(() => {
        throw new Error("fake source disposal failure");
      }),
    };
    const openZipSnapshotSource = vi.fn<
      NonNullable<
        GenericGitSnapshotDependencies["openZipSnapshotSource"]
      >
    >(() => source);
    const materializeRepositorySnapshot = vi.fn<
      NonNullable<
        GenericGitSnapshotDependencies["materializeRepositorySnapshot"]
      >
    >(async () => ({
      name: "Repo",
      files: Object.freeze([]),
      diagnostics: Object.freeze([]),
    }));

    await expect(
      snapshotGenericGitRepository(
        {
          repositoryUrl:
            "https://dev.azure.example/Collection/Project/_git/Repo",
        },
        {
          ...dependencies,
          openZipSnapshotSource,
          materializeRepositorySnapshot,
        },
      ),
    ).rejects.toThrow();
    expect(source.dispose).toHaveBeenCalledOnce();
    expect(workspace.dispose).toHaveBeenCalledOnce();
  });

  it("cleans up after caller cancellation during a workspace command", async () => {
    const workspace = await workspaceHarness();
    const controller = new AbortController();
    const base = fakeGit();
    const runGit: NonNullable<
      GenericGitSnapshotDependencies["runGit"]
    > = async (request) => {
      if (operationOf(request) === "fetch") {
        controller.abort();
        throw new Error("fake cancelled Git process");
      }
      return base.runGit(request);
    };

    await expect(
      snapshotGenericGitRepository(
        {
          repositoryUrl:
            "https://dev.azure.example/Collection/Project/_git/Repo",
          signal: controller.signal,
        },
        {
          runGit,
          createTemporaryWorkspace: async () =>
            workspace.workspace,
        },
      ),
    ).rejects.toThrow(/cancel/iu);
    expect(workspace.dispose).toHaveBeenCalledOnce();
  });

  it(
    "disposes a workspace that resolves only after the shared deadline",
    { timeout: 1_000 },
    async () => {
      const workspace = await workspaceHarness();
      const createTemporaryWorkspace: NonNullable<
        GenericGitSnapshotDependencies["createTemporaryWorkspace"]
      > = async () =>
        new Promise((resolve) => {
          globalThis.setTimeout(
            () => resolve(workspace.workspace),
            40,
          );
        });

      await expect(
        snapshotGenericGitRepository(
          {
            repositoryUrl:
              "https://dev.azure.example/Collection/Project/_git/Repo",
            timeoutMs: 10,
          },
          {
            runGit: fakeGit().runGit,
            createTemporaryWorkspace,
          },
        ),
      ).rejects.toThrow(/deadline|time/iu);
      await new Promise((resolve) =>
        globalThis.setTimeout(resolve, 70),
      );
      expect(workspace.dispose).toHaveBeenCalledOnce();
      await expect(
        fs.access(workspace.workspace.root),
      ).rejects.toThrow();
    },
  );

  it("redacts cleanup failures without skipping the cleanup attempt", async () => {
    const { dependencies, workspace } =
      await successfulDependencies();
    const cleanupSecret = "cleanup-secret-token";
    workspace.dispose.mockRejectedValue(
      new Error(
        `${cleanupSecret} at ${workspace.workspace.root}`,
      ),
    );

    let failure: unknown;
    try {
      await snapshotGenericGitRepository(
        {
          repositoryUrl:
            "https://dev.azure.example/Collection/Project/_git/Repo",
        },
        dependencies,
      );
    } catch (error) {
      failure = error;
    }

    expect(workspace.dispose).toHaveBeenCalledTimes(2);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toContain(cleanupSecret);
    expect((failure as Error).message).not.toContain(
      workspace.workspace.root,
    );
  });
});

describe("generic Git cancellation and diagnostics", () => {
  it(
    "bounds a runner that ignores AbortSignal",
    { timeout: 1_000 },
    async () => {
      const runGit: NonNullable<
        GenericGitSnapshotDependencies["runGit"]
      > = async () => new Promise(() => undefined);
      const startedAt = Date.now();

      await expect(
        snapshotGenericGitRepository(
          {
            repositoryUrl:
              "https://dev.azure.example/Collection/Project/_git/Repo",
            timeoutMs: 25,
          },
          { runGit },
        ),
      ).rejects.toThrow(/deadline|time/iu);
      expect(Date.now() - startedAt).toBeLessThan(750);
    },
  );

  it("honors a signal already aborted before any process or workspace", async () => {
    const controller = new AbortController();
    controller.abort();
    const runGit = vi.fn<
      NonNullable<GenericGitSnapshotDependencies["runGit"]>
    >();
    const createTemporaryWorkspace = vi.fn<
      NonNullable<
        GenericGitSnapshotDependencies["createTemporaryWorkspace"]
      >
    >();

    await expect(
      snapshotGenericGitRepository(
        {
          repositoryUrl:
            "https://dev.azure.example/Collection/Project/_git/Repo",
          signal: controller.signal,
        },
        { runGit, createTemporaryWorkspace },
      ),
    ).rejects.toThrow(/cancel/iu);
    expect(runGit).not.toHaveBeenCalled();
    expect(createTemporaryWorkspace).not.toHaveBeenCalled();
  });

  it("honors an already-aborted snapshot materialization signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const runGit = vi.fn<
      NonNullable<GenericGitSnapshotDependencies["runGit"]>
    >();
    const createTemporaryWorkspace = vi.fn<
      NonNullable<
        GenericGitSnapshotDependencies["createTemporaryWorkspace"]
      >
    >();

    await expect(
      snapshotGenericGitRepository(
        {
          repositoryUrl:
            "https://dev.azure.example/Collection/Project/_git/Repo",
          snapshotOptions: { signal: controller.signal },
        },
        { runGit, createTemporaryWorkspace },
      ),
    ).rejects.toThrow(/cancel/iu);
    expect(runGit).not.toHaveBeenCalled();
    expect(createTemporaryWorkspace).not.toHaveBeenCalled();
  });

  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    2_147_483_648,
  ])("rejects invalid timeout %j before any process", async (timeoutMs) => {
    const runGit = vi.fn<
      NonNullable<GenericGitSnapshotDependencies["runGit"]>
    >();
    const createTemporaryWorkspace = vi.fn<
      NonNullable<
        GenericGitSnapshotDependencies["createTemporaryWorkspace"]
      >
    >();

    await expect(
      snapshotGenericGitRepository(
        {
          repositoryUrl:
            "https://dev.azure.example/Collection/Project/_git/Repo",
          timeoutMs,
        },
        { runGit, createTemporaryWorkspace },
      ),
    ).rejects.toThrow(/timeout|positive|deadline/iu);
    expect(runGit).not.toHaveBeenCalled();
    expect(createTemporaryWorkspace).not.toHaveBeenCalled();
  });

  it(
    "propagates caller cancellation to a pending runner",
    { timeout: 1_000 },
    async () => {
      const controller = new AbortController();
      const runGit: NonNullable<
        GenericGitSnapshotDependencies["runGit"]
      > = async (request) =>
        new Promise((_resolve, reject) => {
          request.signal.addEventListener(
            "abort",
            () => reject(new Error("fake runner observed abort")),
            { once: true },
          );
        });
      const operation = snapshotGenericGitRepository(
        {
          repositoryUrl:
            "https://dev.azure.example/Collection/Project/_git/Repo",
          signal: controller.signal,
          timeoutMs: 500,
        },
        { runGit },
      );
      controller.abort();

      await expect(operation).rejects.toThrow(/cancel/iu);
    },
  );

  it("redacts remote, ref, runner diagnostics, tokens, and temporary paths", async () => {
    const workspace = await workspaceHarness();
    const repositoryUrl =
      "ssh://git@private.example/SecretCollection/TopSecretRepo";
    const ref = "secret-release-name";
    const token = "ghp_super_secret_token";
    const advertised =
      `${COMMIT}\trefs/heads/${ref}\n`;
    const base = fakeGit({
      refOutputs: [advertised, advertised],
    });
    const runGit: NonNullable<
      GenericGitSnapshotDependencies["runGit"]
    > = async (request) => {
      if (operationOf(request) === "fetch") {
        throw new Error(
          `${repositoryUrl}\n${ref}\n${token}\n` +
            `stderr: authentication failed at ${workspace.workspace.root}`,
        );
      }
      return base.runGit(request);
    };

    let failure: unknown;
    try {
      await snapshotGenericGitRepository(
        { repositoryUrl, ref },
        {
          runGit,
          createTemporaryWorkspace: async () =>
            workspace.workspace,
        },
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message.length).toBeLessThan(1_024);
    expect(message).not.toContain(repositoryUrl);
    expect(message).not.toContain("private.example");
    expect(message).not.toContain("TopSecretRepo");
    expect(message).not.toContain(ref);
    expect(message).not.toContain(token);
    expect(message).not.toContain("authentication failed");
    expect(message).not.toContain(workspace.workspace.root);
    expect(workspace.dispose).toHaveBeenCalledOnce();
  });
});
