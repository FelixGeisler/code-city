import type {
  CityBuilding,
  CityDependency,
  CityDistrict,
  CityModel,
} from "../../../packages/core/src/model.js";
import {
  normalizeExternalDependencyTarget,
} from "../../../packages/core/src/external-dependencies.js";
import { routeEndpointKey } from "./dependency-route-layout.js";

export const DEPENDENCY_ROUTES_PER_DIRECTION = 20;

export type DependencyRouteDirection = "incoming" | "outgoing";

export interface InternalDependencyCounterpart {
  readonly kind: "building";
  readonly buildingId: string;
  readonly districtId: string;
  readonly name: string;
  readonly path: string;
}

export interface ExternalDependencyCounterpart {
  readonly kind: "external";
  readonly target: string;
}

interface SelectedDependencyRouteBase {
  readonly dependencyId: string;
  readonly kind: "typescript-import";
  readonly direction: DependencyRouteDirection;
  readonly sourceBuildingId: string;
  readonly weight: number;
}

export interface InternalSelectedDependencyRoute
  extends SelectedDependencyRouteBase {
  readonly targetBuildingId: string;
  readonly counterpart: InternalDependencyCounterpart;
}

export interface ExternalSelectedDependencyRoute
  extends SelectedDependencyRouteBase {
  readonly direction: "outgoing";
  readonly externalTarget: string;
  readonly counterpart: ExternalDependencyCounterpart;
}

export type SelectedDependencyRoute =
  | InternalSelectedDependencyRoute
  | ExternalSelectedDependencyRoute;

export interface DependencyDirectionSummary {
  readonly direction: DependencyRouteDirection;
  readonly totalCount: number;
  readonly visibleCount: number;
  readonly hiddenCount: number;
  readonly totalWeight: number;
  readonly visibleWeight: number;
  readonly hiddenWeight: number;
  readonly routes: readonly SelectedDependencyRoute[];
}

export interface BuildingDependencySummary {
  readonly buildingId: string;
  readonly incoming: DependencyDirectionSummary;
  readonly outgoing: DependencyDirectionSummary;
}

interface IndexedBuilding {
  readonly id: string;
  readonly districtId: string;
  readonly name: string;
  readonly path: string;
}

interface IndexedDistrict {
  readonly id: string;
}

interface DependencyExplorerData {
  readonly buildings: ReadonlyMap<string, IndexedBuilding>;
  readonly districts: ReadonlyMap<string, IndexedDistrict>;
  readonly incoming: ReadonlyMap<string, readonly SelectedDependencyRoute[]>;
  readonly outgoing: ReadonlyMap<string, readonly SelectedDependencyRoute[]>;
  readonly routes: ReadonlySet<SelectedDependencyRoute>;
}

const dependencyExplorerData = Symbol("dependencyExplorerData");

export interface DependencyExplorerIndex {
  readonly buildingCount: number;
  readonly dependencyCount: number;
  readonly [dependencyExplorerData]: DependencyExplorerData;
}

export interface DependencyRouteToggleState {
  readonly incoming: boolean;
  readonly outgoing: boolean;
}

export const INITIAL_DEPENDENCY_ROUTE_STATE: DependencyRouteToggleState =
  Object.freeze({
    incoming: false,
    outgoing: false,
  });

export interface BuildingRouteEndpoint {
  readonly kind: "building";
  readonly buildingId: string;
}

export interface ExternalRouteEndpoint {
  readonly kind: "external";
  readonly target: string;
}

export interface DistrictBoundaryRouteEndpoint {
  readonly kind: "district-boundary";
  readonly gatewayKey: string;
  readonly districtId: string;
  readonly hiddenCounterpart: InternalDependencyCounterpart;
}

export type DependencyRouteEndpoint =
  | BuildingRouteEndpoint
  | ExternalRouteEndpoint
  | DistrictBoundaryRouteEndpoint;

export interface DependencyRouteProjection {
  readonly dependencyId: string;
  readonly direction: DependencyRouteDirection;
  readonly source: DependencyRouteEndpoint;
  readonly target: DependencyRouteEndpoint;
}

type DependencyExplorerModel = Pick<
  CityModel,
  "buildings" | "dependencies" | "districts"
>;

const EMPTY_ROUTES: readonly SelectedDependencyRoute[] = Object.freeze([]);

