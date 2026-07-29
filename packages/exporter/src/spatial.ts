import type { PrintBounds } from "./geometry.js";

export interface BoundedPrintItem {
  readonly id: string;
  readonly bounds: PrintBounds;
}

interface IndexedItem<T extends BoundedPrintItem> {
  readonly item: T;
  readonly inputIndex: number;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function orderedItems<T extends BoundedPrintItem>(
  items: readonly T[],
): readonly IndexedItem<T>[] {
  return items
    .map((item, inputIndex) => ({ item, inputIndex }))
    .sort(
      (left, right) =>
        left.item.bounds.minimum.x - right.item.bounds.minimum.x ||
        left.item.bounds.maximum.x - right.item.bounds.maximum.x ||
        compare(left.item.id, right.item.id) ||
        left.inputIndex - right.inputIndex,
    );
}

function intervalsCanInteract(
  leftMinimum: number,
  leftMaximum: number,
  rightMinimum: number,
  rightMaximum: number,
  epsilon: number,
): boolean {
  return (
    leftMaximum + epsilon >= rightMinimum &&
    rightMaximum + epsilon >= leftMinimum
  );
}

/**
 * Deterministic X-axis sweep for pairs whose AABBs overlap or touch on all
 * axes. It is a broad phase only; callers still perform their exact test.
 */
export function* potentialPrintPairs<T extends BoundedPrintItem>(
  items: readonly T[],
  epsilon: number,
): Generator<readonly [T, T]> {
  const active: IndexedItem<T>[] = [];
  for (const current of orderedItems(items)) {
    for (let index = active.length - 1; index >= 0; index -= 1) {
      if (
        active[index]!.item.bounds.maximum.x + epsilon <
        current.item.bounds.minimum.x
      ) {
        active.splice(index, 1);
      }
    }
    for (const left of active) {
      if (
        intervalsCanInteract(
          left.item.bounds.minimum.y,
          left.item.bounds.maximum.y,
          current.item.bounds.minimum.y,
          current.item.bounds.maximum.y,
          epsilon,
        ) &&
        intervalsCanInteract(
          left.item.bounds.minimum.z,
          left.item.bounds.maximum.z,
          current.item.bounds.minimum.z,
          current.item.bounds.maximum.z,
          epsilon,
        )
      ) {
        yield [left.item, current.item];
      }
    }
    active.push(current);
  }
}

function intervalGap(
  leftMinimum: number,
  leftMaximum: number,
  rightMinimum: number,
  rightMaximum: number,
): number {
  return Math.max(
    0,
    Math.max(leftMinimum, rightMinimum) -
      Math.min(leftMaximum, rightMaximum),
  );
}

/**
 * Finds the exact smallest positive horizontal AABB gap among vertically
 * overlapping items. Once a finite candidate exists, the sweep discards every
 * item whose X distance alone cannot improve it.
 */
export function minimumPositiveHorizontalGap<T extends BoundedPrintItem>(
  items: readonly T[],
  epsilon: number,
): number | null {
  let minimum = Number.POSITIVE_INFINITY;
  const active: IndexedItem<T>[] = [];
  for (const current of orderedItems(items)) {
    for (let index = active.length - 1; index >= 0; index -= 1) {
      if (
        active[index]!.item.bounds.maximum.x + minimum + epsilon <
        current.item.bounds.minimum.x
      ) {
        active.splice(index, 1);
      }
    }
    for (const left of active) {
      const verticalOverlap =
        Math.min(
          left.item.bounds.maximum.z,
          current.item.bounds.maximum.z,
        ) -
        Math.max(
          left.item.bounds.minimum.z,
          current.item.bounds.minimum.z,
        );
      if (verticalOverlap <= epsilon) continue;
      const xGap = intervalGap(
        left.item.bounds.minimum.x,
        left.item.bounds.maximum.x,
        current.item.bounds.minimum.x,
        current.item.bounds.maximum.x,
      );
      if (xGap >= minimum) continue;
      const yGap = intervalGap(
        left.item.bounds.minimum.y,
        left.item.bounds.maximum.y,
        current.item.bounds.minimum.y,
        current.item.bounds.maximum.y,
      );
      if (yGap >= minimum) continue;
      const gap = Math.hypot(xGap, yGap);
      if (gap > epsilon && gap < minimum) minimum = gap;
    }
    active.push(current);
  }
  return Number.isFinite(minimum) ? minimum : null;
}
