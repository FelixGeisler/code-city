import { readFile } from "node:fs/promises";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { EXTENSION_CONFIGURATION_VERSION, EXTENSION_LIMITS, SAFE_EXTENSION_PRESETS, evaluateSafeExtension, migrateSafeExtensionConfiguration, validateSafeExtensionConfiguration } from "../packages/core/src/extensions.js";
import type { CityModel } from "../packages/core/src/model.js";

const model: Pick<CityModel, "schemaVersion" | "buildings"> = { schemaVersion: "1.0", buildings: [{ id: "a", repositoryId: "r", moduleId: "m", districtId: "d", name: "a.ts", path: "a.ts", language: "typescript", metrics: { sloc: 100, decisionLoad: 5, maximumComplexity: 8, executableUnitCount: 2 }, risk: "low", semanticGroupId: "risk", position: { x: 0, y: 0, z: 0 }, size: { x: 1, y: 1, z: 1 } }] };
const schema = JSON.parse(await readFile(new URL("../packages/core/schema/safe-extension.schema.json", import.meta.url), "utf8")) as object;
const validateSchema = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
describe("safe declarative extensions", () => {
  it("publishes a schema that accepts the preset and rejects executable-looking definitions", () => {
    expect(validateSchema(SAFE_EXTENSION_PRESETS[0]), JSON.stringify(validateSchema.errors)).toBe(true);
    expect(validateSchema({ ...SAFE_EXTENSION_PRESETS[0], overlays: [{ script: "fetch('/secrets')" }] })).toBe(false);
  });
  it("evaluates the public preset deterministically without changing the city", () => { const result = evaluateSafeExtension(model, SAFE_EXTENSION_PRESETS[0]); expect(result.derivedMetrics.a!["complexity-pressure"]).toBeGreaterThan(0); expect(result.matches["high-pressure"]).toEqual(["a"]); });
  it("migrates the immediately previous data-only version", () => { const legacy = { ...SAFE_EXTENSION_PRESETS[0], version: "codecity.extensions/0" }; expect(migrateSafeExtensionConfiguration(legacy).version).toBe(EXTENSION_CONFIGURATION_VERSION); });
  it("rejects unknown versions and undeclared capability definitions", () => { expect(() => validateSafeExtensionConfiguration({ ...SAFE_EXTENSION_PRESETS[0], version: "codecity.extensions/99" })).toThrow(); expect(() => validateSafeExtensionConfiguration({ ...SAFE_EXTENSION_PRESETS[0], compatibility: { cityModel: "1.x", capabilities: ["layouts"] } })).toThrow(); });
  it("requires every definition kind to be declared as a capability", () => { expect(() => validateSafeExtensionConfiguration({ ...SAFE_EXTENSION_PRESETS[0], compatibility: { cityModel: "1.x", capabilities: ["derived-metrics", "filters", "queries"] } })).toThrow(/overlays.*declared/); });
  it("enforces aggregate byte and definition limits", () => {
    expect(() => validateSafeExtensionConfiguration({ ...SAFE_EXTENSION_PRESETS[0], padding: "x".repeat(EXTENSION_LIMITS.bytes) })).toThrow(/byte limit/);
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    expect(() => validateSafeExtensionConfiguration(cyclic)).toThrow(/serializable JSON/);
    const oversized = {
      ...SAFE_EXTENSION_PRESETS[0],
      queries: Array.from({ length: 16 }, (_, index) => ({ id: `query-${index}`, filterId: "high-pressure" })),
      overlays: Array.from({ length: 15 }, (_, index) => ({ id: `overlay-${index}`, filterId: "high-pressure", color: "#DC2626" })),
    };
    expect(() => validateSafeExtensionConfiguration(oversized)).toThrow(/total definition limit/);
  });
  it("fails administrator-scoped configurations closed without an allowlisted approval", () => {
    const configuration = { ...SAFE_EXTENSION_PRESETS[0], scope: { kind: "administrator", approvalId: "shared-policy" } };
    expect(() => evaluateSafeExtension(model, configuration)).toThrow(/not available/);
    expect(evaluateSafeExtension(model, configuration, { administratorApprovalIds: ["shared-policy"] }).matches["high-pressure"]).toEqual(["a"]);
  });
  it("rejects prototype-pollution and executable-looking fields", () => { const polluted = JSON.parse('{"version":"codecity.extensions/1","id":"x","name":"x","compatibility":{"cityModel":"1.x","capabilities":[]},"scope":{"kind":"project"},"__proto__":{"polluted":true}}'); expect(() => validateSafeExtensionConfiguration(polluted)).toThrow(); expect(() => validateSafeExtensionConfiguration({ ...SAFE_EXTENSION_PRESETS[0], script: "process.env.SECRET" })).toThrow(); });
  it("bounds pathological expressions and evaluation operations", () => { let expression: unknown = { op: "constant", value: 1 }; for (let index = 0; index < EXTENSION_LIMITS.expressionDepth + 2; index++) expression = { op: "negate", value: expression }; const candidate = { version: EXTENSION_CONFIGURATION_VERSION, id: "too-deep", name: "Too deep", compatibility: { cityModel: "1.x", capabilities: ["derived-metrics"] }, scope: { kind: "project" }, derivedMetrics: [{ id: "x", label: "x", expression }] }; expect(() => validateSafeExtensionConfiguration(candidate)).toThrow(/expression limits/); expect(() => evaluateSafeExtension(model, SAFE_EXTENSION_PRESETS[0], { checkpoint: () => { throw new DOMException("cancelled", "AbortError"); } })).toThrow(/cancelled/); });
});
