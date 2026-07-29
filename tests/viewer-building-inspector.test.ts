import { describe, expect, it } from "vitest";

import {
  canRevealMoreExecutableUnits,
  INITIAL_EXECUTABLE_UNIT_VISIBLE_LIMIT,
  MAXIMUM_EXECUTABLE_UNIT_VISIBLE_LIMIT,
  presentExecutableUnits,
} from "../apps/viewer/src/building-inspector.js";

describe("viewer building inspector", () => {
  it.each([undefined, []] as const)(
    "presents missing or empty executable units as not recorded",
    (units) => {
      expect(presentExecutableUnits(units)).toBeNull();
    },
  );

  it("presents units in deterministic source order with a useful summary", () => {
    const presentation = presentExecutableUnits([
      { name: "later", line: 30, complexity: 2 },
      { name: "<callback>", line: 10, complexity: 3 },
      { name: "<script>", line: 10, complexity: 8 },
    ]);

    expect(presentation).not.toBeNull();
    expect(presentation?.count).toBe(3);
    expect(presentation?.visibleCount).toBe(3);
    expect(presentation?.hiddenCount).toBe(0);
    expect(presentation?.maximumComplexity).toBe(8);
    expect(presentation?.rows.map(({ name }) => name)).toEqual([
      "<script>",
      "<callback>",
      "later",
    ]);
  });

  it("uses the unit name as plain presentation data", () => {
    const presentation = presentExecutableUnits([
      { name: "<script>alert('no')</script>", line: 1, complexity: 1 },
    ]);

    expect(presentation?.rows[0]?.name).toBe(
      "<script>alert('no')</script>",
    );
  });

  it("limits the initial rows and supports deterministic progressive reveal", () => {
    const units = Array.from({ length: 27 }, (_, index) => ({
      name: `unit-${27 - index}`,
      line: 27 - index,
      complexity: (index % 7) + 1,
    }));

    const initial = presentExecutableUnits(units);
    const revealed = presentExecutableUnits(units, { visibleLimit: 19 });

    expect(initial).toMatchObject({
      count: 27,
      visibleCount: INITIAL_EXECUTABLE_UNIT_VISIBLE_LIMIT,
      hiddenCount: 17,
    });
    expect(
      initial && canRevealMoreExecutableUnits(initial),
    ).toBe(true);
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
      presentExecutableUnits(units, { visibleLimit: Number.POSITIVE_INFINITY })
        ?.visibleCount,
    ).toBe(INITIAL_EXECUTABLE_UNIT_VISIBLE_LIMIT);
    const capped = presentExecutableUnits(units, {
        visibleLimit: MAXIMUM_EXECUTABLE_UNIT_VISIBLE_LIMIT + 1,
      });
    expect(capped?.visibleCount).toBe(
      MAXIMUM_EXECUTABLE_UNIT_VISIBLE_LIMIT,
    );
    expect(capped?.hiddenCount).toBe(1);
    expect(
      capped && canRevealMoreExecutableUnits(capped),
    ).toBe(false);
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
      visibleCount: INITIAL_EXECUTABLE_UNIT_VISIBLE_LIMIT,
      hiddenCount: 9_990,
      maximumComplexity: 500,
    });
    expect(presentation?.rows.map(({ line }) => line)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
  });
});
