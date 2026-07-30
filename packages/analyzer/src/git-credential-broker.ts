import {
  spawn,
  type ChildProcess,
} from "node:child_process";
import { isUtf8 } from "node:buffer";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROTOCOL_MAGIC = Buffer.from("CCGITB1\n", "ascii");
const MAXIMUM_HOST_BYTES = 512;
const MAXIMUM_PATH_BYTES = 4 * 1024;
const MAXIMUM_USERNAME_BYTES = 256;
const MAXIMUM_SECRET_BYTES = 8 * 1024;
const MAXIMUM_READY_BYTES = 256;
const MAXIMUM_DIAGNOSTIC_BYTES = 64 * 1024;
const MAXIMUM_STARTUP_MS = 5_000;
const GRACEFUL_SHUTDOWN_MS = 1_000;
const FORCED_SHUTDOWN_MS = 1_000;
const PIPE_NAME = /^[A-Za-z0-9._-]{1,128}$/u;
const HELPER_FILE = "codecity-git-credential-helper.dll";

export interface GenericGitCredentialBrokerRequest {
  readonly host: string;
  readonly path: string;
  readonly username: string;
  readonly secret: Uint8Array;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}

export interface GenericGitCredentialBroker {
  /**
   * A complete `credential.helper` value. It contains trusted installation
   * paths and an opaque pipe name, never credential material.
   */
  readonly helperCommand: string;
  dispose(): Promise<void>;
}

export type GenericGitCredentialBrokerFactory = (
  request: GenericGitCredentialBrokerRequest,
) => Promise<GenericGitCredentialBroker>;

export interface GenericGitCredentialBrokerLaunch {
  /** Absolute path to the trusted dotnet executable. */
  readonly executable: string;
  /** Absolute path to the trusted bundled helper assembly. */
  readonly assembly: string;
}

export interface GenericGitCredentialBrokerDependencies {
  /** Test seam. Production callers must use the bundled launch. */
  readonly launch?: GenericGitCredentialBrokerLaunch;
}

export class GenericGitCredentialBrokerError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "GenericGitCredentialBrokerError";
  }
}

interface BrokerExit {
  readonly code: number | null;
  readonly closed: boolean;
}

function brokerFailure(): GenericGitCredentialBrokerError {
  return new GenericGitCredentialBrokerError(
    "The Generic Git credential broker failed safely.",
  );
}

async function regularRealPath(
  candidate: string,
): Promise<string | undefined> {
  try {
    const resolved = await fs.realpath(candidate);
    const status = await fs.lstat(resolved);
    return status.isFile() && !status.isSymbolicLink()
      ? resolved
      : undefined;
  } catch {
    return undefined;
  }
}

async function bundledHelperFile(): Promise<string> {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const relativeOutput = path.join(
    "tools",
    "git-credential-helper",
    "bin",
    "Release",
    "net10.0",
    HELPER_FILE,
  );
  for (const candidate of [
    path.resolve(moduleDirectory, "../../../", relativeOutput),
    path.resolve(moduleDirectory, "../../../../../", relativeOutput),
  ]) {
    const resolved = await regularRealPath(candidate);
    if (resolved !== undefined) return resolved;
  }
  throw brokerFailure();
}

async function dotnetExecutable(): Promise<string> {
  const fileName = process.platform === "win32" ? "dotnet.exe" : "dotnet";
  const candidates: string[] = [];
  const root = process.env["DOTNET_ROOT"];
  if (root !== undefined && path.isAbsolute(root)) {
    candidates.push(path.join(root, fileName));
  }
  for (const directory of (process.env["PATH"] ?? "").split(path.delimiter)) {
    if (directory.length > 0 && path.isAbsolute(directory)) {
      candidates.push(path.join(directory, fileName));
    }
  }
  for (const candidate of candidates) {
    const resolved = await regularRealPath(candidate);
    if (resolved !== undefined) return resolved;
  }
  throw brokerFailure();
}

export async function resolveBundledGitCredentialBrokerLaunch(): Promise<GenericGitCredentialBrokerLaunch> {
  const [executable, assembly] = await Promise.all([
    dotnetExecutable(),
    bundledHelperFile(),
  ]);
  return Object.freeze({ executable, assembly });
}

