import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CITY_MODEL_LIMITS,
} from "../../core/src/index.js";
import type {
  ExecutableUnitMetric,
  SourceMetrics,
} from "../../core/src/index.js";

export const ROSLYN_PROTOCOL_VERSION = "code-city.roslyn/1";

export const ROSLYN_HOST_LIMITS = Object.freeze({
  files: CITY_MODEL_LIMITS.buildings,
  idCharacters: CITY_MODEL_LIMITS.identifierCharacters,
  fileBytes: 2 * 1024 * 1024,
  requestBytes: 256 * 1024 * 1024,
  stdoutBytes: 64 * 1024 * 1024,
  stderrBytes: 64 * 1024,
  timeoutMs: 30_000,
  unitsPerFile: CITY_MODEL_LIMITS.metricUnitsPerBuilding,
});

export interface RoslynSourceInput {
  /** Opaque per-batch identifier. Repository paths never cross the process boundary. */
  readonly id: string;
  readonly source: string;
}

export interface RoslynHelperLaunch {
  /** Absolute path to the trusted, bundled helper executable. */
  readonly executable: string;
  /** Trusted packaging arguments. No value is interpreted by a shell. */
  readonly arguments?: readonly string[];
}

export interface RoslynHostOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maximumStdoutBytes?: number;
  readonly maximumStderrBytes?: number;
}

export interface RoslynFileFact {
  readonly id: string;
  readonly status: "ok";
  readonly metricMethod: "csharp-roslyn-v1";
  readonly metrics: SourceMetrics;
  readonly units: readonly ExecutableUnitMetric[];
  readonly warnings: readonly string[];
}

export interface RoslynSkippedFile {
  readonly id: string;
  readonly status: "skipped";
  readonly warning: "unit-limit" | "batch-unit-limit";
}

export type RoslynFileOutcome = RoslynFileFact | RoslynSkippedFile;

export class RoslynHostError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "RoslynHostError";
  }
}

const HELPER_FILE = "codecity-roslyn-helper.dll";

async function regularRealPath(candidate: string): Promise<string | undefined> {
  try {
    const resolved = await fs.realpath(candidate);
    const status = await fs.lstat(resolved);
    return status.isFile() && !status.isSymbolicLink() ? resolved : undefined;
  } catch {
    return undefined;
  }
}

async function bundledHelperFile(): Promise<string> {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const relativeOutput = path.join(
    "tools",
    "roslyn-helper",
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
    if (resolved) return resolved;
  }
  throw new RoslynHostError(
    "The bundled Roslyn helper is unavailable; run the trusted project build.",
  );
}

async function dotnetExecutable(): Promise<string> {
  const fileName = process.platform === "win32" ? "dotnet.exe" : "dotnet";
  const candidates: string[] = [];
  if (
    process.env["DOTNET_ROOT"] &&
    path.isAbsolute(process.env["DOTNET_ROOT"])
  ) {
    candidates.push(path.join(process.env["DOTNET_ROOT"], fileName));
  }
  for (const directory of (process.env["PATH"] ?? "").split(path.delimiter)) {
    if (directory && path.isAbsolute(directory)) {
      candidates.push(path.join(directory, fileName));
    }
  }
  for (const candidate of candidates) {
    const resolved = await regularRealPath(candidate);
    if (resolved) return resolved;
  }
  throw new RoslynHostError(
    "The pinned .NET runtime for the bundled Roslyn helper is unavailable.",
  );
}

/** Resolve only trusted installation files; repository bytes never influence launch. */
export async function resolveBundledRoslynLaunch(): Promise<RoslynHelperLaunch> {
  const [executable, helper] = await Promise.all([
    dotnetExecutable(),
    bundledHelperFile(),
  ]);
  return { executable, arguments: [helper] };
}

interface RawResponse {
  readonly protocolVersion?: unknown;
  readonly files?: unknown;
}

function positiveBoundedOption(
  value: number | undefined,
  hardMaximum: number,
  description: string,
): number {
  if (value === undefined) return hardMaximum;
  if (!Number.isSafeInteger(value) || value <= 0 || value > hardMaximum) {
    throw new TypeError(
      `${description} must be a positive integer no greater than ${hardMaximum}.`,
    );
  }
  return value;
}

function safeEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    DOTNET_CLI_TELEMETRY_OPTOUT: "1",
    DOTNET_NOLOGO: "1",
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1",
  };
  for (const name of [
    "DOTNET_ROOT",
    "DOTNET_ROOT(x86)",
    "SystemRoot",
    "WINDIR",
    "TEMP",
    "TMP",
  ]) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

async function validateLaunch(
  launch: RoslynHelperLaunch,
): Promise<string> {
  if (!path.isAbsolute(launch.executable) || launch.executable.includes("\0")) {
    throw new RoslynHostError(
      "The Roslyn helper must use a trusted absolute executable path.",
    );
  }
  if (
    launch.arguments?.some(
      (argument) => argument.includes("\0") || argument.length > 4_096,
    )
  ) {
    throw new RoslynHostError("The Roslyn helper launch is invalid.");
  }
  try {
    const status = await fs.lstat(launch.executable);
    if (!status.isFile() || status.isSymbolicLink()) throw new Error();
    return await fs.realpath(launch.executable);
  } catch {
    throw new RoslynHostError(
      "The bundled Roslyn helper executable is unavailable.",
    );
  }
}

