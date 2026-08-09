import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  promises as fs,
  type BigIntStats,
  type Stats,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_SNAPSHOT_LIMITS,
  isAnalyzerCandidateSourcePath,
  materializeRepositorySnapshot,
  normalizeSnapshotPath,
  type RepositorySnapshot,
  type SnapshotOptions,
} from "./snapshot.js";
import {
  createGenericGitCredentialBroker,
  isSafeGenericGitCredentialLine,
  type GenericGitCredentialBroker,
  type GenericGitCredentialBrokerFactory,
} from "./git-credential-broker.js";
import {
  HISTORY_CHANGED_PATH_RECORD_OVERHEAD_BYTES,
} from "./history-selection.js";
import {
  GENERIC_GIT_ARCHIVE_MAX_BYTES,
  genericGitZipOptions as zipOptions,
  gitMaterializationOptions as materializationOptions,
  readGenericGitArchive as readArchive,
} from "./git-archive-materialization.js";
export { GENERIC_GIT_ARCHIVE_MAX_BYTES } from "./git-archive-materialization.js";
import {
  decodeGitOutput,
  lsRemoteOperation,
  oneRecord,
  parseLsRemote,
  sameSelection,
  selectRef,
  type RefSelection,
} from "./git-ref-protocol.js";
import {
  genericGitRepositoryOrigin,
  parseGenericGitRemote as parseRemote,
  validateGenericGitRef as validateRef,
  validateGenericGitRef,
  validateGenericGitRepositoryUrl,
  type GenericGitRemoteOrigin,
  type GenericGitTransport,
  type ParsedGenericGitRemote as ParsedRemote,
} from "./git-remote-validation.js";
export {
  genericGitRepositoryOrigin,
  validateGenericGitRef,
  validateGenericGitRepositoryUrl,
} from "./git-remote-validation.js";
export type { GenericGitRemoteOrigin, GenericGitTransport } from "./git-remote-validation.js";
import { GenericGitSnapshotError } from "./git-snapshot-error.js";
export { GenericGitSnapshotError } from "./git-snapshot-error.js";
export type { GenericGitSnapshotErrorCode } from "./git-snapshot-error.js";

import {
  openZipSnapshotSource,
  type DisposableSnapshotSource,
} from "./zip-snapshot-source.js";

const MEBIBYTE = 1024 * 1024;
const COMMIT_SHA = /^[0-9a-f]{40}$/u;
const INVALID_INPUT_CHARACTERS = /[\p{Cc}\p{Cf}\p{Cs}]/u;
const MAX_GIT_OUTPUT_BYTES = MEBIBYTE;
const MAX_GIT_HISTORY_INDEX_BYTES = 32 * MEBIBYTE;
const MAX_GIT_DIAGNOSTIC_BYTES = 64 * 1024;
const MAX_TEMPORARY_BYTES = 2 * 1024 * MEBIBYTE;
const MAX_TIMEOUT_MS = 2_147_483_647;
const ARCHIVE_FILE_NAME = "snapshot.zip";
const HISTORY_PROMISOR_REMOTE = "codecity-history";
const HISTORY_PARTIAL_CLONE_FILTER = "tree:0";
const INTERNAL_ABORT = Object.freeze({ kind: "git-snapshot-abort" });

export const GENERIC_GIT_SNAPSHOT_TIMEOUT_MS =
  DEFAULT_SNAPSHOT_LIMITS.timeoutMs;
export const GENERIC_GIT_TEMPORARY_MAX_BYTES = MAX_TEMPORARY_BYTES;
export const GENERIC_GIT_HISTORY_MAX_COMMITS = 500;
export const GENERIC_GIT_ROOT_TO_TIP_HISTORY_MAX_COMMITS = 100_000;
export const GENERIC_GIT_HISTORY_INDEX_MAX_BYTES =
  MAX_GIT_HISTORY_INDEX_BYTES;
export const GENERIC_GIT_HISTORY_MAX_CHANGED_PATHS = 500_000;
export const GENERIC_GIT_HISTORY_MAX_CHANGED_PATH_BYTES =
  16 * MEBIBYTE;
export const GENERIC_GIT_PROJECT_START_MAX_PATHS = 500_000;
export const GENERIC_GIT_PROJECT_START_MAX_PATH_BYTES = 16 * MEBIBYTE;
export const GENERIC_GIT_HISTORY_CHANGED_PATH_RECORD_OVERHEAD_BYTES =
  HISTORY_CHANGED_PATH_RECORD_OVERHEAD_BYTES;
export const GENERIC_GIT_HISTORY_RENAME_POLICY_REVISION =
  "sampled-boundary-diff-tree-renames-50-myers-v2" as const;
export const GENERIC_GIT_PRESECURED_WINDOWS_ACL =
  "pre-secured-private-directory" as const;
export const GENERIC_GIT_PRESECURED_CANONICAL_ANCESTRY =
  "pre-secured-canonical-entry-and-ancestry-against-rename-delete" as const;

export interface GenericGitSnapshotRequest {
  readonly repositoryUrl: string;
  readonly ref?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly snapshotOptions?: SnapshotOptions;
}

export interface GenericGitSnapshotCredential {
  readonly kind: "basic";
  readonly username: string;
  readonly secret: Uint8Array;
}

export interface GenericGitSnapshotCredentialProvider {
  readonly provider: "basic";
  use<T>(
    signal: AbortSignal,
    operation: (
      credential: GenericGitSnapshotCredential,
    ) => T | Promise<T>,
  ): Promise<T>;
}

export interface GitProcessRequest {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly shell: false;
  readonly windowsHide: true;
  readonly timeoutMs: number;
  readonly maximumStdoutBytes: number;
  readonly maximumStderrBytes: number;
  readonly signal: AbortSignal;
}

export interface GitProcessResult {
  readonly exitCode: number;
  readonly stdout: Uint8Array;
  /** Bounded diagnostics are retained only for explicit protocol checks. */
  readonly stderr?: Uint8Array;
}

export type GenericGitRunGit = (
  request: GitProcessRequest,
) => Promise<GitProcessResult>;

export interface GenericGitTemporaryWorkspace {
  readonly root: string;
  readonly repositoryDirectory: string;
  readonly templateDirectory: string;
  /**
   * Revalidates the filesystem objects backing the workspace. The built-in
   * implementation uses this immediately before path-based Git operations.
   */
  readonly validateSecurityBoundary?: () => Promise<void>;
  measureBytes(
    maximumBytes: number,
    signal: AbortSignal,
  ): Promise<number>;
  dispose(): Promise<void>;
}

/**
 * A custom parent is a security boundary, not merely a location hint.
 *
 * On POSIX the implementation verifies the existing, process-owned mode-0700
 * directory and every canonical ancestor. Node cannot prove Windows ACL
 * privacy or delete-child rights, so a Windows deployment must pre-secure the
 * parent and inherited child ACLs against untrusted content access. It must
 * separately protect the canonical path entries against untrusted rename,
 * delete, and delete-child access, then explicitly attest those preconditions.
 */
export interface GenericGitTrustedPrivateParent {
  readonly directory: string;
  readonly windowsAclProtection: typeof GENERIC_GIT_PRESECURED_WINDOWS_ACL;
  readonly canonicalAncestryProtection: typeof GENERIC_GIT_PRESECURED_CANONICAL_ANCESTRY;
}

export interface GenericGitTemporaryWorkspaceOptions {
  readonly trustedPrivateParent: GenericGitTrustedPrivateParent;
}

export interface GenericGitSnapshotDependencies {
  readonly runGit?: GenericGitRunGit;
  readonly createTemporaryWorkspace?: () => Promise<GenericGitTemporaryWorkspace>;
  readonly temporaryWorkspaceOptions?: GenericGitTemporaryWorkspaceOptions;
  readonly credentialProvider?: GenericGitSnapshotCredentialProvider;
  /**
   * Removes HOME/XDG/SSH-agent/system/global credential sources even when no
   * explicit provider is selected. Public/anonymous callers should enable it.
   */
  readonly isolateCredentials?: boolean;
  /** Test seam; production callers use the bundled one-shot .NET broker. */
  readonly createCredentialBroker?: GenericGitCredentialBrokerFactory;
  readonly openZipSnapshotSource?: typeof openZipSnapshotSource;
  readonly materializeRepositorySnapshot?: typeof materializeRepositorySnapshot;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly gitExecutable?: string;
}

export interface GenericGitSnapshotResult {
  readonly repository: string;
  readonly commitSha: string;
  readonly transport: GenericGitTransport;
  readonly snapshot: RepositorySnapshot;
}

export type GenericGitHistoryPathChange =
  | {
      readonly kind: "added" | "deleted" | "modified" | "type-changed";
      readonly path: string;
    }
  | {
      readonly kind: "renamed";
      readonly previousPath: string;
      readonly path: string;
    };

export interface GenericGitHistoryCommit {
  readonly sha: string;
  /** All parents in Git's canonical order. Traversal follows parents[0]. */
  readonly parents: readonly string[];
  /** Exact non-negative Git committer timestamp in Unix seconds. */
  readonly committedAtSeconds: number;
  readonly committedAt: string;
}

export interface GenericGitHistoryTag {
  /** Validated exact tag name, retained only for in-memory selection. */
  readonly name: string;
  readonly commitSha: string;
}

export interface GenericGitHistoryRequest
  extends Omit<GenericGitSnapshotRequest, "snapshotOptions"> {
  /**
   * Root traversal uses a larger metadata-only ceiling. Bounded is the safe
   * backward-compatible default for recent/date/tag custom selections.
   */
  readonly traversal?: "bounded" | "root-to-tip";
  /** Bound for the selected first-parent chain, excluding the overflow probe. */
  readonly maximumCommits: number;
  /**
   * Aggregate retained changed-path entry limit. Callers may lower, but not
   * raise, the acquisition hard limit.
   */
  readonly maximumChangedPathEntries?: number;
  /**
   * Aggregate UTF-8 path bytes plus conservative per-record object overhead.
   * This is enforced while Git output is parsed.
   */
  readonly maximumChangedPathBytes?: number;
  readonly tagNames?: readonly string[];
  readonly snapshotOptions?: SnapshotOptions;
}

export interface GenericGitHistoryBackend {
  readonly name: "git";
  /** Validated, locale-stable version suffix from `git --version`. */
  readonly version: string;
  readonly renamePolicyRevision: typeof GENERIC_GIT_HISTORY_RENAME_POLICY_REVISION;
}

/**
 * A callback-scoped, private Git history view. Methods become invalid as soon
 * as the callback returns, and accept only commits/edges from this session.
 */
export interface GenericGitHistorySession {
  readonly repository: string;
  readonly tipSha: string;
  readonly transport: GenericGitTransport;
  /** Whether the oldest indexed first-parent commit is a shallow boundary. */
  readonly oldestCommitIsShallow: boolean;
  /** Output-affecting Git implementation and pinned rename-policy revision. */
  readonly backend: GenericGitHistoryBackend;
  /** Newest-to-oldest first-parent commits, including one overflow probe. */
  readonly commits: readonly GenericGitHistoryCommit[];
  readonly tags: readonly GenericGitHistoryTag[];
  /** Detects the oldest mainline commit containing candidate source. */
  detectProjectStart(): Promise<string | undefined>;
  readChanges(
    commitSha: string,
  ): Promise<readonly GenericGitHistoryPathChange[]>;
  /**
   * Returns the aggregate tree delta from an older known first-parent commit
   * to a newer known descendant. Intermediate commits are intentionally not
   * materialized or retained.
   */
  readChangesBetween(
    olderSha: string,
    newerSha: string,
  ): Promise<readonly GenericGitHistoryPathChange[]>;
  readSnapshot(commitSha: string): Promise<RepositorySnapshot>;
}

export type GenericGitHistoryConsumer<T> = (
  session: GenericGitHistorySession,
) => Promise<T>;

interface GitCredentialTarget {
  readonly host: string;
  readonly path: string;
}

