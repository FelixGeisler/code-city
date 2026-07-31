import type {
  CityBuilding,
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
    "id" | "name" | "position" | "size"
  >[];
  readonly renamedBuildingIds: readonly string[];
  readonly resizedBuildingIds: readonly string[];
  readonly changedBuildingIds: readonly string[];
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
  });
}
