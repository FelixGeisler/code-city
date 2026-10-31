import { createSourceColoring, SYNTAX_PALETTE, type SourceColoring, type SyntaxSpan } from "./source-highlighting";
import { DECISION_KINDS, EXPLICIT_UNIT_FORMS } from "../domain/base-metrics";
import { isCanonicalSourcePath, MAX_NORMALIZED_MODULE_BYTES } from "../domain/source-admission";

export const UNIT_PAGE_SIZE = 32;
export const SOURCE_PAGE_BYTES = 8192;
export const CONTRIBUTION_PAGE_SIZE = 32;
export type SourceLocation = Readonly<{ line: number; column: number }>;
export type InspectionQuery =
  | Readonly<{ type: "units"; path: string; offset: number }>
  | Readonly<{ type: "source"; path: string; unit: number; cursor: number | null }>
  | Readonly<{ type: "contributions"; path: string; unit: number; offset: number }>;
export type UnitRow = Readonly<{ id: number; kind: string; complexity: number; start: SourceLocation; end: SourceLocation }>;
export type InspectionResult =
  | Readonly<{ type: "units"; path: string; offset: number; total: number; rows: readonly UnitRow[] }>
  | Readonly<{ type: "source"; path: string; unit: number; kind: string; complexity: number; start: SourceLocation; end: SourceLocation; cursor: number; next: number | null; text: string; syntax: readonly SyntaxSpan[]; syntaxUnavailable: boolean; highlights: readonly Readonly<{ start: number; end: number }>[] }>
  | Readonly<{ type: "contributions"; path: string; unit: number; offset: number; total: number; rows: readonly Readonly<{ kind: string; start: SourceLocation; end: SourceLocation }>[] }>;
export type InspectionEvidence = Readonly<{
  units: Readonly<{ length: number; at(index: number): Readonly<{ kind: string; startByte: number; endByte: number; complexity: number }> | undefined }>;
  contributionCount: number;
  contributions(): Iterable<readonly [number, string, number, number]>;
}>;
const kinds: readonly string[] = ["top-level", ...EXPLICIT_UNIT_FORMS];
const decisions: readonly string[] = DECISION_KINDS;
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
function requireValue(value: unknown): asserts value { if (!value) throw new Error("Unit inspection unavailable"); }
function integer(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum; }
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  requireValue(value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype);
  const entries = Object.getOwnPropertyDescriptors(value);
  requireValue(Reflect.ownKeys(entries).length === keys.length && keys.every(key => entries[key]?.enumerable && "value" in entries[key]!));
  return value as Record<string, unknown>;
}
function array(value: unknown, maximum: number): unknown[] { requireValue(Array.isArray(value) && value.length <= maximum && Object.keys(value).length === value.length); return value; }
function location(value: unknown): void { const point = object(value, ["line", "column"]); requireValue(integer(point.line, MAX_NORMALIZED_MODULE_BYTES + 1) && point.line > 0 && integer(point.column, MAX_NORMALIZED_MODULE_BYTES + 1) && point.column > 0); }
export function validateInspectionQuery(value: unknown): InspectionQuery {
  const candidate = value as InspectionQuery;
  requireValue(candidate && ["units", "source", "contributions"].includes(candidate.type));
  object(value, candidate.type === "units" ? ["type", "path", "offset"] : candidate.type === "source" ? ["type", "path", "unit", "cursor"] : ["type", "path", "unit", "offset"]);
  requireValue(typeof candidate.path === "string" && isCanonicalSourcePath(candidate.path));
  if (candidate.type !== "units") requireValue(integer(candidate.unit, MAX_NORMALIZED_MODULE_BYTES));
  if (candidate.type === "source") requireValue(candidate.cursor === null || integer(candidate.cursor, MAX_NORMALIZED_MODULE_BYTES));
  else requireValue(integer(candidate.offset, MAX_NORMALIZED_MODULE_BYTES));
  return candidate;
}
export function parseInspectionResult(value: unknown, query: InspectionQuery): InspectionResult {
  const data = object(value, query.type === "units" ? ["type", "path", "offset", "total", "rows"] : query.type === "source"
    ? ["type", "path", "unit", "kind", "complexity", "start", "end", "cursor", "next", "text", "syntax", "syntaxUnavailable", "highlights"] : ["type", "path", "unit", "offset", "total", "rows"]);
  requireValue(data.type === query.type && data.path === query.path);
  if (query.type !== "units") requireValue(data.unit === query.unit);
  if (query.type === "source") {
    requireValue(kinds.includes(data.kind as string) && integer(data.complexity) && data.complexity > 0);
    location(data.start); location(data.end);
    requireValue(integer(data.cursor, MAX_NORMALIZED_MODULE_BYTES) && (query.cursor === null || query.cursor === data.cursor));
    requireValue(data.next === null || (integer(data.next, MAX_NORMALIZED_MODULE_BYTES) && data.next > data.cursor));
    requireValue(typeof data.text === "string" && data.text.isWellFormed() && new TextEncoder().encode(data.text).length <= SOURCE_PAGE_BYTES);
    requireValue(typeof data.syntaxUnavailable === "boolean" && (!data.syntaxUnavailable || (Array.isArray(data.syntax) && data.syntax.length === 0)));
    for (const name of ["highlights", "syntax"] as const) {
      let end = 0;
      for (const item of array(data[name], SOURCE_PAGE_BYTES)) {
        const span = object(item, name === "syntax" ? ["color", "start", "end"] : ["start", "end"]);
        if (name === "syntax") requireValue(integer(span.color, SYNTAX_PALETTE.length - 1));
        requireValue(integer(span.start, data.text.length) && integer(span.end, data.text.length) && span.start >= end && span.end > span.start);
        for (const index of [span.start, span.end]) requireValue(!(index > 0 && /[\uD800-\uDBFF]/u.test(data.text[index - 1]!) && /[\uDC00-\uDFFF]/u.test(data.text[index] ?? "")));
        end = span.end;
      }
    }
  } else {
    requireValue(data.offset === query.offset && integer(data.total, MAX_NORMALIZED_MODULE_BYTES) && query.offset <= data.total);
    const rows = array(data.rows, query.type === "units" ? UNIT_PAGE_SIZE : CONTRIBUTION_PAGE_SIZE);
    requireValue(rows.length === Math.min(query.type === "units" ? UNIT_PAGE_SIZE : CONTRIBUTION_PAGE_SIZE, data.total - query.offset));
    const seen = new Set<number>();
    for (const item of rows) {
      const row = object(item, query.type === "units" ? ["id", "kind", "complexity", "start", "end"] : ["kind", "start", "end"]);
      location(row.start); location(row.end);
      if (query.type === "units") { requireValue(integer(row.id, data.total - 1) && !seen.has(row.id) && kinds.includes(row.kind as string) && integer(row.complexity) && row.complexity > 0); seen.add(row.id); }
      else requireValue(decisions.includes(row.kind as string));
    }
  }
  return data as unknown as InspectionResult;
}

