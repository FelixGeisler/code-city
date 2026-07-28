import { describe, expect, it } from "vitest";

import {
  layoutCity,
  type CityLayoutInput,
} from "../packages/core/src/index.js";

const input: CityLayoutInput = {
  repositories: [
    { id: "repo-b", name: "Repository B" },
    { id: "repo-a", name: "Repository A" },
  ],
  modules: [
    {
      id: "module-b",
      repositoryId: "repo-b",
      kind: "dotnet-project",
      name: "Module B",
      path: "src\\B.csproj",
      solutionIds: [],
    },
    {
      id: "module-empty",
      repositoryId: "repo-a",
      kind: "unassigned",
      name: "Empty",
      path: "src/empty",
      solutionIds: [],
    },
    {
      id: "module-a",
      repositoryId: "repo-a",
      kind: "angular-project",
      name: "Module A",
      path: "src/app",
      solutionIds: [],
    },
  ],
  buildings: [
    {
      repositoryId: "repo-b",
      moduleId: "module-b",
      name: "B.cs",
      path: "src\\B.cs",
      language: "csharp",
      metrics: {
        sloc: 100,
        decisionLoad: 4,
        maximumComplexity: 6,
        executableUnitCount: 2,
      },
    },
    {
      repositoryId: "repo-a",
      moduleId: "module-a",
      name: "main.ts",
      path: "./src/app/main.ts",
      language: "typescript",
      metrics: {
        sloc: 20,
        decisionLoad: 0,
        maximumComplexity: 1,
        executableUnitCount: 1,
      },
    },
  ],
  identity: {
    title: "Flow City",
    version: "1.0.0",
    logo: { relativePath: "assets/logo.svg", format: "svg" },
  },
};

describe("deterministic city layout", () => {
  it("is independent of repository, module, and building input order", () => {
    const first = layoutCity(input);
    const second = layoutCity({
      ...input,
      repositories: [...input.repositories].reverse(),
      modules: [...input.modules].reverse(),
      buildings: [...input.buildings].reverse(),
    });
    expect(second).toEqual(first);
  });

  it("creates centered Y-up districts/buildings and stable normalized output", () => {
    const result = layoutCity(input);
    expect(result.districts).toHaveLength(3);
    expect(result.buildings).toHaveLength(2);
    expect(result.districts.map(({ moduleId }) => moduleId)).toEqual([
      "module-a",
      "module-empty",
      "module-b",
    ]);
    expect(result.buildings[0]?.path).toBe("src/app/main.ts");
    expect(result.buildings[0]?.semanticGroupId).toBe("risk-low");
    expect(result.buildings[1]?.risk).toBe("moderate");
    for (const district of result.districts) {
      expect(district.position.y).toBe(district.size.y / 2);
      expect(district.position.z - district.size.z / 2).toBeGreaterThanOrEqual(5);
    }
    for (const building of result.buildings) {
      expect(building.position.y).toBe(1 + building.size.y / 2);
    }
  });

  it("reserves a deterministic embossed front panel and includes it in bounds", () => {
    const result = layoutCity(input);
    expect(result.identity).toEqual(input.identity);
    expect(result.identityPanel).toMatchObject({
      edge: "front",
      semanticGroupId: "identity",
      position: { y: 5, z: 1.6 },
      size: { y: 10, z: 2 },
      relief: "embossed",
      reliefDepth: 0.6,
    });
    expect(result.identityPanel?.size.x).toBe(result.bounds.x);
    expect(result.bounds.y).toBeGreaterThanOrEqual(10);
    expect(
      result.identityPanel!.position.z -
        result.identityPanel!.size.z / 2 -
        result.identityPanel!.reliefDepth,
    ).toBeCloseTo(0, 12);
  });

  it("remains backward-compatible when identity is omitted", () => {
    const {
      identity: _identity,
      ...inputWithoutIdentity
    } = input;
    const result = layoutCity(inputWithoutIdentity);
    expect(result.identity).toBeUndefined();
    expect(result.identityPanel).toBeUndefined();
    expect(
      Math.min(
        ...result.districts.map(
          (district) => district.position.z - district.size.z / 2,
        ),
      ),
    ).toBe(0);
  });

  it("includes empty district bases in the vertical city bound", () => {
    const result = layoutCity({
      repositories: [{ id: "repo", name: "Repository" }],
      modules: [
        {
          id: "empty",
          repositoryId: "repo",
          kind: "unassigned",
          name: "Empty",
          path: ".",
          solutionIds: [],
        },
      ],
      buildings: [],
    });

    expect(result.districts).toHaveLength(1);
    expect(result.buildings).toHaveLength(0);
    expect(result.bounds.y).toBe(1);
  });

  it("rejects inconsistent and duplicate source facts", () => {
    expect(() =>
      layoutCity({
        ...input,
        buildings: [
          ...input.buildings,
          { ...input.buildings[0]!, path: "src/B.cs" },
        ],
      }),
    ).toThrow(/Duplicate building path/u);

    expect(() =>
      layoutCity({
        ...input,
        buildings: [
          { ...input.buildings[0]!, repositoryId: "repo-a" },
        ],
      }),
    ).toThrow(/inconsistent repository/u);
  });
});
