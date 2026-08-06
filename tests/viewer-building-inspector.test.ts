import { describe, expect, it } from "vitest";

import {
  canRevealMoreExecutableUnits,
  INITIAL_COMPLEXITY_HOTSPOT_VISIBLE_LIMIT,
  INITIAL_EXECUTABLE_UNIT_VISIBLE_LIMIT,
  MAXIMUM_EXECUTABLE_UNIT_VISIBLE_LIMIT,
  presentBuildingComplexity,
  presentExecutableUnits,
} from "../apps/viewer/src/building-inspector.js";
import type {
  CityBuilding,
  ExecutableUnitMetric,
} from "../packages/core/src/model.js";

function building(
  id: string,
  units: readonly ExecutableUnitMetric[] | undefined,
  metrics: Partial<CityBuilding["metrics"]> = {},
): CityBuilding {
  const maximumComplexity = (units ?? []).reduce(
    (maximum, unit) => Math.max(maximum, unit.complexity),
    0,
  );
  return {
    id,
    repositoryId: "repository",
    moduleId: "module",
    districtId: "district",
    name: `${id}.ts`,
    path: `src/${id}.ts`,
    language: "typescript",
    metrics: {
      sloc: 200,
      decisionLoad: 40,
      maximumComplexity,
      executableUnitCount: units?.length ?? 0,
      ...metrics,
    },
    ...(units === undefined
      ? {}
      : {
          metricMethod: "typescript-compiler-api-v1" as const,
          units,
        }),
    risk:
      maximumComplexity >= 21
        ? "very-high"
        : maximumComplexity >= 11
          ? "high"
          : maximumComplexity >= 6
            ? "moderate"
            : "low",
    semanticGroupId: "group",
    position: { x: 0, y: 0, z: 0 },
    size: { x: 1, y: 1, z: 1 },
  };
}

