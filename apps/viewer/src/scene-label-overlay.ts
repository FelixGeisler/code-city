import * as THREE from "three";

export type SceneLabelRole = "selected" | "hovered";

export interface SceneLabelPoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface SceneLabel {
  /** Stable scene-entity identity used to collapse selected/hovered duplicates. */
  readonly id: string;
  /** Rendered literally with Canvas2D fillText; it is never parsed as markup. */
  readonly text: string;
  /** World-space center of the camera-facing label. */
  readonly position: SceneLabelPoint;
  /** Optional world-space label height. */
  readonly worldHeight?: number;
}

export interface SceneLabelOverlayState {
  readonly selected: SceneLabel | null;
  readonly hovered: SceneLabel | null;
}

export interface SceneLabelDrawingContext {
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  clearRect(x: number, y: number, width: number, height: number): void;
  fillRect(x: number, y: number, width: number, height: number): void;
  strokeRect(x: number, y: number, width: number, height: number): void;
  fillText(text: string, x: number, y: number): void;
  measureText(text: string): Pick<TextMetrics, "width">;
}

export interface SceneLabelCanvasSurface {
  readonly canvas: HTMLCanvasElement;
  readonly context: SceneLabelDrawingContext;
}

export type SceneLabelCanvasFactory = (
  width: number,
  height: number,
) => SceneLabelCanvasSurface;

export interface SceneLabelOverlayOptions {
  readonly canvasFactory?: SceneLabelCanvasFactory;
  readonly name?: string;
}

export interface SceneLabelTextLayout {
  /** Exact caller-supplied text, retained even when visual lines are capped. */
  readonly sourceText: string;
  readonly lines: readonly string[];
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly truncated: boolean;
}

export type SceneLabelTextMeasure = (
  text: string,
  fontSize: number,
) => number;

export const SCENE_LABEL_CANVAS_WIDTH = 768;
export const SCENE_LABEL_CANVAS_HEIGHT = 256;
export const SCENE_LABEL_MAX_LINES = 8;
/**
 * Non-attenuated Sprite scale per caller emphasis unit. At the viewer's
 * 45-degree camera this keeps a normal one-line label near tooltip size.
 */
export const SCENE_LABEL_SCREEN_SCALE_PER_UNIT = 0.045;
export const SCENE_LABEL_FULL_TEXT_USER_DATA_KEY =
  "sceneLabelFullText" as const;
export const DEFAULT_SCENE_ACCESSIBLE_NAME =
  "Interactive 3D code city";

const HORIZONTAL_PADDING = 34;
const VERTICAL_PADDING = 24;
const MAXIMUM_FONT_SIZE = 52;
const MINIMUM_FONT_SIZE = 18;
const FONT_SIZE_STEP = 2;
const LINE_HEIGHT_RATIO = 1.18;
const DEFAULT_WORLD_HEIGHT = 2.4;
const MAXIMUM_TEXT_SCALE = 2.4;
const LABEL_ASPECT =
  SCENE_LABEL_CANVAS_WIDTH / SCENE_LABEL_CANVAS_HEIGHT;
const FONT_FAMILY =
  '"SFMono-Regular", Consolas, "Liberation Mono", monospace';
const ELLIPSIS = "\u2026";

interface LabelSlot {
  readonly role: SceneLabelRole;
  readonly sprite: THREE.Sprite;
  readonly material: THREE.SpriteMaterial;
  readonly texture: THREE.CanvasTexture;
  readonly context: SceneLabelDrawingContext;
}

export function sceneLabelAccessibleName(
  state: SceneLabelOverlayState,
): string {
  const descriptions = [
    state.selected === null
      ? null
      : `Selected: ${state.selected.text}`,
    state.hovered === null ||
    state.hovered.id === state.selected?.id
      ? null
      : `Hovered: ${state.hovered.text}`,
  ].filter((value): value is string => value !== null);
  return descriptions.length === 0
    ? DEFAULT_SCENE_ACCESSIBLE_NAME
    : `${DEFAULT_SCENE_ACCESSIBLE_NAME}. ${descriptions.join(". ")}`;
}

/**
 * Owns two reusable, scene-level camera-facing labels. The object is attached
 * directly to the supplied scene so labels neither affect city bounds nor
 * inherit district visibility.
 */
export class SceneLabelOverlay {
  public readonly object = new THREE.Group();
  private readonly slots: Readonly<Record<SceneLabelRole, LabelSlot>>;
  private selected: SceneLabel | null = null;
  private hovered: SceneLabel | null = null;
  private disposed = false;

