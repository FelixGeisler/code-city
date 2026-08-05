import {
  designSmellSeverity,
  DESIGN_SMELL_RULE_CATALOG,
  type DesignSmellSeverity,
} from "../../../packages/core/src/design-smells.js";
import type {
  CityBuilding,
  ExecutableUnitMetric,
  SourceLanguage,
} from "../../../packages/core/src/model.js";

export const INITIAL_EXECUTABLE_UNIT_VISIBLE_LIMIT = 10;
export const MAXIMUM_EXECUTABLE_UNIT_VISIBLE_LIMIT = 10_000;
export const INITIAL_COMPLEXITY_HOTSPOT_VISIBLE_LIMIT = 5;

export type ExecutableUnitSort = "complexity" | "source";

export interface ExecutableUnitPresentationOptions {
  readonly visibleLimit?: number;
  readonly query?: string;
  readonly sort?: ExecutableUnitSort;
}

export interface ExecutableUnitPresentation {
  readonly count: number;
  readonly matchingCount: number;
  readonly visibleCount: number;
  readonly hiddenCount: number;
  readonly maximumComplexity: number;
  readonly query: string;
  readonly sort: ExecutableUnitSort;
  readonly rows: readonly ExecutableUnitMetric[];
}

export interface ComplexityHotspot extends ExecutableUnitMetric {
  readonly severity: DesignSmellSeverity;
  readonly threshold: number;
}

export type BuildingComplexityPresentation =
  | {
      readonly state: "available";
      readonly buildingId: string;
      readonly executableUnitCount: number;
      readonly maximumComplexity: number;
      readonly threshold: number;
      readonly hotspotCount: number;
      readonly hiddenHotspotCount: number;
      readonly hotspots: readonly ComplexityHotspot[];
      readonly allUnits: ExecutableUnitPresentation | null;
    }
  | {
      readonly state: "unavailable" | "inconsistent";
      readonly buildingId: string;
      readonly executableUnitCount: number;
      readonly maximumComplexity: number;
      readonly threshold: number;
      readonly reason: string;
      readonly hotspotCount: 0;
      readonly hiddenHotspotCount: 0;
      readonly hotspots: readonly [];
      readonly allUnits: null;
    };

export function canRevealMoreExecutableUnits(
  presentation: ExecutableUnitPresentation,
): boolean {
  return (
    presentation.hiddenCount > 0 &&
    presentation.visibleCount <
      MAXIMUM_EXECUTABLE_UNIT_VISIBLE_LIMIT
  );
}

export function presentBuildingComplexity(
  building: CityBuilding,
  options: ExecutableUnitPresentationOptions & {
    readonly hotspotVisibleLimit?: number;
  } = {},
): BuildingComplexityPresentation {
  const threshold = complexityThreshold(building.language);
  const headline = {
    buildingId: building.id,
    executableUnitCount: building.metrics.executableUnitCount,
    maximumComplexity: building.metrics.maximumComplexity,
    threshold,
  } as const;

  if (building.units === undefined) {
    return {
      state: "unavailable",
      ...headline,
      reason:
        "Executable-unit complexity details were not recorded for this building. " +
        "Its headline file metrics remain available, but individual hotspots cannot be identified safely.",
      hotspotCount: 0,
      hiddenHotspotCount: 0,
      hotspots: [],
      allUnits: null,
    };
  }

  const measuredMaximum = building.units.reduce(
    (maximum, unit) => Math.max(maximum, unit.complexity),
    0,
  );
  if (
    building.units.length !== building.metrics.executableUnitCount ||
    measuredMaximum !== building.metrics.maximumComplexity
  ) {
    return {
      state: "inconsistent",
      ...headline,
      reason:
        "Executable-unit details do not match this building's headline unit count or maximum complexity. " +
        "Rows are withheld to avoid presenting mixed or stale facts.",
      hotspotCount: 0,
      hiddenHotspotCount: 0,
      hotspots: [],
      allUnits: null,
    };
  }

  const hotspotVisibleLimit = normalizeHotspotVisibleLimit(
    options.hotspotVisibleLimit,
  );
  // Project the existing high-complexity-method evidence for one building:
  // persisted unit facts, the catalog threshold, and the shared severity
  // classifier. Do not run a second analyzer or infer missing unit facts.
  const allHotspots = building.units
    .filter(({ complexity }) => complexity >= threshold)
    .sort(compareComplexityFirst)
    .map((unit) => ({
      ...unit,
      threshold,
      severity: designSmellSeverity(unit.complexity, threshold),
    }));
  const hotspots = allHotspots.slice(0, hotspotVisibleLimit);

  return {
    state: "available",
    ...headline,
    hotspotCount: allHotspots.length,
    hiddenHotspotCount: allHotspots.length - hotspots.length,
    hotspots,
    allUnits: presentExecutableUnits(building.units, options),
  };
}

