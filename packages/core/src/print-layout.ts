import type { Vector3 } from "./model.js";
import {
  resolvePrinterGeometryLimits,
  validatePrinterProfile,
  type PrinterProfile,
  type ResolvedPrinterGeometryLimits,
} from "./print.js";

export type PrintFitPolicy = "error" | "scale" | "tile";
/** Shared boundary tolerance for all scale-fidelity contracts. */
export const PRINT_FIDELITY_EPSILON = 1e-9;
/**
 * Stable persisted feature order. `base-thickness` remains for legacy
 * manifest/3MF decoding, but the planner no longer emits it because bases are
 * physically clamped to the profile floor.
 */
export const PRINT_FEATURE_CATEGORIES = Object.freeze([
  "wall-thickness",
  "gap",
  "minimum-feature-size",
  "base-thickness",
  "label-stroke-width",
  "raised-feature-height",
  "recessed-feature-depth",
  "route-width",
  "connector-width",
] as const);
export type PrintFeatureCategory =
  (typeof PRINT_FEATURE_CATEGORIES)[number];

/** A profile fidelity limit crossed by the applied physical scale. */
export interface PrintFeatureViolation {
  readonly category: PrintFeatureCategory;
  /** Resulting physical measurement in millimetres. */
  readonly resultingValue: number;
  /** Configured printer-profile minimum in millimetres. */
  readonly minimum: number;
}

/** Durable scale/fidelity metadata shared by previews and print artifacts. */
export interface PrintScaleFidelity {
  readonly requestedScale: number;
  readonly appliedScale: number;
  readonly minimumSafeScale: number;
  readonly belowProfileScaleAcknowledged: boolean;
  readonly featureViolations: readonly PrintFeatureViolation[];
}
export type PrintLayoutRotation = 0 | 90;
export type PrintLayoutReservationKind =
  | "identity"
  | "plate-number"
  | "external-apron"
  | "external-box";

/**
 * An exact printable envelope in the CityModel axis convention. Values are
 * expressed at scale 1; the layout planner converts them to millimetres.
 */
export interface PrintLayoutBounds {
  readonly minimum: Vector3;
  readonly maximum: Vector3;
}

/**
 * A complete district envelope. Callers include every district-owned parcel,
 * building, label, and other printable feature in sourceBounds.
 */
export interface PrintLayoutDistrictInput {
  readonly id: string;
  readonly name: string;
  readonly sourceBounds: PrintLayoutBounds;
  /**
   * Exposed bottom foundation thickness inside sourceBounds at scale 1. The
   * planner may raise its physical thickness to the conservative maximum of
   * the profile's base-thickness and raised-feature-height minima.
   */
  readonly sourceFoundationThickness?: number;
  readonly channelIds?: readonly string[];
}

/**
 * The exact name/version/fixed-icon envelope reserved on plate 1.
 */
export interface PrintLayoutIdentityInput {
  readonly id: string;
  readonly sourceBounds: PrintLayoutBounds;
  /**
   * `model` (default) follows appliedScale. `physical` treats sourceBounds as
   * exact millimetres, keeping profile-safe glyph/icon geometry unchanged.
   */
  readonly scaleMode?: "model" | "physical";
  readonly channelIds?: readonly string[];
}

/**
 * A fixed physical strip reserved at the rear (+Z) of every plate. The
 * exporter can place duplicated external dependency boxes inside this exact
 * area after district-to-plate assignment is known.
 */
export interface PrintLayoutRearReservationInput {
  readonly id: string;
  readonly depth: number;
  readonly height: number;
  /**
   * Conservative capacity proof. Every listed box is deterministically packed
   * into the apron on every plate, so any plate-specific subset is guaranteed
   * to fit at the returned slot bounds.
   */
  readonly boxes?: readonly PrintLayoutExternalBoxInput[];
  readonly channelIds?: readonly string[];
}

export interface PrintLayoutExternalBoxInput {
  readonly id: string;
  readonly size: Vector3;
  readonly channelIds?: readonly string[];
}

/**
 * Smallest source dimensions at scale 1. A null optional measurement means
 * that feature is absent (for example, routes disabled for this export).
 */
export interface PrintLayoutFeatureMeasurements {
  readonly wallThickness: number;
  readonly gap: number | null;
  readonly minimumFeatureSize: number;
  /** Shared plate-base source thickness; physically clamped by the planner. */
  readonly baseThickness: number;
  readonly labelStrokeWidth?: number | null;
  readonly raisedFeatureHeight?: number | null;
  readonly recessedFeatureDepth?: number | null;
  readonly routeWidth?: number | null;
  readonly connectorWidth?: number | null;
}

export interface PrintLayoutRequest {
  readonly fitPolicy?: PrintFitPolicy;
  readonly requestedScale?: number;
  /**
   * Explicit expert acknowledgement that an applied scale may put printable
   * details below the selected profile's guaranteed fidelity limits. It does
   * not bypass physical build-volume checks.
   */
  readonly acknowledgeBelowProfileScale?: boolean;
  readonly districts: readonly PrintLayoutDistrictInput[];
  readonly features: PrintLayoutFeatureMeasurements;
  readonly identity?: PrintLayoutIdentityInput;
  readonly rearReservation?: PrintLayoutRearReservationInput;
  /**
   * Non-printable physical depth reserved at the rear (+Z) edge of the usable
   * build surface. This remains outside the generated continuous plate base so
   * a slicer can place auxiliary print structures there.
   */
  readonly reservedRearDepth?: number;
  /**
   * Physical street width between independently placed objects. The planner
   * raises smaller values to the printer minimum and records a warning.
   */
  readonly districtGap?: number;
  /**
   * Optional artifact cap. Tile mode reports remaining districts as unplaced
   * instead of silently dropping them.
   */
  readonly maximumPlateCount?: number;
  /** Channel used by the continuous base and generated plate numbers. */
  readonly baseChannelId?: string;
}

/**
 * Source-to-plate transform. Rotation is clockwise in the X/Z plane:
 * 0°: x'=x*s+tx, z'=z*s+tz
 * 90°: x'=-z*s+tx, z'=x*s+tz
 */
export interface PrintLayoutTransform {
  readonly scale: number;
  readonly rotation: PrintLayoutRotation;
  readonly translation: Vector3;
}

export interface PrintLayoutDistrictPlacement {
  readonly districtId: string;
  readonly name: string;
  readonly plateId: string;
  readonly sourceBounds: PrintLayoutBounds;
  readonly bounds: PrintLayoutBounds;
  /** Profile-safe physical foundation thickness exposed above the plate base. */
  readonly foundationThickness: number;
  /**
   * Physical Y offset added to uniformly scaled non-foundation contents.
   */
  readonly foundationLift: number;
  /** Transform for non-foundation district contents, including the lift. */
  readonly transform: PrintLayoutTransform;
  readonly channelIds: readonly string[];
}

export interface PrintLayoutReservationPlacement {
  readonly id: string;
  readonly kind: PrintLayoutReservationKind;
  readonly plateId: string;
  readonly label?: string;
  readonly virtual?: boolean;
  readonly bounds: PrintLayoutBounds;
  readonly transform?: PrintLayoutTransform;
  readonly channelIds: readonly string[];
}

export interface PrintLayoutBase {
  readonly id: string;
  readonly channelId: string;
  readonly bounds: PrintLayoutBounds;
  readonly position: Vector3;
  readonly size: Vector3;
}

export interface PrintLayoutPlate {
  readonly id: string;
  readonly index: number;
  readonly bounds: PrintLayoutBounds;
  readonly dimensions: Vector3;
  readonly base: PrintLayoutBase;
  readonly districts: readonly PrintLayoutDistrictPlacement[];
  readonly reservations: readonly PrintLayoutReservationPlacement[];
  readonly channelIds: readonly string[];
  /** Fraction of the usable build surface occupied by printable footprints. */
  readonly utilization: number;
  readonly occupiedArea: number;
  readonly usableArea: number;
}

export interface PrintLayoutUnplacedObject {
  readonly kind: "district";
  readonly id: string;
  readonly name: string;
  readonly reason: "plate-limit";
  readonly required: Vector3;
}

export interface PrintLayoutPlan {
  readonly profileId: string;
  readonly fitPolicy: PrintFitPolicy;
  readonly requestedScale: number;
  /**
   * Requested scale when it fits, otherwise a deterministic conservative
   * scale grown from one known-valid packing topology. It is not a claim of
   * globally optimal bin packing.
   */
  readonly appliedScale: number;
  readonly minimumSafeScale: number;
  readonly belowProfileScaleAcknowledged: boolean;
  readonly featureViolations: readonly PrintFeatureViolation[];
  readonly buildVolume: Vector3;
  readonly usableBuildBounds: PrintLayoutBounds;
  readonly usableBuildSpan: Vector3;
  /** Resolved non-printable strip at the rear (+Z) build-surface edge. */
  readonly reservedRearDepth: number;
  readonly districtGap: number;
  readonly plates: readonly PrintLayoutPlate[];
  readonly warnings: readonly string[];
  readonly unplaced: readonly PrintLayoutUnplacedObject[];
}

export type PrintLayoutIssueCode =
  | "invalid-request"
  | "resource-limit"
  | "unsafe-scale"
  | "district-does-not-fit"
  | "reservation-does-not-fit"
  | "city-does-not-fit";

export interface PrintLayoutIssue {
  readonly code: PrintLayoutIssueCode;
  readonly message: string;
  readonly objectId?: string;
  readonly required?: Vector3;
  readonly available?: Vector3;
}

export class PrintLayoutError extends Error {
  public readonly issues: readonly PrintLayoutIssue[];

