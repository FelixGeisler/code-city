import type {
  CityBuilding,
  CityDistrict,
  CityModel,
} from "../../../packages/core/src/model.js";
import {
  createSceneEntity,
  type SceneEntity,
} from "./scene-entity.js";

export const DEFAULT_REPOSITORY_EXPLORER_RESULT_LIMIT = 20;
export const MAXIMUM_REPOSITORY_EXPLORER_RESULT_LIMIT = 100;

export interface RepositoryExplorerResult {
  readonly buildingId: string;
  readonly moduleId: string;
  readonly moduleName: string;
  readonly name: string;
  readonly path: string;
  readonly maximumComplexity: number;
}

export interface RepositoryExplorerDistrictResult {
  readonly districtId: string;
  readonly moduleId: string;
  readonly moduleName: string;
  readonly name: string;
  readonly path: string;
  readonly buildingCount: number;
}

interface RepositoryExplorerStateBase {
  readonly query: string;
  readonly totalCount: number;
  readonly results: readonly RepositoryExplorerResult[];
}

export interface RepositoryExplorerDistrictState {
  readonly state: "empty-query" | "no-matches" | "results";
  readonly query: string;
  readonly totalCount: number;
  readonly results: readonly RepositoryExplorerDistrictResult[];
}

export type RepositoryExplorerEntityResult =
  | {
      readonly kind: "building";
      readonly result: RepositoryExplorerResult;
    }
  | {
      readonly kind: "district";
      readonly result: RepositoryExplorerDistrictResult;
    };

export interface RepositoryExplorerEntityState {
  readonly state: "empty-query" | "no-matches" | "results";
  readonly query: string;
  readonly totalCount: number;
  readonly results: readonly RepositoryExplorerEntityResult[];
}

export interface EmptyRepositoryExplorerState
  extends RepositoryExplorerStateBase {
  readonly state: "empty-query";
  readonly query: "";
  readonly totalCount: 0;
  readonly results: readonly [];
}

export interface NoMatchesRepositoryExplorerState
  extends RepositoryExplorerStateBase {
  readonly state: "no-matches";
  readonly totalCount: 0;
  readonly results: readonly [];
}

export interface RepositoryExplorerResultsState
  extends RepositoryExplorerStateBase {
  readonly state: "results";
}

export type RepositoryExplorerState =
  | EmptyRepositoryExplorerState
  | NoMatchesRepositoryExplorerState
  | RepositoryExplorerResultsState;

export interface RepositoryExplorerSearchOptions {
  /**
   * The visible result count. Values are clamped to 1..100 so every search
   * remains bounded.
   */
  readonly limit?: number;
}

const repositoryExplorerEntries = Symbol("repositoryExplorerEntries");
const repositoryExplorerDistrictEntries = Symbol(
  "repositoryExplorerDistrictEntries",
);

export interface RepositoryExplorerIndex {
  readonly buildingCount: number;
  readonly districtCount: number;
  readonly [repositoryExplorerEntries]: readonly IndexedBuilding[];
  readonly [repositoryExplorerDistrictEntries]: readonly IndexedDistrict[];
}

export interface ExplorerState {
  readonly selectedEntity: SceneEntity | null;
  readonly isolatedDistrictId: string | null;
}

export const INITIAL_EXPLORER_STATE: ExplorerState = Object.freeze({
  selectedEntity: null,
  isolatedDistrictId: null,
});

interface RankedResult {
  readonly building: IndexedBuilding;
  readonly rank: number;
  readonly position: number;
}

interface IndexedBuilding {
  readonly result: RepositoryExplorerResult;
  readonly fileNameLength: number;
  readonly pathDepth: number;
  readonly foldedName: string;
  readonly foldedPath: string;
  readonly pathSegments: readonly string[];
}

interface RankedDistrictResult {
  readonly district: IndexedDistrict;
  readonly rank: number;
  readonly position: number;
}

