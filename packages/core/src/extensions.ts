import type {
  CityModel,
  SourceMetrics,
  Vector3,
} from "./model.js";
import { validateCityModel } from "./model-validation.js";

/**
 * Public, data-only extension contract. It deliberately has no script, URL,
 * module, file, credential, or command field: evaluating one is equivalent to
 * interpreting a small AST, never executing extension-provided code.
 */
export const EXTENSION_CONFIGURATION_VERSION =
  "codecity.extensions/1" as const;
export const EXTENSION_CAPABILITIES = [
  "derived-metrics",
  "mappings",
  "filters",
  "legends",
  "layouts",
  "queries",
  "overlays",
] as const;
export type ExtensionCapability =
  (typeof EXTENSION_CAPABILITIES)[number];

export const EXTENSION_LIMITS = Object.freeze({
  bytes: 128 * 1024,
  definitions: 32,
  expressionNodes: 64,
  aggregateExpressionNodes: 256,
  expressionDepth: 12,
  jsonDepth: 32,
  jsonNodes: 10_000,
  identifierCharacters: 64,
  labelCharacters: 160,
  operations: 200_000,
  resultRows: 500,
  modelBuildings: 25_000,
  modelBytes: 32 * 1024 * 1024,
  resultBytes: 32 * 1024 * 1024,
  approvalTtlMilliseconds: 60_000,
  approvalMaximumTtlMilliseconds: 5 * 60_000,
  applicationReceiptTtlMilliseconds: 30_000,
  applicationReceiptMaximumTtlMilliseconds: 60_000,
});

export type ExtensionExpression =
  | { readonly op: "constant"; readonly value: number }
  | { readonly op: "metric"; readonly metric: keyof SourceMetrics }
  | {
      readonly op:
        | "add"
        | "subtract"
        | "multiply"
        | "divide"
        | "minimum"
        | "maximum";
      readonly left: ExtensionExpression;
      readonly right: ExtensionExpression;
    }
  | {
      readonly op: "log1p" | "absolute" | "negate";
      readonly value: ExtensionExpression;
    };

export interface SafeExtensionConfigurationV1 {
  readonly version: typeof EXTENSION_CONFIGURATION_VERSION;
  readonly id: string;
  readonly name: string;
  readonly compatibility: {
    readonly cityModel: "1.x";
    readonly capabilities: readonly ExtensionCapability[];
  };
  readonly scope:
    | { readonly kind: "project" }
    | { readonly kind: "administrator"; readonly approvalId: string };
  readonly derivedMetrics?: readonly {
    readonly id: string;
    readonly label: string;
    readonly expression: ExtensionExpression;
  }[];
  readonly mappings?: readonly {
    readonly id: string;
    readonly metric: string;
    readonly target: "color" | "height" | "footprint";
    readonly minimum: number;
    readonly maximum: number;
  }[];
  readonly filters?: readonly {
    readonly id: string;
    readonly metric: string;
    readonly operator: "atLeast" | "atMost";
    readonly value: number;
  }[];
  readonly legends?: readonly {
    readonly id: string;
    readonly label: string;
    readonly mappingId: string;
  }[];
  readonly layouts?: readonly {
    readonly id: string;
    readonly strategy: "preserve-city" | "group-by-module";
  }[];
  readonly queries?: readonly {
    readonly id: string;
    readonly filterId: string;
  }[];
  readonly overlays?: readonly {
    readonly id: string;
    readonly filterId: string;
    readonly color: string;
  }[];
}

export interface ExtensionDiagnostic {
  readonly path: string;
  readonly message: string;
}

export interface SafeExtensionModelBuilding {
  readonly id: string;
  readonly moduleId: string;
  readonly districtId: string;
  readonly metrics: SourceMetrics;
  readonly position: Vector3;
  readonly size: Vector3;
}

/** Minimal, bounded worker input. No source text or unrelated model data crosses the clone boundary. */
export interface SafeExtensionModelSnapshot {
  readonly schemaVersion: "1.0";
  readonly buildings: readonly SafeExtensionModelBuilding[];
}

export interface ExtensionBuildingApplication {
  readonly id: string;
  readonly position: Vector3;
  readonly size: Vector3;
  readonly color?: string;
}

export interface ExtensionMappingApplication {
  readonly id: string;
  readonly metric: string;
  readonly target: "color" | "height" | "footprint";
  readonly minimum: number;
  readonly maximum: number;
  readonly clampedBelow: number;
  readonly clampedAbove: number;
}

export interface ExtensionLegendApplication {
  readonly id: string;
  readonly label: string;
  readonly mappingId: string;
  readonly target: "color" | "height" | "footprint";
  readonly minimum: number;
  readonly maximum: number;
  readonly minimumColor: string;
  readonly maximumColor: string;
}

export interface ExtensionLayoutApplication {
  readonly id: string;
  readonly strategy: "preserve-city" | "group-by-module";
}

export interface ExtensionQueryApplication {
  readonly id: string;
  readonly buildingIds: readonly string[];
}

export interface ExtensionOverlayApplication {
  readonly id: string;
  readonly color: string;
  readonly buildingIds: readonly string[];
}

export interface ExtensionApplication {
  readonly buildings: readonly ExtensionBuildingApplication[];
  readonly mappings: readonly ExtensionMappingApplication[];
  readonly legends: readonly ExtensionLegendApplication[];
  readonly layouts: readonly ExtensionLayoutApplication[];
  readonly queries: readonly ExtensionQueryApplication[];
  readonly overlays: readonly ExtensionOverlayApplication[];
}

export interface ExtensionEvaluationBinding {
  readonly configurationSha256: `sha256:${string}`;
  readonly modelSha256: `sha256:${string}`;
  readonly scope: "project" | "administrator";
}

export interface ExtensionEvaluation {
  readonly configuration: SafeExtensionConfigurationV1;
  readonly binding: ExtensionEvaluationBinding;
  readonly diagnostics: readonly ExtensionDiagnostic[];
  readonly derivedMetrics: Readonly<
    Record<string, Readonly<Record<string, number>>>
  >;
  readonly matches: Readonly<Record<string, readonly string[]>>;
  readonly application: ExtensionApplication;
}

const metricKeys = [
  "sloc",
  "decisionLoad",
  "maximumComplexity",
  "executableUnitCount",
] as const satisfies readonly (keyof SourceMetrics)[];
const forbiddenKeys = new Set(["__proto__", "prototype", "constructor"]);
const unsafeText = /[\p{Cc}\p{Cf}\p{Cs}]/u;
const coordinateMagnitude = 1_000_000;
const modelIdentifierCharacters = 256;
const COLOR_MINIMUM = "#2563EB";
const COLOR_MAXIMUM = "#DC2626";
const GEOMETRY_MINIMUM_COLOR = "#64748B";
const GEOMETRY_MAXIMUM_COLOR = "#E2E8F0";

