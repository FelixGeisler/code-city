import {
  CITY_MODEL_SCHEMA_VERSION,
  type CityModel,
  type Vector3,
} from "./model.js";
import { isDisplayColor } from "./color.js";
import { normalizeAssetRelativePath } from "./identity.js";
import { normalizeIdentityLogoPrintRelief } from "./logo-relief.js";
import {
  DEFAULT_METRIC_MAPPING,
  normalizeLogarithmically,
  validateMetricMapping as validateMetricMappingContract,
} from "./metrics.js";
import { normalizeRepositoryRelativePath } from "./path.js";

type JsonObject = Record<string, unknown>;

const LANGUAGES = new Set(["csharp", "typescript", "javascript"]);
const RISKS = new Set(["low", "moderate", "high", "very-high"]);
const METRIC_METHODS = new Set([
  "typescript-compiler-api-v1",
  "csharp-lexical-v1",
  "csharp-roslyn-v1",
]);
const METRIC_NORMALIZATION_STATES = new Set([
  "available",
  "clamped",
  "unavailable",
]);
const MODULE_KINDS = new Set([
  "dotnet-project",
  "angular-project",
  "npm-package",
  "unassigned",
]);
const DEPENDENCY_KINDS = new Set([
  "typescript-import",
  "project-reference",
  "package-reference",
]);
const DEPENDENCY_RESOLUTIONS = new Set([
  "internal",
  "external",
  "unresolved",
]);
const UNSAFE_TEXT_CHARACTERS = /[\p{Cc}\p{Cf}\p{Cs}]/u;
const VALIDATION_CHECKPOINT_INTERVAL = 256;

export interface CityModelValidationOptions {
  /**
   * Called at bounded intervals while validating large collections.
   * Throwing aborts validation immediately.
   */
  readonly checkpoint?: () => void;
}

class ValidationCheckpoint {
  #operations = 0;

  public constructor(
    private readonly callback: (() => void) | undefined,
  ) {}

  public checkpoint(): void {
    this.#operations = 0;
    this.callback?.();
  }

