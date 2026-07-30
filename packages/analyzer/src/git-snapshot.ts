import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs, type BigIntStats } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_SNAPSHOT_LIMITS,
  materializeRepositorySnapshot,
  type RepositorySnapshot,
  type SnapshotOptions,
} from "./snapshot.js";
import {
  openZipSnapshotSource,
  type DisposableSnapshotSource,
  type ZipSnapshotSourceOptions,
} from "./zip-snapshot-source.js";

const MEBIBYTE = 1024 * 1024;
const COMMIT_SHA = /^[0-9a-f]{40}$/u;
const INVALID_INPUT_CHARACTERS = /[\p{Cc}\p{Cf}\p{Cs}]/u;
const INVALID_REF_CHARACTERS =
  /[\s\\~^:?*]|\[|\]|\p{Cc}|\p{Cf}|\p{Cs}/u;
const SCP_REMOTE =
  /^(?:([A-Za-z0-9][A-Za-z0-9._-]*)@)?(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?):(.+)$/u;
const MAX_REMOTE_CODE_UNITS = 4_096;
const MAX_REMOTE_BYTES = 8_192;
const MAX_REF_CODE_UNITS = 1_024;
const MAX_REF_BYTES = 256;
const MAX_REPOSITORY_NAME_BYTES = 256;
const MAX_GIT_OUTPUT_BYTES = MEBIBYTE;
const MAX_GIT_DIAGNOSTIC_BYTES = 64 * 1024;
const MAX_ARCHIVE_BYTES = 64 * MEBIBYTE;
const MAX_TEMPORARY_BYTES = 2 * 1024 * MEBIBYTE;
const MAX_TIMEOUT_MS = 2_147_483_647;
const ARCHIVE_FILE_NAME = "snapshot.zip";
const INTERNAL_ABORT = Object.freeze({ kind: "git-snapshot-abort" });

export const GENERIC_GIT_SNAPSHOT_TIMEOUT_MS =
  DEFAULT_SNAPSHOT_LIMITS.timeoutMs;
export const GENERIC_GIT_ARCHIVE_MAX_BYTES = MAX_ARCHIVE_BYTES;
export const GENERIC_GIT_TEMPORARY_MAX_BYTES = MAX_TEMPORARY_BYTES;
export const GENERIC_GIT_PRESECURED_WINDOWS_ACL =
  "pre-secured-private-directory" as const;
export const GENERIC_GIT_PRESECURED_CANONICAL_ANCESTRY =
  "pre-secured-canonical-entry-and-ancestry-against-rename-delete" as const;

export type GenericGitTransport = "https" | "ssh";

export interface GenericGitRemoteOrigin {
  readonly scheme: GenericGitTransport;
  readonly hostname: string;
  readonly port: number;
}

