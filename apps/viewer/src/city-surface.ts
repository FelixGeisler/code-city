import type {
  CityBase,
  CityModel,
} from "../../../packages/core/src/model.js";

export const LEGACY_CITY_BASE_HEIGHT = 0.5;

type CitySurfaceModel = Pick<
  CityModel,
  "base" | "districts" | "identityPanel"
>;

/**
 * Returns explicit shared-base geometry or derives a compatible foundation for
 * older schema-1.0 models that only contain district parcels.
 */
export function cityBaseForModel(
  model: CitySurfaceModel,
): CityBase | undefined {
  if (model.base !== undefined) {
    return model.base;
  }

  let minimumX = Number.POSITIVE_INFINITY;
  let maximumX = Number.NEGATIVE_INFINITY;
  let minimumZ = Number.POSITIVE_INFINITY;
  let maximumZ = Number.NEGATIVE_INFINITY;
  let minimumDistrictBottom = Number.POSITIVE_INFINITY;
  let minimumSupportHeight = Number.POSITIVE_INFINITY;

  for (const district of model.districts) {
    minimumX = Math.min(
      minimumX,
      district.position.x - district.size.x / 2,
    );
    maximumX = Math.max(
      maximumX,
      district.position.x + district.size.x / 2,
    );
    minimumZ = Math.min(
      minimumZ,
      district.position.z - district.size.z / 2,
    );
    maximumZ = Math.max(
      maximumZ,
      district.position.z + district.size.z / 2,
    );
    minimumDistrictBottom = Math.min(
      minimumDistrictBottom,
      district.position.y - district.size.y / 2,
    );
    minimumSupportHeight = Math.min(
      minimumSupportHeight,
      district.size.y,
    );
  }

  const panel = model.identityPanel;
  if (panel !== undefined) {
    minimumX = Math.min(
      minimumX,
      panel.position.x - panel.size.x / 2,
    );
    maximumX = Math.max(
      maximumX,
      panel.position.x + panel.size.x / 2,
    );
    minimumZ = Math.min(
      minimumZ,
      panel.position.z - panel.size.z / 2 - panel.reliefDepth,
    );
    maximumZ = Math.max(
      maximumZ,
      panel.position.z + panel.size.z / 2,
    );
    if (model.districts.length === 0) {
      minimumDistrictBottom = panel.position.y - panel.size.y / 2;
      minimumSupportHeight = panel.size.y;
    }
  }

  if (
    !Number.isFinite(minimumX) ||
    !Number.isFinite(maximumX) ||
    !Number.isFinite(minimumZ) ||
    !Number.isFinite(maximumZ) ||
    !Number.isFinite(minimumDistrictBottom) ||
    !Number.isFinite(minimumSupportHeight)
  ) {
    return undefined;
  }

  const height = Math.min(
    LEGACY_CITY_BASE_HEIGHT,
    minimumSupportHeight / 2,
  );
  return {
    id: "base:legacy-derived",
    semanticGroupId: "base",
    position: {
      x: (minimumX + maximumX) / 2,
      y: minimumDistrictBottom + height / 2,
      z: (minimumZ + maximumZ) / 2,
    },
    size: {
      x: maximumX - minimumX,
      y: height,
      z: maximumZ - minimumZ,
    },
  };
}
