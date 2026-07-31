import type {
  CityBuilding,
  CityDependency,
  CityModel,
  EvolutionBundle,
  EvolutionChangeKind,
  EvolutionCommitMetadata,
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
  readonly addedDependencyIds: readonly string[];
  readonly removedDependencyIds: readonly string[];
  readonly changedDependencyIds: readonly string[];
  readonly retargetedDependencyIds: readonly string[];
  readonly affectedDependencyRouteIds: readonly string[];
  readonly affectedDependencyEndpointKeys: readonly string[];
  readonly interpolatedBuildings: readonly {
    readonly id: string;
    readonly position: CityBuilding["position"];
    readonly size: CityBuilding["size"];
  }[];
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

export function summarizeEvolutionFrames(
  bundle: EvolutionBundle,
): readonly EvolutionFrameSummary[] {
  return commits(bundle).map(({ index, sha, committedAt }) =>
    Object.freeze({ index, sha, committedAt }),
  );
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

function dependencyResolution(
  dependency: CityDependency,
): "internal" | "external" | "unresolved" {
  return (
    dependency.resolution ??
    (dependency.targetId !== undefined
      ? "internal"
      : dependency.externalTarget !== undefined
        ? "external"
        : "unresolved")
  );
}

export function evolutionDependencyChanged(
  left: CityDependency,
  right: CityDependency,
): boolean {
  return (
    left.repositoryId !== right.repositoryId ||
    left.sourceId !== right.sourceId ||
    left.targetId !== right.targetId ||
    left.externalTarget !== right.externalTarget ||
    dependencyResolution(left) !== dependencyResolution(right) ||
    left.kind !== right.kind ||
    left.version !== right.version ||
    left.weight !== right.weight
  );
}

export function evolutionDependencyRetargeted(
  left: CityDependency,
  right: CityDependency,
): boolean {
  return (
    left.targetId !== right.targetId ||
    left.externalTarget !== right.externalTarget ||
    dependencyResolution(left) !== dependencyResolution(right)
  );
}

export function evolutionDependencyEndpointKeys(
  dependency: CityDependency,
): readonly string[] {
  return Object.freeze([
    `entity:${dependency.sourceId}`,
    ...(dependency.targetId === undefined
      ? []
      : [`entity:${dependency.targetId}`]),
    ...(dependency.externalTarget === undefined
      ? []
      : [`external:${dependency.externalTarget}`]),
  ]);
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
  const sourceDependencies = new Map(
    from.dependencies.map((dependency) => [dependency.id, dependency]),
  );
  const targetDependencyIds = new Set<string>();
  const addedDependencyIds: string[] = [];
  const removedDependencyIds: string[] = [];
  const changedDependencyIds: string[] = [];
  const retargetedDependencyIds: string[] = [];
  const affectedDependencyRouteIds = new Set<string>();
  const affectedDependencyEndpointKeys = new Set<string>();
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
  for (const dependency of to.dependencies) {
    targetDependencyIds.add(dependency.id);
    const previous = sourceDependencies.get(dependency.id);
    if (previous === undefined) {
      addedDependencyIds.push(dependency.id);
      affectedDependencyRouteIds.add(dependency.id);
      evolutionDependencyEndpointKeys(dependency).forEach((key) =>
        affectedDependencyEndpointKeys.add(key),
      );
      continue;
    }
    if (!evolutionDependencyChanged(previous, dependency)) continue;
    changedDependencyIds.push(dependency.id);
    affectedDependencyRouteIds.add(dependency.id);
    if (evolutionDependencyRetargeted(previous, dependency)) {
      retargetedDependencyIds.push(dependency.id);
    }
    [
      ...evolutionDependencyEndpointKeys(previous),
      ...evolutionDependencyEndpointKeys(dependency),
    ].forEach((key) => affectedDependencyEndpointKeys.add(key));
  }
  for (const dependency of from.dependencies) {
    if (targetDependencyIds.has(dependency.id)) continue;
    removedDependencyIds.push(dependency.id);
    affectedDependencyRouteIds.add(dependency.id);
    evolutionDependencyEndpointKeys(dependency).forEach((key) =>
      affectedDependencyEndpointKeys.add(key),
    );
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
    addedDependencyIds: Object.freeze(addedDependencyIds.sort()),
    removedDependencyIds: Object.freeze(removedDependencyIds.sort()),
    changedDependencyIds: Object.freeze(changedDependencyIds.sort()),
    retargetedDependencyIds: Object.freeze(retargetedDependencyIds.sort()),
    affectedDependencyRouteIds: Object.freeze(
      [...affectedDependencyRouteIds].sort(),
    ),
    affectedDependencyEndpointKeys: Object.freeze(
      [...affectedDependencyEndpointKeys].sort(),
    ),
    interpolatedBuildings: Object.freeze(
      interpolatedBuildings.sort((left, right) =>
        compareText(left.id, right.id),
      ),
    ),
  });
}
