import { describe, expect, it } from "vitest";

import {
  packRectangles,
  type PackedRectangle,
} from "../packages/core/src/index.js";

const FLOW_LIKE_DISTRICTS = [
  { id: "web", width: 211.2, depth: 195.4 },
  { id: "models", width: 148.9, depth: 148.9 },
  { id: "implementation", width: 115.9, depth: 115.9 },
  { id: "host", width: 100.6, depth: 84.9 },
  { id: "infrastructure", width: 68.7, depth: 68.7 },
  { id: "tests", width: 65.7, depth: 65.7 },
  { id: "interfaces", width: 65.4, depth: 65.4 },
  { id: "client", width: 30.2, depth: 18.1 },
];

function hasRequiredSeparation(
  left: PackedRectangle,
  right: PackedRectangle,
  gap: number,
): boolean {
  return (
    left.x + left.width + gap <= right.x ||
    right.x + right.width + gap <= left.x ||
    left.z + left.depth + gap <= right.z ||
    right.z + right.depth + gap <= left.z
  );
}

describe("deterministic rectangle packing", () => {
  it("packs heterogeneous rectangles compactly without overlap", () => {
    const gap = 8;
    const result = packRectangles(FLOW_LIKE_DISTRICTS, gap);
    const districtArea = FLOW_LIKE_DISTRICTS.reduce(
      (sum, rectangle) => sum + rectangle.width * rectangle.depth,
      0,
    );

    expect(result.width).toBeLessThan(360);
    expect(result.depth).toBeLessThan(360);
    expect(result.width * result.depth).toBeLessThan(125_000);
    expect(districtArea / (result.width * result.depth)).toBeGreaterThan(0.8);
    expect(Math.min(...result.rectangles.map(({ x }) => x))).toBe(0);
    expect(Math.min(...result.rectangles.map(({ z }) => z))).toBe(0);
    expect(
      Math.max(
        ...result.rectangles.map(
          (rectangle) => rectangle.x + rectangle.width,
        ),
      ),
    ).toBe(result.width);
    expect(
      Math.max(
        ...result.rectangles.map(
          (rectangle) => rectangle.z + rectangle.depth,
        ),
      ),
    ).toBe(result.depth);
    for (let left = 0; left < result.rectangles.length; left += 1) {
      for (
        let right = left + 1;
        right < result.rectangles.length;
        right += 1
      ) {
        expect(
          hasRequiredSeparation(
            result.rectangles[left]!,
            result.rectangles[right]!,
            gap,
          ),
        ).toBe(true);
      }
    }
    for (const source of FLOW_LIKE_DISTRICTS) {
      expect(
        result.rectangles.find(({ id }) => id === source.id),
      ).toMatchObject({
        width: source.width,
        depth: source.depth,
      });
    }
  });

  it("is independent of input order", () => {
    expect(packRectangles(FLOW_LIKE_DISTRICTS, 8)).toEqual(
      packRectangles([...FLOW_LIKE_DISTRICTS].reverse(), 8),
    );
    const tiedRectangles = [
      { id: "charlie", width: 20, depth: 20 },
      { id: "alpha", width: 20, depth: 20 },
      { id: "bravo", width: 20, depth: 20 },
    ];
    expect(packRectangles(tiedRectangles, 2)).toEqual(
      packRectangles([...tiedRectangles].reverse(), 2),
    );
  });

  it("fills corners around attainable shelf breakpoints", () => {
    const result = packRectangles(
      [
        { id: "wide", width: 454, depth: 139 },
        { id: "medium", width: 163, depth: 134 },
        { id: "tall", width: 94, depth: 433 },
      ],
      8,
    );

    expect(result.width).toBe(556);
    expect(result.depth).toBe(433);
  });

  it("fills L-shaped corners that next-fit shelves leave empty", () => {
    const gap = 1;
    const result = packRectangles(
      [
        { id: "tall", width: 10, depth: 20 },
        { id: "short", width: 10, depth: 10 },
        { id: "filler", width: 10, depth: 9 },
      ],
      gap,
    );

    expect(result).toEqual({
      rectangles: [
        {
          id: "filler",
          width: 10,
          depth: 9,
          x: 11,
          z: 11,
        },
        {
          id: "short",
          width: 10,
          depth: 10,
          x: 11,
          z: 0,
        },
        {
          id: "tall",
          width: 10,
          depth: 20,
          x: 0,
          z: 0,
        },
      ],
      width: 21,
      depth: 20,
    });
    for (let left = 0; left < result.rectangles.length; left += 1) {
      for (
        let right = left + 1;
        right < result.rectangles.length;
        right += 1
      ) {
        expect(
          hasRequiredSeparation(
            result.rectangles[left]!,
            result.rectangles[right]!,
            gap,
          ),
        ).toBe(true);
      }
    }
  });

  it("preserves the requested gap for decimal coordinates", () => {
    const gap = 4;
    const rectangles = Array.from({ length: 39 }, (_, index) => ({
      id: `id-${index}`,
      width: 1 + ((index * 17 + 39) % 29) + index / 1_000,
      depth: 1 + ((index * 23 + 39) % 31) + index / 2_000,
    }));
    const result = packRectangles(rectangles, gap);

    for (let left = 0; left < result.rectangles.length; left += 1) {
      for (
        let right = left + 1;
        right < result.rectangles.length;
        right += 1
      ) {
        expect(
          hasRequiredSeparation(
            result.rectangles[left]!,
            result.rectangles[right]!,
            gap,
          ),
        ).toBe(true);
      }
    }
  });

  it("keeps large-input packing deterministic and finite", () => {
    const rectangles = Array.from({ length: 257 }, (_, index) => ({
      id: `id-${String(index).padStart(3, "0")}`,
      width: 10 + ((index * 17) % 41) + index / 1_000,
      depth: 10 + ((index * 29) % 37) + index / 2_000,
    }));
    const result = packRectangles(rectangles, 3);

    expect(packRectangles([...rectangles].reverse(), 3)).toEqual(result);
    expect(result.rectangles).toHaveLength(rectangles.length);
    expect(Number.isFinite(result.width)).toBe(true);
    expect(Number.isFinite(result.depth)).toBe(true);
  });

  it("caps large shelf searches and supports cooperative cancellation", () => {
    const rectangles = Array.from({ length: 5_000 }, (_, index) => ({
      id: `large-${String(index).padStart(5, "0")}`,
      width: 1 + (index % 17),
      depth: 1 + (index % 23),
    }));
    let checkpoints = 0;
    const result = packRectangles(rectangles, 1, {
      checkpoint: () => {
        checkpoints += 1;
      },
    });

    expect(result.rectangles).toHaveLength(rectangles.length);
    expect(checkpoints).toBeGreaterThan(0);
    expect(checkpoints).toBeLessThan(5_000);

    const cancellation = new Error("cancel packing");
    let cancellationChecks = 0;
    expect(() =>
      packRectangles(rectangles, 1, {
        checkpoint: () => {
          cancellationChecks += 1;
          if (cancellationChecks === 5) throw cancellation;
        },
      }),
    ).toThrow(cancellation);
  });

  it("keeps a large homogeneous packing compact with bounded candidates", () => {
    const rectangles = Array.from({ length: 5_000 }, (_, index) => ({
      id: `unit-${String(index).padStart(5, "0")}`,
      width: 1,
      depth: 1,
    }));

    const result = packRectangles(rectangles, 1);
    const longest = Math.max(result.width, result.depth);
    const shortest = Math.min(result.width, result.depth);

    expect(longest).toBeLessThan(180);
    expect(longest / shortest).toBeLessThan(1.25);
  });

  it("bounds small-input search explicitly without losing compactness", () => {
    const rectangles = Array.from({ length: 64 }, (_, index) => ({
      id: `bounded-${String(index).padStart(2, "0")}`,
      width: 2,
      depth: 2,
    }));
    let operations = 0;
    const result = packRectangles(rectangles, 1, {
      searchMode: "bounded",
      checkpoint: (completed) => {
        operations += completed;
      },
    });

    expect(
      packRectangles([...rectangles].reverse(), 1, {
        searchMode: "bounded",
      }),
    ).toEqual(result);
    expect(operations).toBeLessThan(5_000);
    expect(
      Math.max(result.width, result.depth) /
        Math.min(result.width, result.depth),
    ).toBeLessThan(1.25);
  });

  it("returns deterministic zero bounds for empty input", () => {
    expect(packRectangles([], 8)).toEqual({
      rectangles: [],
      width: 0,
      depth: 0,
    });
  });

  it("rejects invalid geometry and duplicate ids", () => {
    expect(() =>
      packRectangles([{ id: "bad", width: 0, depth: 1 }], 0),
    ).toThrow(/width/u);
    expect(() =>
      packRectangles([{ id: "bad", width: 1, depth: 1 }], -1),
    ).toThrow(/gap/u);
    expect(() =>
      packRectangles(
        [
          { id: "same", width: 1, depth: 1 },
          { id: "same", width: 2, depth: 2 },
        ],
        0,
      ),
    ).toThrow(/Duplicate rectangle id/u);
    expect(() =>
      packRectangles([{ id: " ", width: 1, depth: 1 }], 0),
    ).toThrow(/id/u);
    expect(() =>
      packRectangles([{ id: "bad", width: 1, depth: Number.NaN }], 0),
    ).toThrow(/depth/u);
    expect(() =>
      packRectangles([{ id: "bad", width: 1, depth: 1 }], Infinity),
    ).toThrow(/gap/u);
    expect(() =>
      packRectangles(
        [
          { id: "one", width: Number.MAX_VALUE, depth: 1 },
          { id: "two", width: Number.MAX_VALUE, depth: 1 },
        ],
        0,
      ),
    ).toThrow(/Combined rectangle geometry/u);
  });

  it("supports a zero-gap singleton", () => {
    expect(
      packRectangles([{ id: "only", width: 3, depth: 5 }], 0),
    ).toEqual({
      rectangles: [
        { id: "only", width: 3, depth: 5, x: 0, z: 0 },
      ],
      width: 3,
      depth: 5,
    });
  });
});
