import { describe, expect, it } from "vitest";
import {
  ADVANCED_SELECTION_SET_VERSION,
  EMPTY_ADVANCED_SELECTION,
  clearAdvancedSelection,
  createAdvancedSelectionSet,
  replaceAdvancedSelection,
  retainAdvancedSelection,
  selectAdvancedBuilding,
  setAdvancedSelectionOverlay,
  validateAdvancedSelectionSet,
} from "../apps/viewer/src/advanced-selection.js";

describe("viewer advanced selection", () => {
  const ordered = ["a", "b", "c", "d", "e"];

  it("supports replacement, additive toggle, and anchored ranges", () => {
    const selected = selectAdvancedBuilding(
      EMPTY_ADVANCED_SELECTION,
      "b",
    );
    const additive = selectAdvancedBuilding(selected, "d", {
      additive: true,
    });
    const ranged = selectAdvancedBuilding(additive, "e", {
      range: true,
      orderedBuildingIds: ordered,
    });

    expect(selected).toMatchObject({
      buildingIds: ["b"],
      primaryBuildingId: "b",
      anchorBuildingId: "b",
    });
    expect(additive).toMatchObject({
      buildingIds: ["b", "d"],
      primaryBuildingId: "d",
      anchorBuildingId: "d",
    });
    expect(ranged).toMatchObject({
      buildingIds: ["d", "e"],
      primaryBuildingId: "e",
      anchorBuildingId: "d",
    });
    expect(
      selectAdvancedBuilding(additive, "e", {
        additive: true,
        range: true,
        orderedBuildingIds: ordered,
      }).buildingIds,
    ).toEqual(["b", "d", "e"]);
  });

  it("keeps primary state coherent while toggling and clearing", () => {
    const selected = replaceAdvancedSelection(
      EMPTY_ADVANCED_SELECTION,
      ["a", "b", "c"],
      "b",
    );
    const toggled = selectAdvancedBuilding(selected, "b", {
      additive: true,
    });
    expect(toggled).toMatchObject({
      buildingIds: ["a", "c"],
      primaryBuildingId: "c",
    });
    expect(clearAdvancedSelection(toggled)).toEqual({
      buildingIds: [],
      primaryBuildingId: null,
      anchorBuildingId: null,
      overlayVisible: true,
    });
  });

  it("retains only identities present in a new model", () => {
    const selected = replaceAdvancedSelection(
      EMPTY_ADVANCED_SELECTION,
      ["a", "b", "c"],
      "b",
    );
    expect(
      retainAdvancedSelection(selected, {
        buildings: [{ id: "a" }, { id: "c" }] as never,
      }),
    ).toMatchObject({
      buildingIds: ["a", "c"],
      primaryBuildingId: "a",
      anchorBuildingId: "a",
    });
  });

  it("toggles the overlay without changing identities", () => {
    const selected = replaceAdvancedSelection(
      EMPTY_ADVANCED_SELECTION,
      ["a", "b"],
    );
    expect(setAdvancedSelectionOverlay(selected, false)).toEqual({
      ...selected,
      overlayVisible: false,
    });
  });

  it("creates and validates bounded versioned selection sets", () => {
    const selectionSet = createAdvancedSelectionSet(" Review set ", [
      "a",
      "a",
      "b",
    ]);
    expect(selectionSet).toEqual({
      version: ADVANCED_SELECTION_SET_VERSION,
      name: "Review set",
      modelSchemaVersion: "1.0",
      buildingIds: ["a", "b"],
    });
    expect(validateAdvancedSelectionSet(selectionSet)).toEqual(selectionSet);
    expect(() =>
      createAdvancedSelectionSet(
        "Too many",
        Array.from({ length: 501 }, (_, index) => `building:${index}`),
      ),
    ).toThrow(/at most 500/u);
  });
});
