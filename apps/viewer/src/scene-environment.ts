export const DEFAULT_FOG_DENSITY = 0.0022;
export const MINIMUM_TARGET_TRANSMITTANCE = 0.8;

const DENSITY_DISTANCE_PRODUCT =
  Math.sqrt(-Math.log(MINIMUM_TARGET_TRANSMITTANCE));

export function fogDensityForCameraDistance(distance: number): number {
  if (!Number.isFinite(distance) || distance <= 0) {
    return DEFAULT_FOG_DENSITY;
  }

  const densityAtMinimumTransmittance = DENSITY_DISTANCE_PRODUCT / distance;
  return Math.min(DEFAULT_FOG_DENSITY, densityAtMinimumTransmittance);
}
