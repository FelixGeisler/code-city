import {
  EVOLUTION_AUTHOR_POLICY,
  EVOLUTION_BUNDLE_LIMITS,
  EVOLUTION_BUNDLE_SCHEMA_VERSION,
  EVOLUTION_CHANGE_KINDS,
  EVOLUTION_ENTITY_COLLECTIONS,
  type EvolutionBundle,
  type EvolutionChangeKind,
  type EvolutionCommitMetadata,
  type EvolutionEntityByCollection,
  type EvolutionEntityCollection,
  type EvolutionFingerprint,
  type EvolutionReplayFrame,
  type NormalizedEvolutionSelection,
} from "./evolution.js";
import type { CityModel } from "./model.js";
import {
  CITY_MODEL_LIMITS,
  validateCityModel,
} from "./model-validation.js";

type JsonObject = Record<string, unknown>;

const GIT_OBJECT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const SHA256_FINGERPRINT = /^sha256:[0-9a-f]{64}$/u;
const UNSAFE_TEXT_CHARACTERS = /[\p{Cc}\p{Cf}\p{Cs}]/u;
const CHANGE_KIND_RANK = new Map(
  EVOLUTION_CHANGE_KINDS.map((kind, index) => [kind, index]),
);
const COLLECTION_LIMITS: Readonly<
  Record<EvolutionEntityCollection, number>
> = Object.freeze({
  repositories: CITY_MODEL_LIMITS.repositories,
  solutions: CITY_MODEL_LIMITS.solutions,
  modules: CITY_MODEL_LIMITS.modules,
  semanticGroups: CITY_MODEL_LIMITS.semanticGroups,
  districts: CITY_MODEL_LIMITS.districts,
  buildings: CITY_MODEL_LIMITS.buildings,
  dependencies: CITY_MODEL_LIMITS.dependencies,
});

const MODEL_CHANGE_KEYS = Object.freeze([
  "metricMapping",
  "analysis",
  "identity",
  "identityPanel",
  "base",
  "bounds",
] as const);
const CANONICAL_CHUNK_CHARACTER_TARGET = 16 * 1024;
const VALIDATION_CHECKPOINT_INTERVAL = 256;

export interface EvolutionMeasurementOptions {
  /**
   * Called at bounded intervals during preparation, measurement, and replay.
   * Throwing aborts measurement immediately.
   */
  readonly checkpoint?: () => void;
}

class ValidationCheckpoint {
  #operations = 0;

  public constructor(
    public readonly callback: (() => void) | undefined,
  ) {}

  public checkpoint(): void {
    this.#operations = 0;
    this.callback?.();
  }

