import type { CityBuilding } from "../../../packages/core/src/model.js";

export const FINE_DETAIL_INITIAL_LIMIT = 40;
export const FINE_DETAIL_MAXIMUM_LIMIT = 200;
export type FineDetailState = "available" | "unavailable" | "bounded";
export interface FineDetailNode { readonly id: string; readonly kind: "function"; readonly name: string; readonly startLine: number; readonly endLine: number; readonly complexity: number; readonly provenance: "persisted-executable-unit"; }
export interface FineDetailProjection { readonly state: FineDetailState; readonly buildingId: string; readonly nodes: readonly FineDetailNode[]; readonly totalCount: number; readonly omittedCount: number; readonly unavailable: readonly string[]; readonly printable: { readonly state: "not-printable"; readonly reason: string }; }

/**
 * Creates no scene meshes. It is a bounded, immutable projection used only
 * after a user drills into one file, keeping the file-level city unchanged.
 */
export function projectFineDetail(building: CityBuilding, requestedLimit = FINE_DETAIL_INITIAL_LIMIT): FineDetailProjection {
  const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(FINE_DETAIL_MAXIMUM_LIMIT, Math.floor(requestedLimit))) : FINE_DETAIL_INITIAL_LIMIT;
  if (!building.units || !building.sourceLocation) return Object.freeze({ state: "unavailable", buildingId: building.id, nodes: [], totalCount: 0, omittedCount: 0, unavailable: Object.freeze([`${languageLabel(building.language)} fine detail is unavailable because this model has no persisted executable-unit source ranges.`]), printable: { state: "not-printable" as const, reason: "Fine detail is an interactive drill-down and is not included in file-level print exports." } });
  const all = building.units.map((unit, index) => Object.freeze({ id: `${building.id}:function:${String(index).padStart(4, "0")}`, kind: "function" as const, name: unit.name, startLine: unit.line, endLine: unit.endLine ?? unit.line, complexity: unit.complexity, provenance: "persisted-executable-unit" as const })).sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine || a.id.localeCompare(b.id));
  const nodes = Object.freeze(all.slice(0, limit));
  const omittedCount = all.length - nodes.length;
  return Object.freeze({ state: omittedCount > 0 ? "bounded" : "available", buildingId: building.id, nodes, totalCount: all.length, omittedCount, unavailable: Object.freeze([`${languageLabel(building.language)} type/class declarations are not persisted by the current analyzer; only functions with recorded ranges are shown.`]), printable: { state: "not-printable" as const, reason: "Fine detail is an interactive drill-down and is not included in file-level print exports." } });
}
function languageLabel(language: CityBuilding["language"]): string { return language === "csharp" ? "C#" : language === "typescript" ? "TypeScript" : "JavaScript"; }
