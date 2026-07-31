import { createHash, randomUUID, type Hash } from "node:crypto";
import {
  constants,
  promises as fs,
  type BigIntStats,
} from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

import { isImportArtifactToken } from "./import-artifacts.js";
import {
  parseSourceArtifact,
  parseSourceArtifactIndex,
  prepareSourceArtifact,
  SOURCE_ARTIFACT_MAX_BYTES,
  SOURCE_ARTIFACT_PREFIX_BYTES,
  sourceArtifactIndexLength,
  sourceArtifactPayloadBytes,
  type SourceArtifact,
  type SourceArtifactIndex,
  type SourceArtifactIndexFile,
  type SourceArtifactWorkOptions,
} from "./source-artifact.js";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const STREAM_CHUNK_BYTES = 64 * 1024;
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

function privateMode(mode: bigint, expected: number): boolean {
  return (
    process.platform === "win32" ||
    (mode & 0o777n) === BigInt(expected)
  );
}

function stableIdentity(
  status: Pick<BigIntStats, "ino">,
): boolean {
  // The device number alone identifies only a filesystem. An inode/file ID
  // of zero cannot distinguish two entries on that filesystem, so it cannot
  // attest a path against replacement even when dev is non-zero.
  return status.ino !== 0n;
}

async function exactLstat(value: string): Promise<BigIntStats> {
  return fs.lstat(value, { bigint: true });
}

