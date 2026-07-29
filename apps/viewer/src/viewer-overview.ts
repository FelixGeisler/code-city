import type {
  CityBuilding,
  CityDependency,
  CityDistrict,
  CityModel,
  RiskBand,
} from "../../../packages/core/src/model.js";

export type ViewerOverviewModel = Pick<
  CityModel,
  | "buildings"
  | "dependencies"
  | "districts"
  | "modules"
  | "repositories"
  | "solutions"
>;

export interface WholeCityViewerScope {
  readonly kind: "city";
  readonly districtId: null;
  readonly name: "Whole city";
  readonly label: "Whole city";
}

export interface DistrictViewerScope {
  readonly kind: "district";
  readonly districtId: string;
  readonly name: string;
  readonly label: string;
}

export type ViewerScope = WholeCityViewerScope | DistrictViewerScope;

export interface ViewerScopeCounts {
  readonly repositories: number;
  readonly solutions: number;
  readonly modules: number;
  readonly districts: number;
  readonly buildings: number;
}

export interface ViewerScopeComplexity {
  readonly totalSloc: number;
  readonly medianMaximumComplexity: number;
  readonly maximumComplexity: number;
}

export type ViewerScopeRiskCounts = Readonly<Record<RiskBand, number>>;

export interface ViewerScopeDependencies {
  readonly edgeCount: number;
  readonly totalReferenceWeight: number;
}

export interface ViewerScopeSummary {
  readonly scope: ViewerScope;
  readonly counts: ViewerScopeCounts;
  readonly complexity: ViewerScopeComplexity;
  readonly risks: ViewerScopeRiskCounts;
  readonly dependencies: ViewerScopeDependencies;
}

/**
 * Summarizes either the whole city or one visible district. An unknown
 * district is treated as the whole city so stale UI state never produces an
 * empty or misleading overview.
 */
export function summarizeViewerScope(
  model: ViewerOverviewModel,
  isolatedDistrictId: string | null,
): ViewerScopeSummary {
  const district =
    isolatedDistrictId === null
      ? undefined
      : model.districts.find(({ id }) => id === isolatedDistrictId);
  const buildings =
    district === undefined
      ? model.buildings
      : model.buildings.filter(
          ({ districtId }) => districtId === district.id,
        );
  const moduleIds = new Set(buildings.map(({ moduleId }) => moduleId));
  const repositoryIds = new Set(
    buildings.map(({ repositoryId }) => repositoryId),
  );
  const dependencies =
    district === undefined
      ? model.dependencies
      : dependenciesFromScope(model.dependencies, buildings, moduleIds);

  return Object.freeze({
    scope: scopeDescriptor(district),
    counts: Object.freeze({
      repositories:
        district === undefined
          ? distinctIds(model.repositories)
          : repositoryIds.size,
      solutions:
        district === undefined
          ? distinctIds(model.solutions)
          : distinctIds(
              model.solutions.filter(({ moduleIds: solutionModuleIds }) =>
                solutionModuleIds.some((moduleId) =>
                  moduleIds.has(moduleId),
                ),
              ),
            ),
      modules:
        district === undefined ? distinctIds(model.modules) : moduleIds.size,
      districts:
        district === undefined ? distinctIds(model.districts) : 1,
      buildings: distinctIds(buildings),
    }),
    complexity: summarizeComplexity(buildings),
    risks: summarizeRisks(buildings),
    dependencies: summarizeDependencies(dependencies),
  });
}

function scopeDescriptor(
  district: CityDistrict | undefined,
): ViewerScope {
  if (district === undefined) {
    return Object.freeze({
      kind: "city",
      districtId: null,
      name: "Whole city",
      label: "Whole city",
    });
  }
  return Object.freeze({
    kind: "district",
    districtId: district.id,
    name: district.name,
    label: `City \u203a ${district.name}`,
  });
}

function dependenciesFromScope(
  dependencies: readonly CityDependency[],
  buildings: readonly CityBuilding[],
  moduleIds: ReadonlySet<string>,
): readonly CityDependency[] {
  const sourceIds = new Set([
    ...buildings.map(({ id }) => id),
    ...moduleIds,
  ]);
  return dependencies.filter(({ sourceId }) => sourceIds.has(sourceId));
}

function distinctIds(
  values: readonly { readonly id: string }[],
): number {
  return new Set(values.map(({ id }) => id)).size;
}

function summarizeComplexity(
  buildings: readonly CityBuilding[],
): ViewerScopeComplexity {
  const maximumComplexities = buildings
    .map(({ metrics }) => metrics.maximumComplexity)
    .toSorted((left, right) => left - right);
  const middle = Math.floor(maximumComplexities.length / 2);
  let medianMaximumComplexity = 0;
  if (maximumComplexities.length % 2 === 1) {
    medianMaximumComplexity = maximumComplexities[middle]!;
  } else if (maximumComplexities.length > 0) {
    medianMaximumComplexity =
      (maximumComplexities[middle - 1]! +
        maximumComplexities[middle]!) /
      2;
  }

  return Object.freeze({
    totalSloc: buildings.reduce(
      (total, { metrics }) => total + metrics.sloc,
      0,
    ),
    medianMaximumComplexity,
    maximumComplexity:
      maximumComplexities[maximumComplexities.length - 1] ?? 0,
  });
}

function summarizeRisks(
  buildings: readonly CityBuilding[],
): ViewerScopeRiskCounts {
  const risks: Record<RiskBand, number> = {
    low: 0,
    moderate: 0,
    high: 0,
    "very-high": 0,
  };
  for (const building of buildings) {
    risks[building.risk] += 1;
  }
  return Object.freeze(risks);
}

function summarizeDependencies(
  dependencies: readonly CityDependency[],
): ViewerScopeDependencies {
  return Object.freeze({
    edgeCount: dependencies.length,
    totalReferenceWeight: dependencies.reduce(
      (total, { weight }) => total + weight,
      0,
    ),
  });
}
