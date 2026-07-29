import type {
  CityBase,
  CityDependency,
  DependencyKind,
  Vector3,
} from "./model.js";

export const EXTERNAL_DEPENDENCY_NODE_LIMIT = 12;
export const EXTERNAL_DEPENDENCY_VISIBLE_TARGET_LIMIT = 11;
export const EXTERNAL_DEPENDENCY_CONSUMER_LIMIT = 8;
export const EXTERNAL_DEPENDENCY_SEMANTIC_GROUP_ID = "external" as const;
export const EXTERNAL_DEPENDENCY_COLOR = "#111827" as const;
export const EXTERNAL_DEPENDENCY_OVERFLOW_ID =
  "external-overflow\0v1" as const;
export const EXTERNAL_DEPENDENCY_OVERFLOW_LABEL = "Others" as const;
export const EXTERNAL_DEPENDENCY_BOX_SIZE = Object.freeze({
  x: 4,
  y: 3,
  z: 2,
}) satisfies Vector3;
export const EXTERNAL_DEPENDENCY_APRON_MARGIN = 1;
export const EXTERNAL_DEPENDENCY_APRON_GAP = 1;

const DEPENDENCY_KIND_ORDER = Object.freeze([
  "typescript-import",
  "project-reference",
  "package-reference",
] as const satisfies readonly DependencyKind[]);
const DEPENDENCY_KINDS = new Set<DependencyKind>(DEPENDENCY_KIND_ORDER);

export interface ExternalDependencyKindSummary {
  readonly kind: DependencyKind;
  readonly edgeCount: number;
  readonly weight: number;
}

export interface ExternalDependencyConsumerSummary {
  readonly sourceId: string;
  readonly edgeCount: number;
  readonly weight: number;
}

interface ExternalDependencyNodeSummary {
  readonly id: string;
  readonly label: string;
  readonly weight: number;
  readonly targetCount: number;
  readonly edgeCount: number;
  readonly kinds: readonly ExternalDependencyKindSummary[];
  readonly consumers: readonly ExternalDependencyConsumerSummary[];
  readonly hiddenConsumerCount: number;
  readonly hiddenConsumerWeight: number;
}

export interface ExternalDependencyTargetNode
  extends ExternalDependencyNodeSummary {
  readonly kind: "external";
  readonly normalizedTarget: string;
}

export interface ExternalDependencyOverflowNode
  extends ExternalDependencyNodeSummary {
  readonly kind: "external-overflow";
}

export type ExternalDependencySelectionNode =
  | ExternalDependencyTargetNode
  | ExternalDependencyOverflowNode;

export interface ExternalDependencySelection {
  /**
   * Display order: normalized targets in ordinal UTF-16 order, followed by
   * the overflow node when present.
   */
  readonly nodes: readonly ExternalDependencySelectionNode[];
  /**
   * Maps every normalized target to its visible node. Omitted targets map to
   * the overflow node without retaining source text or dependency objects.
   */
  readonly assignments: ReadonlyMap<string, string>;
  readonly ignoredDependencyCount: number;
}

export type ExternalDependencyLayoutNode = ExternalDependencySelectionNode & {
  readonly semanticGroupId: typeof EXTERNAL_DEPENDENCY_SEMANTIC_GROUP_ID;
  readonly position: Vector3;
  readonly size: Vector3;
};

export interface ExternalDependencyLayout
  extends Omit<ExternalDependencySelection, "nodes"> {
  readonly nodes: readonly ExternalDependencyLayoutNode[];
  readonly base?: CityBase;
}

interface MutableSummary {
  weight: number;
  edgeCount: number;
}

interface MutableTargetAggregate extends MutableSummary {
  readonly normalizedTarget: string;
  targetCount: number;
  readonly kinds: Map<DependencyKind, MutableSummary>;
  readonly consumers: Map<string, MutableSummary>;
}

/**
 * The external identity contract is deliberately case-sensitive. Only
 * surrounding whitespace and Unicode normalization are changed.
 */
export function normalizeExternalDependencyTarget(target: string): string {
  if (typeof target !== "string") {
    throw new TypeError("External dependency target must not be empty.");
  }
  const normalized = target.trim().normalize("NFC");
  if (normalized === "") {
    throw new TypeError("External dependency target must not be empty.");
  }
  return normalized;
}