export interface GenericGitSnapshotRequest {
  readonly repositoryUrl: string;
  readonly ref?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly snapshotOptions?: SnapshotOptions;
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

export type GenericGitSnapshotErrorCode =
  | "GIT_ABORTED"
  | "GIT_ARCHIVE_TOO_LARGE"
  | "GIT_CLEANUP_FAILED"
  | "GIT_COMMAND_FAILED"
  | "GIT_DEADLINE_EXCEEDED"
  | "GIT_INVALID_REF"
  | "GIT_INVALID_REMOTE"
  | "GIT_INVALID_RESPONSE"
  | "GIT_OUTPUT_TOO_LARGE"
  | "GIT_REF_AMBIGUOUS"
  | "GIT_REF_CHANGED"
  | "GIT_REF_UNAVAILABLE"
  | "GIT_SNAPSHOT_FAILED"
  | "GIT_TEMPORARY_LIMIT"
  | "GIT_TEMPORARY_WORKSPACE_INVALID";

export class GenericGitSnapshotError extends Error {
  public constructor(
    readonly code: GenericGitSnapshotErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "GenericGitSnapshotError";
  }
}

interface ParsedRemote {
  readonly value: string;
  readonly repository: string;
  readonly transport: GenericGitTransport;
  readonly origin: GenericGitRemoteOrigin;
}

interface RefRecord {
  readonly objectSha: string;
  readonly name: string;
}

interface RefSelection {
  readonly commitSha: string;
  readonly objectSha: string;
  readonly remoteRef?: string;
  readonly requestedRef?: string;
}

interface CombinedDeadline {
  readonly signal: AbortSignal;
  remainingMilliseconds(): number;
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function invalidRemote(): GenericGitSnapshotError {
  return new GenericGitSnapshotError(
    "GIT_INVALID_REMOTE",
    "Generic Git remote must be a credential-free HTTPS, SSH, or scp-style repository.",
  );
}

function repositoryName(rawPath: string): string {
  const candidate = rawPath
    .replaceAll("\\", "/")
    .replace(/\/+$/u, "")
    .split("/")
    .at(-1);
  if (!candidate) throw invalidRemote();
  let decoded: string;
  try {
    decoded = decodeURIComponent(candidate);
  } catch {
    throw invalidRemote();
  }
  decoded = decoded.replace(/\.git$/iu, "").normalize("NFC");
  if (
    decoded.length === 0 ||
    decoded === "." ||
    decoded === ".." ||
    decoded.includes("/") ||
    decoded.includes("\\") ||
    INVALID_INPUT_CHARACTERS.test(decoded) ||
    utf8Length(decoded) > MAX_REPOSITORY_NAME_BYTES
  ) {
    throw invalidRemote();
  }
  return decoded;
}

function parseUrlRemote(value: string): ParsedRemote | undefined {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "ssh:") {
    throw invalidRemote();
  }
  if (
    parsed.hostname.length === 0 ||
    !/^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?|\[[0-9A-Fa-f:.]+\])$/u.test(
      parsed.hostname,
    ) ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0 ||
    value.includes("?") ||
    value.includes("#") ||
    value.includes("\\")
  ) {
    throw invalidRemote();
  }
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(parsed.pathname);
  } catch {
    throw invalidRemote();
  }
  if (
    decodedPath.includes("\\") ||
    INVALID_INPUT_CHARACTERS.test(decodedPath)
  ) {
    throw invalidRemote();
  }
  if (parsed.protocol === "https:" && parsed.username.length > 0) {
    throw invalidRemote();
  }
  if (
    parsed.protocol === "ssh:" &&
    (parsed.username.length > 0 &&
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(parsed.username))
  ) {
    throw invalidRemote();
  }
  if (parsed.pathname === "" || parsed.pathname === "/") {
    throw invalidRemote();
  }
  if (
    parsed.protocol === "ssh:" &&
    !/^\/[A-Za-z0-9._/-]+$/u.test(parsed.pathname)
  ) {
    throw invalidRemote();
  }
  const port = Number(
    parsed.port ||
      (parsed.protocol === "https:" ? "443" : "22"),
  );
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw invalidRemote();
  }
  return Object.freeze({
    value,
    repository: repositoryName(parsed.pathname),
    transport: parsed.protocol === "https:" ? "https" : "ssh",
    origin: Object.freeze({
      scheme: parsed.protocol === "https:" ? "https" : "ssh",
      hostname: parsed.hostname
        .replace(/^\[|\]$/gu, "")
        .toLocaleLowerCase("en-US"),
      port,
    }),
  });
}

function parseRemote(value: string): ParsedRemote {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_REMOTE_CODE_UNITS ||
    utf8Length(value) > MAX_REMOTE_BYTES ||
    value !== value.trim() ||
    value.startsWith("-") ||
    INVALID_INPUT_CHARACTERS.test(value)
  ) {
    throw invalidRemote();
  }
  const normalized = value.normalize("NFC");
  const url = parseUrlRemote(normalized);
  if (url !== undefined) return url;

  const scp = SCP_REMOTE.exec(normalized);
  if (scp === null || scp[0] !== normalized) throw invalidRemote();
  const remotePath = scp[3] ?? "";
  if (
    remotePath.length === 0 ||
    remotePath.startsWith("-") ||
    remotePath.includes("\\") ||
    remotePath.includes("?") ||
    remotePath.includes("#") ||
    /\s/u.test(remotePath) ||
    !/^[A-Za-z0-9._/-]+$/u.test(remotePath) ||
    INVALID_INPUT_CHARACTERS.test(remotePath)
  ) {
    throw invalidRemote();
  }
  return Object.freeze({
    value: normalized,
    repository: repositoryName(remotePath),
    transport: "ssh",
    origin: Object.freeze({
      scheme: "ssh",
      hostname: (scp[2] ?? "")
        .replace(/^\[|\]$/gu, "")
        .toLocaleLowerCase("en-US"),
      port: 22,
    }),
  });
}

