import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(/^\.\.?\//.test(specifier) && !/\.[a-z]+$/i.test(specifier) ? `${specifier}.ts` : specifier, context);
  },
});

const {
  COMMIT_EVIDENCE_CAP,
  TREE_EVIDENCE_CAP,
  RAW_CONTENT_CAP,
  createGithubSourceGateway,
  githubRawSourceUrl,
  projectCommitEvidence,
  projectTreeEvidence,
} = await import("../src/edge/github-source-gateway.ts");

const REPOSITORY = { owner: "owner", repository: "repo" };
const SHA40 = "a".repeat(40);
const SHA64 = "b".repeat(64);
const ROOT40 = "c".repeat(40);
const ROOT64 = "d".repeat(64);
const encoder = new TextEncoder();

function streamResponse(url, body, changes = {}) {
  const bytes = typeof body === "string" ? encoder.encode(body) : body;
  return {
    body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
    redirected: false,
    status: 200,
    url,
    ...changes,
  };
}

async function blobId(bytes, width = 40) {
  const prefix = encoder.encode(`blob ${bytes.byteLength}\0`);
  const payload = new Uint8Array(prefix.length + bytes.length);
  payload.set(prefix);
  payload.set(bytes, prefix.length);
  const digest = await webcrypto.subtle.digest(width === 40 ? "SHA-1" : "SHA-256", payload);
  return Buffer.from(digest).toString("hex");
}

function commitApiUrl(selected = SHA40) {
  return `https://api.github.com/repos/owner/repo/git/commits/${selected}`;
}

function treeApiUrl(root = ROOT40) {
  return `https://api.github.com/repos/owner/repo/git/trees/${root}?recursive=1`;
}

