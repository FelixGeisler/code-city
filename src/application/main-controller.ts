import { parseWorkerMessage, readGeneration, type ParsedWorkerMessage, type WorkerCommand } from "./protocol";
import type { InspectionFact, ValidatedCity, ValidatedGeometry } from "./city-payload";
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
export type SelectionAction = "next" | "previous" | "first" | "last" | "clear";

export type ControllerCanvas = Readonly<{ remove(): void }>;
export type ControllerPublication = Readonly<{
  commit(canvas: ControllerCanvas): void;
  setSelection(index: number | null): void;
  rollback(): void;
}>;

export type AttemptView = Readonly<{
  clear(): void;
  invalid(): void;
  working(cancel: () => void): void;
  success(revision: string): void;
  failure(category: string, code?: VisibleFailureCode, revision?: string): void;
  cancelled(): void;
  stagePublication(revision: string, inspection: readonly InspectionFact[]): ControllerPublication;
}>;

export type ControllerPresentationFailure = Readonly<{
  kind: "failure";
  category: "Presentation failed";
  code: "M1-PRES-1";
}>;
export type ControllerPresenterStageResult<T, C extends ControllerCanvas> =
  | Readonly<{ kind: "staged"; token: T; canvas: C }>
  | Readonly<{ kind: "stale" }>
  | ControllerPresentationFailure;
export type ControllerCommitResult = Readonly<{ kind: "committed" }> | Readonly<{ kind: "stale" }>;
export type ControllerVisualResult = Readonly<{ kind: "applied" }> | Readonly<{ kind: "stale" }> | ControllerPresentationFailure;
export type ControllerEventSink<G> = Readonly<{
  hoverIndex(generation: G, index: number | null): void;
  activationIndex(generation: G, index: number | null): void;
  selectionAction(generation: G, action: SelectionAction): void;
}>;

export type ControllerPresenter<G, T = object, C extends ControllerCanvas = ControllerCanvas> = Readonly<{
  stage(generation: G, geometry: ValidatedGeometry, eventSink: ControllerEventSink<G>): ControllerPresenterStageResult<T, C>;
  commit(token: T): ControllerCommitResult;
  rollback(token: T): void;
  setVisualState(generation: G, hover: number | null, selection: number | null): ControllerVisualResult;
  dispose(): void;
}>;

export type ControllerPresentationFactory<G> = (hooks: Readonly<{
  isEligible(generation: G): boolean;
  failed(generation: G, category: "Presentation failed", code: "M1-PRES-1"): void;
}>) => ControllerPresenter<G, unknown, ControllerCanvas>;

type ClosureMeaning = "cancelled" | "replacement" | "invalid" | "disposed";
type TerminalMeaning = "none" | "failure" | "success";
type SuccessSlot = "unused" | "staging" | "committed";

type ActiveBridge = {
  closed: boolean;
  closure?: ClosureMeaning;
  detach: () => void;
  generation: number;
  selectedRevision?: string;
  staticEntered: boolean;
  stopSent: boolean;
  successSlot: SuccessSlot;
  terminal: TerminalMeaning;
  transport: WorkerTransport;
};

type PresentationTransaction = {
  bridge: ActiveBridge;
  city: ValidatedCity;
  publication?: ControllerPublication;
  token?: unknown;
};