function validateRef(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_REF_CODE_UNITS
  ) {
    throw new GenericGitSnapshotError(
      "GIT_INVALID_REF",
      `Generic Git ref must be valid and no larger than ${MAX_REF_BYTES} UTF-8 bytes.`,
    );
  }
  const normalized = value.normalize("NFC");
  const components = normalized.split("/");
  if (
    normalized.length === 0 ||
    utf8Length(normalized) > MAX_REF_BYTES ||
    INVALID_REF_CHARACTERS.test(normalized) ||
    normalized === "@" ||
    normalized.startsWith("-") ||
    normalized.includes("..") ||
    normalized.includes("@{") ||
    (normalized.startsWith("refs/") &&
      !normalized.startsWith("refs/heads/") &&
      !normalized.startsWith("refs/tags/")) ||
    components.some(
      (component) =>
        component.length === 0 ||
        component.startsWith(".") ||
        component.endsWith(".") ||
        component.toLocaleLowerCase("en-US").endsWith(".lock"),
    )
  ) {
    throw new GenericGitSnapshotError(
      "GIT_INVALID_REF",
      `Generic Git ref must be valid and no larger than ${MAX_REF_BYTES} UTF-8 bytes.`,
    );
  }
  return normalized;
}

/**
 * Validates and normalizes a credential-free Generic Git remote without
 * starting Git or touching the filesystem.
 */
export function validateGenericGitRepositoryUrl(value: string): string {
  return parseRemote(value).value;
}

/**
 * Returns the exact outbound origin of an already-valid Generic Git remote.
 * scp-style remotes are represented as SSH on port 22.
 */
export function genericGitRepositoryOrigin(
  value: string,
): GenericGitRemoteOrigin {
  return parseRemote(value).origin;
}

/**
 * Validates a Generic Git ref without contacting the remote.
 */
export function validateGenericGitRef(value: string): string {
  return validateRef(value);
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

function hardenedArguments(
  transport: GenericGitTransport,
  hooksPath: string,
  operation: readonly string[],
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
      }
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
        resolve({ exitCode: code ?? 1, stdout });
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

function decodeGitOutput(output: Uint8Array): string {
  if (output.byteLength > MAX_GIT_OUTPUT_BYTES) {
    throw new GenericGitSnapshotError(
      "GIT_OUTPUT_TOO_LARGE",
      "Installed Git output exceeded its size limit.",
    );
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(output);
  } catch {
    throw new GenericGitSnapshotError(
      "GIT_INVALID_RESPONSE",
      "Installed Git returned invalid reference data.",
    );
  }
}

function parseLsRemote(output: Uint8Array): {
  readonly symbolicHead?: string;
  readonly records: readonly RefRecord[];
} {
  const text = decodeGitOutput(output);
  const records: RefRecord[] = [];
  let symbolicHead: string | undefined;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.endsWith("\r")
      ? rawLine.slice(0, -1)
      : rawLine;
    if (line.length === 0) continue;
    const separator = line.indexOf("\t");
    if (separator <= 0 || separator === line.length - 1) {
      throw new GenericGitSnapshotError(
        "GIT_INVALID_RESPONSE",
        "Installed Git returned invalid reference data.",
      );
    }
    const left = line.slice(0, separator);
    const name = line.slice(separator + 1);
    if (left.startsWith("ref: ")) {
      const target = left.slice(5);
      if (
        name !== "HEAD" ||
        symbolicHead !== undefined ||
        !target.startsWith("refs/heads/")
      ) {
        throw new GenericGitSnapshotError(
          "GIT_INVALID_RESPONSE",
          "Installed Git returned invalid reference data.",
        );
      }
      try {
        validateRef(target);
      } catch {
        throw new GenericGitSnapshotError(
          "GIT_INVALID_RESPONSE",
          "Installed Git returned invalid reference data.",
        );
      }
      symbolicHead = target;
      continue;
    }
    const objectSha = left.toLocaleLowerCase("en-US");
    const peeled = name.endsWith("^{}");
    const baseName = peeled ? name.slice(0, -3) : name;
    if (
      !COMMIT_SHA.test(objectSha) ||
      name.length === 0 ||
      INVALID_INPUT_CHARACTERS.test(name) ||
      (name !== "HEAD" &&
        (!baseName.startsWith("refs/") ||
          (peeled && !baseName.startsWith("refs/tags/"))))
    ) {
      throw new GenericGitSnapshotError(
        "GIT_INVALID_RESPONSE",
        "Installed Git returned invalid reference data.",
      );
    }
    if (name !== "HEAD") {
      try {
        validateRef(baseName);
      } catch {
        throw new GenericGitSnapshotError(
          "GIT_INVALID_RESPONSE",
          "Installed Git returned invalid reference data.",
        );
      }
    }
    records.push(Object.freeze({ objectSha, name }));
  }
  return Object.freeze({
    ...(symbolicHead === undefined ? {} : { symbolicHead }),
    records: Object.freeze(records),
  });
}

