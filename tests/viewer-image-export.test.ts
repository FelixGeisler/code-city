import { describe, expect, it } from "vitest";

import {
  IMAGE_EXPORT_LIMITS,
  flipRgbaRows,
  formatBytes,
  imageExportFileName,
  imageExportLegendLayout,
  imageExportWorkingBytesPerPixel,
  validateImageExportLegend,
  validateImageExportResolution,
} from "../apps/viewer/src/image-export.js";
import { ImageExportAttemptGate } from "../apps/viewer/src/image-export-dialog.js";

const capable = {
  contextAvailable: true,
  maxRenderbufferSize: 16_384,
  maxTextureSize: 16_384,
  maxViewportWidth: 16_384,
  maxViewportHeight: 16_384,
  samples: 4,
};

describe("image export limits", () => {
  it("accepts viewport-independent 4K output with an explicit memory estimate", () => {
    const result = validateImageExportResolution(3_840, 2_160, capable);

    expect(result.pixels).toBe(8_294_400);
    expect(result.estimatedWorkingBytes).toBe(
      result.pixels * imageExportWorkingBytesPerPixel(capable.samples),
    );
    expect(result.maximumDimension).toBe(
      IMAGE_EXPORT_LIMITS.maximumDimension,
    );
  });

  it("enforces application memory and device render limits before allocation", () => {
    expect(() =>
      validateImageExportResolution(8_192, 8_192, capable),
    ).toThrow(/working memory/u);
    expect(() =>
      validateImageExportResolution(4_096, 2_160, {
        ...capable,
        maxRenderbufferSize: 2_048,
      }),
    ).toThrow(/2,048\u00d72,048 pixels/u);
    expect(() =>
      validateImageExportResolution(4_096, 2_160, {
        ...capable,
        maxViewportWidth: 2_048,
      }),
    ).toThrow(/2,048\u00d78,192 pixels/u);
    expect(() =>
      validateImageExportResolution(1_920, 1_080, {
        ...capable,
        contextAvailable: false,
      }),
    ).toThrow(/context is lost/u);
    expect(() =>
      validateImageExportResolution(255, 1_080, capable),
    ).toThrow(/at least 256/u);
  });

  it("bounds complete readable legends", () => {
    const entries = Array.from(
      { length: IMAGE_EXPORT_LIMITS.maximumLegendEntries },
      (_, index) => ({
        label: `Group ${index}`,
        color: "#36a3ff",
      }),
    );
    expect(() =>
      validateImageExportLegend(entries, 3_840, 2_160),
    ).not.toThrow();
    expect(() =>
      validateImageExportLegend([
        ...entries,
        { label: "Overflow", color: "#ffffff" },
      ]),
    ).toThrow(/at most 264/u);

    const layout = imageExportLegendLayout(3_840, 2_160, entries.length);
    expect(layout.fontSize).toBeGreaterThanOrEqual(14);
    expect(layout.columns).toBeGreaterThan(1);
    expect(layout.columnWidth).toBeGreaterThanOrEqual(
      layout.fontSize * 10,
    );
    expect(layout.panelWidth).toBeLessThan(3_840);
    expect(layout.panelHeight).toBeLessThan(2_160);
    expect(() =>
      validateImageExportLegend(entries, 1_920, 1_080),
    ).toThrow(/too small/u);
    expect(() =>
      validateImageExportLegend([
        { label: "Alpha", color: "#36a3ff80" },
      ]),
    ).not.toThrow();
  });

  it("accounts for framebuffer samples in the explicit memory bound", () => {
    expect(imageExportWorkingBytesPerPixel(0)).toBe(24);
    expect(imageExportWorkingBytesPerPixel(4)).toBe(48);
    expect(() => imageExportWorkingBytesPerPixel(65)).toThrow(
      /sample count/u,
    );
  });
});

describe("image export pixels", () => {
  it("flips WebGL bottom-up RGBA rows in place", () => {
    const pixels = new Uint8Array([
      1, 2, 3, 4, 5, 6, 7, 8,
      9, 10, 11, 12, 13, 14, 15, 16,
    ]);

    flipRgbaRows(pixels, 2, 2);

    expect([...pixels]).toEqual([
      9, 10, 11, 12, 13, 14, 15, 16,
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    expect(() => flipRgbaRows(new Uint8Array(3), 1, 1)).toThrow(
      /buffer length/u,
    );
  });

  it("builds deterministic private download names", () => {
    expect(
      imageExportFileName(
        "M\u00fcnchen API / Core",
        { width: 3_840, height: 2_160, preset: "top-down" },
        "ABCDEF0123456789",
      ),
    ).toBe("munchen-api-core-abcdef0123-top-down-3840x2160.png");
    expect(formatBytes(512 * 1024 * 1024)).toBe("512.0 MiB");
  });
});

describe("image export attempt lifecycle", () => {
  it("invalidates stale asynchronous results without leaving the UI busy", () => {
    const gate = new ImageExportAttemptGate();
    const first = gate.begin();
    expect(gate.busy).toBe(true);

    gate.invalidate();
    expect(gate.busy).toBe(false);
    expect(gate.isCurrent(first)).toBe(false);
    expect(gate.settle(first)).toBe(false);

    const second = gate.begin();
    expect(gate.settle(second)).toBe(true);
    expect(gate.busy).toBe(false);
  });
});
