import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { validateCityModel } from "../../../packages/core/src/model-validation.js";
import type { ImportArtifactStore } from "./import-artifacts.js";
import type { JobRecord } from "./job-queue.js";

const INDEX_VERSION = 1;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const MAX_PUBLICATIONS = 100;
const MAX_VERSIONS_PER_PUBLICATION = 20;
const MAX_TITLE_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 1_000;
const MAX_PUBLISHED_VERSION_BYTES = 128 * 1024 * 1024;
const MAX_PUBLISHED_BYTES = 2 * 1024 * 1024 * 1024;

export interface PublishedArtifactMetadata {
  readonly size: number;
  readonly sha256: string;
}

export interface PublishedCityVersion {
  readonly id: string;
  readonly publishedAt: string;
  readonly generatedAt: string;
  readonly model: PublishedArtifactMetadata;
  readonly evolution?: PublishedArtifactMetadata & {
    readonly frameCount: number;
    readonly deltaCount: number;
  };
  readonly modelVersion?: string;
  readonly districtCount: number;
  readonly buildingCount: number;
}

export interface PublishedCity {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly latestVersionId: string;
  readonly versions: readonly PublishedCityVersion[];
}

interface PublishedIndex {
  readonly version: 1;
  readonly publications: readonly PublishedCity[];
}

export interface PublishCityInput {
  readonly publicationId?: string;
  readonly title?: string;
  readonly description?: string;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function safeText(
  value: unknown,
  label: string,
  maximumLength: number,
  required: boolean,
): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string") throw new Error(`${label} is invalid.`);
  const normalized = value.normalize("NFC").trim();
  if (
    (required && normalized.length === 0) ||
    normalized.length > maximumLength ||
    /[\p{Cc}\p{Cf}\p{Cs}]/u.test(normalized)
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return normalized === "" ? undefined : normalized;
}

function validDate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function artifactMetadata(
  value: unknown,
  additionalKeys: readonly string[] = [],
): PublishedArtifactMetadata | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate).sort(compareText);
  const expectedKeys = ["sha256", "size", ...additionalKeys].sort(compareText);
  return keys.length === expectedKeys.length &&
    keys.every((key, index) => key === expectedKeys[index]) &&
    Number.isSafeInteger(candidate["size"]) &&
    (candidate["size"] as number) > 0 &&
    typeof candidate["sha256"] === "string" &&
    DIGEST_PATTERN.test(candidate["sha256"])
    ? Object.freeze({
        size: candidate["size"] as number,
        sha256: candidate["sha256"],
      })
    : undefined;
}

function parseVersion(value: unknown): PublishedCityVersion {
  if (typeof value !== "object" || value === null) {
    throw new Error("Published city version is invalid.");
  }
  const candidate = value as Record<string, unknown>;
  const expectedKeys = [
    "buildingCount",
    "districtCount",
    "generatedAt",
    "id",
    "model",
    "publishedAt",
    ...(candidate["evolution"] === undefined ? [] : ["evolution"]),
    ...(candidate["modelVersion"] === undefined ? [] : ["modelVersion"]),
  ].sort(compareText);
  const actualKeys = Object.keys(candidate).sort(compareText);
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new Error("Published city version is invalid.");
  }
  const id = candidate["id"];
  const publishedAt = candidate["publishedAt"];
  const generatedAt = candidate["generatedAt"];
  const model = artifactMetadata(candidate["model"]);
  const evolutionValue = candidate["evolution"];
  let evolution: PublishedCityVersion["evolution"];
  if (evolutionValue !== undefined) {
    if (typeof evolutionValue !== "object" || evolutionValue === null) {
      throw new Error("Published evolution metadata is invalid.");
    }
    const base = artifactMetadata(evolutionValue, ["deltaCount", "frameCount"]);
    const evolutionCandidate = evolutionValue as Record<string, unknown>;
    const frameCount = evolutionCandidate["frameCount"];
    const deltaCount = evolutionCandidate["deltaCount"];
    if (
      base === undefined ||
      !Number.isSafeInteger(frameCount) ||
      (frameCount as number) < 1 ||
      !Number.isSafeInteger(deltaCount) ||
      (deltaCount as number) !== (frameCount as number) - 1
    ) {
      throw new Error("Published evolution metadata is invalid.");
    }
    evolution = Object.freeze({
      ...base,
      frameCount: frameCount as number,
      deltaCount: deltaCount as number,
    });
  }
  const districtCount = candidate["districtCount"];
  const buildingCount = candidate["buildingCount"];
  const modelVersion = candidate["modelVersion"];
  if (
    typeof id !== "string" ||
    !ID_PATTERN.test(id) ||
    !validDate(publishedAt) ||
    !validDate(generatedAt) ||
    model === undefined ||
    !Number.isSafeInteger(districtCount) ||
    (districtCount as number) < 0 ||
    !Number.isSafeInteger(buildingCount) ||
    (buildingCount as number) < 0 ||
    (modelVersion !== undefined &&
      (typeof modelVersion !== "string" || modelVersion.length > 256))
  ) {
    throw new Error("Published city version is invalid.");
  }
  return Object.freeze({
    id,
    publishedAt,
    generatedAt,
    model,
    ...(evolution === undefined ? {} : { evolution }),
    ...(modelVersion === undefined ? {} : { modelVersion }),
    districtCount: districtCount as number,
    buildingCount: buildingCount as number,
  });
}

