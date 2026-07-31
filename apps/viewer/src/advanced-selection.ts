import type { CityModel } from "../../../packages/core/src/model.js";

export const ADVANCED_SELECTION_SET_VERSION =
  "codecity.selection-set/1";
export const MAXIMUM_ADVANCED_SELECTION_SIZE = 500;
export const MAXIMUM_ADVANCED_SELECTION_ORDER_SIZE = 25_000;

export interface AdvancedSelectionState {
  readonly buildingIds: readonly string[];
  readonly primaryBuildingId: string | null;
  readonly anchorBuildingId: string | null;
  readonly overlayVisible: boolean;
}

export interface AdvancedSelectionIntent {
  readonly additive?: boolean;
  readonly range?: boolean;
  readonly orderedBuildingIds?: readonly string[];
}

export interface AdvancedSelectionSet {
  readonly version: typeof ADVANCED_SELECTION_SET_VERSION;
  readonly name: string;
  readonly modelSchemaVersion: "1.0";
  readonly buildingIds: readonly string[];
}

export const EMPTY_ADVANCED_SELECTION: AdvancedSelectionState =
  Object.freeze({
    buildingIds: Object.freeze([]),
    primaryBuildingId: null,
    anchorBuildingId: null,
    overlayVisible: true,
  });

export function selectAdvancedBuilding(
  state: AdvancedSelectionState,
  buildingId: string,
  intent: AdvancedSelectionIntent = {},
): AdvancedSelectionState {
  const id = requiredId(buildingId, "Building ID");
  if (intent.range) {
    const ordered = validateOrderedIds(intent.orderedBuildingIds);
    const anchor =
      state.anchorBuildingId !== null &&
      ordered.includes(state.anchorBuildingId)
        ? state.anchorBuildingId
        : id;
    const anchorIndex = ordered.indexOf(anchor);
    const targetIndex = ordered.indexOf(id);
    if (targetIndex < 0) return state;
    const start = Math.min(anchorIndex, targetIndex);
    const end = Math.max(anchorIndex, targetIndex);
    const range = ordered.slice(start, end + 1);
    const selected = intent.additive
      ? canonicalIds([...state.buildingIds, ...range])
      : canonicalIds(range);
    return nextSelection(state, selected, id, anchor);
  }
  if (intent.additive) {
    const selected = new Set(state.buildingIds);
    if (selected.has(id)) {
      selected.delete(id);
    } else {
      selected.add(id);
    }
    const buildingIds = canonicalIds([...selected]);
    return nextSelection(
      state,
      buildingIds,
      selected.has(id)
        ? id
        : state.primaryBuildingId === id
          ? buildingIds.at(-1) ?? null
          : state.primaryBuildingId,
      id,
    );
  }
  return nextSelection(state, [id], id, id);
}

export function replaceAdvancedSelection(
  state: AdvancedSelectionState,
  buildingIds: readonly string[],
  primaryBuildingId?: string,
): AdvancedSelectionState {
  const ids = canonicalIds(buildingIds);
  const requestedPrimary =
    primaryBuildingId === undefined
      ? ids[0] ?? null
      : requiredId(primaryBuildingId, "Primary building ID");
  const primary =
    requestedPrimary !== null && ids.includes(requestedPrimary)
      ? requestedPrimary
      : ids[0] ?? null;
  return nextSelection(state, ids, primary, primary);
}

export function clearAdvancedSelection(
  state: AdvancedSelectionState,
): AdvancedSelectionState {
  if (
    state.buildingIds.length === 0 &&
    state.primaryBuildingId === null &&
    state.anchorBuildingId === null
  ) {
    return state;
  }
  return Object.freeze({
    buildingIds: Object.freeze([]),
    primaryBuildingId: null,
    anchorBuildingId: null,
    overlayVisible: state.overlayVisible,
  });
}

export function setAdvancedSelectionOverlay(
  state: AdvancedSelectionState,
  visible: boolean,
): AdvancedSelectionState {
  if (state.overlayVisible === visible) return state;
  return Object.freeze({ ...state, overlayVisible: visible });
}

export function retainAdvancedSelection(
  state: AdvancedSelectionState,
  model: Pick<CityModel, "buildings">,
): AdvancedSelectionState {
  const valid = new Set(model.buildings.map(({ id }) => id));
  const ids = state.buildingIds.filter((id) => valid.has(id));
  const primary =
    state.primaryBuildingId !== null && valid.has(state.primaryBuildingId)
      ? state.primaryBuildingId
      : ids[0] ?? null;
  const anchor =
    state.anchorBuildingId !== null && valid.has(state.anchorBuildingId)
      ? state.anchorBuildingId
      : primary;
  return nextSelection(state, ids, primary, anchor);
}

