import * as THREE from "three";

import type {
  RouteEndpointGeometry,
  RoutePoint,
} from "./dependency-route-layout.js";

export type DependencyOverlayDirection = "incoming" | "outgoing";
export type DependencyOverlayPoint = RoutePoint;

/**
 * A viewer-ready dependency. Endpoint resolution, route limiting, and
 * isolation projection happen upstream; this layer only renders the supplied
 * geometry.
 */
export interface DependencyOverlayRoute {
  readonly id: string;
  readonly consumer: RouteEndpointGeometry;
  readonly provider: RouteEndpointGeometry;
  readonly direction: DependencyOverlayDirection;
  readonly weight: number;
  readonly externalProvider: boolean;
  /** Overrides the selected-file direction palette for overview bundles. */
  readonly color?: string;
  /** Makes a selected bundle stronger without creating another draw object. */
  readonly emphasized?: boolean;
}

export interface DependencyRouteOverlayOptions {
  readonly instancingSupported?: boolean;
}

export interface DependencyOverlayRouteDiagnostics {
  readonly id: string;
  readonly consumer: RouteEndpointGeometry;
  readonly provider: RouteEndpointGeometry;
  readonly direction: DependencyOverlayDirection;
  readonly weight: number;
  readonly color?: string;
  readonly emphasized?: boolean;
}

export interface DependencyRouteOverlayDiagnostics {
  readonly routeCount: number;
  readonly gatewayCount: number;
  readonly routes: readonly DependencyOverlayRouteDiagnostics[];
}

export interface DependencyWeightCue {
  readonly normalized: number;
  readonly lineIntensity: number;
  readonly arrowScale: number;
}

export interface DependencyCurve {
  readonly points: readonly DependencyOverlayPoint[];
  readonly arrowPosition: DependencyOverlayPoint;
  readonly arrowDirection: DependencyOverlayPoint;
  readonly lift: number;
}

export const DEPENDENCY_OVERLAY_COLORS = Object.freeze({
  outgoing: "#38bdf8",
  incoming: "#a78bfa",
  gateway: "#f59e0b",
});

const CURVE_SEGMENTS = 12;
const ARROW_CURVE_POSITION = 0.86;
const MINIMUM_CURVE_LIFT = 0.5;
const MAXIMUM_CURVE_LIFT = 4;
const CURVE_LIFT_PER_HORIZONTAL_UNIT = 0.04;
const COINCIDENT_EPSILON_SQUARED = 1e-12;
const MINIMUM_ARROW_SIZE = 0.45;
const MAXIMUM_ARROW_SIZE = 1.25;
const ARROW_SIZE_PER_HORIZONTAL_UNIT = 0.015;
const EMPHASIZED_LINE_INTENSITY = 1.18;
const EMPHASIZED_ARROW_SCALE = 1.28;
const MAXIMUM_EMPHASIZED_ARROW_SCALE = 1.92;
const UP = new THREE.Vector3(0, 1, 0);

/**
 * Maps dependency weight logarithmically into deliberately small visual
 * changes. Values saturate at weight 63 so untrusted or unusually large
 * weights cannot dominate the scene.
 */
export function dependencyWeightCue(weight: number): DependencyWeightCue {
  if (!Number.isFinite(weight) || weight <= 0) {
    throw new RangeError("Dependency route weight must be positive and finite.");
  }
  const normalized = Math.min(1, Math.log2(1 + weight) / 6);
  return {
    normalized,
    lineIntensity: 0.68 + normalized * 0.32,
    arrowScale: 0.82 + normalized * 0.38,
  };
}

export function dependencyRouteColor(
  direction: DependencyOverlayDirection,
): string {
  return direction === "outgoing"
    ? DEPENDENCY_OVERLAY_COLORS.outgoing
    : DEPENDENCY_OVERLAY_COLORS.incoming;
}

/**
 * Creates a shallow quadratic curve. The arrow tangent always follows the
 * semantic consumer-to-provider direction, independently of whether the route
 * is incoming or outgoing relative to the current selection.
 */
