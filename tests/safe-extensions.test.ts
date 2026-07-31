import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it, vi } from "vitest";
import { DEMO_MODEL } from "../apps/viewer/src/demo-model.js";
import { validateCityModel } from "../packages/core/src/model-validation.js";
import type { CityModel } from "../packages/core/src/model.js";
import {
  EXTENSION_CONFIGURATION_VERSION,
  EXTENSION_LIMITS,
  SAFE_EXTENSION_PRESETS,
  SafeExtensionApprovalAuthority,
  SafeExtensionApplicationAuthority,
  applySafeExtensionEvaluation,
  createSafeExtensionModelSnapshot,
  evaluateSafeExtension,
  migrateSafeExtensionConfiguration,
  safeExtensionConfigurationDigest,
  safeExtensionModelDigest,
  validateSafeExtensionConfiguration,
  validateSafeExtensionEvaluation,
  type SafeExtensionAdministratorApproval,
  type SafeExtensionApplicationReceipt,
  type SafeExtensionConfigurationV1,
  type SafeExtensionModelSnapshot,
} from "../packages/core/src/extensions.js";

const schema = JSON.parse(
  await readFile(
    new URL(
      "../packages/core/schema/safe-extension.schema.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as object;
const validateSchema = new Ajv2020({ allErrors: true, strict: true }).compile(
  schema,
);

function snapshot(
  count = 2,
  schemaVersion: unknown = "1.0",
): SafeExtensionModelSnapshot {
  return {
    schemaVersion,
    buildings: Array.from({ length: count }, (_, index) => ({
      id: `building-${String(index).padStart(4, "0")}`,
      moduleId: index % 2 === 0 ? "module-a" : "module-b",
      districtId: index % 2 === 0 ? "district-a" : "district-b",
      metrics: {
        sloc: 10 + index * 100,
        decisionLoad: 2 + index,
        maximumComplexity: 3 + index * 10,
        executableUnitCount: 1 + index,
      },
      position: { x: index * 10, y: 1, z: index * 5 },
      size: { x: 2, y: 2, z: 2 },
    })),
  } as SafeExtensionModelSnapshot;
}

function completeConfiguration(): SafeExtensionConfigurationV1 {
  return validateSafeExtensionConfiguration({
    version: EXTENSION_CONFIGURATION_VERSION,
    id: "complete",
    name: "Complete data-only visualization",
    compatibility: {
      cityModel: "1.x",
      capabilities: [
        "derived-metrics",
        "mappings",
        "filters",
        "legends",
        "layouts",
        "queries",
        "overlays",
      ],
    },
    scope: { kind: "project" },
    derivedMetrics: [
      {
        id: "pressure",
        label: "Pressure",
        expression: {
          op: "add",
          left: { op: "metric", metric: "maximumComplexity" },
          right: { op: "metric", metric: "decisionLoad" },
        },
      },
    ],
    mappings: [
      {
        id: "pressure-color",
        metric: "pressure",
        target: "color",
        minimum: 0,
        maximum: 10,
      },
      {
        id: "height",
        metric: "maximumComplexity",
        target: "height",
        minimum: 0,
        maximum: 10,
      },
      {
        id: "footprint",
        metric: "sloc",
        target: "footprint",
        minimum: 0,
        maximum: 100,
      },
    ],
    filters: [
      {
        id: "complex",
        metric: "maximumComplexity",
        operator: "atLeast",
        value: 10,
      },
    ],
    legends: [
      {
        id: "pressure-legend",
        label: "Pressure",
        mappingId: "pressure-color",
      },
    ],
    layouts: [{ id: "modules", strategy: "group-by-module" }],
    queries: [{ id: "complex-query", filterId: "complex" }],
    overlays: [
      { id: "complex-overlay", filterId: "complex", color: "#00aa11" },
      { id: "final-overlay", filterId: "complex", color: "#123456" },
    ],
  });
}

function expressionConfiguration(expression: unknown): unknown {
  return {
    version: EXTENSION_CONFIGURATION_VERSION,
    id: "math",
    name: "Math",
    compatibility: {
      cityModel: "1.x",
      capabilities: ["derived-metrics"],
    },
    scope: { kind: "project" },
    derivedMetrics: [{ id: "result", label: "Result", expression }],
  };
}

function applicationReceipt(
  model: CityModel,
  evaluation: ReturnType<typeof evaluateSafeExtension>,
) {
  const authority = new SafeExtensionApplicationAuthority();
  return {
    authority,
    receipt: authority.issue(model, evaluation),
  };
}

function horizontallyDisjoint(
  left: {
    readonly position: { readonly x: number; readonly z: number };
    readonly size: { readonly x: number; readonly z: number };
  },
  right: {
    readonly position: { readonly x: number; readonly z: number };
    readonly size: { readonly x: number; readonly z: number };
  },
): boolean {
  return (
    left.position.x + left.size.x / 2 <=
      right.position.x - right.size.x / 2 ||
    right.position.x + right.size.x / 2 <=
      left.position.x - left.size.x / 2 ||
    left.position.z + left.size.z / 2 <=
      right.position.z - right.size.z / 2 ||
    right.position.z + right.size.z / 2 <=
      left.position.z - left.size.z / 2
  );
}

describe("safe declarative extensions", () => {
  it("publishes a strict schema that accepts the preset", () => {
    expect(
      validateSchema(SAFE_EXTENSION_PRESETS[0]),
      JSON.stringify(validateSchema.errors),
    ).toBe(true);
    expect(
      validateSchema({
        ...SAFE_EXTENSION_PRESETS[0],
        overlays: [{ script: "fetch('/secrets')" }],
      }),
    ).toBe(false);
    expect(
      validateSchema({ ...SAFE_EXTENSION_PRESETS[0], id: "constructor" }),
    ).toBe(false);
    const shadowingMetric = {
      ...SAFE_EXTENSION_PRESETS[0],
      derivedMetrics: [
        {
          id: "sloc",
          label: "Shadowed SLOC",
          expression: { op: "constant", value: 1 },
        },
      ],
    };
    expect(validateSchema(shadowingMetric)).toBe(false);
    expect(() => validateSafeExtensionConfiguration(shadowingMetric)).toThrow(
      /must not shadow a built-in metric/,
    );
    expect(() =>
      validateSafeExtensionConfiguration({
        ...SAFE_EXTENSION_PRESETS[0],
        id: "prototype",
      }),
    ).toThrow(/bounded lowercase identifier/);
    expect(
      validateSchema({
        ...SAFE_EXTENSION_PRESETS[0],
        layouts: [
          { id: "one", strategy: "preserve-city" },
          { id: "two", strategy: "group-by-module" },
        ],
      }),
    ).toBe(false);
  });

  it("applies mappings, a layout, legends, queries, and every overlay deterministically", () => {
    const model = snapshot();
    const configuration = completeConfiguration();
    const first = evaluateSafeExtension(model, configuration);
    const second = evaluateSafeExtension(model, configuration);
    expect(second).toEqual(first);
    expect(first.derivedMetrics["building-0001"]?.pressure).toBe(16);
    expect(first.matches.complex).toEqual(["building-0001"]);
    expect(first.application.mappings).toHaveLength(3);
    expect(first.application.layouts).toEqual([
      { id: "modules", strategy: "group-by-module" },
    ]);
    expect(first.application.legends[0]).toMatchObject({
      id: "pressure-legend",
      minimumColor: "#2563EB",
      maximumColor: "#DC2626",
    });
    expect(first.application.queries[0]?.buildingIds).toEqual([
      "building-0001",
    ]);
    expect(first.application.overlays).toEqual([
      {
        id: "complex-overlay",
        color: "#00AA11",
        buildingIds: ["building-0001"],
      },
      {
        id: "final-overlay",
        color: "#123456",
        buildingIds: ["building-0001"],
      },
    ]);
    const low = first.application.buildings.find(
      ({ id }) => id === "building-0000",
    )!;
    const high = first.application.buildings.find(
      ({ id }) => id === "building-0001",
    )!;
    expect(low.size.y).not.toBe(2);
    expect(high.size.x).toBe(4);
    expect(high.color).toBe("#123456");
    expect(low.position.x).not.toBe(0);
    expect(first.diagnostics.some(({ path }) => path.startsWith("mappings"))).toBe(
      true,
    );
  });

  it("deeply validates a result and applies reviewed geometry to the full model", () => {
    const evaluation = evaluateSafeExtension(
      DEMO_MODEL,
      SAFE_EXTENSION_PRESETS[0],
    );
    expect(
      validateSafeExtensionEvaluation(structuredClone(evaluation), {
        model: DEMO_MODEL,
        configuration: SAFE_EXTENSION_PRESETS[0],
      }),
    ).toEqual(evaluation);
    const projectApplication = applicationReceipt(DEMO_MODEL, evaluation);
    const projected = applySafeExtensionEvaluation(
      DEMO_MODEL,
      evaluation,
      projectApplication,
    );
    expect(projected.buildings).toHaveLength(DEMO_MODEL.buildings.length);
    expect(projected.buildings[0]?.id).toBe(DEMO_MODEL.buildings[0]?.id);
    expect(() =>
      applySafeExtensionEvaluation(DEMO_MODEL, evaluation, projectApplication),
    ).toThrow(/already been used/);

    const forgedReceipt = {
      kind: "safe-extension-application-receipt",
      expiresAt: new Date(Date.now() + 1_000).toISOString(),
    } as unknown as SafeExtensionApplicationReceipt;
    expect(() =>
      applySafeExtensionEvaluation(DEMO_MODEL, evaluation, {
        authority: new SafeExtensionApplicationAuthority(),
        receipt: forgedReceipt,
      }),
    ).toThrow(/invalid/);

    let receiptNow = 10_000;
    const expiringAuthority = new SafeExtensionApplicationAuthority({
      now: () => receiptNow,
    });
    const expiringReceipt = expiringAuthority.issue(DEMO_MODEL, evaluation, 10);
    receiptNow += 10;
    expect(() =>
      applySafeExtensionEvaluation(DEMO_MODEL, evaluation, {
        authority: expiringAuthority,
        receipt: expiringReceipt,
      }),
    ).toThrow(/expired/);

    const geometryEvaluation = evaluateSafeExtension(
      DEMO_MODEL,
      completeConfiguration(),
    );
    const geometryProjection = applySafeExtensionEvaluation(
      DEMO_MODEL,
      geometryEvaluation,
      applicationReceipt(DEMO_MODEL, geometryEvaluation),
    );
    expect(validateCityModel(geometryProjection)).toBe(geometryProjection);
    expect(geometryProjection.bounds).not.toEqual(DEMO_MODEL.bounds);
    expect(geometryProjection.base?.size.x).toBe(
      geometryProjection.bounds.x,
    );

    const forged = structuredClone(evaluation);
    const forgedApplication = applicationReceipt(DEMO_MODEL, evaluation);
    (forged.application.buildings[0]!.size as { x: number }).x = Number.NaN;
    expect(() =>
      applySafeExtensionEvaluation(DEMO_MODEL, forged, forgedApplication),
    ).toThrow(
      /finite JSON numbers|bounded number/,
    );
    const finiteTamper = structuredClone(evaluation);
    (finiteTamper.application.buildings[0]!.position as { x: number }).x += 0.25;
    const finiteTamperAuthority = new SafeExtensionApplicationAuthority();
    const finiteTamperApplication = {
      authority: finiteTamperAuthority,
      receipt: finiteTamperAuthority.issue(DEMO_MODEL, finiteTamper),
    };
    expect(() =>
      applySafeExtensionEvaluation(
        DEMO_MODEL,
        finiteTamper,
        finiteTamperApplication,
      ),
    ).toThrow(/does not match deterministic evaluation/);
    expect(() =>
      validateSafeExtensionEvaluation(evaluation, { model: snapshot() }),
    ).toThrow(/different project model/);
  });

  it("preserves horizontal city geometry for a height-only mapping", () => {
    const configuration = validateSafeExtensionConfiguration({
      version: EXTENSION_CONFIGURATION_VERSION,
      id: "height-only",
      name: "Height only",
      compatibility: {
        cityModel: "1.x",
        capabilities: ["mappings"],
      },
      scope: { kind: "project" },
      mappings: [
        {
          id: "height",
          metric: "sloc",
          target: "height",
          minimum: 0,
          maximum: 1,
        },
      ],
    });
    const evaluation = evaluateSafeExtension(DEMO_MODEL, configuration);
    const projected = applySafeExtensionEvaluation(
      DEMO_MODEL,
      evaluation,
      applicationReceipt(DEMO_MODEL, evaluation),
    );

    expect(projected.districts).toBe(DEMO_MODEL.districts);
    expect(projected.base).toBe(DEMO_MODEL.base);
    expect(projected.bounds.x).toBe(DEMO_MODEL.bounds.x);
    expect(projected.bounds.z).toBe(DEMO_MODEL.bounds.z);
    expect(projected.bounds.y).toBeGreaterThan(DEMO_MODEL.bounds.y);
    expect(
      projected.buildings.map(({ position, size }) => ({
        position: { x: position.x, z: position.z },
        size: { x: size.x, z: size.z },
      })),
    ).toEqual(
      DEMO_MODEL.buildings.map(({ position, size }) => ({
        position: { x: position.x, z: position.z },
        size: { x: size.x, z: size.z },
      })),
    );
    expect(validateCityModel(projected)).toBe(projected);
  });

  it("keeps buildings and districts collision-safe, anchored, and explicit", () => {
    const candidate = structuredClone(DEMO_MODEL);
    const coreDistrict = candidate.districts.find(
      ({ id }) => id === "district:core",
    )!;
    (coreDistrict as { moduleId: string }).moduleId = "module:viewer";
    for (const building of candidate.buildings) {
      if (building.districtId === coreDistrict.id) {
        (building as { moduleId: string }).moduleId = "module:viewer";
      }
    }
    const emptyDistrict = structuredClone(candidate.districts[0]!);
    (emptyDistrict as { id: string }).id = "district:empty";
    (emptyDistrict as { name: string }).name = "Empty district";
    (candidate.districts as typeof emptyDistrict[]).push(emptyDistrict);
    const model = validateCityModel(candidate);
    const moduleConfiguration = validateSafeExtensionConfiguration({
      version: EXTENSION_CONFIGURATION_VERSION,
      id: "module-layout",
      name: "Module layout",
      compatibility: {
        cityModel: "1.x",
        capabilities: ["layouts"],
      },
      scope: { kind: "project" },
      layouts: [{ id: "modules", strategy: "group-by-module" }],
    });
    const evaluation = evaluateSafeExtension(model, moduleConfiguration);
    const projected = applySafeExtensionEvaluation(
      model,
      evaluation,
      applicationReceipt(model, evaluation),
    );
    for (const [index, district] of projected.districts.entries()) {
      for (const other of projected.districts.slice(index + 1)) {
        expect(horizontallyDisjoint(district, other)).toBe(true);
      }
    }
    const originalMinimumZ = Math.min(
      ...model.districts.map(
        (district) => district.position.z - district.size.z / 2,
      ),
    );
    const originalMinimumX = Math.min(
      ...model.districts.map(
        (district) => district.position.x - district.size.x / 2,
      ),
    );
    const originalMaximumX = Math.max(
      ...model.districts.map(
        (district) => district.position.x + district.size.x / 2,
      ),
    );
    const projectedMinimumZ = Math.min(
      ...projected.districts.map(
        (district) => district.position.z - district.size.z / 2,
      ),
    );
    const projectedMinimumX = Math.min(
      ...projected.districts.map(
        (district) => district.position.x - district.size.x / 2,
      ),
    );
    const projectedMaximumX = Math.max(
      ...projected.districts.map(
        (district) => district.position.x + district.size.x / 2,
      ),
    );
    expect(projectedMinimumZ).toBeCloseTo(originalMinimumZ, 10);
    expect((projectedMinimumX + projectedMaximumX) / 2).toBeCloseTo(
      (originalMinimumX + originalMaximumX) / 2,
      10,
    );
    expect(
      model.identityPanel!.position.z + model.identityPanel!.size.z / 2,
    ).toBeLessThan(projectedMinimumZ);
    expect(validateCityModel(projected)).toBe(projected);

    const footprintConfiguration = validateSafeExtensionConfiguration({
      version: EXTENSION_CONFIGURATION_VERSION,
      id: "footprint-layout",
      name: "Footprint layout",
      compatibility: {
        cityModel: "1.x",
        capabilities: ["mappings"],
      },
      scope: { kind: "project" },
      mappings: [
        {
          id: "footprint",
          metric: "sloc",
          target: "footprint",
          minimum: 0,
          maximum: 1,
        },
      ],
    });
    const footprintEvaluation = evaluateSafeExtension(
      model,
      footprintConfiguration,
    );
    expect(footprintEvaluation.application.layouts).toHaveLength(0);
    expect(footprintEvaluation.diagnostics).toContainEqual({
      path: "mappings[0]",
      message:
        "Footprint changes applied a deterministic collision-safe module and district relayout.",
    });
    const footprintProjection = applySafeExtensionEvaluation(
      model,
      footprintEvaluation,
      applicationReceipt(model, footprintEvaluation),
    );
    for (const [index, building] of footprintProjection.buildings.entries()) {
      for (const other of footprintProjection.buildings.slice(index + 1)) {
        expect(horizontallyDisjoint(building, other)).toBe(true);
      }
    }
    for (const [index, district] of footprintProjection.districts.entries()) {
      for (const other of footprintProjection.districts.slice(index + 1)) {
        expect(horizontallyDisjoint(district, other)).toBe(true);
      }
    }
    expect(validateCityModel(footprintProjection)).toBe(footprintProjection);

    const preserveConfiguration = validateSafeExtensionConfiguration({
      ...footprintConfiguration,
      id: "preserved-footprint",
      compatibility: {
        cityModel: "1.x",
        capabilities: ["mappings", "layouts"],
      },
      layouts: [{ id: "preserve", strategy: "preserve-city" }],
    });
    expect(() => evaluateSafeExtension(model, preserveConfiguration)).toThrow(
      /cannot preserve city positions.*use group-by-module/,
    );

    const tiny = snapshot(2);
    for (const building of tiny.buildings) {
      (building as { moduleId: string }).moduleId = "module-a";
      (building as { districtId: string }).districtId = "district-a";
      (building.size as { x: number; z: number }).x = 0.000_001;
      (building.size as { x: number; z: number }).z = 0.000_001;
    }
    const tinyEvaluation = evaluateSafeExtension(tiny, moduleConfiguration);
    expect(
      tinyEvaluation.application.buildings[1]!.position.x -
        tinyEvaluation.application.buildings[0]!.position.x,
    ).toBeCloseTo(1.000_001, 10);
  });

  it("uses canonical SHA-256 model and configuration bindings", () => {
    const configuration = SAFE_EXTENSION_PRESETS[0]!;
    const canonical = migrateSafeExtensionConfiguration(configuration);
    expect(safeExtensionConfigurationDigest(configuration)).toBe(
      `sha256:${createHash("sha256").update(JSON.stringify(canonical)).digest("hex")}`,
    );
    expect(safeExtensionModelDigest(DEMO_MODEL)).toMatch(
      /^sha256:[0-9a-f]{64}$/,
    );
  });

  it("migrates only the immediately previous data-only version", () => {
    const legacy = {
      ...SAFE_EXTENSION_PRESETS[0],
      version: "codecity.extensions/0",
    };
    expect(migrateSafeExtensionConfiguration(legacy).version).toBe(
      EXTENSION_CONFIGURATION_VERSION,
    );
    expect(() =>
      migrateSafeExtensionConfiguration({
        ...legacy,
        version: "codecity.extensions/99",
      }),
    ).toThrow(/Unsupported/);
    expect(() => createSafeExtensionModelSnapshot(snapshot(1, "1.bad"))).toThrow(
      /supported schema version/,
    );
    let accessed = false;
    const hostileLegacy = {
      ...legacy,
    } as Record<string, unknown>;
    Object.defineProperty(hostileLegacy, "version", {
      enumerable: false,
      get: () => {
        accessed = true;
        return "codecity.extensions/0";
      },
    });
    expect(() => migrateSafeExtensionConfiguration(hostileLegacy)).toThrow(
      /accessors|extra properties/,
    );
    expect(accessed).toBe(false);
  });

  it("requires exact capability declarations and references", () => {
    expect(() =>
      validateSafeExtensionConfiguration({
        ...SAFE_EXTENSION_PRESETS[0],
        compatibility: { cityModel: "1.x", capabilities: ["layouts"] },
      }),
    ).toThrow();
    expect(() =>
      validateSafeExtensionConfiguration({
        ...SAFE_EXTENSION_PRESETS[0],
        compatibility: {
          cityModel: "1.x",
          capabilities: [
            "derived-metrics",
            "mappings",
            "filters",
            "legends",
            "queries",
          ],
        },
      }),
    ).toThrow(/overlays.*declared/);
    expect(() =>
      validateSafeExtensionConfiguration({
        ...completeConfiguration(),
        queries: [{ id: "missing-query", filterId: "missing" }],
      }),
    ).toThrow(/reference a filter/);

    const reservedModelId = snapshot(1);
    (reservedModelId.buildings[0] as { id: string }).id = "constructor";
    expect(
      evaluateSafeExtension(reservedModelId, {
        version: EXTENSION_CONFIGURATION_VERSION,
        id: "empty",
        name: "Empty",
        compatibility: { cityModel: "1.x", capabilities: [] },
        scope: { kind: "project" },
      }).application.buildings[0]?.id,
    ).toBe("constructor");
  });

  it("enforces byte, aggregate, graph, accessor, and expression limits", () => {
    expect(() =>
      validateSafeExtensionConfiguration({
        ...SAFE_EXTENSION_PRESETS[0],
        padding: "x".repeat(EXTENSION_LIMITS.bytes),
      }),
    ).toThrow(/byte limit/);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => validateSafeExtensionConfiguration(cyclic)).toThrow(
      /acyclic JSON/,
    );
    let getterCalled = false;
    const accessor = { ...SAFE_EXTENSION_PRESETS[0] } as Record<string, unknown>;
    Object.defineProperty(accessor, "payload", {
      enumerable: true,
      get: () => {
        getterCalled = true;
        return "secret";
      },
    });
    expect(() => validateSafeExtensionConfiguration(accessor)).toThrow(
      /accessors/,
    );
    expect(getterCalled).toBe(false);

    const hidden = { ...SAFE_EXTENSION_PRESETS[0] } as Record<string, unknown>;
    Object.defineProperty(hidden, "script", {
      enumerable: false,
      value: "fetch('/secret')",
    });
    expect(() => validateSafeExtensionConfiguration(hidden)).toThrow(
      /accessors|plain JSON objects/,
    );

    const oversizedKey = "k".repeat(EXTENSION_LIMITS.bytes);
    const stringify = vi.spyOn(JSON, "stringify").mockImplementation(() => {
      throw new Error("serialization must not be reached");
    });
    let oversizedKeyError: unknown;
    try {
      validateSafeExtensionConfiguration({ [oversizedKey]: null });
    } catch (error) {
      oversizedKeyError = error;
    } finally {
      stringify.mockRestore();
    }
    expect(oversizedKeyError).toBeInstanceOf(RangeError);
    expect((oversizedKeyError as Error).message).toMatch(/byte limit/);
    expect(stringify).not.toHaveBeenCalled();

    const balanced = (depth: number): unknown =>
      depth === 0
        ? { op: "constant", value: 1 }
        : {
            op: "add",
            left: balanced(depth - 1),
            right: balanced(depth - 1),
          };
    expect(() =>
      validateSafeExtensionConfiguration({
        version: EXTENSION_CONFIGURATION_VERSION,
        id: "aggregate",
        name: "Aggregate",
        compatibility: {
          cityModel: "1.x",
          capabilities: ["derived-metrics"],
        },
        scope: { kind: "project" },
        derivedMetrics: Array.from({ length: 5 }, (_, index) => ({
          id: `metric-${index}`,
          label: `Metric ${index}`,
          expression: balanced(5),
        })),
      }),
    ).toThrow(/aggregate expression limit/);
  });

  it("accepts the documented model boundary and rejects one building beyond it", () => {
    expect(
      createSafeExtensionModelSnapshot(
        snapshot(EXTENSION_LIMITS.modelBuildings),
      ).buildings,
    ).toHaveLength(EXTENSION_LIMITS.modelBuildings);
    expect(() =>
      createSafeExtensionModelSnapshot(
        snapshot(EXTENSION_LIMITS.modelBuildings + 1),
      ),
    ).toThrow(/unsupported array|bounded array/);
  });

  it("fails explicit invalid math instead of silently coercing it", () => {
    expect(() =>
      evaluateSafeExtension(
        snapshot(1),
        expressionConfiguration({
          op: "divide",
          left: { op: "constant", value: 1 },
          right: { op: "constant", value: 0 },
        }),
      ),
    ).toThrow(/divide by zero/);
    expect(() =>
      evaluateSafeExtension(
        snapshot(1),
        expressionConfiguration({
          op: "log1p",
          value: { op: "constant", value: -1 },
        }),
      ),
    ).toThrow(/log1p/);
    expect(() =>
      evaluateSafeExtension(
        snapshot(1),
        expressionConfiguration({
          op: "multiply",
          left: { op: "constant", value: 1_000_000_000 },
          right: { op: "constant", value: 1_000_000_000 },
        }),
      ),
    ).toThrow(/out-of-range/);

    const tiny = snapshot(1);
    (tiny.buildings[0]!.size as { y: number }).y = 0.000_001;
    const mapped = evaluateSafeExtension(tiny, {
      version: EXTENSION_CONFIGURATION_VERSION,
      id: "tiny-height",
      name: "Tiny height",
      compatibility: {
        cityModel: "1.x",
        capabilities: ["mappings"],
      },
      scope: { kind: "project" },
      mappings: [
        {
          id: "height",
          metric: "sloc",
          target: "height",
          minimum: 10,
          maximum: 20,
        },
      ],
    });
    expect(mapped.application.buildings[0]?.size.y).toBe(0.000_000_25);
  });

  it("issues unforgeable, expiring, one-use administrator approvals bound to both digests", () => {
    let now = 1_000;
    const authority = new SafeExtensionApprovalAuthority({
      approvalIds: ["shared-policy"],
      now: () => now,
    });
    const configuration = {
      ...SAFE_EXTENSION_PRESETS[0],
      scope: { kind: "administrator", approvalId: "shared-policy" },
    };
    expect(() => evaluateSafeExtension(DEMO_MODEL, configuration)).toThrow(
      /not available/,
    );

    const forged = {
      kind: "safe-extension-administrator-approval",
      expiresAt: new Date(now + 1_000).toISOString(),
    } as unknown as SafeExtensionAdministratorApproval;
    expect(() =>
      evaluateSafeExtension(DEMO_MODEL, configuration, {
        administratorApproval: { authority, approval: forged },
      }),
    ).toThrow(/invalid/);

    const mismatched = authority.issue(DEMO_MODEL, configuration);
    expect(() =>
      evaluateSafeExtension(
        DEMO_MODEL,
        { ...configuration, name: "Changed after approval" },
        { administratorApproval: { authority, approval: mismatched } },
      ),
    ).toThrow(/does not match/);
    expect(() =>
      evaluateSafeExtension(DEMO_MODEL, configuration, {
        administratorApproval: { authority, approval: mismatched },
      }),
    ).toThrow(/already been used/);

    const modelBound = authority.issue(DEMO_MODEL, configuration);
    const changedModel = {
      ...DEMO_MODEL,
      buildings: [
        {
          ...DEMO_MODEL.buildings[0]!,
          metrics: {
            ...DEMO_MODEL.buildings[0]!.metrics,
            sloc: DEMO_MODEL.buildings[0]!.metrics.sloc + 1,
          },
        },
        ...DEMO_MODEL.buildings.slice(1),
      ],
    };
    expect(() =>
      evaluateSafeExtension(changedModel, configuration, {
        administratorApproval: { authority, approval: modelBound },
      }),
    ).toThrow(/does not match/);

    const once = authority.issue(DEMO_MODEL, configuration);
    const administratorEvaluation = evaluateSafeExtension(
      DEMO_MODEL,
      configuration,
      { administratorApproval: { authority, approval: once } },
    );
    expect(administratorEvaluation.binding.scope).toBe("administrator");
    expect(() =>
      evaluateSafeExtension(DEMO_MODEL, configuration, {
        administratorApproval: { authority, approval: once },
      }),
    ).toThrow(/already been used/);

    const clonedAdministratorEvaluation = structuredClone(
      administratorEvaluation,
    );
    expect(() =>
      applySafeExtensionEvaluation(
        DEMO_MODEL,
        clonedAdministratorEvaluation,
        applicationReceipt(DEMO_MODEL, clonedAdministratorEvaluation),
      ),
    ).toThrow(/not an unused approved evaluation/);
    const administratorApplication = applicationReceipt(
      DEMO_MODEL,
      administratorEvaluation,
    );
    expect(
      applySafeExtensionEvaluation(
        DEMO_MODEL,
        administratorEvaluation,
        administratorApplication,
      ),
    ).toBe(DEMO_MODEL);
    expect(() =>
      applySafeExtensionEvaluation(
        DEMO_MODEL,
        administratorEvaluation,
        administratorApplication,
      ),
    ).toThrow(/application receipt is invalid or has already been used/);

    const expired = authority.issue(DEMO_MODEL, configuration, 10);
    now += 11;
    expect(() =>
      evaluateSafeExtension(DEMO_MODEL, configuration, {
        administratorApproval: { authority, approval: expired },
      }),
    ).toThrow(/expired/);
  });

  it("caps result sets with an explicit diagnostic and honors cancellation checkpoints", () => {
    const configuration = validateSafeExtensionConfiguration({
      version: EXTENSION_CONFIGURATION_VERSION,
      id: "bounded-results",
      name: "Bounded results",
      compatibility: {
        cityModel: "1.x",
        capabilities: ["filters", "queries", "overlays"],
      },
      scope: { kind: "project" },
      filters: [
        { id: "all", metric: "sloc", operator: "atLeast", value: 0 },
      ],
      queries: [{ id: "all-query", filterId: "all" }],
      overlays: [{ id: "all-overlay", filterId: "all", color: "#123456" }],
    });
    const evaluation = evaluateSafeExtension(snapshot(501), configuration);
    expect(evaluation.matches.all).toHaveLength(EXTENSION_LIMITS.resultRows);
    expect(evaluation.application.queries[0]?.buildingIds).toHaveLength(
      EXTENSION_LIMITS.resultRows,
    );
    expect(evaluation.diagnostics[0]?.message).toMatch(/additional matches/);
    expect(() =>
      evaluateSafeExtension(snapshot(1), SAFE_EXTENSION_PRESETS[0], {
        checkpoint: () => {
          throw new DOMException("cancelled", "AbortError");
        },
      }),
    ).toThrow(/cancelled/);
  });
});
