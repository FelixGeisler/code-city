import ignorePackage, {
  type Ignore,
  type Options as IgnoreOptions,
} from "ignore";
import { CITY_MODEL_LIMITS } from "../../core/src/model-validation.js";

const MEBIBYTE = 1024 * 1024;

export const DEFAULT_SNAPSHOT_LIMITS = Object.freeze({
  maxEntries: 100_000,
  maxRetainedFiles: 50_000,
  maxSourceBuildings: 25_000,
  maxFileBytes: 2 * MEBIBYTE,
  maxTotalBytes: 256 * MEBIBYTE,
  timeoutMs: 300_000,
  maxDiagnostics: 1_000,
});

export interface SnapshotOptions {
  readonly maxEntries?: number;
  readonly maxRetainedFiles?: number;
  readonly maxSourceBuildings?: number;
  readonly maxFileBytes?: number;
  readonly maxTotalBytes?: number;
  readonly timeoutMs?: number;
  readonly maxDiagnostics?: number;
  readonly signal?: AbortSignal;
}

export interface SnapshotFileSourceEntry {
  readonly kind: "file";
  readonly path: string;
  readonly declaredSize?: number;
  chunks(signal?: AbortSignal): AsyncIterable<Uint8Array>;
}

export interface SnapshotDirectorySourceEntry {
  readonly kind: "directory";
  readonly path: string;
}

export interface SnapshotSymlinkSourceEntry {
  readonly kind: "symlink";
  readonly path: string;
}

export interface SnapshotUnreadableSourceEntry {
  readonly kind: "unreadable";
  readonly path: string;
  readonly message: string;
}

export type SnapshotSourceEntry =
  | SnapshotFileSourceEntry
  | SnapshotDirectorySourceEntry
  | SnapshotSymlinkSourceEntry
  | SnapshotUnreadableSourceEntry;

export interface SnapshotSource {
  readonly repositoryName: string;
  entries(signal?: AbortSignal): AsyncIterable<SnapshotSourceEntry>;
}

export interface SnapshotFile {
  readonly path: string;
  readonly text: string;
  readonly byteLength: number;
}

export type SnapshotDiagnosticCode =
  | "binary"
  | "diagnostics-omitted"
  | "invalid-size"
  | "oversized"
  | "symlink-skipped"
  | "unreadable";

export interface SnapshotDiagnostic {
  readonly code: SnapshotDiagnosticCode;
  readonly path?: string;
  readonly message: string;
}

export interface RepositorySnapshot {
  readonly name: string;
  readonly files: readonly SnapshotFile[];
  readonly diagnostics: readonly SnapshotDiagnostic[];
}

export type SnapshotLimitName =
  | "diagnostics"
  | "entries"
  | "file-bytes"
  | "retained-files"
  | "source-buildings"
  | "total-bytes";

export class SnapshotLimitError extends Error {
  readonly code = "SNAPSHOT_LIMIT_EXCEEDED";

  constructor(
    readonly limitName: SnapshotLimitName,
    readonly limit: number,
    readonly actual: number,
  ) {
    super(
      `Snapshot ${limitName} limit exceeded: allowed ${limit}, observed ${actual}.`,
    );
    this.name = "SnapshotLimitError";
  }
}

export class SnapshotDeadlineError extends Error {
  readonly code = "SNAPSHOT_DEADLINE_EXCEEDED";

  constructor(message = "Snapshot deadline exceeded.") {
    super(message);
    this.name = "SnapshotDeadlineError";
  }
}

export class SnapshotPathError extends Error {
  readonly code = "SNAPSHOT_PATH_REJECTED";

  constructor(message: string) {
    super(message);
    this.name = "SnapshotPathError";
  }
}

export class SnapshotPolicyError extends Error {
  readonly code = "SNAPSHOT_POLICY_REJECTED";

  constructor(
    readonly path: string,
    readonly reason: string,
  ) {
    super(`Snapshot ignore policy was rejected: ${reason}.`);
    this.name = "SnapshotPolicyError";
  }
}

