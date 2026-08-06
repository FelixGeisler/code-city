import type {
  CityBuilding,
  ComplexityDecisionKind,
  ComplexityDecisionSite,
  ExecutableUnitMetric,
  SourceLocation,
  SourceRange,
} from "../../../packages/core/src/model.js";
import type { ViewerAiGuidanceContext } from "./import-api.js";

export const INITIAL_DECISION_SITE_VISIBLE_LIMIT = 20;
export const MAXIMUM_DECISION_SITE_VISIBLE_LIMIT = 256;

export type CodeInspectionFocus =
  | Readonly<{
      kind: "file";
      buildingId: string;
    }>
  | Readonly<{
      kind: "unit";
      buildingId: string;
      unit: ExecutableUnitMetric;
      /** Current building-array identity for local legacy range navigation only. */
      localUnitIndex?: number;
      selectedSiteIndex?: number;
    }>
  | Readonly<{
      kind: "declaration";
      buildingId: string;
      category: "type" | "callable";
      stableId: string;
    }>
  | Readonly<{
      kind: "smell";
      buildingId: string;
      findingId: string;
      ruleId: string;
      range?: SourceLocation;
    }>;

export interface DecisionSitePresentation {
  readonly index: number;
  readonly label: string;
  readonly contribution: number;
  readonly range: SourceRange;
  readonly selected: boolean;
}

export type DecisionEvidencePresentation =
  | Readonly<{
      state: "legacy" | "unavailable";
      equation: string;
      summary: string;
      sites: readonly [];
      retainedSiteCount: 0;
      hiddenSiteCount: 0;
      canShowMore: false;
    }>
  | Readonly<{
      state: "complete" | "truncated";
      equation: string;
      summary: string;
      sites: readonly DecisionSitePresentation[];
      retainedSiteCount: number;
      hiddenSiteCount: number;
      canShowMore: boolean;
      totalContribution: number;
      retainedContribution: number;
      omittedContribution: number;
    }>;

export interface ResolvedCodeInspectionFocus {
  readonly contextualRange: SourceLocation;
  readonly exactRange?: SourceRange;
  readonly unit?: ExecutableUnitMetric;
  readonly decisionMarkers: readonly Readonly<{
    id: string;
    range: SourceRange;
    selected: boolean;
  }>[];
  readonly scrollLine: number;
}

export function fileInspectionFocus(
  buildingId: string,
): CodeInspectionFocus {
  return Object.freeze({ kind: "file", buildingId });
}

export function unitInspectionFocus(
  buildingId: string,
  unit: ExecutableUnitMetric,
  selectedSiteIndex?: number,
  localUnitIndex?: number,
): CodeInspectionFocus {
  return Object.freeze({
    kind: "unit",
    buildingId,
    unit,
    ...(localUnitIndex === undefined ? {} : { localUnitIndex }),
    ...(selectedSiteIndex === undefined ? {} : { selectedSiteIndex }),
  });
}

export function decisionKindLabel(
  kind: ComplexityDecisionKind,
): string {
  switch (kind) {
    case "conditional-branch":
      return "Conditional branch";
    case "loop":
      return "Loop";
    case "switch-arm":
      return "Switch arm";
    case "catch":
      return "Catch";
    case "conditional-expression":
      return "Conditional expression";
    case "short-circuit-operator":
      return "Short-circuit operator";
    case "nullish-operator":
      return "Nullish operator";
    case "guard":
      return "Guard";
    case "pattern-operator":
      return "Pattern operator";
  }
}

function rangeLabel(range: SourceRange): string {
  return range.startLine === range.endLine
    ? `line ${range.startLine}:${range.startColumn}–${range.endColumn}`
    : `lines ${range.startLine}:${range.startColumn}–${range.endLine}:${range.endColumn}`;
}

function visibleSiteLimit(value: number): number {
  if (!Number.isFinite(value)) return INITIAL_DECISION_SITE_VISIBLE_LIMIT;
  return Math.min(
    MAXIMUM_DECISION_SITE_VISIBLE_LIMIT,
    Math.max(1, Math.floor(value)),
  );
}

function sitePresentation(
  site: ComplexityDecisionSite,
  index: number,
  selectedSiteIndex: number | undefined,
): DecisionSitePresentation {
  return Object.freeze({
    index,
    label: `${decisionKindLabel(site.kind)} · ${rangeLabel(site.range)}`,
    contribution: site.contribution,
    range: site.range,
    selected: selectedSiteIndex === index,
  });
}