  public constructor(issues: readonly PrintLayoutIssue[]) {
    const detached = issues.map((issue) => ({ ...issue }));
    super(`Invalid print layout: ${detached.map(({ message }) => message).join(" ")}`);
    this.name = "PrintLayoutError";
    this.issues = detached;
  }
}

interface Rectangle {
  readonly x: number;
  readonly z: number;
  readonly width: number;
  readonly depth: number;
}

interface PackItem {
  readonly id: string;
  readonly kind: "district" | PrintLayoutReservationKind;
  readonly name: string;
  readonly width: number;
  readonly depth: number;
  readonly height: number;
  readonly sourceBounds?: PrintLayoutBounds;
  readonly sourceScale?: number;
  readonly foundationThickness?: number;
  readonly foundationLift?: number;
  readonly channelIds: readonly string[];
  readonly allowRotation: boolean;
}

interface PackedItem extends PackItem {
  readonly x: number;
  readonly z: number;
  readonly rotation: PrintLayoutRotation;
}

interface PackingState {
  readonly free: readonly Rectangle[];
  readonly items: readonly PackedItem[];
}

interface PlacementCandidate {
  readonly item: PackedItem;
  readonly score: readonly number[];
}

interface MutablePlate {
  readonly index: number;
  readonly id: string;
  readonly state: PackingState;
}

type PlateCreationResult =
  | { readonly plate: MutablePlate; readonly issue?: never }
  | { readonly plate?: never; readonly issue: PrintLayoutIssue };

interface LayoutContext {
  readonly profile: PrinterProfile;
  readonly limits: ResolvedPrinterGeometryLimits;
  readonly usableBounds: PrintLayoutBounds;
  readonly usableSpan: Vector3;
  /** X/Z span available to identity, number, and districts before the apron. */
  readonly packingSpan: Vector3;
  readonly reservedRearDepth: number;
  readonly baseChannelId: string;
  readonly gap: number;
  readonly plateIdDigits: number;
  readonly maximumPlateCount: number;
  readonly identity?: PrintLayoutIdentityInput;
  readonly rearReservation?: PrintLayoutRearReservationInput;
  readonly features: PrintLayoutFeatureMeasurements;
}

interface AttemptResult {
  readonly plates: readonly MutablePlate[];
  readonly unplaced: readonly PackItem[];
}

const EPSILON = PRINT_FIDELITY_EPSILON;
const SCALE_SEARCH_BELOW_ITERATIONS = 52;
const SCALE_SEARCH_REFINEMENT_ITERATIONS = 32;
const PLATE_ID_DIGITS = 2;
const MAXIMUM_PLATE_COUNT = 99;
const MAXIMUM_DISTRICT_COUNT = 512;
const MAXIMUM_EXTERNAL_BOX_COUNT = 128;
const MAXIMUM_FREE_RECTANGLE_COUNT = 4_096;
const MAXIMUM_ID_LENGTH = 256;
const MAXIMUM_NAME_LENGTH = 512;
const FIT_POLICIES = new Set<PrintFitPolicy>(["error", "scale", "tile"]);

function scaleSearchDiscoveryIntervals(districtCount: number): number {
  if (districtCount <= 16) return 4_096;
  if (districtCount <= 64) return 1_024;
  if (districtCount <= 128) return 512;
  if (districtCount <= 256) return 256;
  return 128;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function finitePositive(value: number, field: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new PrintLayoutError([
      {
        code: "invalid-request",
        message: `${field} must be a positive finite number.`,
      },
    ]);
  }
  return value;
}

function finiteNonNegative(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new PrintLayoutError([
      {
        code: "invalid-request",
        message: `${field} must be a non-negative finite number.`,
      },
    ]);
  }
  return value;
}

function finiteLayoutArithmetic(
  value: number,
  field: string,
  objectId?: string,
): number {
  if (!Number.isFinite(value)) {
    throw new PrintLayoutError([
      {
        code: "resource-limit",
        ...(objectId === undefined ? {} : { objectId }),
        message: `${field} exceeds the finite numeric range supported by the print-layout planner.`,
      },
    ]);
  }
  return Object.is(value, -0) ? 0 : value;
}

function finiteScaledLength(
  value: number,
  scale: number,
  field: string,
  objectId?: string,
): number {
  const result = finiteLayoutArithmetic(
    value * scale,
    field,
    objectId,
  );
  if (result <= 0) {
    throw new PrintLayoutError([
      {
        code: "resource-limit",
        ...(objectId === undefined ? {} : { objectId }),
        message: `${field} is too small to remain positive in the print-layout numeric representation.`,
      },
    ]);
  }
  return result;
}

interface PhysicalFoundationScale {
  readonly thickness: number;
  readonly lift: number;
}

function physicalFoundationScale(
  sourceThickness: number,
  scale: number,
  minimumThickness: number,
  field: string,
  objectId?: string,
): PhysicalFoundationScale {
  const scaledThickness = finiteScaledLength(
    sourceThickness,
    scale,
    `${field} scaled thickness`,
    objectId,
  );
  const thickness = Math.max(scaledThickness, minimumThickness);
  return {
    thickness,
    lift: finiteLayoutArithmetic(
      thickness - scaledThickness,
      `${field} lift`,
      objectId,
    ),
  };
}

function physicalBaseThickness(
  context: LayoutContext,
  scale: number,
  field: string,
  objectId?: string,
): number {
  return physicalFoundationScale(
    context.features.baseThickness,
    scale,
    context.limits.minimumBaseThickness,
    field,
    objectId,
  ).thickness;
}

function districtFoundationScale(
  district: PrintLayoutDistrictInput,
  context: LayoutContext,
  scale: number,
): PhysicalFoundationScale {
  const sourceThickness = district.sourceFoundationThickness;
  if (sourceThickness === undefined) {
    return { thickness: 0, lift: 0 };
  }
  return physicalFoundationScale(
    sourceThickness,
    scale,
    Math.max(
      context.limits.minimumBaseThickness,
      context.limits.minimumRaisedFeatureHeight,
    ),
    `District '${district.id}' foundation`,
    district.id,
  );
}

function finiteArea(
  width: number,
  depth: number,
  field: string,
  objectId?: string,
): number {
  const result = finiteLayoutArithmetic(
    width * depth,
    field,
    objectId,
  );
  if (result <= 0) {
    throw new PrintLayoutError([
      {
        code: "resource-limit",
        ...(objectId === undefined ? {} : { objectId }),
        message: `${field} is too small to remain positive in the print-layout numeric representation.`,
      },
    ]);
  }
  return result;
}

function finiteAreaAdd(
  left: number,
  right: number,
  field: string,
  objectId?: string,
): number {
  return finiteLayoutArithmetic(left + right, field, objectId);
}

function boundedText(
  value: string,
  field: string,
  maximumLength: number,
): string {
  if (value.trim() === "") {
    throw new PrintLayoutError([
      {
        code: "invalid-request",
        message: `${field} must not be empty.`,
      },
    ]);
  }
  if (value.length > maximumLength) {
    throw new PrintLayoutError([
      {
        code: "resource-limit",
        message: `${field} exceeds the ${maximumLength}-character layout limit.`,
      },
    ]);
  }
  return value;
}

function validateBounds(
  bounds: PrintLayoutBounds,
  field: string,
): PrintLayoutBounds {
  for (const axis of ["x", "y", "z"] as const) {
    const extent = bounds.maximum[axis] - bounds.minimum[axis];
    if (
      !Number.isFinite(bounds.minimum[axis]) ||
      !Number.isFinite(bounds.maximum[axis]) ||
      bounds.maximum[axis] <= bounds.minimum[axis] ||
      !Number.isFinite(extent)
    ) {
      throw new PrintLayoutError([
        {
          code: "invalid-request",
          message: `${field} must have finite, strictly increasing ${axis.toUpperCase()} bounds.`,
        },
      ]);
    }
  }
  return {
    minimum: { ...bounds.minimum },
    maximum: { ...bounds.maximum },
  };
}

function boundsSize(bounds: PrintLayoutBounds): Vector3 {
  return {
    x: bounds.maximum.x - bounds.minimum.x,
    y: bounds.maximum.y - bounds.minimum.y,
    z: bounds.maximum.z - bounds.minimum.z,
  };
}

function formatDimension(value: number): string {
  if (value !== 0 && Math.abs(value) < 0.000001) {
    return value.toExponential(6);
  }
  return Number(value.toFixed(6)).toString();
}

function formatDimensions(value: Vector3): string {
  return `${formatDimension(value.x)} x ${formatDimension(value.z)} x ${formatDimension(value.y)} mm (W x D x H)`;
}

function orderedChannelIds(
  profile: PrinterProfile,
  channelIds: readonly string[] | undefined,
  field: string,
): readonly string[] {
  if (channelIds === undefined) return [];
  const known = new Set(profile.printChannels.map(({ id }) => id));
  const unique = new Set<string>();
  for (const channelId of channelIds) {
    if (!known.has(channelId)) {
      throw new PrintLayoutError([
        {
          code: "invalid-request",
          message: `${field} references unknown print channel '${channelId}'.`,
        },
      ]);
    }
    unique.add(channelId);
  }
  return profile.printChannels
    .map(({ id }) => id)
    .filter((id) => unique.has(id));
}

