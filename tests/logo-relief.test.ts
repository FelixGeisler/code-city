import { describe, expect, it } from "vitest";

import {
  decodeIdentityLogoPrintReliefMask,
  encodeIdentityLogoPrintReliefMask,
  identityLogoPrintReliefBit,
  normalizeIdentityLogo,
  normalizeIdentityLogoPrintRelief,
} from "../packages/core/src/index.js";

describe("printable identity logo relief", () => {
  it("normalizes a canonical row-major 1bpp mask", () => {
    const relief = normalizeIdentityLogoPrintRelief({
      version: "codecity.logo-relief/1",
      width: 3,
      height: 2,
      mask: "qA",
    });

    expect(relief).toEqual({
      version: "codecity.logo-relief/1",
      width: 3,
      height: 2,
      mask: "qA",
    });
    expect(decodeIdentityLogoPrintReliefMask(relief)).toEqual(
      new Uint8Array([0b10101000]),
    );
    expect(
      Array.from({ length: 2 }, (_, y) =>
        Array.from({ length: 3 }, (_, x) =>
          identityLogoPrintReliefBit(relief, x, y),
        ),
      ),
    ).toEqual([
      [true, false, true],
      [false, true, false],
    ]);
    expect(
      encodeIdentityLogoPrintReliefMask(
        new Uint8Array([0b10101000]),
      ),
    ).toBe("qA");
  });

  it("preserves a valid relief through identity normalization", () => {
    expect(
      normalizeIdentityLogo({
        relativePath: "assets/logo.png",
        format: "png",
        printRelief: {
          version: "codecity.logo-relief/1",
          width: 1,
          height: 1,
          mask: "gA",
        },
      }),
    ).toMatchObject({
      relativePath: "assets/logo.png",
      format: "png",
      printRelief: {
        version: "codecity.logo-relief/1",
        width: 1,
        height: 1,
        mask: "gA",
      },
    });
  });

  it.each([
    [
      "unknown fields",
      {
        version: "codecity.logo-relief/1",
        width: 1,
        height: 1,
        mask: "gA",
        metadata: "forbidden",
      },
    ],
    [
      "unknown versions",
      {
        version: "codecity.logo-relief/2",
        width: 1,
        height: 1,
        mask: "gA",
      },
    ],
    [
      "padded base64",
      {
        version: "codecity.logo-relief/1",
        width: 1,
        height: 1,
        mask: "gA==",
      },
    ],
    [
      "bad lengths",
      {
        version: "codecity.logo-relief/1",
        width: 9,
        height: 1,
        mask: "gA",
      },
    ],
    [
      "nonzero unused bits",
      {
        version: "codecity.logo-relief/1",
        width: 3,
        height: 2,
        mask: "qQ",
      },
    ],
    [
      "empty masks",
      {
        version: "codecity.logo-relief/1",
        width: 3,
        height: 2,
        mask: "AA",
      },
    ],
    [
      "oversized dimensions",
      {
        version: "codecity.logo-relief/1",
        width: 65,
        height: 1,
        mask: "gA",
      },
    ],
  ])("rejects %s", (_description, relief) => {
    expect(() => normalizeIdentityLogoPrintRelief(relief)).toThrow();
  });
});
