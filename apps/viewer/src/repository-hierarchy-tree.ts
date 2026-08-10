import type {
  CityBuilding,
  CityDistrict,
  CityModel,
  CityModule,
  CityRepository,
  CitySolution,
} from "../../../packages/core/src/model.js";
import {
  createSceneEntity,
  type SceneEntity,
} from "./scene-entity.js";
import type { ExplorerState } from "./repository-explorer.js";

export const REPOSITORY_TREE_ROW_HEIGHT = 32;
export const REPOSITORY_TREE_OVERSCAN_ROWS = 5;
export const MAX_REPOSITORY_TREE_RENDERED_ROWS = 160;
export const MAX_REPOSITORY_TREE_PROJECT_STATES = 8;

export type RepositoryHierarchyNodeKind =
  | "repository"
  | "solution"
  | "module"
  | "district"
  | "building";

export type RepositoryHierarchyNodeIconId =
  | "git-repository"
  | "solution"
  | "package"
  | "folder"
  | "source-file";

export interface RepositoryHierarchyNodeIcon {
  readonly id: RepositoryHierarchyNodeIconId;
  readonly label: string;
  readonly paths: readonly string[];
}

export interface RepositoryHierarchyNode {
  readonly id: string;
  readonly entityId: string;
  readonly kind: RepositoryHierarchyNodeKind;
  readonly label: string;
  readonly path?: string;
  readonly parentId: string | null;
  readonly childIds: readonly string[];
  readonly sceneEntity?: SceneEntity;
  readonly districtId?: string;
}

export interface RepositoryHierarchyIndex {
  readonly roots: readonly string[];
  readonly nodes: ReadonlyMap<string, RepositoryHierarchyNode>;
  readonly nodeCount: number;
  nodeIdForEntity(entity: SceneEntity): string | undefined;
}

export interface RepositoryHierarchyRow {
  readonly node: RepositoryHierarchyNode;
  readonly depth: number;
  readonly positionInSet: number;
  readonly setSize: number;
}

export interface RepositoryTreeVirtualWindow {
  readonly start: number;
  readonly end: number;
  readonly offset: number;
}

export type RepositoryTreeNavigationKey =
  | "ArrowDown"
  | "ArrowUp"
  | "ArrowRight"
  | "ArrowLeft"
  | "Home"
  | "End";

export interface RepositoryTreeNavigation {
  readonly activeId: string | undefined;
  readonly expansion?: {
    readonly nodeId: string;
    readonly expanded: boolean;
  };
}

export interface RepositoryHierarchyTreeController {
  setModel(
    model: Pick<
      CityModel,
      | "repositories"
      | "solutions"
      | "modules"
      | "districts"
      | "buildings"
    >,
    projectKey: string,
  ): void;
  synchronize(
    state: ExplorerState,
    selectedBuildingIds?: readonly string[],
  ): void;
  reveal(): void;
  dispose(): void;
}

export interface RepositoryHierarchyTreeInstallOptions {
  readonly tree: HTMLElement;
  readonly status: HTMLElement;
  readonly model: Pick<
    CityModel,
    | "repositories"
    | "solutions"
    | "modules"
    | "districts"
    | "buildings"
  >;
  readonly projectKey: string;
  readonly onActivate: (
    entity: SceneEntity,
    intent: RepositoryHierarchyActivationIntent,
  ) => void;
  readonly window?: Window;
}

export interface RepositoryHierarchyActivationIntent {
  readonly additive: boolean;
  readonly range: boolean;
  readonly orderedBuildingIds?: readonly string[];
}

interface MutableNode {
  readonly id: string;
  readonly entityId: string;
  readonly kind: RepositoryHierarchyNodeKind;
  readonly label: string;
  readonly path?: string;
  parentId: string | null;
  readonly childIds: string[];
  readonly sceneEntity?: SceneEntity;
  readonly districtId?: string;
}

interface RepositoryTreeProjectState {
  readonly expandedIds: readonly string[];
  readonly activeId?: string;
  readonly scrollTop: number;
}

const KIND_ORDER: Readonly<Record<RepositoryHierarchyNodeKind, number>> =
  Object.freeze({
    repository: 0,
    solution: 1,
    module: 2,
    district: 3,
    building: 4,
  });

const NODE_KIND_ICONS = Object.freeze({
  repository: Object.freeze({
    id: "git-repository",
    label: "Repository",
    paths: Object.freeze([
      "M4 5.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm0 0v5a2 2 0 0 0 2 2h2.5M10 13.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM10 5.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm0 0v1a2 2 0 0 1-2 2H4",
    ]),
  }),
  solution: Object.freeze({
    id: "solution",
    label: "Solution",
    paths: Object.freeze([
      "M2.5 4.5h7v7h-7z",
      "M6.5 2.5h7v7h-2",
    ]),
  }),
  module: Object.freeze({
    id: "package",
    label: "Module",
    paths: Object.freeze([
      "M2.5 5 8 2l5.5 3v6L8 14l-5.5-3V5Z",
      "M2.5 5 8 8l5.5-3M8 8v6",
    ]),
  }),
  district: Object.freeze({
    id: "folder",
    label: "Directory district",
    paths: Object.freeze([
      "M2 4h4l1.5 1.5H14v7.5H2V4Z",
    ]),
  }),
  building: Object.freeze({
    id: "source-file",
    label: "Source file",
    paths: Object.freeze([
      "M4 2h5l3 3v9H4V2Z",
      "M9 2v3h3M7 8 5.5 9.5 7 11M9 8l1.5 1.5L9 11",
    ]),
  }),
}) satisfies Readonly<
  Record<RepositoryHierarchyNodeKind, RepositoryHierarchyNodeIcon>
