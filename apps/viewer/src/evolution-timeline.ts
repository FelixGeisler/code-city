import {
  normalizeExternalDependencyTarget,
  type CityBuilding,
  type CityDependency,
  type CityModel,
  type EvolutionBundle,
  type EvolutionChangeKind,
  type EvolutionCommitMetadata,
} from "../../../packages/core/src/index.js";

export interface EvolutionFrameSummary {
  readonly index: number;
  readonly sha: string;
  readonly committedAt: string;
}

export interface EvolutionBuildingHistory {
  readonly id: string;
  readonly firstFrame: number;
  readonly lastFrame: number;
  readonly removedAtFrame?: number;
  readonly changeCount: number;
  readonly changeKinds: readonly EvolutionChangeKind[];
}

export interface EvolutionBuildingLineageSelection {
  readonly id: string;
  readonly lastKnownBuilding: CityBuilding;
}

export type EvolutionBuildingLineageState =
  | {
      readonly kind: "not-yet-created";
      readonly creationFrame: number;
    }
  | {
      readonly kind: "present";
    }
  | {
      readonly kind: "removed";
      readonly removalFrame: number;
    };

export type EvolutionBuildingLineageResolution =
  | {
      readonly selection: EvolutionBuildingLineageSelection;
      readonly state: Extract<
        EvolutionBuildingLineageState,
        { readonly kind: "not-yet-created" | "removed" }
      >;
    }
  | {
      readonly building: CityBuilding;
      readonly selection: EvolutionBuildingLineageSelection;
      readonly state: Extract<
        EvolutionBuildingLineageState,
        { readonly kind: "present" }
      >;
    };

export type EvolutionDependencyEndpointIdentity =
  | {
      readonly kind: "entity";
      readonly entityKind: "building" | "module";
      readonly id: string;
      readonly key: string;
    }
  | {
      readonly kind: "external";
      readonly target: string;
      readonly key: string;
    };

export interface EvolutionDependencyRouteIdentity {
  readonly dependencyId: string;
  readonly routeKey: string;
  readonly source: Extract<
    EvolutionDependencyEndpointIdentity,
    { readonly kind: "entity" }
  >;
  readonly target: EvolutionDependencyEndpointIdentity;
}

export interface EvolutionRetargetedDependency {
  readonly dependencyId: string;
  readonly before: EvolutionDependencyRouteIdentity;
  readonly after: EvolutionDependencyRouteIdentity;
}

export interface EvolutionDependencyChanges {
  readonly added: readonly EvolutionDependencyRouteIdentity[];
  readonly removed: readonly EvolutionDependencyRouteIdentity[];
  readonly changed: readonly EvolutionDependencyRouteIdentity[];
  readonly retargeted: readonly EvolutionRetargetedDependency[];
  readonly affectedEndpoints: readonly EvolutionDependencyEndpointIdentity[];
  readonly affectedRouteKeys: readonly string[];
}

export interface EvolutionTransition {
  readonly fromIndex: number;
  readonly toIndex: number;
  readonly addedBuildingIds: readonly string[];
  readonly removedBuildings: readonly Pick<
    CityBuilding,
    "id" | "name" | "districtId" | "position" | "size"
  >[];
  readonly renamedBuildingIds: readonly string[];
  readonly resizedBuildingIds: readonly string[];
  readonly changedBuildingIds: readonly string[];
  readonly interpolatedBuildings: readonly {
    readonly id: string;
    readonly position: CityBuilding["position"];
    readonly size: CityBuilding["size"];
  }[];
  readonly dependencyChanges: EvolutionDependencyChanges;
}

export interface EvolutionFrameAnalysis {
  readonly ageByBuildingId: readonly (readonly [string, number])[];
  readonly churnByBuildingId: readonly (readonly [string, number])[];
}

export class EvolutionSeekGate {
  #generation = 0;
  #busy = false;
  #failure: string | undefined;

  public get busy(): boolean {
    return this.#busy;
  }

  public get failure(): string | undefined {
    return this.#failure;
  }

