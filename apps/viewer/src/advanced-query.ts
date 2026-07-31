import type {
  CityBuilding,
  CityDependency,
  CityModel,
  DependencyKind,
  RiskBand,
  SourceLanguage,
  SourceMetrics,
} from "../../../packages/core/src/model.js";

export const ADVANCED_QUERY_VERSION = "codecity.query/1";
export const ADVANCED_QUERY_METRIC_SCHEMA_VERSION =
  "codecity.source-metrics/1";
export const MAXIMUM_QUERY_CONDITIONS = 16;
export const MAXIMUM_QUERY_RESULTS = 500;
export const MAXIMUM_QUERY_BUILDINGS = 25_000;
export const MAXIMUM_QUERY_DEPENDENCIES = 250_000;

export type AdvancedQueryMetric = keyof SourceMetrics;
export type AdvancedQueryChangeKind = "added" | "changed" | "removed";
export type AdvancedQuerySortKey =
  | "name"
  | "path"
  | "dependency-count"
  | AdvancedQueryMetric;

export type AdvancedQueryCondition =
  | {
      readonly kind: "text";
      readonly field: "name" | "path" | "name-or-path";
      readonly operator: "contains" | "equals";
      readonly value: string;
    }
  | {
      readonly kind: "language";
      readonly values: readonly SourceLanguage[];
    }
  | {
      readonly kind: "risk";
      readonly values: readonly RiskBand[];
    }
  | {
      readonly kind: "metric";
      readonly metric: AdvancedQueryMetric;
      readonly operator: "at-least" | "at-most" | "between";
      readonly value: number;
      readonly maximum?: number;
    }
  | {
      readonly kind: "dependency-count";
      readonly direction: "incoming" | "outgoing" | "either";
      readonly minimum: number;
      readonly dependencyKind?: DependencyKind;
    }
  | {
      readonly kind: "neighborhood";
      readonly direction: "incoming" | "outgoing";
      readonly buildingId: string;
      readonly dependencyKind?: DependencyKind;
    }
  | {
      readonly kind: "district";
      readonly districtId: string;
    }
  | {
      readonly kind: "changed";
      readonly changeKinds: readonly AdvancedQueryChangeKind[];
    }
  | {
      readonly kind: "smell";
      readonly ruleId: string;
    };

export interface AdvancedQueryDefinition {
  readonly version: typeof ADVANCED_QUERY_VERSION;
  readonly id: string;
  readonly name: string;
  readonly match: "all" | "any";
  readonly conditions: readonly AdvancedQueryCondition[];
  readonly sort: {
    readonly key: AdvancedQuerySortKey;
    readonly direction: "ascending" | "descending";
  };
  readonly limit: number;
  readonly capabilities: {
    readonly modelSchemaVersion: "1.0";
    readonly metricSchemaVersion: typeof ADVANCED_QUERY_METRIC_SCHEMA_VERSION;
    readonly ruleSchemaVersion?: string;
  };
}

export interface AdvancedQueryContext {
  readonly changesByBuildingId?: ReadonlyMap<
    string,
    ReadonlySet<AdvancedQueryChangeKind>
  >;
  readonly smellRuleIdsByBuildingId?: ReadonlyMap<
    string,
    ReadonlySet<string>
  >;
  readonly availableSmellRuleIdsByBuildingId?: ReadonlyMap<
    string,
    ReadonlySet<string>
  >;
  readonly ruleSchemaVersion?: string;
}

export interface AdvancedQueryResult {
  readonly buildingId: string;
  readonly name: string;
  readonly path: string;
  readonly districtId: string;
  readonly language: SourceLanguage;
  readonly risk: RiskBand;
  readonly metrics: SourceMetrics;
  readonly dependencyCount: number;
  readonly reasons: readonly string[];
}

export interface AdvancedQueryEvaluation {
  readonly state: "empty" | "results" | "partial" | "unavailable";
  readonly queryId: string;
  readonly evaluatedBuildingCount: number;
  readonly totalCount: number;
  readonly truncated: boolean;
  readonly results: readonly AdvancedQueryResult[];
  readonly unavailableReasons: readonly string[];
}

export type AdvancedQueryPreset =
  | "highest-complexity"
  | "dependency-hubs"
  | "incoming-neighborhood"
  | "outgoing-neighborhood"
  | "changed-recently"
  | "selected-district";