function validateInputs(
  files: readonly RoslynSourceInput[],
): readonly RoslynSourceInput[] {
  if (files.length > ROSLYN_HOST_LIMITS.files) {
    throw new RoslynHostError(
      `Roslyn analysis accepts at most ${ROSLYN_HOST_LIMITS.files} files.`,
    );
  }
  const ids = new Set<string>();
  return files
    .map((file): RoslynSourceInput => {
      if (
        file.id.length > ROSLYN_HOST_LIMITS.idCharacters ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]*\.cs$/u.test(file.id)
      ) {
        throw new RoslynHostError(
          "Roslyn source identifiers must be opaque portable .cs identifiers.",
        );
      }
      const collisionKey = file.id.toLocaleLowerCase("en-US");
      if (ids.has(collisionKey)) {
        throw new RoslynHostError(
          "Roslyn source identifiers must be unique.",
        );
      }
      ids.add(collisionKey);
      if (
        Buffer.byteLength(file.source, "utf8") >
        ROSLYN_HOST_LIMITS.fileBytes
      ) {
        throw new RoslynHostError(
          `A Roslyn source exceeds the ${ROSLYN_HOST_LIMITS.fileBytes}-byte limit.`,
        );
      }
      return { id: file.id, source: file.source };
    })
    .sort((left, right) => left.id.localeCompare(right.id, "en-US"));
}

function requestBytes(files: readonly RoslynSourceInput[]): Buffer {
  const bytes = Buffer.from(
    JSON.stringify({
      protocolVersion: ROSLYN_PROTOCOL_VERSION,
      files,
    }),
    "utf8",
  );
  if (bytes.byteLength > ROSLYN_HOST_LIMITS.requestBytes) {
    throw new RoslynHostError(
      `Roslyn request exceeds the ${ROSLYN_HOST_LIMITS.requestBytes}-byte limit.`,
    );
  }
  return bytes;
}

function runHelper(
  executable: string,
  arguments_: readonly string[],
  request: Buffer,
  options: Required<
    Pick<
      RoslynHostOptions,
      "timeoutMs" | "maximumStdoutBytes" | "maximumStderrBytes"
    >
  > &
    Pick<RoslynHostOptions, "signal">,
): Promise<Buffer> {
  if (options.signal?.aborted) {
    throw new RoslynHostError("Roslyn analysis was cancelled.");
  }

  return new Promise<Buffer>((resolve, reject) => {
    let settled = false;
    let failure: string | undefined;
    let terminationFallback: NodeJS.Timeout | undefined;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdout: Buffer[] = [];
    const child = spawn(executable, [...arguments_], {
      cwd: path.dirname(executable),
      env: safeEnvironment(),
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const cleanup = (): void => {
      clearTimeout(timeout);
      if (terminationFallback) clearTimeout(terminationFallback);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const fail = (message: string): void => {
      if (settled || failure) return;
      failure = message;
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
      child.kill("SIGKILL");
      terminationFallback = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new RoslynHostError(message));
      }, 1_000);
      terminationFallback.unref();
    };
    const onAbort = (): void => fail("Roslyn analysis was cancelled.");
    const timeout = setTimeout(
      () => fail("Roslyn analysis exceeded its time limit."),
      options.timeoutMs,
    );
    timeout.unref();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();

    child.stdout.on("data", (chunk: Buffer) => {
      if (settled || failure) return;
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > options.maximumStdoutBytes) {
        fail("Roslyn helper output exceeded its byte limit.");
        return;
      }
      stdout.push(Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (settled || failure) return;
      stderrBytes += chunk.byteLength;
      if (stderrBytes > options.maximumStderrBytes) {
        fail("Roslyn helper diagnostics exceeded their byte limit.");
      }
    });
    child.on("error", () => {
      fail("The bundled Roslyn helper could not be started.");
    });
    child.on("close", (code) => {
      if (settled) return;
      if (failure) {
        settled = true;
        cleanup();
        reject(new RoslynHostError(failure));
        return;
      }
      if (code !== 0) {
        settled = true;
        cleanup();
        reject(new RoslynHostError("The bundled Roslyn helper failed."));
        return;
      }
      settled = true;
      cleanup();
      resolve(Buffer.concat(stdout, stdoutBytes));
    });
    child.stdin.on("error", () => {
      fail("The bundled Roslyn helper rejected its bounded request.");
    });
    child.stdin.end(request);
  });
}

function objectValue(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RoslynHostError("The Roslyn helper returned an invalid response.");
  }
  return value as Record<string, unknown>;
}

function integer(
  value: unknown,
  description: string,
  minimum: number,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new RoslynHostError(
      `The Roslyn helper returned an invalid ${description}.`,
    );
  }
  return value as number;
}

