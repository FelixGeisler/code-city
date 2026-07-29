import type {
  CityBuilding,
  CityDistrict,
} from "./model.js";
import { normalizeRepositoryRelativePath } from "./path.js";

export type PrintLabelPolicy = "auto" | "off";

export const PRINT_CODE_LENGTH = 3;
export const PRINT_CODE_CAPACITY = 36 ** PRINT_CODE_LENGTH;

export interface AssignedPrintCode {
  readonly id: string;
  readonly code: string;
}

export type PhysicalPrintSkipReason =
  | "policy-off"
  | "roof-too-small"
  | "build-volume-height"
  | "ground-space-unavailable";

export type PhysicalPrintStatus =
  | {
      readonly status: "printed";
      readonly text: string;
      readonly mode: "code" | "name";
    }
  | {
      readonly status: "skipped";
      readonly reason: PhysicalPrintSkipReason;
    };

export interface PrintLegendBuilding {
  readonly code: string;
  readonly repositoryId: string;
  readonly repositoryName: string;
  readonly districtId: string;
  readonly districtName: string;
  readonly buildingId: string;
  readonly buildingName: string;
  readonly path: string;
  readonly physicalPrint: PhysicalPrintStatus;
}

export interface PrintLegendDistrict {
  readonly code: string;
  readonly repositoryId: string;
  readonly repositoryName: string;
  readonly districtId: string;
  readonly districtName: string;
  readonly path: string;
  readonly physicalPrint: PhysicalPrintStatus;
}

export interface PrintLegend {
  readonly schemaVersion: "1.0";
  readonly title: string;
  readonly profileId: string;
  readonly labelPolicy: PrintLabelPolicy;
  readonly districts: readonly PrintLegendDistrict[];
  readonly buildings: readonly PrintLegendBuilding[];
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function codeForIndex(index: number): string {
  if (
    !Number.isSafeInteger(index) ||
    index < 0 ||
    index >= PRINT_CODE_CAPACITY
  ) {
    throw new RangeError(
      `Print codes support at most ${PRINT_CODE_CAPACITY} entries.`,
    );
  }
  return index
    .toString(36)
    .toUpperCase()
    .padStart(PRINT_CODE_LENGTH, "0");
}

function assertUniqueIds(
  items: readonly { readonly id: string }[],
  description: string,
): void {
  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.id)) {
      throw new TypeError(`Duplicate ${description} id '${item.id}'.`);
    }
    ids.add(item.id);
  }
}

/**
 * Assigns stable three-character base-36 building codes. Input order does not
 * affect the result.
 */
export function assignBuildingPrintCodes(
  buildings: readonly CityBuilding[],
): readonly AssignedPrintCode[] {
  if (buildings.length > PRINT_CODE_CAPACITY) {
    throw new RangeError(
      `Building print codes support at most ${PRINT_CODE_CAPACITY} buildings.`,
    );
  }
  assertUniqueIds(buildings, "building");
  return [...buildings]
    .sort(
      (left, right) =>
        compare(left.repositoryId, right.repositoryId) ||
        compare(left.districtId, right.districtId) ||
        compare(
          normalizeRepositoryRelativePath(left.path),
          normalizeRepositoryRelativePath(right.path),
        ) ||
        compare(left.id, right.id),
    )
    .map(({ id }, index) => ({ id, code: codeForIndex(index) }));
}

/**
 * District codes use their own stable namespace and retain the documented
 * leading D marker.
 */
export function assignDistrictPrintCodes(
  districts: readonly CityDistrict[],
): readonly AssignedPrintCode[] {
  if (districts.length > PRINT_CODE_CAPACITY) {
    throw new RangeError(
      `District print codes support at most ${PRINT_CODE_CAPACITY} districts.`,
    );
  }
  assertUniqueIds(districts, "district");
  return [...districts]
    .sort(
      (left, right) =>
        compare(left.repositoryId, right.repositoryId) ||
        compare(
          normalizeRepositoryRelativePath(left.path),
          normalizeRepositoryRelativePath(right.path),
        ) ||
        compare(left.id, right.id),
    )
    .map(({ id }, index) => ({ id, code: `D${codeForIndex(index)}` }));
}

export function parsePrintLabelPolicy(
  value: string | undefined,
): PrintLabelPolicy {
  if (value === undefined || value === "auto") return "auto";
  if (value === "off") return "off";
  throw new TypeError("Label policy must be either 'auto' or 'off'.");
}

/** Serializes fixed-order legend data identically in Node and browsers. */
export function serializePrintLegend(legend: PrintLegend): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(legend, null, 2)}\n`);
}
