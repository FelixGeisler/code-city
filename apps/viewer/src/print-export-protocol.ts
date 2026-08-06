import type {
  PrintExportPhase,
} from "../../../packages/exporter/src/print-export.js";
import {
  PRINT_FIDELITY_EPSILON,
  PRINT_FEATURE_CATEGORIES,
  type PrintLayoutIssue,
} from "../../../packages/core/src/print-layout.js";
import type {
  CalibrationMeasurement,
  CalibrationPrintExportPreflight,
} from "../../../packages/exporter/src/calibration.js";
import type {
  PrintPlateExportOptions,
  PrintPlateBundlePreflight,
} from "../../../packages/exporter/src/print-plates.js";
import {
  printLayoutPreviewPlanFromBundle,
  type PrintBundlePreviewSource,
  type PrintLayoutPreviewPlan,
  type RequestedPrintFitPolicy,
} from "./print-plate-preview.js";

export type PrintExportGenerateOptions = Omit<
  PrintPlateExportOptions,
  "fitPolicy" | "acknowledgeBelowProfileScale"
> & {
  readonly fitPolicy?: RequestedPrintFitPolicy;
  /**
   * Confirms the exact below-profile compact plan proposed by an earlier Auto
   * run. The worker still recomputes the plan before serializing it.
   */
  readonly confirmCompactFit?: boolean;
  /** @deprecated Browser UI uses the normal Auto compact-fit confirmation. */
  readonly acknowledgeBelowProfileScale?: boolean;
};

export type PrintExportPreviewSource = PrintBundlePreviewSource;

export interface PrintExportGenerateRequest {
  readonly type: "generate";
  readonly jobId: number;
  readonly format: "3mf" | "stl";
  readonly model: unknown;
  readonly profile: unknown;
  readonly options: PrintExportGenerateOptions;
}

export interface PrintCalibrationGenerateRequest {
  readonly type: "calibrate";
  readonly jobId: number;
  readonly format: "3mf" | "stl";
  readonly profile: unknown;
}

export type PrintExportWorkerRequest =
  | PrintExportGenerateRequest
  | PrintCalibrationGenerateRequest;

export interface PrintExportProgressResponse {
  readonly type: "progress";
  readonly jobId: number;
  readonly phase: PrintExportPhase | "layout";
  readonly completed: number;
  readonly message: string;
}

export interface PrintPlateBundlePreflightResponse {
  readonly type: "bundle-preflight";
  readonly jobId: number;
  readonly preflight: PrintPlateBundlePreflight;
  readonly preview: PrintExportPreviewSource;
}

export interface PrintExportPreflightResponse {
  readonly type: "preflight";
  readonly jobId: number;
  readonly preflight: PrintPlateBundlePreflight;
  readonly preview: PrintExportPreviewSource;
}

export interface PrintCompactFitConfirmationResponse {
  readonly type: "confirmation-required";
  readonly jobId: number;
  readonly preflight: PrintPlateBundlePreflight;
  readonly preview: PrintExportPreviewSource;
}

export type PrintExportTransferArtifact =
  | {
      readonly format: "3mf";
      readonly mimeType: "model/3mf";
      readonly fileExtension: ".3mf";
      readonly bytes: ArrayBuffer;
    }
  | {
      readonly format: "stl";
      readonly mimeType: "model/stl";
      readonly fileExtension: ".stl";
      readonly bytes: ArrayBuffer;
    };

export interface PrintExportResultResponse {
  readonly type: "result";
  readonly jobId: number;
  readonly artifact: PrintExportTransferArtifact;
  readonly manifestBytes: ArrayBuffer;
  readonly legendBytes?: ArrayBuffer;
}

export interface PrintPlateBundleResultResponse {
  readonly type: "bundle-result";
  readonly jobId: number;
  readonly artifact: {
    readonly format: "zip";
    readonly mimeType: "application/zip";
    readonly fileExtension: ".zip";
    readonly bytes: ArrayBuffer;
  };
  readonly manifestBytes: ArrayBuffer;
  readonly legendBytes?: ArrayBuffer;
}

export interface PrintCalibrationResultResponse {
  readonly type: "calibration-result";
  readonly jobId: number;
  readonly preflight: CalibrationPrintExportPreflight;
  readonly artifact: PrintExportTransferArtifact;
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
  readonly issues: readonly (string | PrintLayoutIssue)[];
}

export interface PrintExportFailureResponse {
  readonly type: "failure";
  readonly jobId: number;
  readonly error: PrintExportFailure;
}

