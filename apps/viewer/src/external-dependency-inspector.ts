import type {
  ExternalDependencyKindSummary,
  ExternalDependencySelectionNode,
} from "../../../packages/core/src/external-dependencies.js";

export interface ExternalDependencyConsumerIdentity {
  readonly label: string;
  readonly path: string;
}

export type ExternalDependencyConsumerResolver = (
  sourceId: string,
) => ExternalDependencyConsumerIdentity | null | undefined;

export interface ExternalDependencyConsumerPresentation {
  readonly sourceId: string;
  readonly label: string;
  readonly path: string;
  readonly edgeCount: number;
  readonly weight: number;
}

export interface ExternalDependencyPresentation {
  readonly kind: ExternalDependencySelectionNode["kind"];
  /**
   * The complete normalized target, or the overflow label. The viewer must
   * render this value as text rather than interpreting it as markup.
   */
  readonly label: string;
  readonly targetCount: number;
  readonly edgeCount: number;
  readonly totalWeight: number;
  readonly kindTotals: readonly ExternalDependencyKindSummary[];
  readonly consumers: readonly ExternalDependencyConsumerPresentation[];
  readonly hiddenConsumerCount: number;
  readonly hiddenConsumerWeight: number;
}

/**
 * Converts a shared external-dependency aggregate into deterministic,
 * renderer-neutral interaction data. All labels and paths remain plain text;
 * DOM rendering is deliberately left to the caller.
 */
export function presentExternalDependency(
  node: ExternalDependencySelectionNode,
  resolveConsumer?: ExternalDependencyConsumerResolver,
): ExternalDependencyPresentation {
  const kindTotals = [...node.kinds].sort((left, right) =>
    compareText(left.kind, right.kind),
  );
  const consumers: ExternalDependencyConsumerPresentation[] = [];
  let hiddenConsumerCount = node.hiddenConsumerCount;
  let hiddenConsumerWeight = node.hiddenConsumerWeight;
  for (const consumer of [...node.consumers].sort(
    (left, right) =>
      right.weight - left.weight ||
      compareText(left.sourceId, right.sourceId),
  )) {
    const identity = resolveConsumer?.(consumer.sourceId);
    if (identity === null) {
      hiddenConsumerCount += 1;
      hiddenConsumerWeight = safeWeightSum(
        hiddenConsumerWeight,
        consumer.weight,
      );
      continue;
    }
    consumers.push({
      sourceId: consumer.sourceId,
      label: identity?.label ?? consumer.sourceId,
      path: identity?.path ?? consumer.sourceId,
      edgeCount: consumer.edgeCount,
      weight: consumer.weight,
    });
  }

  return {
    kind: node.kind,
    label:
      node.kind === "external" ? node.normalizedTarget : node.label,
    targetCount: node.targetCount,
    edgeCount: node.edgeCount,
    totalWeight: node.weight,
    kindTotals,
    consumers,
    hiddenConsumerCount,
    hiddenConsumerWeight,
  };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function safeWeightSum(left: number, right: number): number {
  const sum = left + right;
  return Number.isFinite(sum) ? sum : Number.MAX_VALUE;
}
