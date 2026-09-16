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
  [0xa7, 0x8b, 0xfa, 0xff],
  [0x81, 0x8c, 0xf8, 0xff],
  [0x38, 0xbd, 0xf8, 0xff],
  [0x2d, 0xd4, 0xbf, 0xff],
  [0xa3, 0xe6, 0x35, 0xff],
  [0xfa, 0xcc, 0x15, 0xff],
] as const;

export const COMPLEXITY_PALETTE_LEGEND = Object.freeze([
  Object.freeze({ range: "0", rgba: "#A78BFAFF" }),
  Object.freeze({ range: "1", rgba: "#818CF8FF" }),
  Object.freeze({ range: "2–3", rgba: "#38BDF8FF" }),
  Object.freeze({ range: "4–7", rgba: "#2DD4BFFF" }),
  Object.freeze({ range: "8–15", rgba: "#A3E635FF" }),
  Object.freeze({ range: "16+", rgba: "#FACC15FF" }),
]);

const BUILDING_GAP = 2;
const GROUP_GAP = 8;
const GROUP_PADDING = 3;

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

export function paletteBandForComplexity(complexity: number): typeof COMPLEXITY_PALETTE_LEGEND[number] {
  return COMPLEXITY_PALETTE_LEGEND[paletteIndex(complexity)]!;
}

export function displayedHeight(sourceLines: number): number {
  if (!nonnegativeSafeInteger(sourceLines)) invalid();
  return 4 + Math.floor(36 * Math.log1p(Math.min(sourceLines, 1000)) / Math.log(1001) + 0.5);
}

export function displayedSide(executableUnits: number): number {
  if (!nonnegativeSafeInteger(executableUnits)) invalid();
  const ratio = Math.log1p(Math.min(executableUnits, 100)) / Math.log(101);
  return 3 + Math.floor(15 * ratio ** 1.5 + 0.5);
}

type TaggedGroup = Readonly<{ root: boolean; identity: string }>;
type PackedBuilding = Readonly<{ index: number; side: number; x: number; z: number }>;
type PackedGroup = Readonly<{
  group: TaggedGroup;
  buildings: readonly PackedBuilding[];
  width: number;
  depth: number;
}>;

function taggedGroup(canonicalPath: string): TaggedGroup {
  const segments = canonicalPath.split("/");
  segments.pop();
  if (segments.length === 0) return { root: true, identity: "_root" };
  return { root: false, identity: segments.slice(0, 2).join("/") };
}

function compareGroups(left: TaggedGroup, right: TaggedGroup): number {
  const compared = compareUnsignedUtf8(left.identity, right.identity);
  return compared !== 0 ? compared : left.root === right.root ? 0 : left.root ? -1 : 1;
}

