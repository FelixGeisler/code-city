import {
  CITY_MODEL_SCHEMA_VERSION,
  type CityModel,
  type Vector3,
} from "../../../packages/core/src/model.js";
import { normalizeAssetRelativePath } from "../../../packages/core/src/identity.js";

type JsonObject = Record<string, unknown>;

const LANGUAGES = new Set(["csharp", "typescript", "javascript"]);
const RISKS = new Set(["low", "moderate", "high", "very-high"]);
const METRIC_METHODS = new Set([
  "typescript-compiler-api-v1",
  "csharp-lexical-v1",
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
});

export function validateCityModel(value: unknown): CityModel {
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
  nonEmptyString(generator.version, "generator.version");

  const repositories = objectArray(
    model.repositories,
    "repositories",
    CITY_MODEL_LIMITS.repositories,
  );
  const solutions = objectArray(
    model.solutions,
    "solutions",
    CITY_MODEL_LIMITS.solutions,
  );
  const modules = objectArray(
    model.modules,
    "modules",
    CITY_MODEL_LIMITS.modules,
  );
  const semanticGroups = objectArray(
    model.semanticGroups,
    "semanticGroups",
    CITY_MODEL_LIMITS.semanticGroups,
  );
  const districts = objectArray(
    model.districts,
    "districts",
    CITY_MODEL_LIMITS.districts,
  );
  const buildings = objectArray(
    model.buildings,
    "buildings",
    CITY_MODEL_LIMITS.buildings,
  );
  const dependencies = objectArray(
    model.dependencies,
    "dependencies",
    CITY_MODEL_LIMITS.dependencies,
  );

  const repositoryIds = validateIds(repositories, "repositories");
  const solutionIds = validateIds(solutions, "solutions");
  const moduleIds = validateIds(modules, "modules");
  const groupIds = validateIds(semanticGroups, "semanticGroups");
  const districtIds = validateIds(districts, "districts");
  const buildingIds = validateIds(buildings, "buildings");
  validateIds(dependencies, "dependencies");

  repositories.forEach((repository, index) => {
    nonEmptyString(repository.name, `repositories[${index}].name`);
  });

  solutions.forEach((solution, index) => {
    const prefix = `solutions[${index}]`;
    reference(solution.repositoryId, repositoryIds, `${prefix}.repositoryId`);
    nonEmptyString(solution.name, `${prefix}.name`);
    stringAt(solution.path, `${prefix}.path`);
    referenceArray(
      solution.moduleIds,
      moduleIds,
      `${prefix}.moduleIds`,
      CITY_MODEL_LIMITS.referencesPerEntity,
    );
  });

  modules.forEach((module, index) => {
    const prefix = `modules[${index}]`;
    reference(module.repositoryId, repositoryIds, `${prefix}.repositoryId`);
    optionalReference(
      module.parentModuleId,
      moduleIds,
      `${prefix}.parentModuleId`,
    );
    enumValue(module.kind, MODULE_KINDS, `${prefix}.kind`);
    nonEmptyString(module.name, `${prefix}.name`);
    stringAt(module.path, `${prefix}.path`);
    referenceArray(
      module.solutionIds,
      solutionIds,
      `${prefix}.solutionIds`,
      CITY_MODEL_LIMITS.referencesPerEntity,
    );
    optionalStringArray(
      module.targetFrameworks,
      `${prefix}.targetFrameworks`,
      CITY_MODEL_LIMITS.targetFrameworksPerModule,
    );
    optionalString(module.packageId, `${prefix}.packageId`);
  });

  semanticGroups.forEach((group, index) => {
    const prefix = `semanticGroups[${index}]`;
    nonEmptyString(group.label, `${prefix}.label`);
    const color = nonEmptyString(group.color, `${prefix}.color`);
    if (!validColor(color)) {
      fail(`${prefix}.color is not a valid CSS color`);
    }
    finiteNumber(group.priority, `${prefix}.priority`);
    optionalReference(group.mergeInto, groupIds, `${prefix}.mergeInto`);
  });

  validateAnalysis(model.analysis);
  validateIdentity(model.identity, repositoryIds);
  const identityPanel = validateIdentityPanel(model.identityPanel, groupIds);
  const base = validateCityBase(model.base, groupIds);

  districts.forEach((district, index) => {
    const prefix = `districts[${index}]`;
    reference(
      district.repositoryId,
      repositoryIds,
      `${prefix}.repositoryId`,
    );
    reference(district.moduleId, moduleIds, `${prefix}.moduleId`);
    nonEmptyString(district.name, `${prefix}.name`);
    stringAt(district.path, `${prefix}.path`);
    vector(district.position, `${prefix}.position`, false);
    vector(district.size, `${prefix}.size`, true);
  });

  buildings.forEach((building, index) => {
    const prefix = `buildings[${index}]`;
    reference(
      building.repositoryId,
      repositoryIds,
      `${prefix}.repositoryId`,
    );
    reference(building.moduleId, moduleIds, `${prefix}.moduleId`);
    reference(building.districtId, districtIds, `${prefix}.districtId`);
    reference(
      building.semanticGroupId,
      groupIds,
      `${prefix}.semanticGroupId`,
    );
    nonEmptyString(building.name, `${prefix}.name`);
    stringAt(building.path, `${prefix}.path`);
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
    validateBuildingMetricDetails(
      building.metricMethod,
      building.units,
      metrics,
      prefix,
    );
  });

  dependencies.forEach((dependency, index) => {
    const prefix = `dependencies[${index}]`;
    reference(
      dependency.repositoryId,
      repositoryIds,
      `${prefix}.repositoryId`,
    );
    enumValue(dependency.kind, DEPENDENCY_KINDS, `${prefix}.kind`);
    const dependencyNodeIds =
      dependency.kind === "typescript-import" ? buildingIds : moduleIds;
    reference(
      dependency.sourceId,
      dependencyNodeIds,
      `${prefix}.sourceId`,
    );
    optionalReference(
      dependency.targetId,
      dependencyNodeIds,
      `${prefix}.targetId`,
    );
    optionalString(dependency.externalTarget, `${prefix}.externalTarget`);
    optionalString(dependency.version, `${prefix}.version`);
    positiveNumber(dependency.weight, `${prefix}.weight`);

    const hasInternal = dependency.targetId !== undefined;
    const hasExternal = dependency.externalTarget !== undefined;
    if (hasInternal === hasExternal) {
      fail(
        `${prefix} must define exactly one of targetId or externalTarget`,
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
    );
  }
  return model as unknown as CityModel;
}

function validateAnalysis(value: unknown): void {
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
  analysis.warnings.forEach((warning, index) =>
    nonEmptyString(warning, `analysis.warnings[${index}]`),
  );
}

function validateBuildingMetricDetails(
  methodValue: unknown,
  unitsValue: unknown,
  aggregate: JsonObject,
  prefix: string,
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
  );
  units.forEach((unit, index) => {
    const unitPrefix = `${prefix}.units[${index}]`;
    nonEmptyString(unit.name, `${unitPrefix}.name`);
    positiveInteger(unit.line, `${unitPrefix}.line`);
    positiveInteger(unit.complexity, `${unitPrefix}.complexity`);
  });
  if (units.length !== aggregate.executableUnitCount) {
    fail(
      `${prefix}.units length must equal metrics.executableUnitCount`,
    );
  }
  const maximum = Math.max(...units.map((unit) => unit.complexity as number));
  if (maximum !== aggregate.maximumComplexity) {
    fail(`${prefix}.units must preserve metrics.maximumComplexity`);
  }
}

function validateIdentity(
  value: unknown,
  repositoryIds: Set<string>,
): void {
  if (value === undefined) {
    return;
  }

  const identity = objectAt(value, "identity");
  nonEmptyString(identity.title, "identity.title");
  optionalNonEmptyString(identity.version, "identity.version");
  validateLogo(identity.logo, "identity.logo");

  if (identity.repositories !== undefined) {
    const repositories = objectArray(
      identity.repositories,
      "identity.repositories",
      CITY_MODEL_LIMITS.repositories,
    );
    const seen = new Set<string>();
    repositories.forEach((repository, index) => {
      const prefix = `identity.repositories[${index}]`;
      const repositoryId = nonEmptyString(
        repository.repositoryId,
        `${prefix}.repositoryId`,
      );
      if (!repositoryIds.has(repositoryId)) {
        fail(`${prefix}.repositoryId references unknown id "${repositoryId}"`);
      }
      if (seen.has(repositoryId)) {
        fail(`${prefix}.repositoryId duplicates "${repositoryId}"`);
      }
      seen.add(repositoryId);
      optionalNonEmptyString(repository.title, `${prefix}.title`);
      optionalNonEmptyString(repository.version, `${prefix}.version`);
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
  optionalNonEmptyString(logo.alt, `${path}.alt`);
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
): JsonObject[] {
  if (!Array.isArray(value)) {
    fail(`${path} must be an array`);
  }
  if (value.length > maximumLength) {
    fail(`${path} must contain at most ${maximumLength} items`);
  }
  return value.map((item, index) => objectAt(item, `${path}[${index}]`));
}

function validateIds(items: JsonObject[], path: string): Set<string> {
  const ids = new Set<string>();
  items.forEach((item, index) => {
    const id = nonEmptyString(item.id, `${path}[${index}].id`);
    if (ids.has(id)) {
      fail(`${path}[${index}].id duplicates "${id}"`);
    }
    ids.add(id);
  });
  return ids;
}

function reference(value: unknown, ids: Set<string>, path: string): void {
  const id = nonEmptyString(value, path);
  if (!ids.has(id)) {
    fail(`${path} references unknown id "${id}"`);
  }
}

function optionalReference(
  value: unknown,
  ids: Set<string>,
  path: string,
): void {
  if (value !== undefined) {
    reference(value, ids, path);
  }
}

function referenceArray(
  value: unknown,
  ids: Set<string>,
  path: string,
  maximumLength: number,
): void {
  if (!Array.isArray(value)) {
    fail(`${path} must be an array`);
  }
  if (value.length > maximumLength) {
    fail(`${path} must contain at most ${maximumLength} items`);
  }
  value.forEach((item, index) => reference(item, ids, `${path}[${index}]`));
}

function optionalStringArray(
  value: unknown,
  path: string,
  maximumLength: number,
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
  value.forEach((item, index) => nonEmptyString(item, `${path}[${index}]`));
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
    fail(`${path} has unsupported value "${item}"`);
  }
  return item;
}

function optionalString(value: unknown, path: string): void {
  if (value !== undefined) {
    stringAt(value, path);
  }
}

function optionalNonEmptyString(value: unknown, path: string): void {
  if (value !== undefined) {
    nonEmptyString(value, path);
  }
}

function stringAt(value: unknown, path: string): string {
  if (typeof value !== "string") {
    fail(`${path} must be a string`);
  }
  return value;
}

function nonEmptyString(value: unknown, path: string): string {
  const item = stringAt(value, path);
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

function validColor(color: string): boolean {
  if (typeof CSS !== "undefined" && typeof CSS.supports === "function") {
    return CSS.supports("color", color);
  }
  return /^#[\da-f]{3,8}$/i.test(color);
}

function describe(value: unknown): string {
  if (typeof value === "string") {
    return `"${value}"`;
  }
  if (value === undefined) {
    return "undefined";
  }
  return JSON.stringify(value);
}

function fail(message: string): never {
  throw new Error(message);
}