export function createDependencyExplorerIndex(
  model: DependencyExplorerModel,
): DependencyExplorerIndex {
  const districts = indexDistricts(model.districts);
  const buildings = indexBuildings(model.buildings, districts);
  const incoming = new Map<string, SelectedDependencyRoute[]>();
  const outgoing = new Map<string, SelectedDependencyRoute[]>();
  const routes = new Set<SelectedDependencyRoute>();
  const dependencyIds = new Set<string>();
  let dependencyCount = 0;

  for (const dependency of model.dependencies) {
    if (dependency.kind !== "typescript-import") {
      continue;
    }
    if (dependencyIds.has(dependency.id)) {
      throw new TypeError(
        `Duplicate TypeScript dependency id "${dependency.id}".`,
      );
    }
    dependencyIds.add(dependency.id);
    dependencyCount += 1;
    indexTypeScriptDependency(
      dependency,
      buildings,
      incoming,
      outgoing,
      routes,
    );
  }

  const data: DependencyExplorerData = {
    buildings,
    districts,
    incoming: freezeRouteMap(incoming),
    outgoing: freezeRouteMap(outgoing),
    routes,
  };
  return Object.freeze({
    buildingCount: buildings.size,
    dependencyCount,
    [dependencyExplorerData]: data,
  });
}

export function dependencyRoutesForBuilding(
  index: DependencyExplorerIndex,
  buildingId: string,
): BuildingDependencySummary | null {
  const data = index[dependencyExplorerData];
  if (!data.buildings.has(buildingId)) {
    return null;
  }
  return Object.freeze({
    buildingId,
    incoming: summarizeDirection(
      "incoming",
      data.incoming.get(buildingId) ?? EMPTY_ROUTES,
    ),
    outgoing: summarizeDirection(
      "outgoing",
      data.outgoing.get(buildingId) ?? EMPTY_ROUTES,
    ),
  });
}

export function resetDependencyRouteState(): DependencyRouteToggleState {
  return INITIAL_DEPENDENCY_ROUTE_STATE;
}

export function toggleDependencyRouteDirection(
  state: DependencyRouteToggleState,
  direction: DependencyRouteDirection,
): DependencyRouteToggleState {
  return Object.freeze({
    incoming:
      direction === "incoming" ? !state.incoming : state.incoming,
    outgoing:
      direction === "outgoing" ? !state.outgoing : state.outgoing,
  });
}

/**
 * Resolves a selected route to renderable endpoints. When isolation hides an
 * internal counterpart, its building endpoint is replaced by a stable gateway
 * key for the visible district boundary; no hidden building position leaves
 * this helper.
 */
export function projectDependencyRoute(
  index: DependencyExplorerIndex,
  selectedBuildingId: string,
  route: SelectedDependencyRoute,
  isolatedDistrictId: string | null,
): DependencyRouteProjection {
  const data = index[dependencyExplorerData];
  if (!data.routes.has(route)) {
    throw new TypeError("Dependency route does not belong to this index.");
  }
  const selected = requiredBuilding(data, selectedBuildingId);
  if (
    (route.direction === "outgoing" &&
      route.sourceBuildingId !== selectedBuildingId) ||
    (route.direction === "incoming" &&
      (!("targetBuildingId" in route) ||
        route.targetBuildingId !== selectedBuildingId))
  ) {
    throw new TypeError("Dependency route does not belong to the selection.");
  }

  const selectedEndpoint = buildingEndpoint(selectedBuildingId);
  if (
    isolatedDistrictId !== null &&
    selected.districtId !== isolatedDistrictId
  ) {
    throw new RangeError(
      "The selected building must belong to the isolated district.",
    );
  }
  if (route.counterpart.kind === "external") {
    return Object.freeze({
      dependencyId: route.dependencyId,
      direction: route.direction,
      source: selectedEndpoint,
      target: externalEndpoint(route.counterpart.target),
    });
  }

  const counterpart = requiredBuilding(
    data,
    route.counterpart.buildingId,
  );
  let counterpartEndpoint: DependencyRouteEndpoint = buildingEndpoint(
    counterpart.id,
  );
  if (
    isolatedDistrictId !== null &&
    counterpart.districtId !== isolatedDistrictId
  ) {
    const district = data.districts.get(isolatedDistrictId);
    if (!district) {
      throw new RangeError(
        `Unknown isolated district "${isolatedDistrictId}".`,
      );
    }
    counterpartEndpoint = boundaryEndpoint(district, counterpart);
  }

  return Object.freeze({
    dependencyId: route.dependencyId,
    direction: route.direction,
    source:
      route.direction === "outgoing"
        ? selectedEndpoint
        : counterpartEndpoint,
    target:
      route.direction === "outgoing"
        ? counterpartEndpoint
        : selectedEndpoint,
  });
}

