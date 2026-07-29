import type {
  CityBuilding,
  CityDependency,
  CityDistrict,
  CityModel,
  CityModule,
  DependencyKind,
} from "../../../packages/core/src/model.js";
import {
  normalizeExternalDependencyTarget,
} from "../../../packages/core/src/external-dependencies.js";

export const DISTRICT_DEPENDENCY_BUNDLES_LIMIT = 24;
export const DISTRICT_DEPENDENCY_CONTRIBUTORS_LIMIT = 5;

const DEPENDENCY_KIND_ORDER: readonly DependencyKind[] = Object.freeze([
  "typescript-import",
  "project-reference",
  "package-reference",
]);

export interface DistrictDependencyFilters {
  readonly typescriptImport: boolean;
  readonly projectReference: boolean;
  readonly packageReference: boolean;
}

export const INITIAL_DISTRICT_DEPENDENCY_FILTERS: DistrictDependencyFilters =
  Object.freeze({
    typescriptImport: true,
    projectReference: true,
    packageReference: true,
  });

export interface DistrictDependencyKindSummary {
  readonly kind: DependencyKind;
  readonly edgeCount: number;
  readonly weight: number;
}

export interface DistrictDependencyContributor {
  readonly dependencyId: string;
  readonly kind: DependencyKind;
  readonly sourceLabel: string;
  readonly sourcePath: string;
  readonly targetLabel: string;
  readonly targetPath: string;
  readonly weight: number;
}

export interface VisibleDistrictDependencyEndpoint {
  readonly kind: "district";
  readonly districtId: string;
  readonly name: string;
  readonly path: string;
}

export interface BoundaryDistrictDependencyEndpoint {
  readonly kind: "district-boundary";
  readonly visibleDistrictId: string;
  readonly hiddenDistrictId: string;
  readonly hiddenDistrictName: string;
  readonly hiddenDistrictPath: string;
}

export interface ExternalDistrictDependencyEndpoint {
  readonly kind: "external";
  readonly target: string;
}

export type DistrictDependencyEndpoint =
  | VisibleDistrictDependencyEndpoint
  | BoundaryDistrictDependencyEndpoint
  | ExternalDistrictDependencyEndpoint;

export interface DistrictDependencyBundle {
  readonly id: string;
  readonly source: DistrictDependencyEndpoint;
  readonly target: DistrictDependencyEndpoint;
  readonly edgeCount: number;
  readonly weight: number;
  readonly kinds: readonly DistrictDependencyKindSummary[];
  readonly contributors: readonly DistrictDependencyContributor[];
}

export interface DistrictDependencySummary {
  /**
   * Scope-wide availability before the current kind filters are applied.
   * Entries always follow TypeScript, project, package order, including zeros.
   */
  readonly availableKinds: readonly DistrictDependencyKindSummary[];
  readonly totalBundleCount: number;
  readonly visibleBundleCount: number;
  readonly hiddenBundleCount: number;
  readonly totalReferenceWeight: number;
  readonly visibleReferenceWeight: number;
  readonly hiddenReferenceWeight: number;
  readonly bundles: readonly DistrictDependencyBundle[];
}

interface IndexedDistrict {
  readonly id: string;
  readonly moduleId: string;
  readonly name: string;
  readonly path: string;
}

interface IndexedModule {
  readonly id: string;
  readonly name: string;
  readonly path: string;
}

interface IndexedNode {
  readonly id: string;
  readonly districtId: string;
  readonly label: string;
  readonly path: string;
}

interface IndexedDependencyEdge {
  readonly dependencyId: string;
  readonly kind: DependencyKind;
  readonly source: IndexedNode;
  readonly target:
    | {
        readonly kind: "district";
        readonly node: IndexedNode;
      }
    | {
        readonly kind: "external";
        readonly target: string;
      };
  readonly weight: number;
}

