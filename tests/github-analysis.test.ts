import { strToU8, zipSync } from "fflate";
import { expect, it } from "vitest";

import {
  analyzePublicGitHubRepository,
  type GitHubSnapshotFetch,
} from "../packages/analyzer/src/index.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const METADATA_URL = "https://api.github.com/repos/Owner/Repo";
const COMMIT_URL = `${METADATA_URL}/commits/main`;
const ARCHIVE_URL = `https://codeload.github.com/Owner/Repo/zip/${SHA}`;

function responseAt(
  url: string,
  body: string | Uint8Array,
): Response {
  const response = new Response(
    typeof body === "string" ? body : new Uint8Array(body).buffer,
  );
  Object.defineProperty(response, "url", { value: url });
  return response;
}

function fakeGitHub(): GitHubSnapshotFetch {
  return async (input) => {
    const url = input.toString();
    if (url === METADATA_URL) {
      return responseAt(
        url,
        JSON.stringify({
          private: false,
          visibility: "public",
          full_name: "Owner/Repo",
          default_branch: "main",
        }),
      );
    }
    if (url === COMMIT_URL) {
      return responseAt(url, JSON.stringify({ sha: SHA }));
    }
    if (url === ARCHIVE_URL) {
      return responseAt(
        url,
        zipSync({
          [`Repo-${SHA}/src/main.ts`]: strToU8(
            "export function answer(value: boolean) {\n" +
              "  return value ? 42 : 0;\n" +
              "}\n",
          ),
        }),
      );
    }
    throw new Error("Unexpected fake request.");
  };
}

it(
  "builds a city from a public commit with deterministic default identity",
  { timeout: 5_000 },
  async () => {
    const result = await analyzePublicGitHubRepository(
      { repositoryUrl: "https://github.com/Owner/Repo" },
      { timeoutMs: 5_000 },
      { fetch: fakeGitHub() },
    );

    expect(result).toMatchObject({
      owner: "Owner",
      repository: "Repo",
      canonicalRepositoryUrl: "https://github.com/Owner/Repo",
      commitSha: SHA,
    });
    expect(result.model.identity).toEqual({
      title: "Repo",
      version: SHA,
    });
    expect(result.model.repositories).toHaveLength(1);
    expect(result.model.buildings).toHaveLength(1);
    expect(result.model.buildings[0]).toMatchObject({
      name: "main.ts",
      path: "src/main.ts",
      language: "typescript",
    });
  },
);

it(
  "preserves explicit public-city identity",
  { timeout: 5_000 },
  async () => {
    const result = await analyzePublicGitHubRepository(
      { repositoryUrl: "https://github.com/Owner/Repo", ref: "main" },
      {
        title: "Release City",
        version: "2026.7",
        logo: "assets/logo.svg",
        timeoutMs: 5_000,
      },
      { fetch: fakeGitHub() },
    );

    expect(result.model.identity).toEqual({
      title: "Release City",
      version: "2026.7",
      logo: {
        format: "svg",
        relativePath: "assets/logo.svg",
      },
    });
  },
);
