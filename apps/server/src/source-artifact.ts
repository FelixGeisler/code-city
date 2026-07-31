import { createHash, type Hash } from "node:crypto";

import {
  normalizePath,
  validateCityModel,
  type CityModel,
  type SourceLanguage,
  type SourceNavigationProvenance,
  type SourceRepositoryProvenance,
} from "../../../packages/core/src/index.js";
import type {
  RepositorySnapshot,
  SnapshotFile,
} from "../../../packages/analyzer/src/snapshot.js";

export const SOURCE_ARTIFACT_VERSION =
  "codecity.source-artifact/2" as const;
export const SOURCE_ARTIFACT_MAX_BYTES = 128 * 1024 * 1024;
export const SOURCE_ARTIFACT_MAX_FILE_BYTES = 16 * 1024 * 1024;
export const SOURCE_ARTIFACT_MAX_INDEX_BYTES = 4 * 1024 * 1024;
export const SOURCE_ARTIFACT_PREFIX_BYTES = 12;
export const SOURCE_ARTIFACT_MAGIC = Buffer.from("CCSRC02\n", "ascii");
export type SourceRetentionPolicy = "retain" | "disabled";

export interface SourceArtifactWorkOptions {
  readonly signal?: AbortSignal;
  /** Synchronous cancellation/deadline checkpoint for CPU-bound work. */
  readonly checkpoint?: () => void;
}

export interface SourceArtifactLocation {
  readonly startLine: number;
  readonly endLine: number;
}

export interface SourceArtifactFile {
  readonly buildingId: string;
  readonly repositoryId: string;
  readonly path: string;
  readonly language: SourceLanguage;
  readonly location: SourceArtifactLocation;
  readonly text: string;
}

export interface SourceArtifact {
  readonly version: typeof SOURCE_ARTIFACT_VERSION;
  readonly provenance: SourceNavigationProvenance;
  readonly files: readonly SourceArtifactFile[];
}

export interface SourceArtifactIndexFile {
  readonly buildingId: string;
  readonly repositoryId: string;
  readonly path: string;
  readonly language: SourceLanguage;
  readonly location: SourceArtifactLocation;
  readonly offset: number;
  readonly size: number;
  readonly sha256: string;
}

export interface SourceArtifactIndex {
  readonly version: typeof SOURCE_ARTIFACT_VERSION;
  readonly provenance: SourceNavigationProvenance;
  readonly files: readonly SourceArtifactIndexFile[];
}

export interface PreparedSourceArtifact {
  readonly artifact: SourceArtifact;
  readonly prefix: Buffer;
  readonly indexChunks: readonly Buffer[];
  readonly index: SourceArtifactIndex;
  readonly payloads: readonly Buffer[];
  readonly size: number;
  /** Digest of the complete serialized v2 source pack. */
  readonly sha256: string;
  /** Digest of the exact canonical JSON index bytes. */
  readonly indexSha256: string;
}

