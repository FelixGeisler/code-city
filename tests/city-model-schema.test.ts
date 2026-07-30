import { readFile } from "node:fs/promises";

import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import { DEMO_MODEL } from "../apps/viewer/src/demo-model.js";
import {
  calculateBuildingGeometry,
  DEFAULT_METRIC_MAPPING,
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

  it("rejects unknown versions and incoherent additive fields", () => {
    expect(
      validateSchema({ ...DEMO_MODEL, schemaVersion: "2.0" }),
    ).toBe(false);
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
