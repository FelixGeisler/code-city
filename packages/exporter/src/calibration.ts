import {
  CODE_CITY_VERSION,
  parsePrinterProfile,
  resolvePrinterGeometryLimits,
  type PrintFormat,
  type PrinterProfile,
} from "../../core/src/index.js";

import {
  cuboidMesh,
  type PrintBounds,
  type PrintMesh,
  type PrintPart,
  type PrintPoint,
  type PrintPrimitive,
  type PrintableCity,
} from "./geometry.js";
import {
  STL_INFORMATION_LOSS_WARNING,
  type PrintExportArtifact,
} from "./print-export.js";
import { serializeBinaryStl } from "./stl.js";
import { serializeThreeMf } from "./three-mf.js";

const MANIFEST_VERSION = "1.0";
export const MAXIMUM_CALIBRATION_CHANNELS = 64;
const FALLBACK_COLORS = [
  "#64748B",
  "#22C55E",
  "#3B82F6",
  "#F59E0B",
  "#A855F7",
  "#EF4444",
  "#14B8A6",
  "#EC4899",
] as const;

export type CalibrationMeasurementId =
  | "nozzle-diameter"
  | "line-width"
  | "minimum-wall-thickness"
  | "minimum-gap"
  | "minimum-feature-size"
  | "minimum-base-thickness"
  | "minimum-raised-feature-height"
  | "minimum-recessed-feature-depth"
  | "minimum-label-stroke-width"
  | "minimum-route-width"
  | "build-margin-x"
  | "build-margin-y"
  | "build-margin-z"
  | "maximum-model-height";

export interface CalibrationMeasurement {
  readonly id: CalibrationMeasurementId;
  readonly nominalMm: number;
  readonly reference:
    | "coupon"
    | "rail-defined-groove"
    | "plate"
    | "placement"
    | "limit";
  /** Stable physical reference when this measurement has a printed coupon. */
  readonly couponId?: string;
  /** Explicit mapping for profile values defined in CityModel axes. */
  readonly axis?: {
    readonly coordinateSpace: "city";
    readonly cityAxis: "x" | "y" | "z";
    readonly printAxis: "x" | "y" | "z";
    readonly meaning: "width" | "height" | "depth";
  };
}

export interface CalibrationCoupon {
  readonly id: string;
  readonly groupId: string;
  readonly semanticGroupId: string;
  readonly measurementIds: readonly CalibrationMeasurementId[];
  readonly primitiveIds: readonly string[];
  /** Print-space bounds: X width, Y depth, Z height. */
  readonly bounds: PrintBounds;
  readonly description: string;
  readonly markerForChannelId?: string;
}

export interface CalibrationManifest {
  readonly schemaVersion: typeof MANIFEST_VERSION;
  readonly profile: {
    readonly id: string;
    readonly name: string;
  };
  readonly unit: "millimeter";
  readonly axes: {
    readonly coordinateSpace: "print";
    readonly x: {
      readonly meaning: "width";
      readonly cityAxis: "x";
    };
    readonly y: {
      readonly meaning: "depth";
      readonly cityAxis: "z";
    };
    readonly z: {
      readonly meaning: "height";
      readonly cityAxis: "y";
    };
  };
  readonly dimensions: PrintPoint;
  readonly usableVolume: PrintPoint;
  readonly measurements: readonly CalibrationMeasurement[];
  readonly coupons: readonly CalibrationCoupon[];
  readonly channels: readonly {
    readonly id: string;
    readonly label: string;
    readonly markerId: string;
    readonly markerCouponId: string;
    readonly markerBounds: PrintBounds;
  }[];
}

export interface CalibrationPreflight {
  readonly profileId: string;
  readonly profileName: string;
  readonly dimensions: PrintPoint;
  readonly partCount: number;
  readonly channelCount: number;
  readonly triangleCount: number;
  readonly measurements: readonly CalibrationMeasurement[];
  readonly manifest: {
    readonly schemaVersion: typeof MANIFEST_VERSION;
    readonly measurementCount: number;
    readonly couponCount: number;
    readonly channelMarkerCount: number;
  };
}

export interface CalibrationExportResult {
  readonly printable: PrintableCity;
  readonly preflight: CalibrationPreflight;
  readonly threeMfBytes: Uint8Array;
  readonly manifestBytes: Uint8Array;
}

export interface CalibrationPrintExportRequest {
  readonly profile: unknown;
  readonly format?: PrintFormat;
}

export interface CalibrationPrintExportPreflight
  extends CalibrationPreflight {
  readonly format: PrintFormat;
  readonly warnings: readonly string[];
}

export interface CalibrationPrintExportResult {
  readonly printable: PrintableCity;
  readonly preflight: CalibrationPrintExportPreflight;
  readonly artifact: PrintExportArtifact;
  readonly manifestBytes: Uint8Array;
}

interface PreparedCalibrationExport {
  readonly printable: PrintableCity;
  readonly preflight: CalibrationPreflight;
  readonly manifestBytes: Uint8Array;
}

