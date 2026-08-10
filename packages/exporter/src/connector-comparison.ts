import { CODE_CITY_VERSION } from "../../core/src/version.js";
import {
  resolvePrinterGeometryLimits,
  validatePrinterProfile,
  type PrinterProfile,
} from "../../core/src/print.js";

import {
  cuboidMesh,
  raisedPrintableTextMesh,
  type PrintBounds,
  type PrintMesh,
  type PrintPart,
  type PrintPoint,
  type PrintPrimitive,
  type PrintPrimitiveKind,
  type PrintableCity,
} from "./geometry.js";
import { printableTextWidth } from "./printable-font.js";
import { minimumPositiveHorizontalGap } from "./spatial.js";
import {
  PrintGeometryValidationError,
  validatePrintableCity,
} from "./validate.js";

export const DEPENDENCY_CONNECTOR_DECISION =
  "integrated-raised-trace" as const;

export interface DependencyConnectorComparisonMeasurements {
  readonly featureSize: number;
  readonly labelFeatureSize: number;
  readonly baseThickness: number;
  readonly traceWidth: number;
  readonly traceHeight: number;
  readonly clearance: number;
  readonly socketWallThickness: number;
  readonly nominalConnectorWidth: number;
  readonly socketOpeningWidth: number;
  readonly footprint: {
    readonly width: number;
    readonly depth: number;
    readonly height: number;
  };
}

export interface DependencyConnectorComparison {
  readonly printable: PrintableCity;
  readonly measurements: DependencyConnectorComparisonMeasurements;
  readonly decision: typeof DEPENDENCY_CONNECTOR_DECISION;
  /** Concise, deterministic and LF-terminated slicing guidance. */
  readonly instructions: string;
}

const EPSILON = 1e-9;
const COLORS = [
  "#7C879B",
  "#2FB391",
  "#56A8E8",
  "#F2A93B",
  "#B68CFF",
] as const;

function box(
  x: number,
  y: number,
  z: number,
  width: number,
  depth: number,
  height: number,
): PrintBounds {
  return {
    minimum: { x, y, z },
    maximum: { x: x + width, y: y + depth, z: z + height },
    size: { x: width, y: depth, z: height },
  };
}

function meshBounds(mesh: PrintMesh): PrintBounds {
  const minimum = {
    x: Math.min(...mesh.vertices.map(({ x }) => x)),
    y: Math.min(...mesh.vertices.map(({ y }) => y)),
    z: Math.min(...mesh.vertices.map(({ z }) => z)),
  };
  const maximum = {
    x: Math.max(...mesh.vertices.map(({ x }) => x)),
    y: Math.max(...mesh.vertices.map(({ y }) => y)),
    z: Math.max(...mesh.vertices.map(({ z }) => z)),
  };
  return {
    minimum,
    maximum,
    size: {
      x: maximum.x - minimum.x,
      y: maximum.y - minimum.y,
      z: maximum.z - minimum.z,
    },
  };
}

function primitive(
  id: string,
  kind: PrintPrimitiveKind,
  semanticGroupId: string,
  channelId: string,
  bounds: PrintBounds,
): PrintPrimitive {
  return {
    id,
    kind,
    semanticGroupId,
    channelId,
    bounds,
    mesh: cuboidMesh(bounds),
  };
}

function textPrimitive(
  id: string,
  semanticGroupId: string,
  channelId: string,
  text: string,
  featureSize: number,
  raisedHeight: number,
  origin: PrintPoint,
): PrintPrimitive {
  const mesh = raisedPrintableTextMesh(
    text,
    featureSize,
    origin,
    "horizontal",
    raisedHeight,
  );
  return {
    id,
    kind: "comparison-label",
    semanticGroupId,
    channelId,
    mesh,
    bounds: meshBounds(mesh),
  };
}

