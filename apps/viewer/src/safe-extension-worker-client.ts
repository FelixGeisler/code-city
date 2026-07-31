import {
  createSafeExtensionModelSnapshot,
  migrateSafeExtensionConfiguration,
  type CityModel,
  type ExtensionEvaluation,
} from "../../../packages/core/src/index.js";
import {
  validateSafeExtensionWorkerRequest,
  validateSafeExtensionWorkerResponse,
  type SafeExtensionEvaluateRequest,
} from "./safe-extension-protocol.js";

export interface SafeExtensionWorkerClientOptions {
  readonly createWorker?: () => Worker;
  readonly timeoutMilliseconds?: number;
}

interface ActiveEvaluation {
  readonly worker: Worker;
  readonly reject: (error: unknown) => void;
  readonly cleanup: () => void;
}

function cancellationError(): DOMException {
  return new DOMException(
    "The extension evaluation was cancelled.",
    "AbortError",
  );
}

export class SafeExtensionWorkerClient {
  private readonly createWorker: () => Worker;
  private readonly timeoutMilliseconds: number;
  private active: ActiveEvaluation | undefined;
  private nextJob = 0;
  private disposed = false;

  public constructor(options: SafeExtensionWorkerClientOptions = {}) {
    this.createWorker =
      options.createWorker ??
      (() =>
        new Worker(new URL("./safe-extension-worker.ts", import.meta.url), {
          type: "module",
          name: "code-city-safe-extension",
        }));
    this.timeoutMilliseconds = options.timeoutMilliseconds ?? 10_000;
    if (
      !Number.isSafeInteger(this.timeoutMilliseconds) ||
      this.timeoutMilliseconds < 1 ||
      this.timeoutMilliseconds > 30_000
    ) {
      throw new RangeError(
        "Extension worker timeout must be an integer from 1 to 30,000 milliseconds.",
      );
    }
  }

  public evaluate(
    model: CityModel,
    configuration: unknown,
  ): Promise<ExtensionEvaluation> {
    if (this.disposed) {
      return Promise.reject(
        new Error("The extension worker client has been disposed."),
      );
    }
    this.cancel();
    let request: SafeExtensionEvaluateRequest;
    try {
      if (this.nextJob >= Number.MAX_SAFE_INTEGER) this.nextJob = 0;
      request = validateSafeExtensionWorkerRequest({
        type: "evaluate",
        jobId: ++this.nextJob,
        model: createSafeExtensionModelSnapshot(model),
        configuration: migrateSafeExtensionConfiguration(configuration),
      }) as SafeExtensionEvaluateRequest;
    } catch (error) {
      return Promise.reject(error);
    }
    let worker: Worker;
    try {
      worker = this.createWorker();
    } catch {
      return Promise.reject(
        new Error("The extension worker could not be started."),
      );
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timeout !== undefined) clearTimeout(timeout);
        worker.removeEventListener("message", onMessage);
        worker.removeEventListener("error", onError);
        worker.removeEventListener("messageerror", onError);
      };
      const finish = (action: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        worker.terminate();
        if (this.active?.worker === worker) this.active = undefined;
        action();
      };
      const invalidResponse = () =>
        finish(() =>
          reject(
            new Error("The extension worker returned an invalid response."),
          ),
        );
      const onMessage = (event: MessageEvent<unknown>) => {
        let response;
        try {
          response = validateSafeExtensionWorkerResponse(event.data, request);
        } catch {
          invalidResponse();
          return;
        }
        if (response.jobId !== request.jobId) {
          invalidResponse();
          return;
        }
        if (response.type === "failure") {
          finish(() => reject(new Error(response.message)));
          return;
        }
        finish(() => resolve(response.evaluation));
      };
      const onError = () =>
        finish(() =>
          reject(new Error("The extension worker stopped unexpectedly.")),
        );
      worker.addEventListener("message", onMessage);
      worker.addEventListener("error", onError);
      worker.addEventListener("messageerror", onError);
      this.active = { worker, reject, cleanup };
      timeout = setTimeout(
        () =>
          finish(() =>
            reject(new Error("The extension worker exceeded its time limit.")),
          ),
        this.timeoutMilliseconds,
      );
      try {
        worker.postMessage(request);
      } catch {
        finish(() =>
          reject(new Error("The extension could not be sent to the worker.")),
        );
      }
    });
  }

  /** Termination is the interrupt: synchronous evaluator work cannot ignore it. */
  public cancel(): void {
    const active = this.active;
    if (!active) return;
    this.active = undefined;
    active.cleanup();
    active.worker.terminate();
    active.reject(cancellationError());
  }

  public dispose(): void {
    this.disposed = true;
    this.cancel();
  }
}
