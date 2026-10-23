import type { GatewayResult, RevisionGateway } from "../application/resolution";
import type { RepositoryReference } from "../domain/repository-reference";

const PROVIDER_REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const MAX_EVIDENCE_BYTES = 1_048_576;

export function encodeGithubPathSegment(value: string): string {
  if (!value.isWellFormed()) {
    throw new Error("GitHub route segment is not a Unicode scalar string");
  }
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => (
    `%${character.codePointAt(0)?.toString(16).toUpperCase()}`
  ));
}

export function githubRevisionUrl(repository: RepositoryReference): string {
  const owner = encodeGithubPathSegment(repository.owner);
  const name = encodeGithubPathSegment(repository.repository);
  const requestUrl = repository.branch === null
    ? `https://api.github.com/repos/${owner}/${name}/commits?per_page=1&page=1`
    : `https://api.github.com/repos/${owner}/${name}/branches/${encodeGithubPathSegment(repository.branch)}`;
  if (new URL(requestUrl).href !== requestUrl) {
    throw new Error("Request URL normalization changed the fixed route");
  }
  return requestUrl;
}

async function releaseResponse(response: Response): Promise<void> {
  if (response.body) {
    await response.body.cancel();
  }
}

async function readBoundedBody(response: Response): Promise<Uint8Array | undefined> {
  if (!response.body) {
    return undefined;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      total += next.value.byteLength;
      if (total > MAX_EVIDENCE_BYTES) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(next.value);
    }
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // Preserve the request/read failure for application mapping.
    }
    throw error;
  } finally {
    reader.releaseLock();
  }

  const content = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    content.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return content;
}

function ownDataValue(value: unknown, key: string): unknown | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function projectDefaultRevision(value: unknown): GatewayResult {
  if (!Array.isArray(value)) {
    return { kind: "invalid-evidence" };
  }
  if (value.length === 0) {
    return { kind: "empty" };
  }
  const revision = ownDataValue(value[0], "sha");
  return typeof revision === "string" && PROVIDER_REVISION.test(revision)
    ? { kind: "revision", revision }
    : { kind: "invalid-evidence" };
}

function projectBranchRevision(value: unknown, expectedBranch: string): GatewayResult {
  const name = ownDataValue(value, "name");
  const commit = ownDataValue(value, "commit");
  const revision = ownDataValue(commit, "sha");
  return name === expectedBranch && typeof revision === "string" && PROVIDER_REVISION.test(revision)
    ? { kind: "revision", revision }
    : { kind: "invalid-evidence" };
}

export function createGithubRevisionGateway(fetchImpl: typeof fetch): RevisionGateway {
  return async (repository, signal) => {
    const requestUrl = githubRevisionUrl(repository);
    const response = await fetchImpl(requestUrl, {
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2026-03-10",
      },
      mode: "cors",
      credentials: "omit",
      referrer: "",
      referrerPolicy: "no-referrer",
      cache: "no-store",
      redirect: "error",
      signal,
    });

    if (response.redirected || response.url !== requestUrl) {
      await releaseResponse(response);
      return { kind: "invalid-evidence" };
    }
    if (!response.ok) {
      await releaseResponse(response);
      return { kind: "http", status: response.status };
    }

    const bytes = await readBoundedBody(response);
    if (!bytes) {
      return { kind: "invalid-evidence" };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      return { kind: "invalid-evidence" };
    }
    return repository.branch === null
      ? projectDefaultRevision(parsed)
      : projectBranchRevision(parsed, repository.branch);
  };
}