async function validateLaunch(
  requested: GenericGitCredentialBrokerLaunch,
): Promise<GenericGitCredentialBrokerLaunch> {
  if (
    !path.isAbsolute(requested.executable) ||
    !path.isAbsolute(requested.assembly) ||
    requested.executable.includes("\0") ||
    requested.assembly.includes("\0") ||
    requested.executable.length > 4_096 ||
    requested.assembly.length > 4_096
  ) {
    throw brokerFailure();
  }
  const [executable, assembly] = await Promise.all([
    regularRealPath(requested.executable),
    regularRealPath(requested.assembly),
  ]);
  if (executable === undefined || assembly === undefined) {
    throw brokerFailure();
  }
  return Object.freeze({ executable, assembly });
}

function brokerEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    DOTNET_CLI_TELEMETRY_OPTOUT: "1",
    DOTNET_NOLOGO: "1",
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1",
  };
  for (const name of [
    "DOTNET_ROOT",
    "DOTNET_ROOT(x86)",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "TEMP",
    "TMP",
    "TMPDIR",
  ]) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

function validatedTextBytes(
  value: string,
  maximumBytes: number,
): number {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0")
  ) {
    throw brokerFailure();
  }
  const length = Buffer.byteLength(value, "utf8");
  if (length === 0 || length > maximumBytes) throw brokerFailure();
  return length;
}

function isFormatCodePoint(value: number): boolean {
  return (
    value === 0x00ad ||
    (value >= 0x0600 && value <= 0x0605) ||
    value === 0x061c ||
    value === 0x06dd ||
    value === 0x070f ||
    (value >= 0x0890 && value <= 0x0891) ||
    value === 0x08e2 ||
    (value >= 0x17b4 && value <= 0x17b5) ||
    value === 0x180e ||
    (value >= 0x200b && value <= 0x200f) ||
    (value >= 0x202a && value <= 0x202e) ||
    (value >= 0x2060 && value <= 0x2064) ||
    (value >= 0x2066 && value <= 0x206f) ||
    value === 0xfeff ||
    (value >= 0xfff9 && value <= 0xfffb) ||
    value === 0x110bd ||
    value === 0x110cd ||
    (value >= 0x13430 && value <= 0x13455) ||
    (value >= 0x1bca0 && value <= 0x1bca3) ||
    (value >= 0x1d173 && value <= 0x1d17a) ||
    value === 0xe0001 ||
    (value >= 0xe0020 && value <= 0xe007f)
  );
}

function safeUtf8Line(bytes: Uint8Array): boolean {
  if (bytes.byteLength === 0 || !isUtf8(bytes)) return false;
  for (let index = 0; index < bytes.byteLength;) {
    const first = bytes[index]!;
    let value: number;
    let width: number;
    if (first < 0x80) {
      value = first;
      width = 1;
    } else if (first < 0xe0) {
      value =
        ((first & 0x1f) << 6) |
        (bytes[index + 1]! & 0x3f);
      width = 2;
    } else if (first < 0xf0) {
      value =
        ((first & 0x0f) << 12) |
        ((bytes[index + 1]! & 0x3f) << 6) |
        (bytes[index + 2]! & 0x3f);
      width = 3;
    } else {
      value =
        ((first & 0x07) << 18) |
        ((bytes[index + 1]! & 0x3f) << 12) |
        ((bytes[index + 2]! & 0x3f) << 6) |
        (bytes[index + 3]! & 0x3f);
      width = 4;
    }
    if (
      value <= 0x001f ||
      (value >= 0x007f && value <= 0x009f) ||
      (value >= 0xd800 && value <= 0xdfff) ||
      value === 0x2028 ||
      value === 0x2029 ||
      isFormatCodePoint(value)
    ) {
      return false;
    }
    index += width;
  }
  return true;
}

export function isSafeGenericGitCredentialLine(
  bytes: Uint8Array,
): boolean {
  return bytes instanceof Uint8Array && safeUtf8Line(bytes);
}