export function dependencyCurveForRoute(
  route: DependencyOverlayRoute,
): DependencyCurve {
  validateRoute(route);

  const start = route.consumer.anchor;
  const end = route.provider.anchor;
  const deltaX = end.x - start.x;
  const deltaZ = end.z - start.z;
  const horizontalDistance = Math.hypot(deltaX, deltaZ);
  const lift = clamp(
    MINIMUM_CURVE_LIFT +
      horizontalDistance * CURVE_LIFT_PER_HORIZONTAL_UNIT,
    MINIMUM_CURVE_LIFT,
    MAXIMUM_CURVE_LIFT,
  );
  const apexY = Math.max(start.y, end.y) + lift;
  const control = {
    x: (start.x + end.x) * 0.5,
    y: apexY * 2 - (start.y + end.y) * 0.5,
    z: (start.z + end.z) * 0.5,
  };

  if (deltaX * deltaX + deltaZ * deltaZ <= COINCIDENT_EPSILON_SQUARED) {
    control.x += lift;
  }

  const points = Array.from(
    { length: CURVE_SEGMENTS + 1 },
    (_, index) =>
      quadraticPoint(
        start,
        control,
        end,
        index / CURVE_SEGMENTS,
      ),
  );
  const arrowPosition = quadraticPoint(
    start,
    control,
    end,
    ARROW_CURVE_POSITION,
  );
  const arrowDirection = normalizedQuadraticTangent(
    start,
    control,
    end,
    ARROW_CURVE_POSITION,
  );

  return {
    points,
    arrowPosition,
    arrowDirection,
    lift,
  };
}

/**
 * Owns a scene-level dependency overlay. It is intentionally attached to a
 * THREE.Scene rather than the city group, so routes never expand city bounds
 * or inherit district visibility. Its children opt out of raycasting.
 */
export class DependencyRouteOverlay {
  public readonly object = new THREE.Group();
  private readonly instancingSupported: boolean;
  private disposed = false;
  private currentRouteCount = 0;
  private currentGatewayCount = 0;
  private currentRoutes: readonly DependencyOverlayRouteDiagnostics[] =
    Object.freeze([]);

  public constructor(
    private readonly scene: THREE.Scene,
    name = "code-city:dependency-routes",
    options: DependencyRouteOverlayOptions = {},
  ) {
    if (name.trim() === "") {
      throw new TypeError("Dependency route overlay name must not be empty.");
    }
    this.instancingSupported = options.instancingSupported ?? true;
    this.object.name = name;
    this.scene.add(this.object);
  }

  public get routeCount(): number {
    return this.currentRouteCount;
  }

  public get gatewayCount(): number {
    return this.currentGatewayCount;
  }

  public diagnostics(): DependencyRouteOverlayDiagnostics {
    return Object.freeze({
      routeCount: this.currentRouteCount,
      gatewayCount: this.currentGatewayCount,
      routes: this.currentRoutes,
    });
  }

  public replace(routes: readonly DependencyOverlayRoute[]): void {
    this.assertActive();
    if (routes.length === 0) {
      this.clearContents();
      return;
    }

    const ids = new Set<string>();
    for (const route of routes) {
      validateRoute(route);
      if (ids.has(route.id)) {
        throw new TypeError(`Duplicate dependency overlay route '${route.id}'.`);
      }
      ids.add(route.id);
    }
    const ordered = [...routes].sort((left, right) =>
      compareText(left.id, right.id),
    );
    const visuals = ordered.map((route) => ({
      route,
      curve: dependencyCurveForRoute(route),
      cue: dependencyWeightCue(route.weight),
    }));

    const gatewayVisuals = groundedRouteEndpoints(visuals);
    const replacement: THREE.Object3D[] = [];
    try {
      replacement.push(
        createRouteLines(visuals),
        createArrowheads(visuals, this.instancingSupported),
      );
      if (gatewayVisuals.length > 0) {
        replacement.push(
          createGatewayPylons(
            gatewayVisuals,
            this.instancingSupported,
          ),
        );
      }
    } catch (error) {
      replacement.forEach(disposeOverlayObject);
      throw error;
    }

    // Keep the current overlay intact when replacement input is invalid.
    this.clearContents();
    this.object.add(...replacement);
    this.currentRouteCount = visuals.length;
    this.currentGatewayCount = gatewayVisuals.length;
    this.currentRoutes = Object.freeze(
      ordered.map((route) => routeDiagnostics(route)),
    );
  }

  public clear(): void {
    if (this.disposed) {
      return;
    }
    this.clearContents();
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.clearContents();
    this.scene.remove(this.object);
    this.disposed = true;
  }

  private clearContents(): void {
    for (const child of [...this.object.children]) {
      this.object.remove(child);
      disposeOverlayObject(child);
    }
    this.currentRouteCount = 0;
    this.currentGatewayCount = 0;
    this.currentRoutes = Object.freeze([]);
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new Error("Dependency route overlay has been disposed.");
    }
  }
}

