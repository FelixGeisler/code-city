import * as THREE from "three";

import {
  BuildingAabbBvh,
  type BuildingBvhBounds,
  type BuildingBvhPickOptions,
  type BuildingBvhPickResult,
  type BuildingBvhRay,
} from "./viewer-building-bvh.js";

export const ORDINARY_MESH_BUILDING_LIMIT = 500;

export interface ViewerBuildingVector {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface ViewerBuildingMaterialStyle {
  readonly roughness: number;
  readonly metalness: number;
  readonly flatShading?: boolean;
}

export interface ViewerBuildingDefinition {
  readonly id: string;
  readonly districtId: string;
  readonly position: ViewerBuildingVector;
  readonly size: ViewerBuildingVector;
  readonly color: string;
  readonly style: ViewerBuildingMaterialStyle;
}

export interface ViewerBuildingBatchPlan {
  readonly key: string;
  readonly style: ViewerBuildingMaterialStyle;
  readonly buildingIds: readonly string[];
}

export interface ViewerBuildingLayerOptions {
  readonly instancingSupported?: boolean;
  readonly ordinaryMeshLimit?: number;
}

export type ViewerBuildingRenderMode = "instanced" | "ordinary";
export type ViewerBuildingHighlightSlot = "hovered" | "selected";

export interface ViewerBuildingPickBenchmark {
  readonly count: number;
  readonly p95Milliseconds: number;
  readonly maximumAabbTests: number;
}

interface CanonicalBuilding extends ViewerBuildingDefinition {
  readonly colorValue: number;
  readonly matrix: THREE.Matrix4;
  readonly bounds: THREE.Box3;
}

interface BuildingBatch {
  readonly plan: ViewerBuildingBatchPlan;
  readonly buildings: readonly CanonicalBuilding[];
  readonly mesh: THREE.InstancedMesh<
    THREE.BoxGeometry,
    THREE.MeshStandardMaterial
  >;
  visibleBuildingIds: readonly string[];
}

const HIGHLIGHT_SCALE = new THREE.Matrix4().makeScale(1.035, 1.035, 1.035);
const DEFAULT_STYLE: ViewerBuildingMaterialStyle = Object.freeze({
  roughness: 0.58,
  metalness: 0.08,
  flatShading: false,
});

export class ViewerBuildingCapabilityError extends Error {
  public constructor(buildingCount: number, ordinaryMeshLimit: number) {
    super(
      `This browser cannot render ${buildingCount.toLocaleString()} buildings ` +
        `because GPU instancing is unavailable. Use a browser or device with ` +
        `instancing support, or reduce it to at most ` +
        `${ordinaryMeshLimit.toLocaleString()} buildings.`,
    );
    this.name = "ViewerBuildingCapabilityError";
  }
}

export function assertViewerBuildingCapability(
  buildingCount: number,
  instancingSupported: boolean,
  ordinaryMeshLimit = ORDINARY_MESH_BUILDING_LIMIT,
): void {
  if (!Number.isSafeInteger(buildingCount) || buildingCount < 0) {
    throw new RangeError("Building count must be a non-negative safe integer.");
  }
  if (!Number.isSafeInteger(ordinaryMeshLimit) || ordinaryMeshLimit < 0) {
    throw new RangeError(
      "Ordinary-mesh building limit must be a non-negative safe integer.",
    );
  }
  if (!instancingSupported && buildingCount > ordinaryMeshLimit) {
    throw new ViewerBuildingCapabilityError(buildingCount, ordinaryMeshLimit);
  }
}

export function planViewerBuildingBatches(
  definitions: readonly ViewerBuildingDefinition[],
): readonly ViewerBuildingBatchPlan[] {
  const canonical = canonicalDefinitions(definitions);
  const byStyle = new Map<
    string,
    {
      readonly style: ViewerBuildingMaterialStyle;
      readonly buildingIds: string[];
    }
  >();
  for (const building of canonical) {
    const key = materialStyleKey(building.style);
    const existing = byStyle.get(key);
    if (existing) {
      existing.buildingIds.push(building.id);
    } else {
      byStyle.set(key, {
        style: building.style,
        buildingIds: [building.id],
      });
    }
  }
  return Object.freeze(
    [...byStyle.entries()]
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, value]) =>
        Object.freeze({
          key,
          style: value.style,
          buildingIds: Object.freeze([...value.buildingIds]),
        }),
      ),
  );
}

