import * as THREE from "three";

export interface EvolutionRemovalDefinition {
  readonly id: string;
  readonly districtId: string;
  readonly position: {
    readonly x: number;
    readonly y: number;
    readonly z: number;
  };
  readonly size: {
    readonly x: number;
    readonly y: number;
    readonly z: number;
  };
}

export interface EvolutionRemovalDiagnostics {
  readonly totalCount: number;
  readonly visibleCount: number;
  readonly objectCount: 1;
  readonly geometryCount: 1;
  readonly materialCount: 1;
  readonly drawCalls: 0 | 1;
}

const REMOVAL_OPACITY = 0.48;
const IDENTITY_ROTATION = new THREE.Quaternion();

/**
 * A bounded removal-cue layer.
 *
 * Every removed building shares one unit-box geometry and one material.
 * Instance matrices are rebuilt only when district isolation changes; frame
 * animation updates one opacity uniform instead of touching every building.
 */
export class EvolutionRemovalLayer {
  public readonly object: THREE.InstancedMesh<
    THREE.BoxGeometry,
    THREE.MeshBasicMaterial
  >;

  private readonly definitions: readonly EvolutionRemovalDefinition[];
  private readonly matrix = new THREE.Matrix4();
  private readonly position = new THREE.Vector3();
  private readonly scale = new THREE.Vector3();
  private disposed = false;
  private visibleCount = 0;

  public constructor(
    definitions: readonly EvolutionRemovalDefinition[],
  ) {
    this.definitions = definitions;
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshBasicMaterial({
      color: "#fb7185",
      transparent: true,
      opacity: REMOVAL_OPACITY,
      depthWrite: false,
    });
    this.object = new THREE.InstancedMesh(
      geometry,
      material,
      definitions.length,
    );
    this.object.name = "code-city:evolution-removals";
    this.object.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    // Rebuilding a 25k-instance bounding volume on every isolation change
    // costs more than drawing this single translucent cue batch.
    this.object.frustumCulled = false;
    this.setIsolatedDistrict(null);
  }

  public setIsolatedDistrict(districtId: string | null): void {
    this.assertActive();
    let instanceIndex = 0;
    for (const definition of this.definitions) {
      if (
        districtId !== null &&
        definition.districtId !== districtId
      ) {
        continue;
      }
      this.position.set(
        definition.position.x,
        definition.position.y,
        definition.position.z,
      );
      this.scale.set(
        definition.size.x,
        definition.size.y,
        definition.size.z,
      );
      this.matrix.compose(
        this.position,
        IDENTITY_ROTATION,
        this.scale,
      );
      this.object.setMatrixAt(instanceIndex, this.matrix);
      instanceIndex += 1;
    }
    this.visibleCount = instanceIndex;
    this.object.count = instanceIndex;
    this.object.instanceMatrix.needsUpdate = true;
    this.object.visible =
      instanceIndex > 0 && this.object.material.opacity > 0;
  }

  public setProgress(progress: number): void {
    this.assertActive();
    const bounded = Math.min(1, Math.max(0, progress));
    this.object.material.opacity = REMOVAL_OPACITY * (1 - bounded);
    this.object.visible =
      this.visibleCount > 0 && this.object.material.opacity > 0;
  }

  public diagnostics(): EvolutionRemovalDiagnostics {
    this.assertActive();
    return Object.freeze({
      totalCount: this.definitions.length,
      visibleCount: this.visibleCount,
      objectCount: 1 as const,
      geometryCount: 1 as const,
      materialCount: 1 as const,
      drawCalls:
        this.object.visible && this.visibleCount > 0
          ? (1 as const)
          : (0 as const),
    });
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.object.geometry.dispose();
    this.object.material.dispose();
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new Error("Evolution removal layer is disposed.");
    }
  }
}
