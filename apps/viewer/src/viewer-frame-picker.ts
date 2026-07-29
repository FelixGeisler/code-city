export interface ViewerAnimationFrameScheduler {
  request(callback: (timestamp: number) => void): number;
  cancel(handle: number): void;
}

/**
 * Retains only the newest pointer request and executes at most one pick for
 * each animation-frame callback. The picker and result consumer are injected
 * so this scheduler remains independent of DOM and Three.js.
 */
export class ViewerFramePicker<Request, Result> {
  private pending: Request | undefined;
  private frameHandle: number | null = null;
  private generation = 0;
  private disposed = false;

  public constructor(
    private readonly pick: (request: Request) => Result,
    private readonly consume: (result: Result, request: Request) => void,
    private readonly scheduler: ViewerAnimationFrameScheduler,
  ) {}

  public get hasPendingRequest(): boolean {
    return this.pending !== undefined;
  }

  public request(request: Request): void {
    this.assertActive();
    this.pending = request;
    if (this.frameHandle !== null) return;

    const generation = this.generation;
    this.frameHandle = this.scheduler.request(() => {
      if (generation !== this.generation || this.disposed) return;
      this.frameHandle = null;
      this.executePending();
    });
  }

  /** Executes the newest pending request immediately, if one exists. */
  public flush(): boolean {
    if (this.disposed || this.pending === undefined) return false;
    this.cancelScheduledFrame();
    this.executePending();
    return true;
  }

  /** Drops the pending request and invalidates any scheduled callback. */
  public cancel(): boolean {
    if (this.disposed) return false;
    const changed =
      this.pending !== undefined || this.frameHandle !== null;
    this.pending = undefined;
    this.cancelScheduledFrame();
    return changed;
  }

  public dispose(): void {
    if (this.disposed) return;
    this.cancel();
    this.disposed = true;
  }

  private executePending(): void {
    const request = this.pending;
    if (request === undefined) return;
    this.pending = undefined;
    this.consume(this.pick(request), request);
  }

  private cancelScheduledFrame(): void {
    this.generation += 1;
    if (this.frameHandle === null) return;
    this.scheduler.cancel(this.frameHandle);
    this.frameHandle = null;
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new Error("The viewer frame picker has been disposed.");
    }
  }
}