export interface AdvancedQueryPresetContext {
  readonly selectedBuildingId?: string;
  readonly selectedDistrictId?: string;
}

interface DependencyCounts {
  readonly incoming: ReadonlyMap<string, number>;
  readonly outgoing: ReadonlyMap<string, number>;
  readonly incomingByKind: ReadonlyMap<string, number>;
  readonly outgoingByKind: ReadonlyMap<string, number>;
  readonly incomingNeighbors: ReadonlyMap<string, ReadonlySet<string>>;
  readonly outgoingNeighbors: ReadonlyMap<string, ReadonlySet<string>>;
  readonly incomingNeighborsByKind: ReadonlyMap<
    string,
    ReadonlySet<string>
  >;
  readonly outgoingNeighborsByKind: ReadonlyMap<
    string,
    ReadonlySet<string>
  >;
}

interface ConditionMatch {
  readonly matched: boolean;
  readonly reason?: string | undefined;
  readonly unavailable?: string | undefined;
}

export function createAdvancedQueryPreset(
  preset: AdvancedQueryPreset,
  context: AdvancedQueryPresetContext = {},
): AdvancedQueryDefinition {
  const base: Pick<
    AdvancedQueryDefinition,
    "version" | "match" | "limit" | "capabilities"
  > = {
    version: ADVANCED_QUERY_VERSION,
    match: "all" as const,
    limit: 50,
    capabilities: {
      modelSchemaVersion: "1.0" as const,
      metricSchemaVersion: ADVANCED_QUERY_METRIC_SCHEMA_VERSION,
    },
  };
  switch (preset) {
    case "highest-complexity":
      return {
        ...base,
        id: "built-in:highest-complexity",
        name: "Highest complexity",
        conditions: [],
        sort: { key: "maximumComplexity", direction: "descending" },
      };
    case "dependency-hubs":
      return {
        ...base,
        id: "built-in:dependency-hubs",
        name: "Dependency hubs",
        conditions: [
          {
            kind: "dependency-count",
            direction: "either",
            minimum: 1,
          },
        ],
        sort: { key: "dependency-count", direction: "descending" },
      };
    case "incoming-neighborhood":
    case "outgoing-neighborhood": {
      const buildingId = requiredPresetIdentity(
        context.selectedBuildingId,
        `${preset} requires a selected building`,
      );
      const direction =
        preset === "incoming-neighborhood" ? "incoming" : "outgoing";
      return {
        ...base,
        id: `built-in:${preset}:${buildingId}`,
        name:
          direction === "incoming"
            ? "Incoming neighborhood"
            : "Outgoing neighborhood",
        conditions: [
          { kind: "neighborhood", direction, buildingId },
        ],
        sort: { key: "name", direction: "ascending" },
      };
    }
    case "changed-recently":
      return {
        ...base,
        id: "built-in:changed-recently",
        name: "Changed recently",
        conditions: [
          {
            kind: "changed",
            changeKinds: ["added", "changed", "removed"],
          },
        ],
        sort: { key: "path", direction: "ascending" },
      };
    case "selected-district": {
      const districtId = requiredPresetIdentity(
        context.selectedDistrictId,
        "selected-district requires a selected district",
      );
      return {
        ...base,
        id: `built-in:selected-district:${districtId}`,
        name: "Selected district",
        conditions: [{ kind: "district", districtId }],
        sort: { key: "path", direction: "ascending" },
      };
    }
  }
}

