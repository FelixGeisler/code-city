import { Buffer } from "node:buffer";
import net from "node:net";

import {
  analyzeGenericGitHistory,
  analyzeGenericGitRepository,
  analyzePublicGitHubRepository,
  DEFAULT_SNAPSHOT_LIMITS,
  genericGitRepositoryOrigin,
  GENERIC_GIT_PRESECURED_CANONICAL_ANCESTRY,
  GENERIC_GIT_PRESECURED_WINDOWS_ACL,
  GenericGitSnapshotError,
  GitHubSnapshotError,
  HISTORY_SELECTION_LIMITS,
  HistoryEvolutionError,
  HistorySelectionError,
  SnapshotDeadlineError,
  SnapshotLimitError,
  SnapshotPathError,
  SnapshotPolicyError,
  validateGenericGitRef,
  validateGenericGitRepositoryUrl,
  validatePublicGitHubRef,
  validatePublicGitHubRepositoryUrl,
  type GenericGitSnapshotCredential,
  type GenericGitSnapshotCredentialProvider,
  type GenericGitHistoryAnalysisResult,
  type GenericGitHistorySelectionRequest,
  type HistorySemanticCacheLike,
  type GitHubSnapshotCredential,
  type GitHubSnapshotCredentialProvider,
  type LocalAnalysisOptions,
  type RepositorySnapshot,
} from "../../../packages/analyzer/src/index.js";
import {
  normalizeAssetRelativePath,
  type EvolutionBundle,
  type PreparedEvolutionSerialization,
} from "../../../packages/core/src/index.js";
import type {
  CityModel,
  SourceRepositoryProvenance,
} from "../../../packages/core/src/index.js";

import {
  type JobRecord,
  type JobTaskContext,
  JobTaskFailure,
  PersistentJobQueue,
} from "./job-queue.js";
import {
  ImportArtifactStore,
  type CleanupStagingDirectoryOptions,
  type ImportStagingDirectory,
} from "./import-artifacts.js";
import type {
  CredentialProfileBinding,
  CredentialProfileRegistry,
} from "./credential-profiles.js";
import {
  attachSourceProvenance,
  createSourceArtifact,
  type SourceRetentionPolicy,
} from "./source-artifact.js";
import { SourceArtifactStore } from "./source-artifact-store.js";

const ROOT_KEYS = ["analysis", "history", "identity", "source"] as const;
const SOURCE_KEYS = [
  "credentialProfileId",
  "kind",
  "repositoryUrl",
  "revision",
] as const;
const REVISION_KEYS = ["kind", "name", "sha"] as const;
const IDENTITY_KEYS = ["logo", "title", "version"] as const;
const ANALYSIS_KEYS = [
  "maxFileBytes",
  "maxRetainedFiles",
  "maxTotalBytes",
  "timeoutMs",
] as const;
const HISTORY_COMMON_KEYS = [
  "maxAggregateChangedPathBytes",
  "maxAggregateChangedPaths",
  "maxAggregateSemanticBytes",
  "maxAggregateTreeEntries",
  "maxEvolutionOutputBytes",
  "maxUniqueLineages",
  "mode",
  "sampleEvery",
  "totalDeadlineMs",
] as const;
const PROTOTYPE_LIKE_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);
const COMMIT_SHA = /^[0-9a-f]{40}$/iu;
const HISTORY_ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/u;
const CREDENTIAL_PROFILE_ID = /^[a-z][a-z0-9-]{0,63}$/u;
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Cs}]/u;
const MAXIMUM_TITLE_CHARACTERS = 160;
const MAXIMUM_VERSION_CHARACTERS = 80;
const MAXIMUM_LOGO_CHARACTERS = 1_024;
const IMPORT_JOB_KIND = "project-import";
const IMPORT_PROGRESS_TOTAL = 3;
const MAXIMUM_JSON_NESTING = 32;
const MAXIMUM_ALLOWED_GIT_ORIGINS = 64;
const MAXIMUM_GIT_ORIGIN_CHARACTERS = 512;

export type RemoteImportFieldErrorCode =
  | "duplicate-field"
  | "invalid-json"
  | "invalid-type"
  | "invalid-value"
  | "limit-exceeded"
  | "required"
  | "source-not-allowed"
  | "unknown-field";

export interface RemoteImportFieldError {
  readonly code: RemoteImportFieldErrorCode;
  readonly path: string;
  readonly message: string;
}

export class RemoteImportRequestError extends Error {
  public override readonly name = "RemoteImportRequestError";

  public constructor(
    public readonly fields: readonly RemoteImportFieldError[],
    public readonly status: 400 | 403 = 400,
  ) {
    super("The import request is invalid.");
  }
}

export type RemoteImportRevisionKind = "branch" | "tag" | "commit";

export type RemoteImportRevision =
  | {
      readonly kind: "branch" | "tag";
      readonly name: string;
    }
  | {
      readonly kind: "commit";
      readonly sha: string;
    };

export interface RemoteImportSource {
  readonly kind: "github" | "git";
  readonly repositoryUrl: string;
  readonly credentialProfileId?: string;
  readonly revision?: RemoteImportRevision;
  /** Provider-qualified analyzer selector or exact lowercase commit SHA. */
  readonly ref?: string;
}

export interface RemoteImportIdentity {
  readonly title?: string;
  readonly version?: string;
  readonly logo?: string;
}

export interface RemoteImportAnalysis {
  readonly maxRetainedFiles?: number;
  readonly maxFileBytes?: number;
  readonly maxTotalBytes?: number;
  readonly timeoutMs?: number;
}

export interface RemoteImportRequest {
  readonly source: RemoteImportSource;
  readonly history?: GenericGitHistorySelectionRequest;
  readonly identity?: RemoteImportIdentity;
  readonly analysis?: RemoteImportAnalysis;
}

export interface RemoteImportDependencies {
  readonly analyzePublicGitHubRepository?: typeof analyzePublicGitHubRepository;
  readonly analyzeGenericGitRepository?: typeof analyzeGenericGitRepository;
  readonly analyzeGenericGitHistory?: typeof analyzeGenericGitHistory;
  readonly semanticCache?: HistorySemanticCacheLike;
}

function gitOriginKey(
  scheme: "https" | "ssh",
  hostname: string,
  port: number,
): string {
  const host = net.isIP(hostname) === 6 ? `[${hostname}]` : hostname;
  return `${scheme}://${host}:${port}`;
}

function normalizedAllowedGitOrigin(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAXIMUM_GIT_ORIGIN_CHARACTERS ||
    value !== value.trim() ||
    UNSAFE_TEXT.test(value) ||
    value.includes("*")
  ) {
    throw new Error(
      "Allowed Git origins must be exact HTTPS or SSH origins.",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(
      "Allowed Git origins must be exact HTTPS or SSH origins.",
    );
  }
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "ssh:") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    (parsed.pathname !== "" && parsed.pathname !== "/") ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    value.includes("?") ||
    value.includes("#")
  ) {
    throw new Error(
      "Allowed Git origins must be exact HTTPS or SSH origins.",
    );
  }
  const hostname = parsed.hostname
    .replace(/^\[|\]$/gu, "")
    .toLocaleLowerCase("en-US");
  if (
    hostname.length === 0 ||
    (net.isIP(hostname) === 0 &&
      (hostname.length > 253 ||
        hostname.includes("..") ||
        !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(
          hostname,
        )))
  ) {
    throw new Error(
      "Allowed Git origins must be exact HTTPS or SSH origins.",
    );
  }
  const scheme = parsed.protocol === "https:" ? "https" : "ssh";
  const port = Number(
    parsed.port || (scheme === "https" ? "443" : "22"),
  );
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(
      "Allowed Git origins must use a valid explicit or default port.",
    );
  }
  return gitOriginKey(scheme, hostname, port);
}