export class CalibrationValidationError extends Error {
  public readonly issues: readonly string[];

  public constructor(issues: readonly string[]) {
    const unique = [...new Set(issues)];
    super(`Invalid calibration model: ${unique.join(" ")}`);
    this.name = "CalibrationValidationError";
    this.issues = unique;
  }
}

interface RelativeBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly depth: number;
  readonly height: number;
}

interface CouponGroup {
  readonly id: string;
  readonly channelIndex: number;
  readonly semanticGroupId: string;
  readonly measurementIds: readonly CalibrationMeasurementId[];
  readonly description: string;
  readonly markerForChannelId?: string;
  readonly boxes: readonly RelativeBox[];
  readonly width: number;
  readonly depth: number;
}

interface PlacedGroup extends CouponGroup {
  readonly x: number;
  readonly y: number;
}

function bounds(
  minimum: PrintPoint,
  size: PrintPoint,
): PrintBounds {
  const maximum = {
    x: minimum.x + size.x,
    y: minimum.y + size.y,
    z: minimum.z + size.z,
  };
  return { minimum, maximum, size };
}

function concatenate(meshes: readonly PrintMesh[]): PrintMesh {
  const vertices: PrintPoint[] = [];
  const triangles: { a: number; b: number; c: number }[] = [];
  for (const mesh of meshes) {
    const offset = vertices.length;
    vertices.push(...mesh.vertices.map((vertex) => ({ ...vertex })));
    triangles.push(
      ...mesh.triangles.map(({ a, b, c }) => ({
        a: a + offset,
        b: b + offset,
        c: c + offset,
      })),
    );
  }
  return { vertices, triangles };
}

function simpleGroup(
  id: string,
  width: number,
  depth: number,
  height: number,
  measurementIds: readonly CalibrationMeasurementId[],
  description: string,
): CouponGroup {
  return {
    id,
    channelIndex: 0,
    semanticGroupId: `calibration-${id}`,
    measurementIds,
    description,
    boxes: [{ x: 0, y: 0, width, depth, height }],
    width,
    depth,
  };
}

function featureGroups(
  profile: PrinterProfile,
  limits: ReturnType<typeof resolvePrinterGeometryLimits>,
): readonly CouponGroup[] {
  const couponDepth = Math.max(
    limits.minimumFeatureSize * 6,
    limits.lineWidth * 8,
    limits.nozzleDiameter * 8,
    6,
  );
  const standardHeight = Math.max(
    limits.minimumRaisedFeatureHeight,
    limits.minimumFeatureSize,
    limits.lineWidth,
  );
  const gapBarWidth = Math.max(
    limits.minimumWallThickness,
    limits.minimumFeatureSize,
    limits.lineWidth,
  );
  const gapWidth = gapBarWidth * 2 + limits.minimumGap;
  const recessRail = Math.max(
    limits.minimumWallThickness,
    limits.lineWidth,
  );
  const recessOpening = Math.max(
    limits.minimumFeatureSize * 3,
    limits.lineWidth * 6,
  );
  const recessSize = recessOpening + recessRail * 2;
  const markerSize = Math.max(
    limits.minimumFeatureSize * 3,
    limits.minimumWallThickness * 3,
    limits.lineWidth * 4,
    limits.nozzleDiameter * 4,
    3,
  );
  const markerHeight = Math.max(
    limits.minimumRaisedFeatureHeight,
    limits.lineWidth,
  );

  return [
    simpleGroup(
      "wall",
      limits.minimumWallThickness,
      couponDepth,
      standardHeight,
      ["minimum-wall-thickness"],
      "Wall-width bar.",
    ),
    {
      id: "gap",
      channelIndex: 0,
      semanticGroupId: "calibration-gap",
      measurementIds: ["minimum-gap"],
      description: "Two bars separated by the nominal gap.",
      boxes: [
        {
          x: 0,
          y: 0,
          width: gapBarWidth,
          depth: couponDepth,
          height: standardHeight,
        },
        {
          x: gapBarWidth + limits.minimumGap,
          y: 0,
          width: gapBarWidth,
          depth: couponDepth,
          height: standardHeight,
        },
      ],
      width: gapWidth,
      depth: couponDepth,
    },
    simpleGroup(
      "raised",
      Math.max(limits.minimumFeatureSize * 4, 4),
      couponDepth,
      limits.minimumRaisedFeatureHeight,
      ["minimum-raised-feature-height"],
      "Raised-height pad.",
    ),
    {
      id: "recessed",
      channelIndex: 0,
      semanticGroupId: "calibration-recessed",
      measurementIds: ["minimum-recessed-feature-depth"],
      description: "Four rails define the nominal recessed groove depth.",
      boxes: [
        {
          x: 0,
          y: 0,
          width: recessSize,
          depth: recessRail,
          height: limits.minimumRecessedFeatureDepth,
        },
        {
          x: 0,
          y: recessSize - recessRail,
          width: recessSize,
          depth: recessRail,
          height: limits.minimumRecessedFeatureDepth,
        },
        {
          x: 0,
          y: recessRail,
          width: recessRail,
          depth: recessOpening,
          height: limits.minimumRecessedFeatureDepth,
        },
        {
          x: recessSize - recessRail,
          y: recessRail,
          width: recessRail,
          depth: recessOpening,
          height: limits.minimumRecessedFeatureDepth,
        },
      ],
      width: recessSize,
      depth: recessSize,
    },
    simpleGroup(
      "label-stroke",
      limits.minimumLabelStrokeWidth,
      couponDepth,
      standardHeight,
      ["minimum-label-stroke-width"],
      "Label-stroke-width bar.",
    ),
    simpleGroup(
      "route-width",
      limits.minimumRouteWidth,
      couponDepth,
      standardHeight,
      ["minimum-route-width"],
      "Dependency-route-width bar.",
    ),
    simpleGroup(
      "line-width",
      limits.lineWidth,
      couponDepth,
      standardHeight,
      ["line-width"],
      "Extrusion-line-width bar.",
    ),
    simpleGroup(
      "nozzle-diameter",
      limits.nozzleDiameter,
      couponDepth,
      standardHeight,
      ["nozzle-diameter"],
      "Nozzle-diameter reference bar.",
    ),
    simpleGroup(
      "minimum-feature",
      limits.minimumFeatureSize,
      couponDepth,
      standardHeight,
      ["minimum-feature-size"],
      "Minimum-feature-width bar.",
    ),
    ...profile.printChannels.map(
      (_channel, index): CouponGroup => ({
        id: `channel-${String(index + 1).padStart(3, "0")}`,
        channelIndex: index,
        semanticGroupId: `calibration-channel-${String(index + 1).padStart(3, "0")}`,
        measurementIds: [],
        description: `Channel marker for ${profile.printChannels[index]!.label}.`,
        markerForChannelId: profile.printChannels[index]!.id,
        boxes: [
          {
            x: 0,
            y: 0,
            width: markerSize,
            depth: markerSize,
            height: markerHeight,
          },
        ],
        width: markerSize,
        depth: markerSize,
      }),
    ),
  ];
}

