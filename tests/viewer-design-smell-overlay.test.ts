import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";

import {
  DESIGN_SMELL_MARKER_TARGET_CSS_PIXELS,
  DesignSmellOverlay,
  MAXIMUM_DESIGN_SMELL_OVERLAY_MARKERS,
  type DesignSmellOverlayMarker,
} from "../apps/viewer/src/design-smell-overlay.js";

const VIEWPORT_HEIGHT = 500;
const VIEWPORT_ASPECT = 1.6;
const VIEWPORT_WIDTH = VIEWPORT_HEIGHT * VIEWPORT_ASPECT;
const MARKER_PIXEL_TOLERANCE = 0.75;

function marker(index: number): DesignSmellOverlayMarker {
  const rules = [
    "high-complexity-method",
    "oversized-file",
    "excessive-coupling",
    "dependency-cycle",
  ] as const;
  return {
    id: `finding-${index}`,
    buildingId: `building-${index}`,
    districtId: index % 2 === 0 ? "district-a" : "district-b",
    ruleId: rules[index % rules.length]!,
    severity:
      index % 3 === 0
        ? "critical"
        : index % 3 === 1
          ? "high"
          : "moderate",
    position: { x: index, y: 5, z: index },
  };
}

function perspectiveCamera(
  distance: number,
  aspect = VIEWPORT_ASPECT,
): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(45, aspect, 0.1, 10_000);
  camera.position.set(0, 5, distance);
  camera.lookAt(0, 5, 0);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  return camera;
}

function obliquePerspectiveCamera(): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(
    45,
    VIEWPORT_ASPECT,
    0.1,
    10_000,
  );
  camera.position.set(65, 60, 90);
  camera.lookAt(0, 5, 0);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  return camera;
}

function topDownPerspectiveCamera(): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(
    45,
    VIEWPORT_ASPECT,
    0.1,
    10_000,
  );
  camera.position.set(0, 105, 0);
  camera.up.set(0, 0, -1);
  camera.lookAt(0, 5, 0);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  return camera;
}

function orthographicCamera(
  zoom: number,
  oblique = false,
): THREE.OrthographicCamera {
  const camera = new THREE.OrthographicCamera(
    -50 * VIEWPORT_ASPECT,
    50 * VIEWPORT_ASPECT,
    50,
    -50,
    0.1,
    1_000,
  );
  camera.position.set(0, 5, 50);
  if (oblique) camera.position.set(65, 60, 90);
  camera.zoom = zoom;
  camera.lookAt(0, 5, 0);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  return camera;
}

function markerMesh(
  overlay: DesignSmellOverlay,
  category: string,
): THREE.InstancedMesh {
  const mesh = overlay.object.getObjectByName(
    `code-city:design-smells:${category}`,
  );
  expect(mesh).toBeInstanceOf(THREE.InstancedMesh);
  return mesh as THREE.InstancedMesh;
}

function instanceTransform(
  mesh: THREE.InstancedMesh,
  index = 0,
): {
  readonly matrix: THREE.Matrix4;
  readonly position: THREE.Vector3;
  readonly scale: THREE.Vector3;
} {
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3();
  mesh.getMatrixAt(index, matrix);
  matrix.decompose(position, new THREE.Quaternion(), scale);
  return { matrix, position, scale };
}

function projectedPixelBounds(
  mesh: THREE.InstancedMesh,
  camera: THREE.Camera,
  viewportWidth: number,
  viewportHeight: number,
): {
  readonly minimumX: number;
  readonly minimumY: number;
  readonly maximumX: number;
  readonly maximumY: number;
} {
  const { matrix } = instanceTransform(mesh);
  const vertices = mesh.geometry.getAttribute("position");
  const projected = new THREE.Vector3();
  let minimumX = Number.POSITIVE_INFINITY;
  let minimumY = Number.POSITIVE_INFINITY;
  let maximumX = Number.NEGATIVE_INFINITY;
  let maximumY = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < vertices.count; index += 1) {
    projected
      .fromBufferAttribute(vertices as THREE.BufferAttribute, index)
      .applyMatrix4(matrix)
      .project(camera);
    const pixelX = projected.x * viewportWidth / 2;
    const pixelY = projected.y * viewportHeight / 2;
    minimumX = Math.min(minimumX, pixelX);
    minimumY = Math.min(minimumY, pixelY);
    maximumX = Math.max(maximumX, pixelX);
    maximumY = Math.max(maximumY, pixelY);
  }
  return { minimumX, minimumY, maximumX, maximumY };
}

