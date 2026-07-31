import { createHash, randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

import { isImportArtifactToken } from "./import-artifacts.js";
import {
  parseSourceArtifact,
  parseSourceArtifactIndex,
  serializeSourceArtifact,
  SOURCE_ARTIFACT_MAX_BYTES,
  SOURCE_ARTIFACT_PREFIX_BYTES,
  sourceArtifactIndexLength,
  sourceArtifactPayloadBytes,
  type SourceArtifact,
  type SourceArtifactIndex,
  type SourceArtifactIndexFile,
} from "./source-artifact.js";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const SOURCE_FILE_NAME = "source.pack";
const SOURCE_STAGE_PATTERN =
  /^\.source-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/u;

export interface SourceArtifactStoreOptions {
  readonly dataDirectory: string;
}

export interface SourceArtifactMetadata {
  readonly token: string;
  readonly size: number;
  readonly sha256: string;
  readonly indexSha256: string;
  readonly lastModified: string;
}

export interface StoredSourceArtifact extends SourceArtifactMetadata {
  readonly artifact: SourceArtifact;
}

export interface StoredSourceArtifactFile extends SourceArtifactMetadata {
  readonly file: Readonly<
    SourceArtifactIndexFile & { readonly text: string }
  >;
  readonly provenance:
    SourceArtifactIndex["provenance"]["repositories"][number];
}

function errorCode(error: unknown): string | undefined {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
  )
    ? error.code
    : undefined;
}

function privateMode(mode: number, expected: number): boolean {
  return process.platform === "win32" || (mode & 0o777) === expected;
}

function samePath(left: string, right: string): boolean {
  const first = path.resolve(left);
  const second = path.resolve(right);
  return process.platform === "win32"
    ? first.toLocaleLowerCase("en-US") ===
        second.toLocaleLowerCase("en-US")
    : first === second;
}

function directChild(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative !== "" &&
    !path.isAbsolute(relative) &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !relative.includes(path.sep)
  );
}

async function directory(
  value: string,
  description: string,
): Promise<string> {
  const resolved = path.resolve(value);
  const status = await fs.lstat(resolved);
  if (
    status.isSymbolicLink() ||
    !status.isDirectory() ||
    !privateMode(status.mode, DIRECTORY_MODE)
  ) {
    throw new Error(`${description} must be a private regular directory.`);
  }
  const canonical = await fs.realpath(resolved);
  // Windows realpath expands legitimate 8.3 path components (including the
  // runner's temporary directory). The direct lstat above still rejects a
  // reparse point at this directory entry, while the server's shared data
  // directory guard is responsible for its trusted ancestry.
  if (process.platform !== "win32" && !samePath(canonical, resolved)) {
    throw new Error(`${description} must not resolve through a link.`);
  }
  return canonical;
}

