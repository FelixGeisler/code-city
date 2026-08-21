export type GrammarFamily = "javascript-no-jsx" | "javascript-jsx" | "typescript" | "tsx";

export function selectGrammarFamily(canonicalPath: string): GrammarFamily {
  const finalSegment = canonicalPath.slice(canonicalPath.lastIndexOf("/") + 1)
    .replace(/[A-Z]/g, (character) => String.fromCharCode(character.charCodeAt(0) + 32));
  if (finalSegment.endsWith(".jsx")) return "javascript-jsx";
  if (finalSegment.endsWith(".tsx")) return "tsx";
  if (finalSegment.endsWith(".ts") || finalSegment.endsWith(".mts") || finalSegment.endsWith(".cts")) return "typescript";
  if (finalSegment.endsWith(".js") || finalSegment.endsWith(".mjs") || finalSegment.endsWith(".cjs")) return "javascript-no-jsx";
  throw new Error("Unsupported parser suffix");
}

export const EXPLICIT_UNIT_FORMS = [
  "function", "arrow", "method", "constructor", "getter", "setter", "static-block",
] as const;
export const VALUE_ANCHOR_KINDS = [
  "runtime-statement/declaration", "explicit-unit-declaration/expression",
  "value-or-side-effect-import-export", "nonambient runtime TypeScript enum/namespace", "top-level JSX",
] as const;
export const TYPE_ONLY_KINDS = [
  "import/export type", "import/export lists all specifiers type-only", "interface/type alias",
  "ambient/declare", "signature-only", "exact export{}",
] as const;
export const DECISION_KINDS = [
  "if", "loop", "case", "catch", "ternary", "logical-and", "logical-or", "nullish",
  "logical-and-assign", "logical-or-assign", "nullish-assign",
] as const;

export type ByteSpan = Readonly<{ startByte: number; endByte: number }>;
export type ExplicitUnitForm = typeof EXPLICIT_UNIT_FORMS[number];
export type ValueAnchorKind = typeof VALUE_ANCHOR_KINDS[number];
export type TypeOnlyKind = typeof TYPE_ONLY_KINDS[number];
export type DecisionKind = typeof DECISION_KINDS[number];
export type SyntaxObservation =
  | Readonly<{ kind: "lexical-exclusion"; startByte: number; endByte: number }>
  | Readonly<{ kind: "explicit-unit"; form: ExplicitUnitForm; startByte: number; endByte: number; ownedRegions: readonly ByteSpan[] }>
  | Readonly<{ kind: "value-anchor"; valueKind: ValueAnchorKind; startByte: number; endByte: number }>
  | Readonly<{ kind: "type-only"; typeKind: TypeOnlyKind; startByte: number; endByte: number }>
  | Readonly<{ kind: "decision"; decisionKind: DecisionKind; startByte: number; endByte: number }>;

const OBSERVATION_KINDS = ["lexical-exclusion", "explicit-unit", "value-anchor", "type-only", "decision"] as const;
const PAYLOADS = ["", ...EXPLICIT_UNIT_FORMS, ...VALUE_ANCHOR_KINDS, ...TYPE_ONLY_KINDS, ...DECISION_KINDS] as const;
type ObservationKind = typeof OBSERVATION_KINDS[number];
type Payload = typeof PAYLOADS[number];
const observationCode = (kind: ObservationKind) => OBSERVATION_KINDS.indexOf(kind);
const payloadCode = (payload: Payload) => PAYLOADS.indexOf(payload);

export type SyntaxObservationTable = Readonly<{
  length: number;
  at(index: number): SyntaxObservation | undefined;
  [Symbol.iterator](): Iterator<SyntaxObservation>;
  map<T>(callback: (observation: SyntaxObservation, index: number) => T): T[];
  filter(callback: (observation: SyntaxObservation, index: number) => boolean): SyntaxObservation[];
  packedByteLength(): number;
  toJSON(): SyntaxObservation[];
}>;

export type SyntaxObservationWriter = Readonly<{
  appendLexical(startByte: number, endByte: number): void;
  appendExplicit(form: ExplicitUnitForm, startByte: number, endByte: number, ownedStarts: ArrayLike<number>, ownedEnds: ArrayLike<number>): void;
  appendValue(valueKind: ValueAnchorKind, startByte: number, endByte: number): void;
  appendType(typeKind: TypeOnlyKind, startByte: number, endByte: number): void;
  appendDecision(decisionKind: DecisionKind, startByte: number, endByte: number): void;
  finish(): SyntaxObservationTable;
}>;