interface ResolvedSnapshotOptions {
  readonly maxEntries: number;
  readonly maxRetainedFiles: number;
  readonly maxSourceBuildings: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  readonly timeoutMs: number;
  readonly maxDiagnostics: number;
  readonly signal?: AbortSignal;
}

interface CollectedEntry {
  readonly entry: SnapshotSourceEntry;
  readonly path: string;
}

interface RepositoryWork {
  readonly name: string;
  readonly sourceIndex: number;
  readonly entries: CollectedEntry[];
  readonly files: SnapshotFile[];
  readonly diagnostics: SnapshotDiagnostic[];
}

interface IgnoreContext {
  readonly directory: string;
  readonly matcher: Ignore;
}

interface Candidate {
  readonly repository: RepositoryWork;
  readonly entry: SnapshotFileSourceEntry;
  readonly path: string;
}

const HARD_EXCLUDED_DIRECTORIES = new Set([
  ".angular",
  ".git",
  "bin",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "obj",
]);

const GENERATED_CSHARP = /\.(?:g(?:\.i)?|generated|designer)\.cs$/iu;
const UNSAFE_PATH_CHARACTERS = /[\p{Cc}\p{Cf}\p{Cs}]/u;
const URI_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/u;
const WINDOWS_DRIVE = /^[A-Za-z]:/u;
const SOURCE_FILE = /\.(?:cs|jsx?|tsx?)$/iu;
const TYPESCRIPT_CONFIG = /^tsconfig(?:\..+)?\.json$/iu;
const SNAPSHOT_DIAGNOSTIC_CODES = new Set<SnapshotDiagnosticCode>([
  "binary",
  "diagnostics-omitted",
  "invalid-size",
  "oversized",
  "symlink-skipped",
  "unreadable",
]);
const createIgnore = ignorePackage.default as (
  options?: IgnoreOptions,
) => Ignore;

