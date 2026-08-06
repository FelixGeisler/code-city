import * as THREE from "three";

import {
  DESIGN_SMELL_RULE_CATALOG,
  type DesignSmellId,
  type DesignSmellSeverity,
} from "../../../packages/core/src/index.js";

export const MAXIMUM_DESIGN_SMELL_OVERLAY_MARKERS = 2_000;
export const DESIGN_SMELL_MARKER_TARGET_CSS_PIXELS = 14;

const DESIGN_SMELL_MARKER_DEFAULT_WORLD_DIAMETER = 0.75;
const DESIGN_SMELL_MARKER_CLEARANCE_CSS_PIXELS = 2;
const DESIGN_SMELL_MARKER_STACK_GAP_CSS_PIXELS = 2;
const DESIGN_SMELL_MARKER_MINIMUM_CLEARANCE = 0.08;
const DESIGN_SMELL_VIEW_SIGNATURE_EPSILON = 1e-6;

type MarkerCategory = "complexity" | "size" | "coupling" | "structure";

export interface DesignSmellOverlayMarker {
  readonly id: string;
  readonly buildingId: string;
  readonly districtId: string;
  readonly ruleId: DesignSmellId;
  readonly severity: DesignSmellSeverity;
  /** Center of the building roof surface, before overlay clearance. */
  readonly position: {
    readonly x: number;
    readonly y: number;
    readonly z: number;
  };
}

export interface DesignSmellOverlayDiagnostics {
  readonly requestedFindings: number;
  readonly candidateMarkers: number;
  readonly visibleMarkers: number;
  readonly omittedMarkers: number;
  readonly batchCount: number;
}

interface CanonicalMarker extends DesignSmellOverlayMarker {
  readonly category: MarkerCategory;
}

interface MarkerBatch {
  readonly category: MarkerCategory;
  readonly markers: readonly CanonicalMarker[];
  readonly geometryDiameter: number;
  readonly geometryRadius: number;
  readonly mesh: THREE.InstancedMesh<
    THREE.BufferGeometry,
    THREE.MeshBasicMaterial
  >;
}

interface OverlayView {
  readonly camera: THREE.OrthographicCamera | THREE.PerspectiveCamera;
  readonly viewportHeight: number;
  readonly signature: readonly number[];
  readonly unitsPerPixelScale: number;
  readonly depthScaled: boolean;
}

const CATEGORY_ORDER: readonly MarkerCategory[] = [
  "complexity",
  "size",
  "coupling",
  "structure",
];

const SEVERITY_COLOR = Object.freeze({
  moderate: "#eab308",
  high: "#f97316",
  critical: "#ef4444",
} satisfies Record<DesignSmellSeverity, string>);

const SEVERITY_RANK = Object.freeze({
  moderate: 0,
  high: 1,
  critical: 2,
} satisfies Record<DesignSmellSeverity, number>);

function categoryForRule(ruleId: DesignSmellId): MarkerCategory {
  return DESIGN_SMELL_RULE_CATALOG.find(({ id }) => id === ruleId)!
    .category;
}

