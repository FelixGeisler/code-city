import { promises as fs } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  createPrusaXLProfile,
  createSingleChannelProfile,
  parsePrinterProfile,
  parsePrinterProfileJson,
  PrinterProfileParseError,
} from "../packages/core/src/printer-profiles.js";
import { resolvePrinterGeometryLimits } from "../packages/core/src/print.js";

function validProfile(): {
  id: string;
  name: string;
  printChannels: Array<{
    id: string;
    label: string;
    mechanism: string;
    color?: string;
    material?: string;
  }>;
  supportedFormats: string[];
  buildVolume: { x: number; y: number; z: number };
  geometryLimits: {
    minimumWallThickness: number;
    minimumGap: number;
    minimumFeatureSize: number;
    minimumBaseThickness: number;
  };
  overflowPolicy: string;
} {
  return {
    id: "custom-two-channel",
    name: "Custom two-channel printer",
    printChannels: [
      {
        id: "primary",
        label: "Primary",
        mechanism: "single",
        color: "#123456",
        material: "PLA",
      },
      {
        id: "accent",
        label: "Accent",
        mechanism: "manual",
      },
    ],
    supportedFormats: ["3mf"],
    buildVolume: { x: 220, y: 250, z: 220 },
    geometryLimits: {
      minimumWallThickness: 0.45,
      minimumGap: 0.4,
      minimumFeatureSize: 0.8,
      minimumBaseThickness: 0.8,
    },
    overflowPolicy: "merge",
  };
}

function parseIssues(value: unknown): readonly string[] {
  try {
    parsePrinterProfile(value);
  } catch (error) {
    expect(error).toBeInstanceOf(PrinterProfileParseError);
    return (error as PrinterProfileParseError).issues;
  }
  throw new Error("Expected printer profile parsing to fail.");
}

function normalizedProfile(source: ReturnType<typeof validProfile>) {
  return {
    ...source,
    geometryLimits: resolvePrinterGeometryLimits(
      source.geometryLimits,
      source.buildVolume,
    ),
  };
}