function plain(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exact(
  value: unknown,
  keys: readonly string[],
  path: string,
): Record<string, unknown> {
  if (!plain(value)) throw new TypeError(`${path} must be an object.`);
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError(`${path} has unsupported properties.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Object.getOwnPropertyNames(value);
  if (
    actual.some((key) => forbiddenKeys.has(key)) ||
    actual.length !== keys.length ||
    !keys.every((key) => {
      const descriptor = descriptors[key];
      return (
        descriptor !== undefined &&
        descriptor.enumerable === true &&
        "value" in descriptor
      );
    })
  ) {
    throw new TypeError(`${path} has unsupported properties.`);
  }
  return value;
}

function identifier(value: unknown, path: string): string {
  if (
    typeof value !== "string" ||
    !/^[a-z][a-z0-9-]*$/u.test(value) ||
    value.length > EXTENSION_LIMITS.identifierCharacters ||
    forbiddenKeys.has(value)
  ) {
    throw new TypeError(`${path} must be a bounded lowercase identifier.`);
  }
  return value;
}

function modelIdentifier(value: unknown, path: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > modelIdentifierCharacters ||
    unsafeText.test(value)
  ) {
    throw new TypeError(`${path} must be a bounded model identifier.`);
  }
  return value;
}

function label(value: unknown, path: string): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > EXTENSION_LIMITS.labelCharacters ||
    unsafeText.test(value)
  ) {
    throw new TypeError(`${path} must be visible text.`);
  }
  return value;
}

function boundedNumber(value: unknown, path: string): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    Math.abs(value) > 1_000_000_000
  ) {
    throw new TypeError(`${path} must be a finite bounded number.`);
  }
  return Object.is(value, -0) ? 0 : value;
}

function metricNumber(value: unknown, path: string): number {
  const result = boundedNumber(value, path);
  if (result < 0) throw new RangeError(`${path} must not be negative.`);
  return result;
}

function array(
  value: unknown,
  path: string,
  maximum: number = EXTENSION_LIMITS.definitions,
): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new TypeError(`${path} must be a bounded array.`);
  }
  return value;
}

function optionalArray(
  value: Record<string, unknown>,
  key: string,
  maximum: number = EXTENSION_LIMITS.definitions,
): readonly unknown[] {
  return value[key] === undefined ? [] : array(value[key], key, maximum);
}

function capability(value: unknown, path: string): ExtensionCapability {
  if (
    typeof value !== "string" ||
    !(EXTENSION_CAPABILITIES as readonly string[]).includes(value)
  ) {
    throw new TypeError(`${path} is unsupported.`);
  }
  return value as ExtensionCapability;
}

interface JsonBounds {
  readonly bytes: number;
  readonly depth: number;
  readonly nodes: number;
  readonly arrayEntries: number;
  readonly objectKeys: number;
}

/** Rejects accessors, exotic prototypes, cycles, holes, and oversized graphs without serializing them. */
function boundedJsonByteLength(
  value: unknown,
  bounds: JsonBounds,
  description: string,
): number {
  const seen = new WeakSet<object>();
  const stack: { readonly value: unknown; readonly depth: number }[] = [
    { value, depth: 0 },
  ];
  let nodes = 0;
  let serializedBytes = 0;
  const observeBytes = (additional: number): void => {
    if (additional > bounds.bytes - serializedBytes) {
      throw new RangeError(`${description} exceeds the byte limit.`);
    }
    serializedBytes += additional;
  };
  const observeJsonString = (text: string): void => {
    observeBytes(2); // Opening and closing quotation marks.
    if (text.length > bounds.bytes - serializedBytes) {
      throw new RangeError(`${description} exceeds the byte limit.`);
    }
    for (let index = 0; index < text.length; index += 1) {
      const unit = text.charCodeAt(index);
      if (unit === 0x22 || unit === 0x5c) {
        observeBytes(2);
      } else if (unit <= 0x1f) {
        observeBytes(
          unit === 0x08 ||
            unit === 0x09 ||
            unit === 0x0a ||
            unit === 0x0c ||
            unit === 0x0d
            ? 2
            : 6,
        );
      } else if (unit <= 0x7f) {
        observeBytes(1);
      } else if (unit <= 0x7ff) {
        observeBytes(2);
      } else if (unit >= 0xd800 && unit <= 0xdbff) {
        const next = text.charCodeAt(index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          observeBytes(4);
          index += 1;
        } else {
          // Well-formed JSON.stringify escapes lone surrogates as \uXXXX.
          observeBytes(6);
        }
      } else if (unit >= 0xdc00 && unit <= 0xdfff) {
        observeBytes(6);
      } else {
        observeBytes(3);
      }
    }
  };
  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > bounds.nodes) {
      throw new RangeError(`${description} exceeds the aggregate node limit.`);
    }
    if (current.depth > bounds.depth) {
      throw new RangeError(`${description} exceeds the nesting limit.`);
    }
    const item = current.value;
    if (item === null) {
      observeBytes(4);
      continue;
    }
    if (typeof item === "boolean") {
      observeBytes(item ? 4 : 5);
      continue;
    }
    if (typeof item === "number") {
      if (!Number.isFinite(item)) {
        throw new TypeError(`${description} must contain finite JSON numbers.`);
      }
      observeBytes(String(Object.is(item, -0) ? 0 : item).length);
      continue;
    }
    if (typeof item === "string") {
      observeJsonString(item);
      continue;
    }
    if (typeof item !== "object" || item === undefined) {
      throw new TypeError(`${description} must contain JSON data only.`);
    }
    if (seen.has(item)) {
      throw new TypeError(`${description} must be acyclic JSON.`);
    }
    seen.add(item);
    if (Object.getOwnPropertySymbols(item).length > 0) {
      throw new TypeError(`${description} must not contain symbol properties.`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(item);
    const pushDescriptor = (key: string, depth: number): void => {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        descriptor.enumerable !== true ||
        !("value" in descriptor) ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined
      ) {
        throw new TypeError(`${description} must not contain accessors.`);
      }
      stack.push({ value: descriptor.value, depth });
    };
    if (Array.isArray(item)) {
      if (
        Object.getPrototypeOf(item) !== Array.prototype ||
        item.length > bounds.arrayEntries
      ) {
        throw new RangeError(`${description} contains an unsupported array.`);
      }
      const keys = Object.getOwnPropertyNames(item);
      if (
        keys.length !== item.length + 1 ||
        keys[keys.length - 1] !== "length"
      ) {
        throw new TypeError(
          `${description} must not contain sparse arrays or extra properties.`,
        );
      }
      observeBytes(2 + Math.max(0, item.length - 1));
      for (let index = item.length - 1; index >= 0; index -= 1) {
        pushDescriptor(String(index), current.depth + 1);
      }
      continue;
    }
    if (!plain(item)) {
      throw new TypeError(`${description} must contain plain JSON objects.`);
    }
    const keys = Object.getOwnPropertyNames(item);
    if (keys.length > bounds.objectKeys) {
      throw new RangeError(`${description} exceeds the object-key limit.`);
    }
    observeBytes(2 + Math.max(0, keys.length - 1));
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index]!;
      observeJsonString(key);
      observeBytes(1); // Property-name separator.
      pushDescriptor(key, current.depth + 1);
    }
  }
  return serializedBytes;
}

const configurationJsonBounds: JsonBounds = Object.freeze({
  bytes: EXTENSION_LIMITS.bytes,
  depth: EXTENSION_LIMITS.jsonDepth,
  nodes: EXTENSION_LIMITS.jsonNodes,
  arrayEntries: EXTENSION_LIMITS.definitions,
  objectKeys: EXTENSION_LIMITS.definitions,
});

const modelJsonBounds: JsonBounds = Object.freeze({
  bytes: EXTENSION_LIMITS.modelBytes,
  depth: 8,
  nodes: EXTENSION_LIMITS.modelBuildings * 20 + 8,
  arrayEntries: EXTENSION_LIMITS.modelBuildings,
  objectKeys: EXTENSION_LIMITS.modelBuildings,
});

const resultJsonBounds: JsonBounds = Object.freeze({
  bytes: EXTENSION_LIMITS.resultBytes,
  depth: EXTENSION_LIMITS.jsonDepth + 4,
  nodes:
    EXTENSION_LIMITS.modelBuildings * 20 +
    EXTENSION_LIMITS.operations * 2 +
    EXTENSION_LIMITS.jsonNodes,
  arrayEntries: EXTENSION_LIMITS.modelBuildings,
  objectKeys: EXTENSION_LIMITS.modelBuildings,
});

interface ExpressionState {
  nodes: number;
  depth: number;
  aggregate: { nodes: number };
}

function expression(
  value: unknown,
  path: string,
  state: ExpressionState,
): ExtensionExpression {
  state.nodes += 1;
  state.aggregate.nodes += 1;
  state.depth += 1;
  if (state.nodes > EXTENSION_LIMITS.expressionNodes) {
    throw new RangeError(`${path} exceeds the per-expression node limit.`);
  }
  if (state.aggregate.nodes > EXTENSION_LIMITS.aggregateExpressionNodes) {
    throw new RangeError("configuration exceeds the aggregate expression limit.");
  }
  if (state.depth > EXTENSION_LIMITS.expressionDepth) {
    throw new RangeError(`${path} exceeds the expression depth limit.`);
  }
  try {
    const candidate = plain(value) ? value : undefined;
    if (!candidate || typeof candidate.op !== "string") {
      throw new TypeError(`${path} must be an expression.`);
    }
    if (candidate.op === "constant") {
      exact(candidate, ["op", "value"], path);
      return Object.freeze({
        op: "constant",
        value: boundedNumber(candidate.value, `${path}.value`),
      });
    }
    if (candidate.op === "metric") {
      exact(candidate, ["op", "metric"], path);
      if (
        typeof candidate.metric !== "string" ||
        !metricKeys.includes(candidate.metric as keyof SourceMetrics)
      ) {
        throw new TypeError(`${path}.metric is unsupported.`);
      }
      return Object.freeze({
        op: "metric",
        metric: candidate.metric as keyof SourceMetrics,
      });
    }
    if (["log1p", "absolute", "negate"].includes(candidate.op)) {
      exact(candidate, ["op", "value"], path);
      return Object.freeze({
        op: candidate.op as "log1p" | "absolute" | "negate",
        value: expression(candidate.value, `${path}.value`, state),
      });
    }
    if (
      [
        "add",
        "subtract",
        "multiply",
        "divide",
        "minimum",
        "maximum",
      ].includes(candidate.op)
    ) {
      exact(candidate, ["op", "left", "right"], path);
      return Object.freeze({
        op: candidate.op as
          | "add"
          | "subtract"
          | "multiply"
          | "divide"
          | "minimum"
          | "maximum",
        left: expression(candidate.left, `${path}.left`, state),
        right: expression(candidate.right, `${path}.right`, state),
      });
    }
    throw new TypeError(`${path}.op is unsupported.`);
  } finally {
    state.depth -= 1;
  }
}

/** Strictly validates and deep-copies a configuration; unsupported versions fail closed. */
export function validateSafeExtensionConfiguration(
  value: unknown,
): SafeExtensionConfigurationV1 {
  boundedJsonByteLength(value, configurationJsonBounds, "configuration");
  if (!plain(value)) throw new TypeError("configuration must be an object.");
  const candidate = value;
  const allowed = new Set([
    "version",
    "id",
    "name",
    "compatibility",
    "scope",
    "derivedMetrics",
    "mappings",
    "filters",
    "legends",
    "layouts",
    "queries",
    "overlays",
  ]);
  if (
    Object.keys(candidate).some((key) => !allowed.has(key)) ||
    candidate.version !== EXTENSION_CONFIGURATION_VERSION
  ) {
    throw new TypeError("Unsupported extension configuration version.");
  }
  const compatibility = exact(
    candidate.compatibility,
    ["cityModel", "capabilities"],
    "compatibility",
  );
  if (compatibility.cityModel !== "1.x") {
    throw new TypeError("This extension is not compatible with the city model.");
  }
  const capabilities = array(
    compatibility.capabilities,
    "compatibility.capabilities",
    EXTENSION_CAPABILITIES.length,
  ).map((item, index) =>
    capability(item, `compatibility.capabilities[${index}]`),
  );
  if (new Set(capabilities).size !== capabilities.length) {
    throw new TypeError("Capabilities must be unique.");
  }
  const scopeInput = plain(candidate.scope) ? candidate.scope : undefined;
  if (!scopeInput) throw new TypeError("scope is required.");
  const scope =
    scopeInput.kind === "project"
      ? (exact(scopeInput, ["kind"], "scope"),
        Object.freeze({ kind: "project" as const }))
      : scopeInput.kind === "administrator"
        ? (exact(scopeInput, ["kind", "approvalId"], "scope"),
          Object.freeze({
            kind: "administrator" as const,
            approvalId: identifier(scopeInput.approvalId, "scope.approvalId"),
          }))
        : (() => {
            throw new TypeError("scope is unsupported.");
          })();
  const ids = new Set<string>();
  const unique = (id: string, path: string): string => {
    if (ids.has(id)) throw new TypeError(`${path} duplicates '${id}'.`);
    ids.add(id);
    return id;
  };
  const aggregate = { nodes: 0 };
  const derivedMetrics = optionalArray(candidate, "derivedMetrics").map(
    (item, index) => {
      const entry = exact(
        item,
        ["id", "label", "expression"],
        `derivedMetrics[${index}]`,
      );
      const derivedId = identifier(entry.id, `derivedMetrics[${index}].id`);
      if (metricKeys.includes(derivedId as keyof SourceMetrics)) {
        throw new TypeError(
          `derivedMetrics[${index}].id must not shadow a built-in metric.`,
        );
      }
      return Object.freeze({
        id: unique(
          derivedId,
          `derivedMetrics[${index}].id`,
        ),
        label: label(entry.label, `derivedMetrics[${index}].label`),
        expression: expression(
          entry.expression,
          `derivedMetrics[${index}].expression`,
          { nodes: 0, depth: 0, aggregate },
        ),
      });
    },
  );
  const metricExists = (metric: unknown, path: string): string => {
    if (
      typeof metric === "string" &&
      metricKeys.includes(metric as keyof SourceMetrics)
    ) {
      return metric;
    }
    const id = identifier(metric, path);
    if (!derivedMetrics.some((entry) => entry.id === id)) {
      throw new TypeError(
        `${path} must reference a built-in or derived metric.`,
      );
    }
    return id;
  };
  const mappingTargets = new Set<string>();
  const mappings = optionalArray(candidate, "mappings").map((item, index) => {
    const entry = exact(
      item,
      ["id", "metric", "target", "minimum", "maximum"],
      `mappings[${index}]`,
    );
    const minimum = boundedNumber(
      entry.minimum,
      `mappings[${index}].minimum`,
    );
    const maximum = boundedNumber(
      entry.maximum,
      `mappings[${index}].maximum`,
    );
    if (
      minimum >= maximum ||
      !["color", "height", "footprint"].includes(String(entry.target))
    ) {
      throw new TypeError(`mappings[${index}] has invalid bounds or target.`);
    }
    if (mappingTargets.has(String(entry.target))) {
      throw new TypeError(
        `mappings[${index}].target duplicates an existing target.`,
      );
    }
    mappingTargets.add(String(entry.target));
    return Object.freeze({
      id: unique(
        identifier(entry.id, `mappings[${index}].id`),
        `mappings[${index}].id`,
      ),
      metric: metricExists(entry.metric, `mappings[${index}].metric`),
      target: entry.target as "color" | "height" | "footprint",
      minimum,
      maximum,
    });
  });
  const filters = optionalArray(candidate, "filters").map((item, index) => {
    const entry = exact(
      item,
      ["id", "metric", "operator", "value"],
      `filters[${index}]`,
    );
    if (entry.operator !== "atLeast" && entry.operator !== "atMost") {
      throw new TypeError(`filters[${index}].operator is unsupported.`);
    }
    return Object.freeze({
      id: unique(
        identifier(entry.id, `filters[${index}].id`),
        `filters[${index}].id`,
      ),
      metric: metricExists(entry.metric, `filters[${index}].metric`),
      operator: entry.operator,
      value: boundedNumber(entry.value, `filters[${index}].value`),
    });
  });
  const filterExists = (value: unknown, path: string): string => {
    const id = identifier(value, path);
    if (!filters.some((entry) => entry.id === id)) {
      throw new TypeError(`${path} must reference a filter.`);
    }
    return id;
  };
  const legends = optionalArray(candidate, "legends").map((item, index) => {
    const entry = exact(
      item,
      ["id", "label", "mappingId"],
      `legends[${index}]`,
    );
    const mappingId = identifier(
      entry.mappingId,
      `legends[${index}].mappingId`,
    );
    if (!mappings.some((mapping) => mapping.id === mappingId)) {
      throw new TypeError(
        `legends[${index}].mappingId must reference a mapping.`,
      );
    }
    return Object.freeze({
      id: unique(
        identifier(entry.id, `legends[${index}].id`),
        `legends[${index}].id`,
      ),
      label: label(entry.label, `legends[${index}].label`),
      mappingId,
    });
  });
  const layouts = optionalArray(candidate, "layouts", 1).map((item, index) => {
    const entry = exact(item, ["id", "strategy"], `layouts[${index}]`);
    if (
      entry.strategy !== "preserve-city" &&
      entry.strategy !== "group-by-module"
    ) {
      throw new TypeError(`layouts[${index}].strategy is unsupported.`);
    }
    return Object.freeze({
      id: unique(
        identifier(entry.id, `layouts[${index}].id`),
        `layouts[${index}].id`,
      ),
      strategy: entry.strategy,
    });
  });
  const queries = optionalArray(candidate, "queries").map((item, index) => {
    const entry = exact(item, ["id", "filterId"], `queries[${index}]`);
    return Object.freeze({
      id: unique(
        identifier(entry.id, `queries[${index}].id`),
        `queries[${index}].id`,
      ),
      filterId: filterExists(entry.filterId, `queries[${index}].filterId`),
    });
  });
  const overlays = optionalArray(candidate, "overlays").map((item, index) => {
    const entry = exact(
      item,
      ["id", "filterId", "color"],
      `overlays[${index}]`,
    );
    if (
      typeof entry.color !== "string" ||
      !/^#[0-9a-fA-F]{6}$/u.test(entry.color)
    ) {
      throw new TypeError(`overlays[${index}].color must be a color.`);
    }
    return Object.freeze({
      id: unique(
        identifier(entry.id, `overlays[${index}].id`),
        `overlays[${index}].id`,
      ),
      filterId: filterExists(entry.filterId, `overlays[${index}].filterId`),
      color: entry.color.toUpperCase(),
    });
  });
  const present: Record<ExtensionCapability, number> = {
    "derived-metrics": derivedMetrics.length,
    mappings: mappings.length,
    filters: filters.length,
    legends: legends.length,
    layouts: layouts.length,
    queries: queries.length,
    overlays: overlays.length,
  };
  if (
    Object.values(present).reduce((sum, count) => sum + count, 0) >
    EXTENSION_LIMITS.definitions
  ) {
    throw new RangeError("configuration exceeds the total definition limit.");
  }
  for (const item of capabilities) {
    if (present[item] === 0) {
      throw new TypeError(`Capability '${item}' is declared without a definition.`);
    }
  }
  for (const [item, count] of Object.entries(present)) {
    if (count > 0 && !capabilities.includes(item as ExtensionCapability)) {
      throw new TypeError(
        `Definitions for capability '${item}' must be declared.`,
      );
    }
  }
  return Object.freeze({
    version: EXTENSION_CONFIGURATION_VERSION,
    id: identifier(candidate.id, "id"),
    name: label(candidate.name, "name"),
    compatibility: Object.freeze({
      cityModel: "1.x" as const,
      capabilities: Object.freeze(capabilities),
    }),
    scope,
    ...(derivedMetrics.length
      ? { derivedMetrics: Object.freeze(derivedMetrics) }
      : {}),
    ...(mappings.length ? { mappings: Object.freeze(mappings) } : {}),
    ...(filters.length ? { filters: Object.freeze(filters) } : {}),
    ...(legends.length ? { legends: Object.freeze(legends) } : {}),
    ...(layouts.length ? { layouts: Object.freeze(layouts) } : {}),
    ...(queries.length ? { queries: Object.freeze(queries) } : {}),
    ...(overlays.length ? { overlays: Object.freeze(overlays) } : {}),
  });
}

/** Migration is explicit and intentionally supports only the preceding data-only format. */
export function migrateSafeExtensionConfiguration(
  value: unknown,
): SafeExtensionConfigurationV1 {
  // Inspect the complete graph before reading or spreading even the legacy
  // discriminator. This keeps v0 migration inside the same accessor/size
  // boundary as the current format.
  boundedJsonByteLength(value, configurationJsonBounds, "configuration");
  const versionDescriptor = plain(value)
    ? Object.getOwnPropertyDescriptor(value, "version")
    : undefined;
  const version =
    versionDescriptor !== undefined && "value" in versionDescriptor
      ? versionDescriptor.value
      : undefined;
  if (plain(value) && version === "codecity.extensions/0") {
    const { version: _version, ...rest } = value;
    return validateSafeExtensionConfiguration({
      ...rest,
      version: EXTENSION_CONFIGURATION_VERSION,
    });
  }
  return validateSafeExtensionConfiguration(value);
}

function vector(
  value: unknown,
  path: string,
  positive: boolean,
): Vector3 {
  const candidate = exact(value, ["x", "y", "z"], path);
  const result = {
    x: boundedNumber(candidate.x, `${path}.x`),
    y: boundedNumber(candidate.y, `${path}.y`),
    z: boundedNumber(candidate.z, `${path}.z`),
  };
  for (const [axis, coordinate] of Object.entries(result)) {
    if (
      Math.abs(coordinate) > coordinateMagnitude ||
      (positive && coordinate <= 0)
    ) {
      throw new RangeError(`${path}.${axis} is outside the model bounds.`);
    }
  }
  return Object.freeze(result);
}

function metrics(value: unknown, path: string): SourceMetrics {
  const candidate = exact(value, metricKeys, path);
  return Object.freeze({
    sloc: metricNumber(candidate.sloc, `${path}.sloc`),
    decisionLoad: metricNumber(
      candidate.decisionLoad,
      `${path}.decisionLoad`,
    ),
    maximumComplexity: metricNumber(
      candidate.maximumComplexity,
      `${path}.maximumComplexity`,
    ),
    executableUnitCount: metricNumber(
      candidate.executableUnitCount,
      `${path}.executableUnitCount`,
    ),
  });
}

function snapshotBuilding(
  value: unknown,
  index: number,
): SafeExtensionModelBuilding {
  const path = `model.buildings[${index}]`;
  const candidate = exact(
    value,
    ["id", "moduleId", "districtId", "metrics", "position", "size"],
    path,
  );
  return Object.freeze({
    id: modelIdentifier(candidate.id, `${path}.id`),
    moduleId: modelIdentifier(candidate.moduleId, `${path}.moduleId`),
    districtId: modelIdentifier(candidate.districtId, `${path}.districtId`),
    metrics: metrics(candidate.metrics, `${path}.metrics`),
    position: vector(candidate.position, `${path}.position`, false),
    size: vector(candidate.size, `${path}.size`, true),
  });
}

export function validateSafeExtensionModelSnapshot(
  value: unknown,
): SafeExtensionModelSnapshot {
  boundedJsonByteLength(value, modelJsonBounds, "extension model snapshot");
  const candidate = exact(value, ["schemaVersion", "buildings"], "model");
  if (candidate.schemaVersion !== "1.0") {
    throw new TypeError(
      'The loaded city model must use the supported schema version "1.0".',
    );
  }
  const source = array(
    candidate.buildings,
    "model.buildings",
    EXTENSION_LIMITS.modelBuildings,
  );
  const ids = new Set<string>();
  const buildings = source.map((item, index) => {
    const building = snapshotBuilding(item, index);
    if (ids.has(building.id)) {
      throw new TypeError(`model.buildings[${index}].id is duplicated.`);
    }
    ids.add(building.id);
    return building;
  });
  return Object.freeze({
    schemaVersion: "1.0",
    buildings: Object.freeze(buildings),
  });
}

export function createSafeExtensionModelSnapshot(
  model:
    | Pick<CityModel, "schemaVersion" | "buildings">
    | SafeExtensionModelSnapshot,
): SafeExtensionModelSnapshot {
  if (model.schemaVersion !== "1.0") {
    throw new TypeError(
      'The loaded city model must use the supported schema version "1.0".',
    );
  }
  return validateSafeExtensionModelSnapshot({
    schemaVersion: model.schemaVersion,
    buildings: model.buildings.map((building) => ({
      id: building.id,
      moduleId: building.moduleId,
      districtId: building.districtId,
      metrics: building.metrics,
      position: building.position,
      size: building.size,
    })),
  });
}

const sha256Constants = Object.freeze([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
  0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

function sha256(value: string): `sha256:${string}` {
  const source = new TextEncoder().encode(value);
  const paddedLength = Math.ceil((source.length + 9) / 64) * 64;
  const bytes = new Uint8Array(paddedLength);
  bytes.set(source);
  bytes[source.length] = 0x80;
  const bitLength = source.length * 8;
  const view = new DataView(bytes.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);
  const hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const words = new Uint32Array(64);
  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4);
    }
    for (let index = 16; index < 64; index += 1) {
      const previous15 = words[index - 15]!;
      const previous2 = words[index - 2]!;
      const small0 =
        rotateRight(previous15, 7) ^
        rotateRight(previous15, 18) ^
        (previous15 >>> 3);
      const small1 =
        rotateRight(previous2, 17) ^
        rotateRight(previous2, 19) ^
        (previous2 >>> 10);
      words[index] =
        (words[index - 16]! + small0 + words[index - 7]! + small1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const large1 =
        rotateRight(e!, 6) ^ rotateRight(e!, 11) ^ rotateRight(e!, 25);
      const choice = (e! & f!) ^ (~e! & g!);
      const temporary1 =
        (h! + large1 + choice + sha256Constants[index]! + words[index]!) >>> 0;
      const large0 =
        rotateRight(a!, 2) ^ rotateRight(a!, 13) ^ rotateRight(a!, 22);
      const majority = (a! & b!) ^ (a! & c!) ^ (b! & c!);
      const temporary2 = (large0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d! + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }
    hash[0] = (hash[0]! + a!) >>> 0;
    hash[1] = (hash[1]! + b!) >>> 0;
    hash[2] = (hash[2]! + c!) >>> 0;
    hash[3] = (hash[3]! + d!) >>> 0;
    hash[4] = (hash[4]! + e!) >>> 0;
    hash[5] = (hash[5]! + f!) >>> 0;
    hash[6] = (hash[6]! + g!) >>> 0;
    hash[7] = (hash[7]! + h!) >>> 0;
  }
  return `sha256:${[...hash]
    .map((item) => item.toString(16).padStart(8, "0"))
    .join("")}`;
}

function configurationDigest(
  configuration: SafeExtensionConfigurationV1,
): `sha256:${string}` {
  return sha256(JSON.stringify(configuration));
}

function snapshotDigest(
  snapshot: SafeExtensionModelSnapshot,
): `sha256:${string}` {
  return sha256(JSON.stringify(snapshot));
}

export function safeExtensionConfigurationDigest(
  candidate: unknown,
): `sha256:${string}` {
  return configurationDigest(migrateSafeExtensionConfiguration(candidate));
}

export function safeExtensionModelDigest(
  model: Pick<CityModel, "schemaVersion" | "buildings"> | SafeExtensionModelSnapshot,
): `sha256:${string}` {
  return snapshotDigest(createSafeExtensionModelSnapshot(model));
}

function evaluationDigest(
  evaluation: ExtensionEvaluation,
): `sha256:${string}` {
  return sha256(JSON.stringify(evaluation));
}

declare const applicationReceiptBrand: unique symbol;
export interface SafeExtensionApplicationReceipt {
  readonly kind: "safe-extension-application-receipt";
  readonly expiresAt: string;
  readonly [applicationReceiptBrand]: true;
}

interface ApplicationReceiptRecord {
  readonly configurationSha256: `sha256:${string}`;
  readonly modelSha256: `sha256:${string}`;
  readonly evaluationSha256: `sha256:${string}`;
  readonly expiresAt: number;
  consumed: boolean;
}

export interface SafeExtensionApplicationAuthorityOptions {
  readonly now?: () => number;
}

/**
 * Trusted client-side handoff between a dedicated evaluator worker and the
 * renderer. Receipts are opaque identities, expire quickly, are consumed on
 * their first attempt, and bind the complete result as well as both inputs.
 */
export class SafeExtensionApplicationAuthority {
  readonly #now: () => number;
  readonly #records = new WeakMap<object, ApplicationReceiptRecord>();

  public constructor(options: SafeExtensionApplicationAuthorityOptions = {}) {
    this.#now = options.now ?? Date.now;
  }

  public issue(
    model:
      | Pick<CityModel, "schemaVersion" | "buildings">
      | SafeExtensionModelSnapshot,
    evaluation: ExtensionEvaluation,
    ttlMilliseconds: number =
      EXTENSION_LIMITS.applicationReceiptTtlMilliseconds,
  ): SafeExtensionApplicationReceipt {
    if (
      !Number.isSafeInteger(ttlMilliseconds) ||
      ttlMilliseconds < 1 ||
      ttlMilliseconds > EXTENSION_LIMITS.applicationReceiptMaximumTtlMilliseconds
    ) {
      throw new RangeError("Extension application receipt lifetime is invalid.");
    }
    const validated = validateSafeExtensionEvaluation(evaluation, { model });
    const issuedAt = this.#now();
    if (!Number.isSafeInteger(issuedAt)) {
      throw new RangeError("Extension application receipt clock is invalid.");
    }
    const expiresAt = issuedAt + ttlMilliseconds;
    if (!Number.isSafeInteger(expiresAt) || Math.abs(expiresAt) > 8.64e15) {
      throw new RangeError("Extension application receipt expiry is invalid.");
    }
    const receipt = Object.freeze({
      kind: "safe-extension-application-receipt" as const,
      expiresAt: new Date(expiresAt).toISOString(),
    }) as SafeExtensionApplicationReceipt;
    this.#records.set(receipt, {
      configurationSha256: validated.binding.configurationSha256,
      modelSha256: validated.binding.modelSha256,
      evaluationSha256: evaluationDigest(validated),
      expiresAt,
      consumed: false,
    });
    return receipt;
  }

  public consume(
    receipt: SafeExtensionApplicationReceipt,
    model:
      | Pick<CityModel, "schemaVersion" | "buildings">
      | SafeExtensionModelSnapshot,
    evaluation: ExtensionEvaluation,
  ): ExtensionEvaluation {
    const record =
      typeof receipt === "object" && receipt !== null
        ? this.#records.get(receipt)
        : undefined;
    if (record === undefined || record.consumed) {
      throw new TypeError(
        "Extension application receipt is invalid or has already been used.",
      );
    }
    record.consumed = true;
    if (this.#now() >= record.expiresAt) {
      throw new TypeError("Extension application receipt has expired.");
    }
    const validated = validateSafeExtensionEvaluation(evaluation, { model });
    if (
      record.configurationSha256 !== validated.binding.configurationSha256 ||
      record.modelSha256 !== validated.binding.modelSha256 ||
      record.evaluationSha256 !== evaluationDigest(validated)
    ) {
      throw new TypeError(
        "Extension application receipt does not match this result and project.",
      );
    }
    return validated;
  }
}

declare const administratorApprovalBrand: unique symbol;
export interface SafeExtensionAdministratorApproval {
  readonly kind: "safe-extension-administrator-approval";
  readonly expiresAt: string;
  readonly [administratorApprovalBrand]: true;
}

interface ApprovalRecord {
  readonly approvalId: string;
  readonly configurationSha256: `sha256:${string}`;
  readonly modelSha256: `sha256:${string}`;
  readonly expiresAt: number;
  consumed: boolean;
}

export interface SafeExtensionApprovalAuthorityOptions {
  readonly approvalIds: readonly string[];
  readonly now?: () => number;
}

/**
 * Trusted-host approval authority. Grants are opaque object identities held in
 * a private WeakMap, expire, are consumed once, and are bound to both digests.
 * A copied or structurally forged object is never accepted.
 */
export class SafeExtensionApprovalAuthority {
  readonly #approvalIds: ReadonlySet<string>;
  readonly #now: () => number;
  readonly #records = new WeakMap<object, ApprovalRecord>();

  public constructor(options: SafeExtensionApprovalAuthorityOptions) {
    if (
      !Array.isArray(options.approvalIds) ||
      options.approvalIds.length > EXTENSION_LIMITS.definitions
    ) {
      throw new TypeError("Administrator approval IDs must be bounded.");
    }
    const approvalIds = options.approvalIds.map((item, index) =>
      identifier(item, `approvalIds[${index}]`),
    );
    if (new Set(approvalIds).size !== approvalIds.length) {
      throw new TypeError("Administrator approval IDs must be unique.");
    }
    this.#approvalIds = new Set(approvalIds);
    this.#now = options.now ?? Date.now;
  }

  public issue(
    model: Pick<CityModel, "schemaVersion" | "buildings">,
    candidate: unknown,
    ttlMilliseconds: number = EXTENSION_LIMITS.approvalTtlMilliseconds,
  ): SafeExtensionAdministratorApproval {
    if (
      !Number.isSafeInteger(ttlMilliseconds) ||
      ttlMilliseconds < 1 ||
      ttlMilliseconds > EXTENSION_LIMITS.approvalMaximumTtlMilliseconds
    ) {
      throw new RangeError("Administrator approval lifetime is invalid.");
    }
    const configuration = migrateSafeExtensionConfiguration(candidate);
    if (configuration.scope.kind !== "administrator") {
      throw new TypeError("Only administrator-scoped extensions require approval.");
    }
    if (!this.#approvalIds.has(configuration.scope.approvalId)) {
      throw new TypeError(
        `Administrator approval '${configuration.scope.approvalId}' is not available in this deployment.`,
      );
    }
    const issuedAt = this.#now();
    if (!Number.isSafeInteger(issuedAt)) {
      throw new RangeError("Administrator approval clock is invalid.");
    }
    const expiresAt = issuedAt + ttlMilliseconds;
    if (!Number.isSafeInteger(expiresAt) || Math.abs(expiresAt) > 8.64e15) {
      throw new RangeError("Administrator approval expiry is invalid.");
    }
    const grant = Object.freeze({
      kind: "safe-extension-administrator-approval" as const,
      expiresAt: new Date(expiresAt).toISOString(),
    }) as SafeExtensionAdministratorApproval;
    this.#records.set(grant, {
      approvalId: configuration.scope.approvalId,
      configurationSha256: configurationDigest(configuration),
      modelSha256: safeExtensionModelDigest(model),
      expiresAt,
      consumed: false,
    });
    return grant;
  }

  public consume(
    approval: SafeExtensionAdministratorApproval,
    configuration: SafeExtensionConfigurationV1,
    modelSha256: `sha256:${string}`,
  ): void {
    const record =
      typeof approval === "object" && approval !== null
        ? this.#records.get(approval)
        : undefined;
    if (record === undefined || record.consumed) {
      throw new TypeError("Administrator approval is invalid or has already been used.");
    }
    record.consumed = true;
    if (this.#now() >= record.expiresAt) {
      throw new TypeError("Administrator approval has expired.");
    }
    if (
      configuration.scope.kind !== "administrator" ||
      record.approvalId !== configuration.scope.approvalId ||
      record.configurationSha256 !== configurationDigest(configuration) ||
      record.modelSha256 !== modelSha256
    ) {
      throw new TypeError(
        "Administrator approval does not match this extension and project.",
      );
    }
  }
}

function evaluateExpression(
  source: ExtensionExpression,
  sourceMetrics: SourceMetrics,
  checkpoint: (operations: number) => void,
  path: string,
): number {
  checkpoint(1);
  let value: number;
  switch (source.op) {
    case "constant":
      value = source.value;
      break;
    case "metric":
      value = sourceMetrics[source.metric];
      break;
    case "log1p": {
      const operand = evaluateExpression(
        source.value,
        sourceMetrics,
        checkpoint,
        `${path}.value`,
      );
      if (operand <= -1) {
        throw new RangeError(`${path} cannot take log1p of ${operand}.`);
      }
      value = Math.log1p(operand);
      break;
    }
    case "absolute":
      value = Math.abs(
        evaluateExpression(source.value, sourceMetrics, checkpoint, `${path}.value`),
      );
      break;
    case "negate":
      value = -evaluateExpression(
        source.value,
        sourceMetrics,
        checkpoint,
        `${path}.value`,
      );
      break;
    default: {
      const left = evaluateExpression(
        source.left,
        sourceMetrics,
        checkpoint,
        `${path}.left`,
      );
      const right = evaluateExpression(
        source.right,
        sourceMetrics,
        checkpoint,
        `${path}.right`,
      );
      if (source.op === "divide" && right === 0) {
        throw new RangeError(`${path} cannot divide by zero.`);
      }
      value =
        source.op === "add"
          ? left + right
          : source.op === "subtract"
            ? left - right
            : source.op === "multiply"
              ? left * right
              : source.op === "divide"
                ? left / right
                : source.op === "minimum"
                  ? Math.min(left, right)
                  : Math.max(left, right);
    }
  }
  if (!Number.isFinite(value) || Math.abs(value) > 1_000_000_000) {
    throw new RangeError(`${path} produced an out-of-range numeric result.`);
  }
  return Object.is(value, -0) ? 0 : value;
}

interface MutableBuildingApplication {
  readonly id: string;
  readonly moduleId: string;
  readonly districtId: string;
  position: { x: number; y: number; z: number };
  size: { x: number; y: number; z: number };
  color?: string;
}

interface HorizontalLayoutAnchor {
  readonly centerX: number;
  readonly minimumZ: number;
}

function horizontalLayoutAnchor(
  buildings: readonly MutableBuildingApplication[],
): HorizontalLayoutAnchor | undefined {
  if (buildings.length === 0) return undefined;
  let minimumX = Number.POSITIVE_INFINITY;
  let maximumX = Number.NEGATIVE_INFINITY;
  let minimumZ = Number.POSITIVE_INFINITY;
  for (const building of buildings) {
    minimumX = Math.min(minimumX, building.position.x - building.size.x / 2);
    maximumX = Math.max(maximumX, building.position.x + building.size.x / 2);
    minimumZ = Math.min(minimumZ, building.position.z - building.size.z / 2);
  }
  if (
    !Number.isFinite(minimumX) ||
    !Number.isFinite(maximumX) ||
    !Number.isFinite(minimumZ)
  ) {
    throw new RangeError("Extension layout anchor is invalid.");
  }
  return Object.freeze({
    centerX: (minimumX + maximumX) / 2,
    minimumZ,
  });
}

function metricValue(
  building: SafeExtensionModelBuilding,
  derived: Readonly<Record<string, Readonly<Record<string, number>>>>,
  metric: string,
): number {
  if (metricKeys.includes(metric as keyof SourceMetrics)) {
    return building.metrics[metric as keyof SourceMetrics];
  }
  const value = derived[building.id]?.[metric];
  if (value === undefined) {
    throw new TypeError(
      `Derived metric '${metric}' is unavailable for building '${building.id}'.`,
    );
  }
  return value;
}

function interpolateColor(normalized: number): string {
  const minimum = [0x25, 0x63, 0xeb];
  const maximum = [0xdc, 0x26, 0x26];
  return `#${minimum
    .map((start, index) =>
      Math.round(start + (maximum[index]! - start) * normalized)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`.toUpperCase();
}

function assertPresentationBounds(
  building: MutableBuildingApplication,
  path: string,
): void {
  assertGeometryBounds(building.position, building.size, path);
}

function assertGeometryBounds(
  position: Vector3,
  size: Vector3,
  path: string,
): void {
  for (const axis of ["x", "y", "z"] as const) {
    const coordinate = position[axis];
    const dimension = size[axis];
    if (
      !Number.isFinite(coordinate) ||
      Math.abs(coordinate) > coordinateMagnitude ||
      !Number.isFinite(dimension) ||
      dimension <= 0 ||
      dimension > coordinateMagnitude
    ) {
      throw new RangeError(`${path}.${axis} exceeds the geometry bounds.`);
    }
  }
}

function applyGroupByModuleLayout(
  buildings: readonly MutableBuildingApplication[],
  anchor: HorizontalLayoutAnchor | undefined,
  checkpoint: (operations: number) => void,
  path: string,
): void {
  if (buildings.length === 0) return;
  const moduleGroups = new Map<
    string,
    Map<string, MutableBuildingApplication[]>
  >();
  let maximumDistrictSize = 1;
  let maximumDistrictCount = 1;
  let maximumFootprint = 0;
  for (const building of buildings) {
    checkpoint(1);
    let moduleGroup = moduleGroups.get(building.moduleId);
    if (moduleGroup === undefined) {
      moduleGroup = new Map();
      moduleGroups.set(building.moduleId, moduleGroup);
    }
    let districtGroup = moduleGroup.get(building.districtId);
    if (districtGroup === undefined) {
      districtGroup = [];
      moduleGroup.set(building.districtId, districtGroup);
    }
    districtGroup.push(building);
    maximumDistrictSize = Math.max(
      maximumDistrictSize,
      districtGroup.length,
    );
    maximumDistrictCount = Math.max(
      maximumDistrictCount,
      moduleGroup.size,
    );
    maximumFootprint = Math.max(
      maximumFootprint,
      building.size.x,
      building.size.z,
    );
  }
  const orderedModules = [...moduleGroups.entries()].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  const moduleColumns = Math.ceil(Math.sqrt(orderedModules.length));
  const buildingColumns = Math.ceil(Math.sqrt(maximumDistrictSize));
  const districtColumns = Math.ceil(Math.sqrt(maximumDistrictCount));
  const buildingStride = maximumFootprint + 1;
  const districtStride =
    buildingColumns * buildingStride + maximumFootprint + 3;
  const moduleStride =
    districtColumns * districtStride + maximumFootprint + 3;
  const moduleRows = Math.ceil(orderedModules.length / moduleColumns);
  const totalX = Math.max(0, (moduleColumns - 1) * moduleStride);
  const totalZ = Math.max(0, (moduleRows - 1) * moduleStride);
  for (const [moduleIndex, [, moduleGroup]] of orderedModules.entries()) {
    const moduleOriginX =
      (moduleIndex % moduleColumns) * moduleStride - totalX / 2;
    const moduleOriginZ =
      Math.floor(moduleIndex / moduleColumns) * moduleStride - totalZ / 2;
    const orderedDistricts = [...moduleGroup.entries()].sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    for (const [districtIndex, [, districtGroup]] of orderedDistricts.entries()) {
      const districtOriginX =
        moduleOriginX + (districtIndex % districtColumns) * districtStride;
      const districtOriginZ =
        moduleOriginZ +
        Math.floor(districtIndex / districtColumns) * districtStride;
      const columns = Math.ceil(Math.sqrt(districtGroup.length));
      for (const [index, building] of districtGroup
        .sort((left, right) =>
          left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
        )
        .entries()) {
        checkpoint(1);
        building.position = {
          x: districtOriginX + (index % columns) * buildingStride,
          y: building.position.y,
          z:
            districtOriginZ +
            Math.floor(index / columns) * buildingStride,
        };
        assertPresentationBounds(building, `${path}.${building.id}`);
      }
    }
  }
  if (anchor !== undefined) {
    const projectedAnchor = horizontalLayoutAnchor(buildings)!;
    const offsetX = anchor.centerX - projectedAnchor.centerX;
    const offsetZ = anchor.minimumZ - projectedAnchor.minimumZ;
    for (const building of buildings) {
      checkpoint(1);
      building.position = {
        x: building.position.x + offsetX,
        y: building.position.y,
        z: building.position.z + offsetZ,
      };
      assertPresentationBounds(building, `${path}.${building.id}`);
    }
  }
}

export interface EvaluateSafeExtensionOptions {
  readonly checkpoint?: (operations: number) => void;
  readonly administratorApproval?: {
    readonly authority: SafeExtensionApprovalAuthority;
    readonly approval: SafeExtensionAdministratorApproval;
  };
}

const approvedAdministratorEvaluations = new WeakSet<ExtensionEvaluation>();

/** Evaluates bounded AST nodes against an already-loaded model. No I/O APIs are reachable. */
export function evaluateSafeExtension(
  model: Pick<CityModel, "schemaVersion" | "buildings"> | SafeExtensionModelSnapshot,
  candidate: unknown,
  options: EvaluateSafeExtensionOptions = {},
): ExtensionEvaluation {
  const configuration = migrateSafeExtensionConfiguration(candidate);
  const snapshot = createSafeExtensionModelSnapshot(model);
  const modelSha256 = snapshotDigest(snapshot);
  if (configuration.scope.kind === "administrator") {
    const approval = options.administratorApproval;
    if (approval === undefined) {
      throw new TypeError(
        `Administrator approval '${configuration.scope.approvalId}' is not available in this deployment.`,
      );
    }
    approval.authority.consume(approval.approval, configuration, modelSha256);
  }
  let operations = 0;
  const checkpoint = (increment: number): void => {
    operations += increment;
    if (operations > EXTENSION_LIMITS.operations) {
      throw new RangeError("Extension evaluation exceeded its operation budget.");
    }
    options.checkpoint?.(increment);
  };
  const diagnostics: ExtensionDiagnostic[] = [];
  const derived: Record<string, Readonly<Record<string, number>>> =
    Object.create(null) as Record<string, Readonly<Record<string, number>>>;
  for (const [buildingIndex, building] of snapshot.buildings.entries()) {
    checkpoint(1);
    const values: Record<string, number> = Object.create(null) as Record<
      string,
      number
    >;
    for (const [metricIndex, entry] of (
      configuration.derivedMetrics ?? []
    ).entries()) {
      values[entry.id] = evaluateExpression(
        entry.expression,
        building.metrics,
        checkpoint,
        `derivedMetrics[${metricIndex}].expression (building '${building.id}')`,
      );
    }
    derived[building.id] = Object.freeze(values);
  }
  const matches: Record<string, readonly string[]> = Object.create(null) as Record<
    string,
    readonly string[]
  >;
  for (const [filterIndex, filter] of (configuration.filters ?? []).entries()) {
    const found: string[] = [];
    let omitted = 0;
    for (const building of snapshot.buildings) {
      checkpoint(1);
      const value = metricValue(building, derived, filter.metric);
      if (
        (filter.operator === "atLeast" && value >= filter.value) ||
        (filter.operator === "atMost" && value <= filter.value)
      ) {
        if (found.length < EXTENSION_LIMITS.resultRows) found.push(building.id);
        else omitted += 1;
      }
    }
    matches[filter.id] = Object.freeze(found.sort());
    if (omitted > 0) {
      diagnostics.push(
        Object.freeze({
          path: `filters[${filterIndex}]`,
          message:
            `${omitted.toLocaleString("en-US")} additional matches were omitted ` +
            `at the ${EXTENSION_LIMITS.resultRows}-row result limit.`,
        }),
      );
    }
  }
  const mutable = snapshot.buildings.map<MutableBuildingApplication>((building) => ({
    id: building.id,
    moduleId: building.moduleId,
    districtId: building.districtId,
    position: { ...building.position },
    size: { ...building.size },
  }));
  const layoutAnchor = horizontalLayoutAnchor(mutable);
  const mutableById = new Map(mutable.map((building) => [building.id, building]));
  const sourceById = new Map(snapshot.buildings.map((building) => [building.id, building]));
  const mappingApplications: ExtensionMappingApplication[] = [];
  for (const [mappingIndex, mapping] of (configuration.mappings ?? []).entries()) {
    let clampedBelow = 0;
    let clampedAbove = 0;
    for (const building of mutable) {
      checkpoint(1);
      const source = sourceById.get(building.id)!;
      const value = metricValue(source, derived, mapping.metric);
      if (value < mapping.minimum) clampedBelow += 1;
      else if (value > mapping.maximum) clampedAbove += 1;
      const normalized = Math.min(
        1,
        Math.max(0, (value - mapping.minimum) / (mapping.maximum - mapping.minimum)),
      );
      if (mapping.target === "color") {
        building.color = interpolateColor(normalized);
      } else if (mapping.target === "height") {
        const ground = building.position.y - building.size.y / 2;
        building.size.y *= 0.25 + normalized * 1.75;
        building.position.y = ground + building.size.y / 2;
      } else {
        const factor = 0.5 + normalized * 1.5;
        building.size.x *= factor;
        building.size.z *= factor;
      }
      assertPresentationBounds(building, `mappings[${mappingIndex}].${building.id}`);
    }
    mappingApplications.push(
      Object.freeze({
        id: mapping.id,
        metric: mapping.metric,
        target: mapping.target,
        minimum: mapping.minimum,
        maximum: mapping.maximum,
        clampedBelow,
        clampedAbove,
      }),
    );
    if (clampedBelow + clampedAbove > 0) {
      diagnostics.push(
        Object.freeze({
          path: `mappings[${mappingIndex}]`,
          message:
            `${(clampedBelow + clampedAbove).toLocaleString("en-US")} values ` +
            "were explicitly clamped to the declared mapping range.",
        }),
      );
    }
  }
  const groupByModuleLayout = (configuration.layouts ?? []).some(
    ({ strategy }) => strategy === "group-by-module",
  );
  const preserveCityLayoutIndex = (configuration.layouts ?? []).findIndex(
    ({ strategy }) => strategy === "preserve-city",
  );
  const firstFootprintMappingIndex = (configuration.mappings ?? []).findIndex(
    ({ target }) => target === "footprint",
  );
  const footprintGeometryChanged = mutable.some((building) => {
    const source = sourceById.get(building.id)!;
    return building.size.x !== source.size.x || building.size.z !== source.size.z;
  });
  if (footprintGeometryChanged && preserveCityLayoutIndex >= 0) {
    throw new RangeError(
      `layouts[${preserveCityLayoutIndex}].strategy cannot preserve city positions ` +
        "when footprint mappings change horizontal geometry; use group-by-module.",
    );
  }
  if (footprintGeometryChanged && !groupByModuleLayout) {
    applyGroupByModuleLayout(
      mutable,
      layoutAnchor,
      checkpoint,
      "mappings.footprint-layout",
    );
    diagnostics.push(
      Object.freeze({
        path: `mappings[${firstFootprintMappingIndex}]`,
        message:
          "Footprint changes applied a deterministic collision-safe module and district relayout.",
      }),
    );
  }
  const layoutApplications = (configuration.layouts ?? []).map((layout, index) => {
    if (layout.strategy === "group-by-module") {
      applyGroupByModuleLayout(
        mutable,
        layoutAnchor,
        checkpoint,
        `layouts[${index}]`,
      );
    }
    return Object.freeze({ id: layout.id, strategy: layout.strategy });
  });
  const queryApplications = (configuration.queries ?? []).map((query) =>
    Object.freeze({
      id: query.id,
      buildingIds: Object.freeze([...(matches[query.filterId] ?? [])]),
    }),
  );
  const overlayApplications = (configuration.overlays ?? []).map((overlay) => {
    const buildingIds = Object.freeze([...(matches[overlay.filterId] ?? [])]);
    for (const buildingId of buildingIds) {
      checkpoint(1);
      const building = mutableById.get(buildingId);
      if (building !== undefined) building.color = overlay.color;
    }
    return Object.freeze({ id: overlay.id, color: overlay.color, buildingIds });
  });
  const mappingById = new Map(
    (configuration.mappings ?? []).map((mapping) => [mapping.id, mapping]),
  );
  const legendApplications = (configuration.legends ?? []).map((legend) => {
    const mapping = mappingById.get(legend.mappingId)!;
    return Object.freeze({
      id: legend.id,
      label: legend.label,
      mappingId: legend.mappingId,
      target: mapping.target,
      minimum: mapping.minimum,
      maximum: mapping.maximum,
      minimumColor:
        mapping.target === "color" ? COLOR_MINIMUM : GEOMETRY_MINIMUM_COLOR,
      maximumColor:
        mapping.target === "color" ? COLOR_MAXIMUM : GEOMETRY_MAXIMUM_COLOR,
    });
  });
  const buildings = Object.freeze(
    mutable
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
      .map((building) =>
        Object.freeze({
          id: building.id,
          position: Object.freeze({ ...building.position }),
          size: Object.freeze({ ...building.size }),
          ...(building.color === undefined ? {} : { color: building.color }),
        }),
      ),
  );
  const evaluation: ExtensionEvaluation = Object.freeze({
    configuration,
    binding: Object.freeze({
      configurationSha256: configurationDigest(configuration),
      modelSha256,
      scope: configuration.scope.kind,
    }),
    diagnostics: Object.freeze(diagnostics),
    derivedMetrics: Object.freeze(derived),
    matches: Object.freeze(matches),
    application: Object.freeze({
      buildings,
      mappings: Object.freeze(mappingApplications),
      legends: Object.freeze(legendApplications),
      layouts: Object.freeze(layoutApplications),
      queries: Object.freeze(queryApplications),
      overlays: Object.freeze(overlayApplications),
    }),
  });
  boundedJsonByteLength(evaluation, resultJsonBounds, "extension evaluation");
  if (configuration.scope.kind === "administrator") {
    approvedAdministratorEvaluations.add(evaluation);
  }
  return evaluation;
}

export interface ValidateSafeExtensionEvaluationOptions {
  readonly configuration?: unknown;
  readonly model?:
    | Pick<CityModel, "schemaVersion" | "buildings">
    | SafeExtensionModelSnapshot;
}

function digest(value: unknown, path: string): `sha256:${string}` {
  if (
    typeof value !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(value)
  ) {
    throw new TypeError(`${path} must be a SHA-256 digest.`);
  }
  return value as `sha256:${string}`;
}

function resultRecord(
  value: unknown,
  path: string,
  maximumKeys: number,
): Record<string, unknown> {
  if (!plain(value)) throw new TypeError(`${path} must be an object.`);
  const keys = Object.keys(value);
  if (keys.length > maximumKeys) {
    throw new RangeError(`${path} exceeds its result limit.`);
  }
  return value;
}

function visibleResultText(
  value: unknown,
  path: string,
  maximumCharacters: number,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumCharacters ||
    unsafeText.test(value)
  ) {
    throw new TypeError(`${path} must be bounded visible text.`);
  }
  return value;
}

function resultIds(
  value: unknown,
  path: string,
  allowedBuildingIds?: ReadonlySet<string>,
): readonly string[] {
  const source = array(value, path, EXTENSION_LIMITS.resultRows);
  const result = source.map((item, index) =>
    modelIdentifier(item, `${path}[${index}]`),
  );
  for (let index = 0; index < result.length; index += 1) {
    const id = result[index]!;
    if (index > 0 && result[index - 1]! >= id) {
      throw new TypeError(`${path} must contain unique sorted identifiers.`);
    }
    if (allowedBuildingIds !== undefined && !allowedBuildingIds.has(id)) {
      throw new TypeError(`${path} references an unknown building.`);
    }
  }
  return Object.freeze(result);
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Deeply validates and copies an evaluation crossing a worker or persistence
 * boundary. Supplying the request model/configuration additionally enforces
 * the digest binding and exact project membership.
 */
export function validateSafeExtensionEvaluation(
  value: unknown,
  options: ValidateSafeExtensionEvaluationOptions = {},
): ExtensionEvaluation {
  boundedJsonByteLength(value, resultJsonBounds, "extension evaluation");
  const candidate = exact(
    value,
    [
      "configuration",
      "binding",
      "diagnostics",
      "derivedMetrics",
      "matches",
      "application",
    ],
    "evaluation",
  );
  const configuration = validateSafeExtensionConfiguration(
    candidate.configuration,
  );
  if (!sameJson(configuration, candidate.configuration)) {
    throw new TypeError("evaluation.configuration must be canonical.");
  }
  if (
    options.configuration !== undefined &&
    configurationDigest(configuration) !==
      safeExtensionConfigurationDigest(options.configuration)
  ) {
    throw new TypeError("Extension preview belongs to a different configuration.");
  }
  const snapshot =
    options.model === undefined
      ? undefined
      : createSafeExtensionModelSnapshot(options.model);
  const allowedBuildingIds =
    snapshot === undefined
      ? undefined
      : new Set(snapshot.buildings.map((building) => building.id));
  const bindingInput = exact(
    candidate.binding,
    ["configurationSha256", "modelSha256", "scope"],
    "evaluation.binding",
  );
  const binding = Object.freeze({
    configurationSha256: digest(
      bindingInput.configurationSha256,
      "evaluation.binding.configurationSha256",
    ),
    modelSha256: digest(
      bindingInput.modelSha256,
      "evaluation.binding.modelSha256",
    ),
    scope:
      bindingInput.scope === "project" ||
      bindingInput.scope === "administrator"
        ? bindingInput.scope
        : (() => {
            throw new TypeError("evaluation.binding.scope is invalid.");
          })(),
  });
  if (
    binding.configurationSha256 !== configurationDigest(configuration) ||
    binding.scope !== configuration.scope.kind
  ) {
    throw new TypeError("Extension preview configuration binding is invalid.");
  }
  if (
    snapshot !== undefined &&
    binding.modelSha256 !== snapshotDigest(snapshot)
  ) {
    throw new TypeError("Extension preview belongs to a different project model.");
  }

  const diagnostics = array(
    candidate.diagnostics,
    "evaluation.diagnostics",
    EXTENSION_LIMITS.definitions,
  ).map((item, index) => {
    const entry = exact(
      item,
      ["path", "message"],
      `evaluation.diagnostics[${index}]`,
    );
    return Object.freeze({
      path: visibleResultText(
        entry.path,
        `evaluation.diagnostics[${index}].path`,
        512,
      ),
      message: visibleResultText(
        entry.message,
        `evaluation.diagnostics[${index}].message`,
        512,
      ),
    });
  });

  const derivedInput = resultRecord(
    candidate.derivedMetrics,
    "evaluation.derivedMetrics",
    EXTENSION_LIMITS.modelBuildings,
  );
  const expectedDerivedIds = (configuration.derivedMetrics ?? []).map(
    (entry) => entry.id,
  );
  const derivedKeys = Object.keys(derivedInput).sort();
  if (
    snapshot !== undefined &&
    (derivedKeys.length !== allowedBuildingIds!.size ||
      derivedKeys.some((id) => !allowedBuildingIds!.has(id)))
  ) {
    throw new TypeError("evaluation.derivedMetrics does not match the project.");
  }
  const derived: Record<string, Readonly<Record<string, number>>> =
    Object.create(null) as Record<string, Readonly<Record<string, number>>>;
  for (const buildingId of derivedKeys) {
    modelIdentifier(buildingId, "evaluation.derivedMetrics key");
    const valuesInput = resultRecord(
      derivedInput[buildingId],
      `evaluation.derivedMetrics.${buildingId}`,
      EXTENSION_LIMITS.definitions,
    );
    const keys = Object.keys(valuesInput);
    if (
      keys.length !== expectedDerivedIds.length ||
      expectedDerivedIds.some((id) => !Object.hasOwn(valuesInput, id))
    ) {
      throw new TypeError(
        `evaluation.derivedMetrics.${buildingId} has invalid metrics.`,
      );
    }
    const values: Record<string, number> = Object.create(null) as Record<
      string,
      number
    >;
    for (const metricId of expectedDerivedIds) {
      values[metricId] = boundedNumber(
        valuesInput[metricId],
        `evaluation.derivedMetrics.${buildingId}.${metricId}`,
      );
    }
    derived[buildingId] = Object.freeze(values);
  }

  const matchesInput = resultRecord(
    candidate.matches,
    "evaluation.matches",
    EXTENSION_LIMITS.definitions,
  );
  const filters = configuration.filters ?? [];
  if (
    Object.keys(matchesInput).length !== filters.length ||
    filters.some((filter) => !Object.hasOwn(matchesInput, filter.id))
  ) {
    throw new TypeError("evaluation.matches has invalid filters.");
  }
  const matches: Record<string, readonly string[]> = Object.create(null) as Record<
    string,
    readonly string[]
  >;
  for (const filter of filters) {
    matches[filter.id] = resultIds(
      matchesInput[filter.id],
      `evaluation.matches.${filter.id}`,
      allowedBuildingIds,
    );
  }

  const applicationInput = exact(
    candidate.application,
    ["buildings", "mappings", "legends", "layouts", "queries", "overlays"],
    "evaluation.application",
  );
  const buildingInputs = array(
    applicationInput.buildings,
    "evaluation.application.buildings",
    EXTENSION_LIMITS.modelBuildings,
  );
  if (
    snapshot !== undefined &&
    buildingInputs.length !== snapshot.buildings.length
  ) {
    throw new TypeError("evaluation.application.buildings does not match the project.");
  }
  const seenBuildingIds = new Set<string>();
  let previousBuildingId: string | undefined;
  const buildings = buildingInputs.map((item, index) => {
    if (!plain(item)) {
      throw new TypeError(`evaluation.application.buildings[${index}] must be an object.`);
    }
    const hasColor = Object.hasOwn(item, "color");
    const entry = exact(
      item,
      hasColor ? ["id", "position", "size", "color"] : ["id", "position", "size"],
      `evaluation.application.buildings[${index}]`,
    );
    const id = modelIdentifier(
      entry.id,
      `evaluation.application.buildings[${index}].id`,
    );
    if (
      seenBuildingIds.has(id) ||
      (previousBuildingId !== undefined && previousBuildingId >= id) ||
      (allowedBuildingIds !== undefined && !allowedBuildingIds.has(id))
    ) {
      throw new TypeError("evaluation.application.buildings has invalid identifiers.");
    }
    previousBuildingId = id;
    seenBuildingIds.add(id);
    let color: string | undefined;
    if (hasColor) {
      if (
        typeof entry.color !== "string" ||
        !/^#[0-9A-F]{6}$/u.test(entry.color)
      ) {
        throw new TypeError(
          `evaluation.application.buildings[${index}].color is invalid.`,
        );
      }
      color = entry.color;
    }
    return Object.freeze({
      id,
      position: vector(
        entry.position,
        `evaluation.application.buildings[${index}].position`,
        false,
      ),
      size: vector(
        entry.size,
        `evaluation.application.buildings[${index}].size`,
        true,
      ),
      ...(color === undefined ? {} : { color }),
    });
  });
  if (
    allowedBuildingIds !== undefined &&
    seenBuildingIds.size !== allowedBuildingIds.size
  ) {
    throw new TypeError("evaluation.application.buildings does not match the project.");
  }

  const mappingInputs = array(
    applicationInput.mappings,
    "evaluation.application.mappings",
    EXTENSION_LIMITS.definitions,
  );
  const configuredMappings = configuration.mappings ?? [];
  if (mappingInputs.length !== configuredMappings.length) {
    throw new TypeError("evaluation.application.mappings does not match the configuration.");
  }
  const mappings = mappingInputs.map((item, index) => {
    const entry = exact(
      item,
      [
        "id",
        "metric",
        "target",
        "minimum",
        "maximum",
        "clampedBelow",
        "clampedAbove",
      ],
      `evaluation.application.mappings[${index}]`,
    );
    const configured = configuredMappings[index]!;
    const clampedBelow = entry.clampedBelow;
    const clampedAbove = entry.clampedAbove;
    if (
      entry.id !== configured.id ||
      entry.metric !== configured.metric ||
      entry.target !== configured.target ||
      entry.minimum !== configured.minimum ||
      entry.maximum !== configured.maximum ||
      !Number.isSafeInteger(clampedBelow) ||
      !Number.isSafeInteger(clampedAbove) ||
      (clampedBelow as number) < 0 ||
      (clampedAbove as number) < 0 ||
      (clampedBelow as number) > buildingInputs.length ||
      (clampedAbove as number) > buildingInputs.length
    ) {
      throw new TypeError(
        `evaluation.application.mappings[${index}] is invalid.`,
      );
    }
    return Object.freeze({
      id: configured.id,
      metric: configured.metric,
      target: configured.target,
      minimum: configured.minimum,
      maximum: configured.maximum,
      clampedBelow: clampedBelow as number,
      clampedAbove: clampedAbove as number,
    });
  });

  const legendInputs = array(
    applicationInput.legends,
    "evaluation.application.legends",
    EXTENSION_LIMITS.definitions,
  );
  const configuredLegends = configuration.legends ?? [];
  if (legendInputs.length !== configuredLegends.length) {
    throw new TypeError("evaluation.application.legends does not match the configuration.");
  }
  const mappingById = new Map(
    configuredMappings.map((mapping) => [mapping.id, mapping]),
  );
  const legends = legendInputs.map((item, index) => {
    const entry = exact(
      item,
      [
        "id",
        "label",
        "mappingId",
        "target",
        "minimum",
        "maximum",
        "minimumColor",
        "maximumColor",
      ],
      `evaluation.application.legends[${index}]`,
    );
    const configured = configuredLegends[index]!;
    const mapping = mappingById.get(configured.mappingId)!;
    const minimumColor =
      mapping.target === "color" ? COLOR_MINIMUM : GEOMETRY_MINIMUM_COLOR;
    const maximumColor =
      mapping.target === "color" ? COLOR_MAXIMUM : GEOMETRY_MAXIMUM_COLOR;
    if (
      entry.id !== configured.id ||
      entry.label !== configured.label ||
      entry.mappingId !== configured.mappingId ||
      entry.target !== mapping.target ||
      entry.minimum !== mapping.minimum ||
      entry.maximum !== mapping.maximum ||
      entry.minimumColor !== minimumColor ||
      entry.maximumColor !== maximumColor
    ) {
      throw new TypeError(`evaluation.application.legends[${index}] is invalid.`);
    }
    return Object.freeze({
      id: configured.id,
      label: configured.label,
      mappingId: configured.mappingId,
      target: mapping.target,
      minimum: mapping.minimum,
      maximum: mapping.maximum,
      minimumColor,
      maximumColor,
    });
  });

  const layoutInputs = array(
    applicationInput.layouts,
    "evaluation.application.layouts",
    1,
  );
  const configuredLayouts = configuration.layouts ?? [];
  if (layoutInputs.length !== configuredLayouts.length) {
    throw new TypeError("evaluation.application.layouts does not match the configuration.");
  }
  const layouts = layoutInputs.map((item, index) => {
    const entry = exact(
      item,
      ["id", "strategy"],
      `evaluation.application.layouts[${index}]`,
    );
    const configured = configuredLayouts[index]!;
    if (entry.id !== configured.id || entry.strategy !== configured.strategy) {
      throw new TypeError(`evaluation.application.layouts[${index}] is invalid.`);
    }
    return Object.freeze({ id: configured.id, strategy: configured.strategy });
  });

  const queryInputs = array(
    applicationInput.queries,
    "evaluation.application.queries",
    EXTENSION_LIMITS.definitions,
  );
  const configuredQueries = configuration.queries ?? [];
  if (queryInputs.length !== configuredQueries.length) {
    throw new TypeError("evaluation.application.queries does not match the configuration.");
  }
  const queries = queryInputs.map((item, index) => {
    const entry = exact(
      item,
      ["id", "buildingIds"],
      `evaluation.application.queries[${index}]`,
    );
    const configured = configuredQueries[index]!;
    const buildingIds = resultIds(
      entry.buildingIds,
      `evaluation.application.queries[${index}].buildingIds`,
      allowedBuildingIds,
    );
    if (
      entry.id !== configured.id ||
      !sameJson(buildingIds, matches[configured.filterId])
    ) {
      throw new TypeError(`evaluation.application.queries[${index}] is invalid.`);
    }
    return Object.freeze({ id: configured.id, buildingIds });
  });

  const overlayInputs = array(
    applicationInput.overlays,
    "evaluation.application.overlays",
    EXTENSION_LIMITS.definitions,
  );
  const configuredOverlays = configuration.overlays ?? [];
  if (overlayInputs.length !== configuredOverlays.length) {
    throw new TypeError("evaluation.application.overlays does not match the configuration.");
  }
  const overlays = overlayInputs.map((item, index) => {
    const entry = exact(
      item,
      ["id", "color", "buildingIds"],
      `evaluation.application.overlays[${index}]`,
    );
    const configured = configuredOverlays[index]!;
    const buildingIds = resultIds(
      entry.buildingIds,
      `evaluation.application.overlays[${index}].buildingIds`,
      allowedBuildingIds,
    );
    if (
      entry.id !== configured.id ||
      entry.color !== configured.color ||
      !sameJson(buildingIds, matches[configured.filterId])
    ) {
      throw new TypeError(`evaluation.application.overlays[${index}] is invalid.`);
    }
    return Object.freeze({
      id: configured.id,
      color: configured.color,
      buildingIds,
    });
  });

  return Object.freeze({
    configuration,
    binding,
    diagnostics: Object.freeze(diagnostics),
    derivedMetrics: Object.freeze(derived),
    matches: Object.freeze(matches),
    application: Object.freeze({
      buildings: Object.freeze(buildings),
      mappings: Object.freeze(mappings),
      legends: Object.freeze(legends),
      layouts: Object.freeze(layouts),
      queries: Object.freeze(queries),
      overlays: Object.freeze(overlays),
    }),
  });
}

interface HorizontalExtent {
  minimumX: number;
  maximumX: number;
  minimumZ: number;
  maximumZ: number;
}

const extensionDistrictPadding = 0.5;

function includeHorizontal(
  extent: HorizontalExtent,
  position: Vector3,
  size: Vector3,
  frontRelief = 0,
): void {
  extent.minimumX = Math.min(extent.minimumX, position.x - size.x / 2);
  extent.maximumX = Math.max(extent.maximumX, position.x + size.x / 2);
  extent.minimumZ = Math.min(
    extent.minimumZ,
    position.z - size.z / 2 - frontRelief,
  );
  extent.maximumZ = Math.max(extent.maximumZ, position.z + size.z / 2);
}

function finiteHorizontalExtent(extent: HorizontalExtent): boolean {
  return (
    Number.isFinite(extent.minimumX) &&
    Number.isFinite(extent.maximumX) &&
    Number.isFinite(extent.minimumZ) &&
    Number.isFinite(extent.maximumZ)
  );
}

interface MutableDistrictApplication {
  readonly id: string;
  readonly moduleId: string;
  position: { x: number; y: number; z: number };
  size: { x: number; y: number; z: number };
}

function applyCollisionSafeDistrictLayout(
  model: CityModel,
  buildings: readonly MutableBuildingApplication[],
  districts: readonly MutableDistrictApplication[],
): void {
  if (districts.length === 0) return;
  const buildingsByDistrict = new Map<
    string,
    MutableBuildingApplication[]
  >();
  for (const building of buildings) {
    const group = buildingsByDistrict.get(building.districtId) ?? [];
    group.push(building);
    buildingsByDistrict.set(building.districtId, group);
  }
  const moduleGroups = new Map<string, MutableDistrictApplication[]>();
  let maximumDistrictCount = 1;
  let maximumWidth = 0;
  let maximumDepth = 0;
  for (const district of districts) {
    const group = moduleGroups.get(district.moduleId) ?? [];
    group.push(district);
    moduleGroups.set(district.moduleId, group);
    maximumDistrictCount = Math.max(maximumDistrictCount, group.length);
    maximumWidth = Math.max(maximumWidth, district.size.x);
    maximumDepth = Math.max(maximumDepth, district.size.z);
  }
  const orderedModules = [...moduleGroups.entries()].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  const moduleColumns = Math.ceil(Math.sqrt(orderedModules.length));
  const districtColumns = Math.ceil(Math.sqrt(maximumDistrictCount));
  const districtStrideX = maximumWidth + 1;
  const districtStrideZ = maximumDepth + 1;
  const moduleStrideX =
    districtColumns * districtStrideX + maximumWidth + 3;
  const moduleStrideZ =
    districtColumns * districtStrideZ + maximumDepth + 3;
  const moduleRows = Math.ceil(orderedModules.length / moduleColumns);
  const totalX = Math.max(0, (moduleColumns - 1) * moduleStrideX);
  const totalZ = Math.max(0, (moduleRows - 1) * moduleStrideZ);
  for (const [moduleIndex, [, group]] of orderedModules.entries()) {
    const moduleOriginX =
      (moduleIndex % moduleColumns) * moduleStrideX - totalX / 2;
    const moduleOriginZ =
      Math.floor(moduleIndex / moduleColumns) * moduleStrideZ - totalZ / 2;
    const orderedDistricts = [...group].sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    );
    for (const [districtIndex, district] of orderedDistricts.entries()) {
      const targetX =
        moduleOriginX +
        (districtIndex % districtColumns) * districtStrideX;
      const targetZ =
        moduleOriginZ +
        Math.floor(districtIndex / districtColumns) * districtStrideZ;
      const offsetX = targetX - district.position.x;
      const offsetZ = targetZ - district.position.z;
      district.position = {
        x: targetX,
        y: district.position.y,
        z: targetZ,
      };
      assertGeometryBounds(
        district.position,
        district.size,
        `application.districts.${district.id}`,
      );
      for (const building of buildingsByDistrict.get(district.id) ?? []) {
        building.position = {
          x: building.position.x + offsetX,
          y: building.position.y,
          z: building.position.z + offsetZ,
        };
        assertPresentationBounds(building, `application.${building.id}`);
      }
    }
  }

  const originalExtent: HorizontalExtent = {
    minimumX: Number.POSITIVE_INFINITY,
    maximumX: Number.NEGATIVE_INFINITY,
    minimumZ: Number.POSITIVE_INFINITY,
    maximumZ: Number.NEGATIVE_INFINITY,
  };
  for (const district of model.districts) {
    includeHorizontal(originalExtent, district.position, district.size);
  }
  const projectedExtent: HorizontalExtent = {
    minimumX: Number.POSITIVE_INFINITY,
    maximumX: Number.NEGATIVE_INFINITY,
    minimumZ: Number.POSITIVE_INFINITY,
    maximumZ: Number.NEGATIVE_INFINITY,
  };
  for (const district of districts) {
    includeHorizontal(projectedExtent, district.position, district.size);
  }
  if (
    !finiteHorizontalExtent(originalExtent) ||
    !finiteHorizontalExtent(projectedExtent)
  ) {
    throw new RangeError("Extension layout cannot be anchored to the city.");
  }
  const offsetX =
    (originalExtent.minimumX + originalExtent.maximumX) / 2 -
    (projectedExtent.minimumX + projectedExtent.maximumX) / 2;
  const offsetZ = originalExtent.minimumZ - projectedExtent.minimumZ;
  for (const district of districts) {
    district.position = {
      x: district.position.x + offsetX,
      y: district.position.y,
      z: district.position.z + offsetZ,
    };
    assertGeometryBounds(
      district.position,
      district.size,
      `application.districts.${district.id}`,
    );
    for (const building of buildingsByDistrict.get(district.id) ?? []) {
      building.position = {
        x: building.position.x + offsetX,
        y: building.position.y,
        z: building.position.z + offsetZ,
      };
      assertPresentationBounds(building, `application.${building.id}`);
    }
  }
}

/** Verifies every result, its digest binding, and applies coherent geometry. */
export function applySafeExtensionEvaluation(
  model: CityModel,
  evaluation: ExtensionEvaluation,
  application: {
    readonly authority: SafeExtensionApplicationAuthority;
    readonly receipt: SafeExtensionApplicationReceipt;
  },
): CityModel {
  const administratorAuthorized =
    typeof evaluation === "object" &&
    evaluation !== null &&
    approvedAdministratorEvaluations.delete(evaluation);
  let validated = application.authority.consume(
    application.receipt,
    model,
    evaluation,
  );
  if (
    validated.configuration.scope.kind === "administrator" &&
    !administratorAuthorized
  ) {
    throw new TypeError(
      "Administrator extension result is not an unused approved evaluation.",
    );
  }
  if (validated.configuration.scope.kind === "project") {
    const recomputed = validateSafeExtensionEvaluation(
      evaluateSafeExtension(model, validated.configuration),
      { model, configuration: validated.configuration },
    );
    if (evaluationDigest(recomputed) !== evaluationDigest(validated)) {
      throw new TypeError(
        "Extension result does not match deterministic evaluation.",
      );
    }
    validated = recomputed;
  }
  const presentations = new Map<string, ExtensionBuildingApplication>();
  for (const presentation of validated.application.buildings) {
    if (presentations.has(presentation.id)) {
      throw new TypeError("Extension preview contains duplicate building results.");
    }
    presentations.set(presentation.id, presentation);
  }
  if (
    presentations.size !== model.buildings.length ||
    model.buildings.some((building) => !presentations.has(building.id))
  ) {
    throw new TypeError("Extension preview does not match the project buildings.");
  }
  const mutableBuildings =
    model.buildings.map((building) => {
      const presentation = presentations.get(building.id)!;
      return {
        ...building,
        position: { ...presentation.position },
        size: { ...presentation.size },
      };
    });
  const horizontalGeometryChanged = model.buildings.some((building, index) => {
    const projected = mutableBuildings[index]!;
    return (
      building.position.x !== projected.position.x ||
      building.position.z !== projected.position.z ||
      building.size.x !== projected.size.x ||
      building.size.z !== projected.size.z
    );
  });
  const verticalGeometryChanged = model.buildings.some((building, index) => {
    const projected = mutableBuildings[index]!;
    return (
      building.position.y !== projected.position.y ||
      building.size.y !== projected.size.y
    );
  });
  if (!horizontalGeometryChanged && !verticalGeometryChanged) return model;
  const mutableDistricts = horizontalGeometryChanged
    ? (() => {
        const buildingsByDistrict = new Map<
          string,
          MutableBuildingApplication[]
        >();
        for (const building of mutableBuildings) {
          const group = buildingsByDistrict.get(building.districtId) ?? [];
          group.push(building);
          buildingsByDistrict.set(building.districtId, group);
        }
        return model.districts.map((district) => {
          const members = buildingsByDistrict.get(district.id) ?? [];
          if (members.length === 0) {
            return {
              ...district,
              position: { ...district.position },
              size: { ...district.size },
            };
          }
          const extent: HorizontalExtent = {
            minimumX: Number.POSITIVE_INFINITY,
            maximumX: Number.NEGATIVE_INFINITY,
            minimumZ: Number.POSITIVE_INFINITY,
            maximumZ: Number.NEGATIVE_INFINITY,
          };
          for (const building of members) {
            includeHorizontal(extent, building.position, building.size);
          }
          if (!finiteHorizontalExtent(extent)) {
            throw new RangeError(
              `Extension geometry for district '${district.id}' is invalid.`,
            );
          }
          return {
            ...district,
            position: {
              x: (extent.minimumX + extent.maximumX) / 2,
              y: district.position.y,
              z: (extent.minimumZ + extent.maximumZ) / 2,
            },
            size: {
              x:
                extent.maximumX -
                extent.minimumX +
                extensionDistrictPadding * 2,
              y: district.size.y,
              z:
                extent.maximumZ -
                extent.minimumZ +
                extensionDistrictPadding * 2,
            },
          };
        });
      })()
    : undefined;
  if (mutableDistricts !== undefined) {
    applyCollisionSafeDistrictLayout(
      model,
      mutableBuildings,
      mutableDistricts,
    );
  }
  const buildings = Object.freeze(
    mutableBuildings.map((building) =>
      Object.freeze({
        ...building,
        position: Object.freeze({ ...building.position }),
        size: Object.freeze({ ...building.size }),
      }),
    ),
  );
  const districts =
    mutableDistricts === undefined
      ? model.districts
      : Object.freeze(
          mutableDistricts.map((district) =>
            Object.freeze({
              ...district,
              position: Object.freeze({ ...district.position }),
              size: Object.freeze({ ...district.size }),
            }),
          ),
        );

  const cityExtent: HorizontalExtent | undefined = horizontalGeometryChanged
    ? {
        minimumX: Number.POSITIVE_INFINITY,
        maximumX: Number.NEGATIVE_INFINITY,
        minimumZ: Number.POSITIVE_INFINITY,
        maximumZ: Number.NEGATIVE_INFINITY,
      }
    : undefined;
  if (cityExtent !== undefined) {
    for (const district of districts) {
      includeHorizontal(cityExtent, district.position, district.size);
    }
    if (model.identityPanel !== undefined) {
      includeHorizontal(
        cityExtent,
        model.identityPanel.position,
        model.identityPanel.size,
        model.identityPanel.reliefDepth,
      );
    }
  }
  const hasCityExtent =
    cityExtent !== undefined && finiteHorizontalExtent(cityExtent);
  const base =
    model.base === undefined || !hasCityExtent
      ? model.base
      : Object.freeze({
          ...model.base,
          position: Object.freeze({
            x: (cityExtent.minimumX + cityExtent.maximumX) / 2,
            y: model.base.position.y,
            z: (cityExtent.minimumZ + cityExtent.maximumZ) / 2,
          }),
          size: Object.freeze({
            x: cityExtent.maximumX - cityExtent.minimumX,
            y: model.base.size.y,
            z: cityExtent.maximumZ - cityExtent.minimumZ,
          }),
        });
  const maximumY = verticalGeometryChanged
    ? Math.max(
        0,
        ...buildings.map(
          (building) => building.position.y + building.size.y / 2,
        ),
        ...districts.map(
          (district) => district.position.y + district.size.y / 2,
        ),
        ...(base === undefined
          ? []
          : [base.position.y + base.size.y / 2]),
        ...(model.identityPanel === undefined
          ? []
          : [
              model.identityPanel.position.y +
                model.identityPanel.size.y / 2,
            ]),
      )
    : model.bounds.y;
  const bounds = Object.freeze({
    x: hasCityExtent
      ? (base?.size.x ?? cityExtent.maximumX - cityExtent.minimumX)
      : model.bounds.x,
    y: maximumY,
    z: hasCityExtent
      ? (base?.size.z ?? cityExtent.maximumZ - cityExtent.minimumZ)
      : model.bounds.z,
  });
  const projected = Object.freeze({
    ...model,
    ...(base === undefined ? {} : { base }),
    districts,
    buildings,
    bounds,
  });
  return validateCityModel(projected);
}

export const SAFE_EXTENSION_PRESETS: readonly SafeExtensionConfigurationV1[] =
  Object.freeze([
    validateSafeExtensionConfiguration({
      version: EXTENSION_CONFIGURATION_VERSION,
      id: "complexity-focus",
      name: "Complexity focus",
      compatibility: {
        cityModel: "1.x",
        capabilities: [
          "derived-metrics",
          "mappings",
          "filters",
          "legends",
          "queries",
          "overlays",
        ],
      },
      scope: { kind: "project" },
      derivedMetrics: [
        {
          id: "complexity-pressure",
          label: "Complexity pressure",
          expression: {
            op: "multiply",
            left: { op: "metric", metric: "maximumComplexity" },
            right: {
              op: "log1p",
              value: { op: "metric", metric: "sloc" },
            },
          },
        },
      ],
      mappings: [
        {
          id: "complexity-color",
          metric: "complexity-pressure",
          target: "color",
          minimum: 0,
          maximum: 100,
        },
      ],
      filters: [
        {
          id: "high-pressure",
          metric: "complexity-pressure",
          operator: "atLeast",
          value: 20,
        },
      ],
      legends: [
        {
          id: "complexity-legend",
          label: "Complexity pressure",
          mappingId: "complexity-color",
        },
      ],
      queries: [
        { id: "high-pressure-query", filterId: "high-pressure" },
      ],
      overlays: [
        {
          id: "high-pressure-overlay",
          filterId: "high-pressure",
          color: "#DC2626",
        },
      ],
    }),
  ]);