>;

export function repositoryHierarchyNodeIcon(
  kind: RepositoryHierarchyNodeKind,
): RepositoryHierarchyNodeIcon {
  return NODE_KIND_ICONS[kind];
}

const navigationKeys = new Set<RepositoryTreeNavigationKey>([
  "ArrowDown",
  "ArrowUp",
  "ArrowRight",
  "ArrowLeft",
  "Home",
  "End",
]);

export function createRepositoryHierarchyIndex(
  model: Pick<
    CityModel,
    | "repositories"
    | "solutions"
    | "modules"
    | "districts"
    | "buildings"
  >,
): RepositoryHierarchyIndex {
  const mutable = new Map<string, MutableNode>();
  const entityNodes = new Map<string, string>();
  const repositoryNodes = new Map<string, string>();
  const solutionNodes = new Map<string, string>();
  const moduleNodes = new Map<string, string>();
  const districtNodes = new Map<string, string>();
  const solutionsById = new Map(
    model.solutions.map((solution) => [solution.id, solution]),
  );
  const modulesById = new Map(
    model.modules.map((module) => [module.id, module]),
  );

  for (const repository of model.repositories) {
    const node = repositoryNode(repository);
    mutable.set(node.id, node);
    repositoryNodes.set(repository.id, node.id);
  }
  for (const solution of model.solutions) {
    const node = solutionNode(solution);
    mutable.set(node.id, node);
    solutionNodes.set(solution.id, node.id);
  }
  for (const module of model.modules) {
    const node = moduleNode(module);
    mutable.set(node.id, node);
    moduleNodes.set(module.id, node.id);
  }
  for (const district of model.districts) {
    const node = districtNode(district);
    mutable.set(node.id, node);
    districtNodes.set(district.id, node.id);
    entityNodes.set(sceneEntityKey(node.sceneEntity!), node.id);
  }
  for (const building of model.buildings) {
    const node = buildingNode(building);
    mutable.set(node.id, node);
    entityNodes.set(sceneEntityKey(node.sceneEntity!), node.id);
  }

  const solutionsByModule = new Map<string, string[]>();
  for (const solution of model.solutions) {
    for (const moduleId of solution.moduleIds) {
      const solutionIds = solutionsByModule.get(moduleId) ?? [];
      solutionIds.push(solution.id);
      solutionsByModule.set(moduleId, solutionIds);
    }
  }

  const moduleParentCandidates = new Map<string, string>();
  for (const module of model.modules) {
    const parent =
      module.parentModuleId === undefined
        ? undefined
        : modulesById.get(module.parentModuleId);
    if (parent?.repositoryId === module.repositoryId) {
      moduleParentCandidates.set(module.id, parent.id);
    }
  }
  const moduleParents = acyclicModuleParents(moduleParentCandidates);

  for (const solution of model.solutions) {
    attach(
      mutable,
      solutionNodes.get(solution.id),
      repositoryNodes.get(solution.repositoryId),
    );
  }
  for (const module of model.modules) {
    const moduleNodeId = moduleNodes.get(module.id);
    const parentModuleId = moduleParents.get(module.id);
    const solutionId = canonicalSolutionId(
      module,
      solutionsByModule.get(module.id) ?? [],
      solutionsById,
    );
    attach(
      mutable,
      moduleNodeId,
      (parentModuleId === undefined
        ? undefined
        : moduleNodes.get(parentModuleId)) ??
        (solutionId === undefined
          ? undefined
          : solutionNodes.get(solutionId)) ??
        repositoryNodes.get(module.repositoryId),
    );
  }
  for (const district of model.districts) {
    attach(
      mutable,
      districtNodes.get(district.id),
      moduleNodes.get(district.moduleId) ??
        repositoryNodes.get(district.repositoryId),
    );
  }
  for (const building of model.buildings) {
    attach(
      mutable,
      nodeId("building", building.id),
      districtNodes.get(building.districtId) ??
        moduleNodes.get(building.moduleId) ??
        repositoryNodes.get(building.repositoryId),
    );
  }

  const roots = [...mutable.values()]
    .filter(({ parentId }) => parentId === null)
    .sort(compareMutableNodes)
    .map(({ id }) => id);
  const nodes = new Map<string, RepositoryHierarchyNode>();
  for (const node of mutable.values()) {
    node.childIds.sort((leftId, rightId) => {
      const left = mutable.get(leftId);
      const right = mutable.get(rightId);
      return left === undefined
        ? 1
        : right === undefined
          ? -1
          : compareMutableNodes(left, right);
    });
    nodes.set(
      node.id,
      Object.freeze({
        id: node.id,
        entityId: node.entityId,
        kind: node.kind,
        label: node.label,
        ...(node.path === undefined ? {} : { path: node.path }),
        parentId: node.parentId,
        childIds: Object.freeze([...node.childIds]),
        ...(node.sceneEntity === undefined
          ? {}
          : { sceneEntity: node.sceneEntity }),
        ...(node.districtId === undefined
          ? {}
          : { districtId: node.districtId }),
      }),
    );
  }
  return Object.freeze({
    roots: Object.freeze(roots),
    nodes,
    nodeCount: nodes.size,
    nodeIdForEntity: (entity: SceneEntity) =>
      entityNodes.get(sceneEntityKey(entity)),
  });
}