export type PrintExportWorkerResponse =
  | PrintExportProgressResponse
  | PrintExportPreflightResponse
  | PrintPlateBundlePreflightResponse
  | PrintCompactFitConfirmationResponse
  | PrintExportResultResponse
  | PrintPlateBundleResultResponse
  | PrintCalibrationResultResponse
  | PrintExportFailureResponse;

const EXPORT_PHASES: ReadonlySet<PrintExportPhase> = new Set([
  "validating",
  "geometry",
  "serializing",
  "complete",
]);
const BUNDLE_PHASES = new Set([
  ...EXPORT_PHASES,
  "layout",
]);
const BUNDLE_PLATE_LIMIT = 99;
const BUNDLE_CHANNEL_LIMIT = 1_000;
const BUNDLE_WARNING_LIMIT = 1_000;
const BUNDLE_ROUTE_OMISSION_LIMIT = 100_000;
const BUNDLE_UNPLACED_OBJECT_LIMIT = 100_000;
const BUNDLE_IDENTIFIER_LIMIT = 512;
const BUNDLE_WARNING_TEXT_LIMIT = 2_048;
const BOUNDS_EPSILON = 1e-7;
const PRINT_ARTIFACT_BYTE_LIMIT = 512 * 1024 * 1024;
const PRINT_MANIFEST_BYTE_LIMIT = 4 * 1024 * 1024;
const PRINT_LEGEND_BYTE_LIMIT = 16 * 1024 * 1024;
const normalizedPreviewCache = new WeakMap<object, PrintLayoutPreviewPlan>();
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

function boundedText(
  value: unknown,
  maximumLength = BUNDLE_IDENTIFIER_LIMIT,
): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength &&
    !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)
  );
}

function boundedStringArray(
  value: unknown,
  maximumItems: number,
  maximumLength = BUNDLE_IDENTIFIER_LIMIT,
): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length <= maximumItems &&
    value.every((item) => boundedText(item, maximumLength)) &&
    new Set(value).size === value.length
  );
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

function printFormat(value: unknown): value is "3mf" | "stl" {
  return value === "3mf" || value === "stl";
}

function exportOptions(value: unknown): value is PrintExportGenerateOptions {
  const candidate = record(value);
  return (
    candidate !== undefined &&
    finiteNumber(candidate["scale"]) &&
    candidate["scale"] > 0 &&
    (candidate["labelPolicy"] === "auto" ||
      candidate["labelPolicy"] === "off") &&
    (candidate["routePolicy"] === "auto" ||
      candidate["routePolicy"] === "off") &&
    typeof candidate["includeLegend"] === "boolean" &&
    (candidate["wipeTowerReserveDepth"] === undefined ||
      (finiteNumber(candidate["wipeTowerReserveDepth"]) &&
        candidate["wipeTowerReserveDepth"] >= 0 &&
        candidate["wipeTowerReserveDepth"] < 360)) &&
    (candidate["acknowledgeBelowProfileScale"] === undefined ||
      typeof candidate["acknowledgeBelowProfileScale"] === "boolean") &&
    (candidate["confirmCompactFit"] === undefined ||
      typeof candidate["confirmCompactFit"] === "boolean") &&
    (candidate["fitPolicy"] === undefined ||
      candidate["fitPolicy"] === "auto" ||
      candidate["fitPolicy"] === "error" ||
      candidate["fitPolicy"] === "scale" ||
      candidate["fitPolicy"] === "tile") &&
    (candidate["confirmCompactFit"] !== true ||
      candidate["fitPolicy"] === undefined ||
      candidate["fitPolicy"] === "auto") &&
    (candidate["maximumPlateCount"] === undefined ||
      (positiveInteger(candidate["maximumPlateCount"]) &&
        Number(candidate["maximumPlateCount"]) <= 99))
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
    candidate["omittedWeight"] >= 0 &&
    candidate["totalCount"] ===
      Number(candidate["printedCount"]) + Number(candidate["omittedCount"]) &&
    approximatelyEqual(
      Number(candidate["totalWeight"]),
      saturatingWeightAdd(
        Number(candidate["printedWeight"]),
        Number(candidate["omittedWeight"]),
      ),
    )
  );
}

function printSize(value: unknown): boolean {
  const candidate = record(value);
  return (
    candidate !== undefined &&
    finiteNumber(candidate["width"]) &&
    candidate["width"] > 0 &&
    finiteNumber(candidate["depth"]) &&
    candidate["depth"] > 0 &&
    finiteNumber(candidate["height"]) &&
    candidate["height"] > 0
  );
}

