import { EVOLUTION_BUNDLE_LIMITS } from "../../../packages/core/src/evolution.js";

const API_RESPONSE_MAX_BYTES = 256 * 1024;
const SOURCE_RESPONSE_MAX_BYTES = 16 * 1024 * 1024 * 6 + 64 * 1024;
const API_REQUEST_DEADLINE_MS = 30_000;
const API_UPLOAD_DEADLINE_MS = 11 * 60_000;
const API_RESULT_REMOVAL_DEADLINE_MS = 31 * 60_000;
const EVOLUTION_ARTIFACT_DEADLINE_MS = 31 * 60_000;
const MAXIMUM_ERROR_FIELDS = 64;
const MAXIMUM_TEXT_CHARACTERS = 2_048;
const MAXIMUM_EVOLUTION_ARTIFACT_BYTES =
  EVOLUTION_BUNDLE_LIMITS.serializedBytes;
const MAXIMUM_EVOLUTION_ARTIFACT_MEBIBYTES =
  MAXIMUM_EVOLUTION_ARTIFACT_BYTES / (1024 * 1024);
const MAXIMUM_SOURCE_ARTIFACT_BYTES = 128 * 1024 * 1024;

export const IMPORT_JOB_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PROFILE_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;
const ERROR_CODE_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;
const AUTHORIZATION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const AI_PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;
const AI_CONTEXT_DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const AI_BUILDING_ID_PATTERN = /^[a-z0-9-]+:[0-9a-f]{16}$/u;
const AI_GUIDANCE_MINIMUM_TIMEOUT_MS = 1_000;
const AI_GUIDANCE_MAXIMUM_TIMEOUT_MS = 60_000;
const AI_GUIDANCE_ROUND_TRIP_OVERHEAD_MS = 10_000;
const AI_GUIDANCE_APPROVAL_GRANT_TTL_MS = 2 * 60_000;
const AI_GUIDANCE_MAXIMUM_SOURCE_BYTES = 128 * 1024;
const AI_GUIDANCE_MAXIMUM_RELATED_BUILDINGS = 25_000;
const FIELD_PATH_PATTERN =
  /^\$(?:\.[A-Za-z][A-Za-z0-9]*|\[[0-9]+\])*$/u;
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Cs}]/u;

export type ImportAuthorizationMode =
  | "shared-secret"
  | "trusted-network";

export interface ImportAuthorizationStatus {
  readonly mode: ImportAuthorizationMode;
  readonly required: boolean;
  readonly authenticated: boolean;
}

export interface ViewerAiGuidanceProvider {
  readonly id: string;
  readonly label: string;
}

export interface ViewerAiGuidanceProviders {
  readonly enabled: boolean;
  readonly providers: readonly ViewerAiGuidanceProvider[];
}

export type ViewerAiGuidanceContext =
  | Readonly<{ version: "codecity.ai-context/1"; kind: "file"; buildingId: string }>
  | Readonly<{ version: "codecity.ai-context/1"; kind: "type" | "callable"; buildingId: string; stableId: string }>
  | Readonly<{ version: "codecity.ai-context/1"; kind: "dependency"; buildingId: string; dependencyId: string }>
  | Readonly<{ version: "codecity.ai-context/1"; kind: "smell"; buildingId: string; findingId: string; ruleId: string }>;

export interface ViewerAiGuidanceLineRange {
  readonly startLine: number;
  readonly endLine: number;
  readonly startColumn?: never;
  readonly endColumn?: never;
}
export interface ViewerAiGuidanceColumnRange {
  readonly startLine: number;
  readonly endLine: number;
  readonly startColumn: number;
  readonly endColumn: number;
}
export type ViewerAiGuidanceRange =
  | ViewerAiGuidanceLineRange
  | ViewerAiGuidanceColumnRange;
export type ViewerAiGuidanceResolvedContext =
  | Readonly<{ version: "codecity.ai-context/1"; kind: "file"; buildingId: string; label: string; range: ViewerAiGuidanceLineRange }>
  | Readonly<{ version: "codecity.ai-context/1"; kind: "type" | "callable"; buildingId: string; stableId: string; name: string; constructKind: string; label: string; range: ViewerAiGuidanceColumnRange }>
  | Readonly<{ version: "codecity.ai-context/1"; kind: "smell"; buildingId: string; findingId: string; ruleId: string; label: string; range: ViewerAiGuidanceLineRange; evidence: Readonly<Record<string, unknown>> }>;

interface ViewerAiGuidanceLimits { readonly timeoutMs: number; readonly maximumSourceBytes: number; }
export type ViewerAiGuidancePreview = Readonly<{ preview:
  | Readonly<{ enabled: false; availability: "disabled"; limits: ViewerAiGuidanceLimits; privacy: "no-prompt-storage" }>
  | Readonly<{ enabled: true; availability: "unavailable"; provider: ViewerAiGuidanceProvider; context: ViewerAiGuidanceContext; reason: string; limits: ViewerAiGuidanceLimits; privacy: "no-prompt-storage" }>
  | Readonly<{
      enabled: true;
      availability: "available";
      provider: ViewerAiGuidanceProvider;
      transmission: {
      readonly version: 1;
      readonly task: "source-guidance";
      readonly providerId: string;
      readonly context: ViewerAiGuidanceResolvedContext;
      readonly contextDigest: string;
      readonly findingDigest?: string;
      readonly source: {
        readonly path: string;
        readonly language: string;
        readonly text: string;
        readonly lines: ViewerAiGuidanceRange;
      };
      readonly findings: {
        readonly sloc: number;
        readonly maximumComplexity: number;
        readonly decisionLoad: number;
      };
    };
    readonly limits: { readonly timeoutMs: number; readonly maximumSourceBytes: number };
    readonly privacy: "no-prompt-storage";
    readonly grant: string;
  }> }>;

export interface ViewerAiGuidanceResult {
  readonly result: {
    readonly provider: ViewerAiGuidanceProvider;
    readonly context: ViewerAiGuidanceResolvedContext;
    readonly contextDigest: string;
    readonly findingDigest?: string;
    readonly suggestions: readonly {
      readonly title: string;
      readonly detail: string;
      readonly citation: { readonly path: string; readonly startLine: number; readonly endLine: number };
    }[];
  };
}

export type ImportCredentialProvider =
  | "github"
  | "azure-devops"
  | "generic-https";

export interface ImportCredentialProfile {
  readonly id: string;
  readonly label: string;
  readonly provider: ImportCredentialProvider;
}

export type ImportRevision =
  | {
      readonly kind: "branch" | "tag";
      readonly name: string;
    }
  | {
      readonly kind: "commit";
      readonly sha: string;
    };

export interface ImportIdentityOptions {
  readonly title?: string;
  readonly version?: string;
  readonly logo?: string;
}

export interface ImportAnalysisOptions {
  readonly maxRetainedFiles?: number;
  readonly maxFileBytes?: number;
  readonly maxTotalBytes?: number;
  readonly timeoutMs?: number;
}

export interface RemoteImportHistoryBounds {
  readonly sampleEvery?: number;
  readonly totalDeadlineMs?: number;
  readonly maxAggregateChangedPaths?: number;
  readonly maxAggregateChangedPathBytes?: number;
  readonly maxAggregateSemanticBytes?: number;
  readonly maxAggregateTreeEntries?: number;
  readonly maxUniqueLineages?: number;
  readonly maxEvolutionOutputBytes?: number;
}

export type RemoteImportHistorySelection =
  | (RemoteImportHistoryBounds & {
      readonly mode: "commit-count";
      readonly commitCount: number;
    })
  | (RemoteImportHistoryBounds & {
      readonly mode: "date-range";
      readonly fromInclusive: string;
      readonly toInclusive: string;
      readonly maxCommits: number;
    })
  | (RemoteImportHistoryBounds & {
      readonly mode: "tag-range";
      readonly oldestTagName: string;
      readonly newestTagName: string;
      readonly maxCommits: number;
    });

export interface RemoteImportSubmission {
  readonly source: {
    readonly kind: "github" | "git";
    readonly repositoryUrl: string;
    readonly credentialProfileId?: string;
    readonly revision?: ImportRevision;
  };
  readonly history?: RemoteImportHistorySelection;
  readonly identity?: ImportIdentityOptions;
  readonly analysis?: ImportAnalysisOptions;
}

