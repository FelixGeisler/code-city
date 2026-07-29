import type {
  ThreeMfExportOptions,
  ThreeMfExportPhase,
  ThreeMfExportPreflight,
} from "../../../packages/exporter/src/three-mf-export.js";
import type {
  CalibrationMeasurement,
  CalibrationPreflight,
} from "../../../packages/exporter/src/calibration.js";

export interface PrintExportGenerateRequest {
  readonly type: "generate";
  readonly jobId: number;
  readonly model: unknown;
  readonly profile: unknown;
  readonly options: ThreeMfExportOptions;
}

export interface PrintCalibrationGenerateRequest {
  readonly type: "calibrate";
  readonly jobId: number;
  readonly profile: unknown;
}

export type PrintExportWorkerRequest =
  | PrintExportGenerateRequest
  | PrintCalibrationGenerateRequest;

export interface PrintExportProgressResponse {
  readonly type: "progress";
  readonly jobId: number;
  readonly phase: ThreeMfExportPhase;
  readonly completed: number;
  readonly message: string;
}

export interface PrintExportPreflightResponse {
  readonly type: "preflight";
  readonly jobId: number;
  readonly preflight: ThreeMfExportPreflight;
}

export interface PrintExportResultResponse {
  readonly type: "result";
  readonly jobId: number;
  readonly preflight: ThreeMfExportPreflight;
  readonly threeMfBytes: ArrayBuffer;
  readonly legendBytes?: ArrayBuffer;
}

export interface PrintCalibrationResultResponse {
  readonly type: "calibration-result";
  readonly jobId: number;
  readonly preflight: CalibrationPreflight;
  readonly threeMfBytes: ArrayBuffer;
  readonly manifestBytes: ArrayBuffer;
}

export type PrintExportFailureKind =
  | "validation"
  | "unexpected"
  | "protocol";

export interface PrintExportFailure {
  readonly kind: PrintExportFailureKind;
  readonly name: string;
  readonly message: string;
  readonly issues: readonly string[];
}

export interface PrintExportFailureResponse {
  readonly type: "failure";
  readonly jobId: number;
  readonly error: PrintExportFailure;
}

export type PrintExportWorkerResponse =
  | PrintExportProgressResponse
  | PrintExportPreflightResponse
  | PrintExportResultResponse
  | PrintCalibrationResultResponse
  | PrintExportFailureResponse;

const EXPORT_PHASES: ReadonlySet<ThreeMfExportPhase> = new Set([
  "validating",
  "geometry",
  "serializing",
  "complete",
]);
const CALIBRATION_MEASUREMENT_IDS: ReadonlySet<
  CalibrationMeasurement["id"]
> = new Set([
  "nozzle-diameter",
  "line-width",
  "minimum-wall-thickness",
  "minimum-gap",
  "minimum-feature-size",
  "minimum-base-thickness",
  "minimum-raised-feature-height",
  "minimum-recessed-feature-depth",
  "minimum-label-stroke-width",
  "minimum-route-width",
  "build-margin-x",
  "build-margin-y",
  "build-margin-z",
  "maximum-model-height",
]);
const CALIBRATION_MEASUREMENT_REFERENCES: ReadonlySet<
  CalibrationMeasurement["reference"]
> = new Set([
  "coupon",
  "rail-defined-groove",
  "plate",
  "placement",
  "limit",
]);
const EXPECTED_CALIBRATION_AXES: Readonly<
  Partial<
    Record<
      CalibrationMeasurement["id"],
      {
        readonly cityAxis: "x" | "y" | "z";
        readonly printAxis: "x" | "y" | "z";
        readonly meaning: "width" | "height" | "depth";
      }
    >
  >
