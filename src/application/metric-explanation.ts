import type { InspectionFact } from "../domain/city-model";
import { COMPLEXITY_PALETTE_LEGEND, paletteBandForComplexity } from "../domain/city-model";

export type MetricExplanation = Readonly<{
  canonicalPath: string;
  sourceLines: number;
  executableUnits: number;
  maximumComplexity: number;
  height: number;
  width: number;
  depth: number;
  paletteRange: string;
  rgba: string;
}>;

export const METRIC_PALETTE_LEGEND = COMPLEXITY_PALETTE_LEGEND;

export function explainMetricFact(fact: InspectionFact): MetricExplanation {
  const band = paletteBandForComplexity(fact.M);
  return Object.freeze({
    canonicalPath: fact.canonicalPath,
    sourceLines: fact.S,
    executableUnits: fact.U,
    maximumComplexity: fact.M,
    height: fact.S + 1,
    width: fact.U + 1,
    depth: fact.U + 1,
    paletteRange: band.range,
    rgba: band.rgba,
  });
}