function portablePlateFileName(
  value: unknown,
  format: "3mf" | "stl",
): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.(?:3mf|stl)$/u.test(value) &&
    value.toLocaleLowerCase("en-US").endsWith(`.${format}`)
  );
}

function bundleEndpoint(value: unknown, plateCount: number): boolean {
  const candidate = record(value);
  return (
    candidate !== undefined &&
    (candidate["kind"] === "building" ||
      candidate["kind"] === "district" ||
      candidate["kind"] === "external") &&
    boundedText(candidate["id"]) &&
    boundedText(candidate["label"]) &&
    (candidate["plateNumber"] === undefined ||
      (positiveInteger(candidate["plateNumber"]) &&
        Number(candidate["plateNumber"]) <= plateCount))
  );
}

function bundleRouteOmissions(
  value: unknown,
  plateCount: number,
): boolean {
  if (
    !Array.isArray(value) ||
    value.length > BUNDLE_ROUTE_OMISSION_LIMIT
  ) {
    return false;
  }
  const routeIds = new Set<string>();
  for (const item of value) {
    const candidate = record(item);
    if (
      candidate === undefined ||
      !boundedText(candidate["routeId"]) ||
      routeIds.has(candidate["routeId"]) ||
      !finiteNumber(candidate["weight"]) ||
      candidate["weight"] <= 0 ||
      (candidate["reason"] !== "cross-plate" &&
        candidate["reason"] !== "route-limit" &&
        candidate["reason"] !== "unroutable" &&
        candidate["reason"] !== "policy" &&
        candidate["reason"] !== "unplaced-endpoint") ||
      !bundleEndpoint(candidate["consumer"], plateCount) ||
      !bundleEndpoint(candidate["provider"], plateCount)
    ) {
      return false;
    }
    routeIds.add(candidate["routeId"]);
  }
  return true;
}

function bundleUnplacedObjects(value: unknown): boolean {
  if (
    !Array.isArray(value) ||
    value.length > BUNDLE_UNPLACED_OBJECT_LIMIT
  ) {
    return false;
  }
  const keys = new Set<string>();
  for (const item of value) {
    const candidate = record(item);
    if (
      candidate === undefined ||
      (candidate["kind"] !== "district" &&
        candidate["kind"] !== "identity" &&
        candidate["kind"] !== "external") ||
      !boundedText(candidate["id"]) ||
      !boundedText(candidate["label"]) ||
      (candidate["reason"] !== "too-large" &&
        candidate["reason"] !== "no-space" &&
        candidate["reason"] !== "minimum-feature" &&
        candidate["reason"] !== "unsupported" &&
        candidate["reason"] !== "other") ||
      (candidate["size"] !== undefined && !printSize(candidate["size"]))
    ) {
      return false;
    }
    const key = `${candidate["kind"]}\0${candidate["id"]}`;
    if (keys.has(key)) return false;
    keys.add(key);
  }
  return true;
}

function bundlePlatePreflight(
  value: unknown,
  format: "3mf" | "stl",
): boolean {
  const candidate = record(value);
  return (
    candidate !== undefined &&
    positiveInteger(candidate["number"]) &&
    Number(candidate["number"]) <= BUNDLE_PLATE_LIMIT &&
    boundedText(candidate["id"]) &&
    portablePlateFileName(candidate["fileName"], format) &&
    printSize(candidate["dimensions"]) &&
    finiteNumber(candidate["utilization"]) &&
    candidate["utilization"] >= 0 &&
    candidate["utilization"] <= 1 &&
    boundedStringArray(candidate["channelIds"], BUNDLE_CHANNEL_LIMIT) &&
    boundedStringArray(
      candidate["warnings"],
      BUNDLE_WARNING_LIMIT,
      BUNDLE_WARNING_TEXT_LIMIT,
    ) &&
    labels(candidate["labels"]) &&
    routes(candidate["routes"])
  );
}