function indexDistricts(
  districts: readonly CityDistrict[],
): ReadonlyMap<string, IndexedDistrict> {
  const indexed = new Map<string, IndexedDistrict>();
  for (const district of districts) {
    if (indexed.has(district.id)) {
      throw new TypeError(`Duplicate district id "${district.id}".`);
    }
    assertFinitePosition(district.position, `District "${district.id}"`);
    if (
      !Number.isFinite(district.size.x) ||
      !Number.isFinite(district.size.z) ||
      district.size.x <= 0 ||
      district.size.z <= 0
    ) {
      throw new RangeError(
        `District "${district.id}" must have a finite positive footprint.`,
      );
    }
    indexed.set(
      district.id,
      Object.freeze({
        id: district.id,
      }),
    );
  }
  return indexed;
}

function indexBuildings(
  buildings: readonly CityBuilding[],
  districts: ReadonlyMap<string, IndexedDistrict>,
): ReadonlyMap<string, IndexedBuilding> {
  const indexed = new Map<string, IndexedBuilding>();
  for (const building of buildings) {
    if (indexed.has(building.id)) {
      throw new TypeError(`Duplicate building id "${building.id}".`);
    }
    if (!districts.has(building.districtId)) {
      throw new TypeError(
        `Building "${building.id}" references an unknown district.`,
      );
    }
    assertFinitePosition(building.position, `Building "${building.id}"`);
    indexed.set(
      building.id,
      Object.freeze({
        id: building.id,
        districtId: building.districtId,
        name: building.name,
        path: normalizePath(building.path),
      }),
    );
  }
  return indexed;
}

function indexTypeScriptDependency(
  dependency: CityDependency,
  buildings: ReadonlyMap<string, IndexedBuilding>,
  incoming: Map<string, SelectedDependencyRoute[]>,
  outgoing: Map<string, SelectedDependencyRoute[]>,
  routes: Set<SelectedDependencyRoute>,
): void {
  const source = buildings.get(dependency.sourceId);
  if (!source) {
    throw new TypeError(
      `TypeScript dependency "${dependency.id}" has an unknown source.`,
    );
  }
  if (!Number.isFinite(dependency.weight) || dependency.weight <= 0) {
    throw new RangeError(
      `TypeScript dependency "${dependency.id}" has an invalid weight.`,
    );
  }

  const hasInternal = dependency.targetId !== undefined;
  const hasExternal = dependency.externalTarget !== undefined;
  if (hasInternal === hasExternal) {
    throw new TypeError(
      `TypeScript dependency "${dependency.id}" must have exactly one target.`,
    );
  }

  if (dependency.targetId !== undefined) {
    const target = buildings.get(dependency.targetId);
    if (!target) {
      throw new TypeError(
        `TypeScript dependency "${dependency.id}" has an unknown target.`,
      );
    }
    const outgoingRoute: InternalSelectedDependencyRoute = Object.freeze({
      dependencyId: dependency.id,
      kind: "typescript-import",
      direction: "outgoing",
      sourceBuildingId: source.id,
      targetBuildingId: target.id,
      counterpart: buildingCounterpart(target),
      weight: dependency.weight,
    });
    const incomingRoute: InternalSelectedDependencyRoute = Object.freeze({
      dependencyId: dependency.id,
      kind: "typescript-import",
      direction: "incoming",
      sourceBuildingId: source.id,
      targetBuildingId: target.id,
      counterpart: buildingCounterpart(source),
      weight: dependency.weight,
    });
    addRoute(outgoing, source.id, outgoingRoute);
    addRoute(incoming, target.id, incomingRoute);
    routes.add(outgoingRoute);
    routes.add(incomingRoute);
    return;
  }

  const externalTarget = normalizeExternalDependencyTarget(
    dependency.externalTarget!,
  );
  const route: ExternalSelectedDependencyRoute = Object.freeze({
    dependencyId: dependency.id,
    kind: "typescript-import",
    direction: "outgoing",
    sourceBuildingId: source.id,
    externalTarget,
    counterpart: Object.freeze({
      kind: "external",
      target: externalTarget,
    }),
    weight: dependency.weight,
  });
  addRoute(outgoing, source.id, route);
  routes.add(route);
}

