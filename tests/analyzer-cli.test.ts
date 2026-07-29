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
  const planExitCode = await runCli(
    [
      "plan",
      "--model",
      modelPath,
      "--profile",
      profilePath,
      "--format",
      "stl",
      "--scale",
      "2",
      "--routes",
      "auto",
      "--output",
      planPath,
    ],
    io,
  );
  expect(planExitCode, stderr.join("")).toBe(0);

  const model = JSON.parse(await fs.readFile(modelPath, "utf8")) as {
    identity: { title: string; version: string };
  };
  const plan = JSON.parse(await fs.readFile(planPath, "utf8")) as {
    format: string;
    scale: number;
    routePolicy: string;
    channels: unknown[];
    identity: { title: string; version: string };
    identityPanel: {
      channelId: string;
      reliefDepth: number;
      position: { z: number };
      size: { z: number };
    };
  };
  expect(model.identity).toMatchObject({
    title: "Sample City",
    version: "1.2.3",
  });
  expect(plan.format).toBe("stl");
  expect(plan.scale).toBe(2);
  expect(plan.routePolicy).toBe("auto");
  expect(plan.channels).toHaveLength(1);
  expect(plan.identity).toEqual({
    title: "Sample City",
    version: "1.2.3",
  });
  expect(plan.identityPanel.channelId).toBe("channel-1");
  expect(plan.identityPanel.reliefDepth).toBeGreaterThanOrEqual(0.8);
  expect(
    plan.identityPanel.position.z -
      plan.identityPanel.size.z / 2 -
      plan.identityPanel.reliefDepth,
  ).toBeCloseTo(0, 10);
  expect(stderr).toEqual([]);
  expect(stdout.join("")).toContain("Analyzed 1 root");
  expect(stdout.join("")).toContain("Planned STL output");
  expect(stdout.join("")).toContain(
    "Routes: 0 of 0 aggregated bundle(s) printed",
  );
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

it(
  "accepts explicit bounded-analysis limits",
  { timeout: 5_000 },
  async () => {
    const directory = await temporaryDirectory();
    await fs.writeFile(
      path.join(directory, "bounded.ts"),
      "export const bounded = true;\n",
      "utf8",
    );
    const modelPath = path.join(directory, "model.json");
    const messages: string[] = [];

    expect(
      await runCli(
        [
          "analyze",
          directory,
          "--output",
          modelPath,
          "--max-files",
          "10",
          "--max-file-bytes",
          "1024",
          "--max-total-bytes",
          "4096",
          "--timeout-ms",
          "5000",
        ],
        {
          stdout: () => undefined,
          stderr: (message) => messages.push(message),
        },
      ),
    ).toBe(0);

    const model = JSON.parse(await fs.readFile(modelPath, "utf8")) as {
      buildings: unknown[];
    };
    expect(model.buildings).toHaveLength(1);
    expect(messages).toEqual([]);
  },
);

it(
  "rejects non-positive or unsafe bounded-analysis limits",
  { timeout: 2_000 },
  async () => {
    const directory = await temporaryDirectory();
    const invalidLimits = [
      ["--max-files", "0"],
      ["--max-file-bytes", "-1"],
      ["--max-total-bytes", "1.5"],
      ["--timeout-ms", "9007199254740992"],
    ] as const;

    for (const [flag, value] of invalidLimits) {
      const messages: string[] = [];
      expect(
        await runCli(
          [
            "analyze",
            directory,
            "--output",
            path.join(directory, `${flag.slice(2)}.json`),
            flag,
            value,
          ],
          {
            stdout: () => undefined,
            stderr: (message) => messages.push(message),
          },
        ),
      ).toBe(1);
      expect(messages.join("")).toContain(
        `${flag} must be a positive safe integer.`,
      );
    }
  },
);

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

it("exports the canonical Demo as a real five-part 3MF", async () => {
  const directory = await temporaryDirectory();
  const outputPath = path.join(directory, "code-city-demo.3mf");
  const legendPath = path.join(directory, "code-city-demo.legend.json");
  const stdout: string[] = [];
  const stderr: string[] = [];

  expect(
    await runCli(
      [
        "export",
        "--model",
        path.resolve("examples/demo-city.json"),
        "--profile",
        path.resolve("profiles/prusa-xl-5t.json"),
        "--format",
        "3mf",
        "--scale",
        "3",
        "--routes",
        "auto",
        "--output",
        outputPath,
      ],
      {
        stdout: (message) => stdout.push(message),
        stderr: (message) => stderr.push(message),
      },
    ),
  ).toBe(0);

  const archive = await fs.readFile(outputPath);
  const legend = JSON.parse(await fs.readFile(legendPath, "utf8")) as {
    labelPolicy: string;
    buildings: unknown[];
  };
  expect(archive.subarray(0, 2).toString("ascii")).toBe("PK");
  expect(archive.length).toBeGreaterThan(1_000);
  expect(legend.labelPolicy).toBe("auto");
  expect(legend.buildings).toHaveLength(5);
  expect(stderr).toEqual([]);
  expect(stdout.join("")).toContain("5 aligned part(s)");
  expect(stdout.join("")).toContain(" mm.");
  expect(stdout.join("")).toContain(legendPath);
  expect(stdout.join("")).toContain("5 building and 2 district");
  expect(stdout.join("")).toMatch(
    /Routes: \d+ of \d+ aggregated bundle\(s\) printed/u,
  );
});

