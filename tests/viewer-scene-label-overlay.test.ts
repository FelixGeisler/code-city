import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";

import {
  SCENE_LABEL_CANVAS_HEIGHT,
  SCENE_LABEL_CANVAS_WIDTH,
  SCENE_LABEL_FULL_TEXT_USER_DATA_KEY,
  SCENE_LABEL_SCREEN_SCALE_PER_UNIT,
  SceneLabelOverlay,
  layoutSceneLabelText,
  sceneLabelAccessibleName,
  type SceneLabel,
  type SceneLabelCanvasFactory,
  type SceneLabelDrawingContext,
} from "../apps/viewer/src/scene-label-overlay.js";

describe("scene label text layout", () => {
  it("keeps practical long text complete while wrapping and scaling it", () => {
    const measure = (text: string, fontSize: number): number =>
      Array.from(text).length * fontSize;
    const short = layoutSceneLabelText("short label", measure);
    const practical = "@scope/" + "\ud83d\ude80dependency".repeat(20);
    const long = layoutSceneLabelText(practical, measure);

    expect(short.lines).toEqual(["short label"]);
    expect(long.lines.length).toBeGreaterThan(1);
    expect(long.lines.length).toBeLessThanOrEqual(8);
    expect(long.fontSize).toBeLessThan(short.fontSize);
    expect(long.truncated).toBe(false);
    expect(long.lines.join("")).toBe(practical);
    expect(long.sourceText).toBe(practical);
    expect(() => layoutSceneLabelText(" \n ")).toThrow(/must not be empty/u);
  });

  it("retains extreme source text when visual lines must be capped", () => {
    const extreme = "dependency".repeat(500);
    const layout = layoutSceneLabelText(
      extreme,
      (text, fontSize) => Array.from(text).length * fontSize,
    );

    expect(layout.truncated).toBe(true);
    expect(layout.lines).toHaveLength(8);
    expect(layout.lines.at(-1)).toMatch(/\u2026$/u);
    expect(layout.sourceText).toBe(extreme);
  });
});

describe("scene label accessible name", () => {
  it("collapses one entity but preserves equal text for distinct entities", () => {
    const selected = label(
      "building\0first",
      "index.ts",
      { x: 0, y: 1, z: 0 },
    );
    const sameEntity = label(
      "building\0first",
      "index.ts",
      { x: 0, y: 2, z: 0 },
    );
    const otherEntity = label(
      "building\0second",
      "index.ts",
      { x: 1, y: 2, z: 0 },
    );

    expect(
      sceneLabelAccessibleName({
        selected,
        hovered: sameEntity,
      }),
    ).toBe("Interactive 3D code city. Selected: index.ts");
    expect(
      sceneLabelAccessibleName({
        selected,
        hovered: otherEntity,
      }),
    ).toBe(
      "Interactive 3D code city. Selected: index.ts. Hovered: index.ts",
    );
  });
});

