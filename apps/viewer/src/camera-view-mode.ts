import type { CameraNavigationMode } from "./camera-navigation.js";
import type {
  CameraPreset,
  CameraProjection,
} from "./camera-presets.js";

export type CameraViewMode = "3d" | "custom" | "map";
export type PrimaryCameraViewMode = Exclude<CameraViewMode, "custom">;

export interface PrimaryCameraViewConfiguration {
  readonly preset: Extract<CameraPreset, "isometric" | "top-down">;
  readonly projection: CameraProjection;
}

const PRIMARY_VIEW_CONFIGURATIONS = Object.freeze({
  "3d": Object.freeze({
    preset: "isometric",
    projection: "perspective",
  }),
  map: Object.freeze({
    preset: "top-down",
    projection: "orthographic",
  }),
} satisfies Record<PrimaryCameraViewMode, PrimaryCameraViewConfiguration>);

export function cameraViewMode(
  projection: CameraProjection,
  navigationMode: CameraNavigationMode,
): CameraViewMode {
  if (projection === "perspective" && navigationMode === "orbit") {
    return "3d";
  }
  if (
    projection === "orthographic" &&
    navigationMode === "top-down"
  ) {
    return "map";
  }
  return "custom";
}

export function primaryCameraViewConfiguration(
  mode: PrimaryCameraViewMode,
): PrimaryCameraViewConfiguration {
  return PRIMARY_VIEW_CONFIGURATIONS[mode];
}

export function cameraViewModeLabel(mode: CameraViewMode): string {
  switch (mode) {
    case "3d":
      return "3D view";
    case "map":
      return "Map view";
    case "custom":
      return "Custom view";
  }
}
