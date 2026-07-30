import { randomUUID } from "node:crypto";
import {
  constants,
  promises as fs,
  type BigIntStats,
} from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

import { validateCityModel } from "../../../packages/core/src/index.js";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const CITY_MODEL_FILE_NAME = "city-model.json";
const STAGED_UPLOAD_FILE_NAME = "upload.bin";
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CITY_MODEL_TEMPORARY_FILE_PATTERN =
  /^\.city-model-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/u;
const CITY_MODEL_DELETION_FILE_PATTERN =
  /^\.city-model-delete-([0-9a-f]{1,32})-([0-9a-f]{1,32})-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/u;

export const IMPORT_CITY_MODEL_MAX_BYTES = 128 * 1024 * 1024;

export type ImportArtifactStoreErrorCode =
  | "INVALID_TOKEN"
  | "FILESYSTEM_POLICY"
  | "CITY_MODEL_INVALID"
  | "CITY_MODEL_TOO_LARGE"
  | "ARTIFACT_ALREADY_EXISTS";

export class ImportArtifactStoreError extends Error {
  public override readonly name = "ImportArtifactStoreError";

  public constructor(
    public readonly code: ImportArtifactStoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface ImportArtifactStoreOptions {
  readonly dataDirectory: string;
}

export interface ImportStagingDirectory {
  /** Opaque UUIDv4 used for cleanup. It is never interpreted as a path. */
  readonly token: string;
  /** Private server-side directory into which an importer may stage data. */
  readonly directory: string;
}

export interface ImportCityModelArtifactMetadata {
  readonly token: string;
  readonly size: number;
  readonly lastModified: string;
}

export interface ImportCityModelArtifact
  extends ImportCityModelArtifactMetadata {
  readonly bytes: Buffer;
}

export interface StagedUploadWriteOptions {
  readonly expectedBytes: number;
  readonly maximumBytes: number;
  readonly signal?: AbortSignal;
}

interface TrustedDirectory {
  readonly path: string;
  readonly canonicalPath: string;
  readonly device: bigint;
  readonly inode: bigint;
  readonly mode: bigint;
}

interface OpenArtifact {
  readonly handle: FileHandle;
  readonly status: BigIntStats;
  readonly canonicalPath: string;
}

interface FileIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

interface InspectedFile {
  readonly canonicalPath: string;
  readonly status: BigIntStats;
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

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLocaleLowerCase("en-US") ===
        normalizedRight.toLocaleLowerCase("en-US")
    : normalizedLeft === normalizedRight;
}

function sameIdentity(
  left: Pick<TrustedDirectory, "device" | "inode">,
  right: Pick<TrustedDirectory, "device" | "inode">,
): boolean {
  const identityUnavailable =
    left.device === 0n &&
    left.inode === 0n &&
    right.device === 0n &&
    right.inode === 0n;
  return (
    identityUnavailable ||
    (left.device === right.device && left.inode === right.inode)
  );
}

function hasPrivateMode(mode: bigint, expected: number): boolean {
  return (
    process.platform === "win32" ||
    Number(mode & 0o777n) === expected
  );
}

function policyError(
  message: string,
  cause?: unknown,
): ImportArtifactStoreError {
  return new ImportArtifactStoreError(
    "FILESYSTEM_POLICY",
    message,
    cause === undefined ? undefined : { cause },
  );
}

function deletionMarkerIdentity(name: string): FileIdentity | undefined {
  const match = CITY_MODEL_DELETION_FILE_PATTERN.exec(name);
  if (match === null) return undefined;
  return {
    device: BigInt(`0x${match[1]}`),
    inode: BigInt(`0x${match[2]}`),
  };
}

function deletionFileName(status: BigIntStats): string {
  return [
    ".city-model-delete",
    status.dev.toString(16),
    status.ino.toString(16),
    randomUUID(),
  ].join("-") + ".tmp";
}

export function isImportArtifactToken(value: unknown): value is string {
  return typeof value === "string" && UUID_V4_PATTERN.test(value);
}

function validatedToken(token: string): string {
  if (!isImportArtifactToken(token)) {
    throw new ImportArtifactStoreError(
      "INVALID_TOKEN",
      "Import artifact token must be a lowercase UUIDv4.",
    );
  }
  return token;
}

async function applyDirectoryMode(directory: string): Promise<void> {
  try {
    await fs.chmod(directory, DIRECTORY_MODE);
  } catch (error) {
    if (process.platform !== "win32") throw error;
  }
}

async function inspectDirectory(
  directory: string,
  description: string,
): Promise<TrustedDirectory> {
  const status = await fs.lstat(directory, { bigint: true });
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw policyError(`${description} must be a real directory.`);
  }
  const canonicalPath = await fs.realpath(directory);
  return {
    path: directory,
    canonicalPath,
    device: status.dev,
    inode: status.ino,
    mode: status.mode,
  };
}

async function assertTrustedDirectory(
  trusted: TrustedDirectory,
  description: string,
  requirePrivateMode = true,
): Promise<void> {
  let current: TrustedDirectory;
  try {
    current = await inspectDirectory(trusted.path, description);
  } catch (error) {
    if (error instanceof ImportArtifactStoreError) throw error;
    throw policyError(`${description} is no longer accessible safely.`, error);
  }
  if (
    !samePath(current.canonicalPath, trusted.canonicalPath) ||
    !sameIdentity(current, trusted) ||
    (requirePrivateMode &&
      !hasPrivateMode(current.mode, DIRECTORY_MODE))
  ) {
    throw policyError(`${description} changed after it was opened.`);
  }
}

/**
 * Makes completed directory-entry mutations durable on POSIX filesystems.
 *
 * Windows intentionally does not open directory handles here: Node's Win32
 * FileHandle API does not provide a portable directory-fsync operation.
 * Windows deployments must place the data directory behind a presecured ACL
 * and rely on the configured volume's directory-entry durability guarantees;
 * artifact payload bytes are still flushed with FileHandle.sync().
 */
async function syncDirectory(
  directory: TrustedDirectory,
  description: string,
): Promise<void> {
  if (process.platform === "win32") return;

  await assertTrustedDirectory(directory, description);
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(
      directory.canonicalPath,
      constants.O_RDONLY |
        (constants.O_DIRECTORY ?? 0) |
        (constants.O_NOFOLLOW ?? 0),
    );
    const status = await handle.stat({ bigint: true });
    if (
      !status.isDirectory() ||
      status.dev !== directory.device ||
      status.ino !== directory.inode
    ) {
      throw policyError(`${description} changed while it was opened.`);
    }
    await handle.sync();
  } catch (error) {
    if (error instanceof ImportArtifactStoreError) throw error;
    throw policyError(
      `${description} could not be flushed durably.`,
      error,
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
  await assertTrustedDirectory(directory, description);
}

async function ensurePrivateRoot(
  directory: string,
  description: string,
): Promise<TrustedDirectory> {
  const absolute = path.resolve(directory);
  try {
    await fs.mkdir(absolute, {
      recursive: true,
      mode: DIRECTORY_MODE,
    });
    const before = await inspectDirectory(absolute, description);
    await applyDirectoryMode(before.path);
    const after = await inspectDirectory(before.canonicalPath, description);
    if (
      !sameIdentity(before, after) ||
      !hasPrivateMode(after.mode, DIRECTORY_MODE)
    ) {
      throw policyError(`${description} changed while it was initialized.`);
    }
    return after;
  } catch (error) {
    if (error instanceof ImportArtifactStoreError) throw error;
    throw policyError(`${description} could not be initialized safely.`, error);
  }
}

function assertDirectChild(
  parent: TrustedDirectory,
  child: TrustedDirectory,
  name: string,
  description: string,
): void {
  if (
    !samePath(
      child.canonicalPath,
      path.join(parent.canonicalPath, name),
    )
  ) {
    throw policyError(`${description} resolves outside its parent.`);
  }
}

async function ensurePrivateChild(
  parent: TrustedDirectory,
  name: string,
  description: string,
): Promise<TrustedDirectory> {
  await assertTrustedDirectory(parent, "Import data parent directory");
  const candidate = path.join(parent.canonicalPath, name);
  try {
    await fs.mkdir(candidate, {
      recursive: false,
      mode: DIRECTORY_MODE,
    });
  } catch (error) {
    if (errorCode(error) !== "EEXIST") {
      throw policyError(`${description} could not be created safely.`, error);
    }
  }
  try {
    const before = await inspectDirectory(candidate, description);
    assertDirectChild(parent, before, name, description);
    await applyDirectoryMode(before.path);
    const after = await inspectDirectory(before.canonicalPath, description);
    if (
      !sameIdentity(before, after) ||
      !hasPrivateMode(after.mode, DIRECTORY_MODE)
    ) {
      throw policyError(`${description} changed while it was initialized.`);
    }
    await assertTrustedDirectory(parent, "Import data parent directory");
    return after;
  } catch (error) {
    if (error instanceof ImportArtifactStoreError) throw error;
    throw policyError(`${description} could not be initialized safely.`, error);
  }
}

async function existingDirectChild(
  parent: TrustedDirectory,
  name: string,
  description: string,
): Promise<TrustedDirectory | undefined> {
  await assertTrustedDirectory(parent, "Import data parent directory");
  const candidate = path.join(parent.canonicalPath, name);
  let child: TrustedDirectory;
  try {
    child = await inspectDirectory(candidate, description);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    if (error instanceof ImportArtifactStoreError) throw error;
    throw policyError(`${description} could not be inspected safely.`, error);
  }
  assertDirectChild(parent, child, name, description);
  await assertTrustedDirectory(parent, "Import data parent directory");
  return child;
}

async function destinationMustNotExist(
  destination: string,
): Promise<void> {
  try {
    const status = await fs.lstat(destination);
    if (status.isSymbolicLink() || !status.isFile()) {
      throw policyError(
        "City-model artifact destination must be a regular file path.",
      );
    }
    throw new ImportArtifactStoreError(
      "ARTIFACT_ALREADY_EXISTS",
      "A city-model artifact already exists for this token.",
    );
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
}

async function assertArtifactDestinationAbsent(
  destination: string,
): Promise<void> {
  try {
    await fs.lstat(destination);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw policyError(
      "City-model artifact destination could not be checked safely.",
      error,
    );
  }
  throw policyError(
    "A replacement appeared at the city-model artifact destination during cleanup.",
  );
}

async function inspectPrivateFile(
  filePath: string,
  description: string,
): Promise<InspectedFile | undefined> {
  let status;
  try {
    status = await fs.lstat(filePath, { bigint: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw policyError(`${description} could not be inspected safely.`, error);
  }
  if (
    status.isSymbolicLink() ||
    !status.isFile() ||
    !hasPrivateMode(status.mode, FILE_MODE)
  ) {
    throw policyError(`${description} must be a private regular file.`);
  }
  const canonicalPath = await fs.realpath(filePath);
  if (!samePath(canonicalPath, filePath)) {
    throw policyError(`${description} resolves outside its fixed path.`);
  }
  return { canonicalPath, status };
}

function serializeValidatedCityModel(value: unknown): Buffer {
  let serialized: string;
  try {
    const result = JSON.stringify(value, null, 2);
    if (result === undefined) throw new TypeError("Not JSON serializable.");
    serialized = result;
  } catch (error) {
    throw new ImportArtifactStoreError(
      "CITY_MODEL_INVALID",
      "City model could not be serialized as JSON.",
      { cause: error },
    );
  }

  const bytes = Buffer.from(`${serialized}\n`, "utf8");
  if (bytes.byteLength > IMPORT_CITY_MODEL_MAX_BYTES) {
    throw new ImportArtifactStoreError(
      "CITY_MODEL_TOO_LARGE",
      `City model exceeds the ${IMPORT_CITY_MODEL_MAX_BYTES}-byte limit.`,
    );
  }

  try {
    validateCityModel(JSON.parse(serialized) as unknown);
  } catch (error) {
    throw new ImportArtifactStoreError(
      "CITY_MODEL_INVALID",
      "City model failed schema validation.",
      { cause: error },
    );
  }
  return bytes;
}

function positiveByteLimit(value: number, description: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${description} must be a positive safe integer.`);
  }
  return value;
}

function metadata(
  token: string,
  status: OpenArtifact["status"],
): ImportCityModelArtifactMetadata {
  return Object.freeze({
    token,
    size: Number(status.size),
    lastModified: new Date(Number(status.mtimeMs)).toUTCString(),
  });
}

async function openArtifactFile(
  directory: TrustedDirectory,
  expectedLinks = 1n,
): Promise<OpenArtifact | undefined> {
  await assertTrustedDirectory(directory, "City-model artifact directory");
  const filePath = path.join(directory.canonicalPath, CITY_MODEL_FILE_NAME);
  let before;
  try {
    before = await fs.lstat(filePath, { bigint: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw policyError("City-model artifact could not be inspected safely.", error);
  }
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    before.nlink !== expectedLinks ||
    !hasPrivateMode(before.mode, FILE_MODE)
  ) {
    throw policyError(
      "City-model artifact must be a private regular file.",
    );
  }
  if (before.size > BigInt(IMPORT_CITY_MODEL_MAX_BYTES)) {
    throw new ImportArtifactStoreError(
      "CITY_MODEL_TOO_LARGE",
      `City model exceeds the ${IMPORT_CITY_MODEL_MAX_BYTES}-byte limit.`,
    );
  }

  const canonicalBefore = await fs.realpath(filePath);
  if (
    !samePath(
      canonicalBefore,
      path.join(directory.canonicalPath, CITY_MODEL_FILE_NAME),
    )
  ) {
    throw policyError(
      "City-model artifact resolves outside its private directory.",
    );
  }

  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(
      filePath,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
    const status = await handle.stat({ bigint: true });
    const canonicalAfter = await fs.realpath(filePath);
    if (
      !status.isFile() ||
      status.nlink !== expectedLinks ||
      !hasPrivateMode(status.mode, FILE_MODE) ||
      status.dev !== before.dev ||
      status.ino !== before.ino ||
      !samePath(canonicalAfter, canonicalBefore)
    ) {
      throw policyError(
        "City-model artifact changed while it was being opened.",
      );
    }
    if (status.size > BigInt(IMPORT_CITY_MODEL_MAX_BYTES)) {
      throw new ImportArtifactStoreError(
        "CITY_MODEL_TOO_LARGE",
        `City model exceeds the ${IMPORT_CITY_MODEL_MAX_BYTES}-byte limit.`,
      );
    }
    return {
      handle,
      status,
      canonicalPath: canonicalAfter,
    };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    throw error;
  }
}

async function removeFileIfIdentityMatches(
  filePath: string,
  identity: FileIdentity,
  description: string,
  parent?: TrustedDirectory,
): Promise<void> {
  if (identity.device === 0n && identity.inode === 0n) {
    throw policyError(
      `${description} requires a stable filesystem identity.`,
    );
  }
  let status;
  try {
    status = await fs.lstat(filePath, { bigint: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      if (parent !== undefined) {
        await syncDirectory(parent, `${description} parent directory`);
      }
      return;
    }
    throw policyError(
      `${description} could not inspect its fixed path.`,
      error,
    );
  }
  if (
    status.isSymbolicLink() ||
    !status.isFile() ||
    status.dev !== identity.device ||
    status.ino !== identity.inode
  ) {
    throw policyError(
      `${description} refused to remove a different file.`,
    );
  }
  await fs.unlink(filePath);
  if (parent !== undefined) {
    await syncDirectory(parent, `${description} parent directory`);
  }
}

async function removePrivateDirectory(
  parent: TrustedDirectory,
  directory: TrustedDirectory,
  description: string,
): Promise<void> {
  assertDirectChild(
    parent,
    directory,
    path.basename(directory.path),
    description,
  );
  // The private parent still prevents traversal by other users. Cleanup must
  // recover even if interrupted or externally staged material has a broader
  // child mode; path identity and direct-child containment remain mandatory.
  await assertTrustedDirectory(directory, description, false);
  await fs.rm(directory.path, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
  await syncDirectory(parent, `${description} parent directory`);
  await assertTrustedDirectory(parent, "Import data parent directory");
}

/**
 * Owns the private, fixed-shape filesystem area used by browser imports.
 * Public methods accept only opaque UUIDv4 tokens; callers cannot supply paths.
 *
 * One running server must exclusively own a data directory. Opening a store
 * treats every pre-existing staging directory as abandoned. Artifact insertion
 * still uses a filesystem-level no-replace operation so an accidental overlap
 * cannot overwrite an already-published model, but staging is not coordinated
 * between processes.
 */
export class ImportArtifactStore {
  readonly #artifactsDirectory: TrustedDirectory;
  readonly #importsDirectory: TrustedDirectory;
  readonly #publishing = new Set<string>();
  readonly #cleanups = new Map<string, Promise<void>>();
  #reconciling = false;

  private constructor(
    artifactsDirectory: TrustedDirectory,
    importsDirectory: TrustedDirectory,
  ) {
    this.#artifactsDirectory = artifactsDirectory;
    this.#importsDirectory = importsDirectory;
  }

  public static async open(
    options: ImportArtifactStoreOptions,
  ): Promise<ImportArtifactStore> {
    const dataDirectory = await ensurePrivateRoot(
      options.dataDirectory,
      "Code City data directory",
    );
    const artifactsDirectory = await ensurePrivateChild(
      dataDirectory,
      "artifacts",
      "Import artifacts directory",
    );
    const temporaryDirectory = await ensurePrivateChild(
      dataDirectory,
      "tmp",
      "Import temporary directory",
    );
    const importsDirectory = await ensurePrivateChild(
      temporaryDirectory,
      "imports",
      "Import staging directory",
    );
    const store = new ImportArtifactStore(
      artifactsDirectory,
      importsDirectory,
    );
    await store.recoverInterruptedArtifactPublications();
    await store.sweepAbandonedStagingDirectories();
    return store;
  }

  public async createStagingDirectory(): Promise<ImportStagingDirectory> {
    await assertTrustedDirectory(
      this.#importsDirectory,
      "Import staging directory",
    );
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const token = randomUUID();
      const candidate = path.join(
        this.#importsDirectory.canonicalPath,
        token,
      );
      try {
        await fs.mkdir(candidate, {
          recursive: false,
          mode: DIRECTORY_MODE,
        });
      } catch (error) {
        if (errorCode(error) === "EEXIST") continue;
        throw policyError(
          "Import staging directory could not be created safely.",
          error,
        );
      }
      try {
        const before = await inspectDirectory(
          candidate,
          "Import staging directory",
        );
        assertDirectChild(
          this.#importsDirectory,
          before,
          token,
          "Import staging directory",
        );
        await applyDirectoryMode(before.path);
        const directory = await inspectDirectory(
          before.canonicalPath,
          "Import staging directory",
        );
        if (
          !sameIdentity(before, directory) ||
          !hasPrivateMode(directory.mode, DIRECTORY_MODE)
        ) {
          throw policyError(
            "Import staging directory changed while it was initialized.",
          );
        }
        await assertTrustedDirectory(
          this.#importsDirectory,
          "Import staging directory",
        );
        return Object.freeze({
          token,
          directory: directory.canonicalPath,
        });
      } catch (error) {
        await fs.rm(candidate, {
          recursive: true,
          force: true,
        }).catch(() => undefined);
        throw error;
      }
    }
    throw policyError(
      "A unique import staging directory could not be allocated.",
    );
  }

  /**
   * Streams one request body into the only admitted staging filename.
   * Neither the browser filename nor any archive member is materialized.
   */
  public async writeStagedUpload(
    token: string,
    chunks: AsyncIterable<Uint8Array>,
    options: StagedUploadWriteOptions,
  ): Promise<void> {
    const normalized = validatedToken(token);
    const expectedBytes = positiveByteLimit(
      options.expectedBytes,
      "Expected upload bytes",
    );
    const maximumBytes = positiveByteLimit(
      options.maximumBytes,
      "Maximum upload bytes",
    );
    if (expectedBytes > maximumBytes) {
      throw new ImportArtifactStoreError(
        "CITY_MODEL_TOO_LARGE",
        "Staged upload exceeds its byte limit.",
      );
    }
    const directory = await existingDirectChild(
      this.#importsDirectory,
      normalized,
      "Import staging directory",
    );
    if (directory === undefined) {
      throw policyError("Import staging directory is unavailable.");
    }
    const destination = path.join(
      directory.canonicalPath,
      STAGED_UPLOAD_FILE_NAME,
    );
    let handle: FileHandle | undefined;
    let identity: FileIdentity | undefined;
    try {
      options.signal?.throwIfAborted();
      handle = await fs.open(
        destination,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          (constants.O_NOFOLLOW ?? 0),
        FILE_MODE,
      );
      const created = await handle.stat({ bigint: true });
      if (
        !created.isFile() ||
        created.nlink !== 1n ||
        !hasPrivateMode(created.mode, FILE_MODE) ||
        (created.dev === 0n && created.ino === 0n)
      ) {
        throw policyError(
          "Staged upload failed its filesystem policy.",
        );
      }
      identity = { device: created.dev, inode: created.ino };
      let received = 0;
      for await (const chunk of chunks) {
        options.signal?.throwIfAborted();
        if (!(chunk instanceof Uint8Array)) {
          throw new TypeError("Upload chunks must be Uint8Array values.");
        }
        received += chunk.byteLength;
        if (
          !Number.isSafeInteger(received) ||
          received > expectedBytes ||
          received > maximumBytes
        ) {
          throw new ImportArtifactStoreError(
            "CITY_MODEL_TOO_LARGE",
            "Staged upload exceeds its declared byte length.",
          );
        }
        await handle.writeFile(chunk);
      }
      options.signal?.throwIfAborted();
      if (received !== expectedBytes) {
        throw new ImportArtifactStoreError(
          "CITY_MODEL_INVALID",
          "Staged upload did not match its declared byte length.",
        );
      }
      try {
        await handle.chmod(FILE_MODE);
      } catch (error) {
        if (process.platform !== "win32") throw error;
      }
      await handle.sync();
      const completed = await handle.stat({ bigint: true });
      if (
        !completed.isFile() ||
        completed.nlink !== 1n ||
        !hasPrivateMode(completed.mode, FILE_MODE) ||
        completed.dev !== identity.device ||
        completed.ino !== identity.inode ||
        completed.size !== BigInt(received)
      ) {
        throw policyError(
          "Staged upload changed while it was received.",
        );
      }
      await handle.close();
      handle = undefined;
      const canonicalPath = await fs.realpath(destination);
      if (!samePath(canonicalPath, destination)) {
        throw policyError(
          "Staged upload resolves outside its private directory.",
        );
      }
      await syncDirectory(directory, "Import staging directory");
      const inspected = await inspectPrivateFile(
        destination,
        "Staged upload",
      );
      if (
        inspected === undefined ||
        inspected.status.nlink !== 1n ||
        inspected.status.dev !== identity.device ||
        inspected.status.ino !== identity.inode ||
        inspected.status.size !== BigInt(received)
      ) {
        throw policyError(
          "Staged upload changed after it was flushed.",
        );
      }
      options.signal?.throwIfAborted();
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if (identity !== undefined) {
        await removeFileIfIdentityMatches(
          destination,
          identity,
          "Failed staged upload cleanup",
          directory,
        ).catch(() => undefined);
      }
      throw error;
    }
  }

  public async readStagedUpload(
    token: string,
    maximumBytes: number,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    const normalized = validatedToken(token);
    const maximum = positiveByteLimit(
      maximumBytes,
      "Maximum upload bytes",
    );
    const directory = await existingDirectChild(
      this.#importsDirectory,
      normalized,
      "Import staging directory",
    );
    if (directory === undefined) {
      throw policyError("Import staging directory is unavailable.");
    }
    await assertTrustedDirectory(directory, "Import staging directory");
    const filePath = path.join(
      directory.canonicalPath,
      STAGED_UPLOAD_FILE_NAME,
    );
    const before = await inspectPrivateFile(filePath, "Staged upload");
    if (
      before === undefined ||
      before.status.nlink !== 1n ||
      before.status.size < 1n ||
      before.status.size > BigInt(maximum)
    ) {
      throw policyError("Staged upload is unavailable or exceeds its limit.");
    }
    signal?.throwIfAborted();
    let handle: FileHandle | undefined;
    try {
      handle = await fs.open(
        filePath,
        constants.O_RDONLY |
          (constants.O_NOFOLLOW ?? 0) |
          (constants.O_NONBLOCK ?? 0),
      );
      const opened = await handle.stat({ bigint: true });
      if (
        !opened.isFile() ||
        opened.nlink !== 1n ||
        !hasPrivateMode(opened.mode, FILE_MODE) ||
        opened.dev !== before.status.dev ||
        opened.ino !== before.status.ino ||
        opened.size !== before.status.size
      ) {
        throw policyError(
          "Staged upload changed while it was opened.",
        );
      }
      const expectedBytes = Number(opened.size);
      const bytes = Buffer.allocUnsafe(expectedBytes);
      let totalBytes = 0;
      while (totalBytes < expectedBytes) {
        signal?.throwIfAborted();
        const { bytesRead } = await handle.read(
          bytes,
          totalBytes,
          expectedBytes - totalBytes,
          totalBytes,
        );
        if (bytesRead === 0) break;
        totalBytes += bytesRead;
      }
      signal?.throwIfAborted();
      const after = await handle.stat({ bigint: true });
      const canonicalAfter = await fs.realpath(filePath);
      if (
        !after.isFile() ||
        after.nlink !== 1n ||
        !hasPrivateMode(after.mode, FILE_MODE) ||
        after.dev !== opened.dev ||
        after.ino !== opened.ino ||
        after.size !== opened.size ||
        after.mtimeNs !== opened.mtimeNs ||
        totalBytes !== expectedBytes ||
        !samePath(canonicalAfter, before.canonicalPath)
      ) {
        throw policyError(
          "Staged upload changed while it was read.",
        );
      }
      return bytes;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  public async cleanupStagingDirectory(token: string): Promise<void> {
    const normalized = validatedToken(token);
    const directory = await existingDirectChild(
      this.#importsDirectory,
      normalized,
      "Import staging directory",
    );
    if (directory === undefined) {
      await syncDirectory(
        this.#importsDirectory,
        "Import staging directory",
      );
      return;
    }
    await removePrivateDirectory(
      this.#importsDirectory,
      directory,
      "Import staging directory",
    );
  }

  public async cleanupCityModelArtifact(token: string): Promise<void> {
    const normalized = validatedToken(token);
    if (this.#reconciling) {
      throw policyError(
        "City-model artifacts cannot be cleaned while startup reconciliation is active.",
      );
    }
    const active = this.#cleanups.get(normalized);
    if (active !== undefined) return active;
    const cleanup = this.cleanupCityModelArtifactOnce(normalized).finally(
      () => {
        if (this.#cleanups.get(normalized) === cleanup) {
          this.#cleanups.delete(normalized);
        }
      },
    );
    this.#cleanups.set(normalized, cleanup);
    return cleanup;
  }

  public async publishCityModel(
    token: string,
    value: unknown,
  ): Promise<ImportCityModelArtifactMetadata> {
    const normalized = validatedToken(token);
    const bytes = serializeValidatedCityModel(value);
    if (
      this.#publishing.has(normalized) ||
      this.#cleanups.has(normalized) ||
      this.#reconciling
    ) {
      throw new ImportArtifactStoreError(
        "ARTIFACT_ALREADY_EXISTS",
        "A city-model artifact mutation is already in progress for this token.",
      );
    }
    this.#publishing.add(normalized);

    let temporaryPath: string | undefined;
    let destination: string | undefined;
    let stagedIdentity: FileIdentity | undefined;
    let destinationLinked = false;
    let preserveRecoveryMarker = false;
    let handle: FileHandle | undefined;
    let artifactDirectory: TrustedDirectory | undefined;
    try {
      const directory = await ensurePrivateChild(
        this.#artifactsDirectory,
        normalized,
        "City-model artifact directory",
      );
      artifactDirectory = directory;
      await syncDirectory(
        this.#artifactsDirectory,
        "Import artifacts directory",
      );
      destination = path.join(
        directory.canonicalPath,
        CITY_MODEL_FILE_NAME,
      );
      await destinationMustNotExist(destination);
      temporaryPath = path.join(
        directory.canonicalPath,
        `.city-model-${randomUUID()}.tmp`,
      );
      handle = await fs.open(
        temporaryPath,
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
      const staged = await handle.stat({ bigint: true });
      if (
        !staged.isFile() ||
        staged.nlink !== 1n ||
        !hasPrivateMode(staged.mode, FILE_MODE) ||
        staged.size !== BigInt(bytes.byteLength) ||
        (staged.dev === 0n && staged.ino === 0n)
      ) {
        throw policyError(
          "Staged city-model artifact failed its filesystem policy.",
        );
      }
      await handle.close();
      handle = undefined;
      await syncDirectory(
        directory,
        "City-model artifact directory",
      );
      stagedIdentity = {
        device: staged.dev,
        inode: staged.ino,
      };
      const publishedMetadata = metadata(normalized, staged);

      await assertTrustedDirectory(
        directory,
        "City-model artifact directory",
      );
      await destinationMustNotExist(destination);
      try {
        // A hard-link insertion is atomic and fails with EEXIST. Unlike a
        // POSIX rename, it cannot replace an artifact during an accidental
        // overlapping publication.
        await fs.link(temporaryPath, destination);
      } catch (error) {
        if (errorCode(error) === "EEXIST") {
          await destinationMustNotExist(destination);
          throw new ImportArtifactStoreError(
            "ARTIFACT_ALREADY_EXISTS",
            "A city-model artifact already exists for this token.",
            { cause: error },
          );
        }
        throw error;
      }
      destinationLinked = true;
      await syncDirectory(
        directory,
        "City-model artifact directory",
      );

      // Validate the fixed name while the staged name still provides a crash
      // recovery marker. A failure below can therefore remove only the linked
      // inode, or leave an unambiguous pair for startup reconciliation.
      const opened = await openArtifactFile(directory, 2n);
      if (opened === undefined) {
        throw policyError("Published city-model artifact is missing.");
      }
      try {
        if (
          opened.status.dev !== staged.dev ||
          opened.status.ino !== staged.ino ||
          opened.status.size !== BigInt(bytes.byteLength)
        ) {
          throw policyError(
            "Published city-model artifact has an unexpected identity.",
          );
        }
      } finally {
        await opened.handle.close();
      }

      try {
        await removeFileIfIdentityMatches(
          temporaryPath,
          stagedIdentity,
          "City-model publication stage cleanup",
          directory,
        );
      } catch {
        // Retry the identity-checked unlink once for transient Windows sharing
        // failures. Never fall back to removing an unverified replacement.
        await removeFileIfIdentityMatches(
          temporaryPath,
          stagedIdentity,
          "City-model publication stage cleanup",
          directory,
        );
      }
      temporaryPath = undefined;
      destinationLinked = false;
      return publishedMetadata;
    } catch (error) {
      if (
        destinationLinked &&
        destination !== undefined &&
        stagedIdentity !== undefined
      ) {
        try {
          await removeFileIfIdentityMatches(
            destination,
            stagedIdentity,
            "City-model artifact rollback",
            artifactDirectory,
          );
          destinationLinked = false;
        } catch (rollbackError) {
          // Keep the strict temporary name when rollback fails. Startup can
          // safely recognize the two names by inode and complete recovery.
          preserveRecoveryMarker = true;
          throw policyError(
            "City-model artifact publication failed and could not be rolled back safely.",
            new AggregateError([error, rollbackError]),
          );
        }
      }
      throw error;
    } finally {
      this.#publishing.delete(normalized);
      await handle?.close().catch(() => undefined);
      try {
        if (
          temporaryPath !== undefined &&
          !preserveRecoveryMarker
        ) {
          if (stagedIdentity === undefined) {
            await fs.rm(temporaryPath, { force: true });
            if (artifactDirectory !== undefined) {
              await syncDirectory(
                artifactDirectory,
                "City-model artifact directory",
              );
            }
          } else {
            await removeFileIfIdentityMatches(
              temporaryPath,
              stagedIdentity,
              "Abandoned city-model publication stage cleanup",
              artifactDirectory,
            );
          }
        }
      } catch {
        // A failed publication already carries the actionable error. A strict
        // orphan stage is repaired on the next single-owner startup.
      }
    }
  }

  public async statCityModel(
    token: string,
  ): Promise<ImportCityModelArtifactMetadata | undefined> {
    const normalized = validatedToken(token);
    const directory = await existingDirectChild(
      this.#artifactsDirectory,
      normalized,
      "City-model artifact directory",
    );
    if (directory === undefined) return undefined;
    const opened = await openArtifactFile(directory);
    if (opened === undefined) return undefined;
    try {
      return metadata(normalized, opened.status);
    } finally {
      await opened.handle.close();
    }
  }

  public async readCityModel(
    token: string,
  ): Promise<ImportCityModelArtifact | undefined> {
    const normalized = validatedToken(token);
    const directory = await existingDirectChild(
      this.#artifactsDirectory,
      normalized,
      "City-model artifact directory",
    );
    if (directory === undefined) return undefined;
    const opened = await openArtifactFile(directory);
    if (opened === undefined) return undefined;
    try {
      const expectedBytes = Number(opened.status.size);
      const bytes = Buffer.allocUnsafe(expectedBytes);
      let totalBytes = 0;
      while (totalBytes < expectedBytes) {
        const { bytesRead } = await opened.handle.read(
          bytes,
          totalBytes,
          expectedBytes - totalBytes,
          totalBytes,
        );
        if (bytesRead === 0) break;
        totalBytes += bytesRead;
      }

      const after = await opened.handle.stat({ bigint: true });
      const canonicalAfter = await fs.realpath(opened.canonicalPath);
      if (
        !after.isFile() ||
        after.nlink !== 1n ||
        !hasPrivateMode(after.mode, FILE_MODE) ||
        after.dev !== opened.status.dev ||
        after.ino !== opened.status.ino ||
        after.size !== opened.status.size ||
        after.mtimeNs !== opened.status.mtimeNs ||
        BigInt(totalBytes) !== after.size ||
        !samePath(canonicalAfter, opened.canonicalPath)
      ) {
        throw policyError(
          "City-model artifact changed while it was being read.",
        );
      }
      return Object.freeze({
        ...metadata(normalized, after),
        bytes,
      });
    } finally {
      await opened.handle.close();
    }
  }

  /**
   * Reconciles durable job results with their published city-model artifacts.
   *
   * This is a startup-only operation for the single server that exclusively
   * owns the data directory. Callers must derive retainedTokens solely from
   * already-validated completed job results, before accepting HTTP requests.
   * Every other UUID artifact is removed using the normal identity-checked
   * cleanup path. Retained artifacts are read and schema-validated, so startup
   * fails rather than exposing a missing or corrupt completed-job result.
   */
  public async reconcileCityModelArtifacts(
    retainedTokens: ReadonlySet<string>,
  ): Promise<void> {
    const retained = new Set<string>();
    for (const token of retainedTokens) {
      retained.add(validatedToken(token));
    }
    if (
      this.#reconciling ||
      this.#publishing.size > 0 ||
      this.#cleanups.size > 0
    ) {
      throw policyError(
        "City-model artifacts cannot be reconciled while another mutation is active.",
      );
    }
    this.#reconciling = true;
    try {
      await assertTrustedDirectory(
        this.#artifactsDirectory,
        "Import artifacts directory",
      );
      const entries = await fs.readdir(
        this.#artifactsDirectory.canonicalPath,
        { withFileTypes: true },
      );
      for (const entry of entries) {
        if (
          !isImportArtifactToken(entry.name) ||
          retained.has(entry.name)
        ) {
          continue;
        }
        await this.cleanupCityModelArtifactOnce(entry.name);
      }

      for (const token of retained) {
        const artifact = await this.readCityModel(token);
        if (artifact === undefined) {
          throw policyError(
            "A completed import job references a missing city-model artifact.",
          );
        }
        try {
          const serialized = new TextDecoder("utf-8", {
            fatal: true,
          }).decode(artifact.bytes);
          validateCityModel(JSON.parse(serialized) as unknown);
        } catch (error) {
          throw new ImportArtifactStoreError(
            "CITY_MODEL_INVALID",
            "A completed import job references an invalid city-model artifact.",
            { cause: error },
          );
        }
      }
      await assertTrustedDirectory(
        this.#artifactsDirectory,
        "Import artifacts directory",
      );
    } finally {
      this.#reconciling = false;
    }
  }

  private async cleanupCityModelArtifactOnce(
    token: string,
  ): Promise<void> {
    if (this.#publishing.has(token)) {
      throw policyError(
        "City-model artifact cannot be cleaned while publication is active.",
      );
    }
    const directory = await existingDirectChild(
      this.#artifactsDirectory,
      token,
      "City-model artifact directory",
    );
    if (directory === undefined) {
      await syncDirectory(
        this.#artifactsDirectory,
        "Import artifacts directory",
      );
      return;
    }
    const restoredReplacement =
      await this.removeCompletedDeletionMarkers(directory);
    if (restoredReplacement) {
      throw policyError(
        "An interrupted replacement restoration was recovered; the replacement was preserved.",
      );
    }

    const opened = await openArtifactFile(directory);
    if (opened === undefined) {
      const removed = await this.removeArtifactDirectoryIfEmpty(directory);
      if (!removed) {
        throw policyError(
          "City-model artifact is missing but its directory contains unknown data.",
        );
      }
      return;
    }
    if (opened.status.dev === 0n && opened.status.ino === 0n) {
      await opened.handle.close();
      throw policyError(
        "City-model artifact cannot be cleaned without a stable file identity.",
      );
    }
    let handleClosed = false;
    const destination = path.join(
      directory.canonicalPath,
      CITY_MODEL_FILE_NAME,
    );
    const deletionPath = path.join(
      directory.canonicalPath,
      deletionFileName(opened.status),
    );
    try {
      try {
        await fs.rename(destination, deletionPath);
        await syncDirectory(
          directory,
          "City-model artifact directory",
        );
      } catch (error) {
        if (errorCode(error) === "ENOENT") {
          await opened.handle.close();
          handleClosed = true;
          const removed =
            await this.removeArtifactDirectoryIfEmpty(directory);
          if (!removed) {
            throw policyError(
              "City-model artifact disappeared during cleanup but its directory contains unknown data.",
            );
          }
          return;
        }
        throw error;
      }

      let moved;
      try {
        moved = await fs.lstat(deletionPath, { bigint: true });
      } catch (error) {
        throw policyError(
          "City-model artifact changed during cleanup.",
          error,
        );
      }
      const expectedEntry =
        !moved.isSymbolicLink() &&
        moved.isFile() &&
        moved.nlink === 1n &&
        hasPrivateMode(moved.mode, FILE_MODE) &&
        moved.dev === opened.status.dev &&
        moved.ino === opened.status.ino;
      await opened.handle.close();
      handleClosed = true;

      if (!expectedEntry) {
        // Preserve a replacement regular file at its fixed name when possible.
        // link() is create-if-absent, so this never overwrites a newer entry.
        if (!moved.isSymbolicLink() && moved.isFile()) {
          try {
            await fs.link(deletionPath, destination);
            await syncDirectory(
              directory,
              "City-model artifact directory",
            );
            await removeFileIfIdentityMatches(
              deletionPath,
              {
                device: moved.dev,
                inode: moved.ino,
              },
              "Replaced city-model artifact restoration",
              directory,
            );
          } catch (error) {
            if (errorCode(error) !== "EEXIST") {
              throw policyError(
                "A replaced city-model artifact could not be restored safely.",
                error,
              );
            }
          }
        } else {
          const preservedPath = path.join(
            directory.canonicalPath,
            `.city-model-preserved-${randomUUID()}`,
          );
          await fs.rename(deletionPath, preservedPath);
          await syncDirectory(
            directory,
            "City-model artifact directory",
          );
        }
        throw policyError(
          "City-model artifact changed during cleanup; the replacement was not removed.",
        );
      }

      await assertArtifactDestinationAbsent(destination);
      await removeFileIfIdentityMatches(
        deletionPath,
        {
          device: opened.status.dev,
          inode: opened.status.ino,
        },
        "City-model artifact cleanup",
        directory,
      );
      await assertArtifactDestinationAbsent(destination);
      const removed = await this.removeArtifactDirectoryIfEmpty(directory);
      if (!removed) {
        await assertArtifactDestinationAbsent(destination);
        throw policyError(
          "City-model artifact directory was not empty after cleanup.",
        );
      }
    } finally {
      if (!handleClosed) {
        await opened.handle.close().catch(() => undefined);
      }
    }
  }

  private async removeCompletedDeletionMarkers(
    directory: TrustedDirectory,
  ): Promise<boolean> {
    const destination = path.join(
      directory.canonicalPath,
      CITY_MODEL_FILE_NAME,
    );
    let published = await inspectPrivateFile(
      destination,
      "City-model artifact",
    );
    let restoredReplacement = false;
    const names = await fs.readdir(directory.canonicalPath);
    for (const name of names) {
      const expected = deletionMarkerIdentity(name);
      if (expected === undefined) continue;
      const deletionPath = path.join(directory.canonicalPath, name);
      const deletion = await inspectPrivateFile(
        deletionPath,
        "Interrupted city-model deletion",
      );
      if (deletion === undefined) continue;
      if (deletion.status.dev === 0n && deletion.status.ino === 0n) {
        throw policyError(
          "Interrupted city-model deletion has no stable filesystem identity.",
        );
      }

      const matchingDestination =
        published !== undefined &&
        deletion.status.dev === published.status.dev &&
        deletion.status.ino === published.status.ino
          ? published
          : undefined;
      if (matchingDestination !== undefined) {
        if (
          deletion.status.nlink !== 2n ||
          matchingDestination.status.nlink !== 2n
        ) {
          throw policyError(
            "Interrupted city-model deletion has an unknown hard-link target.",
          );
        }
        const restoredIdentity = {
          device: deletion.status.dev,
          inode: deletion.status.ino,
        };
        await removeFileIfIdentityMatches(
          deletionPath,
          restoredIdentity,
          "Interrupted replacement restoration cleanup",
          directory,
        );
        const restored = await inspectPrivateFile(
          destination,
          "Restored city-model artifact",
        );
        if (
          restored === undefined ||
          restored.status.nlink !== 1n ||
          restored.status.dev !== restoredIdentity.device ||
          restored.status.ino !== restoredIdentity.inode
        ) {
          throw policyError(
            "Restored city-model artifact changed during recovery.",
          );
        }
        published = restored;
        restoredReplacement = true;
        continue;
      }

      if (
        deletion.status.nlink === 1n &&
        deletion.status.dev === expected.device &&
        deletion.status.ino === expected.inode
      ) {
        await removeFileIfIdentityMatches(
          deletionPath,
          expected,
          "Interrupted city-model deletion cleanup",
          directory,
        );
        continue;
      }
      throw policyError(
        "Interrupted city-model deletion has an unknown identity or hard-link target.",
      );
    }
    return restoredReplacement;
  }

  private async removeArtifactDirectoryIfEmpty(
    directory: TrustedDirectory,
  ): Promise<boolean> {
    await assertTrustedDirectory(
      directory,
      "City-model artifact directory",
    );
    try {
      await fs.rmdir(directory.path);
    } catch (error) {
      if (
        errorCode(error) === "ENOENT"
      ) {
        await syncDirectory(
          this.#artifactsDirectory,
          "Import artifacts directory",
        );
        return true;
      }
      if (
        errorCode(error) === "ENOTEMPTY" ||
        errorCode(error) === "EEXIST"
      ) {
        return false;
      }
      throw error;
    }
    await syncDirectory(
      this.#artifactsDirectory,
      "Import artifacts directory",
    );
    await assertTrustedDirectory(
      this.#artifactsDirectory,
      "Import artifacts directory",
    );
    return true;
  }

  private async recoverInterruptedArtifactPublications(): Promise<void> {
    await assertTrustedDirectory(
      this.#artifactsDirectory,
      "Import artifacts directory",
    );
    const entries = await fs.readdir(
      this.#artifactsDirectory.canonicalPath,
      { withFileTypes: true },
    );
    for (const entry of entries) {
      if (!isImportArtifactToken(entry.name)) continue;
      const directory = await existingDirectChild(
        this.#artifactsDirectory,
        entry.name,
        "City-model artifact directory",
      );
      if (directory === undefined) continue;
      const names = await fs.readdir(directory.canonicalPath);
      const temporaryNames = names.filter((name) =>
        CITY_MODEL_TEMPORARY_FILE_PATTERN.test(name),
      );
      const deletionNames = names.filter(
        (name) => deletionMarkerIdentity(name) !== undefined,
      );
      if (
        temporaryNames.length === 0 &&
        deletionNames.length === 0
      ) {
        continue;
      }

      const destination = path.join(
        directory.canonicalPath,
        CITY_MODEL_FILE_NAME,
      );
      let published = await inspectPrivateFile(
        destination,
        "City-model artifact",
      );

      for (const name of temporaryNames) {
        const temporaryPath = path.join(directory.canonicalPath, name);
        const staged = await inspectPrivateFile(
          temporaryPath,
          "Interrupted city-model stage",
        );
        if (staged === undefined) continue;
        if (staged.status.dev === 0n && staged.status.ino === 0n) {
          throw policyError(
            "Interrupted city-model stage has no stable filesystem identity.",
          );
        }
        const matchingDestination =
          published !== undefined &&
          staged.status.dev === published.status.dev &&
          staged.status.ino === published.status.ino
            ? published
            : undefined;
        const linkedToDestination =
          matchingDestination !== undefined &&
          staged.status.nlink === 2n &&
          matchingDestination.status.nlink === 2n;
        if (
          matchingDestination !== undefined &&
          !linkedToDestination
        ) {
          throw policyError(
            "Interrupted city-model publication has an unknown hard-link target.",
          );
        }
        if (staged.status.nlink !== 1n && !linkedToDestination) {
          throw policyError(
            "Interrupted city-model stage has an unknown hard-link target.",
          );
        }
        if (linkedToDestination) {
          await removeFileIfIdentityMatches(
            destination,
            {
              device: staged.status.dev,
              inode: staged.status.ino,
            },
            "Interrupted city-model publication rollback",
            directory,
          );
          published = undefined;
        }
        await removeFileIfIdentityMatches(
          temporaryPath,
          {
            device: staged.status.dev,
            inode: staged.status.ino,
          },
          "Interrupted city-model publication stage cleanup",
          directory,
        );
      }

      // A standalone marker is removed only when its encoded identity matches.
      // A restoration marker may encode the replaced artifact's old identity;
      // in that case, an exact two-link marker/fixed-name pair proves which
      // marker can be removed without touching the restored replacement.
      await this.removeCompletedDeletionMarkers(directory);

      const recovered = await openArtifactFile(directory);
      await recovered?.handle.close();
    }
  }

  private async sweepAbandonedStagingDirectories(): Promise<void> {
    await assertTrustedDirectory(
      this.#importsDirectory,
      "Import staging directory",
    );
    const entries = await fs.readdir(this.#importsDirectory.canonicalPath, {
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (!isImportArtifactToken(entry.name)) continue;
      const candidate = path.join(
        this.#importsDirectory.canonicalPath,
        entry.name,
      );
      let status;
      try {
        status = await fs.lstat(candidate);
      } catch (error) {
        if (errorCode(error) === "ENOENT") continue;
        throw error;
      }
      if (
        status.isSymbolicLink() ||
        !status.isDirectory()
      ) {
        continue;
      }
      const directory = await existingDirectChild(
        this.#importsDirectory,
        entry.name,
        "Abandoned import staging directory",
      );
      if (directory === undefined) continue;
      await removePrivateDirectory(
        this.#importsDirectory,
        directory,
        "Abandoned import staging directory",
      );
    }
  }
}