  public begin(): number {
    this.#busy = true;
    this.#failure = undefined;
    this.#generation += 1;
    return this.#generation;
  }

  public isCurrent(generation: number): boolean {
    return generation === this.#generation;
  }

  public settle(generation: number): boolean {
    if (!this.isCurrent(generation)) return false;
    this.#busy = false;
    this.#failure = undefined;
    return true;
  }

  public fail(generation: number, message: string): boolean {
    if (!this.isCurrent(generation)) return false;
    this.#busy = false;
    this.#failure = message;
    return true;
  }

  public cancel(): boolean {
    const wasBusy = this.#busy;
    this.#generation += 1;
    this.#busy = false;
    this.#failure = undefined;
    return wasBusy;
  }
}

export interface EvolutionDeferredSeekControllerOptions<TResult> {
  readonly currentIndex: () => number;
  readonly request: (
    fromIndex: number,
    targetIndex: number,
  ) => Promise<TResult>;
  readonly cancelRequest: () => void;
  readonly render: () => void;
  readonly failureMessage?: (error: unknown) => string;
}

export interface EvolutionDeferredSeekApplication<TResult> {
  readonly result: TResult;
  readonly fromIndex: number;
  readonly targetIndex: number;
}

/**
 * Owns the complete deferred seek lifecycle used by the timeline UI.
 *
 * The controller deliberately keeps the requested target separate from the
 * currently applied frame. That lets rendering retain the newest slider value
 * while an older request settles, without allowing a stale result to mutate
 * either the city or the visible failure state.
 */
export class EvolutionDeferredSeekController<TResult> {
  readonly #gate = new EvolutionSeekGate();
  readonly #options: EvolutionDeferredSeekControllerOptions<TResult>;
  #targetIndex: number | undefined;

  public constructor(
    options: EvolutionDeferredSeekControllerOptions<TResult>,
  ) {
    this.#options = options;
  }

  public get busy(): boolean {
    return this.#gate.busy;
  }

  public get failure(): string | undefined {
    return this.#gate.failure;
  }

  public get targetIndex(): number | undefined {
    return this.#targetIndex;
  }

