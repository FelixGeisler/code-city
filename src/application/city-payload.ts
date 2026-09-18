import {
  compareUnsignedUtf8,
  isCanonicalSourcePath,
  MAX_ADMITTED_MODULES,
  MAX_NORMALIZED_MODULE_BYTES,
  MAX_NORMALIZED_TOTAL_BYTES,
} from "../domain/source-admission";
import {
  PRESENTATION_KIND,
  type City,
  type InspectionFact,
  type PresentationModel,
} from "../domain/city-model";

export type { InspectionFact } from "../domain/city-model";
export type CityPayload = City;

declare const validatedGeometryBrand: unique symbol;
export type ValidatedGeometry = Readonly<PresentationModel & { readonly [validatedGeometryBrand]: true }>;
export type DistrictPlate = Readonly<{
  minimum: readonly [number, number, number];
  dimensions: readonly [number, number, number];
}>;
export type NumericPresentation = Readonly<{
  plates: readonly DistrictPlate[];
  sceneBounds: readonly [number, number, number, number, number, number];
  centre: readonly [number, number, number];
}>;
export type ValidatedCity = Readonly<{
  geometry: ValidatedGeometry;
  inspection: readonly InspectionFact[];
  presentation: NumericPresentation;
}>;

type DataRecord = Record<string, unknown>;
type IntrinsicGetter = (this: unknown) => unknown;

const CITY_KEYS = ["geometry", "inspection"] as const;
const GEOMETRY_KEYS = ["kind", "count", "origins", "sizes", "rgba", "bounds"] as const;
const FACT_KEYS = ["canonicalPath", "S", "U", "M"] as const;
const ARRAY_BUFFER_IS_VIEW = ArrayBuffer.isView;
const ARRAY_BUFFER_PROTOTYPE = ArrayBuffer.prototype;
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Float32Array.prototype) as object;
const TYPED_ARRAY_TAG = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, Symbol.toStringTag)!.get as IntrinsicGetter;
const TYPED_ARRAY_BUFFER = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "buffer")!.get as IntrinsicGetter;
const TYPED_ARRAY_BYTE_LENGTH = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "byteLength")!.get as IntrinsicGetter;
const TYPED_ARRAY_BYTE_OFFSET = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "byteOffset")!.get as IntrinsicGetter;
const TYPED_ARRAY_LENGTH = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "length")!.get as IntrinsicGetter;
const ARRAY_BUFFER_BYTE_LENGTH = Object.getOwnPropertyDescriptor(ARRAY_BUFFER_PROTOTYPE, "byteLength")!.get as IntrinsicGetter;
const MAX_FLOAT_INTEGER = 2 ** 24;
const MAX_TARGET_RELATIVE = 2 ** 23;
const MAX_EXECUTABLE_UNITS_PER_MODULE = 1 + Math.floor(MAX_NORMALIZED_MODULE_BYTES / 3);
const CONTROLLER_PALETTE = [
  { maximum: 0, rgba: [0x22, 0xc5, 0x5e, 0xff] },
  { maximum: 1, rgba: [0x84, 0xcc, 0x16, 0xff] },
  { maximum: 3, rgba: [0xfa, 0xcc, 0x15, 0xff] },
  { maximum: 7, rgba: [0xf5, 0x9e, 0x0b, 0xff] },
  { maximum: 15, rgba: [0xf9, 0x73, 0x16, 0xff] },
  { maximum: Number.MAX_SAFE_INTEGER, rgba: [0xef, 0x44, 0x44, 0xff] },
] as const;

function expectedPaletteForComplexity(complexity: number): readonly [number, number, number, number] {
  for (const band of CONTROLLER_PALETTE) {
    if (complexity <= band.maximum) return band.rgba;
  }
  invalid();
}

function invalid(): never {
  throw new Error("M1-CITY-1");
}

function ownEnumerableDataRecord(value: unknown, exactKeys: readonly string[]): DataRecord | undefined {
  try {
    if (typeof value !== "object" || value === null || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length !== exactKeys.length
      || keys.some((key) => typeof key !== "string")
      || exactKeys.some((key) => !Object.hasOwn(descriptors, key))) return undefined;
    const record: DataRecord = {};
    for (const key of exactKeys) {
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return undefined;
      record[key] = descriptor.value;
    }
    return record;
  } catch {
    return undefined;
  }
}

function nonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function checkedAdd(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right) || !Number.isSafeInteger(result)) invalid();
  return result;
}

function checkedMultiply(left: number, right: number): number {
  const result = left * right;
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right) || !Number.isSafeInteger(result)) invalid();
  return result;
}

function exactFloatInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value < MAX_FLOAT_INTEGER && Math.fround(value) === value;
}

function exactTargetRelative(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value) < MAX_TARGET_RELATIVE && Math.fround(value) === value;
}

const BUILDING_GAP = 2;
const GROUP_GAP = 8;
const GROUP_PADDING = 3;

type ExpectedBuilding = { index: number; side: number; x: number; z: number };
type ExpectedGroup = {
  root: boolean;
  identity: string;
  buildings: ExpectedBuilding[];
  width: number;
  depth: number;
};

function expectedHeight(sourceLines: number): number {
  return 4 + Math.floor(36 * Math.log1p(Math.min(sourceLines, 1000)) / Math.log(1001) + 0.5);
}

function expectedSide(executableUnits: number): number {
  const ratio = Math.log1p(Math.min(executableUnits, 100)) / Math.log(101);
  return 3 + Math.floor(15 * ratio ** 1.5 + 0.5);
}

function groupIdentity(canonicalPath: string): Readonly<{ root: boolean; identity: string }> {
  const segments = canonicalPath.split("/");
  segments.pop();
  return segments.length === 0
    ? { root: true, identity: "_root" }
    : { root: false, identity: segments.slice(0, 2).join("/") };
}

function compareGroupIdentity(left: ExpectedGroup, right: ExpectedGroup): number {
  const compared = compareUnsignedUtf8(left.identity, right.identity);
  return compared !== 0 ? compared : left.root === right.root ? 0 : left.root ? -1 : 1;
}

