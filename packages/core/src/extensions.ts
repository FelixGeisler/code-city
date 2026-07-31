import type { CityModel, SourceMetrics } from "./model.js";

/**
 * Public, data-only extension contract. It deliberately has no script, URL,
 * module, file, credential, or command field: evaluating one is equivalent to
 * interpreting a small AST in the viewer worker, never executing user code.
 */
export const EXTENSION_CONFIGURATION_VERSION = "codecity.extensions/1" as const;
export const EXTENSION_CAPABILITIES = [
  "derived-metrics", "mappings", "filters", "legends", "layouts", "queries", "overlays",
] as const;
export type ExtensionCapability = (typeof EXTENSION_CAPABILITIES)[number];
export const EXTENSION_LIMITS = Object.freeze({ bytes: 128 * 1024, definitions: 32, expressionNodes: 64, expressionDepth: 12, identifierCharacters: 64, labelCharacters: 160, operations: 200_000, resultRows: 500 });

export type ExtensionExpression =
  | { readonly op: "constant"; readonly value: number }
  | { readonly op: "metric"; readonly metric: keyof SourceMetrics }
  | { readonly op: "add" | "subtract" | "multiply" | "divide" | "minimum" | "maximum"; readonly left: ExtensionExpression; readonly right: ExtensionExpression }
  | { readonly op: "log1p" | "absolute" | "negate"; readonly value: ExtensionExpression };

export interface SafeExtensionConfigurationV1 {
  readonly version: typeof EXTENSION_CONFIGURATION_VERSION;
  readonly id: string;
  readonly name: string;
  readonly compatibility: { readonly cityModel: "1.x"; readonly capabilities: readonly ExtensionCapability[] };
  readonly scope: { readonly kind: "project" } | { readonly kind: "administrator"; readonly approvalId: string };
  readonly derivedMetrics?: readonly { readonly id: string; readonly label: string; readonly expression: ExtensionExpression }[];
  readonly mappings?: readonly { readonly id: string; readonly metric: string; readonly target: "color" | "height" | "footprint"; readonly minimum: number; readonly maximum: number }[];
  readonly filters?: readonly { readonly id: string; readonly metric: string; readonly operator: "atLeast" | "atMost"; readonly value: number }[];
  readonly legends?: readonly { readonly id: string; readonly label: string; readonly mappingId: string }[];
  readonly layouts?: readonly { readonly id: string; readonly strategy: "preserve-city" | "group-by-module" }[];
  readonly queries?: readonly { readonly id: string; readonly filterId: string }[];
  readonly overlays?: readonly { readonly id: string; readonly filterId: string; readonly color: string }[];
}

export interface ExtensionDiagnostic { readonly path: string; readonly message: string; }
export interface ExtensionEvaluation { readonly configuration: SafeExtensionConfigurationV1; readonly diagnostics: readonly ExtensionDiagnostic[]; readonly derivedMetrics: Readonly<Record<string, Readonly<Record<string, number>>>>; readonly matches: Readonly<Record<string, readonly string[]>>; }