interface IndexedBundle {
  readonly id: string;
  readonly sourceDistrictId: string;
  readonly target:
    | {
        readonly kind: "district";
        readonly districtId: string;
      }
    | {
        readonly kind: "external";
        readonly target: string;
      };
  readonly edges: readonly IndexedDependencyEdge[];
}

interface DistrictDependencyExplorerData {
  readonly districts: ReadonlyMap<string, IndexedDistrict>;
  readonly bundles: readonly IndexedBundle[];
}

const districtDependencyExplorerData = Symbol(
  "districtDependencyExplorerData",
);

export interface DistrictDependencyExplorerIndex {
  readonly districtCount: number;
  readonly dependencyCount: number;
  readonly bundleCount: number;
  readonly [districtDependencyExplorerData]: DistrictDependencyExplorerData;
}

type DistrictDependencyModel = Pick<
  CityModel,
  "buildings" | "dependencies" | "districts" | "modules"
>;

/**
 * Creates an immutable aggregation snapshot. TypeScript imports resolve through
 * buildings; project and package references resolve through modules.
 */
export function createDistrictDependencyExplorerIndex(
  model: DistrictDependencyModel,
): DistrictDependencyExplorerIndex {
  const modules = indexModules(model.modules);
  const { districts, districtByModuleId } = indexDistricts(
    model.districts,
    modules,
  );
  const buildings = indexBuildings(model.buildings, districts);
  const moduleNodes = indexModuleNodes(modules, districtByModuleId);
  const dependencyIds = new Set<string>();
  const bundleEdges = new Map<string, IndexedDependencyEdge[]>();
  const bundleEndpoints = new Map<
    string,
    Pick<IndexedBundle, "id" | "sourceDistrictId" | "target">
  >();

  for (const dependency of model.dependencies) {
    if (dependencyIds.has(dependency.id)) {
      throw new TypeError(`Duplicate dependency id "${dependency.id}".`);
    }
    dependencyIds.add(dependency.id);
    const edge = indexDependency(dependency, buildings, moduleNodes);
    if (
      edge.target.kind === "district" &&
      edge.source.districtId === edge.target.node.districtId
    ) {
      continue;
    }
    const endpoint = bundleEndpoint(edge);
    const edges = bundleEdges.get(endpoint.id) ?? [];
    edges.push(edge);
    bundleEdges.set(endpoint.id, edges);
    bundleEndpoints.set(endpoint.id, endpoint);
  }

  const bundles = Object.freeze(
    [...bundleEndpoints.values()]
      .map((endpoint): IndexedBundle =>
        Object.freeze({
          ...endpoint,
          edges: Object.freeze(
            [...(bundleEdges.get(endpoint.id) ?? [])].sort(
              compareIndexedEdges,
            ),
          ),
        }),
      )
      .sort(compareIndexedBundles),
  );
  const data: DistrictDependencyExplorerData = {
    districts,
    bundles,
  };
  return Object.freeze({
    districtCount: districts.size,
    dependencyCount: dependencyIds.size,
    bundleCount: bundles.length,
    [districtDependencyExplorerData]: data,
  });
}

export function resetDistrictDependencyFilters(): DistrictDependencyFilters {
  return INITIAL_DISTRICT_DEPENDENCY_FILTERS;
}

export function toggleDistrictDependencyKind(
  filters: DistrictDependencyFilters,
  kind: DependencyKind,
): DistrictDependencyFilters {
  assertFilters(filters);
  return Object.freeze({
    typescriptImport:
      kind === "typescript-import"
        ? !filters.typescriptImport
        : filters.typescriptImport,
    projectReference:
      kind === "project-reference"
        ? !filters.projectReference
        : filters.projectReference,
    packageReference:
      kind === "package-reference"
        ? !filters.packageReference
        : filters.packageReference,
  });
}

/**
 * Applies dependency-kind filters and optional district isolation, then returns
 * the strongest 24 bundles. All counts and weights are recomputed from the
 * filtered edges before the display cap is applied.
 */
