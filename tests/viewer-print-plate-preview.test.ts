import { describe, expect, it, vi } from "vitest";

import {
  normalizePrintLayoutPreviewPlan,
  PrintPlatePreviewController,
  printLayoutPreviewPlanFromBundle,
  projectPrintPlate,
  viewerPrintMeshBatches,
  viewerPrintMeshBuffers,
  withPrintLayoutPreviewReadiness,
  type PrintLayoutPreviewPlan,
  type PrintPreviewBounds,
  type PrintPreviewMesh,
} from "../apps/viewer/src/print-plate-preview.js";
import { installPrintPlateToolbar } from "../apps/viewer/src/print-plate-toolbar.js";

function bounds(
  x: number,
  y: number,
  z: number,
  origin = { x: 0, y: 0, z: 0 },
): PrintPreviewBounds {
  return {
    minimum: origin,
    maximum: {
      x: origin.x + x,
      y: origin.y + y,
      z: origin.z + z,
    },
    size: { x, y, z },
  };
}

function meshForBounds(value: PrintPreviewBounds): PrintPreviewMesh {
  const { minimum, maximum } = value;
  return {
    vertices: [
      { x: minimum.x, y: minimum.y, z: minimum.z },
      { x: maximum.x, y: minimum.y, z: minimum.z },
      { x: maximum.x, y: maximum.y, z: minimum.z },
      { x: minimum.x, y: maximum.y, z: minimum.z },
      { x: minimum.x, y: minimum.y, z: maximum.z },
      { x: maximum.x, y: minimum.y, z: maximum.z },
      { x: maximum.x, y: maximum.y, z: maximum.z },
      { x: minimum.x, y: maximum.y, z: maximum.z },
    ],
    triangles: [
      { a: 0, b: 2, c: 1 },
      { a: 0, b: 3, c: 2 },
      { a: 4, b: 5, c: 6 },
      { a: 4, b: 6, c: 7 },
      { a: 0, b: 1, c: 5 },
      { a: 0, b: 5, c: 4 },
      { a: 1, b: 2, c: 6 },
      { a: 1, b: 6, c: 5 },
      { a: 2, b: 3, c: 7 },
      { a: 2, b: 7, c: 6 },
      { a: 3, b: 0, c: 4 },
      { a: 3, b: 4, c: 7 },
    ],
  };
}

function plan(): PrintLayoutPreviewPlan {
  const districtBounds = bounds(20, 4, 10, { x: 10, y: 1, z: 7 });
  const baseBounds = bounds(200, 0.8, 150);
  return {
    requestedPolicy: "tile",
    appliedPolicy: "tile",
    requestedScale: 3,
    appliedScale: 2.5,
    sourceBounds: bounds(500, 40, 300),
    printableBounds: bounds(340, 40, 340),
    plates: [
      {
        id: "plate-b",
        index: 1,
        fileName: "city-plate-2.3mf",
        bounds: bounds(120, 20, 80),
        utilization: 0.25,
        channels: ["base", "risk"],
        entities: [
          {
            id: "district-b",
            kind: "district",
            semanticGroupId: "base",
            channelId: "tool-1",
            bounds: districtBounds,
            mesh: meshForBounds(districtBounds),
          },
        ],
        routes: [
          {
            id: "route-b",
            points: [
              { x: 1, y: 2, z: 3 },
              { x: 4, y: 2, z: 6 },
            ],
          },
        ],
        warnings: [],
      },
      {
        id: "plate-a",
        index: 0,
        fileName: "city-plate-1.3mf",
        bounds: bounds(200, 25, 150),
        utilization: 0.75,
        channels: ["base"],
        entities: [
          {
            id: "base-a",
            kind: "base",
            bounds: baseBounds,
            mesh: meshForBounds(baseBounds),
          },
        ],
        warnings: ["One cross-plate route was omitted."],
      },
    ],
    warnings: [],
    unplacedObjects: [],
  };
}

class FakeElement {
  public readonly dataset: Record<string, string> = {};
  public readonly attributes = new Map<string, string>();
  public readonly listeners = new Map<string, Set<() => void>>();
  public readonly children: FakeElement[] = [];
  public disabled = false;
  public hidden = false;
  public value = "";
  public selected = false;
  public textContent: string | null = null;
  public readonly ownerDocument = {
    createElement: () => new FakeElement(),
  };