export function validateAdvancedQueryDefinition(
  value: unknown,
): AdvancedQueryDefinition {
  if (!isRecord(value)) {
    throw new TypeError("The query definition must be an object.");
  }
  exactKeys(value, [
    "version",
    "id",
    "name",
    "match",
    "conditions",
    "sort",
    "limit",
    "capabilities",
  ], "query definition");
  if (value["version"] !== ADVANCED_QUERY_VERSION) {
    throw new TypeError(
      `The query version must be "${ADVANCED_QUERY_VERSION}".`,
    );
  }
  const id = boundedText(value["id"], "Query ID", 128);
  const name = boundedText(value["name"], "Query name", 64);
  const match = oneOf(value["match"], ["all", "any"], "Query match mode");
  if (!Array.isArray(value["conditions"])) {
    throw new TypeError("Query conditions must be an array.");
  }
  if (value["conditions"].length > MAXIMUM_QUERY_CONDITIONS) {
    throw new RangeError(
      `A query can contain at most ${MAXIMUM_QUERY_CONDITIONS} conditions.`,
    );
  }
  const conditions = value["conditions"].map((condition, index) =>
    validateCondition(condition, index),
  );
  const sort = validateSort(value["sort"]);
  const limit = boundedInteger(
    value["limit"],
    "Query result limit",
    1,
    MAXIMUM_QUERY_RESULTS,
  );
  const capabilities = validateCapabilities(value["capabilities"]);
  if (
    conditions.some(({ kind }) => kind === "smell") &&
    capabilities.ruleSchemaVersion === undefined
  ) {
    throw new TypeError(
      "Queries that reference design-smell rules must declare a rule schema version.",
    );
  }
  return Object.freeze({
    version: ADVANCED_QUERY_VERSION,
    id,
    name,
    match,
    conditions: Object.freeze(conditions),
    sort,
    limit,
    capabilities,
  });
}

export function evaluateAdvancedQuery(
  model: Pick<
    CityModel,
    "schemaVersion" | "buildings" | "dependencies"
  >,
  unvalidatedDefinition: AdvancedQueryDefinition,
  context: AdvancedQueryContext = {},
): AdvancedQueryEvaluation {
  const definition = validateAdvancedQueryDefinition(
    unvalidatedDefinition,
  );
  if (model.schemaVersion !== definition.capabilities.modelSchemaVersion) {
    throw new TypeError(
      `Query "${definition.name}" requires model schema ` +
        `${definition.capabilities.modelSchemaVersion}.`,
    );
  }
  if (model.buildings.length > MAXIMUM_QUERY_BUILDINGS) {
    throw new RangeError(
      `A query can inspect at most ${MAXIMUM_QUERY_BUILDINGS.toLocaleString()} buildings.`,
    );
  }
  if (model.dependencies.length > MAXIMUM_QUERY_DEPENDENCIES) {
    throw new RangeError(
      `A query can inspect at most ${MAXIMUM_QUERY_DEPENDENCIES.toLocaleString()} dependencies.`,
    );
  }

  const buildingIds = new Set(model.buildings.map(({ id }) => id));
  const dependencies = createDependencyCounts(
    model.dependencies,
    buildingIds,
  );
  const unavailable = new Set<string>();
  const matched: AdvancedQueryResult[] = [];

  for (const building of model.buildings) {
    const matches = definition.conditions.map((condition) =>
      matchCondition(
        building,
        condition,
        dependencies,
        context,
        definition.capabilities.ruleSchemaVersion,
      ),
    );
    for (const result of matches) {
      if (result.unavailable !== undefined) {
        unavailable.add(result.unavailable);
      }
    }
    const availableMatches = matches.filter(
      ({ unavailable: reason }) => reason === undefined,
    );
    const accepted =
      definition.conditions.length === 0 ||
      (definition.match === "all"
        ? availableMatches.length === definition.conditions.length &&
          availableMatches.every(({ matched }) => matched)
        : availableMatches.some(({ matched }) => matched));
    if (!accepted) continue;
    matched.push(
      Object.freeze({
        buildingId: building.id,
        name: building.name,
        path: building.path,
        districtId: building.districtId,
        language: building.language,
        risk: building.risk,
        metrics: Object.freeze({ ...building.metrics }),
        dependencyCount: dependencyCount(
          dependencies,
          building.id,
          "either",
        ),
        reasons: Object.freeze(
          availableMatches
            .filter(({ matched: conditionMatched }) => conditionMatched)
            .map(({ reason }) => reason)
            .filter((reason): reason is string => reason !== undefined),
        ),
      }),
    );
  }

  matched.sort((left, right) =>
    compareResults(left, right, definition.sort),
  );
  const results = Object.freeze(matched.slice(0, definition.limit));
  const unavailableReasons = Object.freeze(
    [...unavailable].sort(compareText),
  );
  const state =
    unavailableReasons.length > 0
      ? results.length > 0
        ? "partial"
        : "unavailable"
      : results.length > 0
        ? "results"
        : "empty";
  return Object.freeze({
    state,
    queryId: definition.id,
    evaluatedBuildingCount: model.buildings.length,
    totalCount: matched.length,
    truncated: matched.length > results.length,
    results,
    unavailableReasons,
  });
}