export const normalizeExternalTarget = normalizeExternalDependencyTarget;

/**
 * Aggregates, ranks, and caps external dependencies without mutating the city
 * model. Malformed external records are ignored so direct JSON consumers fail
 * closed rather than emitting invalid geometry.
 */
export function selectExternalDependencies(
  dependencies: readonly CityDependency[] | readonly unknown[],
): ExternalDependencySelection {
  if (!Array.isArray(dependencies)) {
    return emptySelection();
  }

  const validDependencies: Array<
    NonNullable<ReturnType<typeof readExternalDependency>>
  > = [];
  let ignoredDependencyCount = 0;
  for (const value of dependencies) {
    const dependency = readExternalDependency(value);
    if (dependency === undefined) {
      if (looksExternal(value)) {
        ignoredDependencyCount += 1;
      }
      continue;
    }
    validDependencies.push(dependency);
  }

  validDependencies.sort(compareExternalDependency);
  const byTarget = new Map<string, MutableTargetAggregate>();
  for (const dependency of validDependencies) {
    let aggregate = byTarget.get(dependency.normalizedTarget);
    if (aggregate === undefined) {
      aggregate = mutableAggregate(dependency.normalizedTarget);
      byTarget.set(dependency.normalizedTarget, aggregate);
    }
    addDependency(aggregate, dependency);
  }

  const ranked = [...byTarget.values()].sort(compareTargetStrength);
  const overflowMembers =
    ranked.length > EXTERNAL_DEPENDENCY_NODE_LIMIT
      ? ranked.slice(EXTERNAL_DEPENDENCY_VISIBLE_TARGET_LIMIT)
      : [];
  const visible =
    overflowMembers.length > 0
      ? ranked.slice(0, EXTERNAL_DEPENDENCY_VISIBLE_TARGET_LIMIT)
      : ranked;
  const assignments = new Map<string, string>();
  const visibleNodes = visible
    .sort((left, right) =>
      compareOrdinal(left.normalizedTarget, right.normalizedTarget),
    )
    .map((aggregate) => {
      const node = toTargetNode(aggregate);
      assignments.set(aggregate.normalizedTarget, node.id);
      return node;
    });

  let overflowNode: ExternalDependencyOverflowNode | undefined;
  if (overflowMembers.length > 0) {
    const aggregate = mutableAggregate("");
    for (const member of overflowMembers) {
      mergeAggregate(aggregate, member);
      assignments.set(
        member.normalizedTarget,
        EXTERNAL_DEPENDENCY_OVERFLOW_ID,
      );
    }
    overflowNode = toOverflowNode(aggregate);
  }

  return {
    nodes:
      overflowNode === undefined
        ? visibleNodes
        : [...visibleNodes, overflowNode],
    assignments: sortedAssignments(assignments),
    ignoredDependencyCount,
  };
}

/**
 * Places selected nodes on a rear (+Z) apron and returns a derived connected
 * base. The supplied base and CityModel remain unchanged.
 */
export function layoutExternalDependencies(
  selection: ExternalDependencySelection,
  base: CityBase | undefined,
): ExternalDependencyLayout {
  if (selection.nodes.length === 0 || !isUsableBase(base)) {
    return base === undefined
      ? {
          nodes: [],
          assignments: selection.assignments,
          ignoredDependencyCount: selection.ignoredDependencyCount,
        }
      : {
          nodes: [],
          assignments: selection.assignments,
          ignoredDependencyCount: selection.ignoredDependencyCount,
          base,
        };
  }

  const margin = EXTERNAL_DEPENDENCY_APRON_MARGIN;
  const gap = EXTERNAL_DEPENDENCY_APRON_GAP;
  const box = EXTERNAL_DEPENDENCY_BOX_SIZE;
  const apronWidth = Math.max(base.size.x, box.x + 2 * margin);
  const apronMinX = base.position.x - apronWidth / 2;
  const columns = Math.max(
    1,
    Math.floor((apronWidth - 2 * margin + gap) / (box.x + gap)),
  );
  const oldBaseMinZ = base.position.z - base.size.z / 2;
  const oldBaseMaxZ = base.position.z + base.size.z / 2;
  const baseTop = base.position.y + base.size.y / 2;

  const nodes = selection.nodes.map((node, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    return {
      ...node,
      semanticGroupId: EXTERNAL_DEPENDENCY_SEMANTIC_GROUP_ID,
      position: {
        x:
          apronMinX +
          margin +
          box.x / 2 +
          column * (box.x + gap),
        y: baseTop + box.y / 2,
        z:
          oldBaseMaxZ +
          margin +
          box.z / 2 +
          row * (box.z + gap),
      },
      size: { ...box },
    } satisfies ExternalDependencyLayoutNode;
  });
  const rowCount = Math.ceil(nodes.length / columns);
  const newBaseMaxZ =
    oldBaseMaxZ +
    margin +
    rowCount * box.z +
    (rowCount - 1) * gap +
    margin;
  const newBaseDepth = newBaseMaxZ - oldBaseMinZ;
  const derivedBase: CityBase = {
    ...base,
    position: {
      ...base.position,
      z: oldBaseMinZ + newBaseDepth / 2,
    },
    size: {
      ...base.size,
      x: apronWidth,
      z: newBaseDepth,
    },
  };

  return {
    nodes,
    assignments: selection.assignments,
    ignoredDependencyCount: selection.ignoredDependencyCount,
    base: derivedBase,
  };
}

