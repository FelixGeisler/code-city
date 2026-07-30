import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  promises as fs,
  type BigIntStats,
} from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

import {
  HISTORY_SEMANTIC_ANALYZER_FINGERPRINT,
  cityModelFromFacts,
  type LocalAnalysisFacts,
  type SourceFileFact,
} from "../../../packages/analyzer/src/index.js";
import type {
  CityBuilding,
  CityModel,
} from "../../../packages/core/src/index.js";

const CACHE_CONTRACT_VERSION = 1;
const CACHE_DIRECTORY_NAME = "history-cache-v1";
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const ENTRY_PATTERN = /^[0-9a-f]{64}\.json$/u;
const TEMPORARY_PATTERN =
  /^\.history-cache-[0-9a-f]{64}-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const MAXIMUM_ENTRY_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAXIMUM_BYTES = 1024 * 1024 * 1024;
const DEFAULT_MAXIMUM_ENTRIES = 10_000;
const MAXIMUM_CANONICAL_DEPTH = 64;
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Cs}]/u;
const PROTOTYPE_LIKE_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

export { HISTORY_SEMANTIC_ANALYZER_FINGERPRINT };

export interface HistorySemanticCacheOptions {
  readonly dataDirectory: string;
  readonly maximumBytes?: number;
  readonly maximumEntries?: number;
}

export interface HistorySemanticCacheRequest {
  /**
   * Canonical source identity used only as hash input. It is never persisted.
   */
  readonly repositoryIdentity: string;
  readonly commitSha: string;
  readonly analyzerFingerprint: string;
  /** Semantic analyzer/input policy only; omit identity and time budgets. */
  readonly configuration: unknown;
}

export interface HistorySemanticCacheLease {
  readonly key: string;
  readonly hit: boolean;
  read(): Promise<LocalAnalysisFacts>;
  release(): void;
}

export interface HistorySemanticCacheExecutionOptions {
  /**
   * Called cooperatively during synchronous cache validation and
   * canonicalization.
   */
  readonly checkpoint?: () => void;
}

interface TrustedDirectory {
  readonly path: string;
  readonly canonicalPath: string;
  readonly device: bigint;
  readonly inode: bigint;
}

interface CacheKey {
  readonly key: string;
  readonly repositoryIdentitySha256: string;
  readonly commitSha: string;
  readonly analyzerFingerprint: string;
  readonly configurationSha256: string;
}

interface CacheEntry extends CacheKey {
  readonly version: typeof CACHE_CONTRACT_VERSION;
  readonly facts: LocalAnalysisFacts;
}

interface CacheResolution {
  readonly facts: LocalAnalysisFacts;
  readonly persisted: boolean;
  readonly wasCached: boolean;
}

interface CacheFile {
  readonly name: string;
  readonly key: string;
  readonly size: number;
  readonly modified: number;
}

class HistoryCacheCorruptionError extends Error {
  public override readonly name = "HistoryCacheCorruptionError";
}

class HistoryCacheCheckpointError extends Error {
  public override readonly name = "HistoryCacheCheckpointError";

  public constructor(public override readonly cause: unknown) {
    super("History cache execution was interrupted.", { cause });
  }
}

class CacheCheckpoint {
  #pending = 0;

  public constructor(
    private readonly callback?: () => void,
  ) {}

  public force(): void {
    this.callback?.();
  }

  public step(operations = 1): void {
    if (this.callback === undefined) return;
    this.#pending += operations;
    if (this.#pending < 256) return;
    this.#pending %= 256;
    this.callback();
  }
}

function errorCode(error: unknown): string | undefined {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
      ? error.code
      : undefined
  );
}

