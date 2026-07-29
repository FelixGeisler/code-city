import {
  isPrintExportWorkerResponse,
  serializePrintExportError,
  type PrintCalibrationGenerateRequest,
  type PrintExportFailure,
  type PrintExportGenerateRequest,
  type PrintExportProgressResponse,
  type PrintExportWorkerRequest,
  type PrintExportWorkerResponse,
} from "./print-export-protocol.js";
import type {
  ThreeMfExportOptions,
  ThreeMfExportPreflight,
} from "../../../packages/exporter/src/three-mf-export.js";
import type {
  CalibrationPreflight,
} from "../../../packages/exporter/src/calibration.js";

export interface PrintExportWorkerLike {
  onmessage:
    | ((event: MessageEvent<unknown>) => unknown)
    | null;
  onerror:
    | ((event: ErrorEvent) => unknown)
    | null;
  onmessageerror:
    | ((event: MessageEvent<unknown>) => unknown)
    | null;
  postMessage(message: PrintExportWorkerRequest): void;
  terminate(): void;
}

export type PrintExportWorkerFactory = () => PrintExportWorkerLike;

export const PRINT_EXPORT_WATCHDOG_MS = 60_000;

export interface PrintExportStartRequest {
  readonly model: unknown;
  readonly profile: unknown;
  readonly options: ThreeMfExportOptions;
}

export interface PrintCalibrationStartRequest {
  readonly profile: unknown;
}

export interface PrintExportIdleState {
  readonly status: "idle";
}

export interface PrintExportBusyState {
  readonly status: "busy";
  readonly jobId: number;
  readonly progress?: Omit<PrintExportProgressResponse, "type" | "jobId">;
  readonly preflight?: ThreeMfExportPreflight;
}

export interface PrintExportReadyState {
  readonly status: "ready";
  readonly jobId: number;
  readonly preflight: ThreeMfExportPreflight;
  readonly threeMfBytes: ArrayBuffer;
  readonly legendBytes?: ArrayBuffer;
}

export interface PrintCalibrationReadyState {
  readonly status: "calibration-ready";
  readonly jobId: number;
  readonly preflight: CalibrationPreflight;
  readonly threeMfBytes: ArrayBuffer;
  readonly manifestBytes: ArrayBuffer;
}

export interface PrintExportFailedState {
  readonly status: "failed";
  readonly jobId: number;
  readonly error: PrintExportFailure;
  readonly preflight?: ThreeMfExportPreflight;
}

export type PrintExportControllerState =
  | PrintExportIdleState
  | PrintExportBusyState
  | PrintExportReadyState
  | PrintCalibrationReadyState
  | PrintExportFailedState;

export interface PrintExportControllerCallbacks {
  readonly onStateChange?: (state: PrintExportControllerState) => void;
  readonly watchdogMs?: number;
  readonly scheduleWatchdog?: (
    callback: () => void,
    milliseconds: number,
  ) => unknown;
  readonly clearWatchdog?: (handle: unknown) => void;
}

interface ActiveWorker {
  readonly jobId: number;
  readonly kind: "city" | "calibration";
  readonly worker: PrintExportWorkerLike;
  watchdogHandle?: unknown;
}

const IDLE_STATE: PrintExportIdleState = Object.freeze({ status: "idle" });

function protocolFailure(message: string): PrintExportFailure {
  return {
    kind: "protocol",
    name: "PrintExportProtocolError",
    message,
    issues: [],
  };
}

export class PrintExportController {
  private readonly workerFactory: PrintExportWorkerFactory;
  private readonly onStateChange:
    | ((state: PrintExportControllerState) => void)
    | undefined;
  private readonly watchdogMs: number;
  private readonly scheduleWatchdog: (
    callback: () => void,
    milliseconds: number,
  ) => unknown;
  private readonly clearWatchdog: (handle: unknown) => void;
  private nextJobId = 0;
  private active: ActiveWorker | undefined;
  private currentState: PrintExportControllerState = IDLE_STATE;
  private disposed = false;

