import { describe, expect, it } from "vitest";

import {
  DEFAULT_LAYOUT_OPTIONS,
  layoutCity,
  type CityLayoutInput,
  type CityDistrict,
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

function hasHorizontalGap(
  left: CityDistrict,
  right: CityDistrict,
  gap: number,
): boolean {
  return (
    left.position.x + left.size.x / 2 + gap <=
      right.position.x - right.size.x / 2 ||
    right.position.x + right.size.x / 2 + gap <=
      left.position.x - left.size.x / 2 ||
    left.position.z + left.size.z / 2 + gap <=
      right.position.z - right.size.z / 2 ||
    right.position.z + right.size.z / 2 + gap <=
      left.position.z - left.size.z / 2
  );
}

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
    expect(result.base).toMatchObject({
      semanticGroupId: "base",
      position: {
        x: result.bounds.x / 2,
        y: DEFAULT_LAYOUT_OPTIONS.cityBaseHeight / 2,
        z: result.bounds.z / 2,
      },
      size: {
        x: result.bounds.x,
        y: DEFAULT_LAYOUT_OPTIONS.cityBaseHeight,
        z: result.bounds.z,
      },
    });
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
    const baseTop =
      result.base!.position.y + result.base!.size.y / 2;
    const frontageDepth =
      DEFAULT_LAYOUT_OPTIONS.identityReliefDepth +
      DEFAULT_LAYOUT_OPTIONS.identityPanelDepth +
      DEFAULT_LAYOUT_OPTIONS.identityPanelGap;
    for (const district of result.districts) {
      expect(district.position.y).toBe(district.size.y / 2);
      expect(
        district.position.z - district.size.z / 2,
      ).toBeGreaterThanOrEqual(frontageDepth - 1e-12);
      expect(district.position.y - district.size.y / 2).toBeLessThan(baseTop);
      expect(district.position.y + district.size.y / 2).toBeGreaterThan(
        baseTop,
      );
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
      position: {
        x: result.bounds.x / 2,
        y: DEFAULT_LAYOUT_OPTIONS.identityPanelHeight / 2,
        z:
          DEFAULT_LAYOUT_OPTIONS.identityReliefDepth +
          DEFAULT_LAYOUT_OPTIONS.identityPanelDepth / 2,
      },
      size: {
        x: DEFAULT_LAYOUT_OPTIONS.identityPanelWidth,
        y: DEFAULT_LAYOUT_OPTIONS.identityPanelHeight,
        z: DEFAULT_LAYOUT_OPTIONS.identityPanelDepth,
      },
      relief: "embossed",
      reliefDepth: DEFAULT_LAYOUT_OPTIONS.identityReliefDepth,
    });
    expect(result.identityPanel!.size.x).toBeLessThanOrEqual(result.bounds.x);
    expect(
      result.base!.position.z - result.base!.size.z / 2,
    ).toBeCloseTo(0, 12);
    expect(
      result.identityPanel!.position.y -
        result.identityPanel!.size.y / 2,
    ).toBeLessThan(result.base!.position.y + result.base!.size.y / 2);
    expect(result.bounds.y).toBeGreaterThanOrEqual(
      DEFAULT_LAYOUT_OPTIONS.identityPanelHeight,
    );
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
    expect(result.base).toBeDefined();
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
    expect(result.base?.size.y).toBe(DEFAULT_LAYOUT_OPTIONS.cityBaseHeight);
    expect(result.bounds.y).toBe(1);
  });

  it("supports identity-only and fully empty cities", () => {
    const identityOnly = layoutCity({
      repositories: [],
      modules: [],
      buildings: [],
      identity: { title: "Code City" },
    });
    expect(identityOnly.base).toMatchObject({
      semanticGroupId: "base",
      size: {
        x: DEFAULT_LAYOUT_OPTIONS.identityPanelWidth,
        y: DEFAULT_LAYOUT_OPTIONS.cityBaseHeight,
      },
    });
    expect(identityOnly.base?.size.z).toBe(identityOnly.bounds.z);

    const empty = layoutCity({
      repositories: [],
      modules: [],
      buildings: [],
    });
    expect(empty.base).toBeUndefined();
    expect(empty.bounds).toEqual({ x: 0, y: 0, z: 0 });
  });

  it("validates and applies a custom shared-base height", () => {
    const result = layoutCity(
      {
        repositories: [{ id: "repo", name: "Repository" }],
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
        buildings: [],
      },
      { cityBaseHeight: 0.25 },
    );
    expect(result.base?.size.y).toBe(0.25);

    expect(() => layoutCity(input, { cityBaseHeight: 0 })).toThrow(
      /cityBaseHeight/u,
    );
    expect(() => layoutCity(input, { cityBaseHeight: 1 })).toThrow(
      /less than districtBaseHeight/u,
    );
    expect(() =>
      layoutCity(
        {
          repositories: [],
          modules: [],
          buildings: [],
          identity: { title: "Code City" },
        },
        { identityPanelHeight: DEFAULT_LAYOUT_OPTIONS.cityBaseHeight },
      ),
    ).toThrow(/identityPanelHeight must be greater than cityBaseHeight/u);
  });

  it("packs heterogeneous districts by their actual footprints", () => {
    const moduleSizes = [64, 36, 16, 9, 4, 1];
    const modules = moduleSizes.map((buildingCount, index) => ({
      id: `module-${buildingCount}`,
      repositoryId: "repo",
      kind: "dotnet-project" as const,
      name: `Module ${buildingCount}`,
      path: `src/${String(index + 1).padStart(2, "0")}`,
      solutionIds: [],
    }));
    const buildings = modules.flatMap((module, moduleIndex) =>
      Array.from({ length: moduleSizes[moduleIndex]! }, (_, buildingIndex) => ({
        repositoryId: "repo",
        moduleId: module.id,
        name: `${buildingIndex}.cs`,
        path: `${module.path}/${String(buildingIndex).padStart(2, "0")}.cs`,
        language: "csharp" as const,
        metrics: {
          sloc: 0,
          decisionLoad: 0,
          maximumComplexity: 0,
          executableUnitCount: 0,
        },
      })),
    );
    const result = layoutCity({
      repositories: [{ id: "repo", name: "Repository" }],
      modules: [...modules].reverse(),
      buildings: [...buildings].reverse(),
    });
    const largestWidth = Math.max(
      ...result.districts.map((district) => district.size.x),
    );
    const largestDepth = Math.max(
      ...result.districts.map((district) => district.size.z),
    );
    const legacyColumns = Math.ceil(Math.sqrt(modules.length));
    const legacyRows = Math.ceil(modules.length / legacyColumns);
    const legacyWidth =
      legacyColumns * largestWidth +
      (legacyColumns - 1) * DEFAULT_LAYOUT_OPTIONS.districtGap;
    const legacyDepth =
      legacyRows * largestDepth +
      (legacyRows - 1) * DEFAULT_LAYOUT_OPTIONS.districtGap;
    const occupiedArea = result.districts.reduce(
      (sum, district) => sum + district.size.x * district.size.z,
      0,
    );

    expect(result.districts.map(({ moduleId }) => moduleId)).toEqual(
      modules.map(({ id }) => id),
    );
    expect(result.bounds.x).toBeLessThan(legacyWidth);
    expect(result.bounds.z).toBeLessThan(legacyDepth);
    expect(result.base?.size).toMatchObject({
      x: result.bounds.x,
      z: result.bounds.z,
    });
    expect(occupiedArea).toBeLessThan(
      result.base!.size.x * result.base!.size.z,
    );
    expect(occupiedArea / (result.bounds.x * result.bounds.z)).toBeGreaterThan(
      0.6,
    );
    for (let left = 0; left < result.districts.length; left += 1) {
      for (
        let right = left + 1;
        right < result.districts.length;
        right += 1
      ) {
        const first = result.districts[left]!;
        const second = result.districts[right]!;
        expect(
          hasHorizontalGap(
            first,
            second,
            DEFAULT_LAYOUT_OPTIONS.districtGap,
          ),
        ).toBe(true);
      }
    }
  });

  it("packs heterogeneous repository blocks by their actual footprints", () => {
    const repositorySizes = [16, 4, 1];
    const repositories = repositorySizes.map((buildingCount, index) => ({
      id: `repo-${index}`,
      name: `Repository ${buildingCount}`,
    }));
    const modules = repositories.map((repository, index) => ({
      id: `module-${index}`,
      repositoryId: repository.id,
      kind: "dotnet-project" as const,
      name: `Module ${index}`,
      path: ".",
      solutionIds: [],
    }));
    const buildings = modules.flatMap((module, moduleIndex) =>
      Array.from(
        { length: repositorySizes[moduleIndex]! },
        (_, buildingIndex) => ({
          repositoryId: module.repositoryId,
          moduleId: module.id,
          name: `${buildingIndex}.cs`,
          path: `${buildingIndex}.cs`,
          language: "csharp" as const,
          metrics: {
            sloc: 0,
            decisionLoad: 0,
            maximumComplexity: 0,
            executableUnitCount: 0,
          },
        }),
      ),
    );
    const repositoryInput: CityLayoutInput = {
      repositories,
      modules,
      buildings,
    };
    const result = layoutCity(repositoryInput);
    const largestWidth = Math.max(
      ...result.districts.map((district) => district.size.x),
    );
    const largestDepth = Math.max(
      ...result.districts.map((district) => district.size.z),
    );
    const legacyColumns = Math.ceil(Math.sqrt(repositories.length));
    const legacyRows = Math.ceil(repositories.length / legacyColumns);
    const legacyWidth =
      legacyColumns * largestWidth +
      (legacyColumns - 1) * DEFAULT_LAYOUT_OPTIONS.repositoryGap;
    const legacyDepth =
      legacyRows * largestDepth +
      (legacyRows - 1) * DEFAULT_LAYOUT_OPTIONS.repositoryGap;

    expect(result.bounds.x).toBeLessThan(legacyWidth);
    expect(result.bounds.z).toBeLessThan(legacyDepth);
    expect(
      layoutCity({
        repositories: [...repositories].reverse(),
        modules: [...modules].reverse(),
        buildings: [...buildings].reverse(),
      }),
    ).toEqual(result);
    for (let left = 0; left < result.districts.length; left += 1) {
      for (
        let right = left + 1;
        right < result.districts.length;
        right += 1
      ) {
        expect(
          hasHorizontalGap(
            result.districts[left]!,
            result.districts[right]!,
            DEFAULT_LAYOUT_OPTIONS.repositoryGap,
          ),
        ).toBe(true);
      }
    }
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