export interface RetainedRepositorySnapshot {
  readonly repositoryId: string;
  readonly snapshot: RepositorySnapshot;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

const SOURCE_ARTIFACT_WORK_CHUNK_BYTES = 64 * 1024;
// A UTF-16 code unit can require at most three UTF-8 bytes unless paired;
// this keeps every encoded chunk below the 64 KiB work bound.
const SOURCE_ARTIFACT_UTF8_CHUNK_CHARACTERS = 16 * 1024;

function workCheckpoint(options: SourceArtifactWorkOptions): void {
  options.signal?.throwIfAborted();
  options.checkpoint?.();
  options.signal?.throwIfAborted();
}

function lineCount(
  text: string,
  options: SourceArtifactWorkOptions = {},
): number {
  let count = 1;
  let previousWasCarriageReturn = false;
  for (let index = 0; index < text.length; index += 1) {
    if (
      index % SOURCE_ARTIFACT_UTF8_CHUNK_CHARACTERS === 0
    ) {
      workCheckpoint(options);
    }
    const codeUnit = text.charCodeAt(index);
    if (codeUnit === 0x0d) {
      count += 1;
      previousWasCarriageReturn = true;
    } else if (codeUnit === 0x0a) {
      if (!previousWasCarriageReturn) count += 1;
      previousWasCarriageReturn = false;
    } else {
      previousWasCarriageReturn = false;
    }
  }
  workCheckpoint(options);
  return count;
}

function updateDigest(
  digest: Hash,
  bytes: Uint8Array,
  options: SourceArtifactWorkOptions,
): void {
  for (
    let offset = 0;
    offset < bytes.byteLength;
    offset += SOURCE_ARTIFACT_WORK_CHUNK_BYTES
  ) {
    workCheckpoint(options);
    digest.update(
      bytes.subarray(
        offset,
        Math.min(
          offset + SOURCE_ARTIFACT_WORK_CHUNK_BYTES,
          bytes.byteLength,
        ),
      ),
    );
  }
  workCheckpoint(options);
}

function encodedUtf8(
  text: string,
  options: SourceArtifactWorkOptions,
): { readonly chunks: readonly Buffer[]; readonly byteLength: number } {
  const chunks: Buffer[] = [];
  let byteLength = 0;
  let offset = 0;
  while (offset < text.length) {
    workCheckpoint(options);
    let end = Math.min(
      offset + SOURCE_ARTIFACT_UTF8_CHUNK_CHARACTERS,
      text.length,
    );
    if (
      end < text.length &&
      end > offset &&
      text.charCodeAt(end - 1) >= 0xd800 &&
      text.charCodeAt(end - 1) <= 0xdbff &&
      text.charCodeAt(end) >= 0xdc00 &&
      text.charCodeAt(end) <= 0xdfff
    ) {
      end -= 1;
    }
    const chunk = Buffer.from(text.slice(offset, end), "utf8");
    chunks.push(chunk);
    byteLength += chunk.byteLength;
    offset = end;
    workCheckpoint(options);
  }
  workCheckpoint(options);
  return { chunks, byteLength };
}

function utf8ByteLength(
  text: string,
  options: SourceArtifactWorkOptions,
): number {
  return encodedUtf8(text, options).byteLength;
}

function canonicalSnapshotDigest(
  snapshot: RepositorySnapshot,
  options: SourceArtifactWorkOptions,
): string {
  const digest = createHash("sha256");
  for (const file of [...snapshot.files].sort((left, right) => {
    workCheckpoint(options);
    return compareText(left.path, right.path);
  })) {
    workCheckpoint(options);
    const pathBytes = encodedUtf8(file.path, options);
    const textBytes = encodedUtf8(file.text, options);
    const header = Buffer.allocUnsafe(8);
    header.writeUInt32BE(pathBytes.byteLength, 0);
    header.writeUInt32BE(textBytes.byteLength, 4);
    digest.update(header);
    for (const chunk of pathBytes.chunks) {
      updateDigest(digest, chunk, options);
    }
    for (const chunk of textBytes.chunks) {
      updateDigest(digest, chunk, options);
    }
  }
  workCheckpoint(options);
  return digest.digest("hex");
}

export function uploadedSnapshotProvenance(
  repositoryId: string,
  snapshot: RepositorySnapshot,
  options: SourceArtifactWorkOptions = {},
): SourceRepositoryProvenance {
  return Object.freeze({
    repositoryId,
    provider: "uploaded-archive",
    revision: Object.freeze({
      kind: "snapshot",
      value:
        `sha256:${canonicalSnapshotDigest(snapshot, options)}` as const,
    }),
  });
}

export function attachSourceProvenance(
  model: CityModel,
  repositories: readonly SourceRepositoryProvenance[],
  options: SourceArtifactWorkOptions = {},
): CityModel {
  workCheckpoint(options);
  return validateCityModel(
    {
      ...model,
      sourceProvenance: {
        version: "codecity.source-navigation/1",
        repositories,
      },
    },
    { checkpoint: () => workCheckpoint(options) },
  );
}

function requiredSnapshotFile(
  files: ReadonlyMap<string, SnapshotFile>,
  path: string,
): SnapshotFile {
  const file = files.get(path);
  if (file === undefined) {
    throw new TypeError(
      "A model building has no matching retained source file.",
    );
  }
  return file;
}

export function createSourceArtifact(
  model: CityModel,
  retained: readonly RetainedRepositorySnapshot[],
  options: SourceArtifactWorkOptions = {},
): SourceArtifact {
  workCheckpoint(options);
  const provenance = model.sourceProvenance;
  if (provenance === undefined) {
    throw new TypeError("Source provenance is required.");
  }
  const snapshots = new Map(
    retained.map(({ repositoryId, snapshot }) => {
      workCheckpoint(options);
      return [
        repositoryId,
        new Map(
          snapshot.files.map((file) => {
            workCheckpoint(options);
            return [normalizePath(file.path), file] as const;
          }),
        ),
      ] as const;
    }),
  );
  if (
    snapshots.size !== retained.length ||
    provenance.repositories.length !== retained.length
  ) {
    throw new TypeError(
      "Retained source repositories must exactly match provenance.",
    );
  }
  for (const repository of provenance.repositories) {
    workCheckpoint(options);
    if (!snapshots.has(repository.repositoryId)) {
      throw new TypeError(
        "Retained source repositories must exactly match provenance.",
      );
    }
  }
  let payloadBytes = 0;
  const files = model.buildings
    .map((building): SourceArtifactFile => {
      workCheckpoint(options);
      const repositoryFiles = snapshots.get(building.repositoryId);
      if (repositoryFiles === undefined) {
        throw new TypeError(
          "A model building references unavailable source provenance.",
        );
      }
      const file = requiredSnapshotFile(
        repositoryFiles,
        normalizePath(building.path),
      );
      const lines = lineCount(file.text, options);
      const normalizedByteLength = utf8ByteLength(file.text, options);
      if (
        !Number.isSafeInteger(file.byteLength) ||
        (file.byteLength !== normalizedByteLength &&
          file.byteLength !== normalizedByteLength + 3) ||
        file.byteLength > SOURCE_ARTIFACT_MAX_FILE_BYTES ||
        normalizedByteLength > SOURCE_ARTIFACT_MAX_FILE_BYTES
      ) {
        throw new TypeError("A retained source file is outside its limits.");
      }
      payloadBytes += normalizedByteLength;
      if (
        !Number.isSafeInteger(payloadBytes) ||
        payloadBytes > SOURCE_ARTIFACT_MAX_BYTES
      ) {
        throw new TypeError("Retained source exceeds its total byte limit.");
      }
      if (
        building.sourceLocation !== undefined &&
        building.sourceLocation.endLine !== lines
      ) {
        throw new TypeError(
          "Building source location does not match retained source.",
        );
      }
      return Object.freeze({
        buildingId: building.id,
        repositoryId: building.repositoryId,
        path: building.path,
        language: building.language,
        location: Object.freeze(
          building.sourceLocation ?? { startLine: 1, endLine: lines },
        ),
        text: file.text,
      });
    })
    .sort(
      (left, right) => {
        workCheckpoint(options);
        return (
          compareText(left.repositoryId, right.repositoryId) ||
          compareText(left.path, right.path) ||
          compareText(left.buildingId, right.buildingId)
        );
      },
    );
  if (new Set(files.map(({ buildingId }) => buildingId)).size !== files.length) {
    throw new TypeError("Retained source building identifiers are duplicated.");
  }
  workCheckpoint(options);
  return Object.freeze({
    version: SOURCE_ARTIFACT_VERSION,
    provenance,
    files: Object.freeze(files),
  });
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
  name: string,
): void {
  const keys = Object.keys(value).sort(compareText);
  const sorted = [...expected].sort(compareText);
  if (
    keys.length !== sorted.length ||
    keys.some((key, index) => key !== sorted[index])
  ) {
    throw new TypeError(`${name} has unknown or missing fields.`);
  }
}

function normalizedProvenance(
  value: unknown,
  options: SourceArtifactWorkOptions = {},
): SourceNavigationProvenance {
  const repositories = (
    value as {
      readonly repositories?: readonly {
        readonly repositoryId?: string;
      }[];
    }
  )?.repositories;
  const provenanceModel = validateCityModel(
    {
      schemaVersion: "1.0",
      generator: { name: "code-city", version: "source-artifact" },
      repositories:
        repositories?.map(({ repositoryId }) => {
          workCheckpoint(options);
          return {
            id: repositoryId,
            name: repositoryId,
          };
        }) ?? [],
      solutions: [],
      modules: [],
      semanticGroups: [],
      sourceProvenance: value,
      districts: [],
      buildings: [],
      dependencies: [],
      bounds: { x: 0, y: 0, z: 0 },
    },
    { checkpoint: () => workCheckpoint(options) },
  );
  return provenanceModel.sourceProvenance!;
}

function normalizedLocation(
  value: unknown,
  description: string,
): SourceArtifactLocation {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new TypeError(`${description} is invalid.`);
  }
  const location = value as Readonly<Record<string, unknown>>;
  exactKeys(location, ["endLine", "startLine"], description);
  const startLine = location["startLine"];
  const endLine = location["endLine"];
  if (
    !Number.isSafeInteger(startLine) ||
    !Number.isSafeInteger(endLine) ||
    (startLine as number) < 1 ||
    (endLine as number) < (startLine as number)
  ) {
    throw new TypeError(`${description} is invalid.`);
  }
  return Object.freeze({
    startLine: startLine as number,
    endLine: endLine as number,
  });
}

