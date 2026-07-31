import type { CityBuilding, CityModel, RiskBand, SourceLanguage } from "../../../packages/core/src/model.js";

/** Stable on-disk contract for saved queries. Increment when semantics change. */
export const ADVANCED_QUERY_VERSION = "codecity.advanced-query/1" as const;
export const ADVANCED_QUERY_RULE_SCHEMA = "codecity.query-rules/1" as const;
export const ADVANCED_QUERY_DEFAULT_LIMIT = 100;
export const ADVANCED_QUERY_MAXIMUM_LIMIT = 500;

export type AdvancedQueryField =
  | "name"
  | "path"
  | "language"
  | "risk"
  | "sloc"
  | "decisionLoad"
  | "maximumComplexity"
  | "incomingDependencies"
  | "outgoingDependencies"
  | "changedRecently"
  | "smell";
export type AdvancedQueryOperator = "contains" | "equals" | "atLeast" | "atMost";

export interface AdvancedQueryClause {
  readonly field: AdvancedQueryField;
  readonly operator: AdvancedQueryOperator;
  readonly value: string | number;
}

export interface AdvancedQuery {
  readonly version: typeof ADVANCED_QUERY_VERSION;
  /** Metric/rule definition used when the query was authored. */
  readonly ruleSchema: typeof ADVANCED_QUERY_RULE_SCHEMA;
  readonly name?: string;
  readonly all: readonly AdvancedQueryClause[];
  /** Restricts candidates to the current multi-selection. */
  readonly scope?: "whole-city" | "selected";
}

export interface SavedAdvancedQuery {
  readonly id: string;
  readonly query: AdvancedQuery;
  readonly savedAt: string;
  /** Optional result-set selection; IDs not present in a new model are ignored. */
  readonly selectedBuildingIds?: readonly string[];
}

export interface AdvancedQueryUnavailableFact {
  readonly field: "changedRecently" | "smell";
  readonly reason: string;
}

export interface AdvancedQueryMatch {
  readonly buildingId: string;
  readonly name: string;
  readonly path: string;
  readonly explanations: readonly string[];
}

export interface AdvancedQueryResult {
  readonly state: "empty" | "results" | "partial" | "large";
  readonly totalCount: number;
  readonly matches: readonly AdvancedQueryMatch[];
  readonly omittedCount: number;
  readonly unavailable: readonly AdvancedQueryUnavailableFact[];
}

export const ADVANCED_QUERY_PRESETS: Readonly<Record<"highest-complexity" | "dependency-hubs" | "incoming-neighborhood" | "outgoing-neighborhood" | "changed-recently" | "selected-district", AdvancedQuery>> = Object.freeze({
  "highest-complexity": query("Highest complexity", [{ field: "maximumComplexity", operator: "atLeast", value: 11 }]),
  "dependency-hubs": query("Dependency hubs", [{ field: "incomingDependencies", operator: "atLeast", value: 5 }]),
  "incoming-neighborhood": query("Incoming neighborhood", [{ field: "incomingDependencies", operator: "atLeast", value: 1 }]),
  "outgoing-neighborhood": query("Outgoing neighborhood", [{ field: "outgoingDependencies", operator: "atLeast", value: 1 }]),
  "changed-recently": query("Changed recently", [{ field: "changedRecently", operator: "equals", value: "true" }]),
  "selected-district": { ...query("Selected district", []), scope: "selected" },
});

