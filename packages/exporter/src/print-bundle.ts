import {
  strToU8,
  zipSync,
} from "fflate";

import { normalizeDisplayColor } from "../../core/src/color.js";
import type { PrintFormat } from "../../core/src/print.js";
import type {
  PrintBounds,
  PrintLabelReport,
  PrintPart,
  PrintPoint,
  PrintableCity,
  PrintRouteReport,
} from "./geometry.js";
import {
  BINARY_STL_COUNT_SIZE,
  BINARY_STL_FACET_SIZE,
  BINARY_STL_HEADER_SIZE,
  serializeBinaryStl,
} from "./stl.js";
import { serializeThreeMf } from "./three-mf.js";

const FIXED_ZIP_DATE = new Date(1980, 0, 1, 0, 0, 0, 0);
const MANIFEST_PATH = "manifest.json";
const LEGEND_PATH = "legend.json";
const EPSILON = 1e-7;
const WEIGHT_RELATIVE_EPSILON = 1e-10;
const ZIP_FIXED_BYTE_ENVELOPE = 1_024;
const ZIP_ENTRY_BYTE_ENVELOPE = 512;
const THREE_MF_FIXED_BYTE_ENVELOPE = 64 * 1_024;
const THREE_MF_PART_BYTE_ENVELOPE = 8 * 1_024;
const THREE_MF_VERTEX_BYTE_ENVELOPE = 128;
const THREE_MF_TRIANGLE_BYTE_ENVELOPE = 128;
const MANIFEST_FIXED_MINIMUM_BYTES = 256;
const MANIFEST_PLATE_MINIMUM_BYTES = 256;
const MANIFEST_CHANNEL_MINIMUM_BYTES = 96;
const MANIFEST_DISTRICT_MINIMUM_BYTES = 96;
const MANIFEST_EXTERNAL_MINIMUM_BYTES = 128;
const MANIFEST_ROUTE_OMISSION_MINIMUM_BYTES = 192;
const MANIFEST_UNPLACED_MINIMUM_BYTES = 64;
const MANIFEST_WARNING_MINIMUM_BYTES = 4;

export const PRINT_BUNDLE_SCHEMA =
  "https://felixgeisler.github.io/code-city/schemas/print-bundle-v1.json" as const;
export const PRINT_BUNDLE_PLATE_LIMIT = 99;
export const PRINT_BUNDLE_BYTE_LIMIT = 512 * 1024 * 1024;
export const PRINT_BUNDLE_MANIFEST_BYTE_LIMIT = 4 * 1024 * 1024;
export const PRINT_BUNDLE_LEGEND_BYTE_LIMIT = 16 * 1024 * 1024;
export const PRINT_BUNDLE_PLATE_TRIANGLE_LIMIT = 500_000;
export const PRINT_BUNDLE_PLATE_VERTEX_LIMIT = 500_000;

export type PrintBundleFitPolicy = "error" | "scale" | "tile";
export type PrintBundleRotation = 0 | 90;
export type PrintBundleExternalRole = "original" | "replica";
export type PrintBundleEndpointKind =
  | "building"
  | "district"
  | "external";
export type PrintBundleRouteOmissionReason =
  | "cross-plate"
  | "route-limit"
  | "unroutable"
  | "policy"
  | "unplaced-endpoint";
export type PrintBundleUnplacedKind =
  | "district"
  | "identity"
  | "external";
export type PrintBundleUnplacedReason =
  | "too-large"
  | "no-space"
  | "minimum-feature"
  | "unsupported"
  | "other";

export interface PrintBundleSize {
  readonly width: number;
  readonly depth: number;
  readonly height: number;
}

export interface PrintBundleBounds {
  readonly minimum: PrintPoint;
  readonly maximum: PrintPoint;
  readonly size: PrintBundleSize;
}

export interface PrintBundleDistrictTransform {
  readonly districtId: string;
  /**
   * Translation from the source print geometry into this plate's positive
   * print frame. X is bed width and Y is bed depth.
   */
  readonly translation: {
    readonly x: number;
    readonly y: number;
  };
  readonly rotation: PrintBundleRotation;
}

export interface PrintBundleEndpointIdentity {
  readonly kind: PrintBundleEndpointKind;
  /**
   * Stable printable identity (for example a district/building print code or
   * an external target). Callers must not pass a local source path.
   */
  readonly id: string;
  readonly label: string;
  readonly plateNumber?: number;
}

export interface PrintBundleRouteOmission {
  readonly routeId: string;
  readonly weight: number;
  readonly reason: PrintBundleRouteOmissionReason;
  readonly consumer: PrintBundleEndpointIdentity;
  readonly provider: PrintBundleEndpointIdentity;
}

export interface PrintBundleExternalDependency {
  readonly target: string;
  readonly weight: number;
  readonly role: PrintBundleExternalRole;
  readonly consumer: PrintBundleEndpointIdentity;
}

export interface PrintBundleUnplacedObject {
  readonly kind: PrintBundleUnplacedKind;
  readonly id: string;
  readonly label: string;
  readonly reason: PrintBundleUnplacedReason;
  readonly size?: PrintBundleSize;
}

export interface PrintBundlePlateRequest {
  readonly number: number;
  readonly id: string;
  /**
   * Plate-specific geometry in the positive print octant. It must contain one
   * continuous base envelope and only the objects assigned to this plate.
   */
  readonly city: PrintableCity;
  readonly utilization: number;
  readonly districts: readonly PrintBundleDistrictTransform[];
  readonly externalDependencies: readonly PrintBundleExternalDependency[];
  readonly warnings: readonly string[];
  readonly labels: PrintLabelReport;
  readonly routes: PrintRouteReport;
}

export interface PrintBundleRequest {
  readonly format: PrintFormat;
  readonly title: string;
  readonly version?: string;
  readonly profile: {
    readonly id: string;
    readonly name: string;
  };
  readonly fitPolicy: PrintBundleFitPolicy;
  readonly requestedScale: number;
  readonly appliedScale: number;
  readonly warnings: readonly string[];
  readonly unplacedObjects: readonly PrintBundleUnplacedObject[];
  readonly routeOmissions: readonly PrintBundleRouteOmission[];
  readonly plates: readonly PrintBundlePlateRequest[];
  readonly legendBytes?: Uint8Array;
}

export interface PrintBundleChannelSummary {
  readonly id: string;
  readonly partId: string;
  readonly label: string;
  readonly displayColor: string;
  readonly semanticGroupIds: readonly string[];
  readonly primitiveCount: number;
  readonly triangleCount: number;
}

export interface PrintBundleDistrictLayout {
  readonly districtId: string;
  readonly translation: {
    readonly x: number;
    readonly y: number;
  };
  readonly rotation: PrintBundleRotation;
  readonly bounds: PrintBundleBounds;
}