async function exactHandleStat(handle: FileHandle): Promise<BigIntStats> {
  return handle.stat({ bigint: true });
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
  const status = await exactLstat(resolved);
  if (
    status.isSymbolicLink() ||
    !status.isDirectory() ||
    !stableIdentity(status) ||
    !privateMode(status.mode, DIRECTORY_MODE)
  ) {
    throw new Error(`${description} must be a private regular directory.`);
  }
  const canonical = await fs.realpath(resolved);
  const finalStatus = await exactLstat(resolved);
  // Windows realpath expands legitimate 8.3 path components (including the
  // runner's temporary directory). The direct lstat above still rejects a
  // reparse point at this directory entry, while the server's shared data
  // directory guard is responsible for its trusted ancestry.
  if (
    finalStatus.isSymbolicLink() ||
    !finalStatus.isDirectory() ||
    finalStatus.dev !== status.dev ||
    finalStatus.ino !== status.ino ||
    !privateMode(finalStatus.mode, DIRECTORY_MODE) ||
    (process.platform !== "win32" && !samePath(canonical, resolved))
  ) {
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
  const before = await exactLstat(candidate);
  if (
    before.isSymbolicLink() ||
    !before.isDirectory() ||
    !stableIdentity(before)
  ) {
    throw new Error(`${description} must be a private regular directory.`);
  }
  const canonicalBefore = await fs.realpath(candidate);
  if (
    !samePath(canonicalBefore, candidate) ||
    !directChild(parent, canonicalBefore)
  ) {
    throw new Error(`${description} escaped its private parent.`);
  }

  // Node cannot portably open directory handles on Windows. Avoid chmod by
  // pathname there: a second identity check still rejects a replaced child,
  // while the configured data directory supplies the inherited private ACL.
  if (process.platform === "win32") {
    const canonicalAfter = await fs.realpath(candidate);
    const after = await exactLstat(candidate);
    if (
      after.isSymbolicLink() ||
      !after.isDirectory() ||
      !stableIdentity(after) ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      !samePath(canonicalAfter, canonicalBefore) ||
      !samePath(canonicalAfter, candidate) ||
      !directChild(parent, canonicalAfter)
    ) {
      throw new Error(`${description} changed while it was initialized.`);
    }
    return canonicalAfter;
  }

  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(
      candidate,
      constants.O_RDONLY |
        (constants.O_DIRECTORY ?? 0) |
        (constants.O_NOFOLLOW ?? 0),
    );
    const opened = await exactHandleStat(handle);
    if (
      !opened.isDirectory() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      !stableIdentity(opened)
    ) {
      throw new Error(`${description} changed while it was initialized.`);
    }
    await handle.chmod(DIRECTORY_MODE);
    const hardened = await exactHandleStat(handle);
    const canonicalAfter = await fs.realpath(candidate);
    const after = await exactLstat(candidate);
    if (
      !hardened.isDirectory() ||
      hardened.dev !== opened.dev ||
      hardened.ino !== opened.ino ||
      !privateMode(hardened.mode, DIRECTORY_MODE) ||
      after.isSymbolicLink() ||
      !after.isDirectory() ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      !privateMode(after.mode, DIRECTORY_MODE) ||
      !samePath(canonicalAfter, canonicalBefore) ||
      !samePath(canonicalAfter, candidate) ||
      !directChild(parent, canonicalAfter)
    ) {
      throw new Error(`${description} changed while it was initialized.`);
    }
    return canonicalAfter;
  } finally {
    await handle?.close().catch(() => undefined);
  }
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
    status = await exactLstat(candidate);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
  if (
    status.isSymbolicLink() ||
    !status.isDirectory() ||
    !stableIdentity(status)
  ) {
    throw new Error("Source artifact directory is invalid.");
  }
  const canonical = await fs.realpath(candidate);
  const finalStatus = await exactLstat(candidate);
  if (
    finalStatus.isSymbolicLink() ||
    !finalStatus.isDirectory() ||
    finalStatus.dev !== status.dev ||
    finalStatus.ino !== status.ino ||
    !directChild(parent, canonical) ||
    !samePath(candidate, canonical)
  ) {
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
      readonly sizeBytes: bigint;
      readonly modifiedNs: bigint;
      readonly device: bigint;
      readonly inode: bigint;
      readonly canonicalPath: string;
    }
  | undefined
> {
  const filePath = path.join(directoryPath, SOURCE_FILE_NAME);
  let before;
  try {
    before = await exactLstat(filePath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    before.nlink !== 1n ||
    !stableIdentity(before) ||
    before.size < BigInt(SOURCE_ARTIFACT_PREFIX_BYTES + 2) ||
    before.size > BigInt(SOURCE_ARTIFACT_MAX_BYTES) ||
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
    const opened = await exactHandleStat(handle);
    if (
      !opened.isFile() ||
      opened.nlink !== 1n ||
      !stableIdentity(opened) ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size ||
      !privateMode(opened.mode, FILE_MODE)
    ) {
      throw new Error("Source artifact changed while it was opened.");
    }
    return {
      handle,
      size: Number(opened.size),
      mtimeMs: Number(opened.mtimeMs),
      sizeBytes: opened.size,
      modifiedNs: opened.mtimeNs,
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
  let after;
  let pathAfter;
  let canonicalAfter: string;
  try {
    after = await exactHandleStat(opened.handle);
    canonicalAfter = await fs.realpath(opened.canonicalPath);
    pathAfter = await exactLstat(opened.canonicalPath);
  } catch (error) {
    throw new Error("Source artifact changed while it was read.", {
      cause: error,
    });
  }
  if (
    !after.isFile() ||
    after.nlink !== 1n ||
    !stableIdentity(after) ||
    after.dev !== opened.device ||
    after.ino !== opened.inode ||
    after.size !== opened.sizeBytes ||
    after.mtimeNs !== opened.modifiedNs ||
    !privateMode(after.mode, FILE_MODE) ||
    pathAfter.isSymbolicLink() ||
    !pathAfter.isFile() ||
    pathAfter.nlink !== 1n ||
    !stableIdentity(pathAfter) ||
    pathAfter.dev !== opened.device ||
    pathAfter.ino !== opened.inode ||
    pathAfter.size !== opened.sizeBytes ||
    pathAfter.mtimeNs !== opened.modifiedNs ||
    !privateMode(pathAfter.mode, FILE_MODE) ||
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

function publicationCheckpoint(options: SourceArtifactWorkOptions): void {
  options.signal?.throwIfAborted();
  options.checkpoint?.();
  options.signal?.throwIfAborted();
}

function updateDigest(
  digest: Hash,
  bytes: Uint8Array,
  options: SourceArtifactWorkOptions,
): void {
  for (
    let offset = 0;
    offset < bytes.byteLength;
    offset += STREAM_CHUNK_BYTES
  ) {
    publicationCheckpoint(options);
    digest.update(
      bytes.subarray(
        offset,
        Math.min(offset + STREAM_CHUNK_BYTES, bytes.byteLength),
      ),
    );
  }
  publicationCheckpoint(options);
}

async function writeExact(
  handle: FileHandle,
  bytes: Uint8Array,
  position: number,
  options: SourceArtifactWorkOptions,
): Promise<number> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    publicationCheckpoint(options);
    const result = await handle.write(
      bytes,
      offset,
      Math.min(STREAM_CHUNK_BYTES, bytes.byteLength - offset),
      position + offset,
    );
    publicationCheckpoint(options);
    if (result.bytesWritten === 0) {
      throw new Error("Staged source artifact write stopped early.");
    }
    offset += result.bytesWritten;
  }
  publicationCheckpoint(options);
  return position + offset;
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
    options: SourceArtifactWorkOptions = {},
  ): Promise<SourceArtifactMetadata> {
    const normalized = token(value);
    publicationCheckpoint(options);
    if (this.#mutations.has(normalized)) {
      throw new Error("A source artifact mutation is already active.");
    }
    this.#mutations.add(normalized);
    let artifactDirectory: string | undefined;
    let artifactDirectoryIdentity:
      | { readonly device: bigint; readonly inode: bigint }
      | undefined;
    let stagePath: string | undefined;
    let stageIdentity:
      | { readonly device: bigint; readonly inode: bigint }
      | undefined;
    let destinationLinked = false;
    let completed = false;
    let handle: FileHandle | undefined;
    try {
      publicationCheckpoint(options);
      artifactDirectory = await ensureChild(
        this.#sourcesDirectory,
        normalized,
        "Source artifact directory",
      );
      const artifactDirectoryStatus = await exactLstat(
        artifactDirectory,
      );
      if (!stableIdentity(artifactDirectoryStatus)) {
        throw new Error("Source artifact directory identity is invalid.");
      }
      artifactDirectoryIdentity = {
        device: artifactDirectoryStatus.dev,
        inode: artifactDirectoryStatus.ino,
      };
      publicationCheckpoint(options);
      const destination = path.join(
        artifactDirectory,
        SOURCE_FILE_NAME,
      );
      try {
        await exactLstat(destination);
        throw new Error("Source artifact already exists.");
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
      }
      publicationCheckpoint(options);
      const prepared = prepareSourceArtifact(artifact, options);
      publicationCheckpoint(options);
      stagePath = path.join(
        artifactDirectory,
        `.source-${randomUUID()}.tmp`,
      );
      publicationCheckpoint(options);
      handle = await fs.open(
        stagePath,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          (constants.O_NOFOLLOW ?? 0),
        FILE_MODE,
      );
      const created = await exactHandleStat(handle);
      if (
        !created.isFile() ||
        created.nlink !== 1n ||
        !privateMode(created.mode, FILE_MODE) ||
        !stableIdentity(created)
      ) {
        throw new Error("Staged source artifact failed its policy.");
      }
      stageIdentity = {
        device: created.dev,
        inode: created.ino,
      };
      publicationCheckpoint(options);
      let writePosition = await writeExact(
        handle,
        prepared.prefix,
        0,
        options,
      );
      for (const indexChunk of prepared.indexChunks) {
        writePosition = await writeExact(
          handle,
          indexChunk,
          writePosition,
          options,
        );
      }
      for (const payload of prepared.payloads) {
        publicationCheckpoint(options);
        writePosition = await writeExact(
          handle,
          payload,
          writePosition,
          options,
        );
      }
      publicationCheckpoint(options);
      if (writePosition !== prepared.size) {
        throw new Error("Staged source artifact length is invalid.");
      }
      try {
        await handle.chmod(FILE_MODE);
      } catch (error) {
        if (process.platform !== "win32") throw error;
      }
      publicationCheckpoint(options);
      await handle.sync();
      publicationCheckpoint(options);
      const staged = await exactHandleStat(handle);
      if (
        !staged.isFile() ||
        staged.nlink !== 1n ||
        staged.size !== BigInt(prepared.size) ||
        !privateMode(staged.mode, FILE_MODE) ||
        staged.dev !== stageIdentity.device ||
        staged.ino !== stageIdentity.inode
      ) {
        throw new Error("Staged source artifact failed its policy.");
      }
      publicationCheckpoint(options);
      await handle.close();
      handle = undefined;
      publicationCheckpoint(options);
      await syncDirectory(artifactDirectory);
      publicationCheckpoint(options);
      await fs.link(stagePath, destination);
      destinationLinked = true;
      publicationCheckpoint(options);
      await syncDirectory(artifactDirectory);
      publicationCheckpoint(options);
      const opened = await openSourceFileWithLinks(artifactDirectory, 2);
      if (
        opened === undefined ||
        opened.device !== staged.dev ||
        opened.inode !== staged.ino ||
        opened.sizeBytes !== staged.size
      ) {
        await opened?.handle.close();
        throw new Error("Published source artifact identity is invalid.");
      }
      await opened.handle.close();
      publicationCheckpoint(options);
      await fs.unlink(stagePath);
      stagePath = undefined;
      publicationCheckpoint(options);
      await syncDirectory(artifactDirectory);
      publicationCheckpoint(options);
      const published = await this.verify(normalized, options);
      if (
        published === undefined ||
        published.size !== prepared.size ||
        published.sha256 !== prepared.sha256 ||
        published.indexSha256 !== prepared.indexSha256
      ) {
        throw new Error("Published source artifact is missing.");
      }
      publicationCheckpoint(options);
      completed = true;
      destinationLinked = false;
      return published;
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
        const status = await exactLstat(destination).catch(
          () => undefined,
        );
        if (
          status?.dev === stageIdentity.device &&
          status.ino === stageIdentity.inode
        ) {
          await fs.unlink(destination).catch(() => undefined);
        }
      }
      throw error;
    } finally {
      await handle?.close().catch(() => undefined);
      if (stagePath !== undefined && stageIdentity !== undefined) {
        const status = await exactLstat(stagePath).catch(
          () => undefined,
        );
        if (
          status?.dev === stageIdentity.device &&
          status.ino === stageIdentity.inode
        ) {
          await fs.unlink(stagePath).catch(() => undefined);
        }
      }
      if (
        !completed &&
        artifactDirectory !== undefined &&
        artifactDirectoryIdentity !== undefined
      ) {
        const status = await exactLstat(artifactDirectory).catch(
          () => undefined,
        );
        if (
          status?.isDirectory() &&
          !status.isSymbolicLink() &&
          status.dev === artifactDirectoryIdentity.device &&
          status.ino === artifactDirectoryIdentity.inode
        ) {
          await fs.rmdir(artifactDirectory).catch(() => undefined);
          await syncDirectory(this.#sourcesDirectory).catch(() => undefined);
        }
      }
      this.#mutations.delete(normalized);
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
        text = new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: true,
        }).decode(bytes);
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
    options: SourceArtifactWorkOptions = {},
  ): Promise<SourceArtifactMetadata | undefined> {
    const normalized = token(value);
    publicationCheckpoint(options);
    const artifactDirectory = await existingTokenDirectory(
      this.#sourcesDirectory,
      normalized,
    );
    if (artifactDirectory === undefined) return undefined;
    publicationCheckpoint(options);
    const opened = await openSourceFile(artifactDirectory);
    if (opened === undefined) return undefined;
    try {
      const indexed = await readIndex(opened, options.signal);
      const overall = createHash("sha256");
      updateDigest(overall, indexed.prefix, options);
      updateDigest(overall, indexed.bytes, options);
      for (const file of indexed.index.files) {
        publicationCheckpoint(options);
        const digest = createHash("sha256");
        let offset = 0;
        while (offset < file.size) {
          publicationCheckpoint(options);
          const bytes = await readExact(
            opened.handle,
            indexed.payloadOffset + file.offset + offset,
            Math.min(STREAM_CHUNK_BYTES, file.size - offset),
            options.signal,
          );
          updateDigest(digest, bytes, options);
          updateDigest(overall, bytes, options);
          offset += bytes.byteLength;
        }
        publicationCheckpoint(options);
        if (digest.digest("hex") !== file.sha256) {
          throw new Error("Retained source file digest is invalid.");
        }
      }
      await assertOpenedUnchanged(opened);
      publicationCheckpoint(options);
      const indexDigest = createHash("sha256");
      updateDigest(indexDigest, indexed.bytes, options);
      return Object.freeze({
        token: normalized,
        size: opened.size,
        sha256: overall.digest("hex"),
        indexSha256: indexDigest.digest("hex"),
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
    before = await exactLstat(filePath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    before.nlink !== BigInt(expectedLinks) ||
    !stableIdentity(before) ||
    before.size < BigInt(SOURCE_ARTIFACT_PREFIX_BYTES + 2) ||
    before.size > BigInt(SOURCE_ARTIFACT_MAX_BYTES) ||
    !privateMode(before.mode, FILE_MODE)
  ) {
    throw new Error("Source artifact link state is invalid.");
  }
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(
      filePath,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
    const opened = await exactHandleStat(handle);
    if (
      !opened.isFile() ||
      !stableIdentity(opened) ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.nlink !== BigInt(expectedLinks) ||
      opened.size !== before.size ||
      !privateMode(opened.mode, FILE_MODE)
    ) {
      throw new Error("Source artifact changed during publication.");
    }
    const canonicalPath = await fs.realpath(filePath);
    if (
      !samePath(canonicalPath, filePath) ||
      !directChild(directoryPath, canonicalPath)
    ) {
      throw new Error("Source artifact escaped its private directory.");
    }
    const pathAfter = await exactLstat(filePath);
    if (
      pathAfter.isSymbolicLink() ||
      !pathAfter.isFile() ||
      !stableIdentity(pathAfter) ||
      pathAfter.dev !== opened.dev ||
      pathAfter.ino !== opened.ino ||
      pathAfter.nlink !== BigInt(expectedLinks) ||
      pathAfter.size !== opened.size ||
      !privateMode(pathAfter.mode, FILE_MODE)
    ) {
      throw new Error("Source artifact changed during publication.");
    }
    return {
      handle,
      size: Number(opened.size),
      mtimeMs: Number(opened.mtimeMs),
      sizeBytes: opened.size,
      modifiedNs: opened.mtimeNs,
      device: opened.dev,
      inode: opened.ino,
      canonicalPath,
    };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    throw error;
  }
}
