import type { RiskBand, SemanticGroup } from "./model.js";

export const DEFAULT_SEMANTIC_GROUPS = Object.freeze([
  {
    id: "base",
    label: "Base",
    color: "#6B7280",
    priority: 100,
  },
  {
    id: "identity",
    label: "Identity",
    color: "#F8FAFC",
    priority: 95,
    mergeInto: "base",
  },
  {
    id: "risk-very-high",
    label: "Very high risk",
    color: "#DC2626",
    priority: 90,
    mergeInto: "base",
  },
  {
    id: "risk-high",
    label: "High risk",
    color: "#F97316",
    priority: 80,
    mergeInto: "risk-very-high",
  },
  {
    id: "risk-moderate",
    label: "Moderate risk",
    color: "#EAB308",
    priority: 70,
    mergeInto: "risk-high",
  },
  {
    id: "risk-low",
    label: "Low risk",
    color: "#22C55E",
    priority: 60,
    mergeInto: "risk-moderate",
  },
  {
    id: "routes",
    label: "Dependency routes",
    color: "#2563EB",
    priority: 50,
    mergeInto: "base",
  },
] as const satisfies readonly SemanticGroup[]);

export function semanticGroupForRisk(risk: RiskBand): string {
  return `risk-${risk}`;
}
