import { createHash } from "node:crypto";

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

export interface RetainedRepositorySnapshot {
  readonly repositoryId: string;
  readonly snapshot: RepositorySnapshot;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function lineCount(text: string): number {
  return Math.max(1, text.split(/\r\n?|\n/u).length);
}

function canonicalSnapshotDigest(snapshot: RepositorySnapshot): string {
  const digest = createHash("sha256");
  for (const file of [...snapshot.files].sort((left, right) =>
    compareText(left.path, right.path),
  )) {
    const pathBytes = Buffer.from(file.path, "utf8");
    const textBytes = Buffer.from(file.text, "utf8");
    const header = Buffer.allocUnsafe(8);
    header.writeUInt32BE(pathBytes.byteLength, 0);
    header.writeUInt32BE(textBytes.byteLength, 4);
    digest.update(header);
    digest.update(pathBytes);
    digest.update(textBytes);
  }
  return digest.digest("hex");
}

export function uploadedSnapshotProvenance(
  repositoryId: string,
  snapshot: RepositorySnapshot,
): SourceRepositoryProvenance {
  return Object.freeze({
    repositoryId,
    provider: "uploaded-archive",
    revision: Object.freeze({
      kind: "snapshot",
      value: `sha256:${canonicalSnapshotDigest(snapshot)}` as const,
    }),
  });
}

export function attachSourceProvenance(
  model: CityModel,
  repositories: readonly SourceRepositoryProvenance[],
): CityModel {
  return validateCityModel({
    ...model,
    sourceProvenance: {
      version: "codecity.source-navigation/1",
      repositories,
    },
  });
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
): SourceArtifact {
  const provenance = model.sourceProvenance;
  if (provenance === undefined) {
    throw new TypeError("Source provenance is required.");
  }
  const snapshots = new Map(
    retained.map(({ repositoryId, snapshot }) => [
      repositoryId,
      new Map(
        snapshot.files.map((file) => [
          normalizePath(file.path),
          file,
        ]),
      ),
    ]),
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
    if (!snapshots.has(repository.repositoryId)) {
      throw new TypeError(
        "Retained source repositories must exactly match provenance.",
      );
    }
  }
  const files = model.buildings
    .map((building): SourceArtifactFile => {
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
      const lines = lineCount(file.text);
      if (
        file.byteLength < 1 ||
        file.byteLength > SOURCE_ARTIFACT_MAX_FILE_BYTES ||
        Buffer.byteLength(file.text, "utf8") !== file.byteLength
      ) {
        throw new TypeError("A retained source file is outside its limits.");
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
      (left, right) =>
        compareText(left.repositoryId, right.repositoryId) ||
        compareText(left.path, right.path) ||
        compareText(left.buildingId, right.buildingId),
    );
  if (new Set(files.map(({ buildingId }) => buildingId)).size !== files.length) {
    throw new TypeError("Retained source building identifiers are duplicated.");
  }
  const artifact = Object.freeze({
    version: SOURCE_ARTIFACT_VERSION,
    provenance,
    files: Object.freeze(files),
  });
  serializeSourceArtifact(artifact);
  return artifact;
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

function normalizedProvenance(value: unknown): SourceNavigationProvenance {
  const repositories = (
    value as {
      readonly repositories?: readonly {
        readonly repositoryId?: string;
      }[];
    }
  )?.repositories;
  const provenanceModel = validateCityModel({
    schemaVersion: "1.0",
    generator: { name: "code-city", version: "source-artifact" },
    repositories:
      repositories?.map(({ repositoryId }) => ({
        id: repositoryId,
        name: repositoryId,
      })) ?? [],
    solutions: [],
    modules: [],
    semanticGroups: [],
    sourceProvenance: value,
    districts: [],
    buildings: [],
    dependencies: [],
    bounds: { x: 0, y: 0, z: 0 },
  });
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

export function normalizeSourceArtifact(value: unknown): SourceArtifact {
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
  const provenance = normalizedProvenance(object["provenance"]);
  if (!Array.isArray(object["files"])) {
    throw new TypeError("Source artifact files must be an array.");
  }
  const repositoryIds = new Set(
    provenance.repositories.map(({ repositoryId }) => repositoryId),
  );
  const seen = new Set<string>();
  const files = object["files"].map((value, index): SourceArtifactFile => {
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
      typeof text === "string" ? Buffer.byteLength(text, "utf8") : 0;
    if (
      typeof text !== "string" ||
      size < 1 ||
      size > SOURCE_ARTIFACT_MAX_FILE_BYTES ||
      identity.location.endLine !== lineCount(text)
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
): SourceArtifactIndex {
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
  const provenance = normalizedProvenance(object["provenance"]);
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
        (size as number) < 1 ||
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
  const normalized = normalizeSourceArtifact(value);
  const payloads: Buffer[] = [];
  let offset = 0;
  const files = normalized.files.map(
    (file): SourceArtifactIndexFile => {
      const bytes = Buffer.from(file.text, "utf8");
      payloads.push(bytes);
      const indexed = Object.freeze({
        buildingId: file.buildingId,
        repositoryId: file.repositoryId,
        path: file.path,
        language: file.language,
        location: file.location,
        offset,
        size: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
      offset += bytes.byteLength;
      return indexed;
    },
  );
  const index = normalizeSourceArtifactIndex({
    version: SOURCE_ARTIFACT_VERSION,
    provenance: normalized.provenance,
    files,
  });
  const indexBytes = Buffer.from(JSON.stringify(index), "utf8");
  if (indexBytes.byteLength > SOURCE_ARTIFACT_MAX_INDEX_BYTES) {
    throw new TypeError("Source artifact index exceeds its byte limit.");
  }
  const prefix = Buffer.alloc(SOURCE_ARTIFACT_PREFIX_BYTES);
  SOURCE_ARTIFACT_MAGIC.copy(prefix);
  prefix.writeUInt32BE(
    indexBytes.byteLength,
    SOURCE_ARTIFACT_MAGIC.byteLength,
  );
  const total =
    prefix.byteLength + indexBytes.byteLength + sourceArtifactPayloadBytes(index);
  if (total > SOURCE_ARTIFACT_MAX_BYTES) {
    throw new TypeError("Source artifact exceeds its total byte limit.");
  }
  return Buffer.concat([prefix, indexBytes, ...payloads], total);
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
      text = new TextDecoder("utf-8", { fatal: true }).decode(payload);
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