function bundlePreflight(
  value: unknown,
): value is PrintPlateBundlePreflight {
  const candidate = record(value);
  if (
    candidate === undefined ||
    !printFormat(candidate["format"]) ||
    !boundedText(candidate["title"]) ||
    !boundedText(candidate["profileId"]) ||
    !boundedText(candidate["profileName"]) ||
    (candidate["fitPolicy"] !== "error" &&
      candidate["fitPolicy"] !== "scale" &&
      candidate["fitPolicy"] !== "tile") ||
    !finiteNumber(candidate["requestedScale"]) ||
    candidate["requestedScale"] <= 0 ||
    !finiteNumber(candidate["appliedScale"]) ||
    candidate["appliedScale"] <= 0 ||
    !finiteNumber(candidate["minimumSafeScale"]) ||
    candidate["minimumSafeScale"] <= 0 ||
    !finiteNumber(candidate["wipeTowerReserveDepth"]) ||
    candidate["wipeTowerReserveDepth"] < 0 ||
    typeof candidate["belowProfileScaleAcknowledged"] !== "boolean" ||
    !featureViolations(candidate["featureViolations"]) ||
    !positiveInteger(candidate["plateCount"]) ||
    Number(candidate["plateCount"]) > BUNDLE_PLATE_LIMIT ||
    !Array.isArray(candidate["plates"]) ||
    candidate["plates"].length !== candidate["plateCount"] ||
    candidate["plates"].length > BUNDLE_PLATE_LIMIT ||
    !candidate["plates"].every((plate) =>
      bundlePlatePreflight(plate, candidate["format"] as "3mf" | "stl"),
    ) ||
    !labels(candidate["labels"]) ||
    !routes(candidate["routes"]) ||
    !boundedStringArray(
      candidate["warnings"],
      BUNDLE_WARNING_LIMIT,
      BUNDLE_WARNING_TEXT_LIMIT,
    ) ||
    !bundleUnplacedObjects(candidate["unplacedObjects"]) ||
    (candidate["unplacedObjects"] as readonly unknown[]).length !== 0 ||
    !bundleRouteOmissions(
      candidate["routeOmissions"],
      Number(candidate["plateCount"]),
    ) ||
    typeof candidate["legendIncluded"] !== "boolean"
  ) {
    return false;
  }

  const plates = candidate["plates"] as readonly Record<string, unknown>[];
  const numbers = plates.map(({ number }) => Number(number));
  const ids = plates.map(({ id }) => String(id));
  const fileNames = plates.map(({ fileName }) =>
    String(fileName).toLocaleLowerCase("en-US"),
  );
  const normalized = candidate as unknown as PrintPlateBundlePreflight;
  const belowSafe =
    normalized.appliedScale + PRINT_FIDELITY_EPSILON <
    normalized.minimumSafeScale;
  if (
    belowSafe !== (normalized.featureViolations.length > 0) ||
    (belowSafe && !normalized.belowProfileScaleAcknowledged) ||
    ((normalized.fitPolicy === "tile" ||
      normalized.fitPolicy === "error") &&
      !fidelityEqual(
        normalized.appliedScale,
        normalized.requestedScale,
      )) ||
    (normalized.fitPolicy === "error" && normalized.plateCount !== 1) ||
    (normalized.fitPolicy === "scale" && normalized.plateCount !== 1) ||
    (normalized.fitPolicy === "scale" &&
      normalized.appliedScale >
        normalized.requestedScale + PRINT_FIDELITY_EPSILON)
  ) {
    return false;
  }
  const labelTotals = normalized.plates.reduce(
    (total, plate) => ({
      printedBuildings:
        total.printedBuildings + plate.labels.printedBuildings,
      skippedBuildings:
        total.skippedBuildings + plate.labels.skippedBuildings,
      printedDistricts:
        total.printedDistricts + plate.labels.printedDistricts,
      skippedDistricts:
        total.skippedDistricts + plate.labels.skippedDistricts,
    }),
    {
      printedBuildings: 0,
      skippedBuildings: 0,
      printedDistricts: 0,
      skippedDistricts: 0,
    },
  );
  const routeTotals = normalized.plates.reduce(
    (total, plate) => ({
      totalCount: total.totalCount + plate.routes.totalCount,
      printedCount: total.printedCount + plate.routes.printedCount,
      omittedCount: total.omittedCount + plate.routes.omittedCount,
      totalWeight: saturatingWeightAdd(
        total.totalWeight,
        plate.routes.totalWeight,
      ),
      printedWeight: saturatingWeightAdd(
        total.printedWeight,
        plate.routes.printedWeight,
      ),
      omittedWeight: saturatingWeightAdd(
        total.omittedWeight,
        plate.routes.omittedWeight,
      ),
    }),
    {
      totalCount: 0,
      printedCount: 0,
      omittedCount: 0,
      totalWeight: 0,
      printedWeight: 0,
      omittedWeight: 0,
    },
  );
  return (
    new Set(numbers).size === plates.length &&
    new Set(ids).size === plates.length &&
    new Set(fileNames).size === plates.length &&
    [...numbers].sort((left, right) => left - right).every(
      (number, index) => number === index + 1,
    ) &&
    labelTotals.printedBuildings === normalized.labels.printedBuildings &&
    labelTotals.skippedBuildings === normalized.labels.skippedBuildings &&
    labelTotals.printedDistricts === normalized.labels.printedDistricts &&
    labelTotals.skippedDistricts === normalized.labels.skippedDistricts &&
    normalized.plates.every(
      (plate) => plate.routes.policy === normalized.routes.policy,
    ) &&
    routeTotals.totalCount === normalized.routes.totalCount &&
    routeTotals.printedCount === normalized.routes.printedCount &&
    routeTotals.omittedCount === normalized.routes.omittedCount &&
    approximatelyEqual(
      routeTotals.totalWeight,
      normalized.routes.totalWeight,
    ) &&
    approximatelyEqual(
      routeTotals.printedWeight,
      normalized.routes.printedWeight,
    ) &&
    approximatelyEqual(
      routeTotals.omittedWeight,
      normalized.routes.omittedWeight,
    )
  );
}

