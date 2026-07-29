import type { PrinterGeometryLimits } from "../../core/src/print.js";

import {
  cuboidMesh,
  type PrintBounds,
  type PrintPoint,
  type PrintPrimitive,
} from "./geometry.js";

export const PRINT_DEPENDENCY_ROUTE_LIMIT = 24;
export const PRINT_DEPENDENCY_ROUTE_SEMANTIC_GROUP_ID = "routes" as const;

const EPSILON = 1e-7;
const ARROW_STEP_COUNT = 3;
const MAX_GATEWAYS_PER_SIDE = 9;
const MAX_GATEWAY_PAIRS = 96;
const MAX_ROUTING_GRAPH_NODES = 100_000;
const MAX_ROUTING_SEARCH_NODES = 300_000;

export interface PrintRoutePoint2D {
  readonly x: number;
  readonly y: number;
}

export interface PrintRouteBounds2D {
  readonly minimum: PrintRoutePoint2D;
  readonly maximum: PrintRoutePoint2D;
}

export interface PrintRouteEndpoint {
  /**
   * Internal lookup key only. It is never copied to a printable primitive id.
   */
  readonly id: string;
  readonly bounds: PrintRouteBounds2D;
}

export interface PrintRouteObstacle {
  readonly bounds: PrintRouteBounds2D;
}

export interface PrintDependencyRouteBundle {
  /**
   * Stable aggregation key used only as a deterministic tie-breaker.
   * It is never copied to printable output.
   */
  readonly id: string;
  readonly sourceEndpointId: string;
  readonly targetEndpointId: string;
  readonly weight: number;
}

export interface PlanPrintableDependencyRoutesRequest {
  readonly bundles: readonly PrintDependencyRouteBundle[];
  readonly endpoints: readonly PrintRouteEndpoint[];
  readonly obstacles?: readonly PrintRouteObstacle[];
  readonly baseBounds: PrintBounds;
  readonly geometryLimits: Pick<
    PrinterGeometryLimits,
    | "minimumFeatureSize"
    | "minimumGap"
    | "minimumWallThickness"
    | "lineWidth"
    | "minimumRaisedFeatureHeight"
    | "minimumRouteWidth"
  >;
  readonly channelId: string;
  /**
   * Test and small-model override. The hard public ceiling remains 24.
   */
  readonly maximumRoutes?: number;
}

export type PrintDependencyRouteWidthClass = 1 | 2 | 3;

export interface PlannedPrintableDependencyRoute {
  readonly bundleId: string;
  readonly ordinal: number;
  readonly widthClass: PrintDependencyRouteWidthClass;
  readonly weight: number;
  readonly primitiveIds: readonly string[];
}

export type PrintableDependencyRouteOmissionReason =
  | "route-limit"
  | "unresolved-endpoint"
  | "unroutable";

export interface PrintableDependencyRouteOmission {
  readonly bundleId: string;
  readonly reason: PrintableDependencyRouteOmissionReason;
  readonly weight: number;
}

export interface PrintableDependencyRouteReport {
  readonly totalRouteCount: number;
  readonly printedRouteCount: number;
  readonly omittedRouteCount: number;
  readonly cappedRouteCount: number;
  readonly unresolvedEndpointRouteCount: number;
  readonly unroutableRouteCount: number;
  readonly totalWeight: number;
  readonly printedWeight: number;
  readonly omittedWeight: number;
}

export interface PrintableDependencyRoutes {
  readonly primitives: readonly PrintPrimitive[];
  readonly routes: readonly PlannedPrintableDependencyRoute[];
  readonly omissions: readonly PrintableDependencyRouteOmission[];
  readonly report: PrintableDependencyRouteReport;
}

type Side = "left" | "right" | "bottom" | "top";
type TravelDirection = 0 | 1 | 2;

interface MutableRectangle {
  readonly minimum: PrintRoutePoint2D;
  readonly maximum: PrintRoutePoint2D;
}

interface Gateway {
  readonly side: Side;
  readonly point: PrintRoutePoint2D;
  readonly escape: PrintRoutePoint2D;
  readonly rank: number;
}

interface RouteRectangle {
  readonly role: "trace" | "arrow";
  readonly bounds: MutableRectangle;
}

interface HeapItem {
  readonly state: number;
  readonly priority: number;
  readonly cost: number;
}

interface RoutingSearchBudget {
  remainingNodes: number;
}

const SIDE_ORDER: readonly Side[] = Object.freeze([
  "right",
  "left",
  "top",
  "bottom",
]);

/**
 * Maps aggregate weight to exactly three bounded printable width classes.
 * The logarithmic bands prevent a single large dependency count from
 * dominating the city.
 */
export function dependencyRouteWidthClass(
  weight: number,
): PrintDependencyRouteWidthClass {
  if (!Number.isFinite(weight) || weight <= 0) {
    throw new RangeError("Dependency route weight must be positive.");
  }
  if (weight >= 4) return 3;
  if (weight >= 2) return 2;
  return 1;
}

/**
 * Plans shallow, base-connected Manhattan traces. Stronger aggregate bundles
 * are routed first; later routes treat accepted traces as obstacles. A
 * three-step taper at the provider end is the consumer-to-provider cue.
 */