interface RankedEntityResult {
  readonly kind: "building" | "district";
  readonly result:
    | RepositoryExplorerResult
    | RepositoryExplorerDistrictResult;
  readonly rank: number;
  readonly position: number;
  readonly nameLength: number;
  readonly pathDepth: number;
  readonly foldedName: string;
  readonly foldedPath: string;
  readonly id: string;
}

interface IndexedDistrict {
  readonly result: RepositoryExplorerDistrictResult;
  readonly nameLength: number;
  readonly pathDepth: number;
  readonly foldedName: string;
  readonly foldedPath: string;
  readonly pathSegments: readonly string[];
}

/**
 * Takes a search snapshot of a model. Normalized paths and presentation data
 * are computed once and do not follow later mutations of the source model.
 */
export function createRepositoryExplorerIndex(
  model: Pick<CityModel, "buildings" | "districts" | "modules">,
): RepositoryExplorerIndex {
  const modules = new Map(
    model.modules.map((module) => [module.id, module.name]),
  );
  const entries = model.buildings.map((building) =>
    indexBuilding(building, modules),
  );
  const buildingCounts = new Map<string, number>();
  for (const building of model.buildings) {
    buildingCounts.set(
      building.districtId,
      (buildingCounts.get(building.districtId) ?? 0) + 1,
    );
  }
  const districtEntries = model.districts.map((district) =>
    indexDistrict(
      district,
      modules,
      buildingCounts.get(district.id) ?? 0,
    ),
  );
  return Object.freeze({
    buildingCount: entries.length,
    districtCount: districtEntries.length,
    [repositoryExplorerEntries]: Object.freeze(entries),
    [repositoryExplorerDistrictEntries]: Object.freeze(districtEntries),
  });
}

/**
 * Searches a precomputed index. Matching ignores case and treats Windows and
 * POSIX separators alike. Only the best visible candidates are retained even
 * when every indexed building matches.
 */
export function searchRepositoryBuildings(
  index: RepositoryExplorerIndex,
  query: string,
  options: RepositoryExplorerSearchOptions = {},
): RepositoryExplorerState {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) {
    return {
      state: "empty-query",
      query: "",
      totalCount: 0,
      results: [],
    };
  }

  const foldedQuery = normalizedQuery.toLowerCase();
  const limit = resultLimit(options.limit);
  const best: RankedResult[] = [];
  let totalCount = 0;

  for (const building of index[repositoryExplorerEntries]) {
    const candidate = rankBuilding(building, foldedQuery);
    if (candidate) {
      totalCount += 1;
      retainBestCandidate(best, candidate, limit);
    }
  }

  if (totalCount === 0) {
    return {
      state: "no-matches",
      query: normalizedQuery,
      totalCount: 0,
      results: [],
    };
  }

  return {
    state: "results",
    query: normalizedQuery,
    totalCount,
    results: best.map(({ building }) => building.result),
  };
}

export function searchRepositoryDistricts(
  index: RepositoryExplorerIndex,
  query: string,
  options: RepositoryExplorerSearchOptions = {},
): RepositoryExplorerDistrictState {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) {
    return {
      state: "empty-query",
      query: "",
      totalCount: 0,
      results: [],
    };
  }

  const foldedQuery = normalizedQuery.toLowerCase();
  const limit = resultLimit(options.limit);
  const best: RankedDistrictResult[] = [];
  let totalCount = 0;

  for (const district of index[repositoryExplorerDistrictEntries]) {
    const ranked = rankIndexedText(
      district.foldedName,
      district.foldedPath,
      district.pathSegments,
      foldedQuery,
    );
    if (!ranked) continue;
    totalCount += 1;
    retainBestDistrict(
      best,
      { district, ...ranked },
      limit,
    );
  }

  return {
    state: totalCount === 0 ? "no-matches" : "results",
    query: normalizedQuery,
    totalCount,
    results: best.map(({ district }) => district.result),
  };
}