export function createAdvancedSelectionSet(
  name: string,
  buildingIds: readonly string[],
): AdvancedSelectionSet {
  return Object.freeze({
    version: ADVANCED_SELECTION_SET_VERSION,
    name: normalizedName(name),
    modelSchemaVersion: "1.0",
    buildingIds: Object.freeze(canonicalIds(buildingIds)),
  });
}

export function validateAdvancedSelectionSet(
  value: unknown,
): AdvancedSelectionSet {
  if (!isRecord(value)) {
    throw new TypeError("The selection set must be an object.");
  }
  const actual = Object.keys(value).sort();
  const expected = [
    "buildingIds",
    "modelSchemaVersion",
    "name",
    "version",
  ];
  if (
    actual.length !== expected.length ||
    !actual.every((key, index) => key === expected[index])
  ) {
    throw new TypeError("The selection set fields are invalid.");
  }
  if (value["version"] !== ADVANCED_SELECTION_SET_VERSION) {
    throw new TypeError(
      `The selection set version must be "${ADVANCED_SELECTION_SET_VERSION}".`,
    );
  }
  if (value["modelSchemaVersion"] !== "1.0") {
    throw new TypeError('The selection set model schema must be "1.0".');
  }
  if (!Array.isArray(value["buildingIds"])) {
    throw new TypeError("Selection-set building IDs must be an array.");
  }
  return createAdvancedSelectionSet(
    typeof value["name"] === "string" ? value["name"] : "",
    value["buildingIds"].map((id) => requiredId(id, "Building ID")),
  );
}

function nextSelection(
  state: AdvancedSelectionState,
  buildingIds: readonly string[],
  primaryBuildingId: string | null,
  anchorBuildingId: string | null,
): AdvancedSelectionState {
  const ids = canonicalIds(buildingIds);
  const primary =
    primaryBuildingId !== null && ids.includes(primaryBuildingId)
      ? primaryBuildingId
      : ids[0] ?? null;
  const anchor =
    anchorBuildingId !== null && ids.includes(anchorBuildingId)
      ? anchorBuildingId
      : primary;
  if (
    sameIds(state.buildingIds, ids) &&
    state.primaryBuildingId === primary &&
    state.anchorBuildingId === anchor
  ) {
    return state;
  }
  return Object.freeze({
    buildingIds: Object.freeze(ids),
    primaryBuildingId: primary,
    anchorBuildingId: anchor,
    overlayVisible: state.overlayVisible,
  });
}

function canonicalIds(buildingIds: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of buildingIds) {
    const id = requiredId(value, "Building ID");
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(id);
    if (result.length > MAXIMUM_ADVANCED_SELECTION_SIZE) {
      throw new RangeError(
        `A selection can contain at most ${MAXIMUM_ADVANCED_SELECTION_SIZE} buildings.`,
      );
    }
  }
  return result;
}

function validateOrderedIds(
  value: readonly string[] | undefined,
): readonly string[] {
  if (value === undefined || value.length === 0) {
    throw new TypeError(
      "Range selection requires a non-empty ordered building list.",
    );
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const candidate of value) {
    const id = requiredId(candidate, "Building ID");
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(id);
    if (result.length > MAXIMUM_ADVANCED_SELECTION_ORDER_SIZE) {
      throw new RangeError(
        "A range-selection order can contain at most " +
          `${MAXIMUM_ADVANCED_SELECTION_ORDER_SIZE} buildings.`,
      );
    }
  }
  return result;
}

function normalizedName(name: string): string {
  const normalized = name.trim().replace(/\s+/gu, " ");
  if (
    normalized.length === 0 ||
    normalized.length > 64 ||
    /[\p{Cc}\p{Cf}\p{Cs}]/u.test(normalized)
  ) {
    throw new RangeError(
      "Selection-set names must contain 1-64 visible characters.",
    );
  }
  return normalized;
}

function requiredId(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > 256
  ) {
    throw new TypeError(
      `${label} must contain 1-256 visible characters.`,
    );
  }
  return value.trim();
}

function sameIds(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((id, index) => id === right[index])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}