  public consume(operations = 1): void {
    if (this.callback === undefined) return;
    this.#operations += operations;
    if (this.#operations < VALIDATION_CHECKPOINT_INTERVAL) return;
    this.#operations %= VALIDATION_CHECKPOINT_INTERVAL;
    this.callback();
  }
}

export const CITY_MODEL_LIMITS = Object.freeze({
  repositories: 1_000,
  solutions: 5_000,
  modules: 10_000,
  semanticGroups: 256,
  districts: 10_000,
  buildings: 25_000,
  dependencies: 100_000,
  referencesPerEntity: 10_000,
  targetFrameworksPerModule: 128,
  metricUnitsPerBuilding: 10_000,
  warnings: 10_000,
  coordinateMagnitude: 1_000_000,
  identifierCharacters: 256,
  displayTextCharacters: 256,
  versionCharacters: 256,
  externalReferenceCharacters: 512,
  warningCharacters: 1_024,
  pathCharacters: 2_048,
  textCharacters: 2_048,
});

export function validateCityModel(
  value: unknown,
  options: CityModelValidationOptions = {},
): CityModel {
  const work = new ValidationCheckpoint(options.checkpoint);
  work.checkpoint();
  const model = objectAt(value, "model");

  if (model.schemaVersion !== CITY_MODEL_SCHEMA_VERSION) {
    fail(
      `schemaVersion must be "${CITY_MODEL_SCHEMA_VERSION}", received ${describe(
        model.schemaVersion,
      )}`,
    );
  }

  const generator = objectAt(model.generator, "generator");
  if (generator.name !== "code-city") {
    fail('generator.name must be "code-city"');
  }
  nonEmptyString(
    generator.version,
    "generator.version",
    CITY_MODEL_LIMITS.versionCharacters,
  );

  const repositories = objectArray(
    model.repositories,
    "repositories",
    CITY_MODEL_LIMITS.repositories,
    work,
  );
  const solutions = objectArray(
    model.solutions,
    "solutions",
    CITY_MODEL_LIMITS.solutions,
    work,
  );
  const modules = objectArray(
    model.modules,
    "modules",
    CITY_MODEL_LIMITS.modules,
    work,
  );
  const semanticGroups = objectArray(
    model.semanticGroups,
    "semanticGroups",
    CITY_MODEL_LIMITS.semanticGroups,
    work,
  );
  const districts = objectArray(
    model.districts,
    "districts",
    CITY_MODEL_LIMITS.districts,
    work,
  );
  const buildings = objectArray(
    model.buildings,
    "buildings",
    CITY_MODEL_LIMITS.buildings,
    work,
  );
  const dependencies = objectArray(
    model.dependencies,
    "dependencies",
    CITY_MODEL_LIMITS.dependencies,
    work,
  );

  const repositoryIds = validateIds(repositories, "repositories", work);
  const solutionIds = validateIds(solutions, "solutions", work);
  const moduleIds = validateIds(modules, "modules", work);
  const groupIds = validateIds(semanticGroups, "semanticGroups", work);
  const districtIds = validateIds(districts, "districts", work);
  const buildingIds = validateIds(buildings, "buildings", work);
  validateIds(dependencies, "dependencies", work);
  const solutionsById = entitiesById(solutions, work);
  const modulesById = entitiesById(modules, work);
  const districtsById = entitiesById(districts, work);
  const buildingsById = entitiesById(buildings, work);

  repositories.forEach((repository, index) => {
    work.consume();
    nonEmptyString(
      repository.name,
      `repositories[${index}].name`,
      CITY_MODEL_LIMITS.displayTextCharacters,
    );
  });

  solutions.forEach((solution, index) => {
    work.consume();
    const prefix = `solutions[${index}]`;
    const repositoryId = reference(
      solution.repositoryId,
      repositoryIds,
      `${prefix}.repositoryId`,
    );
    nonEmptyString(
      solution.name,
      `${prefix}.name`,
      CITY_MODEL_LIMITS.displayTextCharacters,
    );
    repositoryRelativePath(solution.path, `${prefix}.path`);
    const referencedModuleIds = referenceArray(
      solution.moduleIds,
      moduleIds,
      `${prefix}.moduleIds`,
      CITY_MODEL_LIMITS.referencesPerEntity,
      work,
    );
    referencedModuleIds.forEach((moduleId, moduleIndex) => {
      work.consume();
      if (modulesById.get(moduleId)!.repositoryId !== repositoryId) {
        fail(
          `${prefix}.moduleIds[${moduleIndex}] must reference a module in the same repository`,
        );
      }
    });
  });

  modules.forEach((module, index) => {
    work.consume();
    const prefix = `modules[${index}]`;
    const repositoryId = reference(
      module.repositoryId,
      repositoryIds,
      `${prefix}.repositoryId`,
    );
    const parentModuleId = optionalReference(
      module.parentModuleId,
      moduleIds,
      `${prefix}.parentModuleId`,
    );
    if (
      parentModuleId !== undefined &&
      modulesById.get(parentModuleId)!.repositoryId !== repositoryId
    ) {
      fail(
        `${prefix}.parentModuleId must reference a module in the same repository`,
      );
    }
    enumValue(module.kind, MODULE_KINDS, `${prefix}.kind`);
    nonEmptyString(
      module.name,
      `${prefix}.name`,
      CITY_MODEL_LIMITS.displayTextCharacters,
    );
    repositoryRelativePath(module.path, `${prefix}.path`);
    const referencedSolutionIds = referenceArray(
      module.solutionIds,
      solutionIds,
      `${prefix}.solutionIds`,
      CITY_MODEL_LIMITS.referencesPerEntity,
      work,
    );
    referencedSolutionIds.forEach((solutionId, solutionIndex) => {
      work.consume();
      if (solutionsById.get(solutionId)!.repositoryId !== repositoryId) {
        fail(
          `${prefix}.solutionIds[${solutionIndex}] must reference a solution in the same repository`,
        );
      }
    });
    optionalStringArray(
      module.targetFrameworks,
      `${prefix}.targetFrameworks`,
      CITY_MODEL_LIMITS.targetFrameworksPerModule,
      CITY_MODEL_LIMITS.externalReferenceCharacters,
      work,
    );
    optionalString(
      module.packageId,
      `${prefix}.packageId`,
      CITY_MODEL_LIMITS.externalReferenceCharacters,
    );
  });

  semanticGroups.forEach((group, index) => {
    work.consume();
    const prefix = `semanticGroups[${index}]`;
    nonEmptyString(
      group.label,
      `${prefix}.label`,
      CITY_MODEL_LIMITS.displayTextCharacters,
    );
    const color = nonEmptyString(group.color, `${prefix}.color`);
    if (!isDisplayColor(color)) {
      fail(`${prefix}.color must be a #RRGGBB or #RRGGBBAA color`);
    }
    finiteNumber(group.priority, `${prefix}.priority`);
    optionalReference(group.mergeInto, groupIds, `${prefix}.mergeInto`);
  });

  if (model.metricMapping !== undefined) {
    validateMetricMappingContract(model.metricMapping, "metricMapping");
  }
  validateAnalysis(model.analysis, work);
  validateSourceProvenance(model.sourceProvenance, repositoryIds, work);
  validateIdentity(model.identity, repositoryIds, work);
  const identityPanel = validateIdentityPanel(model.identityPanel, groupIds);
  const base = validateCityBase(model.base, groupIds);

  districts.forEach((district, index) => {
    work.consume();
    const prefix = `districts[${index}]`;
    reference(
      district.repositoryId,
      repositoryIds,
      `${prefix}.repositoryId`,
    );
    reference(district.moduleId, moduleIds, `${prefix}.moduleId`);
    const referencedModule = modulesById.get(district.moduleId as string)!;
    if (referencedModule.repositoryId !== district.repositoryId) {
      fail(
        `${prefix}.repositoryId must match its referenced module repository`,
      );
    }
    nonEmptyString(
      district.name,
      `${prefix}.name`,
      CITY_MODEL_LIMITS.displayTextCharacters,
    );
    repositoryRelativePath(district.path, `${prefix}.path`);
    vector(district.position, `${prefix}.position`, false);
    vector(district.size, `${prefix}.size`, true);
  });

  buildings.forEach((building, index) => {
    work.consume();
    const prefix = `buildings[${index}]`;
    reference(
      building.repositoryId,
      repositoryIds,
      `${prefix}.repositoryId`,
    );
    reference(building.moduleId, moduleIds, `${prefix}.moduleId`);
    reference(building.districtId, districtIds, `${prefix}.districtId`);
    const referencedDistrict = districtsById.get(
      building.districtId as string,
    )!;
    const referencedModule = modulesById.get(building.moduleId as string)!;
    if (
      referencedDistrict.repositoryId !== building.repositoryId ||
      referencedDistrict.moduleId !== building.moduleId ||
      referencedModule.repositoryId !== building.repositoryId
    ) {
      fail(
        `${prefix} repository/module ownership must match its referenced district and module`,
      );
    }
    reference(
      building.semanticGroupId,
      groupIds,
      `${prefix}.semanticGroupId`,
    );
    nonEmptyString(
      building.name,
      `${prefix}.name`,
      CITY_MODEL_LIMITS.displayTextCharacters,
    );
    repositoryRelativePath(building.path, `${prefix}.path`);
    enumValue(building.language, LANGUAGES, `${prefix}.language`);
    enumValue(building.risk, RISKS, `${prefix}.risk`);
    vector(building.position, `${prefix}.position`, false);
    vector(building.size, `${prefix}.size`, true);

    const metrics = objectAt(building.metrics, `${prefix}.metrics`);
    nonNegativeInteger(metrics.sloc, `${prefix}.metrics.sloc`);
    nonNegativeInteger(
      metrics.decisionLoad,
      `${prefix}.metrics.decisionLoad`,
    );
    positiveInteger(
      metrics.maximumComplexity,
      `${prefix}.metrics.maximumComplexity`,
    );
    nonNegativeInteger(
      metrics.executableUnitCount,
      `${prefix}.metrics.executableUnitCount`,
    );
    const sourceEndLine = validateSourceLocation(
      building.sourceLocation,
      prefix,
    );
    validateBuildingMetricDetails(
      building.metricMethod,
      building.units,
      metrics,
      prefix,
      work,
      sourceEndLine,
    );
    validateBuildingMetricNormalization(
      building.metricNormalization,
      metrics,
      prefix,
    );
  });

  dependencies.forEach((dependency, index) => {
    work.consume();
    const prefix = `dependencies[${index}]`;
    const repositoryId = reference(
      dependency.repositoryId,
      repositoryIds,
      `${prefix}.repositoryId`,
    );
    const kind = enumValue(
      dependency.kind,
      DEPENDENCY_KINDS,
      `${prefix}.kind`,
    );
    const dependencyNodeIds =
      kind === "typescript-import" ? buildingIds : moduleIds;
    const dependencyNodes =
      kind === "typescript-import" ? buildingsById : modulesById;
    const sourceId = reference(
      dependency.sourceId,
      dependencyNodeIds,
      `${prefix}.sourceId`,
    );
    if (dependencyNodes.get(sourceId)!.repositoryId !== repositoryId) {
      fail(
        `${prefix}.repositoryId must match its source repository`,
      );
    }
    optionalReference(
      dependency.targetId,
      dependencyNodeIds,
      `${prefix}.targetId`,
    );
    optionalNonEmptyString(
      dependency.externalTarget,
      `${prefix}.externalTarget`,
      CITY_MODEL_LIMITS.externalReferenceCharacters,
    );
    optionalString(
      dependency.version,
      `${prefix}.version`,
      CITY_MODEL_LIMITS.versionCharacters,
    );
    positiveNumber(dependency.weight, `${prefix}.weight`);

    const hasInternal = dependency.targetId !== undefined;
    const hasExternal = dependency.externalTarget !== undefined;
    if (hasInternal === hasExternal) {
      fail(
        `${prefix} must define exactly one of targetId or externalTarget`,
      );
    }
    const resolution =
      dependency.resolution === undefined
        ? hasInternal
          ? "internal"
          : "external"
        : enumValue(
            dependency.resolution,
            DEPENDENCY_RESOLUTIONS,
            `${prefix}.resolution`,
          );
    if (resolution === "internal" && !hasInternal) {
      fail(`${prefix}.resolution "internal" requires targetId`);
    }
    if (resolution !== "internal" && !hasExternal) {
      fail(
        `${prefix}.resolution "${resolution}" requires externalTarget`,
      );
    }
  });

  const bounds = vector(model.bounds, "bounds", false);
  if (bounds.x < 0 || bounds.y < 0 || bounds.z < 0) {
    fail("bounds components must be non-negative");
  }
  if (base !== undefined) {
    validateSharedGeometry(
      base,
      identityPanel,
      districts,
      buildings,
      bounds,
      work,
    );
  }
  work.checkpoint();
  return model as unknown as CityModel;
}

function validateAnalysis(
  value: unknown,
  work: ValidationCheckpoint,
): void {
  if (value === undefined) return;
  const analysis = objectAt(value, "analysis");
  if (!Array.isArray(analysis.warnings)) {
    fail("analysis.warnings must be an array");
  }
  if (analysis.warnings.length > CITY_MODEL_LIMITS.warnings) {
    fail(
      `analysis.warnings must contain at most ${CITY_MODEL_LIMITS.warnings} items`,
    );
  }
  analysis.warnings.forEach((warning, index) => {
    work.consume();
    nonEmptyString(
      warning,
      `analysis.warnings[${index}]`,
      CITY_MODEL_LIMITS.warningCharacters,
    );
  });
}

function validateBuildingMetricNormalization(
  value: unknown,
  metrics: JsonObject,
  prefix: string,
): void {
  if (value === undefined) return;
  const normalization = objectAt(
    value,
    `${prefix}.metricNormalization`,
  );
  validateNormalizedMetric(
    normalization.sloc,
    metrics.sloc as number,
    DEFAULT_METRIC_MAPPING.normalizationCaps.sloc,
    `${prefix}.metricNormalization.sloc`,
  );
  validateNormalizedMetric(
    normalization.decisionLoad,
    metrics.decisionLoad as number,
    DEFAULT_METRIC_MAPPING.normalizationCaps.decisionLoad,
    `${prefix}.metricNormalization.decisionLoad`,
  );
}

function validateNormalizedMetric(
  value: unknown,
  rawValue: number,
  cap: number,
  path: string,
): void {
  const normalized = objectAt(value, path);
  const state = enumValue(
    normalized.state,
    METRIC_NORMALIZATION_STATES,
    `${path}.state`,
  );
  if (state === "unavailable") {
    if (normalized.normalizedValue !== undefined) {
      fail(`${path}.normalizedValue must be omitted when unavailable`);
    }
    return;
  }

  const normalizedValue = finiteNumber(
    normalized.normalizedValue,
    `${path}.normalizedValue`,
  );
  if (normalizedValue < 0 || normalizedValue > 1) {
    fail(`${path}.normalizedValue must be between 0 and 1`);
  }
  const expectedState = rawValue > cap ? "clamped" : "available";
  if (state !== expectedState) {
    fail(
      `${path}.state must be "${expectedState}" for raw value ${rawValue}`,
    );
  }
  const expectedValue = normalizeLogarithmically(rawValue, cap);
  if (Math.abs(normalizedValue - expectedValue) > 1e-12) {
    fail(
      `${path}.normalizedValue must match ${DEFAULT_METRIC_MAPPING.formulas.normalization}`,
    );
  }
}

function validateBuildingMetricDetails(
  methodValue: unknown,
  unitsValue: unknown,
  aggregate: JsonObject,
  prefix: string,
  work: ValidationCheckpoint,
  sourceEndLine?: number,
): void {
  if (methodValue === undefined && unitsValue === undefined) return;
  if (methodValue === undefined || unitsValue === undefined) {
    fail(`${prefix}.metricMethod and ${prefix}.units must be supplied together`);
  }

  enumValue(methodValue, METRIC_METHODS, `${prefix}.metricMethod`);
  const units = objectArray(
    unitsValue,
    `${prefix}.units`,
    CITY_MODEL_LIMITS.metricUnitsPerBuilding,
    work,
  );
  units.forEach((unit, index) => {
    work.consume();
    const unitPrefix = `${prefix}.units[${index}]`;
    nonEmptyString(
      unit.name,
      `${unitPrefix}.name`,
      CITY_MODEL_LIMITS.displayTextCharacters,
    );
    const line = positiveInteger(unit.line, `${unitPrefix}.line`);
    const endLine =
      unit.endLine === undefined
        ? line
        : positiveInteger(unit.endLine, `${unitPrefix}.endLine`);
    if (endLine < line) {
      fail(`${unitPrefix}.endLine must not precede line`);
    }
    if (sourceEndLine !== undefined && endLine > sourceEndLine) {
      fail(`${unitPrefix} must remain inside the building source location`);
    }
    positiveInteger(unit.complexity, `${unitPrefix}.complexity`);
  });
  if (units.length !== aggregate.executableUnitCount) {
    fail(
      `${prefix}.units length must equal metrics.executableUnitCount`,
    );
  }
  let maximum = Number.NEGATIVE_INFINITY;
  for (const unit of units) {
    work.consume();
    maximum = Math.max(maximum, unit.complexity as number);
  }
  if (maximum !== aggregate.maximumComplexity) {
    fail(`${prefix}.units must preserve metrics.maximumComplexity`);
  }
}

function validateIdentity(
  value: unknown,
  repositoryIds: Set<string>,
  work: ValidationCheckpoint,
): void {
  if (value === undefined) {
    return;
  }

  const identity = objectAt(value, "identity");
  nonEmptyString(identity.title, "identity.title", 160);
  optionalNonEmptyString(identity.version, "identity.version", 80);
  validateLogo(identity.logo, "identity.logo");

  if (identity.repositories !== undefined) {
    const repositories = objectArray(
      identity.repositories,
      "identity.repositories",
      CITY_MODEL_LIMITS.repositories,
      work,
    );
    const seen = new Set<string>();
    repositories.forEach((repository, index) => {
      work.consume();
      const prefix = `identity.repositories[${index}]`;
      const repositoryId = nonEmptyString(
        repository.repositoryId,
        `${prefix}.repositoryId`,
        CITY_MODEL_LIMITS.identifierCharacters,
      );
      if (!repositoryIds.has(repositoryId)) {
        fail(`${prefix}.repositoryId references an unknown id`);
      }
      if (seen.has(repositoryId)) {
        fail(`${prefix}.repositoryId is duplicated`);
      }
      seen.add(repositoryId);
      optionalNonEmptyString(repository.title, `${prefix}.title`, 160);
      optionalNonEmptyString(repository.version, `${prefix}.version`, 80);
      validateLogo(repository.logo, `${prefix}.logo`);
    });
  }
}

function validateLogo(value: unknown, path: string): void {
  if (value === undefined) {
    return;
  }
  const logo = objectAt(value, path);
  const relativePath = nonEmptyString(
    logo.relativePath,
    `${path}.relativePath`,
  );
  let normalizedPath: string;
  try {
    normalizedPath = normalizeAssetRelativePath(relativePath);
  } catch {
    fail(`${path}.relativePath must be a normalized repository-relative path`);
  }
  if (normalizedPath !== relativePath) {
    fail(`${path}.relativePath must be a normalized repository-relative path`);
  }
  const format = enumValue(
    logo.format,
    new Set(["svg", "png"]),
    `${path}.format`,
  );
  if (!relativePath.toLowerCase().endsWith(`.${format}`)) {
    fail(`${path}.relativePath must use the .${format} extension`);
  }
  optionalNonEmptyString(logo.alt, `${path}.alt`, 160);
  if (logo.printRelief !== undefined) {
    try {
      normalizeIdentityLogoPrintRelief(logo.printRelief);
    } catch (error) {
      fail(
        `${path}.printRelief is invalid: ${
          error instanceof Error ? error.message : "Invalid value."
        }`,
      );
    }
  }
}

function validateSourceLocation(
  value: unknown,
  prefix: string,
): number | undefined {
  if (value === undefined) return undefined;
  const location = objectAt(value, `${prefix}.sourceLocation`);
  const startLine = positiveInteger(
    location.startLine,
    `${prefix}.sourceLocation.startLine`,
  );
  const endLine = positiveInteger(
    location.endLine,
    `${prefix}.sourceLocation.endLine`,
  );
  if (startLine !== 1) {
    fail(`${prefix}.sourceLocation.startLine must be 1`);
  }
  if (endLine < startLine) {
    fail(`${prefix}.sourceLocation.endLine must not precede startLine`);
  }
  return endLine;
}

function validateSourceProvenance(
  value: unknown,
  repositoryIds: Set<string>,
  work: ValidationCheckpoint,
): void {
  if (value === undefined) return;
  const provenance = objectAt(value, "sourceProvenance");
  if (provenance.version !== "codecity.source-navigation/1") {
    fail(
      'sourceProvenance.version must be "codecity.source-navigation/1"',
    );
  }
  const repositories = objectArray(
    provenance.repositories,
    "sourceProvenance.repositories",
    CITY_MODEL_LIMITS.repositories,
    work,
  );
  if (repositories.length === 0) {
    fail("sourceProvenance.repositories must not be empty");
  }
  const seen = new Set<string>();
  repositories.forEach((repository, index) => {
    work.consume();
    const prefix = `sourceProvenance.repositories[${index}]`;
    const repositoryId = reference(
      repository.repositoryId,
      repositoryIds,
      `${prefix}.repositoryId`,
    );
    if (seen.has(repositoryId)) {
      fail(`${prefix}.repositoryId is duplicated`);
    }
    seen.add(repositoryId);
    const provider = enumValue(
      repository.provider,
      new Set([
        "azure-devops",
        "generic-git",
        "github",
        "uploaded-archive",
      ]),
      `${prefix}.provider`,
    );
    const revision = objectAt(
      repository.revision,
      `${prefix}.revision`,
    );
    if (revision.kind === "commit") {
      const commit = nonEmptyString(
        revision.value,
        `${prefix}.revision.value`,
        64,
      );
      if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(commit)) {
        fail(`${prefix}.revision.value must be an immutable commit SHA`);
      }
    } else if (revision.kind === "snapshot") {
      const snapshot = nonEmptyString(
        revision.value,
        `${prefix}.revision.value`,
        71,
      );
      if (!/^sha256:[0-9a-f]{64}$/u.test(snapshot)) {
        fail(`${prefix}.revision.value must be a SHA-256 snapshot digest`);
      }
    } else {
      fail(`${prefix}.revision.kind is invalid`);
    }
    if (
      (provider === "uploaded-archive" &&
        revision.kind !== "snapshot") ||
      (provider !== "uploaded-archive" &&
        revision.kind !== "commit")
    ) {
      fail(
        `${prefix}.revision.kind does not match its source provider`,
      );
    }
    if (repository.repositoryUrl === undefined) {
      if (provider !== "uploaded-archive") {
        fail(`${prefix}.repositoryUrl is required for remote provenance`);
      }
      return;
    }
    if (provider === "uploaded-archive") {
      fail(`${prefix}.repositoryUrl must be omitted for uploaded archives`);
    }
    const repositoryUrl = nonEmptyString(
      repository.repositoryUrl,
      `${prefix}.repositoryUrl`,
      2_048,
    );
    let parsed: URL;
    try {
      parsed = new URL(repositoryUrl);
    } catch {
      fail(`${prefix}.repositoryUrl must be an absolute URL`);
    }
    if (
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.hash !== "" ||
      parsed.search !== ""
    ) {
      fail(`${prefix}.repositoryUrl must be credential-free`);
    }
    if (
      (provider === "github" &&
        (parsed.protocol !== "https:" ||
          parsed.hostname.toLowerCase() !== "github.com")) ||
      (provider === "azure-devops" &&
        parsed.protocol !== "https:") ||
      (provider === "generic-git" &&
        parsed.protocol !== "https:" &&
        parsed.protocol !== "ssh:")
    ) {
      fail(
        `${prefix}.repositoryUrl scheme or host does not match its provider`,
      );
    }
  });
}

