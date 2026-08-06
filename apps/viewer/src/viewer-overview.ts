import type {
  CityBuilding,
  CityDependency,
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

export interface ViewerOverviewCounts {
  readonly repositories: number;
  readonly solutions: number;
  readonly modules: number;
  readonly districts: number;
  readonly buildings: number;
}

export interface ViewerOverviewComplexity {
  readonly totalSloc: number;
  readonly medianMaximumComplexity: number;
  readonly maximumComplexity: number;
}

export type ViewerOverviewRiskCounts = Readonly<Record<RiskBand, number>>;

export interface ViewerOverviewDependencies {
  readonly edgeCount: number;
  readonly totalReferenceWeight: number;
}

export interface ViewerOverviewSummary {
  readonly counts: ViewerOverviewCounts;
  readonly complexity: ViewerOverviewComplexity;
  readonly risks: ViewerOverviewRiskCounts;
  readonly dependencies: ViewerOverviewDependencies;
}

/** Summarizes the complete city model shown by Explore. */
export function summarizeViewerOverview(
  model: ViewerOverviewModel,
): ViewerOverviewSummary {
  return Object.freeze({
    counts: Object.freeze({
      repositories: distinctIds(model.repositories),
      solutions: distinctIds(model.solutions),
      modules: distinctIds(model.modules),
      districts: distinctIds(model.districts),
      buildings: distinctIds(model.buildings),
    }),
    complexity: summarizeComplexity(model.buildings),
    risks: summarizeRisks(model.buildings),
    dependencies: summarizeDependencies(model.dependencies),
  });
}

function distinctIds(
  values: readonly { readonly id: string }[],
): number {
  return new Set(values.map(({ id }) => id)).size;
}

function summarizeComplexity(
  buildings: readonly CityBuilding[],
): ViewerOverviewComplexity {
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
): ViewerOverviewRiskCounts {
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
): ViewerOverviewDependencies {
  return Object.freeze({
    edgeCount: dependencies.length,
    totalReferenceWeight: dependencies.reduce(
      (total, { weight }) => total + weight,
      0,
    ),
  });
}
