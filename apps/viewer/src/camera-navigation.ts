import { MOUSE, TOUCH } from "three";

export type CameraNavigationMode = "orbit" | "top-down";

export interface CameraNavigationProfile {
  readonly enableRotate: boolean;
  readonly screenSpacePanning: boolean;
  readonly minPolarAngle: number;
  readonly maxPolarAngle: number;
  readonly mouseButtons: {
    readonly LEFT: MOUSE;
    readonly MIDDLE: MOUSE;
    readonly RIGHT: MOUSE;
  };
  readonly touches: {
    readonly ONE: TOUCH;
    readonly TWO: TOUCH;
  };
}

const ORBIT_PROFILE: CameraNavigationProfile = Object.freeze({
  enableRotate: true,
  screenSpacePanning: false,
  minPolarAngle: 0,
  maxPolarAngle: Math.PI * 0.495,
  mouseButtons: Object.freeze({
    LEFT: MOUSE.ROTATE,
    MIDDLE: MOUSE.DOLLY,
    RIGHT: MOUSE.PAN,
  }),
  touches: Object.freeze({
    ONE: TOUCH.ROTATE,
    TWO: TOUCH.DOLLY_PAN,
  }),
});

const TOP_DOWN_PROFILE: CameraNavigationProfile = Object.freeze({
  enableRotate: false,
  // With the top-down camera's up vector on -Z, world-plane panning must use
  // the camera's screen axes. Ground-plane panning would otherwise derive a
  // vertical vector and move the target along world Y.
  screenSpacePanning: true,
  minPolarAngle: 0,
  // The viewing direction and camera up vector are perpendicular in a true
  // top-down frame. The normal orbit cap is just below PI / 2, so retaining it
  // would introduce a small tilt every time OrbitControls updates.
  maxPolarAngle: Math.PI,
  mouseButtons: Object.freeze({
    LEFT: MOUSE.PAN,
    MIDDLE: MOUSE.DOLLY,
    RIGHT: MOUSE.PAN,
  }),
  touches: Object.freeze({
    ONE: TOUCH.PAN,
    TWO: TOUCH.DOLLY_PAN,
  }),
});

export function cameraNavigationProfile(
  mode: CameraNavigationMode,
): CameraNavigationProfile {
  return mode === "top-down" ? TOP_DOWN_PROFILE : ORBIT_PROFILE;
}
