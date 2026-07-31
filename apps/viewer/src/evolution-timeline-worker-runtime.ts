import {
  EVOLUTION_ENTITY_COLLECTIONS,
  replayValidatedEvolutionBundle,
  validateEvolutionBundle,
  type CityBuilding,
  type CityModel,
  type EvolutionBundle,
  type EvolutionChanges,
  type EvolutionEntityDelta,
} from "../../../packages/core/src/index.js";
import {
  analyzeEvolutionBuildingHistory,
  EvolutionDependencyChangeCollector,
  summarizeEvolutionFrames,
  type EvolutionFrameAnalysis,
  type EvolutionTransition,
} from "./evolution-timeline.js";
import {
  evolutionWorkerFailureMessage,
  isEvolutionWorkerRequest,
  type EvolutionWorkerRequest,
  type EvolutionWorkerResponse,
} from "./evolution-timeline-protocol.js";

/**
 * Cooperative work is returned to the worker event loop at least once per
 * this many visited JSON values or evolution entities. A cancel or newer seek
 * can therefore replace large replay, clone, analysis, and transition work
 * without waiting for a whole frame to finish.
 */
export const EVOLUTION_WORK_CHECKPOINT_INTERVAL = 256;

/**
 * Retain every tenth successfully replayed frame. Validated artifacts contain
 * at most 100 frames, so this keeps at most nine intermediate models while
 * bounding each warm frame reconstruction to nine delta applications. A
 * request with two uncached endpoints can reconstruct both.
 */
export const EVOLUTION_REPLAY_CHECKPOINT_INTERVAL = 10;

export type EvolutionWorkerWorkPhase =
  | "delta-replay"
  | "load-model-clone"
  | "post-replay-analysis"
  | "post-replay-clone"
  | "post-replay-transition";

export interface EvolutionTimelineWorkerRuntimeOptions {
  readonly postMessage: (response: EvolutionWorkerResponse) => void;
  readonly yieldControl?: (phase: EvolutionWorkerWorkPhase) => Promise<void>;
  readonly checkpointInterval?: number;
  readonly replayCheckpointInterval?: number;
  readonly onReplayDeltaApplied?: (frameIndex: number) => void;
}

type Identified = Readonly<{ id: string }>;
type JsonContainer = Record<string, unknown> | unknown[];
type ReplaySource = Readonly<{
  index: number;
  model: CityModel;
}>;

const MODEL_CHANGE_KEYS = Object.freeze([
  "metricMapping",
  "analysis",
  "identity",
  "identityPanel",
  "base",
  "bounds",
] as const);

function cancelledError(): DOMException {
  return new DOMException("The evolution seek was replaced.", "AbortError");
}

let cooperativeYieldChannel: MessageChannel | undefined;
const cooperativeYieldResolvers: (() => void)[] = [];