describe("viewer building inspector", () => {
  it.each([undefined, []] as const)(
    "presents missing or empty executable units as not recorded",
    (units) => {
      expect(presentExecutableUnits(units)).toBeNull();
    },
  );

  it("puts the most complex unit first, even when it appears late in the file", () => {
    const presentation = presentExecutableUnits([
      { name: "early", line: 10, complexity: 2 },
      { name: "latest", line: 300, complexity: 37 },
      { name: "middle", line: 100, complexity: 8 },
    ]);

    expect(presentation).toMatchObject({
      count: 3,
      matchingCount: 3,
      visibleCount: 3,
      hiddenCount: 0,
      maximumComplexity: 37,
      sort: "complexity",
    });
    expect(presentation?.rows.map(({ name }) => name)).toEqual([
      "latest",
      "middle",
      "early",
    ]);
  });

  it("offers deterministic source order as a secondary sort", () => {
    const presentation = presentExecutableUnits(
      [
        { name: "later", line: 30, complexity: 2 },
        { name: "<callback>", line: 10, complexity: 3 },
        { name: "<script>", line: 10, complexity: 8 },
      ],
      { sort: "source" },
    );

    expect(presentation?.rows.map(({ name }) => name)).toEqual([
      "<script>",
      "<callback>",
      "later",
    ]);
  });

  it("searches plain unit data without interpreting names as markup", () => {
    const presentation = presentExecutableUnits(
      [
        {
          name: "<script>alert('no')</script>",
          line: 1,
          complexity: 1,
        },
        { name: "canonicalObjectChildContext", line: 393, endLine: 494, complexity: 37 },
      ],
      { query: "393-494" },
    );

    expect(presentation).toMatchObject({
      count: 2,
      matchingCount: 1,
      query: "393-494",
    });
    expect(presentation?.rows[0]).toMatchObject({
      name: "canonicalObjectChildContext",
      line: 393,
      endLine: 494,
    });
    expect(
      presentExecutableUnits(
        [{ name: "<script>alert('no')</script>", line: 1, complexity: 1 }],
        { query: "<SCRIPT>" },
      )?.rows[0]?.name,
    ).toBe("<script>alert('no')</script>");
  });

  it("ranks deterministic high-complexity evidence and retains exact ranges", () => {
    const decisionEvidence = Object.freeze({
      version: "codecity.complexity-evidence/1" as const,
      unitId: "building:hotspots:unit:critical",
      scope: "callable" as const,
      callableId: "building:hotspots:callable:critical",
      status: "complete" as const,
      totalContribution: 29,
      omittedContribution: 0 as const,
      sites: Object.freeze([]),
    });
    const presentation = presentBuildingComplexity(
      building("hotspots", [
        { name: "earlyLow", line: 2, endLine: 4, complexity: 1 },
        { name: "moderate", line: 900, endLine: 920, complexity: 15 },
        { name: "critical", line: 700, endLine: 760, complexity: 30, decisionEvidence },
        { name: "high", line: 800, endLine: 850, complexity: 21 },
      ]),
    );

    expect(presentation).toMatchObject({
      state: "available",
      buildingId: "hotspots",
      executableUnitCount: 4,
      maximumComplexity: 30,
      threshold: 15,
      hotspotCount: 3,
      hiddenHotspotCount: 0,
    });
    expect(presentation.hotspots).toEqual([
      expect.objectContaining({
        name: "critical",
        complexity: 30,
        severity: "critical",
        line: 700,
        endLine: 760,
        threshold: 15,
      }),
      expect.objectContaining({
        name: "high",
        complexity: 21,
        severity: "high",
      }),
      expect.objectContaining({
        name: "moderate",
        complexity: 15,
        severity: "moderate",
      }),
    ]);
    expect(presentation.hotspots[0]?.decisionEvidence).toBe(
      decisionEvidence,
    );
  });

  it("keeps hotspots ranked while all units are independently searched and sorted", () => {
    const presentation = presentBuildingComplexity(
      building("filters", [
        { name: "firstLow", line: 1, complexity: 1 },
        { name: "lateHotspot", line: 500, complexity: 19 },
        { name: "lastLow", line: 600, complexity: 2 },
      ]),
      { query: "low", sort: "source" },
    );

    expect(presentation.state).toBe("available");
    expect(presentation.hotspots.map(({ name }) => name)).toEqual([
      "lateHotspot",
    ]);
    expect(presentation.allUnits?.rows.map(({ name }) => name)).toEqual([
      "firstLow",
      "lastLow",
    ]);
  });

  it("withholds unavailable and inconsistent unit details explicitly", () => {
    const unavailable = presentBuildingComplexity(
      building("model-only", undefined, {
        executableUnitCount: 9,
        maximumComplexity: 22,
      }),
    );
    const mismatchedCount = presentBuildingComplexity(
      building(
        "stale-count",
        [{ name: "only", line: 1, complexity: 3 }],
        { executableUnitCount: 2 },
      ),
    );
    const mismatchedMaximum = presentBuildingComplexity(
      building(
        "stale-maximum",
        [{ name: "only", line: 1, complexity: 3 }],
        { maximumComplexity: 99 },
      ),
    );

    expect(unavailable).toMatchObject({
      state: "unavailable",
      buildingId: "model-only",
      executableUnitCount: 9,
      maximumComplexity: 22,
      hotspots: [],
      allUnits: null,
    });
    expect(unavailable.state === "unavailable" && unavailable.reason).toMatch(
      /cannot be identified safely/iu,
    );
    expect(mismatchedCount.state).toBe("inconsistent");
    expect(mismatchedMaximum.state).toBe("inconsistent");
  });

  it("binds headline facts and rows to the same selected building", () => {
    const first = presentBuildingComplexity(
      building("first", [
        { name: "firstHotspot", line: 100, complexity: 18 },
      ]),
    );
    const second = presentBuildingComplexity(
      building("second", [
        { name: "secondHotspot", line: 200, complexity: 40 },
        { name: "secondLow", line: 1, complexity: 1 },
      ]),
    );

    expect(first).toMatchObject({
      buildingId: "first",
      executableUnitCount: 1,
      maximumComplexity: 18,
    });
    expect(first.hotspots.map(({ name }) => name)).toEqual([
      "firstHotspot",
    ]);
    expect(second).toMatchObject({
      buildingId: "second",
      executableUnitCount: 2,
      maximumComplexity: 40,
    });
    expect(second.hotspots.map(({ name }) => name)).toEqual([
      "secondHotspot",
    ]);
  });

  it("bounds the prominent hotspot list without changing the hotspot count", () => {
    const units = Array.from({ length: 12 }, (_, index) => ({
      name: `hotspot-${index}`,
      line: index + 1,
      complexity: 15 + index,
    }));
    const presentation = presentBuildingComplexity(
      building("many-hotspots", units),
    );

    expect(presentation.hotspots).toHaveLength(
      INITIAL_COMPLEXITY_HOTSPOT_VISIBLE_LIMIT,
    );
    expect(presentation).toMatchObject({
      hotspotCount: 12,
      hiddenHotspotCount:
        12 - INITIAL_COMPLEXITY_HOTSPOT_VISIBLE_LIMIT,
    });
    expect(presentation.hotspots[0]?.complexity).toBe(26);
  });

  it("limits the initial rows and supports deterministic progressive reveal", () => {
    const units = Array.from({ length: 27 }, (_, index) => ({
      name: `unit-${27 - index}`,
      line: 27 - index,
      complexity: (index % 7) + 1,
    }));

    const initial = presentExecutableUnits(units, { sort: "source" });
    const revealed = presentExecutableUnits(units, {
      visibleLimit: 19,
      sort: "source",
    });

    expect(initial).toMatchObject({
      count: 27,
      visibleCount: INITIAL_EXECUTABLE_UNIT_VISIBLE_LIMIT,
      hiddenCount: 17,
    });
    expect(initial && canRevealMoreExecutableUnits(initial)).toBe(true);
    expect(initial?.rows.map(({ line }) => line)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
    expect(revealed).toMatchObject({
      count: 27,
      visibleCount: 19,
      hiddenCount: 8,
    });
    expect(revealed?.rows.map(({ line }) => line)).toEqual(
      Array.from({ length: 19 }, (_, index) => index + 1),
    );
    expect(units[0]?.line).toBe(27);
  });

  it("normalizes invalid and excessive visible limits to safe bounds", () => {
    const units = Array.from(
      { length: MAXIMUM_EXECUTABLE_UNIT_VISIBLE_LIMIT + 1 },
      (_, index) => ({
        name: `unit-${index}`,
        line: index,
        complexity: 1,
      }),
    );

    expect(
      presentExecutableUnits(units, { visibleLimit: 0 })?.visibleCount,
    ).toBe(1);
    expect(
      presentExecutableUnits(units, { visibleLimit: 3.9 })?.visibleCount,
    ).toBe(3);
    expect(
      presentExecutableUnits(units, { visibleLimit: Number.NaN })
        ?.visibleCount,
    ).toBe(INITIAL_EXECUTABLE_UNIT_VISIBLE_LIMIT);
    expect(
      presentExecutableUnits(units, {
        visibleLimit: Number.POSITIVE_INFINITY,
      })?.visibleCount,
    ).toBe(INITIAL_EXECUTABLE_UNIT_VISIBLE_LIMIT);
    const capped = presentExecutableUnits(units, {
      visibleLimit: MAXIMUM_EXECUTABLE_UNIT_VISIBLE_LIMIT + 1,
    });
    expect(capped?.visibleCount).toBe(
      MAXIMUM_EXECUTABLE_UNIT_VISIBLE_LIMIT,
    );
    expect(capped?.hiddenCount).toBe(1);
    expect(capped && canRevealMoreExecutableUnits(capped)).toBe(false);
  });

  it("keeps a 10,000-unit building bounded while summarizing all units", () => {
    const units = Array.from({ length: 10_000 }, (_, index) => ({
      name: `unit-${10_000 - index}`,
      line: 10_000 - index,
      complexity: index === 0 ? 500 : 1,
    }));

    const presentation = presentExecutableUnits(units);

    expect(presentation).toMatchObject({
      count: 10_000,
      matchingCount: 10_000,
      visibleCount: INITIAL_EXECUTABLE_UNIT_VISIBLE_LIMIT,
      hiddenCount: 9_990,
      maximumComplexity: 500,
    });
    expect(presentation?.rows[0]).toMatchObject({
      line: 10_000,
      complexity: 500,
    });
  });
});