async function isMissing(candidate: string): Promise<boolean> {
  try {
    await fs.lstat(candidate);
    return false;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return true;
    throw error;
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalValue(
  value: unknown,
  depth = 0,
  seen = new Set<object>(),
  checkpoint = new CacheCheckpoint(),
): unknown {
  checkpoint.step();
  if (depth > MAXIMUM_CANONICAL_DEPTH) {
    throw new TypeError("History cache configuration is too deeply nested.");
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    if (
      typeof value === "string" &&
      (value.length > 65_536 || UNSAFE_TEXT.test(value))
    ) {
      throw new TypeError("History cache configuration text is invalid.");
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("History cache configuration number is invalid.");
    }
    return value;
  }
  if (typeof value !== "object" || value === undefined) {
    throw new TypeError("History cache configuration is not JSON-safe.");
  }
  if (seen.has(value)) {
    throw new TypeError("History cache configuration is cyclic.");
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > 10_000) {
        throw new TypeError("History cache configuration array is too large.");
      }
      return value.map((item) =>
        canonicalValue(item, depth + 1, seen, checkpoint),
      );
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      throw new TypeError("History cache configuration object is invalid.");
    }
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort(compareText)) {
      if (
        key.length === 0 ||
        key.length > 256 ||
        UNSAFE_TEXT.test(key) ||
        PROTOTYPE_LIKE_KEYS.has(key)
      ) {
        throw new TypeError("History cache configuration key is invalid.");
      }
      result[key] = canonicalValue(
        (value as Record<string, unknown>)[key],
        depth + 1,
        seen,
        checkpoint,
      );
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

function canonicalJson(
  value: unknown,
  checkpoint?: () => void,
): string {
  const budget = new CacheCheckpoint(checkpoint);
  budget.force();
  const result = JSON.stringify(
    canonicalValue(value, 0, new Set<object>(), budget),
  );
  budget.force();
  return result;
}

function normalizedRequest(
  request: HistorySemanticCacheRequest,
  checkpoint?: () => void,
): CacheKey {
  checkpoint?.();
  if (
    typeof request.repositoryIdentity !== "string" ||
    request.repositoryIdentity.length === 0 ||
    request.repositoryIdentity.length > 4_096 ||
    UNSAFE_TEXT.test(request.repositoryIdentity) ||
    !COMMIT_SHA_PATTERN.test(request.commitSha) ||
    typeof request.analyzerFingerprint !== "string" ||
    request.analyzerFingerprint.length === 0 ||
    request.analyzerFingerprint.length > 160 ||
    UNSAFE_TEXT.test(request.analyzerFingerprint)
  ) {
    throw new TypeError("History semantic cache request is invalid.");
  }
  const repositoryIdentitySha256 = sha256(
    request.repositoryIdentity,
  );
  const configurationSha256 = sha256(
    canonicalJson(request.configuration, checkpoint),
  );
  checkpoint?.();
  const keyMaterial = canonicalJson(
    {
      analyzerFingerprint: request.analyzerFingerprint,
      commitSha: request.commitSha,
      configurationSha256,
      repositoryIdentitySha256,
      version: CACHE_CONTRACT_VERSION,
    },
    checkpoint,
  );
  checkpoint?.();
  return Object.freeze({
    key: sha256(keyMaterial),
    repositoryIdentitySha256,
    commitSha: request.commitSha,
    analyzerFingerprint: request.analyzerFingerprint,
    configurationSha256,
  });
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLocaleLowerCase("en-US") ===
        normalizedRight.toLocaleLowerCase("en-US")
    : normalizedLeft === normalizedRight;
}

async function privateDirectory(
  directory: string,
): Promise<TrustedDirectory> {
  const absolute = path.resolve(directory);
  await fs.mkdir(absolute, { recursive: true, mode: DIRECTORY_MODE });
  if (process.platform !== "win32") {
    await fs.chmod(absolute, DIRECTORY_MODE);
  }
  const status = await fs.lstat(absolute, { bigint: true });
  const canonicalPath = await fs.realpath(absolute);
  if (
    !status.isDirectory() ||
    status.isSymbolicLink() ||
    (process.platform !== "win32" &&
      Number(status.mode & 0o777n) !== DIRECTORY_MODE)
  ) {
    throw new Error("History semantic cache directory is not private.");
  }
  return Object.freeze({
    path: absolute,
    canonicalPath,
    device: status.dev,
    inode: status.ino,
  });
}

async function assertDirectory(
  directory: TrustedDirectory,
): Promise<void> {
  const status = await fs.lstat(directory.path, { bigint: true });
  const canonical = await fs.realpath(directory.path);
  if (
    !status.isDirectory() ||
    status.isSymbolicLink() ||
    !samePath(canonical, directory.canonicalPath) ||
    (directory.device !== 0n &&
      directory.inode !== 0n &&
      (status.dev !== directory.device || status.ino !== directory.inode)) ||
    (process.platform !== "win32" &&
      Number(status.mode & 0o777n) !== DIRECTORY_MODE)
  ) {
    throw new Error("History semantic cache directory changed.");
  }
}

async function syncDirectory(
  directory: TrustedDirectory,
): Promise<void> {
  if (process.platform === "win32") return;
  await assertDirectory(directory);
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(
      directory.canonicalPath,
      constants.O_RDONLY |
        (constants.O_DIRECTORY ?? 0) |
        (constants.O_NOFOLLOW ?? 0),
    );
    await handle.sync();
  } finally {
    await handle?.close().catch(() => undefined);
  }
  await assertDirectory(directory);
}

function exactKeys(
  value: unknown,
  expected: readonly string[],
): value is Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return false;
  }
  const keys = Object.keys(value).sort(compareText);
  const sorted = [...expected].sort(compareText);
  return (
    keys.length === sorted.length &&
    keys.every((key, index) => key === sorted[index])
  );
}