function validateMeasurements(
  features: PrintLayoutFeatureMeasurements,
): PrintLayoutFeatureMeasurements {
  const optional = (
    value: number | null,
    field: string,
  ): number | null => {
    if (value === null) return null;
    return finitePositive(value, field);
  };
  return {
    wallThickness: finitePositive(
      features.wallThickness,
      "features.wallThickness",
    ),
    gap:
      features.gap === null
        ? null
        : finitePositive(features.gap, "features.gap"),
    minimumFeatureSize: finitePositive(
      features.minimumFeatureSize,
      "features.minimumFeatureSize",
    ),
    baseThickness: finitePositive(
      features.baseThickness,
      "features.baseThickness",
    ),
    ...(
      features.labelStrokeWidth === undefined
        ? {}
        : {
            labelStrokeWidth: optional(
              features.labelStrokeWidth,
              "features.labelStrokeWidth",
            ),
          }
    ),
    ...(
      features.raisedFeatureHeight === undefined
        ? {}
        : {
            raisedFeatureHeight: optional(
              features.raisedFeatureHeight,
              "features.raisedFeatureHeight",
            ),
          }
    ),
    ...(
      features.recessedFeatureDepth === undefined
        ? {}
        : {
            recessedFeatureDepth: optional(
              features.recessedFeatureDepth,
              "features.recessedFeatureDepth",
            ),
          }
    ),
    ...(
      features.routeWidth === undefined
        ? {}
        : {
            routeWidth: optional(
              features.routeWidth,
              "features.routeWidth",
            ),
          }
    ),
    ...(
      features.connectorWidth === undefined
        ? {}
        : {
            connectorWidth: optional(
              features.connectorWidth,
              "features.connectorWidth",
            ),
          }
    ),
  };
}

function minimumSafeScale(
  features: PrintLayoutFeatureMeasurements,
  limits: ResolvedPrinterGeometryLimits,
): number {
  const ratios: number[] = [
    limits.minimumWallThickness / features.wallThickness,
    limits.minimumFeatureSize / features.minimumFeatureSize,
  ];
  const add = (
    value: number | null | undefined,
    minimum: number,
  ): void => {
    if (value !== null && value !== undefined) {
      ratios.push(minimum / value);
    }
  };
  add(features.gap, limits.minimumGap);
  add(features.labelStrokeWidth, limits.minimumLabelStrokeWidth);
  add(features.raisedFeatureHeight, limits.minimumRaisedFeatureHeight);
  add(features.recessedFeatureDepth, limits.minimumRecessedFeatureDepth);
  add(features.routeWidth, limits.minimumRouteWidth);
  add(
    features.connectorWidth,
    Math.max(limits.minimumFeatureSize, limits.lineWidth),
  );
  return Math.max(...ratios);
}

function featureViolations(
  features: PrintLayoutFeatureMeasurements,
  limits: ResolvedPrinterGeometryLimits,
  scale: number,
): readonly PrintFeatureViolation[] {
  const candidates: readonly {
    readonly category: PrintFeatureCategory;
    readonly value: number | null | undefined;
    readonly minimum: number;
  }[] = [
    {
      category: "wall-thickness",
      value: features.wallThickness,
      minimum: limits.minimumWallThickness,
    },
    { category: "gap", value: features.gap, minimum: limits.minimumGap },
    {
      category: "minimum-feature-size",
      value: features.minimumFeatureSize,
      minimum: limits.minimumFeatureSize,
    },
    {
      category: "label-stroke-width",
      value: features.labelStrokeWidth,
      minimum: limits.minimumLabelStrokeWidth,
    },
    {
      category: "raised-feature-height",
      value: features.raisedFeatureHeight,
      minimum: limits.minimumRaisedFeatureHeight,
    },
    {
      category: "recessed-feature-depth",
      value: features.recessedFeatureDepth,
      minimum: limits.minimumRecessedFeatureDepth,
    },
    {
      category: "route-width",
      value: features.routeWidth,
      minimum: limits.minimumRouteWidth,
    },
    {
      category: "connector-width",
      value: features.connectorWidth,
      minimum: Math.max(limits.minimumFeatureSize, limits.lineWidth),
    },
  ];
  return candidates.flatMap(({ category, value, minimum }) => {
    if (value === null || value === undefined) return [];
    const resultingValue = finiteLayoutArithmetic(
      value * scale,
      `Resulting ${category}`,
    );
    return resultingValue + EPSILON < minimum
      ? [{ category, resultingValue, minimum }]
      : [];
  });
}

function usableGeometry(
  profile: PrinterProfile,
  limits: ResolvedPrinterGeometryLimits,
): {
  readonly bounds: PrintLayoutBounds;
  readonly span: Vector3;
} {
  const span = {
    x: profile.buildVolume.x - limits.buildMargins.x * 2,
    y: Math.min(
      profile.buildVolume.y - limits.buildMargins.y * 2,
      limits.maximumModelHeight,
    ),
    z: profile.buildVolume.z - limits.buildMargins.z * 2,
  };
  return {
    bounds: {
      minimum: { ...limits.buildMargins },
      maximum: {
        x: limits.buildMargins.x + span.x,
        y: limits.buildMargins.y + span.y,
        z: limits.buildMargins.z + span.z,
      },
    },
    span,
  };
}

function districtOrder(left: PackItem, right: PackItem): number {
  return (
    right.width * right.depth - left.width * left.depth ||
    Math.max(right.width, right.depth) -
      Math.max(left.width, left.depth) ||
    Math.min(right.width, right.depth) -
      Math.min(left.width, left.depth) ||
    right.height - left.height ||
    compareText(left.id, right.id)
  );
}

function scaleDistricts(
  districts: readonly PrintLayoutDistrictInput[],
  context: LayoutContext,
  scale: number,
): readonly PackItem[] {
  return districts
    .map((district): PackItem => {
      const size = boundsSize(district.sourceBounds);
      const foundation = districtFoundationScale(
        district,
        context,
        scale,
      );
      const scaledHeight = finiteScaledLength(
        size.y,
        scale,
        `District '${district.id}' scaled height`,
        district.id,
      );
      return {
        id: district.id,
        kind: "district",
        name: district.name,
        width: finiteScaledLength(
          size.x,
          scale,
          `District '${district.id}' scaled width`,
          district.id,
        ),
        depth: finiteScaledLength(
          size.z,
          scale,
          `District '${district.id}' scaled depth`,
          district.id,
        ),
        height: finiteLayoutArithmetic(
          scaledHeight + foundation.lift,
          `District '${district.id}' physical height`,
          district.id,
        ),
        sourceBounds: district.sourceBounds,
        sourceScale: scale,
        foundationThickness: foundation.thickness,
        foundationLift: foundation.lift,
        channelIds: orderedChannelIds(
          context.profile,
          district.channelIds,
          `District '${district.id}'`,
        ),
        allowRotation: true,
      };
    })
    .sort(districtOrder);
}

function plateNumberSize(
  limits: ResolvedPrinterGeometryLimits,
  plateIdDigits: number,
): Vector3 {
  const feature = Math.max(
    limits.minimumFeatureSize,
    limits.minimumLabelStrokeWidth,
    limits.lineWidth,
  );
  return {
    x: (plateIdDigits * 4 + 2) * feature,
    y: limits.minimumRaisedFeatureHeight,
    z: 9 * feature,
  };
}

function identityItem(
  identity: PrintLayoutIdentityInput,
  profile: PrinterProfile,
  scale: number,
): PackItem {
  const size = boundsSize(identity.sourceBounds);
  const sourceScale =
    identity.scaleMode === "physical" ? 1 : scale;
  return {
    id: identity.id,
    kind: "identity",
    name: "Identity",
    width: finiteScaledLength(
      size.x,
      sourceScale,
      `Identity '${identity.id}' scaled width`,
      identity.id,
    ),
    depth: finiteScaledLength(
      size.z,
      sourceScale,
      `Identity '${identity.id}' scaled depth`,
      identity.id,
    ),
    height: finiteScaledLength(
      size.y,
      sourceScale,
      `Identity '${identity.id}' scaled height`,
      identity.id,
    ),
    sourceBounds: identity.sourceBounds,
    sourceScale,
    channelIds: orderedChannelIds(
      profile,
      identity.channelIds,
      `Identity '${identity.id}'`,
    ),
    allowRotation: false,
  };
}

function plateNumberItem(
  context: LayoutContext,
  index: number,
): PackItem {
  const size = plateNumberSize(context.limits, context.plateIdDigits);
  return {
    id: `${plateId(index, context.plateIdDigits)}-number`,
    kind: "plate-number",
    name: String(index).padStart(context.plateIdDigits, "0"),
    width: size.x,
    depth: size.z,
    height: size.y,
    channelIds: [context.baseChannelId],
    allowRotation: false,
  };
}

function externalBoxItems(context: LayoutContext): readonly PackItem[] {
  const boxes = context.rearReservation?.boxes ?? [];
  return boxes
    .map((box): PackItem => ({
      id: box.id,
      kind: "external-box",
      name: box.id,
      width: box.size.x,
      depth: box.size.z,
      height: box.size.y,
      channelIds: orderedChannelIds(
        context.profile,
        box.channelIds,
        `External box '${box.id}'`,
      ),
      allowRotation: false,
    }))
    .sort(districtOrder);
}

function shelfPackExternalBoxes(
  context: LayoutContext,
  width: number,
): readonly PackedItem[] | undefined {
  const reservation = context.rearReservation;
  if (reservation === undefined || (reservation.boxes?.length ?? 0) === 0) {
    return [];
  }
  const placed: PackedItem[] = [];
  let x = 0;
  let z = 0;
  let rowDepth = 0;
  for (const item of externalBoxItems(context)) {
    if (
      item.width > width + EPSILON ||
      item.height > reservation.height + EPSILON
    ) {
      return undefined;
    }
    const nextX = x === 0 ? 0 : x + context.gap;
    if (nextX + item.width > width + EPSILON && x > 0) {
      z += rowDepth + context.gap;
      x = 0;
      rowDepth = 0;
    }
    const itemX = x === 0 ? 0 : x + context.gap;
    if (
      itemX + item.width > width + EPSILON ||
      z + item.depth > reservation.depth + EPSILON
    ) {
      return undefined;
    }
    placed.push({
      ...item,
      x: itemX,
      z,
      rotation: 0,
    });
    x = itemX + item.width;
    rowDepth = Math.max(rowDepth, item.depth);
  }
  return placed;
}

