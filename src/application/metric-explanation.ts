import type { InspectionFact } from "../domain/city-model";
import {
  COMPLEXITY_PALETTE_LEGEND,
  displayedHeight,
  displayedSide,
  paletteBandForComplexity,
} from "../domain/city-model";

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
    height: displayedHeight(fact.S),
    width: displayedSide(fact.U),
    depth: displayedSide(fact.U),
    paletteRange: band.range,
    rgba: band.rgba,
  });
}
