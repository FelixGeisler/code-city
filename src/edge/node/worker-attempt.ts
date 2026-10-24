import { randomBytes } from "node:crypto";
import { Worker } from "node:worker_threads";
import type { RepositoryReference } from "../../domain/repository-reference";
import {
  parseNodeWorkerCommand,
  validateNodeWorkerEvent,
  type NodeWorkerCommand,
  type NodeWorkerFailure,
  type ValidatedNodeWorkerEvent,
  type ValidatedNodeWorkerSuccess,
} from "./worker-protocol";

export type JoinedNodeWorkerTerminal = NodeWorkerFailure | ValidatedNodeWorkerSuccess;
export type JoinedNodeWorkerResult = JoinedNodeWorkerTerminal | Readonly<{ type: "CANCELLED" }>;

type WorkerLike = Pick<Worker, "on" | "postMessage" | "terminate">;
export type NodeWorkerFactory = (url: URL) => WorkerLike;

export type NodeWorkerAttempt = Readonly<{
  attemptId: string;
  generation: number;
  result: Promise<JoinedNodeWorkerResult>;
  cancel(): Promise<void>;
}>;

export type StartNodeWorkerAttemptOptions = Readonly<{
  repository: RepositoryReference;
  generation: number;
  additionalExclusions?: readonly string[];
  workerUrl?: URL;
  workerFactory?: NodeWorkerFactory;
  release?: () => void;
}>;

function providerFailure(attemptId: string, generation: number, revision?: string): NodeWorkerFailure {
  return revision === undefined
    ? { type: "FAILURE", attemptId, generation, category: "Provider/resolution failure" }
    : { type: "FAILURE", attemptId, generation, revision, category: "Provider/resolution failure" };
}

export function startNodeWorkerAttempt(options: StartNodeWorkerAttemptOptions): NodeWorkerAttempt {
  const attemptId = randomBytes(16).toString("base64url");
  const generation = options.generation;
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    options.release?.();
  };
  let resolveResult!: (result: JoinedNodeWorkerResult) => void;
  const result = new Promise<JoinedNodeWorkerResult>((resolve) => { resolveResult = resolve; });
  let worker: WorkerLike | undefined;
  let selectedRevision: string | undefined;
  let provisional: JoinedNodeWorkerTerminal | undefined;
  let invalid = false;
  let cancelled = false;
  let joined = false;
  let cancelJoin: Promise<void> | undefined;

  const invalidate = (): void => {
    if (joined || invalid) return;
    invalid = true;
    try { void worker?.terminate(); } catch { /* exit remains the join boundary */ }
  };

  const finishWithoutWorker = (): void => {
    release();
    resolveResult(providerFailure(attemptId, generation));
  };

  const startCommand: NodeWorkerCommand = {
    type: "START", attemptId, generation, repository: options.repository,
    additionalExclusions: Object.freeze([...(options.additionalExclusions ?? [])]),
  };
  if (!parseNodeWorkerCommand(startCommand)) {
    finishWithoutWorker();
    return { attemptId, generation, result, async cancel() {} };
  }

  try {
    worker = (options.workerFactory ?? ((url) => new Worker(url)))(
      options.workerUrl ?? new URL("./analysis-worker-entry.js", import.meta.url),
    );
  } catch {
    finishWithoutWorker();
    return { attemptId, generation, result, async cancel() {} };
  }

  const onExit = (code: number): void => {
    if (joined) return;
    joined = true;
    release();
    if (cancelled) resolveResult({ type: "CANCELLED" });
    else if (code !== 0 || invalid || !provisional) resolveResult(providerFailure(attemptId, generation, selectedRevision));
    else resolveResult(provisional);
  };

  const onMessage = (value: unknown): void => {
    if (joined || cancelled || invalid || provisional) { invalidate(); return; }
    const parsed = validateNodeWorkerEvent(value);
    if (parsed.kind !== "valid") {
      if (parsed.mapping === "city" && parsed.attemptId === attemptId && parsed.generation === generation
        && parsed.revision !== undefined && parsed.revision === selectedRevision) {
        provisional = {
          type: "FAILURE", attemptId, generation, revision: parsed.revision,
          category: "City construction failed", code: "M1-CITY-1",
        };
        return;
      }
      invalidate();
      return;
    }
    const event: ValidatedNodeWorkerEvent = parsed.event;
    if (event.attemptId !== attemptId || event.generation !== generation) { invalidate(); return; }
    if (event.type === "REVISION_SELECTED") {
      if (selectedRevision !== undefined) { invalidate(); return; }
      selectedRevision = event.revision;
      return;
    }
    if ("revision" in event) {
      if (selectedRevision === undefined || event.revision !== selectedRevision) { invalidate(); return; }
    } else if (selectedRevision !== undefined) { invalidate(); return; }
    provisional = event;
  };

  try {
    worker.on("exit", onExit);
    worker.on("message", onMessage);
    worker.on("messageerror", invalidate);
    worker.on("error", invalidate);
    worker.postMessage(startCommand);
  } catch {
    invalidate();
  }

  const cancel = (): Promise<void> => {
    if (cancelJoin) return cancelJoin;
    cancelJoin = (async () => {
      if (joined) return;
      cancelled = true;
      const stop: NodeWorkerCommand = { type: "STOP", attemptId, generation };
      try { worker?.postMessage(stop); } catch { /* termination still owns release */ }
      try { await worker?.terminate(); } catch { /* the registered exit event remains authoritative */ }
      await result;
    })();
    return cancelJoin;
  };

  return { attemptId, generation, result, cancel };
}