function oneRecord(
  records: readonly RefRecord[],
  name: string,
): RefRecord | undefined {
  const matches = records.filter((record) => record.name === name);
  if (matches.length > 1) {
    throw new GenericGitSnapshotError(
      "GIT_INVALID_RESPONSE",
      "Installed Git returned duplicate reference data.",
    );
  }
  return matches[0];
}

function selectRef(
  requestedRef: string | undefined,
  output: Uint8Array,
): RefSelection {
  const parsed = parseLsRemote(output);
  if (requestedRef === undefined) {
    if (parsed.symbolicHead === undefined) {
      throw new GenericGitSnapshotError(
        "GIT_REF_UNAVAILABLE",
        "Generic Git default branch is unavailable.",
      );
    }
    const head = oneRecord(parsed.records, "HEAD");
    const branch = oneRecord(parsed.records, parsed.symbolicHead);
    const expectedNames = new Set(["HEAD", parsed.symbolicHead]);
    if (
      head === undefined ||
      parsed.records.some(
        (record) => !expectedNames.has(record.name),
      ) ||
      (branch !== undefined && head.objectSha !== branch.objectSha)
    ) {
      throw new GenericGitSnapshotError(
        "GIT_INVALID_RESPONSE",
        "Generic Git default branch could not be verified.",
      );
    }
    return Object.freeze({
      commitSha: head.objectSha,
      objectSha: head.objectSha,
      remoteRef: parsed.symbolicHead,
    });
  }

  if (COMMIT_SHA.test(requestedRef.toLocaleLowerCase("en-US"))) {
    const commitSha = requestedRef.toLocaleLowerCase("en-US");
    if (!parsed.records.some((record) => record.objectSha === commitSha)) {
      throw new GenericGitSnapshotError(
        "GIT_REF_UNAVAILABLE",
        "Requested Generic Git commit is not advertised.",
      );
    }
    return Object.freeze({
      commitSha,
      objectSha: commitSha,
      requestedRef,
    });
  }

  const qualifiedBranch = requestedRef.startsWith("refs/heads/");
  const qualifiedTag = requestedRef.startsWith("refs/tags/");
  const branchRef = qualifiedTag
    ? undefined
    : qualifiedBranch
      ? requestedRef
      : `refs/heads/${requestedRef}`;
  const tagRef = qualifiedBranch
    ? undefined
    : qualifiedTag
      ? requestedRef
      : `refs/tags/${requestedRef}`;
  const branch =
    branchRef === undefined
      ? undefined
      : oneRecord(parsed.records, branchRef);
  const tag =
    tagRef === undefined ? undefined : oneRecord(parsed.records, tagRef);
  const peeled =
    tagRef === undefined
      ? undefined
      : oneRecord(parsed.records, `${tagRef}^{}`);
  const expectedNames = new Set([
    ...(branchRef === undefined ? [] : [branchRef]),
    ...(tagRef === undefined ? [] : [tagRef, `${tagRef}^{}`]),
  ]);
  if (
    parsed.symbolicHead !== undefined ||
    parsed.records.some(
      (record) => !expectedNames.has(record.name),
    ) ||
    (peeled !== undefined && tag === undefined)
  ) {
    throw new GenericGitSnapshotError(
      "GIT_INVALID_RESPONSE",
      "Installed Git returned unexpected reference data.",
    );
  }
  if (
    !requestedRef.startsWith("refs/") &&
    branch !== undefined &&
    tag !== undefined
  ) {
    throw new GenericGitSnapshotError(
      "GIT_REF_AMBIGUOUS",
      "Requested Generic Git ref is ambiguous.",
    );
  }
  if (branch !== undefined) {
    return Object.freeze({
      commitSha: branch.objectSha,
      objectSha: branch.objectSha,
      remoteRef: branchRef!,
      requestedRef,
    });
  }
  if (tag !== undefined) {
    return Object.freeze({
      commitSha: peeled?.objectSha ?? tag.objectSha,
      objectSha: tag.objectSha,
      remoteRef: tagRef!,
      requestedRef,
    });
  }
  throw new GenericGitSnapshotError(
    "GIT_REF_UNAVAILABLE",
    "Requested Generic Git ref is unavailable.",
  );
}

function sameSelection(
  first: RefSelection,
  second: RefSelection,
): boolean {
  return (
    first.commitSha === second.commitSha &&
    first.objectSha === second.objectSha &&
    first.remoteRef === second.remoteRef
  );
}