describe("strict printer-profile parser", () => {
  it("normalizes and detaches legacy profile data", () => {
    const source = validProfile();
    const parsed = parsePrinterProfile(source);

    expect(parsed).toEqual(normalizedProfile(source));
    expect(parsed).not.toBe(source);
    expect(parsed.printChannels).not.toBe(source.printChannels);
    expect(parsed.printChannels[0]).not.toBe(source.printChannels[0]);
    expect(parsed.supportedFormats).not.toBe(source.supportedFormats);
    expect(parsed.buildVolume).not.toBe(source.buildVolume);
    expect(parsed.geometryLimits).not.toBe(source.geometryLimits);

    source.printChannels[0]!.label = "Changed";
    source.supportedFormats[0] = "stl";
    source.buildVolume.x = 1;
    source.geometryLimits.minimumGap = 9;
    expect(parsed.printChannels[0]?.label).toBe("Primary");
    expect(parsed.supportedFormats).toEqual(["3mf"]);
    expect(parsed.buildVolume.x).toBe(220);
    expect(parsed.geometryLimits.minimumGap).toBe(0.4);
  });

  it("preserves explicit geometry semantics while filling no fields implicitly", () => {
    const source = {
      ...validProfile(),
      geometryLimits: {
        ...validProfile().geometryLimits,
        nozzleDiameter: 0.4,
        lineWidth: 0.5,
        buildMargins: { x: 2, y: 3, z: 4 },
        minimumRaisedFeatureHeight: 0.6,
        minimumRecessedFeatureDepth: 0.7,
        minimumLabelStrokeWidth: 0.5,
        minimumRouteWidth: 0.9,
        maximumModelHeight: 200,
        minimumWallThickness: 0.5,
      },
    };

    expect(parsePrinterProfile(source).geometryLimits).toEqual(
      source.geometryLimits,
    );
  });

  it("rejects unsupported keys at every supported object level", () => {
    const source = {
      ...validProfile(),
      extraRoot: true,
      printChannels: [
        {
          ...validProfile().printChannels[0],
          nozzleDiameter: 0.4,
        },
      ],
      buildVolume: {
        ...validProfile().buildVolume,
        depth: 220,
      },
      geometryLimits: {
        ...validProfile().geometryLimits,
        layerHeight: 0.2,
      },
    };

    expect(parseIssues(source)).toEqual([
      "profile.extraRoot is not supported.",
      "profile.printChannels[0].nozzleDiameter is not supported.",
      "profile.buildVolume.depth is not supported.",
      "profile.geometryLimits.layerHeight is not supported.",
    ]);
  });

  it("reports structural type and missing-field errors with exact paths", () => {
    const source = {
      ...validProfile(),
      id: 42,
      printChannels: [
        null,
        {
          id: "accent",
          label: false,
          mechanism: "manual",
          color: 123,
          material: null,
        },
      ],
      supportedFormats: ["3mf", 12],
      buildVolume: { x: "220", y: 250 },
      geometryLimits: {
        minimumWallThickness: 0.45,
        minimumGap: true,
        minimumBaseThickness: 0.8,
      },
    };

    expect(parseIssues(source)).toEqual([
      "profile.id must be a string.",
      "profile.printChannels[0] must be an object.",
      "profile.printChannels[1].color must be a string when supplied.",
      "profile.printChannels[1].material must be a string when supplied.",
      "profile.printChannels[1].label must be a string.",
      "profile.supportedFormats[1] must be a string.",
      "profile.buildVolume.x must be a number.",
      "profile.buildVolume.z is required.",
      "profile.geometryLimits.minimumGap must be a number.",
      "profile.geometryLimits.minimumFeatureSize is required.",
    ]);
  });

  it("applies centralized semantic validation after structural parsing", () => {
    const source = {
      ...validProfile(),
      id: " ",
      printChannels: [
        {
          id: "same",
          label: "",
          mechanism: "laser",
          color: "red",
        },
        {
          id: "same",
          label: "Duplicate",
          mechanism: "manual",
        },
      ],
      supportedFormats: ["3mf", "3mf", "obj"],
      buildVolume: { x: 0, y: 250, z: 220 },
      geometryLimits: {
        ...validProfile().geometryLimits,
        minimumGap: -1,
      },
      overflowPolicy: "spill",
    };

    const issues = parseIssues(source);
    expect(issues).toContain("Profile id must not be empty.");
    expect(issues).toContain(
      "Print channel 'same' must have a label.",
    );
    expect(issues).toContain(
      "Unsupported channel mechanism 'laser'.",
    );
    expect(issues).toContain("Duplicate print channel 'same'.");
    expect(issues).toContain(
      "Print channel 'same' color must be a #RRGGBB or #RRGGBBAA color.",
    );
    expect(issues).toContain("Duplicate supported format '3mf'.");
    expect(issues).toContain("Unsupported print format 'obj'.");
    expect(issues).toContain("Build volume X must be positive.");
    expect(issues).toContain(
      "Geometry limit 'minimumGap' must be positive.",
    );
    expect(issues).toContain("Unsupported overflow policy 'spill'.");
  });

  it("supports generic profiles with more than five channels", () => {
    const source = {
      ...validProfile(),
      id: "generic-seven",
      printChannels: Array.from({ length: 7 }, (_, index) => ({
        id: `channel-${index + 1}`,
        label: `Channel ${index + 1}`,
        mechanism: "filament-switcher",
      })),
    };

    expect(parsePrinterProfile(source).printChannels).toHaveLength(7);
  });

  it("keeps checked-in presets identical to browser profile factories", async () => {
    const [genericText, multiText, prusaText] = await Promise.all([
      fs.readFile("profiles/generic-single-channel.json", "utf8"),
      fs.readFile("profiles/generic-multi-channel.json", "utf8"),
      fs.readFile("profiles/prusa-xl-5t.json", "utf8"),
    ]);

    expect(parsePrinterProfileJson(genericText)).toEqual(
      createSingleChannelProfile(),
    );
    const multi = parsePrinterProfileJson(multiText);
    expect(multi.id).toBe("generic-multi-channel");
    expect(multi.printChannels.map(({ id }) => id)).toEqual([
      "channel-1",
      "channel-2",
      "channel-3",
    ]);
    expect(multi.geometryLimits).toEqual(
      createSingleChannelProfile().geometryLimits,
    );
    expect(parsePrinterProfileJson(prusaText)).toEqual(
      createPrusaXLProfile([1, 2, 3, 4, 5]),
    );
  });

  it("parses JSON with the same validation and rejects invalid JSON", () => {
    expect(
      parsePrinterProfileJson(JSON.stringify(validProfile())),
    ).toEqual(normalizedProfile(validProfile()));

    expect(() => parsePrinterProfileJson("{")).toThrow(
      PrinterProfileParseError,
    );
    try {
      parsePrinterProfileJson("{");
    } catch (error) {
      expect((error as PrinterProfileParseError).issues[0]).toMatch(
        /^Printer profile JSON is invalid:/u,
      );
    }
    expect(() =>
      parsePrinterProfileJson(42 as unknown as string),
    ).toThrow("Printer profile JSON must be a string.");
  });

  it.each([null, [], "profile", 12, true])(
    "rejects a non-object root without dereferencing it (%j)",
    (value) => {
      expect(parseIssues(value)).toEqual([
        "profile must be an object.",
      ]);
    },
  );
});