function compareMarkers(
  left: CanonicalMarker,
  right: CanonicalMarker,
): number {
  return (
    SEVERITY_RANK[right.severity] - SEVERITY_RANK[left.severity] ||
    compareText(left.buildingId, right.buildingId) ||
    compareText(left.ruleId, right.ruleId) ||
    compareText(left.id, right.id)
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameViewSignature(
  left: readonly number[] | undefined,
  right: readonly number[],
): boolean {
  return (
    left !== undefined &&
    left.length === right.length &&
    left.every(
      (value, index) =>
        Math.abs(value - right[index]!) <=
        DESIGN_SMELL_VIEW_SIGNATURE_EPSILON,
    )
  );
}

function markerDiameter(worldUnitsPerPixel: number): number {
  return Math.max(
    worldUnitsPerPixel * DESIGN_SMELL_MARKER_TARGET_CSS_PIXELS,
    Number.EPSILON,
  );
}

function finitePosition(
  marker: DesignSmellOverlayMarker,
): void {
  if (
    !Number.isFinite(marker.position.x) ||
    !Number.isFinite(marker.position.y) ||
    !Number.isFinite(marker.position.z)
  ) {
    throw new RangeError(
      `Design-smell marker "${marker.id}" has an invalid position.`,
    );
  }
}

/**
 * A bounded overlay with at most four draw calls. Geometry and material are
 * shared; per-instance matrices and colors encode marker placement/severity.
 */
export class DesignSmellOverlay {
  public readonly object = new THREE.Group();

  private readonly geometries: Readonly<
    Record<MarkerCategory, THREE.BufferGeometry>
  > = Object.freeze({
    complexity: new THREE.OctahedronGeometry(0.55),
    size: new THREE.BoxGeometry(0.72, 0.24, 0.72),
    coupling: new THREE.TetrahedronGeometry(0.58),
    structure: new THREE.TorusGeometry(0.46, 0.12, 8, 16),
  });
  private readonly material = new THREE.MeshBasicMaterial({
    color: "#ffffff",
    toneMapped: false,
  });
  private readonly batches: MarkerBatch[] = [];
  private markers: readonly CanonicalMarker[] = Object.freeze([]);
  private visibleBuildingIds: ReadonlySet<string> | null = null;
  private requestedFindings = 0;
  private candidateMarkers = 0;
  private omittedMarkers = 0;
  private visibleMarkers = 0;
  private disposed = false;
  private view: OverlayView | undefined;
  private readonly cameraSpace = new THREE.Vector3();

  public constructor() {
    this.object.name = "code-city:design-smells";
  }

  public replace(
    markers: readonly DesignSmellOverlayMarker[],
  ): void {
    this.assertActive();
    this.requestedFindings = markers.length;
    const byBuildingRule = new Map<string, CanonicalMarker>();
    for (const marker of markers) {
      finitePosition(marker);
      const canonical = Object.freeze({
        ...marker,
        category: categoryForRule(marker.ruleId),
      });
      const key = `${marker.buildingId}\u0000${marker.ruleId}`;
      const existing = byBuildingRule.get(key);
      if (
        existing === undefined ||
        SEVERITY_RANK[canonical.severity] >
          SEVERITY_RANK[existing.severity] ||
        (canonical.severity === existing.severity &&
          compareText(canonical.id, existing.id) < 0)
      ) {
        byBuildingRule.set(key, canonical);
      }
    }
    const candidates = [...byBuildingRule.values()].sort(
      compareMarkers,
    );
    this.candidateMarkers = candidates.length;
    this.markers = Object.freeze(
      candidates.slice(0, MAXIMUM_DESIGN_SMELL_OVERLAY_MARKERS),
    );
    this.omittedMarkers =
      this.requestedFindings - this.markers.length;
    this.rebuildBatches();
  }

  /** Keeps marker silhouettes readable while the camera or viewport changes. */
  public updateView(
    camera: THREE.OrthographicCamera | THREE.PerspectiveCamera,
    viewportHeight: number,
  ): void {
    this.assertActive();
    if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) {
      throw new RangeError(
        "Design-smell marker viewport height must be positive and finite.",
      );
    }
    camera.updateMatrixWorld(true);
    const signature = Object.freeze([
      viewportHeight,
      ...camera.matrixWorld.elements,
      ...camera.projectionMatrix.elements,
    ]);
    if (sameViewSignature(this.view?.signature, signature)) return;
    const depthScaled = camera instanceof THREE.PerspectiveCamera;
    const unitsPerPixelScale = depthScaled
      ? 2 *
        Math.tan(
          THREE.MathUtils.degToRad(camera.getEffectiveFOV()) / 2,
        ) /
        viewportHeight
      : Math.abs(camera.top - camera.bottom) /
        Math.max(camera.zoom * viewportHeight, Number.EPSILON);
    this.view = Object.freeze({
      camera,
      viewportHeight,
      signature,
      unitsPerPixelScale,
      depthScaled,
    });
    if (this.batches.length > 0) this.populateBatches(false);
  }

  public setVisibleBuildingIds(ids: readonly string[] | null): void {
    this.assertActive();
    this.visibleBuildingIds = ids === null ? null : new Set(ids);
    this.populateBatches();
  }

  public clear(): void {
    this.assertActive();
    this.requestedFindings = 0;
    this.candidateMarkers = 0;
    this.omittedMarkers = 0;
    this.visibleMarkers = 0;
    this.markers = Object.freeze([]);
    this.clearBatches();
  }

  public diagnostics(): DesignSmellOverlayDiagnostics {
    return Object.freeze({
      requestedFindings: this.requestedFindings,
      candidateMarkers: this.candidateMarkers,
      visibleMarkers: this.visibleMarkers,
      omittedMarkers: this.omittedMarkers,
      batchCount: this.batches.length,
    });
  }

  public dispose(): void {
    if (this.disposed) return;
    this.clearBatches();
    for (const geometry of Object.values(this.geometries)) {
      geometry.dispose();
    }
    this.material.dispose();
    this.markers = Object.freeze([]);
    this.view = undefined;
    this.disposed = true;
  }

  private rebuildBatches(): void {
    this.clearBatches();
    for (const category of CATEGORY_ORDER) {
      const categoryMarkers = this.markers.filter(
        (marker) => marker.category === category,
      );
      if (categoryMarkers.length === 0) continue;
      const mesh = new THREE.InstancedMesh(
        this.geometries[category],
        this.material,
        categoryMarkers.length,
      );
      mesh.name = `code-city:design-smells:${category}`;
      mesh.raycast = () => undefined;
      // Four tiny batches are cheaper to draw than rescanning up to 2,000
      // instance matrices for new frustum bounds throughout camera damping.
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      const geometry = this.geometries[category];
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
      const geometryBounds = geometry.boundingBox!;
      const geometrySize = geometryBounds.getSize(new THREE.Vector3());
      const geometryDiameter = Math.max(
        geometrySize.x,
        geometrySize.y,
      );
      const batch = {
        category,
        markers: Object.freeze(categoryMarkers),
        geometryDiameter,
        geometryRadius: geometry.boundingSphere!.radius,
        mesh,
      };
      this.batches.push(batch);
      this.object.add(mesh);
    }
    this.populateBatches();
  }

  private populateBatches(updateColors = true): void {
    const stackEndsByBuilding = new Map<string, number>();
    const matrix = new THREE.Matrix4();
    const color = new THREE.Color();
    const position = new THREE.Vector3();
    const scale = new THREE.Vector3();
    const orientation =
      this.view?.camera.quaternion ?? new THREE.Quaternion();
    const screenUp =
      this.view === undefined
        ? new THREE.Vector3(0, 1, 0)
        : new THREE.Vector3(0, 1, 0)
            .applyQuaternion(this.view.camera.quaternion)
            .normalize();
    let visibleMarkers = 0;
    for (const batch of this.batches) {
      let instance = 0;
      for (const marker of batch.markers) {
        if (
          this.visibleBuildingIds !== null &&
          !this.visibleBuildingIds.has(marker.buildingId)
        ) {
          continue;
        }
        let worldUnitsPerPixel = this.worldUnitsPerPixel(marker.position);
        let diameter = markerDiameter(worldUnitsPerPixel);
        let uniformScale = diameter / batch.geometryDiameter;
        let markerRadius = batch.geometryRadius * uniformScale;
        let clearance = Math.max(
          DESIGN_SMELL_MARKER_MINIMUM_CLEARANCE,
          worldUnitsPerPixel * DESIGN_SMELL_MARKER_CLEARANCE_CSS_PIXELS,
        );
        position.set(
          marker.position.x,
          marker.position.y + markerRadius + clearance,
          marker.position.z,
        );
        // Perspective scale depends on depth. Lifting a marker above its roof
        // changes that depth most noticeably in a top-down view, so refine the
        // scale at the eventual marker center instead of only at the roof.
        for (let pass = 0; pass < 2; pass += 1) {
          worldUnitsPerPixel = this.worldUnitsPerPixel(position);
          diameter = markerDiameter(worldUnitsPerPixel);
          uniformScale = diameter / batch.geometryDiameter;
          markerRadius = batch.geometryRadius * uniformScale;
          clearance = Math.max(
            DESIGN_SMELL_MARKER_MINIMUM_CLEARANCE,
            worldUnitsPerPixel * DESIGN_SMELL_MARKER_CLEARANCE_CSS_PIXELS,
          );
          position.set(
            marker.position.x,
            marker.position.y + markerRadius + clearance,
            marker.position.z,
          );
        }
        const stackGap = Math.max(
          DESIGN_SMELL_MARKER_MINIMUM_CLEARANCE,
          worldUnitsPerPixel * DESIGN_SMELL_MARKER_STACK_GAP_CSS_PIXELS,
        );
        const baseAlongScreenUp = position.dot(screenUp);
        const previousStackEnd = stackEndsByBuilding.get(marker.buildingId);
        if (previousStackEnd !== undefined) {
          position.addScaledVector(
            screenUp,
            Math.max(
              0,
              previousStackEnd + markerRadius + stackGap - baseAlongScreenUp,
            ),
          );
        }
        position.y = Math.max(
          position.y,
          marker.position.y + markerRadius + clearance,
        );
        scale.setScalar(uniformScale);
        matrix.compose(position, orientation, scale);
        stackEndsByBuilding.set(
          marker.buildingId,
          position.dot(screenUp) + markerRadius,
        );
        batch.mesh.setMatrixAt(instance, matrix);
        if (updateColors) {
          batch.mesh.setColorAt(
            instance,
            color.set(SEVERITY_COLOR[marker.severity]),
          );
        }
        instance += 1;
      }
      batch.mesh.count = instance;
      batch.mesh.instanceMatrix.needsUpdate = true;
      if (updateColors && batch.mesh.instanceColor !== null) {
        batch.mesh.instanceColor.needsUpdate = true;
      }
      visibleMarkers += instance;
    }
    this.visibleMarkers = visibleMarkers;
  }

  private worldUnitsPerPixel(
    position: DesignSmellOverlayMarker["position"],
  ): number {
    if (this.view === undefined) {
      return (
        DESIGN_SMELL_MARKER_DEFAULT_WORLD_DIAMETER /
        DESIGN_SMELL_MARKER_TARGET_CSS_PIXELS
      );
    }
    const { camera, unitsPerPixelScale, depthScaled } = this.view;
    if (!depthScaled) return unitsPerPixelScale;
    this.cameraSpace
      .set(position.x, position.y, position.z)
      .applyMatrix4(camera.matrixWorldInverse);
    const depth = Math.max(-this.cameraSpace.z, camera.near, 0.01);
    return unitsPerPixelScale * depth;
  }

  private clearBatches(): void {
    for (const batch of this.batches.splice(0)) {
      this.object.remove(batch.mesh);
      batch.mesh.dispose();
    }
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new Error("The design-smell overlay has been disposed.");
    }
  }
}