function routeDiagnostics(
  route: DependencyOverlayRoute,
): DependencyOverlayRouteDiagnostics {
  return Object.freeze({
    id: route.id,
    consumer: endpointDiagnostics(route.consumer),
    provider: endpointDiagnostics(route.provider),
    direction: route.direction,
    weight: route.weight,
    ...(route.color === undefined ? {} : { color: route.color }),
    ...(route.emphasized === undefined
      ? {}
      : { emphasized: route.emphasized }),
  });
}

function endpointDiagnostics(
  endpoint: RouteEndpointGeometry,
): RouteEndpointGeometry {
  return Object.freeze({
    contact: Object.freeze({ ...endpoint.contact }),
    anchor: Object.freeze({ ...endpoint.anchor }),
  });
}

interface RouteVisual {
  readonly route: DependencyOverlayRoute;
  readonly curve: DependencyCurve;
  readonly cue: DependencyWeightCue;
}

function createRouteLines(visuals: readonly RouteVisual[]): THREE.LineSegments {
  const positions: number[] = [];
  const colors: number[] = [];

  for (const visual of visuals) {
    const color = new THREE.Color(
      overlayRouteColor(visual.route),
    ).multiplyScalar(
      visual.cue.lineIntensity *
        (visual.route.emphasized === true
          ? EMPHASIZED_LINE_INTENSITY
          : 1),
    );
    for (let index = 1; index < visual.curve.points.length; index += 1) {
      const previous = visual.curve.points[index - 1]!;
      const current = visual.curve.points[index]!;
      positions.push(
        previous.x,
        previous.y,
        previous.z,
        current.x,
        current.y,
        current.z,
      );
      colors.push(
        color.r,
        color.g,
        color.b,
        color.r,
        color.g,
        color.b,
      );
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  geometry.setAttribute(
    "color",
    new THREE.Float32BufferAttribute(colors, 3),
  );
  geometry.computeBoundingSphere();
  const material = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.94,
    depthTest: true,
    depthWrite: false,
    toneMapped: false,
  });
  const lines = new THREE.LineSegments(geometry, material);
  lines.name = "code-city:dependency-route-lines";
  lines.renderOrder = 3;
  disableRaycasting(lines);
  return lines;
}

function createArrowheads(
  visuals: readonly RouteVisual[],
  instancingSupported: boolean,
): THREE.Object3D {
  if (!instancingSupported) {
    return createLegacyArrowheads(visuals);
  }

  const geometry = new THREE.ConeGeometry(0.25, 1, 6);
  const material = new THREE.MeshBasicMaterial({
    color: "#ffffff",
    transparent: true,
    opacity: 0.98,
    depthTest: true,
    depthWrite: false,
    toneMapped: false,
  });
  const arrows = new THREE.InstancedMesh(
    geometry,
    material,
    visuals.length,
  );
  arrows.name = "code-city:dependency-route-arrows";
  arrows.renderOrder = 4;
  const transform = new THREE.Object3D();
  const color = new THREE.Color();

  visuals.forEach((visual, index) => {
    applyArrowTransform(transform, visual);
    arrows.setMatrixAt(index, transform.matrix);
    color.set(overlayRouteColor(visual.route));
    arrows.setColorAt(index, color);
  });
  arrows.instanceMatrix.needsUpdate = true;
  if (arrows.instanceColor) {
    arrows.instanceColor.needsUpdate = true;
  }
  arrows.computeBoundingSphere();
  disableRaycasting(arrows);
  return arrows;
}

function createGatewayPylons(
  endpoints: readonly RouteEndpointGeometry[],
  instancingSupported: boolean,
): THREE.Object3D {
  if (!instancingSupported) {
    return createLegacyGatewayPylons(endpoints);
  }

  const geometry = new THREE.CylinderGeometry(0.14, 0.18, 1, 8);
  const material = new THREE.MeshBasicMaterial({
    color: DEPENDENCY_OVERLAY_COLORS.gateway,
    transparent: true,
    opacity: 0.98,
    depthTest: true,
    depthWrite: false,
    toneMapped: false,
  });
  const gateways = new THREE.InstancedMesh(
    geometry,
    material,
    endpoints.length,
  );
  gateways.name = "code-city:dependency-route-gateways";
  gateways.renderOrder = 4;
  const transform = new THREE.Object3D();

  endpoints.forEach(({ contact, anchor }, index) => {
    applyGatewayTransform(transform, { contact, anchor });
    gateways.setMatrixAt(index, transform.matrix);
  });
  gateways.instanceMatrix.needsUpdate = true;
  gateways.computeBoundingSphere();
  disableRaycasting(gateways);
  return gateways;
}