function validateIdentityPanel(
  value: unknown,
  groupIds: Set<string>,
): JsonObject | undefined {
  if (value === undefined) {
    return undefined;
  }
  const panel = objectAt(value, "identityPanel");
  nonEmptyString(panel.id, "identityPanel.id");
  if (panel.edge !== "front") {
    fail('identityPanel.edge must be "front"');
  }
  if (panel.semanticGroupId !== "identity") {
    fail('identityPanel.semanticGroupId must be "identity"');
  }
  reference(panel.semanticGroupId, groupIds, "identityPanel.semanticGroupId");
  vector(panel.position, "identityPanel.position", false);
  vector(panel.size, "identityPanel.size", true);
  if (panel.relief !== "embossed") {
    fail('identityPanel.relief must be "embossed"');
  }
  positiveNumber(panel.reliefDepth, "identityPanel.reliefDepth");
  return panel;
}

function validateCityBase(
  value: unknown,
  groupIds: Set<string>,
): JsonObject | undefined {
  if (value === undefined) {
    return undefined;
  }
  const base = objectAt(value, "base");
  nonEmptyString(base.id, "base.id");
  if (base.semanticGroupId !== "base") {
    fail('base.semanticGroupId must be "base"');
  }
  reference(base.semanticGroupId, groupIds, "base.semanticGroupId");
  vector(base.position, "base.position", false);
  vector(base.size, "base.size", true);
  return base;
}

