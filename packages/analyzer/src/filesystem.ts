import { promises as fs } from "node:fs";
import path from "node:path";

const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "bin",
  "obj",
  "dist",
  "build",
  "coverage",
]);

const GENERATED_CSHARP = /\.(?:g|generated|designer)\.cs$/i;

export function portablePath(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  const withoutPrefix = normalized.replace(/^\.\/+/, "");
  return withoutPrefix === "" ? "." : withoutPrefix;
}

/**
 * Key filesystem paths according to the host's path semantics. Linux paths
 * remain case-sensitive; Windows paths are folded because the Win32 APIs used
 * by Node resolve them case-insensitively.
 */
export function filesystemKey(value: string): string {
  const resolved = portablePath(path.resolve(value));
  return process.platform === "win32"
    ? resolved.toLocaleLowerCase("en-US")
    : resolved;
}

export function compareStable(left: string, right: string): number {
  const normalizedLeft = portablePath(left);
  const normalizedRight = portablePath(right);
  const comparableLeft =
    process.platform === "win32"
      ? normalizedLeft.toLocaleLowerCase("en-US")
      : normalizedLeft;
  const comparableRight =
    process.platform === "win32"
      ? normalizedRight.toLocaleLowerCase("en-US")
      : normalizedRight;
  if (comparableLeft < comparableRight) return -1;
  if (comparableLeft > comparableRight) return 1;
  return normalizedLeft < normalizedRight
    ? -1
    : normalizedLeft > normalizedRight
      ? 1
      : 0;
}

export function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

export function repositoryRelative(root: string, absolutePath: string): string {
  const relative = path.relative(root, absolutePath);
  if (!isWithin(root, absolutePath)) {
    throw new Error(`Path escapes its analysis root: ${absolutePath}`);
  }
  return portablePath(relative);
}

export function isGeneratedCSharp(filePath: string): boolean {
  return GENERATED_CSHARP.test(filePath);
}

export function isSourceFile(filePath: string): boolean {
  const extension = path.extname(filePath).toLocaleLowerCase("en-US");
  if (![".cs", ".ts", ".tsx", ".js", ".jsx"].includes(extension)) {
    return false;
  }
  return extension !== ".cs" || !isGeneratedCSharp(filePath);
}

/**
 * Walk a root without following directory symlinks. This makes analysis bounded
 * by the explicit root and avoids cycles or accidental reads outside it.
 */
export async function walkLocalRoot(root: string): Promise<readonly string[]> {
  const files: string[] = [];

  async function visit(directory: string): Promise<void> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareStable(left.name, right.name));

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.has(entry.name.toLocaleLowerCase("en-US"))) {
          await visit(absolutePath);
        }
      } else if (entry.isFile()) {
        files.push(absolutePath);
      }
    }
  }

  await visit(root);
  return files.sort(compareStable);
}

export async function validateRoots(
  requestedRoots: readonly string[],
): Promise<readonly string[]> {
  if (requestedRoots.length === 0) {
    throw new Error("At least one local directory root is required.");
  }

  const unique = new Map<string, string>();
  for (const requestedRoot of requestedRoots) {
    const absoluteRoot = path.resolve(requestedRoot);
    let stat;
    try {
      stat = await fs.stat(absoluteRoot);
    } catch {
      throw new Error(`Analysis root does not exist: ${requestedRoot}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`Analysis root is not a directory: ${requestedRoot}`);
    }
    const canonical = await fs.realpath(absoluteRoot);
    unique.set(filesystemKey(canonical), canonical);
  }

  return [...unique.values()].sort(
    (left, right) =>
      compareStable(path.basename(left), path.basename(right)) ||
      compareStable(left, right),
  );
}