interface CombinedDeadline {
  readonly signal: AbortSignal;
  remainingMilliseconds(): number;
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function invalidCredentialProvider(): GenericGitSnapshotError {
  return new GenericGitSnapshotError(
    "GIT_INVALID_REQUEST",
    "Generic Git credential provider is invalid.",
  );
}

function credentialTarget(remote: ParsedRemote): GitCredentialTarget {
  if (remote.transport !== "https") throw invalidCredentialProvider();
  const parsed = new URL(remote.value);
  const rawSegments = parsed.pathname.slice(1).split("/");
  let canonicalSegments = true;
  for (const segment of rawSegments) {
    if (
      segment.length === 0 ||
      !/^[\u0021-\u007e]+$/u.test(segment)
    ) {
      canonicalSegments = false;
      break;
    }
    for (let index = 0; index < segment.length; index += 1) {
      if (segment[index] !== "%") continue;
      if (
        !/^[0-9A-F]{2}$/u.test(segment.slice(index + 1, index + 3))
      ) {
        canonicalSegments = false;
        break;
      }
      index += 2;
    }
    if (!canonicalSegments) break;
    const decodedSegment = decodeURIComponent(segment);
    if (
      decodedSegment === "." ||
      decodedSegment === ".." ||
      decodedSegment.includes("/") ||
      decodedSegment.includes("\\") ||
      INVALID_INPUT_CHARACTERS.test(decodedSegment)
    ) {
      canonicalSegments = false;
      break;
    }
  }
  const decodedPath = decodeURIComponent(parsed.pathname).replace(
    /^\/+/u,
    "",
  );
  if (
    parsed.protocol !== "https:" ||
    parsed.host.length === 0 ||
    decodedPath.length === 0 ||
    remote.value !== parsed.href ||
    !canonicalSegments ||
    utf8Length(decodedPath) > 4 * 1024
  ) {
    throw invalidCredentialProvider();
  }
  return Object.freeze({
    host: parsed.host,
    path: decodedPath,
  });
}

function validateCredentialProvider(
  provider: GenericGitSnapshotCredentialProvider | undefined,
  remote: ParsedRemote,
): GenericGitSnapshotCredentialProvider | undefined {
  if (provider === undefined) return undefined;
  try {
    if (
      remote.transport !== "https" ||
      provider === null ||
      typeof provider !== "object" ||
      provider.provider !== "basic" ||
      typeof provider.use !== "function"
    ) {
      throw invalidCredentialProvider();
    }
  } catch {
    throw invalidCredentialProvider();
  }
  return provider;
}

function copyCredential(
  value: GenericGitSnapshotCredential,
): {
  readonly username: string;
  readonly secret: Uint8Array;
} {
  let kind: unknown;
  let username: unknown;
  let secret: unknown;
  try {
    kind = value?.kind;
    username = value?.username;
    secret = value?.secret;
  } catch {
    throw invalidCredentialProvider();
  }
  if (
    kind !== "basic" ||
    typeof username !== "string" ||
    username.length === 0 ||
    username.length > 256 ||
    username !== username.trim() ||
    username !== username.normalize("NFC") ||
    !/^[\u0020-\u007e]+$/u.test(username) ||
    username.includes(":") ||
    !(secret instanceof Uint8Array) ||
    secret.byteLength === 0 ||
    secret.byteLength > 8 * 1024 ||
    !isSafeGenericGitCredentialLine(secret)
  ) {
    throw invalidCredentialProvider();
  }
  const copy = new Uint8Array(secret.byteLength);
  copy.set(secret);
  return { username, secret: copy };
}

function resolveTimeout(value: number | undefined): number {
  const timeout = value ?? GENERIC_GIT_SNAPSHOT_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeout) ||
    timeout <= 0 ||
    timeout > MAX_TIMEOUT_MS
  ) {
    throw new GenericGitSnapshotError(
      "GIT_DEADLINE_EXCEEDED",
      "Generic Git timeout must be a positive integer.",
    );
  }
  return timeout;
}

function resolveCredentialIsolation(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") {
    throw new GenericGitSnapshotError(
      "GIT_INVALID_REQUEST",
      "Generic Git credential isolation must be a boolean.",
    );
  }
  return value;
}

function safeEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
  const permitted = new Set([
    "APPDATA",
    "HOME",
    "HOMEDRIVE",
    "HOMEPATH",
    "LOCALAPPDATA",
    "NO_PROXY",
    "PATH",
    "SSH_AGENT_PID",
    "SSH_AUTH_SOCK",
    "SSL_CERT_DIR",
    "SSL_CERT_FILE",
    "SYSTEMROOT",
    "TEMP",
    "TMP",
    "TMPDIR",
    "USERPROFILE",
    "WINDIR",
    "XDG_CONFIG_HOME",
    "GIT_SSL_CAINFO",
    "GIT_SSL_CAPATH",
    "HTTP_PROXY",
    "HTTPS_PROXY",
  ]);
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    const canonicalKey = key.toLocaleUpperCase("en-US");
    if (value !== undefined && permitted.has(canonicalKey)) {
      result[canonicalKey] = value;
    }
  }
  result["GIT_TERMINAL_PROMPT"] = "0";
  result["GCM_INTERACTIVE"] = "Never";
  result["LC_ALL"] = "C";
  result["LANG"] = "C";
  return Object.freeze(result);
}

async function selectedCredentialEnvironment(
  environment: Readonly<Record<string, string>>,
  workspace: GenericGitTemporaryWorkspace,
  deadline: CombinedDeadline,
): Promise<Readonly<Record<string, string>>> {
  if (workspace.validateSecurityBoundary !== undefined) {
    await withinDeadline(
      workspace.validateSecurityBoundary(),
      deadline,
    );
  }
  // The workspace root is already unique and private. Keep these descendants
  // deliberately short so nested Windows import staging stays inside Git for
  // Windows' native path budget before it can read core.longpaths.
  const isolationRoot = path.join(workspace.root, ".g");
  const globalConfig = path.join(isolationRoot, "c");
  const directories = Object.freeze({
    home: path.join(isolationRoot, "h"),
    xdg: path.join(isolationRoot, "x"),
    userProfile: path.join(isolationRoot, "u"),
    appData: path.join(isolationRoot, "a"),
    localAppData: path.join(isolationRoot, "l"),
  });
  try {
    await withinDeadline(
      (async () => {
        await fs.mkdir(isolationRoot, { mode: 0o700 });
        await Promise.all(
          Object.values(directories).map((directory) =>
            fs.mkdir(directory, { mode: 0o700 }),
          ),
        );
        await fs.writeFile(globalConfig, "", {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
      })(),
      deadline,
    );
  } catch (error) {
    if (error === INTERNAL_ABORT) throw error;
    throw new GenericGitSnapshotError(
      "GIT_TEMPORARY_WORKSPACE_INVALID",
      "Temporary Git workspace failed its security policy.",
    );
  }
  const selected = { ...environment };
  delete selected["HOMEDRIVE"];
  delete selected["HOMEPATH"];
  delete selected["SSH_AGENT_PID"];
  delete selected["SSH_AUTH_SOCK"];
  selected["GIT_CONFIG_NOSYSTEM"] = "1";
  selected["GIT_CONFIG_GLOBAL"] = globalConfig;
  // Git otherwise walks above cwd looking for a repository-local config.
  // The workspace root is process-created and privately validated; making it
  // the ceiling prevents an ancestor .git/config from injecting credentials,
  // headers, cookies, or arbitrary url.*.insteadOf rewrites.
  selected["GIT_CEILING_DIRECTORIES"] = path.resolve(workspace.root);
  selected["HOME"] = directories.home;
  selected["XDG_CONFIG_HOME"] = directories.xdg;
  selected["USERPROFILE"] = directories.userProfile;
  selected["APPDATA"] = directories.appData;
  selected["LOCALAPPDATA"] = directories.localAppData;
  return Object.freeze(selected);
}

function hardenedArguments(
  transport: GenericGitTransport,
  hooksPath: string,
  operation: readonly string[],
  credentialHelper?: string,
  isolateCredentials = false,
): readonly string[] {
  return Object.freeze([
    "-c",
    "protocol.allow=never",
    "-c",
    `protocol.${transport}.allow=always`,
    "-c",
    "protocol.file.allow=never",
    "-c",
    "protocol.ext.allow=never",
    "-c",
    "credential.interactive=false",
    "-c",
    "http.followRedirects=false",
    "-c",
    "http.sslVerify=true",
    "-c",
    "core.fsmonitor=false",
    "-c",
    // Git for Windows must enable this from the command line: deeply nested
    // object paths can be opened before any repository config exists.
    "core.longpaths=true",
    "-c",
    `core.hooksPath=${hooksPath}`,
    "-c",
    "maintenance.auto=false",
    "-c",
    "gc.auto=0",
    "-c",
    "fetch.recurseSubmodules=false",
    "-c",
    "submodule.recurse=false",
    "-c",
    "filter.lfs.required=false",
    "-c",
    "filter.lfs.smudge=",
    "-c",
    "filter.lfs.process=",
    ...(credentialHelper !== undefined || isolateCredentials
      ? [
          "-c",
          "credential.helper=",
          "-c",
          "http.extraHeader=",
          "-c",
          "http.cookieFile=",
          "-c",
          "core.askPass=",
        ]
      : []),
    ...(credentialHelper === undefined
      ? []
      : [
          "-c",
          `credential.helper=${credentialHelper}`,
          "-c",
          "credential.useHttpPath=true",
          "-c",
          "credential.protectProtocol=true",
        ]),
    ...(transport === "ssh"
      ? ["-c", "core.sshCommand=ssh -oBatchMode=yes"]
      : []),
    ...operation,
  ]);
}

function terminateProcessTree(child: ChildProcess): void {
  const processId = child.pid;
  if (processId === undefined) return;
  try {
    if (process.platform === "win32") {
      try {
        child.kill("SIGKILL");
      } catch {
        // Continue with the process-tree terminator.
      }
      const killer = spawn(
        "taskkill.exe",
        ["/pid", String(processId), "/t", "/f"],
        {
          shell: false,
          windowsHide: true,
          stdio: "ignore",
        },
      );
      killer.unref();
    } else {
      process.kill(-processId, "SIGKILL");
    }
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // The process already exited.
    }
  }
}

export const runInstalledGit: GenericGitRunGit = async (
  request,
): Promise<GitProcessResult> =>
  new Promise<GitProcessResult>((resolve, reject) => {
    if (request.signal.aborted) {
      reject(INTERNAL_ABORT);
      return;
    }
    let child: ChildProcess;
    try {
      child = spawn(request.executable, [...request.arguments], {
        cwd: request.cwd,
        env: { ...request.env },
        shell: false,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      reject(
        new GenericGitSnapshotError(
          "GIT_COMMAND_FAILED",
          "Installed Git could not be started.",
        ),
      );
      return;
    }

    const stdoutChunks: Uint8Array[] = [];
    const stderrChunks: Uint8Array[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let boundaryFailure: GenericGitSnapshotError | undefined;
    let terminationFailure: unknown;
    let terminationTimer:
      | ReturnType<typeof globalThis.setTimeout>
      | undefined;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      if (terminationTimer !== undefined) {
        globalThis.clearTimeout(terminationTimer);
      }
      request.signal.removeEventListener("abort", abort);
      callback();
    };
    const terminate = (failure: unknown): void => {
      terminationFailure ??= failure;
      terminateProcessTree(child);
      terminationTimer ??= globalThis.setTimeout(
        () =>
          finish(() =>
            reject(terminationFailure ?? INTERNAL_ABORT),
          ),
        2_000,
      );
    };
    const failBoundary = (
      code: "GIT_OUTPUT_TOO_LARGE" | "GIT_COMMAND_FAILED",
      message: string,
    ): void => {
      if (boundaryFailure !== undefined) return;
      boundaryFailure = new GenericGitSnapshotError(code, message);
      terminate(boundaryFailure);
    };
    const abort = (): void => {
      terminate(INTERNAL_ABORT);
    };
    const timer = globalThis.setTimeout(() => {
      terminate(INTERNAL_ABORT);
    }, request.timeoutMs);
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) abort();

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > request.maximumStdoutBytes) {
        failBoundary(
          "GIT_OUTPUT_TOO_LARGE",
          "Installed Git output exceeded its size limit.",
        );
        return;
      }
      stdoutChunks.push(new Uint8Array(chunk));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > request.maximumStderrBytes) {
        failBoundary(
          "GIT_OUTPUT_TOO_LARGE",
          "Installed Git diagnostics exceeded their size limit.",
        );
        return;
      }
      stderrChunks.push(new Uint8Array(chunk));
    });
    child.once("error", () => {
      finish(() =>
        reject(
          new GenericGitSnapshotError(
            "GIT_COMMAND_FAILED",
            "Installed Git could not complete the requested operation.",
          ),
        ),
      );
    });
    child.once("close", (code) => {
      finish(() => {
        if (boundaryFailure !== undefined) {
          reject(boundaryFailure);
          return;
        }
        if (terminationFailure !== undefined) {
          reject(terminationFailure);
          return;
        }
        const stdout = new Uint8Array(stdoutBytes);
        let offset = 0;
        for (const chunk of stdoutChunks) {
          stdout.set(chunk, offset);
          offset += chunk.byteLength;
        }
        const stderr = new Uint8Array(stderrBytes);
        offset = 0;
        for (const chunk of stderrChunks) {
          stderr.set(chunk, offset);
          offset += chunk.byteLength;
        }
        resolve({ exitCode: code ?? 1, stdout, stderr });
      });
    });
  });

async function measureDirectory(
  root: string,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<number> {
  let total = 0;
  const pending = [root];
  while (pending.length > 0) {
    if (signal.aborted) throw INTERNAL_ABORT;
    const current = pending.pop();
    if (current === undefined) break;
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        continue;
      }
      throw error;
    }
    for (const entry of entries) {
      if (signal.aborted) throw INTERNAL_ABORT;
      const candidate = path.join(current, entry.name);
      let stat;
      try {
        stat = await fs.lstat(candidate);
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          continue;
        }
        throw error;
      }
      if (stat.isSymbolicLink()) {
        throw new GenericGitSnapshotError(
          "GIT_TEMPORARY_LIMIT",
          "Temporary Git data failed its filesystem policy.",
        );
      }
      if (stat.isDirectory()) pending.push(candidate);
      else if (stat.isFile()) {
        total += stat.size;
        if (total > maximumBytes) {
          throw new GenericGitSnapshotError(
            "GIT_TEMPORARY_LIMIT",
            "Temporary Git data exceeded the disk size limit.",
          );
        }
      }
    }
  }
  return total;
}

