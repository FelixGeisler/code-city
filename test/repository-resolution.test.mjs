import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(/^\.\.?\//.test(specifier) && !/\.[a-z]+$/i.test(specifier) ? `${specifier}.ts` : specifier, context);
  },
});
const { resolveRevision } = await import("../src/application/resolution.ts");
const { parseRepositoryReference } = await import("../src/domain/repository-reference.ts");
const { createGithubRevisionGateway, githubRevisionUrl } = await import("../src/edge/github-revision-gateway.ts");

const SHA40 = "a".repeat(40);
const SHA64 = "b".repeat(64);
const REPOSITORY = { owner: "owner", repository: "repo", branch: null };
const BRANCH_REPOSITORY = { owner: "owner", repository: "repo", branch: "feature/x" };

function response({ body = "", ok = true, redirected = false, status = 200, url = githubRevisionUrl(REPOSITORY) } = {}) {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  return {
    body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
    ok,
    redirected,
    status,
    url,
  };
}

async function gatewayFor(fakeResponse, repository = REPOSITORY) {
  const calls = [];
  const gateway = createGithubRevisionGateway(async (...args) => {
    calls.push(args);
    return fakeResponse;
  });
  return { calls, result: await gateway(repository, new AbortController().signal) };
}

test("repository URL policy trims only surrounding ASCII whitespace and preserves accepted segments", () => {
  const accepted = [
    ["https://github.com/owner/repo", { owner: "owner", repository: "repo", branch: null }],
    [" \t\r\nhttps://github.com/Owner/a:b @c!()'*~\r\n", { owner: "Owner", repository: "a:b @c!()'*~", branch: null }],
    ["https://github.com/.hidden/..still-a-name", { owner: ".hidden", repository: "..still-a-name", branch: null }],
    ["https://github.com/a/b.", { owner: "a", repository: "b.", branch: null }],
    ["https://github.com/owner/repo\f", { owner: "owner", repository: "repo\f", branch: null }],
    ["https://github.com/owner/repo/tree/feature/x", BRANCH_REPOSITORY],
    ["https://github.com/owner/repo/tree/feature%2Fx", BRANCH_REPOSITORY],
    ["https://github.com/owner/repo/tree/punctuation%3F%23%5C", { owner: "owner", repository: "repo", branch: "punctuation?#\\" }],
    ["https://github.com/owner/repo/tree/literal%252Ftext/%252E", { owner: "owner", repository: "repo", branch: "literal%2Ftext/%2E" }],
    ["https://github.com/owner/repo/tree/feature/x/src", { owner: "owner", repository: "repo", branch: "feature/x/src" }],
  ];
  for (const [value, expected] of accepted) {
    assert.deepEqual(parseRepositoryReference(value), expected, value);
  }

  const rejected = [
    "https://github.com/owner", "https://github.com//repo", "https://github.com/owner/",
    "https://github.com/owner/repo/", "https://github.com/owner/repo/extra",
    "https://github.com/owner/repo/tree", "https://github.com/owner/repo/tree/",
    "https://github.com/owner/repo/tree//x", "https://github.com/owner/repo/tree/x/",
    "https://github.com/owner/repo/tree/.", "https://github.com/owner/repo/tree/..",
    "https://github.com/owner/repo/tree/x/./y", "https://github.com/owner/repo/tree/x/%2E%2E/y",
    "https://github.com/owner/repo/tree/x%2F%2Fy", "https://github.com/owner/repo/tree/%2E",
    "https://github.com/owner/repo/tree/%", "https://github.com/owner/repo/tree/x%2",
    "https://github.com/owner/repo/tree/x\\y", "https://github.com/owner/repo/tree/x?query",
    "https://github.com/owner/repo/tree/x#fragment", "https://github.com/owner/repo/blob/x",
    "https://github.com/owner/repo/commit/abc", "https://github.com/owner/repo/tags",
    "http://github.com/owner/repo", "https://GitHub.com/owner/repo",
    "https://user@github.com/owner/repo", "https://github.com:443/owner/repo",
    "https://github.com/owner/repo?q=1", "https://github.com/owner/repo#part",
    "https://github.com/own%65r/repo", "https://github.com/owner/re%70o",
    "https://github.com/owner\\x/repo", "https://github.com/owner/repo\\x",
    "https://github.com/./repo", "https://github.com/../repo",
    "https://github.com/owner/.", "https://github.com/owner/..",
    `https://github.com/ow${String.fromCharCode(0xd800)}ner/repo`,
    `https://github.com/owner/re${String.fromCharCode(0xdc00)}po`,
    `https://github.com/owner/repo/tree/x${String.fromCharCode(0xd800)}`,
    "\vhttps://github.com/owner/repo",
    null, 42,
  ];
  for (const value of rejected) {
    assert.equal(parseRepositoryReference(value), undefined, value);
  }
});

