import type { CityModel } from "../../../packages/core/src/model.js";
import {
  DEFAULT_SNAPSHOT_LIMITS,
} from "../../../packages/analyzer/src/snapshot.js";
import {
  HISTORY_SELECTION_LIMITS,
} from "../../../packages/analyzer/src/history-selection.js";

import {
  type ImportAnalysisOptions,
  type ImportCredentialProfile,
  type ImportCredentialProvider,
  type ImportFieldError,
  type ImportIdentityOptions,
  type ImportRevision,
  type RemoteImportHistorySelection,
  type RemoteImportSubmission,
  type UploadImportSubmission,
  ViewerImportApiClient,
} from "./import-api.js";
import {
  ImportController,
  type ImportedCityModelSource,
  type ImportControllerState,
} from "./import-controller.js";
import {
  PROJECT_DIRECTORY_ARCHIVE_LIMITS,
  type ProjectDirectoryArchiveProgress,
} from "./project-directory-archive-protocol.js";
import {
  ProjectDirectoryArchiveClient,
} from "./project-directory-archive-client.js";
import {
  VIEWER_MODEL_MAX_BYTES,
  type ViewerLoadGateway,
} from "./model-source.js";

const MEBIBYTE = 1024 * 1024;

export const PROJECT_IMPORT_ANALYSIS_LIMITS = Object.freeze({
  maxRetainedFiles: DEFAULT_SNAPSHOT_LIMITS.maxRetainedFiles,
  maxFileMib: DEFAULT_SNAPSHOT_LIMITS.maxFileBytes / MEBIBYTE,
  maxTotalMib: DEFAULT_SNAPSHOT_LIMITS.maxTotalBytes / MEBIBYTE,
  timeoutSeconds: DEFAULT_SNAPSHOT_LIMITS.timeoutMs / 1_000,
});

export const PROJECT_IMPORT_HISTORY_LIMITS = Object.freeze({
  maxCommits: HISTORY_SELECTION_LIMITS.maxTraversedCommits,
  maxSampleEvery: HISTORY_SELECTION_LIMITS.maxSampleEvery,
  maxFrames: HISTORY_SELECTION_LIMITS.maxSampledFrames,
  maxTagNameBytes: HISTORY_SELECTION_LIMITS.maxTagNameBytes,
});

export const PROJECT_IMPORT_SOURCE_CHOICES = Object.freeze([
  "directory",
  "zip",
  "github-public",
  "github-authenticated",
  "azure-devops",
  "git",
  "city-model",
] as const);

export type ProjectImportSource =
  (typeof PROJECT_IMPORT_SOURCE_CHOICES)[number];

export const PROJECT_IMPORT_STEPS = Object.freeze([
  "source",
  "details",
  "options",
  "progress",
] as const);

export type ProjectImportStep = (typeof PROJECT_IMPORT_STEPS)[number];

export type ProjectImportFieldKey =
  | "analysis"
  | "credentialProfileId"
  | "directory"
  | "history"
  | "model"
  | "repositoryName"
  | "repositoryUrl"
  | "revision"
  | "title"
  | "version"
  | "zip";

export interface InstallProjectImportDialogOptions {
  readonly loadGateway: ViewerLoadGateway;
  readonly viewerUrl?: URL;
  readonly autoResume?: boolean;
  readonly onModelReady: (
    model: CityModel,
    source: ImportedCityModelSource,
  ) => void | Promise<void>;
  readonly onSignedOut?: () => void | Promise<void>;
  readonly onAuthenticated?: () => void | Promise<void>;
  readonly onAuthorizationLost?: () => void | Promise<void>;
  readonly onResultRemoved?: (jobId: string) => void | Promise<void>;
}

export interface ProjectImportDialogHandle {
  open(): void;
  dispose(): void;
}

interface ProjectImportFormValues {
  readonly source: ProjectImportSource;
  readonly identity?: ImportIdentityOptions;
  readonly analysis?: ImportAnalysisOptions;
}

export interface ProjectImportRemoteSubmissionValues {
  readonly source:
    | "github-public"
    | "github-authenticated"
    | "azure-devops"
    | "git";
  readonly repositoryUrl: string;
  readonly credentialProfileId: string;
  readonly revisionKind: string;
  readonly revisionValue: string;
  readonly history?: RemoteImportHistorySelection;
  readonly identity?: ImportIdentityOptions;
  readonly analysis?: ImportAnalysisOptions;
}

interface ProjectImportFieldBinding {
  readonly error: HTMLElement;
  readonly controls: readonly HTMLElement[];
  readonly step: ProjectImportStep;
}

interface FormValidationFailure {
  readonly field: ProjectImportFieldKey;
  readonly message: string;
}

const SOURCE_LABELS: Readonly<Record<ProjectImportSource, string>> =
  Object.freeze({
    directory: "Local directory",
    zip: "ZIP archive",
    "github-public": "Public GitHub",
    "github-authenticated": "Authenticated GitHub",
    "azure-devops": "Azure DevOps",
    git: "Generic Git",
    "city-model": "Existing city model",
  });

const SERVER_FIELD_KEYS: Readonly<
  Record<string, ProjectImportFieldKey>
> = Object.freeze({
  "$.source.repositoryUrl": "repositoryUrl",
  "$.source.credentialProfileId": "credentialProfileId",
  "$.source.revision": "revision",
  "$.source.revision.kind": "revision",
  "$.source.revision.name": "revision",
  "$.source.revision.sha": "revision",
  "$.history": "history",
  "$.history.mode": "history",
  "$.history.commitCount": "history",
  "$.history.fromInclusive": "history",
  "$.history.toInclusive": "history",
  "$.history.oldestTagName": "history",
  "$.history.newestTagName": "history",
  "$.history.maxCommits": "history",
  "$.history.sampleEvery": "history",
  "$.source.repositoryName": "repositoryName",
  "$.source.rootMode": "repositoryName",
  "$.identity.title": "title",
  "$.identity.version": "version",
  "$.analysis": "analysis",
  "$.analysis.maxRetainedFiles": "analysis",
  "$.analysis.maxFileBytes": "analysis",
  "$.analysis.maxTotalBytes": "analysis",
  "$.analysis.timeoutMs": "analysis",
});

export function projectImportFieldForServerPath(
  path: string,
  source?: ProjectImportSource,
): ProjectImportFieldKey | undefined {
  if (path === "$.source.sizeBytes") {
    return source === "city-model"
      ? "model"
      : source === "directory"
        ? "directory"
        : "zip";
  }
  return SERVER_FIELD_KEYS[path];
}

export function projectImportUploadSizeError(
  source: "zip" | "city-model",
  sizeBytes: number,
): string | undefined {
  if (sizeBytes === 0) {
    return source === "city-model"
      ? "City models must not be empty."
      : "Repository ZIPs must not be empty.";
  }
  const maximum =
    source === "city-model"
      ? VIEWER_MODEL_MAX_BYTES
      : PROJECT_DIRECTORY_ARCHIVE_LIMITS.maxArchiveBytes;
  if (sizeBytes <= maximum) return undefined;
  return source === "city-model"
    ? `City models must not exceed ${(
        maximum / MEBIBYTE
      ).toLocaleString()} MiB.`
    : `Repository ZIPs must not exceed ${(
        maximum / MEBIBYTE
      ).toLocaleString()} MiB.`;
}

export function projectImportNavigationLocked(
  status: ImportControllerState["status"],
): boolean {
  return (
    status === "artifact-failed" ||
    status === "completed" ||
    status === "opening-artifact" ||
    status === "removal-failed" ||
    status === "removing-result" ||
    status === "sign-out-failed" ||
    status === "terminal" ||
    status === "unavailable"
  );
}

export function projectImportShouldResetOnOpen(
  _status: ImportControllerState["status"],
): boolean {
  return false;
}

export function projectImportPersistenceWarning(
  state: ImportControllerState,
): string | undefined {
  if (
    !("persistenceAvailable" in state) ||
    state.persistenceAvailable
  ) {
    return undefined;
  }
  return "This browser cannot save import recovery state. Keep this page open while importing; reloading may lose access to the job or its result.";
}

export function projectImportProvidersForSource(
  source: ProjectImportSource,
  repositoryUrl = "",
): readonly ImportCredentialProvider[] {
  switch (source) {
    case "github-authenticated":
      return Object.freeze(["github"]);
    case "azure-devops":
      return Object.freeze(["azure-devops"]);
    case "git":
      return /^https:\/\//iu.test(repositoryUrl.trim())
        ? Object.freeze(["generic-https"])
        : Object.freeze([]);
    case "directory":
    case "zip":
    case "github-public":
    case "city-model":
      return Object.freeze([]);
  }
}

export function projectImportRevision(
  kind: string,
  value: string,
): ImportRevision | undefined {
  if (kind === "default") return undefined;
  const normalized = value.normalize("NFC").trim();
  if (kind === "commit") {
    if (!/^[0-9a-f]{40}$/iu.test(normalized)) {
      throw new Error("Enter an exact 40-character commit SHA.");
    }
    return { kind: "commit", sha: normalized.toLowerCase() };
  }
  if (
    (kind !== "branch" && kind !== "tag") ||
    normalized.length === 0 ||
    normalized.length > 256 ||
    /[\p{Cc}\p{Cf}\p{Cs}]/u.test(normalized)
  ) {
    throw new Error(
      kind === "tag"
        ? "Enter a valid tag name."
        : "Enter a valid branch name.",
    );
  }
  return { kind, name: normalized };
}