function invalidTemporaryWorkspace(): GenericGitSnapshotError {
  return new GenericGitSnapshotError(
    "GIT_TEMPORARY_WORKSPACE_INVALID",
    "Temporary Git workspace could not be created safely.",
  );
}

function windowsTemporaryWorkspaceParentRequired(): GenericGitSnapshotError {
  return new GenericGitSnapshotError(
    "GIT_TEMPORARY_WORKSPACE_INVALID",
    "Generic Git on Windows requires an explicitly pre-secured private workspace parent; configure temporaryWorkspaceOptions or use --trusted-workspace-parent.",
  );
}

function isPathContained(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative.length > 0 &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function pathsMatch(left: string, right: string): boolean {
  return (
    path.relative(left, right).length === 0 &&
    path.relative(right, left).length === 0
  );
}

interface FileIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

interface ValidatedDirectory {
  readonly canonicalPath: string;
  readonly identity: FileIdentity;
  readonly owner: bigint;
  readonly group: bigint;
  readonly permissionBits: bigint;
  readonly requireUsableIdentity: boolean;
  readonly requirePrivateMode: boolean;
}

interface ValidatedParentBoundary {
  readonly directory: ValidatedDirectory;
  readonly posixCanonicalChain: readonly ValidatedDirectory[];
}

interface TemporaryWorkspaceCleanupState {
  quarantine?: ValidatedDirectory;
  removalAttempted?: boolean;
}

function fileIdentity(status: BigIntStats): FileIdentity {
  return Object.freeze({
    device: status.dev,
    inode: status.ino,
  });
}

function identitiesMatch(
  left: FileIdentity,
  right: FileIdentity,
): boolean {
  return (
    left.device === right.device && left.inode === right.inode
  );
}

function hasUsableIdentity(identity: FileIdentity): boolean {
  return identity.device !== 0n || identity.inode !== 0n;
}

function statusMatchesDirectory(
  status: BigIntStats,
  directory: ValidatedDirectory,
): boolean {
  if (status.isSymbolicLink() || !status.isDirectory()) return false;
  const identity = fileIdentity(status);
  if (
    !identitiesMatch(identity, directory.identity) ||
    status.uid !== directory.owner ||
    status.gid !== directory.group ||
    (status.mode & 0o7777n) !== directory.permissionBits ||
    (directory.requireUsableIdentity &&
      !hasUsableIdentity(identity))
  ) {
    return false;
  }
  if (
    directory.requirePrivateMode &&
    (status.mode & 0o7777n) !== 0o700n
  ) {
    return false;
  }
  if (
    directory.requirePrivateMode &&
    process.geteuid !== undefined &&
    status.uid !== BigInt(process.geteuid())
  ) {
    return false;
  }
  return true;
}

function validateTemporaryWorkspaceOptions(
  options: GenericGitTemporaryWorkspaceOptions | undefined,
): string | undefined {
  if (options === undefined) return undefined;
  if (
    typeof options !== "object" ||
    options === null ||
    Array.isArray(options) ||
    Object.keys(options).length !== 1 ||
    !Object.hasOwn(options, "trustedPrivateParent")
  ) {
    throw invalidTemporaryWorkspace();
  }
  const boundary = options.trustedPrivateParent;
  if (
    typeof boundary !== "object" ||
    boundary === null ||
    Array.isArray(boundary) ||
    Object.keys(boundary).length !== 3 ||
    !Object.hasOwn(boundary, "directory") ||
    !Object.hasOwn(boundary, "windowsAclProtection") ||
    !Object.hasOwn(
      boundary,
      "canonicalAncestryProtection",
    ) ||
    typeof boundary.directory !== "string" ||
    boundary.directory.length === 0 ||
    boundary.directory.includes("\0") ||
    boundary.windowsAclProtection !==
      GENERIC_GIT_PRESECURED_WINDOWS_ACL ||
    boundary.canonicalAncestryProtection !==
      GENERIC_GIT_PRESECURED_CANONICAL_ANCESTRY
  ) {
    throw invalidTemporaryWorkspace();
  }
  return boundary.directory;
}

async function captureDirectory(
  requestedPath: string,
  requireUsableIdentity: boolean,
  requirePrivateMode: boolean,
): Promise<ValidatedDirectory> {
  const first = await fs.lstat(requestedPath, { bigint: true });
  const canonicalPath = await fs.realpath(requestedPath);
  // Both the requested path and its canonical target are checked after
  // realpath so a rename/replacement cannot silently change our boundary.
  const afterRealpath = await fs.lstat(requestedPath, {
    bigint: true,
  });
  const canonicalStatus = await fs.lstat(canonicalPath, {
    bigint: true,
  });
  const canonicalAfter = await fs.realpath(requestedPath);
  const directory: ValidatedDirectory = Object.freeze({
    canonicalPath,
    identity: fileIdentity(first),
    owner: first.uid,
    group: first.gid,
    permissionBits: first.mode & 0o7777n,
    requireUsableIdentity,
    requirePrivateMode,
  });
  if (
    !statusMatchesDirectory(first, directory) ||
    !statusMatchesDirectory(afterRealpath, directory) ||
    !statusMatchesDirectory(canonicalStatus, directory) ||
    !pathsMatch(canonicalPath, canonicalAfter)
  ) {
    throw invalidTemporaryWorkspace();
  }
  return directory;
}

async function revalidateDirectory(
  directory: ValidatedDirectory,
): Promise<void> {
  try {
    const before = await fs.lstat(directory.canonicalPath, {
      bigint: true,
    });
    const canonical = await fs.realpath(directory.canonicalPath);
    const afterRealpath = await fs.lstat(directory.canonicalPath, {
      bigint: true,
    });
    const canonicalStatus = await fs.lstat(canonical, {
      bigint: true,
    });
    const canonicalAfter = await fs.realpath(
      directory.canonicalPath,
    );
    if (
      !statusMatchesDirectory(before, directory) ||
      !statusMatchesDirectory(afterRealpath, directory) ||
      !statusMatchesDirectory(canonicalStatus, directory) ||
      !pathsMatch(directory.canonicalPath, canonical) ||
      !pathsMatch(canonical, canonicalAfter)
    ) {
      throw invalidTemporaryWorkspace();
    }
  } catch (error) {
    if (error instanceof GenericGitSnapshotError) throw error;
    throw invalidTemporaryWorkspace();
  }
}

function canonicalDirectoryPaths(candidate: string): readonly string[] {
  const result: string[] = [];
  let current = candidate;
  while (true) {
    result.push(current);
    const parent = path.dirname(current);
    if (pathsMatch(parent, current)) break;
    current = parent;
  }
  return Object.freeze(result.reverse());
}

function assertTrustedPosixOwner(
  directory: ValidatedDirectory,
): void {
  const effectiveUser =
    process.geteuid === undefined
      ? undefined
      : BigInt(process.geteuid());
  if (
    effectiveUser === undefined ||
    (directory.owner !== 0n &&
      directory.owner !== effectiveUser)
  ) {
    throw invalidTemporaryWorkspace();
  }
}

function assertProtectedPosixEntry(
  container: ValidatedDirectory,
  entry: ValidatedDirectory,
): void {
  assertTrustedPosixOwner(container);
  assertTrustedPosixOwner(entry);
  if (
    !pathsMatch(
      path.dirname(entry.canonicalPath),
      container.canonicalPath,
    )
  ) {
    throw invalidTemporaryWorkspace();
  }
  assertProtectedPosixContainer(container);
}

function assertProtectedPosixContainer(
  container: ValidatedDirectory,
): void {
  assertTrustedPosixOwner(container);
  const writableByUntrusted =
    (container.permissionBits & 0o022n) !== 0n;
  const hasStickyDeletionProtection =
    (container.permissionBits & 0o1000n) !== 0n;
  if (
    writableByUntrusted &&
    !hasStickyDeletionProtection
  ) {
    throw invalidTemporaryWorkspace();
  }
}

function assertProtectedPosixChain(
  chain: readonly ValidatedDirectory[],
): void {
  if (chain.length === 0) throw invalidTemporaryWorkspace();
  for (const directory of chain) {
    assertTrustedPosixOwner(directory);
    if (!hasUsableIdentity(directory.identity)) {
      throw invalidTemporaryWorkspace();
    }
  }
  for (let index = 1; index < chain.length; index += 1) {
    const container = chain[index - 1];
    const entry = chain[index];
    if (container === undefined || entry === undefined) {
      throw invalidTemporaryWorkspace();
    }
    assertProtectedPosixEntry(container, entry);
  }
  const leaf = chain.at(-1);
  if (leaf === undefined) throw invalidTemporaryWorkspace();
  assertProtectedPosixContainer(leaf);
}

async function capturePosixCanonicalChain(
  parent: ValidatedDirectory,
): Promise<readonly ValidatedDirectory[]> {
  const chain: ValidatedDirectory[] = [];
  for (const candidate of canonicalDirectoryPaths(
    parent.canonicalPath,
  )) {
    chain.push(
      pathsMatch(candidate, parent.canonicalPath)
        ? parent
        : await captureDirectory(candidate, true, false),
    );
  }
  assertProtectedPosixChain(chain);
  return Object.freeze(chain);
}

async function revalidateParentBoundary(
  parent: ValidatedParentBoundary,
): Promise<void> {
  if (process.platform === "win32") {
    await revalidateDirectory(parent.directory);
    return;
  }
  for (const directory of parent.posixCanonicalChain) {
    await revalidateDirectory(directory);
  }
  for (
    let index = parent.posixCanonicalChain.length - 1;
    index >= 0;
    index -= 1
  ) {
    const directory = parent.posixCanonicalChain[index];
    if (directory === undefined) {
      throw invalidTemporaryWorkspace();
    }
    await revalidateDirectory(directory);
  }
  assertProtectedPosixChain(parent.posixCanonicalChain);
}

async function prepareTemporaryWorkspaceParent(
  options: GenericGitTemporaryWorkspaceOptions | undefined,
): Promise<ValidatedParentBoundary> {
  const configuredParent =
    validateTemporaryWorkspaceOptions(options);
  // Portable Node APIs cannot inspect Windows ACL inheritance or
  // FILE_DELETE_CHILD rights. An implicit environment-derived Windows temp
  // directory therefore has no defensible trust contract.
  if (
    configuredParent === undefined &&
    process.platform === "win32"
  ) {
    throw windowsTemporaryWorkspaceParentRequired();
  }
  const parent = path.resolve(configuredParent ?? os.tmpdir());
  try {
    // A configured private boundary must already exist. In particular, this
    // API never turns an arbitrary user-supplied path into a trust boundary.
    const directory = await captureDirectory(
      parent,
      true,
      configuredParent !== undefined &&
        process.platform !== "win32",
    );
    const posixCanonicalChain =
      process.platform === "win32"
        ? Object.freeze([] as ValidatedDirectory[])
        : await capturePosixCanonicalChain(directory);
    const boundary: ValidatedParentBoundary = Object.freeze({
      directory,
      posixCanonicalChain,
    });
    await revalidateParentBoundary(boundary);
    return boundary;
  } catch (error) {
    if (error instanceof GenericGitSnapshotError) throw error;
    throw invalidTemporaryWorkspace();
  }
}

async function validateWorkspaceDirectories(
  parent: ValidatedParentBoundary,
  root: ValidatedDirectory,
): Promise<void> {
  await revalidateParentBoundary(parent);
  await revalidateDirectory(root);
  await revalidateParentBoundary(parent);
  if (
    !isPathContained(
      parent.directory.canonicalPath,
      root.canonicalPath,
    ) ||
    !pathsMatch(
      path.dirname(root.canonicalPath),
      parent.directory.canonicalPath,
    )
  ) {
    throw invalidTemporaryWorkspace();
  }
  if (process.platform !== "win32") {
    assertProtectedPosixEntry(parent.directory, root);
  }
}

async function isMissingPath(candidate: string): Promise<boolean> {
  try {
    await fs.lstat(candidate);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return true;
    }
    throw error;
  }
  return false;
}

async function requireMissingPath(candidate: string): Promise<void> {
  if (await isMissingPath(candidate)) return;
  throw invalidTemporaryWorkspace();
}

async function removeTemporaryWorkspaceRoot(
  parent: ValidatedParentBoundary,
  root: ValidatedDirectory,
  state: TemporaryWorkspaceCleanupState,
): Promise<void> {
  let quarantine = state.quarantine;
  if (quarantine === undefined) {
    await validateWorkspaceDirectories(parent, root);
    const quarantinePath = path.join(
      parent.directory.canonicalPath,
      `.code-city-git-cleanup-${randomUUID()}`,
    );
    if (
      !isPathContained(
        parent.directory.canonicalPath,
        quarantinePath,
      )
    ) {
      throw invalidTemporaryWorkspace();
    }
    await fs.rename(root.canonicalPath, quarantinePath);
    quarantine = Object.freeze({
      ...root,
      canonicalPath: quarantinePath,
    });
    // Persist the expected identity and new path immediately. A later retry
    // can revalidate this same object after a transient filesystem failure;
    // a moved replacement will not match and is therefore preserved.
    state.quarantine = quarantine;
    // If an unexpected object was moved, preserve it at the quarantine path
    // and fail closed instead of recursively deleting it.
    await revalidateDirectory(quarantine);
  }
  await revalidateParentBoundary(parent);
  if (
    state.removalAttempted === true &&
    (await isMissingPath(quarantine.canonicalPath))
  ) {
    // The trusted object is gone. A later object at the public root name is
    // not ours; preserve it and finish the interrupted disposal.
    return;
  }
  await revalidateDirectory(quarantine);
  // A replacement appearing at the public workspace name is not ours. Keep
  // both objects and report failure rather than claiming the name is clean.
  await requireMissingPath(root.canonicalPath);
  state.removalAttempted = true;
  await fs.rm(quarantine.canonicalPath, {
    recursive: true,
    force: false,
    maxRetries: 10,
    retryDelay: 100,
  });
  await requireMissingPath(quarantine.canonicalPath);
  await requireMissingPath(root.canonicalPath);
}