export function searchRepositoryEntities(
  index: RepositoryExplorerIndex,
  query: string,
  options: RepositoryExplorerSearchOptions = {},
): RepositoryExplorerEntityState {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) {
    return {
      state: "empty-query",
      query: "",
      totalCount: 0,
      results: [],
    };
  }

  const foldedQuery = normalizedQuery.toLowerCase();
  const limit = resultLimit(options.limit);
  const best: RankedEntityResult[] = [];
  let totalCount = 0;

  for (const building of index[repositoryExplorerEntries]) {
    const ranked = rankIndexedText(
      building.foldedName,
      building.foldedPath,
      building.pathSegments,
      foldedQuery,
    );
    if (!ranked) continue;
    totalCount += 1;
    retainBestEntity(
      best,
      {
        kind: "building",
        result: building.result,
        nameLength: building.fileNameLength,
        pathDepth: building.pathDepth,
        foldedName: building.foldedName,
        foldedPath: building.foldedPath,
        id: building.result.buildingId,
        ...ranked,
      },
      limit,
    );
  }

  for (const district of index[repositoryExplorerDistrictEntries]) {
    const ranked = rankIndexedText(
      district.foldedName,
      district.foldedPath,
      district.pathSegments,
      foldedQuery,
    );
    if (!ranked) continue;
    totalCount += 1;
    retainBestEntity(
      best,
      {
        kind: "district",
        result: district.result,
        nameLength: district.nameLength,
        pathDepth: district.pathDepth,
        foldedName: district.foldedName,
        foldedPath: district.foldedPath,
        id: district.result.districtId,
        ...ranked,
      },
      limit,
    );
  }

  return {
    state: totalCount === 0 ? "no-matches" : "results",
    query: normalizedQuery,
    totalCount,
    results: best.map(({ kind, result }) =>
      kind === "building"
        ? {
            kind,
            result: result as RepositoryExplorerResult,
          }
        : {
            kind,
            result: result as RepositoryExplorerDistrictResult,
          },
    ),
  };
}

export function resetExplorerState(): ExplorerState {
  return INITIAL_EXPLORER_STATE;
}

/**
 * Selects only buildings belonging to the current model. When a district is
 * already isolated, selection follows the newly selected building to its
 * district.
 */
export function selectExplorerBuilding(
  state: ExplorerState,
  model: Pick<CityModel, "buildings">,
  buildingId: string,
): ExplorerState {
  const building = model.buildings.find(({ id }) => id === buildingId);
  if (!building) {
    return state;
  }

  return {
    selectedEntity: createSceneEntity("building", building.id),
    isolatedDistrictId:
      state.isolatedDistrictId === null
        ? null
        : building.districtId,
  };
}

export function selectExplorerDistrict(
  state: ExplorerState,
  model: Pick<CityModel, "districts">,
  districtId: string,
): ExplorerState {
  if (!model.districts.some(({ id }) => id === districtId)) {
    return state;
  }
  return {
    selectedEntity: createSceneEntity("district", districtId),
    isolatedDistrictId:
      state.isolatedDistrictId === null ? null : districtId,
  };
}

export function clearExplorerSelection(state: ExplorerState): ExplorerState {
  if (state.selectedEntity === null) {
    return state;
  }
  return {
    selectedEntity: null,
    isolatedDistrictId: state.isolatedDistrictId,
  };
}

export function selectedExplorerBuildingId(
  state: ExplorerState,
): string | null {
  return state.selectedEntity?.kind === "building"
    ? state.selectedEntity.id
    : null;
}

export function selectedExplorerExternalId(
  state: ExplorerState,
): string | null {
  return state.selectedEntity?.kind === "external"
    ? state.selectedEntity.id
    : null;
}

export function selectedExplorerDistrictId(
  state: ExplorerState,
): string | null {
  return state.selectedEntity?.kind === "district"
    ? state.selectedEntity.id
    : null;
}

