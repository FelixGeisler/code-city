import { describe, expect, it } from "vitest";

import { analyzeTypeScriptSource } from "../packages/analyzer/src/typescript-metrics.js";
import { validateCityModel } from "../packages/core/src/model-validation.js";
import { projectFineDetail } from "../apps/viewer/src/progressive-granularity.js";

describe("persisted source structure", () => {
  it("records deterministic TypeScript declarations with exact source ranges", () => {
    const result = analyzeTypeScriptSource("src/example.ts", [
      "export class Outer {",
      "  method(value: number) { return value + 1; }",
      "  class Inner { run = () => 1; }",
      "}",
      "export function top() { return new Outer(); }",
    ].join("\n"));
    expect(result.sourceStructure.types.map(({ id, name, kind, range }) => ({ id, name, kind, startLine: range.startLine, startColumn: range.startColumn }))).toEqual([
      { id: "type:0001", name: "Outer", kind: "class", startLine: 1, startColumn: 1 },
      { id: "type:0002", name: "Inner", kind: "class", startLine: 3, startColumn: 3 },
    ]);
    expect(result.sourceStructure.callables.map(({ name, enclosingTypeId }) => [name, enclosingTypeId])).toEqual([
      ["method", "type:0001"], ["run", "type:0002"], ["top", undefined],
    ]);
    expect(result.sourceStructure.unavailable[0]).toContain("does not infer semantic bindings");
  });

  it("validates additive structure and exposes it lazily as types and functions", () => {
    const structure = analyzeTypeScriptSource("x.ts", "class C { m() {} }").sourceStructure;
    const building = {
      id: "b", repositoryId: "r", moduleId: "m", districtId: "d", name: "x.ts", path: "x.ts", language: "typescript" as const,
      metrics: { sloc: 1, decisionLoad: 0, maximumComplexity: 1, executableUnitCount: 2 }, metricMethod: "typescript-compiler-api-v1" as const,
      units: [{ name: "<top-level>", line: 1, endLine: 1, complexity: 1 }, { name: "m", line: 1, endLine: 1, complexity: 1 }],
      sourceLocation: { startLine: 1, endLine: 1 }, sourceStructure: {
        ...structure,
        types: structure.types.map((item) => ({ ...item, id: `b:${item.id}` })),
        callables: structure.callables.map((item) => ({ ...item, id: `b:${item.id}`, ...(item.enclosingTypeId === undefined ? {} : { enclosingTypeId: `b:${item.enclosingTypeId}` }) })),
      }, risk: "low" as const, semanticGroupId: "low", position: { x: 0, y: 0, z: 0 }, size: { x: 1, y: 1, z: 1 },
    };
    const detail = projectFineDetail(building);
    expect(detail.nodes.map(({ kind, name }) => [kind, name])).toEqual([["type", "C"], ["function", "m"]]);
    expect(detail.printable.state).toBe("not-printable");
    expect(() => validateCityModel({ schemaVersion: "1.0", generator: { name: "code-city", version: "test" }, repositories: [{ id: "r", name: "R" }], solutions: [], modules: [{ id: "m", repositoryId: "r", kind: "unassigned", name: "M", path: ".", solutionIds: [] }], semanticGroups: [{ id: "low", label: "Low", color: "#000000", priority: 0 }], districts: [{ id: "d", repositoryId: "r", moduleId: "m", name: "D", path: ".", position: { x: 0, y: 0, z: 0 }, size: { x: 2, y: 1, z: 2 } }], buildings: [building], dependencies: [], bounds: { x: 2, y: 2, z: 2 } })).not.toThrow();
  });
});