const FEATURE_CATEGORIES = new Set<string>(PRINT_FEATURE_CATEGORIES);
const FEATURE_CATEGORY_ORDER = new Map<string, number>(
  PRINT_FEATURE_CATEGORIES.map((category, index) => [category, index]),
);

function featureViolations(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > FEATURE_CATEGORIES.size) {
    return false;
  }
  const seen = new Set<string>();
  let previousOrder = -1;
  return value.every((item) => {
    const candidate = record(item);
    const category = candidate?.["category"];
    const order = typeof category === "string"
      ? FEATURE_CATEGORY_ORDER.get(category)
      : undefined;
    if (
      candidate === undefined ||
      typeof category !== "string" ||
      !FEATURE_CATEGORIES.has(category) ||
      seen.has(category) ||
      order === undefined ||
      order <= previousOrder ||
      !finiteNumber(candidate["resultingValue"]) ||
      candidate["resultingValue"] <= 0 ||
      !finiteNumber(candidate["minimum"]) ||
      candidate["resultingValue"] + PRINT_FIDELITY_EPSILON >=
        candidate["minimum"]
    ) {
      return false;
    }
    seen.add(category);
    previousOrder = order;
    return true;
  });
}

export function normalizePrintExportPreviewSource(
  value: unknown,
): PrintLayoutPreviewPlan | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const cached = normalizedPreviewCache.get(value);
  if (cached !== undefined) return cached;
  try {
    const normalized = printLayoutPreviewPlanFromBundle(
      value as PrintExportPreviewSource,
    );
    normalizedPreviewCache.set(value, normalized);
    return normalized;
  } catch {
    return undefined;
  }
}

function approximatelyEqual(left: number, right: number): boolean {
  if (left === right) return true;
  const scale = Math.max(1, Math.abs(left), Math.abs(right));
  return Math.abs(left - right) <= BOUNDS_EPSILON * scale;
}

function fidelityEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= PRINT_FIDELITY_EPSILON;
}

function saturatingWeightAdd(left: number, right: number): number {
  const sum = left + right;
  return Number.isFinite(sum) ? sum : Number.MAX_VALUE;
}

function equalStringSets(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every(
    (value, index) => value === sortedRight[index],
  );
}

function zeroOriginBoundsMatch(
  candidate: PrintLayoutPreviewPlan["printableBounds"],
  expected: { readonly x: number; readonly y: number; readonly z: number },
): boolean {
  return (
    approximatelyEqual(candidate.minimum.x, 0) &&
    approximatelyEqual(candidate.minimum.y, 0) &&
    approximatelyEqual(candidate.minimum.z, 0) &&
    approximatelyEqual(candidate.maximum.x, expected.x) &&
    approximatelyEqual(candidate.maximum.y, expected.y) &&
    approximatelyEqual(candidate.maximum.z, expected.z) &&
    approximatelyEqual(candidate.size.x, expected.x) &&
    approximatelyEqual(candidate.size.y, expected.y) &&
    approximatelyEqual(candidate.size.z, expected.z)
  );
}