export function evaluateAdvancedQuery(
  model: Pick<CityModel, "buildings" | "dependencies">,
  candidate: AdvancedQuery,
  selectedBuildingIds: ReadonlySet<string> = new Set(),
  requestedLimit: number = ADVANCED_QUERY_DEFAULT_LIMIT,
): AdvancedQueryResult {
  const query = validateAdvancedQuery(candidate);
  const limit = queryLimit(requestedLimit);
  const unavailable = unavailableFacts(query);
  const availableClauses = query.all.filter((clause) => !isUnavailable(clause.field));
  const degrees = dependencyDegrees(model);
  const selected = query.scope === "selected" ? selectedBuildingIds : undefined;
  const best: AdvancedQueryMatch[] = [];
  let totalCount = 0;

  for (const building of [...model.buildings].sort((left, right) => compare(left.id, right.id))) {
    if (selected && !selected.has(building.id)) continue;
    const explanations = explainMatch(building, availableClauses, degrees);
    if (!explanations) continue;
    totalCount += 1;
    if (best.length < limit) best.push(Object.freeze({ buildingId: building.id, name: building.name, path: building.path, explanations: Object.freeze(explanations) }));
  }

  const omittedCount = totalCount - best.length;
  const state = totalCount === 0 ? "empty" : unavailable.length > 0 ? "partial" : omittedCount > 0 ? "large" : "results";
  return Object.freeze({ state, totalCount, matches: Object.freeze(best), omittedCount, unavailable: Object.freeze(unavailable) });
}

/** Additive and shift-range selection, shared by city, tree, and results. */
export function selectQueryRange(
  current: ReadonlySet<string>,
  orderedIds: readonly string[],
  id: string,
  anchorId: string | null,
  additive: boolean,
  range: boolean,
): ReadonlySet<string> {
  const next = new Set(additive || range ? current : []);
  const index = orderedIds.indexOf(id);
  const anchor = anchorId === null ? -1 : orderedIds.indexOf(anchorId);
  if (range && index >= 0 && anchor >= 0) {
    for (const item of orderedIds.slice(Math.min(index, anchor), Math.max(index, anchor) + 1)) next.add(item);
  } else if (additive && next.has(id)) next.delete(id);
  else next.add(id);
  return new Set([...next].sort(compare));
}

export function validateAdvancedQuery(value: AdvancedQuery): AdvancedQuery {
  if (value?.version !== ADVANCED_QUERY_VERSION || value.ruleSchema !== ADVANCED_QUERY_RULE_SCHEMA || !Array.isArray(value.all)) throw new TypeError("Unsupported advanced query schema.");
  for (const clause of value.all) validateClause(clause);
  if (value.scope !== undefined && value.scope !== "whole-city" && value.scope !== "selected") throw new TypeError("Unsupported query scope.");
  return Object.freeze({ ...value, all: Object.freeze(value.all.map((clause) => Object.freeze({ ...clause }))) });
}

export function serializeSavedAdvancedQuery(saved: SavedAdvancedQuery): string {
  if (!saved.id.trim() || !Number.isFinite(Date.parse(saved.savedAt))) throw new TypeError("Saved query needs an id and ISO date.");
  const selectedBuildingIds = saved.selectedBuildingIds?.every((id) => typeof id === "string") ? [...new Set(saved.selectedBuildingIds)].sort(compare) : undefined;
  return JSON.stringify({ id: saved.id, savedAt: saved.savedAt, query: validateAdvancedQuery(saved.query), ...(selectedBuildingIds === undefined ? {} : { selectedBuildingIds }) });
}

export function parseSavedAdvancedQuery(serialized: string): SavedAdvancedQuery {
  const value: unknown = JSON.parse(serialized);
  if (!isRecord(value) || typeof value.id !== "string" || !Number.isFinite(Date.parse(String(value.savedAt))) || !isRecord(value.query) || (value.selectedBuildingIds !== undefined && (!Array.isArray(value.selectedBuildingIds) || !value.selectedBuildingIds.every((id) => typeof id === "string")))) throw new TypeError("Invalid saved advanced query.");
  return Object.freeze({ id: value.id, savedAt: value.savedAt as string, query: validateAdvancedQuery(value.query as unknown as AdvancedQuery), ...(value.selectedBuildingIds === undefined ? {} : { selectedBuildingIds: Object.freeze([...new Set(value.selectedBuildingIds as string[])].sort(compare)) }) });
}

