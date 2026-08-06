import {
  PRINT_FIDELITY_EPSILON,
  PRINT_FEATURE_CATEGORIES,
  type PrintFeatureCategory,
  type PrintFeatureViolation,
} from "../../../packages/core/src/print-layout.js";

export const PRINT_PREVIEW_MODES = ["city", "plates"] as const;

export type PrintPreviewMode = (typeof PRINT_PREVIEW_MODES)[number];
export type PrintLayoutPreviewReadiness = "planned" | "ready";
export type RequestedPrintFitPolicy =
  | "auto"
  | "error"
  | "scale"
  | "tile";
export type AppliedPrintFitPolicy = "error" | "scale" | "tile";

export interface PrintPreviewPoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface PrintPreviewBounds {
  readonly minimum: PrintPreviewPoint;
  readonly maximum: PrintPreviewPoint;
  readonly size: PrintPreviewPoint;
}

export interface PrintPreviewTriangle {
  readonly a: number;
  readonly b: number;
  readonly c: number;
}

export interface PrintPreviewMesh {
  readonly vertices: readonly PrintPreviewPoint[];
  readonly triangles: readonly PrintPreviewTriangle[];
}

export interface PrintPlatePreviewEntity {
  readonly id: string;
  readonly kind: string;
  readonly semanticGroupId?: string;
  readonly channelId?: string;
  readonly mesh: PrintPreviewMesh;
  /**
   * Exact exporter-plan bounds. The viewer must not repack, rotate, or scale
   * this geometry.
   */
  readonly bounds: PrintPreviewBounds;
}

export interface PrintPlatePreviewRoute {
  readonly id: string;
  readonly channelId?: string;
  readonly points: readonly PrintPreviewPoint[];
}

export interface PrintPlatePreviewPlan {
  readonly id: string;
  readonly index: number;
  readonly fileName: string;
  readonly bounds: PrintPreviewBounds;
  readonly utilization: number;
  readonly channels: readonly string[];
  readonly entities: readonly PrintPlatePreviewEntity[];
  readonly routes?: readonly PrintPlatePreviewRoute[];
  readonly warnings: readonly string[];
}

/**
 * Browser projection of the exporter-owned layout plan. Every placement and
 * bound comes from the exporter; the viewer never derives a second packing.
 */
export interface PrintLayoutPreviewPlan {
  /**
   * Export lifecycle only. It never changes exporter-owned geometry or
   * packing.
   */
  readonly readiness?: PrintLayoutPreviewReadiness;
  readonly requestedPolicy: RequestedPrintFitPolicy;
  readonly appliedPolicy: AppliedPrintFitPolicy;
  readonly requestedScale: number;
  readonly appliedScale: number;
  readonly minimumSafeScale: number;
  readonly belowProfileScaleAcknowledged: boolean;
  readonly featureViolations: readonly PrintFeatureViolation[];
  readonly sourceBounds: PrintPreviewBounds;
  readonly printableBounds: PrintPreviewBounds;
  readonly plates: readonly PrintPlatePreviewPlan[];
  readonly warnings: readonly string[];
  readonly unplacedObjects: readonly string[];
}

/**
 * Structural bridge for the bundle planner. It intentionally avoids importing
 * exporter code into the viewer and accepts only the exact fields needed for
 * preview projection.
 */
export interface PrintBundlePreviewSource {
  readonly fitPolicy: RequestedPrintFitPolicy;
  readonly appliedPolicy?: AppliedPrintFitPolicy;
  readonly requestedScale: number;
  readonly appliedScale: number;
  readonly minimumSafeScale: number;
  readonly belowProfileScaleAcknowledged: boolean;
  readonly featureViolations: readonly PrintFeatureViolation[];
  readonly sourceBounds: PrintPreviewBounds;
  readonly printableBounds: PrintPreviewBounds;
  readonly warnings: readonly string[];
  readonly unplacedObjects: readonly { readonly id: string }[];
  readonly plates: readonly {
    readonly number: number;
    readonly id: string;
    readonly fileName: string;
    readonly utilization: number;
    readonly bounds: PrintPreviewBounds;
    readonly warnings: readonly string[];
    readonly parts: readonly {
      readonly channelId: string;
      readonly primitives: readonly {
        readonly id: string;
        readonly kind: string;
        readonly semanticGroupId?: string;
        readonly channelId?: string;
        readonly bounds: PrintPreviewBounds;
        readonly mesh: PrintPreviewMesh;
      }[];
    }[];
    readonly routes?: readonly PrintPlatePreviewRoute[];
  }[];
}

