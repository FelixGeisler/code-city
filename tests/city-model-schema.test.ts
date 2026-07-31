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
