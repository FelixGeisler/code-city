import type {
  CityBuilding,
  CityModel,
} from "../../../packages/core/src/model.js";

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

interface RepositoryExplorerStateBase {
  readonly query: string;
  readonly totalCount: number;
  readonly results: readonly RepositoryExplorerResult[];
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

export interface RepositoryExplorerIndex {
  readonly buildingCount: number;
  readonly [repositoryExplorerEntries]: readonly IndexedBuilding[];
}

export interface ExplorerState {
  readonly selectedBuildingId: string | null;
  readonly isolatedDistrictId: string | null;
}

export const INITIAL_EXPLORER_STATE: ExplorerState = Object.freeze({
  selectedBuildingId: null,
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

/**
 * Takes a search snapshot of a model. Normalized paths and presentation data
 * are computed once and do not follow later mutations of the source model.
 */
export function createRepositoryExplorerIndex(
  model: Pick<CityModel, "buildings" | "modules">,
): RepositoryExplorerIndex {
  const modules = new Map(
    model.modules.map((module) => [module.id, module.name]),
  );
  const entries = model.buildings.map((building) =>
    indexBuilding(building, modules),
  );
  return Object.freeze({
    buildingCount: entries.length,
    [repositoryExplorerEntries]: Object.freeze(entries),
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
    selectedBuildingId: building.id,
    isolatedDistrictId:
      state.isolatedDistrictId === null
        ? null
        : building.districtId,
  };
}

export function clearExplorerSelection(state: ExplorerState): ExplorerState {
  if (state.selectedBuildingId === null) {
    return state;
  }
  return {
    selectedBuildingId: null,
    isolatedDistrictId: state.isolatedDistrictId,
  };
}

export function isolateSelectedDistrict(
  state: ExplorerState,
  model: Pick<CityModel, "buildings">,
): ExplorerState {
  if (state.selectedBuildingId === null) {
    return state;
  }
  const building = model.buildings.find(
    ({ id }) => id === state.selectedBuildingId,
  );
  if (!building || state.isolatedDistrictId === building.districtId) {
    return state;
  }
  return {
    selectedBuildingId: state.selectedBuildingId,
    isolatedDistrictId: building.districtId,
  };
}

export function showAllDistricts(state: ExplorerState): ExplorerState {
  if (state.isolatedDistrictId === null) {
    return state;
  }
  return {
    selectedBuildingId: state.selectedBuildingId,
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

function rankBuilding(
  building: IndexedBuilding,
  query: string,
): RankedResult | null {
  const {
    foldedName,
    foldedPath,
    pathSegments,
  } = building;
  const pathPosition = foldedPath.indexOf(query);
  const namePosition = foldedName.indexOf(query);

  let rank: number;
  let position: number;
  if (foldedPath === query) {
    rank = 0;
    position = 0;
  } else if (foldedName === query) {
    rank = 1;
    position = 0;
  } else if (foldedPath.endsWith(`/${query}`)) {
    rank = 2;
    position = foldedPath.length - query.length;
  } else if (foldedName.startsWith(query)) {
    rank = 3;
    position = 0;
  } else if (
    namePosition >= 0 &&
    isSearchBoundary(foldedName[namePosition - 1])
  ) {
    rank = 4;
    position = namePosition;
  } else if (namePosition >= 0) {
    rank = 5;
    position = namePosition;
  } else {
    const exactSegment = pathSegments.indexOf(query);
    const prefixSegment = pathSegments.findIndex((segment) =>
      segment.startsWith(query),
    );
    if (exactSegment >= 0) {
      rank = 6;
      position = exactSegment;
    } else if (prefixSegment >= 0) {
      rank = 7;
      position = prefixSegment;
    } else if (pathPosition >= 0) {
      rank = 8;
      position = pathPosition;
    } else {
      return null;
    }
  }

  return {
    building,
    rank,
    position,
  };
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

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