interface GeometryBox {
  readonly minimumX: number;
  readonly maximumX: number;
  readonly minimumY: number;
  readonly maximumY: number;
  readonly minimumZ: number;
  readonly maximumZ: number;
}

const GEOMETRY_EPSILON = 1e-9;

function validateSharedGeometry(
  base: JsonObject,
  identityPanel: JsonObject | undefined,
  districts: readonly JsonObject[],
  buildings: readonly JsonObject[],
  bounds: Vector3,
  work: ValidationCheckpoint,
): void {
  const baseSize = vector(base.size, "base.size", true);
  if (
    !nearlyEqual(baseSize.x, bounds.x) ||
    !nearlyEqual(baseSize.z, bounds.z)
  ) {
    fail("base.size.x/z must equal bounds.x/z");
  }

  const baseBox = geometryBox(base, "base");
  const districtBoxes = new Map<string, GeometryBox>();
  districts.forEach((district, index) => {
    work.consume();
    const path = `districts[${index}]`;
    const box = geometryBox(district, path);
    districtBoxes.set(nonEmptyString(district.id, `${path}.id`), box);
    validateBaseSupport(baseBox, box, path);
  });

  if (identityPanel !== undefined) {
    const reliefDepth = positiveNumber(
      identityPanel.reliefDepth,
      "identityPanel.reliefDepth",
    );
    const panelBox = geometryBox(
      identityPanel,
      "identityPanel",
      reliefDepth,
    );
    validateBaseSupport(baseBox, panelBox, "identityPanel and its relief");
  }

  buildings.forEach((building, index) => {
    work.consume();
    const path = `buildings[${index}]`;
    const districtId = nonEmptyString(
      building.districtId,
      `${path}.districtId`,
    );
    const districtBox = districtBoxes.get(districtId)!;
    const buildingBox = geometryBox(building, path);
    if (!coversHorizontally(districtBox, buildingBox)) {
      fail(`${path} must be horizontally contained by its referenced district`);
    }
    if (!nearlyEqual(buildingBox.minimumY, districtBox.maximumY)) {
      fail(`${path} must rest on its referenced district`);
    }
  });
}

