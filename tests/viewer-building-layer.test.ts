import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";

import {
  LEGACY_BUILDING_LIMIT,
  planViewerBuildingBatches,
  ViewerBuildingCapabilityError,
  ViewerBuildingLayer,
  type ViewerBuildingDefinition,
} from "../apps/viewer/src/viewer-building-layer.js";

function building(
  id: string,
  x: number,
  districtId = "district-a",
  color = "#36a3ff",
  roughness = 0.58,
): ViewerBuildingDefinition {
  return {
    id,
    districtId,
    position: { x, y: 2, z: 0 },
    size: { x: 2, y: 4, z: 2 },
    color,
    style: { roughness, metalness: 0.08 },
  };
}

describe("viewer building layer", () => {
  it("plans deterministic non-color material batches", () => {
    const definitions = [
      building("z", 6, "district-b", "#ff0000", 0.8),
      building("b", 4, "district-a", "#00ff00"),
      building("a", 2, "district-a", "#0000ff"),
    ];

    const forward = planViewerBuildingBatches(definitions);
    const reverse = planViewerBuildingBatches(definitions.toReversed());

    expect(reverse).toEqual(forward);
    expect(forward).toHaveLength(2);
    expect(forward.flatMap(({ buildingIds }) => buildingIds)).toEqual([
      "a",
      "b",
      "z",
    ]);
    expect(forward[0]?.buildingIds).toEqual(["a", "b"]);
  });

  it("keeps losslessly distinct material semantics in separate batches", () => {
    const batches = planViewerBuildingBatches([
      building("a", 2, "district-a", "#ff0000", 0.5800001),
      building("b", 4, "district-a", "#00ff00", 0.5800002),
      building("negative-zero", 6, "district-a", "#0000ff", -0),
      building("positive-zero", 8, "district-a", "#ffffff", 0),
    ]);

    expect(batches).toHaveLength(3);
    expect(
      batches.map(({ buildingIds }) => buildingIds),
    ).toContainEqual(["a"]);
    expect(
      batches.map(({ buildingIds }) => buildingIds),
    ).toContainEqual(["b"]);
    expect(
      batches.map(({ buildingIds }) => buildingIds),
    ).toContainEqual(["negative-zero", "positive-zero"]);
  });

  it("shares one box geometry and keeps stable instance mappings", () => {
    const layer = new ViewerBuildingLayer([
      building("c", 6),
      building("a", 2),
      building("b", 4),
    ]);

    expect(layer.mode).toBe("instanced");
    expect(layer.batchCount).toBe(1);
    expect(layer.visibleBuildingCount).toBe(3);
    const batch = layer.batchObjects[0]!;
    expect(layer.highlightObjects.every(({ geometry }) => geometry === batch.geometry))
      .toBe(true);
    expect([0, 1, 2].map((index) => layer.instanceBuildingId(batch, index)))
      .toEqual(["a", "b", "c"]);

    const matrix = new THREE.Matrix4();
    batch.getMatrixAt(0, matrix);
    expect(new THREE.Vector3().setFromMatrixPosition(matrix)).toEqual(
      new THREE.Vector3(2, 2, 0),
    );
    expect(layer.matrix("a")?.equals(matrix)).toBe(true);
  });

  it("compacts exact building masks and restores canonical ordering", () => {
    const layer = new ViewerBuildingLayer([
      building("d", 8, "district-b"),
      building("b", 4, "district-b"),
      building("c", 6, "district-a"),
      building("a", 2, "district-a"),
    ]);
    const batch = layer.batchObjects[0]!;

    layer.setVisibleBuildingIds(["b", "d"]);
    expect(layer.visibleBuildingCount).toBe(2);
    expect([0, 1].map((index) => layer.instanceBuildingId(batch, index)))
      .toEqual(["b", "d"]);
    expect(layer.districtBounds("district-b")?.max.x).toBe(9);

    layer.setVisibleBuildingIds(null);
    expect(layer.visibleBuildingCount).toBe(4);
    expect(
      [0, 1, 2, 3].map((index) =>
        layer.instanceBuildingId(batch, index),
      ),
    ).toEqual(["a", "b", "c", "d"]);
  });

  it("applies an exact cross-district visibility mask to rendering and picking", () => {
    const layer = new ViewerBuildingLayer([
      building("district-a-hidden", 2, "district-a"),
      building("district-a-visible", 6, "district-a"),
      building("district-b-visible", 10, "district-b"),
      building("district-b-hidden", 14, "district-b"),
    ]);
    const batch = layer.batchObjects[0]!;

    layer.setVisibleBuildingIds([
      "district-b-visible",
      "missing",
      "district-a-visible",
      "district-a-visible",
    ]);

    expect(layer.visibleBuildingCount).toBe(2);
    expect([
      layer.instanceBuildingId(batch, 0),
      layer.instanceBuildingId(batch, 1),
    ]).toEqual(["district-a-visible", "district-b-visible"]);
    expect(
      layer.pick({
        origin: { x: 0, y: 2, z: 0 },
        direction: { x: 1, y: 0, z: 0 },
      }).hit?.id,
    ).toBe("district-a-visible");

    layer.setVisibleBuildingIds(null);
    expect(layer.visibleBuildingCount).toBe(4);
    expect(
      layer.pick({
        origin: { x: 0, y: 2, z: 0 },
        direction: { x: 1, y: 0, z: 0 },
      }).hit?.id,
    ).toBe("district-a-hidden");
  });

  it("unions the exact bounds of every known selected building", () => {
    const layer = new ViewerBuildingLayer([
      building("left", -10, "district-a"),
      building("middle", 0, "district-a"),
      building("right", 14, "district-b"),
    ]);

    const bounds = layer.selectionBounds([
      "right",
      "missing",
      "left",
      "right",
    ]);
    expect(bounds?.min.x).toBe(-11);
    expect(bounds?.max.x).toBe(15);
    expect(layer.selectionBounds(["missing"])).toBeUndefined();
  });

  it("uses two reusable non-raycast highlights and hides scoped-out slots", () => {
    const layer = new ViewerBuildingLayer([
      building("a", 2, "district-a"),
      building("b", 4, "district-b"),
    ]);
    const [hovered, selected] = layer.highlightObjects;

    layer.setHighlight("hovered", "a");
    layer.setHighlight("selected", "b");
    expect(hovered?.visible).toBe(true);
    expect(selected?.visible).toBe(true);
    expect(
      new THREE.Raycaster(
        new THREE.Vector3(2, 20, 0),
        new THREE.Vector3(0, -1, 0),
      ).intersectObjects(layer.object.children, true),
    ).toEqual([]);

    layer.setVisibleBuildingIds(["a"]);
    expect(hovered?.visible).toBe(true);
    expect(selected?.visible).toBe(false);
    layer.setHighlight("hovered", null);
    expect(hovered?.visible).toBe(false);
  });

  it("renders a non-raycast group selection and respects the building mask", () => {
    const layer = new ViewerBuildingLayer([
      building("a", 2, "district-a"),
      building("b", 4, "district-b"),
      building("c", 6, "district-a"),
    ]);

    layer.setGroupHighlight(["c", "missing", "a", "a"]);
    expect(layer.groupHighlightObject.count).toBe(2);
    expect(layer.groupHighlightObject.visible).toBe(true);
    expect(layer.groupHighlightObject.material.color.getHexString()).toBe("63e6ff");
    layer.setGroupHighlight(["a"], "#DC2626");
    expect(layer.groupHighlightObject.material.color.getHexString()).toBe("dc2626");
    layer.setGroupHighlight(["c", "a"]);
    expect(layer.groupHighlightObject.material.color.getHexString()).toBe("63e6ff");
    expect(
      new THREE.Raycaster(
        new THREE.Vector3(2, 20, 0),
        new THREE.Vector3(0, -1, 0),
      ).intersectObject(layer.groupHighlightObject),
    ).toEqual([]);

    layer.setVisibleBuildingIds(["b"]);
    expect(layer.groupHighlightObject.visible).toBe(false);
    layer.setVisibleBuildingIds(["a", "c"]);
    expect(layer.groupHighlightObject.count).toBe(2);
    layer.setGroupHighlight([]);
    expect(layer.groupHighlightObject.visible).toBe(false);
  });

  it("supports bounded legacy meshes and rejects oversized fallback models", () => {
    const fallback = new ViewerBuildingLayer(
      [building("b", 4), building("a", 2)],
      { instancingSupported: false },
    );
    expect(fallback.mode).toBe("legacy");
    expect(fallback.batchCount).toBe(0);
    expect(fallback.visibleBuildingCount).toBe(2);
    fallback.setVisibleBuildingIds(["b"]);
    expect(fallback.visibleBuildingCount).toBe(1);
    expect(
      fallback.pick({
        origin: { x: 0, y: 2, z: 0 },
        direction: { x: 1, y: 0, z: 0 },
      }).hit?.id,
    ).toBe("b");
    fallback.setVisibleBuildingIds([]);
    expect(fallback.visibleBuildingCount).toBe(0);
    expect(
      fallback.pick({
        origin: { x: 0, y: 2, z: 0 },
        direction: { x: 1, y: 0, z: 0 },
      }).hit,
    ).toBeNull();
    fallback.setVisibleBuildingIds(["missing"]);
    expect(fallback.visibleBuildingCount).toBe(0);

    const oversized = Array.from(
      { length: LEGACY_BUILDING_LIMIT + 1 },
      (_, index) => building(`building-${index}`, index * 2),
    );
    expect(
      () =>
        new ViewerBuildingLayer(oversized, {
          instancingSupported: false,
        }),
    ).toThrow(ViewerBuildingCapabilityError);
  });

  it("picks exact nearest boxes and benchmarks the deterministic BVH", () => {
    const layer = new ViewerBuildingLayer([
      building("far", 8),
      building("near", 3),
    ]);

    expect(
      layer.pick({
        origin: { x: 0, y: 2, z: 0 },
        direction: { x: 1, y: 0, z: 0 },
      }).hit?.id,
    ).toBe("near");
    const benchmark = layer.benchmarkPicks(10);
    expect(benchmark.count).toBe(10);
    expect(benchmark.maximumAabbTests).toBeLessThanOrEqual(512);
    expect(benchmark.p95Milliseconds).toBeGreaterThanOrEqual(0);
  });

  it("updates per-instance colors and disposes owned GPU resources once", () => {
    const layer = new ViewerBuildingLayer([building("a", 2)]);
    const batch = layer.batchObjects[0]!;
    const matrixVersion = batch.instanceMatrix.version;
    const boundingBox = batch.boundingBox;
    const boundingSphere = batch.boundingSphere;
    const computeBoundingBox = vi.spyOn(batch, "computeBoundingBox");
    const computeBoundingSphere = vi.spyOn(batch, "computeBoundingSphere");
    const geometryDispose = vi.fn();
    const materialDispose = vi.fn();
    const instanceDispose = vi.fn();
    batch.geometry.addEventListener("dispose", geometryDispose);
    batch.material.addEventListener("dispose", materialDispose);
    batch.addEventListener("dispose", instanceDispose);

    expect(layer.setColor("a", "#ff00ff")).toBe(true);
    expect(layer.setColor("missing", "#ff00ff")).toBe(false);
    layer.setColors(new Map([["a", "#00ffaa"]]));
    const color = new THREE.Color();
    batch.getColorAt(0, color);
    expect(color.getHexString()).toBe("00ffaa");
    expect(batch.instanceMatrix.version).toBe(matrixVersion);
    expect(batch.boundingBox).toBe(boundingBox);
    expect(batch.boundingSphere).toBe(boundingSphere);
    expect(computeBoundingBox).not.toHaveBeenCalled();
    expect(computeBoundingSphere).not.toHaveBeenCalled();

    layer.setColors(new Map([["a", "#36a3ff"]]));
    batch.getColorAt(0, color);
    expect(color.getHexString()).toBe("36a3ff");

    layer.dispose();
    layer.dispose();
    expect(geometryDispose).toHaveBeenCalledTimes(1);
    expect(materialDispose).toHaveBeenCalledTimes(1);
    expect(instanceDispose).toHaveBeenCalledTimes(1);
    expect(() => layer.setVisibleBuildingIds(null)).toThrow(/disposed/u);
    expect(() => layer.selectionBounds(["a"])).toThrow(/disposed/u);
  });

  it("updates compacted visible instance colors without rewriting matrices", () => {
    const layer = new ViewerBuildingLayer([
      building("c", 6),
      building("a", 2),
      building("b", 4),
    ]);
    layer.setVisibleBuildingIds(["c", "a"]);
    const batch = layer.batchObjects[0]!;
    const matrixVersion = batch.instanceMatrix.version;

    layer.setColors(
      new Map([
        ["a", "#f43f5e"],
        ["b", "#64748b"],
        ["c", "#facc15"],
      ]),
    );

    const color = new THREE.Color();
    batch.getColorAt(0, color);
    expect(color.getHexString()).toBe("f43f5e");
    batch.getColorAt(1, color);
    expect(color.getHexString()).toBe("facc15");
    expect(batch.instanceMatrix.version).toBe(matrixVersion);
  });

  it("validates duplicate identifiers, dimensions, styles, and benchmark counts", () => {
    expect(
      () =>
        new ViewerBuildingLayer([
          building("same", 0),
          building("same", 2),
        ]),
    ).toThrow(/Duplicate/u);
    expect(
      () =>
        new ViewerBuildingLayer([
          {
            ...building("bad-size", 0),
            size: { x: 0, y: 1, z: 1 },
          },
        ]),
    ).toThrow(/positive/u);
    expect(
      () =>
        new ViewerBuildingLayer([
          {
            ...building("bad-style", 0),
            style: { roughness: 2, metalness: 0 },
          },
        ]),
    ).toThrow(/between zero and one/u);
    const layer = new ViewerBuildingLayer([building("valid", 0)]);
    expect(() => layer.benchmarkPicks(0)).toThrow(/positive/u);
  });
});