function packGroups(
  groups: readonly CouponGroup[],
  usableWidth: number,
  usableDepth: number,
  padding: number,
): {
  readonly groups: readonly PlacedGroup[];
  readonly plateWidth: number;
  readonly plateDepth: number;
} {
  const placements: PlacedGroup[] = [];
  let x = padding;
  let y = padding;
  let rowDepth = 0;
  let maximumX = padding;

  for (const group of groups) {
    if (group.width + padding * 2 > usableWidth) {
      throw new CalibrationValidationError([
        `Calibration coupon '${group.id}' needs ${group.width + padding * 2} mm X but the margin-adjusted build volume provides ${usableWidth} mm.`,
      ]);
    }
    if (x > padding && x + group.width + padding > usableWidth) {
      x = padding;
      y += rowDepth + padding;
      rowDepth = 0;
    }
    if (y + group.depth + padding > usableDepth) {
      throw new CalibrationValidationError([
        `Calibration coupons need more than the ${usableDepth} mm margin-adjusted Z depth.`,
      ]);
    }
    placements.push({ ...group, x, y });
    maximumX = Math.max(maximumX, x + group.width);
    rowDepth = Math.max(rowDepth, group.depth);
    x += group.width + padding;
  }

  return {
    groups: placements,
    plateWidth: maximumX + padding,
    plateDepth: y + rowDepth + padding,
  };
}

function calibrationCouponId(groupId: string): string {
  return `calibration-coupon-${groupId}`;
}

function calibrationPrimitiveId(
  groupId: string,
  boxIndex: number,
): string {
  return `calibration-${groupId}-${String(boxIndex + 1).padStart(2, "0")}`;
}

