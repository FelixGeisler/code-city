import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";

import {
  openZipSnapshotSource,
  ZipSnapshotValidationError,
} from "../packages/analyzer/src/zip-snapshot-source.js";
import {
  materializeRepositorySnapshot,
  SnapshotDeadlineError,
  type SnapshotFileSourceEntry,
  type SnapshotSourceEntry,
} from "../packages/analyzer/src/snapshot.js";

const CENTRAL_FILE_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface ZipHeaders {
  readonly central: number;
  readonly local: number;
  readonly data: number;
  readonly compressedSize: number;
}

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function endOfCentralDirectory(bytes: Uint8Array): number {
  const view = viewOf(bytes);
  for (let offset = bytes.byteLength - 22; offset >= 0; offset -= 1) {
    if (
      view.getUint32(offset, true) === EOCD_SIGNATURE &&
      offset + 22 + view.getUint16(offset + 20, true) === bytes.byteLength
    ) {
      return offset;
    }
  }
  throw new Error("Test ZIP is missing its EOCD record.");
}

function headersFor(bytes: Uint8Array, name: string): ZipHeaders {
  const view = viewOf(bytes);
  const eocd = endOfCentralDirectory(bytes);
  const count = view.getUint16(eocd + 10, true);
  let central = view.getUint32(eocd + 16, true);
  for (let index = 0; index < count; index += 1) {
    if (view.getUint32(central, true) !== CENTRAL_FILE_SIGNATURE) {
      throw new Error("Test ZIP central directory is malformed.");
    }
    const nameLength = view.getUint16(central + 28, true);
    const extraLength = view.getUint16(central + 30, true);
    const commentLength = view.getUint16(central + 32, true);
    const entryName = decoder.decode(
      bytes.subarray(central + 46, central + 46 + nameLength),
    );
    if (entryName === name) {
      const local = view.getUint32(central + 42, true);
      const localNameLength = view.getUint16(local + 26, true);
      const localExtraLength = view.getUint16(local + 28, true);
      return {
        central,
        local,
        data: local + 30 + localNameLength + localExtraLength,
        compressedSize: view.getUint32(central + 20, true),
      };
    }
    central += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`Test ZIP entry ${name} was not found.`);
}

function copyAndPatch(
  archive: Uint8Array,
  patch: (bytes: Uint8Array, view: DataView) => void,
): Uint8Array {
  const copy = archive.slice();
  patch(copy, viewOf(copy));
  return copy;
}

function wrongCrc(archive: Uint8Array, name: string): Uint8Array {
  return copyAndPatch(archive, (bytes, view) => {
    const headers = headersFor(bytes, name);
    const crc = (view.getUint32(headers.central + 16, true) + 1) >>> 0;
    view.setUint32(headers.central + 16, crc, true);
    view.setUint32(headers.local + 14, crc, true);
  });
}

function expectInvalid(open: () => unknown): void {
  expect(open).toThrow(ZipSnapshotValidationError);
}