function createLegacyArrowheads(
  visuals: readonly RouteVisual[],
): THREE.Group {
  const group = new THREE.Group();
  group.name = "code-city:dependency-route-arrows";
  group.renderOrder = 4;
  for (const visual of visuals) {
    const arrow = new THREE.Mesh(
      new THREE.ConeGeometry(0.25, 1, 6),
      new THREE.MeshBasicMaterial({
        color: overlayRouteColor(visual.route),
        transparent: true,
        opacity: 0.98,
        depthTest: true,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    arrow.name = `code-city:dependency-route-arrow:${visual.route.id}`;
    arrow.renderOrder = 4;
    applyArrowTransform(arrow, visual);
    disableRaycasting(arrow);
    group.add(arrow);
  }
  return group;
}

function createLegacyGatewayPylons(
  endpoints: readonly RouteEndpointGeometry[],
): THREE.Group {
  const group = new THREE.Group();
  group.name = "code-city:dependency-route-gateways";
  group.renderOrder = 4;
  endpoints.forEach((endpoint, index) => {
    const gateway = new THREE.Mesh(
      new THREE.CylinderGeometry(0.14, 0.18, 1, 8),
      new THREE.MeshBasicMaterial({
        color: DEPENDENCY_OVERLAY_COLORS.gateway,
        transparent: true,
        opacity: 0.98,
        depthTest: true,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    gateway.name = `code-city:dependency-route-gateway:${index}`;
    gateway.renderOrder = 4;
    applyGatewayTransform(gateway, endpoint);
    disableRaycasting(gateway);
    group.add(gateway);
  });
  return group;
}

function applyArrowTransform(
  object: THREE.Object3D,
  visual: RouteVisual,
): void {
  const { arrowPosition, arrowDirection } = visual.curve;
  const routeDistance = horizontalDistance(visual.route);
  const baseScale =
    clamp(
      routeDistance * ARROW_SIZE_PER_HORIZONTAL_UNIT,
      MINIMUM_ARROW_SIZE,
      MAXIMUM_ARROW_SIZE,
    ) * visual.cue.arrowScale;
  const scale =
    visual.route.emphasized === true
      ? Math.min(
          MAXIMUM_EMPHASIZED_ARROW_SCALE,
          baseScale * EMPHASIZED_ARROW_SCALE,
        )
      : baseScale;
  object.position.set(
    arrowPosition.x,
    arrowPosition.y,
    arrowPosition.z,
  );
  object.quaternion.setFromUnitVectors(
    UP,
    new THREE.Vector3(
      arrowDirection.x,
      arrowDirection.y,
      arrowDirection.z,
    ),
  );
  object.scale.setScalar(scale);
  object.updateMatrix();
}

function applyGatewayTransform(
  object: THREE.Object3D,
  { contact, anchor }: RouteEndpointGeometry,
): void {
  const height = anchor.y - contact.y;
  object.position.set(
    contact.x,
    contact.y + height * 0.5,
    contact.z,
  );
  object.quaternion.identity();
  object.scale.set(1, height, 1);
  object.updateMatrix();
}

function groundedRouteEndpoints(
  visuals: readonly RouteVisual[],
): readonly RouteEndpointGeometry[] {
  const unique = new Map<string, RouteEndpointGeometry>();
  for (const { route } of visuals) {
    for (const endpoint of [route.consumer, route.provider]) {
      if (endpoint.anchor.y === endpoint.contact.y) {
        continue;
      }
      const key = endpointGeometryKey(endpoint);
      if (!unique.has(key)) {
        unique.set(key, endpoint);
      }
    }
  }
  return [...unique.values()];
}

function endpointGeometryKey(endpoint: RouteEndpointGeometry): string {
  return [
    endpoint.contact.x,
    endpoint.contact.y,
    endpoint.contact.z,
    endpoint.anchor.y,
  ]
    .map(numberKey)
    .join("\u0000");
}

function numberKey(value: number): string {
  return Object.is(value, -0) ? "0" : String(value);
}

function quadraticPoint(
  start: DependencyOverlayPoint,
  control: DependencyOverlayPoint,
  end: DependencyOverlayPoint,
  t: number,
): DependencyOverlayPoint {
  const inverse = 1 - t;
  return {
    x:
      inverse * inverse * start.x +
      2 * inverse * t * control.x +
      t * t * end.x,
    y:
      inverse * inverse * start.y +
      2 * inverse * t * control.y +
      t * t * end.y,
    z:
      inverse * inverse * start.z +
      2 * inverse * t * control.z +
      t * t * end.z,
  };
}

function normalizedQuadraticTangent(
  start: DependencyOverlayPoint,
  control: DependencyOverlayPoint,
  end: DependencyOverlayPoint,
  t: number,
): DependencyOverlayPoint {
  const inverse = 1 - t;
  let x =
    2 * inverse * (control.x - start.x) +
    2 * t * (end.x - control.x);
  let y =
    2 * inverse * (control.y - start.y) +
    2 * t * (end.y - control.y);
  let z =
    2 * inverse * (control.z - start.z) +
    2 * t * (end.z - control.z);
  let length = Math.hypot(x, y, z);
  if (length <= Number.EPSILON) {
    x = end.x - start.x;
    y = end.y - start.y;
    z = end.z - start.z;
    length = Math.hypot(x, y, z);
  }
  if (length <= Number.EPSILON) {
    return { x: -1, y: 0, z: 0 };
  }
  return { x: x / length, y: y / length, z: z / length };
}

function horizontalDistance(route: DependencyOverlayRoute): number {
  return Math.hypot(
    route.provider.anchor.x - route.consumer.anchor.x,
    route.provider.anchor.z - route.consumer.anchor.z,
  );
}

function validateRoute(route: DependencyOverlayRoute): void {
  if (typeof route.id !== "string" || route.id.trim() === "") {
    throw new TypeError("Dependency overlay route id must not be empty.");
  }
  validateEndpoint(route.consumer, "consumer");
  validateEndpoint(route.provider, "provider");
  if (route.direction !== "incoming" && route.direction !== "outgoing") {
    throw new TypeError("Dependency overlay route direction is invalid.");
  }
  dependencyWeightCue(route.weight);
  if (typeof route.externalProvider !== "boolean") {
    throw new TypeError(
      "Dependency overlay externalProvider must be a boolean.",
    );
  }
  if (
    route.color !== undefined &&
    (typeof route.color !== "string" || route.color.trim() === "")
  ) {
    throw new TypeError(
      "Dependency overlay route color must not be empty.",
    );
  }
  if (
    route.emphasized !== undefined &&
    typeof route.emphasized !== "boolean"
  ) {
    throw new TypeError(
      "Dependency overlay emphasized flag must be a boolean.",
    );
  }
}

function validateEndpoint(
  endpoint: RouteEndpointGeometry,
  label: string,
): void {
  validatePoint(endpoint.contact, `${label} contact`);
  validatePoint(endpoint.anchor, `${label} anchor`);
  if (
    endpoint.contact.x !== endpoint.anchor.x ||
    endpoint.contact.z !== endpoint.anchor.z
  ) {
    throw new RangeError(
      `Dependency overlay ${label} contact and anchor must be vertical.`,
    );
  }
  if (endpoint.anchor.y < endpoint.contact.y) {
    throw new RangeError(
      `Dependency overlay ${label} anchor must not be below its contact.`,
    );
  }
}

function overlayRouteColor(route: DependencyOverlayRoute): string {
  return route.color ?? dependencyRouteColor(route.direction);
}

function validatePoint(point: DependencyOverlayPoint, label: string): void {
  if (
    !Number.isFinite(point.x) ||
    !Number.isFinite(point.y) ||
    !Number.isFinite(point.z)
  ) {
    throw new RangeError(
      `Dependency overlay ${label} endpoint must be finite.`,
    );
  }
}

function disableRaycasting(object: THREE.Object3D): void {
  object.raycast = () => {};
}

function disposeOverlayObject(object: THREE.Object3D): void {
  object.traverse((child) => {
    if (child instanceof THREE.InstancedMesh) {
      child.dispose();
    }
    if (child instanceof THREE.LineSegments || child instanceof THREE.Mesh) {
      child.geometry.dispose();
      const materials = Array.isArray(child.material)
        ? child.material
        : [child.material];
      for (const material of materials) {
        material.dispose();
      }
    }
  });
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
