import {
  CITY_MODEL_LIMITS,
  type CityModel,
} from "../../../packages/core/src/index.js";
import { normalizeExternalDependencyTarget } from "../../../packages/core/src/external-dependencies.js";
import {
  evolutionDependencyEndpointKey,
  evolutionDependencyRouteKey,
  type EvolutionBuildingHistory,
  type EvolutionDependencyEndpointIdentity,
  type EvolutionDependencyRouteIdentity,
  type EvolutionFrameAnalysis,
  type EvolutionFrameSummary,
  type EvolutionTransition,
} from "./evolution-timeline.js";

export interface EvolutionLoadRequest {
  readonly type: "load";
  readonly requestId: number;
  readonly bytes: ArrayBuffer;
  readonly expectedSize: number;
  readonly expectedSha256: string;
}

export interface EvolutionSeekRequest {
  readonly type: "seek";
  readonly requestId: number;
  readonly fromIndex: number;
  readonly toIndex: number;
}

export interface EvolutionCancelRequest {
  readonly type: "cancel";
  readonly requestId: number;
}

export type EvolutionWorkerRequest =
  | EvolutionCancelRequest
  | EvolutionLoadRequest
  | EvolutionSeekRequest;

export interface EvolutionLoadResult {
  readonly type: "loaded";
  readonly requestId: number;
  readonly frames: readonly EvolutionFrameSummary[];
  /** Default replay origin; earlier frames are the technical baseline. */
  readonly playbackStartIndex: number;
  readonly histories: readonly EvolutionBuildingHistory[];
  readonly model: CityModel;
  readonly analysis: EvolutionFrameAnalysis;
}

export interface EvolutionSeekResult {
  readonly type: "frame";
  readonly requestId: number;
  readonly frame: EvolutionFrameSummary;
  readonly model: CityModel;
  readonly analysis: EvolutionFrameAnalysis;
  readonly transition: EvolutionTransition;
}

export interface EvolutionWorkerFailure {
  readonly type: "failure";
  readonly requestId: number;
  readonly message: string;
}

export type EvolutionWorkerResponse =
  | EvolutionLoadResult
  | EvolutionSeekResult
  | EvolutionWorkerFailure;

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const GIT_SHA_PATTERN = /^[0-9a-f]{40,64}$/u;
const MAXIMUM_ERROR_CHARACTERS = 512;
const MAXIMUM_FRAMES = 100;
const MAXIMUM_BUILDINGS = 100_000;
const MAXIMUM_DEPENDENCIES = CITY_MODEL_LIMITS.dependencies;
const MAXIMUM_AFFECTED_DEPENDENCY_ROUTES =
  MAXIMUM_DEPENDENCIES * 2;
const MAXIMUM_AFFECTED_DEPENDENCY_ENDPOINTS =
  MAXIMUM_AFFECTED_DEPENDENCY_ROUTES * 2;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function requestId(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function frameIndex(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

export function isEvolutionWorkerRequest(
  value: unknown,
): value is EvolutionWorkerRequest {
  const candidate = record(value);
  if (!candidate || !requestId(candidate["requestId"])) return false;
  if (candidate["type"] === "load") {
    return (
      exactKeys(candidate, [
        "type",
        "requestId",
        "bytes",
        "expectedSize",
        "expectedSha256",
      ]) &&
      candidate["bytes"] instanceof ArrayBuffer &&
      Number.isSafeInteger(candidate["expectedSize"]) &&
      Number(candidate["expectedSize"]) > 0 &&
      candidate["bytes"].byteLength === candidate["expectedSize"] &&
      typeof candidate["expectedSha256"] === "string" &&
      SHA256_PATTERN.test(candidate["expectedSha256"])
    );
  }
  if (candidate["type"] === "cancel") {
    return exactKeys(candidate, ["type", "requestId"]);
  }
  return (
    candidate["type"] === "seek" &&
    exactKeys(candidate, ["type", "requestId", "fromIndex", "toIndex"]) &&
    frameIndex(candidate["fromIndex"]) &&
    frameIndex(candidate["toIndex"])
  );
}

function frameSummary(value: unknown): boolean {
  const candidate = record(value);
  return (
    candidate !== undefined &&
    exactKeys(candidate, ["index", "sha", "committedAt"]) &&
    frameIndex(candidate["index"]) &&
    typeof candidate["sha"] === "string" &&
    GIT_SHA_PATTERN.test(candidate["sha"]) &&
    typeof candidate["committedAt"] === "string" &&
    Number.isFinite(Date.parse(candidate["committedAt"]))
  );
}

function stringArray(
  value: unknown,
  maximum = MAXIMUM_BUILDINGS,
): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length <= maximum &&
    value.every((item) => typeof item === "string" && item.length > 0)
  );
}