function concatenate(meshes: readonly PrintMesh[]): PrintMesh {
  const vertices: PrintPoint[] = [];
  const triangles: { a: number; b: number; c: number }[] = [];
  for (const mesh of meshes) {
    const offset = vertices.length;
    vertices.push(...mesh.vertices);
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

function channelAt(profile: PrinterProfile, roleIndex: number): string {
  return profile.printChannels[
    Math.min(roleIndex, profile.printChannels.length - 1)
  ]!.id;
}

function parts(
  profile: PrinterProfile,
  primitives: readonly PrintPrimitive[],
): readonly PrintPart[] {
  return profile.printChannels.flatMap((channel, channelIndex) => {
    const items = primitives.filter(
      ({ channelId }) => channelId === channel.id,
    );
    if (items.length === 0) return [];
    return [{
      id: `channel:${channel.id}`,
      channelId: channel.id,
      name: channel.label,
      displayColor: channel.color ?? COLORS[channelIndex % COLORS.length]!,
      semanticGroupIds: [
        ...new Set(items.map(({ semanticGroupId }) => semanticGroupId)),
      ].sort(),
      primitives: items,
      mesh: concatenate(items.map(({ mesh }) => mesh)),
    }];
  });
}

function mm(value: number): string {
  return String(Number(value.toFixed(3)));
}

function instructions(
  profile: PrinterProfile,
  measurements: DependencyConnectorComparisonMeasurements,
): string {
  return [
    "Code City dependency connector comparison",
    `Profile: ${profile.id.normalize("NFC").trim().replace(/\s+/gu, " ")}`,
    `Decision: ${DEPENDENCY_CONNECTOR_DECISION}`,
    `Integrated trace: ${mm(measurements.traceWidth)} x ${mm(measurements.traceHeight)} mm, consumer to provider.`,
    `Clearance: ${mm(measurements.clearance)} mm.`,
    `Detachable reference: ${mm(measurements.socketWallThickness)} mm socket wall, ${mm(measurements.nominalConnectorWidth)} mm nominal connector, ${mm(measurements.socketOpeningWidth)} mm opening.`,
    "Optionally bridge the sockets after printing with filament, wire, or a separately printed connector.",
    "Automated geometry validation selected the integrated raised trace.",
    "",
  ].join("\n");
}

/**
 * Builds one printable comparison plate that documents why dependency routes
 * use integrated raised traces instead of detachable connector pieces.
 */
export function buildDependencyConnectorComparison(
  profile: PrinterProfile,
): DependencyConnectorComparison {
  const profileIssues = validatePrinterProfile(profile);
  if (profileIssues.length > 0) {
    throw new PrintGeometryValidationError(profileIssues);
  }

  const limits = resolvePrinterGeometryLimits(profile);
  const feature = Math.max(
    limits.minimumFeatureSize,
    limits.minimumWallThickness,
  );
  const clearance = limits.minimumGap;
  const labelFeature = Math.max(
    feature,
    clearance,
    limits.minimumLabelStrokeWidth,
  );
  const labelRaisedHeight = Math.max(
    labelFeature,
    limits.minimumRaisedFeatureHeight,
  );
  const routeWidth = Math.max(feature, limits.minimumRouteWidth);
  const routeHeight = Math.max(
    feature,
    limits.minimumRaisedFeatureHeight,
  );
  const baseThickness = Math.max(
    limits.minimumBaseThickness,
    feature,
  );
  const padding = Math.max(feature, clearance);
  const cellHeight = feature;
  const labelHeight = 5 * labelFeature;
  const endpointWidth = 4 * feature;
  const endpointDepth = 5 * feature;
  const endpointHeight = 3 * feature;
  const socketLength = 5 * feature;
  const nominalConnectorWidth = 2 * feature;
  const socketOpeningWidth = nominalConnectorWidth + 2 * clearance;
  const socketOuterDepth = socketOpeningWidth + 2 * feature;
  const diagramDepth = Math.max(
    endpointDepth,
    socketOuterDepth,
    5 * routeWidth,
  );
  const labels = ["INTEGRATED", "DETACHABLE"] as const;
  const cellWidth =
    Math.max(...labels.map((text) => printableTextWidth(text, labelFeature))) +
    2 * padding;
  const cellDepth =
    2 * padding + diagramDepth + padding + labelHeight;
  const cellGap = clearance;
  const margin = 2 * padding;
  const baseWidth = 2 * margin + 2 * cellWidth + cellGap;
  const baseDepth = 2 * margin + cellDepth;
  const totalHeight =
    baseThickness +
    cellHeight +
    Math.max(
      endpointHeight,
      3 * feature,
      routeHeight,
      labelRaisedHeight,
    );

  const printVolume = {
    x: profile.buildVolume.x - limits.buildMargins.x * 2,
    y: profile.buildVolume.z - limits.buildMargins.z * 2,
    z: Math.min(
      profile.buildVolume.y - limits.buildMargins.y * 2,
      limits.maximumModelHeight,
    ),
  };
  if (
    baseWidth > printVolume.x + EPSILON ||
    baseDepth > printVolume.y + EPSILON ||
    totalHeight > printVolume.z + EPSILON
  ) {
    throw new PrintGeometryValidationError([
      `Dependency connector comparison needs ${mm(baseWidth)} x ${mm(baseDepth)} x ${mm(totalHeight)} mm but profile '${profile.id}' provides ${mm(printVolume.x)} x ${mm(printVolume.y)} x ${mm(printVolume.z)} mm.`,
    ]);
  }

  const baseChannel = channelAt(profile, 0);
  const integratedChannel = channelAt(profile, 1);
  const integratedLabelChannel = channelAt(profile, 2);
  const socketChannel = channelAt(profile, 3);
  const socketLabelChannel = channelAt(profile, 4);
  const base = primitive(
    "comparison:base",
    "base",
    "comparison-base",
    baseChannel,
    box(0, 0, 0, baseWidth, baseDepth, baseThickness),
  );
  const integratedX = margin;
  const detachableX = integratedX + cellWidth + cellGap;
  const cellY = margin;
  const cellTop = baseThickness + cellHeight;
  const integratedCell = primitive(
    "comparison:cell:integrated",
    "comparison-cell",
    "integrated-cell",
    baseChannel,
    box(
      integratedX,
      cellY,
      baseThickness,
      cellWidth,
      cellDepth,
      cellHeight,
    ),
  );
  const detachableCell = primitive(
    "comparison:cell:detachable",
    "comparison-cell",
    "detachable-cell",
    baseChannel,
    box(
      detachableX,
      cellY,
      baseThickness,
      cellWidth,
      cellDepth,
      cellHeight,
    ),
  );

  const diagramY =
    cellY + padding + (diagramDepth - endpointDepth) / 2;
  const consumerX = integratedX + padding;
  const providerX =
    integratedX + cellWidth - padding - endpointWidth;
  const consumer = primitive(
    "comparison:integrated:consumer",
    "dependency-endpoint",
    "integrated-connector",
    integratedChannel,
    box(
      consumerX,
      diagramY,
      cellTop,
      endpointWidth,
      endpointDepth,
      endpointHeight,
    ),
  );
  const provider = primitive(
    "comparison:integrated:provider",
    "dependency-endpoint",
    "integrated-connector",
    integratedChannel,
    box(
      providerX,
      diagramY,
      cellTop,
      endpointWidth,
      endpointDepth,
      endpointHeight,
    ),
  );
  const arrowStepLength = padding;
  const arrowStart = providerX - 3 * arrowStepLength;
  const traceY = diagramY + (endpointDepth - routeWidth) / 2;
  const trace = primitive(
    "comparison:integrated:trace",
    "dependency-trace",
    "integrated-connector",
    integratedChannel,
    box(
      consumerX + endpointWidth,
      traceY,
      cellTop,
      arrowStart - (consumerX + endpointWidth),
      routeWidth,
      routeHeight,
    ),
  );
  const arrow = [5, 3, 1].map((width, index) =>
    primitive(
      `comparison:integrated:arrow:${index + 1}`,
      "dependency-trace",
      "integrated-connector",
      integratedChannel,
      box(
        arrowStart + index * arrowStepLength,
        diagramY + (endpointDepth - width * routeWidth) / 2,
        cellTop,
        arrowStepLength,
        width * routeWidth,
        routeHeight,
      ),
    ),
  );

  const socketY =
    cellY + padding + (diagramDepth - socketOuterDepth) / 2;
  const socketXs = [
    detachableX + padding,
    detachableX + cellWidth - padding - socketLength,
  ] as const;
  const sockets = socketXs.flatMap((socketX, index) => [
    primitive(
      `comparison:detachable:socket:${index + 1}:floor`,
      "dependency-socket",
      "detachable-connector",
      socketChannel,
      box(
        socketX,
        socketY,
        cellTop,
        socketLength,
        socketOuterDepth,
        feature,
      ),
    ),
    primitive(
      `comparison:detachable:socket:${index + 1}:wall-a`,
      "dependency-socket",
      "detachable-connector",
      socketChannel,
      box(
        socketX,
        socketY,
        cellTop + feature,
        socketLength,
        feature,
        2 * feature,
      ),
    ),
    primitive(
      `comparison:detachable:socket:${index + 1}:wall-b`,
      "dependency-socket",
      "detachable-connector",
      socketChannel,
      box(
        socketX,
        socketY + feature + socketOpeningWidth,
        cellTop + feature,
        socketLength,
        feature,
        2 * feature,
      ),
    ),
  ]);

  const labelY = cellY + padding + diagramDepth + padding;
  const integratedLabel = textPrimitive(
    "comparison:label:integrated",
    "integrated-label",
    integratedLabelChannel,
    labels[0],
    labelFeature,
    labelRaisedHeight,
    { x: integratedX + padding, y: labelY, z: cellTop },
  );
  const detachableLabel = textPrimitive(
    "comparison:label:detachable",
    "detachable-label",
    socketLabelChannel,
    labels[1],
    labelFeature,
    labelRaisedHeight,
    { x: detachableX + padding, y: labelY, z: cellTop },
  );

  const primitives = [
    base,
    integratedCell,
    detachableCell,
    consumer,
    trace,
    ...arrow,
    provider,
    ...sockets,
    integratedLabel,
    detachableLabel,
  ];
  const comparisonParts = parts(profile, primitives);
  const measuredGap = minimumPositiveHorizontalGap(primitives, EPSILON);
  const printable: PrintableCity = {
    application: { name: "Code City", version: CODE_CITY_VERSION },
    profileId: profile.id,
    title: "Dependency Connector Comparison",
    version: DEPENDENCY_CONNECTOR_DECISION,
    unit: "millimeter",
    scale: 1,
    bounds: box(0, 0, 0, baseWidth, baseDepth, totalHeight),
    measurements: {
      baseThickness,
      wallThickness: feature,
      minimumFeatureSize: feature,
      minimumGap: measuredGap,
    },
    parts: comparisonParts,
  };
  const issues = validatePrintableCity(printable, profile);
  if (issues.length > 0) {
    throw new PrintGeometryValidationError(issues);
  }
  const measurements: DependencyConnectorComparisonMeasurements = {
    featureSize: feature,
    labelFeatureSize: labelFeature,
    baseThickness,
    traceWidth: routeWidth,
    traceHeight: routeHeight,
    clearance,
    socketWallThickness: feature,
    nominalConnectorWidth,
    socketOpeningWidth,
    footprint: {
      width: baseWidth,
      depth: baseDepth,
      height: totalHeight,
    },
  };
  return {
    printable,
    measurements,
    decision: DEPENDENCY_CONNECTOR_DECISION,
    instructions: instructions(profile, measurements),
  };
}
