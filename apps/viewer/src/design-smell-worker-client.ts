import {
  validateDesignSmellEvaluation,
  type CityModel,
  type DesignSmellConfiguration,
  type DesignSmellEvaluation,
  type DesignSmellSuppression,
} from "../../../packages/core/src/index.js";
import {
  isDesignSmellWorkerResponse,
  type DesignSmellEvaluateRequest,
} from "./design-smell-protocol.js";

interface ActiveEvaluation {
  readonly worker: Worker;
  readonly jobId: number;
  readonly reject: (reason: unknown) => void;
  readonly cleanup: () => void;
}

function cancellationError(): DOMException {
  return new DOMException(
    "The design-smell evaluation was cancelled.",
    "AbortError",
  );
}

export class DesignSmellWorkerClient {
  private active: ActiveEvaluation | undefined;
  private nextJobId = 0;
  private disposed = false;

  public constructor(
    private readonly createWorker: () => Worker = () =>
      new Worker(new URL("./design-smell-worker.ts", import.meta.url), {
        type: "module",
        name: "code-city-design-smells",
      }),
  ) {}

  public evaluate(
    model: CityModel,
    configuration: DesignSmellConfiguration,
    suppressions: readonly DesignSmellSuppression[],
  ): Promise<DesignSmellEvaluation> {
    if (this.disposed) {
      return Promise.reject(
        new Error(
          "The design-smell worker client has been disposed.",
        ),
      );
    }
    this.cancel();
    const worker = this.createWorker();
    const jobId = ++this.nextJobId;
    const request: DesignSmellEvaluateRequest = {
      type: "evaluate",
      jobId,
      model,
      configuration,
      suppressions,
    };

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (action: () => void): void => {
        if (settled) return;
        settled = true;
        cleanup();
        worker.terminate();
        if (this.active?.jobId === jobId) {
          this.active = undefined;
        }
        action();
      };
      const fail = (): void => {
        finish(() =>
          reject(
            new Error(
              "The design-smell worker stopped unexpectedly.",
            ),
          ),
        );
      };
      const onMessage = (event: MessageEvent<unknown>): void => {
        const response = event.data;
        if (
          !isDesignSmellWorkerResponse(response) ||
          response.jobId !== jobId
        ) {
          fail();
          return;
        }
        if (response.type === "failure") {
          finish(() => reject(new Error(response.message)));
          return;
        }
        try {
          validateDesignSmellEvaluation(
            response.evaluation,
            configuration,
          );
          finish(() => resolve(response.evaluation));
        } catch {
          finish(() =>
            reject(
              new Error(
                "The design-smell worker returned an invalid evaluation.",
              ),
            ),
          );
        }
      };
      const cleanup = (): void => {
        worker.removeEventListener("message", onMessage);
        worker.removeEventListener("error", fail);
        worker.removeEventListener("messageerror", fail);
      };

      worker.addEventListener("message", onMessage);
      worker.addEventListener("error", fail);
      worker.addEventListener("messageerror", fail);
      this.active = {
        worker,
        jobId,
        reject,
        cleanup,
      };
      try {
        worker.postMessage(request);
      } catch {
        fail();
      }
    });
  }

  public cancel(): void {
    const active = this.active;
    if (active === undefined) return;
    this.active = undefined;
    active.cleanup();
    active.worker.terminate();
    active.reject(cancellationError());
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancel();
  }
}
