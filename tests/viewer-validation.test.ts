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

  it.each(["", " \t "])(
    "rejects an empty external dependency target",
    (externalTarget) => {
      const source = DEMO_MODEL.modules[0]!;
      expect(() =>
        validateCityModel({
          ...DEMO_MODEL,
          dependencies: [
            {
              id: "dependency:empty-external",
              repositoryId: source.repositoryId,
              sourceId: source.id,
              externalTarget,
              kind: "package-reference",
              weight: 1,
            },
          ],
        }),
      ).toThrow(/dependencies\[0\]\.externalTarget must not be empty/u);
    },
  );

  it("accepts a deterministic empty-city result", () => {
    const {
      base: _base,
      ...demoWithoutBase
    } = DEMO_MODEL;
    const model = {
      ...demoWithoutBase,
      districts: [],
      buildings: [],
      dependencies: [],
      bounds: { x: 0, y: 0, z: 0 },
    };

    expect(validateCityModel(model)).toBe(model);
  });

  it("accepts legacy schema-1.0 models without explicit base geometry", () => {
    const {
      base: _base,
      ...legacyModel
    } = DEMO_MODEL;

    expect(validateCityModel(legacyModel)).toBe(legacyModel);
  });

  it("validates shared-base semantics and geometry", () => {
    expect(validateCityModel(DEMO_MODEL)).toBe(DEMO_MODEL);
    const base = DEMO_MODEL.base!;
    const panel = DEMO_MODEL.identityPanel!;
    expect(panel.size.x).toBeLessThan(base.size.x);
    expect(panel.position.x).toBe(base.position.x);
    expect(
      Math.min(
        base.position.y + base.size.y / 2,
        panel.position.y + panel.size.y / 2,
      ) -
        Math.max(
          base.position.y - base.size.y / 2,
          panel.position.y - panel.size.y / 2,
        ),
    ).toBeGreaterThan(0);
    expect(
      panel.position.z - panel.size.z / 2 - panel.reliefDepth,
    ).toBeGreaterThanOrEqual(base.position.z - base.size.z / 2);

    expect(() =>
      validateCityModel({
        ...DEMO_MODEL,
        base: {
          ...DEMO_MODEL.base!,
          semanticGroupId: "identity",
        },
      }),
    ).toThrow(/base\.semanticGroupId must be "base"/u);
    expect(() =>
      validateCityModel({
        ...DEMO_MODEL,
        semanticGroups: DEMO_MODEL.semanticGroups.filter(
          ({ id }) => id !== "base",
        ),
      }),
    ).toThrow(/base\.semanticGroupId references unknown id "base"/u);
    expect(() =>
      validateCityModel({
        ...DEMO_MODEL,
        base: {
          ...DEMO_MODEL.base!,
          size: { ...DEMO_MODEL.base!.size, y: 0 },
        },
      }),
    ).toThrow(/base\.size components must be greater than zero/u);
    expect(() =>
      validateCityModel({
        ...DEMO_MODEL,
        base: {
          ...base,
          size: { ...base.size, x: base.size.x - 1 },
        },
      }),
    ).toThrow(/base\.size\.x\/z must equal bounds\.x\/z/u);
    expect(() =>
      validateCityModel({
        ...DEMO_MODEL,
        base: {
          ...base,
          position: { ...base.position, x: base.position.x + 100 },
        },
      }),
    ).toThrow(/base must horizontally cover districts\[0\]/u);
    expect(() =>
      validateCityModel({
        ...DEMO_MODEL,
        base: {
          ...base,
          position: { ...base.position, y: base.position.y + 2 },
        },
      }),
    ).toThrow(/base must overlap districts\[0\] from below/u);
    expect(() =>
      validateCityModel({
        ...DEMO_MODEL,
        identityPanel: {
          ...panel,
          position: { ...panel.position, x: panel.position.x + 100 },
        },
      }),
    ).toThrow(/base must horizontally cover identityPanel and its relief/u);
  });

  it("requires buildings to sit inside and directly on their districts", () => {
    const firstBuilding = DEMO_MODEL.buildings[0]!;
    expect(() =>
      validateCityModel({
        ...DEMO_MODEL,
        buildings: DEMO_MODEL.buildings.map((building, index) =>
          index === 0
            ? {
                ...building,
                position: { ...building.position, x: 0 },
              }
            : building,
        ),
      }),
    ).toThrow(
      /buildings\[0\] must be horizontally contained by its referenced district/u,
    );
    expect(() =>
      validateCityModel({
        ...DEMO_MODEL,
        buildings: DEMO_MODEL.buildings.map((building, index) =>
          index === 0
            ? {
                ...building,
                position: {
                  ...firstBuilding.position,
                  y: firstBuilding.position.y + 1,
                },
              }
            : building,
        ),
      }),
    ).toThrow(/buildings\[0\] must rest on its referenced district/u);
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

  it.each(["red", "#123", "#12345", "#123456789"])(
    "rejects non-portable semantic color %s",
    (color) => {
      expect(() =>
        validateCityModel({
          ...DEMO_MODEL,
          semanticGroups: DEMO_MODEL.semanticGroups.map((group, index) =>
            index === 0 ? { ...group, color } : group,
          ),
        }),
      ).toThrow(/#RRGGBB or #RRGGBBAA/u);
    },
  );

  it("accepts an eight-digit semantic color", () => {
    expect(() =>
      validateCityModel({
        ...DEMO_MODEL,
        semanticGroups: DEMO_MODEL.semanticGroups.map((group, index) =>
          index === 0 ? { ...group, color: "#11223380" } : group,
        ),
      }),
    ).not.toThrow();
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
