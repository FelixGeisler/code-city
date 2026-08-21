import {
  DECISION_KINDS,
  EXPLICIT_UNIT_FORMS,
  type ByteSpan,
  type SyntaxObservation,
  type UnitIdentity,
} from "./base-metrics";
import { isCanonicalSourcePath } from "./source-admission";

export type ModuleComplexityFact = Readonly<{
  canonicalPath: string;
  S: number;
  U: number;
  M: number;
}>;

export type ComplexityInput = Readonly<{
  canonicalPath: string;
  S: number;
  U: number;
  units: Readonly<{
    length: number;
    [Symbol.iterator](): Iterator<UnitIdentity>;
  }>;
  observations: Iterable<SyntaxObservation>;
}>;

export type FinalizedModuleComplexity = Readonly<{
  fact: ModuleComplexityFact;
  perUnitComplexities: Readonly<Float64Array>;
}>;

const MAX_PACKED_BYTE_OFFSET = 0xffff_ffff;
const OBSERVATION_ORDER = ["lexical-exclusion", "explicit-unit", "value-anchor", "type-only", "decision"] as const;

function malformed(): never {
  throw new Error("M1-MET-1");
}

function nonnegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validSpan(span: ByteSpan): boolean {
  return nonnegativeSafeInteger(span.startByte)
    && Number.isSafeInteger(span.endByte)
    && span.endByte > span.startByte
    && span.endByte <= MAX_PACKED_BYTE_OFFSET;
}

function sameSpan(left: ByteSpan, right: ByteSpan): boolean {
  return left.startByte === right.startByte && left.endByte === right.endByte;
}

function compareExplicitUnits(left: Exclude<UnitIdentity, { kind: "top-level" }>, right: Exclude<UnitIdentity, { kind: "top-level" }>): number {
  return left.startByte - right.startByte
    || right.endByte - left.endByte
    || (left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0);
}

export function checkedComplexityIncrement(value: number): number {
  if (!nonnegativeSafeInteger(value) || value >= Number.MAX_SAFE_INTEGER) malformed();
  return value + 1;
}

export function finalizeModuleComplexity(input: ComplexityInput): FinalizedModuleComplexity {
  if (!isCanonicalSourcePath(input.canonicalPath)
    || !nonnegativeSafeInteger(input.S)
    || !nonnegativeSafeInteger(input.U)
    || !nonnegativeSafeInteger(input.units.length)
    || input.units.length !== input.U) {
    malformed();
  }

  const units = [...input.units];
  if (units.length !== input.units.length) malformed();
  let topLevelIndex = -1;
  const explicit: Array<Readonly<{
    tableIndex: number;
    unit: Exclude<UnitIdentity, { kind: "top-level" }>;
  }>> = [];

  for (let tableIndex = 0; tableIndex < units.length; tableIndex += 1) {
    const unit = units[tableIndex]!;
    if (!unit || unit.path !== input.canonicalPath) malformed();
    if (unit.kind === "top-level") {
      if (tableIndex !== 0 || topLevelIndex !== -1 || Reflect.ownKeys(unit).length !== 2) malformed();
      topLevelIndex = tableIndex;
      continue;
    }
    if (!(EXPLICIT_UNIT_FORMS as readonly string[]).includes(unit.kind)
      || !validSpan(unit)
      || !Array.isArray(unit.ownedRegions)) {
      malformed();
    }
    let priorEnd = -1;
    for (const region of unit.ownedRegions) {
      if (!validSpan(region)
        || region.startByte < unit.startByte
        || region.endByte > unit.endByte
        || region.startByte < priorEnd) {
        malformed();
      }
      priorEnd = region.endByte;
    }
    const previous = explicit.at(-1)?.unit;
    if (previous && compareExplicitUnits(previous, unit) >= 0) malformed();
    explicit.push({ tableIndex, unit });
  }

  const stack: number[] = [];
  const depths = new Uint32Array(explicit.length);
  for (let index = 0; index < explicit.length; index += 1) {
    const unit = explicit[index]!.unit;
    while (stack.length > 0 && unit.startByte >= explicit[stack.at(-1)!]!.unit.endByte) stack.pop();
    if (stack.length > 0) {
      const parent = explicit[stack.at(-1)!]!.unit;
      if (sameSpan(parent, unit) || unit.endByte > parent.endByte) malformed();
    }
    depths[index] = stack.length;
    stack.push(index);
  }

  const complexities = new Float64Array(units.length);
  complexities.fill(1);
  let previousStart = -1;
  let previousEnd = -1;
  let previousKind = -1;
  for (const observation of input.observations) {
    if (!observation || !(OBSERVATION_ORDER as readonly string[]).includes(observation.kind)) malformed();
    const order = OBSERVATION_ORDER.indexOf(observation.kind);
    if (!validSpan(observation)
      || observation.startByte < previousStart
      || (observation.startByte === previousStart
        && (observation.endByte > previousEnd
          || (observation.endByte === previousEnd && order < previousKind)))) {
      malformed();
    }
    previousStart = observation.startByte;
    previousEnd = observation.endByte;
    previousKind = order;
    if (observation.kind !== "decision") continue;
    if (!(DECISION_KINDS as readonly string[]).includes(observation.decisionKind)) malformed();

    let owner = -1;
    let ownerDepth = -1;
    for (let explicitIndex = 0; explicitIndex < explicit.length; explicitIndex += 1) {
      const { tableIndex, unit } = explicit[explicitIndex]!;
      if (unit.startByte > observation.startByte) break;
      if (observation.startByte >= unit.endByte) continue;
      for (const region of unit.ownedRegions) {
        if (observation.startByte < region.startByte || observation.startByte >= region.endByte) continue;
        if (observation.endByte > region.endByte) malformed();
        const depth = depths[explicitIndex]!;
        if (depth === ownerDepth) malformed();
        if (depth > ownerDepth) {
          owner = tableIndex;
          ownerDepth = depth;
        }
      }
    }
    if (owner === -1) {
      if (topLevelIndex === -1) malformed();
      owner = topLevelIndex;
    }
    complexities[owner] = checkedComplexityIncrement(complexities[owner]!);
  }

  let M = 0;
  for (const complexity of complexities) {
    if (!nonnegativeSafeInteger(complexity)) malformed();
    M = Math.max(M, complexity);
  }
  return {
    fact: { canonicalPath: input.canonicalPath, S: input.S, U: input.U, M },
    perUnitComplexities: complexities,
  };
}
