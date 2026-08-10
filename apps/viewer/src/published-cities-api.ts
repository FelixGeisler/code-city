const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const REQUEST_DEADLINE_MS = 30_000;
const MAXIMUM_RESPONSE_BYTES = 2 * 1024 * 1024;

export interface PublishedCityVersionView {
  readonly id: string;
  readonly publishedAt: string;
  readonly generatedAt: string;
  readonly model: { readonly size: number; readonly sha256: string };
  readonly evolution?: {
    readonly size: number;
    readonly sha256: string;
    readonly frameCount: number;
    readonly deltaCount: number;
  };
  readonly modelVersion?: string;
  readonly districtCount: number;
  readonly buildingCount: number;
  readonly modelUrl: string;
  readonly evolutionUrl?: string;
  readonly viewerUrl: string;
}

export interface PublishedCityView {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly latestVersionId: string;
  readonly latestUrl: string;
  readonly versions: readonly PublishedCityVersionView[];
}

export interface PublishedCityCurrentModel {
  readonly jobId?: string;
  readonly title: string;
}

function validIsoDate(value: unknown): value is string {
  return typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value;
}

function safeText(value: unknown, maximum: number): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)
    ? value
    : undefined;
}

async function withRequestDeadline<T>(
  signal: AbortSignal | undefined,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = globalThis.setTimeout(
    () => controller.abort(new Error("Published city request timed out.")),
    REQUEST_DEADLINE_MS,
  );
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  try {
    return await operation(controller.signal);
  } finally {
    globalThis.clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

async function readBoundedResponseText(response: Response): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > MAXIMUM_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("Published city response is too large.");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function exactKeys(
  candidate: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(candidate).sort();
  const normalizedExpected = [...expected].sort();
  return actual.length === normalizedExpected.length &&
    actual.every((key, index) => key === normalizedExpected[index]);
}

function artifact(
  value: unknown,
  additionalKeys: readonly string[] = [],
): { size: number; sha256: string } | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  if (!exactKeys(candidate, ["sha256", "size", ...additionalKeys])) {
    return undefined;
  }
  return Number.isSafeInteger(candidate["size"]) &&
    (candidate["size"] as number) > 0 &&
    typeof candidate["sha256"] === "string" &&
    DIGEST_PATTERN.test(candidate["sha256"])
    ? { size: candidate["size"] as number, sha256: candidate["sha256"] }
    : undefined;
}

function parsePublication(value: unknown): PublishedCityView {
  if (typeof value !== "object" || value === null) throw new Error("Published city response is invalid.");
  const candidate = value as Record<string, unknown>;
  if (
    !exactKeys(candidate, [
      "createdAt",
      "id",
      "latestUrl",
      "latestVersionId",
      "title",
      "updatedAt",
      "versions",
      ...(candidate["description"] === undefined ? [] : ["description"]),
    ])
  ) throw new Error("Published city response is invalid.");
  const id = candidate["id"];
  const title = safeText(candidate["title"], 120);
  const description = candidate["description"] === undefined
    ? undefined
    : safeText(candidate["description"], 1_000);
  const latestVersionId = candidate["latestVersionId"];
  const rawVersions = candidate["versions"];
  if (
    typeof id !== "string" || !ID_PATTERN.test(id) || title === undefined ||
    (candidate["description"] !== undefined && description === undefined) ||
    !validIsoDate(candidate["createdAt"]) ||
    !validIsoDate(candidate["updatedAt"]) ||
    typeof latestVersionId !== "string" || !ID_PATTERN.test(latestVersionId) ||
    candidate["latestUrl"] !== `/?published=${id}` || !Array.isArray(rawVersions) ||
    rawVersions.length < 1 || rawVersions.length > 20
  ) throw new Error("Published city response is invalid.");
  const versions = rawVersions.map((raw): PublishedCityVersionView => {
    if (typeof raw !== "object" || raw === null) throw new Error("Published city version is invalid.");
    const version = raw as Record<string, unknown>;
    if (
      !exactKeys(version, [
        "buildingCount",
        "districtCount",
        "generatedAt",
        "id",
        "model",
        "modelUrl",
        "publishedAt",
        "viewerUrl",
        ...(version["evolution"] === undefined
          ? []
          : ["evolution", "evolutionUrl"]),
        ...(version["modelVersion"] === undefined ? [] : ["modelVersion"]),
      ])
    ) throw new Error("Published city version is invalid.");
    const versionId = version["id"];
    const model = artifact(version["model"]);
    if (
      typeof versionId !== "string" || !ID_PATTERN.test(versionId) || model === undefined ||
      !validIsoDate(version["publishedAt"]) ||
      !validIsoDate(version["generatedAt"]) ||
      !Number.isSafeInteger(version["districtCount"]) ||
      !Number.isSafeInteger(version["buildingCount"]) ||
      version["modelUrl"] !== `/api/v1/published/${id}/versions/${versionId}/city-model.json` ||
      version["viewerUrl"] !== `/?published=${id}&version=${versionId}`
    ) throw new Error("Published city version is invalid.");
    let evolution: PublishedCityVersionView["evolution"];
    if (version["evolution"] !== undefined) {
      const base = artifact(version["evolution"], [
        "deltaCount",
        "frameCount",
      ]);
      const detail = version["evolution"] as Record<string, unknown>;
      if (
        base === undefined || !Number.isSafeInteger(detail["frameCount"]) ||
        !Number.isSafeInteger(detail["deltaCount"]) ||
        detail["deltaCount"] !== (detail["frameCount"] as number) - 1 ||
        version["evolutionUrl"] !== `/api/v1/published/${id}/versions/${versionId}/evolution.json`
      ) throw new Error("Published evolution metadata is invalid.");
      evolution = {
        ...base,
        frameCount: detail["frameCount"] as number,
        deltaCount: detail["deltaCount"] as number,
      };
    }
    return Object.freeze({
      id: versionId,
      publishedAt: version["publishedAt"] as string,
      generatedAt: version["generatedAt"] as string,
      model,
      ...(evolution === undefined ? {} : { evolution }),
      ...(typeof version["modelVersion"] === "string"
        ? { modelVersion: version["modelVersion"] as string }
        : {}),
      districtCount: version["districtCount"] as number,
      buildingCount: version["buildingCount"] as number,
      modelUrl: version["modelUrl"] as string,
      ...(evolution === undefined ? {} : { evolutionUrl: version["evolutionUrl"] as string }),
      viewerUrl: version["viewerUrl"] as string,
    });
  });
  if (!versions.some(({ id: versionId }) => versionId === latestVersionId)) {
    throw new Error("Published city latest version is invalid.");
  }
  return Object.freeze({
    id,
    title,
    ...(description === undefined ? {} : { description }),
    createdAt: candidate["createdAt"] as string,
    updatedAt: candidate["updatedAt"] as string,
    latestVersionId,
    latestUrl: candidate["latestUrl"] as string,
    versions: Object.freeze(versions),
  });
}

export class PublishedCitiesApi {
  public constructor(
    private readonly fetchImplementation: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {}

  public async list(signal?: AbortSignal): Promise<readonly PublishedCityView[]> {
    const value = await this.#json("/api/v1/published", { method: "GET" }, signal);
    if (
      typeof value !== "object" ||
      value === null ||
      !exactKeys(value as Record<string, unknown>, ["publications"]) ||
      !Array.isArray((value as Record<string, unknown>)["publications"])
    ) {
      throw new Error("Published cities response is invalid.");
    }
    return Object.freeze(
      ((value as Record<string, unknown>)["publications"] as unknown[]).map(parsePublication),
    );
  }

  public async get(publicationId: string, signal?: AbortSignal): Promise<PublishedCityView> {
    if (!ID_PATTERN.test(publicationId)) throw new Error("Published city ID is invalid.");
    const value = await this.#json(
      `/api/v1/published/${publicationId}`,
      { method: "GET" },
      signal,
    );
    if (
      typeof value !== "object" ||
      value === null ||
      !exactKeys(value as Record<string, unknown>, ["publication"])
    ) throw new Error("Published city response is invalid.");
    return parsePublication((value as Record<string, unknown>)["publication"]);
  }

  public async publish(
    input: { readonly jobId: string; readonly title: string; readonly description?: string; readonly publicationId?: string },
    signal?: AbortSignal,
  ): Promise<PublishedCityView> {
    const value = await this.#json(
      "/api/v1/published",
      {
        method: "POST",
        headers: { "content-type": "application/json", "X-Code-City-Request": "1" },
        body: JSON.stringify(input),
      },
      signal,
    );
    if (
      typeof value !== "object" ||
      value === null ||
      !exactKeys(value as Record<string, unknown>, ["publication"])
    ) throw new Error("Published city response is invalid.");
    return parsePublication((value as Record<string, unknown>)["publication"]);
  }

  public async evolution(
    artifactUrl: string,
    expectedSize: number,
    signal?: AbortSignal,
  ): Promise<ArrayBuffer> {
    if (
      !/^\/api\/v1\/published\/[0-9a-f-]{36}\/versions\/[0-9a-f-]{36}\/evolution\.json$/u.test(artifactUrl) ||
      !Number.isSafeInteger(expectedSize) ||
      expectedSize < 1 ||
      expectedSize > 256 * 1024 * 1024
    ) {
      throw new Error("Published evolution metadata is invalid.");
    }
    return await withRequestDeadline(signal, async (requestSignal) => {
      const response = await this.fetchImplementation(artifactUrl, {
        method: "GET",
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: requestSignal,
      });
      if (
        !response.ok ||
        !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(
          response.headers.get("content-type") ?? "",
        ) ||
        Number(response.headers.get("content-length")) !== expectedSize
      ) {
        throw new Error("Published evolution could not be loaded.");
      }
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength !== expectedSize) {
        throw new Error("Published evolution size changed.");
      }
      return bytes;
    });
  }

  public async remove(publicationId: string, signal?: AbortSignal): Promise<void> {
    if (!ID_PATTERN.test(publicationId)) throw new Error("Published city ID is invalid.");
    await withRequestDeadline(signal, async (requestSignal) => {
      const response = await this.fetchImplementation(
        `/api/v1/published/${publicationId}`,
        {
          method: "DELETE",
          headers: { "X-Code-City-Request": "1" },
          credentials: "same-origin",
          signal: requestSignal,
        },
      );
      if (response.status !== 204) {
        throw new Error("Published city could not be removed.");
      }
    });
  }

  async #json(input: string, init: RequestInit, signal?: AbortSignal): Promise<unknown> {
    return await withRequestDeadline(signal, async (requestSignal) => {
      const response = await this.fetchImplementation(input, {
        ...init,
        credentials: init.method === "GET" ? "omit" : "same-origin",
        cache: "no-store",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: requestSignal,
      });
      if (!response.ok) throw new Error("Published city request failed.");
      const contentType = response.headers.get("content-type");
      if (
        contentType === null ||
        !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(contentType)
      ) {
        throw new Error("Published city response is not UTF-8 JSON.");
      }
      const contentLength = Number(response.headers.get("content-length"));
      if (
        Number.isFinite(contentLength) &&
        contentLength > MAXIMUM_RESPONSE_BYTES
      ) {
        throw new Error("Published city response is too large.");
      }
      return JSON.parse(await readBoundedResponseText(response)) as unknown;
    });
  }
}