function externalWidthBreakpoints(
  context: LayoutContext,
  minimumWidth: number,
): readonly number[] {
  const items = externalBoxItems(context);
  const widths = new Set<number>([
    minimumWidth,
    context.usableSpan.x,
  ]);
  for (let start = 0; start < items.length; start += 1) {
    let width = 0;
    for (let end = start; end < items.length; end += 1) {
      width +=
        (end === start ? 0 : context.gap) + items[end]!.width;
      if (
        width + EPSILON >= minimumWidth &&
        width <= context.usableSpan.x + EPSILON
      ) {
        widths.add(width);
      }
    }
  }
  return [...widths]
    .filter(
      (width) =>
        width + EPSILON >= minimumWidth &&
        width <= context.usableSpan.x + EPSILON,
    )
    .sort((left, right) => left - right);
}

interface RearPlateLayout {
  readonly apron: PackedItem;
  readonly boxes: readonly PackedItem[];
}

function rearPlateLayout(
  context: LayoutContext,
  contentItems: readonly PackedItem[],
): RearPlateLayout | undefined {
  const reservation = context.rearReservation;
  if (reservation === undefined) return undefined;
  const minimumX = Math.min(...contentItems.map(({ x }) => x));
  const maximumX = Math.max(
    ...contentItems.map(({ x, width }) => x + width),
  );
  const maximumZ = Math.max(
    ...contentItems.map(({ z, depth }) => z + depth),
  );
  const contentWidth = maximumX - minimumX;
  for (const width of externalWidthBreakpoints(context, contentWidth)) {
    const boxes = shelfPackExternalBoxes(context, width);
    if (boxes === undefined) continue;
    const x = Math.max(
      0,
      Math.min(minimumX, context.usableSpan.x - width),
    );
    const z = maximumZ + context.gap;
    if (
      z + reservation.depth >
      context.usableSpan.z - context.reservedRearDepth + EPSILON
    ) {
      return undefined;
    }
    const apron: PackedItem = {
      id: reservation.id,
      kind: "external-apron",
      name: "External dependency apron",
      width,
      depth: reservation.depth,
      height: reservation.height,
      channelIds: orderedChannelIds(
        context.profile,
        reservation.channelIds,
        `Rear reservation '${reservation.id}'`,
      ),
      allowRotation: false,
      x,
      z,
      rotation: 0,
    };
    return {
      apron,
      boxes: boxes.map((item) => ({
        ...item,
        x: item.x + x,
        z: item.z + z,
      })),
    };
  }
  return undefined;
}

function plateId(index: number, digits: number): string {
  return `plate-${String(index).padStart(digits, "0")}`;
}

function intersects(left: Rectangle, right: Rectangle): boolean {
  return !(
    left.x + left.width <= right.x + EPSILON ||
    right.x + right.width <= left.x + EPSILON ||
    left.z + left.depth <= right.z + EPSILON ||
    right.z + right.depth <= left.z + EPSILON
  );
}

function contains(outer: Rectangle, inner: Rectangle): boolean {
  return (
    outer.x <= inner.x + EPSILON &&
    outer.z <= inner.z + EPSILON &&
    outer.x + outer.width + EPSILON >= inner.x + inner.width &&
    outer.z + outer.depth + EPSILON >= inner.z + inner.depth
  );
}

function pruneFreeRectangles(
  rectangles: readonly Rectangle[],
): readonly Rectangle[] {
  if (rectangles.length > MAXIMUM_FREE_RECTANGLE_COUNT) {
    throw new PrintLayoutError([
      {
        code: "resource-limit",
        message:
          `Print layout exceeded ${MAXIMUM_FREE_RECTANGLE_COUNT} free rectangles; split the input into smaller print jobs.`,
      },
    ]);
  }
  const usable = rectangles.filter(
    ({ width, depth }) => width > EPSILON && depth > EPSILON,
  );
  const result = usable.filter(
    (candidate, index) =>
      !usable.some(
        (other, otherIndex) =>
          index !== otherIndex &&
          contains(other, candidate) &&
          (
            !contains(candidate, other) ||
            otherIndex < index
          ),
      ),
  );
  return result.sort(
    (left, right) =>
      left.z - right.z ||
      left.x - right.x ||
      left.depth - right.depth ||
      left.width - right.width,
  );
}

function splitFreeRectangles(
  free: readonly Rectangle[],
  occupied: Rectangle,
  binWidth: number,
  binDepth: number,
  gap: number,
): readonly Rectangle[] {
  const exclusion = {
    x: Math.max(0, occupied.x - gap),
    z: Math.max(0, occupied.z - gap),
    width:
      Math.min(binWidth, occupied.x + occupied.width + gap) -
      Math.max(0, occupied.x - gap),
    depth:
      Math.min(binDepth, occupied.z + occupied.depth + gap) -
      Math.max(0, occupied.z - gap),
  };
  const next: Rectangle[] = [];
  for (const rectangle of free) {
    if (!intersects(rectangle, exclusion)) {
      next.push(rectangle);
      continue;
    }
    const right = rectangle.x + rectangle.width;
    const bottom = rectangle.z + rectangle.depth;
    const exclusionRight = exclusion.x + exclusion.width;
    const exclusionBottom = exclusion.z + exclusion.depth;
    if (exclusion.x > rectangle.x + EPSILON) {
      next.push({
        x: rectangle.x,
        z: rectangle.z,
        width: exclusion.x - rectangle.x,
        depth: rectangle.depth,
      });
    }
    if (exclusionRight < right - EPSILON) {
      next.push({
        x: exclusionRight,
        z: rectangle.z,
        width: right - exclusionRight,
        depth: rectangle.depth,
      });
    }
    if (exclusion.z > rectangle.z + EPSILON) {
      next.push({
        x: rectangle.x,
        z: rectangle.z,
        width: rectangle.width,
        depth: exclusion.z - rectangle.z,
      });
    }
    if (exclusionBottom < bottom - EPSILON) {
      next.push({
        x: rectangle.x,
        z: exclusionBottom,
        width: rectangle.width,
        depth: bottom - exclusionBottom,
      });
    }
  }
  return pruneFreeRectangles(next);
}

function compareScore(
  left: readonly number[],
  right: readonly number[],
): number {
  for (let index = 0; index < left.length; index += 1) {
    const difference = left[index]! - right[index]!;
    if (Math.abs(difference) > EPSILON) return difference;
  }
  return 0;
}

function candidateForState(
  state: PackingState,
  item: PackItem,
): PlacementCandidate | undefined {
  let best: PlacementCandidate | undefined;
  const rotations: readonly PrintLayoutRotation[] =
    item.allowRotation && Math.abs(item.width - item.depth) > EPSILON
      ? [0, 90]
      : [0];
  for (const free of state.free) {
    for (const rotation of rotations) {
      const width = rotation === 0 ? item.width : item.depth;
      const depth = rotation === 0 ? item.depth : item.width;
      if (
        width > free.width + EPSILON ||
        depth > free.depth + EPSILON
      ) {
        continue;
      }
      const remainingX = free.width - width;
      const remainingZ = free.depth - depth;
      const candidate: PlacementCandidate = {
        item: {
          ...item,
          x: free.x,
          z: free.z,
          width,
          depth,
          rotation,
        },
        score: [
          Math.min(remainingX, remainingZ),
          Math.max(remainingX, remainingZ),
          free.width * free.depth - width * depth,
          free.z,
          free.x,
          rotation,
        ],
      };
      if (
        best === undefined ||
        compareScore(candidate.score, best.score) < 0
      ) {
        best = candidate;
      }
    }
  }
  return best;
}

function applyCandidate(
  state: PackingState,
  candidate: PlacementCandidate,
  context: LayoutContext,
): PackingState {
  return applyCandidateInBin(
    state,
    candidate,
    context.packingSpan.x,
    context.packingSpan.z,
    context.gap,
  );
}

function applyCandidateInBin(
  state: PackingState,
  candidate: PlacementCandidate,
  binWidth: number,
  binDepth: number,
  gap: number,
): PackingState {
  return {
    free: splitFreeRectangles(
      state.free,
      candidate.item,
      binWidth,
      binDepth,
      gap,
    ),
    items: [...state.items, candidate.item],
  };
}

function itemFitsHeight(
  item: PackItem,
  baseThickness: number,
  context: LayoutContext,
): boolean {
  return (
    baseThickness + item.height <= context.usableSpan.y + EPSILON
  );
}

function reservationFitIssue(
  item: PackItem,
  context: LayoutContext,
  scale: number,
  detail: string,
): PrintLayoutIssue {
  const required = requiredSize(
    item,
    physicalBaseThickness(
      context,
      scale,
      `Reservation '${item.id}' plate base`,
      item.id,
    ),
  );
  const available = {
    x: context.packingSpan.x,
    y: context.usableSpan.y,
    z: context.packingSpan.z,
  };
  return {
    code: "reservation-does-not-fit",
    objectId: item.id,
    required,
    available,
    message:
      `${item.kind === "plate-number" ? "Plate-number" : item.kind === "identity" ? "Identity" : "Rear"} reservation '${item.id}' ` +
      `requires ${formatDimensions(required)}, but the content packing span is ${formatDimensions(available)}. ${detail}`,
  };
}

