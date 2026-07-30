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
import {
  packRectangles,
  type RectanglePackingSearchMode,
} from "./rectangle-packing.js";
import { semanticGroupForRisk } from "./semantics.js";

export interface UnpositionedBuilding {
  /**
   * Optional caller-owned stable identity. Snapshot layouts omit it and keep
   * the schema-1.0 path-derived identity; evolution layouts provide a lineage
   * identity so a rename does not create a new building.
   */
  readonly id?: string;
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

export interface CityLayoutExecutionOptions {
  /**
   * Called with completed work units at bounded intervals and with zero at
   * otherwise idle phase boundaries. Throwing cancels layout.
   */
  readonly checkpoint?: (operations: number) => void;
  /**
   * Uses fixed-cap rectangle candidate searches throughout the entire city
   * layout when set to `bounded`. Evolution analysis uses this mode because it
   * lays out a union plus every sampled frame.
   */
  readonly packingSearchMode?: RectanglePackingSearchMode;
}

const LAYOUT_CHECKPOINT_INTERVAL = 256;

class LayoutCheckpoint {
  #operations = 0;

  public constructor(
    private readonly callback:
      | ((operations: number) => void)
      | undefined,
  ) {}

  public checkpoint(): void {
    const operations = this.#operations;
    this.#operations = 0;
    this.callback?.(operations);
  }

  public consume(operations = 1): void {
    if (this.callback === undefined) return;
    this.#operations += operations;
    while (this.#operations >= LAYOUT_CHECKPOINT_INTERVAL) {
      this.#operations -= LAYOUT_CHECKPOINT_INTERVAL;
      this.callback(LAYOUT_CHECKPOINT_INTERVAL);
    }
  }
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
  work: LayoutCheckpoint,
): void {
  const ids = new Set<string>();
  for (const value of values) {
    work.consume();
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
  packingSearchMode: RectanglePackingSearchMode,
  work: LayoutCheckpoint,
): LocalDistrict {
  work.checkpoint();
  const ordered = [...facts].sort((left, right) => {
    work.consume();
    return (
      compare(normalizePath(left.path), normalizePath(right.path)) ||
      compare(left.name, right.name)
    );
  });
  work.checkpoint();
  const sized = ordered.map((fact) => {
    work.consume();
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
      id:
        fact.id ??
        stableId(
          "building",
          fact.repositoryId,
          fact.moduleId,
          path,
        ),
    };
  });
  const buildingIds = new Set<string>();
  for (const item of sized) {
    work.consume();
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
    {
      searchMode: packingSearchMode,
      checkpoint: (operations) => {
        work.consume(operations);
        work.checkpoint();
      },
    },
  );
  const buildingPlacements = new Map(
    buildingPacking.rectangles.map((rectangle) => {
      work.consume();
      return [rectangle.id, rectangle] as const;
    }),
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
    work.consume();
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
  packingSearchMode: RectanglePackingSearchMode,
  work: LayoutCheckpoint,
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
    {
      searchMode: packingSearchMode,
      checkpoint: (operations) => {
        work.consume(operations);
        work.checkpoint();
      },
    },
  );
  const placements = new Map(
    packing.rectangles.map((rectangle) => {
      work.consume();
      return [rectangle.id, rectangle] as const;
    }),
  );
  return {
    repositoryId,
    districts: districts.map((local) => {
      work.consume();
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
  execution: CityLayoutExecutionOptions = {},
): CityLayoutResult {
  const work = new LayoutCheckpoint(execution.checkpoint);
  work.checkpoint();
  const packingSearchMode = execution.packingSearchMode ?? "quality";
  if (
    packingSearchMode !== "quality" &&
    packingSearchMode !== "bounded"
  ) {
    throw new TypeError(
      "City layout packingSearchMode must be 'quality' or 'bounded'.",
    );
  }
  const options = normalizeOptions(partialOptions);
  assertUniqueIds(input.repositories, "repository", work);
  assertUniqueIds(input.modules, "module", work);
  const repositoryIds = new Set(
    input.repositories.map(({ id }) => {
      work.consume();
      return id;
    }),
  );
  const modulesById = new Map(
    input.modules.map((module) => {
      work.consume();
      return [module.id, module] as const;
    }),
  );
  for (const module of input.modules) {
    work.consume();
    if (!repositoryIds.has(module.repositoryId)) {
      throw new TypeError(
        `Module '${module.id}' references unknown repository '${module.repositoryId}'.`,
      );
    }
  }

  const factsByModule = new Map<string, UnpositionedBuilding[]>();
  for (const fact of input.buildings) {
    work.consume();
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

  work.checkpoint();
  const orderedRepositories = [...input.repositories].sort((left, right) => {
    work.consume();
    return compare(left.id, right.id);
  });
  work.checkpoint();
  const blocks = orderedRepositories
    .map((repository) => {
      work.consume();
      const localDistricts = input.modules
        .filter((module) => {
          work.consume();
          return module.repositoryId === repository.id;
        })
        .sort((left, right) => {
          work.consume();
          return (
            compare(normalizePath(left.path), normalizePath(right.path)) ||
            compare(left.id, right.id)
          );
        })
        .map((module) =>
          createLocalDistrict(
            module,
            factsByModule.get(module.id) ?? [],
            options,
            packingSearchMode,
            work,
          ),
        );
      return packDistricts(
        repository.id,
        localDistricts,
        options.districtGap,
        packingSearchMode,
        work,
      );
    })
    .filter((block) => block.districts.length > 0);

  const repositoryPacking = packRectangles(
    blocks.map((block) => ({
      id: block.repositoryId,
      width: block.width,
      depth: block.depth,
    })),
    options.repositoryGap,
    {
      searchMode: packingSearchMode,
      checkpoint: (operations) => {
        work.consume(operations);
        work.checkpoint();
      },
    },
  );
  const repositoryPlacements = new Map(
    repositoryPacking.rectangles.map((rectangle) => {
      work.consume();
      return [rectangle.id, rectangle] as const;
    }),
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
    work.consume();
    const repositoryPlacement = repositoryPlacements.get(
      block.repositoryId,
    )!;
    const repositoryX =
      xInset + repositoryPlacement.x;
    const repositoryZ = zInset + repositoryPlacement.z;
    for (const positioned of block.districts) {
      work.consume();
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
        work.consume();
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

  work.checkpoint();
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