export function summarizeDistrictDependencies(
  index: DistrictDependencyExplorerIndex,
  filters: DistrictDependencyFilters,
  isolatedDistrictId: string | null,
): DistrictDependencySummary {
  assertFilters(filters);
  const data = index[districtDependencyExplorerData];
  if (!data) {
    throw new TypeError("Invalid district dependency explorer index.");
  }
  if (
    isolatedDistrictId !== null &&
    !data.districts.has(isolatedDistrictId)
  ) {
    throw new RangeError(
      `Unknown isolated district "${isolatedDistrictId}".`,
    );
  }

  const bundles = data.bundles
    .filter(
      (bundle) =>
        isolatedDistrictId === null ||
        bundleTouchesDistrict(bundle, isolatedDistrictId),
    )
    .map((bundle) =>
      summarizeBundle(
        bundle,
        data.districts,
        filters,
        isolatedDistrictId,
      ),
    )
    .filter(
      (bundle): bundle is DistrictDependencyBundle => bundle !== null,
    )
    .sort(compareSummarizedBundles);
  const scopedBundles = data.bundles.filter(
    (bundle) =>
      isolatedDistrictId === null ||
      bundleTouchesDistrict(bundle, isolatedDistrictId),
  );
  const visible = Object.freeze(
    bundles.slice(0, DISTRICT_DEPENDENCY_BUNDLES_LIMIT),
  );
  const totalReferenceWeight = sumBundleWeights(bundles);
  const visibleReferenceWeight = sumBundleWeights(visible);
  const hiddenReferenceWeight = sumBundleWeights(
    bundles.slice(DISTRICT_DEPENDENCY_BUNDLES_LIMIT),
  );
  return Object.freeze({
    availableKinds: summarizeAvailableKinds(scopedBundles),
    totalBundleCount: bundles.length,
    visibleBundleCount: visible.length,
    hiddenBundleCount: bundles.length - visible.length,
    totalReferenceWeight,
    visibleReferenceWeight,
    hiddenReferenceWeight,
    bundles: visible,
  });
}

function summarizeAvailableKinds(
  bundles: readonly IndexedBundle[],
): readonly DistrictDependencyKindSummary[] {
  const edges = bundles.flatMap(({ edges }) => edges);
  return Object.freeze(
    DEPENDENCY_KIND_ORDER.map((kind) => {
      const kindEdges = edges.filter((edge) => edge.kind === kind);
      return Object.freeze({
        kind,
        edgeCount: kindEdges.length,
        weight: sumEdgeWeights(kindEdges),
      });
    }),
  );
}

function indexModules(
  source: readonly CityModule[],
): ReadonlyMap<string, IndexedModule> {
  const modules = new Map<string, IndexedModule>();
  for (const module of source) {
    if (modules.has(module.id)) {
      throw new TypeError(`Duplicate module id "${module.id}".`);
    }
    modules.set(
      module.id,
      Object.freeze({
        id: module.id,
        name: module.name,
        path: normalizePath(module.path),
      }),
    );
  }
  return modules;
}

function indexDistricts(
  source: readonly CityDistrict[],
  modules: ReadonlyMap<string, IndexedModule>,
): {
  readonly districts: ReadonlyMap<string, IndexedDistrict>;
  readonly districtByModuleId: ReadonlyMap<string, IndexedDistrict>;
} {
  const districts = new Map<string, IndexedDistrict>();
  const districtByModuleId = new Map<string, IndexedDistrict>();
  for (const district of source) {
    if (districts.has(district.id)) {
      throw new TypeError(`Duplicate district id "${district.id}".`);
    }
    if (!modules.has(district.moduleId)) {
      throw new TypeError(
        `District "${district.id}" references an unknown module.`,
      );
    }
    if (districtByModuleId.has(district.moduleId)) {
      throw new TypeError(
        `Module "${district.moduleId}" maps to multiple districts.`,
      );
    }
    const indexed: IndexedDistrict = Object.freeze({
      id: district.id,
      moduleId: district.moduleId,
      name: district.name,
      path: normalizePath(district.path),
    });
    districts.set(indexed.id, indexed);
    districtByModuleId.set(indexed.moduleId, indexed);
  }
  return { districts, districtByModuleId };
}

