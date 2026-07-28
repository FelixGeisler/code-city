import type {
  CityBuilding,
  CityDependency,
  CityDistrict,
  CityModel,
} from "../../../packages/core/src/model.js";

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
  readonly position: {
    readonly x: number;
    readonly z: number;
  };
}

interface IndexedDistrict {
  readonly id: string;
  readonly position: {
    readonly x: number;
    readonly z: number;
  };
  readonly size: {
    readonly x: number;
    readonly z: number;
  };
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
  readonly gatewayId: string;
  readonly districtId: string;
  readonly position: {
    readonly x: number;
    readonly z: number;
  };
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
 * internal counterpart, its building endpoint is replaced by a point on the
 * visible district boundary; no hidden building position leaves this helper.
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
    counterpartEndpoint = boundaryEndpoint(
      district,
      selected,
      counterpart,
      route,
    );
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
        position: Object.freeze({
          x: district.position.x,
          z: district.position.z,
        }),
        size: Object.freeze({
          x: district.size.x,
          z: district.size.z,
        }),
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
        position: Object.freeze({
          x: building.position.x,
          z: building.position.z,
        }),
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

  const externalTarget = dependency.externalTarget;
  if (externalTarget === undefined || externalTarget.trim() === "") {
    throw new TypeError(
      `TypeScript dependency "${dependency.id}" has an empty external target.`,
    );
  }
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
  selected: IndexedBuilding,
  hidden: IndexedBuilding,
  route: SelectedDependencyRoute,
): DistrictBoundaryRouteEndpoint {
  const position = projectToBoundary(
    district,
    selected.position,
    hidden.position,
  );
  if (route.counterpart.kind !== "building") {
    throw new TypeError("Only internal routes can use a district boundary.");
  }
  return Object.freeze({
    kind: "district-boundary",
    gatewayId:
      `boundary:${district.id}:${route.direction}:` +
      route.dependencyId,
    districtId: district.id,
    position: Object.freeze(position),
    hiddenCounterpart: route.counterpart,
  });
}

function projectToBoundary(
  district: IndexedDistrict,
  from: IndexedBuilding["position"],
  toward: IndexedBuilding["position"],
): { readonly x: number; readonly z: number } {
  const halfX = district.size.x / 2;
  const halfZ = district.size.z / 2;
  const minimumX = district.position.x - halfX;
  const maximumX = district.position.x + halfX;
  const minimumZ = district.position.z - halfZ;
  const maximumZ = district.position.z + halfZ;
  if (
    from.x < minimumX ||
    from.x > maximumX ||
    from.z < minimumZ ||
    from.z > maximumZ
  ) {
    throw new RangeError(
      "Selected building must lie inside the isolated district.",
    );
  }

  const deltaX = toward.x - from.x;
  const deltaZ = toward.z - from.z;
  const scales: number[] = [];
  if (deltaX > 0) scales.push((maximumX - from.x) / deltaX);
  if (deltaX < 0) scales.push((minimumX - from.x) / deltaX);
  if (deltaZ > 0) scales.push((maximumZ - from.z) / deltaZ);
  if (deltaZ < 0) scales.push((minimumZ - from.z) / deltaZ);
  const scale = Math.min(
    ...scales.filter((candidate) => candidate >= 0),
  );
  if (!Number.isFinite(scale)) {
    return { x: maximumX, z: from.z };
  }
  return {
    x: clamp(from.x + deltaX * scale, minimumX, maximumX),
    z: clamp(from.z + deltaZ * scale, minimumZ, maximumZ),
  };
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

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