function createPlate(
  context: LayoutContext,
  scale: number,
  index: number,
): PlateCreationResult {
  const baseThickness = physicalBaseThickness(
    context,
    scale,
    `Plate ${index} base thickness`,
    `${plateId(index, context.plateIdDigits)}-base`,
  );
  if (baseThickness > context.usableSpan.y + EPSILON) {
    return {
      issue: {
        code: "reservation-does-not-fit",
        objectId: `${plateId(index, context.plateIdDigits)}-base`,
        required: { x: 0, y: baseThickness, z: 0 },
        available: { ...context.usableSpan },
        message:
          `Plate base requires ${formatDimension(baseThickness)} mm height, but the usable build height is ${formatDimension(context.usableSpan.y)} mm.`,
      },
    };
  }
  let state: PackingState = {
    free: [
      {
        x: 0,
        z: 0,
        width: context.packingSpan.x,
        depth: context.packingSpan.z,
      },
    ],
    items: [],
  };
  const rear = context.rearReservation;
  if (
    rear !== undefined &&
    baseThickness + rear.height > context.usableSpan.y + EPSILON
  ) {
    const item: PackItem = {
      id: rear.id,
      kind: "external-apron",
      name: "External dependency apron",
      width: context.packingSpan.x,
      depth: rear.depth,
      height: rear.height,
      channelIds: rear.channelIds ?? [],
      allowRotation: false,
    };
    return {
      issue: reservationFitIssue(
        item,
        context,
        scale,
        "Its fixed physical height exceeds the plate.",
      ),
    };
  }
  const reservations: PackItem[] = [];
  if (index === 1 && context.identity !== undefined) {
    reservations.push(
      identityItem(context.identity, context.profile, scale),
    );
  }
  reservations.push(plateNumberItem(context, index));
  for (const reservation of reservations) {
    if (!itemFitsHeight(reservation, baseThickness, context)) {
      return {
        issue: reservationFitIssue(
          reservation,
          context,
          scale,
          "Its height including the continuous base exceeds the plate.",
        ),
      };
    }
    const candidate = candidateForState(state, reservation);
    if (candidate === undefined) {
      return {
        issue: reservationFitIssue(
          reservation,
          context,
          scale,
          "Its footprint cannot be placed after the fixed reservations.",
        ),
      };
    }
    state = applyCandidate(state, candidate, context);
  }
  return {
    plate: {
      index,
      id: plateId(index, context.plateIdDigits),
      state,
    },
  };
}

function initialContext(
  profile: PrinterProfile,
  request: PrintLayoutRequest,
  features: PrintLayoutFeatureMeasurements,
  warnings: string[],
): LayoutContext {
  const profileIssues = validatePrinterProfile(profile);
  if (profileIssues.length > 0) {
    throw new PrintLayoutError(
      profileIssues.map((message) => ({
        code: "invalid-request",
        message,
      })),
    );
  }
  const limits = resolvePrinterGeometryLimits(profile);
  const usable = usableGeometry(profile, limits);
  const requestedGap =
    request.districtGap === undefined
      ? limits.minimumGap
      : finiteNonNegative(request.districtGap, "districtGap");
  const gap = Math.max(requestedGap, limits.minimumGap);
  if (gap > requestedGap + EPSILON) {
    warnings.push(
      `District gap was raised from ${formatDimension(requestedGap)} mm to the profile minimum ${formatDimension(gap)} mm.`,
    );
  }
  const maximumPlateCount =
    request.maximumPlateCount ??
    Math.max(
      1,
      Math.min(MAXIMUM_PLATE_COUNT, request.districts.length + 1),
    );
  if (
    !Number.isSafeInteger(maximumPlateCount) ||
    maximumPlateCount <= 0
  ) {
    throw new PrintLayoutError([
      {
        code: "invalid-request",
        message: "maximumPlateCount must be a positive safe integer.",
      },
    ]);
  }
  if (maximumPlateCount > MAXIMUM_PLATE_COUNT) {
    throw new PrintLayoutError([
      {
        code: "resource-limit",
        message:
          `maximumPlateCount must not exceed ${MAXIMUM_PLATE_COUNT}; plate artifacts use stable two-digit numbering.`,
      },
    ]);
  }
  const baseChannelId =
    request.baseChannelId ?? profile.printChannels[0]!.id;
  orderedChannelIds(profile, [baseChannelId], "baseChannelId");
  const plateIdDigits = PLATE_ID_DIGITS;
  const reservedRearDepth = request.reservedRearDepth ?? 0;
  const rearDepth = request.rearReservation?.depth ?? 0;
  const rearGap = request.rearReservation === undefined ? 0 : gap;
  const packingSpan = {
    x: usable.span.x,
    y: usable.span.y,
    z: usable.span.z - reservedRearDepth - rearDepth - rearGap,
  };
  if (packingSpan.z <= EPSILON) {
    const requiredDepth = reservedRearDepth + rearDepth + rearGap;
    const requiredDescription =
      reservedRearDepth > 0
        ? `Reserved rear depth ${formatDimension(reservedRearDepth)} mm${request.rearReservation === undefined ? "" : ` plus rear reservation '${request.rearReservation.id}' and its ${formatDimension(rearGap)} mm separation`}`
        : `Rear reservation '${request.rearReservation?.id ?? "rear"}' plus its ${formatDimension(rearGap)} mm separation`;
    throw new PrintLayoutError([
      {
        code: "reservation-does-not-fit",
        ...(request.rearReservation === undefined
          ? {}
          : { objectId: request.rearReservation.id }),
        required: {
          x: usable.span.x,
          y: request.rearReservation?.height ?? 0,
          z: requiredDepth,
        },
        available: { ...usable.span },
        message:
          `${requiredDescription} requires ${formatDimension(requiredDepth)} mm depth, ` +
          `but the usable build depth is ${formatDimension(usable.span.z)} mm.`,
      },
    ]);
  }
  const context: LayoutContext = {
    profile,
    limits,
    usableBounds: usable.bounds,
    usableSpan: usable.span,
    packingSpan,
    reservedRearDepth,
    baseChannelId,
    gap,
    plateIdDigits,
    maximumPlateCount,
    ...(request.identity === undefined
      ? {}
      : { identity: request.identity }),
    ...(request.rearReservation === undefined
      ? {}
      : { rearReservation: request.rearReservation }),
    features,
  };
  if (
    request.rearReservation !== undefined &&
    shelfPackExternalBoxes(context, usable.span.x) === undefined
  ) {
    throw new PrintLayoutError([
      {
        code: "reservation-does-not-fit",
        objectId: request.rearReservation.id,
        required: {
          x: usable.span.x,
          y: request.rearReservation.height,
          z: request.rearReservation.depth,
        },
        available: { ...usable.span },
        message:
          `Fixed external boxes do not fit inside rear reservation '${request.rearReservation.id}' even at the full usable width ` +
          `(${formatDimensions({ x: usable.span.x, y: request.rearReservation.height, z: request.rearReservation.depth })}).`,
      },
    ]);
  }
  return context;
}

function requiredSize(item: PackItem, baseThickness: number): Vector3 {
  return {
    x: item.width,
    y: baseThickness + item.height,
    z: item.depth,
  };
}

function exactDistrictFailure(
  context: LayoutContext,
  scale: number,
  item: PackItem,
): PrintLayoutError {
  const available = {
    x: context.packingSpan.x,
    y: context.usableSpan.y,
    z: context.packingSpan.z,
  };
  const required = requiredSize(
    item,
    physicalBaseThickness(
      context,
      scale,
      `District '${item.id}' plate base`,
      item.id,
    ),
  );
  return new PrintLayoutError([
    {
      code: "district-does-not-fit",
      objectId: item.id,
      required,
      available,
      message:
        `District '${item.name}' (${item.id}) requires ${formatDimensions(required)} at scale ${formatDimension(scale)}, ` +
        `but the district packing span is ${formatDimensions(available)} after fixed reservations; 90-degree rotation was also tested.`,
    },
  ]);
}

function ensureIndividualDistrictsFit(
  context: LayoutContext,
  scale: number,
  items: readonly PackItem[],
): void {
  const created = createPlate(context, scale, 2);
  if (created.issue !== undefined) {
    throw new PrintLayoutError([created.issue]);
  }
  const baseThickness = physicalBaseThickness(
    context,
    scale,
    "District fit plate base",
  );
  for (const item of items) {
    if (
      !itemFitsHeight(item, baseThickness, context) ||
      candidateForState(created.plate.state, item) === undefined
    ) {
      throw exactDistrictFailure(context, scale, item);
    }
  }
}

function attemptSinglePlate(
  context: LayoutContext,
  scale: number,
  items: readonly PackItem[],
): AttemptResult | undefined {
  const created = createPlate(context, scale, 1);
  if (created.issue !== undefined) return undefined;
  let plate = created.plate;
  const baseThickness = physicalBaseThickness(
    context,
    scale,
    "Single-plate fit base",
  );
  for (const item of items) {
    if (!itemFitsHeight(item, baseThickness, context)) {
      return undefined;
    }
    const candidate = candidateForState(plate.state, item);
    if (candidate === undefined) return undefined;
    plate = {
      ...plate,
      state: applyCandidate(plate.state, candidate, context),
    };
  }
  return { plates: [plate], unplaced: [] };
}