/**
 * Building-only render and picking layer.
 *
 * Instanced batches share one unit box geometry and use per-instance matrices
 * and colors. The two highlight meshes are allocated once and never raycast.
 */
export class ViewerBuildingLayer {
  public readonly object = new THREE.Group();
  public readonly mode: ViewerBuildingRenderMode;

  private readonly geometry = new THREE.BoxGeometry(1, 1, 1);
  private readonly definitions: readonly CanonicalBuilding[];
  private readonly definitionsById = new Map<string, CanonicalBuilding>();
  private readonly districtBoundsById = new Map<string, THREE.Box3>();
  private readonly bvh: BuildingAabbBvh;
  private readonly batches: BuildingBatch[] = [];
  private readonly batchByMesh = new Map<THREE.InstancedMesh, BuildingBatch>();
  private readonly ordinaryMeshes = new Map<
    string,
    THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>
  >();
  private readonly ordinaryMaterials = new Set<THREE.MeshStandardMaterial>();
  private readonly highlights: Record<
    ViewerBuildingHighlightSlot,
    THREE.Mesh<THREE.BoxGeometry, THREE.MeshBasicMaterial>
  >;
  private readonly highlightedIds: Record<
    ViewerBuildingHighlightSlot,
    string | null
  > = {
    hovered: null,
    selected: null,
  };
  private readonly groupHighlight: THREE.InstancedMesh<
    THREE.BoxGeometry,
    THREE.MeshBasicMaterial
  >;
  private groupHighlightedIds: readonly string[] = Object.freeze([]);

  private visibleBuildingIds: ReadonlySet<string> | null = null;
  private disposed = false;

  public constructor(
    definitions: readonly ViewerBuildingDefinition[],
    options: ViewerBuildingLayerOptions = {},
  ) {
    const instancingSupported = options.instancingSupported ?? true;
    const ordinaryMeshLimit =
      options.ordinaryMeshLimit ?? ORDINARY_MESH_BUILDING_LIMIT;
    assertViewerBuildingCapability(
      definitions.length,
      instancingSupported,
      ordinaryMeshLimit,
    );

    this.object.name = "code-city:buildings";
    this.definitions = canonicalDefinitions(definitions);
    for (const definition of this.definitions) {
      this.definitionsById.set(definition.id, definition);
      const districtBounds = this.districtBoundsById.get(
        definition.districtId,
      );
      if (districtBounds) {
        districtBounds.union(definition.bounds);
      } else {
        this.districtBoundsById.set(
          definition.districtId,
          definition.bounds.clone(),
        );
      }
    }
    this.bvh = new BuildingAabbBvh(
      this.definitions.map(buildingBvhBounds),
    );

    this.mode = instancingSupported ? "instanced" : "ordinary";
    if (this.mode === "instanced") {
      this.createInstancedBatches();
    } else {
      this.createLegacyMeshes();
    }

    this.highlights = {
      hovered: this.createHighlight("#ffffff", 0.18),
      selected: this.createHighlight("#ffffff", 0.34),
    };
    this.groupHighlight = this.createGroupHighlight();
    this.object.add(
      this.groupHighlight,
      this.highlights.hovered,
      this.highlights.selected,
    );
  }

  public get size(): number {
    return this.definitions.length;
  }

  public get batchCount(): number {
    return this.batches.length;
  }

  public get visibleBuildingCount(): number {
    if (this.mode === "ordinary") {
      let count = 0;
      for (const mesh of this.ordinaryMeshes.values()) {
        if (mesh.visible) count += 1;
      }
      return count;
    }
    return this.batches.reduce((sum, batch) => sum + batch.mesh.count, 0);
  }

  public get batchObjects(): readonly THREE.InstancedMesh<
    THREE.BoxGeometry,
    THREE.MeshStandardMaterial
  >[] {
    return Object.freeze(this.batches.map(({ mesh }) => mesh));
  }

  public get highlightObjects(): readonly THREE.Mesh[] {
    return Object.freeze([
      this.highlights.hovered,
      this.highlights.selected,
    ]);
  }

  public get groupHighlightObject(): THREE.InstancedMesh<
    THREE.BoxGeometry,
    THREE.MeshBasicMaterial
  > {
    return this.groupHighlight;
  }

  public instanceBuildingId(
    mesh: THREE.InstancedMesh,
    instanceId: number,
  ): string | undefined {
    if (!Number.isSafeInteger(instanceId) || instanceId < 0) {
      return undefined;
    }
    return this.batchByMesh.get(mesh)?.visibleBuildingIds[instanceId];
  }