function matchCondition(
  building: CityBuilding,
  condition: AdvancedQueryCondition,
  dependencies: DependencyCounts,
  context: AdvancedQueryContext,
  ruleSchemaVersion: string | undefined,
): ConditionMatch {
  switch (condition.kind) {
    case "text": {
      const candidates =
        condition.field === "name-or-path"
          ? [building.name, building.path]
          : [building[condition.field]];
      const value = condition.value.trim().toLowerCase();
      const matched = candidates.some((candidateValue) => {
        const candidate = candidateValue.trim().toLowerCase();
        return condition.operator === "equals"
          ? candidate === value
          : candidate.includes(value);
      });
      return {
        matched,
        reason: matched
          ? `${condition.field} ${condition.operator === "equals" ? "equals" : "contains"} “${condition.value}”`
          : undefined,
      };
    }
    case "language": {
      const matched = condition.values.includes(building.language);
      return {
        matched,
        reason: matched ? `language is ${building.language}` : undefined,
      };
    }
    case "risk": {
      const matched = condition.values.includes(building.risk);
      return {
        matched,
        reason: matched ? `risk is ${building.risk}` : undefined,
      };
    }
    case "metric": {
      const value = building.metrics[condition.metric];
      const matched =
        condition.operator === "at-least"
          ? value >= condition.value
          : condition.operator === "at-most"
            ? value <= condition.value
            : value >= condition.value &&
              value <= (condition.maximum ?? condition.value);
      return {
        matched,
        reason: matched
          ? `${metricLabel(condition.metric)} is ${String(value)}`
          : undefined,
      };
    }
    case "dependency-count": {
      const count = dependencyCount(
        dependencies,
        building.id,
        condition.direction,
        condition.dependencyKind,
      );
      return {
        matched: count >= condition.minimum,
        reason:
          count >= condition.minimum
            ? `${String(count)} ${condition.direction} dependencies`
            : undefined,
      };
    }
    case "neighborhood": {
      const neighbors = dependencyNeighbors(
        dependencies,
        condition.buildingId,
        condition.direction,
        condition.dependencyKind,
      );
      const matched = neighbors.has(building.id);
      return {
        matched,
        reason: matched
          ? `${condition.direction} neighbor of ${condition.buildingId}`
          : undefined,
      };
    }
    case "district": {
      const matched = building.districtId === condition.districtId;
      return {
        matched,
        reason: matched ? `belongs to district ${condition.districtId}` : undefined,
      };
    }
    case "changed": {
      if (context.changesByBuildingId === undefined) {
        return {
          matched: false,
          unavailable:
            "Change data is unavailable for the current model snapshot.",
        };
      }
      const changes = context.changesByBuildingId.get(building.id);
      const matchingChange = condition.changeKinds.find((kind) =>
        changes?.has(kind),
      );
      return {
        matched: matchingChange !== undefined,
        reason:
          matchingChange === undefined
            ? undefined
            : `${matchingChange} in the active evolution transition`,
      };
    }
    case "smell": {
      if (
        context.smellRuleIdsByBuildingId === undefined ||
        context.availableSmellRuleIdsByBuildingId === undefined
      ) {
        return {
          matched: false,
          unavailable:
            `Design-smell rule "${condition.ruleId}" is unavailable.`,
        };
      }
      if (context.ruleSchemaVersion !== ruleSchemaVersion) {
        return {
          matched: false,
          unavailable:
            `Design-smell schema "${ruleSchemaVersion ?? "unspecified"}" is unavailable.`,
        };
      }
      if (
        context.availableSmellRuleIdsByBuildingId
          .get(building.id)
          ?.has(condition.ruleId) !== true
      ) {
        return {
          matched: false,
          unavailable:
            `Design-smell rule "${condition.ruleId}" is unavailable.`,
        };
      }
      const matched =
        context.smellRuleIdsByBuildingId
          .get(building.id)
          ?.has(condition.ruleId) ?? false;
      return {
        matched,
        reason: matched
          ? `matches smell rule ${condition.ruleId}`
          : undefined,
      };
    }
  }
}

