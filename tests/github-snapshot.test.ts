import { strToU8, zipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";

import {
  GITHUB_ARCHIVE_MAX_BYTES,
  GITHUB_METADATA_MAX_BYTES,
  GITHUB_REF_MAX_BYTES,
  GITHUB_SNAPSHOT_MAX_TIMEOUT_MS,
  GitHubSnapshotError,
  snapshotPublicGitHubRepository,
  type GitHubSnapshotCredential,
  type GitHubSnapshotCredentialProvider,
  type GitHubSnapshotFetch,
} from "../packages/analyzer/src/github-snapshot.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const METADATA_URL = "https://api.github.com/repos/Owner/Repo";
const COMMIT_URL = `${METADATA_URL}/commits/main`;
const ARCHIVE_URL = `https://codeload.github.com/Owner/Repo/zip/${SHA}`;
const AUTHENTICATED_ARCHIVE_URL =
  `${METADATA_URL}/zipball/${SHA}`;
const SIGNED_CODELOAD_URL =
  `https://codeload.github.com/oWnEr/rEpO/legacy.zip/${SHA}?download=opaque,still-opaque`;

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

function providerFor(
  credential: GitHubSnapshotCredential,
  onRelease: () => void = () => {},
): GitHubSnapshotCredentialProvider {
  return {
    provider: "github",
    async use(signal, operation) {
      expect(signal).toBeInstanceOf(AbortSignal);
      try {
        return await operation(credential);
      } finally {
        onRelease();
      }
    },
  };
}

function successfulAuthenticatedFetch(
  calls: Array<{ readonly url: string; readonly init: RequestInit }> = [],
  metadata: Readonly<Record<string, unknown>> = {
    private: true,
    visibility: "private",
    full_name: "Owner/Repo",
    default_branch: "main",
  },
): GitHubSnapshotFetch {
  return async (input, init) => {
    const url = input.toString();
    calls.push({ url, init });
    switch (url) {
      case METADATA_URL:
        return responseAt(url, JSON.stringify(metadata));
      case COMMIT_URL:
        return responseAt(url, JSON.stringify({ sha: SHA }));
      case AUTHENTICATED_ARCHIVE_URL:
        return responseAt(url, null, {
          status: 302,
          headers: { location: SIGNED_CODELOAD_URL },
        });
      case SIGNED_CODELOAD_URL:
        return responseAt(url, archive());
      default:
        throw new Error("Unexpected fake request.");
    }
  };
}

describe("GitHub snapshots", () => {
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

  it("uses a bearer credential only on exact API requests and releases it before materialization", async () => {
    const calls: Array<{
      readonly url: string;
      readonly init: RequestInit;
    }> = [];
    const secretText = "github_pat_private_token";
    const secret = new TextEncoder().encode(secretText);
    let released = false;
    const credentialProvider = providerFor(
      { kind: "bearer", secret },
      () => {
        secret.fill(0);
        released = true;
      },
    );

    const result = await snapshotPublicGitHubRepository(
      { repositoryUrl: "https://github.com/Owner/Repo" },
      {
        fetch: successfulAuthenticatedFetch(calls),
        credentialProvider,
      },
    );

    expect(result).toMatchObject({
      owner: "Owner",
      repository: "Repo",
      canonicalRepositoryUrl: "https://github.com/Owner/Repo",
      commitSha: SHA,
      snapshot: {
        files: [{ path: "src/main.ts" }],
      },
    });
    expect(calls.map(({ url }) => url)).toEqual([
      METADATA_URL,
      COMMIT_URL,
      AUTHENTICATED_ARCHIVE_URL,
      SIGNED_CODELOAD_URL,
    ]);
    expect(calls.map(({ init }) => init.redirect)).toEqual([
      "error",
      "error",
      "manual",
      "error",
    ]);
    expect(
      calls.map(({ init }) =>
        new Headers(init.headers).get("authorization"),
      ),
    ).toEqual([
      `Bearer ${secretText}`,
      `Bearer ${secretText}`,
      `Bearer ${secretText}`,
      null,
    ]);
    for (const { url, init } of calls) {
      const parsed = new URL(url);
      expect(parsed.username).toBe("");
      expect(parsed.password).toBe("");
      expect(init.credentials).toBe("omit");
      expect(new Headers(init.headers).has("cookie")).toBe(false);
    }
    expect(released).toBe(true);
    expect([...secret]).toEqual(new Array(secret.byteLength).fill(0));
    expect(JSON.stringify(result)).not.toContain(secretText);
    expect(JSON.stringify(result)).not.toContain("Authorization");
    expect(JSON.stringify(result)).not.toContain("download=opaque");
  });

  it("cancels the authenticated redirect body before requesting codeload", async () => {
    let redirectBodyCancelled = false;
    const secret = new TextEncoder().encode("github_pat_cleanup");
    const fetch: GitHubSnapshotFetch = async (input) => {
      const url = input.toString();
      if (url === METADATA_URL) {
        return responseAt(
          url,
          JSON.stringify({
            private: true,
            visibility: "private",
            full_name: "Owner/Repo",
            default_branch: "main",
          }),
        );
      }
      if (url === COMMIT_URL) {
        return responseAt(url, JSON.stringify({ sha: SHA }));
      }
      if (url === AUTHENTICATED_ARCHIVE_URL) {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1]));
          },
          cancel() {
            redirectBodyCancelled = true;
          },
        });
        const response = new Response(body, {
          status: 302,
          headers: { location: SIGNED_CODELOAD_URL },
        });
        Object.defineProperty(response, "url", { value: url });
        return response;
      }
      if (url === SIGNED_CODELOAD_URL) {
        expect(redirectBodyCancelled).toBe(true);
        return responseAt(url, archive());
      }
      throw new Error("Unexpected fake request.");
    };

    await snapshotPublicGitHubRepository(
      { repositoryUrl: "https://github.com/Owner/Repo" },
      {
        fetch,
        credentialProvider: providerFor(
          { kind: "bearer", secret },
          () => secret.fill(0),
        ),
      },
    );

    expect(redirectBodyCancelled).toBe(true);
  });

  it.each(["caller abort", "deadline"] as const)(
    "bounds a never-settling redirect cleanup by the %s",
    async (boundary) => {
      if (boundary === "deadline") {
        vi.useFakeTimers({
          toFake: ["Date", "setTimeout", "clearTimeout"],
        });
      }
      try {
        const controller = new AbortController();
        const calls: string[] = [];
        const secret = new TextEncoder().encode(
          "github_pat_cleanup_boundary",
        );
        let cleanupStarted!: () => void;
        const cleanup = new Promise<void>((resolve) => {
          cleanupStarted = resolve;
        });
        const fetch: GitHubSnapshotFetch = async (input) => {
          const url = input.toString();
          calls.push(url);
          if (url === METADATA_URL) {
            return responseAt(
              url,
              JSON.stringify({
                private: true,
                visibility: "private",
                full_name: "Owner/Repo",
                default_branch: "main",
              }),
            );
          }
          if (url === COMMIT_URL) {
            return responseAt(url, JSON.stringify({ sha: SHA }));
          }
          if (url === AUTHENTICATED_ARCHIVE_URL) {
            const body = new ReadableStream<Uint8Array>({
              start(streamController) {
                streamController.enqueue(new Uint8Array([1]));
              },
              cancel() {
                cleanupStarted();
                return new Promise<void>(() => {
                  // The cleanup transport intentionally never settles.
                });
              },
            });
            const response = new Response(body, {
              status: 302,
              headers: { location: SIGNED_CODELOAD_URL },
            });
            Object.defineProperty(response, "url", { value: url });
            return response;
          }
          throw new Error("Codeload must not start during cleanup.");
        };

        const pending = snapshotPublicGitHubRepository(
          {
            repositoryUrl: "https://github.com/Owner/Repo",
            ...(boundary === "caller abort"
              ? { signal: controller.signal }
              : { timeoutMs: 25 }),
          },
          {
            fetch,
            credentialProvider: providerFor(
              { kind: "bearer", secret },
              () => secret.fill(0),
            ),
          },
        );
        const rejection = pending.catch((error: unknown) => error);

        await cleanup;
        if (boundary === "caller abort") {
          controller.abort();
        } else {
          await vi.advanceTimersByTimeAsync(25);
        }
        expect(await rejection).toMatchObject({
          code:
            boundary === "caller abort"
              ? "GITHUB_ABORTED"
              : "GITHUB_DEADLINE_EXCEEDED",
        });

        expect(calls).toEqual([
          METADATA_URL,
          COMMIT_URL,
          AUTHENTICATED_ARCHIVE_URL,
        ]);
        expect([...secret]).toEqual(
          new Array(secret.byteLength).fill(0),
        );
      } finally {
        if (boundary === "deadline") vi.useRealTimers();
      }
    },
  );

  it("rejects non-bearer GitHub credential material before HTTP", async () => {
    const fetch = vi.fn<GitHubSnapshotFetch>();
    const secret = new TextEncoder().encode("basic-is-unsupported");
    const forgedBasic = {
      kind: "basic",
      username: "octocat",
      secret,
    } as unknown as GitHubSnapshotCredential;

    await expect(
      snapshotPublicGitHubRepository(
        { repositoryUrl: "https://github.com/Owner/Repo" },
        {
          fetch,
          credentialProvider: providerFor(
            forgedBasic,
            () => secret.fill(0),
          ),
        },
      ),
    ).rejects.toMatchObject({ code: "GITHUB_INVALID_REQUEST" });

    expect(fetch).not.toHaveBeenCalled();
    expect([...secret]).toEqual(new Array(secret.byteLength).fill(0));
  });

  it("accepts internally consistent internal repository metadata only with credentials", async () => {
    const metadata = {
      private: false,
      visibility: "internal",
      full_name: "Owner/Repo",
      default_branch: "main",
    } as const;
    const secret = new TextEncoder().encode("github_pat_internal");

    await expect(
      snapshotPublicGitHubRepository(
        { repositoryUrl: "https://github.com/Owner/Repo" },
        {
          fetch: successfulAuthenticatedFetch([], metadata),
          credentialProvider: providerFor(
            { kind: "bearer", secret },
            () => secret.fill(0),
          ),
        },
      ),
    ).resolves.toMatchObject({
      owner: "Owner",
      repository: "Repo",
      commitSha: SHA,
    });

    const anonymousFetch = vi.fn<GitHubSnapshotFetch>(async (input) =>
      responseAt(input.toString(), JSON.stringify(metadata)),
    );
    await expect(
      snapshotPublicGitHubRepository(
        { repositoryUrl: "https://github.com/Owner/Repo" },
        { fetch: anonymousFetch },
      ),
    ).rejects.toMatchObject({
      code: "GITHUB_REPOSITORY_UNAVAILABLE",
    });
    expect(anonymousFetch).toHaveBeenCalledTimes(1);
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

  it.each([
    { label: "a missing Location", location: undefined },
    { label: "a relative Location", location: "/Owner/Repo/archive.zip" },
    {
      label: "a protocol-relative Location",
      location: "//codeload.github.com/Owner/Repo/archive.zip",
    },
    { label: "a malformed Location", location: "not a URL" },
    {
      label: "a non-HTTPS Location",
      location: "http://codeload.github.com/Owner/Repo/archive.zip",
    },
    {
      label: "a hostile host",
      location:
        "https://codeload.github.com.evil.example/Owner/Repo/archive.zip",
    },
    {
      label: "Location userinfo",
      location:
        "https://user:location-secret@codeload.github.com/Owner/Repo/archive.zip",
    },
    {
      label: "a custom port",
      location:
        "https://codeload.github.com:444/Owner/Repo/archive.zip",
    },
    {
      label: "a fragment",
      location:
        "https://codeload.github.com/Owner/Repo/archive.zip#location-secret",
    },
    {
      label: "multiple targets",
      location:
        "https://codeload.github.com/Owner/Repo/one.zip, https://codeload.github.com/Owner/Repo/two.zip",
    },
    {
      label: "the wrong owner",
      location:
        `https://codeload.github.com/Other/Repo/legacy.zip/${SHA}`,
    },
    {
      label: "the wrong repository",
      location:
        `https://codeload.github.com/Owner/Other/legacy.zip/${SHA}`,
    },
    {
      label: "the wrong commit SHA",
      location:
        "https://codeload.github.com/Owner/Repo/legacy.zip/ffffffffffffffffffffffffffffffffffffffff",
    },
    {
      label: "an uppercase commit SHA",
      location:
        `https://codeload.github.com/Owner/Repo/legacy.zip/${SHA.toUpperCase()}`,
    },
    {
      label: "a different archive form",
      location:
        `https://codeload.github.com/Owner/Repo/zip/${SHA}`,
    },
    {
      label: "an extra path component",
      location:
        `https://codeload.github.com/Owner/Repo/legacy.zip/${SHA}/extra`,
    },
    {
      label: "a percent-encoded repository path",
      location:
        `https://codeload.github.com/Owner/%52epo/legacy.zip/${SHA}`,
    },
    {
      label: "a normalized dot-segment path",
      location:
        `https://codeload.github.com/Owner/Other/../Repo/legacy.zip/${SHA}`,
    },
  ])("rejects $label from the authenticated archive hop", async ({
    location,
  }) => {
    const calls: Array<{
      readonly url: string;
      readonly init: RequestInit;
    }> = [];
    const secretText = "github_pat_redirect_secret";
    const secret = new TextEncoder().encode(secretText);
    const fetch: GitHubSnapshotFetch = async (input, init) => {
      const url = input.toString();
      calls.push({ url, init });
      if (url === METADATA_URL) {
        return responseAt(
          url,
          JSON.stringify({
            private: true,
            visibility: "private",
            full_name: "Owner/Repo",
            default_branch: "main",
          }),
        );
      }
      if (url === COMMIT_URL) {
        return responseAt(url, JSON.stringify({ sha: SHA }));
      }
      if (url === AUTHENTICATED_ARCHIVE_URL) {
        return responseAt(url, null, {
          status: 302,
          headers:
            location === undefined ? {} : { location },
        });
      }
      throw new Error("The codeload target must not be requested.");
    };

    let failure: unknown;
    try {
      await snapshotPublicGitHubRepository(
        { repositoryUrl: "https://github.com/Owner/Repo" },
        {
          fetch,
          credentialProvider: providerFor(
            { kind: "bearer", secret },
            () => secret.fill(0),
          ),
        },
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ code: "GITHUB_INVALID_RESPONSE" });
    expect(calls.map(({ url }) => url)).toEqual([
      METADATA_URL,
      COMMIT_URL,
      AUTHENTICATED_ARCHIVE_URL,
    ]);
    expect(calls[2]?.init.redirect).toBe("manual");
    expect(
      new Headers(calls[2]?.init.headers).get("authorization"),
    ).toBe(`Bearer ${secretText}`);
    const renderedFailure =
      failure instanceof Error
        ? `${failure.name}: ${failure.message}`
        : String(failure);
    expect(renderedFailure).not.toContain(secretText);
    expect(renderedFailure).not.toContain("Authorization");
    expect(renderedFailure).not.toContain("location-secret");
  });

  it("rejects raw Unicode components that fold to the requested ASCII identity", async () => {
    const requestedOwner = "Kwner";
    const metadataUrl =
      `https://api.github.com/repos/${requestedOwner}/Repo`;
    const commitUrl = `${metadataUrl}/commits/main`;
    const archiveUrl = `${metadataUrl}/zipball/${SHA}`;
    const rawLocation =
      `https://codeload.github.com/\u212Awner/Repo/legacy.zip/${SHA}`;
    const calls: string[] = [];
    const secret = new TextEncoder().encode("github_pat_unicode_path");
    const fetch: GitHubSnapshotFetch = async (input) => {
      const url = input.toString();
      calls.push(url);
      if (url === metadataUrl) {
        return responseAt(
          url,
          JSON.stringify({
            private: true,
            visibility: "private",
            full_name: `${requestedOwner}/Repo`,
            default_branch: "main",
          }),
        );
      }
      if (url === commitUrl) {
        return responseAt(url, JSON.stringify({ sha: SHA }));
      }
      if (url === archiveUrl) {
        const response = responseAt(url, null, { status: 302 });
        Object.defineProperty(response, "headers", {
          value: {
            get(name: string): string | null {
              return name.toLocaleLowerCase("en-US") === "location"
                ? rawLocation
                : null;
            },
          },
        });
        return response;
      }
      throw new Error("The Unicode codeload target must not be requested.");
    };

    await expect(
      snapshotPublicGitHubRepository(
        {
          repositoryUrl:
            `https://github.com/${requestedOwner}/Repo`,
        },
        {
          fetch,
          credentialProvider: providerFor(
            { kind: "bearer", secret },
            () => secret.fill(0),
          ),
        },
      ),
    ).rejects.toMatchObject({ code: "GITHUB_INVALID_RESPONSE" });

    expect(calls).toEqual([metadataUrl, commitUrl, archiveUrl]);
    expect([...secret]).toEqual(new Array(secret.byteLength).fill(0));
  });

  it.each(["API archive", "codeload archive"] as const)(
    "rejects a followed redirect at the %s hop without forwarding credentials",
    async (redirectedHop) => {
      const calls: Array<{
        readonly url: string;
        readonly init: RequestInit;
      }> = [];
      const secret = new TextEncoder().encode("github_pat_redirected");
      const fetch: GitHubSnapshotFetch = async (input, init) => {
        const url = input.toString();
        calls.push({ url, init });
        if (url === METADATA_URL) {
          return responseAt(
            url,
            JSON.stringify({
              private: true,
              visibility: "private",
              full_name: "Owner/Repo",
              default_branch: "main",
            }),
          );
        }
        if (url === COMMIT_URL) {
          return responseAt(url, JSON.stringify({ sha: SHA }));
        }
        if (url === AUTHENTICATED_ARCHIVE_URL) {
          return responseAt(
            url,
            null,
            {
              status: 302,
              headers: { location: SIGNED_CODELOAD_URL },
            },
            { redirected: redirectedHop === "API archive" },
          );
        }
        if (url === SIGNED_CODELOAD_URL) {
          return responseAt(
            url,
            archive(),
            {},
            { redirected: redirectedHop === "codeload archive" },
          );
        }
        throw new Error("Unexpected fake request.");
      };

      await expect(
        snapshotPublicGitHubRepository(
          { repositoryUrl: "https://github.com/Owner/Repo" },
          {
            fetch,
            credentialProvider: providerFor(
              { kind: "bearer", secret },
              () => secret.fill(0),
            ),
          },
        ),
      ).rejects.toMatchObject({ code: "GITHUB_INVALID_RESPONSE" });

      const apiArchiveCall = calls.find(
        ({ url }) => url === AUTHENTICATED_ARCHIVE_URL,
      );
      expect(apiArchiveCall?.init.redirect).toBe("manual");
      expect(
        new Headers(apiArchiveCall?.init.headers).has("authorization"),
      ).toBe(true);
      const codeloadCall = calls.find(
        ({ url }) => url === SIGNED_CODELOAD_URL,
      );
      if (codeloadCall !== undefined) {
        expect(codeloadCall.init.redirect).toBe("error");
        expect(
          new Headers(codeloadCall.init.headers).has("authorization"),
        ).toBe(false);
      }
    },
  );

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

  it("keeps full_name identity exact for credentialed repositories", async () => {
    const calls: Array<{
      readonly url: string;
      readonly init: RequestInit;
    }> = [];
    const secret = new TextEncoder().encode("github_pat_identity");

    await expect(
      snapshotPublicGitHubRepository(
        { repositoryUrl: "https://github.com/Owner/Repo" },
        {
          fetch: successfulAuthenticatedFetch(calls, {
            private: true,
            visibility: "private",
            full_name: "Other/Repo",
            default_branch: "main",
          }),
          credentialProvider: providerFor(
            { kind: "bearer", secret },
            () => secret.fill(0),
          ),
        },
      ),
    ).rejects.toMatchObject({
      code: "GITHUB_REPOSITORY_UNAVAILABLE",
    });
    expect(calls.map(({ url }) => url)).toEqual([METADATA_URL]);
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
    vi.useFakeTimers({
      toFake: ["Date", "setTimeout", "clearTimeout"],
    });
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
      const rejection = pending.catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(25);
      expect(await rejection).toMatchObject({
        code: "GITHUB_DEADLINE_EXCEEDED",
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects unsafe bearer material before HTTP and still releases its bytes", async () => {
    const secret = new TextEncoder().encode(
      "github_pat_safe\r\nX-Leak: injected",
    );
    const fetch = vi.fn<GitHubSnapshotFetch>();

    await expect(
      snapshotPublicGitHubRepository(
        { repositoryUrl: "https://github.com/Owner/Repo" },
        {
          fetch,
          credentialProvider: providerFor(
            { kind: "bearer", secret },
            () => secret.fill(0),
          ),
        },
      ),
    ).rejects.toMatchObject({ code: "GITHUB_INVALID_REQUEST" });

    expect(fetch).not.toHaveBeenCalled();
    expect([...secret]).toEqual(new Array(secret.byteLength).fill(0));
  });

  it("does not expose an authenticated header through transport failures", async () => {
    const secretText = "github_pat_transport_secret";
    const secret = new TextEncoder().encode(secretText);
    let message = "";
    try {
      await snapshotPublicGitHubRepository(
        { repositoryUrl: "https://github.com/Owner/Repo" },
        {
          fetch: async (_input, init) => {
            throw new Error(
              `transport retained ${new Headers(init.headers).get(
                "authorization",
              )}`,
            );
          },
          credentialProvider: providerFor(
            { kind: "bearer", secret },
            () => secret.fill(0),
          ),
        },
      );
    } catch (error) {
      expect(error).toBeInstanceOf(GitHubSnapshotError);
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).not.toContain(secretText);
    expect(message).not.toContain("Bearer");
    expect(message).not.toContain("Authorization");
    expect([...secret]).toEqual(new Array(secret.byteLength).fill(0));
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
