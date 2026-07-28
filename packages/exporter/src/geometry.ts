import type {
  CityIdentityPanel,
  CityModel,
  SemanticGroup,
  Vector3,
} from "../../core/src/model.js";
import type { PrinterProfile } from "../../core/src/print.js";

import {
  PrintGeometryValidationError,
  validatePrintableCity,
} from "./validate.js";

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
  "identity-panel": 3,
  "identity-relief": 4,
});

const THREE_BY_FIVE_FONT: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    "?": Object.freeze(["111", "001", "011", "000", "010"]),
    "-": Object.freeze(["000", "000", "111", "000", "000"]),
    ".": Object.freeze(["000", "000", "000", "000", "010"]),
    _: Object.freeze(["000", "000", "000", "000", "111"]),
    "0": Object.freeze(["111", "101", "101", "101", "111"]),
    "1": Object.freeze(["010", "110", "010", "010", "111"]),
    "2": Object.freeze(["111", "001", "111", "100", "111"]),
    "3": Object.freeze(["111", "001", "111", "001", "111"]),
    "4": Object.freeze(["101", "101", "111", "001", "001"]),
    "5": Object.freeze(["111", "100", "111", "001", "111"]),
    "6": Object.freeze(["111", "100", "111", "101", "111"]),
    "7": Object.freeze(["111", "001", "010", "010", "010"]),
    "8": Object.freeze(["111", "101", "111", "101", "111"]),
    "9": Object.freeze(["111", "101", "111", "001", "111"]),
    A: Object.freeze(["010", "101", "111", "101", "101"]),
    B: Object.freeze(["110", "101", "110", "101", "110"]),
    C: Object.freeze(["111", "100", "100", "100", "111"]),
    D: Object.freeze(["110", "101", "101", "101", "110"]),
    E: Object.freeze(["111", "100", "110", "100", "111"]),
    F: Object.freeze(["111", "100", "110", "100", "100"]),
    G: Object.freeze(["111", "100", "101", "101", "111"]),
    H: Object.freeze(["101", "101", "111", "101", "101"]),
    I: Object.freeze(["111", "010", "010", "010", "111"]),
    J: Object.freeze(["001", "001", "001", "101", "111"]),
    K: Object.freeze(["101", "101", "110", "101", "101"]),
    L: Object.freeze(["100", "100", "100", "100", "111"]),
    M: Object.freeze(["101", "111", "111", "101", "101"]),
    N: Object.freeze(["101", "111", "111", "111", "101"]),
    O: Object.freeze(["111", "101", "101", "101", "111"]),
    P: Object.freeze(["110", "101", "110", "100", "100"]),
    Q: Object.freeze(["111", "101", "101", "111", "001"]),
    R: Object.freeze(["110", "101", "110", "101", "101"]),
    S: Object.freeze(["111", "100", "111", "001", "111"]),
    T: Object.freeze(["111", "010", "010", "010", "010"]),
    U: Object.freeze(["101", "101", "101", "101", "111"]),
    V: Object.freeze(["101", "101", "101", "101", "010"]),
    W: Object.freeze(["101", "101", "111", "111", "101"]),
    X: Object.freeze(["101", "101", "010", "101", "101"]),
    Y: Object.freeze(["101", "101", "010", "010", "010"]),
    Z: Object.freeze(["111", "001", "010", "100", "111"]),
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
  let minimum = Number.POSITIVE_INFINITY;
  for (let leftIndex = 0; leftIndex < primitives.length; leftIndex += 1) {
    const left = primitives[leftIndex]!;
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < primitives.length;
      rightIndex += 1
    ) {
      const right = primitives[rightIndex]!;
      const verticalOverlap =
        Math.min(left.bounds.maximum.z, right.bounds.maximum.z) -
        Math.max(left.bounds.minimum.z, right.bounds.minimum.z);
      if (verticalOverlap <= EPSILON) continue;
      const xGap = intervalGap(
        left.bounds.minimum.x,
        left.bounds.maximum.x,
        right.bounds.minimum.x,
        right.bounds.maximum.x,
      );
      const yGap = intervalGap(
        left.bounds.minimum.y,
        left.bounds.maximum.y,
        right.bounds.minimum.y,
        right.bounds.maximum.y,
      );
      const gap = Math.hypot(xGap, yGap);
      if (gap > EPSILON) minimum = Math.min(minimum, gap);
    }
  }
  return Number.isFinite(minimum) ? minimum : null;
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

function glyphPattern(character: string): readonly string[] | undefined {
  if (character === " ") return undefined;
  const pattern = THREE_BY_FIVE_FONT[character];
  if (!pattern) {
    throw new PrintGeometryValidationError([
      `Printable identity contains unsupported character '${character}'. Use A-Z, 0-9, space, '.', '-', '_', or '?'.`,
    ]);
  }
  return pattern;
}

function validatePrintableText(text: string): void {
  for (const character of text) {
    glyphPattern(character);
  }
}

function textWidth(text: string, featureSize: number): number {
  let width = 0;
  const characters = [...text];
  characters.forEach((character, index) => {
    width += character === " " ? featureSize * 2 : featureSize * 3;
    if (index < characters.length - 1 && character !== " ") {
      width += featureSize;
    }
  });
  return width;
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
  const titleWidth = textWidth(title, featureSize);
  const versionWidth = textWidth(version, featureSize);
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
  const result: PrintPrimitive[] = [];
  let cursorX = startX;
  [...text].forEach((character, characterIndex) => {
    const pattern = glyphPattern(character);
    if (!pattern) {
      cursorX += layout.featureSize * 2;
      return;
    }
    pattern.forEach((row, rowIndex) => {
      [...row].forEach((value, columnIndex) => {
        if (value !== "1") return;
        const minimum = {
          x: cursorX + columnIndex * layout.featureSize,
          y: layout.body.minimum.y - layout.reliefDepth,
          z:
            bottomZ +
            (4 - rowIndex) * layout.featureSize,
        };
        result.push(
          primitive(
            `identity-relief:${line}:${characterIndex}:${rowIndex}:${columnIndex}`,
            "identity-relief",
            semanticGroupId,
            channelId,
            bounds(minimum, {
              x: minimum.x + layout.featureSize,
              y: minimum.y + layout.reliefDepth,
              z: minimum.z + layout.featureSize,
            }),
          ),
        );
      });
    });
    cursorX += layout.featureSize * 4;
  });
  return result;
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
export function buildPrintableCity(
  model: CityModel,
  assignments: readonly PrintSemanticAssignment[],
  options: BuildPrintableCityOptions,
): PrintableCity {
  const scale = finitePositive(options.scale, "Print scale");
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
    primitives.push(
      primitive(
        district.id,
        "district",
        base.semanticGroupId,
        baseChannelId,
        printBoundsFromCityBox(clipped, transform),
      ),
    );
  }

  for (const building of [...model.buildings].sort((left, right) =>
    compare(left.id, right.id),
  )) {
    const channelId = requiredChannel(
      semanticChannels,
      building.semanticGroupId,
    );
    primitives.push(
      primitive(
        building.id,
        "building",
        building.semanticGroupId,
        channelId,
        printBoundsFromCityBox(
          cityBox(building.position, building.size),
          transform,
        ),
      ),
    );
  }

  const title =
    model.identity?.title ??
    model.repositories[0]?.name ??
    "Code City";
  const version = model.identity?.version;
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
  return city;
}