export function planPrintableDependencyRoutes(
  request: PlanPrintableDependencyRoutesRequest,
): PrintableDependencyRoutes {
  validateRequest(request);
  const maximumRoutes =
    request.maximumRoutes ?? PRINT_DEPENDENCY_ROUTE_LIMIT;
  const legacyFeatureSize = Math.max(
    request.geometryLimits.minimumFeatureSize,
    request.geometryLimits.minimumWallThickness,
  );
  const routeWidth = Math.max(
    legacyFeatureSize,
    request.geometryLimits.minimumRouteWidth ??
      Math.max(
        request.geometryLimits.minimumFeatureSize,
        request.geometryLimits.lineWidth ??
          request.geometryLimits.minimumWallThickness,
      ),
  );
  const routeHeight = Math.max(
    legacyFeatureSize,
    request.geometryLimits.minimumRaisedFeatureHeight ??
      request.geometryLimits.minimumFeatureSize,
  );
  const minimumGap = request.geometryLimits.minimumGap;
  const arrowLength = routeWidth * ARROW_STEP_COUNT;
  const maximumWidth = routeWidth * 3;
  const maximumHalfWidth = maximumWidth / 2;
  const clearance = maximumHalfWidth + minimumGap;
  // Leave one full printable feature between a possible gateway bend and the
  // stepped arrow. Otherwise trimming the bend can create a sub-minimum sliver.
  const escapeDistance = arrowLength + clearance + routeWidth;
  const baseFootprint = footprint(request.baseBounds);
  const routingBounds = inset(baseFootprint, maximumHalfWidth);
  const endpoints = new Map(
    request.endpoints.map((endpoint) => [endpoint.id, endpoint]),
  );
  const fixedObstacles = deduplicateRectangles([
    ...request.endpoints.map(({ bounds }) => copyRectangle(bounds)),
    ...(request.obstacles ?? []).map(({ bounds }) =>
      copyRectangle(bounds),
    ),
  ]);
  const ranked = [...request.bundles].sort(compareBundles);
  const candidates = ranked.slice(0, maximumRoutes);
  const capped = ranked.slice(maximumRoutes);
  const acceptedFootprints: MutableRectangle[] = [];
  const primitives: PrintPrimitive[] = [];
  const routes: PlannedPrintableDependencyRoute[] = [];
  const omissionReasons = new Map<
    string,
    PrintableDependencyRouteOmissionReason
  >(
    capped.map(({ id }) => [id, "route-limit"]),
  );
  const printedBundleIds = new Set<string>();
  let unresolvedEndpointRouteCount = 0;
  let unroutableRouteCount = 0;
  let printedWeight = 0;

  for (const bundle of candidates) {
    const source = endpoints.get(bundle.sourceEndpointId);
    const target = endpoints.get(bundle.targetEndpointId);
    if (!source || !target) {
      unresolvedEndpointRouteCount += 1;
      omissionReasons.set(bundle.id, "unresolved-endpoint");
      continue;
    }
    if (
      source.id === target.id ||
      rectanglesOverlapPositive(source.bounds, target.bounds)
    ) {
      unroutableRouteCount += 1;
      omissionReasons.set(bundle.id, "unroutable");
      continue;
    }
    const widthClass = dependencyRouteWidthClass(bundle.weight);
    const path = routeBetweenEndpoints(
      source.bounds,
      target.bounds,
      fixedObstacles,
      acceptedFootprints,
      routingBounds,
      routeWidth,
      minimumGap,
      maximumHalfWidth,
      escapeDistance,
    );
    if (!path) {
      unroutableRouteCount += 1;
      omissionReasons.set(bundle.id, "unroutable");
      continue;
    }
    const rectangles = routeRectangles(
      path,
      widthClass * routeWidth,
      routeWidth,
      arrowLength,
    );
    if (
      !rectangles ||
      !routeRectanglesAreValid(
        rectangles,
        source.bounds,
        target.bounds,
        fixedObstacles,
        acceptedFootprints,
        baseFootprint,
        routeWidth,
        minimumGap,
      )
    ) {
      unroutableRouteCount += 1;
      omissionReasons.set(bundle.id, "unroutable");
      continue;
    }

    const ordinal = routes.length;
    const routePrimitives = rectangles.map((rectangle, index) =>
      routePrimitive(
        ordinal,
        rectangle,
        index,
        request.channelId,
        request.baseBounds.maximum.z,
        routeHeight,
      ),
    );
    primitives.push(...routePrimitives);
    acceptedFootprints.push(
      ...rectangles.map(({ bounds }) => copyRectangle(bounds)),
    );
    printedWeight = addWeight(printedWeight, bundle.weight);
    printedBundleIds.add(bundle.id);
    routes.push({
      bundleId: bundle.id,
      ordinal,
      widthClass,
      weight: bundle.weight,
      primitiveIds: routePrimitives.map(({ id }) => id),
    });
  }

  const totalWeight = sumWeights(ranked);
  const omittedWeight = sumWeights(
    ranked.filter(({ id }) => !printedBundleIds.has(id)),
  );
  const omissions = ranked
    .filter(({ id }) => !printedBundleIds.has(id))
    .map(({ id, weight }) => ({
      bundleId: id,
      reason: omissionReasons.get(id) ?? "unroutable",
      weight,
    }));
  return {
    primitives,
    routes,
    omissions,
    report: {
      totalRouteCount: ranked.length,
      printedRouteCount: routes.length,
      omittedRouteCount: ranked.length - routes.length,
      cappedRouteCount: capped.length,
      unresolvedEndpointRouteCount,
      unroutableRouteCount,
      totalWeight,
      printedWeight,
      omittedWeight,
    },
  };
}