function normalizedFileIdentity(
  value: Readonly<Record<string, unknown>>,
  index: number,
  repositoryIds: ReadonlySet<string>,
  seen: Set<string>,
): {
  readonly buildingId: string;
  readonly repositoryId: string;
  readonly path: string;
  readonly language: SourceLanguage;
  readonly location: SourceArtifactLocation;
} {
  const buildingId = value["buildingId"];
  const repositoryId = value["repositoryId"];
  const filePath = value["path"];
  const language = value["language"];
  if (
    typeof buildingId !== "string" ||
    buildingId.length < 1 ||
    buildingId.length > 2_048 ||
    seen.has(buildingId)
  ) {
    throw new TypeError(
      `Source artifact file ${index} has an invalid building id.`,
    );
  }
  seen.add(buildingId);
  if (
    typeof repositoryId !== "string" ||
    !repositoryIds.has(repositoryId)
  ) {
    throw new TypeError(
      `Source artifact file ${index} has an invalid repository id.`,
    );
  }
  if (
    typeof filePath !== "string" ||
    normalizePath(filePath) !== filePath
  ) {
    throw new TypeError(
      `Source artifact file ${index} has an invalid path.`,
    );
  }
  if (
    language !== "csharp" &&
    language !== "typescript" &&
    language !== "javascript"
  ) {
    throw new TypeError(
      `Source artifact file ${index} has an invalid language.`,
    );
  }
  return Object.freeze({
    buildingId,
    repositoryId,
    path: filePath,
    language,
    location: normalizedLocation(
      value["location"],
      `Source artifact file ${index} location`,
    ),
  });
}

