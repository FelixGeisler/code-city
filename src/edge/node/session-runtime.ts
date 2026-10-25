import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ValidatedCity } from "../../application/city-payload";
import type { FailedFile } from "../../application/source-retrieval";
import { parseRepositoryReference } from "../../domain/repository-reference";
import { isCanonicalAdditionalExclusions, parseAdditionalExclusions, MAX_NORMALIZED_TOTAL_BYTES } from "../../domain/source-admission";
import type { StandaloneConfiguration } from "./config";
import {
  startInactiveHttpPerimeter,
  type FixedHandlerResult,
  type FixedRouteHandlers,
} from "./http-perimeter";
import { startNodeWorkerAttempt, type NodeWorkerAttempt } from "./worker-attempt";
import type { NodeWorkerFailure, ValidatedNodeWorkerSuccess } from "./worker-protocol";

const SESSION_MEDIA_TYPE = "application/x-ndjson; charset=utf-8";

type EmptyResult = Extract<FixedHandlerResult, { kind: "empty" }>;
type StreamResult = Extract<FixedHandlerResult, { kind: "stream" }>;
type DataRecord = Record<string, unknown>;

type RetainedCurrent = Readonly<{
  generation: number;
  sourceBytes: number;
  result: ValidatedNodeWorkerSuccess;
}>;

type ActiveAttempt = {
  readonly generation: number;
  readonly attempt: NodeWorkerAttempt;
  eligible: boolean;
  sourceReleased: boolean;
  completion: Promise<void>;
};

type SessionState = {
  readonly id: string;
  latestGeneration: number;
  active?: ActiveAttempt;
  current?: RetainedCurrent;
  joining: boolean;
  mutation?: Promise<void>;
  lost: boolean;
  released: boolean;
  blockedFrame?: string;
  response?: ServerResponse;
  closingResponse: boolean;
  lossPromise?: Promise<void>;
};

export interface InactiveSessionRuntimeInput {
  readonly configuration: StandaloneConfiguration;
  readonly fixtureManifestBytes: Uint8Array;
  readonly artifactRoot: string;
}

export interface RunningInactiveSessionRuntime {
  readonly origin: string;
  readonly close: () => Promise<void>;
}

function empty(status: number, close = false): EmptyResult {
  return close ? { kind: "empty", status, close: true } : { kind: "empty", status };
}

function exactRecord(value: unknown, keys: readonly string[]): DataRecord | undefined {
  if (typeof value !== "object" || value === null || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(descriptors);
  if (ownKeys.some((key) => typeof key !== "string") || ownKeys.length !== keys.length
    || keys.some((key) => !Object.hasOwn(descriptors, key))) return undefined;
  const record: DataRecord = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return undefined;
    record[key] = descriptor.value;
  }
  return record;
}

function validGeneration(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validSessionId(value: unknown): value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(value)) return false;
  try {
    const bytes = Buffer.from(value, "base64url");
    return bytes.byteLength === 32 && bytes.toString("base64url") === value;
  } catch {
    return false;
  }
}

function analyzeShape(value: unknown): Readonly<{
  sessionId: string;
  generation: number;
  repositoryUrl: string;
  additionalExclusions: string;
}> | undefined {
  const record = exactRecord(value, ["sessionId", "generation", "repositoryUrl", "additionalExclusions"]);
  return record && validSessionId(record.sessionId) && validGeneration(record.generation)
    && typeof record.repositoryUrl === "string" && typeof record.additionalExclusions === "string"
    ? {
        sessionId: record.sessionId,
        generation: record.generation,
        repositoryUrl: record.repositoryUrl,
        additionalExclusions: record.additionalExclusions,
      }
    : undefined;
}

function controlShape(value: unknown): Readonly<{ sessionId: string; generation: number }> | undefined {
  const record = exactRecord(value, ["sessionId", "generation"]);
  return record && validSessionId(record.sessionId) && validGeneration(record.generation)
    ? { sessionId: record.sessionId, generation: record.generation }
    : undefined;
}

function sourceBytes(result: ValidatedNodeWorkerSuccess): number {
  let total = 0;
  for (const source of result.sources) {
    total += source.normalizedUtf8.byteLength;
    if (!Number.isSafeInteger(total) || total > MAX_NORMALIZED_TOTAL_BYTES) throw new Error("Validated source total is invalid");
  }
  return total;
}

function plainFailures(rows: readonly FailedFile[]): readonly Readonly<{ canonicalPath: string; category: FailedFile["category"] }>[] {
  return rows.map(({ canonicalPath, category }) => ({ canonicalPath, category }));
}

