import type { ExecutableUnitMetric } from "../../../packages/core/src/model.js";

export interface ExecutableUnitPresentation {
  readonly count: number;
  readonly maximumComplexity: number;
  readonly rows: readonly ExecutableUnitMetric[];
}

export function presentExecutableUnits(
  units: readonly ExecutableUnitMetric[] | undefined,
): ExecutableUnitPresentation | null {
  if (!units || units.length === 0) {
    return null;
  }

  const rows = [...units].sort(
    (left, right) =>
      left.line - right.line ||
      right.complexity - left.complexity ||
      compareText(left.name, right.name),
  );

  return {
    count: rows.length,
    maximumComplexity: Math.max(...rows.map(({ complexity }) => complexity)),
    rows,
  };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
