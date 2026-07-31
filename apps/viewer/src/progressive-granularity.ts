import type { CityBuilding, SourceCallableFact, SourceStructure, SourceTypeFact } from "../../../packages/core/src/model.js";

export const FINE_DETAIL_INITIAL_LIMIT = 40;
export const FINE_DETAIL_MAXIMUM_LIMIT = 200;
export type FineDetailState = "available" | "unavailable" | "bounded" | "capped";
export interface FineDetailNode {
  readonly id: string;
  readonly category: "type" | "callable";
  readonly kind: SourceTypeFact["kind"] | SourceCallableFact["kind"] | "executable-unit";
  readonly name: string;
  readonly startLine: number;
  readonly startColumn?: number;
  readonly endLine: number;
  readonly endColumn?: number;
  readonly complexity?: number;
  readonly parentId?: string;
  readonly provenance: "persisted-source-structure" | "persisted-executable-unit";
  readonly explanation: string;
}
export interface FineDetailProjection {
  readonly state: FineDetailState;
  readonly buildingId: string;
  readonly nodes: readonly FineDetailNode[];
  readonly totalCount: number;
  readonly omittedCount: number;
  readonly canLoadMore: boolean;
  readonly terminalReason?: string;
  readonly unavailable: readonly string[];
  readonly printable: { readonly state: "not-printable"; readonly reason: string };
}

/** Bounded data-only projection; no fine-detail scene objects are allocated. */
export function projectFineDetail(building: CityBuilding, requestedLimit = FINE_DETAIL_INITIAL_LIMIT): FineDetailProjection {
  const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(FINE_DETAIL_MAXIMUM_LIMIT, Math.floor(requestedLimit))) : FINE_DETAIL_INITIAL_LIMIT;
  const structure = building.sourceStructure;
  if (structure?.availability === "unavailable") return unavailable(building, structure.unavailable);
  if (structure?.availability === "available") return bounded(building.id, structureNodes(structure), structure.unavailable, limit);
  if (!building.units || !building.sourceLocation) return unavailable(building, structure?.unavailable);
  const nodes = building.units.map((unit, index) => Object.freeze({
    id: `${building.id}:function:${String(index).padStart(4, "0")}`,
    category: "callable" as const,
    kind: "executable-unit" as const,
    name: unit.name,
    startLine: unit.line,
    endLine: unit.endLine ?? unit.line,
    complexity: unit.complexity,
    provenance: "persisted-executable-unit" as const,
    explanation: `Executable-unit range persisted by ${building.metricMethod ?? "the analyzer"}; cyclomatic complexity ${unit.complexity}.`,
  })).sort(compareNodes);
  return bounded(building.id, nodes, Object.freeze([`${languageLabel(building.language)} type/class declarations are unavailable in this legacy model; callable rows use persisted executable-unit ranges.`]), limit);
}

function structureNodes(structure: SourceStructure): readonly FineDetailNode[] {
  const types = structure.types.map((item) => Object.freeze({
    id: item.id, category: "type" as const, kind: item.kind, name: item.name,
    startLine: item.range.startLine, startColumn: item.range.startColumn,
    endLine: item.range.endLine, endColumn: item.range.endColumn,
    ...(item.parentTypeId === undefined ? {} : { parentId: item.parentTypeId }),
    provenance: "persisted-source-structure" as const,
    explanation: `${item.kind} declaration from persisted syntax provenance.`,
  }));
  const functions = structure.callables.map((item) => Object.freeze({
    id: item.id, category: "callable" as const, kind: item.kind, name: item.name,
    startLine: item.range.startLine, startColumn: item.range.startColumn,
    endLine: item.range.endLine, endColumn: item.range.endColumn,
    ...(item.complexity === undefined ? {} : { complexity: item.complexity }),
    ...(item.enclosingTypeId === undefined ? {} : { parentId: item.enclosingTypeId }),
    provenance: "persisted-source-structure" as const,
    explanation: `${item.kind} declaration from persisted syntax provenance${item.complexity === undefined ? "." : `; cyclomatic complexity ${item.complexity}.`}`,
  }));
  return [...types, ...functions].sort(compareNodes);
}

function compareNodes(a: FineDetailNode, b: FineDetailNode): number {
  return a.startLine - b.startLine || (a.startColumn ?? 0) - (b.startColumn ?? 0) || compareText(a.category, b.category) || compareText(a.kind, b.kind) || compareText(a.name, b.name) || compareText(a.id, b.id);
}

function bounded(buildingId: string, all: readonly FineDetailNode[], unavailable_: readonly string[], limit: number): FineDetailProjection {
  const nodes = Object.freeze(all.slice(0, limit));
  const omittedCount = all.length - nodes.length;
  const capped = omittedCount > 0 && nodes.length >= FINE_DETAIL_MAXIMUM_LIMIT;
  return Object.freeze({
    state: capped ? "capped" : omittedCount > 0 ? "bounded" : "available",
    buildingId, nodes, totalCount: all.length, omittedCount,
    canLoadMore: omittedCount > 0 && !capped,
    ...(capped ? { terminalReason: `Detail is capped at ${FINE_DETAIL_MAXIMUM_LIMIT.toLocaleString()} declarations for responsive inspection; ${omittedCount.toLocaleString()} remain omitted.` } : {}),
    unavailable: Object.freeze([...unavailable_]),
    printable: { state: "not-printable" as const, reason: "Fine detail is interactive-only and is deliberately excluded from file-level print exports." },
  });
}

function unavailable(building: CityBuilding, explanation: readonly string[] | undefined): FineDetailProjection {
  return Object.freeze({ state: "unavailable", buildingId: building.id, nodes: [], totalCount: 0, omittedCount: 0, canLoadMore: false, unavailable: Object.freeze(explanation === undefined ? [`${languageLabel(building.language)} fine detail is unavailable because this model has no persisted declaration or executable-unit source ranges.`] : [...explanation]), printable: { state: "not-printable" as const, reason: "Fine detail is interactive-only and is deliberately excluded from file-level print exports." } });
}
function languageLabel(language: CityBuilding["language"]): string { return language === "csharp" ? "C#" : language === "typescript" ? "TypeScript" : "JavaScript"; }
function compareText(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
