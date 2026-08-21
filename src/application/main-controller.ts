import { parseWorkerMessage, readGeneration, type WorkerCommand } from "./protocol";
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
  failure(category: string, code?: VisibleFailureCode): void;
  cancelled(): void;
}>;

export type ControllerPresentationResult =
  | Readonly<{ kind: "committed" }>
  | Readonly<{ kind: "stale" }>
  | Readonly<{ kind: "failure"; category: "City construction failed" | "Presentation failed"; code: "M1-CITY-1" | "M1-PRES-1" }>;

export type ControllerPresenter<G> = Readonly<{
  present(generation: G, model: unknown): ControllerPresentationResult;
  clear(): void;
}>;

export type ControllerPresentationFactory<G> = (hooks: Readonly<{
  isEligible(generation: G): boolean;
  failed(generation: G, category: "City construction failed" | "Presentation failed", code: "M1-CITY-1" | "M1-PRES-1"): void;
}>) => ControllerPresenter<G>;

type ActiveBridge = {
  cancellationSelected: boolean;
  closed: boolean;
  detach: () => void;
  failureShown: boolean;
  generation: number;
  publicationRevoked: boolean;
  staticEntered: boolean;
  stopSent: boolean;
  successAccepted: boolean;
  successCommitted: boolean;
  transport: WorkerTransport;
};

export type MainController = Readonly<{
  submit(value: string): boolean;
  cancel(): void;
}>;

export function createMainController(
  createWorker: () => WorkerTransport,
  view: AttemptView,
  createPresentation: ControllerPresentationFactory<number>,
): MainController {
  let active: ActiveBridge | undefined;
  let generation = 0;
  let pending: ReturnType<typeof parseRepositoryReference>;
  let publishedGeneration: number | undefined;

  const presenter = createPresentation({
    isEligible(candidate) {
      return candidate === publishedGeneration;
    },
    failed(candidate, category, code) {
      if (candidate !== publishedGeneration) {
        return;
      }
      publishedGeneration = undefined;
      const bridge = active?.generation === candidate ? active : undefined;
      if (bridge) {
        bridge.failureShown = true;
      }
      view.failure(category, code);
    },
  });

  function revokePublication(): void {
    publishedGeneration = undefined;
    presenter.clear();
    view.clear();
  }

  function startPending(): void {
    if (active || !pending) {
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
    bridge.detach();
    bridge.transport.close();
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
    if (bridge.publicationRevoked || bridge.failureShown) {
      return;
    }
    bridge.failureShown = true;
    if (publishedGeneration === bridge.generation) {
      publishedGeneration = undefined;
      presenter.clear();
    }
    view.failure(category, code);
  }

  function drainImpossible(bridge: ActiveBridge): void {
    if (!bridge.publicationRevoked) {
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

  function cancel(): void {
    pending = undefined;
    const bridge = active;
    if (!bridge || bridge.closed) {
      return;
    }
    bridge.publicationRevoked = true;
    if (!bridge.cancellationSelected) {
      bridge.cancellationSelected = true;
      view.cancelled();
    }
    if (bridge.staticEntered) {
      cleanup(bridge);
      return;
    }
    stopProvider(bridge);
  }

  function start(repository: NonNullable<ReturnType<typeof parseRepositoryReference>>): boolean {
    const nextGeneration = generation + 1;
    let transport: WorkerTransport;
    try {
      transport = createWorker();
    } catch {
      view.failure("Provider/resolution failure");
      return false;
    }

    const bridge: ActiveBridge = {
      cancellationSelected: false,
      closed: false,
      detach: () => {},
      failureShown: false,
      generation: nextGeneration,
      publicationRevoked: false,
      staticEntered: false,
      stopSent: false,
      successAccepted: false,
      successCommitted: false,
      transport,
    };
    active = bridge;
    try {
      bridge.detach = transport.listen({
        message(value) {
          if (bridge.closed) {
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
          if (message.type === "FAILURE") {
            if (bridge.successAccepted) {
              drainImpossible(bridge);
              return;
            }
            showFailure(bridge, message.category, message.code);
            return;
          }
          if (message.type === "PROVIDER_DRAINED_STATIC_ENTERED") {
            if (bridge.failureShown || bridge.staticEntered || bridge.successAccepted) {
              drainImpossible(bridge);
              return;
            }
            bridge.staticEntered = true;
            if (bridge.publicationRevoked) {
              cleanup(bridge);
            }
            return;
          }
          if (message.type === "SUCCESS") {
            if (!bridge.staticEntered || bridge.failureShown || bridge.successAccepted || bridge.publicationRevoked) {
              drainImpossible(bridge);
              return;
            }
            bridge.successAccepted = true;
            publishedGeneration = bridge.generation;
            const result = presenter.present(bridge.generation, message.model);
            if (result.kind === "stale") {
              if (publishedGeneration === bridge.generation) {
                publishedGeneration = undefined;
              }
              cleanup(bridge);
              return;
            }
            if (result.kind === "failure") {
              publishedGeneration = undefined;
              showFailure(bridge, result.category, result.code);
              return;
            }
            try {
              view.success(message.revision);
              bridge.successCommitted = true;
            } catch {
              drainImpossible(bridge);
            }
            return;
          }
          if (!bridge.publicationRevoked
            && !bridge.failureShown
            && !(bridge.successAccepted && bridge.successCommitted)) {
            showFailure(bridge);
          }
          cleanup(bridge);
        },
        crash: () => drainImpossible(bridge),
        messageError: () => drainImpossible(bridge),
      });
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
    const repository = parseRepositoryReference(value);
    if (!repository) {
      view.invalid();
      return false;
    }

    revokePublication();
    const bridge = active;
    if (!bridge) {
      return start(repository);
    }

    pending = repository;
    bridge.publicationRevoked = true;
    if (bridge.staticEntered) {
      cleanup(bridge);
    } else {
      stopProvider(bridge);
    }
    return true;
  }

  return { submit, cancel };
}
