import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";

import {
  createPrusaXLProfile,
  createSingleChannelProfile,
} from "../packages/core/src/index.js";
import {
  buildDependencyConnectorComparison,
  DEPENDENCY_CONNECTOR_DECISION,
} from "../packages/exporter/src/connector-comparison.js";
import { serializeThreeMf } from "../packages/exporter/src/three-mf.js";
import {
  signedMeshVolume,
  validatePrintableCity,
} from "../packages/exporter/src/validate.js";

describe("dependency connector comparison", () => {
  it("builds deterministic, connected, outward geometry for one channel", () => {
    const profile = createSingleChannelProfile();
    const first = buildDependencyConnectorComparison(profile);
    const second = buildDependencyConnectorComparison(profile);

    expect(second).toEqual(first);
    expect(first.decision).toBe(DEPENDENCY_CONNECTOR_DECISION);
    expect(first.instructions.endsWith("\n")).toBe(true);
    expect(first.instructions).toContain("Clearance:");
    expect(first.instructions).toContain("socket wall");
    expect(first.instructions).toContain("filament, wire");
    expect(first.printable.parts).toHaveLength(1);
    expect(validatePrintableCity(first.printable, profile)).toEqual([]);
    expect(
      first.printable.parts
        .flatMap(({ primitives }) => primitives)
        .every(({ mesh }) => signedMeshVolume(mesh) > 0),
    ).toBe(true);

    const primitives = first.printable.parts.flatMap(
      ({ primitives: items }) => items,
    );
    expect(primitives.filter(({ kind }) => kind === "base")).toHaveLength(1);
    expect(
      primitives.filter(({ kind }) => kind === "comparison-cell"),
    ).toHaveLength(2);
    expect(
      primitives.filter(({ kind }) => kind === "dependency-socket"),
    ).toHaveLength(6);
    expect(
      primitives.some(({ id }) => /loose|insert/iu.test(id)),
    ).toBe(false);
  });

  it("derives every printable dimension from restrictive profile minima", () => {
    const profile = createSingleChannelProfile({
      geometryLimits: {
        minimumWallThickness: 0.7,
        minimumGap: 1.2,
        minimumFeatureSize: 0.9,
        minimumBaseThickness: 1.1,
      },
    });
    const result = buildDependencyConnectorComparison(profile);

    expect(result.measurements).toMatchObject({
      featureSize: 0.9,
      labelFeatureSize: 1.2,
      baseThickness: 1.1,
      traceWidth: 0.9,
      traceHeight: 0.9,
      clearance: 1.2,
      socketWallThickness: 0.9,
      nominalConnectorWidth: 1.8,
      socketOpeningWidth: 4.2,
    });
    expect(result.printable.measurements.minimumGap).toBeCloseTo(1.2, 10);
    expect(validatePrintableCity(result.printable, profile)).toEqual([]);
  });

  it("aligns the five comparison roles with Prusa XL channels", () => {
    const profile = createPrusaXLProfile([1, 2, 3, 4, 5]);
    const result = buildDependencyConnectorComparison(profile);

    expect(result.printable.parts.map(({ channelId }) => channelId)).toEqual([
      "tool-1",
      "tool-2",
      "tool-3",
      "tool-4",
      "tool-5",
    ]);
    expect(validatePrintableCity(result.printable, profile)).toEqual([]);
  });

  it("clamps five semantic roles across fewer or additional channels", () => {
    const two = createPrusaXLProfile([1, 2]);
    expect(
      buildDependencyConnectorComparison(two).printable.parts.map(
        ({ channelId }) => channelId,
      ),
    ).toEqual(["tool-1", "tool-2"]);

    const seven = {
      ...createSingleChannelProfile(),
      id: "seven-channel",
      printChannels: Array.from({ length: 7 }, (_, index) => ({
        id: `channel-${index + 1}`,
        label: `Channel ${index + 1}`,
        mechanism: "filament-switcher" as const,
      })),
    };
    expect(
      buildDependencyConnectorComparison(seven).printable.parts.map(
        ({ channelId }) => channelId,
      ),
    ).toEqual([
      "channel-1",
      "channel-2",
      "channel-3",
      "channel-4",
      "channel-5",
    ]);
  });

  it("serializes a deterministic standards-based 3MF archive", () => {
    const profile = createPrusaXLProfile([1, 2, 3, 4, 5]);
    const printable = buildDependencyConnectorComparison(profile).printable;
    const first = serializeThreeMf(printable);
    const second = serializeThreeMf(printable);

    expect([...second]).toEqual([...first]);
    expect(Object.keys(unzipSync(first)).sort()).toEqual([
      "3D/3dmodel.model",
      "Metadata/Slic3r_PE_model.config",
      "[Content_Types].xml",
      "_rels/.rels",
    ]);
  });

  it("fails clearly when the comparison cannot fit the build volume", () => {
    const profile = createSingleChannelProfile({
      id: "too-small",
      buildVolume: { x: 20, y: 20, z: 20 },
    });

    expect(() => buildDependencyConnectorComparison(profile)).toThrow(
      /comparison needs .* but profile 'too-small' provides/iu,
    );
  });
});
