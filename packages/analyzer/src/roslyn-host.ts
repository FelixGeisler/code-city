import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CITY_MODEL_LIMITS,
} from "../../core/src/index.js";
import type {
  ComplexityDecisionKind,
  ComplexityDecisionSite,
  ExecutableUnitMetric,
  ExecutableUnitDecisionEvidence,
  SourceRange,
  SourceStructure,
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
  decisionSitesPerFile: CITY_MODEL_LIMITS.decisionSitesPerBuilding,
  decisionSitesPerBatch: CITY_MODEL_LIMITS.decisionSitesPerModel,
});

const COMPLEXITY_DECISION_KINDS = new Set<ComplexityDecisionKind>([
  "conditional-branch",
  "loop",
  "switch-arm",
  "catch",
  "conditional-expression",
  "short-circuit-operator",
  "nullish-operator",
  "guard",
  "pattern-operator",
]);

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
  readonly sourceStructure: SourceStructure;
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

function parseExactRange(value: unknown): SourceRange {
  const item = objectValue(value);
  const parsed = {
    startLine: integer(item.startLine, "source range start line", 1),
    startColumn: integer(item.startColumn, "source range start column", 1),
    endLine: integer(item.endLine, "source range end line", 1),
    endColumn: integer(item.endColumn, "source range end column", 1),
  };
  if (
    parsed.endLine < parsed.startLine ||
    (parsed.endLine === parsed.startLine &&
      parsed.endColumn < parsed.startColumn)
  ) {
    throw new RoslynHostError("The Roslyn helper returned an invalid source range.");
  }
  return parsed;
}

function rangeEndsBefore(left: SourceRange, right: SourceRange): boolean {
  return left.endLine < right.startLine ||
    (left.endLine === right.startLine && left.endColumn < right.startColumn);
}

function rangeContains(outer: SourceRange, inner: SourceRange): boolean {
  const startsInside = inner.startLine > outer.startLine ||
    (inner.startLine === outer.startLine && inner.startColumn >= outer.startColumn);
  const endsInside = inner.endLine < outer.endLine ||
    (inner.endLine === outer.endLine && inner.endColumn <= outer.endColumn);
  return startsInside && endsInside;
}

function parseDecisionEvidence(
  value: unknown,
  complexity: number,
  line: number,
  endLine: number,
): ExecutableUnitDecisionEvidence {
  const evidence = objectValue(value);
  if (evidence.version !== "codecity.complexity-evidence/1") {
    throw new RoslynHostError("The Roslyn helper returned incompatible decision evidence.");
  }
  const unitId = safeText(evidence.unitId, CITY_MODEL_LIMITS.identifierCharacters);
  const scope = evidence.scope;
  if (scope !== "top-level" && scope !== "callable") {
    throw new RoslynHostError("The Roslyn helper returned invalid decision evidence.");
  }
  const callableId = evidence.callableId === undefined
    ? undefined
    : safeText(evidence.callableId, CITY_MODEL_LIMITS.identifierCharacters);
  if (scope === "top-level" && callableId !== undefined) {
    throw new RoslynHostError("The Roslyn helper returned invalid top-level decision evidence.");
  }
  if (!Array.isArray(evidence.sites) ||
    evidence.sites.length > CITY_MODEL_LIMITS.decisionSitesPerUnit) {
    throw new RoslynHostError("The Roslyn helper returned oversized decision evidence.");
  }
  const sites: ComplexityDecisionSite[] = [];
  let retainedContribution = 0;
  for (const value_ of evidence.sites) {
    const item = objectValue(value_);
    if (!COMPLEXITY_DECISION_KINDS.has(item.kind as ComplexityDecisionKind)) {
      throw new RoslynHostError("The Roslyn helper returned an invalid decision kind.");
    }
    const range = parseExactRange(item.range);
    if (range.startLine < line || range.endLine > endLine ||
      (sites.length > 0 && !rangeEndsBefore(sites.at(-1)!.range, range))) {
      throw new RoslynHostError("The Roslyn helper returned unordered decision evidence.");
    }
    const contribution = integer(item.contribution, "decision contribution", 1);
    if (retainedContribution > Number.MAX_SAFE_INTEGER - contribution) {
      throw new RoslynHostError("The Roslyn helper returned excessive decision contributions.");
    }
    retainedContribution += contribution;
    sites.push({
      kind: item.kind as ComplexityDecisionKind,
      range,
      contribution,
    });
  }
  const status = evidence.status;
  let parsed: ExecutableUnitDecisionEvidence;
  if (status === "unavailable") {
    if (sites.length !== 0 || evidence.totalContribution !== undefined ||
      evidence.omittedContribution !== undefined) {
      throw new RoslynHostError("The Roslyn helper fabricated unavailable decision evidence.");
    }
    parsed = {
      version: "codecity.complexity-evidence/1",
      unitId,
      scope,
      ...(callableId === undefined ? {} : { callableId }),
      status,
      sites: [],
      reason: safeText(evidence.reason, CITY_MODEL_LIMITS.warningCharacters),
    };
  } else if (status === "complete" || status === "truncated") {
    const totalContribution = integer(
      evidence.totalContribution,
      "decision contribution total",
      0,
    );
    const omittedContribution = integer(
      evidence.omittedContribution,
      "omitted decision contribution",
      0,
    );
    if (totalContribution !== complexity - 1 ||
      retainedContribution + omittedContribution !== totalContribution) {
      throw new RoslynHostError("The Roslyn helper returned inconsistent decision evidence.");
    }
    if (status === "complete") {
      if (omittedContribution !== 0 || evidence.reason !== undefined) {
        throw new RoslynHostError("The Roslyn helper returned invalid complete decision evidence.");
      }
      parsed = {
        version: "codecity.complexity-evidence/1",
        unitId,
        scope,
        ...(callableId === undefined ? {} : { callableId }),
        status,
        totalContribution,
        omittedContribution: 0,
        sites,
      };
    } else {
      if (omittedContribution === 0) {
        throw new RoslynHostError("The Roslyn helper returned invalid truncated decision evidence.");
      }
      parsed = {
        version: "codecity.complexity-evidence/1",
        unitId,
        scope,
        ...(callableId === undefined ? {} : { callableId }),
        status,
        totalContribution,
        omittedContribution,
        reason: safeText(evidence.reason, CITY_MODEL_LIMITS.warningCharacters),
        sites,
      };
    }
  } else {
    throw new RoslynHostError("The Roslyn helper returned invalid decision evidence status.");
  }
  if (Buffer.byteLength(JSON.stringify(parsed), "utf8") >
    CITY_MODEL_LIMITS.decisionEvidenceBytesPerUnit) {
    throw new RoslynHostError("The Roslyn helper returned oversized serialized decision evidence.");
  }
  return parsed;
}