export function isolateSelectedDistrict(
  state: ExplorerState,
  model: Pick<CityModel, "buildings" | "districts">,
): ExplorerState {
  const selectedDistrictId = selectedExplorerDistrictId(state);
  if (
    selectedDistrictId !== null &&
    model.districts.some(({ id }) => id === selectedDistrictId)
  ) {
    if (state.isolatedDistrictId === selectedDistrictId) return state;
    return {
      selectedEntity: state.selectedEntity,
      isolatedDistrictId: selectedDistrictId,
    };
  }
  const selectedBuildingId = selectedExplorerBuildingId(state);
  if (selectedBuildingId === null) {
    return state;
  }
  const building = model.buildings.find(
    ({ id }) => id === selectedBuildingId,
  );
  if (!building || state.isolatedDistrictId === building.districtId) {
    return state;
  }
  return {
    selectedEntity: state.selectedEntity,
    isolatedDistrictId: building.districtId,
  };
}

export function showAllDistricts(state: ExplorerState): ExplorerState {
  if (state.isolatedDistrictId === null) {
    return state;
  }
  return {
    selectedEntity: state.selectedEntity,
    isolatedDistrictId: null,
  };
}

function indexBuilding(
  building: CityBuilding,
  modules: ReadonlyMap<string, string>,
): IndexedBuilding {
  const path = normalizeSearchText(building.path);
  const name = normalizeSearchText(building.name);
  const fileName = lastPathSegment(name) || lastPathSegment(path);
  const foldedPath = path.toLowerCase();
  const foldedName = fileName.toLowerCase();
  const pathSegments = foldedPath.split("/").filter(Boolean);

  return {
    result: Object.freeze({
      buildingId: building.id,
      moduleId: building.moduleId,
      moduleName: modules.get(building.moduleId) ?? building.moduleId,
      name: building.name,
      path,
      maximumComplexity: building.metrics.maximumComplexity,
    }),
    fileNameLength: foldedName.length,
    pathDepth: pathSegments.length,
    foldedName,
    foldedPath,
    pathSegments,
  };
}

function indexDistrict(
  district: CityDistrict,
  modules: ReadonlyMap<string, string>,
  buildingCount: number,
): IndexedDistrict {
  const path = normalizeSearchText(district.path);
  const name = normalizeSearchText(district.name);
  const foldedPath = path.toLowerCase();
  const foldedName = name.toLowerCase();
  return {
    result: Object.freeze({
      districtId: district.id,
      moduleId: district.moduleId,
      moduleName: modules.get(district.moduleId) ?? district.moduleId,
      name: district.name,
      path,
      buildingCount,
    }),
    nameLength: foldedName.length,
    pathDepth: foldedPath.split("/").filter(Boolean).length,
    foldedName,
    foldedPath,
    pathSegments: foldedPath.split("/").filter(Boolean),
  };
}

function rankBuilding(
  building: IndexedBuilding,
  query: string,
): RankedResult | null {
  const {
    foldedName,
    foldedPath,
    pathSegments,
  } = building;
  const ranked = rankIndexedText(
    foldedName,
    foldedPath,
    pathSegments,
    query,
  );
  if (!ranked) return null;

  return {
    building,
    ...ranked,
  };
}

function rankIndexedText(
  foldedName: string,
  foldedPath: string,
  pathSegments: readonly string[],
  query: string,
): { readonly rank: number; readonly position: number } | null {
  const pathPosition = foldedPath.indexOf(query);
  const namePosition = foldedName.indexOf(query);

  if (foldedPath === query) return { rank: 0, position: 0 };
  if (foldedName === query) return { rank: 1, position: 0 };
  if (foldedPath.endsWith(`/${query}`)) {
    return { rank: 2, position: foldedPath.length - query.length };
  }
  if (foldedName.startsWith(query)) return { rank: 3, position: 0 };
  if (
    namePosition >= 0 &&
    isSearchBoundary(foldedName[namePosition - 1])
  ) {
    return { rank: 4, position: namePosition };
  }
  if (namePosition >= 0) return { rank: 5, position: namePosition };

  const exactSegment = pathSegments.indexOf(query);
  if (exactSegment >= 0) return { rank: 6, position: exactSegment };
  const prefixSegment = pathSegments.findIndex((segment) =>
    segment.startsWith(query),
  );
  if (prefixSegment >= 0) return { rank: 7, position: prefixSegment };
  return pathPosition >= 0
    ? { rank: 8, position: pathPosition }
    : null;
}

