import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export interface ArtifactPublication {
  readonly destination: string;
  readonly bytes: Uint8Array;
  /** Exact POSIX mode applied to the staged file before publication. */
  readonly mode?: number;
}

export interface ArtifactPublicationOptions {
  /**
   * Test hook invoked after every destination has been backed up and before
   * each staged artifact is published.
   */
  readonly beforePublish?: (
    artifact: ArtifactPublication,
    index: number,
  ) => Promise<void> | void;
}

interface PreparedArtifact {
  readonly artifact: ArtifactPublication;
  readonly absoluteDestination: string;
  readonly index: number;
  temporaryPath: string | undefined;
  backupPath: string | undefined;
  published: boolean;
}

interface DestinationIdentity {
  readonly canonicalPath: string;
  readonly fileIdentity?: string;
}

function errorCode(error: unknown): string | undefined {
  if (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return undefined;
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function comparisonKey(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

async function destinationIdentity(
  absoluteDestination: string,
): Promise<DestinationIdentity> {
  let link;
  try {
    link = await fs.lstat(absoluteDestination);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    const canonicalParent = await fs.realpath(
      path.dirname(absoluteDestination),
    );
    return {
      canonicalPath: path.join(
        canonicalParent,
        path.basename(absoluteDestination),
      ),
    };
  }

  if (link.isSymbolicLink()) {
    throw new Error(
      `Artifact destination '${absoluteDestination}' must not be a symbolic link.`,
    );
  }
  if (!link.isFile()) {
    throw new Error(
      `Artifact destination '${absoluteDestination}' must be a regular file path.`,
    );
  }

  // Windows file IDs routinely exceed Number.MAX_SAFE_INTEGER. BigInt stats
  // keep distinct files distinct instead of comparing rounded inode values.
  const status = await fs.stat(absoluteDestination, { bigint: true });
  if (status.nlink > 1n) {
    throw new Error(
      `Artifact destination '${absoluteDestination}' must not be a hard link.`,
    );
  }
  return {
    canonicalPath: await fs.realpath(absoluteDestination),
    ...(status.dev === 0n && status.ino === 0n
      ? {}
      : { fileIdentity: `${status.dev}:${status.ino}` }),
  };
}

async function assertDistinctDestinations(
  prepared: readonly PreparedArtifact[],
): Promise<void> {
  const canonicalPaths = new Map<string, string>();
  const fileIdentities = new Map<string, string>();
  for (const item of prepared) {
    const identity = await destinationIdentity(item.absoluteDestination);
    const canonicalKey = comparisonKey(identity.canonicalPath);
    const canonicalAlias = canonicalPaths.get(canonicalKey);
    if (canonicalAlias !== undefined) {
      throw new Error(
        `Artifact destinations '${canonicalAlias}' and '${item.absoluteDestination}' resolve to the same path.`,
      );
    }
    canonicalPaths.set(canonicalKey, item.absoluteDestination);

    if (identity.fileIdentity !== undefined) {
      const hardLinkAlias = fileIdentities.get(identity.fileIdentity);
      if (hardLinkAlias !== undefined) {
        throw new Error(
          `Artifact destinations '${hardLinkAlias}' and '${item.absoluteDestination}' refer to the same file.`,
        );
      }
      fileIdentities.set(
        identity.fileIdentity,
        item.absoluteDestination,
      );
    }
  }
}

function transactionPath(
  absoluteDestination: string,
  transactionId: string,
  index: number,
  kind: "stage" | "backup",
): string {
  return path.join(
    path.dirname(absoluteDestination),
    `.codecity-${transactionId}-${index}-${kind}`,
  );
}

async function stageArtifact(
  item: PreparedArtifact,
  transactionId: string,
): Promise<void> {
  const temporaryPath = transactionPath(
    item.absoluteDestination,
    transactionId,
    item.index,
    "stage",
  );
  item.temporaryPath = temporaryPath;
  const handle = await fs.open(
    temporaryPath,
    "wx",
    item.artifact.mode ?? 0o666,
  );
  try {
    await handle.writeFile(item.artifact.bytes);
    if (item.artifact.mode !== undefined) {
      await handle.chmod(item.artifact.mode);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function moveExistingDestinationToBackup(
  item: PreparedArtifact,
  transactionId: string,
): Promise<void> {
  try {
    await fs.lstat(item.absoluteDestination);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
  const backupPath = transactionPath(
    item.absoluteDestination,
    transactionId,
    item.index,
    "backup",
  );
  await fs.rename(item.absoluteDestination, backupPath);
  item.backupPath = backupPath;
}

async function removeIfPresent(filePath: string): Promise<void> {
  await fs.rm(filePath, { force: true });
}

async function rollback(
  prepared: readonly PreparedArtifact[],
): Promise<readonly string[]> {
  const issues: string[] = [];
  for (const item of [...prepared].reverse()) {
    if (!item.published) continue;
    try {
      await removeIfPresent(item.absoluteDestination);
      item.published = false;
    } catch (error) {
      issues.push(
        `could not remove '${item.absoluteDestination}': ${errorDetail(error)}`,
      );
    }
  }
  for (const item of [...prepared].reverse()) {
    if (item.backupPath === undefined || item.published) continue;
    const backupPath = item.backupPath;
    try {
      await fs.rename(backupPath, item.absoluteDestination);
      item.backupPath = undefined;
    } catch (error) {
      issues.push(
        `could not restore '${item.absoluteDestination}' from '${backupPath}': ${errorDetail(error)}`,
      );
    }
  }
  for (const item of prepared) {
    if (item.temporaryPath === undefined) continue;
    const temporaryPath = item.temporaryPath;
    try {
      await removeIfPresent(temporaryPath);
      item.temporaryPath = undefined;
    } catch (error) {
      issues.push(
        `could not remove staged file '${temporaryPath}': ${errorDetail(error)}`,
      );
    }
  }
  return issues;
}

async function removeBackups(
  prepared: readonly PreparedArtifact[],
): Promise<void> {
  const issues: string[] = [];
  for (const item of prepared) {
    if (item.backupPath === undefined) continue;
    const backupPath = item.backupPath;
    try {
      await removeIfPresent(backupPath);
      item.backupPath = undefined;
    } catch (error) {
      issues.push(
        `could not remove backup '${backupPath}': ${errorDetail(error)}`,
      );
    }
  }
  if (issues.length > 0) {
    throw new Error(
      `Artifacts were published, but transaction cleanup failed: ${issues.join("; ")}`,
    );
  }
}

/**
 * Publishes one or more Node.js filesystem artifacts as a rollback-capable
 * transaction. Every payload is staged before an existing destination moves.
 */
export async function publishArtifactsAtomically(
  artifacts: readonly ArtifactPublication[],
  options: ArtifactPublicationOptions = {},
): Promise<readonly string[]> {
  if (artifacts.length === 0) {
    throw new TypeError("At least one artifact is required.");
  }
  const prepared = artifacts.map(
    (artifact, index): PreparedArtifact => ({
      artifact,
      absoluteDestination: path.resolve(artifact.destination),
      index,
      temporaryPath: undefined,
      backupPath: undefined,
      published: false,
    }),
  );
  const lexicalPaths = new Set<string>();
  for (const item of prepared) {
    if (
      item.artifact.mode !== undefined &&
      (!Number.isSafeInteger(item.artifact.mode) ||
        item.artifact.mode < 0 ||
        item.artifact.mode > 0o777)
    ) {
      throw new TypeError("Artifact mode must be an integer from 0000 to 0777.");
    }
    const key = comparisonKey(item.absoluteDestination);
    if (lexicalPaths.has(key)) {
      throw new Error("Artifact destinations must use different paths.");
    }
    lexicalPaths.add(key);
  }

  await Promise.all(
    [
      ...new Set(
        prepared.map(({ absoluteDestination }) =>
          path.dirname(absoluteDestination),
        ),
      ),
    ].map((directory) => fs.mkdir(directory, { recursive: true })),
  );
  await assertDistinctDestinations(prepared);

  const transactionId = `${process.pid}-${randomUUID()}`;
  try {
    for (const item of prepared) {
      await stageArtifact(item, transactionId);
    }
    for (const item of prepared) {
      await moveExistingDestinationToBackup(item, transactionId);
    }
    for (const item of prepared) {
      await options.beforePublish?.(item.artifact, item.index);
      await fs.rename(item.temporaryPath!, item.absoluteDestination);
      item.temporaryPath = undefined;
      item.published = true;
    }
  } catch (error) {
    const rollbackIssues = await rollback(prepared);
    const rollbackDetail =
      rollbackIssues.length === 0
        ? ""
        : ` Rollback issues: ${rollbackIssues.join("; ")}`;
    throw new Error(
      `Atomic artifact publication failed: ${errorDetail(error)}${rollbackDetail}`,
      { cause: error },
    );
  }

  await removeBackups(prepared);
  return prepared.map(({ absoluteDestination }) => absoluteDestination);
}
