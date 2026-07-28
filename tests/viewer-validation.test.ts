import { describe, expect, it } from "vitest";

import { DEMO_MODEL } from "../apps/viewer/src/demo-model.js";
import {
  CITY_MODEL_LIMITS,
  validateCityModel,
} from "../apps/viewer/src/model-validation.js";

describe("viewer model validation", () => {
  it("accepts module-level project and package dependencies", () => {
    const [source, target] = DEMO_MODEL.modules;
    expect(source).toBeDefined();
    expect(target).toBeDefined();

    const model = {
      ...DEMO_MODEL,
      dependencies: [
        {
          id: "dependency:project",
          repositoryId: source!.repositoryId,
          sourceId: source!.id,
          targetId: target!.id,
          kind: "project-reference" as const,
          weight: 1,
        },
        {
          id: "dependency:package",
          repositoryId: source!.repositoryId,
          sourceId: source!.id,
          externalTarget: "example.package",
          kind: "package-reference" as const,
          version: "1.0.0",
          weight: 1,
        },
      ],
    };

    expect(validateCityModel(model)).toBe(model);
  });

  it("accepts a deterministic empty-city result", () => {
    const model = {
      ...DEMO_MODEL,
      districts: [],
      buildings: [],
      dependencies: [],
      bounds: { x: 0, y: 0, z: 0 },
    };

    expect(validateCityModel(model)).toBe(model);
  });

  it.each([
    "%2e%2e/private/logo.svg",
    "assets/.%2e/private/logo.svg",
    "assets%2flogo.svg",
    "assets/%255cprivate/logo.svg",
  ])("rejects encoded logo traversal %s", (relativePath) => {
    const model = {
      ...DEMO_MODEL,
      identity: {
        title: "Code City",
        logo: { relativePath, format: "svg" },
      },
    };

    expect(() => validateCityModel(model)).toThrow(
      /normalized repository-relative path/u,
    );
  });

  it("rejects top-level collections beyond viewer safety limits", () => {
    const model = {
      ...DEMO_MODEL,
      semanticGroups: Array.from(
        { length: CITY_MODEL_LIMITS.semanticGroups + 1 },
        () => DEMO_MODEL.semanticGroups[0],
      ),
    };

    expect(() => validateCityModel(model)).toThrow(
      `semanticGroups must contain at most ${CITY_MODEL_LIMITS.semanticGroups} items`,
    );
  });

  it("rejects geometry beyond the finite viewer coordinate limit", () => {
    const model = {
      ...DEMO_MODEL,
      buildings: DEMO_MODEL.buildings.map((building, index) =>
        index === 0
          ? {
              ...building,
              size: {
                ...building.size,
                x: CITY_MODEL_LIMITS.coordinateMagnitude + 1,
              },
            }
          : building,
      ),
    };

    expect(() => validateCityModel(model)).toThrow(
      `must not exceed ${CITY_MODEL_LIMITS.coordinateMagnitude} model units`,
    );
  });
});