export type UploadImportSubmission =
  | {
      readonly source: {
        readonly kind: "city-model";
        readonly sizeBytes: number;
      };
    }
  | {
      readonly source: {
        readonly kind: "repository-zip";
        readonly sizeBytes: number;
        readonly repositoryName: string;
        readonly rootMode: "single-directory" | "archive-root";
      };
      readonly identity?: ImportIdentityOptions;
      readonly analysis?: ImportAnalysisOptions;
    };

export type ImportJobState =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface ImportJobProgress {
  readonly phase: string;
  readonly current?: number;
  readonly total?: number;
}

export type ImportJobErrorCode =
  | "analysis-failed"
  | "cancelled"
  | "city-model-invalid"
  | "deadline-exceeded"
  | "failed"
  | "import-limit-exceeded"
  | "interrupted"
  | "repository-content-rejected"
  | "repository-unavailable"
  | "revision-unavailable";

export interface ImportJobError {
  readonly code: ImportJobErrorCode;
  readonly message: string;
}

export interface ImportJobResult {
  readonly kind: "city-model";
  readonly artifactToken: string;
  readonly artifactUrl: string;
  readonly evolution?: {
    readonly artifactUrl: string;
    readonly size: number;
    readonly sha256: string;
  };
  readonly source?:
    | {
        readonly availability: "disabled";
      }
    | {
        readonly availability: "not-captured";
      }
    | {
        readonly availability: "retained";
        readonly artifactUrl: string;
        readonly size: number;
        readonly sha256: string;
        readonly indexSha256: string;
      };
}

export interface ImportJob {
  readonly id: string;
  readonly kind: "project-import";
  readonly state: ImportJobState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly progress?: ImportJobProgress;
  readonly error?: ImportJobError;
  readonly result?: ImportJobResult;
}

export interface ImportUploadReservation {
  readonly token: string;
  readonly uploadUrl: string;
  readonly mediaType: "application/json" | "application/zip";
  readonly sizeBytes: number;
  readonly expiresAt: string;
}

export interface ImportFieldError {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export type ImportApiErrorKind =
  | "aborted"
  | "deadline"
  | "http"
  | "network"
  | "protocol";

export class ImportApiError extends Error {
  public override readonly name = "ImportApiError";

  public constructor(
    public readonly kind: ImportApiErrorKind,
    message: string,
    public readonly details: {
      readonly status?: number;
      readonly code?: string;
      readonly fields?: readonly ImportFieldError[];
      readonly retryAfterMs?: number;
    } = {},
  ) {
    super(message);
  }

  public get retryable(): boolean {
    if (this.kind === "network" || this.kind === "deadline") return true;
    const status = this.details.status;
    return (
      this.kind === "http" &&
      status !== undefined &&
      (status === 408 || status === 429 || status >= 500)
    );
  }
}

export type ImportApiFetch = (
  input: string | URL,
  init: RequestInit,
) => Promise<Response>;

export interface ViewerImportApiClientOptions {
  readonly fetch?: ImportApiFetch;
  readonly requestDeadlineMs?: number;
  readonly uploadDeadlineMs?: number;
  readonly removalDeadlineMs?: number;
  readonly scheduleDeadline?: (
    callback: () => void,
    milliseconds: number,
  ) => unknown;
  readonly clearDeadline?: (handle: unknown) => void;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function exactObject(
  value: unknown,
  keys: readonly string[],
  description: string,
): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw protocolError(`${description} is not a JSON object.`);
  }
  const object = value as Record<string, unknown>;
  const actual = Object.keys(object).sort(compareText);
  const expected = [...keys].sort(compareText);
  if (
    actual.length !== expected.length ||
    !actual.every((key, index) => key === expected[index])
  ) {
    throw protocolError(`${description} has an invalid shape.`);
  }
  return object;
}

function safeText(
  value: unknown,
  description: string,
  maximum = MAXIMUM_TEXT_CHARACTERS,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    UNSAFE_TEXT.test(value)
  ) {
    throw protocolError(`${description} is invalid.`);
  }
  return value;
}

function safeIsoDate(value: unknown, description: string): string {
  const date = safeText(value, description, 40);
  if (Number.isNaN(Date.parse(date))) {
    throw protocolError(`${description} is invalid.`);
  }
  return date;
}

function protocolError(message: string): ImportApiError {
  return new ImportApiError("protocol", message);
}

function nonNegativeInteger(value: unknown, description: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw protocolError(`${description} is invalid.`);
  }
  return value as number;
}

function positiveInteger(value: unknown, description: string): number {
  const parsed = nonNegativeInteger(value, description);
  if (parsed === 0) throw protocolError(`${description} is invalid.`);
  return parsed;
}

function parseAiProvider(value: unknown): ViewerAiGuidanceProvider {
  const object = exactObject(value, ["id", "label"], "AI provider");
  const id = safeText(object["id"], "AI provider ID", 64);
  if (!AI_PROVIDER_ID_PATTERN.test(id)) throw protocolError("AI provider ID is invalid.");
  return Object.freeze({ id, label: safeText(object["label"], "AI provider label", 120) });
}

function parseAiGuidanceProviders(value: unknown): ViewerAiGuidanceProviders {
  const object = exactObject(value, ["enabled", "providers"], "AI provider response");
  if (typeof object["enabled"] !== "boolean" || !Array.isArray(object["providers"]) || object["providers"].length > 64) {
    throw protocolError("AI provider response is invalid.");
  }
  const providers = object["providers"].map(parseAiProvider);
  if (!object["enabled"] && providers.length !== 0) throw protocolError("Disabled AI guidance must not expose providers.");
  if (new Set(providers.map(({ id }) => id)).size !== providers.length) throw protocolError("AI provider IDs are duplicated.");
  return Object.freeze({ enabled: object["enabled"], providers: Object.freeze(providers) });
}

function parseAiLineRange(value: unknown, description: string): ViewerAiGuidanceRange {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw protocolError(`${description} is invalid.`);
  const raw = value as Record<string, unknown>;
  const hasColumns = "startColumn" in raw || "endColumn" in raw;
  const object = exactObject(value, hasColumns ? ["endColumn", "endLine", "startColumn", "startLine"] : ["endLine", "startLine"], description);
  const startLine = positiveInteger(object["startLine"], `${description} start`);
  const endLine = positiveInteger(object["endLine"], `${description} end`);
  if (endLine < startLine) throw protocolError(`${description} is invalid.`);
  if (!hasColumns) return Object.freeze({ startLine, endLine });
  const startColumn = positiveInteger(object["startColumn"], `${description} start column`);
  const endColumn = positiveInteger(object["endColumn"], `${description} end column`);
  if (endLine === startLine && endColumn < startColumn) throw protocolError(`${description} is invalid.`);
  return Object.freeze({ startLine, endLine, startColumn, endColumn });
}

function hasAiGuidanceColumns(
  range: ViewerAiGuidanceRange,
): range is ViewerAiGuidanceColumnRange {
  return range.startColumn !== undefined && range.endColumn !== undefined;
}

function parseAiContext(value: unknown): ViewerAiGuidanceContext {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw protocolError("AI context is invalid.");
  const raw = value as Record<string, unknown>;
  const version = raw["version"];
  const kind = raw["kind"];
  const buildingId = safeText(raw["buildingId"], "AI context building ID", 128);
  if (version !== "codecity.ai-context/1" || !AI_BUILDING_ID_PATTERN.test(buildingId)) throw protocolError("AI context is invalid.");
  if (kind === "file") { exactObject(value, ["buildingId", "kind", "version"], "AI file context"); return Object.freeze({ version, kind, buildingId }); }
  if (kind === "type" || kind === "callable") { const object = exactObject(value, ["buildingId", "kind", "stableId", "version"], "AI declaration context"); return Object.freeze({ version, kind, buildingId, stableId: safeText(object["stableId"], "AI context stable ID", 512) }); }
  if (kind === "dependency") { const object = exactObject(value, ["buildingId", "dependencyId", "kind", "version"], "AI dependency context"); return Object.freeze({ version, kind, buildingId, dependencyId: safeText(object["dependencyId"], "AI dependency ID", 512) }); }
  if (kind === "smell") { const object = exactObject(value, ["buildingId", "findingId", "kind", "ruleId", "version"], "AI smell context"); return Object.freeze({ version, kind, buildingId, findingId: safeText(object["findingId"], "AI finding ID", 512), ruleId: safeText(object["ruleId"], "AI smell rule ID", 128) }); }
  throw protocolError("AI context kind is invalid.");
}