export function normalizeSourceArtifact(
  value: unknown,
  options: SourceArtifactWorkOptions = {},
): SourceArtifact {
  workCheckpoint(options);
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new TypeError("Source artifact must be an object.");
  }
  const object = value as Readonly<Record<string, unknown>>;
  exactKeys(object, ["files", "provenance", "version"], "Source artifact");
  if (object["version"] !== SOURCE_ARTIFACT_VERSION) {
    throw new TypeError("Source artifact version is invalid.");
  }
  const provenance = normalizedProvenance(object["provenance"], options);
  if (!Array.isArray(object["files"])) {
    throw new TypeError("Source artifact files must be an array.");
  }
  const repositoryIds = new Set(
    provenance.repositories.map(({ repositoryId }) => repositoryId),
  );
  const seen = new Set<string>();
  const files = object["files"].map((value, index): SourceArtifactFile => {
    workCheckpoint(options);
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value)
    ) {
      throw new TypeError(`Source artifact file ${index} is invalid.`);
    }
    const file = value as Readonly<Record<string, unknown>>;
    exactKeys(
      file,
      [
        "buildingId",
        "language",
        "location",
        "path",
        "repositoryId",
        "text",
      ],
      `Source artifact file ${index}`,
    );
    const identity = normalizedFileIdentity(
      file,
      index,
      repositoryIds,
      seen,
    );
    const text = file["text"];
    const size =
      typeof text === "string" ? utf8ByteLength(text, options) : 0;
    if (
      typeof text !== "string" ||
      size > SOURCE_ARTIFACT_MAX_FILE_BYTES ||
      identity.location.endLine !== lineCount(text, options)
    ) {
      throw new TypeError(
        `Source artifact file ${index} is outside its limits.`,
      );
    }
    return Object.freeze({ ...identity, text });
  });
  return Object.freeze({
    version: SOURCE_ARTIFACT_VERSION,
    provenance,
    files: Object.freeze(files),
  });
}