type CurrentPresentation = {
  generation: number;
  revision: string;
  city: ValidatedCity;
  publication: ControllerPublication;
  token: unknown;
  hover: number | null;
  selection: number | null;
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
  let current: CurrentPresentation | undefined;
  let transaction: PresentationTransaction | undefined;
  let disposed = false;
  let generation = 0;
  let pending: ReturnType<typeof parseRepositoryReference>;

  const safeRollback = (token: unknown): void => {
    try { presenter.rollback(token); } catch {}
  };

  const rollbackTransaction = (candidate: PresentationTransaction | undefined): void => {
    if (!candidate) return;
    if (transaction === candidate) transaction = undefined;
    try { candidate.publication?.rollback(); } catch {}
    if (candidate.token !== undefined) safeRollback(candidate.token);
  };

  const rollbackCurrent = (publication: CurrentPresentation | undefined): void => {
    if (!publication) return;
    if (current === publication) current = undefined;
    try { publication.publication.rollback(); } catch {}
    safeRollback(publication.token);
  };

  const presentationEligible = (candidate: number): boolean => {
    if (disposed) return false;
    if (transaction?.bridge.generation === candidate
      && active === transaction.bridge
      && !transaction.bridge.closed
      && !transaction.bridge.closure
      && transaction.bridge.staticEntered
      && transaction.bridge.terminal === "none"
      && transaction.bridge.successSlot === "staging") return true;
    return current?.generation === candidate;
  };

  const failPresentation = (candidate: number): void => {
    if (disposed) return;
    const staged = transaction?.bridge.generation === candidate ? transaction : undefined;
    const publication = current?.generation === candidate ? current : undefined;
    if (!staged && !publication) return;
    const bridge = staged?.bridge ?? (active?.generation === candidate ? active : undefined);
    const revision = staged?.bridge.selectedRevision ?? publication?.revision;
    rollbackTransaction(staged);
    rollbackCurrent(publication);
    if (bridge) {
      bridge.successSlot = "committed";
      bridge.terminal = "failure";
    }
    view.failure("Presentation failed", "M1-PRES-1", revision);
  };

  const presenter = createPresentation({
    isEligible: presentationEligible,
    failed(candidate) {
      failPresentation(candidate);
    },
  });

  function clearPresentationState(): void {
    const staged = transaction;
    const publication = current;
    transaction = undefined;
    current = undefined;
    try { staged?.publication?.rollback(); } catch {}
    try { publication?.publication.rollback(); } catch {}
    if (staged?.token !== undefined) safeRollback(staged.token);
    if (publication) safeRollback(publication.token);
    view.clear();
  }

  function startPending(): void {
    if (disposed || active || !pending) return;
    const repository = pending;
    pending = undefined;
    start(repository);
  }

  function cleanup(bridge: ActiveBridge): void {
    if (bridge.closed) return;
    bridge.closed = true;
    try { bridge.detach(); } catch {}
    try { bridge.transport.close(); } catch {}
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
    if (bridge.closure || bridge.terminal === "failure") return;
    rollbackTransaction(transaction?.bridge === bridge ? transaction : undefined);
    rollbackCurrent(current?.generation === bridge.generation ? current : undefined);
    bridge.successSlot = "committed";
    bridge.terminal = "failure";
    view.failure(category, code, bridge.selectedRevision);
  }

  function drainImpossible(bridge: ActiveBridge): void {
    if (!bridge.closure) {
      if (bridge.terminal === "success") bridge.terminal = "none";
      showFailure(bridge);
    }
    cleanup(bridge);
  }

  function stopProvider(bridge: ActiveBridge): void {
    if (bridge.stopSent) return;
    bridge.stopSent = true;
    try {
      bridge.transport.send({ type: "STOP", generation: bridge.generation });
    } catch {
      cleanup(bridge);
    }
  }

  function closeWithMeaning(bridge: ActiveBridge, meaning: ClosureMeaning): void {
    bridge.closure = meaning;
    if (bridge.staticEntered) cleanup(bridge);
    else stopProvider(bridge);
  }

  function cancel(): void {
    if (disposed) return;
    const bridge = active;
    if (!bridge || bridge.closed || (bridge.closure === "cancelled" && !pending)) return;
    pending = undefined;
    clearPresentationState();
    bridge.closure = "cancelled";
    view.cancelled();
    if (bridge.staticEntered) cleanup(bridge);
    else stopProvider(bridge);
  }

  function messageFailureMatchesSelection(bridge: ActiveBridge, message: Extract<ParsedWorkerMessage, { type: "FAILURE" }>): boolean {
    if (bridge.selectedRevision === undefined) return !("revision" in message);
    return "revision" in message && message.revision === bridge.selectedRevision;
  }

  function stageEligible(bridge: ActiveBridge): boolean {
    return !disposed
      && active === bridge
      && !bridge.closed
      && !bridge.closure
      && bridge.selectedRevision !== undefined
      && bridge.staticEntered
      && bridge.terminal === "none"
      && bridge.successSlot === "unused";
  }

  function transactionStillEligible(candidate: PresentationTransaction): boolean {
    const bridge = candidate.bridge;
    return !disposed
      && transaction === candidate
      && active === bridge
      && !bridge.closed
      && !bridge.closure
      && bridge.staticEntered
      && bridge.terminal === "none"
      && bridge.successSlot === "staging";
  }

  function validIndex(publication: CurrentPresentation, index: number | null): boolean {
    return index === null || (Number.isSafeInteger(index) && index >= 0 && index < publication.city.geometry.count);
  }

  function applyVisual(publication: CurrentPresentation, hover: number | null, selection: number | null): void {
    if (current !== publication || !validIndex(publication, hover) || !validIndex(publication, selection)) return;
    try {
      const result = presenter.setVisualState(publication.generation, hover, selection);
      if (result.kind === "failure") {
        failPresentation(publication.generation);
        return;
      }
      if (result.kind !== "applied" || current !== publication) return;
      if (selection !== publication.selection) publication.publication.setSelection(selection);
      if (current !== publication) return;
      publication.hover = hover;
      publication.selection = selection;
    } catch {
      failPresentation(publication.generation);
    }
  }

  function eventSink(token: () => unknown): ControllerEventSink<number> {
    const publicationFor = (callbackGeneration: number): CurrentPresentation | undefined => {
      const publication = current;
      return publication?.generation === callbackGeneration && publication.token === token() ? publication : undefined;
    };
    return Object.freeze({
      hoverIndex(callbackGeneration, index) {
        const publication = publicationFor(callbackGeneration);
        if (publication && validIndex(publication, index)) applyVisual(publication, index, publication.selection);
      },
      activationIndex(callbackGeneration, index) {
        const publication = publicationFor(callbackGeneration);
        if (publication && validIndex(publication, index)) applyVisual(publication, publication.hover, index);
      },
      selectionAction(callbackGeneration, action) {
        const publication = publicationFor(callbackGeneration);
        if (!publication) return;
        const count = publication.city.geometry.count;
        const selected = publication.selection;
        let next = selected;
        if (action === "clear") next = null;
        else if (action === "first") next = 0;
        else if (action === "last") next = count - 1;
        else if (action === "next") next = selected === null ? 0 : Math.min(count - 1, selected + 1);
        else if (action === "previous") next = selected === null ? count - 1 : Math.max(0, selected - 1);
        else return;
        applyVisual(publication, publication.hover, next);
      },
    });
  }

  function handleSuccess(bridge: ActiveBridge, message: Extract<ParsedWorkerMessage, { type: "SUCCESS" }>): void {
    if (!stageEligible(bridge) || message.revision !== bridge.selectedRevision) {
      drainImpossible(bridge);
      return;
    }

    bridge.successSlot = "staging";
    const candidate: PresentationTransaction = { bridge, city: message.city };
    transaction = candidate;
    let callbackToken: unknown;
    try {
      const staged = presenter.stage(bridge.generation, message.city.geometry, eventSink(() => callbackToken));
      if (staged.kind === "failure") {
        failPresentation(bridge.generation);
        return;
      }
      if (staged.kind === "stale") {
        rollbackTransaction(candidate);
        cleanup(bridge);
        return;
      }
      candidate.token = staged.token;
      callbackToken = staged.token;
      if (!transactionStillEligible(candidate)) {
        rollbackTransaction(candidate);
        cleanup(bridge);
        return;
      }
      candidate.publication = view.stagePublication(message.revision, message.city.inspection);
      if (!transactionStillEligible(candidate)) {
        rollbackTransaction(candidate);
        cleanup(bridge);
        return;
      }
      const committed = presenter.commit(staged.token);
      if (committed.kind !== "committed") {
        rollbackTransaction(candidate);
        cleanup(bridge);
        return;
      }
      const initialVisual = presenter.setVisualState(bridge.generation, null, null);
      if (initialVisual.kind === "failure") {
        failPresentation(bridge.generation);
        return;
      }
      if (initialVisual.kind !== "applied" || !transactionStillEligible(candidate)) {
        rollbackTransaction(candidate);
        cleanup(bridge);
        return;
      }
      candidate.publication.commit(staged.canvas);
      if (!transactionStillEligible(candidate)) {
        rollbackTransaction(candidate);
        cleanup(bridge);
        return;
      }
      const publication: CurrentPresentation = {
        generation: bridge.generation,
        revision: message.revision,
        city: message.city,
        publication: candidate.publication,
        token: staged.token,
        hover: null,
        selection: null,
      };
      transaction = undefined;
      current = publication;
      bridge.successSlot = "committed";
      bridge.terminal = "success";
      view.success(message.revision);
    } catch {
      if (transaction === candidate || current?.generation === bridge.generation) failPresentation(bridge.generation);
    }
  }

  function handleMessage(bridge: ActiveBridge, value: unknown): void {
    if (bridge.closed || disposed) return;
    const messageGeneration = readGeneration(value);
    if (messageGeneration !== undefined && messageGeneration !== bridge.generation) return;
    const message = parseWorkerMessage(value, bridge.generation);
    if (!message) {
      drainImpossible(bridge);
      return;
    }

    if (message.type === "ATTEMPT_DRAINED") {
      if (bridge.closure || bridge.terminal === "failure" || bridge.terminal === "success") cleanup(bridge);
      else drainImpossible(bridge);
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
      if (bridge.closure) bridge.terminal = "failure";
      else showFailure(bridge, message.category, "code" in message ? message.code : undefined);
      return;
    }

    if (message.type === "PROVIDER_DRAINED_STATIC_ENTERED") {
      if (bridge.selectedRevision === undefined || bridge.staticEntered) {
        drainImpossible(bridge);
        return;
      }
      bridge.staticEntered = true;
      if (bridge.closure) cleanup(bridge);
      return;
    }

    if (bridge.closure
      || bridge.selectedRevision === undefined
      || !bridge.staticEntered
      || message.revision !== bridge.selectedRevision) {
      drainImpossible(bridge);
      return;
    }
    handleSuccess(bridge, message);
  }

  function start(repository: NonNullable<ReturnType<typeof parseRepositoryReference>>): boolean {
    if (disposed) return false;
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
      successSlot: "unused",
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
      if (typeof detach !== "function") throw new Error("Worker listener setup did not return cleanup");
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
    if (disposed) return false;
    const repository = parseRepositoryReference(value);
    clearPresentationState();
    const bridge = active;
    if (!repository) {
      pending = undefined;
      if (bridge) closeWithMeaning(bridge, "invalid");
      view.invalid();
      return false;
    }

    if (!bridge) return start(repository);
    pending = repository;
    view.working(cancel);
    closeWithMeaning(bridge, "replacement");
    return true;
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    pending = undefined;
    const staged = transaction;
    const publication = current;
    transaction = undefined;
    current = undefined;
    try { staged?.publication?.rollback(); } catch {}
    try { publication?.publication.rollback(); } catch {}
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
