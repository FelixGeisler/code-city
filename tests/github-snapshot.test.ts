import { strToU8, zipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";

import {
  GITHUB_ARCHIVE_MAX_BYTES,
  GITHUB_METADATA_MAX_BYTES,
  GITHUB_REF_MAX_BYTES,
  GITHUB_SNAPSHOT_MAX_TIMEOUT_MS,
  GitHubSnapshotError,
  snapshotPublicGitHubRepository,
  type GitHubSnapshotFetch,
} from "../packages/analyzer/src/github-snapshot.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const METADATA_URL = "https://api.github.com/repos/Owner/Repo";
const COMMIT_URL = `${METADATA_URL}/commits/main`;
const ARCHIVE_URL = `https://codeload.github.com/Owner/Repo/zip/${SHA}`;

function responseBody(
  value: string | Uint8Array | null,
): BodyInit | null {
  if (value === null || typeof value === "string") return value;
  return new Uint8Array(value).buffer;
}

function responseAt(
  url: string,
  body: string | Uint8Array | null,
  init: ResponseInit = {},
  options: { readonly redirected?: boolean } = {},
): Response {
  const response = new Response(responseBody(body), init);
  Object.defineProperty(response, "url", { value: url });
  if (options.redirected !== undefined) {
    Object.defineProperty(response, "redirected", {
      value: options.redirected,
    });
  }
  return response;
}

function archive(): Uint8Array {
  return zipSync({
    [`Repo-${SHA}/src/main.ts`]: strToU8(
      "export const answer = 42;\n",
    ),
  });
}

function successfulFetch(
  calls: Array<{ readonly url: string; readonly init: RequestInit }> = [],
): GitHubSnapshotFetch {
  return async (input, init) => {
    const url = input.toString();
    calls.push({ url, init });
    switch (url) {
      case METADATA_URL:
        return responseAt(
          url,
          JSON.stringify({
            private: false,
            visibility: "public",
            full_name: "Owner/Repo",
            default_branch: "main",
          }),
        );
      case COMMIT_URL:
        return responseAt(url, JSON.stringify({ sha: SHA }));
      case ARCHIVE_URL:
        return responseAt(url, archive());
      default:
        throw new Error("Unexpected fake request.");
    }
  };
}

describe("public GitHub snapshots", () => {
  it("resolves a public repository to a SHA and materializes its ZIP deterministically", async () => {
    const calls: Array<{
      readonly url: string;
      readonly init: RequestInit;
    }> = [];
    const fetch = successfulFetch(calls);
    const request = {
      repositoryUrl: "https://github.com/Owner/Repo.git/",
    } as const;

    const first = await snapshotPublicGitHubRepository(request, { fetch });
    const second = await snapshotPublicGitHubRepository(request, {
      fetch: successfulFetch(),
    });

    expect(second).toEqual(first);
    expect(first).toMatchObject({
      owner: "Owner",
      repository: "Repo",
      canonicalRepositoryUrl: "https://github.com/Owner/Repo",
      commitSha: SHA,
      snapshot: {
        name: "Repo",
        files: [
          {
            path: "src/main.ts",
            text: "export const answer = 42;\n",
          },
        ],
      },
    });
    expect(Object.isFrozen(first)).toBe(true);
    expect(calls.map(({ url }) => url)).toEqual([
      METADATA_URL,
      COMMIT_URL,
      ARCHIVE_URL,
    ]);
    expect(
      calls.map(({ init }) => ({
        method: init.method,
        cache: init.cache,
        credentials: init.credentials,
        redirect: init.redirect,
        referrerPolicy: init.referrerPolicy,
      })),
    ).toEqual([
      {
        method: "GET",
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
      },
      {
        method: "GET",
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
      },
      {
        method: "GET",
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
      },
    ]);
    expect(calls.every(({ init }) => init.signal instanceof AbortSignal)).toBe(
      true,
    );
    for (const { init } of calls) {
      const headers = new Headers(init.headers);
      expect(headers.has("authorization")).toBe(false);
      expect(headers.has("cookie")).toBe(false);
    }
  });

  it("normalizes and encodes a bounded explicit ref before resolving its SHA", async () => {
    const expectedCommit =
      "https://api.github.com/repos/Owner/Repo/commits/feature%2FCaf%C3%A9";
    const calls: string[] = [];
    const fetch: GitHubSnapshotFetch = async (input) => {
      const url = input.toString();
      calls.push(url);
      if (url === METADATA_URL) {
        return responseAt(
          url,
          JSON.stringify({
            private: false,
            visibility: "public",
            full_name: "Owner/Repo",
          }),
        );
      }
      if (url === expectedCommit) {
        return responseAt(url, JSON.stringify({ sha: SHA.toUpperCase() }));
      }
      if (url === ARCHIVE_URL) return responseAt(url, archive());
      throw new Error("Unexpected fake request.");
    };

    const result = await snapshotPublicGitHubRepository(
      {
        repositoryUrl: "https://github.com/Owner/Repo",
        ref: "feature/Cafe\u0301",
      },
      { fetch },
    );

    expect(result.commitSha).toBe(SHA);
    expect(calls).toEqual([METADATA_URL, expectedCommit, ARCHIVE_URL]);
  });

  it("adopts canonical API casing after a case-insensitive URL match", async () => {
    const requestedMetadata =
      "https://api.github.com/repos/owner/repo";
    const calls: string[] = [];
    const fetch: GitHubSnapshotFetch = async (input) => {
      const url = input.toString();
      calls.push(url);
      if (url === requestedMetadata) {
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
      if (url === ARCHIVE_URL) return responseAt(url, archive());
      throw new Error("Unexpected fake request.");
    };

    const result = await snapshotPublicGitHubRepository(
      { repositoryUrl: "https://github.com/owner/repo" },
      { fetch },
    );

    expect(result).toMatchObject({
      owner: "Owner",
      repository: "Repo",
      canonicalRepositoryUrl: "https://github.com/Owner/Repo",
    });
    expect(calls).toEqual([
      requestedMetadata,
      COMMIT_URL,
      ARCHIVE_URL,
    ]);
  });

  it.each([
    "http://github.com/Owner/Repo",
    "https://example.com/Owner/Repo",
    "https://api.github.com/Owner/Repo",
    "https://user:secret@github.com/Owner/Repo",
    "https://github.com:444/Owner/Repo",
    "https://github.com/Owner/Repo?token=secret",
    "https://github.com/Owner/Repo#main",
    "https://github.com/Owner%2FRepo/Other",
    "https://github.com/Owner/Repo/extra",
    "https://github.com/Owner/Repo\n",
  ])("rejects non-canonical repository URL %s before HTTP", async (url) => {
    const fetch = vi.fn<GitHubSnapshotFetch>();

    await expect(
      snapshotPublicGitHubRepository({ repositoryUrl: url }, { fetch }),
    ).rejects.toMatchObject({
      code: "GITHUB_INVALID_REPOSITORY_URL",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects invalid or oversized refs before HTTP", async () => {
    const fetch = vi.fn<GitHubSnapshotFetch>();
    for (const ref of [
      "unsafe ref",
      "@",
      "-main",
      "../main",
      ".hidden/main",
      "feature/topic.lock",
      "feature//main",
      "main.lock..next",
      "x".repeat(GITHUB_REF_MAX_BYTES + 1),
    ]) {
      await expect(
        snapshotPublicGitHubRepository(
          {
            repositoryUrl: "https://github.com/Owner/Repo",
            ref,
          },
          { fetch },
        ),
        ref,
      ).rejects.toMatchObject({ code: "GITHUB_INVALID_REF" });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("accepts the reliable timer boundary and rejects larger deadlines", async () => {
    const fetch = vi.fn<GitHubSnapshotFetch>(async (input) =>
      responseAt(
        input.toString(),
        JSON.stringify({
          private: true,
          visibility: "private",
          full_name: "Owner/Repo",
        }),
      ),
    );
    await expect(
      snapshotPublicGitHubRepository(
        {
          repositoryUrl: "https://github.com/Owner/Repo",
          timeoutMs: GITHUB_SNAPSHOT_MAX_TIMEOUT_MS,
        },
        { fetch },
      ),
    ).rejects.toMatchObject({ code: "GITHUB_REPOSITORY_UNAVAILABLE" });
    expect(fetch).toHaveBeenCalledTimes(1);

    await expect(
      snapshotPublicGitHubRepository(
        {
          repositoryUrl: "https://github.com/Owner/Repo",
          timeoutMs: GITHUB_SNAPSHOT_MAX_TIMEOUT_MS + 1,
        },
        { fetch },
      ),
    ).rejects.toMatchObject({
      code: "GITHUB_INVALID_REQUEST",
      message:
        "GitHub snapshot timeout must be between 1 and 2,147,483,647 milliseconds.",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects redirects, missing response URLs, and endpoint changes", async () => {
    for (const response of [
      responseAt(METADATA_URL, "{}", {}, { redirected: true }),
      new Response("{}"),
      responseAt("https://evil.example/metadata", "{}"),
    ]) {
      const fetch = vi.fn<GitHubSnapshotFetch>(async () => response);
      await expect(
        snapshotPublicGitHubRepository(
          { repositoryUrl: "https://github.com/Owner/Repo" },
          { fetch },
        ),
      ).rejects.toMatchObject({ code: "GITHUB_INVALID_RESPONSE" });
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });

  it("cancels response bodies rejected before bounded consumption", async () => {
    const cases = [
      {
        url: "https://evil.example/metadata",
        status: 200,
        headers: {},
      },
      {
        url: METADATA_URL,
        status: 500,
        headers: {},
      },
      {
        url: METADATA_URL,
        status: 200,
        headers: {
          "content-length": String(GITHUB_METADATA_MAX_BYTES + 1),
        },
      },
    ] as const;

    for (const testCase of cases) {
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1]));
        },
        cancel() {
          cancelled = true;
        },
      });
      const response = new Response(body, {
        status: testCase.status,
        headers: testCase.headers,
      });
      Object.defineProperty(response, "url", { value: testCase.url });

      await expect(
        snapshotPublicGitHubRepository(
          { repositoryUrl: "https://github.com/Owner/Repo" },
          { fetch: async () => response },
        ),
      ).rejects.toBeInstanceOf(GitHubSnapshotError);
      await Promise.resolve();
      expect(cancelled).toBe(true);
    }
  });

  it("requires exact public repository metadata before resolving a ref", async () => {
    for (const metadata of [
      {
        private: true,
        visibility: "private",
        full_name: "Owner/Repo",
        default_branch: "main",
      },
      {
        private: false,
        visibility: "public",
        full_name: "Other/Repo",
        default_branch: "main",
      },
      {
        private: false,
        visibility: "public",
        full_name: "Owner/Repo",
        default_branch: ".hidden",
      },
    ]) {
      const fetch = vi.fn<GitHubSnapshotFetch>(async (input) =>
        responseAt(input.toString(), JSON.stringify(metadata)),
      );
      await expect(
        snapshotPublicGitHubRepository(
          { repositoryUrl: "https://github.com/Owner/Repo" },
          { fetch },
        ),
      ).rejects.toBeInstanceOf(GitHubSnapshotError);
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });

  it("caps streamed API bytes and cancels the reader", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(GITHUB_METADATA_MAX_BYTES));
        controller.enqueue(new Uint8Array([1]));
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = new Response(body);
    Object.defineProperty(response, "url", { value: METADATA_URL });

    await expect(
      snapshotPublicGitHubRepository(
        { repositoryUrl: "https://github.com/Owner/Repo" },
        { fetch: async () => response },
      ),
    ).rejects.toMatchObject({ code: "GITHUB_RESPONSE_TOO_LARGE" });
    await Promise.resolve();
    expect(cancelled).toBe(true);
  });

  it("rejects an oversized archive from Content-Length before reading it", async () => {
    const calls: string[] = [];
    const fetch: GitHubSnapshotFetch = async (input) => {
      const url = input.toString();
      calls.push(url);
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
      return responseAt(url, null, {
        headers: {
          "content-length": String(GITHUB_ARCHIVE_MAX_BYTES + 1),
        },
      });
    };

    await expect(
      snapshotPublicGitHubRepository(
        { repositoryUrl: "https://github.com/Owner/Repo" },
        { fetch },
      ),
    ).rejects.toMatchObject({ code: "GITHUB_RESPONSE_TOO_LARGE" });
    expect(calls).toEqual([METADATA_URL, COMMIT_URL, ARCHIVE_URL]);
  });

  it("races an injected fetch that ignores caller cancellation and removes listeners", async () => {
    const controller = new AbortController();
    const added = vi.spyOn(controller.signal, "addEventListener");
    const removed = vi.spyOn(controller.signal, "removeEventListener");
    const pending = snapshotPublicGitHubRepository(
      {
        repositoryUrl: "https://github.com/Owner/Repo",
        signal: controller.signal,
      },
      {
        fetch: async () =>
          await new Promise<Response>(() => {
            // The adapter cancellation boundary must settle this call.
          }),
      },
    );
    const rejection = expect(pending).rejects.toMatchObject({
      code: "GITHUB_ABORTED",
    });

    controller.abort();
    await rejection;
    expect(added).toHaveBeenCalledWith(
      "abort",
      expect.any(Function),
      { once: true },
    );
    expect(removed).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("enforces one combined deadline and clears its timer", async () => {
    vi.useFakeTimers();
    try {
      const pending = snapshotPublicGitHubRepository(
        {
          repositoryUrl: "https://github.com/Owner/Repo",
          timeoutMs: 25,
        },
        {
          fetch: async () =>
            await new Promise<Response>(() => {
              // The injected transport intentionally ignores AbortSignal.
            }),
        },
      );
      const rejection = expect(pending).rejects.toMatchObject({
        code: "GITHUB_DEADLINE_EXCEEDED",
      });

      await vi.advanceTimersByTimeAsync(25);
      await rejection;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not leak transport errors or continue after invalid API data", async () => {
    const secret = "gho_private_transport_detail";
    let message = "";
    try {
      await snapshotPublicGitHubRepository(
        { repositoryUrl: "https://github.com/Owner/Repo" },
        {
          fetch: async () => {
            throw new Error(secret);
          },
        },
      );
    } catch (error) {
      expect(error).toBeInstanceOf(GitHubSnapshotError);
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain(secret);

    const fetch = vi.fn<GitHubSnapshotFetch>(async (input) =>
      responseAt(
        input.toString(),
        JSON.stringify({
          private: false,
          visibility: "public",
          full_name: "Owner/Repo",
          default_branch: "main",
        }),
      ),
    );
    await expect(
      snapshotPublicGitHubRepository(
        { repositoryUrl: "https://github.com/Owner/Repo" },
        { fetch },
      ),
    ).rejects.toMatchObject({ code: "GITHUB_INVALID_RESPONSE" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