  public setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  public addEventListener(type: string, listener: () => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  public removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  public replaceChildren(...children: FakeElement[]): void {
    this.children.splice(0, this.children.length, ...children);
  }

  public emit(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
}

describe("exact print-plate preview projection", () => {
  it("sorts plates deterministically and projects exporter bounds unchanged", () => {
    const normalized = normalizePrintLayoutPreviewPlan(plan());
    expect(normalized.plates.map(({ id }) => id)).toEqual([
      "plate-a",
      "plate-b",
    ]);

    const projected = projectPrintPlate(normalized, "plate-b");
    expect(projected).toMatchObject({
      plateId: "plate-b",
      plateIndex: 1,
      appliedScale: 2.5,
      utilization: 0.25,
      entities: [
        {
          id: "district-b",
          bounds: {
            minimum: { x: 10, y: 1, z: 7 },
            maximum: { x: 30, y: 5, z: 17 },
          },
          position: { x: 20, y: 3, z: 12 },
          size: { x: 20, y: 4, z: 10 },
        },
      ],
      routes: [{ id: "route-b" }],
    });
    expect(projected.entities[0]?.bounds).toEqual(
      normalized.plates[1]?.entities[0]?.bounds,
    );
  });

  it("adapts bundle primitives without deriving a second layout", () => {
    const primitiveBounds = bounds(8, 12, 6, {
      x: 19,
      y: 0.8,
      z: 31,
    });
    const adapted = printLayoutPreviewPlanFromBundle({
      fitPolicy: "tile",
      requestedScale: 3,
      appliedScale: 2,
      sourceBounds: bounds(700, 90, 500),
      printableBounds: bounds(340, 90, 340),
      warnings: ["Scaled before tiling."],
      unplacedObjects: [{ id: "external:unused" }],
      plates: [
        {
          number: 1,
          id: "plate-1",
          fileName: "city-plate-1.3mf",
          utilization: 0.5,
          bounds: bounds(300, 50, 200),
          warnings: [],
          parts: [
            {
              channelId: "tool-2",
              primitives: [
                {
                  id: "building-1",
                  kind: "building",
                  semanticGroupId: "risk-high",
                  bounds: primitiveBounds,
                  mesh: meshForBounds(primitiveBounds),
                },
              ],
            },
          ],
        },
      ],
    });

    expect(adapted).toMatchObject({
      requestedPolicy: "tile",
      appliedPolicy: "tile",
      requestedScale: 3,
      appliedScale: 2,
      unplacedObjects: ["external:unused"],
      plates: [
        {
          id: "plate-1",
          index: 0,
          channels: ["tool-2"],
          entities: [
            {
              id: "building-1",
              channelId: "tool-2",
              bounds: primitiveBounds,
            },
          ],
        },
      ],
    });
    expect(adapted.plates[0]?.entities[0]?.bounds).toEqual(
      primitiveBounds,
    );
  });

  it("keeps selection across plans and falls back without stale plate ids", () => {
    const states: string[] = [];
    const controller = new PrintPlatePreviewController({
      onStateChange: (state) => {
        states.push(`${state.mode}:${state.selectedPlateId ?? "none"}`);
      },
    });
    controller.setPlan(plan());
    expect(controller.state).toMatchObject({
      mode: "city",
      selectedPlateId: "plate-a",
    });
    expect(controller.state.projection).toBeUndefined();
    controller.show("plates");
    expect(controller.state.projection?.entities[0]?.bounds).toBe(
      controller.state.plan?.plates[0]?.entities[0]?.bounds,
    );
    controller.selectPlate("plate-b");
    expect(controller.state.projection?.plateId).toBe("plate-b");

    controller.setPlan({
      ...plan(),
      plates: [plan().plates[1]!],
    });
    expect(controller.state).toMatchObject({
      mode: "plates",
      selectedPlateId: "plate-a",
    });
    controller.setPlan(undefined);
    expect(controller.state).toEqual({
      mode: "city",
      selectorOptions: [],
    });
    expect(states).toContain("plates:plate-b");
  });

  it("rejects malformed bounds and duplicate exact entities", () => {
    const valid = plan();
    const invalidBounds: PrintLayoutPreviewPlan = {
      ...valid,
      plates: [
        {
          ...valid.plates[0]!,
          bounds: {
            ...valid.plates[0]!.bounds,
            size: { ...valid.plates[0]!.bounds.size, x: 999 },
          },
        },
        ...valid.plates.slice(1),
      ],
    };
    expect(() => normalizePrintLayoutPreviewPlan(invalidBounds)).toThrow(
      /size/iu,
    );

    const entity = valid.plates[0]!.entities[0]!;
    const duplicate: PrintLayoutPreviewPlan = {
      ...valid,
      plates: [
        {
          ...valid.plates[0]!,
          entities: [entity, entity],
        },
        ...valid.plates.slice(1),
      ],
    };
    expect(() => normalizePrintLayoutPreviewPlan(duplicate)).toThrow(
      /duplicate/iu,
    );
  });

  it("preserves exporter mesh topology and maps it into viewer axes", () => {
    const normalized = normalizePrintLayoutPreviewPlan(plan());
    const sourceMesh = plan().plates[0]!.entities[0]!.mesh;
    expect(normalized.plates[1]!.entities[0]!.mesh).toEqual(sourceMesh);

    const buffers = viewerPrintMeshBuffers({
      vertices: [
        { x: 1, y: 2, z: 3 },
        { x: 4, y: 5, z: 6 },
        { x: 7, y: 8, z: 9 },
      ],
      triangles: [{ a: 0, b: 1, c: 2 }],
    });
    expect([...buffers.positions]).toEqual([1, 3, 2, 4, 6, 5, 7, 9, 8]);
    expect([...buffers.indices]).toEqual([0, 2, 1]);
  });

  it("rejects malformed mesh topology and mesh/bounds drift", () => {
    const valid = plan();
    const entity = valid.plates[0]!.entities[0]!;
    expect(() =>
      normalizePrintLayoutPreviewPlan({
        ...valid,
        plates: [
          {
            ...valid.plates[0]!,
            entities: [
              {
                ...entity,
                mesh: {
                  ...entity.mesh,
                  triangles: [{ a: 0, b: 1, c: 999 }],
                },
              },
            ],
          },
          ...valid.plates.slice(1),
        ],
      }),
    ).toThrow(/triangle/iu);

    expect(() =>
      normalizePrintLayoutPreviewPlan({
        ...valid,
        plates: [
          {
            ...valid.plates[0]!,
            entities: [
              {
                ...entity,
                mesh: {
                  ...entity.mesh,
                  vertices: entity.mesh.vertices.map((vertex) => ({
                    ...vertex,
                    x: vertex.x + 1,
                  })),
                },
              },
            ],
          },
          ...valid.plates.slice(1),
        ],
      }),
    ).toThrow(/does not match.*bounds/iu);
  });

  it("rejects exact meshes and routes outside their declared plate", () => {
    const valid = plan();
    const plate = valid.plates[0]!;
    const outside = bounds(1, 1, 1, {
      x: plate.bounds.maximum.x + 1,
      y: 0,
      z: 0,
    });
    expect(() =>
      normalizePrintLayoutPreviewPlan({
        ...valid,
        plates: [{
          ...plate,
          entities: [
            ...plate.entities,
            {
              id: "outside",
              kind: "building",
              bounds: outside,
              mesh: meshForBounds(outside),
            },
          ],
        }],
      }),
    ).toThrow(/outside.*bounds/iu);
    expect(() =>
      normalizePrintLayoutPreviewPlan({
        ...valid,
        plates: [{
          ...plate,
          routes: [{
            id: "outside-route",
            points: [
              plate.bounds.minimum,
              {
                ...plate.bounds.maximum,
                x: plate.bounds.maximum.x + 1,
              },
            ],
          }],
        }],
      }),
    ).toThrow(/route outside/iu);
  });

  it("reuses normalized plans and batches a bounded large exact preview", () => {
    const normalized = normalizePrintLayoutPreviewPlan(plan());
    expect(normalizePrintLayoutPreviewPlan(normalized)).toBe(normalized);
    const ready = withPrintLayoutPreviewReadiness(normalized, "ready");
    expect(ready.plates).toBe(normalized.plates);
    expect(withPrintLayoutPreviewReadiness(ready, "ready")).toBe(ready);

    const entity = normalized.plates[0]!.entities[0]!;
    const entities = Array.from({ length: 5_000 }, (_, index) => ({
      ...entity,
      id: `batched-${index}`,
    }));
    const batches = viewerPrintMeshBatches(entities, () => "shared");
    expect(batches).toHaveLength(1);
    expect(batches[0]!.buffers.positions).toHaveLength(
      entity.mesh.vertices.length * entities.length * 3,
    );
    expect(Math.max(...batches[0]!.buffers.indices.slice(-36))).toBe(
      entity.mesh.vertices.length * entities.length - 1,
    );
  });

  it("rejects plate and route payloads beyond browser preview limits", () => {
    const valid = plan();
    expect(() =>
      normalizePrintLayoutPreviewPlan({
        ...valid,
        plates: Array.from({ length: 100 }, (_, index) => ({
          ...valid.plates[0]!,
          id: `plate-${index + 1}`,
          index,
          fileName: `plate-${index + 1}.3mf`,
        })),
      }),
    ).toThrow(/too many plates/iu);

    expect(() =>
      normalizePrintLayoutPreviewPlan({
        ...valid,
        plates: [{
          ...valid.plates[0]!,
          entities: new Array(100_001).fill(
            valid.plates[0]!.entities[0]!,
          ),
        }],
      }),
    ).toThrow(/entity limits/iu);

    expect(() =>
      normalizePrintLayoutPreviewPlan({
        ...valid,
        plates: [
          {
            ...valid.plates[0]!,
            routes: [
              {
                id: "route-too-detailed",
                points: Array.from({ length: 10_001 }, (_, index) => ({
                  x: index,
                  y: 0,
                  z: 0,
                })),
              },
            ],
          },
        ],
      }),
    ).toThrow(/between 2 and/iu);
  });
});

describe("canvas print-plate toolbar behavior", () => {
  it("toggles modes, populates the selector, and detaches listeners", () => {
    const root = new FakeElement();
    const city = new FakeElement();
    const plates = new FakeElement();
    const select = new FakeElement();
    const status = new FakeElement();
    const onStateChange = vi.fn();
    const toolbar = installPrintPlateToolbar(
      {
        root: root as unknown as HTMLElement,
        cityModeButton: city as unknown as HTMLButtonElement,
        platesModeButton: plates as unknown as HTMLButtonElement,
        plateSelect: select as unknown as HTMLSelectElement,
        status: status as unknown as HTMLElement,
      },
      { onStateChange },
    );

    expect(root.hidden).toBe(true);
    expect(plates.disabled).toBe(true);
    expect(select.attributes.get("aria-label")).toBe("Print plate");
    expect(status.attributes.get("aria-live")).toBe("polite");
    toolbar.setPlan(plan());
    expect(root.hidden).toBe(false);
    expect(plates.disabled).toBe(false);
    expect(select.children.map(({ value }) => value)).toEqual([
      "plate-a",
      "plate-b",
    ]);

    plates.emit("click");
    expect(root.dataset["previewMode"]).toBe("plates");
    expect(select.hidden).toBe(false);
    select.value = "plate-b";
    select.emit("change");
    expect(toolbar.state.selectedPlateId).toBe("plate-b");
    expect(status.textContent).toMatch(/Plate 2 of 2/iu);

    toolbar.setPlan({ ...plan(), readiness: "planned" });
    expect(status.textContent).toMatch(/planned/iu);
    toolbar.setPlan({ ...plan(), readiness: "ready" });
    expect(status.textContent).toMatch(/ready/iu);
    toolbar.setPlan(undefined);
    expect(root.hidden).toBe(true);
    toolbar.setPlan(plan());
    toolbar.show("plates");

    toolbar.dispose();
    city.emit("click");
    expect(toolbar.state.mode).toBe("plates");
    expect(onStateChange).toHaveBeenCalled();
  });
});
