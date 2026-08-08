import { describe, expect, it } from "vitest";

import { supportsViewerInstancing } from "../apps/viewer/src/viewer-render-capability.js";

describe("viewer render capability", () => {
  it("accepts complete WebGL 2 instanced drawing operations", () => {
    expect(
      supportsViewerInstancing({
        drawArraysInstanced() {},
        drawElementsInstanced() {},
        vertexAttribDivisor() {},
      }),
    ).toBe(true);
  });

  it("rejects a context without every core instancing operation", () => {
    expect(supportsViewerInstancing({})).toBe(false);
    expect(
      supportsViewerInstancing({
        drawArraysInstanced() {},
        drawElementsInstanced() {},
      }),
    ).toBe(false);
  });
});