function attemptTiled(
  context: LayoutContext,
  scale: number,
  items: readonly PackItem[],
): AttemptResult {
  const firstResult = createPlate(context, scale, 1);
  if (firstResult.issue !== undefined) {
    throw new PrintLayoutError([firstResult.issue]);
  }
  const baseThickness = physicalBaseThickness(
    context,
    scale,
    "Tiled fit plate base",
  );
  const plates: MutablePlate[] = [firstResult.plate];
  const unplaced: PackItem[] = [];
  for (const item of items) {
    let best:
      | {
          readonly plateIndex: number;
          readonly candidate: PlacementCandidate;
        }
      | undefined;
    for (let index = 0; index < plates.length; index += 1) {
      if (!itemFitsHeight(item, baseThickness, context)) continue;
      const candidate = candidateForState(plates[index]!.state, item);
      if (candidate === undefined) continue;
      if (
        best === undefined ||
        compareScore(candidate.score, best.candidate.score) < 0 ||
        (
          compareScore(candidate.score, best.candidate.score) === 0 &&
          index < best.plateIndex
        )
      ) {
        best = { plateIndex: index, candidate };
      }
    }
    if (best !== undefined) {
      const target = plates[best.plateIndex]!;
      plates[best.plateIndex] = {
        ...target,
        state: applyCandidate(target.state, best.candidate, context),
      };
      continue;
    }
    if (plates.length >= context.maximumPlateCount) {
      unplaced.push(item);
      continue;
    }
    const nextResult = createPlate(context, scale, plates.length + 1);
    if (nextResult.issue !== undefined) {
      throw new PrintLayoutError([nextResult.issue]);
    }
    const next = nextResult.plate;
    const candidate = candidateForState(next.state, item);
    if (
      candidate === undefined ||
      !itemFitsHeight(item, baseThickness, context)
    ) {
      throw exactDistrictFailure(context, scale, item);
    }
    plates.push({
      ...next,
      state: applyCandidate(next.state, candidate, context),
    });
  }
  return { plates, unplaced };
}

function transformFor(
  source: PrintLayoutBounds,
  scale: number,
  rotation: PrintLayoutRotation,
  targetMinimum: Vector3,
): PrintLayoutTransform {
  if (rotation === 0) {
    return {
      scale,
      rotation,
      translation: {
        x: targetMinimum.x - source.minimum.x * scale,
        y: targetMinimum.y - source.minimum.y * scale,
        z: targetMinimum.z - source.minimum.z * scale,
      },
    };
  }
  return {
    scale,
    rotation,
    translation: {
      x: targetMinimum.x + source.maximum.z * scale,
      y: targetMinimum.y - source.minimum.y * scale,
      z: targetMinimum.z - source.minimum.x * scale,
    },
  };
}

function placedBounds(
  item: PackedItem,
  context: LayoutContext,
  baseTop: number,
): PrintLayoutBounds {
  const minimum = {
    x: context.usableBounds.minimum.x + item.x,
    y: baseTop,
    z: context.usableBounds.minimum.z + item.z,
  };
  return {
    minimum,
    maximum: {
      x: minimum.x + item.width,
      y: minimum.y + item.height,
      z: minimum.z + item.depth,
    },
  };
}

function reservationOrder(kind: PrintLayoutReservationKind): number {
  switch (kind) {
    case "identity":
      return 0;
    case "plate-number":
      return 1;
    case "external-apron":
      return 2;
    case "external-box":
      return 3;
  }
}

function finalizePlate(
  plate: MutablePlate,
  context: LayoutContext,
  scale: number,
): PrintLayoutPlate {
  const baseThickness = physicalBaseThickness(
    context,
    scale,
    `Plate ${plate.index} base thickness`,
    `${plate.id}-base`,
  );
  const baseBottom = context.usableBounds.minimum.y;
  const baseTop = baseBottom + baseThickness;
  const districtPlacements: PrintLayoutDistrictPlacement[] = [];
  const reservations: PrintLayoutReservationPlacement[] = [];
  for (const item of plate.state.items) {
    const bounds = placedBounds(item, context, baseTop);
    if (item.kind === "district") {
      const sourceBounds = item.sourceBounds!;
      const foundationThickness = item.foundationThickness ?? 0;
      const foundationLift = item.foundationLift ?? 0;
      districtPlacements.push({
        districtId: item.id,
        name: item.name,
        plateId: plate.id,
        sourceBounds,
        bounds,
        foundationThickness,
        foundationLift,
        transform: transformFor(
          sourceBounds,
          item.sourceScale ?? scale,
          item.rotation,
          {
            ...bounds.minimum,
            y: bounds.minimum.y + foundationLift,
          },
        ),
        channelIds: item.channelIds,
      });
      continue;
    }
    const sourceBounds = item.sourceBounds;
    reservations.push({
      id: item.id,
      kind: item.kind,
      plateId: plate.id,
      ...(item.kind === "plate-number" ? { label: item.name } : {}),
      ...(item.kind === "external-apron" ? { virtual: true } : {}),
      bounds,
      ...(sourceBounds === undefined
        ? {}
        : {
            transform: transformFor(
              sourceBounds,
              item.sourceScale ?? scale,
              item.rotation,
              bounds.minimum,
            ),
          }),
      channelIds: item.channelIds,
    });
  }
  const rear = rearPlateLayout(context, plate.state.items);
  if (context.rearReservation !== undefined && rear === undefined) {
    throw new PrintLayoutError([
      {
        code: "reservation-does-not-fit",
        objectId: context.rearReservation.id,
        message:
          `Rear reservation '${context.rearReservation.id}' could not be attached to the packed footprint.`,
        available: { ...context.usableSpan },
      },
    ]);
  }
  if (rear !== undefined) {
    reservations.push({
      id: rear.apron.id,
      kind: "external-apron",
      plateId: plate.id,
      virtual: true,
      bounds: placedBounds(rear.apron, context, baseTop),
      channelIds: rear.apron.channelIds,
    });
    for (const item of rear.boxes) {
      reservations.push({
        id: item.id,
        kind: "external-box",
        plateId: plate.id,
        label: item.name,
        bounds: placedBounds(item, context, baseTop),
        channelIds: item.channelIds,
      });
    }
  }
  districtPlacements.sort((left, right) =>
    compareText(left.districtId, right.districtId),
  );
  reservations.sort(
    (left, right) =>
      reservationOrder(left.kind) - reservationOrder(right.kind) ||
      compareText(left.id, right.id),
  );

  const allBounds = [
    ...districtPlacements.map(({ bounds }) => bounds),
    ...reservations.map(({ bounds }) => bounds),
  ];
  const minimumX = Math.min(
    ...allBounds.map(({ minimum }) => minimum.x),
  );
  const maximumX = Math.max(
    ...allBounds.map(({ maximum }) => maximum.x),
  );
  const minimumZ = Math.min(
    ...allBounds.map(({ minimum }) => minimum.z),
  );
  const maximumZ = Math.max(
    ...allBounds.map(({ maximum }) => maximum.z),
  );
  const maximumY = Math.max(
    baseTop,
    ...allBounds.map(({ maximum }) => maximum.y),
  );
  const baseBounds: PrintLayoutBounds = {
    minimum: { x: minimumX, y: baseBottom, z: minimumZ },
    maximum: { x: maximumX, y: baseTop, z: maximumZ },
  };
  const baseSize = boundsSize(baseBounds);
  const bounds: PrintLayoutBounds = {
    minimum: { ...baseBounds.minimum },
    maximum: { x: maximumX, y: maximumY, z: maximumZ },
  };
  const dimensions = boundsSize(bounds);
  let occupiedArea = 0;
  for (const item of plate.state.items) {
    occupiedArea = finiteAreaAdd(
      occupiedArea,
      finiteArea(
        item.width,
        item.depth,
        `Plate '${plate.id}' object '${item.id}' footprint area`,
        item.id,
      ),
      `Plate '${plate.id}' occupied footprint area`,
      plate.id,
    );
  }
  if (rear !== undefined) {
    occupiedArea = finiteAreaAdd(
      occupiedArea,
      finiteArea(
        rear.apron.width,
        rear.apron.depth,
        `Plate '${plate.id}' rear apron footprint area`,
        rear.apron.id,
      ),
      `Plate '${plate.id}' occupied footprint area`,
      plate.id,
    );
  }
  const usableArea = finiteArea(
    context.usableSpan.x,
    context.usableSpan.z - context.reservedRearDepth,
    "Usable build-surface area",
  );
  const utilization = finiteLayoutArithmetic(
    occupiedArea / usableArea,
    `Plate '${plate.id}' utilization`,
    plate.id,
  );
  const channelIds = orderedChannelIds(
    context.profile,
    [
      context.baseChannelId,
      ...plate.state.items.flatMap(({ channelIds }) => channelIds),
      ...(rear === undefined
        ? []
        : [
            ...rear.apron.channelIds,
            ...rear.boxes.flatMap(({ channelIds }) => channelIds),
          ]),
    ],
    `Plate '${plate.id}'`,
  );
  return {
    id: plate.id,
    index: plate.index,
    bounds,
    dimensions,
    base: {
      id: `${plate.id}-base`,
      channelId: context.baseChannelId,
      bounds: baseBounds,
      position: {
        x: (minimumX + maximumX) / 2,
        y: (baseBottom + baseTop) / 2,
        z: (minimumZ + maximumZ) / 2,
      },
      size: baseSize,
    },
    districts: districtPlacements,
    reservations,
    channelIds,
    utilization,
    occupiedArea,
    usableArea,
  };
}