export function resolveExternalDependencyNode<
  Node extends ExternalDependencySelectionNode,
>(
  plan: {
    readonly nodes: readonly Node[];
    readonly assignments: ReadonlyMap<string, string>;
  },
  target: unknown,
): Node | undefined {
  let normalizedTarget: string;
  try {
    normalizedTarget = normalizeExternalDependencyTarget(target as string);
  } catch {
    return undefined;
  }
  const nodeId = plan.assignments.get(normalizedTarget);
  return nodeId === undefined
    ? undefined
    : plan.nodes.find(({ id }) => id === nodeId);
}

function emptySelection(): ExternalDependencySelection {
  return {
    nodes: [],
    assignments: new Map(),
    ignoredDependencyCount: 0,
  };
}

function compareExternalDependency(
  left: NonNullable<ReturnType<typeof readExternalDependency>>,
  right: NonNullable<ReturnType<typeof readExternalDependency>>,
): number {
  return (
    compareOrdinal(left.normalizedTarget, right.normalizedTarget) ||
    compareOrdinal(left.sourceId, right.sourceId) ||
    DEPENDENCY_KIND_ORDER.indexOf(left.kind) -
      DEPENDENCY_KIND_ORDER.indexOf(right.kind) ||
    left.weight - right.weight
  );
}

function looksExternal(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "externalTarget" in value
  );
}

function readExternalDependency(value: unknown):
  | {
      readonly normalizedTarget: string;
      readonly sourceId: string;
      readonly kind: DependencyKind;
      readonly weight: number;
    }
  | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Partial<CityDependency>;
  if (candidate.externalTarget === undefined) return undefined;
  if (
    candidate.targetId !== undefined ||
    typeof candidate.sourceId !== "string" ||
    candidate.sourceId.trim() === "" ||
    !DEPENDENCY_KINDS.has(candidate.kind as DependencyKind) ||
    typeof candidate.weight !== "number" ||
    !Number.isFinite(candidate.weight) ||
    candidate.weight <= 0
  ) {
    return undefined;
  }
  try {
    return {
      normalizedTarget: normalizeExternalDependencyTarget(
        candidate.externalTarget,
      ),
      sourceId: candidate.sourceId,
      kind: candidate.kind as DependencyKind,
      weight: candidate.weight,
    };
  } catch {
    return undefined;
  }
}

function mutableAggregate(normalizedTarget: string): MutableTargetAggregate {
  return {
    normalizedTarget,
    weight: 0,
    targetCount: normalizedTarget === "" ? 0 : 1,
    edgeCount: 0,
    kinds: new Map(),
    consumers: new Map(),
  };
}

function addDependency(
  aggregate: MutableTargetAggregate,
  dependency: {
    readonly sourceId: string;
    readonly kind: DependencyKind;
    readonly weight: number;
  },
): void {
  aggregate.weight = addWeight(aggregate.weight, dependency.weight);
  aggregate.edgeCount += 1;
  addSummary(aggregate.kinds, dependency.kind, 1, dependency.weight);
  addSummary(aggregate.consumers, dependency.sourceId, 1, dependency.weight);
}