function indexBuildings(
  source: readonly CityBuilding[],
  districts: ReadonlyMap<string, IndexedDistrict>,
): ReadonlyMap<string, IndexedNode> {
  const buildings = new Map<string, IndexedNode>();
  for (const building of source) {
    if (buildings.has(building.id)) {
      throw new TypeError(`Duplicate building id "${building.id}".`);
    }
    const district = districts.get(building.districtId);
    if (!district) {
      throw new TypeError(
        `Building "${building.id}" references an unknown district.`,
      );
    }
    if (building.moduleId !== district.moduleId) {
      throw new TypeError(
        `Building "${building.id}" has an ambiguous module and district mapping.`,
      );
    }
    buildings.set(
      building.id,
      Object.freeze({
        id: building.id,
        districtId: district.id,
        label: building.name,
        path: normalizePath(building.path),
      }),
    );
  }
  return buildings;
}

function indexModuleNodes(
  modules: ReadonlyMap<string, IndexedModule>,
  districtByModuleId: ReadonlyMap<string, IndexedDistrict>,
): ReadonlyMap<string, IndexedNode> {
  const nodes = new Map<string, IndexedNode>();
  for (const module of modules.values()) {
    const district = districtByModuleId.get(module.id);
    if (!district) {
      continue;
    }
    nodes.set(
      module.id,
      Object.freeze({
        id: module.id,
        districtId: district.id,
        label: module.name,
        path: normalizePath(module.path),
      }),
    );
  }
  return nodes;
}

function indexDependency(
  dependency: CityDependency,
  buildings: ReadonlyMap<string, IndexedNode>,
  modules: ReadonlyMap<string, IndexedNode>,
): IndexedDependencyEdge {
  if (!Number.isFinite(dependency.weight) || dependency.weight <= 0) {
    throw new RangeError(
      `Dependency "${dependency.id}" has an invalid weight.`,
    );
  }
  const nodes =
    dependency.kind === "typescript-import" ? buildings : modules;
  const source = nodes.get(dependency.sourceId);
  if (!source) {
    throw new TypeError(
      `Dependency "${dependency.id}" has an unknown or unmapped source.`,
    );
  }
  const hasInternal = dependency.targetId !== undefined;
  const hasExternal = dependency.externalTarget !== undefined;
  if (hasInternal === hasExternal) {
    throw new TypeError(
      `Dependency "${dependency.id}" must have exactly one target.`,
    );
  }

  let target: IndexedDependencyEdge["target"];
  if (dependency.targetId !== undefined) {
    const targetNode = nodes.get(dependency.targetId);
    if (!targetNode) {
      throw new TypeError(
        `Dependency "${dependency.id}" has an unknown or unmapped target.`,
      );
    }
    target = Object.freeze({ kind: "district", node: targetNode });
  } else {
    const externalTarget = normalizeExternalDependencyTarget(
      dependency.externalTarget!,
    );
    target = Object.freeze({
      kind: "external",
      target: externalTarget,
    });
  }
  return Object.freeze({
    dependencyId: dependency.id,
    kind: dependency.kind,
    source,
    target,
    weight: dependency.weight,
  });
}

function bundleEndpoint(
  edge: IndexedDependencyEdge,
): Pick<IndexedBundle, "id" | "sourceDistrictId" | "target"> {
  const sourceDistrictId = edge.source.districtId;
  if (edge.target.kind === "district") {
    const targetDistrictId = edge.target.node.districtId;
    return Object.freeze({
      id: bundleId(sourceDistrictId, "district", targetDistrictId),
      sourceDistrictId,
      target: Object.freeze({
        kind: "district",
        districtId: targetDistrictId,
      }),
    });
  }
  return Object.freeze({
    id: bundleId(sourceDistrictId, "external", edge.target.target),
    sourceDistrictId,
    target: Object.freeze({
      kind: "external",
      target: edge.target.target,
    }),
  });
}