function validateInputs(
  profile: PrinterProfile,
  request: PrintLayoutRequest,
): {
  readonly fitPolicy: PrintFitPolicy;
  readonly requestedScale: number;
  readonly acknowledgeBelowProfileScale: boolean;
  readonly reservedRearDepth: number;
  readonly districts: readonly PrintLayoutDistrictInput[];
  readonly identity?: PrintLayoutIdentityInput;
  readonly rearReservation?: PrintLayoutRearReservationInput;
  readonly features: PrintLayoutFeatureMeasurements;
} {
  const fitPolicy = request.fitPolicy ?? "error";
  if (!FIT_POLICIES.has(fitPolicy)) {
    throw new PrintLayoutError([
      {
        code: "invalid-request",
        message: "fitPolicy must be 'error', 'scale', or 'tile'.",
      },
    ]);
  }
  const requestedScale = finitePositive(
    request.requestedScale ?? 1,
    "requestedScale",
  );
  const reservedRearDepth = finiteNonNegative(
    request.reservedRearDepth ?? 0,
    "reservedRearDepth",
  );
  if (
    request.acknowledgeBelowProfileScale !== undefined &&
    typeof request.acknowledgeBelowProfileScale !== "boolean"
  ) {
    throw new PrintLayoutError([
      {
        code: "invalid-request",
        message: "acknowledgeBelowProfileScale must be a boolean.",
      },
    ]);
  }
  if (request.districts.length > MAXIMUM_DISTRICT_COUNT) {
    throw new PrintLayoutError([
      {
        code: "resource-limit",
        message:
          `Print layout accepts at most ${MAXIMUM_DISTRICT_COUNT} complete districts per job; received ${request.districts.length}.`,
      },
    ]);
  }
  const ids = new Set<string>();
  const districts = request.districts
    .map((district, index): PrintLayoutDistrictInput => {
      boundedText(
        district.id,
        `districts[${index}].id`,
        MAXIMUM_ID_LENGTH,
      );
      if (ids.has(district.id)) {
        throw new PrintLayoutError([
          {
            code: "invalid-request",
            message: `Duplicate district id '${district.id}'.`,
          },
        ]);
      }
      ids.add(district.id);
      boundedText(
        district.name,
        `District '${district.id}' name`,
        MAXIMUM_NAME_LENGTH,
      );
      const sourceBounds = validateBounds(
        district.sourceBounds,
        `District '${district.id}' sourceBounds`,
      );
      const sourceFoundationThickness =
        district.sourceFoundationThickness === undefined
          ? undefined
          : finitePositive(
              district.sourceFoundationThickness,
              `District '${district.id}' sourceFoundationThickness`,
            );
      if (
        sourceFoundationThickness !== undefined &&
        sourceFoundationThickness > boundsSize(sourceBounds).y
      ) {
        throw new PrintLayoutError([
          {
            code: "invalid-request",
            objectId: district.id,
            message:
              `District '${district.id}' sourceFoundationThickness must not exceed its sourceBounds height.`,
          },
        ]);
      }
      return {
        id: district.id,
        name: district.name,
        sourceBounds,
        ...(sourceFoundationThickness === undefined
          ? {}
          : { sourceFoundationThickness }),
        channelIds: orderedChannelIds(
          profile,
          district.channelIds,
          `District '${district.id}'`,
        ),
      };
    })
    .sort((left, right) => compareText(left.id, right.id));
  let identity: PrintLayoutIdentityInput | undefined;
  if (request.identity !== undefined) {
    boundedText(
      request.identity.id,
      "identity.id",
      MAXIMUM_ID_LENGTH,
    );
    if (ids.has(request.identity.id)) {
      throw new PrintLayoutError([
        {
          code: "invalid-request",
          message: `Identity id '${request.identity.id}' duplicates a district id.`,
        },
      ]);
    }
    if (
      request.identity.scaleMode !== undefined &&
      request.identity.scaleMode !== "model" &&
      request.identity.scaleMode !== "physical"
    ) {
      throw new PrintLayoutError([
        {
          code: "invalid-request",
          message: "identity.scaleMode must be 'model' or 'physical'.",
        },
      ]);
    }
    identity = {
      id: request.identity.id,
      sourceBounds: validateBounds(
        request.identity.sourceBounds,
        `Identity '${request.identity.id}' sourceBounds`,
      ),
      channelIds: orderedChannelIds(
        profile,
        request.identity.channelIds,
        `Identity '${request.identity.id}'`,
      ),
      ...(request.identity.scaleMode === undefined
        ? {}
        : { scaleMode: request.identity.scaleMode }),
    };
  }
  let rearReservation: PrintLayoutRearReservationInput | undefined;
  if (request.rearReservation !== undefined) {
    boundedText(
      request.rearReservation.id,
      "rearReservation.id",
      MAXIMUM_ID_LENGTH,
    );
    if (
      ids.has(request.rearReservation.id) ||
      request.rearReservation.id === identity?.id
    ) {
      throw new PrintLayoutError([
        {
          code: "invalid-request",
          message: `Rear reservation id '${request.rearReservation.id}' duplicates another layout object id.`,
        },
      ]);
    }
    const sourceBoxes = request.rearReservation.boxes ?? [];
    if (sourceBoxes.length > MAXIMUM_EXTERNAL_BOX_COUNT) {
      throw new PrintLayoutError([
        {
          code: "resource-limit",
          message:
            `rearReservation.boxes accepts at most ${MAXIMUM_EXTERNAL_BOX_COUNT} fixed boxes; received ${sourceBoxes.length}.`,
        },
      ]);
    }
    const boxIds = new Set<string>();
    const boxes = sourceBoxes
      .map((box, index): PrintLayoutExternalBoxInput => {
        boundedText(
          box.id,
          `rearReservation.boxes[${index}].id`,
          MAXIMUM_ID_LENGTH,
        );
        if (
          boxIds.has(box.id) ||
          ids.has(box.id) ||
          box.id === identity?.id ||
          box.id === request.rearReservation!.id
        ) {
          throw new PrintLayoutError([
            {
              code: "invalid-request",
              message: `External box id '${box.id}' duplicates another layout object id.`,
            },
          ]);
        }
        boxIds.add(box.id);
        return {
          id: box.id,
          size: {
            x: finitePositive(
              box.size.x,
              `External box '${box.id}' size X`,
            ),
            y: finitePositive(
              box.size.y,
              `External box '${box.id}' size Y`,
            ),
            z: finitePositive(
              box.size.z,
              `External box '${box.id}' size Z`,
            ),
          },
          channelIds: orderedChannelIds(
            profile,
            box.channelIds,
            `External box '${box.id}'`,
          ),
        };
      })
      .sort((left, right) => compareText(left.id, right.id));
    rearReservation = {
      id: request.rearReservation.id,
      depth: finitePositive(
        request.rearReservation.depth,
        "rearReservation.depth",
      ),
      height: finitePositive(
        request.rearReservation.height,
        "rearReservation.height",
      ),
      channelIds: orderedChannelIds(
        profile,
        request.rearReservation.channelIds,
        `Rear reservation '${request.rearReservation.id}'`,
      ),
      ...(request.rearReservation.boxes === undefined
        ? {}
        : { boxes }),
    };
  }
  return {
    fitPolicy,
    requestedScale,
    acknowledgeBelowProfileScale:
      request.acknowledgeBelowProfileScale ?? false,
    reservedRearDepth,
    districts,
    ...(identity === undefined ? {} : { identity }),
    ...(rearReservation === undefined ? {} : { rearReservation }),
    features: validateMeasurements(request.features),
  };
}

function scaleWarning(
  requested: number,
  applied: number,
  profileSafe: boolean,
): string {
  return `Print layout was scaled from ${formatDimension(requested)} to ${formatDimension(applied)} to fit one plate${profileSafe ? " safely" : ""}.`;
}

function belowProfileWarning(
  applied: number,
  safe: number,
  violations: readonly PrintFeatureViolation[],
): string {
  const details = violations
    .map(
      ({ category, resultingValue, minimum }) =>
        `${category} ${formatDimension(resultingValue)} mm < ${formatDimension(minimum)} mm`,
    )
    .join(", ");
  return (
    `Applied scale ${formatDimension(applied)} is below the profile-safe scale ${formatDimension(safe)}. ` +
    "The acknowledged risk is reduced print fidelity, not printer hardware danger." +
    (details.length === 0 ? "" : ` Below-limit features: ${details}.`)
  );
}

function onePlateScaleCeiling(
  context: LayoutContext,
  districts: readonly PrintLayoutDistrictInput[],
  requestedScale: number,
): number {
  const width = context.packingSpan.x + EPSILON;
  const depth = context.packingSpan.z + EPSILON;
  const height = context.usableSpan.y + EPSILON;
  let ceiling = requestedScale;
  const cap = (candidate: number): void => {
    if (Number.isFinite(candidate) && candidate > 0) {
      ceiling = Math.min(ceiling, candidate);
    }
  };

  // The continuous plate base grows with model scale even when its printable
  // thickness is clamped upward at small scales.
  cap(height / context.features.baseThickness);
  for (const district of districts) {
    const size = boundsSize(district.sourceBounds);
    const unrotated = Math.min(width / size.x, depth / size.z);
    const rotated = Math.min(width / size.z, depth / size.x);
    cap(Math.max(unrotated, rotated));
    cap(height / size.y);
  }
  if (
    context.identity !== undefined &&
    context.identity.scaleMode !== "physical"
  ) {
    const size = boundsSize(context.identity.sourceBounds);
    cap(width / size.x);
    cap(depth / size.z);
    cap(height / size.y);
  }
  return ceiling;
}

