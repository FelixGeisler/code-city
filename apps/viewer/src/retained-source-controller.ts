import type { BuildingSource } from "./source-navigation.js";

export interface RetainedSourceLoadCallbacks {
  readonly loaded: (source: BuildingSource) => void;
  readonly failed: (error: unknown) => void;
}

/** Owns the single retained-source request and rejects superseded responses. */
export class RetainedSourceController {
  private request:
    | Readonly<{
        buildingId: string;
        controller: AbortController;
        promise: Promise<BuildingSource>;
      }>
    | undefined;
  private loaded:
    | Readonly<{ buildingId: string; source: BuildingSource }>
    | undefined;

  public sourceFor(buildingId: string): BuildingSource | undefined {
    return this.loaded?.buildingId === buildingId
      ? this.loaded.source
      : undefined;
  }

  public isLoading(buildingId: string): boolean {
    return this.request?.buildingId === buildingId;
  }

  public clear(): void {
    this.request?.controller.abort();
    this.request = undefined;
    this.loaded = undefined;
  }

  public load(
    buildingId: string,
    operation: (signal: AbortSignal) => Promise<BuildingSource>,
    isStillSelected: () => boolean,
    callbacks: RetainedSourceLoadCallbacks,
  ): void {
    if (this.isLoading(buildingId)) return;
    this.clear();
    const controller = new AbortController();
    const promise = operation(controller.signal);
    const request = Object.freeze({ buildingId, controller, promise });
    this.request = request;
    void promise.then((source) => {
      if (
        controller.signal.aborted ||
        this.request !== request ||
        !isStillSelected()
      ) return;
      this.request = undefined;
      this.loaded = Object.freeze({ buildingId, source });
      callbacks.loaded(source);
    }).catch((error: unknown) => {
      if (controller.signal.aborted || this.request !== request) return;
      this.request = undefined;
      this.loaded = undefined;
      callbacks.failed(error);
    });
  }
}