export function presentDecisionEvidence(
  unit: ExecutableUnitMetric,
  options: Readonly<{
    visibleLimit?: number;
    selectedSiteIndex?: number;
  }> = {},
): DecisionEvidencePresentation {
  const evidence = unit.decisionEvidence;
  if (evidence === undefined) {
    return Object.freeze({
      state: "legacy",
      equation: `CC ${unit.complexity.toLocaleString()} (aggregate only)`,
      summary:
        "This model predates persisted decision-site evidence. Code City will not infer decisions from source text.",
      sites: Object.freeze([]) as readonly [],
      retainedSiteCount: 0,
      hiddenSiteCount: 0,
      canShowMore: false,
    });
  }
  if (evidence.status === "unavailable") {
    return Object.freeze({
      state: "unavailable",
      equation: `CC ${unit.complexity.toLocaleString()} (decision sites unavailable)`,
      summary: `${evidence.reason} No decision sites are inferred.`,
      sites: Object.freeze([]) as readonly [],
      retainedSiteCount: 0,
      hiddenSiteCount: 0,
      canShowMore: false,
    });
  }
  const limit = visibleSiteLimit(
    options.visibleLimit ?? INITIAL_DECISION_SITE_VISIBLE_LIMIT,
  );
  const retainedContribution = evidence.sites.reduce(
    (sum, site) => sum + site.contribution,
    0,
  );
  const visible = evidence.sites.slice(0, limit).map((site, index) =>
    sitePresentation(site, index, options.selectedSiteIndex),
  );
  const omitted = evidence.omittedContribution;
  const retainedSummary =
    `${retainedContribution.toLocaleString()} contribution ` +
    `retained across ${evidence.sites.length.toLocaleString()} exact ` +
    `${evidence.sites.length === 1 ? "site" : "sites"}`;
  return Object.freeze({
    state: evidence.status,
    equation:
      `CC ${unit.complexity.toLocaleString()} = 1 base path + ` +
      `${evidence.totalContribution.toLocaleString()} persisted decision contribution`,
    summary: evidence.status === "complete"
      ? `${retainedSummary}; evidence is complete.`
      : `${retainedSummary}; ${omitted.toLocaleString()} contribution omitted by analyzer limits. ${evidence.reason}`,
    sites: Object.freeze(visible),
    retainedSiteCount: evidence.sites.length,
    hiddenSiteCount: evidence.sites.length - visible.length,
    canShowMore: visible.length < evidence.sites.length,
    totalContribution: evidence.totalContribution,
    retainedContribution,
    omittedContribution: omitted,
  });
}

function matchingUnit(
  building: CityBuilding,
  focus: Extract<CodeInspectionFocus, { readonly kind: "unit" }>,
): ExecutableUnitMetric | undefined {
  const unitId = focus.unit.decisionEvidence?.unitId;
  if (unitId !== undefined) {
    return building.units?.find(
      (unit) => unit.decisionEvidence?.unitId === unitId,
    );
  }
  if (focus.localUnitIndex !== undefined) {
    const candidate = building.units?.[focus.localUnitIndex];
    if (
      candidate === undefined ||
      candidate.decisionEvidence !== undefined ||
      candidate.name !== focus.unit.name ||
      candidate.line !== focus.unit.line ||
      candidate.endLine !== focus.unit.endLine ||
      candidate.complexity !== focus.unit.complexity
    ) {
      return undefined;
    }
    return candidate;
  }
  // Legacy aggregate focus remains useful for explicit source navigation only
  // when it identifies exactly one current persisted unit. This tuple is never
  // promoted to an AI identity.
  const matches = building.units?.filter((unit) =>
    unit.decisionEvidence === undefined &&
    unit.name === focus.unit.name &&
    unit.line === focus.unit.line &&
    unit.endLine === focus.unit.endLine &&
    unit.complexity === focus.unit.complexity,
  ) ?? [];
  return matches.length === 1 ? matches[0] : undefined;
}