function mergeAggregate(
  target: MutableTargetAggregate,
  source: MutableTargetAggregate,
): void {
  target.weight = addWeight(target.weight, source.weight);
  target.targetCount += source.targetCount;
  target.edgeCount += source.edgeCount;
  for (const [kind, summary] of source.kinds) {
    addSummary(target.kinds, kind, summary.edgeCount, summary.weight);
  }
  for (const [sourceId, summary] of source.consumers) {
    addSummary(
      target.consumers,
      sourceId,
      summary.edgeCount,
      summary.weight,
    );
  }
}

function addSummary<Key>(
  summaries: Map<Key, MutableSummary>,
  key: Key,
  edgeCount: number,
  weight: number,
): void {
  const current = summaries.get(key);
  if (current === undefined) {
    summaries.set(key, { edgeCount, weight });
    return;
  }
  current.edgeCount += edgeCount;
  current.weight = addWeight(current.weight, weight);
}

function addWeight(left: number, right: number): number {
  const sum = left + right;
  return Number.isFinite(sum) ? sum : Number.MAX_VALUE;
}

function compareTargetStrength(
  left: MutableTargetAggregate,
  right: MutableTargetAggregate,
): number {
  return (
    right.weight - left.weight ||
    compareOrdinal(left.normalizedTarget, right.normalizedTarget)
  );
}

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function toTargetNode(
  aggregate: MutableTargetAggregate,
): ExternalDependencyTargetNode {
  return {
    ...summarize(aggregate),
    id: `external\0${aggregate.normalizedTarget}`,
    kind: "external",
    normalizedTarget: aggregate.normalizedTarget,
    label: aggregate.normalizedTarget,
    targetCount: 1,
  };
}

function toOverflowNode(
  aggregate: MutableTargetAggregate,
): ExternalDependencyOverflowNode {
  return {
    ...summarize(aggregate),
    id: EXTERNAL_DEPENDENCY_OVERFLOW_ID,
    kind: "external-overflow",
    label: EXTERNAL_DEPENDENCY_OVERFLOW_LABEL,
    targetCount: aggregate.targetCount,
  };
}

function summarize(
  aggregate: MutableTargetAggregate,
): Omit<
  ExternalDependencyNodeSummary,
  "id" | "label" | "targetCount"
> {
  const kinds = DEPENDENCY_KIND_ORDER.flatMap((kind) => {
    const summary = aggregate.kinds.get(kind);
    return summary === undefined
      ? []
      : [{ kind, ...summary } satisfies ExternalDependencyKindSummary];
  });
  const rankedConsumers = [...aggregate.consumers.entries()]
    .map(([sourceId, summary]) => ({ sourceId, ...summary }))
    .sort(
      (left, right) =>
        right.weight - left.weight ||
        compareOrdinal(left.sourceId, right.sourceId),
    );
  const consumers = rankedConsumers.slice(
    0,
    EXTERNAL_DEPENDENCY_CONSUMER_LIMIT,
  );
  const hiddenConsumers = rankedConsumers.slice(
    EXTERNAL_DEPENDENCY_CONSUMER_LIMIT,
  );

  return {
    weight: aggregate.weight,
    edgeCount: aggregate.edgeCount,
    kinds,
    consumers,
    hiddenConsumerCount: hiddenConsumers.length,
    hiddenConsumerWeight: hiddenConsumers.reduce(
      (sum, consumer) => addWeight(sum, consumer.weight),
      0,
    ),
  };
}

function sortedAssignments(
  assignments: ReadonlyMap<string, string>,
): ReadonlyMap<string, string> {
  return new Map(
    [...assignments.entries()].sort(([left], [right]) =>
      compareOrdinal(left, right),
    ),
  );
}

function isUsableBase(base: CityBase | undefined): base is CityBase {
  if (base === undefined) return false;
  return (
    finiteVector(base.position) &&
    finiteVector(base.size) &&
    base.size.x > 0 &&
    base.size.y > 0 &&
    base.size.z > 0
  );
}

function finiteVector(value: Vector3): boolean {
  return (
    Number.isFinite(value.x) &&
    Number.isFinite(value.y) &&
    Number.isFinite(value.z)
  );
}
