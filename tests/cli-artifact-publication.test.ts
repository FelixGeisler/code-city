import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, it } from "vitest";

import { publishArtifactsAtomically } from "../apps/cli/src/artifact-publication.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "code-city-publication-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

async function transactionFiles(directory: string): Promise<readonly string[]> {
  return (await fs.readdir(directory)).filter((entry) =>
    entry.startsWith(".codecity-"),
  );
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

it("stages the full pair and restores previous outputs after publication failure", async () => {
  const directory = await temporaryDirectory();
  const archivePath = path.join(directory, "city.3mf");
  const legendPath = path.join(directory, "city.legend.json");
  await fs.writeFile(archivePath, "previous archive", "utf8");
  await fs.writeFile(legendPath, "previous legend", "utf8");

  await expect(
    publishArtifactsAtomically(
      [
        {
          destination: archivePath,
          bytes: Buffer.from("replacement archive"),
        },
        {
          destination: legendPath,
          bytes: Buffer.from("replacement legend"),
          mode: 0o600,
        },
      ],
      {
        beforePublish: (_artifact, index) => {
          if (index === 1) throw new Error("injected second publish failure");
        },
      },
    ),
  ).rejects.toThrow(/injected second publish failure/u);

  expect(await fs.readFile(archivePath, "utf8")).toBe("previous archive");
  expect(await fs.readFile(legendPath, "utf8")).toBe("previous legend");
  expect(await transactionFiles(directory)).toEqual([]);
});

it("publishes both staged files, removes transaction files, and protects the legend", async () => {
  const directory = await temporaryDirectory();
  const archivePath = path.join(directory, "city.3mf");
  const legendPath = path.join(directory, "city.legend.json");

  const published = await publishArtifactsAtomically([
    {
      destination: archivePath,
      bytes: Buffer.from("new archive"),
    },
    {
      destination: legendPath,
      bytes: Buffer.from("private legend"),
      mode: 0o600,
    },
  ]);

  expect(published).toEqual([
    path.resolve(archivePath),
    path.resolve(legendPath),
  ]);
  expect(await fs.readFile(archivePath, "utf8")).toBe("new archive");
  expect(await fs.readFile(legendPath, "utf8")).toBe("private legend");
  expect(await transactionFiles(directory)).toEqual([]);
  if (process.platform !== "win32") {
    const mode = (await fs.stat(legendPath)).mode & 0o777;
    expect(mode).toBe(0o600);
  }
});

it("rejects existing hard-link destinations without modifying either alias", async () => {
  const directory = await temporaryDirectory();
  const archivePath = path.join(directory, "city.3mf");
  const legendPath = path.join(directory, "city.legend.json");
  await fs.writeFile(archivePath, "shared previous content", "utf8");
  await fs.link(archivePath, legendPath);

  await expect(
    publishArtifactsAtomically([
      {
        destination: archivePath,
        bytes: Buffer.from("new archive"),
      },
      {
        destination: legendPath,
        bytes: Buffer.from("private legend"),
        mode: 0o600,
      },
    ]),
  ).rejects.toThrow(/hard link/u);

  expect(await fs.readFile(archivePath, "utf8")).toBe(
    "shared previous content",
  );
  expect(await fs.readFile(legendPath, "utf8")).toBe(
    "shared previous content",
  );
  expect(await transactionFiles(directory)).toEqual([]);
});

it("rejects destinations that become canonical aliases through a linked directory", async () => {
  const directory = await temporaryDirectory();
  const realDirectory = path.join(directory, "real");
  const aliasDirectory = path.join(directory, "alias");
  await fs.mkdir(realDirectory);
  await fs.symlink(
    realDirectory,
    aliasDirectory,
    process.platform === "win32" ? "junction" : "dir",
  );
  const realPath = path.join(realDirectory, "artifact");
  const aliasPath = path.join(aliasDirectory, "artifact");

  await expect(
    publishArtifactsAtomically([
      {
        destination: realPath,
        bytes: Buffer.from("archive"),
      },
      {
        destination: aliasPath,
        bytes: Buffer.from("legend"),
        mode: 0o600,
      },
    ]),
  ).rejects.toThrow(/resolve to the same path/u);

  await expect(fs.access(realPath)).rejects.toThrow();
  expect(await transactionFiles(realDirectory)).toEqual([]);
});

it("does not replace a protected input through a canonical directory alias", async () => {
  const directory = await temporaryDirectory();
  const realDirectory = path.join(directory, "real");
  const aliasDirectory = path.join(directory, "alias");
  await fs.mkdir(realDirectory);
  await fs.symlink(
    realDirectory,
    aliasDirectory,
    process.platform === "win32" ? "junction" : "dir",
  );
  const inputPath = path.join(realDirectory, "city.legend.json");
  const destinationPath = path.join(aliasDirectory, "city.legend.json");
  await fs.writeFile(inputPath, "source model", "utf8");

  await expect(
    publishArtifactsAtomically(
      [
        {
          destination: destinationPath,
          bytes: Buffer.from("replacement legend"),
        },
      ],
      { protectedPaths: [inputPath] },
    ),
  ).rejects.toThrow(/must not replace protected input/u);

  expect(await fs.readFile(inputPath, "utf8")).toBe("source model");
  expect(await transactionFiles(realDirectory)).toEqual([]);
});

it("rejects a symbolic-link destination without following it", async () => {
  if (process.platform === "win32") return;
  const directory = await temporaryDirectory();
  const targetPath = path.join(directory, "private-target");
  const destinationPath = path.join(directory, "city.legend.json");
  await fs.writeFile(targetPath, "private previous content", "utf8");
  await fs.symlink(targetPath, destinationPath);

  await expect(
    publishArtifactsAtomically([
      {
        destination: destinationPath,
        bytes: Buffer.from("private legend"),
        mode: 0o600,
      },
    ]),
  ).rejects.toThrow(/symbolic link/u);

  expect(await fs.readFile(targetPath, "utf8")).toBe(
    "private previous content",
  );
  expect(await transactionFiles(directory)).toEqual([]);
});