function defaultYieldControl(): Promise<void> {
  // scheduler.yield() resumes with boosted priority in Chromium. In a worker,
  // a long chain of those continuations can run ahead of the queued cancel
  // message that the checkpoint exists to observe. A MessageChannel task
  // returns to the worker event loop without that priority boost.
  if (typeof MessageChannel !== "undefined") {
    cooperativeYieldChannel ??= new MessageChannel();
    cooperativeYieldChannel.port1.onmessage = () => {
      cooperativeYieldResolvers.shift()?.();
    };
    return new Promise((resolve) => {
      cooperativeYieldResolvers.push(resolve);
      cooperativeYieldChannel!.port2.postMessage(undefined);
    });
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function canonicalBaselineModel(bundle: EvolutionBundle): CityModel {
  const replay = replayValidatedEvolutionBundle(bundle);
  const baseline = replay.next();
  replay.return();
  if (baseline.done) {
    throw new Error("The validated evolution baseline is unavailable.");
  }
  return baseline.value.model;
}

function isContainer(value: unknown): value is JsonContainer {
  return typeof value === "object" && value !== null;
}

class CooperativeCheckpoint {
  #operations = 0;

  public constructor(
    private readonly isCurrent: () => boolean,
    private readonly yieldControl: (
      phase: EvolutionWorkerWorkPhase,
    ) => Promise<void>,
    private readonly interval: number,
  ) {}

  public assertCurrent(): void {
    if (!this.isCurrent()) throw cancelledError();
  }

  public async boundary(phase: EvolutionWorkerWorkPhase): Promise<void> {
    this.#operations = 0;
    this.assertCurrent();
    await this.yieldControl(phase);
    this.assertCurrent();
  }

  public async consume(
    phase: EvolutionWorkerWorkPhase,
    operations = 1,
  ): Promise<void> {
    this.#operations += operations;
    if (this.#operations < this.interval) return;
    this.#operations %= this.interval;
    this.assertCurrent();
    await this.yieldControl(phase);
    this.assertCurrent();
  }
}

async function cooperativeCloneJson<T>(
  value: T,
  work: CooperativeCheckpoint,
  phase: EvolutionWorkerWorkPhase,
  startBoundary = true,
): Promise<T> {
  if (startBoundary) await work.boundary(phase);
  else work.assertCurrent();
  if (!isContainer(value)) return value;

  const clone: JsonContainer = Array.isArray(value)
    ? new Array<unknown>(value.length)
    : {};
  const stack: {
    readonly source: JsonContainer;
    readonly target: JsonContainer;
    readonly keys: readonly string[] | undefined;
    index: number;
  }[] = [
    {
      source: value,
      target: clone,
      keys: Array.isArray(value) ? undefined : Object.keys(value),
      index: 0,
    },
  ];

  while (stack.length > 0) {
    const frame = stack.at(-1)!;
    const key =
      frame.keys === undefined
        ? frame.index < (frame.source as unknown[]).length
          ? String(frame.index)
          : undefined
        : frame.keys[frame.index];
    if (key === undefined) {
      stack.pop();
      continue;
    }
    frame.index += 1;
    const child = frame.source[key as keyof typeof frame.source];
    if (!isContainer(child)) {
      Object.defineProperty(frame.target, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: child,
      });
      await work.consume(phase);
      continue;
    }

    const childClone: JsonContainer = Array.isArray(child)
      ? new Array<unknown>(child.length)
      : {};
    Object.defineProperty(frame.target, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: childClone,
    });
    await work.consume(phase);
    stack.push({
      source: child,
      target: childClone,
      keys: Array.isArray(child) ? undefined : Object.keys(child),
      index: 0,
    });
  }
  work.assertCurrent();
  return clone as T;
}

async function applyEntityDelta(
  current: readonly Identified[],
  delta: EvolutionEntityDelta<Identified>,
  work: CooperativeCheckpoint,
): Promise<readonly Identified[]> {
  const result: Identified[] = [];
  let currentIndex = 0;
  let addedIndex = 0;
  let removedIndex = 0;
  let changedIndex = 0;

  while (
    currentIndex < current.length ||
    addedIndex < delta.added.length
  ) {
    const existing = current[currentIndex];
    const added = delta.added[addedIndex];
    if (
      added !== undefined &&
      (existing === undefined || added.id < existing.id)
    ) {
      result.push(
        await cooperativeCloneJson(
          added,
          work,
          "delta-replay",
          false,
        ),
      );
      addedIndex += 1;
      continue;
    }
    if (existing === undefined) break;

    const removedId = delta.removed[removedIndex];
    const changed = delta.changed[changedIndex];
    if (removedId === existing.id) {
      removedIndex += 1;
    } else if (changed?.id === existing.id) {
      result.push(
        await cooperativeCloneJson(
          changed.entity,
          work,
          "delta-replay",
          false,
        ),
      );
      changedIndex += 1;
    } else {
      result.push(existing);
    }
    currentIndex += 1;
    await work.consume("delta-replay");
  }

  while (addedIndex < delta.added.length) {
    result.push(
      await cooperativeCloneJson(
        delta.added[addedIndex]!,
        work,
        "delta-replay",
        false,
      ),
    );
    addedIndex += 1;
  }

  // Validation already proved that every operation addresses one exact
  // lineage. These checks guard this worker-specific merge from drifting away
  // from that validated contract during future maintenance.
  if (
    currentIndex !== current.length ||
    addedIndex !== delta.added.length ||
    removedIndex !== delta.removed.length ||
    changedIndex !== delta.changed.length
  ) {
    throw new Error("The validated evolution delta could not be replayed.");
  }
  return result;
}

async function applyDelta(
  model: CityModel,
  changes: EvolutionChanges,
  work: CooperativeCheckpoint,
): Promise<CityModel> {
  await work.boundary("delta-replay");
  const next = { ...model } as unknown as Record<string, unknown>;
  const rootChanges = changes.model as unknown as Record<string, unknown>;
  for (const key of MODEL_CHANGE_KEYS) {
    if (!Object.hasOwn(rootChanges, key)) {
      await work.consume("delta-replay");
      continue;
    }
    const replacement = rootChanges[key];
    if (replacement === null) {
      delete next[key];
    } else {
      next[key] = await cooperativeCloneJson(
        replacement,
        work,
        "delta-replay",
        false,
      );
    }
    await work.consume("delta-replay");
  }

  for (const collection of EVOLUTION_ENTITY_COLLECTIONS) {
    next[collection] = await applyEntityDelta(
      model[collection] as readonly Identified[],
      changes[collection] as EvolutionEntityDelta<Identified>,
      work,
    );
  }
  work.assertCurrent();
  return next as unknown as CityModel;
}

async function replayAt(
  bundle: EvolutionBundle,
  baselineModel: CityModel,
  index: number,
  activeFrameIndex: number,
  activeFrameModel: CityModel | undefined,
  replayCheckpoints: ReadonlyMap<number, CityModel>,
  pendingCheckpoints: Map<number, CityModel>,
  requestSource: ReplaySource | undefined,
  replayCheckpointInterval: number,
  onReplayDeltaApplied: ((frameIndex: number) => void) | undefined,
  work: CooperativeCheckpoint,
): Promise<CityModel> {
  if (index < 0 || index > bundle.deltas.length) {
    throw new Error("The requested evolution frame is out of range.");
  }

  let source: ReplaySource = { index: 0, model: baselineModel };
  const consider = (
    candidateIndex: number,
    candidateModel: CityModel | undefined,
  ): void => {
    if (
      candidateModel !== undefined &&
      candidateIndex <= index &&
      candidateIndex > source.index
    ) {
      source = { index: candidateIndex, model: candidateModel };
    }
  };
  consider(activeFrameIndex, activeFrameModel);
  for (const [checkpointIndex, checkpointModel] of replayCheckpoints) {
    consider(checkpointIndex, checkpointModel);
  }
  for (const [checkpointIndex, checkpointModel] of pendingCheckpoints) {
    consider(checkpointIndex, checkpointModel);
  }
  if (requestSource !== undefined) {
    consider(requestSource.index, requestSource.model);
  }

  if (source.index === index) {
    work.assertCurrent();
    return source.model;
  }

  // applyDelta is persistent: it builds new roots and collection arrays and
  // never mutates its source model. A cold direct seek may still start at the
  // baseline, but the validated 100-frame limit caps each fallback endpoint at
  // 99 applications and the seek records crossed checkpoints for later use.
  let model = source.model;
  for (let offset = source.index; offset < index; offset += 1) {
    model = await applyDelta(model, bundle.deltas[offset]!.changes, work);
    const frameIndex = offset + 1;
    onReplayDeltaApplied?.(frameIndex);
    if (
      frameIndex % replayCheckpointInterval === 0 &&
      !replayCheckpoints.has(frameIndex)
    ) {
      pendingCheckpoints.set(frameIndex, model);
    }
  }
  work.assertCurrent();
  return model;
}

async function analyzeFrame(
  bundle: EvolutionBundle,
  targetIndex: number,
  targetModel: CityModel,
  work: CooperativeCheckpoint,
): Promise<EvolutionFrameAnalysis> {
  await work.boundary("post-replay-analysis");
  const firstSeen = new Map<string, number>();
  const churn = new Map<string, number>();
  for (const building of bundle.baseline.model.buildings) {
    firstSeen.set(building.id, 0);
    churn.set(building.id, 0);
    await work.consume("post-replay-analysis");
  }
  for (let offset = 0; offset < targetIndex; offset += 1) {
    const frame = bundle.deltas[offset];
    if (frame === undefined) break;
    const frameIndex = offset + 1;
    for (const building of frame.changes.buildings.added) {
      if (!firstSeen.has(building.id)) firstSeen.set(building.id, frameIndex);
      churn.set(building.id, (churn.get(building.id) ?? 0) + 1);
      await work.consume("post-replay-analysis");
    }
    for (const replacement of frame.changes.buildings.changed) {
      churn.set(replacement.id, (churn.get(replacement.id) ?? 0) + 1);
      await work.consume("post-replay-analysis");
    }
    for (const id of frame.changes.buildings.removed) {
      churn.set(id, (churn.get(id) ?? 0) + 1);
      await work.consume("post-replay-analysis");
    }
  }

  const ageByBuildingId: [string, number][] = [];
  const churnByBuildingId: [string, number][] = [];
  for (const building of targetModel.buildings) {
    ageByBuildingId.push([
      building.id,
      targetIndex - (firstSeen.get(building.id) ?? targetIndex),
    ]);
    churnByBuildingId.push([building.id, churn.get(building.id) ?? 0]);
    await work.consume("post-replay-analysis");
  }
  work.assertCurrent();
  return { ageByBuildingId, churnByBuildingId };
}

function vectorChanged(
  left: CityBuilding["size"],
  right: CityBuilding["size"],
): boolean {
  return left.x !== right.x || left.y !== right.y || left.z !== right.z;
}

function metricsChanged(
  left: CityBuilding["metrics"],
  right: CityBuilding["metrics"],
): boolean {
  return (
    left.sloc !== right.sloc ||
    left.decisionLoad !== right.decisionLoad ||
    left.maximumComplexity !== right.maximumComplexity ||
    left.executableUnitCount !== right.executableUnitCount
  );
}

async function compareFrames(
  from: CityModel,
  to: CityModel,
  fromIndex: number,
  toIndex: number,
  work: CooperativeCheckpoint,
): Promise<EvolutionTransition> {
  await work.boundary("post-replay-transition");
  const source = new Map<string, CityBuilding>();
  for (const building of from.buildings) {
    source.set(building.id, building);
    await work.consume("post-replay-transition");
  }
  const targetIds = new Set<string>();
  const addedBuildingIds: string[] = [];
  const removedBuildings: EvolutionTransition["removedBuildings"][number][] =
    [];
  const renamedBuildingIds: string[] = [];
  const resizedBuildingIds: string[] = [];
  const changedBuildingIds: string[] = [];
  const interpolatedBuildings: EvolutionTransition["interpolatedBuildings"][number][] =
    [];
  for (const building of to.buildings) {
    targetIds.add(building.id);
    const previous = source.get(building.id);
    if (previous === undefined) {
      addedBuildingIds.push(building.id);
      await work.consume("post-replay-transition");
      continue;
    }
    const renamed =
      previous.name !== building.name || previous.path !== building.path;
    const resized =
      vectorChanged(previous.size, building.size) ||
      vectorChanged(previous.position, building.position);
    if (renamed) renamedBuildingIds.push(building.id);
    if (resized) {
      resizedBuildingIds.push(building.id);
      interpolatedBuildings.push({
        id: building.id,
        position: previous.position,
        size: previous.size,
      });
    }
    if (
      renamed ||
      resized ||
      metricsChanged(previous.metrics, building.metrics) ||
      previous.districtId !== building.districtId ||
      previous.semanticGroupId !== building.semanticGroupId
    ) {
      changedBuildingIds.push(building.id);
    }
    await work.consume("post-replay-transition");
  }
  for (const building of from.buildings) {
    if (!targetIds.has(building.id)) {
      removedBuildings.push({
        id: building.id,
        name: building.name,
        districtId: building.districtId,
        position: building.position,
        size: building.size,
      });
    }
    await work.consume("post-replay-transition");
  }
  const dependencyChanges = new EvolutionDependencyChangeCollector();
  let sourceDependencyIndex = 0;
  let targetDependencyIndex = 0;
  while (
    sourceDependencyIndex < from.dependencies.length ||
    targetDependencyIndex < to.dependencies.length
  ) {
    const previous = from.dependencies[sourceDependencyIndex];
    const current = to.dependencies[targetDependencyIndex];
    if (
      previous !== undefined &&
      (current === undefined || previous.id < current.id)
    ) {
      dependencyChanges.add(previous, undefined);
      sourceDependencyIndex += 1;
    } else if (
      current !== undefined &&
      (previous === undefined || current.id < previous.id)
    ) {
      dependencyChanges.add(undefined, current);
      targetDependencyIndex += 1;
    } else {
      dependencyChanges.add(previous, current);
      sourceDependencyIndex += 1;
      targetDependencyIndex += 1;
    }
    await work.consume("post-replay-transition");
  }
  work.assertCurrent();
  return {
    fromIndex,
    toIndex,
    addedBuildingIds,
    removedBuildings,
    renamedBuildingIds,
    resizedBuildingIds,
    changedBuildingIds,
    interpolatedBuildings,
    dependencyChanges: dependencyChanges.finish(),
  };
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

export class EvolutionTimelineWorkerRuntime {
  readonly #postMessage: (response: EvolutionWorkerResponse) => void;
  readonly #yieldControl: (
    phase: EvolutionWorkerWorkPhase,
  ) => Promise<void>;
  readonly #checkpointInterval: number;
  readonly #replayCheckpointInterval: number;
  readonly #onReplayDeltaApplied: ((frameIndex: number) => void) | undefined;
  #activeBundle: EvolutionBundle | undefined;
  #baselineModel: CityModel | undefined;
  #activeFrameIndex = 0;
  #activeFrameModel: CityModel | undefined;
  #replayCheckpoints = new Map<number, CityModel>();
  #latestRequestId = 0;

  public constructor(options: EvolutionTimelineWorkerRuntimeOptions) {
    this.#postMessage = options.postMessage;
    this.#yieldControl =
      options.yieldControl ??
      (async () => {
        await defaultYieldControl();
      });
    this.#checkpointInterval =
      options.checkpointInterval ?? EVOLUTION_WORK_CHECKPOINT_INTERVAL;
    this.#replayCheckpointInterval =
      options.replayCheckpointInterval ??
      EVOLUTION_REPLAY_CHECKPOINT_INTERVAL;
    this.#onReplayDeltaApplied = options.onReplayDeltaApplied;
    if (
      !Number.isSafeInteger(this.#checkpointInterval) ||
      this.#checkpointInterval < 1
    ) {
      throw new RangeError("Evolution checkpoint interval must be positive.");
    }
    if (
      !Number.isSafeInteger(this.#replayCheckpointInterval) ||
      this.#replayCheckpointInterval < 1
    ) {
      throw new RangeError(
        "Evolution replay checkpoint interval must be positive.",
      );
    }
  }

  public async handle(value: unknown): Promise<void> {
    if (!isEvolutionWorkerRequest(value)) return;
    const request = value;
    this.#latestRequestId = request.requestId;
    if (request.type === "cancel") return;

    const work = new CooperativeCheckpoint(
      () => request.requestId === this.#latestRequestId,
      this.#yieldControl,
      this.#checkpointInterval,
    );
    let response: EvolutionWorkerResponse;
    try {
      response =
        request.type === "load"
          ? await this.#load(request, work)
          : await this.#seek(request, work);
    } catch (error) {
      if (
        request.requestId !== this.#latestRequestId ||
        (error instanceof DOMException && error.name === "AbortError")
      ) {
        return;
      }
      response = {
        type: "failure",
        requestId: request.requestId,
        message: evolutionWorkerFailureMessage(error),
      };
    }
    if (request.requestId !== this.#latestRequestId) return;
    this.#postMessage(response);
  }

  async #load(
    request: Extract<EvolutionWorkerRequest, { readonly type: "load" }>,
    work: CooperativeCheckpoint,
  ): Promise<EvolutionWorkerResponse> {
    const digest = await crypto.subtle.digest("SHA-256", request.bytes);
    work.assertCurrent();
    if (hex(digest) !== request.expectedSha256) {
      throw new Error("The evolution artifact checksum does not match.");
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      request.bytes,
    );
    const bundle = validateEvolutionBundle(JSON.parse(text) as unknown);
    work.assertCurrent();
    const baselineModel = canonicalBaselineModel(bundle);
    work.assertCurrent();
    const cachedModel = await cooperativeCloneJson(
      baselineModel,
      work,
      "load-model-clone",
    );
    const responseModel = await cooperativeCloneJson(
      cachedModel,
      work,
      "load-model-clone",
    );
    const analysis = await analyzeFrame(bundle, 0, responseModel, work);
    work.assertCurrent();
    this.#activeBundle = bundle;
    this.#baselineModel = baselineModel;
    this.#activeFrameIndex = 0;
    this.#activeFrameModel = cachedModel;
    this.#replayCheckpoints = new Map();
    return {
      type: "loaded",
      requestId: request.requestId,
      frames: summarizeEvolutionFrames(bundle),
      histories: analyzeEvolutionBuildingHistory(bundle),
      model: responseModel,
      analysis,
    };
  }

  async #seek(
    request: Extract<EvolutionWorkerRequest, { readonly type: "seek" }>,
    work: CooperativeCheckpoint,
  ): Promise<EvolutionWorkerResponse> {
    const bundle = this.#activeBundle;
    const baselineModel = this.#baselineModel;
    if (bundle === undefined || baselineModel === undefined) {
      throw new Error("Repository evolution is not loaded.");
    }
    const replayCheckpoints = this.#replayCheckpoints;
    const pendingCheckpoints = new Map<number, CityModel>();
    const from = await replayAt(
      bundle,
      baselineModel,
      request.fromIndex,
      this.#activeFrameIndex,
      this.#activeFrameModel,
      replayCheckpoints,
      pendingCheckpoints,
      undefined,
      this.#replayCheckpointInterval,
      this.#onReplayDeltaApplied,
      work,
    );
    const model = await replayAt(
      bundle,
      baselineModel,
      request.toIndex,
      this.#activeFrameIndex,
      this.#activeFrameModel,
      replayCheckpoints,
      pendingCheckpoints,
      { index: request.fromIndex, model: from },
      this.#replayCheckpointInterval,
      this.#onReplayDeltaApplied,
      work,
    );
    const responseModel = await cooperativeCloneJson(
      model,
      work,
      "post-replay-clone",
    );
    const analysis = await analyzeFrame(
      bundle,
      request.toIndex,
      model,
      work,
    );
    const transition = await compareFrames(
      from,
      model,
      request.fromIndex,
      request.toIndex,
      work,
    );
    work.assertCurrent();
    this.#replayCheckpoints = new Map([
      ...replayCheckpoints,
      ...pendingCheckpoints,
    ]);
    this.#activeFrameIndex = request.toIndex;
    this.#activeFrameModel = model;
    return {
      type: "frame",
      requestId: request.requestId,
      frame: summarizeEvolutionFrames(bundle)[request.toIndex]!,
      model: responseModel,
      analysis,
      transition,
    };
  }
}
