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
  "codecity.source-artifact/1" as const;
export const SOURCE_ARTIFACT_MAX_BYTES = 128 * 1024 * 1024;
export const SOURCE_ARTIFACT_MAX_FILE_BYTES = 16 * 1024 * 1024;
export type SourceRetentionPolicy = "retain" | "disabled";

export interface SourceArtifactFile {
  readonly buildingId: string;
  readonly repositoryId: string;
  readonly path: string;
  readonly language: SourceLanguage;
  readonly text: string;
}

export interface SourceArtifact {
  readonly version: typeof SOURCE_ARTIFACT_VERSION;
  readonly provenance: SourceNavigationProvenance;
  readonly files: readonly SourceArtifactFile[];
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
      if (
        file.byteLength < 1 ||
        file.byteLength > SOURCE_ARTIFACT_MAX_FILE_BYTES ||
        Buffer.byteLength(file.text, "utf8") !== file.byteLength
      ) {
        throw new TypeError("A retained source file is outside its limits.");
      }
      if (
        building.sourceLocation !== undefined &&
        building.sourceLocation.endLine !== lineCount(file.text)
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
  const provenanceModel = validateCityModel({
    schemaVersion: "1.0",
    generator: { name: "code-city", version: "source-artifact" },
    repositories: (
      object["provenance"] as {
        readonly repositories?: readonly {
          readonly repositoryId?: string;
        }[];
      }
    )?.repositories?.map(({ repositoryId }) => ({
      id: repositoryId,
      name: repositoryId,
    })) ?? [],
    solutions: [],
    modules: [],
    semanticGroups: [],
    sourceProvenance: object["provenance"],
    districts: [],
    buildings: [],
    dependencies: [],
    bounds: { x: 0, y: 0, z: 0 },
  });
  const provenance = provenanceModel.sourceProvenance!;
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
      ["buildingId", "language", "path", "repositoryId", "text"],
      `Source artifact file ${index}`,
    );
    if (
      typeof file["buildingId"] !== "string" ||
      file["buildingId"].length < 1 ||
      file["buildingId"].length > 2_048 ||
      seen.has(file["buildingId"])
    ) {
      throw new TypeError(
        `Source artifact file ${index} has an invalid building id.`,
      );
    }
    seen.add(file["buildingId"]);
    if (
      typeof file["repositoryId"] !== "string" ||
      !repositoryIds.has(file["repositoryId"])
    ) {
      throw new TypeError(
        `Source artifact file ${index} has an invalid repository id.`,
      );
    }
    if (
      typeof file["path"] !== "string" ||
      normalizePath(file["path"]) !== file["path"]
    ) {
      throw new TypeError(
        `Source artifact file ${index} has an invalid path.`,
      );
    }
    if (
      file["language"] !== "csharp" &&
      file["language"] !== "typescript" &&
      file["language"] !== "javascript"
    ) {
      throw new TypeError(
        `Source artifact file ${index} has an invalid language.`,
      );
    }
    if (
      typeof file["text"] !== "string" ||
      Buffer.byteLength(file["text"], "utf8") < 1 ||
      Buffer.byteLength(file["text"], "utf8") >
        SOURCE_ARTIFACT_MAX_FILE_BYTES
    ) {
      throw new TypeError(
        `Source artifact file ${index} is outside its byte limit.`,
      );
    }
    return Object.freeze({
      buildingId: file["buildingId"],
      repositoryId: file["repositoryId"],
      path: file["path"],
      language: file["language"],
      text: file["text"],
    });
  });
  const normalized = Object.freeze({
    version: SOURCE_ARTIFACT_VERSION,
    provenance,
    files: Object.freeze(files),
  });
  if (
    Buffer.byteLength(JSON.stringify(normalized), "utf8") >
    SOURCE_ARTIFACT_MAX_BYTES
  ) {
    throw new TypeError("Source artifact exceeds its total byte limit.");
  }
  return normalized;
}

export function serializeSourceArtifact(
  value: SourceArtifact,
): Buffer {
  const normalized = normalizeSourceArtifact(value);
  const bytes = Buffer.from(JSON.stringify(normalized), "utf8");
  if (bytes.byteLength > SOURCE_ARTIFACT_MAX_BYTES) {
    throw new TypeError("Source artifact exceeds its total byte limit.");
  }
  return bytes;
}

export function parseSourceArtifact(bytes: Uint8Array): SourceArtifact {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength < 1 ||
    bytes.byteLength > SOURCE_ARTIFACT_MAX_BYTES
  ) {
    throw new TypeError("Source artifact bytes are outside their limit.");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new TypeError("Source artifact must be valid UTF-8.");
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new TypeError("Source artifact must be valid JSON.");
  }
  return normalizeSourceArtifact(value);
}

export function sourceArtifactFile(
  artifact: SourceArtifact,
  model: CityModel,
  buildingId: string,
): SourceArtifactFile | undefined {
  const building = model.buildings.find(({ id }) => id === buildingId);
  if (building === undefined) return undefined;
  const file = artifact.files.find(
    (candidate) =>
      candidate.buildingId === building.id &&
      candidate.repositoryId === building.repositoryId &&
      candidate.path === building.path &&
      candidate.language === building.language,
  );
  return file;
}
