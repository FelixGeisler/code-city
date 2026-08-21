import { parseWorkerMessage, readGeneration, type WorkerCommand, type WorkerMessage } from "./protocol";
import type { FailureCode } from "./resolution";
import { parseRepositoryReference } from "../domain/repository-reference";

export type WorkerTransport = Readonly<{
  send(command: WorkerCommand): void;
  close(): void;
  listen(handlers: Readonly<{
    message(value: unknown): void;
    crash(): void;
    messageError(): void;
  }>): () => void;
}>;

export type VisibleFailureCode = FailureCode | "M1-PRES-1";

export type AttemptView = Readonly<{
  clear(): void;
  invalid(): void;
  working(cancel: () => void): void;
  success(revision: string): void;
  failure(category: string, code?: VisibleFailureCode, revision?: string): void;
  cancelled(): void;
}>;

export type ControllerPresentationResult =
  | Readonly<{ kind: "committed" }>
  | Readonly<{ kind: "stale" }>
  | Readonly<{ kind: "failure"; category: "City construction failed" | "Presentation failed"; code: "M1-CITY-1" | "M1-PRES-1" }>;

export type ControllerPresenter<G> = Readonly<{
  present(generation: G, model: unknown): ControllerPresentationResult;
  clear(): void;
  dispose(): void;
}>;

export type ControllerPresentationFactory<G> = (hooks: Readonly<{
  isEligible(generation: G): boolean;
  failed(generation: G, category: "City construction failed" | "Presentation failed", code: "M1-CITY-1" | "M1-PRES-1"): void;
}>) => ControllerPresenter<G>;

type ClosureMeaning = "cancelled" | "replacement" | "invalid" | "disposed";
type TerminalMeaning = "none" | "failure" | "success";

type ActiveBridge = {
  closed: boolean;
  closure?: ClosureMeaning;
  detach: () => void;
  generation: number;
  selectedRevision?: string;
  staticEntered: boolean;
  stopSent: boolean;
  terminal: TerminalMeaning;
  transport: WorkerTransport;
};

export type MainController = Readonly<{
  submit(value: string): boolean;
  cancel(): void;
  dispose(): void;
}>;

