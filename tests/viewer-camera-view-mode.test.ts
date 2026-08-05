import { describe, expect, it } from "vitest";

import {
  cameraViewMode,
  cameraViewModeLabel,
  primaryCameraViewConfiguration,
} from "../apps/viewer/src/camera-view-mode.js";

describe("camera view modes", () => {
  it("maps the primary views to complete camera configurations", () => {
    expect(primaryCameraViewConfiguration("3d")).toEqual({
      preset: "isometric",
      projection: "perspective",
    });
    expect(primaryCameraViewConfiguration("map")).toEqual({
      preset: "top-down",
      projection: "orthographic",
    });
  });

  it("distinguishes primary views from advanced lens combinations", () => {
    expect(cameraViewMode("perspective", "orbit")).toBe("3d");
    expect(cameraViewMode("orthographic", "top-down")).toBe("map");
    expect(cameraViewMode("orthographic", "orbit")).toBe("custom");
    expect(cameraViewMode("perspective", "top-down")).toBe("custom");
    expect(cameraViewModeLabel("custom")).toBe("Custom view");
  });
});