function analysis(value: unknown): boolean {
  const candidate = record(value);
  const pairs = (item: unknown): boolean =>
    Array.isArray(item) &&
    item.length <= MAXIMUM_BUILDINGS &&
    item.every(
      (pair) =>
        Array.isArray(pair) &&
        pair.length === 2 &&
        typeof pair[0] === "string" &&
        pair[0].length > 0 &&
        frameIndex(pair[1]),
    );
  return (
    candidate !== undefined &&
    exactKeys(candidate, ["ageByBuildingId", "churnByBuildingId"]) &&
    pairs(candidate["ageByBuildingId"]) &&
    pairs(candidate["churnByBuildingId"])
  );
}

function histories(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= MAXIMUM_BUILDINGS &&
    value.every((item) => {
      const candidate = record(item);
      if (!candidate) return false;
      const expected = [
        "id",
        "firstFrame",
        "lastFrame",
        "changeCount",
        "changeKinds",
        ...(Object.hasOwn(candidate, "removedAtFrame")
          ? ["removedAtFrame"]
          : []),
      ];
      return (
        exactKeys(candidate, expected) &&
        typeof candidate["id"] === "string" &&
        candidate["id"].length > 0 &&
        frameIndex(candidate["firstFrame"]) &&
        frameIndex(candidate["lastFrame"]) &&
        frameIndex(candidate["changeCount"]) &&
        (candidate["removedAtFrame"] === undefined ||
          frameIndex(candidate["removedAtFrame"])) &&
        stringArray(candidate["changeKinds"])
      );
    })
  );
}

function dependencyEndpoint(
  value: unknown,
): value is EvolutionDependencyEndpointIdentity {
  const candidate = record(value);
  if (
    candidate === undefined ||
    typeof candidate["key"] !== "string" ||
    candidate["key"].length === 0
  ) {
    return false;
  }
  try {
    if (candidate["kind"] === "entity") {
      return (
        exactKeys(candidate, [
          "kind",
          "entityKind",
          "id",
          "key",
        ]) &&
        (candidate["entityKind"] === "building" ||
          candidate["entityKind"] === "module") &&
        typeof candidate["id"] === "string" &&
        candidate["id"].length > 0 &&
        candidate["key"] ===
          evolutionDependencyEndpointKey({
            kind: "entity",
            entityKind: candidate["entityKind"],
            id: candidate["id"],
          })
      );
    }
    return (
      candidate["kind"] === "external" &&
      exactKeys(candidate, ["kind", "target", "key"]) &&
      typeof candidate["target"] === "string" &&
      candidate["target"].length > 0 &&
      candidate["target"] ===
        normalizeExternalDependencyTarget(candidate["target"]) &&
      candidate["key"] ===
        evolutionDependencyEndpointKey({
          kind: "external",
          target: candidate["target"],
        })
    );
  } catch {
    return false;
  }
}

function dependencyRoute(
  value: unknown,
): value is EvolutionDependencyRouteIdentity {
  const candidate = record(value);
  if (
    candidate === undefined ||
    !exactKeys(candidate, [
      "dependencyId",
      "routeKey",
      "source",
      "target",
    ]) ||
    typeof candidate["dependencyId"] !== "string" ||
    candidate["dependencyId"].length === 0 ||
    typeof candidate["routeKey"] !== "string" ||
    !dependencyEndpoint(candidate["source"]) ||
    candidate["source"].kind !== "entity" ||
    !dependencyEndpoint(candidate["target"])
  ) {
    return false;
  }
  return (
    candidate["routeKey"] ===
    evolutionDependencyRouteKey(
      candidate["source"],
      candidate["target"],
    )
  );
}

function dependencyRouteArray(
  value: unknown,
): value is readonly EvolutionDependencyRouteIdentity[] {
  return (
    Array.isArray(value) &&
    value.length <= MAXIMUM_DEPENDENCIES &&
    value.every(dependencyRoute)
  );
}

