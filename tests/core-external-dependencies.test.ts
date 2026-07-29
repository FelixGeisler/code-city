import { describe, expect, it } from "vitest";

import {
  DEFAULT_SEMANTIC_GROUPS,
  EXTERNAL_DEPENDENCY_BOX_SIZE,
  EXTERNAL_DEPENDENCY_COLOR,
  EXTERNAL_DEPENDENCY_CONSUMER_LIMIT,
  EXTERNAL_DEPENDENCY_NODE_LIMIT,
  layoutExternalDependencies,
  normalizeExternalDependencyTarget,
  resolveExternalDependencyNode,
  selectExternalDependencies,
  type CityBase,
  type CityDependency,
} from "../packages/core/src/index.js";

describe("external dependency policy", () => {
  it("normalizes only surrounding whitespace and Unicode composition", () => {
    expect(normalizeExternalDependencyTarget("  e\u0301xample  ")).toBe(
      "\u00e9xample",
    );
    expect(normalizeExternalDependencyTarget("Package")).toBe("Package");
    expect(normalizeExternalDependencyTarget("package")).toBe("package");
    expect(() => normalizeExternalDependencyTarget(" \t\r\n ")).toThrow(
      /External dependency target must not be empty/u,
    );
    expect(() =>
      normalizeExternalDependencyTarget(undefined as unknown as string),
    ).toThrow(/External dependency target must not be empty/u);
  });

  it("aggregates normalized targets, kinds, and bounded consumers", () => {
    const dependencies = [
      externalDependency("a", "  e\u0301xample ", 3, {
        sourceId: "consumer-b",
        kind: "typescript-import",
      }),
      externalDependency("b", "\u00e9xample", 4, {
        sourceId: "consumer-a",
        kind: "package-reference",
      }),
      ...Array.from(
        { length: EXTERNAL_DEPENDENCY_CONSUMER_LIMIT },
        (_, index) =>
          externalDependency(`extra-${index}`, "\u00e9xample", 1, {
            sourceId: `consumer-${String(index + 2).padStart(2, "0")}`,
            kind: "package-reference",
          }),
      ),
    ];

    const selection = selectExternalDependencies(dependencies);
    expect(selection.nodes).toHaveLength(1);
    expect(selection.nodes[0]).toMatchObject({
      kind: "external",
      normalizedTarget: "\u00e9xample",
      label: "\u00e9xample",
      weight: 15,
      targetCount: 1,
      edgeCount: 10,
      kinds: [
        { kind: "typescript-import", edgeCount: 1, weight: 3 },
        { kind: "package-reference", edgeCount: 9, weight: 12 },
      ],
      hiddenConsumerCount: 2,
      hiddenConsumerWeight: 2,
    });
    expect(selection.nodes[0]!.consumers).toHaveLength(
      EXTERNAL_DEPENDENCY_CONSUMER_LIMIT,
    );
    expect(selection.nodes[0]!.consumers.slice(0, 2)).toEqual([
      { sourceId: "consumer-a", edgeCount: 1, weight: 4 },
      { sourceId: "consumer-b", edgeCount: 1, weight: 3 },
    ]);
  });

  it("keeps twelve targets, otherwise selects the strongest eleven plus overflow", () => {
    const twelve = Array.from(
      { length: EXTERNAL_DEPENDENCY_NODE_LIMIT },
      (_, index) =>
        externalDependency(
          `twelve-${index}`,
          `target-${String(index).padStart(2, "0")}`,
          1,
        ),
    );
    expect(selectExternalDependencies(twelve).nodes).toHaveLength(12);

    const dependencies = [
      ...Array.from({ length: 11 }, (_, index) =>
        externalDependency(
          `strong-${index}`,
          `strong-${String(index).padStart(2, "0")}`,
          10,
        ),
      ),
      externalDependency("weak-b", "weak-b", 2, {
        sourceId: "shared",
        kind: "project-reference",
      }),
      externalDependency("weak-a", "weak-a", 2, {
        sourceId: "shared",
        kind: "project-reference",
      }),
    ];

    const selection = selectExternalDependencies(dependencies);
    expect(selection.nodes).toHaveLength(12);
    expect(selection.nodes.slice(0, 11).map(({ label }) => label)).toEqual(
      Array.from(
        { length: 11 },
        (_, index) => `strong-${String(index).padStart(2, "0")}`,
      ),
    );
    expect(selection.nodes.at(-1)).toMatchObject({
      id: "external-overflow\0v1",
      kind: "external-overflow",
      label: "Others",
      targetCount: 2,
      edgeCount: 2,
      weight: 4,
      consumers: [{ sourceId: "shared", edgeCount: 2, weight: 4 }],
    });
    expect(selection.assignments.get("weak-a")).toBe(
      "external-overflow\0v1",
    );
    expect(selection.assignments.get("weak-b")).toBe(
      "external-overflow\0v1",
    );
    expect(resolveExternalDependencyNode(selection, " weak-a ")).toBe(
      selection.nodes.at(-1),
    );
  });

  it("uses ordinal UTF-16 target ordering and keeps real Others distinct", () => {
    const dependencies = [
      externalDependency("emoji", "\ud83d\ude00", 1),
      externalDependency("bmp", "\ue000", 1),
      externalDependency("upper", "Others", 1),
      externalDependency("lower", "others", 1),
    ];
    const selection = selectExternalDependencies(dependencies);

    expect(selection.nodes.map(({ label }) => label)).toEqual([
      "Others",
      "others",
      "\ud83d\ude00",
      "\ue000",
    ]);
    expect(selection.nodes[0]).toMatchObject({
      kind: "external",
      id: "external\0Others",
      normalizedTarget: "Others",
    });
  });

  it("is deterministic across input order and safely ignores malformed records", () => {
    const valid = [
      externalDependency("b", "B", 2),
      externalDependency("a", "A", 3),
      externalDependency("a-2", "A", 4, {
        sourceId: "source-z",
        kind: "project-reference",
      }),
    ];
    const malformed: readonly unknown[] = [
      null,
      {},
      { externalTarget: " " },
      { externalTarget: "X", sourceId: "", kind: "package-reference", weight: 1 },
      {
        externalTarget: "X",
        sourceId: "source",
        kind: "unknown",
        weight: 1,
      },
      {
        externalTarget: "X",
        targetId: "also-internal",
        sourceId: "source",
        kind: "package-reference",
        weight: 1,
      },
      {
        externalTarget: "X",
        sourceId: "source",
        kind: "package-reference",
        weight: Number.POSITIVE_INFINITY,
      },
    ];

    const first = selectExternalDependencies([...valid, ...malformed]);
    const second = selectExternalDependencies([
      ...malformed.toReversed(),
      ...valid.toReversed(),
    ]);
    expect([...second.assignments]).toEqual([...first.assignments]);
    expect(second.nodes).toEqual(first.nodes);
    expect(first.ignoredDependencyCount).toBe(5);
    expect(resolveExternalDependencyNode(first, "missing")).toBeUndefined();
    expect(resolveExternalDependencyNode(first, null)).toBeUndefined();
    expect(
      selectExternalDependencies(null as unknown as readonly unknown[]),
    ).toEqual({
      nodes: [],
      assignments: new Map(),
      ignoredDependencyCount: 0,
    });
  });

  it("places fixed boxes by the exact rear-apron formula and derives a connected base", () => {
    const selection = selectExternalDependencies([
      externalDependency("b", "B", 1),
      externalDependency("a", "A", 1),
    ]);
    const base: CityBase = {
      id: "base",
      semanticGroupId: "base",
      position: { x: 10, y: 0.25, z: 4 },
      size: { x: 2, y: 0.5, z: 8 },
    };
    const snapshot = structuredClone(base);

    const layout = layoutExternalDependencies(selection, base);

    expect(base).toEqual(snapshot);
    expect(layout.nodes).toEqual([
      expect.objectContaining({
        label: "A",
        semanticGroupId: "external",
        position: { x: 10, y: 2, z: 10 },
        size: EXTERNAL_DEPENDENCY_BOX_SIZE,
      }),
      expect.objectContaining({
        label: "B",
        semanticGroupId: "external",
        position: { x: 10, y: 2, z: 13 },
        size: EXTERNAL_DEPENDENCY_BOX_SIZE,
      }),
    ]);
    expect(layout.base).toEqual({
      ...base,
      position: { x: 10, y: 0.25, z: 7.5 },
      size: { x: 6, y: 0.5, z: 15 },
    });
    expect(resolveExternalDependencyNode(layout, "A")).toBe(layout.nodes[0]);
  });

  it("fills apron rows by ordinal node order and leaves empty/invalid bases safe", () => {
    const selection = selectExternalDependencies([
      externalDependency("d", "D", 1),
      externalDependency("c", "C", 1),
      externalDependency("b", "B", 1),
      externalDependency("a", "A", 1),
    ]);
    const base: CityBase = {
      id: "base",
      semanticGroupId: "base",
      position: { x: 8, y: 0.5, z: 5 },
      size: { x: 16, y: 1, z: 10 },
    };
    const layout = layoutExternalDependencies(selection, base);

    expect(layout.nodes.map(({ label, position }) => [label, position])).toEqual([
      ["A", { x: 3, y: 2.5, z: 12 }],
      ["B", { x: 8, y: 2.5, z: 12 }],
      ["C", { x: 13, y: 2.5, z: 12 }],
      ["D", { x: 3, y: 2.5, z: 15 }],
    ]);
    expect(layout.base?.size).toEqual({ x: 16, y: 1, z: 17 });

    const noBase = layoutExternalDependencies(selection, undefined);
    expect(noBase.nodes).toEqual([]);
    expect(noBase.base).toBeUndefined();

    const empty = layoutExternalDependencies(
      selectExternalDependencies([]),
      base,
    );
    expect(empty.nodes).toEqual([]);
    expect(empty.base).toBe(base);
  });

  it("publishes the fixed external semantic role", () => {
    expect(
      DEFAULT_SEMANTIC_GROUPS.find(({ id }) => id === "external"),
    ).toMatchObject({
      label: "External dependencies",
      color: EXTERNAL_DEPENDENCY_COLOR,
      mergeInto: "base",
    });
  });
});

function externalDependency(
  id: string,
  externalTarget: string,
  weight: number,
  options: {
    readonly sourceId?: string;
    readonly kind?: CityDependency["kind"];
  } = {},
): CityDependency {
  return {
    id,
    repositoryId: "repo",
    sourceId: options.sourceId ?? `source-${id}`,
    externalTarget,
    kind: options.kind ?? "package-reference",
    weight,
  };
}
