import type { ModuleComplexityFact } from "./complexity";
import { compareUnsignedUtf8, isCanonicalSourcePath, MAX_ADMITTED_MODULES } from "./source-admission";

export const PRESENTATION_KIND = "CODE_CITY_PRESENTATION" as const;

export type PresentationModel = Readonly<{
  kind: typeof PRESENTATION_KIND;
  count: number;
  origins: Float32Array;
  sizes: Float32Array;
  rgba: Uint8Array;
  bounds: Float32Array;
}>;

export type InspectionFact = Readonly<{ canonicalPath: string; S: number; U: number; M: number }>;

export type City = Readonly<{
  geometry: PresentationModel;
  inspection: readonly InspectionFact[];
}>;

export type CityView = Readonly<{
  target: readonly [number, number, number];
  D: readonly [number, number, number];
  R: readonly [number, number, number];
  V: readonly [number, number, number];
  E_r: number;
  E_v: number;
  H: number;
  verticalHalf: number;
  horizontalHalf: number;
  E_d: number;
  camera: readonly [number, number, number];
  near: number;
  far: number;
}>;

type DataRecord = Record<string, unknown>;
type FactSnapshot = Readonly<{ canonicalPath: string; S: number; U: number; M: number }>;

const MAX_FLOAT_INTEGER = 2 ** 24;
const MAX_TARGET_RELATIVE = 2 ** 23;
const FACT_KEYS = ["canonicalPath", "S", "U", "M"] as const;
const ARRAY_BUFFER_IS_VIEW = ArrayBuffer.isView;
const ARRAY_BUFFER_PROTOTYPE = ArrayBuffer.prototype;
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Float32Array.prototype) as object;
type IntrinsicGetter = (this: unknown) => unknown;
const TYPED_ARRAY_TAG = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, Symbol.toStringTag)!.get as IntrinsicGetter;
const TYPED_ARRAY_BUFFER = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "buffer")!.get as IntrinsicGetter;
const TYPED_ARRAY_BYTE_LENGTH = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "byteLength")!.get as IntrinsicGetter;
const TYPED_ARRAY_BYTE_OFFSET = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "byteOffset")!.get as IntrinsicGetter;
const TYPED_ARRAY_LENGTH = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "length")!.get as IntrinsicGetter;
const ARRAY_BUFFER_BYTE_LENGTH = Object.getOwnPropertyDescriptor(ARRAY_BUFFER_PROTOTYPE, "byteLength")!.get as IntrinsicGetter;
const PALETTE = [
  [0x44, 0x01, 0x54, 0xff],
  [0x41, 0x44, 0x87, 0xff],
  [0x2a, 0x78, 0x8e, 0xff],
  [0x22, 0xa8, 0x84, 0xff],
  [0x7a, 0xd1, 0x51, 0xff],
  [0xfd, 0xe7, 0x25, 0xff],
] as const;

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
  return Number.isSafeInteger(value)
    && value >= 0
    && value < MAX_FLOAT_INTEGER
    && Math.fround(value) === value;
}

function requireExactFloatInteger(value: number): number {
  if (!exactFloatInteger(value)) invalid();
  return value;
}

function exactTargetRelative(value: number): boolean {
  return Number.isFinite(value)
    && Math.abs(value) < MAX_TARGET_RELATIVE
    && Math.fround(value) === value;
}

function paletteIndex(complexity: number): number {
  if (complexity === 0) return 0;
  if (complexity === 1) return 1;
  if (complexity <= 3) return 2;
  if (complexity <= 7) return 3;
  if (complexity <= 15) return 4;
  return 5;
}

export function paletteForComplexity(complexity: number): typeof PALETTE[number] {
  return PALETTE[paletteIndex(complexity)]!;
}