function sourceFact(
  building: CityBuilding,
  districtsById: ReadonlyMap<
    string,
    CityModel["districts"][number]
  >,
  importsValue: unknown,
  checkpoint: CacheCheckpoint,
): SourceFileFact {
  checkpoint.step();
  const district = districtsById.get(building.districtId);
  if (district === undefined || building.metricMethod === undefined) {
    throw new HistoryCacheCorruptionError(
      "History cache semantic facts are incomplete.",
    );
  }
  if (!Array.isArray(importsValue) || importsValue.length > 100_000) {
    throw new HistoryCacheCorruptionError(
      "History cache source imports are invalid.",
    );
  }
  const seenImports = new Set<string>();
  const imports = importsValue.map((value) => {
    checkpoint.step();
    if (
      !exactKeys(value, ["count", "specifier"]) ||
      typeof value["specifier"] !== "string" ||
      value["specifier"].length === 0 ||
      value["specifier"].length > 2_048 ||
      UNSAFE_TEXT.test(value["specifier"]) ||
      typeof value["count"] !== "number" ||
      !Number.isSafeInteger(value["count"]) ||
      value["count"] <= 0 ||
      value["count"] > 1_000_000 ||
      seenImports.has(value["specifier"])
    ) {
      throw new HistoryCacheCorruptionError(
        "History cache source imports are invalid.",
      );
    }
    seenImports.add(value["specifier"]);
    return Object.freeze({
      specifier: value["specifier"],
      count: value["count"],
    });
  });
  checkpoint.force();
  imports.sort((left, right) => {
    checkpoint.step();
    return compareText(left.specifier, right.specifier);
  });
  checkpoint.force();
  return Object.freeze({
    id: building.id,
    repositoryId: building.repositoryId,
    moduleId: building.moduleId,
    districtId: building.districtId,
    districtName: district.name,
    districtPath: district.path,
    name: building.name,
    path: building.path,
    language: building.language,
    metrics: building.metrics,
    metricMethod: building.metricMethod,
    units: Object.freeze([...(building.units ?? [])]),
    risk: building.risk,
    semanticGroupId: building.semanticGroupId,
    imports: Object.freeze(imports),
  });
}

/**
 * Converts unknown persisted facts through the existing model validator and
 * returns a fresh exact-shape semantic representation with no identity/layout.
 */