export function normalizeSourceArtifactIndex(
  value: unknown,
  options: SourceArtifactWorkOptions = {},
): SourceArtifactIndex {
  workCheckpoint(options);
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new TypeError("Source artifact index must be an object.");
  }
  const object = value as Readonly<Record<string, unknown>>;
  exactKeys(
    object,
    ["files", "provenance", "version"],
    "Source artifact index",
  );
  if (object["version"] !== SOURCE_ARTIFACT_VERSION) {
    throw new TypeError("Source artifact index version is invalid.");
  }
  const provenance = normalizedProvenance(object["provenance"], options);
  if (!Array.isArray(object["files"])) {
    throw new TypeError("Source artifact index files must be an array.");
  }
  const repositoryIds = new Set(
    provenance.repositories.map(({ repositoryId }) => repositoryId),
  );
  const seen = new Set<string>();
  let nextOffset = 0;
  const files = object["files"].map(
    (value, index): SourceArtifactIndexFile => {
      workCheckpoint(options);
      if (
        typeof value !== "object" ||
        value === null ||
        Array.isArray(value)
      ) {
        throw new TypeError(`Source artifact index file ${index} is invalid.`);
      }
      const file = value as Readonly<Record<string, unknown>>;
      exactKeys(
        file,
        [
          "buildingId",
          "language",
          "location",
          "offset",
          "path",
          "repositoryId",
          "sha256",
          "size",
        ],
        `Source artifact index file ${index}`,
      );
      const identity = normalizedFileIdentity(
        file,
        index,
        repositoryIds,
        seen,
      );
      const offset = file["offset"];
      const size = file["size"];
      const sha256 = file["sha256"];
      if (
        !Number.isSafeInteger(offset) ||
        (offset as number) !== nextOffset ||
        !Number.isSafeInteger(size) ||
        (size as number) < 0 ||
        (size as number) > SOURCE_ARTIFACT_MAX_FILE_BYTES ||
        typeof sha256 !== "string" ||
        !/^[0-9a-f]{64}$/u.test(sha256)
      ) {
        throw new TypeError(
          `Source artifact index file ${index} has invalid bounds or digest.`,
        );
      }
      nextOffset += size as number;
      if (
        !Number.isSafeInteger(nextOffset) ||
        nextOffset > SOURCE_ARTIFACT_MAX_BYTES
      ) {
        throw new TypeError("Source artifact payload exceeds its limit.");
      }
      return Object.freeze({
        ...identity,
        offset: offset as number,
        size: size as number,
        sha256,
      });
    },
  );
  return Object.freeze({
    version: SOURCE_ARTIFACT_VERSION,
    provenance,
    files: Object.freeze(files),
  });
}

