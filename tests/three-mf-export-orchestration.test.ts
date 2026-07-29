import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runCli } from "../apps/cli/src/main.js";
import { DEMO_MODEL } from "../apps/viewer/src/demo-model.js";
import {
  createPrusaXLProfile,
  createSingleChannelProfile,
  PrintPlanValidationError,
} from "../packages/core/src/index.js";
import {
  generateThreeMfExport,
  prepareThreeMfExport,
  PrintGeometryValidationError,
} from "../packages/exporter/src/index.js";

const demoOptions = {
  scale: 3,
  labelPolicy: "auto" as const,
  routePolicy: "auto" as const,
  includeLegend: true,
};

describe("shared browser-safe 3MF export orchestration", () => {
  it("preflights dimensions, parts, channels, and warnings", () => {
    const prepared = prepareThreeMfExport({
      model: DEMO_MODEL,
      profile: createSingleChannelProfile(),
      options: demoOptions,
    });

    expect(prepared.preflight.dimensions.x).toBeGreaterThan(0);
    expect(prepared.preflight.dimensions.y).toBeGreaterThan(0);
    expect(prepared.preflight.dimensions.z).toBeGreaterThan(0);
    expect(prepared.preflight.partCount).toBe(1);
    expect(prepared.preflight.channels).toEqual([
      expect.objectContaining({
        id: "channel-1",
        label: "Channel 1",
        partIds: ["channel:channel-1"],
      }),
    ]);
    expect(
      prepared.preflight.warnings.some((warning) =>
        /semantic groups were merged/u.test(warning),
      ),
    ).toBe(true);
    expect(prepared.preflight.legendIncluded).toBe(true);
  });

  it("is deterministic, supports a disabled legend, and never calls fetch", () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (() => {
      fetchCalls += 1;
      throw new Error("Export attempted a network request.");
    }) as typeof fetch;
    try {
      const request = {
        model: DEMO_MODEL,
        profile: createPrusaXLProfile([1, 2, 3, 4, 5]),
        options: { ...demoOptions, includeLegend: false },
      };
      const first = generateThreeMfExport(request);
      const second = generateThreeMfExport(request);

      expect(first.threeMfBytes).toEqual(second.threeMfBytes);
      expect(first.legendBytes).toBeUndefined();
      expect(first.preflight.legendIncluded).toBe(false);
      expect(fetchCalls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("reports unsupported profiles and oversized cities without auto-fitting", () => {
    expect(() =>
      prepareThreeMfExport({
        model: DEMO_MODEL,
        profile: {
          ...createSingleChannelProfile(),
          supportedFormats: ["stl"],
        },
        options: demoOptions,
      }),
    ).toThrowError(PrintPlanValidationError);

    try {
      prepareThreeMfExport({
        model: DEMO_MODEL,
        profile: createSingleChannelProfile(),
        options: { ...demoOptions, scale: 1_000 },
      });
      throw new Error("Expected oversized export to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(PrintGeometryValidationError);
      expect((error as PrintGeometryValidationError).issues).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/exceeds build volume/u),
        ]),
      );
    }
  });

  it("describes skipped-label lookup according to legend selection", () => {
    const request = {
      model: DEMO_MODEL,
      profile: createPrusaXLProfile([1, 2, 3, 4, 5]),
      options: {
        ...demoOptions,
        scale: 2,
        routePolicy: "off" as const,
        includeLegend: false,
      },
    };
    const withoutLegend = prepareThreeMfExport(request).preflight;
    const withLegend = prepareThreeMfExport({
      ...request,
      options: { ...request.options, includeLegend: true },
    }).preflight;

    expect(
      withoutLegend.labels.skippedBuildings +
        withoutLegend.labels.skippedDistricts,
    ).toBeGreaterThan(0);
    expect(withoutLegend.warnings).toContain(
      "5 physical labels were skipped; enable the companion legend for lookup.",
    );
    expect(withLegend.warnings).toContain(
      "5 physical labels were skipped; use the companion legend for lookup.",
    );
  });

  it("emits byte-identical CLI and shared-orchestrator archives", async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "code-city-browser-export-"),
    );
    const modelPath = path.join(directory, "demo.json");
    const profilePath = path.join(directory, "profile.json");
    const outputPath = path.join(directory, "demo.3mf");
    const profile = createPrusaXLProfile([1, 2, 3, 4, 5]);
    await fs.writeFile(modelPath, JSON.stringify(DEMO_MODEL), "utf8");
    await fs.writeFile(profilePath, JSON.stringify(profile), "utf8");

    const exitCode = await runCli(
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
        "auto",
        "--routes",
        "auto",
        "--legend",
        "off",
        "--output",
        outputPath,
      ],
      { stdout: () => undefined, stderr: () => undefined },
    );
    const shared = generateThreeMfExport({
      model: DEMO_MODEL,
      profile,
      options: { ...demoOptions, includeLegend: false },
    });

    expect(exitCode).toBe(0);
    expect(await fs.readFile(outputPath)).toEqual(
      Buffer.from(shared.threeMfBytes),
    );
  });
});