export function projectImportRemoteSubmission(
  values: ProjectImportRemoteSubmissionValues,
): RemoteImportSubmission {
  const kind =
    values.source === "github-public" ||
    values.source === "github-authenticated"
      ? "github"
      : "git";
  const revision = projectImportRevision(
    values.revisionKind,
    values.revisionValue,
  );
  const historyRevisionError = projectImportHistoryRevisionError(
    values.history,
    revision,
  );
  if (historyRevisionError !== undefined) {
    throw new Error(historyRevisionError);
  }
  const selectedProfile =
    projectImportProvidersForSource(
      values.source,
      values.repositoryUrl,
    ).length > 0 && values.credentialProfileId !== ""
      ? values.credentialProfileId
      : undefined;
  return {
    source: {
      kind,
      repositoryUrl: values.repositoryUrl.normalize("NFC").trim(),
      ...(selectedProfile === undefined
        ? {}
        : { credentialProfileId: selectedProfile }),
      ...(revision === undefined ? {} : { revision }),
    },
    ...(values.history === undefined ? {} : { history: values.history }),
    ...(values.identity === undefined ? {} : { identity: values.identity }),
    ...(values.analysis === undefined ? {} : { analysis: values.analysis }),
  };
}

export function projectImportRepositoryZipSubmission(
  sizeBytes: number,
  repositoryName: string,
  rootMode: "single-directory" | "archive-root",
  identity?: ImportIdentityOptions,
  analysis?: ImportAnalysisOptions,
): UploadImportSubmission {
  return {
    source: {
      kind: "repository-zip",
      sizeBytes,
      repositoryName,
      rootMode,
    },
    ...(identity === undefined ? {} : { identity }),
    ...(analysis === undefined ? {} : { analysis }),
  };
}

export function projectImportCityModelSubmission(
  sizeBytes: number,
): UploadImportSubmission {
  return {
    source: {
      kind: "city-model",
      sizeBytes,
    },
  };
}

function requiredElement<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!(value instanceof HTMLElement)) {
    throw new Error(`Missing required project import element #${id}.`);
  }
  return value as T;
}

interface ProjectImportHistoryControls {
  readonly root: HTMLFieldSetElement;
  readonly enabled: HTMLInputElement;
  readonly options: HTMLElement;
  readonly mode: HTMLSelectElement;
  readonly panels: readonly HTMLElement[];
  readonly commitCount: HTMLInputElement;
  readonly fromInclusive: HTMLInputElement;
  readonly toInclusive: HTMLInputElement;
  readonly dateMaxCommits: HTMLInputElement;
  readonly oldestTagName: HTMLInputElement;
  readonly newestTagName: HTMLInputElement;
  readonly tagMaxCommits: HTMLInputElement;
  readonly sampleEvery: HTMLInputElement;
  readonly frameHelp: HTMLElement;
  readonly error: HTMLElement;
  readonly allInputs: readonly HTMLElement[];
}

function createHistoryInput(
  id: string,
  type: "datetime-local" | "number" | "text",
): HTMLInputElement {
  const input = document.createElement("input");
  input.id = id;
  input.type = type;
  input.autocomplete = "off";
  input.setAttribute(
    "aria-describedby",
    "project-import-history-help project-import-history-frame-help project-import-error-history",
  );
  return input;
}

function createHistoryLabel(
  text: string,
  control: HTMLInputElement | HTMLSelectElement,
): HTMLLabelElement {
  const label = document.createElement("label");
  label.className = "project-import-field";
  label.htmlFor = control.id;
  const title = document.createElement("span");
  title.textContent = text;
  label.append(title, control);
  return label;
}

function configureHistoryCountInput(
  input: HTMLInputElement,
  value: string,
): void {
  input.min = "1";
  input.max = PROJECT_IMPORT_HISTORY_LIMITS.maxCommits.toString();
  input.step = "1";
  input.inputMode = "numeric";
  input.value = value;
  input.defaultValue = value;
}

function createProjectImportHistoryControls(
  remotePanel: HTMLElement,
): ProjectImportHistoryControls {
  const root = document.createElement("fieldset");
  root.className = "project-import-history";
  root.id = "project-import-history";

  const legend = document.createElement("legend");
  legend.textContent = "Repository history";

  const enabled = document.createElement("input");
  enabled.id = "project-import-history-enabled";
  enabled.type = "checkbox";
  enabled.setAttribute("aria-controls", "project-import-history-options");
  enabled.setAttribute("aria-expanded", "false");
  enabled.setAttribute(
    "aria-describedby",
    "project-import-history-help project-import-error-history",
  );
  const toggle = document.createElement("label");
  toggle.className = "project-import-history-toggle";
  toggle.htmlFor = enabled.id;
  const toggleText = document.createElement("span");
  toggleText.textContent = "Create a time-travel history";
  toggle.append(enabled, toggleText);

  const help = document.createElement("p");
  help.id = "project-import-history-help";
  help.className = "project-import-help";
  help.textContent =
    "Optional. Analyze a bounded first-parent history instead of only one snapshot. UTC date values are interpreted exactly as shown.";

  const options = document.createElement("div");
  options.id = "project-import-history-options";
  options.className = "project-import-history-options";
  options.hidden = true;

  const mode = document.createElement("select");
  mode.id = "project-import-history-mode";
  mode.setAttribute(
    "aria-describedby",
    "project-import-history-help project-import-error-history",
  );
  for (const [value, text] of [
    ["commit-count", "Most recent commits"],
    ["date-range", "UTC date range"],
    ["tag-range", "Exact tag range"],
  ] as const) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = text;
    mode.append(option);
  }
  options.append(createHistoryLabel("History range", mode));

  const commitPanel = document.createElement("div");
  commitPanel.className = "project-import-history-fields";
  commitPanel.dataset["historyModePanel"] = "commit-count";
  const commitCount = createHistoryInput(
    "project-import-history-commit-count",
    "number",
  );
  configureHistoryCountInput(commitCount, "50");
  commitPanel.append(createHistoryLabel("Commit count", commitCount));

  const datePanel = document.createElement("div");
  datePanel.className = "project-import-history-fields";
  datePanel.dataset["historyModePanel"] = "date-range";
  datePanel.hidden = true;
  const fromInclusive = createHistoryInput(
    "project-import-history-from",
    "datetime-local",
  );
  fromInclusive.step = "1";
  const toInclusive = createHistoryInput(
    "project-import-history-to",
    "datetime-local",
  );
  toInclusive.step = "1";
  const dateMaxCommits = createHistoryInput(
    "project-import-history-date-max-commits",
    "number",
  );
  configureHistoryCountInput(dateMaxCommits, "100");
  datePanel.append(
    createHistoryLabel("From, inclusive (UTC)", fromInclusive),
    createHistoryLabel("To, inclusive (UTC)", toInclusive),
    createHistoryLabel("Maximum commits", dateMaxCommits),
  );

  const tagPanel = document.createElement("div");
  tagPanel.className = "project-import-history-fields";
  tagPanel.dataset["historyModePanel"] = "tag-range";
  tagPanel.hidden = true;
  const oldestTagName = createHistoryInput(
    "project-import-history-oldest-tag",
    "text",
  );
  oldestTagName.maxLength = 256;
  oldestTagName.autocapitalize = "none";
  oldestTagName.spellcheck = false;
  const newestTagName = createHistoryInput(
    "project-import-history-newest-tag",
    "text",
  );
  newestTagName.maxLength = 256;
  newestTagName.autocapitalize = "none";
  newestTagName.spellcheck = false;
  const tagMaxCommits = createHistoryInput(
    "project-import-history-tag-max-commits",
    "number",
  );
  configureHistoryCountInput(tagMaxCommits, "100");
  tagPanel.append(
    createHistoryLabel("Oldest exact tag", oldestTagName),
    createHistoryLabel("Newest exact tag", newestTagName),
    createHistoryLabel("Maximum commits", tagMaxCommits),
  );

  const sampleEvery = createHistoryInput(
    "project-import-history-sample-every",
    "number",
  );
  sampleEvery.min = "1";
  sampleEvery.max =
    PROJECT_IMPORT_HISTORY_LIMITS.maxSampleEvery.toString();
  sampleEvery.step = "1";
  sampleEvery.inputMode = "numeric";
  sampleEvery.value = "1";
  sampleEvery.defaultValue = "1";

  const frameHelp = document.createElement("p");
  frameHelp.id = "project-import-history-frame-help";
  frameHelp.className = "project-import-field-help";
  frameHelp.setAttribute("role", "status");
  frameHelp.setAttribute("aria-live", "polite");

  options.append(
    commitPanel,
    datePanel,
    tagPanel,
    createHistoryLabel("Sample every N commits", sampleEvery),
    frameHelp,
  );

  const error = document.createElement("p");
  error.id = "project-import-error-history";
  error.className = "project-import-field-error";
  error.dataset["importFieldError"] = "history";
  error.setAttribute("role", "alert");
  error.hidden = true;

  root.append(legend, toggle, help, options, error);
  remotePanel.append(root);
  const panels = Object.freeze([commitPanel, datePanel, tagPanel]);
  const allInputs = Object.freeze([
    enabled,
    mode,
    commitCount,
    fromInclusive,
    toInclusive,
    dateMaxCommits,
    oldestTagName,
    newestTagName,
    tagMaxCommits,
    sampleEvery,
  ]);
  return {
    root,
    enabled,
    options,
    mode,
    panels,
    commitCount,
    fromInclusive,
    toInclusive,
    dateMaxCommits,
    oldestTagName,
    newestTagName,
    tagMaxCommits,
    sampleEvery,
    frameHelp,
    error,
    allInputs,
  };
}