export function flattenRepositoryHierarchy(
  index: RepositoryHierarchyIndex,
  expandedIds: ReadonlySet<string>,
): readonly RepositoryHierarchyRow[] {
  const rows: RepositoryHierarchyRow[] = [];
  const pending: {
    readonly nodeId: string;
    readonly depth: number;
    readonly positionInSet: number;
    readonly setSize: number;
  }[] = [];
  for (
    let indexInRoots = index.roots.length - 1;
    indexInRoots >= 0;
    indexInRoots -= 1
  ) {
    pending.push({
      nodeId: index.roots[indexInRoots]!,
      depth: 1,
      positionInSet: indexInRoots + 1,
      setSize: index.roots.length,
    });
  }
  while (pending.length > 0) {
    const current = pending.pop()!;
    const node = index.nodes.get(current.nodeId);
    if (node === undefined) continue;
    rows.push(
      Object.freeze({
        node,
        depth: current.depth,
        positionInSet: current.positionInSet,
        setSize: current.setSize,
      }),
    );
    if (!expandedIds.has(node.id)) continue;
    for (
      let childIndex = node.childIds.length - 1;
      childIndex >= 0;
      childIndex -= 1
    ) {
      pending.push({
        nodeId: node.childIds[childIndex]!,
        depth: current.depth + 1,
        positionInSet: childIndex + 1,
        setSize: node.childIds.length,
      });
    }
  }
  return Object.freeze(rows);
}

export function repositoryHierarchyAncestorIds(
  index: RepositoryHierarchyIndex,
  nodeId: string,
): readonly string[] {
  const ancestors: string[] = [];
  const visited = new Set<string>();
  let current = index.nodes.get(nodeId);
  while (current?.parentId !== null && current?.parentId !== undefined) {
    if (visited.has(current.parentId)) break;
    visited.add(current.parentId);
    ancestors.push(current.parentId);
    current = index.nodes.get(current.parentId);
  }
  return Object.freeze(ancestors.reverse());
}

export function repositoryHierarchyVisibleActiveId(
  index: RepositoryHierarchyIndex,
  rows: readonly RepositoryHierarchyRow[],
  activeId: string | undefined,
): string | undefined {
  if (rows.length === 0) return undefined;
  const visibleIds = new Set(rows.map(({ node }) => node.id));
  let candidate = activeId;
  const visited = new Set<string>();
  while (candidate !== undefined && !visibleIds.has(candidate)) {
    if (visited.has(candidate)) return rows[0]!.node.id;
    visited.add(candidate);
    candidate =
      index.nodes.get(candidate)?.parentId ?? undefined;
  }
  return candidate ?? rows[0]!.node.id;
}

export function repositoryTreeVirtualWindow(
  totalRows: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight = REPOSITORY_TREE_ROW_HEIGHT,
  overscan = REPOSITORY_TREE_OVERSCAN_ROWS,
): RepositoryTreeVirtualWindow {
  const total = safeWholeNumber(totalRows);
  const height = positiveWholeNumber(rowHeight, REPOSITORY_TREE_ROW_HEIGHT);
  const viewport = positiveWholeNumber(viewportHeight, height * 10);
  const extra = safeWholeNumber(overscan);
  const firstVisible = Math.min(
    Math.max(0, total - 1),
    Math.floor(Math.max(0, finiteNumber(scrollTop)) / height),
  );
  const requested =
    Math.ceil(viewport / height) + extra * 2;
  const count = Math.min(
    total,
    MAX_REPOSITORY_TREE_RENDERED_ROWS,
    Math.max(1, requested),
  );
  const start = Math.max(
    0,
    Math.min(
      total - count,
      firstVisible - Math.min(extra, Math.floor(count / 2)),
    ),
  );
  const end = Math.min(total, start + count);
  return Object.freeze({
    start,
    end,
    offset: start * height,
  });
}