function createDependencyCounts(
  source: readonly CityDependency[],
  buildingIds: ReadonlySet<string>,
): DependencyCounts {
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, number>();
  const incomingByKind = new Map<string, number>();
  const outgoingByKind = new Map<string, number>();
  const incomingNeighbors = new Map<string, Set<string>>();
  const outgoingNeighbors = new Map<string, Set<string>>();
  const incomingNeighborsByKind = new Map<string, Set<string>>();
  const outgoingNeighborsByKind = new Map<string, Set<string>>();
  for (const dependency of source) {
    if (
      !buildingIds.has(dependency.sourceId) ||
      dependency.targetId === undefined ||
      !buildingIds.has(dependency.targetId)
    ) {
      continue;
    }
    increment(outgoing, dependency.sourceId);
    increment(incoming, dependency.targetId);
    increment(
      outgoingByKind,
      dependencyKindKey(dependency.sourceId, dependency.kind),
    );
    increment(
      incomingByKind,
      dependencyKindKey(dependency.targetId, dependency.kind),
    );
    addNeighbor(
      outgoingNeighbors,
      dependency.sourceId,
      dependency.targetId,
    );
    addNeighbor(
      incomingNeighbors,
      dependency.targetId,
      dependency.sourceId,
    );
    addNeighbor(
      outgoingNeighborsByKind,
      dependencyKindKey(dependency.sourceId, dependency.kind),
      dependency.targetId,
    );
    addNeighbor(
      incomingNeighborsByKind,
      dependencyKindKey(dependency.targetId, dependency.kind),
      dependency.sourceId,
    );
  }
  return {
    incoming,
    outgoing,
    incomingByKind,
    outgoingByKind,
    incomingNeighbors,
    outgoingNeighbors,
    incomingNeighborsByKind,
    outgoingNeighborsByKind,
  };
}

function dependencyCount(
  counts: DependencyCounts,
  buildingId: string,
  direction: "incoming" | "outgoing" | "either",
  kind?: DependencyKind,
): number {
  const key = kind === undefined ? buildingId : dependencyKindKey(buildingId, kind);
  const incoming =
    (kind === undefined ? counts.incoming : counts.incomingByKind).get(key) ??
    0;
  const outgoing =
    (kind === undefined ? counts.outgoing : counts.outgoingByKind).get(key) ??
    0;
  return direction === "incoming"
    ? incoming
    : direction === "outgoing"
      ? outgoing
      : incoming + outgoing;
}

function dependencyNeighbors(
  counts: DependencyCounts,
  buildingId: string,
  direction: "incoming" | "outgoing",
  kind?: DependencyKind,
): ReadonlySet<string> {
  const key = kind === undefined ? buildingId : dependencyKindKey(buildingId, kind);
  const index =
    direction === "incoming"
      ? kind === undefined
        ? counts.incomingNeighbors
        : counts.incomingNeighborsByKind
      : kind === undefined
        ? counts.outgoingNeighbors
        : counts.outgoingNeighborsByKind;
  return index.get(key) ?? EMPTY_IDS;
}

const EMPTY_IDS: ReadonlySet<string> = new Set();

function compareResults(
  left: AdvancedQueryResult,
  right: AdvancedQueryResult,
  sort: AdvancedQueryDefinition["sort"],
): number {
  const direction = sort.direction === "ascending" ? 1 : -1;
  const leftValue = querySortValue(left, sort.key);
  const rightValue = querySortValue(right, sort.key);
  const primary =
    typeof leftValue === "number" && typeof rightValue === "number"
      ? leftValue - rightValue
      : compareText(String(leftValue), String(rightValue));
  return (
    primary * direction ||
    compareText(left.path, right.path) ||
    compareText(left.buildingId, right.buildingId)
  );
}

function querySortValue(
  result: AdvancedQueryResult,
  key: AdvancedQuerySortKey,
): string | number {
  if (key === "name" || key === "path") return result[key].toLowerCase();
  if (key === "dependency-count") return result.dependencyCount;
  return result.metrics[key];
}