function validateRequest(
  request: PlanPrintableDependencyRoutesRequest,
): void {
  assertBounds3D(request.baseBounds, "Route base");
  if (request.channelId.trim() === "") {
    throw new TypeError("Dependency route channel id must not be empty.");
  }
  for (const [name, value] of [
    [
      "minimum feature size",
      request.geometryLimits.minimumFeatureSize,
    ],
    [
      "minimum wall thickness",
      request.geometryLimits.minimumWallThickness,
    ],
    ["minimum gap", request.geometryLimits.minimumGap],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new RangeError(`Dependency route ${name} must be positive.`);
    }
  }
  for (const [name, value] of [
    ["line width", request.geometryLimits.lineWidth],
    [
      "minimum raised feature height",
      request.geometryLimits.minimumRaisedFeatureHeight,
    ],
    ["minimum route width", request.geometryLimits.minimumRouteWidth],
  ] as const) {
    if (
      value !== undefined &&
      (!Number.isFinite(value) || value <= 0)
    ) {
      throw new RangeError(`Dependency route ${name} must be positive.`);
    }
  }
  const maximumRoutes =
    request.maximumRoutes ?? PRINT_DEPENDENCY_ROUTE_LIMIT;
  if (
    !Number.isSafeInteger(maximumRoutes) ||
    maximumRoutes < 1 ||
    maximumRoutes > PRINT_DEPENDENCY_ROUTE_LIMIT
  ) {
    throw new RangeError(
      `Dependency route cap must be an integer from 1 through ${PRINT_DEPENDENCY_ROUTE_LIMIT}.`,
    );
  }
  const endpointIds = new Set<string>();
  for (const endpoint of request.endpoints) {
    if (endpoint.id.trim() === "") {
      throw new TypeError("Dependency route endpoint id must not be empty.");
    }
    if (endpointIds.has(endpoint.id)) {
      throw new TypeError(
        `Duplicate dependency route endpoint '${endpoint.id}'.`,
      );
    }
    endpointIds.add(endpoint.id);
    assertRectangle(endpoint.bounds, "Dependency route endpoint");
  }
  for (const obstacle of request.obstacles ?? []) {
    assertRectangle(obstacle.bounds, "Dependency route obstacle");
  }
  const bundleIds = new Set<string>();
  for (const bundle of request.bundles) {
    if (
      bundle.id.trim() === "" ||
      bundle.sourceEndpointId.trim() === "" ||
      bundle.targetEndpointId.trim() === ""
    ) {
      throw new TypeError(
        "Dependency route bundle and endpoint ids must not be empty.",
      );
    }
    if (bundleIds.has(bundle.id)) {
      throw new TypeError(
        `Duplicate dependency route bundle '${bundle.id}'.`,
      );
    }
    bundleIds.add(bundle.id);
    dependencyRouteWidthClass(bundle.weight);
  }
}

function assertBounds3D(value: PrintBounds, label: string): void {
  for (const axis of ["x", "y", "z"] as const) {
    if (
      !Number.isFinite(value.minimum[axis]) ||
      !Number.isFinite(value.maximum[axis]) ||
      !Number.isFinite(value.size[axis]) ||
      value.maximum[axis] - value.minimum[axis] <= 0 ||
      Math.abs(
        value.maximum[axis] -
          value.minimum[axis] -
          value.size[axis],
      ) > EPSILON
    ) {
      throw new RangeError(`${label} ${axis.toUpperCase()} bounds are invalid.`);
    }
  }
}

function assertRectangle(
  value: PrintRouteBounds2D,
  label: string,
): void {
  for (const axis of ["x", "y"] as const) {
    if (
      !Number.isFinite(value.minimum[axis]) ||
      !Number.isFinite(value.maximum[axis]) ||
      value.maximum[axis] - value.minimum[axis] <= 0
    ) {
      throw new RangeError(`${label} ${axis.toUpperCase()} bounds are invalid.`);
    }
  }
}