function parsePublication(value: unknown): PublishedCity {
  if (typeof value !== "object" || value === null) {
    throw new Error("Published city is invalid.");
  }
  const candidate = value as Record<string, unknown>;
  const expectedKeys = [
    "createdAt",
    "id",
    "latestVersionId",
    "title",
    "updatedAt",
    "versions",
    ...(candidate["description"] === undefined ? [] : ["description"]),
  ].sort(compareText);
  const actualKeys = Object.keys(candidate).sort(compareText);
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new Error("Published city is invalid.");
  }
  const id = candidate["id"];
  const title = safeText(candidate["title"], "Published city title", MAX_TITLE_LENGTH, true)!;
  const description = safeText(
    candidate["description"],
    "Published city description",
    MAX_DESCRIPTION_LENGTH,
    false,
  );
  const createdAt = candidate["createdAt"];
  const updatedAt = candidate["updatedAt"];
  const latestVersionId = candidate["latestVersionId"];
  const rawVersions = candidate["versions"];
  if (
    typeof id !== "string" ||
    !ID_PATTERN.test(id) ||
    !validDate(createdAt) ||
    !validDate(updatedAt) ||
    typeof latestVersionId !== "string" ||
    !ID_PATTERN.test(latestVersionId) ||
    !Array.isArray(rawVersions) ||
    rawVersions.length < 1 ||
    rawVersions.length > MAX_VERSIONS_PER_PUBLICATION
  ) {
    throw new Error("Published city is invalid.");
  }
  const versions = rawVersions.map(parseVersion);
  if (
    new Set(versions.map(({ id: versionId }) => versionId)).size !== versions.length ||
    !versions.some(({ id: versionId }) => versionId === latestVersionId)
  ) {
    throw new Error("Published city versions are invalid.");
  }
  return Object.freeze({
    id,
    title,
    ...(description === undefined ? {} : { description }),
    createdAt,
    updatedAt,
    latestVersionId,
    versions: Object.freeze(versions),
  });
}

function parseIndex(value: unknown): PublishedIndex {
  if (typeof value !== "object" || value === null) {
    throw new Error("Published city index is invalid.");
  }
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate).sort(compareText);
  if (
    keys.length !== 2 ||
    keys[0] !== "publications" ||
    keys[1] !== "version" ||
    candidate["version"] !== INDEX_VERSION ||
    !Array.isArray(candidate["publications"]) ||
    candidate["publications"].length > MAX_PUBLICATIONS
  ) {
    throw new Error("Published city index is invalid.");
  }
  const publications = candidate["publications"].map(parsePublication);
  if (new Set(publications.map(({ id }) => id)).size !== publications.length) {
    throw new Error("Published city IDs are duplicated.");
  }
  return Object.freeze({ version: 1, publications: Object.freeze(publications) });
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function publicModel(value: unknown) {
  const model = validateCityModel(value);
  const {
    analysis: _analysis,
    sourceProvenance: _sourceProvenance,
    ...published
  } = model;
  return validateCityModel(published);
}