function validHostAuthority(value: string): boolean {
  if (
    !/^[\u0021-\u007e]+$/u.test(value) ||
    /[/?#\\@]/u.test(value)
  ) {
    return false;
  }
  try {
    const parsed = new URL(`https://${value}/`);
    return (
      parsed.username.length === 0 &&
      parsed.password.length === 0 &&
      parsed.host === value
    );
  } catch {
    return false;
  }
}

function validateRequest(
  request: GenericGitCredentialBrokerRequest,
): readonly [number, number, number, number] {
  if (
    !Number.isSafeInteger(request.timeoutMs) ||
    request.timeoutMs <= 0 ||
    request.timeoutMs > 0x7fff_ffff ||
    !(request.signal instanceof AbortSignal) ||
    !(request.secret instanceof Uint8Array) ||
    request.secret.byteLength === 0 ||
    request.secret.byteLength > MAXIMUM_SECRET_BYTES ||
    !safeUtf8Line(request.secret) ||
    !/^[\u0020-\u007e]+$/u.test(request.username) ||
    request.username.includes(":") ||
    request.username !== request.username.trim() ||
    request.path.startsWith("/") ||
    !validHostAuthority(request.host) ||
    request.host !== request.host.trim() ||
    !safeUtf8Line(Buffer.from(request.path, "utf8"))
  ) {
    throw brokerFailure();
  }
  return Object.freeze([
    validatedTextBytes(request.host, MAXIMUM_HOST_BYTES),
    validatedTextBytes(request.path, MAXIMUM_PATH_BYTES),
    validatedTextBytes(request.username, MAXIMUM_USERNAME_BYTES),
    request.secret.byteLength,
  ]);
}

function initFrame(
  request: GenericGitCredentialBrokerRequest,
): Buffer {
  const lengths = validateRequest(request);
  const total =
    PROTOCOL_MAGIC.byteLength +
    4 +
    lengths.reduce((sum, length) => sum + 4 + length, 0);
  const frame = Buffer.alloc(total);
  let offset = 0;
  PROTOCOL_MAGIC.copy(frame, offset);
  offset += PROTOCOL_MAGIC.byteLength;
  frame.writeUInt32BE(request.timeoutMs, offset);
  offset += 4;
  for (const [index, value] of [
    request.host,
    request.path,
    request.username,
  ].entries()) {
    const length = lengths[index];
    if (length === undefined) {
      frame.fill(0);
      throw brokerFailure();
    }
    frame.writeUInt32BE(length, offset);
    offset += 4;
    offset += frame.write(value, offset, length, "utf8");
  }
  frame.writeUInt32BE(request.secret.byteLength, offset);
  offset += 4;
  frame.set(request.secret, offset);
  return frame;
}

/**
 * Quote one trusted argument for the POSIX shell used by Git's `!` credential
 * helper form. Git itself appends the credential operation after this command.
 */
export function quoteGitCredentialHelperArgument(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4_096 ||
    value.includes("\0")
  ) {
    throw brokerFailure();
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function gitCredentialHelperCommand(
  launch: GenericGitCredentialBrokerLaunch,
  pipeName: string,
): string {
  if (!PIPE_NAME.test(pipeName)) throw brokerFailure();
  return [
    `!${quoteGitCredentialHelperArgument(launch.executable)}`,
    quoteGitCredentialHelperArgument(launch.assembly),
    "helper",
    quoteGitCredentialHelperArgument(pipeName),
  ].join(" ");
}

function terminateProcessTree(child: ChildProcess): void {
  const processId = child.pid;
  if (processId === undefined) return;
  try {
    if (process.platform === "win32") {
      child.kill("SIGKILL");
    } else {
      process.kill(-processId, "SIGKILL");
    }
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // The broker already exited.
    }
  }
}

function wait(
  milliseconds: number,
): Promise<"timeout"> {
  return new Promise((resolve) => {
    const timer = globalThis.setTimeout(
      () => resolve("timeout"),
      milliseconds,
    );
    timer.unref?.();
  });
}

async function stopBroker(
  child: ChildProcess,
  exit: Promise<BrokerExit>,
): Promise<BrokerExit> {
  try {
    child.stdin?.end();
  } catch {
    // Continue to the bounded process-tree termination.
  }
  const graceful = await Promise.race([
    exit,
    wait(GRACEFUL_SHUTDOWN_MS),
  ]);
  if (graceful !== "timeout") return graceful;
  terminateProcessTree(child);
  const forced = await Promise.race([
    exit,
    wait(FORCED_SHUTDOWN_MS),
  ]);
  return forced === "timeout"
    ? { code: null, closed: false }
    : forced;
}

function waitForReadiness(
  child: ChildProcess,
  frame: Buffer,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let readyPipe: string | undefined;
    let writeFinished = false;
    let stdout = Buffer.alloc(0);
    let diagnosticBytes = 0;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      child.removeListener("error", error);
      child.removeListener("close", close);
      child.stdout?.removeListener("data", data);
      child.stderr?.removeListener("data", diagnostic);
      frame.fill(0);
      callback();
    };
    const fail = (): void => finish(() => reject(brokerFailure()));
    const complete = (): void => {
      if (readyPipe !== undefined && writeFinished) {
        const pipe = readyPipe;
        finish(() => resolve(pipe));
      }
    };
    const abort = (): void => fail();
    const error = (): void => fail();
    const close = (): void => fail();
    const diagnostic = (chunk: Buffer): void => {
      diagnosticBytes += chunk.byteLength;
      if (diagnosticBytes > MAXIMUM_DIAGNOSTIC_BYTES) fail();
    };
    const data = (chunk: Buffer): void => {
      if (stdout.byteLength + chunk.byteLength > MAXIMUM_READY_BYTES) {
        fail();
        return;
      }
      stdout = Buffer.concat([stdout, chunk]);
      const newline = stdout.indexOf(0x0a);
      if (newline < 0) return;
      if (newline !== stdout.byteLength - 1) {
        fail();
        return;
      }
      const line = stdout.toString("ascii", 0, newline);
      const match = /^CCGITB1 ([A-Za-z0-9._-]{1,128})$/u.exec(line);
      if (match === null || match[1] === undefined) {
        fail();
        return;
      }
      readyPipe = match[1];
      complete();
    };
    const timer = globalThis.setTimeout(
      fail,
      Math.min(timeoutMs, MAXIMUM_STARTUP_MS),
    );
    timer.unref?.();
    signal.addEventListener("abort", abort, { once: true });
    child.once("error", error);
    child.once("close", close);
    child.stdout?.on("data", data);
    child.stderr?.on("data", diagnostic);
    if (
      signal.aborted ||
      child.stdin === null ||
      child.stdout === null ||
      child.stderr === null
    ) {
      fail();
      return;
    }
    child.stdin.write(frame, (writeError) => {
      frame.fill(0);
      if (writeError !== null && writeError !== undefined) {
        fail();
        return;
      }
      writeFinished = true;
      complete();
    });
  });
}