export interface ProjectedPrintEntity extends PrintPlatePreviewEntity {
  readonly position: PrintPreviewPoint;
  readonly size: PrintPreviewPoint;
}

export interface ProjectedPrintPlate {
  readonly plateId: string;
  readonly plateIndex: number;
  readonly fileName: string;
  readonly appliedScale: number;
  readonly bounds: PrintPreviewBounds;
  readonly utilization: number;
  readonly channels: readonly string[];
  readonly entities: readonly ProjectedPrintEntity[];
  readonly routes: readonly PrintPlatePreviewRoute[];
  readonly warnings: readonly string[];
}

export interface ViewerPrintMeshBuffers {
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
}

export interface ViewerPrintMeshBatch {
  readonly key: string;
  readonly buffers: ViewerPrintMeshBuffers;
}

export interface PrintPlateSelectorOption {
  readonly id: string;
  readonly label: string;
  readonly selected: boolean;
}

export interface PrintPlatePreviewState {
  readonly mode: PrintPreviewMode;
  readonly plan?: PrintLayoutPreviewPlan;
  readonly selectedPlateId?: string;
  readonly selectorOptions: readonly PrintPlateSelectorOption[];
  readonly projection?: ProjectedPrintPlate;
}

export interface PrintPlatePreviewControllerOptions {
  readonly onStateChange?: (state: PrintPlatePreviewState) => void;
}

const BOUNDS_EPSILON = 1e-7;
const PREVIEW_PLATE_LIMIT = 99;
const PREVIEW_CHANNEL_LIMIT = 1_000;
const PREVIEW_WARNING_LIMIT = 1_000;
const PREVIEW_UNPLACED_LIMIT = 100_000;
const PREVIEW_ENTITY_LIMIT = 100_000;
const PREVIEW_ROUTE_LIMIT = 100_000;
const PREVIEW_ROUTE_POINT_LIMIT = 1_000_000;
const PREVIEW_POINTS_PER_ROUTE_LIMIT = 10_000;
const PREVIEW_VERTEX_LIMIT = 1_000_000;
const PREVIEW_TRIANGLE_LIMIT = 1_000_000;
const normalizedMeshes = new WeakSet<object>();
const normalizedPlans = new WeakSet<object>();
const FEATURE_CATEGORIES = new Set<PrintFeatureCategory>([
  ...PRINT_FEATURE_CATEGORIES,
]);
const FEATURE_CATEGORY_ORDER = new Map<PrintFeatureCategory, number>(
  PRINT_FEATURE_CATEGORIES.map((category, index) => [category, index]),
);

