import type {
  SourceLanguage,
  SourceRepositoryProvenance,
} from "../../../packages/core/src/model.js";

const JOB_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const BUILDING_ID = /^[a-z0-9-]+:[0-9a-f]{16}$/u;
const MAXIMUM_SOURCE_BYTES = 16 * 1024 * 1024;
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Cs}]/u;
const SOURCE_LINE_CONTEXT = 120;
const SOURCE_LINE_WINDOW_LIMIT = 500;

export interface BuildingSource {
  readonly buildingId: string;
  readonly repositoryId: string;
  readonly path: string;
  readonly language: SourceLanguage;
  readonly text: string;
  readonly location: {
    readonly startLine: number;
    readonly endLine: number;
  };
  readonly provenance: SourceRepositoryProvenance;
  readonly externalUrl?: string;
  readonly editorUrl?: string;
}

export interface ExpectedBuildingSource {
  readonly buildingId: string;
  readonly repositoryId: string;
  readonly path: string;
  readonly language: SourceLanguage;
  readonly location?: {
    readonly startLine: number;
    readonly endLine: number;
  };
  readonly provenance: SourceRepositoryProvenance;
}

export interface SourceLineWindow {
  readonly requestedStart: number;
  readonly requestedEnd: number;
  readonly firstLine: number;
  readonly lastLine: number;
  readonly omittedBefore: number;
  readonly omittedAfter: number;
}

export function sourceOmissionMarker(
  count: number,
  direction: "earlier" | "later",
): string {
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new TypeError("Source omission count must be a positive integer.");
  }
  return `\u2026 ${count} ${direction} lines omitted \u2026`;
}

export function sourceLineWindow(
  totalLines: number,
  startLine: number,
  endLine = startLine,
): SourceLineWindow {
  if (
    !Number.isSafeInteger(totalLines) ||
    totalLines < 1 ||
    !Number.isSafeInteger(startLine) ||
    !Number.isSafeInteger(endLine)
  ) {
    throw new TypeError("Source line window bounds are invalid.");
  }
  const requestedStart = Math.min(totalLines, Math.max(1, startLine));
  const requestedEnd = Math.min(
    totalLines,
    Math.max(requestedStart, endLine),
  );
  const firstLine = Math.max(
    1,
    requestedStart - SOURCE_LINE_CONTEXT,
  );
  let lastLine = Math.min(
    totalLines,
    requestedEnd + SOURCE_LINE_CONTEXT,
  );
  if (lastLine - firstLine + 1 > SOURCE_LINE_WINDOW_LIMIT) {
    lastLine = Math.min(
      totalLines,
      firstLine + SOURCE_LINE_WINDOW_LIMIT - 1,
    );
  }
  return Object.freeze({
    requestedStart,
    requestedEnd,
    firstLine,
    lastLine,
    omittedBefore: firstLine - 1,
    omittedAfter: totalLines - lastLine,
  });
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return (
    actual.length === sorted.length &&
    actual.every((key, index) => key === sorted[index])
  );
}

function immutableExternalUrl(
  provenance: SourceRepositoryProvenance,
  sourcePath: string,
  line: number,
): string | undefined {
  if (provenance.repositoryUrl === undefined) return undefined;
  let repository: URL;
  try {
    repository = new URL(provenance.repositoryUrl);
  } catch {
    return undefined;
  }
  if (
    repository.protocol !== "https:" ||
    repository.username !== "" ||
    repository.password !== ""
  ) {
    return undefined;
  }
  const encodedPath = sourcePath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  if (provenance.provider === "github") {
    return `${provenance.repositoryUrl.replace(/\.git\/?$/u, "").replace(/\/$/u, "")}/blob/${provenance.revision.value}/${encodedPath}#L${line}`;
  }
  if (provenance.provider === "azure-devops") {
    repository.search = "";
    repository.hash = "";
    repository.searchParams.set("path", `/${sourcePath}`);
    repository.searchParams.set(
      "version",
      `GC${provenance.revision.value}`,
    );
    repository.searchParams.set("line", String(line));
    repository.searchParams.set("_a", "contents");
    return repository.toString();
  }
  return undefined;
}