function parseAiResolvedContext(value: unknown): ViewerAiGuidanceResolvedContext {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw protocolError("Resolved AI context is invalid.");
  const raw = value as Record<string, unknown>;
  const descriptor = parseAiContext(Object.fromEntries(Object.entries(raw).filter(([key]) => ["version", "kind", "buildingId", "stableId", "findingId", "ruleId"].includes(key))));
  const label = safeText(raw["label"], "AI context label", 1_000);
  const range = parseAiLineRange(raw["range"], "AI context range");
  if (descriptor.kind === "file") {
    exactObject(value, ["buildingId", "kind", "label", "range", "version"], "Resolved AI file context");
    if (hasAiGuidanceColumns(range)) throw protocolError("Resolved AI file context range is invalid.");
    return Object.freeze({ ...descriptor, label, range });
  }
  if (descriptor.kind === "type" || descriptor.kind === "callable") {
    const object = exactObject(value, ["buildingId", "constructKind", "kind", "label", "name", "range", "stableId", "version"], "Resolved AI declaration context");
    if (!hasAiGuidanceColumns(range)) throw protocolError("Resolved AI declaration context range is invalid.");
    return Object.freeze({ ...descriptor, name: safeText(object["name"], "AI declaration name", 1_000), constructKind: safeText(object["constructKind"], "AI declaration kind", 120), label, range });
  }
  if (descriptor.kind !== "smell") throw protocolError("Resolved dependency AI context cannot include source.");
  const object = exactObject(value, ["buildingId", "evidence", "findingId", "kind", "label", "range", "ruleId", "version"], "Resolved AI smell context");
  if (hasAiGuidanceColumns(range)) throw protocolError("Resolved AI smell context range is invalid.");
  if (object["evidence"] === null || typeof object["evidence"] !== "object" || Array.isArray(object["evidence"])) throw protocolError("AI smell evidence is invalid.");
  const rawEvidence = object["evidence"] as Record<string, unknown>;
  const optionalKeys = ["unit", "subject", "line", "endLine", "relatedBuildingIds"].filter((key) => rawEvidence[key] !== undefined);
  const evidence = exactObject(rawEvidence, ["kind", "label", "value", "threshold", ...optionalKeys], "AI smell evidence");
  const kind = evidence["kind"];
  if (kind !== "metric" && kind !== "executable-unit" && kind !== "dependency" && kind !== "cycle") throw protocolError("AI smell evidence kind is invalid.");
  const expectedKind = descriptor.ruleId === "high-complexity-method" ? "executable-unit" : descriptor.ruleId === "oversized-file" ? "metric" : descriptor.ruleId === "excessive-coupling" ? "dependency" : descriptor.ruleId === "dependency-cycle" ? "cycle" : undefined;
  if (expectedKind === undefined || kind !== expectedKind) throw protocolError("AI smell evidence does not match its rule.");
  const evidenceLabel = safeText(evidence["label"], "AI smell evidence label", 256);
  const evidenceValue = nonNegativeInteger(evidence["value"], "AI smell evidence value");
  const evidenceThreshold = positiveInteger(evidence["threshold"], "AI smell evidence threshold");
  if (evidenceThreshold > 1_000_000_000 || evidenceValue < evidenceThreshold) throw protocolError("AI smell evidence values are invalid.");
  const unit = evidence["unit"] === undefined ? undefined : safeText(evidence["unit"], "AI smell evidence unit", 256);
  const subject = evidence["subject"] === undefined ? undefined : safeText(evidence["subject"], "AI smell evidence subject", 256);
  const line = evidence["line"] === undefined ? undefined : positiveInteger(evidence["line"], "AI smell evidence line");
  const endLine = evidence["endLine"] === undefined ? undefined : positiveInteger(evidence["endLine"], "AI smell evidence end line");
  if (endLine !== undefined && (line === undefined || endLine < line)) throw protocolError("AI smell evidence range is invalid.");
  if (kind === "executable-unit") {
    if (line === undefined || subject === undefined || evidence["relatedBuildingIds"] !== undefined) throw protocolError("AI executable-unit smell evidence is invalid.");
    if (range.startLine !== line || range.endLine !== (endLine ?? line)) throw protocolError("AI smell evidence range does not match its context.");
  } else if (line !== undefined || endLine !== undefined || subject !== undefined) {
    throw protocolError("AI smell evidence is invalid for its kind.");
  }
  let relatedBuildingIds: readonly string[] | undefined;
  if (kind === "cycle") {
    if (!Array.isArray(evidence["relatedBuildingIds"]) || evidence["relatedBuildingIds"].length < 1 || evidence["relatedBuildingIds"].length > AI_GUIDANCE_MAXIMUM_RELATED_BUILDINGS || evidence["relatedBuildingIds"].length !== evidenceValue) throw protocolError("AI cycle evidence is invalid.");
    const parsed = evidence["relatedBuildingIds"].map((id) => safeText(id, "AI related building ID", 128));
    if (parsed.some((id) => !AI_BUILDING_ID_PATTERN.test(id)) || parsed.some((id, index) => index > 0 && parsed[index - 1]! >= id)) throw protocolError("AI related building IDs are invalid.");
    relatedBuildingIds = Object.freeze(parsed);
  } else if (evidence["relatedBuildingIds"] !== undefined) {
    throw protocolError("AI smell evidence is invalid for its kind.");
  }
  const normalizedEvidence = Object.freeze({
    kind,
    label: evidenceLabel,
    value: evidenceValue,
    threshold: evidenceThreshold,
    ...(unit === undefined ? {} : { unit }),
    ...(subject === undefined ? {} : { subject }),
    ...(line === undefined ? {} : { line }),
    ...(endLine === undefined ? {} : { endLine }),
    ...(relatedBuildingIds === undefined ? {} : { relatedBuildingIds }),
  });
  return Object.freeze({ ...descriptor, label, range, evidence: normalizedEvidence });
}

function parseAiLimits(value: unknown): ViewerAiGuidanceLimits {
  const limits = exactObject(value, ["maximumSourceBytes", "timeoutMs"], "AI limits");
  const timeoutMs = positiveInteger(limits["timeoutMs"], "AI timeout");
  const maximumSourceBytes = positiveInteger(limits["maximumSourceBytes"], "AI source limit");
  if (timeoutMs < AI_GUIDANCE_MINIMUM_TIMEOUT_MS || timeoutMs > AI_GUIDANCE_MAXIMUM_TIMEOUT_MS || maximumSourceBytes > AI_GUIDANCE_MAXIMUM_SOURCE_BYTES) throw protocolError("AI limits are invalid.");
  return Object.freeze({ timeoutMs, maximumSourceBytes });
}

function aiGuidanceRequestDeadlineMs(providerTimeoutMs: unknown): number {
  if (
    typeof providerTimeoutMs !== "number" ||
    !Number.isSafeInteger(providerTimeoutMs) ||
    providerTimeoutMs < AI_GUIDANCE_MINIMUM_TIMEOUT_MS ||
    providerTimeoutMs > AI_GUIDANCE_MAXIMUM_TIMEOUT_MS
  ) {
    throw protocolError("AI timeout is invalid.");
  }
  const deadlineMs = providerTimeoutMs + AI_GUIDANCE_ROUND_TRIP_OVERHEAD_MS;
  if (deadlineMs >= AI_GUIDANCE_APPROVAL_GRANT_TTL_MS) {
    throw protocolError("AI request deadline exceeds its approval lifetime.");
  }
  return deadlineMs;
}