function publicEvolutionArtifact(bytes: Uint8Array): {
  readonly bytes: Buffer;
  readonly frameCount: number;
  readonly deltaCount: number;
} {
  const parsed = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  ) as unknown;
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Evolution artifact is invalid.");
  }
  const candidate = parsed as Record<string, unknown>;
  const baseline = candidate["baseline"];
  const deltas = candidate["deltas"];
  if (
    typeof baseline !== "object" ||
    baseline === null ||
    !Array.isArray(deltas)
  ) {
    throw new Error("Evolution artifact is invalid.");
  }
  const baselineRecord = baseline as Record<string, unknown>;
  const sanitizedDeltas = deltas.map((delta) => {
    if (typeof delta !== "object" || delta === null) {
      throw new Error("Evolution artifact is invalid.");
    }
    const deltaRecord = delta as Record<string, unknown>;
    const changes = deltaRecord["changes"];
    if (typeof changes !== "object" || changes === null) {
      throw new Error("Evolution artifact is invalid.");
    }
    const changesRecord = changes as Record<string, unknown>;
    const modelChanges = changesRecord["model"];
    if (typeof modelChanges !== "object" || modelChanges === null) {
      throw new Error("Evolution artifact is invalid.");
    }
    const {
      analysis: _analysis,
      ...publicModelChanges
    } = modelChanges as Record<string, unknown>;
    return {
      ...deltaRecord,
      changes: {
        ...changesRecord,
        model: publicModelChanges,
      },
    };
  });
  const sanitized = {
    ...candidate,
    baseline: {
      ...baselineRecord,
      model: publicModel(baselineRecord["model"]),
    },
    deltas: sanitizedDeltas,
  };
  return {
    bytes: Buffer.from(`${JSON.stringify(sanitized)}\n`, "utf8"),
    frameCount: deltas.length + 1,
    deltaCount: deltas.length,
  };
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const status = await fs.lstat(directory);
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new Error("Published city directory is unsafe.");
  }
  if (process.platform !== "win32") await fs.chmod(directory, 0o700);
}

async function regularFileSize(file: string, label: string): Promise<number> {
  const status = await fs.lstat(file);
  if (!status.isFile() || status.isSymbolicLink() || status.nlink !== 1) {
    throw new Error(`${label} is unsafe.`);
  }
  return Number(status.size);
}

async function reconcilePublishedDirectory(
  root: string,
  publications: ReadonlyMap<string, PublishedCity>,
): Promise<void> {
  const rootEntries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of rootEntries) {
    if (entry.name === "index.json") continue;
    const entryPath = path.join(root, entry.name);
    if (/^index\.json\.[0-9a-f-]{36}\.tmp$/u.test(entry.name)) {
      await fs.rm(entryPath, { force: true });
      continue;
    }
    if (!ID_PATTERN.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error("Published city directory contains an unsafe entry.");
    }
    const publication = publications.get(entry.name);
    if (publication === undefined) {
      await fs.rm(entryPath, { recursive: true, force: true });
      continue;
    }
    const expectedVersions = new Map(
      publication.versions.map((version) => [version.id, version]),
    );
    for (const child of await fs.readdir(entryPath, { withFileTypes: true })) {
      const childPath = path.join(entryPath, child.name);
      if (/^\.stage-[0-9a-f-]{36}$/u.test(child.name)) {
        await fs.rm(childPath, { recursive: true, force: true });
        continue;
      }
      if (!ID_PATTERN.test(child.name) || !child.isDirectory() || child.isSymbolicLink()) {
        throw new Error("Published city version directory contains an unsafe entry.");
      }
      const version = expectedVersions.get(child.name);
      if (version === undefined) {
        await fs.rm(childPath, { recursive: true, force: true });
        continue;
      }
      const names = (await fs.readdir(childPath)).sort(compareText);
      const expectedNames = [
        "city-model.json",
        ...(version.evolution === undefined ? [] : ["evolution.json"]),
      ].sort(compareText);
      if (
        names.length !== expectedNames.length ||
        names.some((name, index) => name !== expectedNames[index]) ||
        await regularFileSize(
          path.join(childPath, "city-model.json"),
          "Published city model",
        ) !== version.model.size ||
        (version.evolution !== undefined &&
          await regularFileSize(
            path.join(childPath, "evolution.json"),
            "Published evolution",
          ) !== version.evolution.size)
      ) {
        throw new Error("Published city version artifacts are invalid.");
      }
      expectedVersions.delete(child.name);
    }
    if (expectedVersions.size !== 0) {
      throw new Error("Published city version artifacts are missing.");
    }
  }
  for (const publicationId of publications.keys()) {
    if (!rootEntries.some(({ name }) => name === publicationId)) {
      throw new Error("Published city directory is missing.");
    }
  }
}

async function writeAtomic(file: string, bytes: Uint8Array | string): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

export class PublishedCityStore {
  readonly #root: string;
  readonly #indexPath: string;
  #publications = new Map<string, PublishedCity>();
  #operation: Promise<unknown> = Promise.resolve();

  private constructor(root: string) {
    this.#root = root;
    this.#indexPath = path.join(root, "index.json");
  }

