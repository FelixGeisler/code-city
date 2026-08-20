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
  "runtime-statement/declaration",
  "explicit-unit-declaration/expression",
  "value-or-side-effect-import-export",
  "nonambient runtime TypeScript enum/namespace",
  "top-level JSX",
] as const;

export const TYPE_ONLY_KINDS = [
  "import/export type",
  "import/export lists all specifiers type-only",
  "interface/type alias",
  "ambient/declare",
  "signature-only",
  "exact export{}",
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
  | Readonly<{
      kind: "explicit-unit";
      form: ExplicitUnitForm;
      startByte: number;
      endByte: number;
      ownedRegions: readonly ByteSpan[];
    }>
  | Readonly<{ kind: "value-anchor"; valueKind: ValueAnchorKind; startByte: number; endByte: number }>
  | Readonly<{ kind: "type-only"; typeKind: TypeOnlyKind; startByte: number; endByte: number }>
  | Readonly<{ kind: "decision"; decisionKind: DecisionKind; startByte: number; endByte: number }>;

export type SyntaxObservationStream = Readonly<{
  observations: readonly SyntaxObservation[];
  release(): void;
}>;

export type ExplicitUnitIdentity = Readonly<{
  path: string;
  kind: ExplicitUnitForm;
  startByte: number;
  endByte: number;
  ownedRegions: readonly ByteSpan[];
}>;

export type TopLevelIdentity = Readonly<{ path: string; kind: "top-level" }>;

export type BaseMetricAnalysis = Readonly<{
  canonicalPath: string;
  S: number;
  U: number;
  units: readonly (TopLevelIdentity | ExplicitUnitIdentity)[];
  observations: readonly SyntaxObservation[];
}>;

const encoder = new TextEncoder();
const WHITE_SPACE = /^\p{White_Space}$/u;

function validSpan(span: ByteSpan, byteLength: number): boolean {
  return Number.isSafeInteger(span.startByte)
    && Number.isSafeInteger(span.endByte)
    && span.startByte >= 0
    && span.endByte > span.startByte
    && span.endByte <= byteLength;
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function countSloc(source: string, exclusions: readonly ByteSpan[]): number {
  let byteOffset = 0;
  let exclusionIndex = 0;
  let lineHasSource = false;
  let count = 0;

  for (const scalar of source) {
    const scalarBytes = encoder.encode(scalar).byteLength;
    while (exclusionIndex < exclusions.length && exclusions[exclusionIndex]!.endByte <= byteOffset) {
      exclusionIndex += 1;
    }
    const excluded = exclusionIndex < exclusions.length
      && exclusions[exclusionIndex]!.startByte <= byteOffset
      && byteOffset + scalarBytes <= exclusions[exclusionIndex]!.endByte;
    if (scalar === "\n") {
      if (lineHasSource) {
        count += 1;
      }
      lineHasSource = false;
    } else if (!excluded && !WHITE_SPACE.test(scalar)) {
      lineHasSource = true;
    }
    byteOffset += scalarBytes;
  }
  return count + (lineHasSource ? 1 : 0);
}

function spanHasBytesOutsideRegions(span: ByteSpan, regions: readonly ByteSpan[]): boolean {
  let cursor = span.startByte;
  for (const region of regions) {
    if (region.endByte <= cursor || region.startByte >= span.endByte) {
      continue;
    }
    if (region.startByte > cursor) {
      return true;
    }
    cursor = Math.max(cursor, region.endByte);
    if (cursor >= span.endByte) {
      return false;
    }
  }
  return cursor < span.endByte;
}

export function deriveBaseMetricAnalysis(
  canonicalPath: string,
  normalizedSource: string,
  projected: readonly SyntaxObservation[],
): BaseMetricAnalysis {
  const byteLength = encoder.encode(normalizedSource).byteLength;
  const identities = new Set<string>();
  let previousStart = -1;
  let previousEnd = -1;
  const observations: readonly SyntaxObservation[] = projected.map((observation): SyntaxObservation => {
    if (!validSpan(observation, byteLength)) {
      throw new Error("Invalid projected range");
    }
    if (observation.startByte < previousStart
      || (observation.startByte === previousStart && observation.endByte > previousEnd)) {
      throw new Error("Observation stream is not source ordered");
    }
    previousStart = observation.startByte;
    previousEnd = observation.endByte;
    if (observation.kind === "explicit-unit") {
      const ownedRegions = observation.ownedRegions.map((region) => {
        if (!validSpan(region, byteLength)
          || region.startByte < observation.startByte
          || region.endByte > observation.endByte) {
          throw new Error("Invalid owned region");
        }
        return { ...region };
      }).sort((left, right) => left.startByte - right.startByte || left.endByte - right.endByte);
      const key = `${canonicalPath}\0${observation.form}\0${observation.startByte}\0${observation.endByte}`;
      if (identities.has(key)) {
        throw new Error("Duplicate explicit-unit identity");
      }
      identities.add(key);
      return { ...observation, ownedRegions };
    }
    return { ...observation };
  });

  const exclusions = observations
    .filter((observation): observation is Extract<SyntaxObservation, { kind: "lexical-exclusion" }> => observation.kind === "lexical-exclusion")
    .map(({ startByte, endByte }) => ({ startByte, endByte }))
    .sort((left, right) => left.startByte - right.startByte || left.endByte - right.endByte);
  for (let index = 1; index < exclusions.length; index += 1) {
    if (exclusions[index]!.startByte < exclusions[index - 1]!.endByte) {
      throw new Error("Overlapping lexical exclusions");
    }
  }

  const explicitUnits: ExplicitUnitIdentity[] = observations
    .filter((observation): observation is Extract<SyntaxObservation, { kind: "explicit-unit" }> => observation.kind === "explicit-unit")
    .map((observation) => ({
      path: canonicalPath,
      kind: observation.form,
      startByte: observation.startByte,
      endByte: observation.endByte,
      ownedRegions: observation.ownedRegions,
    }))
    .sort((left, right) => left.startByte - right.startByte
      || right.endByte - left.endByte
      || compareAscii(left.kind, right.kind));

  const allOwnedRegions = explicitUnits
    .flatMap((unit) => unit.ownedRegions)
    .sort((left, right) => left.startByte - right.startByte || left.endByte - right.endByte);
  const hasTopLevel = observations.some((observation) => observation.kind === "value-anchor"
    && spanHasBytesOutsideRegions(observation, allOwnedRegions));
  const units: (TopLevelIdentity | ExplicitUnitIdentity)[] = [
    ...(hasTopLevel ? [{ path: canonicalPath, kind: "top-level" as const }] : []),
    ...explicitUnits,
  ];

  return {
    canonicalPath,
    S: countSloc(normalizedSource, exclusions),
    U: units.length,
    units,
    observations,
  };
}