export function navigateRepositoryHierarchy(
  index: RepositoryHierarchyIndex,
  rows: readonly RepositoryHierarchyRow[],
  expandedIds: ReadonlySet<string>,
  activeId: string | undefined,
  key: RepositoryTreeNavigationKey,
): RepositoryTreeNavigation {
  if (rows.length === 0) return Object.freeze({ activeId: undefined });
  let activeIndex = rows.findIndex(({ node }) => node.id === activeId);
  if (activeIndex < 0) {
    return Object.freeze({
      activeId: key === "End" ? rows.at(-1)!.node.id : rows[0]!.node.id,
    });
  }
  const active = rows[activeIndex]!;
  switch (key) {
    case "ArrowDown":
      return Object.freeze({
        activeId: rows[Math.min(rows.length - 1, activeIndex + 1)]!.node.id,
      });
    case "ArrowUp":
      return Object.freeze({
        activeId: rows[Math.max(0, activeIndex - 1)]!.node.id,
      });
    case "Home":
      return Object.freeze({ activeId: rows[0]!.node.id });
    case "End":
      return Object.freeze({ activeId: rows.at(-1)!.node.id });
    case "ArrowRight":
      if (active.node.childIds.length === 0) {
        return Object.freeze({ activeId: active.node.id });
      }
      if (!expandedIds.has(active.node.id)) {
        return Object.freeze({
          activeId: active.node.id,
          expansion: Object.freeze({
            nodeId: active.node.id,
            expanded: true,
          }),
        });
      }
      return Object.freeze({
        activeId:
          rows.find(
            (row, indexInRows) =>
              indexInRows > activeIndex &&
              row.node.parentId === active.node.id,
          )?.node.id ?? active.node.id,
      });
    case "ArrowLeft":
      if (
        active.node.childIds.length > 0 &&
        expandedIds.has(active.node.id)
      ) {
        return Object.freeze({
          activeId: active.node.id,
          expansion: Object.freeze({
            nodeId: active.node.id,
            expanded: false,
          }),
        });
      }
      return Object.freeze({
        activeId:
          active.node.parentId !== null &&
          index.nodes.has(active.node.parentId)
            ? active.node.parentId
            : active.node.id,
      });
  }
}

export function repositoryHierarchyProjectKey(
  model: Pick<CityModel, "repositories">,
  sourceKey: string,
): string {
  const repositories = model.repositories
    .map(({ id }) => id)
    .sort(compareText);
  return (
    `source:${identityPart(sourceKey)}` +
    `repositories:${repositories.length}:` +
    repositories.map(identityPart).join("")
  );
}

export function installRepositoryHierarchyTree(
  options: RepositoryHierarchyTreeInstallOptions,
): RepositoryHierarchyTreeController {
  return new RepositoryHierarchyTree(options);
}

