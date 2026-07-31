import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { DEMO_MODEL } from "../apps/viewer/src/demo-model.js";
import {
  EXTENSION_CONFIGURATION_VERSION,
  EXTENSION_LIMITS,
  SAFE_EXTENSION_PRESETS,
  SafeExtensionApprovalAuthority,
  applySafeExtensionEvaluation,
  createSafeExtensionModelSnapshot,
  evaluateSafeExtension,
  migrateSafeExtensionConfiguration,
  safeExtensionConfigurationDigest,
  safeExtensionModelDigest,
  validateSafeExtensionConfiguration,
  validateSafeExtensionEvaluation,
  type SafeExtensionAdministratorApproval,
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
    ]);
    const low = first.application.buildings.find(
      ({ id }) => id === "building-0000",
    )!;
    const high = first.application.buildings.find(
      ({ id }) => id === "building-0001",
    )!;
    expect(low.size.y).not.toBe(2);
    expect(high.size.x).toBe(4);
    expect(high.color).toBe("#00AA11");
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
    const projected = applySafeExtensionEvaluation(DEMO_MODEL, evaluation);
    expect(projected.buildings).toHaveLength(DEMO_MODEL.buildings.length);
    expect(projected.buildings[0]?.id).toBe(DEMO_MODEL.buildings[0]?.id);

    const forged = structuredClone(evaluation);
    forged.application.buildings[0]!.size.x = Number.NaN;
    expect(() => applySafeExtensionEvaluation(DEMO_MODEL, forged)).toThrow(
      /finite JSON numbers|bounded number/,
    );
    expect(() =>
      validateSafeExtensionEvaluation(evaluation, { model: snapshot() }),
    ).toThrow(/different project model/);
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

    const once = authority.issue(DEMO_MODEL, configuration);
    expect(
      evaluateSafeExtension(DEMO_MODEL, configuration, {
        administratorApproval: { authority, approval: once },
      }).binding.scope,
    ).toBe("administrator");
    expect(() =>
      evaluateSafeExtension(DEMO_MODEL, configuration, {
        administratorApproval: { authority, approval: once },
      }),
    ).toThrow(/already been used/);

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
