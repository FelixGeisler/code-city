import { normalizeCityIdentity } from "./identity.js";
import {
  calculateBuildingGeometry,
  classifyRisk,
  metricNormalizationForGeometry,
  validateSourceMetrics,
} from "./metrics.js";
import type {
  CityBase,
  CityBuilding,
  CityDistrict,
  CityIdentity,
  CityIdentityPanel,
  CityModule,
  CityRepository,
  ExecutableUnitMetric,
  MetricMethod,
  SourceLanguage,
  SourceMetrics,
  Vector3,
} from "./model.js";
import { normalizePath, stableId } from "./path.js";
import { packRectangles } from "./rectangle-packing.js";
import { semanticGroupForRisk } from "./semantics.js";

export interface UnpositionedBuilding {
  readonly repositoryId: string;
  readonly moduleId: string;
  readonly name: string;
  readonly path: string;
  readonly language: SourceLanguage;
  readonly metrics: SourceMetrics;
  readonly metricMethod?: MetricMethod;
  readonly units?: readonly ExecutableUnitMetric[];
  readonly semanticGroupId?: string;
}

export interface CityLayoutInput {
  readonly repositories: readonly CityRepository[];
  readonly modules: readonly CityModule[];
  readonly buildings: readonly UnpositionedBuilding[];
  readonly identity?: CityIdentity;
}

export interface LayoutOptions {
  readonly buildingGap: number;
  readonly districtPadding: number;
  readonly districtGap: number;
  readonly repositoryGap: number;
  readonly cityBaseHeight: number;
  readonly districtBaseHeight: number;
  readonly minimumDistrictSize: number;
  readonly identityPanelHeight: number;
  readonly identityPanelDepth: number;
  readonly identityPanelGap: number;
  readonly identityReliefDepth: number;
  readonly identityPanelWidth: number;
}

export interface CityLayoutResult {
  readonly identity?: CityIdentity;
  readonly identityPanel?: CityIdentityPanel;
  readonly base?: CityBase;
  readonly districts: readonly CityDistrict[];
  readonly buildings: readonly CityBuilding[];
  readonly bounds: Vector3;
}

export const DEFAULT_LAYOUT_OPTIONS: Readonly<LayoutOptions> = Object.freeze({
  buildingGap: 2,
  districtPadding: 4,
  districtGap: 8,
  repositoryGap: 16,
  cityBaseHeight: 0.5,
  districtBaseHeight: 1,
  minimumDistrictSize: 12,
  identityPanelHeight: 6,
  identityPanelDepth: 1.2,
  identityPanelGap: 2,
  identityReliefDepth: 0.4,
  identityPanelWidth: 40,
});

interface LocalBuilding {
  readonly building: Omit<CityBuilding, "position">;
  readonly position: Vector3;
}

interface LocalDistrict {
  readonly repositoryId: string;
  readonly district: Omit<CityDistrict, "position">;
  readonly buildings: readonly LocalBuilding[];
  readonly width: number;
  readonly depth: number;
}

interface PositionedDistrict {
  readonly local: LocalDistrict;
  readonly x: number;
  readonly z: number;
}