  public constructor(
    workerFactory: PrintExportWorkerFactory,
    callbacks: PrintExportControllerCallbacks = {},
  ) {
    this.workerFactory = workerFactory;
    this.onStateChange = callbacks.onStateChange;
    this.watchdogMs =
      callbacks.watchdogMs ?? PRINT_EXPORT_WATCHDOG_MS;
    if (!Number.isSafeInteger(this.watchdogMs) || this.watchdogMs <= 0) {
      throw new TypeError(
        "The print export watchdog must be a positive integer.",
      );
    }
    this.scheduleWatchdog =
      callbacks.scheduleWatchdog ??
      ((callback, milliseconds) =>
        globalThis.setTimeout(callback, milliseconds));
    this.clearWatchdog =
      callbacks.clearWatchdog ??
      ((handle) => globalThis.clearTimeout(handle as number));
  }

  public get state(): PrintExportControllerState {
    return this.currentState;
  }

  public start(request: PrintExportStartRequest): number {
    return this.startWorker("city", (jobId): PrintExportGenerateRequest => ({
      type: "generate",
      jobId,
      model: request.model,
      profile: request.profile,
      options: request.options,
    }));
  }

  public startCalibration(request: PrintCalibrationStartRequest): number {
    return this.startWorker(
      "calibration",
      (jobId): PrintCalibrationGenerateRequest => ({
        type: "calibrate",
        jobId,
        profile: request.profile,
      }),
    );
  }

  private startWorker(
    kind: ActiveWorker["kind"],
    createRequest: (jobId: number) => PrintExportWorkerRequest,
  ): number {
    if (this.disposed) {
      throw new Error("The print export controller has been disposed.");
    }
    this.stopActiveWorker();
    const jobId = this.nextJobId + 1;
    this.nextJobId = jobId;

    let worker: PrintExportWorkerLike;
    try {
      worker = this.workerFactory();
    } catch (error) {
      this.updateState({
        status: "failed",
        jobId,
        error: serializePrintExportError(error),
      });
      return jobId;
    }

    this.active = { jobId, kind, worker };
    worker.onmessage = (event) => {
      this.receive(worker, jobId, event.data);
    };
    worker.onerror = (event) => {
      event.preventDefault();
      this.fail(
        worker,
        jobId,
        serializePrintExportError(
          new Error(event.message || "The 3MF export worker failed."),
        ),
      );
    };
    worker.onmessageerror = () => {
      this.fail(
        worker,
        jobId,
        protocolFailure("The 3MF export worker returned unreadable data."),
      );
    };
    this.updateState({ status: "busy", jobId });

    if (!this.isCurrent(worker, jobId)) return jobId;
    this.armWatchdog(worker, jobId);
    if (!this.isCurrent(worker, jobId)) return jobId;
    try {
      worker.postMessage(createRequest(jobId));
    } catch (error) {
      this.fail(worker, jobId, serializePrintExportError(error));
    }
    return jobId;
  }

  public cancel(): void {
    this.stopActiveWorker();
    if (this.currentState.status !== "idle") {
      this.updateState(IDLE_STATE);
    }
  }

  public reset(): void {
    this.cancel();
  }

  public dispose(): void {
    if (this.disposed) return;
    this.stopActiveWorker();
    this.disposed = true;
    if (this.currentState.status !== "idle") {
      this.updateState(IDLE_STATE);
    }
  }

  private receive(
    worker: PrintExportWorkerLike,
    jobId: number,
    value: unknown,
  ): void {
    if (!this.isCurrent(worker, jobId)) return;
    if (!isPrintExportWorkerResponse(value)) {
      this.fail(
        worker,
        jobId,
        protocolFailure("The 3MF export worker returned an invalid message."),
      );
      return;
    }
    if (value.jobId !== jobId) return;
    const kind = this.active!.kind;

    switch (value.type) {
      case "progress": {
        const state = this.busyState(jobId);
        this.updateState({
          status: "busy",
          jobId,
          progress: {
            phase: value.phase,
            completed: value.completed,
            message: value.message,
          },
          ...(state?.preflight === undefined
            ? {}
            : { preflight: state.preflight }),
        });
        break;
      }
      case "preflight": {
        if (kind !== "city") {
          this.fail(
            worker,
            jobId,
            protocolFailure(
              "The calibration worker returned a city preflight.",
            ),
          );
          break;
        }
        const state = this.busyState(jobId);
        this.updateState({
          status: "busy",
          jobId,
          preflight: value.preflight,
          ...(state?.progress === undefined
            ? {}
            : { progress: state.progress }),
        });
        break;
      }
      case "result":
        if (kind !== "city") {
          this.fail(
            worker,
            jobId,
            protocolFailure(
              "The calibration worker returned a city export.",
            ),
          );
          break;
        }
        this.finishWorker(worker, jobId);
        this.updateState({
          status: "ready",
          jobId,
          preflight: value.preflight,
          threeMfBytes: value.threeMfBytes,
          ...(value.legendBytes === undefined
            ? {}
            : { legendBytes: value.legendBytes }),
        });
        break;
      case "calibration-result":
        if (kind !== "calibration") {
          this.fail(
            worker,
            jobId,
            protocolFailure(
              "The city worker returned a calibration export.",
            ),
          );
          break;
        }
        this.finishWorker(worker, jobId);
        this.updateState({
          status: "calibration-ready",
          jobId,
          preflight: value.preflight,
          threeMfBytes: value.threeMfBytes,
          manifestBytes: value.manifestBytes,
        });
        break;
      case "failure": {
        const state = this.busyState(jobId);
        this.finishWorker(worker, jobId);
        this.updateState({
          status: "failed",
          jobId,
          error: value.error,
          ...(state?.preflight === undefined
            ? {}
            : { preflight: state.preflight }),
        });
        break;
      }
    }
  }

