/**
 * An axis-aligned footprint. Rectangles are never rotated.
 */
export interface PackingRectangle {
  readonly id: string;
  readonly width: number;
  readonly depth: number;
}

/**
 * A footprint positioned from the packing origin at (0, 0).
 */
export interface PackedRectangle extends PackingRectangle {
  readonly x: number;
  readonly z: number;
}

/**
 * Exact occupied bounds. Rectangles are sorted by id, not placement order.
 */
export interface RectanglePacking {
  readonly rectangles: readonly PackedRectangle[];
  readonly width: number;
  readonly depth: number;
}

interface PackingBounds {
  readonly width: number;
  readonly depth: number;
}

const EXACT_BREAKPOINT_LIMIT = 256;
const CORNER_PACKING_LIMIT = 64;

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function positive(value: number, field: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${field} must be a positive finite number.`);
  }
  return value;
}

function nonNegative(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative finite number.`);
  }
  return value;
}

function walkShelves(
  ordered: readonly PackingRectangle[],
  gap: number,
  targetWidth: number,
  place?: (rectangle: PackingRectangle, x: number, z: number) => void,
): PackingBounds {
  let rowWidth = 0;
  let rowDepth = 0;
  let rowZ = 0;
  let width = 0;

  for (const rectangle of ordered) {
    const nextWidth =
      rowWidth === 0
        ? rectangle.width
        : rowWidth + gap + rectangle.width;
    if (rowWidth > 0 && nextWidth > targetWidth) {
      rowZ = rowZ + rowDepth + gap;
      rowWidth = 0;
      rowDepth = 0;
    }

    const x = rowWidth === 0 ? 0 : rowWidth + gap;
    rowWidth = x + rectangle.width;
    rowDepth = Math.max(rowDepth, rectangle.depth);
    width = Math.max(width, rowWidth);
    place?.(rectangle, x, rowZ);
  }

  return {
    width,
    depth: rowZ + rowDepth,
  };
}

function packAtWidth(
  ordered: readonly PackingRectangle[],
  gap: number,
  targetWidth: number,
): RectanglePacking {
  const rectangles: PackedRectangle[] = [];
  const bounds = walkShelves(
    ordered,
    gap,
    targetWidth,
    (rectangle, x, z) => rectangles.push({ ...rectangle, x, z }),
  );
  return {
    rectangles: rectangles.sort((left, right) =>
      compare(left.id, right.id),
    ),
    ...bounds,
  };
}

function isSeparated(
  left: PackedRectangle,
  right: PackedRectangle,
  gap: number,
): boolean {
  return (
    left.x + left.width + gap <= right.x ||
    right.x + right.width + gap <= left.x ||
    left.z + left.depth + gap <= right.z ||
    right.z + right.depth + gap <= left.z
  );
}

function isBetter(
  candidate: PackingBounds,
  current: PackingBounds,
): boolean {
  const candidateScore = [
    Math.max(candidate.width, candidate.depth),
    Math.log(candidate.width) + Math.log(candidate.depth),
    Math.abs(candidate.width - candidate.depth),
    candidate.width,
  ];
  const currentScore = [
    Math.max(current.width, current.depth),
    Math.log(current.width) + Math.log(current.depth),
    Math.abs(current.width - current.depth),
    current.width,
  ];
  for (let index = 0; index < candidateScore.length; index += 1) {
    const difference = candidateScore[index]! - currentScore[index]!;
    if (difference !== 0) {
      return difference < 0;
    }
  }
  return false;
}

function hasEqualScore(
  left: PackingBounds,
  right: PackingBounds,
): boolean {
  return !isBetter(left, right) && !isBetter(right, left);
}

/**
 * Places each rectangle at a corner formed by the origin or an already placed
 * edge. Unlike shelves, this can reuse the L-shaped spaces beside and behind
 * rectangles of different depths.
 */
function packAtCorners(
  ordered: readonly PackingRectangle[],
  gap: number,
): RectanglePacking {
  const placed: PackedRectangle[] = [];
  let width = 0;
  let depth = 0;

  for (const rectangle of ordered) {
    const candidateXs = [
      ...new Set([
        0,
        ...placed.map(
          (candidate) => candidate.x + candidate.width + gap,
        ),
      ]),
    ].sort((left, right) => left - right);
    const candidateZs = [
      ...new Set([
        0,
        ...placed.map(
          (candidate) => candidate.z + candidate.depth + gap,
        ),
      ]),
    ].sort((left, right) => left - right);

    let best:
      | {
          readonly rectangle: PackedRectangle;
          readonly bounds: PackingBounds;
        }
      | undefined;
    for (const x of candidateXs) {
      for (const z of candidateZs) {
        const candidate = { ...rectangle, x, z };
        if (
          !placed.every((existing) =>
            isSeparated(candidate, existing, gap),
          )
        ) {
          continue;
        }
        const bounds = {
          width: Math.max(width, x + rectangle.width),
          depth: Math.max(depth, z + rectangle.depth),
        };
        if (
          best === undefined ||
          isBetter(bounds, best.bounds) ||
          (hasEqualScore(bounds, best.bounds) &&
            (z < best.rectangle.z ||
              (z === best.rectangle.z && x < best.rectangle.x)))
        ) {
          best = { rectangle: candidate, bounds };
        }
      }
    }

    // Placing above every existing rectangle is always a valid candidate.
    if (best === undefined) {
      throw new Error("Unable to find a finite rectangle placement.");
    }
    placed.push(best.rectangle);
    width = best.bounds.width;
    depth = best.bounds.depth;
  }

  return {
    rectangles: placed.sort((left, right) => compare(left.id, right.id)),
    width,
    depth,
  };
}