export interface PrintBundlePlateLayout {
  readonly bounds: PrintBundleBounds;
  readonly base: PrintBundleBounds;
  readonly utilization: number;
  readonly districts: readonly PrintBundleDistrictLayout[];
}

export interface PrintBundlePlatePreflight {
  readonly format: PrintFormat;
  readonly plateNumber: number;
  readonly fileName: string;
  readonly dimensions: PrintBundleSize;
  readonly partCount: number;
  readonly triangleCount: number;
  readonly channels: readonly PrintBundleChannelSummary[];
  readonly warnings: readonly string[];
  readonly labels: PrintLabelReport;
  readonly routes: PrintRouteReport;
  readonly routeOmissionCount: number;
  readonly externalDependencyCount: number;
}

export interface PrintBundleManifestPlate {
  readonly number: number;
  readonly id: string;
  readonly file: string;
  readonly layout: PrintBundlePlateLayout;
  readonly preflight: PrintBundlePlatePreflight;
  /**
   * Repeated on every relevant plate so that one plate remains intelligible
   * when its external endpoint is a replicated fixed-size box.
   */
  readonly externalDependencies: readonly PrintBundleExternalDependency[];
}

export interface PrintBundleManifest {
  readonly schema: typeof PRINT_BUNDLE_SCHEMA;
  readonly title: string;
  readonly version?: string;
  readonly format: PrintFormat;
  readonly profile: {
    readonly id: string;
    readonly name: string;
  };
  readonly fit: {
    readonly policy: PrintBundleFitPolicy;
    readonly requestedScale: number;
    readonly appliedScale: number;
  };
  readonly plateCount: number;
  readonly warnings: readonly string[];
  readonly unplacedObjects: readonly PrintBundleUnplacedObject[];
  readonly routeOmissionSummary: {
    readonly count: number;
    readonly totalWeight: number;
    readonly byReason: Readonly<
      Record<PrintBundleRouteOmissionReason, number>
    >;
  };
  readonly routeOmissions: readonly PrintBundleRouteOmission[];
  readonly plates: readonly PrintBundleManifestPlate[];
  readonly legendFile?: typeof LEGEND_PATH;
}

export type PrintBundlePlateArtifact =
  | {
      readonly format: "3mf";
      readonly plateNumber: number;
      readonly fileName: string;
      readonly mimeType: "model/3mf";
      readonly bytes: Uint8Array;
      readonly preflight: PrintBundlePlatePreflight;
    }
  | {
      readonly format: "stl";
      readonly plateNumber: number;
      readonly fileName: string;
      readonly mimeType: "model/stl";
      readonly bytes: Uint8Array;
      readonly preflight: PrintBundlePlatePreflight;
    };

export interface PrintBundleResult {
  readonly mimeType: "application/zip";
  readonly fileExtension: ".zip";
  readonly fileName: string;
  readonly bytes: Uint8Array;
  readonly manifest: PrintBundleManifest;
  readonly manifestBytes: Uint8Array;
  readonly artifacts: readonly PrintBundlePlateArtifact[];
}

export interface PrintBundleSerializationLimits {
  /**
   * Optional lower ceiling for constrained callers and bounded verification.
   * It can never raise the hard process-wide bundle limit.
   */
  readonly maximumBytes?: number;
}

interface PrintBundleByteBudget {
  readonly maximumBytes: number;
  committedBytes: number;
}

interface NormalizedPrintBundlePlate {
  readonly manifest: PrintBundleManifestPlate;
  readonly city: PrintableCity;
  readonly artifactByteEnvelope: number;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function requiredText(
  value: string,
  field: string,
  maximumLength = 512,
): string {
  if (typeof value !== "string") {
    throw new TypeError(`${field} must be text.`);
  }
  const normalized = value.normalize("NFC").trim();
  if (normalized === "") {
    throw new TypeError(`${field} must not be empty.`);
  }
  if (normalized.length > maximumLength) {
    throw new RangeError(
      `${field} exceeds the ${maximumLength} character safety limit.`,
    );
  }
  for (const character of normalized) {
    const codePoint = character.codePointAt(0)!;
    if (
      codePoint < 0x20 ||
      codePoint === 0x7f ||
      codePoint === 0x2028 ||
      codePoint === 0x2029
    ) {
      throw new TypeError(`${field} contains a control character.`);
    }
  }
  return normalized;
}

function positive(value: number, field: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${field} must be a positive finite number.`);
  }
  return Object.is(value, -0) ? 0 : value;
}

function nonNegative(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative finite number.`);
  }
  return Object.is(value, -0) ? 0 : value;
}

function positiveWeight(value: number, field: string): number {
  const result = nonNegative(value, field);
  if (result === 0) {
    throw new RangeError(`${field} must be positive.`);
  }
  return result;
}

function saturatingWeightAdd(left: number, right: number): number {
  return right > Number.MAX_VALUE - left
    ? Number.MAX_VALUE
    : left + right;
}

function weightsEqual(left: number, right: number): boolean {
  if (left === right) return true;
  const scale = Math.max(Math.abs(left), Math.abs(right));
  return (
    scale > 0 &&
    Math.abs(left - right) / scale <= WEIGHT_RELATIVE_EPSILON
  );
}

