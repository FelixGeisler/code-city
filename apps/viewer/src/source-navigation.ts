import type {
  SourceLanguage,
  SourceRepositoryProvenance,
} from "../../../packages/core/src/model.js";

const JOB_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const BUILDING_ID = /^[a-z0-9-]+:[0-9a-f]{16}$/u;
const MAXIMUM_SOURCE_BYTES = 16 * 1024 * 1024;
const MAXIMUM_EDITOR_URL_CHARACTERS = 4_096;
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Cs}]/u;
const SOURCE_LINE_CONTEXT = 120;
export const SOURCE_LINE_WINDOW_LIMIT = 500;

export const SOURCE_RENDERED_CHARACTER_LIMIT = 64 * 1024;
export const SOURCE_RENDERED_TOKEN_LIMIT = 4_096;

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

export interface SourceTextLine {
  readonly lineNumber: number;
  readonly text: string;
}

export interface ExtractedSourceLineWindow extends SourceLineWindow {
  readonly lines: readonly SourceTextLine[];
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

type RemovedSourceOwner<Source> =
  Omit<Source, "sourceAvailability"> & {
    readonly sourceAvailability: "removed";
  };

export function sourceOwnerAfterResultRemoval<
  Source extends {
    readonly jobId?: string;
    readonly sourceAvailability?: string;
  },
>(
  source: Source,
  removedJobId: string,
): Source | RemovedSourceOwner<Source> {
  if (
    source.jobId !== removedJobId ||
    source.sourceAvailability !== "retained"
  ) {
    return source;
  }
  return Object.freeze({
    ...source,
    sourceAvailability: "removed" as const,
  }) as RemovedSourceOwner<Source>;
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

function visitSourceLines(
  text: string,
  visitor?: (
    lineNumber: number,
    startOffset: number,
    endOffset: number,
  ) => void,
): number {
  let lineNumber = 1;
  let lineStart = 0;
  let cursor = 0;
  while (cursor < text.length) {
    const character = text.charCodeAt(cursor);
    if (character !== 10 && character !== 13) {
      cursor += 1;
      continue;
    }
    visitor?.(lineNumber, lineStart, cursor);
    lineNumber += 1;
    if (
      character === 13 &&
      text.charCodeAt(cursor + 1) === 10
    ) {
      cursor += 1;
    }
    cursor += 1;
    lineStart = cursor;
  }
  visitor?.(lineNumber, lineStart, text.length);
  return lineNumber;
}

export function sourceLineCount(text: string): number {
  if (typeof text !== "string") {
    throw new TypeError("Source text must be a string.");
  }
  return visitSourceLines(text);
}

export function extractSourceLineWindow(
  text: string,
  startLine: number,
  endLine = startLine,
): ExtractedSourceLineWindow {
  if (
    typeof text !== "string" ||
    !Number.isSafeInteger(startLine) ||
    !Number.isSafeInteger(endLine)
  ) {
    throw new TypeError("Source line window bounds are invalid.");
  }

  const provisionalStart = Math.max(1, startLine);
  const provisionalEnd = Math.max(provisionalStart, endLine);
  const targetFirst = Math.max(
    1,
    provisionalStart - SOURCE_LINE_CONTEXT,
  );
  const contextualLast =
    provisionalEnd >
    Number.MAX_SAFE_INTEGER - SOURCE_LINE_CONTEXT
      ? Number.MAX_SAFE_INTEGER
      : provisionalEnd + SOURCE_LINE_CONTEXT;
  const targetLast = Math.min(
    contextualLast,
    targetFirst + SOURCE_LINE_WINDOW_LIMIT - 1,
  );

  const targetNumbers = new Float64Array(
    SOURCE_LINE_WINDOW_LIMIT,
  );
  const targetStarts = new Float64Array(
    SOURCE_LINE_WINDOW_LIMIT,
  );
  const targetEnds = new Float64Array(SOURCE_LINE_WINDOW_LIMIT);
  const tailNumbers = new Float64Array(SOURCE_LINE_WINDOW_LIMIT);
  const tailStarts = new Float64Array(SOURCE_LINE_WINDOW_LIMIT);
  const tailEnds = new Float64Array(SOURCE_LINE_WINDOW_LIMIT);

  const totalLines = visitSourceLines(
    text,
    (lineNumber, startOffset, endOffset) => {
      if (
        lineNumber >= targetFirst &&
        lineNumber <= targetLast
      ) {
        const targetIndex = lineNumber - targetFirst;
        targetNumbers[targetIndex] = lineNumber;
        targetStarts[targetIndex] = startOffset;
        targetEnds[targetIndex] = endOffset;
      }
      const tailIndex =
        (lineNumber - 1) % SOURCE_LINE_WINDOW_LIMIT;
      tailNumbers[tailIndex] = lineNumber;
      tailStarts[tailIndex] = startOffset;
      tailEnds[tailIndex] = endOffset;
    },
  );
  const window = sourceLineWindow(
    totalLines,
    startLine,
    endLine,
  );
  const useTarget =
    window.firstLine >= targetFirst &&
    window.lastLine <= targetLast;
  const lines: SourceTextLine[] = [];
  for (
    let lineNumber = window.firstLine;
    lineNumber <= window.lastLine;
    lineNumber += 1
  ) {
    const index = useTarget
      ? lineNumber - targetFirst
      : (lineNumber - 1) % SOURCE_LINE_WINDOW_LIMIT;
    const numbers = useTarget ? targetNumbers : tailNumbers;
    const starts = useTarget ? targetStarts : tailStarts;
    const ends = useTarget ? targetEnds : tailEnds;
    if (numbers[index] !== lineNumber) {
      throw new TypeError("Source line extraction failed.");
    }
    lines.push(
      Object.freeze({
        lineNumber,
        text: text.slice(starts[index], ends[index]),
      }),
    );
  }
  return Object.freeze({
    ...window,
    lines: Object.freeze(lines),
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
  if (
    value.length > MAXIMUM_EDITOR_URL_CHARACTERS ||
    UNSAFE_TEXT.test(value)
  ) {
    return false;
  }
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
          sourceLineCount(source["text"]))) ||
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

export interface SourceLinePresentation {
  readonly text: string;
  readonly tokens: readonly SourceToken[];
  readonly omittedCharacters: number;
  readonly syntaxHighlighted: boolean;
}

const SOURCE_KEYWORDS = new Set([
  "abstract",
  "async",
  "await",
  "boolean",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "default",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "from",
  "function",
  "get",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "let",
  "namespace",
  "new",
  "null",
  "number",
  "override",
  "private",
  "protected",
  "public",
  "readonly",
  "return",
  "set",
  "static",
  "string",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "type",
  "typeof",
  "undefined",
  "using",
  "var",
  "void",
  "while",
  "yield",
]);

function isAsciiWordCharacter(character: string | undefined): boolean {
  if (character === undefined) return false;
  const code = character.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    code === 95 ||
    (code >= 97 && code <= 122)
  );
}

function isAsciiDigit(character: string | undefined): boolean {
  if (character === undefined) return false;
  const code = character.charCodeAt(0);
  return code >= 48 && code <= 57;
}

function quotedTokenEnd(line: string, start: number): number {
  const quote = line[start]!;
  let cursor = start + 1;
  while (cursor < line.length) {
    const character = line[cursor]!;
    if (character === "\\") {
      cursor = Math.min(line.length, cursor + 2);
      continue;
    }
    cursor += 1;
    if (character === quote) return cursor;
  }
  return line.length;
}

function tokenizeSourceLine(
  line: string,
  maximumTokens: number,
): {
  readonly complete: boolean;
  readonly tokens: readonly SourceToken[];
} {
  const tokens: SourceToken[] = [];
  let cursor = 0;
  let plainTextStart = 0;

  const appendToken = (
    start: number,
    end: number,
    kind: SourceTokenKind,
  ): boolean => {
    const needed = (start > plainTextStart ? 1 : 0) + 1;
    if (tokens.length + needed > maximumTokens) return false;
    if (start > plainTextStart) {
      tokens.push({
        kind: "text",
        text: line.slice(plainTextStart, start),
      });
    }
    tokens.push({ kind, text: line.slice(start, end) });
    plainTextStart = end;
    return true;
  };

  while (cursor < line.length) {
    let end = cursor;
    let kind: SourceTokenKind | undefined;
    if (line.startsWith("//", cursor)) {
      end = line.length;
      kind = "comment";
    } else if (line.startsWith("/*", cursor)) {
      const terminator = line.indexOf("*/", cursor + 2);
      end = terminator < 0 ? line.length : terminator + 2;
      kind = "comment";
    } else {
      const character = line[cursor]!;
      if (
        character === '"' ||
        character === "'" ||
        character === "`"
      ) {
        end = quotedTokenEnd(line, cursor);
        kind = "string";
      } else if (isAsciiWordCharacter(character)) {
        let digitsOnly = isAsciiDigit(character);
        end = cursor + 1;
        while (isAsciiWordCharacter(line[end])) {
          digitsOnly &&= isAsciiDigit(line[end]);
          end += 1;
        }
        const word = line.slice(cursor, end);
        if (SOURCE_KEYWORDS.has(word)) {
          kind = "keyword";
        } else if (digitsOnly) {
          const fractionStart = end;
          if (
            line[fractionStart] === "." &&
            isAsciiDigit(line[fractionStart + 1])
          ) {
            let fractionEnd = fractionStart + 2;
            while (isAsciiDigit(line[fractionEnd])) {
              fractionEnd += 1;
            }
            if (!isAsciiWordCharacter(line[fractionEnd])) {
              end = fractionEnd;
            }
          }
          if (!isAsciiWordCharacter(line[end])) kind = "number";
        }
      }
    }

    if (kind === undefined) {
      cursor = Math.max(cursor + 1, end);
      continue;
    }
    if (!appendToken(cursor, end, kind)) {
      return { complete: false, tokens: Object.freeze(tokens) };
    }
    cursor = end;
  }

  if (plainTextStart < line.length) {
    if (tokens.length === maximumTokens) {
      return { complete: false, tokens: Object.freeze(tokens) };
    }
    tokens.push({
      kind: "text",
      text: line.slice(plainTextStart),
    });
  }
  return { complete: true, tokens: Object.freeze(tokens) };
}

export function sourceLineTokens(line: string): readonly SourceToken[] {
  return tokenizeSourceLine(
    line,
    Number.MAX_SAFE_INTEGER,
  ).tokens;
}

export function presentSourceLine(
  line: string,
  maximumCharacters: number,
  maximumTokens: number,
): SourceLinePresentation {
  if (
    !Number.isSafeInteger(maximumCharacters) ||
    maximumCharacters < 0 ||
    !Number.isSafeInteger(maximumTokens) ||
    maximumTokens < 1
  ) {
    throw new TypeError("Source rendering budgets are invalid.");
  }
  const text = line.slice(0, maximumCharacters);
  const omittedCharacters = line.length - text.length;
  if (omittedCharacters > 0) {
    return Object.freeze({
      text,
      tokens: Object.freeze([
        { kind: "text" as const, text },
      ]),
      omittedCharacters,
      syntaxHighlighted: false,
    });
  }
  const tokenized = tokenizeSourceLine(text, maximumTokens);
  if (!tokenized.complete) {
    return Object.freeze({
      text,
      tokens: Object.freeze([
        { kind: "text" as const, text },
      ]),
      omittedCharacters: 0,
      syntaxHighlighted: false,
    });
  }
  return Object.freeze({
    text,
    tokens: tokenized.tokens,
    omittedCharacters: 0,
    syntaxHighlighted: true,
  });
}
