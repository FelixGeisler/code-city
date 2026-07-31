import { describe, expect, it, vi } from "vitest";

import {
  extractSourceLineWindow,
  loadBuildingSource,
  sourceOmissionMarker,
  presentSourceLine,
  SOURCE_RENDERED_CHARACTER_LIMIT,
  SOURCE_RENDERED_TOKEN_LIMIT,
  SOURCE_LINE_WINDOW_LIMIT,
  sourceLineCount,
  sourceLineWindow,
  sourceLineTokens,
  sourceOwnerAfterResultRemoval,
} from "../apps/viewer/src/source-navigation.js";

const JOB = "123e4567-e89b-42d3-a456-426614174000";
const BUILDING = "building:1234567890abcdef";
const EXPECTED = {
  buildingId: BUILDING,
  repositoryId: "repository:1234567890abcdef",
  path: "src/example.ts",
  language: "typescript" as const,
  location: { startLine: 1, endLine: 2 },
  provenance: {
    repositoryId: "repository:1234567890abcdef",
    provider: "github" as const,
    revision: { kind: "commit" as const, value: "a".repeat(40) },
    repositoryUrl: "https://github.com/example/repository",
  },
};

function response(
  overrides: Record<string, unknown> = {},
): { readonly source: Record<string, unknown> } {
  return {
    source: {
      buildingId: BUILDING,
      repositoryId: "repository:1234567890abcdef",
      path: "src/example.ts",
      language: "typescript",
      text: "export const answer = 42;\n",
      location: { startLine: 1, endLine: 2 },
      provenance: EXPECTED.provenance,
      externalUrl:
        `https://github.com/example/repository/blob/${"a".repeat(40)}/src/example.ts#L1`,
      ...overrides,
    },
  };
}

