import type { CityModel } from "../../../packages/core/src/model.js";
import type {
  AdvancedQueryChangeKind,
  AdvancedQueryDefinition,
  AdvancedQueryEvaluation,
} from "./advanced-query.js";
import {
  MAXIMUM_QUERY_BUILDINGS,
  MAXIMUM_QUERY_CONDITIONS,
  MAXIMUM_QUERY_RESULTS,
} from "./advanced-query.js";

export interface AdvancedQueryWorkerContext {
  readonly changes:
    | readonly [
        buildingId: string,
        changeKinds: readonly AdvancedQueryChangeKind[],
      ][]
    | null;
  readonly smellRules:
    | readonly [
        buildingId: string,
        ruleIds: readonly string[],
      ][]
    | null;
}

export interface AdvancedQueryEvaluateRequest {
  readonly type: "evaluate";
  readonly jobId: number;
  readonly model: CityModel;
  readonly definition: AdvancedQueryDefinition;
  readonly context: AdvancedQueryWorkerContext;
}

export interface AdvancedQueryEvaluateResult {
  readonly type: "result";
  readonly jobId: number;
  readonly evaluation: AdvancedQueryEvaluation;
}

export interface AdvancedQueryEvaluateFailure {
  readonly type: "failure";
  readonly jobId: number;
  readonly message: string;
}

export type AdvancedQueryWorkerResponse =
  | AdvancedQueryEvaluateResult
  | AdvancedQueryEvaluateFailure;

const MAXIMUM_WORKER_ERROR_CHARACTERS = 512;
const MAXIMUM_QUERY_ID_CHARACTERS = 128;
const MAXIMUM_RESULT_TEXT_CHARACTERS = 512;
const MAXIMUM_RULE_IDS_PER_BUILDING = 64;

export function isAdvancedQueryEvaluateRequest(
  value: unknown,
): value is AdvancedQueryEvaluateRequest {
  const candidate = record(value);
  return (
    candidate !== undefined &&
    hasExactKeys(candidate, [
      "type",
      "jobId",
      "model",
      "definition",
      "context",
    ]) &&
    candidate["type"] === "evaluate" &&
    jobId(candidate["jobId"]) &&
    record(candidate["model"]) !== undefined &&
    record(candidate["definition"]) !== undefined &&
    isWorkerContext(candidate["context"])
  );
}

export function isAdvancedQueryWorkerResponse(
  value: unknown,
): value is AdvancedQueryWorkerResponse {
  const candidate = record(value);
  if (
    candidate === undefined ||
    !jobId(candidate["jobId"]) ||
    typeof candidate["type"] !== "string"
  ) {
    return false;
  }
  if (candidate["type"] === "failure") {
    return (
      hasExactKeys(candidate, ["type", "jobId", "message"]) &&
      typeof candidate["message"] === "string" &&
      candidate["message"].length > 0 &&
      candidate["message"].length <= MAXIMUM_WORKER_ERROR_CHARACTERS
    );
  }
  return (
    candidate["type"] === "result" &&
    hasExactKeys(candidate, ["type", "jobId", "evaluation"]) &&
    isEvaluation(candidate["evaluation"])
  );
}

export function advancedQueryFailureMessage(error: unknown): string {
  const message =
    error instanceof Error && error.message.trim().length > 0
      ? error.message.trim()
      : "The query could not be evaluated.";
  return message.slice(0, MAXIMUM_WORKER_ERROR_CHARACTERS);
}

function isWorkerContext(value: unknown): value is AdvancedQueryWorkerContext {
  const candidate = record(value);
  return (
    candidate !== undefined &&
    hasExactKeys(candidate, ["changes", "smellRules"]) &&
    nullableStringArrayTuples(
      candidate["changes"],
      3,
      new Set(["added", "changed", "removed"]),
    ) &&
    nullableStringArrayTuples(
      candidate["smellRules"],
      MAXIMUM_RULE_IDS_PER_BUILDING,
    )
  );
}