function parseAiGuidancePreview(value: unknown): ViewerAiGuidancePreview {
  const root = exactObject(value, ["preview"], "AI preview response");
  if (root["preview"] === null || typeof root["preview"] !== "object" || Array.isArray(root["preview"])) throw protocolError("AI preview is invalid.");
  const raw = root["preview"] as Record<string, unknown>;
  if (raw["privacy"] !== "no-prompt-storage") throw protocolError("AI preview is invalid.");
  if (raw["enabled"] === false) {
    const preview = exactObject(raw, ["availability", "enabled", "limits", "privacy"], "Disabled AI preview");
    if (preview["availability"] !== "disabled") throw protocolError("Disabled AI preview is invalid.");
    return Object.freeze({ preview: Object.freeze({ enabled: false, availability: "disabled", limits: parseAiLimits(preview["limits"]), privacy: "no-prompt-storage" }) });
  }
  if (raw["enabled"] !== true) throw protocolError("AI preview is invalid.");
  if (raw["availability"] === "unavailable") {
    const preview = exactObject(raw, ["availability", "context", "enabled", "limits", "privacy", "provider", "reason"], "Unavailable AI preview");
    return Object.freeze({ preview: Object.freeze({ enabled: true, availability: "unavailable", provider: parseAiProvider(preview["provider"]), context: parseAiContext(preview["context"]), reason: safeText(preview["reason"], "AI context unavailability reason", 1_000), limits: parseAiLimits(preview["limits"]), privacy: "no-prompt-storage" }) });
  }
  const preview = exactObject(raw, ["availability", "enabled", "grant", "limits", "privacy", "provider", "transmission"], "AI preview");
  if (preview["availability"] !== "available" || typeof preview["grant"] !== "string" || !AUTHORIZATION_TOKEN_PATTERN.test(preview["grant"])) throw protocolError("AI preview is invalid.");
  const provider = parseAiProvider(preview["provider"]);
  const limits = parseAiLimits(preview["limits"]);
  if (preview["transmission"] === null || typeof preview["transmission"] !== "object" || Array.isArray(preview["transmission"])) throw protocolError("AI transmission is invalid.");
  const transmissionRaw = preview["transmission"] as Record<string, unknown>;
  const hasFindingDigest = "findingDigest" in transmissionRaw;
  const transmission = exactObject(transmissionRaw, hasFindingDigest ? ["context", "contextDigest", "findingDigest", "findings", "providerId", "source", "task", "version"] : ["context", "contextDigest", "findings", "providerId", "source", "task", "version"], "AI transmission");
  if (transmission["version"] !== 1 || transmission["task"] !== "source-guidance") throw protocolError("AI transmission version is invalid.");
  const providerId = safeText(transmission["providerId"], "AI transmission provider ID", 64);
  if (!AI_PROVIDER_ID_PATTERN.test(providerId) || providerId !== provider.id) throw protocolError("AI transmission provider does not match its preview.");
  const context = parseAiResolvedContext(transmission["context"]);
  const contextDigest = safeText(transmission["contextDigest"], "AI context digest", 64);
  if (!AI_CONTEXT_DIGEST_PATTERN.test(contextDigest)) throw protocolError("AI context digest is invalid.");
  const findingDigest = hasFindingDigest ? safeText(transmission["findingDigest"], "AI finding digest", 64) : undefined;
  if ((findingDigest !== undefined && !AI_CONTEXT_DIGEST_PATTERN.test(findingDigest)) || (context.kind === "smell") !== (findingDigest !== undefined)) throw protocolError("AI finding digest is invalid.");
  const source = exactObject(transmission["source"], ["language", "lines", "path", "text"], "AI transmission source");
  const findings = exactObject(transmission["findings"], ["decisionLoad", "maximumComplexity", "sloc"], "AI findings");
  const lines = parseAiLineRange(source["lines"], "AI source range");
  if (JSON.stringify(lines) !== JSON.stringify(context.range)) throw protocolError("AI source range does not match its context.");
  if (typeof source["text"] !== "string" || new TextEncoder().encode(source["text"]).byteLength > limits.maximumSourceBytes) throw protocolError("AI source text exceeds its advertised limit.");
  return Object.freeze({ preview: Object.freeze({
    enabled: true,
    availability: "available",
    provider,
    transmission: Object.freeze({
      version: 1,
      task: "source-guidance",
      providerId,
      context,
      contextDigest,
      ...(findingDigest === undefined ? {} : { findingDigest }),
      source: Object.freeze({
        path: safeText(source["path"], "AI source path", 4_096),
        language: safeText(source["language"], "AI source language", 120),
        text: source["text"],
        lines,
      }),
      findings: Object.freeze({
        sloc: nonNegativeInteger(findings["sloc"], "AI SLOC"),
        maximumComplexity: nonNegativeInteger(findings["maximumComplexity"], "AI maximum complexity"),
        decisionLoad: nonNegativeInteger(findings["decisionLoad"], "AI decision load"),
      }),
    }),
    limits,
    privacy: "no-prompt-storage",
    grant: preview["grant"],
  }) });
}

function parseAiGuidanceResult(value: unknown): ViewerAiGuidanceResult {
  const root = exactObject(value, ["result"], "AI guidance response");
  if (root["result"] === null || typeof root["result"] !== "object" || Array.isArray(root["result"])) throw protocolError("AI guidance result is invalid.");
  const raw = root["result"] as Record<string, unknown>;
  const hasFindingDigest = "findingDigest" in raw;
  const result = exactObject(raw, hasFindingDigest ? ["context", "contextDigest", "findingDigest", "provider", "suggestions"] : ["context", "contextDigest", "provider", "suggestions"], "AI guidance result");
  const context = parseAiResolvedContext(result["context"]);
  const contextDigest = safeText(result["contextDigest"], "AI context digest", 64);
  if (!AI_CONTEXT_DIGEST_PATTERN.test(contextDigest)) throw protocolError("AI context digest is invalid.");
  const findingDigest = hasFindingDigest ? safeText(result["findingDigest"], "AI finding digest", 64) : undefined;
  if ((findingDigest !== undefined && !AI_CONTEXT_DIGEST_PATTERN.test(findingDigest)) || (context.kind === "smell") !== (findingDigest !== undefined)) throw protocolError("AI finding digest is invalid.");
  if (!Array.isArray(result["suggestions"]) || result["suggestions"].length > 20) throw protocolError("AI suggestions are invalid.");
  const suggestions = result["suggestions"].map((value) => {
    const suggestion = exactObject(value, ["citation", "detail", "title"], "AI suggestion");
    const citation = exactObject(suggestion["citation"], ["endLine", "path", "startLine"], "AI suggestion citation");
    const range = parseAiLineRange({ startLine: citation["startLine"], endLine: citation["endLine"] }, "AI suggestion range");
    return Object.freeze({
      title: safeText(suggestion["title"], "AI suggestion title", 500),
      detail: safeText(suggestion["detail"], "AI suggestion detail", 8_000),
      citation: Object.freeze({ path: safeText(citation["path"], "AI citation path", 4_096), ...range }),
    });
  });
  return Object.freeze({ result: Object.freeze({ provider: parseAiProvider(result["provider"]), context, contextDigest, ...(findingDigest === undefined ? {} : { findingDigest }), suggestions: Object.freeze(suggestions) }) });
}

function evolutionArtifactTooLargeFailure(): ImportApiError {
  return protocolError(
    `Evolution artifact exceeds the browser-safe ${MAXIMUM_EVOLUTION_ARTIFACT_MEBIBYTES} MiB limit. Re-import with fewer history frames or a lower maxEvolutionOutputBytes.`,
  );
}

function parseAuthorizationStatus(value: unknown): ImportAuthorizationStatus {
  const object = exactObject(
    value,
    ["authenticated", "mode", "required"],
    "Authorization status",
  );
  const mode = object["mode"];
  const required = object["required"];
  const authenticated = object["authenticated"];
  if (
    (mode !== "shared-secret" && mode !== "trusted-network") ||
    typeof required !== "boolean" ||
    typeof authenticated !== "boolean" ||
    (mode === "shared-secret" && !required) ||
    (mode === "trusted-network" && (required || authenticated))
  ) {
    throw protocolError("Authorization status is inconsistent.");
  }
  return Object.freeze({ mode, required, authenticated });
}

export function parseAuthorizationResponse(
  value: unknown,
): ImportAuthorizationStatus {
  const root = exactObject(
    value,
    ["authorization"],
    "Authorization response",
  );
  return parseAuthorizationStatus(root["authorization"]);
}

function parseCredentialProfile(value: unknown): ImportCredentialProfile {
  const object = exactObject(
    value,
    ["id", "label", "provider"],
    "Credential profile",
  );
  const id = safeText(object["id"], "Credential profile id", 64);
  const label = safeText(object["label"], "Credential profile label", 80);
  const provider = object["provider"];
  if (
    !PROFILE_ID_PATTERN.test(id) ||
    (provider !== "github" &&
      provider !== "azure-devops" &&
      provider !== "generic-https")
  ) {
    throw protocolError("Credential profile is invalid.");
  }
  return Object.freeze({ id, label, provider });
}