function validateBaseSupport(
  base: GeometryBox,
  supported: GeometryBox,
  path: string,
): void {
  if (!coversHorizontally(base, supported)) {
    fail(`base must horizontally cover ${path}`);
  }
  if (
    base.minimumY > supported.minimumY + GEOMETRY_EPSILON ||
    base.maximumY <= supported.minimumY + GEOMETRY_EPSILON ||
    base.maximumY >= supported.maximumY - GEOMETRY_EPSILON
  ) {
    fail(`base must overlap ${path} from below and leave it raised`);
  }
}

function geometryBox(
  value: JsonObject,
  path: string,
  frontReliefDepth = 0,
): GeometryBox {
  const position = vector(value.position, `${path}.position`, false);
  const size = vector(value.size, `${path}.size`, true);
  return {
    minimumX: position.x - size.x / 2,
    maximumX: position.x + size.x / 2,
    minimumY: position.y - size.y / 2,
    maximumY: position.y + size.y / 2,
    minimumZ: position.z - size.z / 2 - frontReliefDepth,
    maximumZ: position.z + size.z / 2,
  };
}

function coversHorizontally(
  outer: GeometryBox,
  inner: GeometryBox,
): boolean {
  return (
    outer.minimumX <= inner.minimumX + GEOMETRY_EPSILON &&
    outer.maximumX >= inner.maximumX - GEOMETRY_EPSILON &&
    outer.minimumZ <= inner.minimumZ + GEOMETRY_EPSILON &&
    outer.maximumZ >= inner.maximumZ - GEOMETRY_EPSILON
  );
}