test("gateway independently encodes inert segments without allowing URL route normalization", () => {
  const url = githubRevisionUrl({ owner: "a:b @c", repository: "..still!'()*~", branch: null });
  assert.equal(url, "https://api.github.com/repos/a%3Ab%20%40c/..still%21%27%28%29%2A~/commits?per_page=1&page=1");
  assert.equal(new URL(url).pathname, "/repos/a%3Ab%20%40c/..still%21%27%28%29%2A~/commits");
  for (const reference of [
    { owner: "..x", repository: "y", branch: null },
    { owner: "x", repository: ".y", branch: null },
    { owner: "a／b", repository: "c", branch: null },
  ]) {
    assert.match(githubRevisionUrl(reference), /^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/commits\?per_page=1&page=1$/);
  }
});

test("route encoding rejects rather than mutates lone surrogates before Fetch", async () => {
  const invalid = { owner: `ow${String.fromCharCode(0xd800)}ner`, repository: "repo", branch: null };
  assert.throws(() => githubRevisionUrl(invalid), /Unicode scalar/);
  let calls = 0;
  const gateway = createGithubRevisionGateway(async () => { calls += 1; return response(); });
  await assert.rejects(gateway(invalid, new AbortController().signal), /Unicode scalar/);
  assert.equal(calls, 0);
});

