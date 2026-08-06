import { describe, expect, it } from "vitest";

import {
  codeInspectionAiContext,
  decisionKindLabel,
  INITIAL_DECISION_SITE_VISIBLE_LIMIT,
  MAXIMUM_DECISION_SITE_VISIBLE_LIMIT,
  presentDecisionEvidence,
  resolveCodeInspectionFocus,
  unitInspectionFocus,
} from "../apps/viewer/src/code-inspection.js";
import { projectFineDetail } from "../apps/viewer/src/progressive-granularity.js";
import type {
  CityBuilding,
  ComplexityDecisionKind,
  ExecutableUnitMetric,
} from "../packages/core/src/model.js";

const BUILDING_ID = "building:1234567890abcdef";
const CALLABLE_ID = `${BUILDING_ID}:callable:run`;

function site(index: number) {
  return {
    kind: "conditional-branch" as const,
    range: {
      startLine: 10 + index,
      endLine: 10 + index,
      startColumn: 3,
      endColumn: 4,
    },
    contribution: 1,
  };
}

function unit(
  status: "complete" | "truncated" = "complete",
  siteCount = 2,
): ExecutableUnitMetric {
  return {
    name: "run",
    line: 10,
    endLine: 300,
    complexity: siteCount + 1,
    decisionEvidence: status === "complete"
      ? {
          version: "codecity.complexity-evidence/1",
          unitId: `${BUILDING_ID}:unit:run`,
          scope: "callable",
          callableId: CALLABLE_ID,
          status,
          totalContribution: siteCount,
          omittedContribution: 0,
          sites: Array.from({ length: siteCount }, (_, index) => site(index)),
        }
      : {
          version: "codecity.complexity-evidence/1",
          unitId: `${BUILDING_ID}:unit:run`,
          scope: "callable",
          callableId: CALLABLE_ID,
          status,
          totalContribution: siteCount + 4,
          omittedContribution: 4,
          reason: "Analyzer evidence budget reached.",
          sites: Array.from({ length: siteCount }, (_, index) => site(index)),
        },
  };
}

function building(executableUnit = unit()): CityBuilding {
  return {
    id: BUILDING_ID,
    repositoryId: "repository:1234567890abcdef",
    moduleId: "module:1234567890abcdef",
    districtId: "district:1234567890abcdef",
    name: "run.ts",
    path: "src/run.ts",
    language: "typescript",
    metrics: {
      sloc: 300,
      decisionLoad: executableUnit.complexity - 1,
      maximumComplexity: executableUnit.complexity,
      executableUnitCount: 1,
    },
    units: [executableUnit],
    sourceLocation: { startLine: 1, endLine: 300 },
    sourceStructure: {
      version: "codecity.source-structure/1",
      availability: "available",
      types: [],
      callables: [{
        id: CALLABLE_ID,
        name: "run",
        kind: "function",
        range: {
          startLine: 10,
          endLine: 300,
          startColumn: 1,
          endColumn: 1,
        },
        complexity: executableUnit.complexity,
      }],
      relations: [],
      unavailable: [],
    },
    risk: "high",
    semanticGroupId: "group",
    position: { x: 0, y: 0, z: 0 },
    size: { x: 1, y: 1, z: 1 },
  };
}

