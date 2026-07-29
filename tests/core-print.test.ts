import { describe, expect, it } from "vitest";

import {
  assignSemanticGroups,
  DEFAULT_FDM_GEOMETRY_LIMITS,
  DEFAULT_SEMANTIC_GROUPS,
  PrintPlanValidationError,
  createPrusaXLProfile,
  createSingleChannelProfile,
  layoutCity,
  planPrint,
  validatePrinterProfile,
  type PrinterProfile,
} from "../packages/core/src/index.js";

const geometry = {
  wallThickness: 0.6,
  gap: 0.5,
  minimumFeatureSize: 1,
  baseThickness: 1,
};

describe("capability-driven printer profiles", () => {
  it("assigns semantic groups without requiring invented geometry measurements", () => {
    const profile = createPrusaXLProfile([1, 2]);
    const assignments = assignSemanticGroups(
      profile,
      [...DEFAULT_SEMANTIC_GROUPS].reverse(),
    );

    expect(assignments).toHaveLength(DEFAULT_SEMANTIC_GROUPS.length);
    expect(assignments.map(({ semanticGroupId }) => semanticGroupId)).toEqual(
      [...DEFAULT_SEMANTIC_GROUPS].map(({ id }) => id).sort(),
    );
    expect(new Set(assignments.map(({ channelId }) => channelId))).toEqual(
      new Set(["tool-1", "tool-2"]),
    );
  });

  it.each([
    [[1], ["tool-1"]],
    [[1, 5], ["tool-1", "tool-5"]],
    [[5, 3, 1, 4, 2], ["tool-1", "tool-2", "tool-3", "tool-4", "tool-5"]],
  ])("supports an XL configuration %j", (ids, expected) => {
    const profile = createPrusaXLProfile(ids);
    expect(profile.printChannels.map(({ id }) => id)).toEqual(expected);
    expect(profile.id).toBe(
      `prusa-xl-${expected.map((channel) => channel.replace("tool-", "t")).join("-")}`,
    );
    expect(profile.buildVolume).toEqual({ x: 360, y: 360, z: 360 });
    expect(validatePrinterProfile(profile)).toEqual([]);
  });

  it("keeps the XL preset hardware-accurate", () => {
    expect(() => createPrusaXLProfile([])).toThrow(/enabled tool/u);
    expect(() => createPrusaXLProfile([1, 1])).toThrow(/unique/u);
    expect(() => createPrusaXLProfile([6])).toThrow(/1 through 5/u);
  });

  it("places no global limit on generic channels", () => {
    const profile: PrinterProfile = {
      id: "generic-seven",
      name: "Generic seven-channel printer",
      printChannels: Array.from({ length: 7 }, (_, index) => ({
        id: `channel-${index + 1}`,
        label: `Channel ${index + 1}`,
        mechanism: "filament-switcher" as const,
      })),
      supportedFormats: ["3mf"],
      buildVolume: { x: 500, y: 500, z: 500 },
      geometryLimits: DEFAULT_FDM_GEOMETRY_LIMITS,
      overflowPolicy: "merge",
    };
    expect(validatePrinterProfile(profile)).toEqual([]);
    expect(
      planPrint(profile, {
        format: "3mf",
        semanticGroups: DEFAULT_SEMANTIC_GROUPS,
        bounds: { x: 100, y: 50, z: 100 },
        geometry,
      }).channels,
    ).toHaveLength(7);
  });

  it("rejects an empty channel list at runtime", () => {
    const profile: PrinterProfile = {
      ...createSingleChannelProfile(),
      printChannels: [],
    };
    expect(validatePrinterProfile(profile)).toContain(
      "At least one print channel is required.",
    );
  });

  it("rejects print-channel colors that 3MF cannot preserve", () => {
    const profile: PrinterProfile = {
      ...createSingleChannelProfile(),
      printChannels: [
        {
          ...createSingleChannelProfile().printChannels[0]!,
          color: "red",
        },
      ],
    };
    expect(validatePrinterProfile(profile)).toContain(
      "Print channel 'channel-1' color must be a #RRGGBB or #RRGGBBAA color.",
    );
  });
});

