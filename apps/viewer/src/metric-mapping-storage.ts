import {
  validateMetricMappingDefinition,
  type CityModel,
  type MetricMappingDefinitionV1,
} from "../../../packages/core/src/index.js";

export const METRIC_MAPPING_STORAGE_PREFIX =
  "code-city-metric-configurations-v1:";
export const MAXIMUM_METRIC_MAPPING_CONFIGURATIONS = 16;
export const MAXIMUM_METRIC_MAPPING_CONFIGURATION_NAME_CHARACTERS = 64;
export const MAXIMUM_METRIC_MAPPING_STORAGE_BYTES = 128 * 1024;

interface MetricMappingStorageDocumentV1 {
  readonly version: 1;
  readonly projectIdentity: string;
  readonly configurations: readonly StoredMetricMappingConfiguration[];
}

export interface StoredMetricMappingConfiguration {
  readonly name: string;
  readonly mapping: MetricMappingDefinitionV1;
}

export interface MetricMappingStorageResult {
  readonly ok: boolean;
  readonly message: string;
}

export interface MetricMappingStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function copyMapping(
  mapping: MetricMappingDefinitionV1,
): MetricMappingDefinitionV1 {
  return structuredClone(mapping);
}

function normalizeConfigurationName(name: string): string {
  const normalized = name.trim().replace(/\s+/gu, " ");
  if (
    normalized.length === 0 ||
    normalized.length >
      MAXIMUM_METRIC_MAPPING_CONFIGURATION_NAME_CHARACTERS ||
    /[\p{Cc}\p{Cf}\p{Cs}]/u.test(normalized)
  ) {
    throw new RangeError(
      `Configuration names must contain 1-${MAXIMUM_METRIC_MAPPING_CONFIGURATION_NAME_CHARACTERS} visible characters.`,
    );
  }
  return normalized;
}

function identityMaterial(model: CityModel): string {
  const repositories = [...model.repositories]
    .map(({ id, name }) => [id, name] as const)
    .sort(
      ([leftId, leftName], [rightId, rightName]) =>
        leftId.localeCompare(rightId) || leftName.localeCompare(rightName),
    );
  const solutions = [...model.solutions]
    .map(({ id, repositoryId, name, path }) => ({
      id,
      repositoryId,
      name,
      path,
    }))
    .sort(
      (left, right) =>
        left.repositoryId.localeCompare(right.repositoryId) ||
        left.path.localeCompare(right.path) ||
        left.id.localeCompare(right.id),
    );
  const modules = [...model.modules]
    .map(
      ({
        id,
        repositoryId,
        parentModuleId,
        kind,
        name,
        path,
        packageId,
      }) => ({
        id,
        repositoryId,
        ...(parentModuleId === undefined ? {} : { parentModuleId }),
        kind,
        name,
        path,
        ...(packageId === undefined ? {} : { packageId }),
      }),
    )
    .sort(
      (left, right) =>
        left.repositoryId.localeCompare(right.repositoryId) ||
        left.path.localeCompare(right.path) ||
        left.id.localeCompare(right.id),
    );
  return JSON.stringify({
    version: 2,
    schemaVersion: model.schemaVersion,
    repositories,
    // CityModel has no globally unique, privacy-safe origin identifier. The
    // declared solution/module topology is the strongest bounded project
    // anchor available: it distinguishes unrelated same-named repositories
    // while remaining stable across ordinary file and metric evolution.
    solutions,
    modules,
  });
}

