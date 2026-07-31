import * as THREE from "three";
import { describe, expect, it } from "vitest";

import type { CityModel } from "../packages/core/src/model.js";
import {
  boxBounds,
  createSemanticSceneBounds,
} from "../apps/viewer/src/semantic-scene-bounds.js";

const model: CityModel = {
  schemaVersion: "1.0",
  generator: {
    name: "code-city",
    version: "1.0.0",
  },
  repositories: [
    {
      id: "repo",
      name: "Repository",
    },
  ],
  solutions: [],
  modules: [
    {
      id: "module",
      repositoryId: "repo",
      kind: "unassigned",
      name: "Module",
      path: ".",
      solutionIds: [],
    },
  ],
  semanticGroups: [
    {
      id: "base",
      label: "Base",
      color: "#334455",
      priority: 0,
    },
    {
      id: "code",
      label: "Code",
      color: "#36a3ff",
      priority: 1,
    },
  ],
  districts: [
    {
      id: "district",
      repositoryId: "repo",
      moduleId: "module",
      name: "District",
      path: ".",
      position: { x: 0, y: 0, z: 0 },
      size: { x: 10, y: 1, z: 8 },
    },
  ],
  buildings: [
    {
      id: "building",
      repositoryId: "repo",
      moduleId: "module",
      districtId: "district",
      semanticGroupId: "code",
      name: "Building",
      path: "src/index.ts",
      language: "typescript",
      position: { x: 3, y: 5, z: -2 },
      size: { x: 2, y: 10, z: 2 },
      metrics: {
        sloc: 10,
        decisionLoad: 2,
        maximumComplexity: 3,
        executableUnitCount: 1,
      },
      risk: "low",
    },
  ],
  dependencies: [],
  bounds: { x: 22, y: 12, z: 12 },
};

describe("semantic scene bounds", () => {
  it("includes stable city primitives while keeping district framing local", () => {
    const result = createSemanticSceneBounds(
      model,
      {
        id: "base",
        position: { x: 0, y: -1, z: 0 },
        size: { x: 14, y: 1, z: 12 },
        semanticGroupId: "base",
      },
      [
        {
          position: { x: 20, y: 2, z: 0 },
          size: { x: 4, y: 4, z: 4 },
        },
      ],
    );

    expect(result.city.min.toArray()).toEqual([-7, -1.5, -6]);
    expect(result.city.max.toArray()).toEqual([22, 10, 6]);
    expect(result.districts.get("district")?.min.toArray()).toEqual([
      -5,
      -0.5,
      -4,
    ]);
    expect(result.districts.get("district")?.max.toArray()).toEqual([
      5,
      10,
      4,
    ]);
  });

  it("is unaffected by hidden or transient render-only objects", () => {
    const semantic = createSemanticSceneBounds(model, undefined, []);
    const transient = new THREE.Mesh(
      new THREE.BoxGeometry(10_000, 10_000, 10_000),
    );
    transient.visible = false;
    const renderGroup = new THREE.Group();
    renderGroup.add(transient);

    expect(
      new THREE.Box3().setFromObject(renderGroup).getSize(
        new THREE.Vector3(),
      ).x,
    ).toBe(10_000);
    expect(semantic.city.getSize(new THREE.Vector3()).x).toBe(10);
  });

  it("rejects invalid box primitives before camera math", () => {
    expect(() =>
      boxBounds(
        { x: 0, y: Number.NaN, z: 0 },
        { x: 1, y: 1, z: 1 },
      ),
    ).toThrow(/finite positions/u);
    expect(() =>
      boxBounds(
        { x: 0, y: 0, z: 0 },
        { x: 1, y: -1, z: 1 },
      ),
    ).toThrow(/non-negative sizes/u);
  });
});