  public consume(operations = 1): void {
    if (this.callback === undefined) return;
    this.#operations += operations;
    if (this.#operations < VALIDATION_CHECKPOINT_INTERVAL) return;
    this.#operations %= VALIDATION_CHECKPOINT_INTERVAL;
    this.callback();
  }
}

interface ReplayState {
  model: CityModel;
  operationCount: number;
  readonly lineages: Set<string>;
}

/**
 * Validates the bundle and replays every delta with bounded working memory.
 */
function validatePreparedEvolutionBundle(
  value: unknown,
  work: ValidationCheckpoint,
): EvolutionBundle {
  const bundle = objectAt(value, "bundle");
  exactKeys(
    bundle,
    [
      "schemaVersion",
      "generator",
      "authorPolicy",
      "selection",
      "provenance",
      "baseline",
      "deltas",
    ],
    [],
    "bundle",
  );

  if (bundle.schemaVersion !== EVOLUTION_BUNDLE_SCHEMA_VERSION) {
    fail(
      `schemaVersion must be "${EVOLUTION_BUNDLE_SCHEMA_VERSION}"`,
    );
  }
  if (bundle.authorPolicy !== EVOLUTION_AUTHOR_POLICY) {
    fail(`authorPolicy must be "${EVOLUTION_AUTHOR_POLICY}"`);
  }

  const generator = validateGenerator(bundle.generator, "generator");
  const selection = validateSelection(bundle.selection, work);
  const provenance = validateProvenance(
    bundle.provenance,
    generator.version,
  );
  const baseline = objectAt(bundle.baseline, "baseline");
  exactKeys(baseline, ["commit", "model"], [], "baseline");

  const deltas = objectArray(
    bundle.deltas,
    "deltas",
    EVOLUTION_BUNDLE_LIMITS.frames - 1,
    work,
  );
  if (selection.sampledCommitCount !== deltas.length + 1) {
    fail(
      "selection.sampledCommitCount must equal the baseline plus delta count",
    );
  }

  const seenCommitShas = new Set<string>();
  const seenAnalysisFingerprints = new Set<string>();
  const baselineCommit = validateCommit(
    baseline.commit,
    0,
    selection.sampledCommitShas[0]!,
    generator.version,
    seenCommitShas,
    seenAnalysisFingerprints,
    "baseline.commit",
    work,
  );
  if (
    selection.mode === "root-to-tip" &&
    baselineCommit.parentShas.length !== 0
  ) {
    fail(
      "baseline.commit.parentShas must be empty for a root-to-tip selection",
    );
  }
  validateCommitSelectionTime(
    baselineCommit,
    selection,
    "baseline.commit",
  );
  const baselineModel = validateCityModel(
    baseline.model,
    work.callback === undefined
      ? {}
      : { checkpoint: work.callback },
  );
  validateFrameProvenance(
    baselineModel,
    bundle.generator,
    provenance.repositoryId,
    "baseline.model",
    work,
  );

  const state: ReplayState = {
    model: normalizeCityModel(baselineModel, work),
    operationCount: 0,
    lineages: collectLineages(baselineModel, work),
  };
  assertLineageLimit(state.lineages);

  let previousCommit = baselineCommit;
  deltas.forEach((deltaValue, offset) => {
    work.consume();
    const index = offset + 1;
    const path = `deltas[${offset}]`;
    const delta = objectAt(deltaValue, path);
    exactKeys(delta, ["commit", "changes"], [], path);
    const commit = validateCommit(
      delta.commit,
      index,
      selection.sampledCommitShas[index]!,
      generator.version,
      seenCommitShas,
      seenAnalysisFingerprints,
      `${path}.commit`,
      work,
    );
    validateCommitSelectionTime(
      commit,
      selection,
      `${path}.commit`,
    );
    if (
      ((selection.mode === "root-to-tip" &&
        selection.sampledCommitCount ===
          selection.selectedCommitCount) ||
        (selection.mode !== "root-to-tip" &&
          selection.sampleEvery === 1 &&
          selection.mode !== "date-range")) &&
      commit.parentShas[0] !== previousCommit.sha
    ) {
      fail(
        `${path}.commit.parentShas[0] must reference the previous frame when sampleEvery is 1`,
      );
    }
    state.model = applyEvolutionChanges(
      state,
      delta.changes,
      `${path}.changes`,
      work,
    );
    validateFrameProvenance(
      state.model,
      bundle.generator,
      provenance.repositoryId,
      `${path}.changes`,
      work,
    );
    previousCommit = commit;
  });

  return bundle as unknown as EvolutionBundle;
}

interface PreparedEvolutionBundle {
  readonly bundle: EvolutionBundle;
  readonly measuredBytes: number;
}

/**
 * Opaque, runtime-authenticated result of a complete immutable validation,
 * replay, and canonical byte measurement. Trusted writers can stream it
 * without repeating that work.
 */
export interface PreparedEvolutionSerialization {
  readonly bundle: EvolutionBundle;
  readonly measuredBytes: number;
}

const PREPARED_EVOLUTION_SERIALIZATIONS =
  new WeakSet<PreparedEvolutionSerialization>();
const VALIDATED_EVOLUTION_BUNDLES = new WeakSet<EvolutionBundle>();

function prepareEvolutionBundle(
  value: unknown,
  checkpoint?: () => void,
): PreparedEvolutionBundle {
  const work = new ValidationCheckpoint(checkpoint);
  work.checkpoint();
  const preparedJson = freezeJsonTree(value, work);
  const bundle = validatePreparedEvolutionBundle(preparedJson.value, work);
  VALIDATED_EVOLUTION_BUNDLES.add(bundle);
  const prepared = Object.freeze({
    bundle,
    measuredBytes: preparedJson.measuredBytes,
  });
  work.checkpoint();
  return prepared;
}

/**
 * Takes an immutable data-property snapshot, then validates and replays every
 * delta. Node rejects Proxy inputs and can safely freeze/reuse the supplied
 * graph; runtimes without native Proxy introspection receive an owned frozen
 * graph captured through descriptors. Accessors and sparse or exotic arrays
 * are rejected before semantic reads.
 */
export function validateEvolutionBundle(value: unknown): EvolutionBundle {
  return prepareEvolutionBundle(value).bundle;
}

/**
 * Streams independently owned frames in oldest-first order. Validation first
 * performs a bounded replay, so iteration can never yield a partially valid
 * bundle.
 */
export function* replayEvolutionBundle(
  value: unknown,
): Generator<EvolutionReplayFrame, void, undefined> {
  const bundle = prepareEvolutionBundle(value).bundle;
  yield* replayValidatedEvolutionBundle(bundle);
}

/**
 * Replays a bundle returned by `validateEvolutionBundle` without repeating its
 * bounded whole-bundle validation. This is intended for worker-owned playback
 * loops that keep the exact validator-returned object identity.
 */
export function* replayValidatedEvolutionBundle(
  bundle: EvolutionBundle,
): Generator<EvolutionReplayFrame, void, undefined> {
  if (!VALIDATED_EVOLUTION_BUNDLES.has(bundle)) {
    throw new TypeError(
      "Evolution bundle must be the exact result of validateEvolutionBundle.",
    );
  }
  const work = new ValidationCheckpoint(undefined);
  let model = normalizeCityModel(bundle.baseline.model, work);
  yield {
    commit: structuredClone(bundle.baseline.commit),
    model: structuredClone(model),
  };
  for (const [offset, delta] of bundle.deltas.entries()) {
    const state: ReplayState = {
      model,
      operationCount: 0,
      lineages: collectLineages(model, work),
    };
    model = applyEvolutionChanges(
      state,
      delta.changes,
      `deltas[${offset}].changes`,
      work,
    );
    yield {
      commit: structuredClone(delta.commit),
      model: structuredClone(model),
    };
  }
}

/**
 * Returns the exact canonical UTF-8 byte count without materializing the
 * serialized document. Canonical normalization only reorders JSON members and
 * set-like arrays, so it cannot change the encoded byte count.
 */
export function measureEvolutionBundleBytes(
  value: unknown,
  options: EvolutionMeasurementOptions = {},
): number {
  return prepareEvolutionBundle(value, options.checkpoint).measuredBytes;
}

export function prepareEvolutionSerialization(
  value: unknown,
  options: EvolutionMeasurementOptions = {},
): PreparedEvolutionSerialization {
  const prepared = prepareEvolutionBundle(
    value,
    options.checkpoint,
  );
  const serialization = Object.freeze({
    bundle: prepared.bundle,
    measuredBytes: prepared.measuredBytes,
  });
  PREPARED_EVOLUTION_SERIALIZATIONS.add(serialization);
  return serialization;
}

type CanonicalContext =
  | { readonly kind: "generic" }
  | { readonly kind: "bundle" }
  | { readonly kind: "baseline" }
  | { readonly kind: "city-model" }
  | { readonly kind: "delta-list" }
  | { readonly kind: "delta" }
  | { readonly kind: "changes" }
  | { readonly kind: "model-changes" }
  | { readonly kind: "analysis" }
  | { readonly kind: "identity" }
  | {
      readonly kind: "entity-delta";
      readonly collection: EvolutionEntityCollection;
    }
  | {
      readonly kind: "entity-list";
      readonly collection: EvolutionEntityCollection;
    }
  | {
      readonly kind: "replacement-list";
      readonly collection: EvolutionEntityCollection;
    }
  | {
      readonly kind: "replacement";
      readonly collection: EvolutionEntityCollection;
    }
  | {
      readonly kind: "entity";
      readonly collection: EvolutionEntityCollection;
    }
  | { readonly kind: "string-set" }
  | { readonly kind: "change-kind-set" }
  | { readonly kind: "unit-set" }
  | { readonly kind: "identity-repository-set" };

const GENERIC_CANONICAL_CONTEXT =
  Object.freeze({ kind: "generic" }) satisfies CanonicalContext;

function canonicalObjectChildContext(
  context: CanonicalContext,
  key: string,
): CanonicalContext {
  switch (context.kind) {
    case "bundle":
      if (key === "baseline") return { kind: "baseline" };
      if (key === "deltas") return { kind: "delta-list" };
      break;
    case "baseline":
      if (key === "model") return { kind: "city-model" };
      break;
    case "city-model":
      if (
        EVOLUTION_ENTITY_COLLECTIONS.includes(
          key as EvolutionEntityCollection,
        )
      ) {
        return {
          kind: "entity-list",
          collection: key as EvolutionEntityCollection,
        };
      }
      if (key === "analysis") return { kind: "analysis" };
      if (key === "identity") return { kind: "identity" };
      break;
    case "delta":
      if (key === "changes") return { kind: "changes" };
      break;
    case "changes":
      if (key === "model") return { kind: "model-changes" };
      if (
        EVOLUTION_ENTITY_COLLECTIONS.includes(
          key as EvolutionEntityCollection,
        )
      ) {
        return {
          kind: "entity-delta",
          collection: key as EvolutionEntityCollection,
        };
      }
      break;
    case "model-changes":
      if (key === "analysis") return { kind: "analysis" };
      if (key === "identity") return { kind: "identity" };
      break;
    case "analysis":
      if (key === "warnings") return { kind: "string-set" };
      break;
    case "identity":
      if (key === "repositories") {
        return { kind: "identity-repository-set" };
      }
      break;
    case "entity-delta":
      if (key === "added") {
        return {
          kind: "entity-list",
          collection: context.collection,
        };
      }
      if (key === "removed") return { kind: "string-set" };
      if (key === "changed") {
        return {
          kind: "replacement-list",
          collection: context.collection,
        };
      }
      break;
    case "replacement":
      if (key === "changeKinds") return { kind: "change-kind-set" };
      if (key === "entity") {
        return {
          kind: "entity",
          collection: context.collection,
        };
      }
      break;
    case "entity":
      if (
        context.collection === "solutions" &&
        key === "moduleIds"
      ) {
        return { kind: "string-set" };
      }
      if (
        context.collection === "modules" &&
        (
          key === "solutionIds" ||
          key === "targetFrameworks"
        )
      ) {
        return { kind: "string-set" };
      }
      if (context.collection === "buildings" && key === "units") {
        return { kind: "unit-set" };
      }
      break;
  }
  return GENERIC_CANONICAL_CONTEXT;
}

function canonicalArrayValues(
  value: readonly unknown[],
  context: CanonicalContext,
  work: ValidationCheckpoint,
): readonly unknown[] {
  const sortableCopy = (): unknown[] => {
    const copy = new Array<unknown>(value.length);
    for (let index = 0; index < value.length; index += 1) {
      work.consume();
      copy[index] = value[index];
    }
    return copy;
  };
  switch (context.kind) {
    case "entity-list":
    case "replacement-list":
      return sortableCopy().sort((left, right) => {
        work.consume();
        return compareText(
          (left as JsonObject).id as string,
          (right as JsonObject).id as string,
        );
      });
    case "string-set":
      return sortableCopy().sort((left, right) => {
        work.consume();
        return compareText(left as string, right as string);
      });
    case "change-kind-set":
      return sortableCopy().sort((left, right) => {
        work.consume();
        return (
          CHANGE_KIND_RANK.get(left as EvolutionChangeKind)! -
          CHANGE_KIND_RANK.get(right as EvolutionChangeKind)!
        );
      });
    case "unit-set":
      return sortableCopy().sort((left, right) => {
        work.consume();
        const leftUnit = left as JsonObject;
        const rightUnit = right as JsonObject;
        return (
          (leftUnit.line as number) - (rightUnit.line as number) ||
          compareText(
            leftUnit.name as string,
            rightUnit.name as string,
          ) ||
          (leftUnit.complexity as number) -
            (rightUnit.complexity as number)
        );
      });
    case "identity-repository-set":
      return sortableCopy().sort((left, right) => {
        work.consume();
        return compareText(
          (left as JsonObject).repositoryId as string,
          (right as JsonObject).repositoryId as string,
        );
      });
    default:
      return value;
  }
}

function canonicalArrayChildContext(
  context: CanonicalContext,
): CanonicalContext {
  switch (context.kind) {
    case "delta-list":
      return { kind: "delta" };
    case "entity-list":
      return {
        kind: "entity",
        collection: context.collection,
      };
    case "replacement-list":
      return {
        kind: "replacement",
        collection: context.collection,
      };
    default:
      return GENERIC_CANONICAL_CONTEXT;
  }
}

function* canonicalJsonTokens(
  value: unknown,
  context: CanonicalContext = GENERIC_CANONICAL_CONTEXT,
  work = new ValidationCheckpoint(undefined),
): Generator<string> {
  work.consume();
  if (Array.isArray(value)) {
    yield "[";
    const childContext = canonicalArrayChildContext(context);
    for (const [index, item] of canonicalArrayValues(
      value,
      context,
      work,
    ).entries()) {
      work.consume();
      if (index > 0) yield ",";
      yield* canonicalJsonTokens(item, childContext, work);
    }
    yield "]";
    return;
  }
  if (typeof value === "object" && value !== null) {
    yield "{";
    const object = value as JsonObject;
    const keys = Object.keys(object).sort((left, right) => {
      work.consume();
      return compareText(left, right);
    });
    for (const [index, key] of keys.entries()) {
      work.consume();
      if (index > 0) yield ",";
      yield JSON.stringify(key);
      yield ":";
      yield* canonicalJsonTokens(
        object[key],
        canonicalObjectChildContext(context, key),
        work,
      );
    }
    yield "}";
    return;
  }
  const token = JSON.stringify(value);
  if (token === undefined) {
    fail("bundle must contain only JSON values");
  }
  yield token;
}

/**
 * Canonical UTF-8 JSON chunks. Object keys are recursively sorted, while every
 * set-like CityModel and delta array is normalized with code-point ordering.
 * Git parent order and sampled frame order remain significant and unchanged.
 *
 * Validation completes against an immutable data-only tree before this
 * function returns. Node freezes and reuses ordinary inputs; runtimes without
 * native Proxy introspection capture an owned descriptor snapshot. Set-like
 * collections are normalized one at a time during iteration, so consumers can
 * safely stream chunks into an atomic temporary artifact without retaining the
 * full normalized tree or serialized byte document.
 */
function* canonicalEvolutionBundleChunks(
  bundle: EvolutionBundle,
  checkpoint?: () => void,
): Generator<Uint8Array, void, undefined> {
  const work = new ValidationCheckpoint(checkpoint);
  work.checkpoint();
  const encoder = new TextEncoder();
  let pending: string[] = [];
  let pendingCharacters = 0;
  let emittedBytes = 0;
  for (const token of canonicalJsonTokens(
    bundle,
    { kind: "bundle" },
    work,
  )) {
    work.consume();
    pending.push(token);
    pendingCharacters += token.length;
    if (pendingCharacters < CANONICAL_CHUNK_CHARACTER_TARGET) continue;
    const chunk = encoder.encode(pending.join(""));
    emittedBytes += chunk.byteLength;
    if (emittedBytes > EVOLUTION_BUNDLE_LIMITS.serializedBytes) {
      fail(
        `serialized bundle must not exceed ${EVOLUTION_BUNDLE_LIMITS.serializedBytes} bytes`,
      );
    }
    pending = [];
    pendingCharacters = 0;
    yield chunk;
  }
  if (pending.length > 0) {
    const chunk = encoder.encode(pending.join(""));
    emittedBytes += chunk.byteLength;
    if (emittedBytes > EVOLUTION_BUNDLE_LIMITS.serializedBytes) {
      fail(
        `serialized bundle must not exceed ${EVOLUTION_BUNDLE_LIMITS.serializedBytes} bytes`,
      );
    }
    yield chunk;
  }
  work.checkpoint();
}

interface PreparedJsonTree<T> {
  readonly value: T;
  readonly measuredBytes: number;
}

function freezeJsonTree<T>(
  value: T,
  work: ValidationCheckpoint,
): PreparedJsonTree<T> {
  const isProxy = runtimeProxyDetector();
  if (isProxy === undefined) {
    return ownedJsonSnapshot(value, work);
  }
  const frozen = new WeakSet<object>();
  let nodes = 0;
  const freeze = (
    item: unknown,
    path: string,
    depth: number,
  ): void => {
    work.consume();
    nodes += 1;
    if (nodes > EVOLUTION_BUNDLE_LIMITS.jsonValues) {
      fail(
        `bundle JSON must contain at most ${EVOLUTION_BUNDLE_LIMITS.jsonValues} values`,
      );
    }
    if (depth > EVOLUTION_BUNDLE_LIMITS.jsonDepth) {
      fail(
        `bundle JSON must not exceed ${EVOLUTION_BUNDLE_LIMITS.jsonDepth} nested levels`,
      );
    }
    if (
      typeof item !== "object" ||
      item === null ||
      frozen.has(item)
    ) {
      return;
    }
    if (isProxy(item)) {
      fail(`${path} must not contain Proxy objects`);
    }
    frozen.add(item);
    Object.freeze(item);
    const descriptors = jsonDataDescriptors(item, path, work);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (Array.isArray(item) && key === "length") continue;
      const childPath =
        typeof key === "string"
          ? Array.isArray(item)
            ? `${path}[${key}]`
            : `${path}.${key}`
          : path;
      freeze(
        dataDescriptorValue(descriptors[key], childPath),
        childPath,
        depth + 1,
      );
    }
  };
  freeze(value, "bundle", 0);
  return Object.freeze({
    value,
    measuredBytes: assertPlainJson(value, work),
  });
}