export async function createGenericGitTemporaryWorkspace(
  options?: GenericGitTemporaryWorkspaceOptions,
): Promise<GenericGitTemporaryWorkspace> {
  const parent = await prepareTemporaryWorkspaceParent(options);
  let root: string | undefined;
  let rootDirectory: ValidatedDirectory | undefined;
  const cleanupState: TemporaryWorkspaceCleanupState = {};
  try {
    await revalidateParentBoundary(parent);
    root = await fs.mkdtemp(
      path.join(
        parent.directory.canonicalPath,
        "code-city-git-",
      ),
    );
    const workspaceRoot = root;
    if (
      !isPathContained(
        parent.directory.canonicalPath,
        path.resolve(workspaceRoot),
      )
    ) {
      throw invalidTemporaryWorkspace();
    }
    if (process.platform !== "win32") {
      await fs.chmod(workspaceRoot, 0o700);
    }
    rootDirectory = await captureDirectory(
      workspaceRoot,
      true,
      process.platform !== "win32",
    );
    const validatedRoot = rootDirectory;
    await validateWorkspaceDirectories(parent, validatedRoot);
    const repositoryDirectory = path.join(
      workspaceRoot,
      "repository.git",
    );
    const templateDirectory = path.join(
      workspaceRoot,
      "empty-template",
    );
    await fs.mkdir(templateDirectory, { recursive: false, mode: 0o700 });
    await validateWorkspaceDirectories(parent, validatedRoot);
    let disposed = false;
    let disposing: Promise<void> | undefined;
    return {
      root: workspaceRoot,
      repositoryDirectory,
      templateDirectory,
      validateSecurityBoundary: () =>
        validateWorkspaceDirectories(parent, validatedRoot),
      measureBytes: async (maximumBytes, signal) => {
        await validateWorkspaceDirectories(parent, validatedRoot);
        const measured = await measureDirectory(
          workspaceRoot,
          maximumBytes,
          signal,
        );
        await validateWorkspaceDirectories(parent, validatedRoot);
        return measured;
      },
      dispose: async () => {
        if (disposed) return;
        disposing ??= (async () => {
          try {
            await removeTemporaryWorkspaceRoot(
              parent,
              validatedRoot,
              cleanupState,
            );
            disposed = true;
          } catch {
            throw new GenericGitSnapshotError(
              "GIT_CLEANUP_FAILED",
              "Temporary Git data could not be removed safely.",
            );
          } finally {
            disposing = undefined;
          }
        })();
        await disposing;
      },
    };
  } catch (error) {
    if (root !== undefined && rootDirectory !== undefined) {
      try {
        await removeTemporaryWorkspaceRoot(
          parent,
          rootDirectory,
          cleanupState,
        );
      } catch {
        throw new GenericGitSnapshotError(
          "GIT_CLEANUP_FAILED",
          "Temporary Git data could not be removed safely.",
        );
      }
    }
    if (error instanceof GenericGitSnapshotError) throw error;
    throw invalidTemporaryWorkspace();
  }
}

async function withCombinedDeadline<T>(
  timeoutMs: number,
  signals: readonly (AbortSignal | undefined)[],
  operation: (deadline: CombinedDeadline) => Promise<T>,
): Promise<T> {
  const callers = [
    ...new Set(signals.filter((signal) => signal !== undefined)),
  ] as AbortSignal[];
  if (callers.some((signal) => signal.aborted)) {
    throw new GenericGitSnapshotError(
      "GIT_ABORTED",
      "Generic Git snapshot was cancelled.",
    );
  }
  const controller = new AbortController();
  const deadlineAt = Date.now() + timeoutMs;
  let reason: "caller" | "deadline" | undefined;
  const abortFromCaller = (): void => {
    reason ??= "caller";
    controller.abort();
  };
  for (const signal of callers) {
    signal.addEventListener("abort", abortFromCaller, { once: true });
  }
  if (callers.some((signal) => signal.aborted)) abortFromCaller();
  const timer = globalThis.setTimeout(() => {
    reason ??= "deadline";
    controller.abort();
  }, timeoutMs);
  const deadline: CombinedDeadline = {
    signal: controller.signal,
    remainingMilliseconds: () => {
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) {
        reason ??= "deadline";
        controller.abort();
        throw INTERNAL_ABORT;
      }
      return remaining;
    },
  };
  try {
    const result = await operation(deadline);
    if (controller.signal.aborted) throw INTERNAL_ABORT;
    return result;
  } catch (error) {
    if (
      reason === "deadline" ||
      (reason === undefined && error === INTERNAL_ABORT)
    ) {
      throw new GenericGitSnapshotError(
        "GIT_DEADLINE_EXCEEDED",
        "Generic Git snapshot exceeded its time deadline.",
      );
    }
    if (reason === "caller" || error === INTERNAL_ABORT) {
      throw new GenericGitSnapshotError(
        "GIT_ABORTED",
        "Generic Git snapshot was cancelled.",
      );
    }
    throw error;
  } finally {
    globalThis.clearTimeout(timer);
    for (const signal of callers) {
      signal.removeEventListener("abort", abortFromCaller);
    }
  }
}

async function withinDeadline<T>(
  operation: PromiseLike<T>,
  deadline: CombinedDeadline,
): Promise<T> {
  const remaining = deadline.remainingMilliseconds();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      deadline.signal.removeEventListener("abort", abort);
      callback();
    };
    const abort = (): void => finish(() => reject(INTERNAL_ABORT));
    const timer = globalThis.setTimeout(
      () => finish(() => reject(INTERNAL_ABORT)),
      remaining,
    );
    deadline.signal.addEventListener("abort", abort, { once: true });
    if (deadline.signal.aborted) abort();
    Promise.resolve(operation).then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

async function createWorkspaceWithinDeadline(
  createWorkspace: () => Promise<GenericGitTemporaryWorkspace>,
  deadline: CombinedDeadline,
): Promise<GenericGitTemporaryWorkspace> {
  const pending = Promise.resolve().then(createWorkspace);
  try {
    return await withinDeadline(pending, deadline);
  } catch (error) {
    void pending
      .then((workspace) => workspace.dispose())
      .catch(() => undefined);
    throw error;
  }
}

function waitForDiskPoll(signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(INTERNAL_ABORT);
      return;
    }
    const finish = (callback: () => void): void => {
      globalThis.clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      callback();
    };
    const abort = (): void => finish(() => reject(INTERNAL_ABORT));
    const timer = globalThis.setTimeout(
      () => finish(resolve),
      100,
    );
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

async function monitorTemporaryWorkspace(
  workspace: GenericGitTemporaryWorkspace,
  deadline: CombinedDeadline,
  signal: AbortSignal,
  completed: () => boolean,
): Promise<never> {
  while (true) {
    if (completed()) {
      return await new Promise<never>(() => undefined);
    }
    const measured = await withinDeadline(
      workspace.measureBytes(MAX_TEMPORARY_BYTES, signal),
      deadline,
    );
    if (
      !Number.isSafeInteger(measured) ||
      measured < 0 ||
      measured > MAX_TEMPORARY_BYTES
    ) {
      throw new GenericGitSnapshotError(
        "GIT_TEMPORARY_LIMIT",
        "Temporary Git data exceeded the disk size limit.",
      );
    }
    await waitForDiskPoll(signal);
  }
}

interface GitInvocationOptions {
  readonly maximumStdoutBytes?: number;
  readonly validateResult?: (result: GitProcessResult) => void;
}

async function invokeGit(
  runGit: GenericGitRunGit,
  executable: string,
  environment: Readonly<Record<string, string>>,
  workspace: GenericGitTemporaryWorkspace,
  remote: ParsedRemote,
  deadline: CombinedDeadline,
  operation: readonly string[],
  monitorDisk = false,
  credentialHelper?: string,
  isolateCredentials = false,
  options: GitInvocationOptions = {},
): Promise<Uint8Array> {
  const maximumStdoutBytes =
    options.maximumStdoutBytes ?? MAX_GIT_OUTPUT_BYTES;
  const commandController = new AbortController();
  const abortCommand = (): void => commandController.abort();
  deadline.signal.addEventListener("abort", abortCommand, {
    once: true,
  });
  if (deadline.signal.aborted) abortCommand();
  let completed = false;
  let diskFailure: GenericGitSnapshotError | undefined;
  let run: Promise<GitProcessResult> | undefined;
  try {
    if (workspace.validateSecurityBoundary !== undefined) {
      await withinDeadline(
        workspace.validateSecurityBoundary(),
        deadline,
      );
    }
    if (monitorDisk) {
      await enforceTemporaryLimit(workspace, deadline);
    }
    run = Promise.resolve(
      runGit({
        executable,
        arguments: hardenedArguments(
          remote.transport,
          workspace.templateDirectory,
          operation,
          credentialHelper,
          isolateCredentials ||
            environment["GIT_CONFIG_NOSYSTEM"] === "1",
        ),
        cwd: workspace.root,
        env: environment,
        shell: false,
        windowsHide: true,
        timeoutMs: deadline.remainingMilliseconds(),
        maximumStdoutBytes,
        maximumStderrBytes: MAX_GIT_DIAGNOSTIC_BYTES,
        signal: commandController.signal,
      }),
    );
    void run.then(
      () => {
        completed = true;
      },
      () => {
        completed = true;
      },
    );
    const monitored = monitorDisk
      ? monitorTemporaryWorkspace(
          workspace,
          deadline,
          commandController.signal,
          () => completed,
        ).catch((error: unknown) => {
          if (error instanceof GenericGitSnapshotError) {
            diskFailure = error;
          }
          commandController.abort();
          throw error;
        })
      : new Promise<never>(() => undefined);
    const boundedOperation = Promise.race([run, monitored]);
    const result =
      runGit === runInstalledGit
        ? await boundedOperation
        : await withinDeadline(boundedOperation, deadline);
    if (result.stdout.byteLength > maximumStdoutBytes) {
      throw new GenericGitSnapshotError(
        "GIT_OUTPUT_TOO_LARGE",
        "Installed Git output exceeded its size limit.",
      );
    }
    if (
      result.stderr !== undefined &&
      result.stderr.byteLength > MAX_GIT_DIAGNOSTIC_BYTES
    ) {
      throw new GenericGitSnapshotError(
        "GIT_OUTPUT_TOO_LARGE",
        "Installed Git diagnostics exceeded their size limit.",
      );
    }
    if (!Number.isInteger(result.exitCode) || result.exitCode !== 0) {
      throw new GenericGitSnapshotError(
        "GIT_COMMAND_FAILED",
        "Installed Git operation failed safely.",
      );
    }
    options.validateResult?.(result);
    return result.stdout.slice();
  } catch (error) {
    commandController.abort();
    if (runGit === runInstalledGit && run !== undefined) {
      try {
        await run;
      } catch {
        // The safe error below describes the original failure.
      }
    }
    if (diskFailure !== undefined) throw diskFailure;
    if (
      error === INTERNAL_ABORT ||
      error instanceof GenericGitSnapshotError
    ) {
      throw error;
    }
    throw new GenericGitSnapshotError(
      "GIT_COMMAND_FAILED",
      "Installed Git operation failed safely.",
    );
  } finally {
    completed = true;
    commandController.abort();
    deadline.signal.removeEventListener("abort", abortCommand);
  }
}

function validCredentialBroker(
  value: unknown,
): value is GenericGitCredentialBroker {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<GenericGitCredentialBroker>;
  return (
    typeof candidate.helperCommand === "string" &&
    candidate.helperCommand.startsWith("!") &&
    candidate.helperCommand.length <= 16_384 &&
    !/[\0\r\n]/u.test(candidate.helperCommand) &&
    typeof candidate.dispose === "function"
  );
}

async function createBrokerWithinDeadline(
  factory: GenericGitCredentialBrokerFactory,
  request: Parameters<GenericGitCredentialBrokerFactory>[0],
  deadline: CombinedDeadline,
): Promise<GenericGitCredentialBroker> {
  let pendingSettled = false;
  const pending = Promise.resolve()
    .then(() => factory(request))
    .then(
      (broker) => {
        pendingSettled = true;
        return broker;
      },
      (error: unknown) => {
        pendingSettled = true;
        throw error;
      },
    );
  void pending.catch(() => undefined);
  let candidate: unknown;
  try {
    candidate = await withinDeadline(
      pending,
      deadline,
    );
  } catch (error) {
    request.secret.fill(0);
    const lateCleanup = pending
      .then((lateCandidate: unknown) =>
        validCredentialBroker(lateCandidate)
          ? lateCandidate.dispose()
          : undefined,
      )
      .catch(() => undefined);
    if (pendingSettled) await lateCleanup;
    else void lateCleanup;
    throw error;
  }
  if (!validCredentialBroker(candidate)) {
    if (
      typeof candidate === "object" &&
      candidate !== null &&
      "dispose" in candidate &&
      typeof candidate.dispose === "function"
    ) {
      await Promise.resolve(candidate.dispose()).catch(
        () => undefined,
      );
    }
    throw invalidCredentialProvider();
  }
  return candidate;
}