function measurementManifest(
  limits: ReturnType<typeof resolvePrinterGeometryLimits>,
): readonly CalibrationMeasurement[] {
  return [
    {
      id: "nozzle-diameter",
      nominalMm: limits.nozzleDiameter,
      reference: "coupon",
      couponId: calibrationCouponId("nozzle-diameter"),
    },
    {
      id: "line-width",
      nominalMm: limits.lineWidth,
      reference: "coupon",
      couponId: calibrationCouponId("line-width"),
    },
    {
      id: "minimum-wall-thickness",
      nominalMm: limits.minimumWallThickness,
      reference: "coupon",
      couponId: calibrationCouponId("wall"),
    },
    {
      id: "minimum-gap",
      nominalMm: limits.minimumGap,
      reference: "coupon",
      couponId: calibrationCouponId("gap"),
    },
    {
      id: "minimum-feature-size",
      nominalMm: limits.minimumFeatureSize,
      reference: "coupon",
      couponId: calibrationCouponId("minimum-feature"),
    },
    {
      id: "minimum-base-thickness",
      nominalMm: limits.minimumBaseThickness,
      reference: "plate",
      couponId: calibrationCouponId("base"),
    },
    {
      id: "minimum-raised-feature-height",
      nominalMm: limits.minimumRaisedFeatureHeight,
      reference: "coupon",
      couponId: calibrationCouponId("raised"),
    },
    {
      id: "minimum-recessed-feature-depth",
      nominalMm: limits.minimumRecessedFeatureDepth,
      // The exposed plate is the groove floor; the surrounding rail height
      // is therefore the exact depth reference without a fragile mesh boolean.
      reference: "rail-defined-groove",
      couponId: calibrationCouponId("recessed"),
    },
    {
      id: "minimum-label-stroke-width",
      nominalMm: limits.minimumLabelStrokeWidth,
      reference: "coupon",
      couponId: calibrationCouponId("label-stroke"),
    },
    {
      id: "minimum-route-width",
      nominalMm: limits.minimumRouteWidth,
      reference: "coupon",
      couponId: calibrationCouponId("route-width"),
    },
    {
      id: "build-margin-x",
      nominalMm: limits.buildMargins.x,
      reference: "placement",
      axis: {
        coordinateSpace: "city",
        cityAxis: "x",
        printAxis: "x",
        meaning: "width",
      },
    },
    {
      id: "build-margin-y",
      nominalMm: limits.buildMargins.y,
      reference: "placement",
      axis: {
        coordinateSpace: "city",
        cityAxis: "y",
        printAxis: "z",
        meaning: "height",
      },
    },
    {
      id: "build-margin-z",
      nominalMm: limits.buildMargins.z,
      reference: "placement",
      axis: {
        coordinateSpace: "city",
        cityAxis: "z",
        printAxis: "y",
        meaning: "depth",
      },
    },
    {
      id: "maximum-model-height",
      nominalMm: limits.maximumModelHeight,
      reference: "limit",
      axis: {
        coordinateSpace: "city",
        cityAxis: "y",
        printAxis: "z",
        meaning: "height",
      },
    },
  ];
}

function manifestBytes(manifest: CalibrationManifest): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
}

function parts(
  primitives: readonly PrintPrimitive[],
  profile: PrinterProfile,
): readonly PrintPart[] {
  return profile.printChannels.map((channel, index) => {
    const channelPrimitives = primitives.filter(
      (primitive) => primitive.channelId === channel.id,
    );
    return {
      id: `calibration-part-${String(index + 1).padStart(3, "0")}`,
      channelId: channel.id,
      name: `Calibration ${channel.label}`,
      displayColor:
        channel.color ?? FALLBACK_COLORS[index % FALLBACK_COLORS.length]!,
      semanticGroupIds: [
        ...new Set(
          channelPrimitives.map(({ semanticGroupId }) => semanticGroupId),
        ),
      ].sort(),
      primitives: channelPrimitives,
      mesh: concatenate(channelPrimitives.map(({ mesh }) => mesh)),
    };
  });
}

const CALIBRATION_EPSILON = 1e-9;

function close(left: number, right: number): boolean {
  const scale = Math.max(1, Math.abs(left), Math.abs(right));
  return Math.abs(left - right) <= CALIBRATION_EPSILON * scale;
}

function sameBounds(left: PrintBounds, right: PrintBounds): boolean {
  return (["x", "y", "z"] as const).every(
    (axis) =>
      close(left.minimum[axis], right.minimum[axis]) &&
      close(left.maximum[axis], right.maximum[axis]) &&
      close(left.size[axis], right.size[axis]),
  );
}

function sameMesh(left: PrintMesh, right: PrintMesh): boolean {
  return (
    left.vertices.length === right.vertices.length &&
    left.triangles.length === right.triangles.length &&
    left.vertices.every((vertex, index) => {
      const expected = right.vertices[index]!;
      return (
        close(vertex.x, expected.x) &&
        close(vertex.y, expected.y) &&
        close(vertex.z, expected.z)
      );
    }) &&
    left.triangles.every((triangle, index) => {
      const expected = right.triangles[index]!;
      return (
        triangle.a === expected.a &&
        triangle.b === expected.b &&
        triangle.c === expected.c
      );
    })
  );
}

function combinedBounds(
  primitives: readonly PrintPrimitive[],
): PrintBounds | undefined {
  if (primitives.length === 0) return undefined;
  const minimum = {
    x: Math.min(...primitives.map(({ bounds: item }) => item.minimum.x)),
    y: Math.min(...primitives.map(({ bounds: item }) => item.minimum.y)),
    z: Math.min(...primitives.map(({ bounds: item }) => item.minimum.z)),
  };
  const maximum = {
    x: Math.max(...primitives.map(({ bounds: item }) => item.maximum.x)),
    y: Math.max(...primitives.map(({ bounds: item }) => item.maximum.y)),
    z: Math.max(...primitives.map(({ bounds: item }) => item.maximum.z)),
  };
  return bounds(minimum, {
    x: maximum.x - minimum.x,
    y: maximum.y - minimum.y,
    z: maximum.z - minimum.z,
  });
}

