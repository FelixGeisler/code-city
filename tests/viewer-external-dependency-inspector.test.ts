import { describe, expect, it } from "vitest";

import type { ExternalDependencySelectionNode } from "../packages/core/src/external-dependencies.js";
import { presentExternalDependency } from "../apps/viewer/src/external-dependency-inspector.js";

describe("viewer external dependency inspector", () => {
  it("presents a full target and deterministic aggregate details", () => {
    const node = externalNode({
      label: "Package",
      normalizedTarget: "@scope/package",
      weight: 14,
      edgeCount: 5,
      kinds: [
        { kind: "typescript-import", edgeCount: 3, weight: 9 },
        { kind: "package-reference", edgeCount: 2, weight: 5 },
      ],
      consumers: [
        { sourceId: "building-b", edgeCount: 2, weight: 4 },
        { sourceId: "building-a", edgeCount: 2, weight: 8 },
        { sourceId: "building-c", edgeCount: 1, weight: 2 },
      ],
      hiddenConsumerCount: 4,
      hiddenConsumerWeight: 7,
    });

    const identities = new Map([
      [
        "building-a",
        { label: "alpha.ts", path: "src/feature/alpha.ts" },
      ],
      ["building-b", { label: "beta.ts", path: "src/beta.ts" }],
    ]);
    const presentation = presentExternalDependency(node, (sourceId) =>
      identities.get(sourceId),
    );

    expect(presentation).toEqual({
      kind: "external",
      label: "@scope/package",
      targetCount: 1,
      edgeCount: 5,
      totalWeight: 14,
      kindTotals: [
        { kind: "package-reference", edgeCount: 2, weight: 5 },
        { kind: "typescript-import", edgeCount: 3, weight: 9 },
      ],
      consumers: [
        {
          sourceId: "building-a",
          label: "alpha.ts",
          path: "src/feature/alpha.ts",
          edgeCount: 2,
          weight: 8,
        },
        {
          sourceId: "building-b",
          label: "beta.ts",
          path: "src/beta.ts",
          edgeCount: 2,
          weight: 4,
        },
        {
          sourceId: "building-c",
          label: "building-c",
          path: "building-c",
          edgeCount: 1,
          weight: 2,
        },
      ],
      hiddenConsumerCount: 4,
      hiddenConsumerWeight: 7,
    });
  });

  it("uses the overflow label and preserves its target count", () => {
    const presentation = presentExternalDependency({
      id: "external-overflow\u0000v1",
      kind: "external-overflow",
      label: "Others",
      weight: 31,
      targetCount: 6,
      edgeCount: 9,
      kinds: [
        { kind: "project-reference", edgeCount: 4, weight: 20 },
        { kind: "package-reference", edgeCount: 5, weight: 11 },
      ],
      consumers: [],
      hiddenConsumerCount: 9,
      hiddenConsumerWeight: 31,
    });

    expect(presentation.kind).toBe("external-overflow");
    expect(presentation.label).toBe("Others");
    expect(presentation.targetCount).toBe(6);
    expect(presentation.totalWeight).toBe(31);
    expect(presentation.hiddenConsumerCount).toBe(9);
    expect(presentation.hiddenConsumerWeight).toBe(31);
  });

  it("keeps target and consumer identity values as inert plain text", () => {
    const markup = "<img src=x onerror=alert(1)>";
    const presentation = presentExternalDependency(
      externalNode({
        label: markup,
        normalizedTarget: markup,
        consumers: [{ sourceId: "unsafe", edgeCount: 1, weight: 1 }],
      }),
      () => ({ label: "<script>bad()</script>", path: "src/<b>x</b>.ts" }),
    );

    expect(presentation.label).toBe(markup);
    expect(presentation.consumers[0]).toMatchObject({
      label: "<script>bad()</script>",
      path: "src/<b>x</b>.ts",
    });
    expect(JSON.stringify(presentation)).not.toContain("&lt;");
  });

  it("folds privacy-masked consumers into omitted totals", () => {
    const presentation = presentExternalDependency(
      externalNode({
        consumers: [
          { sourceId: "hidden-building", edgeCount: 2, weight: 5 },
          { sourceId: "visible-building", edgeCount: 1, weight: 3 },
        ],
        hiddenConsumerCount: 1,
        hiddenConsumerWeight: 2,
      }),
      (sourceId) =>
        sourceId === "hidden-building"
          ? null
          : { label: "visible.ts", path: "src/visible.ts" },
    );

    expect(presentation.consumers).toEqual([
      {
        sourceId: "visible-building",
        label: "visible.ts",
        path: "src/visible.ts",
        edgeCount: 1,
        weight: 3,
      },
    ]);
    expect(presentation.hiddenConsumerCount).toBe(2);
    expect(presentation.hiddenConsumerWeight).toBe(7);
    expect(JSON.stringify(presentation)).not.toContain("hidden-building");
  });

  it("does not mutate shared aggregate arrays while sorting rows", () => {
    const kinds = [
      { kind: "typescript-import" as const, edgeCount: 1, weight: 1 },
      { kind: "package-reference" as const, edgeCount: 1, weight: 1 },
    ];
    const consumers = [
      { sourceId: "z", edgeCount: 1, weight: 1 },
      { sourceId: "a", edgeCount: 1, weight: 1 },
    ];
    const node = externalNode({ kinds, consumers });

    const presentation = presentExternalDependency(node);

    expect(kinds.map(({ kind }) => kind)).toEqual([
      "typescript-import",
      "package-reference",
    ]);
    expect(consumers.map(({ sourceId }) => sourceId)).toEqual(["z", "a"]);
    expect(presentation.consumers.map(({ sourceId }) => sourceId)).toEqual([
      "a",
      "z",
    ]);
  });
});

function externalNode(
  overrides: Partial<
    Extract<ExternalDependencySelectionNode, { kind: "external" }>
  > = {},
): Extract<ExternalDependencySelectionNode, { kind: "external" }> {
  return {
    id: "external\u0000rxjs",
    kind: "external",
    normalizedTarget: "rxjs",
    label: "rxjs",
    weight: 1,
    targetCount: 1,
    edgeCount: 1,
    kinds: [{ kind: "typescript-import", edgeCount: 1, weight: 1 }],
    consumers: [{ sourceId: "building-a", edgeCount: 1, weight: 1 }],
    hiddenConsumerCount: 0,
    hiddenConsumerWeight: 0,
    ...overrides,
  };
}