function ascendingDependencyIds(
  changes: readonly { readonly dependencyId: string }[],
): boolean {
  let previous: string | undefined;
  for (const change of changes) {
    if (
      previous !== undefined &&
      previous >= change.dependencyId
    ) {
      return false;
    }
    previous = change.dependencyId;
  }
  return true;
}

function dependencyChanges(value: unknown): boolean {
  const candidate = record(value);
  if (
    candidate === undefined ||
    !exactKeys(candidate, [
      "added",
      "removed",
      "changed",
      "retargeted",
      "affectedEndpoints",
      "affectedRouteKeys",
    ])
  ) {
    return false;
  }
  const added = candidate["added"];
  const removed = candidate["removed"];
  const changed = candidate["changed"];
  const retargeted = candidate["retargeted"];
  const affectedEndpoints = candidate["affectedEndpoints"];
  const affectedRouteKeys = candidate["affectedRouteKeys"];
  if (
    !dependencyRouteArray(added) ||
    !dependencyRouteArray(removed) ||
    !dependencyRouteArray(changed) ||
    !Array.isArray(retargeted) ||
    retargeted.length > MAXIMUM_DEPENDENCIES ||
    !retargeted.every((value) => {
      const retargeted = record(value);
      return (
        retargeted !== undefined &&
        exactKeys(retargeted, [
          "dependencyId",
          "before",
          "after",
        ]) &&
        typeof retargeted["dependencyId"] === "string" &&
        dependencyRoute(retargeted["before"]) &&
        dependencyRoute(retargeted["after"]) &&
        retargeted["before"].dependencyId ===
          retargeted["dependencyId"] &&
        retargeted["after"].dependencyId ===
          retargeted["dependencyId"] &&
        retargeted["before"].routeKey !==
          retargeted["after"].routeKey
      );
    }) ||
    !Array.isArray(affectedEndpoints) ||
    affectedEndpoints.length >
      MAXIMUM_AFFECTED_DEPENDENCY_ENDPOINTS ||
    !affectedEndpoints.every(dependencyEndpoint) ||
    !stringArray(
      affectedRouteKeys,
      MAXIMUM_AFFECTED_DEPENDENCY_ROUTES,
    )
  ) {
    return false;
  }

  const changeCount =
    added.length +
    removed.length +
    changed.length +
    retargeted.length;
  if (changeCount > MAXIMUM_AFFECTED_DEPENDENCY_ROUTES) {
    return false;
  }
  const dependencyIds = [
    ...added,
    ...removed,
    ...changed,
    ...retargeted,
  ].map((change) => change.dependencyId);
  const endpointKeys = affectedEndpoints.map(
    (endpoint) => endpoint.key,
  );
  const expectedEndpointKeys: string[] = [];
  const expectedRouteKeys: string[] = [];
  const expectedEndpointKeySet = new Set<string>();
  const expectedRouteKeySet = new Set<string>();
  const affect = (route: EvolutionDependencyRouteIdentity): void => {
    for (const endpoint of [route.source, route.target]) {
      if (!expectedEndpointKeySet.has(endpoint.key)) {
        expectedEndpointKeySet.add(endpoint.key);
        expectedEndpointKeys.push(endpoint.key);
      }
    }
    if (!expectedRouteKeySet.has(route.routeKey)) {
      expectedRouteKeySet.add(route.routeKey);
      expectedRouteKeys.push(route.routeKey);
    }
  };
  const orderedChanges = [
    ...added.map((change) => ({
      dependencyId: change.dependencyId,
      routes: [change] as const,
    })),
    ...removed.map((change) => ({
      dependencyId: change.dependencyId,
      routes: [change] as const,
    })),
    ...changed.map((change) => ({
      dependencyId: change.dependencyId,
      routes: [change] as const,
    })),
    ...retargeted.map((change) => ({
      dependencyId: change.dependencyId,
      routes: [change.before, change.after] as const,
    })),
  ].sort((left, right) =>
    left.dependencyId < right.dependencyId
      ? -1
      : left.dependencyId > right.dependencyId
        ? 1
        : 0,
  );
  orderedChanges.forEach(({ routes }) => routes.forEach(affect));
  return (
    ascendingDependencyIds(added) &&
    ascendingDependencyIds(removed) &&
    ascendingDependencyIds(changed) &&
    ascendingDependencyIds(retargeted) &&
    new Set(dependencyIds).size === dependencyIds.length &&
    new Set(endpointKeys).size === endpointKeys.length &&
    new Set(affectedRouteKeys).size === affectedRouteKeys.length &&
    expectedEndpointKeys.length === endpointKeys.length &&
    endpointKeys.every((key, index) => expectedEndpointKeys[index] === key) &&
    expectedRouteKeys.length === affectedRouteKeys.length &&
    affectedRouteKeys.every(
      (key, index) => expectedRouteKeys[index] === key,
    )
  );
}

