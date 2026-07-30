import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import {
  runCli,
  type CliDependencies,
} from "../apps/cli/src/main.js";
import {
  GENERIC_GIT_PRESECURED_CANONICAL_ANCESTRY,
  GENERIC_GIT_PRESECURED_WINDOWS_ACL,
} from "../packages/analyzer/src/index.js";
import { validateCityModel } from "../packages/core/src/index.js";

const temporaryDirectories: string[] = [];
const COMMIT = "0123456789abcdef0123456789abcdef01234567";

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "code-city-git-cli-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

async function demoModel() {
  return validateCityModel(
    JSON.parse(
      await fs.readFile(path.resolve("examples/demo-city.json"), "utf8"),
    ),
  );
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

it(
  "analyzes one generic remote and publishes only the derived model",
  { timeout: 5_000 },
  async () => {
    const directory = await temporaryDirectory();
    const output = path.join(directory, "remote-city.json");
    const analyze = vi.fn<
      NonNullable<CliDependencies["analyzeGenericGitRepository"]>
    >(async () => ({
      repository: "Repo",
      commitSha: COMMIT,
      transport: "https",
      model: await demoModel(),
    }));
    const stdout: string[] = [];
    const stderr: string[] = [];

    expect(
      await runCli(
        [
          "analyze-git",
          "https://dev.azure.example/Collection/Project/_git/Repo",
          "--ref",
          "release/v1",
          "--output",
          output,
          "--title",
          "Enterprise City",
          "--version",
          "v1",
          "--max-files",
          "200",
          "--timeout-ms",
          "5000",
        ],
        {
          stdout: (message) => stdout.push(message),
          stderr: (message) => stderr.push(message),
        },
        { analyzeGenericGitRepository: analyze },
      ),
    ).toBe(0);

    expect(analyze).toHaveBeenCalledWith(
      {
        repositoryUrl:
          "https://dev.azure.example/Collection/Project/_git/Repo",
        ref: "release/v1",
      },
      {
        title: "Enterprise City",
        version: "v1",
        maxRetainedFiles: 200,
        timeoutMs: 5000,
      },
    );
    expect(
      validateCityModel(JSON.parse(await fs.readFile(output, "utf8"))),
    ).toEqual(await demoModel());
    expect(stdout.join("")).toContain(
      `remote repository Repo at ${COMMIT}`,
    );
    expect(stdout.join("")).not.toContain("dev.azure.example");
    expect(stderr).toEqual([]);
  },
);

it(
  "leaves no output and does not echo a remote when ingestion fails",
  { timeout: 2_000 },
  async () => {
    const directory = await temporaryDirectory();
    const output = path.join(directory, "must-not-exist.json");
    const stderr: string[] = [];
    const secretRemote =
      "ssh://git@example.test/private/repository";
    const analyze = vi.fn<
      NonNullable<CliDependencies["analyzeGenericGitRepository"]>
    >(async () => {
      throw new Error("Generic Git fetch failed safely.");
    });

    expect(
      await runCli(
        [
          "analyze-git",
          secretRemote,
          "--output",
          output,
        ],
        {
          stdout: () => undefined,
          stderr: (message) => stderr.push(message),
        },
        { analyzeGenericGitRepository: analyze },
      ),
    ).toBe(1);
    await expect(fs.access(output)).rejects.toThrow();
    expect(stderr.join("")).toContain("Git fetch failed safely");
    expect(stderr.join("")).not.toContain(secretRemote);
  },
);

it(
  "forwards an explicit pre-secured Generic Git workspace parent",
  { timeout: 5_000 },
  async () => {
    const directory = await temporaryDirectory();
    const trustedParent = path.join(directory, "trusted git temp");
    await fs.mkdir(trustedParent);
    const output = path.join(directory, "remote-city.json");
    const analyze = vi.fn<
      NonNullable<CliDependencies["analyzeGenericGitRepository"]>
    >(async () => ({
      repository: "Repo",
      commitSha: COMMIT,
      transport: "https",
      model: await demoModel(),
    }));

    expect(
      await runCli(
        [
          "analyze-git",
          "https://example.test/repository",
          "--output",
          output,
          "--trusted-workspace-parent",
          path.relative(process.cwd(), trustedParent),
        ],
        { stdout: () => undefined, stderr: () => undefined },
        { analyzeGenericGitRepository: analyze },
      ),
    ).toBe(0);

    expect(analyze).toHaveBeenCalledWith(
      { repositoryUrl: "https://example.test/repository" },
      {},
      {
        temporaryWorkspaceOptions: {
          trustedPrivateParent: {
            directory: path.resolve(trustedParent),
            windowsAclProtection:
              GENERIC_GIT_PRESECURED_WINDOWS_ACL,
            canonicalAncestryProtection:
              GENERIC_GIT_PRESECURED_CANONICAL_ANCESTRY,
          },
        },
      },
    );
  },
);

it(
  "keeps local analysis independent from generic Git",
  { timeout: 5_000 },
  async () => {
    const directory = await temporaryDirectory();
    await fs.writeFile(
      path.join(directory, "local.ts"),
      "export const local = true;\n",
      "utf8",
    );
    const analyzeGit = vi.fn<
      NonNullable<CliDependencies["analyzeGenericGitRepository"]>
    >();

    expect(
      await runCli(
        [
          "analyze",
          directory,
          "--output",
          path.join(directory, "local-city.json"),
        ],
        { stdout: () => undefined, stderr: () => undefined },
        { analyzeGenericGitRepository: analyzeGit },
      ),
    ).toBe(0);
    expect(analyzeGit).not.toHaveBeenCalled();
  },
);

it(
  "documents and validates the explicit generic Git command",
  { timeout: 1_000 },
  async () => {
    const stdout: string[] = [];
    expect(
      await runCli(["analyze-git", "--help"], {
        stdout: (message) => stdout.push(message),
        stderr: () => undefined,
      }),
    ).toBe(0);
    expect(stdout.join("")).toContain(
      "codecity analyze-git <https|ssh|scp-remote>",
    );
    expect(stdout.join("")).toContain("--ref <branch|tag|commit>");
    expect(stdout.join("")).toContain(
      "--trusted-workspace-parent <directory>",
    );
    expect(stdout.join("")).toContain(
      "Parent/child ACLs protect content",
    );
    expect(stdout.join("")).toContain(
      "ancestry protects path entries",
    );

    const analyze = vi.fn<
      NonNullable<CliDependencies["analyzeGenericGitRepository"]>
    >();
    for (const positionals of [
      [] as string[],
      ["https://one.example/repo", "ssh://two.example/repo"],
    ]) {
      const stderr: string[] = [];
      expect(
        await runCli(
          ["analyze-git", ...positionals, "--output", "model.json"],
          {
            stdout: () => undefined,
            stderr: (message) => stderr.push(message),
          },
          { analyzeGenericGitRepository: analyze },
        ),
      ).toBe(1);
      expect(stderr.join("")).toContain(
        "requires exactly one Git remote",
      );
    }
    expect(analyze).not.toHaveBeenCalled();
  },
);
