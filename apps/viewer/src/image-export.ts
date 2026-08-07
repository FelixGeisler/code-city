import type { CameraProjection } from "./camera-presets.js";

export type ImageExportBackground = "scene" | "transparent";
export type ImageExportAngle =
  | "current-view"
  | "isometric"
  | "top-down";
export type ImageExportFitTarget =
  | "selected-entity"
  | "whole-city";
export type ImageExportLens = "current-view" | CameraProjection;
export type ImageExportCamera =
  | { readonly mode: "current-view" }
  | {
      readonly mode: "custom";
      readonly angle: ImageExportAngle;
      readonly fit: ImageExportFitTarget;
      readonly lens: ImageExportLens;
    };

export interface ImageExportRequest {
  readonly width: number;
  readonly height: number;
  readonly camera: ImageExportCamera;
  readonly background: ImageExportBackground;
  readonly includeLabels: boolean;
  readonly includeLegend: boolean;
  readonly includeEvolutionFrame: boolean;
}

export interface ImageExportCapabilities {
  readonly maxRenderbufferSize: number;
  readonly maxTextureSize: number;
  readonly maxViewportWidth: number;
  readonly maxViewportHeight: number;
  readonly samples: number;
  readonly contextAvailable: boolean;
}

export interface ValidatedImageExportResolution {
  readonly width: number;
  readonly height: number;
  readonly pixels: number;
  readonly estimatedWorkingBytes: number;
  readonly estimatedWorkingBytesPerPixel: number;
  readonly maximumDimension: number;
  readonly maximumWidth: number;
  readonly maximumHeight: number;
}

export interface ImageExportLegendEntry {
  readonly label: string;
  readonly color: string;
}

export interface ImageExportProjectedLabel {
  readonly text: string;
  readonly x: number;
  readonly y: number;
}

export interface ImageExportOverlay {
  readonly title: string;
  readonly subtitle?: string;
  readonly labels: readonly ImageExportProjectedLabel[];
  readonly legendTitle?: string;
  readonly legend: readonly ImageExportLegendEntry[];
}

export interface ImageExportLegendLayout {
  readonly fontSize: number;
  readonly rowHeight: number;
  readonly rowsPerColumn: number;
  readonly columns: number;
  readonly margin: number;
  readonly panelWidth: number;
  readonly panelHeight: number;
  readonly columnWidth: number;
}

export const IMAGE_EXPORT_LIMITS = Object.freeze({
  minimumDimension: 256,
  maximumDimension: 8_192,
  // 256 model groups plus bounded viewer-owned evolution/external entries.
  maximumLegendEntries: 264,
  baseWorkingBytesPerPixel: 16,
  multisampleWorkingBytesPerPixel: 8,
  maximumWorkingBytes: 512 * 1024 * 1024,
});

const FONT_FAMILY =
  'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';

export function validateImageExportResolution(
  width: number,
  height: number,
  capabilities: ImageExportCapabilities,
): ValidatedImageExportResolution {
  if (!capabilities.contextAvailable) {
    throw new Error(
      "Image export is unavailable because the WebGL context is lost.",
    );
  }
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < IMAGE_EXPORT_LIMITS.minimumDimension ||
    height < IMAGE_EXPORT_LIMITS.minimumDimension
  ) {
    throw new RangeError(
      `Image width and height must be whole numbers of at least ${IMAGE_EXPORT_LIMITS.minimumDimension}.`,
    );
  }
  const maximumWidth = Math.min(
    IMAGE_EXPORT_LIMITS.maximumDimension,
    positiveCapability(
      capabilities.maxRenderbufferSize,
      "WebGL renderbuffer size",
    ),
    positiveCapability(
      capabilities.maxTextureSize,
      "WebGL texture size",
    ),
    positiveCapability(
      capabilities.maxViewportWidth,
      "WebGL viewport width",
    ),
  );
  const maximumHeight = Math.min(
    IMAGE_EXPORT_LIMITS.maximumDimension,
    capabilities.maxRenderbufferSize,
    capabilities.maxTextureSize,
    positiveCapability(
      capabilities.maxViewportHeight,
      "WebGL viewport height",
    ),
  );
  if (width > maximumWidth || height > maximumHeight) {
    throw new RangeError(
      `This device supports image dimensions up to ${maximumWidth.toLocaleString("en-US")}\u00d7${maximumHeight.toLocaleString("en-US")} pixels.`,
    );
  }
  const pixels = width * height;
  const estimatedWorkingBytesPerPixel =
    imageExportWorkingBytesPerPixel(capabilities.samples);
  const maximumPixels = Math.floor(
    IMAGE_EXPORT_LIMITS.maximumWorkingBytes /
      estimatedWorkingBytesPerPixel,
  );
  if (!Number.isSafeInteger(pixels) || pixels > maximumPixels) {
    throw new RangeError(
      `Image export is limited to ${maximumPixels.toLocaleString()} pixels on this device (${formatBytes(IMAGE_EXPORT_LIMITS.maximumWorkingBytes)} estimated working memory with ${Math.max(1, capabilities.samples)} framebuffer sample${Math.max(1, capabilities.samples) === 1 ? "" : "s"}).`,
    );
  }
  return {
    width,
    height,
    pixels,
    estimatedWorkingBytes: pixels * estimatedWorkingBytesPerPixel,
    estimatedWorkingBytesPerPixel,
    maximumDimension: Math.min(maximumWidth, maximumHeight),
    maximumWidth,
    maximumHeight,
  };
}