function bundleId(
  sourceDistrictId: string,
  targetKind: "district" | "external",
  targetIdentity: string,
): string {
  return `district-dependency:${encodeURIComponent(
    sourceDistrictId,
  )}:${targetKind}:${encodeURIComponent(targetIdentity)}`;
}

function summarizeBundle(
  bundle: IndexedBundle,
  districts: ReadonlyMap<string, IndexedDistrict>,
  filters: DistrictDependencyFilters,
  isolatedDistrictId: string | null,
): DistrictDependencyBundle | null {
  const edges = bundle.edges.filter((edge) =>
    filterIncludes(filters, edge.kind),
  );
  if (edges.length === 0) {
    return null;
  }
  const kinds = Object.freeze(
    DEPENDENCY_KIND_ORDER.flatMap((kind) => {
      const kindEdges = edges.filter((edge) => edge.kind === kind);
      return kindEdges.length === 0
        ? []
        : [
            Object.freeze({
              kind,
              edgeCount: kindEdges.length,
              weight: sumEdgeWeights(kindEdges),
            }),
          ];
    }),
  );
  const contributors = Object.freeze(
    edges
      .map(toContributor)
      .sort(compareContributors)
      .slice(0, DISTRICT_DEPENDENCY_CONTRIBUTORS_LIMIT),
  );
  return Object.freeze({
    id: bundle.id,
    source: districtEndpoint(
      requiredDistrict(districts, bundle.sourceDistrictId),
      isolatedDistrictId,
    ),
    target:
      bundle.target.kind === "district"
        ? districtEndpoint(
            requiredDistrict(districts, bundle.target.districtId),
            isolatedDistrictId,
          )
        : Object.freeze({
            kind: "external",
            target: bundle.target.target,
          }),
    edgeCount: edges.length,
    weight: sumEdgeWeights(edges),
    kinds,
    contributors,
  });
}

function districtEndpoint(
  district: IndexedDistrict,
  isolatedDistrictId: string | null,
): VisibleDistrictDependencyEndpoint | BoundaryDistrictDependencyEndpoint {
  if (
    isolatedDistrictId !== null &&
    district.id !== isolatedDistrictId
  ) {
    return Object.freeze({
      kind: "district-boundary",
      visibleDistrictId: isolatedDistrictId,
      hiddenDistrictId: district.id,
      hiddenDistrictName: district.name,
      hiddenDistrictPath: district.path,
    });
  }
  return Object.freeze({
    kind: "district",
    districtId: district.id,
    name: district.name,
    path: district.path,
  });
}

function toContributor(
  edge: IndexedDependencyEdge,
): DistrictDependencyContributor {
  const target =
    edge.target.kind === "district"
      ? {
          label: edge.target.node.label,
          path: edge.target.node.path,
        }
      : {
          label: edge.target.target,
          path: edge.target.target,
        };
  return Object.freeze({
    dependencyId: edge.dependencyId,
    kind: edge.kind,
    sourceLabel: edge.source.label,
    sourcePath: edge.source.path,
    targetLabel: target.label,
    targetPath: target.path,
    weight: edge.weight,
  });
}

function bundleTouchesDistrict(
  bundle: IndexedBundle,
  districtId: string,
): boolean {
  return (
    bundle.sourceDistrictId === districtId ||
    (bundle.target.kind === "district" &&
      bundle.target.districtId === districtId)
  );
}

function filterIncludes(
  filters: DistrictDependencyFilters,
  kind: DependencyKind,
): boolean {
  switch (kind) {
    case "typescript-import":
      return filters.typescriptImport;
    case "project-reference":
      return filters.projectReference;
    case "package-reference":
      return filters.packageReference;
  }
}

function assertFilters(filters: DistrictDependencyFilters): void {
  if (
    typeof filters.typescriptImport !== "boolean" ||
    typeof filters.projectReference !== "boolean" ||
    typeof filters.packageReference !== "boolean"
  ) {
    throw new TypeError(
      "District dependency filters must contain three booleans.",
    );
  }
}

