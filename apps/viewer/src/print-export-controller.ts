import {
  PRINT_FIDELITY_EPSILON,
} from "../../../packages/core/src/print-layout.js";
import {
  isPrintExportWorkerResponse,
  normalizePrintExportPreviewSource,
  serializePrintExportError,
  type PrintCalibrationGenerateRequest,
  type PrintExportGenerateOptions,
  type PrintExportFailure,
  type PrintExportGenerateRequest,
  type PrintPlateBundleResultResponse,
  type PrintExportProgressResponse,
  type PrintExportTransferArtifact,
  type PrintExportWorkerRequest,
  type PrintExportWorkerResponse,
} from "./print-export-protocol.js";
import type {
  CalibrationPrintExportPreflight,
} from "../../../packages/exporter/src/calibration.js";
import type {
  PrintPlateBundlePreflight,
} from "../../../packages/exporter/src/print-plates.js";
import type { PrintLayoutPreviewPlan } from "./print-plate-preview.js";

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
  readonly format: "3mf" | "stl";
  readonly model: unknown;
  readonly profile: unknown;
  readonly options: PrintExportGenerateOptions;
}

export interface PrintCalibrationStartRequest {
  readonly format: "3mf" | "stl";
  readonly profile: unknown;
}

export interface PrintExportIdleState {
  readonly status: "idle";
}

export interface PrintExportBusyState {
  readonly status: "busy";
  readonly jobId: number;
  readonly progress?: Omit<PrintExportProgressResponse, "type" | "jobId">;
  readonly preflight?: PrintPlateBundlePreflight;
  readonly preview?: PrintLayoutPreviewPlan;
  readonly bundlePreflight?: PrintPlateBundlePreflight;
  readonly bundlePreview?: PrintLayoutPreviewPlan;
}

export interface PrintExportReadyState {
  readonly status: "ready";
  readonly jobId: number;
  readonly preflight: PrintPlateBundlePreflight;
  readonly preview: PrintLayoutPreviewPlan;
  readonly artifact: PrintExportTransferArtifact;
  readonly manifestBytes: ArrayBuffer;
  readonly legendBytes?: ArrayBuffer;
}

export interface PrintCalibrationReadyState {
  readonly status: "calibration-ready";
  readonly jobId: number;
  readonly preflight: CalibrationPrintExportPreflight;
  readonly artifact: PrintExportTransferArtifact;
  readonly manifestBytes: ArrayBuffer;
}

export interface PrintPlateBundleReadyState {
  readonly status: "bundle-ready";
  readonly jobId: number;
  readonly preflight: PrintPlateBundlePreflight;
  readonly preview: PrintLayoutPreviewPlan;
  readonly artifact: PrintPlateBundleResultResponse["artifact"];
  readonly manifestBytes: ArrayBuffer;
  readonly legendBytes?: ArrayBuffer;
}

export interface PrintExportFailedState {
  readonly status: "failed";
  readonly jobId: number;
  readonly error: PrintExportFailure;
  readonly preflight?: PrintPlateBundlePreflight;
  readonly preview?: PrintLayoutPreviewPlan;
  readonly bundlePreflight?: PrintPlateBundlePreflight;
  readonly bundlePreview?: PrintLayoutPreviewPlan;
}

export interface PrintExportConfirmationRequiredState {
  readonly status: "confirmation-required";
  readonly jobId: number;
  readonly preflight: PrintPlateBundlePreflight;
  readonly preview: PrintLayoutPreviewPlan;
}

export type PrintExportControllerState =
  | PrintExportIdleState
  | PrintExportBusyState
  | PrintExportReadyState
  | PrintPlateBundleReadyState
  | PrintCalibrationReadyState
  | PrintExportConfirmationRequiredState
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
  output: "pending" | "single" | "bundle" | "calibration";
  readonly format: "3mf" | "stl";
  readonly requestFingerprint?: PrintExportRequestFingerprint;
  readonly startRequest?: PrintExportStartRequest;
  readonly worker: PrintExportWorkerLike;
  watchdogHandle?: unknown;
}

