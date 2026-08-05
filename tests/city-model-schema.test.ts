import { readFile } from "node:fs/promises";

import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import { DEMO_MODEL } from "../apps/viewer/src/demo-model.js";
import {
  calculateBuildingGeometry,
  DEFAULT_METRIC_MAPPING,
  DEFAULT_VERSIONED_METRIC_MAPPING,
  metricNormalizationForGeometry,
  validateCityModel,
} from "../packages/core/src/index.js";

const schemaPath = new URL(
  "../packages/core/schema/city-model.schema.json",
  import.meta.url,
);
const schema = JSON.parse(await readFile(schemaPath, "utf8")) as object;
const validateSchema = new Ajv2020({
  allErrors: true,
  strict: true,
}).compile(schema);

function errors(): string {
  return JSON.stringify(validateSchema.errors, null, 2);
}

describe("CityModel JSON Schema", () => {
  it("accepts the unchanged legacy 1.0 demo fixture", () => {
    expect(validateSchema(DEMO_MODEL), errors()).toBe(true);
    expect(validateCityModel(DEMO_MODEL)).toBe(DEMO_MODEL);
  });

  it("accepts the additive metric and dependency contract", () => {
    const template = DEMO_MODEL.buildings[0]!;
    const dependency = DEMO_MODEL.dependencies[0]!;
    const extended = {
      ...DEMO_MODEL,
      metricMapping: DEFAULT_METRIC_MAPPING,
      buildings: [
        {
          ...template,
          metricNormalization: metricNormalizationForGeometry(
            calculateBuildingGeometry(template.metrics),
          ),
        },
        ...DEMO_MODEL.buildings.slice(1),
      ],
      dependencies: [
        {
          ...dependency,
          resolution:
            dependency.targetId === undefined
              ? ("external" as const)
              : ("internal" as const),
        },
        ...DEMO_MODEL.dependencies.slice(1),
      ],
    };

    expect(validateSchema(extended), errors()).toBe(true);
    expect(validateCityModel(extended)).toBe(extended);
  });

  it("accepts only the canonical additive logo print-relief contract", () => {
    const logo = {
      relativePath: "assets/logo.svg",
      format: "svg" as const,
      printRelief: {
        version: "codecity.logo-relief/1" as const,
        width: 3,
        height: 2,
        mask: "qA",
      },
    };
    const extended = {
      ...DEMO_MODEL,
      identity: { ...DEMO_MODEL.identity!, logo },
    };

    expect(validateSchema(extended), errors()).toBe(true);
    expect(validateCityModel(extended)).toBe(extended);

    const unknownField = {
      ...extended,
      identity: {
        ...extended.identity,
        logo: {
          ...logo,
          printRelief: {
            ...logo.printRelief,
            sourcePath: "forbidden",
          },
        },
      },
    };
    expect(validateSchema(unknownField)).toBe(false);
    expect(() => validateCityModel(unknownField)).toThrow(
      /unknown or missing fields/u,
    );
  });

  it("accepts the bounded versioned metric-mapping definition", () => {
    const versioned = {
      ...DEMO_MODEL,
      metricMapping: DEFAULT_VERSIONED_METRIC_MAPPING,
    };

    expect(validateSchema(versioned), errors()).toBe(true);
    expect(validateCityModel(versioned)).toBe(versioned);

    const whitespaceColor = {
      ...versioned,
      metricMapping: {
        ...DEFAULT_VERSIONED_METRIC_MAPPING,
        channels: {
          ...DEFAULT_VERSIONED_METRIC_MAPPING.channels,
          color: {
            ...DEFAULT_VERSIONED_METRIC_MAPPING.channels.color,
            palette:
              DEFAULT_VERSIONED_METRIC_MAPPING.channels.color.palette.map(
                (entry, index) =>
                  index === 0
                    ? { ...entry, color: ` ${entry.color}` }
                    : entry,
              ),
          },
        },
      },
    };
    expect(validateSchema(whitespaceColor), errors()).toBe(false);
    expect(() => validateCityModel(whitespaceColor)).toThrow(
      /metricMapping\.channels\.color\.palette\[0\]\.color/u,
    );
  });

  it("accepts credential-free immutable source provenance and bounded line locations", () => {
    const repository = DEMO_MODEL.repositories[0]!;
    const building = DEMO_MODEL.buildings.find(
      ({ repositoryId }) => repositoryId === repository.id,
    )!;
    const endLine = Math.max(
      100,
      ...(building.units ?? []).map(
        ({ endLine, line }) => endLine ?? line,
      ),
    );
    const extended = {
      ...DEMO_MODEL,
      sourceProvenance: {
        version: "codecity.source-navigation/1" as const,
        repositories: [
          {
            repositoryId: repository.id,
            provider: "github" as const,
            revision: {
              kind: "commit" as const,
              value: "a".repeat(40),
            },
            repositoryUrl: "https://github.com/example/repository",
          },
        ],
      },
      buildings: DEMO_MODEL.buildings.map((candidate) =>
        candidate.id === building.id
          ? {
              ...candidate,
              sourceLocation: { startLine: 1, endLine },
            }
          : candidate,
      ),
    };
    expect(validateSchema(extended), errors()).toBe(true);
    expect(validateCityModel(extended)).toBe(extended);

    expect(() =>
      validateCityModel({
        ...extended,
        sourceProvenance: {
          ...extended.sourceProvenance,
          repositories: [
            {
              ...extended.sourceProvenance.repositories[0]!,
              repositoryUrl:
                "https://token@example.com/example/repository",
            },
          ],
        },
      }),
    ).toThrow(/credential/u);

    expect(() =>
      validateCityModel({
        ...extended,
        sourceProvenance: {
          ...extended.sourceProvenance,
          repositories: [
            {
              ...extended.sourceProvenance.repositories[0]!,
              repositoryUrl: "javascript:alert(1)",
            },
          ],
        },
      }),
    ).toThrow(/scheme or host/u);
  });

  it("keeps source-structure v1 compatible while validating typed relationships", () => {
    const template = DEMO_MODEL.buildings[0]!;
    const sourceStructure = {
      version: "codecity.source-structure/1" as const,
      availability: "available" as const,
      types: [{
        id: "type:C",
        name: "C",
        kind: "class" as const,
        range: { startLine: 1, startColumn: 1, endLine: 4, endColumn: 1 },
      }],
      callables: [{
        id: "callable:m",
        name: "m",
        kind: "method" as const,
        range: { startLine: 2, startColumn: 3, endLine: 3, endColumn: 3 },
        enclosingTypeId: "type:C",
        complexity: 1,
      }],
      relations: [{
        id: "relation:reference",
        kind: "type-reference" as const,
        sourceId: "callable:m",
        targetId: "type:C",
        provenance: "syntax" as const,
      }],
      unavailable: [],
    };
    const model = {
      ...DEMO_MODEL,
      buildings: DEMO_MODEL.buildings.map((building) =>
        building.id === template.id
          ? {
              ...building,
              sourceLocation: { startLine: 1 as const, endLine: 4 },
              sourceStructure,
            }
          : building,
      ),
    };

    expect(validateSchema(model), errors()).toBe(true);
    expect(validateCityModel(model)).toBe(model);

    const duplicateRelationId = {
      ...model,
      buildings: model.buildings.map((building) =>
        building.id === template.id
          ? {
              ...building,
              sourceStructure: {
                ...sourceStructure,
                relations: [{
                  ...sourceStructure.relations[0]!,
                  id: "type:C",
                }],
              },
            }
          : building,
      ),
    };
    expect(() => validateCityModel(duplicateRelationId)).toThrow(
      /id must be unique within sourceStructure/u,
    );
  });

  it("validates bounded decision-site evidence without breaking aggregate-only units", () => {
    const template = DEMO_MODEL.buildings[0]!;
    const completeEvidence = {
      version: "codecity.complexity-evidence/1" as const,
      unitId: "unit:m",
      scope: "callable" as const,
      callableId: "callable:m",
      status: "complete" as const,
      totalContribution: 2,
      omittedContribution: 0 as const,
      sites: [
        {
          kind: "conditional-branch" as const,
          range: { startLine: 2, startColumn: 3, endLine: 2, endColumn: 4 },
          contribution: 1,
        },
        {
          kind: "short-circuit-operator" as const,
          range: { startLine: 2, startColumn: 8, endLine: 2, endColumn: 9 },
          contribution: 1,
        },
      ],
    };
    const building = {
      ...template,
      metrics: {
        ...template.metrics,
        decisionLoad: 2,
        maximumComplexity: 3,
        executableUnitCount: 1,
      },
      metricMethod: "typescript-compiler-api-v1" as const,
      sourceLocation: { startLine: 1 as const, endLine: 3 },
      units: [{
        name: "m",
        line: 2,
        endLine: 3,
        complexity: 3,
        decisionEvidence: completeEvidence,
      }],
      sourceStructure: {
        version: "codecity.source-structure/1" as const,
        availability: "available" as const,
        types: [],
        callables: [{
          id: "callable:m",
          name: "m",
          kind: "function" as const,
          range: { startLine: 2, startColumn: 1, endLine: 3, endColumn: 1 },
          complexity: 3,
        }],
        relations: [],
        unavailable: [],
      },
    };
    const model = {
      ...DEMO_MODEL,
      buildings: DEMO_MODEL.buildings.map((candidate) =>
        candidate.id === template.id ? building : candidate,
      ),
    };

    expect(validateSchema(model), errors()).toBe(true);
    expect(validateCityModel(model)).toBe(model);

    for (const target of ["evidence", "site", "range"] as const) {
      const unknownField = structuredClone(model);
      const evidence = unknownField.buildings[0]!.units![0]!
        .decisionEvidence!;
      const record = (
        target === "evidence"
          ? evidence
          : target === "site"
            ? evidence.sites[0]!
            : evidence.sites[0]!.range
      ) as unknown as Record<string, unknown>;
      record["futureField"] = true;
      expect(validateSchema(unknownField), target).toBe(false);
      expect(() => validateCityModel(unknownField), target).toThrow(
        /unknown or missing fields/u,
      );
    }

    const truncated = structuredClone(model);
    (truncated.buildings[0]!.units![0] as unknown as Record<string, unknown>)["decisionEvidence"] = {
      ...completeEvidence,
      status: "truncated",
      sites: completeEvidence.sites.slice(0, 1),
      omittedContribution: 1,
      reason: "Per-unit retention limit reached.",
    };
    expect(validateSchema(truncated), errors()).toBe(true);
    expect(validateCityModel(truncated)).toBe(truncated);

    const unavailable = structuredClone(model);
    (unavailable.buildings[0]!.units![0] as unknown as Record<string, unknown>)["decisionEvidence"] = {
      version: "codecity.complexity-evidence/1",
      unitId: "unit:m",
      scope: "callable",
      callableId: "callable:m",
      status: "unavailable",
      sites: [],
      reason: "The analyzer cannot attribute exact syntax sites.",
    };
    expect(validateSchema(unavailable), errors()).toBe(true);
    expect(validateCityModel(unavailable)).toBe(unavailable);

    const inconsistent = structuredClone(model);
    (inconsistent.buildings[0]!.units![0]!.decisionEvidence as unknown as Record<string, unknown>)["totalContribution"] = 1;
    expect(() => validateCityModel(inconsistent)).toThrow(
      /totalContribution must equal unit complexity minus one/u,
    );

    const unordered = structuredClone(model);
    (unordered.buildings[0]!.units![0]!.decisionEvidence!.sites as unknown[]).reverse();
    expect(() => validateCityModel(unordered)).toThrow(
      /strictly source ordered and non-overlapping/u,
    );

    const missingCallableLink = structuredClone(model);
    delete (missingCallableLink.buildings[0]!.units![0]!.decisionEvidence as unknown as Record<string, unknown>)["callableId"];
    expect(() => validateCityModel(missingCallableLink)).toThrow(
      /callableId is required/u,
    );

    const wrongCallable = structuredClone(model);
    (wrongCallable.buildings[0]!.sourceStructure!.callables as unknown as Record<string, unknown>[]).push({
      ...wrongCallable.buildings[0]!.sourceStructure!.callables[0]!,
      id: "callable:n",
      name: "n",
    });
    (wrongCallable.buildings[0]!.units![0]!.decisionEvidence as unknown as Record<string, unknown>)["callableId"] = "callable:n";
    expect(() => validateCityModel(wrongCallable)).toThrow(
      /name must match its sourceStructure callable/u,
    );

    const duplicateCallable = structuredClone(model);
    (duplicateCallable.buildings[0]!.metrics as unknown as Record<string, unknown>)["executableUnitCount"] = 2;
    (duplicateCallable.buildings[0]!.metrics as unknown as Record<string, unknown>)["decisionLoad"] = 4;
    (duplicateCallable.buildings[0]!.units as unknown as Record<string, unknown>[]).push({
      ...duplicateCallable.buildings[0]!.units![0]!,
      decisionEvidence: {
        ...duplicateCallable.buildings[0]!.units![0]!.decisionEvidence!,
        unitId: "unit:m-duplicate",
      },
    });
    expect(validateSchema(duplicateCallable), errors()).toBe(true);
    expect(() => validateCityModel(duplicateCallable)).toThrow(
      /callableId must link to only one executable unit/u,
    );

    const fabricatedUnavailable = structuredClone(unavailable);
    (fabricatedUnavailable.buildings[0]!.units![0]!.decisionEvidence as unknown as Record<string, unknown>)["totalContribution"] = 2;
    expect(validateSchema(fabricatedUnavailable)).toBe(false);
    expect(() => validateCityModel(fabricatedUnavailable)).toThrow(
      /must not synthesize contribution totals/u,
    );

    const oversized = structuredClone(model);
    const sites = Array.from({ length: 257 }, (_, index) => ({
      kind: "conditional-branch" as const,
      range: {
        startLine: index + 2,
        startColumn: 1,
        endLine: index + 2,
        endColumn: 2,
      },
      contribution: 1,
    }));
    const oversizedBuilding = oversized.buildings[0]!;
    (oversizedBuilding as unknown as Record<string, unknown>)["sourceLocation"] = { startLine: 1, endLine: 258 };
    (oversizedBuilding.metrics as unknown as Record<string, unknown>)["decisionLoad"] = 257;
    (oversizedBuilding.metrics as unknown as Record<string, unknown>)["maximumComplexity"] = 258;
    (oversizedBuilding.units![0] as unknown as Record<string, unknown>)["endLine"] = 258;
    (oversizedBuilding.units![0] as unknown as Record<string, unknown>)["complexity"] = 258;
    (oversizedBuilding.units![0] as unknown as Record<string, unknown>)["decisionEvidence"] = {
      ...completeEvidence,
      totalContribution: 257,
      sites,
    };
    (oversizedBuilding.sourceStructure!.callables[0]!.range as unknown as Record<string, unknown>)["endLine"] = 258;
    (oversizedBuilding.sourceStructure!.callables[0] as unknown as Record<string, unknown>)["complexity"] = 258;
    expect(validateSchema(oversized)).toBe(false);
    expect(() => validateCityModel(oversized)).toThrow(/at most 256 items/u);

    const legacyAggregateOnly = structuredClone(model);
    delete (legacyAggregateOnly.buildings[0]!.units![0] as unknown as Record<string, unknown>)["decisionEvidence"];
    expect(validateSchema(legacyAggregateOnly), errors()).toBe(true);
    expect(validateCityModel(legacyAggregateOnly)).toBe(legacyAggregateOnly);
  });

  it("rejects unknown versions and incoherent additive fields", () => {
    expect(
      validateSchema({ ...DEMO_MODEL, schemaVersion: "2.0" }),
    ).toBe(false);
    expect(
      validateSchema({
        ...DEMO_MODEL,
        metricMapping: {
          ...DEFAULT_METRIC_MAPPING,
          definitionVersion: "2.0",
        },
      }),
    ).toBe(false);
    expect(() =>
      validateCityModel({
        ...DEMO_MODEL,
        metricMapping: {
          ...DEFAULT_METRIC_MAPPING,
          definitionVersion: "2.0",
        },
      }),
    ).toThrow(/metricMapping\.definitionVersion/u);
    expect(
      validateSchema({
        ...DEMO_MODEL,
        metricMapping: {
          ...DEFAULT_METRIC_MAPPING,
          normalizationCaps: {
            ...DEFAULT_METRIC_MAPPING.normalizationCaps,
            sloc: 999,
          },
        },
      }),
    ).toBe(false);
    expect(
      validateSchema({
        ...DEMO_MODEL,
        dependencies: [
          {
            ...DEMO_MODEL.dependencies.find(
              ({ externalTarget }) => externalTarget !== undefined,
            )!,
            resolution: "internal",
          },
        ],
      }),
    ).toBe(false);
  });

  it("keeps graph invariants in the runtime validator", () => {
    const invalidCrossReference = {
      ...DEMO_MODEL,
      dependencies: [
        {
          ...DEMO_MODEL.dependencies[0]!,
          sourceId: "module:missing",
        },
      ],
    };

    expect(validateSchema(invalidCrossReference), errors()).toBe(true);
    expect(() => validateCityModel(invalidCrossReference)).toThrow(
      /sourceId references an unknown id/u,
    );
  });
});