function packFacts(facts: readonly FactSnapshot[], sides: readonly number[]): {
  origins: readonly number[];
  maximumX: number;
  maximumZ: number;
} {
  const groups = new Map<string, { group: TaggedGroup; indices: number[] }>();
  for (let index = 0; index < facts.length; index += 1) {
    const group = taggedGroup(facts[index]!.canonicalPath);
    const key = `${group.root ? "root" : "directory"}:${group.identity}`;
    const entry = groups.get(key) ?? { group, indices: [] };
    entry.indices.push(index);
    groups.set(key, entry);
  }

  const packedGroups: PackedGroup[] = [];
  for (const entry of groups.values()) {
    entry.indices.sort((left, right) => sides[right]! - sides[left]!
      || compareUnsignedUtf8(facts[left]!.canonicalPath, facts[right]!.canonicalPath));
    let area = 0;
    let maximumSide = 0;
    for (const index of entry.indices) {
      const side = sides[index]!;
      area = checkedAdd(area, checkedMultiply(checkedAdd(side, BUILDING_GAP), checkedAdd(side, BUILDING_GAP)));
      maximumSide = Math.max(maximumSide, side);
    }
    const target = Math.max(maximumSide, Math.ceil(Math.sqrt(area)));
    const buildings: PackedBuilding[] = [];
    let cursorX = 0;
    let cursorZ = 0;
    let rowDepth = 0;
    let occupiedWidth = 0;
    let occupiedDepth = 0;
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
    packedGroups.push({
      group: entry.group,
      buildings,
      width: checkedAdd(occupiedWidth, GROUP_PADDING * 2),
      depth: checkedAdd(occupiedDepth, GROUP_PADDING * 2),
    });
  }

  packedGroups.sort((left, right) => checkedMultiply(right.width, right.depth) - checkedMultiply(left.width, left.depth)
    || compareGroups(left.group, right.group));
  let outerArea = 0;
  let maximumCellWidth = 0;
  for (const group of packedGroups) {
    outerArea = checkedAdd(outerArea, checkedMultiply(checkedAdd(group.width, GROUP_GAP), checkedAdd(group.depth, GROUP_GAP)));
    maximumCellWidth = Math.max(maximumCellWidth, group.width);
  }
  const outerTarget = Math.max(maximumCellWidth, Math.ceil(Math.sqrt(outerArea)));
  const rawOrigins = new Array<number>(facts.length * 2).fill(0);
  let cursorX = 0;
  let cursorZ = 0;
  let rowDepth = 0;
  let minimumX = Number.POSITIVE_INFINITY;
  let minimumZ = Number.POSITIVE_INFINITY;
  for (const group of packedGroups) {
    if (cursorX !== 0 && checkedAdd(cursorX, group.width) > outerTarget) {
      cursorX = 0;
      cursorZ = checkedAdd(cursorZ, checkedAdd(rowDepth, GROUP_GAP));
      rowDepth = 0;
    }
    for (const building of group.buildings) {
      const x = checkedAdd(cursorX, building.x);
      const z = checkedAdd(cursorZ, building.z);
      rawOrigins[building.index * 2] = x;
      rawOrigins[building.index * 2 + 1] = z;
      minimumX = Math.min(minimumX, x);
      minimumZ = Math.min(minimumZ, z);
    }
    cursorX = checkedAdd(cursorX, checkedAdd(group.width, GROUP_GAP));
    rowDepth = Math.max(rowDepth, group.depth);
  }

  let maximumX = 0;
  let maximumZ = 0;
  for (let index = 0; index < facts.length; index += 1) {
    const x = rawOrigins[index * 2]! - minimumX;
    const z = rawOrigins[index * 2 + 1]! - minimumZ;
    rawOrigins[index * 2] = requireExactFloatInteger(x);
    rawOrigins[index * 2 + 1] = requireExactFloatInteger(z);
    maximumX = Math.max(maximumX, checkedAdd(x, sides[index]!));
    maximumZ = Math.max(maximumZ, checkedAdd(z, sides[index]!));
  }
  return { origins: rawOrigins, maximumX, maximumZ };
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
    const sideValues = new Array<number>(count);
    let maximumY = 0;
    for (let index = 0; index < count; index += 1) {
      const fact = facts[index]!;
      const side = requireExactFloatInteger(displayedSide(fact.U));
      const height = requireExactFloatInteger(displayedHeight(fact.S));
      sideValues[index] = side;
      const offset = index * 3;
      sizes[offset] = side;
      sizes[offset + 1] = height;
      sizes[offset + 2] = side;
      maximumY = Math.max(maximumY, height);
      rgba.set(paletteForComplexity(fact.M), index * 4);
    }

    const placement = packFacts(facts, sideValues);
    for (let index = 0; index < count; index += 1) {
      const offset = index * 3;
      origins[offset] = placement.origins[index * 2]!;
      origins[offset + 1] = 0;
      origins[offset + 2] = placement.origins[index * 2 + 1]!;
    }
    bounds.set([0, 0, 0, placement.maximumX, maximumY, placement.maximumZ]);

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
