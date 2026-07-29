import type {
  CityBuilding,
  CityDistrict,
  CityIdentityPanel,
  CityModel,
  SemanticGroup,
  Vector3,
} from "../../core/src/model.js";
import {
  assignBuildingPrintCodes,
  assignDistrictPrintCodes,
  type PhysicalPrintStatus,
  type PrintLabelPolicy,
  type PrintLegend,
} from "../../core/src/print-labels.js";
import { normalizeRepositoryRelativePath } from "../../core/src/path.js";
import type { PrinterProfile } from "../../core/src/print.js";

import {
  PrintGeometryValidationError,
  validatePrintableCity,
} from "./validate.js";
import {
  printableTextCells,
  printableTextSupported,
  printableTextWidth,
  validatePrintableText,
} from "./printable-font.js";
import { minimumPositiveHorizontalGap } from "./spatial.js";

export interface PrintPoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface PrintTriangle {
  readonly a: number;
  readonly b: number;
  readonly c: number;
}

export interface PrintMesh {
  readonly vertices: readonly PrintPoint[];
  readonly triangles: readonly PrintTriangle[];
}

export interface PrintBounds {
  readonly minimum: PrintPoint;
  readonly maximum: PrintPoint;
  readonly size: PrintPoint;
}

export type PrintPrimitiveKind =
  | "base"
  | "district"
  | "building"
  | "building-label"
  | "district-label"
  | "comparison-cell"
  | "comparison-label"
  | "dependency-endpoint"
  | "dependency-trace"
  | "dependency-socket"
  | "identity-panel"
  | "identity-relief";

export interface PrintPrimitive {
  readonly id: string;
  readonly kind: PrintPrimitiveKind;
  readonly semanticGroupId: string;
  readonly channelId: string;
  readonly mesh: PrintMesh;
  readonly bounds: PrintBounds;
}

export interface PrintPart {
  readonly id: string;
  readonly channelId: string;
  readonly name: string;
  readonly displayColor: string;
  readonly semanticGroupIds: readonly string[];
  readonly primitives: readonly PrintPrimitive[];
  readonly mesh: PrintMesh;
}

export interface PrintableCity {
  readonly application: {
    readonly name: string;
    readonly version: string;
  };
  readonly profileId: string;
  readonly title: string;
  readonly version?: string;
  readonly unit: "millimeter";
  readonly scale: number;
  readonly bounds: PrintBounds;
  readonly measurements: {
    readonly baseThickness: number;
    readonly wallThickness: number;
    readonly minimumFeatureSize: number;
    readonly minimumGap: number | null;
  };
  readonly parts: readonly PrintPart[];
}

export interface PrintSemanticAssignment {
  readonly semanticGroupId: string;
  readonly channelId: string;
}

export interface BuildPrintableCityOptions {
  readonly scale: number;
  readonly profile: PrinterProfile;
  readonly labelPolicy?: PrintLabelPolicy;
}

export interface PrintLabelReport {
  readonly printedBuildings: number;
  readonly skippedBuildings: number;
  readonly printedDistricts: number;
  readonly skippedDistricts: number;
}

export interface PrintableCityArtifacts {
  readonly city: PrintableCity;
  readonly legend: PrintLegend;
  readonly labels: PrintLabelReport;
}

export interface PrintablePlanGeometry {
  readonly bounds: Vector3;
  readonly identityPanel?: CityIdentityPanel;
}

interface CityBox {
  readonly minimum: Vector3;
  readonly maximum: Vector3;
}

interface CoordinateTransform {
  readonly scale: number;
  readonly origin: Vector3;
}

interface PlaqueLayout {
  readonly body: PrintBounds;
  readonly reliefDepth: number;
  readonly featureSize: number;
  readonly margin: number;
  readonly iconWidth: number;
  readonly contentGap: number;
  readonly lineGap: number;
  readonly titleWidth: number;
  readonly versionWidth: number;
}

const KIND_ORDER: Readonly<Record<PrintPrimitiveKind, number>> = Object.freeze({
  base: 0,
  district: 1,
  building: 2,
  "building-label": 3,
  "district-label": 4,
  "comparison-cell": 5,
  "comparison-label": 6,
  "dependency-endpoint": 7,
  "dependency-trace": 8,
  "dependency-socket": 9,
  "identity-panel": 10,
  "identity-relief": 11,
});

