import { describe, expect, it } from "vitest";

import {
  buildingFootprintArea,
  buildingHeight,
  calculateBuildingGeometry,
  classifyRisk,
  normalizeCityIdentity,
  normalizePath,
  stableId,
  stablePathId,
} from "../packages/core/src/index.js";

describe("source path normalization and stable ids", () => {
  it.each([
    ["src\\app\\.\\main.ts", "src/app/main.ts"],
    ["./src/a/../main.ts/", "src/main.ts"],
    ["C:\\repo\\src\\..\\main.cs", "C:/repo/main.cs"],
    ["/repo//src/../main.cs", "/repo/main.cs"],
    ["\\\\server\\share\\src\\..\\main.cs", "//server/share/main.cs"],
    ["", "."],
  ])("normalizes %s", (input, expected) => {
    expect(normalizePath(input)).toBe(expected);
  });

  it("does not let an absolute or UNC path escape its root", () => {
    expect(normalizePath("/../../file.ts")).toBe("/file.ts");
    expect(normalizePath("//server/share/../../file.ts")).toBe(
      "//server/share/file.ts",
    );
  });

  it("creates repeatable, unambiguous ids", () => {
    expect(stableId("Building", "ab", "c")).toBe(
      stableId("building", "ab", "c"),
    );
    expect(stableId("building", "ab", "c")).not.toBe(
      stableId("building", "a", "bc"),
    );
    expect(stablePathId("building", "repo", "a\\b\\..\\c.ts")).toBe(
      stablePathId("building", "repo", "a/c.ts"),
    );
  });
});

describe("documented metric mapping", () => {
  it.each([
    [0, "low"],
    [5, "low"],
    [6, "moderate"],
    [10, "moderate"],
    [11, "high"],
    [20, "high"],
    [21, "very-high"],
  ] as const)("classifies CC %i as %s", (complexity, expected) => {
    expect(classifyRisk(complexity)).toBe(expected);
  });

  it("uses the documented logarithmic formulas and caps", () => {
    expect(buildingFootprintArea(0)).toBe(16);
    expect(buildingFootprintArea(1_000)).toBeCloseTo(196, 12);
    expect(buildingFootprintArea(10_000)).toBeCloseTo(196, 12);
    expect(buildingHeight(0)).toBe(4);
    expect(buildingHeight(100)).toBeCloseTo(40, 12);
    expect(buildingHeight(1_000)).toBeCloseTo(40, 12);

    const geometry = calculateBuildingGeometry({
      sloc: 1_001,
      decisionLoad: 101,
    });
    expect(geometry.size.x * geometry.size.z).toBeCloseTo(196, 12);
    expect(geometry.size.y).toBeCloseTo(40, 12);
    expect(geometry.slocClamped).toBe(true);
    expect(geometry.decisionLoadClamped).toBe(true);
  });

  it("rejects invalid counts", () => {
    expect(() => classifyRisk(-1)).toThrow(/non-negative/u);
    expect(() =>
      calculateBuildingGeometry({ sloc: 1.5, decisionLoad: 0 }),
    ).toThrow(/safe integer/u);
  });
});

describe("identity metadata", () => {
  it("normalizes safe relative logo references and repository order", () => {
    expect(
      normalizeCityIdentity({
        title: " Flow ",
        version: " 1.2.3 ",
        logo: { relativePath: ".\\assets\\logo.svg", format: "svg" },
        repositories: [
          { repositoryId: "z" },
          { repositoryId: "a", title: " App " },
        ],
      }),
    ).toEqual({
      title: "Flow",
      version: "1.2.3",
      logo: { relativePath: "assets/logo.svg", format: "svg" },
      repositories: [
        { repositoryId: "a", title: "App" },
        { repositoryId: "z" },
      ],
    });
  });

  it.each([
    "C:\\private\\logo.svg",
    "/private/logo.svg",
    "../private/logo.svg",
    "https://example.test/logo.svg",
    "%2e%2e/private/logo.svg",
    "assets/.%2e/private/logo.svg",
    "assets%2flogo.svg",
    "assets/%255cprivate/logo.svg",
  ])("rejects unsafe logo reference %s", (relativePath) => {
    expect(() =>
      normalizeCityIdentity({
        title: "City",
        logo: { relativePath, format: "svg" },
      }),
    ).toThrow(/relative|asset root|traversal|encoding/u);
  });

  it("keeps non-structural percent encoding intact", () => {
    expect(
      normalizeCityIdentity({
        title: "City",
        logo: {
          relativePath: "assets/code%20city.svg",
          format: "svg",
        },
      }).logo?.relativePath,
    ).toBe("assets/code%20city.svg");
  });
});