export function parseCapabilitiesResponse(
  value: unknown,
): readonly ImportCredentialProfile[] {
  const root = exactObject(
    value,
    ["credentialProfiles"],
    "Import capability response",
  );
  const profiles = root["credentialProfiles"];
  if (!Array.isArray(profiles) || profiles.length > 64) {
    throw protocolError("Credential profile list is invalid.");
  }
  const parsed = profiles.map(parseCredentialProfile);
  const ids = new Set<string>();
  for (let index = 0; index < parsed.length; index += 1) {
    const profile = parsed[index]!;
    if (
      ids.has(profile.id) ||
      (index > 0 && parsed[index - 1]!.id >= profile.id)
    ) {
      throw protocolError(
        "Credential profiles must have unique, sorted identifiers.",
      );
    }
    ids.add(profile.id);
  }
  return Object.freeze(parsed);
}

function parseJobProgress(value: unknown): ImportJobProgress {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw protocolError("Import job progress is invalid.");
  }
  const candidate = value as Record<string, unknown>;
  const currentPresent = Object.hasOwn(candidate, "current");
  const totalPresent = Object.hasOwn(candidate, "total");
  const object = exactObject(
    value,
    [
      "phase",
      ...(currentPresent ? ["current"] : []),
      ...(totalPresent ? ["total"] : []),
    ],
    "Import job progress",
  );
  const phase = safeText(object["phase"], "Import job phase", 160);
  const current = object["current"];
  const total = object["total"];
  if (
    (currentPresent &&
      (!Number.isSafeInteger(current) || (current as number) < 0)) ||
    (totalPresent &&
      (!Number.isSafeInteger(total) || (total as number) < 0)) ||
    (currentPresent &&
      totalPresent &&
      (current as number) > (total as number))
  ) {
    throw protocolError("Import job progress is invalid.");
  }
  return Object.freeze({
    phase,
    ...(currentPresent ? { current: current as number } : {}),
    ...(totalPresent ? { total: total as number } : {}),
  });
}

function isJobErrorCode(value: unknown): value is ImportJobErrorCode {
  return (
    value === "analysis-failed" ||
    value === "cancelled" ||
    value === "city-model-invalid" ||
    value === "deadline-exceeded" ||
    value === "failed" ||
    value === "import-limit-exceeded" ||
    value === "interrupted" ||
    value === "repository-content-rejected" ||
    value === "repository-unavailable" ||
    value === "revision-unavailable"
  );
}

function parseJobError(value: unknown): ImportJobError {
  const object = exactObject(
    value,
    ["code", "message"],
    "Import job error",
  );
  const code = object["code"];
  if (!isJobErrorCode(code)) {
    throw protocolError("Import job error code is invalid.");
  }
  return Object.freeze({
    code,
    message: safeText(object["message"], "Import job error message", 1_024),
  });
}

function parseJobResult(value: unknown, jobId: string): ImportJobResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw protocolError("Import job result is invalid.");
  }
  const candidate = value as Record<string, unknown>;
  const evolutionPresent = Object.hasOwn(candidate, "evolution");
  const sourcePresent = Object.hasOwn(candidate, "source");
  const object = exactObject(
    value,
    [
      "artifactToken",
      "artifactUrl",
      "kind",
      ...(evolutionPresent ? ["evolution"] : []),
      ...(sourcePresent ? ["source"] : []),
    ],
    "Import job result",
  );
  const token = object["artifactToken"];
  const artifactUrl = object["artifactUrl"];
  if (
    object["kind"] !== "city-model" ||
    token !== jobId ||
    artifactUrl !== `/api/v1/artifacts/${jobId}/city-model.json`
  ) {
    throw protocolError("Import job result is invalid.");
  }
  let evolution: ImportJobResult["evolution"];
  if (evolutionPresent) {
    const evolutionObject = exactObject(
      object["evolution"],
      ["artifactUrl", "sha256", "size"],
      "Import evolution result",
    );
    const size = evolutionObject["size"];
    const sha256 = evolutionObject["sha256"];
    if (
      Number.isSafeInteger(size) &&
      (size as number) > MAXIMUM_EVOLUTION_ARTIFACT_BYTES
    ) {
      throw evolutionArtifactTooLargeFailure();
    }
    if (
      evolutionObject["artifactUrl"] !==
        `/api/v1/artifacts/${jobId}/evolution.json` ||
      !Number.isSafeInteger(size) ||
      (size as number) < 1 ||
      typeof sha256 !== "string" ||
      !/^[0-9a-f]{64}$/u.test(sha256)
    ) {
      throw protocolError("Import evolution result is invalid.");
    }
    evolution = Object.freeze({
      artifactUrl: evolutionObject["artifactUrl"],
      size: size as number,
      sha256,
    });
  }
  let source: ImportJobResult["source"];
  if (sourcePresent) {
    if (
      typeof object["source"] !== "object" ||
      object["source"] === null ||
      Array.isArray(object["source"])
    ) {
      throw protocolError("Import source result is invalid.");
    }
    const sourceCandidate = object["source"] as Record<string, unknown>;
    if (
      sourceCandidate["availability"] === "disabled" ||
      sourceCandidate["availability"] === "not-captured"
    ) {
      exactObject(
        sourceCandidate,
        ["availability"],
        "Import source result",
      );
      source = Object.freeze({
        availability: sourceCandidate["availability"],
      });
    } else {
      const sourceObject = exactObject(
        sourceCandidate,
        [
          "artifactUrl",
          "availability",
          "indexSha256",
          "sha256",
          "size",
        ],
        "Import source result",
      );
      const size = sourceObject["size"];
      const sha256 = sourceObject["sha256"];
      const indexSha256 = sourceObject["indexSha256"];
      if (
        sourceObject["availability"] !== "retained" ||
        sourceObject["artifactUrl"] !==
          `/api/v1/artifacts/${jobId}/source` ||
        !Number.isSafeInteger(size) ||
        (size as number) < 1 ||
        (size as number) > MAXIMUM_SOURCE_ARTIFACT_BYTES ||
        typeof sha256 !== "string" ||
        !/^[0-9a-f]{64}$/u.test(sha256) ||
        typeof indexSha256 !== "string" ||
        !/^[0-9a-f]{64}$/u.test(indexSha256)
      ) {
        throw protocolError("Import source result is invalid.");
      }
      source = Object.freeze({
        availability: "retained",
        artifactUrl: sourceObject["artifactUrl"],
        size: size as number,
        sha256,
        indexSha256,
      });
    }
  }
  return Object.freeze({
    kind: "city-model",
    artifactToken: jobId,
    artifactUrl,
    ...(evolution === undefined ? {} : { evolution }),
    ...(source === undefined ? {} : { source }),
  });
}

export function parseImportJob(
  value: unknown,
  expectedId?: string,
): ImportJob {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw protocolError("Import job is invalid.");
  }
  const candidate = value as Record<string, unknown>;
  const progressPresent = Object.hasOwn(candidate, "progress");
  const errorPresent = Object.hasOwn(candidate, "error");
  const resultPresent = Object.hasOwn(candidate, "result");
  const object = exactObject(
    value,
    [
      "createdAt",
      "id",
      "kind",
      "state",
      "updatedAt",
      ...(progressPresent ? ["progress"] : []),
      ...(errorPresent ? ["error"] : []),
      ...(resultPresent ? ["result"] : []),
    ],
    "Import job",
  );
  const id = safeText(object["id"], "Import job id", 36);
  const state = object["state"];
  if (
    !IMPORT_JOB_ID_PATTERN.test(id) ||
    (expectedId !== undefined && id !== expectedId) ||
    object["kind"] !== "project-import" ||
    (state !== "queued" &&
      state !== "running" &&
      state !== "completed" &&
      state !== "failed" &&
      state !== "cancelled")
  ) {
    throw protocolError("Import job identity or state is invalid.");
  }
  if (
    ((state === "queued" || state === "running") &&
      (errorPresent || resultPresent)) ||
    (state === "completed" && (!resultPresent || errorPresent)) ||
    ((state === "failed" || state === "cancelled") &&
      (!errorPresent || resultPresent))
  ) {
    throw protocolError("Import job terminal data is inconsistent.");
  }
  const progress = progressPresent
    ? parseJobProgress(object["progress"])
    : undefined;
  const error = errorPresent ? parseJobError(object["error"]) : undefined;
  const result = resultPresent
    ? parseJobResult(object["result"], id)
    : undefined;
  return Object.freeze({
    id,
    kind: "project-import",
    state,
    createdAt: safeIsoDate(object["createdAt"], "Import job creation time"),
    updatedAt: safeIsoDate(object["updatedAt"], "Import job update time"),
    ...(progress === undefined ? {} : { progress }),
    ...(error === undefined ? {} : { error }),
    ...(result === undefined ? {} : { result }),
  });
}

