import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../apps/cli/src/main.js";
import { DEMO_MODEL } from "../apps/viewer/src/demo-model.js";
import {
  createPrusaXLProfile,
  createSingleChannelProfile,
  type PrintFormat,
  type PrinterProfile,
} from "../packages/core/src/index.js";
import {
  generatePrintExport,
  preparePrintPlateBundle,
  serializePreparedSinglePrintPlateExport,
  STL_INFORMATION_LOSS_WARNING,
} from "../packages/exporter/src/index.js";

const temporaryDirectories: string[] = [];
const options = {
  scale: 3,
  labelPolicy: "auto" as const,
  routePolicy: "auto" as const,
  includeLegend: true,
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

function profileCases(): readonly [
  PrintFormat,
  PrinterProfile,
  string,
  string,
][] {
  return [
    [
      "3mf",
      createPrusaXLProfile([1, 2, 3, 4, 5]),
      "model/3mf",
      ".3mf",
    ],
    [
      "stl",
      createSingleChannelProfile(),
      "model/stl",
      ".stl",
    ],
  ];
}

describe("format-neutral print export orchestration", () => {
  it.each(profileCases())(
    "returns deterministic %s artifacts for generic and Prusa profiles",
    (format, profile, mimeType, fileExtension) => {
      const request = {
        format,
        model: DEMO_MODEL,
        profile,
        options,
      };
      const first = generatePrintExport(request);
      const second = generatePrintExport(request);

      expect(second).toEqual(first);
      expect(first.artifact).toMatchObject({
        format,
        mimeType,
        fileExtension,
      });
      expect(first.artifact.bytes.byteLength).toBeGreaterThan(84);
      expect(first.preflight.format).toBe(format);
      expect(first.preflight.triangleCount).toBeGreaterThan(0);
      expect(first.preflight.legendIncluded).toBe(true);
      if (format === "stl") {
        expect(first.preflight.partCount).toBe(1);
        expect(first.preflight.warnings).toContain(
          STL_INFORMATION_LOSS_WARNING,
        );
      } else {
        expect(first.preflight.partCount).toBeGreaterThan(1);
        expect(first.preflight.warnings).not.toContain(
          STL_INFORMATION_LOSS_WARNING,
        );
      }
    },
  );

  it("collapses a five-channel Prusa XL city into one STL artifact", () => {
    const result = generatePrintExport({
      format: "stl",
      model: DEMO_MODEL,
      profile: createPrusaXLProfile([1, 2, 3, 4, 5]),
      options,
    });

    expect(result.artifact).toMatchObject({
      format: "stl",
      mimeType: "model/stl",
      fileExtension: ".stl",
    });
    expect(result.preflight.partCount).toBe(1);
    expect(result.preflight.channels).toHaveLength(5);
    expect(result.preflight.warnings).toContain(
      STL_INFORMATION_LOSS_WARNING,
    );
  });

  it.each(profileCases())(
    "publishes CLI %s bytes identical to the exact plate generator",
    async (format, profile) => {
      const directory = await fs.mkdtemp(
        path.join(os.tmpdir(), `code-city-${format}-export-`),
      );
      temporaryDirectories.push(directory);
      const modelPath = path.join(directory, "model.json");
      const profilePath = path.join(directory, "profile.json");
      const outputPath = path.join(directory, `city.${format}`);
      const legendPath = path.join(directory, "city.legend.json");
      await fs.writeFile(modelPath, JSON.stringify(DEMO_MODEL), "utf8");
      await fs.writeFile(profilePath, JSON.stringify(profile), "utf8");
      const stdout: string[] = [];
      const stderr: string[] = [];

      const exitCode = await runCli(
        [
          "export",
          "--model",
          modelPath,
          "--profile",
          profilePath,
          "--format",
          format,
          "--scale",
          "3",
          "--labels",
          "auto",
          "--routes",
          "auto",
          "--output",
          outputPath,
        ],
        {
          stdout: (message) => stdout.push(message),
          stderr: (message) => stderr.push(message),
        },
      );
      const shared = serializePreparedSinglePrintPlateExport(
        preparePrintPlateBundle({
          format,
          model: DEMO_MODEL,
          profile,
          options: { ...options, fitPolicy: "error" },
        }),
      );

      expect(exitCode).toBe(0);
      expect(await fs.readFile(outputPath)).toEqual(
        Buffer.from(shared.artifact.bytes),
      );
      expect(await fs.readFile(legendPath)).toEqual(
        Buffer.from(shared.legendBytes!),
      );
      expect(stdout.join("")).toContain(
        `Exported 1 ${format.toUpperCase()} print plate`,
      );
      for (const warning of shared.preflight.warnings) {
        expect(stderr.join("")).toContain(`Warning: ${warning}`);
      }
    },
    20_000,
  );

  it("rejects format/extension mismatches before publication", async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "code-city-extension-mismatch-"),
    );
    temporaryDirectories.push(directory);
    const messages: string[] = [];
    const common = [
      "--model",
      path.resolve("examples/demo-city.json"),
      "--profile",
      path.resolve("profiles/generic-single-channel.json"),
    ];

    expect(
      await runCli(
        [
          "export",
          ...common,
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
          "export",
          ...common,
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
    await expect(
      fs.readdir(directory),
    ).resolves.toEqual([]);
  });
});