class RepositoryHierarchyTree
  implements RepositoryHierarchyTreeController
{
  readonly #tree: HTMLElement;
  readonly #status: HTMLElement;
  readonly #content: HTMLElement;
  readonly #onActivate: (
    entity: SceneEntity,
    intent: RepositoryHierarchyActivationIntent,
  ) => void;
  readonly #window: Window;
  readonly #projectStates = new Map<string, RepositoryTreeProjectState>();
  readonly #abort = new AbortController();
  #index: RepositoryHierarchyIndex;
  #projectKey: string;
  #expandedIds = new Set<string>();
  #activeId: string | undefined;
  #selectedNodeIds = new Set<string>();
  #rows: readonly RepositoryHierarchyRow[] = [];
  #renderFrame: number | undefined;
  #pendingScrollTop: number | undefined;
  #pendingActiveReveal = false;
  #renderRevision = 0;
  #lastRenderSignature = "";
  #lastHandledScrollTop = 0;

  public constructor(options: RepositoryHierarchyTreeInstallOptions) {
    this.#tree = options.tree;
    this.#status = options.status;
    this.#content = this.#tree.ownerDocument.createElement("div");
    this.#content.className = "repository-tree-content";
    this.#tree.replaceChildren(this.#content);
    this.#onActivate = options.onActivate;
    this.#window = options.window ?? window;
    this.#index = createRepositoryHierarchyIndex(options.model);
    this.#projectKey = options.projectKey;
    this.#expandedIds = new Set(this.#index.roots);
    this.#rows = flattenRepositoryHierarchy(
      this.#index,
      this.#expandedIds,
    );
    this.#activeId = this.#rows[0]?.node.id;
    this.#tree.setAttribute("role", "tree");
    this.#tree.setAttribute("aria-multiselectable", "true");
    this.#tree.setAttribute("tabindex", "0");
    this.#tree.addEventListener(
      "scroll",
      () => this.#handleScroll(),
      { passive: true, signal: this.#abort.signal },
    );
    this.#tree.addEventListener(
      "keydown",
      (event) => this.#handleKeydown(event),
      { signal: this.#abort.signal },
    );
    this.#tree.addEventListener(
      "click",
      (event) => this.#handleClick(event),
      { signal: this.#abort.signal },
    );
    this.#window.addEventListener(
      "resize",
      () => {
        this.#restorePendingViewport();
        this.#scheduleRender();
      },
      { signal: this.#abort.signal },
    );
    this.#render();
  }

  public setModel(
    model: Pick<
      CityModel,
      | "repositories"
      | "solutions"
      | "modules"
      | "districts"
      | "buildings"
    >,
    projectKey: string,
  ): void {
    const currentState: RepositoryTreeProjectState = {
      expandedIds: [...this.#expandedIds],
      ...(this.#activeId === undefined
        ? {}
        : { activeId: this.#activeId }),
      scrollTop: this.#effectiveScrollTop(),
    };
    this.#saveProjectState();
    this.#pendingScrollTop = undefined;
    this.#pendingActiveReveal = false;
    this.#index = createRepositoryHierarchyIndex(model);
    const sameProject = projectKey === this.#projectKey;
    this.#projectKey = projectKey;
    const stored = sameProject
      ? currentState
      : this.#projectStates.get(projectKey);
    this.#expandedIds = new Set(
      stored?.expandedIds ?? this.#index.roots,
    );
    this.#activeId = stored?.activeId;
    this.#rebuildRows();
    this.#activeId ??= this.#rows[0]?.node.id;
    this.#selectedNodeIds = new Set();
    this.#render();
    this.#setScrollTopWhenVisible(stored?.scrollTop ?? 0);
    this.#render();
  }

  public synchronize(
    state: ExplorerState,
    selectedBuildingIds?: readonly string[],
  ): void {
    const previousSelection = [...this.#selectedNodeIds];
    const selected =
      state.selectedEntity === null
        ? undefined
        : this.#index.nodeIdForEntity(state.selectedEntity);
    const selectedNodeIds = new Set<string>();
    if (selected !== undefined) selectedNodeIds.add(selected);
    for (const buildingId of selectedBuildingIds ?? []) {
      const nodeId = this.#index.nodeIdForEntity(
        createSceneEntity("building", buildingId),
      );
      if (nodeId !== undefined) selectedNodeIds.add(nodeId);
    }
    this.#selectedNodeIds = selectedNodeIds;
    if (!sameStringSet(previousSelection, this.#selectedNodeIds)) {
      this.#renderRevision += 1;
    }
    if (selected !== undefined) {
      let rowsChanged = false;
      for (const ancestor of repositoryHierarchyAncestorIds(
        this.#index,
        selected,
      )) {
        if (!this.#expandedIds.has(ancestor)) {
          this.#expandedIds.add(ancestor);
          rowsChanged = true;
        }
      }
      const activeChanged = this.#activeId !== selected;
      this.#activeId = selected;
      if (rowsChanged) {
        this.#rebuildRows();
      } else if (activeChanged) {
        this.#renderRevision += 1;
      }
      this.#pendingActiveReveal = true;
      this.#render();
      this.#ensureActiveVisible();
    } else {
      this.#pendingActiveReveal = false;
    }
    this.#render();
  }

  public reveal(): void {
    this.#restorePendingViewport();
    this.#render();
  }

  public dispose(): void {
    this.#saveProjectState();
    this.#abort.abort();
    if (this.#renderFrame !== undefined) {
      this.#window.cancelAnimationFrame(this.#renderFrame);
      this.#renderFrame = undefined;
    }
  }

  #handleKeydown(event: KeyboardEvent): void {
    if (navigationKeys.has(event.key as RepositoryTreeNavigationKey)) {
      event.preventDefault();
      const navigation = navigateRepositoryHierarchy(
        this.#index,
        this.#rows,
        this.#expandedIds,
        this.#activeId,
        event.key as RepositoryTreeNavigationKey,
      );
      this.#activeId = navigation.activeId;
      this.#renderRevision += 1;
      if (navigation.expansion !== undefined) {
        this.#setExpanded(
          navigation.expansion.nodeId,
          navigation.expansion.expanded,
        );
      }
      this.#ensureActiveVisible();
      this.#render();
      return;
    }
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    const node =
      this.#activeId === undefined
        ? undefined
        : this.#index.nodes.get(this.#activeId);
    if (node === undefined) return;
    this.#activate(node, {
      additive: event.ctrlKey || event.metaKey,
      range: event.shiftKey,
      ...(event.shiftKey
        ? { orderedBuildingIds: this.#visibleBuildingIds() }
        : {}),
    });
  }

  #handleScroll(): void {
    const scrollTop = this.#tree.scrollTop;
    if (Math.abs(scrollTop - this.#lastHandledScrollTop) < 0.5) {
      return;
    }
    this.#lastHandledScrollTop = scrollTop;
    this.#scheduleRender();
  }

  #handleClick(event: MouseEvent): void {
    const target =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>("[data-tree-node-id]")
        : null;
    const nodeId = target?.dataset["treeNodeId"];
    if (nodeId === undefined) return;
    const node = this.#index.nodes.get(nodeId);
    if (node === undefined) return;
    this.#activeId = node.id;
    this.#renderRevision += 1;
    this.#tree.focus({ preventScroll: true });
    const toggle =
      event.target instanceof Element
        ? event.target.closest("[data-tree-toggle]")
        : null;
    if (toggle !== null) {
      this.#setExpanded(node.id, !this.#expandedIds.has(node.id));
      this.#render();
      return;
    }
    this.#activate(node, {
      additive: event.ctrlKey || event.metaKey,
      range: event.shiftKey,
      ...(event.shiftKey
        ? { orderedBuildingIds: this.#visibleBuildingIds() }
        : {}),
    });
  }

  #activate(
    node: RepositoryHierarchyNode,
    intent: RepositoryHierarchyActivationIntent,
  ): void {
    if (node.sceneEntity !== undefined) {
      this.#onActivate(node.sceneEntity, intent);
      return;
    }
    if (node.childIds.length > 0) {
      this.#setExpanded(node.id, !this.#expandedIds.has(node.id));
      this.#render();
    }
  }

  #visibleBuildingIds(): readonly string[] {
    return Object.freeze(
      this.#rows
        .filter(({ node }) => node.kind === "building")
        .map(({ node }) => node.entityId),
    );
  }

  #setExpanded(nodeId: string, expanded: boolean): void {
    if (expanded) this.#expandedIds.add(nodeId);
    else this.#expandedIds.delete(nodeId);
    this.#rebuildRows();
  }

  #rebuildRows(): void {
    this.#rows = flattenRepositoryHierarchy(
      this.#index,
      this.#expandedIds,
    );
    this.#renderRevision += 1;
    this.#activeId = repositoryHierarchyVisibleActiveId(
      this.#index,
      this.#rows,
      this.#activeId,
    );
  }

  #ensureActiveVisible(): void {
    const activeIndex = this.#rows.findIndex(
      ({ node }) => node.id === this.#activeId,
    );
    if (activeIndex < 0) return;
    if (this.#tree.clientHeight <= 0) {
      this.#pendingActiveReveal = true;
      return;
    }
    this.#pendingActiveReveal = false;
    const rowTop = activeIndex * REPOSITORY_TREE_ROW_HEIGHT;
    const rowBottom = rowTop + REPOSITORY_TREE_ROW_HEIGHT;
    const viewportHeight = this.#tree.clientHeight;
    if (rowTop < this.#tree.scrollTop) {
      this.#tree.scrollTop = rowTop;
    } else if (
      rowBottom >
      this.#tree.scrollTop + viewportHeight
    ) {
      this.#tree.scrollTop = rowBottom - viewportHeight;
    }
    this.#lastHandledScrollTop = this.#tree.scrollTop;
  }

  #setScrollTopWhenVisible(scrollTop: number): void {
    const bounded = Math.max(0, finiteNumber(scrollTop));
    if (this.#tree.clientHeight <= 0) {
      this.#pendingScrollTop = bounded;
      return;
    }
    this.#tree.scrollTop = bounded;
    this.#lastHandledScrollTop = this.#tree.scrollTop;
    this.#pendingScrollTop = undefined;
  }

  #restorePendingViewport(): void {
    if (this.#tree.clientHeight <= 0) return;
    if (this.#pendingScrollTop !== undefined) {
      this.#tree.scrollTop = this.#pendingScrollTop;
      this.#lastHandledScrollTop = this.#tree.scrollTop;
      this.#pendingScrollTop = undefined;
    }
    if (this.#pendingActiveReveal) {
      this.#ensureActiveVisible();
    }
  }

  #scheduleRender(): void {
    if (this.#renderFrame !== undefined) return;
    this.#renderFrame = this.#window.requestAnimationFrame(() => {
      this.#renderFrame = undefined;
      this.#render();
    });
  }

  #render(): void {
    const viewportHeight =
      this.#tree.clientHeight || REPOSITORY_TREE_ROW_HEIGHT * 10;
    const window = repositoryTreeVirtualWindow(
      this.#rows.length,
      this.#tree.scrollTop,
      viewportHeight,
    );
    const renderedIndexes = new Set<number>();
    for (let index = window.start; index < window.end; index += 1) {
      renderedIndexes.add(index);
    }
    const activeIndex = this.#rows.findIndex(
      ({ node }) => node.id === this.#activeId,
    );
    if (activeIndex >= 0 && !renderedIndexes.has(activeIndex)) {
      if (
        renderedIndexes.size >= MAX_REPOSITORY_TREE_RENDERED_ROWS
      ) {
        const edgeToDiscard =
          activeIndex < window.start ? window.end - 1 : window.start;
        renderedIndexes.delete(edgeToDiscard);
      }
      renderedIndexes.add(activeIndex);
    }
    const renderSignature =
      `${this.#renderRevision}:${window.start}:${window.end}:` +
      `${activeIndex}`;
    if (renderSignature === this.#lastRenderSignature) return;
    this.#lastRenderSignature = renderSignature;

    this.#content.style.height =
      `${this.#rows.length * REPOSITORY_TREE_ROW_HEIGHT}px`;
    const desiredIndexes = [...renderedIndexes].sort(
      (left, right) => left - right,
    );
    const desired = new Set(desiredIndexes);
    const existing = new Map<number, HTMLElement>();
    for (const child of [
      ...this.#content.querySelectorAll<HTMLElement>(
        ":scope > [data-tree-row-index]",
      ),
    ]) {
      const index = Number(child.dataset["treeRowIndex"]);
      if (!Number.isSafeInteger(index) || !desired.has(index)) {
        child.remove();
      } else {
        existing.set(index, child);
      }
    }
    for (const index of desiredIndexes) {
      const row = this.#rows[index];
      if (row === undefined) continue;
      const current = existing.get(index);
      if (
        current?.dataset["treeRenderRevision"] ===
          String(this.#renderRevision) &&
        current.dataset["treeNodeId"] === row.node.id
      ) {
        continue;
      }
      const replacement = this.#renderRow(row, index);
      if (current === undefined) {
        this.#content.append(replacement);
      } else {
        current.replaceWith(replacement);
      }
      existing.set(index, replacement);
    }
    let previous: HTMLElement | undefined;
    for (const index of desiredIndexes) {
      const element = existing.get(index);
      if (element === undefined) continue;
      if (previous === undefined) {
        if (this.#content.firstElementChild !== element) {
          this.#content.prepend(element);
        }
      } else if (previous.nextElementSibling !== element) {
        previous.after(element);
      }
      previous = element;
    }
    if (activeIndex >= 0) {
      this.#tree.setAttribute(
        "aria-activedescendant",
        rowElementId(activeIndex),
      );
    } else {
      this.#tree.removeAttribute("aria-activedescendant");
    }
    this.#tree.setAttribute(
      "aria-label",
      `Repository hierarchy, ${this.#index.nodeCount.toLocaleString()} nodes`,
    );
    this.#status.textContent =
      `${this.#rows.length.toLocaleString()} visible of ` +
      `${this.#index.nodeCount.toLocaleString()} nodes \u00b7 ` +
      `${renderedIndexes.size.toLocaleString()} rendered`;
  }

  #renderRow(
    row: RepositoryHierarchyRow,
    index: number,
  ): HTMLElement {
    const { node } = row;
    const document = this.#tree.ownerDocument;
    const element = document.createElement("div");
    element.id = rowElementId(index);
    element.className = "repository-tree-row";
    element.dataset["treeRowIndex"] = String(index);
    element.dataset["treeRenderRevision"] = String(
      this.#renderRevision,
    );
    element.dataset["treeNodeId"] = node.id;
    element.dataset["nodeKind"] = node.kind;
    element.style.top = `${index * REPOSITORY_TREE_ROW_HEIGHT}px`;
    element.style.paddingInlineStart =
      `${Math.max(0, row.depth - 1) * 18 + 8}px`;
    element.setAttribute("role", "treeitem");
    element.setAttribute("aria-level", String(row.depth));
    element.setAttribute(
      "aria-posinset",
      String(row.positionInSet),
    );
    element.setAttribute("aria-setsize", String(row.setSize));
    element.setAttribute(
      "aria-selected",
      String(this.#selectedNodeIds.has(node.id)),
    );
    if (node.id === this.#activeId) {
      element.dataset["active"] = "true";
    }
    if (node.childIds.length > 0) {
      element.setAttribute(
        "aria-expanded",
        String(this.#expandedIds.has(node.id)),
      );
    }
    element.setAttribute(
      "aria-label",
      `${nodeKindLabel(node.kind)} ${node.label}` +
        (node.path === undefined ? "" : `, ${node.path}`),
    );
    const toggle = document.createElement("span");
    toggle.className = "repository-tree-toggle";
    toggle.dataset["treeToggle"] = "true";
    toggle.setAttribute("aria-hidden", "true");
    toggle.textContent =
      node.childIds.length === 0
        ? ""
        : this.#expandedIds.has(node.id)
          ? "\u25be"
          : "\u25b8";
    const icon = document.createElement("span");
    icon.className = "repository-tree-kind";
    icon.setAttribute("aria-hidden", "true");
    const iconDescriptor = repositoryHierarchyNodeIcon(node.kind);
    icon.dataset["nodeIcon"] = iconDescriptor.id;
    icon.title = iconDescriptor.label;
    icon.append(createNodeKindIcon(document, iconDescriptor));
    const text = document.createElement("span");
    text.className = "repository-tree-label";
    text.textContent = node.label;
    if (node.path !== undefined) text.title = node.path;
    element.append(toggle, icon, text);
    return element;
  }

  #saveProjectState(): void {
    const state: RepositoryTreeProjectState = Object.freeze({
      expandedIds: Object.freeze([...this.#expandedIds]),
      ...(this.#activeId === undefined
        ? {}
        : { activeId: this.#activeId }),
      scrollTop: this.#effectiveScrollTop(),
    });
    this.#projectStates.delete(this.#projectKey);
    this.#projectStates.set(this.#projectKey, state);
    while (
      this.#projectStates.size > MAX_REPOSITORY_TREE_PROJECT_STATES
    ) {
      const oldest = this.#projectStates.keys().next().value as
        | string
        | undefined;
      if (oldest === undefined) break;
      this.#projectStates.delete(oldest);
    }
  }

  #effectiveScrollTop(): number {
    return Math.max(
      0,
      this.#pendingScrollTop ?? this.#tree.scrollTop,
    );
  }
}

function acyclicModuleParents(
  parentByModuleId: ReadonlyMap<string, string>,
): ReadonlyMap<string, string> {
  const chainIsAcyclic = new Map<string, boolean>();
  for (const start of parentByModuleId.keys()) {
    if (chainIsAcyclic.has(start)) continue;
    const path: string[] = [];
    const positionInPath = new Map<string, number>();
    let current: string | undefined = start;
    let acyclic = true;
    while (current !== undefined) {
      const known = chainIsAcyclic.get(current);
      if (known !== undefined) {
        acyclic = known;
        break;
      }
      if (positionInPath.has(current)) {
        acyclic = false;
        break;
      }
      positionInPath.set(current, path.length);
      path.push(current);
      current = parentByModuleId.get(current);
    }
    for (const id of path) chainIsAcyclic.set(id, acyclic);
  }
  return new Map(
    [...parentByModuleId].filter(([id]) => chainIsAcyclic.get(id)),
  );
}

function repositoryNode(repository: CityRepository): MutableNode {
  return {
    id: nodeId("repository", repository.id),
    entityId: repository.id,
    kind: "repository",
    label: repository.name,
    parentId: null,
    childIds: [],
  };
}

function solutionNode(solution: CitySolution): MutableNode {
  return {
    id: nodeId("solution", solution.id),
    entityId: solution.id,
    kind: "solution",
    label: solution.name,
    path: solution.path,
    parentId: null,
    childIds: [],
  };
}

function moduleNode(module: CityModule): MutableNode {
  return {
    id: nodeId("module", module.id),
    entityId: module.id,
    kind: "module",
    label: module.name,
    path: module.path,
    parentId: null,
    childIds: [],
  };
}

function districtNode(district: CityDistrict): MutableNode {
  return {
    id: nodeId("district", district.id),
    entityId: district.id,
    kind: "district",
    label: district.name,
    path: district.path,
    parentId: null,
    childIds: [],
    sceneEntity: createSceneEntity("district", district.id),
    districtId: district.id,
  };
}

function buildingNode(building: CityBuilding): MutableNode {
  return {
    id: nodeId("building", building.id),
    entityId: building.id,
    kind: "building",
    label: building.name,
    path: building.path,
    parentId: null,
    childIds: [],
    sceneEntity: createSceneEntity("building", building.id),
    districtId: building.districtId,
  };
}

function canonicalSolutionId(
  module: CityModule,
  referencedBySolutions: readonly string[],
  solutionsById: ReadonlyMap<string, CitySolution>,
): string | undefined {
  const candidates = new Set([
    ...module.solutionIds,
    ...referencedBySolutions,
  ]);
  return [...candidates]
    .filter(
      (id) =>
        solutionsById.get(id)?.repositoryId === module.repositoryId,
    )
    .sort(compareText)[0];
}

function attach(
  nodes: Map<string, MutableNode>,
  childId: string | undefined,
  parentId: string | undefined,
): void {
  if (childId === undefined || parentId === undefined) return;
  const child = nodes.get(childId);
  const parent = nodes.get(parentId);
  if (
    child === undefined ||
    parent === undefined ||
    child.id === parent.id
  ) {
    return;
  }
  child.parentId = parent.id;
  parent.childIds.push(child.id);
}

function compareMutableNodes(
  left: MutableNode,
  right: MutableNode,
): number {
  return (
    KIND_ORDER[left.kind] - KIND_ORDER[right.kind] ||
    compareText(left.label, right.label) ||
    compareText(left.path ?? "", right.path ?? "") ||
    compareText(left.id, right.id)
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function identityPart(value: string): string {
  return `${value.length}:${value}`;
}

function nodeId(
  kind: RepositoryHierarchyNodeKind,
  entityId: string,
): string {
  return `${kind}:${entityId}`;
}

function sceneEntityKey(entity: SceneEntity): string {
  return `${entity.kind}:${entity.id}`;
}

function rowElementId(index: number): string {
  return `repository-tree-row-${index}`;
}

function nodeKindLabel(kind: RepositoryHierarchyNodeKind): string {
  switch (kind) {
    case "repository":
      return "Repository";
    case "solution":
      return "Solution";
    case "module":
      return "Module";
    case "district":
      return "District";
    case "building":
      return "File";
  }
}

function createNodeKindIcon(
  document: Document,
  descriptor: RepositoryHierarchyNodeIcon,
): SVGSVGElement {
  const namespace = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(namespace, "svg");
  svg.setAttribute("class", "repository-tree-kind-mark");
  svg.setAttribute("data-icon", descriptor.id);
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.35");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.style.display = "block";
  svg.style.margin = "auto";
  for (const pathData of descriptor.paths) {
    const path = document.createElementNS(namespace, "path");
    path.setAttribute("d", pathData);
    svg.append(path);
  }
  return svg;
}

function finiteNumber(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function safeWholeNumber(value: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function sameStringSet(
  left: readonly string[],
  right: ReadonlySet<string>,
): boolean {
  return (
    left.length === right.size &&
    left.every((value) => right.has(value))
  );
}

function positiveWholeNumber(
  value: number,
  fallback: number,
): number {
  return Number.isFinite(value) && value > 0
    ? Math.max(1, Math.floor(value))
    : fallback;
}