describe("deterministic print planning", () => {
  it("maps eight semantic roles onto five XL tools using merge hints", () => {
    const plan = planPrint(createPrusaXLProfile([1, 2, 3, 4, 5]), {
      format: "3mf",
      semanticGroups: [...DEFAULT_SEMANTIC_GROUPS].reverse(),
      bounds: { x: 200, y: 50, z: 200 },
      geometry,
    });
    expect(plan.assignments).toEqual([
      { semanticGroupId: "base", channelId: "tool-1" },
      {
        semanticGroupId: "external",
        channelId: "tool-1",
        mergedIntoSemanticGroupId: "base",
      },
      { semanticGroupId: "identity", channelId: "tool-2" },
      {
        semanticGroupId: "risk-high",
        channelId: "tool-4",
      },
      {
        semanticGroupId: "risk-low",
        channelId: "tool-5",
        mergedIntoSemanticGroupId: "risk-moderate",
      },
      {
        semanticGroupId: "risk-moderate",
        channelId: "tool-5",
      },
      {
        semanticGroupId: "risk-very-high",
        channelId: "tool-3",
      },
      {
        semanticGroupId: "routes",
        channelId: "tool-1",
        mergedIntoSemanticGroupId: "base",
      },
    ]);
  });

  it("emits only channel groups that are used", () => {
    const plan = planPrint(createPrusaXLProfile([1, 2, 3, 4, 5]), {
      format: "3mf",
      scale: 3,
      semanticGroups: DEFAULT_SEMANTIC_GROUPS.slice(0, 2),
      bounds: { x: 100, y: 50, z: 100 },
      geometry: { ...geometry, gap: null },
    });
    expect(plan.scale).toBe(3);
    expect(plan.labelPolicy).toBe("auto");
    expect(plan.channels.map(({ channel }) => channel.id)).toEqual([
      "tool-1",
      "tool-2",
    ]);
  });

  it("persists and validates the shared physical-label policy", () => {
    const profile = createSingleChannelProfile();
    const request = {
      format: "3mf" as const,
      semanticGroups: DEFAULT_SEMANTIC_GROUPS.slice(0, 1),
      bounds: { x: 100, y: 50, z: 100 },
      geometry,
    };

    expect(planPrint(profile, { ...request, labelPolicy: "off" }).labelPolicy)
      .toBe("off");
    expect(() =>
      planPrint(profile, {
        ...request,
        labelPolicy: "invalid" as "auto",
      }),
    ).toThrow(/Label policy/u);
  });

  it("assigns an embossed identity panel to a monochrome channel", () => {
    const layout = layoutCity({
      repositories: [],
      modules: [],
      buildings: [],
      identity: {
        title: "Code City",
        version: "1.2.3",
        logo: {
          relativePath: "assets/code-city.svg",
          format: "svg",
        },
      },
    });
    expect(layout.identityPanel).toBeDefined();
    const plan = planPrint(createSingleChannelProfile(), {
      format: "stl",
      semanticGroups: DEFAULT_SEMANTIC_GROUPS,
      bounds: layout.bounds,
      geometry,
      identity: layout.identity!,
      identityPanel: layout.identityPanel!,
    });
    expect(new Set(plan.assignments.map(({ channelId }) => channelId))).toEqual(
      new Set(["channel-1"]),
    );
    expect(plan.identityPanel).toMatchObject({
      channelId: "channel-1",
      relief: "embossed",
    });
    expect(plan.identity).toEqual({
      title: "Code City",
      version: "1.2.3",
      logo: {
        relativePath: "assets/code-city.svg",
        format: "svg",
      },
    });
  });

  it("rejects an identity panel without printable identity content", () => {
    const layout = layoutCity({
      repositories: [],
      modules: [],
      buildings: [],
      identity: { title: "Code City" },
    });
    expect(() =>
      planPrint(createSingleChannelProfile(), {
        format: "stl",
        semanticGroups: DEFAULT_SEMANTIC_GROUPS,
        bounds: layout.bounds,
        geometry,
        identityPanel: layout.identityPanel!,
      }),
    ).toThrow(/requires identity content/u);
  });

  it("validates the identity panel and relief AABB against both bounds", () => {
    const layout = layoutCity({
      repositories: [],
      modules: [],
      buildings: [],
      identity: { title: "Code City" },
    });
    const panel = layout.identityPanel!;

    expect(() =>
      planPrint(createSingleChannelProfile(), {
        format: "stl",
        semanticGroups: DEFAULT_SEMANTIC_GROUPS,
        bounds: { ...layout.bounds, x: 200 },
        geometry,
        identity: layout.identity!,
        identityPanel: {
          ...panel,
          position: { ...panel.position, x: 250 },
        },
      }),
    ).toThrow(
      /AABB exceed city bound X.*AABB exceed build volume X/u,
    );
  });

  it("is independent of semantic group input order", () => {
    const profile = createPrusaXLProfile([1, 2]);
    const request = {
      format: "3mf" as const,
      semanticGroups: DEFAULT_SEMANTIC_GROUPS,
      bounds: { x: 100, y: 50, z: 100 },
      geometry,
    };
    expect(
      planPrint(profile, {
        ...request,
        semanticGroups: [...request.semanticGroups].reverse(),
      }),
    ).toEqual(planPrint(profile, request));
  });

  it("enforces error overflow policy", () => {
    const profile: PrinterProfile = {
      ...createSingleChannelProfile(),
      overflowPolicy: "error",
    };
    expect(() =>
      planPrint(profile, {
        format: "3mf",
        semanticGroups: DEFAULT_SEMANTIC_GROUPS,
        bounds: { x: 100, y: 50, z: 100 },
        geometry,
      }),
    ).toThrow(PrintPlanValidationError);
  });

  it.each([
    {
      label: "unsupported format",
      request: {
        format: "stl" as const,
        bounds: { x: 10, y: 10, z: 10 },
        geometry,
      },
      profile: {
        ...createSingleChannelProfile(),
        supportedFormats: ["3mf" as const],
      },
    },
    {
      label: "oversized model",
      request: {
        format: "3mf" as const,
        bounds: { x: 221, y: 10, z: 10 },
        geometry,
      },
      profile: createSingleChannelProfile(),
    },
    {
      label: "unsafe wall",
      request: {
        format: "3mf" as const,
        bounds: { x: 10, y: 10, z: 10 },
        geometry: { ...geometry, wallThickness: 0.1 },
      },
      profile: createSingleChannelProfile(),
    },
  ])("rejects $label", ({ profile, request }) => {
    expect(() =>
      planPrint(profile, {
        ...request,
        semanticGroups: DEFAULT_SEMANTIC_GROUPS,
      }),
    ).toThrow(PrintPlanValidationError);
  });
});