export function sourceArtifactIndexLength(prefix: Uint8Array): number {
  if (
    !(prefix instanceof Uint8Array) ||
    prefix.byteLength !== SOURCE_ARTIFACT_PREFIX_BYTES ||
    !Buffer.from(prefix.subarray(0, SOURCE_ARTIFACT_MAGIC.byteLength)).equals(
      SOURCE_ARTIFACT_MAGIC,
    )
  ) {
    throw new TypeError("Source artifact prefix is invalid.");
  }
  const length = Buffer.from(prefix).readUInt32BE(
    SOURCE_ARTIFACT_MAGIC.byteLength,
  );
  if (length < 2 || length > SOURCE_ARTIFACT_MAX_INDEX_BYTES) {
    throw new TypeError("Source artifact index is outside its limit.");
  }
  return length;
}

export function parseSourceArtifactIndex(
  bytes: Uint8Array,
): SourceArtifactIndex {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength < 2 ||
    bytes.byteLength > SOURCE_ARTIFACT_MAX_INDEX_BYTES
  ) {
    throw new TypeError("Source artifact index bytes are outside their limit.");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new TypeError("Source artifact index must be valid UTF-8.");
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new TypeError("Source artifact index must be valid JSON.");
  }
  return normalizeSourceArtifactIndex(value);
}

export function sourceArtifactPayloadBytes(
  index: SourceArtifactIndex,
): number {
  const last = index.files.at(-1);
  return last === undefined ? 0 : last.offset + last.size;
}

export function serializeSourceArtifact(value: SourceArtifact): Buffer {
  const prepared = prepareSourceArtifact(value);
  return Buffer.concat(
    [prepared.prefix, ...prepared.indexChunks, ...prepared.payloads],
    prepared.size,
  );
}

export function prepareSourceArtifact(
  value: SourceArtifact,
  options: SourceArtifactWorkOptions = {},
): PreparedSourceArtifact {
  workCheckpoint(options);
  const normalized = normalizeSourceArtifact(value, options);
  const payloads: Buffer[] = [];
  let offset = 0;
  const files = normalized.files.map(
    (file): SourceArtifactIndexFile => {
      workCheckpoint(options);
      const encoded = encodedUtf8(file.text, options);
      payloads.push(...encoded.chunks);
      const digest = createHash("sha256");
      for (const chunk of encoded.chunks) {
        updateDigest(digest, chunk, options);
      }
      const indexed = Object.freeze({
        buildingId: file.buildingId,
        repositoryId: file.repositoryId,
        path: file.path,
        language: file.language,
        location: file.location,
        offset,
        size: encoded.byteLength,
        sha256: digest.digest("hex"),
      });
      offset += encoded.byteLength;
      return indexed;
    },
  );
  const index = normalizeSourceArtifactIndex(
    {
      version: SOURCE_ARTIFACT_VERSION,
      provenance: normalized.provenance,
      files,
    },
    options,
  );
  let serializedProperties = 0;
  const serializedIndex = JSON.stringify(index, (_key, item) => {
    serializedProperties += 1;
    if (serializedProperties >= 256) {
      serializedProperties = 0;
      workCheckpoint(options);
    }
    return item;
  });
  workCheckpoint(options);
  const encodedIndex = encodedUtf8(serializedIndex, options);
  if (encodedIndex.byteLength > SOURCE_ARTIFACT_MAX_INDEX_BYTES) {
    throw new TypeError("Source artifact index exceeds its byte limit.");
  }
  const prefix = Buffer.alloc(SOURCE_ARTIFACT_PREFIX_BYTES);
  SOURCE_ARTIFACT_MAGIC.copy(prefix);
  prefix.writeUInt32BE(
    encodedIndex.byteLength,
    SOURCE_ARTIFACT_MAGIC.byteLength,
  );
  const total =
    prefix.byteLength +
    encodedIndex.byteLength +
    sourceArtifactPayloadBytes(index);
  if (total > SOURCE_ARTIFACT_MAX_BYTES) {
    throw new TypeError("Source artifact exceeds its total byte limit.");
  }
  const overallDigest = createHash("sha256");
  updateDigest(overallDigest, prefix, options);
  for (const chunk of encodedIndex.chunks) {
    updateDigest(overallDigest, chunk, options);
  }
  for (const payload of payloads) {
    updateDigest(overallDigest, payload, options);
  }
  const indexDigest = createHash("sha256");
  for (const chunk of encodedIndex.chunks) {
    updateDigest(indexDigest, chunk, options);
  }
  workCheckpoint(options);
  return Object.freeze({
    artifact: normalized,
    prefix,
    indexChunks: Object.freeze([...encodedIndex.chunks]),
    index,
    payloads: Object.freeze(payloads),
    size: total,
    sha256: overallDigest.digest("hex"),
    indexSha256: indexDigest.digest("hex"),
  });
}

