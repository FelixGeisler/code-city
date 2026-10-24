const FIXED_TRANSFER_SOURCE_OWNERSHIP = Symbol("fixed-transfer-source-ownership");
const fixedTransferNormalizedBytes = new WeakSet<Uint8Array>();
const fixedTransferNormalizedBuffers = new WeakSet<ArrayBuffer>();
const encoder = new TextEncoder();

export const fixedTransferSourceOwnership = FIXED_TRANSFER_SOURCE_OWNERSHIP;

function fixFreshNormalizedUtf8(value: Uint8Array): void {
  const buffer = value.buffer as ArrayBuffer;
  if (Object.getPrototypeOf(value) !== Uint8Array.prototype
    || Object.getPrototypeOf(buffer) !== ArrayBuffer.prototype
    || value.byteOffset !== 0
    || value.byteLength !== buffer.byteLength
    || (buffer as ArrayBuffer & { resizable?: boolean }).resizable === true
    || Object.getOwnPropertySymbols(value).length !== 0
    || Reflect.ownKeys(buffer).length !== 0
    || !Object.isExtensible(value)
    || !Object.isExtensible(buffer)) {
    throw new Error("Normalized source byte ownership is invalid");
  }
  Object.preventExtensions(buffer);
  Object.preventExtensions(value);
  fixedTransferNormalizedBuffers.add(buffer);
  fixedTransferNormalizedBytes.add(value);
}

export function applyRequestedSourceByteOwnership(gateway: object, value: Uint8Array): void {
  const request = Object.getOwnPropertyDescriptor(gateway, FIXED_TRANSFER_SOURCE_OWNERSHIP);
  if (request?.value === true) fixFreshNormalizedUtf8(value);
}

export function createFixedTransferNormalizedUtf8(normalizedSource: string): Uint8Array {
  const value = new Uint8Array(encoder.encode(normalizedSource));
  fixFreshNormalizedUtf8(value);
  return value;
}

export function isFixedTransferNormalizedUtf8(value: unknown): value is Uint8Array {
  try {
    if (typeof value !== "object" || value === null || !ArrayBuffer.isView(value)
      || Object.getPrototypeOf(value) !== Uint8Array.prototype) return false;
    const bytes = value as Uint8Array;
    const buffer = bytes.buffer as ArrayBuffer;
    return Object.getPrototypeOf(buffer) === ArrayBuffer.prototype
      && bytes.byteOffset === 0
      && bytes.byteLength === buffer.byteLength
      && (buffer as ArrayBuffer & { resizable?: boolean }).resizable !== true
      && Object.getOwnPropertySymbols(bytes).length === 0
      && Reflect.ownKeys(buffer).length === 0
      && fixedTransferNormalizedBytes.has(bytes)
      && fixedTransferNormalizedBuffers.has(buffer)
      && !Object.isExtensible(bytes)
      && !Object.isExtensible(buffer);
  } catch {
    return false;
  }
}
