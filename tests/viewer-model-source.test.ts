import { describe, expect, it } from "vitest";

import {
  AutomaticModelLoadGate,
  assetRootFromResponseUrl,
  resolveAssetUrl,
  sortLegendGroups,
} from "../apps/viewer/src/model-source.js";
import type { SemanticGroup } from "../packages/core/src/model.js";

describe("viewer model sources", () => {
  it("aborts and invalidates superseded automatic loads", () => {
    const gate = new AutomaticModelLoadGate();
    const first = gate.begin();
    const second = gate.begin();

    expect(first.signal.aborted).toBe(true);
    expect(first.isCurrent()).toBe(false);
    expect(second.signal.aborted).toBe(false);
    expect(second.isCurrent()).toBe(true);

    gate.invalidate();
    expect(second.signal.aborted).toBe(true);
    expect(second.isCurrent()).toBe(false);
  });

  it("derives the asset root from the final response URL", () => {
    const root = assetRootFromResponseUrl(
      "https://cdn.example.test/releases/v1/city.json",
    );

    expect(root.href).toBe("https://cdn.example.test/releases/v1/");
    expect(resolveAssetUrl("assets/logo.svg", root).href).toBe(
      "https://cdn.example.test/releases/v1/assets/logo.svg",
    );
  });

  it.each([
    "../logo.svg",
    "%2e%2e/logo.svg",
    "assets%2flogo.svg",
  ])("does not resolve an unsafe asset reference %s", (relativePath) => {
    expect(() =>
      resolveAssetUrl(
        relativePath,
        new URL("https://example.test/models/"),
      ),
    ).toThrow(/root|traversal|normalized/u);
  });

  it("sorts equal legend labels deterministically by id", () => {
    const groups: SemanticGroup[] = [
      { id: "b", label: "Same", color: "#000", priority: 1 },
      { id: "a", label: "Same", color: "#111", priority: 1 },
      { id: "high", label: "Later", color: "#222", priority: 2 },
    ];

    expect(sortLegendGroups(groups).map(({ id }) => id)).toEqual([
      "high",
      "a",
      "b",
    ]);
  });
});
