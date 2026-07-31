import * as THREE from "three";
import { describe, expect, it } from "vitest";

import {
  DEPENDENCY_OVERLAY_COLORS,
  DependencyRouteOverlay,
  dependencyCurveForRoute,
  dependencyRouteColor,
  dependencyWeightCue,
  type DependencyOverlayRoute,
} from "../apps/viewer/src/dependency-overlay.js";
import type {
  RouteEndpointGeometry,
  RoutePoint,
} from "../apps/viewer/src/dependency-route-layout.js";

describe("dependency overlay curve geometry", () => {
  it("raises a shallow curve and points its arrow at the provider", () => {
    const route = dependencyRoute({
      consumer: { x: 0, y: 2, z: 0 },
      provider: { x: 10, y: 3, z: 0 },
      direction: "outgoing",
    });

    const curve = dependencyCurveForRoute(route);

    expect(curve.points).toHaveLength(13);
    expect(curve.points[0]).toEqual(route.consumer.anchor);
    expect(curve.points.at(-1)).toEqual(route.provider.anchor);
    expect(curve.points[6]?.y).toBeCloseTo(
      Math.max(route.consumer.anchor.y, route.provider.anchor.y) +
        curve.lift,
      12,
    );
    expect(curve.lift).toBeGreaterThanOrEqual(0.5);
    expect(curve.lift).toBeLessThanOrEqual(4);

    const towardProvider = new THREE.Vector3(
      route.provider.anchor.x - curve.arrowPosition.x,
      route.provider.anchor.y - curve.arrowPosition.y,
      route.provider.anchor.z - curve.arrowPosition.z,
    ).normalize();
    const arrowDirection = new THREE.Vector3(
      curve.arrowDirection.x,
      curve.arrowDirection.y,
      curve.arrowDirection.z,
    );
    expect(arrowDirection.length()).toBeCloseTo(1, 12);
    expect(arrowDirection.dot(towardProvider)).toBeGreaterThan(0.99);
  });

  it("keeps semantic direction in the palette, not the arrow orientation", () => {
    const incoming = dependencyRoute({
      direction: "incoming",
      consumer: { x: 8, y: 1, z: -2 },
      provider: { x: 0, y: 1, z: -2 },
    });
    const curve = dependencyCurveForRoute(incoming);

    expect(dependencyRouteColor("incoming")).toBe(
      DEPENDENCY_OVERLAY_COLORS.incoming,
    );
    expect(dependencyRouteColor("outgoing")).toBe(
      DEPENDENCY_OVERLAY_COLORS.outgoing,
    );
    expect(curve.arrowDirection.x).toBeLessThan(0);
  });

  it("creates finite deterministic geometry for coincident endpoints", () => {
    const route = dependencyRoute({
      consumer: { x: 2, y: 3, z: 4 },
      provider: { x: 2, y: 3, z: 4 },
    });

    const first = dependencyCurveForRoute(route);
    const second = dependencyCurveForRoute(route);

    expect(second).toEqual(first);
    expect(
      first.points.some(({ x }) => x > route.consumer.anchor.x),
    ).toBe(true);
    for (const point of [
      ...first.points,
      first.arrowPosition,
      first.arrowDirection,
    ]) {
      expect(Number.isFinite(point.x)).toBe(true);
      expect(Number.isFinite(point.y)).toBe(true);
      expect(Number.isFinite(point.z)).toBe(true);
    }
    const towardProvider = new THREE.Vector3(
      route.provider.anchor.x - first.arrowPosition.x,
      route.provider.anchor.y - first.arrowPosition.y,
      route.provider.anchor.z - first.arrowPosition.z,
    ).normalize();
    const arrowDirection = new THREE.Vector3(
      first.arrowDirection.x,
      first.arrowDirection.y,
      first.arrowDirection.z,
    );
    expect(arrowDirection.dot(towardProvider)).toBeGreaterThan(0.99);
  });

  it("maps weight logarithmically into bounded monotonic cues", () => {
    const light = dependencyWeightCue(1);
    const medium = dependencyWeightCue(7);
    const saturated = dependencyWeightCue(63);
    const enormous = dependencyWeightCue(Number.MAX_VALUE);

    expect(medium.normalized).toBeGreaterThan(light.normalized);
    expect(medium.lineIntensity).toBeGreaterThan(light.lineIntensity);
    expect(medium.arrowScale).toBeGreaterThan(light.arrowScale);
    expect(saturated).toEqual({
      normalized: 1,
      lineIntensity: 1,
      arrowScale: 1.2,
    });
    expect(enormous).toEqual(saturated);
    expect(() => dependencyWeightCue(0)).toThrow(RangeError);
    expect(() => dependencyWeightCue(Number.NaN)).toThrow(RangeError);
  });
});