test("gateway makes the exact sole native-fetch request", async () => {
  const fake = response({ body: JSON.stringify([{ sha: SHA40 }]) });
  const { calls, result } = await gatewayFor(fake);
  assert.deepEqual(result, { kind: "revision", revision: SHA40 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "https://api.github.com/repos/owner/repo/commits?per_page=1&page=1");
  const signal = calls[0][1].signal;
  assert.deepEqual(calls[0][1], {
    method: "GET",
    headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10" },
    mode: "cors",
    credentials: "omit",
    referrer: "",
    referrerPolicy: "no-referrer",
    cache: "no-store",
    redirect: "error",
    signal,
  });
  assert(signal instanceof AbortSignal);
});

test("branch gateway encodes the whole decoded name once and projects matching branch evidence", async () => {
  const branches = [
    ["feature/x", "feature%2Fx"],
    ["punctuation?#\\", "punctuation%3F%23%5C"],
    ["literal%2Ftext/%2E", "literal%252Ftext%2F%252E"],
  ];
  for (const [branch, encoded] of branches) {
    const repository = { ...REPOSITORY, branch };
    const requestUrl = `https://api.github.com/repos/owner/repo/branches/${encoded}`;
    assert.equal(githubRevisionUrl(repository), requestUrl);
    const fake = response({ body: JSON.stringify({ name: branch, commit: { sha: SHA40 }, ignored: true }), url: requestUrl });
    const { calls, result } = await gatewayFor(fake, repository);
    assert.deepEqual(result, { kind: "revision", revision: SHA40 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], requestUrl);
  }
});

test("branch evidence must match the selected branch and contain an own full commit ID", async () => {
  const requestUrl = githubRevisionUrl(BRANCH_REPOSITORY);
  const invalidBodies = [
    {}, { name: "feature", commit: { sha: SHA40 } }, { name: "feature/x" },
    { name: "feature/x", commit: {} }, { name: "feature/x", commit: { SHA: SHA40 } },
    { name: "feature/x", commit: { sha: SHA40.toUpperCase() } },
  ];
  for (const body of invalidBodies) {
    const result = await gatewayFor(response({ body: JSON.stringify(body), url: requestUrl }), BRANCH_REPOSITORY);
    assert.deepEqual(result.result, { kind: "invalid-evidence" });
  }
});

test("gateway requires the exact non-redirected response URL and releases rejected responses", async () => {
  for (const changes of [
    { redirected: true },
    { url: "https://api.github.com/repos/owner/repo/commits?page=1&per_page=1" },
  ]) {
    let cancelled = 0;
    const fake = response({ body: JSON.stringify([{ sha: SHA40 }]), ...changes });
    fake.body = new ReadableStream({ cancel() { cancelled += 1; } });
    const { result } = await gatewayFor(fake);
    assert.deepEqual(result, { kind: "invalid-evidence" });
    assert.equal(cancelled, 1);
  }
});

test("gateway enforces the streamed 1 MiB boundary and fatal UTF-8", async () => {
  const valid = JSON.stringify([{ sha: SHA40 }]);
  const exact = new TextEncoder().encode(valid + " ".repeat(1_048_576 - valid.length));
  assert.deepEqual((await gatewayFor(response({ body: exact }))).result, { kind: "revision", revision: SHA40 });

  let cancelled = 0;
  const reader = {
    reads: 0,
    async read() {
      this.reads += 1;
      return this.reads === 1
        ? { done: false, value: new Uint8Array(1_048_577) }
        : { done: true };
    },
    async cancel() { cancelled += 1; },
    releaseLock() { this.released = (this.released ?? 0) + 1; },
  };
  const oversized = response();
  oversized.body = { getReader: () => reader };
  assert.deepEqual((await gatewayFor(oversized)).result, { kind: "invalid-evidence" });
  assert.equal(cancelled, 1);
  assert.equal(reader.released, 1);

  const invalidUtf8 = Uint8Array.from([0x5b, 0x22, 0xff, 0x22, 0x5d]);
  assert.deepEqual((await gatewayFor(response({ body: invalidUtf8 }))).result, { kind: "invalid-evidence" });
});

test("gateway projects only a valid first own primitive revision", async () => {
  const accepted = [SHA40, SHA64];
  for (const sha of accepted) {
    assert.deepEqual((await gatewayFor(response({ body: JSON.stringify([{ sha }, { sha: "c".repeat(41) }]) }))).result, { kind: "revision", revision: sha });
  }
  const invalidBodies = [
    "{}", "[null]", "[{}]", `[{"SHA":"${SHA40}"}]`, `[{"sha":${JSON.stringify({ value: SHA40 })}}]`,
    `[{"__proto__":{"sha":"${SHA40}"}}]`, `[{"sha":"${"a".repeat(39)}"}]`,
    `[{"sha":"${"a".repeat(41)}"}]`, `[{"sha":"${"a".repeat(63)}"}]`,
    `[{"sha":"${"a".repeat(65)}"}]`, `[{"sha":"${"A".repeat(40)}"}]`, "not json",
  ];
  for (const body of invalidBodies) {
    assert.deepEqual((await gatewayFor(response({ body }))).result, { kind: "invalid-evidence" }, body);
  }
  assert.deepEqual((await gatewayFor(response({ body: "[]" }))).result, { kind: "empty" });
});

test("application exclusively maps default and explicit-branch statuses without fallback", async () => {
  const cases = [
    [REPOSITORY, { kind: "http", status: 404 }, { kind: "failure", category: "Repository unavailable for anonymous access" }],
    [BRANCH_REPOSITORY, { kind: "http", status: 404 }, { kind: "failure", category: "Revision unavailable" }],
    [REPOSITORY, { kind: "http", status: 409 }, { kind: "failure", category: "Revision unavailable" }],
    [BRANCH_REPOSITORY, { kind: "http", status: 409 }, { kind: "failure", category: "Revision unavailable" }],
    [REPOSITORY, { kind: "empty" }, { kind: "failure", category: "Revision unavailable" }],
    [BRANCH_REPOSITORY, { kind: "http", status: 401 }, { kind: "failure", category: "Provider/resolution failure" }],
    [BRANCH_REPOSITORY, { kind: "invalid-evidence" }, { kind: "failure", category: "Provider/resolution failure" }],
    [BRANCH_REPOSITORY, { kind: "revision", revision: SHA40 }, { kind: "selected", repository: BRANCH_REPOSITORY, revision: SHA40 }],
  ];
  for (const [repository, gatewayResult, expected] of cases) {
    assert.deepEqual(await resolveRevision(repository, new AbortController().signal, async () => gatewayResult), expected);
  }
  assert.deepEqual(await resolveRevision(REPOSITORY, new AbortController().signal, async () => { throw new Error("private detail"); }), { kind: "failure", category: "Provider/resolution failure" });

  const current = new AbortController();
  current.abort();
  assert.deepEqual(await resolveRevision(REPOSITORY, current.signal, async () => { throw new Error("AbortError"); }), { kind: "cancelled" });
  const stale = new AbortController();
  stale.abort();
  assert.deepEqual(await resolveRevision(REPOSITORY, new AbortController().signal, async () => { throw new Error(stale.signal.reason); }), { kind: "failure", category: "Provider/resolution failure" });
});

test("HTTP and transport failures make no retry, fallback, timeout, or diagnostic publication", async () => {
  let calls = 0;
  const gateway = createGithubRevisionGateway(async () => {
    calls += 1;
    throw new Error("secret provider diagnostic");
  });
  const result = await resolveRevision(BRANCH_REPOSITORY, new AbortController().signal, gateway);
  assert.equal(calls, 1);
  assert.deepEqual(result, { kind: "failure", category: "Provider/resolution failure" });
  assert.doesNotMatch(JSON.stringify(result), /secret|github|url|transport/i);
});