export function iterateCanonicalEvolutionBundleBytes(
  value: unknown,
  options: EvolutionMeasurementOptions = {},
): Generator<Uint8Array, void, undefined> {
  return canonicalEvolutionBundleChunks(
    prepareEvolutionBundle(value, options.checkpoint).bundle,
    options.checkpoint,
  );
}

export function iteratePreparedEvolutionBundleBytes(
  prepared: PreparedEvolutionSerialization,
  options: EvolutionMeasurementOptions = {},
): Generator<Uint8Array, void, undefined> {
  options.checkpoint?.();
  if (
    typeof prepared !== "object" ||
    prepared === null ||
    !PREPARED_EVOLUTION_SERIALIZATIONS.has(prepared)
  ) {
    fail("prepared evolution serialization is invalid");
  }
  return canonicalEvolutionBundleChunks(
    prepared.bundle,
    options.checkpoint,
  );
}

/**
 * Materialized canonical UTF-8 JSON for callers that explicitly need a byte
 * array. Streaming artifact writers should use
 * `iterateCanonicalEvolutionBundleBytes` instead.
 */
export function serializeEvolutionBundle(
  value: unknown,
): Uint8Array {
  const prepared = prepareEvolutionBundle(value);
  const expectedBytes = prepared.measuredBytes;
  const bytes = new Uint8Array(expectedBytes);
  let offset = 0;
  for (const chunk of canonicalEvolutionBundleChunks(prepared.bundle)) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (offset !== expectedBytes) {
    fail("canonical evolution byte measurement is inconsistent");
  }
  return bytes;
}

export function canonicalEvolutionBundleJson(value: unknown): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(
    serializeEvolutionBundle(value),
  );
}

/**
 * Classifies a complete stable-ID entity replacement exactly as the bundle
 * validator does. Producers should use this helper instead of maintaining a
 * second change-kind classifier.
 */
export function deriveEvolutionChangeKinds<
  TCollection extends EvolutionEntityCollection,
>(
  collection: TCollection,
  beforeValue: EvolutionEntityByCollection[TCollection],
  afterValue: EvolutionEntityByCollection[TCollection],
): readonly EvolutionChangeKind[] {
  if (
    !EVOLUTION_ENTITY_COLLECTIONS.includes(
      collection as EvolutionEntityCollection,
    )
  ) {
    fail("collection has an unsupported value");
  }
  assertPlainJson([beforeValue, afterValue]);
  const before = objectAt(beforeValue, "before");
  const after = objectAt(afterValue, "after");
  const beforeId = entityId(before, "before");
  if (entityId(after, "after") !== beforeId) {
    fail("before.id and after.id must match");
  }
  return Object.freeze(
    deriveEvolutionChangeKindsUnchecked(collection, before, after),
  );
}

function validateGenerator(
  value: unknown,
  path: string,
): { readonly name: "code-city"; readonly version: string } {
  const generator = objectAt(value, path);
  exactKeys(generator, ["name", "version"], [], path);
  if (generator.name !== "code-city") {
    fail(`${path}.name must be "code-city"`);
  }
  return {
    name: "code-city",
    version: nonEmptyString(
      generator.version,
      `${path}.version`,
      EVOLUTION_BUNDLE_LIMITS.versionCharacters,
    ),
  };
}

