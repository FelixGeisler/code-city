export const DEFAULT_FOG_DENSITY = 0.0022;
export const MINIMUM_TARGET_TRANSMITTANCE = 0.8;

export function fogDensityForCameraDistance(distance: number): number {
  if (!Number.isFinite(distance) || distance <= 0) {
    return DEFAULT_FOG_DENSITY;
  }

  const densityAtMinimumTransmittance =
    Math.sqrt(-Math.log(MINIMUM_TARGET_TRANSMITTANCE)) / distance;
  return Math.min(DEFAULT_FOG_DENSITY, densityAtMinimumTransmittance);
}
