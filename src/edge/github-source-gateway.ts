import type {
  ImmutableSourceGateway,
  InventoryGatewayResult,
  SourceGatewayResult,
} from "../application/source-retrieval";
import { validObjectId } from "../application/source-retrieval";
import { prepareSourceInventory, type ProjectedTreeEntry, type SourceCandidate } from "../domain/source-admission";
import type { RepositoryReference } from "../domain/repository-reference";
import { encodeGithubPathSegment } from "./github-revision-gateway";

export const COMMIT_EVIDENCE_CAP = 4 * 1_048_576;
export const TREE_EVIDENCE_CAP = 8 * 1_048_576;
export const RAW_CONTENT_CAP = 4_194_307;

const API_HEADERS = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2026-03-10",
} as const;

type Digest = (algorithm: "SHA-1" | "SHA-256", data: ArrayBuffer) => Promise<ArrayBuffer>;

type BoundedBody =
  | Readonly<{ kind: "bytes"; bytes: Uint8Array }>
  | Readonly<{ kind: "overflow" }>
  | Readonly<{ kind: "invalid" }>;

type DataDescriptor = PropertyDescriptor & { value: unknown };

function ownDataDescriptor(value: unknown, key: string): DataDescriptor | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor as DataDescriptor : undefined;
  } catch {
    return undefined;
  }
}

function ownString(value: unknown, key: string): string | undefined {
  const descriptor = ownDataDescriptor(value, key);
  return typeof descriptor?.value === "string" ? descriptor.value : undefined;
}

function exactUrl(value: string): string {
  if (new URL(value).href !== value) {
    throw new Error("Request URL normalization changed the fixed route");
  }
  return value;
}

function commitUrl(repository: RepositoryReference, selected: string): string {
  return exactUrl(`https://api.github.com/repos/${encodeGithubPathSegment(repository.owner)}/${encodeGithubPathSegment(repository.repository)}/git/commits/${encodeGithubPathSegment(selected)}`);
}

function treeUrl(repository: RepositoryReference, root: string): string {
  return exactUrl(`https://api.github.com/repos/${encodeGithubPathSegment(repository.owner)}/${encodeGithubPathSegment(repository.repository)}/git/trees/${encodeGithubPathSegment(root)}?recursive=1`);
}

export function githubRawSourceUrl(
  repository: RepositoryReference,
  selected: string,
  rawPath: string,
): string {
  const path = rawPath.split("/").map(encodeGithubPathSegment).join("/");
  return exactUrl(`https://raw.githubusercontent.com/${encodeGithubPathSegment(repository.owner)}/${encodeGithubPathSegment(repository.repository)}/${encodeGithubPathSegment(selected)}/${path}`);
}

function apiOptions(signal: AbortSignal): RequestInit {
  return {
    method: "GET",
    headers: API_HEADERS,
    mode: "cors",
    credentials: "omit",
    referrer: "",
    referrerPolicy: "no-referrer",
    cache: "no-store",
    redirect: "error",
    signal,
  };
}

function rawOptions(signal: AbortSignal): RequestInit {
  return {
    method: "GET",
    mode: "cors",
    credentials: "omit",
    referrer: "",
    referrerPolicy: "no-referrer",
    cache: "no-store",
    redirect: "error",
    signal,
  };
}

async function cancelResponse(response: Response): Promise<void> {
  if (response.body) {
    await response.body.cancel();
  }
}

async function readBoundedBody(response: Response, cap: number): Promise<BoundedBody> {
  if (!response.body) {
    return { kind: "invalid" };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let completed = false;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        completed = true;
        break;
      }
      if (!(next.value instanceof Uint8Array)) {
        await reader.cancel();
        return { kind: "invalid" };
      }
      if (next.value.byteLength > cap - total) {
        await reader.cancel();
        return { kind: "overflow" };
      }
      total += next.value.byteLength;
      chunks.push(next.value);
    }
  } catch (error) {
    if (!completed) {
      try {
        await reader.cancel();
      } catch {
        // Preserve the request/read failure for the application mapping.
      }
    }
    throw error;
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { kind: "bytes", bytes };
}

function parseStrictJson(bytes: Uint8Array): unknown | undefined {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
}

export function projectCommitEvidence(value: unknown, selected: string): string | undefined {
  const sha = ownString(value, "sha");
  const tree = ownDataDescriptor(value, "tree")?.value;
  const root = ownString(tree, "sha");
  return sha === selected && validObjectId(root, selected.length) ? root : undefined;
}

function completeOwnArray(value: unknown): readonly unknown[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  try {
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor)) {
        return undefined;
      }
    }
    return value;
  } catch {
    return undefined;
  }
}