function validateSelection(
  value: unknown,
  work: ValidationCheckpoint,
): NormalizedEvolutionSelection {
  const selection = objectAt(value, "selection");
  const mode = enumString(
    selection.mode,
    new Set([
      "root-to-tip",
      "commit-count",
      "date-range",
      "tag-range",
    ]),
    "selection.mode",
  ) as NormalizedEvolutionSelection["mode"];
  const commonKeys = [
    "mode",
    "traversal",
    "order",
    "selectedCommitCount",
    "sampledCommitCount",
    "traversedCommitCount",
    "resolvedOldestSha",
    "resolvedNewestSha",
    "sampledCommitShas",
  ];
  switch (mode) {
    case "root-to-tip":
      exactKeys(
        selection,
        [...commonKeys, "samplingStrategy", "maxFrames"],
        [],
        "selection",
      );
      break;
    case "commit-count":
      exactKeys(
        selection,
        [...commonKeys, "sampleEvery", "requestedCommitCount"],
        [],
        "selection",
      );
      break;
    case "date-range":
      exactKeys(
        selection,
        [
          ...commonKeys,
          "sampleEvery",
          "fromInclusive",
          "toInclusive",
        ],
        [],
        "selection",
      );
      break;
    case "tag-range":
      exactKeys(
        selection,
        [...commonKeys, "sampleEvery"],
        [],
        "selection",
      );
      break;
  }

  if (selection.traversal !== "first-parent") {
    fail('selection.traversal must be "first-parent"');
  }
  if (selection.order !== "oldest-first") {
    fail('selection.order must be "oldest-first"');
  }
  const selectedCommitCount = boundedPositiveInteger(
    selection.selectedCommitCount,
    "selection.selectedCommitCount",
    EVOLUTION_BUNDLE_LIMITS.traversedCommits,
  );
  const sampledCommitCount = boundedPositiveInteger(
    selection.sampledCommitCount,
    "selection.sampledCommitCount",
    EVOLUTION_BUNDLE_LIMITS.frames,
  );
  const traversedCommitCount = boundedPositiveInteger(
    selection.traversedCommitCount,
    "selection.traversedCommitCount",
    EVOLUTION_BUNDLE_LIMITS.traversedCommits,
  );
  if (selectedCommitCount > traversedCommitCount) {
    fail(
      "selection.selectedCommitCount must not exceed traversedCommitCount",
    );
  }
  const sampleEvery =
    mode === "root-to-tip"
      ? undefined
      : boundedPositiveInteger(
          selection.sampleEvery,
          "selection.sampleEvery",
          EVOLUTION_BUNDLE_LIMITS.sampleEvery,
        );
  const maxFrames =
    mode === "root-to-tip"
      ? boundedPositiveInteger(
          selection.maxFrames,
          "selection.maxFrames",
          EVOLUTION_BUNDLE_LIMITS.frames,
        )
      : undefined;
  if (maxFrames !== undefined && maxFrames < 2) {
    fail("selection.maxFrames must be at least 2");
  }
  const samplingStrategy =
    mode === "root-to-tip"
      ? enumString(
          selection.samplingStrategy,
          new Set(["evenly-spaced-v1", "elapsed-time-v1"]),
          "selection.samplingStrategy",
        ) as "evenly-spaced-v1" | "elapsed-time-v1"
      : undefined;
  if (
    mode !== "root-to-tip" &&
    (selectedCommitCount > EVOLUTION_BUNDLE_LIMITS.customSelectionCommits ||
      traversedCommitCount > EVOLUTION_BUNDLE_LIMITS.customSelectionCommits)
  ) {
    fail(
      `selection selectedCommitCount and traversedCommitCount must not exceed ${EVOLUTION_BUNDLE_LIMITS.customSelectionCommits} for ${mode}`,
    );
  }
  const expectedSampledCount =
    maxFrames === undefined
      ? Math.ceil((selectedCommitCount - 1) / sampleEvery!) + 1
      : Math.min(selectedCommitCount, maxFrames);
  if (sampledCommitCount !== expectedSampledCount) {
    fail(
      "selection.sampledCommitCount must match endpoint-inclusive sampling",
    );
  }

  const resolvedOldestSha = gitSha(
    selection.resolvedOldestSha,
    "selection.resolvedOldestSha",
  );
  const resolvedNewestSha = gitSha(
    selection.resolvedNewestSha,
    "selection.resolvedNewestSha",
  );
  const sampledCommitShas = stringArray(
    selection.sampledCommitShas,
    "selection.sampledCommitShas",
    EVOLUTION_BUNDLE_LIMITS.frames,
    gitSha,
    work,
  );
  if (sampledCommitShas.length !== sampledCommitCount) {
    fail(
      "selection.sampledCommitShas length must equal sampledCommitCount",
    );
  }
  assertUnique(sampledCommitShas, "selection.sampledCommitShas");
  if (
    sampledCommitShas[0] !== resolvedOldestSha ||
    sampledCommitShas.at(-1) !== resolvedNewestSha
  ) {
    fail(
      "selection sampled endpoints must match resolvedOldestSha and resolvedNewestSha",
    );
  }
  if (
    sampledCommitCount === 1 &&
    resolvedOldestSha !== resolvedNewestSha
  ) {
    fail("a single sampled frame must have identical resolved boundaries");
  }

  const common = {
    traversal: "first-parent" as const,
    order: "oldest-first" as const,
    selectedCommitCount,
    sampledCommitCount,
    traversedCommitCount,
    resolvedOldestSha,
    resolvedNewestSha,
    sampledCommitShas,
  };
  switch (mode) {
    case "root-to-tip":
      return {
        ...common,
        mode,
        samplingStrategy: samplingStrategy!,
        maxFrames: maxFrames!,
      };
    case "commit-count": {
      const requestedCommitCount = boundedPositiveInteger(
        selection.requestedCommitCount,
        "selection.requestedCommitCount",
        EVOLUTION_BUNDLE_LIMITS.customSelectionCommits,
      );
      if (selectedCommitCount > requestedCommitCount) {
        fail(
          "selection.selectedCommitCount must not exceed requestedCommitCount",
        );
      }
      return {
        ...common,
        mode,
        sampleEvery: sampleEvery!,
        requestedCommitCount,
      };
    }
    case "date-range": {
      const fromInclusive = canonicalInstant(
        selection.fromInclusive,
        "selection.fromInclusive",
      );
      const toInclusive = canonicalInstant(
        selection.toInclusive,
        "selection.toInclusive",
      );
      if (fromInclusive > toInclusive) {
        fail(
          "selection.fromInclusive must not be later than toInclusive",
        );
      }
      return {
        ...common,
        mode,
        sampleEvery: sampleEvery!,
        fromInclusive,
        toInclusive,
      };
    }
    case "tag-range":
      return { ...common, mode, sampleEvery: sampleEvery! };
  }
}

function validateProvenance(
  value: unknown,
  generatorVersion: string,
): {
  readonly repositoryId: string;
  readonly repositoryFingerprint: EvolutionFingerprint;
  readonly analyzer: {
    readonly name: "code-city";
    readonly version: string;
    readonly fingerprint: EvolutionFingerprint;
  };
  readonly historyBackend: {
    readonly name: "git";
    readonly version: string;
    readonly renamePolicyRevision: string;
  };
  readonly metricConfigurationFingerprint: EvolutionFingerprint;
  readonly selectionFingerprint: EvolutionFingerprint;
} {
  const provenance = objectAt(value, "provenance");
  exactKeys(
    provenance,
    [
      "repositoryId",
      "repositoryFingerprint",
      "analyzer",
      "historyBackend",
      "metricConfigurationFingerprint",
      "selectionFingerprint",
    ],
    [],
    "provenance",
  );
  const analyzer = objectAt(provenance.analyzer, "provenance.analyzer");
  exactKeys(
    analyzer,
    ["name", "version", "fingerprint"],
    [],
    "provenance.analyzer",
  );
  if (analyzer.name !== "code-city") {
    fail('provenance.analyzer.name must be "code-city"');
  }
  const historyBackend = objectAt(
    provenance.historyBackend,
    "provenance.historyBackend",
  );
  exactKeys(
    historyBackend,
    ["name", "version", "renamePolicyRevision"],
    [],
    "provenance.historyBackend",
  );
  if (historyBackend.name !== "git") {
    fail('provenance.historyBackend.name must be "git"');
  }
  const analyzerVersion = nonEmptyString(
    analyzer.version,
    "provenance.analyzer.version",
    EVOLUTION_BUNDLE_LIMITS.versionCharacters,
  );
  if (analyzerVersion !== generatorVersion) {
    fail(
      "provenance.analyzer.version must equal generator.version",
    );
  }
  return {
    repositoryId: nonEmptyString(
      provenance.repositoryId,
      "provenance.repositoryId",
      EVOLUTION_BUNDLE_LIMITS.identifierCharacters,
    ),
    repositoryFingerprint: fingerprint(
      provenance.repositoryFingerprint,
      "provenance.repositoryFingerprint",
    ),
    analyzer: {
      name: "code-city",
      version: analyzerVersion,
      fingerprint: fingerprint(
        analyzer.fingerprint,
        "provenance.analyzer.fingerprint",
      ),
    },
    historyBackend: {
      name: "git",
      version: nonEmptyString(
        historyBackend.version,
        "provenance.historyBackend.version",
        EVOLUTION_BUNDLE_LIMITS.versionCharacters,
      ),
      renamePolicyRevision: nonEmptyString(
        historyBackend.renamePolicyRevision,
        "provenance.historyBackend.renamePolicyRevision",
        EVOLUTION_BUNDLE_LIMITS.versionCharacters,
      ),
    },
    metricConfigurationFingerprint: fingerprint(
      provenance.metricConfigurationFingerprint,
      "provenance.metricConfigurationFingerprint",
    ),
    selectionFingerprint: fingerprint(
      provenance.selectionFingerprint,
      "provenance.selectionFingerprint",
    ),
  };
}