export class RemoteImportPolicy {
  readonly #allowedGenericGitOrigins: ReadonlySet<string>;
  readonly #platform: NodeJS.Platform;
  readonly #trustWindowsGitWorkspace: boolean;

  public constructor(
    origins: readonly string[] = [],
    options: {
      readonly platform?: NodeJS.Platform;
      readonly trustWindowsGitWorkspace?: boolean;
    } = {},
  ) {
    if (
      !Array.isArray(origins) ||
      origins.length > MAXIMUM_ALLOWED_GIT_ORIGINS
    ) {
      throw new Error(
        `At most ${MAXIMUM_ALLOWED_GIT_ORIGINS} exact Git origins may be allowed.`,
      );
    }
    const normalized = new Set<string>();
    for (const origin of origins) {
      normalized.add(normalizedAllowedGitOrigin(origin));
    }
    const platform = options.platform ?? process.platform;
    const trustWindowsGitWorkspace =
      options.trustWindowsGitWorkspace ?? false;
    if (typeof trustWindowsGitWorkspace !== "boolean") {
      throw new Error(
        "Windows Generic Git workspace trust must be an explicit boolean.",
      );
    }
    if (
      platform === "win32" &&
      normalized.size > 0 &&
      !trustWindowsGitWorkspace
    ) {
      throw new Error(
        "Allowed Git origins on Windows require explicit private workspace ACL and ancestry trust.",
      );
    }
    this.#allowedGenericGitOrigins = normalized;
    this.#platform = platform;
    this.#trustWindowsGitWorkspace =
      trustWindowsGitWorkspace;
  }

  public assertAllowed(request: RemoteImportRequest): void {
    if (
      this.#platform === "win32" &&
      request.history !== undefined &&
      !this.#trustWindowsGitWorkspace
    ) {
      throw new RemoteImportRequestError(
        [
          Object.freeze({
            code: "source-not-allowed",
            path: "$.history",
            message:
              "Repository history on Windows requires CODECITY_TRUST_WINDOWS_GIT_WORKSPACE=1 after securing the private workspace ACL and ancestry.",
          }),
        ],
        403,
      );
    }
    if (request.source.kind !== "git") return;
    const origin = genericGitRepositoryOrigin(
      request.source.repositoryUrl,
    );
    const key = gitOriginKey(
      origin.scheme,
      origin.hostname,
      origin.port,
    );
    if (this.#allowedGenericGitOrigins.has(key)) return;
    throw new RemoteImportRequestError(
      [
        Object.freeze({
          code: "source-not-allowed",
          path: "$.source.repositoryUrl",
          message:
            "This Generic Git origin is not allowed by the server.",
        }),
      ],
      403,
    );
  }
}

interface RemoteImportRuntime {
  readonly jobs: PersistentJobQueue;
  readonly artifacts: ImportArtifactStore;
  readonly sources?: SourceArtifactStore;
  readonly sourceRetention?: SourceRetentionPolicy;
  readonly policy: RemoteImportPolicy;
  readonly credentialProfiles: CredentialProfileRegistry;
  readonly dependencies?: RemoteImportDependencies;
}

function fail(
  path: string,
  message: string,
  code: RemoteImportFieldErrorCode = "invalid-value",
): never {
  throw new RemoteImportRequestError([
    Object.freeze({ code, path, message }),
  ]);
}

class ExactJsonScanner {
  #index = 0;

  public constructor(private readonly text: string) {}