function projectedDiameter(
  mesh: THREE.InstancedMesh,
  camera: THREE.Camera,
  viewportWidth: number,
  viewportHeight: number,
): number {
  const bounds = projectedPixelBounds(
    mesh,
    camera,
    viewportWidth,
    viewportHeight,
  );
  return Math.max(
    bounds.maximumX - bounds.minimumX,
    bounds.maximumY - bounds.minimumY,
  );
}

function transformedVertexBounds(mesh: THREE.InstancedMesh): THREE.Box3 {
  const { matrix } = instanceTransform(mesh);
  const vertices = mesh.geometry.getAttribute("position");
  const bounds = new THREE.Box3();
  const vertex = new THREE.Vector3();
  for (let index = 0; index < vertices.count; index += 1) {
    bounds.expandByPoint(
      vertex
        .fromBufferAttribute(vertices as THREE.BufferAttribute, index)
        .applyMatrix4(matrix),
    );
  }
  return bounds;
}

describe("design smell 3D overlay", () => {
  it("keeps a stable CSS-pixel diameter across camera distance and projection", () => {
    const overlay = new DesignSmellOverlay();
    overlay.replace(
      [0, 1, 2, 3].map((index) => ({
        ...marker(index),
        position: { x: 0, y: 5, z: 0 },
      })),
    );
    const mesh = markerMesh(overlay, "complexity");
    const children = [...overlay.object.children];
    const resources = children.map((child) => {
      const batch = child as THREE.InstancedMesh;
      return { geometry: batch.geometry, material: batch.material };
    });

    const views = [
      {
        label: "near perspective",
        camera: perspectiveCamera(50),
        height: VIEWPORT_HEIGHT,
      },
      {
        label: "far perspective",
        camera: perspectiveCamera(120),
        height: VIEWPORT_HEIGHT,
      },
      {
        label: "whole-city fit",
        camera: perspectiveCamera(703),
        height: 489,
      },
      {
        label: "focused small building",
        camera: perspectiveCamera(5),
        height: VIEWPORT_HEIGHT,
      },
      {
        label: "oblique perspective",
        camera: obliquePerspectiveCamera(),
        height: VIEWPORT_HEIGHT,
      },
      {
        label: "top-down perspective",
        camera: topDownPerspectiveCamera(),
        height: VIEWPORT_HEIGHT,
      },
      {
        label: "orthographic",
        camera: orthographicCamera(1),
        height: VIEWPORT_HEIGHT,
      },
      {
        label: "oblique orthographic",
        camera: orthographicCamera(2, true),
        height: VIEWPORT_HEIGHT,
      },
      {
        label: "short viewport",
        camera: perspectiveCamera(120),
        height: 250,
      },
      {
        label: "tall viewport",
        camera: perspectiveCamera(120),
        height: 1_000,
      },
    ];
    const worldScales: number[] = [];
    for (const { label, camera, height } of views) {
      const width = height * VIEWPORT_ASPECT;
      overlay.updateView(camera, height);
      overlay.object.children.forEach((child, index) => {
        const diameter = projectedDiameter(
          child as THREE.InstancedMesh,
          camera,
          width,
          height,
        );
        expect(diameter, `${label}: ${child.name}`).toBeGreaterThanOrEqual(
          DESIGN_SMELL_MARKER_TARGET_CSS_PIXELS - MARKER_PIXEL_TOLERANCE,
        );
        expect(diameter, `${label}: ${child.name}`).toBeLessThanOrEqual(
          DESIGN_SMELL_MARKER_TARGET_CSS_PIXELS + MARKER_PIXEL_TOLERANCE,
        );
        expect(child).toBe(children[index]);
        expect((child as THREE.InstancedMesh).geometry).toBe(
          resources[index]!.geometry,
        );
        expect((child as THREE.InstancedMesh).material).toBe(
          resources[index]!.material,
        );
      });
      worldScales.push(instanceTransform(mesh).scale.x);
    }
    expect(new Set(worldScales).size).toBeGreaterThan(4);
    expect(overlay.diagnostics()).toMatchObject({
      visibleMarkers: 4,
      batchCount: 4,
    });
    overlay.dispose();
  });

  it("keeps markers above the roof and separates same-building findings", () => {
    const overlay = new DesignSmellOverlay();
    const sameBuilding = [0, 1, 2, 3].map((index) => ({
      ...marker(index),
      buildingId: "shared-building",
      position: { x: 0, y: 5, z: 0 },
    }));
    overlay.replace(sameBuilding);
    const camera = obliquePerspectiveCamera();
    overlay.updateView(camera, VIEWPORT_HEIGHT);

    const projectedRanges = overlay.object.children.map((child) => {
      const mesh = child as THREE.InstancedMesh;
      const bounds = transformedVertexBounds(mesh);
      expect(bounds.min.y - 5).toBeGreaterThanOrEqual(0.08 - 1e-6);
      const projected = projectedPixelBounds(
        mesh,
        camera,
        VIEWPORT_WIDTH,
        VIEWPORT_HEIGHT,
      );
      return [projected.minimumY, projected.maximumY] as const;
    }).sort((left, right) => left[0] - right[0]);

    for (let index = 1; index < projectedRanges.length; index += 1) {
      const gap =
        projectedRanges[index]![0] - projectedRanges[index - 1]![1];
      expect(gap).toBeGreaterThanOrEqual(2 - 0.1);
    }
    overlay.dispose();
  });

  it("preserves marker-to-image ratio in higher-resolution exports", () => {
    const overlay = new DesignSmellOverlay();
    overlay.replace([{ ...marker(0), position: { x: 0, y: 5, z: 0 } }]);
    const camera = perspectiveCamera(120);
    overlay.updateView(camera, VIEWPORT_HEIGHT);
    const mesh = markerMesh(overlay, "complexity");
    const interactiveDiameter = projectedDiameter(
      mesh,
      camera,
      VIEWPORT_WIDTH,
      VIEWPORT_HEIGHT,
    );
    const exportScale = 4;
    const exportDiameter = projectedDiameter(
      mesh,
      camera,
      VIEWPORT_WIDTH * exportScale,
      VIEWPORT_HEIGHT * exportScale,
    );

    expect(exportDiameter).toBeCloseTo(
      interactiveDiameter * exportScale,
      6,
    );
    expect(exportDiameter / (VIEWPORT_HEIGHT * exportScale)).toBeCloseTo(
      interactiveDiameter / VIEWPORT_HEIGHT,
      6,
    );
    overlay.dispose();
  });

  it("skips batch updates for identical and negligible camera changes", () => {
    const overlay = new DesignSmellOverlay();
    overlay.replace([marker(0), marker(1), marker(2), marker(3)]);
    const camera = perspectiveCamera(120);
    overlay.updateView(camera, VIEWPORT_HEIGHT);
    const meshes = overlay.object.children as THREE.InstancedMesh[];
    const versions = meshes.map((mesh) => mesh.instanceMatrix.version);

    overlay.updateView(camera, VIEWPORT_HEIGHT);
    expect(meshes.map((mesh) => mesh.instanceMatrix.version)).toEqual(versions);

    camera.position.x += 5e-7;
    overlay.updateView(camera, VIEWPORT_HEIGHT);
    expect(meshes.map((mesh) => mesh.instanceMatrix.version)).toEqual(versions);

    camera.position.x += 1e-3;
    overlay.updateView(camera, VIEWPORT_HEIGHT);
    meshes.forEach((mesh, index) => {
      expect(mesh.instanceMatrix.version).toBeGreaterThan(versions[index]!);
    });
    overlay.dispose();
  });

  it("rejects invalid viewport heights", () => {
    const overlay = new DesignSmellOverlay();
    const camera = perspectiveCamera(50);
    expect(() => overlay.updateView(camera, 0)).toThrow(RangeError);
    expect(() => overlay.updateView(camera, Number.NaN)).toThrow(RangeError);
    overlay.dispose();
  });

  it("uses bounded instanced batches and reports deterministic omissions", () => {
    const overlay = new DesignSmellOverlay();
    const markers = Array.from(
      { length: MAXIMUM_DESIGN_SMELL_OVERLAY_MARKERS + 50 },
      (_, index) => marker(index),
    );

    overlay.replace(markers);

    expect(overlay.object.children.length).toBeLessThanOrEqual(4);
    expect(
      overlay.object.children.every(
        (child) => child instanceof THREE.InstancedMesh,
      ),
    ).toBe(true);
    expect(overlay.diagnostics()).toMatchObject({
      requestedFindings: markers.length,
      candidateMarkers: markers.length,
      visibleMarkers: MAXIMUM_DESIGN_SMELL_OVERLAY_MARKERS,
      omittedMarkers: 50,
      batchCount: 4,
    });
    overlay.dispose();
  });

  it("retains severe markers before applying the deterministic cap", () => {
    const overlay = new DesignSmellOverlay();
    const moderate = Array.from(
      { length: MAXIMUM_DESIGN_SMELL_OVERLAY_MARKERS },
      (_, index) => ({
        ...marker(index),
        districtId: "district-ordinary",
        severity: "moderate" as const,
      }),
    );
    const critical = {
      ...marker(MAXIMUM_DESIGN_SMELL_OVERLAY_MARKERS),
      id: "finding-late-critical",
      buildingId: "building-late-critical",
      districtId: "district-critical",
      severity: "critical" as const,
    };

    overlay.replace([...moderate, critical]);
    overlay.setVisibleBuildingIds(["building-late-critical"]);

    expect(overlay.diagnostics()).toMatchObject({
      candidateMarkers: MAXIMUM_DESIGN_SMELL_OVERLAY_MARKERS + 1,
      visibleMarkers: 1,
      omittedMarkers: 1,
    });
    overlay.dispose();
  });

  it("deduplicates a building/rule and applies the exact building mask", () => {
    const overlay = new DesignSmellOverlay();
    overlay.replace([
      marker(0),
      { ...marker(0), id: "higher", severity: "critical" },
      marker(1),
    ]);

    expect(overlay.diagnostics()).toMatchObject({
      requestedFindings: 3,
      candidateMarkers: 2,
      visibleMarkers: 2,
      omittedMarkers: 1,
    });

    overlay.setVisibleBuildingIds(["building-1"]);
    expect(overlay.diagnostics().visibleMarkers).toBe(1);
    overlay.setVisibleBuildingIds(null);
    expect(overlay.diagnostics().visibleMarkers).toBe(2);
    overlay.dispose();
  });

  it("disposes every shared geometry and material exactly once", () => {
    const overlay = new DesignSmellOverlay();
    overlay.replace([marker(0), marker(1), marker(2), marker(3)]);
    const meshes = overlay.object.children as THREE.InstancedMesh[];
    const geometries = new Set(meshes.map(({ geometry }) => geometry));
    const materials = new Set(
      meshes.map(({ material }) => material as THREE.Material),
    );
    const geometrySpies = [...geometries].map((geometry) =>
      vi.spyOn(geometry, "dispose"),
    );
    const materialSpies = [...materials].map((material) =>
      vi.spyOn(material, "dispose"),
    );

    overlay.dispose();
    overlay.dispose();

    geometrySpies.forEach((spy) => expect(spy).toHaveBeenCalledOnce());
    materialSpies.forEach((spy) => expect(spy).toHaveBeenCalledOnce());
    expect(overlay.object.children).toHaveLength(0);
  });
});