function nearlyEqual(left: number, right: number): boolean {
  const scale = Math.max(1, Math.abs(left), Math.abs(right));
  return Math.abs(left - right) <= GEOMETRY_EPSILON * scale;
}

function objectAt(value: unknown, path: string): JsonObject {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    fail(`${path} must be an object`);
  }
  return value as JsonObject;
}

function objectArray(
  value: unknown,
  path: string,
  maximumLength: number,
  work?: ValidationCheckpoint,
): JsonObject[] {
  if (!Array.isArray(value)) {
    fail(`${path} must be an array`);
  }
  if (value.length > maximumLength) {
    fail(`${path} must contain at most ${maximumLength} items`);
  }
  return value.map((item, index) => {
    work?.consume();
    return objectAt(item, `${path}[${index}]`);
  });
}

function validateIds(
  items: JsonObject[],
  path: string,
  work: ValidationCheckpoint,
): Set<string> {
  const ids = new Set<string>();
  items.forEach((item, index) => {
    work.consume();
    const id = nonEmptyString(
      item.id,
      `${path}[${index}].id`,
      CITY_MODEL_LIMITS.identifierCharacters,
    );
    if (ids.has(id)) {
      fail(`${path}[${index}].id is duplicated`);
    }
    ids.add(id);
  });
  return ids;
}