function reconstructExpected(inspection: readonly InspectionFact[]): Readonly<{
  origins: readonly number[];
  sizes: readonly number[];
  rgba: readonly number[];
  bounds: readonly number[];
  plates: readonly Readonly<{ minimumX: number; minimumZ: number; width: number; depth: number }>[];
  sceneBounds: readonly number[];
}> {
  const count = inspection.length;
  const sizes = new Array<number>(count * 3);
  const rgba = new Array<number>(count * 4);
  const sides = new Array<number>(count);
  let maximumY = 0;
  const groupsByKey = new Map<string, { root: boolean; identity: string; indices: number[] }>();
  for (let index = 0; index < count; index += 1) {
    const fact = inspection[index]!;
    const side = expectedSide(fact.U);
    const height = expectedHeight(fact.S);
    sides[index] = side;
    sizes[index * 3] = side;
    sizes[index * 3 + 1] = height;
    sizes[index * 3 + 2] = side;
    maximumY = Math.max(maximumY, height);
    const colour = expectedPaletteForComplexity(fact.M);
    for (let channel = 0; channel < 4; channel += 1) rgba[index * 4 + channel] = colour[channel]!;
    const group = groupIdentity(fact.canonicalPath);
    const key = `${group.root ? "root" : "directory"}:${group.identity}`;
    const entry = groupsByKey.get(key) ?? { ...group, indices: [] };
    entry.indices.push(index);
    groupsByKey.set(key, entry);
  }

  const groups: ExpectedGroup[] = [];
  for (const entry of groupsByKey.values()) {
    entry.indices.sort((left, right) => sides[right]! - sides[left]!
      || compareUnsignedUtf8(inspection[left]!.canonicalPath, inspection[right]!.canonicalPath));
    let area = 0;
    let maximumSide = 0;
    for (const index of entry.indices) {
      const span = checkedAdd(sides[index]!, BUILDING_GAP);
      area = checkedAdd(area, checkedMultiply(span, span));
      maximumSide = Math.max(maximumSide, sides[index]!);
    }
    const target = Math.max(maximumSide, Math.ceil(Math.sqrt(area)));
    let cursorX = 0;
    let cursorZ = 0;
    let rowDepth = 0;
    let occupiedWidth = 0;
    let occupiedDepth = 0;
    const buildings: ExpectedBuilding[] = [];
    for (const index of entry.indices) {
      const side = sides[index]!;
      if (cursorX !== 0 && checkedAdd(cursorX, side) > target) {
        cursorX = 0;
        cursorZ = checkedAdd(cursorZ, checkedAdd(rowDepth, BUILDING_GAP));
        rowDepth = 0;
      }
      buildings.push({ index, side, x: checkedAdd(cursorX, GROUP_PADDING), z: checkedAdd(cursorZ, GROUP_PADDING) });
      occupiedWidth = Math.max(occupiedWidth, checkedAdd(cursorX, side));
      occupiedDepth = Math.max(occupiedDepth, checkedAdd(cursorZ, side));
      cursorX = checkedAdd(cursorX, checkedAdd(side, BUILDING_GAP));
      rowDepth = Math.max(rowDepth, side);
    }
    groups.push({
      root: entry.root,
      identity: entry.identity,
      buildings,
      width: checkedAdd(occupiedWidth, GROUP_PADDING * 2),
      depth: checkedAdd(occupiedDepth, GROUP_PADDING * 2),
    });
  }

  groups.sort((left, right) => checkedMultiply(right.width, right.depth) - checkedMultiply(left.width, left.depth)
    || compareGroupIdentity(left, right));
  let outerArea = 0;
  let maximumCellWidth = 0;
  for (const group of groups) {
    outerArea = checkedAdd(outerArea, checkedMultiply(
      checkedAdd(group.width, GROUP_GAP),
      checkedAdd(group.depth, GROUP_GAP),
    ));
    maximumCellWidth = Math.max(maximumCellWidth, group.width);
  }
  const target = Math.max(maximumCellWidth, Math.ceil(Math.sqrt(outerArea)));
  const horizontal = new Array<number>(count * 2).fill(0);
  let cursorX = 0;
  let cursorZ = 0;
  let rowDepth = 0;
  let minimumX = Number.POSITIVE_INFINITY;
  let minimumZ = Number.POSITIVE_INFINITY;
  const packedCells: Array<{ minimumX: number; minimumZ: number; width: number; depth: number }> = [];
  for (const group of groups) {
    if (cursorX !== 0 && checkedAdd(cursorX, group.width) > target) {
      cursorX = 0;
      cursorZ = checkedAdd(cursorZ, checkedAdd(rowDepth, GROUP_GAP));
      rowDepth = 0;
    }
    packedCells.push({ minimumX: cursorX, minimumZ: cursorZ, width: group.width, depth: group.depth });
    for (const building of group.buildings) {
      const x = checkedAdd(cursorX, building.x);
      const z = checkedAdd(cursorZ, building.z);
      horizontal[building.index * 2] = x;
      horizontal[building.index * 2 + 1] = z;
      minimumX = Math.min(minimumX, x);
      minimumZ = Math.min(minimumZ, z);
    }
    cursorX = checkedAdd(cursorX, checkedAdd(group.width, GROUP_GAP));
    rowDepth = Math.max(rowDepth, group.depth);
  }

  const origins = new Array<number>(count * 3);
  let maximumX = 0;
  let maximumZ = 0;
  for (let index = 0; index < count; index += 1) {
    const x = horizontal[index * 2]! - minimumX;
    const z = horizontal[index * 2 + 1]! - minimumZ;
    origins[index * 3] = x;
    origins[index * 3 + 1] = 0;
    origins[index * 3 + 2] = z;
    maximumX = Math.max(maximumX, checkedAdd(x, sides[index]!));
    maximumZ = Math.max(maximumZ, checkedAdd(z, sides[index]!));
  }
  const plates = packedCells.map((cell) => ({
    minimumX: cell.minimumX - minimumX,
    minimumZ: cell.minimumZ - minimumZ,
    width: cell.width,
    depth: cell.depth,
  }));
  let sceneMinimumX = 0;
  let sceneMinimumZ = 0;
  let sceneMaximumX = maximumX;
  let sceneMaximumZ = maximumZ;
  for (const plate of plates) {
    sceneMinimumX = Math.min(sceneMinimumX, plate.minimumX);
    sceneMinimumZ = Math.min(sceneMinimumZ, plate.minimumZ);
    sceneMaximumX = Math.max(sceneMaximumX, checkedAdd(plate.minimumX, plate.width));
    sceneMaximumZ = Math.max(sceneMaximumZ, checkedAdd(plate.minimumZ, plate.depth));
  }
  return {
    origins,
    sizes,
    rgba,
    bounds: [0, 0, 0, maximumX, maximumY, maximumZ],
    plates,
    sceneBounds: [sceneMinimumX, -0.5, sceneMinimumZ, sceneMaximumX, maximumY, sceneMaximumZ],
  };
}