it("supports explicit label and companion-legend controls", async () => {
  const directory = await temporaryDirectory();
  const outputPath = path.join(directory, "without-labels.3mf");
  const stdout: string[] = [];
  const stderr: string[] = [];

  expect(
    await runCli(
      [
        "export",
        "--model",
        path.resolve("examples/demo-city.json"),
        "--profile",
        path.resolve("profiles/prusa-xl-5t.json"),
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
      {
        stdout: (message) => stdout.push(message),
        stderr: (message) => stderr.push(message),
      },
    ),
  ).toBe(0);

  expect(await fs.readFile(outputPath)).not.toHaveLength(0);
  await expect(
    fs.access(path.join(directory, "without-labels.legend.json")),
  ).rejects.toThrow();
  expect(stderr).toEqual([]);
  expect(stdout.join("")).toContain("93 × 48 × 33 mm");
  expect(stdout.join("")).toContain("Legend output disabled");
  expect(stdout.join("")).toContain("0 building and 0 district");
  expect(stdout.join("")).toContain("Routes: disabled.");
});

it("emits deterministic companion legend bytes", async () => {
  const directory = await temporaryDirectory();
  const legends: Buffer[] = [];
  for (const suffix of ["a", "b"]) {
    const outputPath = path.join(directory, `${suffix}.3mf`);
    const legendPath = path.join(directory, `${suffix}.json`);
    expect(
      await runCli(
        [
          "export",
          "--model",
          path.resolve("examples/demo-city.json"),
          "--profile",
          path.resolve("profiles/prusa-xl-5t.json"),
          "--format",
          "3mf",
          "--scale",
          "3",
          "--labels",
          "auto",
          "--legend",
          legendPath,
          "--output",
          outputPath,
        ],
        { stdout: () => undefined, stderr: () => undefined },
      ),
    ).toBe(0);
    legends.push(await fs.readFile(legendPath));
  }
  expect(legends[1]).toEqual(legends[0]);
});

it("rejects unsupported export formats and invalid scale values", async () => {
  const directory = await temporaryDirectory();
  const messages: string[] = [];
  const common = [
    "--model",
    path.resolve("examples/demo-city.json"),
    "--profile",
    path.resolve("profiles/prusa-xl-5t.json"),
    "--output",
    path.join(directory, "demo.3mf"),
  ];

  expect(
    await runCli(["export", ...common, "--format", "stl"], {
      stdout: () => undefined,
      stderr: (message) => messages.push(message),
    }),
  ).toBe(1);
  expect(
    await runCli(
      ["export", ...common, "--format", "3mf", "--scale", "0"],
      {
        stdout: () => undefined,
        stderr: (message) => messages.push(message),
      },
    ),
  ).toBe(1);
  expect(
    await runCli(
      ["export", ...common, "--format", "3mf", "--labels", "always"],
      {
        stdout: () => undefined,
        stderr: (message) => messages.push(message),
      },
    ),
  ).toBe(1);
  expect(
    await runCli(
      ["export", ...common, "--format", "3mf", "--routes", "always"],
      {
        stdout: () => undefined,
        stderr: (message) => messages.push(message),
      },
    ),
  ).toBe(1);
  expect(messages.join("")).toContain("currently supports only '3mf'");
  expect(messages.join("")).toContain("--scale must be a positive");
  expect(messages.join("")).toContain("--labels must be either");
  expect(messages.join("")).toContain("--routes must be either");
});

it("documents both dependency-route policy values", async () => {
  const stdout: string[] = [];
  expect(
    await runCli(["--help"], {
      stdout: (message) => stdout.push(message),
      stderr: () => undefined,
    }),
  ).toBe(0);
  expect(stdout.join("")).toContain("--routes <auto|off>");
  expect(stdout.join("")).toContain("default: off");
});

it(
  "documents all bounded-analysis controls and defaults",
  { timeout: 1_000 },
  async () => {
    const stdout: string[] = [];
    expect(
      await runCli(["analyze", "--help"], {
        stdout: (message) => stdout.push(message),
        stderr: () => undefined,
      }),
    ).toBe(0);
    const help = stdout.join("");
    expect(help).toContain("--max-files <count>");
    expect(help).toContain("--max-file-bytes <bytes>");
    expect(help).toContain("--max-total-bytes <bytes>");
    expect(help).toContain("--timeout-ms <ms>");
    expect(help).toContain("default: 50000");
    expect(help).toContain("default: 2097152");
    expect(help).toContain("default: 268435456");
    expect(help).toContain("default: 300000");
  },
);

it("rejects structurally incomplete export models before geometry work", async () => {
  const directory = await temporaryDirectory();
  const model = JSON.parse(
    await fs.readFile(path.resolve("examples/demo-city.json"), "utf8"),
  ) as Record<string, unknown>;
  delete model["districts"];
  const modelPath = path.join(directory, "incomplete.json");
  await fs.writeFile(modelPath, JSON.stringify(model), "utf8");
  const messages: string[] = [];

  expect(
    await runCli(
      [
        "export",
        "--model",
        modelPath,
        "--profile",
        path.resolve("profiles/prusa-xl-5t.json"),
        "--format",
        "3mf",
        "--output",
        path.join(directory, "demo.3mf"),
      ],
      {
        stdout: () => undefined,
        stderr: (message) => messages.push(message),
      },
    ),
  ).toBe(1);
  expect(messages.join("")).toContain("districts must be an array");
});