function checkedValue(name: string): string {
  const checked = document.querySelector<HTMLInputElement>(
    `input[name="${name}"]:checked`,
  );
  return checked?.value ?? "";
}

function isProjectImportSource(value: string): value is ProjectImportSource {
  return PROJECT_IMPORT_SOURCE_CHOICES.some((choice) => choice === value);
}

function isProjectImportStep(value: string): value is ProjectImportStep {
  return PROJECT_IMPORT_STEPS.some((step) => step === value);
}

function sourceChoice(): ProjectImportSource {
  const value = checkedValue("project-import-source");
  if (!isProjectImportSource(value)) {
    throw new Error("Choose a project source.");
  }
  return value;
}

function revisionChoice(): string {
  return checkedValue("project-import-revision") || "default";
}

function normalizedOptionalText(value: string): string | undefined {
  const normalized = value.normalize("NFC").trim();
  return normalized === "" ? undefined : normalized;
}

export interface ProjectImportIdentityFieldValues {
  readonly title: string;
  readonly version: string;
}

class ProjectImportIdentityValidationError extends Error {
  public constructor(
    public readonly field: "title" | "version",
    message: string,
  ) {
    super(message);
    this.name = "ProjectImportIdentityValidationError";
  }
}

export function projectImportIdentityOptions(
  values: ProjectImportIdentityFieldValues,
): ImportIdentityOptions | undefined {
  const title = normalizedOptionalText(values.title);
  const version = normalizedOptionalText(values.version);
  if (
    title !== undefined &&
    (title.length > 160 || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(title))
  ) {
    throw new ProjectImportIdentityValidationError(
      "title",
      "City title must be at most 160 safe characters.",
    );
  }
  if (
    version !== undefined &&
    (version.length > 80 || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(version))
  ) {
    throw new ProjectImportIdentityValidationError(
      "version",
      "City version must be at most 80 safe characters.",
    );
  }
  if (title === undefined && version !== undefined) {
    throw new ProjectImportIdentityValidationError(
      "title",
      "Enter a city title when setting a city version.",
    );
  }
  if (title === undefined) return undefined;
  return {
    title,
    ...(version === undefined ? {} : { version }),
  };
}

function optionalInteger(
  rawValue: string,
  label: string,
  minimum: number,
  maximum: number,
  multiplier = 1,
): number | undefined {
  if (rawValue.trim() === "") return undefined;
  const value = Number(rawValue);
  if (
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum ||
    !Number.isSafeInteger(value * multiplier)
  ) {
    throw new Error(
      `${label} must be a whole number from ${minimum.toLocaleString()} to ${maximum.toLocaleString()}.`,
    );
  }
  return value * multiplier;
}

export interface ProjectImportHistoryFieldValues {
  readonly enabled: boolean;
  readonly mode: string;
  readonly commitCount: string;
  readonly fromInclusive: string;
  readonly toInclusive: string;
  readonly dateMaxCommits: string;
  readonly oldestTagName: string;
  readonly newestTagName: string;
  readonly tagMaxCommits: string;
  readonly sampleEvery: string;
}

function requiredHistoryInteger(
  rawValue: string,
  label: string,
): number {
  const value = optionalInteger(
    rawValue,
    label,
    1,
    PROJECT_IMPORT_HISTORY_LIMITS.maxCommits,
  );
  if (value === undefined) {
    throw new Error(`${label} is required.`);
  }
  return value;
}

function canonicalUtcDateTime(rawValue: string, label: string): string {
  const value = rawValue.trim();
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/u.exec(
      value,
    );
  if (match === null) {
    throw new Error(`Enter a valid ${label} UTC date and time.`);
  }
  const [
    ,
    rawYear,
    rawMonth,
    rawDay,
    rawHour,
    rawMinute,
    rawSecond = "0",
    rawMillisecond = "0",
  ] = match;
  const year = Number(rawYear);
  const month = Number(rawMonth);
  const day = Number(rawDay);
  const hour = Number(rawHour);
  const minute = Number(rawMinute);
  const second = Number(rawSecond);
  const millisecond = Number(rawMillisecond.padEnd(3, "0"));
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, millisecond);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second ||
    date.getUTCMilliseconds() !== millisecond
  ) {
    throw new Error(`Enter a valid ${label} UTC date and time.`);
  }
  return date.toISOString();
}

function exactHistoryTagName(rawValue: string, label: string): string {
  const value = rawValue.normalize("NFC");
  const components = value.split("/");
  if (
    value.length === 0 ||
    value !== value.trim() ||
    value.length > PROJECT_IMPORT_HISTORY_LIMITS.maxTagNameBytes ||
    new TextEncoder().encode(value).byteLength >
      PROJECT_IMPORT_HISTORY_LIMITS.maxTagNameBytes ||
    /[\s\\~^:?*]|\[|\]|\p{Cc}|\p{Cf}|\p{Cs}/u.test(value) ||
    value === "@" ||
    value.startsWith("-") ||
    value.includes("..") ||
    value.includes("@{") ||
    value.startsWith("refs/") ||
    components.some(
      (component) =>
        component.length === 0 ||
        component.startsWith(".") ||
        component.endsWith(".") ||
        component.toLocaleLowerCase("en-US").endsWith(".lock"),
    )
  ) {
    throw new Error(
      `Enter an exact valid ${label} tag name of at most ${PROJECT_IMPORT_HISTORY_LIMITS.maxTagNameBytes} UTF-8 bytes.`,
    );
  }
  return value;
}

export function projectImportHistoryRevisionError(
  history: RemoteImportHistorySelection | undefined,
  revision: ImportRevision | undefined,
): string | undefined {
  return history?.mode === "tag-range" && revision !== undefined
    ? "Choose the repository default revision when using a tag-range history."
    : undefined;
}

function assertHistoryFrameLimit(
  maximumCommits: number,
  sampleEvery: number,
): void {
  const maximumFrames =
    Math.ceil((maximumCommits - 1) / sampleEvery) + 1;
  if (maximumFrames > PROJECT_IMPORT_HISTORY_LIMITS.maxFrames) {
    throw new Error(
      `This selection could create ${maximumFrames.toLocaleString()} frames. Increase the sample interval or reduce the commit limit to create at most ${PROJECT_IMPORT_HISTORY_LIMITS.maxFrames.toLocaleString()} frames.`,
    );
  }
}

export function projectImportHistorySelection(
  values: ProjectImportHistoryFieldValues,
): RemoteImportHistorySelection | undefined {
  if (!values.enabled) return undefined;
  const sampleEvery = optionalInteger(
    values.sampleEvery,
    "Sample interval",
    1,
    PROJECT_IMPORT_HISTORY_LIMITS.maxSampleEvery,
  );
  const resolvedSampleEvery = sampleEvery ?? 1;
  const sample = sampleEvery === undefined ? {} : { sampleEvery };

  if (values.mode === "commit-count") {
    const commitCount = requiredHistoryInteger(
      values.commitCount,
      "Commit count",
    );
    assertHistoryFrameLimit(commitCount, resolvedSampleEvery);
    return {
      mode: values.mode,
      commitCount,
      ...sample,
    };
  }
  if (values.mode === "date-range") {
    const fromInclusive = canonicalUtcDateTime(
      values.fromInclusive,
      "starting",
    );
    const toInclusive = canonicalUtcDateTime(
      values.toInclusive,
      "ending",
    );
    if (Date.parse(fromInclusive) > Date.parse(toInclusive)) {
      throw new Error(
        "The starting UTC date must not be later than the ending UTC date.",
      );
    }
    const maxCommits = requiredHistoryInteger(
      values.dateMaxCommits,
      "Date-range commit limit",
    );
    assertHistoryFrameLimit(maxCommits, resolvedSampleEvery);
    return {
      mode: values.mode,
      fromInclusive,
      toInclusive,
      maxCommits,
      ...sample,
    };
  }
  if (values.mode === "tag-range") {
    const oldestTagName = exactHistoryTagName(
      values.oldestTagName,
      "oldest",
    );
    const newestTagName = exactHistoryTagName(
      values.newestTagName,
      "newest",
    );
    const maxCommits = requiredHistoryInteger(
      values.tagMaxCommits,
      "Tag-range commit limit",
    );
    assertHistoryFrameLimit(maxCommits, resolvedSampleEvery);
    return {
      mode: values.mode,
      oldestTagName,
      newestTagName,
      maxCommits,
      ...sample,
    };
  }
  throw new Error("Choose a repository history range.");
}