function validateCommit(
  value: unknown,
  expectedIndex: number,
  expectedSha: string,
  expectedAnalyzerVersion: string,
  seenShas: Set<string>,
  seenAnalysisFingerprints: Set<string>,
  path: string,
  work: ValidationCheckpoint,
): EvolutionCommitMetadata {
  const commit = objectAt(value, path);
  exactKeys(
    commit,
    [
      "index",
      "sha",
      "committedAt",
      "parentShas",
      "analyzerVersion",
      "analysisFingerprint",
    ],
    [],
    path,
  );
  const index = nonNegativeInteger(commit.index, `${path}.index`);
  if (index !== expectedIndex) {
    fail(`${path}.index must be ${expectedIndex}`);
  }
  const sha = gitSha(commit.sha, `${path}.sha`);
  if (sha !== expectedSha) {
    fail(`${path}.sha must match selection.sampledCommitShas[${expectedIndex}]`);
  }
  if (seenShas.has(sha)) {
    fail(`${path}.sha is duplicated`);
  }
  seenShas.add(sha);
  const parentShas = stringArray(
    commit.parentShas,
    `${path}.parentShas`,
    EVOLUTION_BUNDLE_LIMITS.parentsPerCommit,
    gitSha,
    work,
  );
  assertUnique(parentShas, `${path}.parentShas`);
  if (parentShas.includes(sha)) {
    fail(`${path}.parentShas must not contain the commit itself`);
  }
  const analyzerVersion = nonEmptyString(
    commit.analyzerVersion,
    `${path}.analyzerVersion`,
    EVOLUTION_BUNDLE_LIMITS.versionCharacters,
  );
  if (analyzerVersion !== expectedAnalyzerVersion) {
    fail(`${path}.analyzerVersion must equal generator.version`);
  }
  const analysisFingerprint = fingerprint(
    commit.analysisFingerprint,
    `${path}.analysisFingerprint`,
  );
  if (seenAnalysisFingerprints.has(analysisFingerprint)) {
    fail(`${path}.analysisFingerprint is duplicated`);
  }
  seenAnalysisFingerprints.add(analysisFingerprint);
  return {
    index,
    sha,
    committedAt: canonicalInstant(
      commit.committedAt,
      `${path}.committedAt`,
    ),
    parentShas,
    analyzerVersion,
    analysisFingerprint,
  };
}

function validateCommitSelectionTime(
  commit: EvolutionCommitMetadata,
  selection: NormalizedEvolutionSelection,
  path: string,
): void {
  const committedAt = Date.parse(commit.committedAt);
  if (
    selection.mode === "date-range" &&
    (committedAt < Date.parse(selection.fromInclusive) ||
      committedAt > Date.parse(selection.toInclusive))
  ) {
    fail(
      `${path}.committedAt must lie within the inclusive selection date range`,
    );
  }
}

function validateFrameProvenance(
  model: CityModel,
  generatorValue: unknown,
  repositoryId: string,
  path: string,
  work: ValidationCheckpoint,
): void {
  if (!deepEqual(model.generator, generatorValue, work)) {
    fail(`${path}.generator must equal the bundle generator`);
  }
  if (
    !model.repositories.some(({ id }) => {
      work.consume();
      return id === repositoryId;
    })
  ) {
    fail(
      `${path} must retain provenance.repositoryId in repositories`,
    );
  }
}

function applyEvolutionChanges(
  state: ReplayState,
  value: unknown,
  path: string,
  work: ValidationCheckpoint,
): CityModel {
  const changes = objectAt(value, path);
  exactKeys(
    changes,
    ["model", ...EVOLUTION_ENTITY_COLLECTIONS],
    [],
    path,
  );
  const next = cloneJsonValue(state.model, work) as unknown as JsonObject;
  applyModelChanges(next, changes.model, `${path}.model`, work);

  for (const collection of EVOLUTION_ENTITY_COLLECTIONS) {
    work.consume();
    const current = objectArray(
      next[collection],
      `model.${collection}`,
      COLLECTION_LIMITS[collection],
      work,
    );
    next[collection] = applyEntityDelta(
      state,
      collection,
      current,
      changes[collection],
      `${path}.${collection}`,
      work,
    );
  }
  if (state.operationCount > EVOLUTION_BUNDLE_LIMITS.deltaOperations) {
    fail(
      `bundle must contain at most ${EVOLUTION_BUNDLE_LIMITS.deltaOperations} delta operations`,
    );
  }
  assertLineageLimit(state.lineages);
  return validateCityModel(
    next,
    work.callback === undefined
      ? {}
      : { checkpoint: work.callback },
  );
}

function applyModelChanges(
  model: JsonObject,
  value: unknown,
  path: string,
  work: ValidationCheckpoint,
): void {
  const changes = objectAt(value, path);
  exactKeys(changes, [], MODEL_CHANGE_KEYS, path);
  for (const key of MODEL_CHANGE_KEYS) {
    work.consume();
    if (!Object.hasOwn(changes, key)) continue;
    const change = changes[key];
    const current = normalizeModelRootValue(key, model[key], work);
    const replacement =
      change === null
        ? undefined
        : normalizeModelRootValue(key, change, work);
    if (deepEqual(current, replacement, work)) {
      fail(`${path}.${key} must not be a no-op`);
    }
    if (change === null) {
      if (key === "bounds") {
        fail(`${path}.bounds cannot be removed`);
      }
      delete model[key];
    } else {
      model[key] = cloneJsonValue(change, work);
    }
  }
}

function applyEntityDelta(
  state: ReplayState,
  collection: EvolutionEntityCollection,
  current: JsonObject[],
  value: unknown,
  path: string,
  work: ValidationCheckpoint,
): JsonObject[] {
  const delta = objectAt(value, path);
  exactKeys(delta, ["added", "removed", "changed"], [], path);
  const maximum = COLLECTION_LIMITS[collection];
  const added = objectArray(
    delta.added,
    `${path}.added`,
    maximum,
    work,
  );
  const removed = stringArray(
    delta.removed,
    `${path}.removed`,
    maximum,
    (item, itemPath) =>
      nonEmptyString(
        item,
        itemPath,
        EVOLUTION_BUNDLE_LIMITS.identifierCharacters,
      ),
    work,
  );
  const changed = objectArray(
    delta.changed,
    `${path}.changed`,
    maximum,
    work,
  );
  state.operationCount += added.length + removed.length + changed.length;

  const addedIds = added.map((entity, index) => {
    work.consume();
    return entityId(entity, `${path}.added[${index}]`);
  });
  const changedIds = changed.map((replacement, index) => {
    work.consume();
    return nonEmptyString(
      replacement.id,
      `${path}.changed[${index}].id`,
      EVOLUTION_BUNDLE_LIMITS.identifierCharacters,
    );
  });
  assertUnique(addedIds, `${path}.added`, work);
  assertUnique(removed, `${path}.removed`, work);
  assertUnique(changedIds, `${path}.changed`, work);
  assertSorted(addedIds, `${path}.added`, work);
  assertSorted(removed, `${path}.removed`, work);
  assertSorted(changedIds, `${path}.changed`, work);

  const operated = new Set<string>();
  for (const [operation, ids] of [
    ["added", addedIds],
    ["removed", removed],
    ["changed", changedIds],
  ] as const) {
    ids.forEach((id, index) => {
      work.consume();
      if (operated.has(id)) {
        fail(
          `${path}.${operation}[${index}] overlaps another operation for id "${id}"`,
        );
      }
      operated.add(id);
    });
  }

  const entities = new Map<string, JsonObject>();
  current.forEach((entity, index) => {
    work.consume();
    entities.set(
      entityId(entity, `model.${collection}[${index}]`),
      entity,
    );
  });
  removed.forEach((id, index) => {
    work.consume();
    if (!entities.delete(id)) {
      fail(`${path}.removed[${index}] references an unknown id`);
    }
  });
  changed.forEach((replacement, index) => {
    work.consume();
    const replacementPath = `${path}.changed[${index}]`;
    exactKeys(
      replacement,
      ["id", "changeKinds", "entity"],
      [],
      replacementPath,
    );
    const id = changedIds[index]!;
    const before = entities.get(id);
    if (before === undefined) {
      fail(`${replacementPath}.id references an unknown id`);
    }
    const entity = objectAt(
      replacement.entity,
      `${replacementPath}.entity`,
    );
    if (entityId(entity, `${replacementPath}.entity`) !== id) {
      fail(`${replacementPath}.entity.id must equal id`);
    }
    const declaredKinds = validateChangeKinds(
      replacement.changeKinds,
      `${replacementPath}.changeKinds`,
    );
    const actualKinds = deriveEvolutionChangeKindsUnchecked(
      collection,
      before,
      entity,
      work,
    );
    if (
      actualKinds.length === 0 ||
      !deepEqual(declaredKinds, actualKinds, work)
    ) {
      fail(
        `${replacementPath}.changeKinds must exactly describe the full replacement (${actualKinds.join(", ") || "no changes"})`,
      );
    }
    entities.set(id, cloneJsonValue(entity, work));
  });
  added.forEach((entity, index) => {
    work.consume();
    const id = addedIds[index]!;
    if (entities.has(id)) {
      fail(`${path}.added[${index}].id already exists`);
    }
    const lineage = `${collection}\u0000${id}`;
    if (state.lineages.has(lineage)) {
      fail(
        `${path}.added[${index}].id references a retired lineage and cannot be re-added`,
      );
    }
    entities.set(id, cloneJsonValue(entity, work));
    state.lineages.add(lineage);
  });

  const result: JsonObject[] = [];
  for (const entity of entities.values()) {
    work.consume();
    result.push(entity);
  }
  return result.sort((left, right) => {
    work.consume();
    return compareText(left.id as string, right.id as string);
  });
}