describe("DependencyRouteOverlay lifecycle", () => {
  it("reports owned deterministic route geometry after every replacement", () => {
    const scene = new THREE.Scene();
    const overlay = new DependencyRouteOverlay(scene);
    const route = dependencyRoute({
      id: "diagnostic-route",
      consumer: groundedEndpoint(
        { x: -2, y: 0, z: 3 },
        { x: -2, y: 2, z: 3 },
      ),
      provider: { x: 8, y: 4, z: -1 },
      weight: 5,
      color: "#f472b6",
      emphasized: true,
    });

    overlay.replace([route]);
    const diagnostics = overlay.diagnostics();
    expect(diagnostics).toEqual({
      routeCount: 1,
      gatewayCount: 1,
      routes: [
        {
          id: "diagnostic-route",
          consumer: route.consumer,
          provider: route.provider,
          direction: "outgoing",
          weight: 5,
          color: "#f472b6",
          emphasized: true,
        },
      ],
    });
    (
      route.consumer.anchor as {
        x: number;
        y: number;
        z: number;
      }
    ).x = 99;
    expect(diagnostics.routes[0]?.consumer.anchor.x).toBe(-2);

    overlay.clear();
    expect(overlay.diagnostics()).toEqual({
      routeCount: 0,
      gatewayCount: 0,
      routes: [],
    });
    overlay.dispose();
  });

  it("uses at most three non-raycast scene-level draw objects", () => {
    const scene = new THREE.Scene();
    const overlay = new DependencyRouteOverlay(scene);
    const routes = [
      dependencyRoute({
        id: "external-outgoing",
        externalProvider: true,
        provider: groundedEndpoint(
          { x: 10, y: 0, z: 0 },
          { x: 10, y: 2, z: 0 },
        ),
      }),
      dependencyRoute({
        id: "hidden-incoming",
        direction: "incoming",
        consumer: groundedEndpoint(
          { x: -5, y: 0, z: 1 },
          { x: -5, y: 1, z: 1 },
        ),
      }),
    ] as const;

    overlay.replace(routes);

    expect(overlay.object.parent).toBe(scene);
    expect(overlay.routeCount).toBe(2);
    expect(overlay.gatewayCount).toBe(2);
    expect(overlay.object.children).toHaveLength(3);
    for (const child of overlay.object.children) {
      const renderable = child as THREE.LineSegments | THREE.Mesh;
      const materials = Array.isArray(renderable.material)
        ? renderable.material
        : [renderable.material];
      expect(materials.every(({ depthWrite }) => depthWrite === false)).toBe(
        true,
      );
    }

    const raycaster = new THREE.Raycaster(
      new THREE.Vector3(0, 20, 0),
      new THREE.Vector3(0, -1, 0),
    );
    expect(
      raycaster.intersectObjects(overlay.object.children, true),
    ).toEqual([]);

    overlay.dispose();
    expect(overlay.object.parent).toBeNull();
  });

  it("preserves arrows and gateways with ordinary meshes without instancing", () => {
    const scene = new THREE.Scene();
    const overlay = new DependencyRouteOverlay(
      scene,
      "code-city:dependency-routes",
      { instancingSupported: false },
    );
    const route = dependencyRoute({
      id: "legacy-incoming",
      direction: "incoming",
      consumer: groundedEndpoint(
        { x: -3, y: 0, z: 1 },
        { x: -3, y: 2, z: 1 },
      ),
      provider: { x: 9, y: 4, z: 5 },
    });

    overlay.replace([route]);

    const arrows = overlay.object.getObjectByName(
      "code-city:dependency-route-arrows",
    );
    const gateways = overlay.object.getObjectByName(
      "code-city:dependency-route-gateways",
    );
    expect(arrows).toBeInstanceOf(THREE.Group);
    expect(gateways).toBeInstanceOf(THREE.Group);
    expect(
      overlay.object.children.some(
        (child) => child instanceof THREE.InstancedMesh,
      ),
    ).toBe(false);
    expect(arrows?.children).toHaveLength(1);
    expect(gateways?.children).toHaveLength(1);

    const arrow = arrows?.children[0];
    const gateway = gateways?.children[0];
    expect(arrow).toBeInstanceOf(THREE.Mesh);
    expect(gateway).toBeInstanceOf(THREE.Mesh);
    expect(
      ((arrow as THREE.Mesh).material as THREE.MeshBasicMaterial).color
        .getHexString(),
    ).toBe(
      new THREE.Color(DEPENDENCY_OVERLAY_COLORS.incoming).getHexString(),
    );
    expect(gateway?.position).toEqual(new THREE.Vector3(-3, 1, 1));
    expect(gateway?.scale.y).toBe(2);

    const raycaster = new THREE.Raycaster(
      new THREE.Vector3(-3, 20, 1),
      new THREE.Vector3(0, -1, 0),
    );
    expect(
      raycaster.intersectObjects(overlay.object.children, true),
    ).toEqual([]);

    overlay.dispose();
    expect(overlay.object.parent).toBeNull();
  });

  it("places an amber pylon between a surface contact and route anchor", () => {
    const scene = new THREE.Scene();
    const overlay = new DependencyRouteOverlay(scene);
    const route = dependencyRoute({
      consumer: groundedEndpoint(
        { x: -3, y: 0, z: 1 },
        { x: -3, y: 2, z: 1 },
      ),
      provider: { x: 9, y: 4, z: 5 },
    });

    overlay.replace([route]);
    expect(instancePosition(gatewayMesh(overlay))).toEqual(
      new THREE.Vector3(-3, 1, 1),
    );
    expect(instanceScaleY(gatewayMesh(overlay), 0)).toBe(2);
    expect(
      (gatewayMesh(overlay).material as THREE.MeshBasicMaterial).color.getHexString(),
    ).toBe(DEPENDENCY_OVERLAY_COLORS.gateway.slice(1));

    overlay.replace([
      dependencyRoute({
        consumer: { x: -3, y: 2, z: 1 },
        provider: groundedEndpoint(
          { x: 9, y: 1, z: 5 },
          { x: 9, y: 4, z: 5 },
        ),
      }),
    ]);
    expect(instancePosition(gatewayMesh(overlay))).toEqual(
      new THREE.Vector3(9, 2.5, 5),
    );
    expect(instanceScaleY(gatewayMesh(overlay), 0)).toBe(3);
  });

  it("grounds both route ends and deduplicates shared pylons", () => {
    const scene = new THREE.Scene();
    const overlay = new DependencyRouteOverlay(scene);
    const shared = groundedEndpoint(
      { x: 0, y: 0.5, z: 0 },
      { x: 0, y: 5, z: 0 },
    );
    overlay.replace([
      dependencyRoute({
        id: "a",
        consumer: shared,
        provider: groundedEndpoint(
          { x: 10, y: 1, z: 0 },
          { x: 10, y: 4, z: 0 },
        ),
      }),
      dependencyRoute({
        id: "b",
        consumer: shared,
        provider: { x: 20, y: 3, z: 0 },
      }),
    ]);

    expect(overlay.gatewayCount).toBe(2);
    expect(gatewayMesh(overlay).count).toBe(2);
    expect(overlay.object.children).toHaveLength(3);
    overlay.dispose();
  });

  it("colors arrowheads through their instance colors", () => {
    const scene = new THREE.Scene();
    const overlay = new DependencyRouteOverlay(scene);
    overlay.replace([
      dependencyRoute({
        direction: "incoming",
      }),
    ]);

    const arrows = arrowMesh(overlay);
    const color = new THREE.Color();
    arrows.getColorAt(0, color);

    expect(color.getHexString()).toBe(
      new THREE.Color(DEPENDENCY_OVERLAY_COLORS.incoming).getHexString(),
    );
    expect(
      (arrows.material as THREE.MeshBasicMaterial).vertexColors,
    ).toBe(false);
    overlay.dispose();
  });

  it("supports a named overview layer with explicit colors and emphasis", () => {
    const scene = new THREE.Scene();
    const overlay = new DependencyRouteOverlay(
      scene,
      "code-city:district-dependency-routes",
    );
    const color = "#22c55e";
    overlay.replace([
      dependencyRoute({
        id: "normal",
        color,
      }),
      dependencyRoute({
        id: "selected",
        color,
        emphasized: true,
        consumer: { x: 0, y: 1, z: 2 },
        provider: { x: 10, y: 1, z: 2 },
      }),
    ]);

    expect(overlay.object.name).toBe(
      "code-city:district-dependency-routes",
    );
    expect(overlay.object.children).toHaveLength(2);

    const arrows = arrowMesh(overlay);
    const normalColor = new THREE.Color();
    const selectedColor = new THREE.Color();
    arrows.getColorAt(0, normalColor);
    arrows.getColorAt(1, selectedColor);
    expect(normalColor.getHexString()).toBe(
      new THREE.Color(color).getHexString(),
    );
    expect(selectedColor.getHexString()).toBe(normalColor.getHexString());
    expect(instanceScale(arrows, 1)).toBeGreaterThan(
      instanceScale(arrows, 0),
    );

    const lines = routeLines(overlay);
    const colors = lines.geometry.getAttribute("color");
    const expected = new THREE.Color(color).multiplyScalar(
      dependencyWeightCue(1).lineIntensity,
    );
    expect(colors.getX(0)).toBeCloseTo(expected.r, 6);
    expect(colors.getY(0)).toBeCloseTo(expected.g, 6);
    expect(colors.getZ(0)).toBeCloseTo(expected.b, 6);

    overlay.replace([
      dependencyRoute({
        id: "bounded-emphasis",
        color,
        emphasized: true,
        provider: { x: 1_000_000, y: 1, z: 0 },
        weight: Number.MAX_VALUE,
      }),
    ]);
    expect(instanceScale(arrowMesh(overlay), 0)).toBeCloseTo(1.92, 6);

    overlay.dispose();
    expect(
      () => new DependencyRouteOverlay(scene, "   "),
    ).toThrow(/name/u);
  });

  it("disposes replaced geometry and supports idempotent clear/dispose", () => {
    const scene = new THREE.Scene();
    const overlay = new DependencyRouteOverlay(scene);
    overlay.replace([
      dependencyRoute({
        externalProvider: true,
        provider: groundedEndpoint(
          { x: 10, y: 0, z: 0 },
          { x: 10, y: 1, z: 0 },
        ),
      }),
    ]);
    let geometryDisposals = 0;
    let instanceDisposals = 0;
    for (const child of overlay.object.children) {
      const renderable = child as THREE.LineSegments | THREE.Mesh;
      renderable.geometry.addEventListener("dispose", () => {
        geometryDisposals += 1;
      });
      if (child instanceof THREE.InstancedMesh) {
        child.addEventListener("dispose", () => {
          instanceDisposals += 1;
        });
      }
    }

    overlay.replace([dependencyRoute()]);

    expect(geometryDisposals).toBe(3);
    expect(instanceDisposals).toBe(2);
    expect(overlay.object.children).toHaveLength(2);
    expect(overlay.routeCount).toBe(1);
    expect(overlay.gatewayCount).toBe(0);

    overlay.clear();
    overlay.clear();
    expect(overlay.object.children).toHaveLength(0);
    expect(overlay.routeCount).toBe(0);
    overlay.dispose();
    overlay.dispose();
    expect(() => overlay.replace([dependencyRoute()])).toThrow(/disposed/u);
  });

  it("disposes every ordinary fallback mesh across replace and clear", () => {
    const scene = new THREE.Scene();
    const overlay = new DependencyRouteOverlay(
      scene,
      "code-city:dependency-routes",
      { instancingSupported: false },
    );
    overlay.replace([
      dependencyRoute({
        provider: groundedEndpoint(
          { x: 10, y: 0, z: 0 },
          { x: 10, y: 2, z: 0 },
        ),
      }),
    ]);
    let geometryDisposals = 0;
    let materialDisposals = 0;
    overlay.object.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      child.geometry.addEventListener("dispose", () => {
        geometryDisposals += 1;
      });
      const material = child.material as THREE.Material;
      material.addEventListener("dispose", () => {
        materialDisposals += 1;
      });
    });

    overlay.replace([dependencyRoute()]);

    expect(geometryDisposals).toBe(2);
    expect(materialDisposals).toBe(2);
    expect(overlay.object.children).toHaveLength(2);
    expect(
      overlay.object.children.every(
        (child) => !(child instanceof THREE.InstancedMesh),
      ),
    ).toBe(true);

    overlay.clear();
    overlay.clear();
    overlay.dispose();
    overlay.dispose();
    expect(overlay.object.parent).toBeNull();
  });

  it("rejects invalid endpoint geometry and duplicate route ids", () => {
    const scene = new THREE.Scene();
    const overlay = new DependencyRouteOverlay(scene);
    overlay.replace([dependencyRoute()]);
    const nonVertical = dependencyRoute({
      provider: {
        contact: { x: 9, y: 0, z: 0 },
        anchor: { x: 10, y: 1, z: 0 },
      },
    });
    const inverted = dependencyRoute({
      provider: {
        contact: { x: 10, y: 2, z: 0 },
        anchor: { x: 10, y: 1, z: 0 },
      },
    });

    expect(() =>
      dependencyCurveForRoute(nonVertical),
    ).toThrow(/vertical/u);
    expect(() => dependencyCurveForRoute(inverted)).toThrow(/below/u);
    expect(() =>
      overlay.replace([dependencyRoute(), dependencyRoute()]),
    ).toThrow(/duplicate/iu);
    expect(overlay.routeCount).toBe(1);
    expect(overlay.object.children).toHaveLength(2);
    overlay.dispose();
  });
});