export function validateImageExportLegend(
  entries: readonly ImageExportLegendEntry[],
  width?: number,
  height?: number,
): void {
  if (entries.length > IMAGE_EXPORT_LIMITS.maximumLegendEntries) {
    throw new RangeError(
      `Image legends support at most ${IMAGE_EXPORT_LIMITS.maximumLegendEntries} entries; disable the legend or reduce the active groups.`,
    );
  }
  for (const entry of entries) {
    if (entry.label.trim() === "" || entry.label.length > 512) {
      throw new RangeError(
        "Image legend labels must contain 1 to 512 characters.",
      );
    }
    if (!/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/iu.test(entry.color)) {
      throw new RangeError(
        `Image legend color "${entry.color}" must be a six- or eight-digit hex color.`,
      );
    }
  }
  if (entries.length > 0 && width !== undefined && height !== undefined) {
    imageExportLegendLayout(width, height, entries.length);
  }
}

export function imageExportLegendLayout(
  width: number,
  height: number,
  entryCount: number,
): ImageExportLegendLayout {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    !Number.isSafeInteger(entryCount) ||
    entryCount < 0 ||
    entryCount > IMAGE_EXPORT_LIMITS.maximumLegendEntries
  ) {
    throw new RangeError("Image legend layout inputs are out of range.");
  }
  const shortSide = Math.min(width, height);
  const fontSize = clamp(Math.round(shortSide / 55), 14, 32);
  const rowHeight = Math.ceil(fontSize * 1.55);
  const margin = Math.ceil(fontSize * 0.85);
  const headerHeight = Math.ceil(fontSize * 2.35);
  const availableRows = Math.max(
    1,
    Math.floor((height * 0.72 - headerHeight - margin * 2) / rowHeight),
  );
  const rowsPerColumn = Math.max(
    1,
    Math.min(availableRows, Math.max(1, entryCount)),
  );
  const columns = Math.max(1, Math.ceil(entryCount / rowsPerColumn));
  const maximumPanelWidth = Math.max(1, width - margin * 2);
  const minimumColumnWidth = fontSize * 10;
  const minimumPanelWidth =
    Math.ceil(columns * minimumColumnWidth + margin * 2);
  if (minimumPanelWidth > maximumPanelWidth) {
    throw new RangeError(
      `The ${width.toLocaleString()}\u00d7${height.toLocaleString()} image is too small for ${entryCount.toLocaleString()} readable legend entries; increase the resolution or disable the legend.`,
    );
  }
  const panelWidth = Math.min(
    maximumPanelWidth,
    Math.max(
      minimumPanelWidth,
      Math.ceil(
        columns * Math.min(width * 0.3, fontSize * 24) +
          margin * 2,
      ),
    ),
  );
  const panelHeight = Math.min(
    height - margin * 2,
    headerHeight +
      Math.min(rowsPerColumn, Math.max(1, entryCount)) * rowHeight +
      margin * 2,
  );
  return {
    fontSize,
    rowHeight,
    rowsPerColumn,
    columns,
    margin,
    panelWidth,
    panelHeight,
    columnWidth: (panelWidth - margin * 2) / columns,
  };
}