function parseUnit(value: unknown): ExecutableUnitMetric {
  const unit = objectValue(value);
  const line = integer(unit.line, "unit line", 1);
  const endLine = unit.endLine === undefined
    ? line
    : integer(unit.endLine, "unit end line", 1);
  const complexity = integer(unit.complexity, "unit complexity", 1);
  const decisionEvidence = unit.decisionEvidence === undefined
    ? undefined
    : parseDecisionEvidence(unit.decisionEvidence, complexity, line, endLine);
  if (decisionEvidence?.scope === "top-level" &&
    (unit.name !== "<top-level>" || line !== 1)) {
    throw new RoslynHostError("The Roslyn helper returned an invalid top-level unit.");
  }
  return {
    name: safeText(unit.name, CITY_MODEL_LIMITS.displayTextCharacters),
    line,
    ...(unit.endLine === undefined ? {} : { endLine }),
    complexity,
    ...(decisionEvidence === undefined ? {} : { decisionEvidence }),
  };
}

function parseSourceStructure(value: unknown): SourceStructure {
  const structure = objectValue(value);
  if (structure.version !== "codecity.source-structure/1" ||
    (structure.availability !== "available" && structure.availability !== "unavailable") ||
    !Array.isArray(structure.types) || !Array.isArray(structure.callables) ||
    !Array.isArray(structure.relations) || !Array.isArray(structure.unavailable)) {
    throw new RoslynHostError("The Roslyn helper returned invalid source structure.");
  }
  if (
    structure.types.length > CITY_MODEL_LIMITS.sourceTypesPerBuilding ||
    structure.callables.length > CITY_MODEL_LIMITS.sourceCallablesPerBuilding ||
    structure.relations.length > CITY_MODEL_LIMITS.sourceRelationsPerBuilding ||
    structure.unavailable.length > CITY_MODEL_LIMITS.warnings
  ) {
    throw new RoslynHostError("The Roslyn helper returned oversized source structure.");
  }
  const typeKinds = new Set(["class", "interface", "enum", "type", "struct", "record", "delegate"]);
  const callableKinds = new Set(["function", "method", "constructor", "accessor", "lambda", "local-function"]);
  const ids = new Set<string>();
  const typeIds = new Set<string>();
  const callableIds = new Set<string>();
  const relationIds = new Set<string>();
  const types = structure.types.map((value_) => {
    const item = objectValue(value_); const id = safeText(item.id, CITY_MODEL_LIMITS.identifierCharacters);
    if (!typeKinds.has(item.kind as string) || item.provenance !== "syntax" || ids.has(id)) throw new RoslynHostError("The Roslyn helper returned invalid source structure."); ids.add(id); typeIds.add(id);
    return { id, name: safeText(item.name, CITY_MODEL_LIMITS.displayTextCharacters), kind: item.kind as SourceStructure["types"][number]["kind"], range: parseExactRange(item.range), provenance: "syntax" as const, ...(item.parentTypeId === undefined ? {} : { parentTypeId: safeText(item.parentTypeId, CITY_MODEL_LIMITS.identifierCharacters) }) };
  });
  const callables = structure.callables.map((value_) => {
    const item = objectValue(value_); const id = safeText(item.id, CITY_MODEL_LIMITS.identifierCharacters);
    if (!callableKinds.has(item.kind as string) || item.provenance !== "syntax" || ids.has(id)) throw new RoslynHostError("The Roslyn helper returned invalid source structure."); ids.add(id); callableIds.add(id);
    return { id, name: safeText(item.name, CITY_MODEL_LIMITS.displayTextCharacters), kind: item.kind as SourceStructure["callables"][number]["kind"], range: parseExactRange(item.range), provenance: "syntax" as const, ...(item.enclosingTypeId === undefined ? {} : { enclosingTypeId: safeText(item.enclosingTypeId, CITY_MODEL_LIMITS.identifierCharacters) }), complexity: integer(item.complexity, "source callable complexity", 1) };
  });
  for (const type of types) if (type.parentTypeId !== undefined && !typeIds.has(type.parentTypeId)) throw new RoslynHostError("The Roslyn helper returned unresolved source structure reference.");
  for (const callable of callables) if (callable.enclosingTypeId !== undefined && !typeIds.has(callable.enclosingTypeId)) throw new RoslynHostError("The Roslyn helper returned unresolved source structure reference.");
  const parentByType = new Map(types.flatMap((item) => item.parentTypeId === undefined ? [] : [[item.id, item.parentTypeId] as const]));
  const ancestryState = new Map<string, 1 | 2>();
  for (const type of types) {
    if (ancestryState.get(type.id) === 2) continue;
    const pending: string[] = [];
    let current: string | undefined = type.id;
    while (current !== undefined && ancestryState.get(current) !== 2) {
      if (ancestryState.get(current) === 1) {
        throw new RoslynHostError("The Roslyn helper returned cyclic source type nesting.");
      }
      ancestryState.set(current, 1);
      pending.push(current);
      current = parentByType.get(current);
    }
    for (const visited of pending) ancestryState.set(visited, 2);
  }
  const relationKinds = new Set(["extends", "implements", "calls", "type-reference"]);
  const relations = structure.relations.map((value_) => {
    const item = objectValue(value_);
    const id = safeText(item.id, CITY_MODEL_LIMITS.identifierCharacters);
    const kind = item.kind;
    const sourceId = safeText(item.sourceId, CITY_MODEL_LIMITS.identifierCharacters);
    const targetId = safeText(item.targetId, CITY_MODEL_LIMITS.identifierCharacters);
    if (!relationKinds.has(kind as string) || item.provenance !== "syntax" || relationIds.has(id) || !ids.has(sourceId) || !ids.has(targetId)) throw new RoslynHostError("The Roslyn helper returned invalid source relation.");
    relationIds.add(id);
    if ((kind === "extends" || kind === "implements") && (!typeIds.has(sourceId) || !typeIds.has(targetId))) throw new RoslynHostError("The Roslyn helper returned invalid source relation.");
    if (kind === "calls" && (!callableIds.has(sourceId) || !callableIds.has(targetId))) throw new RoslynHostError("The Roslyn helper returned invalid source relation.");
    if (kind === "type-reference" && !typeIds.has(targetId)) throw new RoslynHostError("The Roslyn helper returned invalid source relation.");
    return { id, kind: kind as SourceStructure["relations"][number]["kind"], sourceId, targetId, provenance: "syntax" as const };
  });
  const unavailable = structure.unavailable.map((item) => safeText(item, CITY_MODEL_LIMITS.warningCharacters));
  if (structure.availability === "unavailable" && (types.length !== 0 || callables.length !== 0 || relations.length !== 0 || unavailable.length === 0)) throw new RoslynHostError("The Roslyn helper returned invalid unavailable source structure.");
  return { version: "codecity.source-structure/1", availability: structure.availability, types, callables, relations, unavailable };
}

