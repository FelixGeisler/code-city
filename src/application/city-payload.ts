import {
  compareUnsignedUtf8,
  isCanonicalSourcePath,
  MAX_ADMITTED_MODULES,
  MAX_NORMALIZED_MODULE_BYTES,
  MAX_NORMALIZED_TOTAL_BYTES,
} from "../domain/source-admission";
import {
  paletteForComplexity,
  PRESENTATION_KIND,
  type City,
  type InspectionFact,
  type PresentationModel,
} from "../domain/city-model";

export type { InspectionFact } from "../domain/city-model";
export type CityPayload = City;

declare const validatedGeometryBrand: unique symbol;
export type ValidatedGeometry = Readonly<PresentationModel & { readonly [validatedGeometryBrand]: true }>;
export type ValidatedCity = Readonly<{
  geometry: ValidatedGeometry;
  inspection: readonly InspectionFact[];
  centre: readonly [number, number, number];
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
const PALETTE_PROBES = [0, 1, 2, 4, 8, 16] as const;

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
  const columnCount = Math.ceil(Math.sqrt(count));
  if (!Number.isSafeInteger(columnCount) || columnCount < 1 || columnCount * columnCount < count) invalid();
  const rowCount = Math.ceil(count / columnCount);
  const rowDepths = new Array<number>(rowCount).fill(0);
  for (let index = 0; index < count; index += 1) {
    const offset = index * 3;
    const width = sizes[offset]!;
    const height = sizes[offset + 1]!;
    const depth = sizes[offset + 2]!;
    if (!exactFloatInteger(width) || !exactFloatInteger(height) || !exactFloatInteger(depth)
      || width <= 0 || height <= 0 || depth <= 0 || width !== depth) invalid();
    const row = Math.floor(index / columnCount);
    rowDepths[row] = Math.max(rowDepths[row]!, depth);
    const colourOffset = index * 4;
    let paletteMatch = false;
    for (const probe of PALETTE_PROBES) {
      const colour = paletteForComplexity(probe);
      if (rgba[colourOffset] === colour[0] && rgba[colourOffset + 1] === colour[1]
        && rgba[colourOffset + 2] === colour[2] && rgba[colourOffset + 3] === colour[3]) {
        paletteMatch = true;
        break;
      }
    }
    if (!paletteMatch) invalid();
  }

  let expectedZ = 0;
  let maximumX = 0;
  let maximumY = 0;
  let maximumZ = 0;
  for (let row = 0; row < rowCount; row += 1) {
    let expectedX = 0;
    const first = row * columnCount;
    const end = Math.min(first + columnCount, count);
    for (let index = first; index < end; index += 1) {
      const offset = index * 3;
      const width = sizes[offset]!;
      const height = sizes[offset + 1]!;
      const x = origins[offset]!;
      const y = origins[offset + 1]!;
      const z = origins[offset + 2]!;
      if (!exactFloatInteger(x) || !exactFloatInteger(y) || !exactFloatInteger(z)
        || !sameNumber(x, expectedX) || !sameNumber(y, 0) || !sameNumber(z, expectedZ)) invalid();
      const endpointX = checkedAdd(x, width);
      const endpointY = checkedAdd(y, height);
      const endpointZ = checkedAdd(z, width);
      if (![endpointX, endpointY, endpointZ].every(exactFloatInteger)) invalid();
      maximumX = Math.max(maximumX, endpointX);
      maximumY = Math.max(maximumY, endpointY);
      maximumZ = Math.max(maximumZ, endpointZ);
      if (index + 1 < end) expectedX = checkedAdd(endpointX, 1);
    }
    if (row + 1 < rowCount) expectedZ = checkedAdd(checkedAdd(expectedZ, rowDepths[row]!), 1);
  }
  const expectedBounds = [0, 0, 0, maximumX, maximumY, maximumZ] as const;
  for (let index = 0; index < 6; index += 1) {
    if (!exactFloatInteger(bounds[index]!) || !sameNumber(bounds[index]!, expectedBounds[index])) invalid();
  }
  if (maximumX <= 0 || maximumY <= 0 || maximumZ <= 0) invalid();
  const centre = [maximumX / 2, maximumY / 2, maximumZ / 2] as const;
  for (let index = 0; index < count; index += 1) {
    const offset = index * 3;
    for (let axis = 0; axis < 3; axis += 1) {
      const origin = origins[offset + axis]!;
      const endpoint = checkedAdd(origin, sizes[offset + axis]!);
      if (!exactTargetRelative(origin - centre[axis]) || !exactTargetRelative(endpoint - centre[axis])) invalid();
    }
  }
  return Object.freeze({ kind: PRESENTATION_KIND, count, origins, sizes, rgba, bounds }) as ValidatedGeometry;
}

export function validateCityPayload(value: unknown): ValidatedCity {
  try {
    const city = ownEnumerableDataRecord(value, CITY_KEYS);
    if (!city) invalid();
    const geometry = snapshotGeometry(city.geometry);
    const inspection = snapshotInspection(city.inspection, geometry.count);
    for (let index = 0; index < geometry.count; index += 1) {
      const fact = inspection[index]!;
      const vectorOffset = index * 3;
      const colourOffset = index * 4;
      if (geometry.sizes[vectorOffset] !== fact.U + 1
        || geometry.sizes[vectorOffset + 1] !== fact.S + 1
        || geometry.sizes[vectorOffset + 2] !== fact.U + 1) invalid();
      const colour = paletteForComplexity(fact.M);
      for (let channel = 0; channel < 4; channel += 1) {
        if (geometry.rgba[colourOffset + channel] !== colour[channel]) invalid();
      }
    }
    const centre = Object.freeze([
      geometry.bounds[0]! + (geometry.bounds[3]! - geometry.bounds[0]!) / 2,
      geometry.bounds[1]! + (geometry.bounds[4]! - geometry.bounds[1]!) / 2,
      geometry.bounds[2]! + (geometry.bounds[5]! - geometry.bounds[2]!) / 2,
    ]) as readonly [number, number, number];
    return Object.freeze({ geometry, inspection, centre });
  } catch (error) {
    if (error instanceof Error && error.message === "M1-CITY-1") throw error;
    invalid();
  }
}
