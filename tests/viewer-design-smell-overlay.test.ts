import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";

import {
  DesignSmellOverlay,
  MAXIMUM_DESIGN_SMELL_OVERLAY_MARKERS,
  type DesignSmellOverlayMarker,
} from "../apps/viewer/src/design-smell-overlay.js";

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

describe("design smell 3D overlay", () => {
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
    overlay.setIsolatedDistrict("district-critical");

    expect(overlay.diagnostics()).toMatchObject({
      candidateMarkers: MAXIMUM_DESIGN_SMELL_OVERLAY_MARKERS + 1,
      visibleMarkers: 1,
      omittedMarkers: 1,
    });
    overlay.dispose();
  });

  it("deduplicates a building/rule and hides markers outside isolation", () => {
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

    overlay.setIsolatedDistrict("district-a");
    expect(overlay.diagnostics().visibleMarkers).toBe(1);
    overlay.setIsolatedDistrict(null);
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