interface PrintExportRequestFingerprint {
  readonly format: "3mf" | "stl";
  readonly fitPolicy: "auto" | "error" | "scale" | "tile";
  readonly confirmCompactFit: boolean;
  readonly scale: number;
  readonly acknowledgeBelowProfileScale: boolean;
  readonly maximumPlateCount?: number;
  readonly routePolicy: PrintExportGenerateOptions["routePolicy"];
  readonly labelPolicy: PrintExportGenerateOptions["labelPolicy"];
  readonly includeLegend: boolean;
  readonly profileId?: string;
  readonly profileName?: string;
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

function sameScale(left: number, right: number): boolean {
  return Math.abs(left - right) <= PRINT_FIDELITY_EPSILON;
}

function profileField(
  profile: unknown,
  field: "id" | "name",
): string | undefined {
  if (typeof profile !== "object" || profile === null) return undefined;
  const value = (profile as Record<string, unknown>)[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requestFingerprint(
  request: PrintExportStartRequest,
): PrintExportRequestFingerprint {
  const profileId = profileField(request.profile, "id");
  const profileName = profileField(request.profile, "name");
  return Object.freeze({
    format: request.format,
    fitPolicy: request.options.fitPolicy ?? "auto",
    confirmCompactFit: request.options.confirmCompactFit ?? false,
    scale: request.options.scale,
    acknowledgeBelowProfileScale:
      request.options.acknowledgeBelowProfileScale ?? false,
    ...(request.options.maximumPlateCount === undefined
      ? {}
      : { maximumPlateCount: request.options.maximumPlateCount }),
    routePolicy: request.options.routePolicy,
    labelPolicy: request.options.labelPolicy,
    includeLegend: request.options.includeLegend,
    ...(profileId === undefined ? {} : { profileId }),
    ...(profileName === undefined ? {} : { profileName }),
  });
}

function preflightMatchesRequest(
  preflight: PrintPlateBundlePreflight,
  fingerprint: PrintExportRequestFingerprint,
  allowUnconfirmedCompactProposal = false,
): boolean {
  const labelsDisabled =
    fingerprint.labelPolicy === "off" &&
    (preflight.labels.printedBuildings !== 0 ||
      preflight.labels.printedDistricts !== 0);
  return (
    preflight.format === fingerprint.format &&
    (fingerprint.fitPolicy === "auto" ||
      preflight.fitPolicy === fingerprint.fitPolicy) &&
    sameScale(preflight.requestedScale, fingerprint.scale) &&
    preflight.belowProfileScaleAcknowledged ===
      (fingerprint.fitPolicy === "auto" &&
      preflight.featureViolations.length > 0 &&
      (fingerprint.confirmCompactFit || allowUnconfirmedCompactProposal)
        ? true
        : fingerprint.acknowledgeBelowProfileScale) &&
    preflight.routes.policy === fingerprint.routePolicy &&
    preflight.legendIncluded === fingerprint.includeLegend &&
    !labelsDisabled &&
    (fingerprint.maximumPlateCount === undefined ||
      preflight.plateCount <= fingerprint.maximumPlateCount) &&
    (fingerprint.profileId === undefined ||
      preflight.profileId === fingerprint.profileId) &&
    (fingerprint.profileName === undefined ||
      preflight.profileName === fingerprint.profileName)
  );
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
  private compactConfirmationRequest: PrintExportStartRequest | undefined;
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
    this.compactConfirmationRequest = undefined;
    const fingerprint = requestFingerprint(request);
    return this.startWorker(
      "city",
      "pending",
      request.format,
      fingerprint,
      request,
      (jobId): PrintExportGenerateRequest => ({
        type: "generate",
        jobId,
        format: request.format,
        model: request.model,
        profile: request.profile,
        options: request.options,
      }),
    );
  }

  public startCalibration(request: PrintCalibrationStartRequest): number {
    return this.startWorker(
      "calibration",
      "calibration",
      request.format,
      undefined,
      undefined,
      (jobId): PrintCalibrationGenerateRequest => ({
        type: "calibrate",
        jobId,
        format: request.format,
        profile: request.profile,
      }),
    );
  }

  private startWorker(
    kind: ActiveWorker["kind"],
    output: ActiveWorker["output"],
    format: ActiveWorker["format"],
    fingerprint: PrintExportRequestFingerprint | undefined,
    startRequest: PrintExportStartRequest | undefined,
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

    this.active = {
      jobId,
      kind,
      output,
      format,
      worker,
      ...(fingerprint === undefined
        ? {}
        : { requestFingerprint: fingerprint }),
      ...(startRequest === undefined ? {} : { startRequest }),
    };
    worker.onmessage = (event) => {
      this.receive(worker, jobId, event.data);
    };
    worker.onerror = (event) => {
      event.preventDefault();
      this.fail(
        worker,
        jobId,
        serializePrintExportError(
          new Error(event.message || "The print export worker failed."),
        ),
      );
    };
    worker.onmessageerror = () => {
      this.fail(
        worker,
        jobId,
        protocolFailure("The print export worker returned unreadable data."),
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
    this.compactConfirmationRequest = undefined;
    if (this.currentState.status !== "idle") {
      this.updateState(IDLE_STATE);
    }
  }

  public reset(): void {
    this.cancel();
  }

  public confirmCompactFit(): number {
    const request = this.compactConfirmationRequest;
    if (
      this.currentState.status !== "confirmation-required" ||
      request === undefined
    ) {
      throw new Error("No compact print fit is awaiting confirmation.");
    }
    return this.start({
      ...request,
      options: {
        ...request.options,
        fitPolicy: "auto",
        confirmCompactFit: true,
      },
    });
  }

  public dispose(): void {
    if (this.disposed) return;
    this.stopActiveWorker();
    this.compactConfirmationRequest = undefined;
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
        protocolFailure("The print export worker returned an invalid message."),
      );
      return;
    }
    if (value.jobId !== jobId) return;
    const {
      kind,
      output,
      format,
      requestFingerprint: fingerprint,
      startRequest,
    } = this.active!;

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
          ...(state?.preview === undefined
            ? {}
            : { preview: state.preview }),
          ...(state?.bundlePreflight === undefined
            ? {}
            : { bundlePreflight: state.bundlePreflight }),
          ...(state?.bundlePreview === undefined
            ? {}
            : { bundlePreview: state.bundlePreview }),
        });
        break;
      }
      case "preflight": {
        const state = this.busyState(jobId);
        if (
          kind !== "city" ||
          (output !== "pending" && output !== "single")
        ) {
          this.fail(
            worker,
            jobId,
            protocolFailure(
              "The calibration worker returned a city preflight.",
            ),
          );
          break;
        }
        const preview = normalizePrintExportPreviewSource(value.preview);
        if (
          fingerprint === undefined ||
          !preflightMatchesRequest(value.preflight, fingerprint) ||
          preview === undefined ||
          preview.requestedPolicy !== fingerprint.fitPolicy ||
          !sameScale(preview.requestedScale, fingerprint.scale) ||
          state?.preflight !== undefined ||
          state?.bundlePreflight !== undefined
        ) {
          this.fail(
            worker,
            jobId,
            protocolFailure(
              "The print worker returned preflight for another export request.",
            ),
          );
          break;
        }
        this.active!.output = "single";
        this.updateState({
          status: "busy",
          jobId,
          preflight: value.preflight,
          preview,
          ...(state?.progress === undefined
            ? {}
            : { progress: state.progress }),
        });
        break;
      }
      case "bundle-preflight": {
        const state = this.busyState(jobId);
        if (
          kind !== "city" ||
          (output !== "pending" && output !== "bundle")
        ) {
          this.fail(
            worker,
            jobId,
            protocolFailure(
              "The calibration worker returned a city bundle preflight.",
            ),
          );
          break;
        }
        const preview = normalizePrintExportPreviewSource(value.preview);
        if (
          fingerprint === undefined ||
          !preflightMatchesRequest(value.preflight, fingerprint) ||
          preview === undefined ||
          preview.requestedPolicy !== fingerprint.fitPolicy ||
          !sameScale(preview.requestedScale, fingerprint.scale) ||
          state?.preflight !== undefined ||
          state?.bundlePreflight !== undefined
        ) {
          this.fail(
            worker,
            jobId,
            protocolFailure(
              "The print worker returned a bundle for another export request.",
            ),
          );
          break;
        }
        this.active!.output = "bundle";
        this.updateState({
          status: "busy",
          jobId,
          bundlePreflight: value.preflight,
          bundlePreview: preview,
          ...(state?.progress === undefined
            ? {}
            : { progress: state.progress }),
        });
        break;
      }
      case "confirmation-required": {
        const state = this.busyState(jobId);
        const preview = normalizePrintExportPreviewSource(value.preview);
        if (
          kind !== "city" ||
          output !== "pending" ||
          fingerprint === undefined ||
          fingerprint.fitPolicy !== "auto" ||
          fingerprint.confirmCompactFit ||
          startRequest === undefined ||
          !preflightMatchesRequest(value.preflight, fingerprint, true) ||
          preview === undefined ||
          preview.requestedPolicy !== "auto" ||
          !sameScale(preview.requestedScale, fingerprint.scale) ||
          state?.preflight !== undefined ||
          state?.bundlePreflight !== undefined
        ) {
          this.fail(
            worker,
            jobId,
            protocolFailure(
              "The print worker returned a compact fit for another export request.",
            ),
          );
          break;
        }
        this.finishWorker(worker, jobId);
        this.compactConfirmationRequest = startRequest;
        this.updateState({
          status: "confirmation-required",
          jobId,
          preflight: value.preflight,
          preview,
        });
        break;
      }
      case "result":
        if (kind !== "city" || output !== "single") {
          this.fail(
            worker,
            jobId,
            protocolFailure(
              "The calibration worker returned a city export.",
            ),
          );
          break;
        }
        const singleState = this.busyState(jobId);
        if (
          singleState?.preflight === undefined ||
          singleState.preview === undefined ||
          singleState.preflight.format !== format ||
          value.artifact.format !== format ||
          (value.legendBytes !== undefined) !==
            singleState.preflight.legendIncluded
        ) {
          this.fail(
            worker,
            jobId,
            protocolFailure(
              "The print worker returned an export without matching preflight.",
            ),
          );
          break;
        }
        this.finishWorker(worker, jobId);
        this.updateState({
          status: "ready",
          jobId,
          preflight: singleState.preflight,
          preview: singleState.preview,
          artifact: value.artifact,
          manifestBytes: value.manifestBytes,
          ...(value.legendBytes === undefined
            ? {}
            : { legendBytes: value.legendBytes }),
        });
        break;
      case "bundle-result":
        if (kind !== "city" || output !== "bundle") {
          this.fail(
            worker,
            jobId,
            protocolFailure(
              "The calibration worker returned a city bundle export.",
            ),
          );
          break;
        }
        const bundleState = this.busyState(jobId);
        if (
          bundleState?.bundlePreflight === undefined ||
          bundleState.bundlePreview === undefined ||
          bundleState.bundlePreflight.format !== format ||
          (value.legendBytes !== undefined) !==
            bundleState.bundlePreflight.legendIncluded
        ) {
          this.fail(
            worker,
            jobId,
            protocolFailure(
              "The print worker returned a bundle without matching preflight.",
            ),
          );
          break;
        }
        this.finishWorker(worker, jobId);
        this.updateState({
          status: "bundle-ready",
          jobId,
          preflight: bundleState.bundlePreflight,
          preview: bundleState.bundlePreview,
          artifact: value.artifact,
          manifestBytes: value.manifestBytes,
          ...(value.legendBytes === undefined
            ? {}
            : { legendBytes: value.legendBytes }),
        });
        break;
      case "calibration-result":
        if (kind !== "calibration" || output !== "calibration") {
          this.fail(
            worker,
            jobId,
            protocolFailure(
              "The city worker returned a calibration export.",
            ),
          );
          break;
        }
        if (value.artifact.format !== format) {
          this.fail(
            worker,
            jobId,
            protocolFailure(
              "The calibration worker returned an unexpected artifact format.",
            ),
          );
          break;
        }
        this.finishWorker(worker, jobId);
        this.updateState({
          status: "calibration-ready",
          jobId,
          preflight: value.preflight,
          artifact: value.artifact,
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
          ...(state?.preview === undefined
            ? {}
            : { preview: state.preview }),
          ...(state?.bundlePreflight === undefined
            ? {}
            : { bundlePreflight: state.bundlePreflight }),
          ...(state?.bundlePreview === undefined
            ? {}
            : { bundlePreview: state.bundlePreview }),
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
      ...(state?.preview === undefined
        ? {}
        : { preview: state.preview }),
      ...(state?.bundlePreflight === undefined
        ? {}
        : { bundlePreflight: state.bundlePreflight }),
      ...(state?.bundlePreview === undefined
        ? {}
        : { bundlePreview: state.bundlePreview }),
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
              `The print export exceeded the ${this.watchdogMs.toLocaleString(
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