interface RepositoryBlock {
  readonly repositoryId: string;
  readonly districts: readonly PositionedDistrict[];
  readonly width: number;
  readonly depth: number;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function positive(value: number, field: string, allowZero = false): number {
  if (
    !Number.isFinite(value) ||
    (allowZero ? value < 0 : value <= 0)
  ) {
    throw new RangeError(
      `${field} must be a ${allowZero ? "non-negative" : "positive"} finite number.`,
    );
  }
  return value;
}

function normalizeOptions(options: Partial<LayoutOptions>): LayoutOptions {
  const merged = { ...DEFAULT_LAYOUT_OPTIONS, ...options };
  positive(merged.buildingGap, "buildingGap", true);
  positive(merged.districtPadding, "districtPadding", true);
  positive(merged.districtGap, "districtGap", true);
  positive(merged.repositoryGap, "repositoryGap", true);
  positive(merged.cityBaseHeight, "cityBaseHeight");
  positive(merged.districtBaseHeight, "districtBaseHeight");
  positive(merged.minimumDistrictSize, "minimumDistrictSize");
  positive(merged.identityPanelHeight, "identityPanelHeight");
  positive(merged.identityPanelDepth, "identityPanelDepth");
  positive(merged.identityPanelGap, "identityPanelGap", true);
  positive(merged.identityReliefDepth, "identityReliefDepth");
  positive(merged.identityPanelWidth, "identityPanelWidth");
  if (merged.identityReliefDepth > merged.identityPanelDepth) {
    throw new RangeError("identityReliefDepth must not exceed identityPanelDepth.");
  }
  if (merged.cityBaseHeight >= merged.districtBaseHeight) {
    throw new RangeError(
      "cityBaseHeight must be less than districtBaseHeight.",
    );
  }
  if (merged.identityPanelHeight <= merged.cityBaseHeight) {
    throw new RangeError(
      "identityPanelHeight must be greater than cityBaseHeight.",
    );
  }
  return merged;
}

function assertUniqueIds(
  values: readonly { readonly id: string }[],
  kind: string,
): void {
  const ids = new Set<string>();
  for (const value of values) {
    if (ids.has(value.id)) {
      throw new TypeError(`Duplicate ${kind} id '${value.id}'.`);
    }
    ids.add(value.id);
  }
}

function createLocalDistrict(
  module: CityModule,
  facts: readonly UnpositionedBuilding[],
  options: LayoutOptions,
): LocalDistrict {
  const ordered = [...facts].sort(
    (left, right) =>
      compare(normalizePath(left.path), normalizePath(right.path)) ||
      compare(left.name, right.name),
  );
  const sized = ordered.map((fact) => {
    validateSourceMetrics(fact.metrics);
    const path = normalizePath(fact.path);
    const risk = classifyRisk(fact.metrics.maximumComplexity);
    const geometry = calculateBuildingGeometry(fact.metrics);
    return {
      fact,
      path,
      geometry,
      size: geometry.size,
      risk,
      id: stableId(
        "building",
        fact.repositoryId,
        fact.moduleId,
        path,
      ),
    };
  });
  const buildingIds = new Set<string>();
  for (const item of sized) {
    if (buildingIds.has(item.id)) {
      throw new TypeError(
        `Duplicate building path '${item.path}' in module '${module.id}'.`,
      );
    }
    buildingIds.add(item.id);
  }

  const buildingPacking = packRectangles(
    sized.map((item) => ({
      id: item.id,
      width: item.size.x,
      depth: item.size.z,
    })),
    options.buildingGap,
  );
  const buildingPlacements = new Map(
    buildingPacking.rectangles.map((rectangle) => [
      rectangle.id,
      rectangle,
    ]),
  );
  const width = Math.max(
    options.minimumDistrictSize,
    options.districtPadding * 2 + buildingPacking.width,
  );
  const depth = Math.max(
    options.minimumDistrictSize,
    options.districtPadding * 2 + buildingPacking.depth,
  );
  const buildingInsetX = (width - buildingPacking.width) / 2;
  const buildingInsetZ = (depth - buildingPacking.depth) / 2;
  const districtId = stableId("district", module.repositoryId, module.id);
  const buildings = sized.map((item): LocalBuilding => {
    const placement = buildingPlacements.get(item.id)!;
    return {
      building: {
        id: item.id,
        repositoryId: item.fact.repositoryId,
        moduleId: item.fact.moduleId,
        districtId,
        name: item.fact.name,
        path: item.path,
        language: item.fact.language,
        metrics: item.fact.metrics,
        metricNormalization: metricNormalizationForGeometry(item.geometry),
        ...(item.fact.metricMethod === undefined
          ? {}
          : { metricMethod: item.fact.metricMethod }),
        ...(item.fact.units === undefined ? {} : { units: item.fact.units }),
        risk: item.risk,
        semanticGroupId:
          item.fact.semanticGroupId ?? semanticGroupForRisk(item.risk),
        size: item.size,
      },
      position: {
        x: buildingInsetX + placement.x + item.size.x / 2,
        y: options.districtBaseHeight + item.size.y / 2,
        z: buildingInsetZ + placement.z + item.size.z / 2,
      },
    };
  });

  return {
    repositoryId: module.repositoryId,
    district: {
      id: districtId,
      repositoryId: module.repositoryId,
      moduleId: module.id,
      name: module.name,
      path: normalizePath(module.path),
      size: { x: width, y: options.districtBaseHeight, z: depth },
    },
    buildings,
    width,
    depth,
  };
}

function packDistricts(
  repositoryId: string,
  districts: readonly LocalDistrict[],
  gap: number,
): RepositoryBlock {
  if (districts.length === 0) {
    return { repositoryId, districts: [], width: 0, depth: 0 };
  }
  const packing = packRectangles(
    districts.map((local) => ({
      id: local.district.id,
      width: local.width,
      depth: local.depth,
    })),
    gap,
  );
  const placements = new Map(
    packing.rectangles.map((rectangle) => [rectangle.id, rectangle]),
  );
  return {
    repositoryId,
    districts: districts.map((local) => {
      const placement = placements.get(local.district.id)!;
      return {
        local,
        x: placement.x,
        z: placement.z,
      };
    }),
    width: packing.width,
    depth: packing.depth,
  };
}

export function layoutCity(
  input: CityLayoutInput,
  partialOptions: Partial<LayoutOptions> = {},
): CityLayoutResult {
  const options = normalizeOptions(partialOptions);
  assertUniqueIds(input.repositories, "repository");
  assertUniqueIds(input.modules, "module");
  const repositoryIds = new Set(input.repositories.map(({ id }) => id));
  const modulesById = new Map(input.modules.map((module) => [module.id, module]));
  for (const module of input.modules) {
    if (!repositoryIds.has(module.repositoryId)) {
      throw new TypeError(
        `Module '${module.id}' references unknown repository '${module.repositoryId}'.`,
      );
    }
  }

  const factsByModule = new Map<string, UnpositionedBuilding[]>();
  for (const fact of input.buildings) {
    const module = modulesById.get(fact.moduleId);
    if (!module) {
      throw new TypeError(
        `Building '${fact.path}' references unknown module '${fact.moduleId}'.`,
      );
    }
    if (
      fact.repositoryId !== module.repositoryId ||
      !repositoryIds.has(fact.repositoryId)
    ) {
      throw new TypeError(
        `Building '${fact.path}' has an inconsistent repository id.`,
      );
    }
    const list = factsByModule.get(fact.moduleId) ?? [];
    list.push(fact);
    factsByModule.set(fact.moduleId, list);
  }

  const orderedRepositories = [...input.repositories].sort((left, right) =>
    compare(left.id, right.id),
  );
  const blocks = orderedRepositories
    .map((repository) => {
      const localDistricts = input.modules
        .filter((module) => module.repositoryId === repository.id)
        .sort(
          (left, right) =>
            compare(normalizePath(left.path), normalizePath(right.path)) ||
            compare(left.id, right.id),
        )
        .map((module) =>
          createLocalDistrict(
            module,
            factsByModule.get(module.id) ?? [],
            options,
          ),
        );
      return packDistricts(repository.id, localDistricts, options.districtGap);
    })
    .filter((block) => block.districts.length > 0);

  const repositoryPacking = packRectangles(
    blocks.map((block) => ({
      id: block.repositoryId,
      width: block.width,
      depth: block.depth,
    })),
    options.repositoryGap,
  );
  const repositoryPlacements = new Map(
    repositoryPacking.rectangles.map((rectangle) => [
      rectangle.id,
      rectangle,
    ]),
  );
  const cityWidth = repositoryPacking.width;
  const cityDepth = repositoryPacking.depth;

  const identity =
    input.identity === undefined ? undefined : normalizeCityIdentity(input.identity);
  const panelWidth =
    identity === undefined ? 0 : options.identityPanelWidth;
  const baseWidth =
    identity === undefined ? cityWidth : Math.max(cityWidth, panelWidth);
  const xInset = (baseWidth - cityWidth) / 2;
  const zInset =
    identity === undefined
      ? 0
      : options.identityReliefDepth +
        options.identityPanelDepth +
        options.identityPanelGap;
  const districts: CityDistrict[] = [];
  const buildings: CityBuilding[] = [];
  let maximumHeight = 0;

  blocks.forEach((block) => {
    const repositoryPlacement = repositoryPlacements.get(
      block.repositoryId,
    )!;
    const repositoryX =
      xInset + repositoryPlacement.x;
    const repositoryZ = zInset + repositoryPlacement.z;
    for (const positioned of block.districts) {
      const originX = repositoryX + positioned.x;
      const originZ = repositoryZ + positioned.z;
      const { local } = positioned;
      districts.push({
        ...local.district,
        position: {
          x: originX + local.width / 2,
          y: options.districtBaseHeight / 2,
          z: originZ + local.depth / 2,
        },
      });
      maximumHeight = Math.max(maximumHeight, options.districtBaseHeight);
      for (const item of local.buildings) {
        buildings.push({
          ...item.building,
          position: {
            x: originX + item.position.x,
            y: item.position.y,
            z: originZ + item.position.z,
          },
        });
        maximumHeight = Math.max(
          maximumHeight,
          options.districtBaseHeight + item.building.size.y,
        );
      }
    }
  });

  const identityPanel: CityIdentityPanel | undefined =
    identity === undefined
      ? undefined
      : {
          id: stableId("identity-panel", identity.title),
          edge: "front",
          semanticGroupId: "identity",
          position: {
            x: baseWidth / 2,
            y: options.identityPanelHeight / 2,
            z:
              options.identityReliefDepth +
              options.identityPanelDepth / 2,
          },
          size: {
            x: panelWidth,
            y: options.identityPanelHeight,
            z: options.identityPanelDepth,
          },
          relief: "embossed",
          reliefDepth: options.identityReliefDepth,
        };
  const baseDepth = zInset + cityDepth;
  const base: CityBase | undefined =
    baseWidth > 0 && baseDepth > 0
      ? {
          id: stableId(
            "base",
            ...orderedRepositories.map(({ id }) => id),
          ),
          semanticGroupId: "base",
          position: {
            x: baseWidth / 2,
            y: options.cityBaseHeight / 2,
            z: baseDepth / 2,
          },
          size: {
            x: baseWidth,
            y: options.cityBaseHeight,
            z: baseDepth,
          },
        }
      : undefined;

  return {
    ...(identity === undefined ? {} : { identity }),
    ...(identityPanel === undefined ? {} : { identityPanel }),
    ...(base === undefined ? {} : { base }),
    districts,
    buildings,
    bounds: {
      x: baseWidth,
      y: Math.max(
        maximumHeight,
        identityPanel?.size.y ?? 0,
        base?.size.y ?? 0,
      ),
      z: zInset + cityDepth,
    },
  };
}
