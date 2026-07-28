import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, it } from "vitest";

import { runCli } from "../apps/cli/src/main.js";
import { createSingleChannelProfile } from "../packages/core/src/index.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "code-city-cli-"));
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

it("analyzes local roots and creates a printer-independent print plan", async () => {
  const directory = await temporaryDirectory();
  const sourceRoot = path.join(directory, "sample");
  await fs.mkdir(sourceRoot);
  await fs.writeFile(
    path.join(sourceRoot, "sample.ts"),
    "export const answer = value ?? 42;\n",
    "utf8",
  );
  const modelPath = path.join(directory, "model.json");
  const profilePath = path.join(directory, "profile.json");
  const planPath = path.join(directory, "plan.json");
  await fs.writeFile(
    profilePath,
    JSON.stringify(createSingleChannelProfile()),
    "utf8",
  );
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io = {
    stdout: (message: string) => stdout.push(message),
    stderr: (message: string) => stderr.push(message),
  };

  expect(
    await runCli(
      [
        "analyze",
        sourceRoot,
        "--output",
        modelPath,
        "--title",
        "Sample City",
        "--version",
        "1.2.3",
      ],
      io,
    ),
  ).toBe(0);
  expect(
    await runCli(
      [
        "plan",
        "--model",
        modelPath,
        "--profile",
        profilePath,
        "--format",
        "stl",
        "--output",
        planPath,
      ],
      io,
    ),
  ).toBe(0);

  const model = JSON.parse(await fs.readFile(modelPath, "utf8")) as {
    identity: { title: string; version: string };
  };
  const plan = JSON.parse(await fs.readFile(planPath, "utf8")) as {
    format: string;
    channels: unknown[];
    identity: { title: string; version: string };
  };
  expect(model.identity).toMatchObject({
    title: "Sample City",
    version: "1.2.3",
  });
  expect(plan.format).toBe("stl");
  expect(plan.channels).toHaveLength(1);
  expect(plan.identity).toEqual({
    title: "Sample City",
    version: "1.2.3",
  });
  expect(stderr).toEqual([]);
  expect(stdout.join("")).toContain("Analyzed 1 root");
  expect(stdout.join("")).toContain("Planned STL output");
});

it("returns a useful error for an unsafe logo reference", async () => {
  const directory = await temporaryDirectory();
  const messages: string[] = [];
  const code = await runCli(
    [
      "analyze",
      directory,
      "--output",
      path.join(directory, "model.json"),
      "--logo",
      path.resolve(directory, "logo.svg"),
    ],
    {
      stdout: () => undefined,
      stderr: (message) => messages.push(message),
    },
  );

  expect(code).toBe(1);
  expect(messages.join("")).toContain("Logo must be a relative");
});

it("requires an explicit title for printable identity metadata", async () => {
  const directory = await temporaryDirectory();
  const messages: string[] = [];
  const code = await runCli(
    [
      "analyze",
      directory,
      "--output",
      path.join(directory, "model.json"),
      "--version",
      "1.2.3",
    ],
    {
      stdout: () => undefined,
      stderr: (message) => messages.push(message),
    },
  );

  expect(code).toBe(1);
  expect(messages.join("")).toContain("Identity title is required");
});

it("persists analyzer warnings and prints them on stderr", async () => {
  const directory = await temporaryDirectory();
  await fs.writeFile(
    path.join(directory, "angular.json"),
    JSON.stringify({ version: 1 }),
    "utf8",
  );
  const modelPath = path.join(directory, "model.json");
  const messages: string[] = [];

  expect(
    await runCli(
      ["analyze", directory, "--output", modelPath],
      {
        stdout: () => undefined,
        stderr: (message) => messages.push(message),
      },
    ),
  ).toBe(0);

  const model = JSON.parse(await fs.readFile(modelPath, "utf8")) as {
    analysis: { warnings: string[] };
  };
  expect(model.analysis.warnings).toHaveLength(1);
  expect(model.analysis.warnings[0]).toContain("missing projects");
  expect(messages.join("")).toContain("Warning:");
  expect(messages.join("")).toContain("missing projects");
});
