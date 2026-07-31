import { describe, expect, it } from "vitest";

import { DEMO_MODEL } from "../apps/viewer/src/demo-model.js";
import {
  DEFAULT_DESIGN_SMELL_CONFIGURATION,
  DESIGN_SMELL_LIMITS,
  DESIGN_SMELL_PROTOCOL_VERSION,
  evaluateDesignSmells,
  validateDesignSmellConfiguration,
  validateDesignSmellEvaluation,
  validateDesignSmellSuppression,
  type CityModel,
} from "../packages/core/src/index.js";

function modelWithEvidence(): CityModel {
  const [first, second] = DEMO_MODEL.buildings;
  if (!first || !second) {
    throw new Error("Demo model needs two buildings.");
  }
  return {
    ...DEMO_MODEL,
    buildings: [
      {
        ...first,
        language: "typescript",
        metrics: { ...first.metrics, sloc: 900 },
        units: [
          {
            name: "hard",
            line: 12,
            endLine: 18,
            complexity: 21,
          },
        ],
      },
      { ...second, language: "typescript" },
    ],
    dependencies: [
      ...Array.from({ length: 10 }, (_, index) => ({
        id: `smell:outgoing:${index}`,
        repositoryId: first.repositoryId,
        sourceId: first.id,
        externalTarget: `library-${index}`,
        kind: "typescript-import" as const,
        weight: 1,
      })),
      {
        id: "smell:forward",
        repositoryId: first.repositoryId,
        sourceId: first.id,
        targetId: second.id,
        kind: "typescript-import",
        weight: 1,
      },
      {
        id: "smell:cycle",
        repositoryId: first.repositoryId,
        sourceId: second.id,
        targetId: first.id,
        kind: "typescript-import",
        weight: 1,
      },
    ],
  };
}