  public constructor(
    private readonly scene: THREE.Scene,
    options: SceneLabelOverlayOptions = {},
  ) {
    const name = options.name ?? "code-city:scene-labels";
    if (name.trim() === "") {
      throw new TypeError("Scene label overlay name must not be empty.");
    }
    const canvasFactory = options.canvasFactory ?? browserCanvasFactory;
    this.object.name = name;
    this.object.renderOrder = 1_000;
    disableRaycasting(this.object);
    this.slots = {
      selected: createLabelSlot("selected", canvasFactory),
      hovered: createLabelSlot("hovered", canvasFactory),
    };
    this.object.add(
      this.slots.selected.sprite,
      this.slots.hovered.sprite,
    );
    this.scene.add(this.object);
  }

  public get visibleLabelCount(): number {
    return Number(this.slots.selected.sprite.visible) +
      Number(this.slots.hovered.sprite.visible);
  }

  /**
   * Complete literal text for a DOM/ARIA fallback. WebGL canvas content is not
   * itself represented in the browser accessibility tree.
   */
  public fullText(role: SceneLabelRole): string | null {
    return role === "selected"
      ? this.selected?.text ?? null
      : this.hovered?.text ?? null;
  }

  public snapshot(): SceneLabelOverlayState {
    return {
      selected:
        this.selected === null ? null : snapshotLabel(this.selected),
      hovered:
        this.hovered === null ? null : snapshotLabel(this.hovered),
    };
  }

  public replace(state: SceneLabelOverlayState): void {
    this.assertActive();
    this.selected =
      state.selected === null ? null : snapshotLabel(state.selected);
    this.hovered =
      state.hovered === null ? null : snapshotLabel(state.hovered);
    this.refresh();
  }

  public setSelected(label: SceneLabel | null): void {
    this.assertActive();
    this.selected = label === null ? null : snapshotLabel(label);
    this.refresh();
  }

  public setHovered(label: SceneLabel | null): void {
    this.assertActive();
    this.hovered = label === null ? null : snapshotLabel(label);
    this.refresh();
  }

  /**
   * Hides both labels while retaining the two canvases, textures, materials,
   * and sprites for subsequent reuse.
   */
  public clear(): void {
    if (this.disposed) {
      return;
    }
    this.selected = null;
    this.hovered = null;
    hideSlot(this.slots.selected);
    hideSlot(this.slots.hovered);
  }

  /** Detaches the overlay and releases both texture/material pairs once. */
  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.clear();
    this.scene.remove(this.object);
    for (const slot of Object.values(this.slots)) {
      slot.texture.dispose();
      slot.material.dispose();
      this.object.remove(slot.sprite);
    }
    this.disposed = true;
  }

  private refresh(): void {
    updateSlot(this.slots.selected, this.selected);
    updateSlot(
      this.slots.hovered,
      this.hovered !== null &&
        this.hovered.id !== this.selected?.id
        ? this.hovered
        : null,
    );
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new Error("Scene label overlay has been disposed.");
    }
  }
}

/**
 * Finds a bounded, deterministic text layout. Long words are split at Unicode
 * code-point boundaries; extreme input is safely capped with an ellipsis.
 */
export function layoutSceneLabelText(
  text: string,
  measureText: SceneLabelTextMeasure = approximateTextWidth,
): SceneLabelTextLayout {
  if (typeof text !== "string" || text.trim() === "") {
    throw new TypeError("Scene label text must not be empty.");
  }
  const maximumWidth =
    SCENE_LABEL_CANVAS_WIDTH - HORIZONTAL_PADDING * 2;

  for (
    let fontSize = MAXIMUM_FONT_SIZE;
    fontSize >= MINIMUM_FONT_SIZE;
    fontSize -= FONT_SIZE_STEP
  ) {
    const lines = wrapText(text, fontSize, maximumWidth, measureText);
    if (
      lines.length <= SCENE_LABEL_MAX_LINES &&
      linesFitVertically(lines.length, fontSize)
    ) {
      return {
        sourceText: text,
        lines,
        fontSize,
        lineHeight: fontSize * LINE_HEIGHT_RATIO,
        truncated: false,
      };
    }
  }

  const fontSize = MINIMUM_FONT_SIZE;
  const wrapped = wrapText(
    text,
    fontSize,
    maximumWidth,
    measureText,
  );
  const lines = wrapped.slice(0, SCENE_LABEL_MAX_LINES);
  const lastIndex = lines.length - 1;
  if (lastIndex >= 0) {
    lines[lastIndex] = fitWithEllipsis(
      lines[lastIndex]!,
      fontSize,
      maximumWidth,
      measureText,
    );
  }
  return {
    sourceText: text,
    lines,
    fontSize,
    lineHeight: fontSize * LINE_HEIGHT_RATIO,
    truncated: wrapped.length > SCENE_LABEL_MAX_LINES,
  };
}