const MINIMUM_DEMO_RELIEF_FEATURE = 0.8;
const EPSILON = 1e-9;

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function finitePositive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number.`);
  }
  return value;
}

function cityBox(position: Vector3, size: Vector3): CityBox {
  return {
    minimum: {
      x: position.x - size.x / 2,
      y: position.y - size.y / 2,
      z: position.z - size.z / 2,
    },
    maximum: {
      x: position.x + size.x / 2,
      y: position.y + size.y / 2,
      z: position.z + size.z / 2,
    },
  };
}

function printBoundsFromCityBox(
  box: CityBox,
  transform: CoordinateTransform,
): PrintBounds {
  const minimum = {
    x: (box.minimum.x - transform.origin.x) * transform.scale,
    y: (box.minimum.z - transform.origin.z) * transform.scale,
    z: (box.minimum.y - transform.origin.y) * transform.scale,
  };
  const maximum = {
    x: (box.maximum.x - transform.origin.x) * transform.scale,
    y: (box.maximum.z - transform.origin.z) * transform.scale,
    z: (box.maximum.y - transform.origin.y) * transform.scale,
  };
  return bounds(minimum, maximum);
}

function bounds(minimum: PrintPoint, maximum: PrintPoint): PrintBounds {
  return {
    minimum: { ...minimum },
    maximum: { ...maximum },
    size: {
      x: maximum.x - minimum.x,
      y: maximum.y - minimum.y,
      z: maximum.z - minimum.z,
    },
  };
}

/**
 * Creates one closed, outward-wound cuboid. Vertex and triangle order are part
 * of the deterministic exporter contract.
 */
export function cuboidMesh(box: PrintBounds): PrintMesh {
  const { minimum, maximum } = box;
  finitePositive(maximum.x - minimum.x, "Cuboid X size");
  finitePositive(maximum.y - minimum.y, "Cuboid Y size");
  finitePositive(maximum.z - minimum.z, "Cuboid Z size");

  const vertices: readonly PrintPoint[] = [
    { x: minimum.x, y: minimum.y, z: minimum.z },
    { x: maximum.x, y: minimum.y, z: minimum.z },
    { x: maximum.x, y: maximum.y, z: minimum.z },
    { x: minimum.x, y: maximum.y, z: minimum.z },
    { x: minimum.x, y: minimum.y, z: maximum.z },
    { x: maximum.x, y: minimum.y, z: maximum.z },
    { x: maximum.x, y: maximum.y, z: maximum.z },
    { x: minimum.x, y: maximum.y, z: maximum.z },
  ];
  const triangles: readonly PrintTriangle[] = [
    { a: 0, b: 2, c: 1 },
    { a: 0, b: 3, c: 2 },
    { a: 4, b: 5, c: 6 },
    { a: 4, b: 6, c: 7 },
    { a: 0, b: 1, c: 5 },
    { a: 0, b: 5, c: 4 },
    { a: 3, b: 7, c: 6 },
    { a: 3, b: 6, c: 2 },
    { a: 0, b: 4, c: 7 },
    { a: 0, b: 7, c: 3 },
    { a: 1, b: 2, c: 6 },
    { a: 1, b: 6, c: 5 },
  ];
  return { vertices, triangles };
}

function primitive(
  id: string,
  kind: PrintPrimitiveKind,
  semanticGroupId: string,
  channelId: string,
  primitiveBounds: PrintBounds,
): PrintPrimitive {
  return {
    id,
    kind,
    semanticGroupId,
    channelId,
    bounds: primitiveBounds,
    mesh: cuboidMesh(primitiveBounds),
  };
}

function concatenateMeshes(
  meshes: readonly PrintMesh[],
): PrintMesh {
  const vertices: PrintPoint[] = [];
  const triangles: PrintTriangle[] = [];
  for (const mesh of meshes) {
    const offset = vertices.length;
    vertices.push(...mesh.vertices.map((vertex) => ({ ...vertex })));
    triangles.push(
      ...mesh.triangles.map((triangle) => ({
        a: triangle.a + offset,
        b: triangle.b + offset,
        c: triangle.c + offset,
      })),
    );
  }
  return { vertices, triangles };
}

function measuredMeshBounds(mesh: PrintMesh): PrintBounds {
  if (mesh.vertices.length === 0) {
    throw new PrintGeometryValidationError([
      "Printable text must contain at least one solid glyph cell.",
    ]);
  }
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
  return bounds(minimum, maximum);
}

function compositePrimitive(
  id: string,
  kind: PrintPrimitiveKind,
  semanticGroupId: string,
  channelId: string,
  meshes: readonly PrintMesh[],
): PrintPrimitive {
  const mesh = concatenateMeshes(meshes);
  return {
    id,
    kind,
    semanticGroupId,
    channelId,
    mesh,
    bounds: measuredMeshBounds(mesh),
  };
}

function measuredBounds(
  primitives: readonly PrintPrimitive[],
): PrintBounds {
  if (primitives.length === 0) {
    throw new PrintGeometryValidationError([
      "Printable city must contain at least one primitive.",
    ]);
  }
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
  for (const item of primitives) {
    minimum.x = Math.min(minimum.x, item.bounds.minimum.x);
    minimum.y = Math.min(minimum.y, item.bounds.minimum.y);
    minimum.z = Math.min(minimum.z, item.bounds.minimum.z);
    maximum.x = Math.max(maximum.x, item.bounds.maximum.x);
    maximum.y = Math.max(maximum.y, item.bounds.maximum.y);
    maximum.z = Math.max(maximum.z, item.bounds.maximum.z);
  }
  return bounds(minimum, maximum);
}

function minimumPrimitiveFeature(
  primitives: readonly PrintPrimitive[],
): number {
  return Math.min(
    ...primitives.flatMap(({ bounds: item }) => [
      item.size.x,
      item.size.y,
      item.size.z,
    ]),
  );
}

function intervalGap(
  leftMinimum: number,
  leftMaximum: number,
  rightMinimum: number,
  rightMaximum: number,
): number {
  return Math.max(
    0,
    Math.max(leftMinimum, rightMinimum) -
      Math.min(leftMaximum, rightMaximum),
  );
}

function minimumHorizontalGap(
  primitives: readonly PrintPrimitive[],
): number | null {
  return minimumPositiveHorizontalGap(primitives, EPSILON);
}

function semanticChannelMap(
  model: CityModel,
  assignments: readonly PrintSemanticAssignment[],
  profile: PrinterProfile,
): ReadonlyMap<string, string> {
  const semanticIds = new Set(model.semanticGroups.map(({ id }) => id));
  const channelIds = new Set(profile.printChannels.map(({ id }) => id));
  const result = new Map<string, string>();
  for (const assignment of assignments) {
    if (!semanticIds.has(assignment.semanticGroupId)) {
      throw new TypeError(
        `Print assignment references unknown semantic group '${assignment.semanticGroupId}'.`,
      );
    }
    if (!channelIds.has(assignment.channelId)) {
      throw new TypeError(
        `Print assignment references unknown channel '${assignment.channelId}'.`,
      );
    }
    if (result.has(assignment.semanticGroupId)) {
      throw new TypeError(
        `Duplicate print assignment for semantic group '${assignment.semanticGroupId}'.`,
      );
    }
    result.set(assignment.semanticGroupId, assignment.channelId);
  }
  return result;
}

function requiredChannel(
  channels: ReadonlyMap<string, string>,
  semanticGroupId: string,
): string {
  const channelId = channels.get(semanticGroupId);
  if (!channelId) {
    throw new TypeError(
      `Missing print assignment for semantic group '${semanticGroupId}'.`,
    );
  }
  return channelId;
}

function primitiveOrder(
  left: PrintPrimitive,
  right: PrintPrimitive,
): number {
  return (
    KIND_ORDER[left.kind] - KIND_ORDER[right.kind] ||
    compare(left.id, right.id)
  );
}

function rankedSemanticColor(
  semanticGroupIds: readonly string[],
  groupsById: ReadonlyMap<string, SemanticGroup>,
): string {
  return (
    semanticGroupIds
      .map((id) => groupsById.get(id))
      .filter((group): group is SemanticGroup => group !== undefined)
      .sort(
        (left, right) =>
          right.priority - left.priority || compare(left.id, right.id),
      )[0]?.color ?? "#808080"
  );
}

function createParts(
  primitives: readonly PrintPrimitive[],
  model: CityModel,
  profile: PrinterProfile,
): readonly PrintPart[] {
  const byChannel = new Map<string, PrintPrimitive[]>();
  for (const item of primitives) {
    const channelPrimitives = byChannel.get(item.channelId) ?? [];
    channelPrimitives.push(item);
    byChannel.set(item.channelId, channelPrimitives);
  }
  const groupsById = new Map(
    model.semanticGroups.map((group) => [group.id, group]),
  );
  return profile.printChannels
    .filter((channel) => byChannel.has(channel.id))
    .map((channel): PrintPart => {
      const channelPrimitives = [...(byChannel.get(channel.id) ?? [])].sort(
        primitiveOrder,
      );
      const semanticGroupIds = [
        ...new Set(
          channelPrimitives.map(({ semanticGroupId }) => semanticGroupId),
        ),
      ].sort(compare);
      return {
        id: `channel:${channel.id}`,
        channelId: channel.id,
        name: channel.label,
        displayColor:
          channel.color ??
          rankedSemanticColor(semanticGroupIds, groupsById),
        semanticGroupIds,
        primitives: channelPrimitives,
        mesh: concatenateMeshes(
          channelPrimitives.map(({ mesh }) => mesh),
        ),
      };
    });
}

export type RoofTextOrientation = "horizontal" | "vertical";

interface RoofTextPlacement {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly depth: number;
  readonly orientation: RoofTextOrientation;
}

interface LabelBuildResult {
  readonly status: PhysicalPrintStatus;
  readonly primitive?: PrintPrimitive;
}

interface GridCell {
  readonly x: number;
  readonly y: number;
}

function labelFeatureSize(profile: PrinterProfile): number {
  return Math.max(
    MINIMUM_DEMO_RELIEF_FEATURE,
    profile.geometryLimits.minimumFeatureSize,
    profile.geometryLimits.minimumWallThickness,
    profile.geometryLimits.minimumGap,
  );
}

function textFootprint(
  text: string,
  featureSize: number,
  orientation: RoofTextOrientation,
): Pick<RoofTextPlacement, "width" | "depth"> {
  const textWidth = printableTextWidth(text, featureSize);
  const textHeight = featureSize * 5;
  return orientation === "horizontal"
    ? { width: textWidth, depth: textHeight }
    : { width: textHeight, depth: textWidth };
}

function gridCellKey(x: number, y: number): string {
  return `${x}:${y}`;
}

function connectedGridComponents(
  cells: readonly GridCell[],
): readonly (readonly GridCell[])[] {
  const byKey = new Map(
    cells.map((cell) => [gridCellKey(cell.x, cell.y), cell]),
  );
  const visited = new Set<string>();
  const result: GridCell[][] = [];
  for (const first of [...cells].sort(
    (left, right) => left.y - right.y || left.x - right.x,
  )) {
    const firstKey = gridCellKey(first.x, first.y);
    if (visited.has(firstKey)) continue;
    const component: GridCell[] = [];
    const queue = [first];
    visited.add(firstKey);
    while (queue.length > 0) {
      const current = queue.shift()!;
      component.push(current);
      for (const [x, y] of [
        [current.x - 1, current.y],
        [current.x + 1, current.y],
        [current.x, current.y - 1],
        [current.x, current.y + 1],
      ] as const) {
        const key = gridCellKey(x, y);
        const adjacent = byKey.get(key);
        if (!adjacent || visited.has(key)) continue;
        visited.add(key);
        queue.push(adjacent);
      }
    }
    result.push(
      component.sort(
        (left, right) => left.y - right.y || left.x - right.x,
      ),
    );
  }
  return result;
}

function glyphComponentMesh(
  component: readonly GridCell[],
  featureSize: number,
  roofZ: number,
  placement: RoofTextPlacement,
): PrintMesh {
  const occupied = new Set(
    component.map(({ x, y }) => gridCellKey(x, y)),
  );
  const vertices: PrintPoint[] = [];
  const triangles: PrintTriangle[] = [];
  const vertexIndices = new Map<string, number>();
  const vertex = (x: number, y: number, z: number): number => {
    const key = `${x}:${y}:${z}`;
    const existing = vertexIndices.get(key);
    if (existing !== undefined) return existing;
    const index = vertices.length;
    vertexIndices.set(key, index);
    vertices.push({
      x: placement.x + x * featureSize,
      y: placement.y + y * featureSize,
      z: roofZ + z * featureSize,
    });
    return index;
  };
  const face = (
    points: readonly [
      readonly [number, number, number],
      readonly [number, number, number],
      readonly [number, number, number],
      readonly [number, number, number],
    ],
  ): void => {
    const [a, b, c, d] = points.map(([x, y, z]) => vertex(x, y, z));
    triangles.push({ a: a!, b: b!, c: c! }, { a: a!, b: c!, c: d! });
  };
  for (const { x, y } of component) {
    if (!occupied.has(gridCellKey(x - 1, y))) {
      face([
        [x, y, 0],
        [x, y, 1],
        [x, y + 1, 1],
        [x, y + 1, 0],
      ]);
    }
    if (!occupied.has(gridCellKey(x + 1, y))) {
      face([
        [x + 1, y, 0],
        [x + 1, y + 1, 0],
        [x + 1, y + 1, 1],
        [x + 1, y, 1],
      ]);
    }
    if (!occupied.has(gridCellKey(x, y - 1))) {
      face([
        [x, y, 0],
        [x + 1, y, 0],
        [x + 1, y, 1],
        [x, y, 1],
      ]);
    }
    if (!occupied.has(gridCellKey(x, y + 1))) {
      face([
        [x, y + 1, 0],
        [x, y + 1, 1],
        [x + 1, y + 1, 1],
        [x + 1, y + 1, 0],
      ]);
    }
    face([
      [x, y, 0],
      [x, y + 1, 0],
      [x + 1, y + 1, 0],
      [x + 1, y, 0],
    ]);
    face([
      [x, y, 1],
      [x + 1, y, 1],
      [x + 1, y + 1, 1],
      [x, y + 1, 1],
    ]);
  }
  return { vertices, triangles };
}

/**
 * Builds raised block text on a horizontal surface. Adjacent glyph cells are
 * unioned into face-clean components, so the mesh has no coincident internal
 * faces while disconnected strokes remain independent watertight shells.
 */
export function raisedPrintableTextMesh(
  text: string,
  featureSize: number,
  origin: PrintPoint,
  orientation: RoofTextOrientation = "horizontal",
): PrintMesh {
  finitePositive(featureSize, "Printable text feature size");
  validatePrintableText(text);
  const footprint = textFootprint(text, featureSize, orientation);
  const placement: RoofTextPlacement = {
    x: origin.x,
    y: origin.y,
    ...footprint,
    orientation,
  };
  const cells = printableTextCells(text, featureSize);
  if (cells.length === 0) {
    throw new PrintGeometryValidationError([
      "Printable text must contain at least one solid glyph cell.",
    ]);
  }
  const gridCells = cells.map((cell): GridCell => ({
    x: Math.round(
      (orientation === "horizontal" ? cell.u : cell.v) /
        featureSize,
    ),
    y: Math.round(
      (orientation === "horizontal" ? cell.v : cell.u) /
        featureSize,
    ),
  }));
  return concatenateMeshes(
    connectedGridComponents(gridCells).map((component) =>
      glyphComponentMesh(
        component,
        featureSize,
        origin.z,
        placement,
      ),
    ),
  );
}

function roofTextPrimitive(
  id: string,
  kind: "building-label" | "district-label",
  semanticGroupId: string,
  channelId: string,
  text: string,
  featureSize: number,
  roofZ: number,
  placement: RoofTextPlacement,
): PrintPrimitive {
  return compositePrimitive(
    id,
    kind,
    semanticGroupId,
    channelId,
    [
      raisedPrintableTextMesh(
        text,
        featureSize,
        {
          x: placement.x,
          y: placement.y,
          z: roofZ,
        },
        placement.orientation,
      ),
    ],
  );
}

function centeredRoofPlacement(
  roof: PrintBounds,
  text: string,
  featureSize: number,
): RoofTextPlacement | undefined {
  for (const orientation of ["horizontal", "vertical"] as const) {
    const footprint = textFootprint(text, featureSize, orientation);
    if (
      footprint.width <= roof.size.x + EPSILON &&
      footprint.depth <= roof.size.y + EPSILON
    ) {
      return {
        x:
          roof.minimum.x +
          (roof.size.x - footprint.width) / 2,
        y:
          roof.minimum.y +
          (roof.size.y - footprint.depth) / 2,
        ...footprint,
        orientation,
      };
    }
  }
  return undefined;
}

function districtRoofPlacements(
  roof: PrintBounds,
  text: string,
  featureSize: number,
): readonly RoofTextPlacement[] {
  const result: RoofTextPlacement[] = [];
  for (const orientation of ["horizontal", "vertical"] as const) {
    const footprint = textFootprint(text, featureSize, orientation);
    if (
      footprint.width > roof.size.x + EPSILON ||
      footprint.depth > roof.size.y + EPSILON
    ) {
      continue;
    }
    const minimumX = roof.minimum.x;
    const maximumX = roof.maximum.x - footprint.width;
    const middleX = (minimumX + maximumX) / 2;
    const minimumY = roof.minimum.y;
    const maximumY = roof.maximum.y - footprint.depth;
    const middleY = (minimumY + maximumY) / 2;
    const ordered = [
      [middleX, minimumY],
      [minimumX, minimumY],
      [maximumX, minimumY],
      [middleX, maximumY],
      [minimumX, maximumY],
      [maximumX, maximumY],
      [minimumX, middleY],
      [maximumX, middleY],
      [middleX, middleY],
    ] as const;
    for (const [x, y] of ordered) {
      result.push({ x, y, ...footprint, orientation });
    }
  }
  return result.filter(
    (placement, index) =>
      result.findIndex(
        (candidate) =>
          candidate.orientation === placement.orientation &&
          Math.abs(candidate.x - placement.x) <= EPSILON &&
          Math.abs(candidate.y - placement.y) <= EPSILON,
      ) === index,
  );
}

function placementClearOfBuildings(
  placement: RoofTextPlacement,
  buildings: readonly PrintBounds[],
  minimumGap: number,
): boolean {
  const maximumX = placement.x + placement.width;
  const maximumY = placement.y + placement.depth;
  return buildings.every((building) => {
    const xGap = intervalGap(
      placement.x,
      maximumX,
      building.minimum.x,
      building.maximum.x,
    );
    const yGap = intervalGap(
      placement.y,
      maximumY,
      building.minimum.y,
      building.maximum.y,
    );
    return Math.hypot(xGap, yGap) + EPSILON >= minimumGap;
  });
}

function buildingLabel(
  building: CityBuilding,
  roof: PrintBounds,
  code: string,
  channelId: string,
  policy: PrintLabelPolicy,
  profile: PrinterProfile,
): LabelBuildResult {
  if (policy === "off") {
    return { status: { status: "skipped", reason: "policy-off" } };
  }
  const featureSize = labelFeatureSize(profile);
  if (
    roof.maximum.z + featureSize >
    profile.buildVolume.y + EPSILON
  ) {
    return {
      status: { status: "skipped", reason: "build-volume-height" },
    };
  }
  const placement = centeredRoofPlacement(roof, code, featureSize);
  if (!placement) {
    return { status: { status: "skipped", reason: "roof-too-small" } };
  }
  return {
    status: { status: "printed", text: code, mode: "code" },
    primitive: roofTextPrimitive(
      `building-label:${building.id}`,
      "building-label",
      building.semanticGroupId,
      channelId,
      code,
      featureSize,
      roof.maximum.z,
      placement,
    ),
  };
}

function districtLabel(
  district: CityDistrict,
  roof: PrintBounds,
  code: string,
  occupied: readonly PrintBounds[],
  channelId: string,
  policy: PrintLabelPolicy,
  profile: PrinterProfile,
): LabelBuildResult {
  if (policy === "off") {
    return { status: { status: "skipped", reason: "policy-off" } };
  }
  const featureSize = labelFeatureSize(profile);
  if (
    roof.maximum.z + featureSize >
    profile.buildVolume.y + EPSILON
  ) {
    return {
      status: { status: "skipped", reason: "build-volume-height" },
    };
  }
  const name = district.name
    .normalize("NFC")
    .trim()
    .replace(/\s+/gu, " ")
    .toUpperCase();
  const candidates = [
    ...(name !== "" && printableTextSupported(name)
      ? [{ text: name, mode: "name" as const }]
      : []),
    { text: code, mode: "code" as const },
  ];
  for (const candidate of candidates) {
    const placement = districtRoofPlacements(
      roof,
      candidate.text,
      featureSize,
    ).find((item) =>
      placementClearOfBuildings(
        item,
        occupied,
        profile.geometryLimits.minimumGap,
      ),
    );
    if (!placement) continue;
    return {
      status: {
        status: "printed",
        text: candidate.text,
        mode: candidate.mode,
      },
      primitive: roofTextPrimitive(
        `district-label:${district.id}`,
        "district-label",
        "base",
        channelId,
        candidate.text,
        featureSize,
        roof.maximum.z,
        placement,
      ),
    };
  }
  return {
    status: { status: "skipped", reason: "ground-space-unavailable" },
  };
}

function requiredStatus(
  statuses: ReadonlyMap<string, PhysicalPrintStatus>,
  id: string,
): PhysicalPrintStatus {
  const status = statuses.get(id);
  if (!status) {
    throw new Error(`Missing physical print status for '${id}'.`);
  }
  return status;
}

function printLegend(
  model: CityModel,
  profile: PrinterProfile,
  title: string,
  policy: PrintLabelPolicy,
  buildingCodes: ReadonlyMap<string, string>,
  districtCodes: ReadonlyMap<string, string>,
  buildingStatuses: ReadonlyMap<string, PhysicalPrintStatus>,
  districtStatuses: ReadonlyMap<string, PhysicalPrintStatus>,
): PrintLegend {
  const repositories = new Map(
    model.repositories.map((repository) => [repository.id, repository]),
  );
  const districts = new Map(
    model.districts.map((district) => [district.id, district]),
  );
  return {
    schemaVersion: "1.0",
    title,
    profileId: profile.id,
    labelPolicy: policy,
    districts: [...model.districts]
      .sort((left, right) =>
        compare(
          districtCodes.get(left.id)!,
          districtCodes.get(right.id)!,
        ),
      )
      .map((district) => ({
        code: districtCodes.get(district.id)!,
        repositoryId: district.repositoryId,
        repositoryName: repositories.get(district.repositoryId)!.name,
        districtId: district.id,
        districtName: district.name,
        path: normalizeRepositoryRelativePath(district.path),
        physicalPrint: requiredStatus(districtStatuses, district.id),
      })),
    buildings: [...model.buildings]
      .sort((left, right) =>
        compare(
          buildingCodes.get(left.id)!,
          buildingCodes.get(right.id)!,
        ),
      )
      .map((building) => {
        const district = districts.get(building.districtId)!;
        return {
          code: buildingCodes.get(building.id)!,
          repositoryId: building.repositoryId,
          repositoryName: repositories.get(building.repositoryId)!.name,
          districtId: building.districtId,
          districtName: district.name,
          buildingId: building.id,
          buildingName: building.name,
          path: normalizeRepositoryRelativePath(building.path),
          physicalPrint: requiredStatus(buildingStatuses, building.id),
        };
      }),
  };
}

function plaqueLayout(
  model: CityModel,
  transform: CoordinateTransform,
  baseBounds: PrintBounds,
  featureSize: number,
  title: string,
  version: string,
): PlaqueLayout {
  const panel = model.identityPanel!;
  const margin = featureSize * 2;
  const contentGap = featureSize * 2;
  const lineGap = featureSize * 2;
  const iconWidth = featureSize * 8;
  const titleWidth = printableTextWidth(title, featureSize);
  const versionWidth = printableTextWidth(version, featureSize);
  const textBlockWidth = Math.max(titleWidth, versionWidth);
  const requiredWidth =
    margin * 2 + iconWidth + contentGap + textBlockWidth;
  const requiredHeight =
    margin * 2 + featureSize * 5 * 2 + lineGap;
  const availableWidth = baseBounds.size.x - featureSize * 2;
  if (requiredWidth > availableWidth + EPSILON) {
    throw new PrintGeometryValidationError([
      `Identity plaque needs ${requiredWidth.toFixed(3)} mm but only ${availableWidth.toFixed(3)} mm are available.`,
    ]);
  }

  const panelWidth = Math.max(panel.size.x * transform.scale, requiredWidth);
  const panelHeight = Math.max(panel.size.y * transform.scale, requiredHeight);
  const panelDepth = Math.max(
    panel.size.z * transform.scale,
    featureSize,
  );
  const reliefDepth = Math.max(
    panel.reliefDepth * transform.scale,
    featureSize,
  );
  const centerX =
    (panel.position.x - transform.origin.x) * transform.scale;
  const minimumX = centerX - panelWidth / 2;
  const maximumX = centerX + panelWidth / 2;
  if (
    minimumX < baseBounds.minimum.x - EPSILON ||
    maximumX > baseBounds.maximum.x + EPSILON
  ) {
    throw new PrintGeometryValidationError([
      "Identity plaque does not fit inside the shared base width.",
    ]);
  }
  const body = bounds(
    {
      x: minimumX,
      y: baseBounds.minimum.y + reliefDepth,
      z: baseBounds.maximum.z,
    },
    {
      x: maximumX,
      y: baseBounds.minimum.y + reliefDepth + panelDepth,
      z: baseBounds.maximum.z + panelHeight,
    },
  );
  if (body.maximum.y > baseBounds.maximum.y + EPSILON) {
    throw new PrintGeometryValidationError([
      "Identity plaque does not fit inside the shared base depth.",
    ]);
  }
  return {
    body,
    reliefDepth,
    featureSize,
    margin,
    iconWidth,
    contentGap,
    lineGap,
    titleWidth,
    versionWidth,
  };
}

function textReliefPrimitives(
  text: string,
  line: "title" | "version",
  startX: number,
  bottomZ: number,
  layout: PlaqueLayout,
  semanticGroupId: string,
  channelId: string,
): readonly PrintPrimitive[] {
  return printableTextCells(text, layout.featureSize).map((cell) => {
    const minimum = {
      x: startX + cell.u,
      y: layout.body.minimum.y - layout.reliefDepth,
      z: bottomZ + cell.v,
    };
    return primitive(
      `identity-relief:${line}:${cell.characterIndex}:${cell.row}:${cell.column}`,
      "identity-relief",
      semanticGroupId,
      channelId,
      bounds(minimum, {
        x: minimum.x + layout.featureSize,
        y: minimum.y + layout.reliefDepth,
        z: minimum.z + layout.featureSize,
      }),
    );
  });
}

function skylineReliefPrimitives(
  layout: PlaqueLayout,
  semanticGroupId: string,
  channelId: string,
): readonly PrintPrimitive[] {
  const widths = [2, 2, 2] as const;
  const heights = [5, 8, 6] as const;
  const totalWidth =
    widths.reduce((sum, width) => sum + width, 0) *
      layout.featureSize +
    (widths.length - 1) * layout.featureSize;
  let cursorX =
    layout.body.minimum.x +
    layout.margin +
    (layout.iconWidth - totalWidth) / 2;
  const bottomZ =
    layout.body.minimum.z +
    (layout.body.size.z - heights[1] * layout.featureSize) / 2;
  return widths.map((width, index) => {
    const minimum = {
      x: cursorX,
      y: layout.body.minimum.y - layout.reliefDepth,
      z: bottomZ,
    };
    const item = primitive(
      `identity-relief:skyline:${index}`,
      "identity-relief",
      semanticGroupId,
      channelId,
      bounds(minimum, {
        x: minimum.x + width * layout.featureSize,
        y: minimum.y + layout.reliefDepth,
        z: minimum.z + heights[index]! * layout.featureSize,
      }),
    );
    cursorX += (width + 1) * layout.featureSize;
    return item;
  });
}

function identityPrimitives(
  model: CityModel,
  transform: CoordinateTransform,
  baseBounds: PrintBounds,
  semanticChannels: ReadonlyMap<string, string>,
  profile: PrinterProfile,
  title: string,
  version: string | undefined,
): readonly PrintPrimitive[] {
  const panel = model.identityPanel;
  if (!panel) return [];
  const semanticGroupId = panel.semanticGroupId;
  const channelId = requiredChannel(semanticChannels, semanticGroupId);
  const featureSize = Math.max(
    MINIMUM_DEMO_RELIEF_FEATURE,
    profile.geometryLimits.minimumFeatureSize,
  );
  const printableTitle = title.normalize("NFC").toUpperCase();
  const printableVersion = (version ?? "").normalize("NFC").toUpperCase();
  validatePrintableText(printableTitle);
  validatePrintableText(printableVersion);
  const layout = plaqueLayout(
    model,
    transform,
    baseBounds,
    featureSize,
    printableTitle,
    printableVersion,
  );
  const body = primitive(
    panel.id,
    "identity-panel",
    semanticGroupId,
    channelId,
    layout.body,
  );
  const textStart =
    layout.body.minimum.x +
    layout.margin +
    layout.iconWidth +
    layout.contentGap;
  const textRegionWidth =
    layout.body.maximum.x - layout.margin - textStart;
  const versionBottom = layout.body.minimum.z + layout.margin;
  const titleBottom =
    versionBottom +
    layout.featureSize * 5 +
    layout.lineGap;
  const titleStart =
    textStart + (textRegionWidth - layout.titleWidth) / 2;
  const versionStart =
    textStart + (textRegionWidth - layout.versionWidth) / 2;
  return [
    body,
    ...skylineReliefPrimitives(layout, semanticGroupId, channelId),
    ...textReliefPrimitives(
      printableTitle,
      "title",
      titleStart,
      titleBottom,
      layout,
      semanticGroupId,
      channelId,
    ),
    ...textReliefPrimitives(
      printableVersion,
      "version",
      versionStart,
      versionBottom,
      layout,
      semanticGroupId,
      channelId,
    ),
  ];
}

/**
 * Describes transformed print geometry in the CityModel axis convention used
 * by the printer-independent planning contract.
 */
export function printablePlanGeometry(
  city: PrintableCity,
): PrintablePlanGeometry {
  const primitives = city.parts.flatMap(({ primitives: items }) => items);
  const panels = primitives.filter(({ kind }) => kind === "identity-panel");
  const planBounds = {
    x: city.bounds.size.x,
    y: city.bounds.size.z,
    z: city.bounds.size.y,
  };
  if (panels.length === 0) {
    return { bounds: planBounds };
  }
  if (panels.length !== 1) {
    throw new PrintGeometryValidationError([
      "Printable city must contain at most one identity panel.",
    ]);
  }
  const panel = panels[0]!;
  if (panel.semanticGroupId !== "identity") {
    throw new PrintGeometryValidationError([
      "Printable identity panel must use the 'identity' semantic group.",
    ]);
  }
  const reliefs = primitives.filter(
    ({ kind, channelId }) =>
      kind === "identity-relief" && channelId === panel.channelId,
  );
  if (reliefs.length === 0) {
    throw new PrintGeometryValidationError([
      "Printable identity panel must contain relief geometry.",
    ]);
  }
  const reliefMinimumY = Math.min(
    ...reliefs.map(({ bounds: item }) => item.minimum.y),
  );
  const reliefDepth = panel.bounds.minimum.y - reliefMinimumY;
  if (reliefDepth <= EPSILON) {
    throw new PrintGeometryValidationError([
      "Printable identity relief must extend from the panel front.",
    ]);
  }
  const origin = city.bounds.minimum;
  return {
    bounds: planBounds,
    identityPanel: {
      id: panel.id,
      edge: "front",
      semanticGroupId: "identity",
      position: {
        x:
          (panel.bounds.minimum.x + panel.bounds.maximum.x) / 2 -
          origin.x,
        y:
          (panel.bounds.minimum.z + panel.bounds.maximum.z) / 2 -
          origin.z,
        z:
          (panel.bounds.minimum.y + panel.bounds.maximum.y) / 2 -
          origin.y,
      },
      size: {
        x: panel.bounds.size.x,
        y: panel.bounds.size.z,
        z: panel.bounds.size.y,
      },
      relief: "embossed",
      reliefDepth,
    },
  };
}

/**
 * Converts the shared CityModel coordinate system into millimetres:
 * city X -> printer X, city Z -> printer Y, and city Y -> printer Z.
 */
export function buildPrintableCityArtifacts(
  model: CityModel,
  assignments: readonly PrintSemanticAssignment[],
  options: BuildPrintableCityOptions,
): PrintableCityArtifacts {
  const scale = finitePositive(options.scale, "Print scale");
  const labelPolicy = options.labelPolicy ?? "auto";
  if (labelPolicy !== "auto" && labelPolicy !== "off") {
    throw new TypeError("Label policy must be either 'auto' or 'off'.");
  }
  const base = model.base;
  if (!base) {
    throw new PrintGeometryValidationError([
      "Printable export requires explicit shared-base geometry.",
    ]);
  }
  const semanticChannels = semanticChannelMap(
    model,
    assignments,
    options.profile,
  );
  const baseCityBox = cityBox(base.position, base.size);
  const transform: CoordinateTransform = {
    scale,
    origin: { ...baseCityBox.minimum },
  };
  const baseChannelId = requiredChannel(
    semanticChannels,
    base.semanticGroupId,
  );
  const baseBounds = printBoundsFromCityBox(baseCityBox, transform);
  const primitives: PrintPrimitive[] = [
    primitive(
      base.id,
      "base",
      base.semanticGroupId,
      baseChannelId,
      baseBounds,
    ),
  ];
  const districtsById = new Map(
    model.districts.map((district) => [district.id, district]),
  );
  const buildingsById = new Map(
    model.buildings.map((building) => [building.id, building]),
  );
  const districtPrimitives = new Map<string, PrintPrimitive>();
  const buildingPrimitives = new Map<string, PrintPrimitive>();
  const baseTop = baseCityBox.maximum.y;

  for (const district of [...model.districts].sort((left, right) =>
    compare(left.id, right.id),
  )) {
    const source = cityBox(district.position, district.size);
    const clipped: CityBox = {
      minimum: {
        ...source.minimum,
        y: Math.max(source.minimum.y, baseTop),
      },
      maximum: { ...source.maximum },
    };
    if (clipped.maximum.y <= clipped.minimum.y + EPSILON) {
      throw new PrintGeometryValidationError([
        `District '${district.id}' has no printable volume above the shared base.`,
      ]);
    }
    const districtPrimitive = primitive(
      district.id,
      "district",
      base.semanticGroupId,
      baseChannelId,
      printBoundsFromCityBox(clipped, transform),
    );
    districtPrimitives.set(district.id, districtPrimitive);
    primitives.push(districtPrimitive);
  }

  for (const building of [...model.buildings].sort((left, right) =>
    compare(left.id, right.id),
  )) {
    const channelId = requiredChannel(
      semanticChannels,
      building.semanticGroupId,
    );
    const buildingPrimitive = primitive(
      building.id,
      "building",
      building.semanticGroupId,
      channelId,
      printBoundsFromCityBox(
        cityBox(building.position, building.size),
        transform,
      ),
    );
    buildingPrimitives.set(building.id, buildingPrimitive);
    primitives.push(buildingPrimitive);
  }

  const title =
    model.identity?.title ??
    model.repositories[0]?.name ??
    "Code City";
  const version = model.identity?.version;
  const assignedBuildingCodes = assignBuildingPrintCodes(model.buildings);
  const buildingCodes = new Map(
    assignedBuildingCodes.map(({ id, code }) => [id, code]),
  );
  const assignedDistrictCodes = assignDistrictPrintCodes(model.districts);
  const districtCodes = new Map(
    assignedDistrictCodes.map(({ id, code }) => [id, code]),
  );
  const buildingStatuses = new Map<string, PhysicalPrintStatus>();
  for (const { id, code } of assignedBuildingCodes) {
    const building = buildingsById.get(id)!;
    const buildingPrimitive = buildingPrimitives.get(id)!;
    const result = buildingLabel(
      building,
      buildingPrimitive.bounds,
      code,
      buildingPrimitive.channelId,
      labelPolicy,
      options.profile,
    );
    buildingStatuses.set(id, result.status);
    if (result.primitive) primitives.push(result.primitive);
  }
  const districtStatuses = new Map<string, PhysicalPrintStatus>();
  const buildingBoundsByDistrict = new Map<string, PrintBounds[]>();
  for (const building of [...model.buildings].sort((left, right) =>
    compare(left.id, right.id),
  )) {
    const items = buildingBoundsByDistrict.get(building.districtId) ?? [];
    items.push(buildingPrimitives.get(building.id)!.bounds);
    buildingBoundsByDistrict.set(building.districtId, items);
  }
  for (const { id, code } of assignedDistrictCodes) {
    const district = districtsById.get(id)!;
    const districtPrimitive = districtPrimitives.get(id)!;
    const result = districtLabel(
      district,
      districtPrimitive.bounds,
      code,
      buildingBoundsByDistrict.get(id) ?? [],
      baseChannelId,
      labelPolicy,
      options.profile,
    );
    districtStatuses.set(id, result.status);
    if (result.primitive) primitives.push(result.primitive);
  }
  primitives.push(
    ...identityPrimitives(
      model,
      transform,
      baseBounds,
      semanticChannels,
      options.profile,
      title,
      version,
    ),
  );
  primitives.sort(primitiveOrder);
  const cityBounds = measuredBounds(primitives);
  const minimumFeatureSize = minimumPrimitiveFeature(primitives);
  const city: PrintableCity = {
    application: {
      name: "Code City",
      version: model.generator.version,
    },
    profileId: options.profile.id,
    title,
    ...(version === undefined ? {} : { version }),
    unit: "millimeter",
    scale,
    bounds: cityBounds,
    measurements: {
      baseThickness: baseBounds.size.z,
      wallThickness: minimumFeatureSize,
      minimumFeatureSize,
      minimumGap: minimumHorizontalGap(primitives),
    },
    parts: createParts(primitives, model, options.profile),
  };
  const issues = validatePrintableCity(city, options.profile);
  if (issues.length > 0) {
    throw new PrintGeometryValidationError(issues);
  }
  const legend = printLegend(
    model,
    options.profile,
    title,
    labelPolicy,
    buildingCodes,
    districtCodes,
    buildingStatuses,
    districtStatuses,
  );
  return {
    city,
    legend,
    labels: {
      printedBuildings: [...buildingStatuses.values()].filter(
        ({ status }) => status === "printed",
      ).length,
      skippedBuildings: [...buildingStatuses.values()].filter(
        ({ status }) => status === "skipped",
      ).length,
      printedDistricts: [...districtStatuses.values()].filter(
        ({ status }) => status === "printed",
      ).length,
      skippedDistricts: [...districtStatuses.values()].filter(
        ({ status }) => status === "skipped",
      ).length,
    },
  };
}

export function buildPrintableCity(
  model: CityModel,
  assignments: readonly PrintSemanticAssignment[],
  options: BuildPrintableCityOptions,
): PrintableCity {
  return buildPrintableCityArtifacts(model, assignments, options).city;
}