function exactTypedArray<T extends Float32Array | Uint8Array>(
  value: unknown,
  prototype: object,
  brand: "Float32Array" | "Uint8Array",
  length: number,
  bytesPerElement: number,
): value is T {
  if (typeof value !== "object" || value === null || !ARRAY_BUFFER_IS_VIEW(value)) return false;
  try {
    const byteLength = checkedMultiply(length, bytesPerElement);
    if (TYPED_ARRAY_TAG.call(value) !== brand
      || TYPED_ARRAY_LENGTH.call(value) !== length
      || TYPED_ARRAY_BYTE_OFFSET.call(value) !== 0
      || TYPED_ARRAY_BYTE_LENGTH.call(value) !== byteLength
      || Object.getPrototypeOf(value) !== prototype) return false;
    const buffer = TYPED_ARRAY_BUFFER.call(value);
    if (typeof buffer !== "object" || buffer === null
      || Object.getPrototypeOf(buffer) !== ARRAY_BUFFER_PROTOTYPE
      || ARRAY_BUFFER_BYTE_LENGTH.call(buffer) !== byteLength
      || Reflect.ownKeys(buffer).length !== 0) return false;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== length) return false;
    for (let index = 0; index < length; index += 1) if (keys[index] !== String(index)) return false;
    return true;
  } catch {
    return false;
  }
}

function sameNumber(actual: number, expected: number): boolean {
  return Object.is(actual, expected);
}

function snapshotInspection(value: unknown, count: number): readonly InspectionFact[] {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) invalid();
    const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<PropertyKey, PropertyDescriptor>;
    const lengthDescriptor = descriptors.length;
    if (!lengthDescriptor || !("value" in lengthDescriptor) || lengthDescriptor.value !== count
      || Reflect.ownKeys(descriptors).length !== count + 1) invalid();
    const inspection: InspectionFact[] = [];
    let priorPath: string | undefined;
    let totalSourceLines = 0;
    let totalExecutableUnits = 0;
    for (let index = 0; index < count; index += 1) {
      const element = descriptors[String(index)];
      if (!element || !("value" in element) || !element.enumerable) invalid();
      const record = ownEnumerableDataRecord(element.value, FACT_KEYS);
      if (!record || typeof record.canonicalPath !== "string" || !isCanonicalSourcePath(record.canonicalPath)
        || !nonnegativeSafeInteger(record.S) || record.S > MAX_NORMALIZED_MODULE_BYTES
        || !nonnegativeSafeInteger(record.U) || record.U > MAX_EXECUTABLE_UNITS_PER_MODULE
        || !nonnegativeSafeInteger(record.M)
        || (priorPath !== undefined && compareUnsignedUtf8(priorPath, record.canonicalPath) >= 0)) invalid();
      totalSourceLines = checkedAdd(totalSourceLines, record.S);
      totalExecutableUnits = checkedAdd(totalExecutableUnits, record.U);
      if (totalSourceLines > MAX_NORMALIZED_TOTAL_BYTES
        || totalExecutableUnits > checkedAdd(count, Math.floor(MAX_NORMALIZED_TOTAL_BYTES / 3))) invalid();
      const snapshot = Object.freeze({
        canonicalPath: record.canonicalPath,
        S: record.S,
        U: record.U,
        M: record.M,
      });
      inspection.push(snapshot);
      priorPath = snapshot.canonicalPath;
    }
    return Object.freeze(inspection);
  } catch (error) {
    if (error instanceof Error && error.message === "M1-CITY-1") throw error;
    invalid();
  }
}