  public matrix(id: string): THREE.Matrix4 | undefined {
    return this.definitionsById.get(id)?.matrix.clone();
  }

  public bounds(id: string): THREE.Box3 | undefined {
    return this.definitionsById.get(id)?.bounds.clone();
  }

  public selectionBounds(ids: readonly string[]): THREE.Box3 | undefined {
    this.assertActive();
    const bounds = new THREE.Box3();
    let found = false;
    for (const id of new Set(ids)) {
      const building = this.definitionsById.get(id);
      if (building === undefined) continue;
      bounds.union(building.bounds);
      found = true;
    }
    return found ? bounds : undefined;
  }

  public districtBounds(id: string): THREE.Box3 | undefined {
    return this.districtBoundsById.get(id)?.clone();
  }

  public pick(
    ray: BuildingBvhRay,
    options: BuildingBvhPickOptions = {},
  ): BuildingBvhPickResult {
    return this.bvh.pick(ray, {
      ...options,
      ...(this.visibleBuildingIds === null
        ? {}
        : { buildingIds: this.visibleBuildingIds }),
    });
  }

  public benchmarkPicks(count = 50): ViewerBuildingPickBenchmark {
    this.assertActive();
    if (!Number.isSafeInteger(count) || count < 1) {
      throw new RangeError("Benchmark pick count must be a positive safe integer.");
    }
    if (this.definitions.length === 0) {
      return Object.freeze({
        count: 0,
        p95Milliseconds: 0,
        maximumAabbTests: 0,
      });
    }
    const durations: number[] = [];
    let maximumAabbTests = 0;
    for (let index = 0; index < count + 5; index += 1) {
      const definition =
        this.definitions[
          Math.floor(
            (index * this.definitions.length) / (count + 5),
          ) % this.definitions.length
        ]!;
      const startedAt = performance.now();
      const result = this.bvh.pick({
        origin: {
          x: definition.position.x,
          y: definition.bounds.max.y + 1_000,
          z: definition.position.z,
        },
        direction: { x: 0, y: -1, z: 0 },
      });
      const duration = performance.now() - startedAt;
      if (index >= 5) {
        durations.push(duration);
        maximumAabbTests = Math.max(
          maximumAabbTests,
          result.aabbTests,
        );
      }
    }
    durations.sort((left, right) => left - right);
    const p95Index = Math.max(
      0,
      Math.ceil(durations.length * 0.95) - 1,
    );
    return Object.freeze({
      count: durations.length,
      p95Milliseconds: durations[p95Index] ?? 0,
      maximumAabbTests,
    });
  }

  public setVisibleBuildingIds(ids: readonly string[] | null): void {
    this.assertActive();
    if (ids === null) {
      this.visibleBuildingIds = null;
    } else {
      const visible = new Set<string>();
      for (const id of ids) {
        if (this.definitionsById.has(id)) visible.add(id);
      }
      this.visibleBuildingIds = visible;
    }
    this.refreshVisibility();
  }

  private refreshVisibility(): void {
    if (this.mode === "instanced") {
      this.populateBatches();
    } else {
      for (const [buildingId, mesh] of this.ordinaryMeshes) {
        const building = this.definitionsById.get(buildingId)!;
        mesh.visible = this.isBuildingVisible(building);
      }
    }
    this.refreshHighlight("hovered");
    this.refreshHighlight("selected");
    this.refreshGroupHighlight();
  }

  public setHighlight(
    slot: ViewerBuildingHighlightSlot,
    id: string | null,
  ): void {
    this.assertActive();
    this.highlightedIds[slot] = id;
    this.refreshHighlight(slot);
  }

  public setGroupHighlight(
    ids: readonly string[],
    color = "#63e6ff",
  ): void {
    this.assertActive();
    this.groupHighlight.material.color.set(color);
    const seen = new Set<string>();
    const valid: string[] = [];
    for (const id of ids) {
      if (seen.has(id) || !this.definitionsById.has(id)) continue;
      seen.add(id);
      valid.push(id);
    }
    this.groupHighlightedIds = Object.freeze(valid);
    this.refreshGroupHighlight();
  }

  public setColor(id: string, color: string): boolean {
    this.assertActive();
    const building = this.definitionsById.get(id);
    if (!building) return false;
    const colorValue = new THREE.Color(color).getHex();
    Object.assign(building, { color, colorValue });
    if (this.mode === "instanced") {
      this.populateBatchColors();
    } else {
      this.ordinaryMeshes.get(id)?.material.color.setHex(colorValue);
    }
    this.refreshHighlight("hovered");
    this.refreshHighlight("selected");
    return true;
  }