describe("code inspection presentation", () => {
  it("labels every persisted decision kind", () => {
    const kinds: readonly ComplexityDecisionKind[] = [
      "conditional-branch",
      "loop",
      "switch-arm",
      "catch",
      "conditional-expression",
      "short-circuit-operator",
      "nullish-operator",
      "guard",
      "pattern-operator",
    ];
    expect(kinds.map(decisionKindLabel)).toEqual([
      "Conditional branch",
      "Loop",
      "Switch arm",
      "Catch",
      "Conditional expression",
      "Short-circuit operator",
      "Nullish operator",
      "Guard",
      "Pattern operator",
    ]);
  });

  it("explains complete, truncated, unavailable, and legacy evidence honestly", () => {
    expect(presentDecisionEvidence(unit())).toMatchObject({
      state: "complete",
      equation: "CC 3 = 1 base path + 2 persisted decision contribution",
      retainedContribution: 2,
      omittedContribution: 0,
    });
    expect(presentDecisionEvidence(unit("truncated"))).toMatchObject({
      state: "truncated",
      retainedContribution: 2,
      omittedContribution: 4,
      totalContribution: 6,
    });
    const unavailable: ExecutableUnitMetric = {
      name: "legacy-lexical",
      line: 1,
      complexity: 7,
      decisionEvidence: {
        version: "codecity.complexity-evidence/1",
        unitId: `${BUILDING_ID}:unit:unavailable`,
        scope: "callable",
        status: "unavailable",
        reason: "Exact sites are unavailable.",
        sites: [],
      },
    };
    expect(presentDecisionEvidence(unavailable)).toMatchObject({
      state: "unavailable",
      sites: [],
    });
    expect(presentDecisionEvidence({
      name: "old",
      line: 1,
      complexity: 5,
    })).toMatchObject({
      state: "legacy",
      sites: [],
    });
  });

  it("bounds progressive site presentation at 20 initially and 256 maximum", () => {
    const many = unit("complete", MAXIMUM_DECISION_SITE_VISIBLE_LIMIT);
    expect(presentDecisionEvidence(many).sites).toHaveLength(
      INITIAL_DECISION_SITE_VISIBLE_LIMIT,
    );
    expect(presentDecisionEvidence(many, {
      visibleLimit: Number.MAX_SAFE_INTEGER,
    }).sites).toHaveLength(MAXIMUM_DECISION_SITE_VISIBLE_LIMIT);
  });

  it("resolves exact site focus and AI identity through the current unit and callable", () => {
    const currentUnit = unit();
    const currentBuilding = building(currentUnit);
    const focus = unitInspectionFocus(BUILDING_ID, currentUnit, 1);
    expect(resolveCodeInspectionFocus(currentBuilding, focus)).toMatchObject({
      contextualRange: { startLine: 10, endLine: 300 },
      exactRange: site(1).range,
      scrollLine: 11,
      decisionMarkers: [
        { id: "decision:0", selected: false },
        { id: "decision:1", selected: true },
      ],
    });
    expect(codeInspectionAiContext(currentBuilding, focus)).toEqual({
      version: "codecity.ai-context/1",
      kind: "callable",
      buildingId: BUILDING_ID,
      stableId: CALLABLE_ID,
    });
    const truncated = unit("truncated");
    expect(codeInspectionAiContext(
      building(truncated),
      unitInspectionFocus(BUILDING_ID, truncated),
    )).toEqual({
      version: "codecity.ai-context/1",
      kind: "callable",
      buildingId: BUILDING_ID,
      stableId: CALLABLE_ID,
    });
  });

  it("rejects stale, top-level, unlinked, and legacy units as AI identities", () => {
    const current = unit();
    const currentBuilding = building(current);
    const stale = {
      ...current,
      decisionEvidence: {
        ...current.decisionEvidence!,
        unitId: `${BUILDING_ID}:unit:stale`,
      },
    };
    expect(codeInspectionAiContext(
      currentBuilding,
      unitInspectionFocus(BUILDING_ID, stale),
    )).toBeUndefined();
    const topLevel = {
      ...current,
      decisionEvidence: {
        ...current.decisionEvidence!,
        scope: "top-level" as const,
      },
    };
    expect(codeInspectionAiContext(
      building(topLevel),
      unitInspectionFocus(BUILDING_ID, topLevel),
    )).toBeUndefined();
    const unavailable = {
      ...current,
      decisionEvidence: {
        version: "codecity.complexity-evidence/1" as const,
        unitId: current.decisionEvidence!.unitId,
        scope: "callable" as const,
        callableId: CALLABLE_ID,
        status: "unavailable" as const,
        reason: "Exact evidence unavailable.",
        sites: [] as const,
      },
    };
    expect(codeInspectionAiContext(
      building(unavailable),
      unitInspectionFocus(BUILDING_ID, unavailable),
    )).toBeUndefined();
    const legacy = { name: "run", line: 10, endLine: 300, complexity: 3 };
    expect(codeInspectionAiContext(
      building(legacy),
      unitInspectionFocus(BUILDING_ID, legacy),
    )).toBeUndefined();
  });

  it("uses current array identity for duplicate legacy ranges without granting AI identity", () => {
    const first = { name: "<anonymous>", line: 20, endLine: 24, complexity: 4 };
    const second = { ...first };
    const { sourceStructure: _sourceStructure, ...legacyBuilding } = building(first);
    const currentBuilding = {
      ...legacyBuilding,
      metrics: {
        ...building(first).metrics,
        executableUnitCount: 2,
      },
      units: [first, second],
    } satisfies CityBuilding;
    const firstFocus = unitInspectionFocus(BUILDING_ID, first, undefined, 0);
    const secondFocus = unitInspectionFocus(BUILDING_ID, second, undefined, 1);

    expect(resolveCodeInspectionFocus(currentBuilding, firstFocus)?.unit).toBe(first);
    expect(resolveCodeInspectionFocus(currentBuilding, secondFocus)?.unit).toBe(second);
    expect(codeInspectionAiContext(currentBuilding, firstFocus)).toBeUndefined();
    expect(codeInspectionAiContext(currentBuilding, secondFocus)).toBeUndefined();
    expect(resolveCodeInspectionFocus(
      currentBuilding,
      unitInspectionFocus(
        BUILDING_ID,
        { ...first, complexity: 99 },
        undefined,
        0,
      ),
    )).toBeUndefined();
  });

  it("routes a legacy Code outline fallback node to its indexed local range", () => {
    const earlier = { name: "later", line: 40, endLine: 44, complexity: 2 };
    const target = { name: "first", line: 5, endLine: 8, complexity: 3 };
    const { sourceStructure: _sourceStructure, ...legacyBuilding } = building(earlier);
    const currentBuilding = {
      ...legacyBuilding,
      metrics: {
        ...building(earlier).metrics,
        executableUnitCount: 2,
      },
      units: [earlier, target],
    } satisfies CityBuilding;
    const fallback = projectFineDetail(currentBuilding).nodes[0]!;
    expect(fallback).toMatchObject({
      name: "first",
      provenance: "persisted-executable-unit",
      unitIndex: 1,
    });
    const focus = unitInspectionFocus(
      BUILDING_ID,
      currentBuilding.units![fallback.unitIndex!]!,
      undefined,
      fallback.unitIndex,
    );
    expect(resolveCodeInspectionFocus(currentBuilding, focus)).toMatchObject({
      contextualRange: { startLine: 5, endLine: 8 },
      scrollLine: 5,
    });
    expect(codeInspectionAiContext(currentBuilding, focus)).toBeUndefined();
  });

  it("keeps a line-less smell identifier exact without falling back to file AI", () => {
    const currentBuilding = building();
    const focus = {
      kind: "smell" as const,
      buildingId: BUILDING_ID,
      findingId: "cycle:repository:viewer",
      ruleId: "cyclic-dependency",
    };
    expect(resolveCodeInspectionFocus(currentBuilding, focus)).toBeUndefined();
    expect(codeInspectionAiContext(currentBuilding, focus)).toEqual({
      version: "codecity.ai-context/1",
      kind: "smell",
      buildingId: BUILDING_ID,
      findingId: "cycle:repository:viewer",
      ruleId: "cyclic-dependency",
    });
  });
});