function sanitizedFacts(
  value: unknown,
  callback?: () => void,
): LocalAnalysisFacts {
  const checkpoint = new CacheCheckpoint(callback);
  checkpoint.force();
  if (
    !exactKeys(value, [
      "dependencies",
      "modules",
      "repositories",
      "solutions",
      "sources",
      "warnings",
    ])
  ) {
    throw new HistoryCacheCorruptionError(
      "History cache facts have an invalid shape.",
    );
  }
  let model: CityModel;
  try {
    model = cityModelFromFacts(
      value as unknown as LocalAnalysisFacts,
      callback === undefined
        ? {}
        : {
            layoutCheckpoint: () => callback(),
            validationCheckpoint: callback,
          },
    );
  } catch (error) {
    if (error instanceof HistoryCacheCheckpointError) throw error;
    throw new HistoryCacheCorruptionError(
      "History cache facts failed semantic validation.",
    );
  }
  checkpoint.force();
  const rawSources = value["sources"];
  if (!Array.isArray(rawSources) || rawSources.length !== model.buildings.length) {
    throw new HistoryCacheCorruptionError(
      "History cache semantic sources are incomplete.",
    );
  }
  const districtsById = new Map<
    string,
    CityModel["districts"][number]
  >();
  for (const district of model.districts) {
    checkpoint.step();
    districtsById.set(district.id, district);
  }
  const rawSourcesById = new Map<string, Record<string, unknown>>();
  for (const source of rawSources) {
    checkpoint.step();
    if (
      typeof source !== "object" ||
      source === null ||
      Array.isArray(source) ||
      typeof (source as Record<string, unknown>)["id"] !== "string"
    ) {
      throw new HistoryCacheCorruptionError(
        "History cache semantic sources are invalid.",
      );
    }
    const record = source as Record<string, unknown>;
    const id = record["id"] as string;
    if (rawSourcesById.has(id)) {
      throw new HistoryCacheCorruptionError(
        "History cache semantic source identities are duplicated.",
      );
    }
    rawSourcesById.set(id, record);
  }
  const sources: SourceFileFact[] = [];
  for (const building of model.buildings) {
    checkpoint.step();
    sources.push(
      sourceFact(
        building,
        districtsById,
        rawSourcesById.get(building.id)?.["imports"],
        checkpoint,
      ),
    );
  }
  checkpoint.force();
  return Object.freeze({
    repositories: Object.freeze([...model.repositories]),
    solutions: Object.freeze([...model.solutions]),
    modules: Object.freeze([...model.modules]),
    sources: Object.freeze(sources),
    dependencies: Object.freeze([...model.dependencies]),
    warnings: Object.freeze([...(model.analysis?.warnings ?? [])]),
  });
}

function entryJson(
  key: CacheKey,
  facts: LocalAnalysisFacts,
  checkpoint?: () => void,
): string {
  return (
    canonicalJson({
      analyzerFingerprint: key.analyzerFingerprint,
      commitSha: key.commitSha,
      configurationSha256: key.configurationSha256,
      facts,
      key: key.key,
      repositoryIdentitySha256: key.repositoryIdentitySha256,
      version: CACHE_CONTRACT_VERSION,
    }, checkpoint) + "\n"
  );
}

function validatedEntry(
  value: unknown,
  expected: CacheKey,
  checkpoint?: () => void,
): CacheEntry {
  if (
    !exactKeys(value, [
      "analyzerFingerprint",
      "commitSha",
      "configurationSha256",
      "facts",
      "key",
      "repositoryIdentitySha256",
      "version",
    ]) ||
    value["version"] !== CACHE_CONTRACT_VERSION ||
    value["key"] !== expected.key ||
    value["repositoryIdentitySha256"] !==
      expected.repositoryIdentitySha256 ||
    value["commitSha"] !== expected.commitSha ||
    value["analyzerFingerprint"] !== expected.analyzerFingerprint ||
    value["configurationSha256"] !== expected.configurationSha256
  ) {
    throw new HistoryCacheCorruptionError(
      "History cache entry identity is invalid.",
    );
  }
  return Object.freeze({
    ...expected,
    version: CACHE_CONTRACT_VERSION,
    facts: sanitizedFacts(value["facts"], checkpoint),
  });
}