function expectedCalibrationPrimitives(
  packed: {
    readonly groups: readonly PlacedGroup[];
    readonly plateWidth: number;
    readonly plateDepth: number;
  },
  profile: PrinterProfile,
  baseThickness: number,
  totalHeight: number,
): readonly PrintPrimitive[] {
  const baseBounds = bounds(
    { x: 0, y: 0, z: 0 },
    {
      x: packed.plateWidth,
      y: packed.plateDepth,
      z: baseThickness,
    },
  );
  const base: PrintPrimitive = {
    id: "calibration-base",
    kind: "base",
    semanticGroupId: "calibration-base",
    channelId: profile.printChannels[0]!.id,
    bounds: baseBounds,
    mesh: cuboidMesh(baseBounds),
  };
  const coupons = packed.groups.flatMap((group) =>
    group.boxes.map((box, boxIndex): PrintPrimitive => {
      const itemBounds = bounds(
        {
          x: group.x + box.x,
          y: group.y + box.y,
          z: baseThickness,
        },
        { x: box.width, y: box.depth, z: box.height },
      );
      return {
        id: calibrationPrimitiveId(group.id, boxIndex),
        kind: "comparison-cell",
        semanticGroupId: group.semanticGroupId,
        channelId: profile.printChannels[group.channelIndex]!.id,
        bounds: itemBounds,
        mesh: cuboidMesh(itemBounds),
      };
    }),
  );
  const expectedBounds = combinedBounds([base, ...coupons]);
  if (
    expectedBounds === undefined ||
    !close(expectedBounds.size.z, totalHeight)
  ) {
    throw new Error("Calibration layout height is internally inconsistent.");
  }
  return [base, ...coupons];
}

function calibrationGeometryIssues(
  printable: PrintableCity,
  profile: PrinterProfile,
  limits: ReturnType<typeof resolvePrinterGeometryLimits>,
  usableVolume: PrintPoint,
  packed: {
    readonly groups: readonly PlacedGroup[];
    readonly plateWidth: number;
    readonly plateDepth: number;
  },
  totalHeight: number,
): readonly string[] {
  const issues: string[] = [];
  const primitives = printable.parts.flatMap(
    ({ primitives: items }) => items,
  );
  const expected = expectedCalibrationPrimitives(
    packed,
    profile,
    limits.minimumBaseThickness,
    totalHeight,
  );
  const expectedById = new Map(expected.map((item) => [item.id, item]));
  const actualById = new Map<string, PrintPrimitive>();

  if (
    !sameBounds(
      printable.bounds,
      bounds(
        { x: 0, y: 0, z: 0 },
        {
          x: packed.plateWidth,
          y: packed.plateDepth,
          z: totalHeight,
        },
      ),
    )
  ) {
    issues.push(
      "Calibration bounds must be zero-origin and match the planned plate.",
    );
  }
  const measured = combinedBounds(primitives);
  if (measured === undefined || !sameBounds(measured, printable.bounds)) {
    issues.push(
      "Calibration bounds must match the measured primitive bounds.",
    );
  }
  for (const axis of ["x", "y", "z"] as const) {
    if (printable.bounds.size[axis] > usableVolume[axis] + CALIBRATION_EPSILON) {
      issues.push(
        `Calibration ${axis.toUpperCase()} size exceeds the usable profile span.`,
      );
    }
  }

  const bases = primitives.filter(({ kind }) => kind === "base");
  if (bases.length !== 1 || bases[0]?.id !== "calibration-base") {
    issues.push("Calibration must contain exactly one canonical base.");
  }
  const base = bases[0];
  for (const item of primitives) {
    if (actualById.has(item.id)) {
      issues.push(`Duplicate calibration primitive id '${item.id}'.`);
    }
    actualById.set(item.id, item);
    const expectedItem = expectedById.get(item.id);
    if (
      expectedItem === undefined ||
      item.kind !== expectedItem.kind ||
      item.semanticGroupId !== expectedItem.semanticGroupId ||
      item.channelId !== expectedItem.channelId ||
      !sameBounds(item.bounds, expectedItem.bounds)
    ) {
      issues.push(
        `Calibration primitive '${item.id}' does not match its planned coupon.`,
      );
    }
    if (!sameMesh(item.mesh, cuboidMesh(item.bounds))) {
      issues.push(
        `Calibration primitive '${item.id}' must be a closed canonical cuboid.`,
      );
    }
    if (base !== undefined && item !== base) {
      if (!close(item.bounds.minimum.z, base.bounds.maximum.z)) {
        issues.push(
          `Calibration primitive '${item.id}' is not face-supported by the base.`,
        );
      }
      if (
        item.bounds.minimum.x < base.bounds.minimum.x - CALIBRATION_EPSILON ||
        item.bounds.maximum.x > base.bounds.maximum.x + CALIBRATION_EPSILON ||
        item.bounds.minimum.y < base.bounds.minimum.y - CALIBRATION_EPSILON ||
        item.bounds.maximum.y > base.bounds.maximum.y + CALIBRATION_EPSILON
      ) {
        issues.push(
          `Calibration primitive '${item.id}' is outside the base footprint.`,
        );
      }
    }
  }
  for (const id of expectedById.keys()) {
    if (!actualById.has(id)) {
      issues.push(`Calibration primitive '${id}' is missing.`);
    }
  }
  if (actualById.size !== expectedById.size) {
    issues.push("Calibration primitive count does not match the plan.");
  }

  const profileChannels = new Set(
    profile.printChannels.map(({ id }) => id),
  );
  const partChannels = new Set<string>();
  for (const part of printable.parts) {
    if (!profileChannels.has(part.channelId) || partChannels.has(part.channelId)) {
      issues.push(
        `Calibration part channel '${part.channelId}' is invalid or duplicated.`,
      );
    }
    partChannels.add(part.channelId);
    if (
      part.primitives.some(
        ({ channelId }) => channelId !== part.channelId,
      )
    ) {
      issues.push(
        `Calibration part '${part.id}' contains a primitive from another channel.`,
      );
    }
    const semanticGroupIds = [
      ...new Set(
        part.primitives.map(({ semanticGroupId }) => semanticGroupId),
      ),
    ].sort();
    if (
      semanticGroupIds.length !== part.semanticGroupIds.length ||
      semanticGroupIds.some(
        (id, index) => id !== part.semanticGroupIds[index],
      )
    ) {
      issues.push(
        `Calibration part '${part.id}' semantic groups do not match its primitives.`,
      );
    }
    if (
      !sameMesh(
        part.mesh,
        concatenate(part.primitives.map(({ mesh }) => mesh)),
      )
    ) {
      issues.push(
        `Calibration part '${part.id}' mesh does not match its primitives.`,
      );
    }
  }
  if (
    printable.parts.length !== profile.printChannels.length ||
    partChannels.size !== profile.printChannels.length
  ) {
    issues.push("Calibration must contain exactly one part per print channel.");
  }

  const gapLeft = actualById.get("calibration-gap-01");
  const gapRight = actualById.get("calibration-gap-02");
  if (
    gapLeft === undefined ||
    gapRight === undefined ||
    !close(
      gapRight.bounds.minimum.x - gapLeft.bounds.maximum.x,
      limits.minimumGap,
    )
  ) {
    issues.push("Calibration gap coupon does not preserve the nominal gap.");
  }
  const recessRails = [0, 1, 2, 3].map((index) =>
    actualById.get(calibrationPrimitiveId("recessed", index)),
  );
  if (
    recessRails.some(
      (item) =>
        item === undefined ||
        !close(
          item.bounds.size.z,
          limits.minimumRecessedFeatureDepth,
        ),
    )
  ) {
    issues.push(
      "Calibration recessed coupon does not preserve the rail-defined groove depth.",
    );
  }
  profile.printChannels.forEach((channel, index) => {
    const markerId = calibrationPrimitiveId(
      `channel-${String(index + 1).padStart(3, "0")}`,
      0,
    );
    const markers = primitives.filter(({ id }) => id === markerId);
    if (
      markers.length !== 1 ||
      markers[0]!.channelId !== channel.id
    ) {
      issues.push(
        `Calibration channel '${channel.id}' must have exactly one marker.`,
      );
    }
  });
  return [...new Set(issues)];
}

