import { MOUSE, TOUCH } from "three";
import { describe, expect, it } from "vitest";

import { cameraNavigationProfile } from "../apps/viewer/src/camera-navigation.js";

describe("camera navigation profiles", () => {
  it("maps top-down mouse and touch gestures to planar pan and zoom", () => {
    const profile = cameraNavigationProfile("top-down");

    expect(profile).toMatchObject({
      enableRotate: false,
      screenSpacePanning: true,
      minPolarAngle: 0,
      maxPolarAngle: Math.PI,
      mouseButtons: {
        LEFT: MOUSE.PAN,
        MIDDLE: MOUSE.DOLLY,
        RIGHT: MOUSE.PAN,
      },
      touches: {
        ONE: TOUCH.PAN,
        TWO: TOUCH.DOLLY_PAN,
      },
    });
  });

  it("restores the regular orbit gestures after top-down navigation", () => {
    const profile = cameraNavigationProfile("orbit");

    expect(profile).toMatchObject({
      enableRotate: true,
      screenSpacePanning: false,
      minPolarAngle: 0,
      maxPolarAngle: Math.PI * 0.495,
      mouseButtons: {
        LEFT: MOUSE.ROTATE,
        MIDDLE: MOUSE.DOLLY,
        RIGHT: MOUSE.PAN,
      },
      touches: {
        ONE: TOUCH.ROTATE,
        TWO: TOUCH.DOLLY_PAN,
      },
    });
  });
});