function createLabelSlot(
  role: SceneLabelRole,
  canvasFactory: SceneLabelCanvasFactory,
): LabelSlot {
  const surface = canvasFactory(
    SCENE_LABEL_CANVAS_WIDTH,
    SCENE_LABEL_CANVAS_HEIGHT,
  );
  if (
    surface.canvas.width !== SCENE_LABEL_CANVAS_WIDTH ||
    surface.canvas.height !== SCENE_LABEL_CANVAS_HEIGHT
  ) {
    surface.canvas.width = SCENE_LABEL_CANVAS_WIDTH;
    surface.canvas.height = SCENE_LABEL_CANVAS_HEIGHT;
  }
  const texture = new THREE.CanvasTexture(surface.canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    sizeAttenuation: false,
    toneMapped: false,
  });
  const sprite = new THREE.Sprite(material);
  sprite.name = `code-city:scene-label:${role}`;
  sprite.renderOrder = role === "selected" ? 1_002 : 1_001;
  sprite.visible = false;
  sprite.userData["sceneLabelRole"] = role;
  disableRaycasting(sprite);
  return { role, sprite, material, texture, context: surface.context };
}

function updateSlot(slot: LabelSlot, label: SceneLabel | null): void {
  if (label === null) {
    hideSlot(slot);
    return;
  }
  const layout = drawLabel(slot, label.text);
  slot.sprite.position.set(
    label.position.x,
    label.position.y,
    label.position.z,
  );
  const worldHeight = label.worldHeight ?? DEFAULT_WORLD_HEIGHT;
  const textScale = Math.min(
    MAXIMUM_TEXT_SCALE,
    MAXIMUM_FONT_SIZE / layout.fontSize,
  );
  const screenHeight =
    worldHeight * SCENE_LABEL_SCREEN_SCALE_PER_UNIT * textScale;
  slot.sprite.scale.set(
    screenHeight * LABEL_ASPECT,
    screenHeight,
    1,
  );
  slot.sprite.userData["sceneLabelId"] = label.id;
  slot.sprite.userData["sceneLabelText"] = label.text;
  slot.sprite.userData[SCENE_LABEL_FULL_TEXT_USER_DATA_KEY] = label.text;
  slot.sprite.userData["sceneLabelTextTruncated"] = layout.truncated;
  slot.sprite.visible = true;
}

function hideSlot(slot: LabelSlot): void {
  slot.sprite.visible = false;
  delete slot.sprite.userData["sceneLabelId"];
  delete slot.sprite.userData["sceneLabelText"];
  delete slot.sprite.userData[SCENE_LABEL_FULL_TEXT_USER_DATA_KEY];
  delete slot.sprite.userData["sceneLabelTextTruncated"];
}

function drawLabel(
  slot: LabelSlot,
  text: string,
): SceneLabelTextLayout {
  const { context } = slot;
  const layout = layoutSceneLabelText(text, (value, fontSize) => {
    context.font = font(fontSize);
    return context.measureText(value).width;
  });
  context.clearRect(
    0,
    0,
    SCENE_LABEL_CANVAS_WIDTH,
    SCENE_LABEL_CANVAS_HEIGHT,
  );
  context.fillStyle = "rgba(3, 7, 18, 0.96)";
  context.fillRect(
    0,
    0,
    SCENE_LABEL_CANVAS_WIDTH,
    SCENE_LABEL_CANVAS_HEIGHT,
  );
  context.strokeStyle =
    slot.role === "selected" ? "#7dd3fc" : "#f8fafc";
  context.lineWidth = slot.role === "selected" ? 8 : 5;
  context.strokeRect(
    context.lineWidth / 2,
    context.lineWidth / 2,
    SCENE_LABEL_CANVAS_WIDTH - context.lineWidth,
    SCENE_LABEL_CANVAS_HEIGHT - context.lineWidth,
  );
  context.font = font(layout.fontSize);
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillStyle = "#ffffff";
  const blockHeight = layout.lines.length * layout.lineHeight;
  const firstLineY =
    SCENE_LABEL_CANVAS_HEIGHT / 2 -
    blockHeight / 2 +
    layout.lineHeight / 2;
  layout.lines.forEach((line, index) => {
    context.fillText(
      line,
      SCENE_LABEL_CANVAS_WIDTH / 2,
      firstLineY + index * layout.lineHeight,
    );
  });
  slot.texture.needsUpdate = true;
  return layout;
}