function calibrationCoupons(
  packed: {
    readonly groups: readonly PlacedGroup[];
  },
  primitives: readonly PrintPrimitive[],
): readonly CalibrationCoupon[] {
  const byId = new Map(primitives.map((item) => [item.id, item]));
  const base = byId.get("calibration-base")!;
  return [
    {
      id: calibrationCouponId("base"),
      groupId: "base",
      semanticGroupId: "calibration-base",
      measurementIds: ["minimum-base-thickness"],
      primitiveIds: [base.id],
      bounds: base.bounds,
      description: "Shared calibration plate.",
    },
    ...packed.groups.map((group): CalibrationCoupon => {
      const primitiveIds = group.boxes.map((_box, index) =>
        calibrationPrimitiveId(group.id, index),
      );
      const groupPrimitives = primitiveIds.map((id) => byId.get(id)!);
      return {
        id: calibrationCouponId(group.id),
        groupId: group.id,
        semanticGroupId: group.semanticGroupId,
        measurementIds: group.measurementIds,
        primitiveIds,
        bounds: combinedBounds(groupPrimitives)!,
        description: group.description,
        ...(group.markerForChannelId === undefined
          ? {}
          : { markerForChannelId: group.markerForChannelId }),
      };
    }),
  ];
}

/**
 * Rechecks a calibration printable against the deterministic profile-derived
 * coupon plan. Export generation calls the same validator before serialization.
 */