function resolveNonNegativeInteger(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer.`);
  }
  return resolved;
}

function resolveOptions(options: SnapshotOptions): ResolvedSnapshotOptions {
  const resolved = {
    maxEntries: resolveNonNegativeInteger(
      options.maxEntries,
      DEFAULT_SNAPSHOT_LIMITS.maxEntries,
      "maxEntries",
    ),
    maxRetainedFiles: resolveNonNegativeInteger(
      options.maxRetainedFiles,
      DEFAULT_SNAPSHOT_LIMITS.maxRetainedFiles,
      "maxRetainedFiles",
    ),
    maxSourceBuildings: resolveNonNegativeInteger(
      options.maxSourceBuildings,
      DEFAULT_SNAPSHOT_LIMITS.maxSourceBuildings,
      "maxSourceBuildings",
    ),
    maxFileBytes: resolveNonNegativeInteger(
      options.maxFileBytes,
      DEFAULT_SNAPSHOT_LIMITS.maxFileBytes,
      "maxFileBytes",
    ),
    maxTotalBytes: resolveNonNegativeInteger(
      options.maxTotalBytes,
      DEFAULT_SNAPSHOT_LIMITS.maxTotalBytes,
      "maxTotalBytes",
    ),
    timeoutMs: resolveNonNegativeInteger(
      options.timeoutMs,
      DEFAULT_SNAPSHOT_LIMITS.timeoutMs,
      "timeoutMs",
    ),
    maxDiagnostics: resolveNonNegativeInteger(
      options.maxDiagnostics,
      DEFAULT_SNAPSHOT_LIMITS.maxDiagnostics,
      "maxDiagnostics",
    ),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
  return resolved;
}

function compareText(left: string, right: string): number {
  const foldedLeft = left.toLocaleLowerCase("en-US");
  const foldedRight = right.toLocaleLowerCase("en-US");
  if (foldedLeft < foldedRight) return -1;
  if (foldedLeft > foldedRight) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

function portablePathKey(value: string): string {
  return value.toLocaleLowerCase("en-US");
}

function normalizeRepositoryName(value: string): string {
  const normalized = value.normalize("NFC");
  if (
    normalized.length === 0 ||
    normalized === "." ||
    normalized === ".." ||
    normalized.includes("/") ||
    normalized.includes("\\") ||
    normalized.length > CITY_MODEL_LIMITS.displayTextCharacters ||
    UNSAFE_PATH_CHARACTERS.test(normalized)
  ) {
    throw new SnapshotPathError("Snapshot repository name is not portable.");
  }
  return normalized;
}

export function normalizeSnapshotPath(value: string): string {
  const normalized = value.replaceAll("\\", "/").normalize("NFC");
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    normalized.startsWith("//") ||
    WINDOWS_DRIVE.test(normalized) ||
    URI_SCHEME.test(normalized) ||
    normalized.length > CITY_MODEL_LIMITS.pathCharacters ||
    UNSAFE_PATH_CHARACTERS.test(normalized)
  ) {
    throw new SnapshotPathError("Snapshot entry path is not portable.");
  }

  const segments = normalized.split("/");
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    throw new SnapshotPathError("Snapshot entry path contains unsafe segments.");
  }
  return segments.join("/");
}

function normalizeDiagnosticPath(value: string): string {
  if (value === ".") return ".";
  return normalizeSnapshotPath(value);
}

export function isAnalyzerInputPath(value: string): boolean {
  const name = value.slice(value.lastIndexOf("/") + 1);
  const lowerName = name.toLocaleLowerCase("en-US");
  return (
    SOURCE_FILE.test(name) ||
    lowerName.endsWith(".csproj") ||
    lowerName.endsWith(".sln") ||
    lowerName.endsWith(".slnx") ||
    lowerName === "angular.json" ||
    TYPESCRIPT_CONFIG.test(name)
  );
}

function isSourceBuildingPath(value: string): boolean {
  return SOURCE_FILE.test(value);
}

export function isHardExcludedSnapshotPath(value: string): boolean {
  const segments = value.split("/");
  if (
    segments.some((segment) =>
      HARD_EXCLUDED_DIRECTORIES.has(segment.toLocaleLowerCase("en-US")),
    )
  ) {
    return true;
  }
  return GENERATED_CSHARP.test(segments.at(-1) ?? value);
}

function isIgnoreControlPath(value: string): boolean {
  const name = value.slice(value.lastIndexOf("/") + 1);
  return name === ".gitignore" || value === ".codecityignore";
}

function directoryOf(value: string): string {
  const index = value.lastIndexOf("/");
  return index === -1 ? "." : value.slice(0, index);
}

function pathWithin(directory: string, candidate: string): string | undefined {
  if (directory === ".") return candidate;
  const prefix = `${directory}/`;
  return candidate.startsWith(prefix) ? candidate.slice(prefix.length) : undefined;
}

function testIgnored(
  contexts: readonly IgnoreContext[],
  candidate: string,
  directory: boolean,
): boolean {
  let ignored = false;
  for (const context of contexts) {
    const relative = pathWithin(context.directory, candidate);
    if (relative === undefined || relative.length === 0) continue;
    const tested = context.matcher.test(directory ? `${relative}/` : relative);
    if (tested.ignored) ignored = true;
    else if (tested.unignored) ignored = false;
  }
  return ignored;
}

function diagnostic(
  code: SnapshotDiagnosticCode,
  message: string,
  path?: string,
): SnapshotDiagnostic {
  return Object.freeze({
    code,
    ...(path === undefined ? {} : { path }),
    message,
  });
}

function ensureDeadline(deadlineAt: number, signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new SnapshotDeadlineError("Snapshot was aborted.");
  }
  if (Date.now() >= deadlineAt) throw new SnapshotDeadlineError();
}

async function withinDeadline<T>(
  operation: PromiseLike<T>,
  deadlineAt: number,
  signal?: AbortSignal,
): Promise<T> {
  ensureDeadline(deadlineAt, signal);
  const remaining = deadlineAt - Date.now();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      callback();
    };
    const abort = (): void =>
      finish(() => reject(new SnapshotDeadlineError("Snapshot was aborted.")));
    const timer = setTimeout(
      () => finish(() => reject(new SnapshotDeadlineError())),
      Math.max(0, remaining),
    );
    signal?.addEventListener("abort", abort, { once: true });
    Promise.resolve(operation).then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

interface ReadEntryResult {
  readonly text: string;
  readonly byteLength: number;
}

async function closeAsyncIterator<T>(
  iterator: AsyncIterator<T>,
  deadlineAt: number,
  signal?: AbortSignal,
): Promise<void> {
  if (!iterator.return) return;
  try {
    await withinDeadline(iterator.return(), deadlineAt, signal);
  } catch (error) {
    if (error instanceof SnapshotDeadlineError) throw error;
  }
}

async function readEntry(
  repository: RepositoryWork,
  candidate: Candidate,
  options: ResolvedSnapshotOptions,
  deadlineAt: number,
  policyFile = false,
): Promise<ReadEntryResult | undefined> {
  const { entry, path } = candidate;
  if (
    entry.declaredSize !== undefined &&
    (!Number.isSafeInteger(entry.declaredSize) || entry.declaredSize < 0)
  ) {
    if (policyFile) {
      throw new SnapshotPolicyError(path, "invalid declared size");
    }
    repository.diagnostics.push(
      diagnostic(
        "invalid-size",
        "The source reported an invalid declared byte size.",
        path,
      ),
    );
    return undefined;
  }
  if (
    entry.declaredSize !== undefined &&
    entry.declaredSize > options.maxFileBytes
  ) {
    if (policyFile) {
      throw new SnapshotPolicyError(path, "per-file byte limit exceeded");
    }
    repository.diagnostics.push(
      diagnostic(
        "oversized",
        `The file exceeds the ${options.maxFileBytes}-byte per-file limit.`,
        path,
      ),
    );
    return undefined;
  }

  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  let iterator: AsyncIterator<Uint8Array> | undefined;
  let completed = false;
  try {
    iterator = entry.chunks(options.signal)[Symbol.asyncIterator]();
    while (true) {
      const next = await withinDeadline(
        iterator.next(),
        deadlineAt,
        options.signal,
      );
      if (next.done) {
        completed = true;
        break;
      }
      if (!(next.value instanceof Uint8Array)) {
        throw new TypeError("Snapshot readers must yield Uint8Array chunks.");
      }
      byteLength += next.value.byteLength;
      if (byteLength > options.maxFileBytes) {
        await closeAsyncIterator(iterator, deadlineAt, options.signal);
        completed = true;
        if (policyFile) {
          throw new SnapshotPolicyError(
            path,
            "per-file byte limit exceeded",
          );
        }
        repository.diagnostics.push(
          diagnostic(
            "oversized",
            `The file exceeds the ${options.maxFileBytes}-byte per-file limit.`,
            path,
          ),
        );
        return undefined;
      }
      chunks.push(next.value);
    }
  } catch (error) {
    if (
      error instanceof SnapshotDeadlineError ||
      error instanceof SnapshotPolicyError
    ) {
      throw error;
    }
    if (policyFile) throw new SnapshotPolicyError(path, "file unreadable");
    repository.diagnostics.push(
      diagnostic("unreadable", "The file could not be read.", path),
    );
    return undefined;
  } finally {
    if (iterator !== undefined && !completed) {
      await closeAsyncIterator(iterator, deadlineAt, options.signal);
    }
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (bytes.includes(0)) {
    if (policyFile) throw new SnapshotPolicyError(path, "binary NUL content");
    repository.diagnostics.push(
      diagnostic("binary", "The file contains NUL bytes.", path),
    );
    return undefined;
  }

  try {
    return {
      text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      byteLength,
    };
  } catch {
    if (policyFile) throw new SnapshotPolicyError(path, "invalid UTF-8");
    repository.diagnostics.push(
      diagnostic("binary", "The file is not valid UTF-8 text.", path),
    );
    return undefined;
  }
}

async function collectEntries(
  repositories: readonly RepositoryWork[],
  sources: readonly SnapshotSource[],
  options: ResolvedSnapshotOptions,
  deadlineAt: number,
): Promise<void> {
  let entryCount = 0;
  for (const repository of repositories) {
    const source = sources[repository.sourceIndex]!;
    const iterator = source.entries(options.signal)[Symbol.asyncIterator]();
    let completed = false;
    try {
      while (true) {
        const next = await withinDeadline(
          iterator.next(),
          deadlineAt,
          options.signal,
        );
        if (next.done) {
          completed = true;
          break;
        }
        entryCount += 1;
        if (entryCount > options.maxEntries) {
          throw new SnapshotLimitError(
            "entries",
            options.maxEntries,
            entryCount,
          );
        }
        const entry = next.value;
        const normalizedPath =
          entry.kind === "unreadable"
            ? normalizeDiagnosticPath(entry.path)
            : normalizeSnapshotPath(entry.path);
        repository.entries.push({ entry, path: normalizedPath });
      }
    } finally {
      if (!completed && iterator.return) {
        await closeAsyncIterator(iterator, deadlineAt, options.signal);
      }
    }
  }
}

function rejectPortableCollisions(repository: RepositoryWork): void {
  const seen = new Map<string, string>();
  for (const candidate of repository.entries) {
    if (candidate.path === ".") continue;
    const key = portablePathKey(candidate.path);
    const previous = seen.get(key);
    if (previous !== undefined) {
      throw new SnapshotPathError(
        "Portable snapshot paths collide after case and Unicode normalization.",
      );
    }
    seen.set(key, candidate.path);
  }
}

function hasSymlinkAncestor(
  candidatePath: string,
  symlinkPaths: ReadonlySet<string>,
): boolean {
  let separator = candidatePath.lastIndexOf("/");
  while (separator !== -1) {
    if (symlinkPaths.has(candidatePath.slice(0, separator))) return true;
    separator = candidatePath.lastIndexOf("/", separator - 1);
  }
  return false;
}

function discardSymlinkDescendants(repository: RepositoryWork): void {
  const symlinkPaths = new Set(
    repository.entries
      .filter(({ entry }) => entry.kind === "symlink")
      .map(({ path }) => path),
  );
  if (symlinkPaths.size === 0) return;
  const safeEntries = repository.entries.filter(
    ({ path }) => !hasSymlinkAncestor(path, symlinkPaths),
  );
  repository.entries.splice(0, repository.entries.length, ...safeEntries);
}

async function buildIgnoreContexts(
  repository: RepositoryWork,
  options: ResolvedSnapshotOptions,
  deadlineAt: number,
): Promise<{
  readonly git: readonly IgnoreContext[];
  readonly codeCity?: IgnoreContext;
}> {
  const git: IgnoreContext[] = [];
  let codeCity: IgnoreContext | undefined;
  const controls = repository.entries
    .filter(
      (candidate): candidate is CollectedEntry & {
        readonly entry: SnapshotFileSourceEntry;
      } =>
        candidate.entry.kind === "file" &&
        isIgnoreControlPath(candidate.path) &&
        !isHardExcludedSnapshotPath(candidate.path),
    )
    .sort(
      (left, right) =>
        directoryOf(left.path).split("/").length -
          directoryOf(right.path).split("/").length ||
        compareText(left.path, right.path),
    );

  for (const control of controls) {
    const directory = directoryOf(control.path);
    if (
      control.path !== ".codecityignore" &&
      testIgnored(git, directory, true)
    ) {
      continue;
    }
    const text = await readEntry(
      repository,
      {
        repository,
        entry: control.entry,
        path: control.path,
      },
      options,
      deadlineAt,
      true,
    );
    if (text === undefined) continue;
    let matcher: Ignore;
    try {
      matcher = createIgnore({ ignorecase: true }).add(text.text);
    } catch {
      throw new SnapshotPolicyError(control.path, "invalid ignore rules");
    }
    const context = { directory, matcher };
    if (control.path === ".codecityignore") codeCity = context;
    else git.push(context);
  }
  return {
    git,
    ...(codeCity === undefined ? {} : { codeCity }),
  };
}

function compareDiagnosticRecords(
  left: { readonly repository: RepositoryWork; readonly value: SnapshotDiagnostic },
  right: { readonly repository: RepositoryWork; readonly value: SnapshotDiagnostic },
): number {
  return (
    compareText(left.repository.name, right.repository.name) ||
    left.repository.sourceIndex - right.repository.sourceIndex ||
    compareText(left.value.path ?? "", right.value.path ?? "") ||
    compareText(left.value.code, right.value.code) ||
    compareText(left.value.message, right.value.message)
  );
}

function capDiagnostics(
  repositories: readonly RepositoryWork[],
  maxDiagnostics: number,
): void {
  const records = repositories
    .flatMap((repository) =>
      repository.diagnostics.map((value) => ({ repository, value })),
    )
    .sort(compareDiagnosticRecords);
  for (const repository of repositories) repository.diagnostics.splice(0);

  for (const record of records.slice(0, maxDiagnostics)) {
    record.repository.diagnostics.push(record.value);
  }
  const omitted = records.length - Math.min(records.length, maxDiagnostics);
  if (omitted > 0 && repositories[0]) {
    repositories[0].diagnostics.push(
      diagnostic(
        "diagnostics-omitted",
        `${omitted} additional snapshot diagnostics were omitted.`,
      ),
    );
  }
}

function immutableSnapshots(
  repositories: readonly RepositoryWork[],
): readonly RepositorySnapshot[] {
  return Object.freeze(
    repositories.map((repository) =>
      Object.freeze({
        name: repository.name,
        files: Object.freeze(
          [...repository.files].sort((left, right) =>
            compareText(left.path, right.path),
          ),
        ),
        diagnostics: Object.freeze(
          [...repository.diagnostics].sort((left, right) => {
            if (
              left.code === "diagnostics-omitted" &&
              right.code !== "diagnostics-omitted"
            ) {
              return 1;
            }
            if (
              right.code === "diagnostics-omitted" &&
              left.code !== "diagnostics-omitted"
            ) {
              return -1;
            }
            return (
              compareText(left.path ?? "", right.path ?? "") ||
              compareText(left.code, right.code) ||
              compareText(left.message, right.message)
            );
          }),
        ),
      }),
    ),
  );
}

export async function materializeRepositorySnapshots(
  sources: readonly SnapshotSource[],
  options: SnapshotOptions = {},
): Promise<readonly RepositorySnapshot[]> {
  const resolved = resolveOptions(options);
  const deadlineAt = Date.now() + resolved.timeoutMs;
  ensureDeadline(deadlineAt, resolved.signal);

  const repositories = sources
    .map((source, sourceIndex) => ({
      name: normalizeRepositoryName(source.repositoryName),
      sourceIndex,
      entries: [] as CollectedEntry[],
      files: [] as SnapshotFile[],
      diagnostics: [] as SnapshotDiagnostic[],
    }))
    .sort(
      (left, right) =>
        compareText(left.name, right.name) ||
        left.sourceIndex - right.sourceIndex,
    );

  await collectEntries(repositories, sources, resolved, deadlineAt);
  for (const repository of repositories) {
    repository.entries.sort((left, right) =>
      compareText(left.path, right.path),
    );
    rejectPortableCollisions(repository);
    // A defensive adapter boundary: even if a source accidentally enumerates
    // below a directory symlink, no descendant policy or source bytes are read.
    discardSymlinkDescendants(repository);
  }

  const candidates: Candidate[] = [];
  for (const repository of repositories) {
    const contexts = await buildIgnoreContexts(
      repository,
      resolved,
      deadlineAt,
    );
    for (const collected of repository.entries) {
      const { entry, path } = collected;
      const policyPath =
        path !== "." &&
        isIgnoreControlPath(path) &&
        !isHardExcludedSnapshotPath(path);
      const ignoredPolicyPath =
        policyPath &&
        path !== ".codecityignore" &&
        directoryOf(path) !== "." &&
        testIgnored(contexts.git, directoryOf(path), true);
      if (entry.kind === "symlink") {
        if (ignoredPolicyPath) continue;
        if (policyPath) {
          throw new SnapshotPolicyError(path, "symbolic link not permitted");
        }
        repository.diagnostics.push(
          diagnostic(
            "symlink-skipped",
            "The symbolic link was not followed.",
            path,
          ),
        );
        continue;
      }
      if (entry.kind === "unreadable") {
        if (ignoredPolicyPath) continue;
        if (policyPath) {
          throw new SnapshotPolicyError(path, "entry unreadable");
        }
        repository.diagnostics.push(
          diagnostic("unreadable", "The entry could not be read.", path),
        );
        continue;
      }
      if (
        entry.kind !== "file" ||
        isHardExcludedSnapshotPath(path) ||
        isIgnoreControlPath(path) ||
        !isAnalyzerInputPath(path)
      ) {
        continue;
      }
      const gitIgnored = testIgnored(contexts.git, path, false);
      const ignored =
        contexts.codeCity === undefined
          ? gitIgnored
          : (() => {
              const override = contexts.codeCity.matcher.test(path);
              if (override.ignored) return true;
              if (override.unignored) return false;
              return gitIgnored;
            })();
      if (!ignored) candidates.push({ repository, entry, path });
    }
  }
  candidates.sort(
    (left, right) =>
      compareText(left.repository.name, right.repository.name) ||
      left.repository.sourceIndex - right.repository.sourceIndex ||
      compareText(left.path, right.path),
  );

  let retainedFiles = 0;
  let sourceBuildings = 0;
  let totalBytes = 0;
  for (const candidate of candidates) {
    ensureDeadline(deadlineAt, resolved.signal);
    const content = await readEntry(
      candidate.repository,
      candidate,
      resolved,
      deadlineAt,
    );
    if (content === undefined) continue;
    const { text, byteLength } = content;

    retainedFiles += 1;
    if (retainedFiles > resolved.maxRetainedFiles) {
      throw new SnapshotLimitError(
        "retained-files",
        resolved.maxRetainedFiles,
        retainedFiles,
      );
    }
    if (isSourceBuildingPath(candidate.path)) {
      sourceBuildings += 1;
      if (sourceBuildings > resolved.maxSourceBuildings) {
        throw new SnapshotLimitError(
          "source-buildings",
          resolved.maxSourceBuildings,
          sourceBuildings,
        );
      }
    }
    totalBytes += byteLength;
    if (totalBytes > resolved.maxTotalBytes) {
      throw new SnapshotLimitError(
        "total-bytes",
        resolved.maxTotalBytes,
        totalBytes,
      );
    }
    candidate.repository.files.push(
      Object.freeze({ path: candidate.path, text, byteLength }),
    );
  }

  capDiagnostics(repositories, resolved.maxDiagnostics);
  ensureDeadline(deadlineAt, resolved.signal);
  return immutableSnapshots(repositories);
}

export async function materializeRepositorySnapshot(
  source: SnapshotSource,
  options: SnapshotOptions = {},
): Promise<RepositorySnapshot> {
  const snapshots = await materializeRepositorySnapshots([source], options);
  return snapshots[0]!;
}

export function assertRepositorySnapshots(
  snapshots: readonly RepositorySnapshot[],
  options: SnapshotOptions = {},
): void {
  const resolved = resolveOptions(options);
  let retainedFiles = 0;
  let sourceBuildings = 0;
  let totalBytes = 0;
  let persistedDiagnostics = 0;
  let omissionSummaries = 0;

  for (const snapshot of snapshots) {
    normalizeRepositoryName(snapshot.name);
    const paths = new Map<string, string>();
    for (const file of snapshot.files) {
      const normalized = normalizeSnapshotPath(file.path);
      if (normalized !== file.path) {
        throw new SnapshotPathError("Snapshot file path is not normalized.");
      }
      const key = portablePathKey(normalized);
      const previous = paths.get(key);
      if (previous !== undefined) {
        throw new SnapshotPathError(
          "Portable snapshot paths collide after case and Unicode normalization.",
        );
      }
      paths.set(key, normalized);
      if (
        isHardExcludedSnapshotPath(normalized) ||
        !isAnalyzerInputPath(normalized)
      ) {
        throw new SnapshotPathError(
          "Snapshot file is not an admitted analyzer input.",
        );
      }
      if (file.text.includes("\u0000")) {
        throw new SnapshotPathError(
          "Snapshot file contains binary NUL content.",
        );
      }
      if (
        !Number.isSafeInteger(file.byteLength) ||
        file.byteLength < new TextEncoder().encode(file.text).byteLength
      ) {
        throw new SnapshotPathError(
          "Snapshot file has an invalid byte length.",
        );
      }
      if (file.byteLength > resolved.maxFileBytes) {
        throw new SnapshotLimitError(
          "file-bytes",
          resolved.maxFileBytes,
          file.byteLength,
        );
      }

      retainedFiles += 1;
      if (retainedFiles > resolved.maxRetainedFiles) {
        throw new SnapshotLimitError(
          "retained-files",
          resolved.maxRetainedFiles,
          retainedFiles,
        );
      }
      if (isSourceBuildingPath(normalized)) {
        sourceBuildings += 1;
        if (sourceBuildings > resolved.maxSourceBuildings) {
          throw new SnapshotLimitError(
            "source-buildings",
            resolved.maxSourceBuildings,
            sourceBuildings,
          );
        }
      }
      totalBytes += file.byteLength;
      if (totalBytes > resolved.maxTotalBytes) {
        throw new SnapshotLimitError(
          "total-bytes",
          resolved.maxTotalBytes,
          totalBytes,
        );
      }
    }
    for (const diagnosticValue of snapshot.diagnostics) {
      if (!SNAPSHOT_DIAGNOSTIC_CODES.has(diagnosticValue.code)) {
        throw new SnapshotPathError("Snapshot diagnostic code is invalid.");
      }
      if (diagnosticValue.code === "diagnostics-omitted") {
        omissionSummaries += 1;
        if (omissionSummaries > 1) {
          throw new SnapshotPathError(
            "Snapshot contains multiple diagnostic omission summaries.",
          );
        }
      } else {
        persistedDiagnostics += 1;
      }
      if (persistedDiagnostics > resolved.maxDiagnostics) {
        throw new SnapshotLimitError(
          "diagnostics",
          resolved.maxDiagnostics,
          persistedDiagnostics,
        );
      }
      if (
        diagnosticValue.path !== undefined &&
        normalizeDiagnosticPath(diagnosticValue.path) !== diagnosticValue.path
      ) {
        throw new SnapshotPathError(
          "Snapshot diagnostic path is not normalized.",
        );
      }
    }
  }
}

export function findSnapshotFile(
  snapshot: RepositorySnapshot,
  filePath: string,
): SnapshotFile | undefined {
  const normalized = normalizeSnapshotPath(filePath);
  return snapshot.files.find(({ path }) => path === normalized);
}

export function readSnapshotFileText(
  snapshot: RepositorySnapshot,
  filePath: string,
): string | undefined {
  return findSnapshotFile(snapshot, filePath)?.text;
}