function compareBundles(
  left: PrintDependencyRouteBundle,
  right: PrintDependencyRouteBundle,
): number {
  return (
    right.weight - left.weight ||
    compare(left.sourceEndpointId, right.sourceEndpointId) ||
    compare(left.targetEndpointId, right.targetEndpointId) ||
    compare(left.id, right.id)
  );
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function routeBetweenEndpoints(
  source: PrintRouteBounds2D,
  target: PrintRouteBounds2D,
  fixedObstacles: readonly MutableRectangle[],
  acceptedRoutes: readonly MutableRectangle[],
  routingBounds: MutableRectangle | undefined,
  featureSize: number,
  minimumGap: number,
  maximumHalfWidth: number,
  escapeDistance: number,
): readonly PrintRoutePoint2D[] | undefined {
  if (!routingBounds) return undefined;
  const obstacleCount =
    fixedObstacles.length + acceptedRoutes.length;
  const maximumAxisCoordinates = obstacleCount * 2 + 6;
  if (
    maximumAxisCoordinates * maximumAxisCoordinates >
    MAX_ROUTING_GRAPH_NODES
  ) {
    return undefined;
  }
  const searchBudget: RoutingSearchBudget = {
    remainingNodes: MAX_ROUTING_SEARCH_NODES,
  };
  const sourceGateways = gateways(
    source,
    center(target),
    routingBounds,
    featureSize * 3 + minimumGap,
    maximumHalfWidth,
    escapeDistance,
  );
  const targetGateways = gateways(
    target,
    center(source),
    routingBounds,
    featureSize * 3 + minimumGap,
    maximumHalfWidth,
    escapeDistance,
  );
  const pairs = sourceGateways
    .flatMap((sourceGateway) =>
      targetGateways.map((targetGateway) => ({
        source: sourceGateway,
        target: targetGateway,
        score:
          manhattan(sourceGateway.escape, targetGateway.escape) +
          (sourceGateway.rank + targetGateway.rank) * featureSize,
      })),
    )
    .sort(
      (left, right) =>
        left.score - right.score ||
        left.source.rank - right.source.rank ||
        left.target.rank - right.target.rank ||
        comparePoints(left.source.point, right.source.point) ||
        comparePoints(left.target.point, right.target.point),
    )
    .slice(0, MAX_GATEWAY_PAIRS);
  const inflated = [
    ...fixedObstacles,
    ...acceptedRoutes,
  ].map((rectangle) =>
    inflate(rectangle, maximumHalfWidth + minimumGap),
  );

  for (const pair of pairs) {
    if (searchBudget.remainingNodes <= 0) break;
    if (
      !stubIsClear(
        pair.source.point,
        pair.source.escape,
        source,
        target,
        fixedObstacles,
        acceptedRoutes,
        featureSize * 3,
        minimumGap,
      ) ||
      !stubIsClear(
        pair.target.point,
        pair.target.escape,
        target,
        source,
        fixedObstacles,
        acceptedRoutes,
        featureSize * 3,
        minimumGap,
      )
    ) {
      continue;
    }
    const middle = findManhattanPath(
      pair.source.escape,
      pair.target.escape,
      routingBounds,
      inflated,
      featureSize,
      searchBudget,
    );
    if (!middle) continue;
    return simplifyPath([
      pair.source.point,
      ...middle,
      pair.target.point,
    ]);
  }
  return undefined;
}

function gateways(
  rectangle: PrintRouteBounds2D,
  toward: PrintRoutePoint2D,
  routingBounds: MutableRectangle,
  pitch: number,
  maximumHalfWidth: number,
  escapeDistance: number,
): readonly Gateway[] {
  const result: Gateway[] = [];
  const sideRanks = SIDE_ORDER.map((side, sideIndex) => {
    const middle = sidePoint(rectangle, side, center(rectangle));
    const escape = moveOutward(middle, side, escapeDistance);
    return {
      side,
      sideIndex,
      score: manhattan(escape, toward),
    };
  }).sort(
    (left, right) =>
      left.score - right.score || left.sideIndex - right.sideIndex,
  );

  for (const [sideRank, { side }] of sideRanks.entries()) {
    const horizontalSide = side === "top" || side === "bottom";
    const minimum =
      rectangle.minimum[horizontalSide ? "x" : "y"] +
      maximumHalfWidth;
    const maximum =
      rectangle.maximum[horizontalSide ? "x" : "y"] -
      maximumHalfWidth;
    if (maximum + EPSILON < minimum) continue;
    const middle = (minimum + maximum) / 2;
    const positions = centeredLanePositions(
      minimum,
      maximum,
      middle,
      pitch,
      routingBounds.minimum[horizontalSide ? "x" : "y"],
    );
    for (const [offsetRank, position] of positions.entries()) {
      const point = sidePoint(
        rectangle,
        side,
        horizontalSide
          ? { x: position, y: middle }
          : { x: middle, y: position },
      );
      const escape = moveOutward(point, side, escapeDistance);
      if (!containsPoint(routingBounds, escape)) continue;
      result.push({
        side,
        point,
        escape,
        rank: sideRank * MAX_GATEWAYS_PER_SIDE + offsetRank,
      });
    }
  }
  return result;
}

function centeredLanePositions(
  minimum: number,
  maximum: number,
  middle: number,
  pitch: number,
  origin: number,
): readonly number[] {
  const candidates = [middle];
  const nearestLane = Math.round((middle - origin) / pitch);
  for (let step = 0; step <= MAX_GATEWAYS_PER_SIDE; step += 1) {
    for (const lane of new Set([
      nearestLane - step,
      nearestLane + step,
    ])) {
      const candidate = origin + lane * pitch;
      if (
        candidate >= minimum - EPSILON &&
        candidate <= maximum + EPSILON
      ) {
        candidates.push(candidate);
      }
    }
  }
  return [...new Set(candidates)]
    .sort(
      (left, right) =>
        Math.abs(left - middle) - Math.abs(right - middle) ||
        left - right,
    )
    .slice(0, MAX_GATEWAYS_PER_SIDE);
}

function sidePoint(
  rectangle: PrintRouteBounds2D,
  side: Side,
  position: PrintRoutePoint2D,
): PrintRoutePoint2D {
  switch (side) {
    case "left":
      return { x: rectangle.minimum.x, y: position.y };
    case "right":
      return { x: rectangle.maximum.x, y: position.y };
    case "bottom":
      return { x: position.x, y: rectangle.minimum.y };
    case "top":
      return { x: position.x, y: rectangle.maximum.y };
  }
}

function moveOutward(
  point: PrintRoutePoint2D,
  side: Side,
  distance: number,
): PrintRoutePoint2D {
  switch (side) {
    case "left":
      return { x: point.x - distance, y: point.y };
    case "right":
      return { x: point.x + distance, y: point.y };
    case "bottom":
      return { x: point.x, y: point.y - distance };
    case "top":
      return { x: point.x, y: point.y + distance };
  }
}

function stubIsClear(
  gateway: PrintRoutePoint2D,
  escape: PrintRoutePoint2D,
  ownEndpoint: PrintRouteBounds2D,
  otherEndpoint: PrintRouteBounds2D,
  fixedObstacles: readonly MutableRectangle[],
  acceptedRoutes: readonly MutableRectangle[],
  width: number,
  minimumGap: number,
): boolean {
  const stub = segmentRectangle(gateway, escape, width, 0, 0);
  if (!stub) return false;
  for (const obstacle of fixedObstacles) {
    if (sameRectangle(obstacle, ownEndpoint)) {
      if (rectanglesOverlapPositive(stub, obstacle)) return false;
      continue;
    }
    if (
      rectanglesOverlapPositive(stub, obstacle) ||
      rectangleDistance(stub, obstacle) + EPSILON < minimumGap
    ) {
      return false;
    }
  }
  if (
    rectanglesOverlapPositive(stub, otherEndpoint) ||
    rectangleDistance(stub, otherEndpoint) + EPSILON < minimumGap
  ) {
    return false;
  }
  return acceptedRoutes.every(
    (route) =>
      !rectanglesOverlapPositive(stub, route) &&
      rectangleDistance(stub, route) + EPSILON >= minimumGap,
  );
}

function findManhattanPath(
  start: PrintRoutePoint2D,
  target: PrintRoutePoint2D,
  routingBounds: MutableRectangle,
  obstacles: readonly MutableRectangle[],
  turnScale: number,
  searchBudget: RoutingSearchBudget,
): readonly PrintRoutePoint2D[] | undefined {
  const relevantObstacles = obstacles.filter((obstacle) =>
    rectanglesOverlapOrTouch(obstacle, routingBounds),
  );
  if (
    !pointIsFree(start, routingBounds, relevantObstacles) ||
    !pointIsFree(target, routingBounds, relevantObstacles)
  ) {
    return undefined;
  }
  const xs = uniqueSorted([
    routingBounds.minimum.x,
    routingBounds.maximum.x,
    start.x,
    target.x,
    ...relevantObstacles.flatMap(({ minimum, maximum }) => [
      clamp(minimum.x, routingBounds.minimum.x, routingBounds.maximum.x),
      clamp(maximum.x, routingBounds.minimum.x, routingBounds.maximum.x),
    ]),
  ]);
  const ys = uniqueSorted([
    routingBounds.minimum.y,
    routingBounds.maximum.y,
    start.y,
    target.y,
    ...relevantObstacles.flatMap(({ minimum, maximum }) => [
      clamp(minimum.y, routingBounds.minimum.y, routingBounds.maximum.y),
      clamp(maximum.y, routingBounds.minimum.y, routingBounds.maximum.y),
    ]),
  ]);
  const nodeCount = xs.length * ys.length;
  if (
    !Number.isSafeInteger(nodeCount) ||
    nodeCount > MAX_ROUTING_GRAPH_NODES ||
    nodeCount > searchBudget.remainingNodes
  ) {
    searchBudget.remainingNodes = 0;
    return undefined;
  }
  searchBudget.remainingNodes -= nodeCount;
  const valid = new Uint8Array(nodeCount);
  for (let yIndex = 0; yIndex < ys.length; yIndex += 1) {
    for (let xIndex = 0; xIndex < xs.length; xIndex += 1) {
      const point = {
        x: xs[xIndex]!,
        y: ys[yIndex]!,
      };
      if (pointIsFree(point, routingBounds, relevantObstacles)) {
        valid[nodeIndex(xIndex, yIndex, xs.length)] = 1;
      }
    }
  }
  const startX = coordinateIndex(xs, start.x);
  const startY = coordinateIndex(ys, start.y);
  const targetX = coordinateIndex(xs, target.x);
  const targetY = coordinateIndex(ys, target.y);
  if (
    startX < 0 ||
    startY < 0 ||
    targetX < 0 ||
    targetY < 0
  ) {
    return undefined;
  }
  const startNode = nodeIndex(startX, startY, xs.length);
  const targetNode = nodeIndex(targetX, targetY, xs.length);
  const stateCount = nodeCount * 3;
  const distances = new Float64Array(stateCount);
  distances.fill(Number.POSITIVE_INFINITY);
  const previous = new Int32Array(stateCount);
  previous.fill(-1);
  const startState = stateIndex(startNode, 0);
  distances[startState] = 0;
  const heap: HeapItem[] = [];
  heapPush(heap, {
    state: startState,
    priority: manhattan(start, target),
    cost: 0,
  });
  let finalState = -1;

  while (heap.length > 0) {
    const current = heapPop(heap)!;
    if (current.cost > distances[current.state]! + EPSILON) continue;
    const currentNode = Math.floor(current.state / 3);
    const currentDirection = (current.state % 3) as TravelDirection;
    if (currentNode === targetNode) {
      finalState = current.state;
      break;
    }
    const xIndex = currentNode % xs.length;
    const yIndex = Math.floor(currentNode / xs.length);
    for (const [nextX, nextY, direction] of [
      [xIndex - 1, yIndex, 1],
      [xIndex + 1, yIndex, 1],
      [xIndex, yIndex - 1, 2],
      [xIndex, yIndex + 1, 2],
    ] as const) {
      if (
        nextX < 0 ||
        nextX >= xs.length ||
        nextY < 0 ||
        nextY >= ys.length
      ) {
        continue;
      }
      const nextNode = nodeIndex(nextX, nextY, xs.length);
      if (valid[nextNode] === 0) continue;
      const from = { x: xs[xIndex]!, y: ys[yIndex]! };
      const to = { x: xs[nextX]!, y: ys[nextY]! };
      if (!segmentIsFree(from, to, relevantObstacles)) continue;
      const turnCost =
        currentDirection !== 0 && currentDirection !== direction
          ? turnScale / 10
          : 0;
      const nextCost =
        current.cost + manhattan(from, to) + turnCost;
      const nextState = stateIndex(nextNode, direction);
      if (
        nextCost + EPSILON < distances[nextState]! ||
        (Math.abs(nextCost - distances[nextState]!) <= EPSILON &&
          current.state < previous[nextState]!)
      ) {
        distances[nextState] = nextCost;
        previous[nextState] = current.state;
        heapPush(heap, {
          state: nextState,
          cost: nextCost,
          priority: nextCost + manhattan(to, target),
        });
      }
    }
  }
  if (finalState < 0) return undefined;
  const points: PrintRoutePoint2D[] = [];
  let state = finalState;
  while (state >= 0) {
    const node = Math.floor(state / 3);
    points.push({
      x: xs[node % xs.length]!,
      y: ys[Math.floor(node / xs.length)]!,
    });
    state = previous[state]!;
  }
  return simplifyPath(points.reverse());
}

function routeRectangles(
  path: readonly PrintRoutePoint2D[],
  routeWidth: number,
  featureSize: number,
  arrowLength: number,
): readonly RouteRectangle[] | undefined {
  const simplified = simplifyPath(path);
  if (simplified.length < 2) return undefined;
  const target = simplified.at(-1)!;
  const beforeTarget = simplified.at(-2)!;
  const lastLength = manhattan(beforeTarget, target);
  if (lastLength + EPSILON < arrowLength + featureSize) {
    return undefined;
  }
  const lastUnit = unitDirection(beforeTarget, target);
  if (!lastUnit) return undefined;
  const arrowStart = {
    x: target.x - lastUnit.x * arrowLength,
    y: target.y - lastUnit.y * arrowLength,
  };
  const tracePoints = simplifyPath([
    ...simplified.slice(0, -1),
    arrowStart,
  ]);
  const traceBounds = polylineRectangles(tracePoints, routeWidth);
  if (!traceBounds) return undefined;
  const result: RouteRectangle[] = traceBounds.map((bounds) => ({
    role: "trace",
    bounds,
  }));
  for (let step = 0; step < ARROW_STEP_COUNT; step += 1) {
    const start = {
      x: arrowStart.x + lastUnit.x * step * featureSize,
      y: arrowStart.y + lastUnit.y * step * featureSize,
    };
    const end = {
      x: arrowStart.x + lastUnit.x * (step + 1) * featureSize,
      y: arrowStart.y + lastUnit.y * (step + 1) * featureSize,
    };
    const arrow = segmentRectangle(
      start,
      end,
      (ARROW_STEP_COUNT - step) * featureSize,
      0,
      0,
    );
    if (!arrow) return undefined;
    result.push({ role: "arrow", bounds: arrow });
  }
  return result;
}

function polylineRectangles(
  path: readonly PrintRoutePoint2D[],
  width: number,
): readonly MutableRectangle[] | undefined {
  if (path.length < 2) return undefined;
  const rectangles: MutableRectangle[] = [];
  for (let index = 1; index < path.length - 1; index += 1) {
    const point = path[index]!;
    rectangles.push({
      minimum: {
        x: point.x - width / 2,
        y: point.y - width / 2,
      },
      maximum: {
        x: point.x + width / 2,
        y: point.y + width / 2,
      },
    });
  }
  for (let index = 0; index < path.length - 1; index += 1) {
    const rectangle = segmentRectangle(
      path[index]!,
      path[index + 1]!,
      width,
      index === 0 ? 0 : width / 2,
      index === path.length - 2 ? 0 : width / 2,
    );
    if (!rectangle) return undefined;
    rectangles.push(rectangle);
  }
  return rectangles;
}

function segmentRectangle(
  start: PrintRoutePoint2D,
  end: PrintRoutePoint2D,
  width: number,
  trimStart: number,
  trimEnd: number,
): MutableRectangle | undefined {
  if (Math.abs(start.y - end.y) <= EPSILON) {
    const increasing = end.x > start.x;
    const minimum =
      Math.min(start.x, end.x) +
      (increasing ? trimStart : trimEnd);
    const maximum =
      Math.max(start.x, end.x) -
      (increasing ? trimEnd : trimStart);
    if (maximum - minimum <= EPSILON) return undefined;
    return {
      minimum: { x: minimum, y: start.y - width / 2 },
      maximum: { x: maximum, y: start.y + width / 2 },
    };
  }
  if (Math.abs(start.x - end.x) <= EPSILON) {
    const increasing = end.y > start.y;
    const minimum =
      Math.min(start.y, end.y) +
      (increasing ? trimStart : trimEnd);
    const maximum =
      Math.max(start.y, end.y) -
      (increasing ? trimEnd : trimStart);
    if (maximum - minimum <= EPSILON) return undefined;
    return {
      minimum: { x: start.x - width / 2, y: minimum },
      maximum: { x: start.x + width / 2, y: maximum },
    };
  }
  return undefined;
}

function routeRectanglesAreValid(
  rectangles: readonly RouteRectangle[],
  source: PrintRouteBounds2D,
  target: PrintRouteBounds2D,
  fixedObstacles: readonly MutableRectangle[],
  acceptedRoutes: readonly MutableRectangle[],
  base: MutableRectangle,
  featureSize: number,
  minimumGap: number,
): boolean {
  if (
    rectangles.some(
      ({ bounds }) =>
        !containsRectangle(base, bounds) ||
        rectangleWidth(bounds) + EPSILON < featureSize ||
        rectangleHeight(bounds) + EPSILON < featureSize,
    )
  ) {
    return false;
  }
  for (const { bounds } of rectangles) {
    for (const obstacle of fixedObstacles) {
      if (rectanglesOverlapPositive(bounds, obstacle)) return false;
      if (
        !sameRectangle(obstacle, source) &&
        !sameRectangle(obstacle, target) &&
        rectangleDistance(bounds, obstacle) + EPSILON < minimumGap
      ) {
        return false;
      }
    }
    for (const accepted of acceptedRoutes) {
      if (
        rectanglesOverlapPositive(bounds, accepted) ||
        rectangleDistance(bounds, accepted) + EPSILON < minimumGap
      ) {
        return false;
      }
    }
  }
  for (let left = 0; left < rectangles.length; left += 1) {
    for (let right = left + 1; right < rectangles.length; right += 1) {
      const leftBounds = rectangles[left]!.bounds;
      const rightBounds = rectangles[right]!.bounds;
      if (rectanglesOverlapPositive(leftBounds, rightBounds)) return false;
      const distance = rectangleDistance(leftBounds, rightBounds);
      if (distance > EPSILON && distance + EPSILON < minimumGap) {
        return false;
      }
    }
  }
  return (
    rectangles.some(({ bounds }) =>
      rectanglesHavePositiveEdgeContact(bounds, source),
    ) &&
    rectangles.some(({ bounds }) =>
      rectanglesHavePositiveEdgeContact(bounds, target),
    )
  );
}

function routePrimitive(
  routeOrdinal: number,
  rectangle: RouteRectangle,
  pieceOrdinal: number,
  channelId: string,
  baseTop: number,
  featureSize: number,
): PrintPrimitive {
  const primitiveBounds = bounds3D(
    {
      x: rectangle.bounds.minimum.x,
      y: rectangle.bounds.minimum.y,
      z: baseTop,
    },
    {
      x: rectangle.bounds.maximum.x,
      y: rectangle.bounds.maximum.y,
      z: baseTop + featureSize,
    },
  );
  const id = `dependency-route:${ordinal(routeOrdinal)}:${rectangle.role}:${ordinal(pieceOrdinal)}`;
  return {
    id,
    kind: "dependency-trace",
    semanticGroupId: PRINT_DEPENDENCY_ROUTE_SEMANTIC_GROUP_ID,
    channelId,
    bounds: primitiveBounds,
    mesh: cuboidMesh(primitiveBounds),
  };
}

function bounds3D(minimum: PrintPoint, maximum: PrintPoint): PrintBounds {
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

function footprint(value: PrintBounds): MutableRectangle {
  return {
    minimum: { x: value.minimum.x, y: value.minimum.y },
    maximum: { x: value.maximum.x, y: value.maximum.y },
  };
}

function copyRectangle(
  value: PrintRouteBounds2D,
): MutableRectangle {
  return {
    minimum: { ...value.minimum },
    maximum: { ...value.maximum },
  };
}

function deduplicateRectangles(
  values: readonly MutableRectangle[],
): readonly MutableRectangle[] {
  const result: MutableRectangle[] = [];
  for (const value of values) {
    if (!result.some((existing) => sameRectangle(existing, value))) {
      result.push(value);
    }
  }
  return result;
}

function sameRectangle(
  left: PrintRouteBounds2D,
  right: PrintRouteBounds2D,
): boolean {
  return (
    Math.abs(left.minimum.x - right.minimum.x) <= EPSILON &&
    Math.abs(left.minimum.y - right.minimum.y) <= EPSILON &&
    Math.abs(left.maximum.x - right.maximum.x) <= EPSILON &&
    Math.abs(left.maximum.y - right.maximum.y) <= EPSILON
  );
}

function inflate(
  rectangle: PrintRouteBounds2D,
  amount: number,
): MutableRectangle {
  return {
    minimum: {
      x: rectangle.minimum.x - amount,
      y: rectangle.minimum.y - amount,
    },
    maximum: {
      x: rectangle.maximum.x + amount,
      y: rectangle.maximum.y + amount,
    },
  };
}

function inset(
  rectangle: PrintRouteBounds2D,
  amount: number,
): MutableRectangle | undefined {
  const result = {
    minimum: {
      x: rectangle.minimum.x + amount,
      y: rectangle.minimum.y + amount,
    },
    maximum: {
      x: rectangle.maximum.x - amount,
      y: rectangle.maximum.y - amount,
    },
  };
  return rectangleWidth(result) > 0 && rectangleHeight(result) > 0
    ? result
    : undefined;
}

function center(
  rectangle: PrintRouteBounds2D,
): PrintRoutePoint2D {
  return {
    x: (rectangle.minimum.x + rectangle.maximum.x) / 2,
    y: (rectangle.minimum.y + rectangle.maximum.y) / 2,
  };
}

function containsPoint(
  rectangle: PrintRouteBounds2D,
  point: PrintRoutePoint2D,
): boolean {
  return (
    point.x >= rectangle.minimum.x - EPSILON &&
    point.x <= rectangle.maximum.x + EPSILON &&
    point.y >= rectangle.minimum.y - EPSILON &&
    point.y <= rectangle.maximum.y + EPSILON
  );
}

function containsRectangle(
  outer: PrintRouteBounds2D,
  inner: PrintRouteBounds2D,
): boolean {
  return (
    inner.minimum.x >= outer.minimum.x - EPSILON &&
    inner.minimum.y >= outer.minimum.y - EPSILON &&
    inner.maximum.x <= outer.maximum.x + EPSILON &&
    inner.maximum.y <= outer.maximum.y + EPSILON
  );
}

function pointIsFree(
  point: PrintRoutePoint2D,
  routingBounds: PrintRouteBounds2D,
  obstacles: readonly PrintRouteBounds2D[],
): boolean {
  return (
    containsPoint(routingBounds, point) &&
    obstacles.every((obstacle) => !pointStrictlyInside(point, obstacle))
  );
}

function pointStrictlyInside(
  point: PrintRoutePoint2D,
  rectangle: PrintRouteBounds2D,
): boolean {
  return (
    point.x > rectangle.minimum.x + EPSILON &&
    point.x < rectangle.maximum.x - EPSILON &&
    point.y > rectangle.minimum.y + EPSILON &&
    point.y < rectangle.maximum.y - EPSILON
  );
}

function segmentIsFree(
  start: PrintRoutePoint2D,
  end: PrintRoutePoint2D,
  obstacles: readonly PrintRouteBounds2D[],
): boolean {
  if (Math.abs(start.y - end.y) <= EPSILON) {
    const minimum = Math.min(start.x, end.x);
    const maximum = Math.max(start.x, end.x);
    return obstacles.every(
      (obstacle) =>
        start.y <= obstacle.minimum.y + EPSILON ||
        start.y >= obstacle.maximum.y - EPSILON ||
        Math.min(maximum, obstacle.maximum.x) -
          Math.max(minimum, obstacle.minimum.x) <=
          EPSILON,
    );
  }
  if (Math.abs(start.x - end.x) <= EPSILON) {
    const minimum = Math.min(start.y, end.y);
    const maximum = Math.max(start.y, end.y);
    return obstacles.every(
      (obstacle) =>
        start.x <= obstacle.minimum.x + EPSILON ||
        start.x >= obstacle.maximum.x - EPSILON ||
        Math.min(maximum, obstacle.maximum.y) -
          Math.max(minimum, obstacle.minimum.y) <=
          EPSILON,
    );
  }
  return false;
}

function rectanglesOverlapPositive(
  left: PrintRouteBounds2D,
  right: PrintRouteBounds2D,
): boolean {
  return (
    Math.min(left.maximum.x, right.maximum.x) -
      Math.max(left.minimum.x, right.minimum.x) >
      EPSILON &&
    Math.min(left.maximum.y, right.maximum.y) -
      Math.max(left.minimum.y, right.minimum.y) >
      EPSILON
  );
}

function rectanglesOverlapOrTouch(
  left: PrintRouteBounds2D,
  right: PrintRouteBounds2D,
): boolean {
  return (
    left.maximum.x + EPSILON >= right.minimum.x &&
    right.maximum.x + EPSILON >= left.minimum.x &&
    left.maximum.y + EPSILON >= right.minimum.y &&
    right.maximum.y + EPSILON >= left.minimum.y
  );
}

function rectanglesHavePositiveEdgeContact(
  left: PrintRouteBounds2D,
  right: PrintRouteBounds2D,
): boolean {
  const xTouch =
    Math.abs(left.maximum.x - right.minimum.x) <= EPSILON ||
    Math.abs(right.maximum.x - left.minimum.x) <= EPSILON;
  const yTouch =
    Math.abs(left.maximum.y - right.minimum.y) <= EPSILON ||
    Math.abs(right.maximum.y - left.minimum.y) <= EPSILON;
  const xOverlap =
    Math.min(left.maximum.x, right.maximum.x) -
      Math.max(left.minimum.x, right.minimum.x) >
    EPSILON;
  const yOverlap =
    Math.min(left.maximum.y, right.maximum.y) -
      Math.max(left.minimum.y, right.minimum.y) >
    EPSILON;
  return (xTouch && yOverlap) || (yTouch && xOverlap);
}

function rectangleDistance(
  left: PrintRouteBounds2D,
  right: PrintRouteBounds2D,
): number {
  const x = Math.max(
    0,
    Math.max(left.minimum.x, right.minimum.x) -
      Math.min(left.maximum.x, right.maximum.x),
  );
  const y = Math.max(
    0,
    Math.max(left.minimum.y, right.minimum.y) -
      Math.min(left.maximum.y, right.maximum.y),
  );
  return Math.hypot(x, y);
}

function rectangleWidth(rectangle: PrintRouteBounds2D): number {
  return rectangle.maximum.x - rectangle.minimum.x;
}

function rectangleHeight(rectangle: PrintRouteBounds2D): number {
  return rectangle.maximum.y - rectangle.minimum.y;
}

function simplifyPath(
  source: readonly PrintRoutePoint2D[],
): readonly PrintRoutePoint2D[] {
  const deduplicated: PrintRoutePoint2D[] = [];
  for (const point of source) {
    const previous = deduplicated.at(-1);
    if (!previous || manhattan(previous, point) > EPSILON) {
      deduplicated.push({ ...point });
    }
  }
  const result: PrintRoutePoint2D[] = [];
  for (const point of deduplicated) {
    while (result.length >= 2) {
      const before = result.at(-2)!;
      const previous = result.at(-1)!;
      const horizontal =
        Math.abs(before.y - previous.y) <= EPSILON &&
        Math.abs(previous.y - point.y) <= EPSILON;
      const vertical =
        Math.abs(before.x - previous.x) <= EPSILON &&
        Math.abs(previous.x - point.x) <= EPSILON;
      if (!horizontal && !vertical) break;
      result.pop();
    }
    result.push(point);
  }
  return result;
}

function unitDirection(
  start: PrintRoutePoint2D,
  end: PrintRoutePoint2D,
): PrintRoutePoint2D | undefined {
  if (Math.abs(start.y - end.y) <= EPSILON) {
    return { x: end.x > start.x ? 1 : -1, y: 0 };
  }
  if (Math.abs(start.x - end.x) <= EPSILON) {
    return { x: 0, y: end.y > start.y ? 1 : -1 };
  }
  return undefined;
}

function comparePoints(
  left: PrintRoutePoint2D,
  right: PrintRoutePoint2D,
): number {
  return left.x - right.x || left.y - right.y;
}

function manhattan(
  left: PrintRoutePoint2D,
  right: PrintRoutePoint2D,
): number {
  return Math.abs(left.x - right.x) + Math.abs(left.y - right.y);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function uniqueSorted(values: readonly number[]): readonly number[] {
  const sorted = [...values].sort((left, right) => left - right);
  const result: number[] = [];
  for (const value of sorted) {
    if (
      result.length === 0 ||
      Math.abs(value - result.at(-1)!) > EPSILON
    ) {
      result.push(value);
    }
  }
  return result;
}

function coordinateIndex(
  values: readonly number[],
  value: number,
): number {
  return values.findIndex(
    (candidate) => Math.abs(candidate - value) <= EPSILON,
  );
}

function nodeIndex(
  xIndex: number,
  yIndex: number,
  width: number,
): number {
  return yIndex * width + xIndex;
}

function stateIndex(node: number, direction: TravelDirection): number {
  return node * 3 + direction;
}

function heapPush(heap: HeapItem[], item: HeapItem): void {
  heap.push(item);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (compareHeapItems(heap[parent]!, item) <= 0) break;
    heap[index] = heap[parent]!;
    index = parent;
  }
  heap[index] = item;
}

function heapPop(heap: HeapItem[]): HeapItem | undefined {
  const result = heap[0];
  const tail = heap.pop();
  if (!result || !tail || heap.length === 0) return result;
  let index = 0;
  while (true) {
    const left = index * 2 + 1;
    const right = left + 1;
    if (left >= heap.length) break;
    let child = left;
    if (
      right < heap.length &&
      compareHeapItems(heap[right]!, heap[left]!) < 0
    ) {
      child = right;
    }
    if (compareHeapItems(tail, heap[child]!) <= 0) break;
    heap[index] = heap[child]!;
    index = child;
  }
  heap[index] = tail;
  return result;
}

function compareHeapItems(left: HeapItem, right: HeapItem): number {
  return (
    left.priority - right.priority ||
    left.cost - right.cost ||
    left.state - right.state
  );
}

function ordinal(value: number): string {
  return value.toString().padStart(3, "0");
}

function sumWeights(
  bundles: readonly PrintDependencyRouteBundle[],
): number {
  return bundles.reduce(
    (sum, { weight }) => addWeight(sum, weight),
    0,
  );
}

function addWeight(left: number, right: number): number {
  return right > Number.MAX_VALUE - left
    ? Number.MAX_VALUE
    : left + right;
}
