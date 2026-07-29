import { promises as fs } from "node:fs";

import { strToU8, zipSync } from "fflate";
import { expect, it } from "vitest";

import {
  analyzeGenericGitRepository,
  type GenericGitRunGit,
} from "../packages/analyzer/src/index.js";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const REMOTE =
  "https://dev.azure.example/Collection/Project/_git/Repo";

function text(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function fakeGit(): GenericGitRunGit {
  return async (request) => {
    const args = [...request.arguments];
    if (args.includes("--version")) {
      return { exitCode: 0, stdout: text("git version 2.45.1\n") };
    }
    if (args.includes("ls-remote")) {
      return {
        exitCode: 0,
        stdout: text(
          `ref: refs/heads/main\tHEAD\n` +
            `${COMMIT}\tHEAD\n` +
            `${COMMIT}\trefs/heads/main\n`,
        ),
      };
    }
    if (args.includes("rev-parse")) {
      return { exitCode: 0, stdout: text(`${COMMIT}\n`) };
    }
    if (args.includes("archive")) {
      const outputOptionIndex = args.findIndex(
        (argument) => argument === "--output",
      );
      const output =
        outputOptionIndex >= 0
          ? args[outputOptionIndex + 1]
          : args
              .find((argument) => argument.startsWith("--output="))
              ?.slice("--output=".length);
      if (output === undefined) {
        throw new Error("Fake Git expected a bounded archive output path.");
      }
      await fs.writeFile(
        output,
        zipSync({
          "snapshot/src/main.ts": strToU8(
            "export function answer(value: boolean) {\n" +
              "  return value ? 42 : 0;\n" +
              "}\n",
          ),
        }),
      );
    }
    return { exitCode: 0, stdout: new Uint8Array() };
  };
}

it(
  "builds a city from a generic remote with deterministic provenance",
  { timeout: 5_000 },
  async () => {
    const result = await analyzeGenericGitRepository(
      { repositoryUrl: REMOTE },
      { timeoutMs: 5_000 },
      { runGit: fakeGit() },
    );

    expect(result).toMatchObject({
      repository: "Repo",
      commitSha: COMMIT,
      transport: "https",
    });
    expect(result.model.identity).toEqual({
      title: "Repo",
      version: COMMIT,
    });
    expect(result.model.repositories).toHaveLength(1);
    expect(result.model.buildings).toHaveLength(1);
    expect(result.model.buildings[0]).toMatchObject({
      name: "main.ts",
      path: "src/main.ts",
      language: "typescript",
    });
  },
);

it(
  "preserves explicit generic-remote city identity",
  { timeout: 5_000 },
  async () => {
    const result = await analyzeGenericGitRepository(
      { repositoryUrl: REMOTE },
      {
        title: "Release City",
        version: "2026.7",
        logo: "assets/logo.svg",
        timeoutMs: 5_000,
      },
      { runGit: fakeGit() },
    );

    expect(result.model.identity).toEqual({
      title: "Release City",
      version: "2026.7",
      logo: {
        format: "svg",
        relativePath: "assets/logo.svg",
      },
    });
  },
);
