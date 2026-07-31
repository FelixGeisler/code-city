import { describe, expect, it, vi } from "vitest";

import {
  loadBuildingSource,
  sourceOmissionMarker,
  sourceLineWindow,
  sourceLineTokens,
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

  it("renders proper ellipses around both omission markers", () => {
    expect(sourceOmissionMarker(249_879, "earlier")).toBe(
      "\u2026 249879 earlier lines omitted \u2026",
    );
    expect(sourceOmissionMarker(249_621, "later")).toBe(
      "\u2026 249621 later lines omitted \u2026",
    );
  });
});
