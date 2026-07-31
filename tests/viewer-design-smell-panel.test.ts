import { describe, expect, it } from "vitest";

import {
  DESIGN_SMELL_PAGE_SIZE,
  designSmellFindingButtonText,
  formatDesignSmellThresholds,
} from "../apps/viewer/src/design-smell-panel.js";
import {
  DESIGN_SMELL_PROTOCOL_VERSION,
  evaluateDesignSmells,
} from "../packages/core/src/index.js";
import { DEMO_MODEL } from "../apps/viewer/src/demo-model.js";

describe("design smell panel presentation", () => {
  it("shows every active language threshold exactly", () => {
    expect(
      formatDesignSmellThresholds({
        csharp: 15,
        typescript: 12,
        javascript: 9,
      }),
    ).toBe("C# 15; TypeScript 12; JavaScript 9");
    expect(DESIGN_SMELL_PAGE_SIZE).toBe(100);
  });

  it("renders canonical Unicode warning and separators without mojibake", () => {
    const building = DEMO_MODEL.buildings[0]!;
    const model = {
      ...DEMO_MODEL,
      buildings: [
        {
          ...building,
          language: "typescript" as const,
          metrics: { ...building.metrics, sloc: 500 },
        },
      ],
      dependencies: [],
    };
    const finding = evaluateDesignSmells(model).findings.find(
      ({ ruleId }) => ruleId === "oversized-file",
    )!;

    const text = designSmellFindingButtonText(finding, building);

    expect(text).toContain("⚠ Oversized file");
    expect(text).toContain(building.name);
    expect(text).toContain(building.path);
    expect(text).not.toMatch(/â|Â|Ã/u);
    expect(finding.ruleVersion).toBe("1");
    expect(DESIGN_SMELL_PROTOCOL_VERSION).toBe(
      "codecity.design-smells/1",
    );
  });
});