class SpawnedCredentialBroker implements GenericGitCredentialBroker {
  readonly #child: ChildProcess;
  readonly #exit: Promise<BrokerExit>;
  readonly #signal: AbortSignal;
  readonly #abort: () => void;
  #disposePromise: Promise<void> | undefined;

  public constructor(
    readonly helperCommand: string,
    child: ChildProcess,
    exit: Promise<BrokerExit>,
    signal: AbortSignal,
  ) {
    this.#child = child;
    this.#exit = exit;
    this.#signal = signal;
    this.#abort = () => terminateProcessTree(child);
    signal.addEventListener("abort", this.#abort, { once: true });
    child.stdout?.resume();
    child.stderr?.resume();
    child.on("error", () => undefined);
    if (signal.aborted) this.#abort();
  }

  public dispose(): Promise<void> {
    this.#disposePromise ??= this.#dispose();
    return this.#disposePromise;
  }

  async #dispose(): Promise<void> {
    try {
      const result = await stopBroker(this.#child, this.#exit);
      if (
        !result.closed ||
        (!this.#signal.aborted &&
          result.code !== 0)
      ) {
        throw brokerFailure();
      }
    } finally {
      this.#signal.removeEventListener("abort", this.#abort);
    }
  }
}

/**
 * Starts the trusted one-shot .NET broker. Credential material crosses only
 * its bounded binary stdin initialization frame and is zeroed after the write.
 */
export async function createGenericGitCredentialBroker(
  request: GenericGitCredentialBrokerRequest,
  dependencies: GenericGitCredentialBrokerDependencies = {},
): Promise<GenericGitCredentialBroker> {
  let frame: Buffer | undefined;
  let child: ChildProcess | undefined;
  let exit: Promise<BrokerExit> | undefined;
  try {
    frame = initFrame(request);
    if (request.signal.aborted) throw brokerFailure();
    const launch = await validateLaunch(
      dependencies.launch ??
        (await resolveBundledGitCredentialBrokerLaunch()),
    );
    if (request.signal.aborted) throw brokerFailure();
    child = spawn(
      launch.executable,
      [launch.assembly, "broker"],
      {
        cwd: path.dirname(launch.assembly),
        env: brokerEnvironment(),
        shell: false,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    exit = new Promise<BrokerExit>((resolve) => {
      child?.once("close", (code) =>
        resolve({ code, closed: true }),
      );
      child?.once("error", () =>
        resolve({ code: null, closed: true }),
      );
    });
    const pipeName = await waitForReadiness(
      child,
      frame,
      request.signal,
      request.timeoutMs,
    );
    frame = undefined;
    return new SpawnedCredentialBroker(
      gitCredentialHelperCommand(launch, pipeName),
      child,
      exit,
      request.signal,
    );
  } catch {
    frame?.fill(0);
    if (child !== undefined && exit !== undefined) {
      await stopBroker(child, exit);
    }
    throw brokerFailure();
  }
}
