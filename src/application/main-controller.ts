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
  cancelled: boolean;
  closed: boolean;
  detach: () => void;
  failureShown: boolean;
  generation: number;
  staticEntered: boolean;
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
  let started = false;

  function cleanup(bridge: ActiveBridge): void {
    if (bridge.closed) {
      return;
    }
    bridge.closed = true;
    bridge.detach();
    bridge.transport.close();
    if (active === bridge) {
      active = undefined;
    }
  }

  function showFailure(
    bridge: ActiveBridge,
    category = "Provider/resolution failure",
    code?: FailureCode,
  ): void {
    if (bridge.cancelled || bridge.failureShown) {
      return;
    }
    bridge.failureShown = true;
    view.failure(category, code);
  }

  function drainImpossible(bridge: ActiveBridge): void {
    if (bridge.cancelled) {
      cleanup(bridge);
      return;
    }
    showFailure(bridge);
    cleanup(bridge);
  }

  function cancel(): void {
    const bridge = active;
    if (!bridge || bridge.cancelled || bridge.closed) {
      return;
    }
    bridge.cancelled = true;
    view.cancelled();
    if (bridge.staticEntered) {
      cleanup(bridge);
      return;
    }
    try {
      bridge.transport.send({ type: "STOP", generation: bridge.generation });
    } catch {
      cleanup(bridge);
    }
  }

  function submit(value: string): boolean {
    if (active || started) {
      return false;
    }
    const repository = parseRepositoryReference(value);
    if (!repository) {
      view.invalid();
      return false;
    }

    generation += 1;
    let transport: WorkerTransport;
    try {
      transport = createWorker();
    } catch {
      started = true;
      view.failure("Provider/resolution failure");
      return false;
    }

    started = true;
    const bridge: ActiveBridge = {
      cancelled: false,
      closed: false,
      detach: () => {},
      failureShown: false,
      generation,
      staticEntered: false,
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
            if (!bridge.cancelled) {
              showFailure(bridge);
              cleanup(bridge);
            }
            return;
          }
          if (message.type === "FAILURE") {
            showFailure(bridge, message.category, message.code);
            return;
          }
          if (message.type === "PROVIDER_DRAINED_STATIC_ENTERED") {
            if (bridge.cancelled || bridge.failureShown || bridge.staticEntered) {
              if (!bridge.cancelled) {
                showFailure(bridge);
              }
              cleanup(bridge);
              return;
            }
            bridge.staticEntered = true;
            return;
          }
          if (!bridge.cancelled && !bridge.failureShown) {
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
      transport.send({ type: "START", generation, repository });
    } catch {
      drainImpossible(bridge);
      return false;
    }
    return true;
  }

  return { submit, cancel };
}
