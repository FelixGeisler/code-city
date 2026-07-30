import net from "node:net";

import {
  analyzeGenericGitRepository,
  analyzePublicGitHubRepository,
  DEFAULT_SNAPSHOT_LIMITS,
  genericGitRepositoryOrigin,
  GENERIC_GIT_PRESECURED_CANONICAL_ANCESTRY,
  GENERIC_GIT_PRESECURED_WINDOWS_ACL,
  GenericGitSnapshotError,
  GitHubSnapshotError,
  SnapshotDeadlineError,
  SnapshotLimitError,
  SnapshotPathError,
  SnapshotPolicyError,
  validateGenericGitRef,
  validateGenericGitRepositoryUrl,
  validatePublicGitHubRef,
  validatePublicGitHubRepositoryUrl,
  type LocalAnalysisOptions,
} from "../../../packages/analyzer/src/index.js";
import { normalizeAssetRelativePath } from "../../../packages/core/src/index.js";
import type { CityModel } from "../../../packages/core/src/index.js";

import {
  type JobRecord,
  type JobTaskContext,
  JobTaskFailure,
  PersistentJobQueue,
} from "./job-queue.js";
import {
  ImportArtifactStore,
  type ImportStagingDirectory,
} from "./import-artifacts.js";

const ROOT_KEYS = ["analysis", "identity", "source"] as const;
const SOURCE_KEYS = [
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
const PROTOTYPE_LIKE_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);
const COMMIT_SHA = /^[0-9a-f]{40}$/iu;
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
  readonly identity?: RemoteImportIdentity;
  readonly analysis?: RemoteImportAnalysis;
}

export interface RemoteImportDependencies {
  readonly analyzePublicGitHubRepository?: typeof analyzePublicGitHubRepository;
  readonly analyzeGenericGitRepository?: typeof analyzeGenericGitRepository;
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
  }

  public assertAllowed(request: RemoteImportRequest): void {
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
  readonly policy: RemoteImportPolicy;
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
  try {
    new ExactJsonScanner(text).scan();
    return parseRemoteImportRequest(JSON.parse(text) as unknown);
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

function parseIdentity(value: unknown): RemoteImportIdentity {
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

function parseAnalysis(value: unknown): RemoteImportAnalysis {
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
  return Object.freeze({
    kind,
    repositoryUrl,
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
    const identity = Object.hasOwn(object, "identity")
      ? parseIdentity(object["identity"])
      : undefined;
    const analysis = Object.hasOwn(object, "analysis")
      ? parseAnalysis(object["analysis"])
      : undefined;
    return Object.freeze({
      source,
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

function analysisTaskFailure(error: unknown): JobTaskFailure {
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
): () => Promise<void> {
  let cleaned = false;
  let active: Promise<void> | undefined;
  return () => {
    if (cleaned) return Promise.resolve();
    if (active !== undefined) return active;
    active = artifacts.cleanupStagingDirectory(staging.token).then(() => {
      cleaned = true;
    });
    void active.finally(() => {
      active = undefined;
    }).catch(() => undefined);
    return active;
  };
}

async function analyze(
  request: RemoteImportRequest,
  context: JobTaskContext,
  staging: ImportStagingDirectory,
  dependencies: RemoteImportDependencies | undefined,
): Promise<CityModel> {
  const options = analyzerOptions(request, context.signal);
  const repositoryRequest = {
    repositoryUrl: request.source.repositoryUrl,
    ...(request.source.ref === undefined
      ? {}
      : { ref: request.source.ref }),
  };
  if (request.source.kind === "github") {
    const implementation =
      dependencies?.analyzePublicGitHubRepository ??
      analyzePublicGitHubRepository;
    return (await implementation(repositoryRequest, options)).model;
  }
  const implementation =
    dependencies?.analyzeGenericGitRepository ??
    analyzeGenericGitRepository;
  return (
    await implementation(repositoryRequest, options, {
      temporaryWorkspaceOptions: {
        trustedPrivateParent: {
          directory: staging.directory,
          windowsAclProtection:
            GENERIC_GIT_PRESECURED_WINDOWS_ACL,
          canonicalAncestryProtection:
            GENERIC_GIT_PRESECURED_CANONICAL_ANCESTRY,
        },
      },
    })
  ).model;
}

export async function enqueueRemoteImport(
  request: RemoteImportRequest,
  runtime: RemoteImportRuntime,
): Promise<JobRecord> {
  runtime.policy.assertAllowed(request);
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
          let model: CityModel;
          try {
            model = await analyze(
              request,
              context,
              staging,
              runtime.dependencies,
            );
          } catch (error) {
            throw analysisTaskFailure(error);
          }
          context.signal.throwIfAborted();
          await context.report({
            phase: "publishing-city-model",
            current: 1,
            total: IMPORT_PROGRESS_TOTAL,
          });
          await runtime.artifacts.publishCityModel(context.id, model);
          context.signal.throwIfAborted();
          await context.report({
            phase: "cleaning-temporary-data",
            current: 2,
            total: IMPORT_PROGRESS_TOTAL,
          });
          await cleanupStaging();
          context.signal.throwIfAborted();
          await context.report({
            phase: "ready",
            current: IMPORT_PROGRESS_TOTAL,
            total: IMPORT_PROGRESS_TOTAL,
          });
          return {
            kind: "city-model",
            artifactToken: context.id,
            artifactUrl:
              `/api/v1/artifacts/${context.id}/city-model.json`,
          };
        } catch (error) {
          try {
            await cleanupStaging();
          } catch {
            throw fixedTaskFailure();
          }
          if (error instanceof JobTaskFailure) throw error;
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
                ]),
          ]);
        },
        rollback: async (record) => {
          await allCleanupOperations([
            runtime.artifacts.cleanupCityModelArtifact(record.id),
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
