import type { CityModel } from "../../../packages/core/src/model.js";
import {
  validateAdvancedQueryDefinition,
  type AdvancedQueryDefinition,
} from "./advanced-query.js";
import {
  validateAdvancedSelectionSet,
  type AdvancedSelectionSet,
} from "./advanced-selection.js";
import { metricMappingProjectIdentity } from "./metric-mapping-storage.js";

export const ADVANCED_QUERY_STORAGE_PREFIX =
  "code-city-advanced-queries-v1:";
export const MAXIMUM_SAVED_ADVANCED_QUERIES = 16;
export const MAXIMUM_SAVED_SELECTION_SETS = 16;
export const MAXIMUM_ADVANCED_QUERY_STORAGE_BYTES = 256 * 1024;

export interface AdvancedQueryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

export interface SavedAdvancedQuery {
  readonly name: string;
  readonly definition: AdvancedQueryDefinition;
}

export interface AdvancedQueryStorageSnapshot {
  readonly queries: readonly SavedAdvancedQuery[];
  readonly selectionSets: readonly AdvancedSelectionSet[];
}

export interface AdvancedQueryStorageResult {
  readonly ok: boolean;
  readonly message: string;
}

interface AdvancedQueryStorageDocument {
  readonly version: 1;
  readonly projectIdentity: string;
  readonly queries: readonly SavedAdvancedQuery[];
  readonly selectionSets: readonly AdvancedSelectionSet[];
}

export function advancedQueryStorageKey(model: CityModel): string {
  return `${ADVANCED_QUERY_STORAGE_PREFIX}${metricMappingProjectIdentity(model)}`;
}

export class AdvancedQueryStore {
  public constructor(private readonly storage: AdvancedQueryStorage) {}

  public load(model: CityModel): AdvancedQueryStorageSnapshot {
    const document = this.read(model);
    return Object.freeze({
      queries: Object.freeze(
        (document?.queries ?? []).map((entry) =>
          Object.freeze(structuredClone(entry)),
        ),
      ),
      selectionSets: Object.freeze(
        (document?.selectionSets ?? []).map((entry) =>
          Object.freeze(structuredClone(entry)),
        ),
      ),
    });
  }

  public saveQuery(
    model: CityModel,
    name: string,
    definition: AdvancedQueryDefinition,
  ): AdvancedQueryStorageResult {
    let entry: SavedAdvancedQuery;
    try {
      entry = {
        name: normalizedName(name),
        definition: validateAdvancedQueryDefinition(definition),
      };
    } catch (error) {
      return invalidResult(error, "The query is invalid.");
    }
    const document = this.read(model) ?? emptyDocument(model);
    const queries = upsertNamed(
      document.queries,
      entry,
      MAXIMUM_SAVED_ADVANCED_QUERIES,
      "queries",
    );
    if ("ok" in queries) return queries;
    return this.write(model, { ...document, queries });
  }

  public saveSelectionSet(
    model: CityModel,
    selectionSet: AdvancedSelectionSet,
  ): AdvancedQueryStorageResult {
    let entry: AdvancedSelectionSet;
    try {
      entry = validateAdvancedSelectionSet(selectionSet);
    } catch (error) {
      return invalidResult(error, "The selection set is invalid.");
    }
    const document = this.read(model) ?? emptyDocument(model);
    const selectionSets = upsertNamed(
      document.selectionSets,
      entry,
      MAXIMUM_SAVED_SELECTION_SETS,
      "selection sets",
    );
    if ("ok" in selectionSets) return selectionSets;
    return this.write(model, { ...document, selectionSets });
  }

  public delete(
    model: CityModel,
    kind: "query" | "selection-set",
    name: string,
  ): AdvancedQueryStorageResult {
    let normalized: string;
    try {
      normalized = normalizedName(name);
    } catch (error) {
      return invalidResult(error, "The saved item name is invalid.");
    }
    const document = this.read(model);
    if (document === undefined) {
      return { ok: true, message: "No saved item was changed." };
    }
    const field = kind === "query" ? "queries" : "selectionSets";
    const filtered = document[field].filter(
      (entry) => foldedName(entry.name) !== foldedName(normalized),
    );
    if (filtered.length === document[field].length) {
      return { ok: true, message: "No saved item was changed." };
    }
    const next = { ...document, [field]: filtered };
    if (next.queries.length === 0 && next.selectionSets.length === 0) {
      try {
        this.storage.removeItem?.(advancedQueryStorageKey(model));
        return { ok: true, message: `Deleted “${normalized}”.` };
      } catch {
        return {
          ok: false,
          message: "Browser storage is unavailable; the item was not deleted.",
        };
      }
    }
    const result = this.write(model, next);
    return result.ok
      ? { ok: true, message: `Deleted “${normalized}”.` }
      : result;
  }