const metricKeys = ["sloc", "decisionLoad", "maximumComplexity", "executableUnitCount"] as const satisfies readonly (keyof SourceMetrics)[];
const forbiddenKeys = new Set(["__proto__", "prototype", "constructor"]);
function plain(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
function exact(value: unknown, keys: readonly string[], path: string): Record<string, unknown> { if (!plain(value) || Object.keys(value).some((key) => forbiddenKeys.has(key)) || Object.keys(value).length !== keys.length || !keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))) throw new TypeError(`${path} has unsupported properties.`); return value; }
function identifier(value: unknown, path: string): string { if (typeof value !== "string" || !/^[a-z][a-z0-9-]*$/u.test(value) || value.length > EXTENSION_LIMITS.identifierCharacters) throw new TypeError(`${path} must be a bounded lowercase identifier.`); return value; }
function label(value: unknown, path: string): string { if (typeof value !== "string" || value.trim().length === 0 || value.length > EXTENSION_LIMITS.labelCharacters || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)) throw new TypeError(`${path} must be visible text.`); return value; }
function number(value: unknown, path: string): number { if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 1_000_000_000) throw new TypeError(`${path} must be a finite bounded number.`); return value; }
function array(value: unknown, path: string): readonly unknown[] { if (!Array.isArray(value) || value.length > EXTENSION_LIMITS.definitions) throw new TypeError(`${path} must be a bounded array.`); return value; }
function optionalArray(value: Record<string, unknown>, key: string): readonly unknown[] { return value[key] === undefined ? [] : array(value[key], key); }
function capability(value: unknown, path: string): ExtensionCapability { if (typeof value !== "string" || !(EXTENSION_CAPABILITIES as readonly string[]).includes(value)) throw new TypeError(`${path} is unsupported.`); return value as ExtensionCapability; }
function serializedByteLength(value: unknown): number {
  let serialized: string | undefined;
  try { serialized = JSON.stringify(value); }
  catch { throw new TypeError("configuration must be serializable JSON."); }
  if (serialized === undefined) throw new TypeError("configuration must be serializable JSON.");
  return new TextEncoder().encode(serialized).byteLength;
}

function expression(value: unknown, path: string, state: { nodes: number; depth: number }): ExtensionExpression {
  state.nodes++; state.depth++;
  if (state.nodes > EXTENSION_LIMITS.expressionNodes || state.depth > EXTENSION_LIMITS.expressionDepth) throw new RangeError(`${path} exceeds expression limits.`);
  try {
    const candidate = plain(value) ? value : undefined;
    if (!candidate || typeof candidate.op !== "string") throw new TypeError(`${path} must be an expression.`);
    if (candidate.op === "constant") { exact(candidate, ["op", "value"], path); return Object.freeze({ op: "constant", value: number(candidate.value, `${path}.value`) }); }
    if (candidate.op === "metric") { exact(candidate, ["op", "metric"], path); if (typeof candidate.metric !== "string" || !metricKeys.includes(candidate.metric as keyof SourceMetrics)) throw new TypeError(`${path}.metric is unsupported.`); return Object.freeze({ op: "metric", metric: candidate.metric as keyof SourceMetrics }); }
    if (["log1p", "absolute", "negate"].includes(candidate.op)) { exact(candidate, ["op", "value"], path); return Object.freeze({ op: candidate.op as "log1p" | "absolute" | "negate", value: expression(candidate.value, `${path}.value`, state) }); }
    if (["add", "subtract", "multiply", "divide", "minimum", "maximum"].includes(candidate.op)) { exact(candidate, ["op", "left", "right"], path); return Object.freeze({ op: candidate.op as "add" | "subtract" | "multiply" | "divide" | "minimum" | "maximum", left: expression(candidate.left, `${path}.left`, state), right: expression(candidate.right, `${path}.right`, state) }); }
    throw new TypeError(`${path}.op is unsupported.`);
  } finally { state.depth--; }
}