function count(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative safe integer.`);
  }
  return value;
}

function copyPoint(point: PrintPoint, field: string): PrintPoint {
  return {
    x: nonNegative(point.x, `${field}.x`),
    y: nonNegative(point.y, `${field}.y`),
    z: nonNegative(point.z, `${field}.z`),
  };
}

function sizeFromBounds(bounds: PrintBounds): PrintBundleSize {
  return {
    width: positive(bounds.size.x, "bounds.size.x"),
    depth: positive(bounds.size.y, "bounds.size.y"),
    height: positive(bounds.size.z, "bounds.size.z"),
  };
}

function normalizedBounds(
  bounds: PrintBounds,
  field: string,
): PrintBundleBounds {
  const minimum = copyPoint(bounds.minimum, `${field}.minimum`);
  const maximum = copyPoint(bounds.maximum, `${field}.maximum`);
  const size = sizeFromBounds(bounds);
  for (const [axis, expected] of [
    ["x", size.width],
    ["y", size.depth],
    ["z", size.height],
  ] as const) {
    if (
      maximum[axis] <= minimum[axis] ||
      Math.abs(maximum[axis] - minimum[axis] - expected) > EPSILON
    ) {
      throw new RangeError(`${field} has inconsistent ${axis} bounds.`);
    }
  }
  return { minimum, maximum, size };
}

function envelope(
  bounds: readonly PrintBounds[],
  field: string,
): PrintBundleBounds {
  if (bounds.length === 0) {
    throw new TypeError(`${field} requires printable base geometry.`);
  }
  const minimum = {
    x: Math.min(...bounds.map((item) => item.minimum.x)),
    y: Math.min(...bounds.map((item) => item.minimum.y)),
    z: Math.min(...bounds.map((item) => item.minimum.z)),
  };
  const maximum = {
    x: Math.max(...bounds.map((item) => item.maximum.x)),
    y: Math.max(...bounds.map((item) => item.maximum.y)),
    z: Math.max(...bounds.map((item) => item.maximum.z)),
  };
  return normalizedBounds(
    {
      minimum,
      maximum,
      size: {
        x: maximum.x - minimum.x,
        y: maximum.y - minimum.y,
        z: maximum.z - minimum.z,
      },
    },
    field,
  );
}

function normalizedWarnings(
  values: readonly string[],
  field: string,
): readonly string[] {
  if (!Array.isArray(values)) {
    throw new TypeError(`${field} must be an array.`);
  }
  if (values.length > 1_000) {
    throw new RangeError(`${field} exceeds the 1000 item safety limit.`);
  }
  return [
    ...new Set(
      values.map((value, index) =>
        requiredText(value, `${field}[${index}]`, 2_048),
      ),
    ),
  ].sort(compare);
}

function normalizedLabels(
  value: PrintLabelReport,
  field: string,
): PrintLabelReport {
  return {
    printedBuildings: count(
      value.printedBuildings,
      `${field}.printedBuildings`,
    ),
    skippedBuildings: count(
      value.skippedBuildings,
      `${field}.skippedBuildings`,
    ),
    printedDistricts: count(
      value.printedDistricts,
      `${field}.printedDistricts`,
    ),
    skippedDistricts: count(
      value.skippedDistricts,
      `${field}.skippedDistricts`,
    ),
  };
}

function normalizedRoutes(
  value: PrintRouteReport,
  field: string,
): PrintRouteReport {
  const report: PrintRouteReport = {
    policy: value.policy,
    totalCount: count(value.totalCount, `${field}.totalCount`),
    printedCount: count(value.printedCount, `${field}.printedCount`),
    omittedCount: count(value.omittedCount, `${field}.omittedCount`),
    totalWeight: nonNegative(value.totalWeight, `${field}.totalWeight`),
    printedWeight: nonNegative(
      value.printedWeight,
      `${field}.printedWeight`,
    ),
    omittedWeight: nonNegative(
      value.omittedWeight,
      `${field}.omittedWeight`,
    ),
  };
  if (report.policy !== "auto" && report.policy !== "off") {
    throw new TypeError(`${field}.policy must be either 'auto' or 'off'.`);
  }
  if (
    report.printedCount > report.totalCount ||
    report.omittedCount !== report.totalCount - report.printedCount
  ) {
    throw new RangeError(`${field} route counts are inconsistent.`);
  }
  if (
    (
      report.printedWeight > report.totalWeight &&
      !weightsEqual(report.printedWeight, report.totalWeight)
    ) ||
    (
      report.omittedWeight > report.totalWeight &&
      !weightsEqual(report.omittedWeight, report.totalWeight)
    ) ||
    !weightsEqual(
      saturatingWeightAdd(report.printedWeight, report.omittedWeight),
      report.totalWeight,
    )
  ) {
    throw new RangeError(`${field} route weights are inconsistent.`);
  }
  return report;
}

function normalizedEndpoint(
  value: PrintBundleEndpointIdentity,
  field: string,
  plateCount: number,
): PrintBundleEndpointIdentity {
  if (
    value.kind !== "building" &&
    value.kind !== "district" &&
    value.kind !== "external"
  ) {
    throw new TypeError(`${field}.kind is unsupported.`);
  }
  const plateNumber =
    value.plateNumber === undefined
      ? undefined
      : count(value.plateNumber, `${field}.plateNumber`);
  if (
    plateNumber !== undefined &&
    (plateNumber < 1 || plateNumber > plateCount)
  ) {
    throw new RangeError(`${field}.plateNumber does not identify a plate.`);
  }
  return {
    kind: value.kind,
    id: requiredText(value.id, `${field}.id`, 512),
    label: requiredText(value.label, `${field}.label`, 512),
    ...(plateNumber === undefined ? {} : { plateNumber }),
  };
}

function endpointOrderKey(value: PrintBundleEndpointIdentity): string {
  return [
    value.kind,
    value.id,
    value.label,
    String(value.plateNumber ?? 0).padStart(4, "0"),
  ].join("\0");
}

function normalizedRouteOmissions(
  values: readonly PrintBundleRouteOmission[],
  plateCount: number,
): readonly PrintBundleRouteOmission[] {
  if (!Array.isArray(values)) {
    throw new TypeError("routeOmissions must be an array.");
  }
  if (values.length > 100_000) {
    throw new RangeError(
      "routeOmissions exceeds the 100000 item safety limit.",
    );
  }
  const ids = new Set<string>();
  const result = values.map((value, index): PrintBundleRouteOmission => {
    const routeId = requiredText(
      value.routeId,
      `routeOmissions[${index}].routeId`,
      512,
    );
    if (ids.has(routeId)) {
      throw new TypeError(`Duplicate omitted route '${routeId}'.`);
    }
    ids.add(routeId);
    if (
      value.reason !== "cross-plate" &&
      value.reason !== "route-limit" &&
      value.reason !== "unroutable" &&
      value.reason !== "policy" &&
      value.reason !== "unplaced-endpoint"
    ) {
      throw new TypeError(
        `routeOmissions[${index}].reason is unsupported.`,
      );
    }
    return {
      routeId,
      weight: positiveWeight(
        value.weight,
        `routeOmissions[${index}].weight`,
      ),
      reason: value.reason,
      consumer: normalizedEndpoint(
        value.consumer,
        `routeOmissions[${index}].consumer`,
        plateCount,
      ),
      provider: normalizedEndpoint(
        value.provider,
        `routeOmissions[${index}].provider`,
        plateCount,
      ),
    };
  });
  return result.sort(
    (left, right) =>
      compare(left.routeId, right.routeId) ||
      compare(endpointOrderKey(left.consumer), endpointOrderKey(right.consumer)) ||
      compare(endpointOrderKey(left.provider), endpointOrderKey(right.provider)),
  );
}

function normalizedExternalDependencies(
  values: readonly PrintBundleExternalDependency[],
  field: string,
  plateCount: number,
  plateNumber: number,
): readonly PrintBundleExternalDependency[] {
  if (!Array.isArray(values)) {
    throw new TypeError(`${field} must be an array.`);
  }
  if (values.length > 100_000) {
    throw new RangeError(`${field} exceeds the 100000 item safety limit.`);
  }
  const keys = new Set<string>();
  const result = values.map((value, index): PrintBundleExternalDependency => {
    if (value.role !== "original" && value.role !== "replica") {
      throw new TypeError(`${field}[${index}].role is unsupported.`);
    }
    const normalizedConsumer = normalizedEndpoint(
      value.consumer,
      `${field}[${index}].consumer`,
      plateCount,
    );
    if (normalizedConsumer.kind === "external") {
      throw new TypeError(
        `${field}[${index}].consumer must be a district or building.`,
      );
    }
    if (
      normalizedConsumer.plateNumber !== undefined &&
      normalizedConsumer.plateNumber !== plateNumber
    ) {
      throw new RangeError(
        `${field}[${index}].consumer belongs to a different plate.`,
      );
    }
    const consumer = {
      ...normalizedConsumer,
      plateNumber,
    };
    const item = {
      target: requiredText(
        value.target,
        `${field}[${index}].target`,
        512,
      ),
      weight: positiveWeight(value.weight, `${field}[${index}].weight`),
      role: value.role,
      consumer,
    };
    const key = [
      item.target,
      item.role,
      endpointOrderKey(item.consumer),
    ].join("\0");
    if (keys.has(key)) {
      throw new TypeError(`${field} contains duplicate external metadata.`);
    }
    keys.add(key);
    return item;
  });
  return result.sort(
    (left, right) =>
      compare(left.target, right.target) ||
      compare(left.role, right.role) ||
      compare(endpointOrderKey(left.consumer), endpointOrderKey(right.consumer)),
  );
}

function normalizedSize(
  value: PrintBundleSize,
  field: string,
): PrintBundleSize {
  return {
    width: positive(value.width, `${field}.width`),
    depth: positive(value.depth, `${field}.depth`),
    height: positive(value.height, `${field}.height`),
  };
}

function normalizedUnplacedObjects(
  values: readonly PrintBundleUnplacedObject[],
): readonly PrintBundleUnplacedObject[] {
  if (!Array.isArray(values)) {
    throw new TypeError("unplacedObjects must be an array.");
  }
  if (values.length > 100_000) {
    throw new RangeError(
      "unplacedObjects exceeds the 100000 item safety limit.",
    );
  }
  const keys = new Set<string>();
  const result = values.map((value, index): PrintBundleUnplacedObject => {
    if (
      value.kind !== "district" &&
      value.kind !== "identity" &&
      value.kind !== "external"
    ) {
      throw new TypeError(`unplacedObjects[${index}].kind is unsupported.`);
    }
    if (
      value.reason !== "too-large" &&
      value.reason !== "no-space" &&
      value.reason !== "minimum-feature" &&
      value.reason !== "unsupported" &&
      value.reason !== "other"
    ) {
      throw new TypeError(
        `unplacedObjects[${index}].reason is unsupported.`,
      );
    }
    const item: PrintBundleUnplacedObject = {
      kind: value.kind,
      id: requiredText(value.id, `unplacedObjects[${index}].id`, 512),
      label: requiredText(
        value.label,
        `unplacedObjects[${index}].label`,
        512,
      ),
      reason: value.reason,
      ...(value.size === undefined
        ? {}
        : {
            size: normalizedSize(
              value.size,
              `unplacedObjects[${index}].size`,
            ),
          }),
    };
    const key = `${item.kind}\0${item.id}`;
    if (keys.has(key)) {
      throw new TypeError(`Duplicate unplaced object '${item.id}'.`);
    }
    keys.add(key);
    return item;
  });
  return result.sort(
    (left, right) =>
      compare(left.kind, right.kind) || compare(left.id, right.id),
  );
}

function channelSummaries(
  parts: readonly PrintPart[],
): readonly PrintBundleChannelSummary[] {
  return [...parts]
    .sort(
      (left, right) =>
        compare(left.channelId, right.channelId) ||
        compare(left.id, right.id),
    )
    .map((part, index) => ({
      id: requiredText(part.channelId, `parts[${index}].channelId`, 256),
      partId: requiredText(part.id, `parts[${index}].id`, 256),
      label: requiredText(part.name, `parts[${index}].name`, 512),
      displayColor: normalizeDisplayColor(
        requiredText(
          part.displayColor,
          `parts[${index}].displayColor`,
          9,
        ),
        `parts[${index}].displayColor`,
      ),
      semanticGroupIds: [
        ...new Set(
          part.semanticGroupIds.map((id, groupIndex) =>
            requiredText(
              id,
              `parts[${index}].semanticGroupIds[${groupIndex}]`,
              256,
            ),
          ),
        ),
      ].sort(compare),
      primitiveCount: count(
        part.primitives.length,
        `parts[${index}].primitiveCount`,
      ),
      triangleCount: count(
        part.mesh.triangles.length,
        `parts[${index}].triangleCount`,
      ),
    }));
}

function plateResources(
  parts: readonly PrintPart[],
  cityBounds: PrintBundleBounds,
): {
  readonly triangleCount: number;
  readonly vertexCount: number;
} {
  let triangleResult = 0;
  let vertexResult = 0;
  const minimum = {
    x: Number.POSITIVE_INFINITY,
    y: Number.POSITIVE_INFINITY,
    z: Number.POSITIVE_INFINITY,
  };
  const maximum = {
    x: Number.NEGATIVE_INFINITY,
    y: Number.NEGATIVE_INFINITY,
    z: Number.NEGATIVE_INFINITY,
  };
  for (const [index, part] of parts.entries()) {
    const triangles = count(
      part.mesh.triangles.length,
      `parts[${index}].triangleCount`,
    );
    const vertices = count(
      part.mesh.vertices.length,
      `parts[${index}].vertexCount`,
    );
    if (
      triangles > PRINT_BUNDLE_PLATE_TRIANGLE_LIMIT ||
      triangleResult > PRINT_BUNDLE_PLATE_TRIANGLE_LIMIT - triangles
    ) {
      throw new RangeError(
        `Plate triangle count exceeds the ${PRINT_BUNDLE_PLATE_TRIANGLE_LIMIT} triangle safety limit.`,
      );
    }
    if (
      vertices > PRINT_BUNDLE_PLATE_VERTEX_LIMIT ||
      vertexResult > PRINT_BUNDLE_PLATE_VERTEX_LIMIT - vertices
    ) {
      throw new RangeError(
        `Plate vertex count exceeds the ${PRINT_BUNDLE_PLATE_VERTEX_LIMIT} vertex safety limit.`,
      );
    }
    triangleResult += triangles;
    vertexResult += vertices;
    part.mesh.vertices.forEach((vertex, vertexIndex) => {
      for (const axis of ["x", "y", "z"] as const) {
        const coordinate = nonNegative(
          vertex[axis],
          `parts[${index}].vertices[${vertexIndex}].${axis}`,
        );
        minimum[axis] = Math.min(minimum[axis], coordinate);
        maximum[axis] = Math.max(maximum[axis], coordinate);
      }
    });
  }
  if (vertexResult === 0 || triangleResult === 0) {
    throw new TypeError("Plate geometry must not be empty.");
  }
  for (const axis of ["x", "y", "z"] as const) {
    if (
      Math.abs(minimum[axis] - cityBounds.minimum[axis]) > EPSILON ||
      Math.abs(maximum[axis] - cityBounds.maximum[axis]) > EPSILON
    ) {
      throw new RangeError(
        `Plate mesh envelope does not match declared ${axis.toUpperCase()} bounds.`,
      );
    }
  }
  return {
    triangleCount: triangleResult,
    vertexCount: vertexResult,
  };
}

function safeByteSum(
  values: readonly number[],
  description: string,
): number {
  let total = 0;
  for (const value of values) {
    if (
      !Number.isSafeInteger(value) ||
      value < 0 ||
      total > Number.MAX_SAFE_INTEGER - value
    ) {
      throw new RangeError(`${description} exceeds a safe integer.`);
    }
    total += value;
  }
  return total;
}

function safeByteProduct(
  countValue: number,
  bytesPerItem: number,
  description: string,
): number {
  const itemCount = count(countValue, `${description} item count`);
  if (
    !Number.isSafeInteger(bytesPerItem) ||
    bytesPerItem < 0 ||
    (
      itemCount > 0 &&
      bytesPerItem > Math.floor(Number.MAX_SAFE_INTEGER / itemCount)
    )
  ) {
    throw new RangeError(`${description} exceeds a safe integer.`);
  }
  return itemCount * bytesPerItem;
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

/**
 * A deliberately low, guaranteed byte floor for the pretty-printed manifest.
 * It can reject an impossible request before normalizing tens of thousands of
 * records, but never replaces the exact UTF-8 byte check below.
 */
function manifestMinimumByteEnvelope(
  request: PrintBundleRequest,
  plates: readonly PrintBundlePlateRequest[],
): number {
  const values = [
    MANIFEST_FIXED_MINIMUM_BYTES,
    safeByteProduct(
      arrayLength(request.warnings),
      MANIFEST_WARNING_MINIMUM_BYTES,
      "Manifest warnings",
    ),
    safeByteProduct(
      arrayLength(request.unplacedObjects),
      MANIFEST_UNPLACED_MINIMUM_BYTES,
      "Manifest unplaced objects",
    ),
    safeByteProduct(
      arrayLength(request.routeOmissions),
      MANIFEST_ROUTE_OMISSION_MINIMUM_BYTES,
      "Manifest route omissions",
    ),
    safeByteProduct(
      plates.length,
      MANIFEST_PLATE_MINIMUM_BYTES,
      "Manifest plates",
    ),
  ];
  for (const [index, plate] of plates.entries()) {
    values.push(
      safeByteProduct(
        arrayLength(plate.warnings),
        MANIFEST_WARNING_MINIMUM_BYTES,
        `Manifest plate ${index + 1} warnings`,
      ),
      safeByteProduct(
        arrayLength(plate.districts),
        MANIFEST_DISTRICT_MINIMUM_BYTES,
        `Manifest plate ${index + 1} districts`,
      ),
      safeByteProduct(
        arrayLength(plate.externalDependencies),
        MANIFEST_EXTERNAL_MINIMUM_BYTES,
        `Manifest plate ${index + 1} external dependencies`,
      ),
      safeByteProduct(
        arrayLength(plate.city.parts),
        MANIFEST_CHANNEL_MINIMUM_BYTES,
        `Manifest plate ${index + 1} channels`,
      ),
    );
  }
  return safeByteSum(values, "Print manifest minimum byte envelope");
}

function zipByteEnvelope(entryCount: number): number {
  return safeByteSum(
    [
      ZIP_FIXED_BYTE_ENVELOPE,
      count(entryCount, "ZIP entry count") * ZIP_ENTRY_BYTE_ENVELOPE,
    ],
    "ZIP container byte envelope",
  );
}

function plateArtifactByteEnvelope(
  format: PrintFormat,
  city: PrintableCity,
  resources: {
    readonly triangleCount: number;
    readonly vertexCount: number;
  },
): number {
  if (format === "stl") {
    return safeByteSum(
      [
        BINARY_STL_HEADER_SIZE,
        BINARY_STL_COUNT_SIZE,
        resources.triangleCount * BINARY_STL_FACET_SIZE,
      ],
      "Binary STL byte envelope",
    );
  }
  const escapedMetadataBytes = safeByteSum(
    [
      city.title.length * 3,
      city.version?.length ?? 0,
      city.application.name.length,
      city.application.version.length,
      city.profileId.length,
      ...city.parts.map(({ name }) => name.length * 2),
    ].map((characters) => characters * 6),
    "3MF escaped metadata byte envelope",
  );
  return safeByteSum(
    [
      THREE_MF_FIXED_BYTE_ENVELOPE,
      count(city.parts.length, "3MF part count") *
        THREE_MF_PART_BYTE_ENVELOPE,
      escapedMetadataBytes,
      resources.vertexCount * THREE_MF_VERTEX_BYTE_ENVELOPE,
      resources.triangleCount * THREE_MF_TRIANGLE_BYTE_ENVELOPE,
    ],
    "3MF byte envelope",
  );
}

function plateResourceEnvelopeCounts(
  parts: readonly PrintPart[],
  plateNumber: number,
): {
  readonly triangleCount: number;
  readonly vertexCount: number;
} {
  if (!Array.isArray(parts)) {
    throw new TypeError(`Plate ${plateNumber} parts must be an array.`);
  }
  let triangleCount = 0;
  let vertexCount = 0;
  for (const [index, part] of parts.entries()) {
    if (
      typeof part !== "object" ||
      part === null ||
      typeof part.mesh !== "object" ||
      part.mesh === null ||
      !Array.isArray(part.mesh.triangles) ||
      !Array.isArray(part.mesh.vertices)
    ) {
      throw new TypeError(
        `Plate ${plateNumber} part ${index + 1} mesh must contain vertex and triangle arrays.`,
      );
    }
    const triangles = count(
      part.mesh.triangles.length,
      `Plate ${plateNumber} part ${index + 1} triangle count`,
    );
    const vertices = count(
      part.mesh.vertices.length,
      `Plate ${plateNumber} part ${index + 1} vertex count`,
    );
    if (
      triangles > PRINT_BUNDLE_PLATE_TRIANGLE_LIMIT ||
      triangleCount > PRINT_BUNDLE_PLATE_TRIANGLE_LIMIT - triangles
    ) {
      throw new RangeError(
        `Plate triangle count exceeds the ${PRINT_BUNDLE_PLATE_TRIANGLE_LIMIT} triangle safety limit.`,
      );
    }
    if (
      vertices > PRINT_BUNDLE_PLATE_VERTEX_LIMIT ||
      vertexCount > PRINT_BUNDLE_PLATE_VERTEX_LIMIT - vertices
    ) {
      throw new RangeError(
        `Plate vertex count exceeds the ${PRINT_BUNDLE_PLATE_VERTEX_LIMIT} vertex safety limit.`,
      );
    }
    triangleCount += triangles;
    vertexCount += vertices;
  }
  return { triangleCount, vertexCount };
}

function reservePlateBytes(
  budget: PrintBundleByteBudget,
  plateNumber: number,
  byteEnvelope: number,
  stage = "serializing",
): void {
  if (byteEnvelope > budget.maximumBytes - budget.committedBytes) {
    throw new RangeError(
      `Print bundle would exceed its ${budget.maximumBytes} byte limit before ${stage} plate ${plateNumber}; ` +
      `${budget.committedBytes} bytes are already reserved and this plate requires a conservative ${byteEnvelope} byte envelope.`,
    );
  }
  budget.committedBytes += byteEnvelope;
}

function districtLayouts(
  plate: PrintBundlePlateRequest,
  plateIndex: number,
): readonly PrintBundleDistrictLayout[] {
  if (!Array.isArray(plate.districts)) {
    throw new TypeError(`plates[${plateIndex}].districts must be an array.`);
  }
  const primitiveBounds = new Map<string, PrintBounds>();
  for (const part of plate.city.parts) {
    for (const primitive of part.primitives) {
      if (primitive.kind !== "district") continue;
      if (primitiveBounds.has(primitive.id)) {
        throw new TypeError(
          `Plate ${plate.number} contains duplicate district primitive '${primitive.id}'.`,
        );
      }
      primitiveBounds.set(primitive.id, primitive.bounds);
    }
  }
  const ids = new Set<string>();
  const layouts = plate.districts.map(
    (district, index): PrintBundleDistrictLayout => {
      const districtId = requiredText(
        district.districtId,
        `plates[${plateIndex}].districts[${index}].districtId`,
        512,
      );
      if (ids.has(districtId)) {
        throw new TypeError(
          `Plate ${plate.number} contains duplicate district '${districtId}'.`,
        );
      }
      ids.add(districtId);
      const bounds = primitiveBounds.get(districtId);
      if (bounds === undefined) {
        throw new TypeError(
          `Plate ${plate.number} has no printable district '${districtId}'.`,
        );
      }
      if (district.rotation !== 0 && district.rotation !== 90) {
        throw new TypeError(
          `plates[${plateIndex}].districts[${index}].rotation must be 0 or 90.`,
        );
      }
      const x = district.translation.x;
      const y = district.translation.y;
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw new RangeError(
          `plates[${plateIndex}].districts[${index}].translation must be finite.`,
        );
      }
      return {
        districtId,
        translation: {
          x: Object.is(x, -0) ? 0 : x,
          y: Object.is(y, -0) ? 0 : y,
        },
        rotation: district.rotation,
        bounds: normalizedBounds(
          bounds,
          `plates[${plateIndex}].districts[${index}].bounds`,
        ),
      };
    },
  );
  for (const primitiveId of primitiveBounds.keys()) {
    if (!ids.has(primitiveId)) {
      throw new TypeError(
        `Plate ${plate.number} is missing the transform for district '${primitiveId}'.`,
      );
    }
  }
  return layouts.sort((left, right) =>
    compare(left.districtId, right.districtId),
  );
}

function plateBase(
  plate: PrintBundlePlateRequest,
  plateIndex: number,
): PrintBundleBounds {
  const baseBounds = plate.city.parts.flatMap(({ primitives }) =>
    primitives
      .filter(({ kind }) => kind === "base")
      .map(({ bounds }) => bounds),
  );
  if (baseBounds.length !== 1) {
    throw new TypeError(
      `Plate ${plate.number} must contain exactly one continuous base primitive.`,
    );
  }
  const base = envelope(baseBounds, `plates[${plateIndex}].base`);
  const city = normalizedBounds(
    plate.city.bounds,
    `plates[${plateIndex}].city.bounds`,
  );
  for (const axis of ["x", "y"] as const) {
    if (
      Math.abs(base.minimum[axis] - city.minimum[axis]) > EPSILON ||
      Math.abs(base.maximum[axis] - city.maximum[axis]) > EPSILON
    ) {
      throw new RangeError(
        `Plate ${plate.number} base must cover the complete ${axis.toUpperCase()} plate footprint.`,
      );
    }
  }
  if (Math.abs(base.minimum.z - city.minimum.z) > EPSILON) {
    throw new RangeError(
      `Plate ${plate.number} base must start at the plate's minimum height.`,
    );
  }
  return base;
}