export function validateCalibrationPrintable(
  printable: PrintableCity,
  profileInput: unknown,
): readonly string[] {
  const profile = parsePrinterProfile(profileInput);
  const limits = resolvePrinterGeometryLimits(profile);
  const usableVolume = {
    x: profile.buildVolume.x - limits.buildMargins.x * 2,
    y: profile.buildVolume.z - limits.buildMargins.z * 2,
    z: Math.min(
      profile.buildVolume.y - limits.buildMargins.y * 2,
      limits.maximumModelHeight,
    ),
  };
  const padding = Math.max(
    limits.minimumGap,
    limits.minimumFeatureSize,
    limits.lineWidth,
    limits.nozzleDiameter,
  );
  const packed = packGroups(
    featureGroups(profile, limits),
    usableVolume.x,
    usableVolume.y,
    padding,
  );
  const maximumFeatureHeight = Math.max(
    ...packed.groups.flatMap(({ boxes }) =>
      boxes.map(({ height }) => height),
    ),
  );
  const totalHeight =
    limits.minimumBaseThickness + maximumFeatureHeight;
  return calibrationGeometryIssues(
    printable,
    profile,
    limits,
    usableVolume,
    packed,
    totalHeight,
  );
}

/**
 * Builds the complete calibration artifact without filesystem, browser, or
 * network access. Identical normalized profiles produce identical bytes.
 */
function prepareCalibrationExport(
  profileInput: unknown,
  format: PrintFormat,
): PreparedCalibrationExport {
  const profile = parsePrinterProfile(profileInput);
  if (!profile.supportedFormats.includes(format)) {
    throw new CalibrationValidationError([
      `Profile '${profile.id}' does not support ${format.toUpperCase()} calibration output.`,
    ]);
  }
  if (profile.printChannels.length > MAXIMUM_CALIBRATION_CHANNELS) {
    throw new CalibrationValidationError([
      `Calibration supports at most ${MAXIMUM_CALIBRATION_CHANNELS} print channels; profile '${profile.id}' declares ${profile.printChannels.length}.`,
    ]);
  }
  const limits = resolvePrinterGeometryLimits(profile);
  const usableVolume = {
    x: profile.buildVolume.x - limits.buildMargins.x * 2,
    y: profile.buildVolume.z - limits.buildMargins.z * 2,
    z: Math.min(
      profile.buildVolume.y - limits.buildMargins.y * 2,
      limits.maximumModelHeight,
    ),
  };
  const unusableAxes = (["x", "y", "z"] as const).filter(
    (axis) => !Number.isFinite(usableVolume[axis]) || usableVolume[axis] <= 0,
  );
  if (unusableAxes.length > 0) {
    throw new CalibrationValidationError(
      unusableAxes.map(
        (axis) =>
          `Profile buildMargins.${axis === "y" ? "z" : axis === "z" ? "y" : "x"} leaves no usable ${axis.toUpperCase()} calibration volume.`,
      ),
    );
  }

  const padding = Math.max(
    limits.minimumGap,
    limits.minimumFeatureSize,
    limits.lineWidth,
    limits.nozzleDiameter,
  );
  const packed = packGroups(
    featureGroups(profile, limits),
    usableVolume.x,
    usableVolume.y,
    padding,
  );
  const maximumFeatureHeight = Math.max(
    ...packed.groups.flatMap(({ boxes }) =>
      boxes.map(({ height }) => height),
    ),
  );
  const totalHeight = limits.minimumBaseThickness + maximumFeatureHeight;
  if (totalHeight > usableVolume.z) {
    throw new CalibrationValidationError([
      `Calibration needs ${totalHeight} mm Y height but the margin- and maximumModelHeight-adjusted profile provides ${usableVolume.z} mm.`,
    ]);
  }

  const firstChannel = profile.printChannels[0]!;
  // Margins reduce the allowable spans; files stay at a portable zero origin
  // so slicer placement does not depend on machine-specific offsets.
  const origin = { x: 0, y: 0, z: 0 };
  const baseBounds = bounds(origin, {
    x: packed.plateWidth,
    y: packed.plateDepth,
    z: limits.minimumBaseThickness,
  });
  const base: PrintPrimitive = {
    id: "calibration-base",
    kind: "base",
    semanticGroupId: "calibration-base",
    channelId: firstChannel.id,
    bounds: baseBounds,
    mesh: cuboidMesh(baseBounds),
  };
  const coupons = packed.groups.flatMap((group) =>
    group.boxes.map((box, boxIndex): PrintPrimitive => {
      const itemBounds = bounds(
        {
          x: origin.x + group.x + box.x,
          y: origin.y + group.y + box.y,
          z: baseBounds.maximum.z,
        },
        { x: box.width, y: box.depth, z: box.height },
      );
      return {
        id: calibrationPrimitiveId(group.id, boxIndex),
        kind: "comparison-cell",
        semanticGroupId: group.semanticGroupId,
        channelId: profile.printChannels[group.channelIndex]!.id,
        bounds: itemBounds,
        mesh: cuboidMesh(itemBounds),
      };
    }),
  );
  const primitives = [base, ...coupons];
  const printableParts = parts(primitives, profile);
  const printable: PrintableCity = {
    application: { name: "Code City", version: CODE_CITY_VERSION },
    profileId: profile.id,
    title: `Code City calibration - ${profile.name}`,
    unit: "millimeter",
    scale: 1,
    bounds: bounds(origin, {
      x: packed.plateWidth,
      y: packed.plateDepth,
      z: totalHeight,
    }),
    measurements: {
      baseThickness: limits.minimumBaseThickness,
      wallThickness: limits.minimumWallThickness,
      minimumFeatureSize: Math.min(
        limits.minimumFeatureSize,
        limits.minimumWallThickness,
        limits.minimumLabelStrokeWidth,
        limits.minimumRouteWidth,
        limits.lineWidth,
        limits.nozzleDiameter,
      ),
      minimumGap: limits.minimumGap,
    },
    parts: printableParts,
  };
  const measurements = measurementManifest(limits);
  const dimensions = { ...printable.bounds.size };
  const geometryIssues = calibrationGeometryIssues(
    printable,
    profile,
    limits,
    usableVolume,
    packed,
    totalHeight,
  );
  if (geometryIssues.length > 0) {
    throw new CalibrationValidationError(geometryIssues);
  }
  const couponReferences = calibrationCoupons(packed, primitives);
  const primitiveById = new Map(primitives.map((item) => [item.id, item]));
  const manifest: CalibrationManifest = {
    schemaVersion: MANIFEST_VERSION,
    profile: { id: profile.id, name: profile.name },
    unit: "millimeter",
    axes: {
      coordinateSpace: "print",
      x: { meaning: "width", cityAxis: "x" },
      y: { meaning: "depth", cityAxis: "z" },
      z: { meaning: "height", cityAxis: "y" },
    },
    dimensions,
    usableVolume,
    measurements,
    coupons: couponReferences,
    channels: profile.printChannels.map((channel, index) => ({
      id: channel.id,
      label: channel.label,
      markerId: calibrationPrimitiveId(
        `channel-${String(index + 1).padStart(3, "0")}`,
        0,
      ),
      markerCouponId: calibrationCouponId(
        `channel-${String(index + 1).padStart(3, "0")}`,
      ),
      markerBounds: primitiveById.get(
        calibrationPrimitiveId(
          `channel-${String(index + 1).padStart(3, "0")}`,
          0,
        ),
      )!.bounds,
    })),
  };
  const preflight: CalibrationPreflight = {
    profileId: profile.id,
    profileName: profile.name,
    dimensions,
    partCount: printable.parts.length,
    channelCount: profile.printChannels.length,
    triangleCount: printable.parts.reduce(
      (count, part) => count + part.mesh.triangles.length,
      0,
    ),
    measurements,
    manifest: {
      schemaVersion: MANIFEST_VERSION,
      measurementCount: measurements.length,
      couponCount: couponReferences.length,
      channelMarkerCount: profile.printChannels.length,
    },
  };
  return {
    printable,
    preflight,
    manifestBytes: manifestBytes(manifest),
  };
}