type RouteOverrides = Omit<
  Partial<DependencyOverlayRoute>,
  "consumer" | "provider"
> & {
  readonly consumer?: RoutePoint | RouteEndpointGeometry;
  readonly provider?: RoutePoint | RouteEndpointGeometry;
};

function dependencyRoute(
  overrides: RouteOverrides = {},
): DependencyOverlayRoute {
  const {
    consumer = { x: 0, y: 1, z: 0 },
    provider = { x: 10, y: 1, z: 0 },
    ...rest
  } = overrides;
  return {
    id: "route-a",
    consumer: routeEndpoint(consumer),
    provider: routeEndpoint(provider),
    direction: "outgoing",
    weight: 1,
    externalProvider: false,
    ...rest,
  };
}

function routeEndpoint(
  value: RoutePoint | RouteEndpointGeometry,
): RouteEndpointGeometry {
  return "contact" in value
    ? value
    : { contact: value, anchor: value };
}

function groundedEndpoint(
  contact: RoutePoint,
  anchor: RoutePoint,
): RouteEndpointGeometry {
  return { contact, anchor };
}

function gatewayMesh(
  overlay: DependencyRouteOverlay,
): THREE.InstancedMesh {
  const mesh = overlay.object.getObjectByName(
    "code-city:dependency-route-gateways",
  );
  if (!(mesh instanceof THREE.InstancedMesh)) {
    throw new Error("Expected an instanced gateway mesh.");
  }
  return mesh;
}