function buildingCounterpart(
  building: IndexedBuilding,
): InternalDependencyCounterpart {
  return Object.freeze({
    kind: "building",
    buildingId: building.id,
    districtId: building.districtId,
    name: building.name,
    path: building.path,
  });
}

function addRoute(
  map: Map<string, SelectedDependencyRoute[]>,
  buildingId: string,
  route: SelectedDependencyRoute,
): void {
  const routes = map.get(buildingId) ?? [];
  routes.push(route);
  map.set(buildingId, routes);
}

function freezeRouteMap(
  source: Map<string, SelectedDependencyRoute[]>,
): ReadonlyMap<string, readonly SelectedDependencyRoute[]> {
  const result = new Map<string, readonly SelectedDependencyRoute[]>();
  for (const [buildingId, routes] of source) {
    result.set(
      buildingId,
      Object.freeze([...routes].sort(compareRoutes)),
    );
  }
  return result;
}

function compareRoutes(
  left: SelectedDependencyRoute,
  right: SelectedDependencyRoute,
): number {
  const leftIdentity = counterpartIdentity(left.counterpart);
  const rightIdentity = counterpartIdentity(right.counterpart);
  return (
    right.weight - left.weight ||
    compareText(leftIdentity.pathFolded, rightIdentity.pathFolded) ||
    compareText(leftIdentity.path, rightIdentity.path) ||
    compareText(leftIdentity.nameFolded, rightIdentity.nameFolded) ||
    compareText(leftIdentity.name, rightIdentity.name) ||
    compareText(leftIdentity.id, rightIdentity.id) ||
    compareText(left.dependencyId, right.dependencyId)
  );
}

function counterpartIdentity(
  counterpart: SelectedDependencyRoute["counterpart"],
): {
  readonly id: string;
  readonly name: string;
  readonly nameFolded: string;
  readonly path: string;
  readonly pathFolded: string;
} {
  const id =
    counterpart.kind === "building"
      ? counterpart.buildingId
      : `external:${counterpart.target}`;
  const name =
    counterpart.kind === "building"
      ? counterpart.name
      : counterpart.target;
  const path =
    counterpart.kind === "building"
      ? counterpart.path
      : counterpart.target;
  return {
    id,
    name,
    nameFolded: name.toLowerCase(),
    path,
    pathFolded: path.toLowerCase(),
  };
}

function summarizeDirection(
  direction: DependencyRouteDirection,
  routes: readonly SelectedDependencyRoute[],
): DependencyDirectionSummary {
  const visible = Object.freeze(
    routes.slice(0, DEPENDENCY_ROUTES_PER_DIRECTION),
  );
  const totalWeight = sumWeight(routes);
  const visibleWeight = sumWeight(visible);
  return Object.freeze({
    direction,
    totalCount: routes.length,
    visibleCount: visible.length,
    hiddenCount: routes.length - visible.length,
    totalWeight,
    visibleWeight,
    hiddenWeight: totalWeight - visibleWeight,
    routes: visible,
  });
}

function sumWeight(routes: readonly SelectedDependencyRoute[]): number {
  return routes.reduce((total, route) => total + route.weight, 0);
}

function requiredBuilding(
  data: DependencyExplorerData,
  buildingId: string,
): IndexedBuilding {
  const building = data.buildings.get(buildingId);
  if (!building) {
    throw new TypeError(`Unknown building "${buildingId}".`);
  }
  return building;
}

function buildingEndpoint(buildingId: string): BuildingRouteEndpoint {
  return Object.freeze({ kind: "building", buildingId });
}

function externalEndpoint(target: string): ExternalRouteEndpoint {
  return Object.freeze({ kind: "external", target });
}

function boundaryEndpoint(
  district: IndexedDistrict,
  hidden: IndexedBuilding,
): DistrictBoundaryRouteEndpoint {
  return Object.freeze({
    kind: "district-boundary",
    gatewayKey: routeEndpointKey("building", hidden.id),
    districtId: district.id,
    hiddenCounterpart: buildingCounterpart(hidden),
  });
}

function assertFinitePosition(
  position: { readonly x: number; readonly z: number },
  label: string,
): void {
  if (!Number.isFinite(position.x) || !Number.isFinite(position.z)) {
    throw new RangeError(`${label} must have a finite position.`);
  }
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/\/+/g, "/");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