  public async seek(
    targetIndex: number,
    apply: (value: EvolutionDeferredSeekApplication<TResult>) => void,
  ): Promise<boolean> {
    const fromIndex = this.#options.currentIndex();
    if (targetIndex === fromIndex) {
      const wasBusy = this.#gate.cancel();
      this.#targetIndex = undefined;
      if (wasBusy) this.#options.cancelRequest();
      this.#options.render();
      return true;
    }

    if (this.#gate.busy) this.#options.cancelRequest();
    const generation = this.#gate.begin();
    this.#targetIndex = targetIndex;
    this.#options.render();

    try {
      const result = await this.#options.request(fromIndex, targetIndex);
      if (!this.#gate.isCurrent(generation)) return false;
      apply({ result, fromIndex, targetIndex });
      if (!this.#gate.settle(generation)) return false;
      this.#targetIndex = undefined;
      this.#options.render();
      return true;
    } catch (error) {
      if (!this.#gate.isCurrent(generation)) return false;
      this.#targetIndex = undefined;
      if (error instanceof DOMException && error.name === "AbortError") {
        this.#gate.settle(generation);
      } else {
        this.#gate.fail(
          generation,
          this.#options.failureMessage?.(error) ??
            (error instanceof Error
              ? error.message
              : "The frame could not be shown."),
        );
      }
      this.#options.render();
      return false;
    }
  }

  public cancel(): boolean {
    const hadFailure = this.#gate.failure !== undefined;
    const wasBusy = this.#gate.cancel();
    this.#targetIndex = undefined;
    if (wasBusy) this.#options.cancelRequest();
    if (wasBusy || hadFailure) this.#options.render();
    return wasBusy;
  }
}

function commits(bundle: EvolutionBundle): readonly EvolutionCommitMetadata[] {
  return [bundle.baseline.commit, ...bundle.deltas.map(({ commit }) => commit)];
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function identityKey(kind: string, value: string): string {
  return `${kind}:${value.length}:${value}`;
}

export function evolutionDependencyEndpointKey(
  endpoint:
    | {
        readonly kind: "entity";
        readonly entityKind: "building" | "module";
        readonly id: string;
      }
    | { readonly kind: "external"; readonly target: string },
): string {
  return endpoint.kind === "entity"
    ? identityKey(
        "entity",
        identityKey(endpoint.entityKind, endpoint.id),
      )
    : identityKey(
        "external",
        normalizeExternalDependencyTarget(endpoint.target),
      );
}

export function evolutionDependencyRouteKey(
  source: EvolutionDependencyEndpointIdentity,
  target: EvolutionDependencyEndpointIdentity,
): string {
  return (
    identityKey("source", source.key) +
    identityKey("target", target.key)
  );
}

function dependencyEntityEndpoint(
  entityKind: "building" | "module",
  id: string,
): Extract<
  EvolutionDependencyEndpointIdentity,
  { readonly kind: "entity" }
> {
  const endpoint = { kind: "entity", entityKind, id } as const;
  return Object.freeze({
    ...endpoint,
    key: evolutionDependencyEndpointKey(endpoint),
  });
}

function dependencyExternalEndpoint(
  value: string,
): Extract<
  EvolutionDependencyEndpointIdentity,
  { readonly kind: "external" }
> {
  const target = normalizeExternalDependencyTarget(value);
  const endpoint = { kind: "external", target } as const;
  return Object.freeze({
    ...endpoint,
    key: evolutionDependencyEndpointKey(endpoint),
  });
}

function dependencyRouteIdentity(
  dependency: CityDependency,
): EvolutionDependencyRouteIdentity {
  const entityKind =
    dependency.kind === "typescript-import"
      ? "building"
      : "module";
  const source = dependencyEntityEndpoint(
    entityKind,
    dependency.sourceId,
  );
  const target =
    dependency.targetId === undefined
      ? dependencyExternalEndpoint(dependency.externalTarget!)
      : dependencyEntityEndpoint(entityKind, dependency.targetId);
  return Object.freeze({
    dependencyId: dependency.id,
    routeKey: evolutionDependencyRouteKey(source, target),
    source,
    target,
  });
}

function effectiveDependencyResolution(
  dependency: CityDependency,
): NonNullable<CityDependency["resolution"]> {
  return (
    dependency.resolution ??
    (dependency.targetId === undefined ? "external" : "internal")
  );
}

function dependencyMetadataChanged(
  before: CityDependency,
  after: CityDependency,
): boolean {
  return (
    before.repositoryId !== after.repositoryId ||
    before.kind !== after.kind ||
    before.version !== after.version ||
    before.weight !== after.weight ||
    effectiveDependencyResolution(before) !==
      effectiveDependencyResolution(after)
  );
}

/**
 * Accumulates dependency comparisons visited in ascending dependency-id order.
 * Both the pure comparator and the worker use this path, keeping categorization
 * and stable route identity exactly aligned without a large, non-yielding sort
 * at the end of worker work.
 */
export class EvolutionDependencyChangeCollector {
  readonly #added: EvolutionDependencyRouteIdentity[] = [];
  readonly #removed: EvolutionDependencyRouteIdentity[] = [];
  readonly #changed: EvolutionDependencyRouteIdentity[] = [];
  readonly #retargeted: EvolutionRetargetedDependency[] = [];
  readonly #affectedEndpoints: EvolutionDependencyEndpointIdentity[] = [];
  readonly #affectedEndpointKeys = new Set<string>();
  readonly #affectedRouteKeys: string[] = [];
  readonly #affectedRouteKeySet = new Set<string>();
  #lastDependencyId: string | undefined;
  #finished = false;

  public add(
    before: CityDependency | undefined,
    after: CityDependency | undefined,
  ): void {
    if (this.#finished) {
      throw new Error("Dependency change collection has already finished.");
    }
    if (
      (before === undefined && after === undefined) ||
      (before !== undefined &&
        after !== undefined &&
        before.id !== after.id)
    ) {
      throw new TypeError(
        "Dependency comparison requires one stable dependency identity.",
      );
    }
    const dependencyId = (after ?? before)!.id;
    if (
      this.#lastDependencyId !== undefined &&
      compareText(this.#lastDependencyId, dependencyId) >= 0
    ) {
      throw new TypeError(
        "Dependency comparisons must use ascending unique dependency ids.",
      );
    }
    this.#lastDependencyId = dependencyId;

    if (before === undefined) {
      const route = dependencyRouteIdentity(after!);
      this.#added.push(route);
      this.#affect(route);
      return;
    }
    if (after === undefined) {
      const route = dependencyRouteIdentity(before);
      this.#removed.push(route);
      this.#affect(route);
      return;
    }
    const beforeRoute = dependencyRouteIdentity(before);
    const afterRoute = dependencyRouteIdentity(after);
    if (beforeRoute.routeKey !== afterRoute.routeKey) {
      this.#retargeted.push(
        Object.freeze({
          dependencyId,
          before: beforeRoute,
          after: afterRoute,
        }),
      );
      this.#affect(beforeRoute);
      this.#affect(afterRoute);
      return;
    }
    if (dependencyMetadataChanged(before, after)) {
      this.#changed.push(afterRoute);
      this.#affect(afterRoute);
    }
  }

  public finish(): EvolutionDependencyChanges {
    if (this.#finished) {
      throw new Error("Dependency change collection has already finished.");
    }
    this.#finished = true;
    return Object.freeze({
      added: Object.freeze(this.#added),
      removed: Object.freeze(this.#removed),
      changed: Object.freeze(this.#changed),
      retargeted: Object.freeze(this.#retargeted),
      affectedEndpoints: Object.freeze(this.#affectedEndpoints),
      affectedRouteKeys: Object.freeze(this.#affectedRouteKeys),
    });
  }

  #affect(route: EvolutionDependencyRouteIdentity): void {
    this.#affectEndpoint(route.source);
    this.#affectEndpoint(route.target);
    if (!this.#affectedRouteKeySet.has(route.routeKey)) {
      this.#affectedRouteKeySet.add(route.routeKey);
      this.#affectedRouteKeys.push(route.routeKey);
    }
  }

  #affectEndpoint(endpoint: EvolutionDependencyEndpointIdentity): void {
    if (this.#affectedEndpointKeys.has(endpoint.key)) return;
    this.#affectedEndpointKeys.add(endpoint.key);
    this.#affectedEndpoints.push(endpoint);
  }
}

export function compareEvolutionDependencies(
  from: readonly CityDependency[],
  to: readonly CityDependency[],
): EvolutionDependencyChanges {
  const source = new Map(from.map((dependency) => [dependency.id, dependency]));
  const target = new Map(to.map((dependency) => [dependency.id, dependency]));
  const dependencyIds = [...new Set([...source.keys(), ...target.keys()])].sort(
    compareText,
  );
  const collector = new EvolutionDependencyChangeCollector();
  for (const id of dependencyIds) {
    collector.add(source.get(id), target.get(id));
  }
  return collector.finish();
}

export function summarizeEvolutionFrames(
  bundle: EvolutionBundle,
): readonly EvolutionFrameSummary[] {
  return commits(bundle).map(({ index, sha, committedAt }) =>
    Object.freeze({ index, sha, committedAt }),
  );
}

export function evolutionPlaybackStartIndex(
  bundle: EvolutionBundle,
): number {
  const projectStartSha =
    bundle.selection.mode === "root-to-tip"
      ? bundle.selection.projectStartSha
      : undefined;
  if (projectStartSha === undefined) return 0;
  const index = bundle.selection.sampledCommitShas.indexOf(projectStartSha);
  return index < 0 ? 0 : index;
}

export function analyzeEvolutionBuildingHistory(
  bundle: EvolutionBundle,
): readonly EvolutionBuildingHistory[] {
  const histories = new Map<
    string,
    {
      firstFrame: number;
      lastFrame: number;
      removedAtFrame?: number;
      changeCount: number;
      changeKinds: Set<EvolutionChangeKind>;
    }
  >();
  const present = new Set<string>();
  for (const building of bundle.baseline.model.buildings) {
    present.add(building.id);
    histories.set(building.id, {
      firstFrame: 0,
      lastFrame: 0,
      changeCount: 0,
      changeKinds: new Set(),
    });
  }
  for (const [offset, frame] of bundle.deltas.entries()) {
    const frameIndex = offset + 1;
    for (const building of frame.changes.buildings.added) {
      const previous = histories.get(building.id);
      histories.set(building.id, {
        firstFrame: previous?.firstFrame ?? frameIndex,
        lastFrame: frameIndex,
        changeCount: (previous?.changeCount ?? 0) + 1,
        changeKinds: previous?.changeKinds ?? new Set(),
      });
      present.add(building.id);
    }
    for (const replacement of frame.changes.buildings.changed) {
      const history = histories.get(replacement.id);
      if (!history) continue;
      history.lastFrame = frameIndex;
      delete history.removedAtFrame;
      history.changeCount += 1;
      replacement.changeKinds.forEach((kind) =>
        history.changeKinds.add(kind),
      );
    }
    for (const id of frame.changes.buildings.removed) {
      const history = histories.get(id);
      if (!history) continue;
      history.lastFrame = frameIndex - 1;
      history.removedAtFrame = frameIndex;
      history.changeCount += 1;
      present.delete(id);
    }
    for (const id of present) {
      const history = histories.get(id);
      if (history) history.lastFrame = frameIndex;
    }
  }
  return [...histories.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([id, history]) =>
      Object.freeze({
        id,
        firstFrame: history.firstFrame,
        lastFrame: history.lastFrame,
        ...(history.removedAtFrame === undefined
          ? {}
          : { removedAtFrame: history.removedAtFrame }),
        changeCount: history.changeCount,
        changeKinds: Object.freeze([...history.changeKinds].sort()),
      }),
    );
}

export function createEvolutionBuildingLineageSelection(
  building: CityBuilding,
): EvolutionBuildingLineageSelection {
  return Object.freeze({
    id: building.id,
    lastKnownBuilding: building,
  });
}

/**
 * Resolves one remembered stable lineage against a replayed frame.
 *
 * Evolution validation guarantees a lineage is present continuously from its
 * first frame until its optional removal frame and cannot be resurrected.
 * Checking the replayed model as well makes inconsistent worker/history data
 * fail closed instead of showing historically false tombstone wording.
 */
export function resolveEvolutionBuildingLineage(
  selection: EvolutionBuildingLineageSelection,
  history: EvolutionBuildingHistory,
  targetFrame: number,
  presentBuilding?: CityBuilding,
): EvolutionBuildingLineageResolution | undefined {
  if (
    history.id !== selection.id ||
    !Number.isSafeInteger(targetFrame) ||
    targetFrame < 0 ||
    (presentBuilding !== undefined &&
      presentBuilding.id !== selection.id)
  ) {
    return undefined;
  }

  let state: EvolutionBuildingLineageState;
  if (targetFrame < history.firstFrame) {
    if (presentBuilding !== undefined) return undefined;
    state = Object.freeze({
      kind: "not-yet-created",
      creationFrame: history.firstFrame,
    });
  } else if (
    history.removedAtFrame !== undefined &&
    targetFrame >= history.removedAtFrame
  ) {
    if (presentBuilding !== undefined) return undefined;
    state = Object.freeze({
      kind: "removed",
      removalFrame: history.removedAtFrame,
    });
  } else {
    if (
      presentBuilding === undefined ||
      targetFrame > history.lastFrame
    ) {
      return undefined;
    }
    state = Object.freeze({ kind: "present" });
  }

  const nextSelection =
    presentBuilding === undefined ||
    presentBuilding === selection.lastKnownBuilding
      ? selection
      : createEvolutionBuildingLineageSelection(presentBuilding);
  return state.kind === "present"
    ? Object.freeze({
        building: presentBuilding!,
        selection: nextSelection,
        state,
      })
    : Object.freeze({ selection: nextSelection, state });
}

export function analyzeEvolutionFrame(
  bundle: EvolutionBundle,
  targetIndex: number,
): EvolutionFrameAnalysis {
  const firstSeen = new Map<string, number>();
  const churn = new Map<string, number>();
  const present = new Set<string>();
  for (const building of bundle.baseline.model.buildings) {
    firstSeen.set(building.id, 0);
    churn.set(building.id, 0);
    present.add(building.id);
  }
  for (let offset = 0; offset < targetIndex; offset += 1) {
    const frame = bundle.deltas[offset];
    if (!frame) break;
    const frameIndex = offset + 1;
    for (const building of frame.changes.buildings.added) {
      if (!firstSeen.has(building.id)) firstSeen.set(building.id, frameIndex);
      churn.set(building.id, (churn.get(building.id) ?? 0) + 1);
      present.add(building.id);
    }
    for (const replacement of frame.changes.buildings.changed) {
      churn.set(replacement.id, (churn.get(replacement.id) ?? 0) + 1);
    }
    for (const id of frame.changes.buildings.removed) {
      churn.set(id, (churn.get(id) ?? 0) + 1);
      present.delete(id);
    }
  }
  return {
    ageByBuildingId: [...present]
      .sort()
      .map((id) => [id, targetIndex - (firstSeen.get(id) ?? targetIndex)]),
    churnByBuildingId: [...present]
      .sort()
      .map((id) => [id, churn.get(id) ?? 0]),
  };
}

function vectorChanged(
  left: CityBuilding["size"],
  right: CityBuilding["size"],
): boolean {
  return left.x !== right.x || left.y !== right.y || left.z !== right.z;
}

export function compareEvolutionFrames(
  from: CityModel,
  to: CityModel,
  fromIndex: number,
  toIndex: number,
): EvolutionTransition {
  const source = new Map(from.buildings.map((building) => [building.id, building]));
  const target = new Map(to.buildings.map((building) => [building.id, building]));
  const addedBuildingIds: string[] = [];
  const removedBuildings: EvolutionTransition["removedBuildings"][number][] = [];
  const renamedBuildingIds: string[] = [];
  const resizedBuildingIds: string[] = [];
  const changedBuildingIds: string[] = [];
  const interpolatedBuildings: EvolutionTransition["interpolatedBuildings"][number][] =
    [];
  for (const [id, building] of target) {
    const previous = source.get(id);
    if (!previous) {
      addedBuildingIds.push(id);
      continue;
    }
    const renamed =
      previous.name !== building.name || previous.path !== building.path;
    const resized =
      vectorChanged(previous.size, building.size) ||
      vectorChanged(previous.position, building.position);
    if (renamed) renamedBuildingIds.push(id);
    if (resized) {
      resizedBuildingIds.push(id);
      interpolatedBuildings.push({
        id,
        position: previous.position,
        size: previous.size,
      });
    }
    if (
      renamed ||
      resized ||
      JSON.stringify(previous.metrics) !== JSON.stringify(building.metrics) ||
      previous.districtId !== building.districtId ||
      previous.semanticGroupId !== building.semanticGroupId
    ) {
      changedBuildingIds.push(id);
    }
  }
  for (const [id, building] of source) {
    if (target.has(id)) continue;
    removedBuildings.push({
      id,
      name: building.name,
      districtId: building.districtId,
      position: building.position,
      size: building.size,
    });
  }
  return Object.freeze({
    fromIndex,
    toIndex,
    addedBuildingIds: Object.freeze(addedBuildingIds.sort()),
    removedBuildings: Object.freeze(
      removedBuildings.sort((left, right) => compareText(left.id, right.id)),
    ),
    renamedBuildingIds: Object.freeze(renamedBuildingIds.sort()),
    resizedBuildingIds: Object.freeze(resizedBuildingIds.sort()),
    changedBuildingIds: Object.freeze(changedBuildingIds.sort()),
    interpolatedBuildings: Object.freeze(
      interpolatedBuildings.sort((left, right) =>
        compareText(left.id, right.id),
      ),
    ),
    dependencyChanges: compareEvolutionDependencies(
      from.dependencies,
      to.dependencies,
    ),
  });
}
