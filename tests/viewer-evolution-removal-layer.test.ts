import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";

import {
  EvolutionRemovalLayer,
  type EvolutionRemovalDefinition,
} from "../apps/viewer/src/evolution-removal-layer.js";

const MAXIMUM_BUILDINGS = 25_000;
const DISTRICT_COUNT = 100;

function maximumRemovalFixture(): readonly EvolutionRemovalDefinition[] {
  return Object.freeze(
    Array.from({ length: MAXIMUM_BUILDINGS }, (_, index) =>
      Object.freeze({
        id: `building:${index}`,
        districtId: `district:${index % DISTRICT_COUNT}`,
        position: {
          x: index % 250,
          y: 2 + (index % 5),
          z: Math.floor(index / 250),
        },
        size: {
          x: 1 + (index % 3),
          y: 2 + (index % 5),
          z: 1.5,
        },
      }),
    ),
  );
}

describe("evolution removal layer", () => {
  it("renders 25k removals with one bounded instanced batch", () => {
    const layer = new EvolutionRemovalLayer(maximumRemovalFixture());
    let objectCount = 0;
    layer.object.traverse(() => {
      objectCount += 1;
    });

    expect(layer.object).toBeInstanceOf(THREE.InstancedMesh);
    expect(layer.object.count).toBe(MAXIMUM_BUILDINGS);
    expect(objectCount).toBe(1);
    expect(layer.diagnostics()).toEqual({
      totalCount: MAXIMUM_BUILDINGS,
      visibleCount: MAXIMUM_BUILDINGS,
      objectCount: 1,
      geometryCount: 1,
      materialCount: 1,
      drawCalls: 1,
    });

    layer.dispose();
  });

  it("filters instances by district and animates without reallocating", () => {
    const layer = new EvolutionRemovalLayer(maximumRemovalFixture());
    const geometry = layer.object.geometry;
    const material = layer.object.material;

    layer.setIsolatedDistrict("district:7");
    expect(layer.object.count).toBe(250);
    expect(layer.diagnostics()).toMatchObject({
      totalCount: MAXIMUM_BUILDINGS,
      visibleCount: 250,
      drawCalls: 1,
    });

    // Reduced motion leaves the same bounded cue at progress zero. Normal
    // motion changes one shared material uniform rather than instance data.
    layer.setProgress(0);
    expect(material.opacity).toBeCloseTo(0.48);
    layer.setProgress(0.5);
    expect(material.opacity).toBeCloseTo(0.24);
    expect(layer.object.geometry).toBe(geometry);
    expect(layer.object.material).toBe(material);

    layer.setProgress(1);
    expect(layer.object.visible).toBe(false);
    expect(layer.diagnostics().drawCalls).toBe(0);

    layer.setProgress(0);
    layer.setIsolatedDistrict(null);
    expect(layer.object.count).toBe(MAXIMUM_BUILDINGS);
    expect(layer.object.visible).toBe(true);
    expect(layer.object.geometry).toBe(geometry);
    expect(layer.object.material).toBe(material);

    const disposeGeometry = vi.spyOn(geometry, "dispose");
    const disposeMaterial = vi.spyOn(material, "dispose");
    layer.dispose();
    layer.dispose();
    expect(disposeGeometry).toHaveBeenCalledTimes(1);
    expect(disposeMaterial).toHaveBeenCalledTimes(1);
  });
});
