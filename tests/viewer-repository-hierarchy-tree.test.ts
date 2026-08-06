import { describe, expect, it } from "vitest";

import type { CityModel } from "../packages/core/src/model.js";
import {
  createRepositoryHierarchyIndex,
  flattenRepositoryHierarchy,
  MAX_REPOSITORY_TREE_RENDERED_ROWS,
  navigateRepositoryHierarchy,
  repositoryHierarchyAncestorIds,
  repositoryHierarchyNodeIcon,
  repositoryHierarchyProjectKey,
  repositoryHierarchyVisibleActiveId,
  repositoryTreeVirtualWindow,
  type RepositoryHierarchyIndex,
  type RepositoryHierarchyNode,
} from "../apps/viewer/src/repository-hierarchy-tree.js";
import { createSceneEntity } from "../apps/viewer/src/scene-entity.js";

describe("repository hierarchy tree", () => {
  it("uses stable, recognizable SVG metadata for every hierarchy kind", () => {
    const icons = ([
      "repository",
      "solution",
      "module",
      "district",
      "building",
    ] as const).map(repositoryHierarchyNodeIcon);

    expect(icons.map(({ id }) => id)).toEqual([
      "git-repository",
      "solution",
      "package",
      "folder",
      "source-file",
    ]);
    expect(icons.map(({ label }) => label)).toEqual([
      "Repository",
      "Solution",
      "Module",
      "Directory district",
      "Source file",
    ]);
    expect(icons.every(({ paths }) => paths.length > 0)).toBe(true);
    expect(new Set(icons.flatMap(({ paths }) => paths)).size).toBe(
      icons.reduce((total, { paths }) => total + paths.length, 0),
    );
    for (const icon of icons) {
      expect(Object.isFrozen(icon)).toBe(true);
      expect(Object.isFrozen(icon.paths)).toBe(true);
    }
  });

  it("builds one stable repository-to-file path with nested modules", () => {
    const model = hierarchyModel();
    const index = createRepositoryHierarchyIndex(model);
    const buildingId = index.nodeIdForEntity(
      createSceneEntity("building", "building:entry"),
    );
    const districtId = index.nodeIdForEntity(
      createSceneEntity("district", "district:src"),
    );

    expect(index.nodeCount).toBe(6);
    expect(index.roots).toEqual(["repository:repository:demo"]);
    expect(districtId).toBe("district:district:src");
    expect(buildingId).toBe("building:building:entry");
    expect(
      repositoryHierarchyAncestorIds(index, buildingId!),
    ).toEqual([
      "repository:repository:demo",
      "solution:solution:demo",
      "module:module:parent",
      "module:module:child",
      "district:district:src",
    ]);
  });

  it("chooses a deterministic canonical solution for shared modules", () => {
    const model = hierarchyModel();
    const shared = {
      ...model.modules[0]!,
      solutionIds: ["solution:z", "solution:a"],
    };
    const index = createRepositoryHierarchyIndex({
      ...model,
      solutions: [
        {
          id: "solution:z",
          repositoryId: "repository:demo",
          name: "Zulu",
          path: "z.sln",
          moduleIds: [shared.id],
        },
        {
          id: "solution:a",
          repositoryId: "repository:demo",
          name: "Alpha",
          path: "a.sln",
          moduleIds: [shared.id],
        },
      ],
      modules: [shared, model.modules[1]!],
    });

    expect(
      index.nodes.get("module:module:parent")?.parentId,
    ).toBe("solution:solution:a");
  });

  it("falls cyclic module parents back to their canonical solution", () => {
    const model = hierarchyModel();
    const cyclicModules = [
      {
        ...model.modules[0]!,
        parentModuleId: model.modules[1]!.id,
      },
      {
        ...model.modules[1]!,
        parentModuleId: model.modules[0]!.id,
      },
    ];
    const index = createRepositoryHierarchyIndex({
      ...model,
      modules: cyclicModules,
    });

    expect(index.nodes.get("module:module:parent")?.parentId).toBe(
      "solution:solution:demo",
    );
    expect(index.nodes.get("module:module:child")?.parentId).toBe(
      "solution:solution:demo",
    );
    expect(
      repositoryHierarchyAncestorIds(
        index,
        "building:building:entry",
      ),
    ).toEqual([
      "repository:repository:demo",
      "solution:solution:demo",
      "module:module:child",
      "district:district:src",
    ]);
  });

  it("flattens only expanded branches and reports accessible set metadata", () => {
    const index = createRepositoryHierarchyIndex(hierarchyModel());
    const collapsed = flattenRepositoryHierarchy(
      index,
      new Set(index.roots),
    );
    expect(collapsed.map(({ node }) => node.kind)).toEqual([
      "repository",
      "solution",
    ]);

    const expanded = new Set(index.nodes.keys());
    const rows = flattenRepositoryHierarchy(index, expanded);
    expect(rows.map(({ node }) => node.kind)).toEqual([
      "repository",
      "solution",
      "module",
      "module",
      "district",
      "building",
    ]);
    expect(rows.at(-1)).toMatchObject({
      depth: 6,
      positionInSet: 1,
      setSize: 1,
    });

    expect(
      repositoryHierarchyVisibleActiveId(
        index,
        collapsed,
        "building:building:entry",
      ),
    ).toBe("solution:solution:demo");
  });

  it("flattens deeply nested modules without recursive stack growth", () => {
    const depth = 12_000;
    const nodes = new Map<string, RepositoryHierarchyNode>();
    for (let index = 0; index < depth; index += 1) {
      const id = `module:deep-${index}`;
      nodes.set(id, {
        id,
        entityId: `deep-${index}`,
        kind: "module",
        label: `Module ${index}`,
        parentId: index === 0 ? null : `module:deep-${index - 1}`,
        childIds:
          index === depth - 1 ? [] : [`module:deep-${index + 1}`],
      });
    }
    const hierarchy: RepositoryHierarchyIndex = {
      roots: ["module:deep-0"],
      nodes,
      nodeCount: nodes.size,
      nodeIdForEntity: () => undefined,
    };

    const rows = flattenRepositoryHierarchy(
      hierarchy,
      new Set(nodes.keys()),
    );
    expect(rows).toHaveLength(depth);
    expect(rows.at(-1)?.depth).toBe(depth);
  });

  it("indexes a maximum-depth parent chain in linear work", () => {
    const depth = 10_000;
    const moduleIds = Array.from(
      { length: depth },
      (_, index) => `module:deep-${index}`,
    );
    const index = createRepositoryHierarchyIndex({
      repositories: [{ id: "repository:deep", name: "Deep" }],
      solutions: [
        {
          id: "solution:deep",
          repositoryId: "repository:deep",
          name: "Deep",
          path: "deep.sln",
          moduleIds,
        },
      ],
      modules: moduleIds.map((id, moduleIndex) => ({
        id,
        repositoryId: "repository:deep",
        ...(moduleIndex === 0
          ? {}
          : { parentModuleId: moduleIds[moduleIndex - 1] }),
        kind: "npm-package" as const,
        name: `Module ${moduleIndex}`,
        path: `src/${moduleIndex}`,
        solutionIds: ["solution:deep"],
      })),
      districts: [],
      buildings: [],
    });

    expect(index.nodeCount).toBe(depth + 2);
    expect(
      repositoryHierarchyAncestorIds(
        index,
        `module:${moduleIds.at(-1)!}`,
      ),
    ).toHaveLength(depth + 1);
  });

  it("keeps virtualized rendering bounded for a 25k repository", () => {
    const middle = repositoryTreeVirtualWindow(
      25_202,
      400_000,
      380,
    );
    expect(middle.start).toBeGreaterThan(0);
    expect(middle.end).toBeLessThan(25_202);
    expect(middle.end - middle.start).toBeLessThanOrEqual(
      MAX_REPOSITORY_TREE_RENDERED_ROWS,
    );
    expect(middle.offset).toBe(middle.start * 32);

    const oversizedViewport = repositoryTreeVirtualWindow(
      25_202,
      0,
      1_000_000,
    );
    expect(
      oversizedViewport.end - oversizedViewport.start,
    ).toBe(MAX_REPOSITORY_TREE_RENDERED_ROWS);
    expect(repositoryTreeVirtualWindow(0, 100, 300)).toEqual({
      start: 0,
      end: 0,
      offset: 0,
    });
  });

  it("implements conventional tree keyboard navigation", () => {
    const index = createRepositoryHierarchyIndex(hierarchyModel());
    const expanded = new Set(index.roots);
    let rows = flattenRepositoryHierarchy(index, expanded);
    const solutionId = "solution:solution:demo";

    expect(
      navigateRepositoryHierarchy(
        index,
        rows,
        expanded,
        undefined,
        "ArrowDown",
      ).activeId,
    ).toBe(index.roots[0]);
    expect(
      navigateRepositoryHierarchy(
        index,
        rows,
        expanded,
        index.roots[0],
        "ArrowDown",
      ).activeId,
    ).toBe(solutionId);
    expect(
      navigateRepositoryHierarchy(
        index,
        rows,
        expanded,
        solutionId,
        "ArrowRight",
      ),
    ).toEqual({
      activeId: solutionId,
      expansion: {
        nodeId: solutionId,
        expanded: true,
      },
    });

    expanded.add(solutionId);
    rows = flattenRepositoryHierarchy(index, expanded);
    expect(
      navigateRepositoryHierarchy(
        index,
        rows,
        expanded,
        solutionId,
        "ArrowRight",
      ).activeId,
    ).toBe("module:module:parent");
    expect(
      navigateRepositoryHierarchy(
        index,
        rows,
        expanded,
        "module:module:parent",
        "ArrowLeft",
      ).activeId,
    ).toBe(solutionId);
    expect(
      navigateRepositoryHierarchy(
        index,
        rows,
        expanded,
        solutionId,
        "End",
      ).activeId,
    ).toBe("module:module:parent");
  });

  it("uses repository identity instead of entity counts for project state", () => {
    const model = hierarchyModel();
    const reversed = {
      ...model,
      repositories: [...model.repositories].reverse(),
      buildings: [],
    };
    expect(repositoryHierarchyProjectKey(model, "job:42")).toBe(
      repositoryHierarchyProjectKey(reversed, "job:42"),
    );
    expect(repositoryHierarchyProjectKey(model, "job:42")).not.toBe(
      repositoryHierarchyProjectKey(model, "job:43"),
    );
    expect(
      repositoryHierarchyProjectKey(
        { repositories: [{ id: "b\u001ec", name: "A" }] },
        "a",
      ),
    ).not.toBe(
      repositoryHierarchyProjectKey(
        { repositories: [{ id: "c", name: "B" }] },
        "a\u001eb",
      ),
    );
  });
});