export function imageExportWorkingBytesPerPixel(samples: number): number {
  if (!Number.isSafeInteger(samples) || samples < 0 || samples > 64) {
    throw new RangeError(
      "WebGL framebuffer sample count must be a whole number from 0 to 64.",
    );
  }
  return (
    IMAGE_EXPORT_LIMITS.baseWorkingBytesPerPixel +
    IMAGE_EXPORT_LIMITS.multisampleWorkingBytesPerPixel *
      Math.max(1, samples)
  );
}

export function flipRgbaRows(
  pixels: Uint8Array,
  width: number,
  height: number,
): void {
  const rowBytes = width * 4;
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    pixels.byteLength !== rowBytes * height
  ) {
    throw new RangeError(
      "RGBA buffer length must match the requested image dimensions.",
    );
  }
  const temporary = new Uint8Array(rowBytes);
  for (let top = 0; top < Math.floor(height / 2); top += 1) {
    const bottom = height - top - 1;
    const topOffset = top * rowBytes;
    const bottomOffset = bottom * rowBytes;
    temporary.set(pixels.subarray(topOffset, topOffset + rowBytes));
    pixels.copyWithin(topOffset, bottomOffset, bottomOffset + rowBytes);
    pixels.set(temporary, bottomOffset);
  }
}

export function drawImageExportOverlay(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  overlay: ImageExportOverlay,
): void {
  if (overlay.title.trim() === "") {
    throw new RangeError("Image export title must not be empty.");
  }
  validateImageExportLegend(overlay.legend, width, height);
  if (overlay.subtitle !== undefined) {
    drawCaption(context, width, height, overlay.title, overlay.subtitle);
  }
  drawProjectedLabels(context, width, height, overlay.labels);
  if (overlay.legend.length > 0) {
    drawLegend(
      context,
      width,
      height,
      overlay.legendTitle ?? "Legend",
      overlay.legend,
    );
  }
}

export function imageExportFileName(
  title: string,
  request: Pick<ImageExportRequest, "camera" | "height" | "width">,
  frameSha?: string,
): string {
  const slug =
    title
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 64) || "code-city";
  const frame =
    frameSha === undefined
      ? ""
      : `-${frameSha.toLowerCase().replace(/[^0-9a-f]/gu, "").slice(0, 10)}`;
  const camera =
    request.camera.mode === "current-view"
      ? "current-view"
      : `${request.camera.lens}-${request.camera.angle}-${request.camera.fit}`;
  return `${slug}${frame}-${camera}-${request.width}x${request.height}.png`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    throw new RangeError("Byte count must be finite and non-negative.");
  }
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function drawCaption(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  title: string,
  subtitle: string | undefined,
): void {
  const fontSize = clamp(Math.round(Math.min(width, height) / 44), 16, 42);
  const padding = Math.ceil(fontSize * 0.72);
  const subtitleSize = Math.max(13, Math.round(fontSize * 0.58));
  context.save();
  context.font = `700 ${fontSize}px ${FONT_FAMILY}`;
  const titleWidth = context.measureText(title).width;
  context.font = `600 ${subtitleSize}px ${FONT_FAMILY}`;
  const subtitleWidth =
    subtitle === undefined ? 0 : context.measureText(subtitle).width;
  const panelWidth = Math.min(
    width - padding * 2,
    Math.ceil(Math.max(titleWidth, subtitleWidth) + padding * 2),
  );
  const panelHeight =
    padding * 2 + fontSize + (subtitle === undefined ? 0 : subtitleSize * 1.5);
  roundedPanel(context, padding, padding, panelWidth, panelHeight, fontSize / 2);
  context.fillStyle = "#f5fbff";
  context.textBaseline = "top";
  context.font = `700 ${fontSize}px ${FONT_FAMILY}`;
  context.fillText(
    fitText(context, title, panelWidth - padding * 2),
    padding * 2,
    padding * 2,
  );
  if (subtitle !== undefined) {
    context.fillStyle = "#bdd5e9";
    context.font = `600 ${subtitleSize}px ${FONT_FAMILY}`;
    context.fillText(
      fitText(context, subtitle, panelWidth - padding * 2),
      padding * 2,
      padding * 2 + fontSize * 1.25,
    );
  }
  context.restore();
}