function fnv1a64(value: string): string {
  let hash = 0xcbf29ce484222325n;
  const bytes = new TextEncoder().encode(value);
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

export function metricMappingProjectIdentity(model: CityModel): string {
  return `project-v2-${fnv1a64(identityMaterial(model))}`;
}

export function metricMappingStorageKey(model: CityModel): string {
  return `${METRIC_MAPPING_STORAGE_PREFIX}${metricMappingProjectIdentity(
    model,
  )}`;
}

function configuration(
  value: unknown,
): StoredMetricMappingConfiguration | undefined {
  const candidate = record(value);
  if (
    candidate === undefined ||
    !hasExactKeys(candidate, ["name", "mapping"]) ||
    typeof candidate["name"] !== "string"
  ) {
    return undefined;
  }
  let name: string;
  try {
    name = normalizeConfigurationName(candidate["name"]);
    if (name !== candidate["name"]) return undefined;
    validateMetricMappingDefinition(candidate["mapping"]);
  } catch {
    return undefined;
  }
  return {
    name,
    mapping: copyMapping(
      candidate["mapping"] as MetricMappingDefinitionV1,
    ),
  };
}

function parseDocument(
  value: string,
  projectIdentity: string,
): MetricMappingStorageDocumentV1 | undefined {
  if (
    new TextEncoder().encode(value).byteLength >
    MAXIMUM_METRIC_MAPPING_STORAGE_BYTES
  ) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  const candidate = record(parsed);
  if (
    candidate === undefined ||
    !hasExactKeys(candidate, [
      "version",
      "projectIdentity",
      "configurations",
    ]) ||
    candidate["version"] !== 1 ||
    candidate["projectIdentity"] !== projectIdentity ||
    !Array.isArray(candidate["configurations"]) ||
    candidate["configurations"].length >
      MAXIMUM_METRIC_MAPPING_CONFIGURATIONS
  ) {
    return undefined;
  }
  const configurations = candidate["configurations"].map(configuration);
  if (configurations.some((entry) => entry === undefined)) {
    return undefined;
  }
  const names = new Set<string>();
  for (const entry of configurations) {
    const key = entry!.name.toLocaleLowerCase("en-US");
    if (names.has(key)) return undefined;
    names.add(key);
  }
  return {
    version: 1,
    projectIdentity,
    configurations:
      configurations as readonly StoredMetricMappingConfiguration[],
  };
}

function emptyDocument(
  projectIdentity: string,
): MetricMappingStorageDocumentV1 {
  return { version: 1, projectIdentity, configurations: [] };
}

/**
 * A bounded, versioned project-local configuration store. Storage failures
 * never escape into the viewer and malformed documents are ignored wholesale.
 */
export class MetricMappingConfigurationStore {
  public constructor(private readonly storage: MetricMappingStorage) {}

  public list(model: CityModel): readonly StoredMetricMappingConfiguration[] {
    const projectIdentity = metricMappingProjectIdentity(model);
    let value: string | null;
    try {
      value = this.storage.getItem(metricMappingStorageKey(model));
    } catch {
      return [];
    }
    if (value === null) return [];
    const document = parseDocument(value, projectIdentity);
    return Object.freeze(
      (document?.configurations ?? []).map((entry) =>
        Object.freeze({
          name: entry.name,
          mapping: copyMapping(entry.mapping),
        }),
      ),
    );
  }

  public save(
    model: CityModel,
    name: string,
    mapping: MetricMappingDefinitionV1,
  ): MetricMappingStorageResult {
    let normalizedName: string;
    try {
      normalizedName = normalizeConfigurationName(name);
      validateMetricMappingDefinition(mapping);
    } catch (error) {
      return {
        ok: false,
        message:
          error instanceof Error
            ? error.message
            : "The metric configuration is invalid.",
      };
    }

    const projectIdentity = metricMappingProjectIdentity(model);
    const existing = this.readDocument(model) ?? emptyDocument(projectIdentity);
    const matchingIndex = existing.configurations.findIndex(
      (entry) =>
        entry.name.toLocaleLowerCase("en-US") ===
        normalizedName.toLocaleLowerCase("en-US"),
    );
    if (
      matchingIndex < 0 &&
      existing.configurations.length >=
        MAXIMUM_METRIC_MAPPING_CONFIGURATIONS
    ) {
      return {
        ok: false,
        message: `A project can store at most ${MAXIMUM_METRIC_MAPPING_CONFIGURATIONS} metric configurations.`,
      };
    }
    const replacement: StoredMetricMappingConfiguration = {
      name: normalizedName,
      mapping: copyMapping(mapping),
    };
    const configurations = [...existing.configurations];
    if (matchingIndex < 0) {
      configurations.push(replacement);
    } else {
      configurations[matchingIndex] = replacement;
    }
    configurations.sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    return this.write(model, {
      version: 1,
      projectIdentity,
      configurations,
    });
  }

  public delete(
    model: CityModel,
    name: string,
  ): MetricMappingStorageResult {
    let normalizedName: string;
    try {
      normalizedName = normalizeConfigurationName(name);
    } catch (error) {
      return {
        ok: false,
        message:
          error instanceof Error
            ? error.message
            : "The metric configuration name is invalid.",
      };
    }
    const existing = this.readDocument(model);
    if (existing === undefined) {
      return { ok: true, message: "No saved configuration was changed." };
    }
    const configurations = existing.configurations.filter(
      (entry) =>
        entry.name.toLocaleLowerCase("en-US") !==
        normalizedName.toLocaleLowerCase("en-US"),
    );
    if (configurations.length === existing.configurations.length) {
      return { ok: true, message: "No saved configuration was changed." };
    }
    if (configurations.length === 0 && this.storage.removeItem) {
      try {
        this.storage.removeItem(metricMappingStorageKey(model));
        return {
          ok: true,
          message: `Deleted “${normalizedName}”.`,
        };
      } catch {
        return {
          ok: false,
          message:
            "Browser storage is unavailable; the configuration was not deleted.",
        };
      }
    }
    const result = this.write(model, {
      ...existing,
      configurations,
    });
    return result.ok
      ? { ok: true, message: `Deleted “${normalizedName}”.` }
      : result;
  }

  private readDocument(
    model: CityModel,
  ): MetricMappingStorageDocumentV1 | undefined {
    const projectIdentity = metricMappingProjectIdentity(model);
    try {
      const value = this.storage.getItem(metricMappingStorageKey(model));
      return value === null
        ? emptyDocument(projectIdentity)
        : parseDocument(value, projectIdentity);
    } catch {
      return undefined;
    }
  }

  private write(
    model: CityModel,
    document: MetricMappingStorageDocumentV1,
  ): MetricMappingStorageResult {
    const value = JSON.stringify(document);
    if (
      new TextEncoder().encode(value).byteLength >
      MAXIMUM_METRIC_MAPPING_STORAGE_BYTES
    ) {
      return {
        ok: false,
        message: "The saved metric configurations exceed the storage limit.",
      };
    }
    try {
      this.storage.setItem(metricMappingStorageKey(model), value);
      return { ok: true, message: "Metric configuration saved." };
    } catch {
      return {
        ok: false,
        message:
          "Browser storage is unavailable or full; the configuration was not saved.",
      };
    }
  }
}