function plainCity(city: ValidatedCity): Readonly<Record<string, unknown>> {
  return {
    geometry: {
      kind: city.geometry.kind,
      count: city.geometry.count,
      origins: Array.from(city.geometry.origins),
      sizes: Array.from(city.geometry.sizes),
      rgba: Array.from(city.geometry.rgba),
      bounds: Array.from(city.geometry.bounds),
    },
    inspection: city.inspection.map(({ canonicalPath, S, U, M }) => ({ canonicalPath, S, U, M })),
    presentation: {
      plates: city.presentation.plates.map(({ minimum, dimensions }) => ({ minimum: [...minimum], dimensions: [...dimensions] })),
      sceneBounds: [...city.presentation.sceneBounds],
      centre: [...city.presentation.centre],
    },
    districts: city.districts.map(({ root, identity }) => ({ root, identity })),
  };
}

function failureEvent(session: SessionState, failure: NodeWorkerFailure): Readonly<Record<string, unknown>> {
  return {
    type: "ANALYSIS_FAILED",
    sessionId: session.id,
    generation: failure.generation,
    ...("revision" in failure ? { revision: failure.revision } : {}),
    category: failure.category,
    ...("code" in failure ? { code: failure.code } : {}),
  };
}

export async function startInactiveSessionRuntime(input: InactiveSessionRuntimeInput): Promise<RunningInactiveSessionRuntime> {
  const { configuration } = input;
  const sessions = new Map<string, SessionState>();
  const ownedSessions = new Set<SessionState>();
  const ownedSessionIds = new Set<string>();
  let liveSessions = 0;
  let activeAttempts = 0;
  let retainedSourceBytes = 0;
  let accepting = true;
  let closePromise: Promise<void> | undefined;

  const releaseSource = (active: ActiveAttempt): void => {
    if (active.sourceReleased) return;
    active.sourceReleased = true;
    retainedSourceBytes -= MAX_NORMALIZED_TOTAL_BYTES;
  };

  const discardCurrent = (session: SessionState): boolean => {
    const current = session.current;
    if (!current) return false;
    session.current = undefined;
    retainedSourceBytes -= current.sourceBytes;
    return true;
  };

  const releaseSession = (session: SessionState): void => {
    if (session.released) return;
    session.released = true;
    sessions.delete(session.id);
    ownedSessions.delete(session);
    ownedSessionIds.delete(session.id);
    liveSessions -= 1;
  };

  const endResponse = (session: SessionState): void => {
    const response = session.response;
    if (!response || response.destroyed || response.writableEnded) return;
    session.closingResponse = true;
    try { response.end(); }
    catch { response.destroy(); }
  };

  const cleanupActive = async (session: SessionState): Promise<boolean> => {
    const active = session.active;
    if (!active) return false;
    active.eligible = false;
    await active.attempt.cancel();
    await active.completion;
    if (session.active === active) session.active = undefined;
    releaseSource(active);
    return true;
  };

  const cleanupState = async (session: SessionState): Promise<boolean> => {
    const hadActive = await cleanupActive(session);
    const hadCurrent = discardCurrent(session);
    return hadActive || hadCurrent;
  };

  const ownMutation = (session: SessionState): (() => void) => {
    let resolveMutation!: () => void;
    const mutation = new Promise<void>((resolve) => { resolveMutation = resolve; });
    session.joining = true;
    session.mutation = mutation;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (session.mutation === mutation) {
        session.mutation = undefined;
        session.joining = false;
      }
      resolveMutation();
    };
  };

  const eligibleAfterAwait = (session: SessionState): boolean => accepting
    && !session.lost && !session.released && sessions.get(session.id) === session;

  const beginLoss = (session: SessionState): Promise<void> => {
    if (session.lossPromise) return session.lossPromise;
    session.lost = true;
    if (session.active) session.active.eligible = false;
    sessions.delete(session.id);
    const mutation = session.mutation;
    session.lossPromise = (async () => {
      if (mutation) await mutation;
      session.joining = true;
      await cleanupState(session);
      session.blockedFrame = undefined;
      endResponse(session);
      releaseSession(session);
      session.joining = false;
    })();
    return session.lossPromise;
  };

  const writeFrame = (session: SessionState, event: Readonly<Record<string, unknown>>): boolean => {
    if (session.lost || session.released) return false;
    if (session.blockedFrame !== undefined) {
      void beginLoss(session);
      return false;
    }
    const response = session.response;
    if (!response || response.destroyed || response.writableEnded) {
      void beginLoss(session);
      return false;
    }
    try {
      const frame = `${JSON.stringify(event)}\n`;
      if (!response.write(frame)) {
        session.blockedFrame = frame;
        response.once("drain", () => {
          if (session.blockedFrame === frame) session.blockedFrame = undefined;
        });
      }
      return true;
    } catch {
      void beginLoss(session);
      return false;
    }
  };

  const commandConflict = (session: SessionState): EmptyResult | undefined => {
    if (session.blockedFrame !== undefined) {
      void beginLoss(session);
      return empty(409);
    }
    if (session.joining) return empty(409);
    return undefined;
  };

  const completeAttempt = async (session: SessionState, active: ActiveAttempt): Promise<void> => {
    const result = await active.attempt.result;
    if (!active.eligible || session.active !== active || session.lost) return;
    session.active = undefined;
    active.eligible = false;
    if (result.type === "CANCELLED") {
      releaseSource(active);
      return;
    }
    if (result.type === "FAILURE") {
      releaseSource(active);
      writeFrame(session, failureEvent(session, result));
      return;
    }

    let exactSourceBytes: number;
    try { exactSourceBytes = sourceBytes(result); }
    catch {
      releaseSource(active);
      writeFrame(session, {
        type: "ANALYSIS_FAILED", sessionId: session.id, generation: active.generation,
        revision: result.revision, category: "Provider/resolution failure",
      });
      return;
    }
    active.sourceReleased = true;
    retainedSourceBytes -= MAX_NORMALIZED_TOTAL_BYTES - exactSourceBytes;
    session.current = { generation: active.generation, sourceBytes: exactSourceBytes, result };
    const failures = plainFailures(result.result.notAnalyzedFiles);
    if (result.result.city === null) {
      writeFrame(session, {
        type: "ANALYSIS_ALL_FILES_FAILED", sessionId: session.id, generation: active.generation,
        revision: result.revision, notAnalyzedFiles: failures,
      });
      return;
    }
    writeFrame(session, {
      type: "ANALYSIS_SUCCEEDED", sessionId: session.id, generation: active.generation,
      revision: result.revision, city: plainCity(result.result.city), notAnalyzedFiles: failures,
    });
  };

  const sessionHandler = (): StreamResult | EmptyResult => {
    if (!accepting || liveSessions >= configuration.maxLiveSessions) return empty(503, true);
    let id: string;
    do { id = randomBytes(32).toString("base64url"); } while (ownedSessionIds.has(id));
    const session: SessionState = {
      id, latestGeneration: 0, joining: false, lost: false, released: false, closingResponse: false,
    };
    sessions.set(id, session);
    ownedSessions.add(session);
    ownedSessionIds.add(id);
    liveSessions += 1;
    return {
      kind: "stream",
      status: 200,
      contentType: SESSION_MEDIA_TYPE,
      open(request, response) {
        session.response = response;
        const lost = (): void => { if (!session.closingResponse) void beginLoss(session); };
        request.once("aborted", lost);
        response.once("close", lost);
        response.once("error", lost);
        request.socket.once("close", lost);
        if (request.socket.destroyed || response.destroyed) void beginLoss(session);
        else writeFrame(session, { type: "SESSION_OPENED", sessionId: id });
      },
    };
  };

  const analyzeHandler = async (value: unknown): Promise<EmptyResult> => {
    const command = analyzeShape(value);
    if (!command) return empty(400);
    const session = sessions.get(command.sessionId);
    if (!session || session.lost) return empty(404);
    const conflict = commandConflict(session);
    if (conflict) return conflict;
    if (command.generation <= session.latestGeneration) return empty(409);

    const repository = parseRepositoryReference(command.repositoryUrl);
    const additionalExclusions = parseAdditionalExclusions(command.additionalExclusions);
    const releaseMutation = ownMutation(session);
    try {
      session.latestGeneration = command.generation;
      await cleanupActive(session);
      discardCurrent(session);
      if (!eligibleAfterAwait(session)) return empty(404);
      if (!repository || !additionalExclusions || !isCanonicalAdditionalExclusions(additionalExclusions)) return empty(422);
      if (activeAttempts >= configuration.maxActiveAttempts
        || retainedSourceBytes > configuration.maxRetainedSourceBytes - MAX_NORMALIZED_TOTAL_BYTES) return empty(503);

      activeAttempts += 1;
      retainedSourceBytes += MAX_NORMALIZED_TOTAL_BYTES;
      let attemptReleased = false;
      let active!: ActiveAttempt;
      const pendingRevisions: string[] = [];
      let attempt: NodeWorkerAttempt;
      try {
        attempt = startNodeWorkerAttempt({
          repository,
          generation: command.generation,
          additionalExclusions,
          release() {
            if (attemptReleased) return;
            attemptReleased = true;
            activeAttempts -= 1;
          },
          onRevisionSelected(revision) {
            if (!active) { pendingRevisions.push(revision); return; }
            if (active.eligible && session.active === active && eligibleAfterAwait(session)) {
              writeFrame(session, { type: "REVISION_SELECTED", sessionId: session.id, generation: active.generation, revision });
            }
          },
        });
      } catch {
        activeAttempts -= 1;
        retainedSourceBytes -= MAX_NORMALIZED_TOTAL_BYTES;
        queueMicrotask(() => writeFrame(session, {
          type: "ANALYSIS_FAILED", sessionId: session.id, generation: command.generation,
          category: "Provider/resolution failure",
        }));
        return empty(202);
      }
      active = {
        generation: command.generation,
        attempt,
        eligible: true,
        sourceReleased: false,
        completion: Promise.resolve(),
      };
      session.active = active;
      for (const revision of pendingRevisions) {
        if (!active.eligible || session.active !== active || !eligibleAfterAwait(session)) break;
        writeFrame(session, { type: "REVISION_SELECTED", sessionId: session.id, generation: active.generation, revision });
      }
      active.completion = completeAttempt(session, active);
      return empty(202);
    } finally {
      releaseMutation();
    }
  };

  const cancelHandler = async (value: unknown): Promise<EmptyResult> => {
    const command = controlShape(value);
    if (!command) return empty(400);
    const session = sessions.get(command.sessionId);
    if (!session || session.lost) return empty(404);
    const conflict = commandConflict(session);
    if (conflict) return conflict;
    if (command.generation !== session.latestGeneration) return empty(409);
    if (!session.active) return empty(204);
    const releaseMutation = ownMutation(session);
    try {
      await cleanupActive(session);
      if (!eligibleAfterAwait(session)) return empty(404);
      writeFrame(session, { type: "ANALYSIS_CANCELLED", sessionId: session.id, generation: command.generation });
      return empty(204);
    } finally {
      releaseMutation();
    }
  };

  const discardHandler = async (value: unknown): Promise<EmptyResult> => {
    const command = controlShape(value);
    if (!command) return empty(400);
    const session = sessions.get(command.sessionId);
    if (!session || session.lost) return empty(404);
    const conflict = commandConflict(session);
    if (conflict) return conflict;
    if (command.generation !== session.latestGeneration) return empty(409);
    const hadState = session.active !== undefined || session.current !== undefined;
    if (!hadState) return empty(204);
    const releaseMutation = ownMutation(session);
    try {
      await cleanupActive(session);
      discardCurrent(session);
      if (!eligibleAfterAwait(session)) return empty(404);
      writeFrame(session, { type: "CURRENT_DISCARDED", sessionId: session.id, generation: command.generation });
      return empty(204);
    } finally {
      releaseMutation();
    }
  };

  const handlers: FixedRouteHandlers = Object.freeze({
    "/_code-city/session": sessionHandler,
    "/_code-city/analyze": analyzeHandler,
    "/_code-city/cancel": cancelHandler,
    "/_code-city/discard": discardHandler,
  });
  const perimeter = await startInactiveHttpPerimeter({ ...input, handlers });

  return Object.freeze({
    origin: perimeter.origin,
    close(): Promise<void> {
      closePromise ??= (async () => {
        accepting = false;
        const listenerClosed = perimeter.close();
        await Promise.all([...ownedSessions].map((session) => beginLoss(session)));
        perimeter.closeIdleConnections();
        await listenerClosed;
        if (liveSessions !== 0 || activeAttempts !== 0 || retainedSourceBytes !== 0) {
          throw new Error("Standalone runtime shutdown did not release all ownership");
        }
      })();
      return closePromise;
    },
  });
}

export function installInactiveSessionShutdownSignals(runtime: RunningInactiveSessionRuntime): () => void {
  let entered = false;
  const shutdown = (): void => {
    if (entered) return;
    entered = true;
    void runtime.close().then(
      () => { process.exitCode = 0; },
      () => { process.exitCode = 1; },
    );
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return () => {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
  };
}