function attainableWidths(
  ordered: readonly PackingRectangle[],
  gap: number,
): readonly number[] {
  const widths = new Set<number>();
  for (let start = 0; start < ordered.length; start += 1) {
    let width = 0;
    for (let end = start; end < ordered.length; end += 1) {
      width += (end === start ? 0 : gap) + ordered[end]!.width;
      widths.add(width);
    }
  }
  return [...widths].sort((left, right) => left - right);
}

function boundedWidths(
  ordered: readonly PackingRectangle[],
  gap: number,
): readonly number[] {
  const widths = new Set<number>();
  let prefix = 0;
  let suffix = 0;
  let maximum = 0;
  for (let index = 0; index < ordered.length; index += 1) {
    prefix = prefix + (index === 0 ? 0 : gap) + ordered[index]!.width;
    widths.add(prefix);
    maximum = Math.max(maximum, ordered[index]!.width);

    const reverseIndex = ordered.length - 1 - index;
    suffix =
      ordered[reverseIndex]!.width +
      (index === 0 ? 0 : gap) +
      suffix;
    widths.add(suffix);
  }
  widths.add(maximum);
  return [...widths].sort((left, right) => left - right);
}

/**
 * Deterministically packs non-rotated rectangles while minimizing longest
 * side, then area and imbalance. Small inputs compare corner-filling passes
 * with a next-fit shelf baseline. Larger inputs retain bounded-cost shelves.
 * Up to 256 rectangles use all attainable shelf widths; larger inputs use
 * bounded prefix and suffix breakpoints.
 */
export function packRectangles(
  rectangles: readonly PackingRectangle[],
  gap: number,
): RectanglePacking {
  nonNegative(gap, "gap");
  if (rectangles.length === 0) {
    return { rectangles: [], width: 0, depth: 0 };
  }

  const ids = new Set<string>();
  const validated = rectangles.map((rectangle, index) => {
    if (rectangle.id.trim() === "") {
      throw new TypeError(`rectangles[${index}].id must not be empty.`);
    }
    if (ids.has(rectangle.id)) {
      throw new TypeError(`Duplicate rectangle id '${rectangle.id}'.`);
    }
    ids.add(rectangle.id);
    return {
      id: rectangle.id,
      width: positive(rectangle.width, `rectangles[${index}].width`),
      depth: positive(rectangle.depth, `rectangles[${index}].depth`),
    };
  });
  const ordered = [...validated].sort(
    (left, right) =>
      right.depth - left.depth ||
      right.width - left.width ||
      compare(left.id, right.id),
  );
  const totalWidth =
    ordered.reduce(
      (sum, rectangle, index) =>
        sum + rectangle.width + (index === 0 ? 0 : gap),
      0,
    );
  const totalDepth = ordered.reduce(
    (sum, rectangle, index) =>
      sum + rectangle.depth + (index === 0 ? 0 : gap),
    0,
  );
  if (!Number.isFinite(totalWidth) || !Number.isFinite(totalDepth)) {
    throw new RangeError("Combined rectangle geometry must remain finite.");
  }

  const candidateWidths =
    ordered.length <= EXACT_BREAKPOINT_LIMIT
      ? attainableWidths(ordered, gap)
      : boundedWidths(ordered, gap);
  let bestTargetWidth = candidateWidths[0]!;
  let best = walkShelves(ordered, gap, bestTargetWidth);
  for (const candidateWidth of candidateWidths.slice(1)) {
    const candidate = walkShelves(ordered, gap, candidateWidth);
    if (isBetter(candidate, best)) {
      best = candidate;
      bestTargetWidth = candidateWidth;
    }
  }
  let result = packAtWidth(ordered, gap, bestTargetWidth);
  if (ordered.length <= CORNER_PACKING_LIMIT) {
    const widthOrdered = [...validated].sort(
      (left, right) =>
        right.width - left.width ||
        right.depth - left.depth ||
        compare(left.id, right.id),
    );
    for (const cornerOrder of [ordered, widthOrdered]) {
      const candidate = packAtCorners(cornerOrder, gap);
      if (isBetter(candidate, result)) {
        result = candidate;
      }
    }
  }
  return result;
}
