import { describe, expect, it } from "vitest";

import { environmentSourceRetention } from "../apps/server/src/main.js";

describe("source retention environment policy", () => {
  it.each([
    [undefined, "disabled"],
    ["", "disabled"],
    ["disabled", "disabled"],
    ["retain", "retain"],
  ] as const)("maps %s to %s", (value, expected) => {
    expect(environmentSourceRetention(value)).toBe(expected);
  });

  it.each([" retain", "retain ", "DISABLED", "true", "1"])(
    "rejects the non-canonical value %s",
    (value) => {
      expect(() => environmentSourceRetention(value)).toThrow(
        /exactly retain or disabled/u,
      );
    },
  );
});
