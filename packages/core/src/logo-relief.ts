import type { IdentityLogoPrintRelief } from "./model.js";

export const IDENTITY_LOGO_PRINT_RELIEF_VERSION =
  "codecity.logo-relief/1" as const;
export const IDENTITY_LOGO_PRINT_RELIEF_MAX_DIMENSION = 64;

const BASE64URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const BASE64URL_VALUES = new Map(
  [...BASE64URL_ALPHABET].map((character, index) => [
    character,
    index,
  ]),
);
const PRINT_RELIEF_KEYS = new Set([
  "height",
  "mask",
  "version",
  "width",
]);

function dimension(value: unknown, name: string): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > IDENTITY_LOGO_PRINT_RELIEF_MAX_DIMENSION
  ) {
    throw new TypeError(
      `${name} must be a whole number from 1 to ${IDENTITY_LOGO_PRINT_RELIEF_MAX_DIMENSION}.`,
    );
  }
  return value as number;
}

function decodeBase64Url(value: unknown): Uint8Array {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !/^[A-Za-z0-9_-]+$/u.test(value) ||
    value.length % 4 === 1
  ) {
    throw new TypeError(
      "Logo print relief mask must be canonical unpadded base64url.",
    );
  }
  const output = new Uint8Array(Math.floor((value.length * 6) / 8));
  let accumulator = 0;
  let bits = 0;
  let outputIndex = 0;
  for (const character of value) {
    const decoded = BASE64URL_VALUES.get(character);
    if (decoded === undefined) {
      throw new TypeError(
        "Logo print relief mask must be canonical unpadded base64url.",
      );
    }
    accumulator = accumulator * 64 + decoded;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output[outputIndex] = Math.floor(
        accumulator / 2 ** bits,
      ) & 0xff;
      outputIndex += 1;
      accumulator %= 2 ** bits;
    }
  }
  if (accumulator !== 0 || encodeBase64Url(output) !== value) {
    throw new TypeError(
      "Logo print relief mask must be canonical unpadded base64url.",
    );
  }
  return output;
}

export function encodeIdentityLogoPrintReliefMask(
  bytes: Uint8Array,
): string {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    throw new TypeError("Logo print relief mask bytes are required.");
  }
  return encodeBase64Url(bytes);
}

function encodeBase64Url(bytes: Uint8Array): string {
  let result = "";
  let accumulator = 0;
  let bits = 0;
  for (const byte of bytes) {
    accumulator = accumulator * 256 + byte;
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      result += BASE64URL_ALPHABET[
        Math.floor(accumulator / 2 ** bits) & 0x3f
      ];
      accumulator %= 2 ** bits;
    }
  }
  if (bits > 0) {
    result += BASE64URL_ALPHABET[
      (accumulator * 2 ** (6 - bits)) & 0x3f
    ];
  }
  return result;
}

export function decodeIdentityLogoPrintReliefMask(
  relief: IdentityLogoPrintRelief,
): Uint8Array {
  const width = dimension(relief.width, "Logo print relief width");
  const height = dimension(relief.height, "Logo print relief height");
  const bytes = decodeBase64Url(relief.mask);
  const bitCount = width * height;
  const expectedBytes = Math.ceil(bitCount / 8);
  if (bytes.byteLength !== expectedBytes) {
    throw new TypeError(
      "Logo print relief mask length does not match its dimensions.",
    );
  }
  const unusedBits = expectedBytes * 8 - bitCount;
  if (
    unusedBits > 0 &&
    (bytes[bytes.byteLength - 1]! & (2 ** unusedBits - 1)) !== 0
  ) {
    throw new TypeError(
      "Logo print relief mask has nonzero unused bits.",
    );
  }
  if (!bytes.some((byte) => byte !== 0)) {
    throw new TypeError("Logo print relief mask must not be empty.");
  }
  return bytes;
}

export function normalizeIdentityLogoPrintRelief(
  value: unknown,
): IdentityLogoPrintRelief {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new TypeError("Logo print relief must be an object.");
  }
  const keys = Object.keys(value);
  if (
    keys.length !== PRINT_RELIEF_KEYS.size ||
    keys.some((key) => !PRINT_RELIEF_KEYS.has(key))
  ) {
    throw new TypeError(
      "Logo print relief contains unknown or missing fields.",
    );
  }
  const relief = value as Record<string, unknown>;
  if (relief["version"] !== IDENTITY_LOGO_PRINT_RELIEF_VERSION) {
    throw new TypeError(
      `Logo print relief version must be ${IDENTITY_LOGO_PRINT_RELIEF_VERSION}.`,
    );
  }
  const width = dimension(relief["width"], "Logo print relief width");
  const height = dimension(relief["height"], "Logo print relief height");
  const mask = relief["mask"];
  const normalized: IdentityLogoPrintRelief = {
    version: IDENTITY_LOGO_PRINT_RELIEF_VERSION,
    width,
    height,
    mask: typeof mask === "string" ? mask : "",
  };
  decodeIdentityLogoPrintReliefMask(normalized);
  return Object.freeze({
    version: IDENTITY_LOGO_PRINT_RELIEF_VERSION,
    width,
    height,
    mask: normalized.mask,
  });
}

export function identityLogoPrintReliefBit(
  relief: IdentityLogoPrintRelief,
  x: number,
  y: number,
): boolean {
  if (
    !Number.isSafeInteger(x) ||
    !Number.isSafeInteger(y) ||
    x < 0 ||
    x >= relief.width ||
    y < 0 ||
    y >= relief.height
  ) {
    throw new RangeError("Logo print relief coordinate is outside the mask.");
  }
  const bytes = decodeIdentityLogoPrintReliefMask(relief);
  const bit = y * relief.width + x;
  return (bytes[Math.floor(bit / 8)]! & (0x80 >> (bit % 8))) !== 0;
}