function normalizeSearchText(value: string): string {
  return value
    .trim()
    .replaceAll("\\", "/")
    .replace(/\/+/g, "/")
    .replace(/^(?:\.\/)+/, "")
    .replace(/^\/+|\/+$/g, "");
}

function lastPathSegment(path: string): string {
  return path.split("/").at(-1) ?? "";
}

function isSearchBoundary(character: string | undefined): boolean {
  return character === undefined || !/[a-z0-9]/i.test(character);
}

function resultLimit(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) {
    return DEFAULT_REPOSITORY_EXPLORER_RESULT_LIMIT;
  }
  return Math.min(
    MAXIMUM_REPOSITORY_EXPLORER_RESULT_LIMIT,
    Math.max(1, Math.floor(requested)),
  );
}

function compareRankedResults(
  left: RankedResult,
  right: RankedResult,
): number {
  const leftBuilding = left.building;
  const rightBuilding = right.building;
  return (
    left.rank - right.rank ||
    left.position - right.position ||
    leftBuilding.fileNameLength - rightBuilding.fileNameLength ||
    leftBuilding.pathDepth - rightBuilding.pathDepth ||
    compareText(leftBuilding.foldedName, rightBuilding.foldedName) ||
    compareText(leftBuilding.foldedPath, rightBuilding.foldedPath) ||
    compareText(
      leftBuilding.result.buildingId,
      rightBuilding.result.buildingId,
    )
  );
}

function compareRankedDistricts(
  left: RankedDistrictResult,
  right: RankedDistrictResult,
): number {
  return (
    left.rank - right.rank ||
    left.position - right.position ||
    left.district.nameLength - right.district.nameLength ||
    left.district.pathDepth - right.district.pathDepth ||
    compareText(left.district.foldedName, right.district.foldedName) ||
    compareText(left.district.foldedPath, right.district.foldedPath) ||
    compareText(
      left.district.result.districtId,
      right.district.result.districtId,
    )
  );
}

function compareRankedEntities(
  left: RankedEntityResult,
  right: RankedEntityResult,
): number {
  return (
    left.rank - right.rank ||
    left.position - right.position ||
    left.nameLength - right.nameLength ||
    left.pathDepth - right.pathDepth ||
    compareText(left.foldedName, right.foldedName) ||
    compareText(left.foldedPath, right.foldedPath) ||
    compareText(left.kind, right.kind) ||
    compareText(left.id, right.id)
  );
}

function retainBestCandidate(
  best: RankedResult[],
  candidate: RankedResult,
  limit: number,
): void {
  let low = 0;
  let high = best.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const existing = best[middle];
    if (
      existing !== undefined &&
      compareRankedResults(candidate, existing) < 0
    ) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }

  if (low >= limit) {
    return;
  }
  best.splice(low, 0, candidate);
  if (best.length > limit) {
    best.pop();
  }
}

function retainBestDistrict(
  best: RankedDistrictResult[],
  candidate: RankedDistrictResult,
  limit: number,
): void {
  let low = 0;
  let high = best.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const existing = best[middle];
    if (
      existing !== undefined &&
      compareRankedDistricts(candidate, existing) < 0
    ) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }
  if (low >= limit) return;
  best.splice(low, 0, candidate);
  if (best.length > limit) best.pop();
}

function retainBestEntity(
  best: RankedEntityResult[],
  candidate: RankedEntityResult,
  limit: number,
): void {
  let low = 0;
  let high = best.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const existing = best[middle];
    if (
      existing !== undefined &&
      compareRankedEntities(candidate, existing) < 0
    ) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }
  if (low >= limit) return;
  best.splice(low, 0, candidate);
  if (best.length > limit) best.pop();
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
