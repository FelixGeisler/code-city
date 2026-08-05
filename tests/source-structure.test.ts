import { describe, expect, it } from "vitest";

import { analyzeTypeScriptSource } from "../packages/analyzer/src/typescript-metrics.js";
import { validateCityModel } from "../packages/core/src/model-validation.js";
import type { SourceRange } from "../packages/core/src/model.js";
import { projectFineDetail } from "../apps/viewer/src/progressive-granularity.js";

function textAtInclusiveRange(source: string, range: SourceRange): string {
  const selectedLines = source
    .split("\n")
    .slice(range.startLine - 1, range.endLine);
  const firstLine = selectedLines[0]!;
  if (selectedLines.length === 1) {
    return firstLine.slice(range.startColumn - 1, range.endColumn);
  }
  const lastLine = selectedLines.at(-1)!;
  return [
    firstLine.slice(range.startColumn - 1),
    ...selectedLines.slice(1, -1),
    lastLine.slice(0, range.endColumn),
  ].join("\n");
}

describe("persisted source structure", () => {
  it("records deterministic TypeScript declarations with exact source ranges", () => {
    const result = analyzeTypeScriptSource("src/example.ts", [
      "export class Outer {",
      "  method(value: number) { return value + 1; }",
      "  static Inner = class Inner { run = () => 1; };",
      "}",
      "export function top() { return new Outer(); }",
    ].join("\n"));
    const outer = result.sourceStructure.types.find(({ name }) => name === "Outer")!;
    const inner = result.sourceStructure.types.find(({ name }) => name === "Inner")!;
    expect([outer, inner].map(({ id, name, kind, range }) => ({ id, name, kind, startLine: range.startLine, startColumn: range.startColumn }))).toEqual([
      expect.objectContaining({ id: expect.stringMatching(/^type:/u), name: "Outer", kind: "class", startLine: 1, startColumn: 1 }),
      expect.objectContaining({ id: expect.stringMatching(/^type:/u), name: "Inner", kind: "class", startLine: 3, startColumn: 18 }),
    ]);
    expect(result.sourceStructure.callables.map(({ name, enclosingTypeId, complexity }) => [name, enclosingTypeId, complexity])).toEqual([
      ["method", outer.id, 1], ["run", inner.id, 1], ["top", undefined, 1],
    ]);
    expect(result.sourceStructure.unavailable[0]).toContain("does not infer semantic bindings");
  });

  it("emits inclusive TypeScript end columns for one-character bodies and multiline declarations", () => {
    const source = [
      "const one = () => 1;",
      "export function multi(",
      "  value: number,",
      ") {",
      "  return value;",
      "}",
    ].join("\n");
    const structure = analyzeTypeScriptSource("src/ranges.ts", source).sourceStructure;
    const one = structure.callables.find(({ name }) => name === "one")!;
    const multi = structure.callables.find(({ name }) => name === "multi")!;

    expect(textAtInclusiveRange(source, one.range)).toBe("() => 1");
    expect(textAtInclusiveRange(source, multi.range)).toBe([
      "export function multi(",
      "  value: number,",
      ") {",
      "  return value;",
      "}",
    ].join("\n"));
  });

  it("keeps semantic declaration identities stable across unrelated insertions", () => {
    const before = analyzeTypeScriptSource(
      "src/example.ts",
      "class C { m(value: number) { if (value) return 1; return 0; } }",
    ).sourceStructure;
    const after = analyzeTypeScriptSource(
      "src/example.ts",
      "function unrelated() {}\nclass C { m(value: number) { if (value) return 1; return 0; } }",
    ).sourceStructure;
    expect(after.types.find(({ name }) => name === "C")?.id).toBe(
      before.types.find(({ name }) => name === "C")?.id,
    );
    expect(after.callables.find(({ name }) => name === "m")?.id).toBe(
      before.callables.find(({ name }) => name === "m")?.id,
    );
    expect(before.callables.find(({ name }) => name === "m")?.complexity).toBe(
      2,
    );
  });

  it("keeps declaration identities stable when unrelated declarations are inserted", () => {
    const original = analyzeTypeScriptSource("x.ts", "class C { m() {} }").sourceStructure;
    const inserted = analyzeTypeScriptSource("x.ts", "class Added {}\nclass C { m() {} }").sourceStructure;
    expect(inserted.types.find(({ name }) => name === "C")?.id).toBe(
      original.types.find(({ name }) => name === "C")?.id,
    );
    expect(inserted.callables.find(({ name }) => name === "m")?.id).toBe(
      original.callables.find(({ name }) => name === "m")?.id,
    );
  });

  it("keeps canonical IDs stable across bodies, formatting, members, namespaces, and enclosing callables", () => {
    const before = analyzeTypeScriptSource("x.ts", `namespace N { class C { m(value:Array<string>) { if (value.length) return 1; return 0; } } function outer(){ function local(x:string){ return x; } return local("x"); } }`).sourceStructure;
    const after = analyzeTypeScriptSource("x.ts", `namespace N {
      class C {
        added() {}
        m( renamed : Array < /* stable formatting */ string > ) { return renamed.length + 10; }
      }
      function outer ( ) {
        const inserted = 1;
        function local( x : string ) { return x.toUpperCase(); }
        return local("x") + inserted;
      }
    }`).sourceStructure;
    for (const name of ["C", "m", "outer", "local"]) {
      const original = [...before.types, ...before.callables].find((item) => item.name === name)?.id;
      expect([...after.types, ...after.callables].find((item) => item.name === name)?.id, name).toBe(original);
    }
    expect(after.callables.find(({ name }) => name === "local")?.kind).toBe(
      "local-function",
    );
  });

  it("scopes duplicate declarations by namespace, type, and enclosing callable", () => {
    const structure = analyzeTypeScriptSource("x.ts", `
      namespace A {
        class C { m() {} }
        function first() { function local() {} return local; }
        function second() { function local() {} return local; }
      }
      namespace B { class C { m() {} } }
    `).sourceStructure;
    for (const [name, count] of [["C", 2], ["m", 2], ["local", 2]] as const) {
      const ids = [...structure.types, ...structure.callables]
        .filter((item) => item.name === name)
        .map(({ id }) => id);
      expect(ids).toHaveLength(count);
      expect(new Set(ids).size).toBe(count);
    }
  });

  it("normalizes TypeScript display names to safe bounded NFC", () => {
    const long = `Cafe\u0301${"x".repeat(400)}`;
    const structure = analyzeTypeScriptSource("x.ts", `const ${long} = () => 1;`).sourceStructure;
    const name = structure.callables[0]!.name;
    expect(name).toBe(name.normalize("NFC"));
    expect(name.length).toBeLessThanOrEqual(256);
    expect(name).not.toMatch(/[\p{Cc}\p{Cf}\p{Cs}]/u);
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
    expect(detail.nodes.map(({ category, kind, name }) => [category, kind, name])).toEqual([["type", "class", "C"], ["callable", "method", "m"]]);
    expect(detail.printable.state).toBe("not-printable");
    expect(() => validateCityModel({ schemaVersion: "1.0", generator: { name: "code-city", version: "test" }, repositories: [{ id: "r", name: "R" }], solutions: [], modules: [{ id: "m", repositoryId: "r", kind: "unassigned", name: "M", path: ".", solutionIds: [] }], semanticGroups: [{ id: "low", label: "Low", color: "#000000", priority: 0 }], districts: [{ id: "d", repositoryId: "r", moduleId: "m", name: "D", path: ".", position: { x: 0, y: 0, z: 0 }, size: { x: 2, y: 1, z: 2 } }], buildings: [building], dependencies: [], bounds: { x: 2, y: 2, z: 2 } })).not.toThrow();
  });

  it("keeps source-structure v1 models from before declaration provenance compatible", () => {
    const structure = analyzeTypeScriptSource("x.ts", "class C { m() {} }").sourceStructure;
    const legacyStructure = {
      ...structure,
      types: structure.types.map(({ provenance: _provenance, ...item }) => item),
      callables: structure.callables.map(({ provenance: _provenance, ...item }) => item),
    };
    const building = {
      id: "b", repositoryId: "r", moduleId: "m", districtId: "d", name: "x.ts", path: "x.ts", language: "typescript" as const,
      metrics: { sloc: 1, decisionLoad: 0, maximumComplexity: 1, executableUnitCount: 1 },
      sourceLocation: { startLine: 1 as const, endLine: 1 }, sourceStructure: legacyStructure,
      risk: "low" as const, semanticGroupId: "low", position: { x: 0, y: 0, z: 0 }, size: { x: 1, y: 1, z: 1 },
    };
    expect(() => validateCityModel({ schemaVersion: "1.0", generator: { name: "code-city", version: "test" }, repositories: [{ id: "r", name: "R" }], solutions: [], modules: [{ id: "m", repositoryId: "r", kind: "unassigned", name: "M", path: ".", solutionIds: [] }], semanticGroups: [{ id: "low", label: "Low", color: "#000000", priority: 0 }], districts: [{ id: "d", repositoryId: "r", moduleId: "m", name: "D", path: ".", position: { x: 0, y: 0, z: 0 }, size: { x: 2, y: 1, z: 2 } }], buildings: [building], dependencies: [], bounds: { x: 2, y: 2, z: 2 } })).not.toThrow();
  });

  it("keeps explicit unavailability authoritative and exposes a terminal cap", () => {
    const base = {
      id: "b", repositoryId: "r", moduleId: "m", districtId: "d", name: "x.ts", path: "x.ts", language: "typescript" as const,
      metrics: { sloc: 1, decisionLoad: 0, maximumComplexity: 1, executableUnitCount: 1 },
      units: [{ name: "legacy", line: 1, complexity: 1 }], sourceLocation: { startLine: 1, endLine: 1 },
      risk: "low" as const, semanticGroupId: "low", position: { x: 0, y: 0, z: 0 }, size: { x: 1, y: 1, z: 1 },
    };
    expect(projectFineDetail({ ...base, sourceStructure: { version: "codecity.source-structure/1", availability: "unavailable", types: [], callables: [], relations: [], unavailable: ["Analyzer explicitly unavailable."] } }).state).toBe("unavailable");
    const callables = Array.from({ length: 250 }, (_, index) => ({ id: `c-${index}`, name: `m${index}`, kind: "method" as const, range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 }, provenance: "syntax" as const, complexity: 1 }));
    const capped = projectFineDetail({ ...base, sourceStructure: { version: "codecity.source-structure/1", availability: "available", types: [], callables, relations: [], unavailable: [] } }, 200);
    expect(capped).toMatchObject({ state: "capped", canLoadMore: false, omittedCount: 50 });
    expect(capped.terminalReason).toContain("capped at 200");
  });

  it("validates a 10k type chain linearly and checks cancellation cooperatively", () => {
    const types = Array.from({ length: 10_000 }, (_, index) => ({ id: `t${index}`, name: `T${index}`, kind: "class" as const, range: { startLine: index + 1, startColumn: 1, endLine: index + 1, endColumn: 1 }, provenance: "syntax" as const, ...(index === 0 ? {} : { parentTypeId: `t${index - 1}` }) }));
    const model = { schemaVersion: "1.0", generator: { name: "code-city", version: "test" }, repositories: [{ id: "r", name: "R" }], solutions: [], modules: [{ id: "m", repositoryId: "r", kind: "unassigned", name: "M", path: ".", solutionIds: [] }], semanticGroups: [{ id: "low", label: "Low", color: "#000000", priority: 0 }], districts: [{ id: "d", repositoryId: "r", moduleId: "m", name: "D", path: ".", position: { x: 0, y: 0, z: 0 }, size: { x: 2, y: 1, z: 2 } }], buildings: [{ id: "b", repositoryId: "r", moduleId: "m", districtId: "d", name: "x.ts", path: "x.ts", language: "typescript", metrics: { sloc: 10_000, decisionLoad: 0, maximumComplexity: 1, executableUnitCount: 0 }, sourceLocation: { startLine: 1, endLine: 10_000 }, sourceStructure: { version: "codecity.source-structure/1", availability: "available", types, callables: [], relations: [], unavailable: [] }, risk: "low", semanticGroupId: "low", position: { x: 0, y: 0, z: 0 }, size: { x: 1, y: 1, z: 1 } }], dependencies: [], bounds: { x: 2, y: 2, z: 2 } };
    expect(() => validateCityModel(model)).not.toThrow();
    const cancelled = new Error("cancel ancestry validation");
    let checks = 0;
    expect(() => validateCityModel(model, { checkpoint: () => { if (++checks === 8) throw cancelled; } })).toThrow(cancelled);
  });
});