async function invokeGitWithCredential(
  provider: GenericGitSnapshotCredentialProvider,
  brokerFactory: GenericGitCredentialBrokerFactory,
  target: GitCredentialTarget,
  runGit: GenericGitRunGit,
  executable: string,
  environment: Readonly<Record<string, string>>,
  workspace: GenericGitTemporaryWorkspace,
  remote: ParsedRemote,
  deadline: CombinedDeadline,
  operation: readonly string[],
  monitorDisk = false,
  options: GitInvocationOptions = {},
): Promise<Uint8Array> {
  const operationController = new AbortController();
  const abortOperation = (): void => operationController.abort();
  deadline.signal.addEventListener("abort", abortOperation, {
    once: true,
  });
  if (deadline.signal.aborted) abortOperation();
  const operationDeadline: CombinedDeadline = {
    signal: operationController.signal,
    remainingMilliseconds: () => deadline.remainingMilliseconds(),
  };
  let acceptingCallbacks = true;
  let callbackCount = 0;
  let callbackViolation = false;
  let operationPromise: Promise<Uint8Array> | undefined;
  let operationFailure: unknown;
  const providerRun = Promise.resolve().then(() =>
    provider.use(deadline.signal, (credential) => {
      if (!acceptingCallbacks || callbackCount !== 0) {
        callbackViolation = true;
        abortOperation();
        const rejected = Promise.reject<never>(
          invalidCredentialProvider(),
        );
        void rejected.catch(() => undefined);
        return rejected;
      }
      callbackCount = 1;
      operationPromise = (async () => {
        const material = copyCredential(credential);
        let broker: GenericGitCredentialBroker | undefined;
        let output: Uint8Array | undefined;
        let failure: unknown;
        try {
          broker = await createBrokerWithinDeadline(
            brokerFactory,
            {
              host: target.host,
              path: target.path,
              username: material.username,
              secret: material.secret,
              timeoutMs:
                operationDeadline.remainingMilliseconds(),
              signal: operationDeadline.signal,
            },
            operationDeadline,
          );
          output = await invokeGit(
            runGit,
            executable,
            environment,
            workspace,
            remote,
            operationDeadline,
            operation,
            monitorDisk,
            broker.helperCommand,
            true,
            options,
          );
        } catch (error) {
          failure = error;
        } finally {
          try {
            await broker?.dispose();
          } catch {
            failure ??= new GenericGitSnapshotError(
              "GIT_COMMAND_FAILED",
              "Installed Git operation failed safely.",
            );
          } finally {
            material.secret.fill(0);
          }
        }
        if (failure !== undefined) throw failure;
        if (output === undefined) {
          throw new GenericGitSnapshotError(
            "GIT_COMMAND_FAILED",
            "Installed Git operation failed safely.",
          );
        }
        return output;
      })().catch((error: unknown) => {
        operationFailure = error;
        throw error;
      });
      void operationPromise.catch(() => undefined);
      return operationPromise;
    }),
  );
  void providerRun.catch(() => undefined);

  let providerFailure: unknown;
  try {
    await withinDeadline(providerRun, deadline);
  } catch (error) {
    providerFailure = error;
  } finally {
    acceptingCallbacks = false;
  }
  try {
    if (
      providerFailure !== undefined ||
      callbackViolation ||
      callbackCount !== 1 ||
      operationPromise === undefined
    ) {
      abortOperation();
      if (operationPromise !== undefined) {
        try {
          await operationPromise;
        } catch {
          // The fixed decision below owns the provider boundary failure.
        }
      }
      if (callbackViolation) throw invalidCredentialProvider();
      if (providerFailure === INTERNAL_ABORT) throw INTERNAL_ABORT;
      if (
        !callbackViolation &&
        providerFailure === operationFailure &&
        providerFailure instanceof GenericGitSnapshotError
      ) {
        throw providerFailure;
      }
      if (callbackCount !== 1) {
        throw invalidCredentialProvider();
      }
      throw new GenericGitSnapshotError(
        "GIT_COMMAND_FAILED",
        "Installed Git operation failed safely.",
      );
    }
    try {
      return await operationPromise;
    } catch (error) {
      if (
        error === INTERNAL_ABORT ||
        error instanceof GenericGitSnapshotError
      ) {
        throw error;
      }
      throw new GenericGitSnapshotError(
        "GIT_COMMAND_FAILED",
        "Installed Git operation failed safely.",
      );
    }
  } finally {
    deadline.signal.removeEventListener("abort", abortOperation);
  }
}

function invalidShallowMetadata(): GenericGitSnapshotError {
  return new GenericGitSnapshotError(
    "GIT_INVALID_RESPONSE",
    "Installed Git returned invalid shallow-boundary metadata.",
  );
}

async function oldestCommitIsShallowBoundary(
  workspace: GenericGitTemporaryWorkspace,
  oldestCommitSha: string,
  deadline: CombinedDeadline,
): Promise<boolean> {
  if (workspace.validateSecurityBoundary !== undefined) {
    await withinDeadline(
      workspace.validateSecurityBoundary(),
      deadline,
    );
  }
  const shallowPath = path.join(
    workspace.repositoryDirectory,
    "shallow",
  );
  let status: Stats;
  try {
    status = await withinDeadline(fs.lstat(shallowPath), deadline);
  } catch (error) {
    if (error === INTERNAL_ABORT) throw error;
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }
    throw invalidShallowMetadata();
  }
  if (
    status.isSymbolicLink() ||
    !status.isFile() ||
    !Number.isSafeInteger(status.size) ||
    status.size < 1 ||
    status.size > MAX_GIT_HISTORY_INDEX_BYTES
  ) {
    throw invalidShallowMetadata();
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(
      await withinDeadline(fs.readFile(shallowPath), deadline),
    );
  } catch (error) {
    if (error === INTERNAL_ABORT) throw error;
    throw invalidShallowMetadata();
  }
  if (
    bytes.byteLength < 1 ||
    bytes.byteLength > MAX_GIT_HISTORY_INDEX_BYTES
  ) {
    throw invalidShallowMetadata();
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw invalidShallowMetadata();
  }
  if (!text.endsWith("\n")) throw invalidShallowMetadata();
  const lines = text.slice(0, -1).split("\n");
  const boundaries = new Set<string>();
  for (const line of lines) {
    if (!COMMIT_SHA.test(line) || boundaries.has(line)) {
      throw invalidShallowMetadata();
    }
    boundaries.add(line);
  }
  return boundaries.has(oldestCommitSha);
}

async function enforceTemporaryLimit(
  workspace: GenericGitTemporaryWorkspace,
  deadline: CombinedDeadline,
): Promise<void> {
  const measured = await withinDeadline(
    workspace.measureBytes(MAX_TEMPORARY_BYTES, deadline.signal),
    deadline,
  );
  if (
    !Number.isSafeInteger(measured) ||
    measured < 0 ||
    measured > MAX_TEMPORARY_BYTES
  ) {
    throw new GenericGitSnapshotError(
      "GIT_TEMPORARY_LIMIT",
      "Temporary Git data exceeded the disk size limit.",
    );
  }
}

export async function snapshotGenericGitRepository(
  request: GenericGitSnapshotRequest,
  dependencies: GenericGitSnapshotDependencies = {},
): Promise<GenericGitSnapshotResult> {
  const remote = parseRemote(request.repositoryUrl);
  const requestedRef =
    request.ref === undefined ? undefined : validateRef(request.ref);
  const timeoutMs = resolveTimeout(request.timeoutMs);
  const runGit = dependencies.runGit ?? runInstalledGit;
  const createWorkspace =
    dependencies.createTemporaryWorkspace ??
    (() =>
      createGenericGitTemporaryWorkspace(
        dependencies.temporaryWorkspaceOptions,
      ));
  const openZip =
    dependencies.openZipSnapshotSource ?? openZipSnapshotSource;
  const materialize =
    dependencies.materializeRepositorySnapshot ??
    materializeRepositorySnapshot;
  const executable = dependencies.gitExecutable ?? "git";
  const environment = safeEnvironment(
    dependencies.environment ?? process.env,
  );
  const credentialProvider = validateCredentialProvider(
    dependencies.credentialProvider,
    remote,
  );
  const isolateCredentials = resolveCredentialIsolation(
    dependencies.isolateCredentials,
  );
  const brokerFactory =
    dependencies.createCredentialBroker ??
    createGenericGitCredentialBroker;
  if (
    credentialProvider !== undefined &&
    typeof brokerFactory !== "function"
  ) {
    throw invalidCredentialProvider();
  }
  const target =
    credentialProvider === undefined
      ? undefined
      : credentialTarget(remote);

  try {
    return await withCombinedDeadline(
      timeoutMs,
      [request.signal, request.snapshotOptions?.signal],
      async (deadline) => {
        const workspace = await createWorkspaceWithinDeadline(
          createWorkspace,
          deadline,
        );
        let workspaceDisposed = false;
        let source: DisposableSnapshotSource | undefined;
        try {
          const commandEnvironment =
            credentialProvider === undefined && !isolateCredentials
              ? environment
              : await selectedCredentialEnvironment(
                  environment,
                  workspace,
                  deadline,
                );
          const firstOperation = lsRemoteOperation(
            remote,
            requestedRef,
          );
          const firstOutput =
            credentialProvider === undefined || target === undefined
              ? await invokeGit(
                  runGit,
                  executable,
                  commandEnvironment,
                  workspace,
                  remote,
                  deadline,
                  firstOperation,
                )
              : await invokeGitWithCredential(
                  credentialProvider,
                  brokerFactory,
                  target,
                  runGit,
                  executable,
                  commandEnvironment,
                  workspace,
                  remote,
                  deadline,
                  firstOperation,
                );
          const selection = selectRef(requestedRef, firstOutput);

          await invokeGit(
            runGit,
            executable,
            commandEnvironment,
            workspace,
            remote,
            deadline,
            [
              "init",
              "--bare",
              `--template=${workspace.templateDirectory}`,
              workspace.repositoryDirectory,
            ],
          );
          const fetchOperation = [
            "-C",
            workspace.repositoryDirectory,
            "fetch",
            "--quiet",
            "--depth=1",
            "--no-tags",
            "--no-recurse-submodules",
            "--no-write-fetch-head",
            "--no-auto-maintenance",
            "--no-auto-gc",
            "--no-write-commit-graph",
            remote.value,
            selection.commitSha,
          ];
          if (
            credentialProvider === undefined ||
            target === undefined
          ) {
            await invokeGit(
              runGit,
              executable,
              commandEnvironment,
              workspace,
              remote,
              deadline,
              fetchOperation,
              true,
            );
          } else {
            await invokeGitWithCredential(
              credentialProvider,
              brokerFactory,
              target,
              runGit,
              executable,
              commandEnvironment,
              workspace,
              remote,
              deadline,
              fetchOperation,
              true,
            );
          }
          await enforceTemporaryLimit(workspace, deadline);
          const verified = decodeGitOutput(
            await invokeGit(
              runGit,
              executable,
              commandEnvironment,
              workspace,
              remote,
              deadline,
              [
                "-C",
                workspace.repositoryDirectory,
                "rev-parse",
                "--verify",
                `${selection.commitSha}^{commit}`,
              ],
            ),
          )
            .trim()
            .toLocaleLowerCase("en-US");
          if (
            !COMMIT_SHA.test(verified) ||
            verified !== selection.commitSha
          ) {
            throw new GenericGitSnapshotError(
              "GIT_INVALID_RESPONSE",
              "Fetched Generic Git commit could not be verified.",
            );
          }

          const secondOperation = lsRemoteOperation(
            remote,
            requestedRef,
          );
          const secondOutput =
            credentialProvider === undefined || target === undefined
              ? await invokeGit(
                  runGit,
                  executable,
                  commandEnvironment,
                  workspace,
                  remote,
                  deadline,
                  secondOperation,
                )
              : await invokeGitWithCredential(
                  credentialProvider,
                  brokerFactory,
                  target,
                  runGit,
                  executable,
                  commandEnvironment,
                  workspace,
                  remote,
                  deadline,
                  secondOperation,
                );
          const secondSelection = selectRef(
            requestedRef,
            secondOutput,
          );
          if (!sameSelection(selection, secondSelection)) {
            throw new GenericGitSnapshotError(
              "GIT_REF_CHANGED",
              "Requested Generic Git ref changed during ingestion.",
            );
          }

          const archivePath = path.join(
            workspace.root,
            ARCHIVE_FILE_NAME,
          );
          await invokeGit(
            runGit,
            executable,
            commandEnvironment,
            workspace,
            remote,
            deadline,
            [
              "-C",
              workspace.repositoryDirectory,
              "archive",
              "--format=zip",
              "--prefix=snapshot/",
              `--output=${archivePath}`,
              selection.commitSha,
            ],
            true,
          );
          await enforceTemporaryLimit(workspace, deadline);
          const archive = await readArchive(archivePath, deadline, withinDeadline);

          await workspace.dispose();
          workspaceDisposed = true;
          source = openZip(
            archive,
            remote.repository,
            zipOptions(request.snapshotOptions, deadline.signal),
          );
          const snapshot = await withinDeadline(
            materialize(
              source,
              materializationOptions(
                request.snapshotOptions,
                deadline,
              ),
            ),
            deadline,
          );
          return Object.freeze({
            repository: remote.repository,
            commitSha: selection.commitSha,
            transport: remote.transport,
            snapshot,
          });
        } finally {
          try {
            source?.dispose();
          } finally {
            if (!workspaceDisposed) await workspace.dispose();
          }
        }
      },
    );
  } catch (error) {
    if (error instanceof GenericGitSnapshotError) throw error;
    throw new GenericGitSnapshotError(
      "GIT_SNAPSHOT_FAILED",
      "Generic Git snapshot failed safely.",
    );
  }
}