function safeText(value: unknown, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    /[\p{Cc}\p{Cf}\p{Cs}]/u.test(value) ||
    value !== value.normalize("NFC")
  ) {
    throw new RoslynHostError("The Roslyn helper returned unsafe text.");
  }
  return value;
}

function parseUnit(value: unknown): ExecutableUnitMetric {
  const unit = objectValue(value);
  return {
    name: safeText(unit.name, CITY_MODEL_LIMITS.displayTextCharacters),
    line: integer(unit.line, "unit line", 1),
    complexity: integer(unit.complexity, "unit complexity", 1),
  };
}

function parseOutcome(value: unknown): RoslynFileOutcome {
  const item = objectValue(value);
  const id = safeText(item.id, ROSLYN_HOST_LIMITS.idCharacters);
  if (item.status === "skipped") {
    if (item.warning !== "unit-limit" && item.warning !== "batch-unit-limit") {
      throw new RoslynHostError(
        "The Roslyn helper returned an invalid skip reason.",
      );
    }
    return { id, status: "skipped", warning: item.warning };
  }
  if (item.status !== "ok" || item.metricMethod !== "csharp-roslyn-v1") {
    throw new RoslynHostError("The Roslyn helper returned an invalid result.");
  }
  if (!Array.isArray(item.units) || !Array.isArray(item.warnings)) {
    throw new RoslynHostError("The Roslyn helper returned invalid metrics.");
  }
  if (item.units.length > ROSLYN_HOST_LIMITS.unitsPerFile) {
    throw new RoslynHostError("The Roslyn helper returned too many units.");
  }
  const units = item.units.map(parseUnit);
  const executableUnitCount = integer(
    item.executableUnitCount,
    "unit count",
    1,
  );
  const maximumComplexity = integer(
    item.maximumComplexity,
    "maximum complexity",
    1,
  );
  if (
    units.length !== executableUnitCount ||
    Math.max(...units.map(({ complexity }) => complexity)) !==
      maximumComplexity
  ) {
    throw new RoslynHostError(
      "The Roslyn helper returned inconsistent metrics.",
    );
  }
  const warnings = item.warnings.map((warning) =>
    safeText(warning, CITY_MODEL_LIMITS.warningCharacters),
  );
  return {
    id,
    status: "ok",
    metricMethod: "csharp-roslyn-v1",
    metrics: {
      sloc: integer(item.sloc, "SLOC", 0),
      decisionLoad: integer(item.decisionLoad, "decision load", 0),
      maximumComplexity,
      executableUnitCount,
    },
    units,
    warnings,
  };
}

function parseResponse(
  bytes: Buffer,
  expectedIds: ReadonlySet<string>,
): readonly RoslynFileOutcome[] {
  let parsed: RawResponse;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    parsed = objectValue(JSON.parse(text)) as RawResponse;
  } catch (error) {
    if (error instanceof RoslynHostError) throw error;
    throw new RoslynHostError("The Roslyn helper returned invalid JSON.");
  }
  if (
    parsed.protocolVersion !== ROSLYN_PROTOCOL_VERSION ||
    !Array.isArray(parsed.files) ||
    parsed.files.length !== expectedIds.size
  ) {
    throw new RoslynHostError(
      "The Roslyn helper returned an incompatible protocol response.",
    );
  }
  const outcomes = parsed.files.map(parseOutcome);
  const returnedIds = new Set(outcomes.map(({ id }) => id));
  if (
    returnedIds.size !== expectedIds.size ||
    [...returnedIds].some((item) => !expectedIds.has(item))
  ) {
    throw new RoslynHostError(
      "The Roslyn helper returned mismatched source identifiers.",
    );
  }
  return outcomes.sort((left, right) =>
    left.id.localeCompare(right.id, "en-US"),
  );
}

/**
 * Sends one immutable C# batch to the bundled syntax-only helper. This host
 * never invokes dotnet build/run, MSBuild, a shell, or repository code.
 */
export async function analyzeCSharpWithRoslyn(
  files: readonly RoslynSourceInput[],
  launch: RoslynHelperLaunch,
  options: RoslynHostOptions = {},
): Promise<readonly RoslynFileOutcome[]> {
  const normalized = validateInputs(files);
  const executable = await validateLaunch(launch);
  const bytes = await runHelper(
    executable,
    launch.arguments ?? [],
    requestBytes(normalized),
    {
      timeoutMs: positiveBoundedOption(
        options.timeoutMs,
        ROSLYN_HOST_LIMITS.timeoutMs,
        "Roslyn timeout",
      ),
      maximumStdoutBytes: positiveBoundedOption(
        options.maximumStdoutBytes,
        ROSLYN_HOST_LIMITS.stdoutBytes,
        "Roslyn stdout limit",
      ),
      maximumStderrBytes: positiveBoundedOption(
        options.maximumStderrBytes,
        ROSLYN_HOST_LIMITS.stderrBytes,
        "Roslyn stderr limit",
      ),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
  );
  return parseResponse(
    bytes,
    new Set(normalized.map(({ id }) => id)),
  );
}