export function parseImportJobResponse(
  value: unknown,
  expectedId?: string,
): ImportJob {
  const root = exactObject(value, ["job"], "Import job response");
  return parseImportJob(root["job"], expectedId);
}

export function parseUploadReservationResponse(
  value: unknown,
  request: UploadImportSubmission,
): ImportUploadReservation {
  const root = exactObject(
    value,
    ["upload"],
    "Upload reservation response",
  );
  const object = exactObject(
    root["upload"],
    ["expiresAt", "mediaType", "sizeBytes", "token", "uploadUrl"],
    "Upload reservation",
  );
  const token = safeText(object["token"], "Upload reservation token", 36);
  const expectedMediaType =
    request.source.kind === "city-model"
      ? "application/json"
      : "application/zip";
  if (
    !IMPORT_JOB_ID_PATTERN.test(token) ||
    object["uploadUrl"] !== `/api/v1/imports/uploads/${token}` ||
    object["mediaType"] !== expectedMediaType ||
    object["sizeBytes"] !== request.source.sizeBytes
  ) {
    throw protocolError("Upload reservation is inconsistent.");
  }
  return Object.freeze({
    token,
    uploadUrl: object["uploadUrl"],
    mediaType: expectedMediaType,
    sizeBytes: request.source.sizeBytes,
    expiresAt: safeIsoDate(
      object["expiresAt"],
      "Upload reservation expiry",
    ),
  });
}

function parseFieldError(value: unknown): ImportFieldError {
  const object = exactObject(
    value,
    ["code", "message", "path"],
    "Import field error",
  );
  const code = safeText(object["code"], "Import field error code", 64);
  const path = safeText(object["path"], "Import field path", 256);
  if (!ERROR_CODE_PATTERN.test(code) || !FIELD_PATH_PATTERN.test(path)) {
    throw protocolError("Import field error is invalid.");
  }
  return Object.freeze({
    code,
    path,
    message: safeText(
      object["message"],
      "Import field error message",
      1_024,
    ),
  });
}

function retryAfterMilliseconds(response: Response): number | undefined {
  const raw = response.headers.get("retry-after");
  if (raw === null || !/^(?:[1-9]|[1-5][0-9]|60)$/u.test(raw)) {
    return undefined;
  }
  return Number(raw) * 1_000;
}

function parseErrorResponse(
  value: unknown,
  response: Response,
): ImportApiError {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw protocolError("API error response is invalid.");
    }
    const rootCandidate = value as Record<string, unknown>;
    const errorValue = rootCandidate["error"];
    if (
      typeof errorValue !== "object" ||
      errorValue === null ||
      Array.isArray(errorValue)
    ) {
      throw protocolError("API error response is invalid.");
    }
    const errorCandidate = errorValue as Record<string, unknown>;
    const fieldsPresent = Object.hasOwn(errorCandidate, "fields");
    const root = exactObject(value, ["error"], "API error response");
    const object = exactObject(
      root["error"],
      ["code", "message", ...(fieldsPresent ? ["fields"] : [])],
      "API error",
    );
    const code = safeText(object["code"], "API error code", 64);
    const message = safeText(object["message"], "API error message", 1_024);
    if (!ERROR_CODE_PATTERN.test(code)) {
      throw protocolError("API error code is invalid.");
    }
    let fields: readonly ImportFieldError[] | undefined;
    if (fieldsPresent) {
      if (
        !Array.isArray(object["fields"]) ||
        object["fields"].length > MAXIMUM_ERROR_FIELDS
      ) {
        throw protocolError("API field errors are invalid.");
      }
      fields = Object.freeze(object["fields"].map(parseFieldError));
    }
    const retryAfterMs = retryAfterMilliseconds(response);
    return new ImportApiError("http", message, {
      status: response.status,
      code,
      ...(fields === undefined ? {} : { fields }),
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    });
  } catch {
    const retryAfterMs = retryAfterMilliseconds(response);
    return new ImportApiError(
      "http",
      `Code City request failed with HTTP ${response.status}.`,
      {
        status: response.status,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      },
    );
  }
}

function abortFailure(): DOMException {
  return new DOMException("The import request was cancelled.", "AbortError");
}

async function waitForAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw abortFailure();
  return await new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(abortFailure());
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