function hierarchyModel(): Pick<
  CityModel,
  | "repositories"
  | "solutions"
  | "modules"
  | "districts"
  | "buildings"
> {
  return {
    repositories: [
      { id: "repository:demo", name: "Demo repository" },
    ],
    solutions: [
      {
        id: "solution:demo",
        repositoryId: "repository:demo",
        name: "Demo solution",
        path: "demo.sln",
        moduleIds: ["module:parent", "module:child"],
      },
    ],
    modules: [
      {
        id: "module:parent",
        repositoryId: "repository:demo",
        kind: "npm-package",
        name: "Workspace",
        path: ".",
        solutionIds: ["solution:demo"],
      },
      {
        id: "module:child",
        repositoryId: "repository:demo",
        parentModuleId: "module:parent",
        kind: "npm-package",
        name: "Application",
        path: "src",
        solutionIds: ["solution:demo"],
      },
    ],
    districts: [
      {
        id: "district:src",
        repositoryId: "repository:demo",
        moduleId: "module:child",
        name: "src",
        path: "src",
        position: { x: 0, y: 0.5, z: 0 },
        size: { x: 10, y: 1, z: 10 },
      },
    ],
    buildings: [
      {
        id: "building:entry",
        repositoryId: "repository:demo",
        moduleId: "module:child",
        districtId: "district:src",
        name: "index.ts",
        path: "src/index.ts",
        language: "typescript",
        metrics: {
          sloc: 10,
          decisionLoad: 2,
          maximumComplexity: 2,
          executableUnitCount: 1,
        },
        risk: "low",
        semanticGroupId: "group",
        position: { x: 0, y: 1.5, z: 0 },
        size: { x: 1, y: 2, z: 1 },
      },
    ],
  };
}