function validateUnitEvidenceLinks(
  units: readonly ExecutableUnitMetric[],
  sourceStructure: SourceStructure,
  validateCallableLinks = true,
): void {
  const unitIds = new Set<string>();
  const linkedCallableIds = new Set<string>();
  const callables = new Map(
    sourceStructure.callables.map((callable) => [callable.id, callable]),
  );
  let topLevelCount = 0;
  let siteCount = 0;
  let serializedBytes = 0;
  for (const unit of units) {
    const evidence = unit.decisionEvidence;
    if (evidence === undefined) continue;
    if (unitIds.has(evidence.unitId)) {
      throw new RoslynHostError("The Roslyn helper returned duplicate unit identities.");
    }
    unitIds.add(evidence.unitId);
    siteCount += evidence.sites.length;
    serializedBytes += Buffer.byteLength(JSON.stringify(evidence), "utf8");
    if (evidence.scope === "top-level") {
      topLevelCount += 1;
      if (topLevelCount > 1 || unit.name !== "<top-level>" || unit.line !== 1) {
        throw new RoslynHostError("The Roslyn helper returned invalid top-level evidence.");
      }
      continue;
    }
    if (!validateCallableLinks) continue;
    if (sourceStructure.availability === "available" &&
      evidence.callableId === undefined) {
      throw new RoslynHostError("The Roslyn helper omitted a callable evidence link.");
    }
    if (evidence.callableId === undefined ||
      sourceStructure.availability !== "available") continue;
    if (linkedCallableIds.has(evidence.callableId)) {
      throw new RoslynHostError("The Roslyn helper reused a callable evidence link.");
    }
    linkedCallableIds.add(evidence.callableId);
    const callable = callables.get(evidence.callableId);
    if (callable === undefined || callable.name !== unit.name ||
      callable.complexity !== unit.complexity ||
      callable.range.startLine !== unit.line ||
      callable.range.endLine !== (unit.endLine ?? unit.line) ||
      evidence.sites.some((site) => !rangeContains(callable.range, site.range))) {
      throw new RoslynHostError("The Roslyn helper returned inconsistent callable evidence.");
    }
  }
  if (siteCount > ROSLYN_HOST_LIMITS.decisionSitesPerFile ||
    serializedBytes > CITY_MODEL_LIMITS.decisionEvidenceBytesPerBuilding) {
    throw new RoslynHostError("The Roslyn helper returned oversized file decision evidence.");
  }
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
  // Protocol-1 helpers from already-installed analyzer bundles did not carry
  // declaration facts. Preserve their metrics and surface the exact absence
  // instead of fabricating types, methods, or relationships.
  const sourceStructure = item.sourceStructure === undefined
    ? {
        version: "codecity.source-structure/1" as const,
        availability: "unavailable" as const,
        types: [], callables: [], relations: [],
        unavailable: ["C# declaration detail is unavailable because this Roslyn helper predates codecity.source-structure/1."],
      }
    : parseSourceStructure(item.sourceStructure);
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
  const decisionLoad = integer(item.decisionLoad, "decision load", 0);
  if (
    units.length !== executableUnitCount ||
    Math.max(...units.map(({ complexity }) => complexity)) !==
      maximumComplexity ||
    units.reduce((total, unit) => total + unit.complexity - 1, 0) !==
      decisionLoad
  ) {
    throw new RoslynHostError(
      "The Roslyn helper returned inconsistent metrics.",
    );
  }
  const warnings = item.warnings.map((warning) =>
    safeText(warning, CITY_MODEL_LIMITS.warningCharacters),
  );
  validateUnitEvidenceLinks(
    units,
    sourceStructure,
    !warnings.includes("syntax-errors-present"),
  );
  return {
    id,
    status: "ok",
    metricMethod: "csharp-roslyn-v1",
    metrics: {
      sloc: integer(item.sloc, "SLOC", 0),
      decisionLoad,
      maximumComplexity,
      executableUnitCount,
    },
    units,
    sourceStructure,
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
  let decisionSites = 0;
  let decisionEvidenceBytes = 0;
  for (const outcome of outcomes) {
    if (outcome.status !== "ok") continue;
    for (const unit of outcome.units) {
      const evidence = unit.decisionEvidence;
      if (evidence === undefined) continue;
      decisionSites += evidence.sites.length;
      decisionEvidenceBytes += Buffer.byteLength(
        JSON.stringify(evidence),
        "utf8",
      );
    }
  }
  if (decisionSites > ROSLYN_HOST_LIMITS.decisionSitesPerBatch ||
    decisionEvidenceBytes > CITY_MODEL_LIMITS.decisionEvidenceBytesPerModel) {
    throw new RoslynHostError("The Roslyn helper returned oversized batch decision evidence.");
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