function plateFileName(
  plateNumber: number,
  format: PrintFormat,
): string {
  return `plate-${String(plateNumber).padStart(2, "0")}.${format}`;
}

function routeOmissionCountForPlate(
  omissions: readonly PrintBundleRouteOmission[],
  plateNumber: number,
): number {
  return omissions.filter(
    ({ consumer, provider }) =>
      consumer.plateNumber === plateNumber ||
      provider.plateNumber === plateNumber,
  ).length;
}

function serializePlateArtifact(
  format: PrintFormat,
  city: PrintableCity,
): Uint8Array {
  switch (format) {
    case "3mf":
      return serializeThreeMf(city);
    case "stl":
      return serializeBinaryStl(city);
  }
}

function normalizedPlate(
  request: PrintBundleRequest,
  plate: PrintBundlePlateRequest,
  plateIndex: number,
  routeOmissions: readonly PrintBundleRouteOmission[],
): NormalizedPrintBundlePlate {
  if (
    requiredText(plate.city.profileId, "city.profileId", 256) !==
    request.profile.id
  ) {
    throw new TypeError(
      `Plate ${plate.number} profile does not match the bundle profile.`,
    );
  }
  if (Math.abs(plate.city.scale - request.appliedScale) > EPSILON) {
    throw new RangeError(
      `Plate ${plate.number} scale does not match the applied bundle scale.`,
    );
  }
  if (requiredText(plate.city.title, "city.title") !== request.title) {
    throw new TypeError(
      `Plate ${plate.number} title does not match the bundle title.`,
    );
  }
  const cityVersion =
    plate.city.version === undefined
      ? undefined
      : requiredText(plate.city.version, "city.version", 512);
  if (cityVersion !== request.version) {
    throw new TypeError(
      `Plate ${plate.number} version does not match the bundle version.`,
    );
  }
  const fileName = plateFileName(plate.number, request.format);
  const normalizedCityBounds = normalizedBounds(
    plate.city.bounds,
    `plates[${plateIndex}].city.bounds`,
  );
  const dimensions = normalizedCityBounds.size;
  const resources = plateResources(
    plate.city.parts,
    normalizedCityBounds,
  );
  const artifactByteEnvelope = plateArtifactByteEnvelope(
    request.format,
    plate.city,
    resources,
  );
  const channels = channelSummaries(plate.city.parts);
  const layout: PrintBundlePlateLayout = {
    bounds: normalizedCityBounds,
    base: plateBase(plate, plateIndex),
    utilization: nonNegative(
      plate.utilization,
      `plates[${plateIndex}].utilization`,
    ),
    districts: districtLayouts(plate, plateIndex),
  };
  if (layout.utilization > 1 + EPSILON) {
    throw new RangeError(
      `plates[${plateIndex}].utilization must not exceed 1.`,
    );
  }
  const externalDependencies = normalizedExternalDependencies(
    plate.externalDependencies,
    `plates[${plateIndex}].externalDependencies`,
    request.plates.length,
    plate.number,
  );
  const preflight: PrintBundlePlatePreflight = {
    format: request.format,
    plateNumber: plate.number,
    fileName,
    dimensions,
    partCount:
      request.format === "stl" ? 1 : plate.city.parts.length,
    triangleCount: resources.triangleCount,
    channels,
    warnings: normalizedWarnings(
      plate.warnings,
      `plates[${plateIndex}].warnings`,
    ),
    labels: normalizedLabels(
      plate.labels,
      `plates[${plateIndex}].labels`,
    ),
    routes: normalizedRoutes(
      plate.routes,
      `plates[${plateIndex}].routes`,
    ),
    routeOmissionCount: routeOmissionCountForPlate(
      routeOmissions,
      plate.number,
    ),
    externalDependencyCount: externalDependencies.length,
  };
  return {
    manifest: {
      number: plate.number,
      id: requiredText(plate.id, `plates[${plateIndex}].id`, 256),
      file: fileName,
      layout,
      preflight,
      externalDependencies,
    },
    city: plate.city,
    artifactByteEnvelope,
  };
}

