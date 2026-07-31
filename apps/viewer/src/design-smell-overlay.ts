import * as THREE from "three";

import {
  DESIGN_SMELL_RULE_CATALOG,
  type DesignSmellId,
  type DesignSmellSeverity,
} from "../../../packages/core/src/index.js";

export const MAXIMUM_DESIGN_SMELL_OVERLAY_MARKERS = 2_000;

type MarkerCategory = "complexity" | "size" | "coupling" | "structure";

export interface DesignSmellOverlayMarker {
  readonly id: string;
  readonly buildingId: string;
  readonly districtId: string;
  readonly ruleId: DesignSmellId;
  readonly severity: DesignSmellSeverity;
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
  readonly mesh: THREE.InstancedMesh<
    THREE.BufferGeometry,
    THREE.MeshBasicMaterial
  >;
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
  private isolatedDistrictId: string | null = null;
  private requestedFindings = 0;
  private candidateMarkers = 0;
  private omittedMarkers = 0;
  private visibleMarkers = 0;
  private disposed = false;

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

  public setIsolatedDistrict(id: string | null): void {
    this.assertActive();
    this.isolatedDistrictId = id;
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
      const batch = {
        category,
        markers: Object.freeze(categoryMarkers),
        mesh,
      };
      this.batches.push(batch);
      this.object.add(mesh);
    }
    this.populateBatches();
  }

  private populateBatches(): void {
    const levelsByBuilding = new Map<string, number>();
    const matrix = new THREE.Matrix4();
    const color = new THREE.Color();
    let visibleMarkers = 0;
    for (const batch of this.batches) {
      let instance = 0;
      for (const marker of batch.markers) {
        if (
          this.isolatedDistrictId !== null &&
          marker.districtId !== this.isolatedDistrictId
        ) {
          continue;
        }
        const level =
          levelsByBuilding.get(marker.buildingId) ?? 0;
        levelsByBuilding.set(marker.buildingId, level + 1);
        matrix.makeTranslation(
          marker.position.x,
          marker.position.y + level * 0.38,
          marker.position.z,
        );
        batch.mesh.setMatrixAt(instance, matrix);
        batch.mesh.setColorAt(
          instance,
          color.set(SEVERITY_COLOR[marker.severity]),
        );
        instance += 1;
      }
      batch.mesh.count = instance;
      batch.mesh.instanceMatrix.needsUpdate = true;
      if (batch.mesh.instanceColor !== null) {
        batch.mesh.instanceColor.needsUpdate = true;
      }
      batch.mesh.computeBoundingBox();
      batch.mesh.computeBoundingSphere();
      visibleMarkers += instance;
    }
    this.visibleMarkers = visibleMarkers;
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