function entitiesById(
  items: readonly JsonObject[],
  work: ValidationCheckpoint,
): Map<string, JsonObject> {
  const result = new Map<string, JsonObject>();
  for (const item of items) {
    work.consume();
    result.set(item.id as string, item);
  }
  return result;
}

function reference(value: unknown, ids: Set<string>, path: string): string {
  const id = nonEmptyString(
    value,
    path,
    CITY_MODEL_LIMITS.identifierCharacters,
  );
  if (!ids.has(id)) {
    fail(`${path} references an unknown id`);
  }
  return id;
}

function optionalReference(
  value: unknown,
  ids: Set<string>,
  path: string,
): string | undefined {
  return value === undefined ? undefined : reference(value, ids, path);
}

function referenceArray(
  value: unknown,
  ids: Set<string>,
  path: string,
  maximumLength: number,
  work: ValidationCheckpoint,
): readonly string[] {
  if (!Array.isArray(value)) {
    fail(`${path} must be an array`);
  }
  if (value.length > maximumLength) {
    fail(`${path} must contain at most ${maximumLength} items`);
  }
  return value.map((item, index) => {
    work.consume();
    return reference(item, ids, `${path}[${index}]`);
  });
}

function optionalStringArray(
  value: unknown,
  path: string,
  maximumLength: number,
  maximumItemLength: number = CITY_MODEL_LIMITS.textCharacters,
  work?: ValidationCheckpoint,
): void {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    fail(`${path} must be an array`);
  }
  if (value.length > maximumLength) {
    fail(`${path} must contain at most ${maximumLength} items`);
  }
  value.forEach((item, index) => {
    work?.consume();
    nonEmptyString(item, `${path}[${index}]`, maximumItemLength);
  });
}