function serializeNormalizedPlate(
  format: PrintFormat,
  plate: NormalizedPrintBundlePlate,
  byteBudget: PrintBundleByteBudget,
): PrintBundlePlateArtifact {
  reservePlateBytes(
    byteBudget,
    plate.manifest.number,
    plate.artifactByteEnvelope,
  );
  const bytes = serializePlateArtifact(format, plate.city);
  if (bytes.byteLength > plate.artifactByteEnvelope) {
    throw new RangeError(
      `Plate ${plate.manifest.number} serialization exceeded its conservative ${plate.artifactByteEnvelope} byte envelope.`,
    );
  }
  return format === "3mf"
    ? {
        format: "3mf",
        plateNumber: plate.manifest.number,
        fileName: plate.manifest.file,
        mimeType: "model/3mf",
        bytes,
        preflight: plate.manifest.preflight,
      }
    : {
        format: "stl",
        plateNumber: plate.manifest.number,
        fileName: plate.manifest.file,
        mimeType: "model/stl",
        bytes,
        preflight: plate.manifest.preflight,
      };
}

function validatePlateNumbers(
  plates: readonly PrintBundlePlateRequest[],
): readonly PrintBundlePlateRequest[] {
  if (!Array.isArray(plates) || plates.length === 0) {
    throw new TypeError("Print bundle requires at least one plate.");
  }
  if (plates.length > PRINT_BUNDLE_PLATE_LIMIT) {
    throw new RangeError(
      `Print bundle exceeds the ${PRINT_BUNDLE_PLATE_LIMIT} plate safety limit.`,
    );
  }
  const ordered = [...plates].sort(
    (left, right) => left.number - right.number,
  );
  const ids = new Set<string>();
  for (const [index, plate] of ordered.entries()) {
    if (!Number.isSafeInteger(plate.number) || plate.number !== index + 1) {
      throw new RangeError(
        "Print bundle plate numbers must be contiguous integers starting at 1.",
      );
    }
    const id = requiredText(plate.id, `plates[${index}].id`, 256);
    if (ids.has(id)) {
      throw new TypeError(`Duplicate print plate id '${id}'.`);
    }
    ids.add(id);
  }
  return ordered;
}