function isEvaluation(value: unknown): value is AdvancedQueryEvaluation {
  const candidate = record(value);
  if (
    candidate === undefined ||
    !hasExactKeys(candidate, [
      "state",
      "queryId",
      "evaluatedBuildingCount",
      "totalCount",
      "truncated",
      "results",
      "unavailableReasons",
    ]) ||
    !["empty", "results", "partial", "unavailable"].includes(
      String(candidate["state"]),
    ) ||
    !boundedString(candidate["queryId"], MAXIMUM_QUERY_ID_CHARACTERS) ||
    !boundedInteger(candidate["evaluatedBuildingCount"], MAXIMUM_QUERY_BUILDINGS) ||
    !boundedInteger(candidate["totalCount"], MAXIMUM_QUERY_BUILDINGS) ||
    typeof candidate["truncated"] !== "boolean" ||
    !Array.isArray(candidate["results"]) ||
    candidate["results"].length > MAXIMUM_QUERY_RESULTS ||
    !candidate["results"].every(isResult) ||
    !boundedStringArray(
      candidate["unavailableReasons"],
      MAXIMUM_QUERY_CONDITIONS,
    )
  ) {
    return false;
  }
  const results = candidate["results"];
  const unavailableReasons = candidate["unavailableReasons"];
  const state = candidate["state"];
  const evaluatedBuildingCount = candidate["evaluatedBuildingCount"];
  const totalCount = candidate["totalCount"];
  const truncated = candidate["truncated"];
  return (
    new Set(
      results.map(
        (result) => (result as Record<string, unknown>)["buildingId"],
      ),
    ).size === results.length &&
    totalCount <= evaluatedBuildingCount &&
    results.length <= totalCount &&
    truncated === (totalCount > results.length) &&
    (state === "results"
      ? results.length > 0 && unavailableReasons.length === 0
      : state === "partial"
        ? results.length > 0 && unavailableReasons.length > 0
        : state === "unavailable"
          ? results.length === 0 && unavailableReasons.length > 0
          : results.length === 0 && unavailableReasons.length === 0)
  );
}

function isResult(value: unknown): boolean {
  const candidate = record(value);
  const metrics = record(candidate?.["metrics"]);
  return (
    candidate !== undefined &&
    hasExactKeys(candidate, [
      "buildingId",
      "name",
      "path",
      "districtId",
      "language",
      "risk",
      "metrics",
      "dependencyCount",
      "reasons",
    ]) &&
    boundedString(candidate["buildingId"], 256) &&
    boundedString(candidate["name"], MAXIMUM_RESULT_TEXT_CHARACTERS) &&
    typeof candidate["path"] === "string" &&
    candidate["path"].length <= MAXIMUM_RESULT_TEXT_CHARACTERS &&
    boundedString(candidate["districtId"], 256) &&
    ["csharp", "typescript", "javascript"].includes(
      String(candidate["language"]),
    ) &&
    ["low", "moderate", "high", "very-high"].includes(
      String(candidate["risk"]),
    ) &&
    metrics !== undefined &&
    hasExactKeys(metrics, [
      "sloc",
      "decisionLoad",
      "maximumComplexity",
      "executableUnitCount",
    ]) &&
    Object.values(metrics).every(nonNegativeFinite) &&
    boundedInteger(candidate["dependencyCount"], 250_000) &&
    boundedStringArray(
      candidate["reasons"],
      MAXIMUM_QUERY_CONDITIONS,
    )
  );
}

function nullableStringArrayTuples(
  value: unknown,
  maximumValues: number,
  allowedValues?: ReadonlySet<string>,
): boolean {
  if (value === null) return true;
  return (
    Array.isArray(value) &&
    value.length <= MAXIMUM_QUERY_BUILDINGS &&
    value.every(
      (entry) =>
        Array.isArray(entry) &&
        entry.length === 2 &&
        boundedString(entry[0], 256) &&
        boundedStringArray(entry[1], maximumValues) &&
        (allowedValues === undefined ||
          entry[1].every((item: string) => allowedValues.has(item))),
    ) &&
    ascendingUniqueTupleIds(value)
  );
}

function boundedStringArray(
  value: unknown,
  maximumLength: number,
): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= maximumLength &&
    value.every((entry) =>
      boundedString(entry, MAXIMUM_RESULT_TEXT_CHARACTERS),
    ) &&
    new Set(value).size === value.length
  );
}

function ascendingUniqueTupleIds(
  entries: readonly unknown[],
): boolean {
  let previous: string | undefined;
  for (const entry of entries) {
    const id = (entry as readonly [string, unknown])[0];
    if (previous !== undefined && previous >= id) return false;
    previous = id;
  }
  return true;
}

function boundedString(
  value: unknown,
  maximumLength: number,
): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength
  );
}

function boundedInteger(
  value: unknown,
  maximum: number,
): value is number {
  return (
    Number.isSafeInteger(value) &&
    Number(value) >= 0 &&
    Number(value) <= maximum
  );
}

function nonNegativeFinite(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0
  );
}

function jobId(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function record(value: unknown): Record<string, unknown> | undefined {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  )
    ? (value as Record<string, unknown>)
    : undefined;
}
