import { constants, promises as fs } from "node:fs";
import path from "node:path";

import {
  isHardExcludedSnapshotPath,
  materializeRepositorySnapshot,
  materializeRepositorySnapshots,
  SnapshotPathError,
  type RepositorySnapshot,
  type SnapshotFileSourceEntry,
  type SnapshotOptions,
  type SnapshotSource,
  type SnapshotSourceEntry,
} from "./snapshot.js";

function compareLocalPath(left: string, right: string): number {
  const foldedLeft = left
    .normalize("NFC")
    .toLocaleLowerCase("en-US");
  const foldedRight = right
    .normalize("NFC")
    .toLocaleLowerCase("en-US");
  if (foldedLeft < foldedRight) return -1;
  if (foldedLeft > foldedRight) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

function portablePath(value: string): string {
  return value.replaceAll("\\", "/").normalize("NFC");
}

function canonicalPathKey(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === "win32"
    ? normalized.toLocaleLowerCase("en-US")
    : normalized;
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

async function* readLocalFileChunks(
  absolutePath: string,
  canonicalRoot: string,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  const beforeOpen = await fs.lstat(absolutePath);
  if (beforeOpen.isSymbolicLink() || !beforeOpen.isFile()) {
    throw new Error("Snapshot entry is no longer a regular file.");
  }
  const resolvedBefore = await fs.realpath(absolutePath);
  if (!isWithinRoot(canonicalRoot, resolvedBefore)) {
    throw new Error("Snapshot entry resolves outside its repository.");
  }
  const handle = await fs.open(
    absolutePath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("Snapshot entry is no longer a file.");
    if (stat.dev !== beforeOpen.dev || stat.ino !== beforeOpen.ino) {
      throw new Error("Snapshot entry changed while it was being opened.");
    }
    const resolvedAfter = await fs.realpath(absolutePath);
    if (
      !isWithinRoot(canonicalRoot, resolvedAfter) ||
      canonicalPathKey(resolvedAfter) !== canonicalPathKey(resolvedBefore)
    ) {
      throw new Error("Snapshot entry changed while it was being opened.");
    }
    while (true) {
      if (signal?.aborted) throw new Error("Snapshot read was aborted.");
      const buffer = new Uint8Array(64 * 1024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) break;
      yield buffer.slice(0, bytesRead);
    }
  } finally {
    await handle.close();
  }
}

function localSource(root: string): SnapshotSource {
  const absoluteRoot = path.resolve(root);
  const repositoryName =
    path.basename(absoluteRoot).normalize("NFC") || "Filesystem root";

  async function* visit(
    absoluteDirectory: string,
    relativeDirectory: string,
    canonicalRoot: string,
  ): AsyncGenerator<SnapshotSourceEntry> {
    let entries;
    try {
      const before = await fs.lstat(absoluteDirectory);
      const resolvedBefore = await fs.realpath(absoluteDirectory);
      if (
        before.isSymbolicLink() ||
        !before.isDirectory() ||
        !isWithinRoot(canonicalRoot, resolvedBefore)
      ) {
        throw new Error("Directory resolves outside its repository.");
      }
      entries = await fs.readdir(absoluteDirectory, { withFileTypes: true });
      const after = await fs.lstat(absoluteDirectory);
      const resolvedAfter = await fs.realpath(absoluteDirectory);
      if (
        after.isSymbolicLink() ||
        !after.isDirectory() ||
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        canonicalPathKey(resolvedAfter) !== canonicalPathKey(resolvedBefore)
      ) {
        throw new Error("Directory changed while it was enumerated.");
      }
    } catch {
      yield {
        kind: "unreadable",
        path: relativeDirectory || ".",
        message: "Directory could not be enumerated.",
      };
      return;
    }
    entries.sort((left, right) => compareLocalPath(left.name, right.name));

    for (const entry of entries) {
      const relativePath = portablePath(
        relativeDirectory
          ? `${relativeDirectory}/${entry.name}`
          : entry.name,
      );
      const absolutePath = path.join(absoluteDirectory, entry.name);
      let stat;
      try {
        stat = await fs.lstat(absolutePath);
      } catch {
        yield {
          kind: "unreadable",
          path: relativePath,
          message: "Entry metadata could not be read.",
        };
        continue;
      }

      if (stat.isSymbolicLink()) {
        yield { kind: "symlink", path: relativePath };
        continue;
      }
      if (stat.isDirectory()) {
        yield { kind: "directory", path: relativePath };
        if (!isHardExcludedSnapshotPath(relativePath)) {
          yield* visit(absolutePath, relativePath, canonicalRoot);
        }
        continue;
      }
      if (stat.isFile()) {
        const file: SnapshotFileSourceEntry = {
          kind: "file",
          path: relativePath,
          declaredSize: stat.size,
          chunks: (signal) =>
            readLocalFileChunks(absolutePath, canonicalRoot, signal),
        };
        yield file;
      }
    }
  }

  async function* entries(): AsyncGenerator<SnapshotSourceEntry> {
    let stat;
    try {
      stat = await fs.lstat(absoluteRoot);
    } catch {
      throw new Error("Snapshot root does not exist or is unreadable.");
    }
    if (stat.isSymbolicLink()) {
      throw new SnapshotPathError(
        "Snapshot root must not be a symbolic link.",
      );
    }
    if (!stat.isDirectory()) {
      throw new SnapshotPathError("Snapshot root must be a directory.");
    }
    const canonicalRoot = await fs.realpath(absoluteRoot);
    const verified = await fs.lstat(absoluteRoot);
    if (
      verified.isSymbolicLink() ||
      !verified.isDirectory() ||
      verified.dev !== stat.dev ||
      verified.ino !== stat.ino
    ) {
      throw new SnapshotPathError(
        "Snapshot root changed while it was being opened.",
      );
    }
    yield* visit(absoluteRoot, "", canonicalRoot);
  }

  return { repositoryName, entries };
}

export async function snapshotLocalDirectory(
  root: string,
  options: SnapshotOptions = {},
): Promise<RepositorySnapshot> {
  return materializeRepositorySnapshot(localSource(root), options);
}

export async function materializeLocalRepositorySnapshots(
  roots: readonly string[],
  options: SnapshotOptions = {},
): Promise<readonly RepositorySnapshot[]> {
  if (roots.length === 0) {
    throw new Error("At least one local directory root is required.");
  }
  const unique = new Map<string, string>();
  for (const root of roots) {
    const absolute = path.resolve(root);
    const key =
      process.platform === "win32"
        ? absolute.toLocaleLowerCase("en-US")
        : absolute;
    unique.set(key, absolute);
  }
  const sortedRoots = [...unique.values()].sort(
    (left, right) =>
      compareLocalPath(path.basename(left), path.basename(right)) ||
      compareLocalPath(left, right),
  );
  return materializeRepositorySnapshots(
    sortedRoots.map((root) => localSource(root)),
    options,
  );
}