  public static async open(options: { readonly dataDirectory: string }): Promise<PublishedCityStore> {
    const root = path.resolve(options.dataDirectory, "published");
    await ensurePrivateDirectory(root);
    const store = new PublishedCityStore(root);
    let text: string | undefined;
    try {
      await regularFileSize(store.#indexPath, "Published city index");
      text = await fs.readFile(store.#indexPath, "utf8");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    if (text !== undefined) {
      const index = parseIndex(JSON.parse(text));
      store.#publications = new Map(index.publications.map((publication) => [publication.id, publication]));
    }
    await reconcilePublishedDirectory(root, store.#publications);
    return store;
  }

  public list(): readonly PublishedCity[] {
    return Object.freeze(
      [...this.#publications.values()].sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) || compareText(left.id, right.id),
      ),
    );
  }

  public get(publicationId: string): PublishedCity | undefined {
    return ID_PATTERN.test(publicationId) ? this.#publications.get(publicationId) : undefined;
  }

  public version(publicationId: string, versionId?: string): PublishedCityVersion | undefined {
    const publication = this.get(publicationId);
    if (publication === undefined) return undefined;
    const selected = versionId ?? publication.latestVersionId;
    if (!ID_PATTERN.test(selected)) return undefined;
    return publication.versions.find(({ id }) => id === selected);
  }

  public async publish(
    job: JobRecord,
    artifacts: ImportArtifactStore,
    input: PublishCityInput,
  ): Promise<PublishedCity> {
    return await this.#exclusive(async () => {
      if (
        job.state !== "completed" ||
        job.result?.kind !== "city-model" ||
        job.result.artifactToken !== job.id
      ) {
        throw new Error("Only a completed import can be published.");
      }
      const existing = input.publicationId === undefined
        ? undefined
        : this.get(input.publicationId);
      if (input.publicationId !== undefined && existing === undefined) {
        throw new Error("Published city not found.");
      }
      if (existing === undefined && this.#publications.size >= MAX_PUBLICATIONS) {
        throw new Error("Published city limit reached.");
      }
      if (existing !== undefined && existing.versions.length >= MAX_VERSIONS_PER_PUBLICATION) {
        throw new Error("Published city version limit reached.");
      }

      const modelArtifact = await artifacts.readCityModel(job.id);
      if (modelArtifact === undefined) throw new Error("City model artifact not found.");
      const model = validateCityModel(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(modelArtifact.bytes)),
      );
      const publishedModel = publicModel(model);
      const publishedModelBytes = Buffer.from(
        `${JSON.stringify(publishedModel)}\n`,
        "utf8",
      );
      const title = safeText(
        input.title ?? existing?.title ?? model.identity?.title ?? model.repositories[0]?.name ?? "Published Code City",
        "Published city title",
        MAX_TITLE_LENGTH,
        true,
      )!;
      const description = safeText(
        input.description ?? existing?.description,
        "Published city description",
        MAX_DESCRIPTION_LENGTH,
        false,
      );

      let evolutionBytes: Buffer | undefined;
      let evolutionMetadata: PublishedCityVersion["evolution"];
      const expectedEvolution = job.result.evolution;
      if (
        modelArtifact.bytes.byteLength + (expectedEvolution?.size ?? 0) >
        MAX_PUBLISHED_VERSION_BYTES
      ) {
        throw new Error("Published city version size limit reached.");
      }
      if (expectedEvolution !== undefined) {
        const evolution = await artifacts.readEvolution(job.id, expectedEvolution);
        if (evolution === undefined) throw new Error("Evolution artifact not found.");
        try {
          const chunks: Buffer[] = [];
          for await (const chunk of evolution.chunks()) chunks.push(Buffer.from(chunk));
          evolutionBytes = Buffer.concat(chunks);
        } finally {
          await evolution.close();
        }
        if (
          evolutionBytes.byteLength !== expectedEvolution.size ||
          sha256(evolutionBytes) !== expectedEvolution.sha256
        ) {
          throw new Error("Evolution artifact changed while publishing.");
        }
        const sanitizedEvolution = publicEvolutionArtifact(evolutionBytes);
        evolutionBytes = sanitizedEvolution.bytes;
        evolutionMetadata = Object.freeze({
          size: evolutionBytes.byteLength,
          sha256: sha256(evolutionBytes),
          frameCount: sanitizedEvolution.frameCount,
          deltaCount: sanitizedEvolution.deltaCount,
        });
      }

      const retainedBytes = this.list().reduce(
        (publicationTotal, publication) =>
          publicationTotal + publication.versions.reduce(
            (versionTotal, version) =>
              versionTotal + version.model.size + (version.evolution?.size ?? 0),
            0,
          ),
        0,
      );
      const nextBytes =
        publishedModelBytes.byteLength + (evolutionBytes?.byteLength ?? 0);
      if (retainedBytes + nextBytes > MAX_PUBLISHED_BYTES) {
        throw new Error("Published city storage limit reached.");
      }

      const publicationId = existing?.id ?? randomUUID();
      const versionId = randomUUID();
      const publicationDirectory = path.join(this.#root, publicationId);
      await ensurePrivateDirectory(publicationDirectory);
      const stage = path.join(publicationDirectory, `.stage-${versionId}`);
      const versionDirectory = path.join(publicationDirectory, versionId);
      await fs.mkdir(stage, { mode: 0o700 });
      try {
        await fs.writeFile(path.join(stage, "city-model.json"), publishedModelBytes, { flag: "wx", mode: 0o600 });
        if (evolutionBytes !== undefined) {
          await fs.writeFile(path.join(stage, "evolution.json"), evolutionBytes, { flag: "wx", mode: 0o600 });
        }
        await fs.rename(stage, versionDirectory);
      } catch (error) {
        await fs.rm(stage, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }

      const now = new Date().toISOString();
      const version = Object.freeze({
        id: versionId,
        publishedAt: now,
        generatedAt: job.updatedAt,
        model: Object.freeze({
          size: publishedModelBytes.byteLength,
          sha256: sha256(publishedModelBytes),
        }),
        ...(evolutionMetadata === undefined ? {} : { evolution: evolutionMetadata }),
        ...(model.identity?.version === undefined ? {} : { modelVersion: model.identity.version }),
        districtCount: model.districts.length,
        buildingCount: model.buildings.length,
      });
      const publication = Object.freeze({
        id: publicationId,
        title,
        ...(description === undefined ? {} : { description }),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        latestVersionId: versionId,
        versions: Object.freeze([version, ...(existing?.versions ?? [])]),
      });
      this.#publications.set(publicationId, publication);
      try {
        await this.#persist();
      } catch (error) {
        this.#publications = new Map(
          existing === undefined
            ? [...this.#publications].filter(([id]) => id !== publicationId)
            : [...this.#publications].map(([id, value]) => [id, id === publicationId ? existing : value]),
        );
        await fs.rm(versionDirectory, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
      return publication;
    });
  }

  public async remove(publicationId: string): Promise<boolean> {
    return await this.#exclusive(async () => {
      const existing = this.get(publicationId);
      if (existing === undefined) return false;
      this.#publications.delete(publicationId);
      try {
        await this.#persist();
      } catch (error) {
        this.#publications.set(publicationId, existing);
        throw error;
      }
      await fs.rm(path.join(this.#root, publicationId), { recursive: true, force: true });
      return true;
    });
  }

  public async readModel(
    publicationId: string,
    versionId?: string,
    signal?: AbortSignal,
  ): Promise<Buffer | undefined> {
    return await this.#readArtifact(
      publicationId,
      versionId,
      "city-model.json",
      "model",
      signal,
    );
  }

  public async readEvolution(
    publicationId: string,
    versionId?: string,
    signal?: AbortSignal,
  ): Promise<Buffer | undefined> {
    return await this.#readArtifact(
      publicationId,
      versionId,
      "evolution.json",
      "evolution",
      signal,
    );
  }

  async #readArtifact(
    publicationId: string,
    versionId: string | undefined,
    fileName: string,
    kind: "model" | "evolution",
    signal?: AbortSignal,
  ): Promise<Buffer | undefined> {
    const version = this.version(publicationId, versionId);
    if (version === undefined || (kind === "evolution" && version.evolution === undefined)) return undefined;
    const expected = kind === "model" ? version.model : version.evolution!;
    signal?.throwIfAborted();
    const bytes = await fs.readFile(
      path.join(this.#root, publicationId, version.id, fileName),
      signal === undefined ? undefined : { signal },
    );
    signal?.throwIfAborted();
    if (bytes.byteLength !== expected.size || sha256(bytes) !== expected.sha256) {
      throw new Error(`Published city ${kind} artifact is invalid.`);
    }
    return bytes;
  }

  async #persist(): Promise<void> {
    const index: PublishedIndex = Object.freeze({ version: 1, publications: this.list() });
    await writeAtomic(this.#indexPath, `${JSON.stringify(index)}\n`);
  }

  async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operation.then(operation, operation);
    this.#operation = result.then(() => undefined, () => undefined);
    return await result;
  }
}