async function ensureChild(
  parent: string,
  name: string,
  description: string,
): Promise<string> {
  const candidate = path.join(parent, name);
  try {
    await fs.mkdir(candidate, { mode: DIRECTORY_MODE });
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
  try {
    await fs.chmod(candidate, DIRECTORY_MODE);
  } catch (error) {
    if (process.platform !== "win32") throw error;
  }
  const canonical = await directory(candidate, description);
  if (!directChild(parent, canonical)) {
    throw new Error(`${description} escaped its private parent.`);
  }
  return canonical;
}

async function syncDirectory(directoryPath: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await fs.open(directoryPath, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function token(value: string): string {
  if (!isImportArtifactToken(value)) {
    throw new TypeError("Source artifact token must be a lowercase UUIDv4.");
  }
  return value;
}

async function existingTokenDirectory(
  parent: string,
  value: string,
): Promise<string | undefined> {
  const candidate = path.join(parent, token(value));
  let status;
  try {
    status = await fs.lstat(candidate);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw new Error("Source artifact directory is invalid.");
  }
  const canonical = await fs.realpath(candidate);
  if (!directChild(parent, canonical) || !samePath(candidate, canonical)) {
    throw new Error("Source artifact directory escaped its private parent.");
  }
  return directory(canonical, "Source artifact directory");
}

async function openSourceFile(
  directoryPath: string,
): Promise<
  | {
      readonly handle: FileHandle;
      readonly size: number;
      readonly mtimeMs: number;
      readonly device: number;
      readonly inode: number;
      readonly canonicalPath: string;
    }
  | undefined
> {
  const filePath = path.join(directoryPath, SOURCE_FILE_NAME);
  let before;
  try {
    before = await fs.lstat(filePath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    before.nlink !== 1 ||
    before.size < SOURCE_ARTIFACT_PREFIX_BYTES + 2 ||
    before.size > SOURCE_ARTIFACT_MAX_BYTES ||
    !privateMode(before.mode, FILE_MODE)
  ) {
    throw new Error("Source artifact must be one private regular file.");
  }
  const canonicalPath = await fs.realpath(filePath);
  if (
    !samePath(canonicalPath, filePath) ||
    !directChild(directoryPath, canonicalPath)
  ) {
    throw new Error("Source artifact escaped its private directory.");
  }
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(
      filePath,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size ||
      !privateMode(opened.mode, FILE_MODE)
    ) {
      throw new Error("Source artifact changed while it was opened.");
    }
    return {
      handle,
      size: opened.size,
      mtimeMs: opened.mtimeMs,
      device: opened.dev,
      inode: opened.ino,
      canonicalPath,
    };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    throw error;
  }
}

async function readOpened(
  opened: NonNullable<Awaited<ReturnType<typeof openSourceFile>>>,
  signal?: AbortSignal,
): Promise<Buffer> {
  const bytes = await readExact(
    opened.handle,
    0,
    opened.size,
    signal,
  );
  await assertOpenedUnchanged(opened);
  return bytes;
}

async function readExact(
  handle: FileHandle,
  position: number,
  length: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  const bytes = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < bytes.byteLength) {
    signal?.throwIfAborted();
    const result = await handle.read(
      bytes,
      offset,
      Math.min(64 * 1024, bytes.byteLength - offset),
      position + offset,
    );
    if (result.bytesRead === 0) {
      throw new Error("Source artifact is truncated.");
    }
    offset += result.bytesRead;
  }
  return bytes;
}

async function assertOpenedUnchanged(
  opened: NonNullable<Awaited<ReturnType<typeof openSourceFile>>>,
): Promise<void> {
  const after = await opened.handle.stat();
  const canonicalAfter = await fs.realpath(opened.canonicalPath);
  if (
    after.dev !== opened.device ||
    after.ino !== opened.inode ||
    after.size !== opened.size ||
    !samePath(canonicalAfter, opened.canonicalPath)
  ) {
    throw new Error("Source artifact changed while it was read.");
  }
}

async function readIndex(
  opened: NonNullable<Awaited<ReturnType<typeof openSourceFile>>>,
  signal?: AbortSignal,
): Promise<{
  readonly prefix: Buffer;
  readonly bytes: Buffer;
  readonly index: SourceArtifactIndex;
  readonly payloadOffset: number;
}> {
  const prefix = await readExact(
    opened.handle,
    0,
    SOURCE_ARTIFACT_PREFIX_BYTES,
    signal,
  );
  const length = sourceArtifactIndexLength(prefix);
  const payloadOffset = SOURCE_ARTIFACT_PREFIX_BYTES + length;
  if (payloadOffset > opened.size) {
    throw new Error("Source artifact index is truncated.");
  }
  const bytes = await readExact(
    opened.handle,
    SOURCE_ARTIFACT_PREFIX_BYTES,
    length,
    signal,
  );
  const index = parseSourceArtifactIndex(bytes);
  if (
    payloadOffset + sourceArtifactPayloadBytes(index) !== opened.size
  ) {
    throw new Error("Source artifact payload bounds are invalid.");
  }
  return { prefix, bytes, index, payloadOffset };
}

function metadata(
  value: string,
  bytes: Uint8Array,
  mtimeMs: number,
): SourceArtifactMetadata {
  const indexLength = sourceArtifactIndexLength(
    bytes.subarray(0, SOURCE_ARTIFACT_PREFIX_BYTES),
  );
  return Object.freeze({
    token: value,
    size: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    indexSha256: createHash("sha256")
      .update(
        bytes.subarray(
          SOURCE_ARTIFACT_PREFIX_BYTES,
          SOURCE_ARTIFACT_PREFIX_BYTES + indexLength,
        ),
      )
      .digest("hex"),
    lastModified: new Date(mtimeMs).toUTCString(),
  });
}

export class SourceArtifactStore {
  readonly #sourcesDirectory: string;
  readonly #mutations = new Set<string>();

  private constructor(sourcesDirectory: string) {
    this.#sourcesDirectory = sourcesDirectory;
  }

  public static async open(
    options: SourceArtifactStoreOptions,
  ): Promise<SourceArtifactStore> {
    const dataDirectory = await directory(
      options.dataDirectory,
      "Code City data directory",
    );
    const sourcesDirectory = await ensureChild(
      dataDirectory,
      "sources",
      "Source artifacts directory",
    );
    const store = new SourceArtifactStore(sourcesDirectory);
    await store.recoverStages();
    return store;
  }

  public async publish(
    value: string,
    artifact: SourceArtifact,
  ): Promise<SourceArtifactMetadata> {
    const normalized = token(value);
    if (this.#mutations.has(normalized)) {
      throw new Error("A source artifact mutation is already active.");
    }
    this.#mutations.add(normalized);
    let artifactDirectory: string | undefined;
    let stagePath: string | undefined;
    let stageIdentity:
      | { readonly device: number; readonly inode: number }
      | undefined;
    let destinationLinked = false;
    let handle: FileHandle | undefined;
    try {
      artifactDirectory = await ensureChild(
        this.#sourcesDirectory,
        normalized,
        "Source artifact directory",
      );
      const destination = path.join(
        artifactDirectory,
        SOURCE_FILE_NAME,
      );
      try {
        await fs.lstat(destination);
        throw new Error("Source artifact already exists.");
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
      }
      const bytes = serializeSourceArtifact(artifact);
      stagePath = path.join(
        artifactDirectory,
        `.source-${randomUUID()}.tmp`,
      );
      handle = await fs.open(
        stagePath,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          (constants.O_NOFOLLOW ?? 0),
        FILE_MODE,
      );
      await handle.writeFile(bytes);
      try {
        await handle.chmod(FILE_MODE);
      } catch (error) {
        if (process.platform !== "win32") throw error;
      }
      await handle.sync();
      const staged = await handle.stat();
      if (
        !staged.isFile() ||
        staged.nlink !== 1 ||
        staged.size !== bytes.byteLength ||
        !privateMode(staged.mode, FILE_MODE) ||
        (staged.dev === 0 && staged.ino === 0)
      ) {
        throw new Error("Staged source artifact failed its policy.");
      }
      stageIdentity = { device: staged.dev, inode: staged.ino };
      await handle.close();
      handle = undefined;
      await syncDirectory(artifactDirectory);
      await fs.link(stagePath, destination);
      destinationLinked = true;
      await syncDirectory(artifactDirectory);
      const opened = await openSourceFileWithLinks(artifactDirectory, 2);
      if (
        opened === undefined ||
        opened.device !== staged.dev ||
        opened.inode !== staged.ino ||
        opened.size !== bytes.byteLength
      ) {
        await opened?.handle.close();
        throw new Error("Published source artifact identity is invalid.");
      }
      await opened.handle.close();
      await fs.unlink(stagePath);
      stagePath = undefined;
      destinationLinked = false;
      await syncDirectory(artifactDirectory);
      const published = await openSourceFile(artifactDirectory);
      if (published === undefined) {
        throw new Error("Published source artifact is missing.");
      }
      try {
        return metadata(normalized, bytes, published.mtimeMs);
      } finally {
        await published.handle.close();
      }
    } catch (error) {
      if (
        destinationLinked &&
        artifactDirectory !== undefined &&
        stageIdentity !== undefined
      ) {
        const destination = path.join(
          artifactDirectory,
          SOURCE_FILE_NAME,
        );
        const status = await fs.lstat(destination).catch(() => undefined);
        if (
          status?.dev === stageIdentity.device &&
          status.ino === stageIdentity.inode
        ) {
          await fs.unlink(destination).catch(() => undefined);
        }
      }
      throw error;
    } finally {
      this.#mutations.delete(normalized);
      await handle?.close().catch(() => undefined);
      if (stagePath !== undefined && stageIdentity !== undefined) {
        const status = await fs.lstat(stagePath).catch(() => undefined);
        if (
          status?.dev === stageIdentity.device &&
          status.ino === stageIdentity.inode
        ) {
          await fs.unlink(stagePath).catch(() => undefined);
        }
      }
    }
  }

  public async read(
    value: string,
    signal?: AbortSignal,
  ): Promise<StoredSourceArtifact | undefined> {
    const normalized = token(value);
    const artifactDirectory = await existingTokenDirectory(
      this.#sourcesDirectory,
      normalized,
    );
    if (artifactDirectory === undefined) return undefined;
    const opened = await openSourceFile(artifactDirectory);
    if (opened === undefined) return undefined;
    try {
      const bytes = await readOpened(opened, signal);
      return Object.freeze({
        ...metadata(normalized, bytes, opened.mtimeMs),
        artifact: parseSourceArtifact(bytes),
      });
    } finally {
      await opened.handle.close();
    }
  }

  public async readFile(
    value: string,
    buildingId: string,
    expected: Pick<
      SourceArtifactMetadata,
      "indexSha256" | "sha256" | "size"
    >,
    signal?: AbortSignal,
  ): Promise<StoredSourceArtifactFile | undefined> {
    const normalized = token(value);
    const artifactDirectory = await existingTokenDirectory(
      this.#sourcesDirectory,
      normalized,
    );
    if (artifactDirectory === undefined) return undefined;
    const opened = await openSourceFile(artifactDirectory);
    if (opened === undefined) return undefined;
    try {
      if (opened.size !== expected.size) return undefined;
      const indexed = await readIndex(opened, signal);
      if (
        createHash("sha256").update(indexed.bytes).digest("hex") !==
        expected.indexSha256
      ) {
        throw new Error("Source artifact index digest is invalid.");
      }
      const file = indexed.index.files.find(
        (candidate) => candidate.buildingId === buildingId,
      );
      if (file === undefined) return undefined;
      const provenance = indexed.index.provenance.repositories.find(
        ({ repositoryId }) => repositoryId === file.repositoryId,
      );
      if (provenance === undefined) {
        throw new Error("Source artifact provenance is invalid.");
      }
      const bytes = await readExact(
        opened.handle,
        indexed.payloadOffset + file.offset,
        file.size,
        signal,
      );
      if (
        createHash("sha256").update(bytes).digest("hex") !== file.sha256
      ) {
        throw new Error("Selected source file digest is invalid.");
      }
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new Error("Selected source file is not valid UTF-8.");
      }
      if (
        Math.max(1, text.split(/\r\n?|\n/u).length) !==
        file.location.endLine
      ) {
        throw new Error("Selected source file line bounds are invalid.");
      }
      await assertOpenedUnchanged(opened);
      return Object.freeze({
        token: normalized,
        size: opened.size,
        sha256: expected.sha256,
        indexSha256: expected.indexSha256,
        lastModified: new Date(opened.mtimeMs).toUTCString(),
        file: Object.freeze({ ...file, text }),
        provenance,
      });
    } finally {
      await opened.handle.close();
    }
  }

  private async verify(
    value: string,
    signal?: AbortSignal,
  ): Promise<SourceArtifactMetadata | undefined> {
    const normalized = token(value);
    const artifactDirectory = await existingTokenDirectory(
      this.#sourcesDirectory,
      normalized,
    );
    if (artifactDirectory === undefined) return undefined;
    const opened = await openSourceFile(artifactDirectory);
    if (opened === undefined) return undefined;
    try {
      const indexed = await readIndex(opened, signal);
      const overall = createHash("sha256")
        .update(indexed.prefix)
        .update(indexed.bytes);
      for (const file of indexed.index.files) {
        const digest = createHash("sha256");
        let offset = 0;
        while (offset < file.size) {
          signal?.throwIfAborted();
          const bytes = await readExact(
            opened.handle,
            indexed.payloadOffset + file.offset + offset,
            Math.min(64 * 1024, file.size - offset),
            signal,
          );
          digest.update(bytes);
          overall.update(bytes);
          offset += bytes.byteLength;
        }
        if (digest.digest("hex") !== file.sha256) {
          throw new Error("Retained source file digest is invalid.");
        }
      }
      await assertOpenedUnchanged(opened);
      return Object.freeze({
        token: normalized,
        size: opened.size,
        sha256: overall.digest("hex"),
        indexSha256: createHash("sha256")
          .update(indexed.bytes)
          .digest("hex"),
        lastModified: new Date(opened.mtimeMs).toUTCString(),
      });
    } finally {
      await opened.handle.close();
    }
  }

  public async cleanup(value: string): Promise<void> {
    const normalized = token(value);
    if (this.#mutations.has(normalized)) {
      throw new Error("Source artifact mutation is active.");
    }
    this.#mutations.add(normalized);
    try {
      const artifactDirectory = await existingTokenDirectory(
        this.#sourcesDirectory,
        normalized,
      );
      if (artifactDirectory === undefined) return;
      await fs.rm(artifactDirectory, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
      await syncDirectory(this.#sourcesDirectory);
    } finally {
      this.#mutations.delete(normalized);
    }
  }

  public async reconcile(
    retained: ReadonlyMap<string, SourceArtifactMetadata | undefined>,
  ): Promise<void> {
    const entries = await fs.readdir(this.#sourcesDirectory, {
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (!isImportArtifactToken(entry.name) || !entry.isDirectory()) {
        throw new Error("Source artifacts directory contains unknown data.");
      }
      if (!retained.has(entry.name)) {
        await this.cleanup(entry.name);
      }
    }
    for (const [retainedToken, expected] of retained) {
      token(retainedToken);
      if (expected === undefined) {
        await this.cleanup(retainedToken);
        continue;
      }
      const stored = await this.verify(retainedToken);
      if (
        stored === undefined ||
        stored.size !== expected.size ||
        stored.sha256 !== expected.sha256 ||
        stored.indexSha256 !== expected.indexSha256
      ) {
        throw new Error(
          "A completed import references a missing or mismatched source artifact.",
        );
      }
    }
  }

  private async recoverStages(): Promise<void> {
    const entries = await fs.readdir(this.#sourcesDirectory, {
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (!isImportArtifactToken(entry.name) || !entry.isDirectory()) {
        throw new Error("Source artifacts directory contains unknown data.");
      }
      const artifactDirectory = await existingTokenDirectory(
        this.#sourcesDirectory,
        entry.name,
      );
      if (artifactDirectory === undefined) continue;
      const names = await fs.readdir(artifactDirectory);
      for (const name of names) {
        if (SOURCE_STAGE_PATTERN.test(name)) {
          await fs.unlink(path.join(artifactDirectory, name));
        } else if (name !== SOURCE_FILE_NAME) {
          throw new Error("Source artifact directory contains unknown data.");
        }
      }
    }
  }
}

async function openSourceFileWithLinks(
  directoryPath: string,
  expectedLinks: number,
): ReturnType<typeof openSourceFile> {
  const filePath = path.join(directoryPath, SOURCE_FILE_NAME);
  let before;
  try {
    before = await fs.lstat(filePath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    before.nlink !== expectedLinks ||
    !privateMode(before.mode, FILE_MODE)
  ) {
    throw new Error("Source artifact link state is invalid.");
  }
  const handle = await fs.open(
    filePath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  const opened = await handle.stat();
  if (
    opened.dev !== before.dev ||
    opened.ino !== before.ino ||
    opened.nlink !== expectedLinks
  ) {
    await handle.close();
    throw new Error("Source artifact changed during publication.");
  }
  return {
    handle,
    size: opened.size,
    mtimeMs: opened.mtimeMs,
    device: opened.dev,
    inode: opened.ino,
    canonicalPath: await fs.realpath(filePath),
  };
}
