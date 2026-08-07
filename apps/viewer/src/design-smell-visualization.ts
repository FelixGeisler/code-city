import type {
  DesignSmellFinding,
  DesignSmellSeverity,
} from "../../../packages/core/src/design-smells.js";
import type { SemanticGroup } from "../../../packages/core/src/model.js";

export const DESIGN_SMELL_BUILDING_COLORS = Object.freeze({
  critical: "#f43f5e",
  high: "#fb923c",
  moderate: "#facc15",
  unaffected: "#64748b",
} satisfies Record<DesignSmellSeverity | "unaffected", string>);

export const DESIGN_SMELL_BUILDING_LEGEND: readonly SemanticGroup[] =
  Object.freeze([
    Object.freeze({
      id: "design-smell-critical",
      label: "Critical finding (at least 2× threshold)",
      color: DESIGN_SMELL_BUILDING_COLORS.critical,
      priority: 104,
    }),
    Object.freeze({
      id: "design-smell-high",
      label: "High finding (at least 1.35× threshold)",
      color: DESIGN_SMELL_BUILDING_COLORS.high,
      priority: 103,
    }),
    Object.freeze({
      id: "design-smell-moderate",
      label: "Moderate finding (threshold reached)",
      color: DESIGN_SMELL_BUILDING_COLORS.moderate,
      priority: 102,
    }),
    Object.freeze({
      id: "design-smell-unaffected",
      label: "No visible finding under current rules and filters",
      color: DESIGN_SMELL_BUILDING_COLORS.unaffected,
      priority: 101,
    }),
  ]);

export interface DesignSmellBuildingDiagnostics {
  readonly active: boolean;
  readonly requestedFindings: number;
  readonly validFindings: number;
  readonly buildingCount: number;
  readonly affectedBuildings: number;
  readonly coloredBuildings: number;
  readonly severityBuildings: Readonly<
    Record<DesignSmellSeverity, number>
  >;
}

export interface DesignSmellBuildingVisualization {
  readonly colorsByBuildingId: ReadonlyMap<string, string>;
  readonly findingSummaryByBuildingId: ReadonlyMap<
    string,
    DesignSmellBuildingFindingSummary
  >;
  readonly diagnostics: Omit<
    DesignSmellBuildingDiagnostics,
    "active" | "coloredBuildings"
  >;
}

export interface DesignSmellBuildingFindingSummary {
  readonly count: number;
  readonly highestSeverity: DesignSmellSeverity;
}

const SEVERITY_RANK = Object.freeze({
  moderate: 0,
  high: 1,
  critical: 2,
} satisfies Record<DesignSmellSeverity, number>);

/**
 * Creates a complete, deterministic Findings color map. Gray means only that
 * no finding is visible under the current rules and filters; it is not a
 * quality guarantee.
 */
export function createDesignSmellBuildingVisualization(
  buildingIds: Iterable<string>,
  findings: readonly DesignSmellFinding[],
): DesignSmellBuildingVisualization {
  const colorsByBuildingId = new Map<string, string>();
  for (const buildingId of buildingIds) {
    if (!colorsByBuildingId.has(buildingId)) {
      colorsByBuildingId.set(
        buildingId,
        DESIGN_SMELL_BUILDING_COLORS.unaffected,
      );
    }
  }

  const findingIdsByBuildingId = new Map<string, Set<string>>();
  const severityByBuildingId = new Map<string, DesignSmellSeverity>();
  const validFindingIds = new Set<string>();
  for (const finding of findings) {
    if (!colorsByBuildingId.has(finding.buildingId)) continue;
    validFindingIds.add(finding.id);
    const buildingFindingIds = findingIdsByBuildingId.get(
      finding.buildingId,
    );
    if (buildingFindingIds === undefined) {
      findingIdsByBuildingId.set(
        finding.buildingId,
        new Set([finding.id]),
      );
    } else {
      buildingFindingIds.add(finding.id);
    }
    const existing = severityByBuildingId.get(finding.buildingId);
    if (
      existing === undefined ||
      SEVERITY_RANK[finding.severity] > SEVERITY_RANK[existing]
    ) {
      severityByBuildingId.set(finding.buildingId, finding.severity);
    }
  }

  const severityBuildings: Record<DesignSmellSeverity, number> = {
    moderate: 0,
    high: 0,
    critical: 0,
  };
  const findingSummaryByBuildingId = new Map<
    string,
    DesignSmellBuildingFindingSummary
  >();
  for (const [buildingId, severity] of severityByBuildingId) {
    colorsByBuildingId.set(
      buildingId,
      DESIGN_SMELL_BUILDING_COLORS[severity],
    );
    severityBuildings[severity] += 1;
    findingSummaryByBuildingId.set(
      buildingId,
      Object.freeze({
        count: findingIdsByBuildingId.get(buildingId)!.size,
        highestSeverity: severity,
      }),
    );
  }

  return Object.freeze({
    colorsByBuildingId,
    findingSummaryByBuildingId,
    diagnostics: Object.freeze({
      requestedFindings: findings.length,
      validFindings: validFindingIds.size,
      buildingCount: colorsByBuildingId.size,
      affectedBuildings: severityByBuildingId.size,
      severityBuildings: Object.freeze(severityBuildings),
    }),
  });
}

export function designSmellBuildingDiagnostics(
  visualization: DesignSmellBuildingVisualization,
  active: boolean,
): DesignSmellBuildingDiagnostics {
  return Object.freeze({
    active,
    ...visualization.diagnostics,
    coloredBuildings: active
      ? visualization.diagnostics.buildingCount
      : 0,
  });
}
