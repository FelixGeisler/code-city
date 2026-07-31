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

function instancedObject(
  layer: EvolutionRemovalLayer,
): THREE.InstancedMesh<THREE.BoxGeometry, THREE.MeshBasicMaterial> {
  if (!(layer.object instanceof THREE.InstancedMesh)) {
    throw new Error("Expected an instanced removal object.");
  }
  return layer.object;
}

describe("evolution removal layer", () => {
  it("keeps an empty transition bounded and out of the draw list", () => {
    const layer = new EvolutionRemovalLayer([]);
    const object = instancedObject(layer);

    expect(object.count).toBe(0);
    expect(object.visible).toBe(false);
    expect(layer.diagnostics()).toEqual({
      renderMode: "instanced",
      totalCount: 0,
      visibleCount: 0,
      objectCount: 1,
      geometryCount: 1,
      materialCount: 1,
      drawCalls: 0,
    });

    layer.dispose();
  });

  it("renders 25k removals with one bounded instanced batch", () => {
    const layer = new EvolutionRemovalLayer(maximumRemovalFixture());
    const object = instancedObject(layer);
    let objectCount = 0;
    object.traverse(() => {
      objectCount += 1;
    });

    expect(layer.mode).toBe("instanced");
    expect(object.count).toBe(MAXIMUM_BUILDINGS);
    expect(objectCount).toBe(1);
    expect(layer.diagnostics()).toEqual({
      renderMode: "instanced",
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
    const layer = new EvolutionRemovalLayer(
      maximumRemovalFixture(),
      "district:7",
    );
    const object = instancedObject(layer);
    const geometry = object.geometry;
    const material = object.material;
    const matrix = new THREE.Matrix4();

    expect(object.count).toBe(250);
    object.getMatrixAt(0, matrix);
    expect(new THREE.Vector3().setFromMatrixPosition(matrix).x).toBe(7);
    expect(layer.diagnostics()).toMatchObject({
      renderMode: "instanced",
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
    expect(object.geometry).toBe(geometry);
    expect(object.material).toBe(material);

    layer.setProgress(1);
    expect(object.visible).toBe(false);
    expect(layer.diagnostics().drawCalls).toBe(0);

    layer.setProgress(0);
    layer.setIsolatedDistrict(null);
    expect(object.count).toBe(MAXIMUM_BUILDINGS);
    expect(object.visible).toBe(true);
    expect(object.geometry).toBe(geometry);
    expect(object.material).toBe(material);

    const disposeObject = vi.spyOn(object, "dispose");
    const disposeGeometry = vi.spyOn(geometry, "dispose");
    const disposeMaterial = vi.spyOn(material, "dispose");
    layer.dispose();
    layer.dispose();
    expect(disposeObject).toHaveBeenCalledTimes(1);
    expect(disposeGeometry).toHaveBeenCalledTimes(1);
    expect(disposeMaterial).toHaveBeenCalledTimes(1);
  });

  it("keeps the non-instancing fallback to one merged draw call", () => {
    const definitions = maximumRemovalFixture().slice(0, 500);
    const layer = new EvolutionRemovalLayer(
      definitions,
      null,
      { instancingSupported: false },
    );
    if (layer.object instanceof THREE.InstancedMesh) {
      throw new Error("Expected a merged removal object.");
    }
    const object = layer.object;
    const material = object.material;
    const wholeCityGeometry = object.geometry;
    const disposeWholeCityGeometry = vi.spyOn(
      wholeCityGeometry,
      "dispose",
    );

    expect(layer.mode).toBe("merged");
    expect(
      object.geometry.getAttribute("position").count,
    ).toBe(500 * 36);
    expect(layer.diagnostics()).toEqual({
      renderMode: "merged",
      totalCount: 500,
      visibleCount: 500,
      objectCount: 1,
      geometryCount: 1,
      materialCount: 1,
      drawCalls: 1,
    });

    layer.setIsolatedDistrict("district:7");
    expect(disposeWholeCityGeometry).toHaveBeenCalledTimes(1);
    expect(
      object.geometry.getAttribute("position").count,
    ).toBe(5 * 36);
    expect(layer.diagnostics()).toMatchObject({
      visibleCount: 5,
      drawCalls: 1,
    });

    const isolatedGeometry = object.geometry;
    const disposeIsolatedGeometry = vi.spyOn(
      isolatedGeometry,
      "dispose",
    );
    const disposeMaterial = vi.spyOn(material, "dispose");
    layer.dispose();
    layer.dispose();
    expect(disposeIsolatedGeometry).toHaveBeenCalledTimes(1);
    expect(disposeMaterial).toHaveBeenCalledTimes(1);
  });
});