function vector(value: unknown, path: string, positive: boolean): Vector3 {
  const item = objectAt(value, path);
  const x = finiteNumber(item.x, `${path}.x`);
  const y = finiteNumber(item.y, `${path}.y`);
  const z = finiteNumber(item.z, `${path}.z`);
  if (
    Math.abs(x) > CITY_MODEL_LIMITS.coordinateMagnitude ||
    Math.abs(y) > CITY_MODEL_LIMITS.coordinateMagnitude ||
    Math.abs(z) > CITY_MODEL_LIMITS.coordinateMagnitude
  ) {
    fail(
      `${path} components must not exceed ${CITY_MODEL_LIMITS.coordinateMagnitude} model units`,
    );
  }
  if (positive && (x <= 0 || y <= 0 || z <= 0)) {
    fail(`${path} components must be greater than zero`);
  }
  return { x, y, z };
}

function enumValue(
  value: unknown,
  allowed: ReadonlySet<string>,
  path: string,
): string {
  const item = nonEmptyString(value, path);
  if (!allowed.has(item)) {
    fail(`${path} has an unsupported value`);
  }
  return item;
}

function optionalString(
  value: unknown,
  path: string,
  maximumLength: number = CITY_MODEL_LIMITS.textCharacters,
): void {
  if (value !== undefined) {
    stringAt(value, path, maximumLength);
  }
}

function optionalNonEmptyString(
  value: unknown,
  path: string,
  maximumLength: number = CITY_MODEL_LIMITS.textCharacters,
): void {
  if (value !== undefined) {
    nonEmptyString(value, path, maximumLength);
  }
}

function stringAt(
  value: unknown,
  path: string,
  maximumLength: number = CITY_MODEL_LIMITS.textCharacters,
): string {
  if (typeof value !== "string") {
    fail(`${path} must be a string`);
  }
  if (value.length > maximumLength) {
    fail(`${path} must not exceed ${maximumLength} characters`);
  }
  if (UNSAFE_TEXT_CHARACTERS.test(value)) {
    fail(`${path} must not contain control or formatting characters`);
  }
  return value;
}

function repositoryRelativePath(value: unknown, path: string): string {
  const item = stringAt(value, path, CITY_MODEL_LIMITS.pathCharacters);
  let normalized: string;
  try {
    normalized = normalizeRepositoryRelativePath(item);
  } catch {
    fail(`${path} must be a normalized repository-relative path`);
  }
  if (normalized !== item) {
    fail(`${path} must be a normalized repository-relative path`);
  }
  return normalized;
}

function nonEmptyString(
  value: unknown,
  path: string,
  maximumLength: number = CITY_MODEL_LIMITS.textCharacters,
): string {
  const item = stringAt(value, path, maximumLength);
  if (item.trim().length === 0) {
    fail(`${path} must not be empty`);
  }
  return item;
}

function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(`${path} must be a finite number`);
  }
  return value;
}

function positiveNumber(value: unknown, path: string): number {
  const item = finiteNumber(value, path);
  if (item <= 0) {
    fail(`${path} must be greater than zero`);
  }
  return item;
}

function nonNegativeInteger(value: unknown, path: string): number {
  const item = finiteNumber(value, path);
  if (!Number.isInteger(item) || item < 0) {
    fail(`${path} must be a non-negative integer`);
  }
  return item;
}

function positiveInteger(value: unknown, path: string): number {
  const item = finiteNumber(value, path);
  if (!Number.isInteger(item) || item < 1) {
    fail(`${path} must be a positive integer`);
  }
  return item;
}

function describe(value: unknown): string {
  if (typeof value === "string") {
    return "a string";
  }
  if (value === undefined) {
    return "undefined";
  }
  return JSON.stringify(value);
}

function fail(message: string): never {
  throw new Error(message);
}