  public setColors(colorsById: ReadonlyMap<string, string>): void {
    this.assertActive();
    for (const [id, color] of colorsById) {
      const building = this.definitionsById.get(id);
      if (!building) continue;
      const colorValue = new THREE.Color(color).getHex();
      Object.assign(building, { color, colorValue });
    }
    if (this.mode === "instanced") {
      this.populateBatchColors();
    } else {
      for (const [id, mesh] of this.ordinaryMeshes) {
        mesh.material.color.setHex(
          this.definitionsById.get(id)!.colorValue,
        );
      }
    }
    this.refreshHighlight("hovered");
    this.refreshHighlight("selected");
  }

  public setEvolutionProgress(
    addedBuildingIds: ReadonlySet<string>,
    fromByBuildingId: ReadonlyMap<
      string,
      {
        readonly position: ViewerBuildingVector;
        readonly size: ViewerBuildingVector;
      }
    >,
    progress: number,
  ): void {
    this.assertActive();
    const bounded = Math.min(1, Math.max(0.02, progress));
    const matrixFor = (building: CanonicalBuilding): THREE.Matrix4 => {
      const from = fromByBuildingId.get(building.id);
      if (
        (!addedBuildingIds.has(building.id) && from === undefined) ||
        bounded === 1
      ) {
        return building.matrix;
      }
      const startPosition = from?.position ?? {
        x: building.position.x,
        y: building.position.y - building.size.y / 2,
        z: building.position.z,
      };
      const startSize = from?.size ?? {
        x: building.size.x,
        y: 0,
        z: building.size.z,
      };
      const lerp = (start: number, end: number): number =>
        start + (end - start) * bounded;
      return new THREE.Matrix4().compose(
        new THREE.Vector3(
          lerp(startPosition.x, building.position.x),
          lerp(startPosition.y, building.position.y),
          lerp(startPosition.z, building.position.z),
        ),
        new THREE.Quaternion(),
        new THREE.Vector3(
          lerp(startSize.x, building.size.x),
          Math.max(0.02, lerp(startSize.y, building.size.y)),
          lerp(startSize.z, building.size.z),
        ),
      );
    };
    if (this.mode === "instanced") {
      for (const batch of this.batches) {
        for (const [index, id] of batch.visibleBuildingIds.entries()) {
          const building = this.definitionsById.get(id);
          if (building) batch.mesh.setMatrixAt(index, matrixFor(building));
        }
        batch.mesh.instanceMatrix.needsUpdate = true;
        batch.mesh.computeBoundingBox();
        batch.mesh.computeBoundingSphere();
      }
    } else {
      for (const [id, mesh] of this.ordinaryMeshes) {
        const building = this.definitionsById.get(id);
        if (!building) continue;
        mesh.matrix.copy(matrixFor(building));
        mesh.matrixWorldNeedsUpdate = true;
      }
    }
    this.refreshHighlight("hovered");
    this.refreshHighlight("selected");
    this.refreshGroupHighlight();
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.object.remove(...this.object.children);
    for (const batch of this.batches) {
      batch.mesh.dispose();
      batch.mesh.material.dispose();
    }
    for (const material of this.ordinaryMaterials) {
      material.dispose();
    }
    this.highlights.hovered.material.dispose();
    this.highlights.selected.material.dispose();
    this.groupHighlight.dispose();
    this.groupHighlight.material.dispose();
    this.geometry.dispose();
    this.batches.length = 0;
    this.batchByMesh.clear();
    this.ordinaryMeshes.clear();
    this.ordinaryMaterials.clear();
  }