function bundleMatchesPreview(
  preflight: PrintPlateBundlePreflight,
  preview: PrintLayoutPreviewPlan,
): boolean {
  if (
    preview.appliedPolicy !== preflight.fitPolicy ||
    !fidelityEqual(preview.requestedScale, preflight.requestedScale) ||
    !fidelityEqual(preview.appliedScale, preflight.appliedScale) ||
    !fidelityEqual(
      preview.minimumSafeScale,
      preflight.minimumSafeScale,
    ) ||
    preview.belowProfileScaleAcknowledged !==
      preflight.belowProfileScaleAcknowledged ||
    JSON.stringify(preview.featureViolations) !==
      JSON.stringify(preflight.featureViolations) ||
    preview.plates.length !== preflight.plateCount ||
    !equalStringSets(preview.warnings, preflight.warnings) ||
    !equalStringSets(
      preview.unplacedObjects,
      preflight.unplacedObjects.map(({ id }) => id),
    )
  ) {
    return false;
  }

  const maximum = preflight.plates.reduce(
    (current, plate) => ({
      x: Math.max(current.x, plate.dimensions.width),
      y: Math.max(current.y, plate.dimensions.depth),
      z: Math.max(current.z, plate.dimensions.height),
    }),
    { x: 0, y: 0, z: 0 },
  );
  if (!zeroOriginBoundsMatch(preview.printableBounds, maximum)) {
    return false;
  }

  const previewByIndex = new Map(
    preview.plates.map((plate) => [plate.index + 1, plate]),
  );
  return preflight.plates.every((plate) => {
    const projected = previewByIndex.get(plate.number);
    return (
      projected !== undefined &&
      projected.id === plate.id &&
      projected.fileName === plate.fileName &&
      approximatelyEqual(projected.utilization, plate.utilization) &&
      zeroOriginBoundsMatch(projected.bounds, {
        x: plate.dimensions.width,
        y: plate.dimensions.depth,
        z: plate.dimensions.height,
      }) &&
      equalStringSets(projected.channels, plate.channelIds) &&
      equalStringSets(projected.warnings, plate.warnings)
    );
  });
}

function singleMatchesPreview(
  preflight: PrintPlateBundlePreflight,
  preview: PrintLayoutPreviewPlan,
): boolean {
  if (
    preflight.plateCount !== 1 ||
    preview.plates.length !== 1 ||
    preview.unplacedObjects.length !== 0 ||
    !equalStringSets(preview.warnings, preflight.warnings) ||
    !bundleMatchesPreview(preflight, preview)
  ) {
    return false;
  }
  const plate = preview.plates[0]!;
  const preflightPlate = preflight.plates[0]!;
  return (
    plate.index === 0 &&
    portablePlateFileName(plate.fileName, preflight.format) &&
    plate.id === preflightPlate.id &&
    plate.fileName === preflightPlate.fileName
  );
}

function compactConfirmationMatches(
  preflight: PrintPlateBundlePreflight,
  preview: PrintLayoutPreviewPlan,
): boolean {
  return (
    preflight.fitPolicy === "scale" &&
    preflight.plateCount === 1 &&
    preflight.featureViolations.length > 0 &&
    preflight.belowProfileScaleAcknowledged &&
    preview.requestedPolicy === "auto" &&
    preview.appliedPolicy === "scale" &&
    singleMatchesPreview(preflight, preview)
  );
}

function bundleTransferArtifact(value: unknown): value is {
  readonly format: "zip";
  readonly mimeType: "application/zip";
  readonly fileExtension: ".zip";
  readonly bytes: ArrayBuffer;
} {
  const candidate = record(value);
  return (
    candidate !== undefined &&
    candidate["format"] === "zip" &&
    candidate["mimeType"] === "application/zip" &&
    candidate["fileExtension"] === ".zip" &&
    boundedPrintTransferBuffer(
      candidate["bytes"],
      PRINT_ARTIFACT_BYTE_LIMIT,
    )
  );
}

export function boundedPrintTransferBuffer(
  value: unknown,
  maximumBytes: number,
): value is ArrayBuffer {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
    throw new TypeError("Transfer-buffer limit must be a positive integer.");
  }
  return (
    value instanceof ArrayBuffer &&
    value.byteLength > 0 &&
    value.byteLength <= maximumBytes
  );
}

