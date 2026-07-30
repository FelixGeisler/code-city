import type {
  CityModel,
  MetricMappingDefinitionV1,
} from "../../../packages/core/src/index.js";

export interface MetricMappingProjectRequest {
  readonly type: "project";
  readonly jobId: number;
  readonly model: CityModel;
  readonly mapping: MetricMappingDefinitionV1;
}

export interface MetricMappingProjectResult {
  readonly type: "result";
  readonly jobId: number;
  readonly model: CityModel;
}

export interface MetricMappingProjectFailure {
  readonly type: "failure";
  readonly jobId: number;
  readonly message: string;
}

export type MetricMappingWorkerResponse =
  | MetricMappingProjectResult
  | MetricMappingProjectFailure;

const MAXIMUM_WORKER_ERROR_CHARACTERS = 512;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function isJobId(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

export function isMetricMappingProjectRequest(
  value: unknown,
): value is MetricMappingProjectRequest {
  const candidate = record(value);
  return (
    candidate !== undefined &&
    hasExactKeys(candidate, ["type", "jobId", "model", "mapping"]) &&
    candidate["type"] === "project" &&
    isJobId(candidate["jobId"]) &&
    record(candidate["model"]) !== undefined &&
    record(candidate["mapping"]) !== undefined
  );
}

export function isMetricMappingWorkerResponse(
  value: unknown,
): value is MetricMappingWorkerResponse {
  const candidate = record(value);
  if (
    candidate === undefined ||
    !isJobId(candidate["jobId"]) ||
    typeof candidate["type"] !== "string"
  ) {
    return false;
  }
  if (candidate["type"] === "result") {
    return (
      hasExactKeys(candidate, ["type", "jobId", "model"]) &&
      record(candidate["model"]) !== undefined
    );
  }
  return (
    candidate["type"] === "failure" &&
    hasExactKeys(candidate, ["type", "jobId", "message"]) &&
    typeof candidate["message"] === "string" &&
    candidate["message"].length > 0 &&
    candidate["message"].length <= MAXIMUM_WORKER_ERROR_CHARACTERS
  );
}

export function metricMappingFailureMessage(error: unknown): string {
  const message =
    error instanceof Error && error.message.trim().length > 0
      ? error.message.trim()
      : "The metric projection could not be generated.";
  return message.slice(0, MAXIMUM_WORKER_ERROR_CHARACTERS);
}