  private createInstancedBatches(): void {
    const definitionsById = this.definitionsById;
    for (const plan of planViewerBuildingBatches(this.definitions)) {
      const buildings = plan.buildingIds.map((id) => definitionsById.get(id)!);
      const material = new THREE.MeshStandardMaterial({
        color: "#ffffff",
        roughness: plan.style.roughness,
        metalness: plan.style.metalness,
        flatShading: plan.style.flatShading ?? false,
      });
      const mesh = new THREE.InstancedMesh(
        this.geometry,
        material,
        buildings.length,
      );
      mesh.name = `code-city:buildings:${plan.key}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.raycast = () => undefined;
      const batch: BuildingBatch = {
        plan,
        buildings,
        mesh,
        visibleBuildingIds: Object.freeze([]),
      };
      this.batches.push(batch);
      this.batchByMesh.set(mesh, batch);
      this.object.add(mesh);
    }
    this.populateBatches();
  }

  private populateBatches(): void {
    for (const batch of this.batches) {
      const visibleIds: string[] = [];
      let index = 0;
      for (const building of batch.buildings) {
        if (!this.isBuildingVisible(building)) continue;
        batch.mesh.setMatrixAt(index, building.matrix);
        batch.mesh.setColorAt(index, new THREE.Color(building.colorValue));
        visibleIds.push(building.id);
        index += 1;
      }
      batch.mesh.count = index;
      batch.mesh.instanceMatrix.needsUpdate = true;
      if (batch.mesh.instanceColor) {
        batch.mesh.instanceColor.needsUpdate = true;
      }
      batch.visibleBuildingIds = Object.freeze(visibleIds);
      batch.mesh.computeBoundingBox();
      batch.mesh.computeBoundingSphere();
    }
  }

  private populateBatchColors(): void {
    const color = new THREE.Color();
    for (const batch of this.batches) {
      for (
        let index = 0;
        index < batch.visibleBuildingIds.length;
        index += 1
      ) {
        const building = this.definitionsById.get(
          batch.visibleBuildingIds[index]!,
        )!;
        batch.mesh.setColorAt(
          index,
          color.setHex(building.colorValue),
        );
      }
      if (batch.mesh.instanceColor) {
        batch.mesh.instanceColor.needsUpdate = true;
      }
    }
  }

  private createLegacyMeshes(): void {
    for (const building of this.definitions) {
      const material = new THREE.MeshStandardMaterial({
        color: building.colorValue,
        roughness: building.style.roughness,
        metalness: building.style.metalness,
        flatShading: building.style.flatShading ?? false,
      });
      const mesh = new THREE.Mesh(this.geometry, material);
      mesh.name = `code-city:building:${building.id}`;
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(building.matrix);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.raycast = () => undefined;
      this.ordinaryMaterials.add(material);
      this.ordinaryMeshes.set(building.id, mesh);
      this.object.add(mesh);
    }
  }

  private createHighlight(
    color: string,
    opacity: number,
  ): THREE.Mesh<THREE.BoxGeometry, THREE.MeshBasicMaterial> {
    const material = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity,
      depthWrite: false,
      toneMapped: false,
    });
    const mesh = new THREE.Mesh(this.geometry, material);
    mesh.name = "code-city:building-highlight";
    mesh.matrixAutoUpdate = false;
    mesh.visible = false;
    mesh.renderOrder = 3;
    mesh.raycast = () => undefined;
    return mesh;
  }

  private createGroupHighlight(): THREE.InstancedMesh<
    THREE.BoxGeometry,
    THREE.MeshBasicMaterial
  > {
    const material = new THREE.MeshBasicMaterial({
      color: "#63e6ff",
      transparent: true,
      opacity: 0.28,
      depthWrite: false,
      toneMapped: false,
    });
    const mesh = new THREE.InstancedMesh(
      this.geometry,
      material,
      Math.max(1, this.definitions.length),
    );
    mesh.name = "code-city:building-group-highlight";
    mesh.count = 0;
    mesh.visible = false;
    mesh.renderOrder = 2;
    mesh.raycast = () => undefined;
    return mesh;
  }

  private refreshGroupHighlight(): void {
    let index = 0;
    for (const id of this.groupHighlightedIds) {
      const building = this.definitionsById.get(id);
      if (
        building === undefined ||
        !this.isBuildingVisible(building)
      ) {
        continue;
      }
      this.groupHighlight.setMatrixAt(
        index,
        building.matrix.clone().multiply(HIGHLIGHT_SCALE),
      );
      index += 1;
    }
    this.groupHighlight.count = index;
    this.groupHighlight.visible = index > 0;
    this.groupHighlight.instanceMatrix.needsUpdate = true;
    this.groupHighlight.computeBoundingBox();
    this.groupHighlight.computeBoundingSphere();
  }

  private refreshHighlight(slot: ViewerBuildingHighlightSlot): void {
    const mesh = this.highlights[slot];
    const id = this.highlightedIds[slot];
    const building = id === null ? undefined : this.definitionsById.get(id);
    if (
      building === undefined ||
      !this.isBuildingVisible(building)
    ) {
      mesh.visible = false;
      return;
    }
    mesh.material.color.setHex(building.colorValue);
    mesh.matrix.copy(building.matrix).multiply(HIGHLIGHT_SCALE);
    mesh.matrixWorldNeedsUpdate = true;
    mesh.visible = true;
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new Error("The viewer building layer has been disposed.");
    }
  }

  private isBuildingVisible(building: CanonicalBuilding): boolean {
    return (
      (this.visibleBuildingIds === null ||
        this.visibleBuildingIds.has(building.id))
    );
  }
}

function canonicalDefinitions(
  definitions: readonly ViewerBuildingDefinition[],
): readonly CanonicalBuilding[] {
  const ids = new Set<string>();
  const canonical = definitions.map((definition) => {
    const id = requiredId(definition?.id, "Building ID");
    if (ids.has(id)) {
      throw new TypeError(`Duplicate building ID "${id}".`);
    }
    ids.add(id);
    const districtId = requiredId(
      definition?.districtId,
      `District ID for building "${id}"`,
    );
    const position = finiteVector(
      definition?.position,
      `Position for building "${id}"`,
    );
    const size = positiveVector(
      definition?.size,
      `Size for building "${id}"`,
    );
    const style = canonicalStyle(definition?.style ?? DEFAULT_STYLE);
    const color = requiredId(definition?.color, `Color for building "${id}"`);
    const colorValue = new THREE.Color(color).getHex();
    const matrix = new THREE.Matrix4().compose(
      new THREE.Vector3(position.x, position.y, position.z),
      new THREE.Quaternion(),
      new THREE.Vector3(size.x, size.y, size.z),
    );
    const half = {
      x: size.x * 0.5,
      y: size.y * 0.5,
      z: size.z * 0.5,
    };
    const bounds = new THREE.Box3(
      new THREE.Vector3(
        position.x - half.x,
        position.y - half.y,
        position.z - half.z,
      ),
      new THREE.Vector3(
        position.x + half.x,
        position.y + half.y,
        position.z + half.z,
      ),
    );
    return {
      id,
      districtId,
      position,
      size,
      color,
      colorValue,
      style,
      matrix,
      bounds,
    };
  });
  canonical.sort((left, right) => compareText(left.id, right.id));
  return Object.freeze(canonical);
}

function canonicalStyle(
  style: ViewerBuildingMaterialStyle,
): ViewerBuildingMaterialStyle {
  if (
    !Number.isFinite(style?.roughness) ||
    style.roughness < 0 ||
    style.roughness > 1 ||
    !Number.isFinite(style?.metalness) ||
    style.metalness < 0 ||
    style.metalness > 1
  ) {
    throw new RangeError(
      "Building material roughness and metalness must be between zero and one.",
    );
  }
  return Object.freeze({
    roughness: style.roughness,
    metalness: style.metalness,
    flatShading: style.flatShading ?? false,
  });
}

function materialStyleKey(style: ViewerBuildingMaterialStyle): string {
  return [
    materialNumberKey(style.roughness),
    materialNumberKey(style.metalness),
    style.flatShading === true ? "flat" : "smooth",
  ].join("|");
}

function materialNumberKey(value: number): string {
  return Object.is(value, -0) ? "0" : String(value);
}

function finiteVector(
  value: ViewerBuildingVector,
  label: string,
): ViewerBuildingVector {
  if (
    value === null ||
    typeof value !== "object" ||
    !Number.isFinite(value.x) ||
    !Number.isFinite(value.y) ||
    !Number.isFinite(value.z)
  ) {
    throw new RangeError(`${label} must contain finite coordinates.`);
  }
  return Object.freeze({ x: value.x, y: value.y, z: value.z });
}

function positiveVector(
  value: ViewerBuildingVector,
  label: string,
): ViewerBuildingVector {
  const vector = finiteVector(value, label);
  if (vector.x <= 0 || vector.y <= 0 || vector.z <= 0) {
    throw new RangeError(`${label} must contain positive coordinates.`);
  }
  return vector;
}

function buildingBvhBounds(
  building: CanonicalBuilding,
): BuildingBvhBounds {
  return {
    id: building.id,
    districtId: building.districtId,
    min: {
      x: building.bounds.min.x,
      y: building.bounds.min.y,
      z: building.bounds.min.z,
    },
    max: {
      x: building.bounds.max.x,
      y: building.bounds.max.y,
      z: building.bounds.max.z,
    },
  };
}

function requiredId(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return value;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