  public scan(): void {
    this.skipWhitespace();
    this.scanValue("$", 0);
    this.skipWhitespace();
    if (this.#index !== this.text.length) this.invalidJson();
  }

  private invalidJson(): never {
    fail("$", "Must contain one valid JSON value.", "invalid-json");
  }

  private skipWhitespace(): void {
    while (
      this.text[this.#index] === " " ||
      this.text[this.#index] === "\t" ||
      this.text[this.#index] === "\r" ||
      this.text[this.#index] === "\n"
    ) {
      this.#index += 1;
    }
  }

  private consume(expected: string): void {
    if (!this.text.startsWith(expected, this.#index)) {
      this.invalidJson();
    }
    this.#index += expected.length;
  }

  private scanValue(path: string, depth: number): void {
    if (depth > MAXIMUM_JSON_NESTING) {
      fail(
        "$",
        `JSON nesting must not exceed ${MAXIMUM_JSON_NESTING}.`,
        "limit-exceeded",
      );
    }
    this.skipWhitespace();
    const character = this.text[this.#index];
    if (character === "{") {
      this.scanObject(path, depth);
      return;
    }
    if (character === "[") {
      this.scanArray(path, depth);
      return;
    }
    if (character === '"') {
      this.scanString();
      return;
    }
    if (character === "t") {
      this.consume("true");
      return;
    }
    if (character === "f") {
      this.consume("false");
      return;
    }
    if (character === "n") {
      this.consume("null");
      return;
    }
    const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(
      this.text.slice(this.#index),
    )?.[0];
    if (number === undefined) this.invalidJson();
    this.#index += number.length;
  }

  private scanObject(path: string, depth: number): void {
    this.consume("{");
    this.skipWhitespace();
    if (this.text[this.#index] === "}") {
      this.#index += 1;
      return;
    }
    const keys = new Set<string>();
    while (true) {
      if (this.text[this.#index] !== '"') this.invalidJson();
      const key = this.scanString();
      if (keys.has(key)) {
        fail(
          path,
          "Must not contain duplicate JSON members.",
          "duplicate-field",
        );
      }
      keys.add(key);
      this.skipWhitespace();
      this.consume(":");
      this.scanValue(path, depth + 1);
      this.skipWhitespace();
      const delimiter = this.text[this.#index];
      if (delimiter === "}") {
        this.#index += 1;
        return;
      }
      if (delimiter !== ",") this.invalidJson();
      this.#index += 1;
      this.skipWhitespace();
    }
  }

  private scanArray(path: string, depth: number): void {
    this.consume("[");
    this.skipWhitespace();
    if (this.text[this.#index] === "]") {
      this.#index += 1;
      return;
    }
    let index = 0;
    while (true) {
      this.scanValue(`${path}[${index}]`, depth + 1);
      index += 1;
      this.skipWhitespace();
      const delimiter = this.text[this.#index];
      if (delimiter === "]") {
        this.#index += 1;
        return;
      }
      if (delimiter !== ",") this.invalidJson();
      this.#index += 1;
      this.skipWhitespace();
    }
  }

  private scanString(): string {
    const start = this.#index;
    this.consume('"');
    while (this.#index < this.text.length) {
      const character = this.text[this.#index]!;
      const code = character.charCodeAt(0);
      if (character === '"') {
        this.#index += 1;
        const token = this.text.slice(start, this.#index);
        try {
          const decoded = JSON.parse(token) as unknown;
          if (typeof decoded !== "string") this.invalidJson();
          return decoded;
        } catch (error) {
          if (error instanceof RemoteImportRequestError) throw error;
          this.invalidJson();
        }
      }
      if (code < 0x20) this.invalidJson();
      if (character !== "\\") {
        this.#index += 1;
        continue;
      }
      this.#index += 1;
      const escaped = this.text[this.#index];
      if (escaped === "u") {
        const hex = this.text.slice(
          this.#index + 1,
          this.#index + 5,
        );
        if (!/^[0-9a-f]{4}$/iu.test(hex)) this.invalidJson();
        this.#index += 5;
        continue;
      }
      if (
        escaped === undefined ||
        !'"\\/bfnrt'.includes(escaped)
      ) {
        this.invalidJson();
      }
      this.#index += 1;
    }
    this.invalidJson();
  }
}

export function parseRemoteImportJson(
  text: string,
): RemoteImportRequest {
  return parseRemoteImportRequest(parseExactImportJsonValue(text));
}

export function parseExactImportJsonValue(text: string): unknown {
  try {
    new ExactJsonScanner(text).scan();
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof RemoteImportRequestError) throw error;
    fail("$", "Must contain one valid JSON value.", "invalid-json");
  }
}

function jsonObject(
  value: unknown,
  path: string,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    fail(path, "Must be a JSON object.", "invalid-type");
  }
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      fail(
        path,
        "Must be a plain JSON object.",
        "invalid-type",
      );
    }
  } catch (error) {
    if (error instanceof RemoteImportRequestError) throw error;
    fail(path, "Must be a readable JSON object.", "invalid-type");
  }
  const object = value as Record<string, unknown>;
  let keys: string[];
  try {
    keys = Object.keys(object).sort();
  } catch {
    fail(path, "Must be a readable JSON object.", "invalid-type");
  }
  for (const key of keys) {
    if (
      PROTOTYPE_LIKE_KEYS.has(key) ||
      !allowedKeys.includes(key)
    ) {
      fail(
        path,
        "Unknown field.",
        "unknown-field",
      );
    }
  }
  return object;
}

function required(
  object: Record<string, unknown>,
  key: string,
  path: string,
): unknown {
  if (!Object.hasOwn(object, key)) {
    fail(path, "Field is required.", "required");
  }
  return object[key];
}

function boundedText(
  value: unknown,
  path: string,
  maximumCharacters: number,
): string {
  if (typeof value !== "string") {
    fail(path, "Must be a string.", "invalid-type");
  }
  const normalized = value.normalize("NFC").trim();
  if (
    normalized.length === 0 ||
    normalized.length > maximumCharacters ||
    UNSAFE_TEXT.test(normalized)
  ) {
    fail(
      path,
      `Must contain 1 to ${maximumCharacters} safe characters.`,
    );
  }
  return normalized;
}

function boundedExactText(
  value: unknown,
  path: string,
  maximumCharacters: number,
): string {
  if (typeof value !== "string") {
    fail(path, "Must be a string.", "invalid-type");
  }
  if (
    value.length === 0 ||
    value.length > maximumCharacters ||
    UNSAFE_TEXT.test(value)
  ) {
    fail(
      path,
      `Must contain 1 to ${maximumCharacters} safe characters.`,
    );
  }
  return value;
}

function optionalBoundedText(
  object: Record<string, unknown>,
  key: string,
  path: string,
  maximumCharacters: number,
): string | undefined {
  if (!Object.hasOwn(object, key)) return undefined;
  return boundedText(object[key], path, maximumCharacters);
}

export function parseImportIdentity(
  value: unknown,
): RemoteImportIdentity {
  const object = jsonObject(value, "$.identity", IDENTITY_KEYS);
  const title = optionalBoundedText(
    object,
    "title",
    "$.identity.title",
    MAXIMUM_TITLE_CHARACTERS,
  );
  const version = optionalBoundedText(
    object,
    "version",
    "$.identity.version",
    MAXIMUM_VERSION_CHARACTERS,
  );
  let logo = optionalBoundedText(
    object,
    "logo",
    "$.identity.logo",
    MAXIMUM_LOGO_CHARACTERS,
  );
  if (logo !== undefined) {
    try {
      logo = normalizeAssetRelativePath(logo);
      if (!/\.(?:png|svg)$/iu.test(logo)) {
        fail("$.identity.logo", "Must reference a relative .svg or .png asset.");
      }
    } catch (error) {
      if (error instanceof RemoteImportRequestError) throw error;
      fail("$.identity.logo", "Must reference a safe relative .svg or .png asset.");
    }
  }
  if (title === undefined && (version !== undefined || logo !== undefined)) {
    fail(
      "$.identity.title",
      "Is required when identity.version or identity.logo is supplied.",
    );
  }
  return Object.freeze({
    ...(title === undefined ? {} : { title }),
    ...(version === undefined ? {} : { version }),
    ...(logo === undefined ? {} : { logo }),
  });
}

function analysisLimit(
  object: Record<string, unknown>,
  key: keyof typeof DEFAULT_SNAPSHOT_LIMITS,
  minimum: number,
): number | undefined {
  if (!Object.hasOwn(object, key)) return undefined;
  const value = object[key];
  const maximum = DEFAULT_SNAPSHOT_LIMITS[key];
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    fail(
      `$.analysis.${key}`,
      `Must be an integer from ${minimum} to ${maximum}.`,
    );
  }
  return value;
}

export function parseImportAnalysis(
  value: unknown,
): RemoteImportAnalysis {
  const object = jsonObject(value, "$.analysis", ANALYSIS_KEYS);
  const maxRetainedFiles = analysisLimit(
    object,
    "maxRetainedFiles",
    0,
  );
  const maxFileBytes = analysisLimit(object, "maxFileBytes", 0);
  const maxTotalBytes = analysisLimit(object, "maxTotalBytes", 0);
  const timeoutMs = analysisLimit(object, "timeoutMs", 1);
  if (
    maxFileBytes !== undefined &&
    maxTotalBytes !== undefined &&
    maxFileBytes > maxTotalBytes
  ) {
    fail(
      "$.analysis.maxFileBytes",
      "Must not exceed maxTotalBytes.",
    );
  }
  return Object.freeze({
    ...(maxRetainedFiles === undefined ? {} : { maxRetainedFiles }),
    ...(maxFileBytes === undefined ? {} : { maxFileBytes }),
    ...(maxTotalBytes === undefined ? {} : { maxTotalBytes }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

function historyInteger(
  object: Readonly<Record<string, unknown>>,
  key: string,
  maximum: number,
  requiredValue = false,
): number | undefined {
  if (!Object.hasOwn(object, key)) {
    if (requiredValue) fail(`$.history.${key}`, "Required.", "required");
    return undefined;
  }
  const value = object[key];
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > maximum
  ) {
    fail(
      `$.history.${key}`,
      `Must be an integer from 1 to ${maximum}.`,
      "limit-exceeded",
    );
  }
  return value;
}

function historyBounds(
  object: Readonly<Record<string, unknown>>,
): {
  readonly sampleEvery?: number;
  readonly totalDeadlineMs?: number;
  readonly maxAggregateChangedPathBytes?: number;
  readonly maxAggregateChangedPaths?: number;
  readonly maxAggregateSemanticBytes?: number;
  readonly maxAggregateTreeEntries?: number;
  readonly maxUniqueLineages?: number;
  readonly maxEvolutionOutputBytes?: number;
} {
  const sampleEvery = historyInteger(
    object,
    "sampleEvery",
    HISTORY_SELECTION_LIMITS.maxSampleEvery,
  );
  const totalDeadlineMs = Object.hasOwn(object, "totalDeadlineMs")
    ? historyInteger(
        object,
        "totalDeadlineMs",
        HISTORY_SELECTION_LIMITS.maxTotalDeadlineMs,
        true,
      )
    : undefined;
  if (
    totalDeadlineMs !== undefined &&
    totalDeadlineMs < HISTORY_SELECTION_LIMITS.minTotalDeadlineMs
  ) {
    fail(
      "$.history.totalDeadlineMs",
      `Must be at least ${HISTORY_SELECTION_LIMITS.minTotalDeadlineMs}.`,
      "limit-exceeded",
    );
  }
  const maxAggregateChangedPaths = historyInteger(
    object,
    "maxAggregateChangedPaths",
    HISTORY_SELECTION_LIMITS.maxAggregateChangedPaths,
  );
  const maxAggregateChangedPathBytes = historyInteger(
    object,
    "maxAggregateChangedPathBytes",
    HISTORY_SELECTION_LIMITS.maxAggregateChangedPathBytes,
  );
  const maxAggregateSemanticBytes = historyInteger(
    object,
    "maxAggregateSemanticBytes",
    HISTORY_SELECTION_LIMITS.maxAggregateSemanticBytes,
  );
  const maxAggregateTreeEntries = historyInteger(
    object,
    "maxAggregateTreeEntries",
    HISTORY_SELECTION_LIMITS.maxAggregateTreeEntries,
  );
  const maxUniqueLineages = historyInteger(
    object,
    "maxUniqueLineages",
    HISTORY_SELECTION_LIMITS.maxUniqueLineages,
  );
  const maxEvolutionOutputBytes = historyInteger(
    object,
    "maxEvolutionOutputBytes",
    HISTORY_SELECTION_LIMITS.maxEvolutionOutputBytes,
  );
  return Object.freeze({
    ...(sampleEvery === undefined ? {} : { sampleEvery }),
    ...(totalDeadlineMs === undefined ? {} : { totalDeadlineMs }),
    ...(maxAggregateChangedPaths === undefined
      ? {}
      : { maxAggregateChangedPaths }),
    ...(maxAggregateChangedPathBytes === undefined
      ? {}
      : { maxAggregateChangedPathBytes }),
    ...(maxAggregateSemanticBytes === undefined
      ? {}
      : { maxAggregateSemanticBytes }),
    ...(maxAggregateTreeEntries === undefined
      ? {}
      : { maxAggregateTreeEntries }),
    ...(maxUniqueLineages === undefined
      ? {}
      : { maxUniqueLineages }),
    ...(maxEvolutionOutputBytes === undefined
      ? {}
      : { maxEvolutionOutputBytes }),
  });
}

function assertHistoryFrameBound(
  maximumCommits: number,
  sampleEvery: number | undefined,
): void {
  const interval = sampleEvery ?? 1;
  const frames = Math.ceil((maximumCommits - 1) / interval) + 1;
  if (frames > HISTORY_SELECTION_LIMITS.maxSampledFrames) {
    fail(
      "$.history.sampleEvery",
      `This selection can produce ${frames} frames; increase sampleEvery so no more than ${HISTORY_SELECTION_LIMITS.maxSampledFrames} frames are requested.`,
      "limit-exceeded",
    );
  }
}

function canonicalHistoryInstant(
  value: unknown,
  key: "fromInclusive" | "toInclusive",
): string {
  const text = boundedExactText(value, `$.history.${key}`, 64);
  const match = HISTORY_ISO_INSTANT.exec(text);
  if (match === null) {
    fail(
      `$.history.${key}`,
      "Must be an ISO-8601 instant with an explicit UTC offset.",
    );
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const millisecond = Number((match[7] ?? "").padEnd(3, "0"));
  const offsetHour = match[8] === "Z" ? 0 : Number(match[10]);
  const offsetMinute = match[8] === "Z" ? 0 : Number(match[11]);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    fail(`$.history.${key}`, "Must be a valid ISO-8601 instant.");
  }

  const local = new Date(0);
  local.setUTCFullYear(year, month - 1, day);
  local.setUTCHours(hour, minute, second, millisecond);
  if (
    local.getUTCFullYear() !== year ||
    local.getUTCMonth() !== month - 1 ||
    local.getUTCDate() !== day ||
    local.getUTCHours() !== hour ||
    local.getUTCMinutes() !== minute ||
    local.getUTCSeconds() !== second ||
    local.getUTCMilliseconds() !== millisecond
  ) {
    fail(`$.history.${key}`, "Must be a valid calendar instant.");
  }

  const offsetMilliseconds =
    (offsetHour * 60 + offsetMinute) * 60 * 1_000;
  const signedOffset =
    match[8] === "Z" || match[9] === "+"
      ? offsetMilliseconds
      : -offsetMilliseconds;
  const utcMilliseconds = local.getTime() - signedOffset;
  let normalized: string;
  try {
    normalized = new Date(utcMilliseconds).toISOString();
  } catch {
    fail(
      `$.history.${key}`,
      "Must be an ISO-8601 instant in the supported date range.",
    );
  }
  if (normalized.length !== 24) {
    fail(
      `$.history.${key}`,
      "Must normalize to a supported four-digit UTC year.",
    );
  }
  return normalized;
}

function historyTagName(
  value: unknown,
  key: "oldestTagName" | "newestTagName",
): string {
  const name = boundedExactText(
    value,
    `$.history.${key}`,
    HISTORY_SELECTION_LIMITS.maxTagNameBytes,
  );
  if (
    Buffer.byteLength(name, "utf8") >
    HISTORY_SELECTION_LIMITS.maxTagNameBytes
  ) {
    fail(
      `$.history.${key}`,
      `Must be no larger than ${HISTORY_SELECTION_LIMITS.maxTagNameBytes} UTF-8 bytes.`,
      "limit-exceeded",
    );
  }
  if (name.startsWith("refs/")) {
    fail(
      `$.history.${key}`,
      "Must be an unqualified exact tag name.",
    );
  }
  try {
    return validateGenericGitRef(`refs/tags/${name}`).slice(
      "refs/tags/".length,
    );
  } catch {
    fail(`$.history.${key}`, "Must be a valid exact Git tag name.");
  }
}

export function parseImportHistory(
  value: unknown,
): GenericGitHistorySelectionRequest {
  const initial = jsonObject(
    value,
    "$.history",
    [
      ...HISTORY_COMMON_KEYS,
      "commitCount",
      "fromInclusive",
      "maxFrames",
      "maxCommits",
      "newestTagName",
      "oldestTagName",
      "toInclusive",
    ],
  );
  const mode = required(initial, "mode", "$.history.mode");
  if (
    mode !== "root-to-tip" &&
    mode !== "commit-count" &&
    mode !== "date-range" &&
    mode !== "tag-range"
  ) {
    fail(
      "$.history.mode",
      'Must be "root-to-tip", "commit-count", "date-range", or "tag-range".',
    );
  }
  const modeKeys =
    mode === "root-to-tip"
      ? [
          ...HISTORY_COMMON_KEYS.filter(
            (key) => key !== "sampleEvery",
          ),
          "maxFrames",
        ]
      : mode === "commit-count"
      ? [...HISTORY_COMMON_KEYS, "commitCount"]
      : mode === "date-range"
        ? [
            ...HISTORY_COMMON_KEYS,
            "fromInclusive",
            "maxCommits",
            "toInclusive",
          ]
        : [
            ...HISTORY_COMMON_KEYS,
            "maxCommits",
            "newestTagName",
            "oldestTagName",
          ];
  const object = jsonObject(value, "$.history", modeKeys);
  const bounds = historyBounds(object);
  if (mode === "root-to-tip") {
    const maxFrames = historyInteger(
      object,
      "maxFrames",
      HISTORY_SELECTION_LIMITS.maxSampledFrames,
      true,
    )!;
    if (maxFrames < 2) {
      fail(
        "$.history.maxFrames",
        "Must be an integer from 2 to 100.",
        "limit-exceeded",
      );
    }
    const { sampleEvery: _unused, ...analysisBounds } = bounds;
    return Object.freeze({
      mode,
      maxFrames,
      ...analysisBounds,
    });
  }
  if (mode === "commit-count") {
    const commitCount = historyInteger(
      object,
      "commitCount",
      HISTORY_SELECTION_LIMITS.maxTraversedCommits,
      true,
    )!;
    assertHistoryFrameBound(commitCount, bounds.sampleEvery);
    return Object.freeze({
      mode,
      commitCount,
      ...bounds,
    });
  }
  const maxCommits = historyInteger(
    object,
    "maxCommits",
    HISTORY_SELECTION_LIMITS.maxTraversedCommits,
    true,
  )!;
  assertHistoryFrameBound(maxCommits, bounds.sampleEvery);
  if (mode === "date-range") {
    const fromInclusive = canonicalHistoryInstant(
      required(
        object,
        "fromInclusive",
        "$.history.fromInclusive",
      ),
      "fromInclusive",
    );
    const toInclusive = canonicalHistoryInstant(
      required(object, "toInclusive", "$.history.toInclusive"),
      "toInclusive",
    );
    if (Date.parse(fromInclusive) > Date.parse(toInclusive)) {
      fail(
        "$.history.fromInclusive",
        "Must not be later than toInclusive.",
      );
    }
    return Object.freeze({
      mode,
      fromInclusive,
      toInclusive,
      maxCommits,
      ...bounds,
    });
  }
  return Object.freeze({
    mode,
    oldestTagName: historyTagName(
      required(
        object,
        "oldestTagName",
        "$.history.oldestTagName",
      ),
      "oldestTagName",
    ),
    newestTagName: historyTagName(
      required(
        object,
        "newestTagName",
        "$.history.newestTagName",
      ),
      "newestTagName",
    ),
    maxCommits,
    ...bounds,
  });
}

function revisionRef(
  value: unknown,
  sourceKind: "github" | "git",
): {
  readonly revision: RemoteImportRevision;
  readonly ref: string;
} {
  const object = jsonObject(value, "$.source.revision", REVISION_KEYS);
  const rawKind = required(
    object,
    "kind",
    "$.source.revision.kind",
  );
  if (
    rawKind !== "branch" &&
    rawKind !== "tag" &&
    rawKind !== "commit"
  ) {
    fail(
      "$.source.revision.kind",
      'Must be "branch", "tag", or "commit".',
    );
  }
  if (rawKind === "commit") {
    jsonObject(
      value,
      "$.source.revision",
      ["kind", "sha"],
    );
    const rawSha = boundedExactText(
      required(object, "sha", "$.source.revision.sha"),
      "$.source.revision.sha",
      40,
    );
    if (!COMMIT_SHA.test(rawSha)) {
      fail(
        "$.source.revision.sha",
        "Must be an exact 40-character hexadecimal commit SHA.",
      );
    }
    const sha = rawSha.toLocaleLowerCase("en-US");
    return Object.freeze({
      revision: Object.freeze({ kind: "commit", sha }),
      ref: sha,
    });
  }
  jsonObject(
    value,
    "$.source.revision",
    ["kind", "name"],
  );
  const rawName = boundedExactText(
    required(object, "name", "$.source.revision.name"),
    "$.source.revision.name",
    1_024,
  );
  if (rawName.startsWith("refs/")) {
    fail(
      "$.source.revision.name",
      "Branch and tag values must be unqualified names.",
    );
  }
  const prefix =
    sourceKind === "github"
      ? rawKind === "branch"
        ? "heads/"
        : "tags/"
      : rawKind === "branch"
        ? "refs/heads/"
        : "refs/tags/";
  const qualified = `${prefix}${rawName}`;
  try {
    const ref =
      sourceKind === "github"
        ? validatePublicGitHubRef(qualified)
        : validateGenericGitRef(qualified);
    return Object.freeze({
      revision: Object.freeze({
        kind: rawKind,
        name: ref.slice(prefix.length),
      }),
      ref,
    });
  } catch {
    fail(
      "$.source.revision.name",
      `Must be a valid Git ${rawKind} name.`,
    );
  }
}

function parseSource(value: unknown): RemoteImportSource {
  const object = jsonObject(value, "$.source", SOURCE_KEYS);
  const kind = required(object, "kind", "$.source.kind");
  if (kind !== "github" && kind !== "git") {
    fail("$.source.kind", 'Must be "github" or "git".');
  }
  const rawRepositoryUrl = boundedExactText(
    required(
      object,
      "repositoryUrl",
      "$.source.repositoryUrl",
    ),
    "$.source.repositoryUrl",
    4_096,
  );
  let repositoryUrl: string;
  try {
    repositoryUrl =
      kind === "github"
        ? validatePublicGitHubRepositoryUrl(rawRepositoryUrl)
        : validateGenericGitRepositoryUrl(rawRepositoryUrl);
  } catch {
    fail(
      "$.source.repositoryUrl",
      kind === "github"
        ? "Must be a canonical anonymous https://github.com/owner/repository URL."
        : "Must be a credential-free HTTPS, SSH, or scp-style Git remote without query or fragment data.",
    );
  }
  const parsedRevision = Object.hasOwn(object, "revision")
    ? revisionRef(object["revision"], kind)
    : undefined;
  let credentialProfileId: string | undefined;
  if (Object.hasOwn(object, "credentialProfileId")) {
    credentialProfileId = boundedExactText(
      object["credentialProfileId"],
      "$.source.credentialProfileId",
      64,
    );
    if (!CREDENTIAL_PROFILE_ID.test(credentialProfileId)) {
      fail(
        "$.source.credentialProfileId",
        "Must start with a lowercase letter and contain at most 64 lowercase letters, digits, or hyphens.",
      );
    }
  }
  return Object.freeze({
    kind,
    repositoryUrl,
    ...(credentialProfileId === undefined
      ? {}
      : { credentialProfileId }),
    ...(parsedRevision === undefined
      ? {}
      : {
          revision: parsedRevision.revision,
          ref: parsedRevision.ref,
        }),
  });
}

export function parseRemoteImportRequest(
  value: unknown,
): RemoteImportRequest {
  try {
    const object = jsonObject(value, "$", ROOT_KEYS);
    const source = parseSource(
      required(object, "source", "$.source"),
    );
    const history = Object.hasOwn(object, "history")
      ? parseImportHistory(object["history"])
      : undefined;
    if (
      history?.mode === "tag-range" &&
      source.revision !== undefined
    ) {
      fail(
        "$.source.revision",
        "Must be omitted when history uses a tag range.",
      );
    }
    const identity = Object.hasOwn(object, "identity")
      ? parseImportIdentity(object["identity"])
      : undefined;
    const analysis = Object.hasOwn(object, "analysis")
      ? parseImportAnalysis(object["analysis"])
      : undefined;
    if (
      history?.totalDeadlineMs !== undefined &&
      analysis?.timeoutMs !== undefined
    ) {
      fail(
        "$.analysis.timeoutMs",
        "Must be omitted when history.totalDeadlineMs is provided.",
      );
    }
    if (
      history !== undefined &&
      history.totalDeadlineMs === undefined &&
      analysis?.timeoutMs !== undefined &&
      analysis.timeoutMs < HISTORY_SELECTION_LIMITS.minTotalDeadlineMs
    ) {
      fail(
        "$.analysis.timeoutMs",
        `Must be at least ${HISTORY_SELECTION_LIMITS.minTotalDeadlineMs} when it supplies the history total deadline.`,
      );
    }
    return Object.freeze({
      source,
      ...(history === undefined ? {} : { history }),
      ...(identity === undefined ? {} : { identity }),
      ...(analysis === undefined ? {} : { analysis }),
    });
  } catch (error) {
    if (error instanceof RemoteImportRequestError) throw error;
    fail(
      "$",
      "Must be a readable exact-shape JSON object.",
      "invalid-json",
    );
  }
}

function analyzerOptions(
  request: RemoteImportRequest,
  signal: AbortSignal,
): LocalAnalysisOptions {
  return Object.freeze({
    ...(request.identity ?? {}),
    ...(request.analysis ?? {}),
    signal,
  });
}

function fixedTaskFailure(): Error {
  return new Error("Repository import failed.");
}

function githubCredentialProvider(
  binding: CredentialProfileBinding<"github">,
): GitHubSnapshotCredentialProvider {
  return Object.freeze({
    provider: "github" as const,
    use<T>(
      signal: AbortSignal,
      operation: (
        credential: GitHubSnapshotCredential,
      ) => T | Promise<T>,
    ): Promise<T> {
      return binding.use(signal, (credential) => {
        if (credential.kind !== "bearer") {
          throw fixedTaskFailure();
        }
        return operation(credential);
      });
    },
  });
}

function genericGitCredentialProvider(
  binding: CredentialProfileBinding<
    "azure-devops" | "generic-https"
  >,
): GenericGitSnapshotCredentialProvider {
  return Object.freeze({
    provider: "basic" as const,
    use<T>(
      signal: AbortSignal,
      operation: (
        credential: GenericGitSnapshotCredential,
      ) => T | Promise<T>,
    ): Promise<T> {
      return binding.use(signal, (credential) => {
        if (credential.kind !== "basic") {
          throw fixedTaskFailure();
        }
        return operation(credential);
      });
    },
  });
}

function githubHistoryCredentialProvider(
  binding: CredentialProfileBinding<"github">,
): GenericGitSnapshotCredentialProvider {
  return Object.freeze({
    provider: "basic" as const,
    use<T>(
      signal: AbortSignal,
      operation: (
        credential: GenericGitSnapshotCredential,
      ) => T | Promise<T>,
    ): Promise<T> {
      return binding.use(signal, (credential) => {
        if (credential.kind !== "bearer") {
          throw fixedTaskFailure();
        }
        return operation({
          kind: "basic",
          username: "x-access-token",
          secret: credential.secret,
        });
      });
    },
  });
}

type BoundCredentialProfile =
  | CredentialProfileBinding<"github">
  | CredentialProfileBinding<
      "azure-devops" | "generic-https"
    >;

function analysisTaskFailure(error: unknown): JobTaskFailure {
  if (error instanceof HistorySelectionError) {
    if (error.code === "history-too-long") {
      return new JobTaskFailure("history-too-long");
    }
    if (error.code === "history-incomplete") {
      return new JobTaskFailure("history-incomplete");
    }
    if (error.code === "limit-exceeded") {
      return new JobTaskFailure("history-limit-exceeded");
    }
    if (error.code === "selection-unavailable") {
      return new JobTaskFailure("revision-unavailable");
    }
    return new JobTaskFailure("analysis-failed");
  }
  if (error instanceof HistoryEvolutionError) {
    if (error.code === "deadline-exceeded") {
      return new JobTaskFailure("deadline-exceeded");
    }
    if (error.code === "limit-exceeded") {
      return new JobTaskFailure("history-limit-exceeded");
    }
    return new JobTaskFailure("analysis-failed");
  }
  if (error instanceof SnapshotDeadlineError) {
    return new JobTaskFailure("deadline-exceeded");
  }
  if (error instanceof SnapshotLimitError) {
    return new JobTaskFailure("import-limit-exceeded");
  }
  if (
    error instanceof SnapshotPathError ||
    error instanceof SnapshotPolicyError
  ) {
    return new JobTaskFailure("repository-content-rejected");
  }
  if (error instanceof GitHubSnapshotError) {
    if (
      error.code === "GITHUB_REPOSITORY_UNAVAILABLE" ||
      error.code === "GITHUB_REQUEST_FAILED"
    ) {
      return new JobTaskFailure("repository-unavailable");
    }
    if (error.code === "GITHUB_REF_UNAVAILABLE") {
      return new JobTaskFailure("revision-unavailable");
    }
    if (error.code === "GITHUB_DEADLINE_EXCEEDED") {
      return new JobTaskFailure("deadline-exceeded");
    }
    if (error.code === "GITHUB_RESPONSE_TOO_LARGE") {
      return new JobTaskFailure("import-limit-exceeded");
    }
    return new JobTaskFailure("analysis-failed");
  }
  if (error instanceof GenericGitSnapshotError) {
    if (error.code === "GIT_PARTIAL_CLONE_UNAVAILABLE") {
      return new JobTaskFailure("history-capability-unavailable");
    }
    if (error.code === "GIT_COMMAND_FAILED") {
      return new JobTaskFailure("repository-unavailable");
    }
    if (
      error.code === "GIT_REF_AMBIGUOUS" ||
      error.code === "GIT_REF_CHANGED" ||
      error.code === "GIT_REF_UNAVAILABLE"
    ) {
      return new JobTaskFailure("revision-unavailable");
    }
    if (error.code === "GIT_DEADLINE_EXCEEDED") {
      return new JobTaskFailure("deadline-exceeded");
    }
    if (
      error.code === "GIT_ARCHIVE_TOO_LARGE" ||
      error.code === "GIT_OUTPUT_TOO_LARGE" ||
      error.code === "GIT_TEMPORARY_LIMIT"
    ) {
      return new JobTaskFailure("import-limit-exceeded");
    }
    return new JobTaskFailure("analysis-failed");
  }
  return new JobTaskFailure("analysis-failed");
}

async function allCleanupOperations(
  operations: readonly Promise<void>[],
): Promise<void> {
  const settled = await Promise.allSettled(operations);
  if (settled.some(({ status }) => status === "rejected")) {
    throw new Error("Repository import cleanup failed.");
  }
}

function stagingCleanup(
  artifacts: ImportArtifactStore,
  staging: ImportStagingDirectory,
): (options?: CleanupStagingDirectoryOptions) => Promise<void> {
  let cleaned = false;
  let active: Promise<void> | undefined;
  return (options = {}) => {
    if (cleaned) return Promise.resolve();
    if (active !== undefined) return active;
    active = artifacts
      .cleanupStagingDirectory(staging.token, options)
      .then(() => {
        cleaned = true;
      });
    void active.finally(() => {
      active = undefined;
    }).catch(() => undefined);
    return active;
  };
}

interface RemoteImportAnalysisOutput {
  readonly model: CityModel;
  readonly sourceSnapshot?: RepositorySnapshot;
  readonly evolution?: EvolutionBundle;
  readonly preparedEvolution?: PreparedEvolutionSerialization;
  /**
   * Absolute wall-clock deadline shared by history analysis, publication,
   * and temporary-data cleanup.
   */
  readonly historyDeadlineAt?: number;
}

interface HistoryDeadlineScope {
  readonly signal: AbortSignal;
  checkpoint(): void;
  dispose(): void;
}

function historyDeadlineScope(
  deadlineAt: number,
  parentSignal: AbortSignal,
): HistoryDeadlineScope {
  const controller = new AbortController();
  const abortFromParent = (): void => {
    controller.abort(parentSignal.reason);
  };
  if (parentSignal.aborted) {
    abortFromParent();
  } else {
    parentSignal.addEventListener("abort", abortFromParent, {
      once: true,
    });
  }

  const remainingMilliseconds = deadlineAt - Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abortForDeadline = (): void => {
    controller.abort(
      new HistoryEvolutionError(
        "deadline-exceeded",
        "Repository history processing exceeded its total deadline.",
      ),
    );
  };
  if (remainingMilliseconds <= 0) {
    abortForDeadline();
  } else {
    timer = setTimeout(abortForDeadline, remainingMilliseconds);
  }

  return Object.freeze({
    signal: controller.signal,
    checkpoint(): void {
      parentSignal.throwIfAborted();
      if (!controller.signal.aborted && Date.now() >= deadlineAt) {
        abortForDeadline();
      }
      controller.signal.throwIfAborted();
    },
    dispose(): void {
      if (timer !== undefined) clearTimeout(timer);
      parentSignal.removeEventListener("abort", abortFromParent);
    },
  });
}

function historyRepositoryIdentity(repositoryUrl: string): string {
  try {
    const parsed = new URL(repositoryUrl);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    const match =
      /^(?:[^@\s]+@)?(\[[^\]]+\]|[^:\s]+):([A-Za-z0-9._/-]+)$/u.exec(
        repositoryUrl,
      );
    if (match === null) throw fixedTaskFailure();
    const host = match[1]!;
    const repositoryPath = match[2]!.replace(/^\/+/u, "");
    return `ssh://${host}/${repositoryPath}`;
  }
}

function remoteSourceProvenance(
  model: CityModel,
  request: RemoteImportRequest,
  credential: BoundCredentialProfile | undefined,
  revision: string,
  repositoryUrl: string,
): SourceRepositoryProvenance {
  const repository = model.repositories[0];
  if (repository === undefined || model.repositories.length !== 1) {
    throw new TypeError(
      "Remote source provenance requires exactly one repository.",
    );
  }
  return Object.freeze({
    repositoryId: repository.id,
    provider:
      request.source.kind === "github"
        ? "github"
        : credential?.provider === "azure-devops"
          ? "azure-devops"
          : "generic-git",
    revision: Object.freeze({
      kind: "commit",
      value: revision,
    }),
    repositoryUrl,
  });
}

function attachRemoteSourceProvenance(
  model: CityModel,
  create: () => SourceRepositoryProvenance,
): CityModel {
  if (model.repositories.length !== 1) return model;
  return attachSourceProvenance(model, [create()]);
}

function genericHistoryRef(request: RemoteImportRequest): string | undefined {
  if (request.history?.mode === "tag-range") {
    return `refs/tags/${request.history.newestTagName}`;
  }
  const ref = request.source.ref;
  if (ref === undefined || request.source.kind === "git") return ref;
  if (ref.startsWith("heads/")) {
    return `refs/heads/${ref.slice("heads/".length)}`;
  }
  if (ref.startsWith("tags/")) {
    return `refs/tags/${ref.slice("tags/".length)}`;
  }
  return ref;
}

async function analyze(
  request: RemoteImportRequest,
  context: JobTaskContext,
  staging: ImportStagingDirectory,
  credentialBinding: BoundCredentialProfile | undefined,
  dependencies: RemoteImportDependencies | undefined,
  retainSource: boolean,
): Promise<RemoteImportAnalysisOutput> {
  const options = analyzerOptions(request, context.signal);
  const repositoryRequest = {
    repositoryUrl: request.source.repositoryUrl,
    ...(request.source.ref === undefined
      ? {}
      : { ref: request.source.ref }),
  };
  if (request.history !== undefined) {
    const implementation =
      dependencies?.analyzeGenericGitHistory ??
      analyzeGenericGitHistory;
    const selection =
      request.history.totalDeadlineMs === undefined &&
      request.analysis?.timeoutMs !== undefined
        ? Object.freeze({
            ...request.history,
            totalDeadlineMs: request.analysis.timeoutMs,
          })
        : request.history;
    const historyDeadlineAt =
      Date.now() +
      (selection.totalDeadlineMs ??
        HISTORY_SELECTION_LIMITS.defaultTotalDeadlineMs);
    const historyCredentialProvider =
      credentialBinding === undefined
        ? undefined
        : credentialBinding.provider === "github"
          ? githubHistoryCredentialProvider(credentialBinding)
          : genericGitCredentialProvider(credentialBinding);
    const resolvedHistoryRef = genericHistoryRef(request);
    const result: GenericGitHistoryAnalysisResult =
      await implementation(
        {
          repositoryUrl: request.source.repositoryUrl,
          repositoryIdentity: historyRepositoryIdentity(
            request.source.repositoryUrl,
          ),
          ...(resolvedHistoryRef === undefined
            ? {}
            : { ref: resolvedHistoryRef }),
          selection,
          signal: context.signal,
        },
        {
          ...(request.identity === undefined
            ? {}
            : { identity: request.identity }),
          ...(request.analysis === undefined
            ? {}
            : {
                analysisOptions: {
                  ...(request.analysis.maxRetainedFiles === undefined
                    ? {}
                    : {
                        maxRetainedFiles:
                          request.analysis.maxRetainedFiles,
                      }),
                  ...(request.analysis.maxFileBytes === undefined
                    ? {}
                    : { maxFileBytes: request.analysis.maxFileBytes }),
                  ...(request.analysis.maxTotalBytes === undefined
                    ? {}
                    : { maxTotalBytes: request.analysis.maxTotalBytes }),
                },
              }),
          ...(retainSource ? { retainSourceSnapshot: true } : {}),
        },
        {
          ...(dependencies?.semanticCache === undefined
            ? {}
            : { semanticCache: dependencies.semanticCache }),
          git: {
            ...(request.source.kind === "github" &&
            credentialBinding === undefined
              ? { isolateCredentials: true }
              : {}),
            ...(historyCredentialProvider === undefined
              ? {}
              : { credentialProvider: historyCredentialProvider }),
            temporaryWorkspaceOptions: {
              trustedPrivateParent: {
                directory: staging.directory,
                windowsAclProtection:
                  GENERIC_GIT_PRESECURED_WINDOWS_ACL,
                canonicalAncestryProtection:
                  GENERIC_GIT_PRESECURED_CANONICAL_ANCESTRY,
              },
            },
          },
        },
      );
    return Object.freeze({
      model: attachRemoteSourceProvenance(result.model, () =>
        remoteSourceProvenance(
          result.model,
          request,
          credentialBinding,
          result.tipSha,
          historyRepositoryIdentity(request.source.repositoryUrl),
        ),
      ),
      ...(result.sourceSnapshot === undefined
        ? {}
        : { sourceSnapshot: result.sourceSnapshot }),
      evolution: result.evolution.bundle,
      ...(result.evolution.preparedSerialization === undefined
        ? {}
        : {
            preparedEvolution:
              result.evolution.preparedSerialization,
          }),
      historyDeadlineAt,
    });
  }
  if (request.source.kind === "github") {
    const implementation =
      dependencies?.analyzePublicGitHubRepository ??
      analyzePublicGitHubRepository;
    const result =
      credentialBinding === undefined
        ? await implementation(repositoryRequest, options)
        : credentialBinding.provider !== "github"
          ? (() => {
              throw fixedTaskFailure();
            })()
          : await implementation(repositoryRequest, options, {
              credentialProvider:
                githubCredentialProvider(credentialBinding),
            });
    return Object.freeze({
      model: attachRemoteSourceProvenance(result.model, () =>
        remoteSourceProvenance(
          result.model,
          request,
          credentialBinding,
          result.commitSha,
          result.canonicalRepositoryUrl,
        ),
      ),
      ...(retainSource && result.sourceSnapshot !== undefined
        ? { sourceSnapshot: result.sourceSnapshot }
        : {}),
    });
  }
  const implementation =
    dependencies?.analyzeGenericGitRepository ??
    analyzeGenericGitRepository;
  if (credentialBinding?.provider === "github") {
    throw fixedTaskFailure();
  }
  const result = await implementation(repositoryRequest, options, {
    ...(credentialBinding === undefined
      ? {}
      : {
          credentialProvider:
            genericGitCredentialProvider(credentialBinding),
        }),
    temporaryWorkspaceOptions: {
      trustedPrivateParent: {
        directory: staging.directory,
        windowsAclProtection:
          GENERIC_GIT_PRESECURED_WINDOWS_ACL,
        canonicalAncestryProtection:
          GENERIC_GIT_PRESECURED_CANONICAL_ANCESTRY,
      },
    },
  });
  return Object.freeze({
    model: attachRemoteSourceProvenance(result.model, () =>
      remoteSourceProvenance(
        result.model,
        request,
        credentialBinding,
        result.commitSha,
        historyRepositoryIdentity(request.source.repositoryUrl),
      ),
    ),
    ...(retainSource && result.sourceSnapshot !== undefined
      ? { sourceSnapshot: result.sourceSnapshot }
      : {}),
  });
}

function unavailableCredentialProfile(): RemoteImportRequestError {
  return new RemoteImportRequestError(
    [
      Object.freeze({
        code: "source-not-allowed",
        path: "$.source.credentialProfileId",
        message:
          "This credential profile is not available for the requested source.",
      }),
    ],
    403,
  );
}

function credentialBinding(
  request: RemoteImportRequest,
  profiles: CredentialProfileRegistry,
): BoundCredentialProfile | undefined {
  const profileId = request.source.credentialProfileId;
  if (profileId === undefined) return undefined;
  if (request.source.kind === "github") {
    const binding = profiles.bind(
      profileId,
      "github",
      request.source.repositoryUrl,
    );
    if (binding === undefined || binding.provider !== "github") {
      throw unavailableCredentialProfile();
    }
    return binding;
  }
  let scheme: "https" | "ssh";
  try {
    scheme = genericGitRepositoryOrigin(
      request.source.repositoryUrl,
    ).scheme;
  } catch {
    throw unavailableCredentialProfile();
  }
  if (scheme !== "https") {
    throw unavailableCredentialProfile();
  }
  const binding = profiles.bind(
    profileId,
    "git",
    request.source.repositoryUrl,
  );
  if (
    binding === undefined ||
    (
      binding.provider !== "azure-devops" &&
      binding.provider !== "generic-https"
    )
  ) {
    throw unavailableCredentialProfile();
  }
  return binding;
}

export async function enqueueRemoteImport(
  request: RemoteImportRequest,
  runtime: RemoteImportRuntime,
): Promise<JobRecord> {
  try {
    runtime.policy.assertAllowed(request);
  } catch (error) {
    if (
      error instanceof RemoteImportRequestError &&
      request.source.credentialProfileId !== undefined &&
      error.fields.length > 0 &&
      error.fields.every(
        ({ path }) => path === "$.source.repositoryUrl",
      )
    ) {
      throw unavailableCredentialProfile();
    }
    throw error;
  }
  const boundCredential = credentialBinding(
    request,
    runtime.credentialProfiles,
  );
  let staging: ImportStagingDirectory;
  try {
    staging = await runtime.artifacts.createStagingDirectory();
  } catch {
    throw new Error("Repository import staging could not be created.");
  }
  const cleanupStaging = stagingCleanup(runtime.artifacts, staging);

  try {
    return await runtime.jobs.enqueue(
      IMPORT_JOB_KIND,
      async (context) => {
        try {
          context.signal.throwIfAborted();
          await context.report({
            phase: "analyzing-repository",
            current: 0,
            total: IMPORT_PROGRESS_TOTAL,
          });
          let analyzed: RemoteImportAnalysisOutput;
          try {
            analyzed = await analyze(
              request,
              context,
              staging,
              boundCredential,
              runtime.dependencies,
              runtime.sourceRetention === "retain",
            );
          } catch (error) {
            throw analysisTaskFailure(error);
          }
          const deadline =
            analyzed.historyDeadlineAt === undefined
              ? undefined
              : historyDeadlineScope(
                  analyzed.historyDeadlineAt,
                  context.signal,
                );
          try {
            const operationSignal =
              deadline?.signal ?? context.signal;
            const operationCheckpoint =
              deadline?.checkpoint ??
              (() => context.signal.throwIfAborted());
            const sourceWork = {
              signal: operationSignal,
              checkpoint: operationCheckpoint,
            };
            operationCheckpoint();
            await context.report({
              phase:
                analyzed.evolution === undefined
                  ? "publishing-city-model"
                  : "publishing-history",
              current: 1,
              total: IMPORT_PROGRESS_TOTAL,
            });
            operationCheckpoint();
            const repository = analyzed.model.repositories[0];
            const publishedSource =
              runtime.sourceRetention === "retain" &&
              runtime.sources !== undefined &&
              analyzed.sourceSnapshot !== undefined &&
              repository !== undefined
                ? await runtime.sources.publish(
                    context.id,
                    createSourceArtifact(
                      analyzed.model,
                      [
                        {
                          repositoryId: repository.id,
                          snapshot: analyzed.sourceSnapshot,
                        },
                      ],
                      sourceWork,
                    ),
                    sourceWork,
                  )
                : undefined;
            operationCheckpoint();
            const publishedHistory =
              analyzed.evolution === undefined
                ? undefined
                : await runtime.artifacts.publishHistoryArtifacts(
                    context.id,
                    analyzed.model,
                    analyzed.evolution,
                    {
                      signal: operationSignal,
                      checkpoint: operationCheckpoint,
                      ...(analyzed.preparedEvolution === undefined
                        ? {}
                        : {
                            preparedSerialization:
                              analyzed.preparedEvolution,
                          }),
                    },
                  );
            if (publishedHistory === undefined) {
              await runtime.artifacts.publishCityModel(
                context.id,
                analyzed.model,
              );
            }
            operationCheckpoint();
            await context.report({
              phase: "cleaning-temporary-data",
              current: 2,
              total: IMPORT_PROGRESS_TOTAL,
            });
            operationCheckpoint();
            await cleanupStaging({
              signal: operationSignal,
              checkpoint: operationCheckpoint,
            });
            operationCheckpoint();
            await context.report({
              phase: "ready",
              current: IMPORT_PROGRESS_TOTAL,
              total: IMPORT_PROGRESS_TOTAL,
            });
            operationCheckpoint();
            return {
              kind: "city-model",
              artifactToken: context.id,
              artifactUrl:
                `/api/v1/artifacts/${context.id}/city-model.json`,
              source:
                publishedSource === undefined
                  ? { availability: "disabled" as const }
                  : {
                      availability: "retained" as const,
                      artifactUrl:
                        `/api/v1/artifacts/${context.id}/source`,
                      size: publishedSource.size,
                      sha256: publishedSource.sha256,
                      indexSha256: publishedSource.indexSha256,
                    },
              ...(publishedHistory === undefined
                ? {}
                : {
                    evolution: {
                      artifactUrl:
                        `/api/v1/artifacts/${context.id}/evolution.json`,
                      size: publishedHistory.evolution.size,
                      sha256:
                        publishedHistory.evolution.sha256,
                    },
                  }),
            };
          } finally {
            deadline?.dispose();
          }
        } catch (error) {
          try {
            await cleanupStaging();
          } catch {
            throw fixedTaskFailure();
          }
          if (error instanceof JobTaskFailure) throw error;
          if (
            error instanceof HistoryEvolutionError &&
            error.code === "deadline-exceeded"
          ) {
            throw analysisTaskFailure(error);
          }
          throw fixedTaskFailure();
        }
      },
      {
        finalize: async (record) => {
          await allCleanupOperations([
            runtime.artifacts.cleanupStagingDirectory(staging.token),
            ...(record.state === "completed"
              ? []
              : [
                  runtime.artifacts.cleanupCityModelArtifact(
                    record.id,
                  ),
                  ...(runtime.sources === undefined
                    ? []
                    : [runtime.sources.cleanup(record.id)]),
                ]),
          ]);
        },
        rollback: async (record) => {
          await allCleanupOperations([
            runtime.artifacts.cleanupCityModelArtifact(record.id),
            ...(runtime.sources === undefined
              ? []
              : [runtime.sources.cleanup(record.id)]),
            runtime.artifacts.cleanupStagingDirectory(staging.token),
          ]);
        },
      },
    );
  } catch {
    await cleanupStaging().catch(() => undefined);
    throw new Error("Repository import could not be queued.");
  }
}
