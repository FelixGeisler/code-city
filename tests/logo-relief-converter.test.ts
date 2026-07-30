import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { zlibSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";

import {
  acquireLocalLogoPrintRelief,
  convertLogoToPrintRelief,
  LOCAL_LOGO_RELIEF_WARNING,
  type LogoReliefWorker,
} from "../packages/analyzer/src/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "code-city-logo-relief-"),
  );
  temporaryDirectories.push(directory);
  return directory;
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

function uint32(value: number): Uint8Array {
  return new Uint8Array([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

function joined(chunks: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  return joined([
    uint32(data.byteLength),
    typeBytes,
    data,
    uint32(crc32(joined([typeBytes, data]))),
  ]);
}

function rgbaPng(
  width: number,
  height: number,
  pixels: Uint8Array,
): Uint8Array {
  const header = new Uint8Array(13);
  header.set(uint32(width), 0);
  header.set(uint32(height), 4);
  header[8] = 8;
  header[9] = 6;
  const rows = new Uint8Array(height * (width * 4 + 1));
  for (let y = 0; y < height; y += 1) {
    rows.set(
      pixels.subarray(y * width * 4, (y + 1) * width * 4),
      y * (width * 4 + 1) + 1,
    );
  }
  return joined([
    new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", zlibSync(rows)),
    pngChunk("IEND", new Uint8Array()),
  ]);
}

describe("bounded logo relief conversion", () => {
  it("rasterizes and tightly crops a safe SVG silhouette deterministically", () => {
    const source = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 10"><path fill="#123456" d="M 2 1 H 18 V 9 H 2 Z"/></svg>',
    );

    const first = convertLogoToPrintRelief(source, "svg");
    const second = convertLogoToPrintRelief(source, "svg");

    expect(first).toEqual(second);
    expect(first.version).toBe("codecity.logo-relief/1");
    expect(first.width).toBeLessThanOrEqual(64);
    expect(first.height).toBeLessThanOrEqual(64);
    expect(first.mask).toMatch(/^[A-Za-z0-9_-]+$/u);
  });

  it("inherits one opaque group fill and ignores explicitly empty shapes", () => {
    const source = new TextEncoder().encode(
      '<svg viewBox="0 0 2 1"><g fill="#abc"><rect width="1" height="1"/><rect x="1" width="1" height="1" fill="none"/></g></svg>',
    );

    const relief = convertLogoToPrintRelief(source, "svg");

    expect(relief.width).toBe(32);
    expect(relief.height).toBe(32);
  });

  it("decodes PNG filters and accepts only one opaque silhouette color", () => {
    const png = rgbaPng(
      2,
      2,
      new Uint8Array([
        0, 0, 0, 0,
        255, 0, 0, 255,
        255, 0, 0, 255,
        255, 0, 0, 255,
      ]),
    );

    expect(convertLogoToPrintRelief(png, "png")).toEqual({
      version: "codecity.logo-relief/1",
      width: 2,
      height: 2,
      mask: "cA",
    });
  });

  it.each([
    '<!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///secret">]><svg viewBox="0 0 1 1"><path d="M0 0H1V1H0Z"/></svg>',
    '<svg viewBox="0 0 1 1"><script>alert(1)</script><path d="M0 0H1V1H0Z"/></svg>',
    '<svg viewBox="0 0 1 1"><image href="https://example.test/a.png"/></svg>',
    '<svg viewBox="0 0 1 1"><rect width="1" height="1" onload="alert(1)"/></svg>',
    '<svg viewBox="0 0 1 1"><rect width="1" height="1" fill="url(#paint)"/></svg>',
    '<svg viewBox="0 0 1 1"><text>secret</text></svg>',
    '<svg viewBox="0 0 1 1"><path transform="scale(2)" d="M0 0H1V1H0Z"/></svg>',
    '<svg viewBox="0 0 1 1"><rect width="1" height="1" rx=".2"/></svg>',
    '<svg viewBox="0 0 1 1"><rect width="1" height="1" fill="#12345600"/></svg>',
    '<svg viewBox="0 0 1 1"><rect width="1" height="1" fill="transparent"/></svg>',
    '<svg viewBox="0 0 1 1"><g><rect width="1" height="1"/></svg></g>',
  ])("rejects malicious or unsupported SVG without reflecting it", (source) => {
    expect(() =>
      convertLogoToPrintRelief(
        new TextEncoder().encode(source),
        "svg",
      ),
    ).toThrow(/^Logo relief conversion rejected:/u);
  });

  it("enforces the aggregate SVG point limit across elements", () => {
    const circles = Array.from(
      { length: 129 },
      () => '<circle cx=".5" cy=".5" r=".4"/>',
    ).join("");

    expect(() =>
      convertLogoToPrintRelief(
        new TextEncoder().encode(
          `<svg viewBox="0 0 1 1">${circles}</svg>`,
        ),
        "svg",
      ),
    ).toThrow(/point limit/u);
  });

  it("rejects PNG CRC corruption and non-solid pixels", () => {
    const corrupted = rgbaPng(
      1,
      1,
      new Uint8Array([255, 0, 0, 255]),
    );
    corrupted[corrupted.length - 5] =
      corrupted[corrupted.length - 5]! ^ 1;
    expect(() => convertLogoToPrintRelief(corrupted, "png")).toThrow(
      /CRC|end chunk/u,
    );

    const multicolor = rgbaPng(
      2,
      1,
      new Uint8Array([
        255, 0, 0, 255,
        0, 0, 255, 255,
      ]),
    );
    expect(() => convertLogoToPrintRelief(multicolor, "png")).toThrow(
      /one solid silhouette color/u,
    );
  });

  it("reads exactly one bounded file below an explicit root", async () => {
    const root = await temporaryDirectory();
    await fs.mkdir(path.join(root, "assets"));
    const source = new TextEncoder().encode(
      '<svg viewBox="0 0 1 1"><rect width="1" height="1"/></svg>',
    );
    await fs.writeFile(path.join(root, "assets", "logo.svg"), source);
    const converted: Uint8Array[] = [];
    const controller = new AbortController();
    let observedTimeout = 0;
    let observedSignal: AbortSignal | undefined;

    const result = await acquireLocalLogoPrintRelief(
      [root],
      "assets/logo.svg",
      {
        signal: controller.signal,
        dependencies: {
          convert: async (bytes, format, timeoutMs, signal) => {
            converted.push(bytes);
            observedTimeout = timeoutMs;
            observedSignal = signal;
            return convertLogoToPrintRelief(bytes, format);
          },
        },
      },
    );

    expect(result.warning).toBeUndefined();
    expect(result.relief).toBeDefined();
    expect(converted).toHaveLength(1);
    expect(converted[0]).toEqual(source);
    expect(observedTimeout).toBe(5_000);
    expect(observedSignal).toBe(controller.signal);
  });

  it("terminates an unresponsive worker at the bounded deadline", async () => {
    const root = await temporaryDirectory();
    await fs.writeFile(
      path.join(root, "logo.svg"),
      '<svg viewBox="0 0 1 1"><rect width="1" height="1"/></svg>',
    );
    let posts = 0;
    let terminations = 0;
    const worker = {
      once: () => worker,
      postMessage: () => {
        posts += 1;
      },
      terminate: async () => {
        terminations += 1;
        return 0;
      },
    } as unknown as LogoReliefWorker;

    const result = await acquireLocalLogoPrintRelief(
      [root],
      "logo.svg",
      {
        timeoutMs: 5,
        dependencies: {
          createWorker: () => worker,
        },
      },
    );

    expect(result).toEqual({ warning: LOCAL_LOGO_RELIEF_WARNING });
    expect(posts).toBe(1);
    expect(terminations).toBe(1);
  });

  it("uses one sanitized warning for missing, ambiguous, or rejected input", async () => {
    const first = await temporaryDirectory();
    const second = await temporaryDirectory();
    for (const root of [first, second]) {
      await fs.writeFile(
        path.join(root, "logo.svg"),
        '<svg viewBox="0 0 1 1"><rect width="1" height="1"/></svg>',
      );
    }

    const ambiguous = await acquireLocalLogoPrintRelief(
      [first, second],
      "logo.svg",
    );
    const missing = await acquireLocalLogoPrintRelief(
      [first],
      "private-name.svg",
    );
    const rejected = await acquireLocalLogoPrintRelief(
      [first],
      "logo.svg",
      {
        dependencies: {
          convert: async () => {
            throw new Error("sensitive converter detail");
          },
        },
      },
    );

    expect(ambiguous).toEqual({ warning: LOCAL_LOGO_RELIEF_WARNING });
    expect(missing).toEqual({ warning: LOCAL_LOGO_RELIEF_WARNING });
    expect(rejected).toEqual({ warning: LOCAL_LOGO_RELIEF_WARNING });
    expect(JSON.stringify([ambiguous, missing, rejected])).not.toContain(
      "private-name",
    );
    expect(JSON.stringify(rejected)).not.toContain("sensitive");
  });
});