test("commit and tree requests are exact, sequential, identity-consistent, and primitive-projected", async () => {
  const calls = [];
  let active = 0;
  let maximumActive = 0;
  const gateway = createGithubSourceGateway(async (url, options) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    calls.push([url, options]);
    const response = url.includes("/git/commits/")
      ? streamResponse(url, JSON.stringify({ sha: SHA40, tree: { sha: ROOT40, url: "untrusted" }, url: "untrusted" }))
      : streamResponse(url, JSON.stringify({
          sha: ROOT40,
          truncated: false,
          tree: [
            { path: "z.ts", mode: "100644", type: "blob", sha: "e".repeat(40), size: 9, url: "untrusted" },
            { path: "README.md", mode: "100644", type: "blob", sha: { ignored: true }, size: Number.MAX_VALUE },
          ],
        }));
    active -= 1;
    return response;
  });
  const signal = new AbortController().signal;
  assert.deepEqual(await gateway.loadInventory(REPOSITORY, SHA40, signal), {
    kind: "inventory",
    entries: [
      { path: "z.ts", mode: "100644", type: "blob", sha: "e".repeat(40) },
      { path: "README.md", mode: "100644", type: "blob" },
    ],
  });
  assert.equal(maximumActive, 1);
  assert.deepEqual(calls.map(([url]) => url), [commitApiUrl(), treeApiUrl()]);
  for (const [, options] of calls) {
    assert.deepEqual(options, {
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
  }
});

test("own-data projectors reject accessors and mixed identities without consulting excluded metadata", () => {
  let reads = 0;
  const accessor = (value, key) => {
    Object.defineProperty(value, key, { enumerable: true, get() { reads += 1; throw new Error("accessed"); } });
    return value;
  };
  assert.equal(projectCommitEvidence(accessor({ sha: SHA40, tree: { sha: ROOT40 } }, "sha"), SHA40), undefined);
  assert.equal(projectCommitEvidence({ sha: SHA40, tree: accessor({}, "sha") }, SHA40), undefined);
  assert.equal(projectCommitEvidence({ sha: SHA40, tree: { sha: ROOT64 } }, SHA40), undefined);

  const excluded = [
    accessor({ path: "README.md", mode: "100644", type: "blob", size: 1 }, "sha"),
    accessor({ path: "folder.ts", mode: "040000", type: "tree", size: 1 }, "sha"),
    accessor({ path: "link.ts", mode: "120000", type: "blob", size: 1 }, "sha"),
    accessor({ path: "link.ts/descendant.ts", mode: "100644", type: "blob", size: 1 }, "sha"),
    accessor({ path: "module.ts", mode: "160000", type: "commit", size: 1 }, "sha"),
  ];
  for (const entry of excluded) accessor(entry, "size");
  assert.deepEqual(projectTreeEvidence({ sha: ROOT40, truncated: false, tree: excluded }, ROOT40, 40), excluded.map(({ path, mode, type }) => ({ path, mode, type })));
  assert.equal(reads, 0);

  const candidate = accessor({ path: "a.ts", mode: "100644", type: "blob" }, "sha");
  assert.deepEqual(projectTreeEvidence({ sha: ROOT40, truncated: false, tree: [candidate] }, ROOT40, 40), [
    { path: "a.ts", mode: "100644", type: "blob" },
  ]);
  assert.equal(reads, 0);

  const inheritedPath = Object.assign(Object.create({ path: "a.ts" }), { mode: "100644", type: "blob", sha: SHA40 });
  assert.equal(projectTreeEvidence({ sha: ROOT40, truncated: false, tree: [inheritedPath] }, ROOT40, 40), undefined);
  assert.equal(projectTreeEvidence({ sha: ROOT40, truncated: true, tree: [] }, ROOT40, 40), undefined);
  assert.equal(projectTreeEvidence({ sha: ROOT40, truncated: false, tree: new Array(1) }, ROOT40, 40), undefined);
});

test("40- and 64-character commit/root/tree consistency is exact", () => {
  assert.equal(projectCommitEvidence({ sha: SHA40, tree: { sha: ROOT40 } }, SHA40), ROOT40);
  assert.equal(projectCommitEvidence({ sha: SHA64, tree: { sha: ROOT64 } }, SHA64), ROOT64);
  for (const [selected, root] of [[SHA40, ROOT64], [SHA64, ROOT40], [SHA40, ROOT40.toUpperCase()]]) {
    assert.equal(projectCommitEvidence({ sha: selected, tree: { sha: root } }, selected), undefined);
  }
  assert.deepEqual(projectTreeEvidence({ sha: ROOT64, truncated: false, tree: [] }, ROOT64, 64), []);
  assert.equal(projectTreeEvidence({ sha: ROOT64, truncated: false, tree: [] }, ROOT64, 40), undefined);
});

test("REST evidence caps accept exact 4/8 MiB and reject the next byte independent of Content-Length", async () => {
  assert.equal(COMMIT_EVIDENCE_CAP, 4 * 1_048_576);
  assert.equal(TREE_EVIDENCE_CAP, 8 * 1_048_576);
  const exactCommit = JSON.stringify({ sha: SHA40, tree: { sha: ROOT40 } });
  const exactTree = JSON.stringify({ sha: ROOT40, truncated: false, tree: [] });
  const responses = [
    streamResponse(commitApiUrl(), exactCommit + " ".repeat(COMMIT_EVIDENCE_CAP - exactCommit.length), { headers: { "Content-Length": "1" } }),
    streamResponse(treeApiUrl(), exactTree + " ".repeat(TREE_EVIDENCE_CAP - exactTree.length), { headers: { "Content-Length": "999999999" } }),
  ];
  const exact = createGithubSourceGateway(async () => responses.shift());
  assert.deepEqual(await exact.loadInventory(REPOSITORY, SHA40, new AbortController().signal), { kind: "inventory", entries: [] });

  for (const [cap, firstUrl] of [[COMMIT_EVIDENCE_CAP, commitApiUrl()], [TREE_EVIDENCE_CAP, treeApiUrl()]]) {
    let cancelled = 0;
    let released = 0;
    const reader = {
      reads: 0,
      async read() {
        this.reads += 1;
        return this.reads === 1 ? { done: false, value: new Uint8Array(cap + 1) } : { done: true };
      },
      async cancel() { cancelled += 1; },
      releaseLock() { released += 1; },
    };
    const fetchImpl = async (url) => {
      if (url === commitApiUrl() && firstUrl === treeApiUrl()) {
        return streamResponse(url, JSON.stringify({ sha: SHA40, tree: { sha: ROOT40 } }));
      }
      return { body: { getReader: () => reader }, redirected: false, status: 200, url };
    };
    const result = await createGithubSourceGateway(fetchImpl).loadInventory(REPOSITORY, SHA40, new AbortController().signal);
    assert.deepEqual(result, { kind: "provider-failure" });
    assert.equal(cancelled, 1);
    assert.equal(released, 1);
  }
});

test("raw URL and request options use only local immutable values and independently encoded segments", async () => {
  const repository = { owner: "a:b @c", repository: "repo!'()*~" };
  const path = "space here/uni／code.TS";
  const bytes = encoder.encode("export {};");
  const expected = await blobId(bytes);
  const url = githubRawSourceUrl(repository, SHA40, path);
  assert.equal(url, `https://raw.githubusercontent.com/a%3Ab%20%40c/repo%21%27%28%29%2A~/${SHA40}/space%20here/uni%EF%BC%8Fcode.TS`);
  const calls = [];
  const gateway = createGithubSourceGateway(async (...args) => {
    calls.push(args);
    return streamResponse(args[0], bytes);
  }, (algorithm, payload) => webcrypto.subtle.digest(algorithm, payload));
  const signal = new AbortController().signal;
  assert.deepEqual(await gateway.readSource(repository, SHA40, { canonicalPath: path, rawPath: path, expectedBlobId: expected }, signal), {
    kind: "source", decodedSource: "export {};",
  });
  assert.deepEqual(calls[0], [url, {
    method: "GET",
    mode: "cors",
    credentials: "omit",
    referrer: "",
    referrerPolicy: "no-referrer",
    cache: "no-store",
    redirect: "error",
    signal,
  }]);
  assert.equal(Object.hasOwn(calls[0][1], "headers"), false);
});

test("blob integrity uses exact Git framing for SHA-1/SHA-256 and treats LFS pointer text as source", async () => {
  const lfs = encoder.encode("version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 1\n");
  for (const [selected, width] of [[SHA40, 40], [SHA64, 64]]) {
    const expected = await blobId(lfs, width);
    let observedAlgorithm;
    let observedPayload;
    const gateway = createGithubSourceGateway(async (url) => streamResponse(url, lfs), async (algorithm, payload) => {
      observedAlgorithm = algorithm;
      observedPayload = new Uint8Array(payload);
      return webcrypto.subtle.digest(algorithm, payload);
    });
    const result = await gateway.readSource(REPOSITORY, selected, { canonicalPath: "a.ts", rawPath: "a.ts", expectedBlobId: expected }, new AbortController().signal);
    assert.deepEqual(result, { kind: "source", decodedSource: new TextDecoder().decode(lfs) });
    assert.equal(observedAlgorithm, width === 40 ? "SHA-1" : "SHA-256");
    const prefix = encoder.encode(`blob ${lfs.length}\0`);
    assert.deepEqual(observedPayload.slice(0, prefix.length), prefix);
    assert.deepEqual(observedPayload.slice(prefix.length), lfs);
  }
});

test("raw status/final URL, digest mismatch/unavailability, and strict UTF-8 fail deterministically", async () => {
  const bytes = encoder.encode("ok");
  const expected = await blobId(bytes);
  for (const changes of [{ status: 201 }, { redirected: true }, { url: "https://raw.githubusercontent.com/other" }]) {
    let cancelled = 0;
    const gateway = createGithubSourceGateway(async (url) => ({
      body: new ReadableStream({ cancel() { cancelled += 1; } }),
      redirected: false,
      status: 200,
      url,
      ...changes,
    }));
    assert.deepEqual(await gateway.readSource(REPOSITORY, SHA40, { canonicalPath: "a.ts", rawPath: "a.ts", expectedBlobId: expected }, new AbortController().signal), { kind: "provider-failure" });
    assert.equal(cancelled, 1);
  }

  const mismatch = createGithubSourceGateway(async (url) => streamResponse(url, bytes), (algorithm, payload) => webcrypto.subtle.digest(algorithm, payload));
  assert.deepEqual(await mismatch.readSource(REPOSITORY, SHA40, { canonicalPath: "a.ts", rawPath: "a.ts", expectedBlobId: "f".repeat(40) }, new AbortController().signal), { kind: "provider-failure" });
  const unavailable = createGithubSourceGateway(async (url) => streamResponse(url, bytes), async () => { throw new Error("unavailable"); });
  assert.deepEqual(await unavailable.readSource(REPOSITORY, SHA40, { canonicalPath: "a.ts", rawPath: "a.ts", expectedBlobId: expected }, new AbortController().signal), { kind: "provider-failure" });

  const invalid = Uint8Array.from([0xff]);
  const invalidId = await blobId(invalid);
  const invalidUtf8 = createGithubSourceGateway(async (url) => streamResponse(url, invalid), (algorithm, payload) => webcrypto.subtle.digest(algorithm, payload));
  assert.deepEqual(await invalidUtf8.readSource(REPOSITORY, SHA40, { canonicalPath: "a.ts", rawPath: "a.ts", expectedBlobId: invalidId }, new AbortController().signal), { kind: "invalid-content" });
});

test("aborting an active raw read cancels its acquired reader and releases its lock exactly once", async () => {
  const controller = new AbortController();
  let cancelled = 0;
  let released = 0;
  let readStarted;
  const started = new Promise((resolve) => { readStarted = resolve; });
  const reader = {
    async read() {
      readStarted();
      await new Promise((_, reject) => controller.signal.addEventListener("abort", () => reject(new Error("aborted read")), { once: true }));
    },
    async cancel() { cancelled += 1; },
    releaseLock() { released += 1; },
  };
  const gateway = createGithubSourceGateway(async (url) => ({ body: { getReader: () => reader }, redirected: false, status: 200, url }));
  const pending = gateway.readSource(REPOSITORY, SHA40, { canonicalPath: "a.ts", rawPath: "a.ts", expectedBlobId: "f".repeat(40) }, controller.signal);
  await started;
  controller.abort();
  await assert.rejects(pending, /aborted read/);
  assert.equal(cancelled, 1);
  assert.equal(released, 1);
});

test("raw stream cap accepts exactly 4,194,307 bytes and the next byte cancels before hashing", async () => {
  assert.equal(RAW_CONTENT_CAP, 4_194_307);
  const exactBytes = new Uint8Array(RAW_CONTENT_CAP);
  const expected = await blobId(exactBytes);
  let digestCalls = 0;
  const exact = createGithubSourceGateway(async (url) => streamResponse(url, exactBytes), async (algorithm, payload) => {
    digestCalls += 1;
    return webcrypto.subtle.digest(algorithm, payload);
  });
  assert.equal((await exact.readSource(REPOSITORY, SHA40, { canonicalPath: "a.ts", rawPath: "a.ts", expectedBlobId: expected }, new AbortController().signal)).kind, "source");
  assert.equal(digestCalls, 1);

  let cancelled = 0;
  let released = 0;
  const reader = {
    async read() { return { done: false, value: new Uint8Array(RAW_CONTENT_CAP + 1) }; },
    async cancel() { cancelled += 1; },
    releaseLock() { released += 1; },
  };
  const over = createGithubSourceGateway(async (url) => ({ body: { getReader: () => reader }, redirected: false, status: 200, url }), async () => {
    digestCalls += 1;
    throw new Error("must not hash overflow");
  });
  assert.deepEqual(await over.readSource(REPOSITORY, SHA40, { canonicalPath: "a.ts", rawPath: "a.ts", expectedBlobId: expected }, new AbortController().signal), { kind: "product-limit" });
  assert.equal(cancelled, 1);
  assert.equal(released, 1);
  assert.equal(digestCalls, 1);
});