export interface ProjectImportAnalysisFieldValues {
  readonly maxRetainedFiles: string;
  readonly maxFileMib: string;
  readonly maxTotalMib: string;
  readonly timeoutSeconds: string;
}

export function projectImportAnalysisOptions(
  values: ProjectImportAnalysisFieldValues,
): ImportAnalysisOptions | undefined {
  const maxRetainedFiles = optionalInteger(
    values.maxRetainedFiles,
    "Retained files",
    1,
    PROJECT_IMPORT_ANALYSIS_LIMITS.maxRetainedFiles,
  );
  const maxFileBytes = optionalInteger(
    values.maxFileMib,
    "Per-file MiB",
    1,
    PROJECT_IMPORT_ANALYSIS_LIMITS.maxFileMib,
    MEBIBYTE,
  );
  const maxTotalBytes = optionalInteger(
    values.maxTotalMib,
    "Total MiB",
    1,
    PROJECT_IMPORT_ANALYSIS_LIMITS.maxTotalMib,
    MEBIBYTE,
  );
  const timeoutMs = optionalInteger(
    values.timeoutSeconds,
    "Timeout seconds",
    1,
    PROJECT_IMPORT_ANALYSIS_LIMITS.timeoutSeconds,
    1_000,
  );
  if (
    maxFileBytes !== undefined &&
    maxTotalBytes !== undefined &&
    maxFileBytes > maxTotalBytes
  ) {
    throw new Error("Per-file MiB must not exceed total MiB.");
  }
  return maxRetainedFiles === undefined &&
    maxFileBytes === undefined &&
    maxTotalBytes === undefined &&
    timeoutMs === undefined
    ? undefined
    : {
        ...(maxRetainedFiles === undefined
          ? {}
          : { maxRetainedFiles }),
        ...(maxFileBytes === undefined ? {} : { maxFileBytes }),
        ...(maxTotalBytes === undefined ? {} : { maxTotalBytes }),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      };
}

function messageOf(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "The import could not be completed.";
}

