import { describe, expect, it } from "vitest";

import { presentExecutableUnits } from "../apps/viewer/src/building-inspector.js";

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
});