describe("SceneLabelOverlay", () => {
  it("owns exactly two reusable camera-facing, non-raycast scene slots", () => {
    const scene = new THREE.Scene();
    const canvases = new FakeCanvasFactory();
    const overlay = new SceneLabelOverlay(scene, {
      canvasFactory: canvases.create,
    });
    const originalSlots = [...overlay.object.children] as THREE.Sprite[];
    const originalMaterials = originalSlots.map(({ material }) => material);
    const originalTextures = originalMaterials.map(
      (material) => (material as THREE.SpriteMaterial).map,
    );

    overlay.replace({
      selected: label("selected-id", "Selected", { x: 1, y: 8, z: 3 }),
      hovered: label("hovered-id", "Hovered", { x: -2, y: 4, z: 7 }),
    });

    expect(overlay.object.parent).toBe(scene);
    expect(overlay.object.children).toHaveLength(2);
    expect(
      overlay.object.children.every((child) => child instanceof THREE.Sprite),
    ).toBe(true);
    expect(overlay.visibleLabelCount).toBe(2);
    expect(originalSlots[0]?.position).toEqual(new THREE.Vector3(1, 8, 3));
    expect(originalSlots[1]?.position).toEqual(new THREE.Vector3(-2, 4, 7));
    const expectedHeight = 2.4 * SCENE_LABEL_SCREEN_SCALE_PER_UNIT;
    expect(originalSlots[0]?.scale.x).toBeCloseTo(expectedHeight * 3, 12);
    expect(originalSlots[0]?.scale.y).toBeCloseTo(expectedHeight, 12);
    expect(originalSlots[0]?.scale.z).toBe(1);
    expect(
      originalMaterials.every(
        (material) =>
          (material as THREE.SpriteMaterial).depthTest === false &&
          (material as THREE.SpriteMaterial).depthWrite === false &&
          (material as THREE.SpriteMaterial).sizeAttenuation === false,
      ),
    ).toBe(true);

    const raycaster = new THREE.Raycaster(
      new THREE.Vector3(1, 8, 10),
      new THREE.Vector3(0, 0, -1),
    );
    expect(
      raycaster.intersectObjects(overlay.object.children, true),
    ).toEqual([]);

    overlay.setSelected(
      label("replacement", "Replacement", { x: 2, y: 9, z: 4 }),
    );
    expect(overlay.object.children).toEqual(originalSlots);
    expect(originalSlots.map(({ material }) => material)).toEqual(
      originalMaterials,
    );
    expect(
      originalMaterials.map(
        (material) => (material as THREE.SpriteMaterial).map,
      ),
    ).toEqual(originalTextures);
  });

  it("collapses a hovered duplicate and restores it when selection clears", () => {
    const scene = new THREE.Scene();
    const canvases = new FakeCanvasFactory();
    const overlay = new SceneLabelOverlay(scene, {
      canvasFactory: canvases.create,
    });
    const [selected, hovered] = overlay.object.children as THREE.Sprite[];
    const duplicate = label("same", "Same entity", { x: 1, y: 2, z: 3 });

    overlay.setHovered(duplicate);
    expect(selected?.visible).toBe(false);
    expect(hovered?.visible).toBe(true);

    overlay.setSelected(
      label("same", "Selected wins", { x: 1, y: 3, z: 3 }),
    );
    expect(selected?.visible).toBe(true);
    expect(hovered?.visible).toBe(false);
    expect(overlay.visibleLabelCount).toBe(1);

    overlay.setSelected(null);
    expect(selected?.visible).toBe(false);
    expect(hovered?.visible).toBe(true);
    expect(hovered?.userData["sceneLabelText"]).toBe("Same entity");
  });

  it("draws high-contrast literal text through the injected canvases", () => {
    const scene = new THREE.Scene();
    const canvases = new FakeCanvasFactory();
    const overlay = new SceneLabelOverlay(scene, {
      canvasFactory: canvases.create,
    });
    const markup = "<img src=x onerror=alert(1)>";

    overlay.setSelected(
      label("unsafe", markup, { x: 0, y: 1, z: 0 }),
    );

    const context = canvases.contexts[0]!;
    expect(context.filledRectangles).toContainEqual([
      0,
      0,
      SCENE_LABEL_CANVAS_WIDTH,
      SCENE_LABEL_CANVAS_HEIGHT,
    ]);
    expect(context.strokedRectangles).toHaveLength(1);
    expect(context.fillStyle).toBe("#ffffff");
    expect(context.strokeStyle).toBe("#7dd3fc");
    expect(context.drawnText.map(({ text }) => text).join(" ")).toBe(markup);
    expect(context.drawnText.map(({ text }) => text).join(" ")).not.toContain(
      "&lt;",
    );
    const selected = overlay.object.children[0] as THREE.Sprite;
    expect(selected.userData[SCENE_LABEL_FULL_TEXT_USER_DATA_KEY]).toBe(markup);
    expect(overlay.fullText("selected")).toBe(markup);
  });

  it("keeps extreme full text on the pooled slot when the canvas is capped", () => {
    const scene = new THREE.Scene();
    const canvases = new FakeCanvasFactory();
    const overlay = new SceneLabelOverlay(scene, {
      canvasFactory: canvases.create,
    });
    const extreme = "very-long-target/".repeat(300);

    overlay.setHovered(label("extreme", extreme, { x: 0, y: 1, z: 0 }));

    const hovered = overlay.object.children[1] as THREE.Sprite;
    expect(hovered.userData["sceneLabelTextTruncated"]).toBe(true);
    expect(hovered.userData[SCENE_LABEL_FULL_TEXT_USER_DATA_KEY]).toBe(extreme);
    expect(overlay.fullText("hovered")).toBe(extreme);
    expect(overlay.object.children).toHaveLength(2);

    overlay.clear();
    expect(overlay.fullText("hovered")).toBeNull();
    expect(
      SCENE_LABEL_FULL_TEXT_USER_DATA_KEY in hovered.userData,
    ).toBe(false);
  });

  it("clears for reuse and disposes both resource pairs exactly once", () => {
    const scene = new THREE.Scene();
    const canvases = new FakeCanvasFactory();
    const overlay = new SceneLabelOverlay(scene, {
      canvasFactory: canvases.create,
    });
    overlay.replace({
      selected: label("a", "A", { x: 0, y: 1, z: 0 }),
      hovered: label("b", "B", { x: 1, y: 1, z: 0 }),
    });
    const slots = [...overlay.object.children] as THREE.Sprite[];
    const materials = slots.map(
      ({ material }) => material as THREE.SpriteMaterial,
    );
    const textures = materials.map(({ map }) => map!);
    const materialDisposals = materials.map((material) =>
      vi.spyOn(material, "dispose"),
    );
    const textureDisposals = textures.map((texture) =>
      vi.spyOn(texture, "dispose"),
    );

    overlay.clear();
    expect(overlay.object.children).toEqual(slots);
    expect(overlay.visibleLabelCount).toBe(0);
    expect(materialDisposals.every((spy) => spy.mock.calls.length === 0)).toBe(
      true,
    );
    expect(textureDisposals.every((spy) => spy.mock.calls.length === 0)).toBe(
      true,
    );

    overlay.setHovered(label("c", "C", { x: 2, y: 2, z: 2 }));
    expect(overlay.visibleLabelCount).toBe(1);
    overlay.dispose();
    overlay.dispose();
    expect(overlay.object.parent).toBeNull();
    expect(overlay.object.children).toHaveLength(0);
    expect(materialDisposals.every((spy) => spy.mock.calls.length === 1)).toBe(
      true,
    );
    expect(textureDisposals.every((spy) => spy.mock.calls.length === 1)).toBe(
      true,
    );
    expect(() => overlay.setSelected(null)).toThrow(/disposed/u);
  });

  it("rejects invalid labels without replacing the visible state", () => {
    const scene = new THREE.Scene();
    const canvases = new FakeCanvasFactory();
    const overlay = new SceneLabelOverlay(scene, {
      canvasFactory: canvases.create,
    });
    overlay.setSelected(label("valid", "Valid", { x: 0, y: 1, z: 0 }));
    const selected = overlay.object.children[0] as THREE.Sprite;

    expect(() =>
      overlay.setSelected({
        id: "invalid",
        text: "Invalid",
        position: { x: Number.NaN, y: 0, z: 0 },
      }),
    ).toThrow(/position must be finite/u);
    expect(selected.userData["sceneLabelId"]).toBe("valid");
    expect(selected.visible).toBe(true);
  });
});