/** Presentation indexing of retained facts, never parsing or metric computation. */
export function createFileInspection(path: string, bytes: Uint8Array, evidence: InspectionEvidence, colorSource: typeof createSourceColoring = createSourceColoring) {
  requireValue(isCanonicalSourcePath(path) && bytes.length <= MAX_NORMALIZED_MODULE_BYTES);
  const normalizedText = decoder.decode(bytes); // Decode retained text; do not parse or analyze it.
  let coloring: Promise<SourceColoring | undefined> | undefined;
  let coloringFailed = false;
  const columns = new Uint32Array(bytes.length + 1), lineStarts = [0];
  let column = 1;
  for (let offset = 0; offset < bytes.length; offset++) {
    if ((bytes[offset]! & 0xc0) === 0x80) continue;
    columns[offset] = column++;
    if (bytes[offset] === 10) { lineStarts.push(offset + 1); column = 1; }
  }
  columns[bytes.length] = column;
  const boundary = (offset: number) => integer(offset, bytes.length) && columns[offset]! > 0;
  const locate = (offset: number): SourceLocation => {
    requireValue(boundary(offset)); let low = 0, high = lineStarts.length;
    while (low + 1 < high) { const middle = (low + high) >>> 1; if (lineStarts[middle]! <= offset) low = middle; else high = middle; }
    return { line: low + 1, column: columns[offset]! };
  };
  const count = evidence.units.length;
  requireValue(integer(count, MAX_NORMALIZED_MODULE_BYTES) && integer(evidence.contributionCount, MAX_NORMALIZED_MODULE_BYTES));
  const starts = new Uint32Array(count), ends = new Uint32Array(count), forms = new Uint8Array(count), complexities = new Float64Array(count);
  const order = Uint32Array.from({ length: count }, (_, index) => index);
  for (let index = 0; index < count; index++) {
    const unit = evidence.units.at(index); requireValue(unit && kinds.includes(unit.kind) && integer(unit.complexity) && unit.complexity > 0);
    const start = unit.kind === "top-level" ? 0 : unit.startByte, end = unit.kind === "top-level" ? bytes.length : unit.endByte;
    requireValue(boundary(start) && boundary(end) && start <= end);
    starts[index] = start; ends[index] = end;
    forms[index] = kinds.indexOf(unit.kind); complexities[index] = unit.complexity;
  }
  order.sort((a, b) => complexities[b]! - complexities[a]! || starts[a]! - starts[b]! || ends[b]! - ends[a]! || (kinds[forms[a]!]! < kinds[forms[b]!]! ? -1 : kinds[forms[a]!]! > kinds[forms[b]!]! ? 1 : 0));
  const offsets = new Uint32Array(count + 1), contributionStarts = new Uint32Array(evidence.contributionCount), contributionEnds = new Uint32Array(evidence.contributionCount), contributionKinds = new Uint8Array(evidence.contributionCount), owners = new Uint32Array(evidence.contributionCount);
  let position = 0;
  for (const [owner, kind, start, end] of evidence.contributions()) {
    requireValue(position < evidence.contributionCount && integer(owner, count - 1) && decisions.includes(kind) && boundary(start) && boundary(end) && start < end && start >= starts[owner]! && end <= ends[owner]!);
    owners[position] = owner; contributionStarts[position] = start; contributionEnds[position] = end; contributionKinds[position] = decisions.indexOf(kind); offsets[owner + 1] = offsets[owner + 1]! + 1; position++;
  }
  requireValue(position === evidence.contributionCount);
  for (let index = 0; index < count; index++) { requireValue(offsets[index + 1] === complexities[index]! - 1); offsets[index + 1] = offsets[index + 1]! + offsets[index]!; }
  const positions = offsets.slice(), byOwner = new Uint32Array(position);
  for (let index = 0; index < position; index++) { const owner = owners[index]!; byOwner[positions[owner]!] = index; positions[owner] = positions[owner]! + 1; }
  for (let owner = 0; owner < count; owner++) byOwner.subarray(offsets[owner], offsets[owner + 1]).sort((a, b) => contributionStarts[a]! - contributionStarts[b]! || contributionEnds[b]! - contributionEnds[a]! || contributionKinds[a]! - contributionKinds[b]!);
  let unionUnit = -1, union: Array<{ start: number; end: number }> = [];
  return async (query: InspectionQuery): Promise<InspectionResult> => {
    validateInspectionQuery(query); requireValue(query.path === path);
    if (query.type === "units") {
      requireValue(query.offset <= count);
      return { type: "units", path, total: count, offset: query.offset, rows: Array.from(order.subarray(query.offset, query.offset + UNIT_PAGE_SIZE), id => ({ id, kind: kinds[forms[id]!]!, complexity: complexities[id]!, start: locate(starts[id]!), end: locate(ends[id]!) })) };
    }
    const id = query.unit; requireValue(id < count);
    const first = offsets[id]!, last = offsets[id + 1]!;
    if (query.type === "contributions") {
      requireValue(query.offset <= last - first);
      return { type: "contributions", path, unit: id, offset: query.offset, total: last - first, rows: Array.from(byOwner.subarray(first + query.offset, Math.min(last, first + query.offset + CONTRIBUTION_PAGE_SIZE)), index => ({ kind: decisions[contributionKinds[index]!]!, start: locate(contributionStarts[index]!), end: locate(contributionEnds[index]!) })) };
    }
    const cursor = query.cursor ?? starts[id]!;
    requireValue(boundary(cursor) && cursor >= starts[id]! && cursor <= ends[id]!);
    let end = Math.min(ends[id]!, cursor + SOURCE_PAGE_BYTES), lines = 0;
    while (!boundary(end)) end--;
    for (let offset = cursor; offset < end; offset++) if (bytes[offset] === 10 && ++lines === 80) { end = offset + 1; break; }
    if (unionUnit !== id) {
      union = []; unionUnit = id;
      for (let offset = first; offset < last; offset++) { const index = byOwner[offset]!, start = contributionStarts[index]!, finish = contributionEnds[index]!; const prior = union.at(-1); if (prior && start <= prior.end) prior.end = Math.max(prior.end, finish); else union.push({ start, end: finish }); }
    }
    const text = decoder.decode(bytes.subarray(cursor, end)), utf16 = new Uint32Array(end - cursor + 1);
    let byte = 0, character = 0;
    for (const scalar of text) { utf16[byte] = character; const point = scalar.codePointAt(0)!; byte += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4; character += scalar.length; }
    utf16[byte] = character;
    const highlights: Array<{ start: number; end: number }> = [];
    // Disjoint unions allow logarithmic lookup even for dense decision streams.
    let low = 0, high = union.length;
    while (low < high) { const middle = (low + high) >>> 1; if (union[middle]!.end <= cursor) low = middle + 1; else high = middle; }
    for (let index = low; index < union.length && union[index]!.start < end; index++) { const span = union[index]!; highlights.push({ start: utf16[Math.max(cursor, span.start) - cursor]!, end: utf16[Math.min(end, span.end) - cursor]! }); }
    let syntax: readonly SyntaxSpan[] = [];
    if (!coloringFailed) {
      try {
        // A single promise also owns concurrent opens while initialization is pending.
        coloring ??= Promise.resolve().then(() => colorSource(path, normalizedText)).catch(() => undefined);
        const readColor = await coloring;
        if (!readColor) coloringFailed = true;
        else if (!coloringFailed) {
          const textStart = decoder.decode(bytes.subarray(0, cursor)).length;
          syntax = readColor(textStart, textStart + text.length);
        }
      } catch { coloringFailed = true; }
    }
    return { type: "source", path, unit: id, kind: kinds[forms[id]!]!, complexity: complexities[id]!, start: locate(cursor), end: locate(end), cursor, next: end < ends[id]! ? end : null, text, syntax, syntaxUnavailable: coloringFailed, highlights };
  };
}