  private read(model: CityModel): AdvancedQueryStorageDocument | undefined {
    let value: string | null;
    try {
      value = this.storage.getItem(advancedQueryStorageKey(model));
    } catch {
      return undefined;
    }
    if (value === null) return emptyDocument(model);
    if (
      new TextEncoder().encode(value).byteLength >
      MAXIMUM_ADVANCED_QUERY_STORAGE_BYTES
    ) {
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      return undefined;
    }
    return parseDocument(parsed, metricMappingProjectIdentity(model));
  }

  private write(
    model: CityModel,
    document: AdvancedQueryStorageDocument,
  ): AdvancedQueryStorageResult {
    const value = JSON.stringify(document);
    if (
      new TextEncoder().encode(value).byteLength >
      MAXIMUM_ADVANCED_QUERY_STORAGE_BYTES
    ) {
      return {
        ok: false,
        message: "Saved queries and selections exceed the storage limit.",
      };
    }
    try {
      this.storage.setItem(advancedQueryStorageKey(model), value);
      return { ok: true, message: "Saved for this project." };
    } catch {
      return {
        ok: false,
        message:
          "Browser storage is unavailable or full; nothing was saved.",
      };
    }
  }
}

function parseDocument(
  value: unknown,
  projectIdentity: string,
): AdvancedQueryStorageDocument | undefined {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "version",
      "projectIdentity",
      "queries",
      "selectionSets",
    ]) ||
    value["version"] !== 1 ||
    value["projectIdentity"] !== projectIdentity ||
    !Array.isArray(value["queries"]) ||
    !Array.isArray(value["selectionSets"]) ||
    value["queries"].length > MAXIMUM_SAVED_ADVANCED_QUERIES ||
    value["selectionSets"].length > MAXIMUM_SAVED_SELECTION_SETS
  ) {
    return undefined;
  }
  const queries: SavedAdvancedQuery[] = [];
  const selectionSets: AdvancedSelectionSet[] = [];
  try {
    for (const candidate of value["queries"]) {
      if (
        !isRecord(candidate) ||
        !hasExactKeys(candidate, ["name", "definition"])
      ) {
        return undefined;
      }
      queries.push({
        name: normalizedName(candidate["name"]),
        definition: validateAdvancedQueryDefinition(candidate["definition"]),
      });
    }
    for (const candidate of value["selectionSets"]) {
      selectionSets.push(validateAdvancedSelectionSet(candidate));
    }
  } catch {
    return undefined;
  }
  if (
    hasDuplicateNames(queries) ||
    hasDuplicateNames(selectionSets)
  ) {
    return undefined;
  }
  queries.sort(compareNames);
  selectionSets.sort(compareNames);
  return {
    version: 1,
    projectIdentity,
    queries,
    selectionSets,
  };
}

function emptyDocument(model: CityModel): AdvancedQueryStorageDocument {
  return {
    version: 1,
    projectIdentity: metricMappingProjectIdentity(model),
    queries: [],
    selectionSets: [],
  };
}

function upsertNamed<T extends { readonly name: string }>(
  source: readonly T[],
  entry: T,
  maximum: number,
  label: string,
): readonly T[] | AdvancedQueryStorageResult {
  const index = source.findIndex(
    (candidate) => foldedName(candidate.name) === foldedName(entry.name),
  );
  if (index < 0 && source.length >= maximum) {
    return {
      ok: false,
      message: `A project can store at most ${maximum} ${label}.`,
    };
  }
  const next = source.map((candidate) => structuredClone(candidate));
  if (index < 0) next.push(structuredClone(entry));
  else next[index] = structuredClone(entry);
  next.sort(compareNames);
  return next;
}

function normalizedName(value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError("Saved item names must be strings.");
  }
  const normalized = value.trim().replace(/\s+/gu, " ");
  if (
    normalized.length === 0 ||
    normalized.length > 64 ||
    /[\p{Cc}\p{Cf}\p{Cs}]/u.test(normalized)
  ) {
    throw new RangeError(
      "Saved item names must contain 1-64 visible characters.",
    );
  }
  return normalized;
}

function compareNames(
  left: { readonly name: string },
  right: { readonly name: string },
): number {
  const folded = compareText(foldedName(left.name), foldedName(right.name));
  return folded || compareText(left.name, right.name);
}

function foldedName(value: string): string {
  return value.toLocaleLowerCase("en-US");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function hasDuplicateNames(
  entries: readonly { readonly name: string }[],
): boolean {
  return new Set(entries.map((entry) => foldedName(entry.name))).size !==
    entries.length;
}

function invalidResult(
  error: unknown,
  fallback: string,
): AdvancedQueryStorageResult {
  return {
    ok: false,
    message: error instanceof Error ? error.message : fallback,
  };
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}