function validateCondition(
  value: unknown,
  index: number,
): AdvancedQueryCondition {
  if (!isRecord(value)) {
    throw new TypeError(`Query condition ${index + 1} must be an object.`);
  }
  const kind = boundedText(value["kind"], `Query condition ${index + 1} kind`, 32);
  switch (kind) {
    case "text": {
      exactKeys(value, ["kind", "field", "operator", "value"], `query condition ${index + 1}`);
      return {
        kind,
        field: oneOf(
          value["field"],
          ["name", "path", "name-or-path"],
          "Text field",
        ),
        operator: oneOf(value["operator"], ["contains", "equals"], "Text operator"),
        value: boundedText(value["value"], "Text query value", 128),
      };
    }
    case "language": {
      exactKeys(value, ["kind", "values"], `query condition ${index + 1}`);
      return {
        kind,
        values: validateEnumArray(
          value["values"],
          ["csharp", "typescript", "javascript"],
          "Query languages",
        ),
      };
    }
    case "risk": {
      exactKeys(value, ["kind", "values"], `query condition ${index + 1}`);
      return {
        kind,
        values: validateEnumArray(
          value["values"],
          ["low", "moderate", "high", "very-high"],
          "Query risk bands",
        ),
      };
    }
    case "metric": {
      exactKeys(
        value,
        ["kind", "metric", "operator", "value", "maximum"],
        `query condition ${index + 1}`,
        ["maximum"],
      );
      const operator = oneOf(
        value["operator"],
        ["at-least", "at-most", "between"],
        "Metric operator",
      );
      const minimum = finiteNonNegative(value["value"], "Metric value");
      const maximum =
        value["maximum"] === undefined
          ? undefined
          : finiteNonNegative(value["maximum"], "Metric maximum");
      if (operator === "between" && (maximum === undefined || maximum < minimum)) {
        throw new RangeError(
          "A between metric condition requires a maximum at least as large as its value.",
        );
      }
      return {
        kind,
        metric: oneOf(
          value["metric"],
          [
            "sloc",
            "decisionLoad",
            "maximumComplexity",
            "executableUnitCount",
          ],
          "Metric",
        ),
        operator,
        value: minimum,
        ...(maximum === undefined ? {} : { maximum }),
      };
    }
    case "dependency-count": {
      exactKeys(
        value,
        ["kind", "direction", "minimum", "dependencyKind"],
        `query condition ${index + 1}`,
        ["dependencyKind"],
      );
      return {
        kind,
        direction: oneOf(
          value["direction"],
          ["incoming", "outgoing", "either"],
          "Dependency direction",
        ),
        minimum: boundedInteger(
          value["minimum"],
          "Minimum dependency count",
          0,
          MAXIMUM_QUERY_DEPENDENCIES,
        ),
        ...(value["dependencyKind"] === undefined
          ? {}
          : {
              dependencyKind: oneOf(
                value["dependencyKind"],
                [
                  "typescript-import",
                  "project-reference",
                  "package-reference",
                ],
                "Dependency kind",
              ),
            }),
      };
    }
    case "neighborhood": {
      exactKeys(
        value,
        ["kind", "direction", "buildingId", "dependencyKind"],
        `query condition ${index + 1}`,
        ["dependencyKind"],
      );
      return {
        kind,
        direction: oneOf(
          value["direction"],
          ["incoming", "outgoing"],
          "Neighborhood direction",
        ),
        buildingId: boundedText(
          value["buildingId"],
          "Neighborhood building ID",
          256,
        ),
        ...(value["dependencyKind"] === undefined
          ? {}
          : {
              dependencyKind: oneOf(
                value["dependencyKind"],
                [
                  "typescript-import",
                  "project-reference",
                  "package-reference",
                ],
                "Dependency kind",
              ),
            }),
      };
    }
    case "district":
      exactKeys(value, ["kind", "districtId"], `query condition ${index + 1}`);
      return {
        kind,
        districtId: boundedText(value["districtId"], "District ID", 256),
      };
    case "changed":
      exactKeys(value, ["kind", "changeKinds"], `query condition ${index + 1}`);
      return {
        kind,
        changeKinds: validateEnumArray(
          value["changeKinds"],
          ["added", "changed", "removed"],
          "Change kinds",
        ),
      };
    case "smell":
      exactKeys(value, ["kind", "ruleId"], `query condition ${index + 1}`);
      return {
        kind,
        ruleId: boundedText(value["ruleId"], "Smell rule ID", 128),
      };
    default:
      throw new TypeError(`Unsupported query condition kind "${kind}".`);
  }
}

