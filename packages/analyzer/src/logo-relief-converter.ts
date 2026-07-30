import { inflateSync } from "node:zlib";

import {
  encodeIdentityLogoPrintReliefMask,
  IDENTITY_LOGO_PRINT_RELIEF_VERSION,
  type IdentityLogoFormat,
  type IdentityLogoPrintRelief,
} from "../../core/src/index.js";

export const LOGO_RELIEF_INPUT_MAX_BYTES = 2 * 1024 * 1024;
export const LOGO_RELIEF_MAX_SOURCE_DIMENSION = 2_048;
export const LOGO_RELIEF_MAX_SOURCE_PIXELS = 4_194_304;
export const LOGO_RELIEF_MAX_RGBA_BYTES = 16 * 1024 * 1024;
export const LOGO_RELIEF_MAX_SVG_ELEMENTS = 512;
export const LOGO_RELIEF_MAX_SVG_PATH_BYTES = 64 * 1024;
export const LOGO_RELIEF_MAX_SVG_POINTS = 8_192;

const PNG_SIGNATURE = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const SVG_FORBIDDEN =
  /<!DOCTYPE|<!ENTITY|<\s*(?:script|style|text|foreignObject|image|use|animate|set|filter|mask|linearGradient|radialGradient|pattern|font)\b|\b(?:href|src)\s*=|\bon[a-z]+\s*=|url\s*\(/iu;
const SVG_TAG_PATTERN = /<\s*(\/?)\s*([A-Za-z][A-Za-z0-9:-]*)([^<>]*)>/gu;
const SVG_ALLOWED_TAGS = new Set([
  "circle",
  "ellipse",
  "g",
  "path",
  "polygon",
  "rect",
  "svg",
]);
const SVG_ALLOWED_ATTRIBUTES = new Set([
  "cx",
  "cy",
  "d",
  "fill",
  "fill-rule",
  "height",
  "id",
  "points",
  "r",
  "rx",
  "ry",
  "version",
  "viewBox",
  "width",
  "x",
  "xmlns",
  "y",
]);
const ATTRIBUTE_PATTERN =
  /([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*(["'])(.*?)\2/gu;

interface Point {
  readonly x: number;
  readonly y: number;
}

interface Shape {
  readonly polygons: readonly (readonly Point[])[];
  readonly evenOdd: boolean;
}

interface SvgElementContext {
  readonly name: string;
  readonly fill: string | null;
  readonly evenOdd: boolean;
}

interface RasterMask {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
}

function failure(message: string): never {
  throw new Error(`Logo relief conversion rejected: ${message}`);
}

function checkedInput(bytes: Uint8Array): Uint8Array {
  if (!(bytes instanceof Uint8Array)) failure("input is not bytes.");
  if (bytes.byteLength < 1 || bytes.byteLength > LOGO_RELIEF_INPUT_MAX_BYTES) {
    failure("input size is outside the 2 MiB limit.");
  }
  return bytes;
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! * 0x1000000 +
    bytes[offset + 1]! * 0x10000 +
    bytes[offset + 2]! * 0x100 +
    bytes[offset + 3]!
  );
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value =
        (value & 1) === 0
          ? value >>> 1
          : 0xedb88320 ^ (value >>> 1);
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value = CRC_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function concatenate(chunks: readonly Uint8Array[]): Uint8Array {
  const length = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function paeth(left: number, above: number, upperLeft: number): number {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const diagonalDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= diagonalDistance) {
    return left;
  }
  return aboveDistance <= diagonalDistance ? above : upperLeft;
}

function pngMask(input: Uint8Array): RasterMask {
  const bytes = checkedInput(input);
  if (
    bytes.byteLength < PNG_SIGNATURE.byteLength ||
    PNG_SIGNATURE.some((value, index) => bytes[index] !== value)
  ) {
    failure("PNG signature is invalid.");
  }
  let offset = PNG_SIGNATURE.byteLength;
  let width = 0;
  let height = 0;
  let channels = 0;
  let sawHeader = false;
  let sawEnd = false;
  const compressed: Uint8Array[] = [];
  while (offset < bytes.byteLength) {
    if (offset + 12 > bytes.byteLength) failure("PNG chunk is truncated.");
    const length = readUint32(bytes, offset);
    const typeBytes = bytes.subarray(offset + 4, offset + 8);
    const type = new TextDecoder("ascii", { fatal: true }).decode(typeBytes);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const crcOffset = dataEnd;
    if (dataEnd + 4 > bytes.byteLength) failure("PNG chunk is truncated.");
    const data = bytes.subarray(dataStart, dataEnd);
    const crcInput = bytes.subarray(offset + 4, dataEnd);
    if (crc32(crcInput) !== readUint32(bytes, crcOffset)) {
      failure("PNG chunk CRC is invalid.");
    }
    offset = dataEnd + 4;
    if (type === "IHDR") {
      if (sawHeader || length !== 13 || dataStart !== 16) {
        failure("PNG header is invalid.");
      }
      sawHeader = true;
      width = readUint32(data, 0);
      height = readUint32(data, 4);
      const bitDepth = data[8];
      const colorType = data[9];
      if (
        bitDepth !== 8 ||
        (colorType !== 6 && colorType !== 4) ||
        data[10] !== 0 ||
        data[11] !== 0 ||
        data[12] !== 0
      ) {
        failure(
          "PNG must be a non-interlaced 8-bit grayscale-alpha or RGBA image.",
        );
      }
      channels = colorType === 6 ? 4 : 2;
      if (
        width < 1 ||
        height < 1 ||
        width > LOGO_RELIEF_MAX_SOURCE_DIMENSION ||
        height > LOGO_RELIEF_MAX_SOURCE_DIMENSION ||
        width * height > LOGO_RELIEF_MAX_SOURCE_PIXELS ||
        width * height * 4 > LOGO_RELIEF_MAX_RGBA_BYTES
      ) {
        failure("PNG dimensions exceed the raster safety limits.");
      }
    } else if (type === "IDAT") {
      if (!sawHeader || sawEnd) failure("PNG chunk order is invalid.");
      compressed.push(data);
    } else if (type === "IEND") {
      if (length !== 0 || !sawHeader || compressed.length === 0) {
        failure("PNG end chunk is invalid.");
      }
      sawEnd = true;
      if (offset !== bytes.byteLength) {
        failure("PNG contains data after its end chunk.");
      }
    } else if ((typeBytes[0]! & 0x20) === 0) {
      failure("PNG contains an unsupported critical chunk.");
    }
  }
  if (!sawHeader || !sawEnd) failure("PNG is incomplete.");

  const rowBytes = width * channels;
  const expectedInflated = (rowBytes + 1) * height;
  let inflated: Uint8Array;
  try {
    inflated = inflateSync(concatenate(compressed), {
      maxOutputLength: expectedInflated,
    });
  } catch {
    failure("PNG compressed data is invalid or exceeds its declared size.");
  }
  if (inflated.byteLength !== expectedInflated) {
    failure("PNG decompressed size does not match its header.");
  }
  const decoded = new Uint8Array(rowBytes * height);
  for (let y = 0; y < height; y += 1) {
    const sourceOffset = y * (rowBytes + 1);
    const filter = inflated[sourceOffset]!;
    if (filter > 4) failure("PNG uses an invalid row filter.");
    for (let x = 0; x < rowBytes; x += 1) {
      const raw = inflated[sourceOffset + 1 + x]!;
      const destination = y * rowBytes + x;
      const left = x >= channels ? decoded[destination - channels]! : 0;
      const above = y > 0 ? decoded[destination - rowBytes]! : 0;
      const upperLeft =
        y > 0 && x >= channels
          ? decoded[destination - rowBytes - channels]!
          : 0;
      const predictor =
        filter === 0
          ? 0
          : filter === 1
            ? left
            : filter === 2
              ? above
              : filter === 3
                ? Math.floor((left + above) / 2)
                : paeth(left, above, upperLeft);
      decoded[destination] = (raw + predictor) & 0xff;
    }
  }

  const alpha = new Uint8Array(width * height);
  let color: string | undefined;
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const start = pixel * channels;
    const alphaValue = decoded[start + channels - 1]!;
    if (alphaValue !== 0 && alphaValue !== 255) {
      failure("PNG must not contain partially transparent pixels.");
    }
    if (alphaValue === 0) continue;
    const current =
      channels === 4
        ? `${decoded[start]},${decoded[start + 1]},${decoded[start + 2]}`
        : `${decoded[start]},${decoded[start]},${decoded[start]}`;
    if (color !== undefined && current !== color) {
      failure("PNG must contain one solid silhouette color.");
    }
    color = current;
    alpha[pixel] = 1;
  }
  if (color === undefined) failure("PNG silhouette is empty.");
  return normalizeRasterMask({ width, height, pixels: alpha });
}

function finiteNumber(value: string | undefined, name: string): number {
  if (
    value === undefined ||
    !/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?$/u.test(value)
  ) {
    failure(`SVG ${name} is invalid.`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) failure(`SVG ${name} is invalid.`);
  return parsed;
}

function svgFill(value: string): string | null {
  const normalized = value.toLocaleLowerCase("en-US");
  if (normalized === "none") return null;
  if (/^#[0-9a-f]{3}$/u.test(normalized)) {
    return `#${[...normalized.slice(1)]
      .map((character) => character.repeat(2))
      .join("")}`;
  }
  if (/^#[0-9a-f]{6}$/u.test(normalized)) return normalized;
  const rgb = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/u.exec(
    normalized,
  );
  if (rgb !== null) {
    const channels = rgb.slice(1).map(Number);
    if (channels.every((channel) => channel <= 255)) {
      return `rgb(${channels.join(",")})`;
    }
  }
  if (
    /^[a-z]+$/u.test(normalized) &&
    !new Set([
      "currentcolor",
      "inherit",
      "initial",
      "revert",
      "transparent",
      "unset",
    ]).has(normalized)
  ) {
    return normalized;
  }
  failure("SVG fill must be one opaque solid color.");
}

function svgFillRule(
  value: string | undefined,
  inherited = false,
): boolean {
  if (value === undefined) return inherited;
  if (value === "evenodd") return true;
  if (value === "nonzero") return false;
  failure("SVG fill rule is invalid.");
}

function attributes(text: string): ReadonlyMap<string, string> {
  const values = new Map<string, string>();
  let consumed = "";
  for (const match of text.matchAll(ATTRIBUTE_PATTERN)) {
    const name = match[1]!;
    if (!SVG_ALLOWED_ATTRIBUTES.has(name) || values.has(name)) {
      failure("SVG contains an unsupported or duplicate attribute.");
    }
    values.set(name, match[3]!);
    consumed += match[0];
  }
  const remainder = text
    .replace(ATTRIBUTE_PATTERN, "")
    .replaceAll("/", "")
    .trim();
  if (remainder !== "") {
    failure("SVG contains malformed or unsupported attributes.");
  }
  return values;
}

function polygonPoints(value: string): readonly Point[] {
  const numbers = value
    .trim()
    .split(/[\s,]+/u)
    .filter(Boolean)
    .map((item) => finiteNumber(item, "polygon coordinate"));
  if (numbers.length < 6 || numbers.length % 2 !== 0) {
    failure("SVG polygon is invalid.");
  }
  const points: Point[] = [];
  for (let index = 0; index < numbers.length; index += 2) {
    points.push({ x: numbers[index]!, y: numbers[index + 1]! });
  }
  return points;
}

function pathPolygons(value: string): readonly (readonly Point[])[] {
  if (new TextEncoder().encode(value).byteLength > LOGO_RELIEF_MAX_SVG_PATH_BYTES) {
    failure("SVG path data exceeds its limit.");
  }
  const tokens =
    value.match(/[MmLlHhVvZz]|[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?/gu) ??
    [];
  if (tokens.join("").replaceAll("+", "") === "" && value.trim() !== "") {
    failure("SVG path data is invalid.");
  }
  if (
    value.replace(
      /[MmLlHhVvZz]|[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?|[\s,]+/gu,
      "",
    ) !== ""
  ) {
    failure("SVG path uses unsupported commands.");
  }
  const polygons: Point[][] = [];
  let current: Point[] = [];
  let cursor: Point = { x: 0, y: 0 };
  let start: Point | undefined;
  let command = "";
  let index = 0;
  const coordinate = (): number => {
    const token = tokens[index];
    if (token === undefined || /^[A-Za-z]$/u.test(token)) {
      failure("SVG path coordinate is missing.");
    }
    index += 1;
    return finiteNumber(token, "path coordinate");
  };
  const append = (point: Point): void => {
    current.push(point);
    cursor = point;
    if (current.length > LOGO_RELIEF_MAX_SVG_POINTS) {
      failure("SVG path point limit exceeded.");
    }
  };
  while (index < tokens.length) {
    const token = tokens[index]!;
    if (/^[A-Za-z]$/u.test(token)) {
      command = token;
      index += 1;
    } else if (command === "") {
      failure("SVG path must begin with a command.");
    }
    if (command === "M" || command === "m") {
      if (current.length > 0) polygons.push(current);
      current = [];
      const x = coordinate();
      const y = coordinate();
      const point =
        command === "m"
          ? { x: cursor.x + x, y: cursor.y + y }
          : { x, y };
      append(point);
      start = point;
      command = command === "m" ? "l" : "L";
    } else if (command === "L" || command === "l") {
      const x = coordinate();
      const y = coordinate();
      append(
        command === "l"
          ? { x: cursor.x + x, y: cursor.y + y }
          : { x, y },
      );
    } else if (command === "H" || command === "h") {
      const x = coordinate();
      append({
        x: command === "h" ? cursor.x + x : x,
        y: cursor.y,
      });
    } else if (command === "V" || command === "v") {
      const y = coordinate();
      append({
        x: cursor.x,
        y: command === "v" ? cursor.y + y : y,
      });
    } else if (command === "Z" || command === "z") {
      if (start !== undefined && current.length > 0) append(start);
      command = "";
      start = undefined;
    } else {
      failure("SVG path uses unsupported commands.");
    }
  }
  if (current.length > 0) polygons.push(current);
  if (polygons.some((polygon) => polygon.length < 3)) {
    failure("SVG path does not describe a closed silhouette.");
  }
  return polygons;
}

function pointInside(point: Point, polygon: readonly Point[]): boolean {
  let inside = false;
  for (
    let index = 0, previous = polygon.length - 1;
    index < polygon.length;
    previous = index, index += 1
  ) {
    const left = polygon[index]!;
    const right = polygon[previous]!;
    if (
      (left.y > point.y) !== (right.y > point.y) &&
      point.x <
        ((right.x - left.x) * (point.y - left.y)) /
          (right.y - left.y) +
          left.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

function svgMask(input: Uint8Array): RasterMask {
  const bytes = checkedInput(input);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    failure("SVG must be valid UTF-8.");
  }
  if (
    SVG_FORBIDDEN.test(text) ||
    text.includes("&") ||
    text.includes("<!--") ||
    text.includes("<?")
  ) {
    failure("SVG contains forbidden executable or external content.");
  }
  const tags = [...text.matchAll(SVG_TAG_PATTERN)];
  if (tags.length < 2 || tags.length > LOGO_RELIEF_MAX_SVG_ELEMENTS) {
    failure("SVG structure exceeds its limits.");
  }
  const uncovered = text.replace(SVG_TAG_PATTERN, "").trim();
  if (uncovered !== "") failure("SVG contains unsupported text content.");
  let root: ReadonlyMap<string, string> | undefined;
  const shapes: Shape[] = [];
  const colors = new Set<string>();
  const stack: SvgElementContext[] = [];
  let rootClosed = false;
  let totalPoints = 0;
  for (const tag of tags) {
    const closing = tag[1] === "/";
    const name = tag[2]!;
    if (!SVG_ALLOWED_TAGS.has(name)) {
      failure("SVG contains an unsupported element.");
    }
    if (closing) {
      if (
        tag[3]!.trim() !== "" ||
        stack.at(-1)?.name !== name
      ) {
        failure("SVG element nesting is invalid.");
      }
      stack.pop();
      if (name === "svg") rootClosed = true;
      continue;
    }
    const selfClosing = /\/\s*$/u.test(tag[3]!);
    const values = attributes(tag[3]!);
    if (name === "svg") {
      if (root !== undefined || stack.length !== 0 || rootClosed) {
        failure("SVG root is invalid.");
      }
      root = values;
      const context = {
        name,
        fill: svgFill(values.get("fill") ?? "#000000"),
        evenOdd: svgFillRule(values.get("fill-rule")),
      };
      if (selfClosing) rootClosed = true;
      else stack.push(context);
      continue;
    }
    const parent = stack.at(-1);
    if (root === undefined || rootClosed || parent === undefined) {
      failure("SVG root is invalid.");
    }
    const fill =
      values.get("fill") === undefined
        ? parent.fill
        : svgFill(values.get("fill")!);
    const evenOdd = svgFillRule(
      values.get("fill-rule"),
      parent.evenOdd,
    );
    const context = { name, fill, evenOdd };
    if (!selfClosing) stack.push(context);
    if (name === "g") continue;
    let polygons: readonly (readonly Point[])[];
    if (name === "rect") {
      if (values.has("rx") || values.has("ry")) {
        failure("SVG rounded rectangles are unsupported.");
      }
      const x = values.has("x") ? finiteNumber(values.get("x"), "rect x") : 0;
      const y = values.has("y") ? finiteNumber(values.get("y"), "rect y") : 0;
      const width = finiteNumber(values.get("width"), "rect width");
      const height = finiteNumber(values.get("height"), "rect height");
      if (width <= 0 || height <= 0) failure("SVG rect is empty.");
      polygons = [[
        { x, y },
        { x: x + width, y },
        { x: x + width, y: y + height },
        { x, y: y + height },
      ]];
    } else if (name === "circle" || name === "ellipse") {
      const cx = finiteNumber(values.get("cx") ?? "0", `${name} cx`);
      const cy = finiteNumber(values.get("cy") ?? "0", `${name} cy`);
      const rx = finiteNumber(
        name === "circle" ? values.get("r") : values.get("rx"),
        `${name} radius`,
      );
      const ry = finiteNumber(
        name === "circle" ? values.get("r") : values.get("ry"),
        `${name} radius`,
      );
      if (rx <= 0 || ry <= 0) failure(`SVG ${name} is empty.`);
      polygons = [[
        ...Array.from({ length: 64 }, (_, index) => {
          const angle = (index / 64) * Math.PI * 2;
          return {
            x: cx + Math.cos(angle) * rx,
            y: cy + Math.sin(angle) * ry,
          };
        }),
      ]];
    } else if (name === "polygon") {
      polygons = [polygonPoints(values.get("points") ?? "")];
    } else if (name === "path") {
      polygons = pathPolygons(values.get("d") ?? "");
    } else {
      failure("SVG contains an unsupported shape.");
    }
    totalPoints += polygons.reduce(
      (sum, polygon) => sum + polygon.length,
      0,
    );
    if (totalPoints > LOGO_RELIEF_MAX_SVG_POINTS) {
      failure("SVG point limit exceeded.");
    }
    if (fill !== null) {
      colors.add(fill);
      if (colors.size > 1) {
        failure("SVG must contain one solid silhouette color.");
      }
      shapes.push({ polygons, evenOdd });
    }
  }
  if (
    root === undefined ||
    !rootClosed ||
    stack.length !== 0 ||
    shapes.length === 0
  ) {
    failure("SVG does not contain a complete silhouette.");
  }
  const viewBoxText = root.get("viewBox");
  let minimumX = 0;
  let minimumY = 0;
  let sourceWidth: number;
  let sourceHeight: number;
  if (viewBoxText !== undefined) {
    const parts = viewBoxText.trim().split(/[\s,]+/u);
    if (parts.length !== 4) failure("SVG viewBox is invalid.");
    [minimumX, minimumY, sourceWidth, sourceHeight] = parts.map((part) =>
      finiteNumber(part, "viewBox"),
    ) as [number, number, number, number];
  } else {
    sourceWidth = finiteNumber(root.get("width"), "width");
    sourceHeight = finiteNumber(root.get("height"), "height");
  }
  if (
    sourceWidth <= 0 ||
    sourceHeight <= 0 ||
    sourceWidth > 1_000_000 ||
    sourceHeight > 1_000_000
  ) {
    failure("SVG viewport is invalid.");
  }
  const width = 64;
  const height = Math.max(
    1,
    Math.min(64, Math.round((sourceHeight / sourceWidth) * width)),
  );
  const pixels = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let coveredSamples = 0;
      for (const sampleY of [0.25, 0.75]) {
        for (const sampleX of [0.25, 0.75]) {
          const point = {
            x: minimumX + ((x + sampleX) / width) * sourceWidth,
            y: minimumY + ((y + sampleY) / height) * sourceHeight,
          };
          const covered = shapes.some((shape) => {
            const matches = shape.polygons.filter((polygon) =>
              pointInside(point, polygon),
            ).length;
            return shape.evenOdd ? matches % 2 === 1 : matches > 0;
          });
          if (covered) coveredSamples += 1;
        }
      }
      if (coveredSamples >= 2) pixels[y * width + x] = 1;
    }
  }
  return normalizeRasterMask({ width, height, pixels });
}

function normalizeRasterMask(source: RasterMask): RasterMask {
  let minimumX = source.width;
  let minimumY = source.height;
  let maximumX = -1;
  let maximumY = -1;
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      if (source.pixels[y * source.width + x] === 0) continue;
      minimumX = Math.min(minimumX, x);
      minimumY = Math.min(minimumY, y);
      maximumX = Math.max(maximumX, x);
      maximumY = Math.max(maximumY, y);
    }
  }
  if (maximumX < minimumX || maximumY < minimumY) {
    failure("silhouette is empty.");
  }
  const croppedWidth = maximumX - minimumX + 1;
  const croppedHeight = maximumY - minimumY + 1;
  const scale = Math.min(
    1,
    64 / croppedWidth,
    64 / croppedHeight,
  );
  const width = Math.max(1, Math.round(croppedWidth * scale));
  const height = Math.max(1, Math.round(croppedHeight * scale));
  const pixels = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const sourceY0 = minimumY + (y * croppedHeight) / height;
    const sourceY1 =
      minimumY + ((y + 1) * croppedHeight) / height;
    for (let x = 0; x < width; x += 1) {
      const sourceX0 = minimumX + (x * croppedWidth) / width;
      const sourceX1 =
        minimumX + ((x + 1) * croppedWidth) / width;
      let coveredArea = 0;
      for (
        let sourceY = Math.floor(sourceY0);
        sourceY < Math.ceil(sourceY1);
        sourceY += 1
      ) {
        const overlapY =
          Math.min(sourceY + 1, sourceY1) -
          Math.max(sourceY, sourceY0);
        for (
          let sourceX = Math.floor(sourceX0);
          sourceX < Math.ceil(sourceX1);
          sourceX += 1
        ) {
          if (
            source.pixels[sourceY * source.width + sourceX] === 0
          ) {
            continue;
          }
          const overlapX =
            Math.min(sourceX + 1, sourceX1) -
            Math.max(sourceX, sourceX0);
          coveredArea += overlapX * overlapY;
        }
      }
      const area = (sourceX1 - sourceX0) * (sourceY1 - sourceY0);
      if (coveredArea * 2 >= area) pixels[y * width + x] = 1;
    }
  }
  if (!pixels.some((value) => value !== 0)) {
    failure("silhouette disappeared during bounded rasterization.");
  }
  return { width, height, pixels };
}

function printRelief(mask: RasterMask): IdentityLogoPrintRelief {
  const bytes = new Uint8Array(
    Math.ceil((mask.width * mask.height) / 8),
  );
  for (let index = 0; index < mask.pixels.length; index += 1) {
    if (mask.pixels[index] !== 0) {
      bytes[Math.floor(index / 8)]! |= 0x80 >> (index % 8);
    }
  }
  return Object.freeze({
    version: IDENTITY_LOGO_PRINT_RELIEF_VERSION,
    width: mask.width,
    height: mask.height,
    mask: encodeIdentityLogoPrintReliefMask(bytes),
  });
}

export function convertLogoToPrintRelief(
  bytes: Uint8Array,
  format: IdentityLogoFormat,
): IdentityLogoPrintRelief {
  return printRelief(format === "png" ? pngMask(bytes) : svgMask(bytes));
}
