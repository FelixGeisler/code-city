export interface GroundGridBounds {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

export interface GroundGridLayout {
  readonly centerX: number;
  readonly centerZ: number;
  readonly size: number;
  readonly divisions: number;
}

const MINIMUM_GRID_SIZE = 20;
const MINIMUM_PADDING = 4;
const MAXIMUM_PADDING = 16;
const PADDING_RATIO = 0.08;
const TARGET_CELL_SIZE = 2;
const MINIMUM_DIVISIONS = 20;
const MAXIMUM_DIVISIONS = 64;

export function groundGridLayout(
  bounds: GroundGridBounds,
): GroundGridLayout {
  assertBounds(bounds);

  const width = bounds.maxX - bounds.minX;
  const depth = bounds.maxZ - bounds.minZ;
  const maximumDimension = Math.max(width, depth);
  const padding = clamp(
    maximumDimension * PADDING_RATIO,
    MINIMUM_PADDING,
    MAXIMUM_PADDING,
  );
  const requiredSize = maximumDimension + padding * 2;
  const size = Math.max(
    MINIMUM_GRID_SIZE,
    roundUp(requiredSize, TARGET_CELL_SIZE),
  );
  const divisions = Math.round(
    clamp(
      size / TARGET_CELL_SIZE,
      MINIMUM_DIVISIONS,
      MAXIMUM_DIVISIONS,
    ),
  );

  return {
    centerX: (bounds.minX + bounds.maxX) * 0.5,
    centerZ: (bounds.minZ + bounds.maxZ) * 0.5,
    size,
    divisions,
  };
}

function assertBounds(bounds: GroundGridBounds): void {
  const values = [
    bounds.minX,
    bounds.maxX,
    bounds.minZ,
    bounds.maxZ,
  ];
  if (values.some((value) => !Number.isFinite(value))) {
    throw new RangeError("Grid bounds must contain finite values.");
  }
  if (bounds.maxX < bounds.minX || bounds.maxZ < bounds.minZ) {
    throw new RangeError("Grid bounds maxima must not be below their minima.");
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function roundUp(value: number, step: number): number {
  return Math.ceil(value / step) * step;
}