class PackedObservationTable implements SyntaxObservationTable {
  readonly length: number;
  private readonly codes: Uint8Array;
  private readonly payloads: Uint8Array;
  private readonly starts: Uint32Array;
  private readonly ends: Uint32Array;
  private readonly counts: Uint32Array;
  private readonly startSteps: Uint32Array;
  private readonly endSteps: Int32Array;
  private readonly ownedOffsets: Uint32Array;
  private readonly ownedCounts: Uint32Array;
  private readonly ownedStarts: Uint32Array;
  private readonly ownedEnds: Uint32Array;
  constructor(codes: Uint8Array, payloads: Uint8Array, starts: Uint32Array, ends: Uint32Array, counts: Uint32Array, startSteps: Uint32Array, endSteps: Int32Array, ownedOffsets: Uint32Array, ownedCounts: Uint32Array, ownedStarts: Uint32Array, ownedEnds: Uint32Array) {
    this.codes = codes; this.payloads = payloads; this.starts = starts; this.ends = ends; this.counts = counts;
    this.startSteps = startSteps; this.endSteps = endSteps; this.ownedOffsets = ownedOffsets; this.ownedCounts = ownedCounts;
    this.ownedStarts = ownedStarts; this.ownedEnds = ownedEnds;
    let length = 0;
    for (const count of counts) length += count;
    this.length = length;
  }

  private value(run: number, offset: number): SyntaxObservation {
    const kind = OBSERVATION_KINDS[this.codes[run]!]!;
    const startByte = this.starts[run]! + this.startSteps[run]! * offset;
    const endByte = this.ends[run]! + this.endSteps[run]! * offset;
    const payload = PAYLOADS[this.payloads[run]!]!;
    if (kind === "lexical-exclusion") return { kind, startByte, endByte };
    if (kind === "value-anchor") return { kind, valueKind: payload as ValueAnchorKind, startByte, endByte };
    if (kind === "type-only") return { kind, typeKind: payload as TypeOnlyKind, startByte, endByte };
    if (kind === "decision") return { kind, decisionKind: payload as DecisionKind, startByte, endByte };
    const ownedRegions: ByteSpan[] = [];
    const first = this.ownedOffsets[run]!;
    for (let index = 0; index < this.ownedCounts[run]!; index += 1) {
      ownedRegions.push({ startByte: this.ownedStarts[first + index]!, endByte: this.ownedEnds[first + index]! });
    }
    return { kind, form: payload as ExplicitUnitForm, startByte, endByte, ownedRegions };
  }

  at(index: number): SyntaxObservation | undefined {
    if (!Number.isInteger(index) || index < 0 || index >= this.length) return undefined;
    let remaining = index;
    for (let run = 0; run < this.counts.length; run += 1) {
      if (remaining < this.counts[run]!) return this.value(run, remaining);
      remaining -= this.counts[run]!;
    }
    return undefined;
  }

  *[Symbol.iterator](): Iterator<SyntaxObservation> {
    for (let run = 0; run < this.counts.length; run += 1) {
      for (let offset = 0; offset < this.counts[run]!; offset += 1) yield this.value(run, offset);
    }
  }

  map<T>(callback: (observation: SyntaxObservation, index: number) => T): T[] {
    const result: T[] = [];
    let index = 0;
    for (const observation of this) result.push(callback(observation, index++));
    return result;
  }

  filter(callback: (observation: SyntaxObservation, index: number) => boolean): SyntaxObservation[] {
    const result: SyntaxObservation[] = [];
    let index = 0;
    for (const observation of this) if (callback(observation, index++)) result.push(observation);
    return result;
  }

  packedByteLength(): number { return this.codes.byteLength + this.payloads.byteLength + this.starts.byteLength + this.ends.byteLength + this.counts.byteLength + this.startSteps.byteLength + this.endSteps.byteLength + this.ownedOffsets.byteLength + this.ownedCounts.byteLength + this.ownedStarts.byteLength + this.ownedEnds.byteLength; }
  toJSON(): SyntaxObservation[] { return [...this]; }
}

