import { describe, expect, it, vi } from "vitest";

import {
  loadBuildingSource,
  sourceLineTokens,
} from "../apps/viewer/src/source-navigation.js";

const JOB = "123e4567-e89b-42d3-a456-426614174000";
const BUILDING = "building:1234567890abcdef";

describe("viewer source navigation", () => {
  it("requests only the selected building and parses its immutable provenance", async () => {
    const request = vi.fn(async () =>
        ({
          source: {
            buildingId: BUILDING,
            repositoryId: "repository:1234567890abcdef",
            path: "src/example.ts",
            language: "typescript",
            text: "export const answer = 42;\n",
            location: { startLine: 1, endLine: 2 },
            provenance: {
              repositoryId: "repository:1234567890abcdef",
              provider: "github",
              revision: { kind: "commit", value: "a".repeat(40) },
              repositoryUrl: "https://github.com/example/repository",
            },
            externalUrl:
              `https://github.com/example/repository/blob/${"a".repeat(40)}/src/example.ts#L1`,
          },
        }),
    );
    const source = await loadBuildingSource(
      JOB,
      BUILDING,
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
        "../building:1234567890abcdef",
        vi.fn(),
      ),
    ).rejects.toThrow(/identifiers/u);
  });
});