describe("design smell rules", () => {
  it("returns deterministic evidence and explicit unavailable facts", () => {
    const result = evaluateDesignSmells(modelWithEvidence());

    expect(result.protocolVersion).toBe(
      DESIGN_SMELL_PROTOCOL_VERSION,
    );
    expect(result.findings.map(({ ruleId }) => ruleId)).toEqual(
      expect.arrayContaining([
        "high-complexity-method",
        "oversized-file",
        "excessive-coupling",
        "dependency-cycle",
      ]),
    );
    expect(
      result.results.find(
        ({ rule }) => rule.id === "oversized-class",
      ),
    ).toMatchObject({
      availability: "unavailable",
      reason: expect.stringMatching(/per-class/iu),
    });
    expect(
      result.findings.find(
        ({ ruleId }) => ruleId === "high-complexity-method",
      ),
    ).toMatchObject({
      ruleVersion: "1",
      evidence: {
        subject: "hard",
        value: 21,
        threshold: 15,
        line: 12,
      },
    });
    expect(() => validateDesignSmellEvaluation(result)).not.toThrow();
  });

  it("does not attribute module-level C# edges to buildings", () => {
    const source = modelWithEvidence();
    const csharp = {
      ...source,
      buildings: source.buildings.map((building) => ({
        ...building,
        language: "csharp" as const,
      })),
    };

    const result = evaluateDesignSmells(csharp);

    for (const ruleId of [
      "excessive-coupling",
      "dependency-cycle",
    ] as const) {
      const rule = result.results.find(
        ({ rule }) => rule.id === ruleId,
      )!;
      expect(rule.languageAvailability.csharp).toMatchObject({
        availability: "unavailable",
        reason: expect.stringMatching(/module level/iu),
      });
      expect(rule.findings).toHaveLength(0);
    }
  });

  it("keeps false-positive suppression outside source data", () => {
    const model = modelWithEvidence();
    const first = model.buildings[0]!;
    const suppressed = evaluateDesignSmells(
      model,
      DEFAULT_DESIGN_SMELL_CONFIGURATION,
      [
        {
          protocolVersion: DESIGN_SMELL_PROTOCOL_VERSION,
          buildingId: first.id,
          ruleId: "oversized-file",
          reason: "Generated facade.",
        },
      ],
    );

    expect(
      suppressed.findings.find(
        ({ ruleId }) => ruleId === "oversized-file",
      )?.suppressed,
    ).toBe(true);
    expect(
      suppressed.visibleFindings.some(
        ({ ruleId }) => ruleId === "oversized-file",
      ),
    ).toBe(false);
    expect(model.buildings[0]!.metrics.sloc).toBe(900);
  });

  it("supports maximum model IDs and unit labels with bounded unique IDs", () => {
    const model = modelWithEvidence();
    const original = model.buildings[0]!;
    const maximumId = "b".repeat(256);
    const maximumUnitName = "u".repeat(256);
    const buildings = model.buildings.map((building, index) =>
      index === 0
        ? {
            ...building,
            id: maximumId,
            units: [
              {
                name: maximumUnitName,
                line: 12,
                complexity: 21,
              },
              {
                name: maximumUnitName,
                line: 12,
                complexity: 21,
              },
            ],
          }
        : building,
    );
    const dependencies = model.dependencies.map((dependency) => ({
      ...dependency,
      sourceId:
        dependency.sourceId === original.id
          ? maximumId
          : dependency.sourceId,
      ...(dependency.targetId === original.id
        ? { targetId: maximumId }
        : {}),
    }));

    const result = evaluateDesignSmells({
      ...model,
      buildings,
      dependencies,
    });
    const unitFindings = result.findings.filter(
      ({ ruleId }) => ruleId === "high-complexity-method",
    );

    expect(unitFindings).toHaveLength(2);
    expect(new Set(unitFindings.map(({ id }) => id)).size).toBe(2);
    expect(
      unitFindings.every(
        ({ id }) => id.length <= DESIGN_SMELL_LIMITS.findingIdCharacters,
      ),
    ).toBe(true);
    expect(unitFindings[0]!.evidence.subject).toHaveLength(256);
    expect(() => validateDesignSmellEvaluation(result)).not.toThrow();
  });

  it("keeps executable-unit finding IDs stable when units are reordered", () => {
    const model = modelWithEvidence();
    const building = model.buildings[0]!;
    const units = [
      {
        name: "alpha",
        line: 20,
        endLine: 25,
        complexity: 20,
      },
      {
        name: "beta",
        line: 40,
        endLine: 48,
        complexity: 24,
      },
    ] as const;
    const withUnits = (
      ordered: readonly (typeof units)[number][],
    ): CityModel => ({
      ...model,
      buildings: model.buildings.map((candidate) =>
        candidate.id === building.id
          ? { ...candidate, units: ordered }
          : candidate,
      ),
    });
    const unitIdentities = (candidate: CityModel) =>
      evaluateDesignSmells(candidate).findings
        .filter(
          ({ ruleId }) => ruleId === "high-complexity-method",
        )
        .map(({ id, evidence }) => ({
          id,
          subject: evidence.subject,
        }))
        .sort((left, right) =>
          left.subject! < right.subject!
            ? -1
            : left.subject! > right.subject!
              ? 1
              : 0,
        );

    expect(unitIdentities(withUnits(units))).toEqual(
      unitIdentities(withUnits([units[1], units[0]])),
    );
  });

  it("strictly rejects forged evaluation invariants", () => {
    const valid = evaluateDesignSmells(modelWithEvidence());
    const wrongCount = structuredClone(valid);
    (
      wrongCount.counts as Record<string, number>
    )["oversized-file"]! += 1;
    expect(() => validateDesignSmellEvaluation(wrongCount)).toThrow(
      /counts/iu,
    );

    const extraEvidence = structuredClone(valid);
    (
      extraEvidence.findings[0]!.evidence as unknown as Record<
        string,
        unknown
      >
    )["future"] = true;
    expect(() =>
      validateDesignSmellEvaluation(extraEvidence),
    ).toThrow(/evidence/iu);

    const wrongVisible = structuredClone(valid);
    (
      wrongVisible as unknown as Record<string, unknown>
    )["visibleFindings"] = [];
    expect(() =>
      validateDesignSmellEvaluation(wrongVisible),
    ).toThrow(/visible/iu);

    const duplicateId = structuredClone(valid);
    (
      duplicateId.findings[1] as unknown as Record<string, unknown>
    )["id"] = duplicateId.findings[0]!.id;
    expect(() =>
      validateDesignSmellEvaluation(duplicateId),
    ).toThrow();

    const wrongConfiguredThreshold = structuredClone(valid);
    const oversizedFile = wrongConfiguredThreshold.results.find(
      ({ rule }) => rule.id === "oversized-file",
    )!;
    (
      oversizedFile.threshold as Record<string, number>
    )["csharp"]! += 1;
    expect(() =>
      validateDesignSmellEvaluation(wrongConfiguredThreshold),
    ).toThrow(/thresholds.*configuration/iu);

    const wrongEvidenceThreshold = structuredClone(valid);
    const complexityResult = wrongEvidenceThreshold.results.find(
      ({ rule }) => rule.id === "high-complexity-method",
    )!;
    const complexityFinding = complexityResult.findings[0]!;
    (
      complexityFinding.evidence as unknown as Record<string, unknown>
    )["threshold"] = 16;
    (
      complexityFinding as unknown as Record<string, unknown>
    )["severity"] = "moderate";
    expect(() =>
      validateDesignSmellEvaluation(wrongEvidenceThreshold),
    ).toThrow(/threshold.*rule.*language/iu);
  });

  it("rejects unknown fields and values beyond shared model limits", () => {
    expect(() =>
      validateDesignSmellConfiguration({
        ...DEFAULT_DESIGN_SMELL_CONFIGURATION,
        future: true,
      }),
    ).toThrow(/schema/iu);
    expect(() =>
      validateDesignSmellSuppression({
        protocolVersion: DESIGN_SMELL_PROTOCOL_VERSION,
        buildingId: "a",
        ruleId: "oversized-file",
        reason: "x".repeat(257),
      }),
    ).toThrow(/invalid/iu);
    expect(() =>
      validateDesignSmellSuppression({
        protocolVersion: DESIGN_SMELL_PROTOCOL_VERSION,
        buildingId: "a".repeat(257),
        ruleId: "oversized-file",
        reason: "valid",
      }),
    ).toThrow(/invalid/iu);
  });
});