function safeEditorUrl(value: string): boolean {
  if (UNSAFE_TEXT.test(value)) return false;
  try {
    const url = new URL(value);
    return (
      ["https:", "vscode:", "vscode-insiders:"].includes(url.protocol) &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}

function parseBuildingSource(
  value: unknown,
  expected: ExpectedBuildingSource,
): BuildingSource {
  const root = record(value);
  const source = record(root?.["source"]);
  const location = record(source?.["location"]);
  const provenance = record(source?.["provenance"]);
  const revision = record(provenance?.["revision"]);
  const sourceKeys = [
    "buildingId",
    ...(source?.["editorUrl"] === undefined ? [] : ["editorUrl"]),
    ...(source?.["externalUrl"] === undefined ? [] : ["externalUrl"]),
    "language",
    "location",
    "path",
    "provenance",
    "repositoryId",
    "text",
  ];
  const expectedProvenance = expected.provenance;
  const expectedExternal = immutableExternalUrl(
    expectedProvenance,
    expected.path,
    expected.location?.startLine ?? 1,
  );
  if (
    root === undefined ||
    !exactKeys(root, ["source"]) ||
    source === undefined ||
    !exactKeys(source, sourceKeys) ||
    source["buildingId"] !== expected.buildingId ||
    source["repositoryId"] !== expected.repositoryId ||
    source["path"] !== expected.path ||
    source["language"] !== expected.language ||
    typeof source["text"] !== "string" ||
    new TextEncoder().encode(source["text"]).byteLength >
      MAXIMUM_SOURCE_BYTES ||
    location === undefined ||
    !exactKeys(location, ["endLine", "startLine"]) ||
    !Number.isSafeInteger(location["startLine"]) ||
    !Number.isSafeInteger(location["endLine"]) ||
    Number(location["startLine"]) < 1 ||
    Number(location["endLine"]) < Number(location["startLine"]) ||
    (expected.location !== undefined &&
      (location["startLine"] !== expected.location.startLine ||
        location["endLine"] !== expected.location.endLine)) ||
    (expected.location === undefined &&
      (location["startLine"] !== 1 ||
        location["endLine"] !==
          Math.max(1, source["text"].split(/\r\n?|\n/u).length))) ||
    provenance === undefined ||
    !exactKeys(provenance, [
      "provider",
      "repositoryId",
      ...(expectedProvenance.repositoryUrl === undefined
        ? []
        : ["repositoryUrl"]),
      "revision",
    ]) ||
    provenance["repositoryId"] !== expectedProvenance.repositoryId ||
    provenance["provider"] !== expectedProvenance.provider ||
    provenance["repositoryUrl"] !== expectedProvenance.repositoryUrl ||
    revision === undefined ||
    !exactKeys(revision, ["kind", "value"]) ||
    revision["kind"] !== expectedProvenance.revision.kind ||
    revision["value"] !== expectedProvenance.revision.value ||
    (source["externalUrl"] !== undefined &&
      (typeof source["externalUrl"] !== "string" ||
        expectedExternal === undefined ||
        source["externalUrl"] !== expectedExternal)) ||
    (source["editorUrl"] !== undefined &&
      (typeof source["editorUrl"] !== "string" ||
        !safeEditorUrl(source["editorUrl"])))
  ) {
    throw new TypeError("The source response is invalid.");
  }
  return source as unknown as BuildingSource;
}

export async function loadBuildingSource(
  jobId: string,
  expected: ExpectedBuildingSource,
  gateway: (
    jobId: string,
    buildingId: string,
    signal?: AbortSignal,
  ) => Promise<unknown>,
  signal?: AbortSignal,
): Promise<BuildingSource> {
  if (!JOB_ID.test(jobId) || !BUILDING_ID.test(expected.buildingId)) {
    throw new TypeError("The source request identifiers are invalid.");
  }
  return parseBuildingSource(
    await gateway(jobId, expected.buildingId, signal),
    expected,
  );
}

export type SourceTokenKind =
  | "comment"
  | "keyword"
  | "number"
  | "string"
  | "text";

export interface SourceToken {
  readonly kind: SourceTokenKind;
  readonly text: string;
}

const TOKEN_PATTERN =
  /(\/\/.*$|\/\*.*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b(?:abstract|async|await|boolean|break|case|catch|class|const|continue|default|do|else|enum|export|extends|false|finally|for|from|function|get|if|implements|import|in|instanceof|interface|let|namespace|new|null|number|override|private|protected|public|readonly|return|set|static|string|super|switch|this|throw|true|try|type|typeof|undefined|using|var|void|while|yield)\b|\b\d+(?:\.\d+)?\b)/gmu;

export function sourceLineTokens(line: string): readonly SourceToken[] {
  const tokens: SourceToken[] = [];
  let index = 0;
  for (const match of line.matchAll(TOKEN_PATTERN)) {
    const start = match.index;
    if (start > index) {
      tokens.push({ kind: "text", text: line.slice(index, start) });
    }
    const text = match[0];
    const kind: SourceTokenKind = text.startsWith("//") ||
      text.startsWith("/*")
      ? "comment"
      : /^["'`]/u.test(text)
        ? "string"
        : /^\d/u.test(text)
          ? "number"
          : "keyword";
    tokens.push({ kind, text });
    index = start + text.length;
  }
  if (index < line.length) {
    tokens.push({ kind: "text", text: line.slice(index) });
  }
  return tokens;
}