function validateChangeKinds(
  value: unknown,
  path: string,
): readonly EvolutionChangeKind[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail(`${path} must be a non-empty array`);
  }
  if (value.length > EVOLUTION_CHANGE_KINDS.length) {
    fail(
      `${path} must contain at most ${EVOLUTION_CHANGE_KINDS.length} items`,
    );
  }
  const kinds = value.map((item, index) =>
    enumString(
      item,
      new Set<string>(EVOLUTION_CHANGE_KINDS),
      `${path}[${index}]`,
    ),
  ) as EvolutionChangeKind[];
  assertUnique(kinds, path);
  const sorted = [...kinds].sort(
    (left, right) =>
      CHANGE_KIND_RANK.get(left)! - CHANGE_KIND_RANK.get(right)!,
  );
  if (!deepEqual(kinds, sorted)) {
    fail(`${path} must use canonical change-kind order`);
  }
  return kinds;
}

function deriveEvolutionChangeKindsUnchecked(
  collection: EvolutionEntityCollection,
  beforeValue: JsonObject,
  afterValue: JsonObject,
  work?: ValidationCheckpoint,
): readonly EvolutionChangeKind[] {
  const before = normalizeEntity(collection, beforeValue, work);
  const after = normalizeEntity(collection, afterValue, work);
  const changedFields = new Set(
    [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
      (key) => {
        work?.consume();
        return (
          key !== "id" &&
          !deepEqual(before[key], after[key], work)
        );
      },
    ),
  );
  if (changedFields.size === 0) return [];

  const kinds: EvolutionChangeKind[] = [];
  consumeFields(changedFields, renamedFields(collection), "renamed", kinds);
  consumeFields(changedFields, movedFields(collection), "moved", kinds);
  consumeFields(changedFields, metricsFields(collection), "metrics", kinds);
  consumeFields(
    changedFields,
    relationshipFields(collection),
    "relationships",
    kinds,
  );
  consumeFields(changedFields, geometryFields(collection), "geometry", kinds);
  if (changedFields.size > 0) kinds.push("metadata");
  return kinds;
}

function consumeFields(
  changed: Set<string>,
  fields: readonly string[],
  kind: EvolutionChangeKind,
  result: EvolutionChangeKind[],
): void {
  let consumed = false;
  fields.forEach((field) => {
    if (changed.delete(field)) consumed = true;
  });
  if (consumed) result.push(kind);
}

function renamedFields(
  collection: EvolutionEntityCollection,
): readonly string[] {
  switch (collection) {
    case "semanticGroups":
      return ["label"];
    case "repositories":
    case "solutions":
    case "modules":
    case "districts":
    case "buildings":
      return ["name"];
    case "dependencies":
      return [];
  }
}

function movedFields(
  collection: EvolutionEntityCollection,
): readonly string[] {
  switch (collection) {
    case "solutions":
    case "modules":
    case "districts":
    case "buildings":
      return ["path"];
    default:
      return [];
  }
}

function metricsFields(
  collection: EvolutionEntityCollection,
): readonly string[] {
  return collection === "buildings"
    ? [
        "metrics",
        "metricMethod",
        "metricNormalization",
        "units",
        "risk",
      ]
    : [];
}

function relationshipFields(
  collection: EvolutionEntityCollection,
): readonly string[] {
  switch (collection) {
    case "repositories":
      return [];
    case "solutions":
      return ["repositoryId", "moduleIds"];
    case "modules":
      return ["repositoryId", "parentModuleId", "solutionIds"];
    case "semanticGroups":
      return ["mergeInto"];
    case "districts":
      return ["repositoryId", "moduleId"];
    case "buildings":
      return [
        "repositoryId",
        "moduleId",
        "districtId",
        "semanticGroupId",
      ];
    case "dependencies":
      return [
        "repositoryId",
        "sourceId",
        "targetId",
        "externalTarget",
        "resolution",
        "kind",
      ];
  }
}

function geometryFields(
  collection: EvolutionEntityCollection,
): readonly string[] {
  return collection === "districts" || collection === "buildings"
    ? ["position", "size"]
    : [];
}

function normalizeCityModel(
  model: CityModel,
  work: ValidationCheckpoint,
): CityModel {
  const normalized = cloneJsonValue(
    model,
    work,
  ) as unknown as JsonObject;
  for (const collection of EVOLUTION_ENTITY_COLLECTIONS) {
    work.consume();
    const entities = (normalized[collection] as JsonObject[]).map(
      (entity) => {
        work.consume();
        return normalizeOwnedEntity(collection, entity, work);
      },
    );
    entities.sort((left, right) => {
      work.consume();
      return compareEntities(left, right);
    });
    normalized[collection] = entities;
  }
  if (normalized.analysis !== undefined) {
    normalized.analysis = normalizeOwnedModelRootValue(
      "analysis",
      normalized.analysis,
      work,
    );
  }
  if (normalized.identity !== undefined) {
    normalized.identity = normalizeOwnedModelRootValue(
      "identity",
      normalized.identity,
      work,
    );
  }
  return normalized as unknown as CityModel;
}

function normalizeEntity(
  collection: EvolutionEntityCollection,
  value: JsonObject,
  work?: ValidationCheckpoint,
): JsonObject {
  return normalizeOwnedEntity(
    collection,
    cloneJsonValue(value, work),
    work,
  );
}

function normalizeOwnedEntity(
  collection: EvolutionEntityCollection,
  entity: JsonObject,
  work?: ValidationCheckpoint,
): JsonObject {
  switch (collection) {
    case "solutions":
      sortStringProperty(entity, "moduleIds", work);
      break;
    case "modules":
      sortStringProperty(entity, "solutionIds", work);
      sortStringProperty(entity, "targetFrameworks", work);
      break;
    case "buildings":
      if (Array.isArray(entity.units)) {
        entity.units.sort((left, right) => {
          work?.consume();
          const leftUnit = left as JsonObject;
          const rightUnit = right as JsonObject;
          return (
            (leftUnit.line as number) - (rightUnit.line as number) ||
            compareText(
              leftUnit.name as string,
              rightUnit.name as string,
            ) ||
            (leftUnit.complexity as number) -
              (rightUnit.complexity as number)
          );
        });
      }
      break;
  }
  return entity;
}

function normalizeModelRootValue(
  key: (typeof MODEL_CHANGE_KEYS)[number],
  value: unknown,
  work: ValidationCheckpoint,
): unknown {
  if (value === undefined || value === null) return value;
  return normalizeOwnedModelRootValue(
    key,
    cloneJsonValue(value, work),
    work,
  );
}

