import { describe, expect, it, vi } from "vitest";

import {
  supportsViewerInstancing,
  type ViewerInstancingContext,
} from "../apps/viewer/src/viewer-render-capability.js";

describe("viewer render capability", () => {
  it("accepts native WebGL 2 instanced drawing operations", () => {
    const getExtension = vi.fn(() => {
      throw new Error("WebGL 2 must not require the ANGLE fallback.");
    });

    expect(
      supportsViewerInstancing({
        drawArraysInstanced() {},
        drawElementsInstanced() {},
        vertexAttribDivisor() {},
        getExtension,
      }),
    ).toBe(true);
    expect(getExtension).not.toHaveBeenCalled();
  });

  it("accepts the complete WebGL 1 ANGLE instancing extension", () => {
    expect(
      supportsViewerInstancing(
        contextWithExtension({
          drawArraysInstancedANGLE() {},
          drawElementsInstancedANGLE() {},
          vertexAttribDivisorANGLE() {},
        }),
      ),
    ).toBe(true);
  });

  it("rejects WebGL 1 contexts without a complete instancing extension", () => {
    expect(supportsViewerInstancing(contextWithExtension(null))).toBe(false);
    expect(
      supportsViewerInstancing(
        contextWithExtension({
          drawArraysInstancedANGLE() {},
          drawElementsInstancedANGLE() {},
        }),
      ),
    ).toBe(false);
  });
});

function contextWithExtension(
  extension: unknown,
): ViewerInstancingContext {
  return {
    getExtension(name) {
      expect(name).toBe("ANGLE_instanced_arrays");
      return extension;
    },
  };
}
