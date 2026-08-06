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

export type EvolutionRemovalRenderMode = "instanced" | "merged";

export interface EvolutionRemovalDiagnostics {
  readonly renderMode: EvolutionRemovalRenderMode;
  readonly totalCount: number;
  readonly visibleCount: number;
  readonly objectCount: 1;
  readonly geometryCount: 1;
  readonly materialCount: 1;
  readonly drawCalls: 0 | 1;
}

export interface EvolutionRemovalLayerOptions {
  readonly instancingSupported?: boolean;
}

type EvolutionRemovalObject =
  | THREE.InstancedMesh<THREE.BoxGeometry, THREE.MeshBasicMaterial>
  | THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;

const REMOVAL_OPACITY = 0.48;
const IDENTITY_ROTATION = new THREE.Quaternion();

// A non-indexed unit cube keeps the WebGL 1 fallback independent of
// OES_element_index_uint. MeshBasicMaterial does not require normals.
const UNIT_BOX_TRIANGLES = new Float32Array([
  // Front.
  -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5,
  -0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5,
  // Back.
  0.5, -0.5, -0.5, -0.5, -0.5, -0.5, -0.5, 0.5, -0.5,
  0.5, -0.5, -0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5,
  // Right.
  0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5,
  0.5, -0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5,
  // Left.
  -0.5, -0.5, -0.5, -0.5, -0.5, 0.5, -0.5, 0.5, 0.5,
  -0.5, -0.5, -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, -0.5,
  // Top.
  -0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, -0.5,
  -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5,
  // Bottom.
  -0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, -0.5, 0.5,
  -0.5, -0.5, -0.5, 0.5, -0.5, 0.5, -0.5, -0.5, 0.5,
]);

/**
 * A bounded removal-cue layer.
 *
 * Every removed building shares one material and renders in one draw call.
 * Capable browsers use a unit-box InstancedMesh. The existing non-instancing
 * viewer fallback gets one merged, non-indexed geometry instead of regressing
 * to a mesh, material, and draw call per removal.
 *
 * Instance or vertex data is rebuilt only when the exact building mask
 * changes; frame animation updates one opacity uniform instead of touching
 * every cue.
 */
export class EvolutionRemovalLayer {
  public readonly object: EvolutionRemovalObject;
  public readonly mode: EvolutionRemovalRenderMode;

  private readonly definitions: readonly EvolutionRemovalDefinition[];
  private readonly matrix = new THREE.Matrix4();
  private readonly position = new THREE.Vector3();
  private readonly scale = new THREE.Vector3();
  private visibleBuildingIds: ReadonlySet<string> | null = null;
  private disposed = false;
  private visibleCount = 0;

  public constructor(
    definitions: readonly EvolutionRemovalDefinition[],
    options: EvolutionRemovalLayerOptions = {},
  ) {
    this.definitions = definitions;
    const material = new THREE.MeshBasicMaterial({
      color: "#fb7185",
      transparent: true,
      opacity: REMOVAL_OPACITY,
      depthWrite: false,
    });
    this.mode =
      options.instancingSupported === false ? "merged" : "instanced";
    if (this.mode === "instanced") {
      const object = new THREE.InstancedMesh(
        new THREE.BoxGeometry(1, 1, 1),
        material,
        definitions.length,
      );
      object.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.object = object;
    } else {
      this.object = new THREE.Mesh(new THREE.BufferGeometry(), material);
    }
    this.object.name = "code-city:evolution-removals";
    this.object.frustumCulled = false;
    this.object.raycast = () => undefined;
    this.refreshVisibleDefinitions();
  }

  /**
   * Applies the same exact building mask as the live city layer.
   *
   * Removal cues that no longer belong to the retained selection stay hidden
   * during an evolution seek, instead of leaking unrelated buildings through
   * an otherwise masked view.
   */
  public setVisibleBuildingIds(ids: readonly string[] | null): void {
    this.assertActive();
    this.visibleBuildingIds = ids === null ? null : new Set(ids);
    this.refreshVisibleDefinitions();
  }

  private refreshVisibleDefinitions(): void {
    const visibleDefinitions =
      this.visibleBuildingIds === null
        ? this.definitions
        : this.definitions.filter(
            (definition) =>
              this.visibleBuildingIds?.has(definition.id) === true,
          );
    this.visibleCount = visibleDefinitions.length;
    if (this.object instanceof THREE.InstancedMesh) {
      this.populateInstances(visibleDefinitions);
    } else {
      const previous = this.object.geometry;
      this.object.geometry = mergedRemovalGeometry(visibleDefinitions);
      previous.dispose();
    }
    this.object.visible =
      this.visibleCount > 0 && this.object.material.opacity > 0;
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
      renderMode: this.mode,
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
    if (this.object instanceof THREE.InstancedMesh) {
      this.object.dispose();
    }
    this.object.geometry.dispose();
    this.object.material.dispose();
  }

  private populateInstances(
    definitions: readonly EvolutionRemovalDefinition[],
  ): void {
    const object = this.object;
    if (!(object instanceof THREE.InstancedMesh)) return;
    let instanceIndex = 0;
    for (const definition of definitions) {
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
      object.setMatrixAt(instanceIndex, this.matrix);
      instanceIndex += 1;
    }
    object.count = instanceIndex;
    object.instanceMatrix.needsUpdate = true;
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new Error("Evolution removal layer is disposed.");
    }
  }
}

function mergedRemovalGeometry(
  definitions: readonly EvolutionRemovalDefinition[],
): THREE.BufferGeometry {
  const positions = new Float32Array(
    definitions.length * UNIT_BOX_TRIANGLES.length,
  );
  let offset = 0;
  for (const definition of definitions) {
    for (let index = 0; index < UNIT_BOX_TRIANGLES.length; index += 3) {
      positions[offset] =
        definition.position.x +
        UNIT_BOX_TRIANGLES[index]! * definition.size.x;
      positions[offset + 1] =
        definition.position.y +
        UNIT_BOX_TRIANGLES[index + 1]! * definition.size.y;
      positions[offset + 2] =
        definition.position.z +
        UNIT_BOX_TRIANGLES[index + 2]! * definition.size.z;
      offset += 3;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  return geometry;
}
