import { describe, expect, it } from "vitest";

import { DEMO_MODEL } from "../apps/viewer/src/demo-model.js";
import {
  assignBuildingPrintCodes,
  assignDistrictPrintCodes,
  parsePrintLabelPolicy,
  PRINT_CODE_CAPACITY,
} from "../packages/core/src/index.js";

describe("deterministic print codes", () => {
  it("is independent of model array order and follows the documented keys", () => {
    const forward = assignBuildingPrintCodes(DEMO_MODEL.buildings);
    const reverse = assignBuildingPrintCodes(
      [...DEMO_MODEL.buildings].reverse(),
    );

    expect(reverse).toEqual(forward);
    expect(forward.map(({ code }) => code)).toEqual([
      "000",
      "001",
      "002",
      "003",
      "004",
    ]);
    expect(forward.map(({ id }) => id)).toEqual([
      "building:schema",
      "building:model",
      "building:demo-model",
      "building:main",
      "building:validation",
    ]);
  });

  it("covers the full 25,000-building model limit with three characters", () => {
    const template = DEMO_MODEL.buildings[0]!;
    const buildings = Array.from({ length: 25_000 }, (_, index) => ({
      ...template,
      id: `building:${index.toString().padStart(5, "0")}`,
      path: `src/file-${index.toString().padStart(5, "0")}.ts`,
    }));
    const codes = assignBuildingPrintCodes(buildings);

    expect(codes).toHaveLength(25_000);
    expect(codes[0]!.code).toBe("000");
    expect(codes.at(-1)!.code).toBe("JAF");
    expect(new Set(codes.map(({ code }) => code)).size).toBe(25_000);
    expect(PRINT_CODE_CAPACITY).toBe(46_656);
  });

  it("uses a separate deterministic D-prefixed district namespace", () => {
    const codes = assignDistrictPrintCodes(
      [...DEMO_MODEL.districts].reverse(),
    );

    expect(codes).toEqual([
      { id: "district:viewer", code: "D000" },
      { id: "district:core", code: "D001" },
    ]);
  });

  it("accepts only the shared auto and off policies", () => {
    expect(parsePrintLabelPolicy(undefined)).toBe("auto");
    expect(parsePrintLabelPolicy("auto")).toBe("auto");
    expect(parsePrintLabelPolicy("off")).toBe("off");
    expect(() => parsePrintLabelPolicy("yes")).toThrow(/auto.*off/u);
  });
});
