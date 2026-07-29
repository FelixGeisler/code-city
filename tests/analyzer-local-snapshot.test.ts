import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  materializeLocalRepositorySnapshots,
  snapshotLocalDirectory,
} from "../packages/analyzer/src/local-snapshot.js";
import { SnapshotLimitError } from "../packages/analyzer/src/snapshot.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(name = "repository"): Promise<string> {
  const parent = await fs.mkdtemp(
    path.join(os.tmpdir(), "code-city-snapshot-"),
  );
  temporaryDirectories.push(parent);
  const root = path.join(parent, name);
  await fs.mkdir(root);
  return root;
}

async function fixture(
  root: string,
  relativePath: string,
  text: string,
): Promise<void> {
  const target = path.join(root, ...relativePath.split("/"));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, text, "utf8");
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("local repository snapshots", () => {
  it("materializes analyzer inputs with local ignore rules", async () => {
    const root = await temporaryDirectory("Flow");
    await fixture(root, ".gitignore", "src/drop.ts\n");
    await fixture(root, ".codecityignore", "!src/drop.ts\nignored.ts\n");
    await fixture(root, "src/drop.ts", "export const restored = true;");
    await fixture(root, "ignored.ts", "export const ignored = true;");
    await fixture(root, "App/App.csproj", "<Project />");
    await fixture(root, "App/Program.cs", "public sealed class Program {}");
    await fixture(root, "README.md", "not retained");
    await fixture(root, "node_modules/vendor.ts", "not traversed");

    const snapshot = await snapshotLocalDirectory(root);

    expect(snapshot.name).toBe("Flow");
    expect(snapshot.files.map(({ path }) => path)).toEqual([
      "App/App.csproj",
      "App/Program.cs",
      "src/drop.ts",
    ]);
    expect(snapshot.files.every(({ text }) => !text.includes(root))).toBe(true);
  });

  it("reports symlinks without reading their targets", async () => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory("outside");
    await fixture(root, "inside.ts", "export const inside = true;");
    await fixture(outside, "secret.ts", "export const secret = true;");
    const link = path.join(root, "linked.ts");
    try {
      await fs.symlink(path.join(outside, "secret.ts"), link, "file");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES") return;
      throw error;
    }

    const snapshot = await snapshotLocalDirectory(root);

    expect(snapshot.files.map(({ path }) => path)).toEqual(["inside.ts"]);
    expect(snapshot.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "symlink-skipped",
        path: "linked.ts",
      }),
    );
    expect(JSON.stringify(snapshot)).not.toContain("secret");
    expect(JSON.stringify(snapshot)).not.toContain(outside);
  });

  it("enforces retained-file limits across all local roots", async () => {
    const first = await temporaryDirectory("A");
    const second = await temporaryDirectory("B");
    await fixture(first, "a.ts", "a");
    await fixture(second, "b.ts", "b");

    await expect(
      materializeLocalRepositorySnapshots([second, first], {
        maxRetainedFiles: 1,
      }),
    ).rejects.toBeInstanceOf(SnapshotLimitError);
  });
});
