import { describe, expect, it } from "vitest";

import {
  minimumPositiveHorizontalGap,
  potentialPrintPairs,
  type BoundedPrintItem,
} from "../packages/exporter/src/spatial.js";

function item(
  id: string,
  minimum: { x: number; y: number; z: number },
  maximum: { x: number; y: number; z: number },
): BoundedPrintItem {
  return {
    id,
    bounds: {
      minimum,
      maximum,
      size: {
        x: maximum.x - minimum.x,
        y: maximum.y - minimum.y,
        z: maximum.z - minimum.z,
      },
    },
  };
}

describe("print geometry broad phase", () => {
  it("finds touching candidates and the exact positive horizontal gap", () => {
    const items = [
      item("a", { x: 0, y: 0, z: 0 }, { x: 2, y: 2, z: 2 }),
      item("b", { x: 2, y: 0, z: 0 }, { x: 4, y: 2, z: 2 }),
      item("c", { x: 5, y: 0, z: 0 }, { x: 7, y: 2, z: 2 }),
      item("lifted", { x: 2, y: 0, z: 3 }, { x: 4, y: 2, z: 4 }),
    ];

    expect(
      [...potentialPrintPairs(items, 1e-7)].map(([left, right]) => [
        left.id,
        right.id,
      ]),
    ).toEqual([["a", "b"]]);
    expect(minimumPositiveHorizontalGap(items, 1e-7)).toBe(1);
  });

  it(
    "stays bounded at the 25,000-building model limit",
    () => {
      const buildings = Array.from({ length: 25_000 }, (_, index) =>
        item(
          `building:${index.toString().padStart(5, "0")}`,
          { x: index * 2, y: 0, z: 1 },
          { x: index * 2 + 1, y: 1, z: 2 },
        ),
      );
      const base = item(
        "base",
        { x: 0, y: 0, z: 0 },
        { x: 50_000, y: 1, z: 1 },
      );
      let candidateCount = 0;
      for (const _pair of potentialPrintPairs(
        [base, ...buildings],
        1e-7,
      )) {
        candidateCount += 1;
      }

      expect(candidateCount).toBe(25_000);
      expect(
        minimumPositiveHorizontalGap([base, ...buildings], 1e-7),
      ).toBe(1);
    },
    10_000,
  );
});