function bundleSlug(title: string): string {
  const slug = title
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[\u0300-\u036f]/gu, "")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80)
    .replace(/-+$/gu, "");
  return slug === "" ? "code-city" : slug;
}

function bundleZip(
  artifacts: readonly PrintBundlePlateArtifact[],
  manifestBytes: Uint8Array,
  legendBytes: Uint8Array | undefined,
  maximumBytes: number,
): Uint8Array {
  let totalBytes = manifestBytes.byteLength;
  const entries = new Map<string, Uint8Array>([
    [MANIFEST_PATH, manifestBytes],
  ]);
  for (const artifact of artifacts) {
    if (entries.has(artifact.fileName)) {
      throw new TypeError(
        `Duplicate print bundle file '${artifact.fileName}'.`,
      );
    }
    totalBytes += artifact.bytes.byteLength;
    entries.set(artifact.fileName, artifact.bytes);
  }
  if (legendBytes !== undefined) {
    if (legendBytes.byteLength > PRINT_BUNDLE_LEGEND_BYTE_LIMIT) {
      throw new RangeError(
        `Print legend exceeds the ${PRINT_BUNDLE_LEGEND_BYTE_LIMIT} byte safety limit.`,
      );
    }
    totalBytes += legendBytes.byteLength;
    entries.set(LEGEND_PATH, legendBytes);
  }
  const containerEnvelope = zipByteEnvelope(entries.size);
  if (
    !Number.isSafeInteger(totalBytes) ||
    totalBytes > maximumBytes - containerEnvelope
  ) {
    throw new RangeError(
      `Print bundle exceeds the ${maximumBytes} byte safety limit including ZIP overhead.`,
    );
  }
  const files: Record<string, [Uint8Array, { level: 0; mtime: Date }]> = {};
  for (const path of [...entries.keys()].sort(compare)) {
    files[path] = [
      entries.get(path)!,
      { level: 0, mtime: FIXED_ZIP_DATE },
    ];
  }
  const bytes = zipSync(files, {
    level: 0,
    mtime: FIXED_ZIP_DATE,
  });
  if (bytes.byteLength > maximumBytes) {
    throw new RangeError(
      `Print bundle exceeds the ${maximumBytes} byte safety limit.`,
    );
  }
  return bytes;
}