function normalizeOwnedModelRootValue(
  key: (typeof MODEL_CHANGE_KEYS)[number],
  normalized: unknown,
  work: ValidationCheckpoint,
): unknown {
  if (key === "analysis") {
    const analysis = normalized as JsonObject;
    sortStringProperty(analysis, "warnings", work);
  }
  if (key === "identity") {
    const identity = normalized as JsonObject;
    if (Array.isArray(identity.repositories)) {
      identity.repositories.sort((left, right) => {
        work.consume();
        return compareText(
          (left as JsonObject).repositoryId as string,
          (right as JsonObject).repositoryId as string,
        );
      });
    }
  }
  return normalized;
}

function sortStringProperty(
  object: JsonObject,
  key: string,
  work?: ValidationCheckpoint,
): void {
  if (Array.isArray(object[key])) {
    object[key].sort((left, right) => {
      work?.consume();
      return compareText(left as string, right as string);
    });
  }
}

function collectLineages(
  model: CityModel,
  work: ValidationCheckpoint,
): Set<string> {
  const lineages = new Set<string>();
  for (const collection of EVOLUTION_ENTITY_COLLECTIONS) {
    model[collection].forEach(({ id }) => {
      work.consume();
      lineages.add(`${collection}\u0000${id}`);
    });
  }
  return lineages;
}

function assertLineageLimit(lineages: ReadonlySet<string>): void {
  if (lineages.size > EVOLUTION_BUNDLE_LIMITS.uniqueEntityLineages) {
    fail(
      `bundle must contain at most ${EVOLUTION_BUNDLE_LIMITS.uniqueEntityLineages} unique entity lineages`,
    );
  }
}

function compareEntities(left: JsonObject, right: JsonObject): number {
  return compareText(left.id as string, right.id as string);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function cloneJsonValue<T>(
  value: T,
  work?: ValidationCheckpoint,
  seen: WeakMap<object, unknown> = new WeakMap<object, unknown>(),
): T {
  work?.consume();
  if (typeof value !== "object" || value === null) return value;
  const existing = seen.get(value);
  if (existing !== undefined) return existing as T;
  if (Array.isArray(value)) {
    const result = new Array<unknown>(value.length);
    seen.set(value, result);
    for (let index = 0; index < value.length; index += 1) {
      result[index] = cloneJsonValue(value[index], work, seen);
    }
    return result as T;
  }
  const result = Object.create(
    Object.getPrototypeOf(value) === null ? null : Object.prototype,
  ) as JsonObject;
  seen.set(value, result);
  for (const key of Object.keys(value)) {
    work?.consume();
    result[key] = cloneJsonValue(
      (value as JsonObject)[key],
      work,
      seen,
    );
  }
  return result as T;
}

function deepEqual(
  left: unknown,
  right: unknown,
  work?: ValidationCheckpoint,
): boolean {
  work?.consume();
  if (typeof left === "string" && typeof right === "string") {
    if (left.length !== right.length) return false;
    if (work?.callback === undefined) return left === right;
    for (let index = 0; index < left.length; index += 1) {
      if (index > 0 && (index & 0x3fff) === 0) work.checkpoint();
      if (left.charCodeAt(index) !== right.charCodeAt(index)) return false;
    }
    return true;
  }
  if (left === right) return true;
  if (
    typeof left !== "object" ||
    left === null ||
    typeof right !== "object" ||
    right === null ||
    Array.isArray(left) !== Array.isArray(right)
  ) {
    return false;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      if (!deepEqual(left[index], right[index], work)) return false;
    }
    return true;
  }
  const leftObject = left as JsonObject;
  const rightObject = right as JsonObject;
  const leftKeys = Object.keys(leftObject);
  if (leftKeys.length !== Object.keys(rightObject).length) return false;
  for (const key of leftKeys) {
    work?.consume();
    if (
      !Object.hasOwn(rightObject, key) ||
      !deepEqual(leftObject[key], rightObject[key], work)
    ) {
      return false;
    }
  }
  return true;
}

function dataDescriptorValue(
  descriptor: PropertyDescriptor | undefined,
  path: string,
): unknown {
  if (descriptor === undefined || !("value" in descriptor)) {
    fail(`${path} must be an own data property`);
  }
  return descriptor.value;
}

interface RuntimeProxyInspector {
  readonly types?: {
    readonly isProxy?: (value: unknown) => boolean;
  };
}

interface RuntimeProcessWithBuiltins {
  readonly getBuiltinModule?: (
    name: string,
  ) => RuntimeProxyInspector | undefined;
}

function runtimeProxyDetector():
  | ((value: unknown) => boolean)
  | undefined {
  const runtimeProcess = (
    globalThis as unknown as {
      readonly process?: RuntimeProcessWithBuiltins;
    }
  ).process;
  try {
    return runtimeProcess
      ?.getBuiltinModule?.("node:util")
      ?.types?.isProxy;
  } catch {
    return undefined;
  }
}

function jsonDataDescriptors(
  item: object,
  path: string,
  work?: ValidationCheckpoint,
): Readonly<Record<PropertyKey, PropertyDescriptor>> {
  const prototype = Object.getPrototypeOf(item);
  if (Array.isArray(item) && prototype !== Array.prototype) {
    fail(`${path} must contain only plain JSON arrays`);
  }
  if (
    !Array.isArray(item) &&
    prototype !== Object.prototype &&
    prototype !== null
  ) {
    fail(`${path} must contain only plain JSON objects`);
  }

  const descriptorKeys = Reflect.ownKeys(item);
  for (const key of descriptorKeys) {
    if (typeof key !== "string") {
      fail(`${path} must not contain symbol properties`);
    }
    jsonStringBytes(key, work);
  }
  const descriptors = Object.getOwnPropertyDescriptors(item);
  if (Array.isArray(item)) {
    const length = dataDescriptorValue(
      descriptors.length,
      `${path}.length`,
    );
    if (
      typeof length !== "number" ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      descriptorKeys.length !== length + 1
    ) {
      fail(`${path} must be a dense JSON array without extra properties`);
    }
    for (let index = 0; index < length; index += 1) {
      dataDescriptorValue(
        descriptors[String(index)],
        `${path}[${index}]`,
      );
    }
    return descriptors;
  }

  for (const key of descriptorKeys) {
    if (typeof key !== "string") continue;
    const descriptor = descriptors[key];
    if (descriptor?.enumerable !== true) {
      fail(`${path}.${key} must be an enumerable data property`);
    }
    dataDescriptorValue(descriptor, `${path}.${key}`);
  }
  return descriptors;
}

function ownedJsonSnapshot<T>(
  value: T,
  work: ValidationCheckpoint,
): PreparedJsonTree<T> {
  assertPlainJson(value, work);
  const active = new WeakSet<object>();
  let nodes = 0;
  const snapshot = (
    item: unknown,
    path: string,
    depth: number,
  ): unknown => {
    work.consume();
    nodes += 1;
    if (nodes > EVOLUTION_BUNDLE_LIMITS.jsonValues) {
      fail(
        `bundle JSON must contain at most ${EVOLUTION_BUNDLE_LIMITS.jsonValues} values`,
      );
    }
    if (depth > EVOLUTION_BUNDLE_LIMITS.jsonDepth) {
      fail(
        `bundle JSON must not exceed ${EVOLUTION_BUNDLE_LIMITS.jsonDepth} nested levels`,
      );
    }
    if (typeof item !== "object" || item === null) return item;
    if (active.has(item)) {
      fail(`${path} must not contain a circular reference`);
    }
    active.add(item);
    const descriptors = jsonDataDescriptors(item, path, work);
    let result: object;
    if (Array.isArray(item)) {
      const length = dataDescriptorValue(
        descriptors.length,
        `${path}.length`,
      );
      if (typeof length !== "number") {
        fail(`${path}.length must be a number`);
      }
      const array: unknown[] = [];
      for (let index = 0; index < length; index += 1) {
        array.push(
          snapshot(
            dataDescriptorValue(
              descriptors[String(index)],
              `${path}[${index}]`,
            ),
            `${path}[${index}]`,
            depth + 1,
          ),
        );
      }
      result = array;
    } else {
      const object = Object.create(
        Object.getPrototypeOf(item) === null
          ? null
          : Object.prototype,
      ) as Record<string, unknown>;
      for (const key of Reflect.ownKeys(descriptors)) {
        if (typeof key !== "string") continue;
        Object.defineProperty(object, key, {
          configurable: true,
          enumerable: true,
          value: snapshot(
            dataDescriptorValue(descriptors[key], `${path}.${key}`),
            `${path}.${key}`,
            depth + 1,
          ),
          writable: true,
        });
      }
      result = object;
    }
    active.delete(item);
    return Object.freeze(result);
  };
  const owned = snapshot(value, "bundle", 0) as T;
  return Object.freeze({
    value: owned,
    measuredBytes: assertPlainJson(owned, work),
  });
}