function requiredDistrict(
  districts: ReadonlyMap<string, IndexedDistrict>,
  districtId: string,
): IndexedDistrict {
  const district = districts.get(districtId);
  if (!district) {
    throw new TypeError(`Unknown district "${districtId}".`);
  }
  return district;
}

function compareIndexedEdges(
  left: IndexedDependencyEdge,
  right: IndexedDependencyEdge,
): number {
  const leftTarget = indexedTargetIdentity(left.target);
  const rightTarget = indexedTargetIdentity(right.target);
  return (
    compareText(left.kind, right.kind) ||
    compareIdentity(left.source.path, right.source.path) ||
    compareIdentity(left.source.label, right.source.label) ||
    compareIdentity(leftTarget.path, rightTarget.path) ||
    compareIdentity(leftTarget.label, rightTarget.label) ||
    compareText(left.dependencyId, right.dependencyId)
  );
}

function compareIndexedBundles(
  left: IndexedBundle,
  right: IndexedBundle,
): number {
  return (
    compareIdentity(left.sourceDistrictId, right.sourceDistrictId) ||
    compareIdentity(
      indexedBundleTargetIdentity(left),
      indexedBundleTargetIdentity(right),
    ) ||
    compareText(left.id, right.id)
  );
}

function compareSummarizedBundles(
  left: DistrictDependencyBundle,
  right: DistrictDependencyBundle,
): number {
  return (
    right.weight - left.weight ||
    compareIdentity(
      endpointIdentity(left.source),
      endpointIdentity(right.source),
    ) ||
    compareIdentity(
      endpointIdentity(left.target),
      endpointIdentity(right.target),
    ) ||
    compareText(left.id, right.id)
  );
}

function compareContributors(
  left: DistrictDependencyContributor,
  right: DistrictDependencyContributor,
): number {
  return (
    right.weight - left.weight ||
    compareIdentity(left.sourcePath, right.sourcePath) ||
    compareIdentity(left.sourceLabel, right.sourceLabel) ||
    compareIdentity(left.targetPath, right.targetPath) ||
    compareIdentity(left.targetLabel, right.targetLabel) ||
    compareText(left.kind, right.kind) ||
    compareText(left.dependencyId, right.dependencyId)
  );
}

function indexedTargetIdentity(
  target: IndexedDependencyEdge["target"],
): { readonly label: string; readonly path: string } {
  return target.kind === "district"
    ? { label: target.node.label, path: target.node.path }
    : { label: target.target, path: target.target };
}

function indexedBundleTargetIdentity(bundle: IndexedBundle): string {
  return bundle.target.kind === "district"
    ? `district:${bundle.target.districtId}`
    : `external:${bundle.target.target}`;
}

function endpointIdentity(endpoint: DistrictDependencyEndpoint): string {
  switch (endpoint.kind) {
    case "district":
      return `district:${endpoint.districtId}`;
    case "district-boundary":
      return `district:${endpoint.hiddenDistrictId}`;
    case "external":
      return `external:${endpoint.target}`;
  }
}

function sumEdgeWeights(edges: readonly IndexedDependencyEdge[]): number {
  return saturatingWeightSum(edges.map(({ weight }) => weight));
}

function sumBundleWeights(
  bundles: readonly DistrictDependencyBundle[],
): number {
  return saturatingWeightSum(
    bundles.map(({ weight }) => weight),
  );
}

function saturatingWeightSum(weights: readonly number[]): number {
  let total = 0;
  for (const weight of weights) {
    if (weight > Number.MAX_VALUE - total) {
      return Number.MAX_VALUE;
    }
    total += weight;
  }
  return total;
}

function compareIdentity(left: string, right: string): number {
  return (
    compareText(left.toLowerCase(), right.toLowerCase()) ||
    compareText(left, right)
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/\/+/g, "/");
}
