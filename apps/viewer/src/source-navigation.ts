import type {
  SourceLanguage,
  SourceRepositoryProvenance,
} from "../../../packages/core/src/model.js";

const JOB_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const BUILDING_ID = /^[a-z0-9-]+:[0-9a-f]{16}$/u;

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

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseBuildingSource(value: unknown): BuildingSource {
  const root = record(value);
  const source = record(root?.["source"]);
  const location = record(source?.["location"]);
  const provenance = record(source?.["provenance"]);
  const revision = record(provenance?.["revision"]);
  if (
    source === undefined ||
    typeof source["buildingId"] !== "string" ||
    !BUILDING_ID.test(source["buildingId"]) ||
    typeof source["repositoryId"] !== "string" ||
    typeof source["path"] !== "string" ||
    !["csharp", "javascript", "typescript"].includes(
      String(source["language"]),
    ) ||
    typeof source["text"] !== "string" ||
    location === undefined ||
    !Number.isSafeInteger(location["startLine"]) ||
    !Number.isSafeInteger(location["endLine"]) ||
    Number(location["startLine"]) < 1 ||
    Number(location["endLine"]) < Number(location["startLine"]) ||
    provenance === undefined ||
    provenance["version"] !== undefined ||
    typeof provenance["repositoryId"] !== "string" ||
    ![
      "github",
      "azure-devops",
      "generic-git",
      "uploaded-archive",
    ].includes(String(provenance["provider"])) ||
    revision === undefined ||
    !["commit", "snapshot"].includes(String(revision["kind"])) ||
    typeof revision["value"] !== "string" ||
    (source["externalUrl"] !== undefined &&
      typeof source["externalUrl"] !== "string") ||
    (source["editorUrl"] !== undefined &&
      typeof source["editorUrl"] !== "string")
  ) {
    throw new TypeError("The source response is invalid.");
  }
  return source as unknown as BuildingSource;
}

export async function loadBuildingSource(
  jobId: string,
  buildingId: string,
  gateway: (
    jobId: string,
    buildingId: string,
    signal?: AbortSignal,
  ) => Promise<unknown>,
  signal?: AbortSignal,
): Promise<BuildingSource> {
  if (!JOB_ID.test(jobId) || !BUILDING_ID.test(buildingId)) {
    throw new TypeError("The source request identifiers are invalid.");
  }
  return parseBuildingSource(
    await gateway(jobId, buildingId, signal),
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