export function resolveCodeInspectionFocus(
  building: CityBuilding,
  focus: CodeInspectionFocus,
): ResolvedCodeInspectionFocus | undefined {
  if (focus.buildingId !== building.id) return undefined;
  if (focus.kind === "file") {
    if (building.sourceLocation === undefined) return undefined;
    return Object.freeze({
      contextualRange: building.sourceLocation,
      decisionMarkers: Object.freeze([]),
      scrollLine: building.sourceLocation.startLine,
    });
  }
  if (focus.kind === "smell") {
    if (focus.range === undefined) return undefined;
    return Object.freeze({
      contextualRange: focus.range,
      decisionMarkers: Object.freeze([]),
      scrollLine: focus.range.startLine,
    });
  }
  if (focus.kind === "declaration") {
    const structure = building.sourceStructure;
    if (structure?.availability !== "available") return undefined;
    const fact = focus.category === "type"
      ? structure.types.find(({ id }) => id === focus.stableId)
      : structure.callables.find(({ id }) => id === focus.stableId);
    if (fact === undefined) return undefined;
    return Object.freeze({
      contextualRange: fact.range,
      exactRange: fact.range,
      decisionMarkers: Object.freeze([]),
      scrollLine: fact.range.startLine,
    });
  }
  const unit = matchingUnit(building, focus);
  if (unit === undefined) return undefined;
  const evidence = unit.decisionEvidence;
  const markers = evidence === undefined || evidence.status === "unavailable"
    ? []
    : evidence.sites.map((site, index) => Object.freeze({
        id: `decision:${index}`,
        range: site.range,
        selected: focus.selectedSiteIndex === index,
      }));
  const selected = focus.selectedSiteIndex === undefined
    ? undefined
    : evidence?.sites[focus.selectedSiteIndex];
  return Object.freeze({
    contextualRange: Object.freeze({
      startLine: unit.line,
      endLine: unit.endLine ?? unit.line,
    }),
    ...(selected === undefined ? {} : { exactRange: selected.range }),
    unit,
    decisionMarkers: Object.freeze(markers),
    scrollLine: selected?.range.startLine ?? unit.line,
  });
}

export function codeInspectionFocusKey(
  focus: CodeInspectionFocus,
): string {
  switch (focus.kind) {
    case "file":
      return `${focus.buildingId}:file`;
    case "declaration":
      return `${focus.buildingId}:declaration:${focus.category}:${focus.stableId}`;
    case "smell":
      return `${focus.buildingId}:smell:${focus.ruleId}:${focus.findingId}`;
    case "unit": {
      const unitIdentity = focus.unit.decisionEvidence?.unitId ??
        (focus.localUnitIndex === undefined
          ? `legacy:${focus.unit.name}:${focus.unit.line}:${focus.unit.endLine ?? focus.unit.line}:${focus.unit.complexity}`
          : `legacy-index:${focus.localUnitIndex}`);
      return `${focus.buildingId}:unit:${unitIdentity}:site:${focus.selectedSiteIndex ?? "none"}`;
    }
  }
}

/** Returns only identifier descriptors the server can resolve independently. */
export function codeInspectionAiContext(
  building: CityBuilding,
  focus: CodeInspectionFocus,
): ViewerAiGuidanceContext | undefined {
  if (focus.buildingId !== building.id) return undefined;
  if (focus.kind === "file") {
    return building.sourceLocation === undefined
      ? undefined
      : Object.freeze({
          version: "codecity.ai-context/1",
          kind: "file",
          buildingId: building.id,
        });
  }
  if (focus.kind === "smell") {
    return Object.freeze({
      version: "codecity.ai-context/1",
      kind: "smell",
      buildingId: building.id,
      findingId: focus.findingId,
      ruleId: focus.ruleId,
    });
  }
  const structure = building.sourceStructure;
  if (structure?.availability !== "available") return undefined;
  if (focus.kind === "declaration") {
    const exists = focus.category === "type"
      ? structure.types.some(({ id }) => id === focus.stableId)
      : structure.callables.some(({ id }) => id === focus.stableId);
    return exists
      ? Object.freeze({
          version: "codecity.ai-context/1",
          kind: focus.category,
          buildingId: building.id,
          stableId: focus.stableId,
        })
      : undefined;
  }
  const unit = matchingUnit(building, focus);
  const evidence = unit?.decisionEvidence;
  const callableId =
    evidence !== undefined &&
    (evidence.status === "complete" || evidence.status === "truncated") &&
    evidence.scope === "callable"
      ? evidence.callableId
      : undefined;
  if (
    callableId === undefined ||
    !structure.callables.some(({ id }) => id === callableId)
  ) {
    return undefined;
  }
  return Object.freeze({
    version: "codecity.ai-context/1",
    kind: "callable",
    buildingId: building.id,
    stableId: callableId,
  });
}