function routeOmissionSummary(
  values: readonly PrintBundleRouteOmission[],
): PrintBundleManifest["routeOmissionSummary"] {
  const byReason: Record<PrintBundleRouteOmissionReason, number> = {
    "cross-plate": 0,
    "route-limit": 0,
    unroutable: 0,
    policy: 0,
    "unplaced-endpoint": 0,
  };
  let totalWeight = 0;
  for (const omission of values) {
    byReason[omission.reason] += 1;
    totalWeight = saturatingWeightAdd(totalWeight, omission.weight);
  }
  return { count: values.length, totalWeight, byReason };
}

/**
 * Serializes one independent print artifact per physical plate plus a concise
 * deterministic manifest. The supplied cities are already plate-aware; this
 * layer never clips or silently drops model geometry.
 */
export function serializePrintBundle(
  request: PrintBundleRequest,
  limits: PrintBundleSerializationLimits = {},
): PrintBundleResult {
  if (request.format !== "3mf" && request.format !== "stl") {
    throw new TypeError("Print bundle format must be either '3mf' or 'stl'.");
  }
  if (
    request.fitPolicy !== "error" &&
    request.fitPolicy !== "scale" &&
    request.fitPolicy !== "tile"
  ) {
    throw new TypeError(
      "Print bundle fit policy must be 'error', 'scale', or 'tile'.",
    );
  }
  const maximumBytes =
    limits.maximumBytes ?? PRINT_BUNDLE_BYTE_LIMIT;
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes <= 0 ||
    maximumBytes > PRINT_BUNDLE_BYTE_LIMIT
  ) {
    throw new RangeError(
      `maximumBytes must be a positive safe integer no greater than ${PRINT_BUNDLE_BYTE_LIMIT}.`,
    );
  }
  const title = requiredText(request.title, "title");
  const version =
    request.version === undefined
      ? undefined
      : requiredText(request.version, "version", 512);
  const profile = {
    id: requiredText(request.profile.id, "profile.id", 256),
    name: requiredText(request.profile.name, "profile.name", 512),
  };
  const requestedScale = positive(
    request.requestedScale,
    "requestedScale",
  );
  const appliedScale = positive(request.appliedScale, "appliedScale");
  if (
    request.fitPolicy === "error" &&
    Math.abs(requestedScale - appliedScale) > EPSILON
  ) {
    throw new RangeError(
      "The 'error' fit policy must not change the requested scale.",
    );
  }
  if (
    request.fitPolicy !== "error" &&
    appliedScale > requestedScale + EPSILON
  ) {
    throw new RangeError(
      `The '${request.fitPolicy}' fit policy must not enlarge the requested scale.`,
    );
  }
  const legendBytes =
    request.legendBytes === undefined
      ? undefined
      : new Uint8Array(request.legendBytes);
  if (
    legendBytes !== undefined &&
    legendBytes.byteLength > PRINT_BUNDLE_LEGEND_BYTE_LIMIT
  ) {
    throw new RangeError(
      `Print legend exceeds the ${PRINT_BUNDLE_LEGEND_BYTE_LIMIT} byte safety limit.`,
    );
  }
  const plates = validatePlateNumbers(request.plates);
  if (request.fitPolicy !== "tile" && plates.length !== 1) {
    throw new RangeError(
      `The '${request.fitPolicy}' fit policy must produce exactly one plate.`,
    );
  }
  const manifestMinimumBytes = manifestMinimumByteEnvelope(request, plates);
  if (manifestMinimumBytes > PRINT_BUNDLE_MANIFEST_BYTE_LIMIT) {
    throw new RangeError(
      `Print manifest has a conservative minimum envelope of ${manifestMinimumBytes} bytes and exceeds the ${PRINT_BUNDLE_MANIFEST_BYTE_LIMIT} byte safety limit before normalization.`,
    );
  }
  const earlyByteBudget: PrintBundleByteBudget = {
    maximumBytes,
    committedBytes: safeByteSum(
      [
        manifestMinimumBytes,
        legendBytes?.byteLength ?? 0,
        zipByteEnvelope(
          plates.length + 1 + (legendBytes === undefined ? 0 : 1),
        ),
      ],
      "Print bundle early byte envelope",
    ),
  };
  if (earlyByteBudget.committedBytes > maximumBytes) {
    throw new RangeError(
      `Print bundle minimum manifest, legend, and ZIP envelope exceeds the ${maximumBytes} byte safety limit before plate normalization.`,
    );
  }
  for (const plate of plates) {
    const resources = plateResourceEnvelopeCounts(
      plate.city.parts,
      plate.number,
    );
    reservePlateBytes(
      earlyByteBudget,
      plate.number,
      plateArtifactByteEnvelope(request.format, plate.city, resources),
      "normalizing",
    );
  }
  const {
    version: _untrustedVersion,
    ...requestWithoutVersion
  } = request;
  const normalizedRequest: PrintBundleRequest = {
    ...requestWithoutVersion,
    title,
    ...(version === undefined ? {} : { version }),
    profile,
    requestedScale,
    appliedScale,
    plates,
  };
  const routeOmissions = normalizedRouteOmissions(
    request.routeOmissions,
    plates.length,
  );
  const warnings = normalizedWarnings(request.warnings, "warnings");
  const unplacedObjects = normalizedUnplacedObjects(
    request.unplacedObjects,
  );
  const normalized = plates.map((plate, index) =>
    normalizedPlate(
      normalizedRequest,
      plate,
      index,
      routeOmissions,
    ),
  );
  const manifest: PrintBundleManifest = {
    schema: PRINT_BUNDLE_SCHEMA,
    title,
    ...(version === undefined ? {} : { version }),
    format: request.format,
    profile,
    fit: {
      policy: request.fitPolicy,
      requestedScale,
      appliedScale,
    },
    plateCount: plates.length,
    warnings,
    unplacedObjects,
    routeOmissionSummary: routeOmissionSummary(routeOmissions),
    routeOmissions,
    plates: normalized.map(({ manifest: plate }) => plate),
    ...(legendBytes === undefined ? {} : { legendFile: LEGEND_PATH }),
  };
  const manifestBytes = strToU8(`${JSON.stringify(manifest, null, 2)}\n`);
  if (manifestBytes.byteLength > PRINT_BUNDLE_MANIFEST_BYTE_LIMIT) {
    throw new RangeError(
      `Print manifest exceeds the ${PRINT_BUNDLE_MANIFEST_BYTE_LIMIT} byte safety limit.`,
    );
  }
  const byteBudget: PrintBundleByteBudget = {
    maximumBytes,
    committedBytes: safeByteSum(
      [
        manifestBytes.byteLength,
        legendBytes?.byteLength ?? 0,
        zipByteEnvelope(
          plates.length + 1 + (legendBytes === undefined ? 0 : 1),
        ),
      ],
      "Print bundle fixed byte envelope",
    ),
  };
  if (byteBudget.committedBytes > maximumBytes) {
    throw new RangeError(
      `Print bundle manifest, legend, and ZIP envelope exceeds the ${maximumBytes} byte safety limit.`,
    );
  }
  const artifacts = normalized.map((plate) =>
    serializeNormalizedPlate(request.format, plate, byteBudget),
  );
  const bytes = bundleZip(
    artifacts,
    manifestBytes,
    legendBytes,
    maximumBytes,
  );
  return {
    mimeType: "application/zip",
    fileExtension: ".zip",
    fileName: `${bundleSlug(title)}-print-bundle.zip`,
    bytes,
    manifest,
    manifestBytes,
    artifacts,
  };
}