function lsRemoteOperation(
  remote: ParsedRemote,
  requestedRef: string | undefined,
): readonly string[] {
  if (requestedRef === undefined) {
    return ["ls-remote", "--symref", remote.value, "HEAD"];
  }
  if (COMMIT_SHA.test(requestedRef.toLocaleLowerCase("en-US"))) {
    return ["ls-remote", remote.value];
  }
  const qualifiedBranch = requestedRef.startsWith("refs/heads/");
  const qualifiedTag = requestedRef.startsWith("refs/tags/");
  const branchRef = qualifiedTag
    ? undefined
    : qualifiedBranch
      ? requestedRef
      : `refs/heads/${requestedRef}`;
  const tagRef = qualifiedBranch
    ? undefined
    : qualifiedTag
      ? requestedRef
      : `refs/tags/${requestedRef}`;
  return [
    "ls-remote",
    remote.value,
    ...(branchRef === undefined ? [] : [branchRef]),
    ...(tagRef === undefined ? [] : [tagRef, `${tagRef}^{}`]),
  ];
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

async function invokeGit(
  runGit: GenericGitRunGit,
  executable: string,
  environment: Readonly<Record<string, string>>,
  workspace: GenericGitTemporaryWorkspace,
  remote: ParsedRemote,
  deadline: CombinedDeadline,
  operation: readonly string[],
  monitorDisk = false,
): Promise<Uint8Array> {
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
        ),
        cwd: workspace.root,
        env: environment,
        shell: false,
        windowsHide: true,
        timeoutMs: deadline.remainingMilliseconds(),
        maximumStdoutBytes: MAX_GIT_OUTPUT_BYTES,
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
    if (result.stdout.byteLength > MAX_GIT_OUTPUT_BYTES) {
      throw new GenericGitSnapshotError(
        "GIT_OUTPUT_TOO_LARGE",
        "Installed Git output exceeded its size limit.",
      );
    }
    if (!Number.isInteger(result.exitCode) || result.exitCode !== 0) {
      throw new GenericGitSnapshotError(
        "GIT_COMMAND_FAILED",
        "Installed Git operation failed safely.",
      );
    }
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

function materializationOptions(
  requested: SnapshotOptions | undefined,
  deadline: CombinedDeadline,
): SnapshotOptions {
  const remaining = deadline.remainingMilliseconds();
  const {
    signal: _callerSignal,
    timeoutMs: requestedTimeout,
    ...options
  } = requested ?? {};
  return {
    ...options,
    timeoutMs:
      requestedTimeout === undefined
        ? remaining
        : Math.min(requestedTimeout, remaining),
    signal: deadline.signal,
  };
}

async function readArchive(
  archivePath: string,
  deadline: CombinedDeadline,
): Promise<Uint8Array> {
  const stat = await withinDeadline(fs.lstat(archivePath), deadline);
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    stat.size < 0 ||
    stat.size > MAX_ARCHIVE_BYTES
  ) {
    throw new GenericGitSnapshotError(
      "GIT_ARCHIVE_TOO_LARGE",
      "Generic Git archive exceeded its size limit.",
    );
  }
  const bytes = await withinDeadline(fs.readFile(archivePath), deadline);
  if (bytes.byteLength > MAX_ARCHIVE_BYTES) {
    throw new GenericGitSnapshotError(
      "GIT_ARCHIVE_TOO_LARGE",
      "Generic Git archive exceeded its size limit.",
    );
  }
  return new Uint8Array(bytes);
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

function zipOptions(
  snapshotOptions: SnapshotOptions | undefined,
  signal: AbortSignal,
): ZipSnapshotSourceOptions {
  return {
    maxArchiveBytes: MAX_ARCHIVE_BYTES,
    maxEntries:
      snapshotOptions?.maxEntries ?? DEFAULT_SNAPSHOT_LIMITS.maxEntries,
    signal,
  };
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
          const firstOutput = await invokeGit(
            runGit,
            executable,
            environment,
            workspace,
            remote,
            deadline,
            lsRemoteOperation(remote, requestedRef),
          );
          const selection = selectRef(requestedRef, firstOutput);

          await invokeGit(
            runGit,
            executable,
            environment,
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
          await invokeGit(
            runGit,
            executable,
            environment,
            workspace,
            remote,
            deadline,
            [
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
            ],
            true,
          );
          await enforceTemporaryLimit(workspace, deadline);
          const verified = decodeGitOutput(
            await invokeGit(
              runGit,
              executable,
              environment,
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

          const secondSelection = selectRef(
            requestedRef,
            await invokeGit(
              runGit,
              executable,
              environment,
              workspace,
              remote,
              deadline,
              lsRemoteOperation(remote, requestedRef),
            ),
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
            environment,
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
          const archive = await readArchive(archivePath, deadline);

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