function validateSort(
  value: unknown,
): AdvancedQueryDefinition["sort"] {
  if (!isRecord(value)) {
    throw new TypeError("Query sort must be an object.");
  }
  exactKeys(value, ["key", "direction"], "query sort");
  return Object.freeze({
    key: oneOf(
      value["key"],
      [
        "name",
        "path",
        "dependency-count",
        "sloc",
        "decisionLoad",
        "maximumComplexity",
        "executableUnitCount",
      ],
      "Query sort key",
    ),
    direction: oneOf(
      value["direction"],
      ["ascending", "descending"],
      "Query sort direction",
    ),
  });
}

function validateCapabilities(
  value: unknown,
): AdvancedQueryDefinition["capabilities"] {
  if (!isRecord(value)) {
    throw new TypeError("Query capabilities must be an object.");
  }
  exactKeys(
    value,
    [
      "modelSchemaVersion",
      "metricSchemaVersion",
      "ruleSchemaVersion",
    ],
    "query capabilities",
    ["ruleSchemaVersion"],
  );
  if (value["modelSchemaVersion"] !== "1.0") {
    throw new TypeError('Query model schema version must be "1.0".');
  }
  if (
    value["metricSchemaVersion"] !==
    ADVANCED_QUERY_METRIC_SCHEMA_VERSION
  ) {
    throw new TypeError(
      `Query metric schema version must be "${ADVANCED_QUERY_METRIC_SCHEMA_VERSION}".`,
    );
  }
  const ruleSchemaVersion =
    value["ruleSchemaVersion"] === undefined
      ? undefined
      : boundedText(
          value["ruleSchemaVersion"],
          "Rule schema version",
          128,
        );
  return Object.freeze({
    modelSchemaVersion: "1.0",
    metricSchemaVersion: ADVANCED_QUERY_METRIC_SCHEMA_VERSION,
    ...(ruleSchemaVersion === undefined ? {} : { ruleSchemaVersion }),
  });
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
  optional: readonly string[] = [],
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      throw new TypeError(`Unexpected ${label} field "${key}".`);
    }
  }
  const optionalSet = new Set(optional);
  for (const key of allowed) {
    if (!optionalSet.has(key) && !(key in value)) {
      throw new TypeError(`Missing ${label} field "${key}".`);
    }
  }
}

function boundedText(
  value: unknown,
  label: string,
  maximumLength: number,
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  const normalized = value.trim();
  if (normalized.length > maximumLength) {
    throw new RangeError(
      `${label} must contain at most ${maximumLength} characters.`,
    );
  }
  return normalized;
}

function boundedInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    throw new RangeError(
      `${label} must be an integer from ${minimum} through ${maximum}.`,
    );
  }
  return value as number;
}

function finiteNonNegative(value: unknown, label: string): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0
  ) {
    throw new RangeError(`${label} must be a finite non-negative number.`);
  }
  return value;
}

function validateEnumArray<const T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): readonly T[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty array.`);
  }
  const result = value.map((entry) => oneOf(entry, allowed, label));
  if (new Set(result).size !== result.length) {
    throw new TypeError(`${label} cannot contain duplicates.`);
  }
  return Object.freeze(result);
}

function oneOf<const T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T {
  if (
    typeof value !== "string" ||
    !allowed.includes(value as T)
  ) {
    throw new TypeError(
      `${label} must be one of ${allowed.map((item) => `"${item}"`).join(", ")}.`,
    );
  }
  return value as T;
}

function requiredPresetIdentity(
  value: string | undefined,
  message: string,
): string {
  if (value === undefined || value.trim().length === 0) {
    throw new TypeError(message);
  }
  return value.trim();
}

function increment(index: Map<string, number>, key: string): void {
  index.set(key, (index.get(key) ?? 0) + 1);
}

function addNeighbor(
  index: Map<string, Set<string>>,
  key: string,
  neighbor: string,
): void {
  const existing = index.get(key);
  if (existing === undefined) {
    index.set(key, new Set([neighbor]));
  } else {
    existing.add(neighbor);
  }
}

function dependencyKindKey(
  buildingId: string,
  kind: DependencyKind,
): string {
  return `${buildingId}\u0000${kind}`;
}

function metricLabel(metric: AdvancedQueryMetric): string {
  switch (metric) {
    case "sloc":
      return "SLOC";
    case "decisionLoad":
      return "decision load";
    case "maximumComplexity":
      return "maximum complexity";
    case "executableUnitCount":
      return "executable units";
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}