function label(
  id: string,
  text: string,
  position: SceneLabel["position"],
): SceneLabel {
  return { id, text, position };
}

class FakeCanvasFactory {
  public readonly contexts: FakeDrawingContext[] = [];

  public readonly create: SceneLabelCanvasFactory = (width, height) => {
    const context = new FakeDrawingContext();
    this.contexts.push(context);
    return {
      canvas: { width, height } as HTMLCanvasElement,
      context,
    };
  };
}

class FakeDrawingContext implements SceneLabelDrawingContext {
  public font = "";
  public textAlign: CanvasTextAlign = "start";
  public textBaseline: CanvasTextBaseline = "alphabetic";
  public fillStyle: string | CanvasGradient | CanvasPattern = "";
  public strokeStyle: string | CanvasGradient | CanvasPattern = "";
  public lineWidth = 1;
  public readonly filledRectangles: Array<
    readonly [number, number, number, number]
  > = [];
  public readonly strokedRectangles: Array<
    readonly [number, number, number, number]
  > = [];
  public readonly drawnText: Array<{
    readonly text: string;
    readonly x: number;
    readonly y: number;
  }> = [];

  public clearRect(): void {}

  public fillRect(
    x: number,
    y: number,
    width: number,
    height: number,
  ): void {
    this.filledRectangles.push([x, y, width, height]);
  }

  public strokeRect(
    x: number,
    y: number,
    width: number,
    height: number,
  ): void {
    this.strokedRectangles.push([x, y, width, height]);
  }

  public fillText(text: string, x: number, y: number): void {
    this.drawnText.push({ text, x, y });
  }

  public measureText(text: string): Pick<TextMetrics, "width"> {
    const fontSize = Number.parseFloat(
      /(\d+(?:\.\d+)?)px/u.exec(this.font)?.[1] ?? "16",
    );
    return { width: Array.from(text).length * fontSize * 0.62 };
  }
}