function transition(value: unknown): boolean {
  const candidate = record(value);
  if (
    !candidate ||
    !exactKeys(candidate, [
      "fromIndex",
      "toIndex",
      "addedBuildingIds",
      "removedBuildings",
      "renamedBuildingIds",
      "resizedBuildingIds",
      "changedBuildingIds",
      "interpolatedBuildings",
      "dependencyChanges",
    ]) ||
    !frameIndex(candidate["fromIndex"]) ||
    !frameIndex(candidate["toIndex"]) ||
    !stringArray(candidate["addedBuildingIds"]) ||
    !stringArray(candidate["renamedBuildingIds"]) ||
    !stringArray(candidate["resizedBuildingIds"]) ||
    !stringArray(candidate["changedBuildingIds"]) ||
    !Array.isArray(candidate["interpolatedBuildings"]) ||
    candidate["interpolatedBuildings"].length > MAXIMUM_BUILDINGS ||
    !Array.isArray(candidate["removedBuildings"]) ||
    candidate["removedBuildings"].length > MAXIMUM_BUILDINGS ||
    !dependencyChanges(candidate["dependencyChanges"])
  ) {
    return false;
  }
  if (
    !candidate["interpolatedBuildings"].every((item) => {
      const building = record(item);
      return (
        building !== undefined &&
        exactKeys(building, ["id", "position", "size"]) &&
        typeof building["id"] === "string" &&
        record(building["position"]) !== undefined &&
        record(building["size"]) !== undefined
      );
    })
  ) {
    return false;
  }
  return candidate["removedBuildings"].every((item) => {
    const building = record(item);
    return (
      building !== undefined &&
      exactKeys(building, [
        "id",
        "name",
        "districtId",
        "position",
        "size",
      ]) &&
      typeof building["id"] === "string" &&
      typeof building["name"] === "string" &&
      typeof building["districtId"] === "string" &&
      record(building["position"]) !== undefined &&
      record(building["size"]) !== undefined
    );
  });
}

export function isEvolutionWorkerResponse(
  value: unknown,
): value is EvolutionWorkerResponse {
  const candidate = record(value);
  if (
    !candidate ||
    !requestId(candidate["requestId"]) ||
    typeof candidate["type"] !== "string"
  ) {
    return false;
  }
  if (candidate["type"] === "failure") {
    return (
      exactKeys(candidate, ["type", "requestId", "message"]) &&
      typeof candidate["message"] === "string" &&
      candidate["message"].length > 0 &&
      candidate["message"].length <= MAXIMUM_ERROR_CHARACTERS
    );
  }
  if (candidate["type"] === "loaded") {
    return (
      exactKeys(candidate, [
        "type",
        "requestId",
        "frames",
        "playbackStartIndex",
        "histories",
        "model",
        "analysis",
      ]) &&
      Array.isArray(candidate["frames"]) &&
      candidate["frames"].length > 0 &&
      candidate["frames"].length <= MAXIMUM_FRAMES &&
      candidate["frames"].every(frameSummary) &&
      Number.isSafeInteger(candidate["playbackStartIndex"]) &&
      Number(candidate["playbackStartIndex"]) >= 0 &&
      Number(candidate["playbackStartIndex"]) < candidate["frames"].length &&
      histories(candidate["histories"]) &&
      record(candidate["model"]) !== undefined &&
      analysis(candidate["analysis"])
    );
  }
  return (
    candidate["type"] === "frame" &&
    exactKeys(candidate, [
      "type",
      "requestId",
      "frame",
      "model",
      "analysis",
      "transition",
    ]) &&
    frameSummary(candidate["frame"]) &&
    record(candidate["model"]) !== undefined &&
    analysis(candidate["analysis"]) &&
    transition(candidate["transition"])
  );
}

export function evolutionWorkerFailureMessage(error: unknown): string {
  const message =
    error instanceof Error && error.message.trim().length > 0
      ? error.message.trim()
      : "The repository evolution could not be prepared.";
  return message.slice(0, MAXIMUM_ERROR_CHARACTERS);
}