/** Strictly validates and deep-copies a configuration; unsupported versions fail closed. */
export function validateSafeExtensionConfiguration(value: unknown): SafeExtensionConfigurationV1 {
  if (serializedByteLength(value) > EXTENSION_LIMITS.bytes) throw new RangeError("configuration exceeds the byte limit.");
  if (!plain(value)) throw new TypeError("configuration must be an object.");
  const candidate = value;
  const allowed = new Set(["version", "id", "name", "compatibility", "scope", "derivedMetrics", "mappings", "filters", "legends", "layouts", "queries", "overlays"]);
  if (Object.keys(candidate).some((key) => !allowed.has(key)) || candidate.version !== EXTENSION_CONFIGURATION_VERSION) throw new TypeError("Unsupported extension configuration version.");
  const compatibility = exact(candidate.compatibility, ["cityModel", "capabilities"], "compatibility");
  if (compatibility.cityModel !== "1.x") throw new TypeError("This extension is not compatible with the city model.");
  const capabilities = array(compatibility.capabilities, "compatibility.capabilities").map((item, index) => capability(item, `compatibility.capabilities[${index}]`));
  if (new Set(capabilities).size !== capabilities.length) throw new TypeError("Capabilities must be unique.");
  const scopeInput = plain(candidate.scope) ? candidate.scope : undefined;
  if (!scopeInput) throw new TypeError("scope is required.");
  const scope = scopeInput.kind === "project" ? (exact(scopeInput, ["kind"], "scope"), Object.freeze({ kind: "project" as const })) : scopeInput.kind === "administrator" ? (exact(scopeInput, ["kind", "approvalId"], "scope"), Object.freeze({ kind: "administrator" as const, approvalId: identifier(scopeInput.approvalId, "scope.approvalId") })) : (() => { throw new TypeError("scope is unsupported."); })();
  const ids = new Set<string>(); const unique = (id: string, path: string) => { if (ids.has(id)) throw new TypeError(`${path} duplicates '${id}'.`); ids.add(id); return id; };
  const derivedMetrics = optionalArray(candidate, "derivedMetrics").map((item, index) => { const entry = exact(item, ["id", "label", "expression"], `derivedMetrics[${index}]`); return Object.freeze({ id: unique(identifier(entry.id, `derivedMetrics[${index}].id`), `derivedMetrics[${index}].id`), label: label(entry.label, `derivedMetrics[${index}].label`), expression: expression(entry.expression, `derivedMetrics[${index}].expression`, { nodes: 0, depth: 0 }) }); });
  const metricExists = (metric: unknown, path: string) => { const id = identifier(metric, path); if (!metricKeys.includes(id as keyof SourceMetrics) && !derivedMetrics.some((entry) => entry.id === id)) throw new TypeError(`${path} must reference a built-in or derived metric.`); return id; };
  const mappings = optionalArray(candidate, "mappings").map((item, index) => { const entry = exact(item, ["id", "metric", "target", "minimum", "maximum"], `mappings[${index}]`); const minimum = number(entry.minimum, `mappings[${index}].minimum`), maximum = number(entry.maximum, `mappings[${index}].maximum`); if (minimum > maximum || !["color", "height", "footprint"].includes(String(entry.target))) throw new TypeError(`mappings[${index}] has invalid bounds or target.`); return Object.freeze({ id: unique(identifier(entry.id, `mappings[${index}].id`), `mappings[${index}].id`), metric: metricExists(entry.metric, `mappings[${index}].metric`), target: entry.target as "color" | "height" | "footprint", minimum, maximum }); });
  const filters = optionalArray(candidate, "filters").map((item, index) => { const entry = exact(item, ["id", "metric", "operator", "value"], `filters[${index}]`); if (entry.operator !== "atLeast" && entry.operator !== "atMost") throw new TypeError(`filters[${index}].operator is unsupported.`); return Object.freeze({ id: unique(identifier(entry.id, `filters[${index}].id`), `filters[${index}].id`), metric: metricExists(entry.metric, `filters[${index}].metric`), operator: entry.operator, value: number(entry.value, `filters[${index}].value`) }); });
  const filterExists = (value: unknown, path: string) => { const id = identifier(value, path); if (!filters.some((entry) => entry.id === id)) throw new TypeError(`${path} must reference a filter.`); return id; };
  const legends = optionalArray(candidate, "legends").map((item, index) => { const entry = exact(item, ["id", "label", "mappingId"], `legends[${index}]`); const mappingId = identifier(entry.mappingId, `legends[${index}].mappingId`); if (!mappings.some((mapping) => mapping.id === mappingId)) throw new TypeError(`legends[${index}].mappingId must reference a mapping.`); return Object.freeze({ id: unique(identifier(entry.id, `legends[${index}].id`), `legends[${index}].id`), label: label(entry.label, `legends[${index}].label`), mappingId }); });
  const layouts = optionalArray(candidate, "layouts").map((item, index) => { const entry = exact(item, ["id", "strategy"], `layouts[${index}]`); if (entry.strategy !== "preserve-city" && entry.strategy !== "group-by-module") throw new TypeError(`layouts[${index}].strategy is unsupported.`); return Object.freeze({ id: unique(identifier(entry.id, `layouts[${index}].id`), `layouts[${index}].id`), strategy: entry.strategy }); });
  const queries = optionalArray(candidate, "queries").map((item, index) => { const entry = exact(item, ["id", "filterId"], `queries[${index}]`); return Object.freeze({ id: unique(identifier(entry.id, `queries[${index}].id`), `queries[${index}].id`), filterId: filterExists(entry.filterId, `queries[${index}].filterId`) }); });
  const overlays = optionalArray(candidate, "overlays").map((item, index) => { const entry = exact(item, ["id", "filterId", "color"], `overlays[${index}]`); if (typeof entry.color !== "string" || !/^#[0-9a-fA-F]{6}$/u.test(entry.color)) throw new TypeError(`overlays[${index}].color must be a color.`); return Object.freeze({ id: unique(identifier(entry.id, `overlays[${index}].id`), `overlays[${index}].id`), filterId: filterExists(entry.filterId, `overlays[${index}].filterId`), color: entry.color.toUpperCase() }); });
  const present: Record<string, number> = { "derived-metrics": derivedMetrics.length, mappings: mappings.length, filters: filters.length, legends: legends.length, layouts: layouts.length, queries: queries.length, overlays: overlays.length };
  if (Object.values(present).reduce((sum, count) => sum + count, 0) > EXTENSION_LIMITS.definitions) throw new RangeError("configuration exceeds the total definition limit.");
  for (const item of capabilities) if (present[item] === 0) throw new TypeError(`Capability '${item}' is declared without a definition.`);
  for (const [item, count] of Object.entries(present)) if (count > 0 && !capabilities.includes(item as ExtensionCapability)) throw new TypeError(`Definitions for capability '${item}' must be declared.`);
  return Object.freeze({ version: EXTENSION_CONFIGURATION_VERSION, id: identifier(candidate.id, "id"), name: label(candidate.name, "name"), compatibility: Object.freeze({ cityModel: "1.x" as const, capabilities: Object.freeze(capabilities) }), scope, ...(derivedMetrics.length ? { derivedMetrics: Object.freeze(derivedMetrics) } : {}), ...(mappings.length ? { mappings: Object.freeze(mappings) } : {}), ...(filters.length ? { filters: Object.freeze(filters) } : {}), ...(legends.length ? { legends: Object.freeze(legends) } : {}), ...(layouts.length ? { layouts: Object.freeze(layouts) } : {}), ...(queries.length ? { queries: Object.freeze(queries) } : {}), ...(overlays.length ? { overlays: Object.freeze(overlays) } : {}) });
}

/** Migration is explicit and intentionally only supports the immediately preceding data-only format. */
export function migrateSafeExtensionConfiguration(value: unknown): SafeExtensionConfigurationV1 {
  if (plain(value) && value.version === "codecity.extensions/0") { const { version: _version, ...rest } = value; return validateSafeExtensionConfiguration({ ...rest, version: EXTENSION_CONFIGURATION_VERSION }); }
  return validateSafeExtensionConfiguration(value);
}

function evaluateExpression(expression: ExtensionExpression, metrics: SourceMetrics, checkpoint: (operations: number) => void): number {
  checkpoint(1);
  let value: number;
  switch (expression.op) {
    case "constant": value = expression.value; break;
    case "metric": value = metrics[expression.metric]; break;
    case "log1p": value = Math.log1p(Math.max(-0.999999, evaluateExpression(expression.value, metrics, checkpoint))); break;
    case "absolute": value = Math.abs(evaluateExpression(expression.value, metrics, checkpoint)); break;
    case "negate": value = -evaluateExpression(expression.value, metrics, checkpoint); break;
    default: {
      const left = evaluateExpression(expression.left, metrics, checkpoint);
      const right = evaluateExpression(expression.right, metrics, checkpoint);
      value = expression.op === "add" ? left + right : expression.op === "subtract" ? left - right : expression.op === "multiply" ? left * right : expression.op === "divide" ? (right === 0 ? 0 : left / right) : expression.op === "minimum" ? Math.min(left, right) : Math.max(left, right);
    }
  }
  return Number.isFinite(value) ? Math.max(-1_000_000_000, Math.min(1_000_000_000, value)) : 0;
}

/** Evaluates only bounded AST nodes against the already-loaded model. No I/O APIs are accepted or reachable. */
export function evaluateSafeExtension(model: Pick<CityModel, "schemaVersion" | "buildings">, candidate: unknown, options: { readonly checkpoint?: (operations: number) => void; readonly administratorApprovalIds?: readonly string[] } = {}): ExtensionEvaluation {
  const configuration = migrateSafeExtensionConfiguration(candidate);
  if (!model.schemaVersion.startsWith("1.")) throw new TypeError("The loaded city model is not compatible with this extension.");
  if (configuration.scope.kind === "administrator" && !options.administratorApprovalIds?.includes(configuration.scope.approvalId)) throw new TypeError(`Administrator approval '${configuration.scope.approvalId}' is not available in this deployment.`);
  let operations = 0; const checkpoint = (increment: number) => { operations += increment; if (operations > EXTENSION_LIMITS.operations) throw new RangeError("Extension evaluation exceeded its operation budget."); options.checkpoint?.(increment); };
  const derived: Record<string, Record<string, number>> = Object.create(null); const matches: Record<string, readonly string[]> = Object.create(null);
  for (const building of model.buildings) { checkpoint(1); const values: Record<string, number> = Object.create(null); for (const entry of configuration.derivedMetrics ?? []) values[entry.id] = evaluateExpression(entry.expression, building.metrics, checkpoint); derived[building.id] = Object.freeze(values); }
  for (const filter of configuration.filters ?? []) { const found: string[] = []; for (const building of model.buildings) { checkpoint(1); const value = metricKeys.includes(filter.metric as keyof SourceMetrics) ? building.metrics[filter.metric as keyof SourceMetrics] : derived[building.id]![filter.metric]!; if ((filter.operator === "atLeast" && value >= filter.value) || (filter.operator === "atMost" && value <= filter.value)) { if (found.length < EXTENSION_LIMITS.resultRows) found.push(building.id); } } matches[filter.id] = Object.freeze(found.sort()); }
  return Object.freeze({ configuration, diagnostics: Object.freeze([]), derivedMetrics: Object.freeze(derived), matches: Object.freeze(matches) });
}

export const SAFE_EXTENSION_PRESETS: readonly SafeExtensionConfigurationV1[] = Object.freeze([validateSafeExtensionConfiguration({ version: EXTENSION_CONFIGURATION_VERSION, id: "complexity-focus", name: "Complexity focus", compatibility: { cityModel: "1.x", capabilities: ["derived-metrics", "filters", "queries", "overlays"] }, scope: { kind: "project" }, derivedMetrics: [{ id: "complexity-pressure", label: "Complexity pressure", expression: { op: "multiply", left: { op: "metric", metric: "maximumComplexity" }, right: { op: "log1p", value: { op: "metric", metric: "sloc" } } } }], filters: [{ id: "high-pressure", metric: "complexity-pressure", operator: "atLeast", value: 20 }], queries: [{ id: "high-pressure-query", filterId: "high-pressure" }], overlays: [{ id: "high-pressure-overlay", filterId: "high-pressure", color: "#DC2626" }] })]);