function snapshotFacts(value: unknown): FactSnapshot[] {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) invalid();
    const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<PropertyKey, PropertyDescriptor>;
    const lengthDescriptor = descriptors.length;
    if (!lengthDescriptor || !("value" in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value)) invalid();
    const length = lengthDescriptor.value as number;
    if (length < 1 || length > MAX_ADMITTED_MODULES || Reflect.ownKeys(descriptors).length !== length + 1) invalid();

    const facts: FactSnapshot[] = [];
    const identities = new Set<string>();
    for (let index = 0; index < length; index += 1) {
      const element = descriptors[String(index)];
      if (!element || !("value" in element) || !element.enumerable) invalid();
      const record = ownEnumerableDataRecord(element.value, FACT_KEYS);
      if (!record
        || typeof record.canonicalPath !== "string"
        || !isCanonicalSourcePath(record.canonicalPath)
        || !nonnegativeSafeInteger(record.S)
        || !nonnegativeSafeInteger(record.U)
        || !nonnegativeSafeInteger(record.M)
        || identities.has(record.canonicalPath)) invalid();
      identities.add(record.canonicalPath);
      facts.push({ canonicalPath: record.canonicalPath, S: record.S, U: record.U, M: record.M });
    }
    facts.sort((left, right) => compareUnsignedUtf8(left.canonicalPath, right.canonicalPath));
    return facts;
  } catch (error) {
    if (error instanceof Error && error.message === "M1-CITY-1") throw error;
    invalid();
  }
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
    if (typeof buffer !== "object"
      || buffer === null
      || Object.getPrototypeOf(buffer) !== ARRAY_BUFFER_PROTOTYPE
      || ARRAY_BUFFER_BYTE_LENGTH.call(buffer) !== byteLength
      || Reflect.ownKeys(buffer).length !== 0) return false;

    const keys = Reflect.ownKeys(value);
    if (keys.length !== length) return false;
    for (let index = 0; index < length; index += 1) {
      if (keys[index] !== String(index)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function buildCity(input: readonly ModuleComplexityFact[]): City {
  const facts = snapshotFacts(input);
  const count = facts.length;
  const vectorLength = checkedMultiply(count, 3);
  const colourLength = checkedMultiply(count, 4);
  let origins: Float32Array | undefined;
  let sizes: Float32Array | undefined;
  let rgba: Uint8Array | undefined;
  let bounds: Float32Array | undefined;

  try {
    origins = new Float32Array(vectorLength);
    sizes = new Float32Array(vectorLength);
    rgba = new Uint8Array(colourLength);
    bounds = new Float32Array(6);
    const columnCount = Math.ceil(Math.sqrt(count));
    if (!Number.isSafeInteger(columnCount) || columnCount < 1 || columnCount * columnCount < count) invalid();
    const rowCount = Math.ceil(count / columnCount);
    const rowDepths = new Array<number>(rowCount).fill(0);

    for (let index = 0; index < count; index += 1) {
      const fact = facts[index]!;
      const width = requireExactFloatInteger(checkedAdd(fact.U, 1));
      const height = requireExactFloatInteger(checkedAdd(fact.S, 1));
      const offset = index * 3;
      sizes[offset] = width;
      sizes[offset + 1] = height;
      sizes[offset + 2] = width;
      rowDepths[Math.floor(index / columnCount)] = Math.max(rowDepths[Math.floor(index / columnCount)]!, width);
      const colour = paletteForComplexity(fact.M);
      rgba.set(colour, index * 4);
    }

    let z = 0;
    let maximumX = 0;
    let maximumY = 0;
    let maximumZ = 0;
    for (let row = 0; row < rowCount; row += 1) {
      let x = 0;
      const first = row * columnCount;
      const end = Math.min(first + columnCount, count);
      for (let index = first; index < end; index += 1) {
        const offset = index * 3;
        const width = sizes[offset]!;
        const height = sizes[offset + 1]!;
        origins[offset] = requireExactFloatInteger(x);
        origins[offset + 1] = 0;
        origins[offset + 2] = requireExactFloatInteger(z);
        const endpointX = requireExactFloatInteger(checkedAdd(x, width));
        const endpointY = requireExactFloatInteger(height);
        const endpointZ = requireExactFloatInteger(checkedAdd(z, width));
        maximumX = Math.max(maximumX, endpointX);
        maximumY = Math.max(maximumY, endpointY);
        maximumZ = Math.max(maximumZ, endpointZ);
        if (index + 1 < end) x = requireExactFloatInteger(checkedAdd(endpointX, 1));
      }
      if (row + 1 < rowCount) z = requireExactFloatInteger(checkedAdd(checkedAdd(z, rowDepths[row]!), 1));
    }
    bounds.set([0, 0, 0, maximumX, maximumY, maximumZ]);

    const geometry: PresentationModel = Object.freeze({ kind: PRESENTATION_KIND, count, origins, sizes, rgba, bounds });
    const inspection = Object.freeze(facts.map((fact) => Object.freeze({ ...fact })));
    return Object.freeze({ geometry, inspection });
  } catch (error) {
    origins?.fill(0);
    sizes?.fill(0);
    rgba?.fill(0);
    bounds?.fill(0);
    facts.length = 0;
    if (error instanceof Error && error.message === "M1-CITY-1") throw error;
    invalid();
  }
}

function boundsSnapshot(value: unknown): readonly [number, number, number, number, number, number] {
  try {
    const snapshot: number[] = [];
    if (Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype) {
      const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<PropertyKey, PropertyDescriptor>;
      if (Reflect.ownKeys(descriptors).length !== 7 || descriptors.length?.value !== 6) invalid();
      for (let index = 0; index < 6; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable || typeof descriptor.value !== "number") invalid();
        snapshot.push(descriptor.value);
      }
    } else if (exactTypedArray<Float32Array>(value, Float32Array.prototype, "Float32Array", 6, 4)) {
      for (let index = 0; index < 6; index += 1) snapshot.push(value[index]!);
    } else {
      invalid();
    }
    if (snapshot.some((entry) => !Number.isFinite(entry))) invalid();
    return snapshot as unknown as readonly [number, number, number, number, number, number];
  } catch (error) {
    if (error instanceof Error && error.message === "M1-CITY-1") throw error;
    invalid();
  }
}

function vector(x: number, y: number, z: number): readonly [number, number, number] {
  if (![x, y, z].every(Number.isFinite)) invalid();
  return Object.freeze([x, y, z]) as readonly [number, number, number];
}

export function deriveView(boundsValue: readonly number[] | Float32Array, aspect: number): CityView {
  const bounds = boundsSnapshot(boundsValue);
  if (!Number.isFinite(aspect) || aspect <= 0) invalid();
  const [minimumX, minimumY, minimumZ, maximumX, maximumY, maximumZ] = bounds;
  if (!(maximumX > minimumX) || !(maximumY > minimumY) || !(maximumZ > minimumZ)) invalid();

  const Lx = maximumX - minimumX;
  const Ly = maximumY - minimumY;
  const Lz = maximumZ - minimumZ;
  const target = vector((minimumX + maximumX) / 2, (minimumY + maximumY) / 2, (minimumZ + maximumZ) / 2);
  const sqrt2 = Math.sqrt(2);
  const sqrt3 = Math.sqrt(3);
  const sqrt6 = Math.sqrt(6);
  const D = vector(1 / sqrt3, 1 / sqrt3, 1 / sqrt3);
  const R = vector(1 / sqrt2, 0, -1 / sqrt2);
  const V = vector(-1 / sqrt6, 2 / sqrt6, -1 / sqrt6);
  const E_r = (Lx + Lz) / (2 * sqrt2);
  const E_v = (Lx + 2 * Ly + Lz) / (2 * sqrt6);
  const H = 1.1 * Math.max(E_v, E_r / aspect);
  const verticalHalf = H;
  const horizontalHalf = aspect * H;
  const E_d = (Lx + Ly + Lz) / (2 * sqrt3);
  const camera = vector(
    target[0] + 3 * E_d * D[0],
    target[1] + 3 * E_d * D[1],
    target[2] + 3 * E_d * D[2],
  );
  const near = E_d;
  const far = 5 * E_d;
  if (![Lx, Ly, Lz, E_r, E_v, H, verticalHalf, horizontalHalf, E_d, near, far].every(Number.isFinite)
    || H <= 0 || E_d <= 0 || near <= 0 || far <= near) invalid();
  return Object.freeze({ target, D, R, V, E_r, E_v, H, verticalHalf, horizontalHalf, E_d, camera, near, far });
}
