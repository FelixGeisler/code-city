import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  afterEach,
  describe,
  expect,
  it,
} from "vitest";
import { unzipSync } from "fflate";

import { runCli } from "../apps/cli/src/main.js";
import { DEMO_MODEL } from "../apps/viewer/src/demo-model.js";
import {
  createSingleChannelProfile,
  validateCityModel,
} from "../packages/core/src/index.js";
import {
  generatePrintPlateBundle,
  preparePrintPlateBundle,
  serializePreparedSinglePrintPlateExport,
} from "../packages/exporter/src/print-plates.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "code-city-plate-cli-"),
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

describe("print-plate CLI", () => {
  it(
    "uses the exact compact numbered plate for default direct export and plan",
    { timeout: 20_000 },
    async () => {
      const directory = await temporaryDirectory();
      const profile = createSingleChannelProfile();
      const modelPath = path.join(directory, "model.json");
      const profilePath = path.join(directory, "profile.json");
      const outputPath = path.join(directory, "city.3mf");
      const planPath = path.join(directory, "plan.json");
      await Promise.all([
        fs.writeFile(modelPath, JSON.stringify(DEMO_MODEL), "utf8"),
        fs.writeFile(profilePath, JSON.stringify(profile), "utf8"),
      ]);
      const io = { stdout: () => undefined, stderr: () => undefined };

      expect(
        await runCli(
          [
            "export",
            "--model",
            modelPath,
            "--profile",
            profilePath,
            "--format",
            "3mf",
            "--scale",
            "3",
            "--labels",
            "off",
            "--routes",
            "off",
            "--legend",
            "off",
            "--output",
            outputPath,
          ],
          io,
        ),
      ).toBe(0);
      const prepared = preparePrintPlateBundle({
        format: "3mf",
        model: DEMO_MODEL,
        profile,
        options: {
          scale: 3,
          fitPolicy: "error",
          labelPolicy: "off",
          routePolicy: "off",
          includeLegend: false,
        },
      });
      const expected =
        serializePreparedSinglePrintPlateExport(prepared);
      expect(await fs.readFile(outputPath)).toEqual(
        Buffer.from(expected.artifact.bytes),
      );
      expect(
        await fs.readFile(
          path.join(directory, "city.print-manifest.json"),
        ),
      ).toEqual(Buffer.from(expected.manifestBytes));

      expect(
        await runCli(
          [
            "plan",
            "--model",
            modelPath,
            "--profile",
            profilePath,
            "--format",
            "3mf",
            "--scale",
            "3",
            "--labels",
            "off",
            "--routes",
            "off",
            "--output",
            planPath,
          ],
          io,
        ),
      ).toBe(0);
      const plan = JSON.parse(await fs.readFile(planPath, "utf8")) as {
        readonly schemaVersion: string;
        readonly layout: { readonly fitPolicy: string };
        readonly plates: readonly {
          readonly fileName: string;
          readonly dimensions: {
            readonly width: number;
            readonly depth: number;
            readonly height: number;
          };
        }[];
      };
      expect(plan.schemaVersion).toBe("1.0");
      expect(plan.layout.fitPolicy).toBe("error");
      expect(plan.plates).toEqual([
        expect.objectContaining({
          fileName: "plate-01.3mf",
          dimensions: expected.preflight.plates[0]!.dimensions,
        }),
      ]);
    },
  );

  it(
    "keeps the safe default and publishes exact acknowledged fidelity artifacts",
    { timeout: 20_000 },
    async () => {
      const directory = await temporaryDirectory();
      const modelPath = path.join(directory, "model.json");
      const profilePath = path.join(directory, "profile.json");
      const outputPath = path.join(directory, "city.3mf");
      const manifestPath = path.join(
        directory,
        "city.print-manifest.json",
      );
      const planPath = path.join(directory, "plan.json");
      const thinDetailModel = validateCityModel({
        ...DEMO_MODEL,
        buildings: DEMO_MODEL.buildings.map((building, index) =>
          index === 0
            ? {
                ...building,
                position: { ...building.position, y: 1.25 },
                size: { ...building.size, y: 0.5 },
              }
            : building,
        ),
      });
      await Promise.all([
        fs.writeFile(modelPath, JSON.stringify(thinDetailModel), "utf8"),
        fs.writeFile(
          profilePath,
          JSON.stringify(createSingleChannelProfile()),
          "utf8",
        ),
      ]);
      const stdout: string[] = [];
      const stderr: string[] = [];
      const io = {
        stdout: (message: string) => stdout.push(message),
        stderr: (message: string) => stderr.push(message),
      };
      const common = [
        "--model",
        modelPath,
        "--profile",
        profilePath,
        "--format",
        "3mf",
        "--scale",
        "0.5",
        "--fit",
        "error",
        "--labels",
        "off",
        "--routes",
        "off",
      ];

      expect(await runCli([
        "export",
        ...common,
        "--legend",
        "off",
        "--output",
        outputPath,
      ], io)).toBe(1);
      expect(stderr.join(" ")).toContain("minimum profile-safe scale");
      await expect(fs.access(outputPath)).rejects.toThrow();
      await expect(fs.access(manifestPath)).rejects.toThrow();
      stdout.length = 0;
      stderr.length = 0;

      expect(await runCli([
        "export",
        ...common,
        "--acknowledge-below-profile-scale",
        "--legend",
        "off",
        "--output",
        outputPath,
      ], io)).toBe(0);
      const manifest = JSON.parse(
        await fs.readFile(manifestPath, "utf8"),
      ) as {
        readonly fit: {
          readonly requestedScale: number;
          readonly appliedScale: number;
          readonly minimumSafeScale: number;
          readonly belowProfileScaleAcknowledged: boolean;
          readonly featureViolations: readonly {
            readonly category: string;
            readonly resultingValue: number;
            readonly minimum: number;
          }[];
        };
      };
      expect(manifest.fit).toMatchObject({
        requestedScale: 0.5,
        appliedScale: 0.5,
        minimumSafeScale: 1.6,
        belowProfileScaleAcknowledged: true,
      });
      expect(manifest.fit.featureViolations.length).toBeGreaterThan(0);
      expect(stdout.join("")).toContain(
        "Scale: requested 0.5; applied 0.5; profile-safe 1.6; below-profile acknowledgement yes.",
      );
      expect(stderr.join("")).toContain(
        "This is a print-fidelity risk, not a printer hardware danger.",
      );
      expect(stdout.join("")).toContain(`Wrote ${path.resolve(manifestPath)}`);

      stdout.length = 0;
      stderr.length = 0;
      expect(await runCli([
        "plan",
        ...common,
        "--acknowledge-below-profile-scale",
        "--output",
        planPath,
      ], io)).toBe(0);
      const plan = JSON.parse(await fs.readFile(planPath, "utf8")) as {
        readonly layout: typeof manifest.fit;
      };
      expect(plan.layout).toMatchObject({
        requestedScale: manifest.fit.requestedScale,
        appliedScale: manifest.fit.appliedScale,
        minimumSafeScale: manifest.fit.minimumSafeScale,
        belowProfileScaleAcknowledged:
          manifest.fit.belowProfileScaleAcknowledged,
        featureViolations: manifest.fit.featureViolations,
      });
    },
  );

  it("rejects valued or duplicate acknowledgement flags before publication", async () => {
    const messages: string[] = [];
    const io = {
      stdout: () => undefined,
      stderr: (message: string) => messages.push(message),
    };

    expect(await runCli([
      "plan",
      "--acknowledge-below-profile-scale=true",
    ], io)).toBe(1);
    expect(await runCli([
      "export",
      "--acknowledge-below-profile-scale",
      "--acknowledge-below-profile-scale",
    ], io)).toBe(1);
    expect(messages.join(" ")).toContain("does not accept a value");
    expect(messages.join(" ")).toContain("may only be supplied once");
  });

  it("publishes no direct artifacts when manifest and legend paths collide", async () => {
    const directory = await temporaryDirectory();
    const modelPath = path.join(directory, "model.json");
    const profilePath = path.join(directory, "profile.json");
    const outputPath = path.join(directory, "city.3mf");
    const companionPath = path.join(
      directory,
      "city.print-manifest.json",
    );
    await Promise.all([
      fs.writeFile(modelPath, JSON.stringify(DEMO_MODEL), "utf8"),
      fs.writeFile(
        profilePath,
        JSON.stringify(createSingleChannelProfile()),
        "utf8",
      ),
    ]);
    const messages: string[] = [];

    expect(await runCli([
      "export",
      "--model",
      modelPath,
      "--profile",
      profilePath,
      "--format",
      "3mf",
      "--scale",
      "3",
      "--fit",
      "error",
      "--legend",
      companionPath,
      "--output",
      outputPath,
    ], {
      stdout: () => undefined,
      stderr: (message) => messages.push(message),
    })).toBe(1);
    expect(messages.join(" ")).toMatch(/duplicate|different paths/iu);
    await expect(fs.access(outputPath)).rejects.toThrow();
    await expect(fs.access(companionPath)).rejects.toThrow();
  });

  it(
    "publishes the exact deterministic tile bundle and a concise plate plan",
    { timeout: 20_000 },
    async () => {
      const directory = await temporaryDirectory();
      const profile = createSingleChannelProfile();
      const modelPath = path.join(directory, "model.json");
      const profilePath = path.join(directory, "profile.json");
      const outputPath = path.join(directory, "city.zip");
      const planPath = path.join(directory, "plan.json");
      await Promise.all([
        fs.writeFile(modelPath, JSON.stringify(DEMO_MODEL), "utf8"),
        fs.writeFile(profilePath, JSON.stringify(profile), "utf8"),
      ]);
      const stdout: string[] = [];
      const stderr: string[] = [];
      const io = {
        stdout: (message: string) => stdout.push(message),
        stderr: (message: string) => stderr.push(message),
      };

      expect(
        await runCli(
          [
            "export",
            "--model",
            modelPath,
            "--profile",
            profilePath,
            "--format",
            "stl",
            "--scale",
            "3",
            "--fit",
            "tile",
            "--labels",
            "off",
            "--routes",
            "auto",
            "--legend",
            "off",
            "--output",
            outputPath,
          ],
          io,
        ),
      ).toBe(0);
      const expected = generatePrintPlateBundle({
        format: "stl",
        model: DEMO_MODEL,
        profile,
        options: {
          scale: 3,
          fitPolicy: "tile",
          labelPolicy: "off",
          routePolicy: "auto",
          includeLegend: false,
        },
      });
      expect(await fs.readFile(outputPath)).toEqual(
        Buffer.from(expected.bytes),
      );
      expect(Object.keys(unzipSync(expected.bytes))).toContain(
        "manifest.json",
      );
      expect(stdout.join("")).toContain(
        `Exported ${expected.manifest.plateCount} STL print`,
      );
      expect(stdout.join("")).toContain("Plate 1: plate-01.stl");
      expect(stdout.join("")).toContain("Legend output disabled.");

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
            "--scale",
            "3",
            "--fit",
            "tile",
            "--max-plates",
            "2",
            "--labels",
            "off",
            "--routes",
            "auto",
            "--output",
            planPath,
          ],
          io,
        ),
      ).toBe(0);
      const plan = JSON.parse(await fs.readFile(planPath, "utf8")) as {
        readonly schemaVersion: string;
        readonly layout: { readonly fitPolicy: string };
        readonly plates: readonly {
          readonly number: number;
          readonly dimensions: {
            readonly x: number;
            readonly y: number;
            readonly z: number;
          };
        }[];
        readonly routeOmissions: readonly unknown[];
      };
      expect(plan.schemaVersion).toBe("1.0");
      expect(plan.layout.fitPolicy).toBe("tile");
      expect(plan.plates[0]?.number).toBe(1);
      expect(plan.routeOmissions).toBeInstanceOf(Array);
      expect(stderr.every((message) => message.startsWith("Warning: ")))
        .toBe(true);
    },
  );

  it("rejects bundle extension and plate-limit errors before publication", async () => {
    const directory = await temporaryDirectory();
    const messages: string[] = [];
    const common = [
      "--model",
      path.resolve("examples/demo-city.json"),
      "--profile",
      path.resolve("profiles/generic-single-channel.json"),
      "--format",
      "stl",
      "--fit",
      "tile",
    ];

    expect(
      await runCli(
        [
          "export",
          ...common,
          "--output",
          path.join(directory, "wrong.stl"),
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
          "--max-plates",
          "100",
          "--output",
          path.join(directory, "wrong.zip"),
        ],
        {
          stdout: () => undefined,
          stderr: (message) => messages.push(message),
        },
      ),
    ).toBe(1);

    expect(messages.join("")).toContain("must use the '.zip'");
    expect(messages.join("")).toContain(
      "--max-plates must be an integer between 1 and 99",
    );
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it("rejects --max-plates unless the fit policy is tile", async () => {
    const directory = await temporaryDirectory();
    const messages: string[] = [];
    const common = [
      "--model",
      path.resolve("examples/demo-city.json"),
      "--profile",
      path.resolve("profiles/generic-single-channel.json"),
      "--format",
      "stl",
      "--max-plates",
      "2",
    ];
    const io = {
      stdout: () => undefined,
      stderr: (message: string) => messages.push(message),
    };

    expect(
      await runCli(
        [
          "plan",
          ...common,
          "--output",
          path.join(directory, "error-plan.json"),
        ],
        io,
      ),
    ).toBe(1);
    expect(
      await runCli(
        [
          "export",
          ...common,
          "--fit",
          "scale",
          "--output",
          path.join(directory, "scale.zip"),
        ],
        io,
      ),
    ).toBe(1);

    expect(
      messages
        .join("")
        .match(/--max-plates may only be used with --fit tile/gu),
    ).toHaveLength(2);
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it("does not replace model or profile inputs with export artifacts", async () => {
    const directory = await temporaryDirectory();
    const modelPath = path.join(directory, "city.legend.json");
    const profilePath = path.join(directory, "profile.json");
    const outputPath = path.join(directory, "city.zip");
    const modelBytes = Buffer.from(JSON.stringify(DEMO_MODEL));
    await Promise.all([
      fs.writeFile(modelPath, modelBytes),
      fs.writeFile(
        profilePath,
        JSON.stringify(createSingleChannelProfile()),
        "utf8",
      ),
    ]);
    const messages: string[] = [];

    expect(
      await runCli(
        [
          "export",
          "--model",
          modelPath,
          "--profile",
          profilePath,
          "--format",
          "stl",
          "--scale",
          "3",
          "--fit",
          "tile",
          "--output",
          outputPath,
        ],
        {
          stdout: () => undefined,
          stderr: (message) => messages.push(message),
        },
      ),
    ).toBe(1);

    expect(messages.join("")).toContain("protected input");
    expect(await fs.readFile(modelPath)).toEqual(modelBytes);
    await expect(fs.access(outputPath)).rejects.toThrow();
  });
});