async function readBoundedBytes(
  response: Response,
  signal: AbortSignal,
  maximumBytes = API_RESPONSE_MAX_BYTES,
): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^\d+$/u.test(contentLength)) {
      throw protocolError("API response Content-Length is invalid.");
    }
    const length = Number(contentLength);
    if (
      !Number.isSafeInteger(length) ||
      length > maximumBytes
    ) {
      throw protocolError("API response exceeds the viewer limit.");
    }
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let complete = false;
  try {
    for (;;) {
      const item = await waitForAbort(reader.read(), signal);
      if (item.done) {
        complete = true;
        break;
      }
      if (item.value.byteLength > maximumBytes - size) {
        throw protocolError("API response exceeds the viewer limit.");
      }
      size += item.value.byteLength;
      chunks.push(item.value);
    }
  } finally {
    if (!complete) {
      void reader.cancel().catch(() => undefined);
    } else {
      reader.releaseLock();
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export type EvolutionArtifactBufferAllocator = (
  byteLength: number,
) => ArrayBuffer;

/**
 * Reads an evolution response into its one final, owned transfer buffer.
 *
 * The declared length is authenticated metadata from the completed job. A
 * single exact allocation means the number of response chunks cannot multiply
 * retained binary memory, while copying each chunk protects the result from
 * response-owned storage before the buffer is transferred to the worker.
 */
export async function readExactEvolutionArtifact(
  response: Response,
  signal: AbortSignal,
  expectedBytes: number,
  allocate: EvolutionArtifactBufferAllocator = (byteLength) =>
    new ArrayBuffer(byteLength),
): Promise<ArrayBuffer> {
  if (
    !Number.isSafeInteger(expectedBytes) ||
    expectedBytes < 1
  ) {
    throw protocolError("Evolution artifact size is invalid.");
  }
  if (expectedBytes > MAXIMUM_EVOLUTION_ARTIFACT_BYTES) {
    throw evolutionArtifactTooLargeFailure();
  }
  const body = response.body;
  if (
    response.headers.get("content-length") !== String(expectedBytes) ||
    body === null
  ) {
    if (body !== null) {
      void body.cancel().catch(() => undefined);
    }
    throw protocolError("Evolution artifact size does not match.");
  }
  if (signal.aborted) {
    void body.cancel().catch(() => undefined);
    throw abortFailure();
  }

  let buffer: ArrayBuffer;
  try {
    buffer = allocate(expectedBytes);
    if (
      !(buffer instanceof ArrayBuffer) ||
      buffer.byteLength !== expectedBytes
    ) {
      throw new TypeError("The artifact allocator returned an invalid buffer.");
    }
  } catch {
    void body.cancel().catch(() => undefined);
    throw protocolError(
      `The evolution artifact could not fit in browser memory. Re-import with fewer history frames or a lower maxEvolutionOutputBytes (maximum ${MAXIMUM_EVOLUTION_ARTIFACT_MEBIBYTES} MiB).`,
    );
  }

  const destination = new Uint8Array(buffer);
  const reader = body.getReader();
  let offset = 0;
  let complete = false;
  try {
    for (;;) {
      const item = await waitForAbort(reader.read(), signal);
      if (item.done) {
        complete = true;
        break;
      }
      if (item.value.byteLength > expectedBytes - offset) {
        throw protocolError("Evolution artifact size does not match.");
      }
      destination.set(item.value, offset);
      offset += item.value.byteLength;
    }
  } finally {
    if (!complete) {
      void reader.cancel().catch(() => undefined);
    } else {
      reader.releaseLock();
    }
  }
  if (offset !== expectedBytes) {
    throw protocolError("Evolution artifact size does not match.");
  }
  return buffer;
}

async function readJsonResponse(
  response: Response,
  signal: AbortSignal,
  maximumBytes = API_RESPONSE_MAX_BYTES,
): Promise<unknown> {
  const contentType = response.headers.get("content-type");
  if (
    contentType === null ||
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(contentType)
  ) {
    throw protocolError("API response is not UTF-8 JSON.");
  }
  const bytes = await readBoundedBytes(response, signal, maximumBytes);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw protocolError("API response is not valid UTF-8.");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw protocolError("API response is not valid JSON.");
  }
}

export class ViewerImportApiClient {
  private readonly origin: string;
  private readonly fetchImplementation: ImportApiFetch;
  private readonly requestDeadlineMs: number;
  private readonly uploadDeadlineMs: number;
  private readonly removalDeadlineMs: number;
  private readonly scheduleDeadline: (
    callback: () => void,
    milliseconds: number,
  ) => unknown;
  private readonly clearDeadline: (handle: unknown) => void;

  public constructor(
    viewerUrl: URL,
    options: ViewerImportApiClientOptions = {},
  ) {
    const base = new URL(viewerUrl.href);
    if (
      (base.protocol !== "http:" && base.protocol !== "https:") ||
      base.username !== "" ||
      base.password !== ""
    ) {
      throw new TypeError(
        "The import API requires a credential-free HTTP(S) viewer URL.",
      );
    }
    this.origin = base.origin;
    this.fetchImplementation =
      options.fetch ??
      ((input, init) => globalThis.fetch(input, init));
    this.requestDeadlineMs =
      options.requestDeadlineMs ?? API_REQUEST_DEADLINE_MS;
    this.uploadDeadlineMs =
      options.uploadDeadlineMs ?? API_UPLOAD_DEADLINE_MS;
    this.removalDeadlineMs =
      options.removalDeadlineMs ?? API_RESULT_REMOVAL_DEADLINE_MS;
    for (const [name, value] of [
      ["request", this.requestDeadlineMs],
      ["upload", this.uploadDeadlineMs],
      ["removal", this.removalDeadlineMs],
    ] as const) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new TypeError(
          `The import API ${name} deadline must be a positive integer.`,
        );
      }
    }
    this.scheduleDeadline =
      options.scheduleDeadline ??
      ((callback, milliseconds) =>
        globalThis.setTimeout(callback, milliseconds));
    this.clearDeadline =
      options.clearDeadline ??
      ((handle) => globalThis.clearTimeout(handle as number));
  }

  public async authorizationStatus(
    signal?: AbortSignal,
  ): Promise<ImportAuthorizationStatus> {
    const response = await this.jsonRequest(
      "/api/v1/auth/session",
      { method: "GET" },
      signal,
    );
    if (response.response.status !== 200) {
      throw protocolError(
        "Authorization API returned an unexpected success status.",
      );
    }
    return parseAuthorizationResponse(response.value);
  }

  public async createSession(
    token: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (
      typeof token !== "string" ||
      !AUTHORIZATION_TOKEN_PATTERN.test(token)
    ) {
      throw new ImportApiError(
        "protocol",
        "Enter the canonical Code City authorization token.",
      );
    }
    await this.emptyRequest(
      "/api/v1/auth/session",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Code-City-Request": "1",
        },
      },
      204,
      signal,
    );
  }

  public async logout(signal?: AbortSignal): Promise<void> {
    await this.emptyRequest(
      "/api/v1/auth/session",
      {
        method: "DELETE",
        headers: { "X-Code-City-Request": "1" },
        keepalive: true,
      },
      204,
      signal,
    );
  }

  public async capabilities(
    signal?: AbortSignal,
  ): Promise<readonly ImportCredentialProfile[]> {
    const response = await this.jsonRequest(
      "/api/v1/imports/capabilities",
      { method: "GET" },
      signal,
    );
    if (response.response.status !== 200) {
      throw protocolError(
        "Import capability API returned an unexpected success status.",
      );
    }
    return parseCapabilitiesResponse(response.value);
  }

  public async buildingSource(
    jobId: string,
    buildingId: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const response = await this.jsonRequest(
      `/api/v1/artifacts/${jobId}/sources/${buildingId}`,
      { method: "GET" },
      signal,
      this.requestDeadlineMs,
      SOURCE_RESPONSE_MAX_BYTES,
    );
    if (response.response.status === 409) {
      throw new ImportApiError(
        "protocol",
        "Source retention is disabled for this imported model.",
      );
    }
    if (response.response.status !== 200) {
      throw protocolError("Source code could not be loaded.");
    }
    return response.value;
  }

  /** The request names a retained unit only; source text is never posted by the browser. */
  public async aiGuidanceProviders(signal?: AbortSignal): Promise<ViewerAiGuidanceProviders> {
    return parseAiGuidanceProviders((await this.jsonRequest("/api/v1/ai/providers", { method: "GET" }, signal, this.requestDeadlineMs, API_RESPONSE_MAX_BYTES)).value);
  }

  public async aiGuidancePreview(jobId: string, context: ViewerAiGuidanceContext, providerId: string, signal?: AbortSignal): Promise<ViewerAiGuidancePreview> {
    this.requireJobId(jobId);
    const descriptor = parseAiContext(context);
    if (!AI_PROVIDER_ID_PATTERN.test(providerId)) throw protocolError("AI provider ID is invalid.");
    return parseAiGuidancePreview((await this.jsonRequest(`/api/v1/ai/preview/${jobId}/${descriptor.buildingId}/${providerId}`, { method: "POST", headers: { "content-type": "application/json", "X-Code-City-Request": "1" }, body: JSON.stringify(descriptor) }, signal, this.requestDeadlineMs, SOURCE_RESPONSE_MAX_BYTES)).value);
  }

  public async aiGuidanceRequest(
    grant: string,
    providerTimeoutMs: number,
    signal?: AbortSignal,
  ): Promise<ViewerAiGuidanceResult> {
    const deadlineMs = aiGuidanceRequestDeadlineMs(providerTimeoutMs);
    return parseAiGuidanceResult((await this.jsonRequest("/api/v1/ai/requests", { method: "POST", headers: { "content-type": "application/json", "X-Code-City-Request": "1" }, body: JSON.stringify({ approval: "once", grant }) }, signal, deadlineMs, API_RESPONSE_MAX_BYTES)).value);
  }

  public async evolutionArtifact(
    jobId: string,
    artifact: NonNullable<ImportJobResult["evolution"]>,
    signal?: AbortSignal,
  ): Promise<ArrayBuffer> {
    this.requireJobId(jobId);
    const expectedPath = `/api/v1/artifacts/${jobId}/evolution.json`;
    if (
      Number.isSafeInteger(artifact.size) &&
      artifact.size > MAXIMUM_EVOLUTION_ARTIFACT_BYTES
    ) {
      throw evolutionArtifactTooLargeFailure();
    }
    if (
      artifact.artifactUrl !== expectedPath ||
      !Number.isSafeInteger(artifact.size) ||
      artifact.size < 1 ||
      !/^[0-9a-f]{64}$/u.test(artifact.sha256)
    ) {
      throw protocolError("Evolution artifact metadata is invalid.");
    }
    return await this.withDeadline(
      signal,
      EVOLUTION_ARTIFACT_DEADLINE_MS,
      async (requestSignal) => {
        const response = await this.fetchResponse(
          expectedPath,
          { method: "GET" },
          requestSignal,
        );
        if (response.status !== 200) {
          if (response.body !== null) {
            await readBoundedBytes(
              response,
              requestSignal,
              API_RESPONSE_MAX_BYTES,
            );
          }
          throw protocolError("Evolution artifact could not be loaded.");
        }
        const contentType = response.headers.get("content-type");
        if (
          contentType === null ||
          !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(contentType)
        ) {
          throw protocolError("Evolution artifact is not UTF-8 JSON.");
        }
        return await readExactEvolutionArtifact(
          response,
          requestSignal,
          artifact.size,
        );
      },
    );
  }

  public async createRemoteImport(
    request: RemoteImportSubmission,
    signal?: AbortSignal,
  ): Promise<ImportJob> {
    const response = await this.jsonRequest(
      "/api/v1/imports",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Code-City-Request": "1",
        },
        body: JSON.stringify(request),
      },
      signal,
    );
    if (response.response.status !== 202) {
      throw protocolError("Import API returned an unexpected success status.");
    }
    const job = parseImportJobResponse(response.value);
    this.requireLocation(response.response, `/api/v1/jobs/${job.id}`);
    return job;
  }

  public async reserveUpload(
    request: UploadImportSubmission,
    signal?: AbortSignal,
  ): Promise<ImportUploadReservation> {
    const response = await this.jsonRequest(
      "/api/v1/imports/uploads",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Code-City-Request": "1",
        },
        body: JSON.stringify(request),
      },
      signal,
    );
    if (response.response.status !== 201) {
      throw protocolError("Upload API returned an unexpected success status.");
    }
    const reservation = parseUploadReservationResponse(
      response.value,
      request,
    );
    this.requireLocation(response.response, reservation.uploadUrl);
    return reservation;
  }

  public async upload(
    reservation: ImportUploadReservation,
    body: Blob,
    signal?: AbortSignal,
  ): Promise<ImportJob> {
    if (
      !(body instanceof Blob) ||
      body.size !== reservation.sizeBytes ||
      !IMPORT_JOB_ID_PATTERN.test(reservation.token) ||
      reservation.uploadUrl !==
        `/api/v1/imports/uploads/${reservation.token}`
    ) {
      throw new ImportApiError(
        "protocol",
        "Upload bytes do not match their reservation.",
      );
    }
    const response = await this.jsonRequest(
      reservation.uploadUrl,
      {
        method: "PUT",
        headers: {
          "Content-Type": reservation.mediaType,
          "X-Code-City-Request": "1",
        },
        body,
      },
      signal,
      this.uploadDeadlineMs,
    );
    if (response.response.status !== 202) {
      throw protocolError("Upload API returned an unexpected success status.");
    }
    const job = parseImportJobResponse(response.value);
    this.requireLocation(response.response, `/api/v1/jobs/${job.id}`);
    return job;
  }

  public async abandonUpload(
    reservation: ImportUploadReservation,
    signal?: AbortSignal,
  ): Promise<void> {
    if (
      !IMPORT_JOB_ID_PATTERN.test(reservation.token) ||
      reservation.uploadUrl !==
        `/api/v1/imports/uploads/${reservation.token}`
    ) {
      throw new ImportApiError(
        "protocol",
        "Upload reservation is invalid.",
      );
    }
    const response = await this.jsonRequest(
      reservation.uploadUrl,
      {
        method: "DELETE",
        headers: { "X-Code-City-Request": "1" },
      },
      signal,
    );
    if (response.response.status !== 200) {
      throw protocolError("Upload deletion returned an unexpected status.");
    }
    const root = exactObject(
      response.value,
      ["deleted"],
      "Upload deletion response",
    );
    if (root["deleted"] !== true) {
      throw protocolError("Upload deletion response is invalid.");
    }
  }

  public async getJob(
    id: string,
    signal?: AbortSignal,
  ): Promise<ImportJob> {
    this.requireJobId(id);
    const response = await this.jsonRequest(
      `/api/v1/jobs/${id}`,
      { method: "GET" },
      signal,
    );
    if (response.response.status !== 200) {
      throw protocolError("Job API returned an unexpected success status.");
    }
    return parseImportJobResponse(response.value, id);
  }

  public async cancelJob(
    id: string,
    signal?: AbortSignal,
  ): Promise<ImportJob> {
    this.requireJobId(id);
    const response = await this.jsonRequest(
      `/api/v1/jobs/${id}`,
      {
        method: "DELETE",
        headers: { "X-Code-City-Request": "1" },
      },
      signal,
      this.uploadDeadlineMs,
    );
    if (response.response.status !== 200) {
      throw protocolError(
        "Job cancellation returned an unexpected success status.",
      );
    }
    return parseImportJobResponse(response.value, id);
  }

  public async removeCompletedJob(
    id: string,
    signal?: AbortSignal,
  ): Promise<ImportJob & { readonly state: "completed" }> {
    this.requireJobId(id);
    const response = await this.jsonRequest(
      `/api/v1/imports/${id}/result`,
      {
        method: "DELETE",
        headers: { "X-Code-City-Request": "1" },
      },
      signal,
      this.removalDeadlineMs,
    );
    if (response.response.status !== 200) {
      throw protocolError(
        "Completed import removal returned an unexpected success status.",
      );
    }
    const root = exactObject(
      response.value,
      ["deleted", "job"],
      "Completed import removal response",
    );
    if (root["deleted"] !== true) {
      throw protocolError(
        "Completed import removal was not confirmed.",
      );
    }
    const job = parseImportJob(root["job"], id);
    if (job.state !== "completed") {
      throw protocolError(
        "Completed import removal returned a non-completed job.",
      );
    }
    return job as ImportJob & { readonly state: "completed" };
  }

  private requireJobId(id: string): void {
    if (!IMPORT_JOB_ID_PATTERN.test(id)) {
      throw new ImportApiError("protocol", "Import job id is invalid.");
    }
  }

  private requireLocation(response: Response, expected: string): void {
    if (response.headers.get("location") !== expected) {
      throw protocolError("Import API returned an invalid Location.");
    }
  }

  private url(path: string): URL {
    if (
      !path.startsWith("/api/v1/") ||
      path.includes("?") ||
      path.includes("#") ||
      path.includes("%") ||
      path.includes("\\")
    ) {
      throw new ImportApiError("protocol", "Import API path is invalid.");
    }
    const url = new URL(path, `${this.origin}/`);
    if (url.origin !== this.origin || url.username !== "" || url.password !== "") {
      throw new ImportApiError("protocol", "Import API path is invalid.");
    }
    return url;
  }

  private async jsonRequest(
    path: string,
    init: RequestInit,
    signal?: AbortSignal,
    deadlineMs = this.requestDeadlineMs,
    maximumResponseBytes = API_RESPONSE_MAX_BYTES,
  ): Promise<{ readonly response: Response; readonly value: unknown }> {
    return await this.withDeadline(signal, deadlineMs, async (requestSignal) => {
      const response = await this.fetchResponse(path, init, requestSignal);
      const value = await readJsonResponse(
        response,
        requestSignal,
        maximumResponseBytes,
      );
      if (!response.ok) throw parseErrorResponse(value, response);
      return { response, value };
    });
  }

  private async emptyRequest(
    path: string,
    init: RequestInit,
    expectedStatus: number,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.withDeadline(
      signal,
      this.requestDeadlineMs,
      async (requestSignal) => {
        const response = await this.fetchResponse(path, init, requestSignal);
        if (!response.ok) {
          const value = await readJsonResponse(response, requestSignal);
          throw parseErrorResponse(value, response);
        }
        if (response.status !== expectedStatus) {
          throw protocolError("Import API returned an unexpected status.");
        }
        const length = response.headers.get("content-length");
        if (length !== null && length !== "0") {
          throw protocolError("Import API returned an unexpected body.");
        }
        if (response.body !== null) {
          const bytes = await readBoundedBytes(response, requestSignal);
          if (bytes.byteLength !== 0) {
            throw protocolError("Import API returned an unexpected body.");
          }
        }
      },
    );
  }

  private async fetchResponse(
    path: string,
    init: RequestInit,
    signal: AbortSignal,
  ): Promise<Response> {
    const requested = this.url(path);
    let response: Response;
    try {
      response = await waitForAbort(
        this.fetchImplementation(requested, {
          ...init,
          cache: "no-store",
          credentials: "same-origin",
          redirect: "error",
          referrerPolicy: "no-referrer",
          mode: "same-origin",
          signal,
        }),
        signal,
      );
    } catch (error) {
      if (signal.aborted) throw error;
      throw new ImportApiError(
        "network",
        "The Code City server could not be reached.",
      );
    }
    let responseUrl: URL;
    try {
      responseUrl =
        response.url === "" ? requested : new URL(response.url);
    } catch {
      throw protocolError("Import API returned an invalid response URL.");
    }
    if (
      response.redirected ||
      response.type === "opaqueredirect" ||
      responseUrl.href !== requested.href ||
      responseUrl.origin !== this.origin
    ) {
      throw protocolError("Import API redirects are not allowed.");
    }
    return response;
  }

  private async withDeadline<T>(
    externalSignal: AbortSignal | undefined,
    deadlineMs: number,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (externalSignal?.aborted) throw abortFailure();
    const controller = new AbortController();
    let deadlineExceeded = false;
    const abort = (): void => controller.abort();
    externalSignal?.addEventListener("abort", abort, { once: true });
    if (externalSignal?.aborted) {
      externalSignal.removeEventListener("abort", abort);
      throw abortFailure();
    }
    const deadline = this.scheduleDeadline(() => {
      deadlineExceeded = true;
      controller.abort();
    }, deadlineMs);
    try {
      if (controller.signal.aborted) throw abortFailure();
      return await waitForAbort(
        operation(controller.signal),
        controller.signal,
      );
    } catch (error) {
      if (deadlineExceeded) {
        throw new ImportApiError(
          "deadline",
          "The Code City server did not respond in time.",
        );
      }
      if (controller.signal.aborted) throw abortFailure();
      throw error;
    } finally {
      this.clearDeadline(deadline);
      externalSignal?.removeEventListener("abort", abort);
    }
  }
}