describe("ZIP snapshot source", () => {
  it("supports an explicit repository-relative archive root without guessing", async () => {
    const archive = zipSync({
      "src/main.ts": strToU8("export const value = 1;\n"),
      "package.json": strToU8('{"name":"example"}\n'),
    });
    const source = openZipSnapshotSource(archive, "Example", {
      rootMode: "archive-root",
    });
    try {
      const snapshot = await materializeRepositorySnapshot(source);
      expect(snapshot.files.map(({ path }) => path)).toEqual([
        "package.json",
        "src/main.ts",
      ]);
    } finally {
      source.dispose();
    }
    expect(() =>
      openZipSnapshotSource(archive, "Example", {
        rootMode: "single-directory",
      }),
    ).toThrow(ZipSnapshotValidationError);
    expect(() =>
      openZipSnapshotSource(archive, "Example", {
        rootMode: "invalid" as "archive-root",
      }),
    ).toThrow(TypeError);
  });

  it("strips one common root and materializes stored and deflated files deterministically", async () => {
    const first = zipSync(
      {
        "Repo-sha/src/z.ts": strToU8("export const z = 1;\n"),
        "Repo-sha/App.csproj": strToU8("<Project />\n"),
        "Repo-sha/src/a.ts": strToU8("export const a = 1;\n"),
      },
      { level: 0 },
    );
    const second = zipSync(
      {
        "Repo-sha/src/a.ts": strToU8("export const a = 1;\n"),
        "Repo-sha/App.csproj": strToU8("<Project />\n"),
        "Repo-sha/src/z.ts": strToU8("export const z = 1;\n"),
      },
      { level: 6 },
    );

    const firstSource = openZipSnapshotSource(first, "Example");
    const secondSource = openZipSnapshotSource(second, "Example");
    try {
      const firstSnapshot =
        await materializeRepositorySnapshot(firstSource);
      const secondSnapshot =
        await materializeRepositorySnapshot(secondSource);

      expect(secondSnapshot).toEqual(firstSnapshot);
      expect(firstSnapshot.files.map(({ path }) => path)).toEqual([
        "App.csproj",
        "src/a.ts",
        "src/z.ts",
      ]);
      expect(
        firstSnapshot.files.every(({ path }) => !path.startsWith("Repo-sha/")),
      ).toBe(true);
    } finally {
      firstSource.dispose();
      secondSource.dispose();
    }
  });

  it("inflates only requested files and emits bounded copied chunks", async () => {
    const ignoredText = "ignored content ".repeat(8_000);
    const archive = wrongCrc(
      zipSync(
        {
          "Repo-sha/.gitignore": strToU8("ignored.ts\n"),
          "Repo-sha/ignored.ts": strToU8(ignoredText),
          "Repo-sha/src/large.ts": strToU8("0123456789".repeat(30_000)),
        },
        { level: 6 },
      ),
      "Repo-sha/ignored.ts",
    );
    const source = openZipSnapshotSource(archive, "Example");
    try {
      const snapshot = await materializeRepositorySnapshot(source, {
        maxFileBytes: 400_000,
      });
      expect(snapshot.files.map(({ path }) => path)).toEqual([
        "src/large.ts",
      ]);

      const chunkSource = openZipSnapshotSource(
        zipSync(
          {
            "Repo-sha/src/large.ts": strToU8(
              "0123456789".repeat(30_000),
            ),
          },
          { level: 6 },
        ),
        "Example",
      );
      try {
        const chunkEntries: SnapshotSourceEntry[] = [];
        for await (const entry of chunkSource.entries()) {
          chunkEntries.push(entry);
        }
        const file = chunkEntries[0] as SnapshotFileSourceEntry;
        const chunks: Uint8Array[] = [];
        for await (const chunk of file.chunks()) chunks.push(chunk);
        expect(chunks.length).toBeGreaterThan(1);
        expect(
          chunks.every(({ byteLength }) => byteLength <= 64 * 1024),
        ).toBe(true);
        expect(
          decoder.decode(
            Uint8Array.from(chunks.flatMap((chunk) => [...chunk])),
          ),
        ).toBe("0123456789".repeat(30_000));
      } finally {
        chunkSource.dispose();
      }
    } finally {
      source.dispose();
    }
  });

  it("keeps CRC and actual-size validation lazy but fatal", async () => {
    const original = zipSync(
      {
        "Repo-sha/main.ts": strToU8("export const main = true;\n"),
      },
      { level: 6 },
    );
    const crcSource = openZipSnapshotSource(
      wrongCrc(original, "Repo-sha/main.ts"),
      "Example",
    );
    try {
      await expect(
        materializeRepositorySnapshot(crcSource),
      ).rejects.toBeInstanceOf(ZipSnapshotValidationError);
    } finally {
      crcSource.dispose();
    }

    const wrongSize = copyAndPatch(original, (bytes, view) => {
      const headers = headersFor(bytes, "Repo-sha/main.ts");
      const actual = view.getUint32(headers.central + 24, true);
      view.setUint32(headers.central + 24, actual + 1, true);
      view.setUint32(headers.local + 22, actual + 1, true);
    });
    const sizeSource = openZipSnapshotSource(wrongSize, "Example");
    try {
      await expect(
        materializeRepositorySnapshot(sizeSource),
      ).rejects.toBeInstanceOf(ZipSnapshotValidationError);
    } finally {
      sizeSource.dispose();
    }
  });

  it("classifies Unix symlinks without inflating them or their descendants", async () => {
    const archive = wrongCrc(
      zipSync({
        "Repo-sha/link": [
          strToU8("private-target"),
          { os: 3, attrs: (0o120777 << 16) >>> 0 },
        ],
        "Repo-sha/safe.ts": strToU8("safe"),
      }),
      "Repo-sha/link",
    );
    const source = openZipSnapshotSource(archive, "Example");
    try {
      const sourceEntries: SnapshotSourceEntry[] = [];
      for await (const entry of source.entries()) sourceEntries.push(entry);
      expect(sourceEntries).toContainEqual({ kind: "symlink", path: "link" });

      const snapshot = await materializeRepositorySnapshot(source);
      expect(snapshot.files.map(({ path }) => path)).toEqual(["safe.ts"]);
      expect(snapshot.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "symlink-skipped",
          path: "link",
        }),
      );
    } finally {
      source.dispose();
    }
  });

  it("rejects traversal, multiple roots, unsafe Unicode, and portable collisions", () => {
    const archives = [
      zipSync({ "Repo-sha/../escape.ts": strToU8("escape") }),
      zipSync({
        "First/main.ts": strToU8("first"),
        "Second/main.ts": strToU8("second"),
      }),
      zipSync({ "main.ts": strToU8("missing root") }),
      zipSync({ "bad\u0001root/main.ts": strToU8("control") }),
      zipSync({
        "Repo-sha/Main.ts": strToU8("first"),
        "Repo-sha/main.ts": strToU8("second"),
      }),
      zipSync({
        "Repo-sha/Caf\u00e9.ts": strToU8("first"),
        "Repo-sha/Cafe\u0301.ts": strToU8("second"),
      }),
      zipSync({
        "Repo-sha/ancestor": strToU8("file"),
        "Repo-sha/ancestor/child.ts": strToU8("child"),
      }),
    ];

    for (const archive of archives) {
      expectInvalid(() => openZipSnapshotSource(archive, "Example"));
    }
  });

  it("rejects inconsistent headers, encryption, unsupported methods, and non-UTF-8 names", () => {
    const original = zipSync({
      "Repo-sha/caf\u00e9.ts": strToU8("source"),
    });
    const inconsistentName = copyAndPatch(original, (bytes) => {
      const { local } = headersFor(bytes, "Repo-sha/caf\u00e9.ts");
      bytes[local + 30] = bytes[local + 30]! ^ 1;
    });
    const encrypted = copyAndPatch(original, (bytes, view) => {
      const { central, local } = headersFor(
        bytes,
        "Repo-sha/caf\u00e9.ts",
      );
      view.setUint16(central + 8, view.getUint16(central + 8, true) | 1, true);
      view.setUint16(local + 6, view.getUint16(local + 6, true) | 1, true);
    });
    const unsupportedMethod = copyAndPatch(original, (bytes, view) => {
      const { central, local } = headersFor(
        bytes,
        "Repo-sha/caf\u00e9.ts",
      );
      view.setUint16(central + 10, 99, true);
      view.setUint16(local + 8, 99, true);
    });
    const missingUtf8Flag = copyAndPatch(original, (bytes, view) => {
      const { central, local } = headersFor(
        bytes,
        "Repo-sha/caf\u00e9.ts",
      );
      view.setUint16(
        central + 8,
        view.getUint16(central + 8, true) & ~(1 << 11),
        true,
      );
      view.setUint16(
        local + 6,
        view.getUint16(local + 6, true) & ~(1 << 11),
        true,
      );
    });

    for (const archive of [
      inconsistentName,
      encrypted,
      unsupportedMethod,
      missingUtf8Flag,
    ]) {
      expectInvalid(() => openZipSnapshotSource(archive, "Example"));
    }
  });

  it("rejects multidisk, ZIP64, central overlap, and local overlap metadata", () => {
    const original = zipSync(
      { "Repo-sha/main.ts": strToU8("source") },
      { level: 0 },
    );
    const multidisk = copyAndPatch(original, (bytes, view) => {
      view.setUint16(endOfCentralDirectory(bytes) + 4, 1, true);
    });
    const zip64 = copyAndPatch(original, (bytes, view) => {
      const eocd = endOfCentralDirectory(bytes);
      view.setUint16(eocd + 8, 0xffff, true);
      view.setUint16(eocd + 10, 0xffff, true);
    });
    const centralOverlap = copyAndPatch(original, (bytes, view) => {
      const { central, local, compressedSize } = headersFor(
        bytes,
        "Repo-sha/main.ts",
      );
      view.setUint32(central + 20, compressedSize + 1, true);
      view.setUint32(central + 24, compressedSize + 1, true);
      view.setUint32(local + 18, compressedSize + 1, true);
      view.setUint32(local + 22, compressedSize + 1, true);
    });
    const localOverlapBase = zipSync(
      {
        "Repo-sha/a.ts": strToU8("a"),
        "Repo-sha/b.ts": strToU8("b"),
      },
      { level: 0 },
    );
    const localOverlap = copyAndPatch(localOverlapBase, (bytes, view) => {
      const first = headersFor(bytes, "Repo-sha/a.ts");
      const second = headersFor(bytes, "Repo-sha/b.ts");
      view.setUint32(second.central + 42, first.local, true);
    });
    const oldEocd = endOfCentralDirectory(original);
    const oldView = viewOf(original);
    const oldCentral = oldView.getUint32(oldEocd + 16, true);
    const gapData = new Uint8Array(original.byteLength + 1);
    gapData.set(original.subarray(0, oldCentral), 0);
    gapData[oldCentral] = 0x41;
    gapData.set(original.subarray(oldCentral), oldCentral + 1);
    viewOf(gapData).setUint32(oldEocd + 1 + 16, oldCentral + 1, true);

    for (const archive of [
      multidisk,
      zip64,
      centralOverlap,
      localOverlap,
      gapData,
    ]) {
      expectInvalid(() => openZipSnapshotSource(archive, "Example"));
    }
  });

  it("rejects duplicate explicit roots and symlink descendants", () => {
    const duplicateRootBase = zipSync({
      "Repo-sha/": new Uint8Array(),
      "Repo-shb/": new Uint8Array(),
    });
    const duplicateRoot = copyAndPatch(
      duplicateRootBase,
      (bytes) => {
        const second = headersFor(bytes, "Repo-shb/");
        const rewritten = encoder.encode("Repo-sha/");
        bytes.set(rewritten, second.central + 46);
        bytes.set(rewritten, second.local + 30);
      },
    );
    const symlinkDescendant = zipSync({
      "Repo-sha/link": [
        strToU8("target"),
        { os: 3, attrs: (0o120777 << 16) >>> 0 },
      ],
      "Repo-sha/link/child.ts": strToU8("child"),
    });
    const caseVariedSymlinkDescendant = zipSync({
      "Repo-sha/LINK": [
        strToU8("target"),
        { os: 3, attrs: (0o120777 << 16) >>> 0 },
      ],
      "Repo-sha/link/child.ts": strToU8("child"),
    });
    const archiveRootCaseVariedFileDescendant = zipSync({
      ROOT: strToU8("file"),
      "root/child.ts": strToU8("child"),
    });

    expectInvalid(() => openZipSnapshotSource(duplicateRoot, "Example"));
    expectInvalid(() =>
      openZipSnapshotSource(symlinkDescendant, "Example"),
    );
    expectInvalid(() =>
      openZipSnapshotSource(caseVariedSymlinkDescendant, "Example"),
    );
    expectInvalid(() =>
      openZipSnapshotSource(
        archiveRootCaseVariedFileDescendant,
        "Example",
        { rootMode: "archive-root" },
      ),
    );
  });

  it("enforces archive, entry, and expanded-size caps before inflation", () => {
    const archive = zipSync({
      "Repo-sha/a.ts": strToU8("1234"),
      "Repo-sha/b.ts": strToU8("5678"),
    });

    expectInvalid(() =>
      openZipSnapshotSource(archive, "Example", {
        maxArchiveBytes: archive.byteLength - 1,
      }),
    );
    expectInvalid(() =>
      openZipSnapshotSource(archive, "Example", { maxEntries: 1 }),
    );
    expectInvalid(() =>
      openZipSnapshotSource(archive, "Example", { maxEntryBytes: 3 }),
    );
    expectInvalid(() =>
      openZipSnapshotSource(archive, "Example", { maxExpandedBytes: 7 }),
    );
    expect(() =>
      openZipSnapshotSource(archive, "Example", { maxEntries: -1 }),
    ).toThrow(RangeError);
  });

  it("honors cancellation and disposal at enumeration and extraction boundaries", async () => {
    const archive = zipSync({
      "Repo-sha/main.ts": encoder.encode("export const main = true;"),
    });
    const preAborted = new AbortController();
    preAborted.abort();
    expect(() =>
      openZipSnapshotSource(archive, "Example", {
        signal: preAborted.signal,
      }),
    ).toThrow(SnapshotDeadlineError);

    const source = openZipSnapshotSource(archive, "Example");
    const entries: SnapshotSourceEntry[] = [];
    for await (const entry of source.entries()) entries.push(entry);
    const file = entries[0] as SnapshotFileSourceEntry;
    source.dispose();

    await expect(
      source.entries()[Symbol.asyncIterator]().next(),
    ).rejects.toBeInstanceOf(ZipSnapshotValidationError);
    await expect(
      file.chunks()[Symbol.asyncIterator]().next(),
    ).rejects.toBeInstanceOf(ZipSnapshotValidationError);
  });

  it("owns archive bytes even when the caller supplies a Buffer view", async () => {
    const callerArchive = Buffer.from(
      zipSync({
        "Repo-sha/main.ts": encoder.encode("export const main = true;"),
      }),
    );
    const source = openZipSnapshotSource(callerArchive, "Example");
    callerArchive.fill(0);
    try {
      const snapshot = await materializeRepositorySnapshot(source);
      expect(snapshot.files[0]).toMatchObject({
        path: "main.ts",
        text: "export const main = true;",
      });
    } finally {
      source.dispose();
    }
  });
});
