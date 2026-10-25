import { randomBytes } from "node:crypto";
import { Worker } from "node:worker_threads";
import type { RepositoryReference } from "../../domain/repository-reference";
import {
  parseNodeWorkerCommand,
  validateNodeWorkerEvent,
  validateNodeWorkerStructuredCloneEvent,
  type NodeWorkerCommand,
  type NodeWorkerFailure,
  type ValidatedNodeWorkerEvent,
  type ValidatedNodeWorkerSuccess,
} from "./worker-protocol";

export type JoinedNodeWorkerTerminal = NodeWorkerFailure | ValidatedNodeWorkerSuccess;
export type JoinedNodeWorkerResult = JoinedNodeWorkerTerminal | Readonly<{ type: "CANCELLED" }>;

type WorkerLike = Pick<Worker, "on" | "off" | "postMessage" | "terminate">;
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
  onRevisionSelected?: (revision: string) => void;
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
  let structuredCloneMessages = false;
  let selectedRevision: string | undefined;
  let provisional: JoinedNodeWorkerTerminal | undefined;
  let invalid = false;
  let cancelled = false;
  let joined = false;
  let exitListenerRegistered = false;
  let cancelJoin: Promise<void> | undefined;

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
    structuredCloneMessages = worker instanceof Worker;
  } catch {
    finishWithoutWorker();
    return { attemptId, generation, result, async cancel() {} };
  }

  function cleanupListeners(): void {
    const current = worker;
    if (!current) return;
    try { current.off("exit", onExit); } catch { /* cleanup is best-effort after the join */ }
    try { current.off("message", onMessage); } catch { /* cleanup is best-effort after the join */ }
    try { current.off("messageerror", onMessageError); } catch { /* cleanup is best-effort after the join */ }
    try { current.off("error", onError); } catch { /* cleanup is best-effort after the join */ }
  }

  function onExit(code: number): void {
    if (joined) return;
    joined = true;
    const terminal = provisional;
    provisional = undefined;
    const completion: JoinedNodeWorkerResult = cancelled
      ? { type: "CANCELLED" }
      : code !== 0 || invalid || !terminal
        ? providerFailure(attemptId, generation, selectedRevision)
        : terminal;
    selectedRevision = undefined;
    cleanupListeners();
    worker = undefined;
    release();
    resolveResult(completion);
  }

  function terminateInvalid(): void {
    if (joined || invalid) return;
    invalid = true;
    provisional = undefined;
    const current = worker;
    if (!current) { onExit(1); return; }
    try {
      const termination = current.terminate();
      if (!exitListenerRegistered) {
        void termination.then(onExit, () => onExit(1));
      }
    } catch {
      if (!exitListenerRegistered) onExit(1);
    }
  }

  function onMessage(value: unknown): void {
    if (joined || cancelled || invalid || provisional) { terminateInvalid(); return; }
    const parsed = structuredCloneMessages
      ? validateNodeWorkerStructuredCloneEvent(value)
      : validateNodeWorkerEvent(value);
    if (parsed.kind !== "valid") {
      if (parsed.mapping === "city" && parsed.attemptId === attemptId && parsed.generation === generation
        && parsed.revision !== undefined && parsed.revision === selectedRevision) {
        provisional = {
          type: "FAILURE", attemptId, generation, revision: parsed.revision,
          category: "City construction failed", code: "M1-CITY-1",
        };
        return;
      }
      terminateInvalid();
      return;
    }
    const event: ValidatedNodeWorkerEvent = parsed.event;
    if (event.attemptId !== attemptId || event.generation !== generation) { terminateInvalid(); return; }
    if (event.type === "REVISION_SELECTED") {
      if (selectedRevision !== undefined) { terminateInvalid(); return; }
      selectedRevision = event.revision;
      try { options.onRevisionSelected?.(event.revision); }
      catch { terminateInvalid(); }
      return;
    }
    if ("revision" in event) {
      if (selectedRevision === undefined || event.revision !== selectedRevision) { terminateInvalid(); return; }
    } else if (selectedRevision !== undefined) { terminateInvalid(); return; }
    provisional = event;
  }

  function onMessageError(): void { terminateInvalid(); }
  function onError(): void { terminateInvalid(); }

  try {
    worker.on("exit", onExit);
    exitListenerRegistered = true;
    worker.on("message", onMessage);
    worker.on("messageerror", onMessageError);
    worker.on("error", onError);
    worker.postMessage(startCommand);
  } catch {
    terminateInvalid();
  }

  const cancel = (): Promise<void> => {
    if (cancelJoin) return cancelJoin;
    cancelJoin = (async () => {
      if (joined) return;
      cancelled = true;
      provisional = undefined;
      const stop: NodeWorkerCommand = { type: "STOP", attemptId, generation };
      try { worker?.postMessage(stop); } catch { /* termination still owns release */ }
      try { await worker?.terminate(); } catch { /* the registered exit event remains authoritative */ }
      await result;
    })();
    return cancelJoin;
  };

  return { attemptId, generation, result, cancel };
}
