import type { GatewayResult, RevisionGateway } from "../application/resolution";
import type { RepositoryReference } from "../domain/repository-reference";

const PROVIDER_REVISION = /^[0-9a-f]{40,64}$/;
const MAX_EVIDENCE_BYTES = 1_048_576;
const API_ORIGIN = "https://api.github.com";

function encodePathSegment(value: string): string {
  return encodeURIComponent(value.toWellFormed()).replace(/[!'()*]/g, (character) => (
    `%${character.codePointAt(0)?.toString(16).toUpperCase()}`
  ));
}

export function githubRevisionUrl(repository: RepositoryReference): string {
  const owner = encodePathSegment(repository.owner);
  const name = encodePathSegment(repository.repository);
  const requestUrl = `${API_ORIGIN}/repos/${owner}/${name}/commits?per_page=1&page=1`;
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

function projectRevision(value: unknown): GatewayResult {
  if (!Array.isArray(value)) {
    return { kind: "invalid-evidence" };
  }
  if (value.length === 0) {
    return { kind: "empty" };
  }
  const first = value[0];
  if (typeof first !== "object" || first === null) {
    return { kind: "invalid-evidence" };
  }
  const descriptor = Object.getOwnPropertyDescriptor(first, "sha");
  if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string" || !PROVIDER_REVISION.test(descriptor.value)) {
    return { kind: "invalid-evidence" };
  }
  return { kind: "revision", revision: descriptor.value };
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
    return projectRevision(parsed);
  };
}