export function parseSourceArtifact(bytes: Uint8Array): SourceArtifact {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength < SOURCE_ARTIFACT_PREFIX_BYTES + 2 ||
    bytes.byteLength > SOURCE_ARTIFACT_MAX_BYTES
  ) {
    throw new TypeError("Source artifact bytes are outside their limit.");
  }
  const indexLength = sourceArtifactIndexLength(
    bytes.subarray(0, SOURCE_ARTIFACT_PREFIX_BYTES),
  );
  const payloadOffset = SOURCE_ARTIFACT_PREFIX_BYTES + indexLength;
  if (payloadOffset > bytes.byteLength) {
    throw new TypeError("Source artifact index is truncated.");
  }
  const index = parseSourceArtifactIndex(
    bytes.subarray(SOURCE_ARTIFACT_PREFIX_BYTES, payloadOffset),
  );
  if (
    payloadOffset + sourceArtifactPayloadBytes(index) !==
    bytes.byteLength
  ) {
    throw new TypeError("Source artifact payload bounds are invalid.");
  }
  const files = index.files.map((file, fileIndex): SourceArtifactFile => {
    const payload = bytes.subarray(
      payloadOffset + file.offset,
      payloadOffset + file.offset + file.size,
    );
    if (
      createHash("sha256").update(payload).digest("hex") !== file.sha256
    ) {
      throw new TypeError(
        `Source artifact file ${fileIndex} digest is invalid.`,
      );
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(payload);
    } catch {
      throw new TypeError(
        `Source artifact file ${fileIndex} must be valid UTF-8.`,
      );
    }
    return Object.freeze({
      buildingId: file.buildingId,
      repositoryId: file.repositoryId,
      path: file.path,
      language: file.language,
      location: file.location,
      text,
    });
  });
  return normalizeSourceArtifact({
    version: SOURCE_ARTIFACT_VERSION,
    provenance: index.provenance,
    files,
  });
}

export function sourceArtifactFile(
  artifact: SourceArtifact,
  model: CityModel,
  buildingId: string,
): SourceArtifactFile | undefined {
  const building = model.buildings.find(({ id }) => id === buildingId);
  if (building === undefined) return undefined;
  return artifact.files.find(
    (candidate) =>
      candidate.buildingId === building.id &&
      candidate.repositoryId === building.repositoryId &&
      candidate.path === building.path &&
      candidate.language === building.language,
  );
}