function jsonStringBytes(
  value: string,
  work?: ValidationCheckpoint,
): number {
  let bytes = 2;
  for (let index = 0; index < value.length; index += 1) {
    if (
      work?.callback !== undefined &&
      index > 0 &&
      (index & 0x3fff) === 0
    ) {
      work.checkpoint();
    }
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c) {
      bytes += 2;
    } else if (code <= 0x1f) {
      bytes +=
        code === 0x08 ||
        code === 0x09 ||
        code === 0x0a ||
        code === 0x0c ||
        code === 0x0d
          ? 2
          : 6;
    } else if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 6;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      bytes += 6;
    } else {
      bytes += 3;
    }
    if (bytes > EVOLUTION_BUNDLE_LIMITS.serializedBytes) {
      fail(
        `serialized bundle must not exceed ${EVOLUTION_BUNDLE_LIMITS.serializedBytes} bytes`,
      );
    }
    if (bytes > EVOLUTION_BUNDLE_LIMITS.jsonStringBytes) {
      fail(
        `bundle JSON strings and property names must not exceed ${EVOLUTION_BUNDLE_LIMITS.jsonStringBytes} encoded bytes`,
      );
    }
  }
  return bytes;
}

function assertPlainJson(
  value: unknown,
  work?: ValidationCheckpoint,
): number {
  const active = new WeakSet<object>();
  let nodes = 0;
  const assertBytes = (bytes: number): number => {
    if (bytes > EVOLUTION_BUNDLE_LIMITS.serializedBytes) {
      fail(
        `serialized bundle must not exceed ${EVOLUTION_BUNDLE_LIMITS.serializedBytes} bytes`,
      );
    }
    return bytes;
  };
  const scalarBytes = (
    item: null | string | boolean | number,
  ): number => {
    if (typeof item === "string") return jsonStringBytes(item, work);
    if (item === null) return 4;
    if (typeof item === "boolean") return item ? 4 : 5;
    return String(item).length;
  };
  const visit = (
    item: unknown,
    path: string,
    depth: number,
  ): number => {
    work?.consume();
    nodes += 1;
    if (nodes > EVOLUTION_BUNDLE_LIMITS.jsonValues) {
      fail(
        `bundle JSON must contain at most ${EVOLUTION_BUNDLE_LIMITS.jsonValues} values`,
      );
    }
    if (depth > EVOLUTION_BUNDLE_LIMITS.jsonDepth) {
      fail(
        `bundle JSON must not exceed ${EVOLUTION_BUNDLE_LIMITS.jsonDepth} nested levels`,
      );
    }
    if (
      item === null ||
      typeof item === "string" ||
      typeof item === "boolean"
    ) {
      return scalarBytes(item);
    }
    if (typeof item === "number") {
      if (!Number.isFinite(item)) {
        fail(`${path} must be a finite JSON number`);
      }
      return scalarBytes(item);
    }
    if (typeof item !== "object") {
      fail(`${path} must contain only JSON values`);
    }
    if (active.has(item)) {
      fail(`${path} must not contain a circular reference`);
    }
    active.add(item);
    let bytes = 2;
    const descriptors = jsonDataDescriptors(item, path, work);
    const descriptorKeys = Reflect.ownKeys(descriptors);
    if (Array.isArray(item)) {
      const length = dataDescriptorValue(
        descriptors.length,
        `${path}.length`,
      );
      if (typeof length !== "number") {
        fail(`${path}.length must be a number`);
      }
      for (let index = 0; index < length; index += 1) {
        const child = dataDescriptorValue(
          descriptors[String(index)],
          `${path}[${index}]`,
        );
        if (index > 0) bytes += 1;
        bytes += visit(child, `${path}[${index}]`, depth + 1);
        assertBytes(bytes);
      }
    } else {
      descriptorKeys.forEach((key, index) => {
        if (typeof key !== "string") return;
        const descriptor = descriptors[key];
        const child = dataDescriptorValue(descriptor, `${path}.${key}`);
        if (index > 0) bytes += 1;
        bytes += scalarBytes(key) + 1;
        bytes += visit(child, `${path}.${key}`, depth + 1);
        assertBytes(bytes);
      });
    }
    active.delete(item);
    return assertBytes(bytes);
  };
  return assertBytes(visit(value, "bundle", 0));
}

function objectAt(value: unknown, path: string): JsonObject {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    fail(`${path} must be an object`);
  }
  return value as JsonObject;
}

function objectArray(
  value: unknown,
  path: string,
  maximumLength: number,
  work?: ValidationCheckpoint,
): JsonObject[] {
  if (!Array.isArray(value)) {
    fail(`${path} must be an array`);
  }
  if (value.length > maximumLength) {
    fail(`${path} must contain at most ${maximumLength} items`);
  }
  return value.map((item, index) => {
    work?.consume();
    return objectAt(item, `${path}[${index}]`);
  });
}

function stringArray(
  value: unknown,
  path: string,
  maximumLength: number,
  validate: (item: unknown, path: string) => string,
  work?: ValidationCheckpoint,
): string[] {
  if (!Array.isArray(value)) {
    fail(`${path} must be an array`);
  }
  if (value.length > maximumLength) {
    fail(`${path} must contain at most ${maximumLength} items`);
  }
  return value.map((item, index) => {
    work?.consume();
    return validate(item, `${path}[${index}]`);
  });
}

function exactKeys(
  object: JsonObject,
  required: readonly string[],
  optional: readonly string[],
  path: string,
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!Object.hasOwn(object, key)) {
      fail(`${path}.${key} is required`);
    }
  }
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) {
      fail(`${path}.${key} is not supported`);
    }
  }
}

function entityId(entity: JsonObject, path: string): string {
  return nonEmptyString(
    entity.id,
    `${path}.id`,
    EVOLUTION_BUNDLE_LIMITS.identifierCharacters,
  );
}

function gitSha(value: unknown, path: string): string {
  const sha = nonEmptyString(value, path, 64);
  if (!GIT_OBJECT_SHA.test(sha) || /^0+$/u.test(sha)) {
    fail(
      `${path} must be a nonzero lowercase 40- or 64-character Git object SHA`,
    );
  }
  return sha;
}

function fingerprint(
  value: unknown,
  path: string,
): EvolutionFingerprint {
  const item = nonEmptyString(value, path, 71);
  if (!SHA256_FINGERPRINT.test(item)) {
    fail(`${path} must be a lowercase sha256 fingerprint`);
  }
  return item as EvolutionFingerprint;
}

function canonicalInstant(value: unknown, path: string): string {
  const instant = nonEmptyString(value, path, 24);
  const parsed = new Date(instant);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString() !== instant
  ) {
    fail(`${path} must be a canonical UTC instant`);
  }
  return instant;
}

function nonEmptyString(
  value: unknown,
  path: string,
  maximumLength: number,
): string {
  if (typeof value !== "string") {
    fail(`${path} must be a string`);
  }
  if (value.length > maximumLength) {
    fail(`${path} must not exceed ${maximumLength} characters`);
  }
  if (value.trim().length === 0) {
    fail(`${path} must not be empty`);
  }
  if (UNSAFE_TEXT_CHARACTERS.test(value)) {
    fail(`${path} must not contain control or formatting characters`);
  }
  return value;
}

function enumString(
  value: unknown,
  allowed: ReadonlySet<string>,
  path: string,
): string {
  const item = nonEmptyString(value, path, 64);
  if (!allowed.has(item)) {
    fail(`${path} has an unsupported value`);
  }
  return item;
}

function nonNegativeInteger(value: unknown, path: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    fail(`${path} must be a non-negative safe integer`);
  }
  return value;
}

function boundedPositiveInteger(
  value: unknown,
  path: string,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1
  ) {
    fail(`${path} must be a positive safe integer`);
  }
  if (value > maximum) {
    fail(`${path} must not exceed ${maximum}`);
  }
  return value;
}

function assertUnique(
  values: readonly string[],
  path: string,
  work?: ValidationCheckpoint,
): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    work?.consume();
    if (seen.has(value)) {
      fail(`${path}[${index}] is duplicated`);
    }
    seen.add(value);
  });
}

function assertSorted(
  values: readonly string[],
  path: string,
  work?: ValidationCheckpoint,
): void {
  for (let index = 1; index < values.length; index += 1) {
    work?.consume();
    if (compareText(values[index - 1]!, values[index]!) > 0) {
      fail(`${path} must be sorted by id`);
    }
  }
}

function fail(message: string): never {
  throw new Error(message);
}