export function createSyntaxObservationWriter(): SyntaxObservationWriter {
  const codes: number[] = [];
  const payloads: number[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  const counts: number[] = [];
  const startSteps: number[] = [];
  const endSteps: number[] = [];
  const ownedOffsets: number[] = [];
  const ownedCounts: number[] = [];
  const ownedStarts: number[] = [];
  const ownedEnds: number[] = [];
  let finished = false;

  function append(kind: ObservationKind, payload: Payload, start: number, end: number, regionStarts?: ArrayLike<number>, regionEnds?: ArrayLike<number>): void {
    if (finished) throw new Error("Observation writer is closed");
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > 0xffff_ffff) throw new Error("Invalid packed observation range");
    const code = observationCode(kind);
    const packedPayload = payloadCode(payload);
    const regionCount = regionStarts?.length ?? 0;
    if (regionCount !== (regionEnds?.length ?? 0)) throw new Error("Mismatched owned regions");
    const last = counts.length - 1;
    if (regionCount === 0 && last >= 0 && ownedCounts[last] === 0 && codes[last] === code && payloads[last] === packedPayload) {
      const count = counts[last]!;
      const startStep = start - (starts[last]! + startSteps[last]! * (count - 1));
      const endStep = end - (ends[last]! + endSteps[last]! * (count - 1));
      if ((count === 1 || (startStep === startSteps[last] && endStep === endSteps[last])) && startStep >= 0 && endStep >= -0x8000_0000 && endStep <= 0x7fff_ffff) {
        if (count === 1) { startSteps[last] = startStep; endSteps[last] = endStep; }
        counts[last] = count + 1;
        return;
      }
    }
    codes.push(code); payloads.push(packedPayload); starts.push(start); ends.push(end); counts.push(1);
    startSteps.push(0); endSteps.push(0); ownedOffsets.push(ownedStarts.length); ownedCounts.push(regionCount);
    for (let index = 0; index < regionCount; index += 1) {
      ownedStarts.push(regionStarts![index]!); ownedEnds.push(regionEnds![index]!);
    }
  }

  return {
    appendLexical: (start, end) => append("lexical-exclusion", "", start, end),
    appendExplicit: (form, start, end, regionStarts, regionEnds) => append("explicit-unit", form, start, end, regionStarts, regionEnds),
    appendValue: (kind, start, end) => append("value-anchor", kind, start, end),
    appendType: (kind, start, end) => append("type-only", kind, start, end),
    appendDecision: (kind, start, end) => append("decision", kind, start, end),
    finish() {
      if (finished) throw new Error("Observation writer is closed");
      finished = true;
      return new PackedObservationTable(
        Uint8Array.from(codes), Uint8Array.from(payloads), Uint32Array.from(starts), Uint32Array.from(ends),
        Uint32Array.from(counts), Uint32Array.from(startSteps), Int32Array.from(endSteps),
        Uint32Array.from(ownedOffsets), Uint32Array.from(ownedCounts), Uint32Array.from(ownedStarts), Uint32Array.from(ownedEnds),
      );
    },
  };
}

export type SyntaxObservationStream = Readonly<{ observations: SyntaxObservationTable; release(): void }>;
export type ExplicitUnitIdentity = Readonly<{ path: string; kind: ExplicitUnitForm; startByte: number; endByte: number; ownedRegions: readonly ByteSpan[] }>;
export type TopLevelIdentity = Readonly<{ path: string; kind: "top-level" }>;
export type UnitIdentity = TopLevelIdentity | ExplicitUnitIdentity;
export type UnitIdentityTable = Readonly<{
  length: number;
  at(index: number): UnitIdentity | undefined;
  [Symbol.iterator](): Iterator<UnitIdentity>;
  map<T>(callback: (unit: UnitIdentity, index: number) => T): T[];
  packedByteLength(): number;
  toJSON(): UnitIdentity[];
}>;