async function openEntry(
  directory: TrustedDirectory,
  key: CacheKey,
  checkpoint?: () => void,
): Promise<CacheEntry | undefined> {
  checkpoint?.();
  await assertDirectory(directory);
  const filePath = path.join(
    directory.canonicalPath,
    `${key.key}.json`,
  );
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(
      filePath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
  try {
    const status = await handle.stat({ bigint: true });
    if (
      !status.isFile() ||
      status.isSymbolicLink() ||
      status.nlink !== 1n ||
      status.size < 2n ||
      status.size > BigInt(MAXIMUM_ENTRY_BYTES) ||
      (process.platform !== "win32" &&
        Number(status.mode & 0o777n) !== FILE_MODE)
    ) {
      throw new HistoryCacheCorruptionError(
        "History cache entry violates its file policy.",
      );
    }
    const bytes = await handle.readFile();
    checkpoint?.();
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const parsed = JSON.parse(text) as unknown;
    checkpoint?.();
    const entry = validatedEntry(parsed, key, checkpoint);
    if (entryJson(key, entry.facts, checkpoint) !== text) {
      throw new HistoryCacheCorruptionError(
        "History cache entry is not canonical.",
      );
    }
    return entry;
  } catch (error) {
    if (
      error instanceof HistoryCacheCorruptionError ||
      error instanceof SyntaxError ||
      error instanceof TypeError
    ) {
      throw new HistoryCacheCorruptionError(
        "History cache entry is corrupt.",
      );
    }
    throw error;
  } finally {
    await handle.close().catch(() => undefined);
    await assertDirectory(directory);
  }
}

async function removeEntry(
  directory: TrustedDirectory,
  name: string,
): Promise<void> {
  if (!ENTRY_PATTERN.test(name) && !TEMPORARY_PATTERN.test(name)) {
    throw new Error("Refusing to remove an unknown history cache path.");
  }
  await assertDirectory(directory);
  await fs.unlink(path.join(directory.canonicalPath, name)).catch(
    (error: unknown) => {
      if (errorCode(error) !== "ENOENT") throw error;
    },
  );
  await syncDirectory(directory);
}

async function publishEntry(
  directory: TrustedDirectory,
  key: CacheKey,
  facts: LocalAnalysisFacts,
  checkpoint?: () => void,
): Promise<boolean> {
  const text = entryJson(key, facts, checkpoint);
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength > MAXIMUM_ENTRY_BYTES) {
    throw new Error("History semantic cache entry is too large.");
  }
  const temporaryName =
    `.history-cache-${key.key}-${randomUUID()}.tmp`;
  const temporaryPath = path.join(
    directory.canonicalPath,
    temporaryName,
  );
  const finalPath = path.join(
    directory.canonicalPath,
    `${key.key}.json`,
  );
  let handle: FileHandle | undefined;
  let moved = false;
  let failure: unknown;
  try {
    checkpoint?.();
    await assertDirectory(directory);
    handle = await fs.open(temporaryPath, "wx", FILE_MODE);
    await handle.writeFile(bytes);
    await handle.sync();
    checkpoint?.();
    await handle.close();
    handle = undefined;
    try {
      await fs.rename(temporaryPath, finalPath);
      moved = true;
    } catch (error) {
      if (
        !["EEXIST", "EPERM"].includes(errorCode(error) ?? "") ||
        (await isMissing(finalPath))
      ) {
        throw error;
      }
    }
  } catch (error) {
    failure = error;
  } finally {
    await handle?.close().catch(() => undefined);
    if (!moved) {
      try {
        await fs.unlink(temporaryPath);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") {
          throw new Error(
            "History semantic cache temporary publication cleanup failed.",
            { cause: error },
          );
        }
      }
    }
  }
  if (failure !== undefined) throw failure;
  await syncDirectory(directory);
  return moved;
}

export class HistorySemanticCache {
  readonly #inFlight = new Map<string, Promise<CacheResolution>>();
  readonly #pins = new Map<string, number>();
  #mutationTail: Promise<void> = Promise.resolve();

  private constructor(
    private readonly directory: TrustedDirectory,
    private readonly maximumBytes: number,
    private readonly maximumEntries: number,
  ) {}

  public static async open(
    options: HistorySemanticCacheOptions,
  ): Promise<HistorySemanticCache> {
    const maximumBytes =
      options.maximumBytes ?? DEFAULT_MAXIMUM_BYTES;
    const maximumEntries =
      options.maximumEntries ?? DEFAULT_MAXIMUM_ENTRIES;
    if (
      !Number.isSafeInteger(maximumBytes) ||
      maximumBytes < MAXIMUM_ENTRY_BYTES ||
      maximumBytes > 16 * 1024 * 1024 * 1024 ||
      !Number.isSafeInteger(maximumEntries) ||
      maximumEntries < 1 ||
      maximumEntries > DEFAULT_MAXIMUM_ENTRIES
    ) {
      throw new TypeError("History semantic cache limits are invalid.");
    }
    const data = await privateDirectory(options.dataDirectory);
    const directory = await privateDirectory(
      path.join(data.canonicalPath, CACHE_DIRECTORY_NAME),
    );
    const cache = new HistorySemanticCache(
      directory,
      maximumBytes,
      maximumEntries,
    );
    await cache.sweepTemporaryFiles();
    await cache.evict();
    return cache;
  }

