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
const DECISION_KIND_SET: ReadonlySet<string> = new Set(DECISION_KINDS);
const EXPLICIT_UNIT_FORM_SET: ReadonlySet<string> = new Set(EXPLICIT_UNIT_FORMS);

function observationOrder(kind: unknown): number {
  switch (kind) {
    case "lexical-exclusion": return 0;
    case "explicit-unit": return 1;
    case "value-anchor": return 2;
    case "type-only": return 3;
    case "decision": return 4;
    default: return -1;
  }
}

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
    if (!EXPLICIT_UNIT_FORM_SET.has(unit.kind)
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

  const regions: Array<Readonly<{
    tableIndex: number;
    unitDepth: number;
    startByte: number;
    endByte: number;
  }>> = [];
  for (let explicitIndex = 0; explicitIndex < explicit.length; explicitIndex += 1) {
    const { tableIndex, unit } = explicit[explicitIndex]!;
    for (const region of unit.ownedRegions) {
      regions.push({ tableIndex, unitDepth: depths[explicitIndex]!, ...region });
    }
  }
  regions.sort((left, right) => left.startByte - right.startByte
    || right.endByte - left.endByte
    || left.unitDepth - right.unitDepth
    || left.tableIndex - right.tableIndex);

  const regionStack: number[] = [];
  const activeDepths = new Set<number>();
  for (let regionIndex = 0; regionIndex < regions.length; regionIndex += 1) {
    const region = regions[regionIndex]!;
    while (regionStack.length > 0 && region.startByte >= regions[regionStack.at(-1)!]!.endByte) {
      activeDepths.delete(regions[regionStack.pop()!]!.unitDepth);
    }
    if (regionStack.length > 0 && region.endByte > regions[regionStack.at(-1)!]!.endByte) malformed();
    if (activeDepths.has(region.unitDepth)) malformed();
    regionStack.push(regionIndex);
    activeDepths.add(region.unitDepth);
  }

  const complexities = new Float64Array(units.length);
  complexities.fill(1);
  let previousStart = -1;
  let previousEnd = -1;
  let previousKind = -1;

  if (regions.length === 0) {
    for (const observation of input.observations) {
      if (!observation) malformed();
      const order = observationOrder(observation.kind);
      if (order === -1
        || !validSpan(observation)
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
      if (!DECISION_KIND_SET.has(observation.decisionKind) || topLevelIndex === -1) malformed();
      const complexity = complexities[topLevelIndex]!;
      if (complexity >= Number.MAX_SAFE_INTEGER) malformed();
      complexities[topLevelIndex] = complexity + 1;
    }
  } else {
    let nextRegion = 0;
    const activeRegions: number[] = [];
    const activeBestRegions: number[] = [];
    for (const observation of input.observations) {
      if (!observation) malformed();
      const order = observationOrder(observation.kind);
      if (order === -1
        || !validSpan(observation)
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
      if (!DECISION_KIND_SET.has(observation.decisionKind)) malformed();

      while (nextRegion < regions.length && regions[nextRegion]!.startByte <= observation.startByte) {
        const region = regions[nextRegion]!;
        while (activeRegions.length > 0 && region.startByte >= regions[activeRegions.at(-1)!]!.endByte) {
          activeRegions.pop();
          activeBestRegions.pop();
        }
        const priorBest = activeBestRegions.at(-1) ?? -1;
        if (priorBest !== -1 && region.unitDepth === regions[priorBest]!.unitDepth) malformed();
        const best = priorBest === -1 || region.unitDepth > regions[priorBest]!.unitDepth
          ? nextRegion
          : priorBest;
        activeRegions.push(nextRegion);
        activeBestRegions.push(best);
        nextRegion += 1;
      }
      while (activeRegions.length > 0 && observation.startByte >= regions[activeRegions.at(-1)!]!.endByte) {
        activeRegions.pop();
        activeBestRegions.pop();
      }

      let owner = topLevelIndex;
      if (activeRegions.length > 0) {
        if (observation.endByte > regions[activeRegions.at(-1)!]!.endByte) malformed();
        owner = regions[activeBestRegions.at(-1)!]!.tableIndex;
      }
      if (owner === -1) malformed();
      const complexity = complexities[owner]!;
      if (complexity >= Number.MAX_SAFE_INTEGER) malformed();
      complexities[owner] = complexity + 1;
    }
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