function featureViolations(
  values: readonly PrintFeatureViolation[],
): readonly PrintFeatureViolation[] {
  if (!Array.isArray(values) || values.length > FEATURE_CATEGORIES.size) {
    throw new TypeError("Print-layout feature violations are invalid.");
  }
  const seen = new Set<PrintFeatureCategory>();
  let previousOrder = -1;
  return Object.freeze(values.map((value) => {
    const order = FEATURE_CATEGORY_ORDER.get(value.category);
    if (
      typeof value !== "object" ||
      value === null ||
      !FEATURE_CATEGORIES.has(value.category) ||
      seen.has(value.category) ||
      order === undefined ||
      order <= previousOrder ||
      !Number.isFinite(value.resultingValue) ||
      value.resultingValue <= 0 ||
      !Number.isFinite(value.minimum) ||
      value.resultingValue + PRINT_FIDELITY_EPSILON >= value.minimum
    ) {
      throw new TypeError("Print-layout feature violation is invalid.");
    }
    seen.add(value.category);
    previousOrder = order;
    return Object.freeze({ ...value });
  }));
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function finite(value: number, field: string): number {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${field} must be finite.`);
  }
  return value;
}

function nonnegative(value: number, field: string): number {
  if (finite(value, field) < 0) {
    throw new TypeError(`${field} must be non-negative.`);
  }
  return value;
}

function identifier(value: string, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    /[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)
  ) {
    throw new TypeError(`${field} must be a bounded identifier.`);
  }
  return value;
}

function point(value: PrintPreviewPoint, field: string): PrintPreviewPoint {
  return Object.freeze({
    x: finite(value.x, `${field}.x`),
    y: finite(value.y, `${field}.y`),
    z: finite(value.z, `${field}.z`),
  });
}

function bounds(
  value: PrintPreviewBounds,
  field: string,
): PrintPreviewBounds {
  const minimum = point(value.minimum, `${field}.minimum`);
  const maximum = point(value.maximum, `${field}.maximum`);
  const size = point(value.size, `${field}.size`);
  for (const axis of ["x", "y", "z"] as const) {
    nonnegative(size[axis], `${field}.size.${axis}`);
    if (maximum[axis] < minimum[axis]) {
      throw new TypeError(`${field} has inverted ${axis} bounds.`);
    }
    if (
      Math.abs(maximum[axis] - minimum[axis] - size[axis]) >
      BOUNDS_EPSILON
    ) {
      throw new TypeError(`${field} size does not match its bounds.`);
    }
  }
  return Object.freeze({ minimum, maximum, size });
}

function containsPoint(
  container: PrintPreviewBounds,
  candidate: PrintPreviewPoint,
): boolean {
  return (
    candidate.x >= container.minimum.x - BOUNDS_EPSILON &&
    candidate.x <= container.maximum.x + BOUNDS_EPSILON &&
    candidate.y >= container.minimum.y - BOUNDS_EPSILON &&
    candidate.y <= container.maximum.y + BOUNDS_EPSILON &&
    candidate.z >= container.minimum.z - BOUNDS_EPSILON &&
    candidate.z <= container.maximum.z + BOUNDS_EPSILON
  );
}

function containsBounds(
  container: PrintPreviewBounds,
  candidate: PrintPreviewBounds,
): boolean {
  return (
    containsPoint(container, candidate.minimum) &&
    containsPoint(container, candidate.maximum)
  );
}

function stringList(
  values: readonly string[],
  field: string,
  maximumItems = PREVIEW_UNPLACED_LIMIT,
): readonly string[] {
  if (!Array.isArray(values) || values.length > maximumItems) {
    throw new TypeError(`${field} must be an array.`);
  }
  const normalized = values.map((value, index) =>
    identifier(value, `${field}[${index}]`),
  );
  if (new Set(normalized).size !== normalized.length) {
    throw new TypeError(`${field} must not contain duplicates.`);
  }
  return Object.freeze([...normalized]);
}

function cloneEntity(
  entity: PrintPlatePreviewEntity,
  plateId: string,
): PrintPlatePreviewEntity {
  const entityBounds = bounds(
    entity.bounds,
    `plate '${plateId}' entity bounds`,
  );
  const mesh = cloneMesh(
    entity.mesh,
    `plate '${plateId}' entity '${entity.id}' mesh`,
  );
  const firstVertex = mesh.vertices[0]!;
  const meshMinimum = { ...firstVertex };
  const meshMaximum = { ...firstVertex };
  for (let index = 1; index < mesh.vertices.length; index += 1) {
    const vertex = mesh.vertices[index]!;
    meshMinimum.x = Math.min(meshMinimum.x, vertex.x);
    meshMinimum.y = Math.min(meshMinimum.y, vertex.y);
    meshMinimum.z = Math.min(meshMinimum.z, vertex.z);
    meshMaximum.x = Math.max(meshMaximum.x, vertex.x);
    meshMaximum.y = Math.max(meshMaximum.y, vertex.y);
    meshMaximum.z = Math.max(meshMaximum.z, vertex.z);
  }
  for (const axis of ["x", "y", "z"] as const) {
    if (
      Math.abs(meshMinimum[axis] - entityBounds.minimum[axis]) >
        BOUNDS_EPSILON ||
      Math.abs(meshMaximum[axis] - entityBounds.maximum[axis]) >
        BOUNDS_EPSILON
    ) {
      throw new TypeError(
        `Plate '${plateId}' entity mesh does not match its ${axis} bounds.`,
      );
    }
  }
  return Object.freeze({
    id: identifier(entity.id, `plate '${plateId}' entity id`),
    kind: identifier(entity.kind, `plate '${plateId}' entity kind`),
    ...(entity.semanticGroupId === undefined
      ? {}
      : {
          semanticGroupId: identifier(
            entity.semanticGroupId,
            `plate '${plateId}' entity semantic group`,
          ),
        }),
    ...(entity.channelId === undefined
      ? {}
      : {
          channelId: identifier(
            entity.channelId,
            `plate '${plateId}' entity channel`,
          ),
        }),
    bounds: entityBounds,
    mesh,
  });
}

function cloneMesh(
  value: PrintPreviewMesh,
  field: string,
): PrintPreviewMesh {
  if (
    typeof value === "object" &&
    value !== null &&
    normalizedMeshes.has(value)
  ) {
    return value;
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !Array.isArray(value.vertices) ||
    value.vertices.length === 0 ||
    value.vertices.length > PREVIEW_VERTEX_LIMIT ||
    !Array.isArray(value.triangles) ||
    value.triangles.length === 0 ||
    value.triangles.length > PREVIEW_TRIANGLE_LIMIT
  ) {
    throw new TypeError(`${field} exceeds browser mesh limits.`);
  }
  const vertices = value.vertices.map((vertex, index) =>
    point(vertex, `${field}.vertices[${index}]`),
  );
  const triangles = value.triangles.map((triangle, index) => {
    if (
      typeof triangle !== "object" ||
      triangle === null ||
      !Number.isSafeInteger(triangle.a) ||
      !Number.isSafeInteger(triangle.b) ||
      !Number.isSafeInteger(triangle.c) ||
      triangle.a < 0 ||
      triangle.b < 0 ||
      triangle.c < 0 ||
      triangle.a >= vertices.length ||
      triangle.b >= vertices.length ||
      triangle.c >= vertices.length ||
      triangle.a === triangle.b ||
      triangle.b === triangle.c ||
      triangle.a === triangle.c
    ) {
      throw new TypeError(`${field}.triangles[${index}] is invalid.`);
    }
    return Object.freeze({
      a: triangle.a,
      b: triangle.b,
      c: triangle.c,
    });
  });
  const normalized = Object.freeze({
    vertices: Object.freeze(vertices),
    triangles: Object.freeze(triangles),
  });
  normalizedMeshes.add(normalized);
  return normalized;
}

function cloneRoute(
  route: PrintPlatePreviewRoute,
  plateId: string,
): PrintPlatePreviewRoute {
  if (
    !Array.isArray(route.points) ||
    route.points.length < 2 ||
    route.points.length > PREVIEW_POINTS_PER_ROUTE_LIMIT
  ) {
    throw new TypeError(
      `Plate '${plateId}' preview routes require between 2 and ` +
        `${PREVIEW_POINTS_PER_ROUTE_LIMIT} points.`,
    );
  }
  return Object.freeze({
    id: identifier(route.id, `plate '${plateId}' route id`),
    ...(route.channelId === undefined
      ? {}
      : {
          channelId: identifier(
            route.channelId,
            `plate '${plateId}' route channel`,
          ),
        }),
    points: Object.freeze(
      route.points.map((value, index) =>
        point(value, `plate '${plateId}' route point ${index}`),
      ),
    ),
  });
}

function clonePlate(
  plate: PrintPlatePreviewPlan,
): PrintPlatePreviewPlan {
  const id = identifier(plate.id, "plate id");
  const plateBounds = bounds(plate.bounds, `plate '${id}' bounds`);
  if (!Number.isSafeInteger(plate.index) || plate.index < 0) {
    throw new TypeError("Plate index must be a non-negative integer.");
  }
  if (
    typeof plate.fileName !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.(?:3mf|stl)$/u.test(
      plate.fileName,
    )
  ) {
    throw new TypeError("Plate file name is not portable.");
  }
  if (
    !Number.isFinite(plate.utilization) ||
    plate.utilization < 0 ||
    plate.utilization > 1
  ) {
    throw new TypeError("Plate utilization must be between zero and one.");
  }
  if (
    !Array.isArray(plate.entities) ||
    plate.entities.length > PREVIEW_ENTITY_LIMIT
  ) {
    throw new TypeError(`Plate '${id}' has too many preview entities.`);
  }
  const entities = plate.entities.map((entity) => cloneEntity(entity, id));
  if (!entities.every((entity) => containsBounds(plateBounds, entity.bounds))) {
    throw new TypeError(
      `Plate '${id}' contains printable geometry outside its bounds.`,
    );
  }
  if (new Set(entities.map(({ id: entityId }) => entityId)).size !== entities.length) {
    throw new TypeError(`Plate '${id}' contains duplicate entity ids.`);
  }
  const sourceRoutes = plate.routes ?? [];
  if (
    !Array.isArray(sourceRoutes) ||
    sourceRoutes.length > PREVIEW_ROUTE_LIMIT
  ) {
    throw new TypeError(`Plate '${id}' has too many preview routes.`);
  }
  const routes = sourceRoutes.map((route) => cloneRoute(route, id));
  if (
    !routes.every((route) =>
      route.points.every((routePoint) =>
        containsPoint(plateBounds, routePoint),
      ),
    )
  ) {
    throw new TypeError(
      `Plate '${id}' contains a preview route outside its bounds.`,
    );
  }
  if (new Set(routes.map(({ id: routeId }) => routeId)).size !== routes.length) {
    throw new TypeError(`Plate '${id}' contains duplicate route ids.`);
  }
  return Object.freeze({
    id,
    index: plate.index,
    fileName: plate.fileName,
    bounds: plateBounds,
    utilization: plate.utilization,
    channels: stringList(
      plate.channels,
      `plate '${id}' channels`,
      PREVIEW_CHANNEL_LIMIT,
    ),
    entities: Object.freeze(entities),
    routes: Object.freeze(routes),
    warnings: stringList(
      plate.warnings,
      `plate '${id}' warnings`,
      PREVIEW_WARNING_LIMIT,
    ),
  });
}

function assertAggregatePreviewLimits(
  plates: readonly PrintPlatePreviewPlan[],
): void {
  let entityCount = 0;
  let routeCount = 0;
  let routePointCount = 0;
  let vertexCount = 0;
  let triangleCount = 0;
  for (const plate of plates) {
    if (!Array.isArray(plate.entities)) {
      throw new TypeError("Print-layout plate entities must be an array.");
    }
    entityCount += plate.entities.length;
    if (entityCount > PREVIEW_ENTITY_LIMIT) {
      throw new TypeError("Print-layout preview exceeds browser entity limits.");
    }
    for (const entity of plate.entities) {
      const mesh = entity?.mesh;
      if (
        typeof mesh !== "object" ||
        mesh === null ||
        !Array.isArray(mesh.vertices) ||
        !Array.isArray(mesh.triangles)
      ) {
        throw new TypeError("Print-layout preview mesh is invalid.");
      }
      vertexCount += mesh.vertices.length;
      triangleCount += mesh.triangles.length;
      if (
        vertexCount > PREVIEW_VERTEX_LIMIT ||
        triangleCount > PREVIEW_TRIANGLE_LIMIT
      ) {
        throw new TypeError("Print-layout preview meshes exceed browser limits.");
      }
    }
    const routes = plate.routes ?? [];
    if (!Array.isArray(routes)) {
      throw new TypeError("Print-layout preview routes must be an array.");
    }
    routeCount += routes.length;
    if (routeCount > PREVIEW_ROUTE_LIMIT) {
      throw new TypeError("Print-layout preview exceeds browser route limits.");
    }
    for (const route of routes) {
      if (!Array.isArray(route?.points)) {
        throw new TypeError("Print-layout preview route points must be an array.");
      }
      routePointCount += route.points.length;
      if (routePointCount > PREVIEW_ROUTE_POINT_LIMIT) {
        throw new TypeError(
          "Print-layout preview route points exceed browser limits.",
        );
      }
    }
  }
}

export function normalizePrintLayoutPreviewPlan(
  plan: PrintLayoutPreviewPlan,
): PrintLayoutPreviewPlan {
  if (
    typeof plan === "object" &&
    plan !== null &&
    normalizedPlans.has(plan)
  ) {
    return plan;
  }
  if (
    plan.requestedPolicy !== "auto" &&
    plan.requestedPolicy !== "error" &&
    plan.requestedPolicy !== "scale" &&
    plan.requestedPolicy !== "tile"
  ) {
    throw new TypeError("Requested print-layout policy is invalid.");
  }
  if (
    plan.appliedPolicy !== "error" &&
    plan.appliedPolicy !== "scale" &&
    plan.appliedPolicy !== "tile"
  ) {
    throw new TypeError("Applied print-layout policy is invalid.");
  }
  if (
    !Number.isFinite(plan.requestedScale) ||
    plan.requestedScale <= 0 ||
    !Number.isFinite(plan.appliedScale) ||
    plan.appliedScale <= 0 ||
    !Number.isFinite(plan.minimumSafeScale) ||
    plan.minimumSafeScale <= 0
  ) {
    throw new TypeError("Print-layout scales must be positive.");
  }
  if (typeof plan.belowProfileScaleAcknowledged !== "boolean") {
    throw new TypeError("Print-layout scale acknowledgement is invalid.");
  }
  const violations = featureViolations(plan.featureViolations);
  if (
    ((plan.appliedPolicy === "error" ||
      plan.appliedPolicy === "tile") &&
      Math.abs(plan.appliedScale - plan.requestedScale) >
        PRINT_FIDELITY_EPSILON) ||
    (plan.appliedPolicy === "scale" &&
      plan.appliedScale >
        plan.requestedScale + PRINT_FIDELITY_EPSILON) ||
    (plan.appliedScale + PRINT_FIDELITY_EPSILON <
      plan.minimumSafeScale) !==
      (violations.length > 0) ||
    (violations.length > 0 && !plan.belowProfileScaleAcknowledged)
  ) {
    throw new TypeError("Print-layout fidelity metadata is inconsistent.");
  }
  if (!Array.isArray(plan.plates) || plan.plates.length === 0) {
    throw new TypeError("A print-layout preview requires at least one plate.");
  }
  if (plan.plates.length > PREVIEW_PLATE_LIMIT) {
    throw new TypeError("A print-layout preview has too many plates.");
  }
  assertAggregatePreviewLimits(plan.plates);
  if (
    plan.readiness !== undefined &&
    plan.readiness !== "planned" &&
    plan.readiness !== "ready"
  ) {
    throw new TypeError("Print-layout preview readiness is invalid.");
  }
  const plates = plan.plates
    .map(clonePlate)
    .sort((left, right) => left.index - right.index || compare(left.id, right.id));
  if (
    new Set(plates.map(({ id }) => id)).size !== plates.length ||
    new Set(plates.map(({ index }) => index)).size !== plates.length
  ) {
    throw new TypeError("Print-layout plate ids and indexes must be unique.");
  }
  const normalized = Object.freeze({
    readiness: plan.readiness ?? "ready",
    requestedPolicy: plan.requestedPolicy,
    appliedPolicy: plan.appliedPolicy,
    requestedScale: plan.requestedScale,
    appliedScale: plan.appliedScale,
    minimumSafeScale: plan.minimumSafeScale,
    belowProfileScaleAcknowledged:
      plan.belowProfileScaleAcknowledged,
    featureViolations: violations,
    sourceBounds: bounds(plan.sourceBounds, "source bounds"),
    printableBounds: bounds(plan.printableBounds, "printable bounds"),
    plates: Object.freeze(plates),
    warnings: stringList(
      plan.warnings,
      "layout warnings",
      PREVIEW_WARNING_LIMIT,
    ),
    unplacedObjects: stringList(
      plan.unplacedObjects,
      "unplaced print objects",
    ),
  });
  normalizedPlans.add(normalized);
  return normalized;
}

export function withPrintLayoutPreviewReadiness(
  plan: PrintLayoutPreviewPlan,
  readiness: PrintLayoutPreviewReadiness,
): PrintLayoutPreviewPlan {
  if (readiness !== "planned" && readiness !== "ready") {
    throw new TypeError("Print-layout preview readiness is invalid.");
  }
  const normalized = normalizePrintLayoutPreviewPlan(plan);
  if (normalized.readiness === readiness) return normalized;
  const updated = Object.freeze({ ...normalized, readiness });
  normalizedPlans.add(updated);
  return updated;
}

/**
 * Projects a bundle planner result without performing geometry, packing,
 * scaling, or rotation in the viewer.
 */
export function printLayoutPreviewPlanFromBundle(
  source: PrintBundlePreviewSource,
  readiness: PrintLayoutPreviewReadiness = "planned",
): PrintLayoutPreviewPlan {
  if (
    !Array.isArray(source.plates) ||
    source.plates.length === 0 ||
    source.plates.length > PREVIEW_PLATE_LIMIT
  ) {
    throw new TypeError("Bundle preview plate count is invalid.");
  }
  if (
    !Array.isArray(source.unplacedObjects) ||
    source.unplacedObjects.length > PREVIEW_UNPLACED_LIMIT ||
    !Array.isArray(source.warnings) ||
    source.warnings.length > PREVIEW_WARNING_LIMIT
  ) {
    throw new TypeError("Bundle preview metadata exceeds browser limits.");
  }
  const sourcePlates =
    source.plates as PrintBundlePreviewSource["plates"];
  let entityCount = 0;
  let routeCount = 0;
  let routePointCount = 0;
  let vertexCount = 0;
  let triangleCount = 0;
  for (const plate of sourcePlates) {
    if (!Array.isArray(plate.parts)) {
      throw new TypeError("Bundle preview parts must be an array.");
    }
    for (const part of plate.parts) {
      if (!Array.isArray(part.primitives)) {
        throw new TypeError("Bundle preview primitives must be an array.");
      }
      entityCount += part.primitives.length;
      for (const primitive of part.primitives) {
        if (
          typeof primitive.mesh !== "object" ||
          primitive.mesh === null ||
          !Array.isArray(primitive.mesh.vertices) ||
          !Array.isArray(primitive.mesh.triangles)
        ) {
          throw new TypeError(
            "Bundle preview primitive mesh is invalid.",
          );
        }
        vertexCount += primitive.mesh.vertices.length;
        triangleCount += primitive.mesh.triangles.length;
      }
      if (entityCount > PREVIEW_ENTITY_LIMIT) {
        throw new TypeError(
          "Bundle preview has too many printable entities.",
        );
      }
      if (
        vertexCount > PREVIEW_VERTEX_LIMIT ||
        triangleCount > PREVIEW_TRIANGLE_LIMIT
      ) {
        throw new TypeError("Bundle preview meshes exceed browser limits.");
      }
    }
    const routes = plate.routes ?? [];
    if (!Array.isArray(routes)) {
      throw new TypeError("Bundle preview routes must be an array.");
    }
    routeCount += routes.length;
    routePointCount += routes.reduce(
      (total, route) =>
        total + (Array.isArray(route.points) ? route.points.length : 0),
      0,
    );
    if (
      routeCount > PREVIEW_ROUTE_LIMIT ||
      routePointCount > PREVIEW_ROUTE_POINT_LIMIT
    ) {
      throw new TypeError("Bundle preview routes exceed browser limits.");
    }
  }
  const appliedPolicy = source.appliedPolicy ??
    (source.fitPolicy === "auto" ? undefined : source.fitPolicy);
  if (appliedPolicy === undefined) {
    throw new TypeError(
      "An Auto print-layout preview requires a concrete applied policy.",
    );
  }
  const plan: PrintLayoutPreviewPlan = {
    readiness,
    requestedPolicy: source.fitPolicy,
    appliedPolicy,
    requestedScale: source.requestedScale,
    appliedScale: source.appliedScale,
    minimumSafeScale: source.minimumSafeScale,
    belowProfileScaleAcknowledged:
      source.belowProfileScaleAcknowledged,
    featureViolations: source.featureViolations,
    sourceBounds: source.sourceBounds,
    printableBounds: source.printableBounds,
    plates: sourcePlates.map((plate) => ({
      id: plate.id,
      index: plate.number - 1,
      fileName: plate.fileName,
      bounds: plate.bounds,
      utilization: plate.utilization,
      channels: [
        ...new Set(plate.parts.map(({ channelId }) => channelId)),
      ].sort(compare),
      entities: plate.parts.flatMap((part) =>
        part.primitives.map((primitive) => ({
          id: primitive.id,
          kind: primitive.kind,
          ...(primitive.semanticGroupId === undefined
            ? {}
            : { semanticGroupId: primitive.semanticGroupId }),
          channelId: primitive.channelId ?? part.channelId,
          bounds: primitive.bounds,
          mesh: primitive.mesh,
        })),
      ),
      ...(plate.routes === undefined ? {} : { routes: plate.routes }),
      warnings: plate.warnings,
    })),
    warnings: source.warnings,
    unplacedObjects: source.unplacedObjects.map(({ id }) => id),
  };
  return normalizePrintLayoutPreviewPlan(plan);
}

export function projectPrintPlate(
  plan: PrintLayoutPreviewPlan,
  plateId: string,
): ProjectedPrintPlate {
  const normalized = normalizePrintLayoutPreviewPlan(plan);
  return projectNormalizedPrintPlate(normalized, plateId);
}

/**
 * Converts print coordinates (X width, Y depth, Z height) into the viewer's
 * X/Y/Z frame. Swapping depth and height reverses handedness, so triangle
 * winding is reversed as well.
 */
export function viewerPrintMeshBuffers(
  mesh: PrintPreviewMesh,
): ViewerPrintMeshBuffers {
  const normalized = cloneMesh(mesh, "print preview mesh");
  const positions = new Float32Array(normalized.vertices.length * 3);
  normalized.vertices.forEach((vertex, index) => {
    const offset = index * 3;
    positions[offset] = vertex.x;
    positions[offset + 1] = vertex.z;
    positions[offset + 2] = vertex.y;
  });
  const indices = new Uint32Array(normalized.triangles.length * 3);
  normalized.triangles.forEach((triangle, index) => {
    const offset = index * 3;
    indices[offset] = triangle.a;
    indices[offset + 1] = triangle.c;
    indices[offset + 2] = triangle.b;
  });
  return Object.freeze({ positions, indices });
}

/**
 * Merges exact exporter meshes by a caller-supplied material key. Geometry is
 * copied into typed buffers once; no packing, scaling, or vertex transforms
 * other than the documented print-to-viewer axis mapping are performed.
 */
export function viewerPrintMeshBatches(
  entities: readonly PrintPlatePreviewEntity[],
  keyFor: (entity: PrintPlatePreviewEntity) => string,
): readonly ViewerPrintMeshBatch[] {
  const groups = new Map<string, PrintPlatePreviewEntity[]>();
  for (const entity of entities) {
    const key = identifier(keyFor(entity), "print mesh batch key");
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [entity]);
    else group.push(entity);
  }
  const result: ViewerPrintMeshBatch[] = [];
  for (const [key, group] of [...groups].sort(([left], [right]) =>
    compare(left, right),
  )) {
    let vertexCount = 0;
    let indexCount = 0;
    for (const entity of group) {
      vertexCount += entity.mesh.vertices.length;
      indexCount += entity.mesh.triangles.length * 3;
    }
    const positions = new Float32Array(vertexCount * 3);
    const indices = new Uint32Array(indexCount);
    let vertexOffset = 0;
    let indexOffset = 0;
    for (const entity of group) {
      const buffers = viewerPrintMeshBuffers(entity.mesh);
      positions.set(buffers.positions, vertexOffset * 3);
      for (let index = 0; index < buffers.indices.length; index += 1) {
        indices[indexOffset + index] =
          buffers.indices[index]! + vertexOffset;
      }
      vertexOffset += buffers.positions.length / 3;
      indexOffset += buffers.indices.length;
    }
    result.push(
      Object.freeze({
        key,
        buffers: Object.freeze({ positions, indices }),
      }),
    );
  }
  return Object.freeze(result);
}

function projectNormalizedPrintPlate(
  normalized: PrintLayoutPreviewPlan,
  plateId: string,
): ProjectedPrintPlate {
  const plate = normalized.plates.find(({ id }) => id === plateId);
  if (plate === undefined) {
    throw new RangeError("Selected print plate is unavailable.");
  }
  return Object.freeze({
    plateId: plate.id,
    plateIndex: plate.index,
    fileName: plate.fileName,
    appliedScale: normalized.appliedScale,
    bounds: plate.bounds,
    utilization: plate.utilization,
    channels: plate.channels,
    entities: Object.freeze(
      plate.entities.map((entity) =>
        Object.freeze({
          ...entity,
          position: Object.freeze({
            x: (entity.bounds.minimum.x + entity.bounds.maximum.x) / 2,
            y: (entity.bounds.minimum.y + entity.bounds.maximum.y) / 2,
            z: (entity.bounds.minimum.z + entity.bounds.maximum.z) / 2,
          }),
          size: entity.bounds.size,
        }),
      ),
    ),
    routes: plate.routes ?? Object.freeze([]),
    warnings: plate.warnings,
  });
}

function stateFor(
  mode: PrintPreviewMode,
  plan: PrintLayoutPreviewPlan | undefined,
  selectedPlateId: string | undefined,
): PrintPlatePreviewState {
  const selected =
    plan?.plates.find(({ id }) => id === selectedPlateId) ??
    plan?.plates[0];
  const selectedId = selected?.id;
  const selectorOptions =
    plan?.plates.map((plate) =>
      Object.freeze({
        id: plate.id,
        label: `Plate ${plate.index + 1} \u00b7 ${Math.round(
          plate.utilization * 100,
        )}%`,
        selected: plate.id === selectedId,
      }),
    ) ?? [];
  return Object.freeze({
    mode: plan === undefined ? "city" : mode,
    ...(plan === undefined ? {} : { plan }),
    ...(selectedId === undefined ? {} : { selectedPlateId: selectedId }),
    selectorOptions: Object.freeze(selectorOptions),
    ...(mode !== "plates" || plan === undefined || selectedId === undefined
      ? {}
      : { projection: projectNormalizedPrintPlate(plan, selectedId) }),
  });
}

export class PrintPlatePreviewController {
  private readonly onStateChange:
    | ((state: PrintPlatePreviewState) => void)
    | undefined;
  private currentState: PrintPlatePreviewState = stateFor(
    "city",
    undefined,
    undefined,
  );

  public constructor(options: PrintPlatePreviewControllerOptions = {}) {
    this.onStateChange = options.onStateChange;
  }

  public get state(): PrintPlatePreviewState {
    return this.currentState;
  }

  public setPlan(plan: PrintLayoutPreviewPlan | undefined): void {
    const normalized =
      plan === undefined ? undefined : normalizePrintLayoutPreviewPlan(plan);
    this.update(
      stateFor(
        this.currentState.mode,
        normalized,
        this.currentState.selectedPlateId,
      ),
    );
  }

  public show(mode: PrintPreviewMode): void {
    if (!PRINT_PREVIEW_MODES.includes(mode)) {
      throw new TypeError("Unknown print preview mode.");
    }
    this.update(
      stateFor(
        mode,
        this.currentState.plan,
        this.currentState.selectedPlateId,
      ),
    );
  }

  public selectPlate(plateId: string): void {
    const plan = this.currentState.plan;
    if (plan === undefined || !plan.plates.some(({ id }) => id === plateId)) {
      throw new RangeError("Selected print plate is unavailable.");
    }
    this.update(stateFor("plates", plan, plateId));
  }

  private update(state: PrintPlatePreviewState): void {
    this.currentState = state;
    this.onStateChange?.(state);
  }
}