export function projectTreeEvidence(
  value: unknown,
  expectedRoot: string,
  selectedWidth: number,
): readonly ProjectedTreeEntry[] | undefined {
  if (ownString(value, "sha") !== expectedRoot || !validObjectId(expectedRoot, selectedWidth)) {
    return undefined;
  }
  const truncated = ownDataDescriptor(value, "truncated")?.value;
  const tree = completeOwnArray(ownDataDescriptor(value, "tree")?.value);
  if (truncated !== false || !tree) {
    return undefined;
  }

  const primitives: ProjectedTreeEntry[] = [];
  for (const providerEntry of tree) {
    const path = ownString(providerEntry, "path");
    const mode = ownString(providerEntry, "mode");
    const type = ownString(providerEntry, "type");
    if (path === undefined || mode === undefined || type === undefined) {
      return undefined;
    }
    primitives.push({ path, mode, type });
  }

  const admission = prepareSourceInventory(primitives);
  const candidatePaths = admission.kind === "candidates"
    ? new Set(admission.candidates.map((candidate) => candidate.rawPath))
    : new Set<string>();
  return primitives.map((entry, index) => {
    if (!candidatePaths.has(entry.path)) {
      return entry;
    }
    const sha = ownString(tree[index], "sha");
    return sha === undefined ? entry : { ...entry, sha };
  });
}

async function requestJson(
  fetchImpl: typeof fetch,
  requestUrl: string,
  cap: number,
  signal: AbortSignal,
): Promise<unknown | undefined> {
  const response = await fetchImpl(requestUrl, apiOptions(signal));
  if (response.status !== 200 || response.redirected || response.url !== requestUrl) {
    await cancelResponse(response);
    return undefined;
  }
  const body = await readBoundedBody(response, cap);
  return body.kind === "bytes" ? parseStrictJson(body.bytes) : undefined;
}

async function requestRawBody(
  fetchImpl: typeof fetch,
  requestUrl: string,
  signal: AbortSignal,
): Promise<BoundedBody> {
  const response = await fetchImpl(requestUrl, rawOptions(signal));
  if (response.status !== 200 || response.redirected || response.url !== requestUrl) {
    await cancelResponse(response);
    return { kind: "invalid" };
  }
  return readBoundedBody(response, RAW_CONTENT_CAP);
}

async function requestCommitRoot(
  fetchImpl: typeof fetch,
  repository: RepositoryReference,
  selected: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  const evidence = await requestJson(fetchImpl, commitUrl(repository, selected), COMMIT_EVIDENCE_CAP, signal);
  return projectCommitEvidence(evidence, selected);
}

async function requestTreeInventory(
  fetchImpl: typeof fetch,
  repository: RepositoryReference,
  root: string,
  selectedWidth: number,
  signal: AbortSignal,
): Promise<readonly ProjectedTreeEntry[] | undefined> {
  const evidence = await requestJson(fetchImpl, treeUrl(repository, root), TREE_EVIDENCE_CAP, signal);
  return projectTreeEvidence(evidence, root, selectedWidth);
}

function gitBlobPayload(bytes: Uint8Array): ArrayBuffer {
  const prefix = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
  const payload = new Uint8Array(prefix.byteLength + bytes.byteLength);
  payload.set(prefix);
  payload.set(bytes, prefix.byteLength);
  return payload.buffer;
}

function hexadecimal(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createGithubSourceGateway(
  fetchImpl: typeof fetch,
  digest: Digest = (algorithm, data) => crypto.subtle.digest(algorithm, data),
): ImmutableSourceGateway {
  return {
    async loadInventory(repository, selected, signal): Promise<InventoryGatewayResult> {
      const root = await requestCommitRoot(fetchImpl, repository, selected, signal);
      if (!root) {
        return { kind: "provider-failure" };
      }
      const entries = await requestTreeInventory(fetchImpl, repository, root, selected.length, signal);
      return entries ? { kind: "inventory", entries } : { kind: "provider-failure" };
    },

    async readSource(repository, selected, candidate, signal): Promise<SourceGatewayResult> {
      const requestUrl = githubRawSourceUrl(repository, selected, candidate.rawPath);
      const body = await requestRawBody(fetchImpl, requestUrl, signal);
      if (body.kind === "overflow") {
        return { kind: "product-limit" };
      }
      if (body.kind !== "bytes") {
        return { kind: "provider-failure" };
      }

      const algorithm = selected.length === 40 ? "SHA-1" : "SHA-256";
      let actualBlobId: string;
      try {
        actualBlobId = hexadecimal(await digest(algorithm, gitBlobPayload(body.bytes)));
      } catch {
        return { kind: "provider-failure" };
      }
      if (actualBlobId !== candidate.expectedBlobId) {
        return { kind: "provider-failure" };
      }
      try {
        return {
          kind: "source",
          decodedSource: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body.bytes),
        };
      } catch {
        return { kind: "invalid-content" };
      }
    },
  };
}
