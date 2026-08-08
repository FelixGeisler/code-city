import { describe, expect, it } from "vitest";

import {
  analyzeCSharpLexically,
  analyzeTypeScriptSource,
} from "../packages/analyzer/src/index.js";
import {
  CITY_MODEL_LIMITS,
  type SourceRange,
} from "../packages/core/src/index.js";

function textAtInclusiveRange(source: string, range: SourceRange): string {
  const lines = source.split("\n").slice(range.startLine - 1, range.endLine);
  if (lines.length === 1) {
    return lines[0]!.slice(range.startColumn - 1, range.endColumn);
  }
  return [
    lines[0]!.slice(range.startColumn - 1),
    ...lines.slice(1, -1),
    lines.at(-1)!.slice(0, range.endColumn),
  ].join("\n");
}

async function callableEvidence(
  fileName: string,
  source: string,
  name: string,
) {
  const result = await analyzeTypeScriptSource(fileName, source);
  const unit = result.units.find((candidate) => candidate.name === name)!;
  const evidence = unit.decisionEvidence!;
  const callable = result.sourceStructure.callables.find(
    (candidate) => candidate.name === name,
  )!;
  expect(evidence.scope).toBe("callable");
  expect(evidence.callableId).toBe(callable.id);
  expect(callable.complexity).toBe(unit.complexity);
  return { result, unit, evidence };
}

describe("complexity decision-site evidence", () => {
  it("records exact TypeScript branch, loop, switch, catch, conditional, and operator sites", async () => {
    const source = [
      "function decide(a: boolean, b: boolean, value?: number) {",
      "  for (let index = 0; index < 1; index += 1) {",
      "    if (a || b) break;",
      "  }",
      "  try {",
      "    switch (value) {",
      "      case 1: return a && b ? 1 : 0;",
      "      default: return value ?? 0;",
      "    }",
      "  } catch { return 0; }",
      "}",
    ].join("\n");
    const { unit, evidence } = await callableEvidence(
      "decision.ts",
      source,
      "decide",
    );

    expect(evidence.status).toBe("complete");
    if (evidence.status !== "complete") throw new Error("Expected complete evidence.");
    expect(evidence.totalContribution).toBe(8);
    expect(unit.complexity).toBe(9);
    expect(evidence.sites.map(({ kind }) => kind)).toEqual([
      "loop",
      "conditional-branch",
      "short-circuit-operator",
      "switch-arm",
      "short-circuit-operator",
      "conditional-expression",
      "nullish-operator",
      "catch",
    ]);
    expect(
      evidence.sites.map(({ range }) => textAtInclusiveRange(source, range)),
    ).toEqual(["for", "if", "||", "case", "&&", "?", "??", "catch"]);
    expect(
      evidence.sites.reduce((total, site) => total + site.contribution, 0),
    ).toBe(unit.complexity - 1);
  });

  it("uses the same exact contract for JavaScript logical assignments", async () => {
    const source = [
      "export function update(left, right) {",
      "  left &&= right;",
      "  left ||= right;",
      "  left ??= right;",
      "  return left ? right : null;",
      "}",
    ].join("\n");
    const { unit, evidence } = await callableEvidence(
      "decision.js",
      source,
      "update",
    );

    expect(evidence.status).toBe("complete");
    expect(evidence.sites.map(({ kind }) => kind)).toEqual([
      "short-circuit-operator",
      "short-circuit-operator",
      "nullish-operator",
      "conditional-expression",
    ]);
    expect(
      evidence.sites.map(({ range }) => textAtInclusiveRange(source, range)),
    ).toEqual(["&&=", "||=", "??=", "?"]);
    expect(unit.complexity).toBe(5);
  });

  it("makes lexical C# evidence explicitly unavailable", () => {
    const result = analyzeCSharpLexically(
      "class C { int Choose(bool value) { if (value) return 1; return 0; } }",
    );

    expect(result.units.every(({ decisionEvidence }) =>
      decisionEvidence?.status === "unavailable" &&
      decisionEvidence.sites.length === 0 &&
      decisionEvidence.reason.includes("csharp-lexical-v1"),
    )).toBe(true);
    expect(JSON.stringify(result.units)).not.toContain("totalContribution");
  });

  it("truncates deterministically at per-unit and per-file limits", async () => {
    const body = Array.from(
      { length: CITY_MODEL_LIMITS.decisionSitesPerUnit + 44 },
      (_, index) => `  if (values[${index}]) total += ${index};`,
    ).join("\n");
    const source = `function crowded(values: boolean[]) {\n  let total = 0;\n${body}\n  return total;\n}`;
    const first = await analyzeTypeScriptSource("crowded.ts", source);
    const second = await analyzeTypeScriptSource("crowded.ts", source);
    const evidence = first.units.find(({ name }) => name === "crowded")!
      .decisionEvidence!;

    expect(second).toEqual(first);
    expect(evidence.status).toBe("truncated");
    if (evidence.status !== "truncated") throw new Error("Expected truncated evidence.");
    expect(evidence.sites).toHaveLength(CITY_MODEL_LIMITS.decisionSitesPerUnit);
    expect(evidence.totalContribution).toBe(300);
    expect(evidence.omittedContribution).toBe(44);

    const functions = Array.from({ length: 17 }, (_, functionIndex) => {
      const decisions = Array.from(
        { length: CITY_MODEL_LIMITS.decisionSitesPerUnit },
        (_, decisionIndex) =>
          `  if (values[${decisionIndex}]) total += ${functionIndex};`,
      ).join("\n");
      return `function f${functionIndex}(values: boolean[]) { let total = 0;\n${decisions}\nreturn total; }`;
    }).join("\n");
    const bounded = await analyzeTypeScriptSource("bounded.ts", functions);
    const retained = bounded.units.reduce(
      (total, unit) => total + (unit.decisionEvidence?.sites.length ?? 0),
      0,
    );
    expect(retained).toBe(CITY_MODEL_LIMITS.decisionSitesPerBuilding);
    expect(
      bounded.units.some((unit) =>
        unit.decisionEvidence?.status === "truncated" &&
        unit.decisionEvidence.sites.length === 0),
    ).toBe(true);
  });
});
