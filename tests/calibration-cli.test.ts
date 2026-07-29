import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, it } from "vitest";

import { runCli } from "../apps/cli/src/main.js";
import { createSingleChannelProfile } from "../packages/core/src/index.js";
import { generateCalibrationPrintExport } from "../packages/exporter/src/calibration.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "code-city-calibration-"),
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
  "publishes deterministic calibration 3MF and default manifest atomically",
  { timeout: 15_000 },
  async () => {
    const directory = await temporaryDirectory();
    const archives: Buffer[] = [];
    const manifests: Buffer[] = [];

    for (const suffix of ["a", "b"]) {
      const output = path.join(directory, `${suffix}.3mf`);
      const stdout: string[] = [];
      const stderr: string[] = [];
      expect(
        await runCli(
          [
            "calibrate",
            "--profile",
            path.resolve("profiles/prusa-xl-5t.json"),
            "--output",
            output,
          ],
          {
            stdout: (message) => stdout.push(message),
            stderr: (message) => stderr.push(message),
          },
        ),
      ).toBe(0);

      const manifest = path.join(directory, `${suffix}.manifest.json`);
      archives.push(await fs.readFile(output));
      manifests.push(await fs.readFile(manifest));
      expect(stderr).toEqual([]);
      expect(stdout.join("")).toContain(
        "across 5 channel(s)",
      );
      expect(stdout.join("")).toContain(output);
      expect(stdout.join("")).toContain(manifest);
    }

    expect(archives[1]).toEqual(archives[0]);
    expect(archives[0]!.subarray(0, 2).toString("ascii")).toBe("PK");
    expect(manifests[1]).toEqual(manifests[0]);
    const manifest = JSON.parse(manifests[0]!.toString("utf8")) as {
      schemaVersion: string;
      measurements: unknown[];
      channels: unknown[];
    };
    expect(manifest.schemaVersion).toBe("1.0");
    expect(manifest.measurements).toHaveLength(14);
    expect(manifest.channels).toHaveLength(5);
    if (process.platform !== "win32") {
      expect(
        (await fs.stat(path.join(directory, "a.manifest.json"))).mode &
          0o777,
      ).toBe(0o600);
    }
  },
);

it("supports an explicit manifest and rejects unsafe extensions", async () => {
  const directory = await temporaryDirectory();
  const output = path.join(directory, "calibration.3mf");
  const manifest = path.join(directory, "measurements.json");
  const messages: string[] = [];

  expect(
    await runCli(
      [
        "calibrate",
        "--profile",
        path.resolve("profiles/generic-single-channel.json"),
        "--output",
        output,
        "--manifest",
        manifest,
      ],
      {
        stdout: () => undefined,
        stderr: (message) => messages.push(message),
      },
    ),
  ).toBe(0);
  await expect(fs.access(output)).resolves.toBeUndefined();
  await expect(fs.access(manifest)).resolves.toBeUndefined();

  expect(
    await runCli(
      [
        "calibrate",
        "--profile",
        path.resolve("profiles/generic-single-channel.json"),
        "--output",
        path.join(directory, "wrong.zip"),
      ],
      {
        stdout: () => undefined,
        stderr: (message) => messages.push(message),
      },
    ),
  ).toBe(1);
  expect(messages.join("")).toContain("must use the '.3mf'");
});

it("publishes STL bytes identical to the pure calibration generator", async () => {
  const directory = await temporaryDirectory();
  const profile = createSingleChannelProfile();
  const profilePath = path.join(directory, "profile.json");
  const output = path.join(directory, "calibration.stl");
  const manifest = path.join(directory, "calibration.manifest.json");
  const stdout: string[] = [];
  const stderr: string[] = [];
  await fs.writeFile(profilePath, JSON.stringify(profile), "utf8");

  expect(
    await runCli(
      [
        "calibrate",
        "--profile",
        profilePath,
        "--format",
        "stl",
        "--output",
        output,
      ],
      {
        stdout: (message) => stdout.push(message),
        stderr: (message) => stderr.push(message),
      },
    ),
  ).toBe(0);
  const shared = generateCalibrationPrintExport({
    profile,
    format: "stl",
  });

  expect(await fs.readFile(output)).toEqual(
    Buffer.from(shared.artifact.bytes),
  );
  expect(await fs.readFile(manifest)).toEqual(
    Buffer.from(shared.manifestBytes),
  );
  expect(stdout.join("")).toContain(
    `${shared.preflight.triangleCount} triangle(s)`,
  );
  expect(stderr.join("")).toContain(
    "colors, tool assignments, and 3MF metadata are not preserved",
  );
});

it("rejects calibration format/extension mismatches", async () => {
  const directory = await temporaryDirectory();
  const messages: string[] = [];
  const profile = path.resolve("profiles/generic-single-channel.json");

  expect(
    await runCli(
      [
        "calibrate",
        "--profile",
        profile,
        "--format",
        "stl",
        "--output",
        path.join(directory, "wrong.3mf"),
      ],
      {
        stdout: () => undefined,
        stderr: (message) => messages.push(message),
      },
    ),
  ).toBe(1);
  expect(
    await runCli(
      [
        "calibrate",
        "--profile",
        profile,
        "--format",
        "3mf",
        "--output",
        path.join(directory, "wrong.stl"),
      ],
      {
        stdout: () => undefined,
        stderr: (message) => messages.push(message),
      },
    ),
  ).toBe(1);
  expect(messages.join("")).toContain(
    "STL output must use the '.stl'",
  );
  expect(messages.join("")).toContain(
    "3MF output must use the '.3mf'",
  );
});
