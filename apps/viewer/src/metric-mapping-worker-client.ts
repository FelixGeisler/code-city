import type {
  CityModel,
  MetricMappingDefinitionV1,
} from "../../../packages/core/src/index.js";
import {
  isMetricMappingWorkerResponse,
  type MetricMappingProjectRequest,
} from "./metric-mapping-protocol.js";
import { validateCityModel } from "./model-validation.js";

export interface MetricMappingWorkerClientOptions {
  readonly createWorker?: () => Worker;
}

interface ActiveProjection {
  readonly jobId: number;
  readonly worker: Worker;
  readonly reject: (error: unknown) => void;
  readonly cleanup: () => void;
}

function cancelledError(): DOMException {
  return new DOMException(
    "The metric mapping preview was cancelled.",
    "AbortError",
  );
}

/**
 * Runs each projection in a fresh module worker. Starting, editing, cancelling,
 * or replacing a project terminates the previous worker at the hard boundary.
 */
export class MetricMappingWorkerClient {
  private readonly createWorker: () => Worker;
  private active: ActiveProjection | undefined;
  private nextJobId = 0;
  private disposed = false;

  public constructor(options: MetricMappingWorkerClientOptions = {}) {
    this.createWorker =
      options.createWorker ??
      (() =>
        new Worker(
          new URL("./metric-mapping-worker.ts", import.meta.url),
          {
            type: "module",
            name: "code-city-metric-mapping-preview",
          },
        ));
  }

  public project(
    model: CityModel,
    mapping: MetricMappingDefinitionV1,
  ): Promise<CityModel> {
    if (this.disposed) {
      return Promise.reject(
        new Error("The metric mapping worker client has been disposed."),
      );
    }
    this.cancel();
    const jobId = ++this.nextJobId;
    const worker = this.createWorker();
    const request: MetricMappingProjectRequest = {
      type: "project",
      jobId,
      model,
      mapping,
    };

    return new Promise<CityModel>((resolve, reject) => {
      let settled = false;
      const finish = (action: () => void): void => {
        if (settled) return;
        settled = true;
        cleanup();
        worker.terminate();
        if (this.active?.jobId === jobId) this.active = undefined;
        action();
      };
      const onMessage = (event: MessageEvent<unknown>): void => {
        const response = event.data;
        if (
          !isMetricMappingWorkerResponse(response) ||
          response.jobId !== jobId
        ) {
          finish(() =>
            reject(
              new Error(
                "The metric mapping worker returned an invalid response.",
              ),
            ),
          );
          return;
        }
        if (response.type === "failure") {
          finish(() => reject(new Error(response.message)));
          return;
        }
        try {
          const projected = validateCityModel(response.model);
          finish(() => resolve(projected));
        } catch (error) {
          finish(() => reject(error));
        }
      };
      const onWorkerError = (): void => {
        finish(() =>
          reject(
            new Error(
              "The metric mapping worker stopped unexpectedly.",
            ),
          ),
        );
      };
      const cleanup = (): void => {
        worker.removeEventListener("message", onMessage);
        worker.removeEventListener("error", onWorkerError);
        worker.removeEventListener("messageerror", onWorkerError);
      };

      worker.addEventListener("message", onMessage);
      worker.addEventListener("error", onWorkerError);
      worker.addEventListener("messageerror", onWorkerError);
      this.active = { jobId, worker, reject, cleanup };
      try {
        worker.postMessage(request);
      } catch {
        finish(() =>
          reject(
            new Error(
              "The model could not be sent to the metric mapping worker.",
            ),
          ),
        );
      }
    });
  }

  public cancel(): void {
    const active = this.active;
    if (active === undefined) return;
    this.active = undefined;
    active.cleanup();
    active.worker.terminate();
    active.reject(cancelledError());
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancel();
  }
}