class PackedUnitIdentityTable implements UnitIdentityTable {
  readonly length: number;
  private readonly path: string;
  private readonly hasTopLevel: boolean;
  private readonly forms: Uint8Array;
  private readonly starts: Uint32Array;
  private readonly ends: Uint32Array;
  private readonly ownedOffsets: Uint32Array;
  private readonly ownedCounts: Uint32Array;
  private readonly ownedStarts: Uint32Array;
  private readonly ownedEnds: Uint32Array;
  constructor(path: string, hasTopLevel: boolean, forms: Uint8Array, starts: Uint32Array, ends: Uint32Array, ownedOffsets: Uint32Array, ownedCounts: Uint32Array, ownedStarts: Uint32Array, ownedEnds: Uint32Array) {
    this.path = path; this.hasTopLevel = hasTopLevel; this.forms = forms; this.starts = starts; this.ends = ends;
    this.ownedOffsets = ownedOffsets; this.ownedCounts = ownedCounts; this.ownedStarts = ownedStarts; this.ownedEnds = ownedEnds;
    this.length = forms.length + (hasTopLevel ? 1 : 0);
  }
  at(index: number): UnitIdentity | undefined {
    if (!Number.isInteger(index) || index < 0 || index >= this.length) return undefined;
    if (this.hasTopLevel && index === 0) return { path: this.path, kind: "top-level" };
    const packedIndex = index - (this.hasTopLevel ? 1 : 0);
    const first = this.ownedOffsets[packedIndex]!;
    const ownedRegions: ByteSpan[] = [];
    for (let owned = 0; owned < this.ownedCounts[packedIndex]!; owned += 1) {
      ownedRegions.push({ startByte: this.ownedStarts[first + owned]!, endByte: this.ownedEnds[first + owned]! });
    }
    return { path: this.path, kind: EXPLICIT_UNIT_FORMS[this.forms[packedIndex]!]!, startByte: this.starts[packedIndex]!, endByte: this.ends[packedIndex]!, ownedRegions };
  }
  *[Symbol.iterator](): Iterator<UnitIdentity> { for (let index = 0; index < this.length; index += 1) yield this.at(index)!; }
  map<T>(callback: (unit: UnitIdentity, index: number) => T): T[] { const result: T[] = []; let index = 0; for (const unit of this) result.push(callback(unit, index++)); return result; }
  packedByteLength(): number { return this.forms.byteLength + this.starts.byteLength + this.ends.byteLength + this.ownedOffsets.byteLength + this.ownedCounts.byteLength + this.ownedStarts.byteLength + this.ownedEnds.byteLength; }
  toJSON(): UnitIdentity[] { return [...this]; }
}

export type BaseMetricAnalysis = Readonly<{ canonicalPath: string; S: number; U: number; units: UnitIdentityTable; observations: SyntaxObservationTable }>;
const encoder = new TextEncoder();
const WHITE_SPACE = /^\p{White_Space}$/u;
function validSpan(span: ByteSpan, byteLength: number): boolean { return Number.isSafeInteger(span.startByte) && Number.isSafeInteger(span.endByte) && span.startByte >= 0 && span.endByte > span.startByte && span.endByte <= byteLength; }
function countSloc(source: string, exclusionKeys: readonly number[], radix: number): number {
  let byteOffset = 0, exclusionIndex = 0, lineHasSource = false, count = 0;
  for (const scalar of source) {
    const scalarBytes = encoder.encode(scalar).byteLength;
    while (exclusionIndex < exclusionKeys.length && exclusionKeys[exclusionIndex]! % radix <= byteOffset) exclusionIndex += 1;
    const key = exclusionKeys[exclusionIndex];
    const excluded = key !== undefined && Math.floor(key / radix) <= byteOffset && byteOffset + scalarBytes <= key % radix;
    if (scalar === "\n") { if (lineHasSource) count += 1; lineHasSource = false; }
    else if (!excluded && !WHITE_SPACE.test(scalar)) lineHasSource = true;
    byteOffset += scalarBytes;
  }
  return count + (lineHasSource ? 1 : 0);
}
function spanHasBytesOutsideRegions(start: number, end: number, regionKeys: readonly number[], radix: number): boolean {
  let cursor = start;
  for (const key of regionKeys) {
    const regionStart = Math.floor(key / radix), regionEnd = key % radix;
    if (regionEnd <= cursor || regionStart >= end) continue;
    if (regionStart > cursor) return true;
    cursor = Math.max(cursor, regionEnd);
    if (cursor >= end) return false;
  }
  return cursor < end;
}

