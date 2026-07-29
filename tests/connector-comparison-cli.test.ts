import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, it } from "vitest";

import { runCli } from "../apps/cli/src/main.js";

const temporaryDirectories: string[] = [];
const EXPORT_TEST_TIMEOUT_MS = 15_000;

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "code-city-connectors-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

it(
  "writes deterministic connector comparison 3MF and instructions",
  async () => {
    const directory = await temporaryDirectory();
    const archives: Buffer[] = [];
    const instructions: Buffer[] = [];

    for (const suffix of ["a", "b"]) {
      const output = path.join(directory, `${suffix}.3mf`);
      const instructionPath = path.join(directory, `${suffix}.txt`);
      const stdout: string[] = [];
      const stderr: string[] = [];

      expect(
        await runCli(
          [
            "compare-connectors",
            "--profile",
            path.resolve("profiles/prusa-xl-5t.json"),
            "--output",
            output,
            "--instructions",
            instructionPath,
          ],
          {
            stdout: (message) => stdout.push(message),
            stderr: (message) => stderr.push(message),
          },
        ),
      ).toBe(0);
      archives.push(await fs.readFile(output));
      instructions.push(await fs.readFile(instructionPath));
      expect(stderr).toEqual([]);
      expect(stdout.join("")).toContain(
        "Decision: integrated-raised-trace",
      );
      expect(stdout.join("")).toContain("69.2 × 13.6 × 4 mm");
      expect(stdout.join("")).toContain(output);
      expect(stdout.join("")).toContain(instructionPath);
    }

    expect(archives[1]).toEqual(archives[0]);
    expect(archives[0]!.subarray(0, 2).toString("ascii")).toBe("PK");
    expect(instructions[1]).toEqual(instructions[0]);
    expect(instructions[0]!.toString("utf8")).toContain(
      "integrated-raised-trace",
    );
    expect(instructions[0]!.toString("utf8").endsWith("\n")).toBe(true);
  },
  EXPORT_TEST_TIMEOUT_MS,
);

it("uses a companion instruction path and rejects wrong extensions", async () => {
  const directory = await temporaryDirectory();
  const output = path.join(directory, "comparison.3mf");
  const messages: string[] = [];

  expect(
    await runCli(
      [
        "compare-connectors",
        "--profile",
        path.resolve("profiles/generic-single-channel.json"),
        "--output",
        output,
      ],
      {
        stdout: () => undefined,
        stderr: (message) => messages.push(message),
      },
    ),
  ).toBe(0);
  await expect(
    fs.access(path.join(directory, "comparison.instructions.txt")),
  ).resolves.toBeUndefined();

  expect(
    await runCli(
      [
        "compare-connectors",
        "--profile",
        path.resolve("profiles/generic-single-channel.json"),
        "--output",
        path.join(directory, "comparison.zip"),
      ],
      {
        stdout: () => undefined,
        stderr: (message) => messages.push(message),
      },
    ),
  ).toBe(1);
  expect(messages.join("")).toContain("must use the '.3mf'");
});