function transferArtifact(
  value: unknown,
): value is PrintExportTransferArtifact {
  const candidate = record(value);
  if (
    candidate === undefined ||
    !boundedPrintTransferBuffer(
      candidate["bytes"],
      PRINT_ARTIFACT_BYTE_LIMIT,
    )
  ) {
    return false;
  }
  return candidate["format"] === "3mf"
    ? candidate["mimeType"] === "model/3mf" &&
        candidate["fileExtension"] === ".3mf"
    : candidate["format"] === "stl" &&
        candidate["mimeType"] === "model/stl" &&
        candidate["fileExtension"] === ".stl";
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
): value is CalibrationPrintExportPreflight {
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
    printFormat(candidate["format"]) &&
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
    stringArray(candidate["warnings"]) &&
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

const PRINT_LAYOUT_ISSUE_CODES = new Set([
  "invalid-request",
  "resource-limit",
  "unsafe-scale",
  "district-does-not-fit",
  "reservation-does-not-fit",
  "city-does-not-fit",
]);

function issueVector(value: unknown): boolean {
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

function layoutIssue(value: unknown): value is PrintLayoutIssue {
  const candidate = record(value);
  return (
    candidate !== undefined &&
    typeof candidate["code"] === "string" &&
    PRINT_LAYOUT_ISSUE_CODES.has(candidate["code"]) &&
    boundedText(candidate["message"], BUNDLE_WARNING_TEXT_LIMIT) &&
    (candidate["objectId"] === undefined ||
      boundedText(candidate["objectId"])) &&
    (candidate["required"] === undefined ||
      issueVector(candidate["required"])) &&
    (candidate["available"] === undefined ||
      issueVector(candidate["available"]))
  );
}

function failureIssues(
  value: unknown,
): value is readonly (string | PrintLayoutIssue)[] {
  return (
    Array.isArray(value) &&
    value.length <= BUNDLE_WARNING_LIMIT &&
    value.every(
      (issue) =>
        (typeof issue === "string" &&
          issue.length <= BUNDLE_WARNING_TEXT_LIMIT) ||
        layoutIssue(issue),
    )
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
    failureIssues(candidate["issues"])
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
    printFormat(candidate["format"]) &&
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
    printFormat(candidate["format"]) &&
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
        BUNDLE_PHASES.has(candidate["phase"]) &&
        typeof candidate["completed"] === "number" &&
        Number.isFinite(candidate["completed"]) &&
        candidate["completed"] >= 0 &&
        candidate["completed"] <= 1 &&
        typeof candidate["message"] === "string"
      );
    case "preflight": {
      const cityPreflight = candidate["preflight"];
      const preview = normalizePrintExportPreviewSource(candidate["preview"]);
      return (
        bundlePreflight(cityPreflight) &&
        preview !== undefined &&
        singleMatchesPreview(cityPreflight, preview)
      );
    }
    case "bundle-preflight": {
      const bundle = candidate["preflight"];
      const preview = normalizePrintExportPreviewSource(candidate["preview"]);
      return (
        bundlePreflight(bundle) &&
        bundle.plateCount > 1 &&
        preview !== undefined &&
        bundleMatchesPreview(bundle, preview)
      );
    }
    case "confirmation-required": {
      const proposed = candidate["preflight"];
      const preview = normalizePrintExportPreviewSource(candidate["preview"]);
      return (
        bundlePreflight(proposed) &&
        preview !== undefined &&
        compactConfirmationMatches(proposed, preview)
      );
    }
    case "result": {
      const artifact = candidate["artifact"];
      return (
        transferArtifact(artifact) &&
        candidate["manifestBytes"] instanceof ArrayBuffer &&
        candidate["manifestBytes"].byteLength > 0 &&
        candidate["manifestBytes"].byteLength <=
          PRINT_MANIFEST_BYTE_LIMIT &&
        (candidate["legendBytes"] === undefined ||
          (candidate["legendBytes"] instanceof ArrayBuffer &&
            candidate["legendBytes"].byteLength > 0 &&
            candidate["legendBytes"].byteLength <=
              PRINT_LEGEND_BYTE_LIMIT))
      );
    }
    case "calibration-result": {
      const calibration = candidate["preflight"];
      const artifact = candidate["artifact"];
      return (
        calibrationPreflight(calibration) &&
        transferArtifact(artifact) &&
        calibration.format === artifact.format &&
        candidate["manifestBytes"] instanceof ArrayBuffer &&
        candidate["manifestBytes"].byteLength > 0 &&
        candidate["manifestBytes"].byteLength <=
          PRINT_MANIFEST_BYTE_LIMIT
      );
    }
    case "bundle-result": {
      return (
        bundleTransferArtifact(candidate["artifact"]) &&
        candidate["manifestBytes"] instanceof ArrayBuffer &&
        candidate["manifestBytes"].byteLength > 0 &&
        candidate["manifestBytes"].byteLength <=
          PRINT_MANIFEST_BYTE_LIMIT &&
        (candidate["legendBytes"] === undefined ||
          (candidate["legendBytes"] instanceof ArrayBuffer &&
            candidate["legendBytes"].byteLength > 0 &&
            candidate["legendBytes"].byteLength <=
              PRINT_LEGEND_BYTE_LIMIT))
      );
    }
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

export function viewerPrintExportGuidance(
  message: string,
  issueCode?: PrintLayoutIssue["code"],
): string {
  const visible = message.replaceAll(
    "Split complete districts (tiled multi-plate export)",
    "Tile complete districts (multi-plate)",
  );
  const append = (value: string, guidance: string): string =>
    `${value}${/[.!?]$/u.test(value) ? " " : ". "}${guidance}`;
  if (issueCode === "district-does-not-fit") {
    let guided = visible
      .replace(
        "use fitPolicy 'scale' or 'tile'.",
        'Choose "Auto fit (recommended)" or lower the Target scale.',
      )
      .replace(
        "use fitPolicy 'tile'.",
        'Choose "Auto fit (recommended)" or lower the Target scale.',
      );
    if (!guided.includes("Auto fit (recommended)")) {
      guided = append(
        guided,
        'Choose "Auto fit (recommended)" or lower the Target scale.',
      );
    }
    if (!guided.includes("cannot split this oversized district")) {
      guided = append(
        guided,
        "Whole-district Tile cannot split this oversized district.",
      );
    }
    return guided;
  }
  if (issueCode === "unsafe-scale") {
    const guided = visible
      .replace(
        "use fitPolicy 'scale' or 'tile'.",
        'raise the Target scale or choose "Auto fit (recommended)".',
      )
      .replace(
        "use fitPolicy 'tile'.",
        'raise the Target scale or choose "Auto fit (recommended)".',
      );
    return guided.includes("Auto fit (recommended)")
      ? guided
      : append(
          guided,
          'Raise the Target scale to the profile-safe value, or choose "Auto fit (recommended)" to preview a viable compact fit for confirmation.',
        );
  }
  if (issueCode === "city-does-not-fit") {
    const guided = visible
      .replace(
        'in Print export, set Fit policy to "Scale to one plate" or "Tile complete districts (multi-plate)".',
        'in Print export, choose "Auto fit (recommended)", "Scale to one plate", or "Tile complete districts (multi-plate)".',
      )
      .replace(
        'in Print export, set Fit policy to "Tile complete districts (multi-plate)".',
        'in Print export, choose "Auto fit (recommended)" or "Tile complete districts (multi-plate)".',
      )
      .replace(
        "use fitPolicy 'scale' or 'tile'.",
        'choose "Auto fit (recommended)", "Scale to one plate", or "Tile complete districts (multi-plate)".',
      )
      .replace(
        "use fitPolicy 'tile'.",
        'choose "Auto fit (recommended)" or "Tile complete districts (multi-plate)".',
      );
    return guided.includes("Auto fit (recommended)")
      ? guided
      : append(
          guided,
          'Choose "Auto fit (recommended)"; for a specific outcome, choose "Scale to one plate" or "Tile complete districts (multi-plate)".',
        );
  }
  return visible
    .replace(
      "use fitPolicy 'scale' or 'tile'.",
      'choose "Auto fit (recommended)", "Scale to one plate", or "Tile complete districts (multi-plate)" under Fit policy.',
    )
    .replace(
      "use fitPolicy 'tile'.",
      'choose "Auto fit (recommended)" or "Tile complete districts (multi-plate)" under Fit policy.',
    );
}

export function serializePrintExportError(
  error: unknown,
  kind?: PrintExportFailureKind,
): PrintExportFailure {
  const candidate = errorRecord(error);
  const sourceIssues = failureIssues(candidate?.["issues"])
    ? candidate["issues"]
    : [];
  const issues = sourceIssues.map((issue) => {
    if (typeof issue === "string") {
      return viewerPrintExportGuidance(issue);
    }
    return {
      code: issue.code,
      message: viewerPrintExportGuidance(issue.message, issue.code),
      ...(issue.objectId === undefined
        ? {}
        : { objectId: issue.objectId }),
      ...(issue.required === undefined
        ? {}
        : { required: { ...issue.required } }),
      ...(issue.available === undefined
        ? {}
        : { available: { ...issue.available } }),
    } satisfies PrintLayoutIssue;
  });
  const rawMessage =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "The print export failed unexpectedly.";
  const primaryLayoutIssue = sourceIssues.find(
    (issue): issue is PrintLayoutIssue => typeof issue !== "string",
  );
  const message = viewerPrintExportGuidance(
    rawMessage,
    primaryLayoutIssue?.code,
  );
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
