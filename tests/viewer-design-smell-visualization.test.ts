import { describe, expect, it } from "vitest";

import {
  createDesignSmellBuildingVisualization,
  DESIGN_SMELL_BUILDING_COLORS,
  DESIGN_SMELL_BUILDING_LEGEND,
  designSmellBuildingDiagnostics,
} from "../apps/viewer/src/design-smell-visualization.js";
import type {
  DesignSmellFinding,
  DesignSmellSeverity,
} from "../packages/core/src/design-smells.js";

function finding(
  id: string,
  buildingId: string,
  severity: DesignSmellSeverity,
): DesignSmellFinding {
  return {
    id,
    buildingId,
    language: "typescript",
    ruleId: "oversized-file",
    ruleName: "Oversized file",
    ruleVersion: "1",
    severity,
    evidence: {
      kind: "metric",
      label: "Source lines",
      value: 500,
      threshold: 300,
    },
    suppressed: false,
  };
}

describe("design-smell building visualization", () => {
  it("colors every building and treats gray as no visible finding", () => {
    const visualization = createDesignSmellBuildingVisualization(
      ["a", "b", "b"],
      [],
    );

    expect([...visualization.colorsByBuildingId]).toEqual([
      ["a", DESIGN_SMELL_BUILDING_COLORS.unaffected],
      ["b", DESIGN_SMELL_BUILDING_COLORS.unaffected],
    ]);
    expect(visualization.diagnostics).toEqual({
      requestedFindings: 0,
      validFindings: 0,
      buildingCount: 2,
      affectedBuildings: 0,
      severityBuildings: {
        moderate: 0,
        high: 0,
        critical: 0,
      },
    });
    expect(DESIGN_SMELL_BUILDING_LEGEND.at(-1)?.label).toContain(
      "No visible finding",
    );
  });

  it("uses the exact severity palette", () => {
    const visualization = createDesignSmellBuildingVisualization(
      ["moderate", "high", "critical", "none"],
      [
        finding("m", "moderate", "moderate"),
        finding("h", "high", "high"),
        finding("c", "critical", "critical"),
      ],
    );

    expect(Object.fromEntries(visualization.colorsByBuildingId)).toEqual({
      moderate: DESIGN_SMELL_BUILDING_COLORS.moderate,
      high: DESIGN_SMELL_BUILDING_COLORS.high,
      critical: DESIGN_SMELL_BUILDING_COLORS.critical,
      none: DESIGN_SMELL_BUILDING_COLORS.unaffected,
    });
    expect(visualization.diagnostics.severityBuildings).toEqual({
      moderate: 1,
      high: 1,
      critical: 1,
    });
  });

  it("chooses the highest severity independent of finding order", () => {
    const findings = [
      finding("moderate", "building", "moderate"),
      finding("critical", "building", "critical"),
      finding("high", "building", "high"),
    ];

    const forward = createDesignSmellBuildingVisualization(
      ["building"],
      findings,
    );
    const reverse = createDesignSmellBuildingVisualization(
      ["building"],
      findings.toReversed(),
    );

    expect([...reverse.colorsByBuildingId]).toEqual([
      ...forward.colorsByBuildingId,
    ]);
    expect(forward.colorsByBuildingId.get("building")).toBe(
      DESIGN_SMELL_BUILDING_COLORS.critical,
    );
    expect(forward.findingSummaryByBuildingId.get("building")).toEqual({
      count: 3,
      highestSeverity: "critical",
    });
    expect(forward.diagnostics.affectedBuildings).toBe(1);
  });

  it("ignores unknown buildings and does not inflate valid duplicate IDs", () => {
    const duplicate = finding("same", "known", "moderate");
    const visualization = createDesignSmellBuildingVisualization(
      ["known"],
      [
        duplicate,
        duplicate,
        finding("same", "known", "critical"),
        finding("unknown", "missing", "critical"),
      ],
    );

    expect(visualization.colorsByBuildingId.get("known")).toBe(
      DESIGN_SMELL_BUILDING_COLORS.critical,
    );
    expect(visualization.diagnostics).toMatchObject({
      requestedFindings: 4,
      validFindings: 1,
      affectedBuildings: 1,
    });
    expect(visualization.findingSummaryByBuildingId.get("known")).toEqual({
      count: 1,
      highestSeverity: "critical",
    });
  });

  it("reports coloring only while Findings is active", () => {
    const visualization = createDesignSmellBuildingVisualization(
      ["a", "b"],
      [finding("a", "a", "high")],
    );

    expect(designSmellBuildingDiagnostics(visualization, false)).toMatchObject({
      active: false,
      coloredBuildings: 0,
      affectedBuildings: 1,
    });
    expect(designSmellBuildingDiagnostics(visualization, true)).toMatchObject({
      active: true,
      coloredBuildings: 2,
      affectedBuildings: 1,
    });
  });
});