  private busyState(jobId: number): PrintExportBusyState | undefined {
    return this.currentState.status === "busy" &&
      this.currentState.jobId === jobId
      ? this.currentState
      : undefined;
  }

  private fail(
    worker: PrintExportWorkerLike,
    jobId: number,
    error: PrintExportFailure,
  ): void {
    if (!this.isCurrent(worker, jobId)) return;
    const state = this.busyState(jobId);
    this.finishWorker(worker, jobId);
    this.updateState({
      status: "failed",
      jobId,
      error,
      ...(state?.preflight === undefined
        ? {}
        : { preflight: state.preflight }),
    });
  }

  private isCurrent(
    worker: PrintExportWorkerLike,
    jobId: number,
  ): boolean {
    return (
      this.active?.worker === worker && this.active.jobId === jobId
    );
  }

  private finishWorker(
    worker: PrintExportWorkerLike,
    jobId: number,
  ): void {
    if (!this.isCurrent(worker, jobId)) return;
    const active = this.active!;
    this.active = undefined;
    this.clearActiveWatchdog(active);
    this.detachAndTerminate(worker);
  }

  private stopActiveWorker(): void {
    const active = this.active;
    this.active = undefined;
    if (active !== undefined) {
      this.clearActiveWatchdog(active);
      this.detachAndTerminate(active.worker);
    }
  }

  private armWatchdog(
    worker: PrintExportWorkerLike,
    jobId: number,
  ): void {
    const active = this.active;
    if (
      active === undefined ||
      active.worker !== worker ||
      active.jobId !== jobId
    ) {
      return;
    }
    try {
      const handle = this.scheduleWatchdog(() => {
        this.fail(
          worker,
          jobId,
          {
            kind: "unexpected",
            name: "PrintExportTimeoutError",
            message:
              `The 3MF export exceeded the ${this.watchdogMs.toLocaleString(
                "en-US",
              )} ms browser limit.`,
            issues: [],
          },
        );
      }, this.watchdogMs);
      if (this.isCurrent(worker, jobId)) {
        active.watchdogHandle = handle;
      } else {
        this.tryClearWatchdog(handle);
      }
    } catch (error) {
      this.fail(worker, jobId, serializePrintExportError(error));
    }
  }

  private clearActiveWatchdog(active: ActiveWorker): void {
    if (active.watchdogHandle === undefined) return;
    const handle = active.watchdogHandle;
    active.watchdogHandle = undefined;
    this.tryClearWatchdog(handle);
  }

  private tryClearWatchdog(handle: unknown): void {
    try {
      this.clearWatchdog(handle);
    } catch {
      // Worker termination remains the authoritative cleanup boundary.
    }
  }

  private detachAndTerminate(worker: PrintExportWorkerLike): void {
    worker.onmessage = null;
    worker.onerror = null;
    worker.onmessageerror = null;
    try {
      worker.terminate();
    } catch {
      // A worker that has already stopped is still fully cleaned up.
    }
  }

  private updateState(state: PrintExportControllerState): void {
    this.currentState = state;
    this.onStateChange?.(state);
  }
}