function query(name: string, all: readonly AdvancedQueryClause[]): AdvancedQuery {
  return Object.freeze({ version: ADVANCED_QUERY_VERSION, ruleSchema: ADVANCED_QUERY_RULE_SCHEMA, name, all: Object.freeze(all) });
}
function validateClause(clause: AdvancedQueryClause): void {
  const validFields: readonly AdvancedQueryField[] = ["name", "path", "language", "risk", "sloc", "decisionLoad", "maximumComplexity", "incomingDependencies", "outgoingDependencies", "changedRecently", "smell"];
  const validOperators: readonly AdvancedQueryOperator[] = ["contains", "equals", "atLeast", "atMost"];
  if (!clause || !validFields.includes(clause.field) || !validOperators.includes(clause.operator) || (typeof clause.value !== "string" && typeof clause.value !== "number")) throw new TypeError("Invalid advanced query clause.");
  const numeric = ["sloc", "decisionLoad", "maximumComplexity", "incomingDependencies", "outgoingDependencies"].includes(clause.field);
  if (numeric !== (typeof clause.value === "number") || (numeric && !["atLeast", "atMost", "equals"].includes(clause.operator))) throw new TypeError(`Invalid operator for ${clause.field}.`);
}
function unavailableFacts(query: AdvancedQuery): AdvancedQueryUnavailableFact[] {
  const result: AdvancedQueryUnavailableFact[] = [];
  if (query.all.some(({ field }) => field === "changedRecently")) result.push({ field: "changedRecently", reason: "This model has no per-building change facts." });
  if (query.all.some(({ field }) => field === "smell")) result.push({ field: "smell", reason: "This model has no persisted smell findings." });
  return result;
}
function isUnavailable(field: AdvancedQueryField): boolean { return field === "changedRecently" || field === "smell"; }
function dependencyDegrees(model: Pick<CityModel, "dependencies">): ReadonlyMap<string, { incoming: number; outgoing: number }> {
  const degrees = new Map<string, { incoming: number; outgoing: number }>();
  const degree = (id: string) => degrees.get(id) ?? (degrees.set(id, { incoming: 0, outgoing: 0 }), degrees.get(id)!);
  for (const dependency of model.dependencies) { degree(dependency.sourceId).outgoing += 1; if (dependency.targetId) degree(dependency.targetId).incoming += 1; }
  return degrees;
}
function explainMatch(building: CityBuilding, clauses: readonly AdvancedQueryClause[], degrees: ReadonlyMap<string, { incoming: number; outgoing: number }>): string[] | null {
  const degree = degrees.get(building.id) ?? { incoming: 0, outgoing: 0 };
  const explanations: string[] = [];
  for (const clause of clauses) {
    const value: string | number = clause.field === "name" ? building.name : clause.field === "path" ? building.path : clause.field === "language" ? building.language : clause.field === "risk" ? building.risk : clause.field === "sloc" ? building.metrics.sloc : clause.field === "decisionLoad" ? building.metrics.decisionLoad : clause.field === "maximumComplexity" ? building.metrics.maximumComplexity : clause.field === "incomingDependencies" ? degree.incoming : degree.outgoing;
    const match = typeof value === "number" ? clause.operator === "atLeast" ? value >= Number(clause.value) : clause.operator === "atMost" ? value <= Number(clause.value) : value === Number(clause.value) : clause.operator === "contains" ? value.toLocaleLowerCase().includes(String(clause.value).toLocaleLowerCase()) : value.toLocaleLowerCase() === String(clause.value).toLocaleLowerCase();
    if (!match) return null;
    explanations.push(`${clause.field} ${clause.operator} ${String(clause.value)} (actual ${String(value)})`);
  }
  return explanations;
}
function queryLimit(value: number): number { return Number.isFinite(value) ? Math.max(1, Math.min(ADVANCED_QUERY_MAXIMUM_LIMIT, Math.floor(value))) : ADVANCED_QUERY_DEFAULT_LIMIT; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
