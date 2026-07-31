import type { CityModel } from "../../../packages/core/src/model.js";
import type {
  AdvancedQueryContext,
  AdvancedQueryDefinition,
  AdvancedQueryEvaluation,
} from "./advanced-query.js";
import {
  isAdvancedQueryWorkerResponse,
  type AdvancedQueryEvaluateRequest,
  type AdvancedQueryWorkerContext,
} from "./advanced-query-protocol.js";

export interface AdvancedQueryWorkerClientOptions {
  readonly createWorker?: () => Worker;
}

interface ActiveQuery {
  readonly jobId: number;
  readonly worker: Worker;
  readonly reject: (error: unknown) => void;
  readonly cleanup: () => void;
}

function cancelledError(): DOMException {
  return new DOMException(
    "The advanced query was cancelled.",
    "AbortError",
  );
}

export class AdvancedQueryWorkerClient {
  private readonly createWorker: () => Worker;
  private active: ActiveQuery | undefined;
  private nextJobId = 0;
  private disposed = false;

  public constructor(options: AdvancedQueryWorkerClientOptions = {}) {
    this.createWorker =
      options.createWorker ??
      (() =>
        new Worker(
          new URL("./advanced-query-worker.ts", import.meta.url),
          {
            type: "module",
            name: "code-city-advanced-query",
          },
        ));
  }

  public evaluate(
    model: CityModel,
    definition: AdvancedQueryDefinition,
    context: AdvancedQueryContext = {},
  ): Promise<AdvancedQueryEvaluation> {
    if (this.disposed) {
      return Promise.reject(
        new Error("The advanced query worker client has been disposed."),
      );
    }
    this.cancel();
    const jobId = ++this.nextJobId;
    const worker = this.createWorker();
    const request: AdvancedQueryEvaluateRequest = {
      type: "evaluate",
      jobId,
      model,
      definition,
      context: serializeContext(context),
    };
    return new Promise<AdvancedQueryEvaluation>((resolve, reject) => {
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
          !isAdvancedQueryWorkerResponse(response) ||
          response.jobId !== jobId
        ) {
          finish(() =>
            reject(
              new Error(
                "The advanced query worker returned an invalid response.",
              ),
            ),
          );
          return;
        }
        if (response.type === "failure") {
          finish(() => reject(new Error(response.message)));
        } else {
          finish(() => resolve(response.evaluation));
        }
      };
      const onWorkerError = (): void => {
        finish(() =>
          reject(
            new Error("The advanced query worker stopped unexpectedly."),
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
              "The model could not be sent to the advanced query worker.",
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

function serializeContext(
  context: AdvancedQueryContext,
): AdvancedQueryWorkerContext {
  return {
    changes:
      context.changesByBuildingId === undefined
        ? null
        : sortedMapEntries(context.changesByBuildingId),
    smellRules:
      context.smellRuleIdsByBuildingId === undefined
        ? null
        : sortedMapEntries(context.smellRuleIdsByBuildingId),
  };
}

function sortedMapEntries<T extends string>(
  source: ReadonlyMap<string, ReadonlySet<T>> | undefined,
): readonly [string, readonly T[]][] {
  if (source === undefined) return [];
  return [...source]
    .map(
      ([id, values]) =>
        [id, [...values].sort()] as [string, readonly T[]],
    )
    .sort(([left], [right]) => left.localeCompare(right));
}