function historyTraversal(
  value: GenericGitHistoryRequest["traversal"],
): "bounded" | "root-to-tip" {
  if (value === undefined || value === "bounded") return "bounded";
  if (value === "root-to-tip") return value;
  throw new GenericGitSnapshotError(
    "GIT_INVALID_REQUEST",
    "Generic Git history traversal must be bounded or root-to-tip.",
  );
}

function historyMaximumCommits(
  value: number,
  traversal: "bounded" | "root-to-tip",
): number {
  const maximum =
    traversal === "root-to-tip"
      ? GENERIC_GIT_ROOT_TO_TIP_HISTORY_MAX_COMMITS
      : GENERIC_GIT_HISTORY_MAX_COMMITS;
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > maximum
  ) {
    throw new GenericGitSnapshotError(
      "GIT_INVALID_REQUEST",
      `Generic Git ${traversal} history must inspect between 1 and ${maximum.toLocaleString(
        "en-US",
      )} first-parent commits.`,
    );
  }
  return value;
}

function historyMaximumChangedPaths(
  value: number | undefined,
): number {
  const resolved =
    value ?? GENERIC_GIT_HISTORY_MAX_CHANGED_PATHS;
  if (
    !Number.isSafeInteger(resolved) ||
    resolved < 1 ||
    resolved > GENERIC_GIT_HISTORY_MAX_CHANGED_PATHS
  ) {
    throw new GenericGitSnapshotError(
      "GIT_INVALID_REQUEST",
      `Generic Git history changed-path entries must be between 1 and ${GENERIC_GIT_HISTORY_MAX_CHANGED_PATHS.toLocaleString(
        "en-US",
      )}.`,
    );
  }
  return resolved;
}

function historyMaximumChangedPathBytes(
  value: number | undefined,
): number {
  const resolved =
    value ?? GENERIC_GIT_HISTORY_MAX_CHANGED_PATH_BYTES;
  if (
    !Number.isSafeInteger(resolved) ||
    resolved < 1 ||
    resolved > GENERIC_GIT_HISTORY_MAX_CHANGED_PATH_BYTES
  ) {
    throw new GenericGitSnapshotError(
      "GIT_INVALID_REQUEST",
      `Generic Git history retained changed-path bytes must be between 1 and ${GENERIC_GIT_HISTORY_MAX_CHANGED_PATH_BYTES.toLocaleString(
        "en-US",
      )}.`,
    );
  }
  return resolved;
}

function canonicalHistoryTagRefs(
  values: readonly string[] | undefined,
): readonly string[] {
  if (values === undefined) return Object.freeze([]);
  if (!Array.isArray(values) || values.length > 64) {
    throw new GenericGitSnapshotError(
      "GIT_INVALID_REQUEST",
      "Generic Git history accepts at most 64 exact tag names.",
    );
  }
  const refs: string[] = [];
  const seen = new Set<string>();
  for (const candidate of values) {
    if (typeof candidate !== "string") {
      throw new GenericGitSnapshotError(
        "GIT_INVALID_REQUEST",
        "Generic Git history tag names are invalid.",
      );
    }
    const value = validateRef(candidate);
    const reference = value.startsWith("refs/tags/")
      ? value
      : value.startsWith("refs/")
        ? undefined
        : `refs/tags/${value}`;
    if (reference === undefined || seen.has(reference)) {
      throw new GenericGitSnapshotError(
        "GIT_INVALID_REQUEST",
        "Generic Git history tag names must be unique exact tags.",
      );
    }
    seen.add(reference);
    refs.push(reference);
  }
  return Object.freeze(refs);
}

function historyTagOperation(
  remote: ParsedRemote,
  references: readonly string[],
): readonly string[] {
  return Object.freeze([
    "ls-remote",
    remote.value,
    ...references.flatMap((reference) => [
      reference,
      `${reference}^{}`,
    ]),
  ]);
}

function historyTagBatches(
  references: readonly string[],
): readonly (readonly string[])[] {
  const batches: string[][] = [];
  for (let index = 0; index < references.length; index += 8) {
    batches.push(references.slice(index, index + 8));
  }
  return Object.freeze(
    batches.map((batch) => Object.freeze(batch)),
  );
}

function historyTags(
  references: readonly string[],
  output: Uint8Array,
): readonly GenericGitHistoryTag[] {
  if (references.length === 0) return Object.freeze([]);
  const parsed = parseLsRemote(output);
  const expected = new Set(
    references.flatMap((reference) => [
      reference,
      `${reference}^{}`,
    ]),
  );
  if (
    parsed.symbolicHead !== undefined ||
    parsed.records.some((record) => !expected.has(record.name))
  ) {
    throw new GenericGitSnapshotError(
      "GIT_INVALID_RESPONSE",
      "Installed Git returned unexpected history tag data.",
    );
  }
  return Object.freeze(
    references.map((reference) => {
      const tag = oneRecord(parsed.records, reference);
      const peeled = oneRecord(parsed.records, `${reference}^{}`);
      if (tag === undefined || (peeled !== undefined && tag === undefined)) {
        throw new GenericGitSnapshotError(
          "GIT_REF_UNAVAILABLE",
          "A requested Generic Git history tag is unavailable.",
        );
      }
      return Object.freeze({
        name: reference.slice("refs/tags/".length),
        commitSha: peeled?.objectSha ?? tag.objectSha,
      });
    }),
  );
}

function sameHistoryTags(
  left: readonly GenericGitHistoryTag[],
  right: readonly GenericGitHistoryTag[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (tag, index) =>
        tag.name === right[index]?.name &&
        tag.commitSha === right[index]?.commitSha,
    )
  );
}

function historyBackend(
  output: Uint8Array,
): GenericGitHistoryBackend {
  const decoded = decodeGitOutput(output);
  const line = decoded.endsWith("\r\n")
    ? decoded.slice(0, -2)
    : decoded.endsWith("\n")
      ? decoded.slice(0, -1)
      : decoded;
  const prefix = "git version ";
  const version = line.startsWith(prefix)
    ? line.slice(prefix.length)
    : "";
  if (
    version.length === 0 ||
    version.length > 160 ||
    version !== version.trim() ||
    version !== version.normalize("NFC") ||
    !/^[\u0020-\u007e]+$/u.test(version)
  ) {
    throw new GenericGitSnapshotError(
      "GIT_INVALID_RESPONSE",
      "Installed Git returned an invalid backend version.",
    );
  }
  return Object.freeze({
    name: "git",
    version,
    renamePolicyRevision:
      GENERIC_GIT_HISTORY_RENAME_POLICY_REVISION,
  });
}

function parseHistoryCommits(
  output: Uint8Array,
): readonly GenericGitHistoryCommit[] {
  const text = decodeGitOutput(
    output,
    MAX_GIT_HISTORY_INDEX_BYTES,
  );
  const commits: GenericGitHistoryCommit[] = [];
  const seen = new Set<string>();
  for (const rawLine of text.split("\n")) {
    const line = rawLine.endsWith("\r")
      ? rawLine.slice(0, -1)
      : rawLine;
    if (line.length === 0) continue;
    const fields = line.split(" ");
    const timestampText = fields.shift();
    const sha = fields.shift()?.toLocaleLowerCase("en-US");
    const parents = fields.map((value) =>
      value.toLocaleLowerCase("en-US"),
    );
    const timestamp = Number(timestampText);
    if (
      timestampText === undefined ||
      !/^(?:0|[1-9][0-9]{0,15})$/u.test(timestampText) ||
      !Number.isSafeInteger(timestamp) ||
      timestamp < 0 ||
      sha === undefined ||
      !COMMIT_SHA.test(sha) ||
      parents.some((parent) => !COMMIT_SHA.test(parent)) ||
      new Set(parents).size !== parents.length ||
      parents.includes(sha) ||
      seen.has(sha)
    ) {
      throw new GenericGitSnapshotError(
        "GIT_INVALID_RESPONSE",
        "Installed Git returned invalid history metadata.",
      );
    }
    const date = new Date(timestamp * 1_000);
    if (Number.isNaN(date.getTime())) {
      throw new GenericGitSnapshotError(
        "GIT_INVALID_RESPONSE",
        "Installed Git returned invalid history metadata.",
      );
    }
    const committedAt = date.toISOString();
    if (committedAt.length !== 24) {
      throw new GenericGitSnapshotError(
        "GIT_INVALID_RESPONSE",
        "Installed Git returned a commit timestamp outside the supported four-digit UTC year range.",
      );
    }
    seen.add(sha);
    commits.push(
      Object.freeze({
        sha,
        parents: Object.freeze(parents),
        committedAtSeconds: timestamp,
        committedAt,
      }),
    );
  }
  if (commits.length === 0) {
    throw new GenericGitSnapshotError(
      "GIT_INVALID_RESPONSE",
      "Installed Git returned no first-parent history.",
    );
  }
  for (let index = 0; index + 1 < commits.length; index += 1) {
    if (commits[index]?.parents[0] !== commits[index + 1]?.sha) {
      throw new GenericGitSnapshotError(
        "GIT_INVALID_RESPONSE",
        "Installed Git returned a non-linear first-parent history.",
      );
    }
  }
  return Object.freeze(commits);
}

function partialCloneUnavailable(): GenericGitSnapshotError {
  return new GenericGitSnapshotError(
    "GIT_PARTIAL_CLONE_UNAVAILABLE",
    "The remote did not provide verifiable filtered history; complete root-to-tip import stopped safely.",
  );
}

function validatePartialHistoryFetchResult(
  result: GitProcessResult,
): void {
  if (result.stderr === undefined) throw partialCloneUnavailable();
  let diagnostics: string;
  try {
    diagnostics = new TextDecoder("utf-8", { fatal: true }).decode(
      result.stderr,
    );
  } catch {
    throw partialCloneUnavailable();
  }
  if (
    /(?:filtering not recognized by server|filtering is not supported by server|server does not support filter)[^\r\n]*(?:ignoring)?/iu.test(
      diagnostics,
    )
  ) {
    throw partialCloneUnavailable();
  }
}

interface HistoryObjectMarkers {
  readonly missing: ReadonlySet<string>;
  readonly omitted: ReadonlySet<string>;
}

function historyObjectMarkers(
  output: Uint8Array,
): HistoryObjectMarkers {
  const text = decodeGitOutput(
    output,
    MAX_GIT_HISTORY_INDEX_BYTES,
  );
  const missing = new Set<string>();
  const omitted = new Set<string>();
  for (const rawLine of text.split("\n")) {
    const line = rawLine.endsWith("\r")
      ? rawLine.slice(0, -1)
      : rawLine;
    if (line.length === 0) continue;
    const match = /^([?~]?)([0-9a-f]{40})$/u.exec(line);
    if (match === null) {
      throw new GenericGitSnapshotError(
        "GIT_INVALID_RESPONSE",
        "Installed Git returned invalid partial-clone object metadata.",
      );
    }
    if (match[1] === "?") missing.add(match[2]!);
    if (match[1] === "~") omitted.add(match[2]!);
  }
  return Object.freeze({ missing, omitted });
}

function validatePartialHistoryObjectInventory(
  reachable: Uint8Array,
  filtered: Uint8Array,
): void {
  const reachableMarkers = historyObjectMarkers(reachable);
  const filteredMarkers = historyObjectMarkers(filtered);
  if (
    [...reachableMarkers.missing].some(
      (objectSha) => !filteredMarkers.omitted.has(objectSha),
    )
  ) {
    throw new GenericGitSnapshotError(
      "GIT_INVALID_RESPONSE",
      "Filtered history omitted an object outside the declared partial-clone filter.",
    );
  }
  if (
    reachableMarkers.missing.size === 0 &&
    filteredMarkers.omitted.size > 0
  ) {
    throw partialCloneUnavailable();
  }
}

const PROJECT_START_PATHSPECS = Object.freeze(
  ["cs", "js", "jsx", "ts", "tsx"].map(
    (extension) => `:(icase,glob)**/*.${extension}`,
  ),
);

function historyProjectStartOperation(
  repositoryDirectory: string,
  tipSha: string,
): readonly string[] {
  return Object.freeze([
    "-C",
    repositoryDirectory,
    "-c",
    "diff.renames=false",
    "log",
    "--first-parent",
    "--full-history",
    "--reverse",
    "--topo-order",
    "--no-abbrev",
    "--format=format:%x00commit:%H%x00",
    "--raw",
    "-z",
    "--no-ext-diff",
    "--no-textconv",
    "--no-color",
    "--no-renames",
    "--diff-filter=AMT",
    "--diff-merges=first-parent",
    "--ignore-submodules=all",
    "--root",
    tipSha,
    "--",
    ...PROJECT_START_PATHSPECS,
  ]);
}