function drawProjectedLabels(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  labels: readonly ImageExportProjectedLabel[],
): void {
  const fontSize = clamp(Math.round(Math.min(width, height) / 52), 14, 36);
  const padding = Math.ceil(fontSize * 0.55);
  const maximumWidth = Math.max(120, width * 0.42);
  context.save();
  context.font = `700 ${fontSize}px ${FONT_FAMILY}`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  for (const label of labels.slice(0, 2)) {
    if (
      label.text.trim() === "" ||
      !Number.isFinite(label.x) ||
      !Number.isFinite(label.y) ||
      label.x < 0 ||
      label.x > width ||
      label.y < 0 ||
      label.y > height
    ) {
      continue;
    }
    const text = fitText(context, label.text, maximumWidth - padding * 2);
    const boxWidth = Math.min(
      maximumWidth,
      context.measureText(text).width + padding * 2,
    );
    const boxHeight = fontSize + padding * 1.5;
    const left = clamp(
      label.x - boxWidth / 2,
      padding,
      width - boxWidth - padding,
    );
    const top = clamp(
      label.y - boxHeight - padding,
      padding,
      height - boxHeight - padding,
    );
    roundedPanel(context, left, top, boxWidth, boxHeight, fontSize / 3);
    context.fillStyle = "#ffffff";
    context.fillText(text, left + boxWidth / 2, top + boxHeight / 2);
  }
  context.restore();
}

function drawLegend(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  title: string,
  entries: readonly ImageExportLegendEntry[],
): void {
  const layout = imageExportLegendLayout(width, height, entries.length);
  const left = width - layout.panelWidth - layout.margin;
  const top = height - layout.panelHeight - layout.margin;
  const innerLeft = left + layout.margin;
  const innerTop = top + layout.margin;
  const headerHeight = Math.ceil(layout.fontSize * 2.35);
  const columnWidth = layout.columnWidth;
  context.save();
  roundedPanel(
    context,
    left,
    top,
    layout.panelWidth,
    layout.panelHeight,
    layout.fontSize / 2,
  );
  context.textAlign = "left";
  context.textBaseline = "middle";
  context.fillStyle = "#f5fbff";
  context.font = `800 ${Math.ceil(layout.fontSize * 1.08)}px ${FONT_FAMILY}`;
  context.fillText(
    fitText(context, title, layout.panelWidth - layout.margin * 2),
    innerLeft,
    innerTop + layout.fontSize * 0.7,
  );
  context.font = `600 ${layout.fontSize}px ${FONT_FAMILY}`;
  entries.forEach((entry, index) => {
    const column = Math.floor(index / layout.rowsPerColumn);
    const row = index % layout.rowsPerColumn;
    const x = innerLeft + column * columnWidth;
    const y =
      innerTop + headerHeight + row * layout.rowHeight + layout.rowHeight / 2;
    const swatch = Math.max(10, Math.round(layout.fontSize * 0.8));
    context.fillStyle = entry.color;
    context.fillRect(x, y - swatch / 2, swatch, swatch);
    context.strokeStyle = "rgba(255, 255, 255, 0.5)";
    context.lineWidth = Math.max(1, Math.round(layout.fontSize / 14));
    context.strokeRect(x, y - swatch / 2, swatch, swatch);
    context.fillStyle = "#e7f2ff";
    context.fillText(
      fitText(
        context,
        entry.label,
        Math.max(1, columnWidth - swatch - layout.fontSize),
      ),
      x + swatch + layout.fontSize * 0.55,
      y,
    );
  });
  context.restore();
}

function roundedPanel(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
  context.fillStyle = "rgba(3, 12, 24, 0.88)";
  context.fill();
  context.strokeStyle = "rgba(121, 196, 255, 0.52)";
  context.lineWidth = Math.max(1, radius / 6);
  context.stroke();
}

function fitText(
  context: CanvasRenderingContext2D,
  text: string,
  maximumWidth: number,
): string {
  if (context.measureText(text).width <= maximumWidth) return text;
  const characters = Array.from(text);
  let lower = 0;
  let upper = characters.length;
  while (lower < upper) {
    const middle = Math.ceil((lower + upper) / 2);
    const candidate = `${characters.slice(0, middle).join("")}\u2026`;
    if (context.measureText(candidate).width <= maximumWidth) {
      lower = middle;
    } else {
      upper = middle - 1;
    }
  }
  return `${characters.slice(0, lower).join("")}\u2026`;
}

function positiveCapability(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} is unavailable.`);
  }
  return value;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
