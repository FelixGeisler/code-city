import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import {
  runCli,
  type CliDependencies,
} from "../apps/cli/src/main.js";
import { validateCityModel } from "../packages/core/src/index.js";

const temporaryDirectories: string[] = [];
const COMMIT = "0123456789abcdef0123456789abcdef01234567";

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "code-city-github-cli-"),
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
  "analyzes one public GitHub URL and publishes only the derived model",
  { timeout: 5_000 },
  async () => {
    const directory = await temporaryDirectory();
    const output = path.join(directory, "github-city.json");
    const analyze = vi.fn<
      NonNullable<CliDependencies["analyzePublicGitHubRepository"]>
    >(async () => ({
      owner: "owner",
      repository: "repository",
      canonicalRepositoryUrl: "https://github.com/owner/repository",
      commitSha: COMMIT,
      model: await demoModel(),
    }));
    const stdout: string[] = [];
    const stderr: string[] = [];

    expect(
      await runCli(
        [
          "analyze-github",
          "https://github.com/owner/repository",
          "--ref",
          "release/v1",
          "--output",
          output,
          "--title",
          "Public City",
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
        { analyzePublicGitHubRepository: analyze },
      ),
    ).toBe(0);

    expect(analyze).toHaveBeenCalledWith(
      {
        repositoryUrl: "https://github.com/owner/repository",
        ref: "release/v1",
      },
      {
        title: "Public City",
        version: "v1",
        maxRetainedFiles: 200,
        timeoutMs: 5000,
      },
    );
    expect(
      validateCityModel(JSON.parse(await fs.readFile(output, "utf8"))),
    ).toEqual(await demoModel());
    expect(stdout.join("")).toContain(
      `https://github.com/owner/repository at ${COMMIT}`,
    );
    expect(stderr).toEqual([]);
  },
);

it(
  "leaves no output when public GitHub ingestion fails",
  { timeout: 2_000 },
  async () => {
    const directory = await temporaryDirectory();
    const output = path.join(directory, "must-not-exist.json");
    const stderr: string[] = [];
    const analyze = vi.fn<
      NonNullable<CliDependencies["analyzePublicGitHubRepository"]>
    >(async () => {
      throw new Error("Public repository could not be read.");
    });

    expect(
      await runCli(
        [
          "analyze-github",
          "https://github.com/owner/repository",
          "--output",
          output,
        ],
        {
          stdout: () => undefined,
          stderr: (message) => stderr.push(message),
        },
        { analyzePublicGitHubRepository: analyze },
      ),
    ).toBe(1);
    await expect(fs.access(output)).rejects.toThrow();
    expect(stderr.join("")).toContain(
      "Public repository could not be read.",
    );
  },
);

it(
  "keeps local analysis independent from the GitHub adapter",
  { timeout: 5_000 },
  async () => {
    const directory = await temporaryDirectory();
    await fs.writeFile(
      path.join(directory, "local.ts"),
      "export const local = true;\n",
      "utf8",
    );
    const analyzeGitHub = vi.fn<
      NonNullable<CliDependencies["analyzePublicGitHubRepository"]>
    >();
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Local analysis attempted the network."));

    expect(
      await runCli(
        [
          "analyze",
          directory,
          "--output",
          path.join(directory, "local-city.json"),
        ],
        { stdout: () => undefined, stderr: () => undefined },
        { analyzePublicGitHubRepository: analyzeGitHub },
      ),
    ).toBe(0);
    expect(analyzeGitHub).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  },
);

it(
  "documents and validates the explicit public GitHub command",
  { timeout: 1_000 },
  async () => {
    const stdout: string[] = [];
    expect(
      await runCli(["analyze-github", "--help"], {
        stdout: (message) => stdout.push(message),
        stderr: () => undefined,
      }),
    ).toBe(0);
    expect(stdout.join("")).toContain(
      "codecity analyze-github <https://github.com/owner/repository>",
    );
    expect(stdout.join("")).toContain("--ref <branch|tag|commit>");

    const analyze = vi.fn<
      NonNullable<CliDependencies["analyzePublicGitHubRepository"]>
    >();
    for (const positionals of [
      [] as string[],
      [
        "https://github.com/one/repository",
        "https://github.com/two/repository",
      ],
    ]) {
      const stderr: string[] = [];
      expect(
        await runCli(
          ["analyze-github", ...positionals, "--output", "model.json"],
          {
            stdout: () => undefined,
            stderr: (message) => stderr.push(message),
          },
          { analyzePublicGitHubRepository: analyze },
        ),
      ).toBe(1);
      expect(stderr.join("")).toContain(
        "requires exactly one public GitHub URL",
      );
    }
    expect(analyze).not.toHaveBeenCalled();
  },
);