export function createMainController(
  createWorker: () => WorkerTransport,
  view: AttemptView,
  createPresentation: ControllerPresentationFactory<number>,
): MainController {
  let active: ActiveBridge | undefined;
  let disposed = false;
  let generation = 0;
  let pending: ReturnType<typeof parseRepositoryReference>;
  let published: Readonly<{ generation: number; revision: string }> | undefined;

  const presenter = createPresentation({
    isEligible(candidate) {
      return !disposed && candidate === published?.generation;
    },
    failed(candidate, category, code) {
      const publication = published;
      if (disposed || candidate !== publication?.generation) {
        return;
      }
      published = undefined;
      const bridge = active?.generation === candidate ? active : undefined;
      if (bridge) {
        bridge.terminal = "failure";
      }
      view.failure(category, code, publication.revision);
    },
  });

  function clearPublishedState(): void {
    published = undefined;
    presenter.clear();
    view.clear();
  }

  function startPending(): void {
    if (disposed || active || !pending) {
      return;
    }
    const repository = pending;
    pending = undefined;
    start(repository);
  }

  function cleanup(bridge: ActiveBridge): void {
    if (bridge.closed) {
      return;
    }
    bridge.closed = true;
    try {
      bridge.detach();
    } catch {}
    try {
      bridge.transport.close();
    } catch {}
    if (active === bridge) {
      active = undefined;
      startPending();
    }
  }

  function showFailure(
    bridge: ActiveBridge,
    category = "Provider/resolution failure",
    code?: VisibleFailureCode,
  ): void {
    if (bridge.closure || bridge.terminal === "failure") {
      return;
    }
    bridge.terminal = "failure";
    if (published?.generation === bridge.generation) {
      published = undefined;
      presenter.clear();
    }
    view.failure(category, code, bridge.selectedRevision);
  }

  function drainImpossible(bridge: ActiveBridge): void {
    if (!bridge.closure) {
      if (bridge.terminal === "success") {
        bridge.terminal = "none";
      }
      showFailure(bridge);
    }
    cleanup(bridge);
  }

  function stopProvider(bridge: ActiveBridge): void {
    if (bridge.stopSent) {
      return;
    }
    bridge.stopSent = true;
    try {
      bridge.transport.send({ type: "STOP", generation: bridge.generation });
    } catch {
      cleanup(bridge);
    }
  }

  function closeWithMeaning(bridge: ActiveBridge, meaning: ClosureMeaning): void {
    bridge.closure = meaning;
    if (bridge.staticEntered) {
      cleanup(bridge);
    } else {
      stopProvider(bridge);
    }
  }

  function cancel(): void {
    if (disposed) {
      return;
    }
    const bridge = active;
    if (!bridge || bridge.closed || (bridge.closure === "cancelled" && !pending)) {
      return;
    }
    pending = undefined;
    clearPublishedState();
    bridge.closure = "cancelled";
    view.cancelled();
    if (bridge.staticEntered) {
      cleanup(bridge);
    } else {
      stopProvider(bridge);
    }
  }

  function messageFailureMatchesSelection(bridge: ActiveBridge, message: Extract<WorkerMessage, { type: "FAILURE" }>): boolean {
    if (bridge.selectedRevision === undefined) {
      return !("revision" in message);
    }
    return "revision" in message && message.revision === bridge.selectedRevision;
  }

  function handleMessage(bridge: ActiveBridge, value: unknown): void {
    if (bridge.closed || disposed) {
      return;
    }
    const messageGeneration = readGeneration(value);
    if (messageGeneration !== undefined && messageGeneration !== bridge.generation) {
      return;
    }
    const message = parseWorkerMessage(value, bridge.generation);
    if (!message) {
      drainImpossible(bridge);
      return;
    }

    if (message.type === "ATTEMPT_DRAINED") {
      if (bridge.closure || bridge.terminal === "failure" || bridge.terminal === "success") {
        cleanup(bridge);
      } else {
        drainImpossible(bridge);
      }
      return;
    }

    if (bridge.terminal !== "none") {
      drainImpossible(bridge);
      return;
    }

    if (message.type === "REVISION_SELECTED") {
      if (bridge.selectedRevision !== undefined || bridge.staticEntered) {
        drainImpossible(bridge);
        return;
      }
      bridge.selectedRevision = message.revision;
      return;
    }

    if (message.type === "FAILURE") {
      if (!messageFailureMatchesSelection(bridge, message)) {
        drainImpossible(bridge);
        return;
      }
      if (bridge.closure) {
        bridge.terminal = "failure";
      } else {
        showFailure(bridge, message.category, "code" in message ? message.code : undefined);
      }
      return;
    }

    if (message.type === "PROVIDER_DRAINED_STATIC_ENTERED") {
      if (bridge.selectedRevision === undefined || bridge.staticEntered) {
        drainImpossible(bridge);
        return;
      }
      bridge.staticEntered = true;
      if (bridge.closure) {
        cleanup(bridge);
      }
      return;
    }

    if (bridge.closure
      || bridge.selectedRevision === undefined
      || !bridge.staticEntered
      || message.revision !== bridge.selectedRevision) {
      drainImpossible(bridge);
      return;
    }

    published = { generation: bridge.generation, revision: bridge.selectedRevision };
    const result = presenter.present(bridge.generation, message.model);
    if (result.kind === "stale") {
      if (published?.generation === bridge.generation) {
        published = undefined;
      }
      cleanup(bridge);
      return;
    }
    if (result.kind === "failure") {
      published = undefined;
      showFailure(bridge, result.category, result.code);
      return;
    }
    try {
      view.success(message.revision);
      bridge.terminal = "success";
    } catch {
      drainImpossible(bridge);
    }
  }

  function start(repository: NonNullable<ReturnType<typeof parseRepositoryReference>>): boolean {
    if (disposed) {
      return false;
    }
    const nextGeneration = generation + 1;
    let transport: WorkerTransport;
    try {
      transport = createWorker();
    } catch {
      view.failure("Provider/resolution failure");
      return false;
    }

    const bridge: ActiveBridge = {
      closed: false,
      detach: () => {},
      generation: nextGeneration,
      staticEntered: false,
      stopSent: false,
      terminal: "none",
      transport,
    };
    active = bridge;
    try {
      const detach = transport.listen({
        message: (value) => handleMessage(bridge, value),
        crash: () => drainImpossible(bridge),
        messageError: () => drainImpossible(bridge),
      });
      if (typeof detach !== "function") {
        throw new Error("Worker listener setup did not return cleanup");
      }
      bridge.detach = detach;
    } catch {
      showFailure(bridge);
      cleanup(bridge);
      return false;
    }

    view.working(cancel);
    try {
      transport.send({ type: "START", generation: nextGeneration, repository });
    } catch {
      drainImpossible(bridge);
      return false;
    }
    generation = nextGeneration;
    return true;
  }

  function submit(value: string): boolean {
    if (disposed) {
      return false;
    }
    const repository = parseRepositoryReference(value);
    clearPublishedState();
    const bridge = active;
    if (!repository) {
      pending = undefined;
      if (bridge) {
        closeWithMeaning(bridge, "invalid");
      }
      view.invalid();
      return false;
    }

    if (!bridge) {
      return start(repository);
    }

    pending = repository;
    closeWithMeaning(bridge, "replacement");
    return true;
  }

  function dispose(): void {
    if (disposed) {
      return;
    }
    disposed = true;
    pending = undefined;
    published = undefined;
    view.clear();
    presenter.dispose();
    const bridge = active;
    if (bridge) {
      bridge.closure = "disposed";
      cleanup(bridge);
    }
  }

  return { submit, cancel, dispose };
}