describe("viewer source navigation", () => {
  it("changes only the source owner whose result was removed", () => {
    const active = Object.freeze({
      jobId: JOB,
      label: "Active import",
      sourceAvailability: "retained" as const,
    });

    expect(
      sourceOwnerAfterResultRemoval(
        active,
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      ),
    ).toBe(active);
    const modelOnly = Object.freeze({
      ...active,
      sourceAvailability: "model-only" as const,
    });
    expect(sourceOwnerAfterResultRemoval(modelOnly, JOB)).toBe(
      modelOnly,
    );
    expect(sourceOwnerAfterResultRemoval(active, JOB)).toEqual({
      jobId: JOB,
      label: "Active import",
      sourceAvailability: "removed",
    });
    expect(active.sourceAvailability).toBe("retained");
  });

  it("requests only the selected building and parses its immutable provenance", async () => {
    const request = vi.fn(async () => response());
    const source = await loadBuildingSource(
      JOB,
      EXPECTED,
      request,
    );
    expect(request).toHaveBeenCalledWith(
      JOB,
      BUILDING,
      undefined,
    );
    expect(source.path).toBe("src/example.ts");
    expect(source.provenance.revision.value).toBe("a".repeat(40));
    expect(source.editorUrl).toBeUndefined();
  });

  it("counts every supported line ending without allocating line arrays", async () => {
    expect(sourceLineCount("")).toBe(1);
    expect(sourceLineCount("one\r\ntwo\rthree\n")).toBe(4);

    const provenance = {
      repositoryId: EXPECTED.repositoryId,
      provider: "github" as const,
      revision: EXPECTED.provenance.revision,
    };
    const sourceResponse = response({
      text: "one\r\ntwo\rthree\n",
      location: { startLine: 1, endLine: 4 },
      provenance,
    });
    delete sourceResponse.source["externalUrl"];
    const split = vi
      .spyOn(String.prototype, "split")
      .mockImplementation(() => {
        throw new Error("validation must not split source text");
      });
    const {
      location: _location,
      ...expectedWithoutLocation
    } = EXPECTED;
    let loaded: Awaited<ReturnType<typeof loadBuildingSource>>;
    try {
      loaded = await loadBuildingSource(
        JOB,
        {
          ...expectedWithoutLocation,
          provenance,
        },
        async () => sourceResponse,
      );
    } finally {
      split.mockRestore();
    }
    expect(loaded.location.endLine).toBe(4);
  });

  it("tokenizes syntax without producing HTML", () => {
    expect(sourceLineTokens('const value = "<script>"; // safe')).toEqual([
      { kind: "keyword", text: "const" },
      { kind: "text", text: " value = " },
      { kind: "string", text: '"<script>"' },
      { kind: "text", text: "; " },
      { kind: "comment", text: "// safe" },
    ]);
  });

  it("tokenizes repeated unterminated block-comment starts in linear work", () => {
    const pathological = "/*a"
      .repeat(Math.ceil(SOURCE_RENDERED_CHARACTER_LIMIT / 3))
      .slice(0, SOURCE_RENDERED_CHARACTER_LIMIT);
    const presentation = presentSourceLine(
      pathological,
      SOURCE_RENDERED_CHARACTER_LIMIT,
      SOURCE_RENDERED_TOKEN_LIMIT,
    );

    expect(presentation).toMatchObject({
      text: pathological,
      omittedCharacters: 0,
      syntaxHighlighted: true,
      tokens: [{ kind: "comment", text: pathological }],
    });
  });

  it("bounds source presentation by character and token-node budgets", () => {
    const oversizedLine = "const value = 1;".repeat(8_000);
    const characterBounded = presentSourceLine(
      oversizedLine,
      SOURCE_RENDERED_CHARACTER_LIMIT,
      SOURCE_RENDERED_TOKEN_LIMIT,
    );
    expect(characterBounded.text).toHaveLength(
      SOURCE_RENDERED_CHARACTER_LIMIT,
    );
    expect(characterBounded.tokens).toEqual([
      { kind: "text", text: characterBounded.text },
    ]);
    expect(characterBounded.omittedCharacters).toBeGreaterThan(0);
    expect(characterBounded.syntaxHighlighted).toBe(false);

    const tokenHeavy = "1 ".repeat(64);
    const tokenBounded = presentSourceLine(
      tokenHeavy,
      tokenHeavy.length,
      8,
    );
    expect(tokenBounded.tokens).toEqual([
      { kind: "text", text: tokenHeavy },
    ]);
    expect(tokenBounded.syntaxHighlighted).toBe(false);
  });

  it("rejects identifiers that could select another route shape", async () => {
    await expect(
      loadBuildingSource(
        JOB,
        {
          ...EXPECTED,
          buildingId: "../building:1234567890abcdef",
        },
        vi.fn(),
      ),
    ).rejects.toThrow(/identifiers/u);
  });

  it.each([
    ["building id", { buildingId: "building:ffffffffffffffff" }],
    ["repository", { repositoryId: "repository:ffffffffffffffff" }],
    ["path", { path: "src/other.ts" }],
    ["language", { language: "javascript" }],
    ["location", { location: { startLine: 1, endLine: 1 } }],
    [
      "provenance",
      {
        provenance: {
          ...EXPECTED.provenance,
          revision: { kind: "commit", value: "b".repeat(40) },
        },
      },
    ],
    ["external link", { externalUrl: "javascript:alert(1)" }],
    ["editor link", { editorUrl: "data:text/html,unsafe" }],
    [
      "oversized editor link",
      {
        editorUrl:
          `https://editor.example.test/open?path=${"a".repeat(4_096)}`,
      },
    ],
  ])("rejects a mismatched or unsafe %s", async (_name, overrides) => {
    await expect(
      loadBuildingSource(
        JOB,
        EXPECTED,
        async () => response(overrides),
      ),
    ).rejects.toThrow(/source response is invalid/u);
  });

  it("bounds rendering windows for very large source files", () => {
    expect(sourceLineWindow(500_000, 250_000, 300_000)).toEqual({
      requestedStart: 250_000,
      requestedEnd: 300_000,
      firstLine: 249_880,
      lastLine: 250_379,
      omittedBefore: 249_879,
      omittedAfter: 249_621,
    });
  });

  it("extracts only the bounded window from newline-heavy source", () => {
    const text = "line\r\n".repeat(200_000);
    const extracted = extractSourceLineWindow(
      text,
      100_000,
      180_000,
    );

    expect(extracted.lines).toHaveLength(
      SOURCE_LINE_WINDOW_LIMIT,
    );
    expect(extracted.lines[0]).toEqual({
      lineNumber: 99_880,
      text: "line",
    });
    expect(extracted.lines.at(-1)).toEqual({
      lineNumber: 100_379,
      text: "line",
    });
    expect(extracted.omittedAfter).toBe(99_622);
  });

  it("extracts CRLF, CR, LF, and empty lines with clamped bounds", () => {
    expect(extractSourceLineWindow("", -10, -1)).toMatchObject({
      requestedStart: 1,
      requestedEnd: 1,
      firstLine: 1,
      lastLine: 1,
      lines: [{ lineNumber: 1, text: "" }],
    });

    const extracted = extractSourceLineWindow(
      "one\r\ntwo\rthree\n",
      Number.MAX_SAFE_INTEGER,
    );

    expect(extracted).toMatchObject({
      requestedStart: 4,
      requestedEnd: 4,
      firstLine: 1,
      lastLine: 4,
      lines: [
        { lineNumber: 1, text: "one" },
        { lineNumber: 2, text: "two" },
        { lineNumber: 3, text: "three" },
        { lineNumber: 4, text: "" },
      ],
    });
  });

  it("renders proper ellipses around both omission markers", () => {
    expect(sourceOmissionMarker(249_879, "earlier")).toBe(
      "\u2026 249879 earlier lines omitted \u2026",
    );
    expect(sourceOmissionMarker(249_621, "later")).toBe(
      "\u2026 249621 later lines omitted \u2026",
    );
  });
});