function arrowMesh(
  overlay: DependencyRouteOverlay,
): THREE.InstancedMesh {
  const mesh = overlay.object.getObjectByName(
    "code-city:dependency-route-arrows",
  );
  if (!(mesh instanceof THREE.InstancedMesh)) {
    throw new Error("Expected an instanced arrow mesh.");
  }
  return mesh;
}

function routeLines(
  overlay: DependencyRouteOverlay,
): THREE.LineSegments {
  const lines = overlay.object.getObjectByName(
    "code-city:dependency-route-lines",
  );
  if (!(lines instanceof THREE.LineSegments)) {
    throw new Error("Expected dependency route lines.");
  }
  return lines;
}

function instancePosition(mesh: THREE.InstancedMesh): THREE.Vector3 {
  const matrix = new THREE.Matrix4();
  mesh.getMatrixAt(0, matrix);
  return new THREE.Vector3().setFromMatrixPosition(matrix);
}

function instanceScale(mesh: THREE.InstancedMesh, index: number): number {
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  mesh.getMatrixAt(index, matrix);
  matrix.decompose(position, quaternion, scale);
  return scale.x;
}

function instanceScaleY(
  mesh: THREE.InstancedMesh,
  index: number,
): number {
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  mesh.getMatrixAt(index, matrix);
  matrix.decompose(position, quaternion, scale);
  return scale.y;
}
