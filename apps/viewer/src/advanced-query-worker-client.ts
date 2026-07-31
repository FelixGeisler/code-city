import type { CityModel } from "../../../packages/core/src/model.js";
import type { AdvancedQuery, AdvancedQueryResult } from "./advanced-query.js";
import { isAdvancedQueryWorkerResponse } from "./advanced-query-protocol.js";

export interface AdvancedQueryWorkerClientOptions { readonly createWorker?: () => Worker; }
interface ActiveQuery { readonly jobId: number; readonly worker: Worker; readonly reject: (error: unknown) => void; readonly cleanup: () => void; }

/** A hard worker boundary keeps replacement/cancellation responsive for large cities. */
export class AdvancedQueryWorkerClient {
  private readonly createWorker: () => Worker;
  private active: ActiveQuery | undefined;
  private nextJobId = 0;
  private disposed = false;
  public constructor(options: AdvancedQueryWorkerClientOptions = {}) { this.createWorker = options.createWorker ?? (() => new Worker(new URL("./advanced-query-worker.ts", import.meta.url), { type: "module", name: "code-city-advanced-query" })); }
  public evaluate(model: CityModel, query: AdvancedQuery, selectedBuildingIds: ReadonlySet<string>, limit: number): Promise<AdvancedQueryResult> {
    if (this.disposed) return Promise.reject(new Error("The advanced query worker client has been disposed."));
    this.cancel();
    const jobId = ++this.nextJobId;
    const worker = this.createWorker();
    return new Promise<AdvancedQueryResult>((resolve, reject) => {
      let settled = false;
      const cleanup = () => { worker.removeEventListener("message", onMessage); worker.removeEventListener("error", onError); worker.removeEventListener("messageerror", onError); };
      const finish = (action: () => void) => { if (settled) return; settled = true; cleanup(); worker.terminate(); if (this.active?.jobId === jobId) this.active = undefined; action(); };
      const onMessage = (event: MessageEvent<unknown>) => { const response = event.data; if (!isAdvancedQueryWorkerResponse(response) || response.jobId !== jobId) return finish(() => reject(new Error("The advanced query worker returned an invalid response."))); if (response.type === "failure") return finish(() => reject(new Error(response.message))); finish(() => resolve(response.result)); };
      const onError = () => finish(() => reject(new Error("The advanced query worker stopped unexpectedly.")));
      worker.addEventListener("message", onMessage); worker.addEventListener("error", onError); worker.addEventListener("messageerror", onError);
      this.active = { jobId, worker, reject, cleanup };
      try { worker.postMessage({ type: "evaluate", jobId, model, query, selectedBuildingIds: [...selectedBuildingIds].sort(), limit }); } catch { finish(() => reject(new Error("The query could not be sent to the worker."))); }
    });
  }
  public cancel(): void { const active = this.active; if (!active) return; this.active = undefined; active.cleanup(); active.worker.terminate(); active.reject(new DOMException("The advanced query was cancelled.", "AbortError")); }
  public dispose(): void { if (this.disposed) return; this.disposed = true; this.cancel(); }
}