function knownSinglePlateBelow(
  context: LayoutContext,
  districts: readonly PrintLayoutDistrictInput[],
  failedScale: number,
): { readonly scale: number; readonly attempt: AttemptResult } | undefined {
  let scale = failedScale;
  for (
    let iteration = 0;
    iteration < SCALE_SEARCH_BELOW_ITERATIONS;
    iteration += 1
  ) {
    scale /= 2;
    if (!Number.isFinite(scale) || scale <= 0) return undefined;
    const attempt = attemptSinglePlate(
      context,
      scale,
      scaleDistricts(districts, context, scale),
    );
    if (attempt !== undefined) return { scale, attempt };
  }
  return undefined;
}

/**
 * Derives a physical plate layout without mutating semantic CityModel
 * coordinates. Districts remain indivisible; only placement transforms change.
 */
export function planPrintLayout(
  profile: PrinterProfile,
  request: PrintLayoutRequest,
): PrintLayoutPlan {
  const validated = validateInputs(profile, request);
  const warnings: string[] = [];
  const context = initialContext(
    profile,
    {
      ...request,
      ...(validated.identity === undefined
        ? {}
        : { identity: validated.identity }),
      ...(validated.rearReservation === undefined
        ? {}
        : { rearReservation: validated.rearReservation }),
      reservedRearDepth: validated.reservedRearDepth,
    },
    validated.features,
    warnings,
  );
  const safeScale = minimumSafeScale(validated.features, context.limits);
  finiteLayoutArithmetic(
    safeScale,
    "Minimum profile-safe scale",
  );
  if (validated.requestedScale + EPSILON < safeScale) {
    if (!validated.acknowledgeBelowProfileScale) {
      throw new PrintLayoutError([
        {
          code: "unsafe-scale",
          message:
            `Requested scale ${formatDimension(validated.requestedScale)} is below the minimum profile-safe scale ${formatDimension(safeScale)} ` +
            "for the supplied wall, gap, label, relief, route, and connector measurements.",
        },
      ]);
    }
  }

  let appliedScale = validated.requestedScale;
  let attempt: AttemptResult;
  if (validated.fitPolicy === "tile") {
    const items = scaleDistricts(
      validated.districts,
      context,
      appliedScale,
    );
    ensureIndividualDistrictsFit(context, appliedScale, items);
    attempt = attemptTiled(context, appliedScale, items);
  } else if (validated.fitPolicy === "error") {
    const items = scaleDistricts(
      validated.districts,
      context,
      appliedScale,
    );
    const requestedAttempt = attemptSinglePlate(
      context,
      appliedScale,
      items,
    );
    if (requestedAttempt !== undefined) {
      attempt = requestedAttempt;
    } else {
      const plateOne = createPlate(context, appliedScale, 1);
      if (plateOne.issue !== undefined) {
        throw new PrintLayoutError([plateOne.issue]);
      }
      ensureIndividualDistrictsFit(context, appliedScale, items);
      throw new PrintLayoutError([
        {
          code: "city-does-not-fit",
          message:
            `Complete districts do not fit together on one plate at scale ${formatDimension(appliedScale)}; ` +
            'in Print export, set Fit policy to "Scale to one plate" or "Tile complete districts (multi-plate)".',
          available: { ...context.usableSpan },
        },
      ]);
    }
  } else {
    const safeSearchStart = Math.min(
      safeScale,
      validated.requestedScale,
    );
    const searchCeiling = onePlateScaleCeiling(
      context,
      validated.districts,
      validated.requestedScale,
    );
    if (
      searchCeiling + EPSILON < safeSearchStart &&
      !validated.acknowledgeBelowProfileScale
    ) {
      const safeItems = scaleDistricts(
        validated.districts,
        context,
        safeSearchStart,
      );
      ensureIndividualDistrictsFit(
        context,
        safeSearchStart,
        safeItems,
      );
      const safePlate = createPlate(context, safeSearchStart, 1);
      if (safePlate.issue !== undefined) {
        throw new PrintLayoutError([safePlate.issue]);
      }
      throw new PrintLayoutError([
        {
          code: "city-does-not-fit",
          message:
            `Complete districts do not fit together on one plate at the minimum profile-safe scale ${formatDimension(safeScale)}; ` +
            'in Print export, set Fit policy to "Tile complete districts (multi-plate)".',
          available: { ...context.usableSpan },
        },
      ]);
    }
    appliedScale = searchCeiling;
    const ceilingItems = scaleDistricts(
      validated.districts,
      context,
      searchCeiling,
    );
    const ceilingAttempt = attemptSinglePlate(
      context,
      searchCeiling,
      ceilingItems,
    );
    if (ceilingAttempt !== undefined) {
      attempt = ceilingAttempt;
    } else {
      const minimumScale = Math.min(safeSearchStart, searchCeiling);
      const minimumAttempt =
        searchCeiling === minimumScale
          ? undefined
          : attemptSinglePlate(
              context,
              minimumScale,
              scaleDistricts(
                validated.districts,
                context,
                minimumScale,
              ),
            );
      let low = minimumScale;
      let high = searchCeiling;
      let best = minimumAttempt;
      const searchSpan = high - low;
      let previousFailure = high;
      let discovered = false;
      const discoveryIntervals = scaleSearchDiscoveryIntervals(
        validated.districts.length,
      );
      // Greedy MaxRects decisions can change with scale, so a failed probe
      // does not prove that every larger scale fails. Discover the highest
      // sampled feasible topology on a dense, nested grid before refining
      // its adjacent upper interval with fresh packing attempts. Small and
      // ordinary cities receive denser coverage; large inputs stay bounded.
      if (searchSpan > EPSILON) {
        for (
          let interval = 1;
          interval < discoveryIntervals;
          interval += 1
        ) {
          const fraction = interval / discoveryIntervals;
          const candidateScale = high - searchSpan * fraction;
          const candidateItems = scaleDistricts(
            validated.districts,
            context,
            candidateScale,
          );
          const candidate = attemptSinglePlate(
            context,
            candidateScale,
            candidateItems,
          );
          if (candidate === undefined) {
            previousFailure = candidateScale;
            continue;
          }
          low = candidateScale;
          high = previousFailure;
          best = candidate;
          discovered = true;
          break;
        }
      }
      if (best === undefined && validated.acknowledgeBelowProfileScale) {
        const below = knownSinglePlateBelow(
          context,
          validated.districts,
          minimumScale,
        );
        if (below !== undefined) {
          low = below.scale;
          best = below.attempt;
        }
      }
      if (best === undefined) {
        const minimumItems = scaleDistricts(
          validated.districts,
          context,
          minimumScale,
        );
        ensureIndividualDistrictsFit(
          context,
          minimumScale,
          minimumItems,
        );
        const plateOne = createPlate(context, minimumScale, 1);
        if (plateOne.issue !== undefined) {
          throw new PrintLayoutError([plateOne.issue]);
        }
        throw new PrintLayoutError([
          {
            code: "city-does-not-fit",
            message:
              (validated.acknowledgeBelowProfileScale
                ? `Complete districts do not fit together on one plate even below the profile-safe scale ${formatDimension(safeScale)}; `
                : `Complete districts do not fit together on one plate at the minimum profile-safe scale ${formatDimension(safeScale)}; `) +
              'in Print export, set Fit policy to "Tile complete districts (multi-plate)".',
            available: { ...context.usableSpan },
          },
        ]);
      }
      if (!discovered) {
        high = previousFailure;
      }
      for (
        let iteration = 0;
        iteration < SCALE_SEARCH_REFINEMENT_ITERATIONS;
        iteration += 1
      ) {
        const candidateScale = low + (high - low) / 2;
        const candidateItems = scaleDistricts(
          validated.districts,
          context,
          candidateScale,
        );
        const candidate = attemptSinglePlate(
          context,
          candidateScale,
          candidateItems,
        );
        if (candidate === undefined) {
          high = candidateScale;
        } else {
          low = candidateScale;
          best = candidate;
        }
      }
      appliedScale = low;
      attempt = best;
    }
    if (appliedScale + EPSILON < validated.requestedScale) {
      warnings.push(
        scaleWarning(
          validated.requestedScale,
          appliedScale,
          appliedScale + EPSILON >= safeScale,
        ),
      );
    }
  }

  const plates = attempt.plates.map((plate) =>
    finalizePlate(plate, context, appliedScale),
  );
  const unplaced = attempt.unplaced.map(
    (item): PrintLayoutUnplacedObject => ({
      kind: "district",
      id: item.id,
      name: item.name,
      reason: "plate-limit",
      required: requiredSize(
        item,
        physicalBaseThickness(
          context,
          appliedScale,
          `Unplaced district '${item.id}' plate base`,
          item.id,
        ),
      ),
    }),
  );
  if (plates.length > 1) {
    warnings.push(
      `Complete districts were distributed across ${plates.length} plates.`,
    );
  }
  if (unplaced.length > 0) {
    warnings.push(
      `${unplaced.length} ${unplaced.length === 1 ? "district was" : "districts were"} not placed because maximumPlateCount is ${context.maximumPlateCount}.`,
    );
  }
  const violations = featureViolations(
    validated.features,
    context.limits,
    appliedScale,
  );
  if (violations.length > 0) {
    warnings.push(belowProfileWarning(appliedScale, safeScale, violations));
  }
  return {
    profileId: profile.id,
    fitPolicy: validated.fitPolicy,
    requestedScale: validated.requestedScale,
    appliedScale,
    minimumSafeScale: safeScale,
    belowProfileScaleAcknowledged:
      validated.acknowledgeBelowProfileScale,
    featureViolations: violations,
    buildVolume: { ...profile.buildVolume },
    usableBuildBounds: context.usableBounds,
    usableBuildSpan: context.usableSpan,
    reservedRearDepth: context.reservedRearDepth,
    districtGap: context.gap,
    plates,
    warnings,
    unplaced,
  };
}