function snapshotLabel(label: SceneLabel): SceneLabel {
  if (typeof label.id !== "string" || label.id.trim() === "") {
    throw new TypeError("Scene label id must not be empty.");
  }
  layoutSceneLabelText(label.text);
  validatePoint(label.position);
  if (
    label.worldHeight !== undefined &&
    (!Number.isFinite(label.worldHeight) || label.worldHeight <= 0)
  ) {
    throw new RangeError(
      "Scene label worldHeight must be positive and finite.",
    );
  }
  return label.worldHeight === undefined
    ? {
        id: label.id,
        text: label.text,
        position: { ...label.position },
      }
    : {
        id: label.id,
        text: label.text,
        position: { ...label.position },
        worldHeight: label.worldHeight,
      };
}

function validatePoint(point: SceneLabelPoint): void {
  if (
    !Number.isFinite(point.x) ||
    !Number.isFinite(point.y) ||
    !Number.isFinite(point.z)
  ) {
    throw new RangeError("Scene label position must be finite.");
  }
}

function wrapText(
  text: string,
  fontSize: number,
  maximumWidth: number,
  measureText: SceneLabelTextMeasure,
): string[] {
  const paragraphs = text.split(/\r\n?|\n/u);
  const lines: string[] = [];
  for (const paragraph of paragraphs) {
    if (paragraph === "") {
      lines.push("");
      continue;
    }
    const words = paragraph.trim().split(/\s+/u);
    let current = "";
    for (const word of words) {
      const candidate = current === "" ? word : `${current} ${word}`;
      if (measureText(candidate, fontSize) <= maximumWidth) {
        current = candidate;
        continue;
      }
      if (current !== "") {
        lines.push(current);
        current = "";
      }
      const fragments = splitLongWord(
        word,
        fontSize,
        maximumWidth,
        measureText,
      );
      lines.push(...fragments.slice(0, -1));
      current = fragments.at(-1) ?? "";
    }
    lines.push(current);
  }
  return lines;
}

function splitLongWord(
  word: string,
  fontSize: number,
  maximumWidth: number,
  measureText: SceneLabelTextMeasure,
): string[] {
  if (measureText(word, fontSize) <= maximumWidth) {
    return [word];
  }
  const fragments: string[] = [];
  let current = "";
  for (const codePoint of Array.from(word)) {
    const candidate = current + codePoint;
    if (
      current !== "" &&
      measureText(candidate, fontSize) > maximumWidth
    ) {
      fragments.push(current);
      current = codePoint;
    } else {
      current = candidate;
    }
  }
  if (current !== "") {
    fragments.push(current);
  }
  return fragments.length === 0 ? [""] : fragments;
}

function fitWithEllipsis(
  line: string,
  fontSize: number,
  maximumWidth: number,
  measureText: SceneLabelTextMeasure,
): string {
  const codePoints = Array.from(line);
  while (
    codePoints.length > 0 &&
    measureText(codePoints.join("") + ELLIPSIS, fontSize) > maximumWidth
  ) {
    codePoints.pop();
  }
  return codePoints.join("") + ELLIPSIS;
}

function linesFitVertically(lineCount: number, fontSize: number): boolean {
  return (
    lineCount * fontSize * LINE_HEIGHT_RATIO <=
    SCENE_LABEL_CANVAS_HEIGHT - VERTICAL_PADDING * 2
  );
}

function approximateTextWidth(text: string, fontSize: number): number {
  return Array.from(text).length * fontSize * 0.62;
}

function font(fontSize: number): string {
  return `700 ${fontSize}px ${FONT_FAMILY}`;
}

function browserCanvasFactory(
  width: number,
  height: number,
): SceneLabelCanvasSurface {
  if (typeof document === "undefined") {
    throw new Error(
      "Scene labels require a canvasFactory outside a browser.",
    );
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Scene label Canvas2D context is unavailable.");
  }
  return { canvas, context };
}

function disableRaycasting(object: THREE.Object3D): void {
  object.raycast = () => {};
}