> = {
  "build-margin-x": {
    cityAxis: "x",
    printAxis: "x",
    meaning: "width",
  },
  "build-margin-y": {
    cityAxis: "y",
    printAxis: "z",
    meaning: "height",
  },
  "build-margin-z": {
    cityAxis: "z",
    printAxis: "y",
    meaning: "depth",
  },
  "maximum-model-height": {
    cityAxis: "y",
    printAxis: "z",
    meaning: "height",
  },
};

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function jobId(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function stringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function nonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function exportOptions(value: unknown): value is ThreeMfExportOptions {
  const candidate = record(value);
  return (
    candidate !== undefined &&
    typeof candidate["scale"] === "number" &&
    (candidate["labelPolicy"] === "auto" ||
      candidate["labelPolicy"] === "off") &&
    (candidate["routePolicy"] === "auto" ||
      candidate["routePolicy"] === "off") &&
    typeof candidate["includeLegend"] === "boolean"
  );
}

function dimensions(value: unknown): boolean {
  const candidate = record(value);
  return (
    candidate !== undefined &&
    finiteNumber(candidate["x"]) &&
    candidate["x"] >= 0 &&
    finiteNumber(candidate["y"]) &&
    candidate["y"] >= 0 &&
    finiteNumber(candidate["z"]) &&
    candidate["z"] >= 0
  );
}

function channel(value: unknown): boolean {
  const candidate = record(value);
  return (
    candidate !== undefined &&
    typeof candidate["id"] === "string" &&
    typeof candidate["label"] === "string" &&
    stringArray(candidate["partIds"]) &&
    stringArray(candidate["semanticGroupIds"]) &&
    nonnegativeInteger(candidate["primitiveCount"])
  );
}

function labels(value: unknown): boolean {
  const candidate = record(value);
  return (
    candidate !== undefined &&
    nonnegativeInteger(candidate["printedBuildings"]) &&
    nonnegativeInteger(candidate["skippedBuildings"]) &&
    nonnegativeInteger(candidate["printedDistricts"]) &&
    nonnegativeInteger(candidate["skippedDistricts"])
  );
}

function routes(value: unknown): boolean {
  const candidate = record(value);
  return (
    candidate !== undefined &&
    (candidate["policy"] === "auto" || candidate["policy"] === "off") &&
    nonnegativeInteger(candidate["totalCount"]) &&
    nonnegativeInteger(candidate["printedCount"]) &&
    nonnegativeInteger(candidate["omittedCount"]) &&
    finiteNumber(candidate["totalWeight"]) &&
    candidate["totalWeight"] >= 0 &&
    finiteNumber(candidate["printedWeight"]) &&
    candidate["printedWeight"] >= 0 &&
    finiteNumber(candidate["omittedWeight"]) &&
    candidate["omittedWeight"] >= 0
  );
}

function preflight(value: unknown): value is ThreeMfExportPreflight {
  const candidate = record(value);
  return (
    candidate !== undefined &&
    typeof candidate["title"] === "string" &&
    typeof candidate["profileId"] === "string" &&
    typeof candidate["profileName"] === "string" &&
    dimensions(candidate["dimensions"]) &&
    nonnegativeInteger(candidate["partCount"]) &&
    Array.isArray(candidate["channels"]) &&
    candidate["channels"].every(channel) &&
    stringArray(candidate["warnings"]) &&
    labels(candidate["labels"]) &&
    routes(candidate["routes"]) &&
    typeof candidate["legendIncluded"] === "boolean"
  );
}

function calibrationMeasurement(
  value: unknown,
): value is CalibrationMeasurement {
  const candidate = record(value);
  const id = candidate?.["id"] as
    | CalibrationMeasurement["id"]
    | undefined;
  const expectedAxis =
    id === undefined ? undefined : EXPECTED_CALIBRATION_AXES[id];
  const axis = record(candidate?.["axis"]);
  return (
    candidate !== undefined &&
    id !== undefined &&
    CALIBRATION_MEASUREMENT_IDS.has(id) &&
    finiteNumber(candidate["nominalMm"]) &&
    candidate["nominalMm"] >= 0 &&
    typeof candidate["reference"] === "string" &&
    CALIBRATION_MEASUREMENT_REFERENCES.has(
      candidate["reference"] as CalibrationMeasurement["reference"],
    ) &&
    (candidate["couponId"] === undefined ||
      (typeof candidate["couponId"] === "string" &&
        candidate["couponId"].trim().length > 0)) &&
    (candidate["axis"] === undefined ||
      (axis !== undefined &&
        expectedAxis !== undefined &&
        axis["coordinateSpace"] === "city" &&
        axis["cityAxis"] === expectedAxis.cityAxis &&
        axis["printAxis"] === expectedAxis.printAxis &&
        axis["meaning"] === expectedAxis.meaning))
  );
}

function calibrationPreflight(
  value: unknown,
): value is CalibrationPreflight {
  const candidate = record(value);
  const manifest = record(candidate?.["manifest"]);
  const measurementValues = candidate?.["measurements"];
  const measurements: readonly CalibrationMeasurement[] | undefined =
    Array.isArray(measurementValues) &&
    measurementValues.every(calibrationMeasurement)
      ? measurementValues
      : undefined;
  const measurementIds =
    measurements === undefined
      ? undefined
      : new Set(measurements.map(({ id }) => id));
  const couponIds =
    measurements === undefined
      ? undefined
      : new Set(
          measurements.flatMap(({ couponId }) =>
            couponId === undefined ? [] : [couponId],
          ),
        );
  const calibrationDimensions = record(candidate?.["dimensions"]);
  return (
    candidate !== undefined &&
    typeof candidate["profileId"] === "string" &&
    candidate["profileId"].length > 0 &&
    typeof candidate["profileName"] === "string" &&
    candidate["profileName"].length > 0 &&
    dimensions(candidate["dimensions"]) &&
    Number(calibrationDimensions?.["x"]) > 0 &&
    Number(calibrationDimensions?.["y"]) > 0 &&
    Number(calibrationDimensions?.["z"]) > 0 &&
    positiveInteger(candidate["partCount"]) &&
    positiveInteger(candidate["channelCount"]) &&
    positiveInteger(candidate["triangleCount"]) &&
    measurementIds !== undefined &&
    measurementIds.size === CALIBRATION_MEASUREMENT_IDS.size &&
    measurements !== undefined &&
    measurements.length === CALIBRATION_MEASUREMENT_IDS.size &&
    manifest !== undefined &&
    manifest["schemaVersion"] === "1.0" &&
    manifest["measurementCount"] === measurements.length &&
    positiveInteger(manifest["couponCount"]) &&
    positiveInteger(manifest["channelMarkerCount"]) &&
    couponIds !== undefined &&
    manifest["couponCount"] ===
      couponIds.size + manifest["channelMarkerCount"] &&
    manifest["channelMarkerCount"] === candidate["channelCount"]
  );
}

function failure(value: unknown): value is PrintExportFailure {
  const candidate = record(value);
  return (
    candidate !== undefined &&
    (candidate["kind"] === "validation" ||
      candidate["kind"] === "unexpected" ||
      candidate["kind"] === "protocol") &&
    typeof candidate["name"] === "string" &&
    typeof candidate["message"] === "string" &&
    stringArray(candidate["issues"])
  );
}

export function isPrintExportGenerateRequest(
  value: unknown,
): value is PrintExportGenerateRequest {
  const candidate = record(value);
  return (
    candidate !== undefined &&
    candidate["type"] === "generate" &&
    jobId(candidate["jobId"]) &&
    "model" in candidate &&
    "profile" in candidate &&
    exportOptions(candidate["options"])
  );
}

export function isPrintCalibrationGenerateRequest(
  value: unknown,
): value is PrintCalibrationGenerateRequest {
  const candidate = record(value);
  return (
    candidate !== undefined &&
    candidate["type"] === "calibrate" &&
    jobId(candidate["jobId"]) &&
    "profile" in candidate
  );
}

export function isPrintExportWorkerRequest(
  value: unknown,
): value is PrintExportWorkerRequest {
  return (
    isPrintExportGenerateRequest(value) ||
    isPrintCalibrationGenerateRequest(value)
  );
}

export function isPrintExportWorkerResponse(
  value: unknown,
): value is PrintExportWorkerResponse {
  const candidate = record(value);
  if (candidate === undefined || !jobId(candidate["jobId"])) return false;

  switch (candidate["type"]) {
    case "progress":
      return (
        typeof candidate["phase"] === "string" &&
        EXPORT_PHASES.has(candidate["phase"] as ThreeMfExportPhase) &&
        typeof candidate["completed"] === "number" &&
        Number.isFinite(candidate["completed"]) &&
        candidate["completed"] >= 0 &&
        candidate["completed"] <= 1 &&
        typeof candidate["message"] === "string"
      );
    case "preflight":
      return preflight(candidate["preflight"]);
    case "result":
      return (
        preflight(candidate["preflight"]) &&
        candidate["threeMfBytes"] instanceof ArrayBuffer &&
        (candidate["legendBytes"] === undefined ||
          candidate["legendBytes"] instanceof ArrayBuffer)
      );
    case "calibration-result":
      return (
        calibrationPreflight(candidate["preflight"]) &&
        candidate["threeMfBytes"] instanceof ArrayBuffer &&
        candidate["manifestBytes"] instanceof ArrayBuffer
      );
    case "failure":
      return failure(candidate["error"]);
    default:
      return false;
  }
}

function errorRecord(error: unknown): Record<string, unknown> | undefined {
  return typeof error === "object" && error !== null
    ? (error as Record<string, unknown>)
    : undefined;
}

export function serializePrintExportError(
  error: unknown,
  kind?: PrintExportFailureKind,
): PrintExportFailure {
  const candidate = errorRecord(error);
  const issues = stringArray(candidate?.["issues"])
    ? [...candidate["issues"]]
    : [];
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "The 3MF export failed unexpectedly.";
  const name =
    error instanceof Error
      ? error.name
      : typeof candidate?.["name"] === "string"
        ? candidate["name"]
        : "Error";
  return {
    kind: kind ?? (issues.length > 0 ? "validation" : "unexpected"),
    name,
    message,
    issues,
  };
}