export function presentExecutableUnits(
  units: readonly ExecutableUnitMetric[] | undefined,
  options: ExecutableUnitPresentationOptions = {},
): ExecutableUnitPresentation | null {
  if (!units || units.length === 0) {
    return null;
  }

  const query = normalizeQuery(options.query);
  const sort = options.sort ?? "complexity";
  const matchingRows = units
    .filter((unit) => matchesUnitQuery(unit, query))
    .sort(sort === "source" ? compareSourceFirst : compareComplexityFirst);
  const visibleLimit = normalizeVisibleLimit(options.visibleLimit);
  const rows = matchingRows.slice(0, visibleLimit);

  return {
    count: units.length,
    matchingCount: matchingRows.length,
    visibleCount: rows.length,
    hiddenCount: matchingRows.length - rows.length,
    maximumComplexity: units.reduce(
      (maximum, { complexity }) => Math.max(maximum, complexity),
      0,
    ),
    query,
    sort,
    rows,
  };
}

function complexityThreshold(language: SourceLanguage): number {
  const rule = DESIGN_SMELL_RULE_CATALOG.find(
    ({ id }) => id === "high-complexity-method",
  );
  return rule !== undefined && "threshold" in rule
    ? rule.threshold[language]
    : 15;
}

function matchesUnitQuery(
  unit: ExecutableUnitMetric,
  query: string,
): boolean {
  if (query.length === 0) return true;
  const endLine = unit.endLine ?? unit.line;
  return [
    unit.name,
    String(unit.line),
    `${unit.line}-${endLine}`,
    String(unit.complexity),
  ].some((value) => value.toLowerCase().includes(query));
}

function normalizeQuery(query: string | undefined): string {
  return query?.trim().toLowerCase() ?? "";
}

function normalizeHotspotVisibleLimit(
  visibleLimit: number | undefined,
): number {
  if (visibleLimit === undefined || !Number.isFinite(visibleLimit)) {
    return INITIAL_COMPLEXITY_HOTSPOT_VISIBLE_LIMIT;
  }
  return Math.min(
    MAXIMUM_EXECUTABLE_UNIT_VISIBLE_LIMIT,
    Math.max(1, Math.floor(visibleLimit)),
  );
}

function normalizeVisibleLimit(visibleLimit: number | undefined): number {
  if (visibleLimit === undefined || !Number.isFinite(visibleLimit)) {
    return INITIAL_EXECUTABLE_UNIT_VISIBLE_LIMIT;
  }

  return Math.min(
    MAXIMUM_EXECUTABLE_UNIT_VISIBLE_LIMIT,
    Math.max(1, Math.floor(visibleLimit)),
  );
}

function compareComplexityFirst(
  left: ExecutableUnitMetric,
  right: ExecutableUnitMetric,
): number {
  return (
    right.complexity - left.complexity ||
    compareSourceFirst(left, right)
  );
}

function compareSourceFirst(
  left: ExecutableUnitMetric,
  right: ExecutableUnitMetric,
): number {
  return (
    left.line - right.line ||
    right.complexity - left.complexity ||
    (left.endLine ?? left.line) - (right.endLine ?? right.line) ||
    compareText(left.name, right.name)
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
