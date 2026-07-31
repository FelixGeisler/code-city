import type { CityBuilding, SourceStructure } from "../../../packages/core/src/model.js";

export const FINE_DETAIL_INITIAL_LIMIT = 40;
export const FINE_DETAIL_MAXIMUM_LIMIT = 200;
export type FineDetailState = "available" | "unavailable" | "bounded";
export interface FineDetailNode {
  readonly id: string;
  readonly kind: "type" | "function";
  readonly name: string;
  readonly startLine: number;
  readonly startColumn?: number;
  readonly endLine: number;
  readonly endColumn?: number;
  readonly complexity?: number;
  readonly parentId?: string;
  readonly provenance: "persisted-source-structure" | "persisted-executable-unit";
}
export interface FineDetailProjection { readonly state: FineDetailState; readonly buildingId: string; readonly nodes: readonly FineDetailNode[]; readonly totalCount: number; readonly omittedCount: number; readonly unavailable: readonly string[]; readonly printable: { readonly state: "not-printable"; readonly reason: string }; }

/**
 * Bounded lazy projection for one selected file. This function is deliberately
 * data-only: city startup never requests it and it allocates no Three.js mesh.
 */
export function projectFineDetail(building: CityBuilding, requestedLimit = FINE_DETAIL_INITIAL_LIMIT): FineDetailProjection {
  const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(FINE_DETAIL_MAXIMUM_LIMIT, Math.floor(requestedLimit))) : FINE_DETAIL_INITIAL_LIMIT;
  const structure = building.sourceStructure;
  if (structure?.availability === "available") return bounded(building.id, structureNodes(structure), structure.unavailable, limit);
  if (!building.units || !building.sourceLocation) return unavailable(building, structure?.unavailable);
  const nodes = building.units.map((unit, index) => Object.freeze({ id: `${building.id}:function:${String(index).padStart(4, "0")}`, kind: "function" as const, name: unit.name, startLine: unit.line, endLine: unit.endLine ?? unit.line, complexity: unit.complexity, provenance: "persisted-executable-unit" as const })).sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine || a.id.localeCompare(b.id));
  return bounded(building.id, nodes, Object.freeze([`${languageLabel(building.language)} type/class declarations are unavailable in this legacy model; functions use persisted executable-unit ranges.`]), limit);
}

function structureNodes(structure: SourceStructure): readonly FineDetailNode[] {
  const types = structure.types.map((item) => Object.freeze({ id: item.id, kind: "type" as const, name: item.name, startLine: item.range.startLine, startColumn: item.range.startColumn, endLine: item.range.endLine, endColumn: item.range.endColumn, ...(item.parentTypeId === undefined ? {} : { parentId: item.parentTypeId }), provenance: "persisted-source-structure" as const }));
  const functions = structure.callables.map((item) => Object.freeze({ id: item.id, kind: "function" as const, name: item.name, startLine: item.range.startLine, startColumn: item.range.startColumn, endLine: item.range.endLine, endColumn: item.range.endColumn, ...(item.complexity === undefined ? {} : { complexity: item.complexity }), ...(item.enclosingTypeId === undefined ? {} : { parentId: item.enclosingTypeId }), provenance: "persisted-source-structure" as const }));
  return [...types, ...functions].sort((a, b) => a.startLine - b.startLine || (a.startColumn ?? 0) - (b.startColumn ?? 0) || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

function bounded(buildingId: string, all: readonly FineDetailNode[], unavailable_: readonly string[], limit: number): FineDetailProjection {
  const nodes = Object.freeze(all.slice(0, limit));
  return Object.freeze({ state: all.length > nodes.length ? "bounded" : "available", buildingId, nodes, totalCount: all.length, omittedCount: all.length - nodes.length, unavailable: Object.freeze([...unavailable_]), printable: { state: "not-printable" as const, reason: "Fine detail is interactive-only and is deliberately excluded from file-level print exports." } });
}

function unavailable(building: CityBuilding, explanation: readonly string[] | undefined): FineDetailProjection {
  return Object.freeze({ state: "unavailable", buildingId: building.id, nodes: [], totalCount: 0, omittedCount: 0, unavailable: Object.freeze(explanation === undefined ? [`${languageLabel(building.language)} fine detail is unavailable because this model has no persisted declaration or executable-unit source ranges.`] : [...explanation]), printable: { state: "not-printable" as const, reason: "Fine detail is interactive-only and is deliberately excluded from file-level print exports." } });
}
function languageLabel(language: CityBuilding["language"]): string { return language === "csharp" ? "C#" : language === "typescript" ? "TypeScript" : "JavaScript"; }
