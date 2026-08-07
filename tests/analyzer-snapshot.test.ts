import { describe, expect, it, vi } from "vitest";

import {
  assertRepositorySnapshots,
  materializeRepositorySnapshot,
  materializeRepositorySnapshots,
  normalizeSnapshotPath,
  SnapshotDeadlineError,
  SnapshotPathError,
  type SnapshotFileSourceEntry,
  type SnapshotSource,
  type SnapshotSourceEntry,
} from "../packages/analyzer/src/snapshot.js";

const encoder = new TextEncoder();

function file(
  path: string,
  text: string | Uint8Array,
  read = vi.fn(),
  declaredSize?: number,
): SnapshotFileSourceEntry {
  const bytes = typeof text === "string" ? encoder.encode(text) : text;
  return {
    kind: "file",
    path,
    ...(declaredSize === undefined ? {} : { declaredSize }),
    chunks: async function* () {
      read();
      yield bytes;
    },
  };
}

function source(
  entries: readonly SnapshotSourceEntry[],
  repositoryName = "Example",
): SnapshotSource {
  return {
    repositoryName,
    entries: async function* () {
      yield* entries;
    },
  };
}

describe("repository snapshot materialization", () => {
  it("applies nested ignores and the root override before reading admitted files", async () => {
    const ignoredRead = vi.fn();
    const hardExcludedRead = vi.fn();
    const unrelatedRead = vi.fn();
    const entries: SnapshotSourceEntry[] = [
      file("src\\keep.ts", "export const keep = true;"),
      file("src/drop.ts", "drop", ignoredRead),
      file("src/.gitignore", "!keep.ts\n"),
      { kind: "directory", path: "src" },
      file("ignored/reincluded.ts", "export const restored = true;"),
      file("ignored/drop.ts", "drop", ignoredRead),
      file(
        ".codecityignore",
        "!ignored/\n!ignored/reincluded.ts\n!node_modules/\n!node_modules/**\n",
      ),
      file(
        ".gitignore",
        "src/*.ts\nignored/\nspace\\ .ts\n",
      ),
      file("space .ts", "drop", ignoredRead),
      file("node_modules/vendor.ts", "vendor", hardExcludedRead),
      file("notes.md", "not analyzer input", unrelatedRead),
      file("App.csproj", "<Project />"),
    ];

    const snapshot = await materializeRepositorySnapshot(source(entries));

    expect(snapshot.files.map(({ path }) => path)).toEqual([
      "App.csproj",
      "ignored/reincluded.ts",
      "src/keep.ts",
    ]);
    expect(ignoredRead).not.toHaveBeenCalled();
    expect(hardExcludedRead).not.toHaveBeenCalled();
    expect(unrelatedRead).not.toHaveBeenCalled();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.files)).toBe(true);
    expect(Object.isFrozen(snapshot.files[0])).toBe(true);
  });

  it("normalizes Windows and Unicode paths and rejects unsafe or colliding paths", async () => {
    expect(normalizeSnapshotPath("src\\Cafe\u0301.ts")).toBe("src/Café.ts");
    for (const unsafe of [
      "../outside.ts",
      "/absolute.ts",
      "C:\\absolute.ts",
      "\\\\server\\share.ts",
      "https://example.test/source.ts",
      "src/\u0000bad.ts",
    ]) {
      expect(() => normalizeSnapshotPath(unsafe), unsafe).toThrow(
        SnapshotPathError,
      );
    }

    await expect(
      materializeRepositorySnapshot(
        source([
          file("src/Café.ts", "first"),
          file("src/Cafe\u0301.ts", "second"),
        ]),
      ),
    ).rejects.toBeInstanceOf(SnapshotPathError);
    await expect(
      materializeRepositorySnapshot(
        source([file("src/Main.ts", "first"), file("src/main.ts", "second")]),
      ),
    ).rejects.toBeInstanceOf(SnapshotPathError);
    expect(() => normalizeSnapshotPath(`${"x".repeat(2_049)}.ts`)).toThrow(
      SnapshotPathError,
    );
    await expect(
      materializeRepositorySnapshot(
        source([file("safe.ts", "safe")], "r".repeat(257)),
      ),
    ).rejects.toBeInstanceOf(SnapshotPathError);
  });

  it("isolates unreadable, oversized, and binary files deterministically", async () => {
    const declaredOversizedRead = vi.fn();
    const failedRead = vi.fn();
    const entries: SnapshotSourceEntry[] = [
      file("actual.ts", "123456", vi.fn(), 2),
      file("declared.ts", "not read", declaredOversizedRead, 8),
      file("nul.ts", new Uint8Array([97, 0, 98])),
      file("utf8.ts", new Uint8Array([0xc3, 0x28])),
      {
        kind: "file",
        path: "unreadable.ts",
        chunks: async function* () {
          failedRead();
          throw new Error("private absolute path must not escape");
        },
      },
      {
        kind: "file",
        path: "sync-throw.ts",
        chunks: () => {
          throw new Error("synchronous adapter failure");
        },
      },
      file("valid.ts", "ok"),
      { kind: "symlink", path: "linked.ts" },
      {
        kind: "unreadable",
        path: "missing.ts",
        message: "adapter detail",
      },
    ];

    const first = await materializeRepositorySnapshot(source(entries), {
      maxFileBytes: 5,
    });
    const second = await materializeRepositorySnapshot(
      source([...entries].reverse()),
      { maxFileBytes: 5 },
    );

    expect(second).toEqual(first);
    expect(first.files.map(({ path }) => path)).toEqual(["valid.ts"]);
    expect(declaredOversizedRead).not.toHaveBeenCalled();
    expect(first.diagnostics.map(({ path, code }) => [path, code])).toEqual([
      ["actual.ts", "oversized"],
      ["declared.ts", "oversized"],
      ["linked.ts", "symlink-skipped"],
      ["missing.ts", "unreadable"],
      ["nul.ts", "binary"],
      ["sync-throw.ts", "unreadable"],
      ["unreadable.ts", "unreadable"],
      ["utf8.ts", "binary"],
    ]);
    expect(JSON.stringify(first.diagnostics)).not.toContain("private absolute");
  });

  it("stops a growing chunk stream at the file limit and preserves original bytes", async () => {
    let yielded = 0;
    let closed = false;
    const growing: SnapshotFileSourceEntry = {
      kind: "file",
      path: "growing.ts",
      declaredSize: 2,
      chunks: async function* () {
        try {
          yielded += 1;
          yield encoder.encode("123");
          yielded += 1;
          yield encoder.encode("45");
          yielded += 1;
          yield encoder.encode("must not be requested");
        } finally {
          closed = true;
        }
      },
    };
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, 0x61]);
    const bomOnly = new Uint8Array([0xef, 0xbb, 0xbf]);

    const snapshot = await materializeRepositorySnapshot(
      source([growing, file("bom-only.ts", bomOnly), file("bom.ts", bom)]),
      { maxFileBytes: 4 },
    );

    expect(yielded).toBe(2);
    expect(closed).toBe(true);
    expect(snapshot.files).toEqual([
      expect.objectContaining({
        path: "bom-only.ts",
        text: "",
        byteLength: 3,
      }),
      expect.objectContaining({ path: "bom.ts", text: "a", byteLength: 4 }),
    ]);
    expect(snapshot.diagnostics).toContainEqual(
      expect.objectContaining({ path: "growing.ts", code: "oversized" }),
    );
  });

  it("never reads entries enumerated below a directory symlink", async () => {
    const leakedRead = vi.fn();
    const snapshot = await materializeRepositorySnapshot(
      source([
        { kind: "symlink", path: "linked" },
        file("linked/.gitignore", "!secret.ts\n", leakedRead),
        file("linked/secret.ts", "secret", leakedRead),
        file("safe.ts", "safe"),
      ]),
    );

    expect(leakedRead).not.toHaveBeenCalled();
    expect(snapshot.files.map(({ path }) => path)).toEqual(["safe.ts"]);
    expect(snapshot.diagnostics).toContainEqual(
      expect.objectContaining({ path: "linked", code: "symlink-skipped" }),
    );
  });

  it("fails closed when an ignore policy file cannot be trusted", async () => {
    await expect(
      materializeRepositorySnapshot(
        source([
          {
            kind: "file",
            path: ".gitignore",
            chunks: async function* () {
              throw new Error("unreadable");
            },
          },
          file("main.ts", "main"),
        ]),
      ),
    ).rejects.toMatchObject({
      code: "SNAPSHOT_POLICY_REJECTED",
      path: ".gitignore",
    });

    await expect(
      materializeRepositorySnapshot(
        source([file(".codecityignore", "too large", vi.fn(), 20)]),
        { maxFileBytes: 2 },
      ),
    ).rejects.toMatchObject({
      code: "SNAPSHOT_POLICY_REJECTED",
      path: ".codecityignore",
    });

    let message = "";
    try {
      await materializeRepositorySnapshot(
        source([
          {
            kind: "unreadable",
            path: "private-name/.gitignore",
            message: "secret adapter detail",
          },
        ]),
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain("private-name");
    expect(message).not.toContain("secret adapter detail");
  });

  it("does not require ignored nested policy files to be readable", async () => {
    const snapshot = await materializeRepositorySnapshot(
      source([
        file(".gitignore", "ignored/\n"),
        { kind: "unreadable", path: "ignored/.gitignore", message: "denied" },
        { kind: "symlink", path: "ignored/deeper/.gitignore" },
        file("safe.ts", "safe"),
      ]),
    );

    expect(snapshot.files.map(({ path }) => path)).toEqual(["safe.ts"]);
    expect(snapshot.diagnostics).toEqual([]);
  });

  it("shares aggregate limits and the diagnostic cap across repositories", async () => {
    await expect(
      materializeRepositorySnapshots(
        [
          source([file("a.ts", "a")], "A"),
          source([file("b.ts", "b")], "B"),
        ],
        { maxRetainedFiles: 1 },
      ),
    ).rejects.toMatchObject({
      limitName: "retained-files",
      limit: 1,
      actual: 2,
    });

    const snapshots = await materializeRepositorySnapshots(
      [
        source(
          [
            { kind: "symlink", path: "z.ts" },
            { kind: "symlink", path: "a.ts" },
          ],
          "A",
        ),
        source([{ kind: "symlink", path: "b.ts" }], "B"),
      ],
      { maxDiagnostics: 1 },
    );
    expect(snapshots.flatMap(({ diagnostics }) => diagnostics)).toEqual([
      expect.objectContaining({ path: "a.ts", code: "symlink-skipped" }),
      expect.objectContaining({
        code: "diagnostics-omitted",
        message: "2 additional snapshot diagnostics were omitted.",
      }),
    ]);
  });

  it("admits package manifests as bounded metadata without counting source buildings", async () => {
    const manifestText = '{"name":"example"}';
    const manifestBytes = encoder.encode(manifestText).byteLength;
    const lockRead = vi.fn();
    const entries = [
      file("Package.JSON", manifestText),
      file("package-lock.json", "not admitted", lockRead),
    ];

    const snapshot = await materializeRepositorySnapshot(source(entries), {
      maxRetainedFiles: 1,
      maxSourceBuildings: 0,
      maxTotalBytes: manifestBytes,
    });

    expect(snapshot.files).toEqual([
      {
        path: "Package.JSON",
        text: manifestText,
        byteLength: manifestBytes,
      },
    ]);
    expect(lockRead).not.toHaveBeenCalled();
    await expect(
      materializeRepositorySnapshot(source(entries), {
        maxRetainedFiles: 0,
        maxSourceBuildings: 0,
      }),
    ).rejects.toMatchObject({
      limitName: "retained-files",
      limit: 0,
      actual: 1,
    });
    await expect(
      materializeRepositorySnapshot(source(entries), {
        maxSourceBuildings: 0,
        maxTotalBytes: manifestBytes - 1,
      }),
    ).rejects.toMatchObject({
      limitName: "total-bytes",
      limit: manifestBytes - 1,
      actual: manifestBytes,
    });
  });

  it("revalidates the admission contract for caller-provided snapshots", () => {
    const snapshot = (
      path: string,
      text = "source",
      diagnostics: readonly {
        code: "unreadable";
        message: string;
      }[] = [],
    ) => [
      {
        name: "Example",
        files: [{ path, text, byteLength: encoder.encode(text).byteLength }],
        diagnostics,
      },
    ];

    expect(() =>
      assertRepositorySnapshots(snapshot("node_modules/vendor.ts")),
    ).toThrow(SnapshotPathError);
    expect(() =>
      assertRepositorySnapshots(snapshot("README.md")),
    ).toThrow(SnapshotPathError);
    expect(() =>
      assertRepositorySnapshots(snapshot("Package.JSON", "{}")),
    ).not.toThrow();
    expect(() =>
      assertRepositorySnapshots(snapshot("package-lock.json", "{}")),
    ).toThrow(SnapshotPathError);
    expect(() =>
      assertRepositorySnapshots(snapshot("binary.ts", "a\u0000b")),
    ).toThrow(SnapshotPathError);
    expect(() =>
      assertRepositorySnapshots(
        snapshot("safe.ts", "safe", [
          { code: "unreadable", message: "untrusted" },
        ]),
        { maxDiagnostics: 0 },
      ),
    ).toThrowError(
      expect.objectContaining({ limitName: "diagnostics" }),
    );
  });

  it("raises typed entry, source-building, byte, and deadline failures", async () => {
    await expect(
      materializeRepositorySnapshot(
        source([
          { kind: "directory", path: "src" },
          file("src/a.ts", "a"),
        ]),
        { maxEntries: 1 },
      ),
    ).rejects.toMatchObject({ limitName: "entries" });

    await expect(
      materializeRepositorySnapshot(
        source([file("a.ts", "a"), file("angular.json", "{}")]),
        { maxSourceBuildings: 0 },
      ),
    ).rejects.toMatchObject({ limitName: "source-buildings" });

    await expect(
      materializeRepositorySnapshot(source([file("a.ts", "123")]), {
        maxTotalBytes: 2,
      }),
    ).rejects.toMatchObject({ limitName: "total-bytes" });

    await expect(
      materializeRepositorySnapshot(
        {
          repositoryName: "Slow",
          entries: () => ({
            [Symbol.asyncIterator]: () => ({
              next: () =>
                new Promise<IteratorResult<SnapshotSourceEntry>>(
                  () => undefined,
                ),
            }),
          }),
        },
        { timeoutMs: 5 },
      ),
    ).rejects.toBeInstanceOf(SnapshotDeadlineError);
  });
});
