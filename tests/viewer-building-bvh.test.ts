import { describe, expect, it } from "vitest";

import {
  BuildingAabbBvh,
  type BuildingBvhBounds,
  type BuildingBvhRay,
} from "../apps/viewer/src/viewer-building-bvh.js";

function box(
  id: string,
  x: number,
  y: number,
  z: number,
  districtId = "district-a",
): BuildingBvhBounds {
  return {
    id,
    districtId,
    min: { x, y, z },
    max: { x: x + 1, y: y + 1, z: z + 1 },
  };
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b_79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

function bruteForcePick(
  bounds: readonly BuildingBvhBounds[],
  ray: BuildingBvhRay,
): { readonly id: string; readonly distance: number } | null {
  const length = Math.hypot(
    ray.direction.x,
    ray.direction.y,
    ray.direction.z,
  );
  const direction = {
    x: ray.direction.x / length,
    y: ray.direction.y / length,
    z: ray.direction.z / length,
  };
  let best: { readonly id: string; readonly distance: number } | null =
    null;
  for (const candidate of bounds) {
    const distance = bruteForceBoundsDistance(
      ray.origin,
      direction,
      candidate,
    );
    if (
      distance !== null &&
      (best === null ||
        distance < best.distance ||
        (distance === best.distance && candidate.id < best.id))
    ) {
      best = { id: candidate.id, distance };
    }
  }
  return best;
}

function bruteForceBoundsDistance(
  origin: BuildingBvhRay["origin"],
  direction: BuildingBvhRay["direction"],
  bounds: BuildingBvhBounds,
): number | null {
  let entry = Number.NEGATIVE_INFINITY;
  let exit = Number.POSITIVE_INFINITY;
  for (const [coordinate, delta, lower, upper] of [
    [origin.x, direction.x, bounds.min.x, bounds.max.x],
    [origin.y, direction.y, bounds.min.y, bounds.max.y],
    [origin.z, direction.z, bounds.min.z, bounds.max.z],
  ] as const) {
    if (delta === 0) {
      if (coordinate < lower || coordinate > upper) return null;
      continue;
    }
    const first = (lower - coordinate) / delta;
    const second = (upper - coordinate) / delta;
    entry = Math.max(entry, Math.min(first, second));
    exit = Math.min(exit, Math.max(first, second));
    if (exit < entry) return null;
  }
  if (exit <= 0) return null;
  return entry > 0 ? entry : exit;
}

describe("building AABB BVH", () => {
  it("returns the exact nearest positive hit and rejects misses", () => {
    const bvh = new BuildingAabbBvh([
      box("far", 5, 0, 0),
      box("near", 2, 0, 0),
    ]);

    expect(
      bvh.pick({
        origin: { x: 0, y: 0.5, z: 0.5 },
        direction: { x: 4, y: 0, z: 0 },
      }).hit,
    ).toEqual({
      id: "near",
      districtId: "district-a",
      distance: 2,
    });
    expect(
      bvh.pick({
        origin: { x: 0, y: 5, z: 0 },
        direction: { x: 1, y: 0, z: 0 },
      }).hit,
    ).toBeNull();
  });

  it("uses the positive exit distance when the ray begins inside", () => {
    const result = new BuildingAabbBvh([box("inside", 0, 0, 0)]).pick({
      origin: { x: 0.25, y: 0.5, z: 0.5 },
      direction: { x: 1, y: 0, z: 0 },
    });

    expect(result.hit?.id).toBe("inside");
    expect(result.hit?.distance).toBeCloseTo(0.75, 12);
  });

  it("does not prune a nearer subtree when the ray begins inside its node bounds", () => {
    const bounds: BuildingBvhBounds[] = [
      {
        id: "near",
        districtId: "district-a",
        min: { x: 1, y: -0.5, z: -0.5 },
        max: { x: 2, y: 0.5, z: 0.5 },
      },
      {
        id: "behind",
        districtId: "district-a",
        min: { x: -10, y: -200, z: 2 },
        max: { x: -9, y: 0, z: 3 },
      },
      {
        id: "competitor",
        districtId: "district-a",
        min: { x: 1.5, y: 0, z: -0.5 },
        max: { x: 1.75, y: 200, z: 0.5 },
      },
      {
        id: "unrelated",
        districtId: "district-a",
        min: { x: 3, y: 201, z: 2 },
        max: { x: 4, y: 202, z: 3 },
      },
    ];

    expect(
      new BuildingAabbBvh(bounds, 1).pick({
        origin: { x: 0, y: 0, z: 0 },
        direction: { x: 1, y: 0, z: 0 },
      }).hit,
    ).toEqual({
      id: "near",
      districtId: "district-a",
      distance: 1,
    });
  });

  it("matches a seeded brute-force oracle for overlapping bounds", () => {
    const random = seededRandom(0x8b_71_c4);
    const bounds = Array.from({ length: 160 }, (_, index) => {
      const center = {
        x: (random() - 0.5) * 30,
        y: (random() - 0.5) * 30,
        z: (random() - 0.5) * 30,
      };
      const halfSize = {
        x: 0.25 + random() * 7,
        y: 0.25 + random() * 7,
        z: 0.25 + random() * 7,
      };
      return {
        id: `random-${index.toString().padStart(3, "0")}`,
        districtId: `district-${index % 5}`,
        min: {
          x: center.x - halfSize.x,
          y: center.y - halfSize.y,
          z: center.z - halfSize.z,
        },
        max: {
          x: center.x + halfSize.x,
          y: center.y + halfSize.y,
          z: center.z + halfSize.z,
        },
      };
    });
    const bvh = new BuildingAabbBvh(bounds, 3);

    for (let index = 0; index < 300; index += 1) {
      const ray = {
        origin: {
          x: (random() - 0.5) * 16,
          y: (random() - 0.5) * 16,
          z: (random() - 0.5) * 16,
        },
        direction: {
          x: random() - 0.5,
          y: random() - 0.5,
          z: random() - 0.5,
        },
      };
      const expected = bruteForcePick(bounds, ray);
      const actual = bvh.pick(ray).hit;

      expect(actual?.id ?? null, `ray ${index}`).toBe(
        expected?.id ?? null,
      );
      if (actual !== null && expected !== null) {
        expect(actual.distance, `ray ${index}`).toBeCloseTo(
          expected.distance,
          12,
        );
      }
    }
  });

  it("breaks equal-distance ties by canonical building ID", () => {
    const ray = {
      origin: { x: 0, y: 0.5, z: 0.5 },
      direction: { x: 1, y: 0, z: 0 },
    };
    const first = new BuildingAabbBvh([
      box("z-building", 2, 0, 0),
      box("a-building", 2, 0, 0),
    ]);
    const reversed = new BuildingAabbBvh([
      box("a-building", 2, 0, 0),
      box("z-building", 2, 0, 0),
    ]);

    expect(first.pick(ray).hit?.id).toBe("a-building");
    expect(reversed.pick(ray)).toEqual(first.pick(ray));
  });

  it("never lets an ID tie-break override a strictly nearer hit", () => {
    const bvh = new BuildingAabbBvh([
      box("a-far", 1.00000000005, 0, 0),
      box("z-near", 1, 0, 0),
    ]);

    expect(
      bvh.pick({
        origin: { x: 0, y: 0.5, z: 0.5 },
        direction: { x: 1, y: 0, z: 0 },
      }).hit,
    ).toEqual({
      id: "z-near",
      districtId: "district-a",
      distance: 1,
    });
  });

  it("filters by district without allowing a nearer hidden building", () => {
    const bvh = new BuildingAabbBvh([
      box("hidden", 1, 0, 0, "district-a"),
      box("visible", 4, 0, 0, "district-b"),
    ]);
    const ray = {
      origin: { x: 0, y: 0.5, z: 0.5 },
      direction: { x: 1, y: 0, z: 0 },
    };

    expect(bvh.pick(ray).hit?.id).toBe("hidden");
    expect(
      bvh.pick(ray, { districtId: "district-b" }).hit?.id,
    ).toBe("visible");
    expect(
      bvh.pick(ray, { districtId: "missing" }).hit,
    ).toBeNull();
  });

  it("canonicalizes lookup data independent of mutable input order", () => {
    const entries = [
      box("c", 6, 0, 0),
      box("a", 2, 0, 0),
      box("b", 4, 0, 0),
    ];
    const forward = new BuildingAabbBvh(entries, 1);
    const reverse = new BuildingAabbBvh(entries.toReversed(), 1);
    const rays = [0.5, 2.5, 4.5, 6.5].map((y) => ({
      origin: { x: -1, y, z: 0.5 },
      direction: { x: 1, y: 0, z: 0 },
    }));

    expect(forward.size).toBe(3);
    expect(forward.bounds("a")).toEqual(reverse.bounds("a"));
    expect(rays.map((ray) => forward.pick(ray))).toEqual(
      rays.map((ray) => reverse.pick(ray)),
    );
  });

  it("keeps representative 25k-grid picks below the traversal budget", () => {
    const width = 250;
    const entries = Array.from({ length: 25_000 }, (_, index) => {
      const x = index % width;
      const z = Math.floor(index / width);
      return box(
        `building-${index.toString().padStart(5, "0")}`,
        x * 2,
        0,
        z * 2,
        `district-${Math.floor(index / 250)
          .toString()
          .padStart(3, "0")}`,
      );
    });
    const bvh = new BuildingAabbBvh(entries);

    for (const index of [0, 127, 12_499, 18_731, 24_999]) {
      const target = entries[index]!;
      const result = bvh.pick({
        origin: {
          x: target.min.x + 0.5,
          y: 100,
          z: target.min.z + 0.5,
        },
        direction: { x: 0, y: -1, z: 0 },
      });
      expect(result.hit?.id).toBe(target.id);
      expect(result.aabbTests).toBeLessThanOrEqual(512);
    }
  });

  it("validates duplicate IDs, invalid bounds, rays, and distances", () => {
    expect(() =>
      new BuildingAabbBvh([box("same", 0, 0, 0), box("same", 2, 0, 0)]),
    ).toThrow(/Duplicate/u);
    expect(
      () =>
        new BuildingAabbBvh([
          {
            ...box("bad", 0, 0, 0),
            min: { x: 2, y: 0, z: 0 },
          },
        ]),
    ).toThrow(/min <= max/u);
    const bvh = new BuildingAabbBvh([box("valid", 0, 0, 0)]);
    expect(() =>
      bvh.pick({
        origin: { x: 0, y: 0, z: 0 },
        direction: { x: 0, y: 0, z: 0 },
      }),
    ).toThrow(/non-zero/u);
    expect(() =>
      bvh.pick(
        {
          origin: { x: 0, y: 0, z: 0 },
          direction: { x: 1, y: 0, z: 0 },
        },
        { maximumDistance: Number.POSITIVE_INFINITY },
      ),
    ).toThrow(/finite and positive/u);
  });
});
