import { validateCityModel } from "./model-validation.js";
import {
  isEvolutionWorkerResponse,
  type EvolutionLoadResult,
  type EvolutionSeekResult,
  type EvolutionWorkerRequest,
  type EvolutionWorkerResponse,
} from "./evolution-timeline-protocol.js";

export interface EvolutionTimelineWorkerClientOptions {
  readonly createWorker?: () => Worker;
}

interface PendingRequest {
  readonly requestId: number;
  readonly kind: "load" | "seek";
  readonly resolve: (value: EvolutionLoadResult | EvolutionSeekResult) => void;
  readonly reject: (error: unknown) => void;
}

function cancelledError(): DOMException {
  return new DOMException("The evolution seek was replaced.", "AbortError");
}

export class EvolutionTimelineWorkerClient {
  private readonly createWorker: () => Worker;
  private worker: Worker | undefined;
  private pending: PendingRequest | undefined;
  private nextRequestId = 0;
  private loaded = false;
  private disposed = false;

  public constructor(options: EvolutionTimelineWorkerClientOptions = {}) {
    this.createWorker =
      options.createWorker ??
      (() =>
        new Worker(
          new URL("./evolution-timeline-worker.ts", import.meta.url),
          {
            type: "module",
            name: "code-city-evolution-timeline",
          },
        ));
  }

  public load(
    bytes: ArrayBuffer,
    expected: { readonly size: number; readonly sha256: string },
  ): Promise<EvolutionLoadResult> {
    if (this.disposed) {
      return Promise.reject(new Error("The evolution worker is disposed."));
    }
    this.reset();
    const worker = this.createWorker();
    this.worker = worker;
    worker.addEventListener("message", this.onMessage);
    worker.addEventListener("error", this.onError);
    worker.addEventListener("messageerror", this.onError);
    const request: EvolutionWorkerRequest = {
      type: "load",
      requestId: ++this.nextRequestId,
      bytes,
      expectedSize: expected.size,
      expectedSha256: expected.sha256,
    };
    return this.post<EvolutionLoadResult>(worker, request, "load", [bytes]);
  }

  public seek(
    fromIndex: number,
    toIndex: number,
  ): Promise<EvolutionSeekResult> {
    const worker = this.worker;
    if (this.disposed || !worker || !this.loaded) {
      return Promise.reject(new Error("Repository evolution is not loaded."));
    }
    this.cancelPending();
    const request: EvolutionWorkerRequest = {
      type: "seek",
      requestId: ++this.nextRequestId,
      fromIndex,
      toIndex,
    };
    return this.post<EvolutionSeekResult>(worker, request, "seek");
  }

  public cancel(): void {
    const pending = this.cancelPending();
    const worker = this.worker;
    if (pending?.kind !== "seek" || worker === undefined || !this.loaded) {
      return;
    }
    const request: EvolutionWorkerRequest = {
      type: "cancel",
      requestId: ++this.nextRequestId,
    };
    try {
      worker.postMessage(request);
    } catch {
      this.fail(new Error("The evolution cancellation could not be sent."));
    }
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.reset();
  }

  private post<T extends EvolutionLoadResult | EvolutionSeekResult>(
    worker: Worker,
    request: EvolutionWorkerRequest,
    kind: PendingRequest["kind"],
    transfer: Transferable[] = [],
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending = {
        requestId: request.requestId,
        kind,
        resolve: resolve as PendingRequest["resolve"],
        reject,
      };
      try {
        worker.postMessage(request, transfer);
      } catch {
        this.fail(new Error("The evolution request could not be sent."));
      }
    });
  }

  private readonly onMessage = (event: MessageEvent<unknown>): void => {
    const response = event.data;
    if (!isEvolutionWorkerResponse(response)) {
      this.fail(new Error("The evolution worker returned an invalid response."));
      return;
    }
    const pending = this.pending;
    if (!pending || response.requestId !== pending.requestId) {
      return;
    }
    if (response.type === "failure") {
      this.pending = undefined;
      pending.reject(new Error(response.message));
      if (pending.kind === "load") this.reset();
      return;
    }
    if (
      (pending.kind === "load" && response.type !== "loaded") ||
      (pending.kind === "seek" && response.type !== "frame")
    ) {
      this.fail(new Error("The evolution worker returned an invalid response."));
      return;
    }
    try {
      validateCityModel(response.model);
      this.pending = undefined;
      if (response.type === "loaded") this.loaded = true;
      pending.resolve(response);
    } catch (error) {
      this.fail(error);
    }
  };

  private readonly onError = (): void => {
    this.fail(new Error("The evolution worker stopped unexpectedly."));
  };

  private cancelPending(): PendingRequest | undefined {
    const pending = this.pending;
    if (!pending) return undefined;
    this.pending = undefined;
    pending.reject(cancelledError());
    return pending;
  }

  private fail(error: unknown): void {
    const pending = this.pending;
    this.pending = undefined;
    pending?.reject(error);
    this.resetWorker();
  }

  private reset(): void {
    this.cancelPending();
    this.resetWorker();
  }

  private resetWorker(): void {
    const worker = this.worker;
    this.worker = undefined;
    this.loaded = false;
    if (!worker) return;
    worker.removeEventListener("message", this.onMessage);
    worker.removeEventListener("error", this.onError);
    worker.removeEventListener("messageerror", this.onError);
    worker.terminate();
  }
}
