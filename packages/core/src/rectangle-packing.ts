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
 * Deterministically packs non-rotated rectangles into next-fit shelves. It
 * minimizes longest side, then area and imbalance. Up to 256 rectangles use all
 * attainable widths; larger inputs use bounded prefix and suffix breakpoints.
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
  return packAtWidth(ordered, gap, bestTargetWidth);
}
