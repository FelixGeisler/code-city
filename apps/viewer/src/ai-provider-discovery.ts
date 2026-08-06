import type {
  ViewerAiGuidanceProvider,
  ViewerAiGuidanceProviders,
} from "./import-api.js";

export type AiProviderCapability =
  | Readonly<{ state: "idle" | "loading" | "not-configured" | "unavailable" }>
  | Readonly<{
      state: "configured";
      providers: readonly ViewerAiGuidanceProvider[];
    }>;

type CachedAiProviderCapability =
  | Readonly<{ state: "not-configured" }>
  | Readonly<{
      state: "configured";
      providers: readonly ViewerAiGuidanceProvider[];
    }>;

const IDLE = Object.freeze({ state: "idle" as const });

/**
 * Session-memory capability discovery. Successful enabled and disabled
 * responses are cached; authentication/transient failures remain retryable.
 * Invalidation generation-guards an in-flight response without coupling it to
 * a selection or source-request AbortController.
 */
export class AiProviderDiscoveryController {
  private current: AiProviderCapability = IDLE;
  private cached: CachedAiProviderCapability | undefined;
  private pending: Promise<AiProviderCapability> | undefined;
  private generation = 0;

  public constructor(
    private readonly load: () => Promise<ViewerAiGuidanceProviders>,
  ) {}

  public get capability(): AiProviderCapability {
    return this.current;
  }

  public discover(): Promise<AiProviderCapability> {
    if (this.cached !== undefined) {
      this.current = this.cached;
      return Promise.resolve(this.cached);
    }
    if (this.pending !== undefined) return this.pending;
    const generation = this.generation;
    this.current = Object.freeze({ state: "loading" });
    const pending = this.load()
      .then((response): AiProviderCapability => {
        const result: CachedAiProviderCapability =
          response.enabled && response.providers.length > 0
          ? Object.freeze({
              state: "configured",
              providers: Object.freeze([...response.providers]),
            })
          : Object.freeze({ state: "not-configured" });
        if (this.generation === generation) {
          this.cached = result;
          this.current = result;
        }
        return this.generation === generation ? result : this.current;
      })
      .catch((): AiProviderCapability => {
        const result = Object.freeze({ state: "unavailable" as const });
        if (this.generation === generation) this.current = result;
        return this.generation === generation ? result : this.current;
      })
      .finally(() => {
        if (this.pending === pending) this.pending = undefined;
      });
    this.pending = pending;
    return pending;
  }

  public invalidate(): void {
    this.generation += 1;
    this.cached = undefined;
    this.pending = undefined;
    this.current = IDLE;
  }
}