function parseHistoryProjectStart(
  output: Uint8Array,
  commits: readonly GenericGitHistoryCommit[],
  maximumEntries: number,
  maximumBytes: number,
): string | undefined {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(output);
  } catch {
    throw new GenericGitSnapshotError(
      "GIT_INVALID_RESPONSE",
      "Installed Git returned invalid project-start path metadata.",
    );
  }
  const oldestIndexBySha = new Map(
    [...commits]
      .reverse()
      .map(({ sha }, index) => [sha, index] as const),
  );
  let cursor = 0;
  let currentCommit: string | undefined;
  let previousCommitIndex = -1;
  let entries = 0;
  let retainedBytes = 0;
  let detected: string | undefined;
  const nextField = (): string | undefined => {
    const terminator = text.indexOf("\0", cursor);
    if (terminator < 0) return undefined;
    const field = text.slice(cursor, terminator);
    cursor = terminator + 1;
    return field;
  };
  const admitPath = (rawPath: string): string => {
    const path = normalizeSnapshotPath(rawPath);
    const bytes =
      Buffer.byteLength(path, "utf8") +
      GENERIC_GIT_HISTORY_CHANGED_PATH_RECORD_OVERHEAD_BYTES;
    if (
      entries >= maximumEntries ||
      retainedBytes > maximumBytes - bytes
    ) {
      throw new GenericGitSnapshotError(
        "GIT_OUTPUT_TOO_LARGE",
        "Generic Git project-start detection exceeded its path metadata limit.",
      );
    }
    entries += 1;
    retainedBytes += bytes;
    return path;
  };

  while (cursor < text.length) {
    const rawField = nextField();
    if (rawField === undefined) break;
    if (rawField === "") continue;
    if (rawField.startsWith("commit:")) {
      const sha = rawField.slice("commit:".length);
      const commitIndex = oldestIndexBySha.get(sha);
      if (
        !COMMIT_SHA.test(sha) ||
        commitIndex === undefined ||
        commitIndex <= previousCommitIndex
      ) {
        throw new GenericGitSnapshotError(
          "GIT_INVALID_RESPONSE",
          "Installed Git returned invalid project-start commit metadata.",
        );
      }
      currentCommit = sha;
      previousCommitIndex = commitIndex;
      continue;
    }
    const field = rawField.startsWith("\n")
      ? rawField.slice(1)
      : rawField;
    const header =
      /^:([0-7]{6}) ([0-7]{6}) [0-9a-f]{40} [0-9a-f]{40} ([AMT])$/u.exec(
        field,
      );
    if (header === null || currentCommit === undefined) {
      throw new GenericGitSnapshotError(
        "GIT_INVALID_RESPONSE",
        "Installed Git returned invalid project-start tree metadata.",
      );
    }
    const currentPath = nextField();
    if (currentPath === undefined) {
      throw new GenericGitSnapshotError(
        "GIT_INVALID_RESPONSE",
        "Installed Git returned incomplete project-start path metadata.",
      );
    }
    const normalizedCurrentPath = admitPath(currentPath);
    const newMode = header[2]!;
    if (
      detected === undefined &&
      (newMode === "100644" || newMode === "100755") &&
      isAnalyzerCandidateSourcePath(normalizedCurrentPath)
    ) {
      detected = currentCommit;
    }
  }
  if (cursor !== text.length) {
    throw new GenericGitSnapshotError(
      "GIT_INVALID_RESPONSE",
      "Installed Git returned incomplete project-start metadata.",
    );
  }
  return detected;
}

function historyDiffTreeOperation(
  repositoryDirectory: string,
  olderSha: string | undefined,
  newerSha: string,
): readonly string[] {
  return Object.freeze([
    "-C",
    repositoryDirectory,
    "-c",
    "core.bigFileThreshold=512m",
    "-c",
    "diff.algorithm=myers",
    "-c",
    "diff.indentHeuristic=false",
    "-c",
    "diff.orderFile=",
    "-c",
    "diff.renameFromRewrite=false",
    "-c",
    "diff.renameLimit=10000",
    "-c",
    "diff.renames=false",
    "diff-tree",
    "--no-commit-id",
    "--no-ext-diff",
    "--no-textconv",
    "--no-color",
    "--name-status",
    "-r",
    "-z",
    "--diff-algorithm=myers",
    "--no-indent-heuristic",
    "--find-renames=50%",
    "--diff-filter=ADMRT",
    "--ignore-submodules=none",
    ...(olderSha === undefined
      ? ["--root", newerSha]
      : [olderSha, newerSha]),
    "--",
  ]);
}

function historyChangeKind(
  status: string,
): GenericGitHistoryPathChange["kind"] | "renamed" {
  if (status === "A") return "added";
  if (status === "D") return "deleted";
  if (status === "M") return "modified";
  if (status === "T") return "type-changed";
  // Git's --name-status protocol always pads similarity scores below 100
  // to three decimal digits (for example, R099 and R050).
  if (/^R(?:100|0[0-9]{2})$/u.test(status)) return "renamed";
  throw new GenericGitSnapshotError(
    "GIT_INVALID_RESPONSE",
    "Installed Git returned an unsupported history change.",
  );
}

interface HistoryChangeAdmission {
  readonly existingEntries: number;
  readonly existingBytes: number;
  readonly maximumEntries: number;
  readonly maximumBytes: number;
}

interface ParsedHistoryChanges {
  readonly changes: readonly GenericGitHistoryPathChange[];
  readonly entries: number;
  readonly bytes: number;
}

function parseHistoryChanges(
  output: Uint8Array,
  admission: HistoryChangeAdmission,
): ParsedHistoryChanges {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(output);
  } catch {
    throw new GenericGitSnapshotError(
      "GIT_INVALID_RESPONSE",
      "Installed Git returned invalid history paths.",
    );
  }
  if (text.length === 0) {
    return Object.freeze({
      changes: Object.freeze([]),
      entries: admission.existingEntries,
      bytes: admission.existingBytes,
    });
  }
  let cursor = 0;
  const nextField = (): string | undefined => {
    const terminator = text.indexOf("\0", cursor);
    if (terminator < 0) return undefined;
    const field = text.slice(cursor, terminator);
    cursor = terminator + 1;
    return field;
  };
  const changes: GenericGitHistoryPathChange[] = [];
  let entries = admission.existingEntries;
  let retainedBytes = admission.existingBytes;
  const admit = (
    path: string,
    previousPath?: string,
  ): void => {
    const addedEntries = previousPath === undefined ? 1 : 2;
    const addedBytes =
      GENERIC_GIT_HISTORY_CHANGED_PATH_RECORD_OVERHEAD_BYTES +
      Buffer.byteLength(path, "utf8") +
      (previousPath === undefined
        ? 0
        : Buffer.byteLength(previousPath, "utf8"));
    if (
      entries > admission.maximumEntries - addedEntries ||
      retainedBytes > admission.maximumBytes - addedBytes
    ) {
      throw new GenericGitSnapshotError(
        "GIT_OUTPUT_TOO_LARGE",
        "Generic Git history exceeded its changed-path retention limit.",
      );
    }
    entries += addedEntries;
    retainedBytes += addedBytes;
  };
  while (cursor < text.length) {
    const status = nextField();
    if (status === undefined || status.length === 0) {
      throw new GenericGitSnapshotError(
        "GIT_INVALID_RESPONSE",
        "Installed Git returned invalid history paths.",
      );
    }
    const kind = historyChangeKind(status);
    if (kind === "renamed") {
      const previous = nextField();
      const current = nextField();
      if (previous === undefined || current === undefined) {
        throw new GenericGitSnapshotError(
          "GIT_INVALID_RESPONSE",
          "Installed Git returned incomplete rename data.",
        );
      }
      const previousPath = normalizeSnapshotPath(previous);
      const currentPath = normalizeSnapshotPath(current);
      admit(currentPath, previousPath);
      changes.push(
        Object.freeze({
          kind,
          previousPath,
          path: currentPath,
        }),
      );
      continue;
    }
    const current = nextField();
    if (current === undefined) {
      throw new GenericGitSnapshotError(
        "GIT_INVALID_RESPONSE",
        "Installed Git returned incomplete history path data.",
      );
    }
    const currentPath = normalizeSnapshotPath(current);
    admit(currentPath);
    changes.push(
      Object.freeze({
        kind,
        path: currentPath,
      }),
    );
  }
  if (cursor !== text.length) {
    throw new GenericGitSnapshotError(
      "GIT_INVALID_RESPONSE",
      "Installed Git returned incomplete history paths.",
    );
  }
  return Object.freeze({
    changes: Object.freeze(changes),
    entries,
    bytes: retainedBytes,
  });
}

/**
 * Opens one bounded, hardened Git session for history planning and streaming
 * snapshots. The workspace, credential broker, archives, and callback-scoped
 * methods are always disposed before the promise settles.
 */