export function deriveBaseMetricAnalysis(canonicalPath: string, normalizedSource: string, projected: SyntaxObservationTable): BaseMetricAnalysis {
  const byteLength = encoder.encode(normalizedSource).byteLength;
  const radix = byteLength + 1;
  const exclusionKeys: number[] = [], regionKeys: number[] = [];
  const forms: number[] = [], starts: number[] = [], ends: number[] = [], ownedOffsets: number[] = [], ownedCounts: number[] = [], ownedStarts: number[] = [], ownedEnds: number[] = [];
  let previousStart = -1, previousEnd = -1, previousKind = -1;
  let duplicateKey: bigint | undefined;
  const identities = new Set<bigint>();
  const valueSpans: number[] = [];
  for (const observation of projected) {
    if (!validSpan(observation, byteLength)) throw new Error("Invalid projected range");
    const kind = observationCode(observation.kind);
    if (observation.startByte < previousStart || (observation.startByte === previousStart && (observation.endByte > previousEnd || (observation.endByte === previousEnd && kind < previousKind)))) throw new Error("Observation stream is not source ordered");
    previousStart = observation.startByte; previousEnd = observation.endByte; previousKind = kind;
    if (observation.kind === "lexical-exclusion") exclusionKeys.push(observation.startByte * radix + observation.endByte);
    if (observation.kind === "value-anchor") valueSpans.push(observation.startByte * radix + observation.endByte);
    if (observation.kind !== "explicit-unit") continue;
    const form = EXPLICIT_UNIT_FORMS.indexOf(observation.form);
    const identity = (BigInt(observation.startByte) << 40n) | (BigInt(observation.endByte) << 8n) | BigInt(form);
    if (identity === duplicateKey || identities.has(identity)) throw new Error("Duplicate explicit-unit identity");
    duplicateKey = identity; identities.add(identity);
    forms.push(form); starts.push(observation.startByte); ends.push(observation.endByte); ownedOffsets.push(ownedStarts.length); ownedCounts.push(observation.ownedRegions.length);
    let priorOwnedEnd = -1;
    for (const region of observation.ownedRegions) {
      if (!validSpan(region, byteLength) || region.startByte < observation.startByte || region.endByte > observation.endByte || region.startByte < priorOwnedEnd) throw new Error("Invalid owned region");
      priorOwnedEnd = region.endByte; ownedStarts.push(region.startByte); ownedEnds.push(region.endByte); regionKeys.push(region.startByte * radix + region.endByte);
    }
  }
  exclusionKeys.sort((left, right) => left - right); regionKeys.sort((left, right) => left - right);
  for (let index = 1; index < exclusionKeys.length; index += 1) if (Math.floor(exclusionKeys[index]! / radix) < exclusionKeys[index - 1]! % radix) throw new Error("Overlapping lexical exclusions");
  const order = forms.map((_, index) => index).sort((left, right) => starts[left]! - starts[right]! || ends[right]! - ends[left]! || (EXPLICIT_UNIT_FORMS[forms[left]!]! < EXPLICIT_UNIT_FORMS[forms[right]!]! ? -1 : 1));
  const sortedForms: number[] = [], sortedStarts: number[] = [], sortedEnds: number[] = [], sortedOwnedOffsets: number[] = [], sortedOwnedCounts: number[] = [], sortedOwnedStarts: number[] = [], sortedOwnedEnds: number[] = [];
  for (const index of order) {
    sortedForms.push(forms[index]!); sortedStarts.push(starts[index]!); sortedEnds.push(ends[index]!); sortedOwnedOffsets.push(sortedOwnedStarts.length); sortedOwnedCounts.push(ownedCounts[index]!);
    for (let owned = 0; owned < ownedCounts[index]!; owned += 1) { sortedOwnedStarts.push(ownedStarts[ownedOffsets[index]! + owned]!); sortedOwnedEnds.push(ownedEnds[ownedOffsets[index]! + owned]!); }
  }
  const hasTopLevel = valueSpans.some((key) => spanHasBytesOutsideRegions(Math.floor(key / radix), key % radix, regionKeys, radix));
  const units = new PackedUnitIdentityTable(canonicalPath, hasTopLevel, Uint8Array.from(sortedForms), Uint32Array.from(sortedStarts), Uint32Array.from(sortedEnds), Uint32Array.from(sortedOwnedOffsets), Uint32Array.from(sortedOwnedCounts), Uint32Array.from(sortedOwnedStarts), Uint32Array.from(sortedOwnedEnds));
  return { canonicalPath, S: countSloc(normalizedSource, exclusionKeys, radix), U: units.length, units, observations: projected };
}