function jobPhaseLabel(phase: string): string {
  const words = phase
    .replace(/[-_]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (words === "") return "Analyzing project";
  return words[0]!.toUpperCase() + words.slice(1);
}

export function installProjectImportDialog(
  options: InstallProjectImportDialogOptions,
): ProjectImportDialogHandle {
  const dialog = requiredElement<HTMLDialogElement>(
    "project-import-dialog",
  );
  const form = requiredElement<HTMLFormElement>("project-import-form");
  const openButton = requiredElement<HTMLButtonElement>(
    "project-import-open",
  );
  const closeButton = requiredElement<HTMLButtonElement>(
    "project-import-close",
  );
  const signOutButton = requiredElement<HTMLButtonElement>(
    "project-import-sign-out",
  );
  const authSection = requiredElement<HTMLElement>("project-import-auth");
  const tokenInput = requiredElement<HTMLInputElement>(
    "project-import-token",
  );
  const authenticateButton = requiredElement<HTMLButtonElement>(
    "project-import-authenticate",
  );
  const authStatus = requiredElement<HTMLElement>(
    "project-import-auth-status",
  );
  const sourceInputs = [
    ...form.querySelectorAll<HTMLInputElement>(
      'input[name="project-import-source"]',
    ),
  ];
  const revisionInputs = [
    ...form.querySelectorAll<HTMLInputElement>(
      'input[name="project-import-revision"]',
    ),
  ];
  const stepSections = new Map<ProjectImportStep, HTMLElement>();
  const stepIndicators = new Map<ProjectImportStep, HTMLElement>();
  const stepHeadings = new Map<ProjectImportStep, HTMLElement>();
  for (const step of PROJECT_IMPORT_STEPS) {
    const section = requiredElement<HTMLElement>(
      `project-import-step-${step}`,
    );
    stepSections.set(step, section);
    const heading = section.querySelector<HTMLElement>("h3");
    if (heading === null) {
      throw new Error(`Missing project import step heading ${step}.`);
    }
    stepHeadings.set(step, heading);
    const indicator = form.querySelector<HTMLElement>(
      `[data-import-step-indicator="${step}"]`,
    );
    if (indicator === null) {
      throw new Error(`Missing project import step indicator ${step}.`);
    }
    stepIndicators.set(step, indicator);
  }
  const sourcePanels = [
    ...form.querySelectorAll<HTMLElement>("[data-import-source-panel]"),
  ];
  const remotePanel = sourcePanels.find(
    (panel) => panel.dataset["importSourcePanel"] === "remote",
  );
  if (remotePanel === undefined) {
    throw new Error("Missing remote project import panel.");
  }
  const historyControls =
    createProjectImportHistoryControls(remotePanel);
  const directoryInput = requiredElement<HTMLInputElement>(
    "project-import-directory",
  );
  const zipInput = requiredElement<HTMLInputElement>("project-import-zip");
  const zipNameInput = requiredElement<HTMLInputElement>(
    "project-import-zip-name",
  );
  const zipRootSelect = requiredElement<HTMLSelectElement>(
    "project-import-zip-root",
  );
  const modelInput = requiredElement<HTMLInputElement>(
    "project-import-model",
  );
  const repositoryUrlInput = requiredElement<HTMLInputElement>(
    "project-import-repository-url",
  );
  const profileWrap = requiredElement<HTMLElement>(
    "project-import-profile-wrap",
  );
  const profileSelect = requiredElement<HTMLSelectElement>(
    "project-import-profile",
  );
  const revisionValueWrap = requiredElement<HTMLElement>(
    "project-import-revision-value-wrap",
  );
  const revisionValueInput = requiredElement<HTMLInputElement>(
    "project-import-revision-value",
  );
  const revisionLabel = requiredElement<HTMLElement>(
    "project-import-revision-label",
  );
  const titleInput = requiredElement<HTMLInputElement>(
    "project-import-identity-title",
  );
  const versionInput = requiredElement<HTMLInputElement>(
    "project-import-identity-version",
  );
  const maxFilesInput = requiredElement<HTMLInputElement>(
    "project-import-max-files",
  );
  const maxFileMibInput = requiredElement<HTMLInputElement>(
    "project-import-max-file-mib",
  );
  const maxTotalMibInput = requiredElement<HTMLInputElement>(
    "project-import-max-total-mib",
  );
  const timeoutSecondsInput = requiredElement<HTMLInputElement>(
    "project-import-timeout-seconds",
  );
  maxFilesInput.max =
    PROJECT_IMPORT_ANALYSIS_LIMITS.maxRetainedFiles.toString();
  maxFileMibInput.max =
    PROJECT_IMPORT_ANALYSIS_LIMITS.maxFileMib.toString();
  maxTotalMibInput.max =
    PROJECT_IMPORT_ANALYSIS_LIMITS.maxTotalMib.toString();
  timeoutSecondsInput.max =
    PROJECT_IMPORT_ANALYSIS_LIMITS.timeoutSeconds.toString();
  const reviewSource = requiredElement<HTMLElement>(
    "project-import-review-source",
  );
  const reviewInput = requiredElement<HTMLElement>(
    "project-import-review-input",
  );
  const reviewRevision = requiredElement<HTMLElement>(
    "project-import-review-revision",
  );
  const progressWrap = requiredElement<HTMLElement>(
    "project-import-progress",
  );
  const progressMeter = requiredElement<HTMLProgressElement>(
    "project-import-progress-meter",
  );
  const progressStatus = requiredElement<HTMLElement>(
    "project-import-status",
  );
  const progressDetail = requiredElement<HTMLElement>(
    "project-import-progress-detail",
  );
  const persistenceWarning = requiredElement<HTMLElement>(
    "project-import-persistence-warning",
  );
  const errorSection = requiredElement<HTMLElement>(
    "project-import-errors",
  );
  const errorList = requiredElement<HTMLUListElement>(
    "project-import-error-list",
  );
  const backButton = requiredElement<HTMLButtonElement>(
    "project-import-back",
  );
  const nextButton = requiredElement<HTMLButtonElement>(
    "project-import-next",
  );
  const submitButton = requiredElement<HTMLButtonElement>(
    "project-import-submit",
  );
  const retryButton = requiredElement<HTMLButtonElement>(
    "project-import-retry",
  );
  const restartButton = requiredElement<HTMLButtonElement>(
    "project-import-restart",
  );
  const removeResultButton = requiredElement<HTMLButtonElement>(
    "project-import-remove-result",
  );
  const cancelButton = requiredElement<HTMLButtonElement>(
    "project-import-cancel",
  );
  const liveStatus = requiredElement<HTMLElement>(
    "project-import-live-status",
  );

  const fieldBindings = new Map<
    ProjectImportFieldKey,
    ProjectImportFieldBinding
  >([
    [
      "directory",
      {
        error: requiredElement("project-import-error-directory"),
        controls: [directoryInput],
        step: "details",
      },
    ],
    [
      "zip",
      {
        error: requiredElement("project-import-error-zip"),
        controls: [zipInput],
        step: "details",
      },
    ],
    [
      "model",
      {
        error: requiredElement("project-import-error-model"),
        controls: [modelInput],
        step: "details",
      },
    ],
    [
      "repositoryName",
      {
        error: requiredElement("project-import-error-repository-name"),
        controls: [zipNameInput, zipRootSelect],
        step: "details",
      },
    ],
    [
      "repositoryUrl",
      {
        error: requiredElement("project-import-error-repository-url"),
        controls: [repositoryUrlInput],
        step: "details",
      },
    ],
    [
      "credentialProfileId",
      {
        error: requiredElement("project-import-error-profile"),
        controls: [profileSelect],
        step: "details",
      },
    ],
    [
      "revision",
      {
        error: requiredElement("project-import-error-revision"),
        controls: [revisionValueInput, ...revisionInputs],
        step: "details",
      },
    ],
    [
      "history",
      {
        error: historyControls.error,
        controls: historyControls.allInputs,
        step: "details",
      },
    ],
    [
      "title",
      {
        error: requiredElement("project-import-error-title"),
        controls: [titleInput],
        step: "options",
      },
    ],
    [
      "version",
      {
        error: requiredElement("project-import-error-version"),
        controls: [versionInput],
        step: "options",
      },
    ],
    [
      "analysis",
      {
        error: requiredElement("project-import-error-analysis"),
        controls: [
          maxFilesInput,
          maxFileMibInput,
          maxTotalMibInput,
          timeoutSecondsInput,
        ],
        step: "options",
      },
    ],
  ]);

  const viewerUrl = new URL(
    options.viewerUrl?.href ?? window.location.href,
  );
  const api = new ViewerImportApiClient(viewerUrl);
  const archiveClient = new ProjectDirectoryArchiveClient();
  let currentStep: ProjectImportStep = "source";
  let currentState: ImportControllerState = { status: "initializing" };
  let profiles: readonly ImportCredentialProfile[] = Object.freeze([]);
  let initialized = false;
  let disposed = false;
  let packagingController: AbortController | undefined;
  let packagingGeneration = 0;
  let scrubbedJobId: string | undefined;
  let sessionCanSignOut = false;

  const controller = new ImportController({
    api,
    loadGateway: options.loadGateway,
    viewerUrl,
    onModelReady: options.onModelReady,
    ...(options.onSignedOut === undefined
      ? {}
      : { onSignedOut: options.onSignedOut }),
    ...(options.onAuthenticated === undefined
      ? {}
      : { onAuthenticated: options.onAuthenticated }),
    ...(options.onAuthorizationLost === undefined
      ? {}
      : { onAuthorizationLost: options.onAuthorizationLost }),
    ...(options.onResultRemoved === undefined
      ? {}
      : { onResultRemoved: options.onResultRemoved }),
    onStateChange: (state) => {
      const previousState = currentState;
      currentState = state;
      if (state.status === "idle") profiles = state.profiles;
      if (controller.canSignOut) sessionCanSignOut = true;
      if (state.status === "authorization-required") {
        sessionCanSignOut = false;
      }
      renderControllerState(state, previousState);
    },
  });

  function clearErrors(): void {
    errorList.replaceChildren();
    errorSection.hidden = true;
    for (const binding of fieldBindings.values()) {
      binding.error.textContent = "";
      binding.error.hidden = true;
      for (const control of binding.controls) {
        control.removeAttribute("aria-invalid");
      }
    }
  }

  function showFieldError(
    field: ProjectImportFieldKey,
    message: string,
  ): HTMLElement {
    const binding = fieldBindings.get(field)!;
    binding.error.textContent = message;
    binding.error.hidden = false;
    for (const control of binding.controls) {
      control.setAttribute("aria-invalid", "true");
    }
    return binding.controls[0]!;
  }

  function showSummaryErrors(messages: readonly string[]): void {
    errorList.replaceChildren();
    for (const message of messages) {
      const item = document.createElement("li");
      item.textContent = message;
      errorList.append(item);
    }
    errorSection.hidden = messages.length === 0;
  }

  function showValidationFailures(
    failures: readonly FormValidationFailure[],
  ): void {
    clearErrors();
    if (failures.length === 0) return;
    let earliestStep: ProjectImportStep = failures[0]!.field === "analysis"
      ? "options"
      : fieldBindings.get(failures[0]!.field)!.step;
    let firstControl: HTMLElement | undefined;
    for (const failure of failures) {
      const binding = fieldBindings.get(failure.field)!;
      const control = showFieldError(failure.field, failure.message);
      if (firstControl === undefined) {
        firstControl = control;
        earliestStep = binding.step;
      }
    }
    setStep(earliestStep);
    firstControl?.focus();
    liveStatus.textContent = failures[0]!.message;
  }

  function showServerFieldErrors(
    fields: readonly ImportFieldError[],
  ): boolean {
    const failures: FormValidationFailure[] = [];
    const unmatched: string[] = [];
    for (const field of fields) {
      const key = projectImportFieldForServerPath(
        field.path,
        sourceChoice(),
      );
      if (key === undefined) unmatched.push(field.message);
      else failures.push({ field: key, message: field.message });
    }
    if (failures.length > 0) showValidationFailures(failures);
    if (unmatched.length > 0) showSummaryErrors(unmatched);
    return failures.length > 0;
  }

  function setStep(
    step: ProjectImportStep,
    announceUserTransition = false,
  ): void {
    currentStep = step;
    for (const [candidate, section] of stepSections) {
      section.hidden = candidate !== step;
    }
    const activeIndex = PROJECT_IMPORT_STEPS.indexOf(step);
    for (const [candidate, indicator] of stepIndicators) {
      const index = PROJECT_IMPORT_STEPS.indexOf(candidate);
      if (candidate === step) {
        indicator.setAttribute("aria-current", "step");
      } else {
        indicator.removeAttribute("aria-current");
      }
      if (index < activeIndex) indicator.dataset["complete"] = "true";
      else delete indicator.dataset["complete"];
    }
    if (step === "progress" && scrubbedJobId === undefined) updateReview();
    if (announceUserTransition) {
      const heading = stepHeadings.get(step)!;
      heading.focus();
      liveStatus.textContent =
        `Step ${activeIndex + 1} of ${PROJECT_IMPORT_STEPS.length}: ${heading.textContent?.trim() ?? ""}.`;
    }
    renderNavigation();
  }

  function isImportBusy(): boolean {
    return (
      packagingController !== undefined ||
      currentState.status === "preparing" ||
      currentState.status === "job" ||
      currentState.status === "recovering" ||
      currentState.status === "opening-artifact" ||
      currentState.status === "removing-result" ||
      currentState.status === "signing-out"
    );
  }

  function renderNavigation(): void {
    const authorizationRequired =
      currentState.status === "authorization-required";
    const busy = isImportBusy();
    const navigationLocked = projectImportNavigationLocked(
      currentState.status,
    );
    dialog.dataset["busy"] = String(busy);
    backButton.hidden =
      authorizationRequired ||
      currentStep === "source" ||
      busy ||
      navigationLocked;
    nextButton.hidden =
      authorizationRequired ||
      currentStep === "progress" ||
      busy ||
      navigationLocked;
    submitButton.hidden =
      authorizationRequired ||
      currentStep !== "progress" ||
      busy ||
      currentState.status === "initializing" ||
      currentState.status === "unavailable" ||
      currentState.status === "artifact-failed" ||
      currentState.status === "removal-failed" ||
      currentState.status === "sign-out-failed" ||
      currentState.status === "terminal" ||
      currentState.status === "completed";
    cancelButton.hidden =
      !busy ||
      currentState.status === "opening-artifact" ||
      currentState.status === "removing-result" ||
      currentState.status === "signing-out" ||
      (currentState.status === "preparing" &&
        currentState.cancelling) ||
      (currentState.status === "job" && currentState.cancelling);
    signOutButton.hidden =
      !sessionCanSignOut ||
      currentState.status === "signing-out" ||
      currentState.status === "removing-result";
    restartButton.hidden =
      currentStep !== "progress" ||
      (currentState.status !== "artifact-failed" &&
        currentState.status !== "completed");
    removeResultButton.hidden =
      currentStep !== "progress" ||
      (currentState.status !== "artifact-failed" &&
        currentState.status !== "completed" &&
        currentState.status !== "removal-failed");
    removeResultButton.textContent =
      currentState.status === "removal-failed"
        ? "Retry removal"
        : "Remove stored import";
    if (
      currentStep !== "progress" ||
      currentState.status !== "artifact-failed" &&
      currentState.status !== "removal-failed" &&
      currentState.status !== "terminal" &&
      currentState.status !== "unavailable" &&
      currentState.status !== "sign-out-failed" &&
      !(currentState.status === "request-failed" && currentState.retryable)
    ) {
      retryButton.hidden = true;
    }
  }

  function renderSourcePanels(): void {
    const source = sourceChoice();
    const panel =
      source === "directory" ||
      source === "zip" ||
      source === "city-model"
        ? source
        : "remote";
    for (const sourcePanel of sourcePanels) {
      sourcePanel.hidden =
        sourcePanel.dataset["importSourcePanel"] !== panel;
    }

    switch (source) {
      case "github-public":
      case "github-authenticated":
        repositoryUrlInput.placeholder =
          "https://github.com/owner/repository";
        break;
      case "azure-devops":
        repositoryUrlInput.placeholder =
          "https://dev.azure.com/organization/project/_git/repository";
        break;
      case "git":
        repositoryUrlInput.placeholder =
          "https://git.example/project/repository.git";
        break;
      case "directory":
      case "zip":
      case "city-model":
        break;
    }
    renderProfiles();
  }

  function renderProfiles(): void {
    const source = sourceChoice();
    const providers = projectImportProvidersForSource(
      source,
      repositoryUrlInput.value,
    );
    profileWrap.hidden = providers.length === 0;
    const previous = profileSelect.value;
    profileSelect.replaceChildren();
    if (providers.length === 0) return;
    const required = source === "github-authenticated";
    const emptyOption = document.createElement("option");
    emptyOption.value = "";
    emptyOption.textContent = required
      ? "Choose a configured profile"
      : "Use the server identity";
    profileSelect.append(emptyOption);
    for (const provider of providers) {
      const group = document.createElement("optgroup");
      group.label =
        provider === "github"
          ? "GitHub profiles"
          : provider === "azure-devops"
            ? "Azure DevOps profiles"
            : "Generic HTTPS profiles";
      for (const profile of profiles) {
        if (profile.provider !== provider) continue;
        const option = document.createElement("option");
        option.value = profile.id;
        option.textContent = profile.label;
        group.append(option);
      }
      if (group.childElementCount > 0) profileSelect.append(group);
    }
    if (
      previous !== "" &&
      [...profileSelect.options].some(
        (option) => option.value === previous,
      )
    ) {
      profileSelect.value = previous;
    }
  }

  function historyFieldValues(): ProjectImportHistoryFieldValues {
    return {
      enabled: historyControls.enabled.checked,
      mode: historyControls.mode.value,
      commitCount: historyControls.commitCount.value,
      fromInclusive: historyControls.fromInclusive.value,
      toInclusive: historyControls.toInclusive.value,
      dateMaxCommits: historyControls.dateMaxCommits.value,
      oldestTagName: historyControls.oldestTagName.value,
      newestTagName: historyControls.newestTagName.value,
      tagMaxCommits: historyControls.tagMaxCommits.value,
      sampleEvery: historyControls.sampleEvery.value,
    };
  }

  function historyCommitBound(): number | undefined {
    const input =
      historyControls.mode.value === "commit-count"
        ? historyControls.commitCount
        : historyControls.mode.value === "date-range"
          ? historyControls.dateMaxCommits
          : historyControls.mode.value === "tag-range"
            ? historyControls.tagMaxCommits
            : undefined;
    if (input === undefined || input.value.trim() === "") return undefined;
    const value = Number(input.value);
    return Number.isSafeInteger(value) && value > 0
      ? value
      : undefined;
  }

  function renderHistory(): void {
    const enabled = historyControls.enabled.checked;
    historyControls.options.hidden = !enabled;
    historyControls.enabled.setAttribute(
      "aria-expanded",
      String(enabled),
    );
    for (const panel of historyControls.panels) {
      panel.hidden =
        panel.dataset["historyModePanel"] !== historyControls.mode.value;
    }
    const bound = historyCommitBound();
    const sampleEvery = Number(historyControls.sampleEvery.value);
    if (
      !enabled ||
      bound === undefined ||
      !Number.isSafeInteger(sampleEvery) ||
      sampleEvery < 1
    ) {
      historyControls.frameHelp.textContent =
        `History imports are limited to ${PROJECT_IMPORT_HISTORY_LIMITS.maxCommits.toLocaleString()} commits and ${PROJECT_IMPORT_HISTORY_LIMITS.maxFrames.toLocaleString()} frames.`;
      return;
    }
    const frames = Math.ceil((bound - 1) / sampleEvery) + 1;
    historyControls.frameHelp.textContent =
      `This range can produce up to ${frames.toLocaleString()} animation ${frames === 1 ? "frame" : "frames"}.`;
  }

  function historyReviewText(): string {
    if (!historyControls.enabled.checked) return "Single snapshot";
    try {
      const selection = projectImportHistorySelection(
        historyFieldValues(),
      );
      if (selection === undefined) return "Single snapshot";
      switch (selection.mode) {
        case "commit-count":
          return `${selection.commitCount.toLocaleString()} recent commits`;
        case "date-range":
          return `${selection.fromInclusive} to ${selection.toInclusive}`;
        case "tag-range":
          return `${selection.oldestTagName} to ${selection.newestTagName}`;
      }
    } catch {
      return "History settings incomplete";
    }
  }

  function renderRevision(): void {
    const kind = revisionChoice();
    revisionValueWrap.hidden = kind === "default";
    revisionValueInput.maxLength = kind === "commit" ? 40 : 256;
    revisionLabel.textContent =
      kind === "branch"
        ? "Branch name"
        : kind === "tag"
          ? "Tag name"
          : kind === "commit"
            ? "Exact commit SHA"
            : "Revision value";
    revisionValueInput.placeholder =
      kind === "commit" ? "0123456789abcdef…" : "";
  }

  function resetProgress(): void {
    progressWrap.hidden = true;
    progressMeter.removeAttribute("value");
    progressMeter.max = 1;
    progressStatus.textContent = "Ready to import";
    progressDetail.textContent = "";
  }

  function resetWizard(): void {
    form.reset();
    scrubbedJobId = undefined;
    clearErrors();
    resetProgress();
    setStep("source");
    retryButton.hidden = true;
    retryButton.textContent = "Retry";
    restartButton.hidden = true;
    renderSourcePanels();
    renderRevision();
    renderHistory();
  }

  function scrubAcceptedSubmission(jobId: string): void {
    if (scrubbedJobId === jobId) return;
    scrubbedJobId = jobId;
    directoryInput.value = "";
    zipInput.value = "";
    modelInput.value = "";
    zipNameInput.value = "";
    repositoryUrlInput.value = "";
    profileSelect.value = "";
    revisionValueInput.value = "";
    historyControls.enabled.checked = false;
    historyControls.fromInclusive.value = "";
    historyControls.toInclusive.value = "";
    historyControls.oldestTagName.value = "";
    historyControls.newestTagName.value = "";
    historyControls.commitCount.value = "";
    historyControls.dateMaxCommits.value = "";
    historyControls.tagMaxCommits.value = "";
    historyControls.sampleEvery.value = "";
    renderHistory();
    titleInput.value = "";
    versionInput.value = "";
    maxFilesInput.value = "";
    maxFileMibInput.value = "";
    maxTotalMibInput.value = "";
    timeoutSecondsInput.value = "";
    reviewInput.textContent = "Accepted by the Code City server";
    reviewRevision.textContent = "Resolved by the Code City server";
  }

  function ensureInitialized(): void {
    if (initialized) return;
    initialized = true;
    controller.initialize();
  }

  function open(): void {
    if (disposed) return;
    if (projectImportShouldResetOnOpen(currentState.status)) {
      controller.forgetCompleted();
      resetWizard();
    }
    ensureInitialized();
    if (!dialog.open) dialog.showModal();
    renderControllerState(currentState);
  }

  function close(): void {
    if (packagingController !== undefined) cancelPackaging();
    if (dialog.open) dialog.close();
  }

  function setIndeterminateProgress(
    status: string,
    detail = "",
  ): void {
    progressWrap.hidden = false;
    progressMeter.removeAttribute("value");
    progressMeter.max = 1;
    progressStatus.textContent = status;
    progressDetail.textContent = detail;
  }

  function setMeasuredProgress(
    status: string,
    current: number,
    total: number,
    detail = "",
  ): void {
    progressWrap.hidden = false;
    progressMeter.max = Math.max(1, total);
    progressMeter.value = Math.min(current, progressMeter.max);
    progressStatus.textContent = status;
    progressDetail.textContent = detail;
  }

  function renderControllerState(
    state: ImportControllerState,
    previousState?: ImportControllerState,
  ): void {
    const warning = projectImportPersistenceWarning(state);
    persistenceWarning.textContent = warning ?? "";
    persistenceWarning.hidden = warning === undefined;
    authSection.hidden = state.status !== "authorization-required";
    authStatus.textContent =
      state.status === "authorization-required"
        ? (state.message ?? "")
        : "";

    switch (state.status) {
      case "initializing":
        if (dialog.open) {
          setIndeterminateProgress("Connecting to the Code City server…");
        }
        break;
      case "authorization-required":
        sessionCanSignOut = false;
        if (state.resumeJobId !== undefined && !dialog.open) {
          dialog.showModal();
        }
        break;
      case "idle":
        sessionCanSignOut =
          state.authorization.mode === "shared-secret" &&
          state.authorization.authenticated;
        profiles = state.profiles;
        renderProfiles();
        if (
          previousState?.status === "preparing" &&
          previousState.cancelling
        ) {
          resetProgress();
          setStep("source");
          liveStatus.textContent =
            "Import cancelled before server acceptance.";
        }
        if (previousState?.status === "removing-result") {
          resetWizard();
          liveStatus.textContent =
            "Stored import and its server artifacts were removed.";
        }
        if (!state.persistenceAvailable) {
          liveStatus.textContent =
            "Import jobs work, but this browser cannot save recovery state.";
        }
        break;
      case "preparing":
        setStep("progress");
        setIndeterminateProgress(
          state.cancelling
            ? "Cancelling import…"
            : state.phase === "reserving-upload"
              ? "Reserving a protected upload…"
              : state.phase === "uploading"
                ? "Uploading project…"
                : "Submitting import…",
        );
        break;
      case "job": {
        setStep("progress");
        scrubAcceptedSubmission(state.job.id);
        const progress = state.job.progress;
        const label = state.cancelling
          ? "Cancelling import…"
          : progress === undefined
            ? state.job.state === "queued"
              ? "Import queued"
              : "Analyzing project"
            : jobPhaseLabel(progress.phase);
        if (
          progress?.current !== undefined &&
          progress.total !== undefined
        ) {
          setMeasuredProgress(
            label,
            progress.current,
            progress.total,
            `${progress.current.toLocaleString()} of ${progress.total.toLocaleString()}`,
          );
        } else {
          setIndeterminateProgress(label);
        }
        break;
      }
      case "recovering":
        setStep("progress");
        setIndeterminateProgress(
          "Reconnecting to the import job…",
          state.message,
        );
        retryButton.textContent = "Retry now";
        retryButton.hidden = false;
        break;
      case "opening-artifact":
        setStep("progress");
        scrubAcceptedSubmission(state.job.id);
        setIndeterminateProgress("Opening generated city…");
        break;
      case "request-failed": {
        const mapped = showServerFieldErrors(state.fields);
        if (!mapped) {
          setStep("progress");
          showSummaryErrors([state.message]);
        }
        if (state.retryable && !mapped) {
          retryButton.textContent = "Retry";
          retryButton.hidden = false;
        }
        break;
      }
      case "terminal":
        setStep("progress");
        scrubAcceptedSubmission(state.job.id);
        setMeasuredProgress(
          state.job.state === "cancelled"
            ? "Import cancelled"
            : "Import failed",
          1,
          1,
          state.job.error?.message ?? "",
        );
        showSummaryErrors([
          state.job.error?.message ??
            (state.job.state === "cancelled"
              ? "The import was cancelled."
              : "The import failed."),
        ]);
        retryButton.textContent = "Start another import";
        retryButton.hidden = false;
        break;
      case "artifact-failed":
        setStep("progress");
        scrubAcceptedSubmission(state.job.id);
        setMeasuredProgress(
          "City generated, but could not be opened",
          1,
          1,
          state.message,
        );
        showSummaryErrors([state.message]);
        retryButton.textContent = "Retry opening city";
        retryButton.hidden = false;
        restartButton.hidden = false;
        break;
      case "completed":
        scrubAcceptedSubmission(state.job.id);
        setMeasuredProgress("City opened", 1, 1);
        liveStatus.textContent = "Project import completed and opened.";
        if (
          previousState?.status === "opening-artifact" &&
          dialog.open
        ) {
          dialog.close();
        }
        break;
      case "removing-result":
        setStep("progress");
        scrubAcceptedSubmission(state.job.id);
        setIndeterminateProgress(
          "Removing stored import...",
          "Waiting for any open artifact response to finish.",
        );
        liveStatus.textContent =
          "Removing the completed import from the Code City server.";
        break;
      case "removal-failed":
        setStep("progress");
        scrubAcceptedSubmission(state.job.id);
        setMeasuredProgress(
          "Stored import could not be removed",
          1,
          1,
          state.message,
        );
        showSummaryErrors([state.message]);
        retryButton.hidden = true;
        break;
      case "unavailable":
        setStep("progress");
        setIndeterminateProgress("Project import is unavailable");
        showSummaryErrors([
          `${state.message} Open this viewer from the self-hosted Code City server to import projects.`,
        ]);
        retryButton.textContent = "Check again";
        retryButton.hidden = false;
        break;
      case "signing-out":
        setStep("progress");
        setIndeterminateProgress("Signing out…");
        liveStatus.textContent =
          "Revoking the Code City browser session.";
        break;
      case "sign-out-failed":
        setStep("progress");
        setIndeterminateProgress("Sign out could not be confirmed");
        showSummaryErrors([state.message]);
        retryButton.textContent = "Retry sign out";
        retryButton.hidden = false;
        break;
    }
    renderNavigation();
  }

  function updateReview(): void {
    const source = sourceChoice();
    reviewSource.textContent = SOURCE_LABELS[source];
    switch (source) {
      case "directory": {
        const file = directoryInput.files?.[0];
        reviewInput.textContent =
          file?.webkitRelativePath.split("/")[0] ?? "No directory selected";
        break;
      }
      case "zip":
        reviewInput.textContent =
          zipInput.files?.[0]?.name ?? "No ZIP selected";
        break;
      case "city-model":
        reviewInput.textContent =
          modelInput.files?.[0]?.name ?? "No model selected";
        break;
      case "github-public":
      case "github-authenticated":
      case "azure-devops":
      case "git":
        reviewInput.textContent =
          repositoryUrlInput.value.trim() || "No repository URL";
        break;
    }
    const revisionKind = revisionChoice();
    if (
      source === "directory" ||
      source === "zip" ||
      source === "city-model"
    ) {
      reviewRevision.textContent = "Uploaded content";
      return;
    }
    const revision =
      revisionKind === "default"
        ? "Repository default"
        : `${revisionKind}: ${revisionValueInput.value.trim() || "not set"}`;
    reviewRevision.textContent = historyControls.enabled.checked
      ? `${revision}; ${historyReviewText()}`
      : revision;
  }

  function validateDetails(): readonly FormValidationFailure[] {
    const failures: FormValidationFailure[] = [];
    const source = sourceChoice();
    if (source === "directory") {
      if ((directoryInput.files?.length ?? 0) === 0) {
        failures.push({
          field: "directory",
          message: "Choose a repository directory.",
        });
      }
      return failures;
    }
    if (source === "zip") {
      const file = zipInput.files?.[0];
      if (file === undefined) {
        failures.push({
          field: "zip",
          message: "Choose a repository ZIP archive.",
        });
      } else {
        const sizeError = projectImportUploadSizeError("zip", file.size);
        if (sizeError !== undefined) {
          failures.push({
            field: "zip",
            message: sizeError,
          });
        }
      }
      const name = normalizedOptionalText(zipNameInput.value);
      if (
        name === undefined ||
        name.length > 160 ||
        /[\/\\\p{Cc}\p{Cf}\p{Cs}]/u.test(name)
      ) {
        failures.push({
          field: "repositoryName",
          message: "Enter a short repository name without path separators.",
        });
      }
      return failures;
    }
    if (source === "city-model") {
      const file = modelInput.files?.[0];
      if (file === undefined) {
        failures.push({
          field: "model",
          message: "Choose a city-model.json file.",
        });
      } else {
        const sizeError = projectImportUploadSizeError(
          "city-model",
          file.size,
        );
        if (sizeError !== undefined) {
          failures.push({
            field: "model",
            message: sizeError,
          });
        }
      }
      return failures;
    }

    const repositoryUrl = repositoryUrlInput.value.normalize("NFC").trim();
    if (
      repositoryUrl.length === 0 ||
      repositoryUrl.length > 4_096 ||
      /[\p{Cc}\p{Cf}\p{Cs}]/u.test(repositoryUrl)
    ) {
      failures.push({
        field: "repositoryUrl",
        message: "Enter a valid repository URL.",
      });
    }
    if (
      source === "github-authenticated" &&
      profileSelect.value === ""
    ) {
      failures.push({
        field: "credentialProfileId",
        message:
          "Choose a configured GitHub profile. Ask the server administrator to add one if the list is empty.",
      });
    }
    let revision: ImportRevision | undefined;
    try {
      revision = projectImportRevision(
        revisionChoice(),
        revisionValueInput.value,
      );
    } catch (error) {
      failures.push({
        field: "revision",
        message: messageOf(error),
      });
    }
    let history: RemoteImportHistorySelection | undefined;
    try {
      history = projectImportHistorySelection(historyFieldValues());
    } catch (error) {
      failures.push({
        field: "history",
        message: messageOf(error),
      });
    }
    const historyRevisionError = projectImportHistoryRevisionError(
      history,
      revision,
    );
    if (historyRevisionError !== undefined) {
      failures.push({
        field: "revision",
        message: historyRevisionError,
      });
    }
    return failures;
  }

  function readFormOptions(): ProjectImportFormValues {
    const source = sourceChoice();
    const failures: FormValidationFailure[] = [];
    let identity: ImportIdentityOptions | undefined;
    try {
      identity = projectImportIdentityOptions({
        title: titleInput.value,
        version: versionInput.value,
      });
    } catch (error) {
      failures.push({
        field:
          error instanceof ProjectImportIdentityValidationError
            ? error.field
            : "title",
        message: messageOf(error),
      });
    }

    let analysis: ImportAnalysisOptions | undefined;
    try {
      analysis = projectImportAnalysisOptions({
        maxRetainedFiles: maxFilesInput.value,
        maxFileMib: maxFileMibInput.value,
        maxTotalMib: maxTotalMibInput.value,
        timeoutSeconds: timeoutSecondsInput.value,
      });
    } catch (error) {
      failures.push({
        field: "analysis",
        message: messageOf(error),
      });
    }
    if (failures.length > 0) {
      showValidationFailures(failures);
      throw new Error(failures[0]!.message);
    }
    return {
      source,
      ...(identity === undefined ? {} : { identity }),
      ...(analysis === undefined ? {} : { analysis }),
    };
  }

  function remoteSubmission(
    values: ProjectImportFormValues,
  ): RemoteImportSubmission {
    const source = values.source;
    if (
      source !== "github-public" &&
      source !== "github-authenticated" &&
      source !== "azure-devops" &&
      source !== "git"
    ) {
      throw new Error("The selected source is not a Git repository.");
    }
    const history = projectImportHistorySelection(historyFieldValues());
    return projectImportRemoteSubmission({
      source,
      repositoryUrl: repositoryUrlInput.value,
      credentialProfileId: profileSelect.value,
      revisionKind: revisionChoice(),
      revisionValue: revisionValueInput.value,
      ...(history === undefined ? {} : { history }),
      ...(values.identity === undefined ? {} : { identity: values.identity }),
      ...(values.analysis === undefined ? {} : { analysis: values.analysis }),
    });
  }

  function repositoryZipSubmission(
    blob: Blob,
    repositoryName: string,
    rootMode: "single-directory" | "archive-root",
    values: ProjectImportFormValues,
  ): UploadImportSubmission {
    return projectImportRepositoryZipSubmission(
      blob.size,
      repositoryName,
      rootMode,
      values.identity,
      values.analysis,
    );
  }

  function renderPackagingProgress(
    progress: ProjectDirectoryArchiveProgress,
  ): void {
    const total = Math.max(1, progress.totalBytes);
    setMeasuredProgress(
      "Packaging selected directory",
      progress.completedBytes,
      total,
      `${progress.completedFiles.toLocaleString()} of ${progress.totalFiles.toLocaleString()} files`,
    );
  }

  function cancelPackaging(): void {
    packagingGeneration += 1;
    packagingController?.abort();
    packagingController = undefined;
    archiveClient.cancel();
    setIndeterminateProgress("Directory packaging cancelled");
    renderNavigation();
  }

  async function startImport(): Promise<void> {
    clearErrors();
    const detailsFailures = validateDetails();
    if (detailsFailures.length > 0) {
      showValidationFailures(detailsFailures);
      return;
    }
    let values: ProjectImportFormValues;
    try {
      values = readFormOptions();
    } catch {
      return;
    }
    setStep("progress");

    try {
      switch (values.source) {
        case "directory": {
          const files = directoryInput.files;
          if (files === null || files.length === 0) {
            showValidationFailures([
              {
                field: "directory",
                message: "Choose a repository directory.",
              },
            ]);
            return;
          }
          const generation = packagingGeneration + 1;
          packagingGeneration = generation;
          const abort = new AbortController();
          packagingController = abort;
          renderNavigation();
          setIndeterminateProgress("Inspecting selected directory…");
          let artifact;
          try {
            artifact = await archiveClient.start(files, {
              signal: abort.signal,
              onProgress: renderPackagingProgress,
            });
          } catch (error) {
            if (
              generation !== packagingGeneration ||
              abort.signal.aborted
            ) {
              return;
            }
            packagingController = undefined;
            setIndeterminateProgress("Directory could not be packaged");
            showSummaryErrors([messageOf(error)]);
            renderNavigation();
            return;
          }
          if (
            generation !== packagingGeneration ||
            abort.signal.aborted
          ) {
            return;
          }
          packagingController = undefined;
          controller.startUpload(
            repositoryZipSubmission(
              artifact.blob,
              artifact.repositoryName,
              artifact.rootMode,
              values,
            ),
            artifact.blob,
          );
          break;
        }
        case "zip": {
          const file = zipInput.files![0]!;
          const blob = new Blob([file], { type: "application/zip" });
          controller.startUpload(
            repositoryZipSubmission(
              blob,
              zipNameInput.value.normalize("NFC").trim(),
              zipRootSelect.value === "archive-root"
                ? "archive-root"
                : "single-directory",
              values,
            ),
            blob,
          );
          break;
        }
        case "city-model": {
          const file = modelInput.files![0]!;
          const blob = new Blob([file], { type: "application/json" });
          controller.startUpload(
            projectImportCityModelSubmission(blob.size),
            blob,
          );
          break;
        }
        case "github-public":
        case "github-authenticated":
        case "azure-devops":
        case "git":
          controller.startRemote(remoteSubmission(values));
          break;
      }
    } catch (error) {
      showSummaryErrors([messageOf(error)]);
      setIndeterminateProgress("Import could not be started");
      renderNavigation();
    }
  }

  openButton.addEventListener("click", open);
  closeButton.addEventListener("click", close);
  signOutButton.addEventListener("click", () => {
    if (packagingController !== undefined) cancelPackaging();
    clearErrors();
    controller.logout();
  });
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  sourceInputs.forEach((input) => {
    input.addEventListener("change", () => {
      clearErrors();
      renderSourcePanels();
      updateReview();
    });
  });
  revisionInputs.forEach((input) => {
    input.addEventListener("change", () => {
      clearErrors();
      renderRevision();
      updateReview();
    });
  });
  historyControls.enabled.addEventListener("change", () => {
    clearErrors();
    renderHistory();
    updateReview();
  });
  historyControls.mode.addEventListener("change", () => {
    clearErrors();
    renderHistory();
    updateReview();
  });
  for (const input of [
    historyControls.commitCount,
    historyControls.fromInclusive,
    historyControls.toInclusive,
    historyControls.dateMaxCommits,
    historyControls.oldestTagName,
    historyControls.newestTagName,
    historyControls.tagMaxCommits,
    historyControls.sampleEvery,
  ]) {
    input.addEventListener("input", () => {
      renderHistory();
      updateReview();
    });
  }
  repositoryUrlInput.addEventListener("input", () => {
    if (sourceChoice() === "git") renderProfiles();
    updateReview();
  });
  zipInput.addEventListener("change", () => {
    const file = zipInput.files?.[0];
    if (file !== undefined && zipNameInput.value.trim() === "") {
      zipNameInput.value = file.name.replace(/\.zip$/iu, "").slice(0, 160);
    }
    updateReview();
  });
  directoryInput.addEventListener("change", updateReview);
  modelInput.addEventListener("change", updateReview);
  backButton.addEventListener("click", () => {
    clearErrors();
    if (currentStep === "details") setStep("source", true);
    else if (currentStep === "options") setStep("details", true);
    else if (currentStep === "progress") {
      setStep(
        sourceChoice() === "city-model" ? "details" : "options",
        true,
      );
    }
  });
  nextButton.addEventListener("click", () => {
    clearErrors();
    if (currentStep === "source") {
      setStep("details", true);
      return;
    }
    if (currentStep === "details") {
      const failures = validateDetails();
      if (failures.length > 0) {
        showValidationFailures(failures);
        return;
      }
      if (sourceChoice() === "city-model") {
        setStep("progress", true);
      } else {
        setStep("options", true);
      }
      return;
    }
    if (currentStep === "options") {
      try {
        readFormOptions();
        setStep("progress", true);
      } catch {
        // readFormOptions exposes and focuses the precise invalid field.
      }
    }
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void startImport();
  });
  authenticateButton.addEventListener("click", () => {
    const token = tokenInput.value;
    tokenInput.value = "";
    if (token.length === 0) {
      authStatus.textContent = "Enter the Code City access token.";
      tokenInput.focus();
      return;
    }
    authStatus.textContent = "Signing in…";
    controller.authenticate(token);
  });
  tokenInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      authenticateButton.click();
    }
  });
  cancelButton.addEventListener("click", () => {
    if (packagingController !== undefined) cancelPackaging();
    else controller.cancel();
  });
  retryButton.addEventListener("click", () => {
    clearErrors();
    if (
      currentState.status === "terminal" ||
      currentState.status === "completed"
    ) {
      controller.forgetCompleted();
      resetWizard();
      setStep("source", true);
      return;
    }
    if (currentState.status === "unavailable") {
      controller.initialize();
      return;
    }
    controller.retry();
  });
  restartButton.addEventListener("click", () => {
    if (
      currentState.status !== "artifact-failed" &&
      currentState.status !== "completed"
    ) {
      return;
    }
    clearErrors();
    controller.forgetCompleted();
    resetWizard();
    setStep("source", true);
  });
  removeResultButton.addEventListener("click", () => {
    if (
      currentState.status !== "artifact-failed" &&
      currentState.status !== "completed" &&
      currentState.status !== "removal-failed"
    ) {
      return;
    }
    clearErrors();
    controller.removeCompleted();
  });

  renderSourcePanels();
  renderRevision();
  renderHistory();
  resetProgress();
  setStep("source");
  if (options.autoResume !== false) {
    initialized = true;
    controller.initialize();
  }

  return {
    open,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      packagingGeneration += 1;
      packagingController?.abort();
      packagingController = undefined;
      archiveClient.dispose();
      controller.dispose();
    },
  };
}