/**
 * Generates a format-neutral calibration artifact. STL preserves all shells
 * but collapses channel/color metadata into one mesh.
 */
export function generateCalibrationPrintExport(
  request: CalibrationPrintExportRequest,
): CalibrationPrintExportResult {
  const format = request.format ?? "3mf";
  if (format !== "3mf" && format !== "stl") {
    throw new CalibrationValidationError([
      "Calibration format must be either '3mf' or 'stl'.",
    ]);
  }
  const prepared = prepareCalibrationExport(request.profile, format);
  const artifact: PrintExportArtifact =
    format === "3mf"
      ? {
          format,
          mimeType: "model/3mf",
          fileExtension: ".3mf",
          bytes: serializeThreeMf(prepared.printable),
        }
      : {
          format,
          mimeType: "model/stl",
          fileExtension: ".stl",
          bytes: serializeBinaryStl(prepared.printable),
        };
  return {
    printable: prepared.printable,
    preflight: {
      ...prepared.preflight,
      format,
      partCount:
        format === "stl" ? 1 : prepared.preflight.partCount,
      warnings:
        format === "stl" ? [STL_INFORMATION_LOSS_WARNING] : [],
    },
    artifact,
    manifestBytes: prepared.manifestBytes,
  };
}

/**
 * Backward-compatible 3MF calibration API.
 */
export function generateCalibrationExport(
  profileInput: unknown,
): CalibrationExportResult {
  const result = generateCalibrationPrintExport({
    profile: profileInput,
    format: "3mf",
  });
  const preflight: CalibrationPreflight = {
    profileId: result.preflight.profileId,
    profileName: result.preflight.profileName,
    dimensions: result.preflight.dimensions,
    partCount: result.preflight.partCount,
    channelCount: result.preflight.channelCount,
    triangleCount: result.preflight.triangleCount,
    measurements: result.preflight.measurements,
    manifest: result.preflight.manifest,
  };
  return {
    printable: result.printable,
    preflight,
    threeMfBytes: result.artifact.bytes,
    manifestBytes: result.manifestBytes,
  };
}
