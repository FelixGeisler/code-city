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

export type AttemptView = Readonly<{
  invalid(): void;
  working(cancel: () => void): void;
  failure(category: string, code?: FailureCode): void;
  cancelled(): void;
}>;

type ActiveBridge = {
  cancellationSelected: boolean;
  closed: boolean;
  detach: () => void;
  failureShown: boolean;
  generation: number;
  publicationRevoked: boolean;
  staticEntered: boolean;
  stopSent: boolean;
  transport: WorkerTransport;
};

export type MainController = Readonly<{
  submit(value: string): boolean;
  cancel(): void;
}>;

export function createMainController(
  createWorker: () => WorkerTransport,
  view: AttemptView,
): MainController {
  let active: ActiveBridge | undefined;
  let generation = 0;
  let pending: ReturnType<typeof parseRepositoryReference>;

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
    code?: FailureCode,
  ): void {
    if (bridge.publicationRevoked || bridge.failureShown) {
      return;
    }
    bridge.failureShown = true;
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
            showFailure(bridge, message.category, message.code);
            return;
          }
          if (message.type === "PROVIDER_DRAINED_STATIC_ENTERED") {
            if (bridge.failureShown || bridge.staticEntered) {
              if (!bridge.publicationRevoked) {
                showFailure(bridge);
              }
              cleanup(bridge);
              return;
            }
            bridge.staticEntered = true;
            if (bridge.publicationRevoked) {
              cleanup(bridge);
            }
            return;
          }
          if (!bridge.publicationRevoked && !bridge.failureShown) {
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