export async function withGenericGitHistoryRepository<T>(
  request: GenericGitHistoryRequest,
  consumer: GenericGitHistoryConsumer<T>,
  dependencies: GenericGitSnapshotDependencies = {},
): Promise<T> {
  if (typeof consumer !== "function") {
    throw new GenericGitSnapshotError(
      "GIT_INVALID_REQUEST",
      "Generic Git history consumer is invalid.",
    );
  }
  const remote = parseRemote(request.repositoryUrl);
  const requestedRef =
    request.ref === undefined ? undefined : validateRef(request.ref);
  const traversal = historyTraversal(request.traversal);
  const maximumCommits = historyMaximumCommits(
    request.maximumCommits,
    traversal,
  );
  const maximumChangedPathEntries = historyMaximumChangedPaths(
    request.maximumChangedPathEntries,
  );
  const maximumChangedPathBytes = historyMaximumChangedPathBytes(
    request.maximumChangedPathBytes,
  );
  const tagReferences = canonicalHistoryTagRefs(request.tagNames);
  const timeoutMs = resolveTimeout(request.timeoutMs);
  const runGit = dependencies.runGit ?? runInstalledGit;
  const createWorkspace =
    dependencies.createTemporaryWorkspace ??
    (() =>
      createGenericGitTemporaryWorkspace(
        dependencies.temporaryWorkspaceOptions,
      ));
  const openZip =
    dependencies.openZipSnapshotSource ?? openZipSnapshotSource;
  const materialize =
    dependencies.materializeRepositorySnapshot ??
    materializeRepositorySnapshot;
  const executable = dependencies.gitExecutable ?? "git";
  const environment = safeEnvironment(
    dependencies.environment ?? process.env,
  );
  const credentialProvider = validateCredentialProvider(
    dependencies.credentialProvider,
    remote,
  );
  const isolateCredentials = resolveCredentialIsolation(
    dependencies.isolateCredentials,
  );
  const brokerFactory =
    dependencies.createCredentialBroker ??
    createGenericGitCredentialBroker;
  if (
    credentialProvider !== undefined &&
    typeof brokerFactory !== "function"
  ) {
    throw invalidCredentialProvider();
  }
  const target =
    credentialProvider === undefined
      ? undefined
      : credentialTarget(remote);

  try {
    return await withCombinedDeadline(
      timeoutMs,
      [request.signal, request.snapshotOptions?.signal],
      async (deadline) => {
        const workspace = await createWorkspaceWithinDeadline(
          createWorkspace,
          deadline,
        );
        try {
          const commandEnvironment =
            credentialProvider === undefined && !isolateCredentials
              ? environment
              : await selectedCredentialEnvironment(
                  environment,
                  workspace,
                  deadline,
                );
          const runWithDeadline = async (
            operation: readonly string[],
            monitorDisk: boolean,
            operationDeadline: CombinedDeadline,
            invocationOptions: GitInvocationOptions = {},
          ): Promise<Uint8Array> =>
            credentialProvider === undefined || target === undefined
              ? await invokeGit(
                  runGit,
                  executable,
                  commandEnvironment,
                  workspace,
                  remote,
                  operationDeadline,
                  operation,
                  monitorDisk,
                  undefined,
                  false,
                  invocationOptions,
                )
              : await invokeGitWithCredential(
                  credentialProvider,
                  brokerFactory,
                  target,
                  runGit,
                  executable,
                  commandEnvironment,
                  workspace,
                  remote,
                  operationDeadline,
                  operation,
                  monitorDisk,
                  invocationOptions,
                );
          const run = async (
            operation: readonly string[],
            monitorDisk = false,
            invocationOptions: GitInvocationOptions = {},
          ): Promise<Uint8Array> =>
            await runWithDeadline(
              operation,
              monitorDisk,
              deadline,
              invocationOptions,
            );
          const readTags = async (): Promise<
            readonly GenericGitHistoryTag[]
          > => {
            const tags: GenericGitHistoryTag[] = [];
            for (const batch of historyTagBatches(tagReferences)) {
              tags.push(
                ...historyTags(
                  batch,
                  await run(historyTagOperation(remote, batch)),
                ),
              );
            }
            return Object.freeze(tags);
          };

          const backend = historyBackend(await run(["--version"]));
          const firstSelection = selectRef(
            requestedRef,
            await run(lsRemoteOperation(remote, requestedRef)),
          );
          const firstTags =
            tagReferences.length === 0
              ? Object.freeze([] as GenericGitHistoryTag[])
              : await readTags();

          await run([
            "init",
            "--bare",
            `--template=${workspace.templateDirectory}`,
            workspace.repositoryDirectory,
          ]);
          if (traversal === "root-to-tip") {
            await run([
              "-C",
              workspace.repositoryDirectory,
              "remote",
              "add",
              HISTORY_PROMISOR_REMOTE,
              remote.value,
            ]);
            await run([
              "-C",
              workspace.repositoryDirectory,
              "config",
              `remote.${HISTORY_PROMISOR_REMOTE}.promisor`,
              "true",
            ]);
            await run([
              "-C",
              workspace.repositoryDirectory,
              "config",
              `remote.${HISTORY_PROMISOR_REMOTE}.partialclonefilter`,
              HISTORY_PARTIAL_CLONE_FILTER,
            ]);
          }
          await run(
            [
              "-C",
              workspace.repositoryDirectory,
              "fetch",
              "--quiet",
              `--depth=${maximumCommits + 1}`,
              ...(traversal === "root-to-tip"
                ? [`--filter=${HISTORY_PARTIAL_CLONE_FILTER}`]
                : []),
              "--no-tags",
              "--no-recurse-submodules",
              "--no-write-fetch-head",
              "--no-auto-maintenance",
              "--no-auto-gc",
              "--no-write-commit-graph",
              traversal === "root-to-tip"
                ? HISTORY_PROMISOR_REMOTE
                : remote.value,
              firstSelection.commitSha,
            ],
            true,
            traversal === "root-to-tip"
              ? { validateResult: validatePartialHistoryFetchResult }
              : {},
          );
          await enforceTemporaryLimit(workspace, deadline);

          const verified = decodeGitOutput(
            await run([
              "-C",
              workspace.repositoryDirectory,
              "rev-parse",
              "--verify",
              `${firstSelection.commitSha}^{commit}`,
            ]),
          )
            .trim()
            .toLocaleLowerCase("en-US");
          if (
            !COMMIT_SHA.test(verified) ||
            verified !== firstSelection.commitSha
          ) {
            throw new GenericGitSnapshotError(
              "GIT_INVALID_RESPONSE",
              "Fetched Generic Git history tip could not be verified.",
            );
          }
          if (traversal === "root-to-tip") {
            const inventoryArguments = [
              "-C",
              workspace.repositoryDirectory,
              "rev-list",
              "--objects",
              "--no-object-names",
              "--missing=print",
              "--max-count=1",
              firstSelection.commitSha,
            ] as const;
            const reachable = await run(
              inventoryArguments,
              false,
              { maximumStdoutBytes: MAX_GIT_HISTORY_INDEX_BYTES },
            );
            const filtered = await run(
              [
                ...inventoryArguments.slice(0, -1),
                `--filter=${HISTORY_PARTIAL_CLONE_FILTER}`,
                "--filter-print-omitted",
                firstSelection.commitSha,
              ],
              false,
              { maximumStdoutBytes: MAX_GIT_HISTORY_INDEX_BYTES },
            );
            validatePartialHistoryObjectInventory(
              reachable,
              filtered,
            );
          }

          const commits = parseHistoryCommits(
            await run(
              [
                "-C",
                workspace.repositoryDirectory,
                "rev-list",
                "--first-parent",
                "--topo-order",
                `--max-count=${maximumCommits + 1}`,
                "--parents",
                "--timestamp",
                firstSelection.commitSha,
              ],
              false,
              { maximumStdoutBytes: MAX_GIT_HISTORY_INDEX_BYTES },
            ),
          );
          if (commits[0]?.sha !== firstSelection.commitSha) {
            throw new GenericGitSnapshotError(
              "GIT_INVALID_RESPONSE",
              "Installed Git history did not start at the selected tip.",
            );
          }
          const oldestCommit = commits.at(-1);
          if (oldestCommit === undefined) {
            throw new GenericGitSnapshotError(
              "GIT_INVALID_RESPONSE",
              "Installed Git returned no first-parent history boundary.",
            );
          }
          const oldestCommitIsShallow =
            await oldestCommitIsShallowBoundary(
              workspace,
              oldestCommit.sha,
              deadline,
            );

          const commitsBySha = new Map(
            commits.map((commit) => [commit.sha, commit]),
          );
          const commitIndexBySha = new Map(
            commits.map((commit, index) => [commit.sha, index]),
          );
          const sessionController = new AbortController();
          const abortSession = (): void => sessionController.abort();
          deadline.signal.addEventListener("abort", abortSession, {
            once: true,
          });
          if (deadline.signal.aborted) abortSession();
          const sessionDeadline: CombinedDeadline = {
            signal: sessionController.signal,
            remainingMilliseconds: () => {
              if (sessionController.signal.aborted) throw INTERNAL_ABORT;
              return deadline.remainingMilliseconds();
            },
          };
          const sessionRun = async (
            operation: readonly string[],
            monitorDisk = false,
            invocationOptions: GitInvocationOptions = {},
          ): Promise<Uint8Array> =>
            await runWithDeadline(
              operation,
              monitorDisk,
              sessionDeadline,
              invocationOptions,
            );
          let changedPaths = 0;
          let changedPathBytes = 0;
          let projectStartResolved = false;
          let projectStart: string | undefined;
          let active = true;
          let operationActive = false;
          let pendingOperation: Promise<unknown> | undefined;

          const remainingDiffOutputBytes = (): number =>
            Math.min(
              GENERIC_GIT_HISTORY_MAX_CHANGED_PATH_BYTES,
              Math.max(
                0,
                maximumChangedPathBytes - changedPathBytes,
              ),
            );

          const exclusive = async <Value>(
            operation: () => Promise<Value>,
          ): Promise<Value> => {
            if (!active || operationActive) {
              throw new GenericGitSnapshotError(
                "GIT_INVALID_REQUEST",
                "Generic Git history session is no longer available.",
              );
            }
            operationActive = true;
            const pending = Promise.resolve().then(operation);
            pendingOperation = pending;
            void pending.catch(() => undefined);
            try {
              return await pending;
            } finally {
              if (pendingOperation === pending) {
                pendingOperation = undefined;
              }
              operationActive = false;
            }
          };

          const detectProjectStart = (): Promise<string | undefined> => {
            const pending = exclusive(async () => {
              if (projectStartResolved) return projectStart;
              const maximumProjectStartBytes = Math.min(
                maximumChangedPathBytes,
                GENERIC_GIT_PROJECT_START_MAX_PATH_BYTES,
              );
              const output = await sessionRun(
                historyProjectStartOperation(
                  workspace.repositoryDirectory,
                  firstSelection.commitSha,
                ),
                true,
                { maximumStdoutBytes: maximumProjectStartBytes },
              );
              projectStart = parseHistoryProjectStart(
                output,
                commits,
                Math.min(
                  maximumChangedPathEntries,
                  GENERIC_GIT_PROJECT_START_MAX_PATHS,
                ),
                maximumProjectStartBytes,
              );
              projectStartResolved = true;
              return projectStart;
            });
            void pending.catch(() => undefined);
            return pending;
          };

          const readChanges = (
            commitSha: string,
          ): Promise<readonly GenericGitHistoryPathChange[]> => {
            const pending = exclusive(async () => {
              const commit = commitsBySha.get(commitSha);
              if (commit === undefined) {
                throw new GenericGitSnapshotError(
                  "GIT_INVALID_REQUEST",
                  "History changes were requested for an unknown commit.",
                );
              }
              const parent = commit.parents[0];
              const output = await sessionRun(
                historyDiffTreeOperation(
                  workspace.repositoryDirectory,
                  parent,
                  commit.sha,
                ),
                true,
                {
                  maximumStdoutBytes: remainingDiffOutputBytes(),
                },
              );
              const parsed = parseHistoryChanges(output, {
                existingEntries: changedPaths,
                existingBytes: changedPathBytes,
                maximumEntries: maximumChangedPathEntries,
                maximumBytes: maximumChangedPathBytes,
              });
              changedPaths = parsed.entries;
              changedPathBytes = parsed.bytes;
              return parsed.changes;
            });
            void pending.catch(() => undefined);
            return pending;
          };

          const readChangesBetween = (
            olderSha: string,
            newerSha: string,
          ): Promise<readonly GenericGitHistoryPathChange[]> => {
            const pending = exclusive(async () => {
              const olderIndex = commitIndexBySha.get(olderSha);
              const newerIndex = commitIndexBySha.get(newerSha);
              if (
                olderIndex === undefined ||
                newerIndex === undefined ||
                olderIndex <= newerIndex
              ) {
                throw new GenericGitSnapshotError(
                  "GIT_INVALID_REQUEST",
                  "History change boundaries must be known older-to-newer first-parent ancestry.",
                );
              }
              const output = await sessionRun(
                historyDiffTreeOperation(
                  workspace.repositoryDirectory,
                  olderSha,
                  newerSha,
                ),
                true,
                {
                  maximumStdoutBytes: remainingDiffOutputBytes(),
                },
              );
              const parsed = parseHistoryChanges(output, {
                existingEntries: changedPaths,
                existingBytes: changedPathBytes,
                maximumEntries: maximumChangedPathEntries,
                maximumBytes: maximumChangedPathBytes,
              });
              changedPaths = parsed.entries;
              changedPathBytes = parsed.bytes;
              return parsed.changes;
            });
            void pending.catch(() => undefined);
            return pending;
          };

          const readSnapshot = (
            commitSha: string,
          ): Promise<RepositorySnapshot> => {
            const pending = exclusive(async () => {
              if (!commitsBySha.has(commitSha)) {
                throw new GenericGitSnapshotError(
                  "GIT_INVALID_REQUEST",
                  "A snapshot was requested for an unknown history commit.",
                );
              }
              const archivePath = path.join(
                workspace.root,
                ARCHIVE_FILE_NAME,
              );
              let source: DisposableSnapshotSource | undefined;
              try {
                await sessionRun(
                  [
                    "-C",
                    workspace.repositoryDirectory,
                    "archive",
                    "--format=zip",
                    "--prefix=snapshot/",
                    `--output=${archivePath}`,
                    commitSha,
                  ],
                  true,
                );
                await enforceTemporaryLimit(
                  workspace,
                  sessionDeadline,
                );
                const archive = await readArchive(
                  archivePath,
                  sessionDeadline,
                  withinDeadline,
                );
                try {
                  await withinDeadline(
                    fs.unlink(archivePath),
                    sessionDeadline,
                  );
                } catch (error) {
                  if (error === INTERNAL_ABORT) throw error;
                  throw new GenericGitSnapshotError(
                    "GIT_CLEANUP_FAILED",
                    "Temporary Git history archive cleanup failed.",
                  );
                }
                source = openZip(
                  archive,
                  remote.repository,
                  zipOptions(
                    request.snapshotOptions,
                    sessionDeadline.signal,
                  ),
                );
                return await withinDeadline(
                  materialize(
                    source,
                    materializationOptions(
                      request.snapshotOptions,
                      sessionDeadline,
                    ),
                  ),
                  sessionDeadline,
                );
              } finally {
                source?.dispose();
              }
            });
            void pending.catch(() => undefined);
            return pending;
          };

          const session: GenericGitHistorySession = Object.freeze({
            repository: remote.repository,
            tipSha: firstSelection.commitSha,
            transport: remote.transport,
            oldestCommitIsShallow,
            backend,
            commits,
            tags: firstTags,
            detectProjectStart,
            readChanges,
            readChangesBetween,
            readSnapshot,
          });

          let consumed!: T;
          let consumerFailed = false;
          let consumerFailure: unknown;
          try {
            consumed = await withinDeadline(
              Promise.resolve().then(() => consumer(session)),
              deadline,
            );
          } catch (error) {
            consumerFailed = true;
            consumerFailure = error;
          } finally {
            active = false;
          }
          const leftOperationRunning = operationActive;
          sessionController.abort();
          deadline.signal.removeEventListener("abort", abortSession);
          const unfinished = pendingOperation;
          if (unfinished !== undefined) {
            try {
              await unfinished;
            } catch {
              // The session-scope error below is stable and intentional.
            }
          }
          if (leftOperationRunning) {
            throw new GenericGitSnapshotError(
              "GIT_INVALID_REQUEST",
              "Generic Git history consumer left an operation running.",
            );
          }
          if (consumerFailed) throw consumerFailure;

          const secondSelection = selectRef(
            requestedRef,
            await run(lsRemoteOperation(remote, requestedRef)),
          );
          const secondTags =
            tagReferences.length === 0
              ? Object.freeze([] as GenericGitHistoryTag[])
              : await readTags();
          if (
            !sameSelection(firstSelection, secondSelection) ||
            !sameHistoryTags(firstTags, secondTags)
          ) {
            throw new GenericGitSnapshotError(
              "GIT_REF_CHANGED",
              "Requested Generic Git history refs changed during ingestion.",
            );
          }
          return consumed;
        } finally {
          await workspace.dispose();
        }
      },
    );
  } catch (error) {
    if (error instanceof GenericGitSnapshotError) throw error;
    throw new GenericGitSnapshotError(
      "GIT_HISTORY_FAILED",
      "Generic Git history failed safely.",
    );
  }
}