  async #read(
    key: CacheKey,
    repair: boolean,
    checkpoint?: () => void,
  ): Promise<CacheEntry | undefined> {
    try {
      return await openEntry(this.directory, key, checkpoint);
    } catch (error) {
      if (!repair || !(error instanceof HistoryCacheCorruptionError)) {
        throw error;
      }
      await removeEntry(this.directory, `${key.key}.json`);
      return undefined;
    }
  }

  async #withMutation<Value>(
    operation: () => Promise<Value>,
  ): Promise<Value> {
    const previous = this.#mutationTail;
    let release!: () => void;
    this.#mutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async #resolve(
    key: CacheKey,
    compute: () => Promise<LocalAnalysisFacts>,
    execution: HistorySemanticCacheExecutionOptions,
  ): Promise<CacheResolution> {
    const checkpoint = execution.checkpoint;
    checkpoint?.();
    const existing = await this.#withMutation(async () =>
      await this.#read(key, true, checkpoint),
    );
    if (existing !== undefined) {
      return Object.freeze({
        facts: existing.facts,
        persisted: true,
        wasCached: true,
      });
    }

    checkpoint?.();
    const facts = sanitizedFacts(await compute(), checkpoint);
    return await this.#withMutation(async () => {
      checkpoint?.();
      const raced = await this.#read(key, true, checkpoint);
      if (raced !== undefined) {
        return Object.freeze({
          facts: raced.facts,
          persisted: true,
          wasCached: true,
        });
      }
      const size = Buffer.byteLength(
        entryJson(key, facts, checkpoint),
        "utf8",
      );
      if (!(await this.#reserve(key.key, size, checkpoint))) {
        return Object.freeze({
          facts,
          persisted: false,
          wasCached: false,
        });
      }
      const published = await publishEntry(
        this.directory,
        key,
        facts,
        checkpoint,
      );
      if (!published) {
        const winner = await this.#read(key, false, checkpoint);
        if (winner === undefined) {
          throw new Error(
            "History semantic cache publication was lost.",
          );
        }
        return Object.freeze({
          facts: winner.facts,
          persisted: true,
          wasCached: true,
        });
      }
      if (!(await this.evict(new Set([key.key]), checkpoint))) {
        await removeEntry(this.directory, `${key.key}.json`);
        return Object.freeze({
          facts,
          persisted: false,
          wasCached: false,
        });
      }
      return Object.freeze({
        facts,
        persisted: true,
        wasCached: false,
      });
    });
  }

  public async acquire(
    request: HistorySemanticCacheRequest,
    compute: () => Promise<LocalAnalysisFacts>,
    execution: HistorySemanticCacheExecutionOptions = {},
  ): Promise<HistorySemanticCacheLease> {
    if (typeof compute !== "function") {
      throw new TypeError("History semantic cache compute callback is invalid.");
    }
    const checkpoint =
      execution.checkpoint === undefined
        ? undefined
        : () => {
            try {
              execution.checkpoint!();
            } catch (error) {
              throw new HistoryCacheCheckpointError(error);
            }
          };
    let key: CacheKey;
    try {
      key = normalizedRequest(request, checkpoint);
    } catch (error) {
      if (error instanceof HistoryCacheCheckpointError) {
        throw error.cause;
      }
      throw error;
    }
    let operation = this.#inFlight.get(key.key);
    const waited = operation !== undefined;
    let owner = false;
    if (operation === undefined) {
      owner = true;
      operation = this.#resolve(
        key,
        compute,
        checkpoint === undefined ? {} : { checkpoint },
      );
      this.#inFlight.set(key.key, operation);
    }
    let resolution: CacheResolution;
    try {
      try {
        resolution = await operation;
      } catch (error) {
        if (error instanceof HistoryCacheCheckpointError) {
          throw error.cause;
        }
        throw error;
      }
    } finally {
      if (owner && this.#inFlight.get(key.key) === operation) {
        this.#inFlight.delete(key.key);
      }
    }
    if (resolution.persisted) {
      this.#pins.set(key.key, (this.#pins.get(key.key) ?? 0) + 1);
    }
    let released = false;
    return Object.freeze({
      key: key.key,
      hit: waited || resolution.wasCached,
      read: async () => {
        if (released) {
          throw new Error("History semantic cache lease was released.");
        }
        return resolution.facts;
      },
      release: () => {
        if (released) return;
        released = true;
        if (!resolution.persisted) return;
        const count = this.#pins.get(key.key) ?? 0;
        if (count <= 1) this.#pins.delete(key.key);
        else this.#pins.set(key.key, count - 1);
      },
    });
  }

  private async sweepTemporaryFiles(): Promise<void> {
    await assertDirectory(this.directory);
    const entries = await fs.readdir(this.directory.canonicalPath, {
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (
        entry.isFile() &&
        !entry.isSymbolicLink() &&
        TEMPORARY_PATTERN.test(entry.name)
      ) {
        await removeEntry(this.directory, entry.name);
      }
    }
  }

  async #files(
    checkpoint?: () => void,
  ): Promise<readonly CacheFile[]> {
    const work = new CacheCheckpoint(checkpoint);
    work.force();
    await assertDirectory(this.directory);
    const names: string[] = [];
    for (const name of await fs.readdir(
      this.directory.canonicalPath,
    )) {
      work.step();
      if (ENTRY_PATTERN.test(name)) names.push(name);
    }
    work.force();
    names.sort((left, right) => {
      work.step();
      return compareText(left, right);
    });
    work.force();
    const entries: CacheFile[] = [];
    for (const name of names) {
      checkpoint?.();
      let status: BigIntStats;
      try {
        status = await fs.lstat(
          path.join(this.directory.canonicalPath, name),
          { bigint: true },
        );
      } catch (error) {
        if (errorCode(error) === "ENOENT") continue;
        throw error;
      }
      checkpoint?.();
      entries.push({
        name,
        key: name.slice(0, -".json".length),
        size: Number(status.size),
        modified: Number(status.mtimeMs),
      });
    }
    work.force();
    return Object.freeze(entries);
  }

  async #reserve(
    key: string,
    size: number,
    checkpoint?: () => void,
  ): Promise<boolean> {
    if (
      !Number.isSafeInteger(size) ||
      size <= 0 ||
      size > MAXIMUM_ENTRY_BYTES ||
      size > this.maximumBytes
    ) {
      return false;
    }
    const work = new CacheCheckpoint(checkpoint);
    work.force();
    const entries = [...(await this.#files(checkpoint))].sort(
      (left, right) => {
        work.step();
        return (
        left.modified - right.modified ||
        compareText(left.name, right.name)
        );
      },
    );
    work.force();
    let existing: CacheFile | undefined;
    let total = 0;
    for (const entry of entries) {
      work.step();
      total += entry.size;
      if (entry.key === key) existing = entry;
    }
    total = total - (existing?.size ?? 0) + size;
    let count = entries.length + (existing === undefined ? 1 : 0);
    for (const entry of entries) {
      checkpoint?.();
      if (total <= this.maximumBytes && count <= this.maximumEntries) {
        break;
      }
      if (entry.key === key || this.#pins.has(entry.key)) continue;
      await removeEntry(this.directory, entry.name);
      total -= entry.size;
      count -= 1;
    }
    work.force();
    return total <= this.maximumBytes && count <= this.maximumEntries;
  }

  private async evict(
    additionallyProtected: ReadonlySet<string> = new Set(),
    checkpoint?: () => void,
  ): Promise<boolean> {
    const work = new CacheCheckpoint(checkpoint);
    work.force();
    const entries = [...(await this.#files(checkpoint))];
    let total = 0;
    for (const entry of entries) {
      work.step();
      total += entry.size;
    }
    entries.sort((left, right) => {
      work.step();
      return (
        left.modified - right.modified ||
        compareText(left.name, right.name)
      );
    });
    work.force();
    let count = entries.length;
    for (const entry of entries) {
      checkpoint?.();
      if (total <= this.maximumBytes && count <= this.maximumEntries) {
        break;
      }
      if (
        this.#pins.has(entry.key) ||
        additionallyProtected.has(entry.key)
      ) {
        continue;
      }
      await removeEntry(this.directory, entry.name);
      total -= entry.size;
      count -= 1;
    }
    work.force();
    return total <= this.maximumBytes && count <= this.maximumEntries;
  }
}