function snapshotGeometry(value: unknown): ValidatedGeometry {
  const record = ownEnumerableDataRecord(value, GEOMETRY_KEYS);
  if (!record || record.kind !== PRESENTATION_KIND || !nonnegativeSafeInteger(record.count)
    || record.count < 1 || record.count > MAX_ADMITTED_MODULES) invalid();
  const count = record.count;
  const vectorLength = checkedMultiply(count, 3);
  const colourLength = checkedMultiply(count, 4);
  if (!exactTypedArray<Float32Array>(record.origins, Float32Array.prototype, "Float32Array", vectorLength, 4)
    || !exactTypedArray<Float32Array>(record.sizes, Float32Array.prototype, "Float32Array", vectorLength, 4)
    || !exactTypedArray<Uint8Array>(record.rgba, Uint8Array.prototype, "Uint8Array", colourLength, 1)
    || !exactTypedArray<Float32Array>(record.bounds, Float32Array.prototype, "Float32Array", 6, 4)) invalid();

  const origins = new Float32Array(record.origins);
  const sizes = new Float32Array(record.sizes);
  const rgba = new Uint8Array(record.rgba);
  const bounds = new Float32Array(record.bounds);
  for (let index = 0; index < count; index += 1) {
    const offset = index * 3;
    const width = sizes[offset]!;
    const height = sizes[offset + 1]!;
    const depth = sizes[offset + 2]!;
    const x = origins[offset]!;
    const y = origins[offset + 1]!;
    const z = origins[offset + 2]!;
    if (![width, height, depth, x, y, z].every(exactFloatInteger)
      || width < 3 || width > 18 || height < 4 || height > 40 || depth !== width || y !== 0) invalid();
    const colourOffset = index * 4;
    let paletteMatch = false;
    for (const { rgba: colour } of CONTROLLER_PALETTE) {
      if (rgba[colourOffset] === colour[0] && rgba[colourOffset + 1] === colour[1]
        && rgba[colourOffset + 2] === colour[2] && rgba[colourOffset + 3] === colour[3]) {
        paletteMatch = true;
        break;
      }
    }
    if (!paletteMatch) invalid();
  }
  if (![...bounds].every(exactFloatInteger) || bounds[3]! <= 0 || bounds[4]! <= 0 || bounds[5]! <= 0) invalid();
  return Object.freeze({ kind: PRESENTATION_KIND, count, origins, sizes, rgba, bounds }) as ValidatedGeometry;
}

export function validateCityPayload(value: unknown): ValidatedCity {
  try {
    const city = ownEnumerableDataRecord(value, CITY_KEYS);
    if (!city) invalid();
    const geometry = snapshotGeometry(city.geometry);
    const inspection = snapshotInspection(city.inspection, geometry.count);
    const expected = reconstructExpected(inspection);
    for (let index = 0; index < geometry.origins.length; index += 1) {
      if (!sameNumber(geometry.origins[index]!, expected.origins[index]!)) invalid();
    }
    for (let index = 0; index < geometry.sizes.length; index += 1) {
      if (!sameNumber(geometry.sizes[index]!, expected.sizes[index]!)) invalid();
    }
    for (let index = 0; index < geometry.rgba.length; index += 1) {
      if (geometry.rgba[index] !== expected.rgba[index]) invalid();
    }
    for (let index = 0; index < geometry.bounds.length; index += 1) {
      if (!sameNumber(geometry.bounds[index]!, expected.bounds[index]!)) invalid();
    }
    const sceneBounds = Object.freeze([...expected.sceneBounds]) as NumericPresentation["sceneBounds"];
    const centre = Object.freeze([
      sceneBounds[0] + (sceneBounds[3] - sceneBounds[0]) / 2,
      sceneBounds[1] + (sceneBounds[4] - sceneBounds[1]) / 2,
      sceneBounds[2] + (sceneBounds[5] - sceneBounds[2]) / 2,
    ]) as NumericPresentation["centre"];
    const plates = Object.freeze(expected.plates.map((plate) => Object.freeze({
      minimum: Object.freeze([plate.minimumX, -0.5, plate.minimumZ]) as DistrictPlate["minimum"],
      dimensions: Object.freeze([plate.width, 0.5, plate.depth]) as DistrictPlate["dimensions"],
    })));
    const exactRelativeBox = (minimum: ArrayLike<number>, dimensions: ArrayLike<number>): void => {
      for (let axis = 0; axis < 3; axis += 1) {
        const endpoint = minimum[axis]! + dimensions[axis]!;
        if (!exactTargetRelative(minimum[axis]! - centre[axis]) || !exactTargetRelative(endpoint - centre[axis])) invalid();
      }
    };
    for (let index = 0; index < geometry.count; index += 1) {
      const offset = index * 3;
      exactRelativeBox(geometry.origins.subarray(offset, offset + 3), geometry.sizes.subarray(offset, offset + 3));
    }
    for (const plate of plates) exactRelativeBox(plate.minimum, plate.dimensions);
    const presentation = Object.freeze({ plates, sceneBounds, centre });
    return Object.freeze({ geometry, inspection, presentation });
  } catch (error) {
    if (error instanceof Error && error.message === "M1-CITY-1") throw error;
    invalid();
  }
}
