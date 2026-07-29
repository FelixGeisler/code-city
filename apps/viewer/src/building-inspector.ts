import type { ExecutableUnitMetric } from "../../../packages/core/src/model.js";

export const INITIAL_EXECUTABLE_UNIT_VISIBLE_LIMIT = 10;
export const MAXIMUM_EXECUTABLE_UNIT_VISIBLE_LIMIT = 10_000;

export interface ExecutableUnitPresentationOptions {
  readonly visibleLimit?: number;
}

export interface ExecutableUnitPresentation {
  readonly count: number;
  readonly visibleCount: number;
  readonly hiddenCount: number;
  readonly maximumComplexity: number;
  readonly rows: readonly ExecutableUnitMetric[];
}

export function canRevealMoreExecutableUnits(
  presentation: ExecutableUnitPresentation,
): boolean {
  return (
    presentation.hiddenCount > 0 &&
    presentation.visibleCount <
      MAXIMUM_EXECUTABLE_UNIT_VISIBLE_LIMIT
  );
}

export function presentExecutableUnits(
  units: readonly ExecutableUnitMetric[] | undefined,
  options: ExecutableUnitPresentationOptions = {},
): ExecutableUnitPresentation | null {
  if (!units || units.length === 0) {
    return null;
  }

  const sortedRows = [...units].sort(
    (left, right) =>
      left.line - right.line ||
      right.complexity - left.complexity ||
      compareText(left.name, right.name),
  );
  const visibleLimit = normalizeVisibleLimit(options.visibleLimit);
  const rows = sortedRows.slice(0, visibleLimit);

  return {
    count: sortedRows.length,
    visibleCount: rows.length,
    hiddenCount: sortedRows.length - rows.length,
    maximumComplexity: sortedRows.reduce(
      (maximum, { complexity }) => Math.max(maximum, complexity),
      Number.NEGATIVE_INFINITY,
    ),
    rows,
  };
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

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
