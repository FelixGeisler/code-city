import type { CityModel } from "../../../packages/core/src/model.js";

import {
  IMPORT_JOB_ID_PATTERN,
  ImportApiError,
  type ImportAuthorizationStatus,
  type ImportCredentialProfile,
  type ImportFieldError,
  type ImportJob,
  type ImportUploadReservation,
  type RemoteImportSubmission,
  type UploadImportSubmission,
} from "./import-api.js";
import {
  assetRootFromResponseUrl,
  ViewerLoadError,
  type ViewerLoadGateway,
} from "./model-source.js";
import { validateCityModel } from "./model-validation.js";

export const IMPORT_JOB_STORAGE_KEY = "code-city.last-import-job.v1";
export const IMPORT_JOB_POLL_INTERVAL_MS = 750;
const IMPORT_JOB_MAXIMUM_RETRY_MS = 10_000;

export interface ViewerImportApi {
  authorizationStatus(signal?: AbortSignal): Promise<ImportAuthorizationStatus>;
  createSession(token: string, signal?: AbortSignal): Promise<void>;
  logout(signal?: AbortSignal): Promise<void>;
  capabilities(
    signal?: AbortSignal,
  ): Promise<readonly ImportCredentialProfile[]>;
  createRemoteImport(
    request: RemoteImportSubmission,
    signal?: AbortSignal,
  ): Promise<ImportJob>;
  reserveUpload(
    request: UploadImportSubmission,
    signal?: AbortSignal,
  ): Promise<ImportUploadReservation>;
  upload(
    reservation: ImportUploadReservation,
    body: Blob,
    signal?: AbortSignal,
  ): Promise<ImportJob>;
  abandonUpload(
    reservation: ImportUploadReservation,
    signal?: AbortSignal,
  ): Promise<void>;
  getJob(id: string, signal?: AbortSignal): Promise<ImportJob>;
  cancelJob(id: string, signal?: AbortSignal): Promise<ImportJob>;
  removeCompletedJob(
    id: string,
    signal?: AbortSignal,
  ): Promise<ImportJob & { readonly state: "completed" }>;
}

export interface ImportJobStorage {
  read(): string | undefined;
  write(id: string): boolean;
  clear(): void;
}

export class LocalImportJobStorage implements ImportJobStorage {
  public constructor(
    private readonly storage: Pick<
      Storage,
      "getItem" | "setItem" | "removeItem"
    >,
  ) {}

  public read(): string | undefined {
    try {
      const value = this.storage.getItem(IMPORT_JOB_STORAGE_KEY);
      if (value === null) return undefined;
      if (!IMPORT_JOB_ID_PATTERN.test(value)) {
        this.storage.removeItem(IMPORT_JOB_STORAGE_KEY);
        return undefined;
      }
      return value;
    } catch {
      return undefined;
    }
  }

  public write(id: string): boolean {
    if (!IMPORT_JOB_ID_PATTERN.test(id)) return false;
    try {
      this.storage.setItem(IMPORT_JOB_STORAGE_KEY, id);
      return true;
    } catch {
      return false;
    }
  }

  public clear(): void {
    try {
      this.storage.removeItem(IMPORT_JOB_STORAGE_KEY);
    } catch {
      // Storage is an optional recovery aid, never an import prerequisite.
    }
  }
}

class VolatileImportJobStorage implements ImportJobStorage {
  public read(): undefined {
    return undefined;
  }

  public write(_id: string): boolean {
    return false;
  }

  public clear(): void {}
}

function defaultStorage(): ImportJobStorage {
  try {
    return new LocalImportJobStorage(globalThis.localStorage);
  } catch {
    return new VolatileImportJobStorage();
  }
}

export interface ImportedCityModelSource {
  readonly label: string;
  readonly responseUrl: URL;
  readonly assetRoot: URL;
  readonly jobId: string;
}

export type ImportPreparationPhase =
  | "reserving-upload"
  | "submitting-import"
  | "uploading";

export type ImportControllerState =
  | {
      readonly status: "initializing";
    }
  | {
      readonly status: "authorization-required";
      readonly resumeJobId?: string;
      readonly message?: string;
    }
  | {
      readonly status: "idle";
      readonly authorization: ImportAuthorizationStatus;
      readonly profiles: readonly ImportCredentialProfile[];
      readonly persistenceAvailable: boolean;
    }
  | {
      readonly status: "preparing";
      readonly phase: ImportPreparationPhase;
      readonly cancelling: boolean;
    }
  | {
      readonly status: "job";
      readonly job: ImportJob;
      readonly cancelling: boolean;
      readonly persistenceAvailable: boolean;
    }
  | {
      readonly status: "recovering";
      readonly jobId: string;
      readonly job?: ImportJob;
      readonly message: string;
      readonly retryAt: number;
      readonly persistenceAvailable: boolean;
    }
  | {
      readonly status: "request-failed";
      readonly message: string;
      readonly fields: readonly ImportFieldError[];
      readonly retryable: boolean;
    }
  | {
      readonly status: "terminal";
      readonly job: ImportJob & {
        readonly state: "failed" | "cancelled";
      };
      readonly persistenceAvailable: boolean;
    }
  | {
      readonly status: "artifact-failed";
      readonly job: ImportJob & {
        readonly state: "completed";
      };
      readonly message: string;
      readonly persistenceAvailable: boolean;
    }
  | {
      readonly status: "opening-artifact";
      readonly job: ImportJob & {
        readonly state: "completed";
      };
      readonly persistenceAvailable: boolean;
    }
  | {
      readonly status: "completed";
      readonly job: ImportJob & {
        readonly state: "completed";
      };
      readonly persistenceAvailable: boolean;
    }
  | {
      readonly status: "removing-result";
      readonly job: ImportJob & {
        readonly state: "completed";
      };
      readonly persistenceAvailable: boolean;
    }
  | {
      readonly status: "removal-failed";
      readonly job: ImportJob & {
        readonly state: "completed";
      };
      readonly message: string;
      readonly persistenceAvailable: boolean;
    }
  | {
      readonly status: "unavailable";
      readonly message: string;
    }
  | {
      readonly status: "signing-out";
    }
  | {
      readonly status: "sign-out-failed";
      readonly message: string;
    };

export interface ImportControllerOptions {
  readonly api: ViewerImportApi;
  readonly loadGateway: ViewerLoadGateway;
  readonly viewerUrl: URL;
  readonly storage?: ImportJobStorage;
  readonly onStateChange?: (state: ImportControllerState) => void;
  readonly onModelReady: (
    model: CityModel,
    source: ImportedCityModelSource,
  ) => void | Promise<void>;
  readonly onSignedOut?: () => void | Promise<void>;
  readonly pollIntervalMs?: number;
  readonly now?: () => number;
  readonly schedulePoll?: (
    callback: () => void,
    milliseconds: number,
  ) => unknown;
  readonly clearPoll?: (handle: unknown) => void;
}

const INITIAL_STATE: ImportControllerState = Object.freeze({
  status: "initializing",
});

function isCompletedJob(
  job: ImportJob,
): job is ImportJob & { readonly state: "completed" } {
  return job.state === "completed";
}

function isFailedJob(
  job: ImportJob,
): job is ImportJob & {
  readonly state: "failed" | "cancelled";
} {
  return job.state === "failed" || job.state === "cancelled";
}

function messageOf(error: unknown): string {
  if (error instanceof ImportApiError || error instanceof ViewerLoadError) {
    return error.message;
  }
  return "The import could not be completed.";
}

function fieldErrors(error: unknown): readonly ImportFieldError[] {
  return error instanceof ImportApiError
    ? (error.details.fields ?? Object.freeze([]))
    : Object.freeze([]);
}

function isAuthorizationFailure(error: unknown): boolean {
  return (
    error instanceof ImportApiError &&
    error.kind === "http" &&
    error.details.status === 401
  );
}

function isMissingJob(error: unknown): boolean {
  return (
    error instanceof ImportApiError &&
    error.kind === "http" &&
    error.details.status === 404
  );
}

function retryable(error: unknown): boolean {
  return error instanceof ImportApiError && error.retryable;
}

type RetryAction = () => void;

export class ImportController {
  private readonly api: ViewerImportApi;
  private readonly loadGateway: ViewerLoadGateway;
  private readonly viewerUrl: URL;
  private readonly storage: ImportJobStorage;
  private readonly onStateChange:
    | ((state: ImportControllerState) => void)
    | undefined;
  private readonly onModelReady: ImportControllerOptions["onModelReady"];
  private readonly onSignedOut: ImportControllerOptions["onSignedOut"];
  private readonly pollIntervalMs: number;
  private readonly now: () => number;
  private readonly schedulePoll: (
    callback: () => void,
    milliseconds: number,
  ) => unknown;
  private readonly clearPoll: (handle: unknown) => void;

  private currentState: ImportControllerState = INITIAL_STATE;
  private authorization: ImportAuthorizationStatus | undefined;
  private profiles: readonly ImportCredentialProfile[] = Object.freeze([]);
  private persistenceAvailable = true;
  private activeJob: ImportJob | undefined;
  private reservation: ImportUploadReservation | undefined;
  private retryAction: RetryAction | undefined;
  private operation: AbortController | undefined;
  private pollHandle: unknown;
  private generation = 0;
  private recoveryFailures = 0;
  private acceptanceCancellationRequested = false;
  private cancellationRequestedJobId: string | undefined;
  private signOutAfterAcceptanceRequested = false;
  private disposed = false;

  public constructor(options: ImportControllerOptions) {
    this.api = options.api;
    this.loadGateway = options.loadGateway;
    this.viewerUrl = new URL(options.viewerUrl.href);
    if (
      (this.viewerUrl.protocol !== "http:" &&
        this.viewerUrl.protocol !== "https:") ||
      this.viewerUrl.username !== "" ||
      this.viewerUrl.password !== ""
    ) {
      throw new TypeError(
        "The import controller requires a credential-free HTTP(S) viewer URL.",
      );
    }
    this.storage = options.storage ?? defaultStorage();
    this.onStateChange = options.onStateChange;
    this.onModelReady = options.onModelReady;
    this.onSignedOut = options.onSignedOut;
    this.pollIntervalMs =
      options.pollIntervalMs ?? IMPORT_JOB_POLL_INTERVAL_MS;
    if (
      !Number.isSafeInteger(this.pollIntervalMs) ||
      this.pollIntervalMs <= 0
    ) {
      throw new TypeError(
        "The import polling interval must be a positive integer.",
      );
    }
    this.now = options.now ?? (() => Date.now());
    this.schedulePoll =
      options.schedulePoll ??
      ((callback, milliseconds) =>
        globalThis.setTimeout(callback, milliseconds));
    this.clearPoll =
      options.clearPoll ??
      ((handle) => globalThis.clearTimeout(handle as number));
  }

  public get state(): ImportControllerState {
    return this.currentState;
  }

  public get canSignOut(): boolean {
    return (
      this.authorization?.mode === "shared-secret" &&
      this.authorization.authenticated
    );
  }

  public initialize(): void {
    this.assertUsable();
    const { controller, generation } = this.beginOperation();
    this.updateState(INITIAL_STATE);
    void this.initializeOperation(controller, generation);
  }

  public authenticate(token: string): void {
    this.assertUsable();
    const { controller, generation } = this.beginOperation();
    this.updateState(INITIAL_STATE);
    void this.api.createSession(token, controller.signal).then(
      () => {
        if (!this.isCurrent(controller, generation)) return;
        this.initialize();
      },
      (error: unknown) => {
        if (!this.isCurrent(controller, generation)) return;
        this.enterAuthorizationRequired(messageOf(error));
      },
    );
  }

  public logout(): void {
    this.assertUsable();
    if (
      this.currentState.status === "signing-out" ||
      this.currentState.status === "removing-result"
    ) {
      return;
    }
    if (this.currentState.status === "preparing") {
      this.acceptanceCancellationRequested = false;
      this.signOutAfterAcceptanceRequested = true;
      this.clearLocalSessionForSignOut();
      return;
    }
    const reservation = this.reservation;
    const cancellableJobId =
      this.activeJob !== undefined &&
      (this.activeJob.state === "queued" ||
        this.activeJob.state === "running")
        ? this.activeJob.id
        : this.currentState.status === "recovering"
          ? this.currentState.jobId
          : undefined;
    const { controller, generation } = this.beginOperation();
    this.cancellationRequestedJobId = undefined;
    this.activeJob = undefined;
    this.reservation = undefined;
    this.clearLocalSessionForSignOut();
    void this.finishLogout(
      reservation,
      cancellableJobId,
      controller,
      generation,
    );
  }

  private clearLocalSessionForSignOut(): void {
    this.cancellationRequestedJobId = undefined;
    this.authorization = undefined;
    this.profiles = Object.freeze([]);
    this.storage.clear();
    this.retryAction = () => this.logout();
    this.updateState({ status: "signing-out" });
    try {
      void Promise.resolve(this.onSignedOut?.()).catch(() => undefined);
    } catch {
      // Revoking the server session must not depend on viewer cleanup.
    }
  }

  public startRemote(request: RemoteImportSubmission): void {
    this.assertReadyForSubmission();
    this.activeJob = undefined;
    this.cancellationRequestedJobId = undefined;
    this.retryAction = () => this.startRemote(request);
    const { controller, generation } = this.beginOperation();
    this.updateState({
      status: "preparing",
      phase: "submitting-import",
      cancelling: false,
    });
    void this.api.createRemoteImport(request, controller.signal).then(
      (job) => {
        if (!this.isCurrent(controller, generation)) return;
        if (this.takeSignOutAfterAcceptanceRequest()) {
          void this.finishLogout(
            undefined,
            job.state === "queued" || job.state === "running"
              ? job.id
              : undefined,
            controller,
            generation,
          );
          return;
        }
        this.retryAction = undefined;
        if (this.takeAcceptanceCancellationRequest()) {
          this.cancelAcceptedJob(job, controller, generation);
          return;
        }
        this.acceptJob(job, controller, generation);
      },
      (error: unknown) => {
        if (!this.isCurrent(controller, generation)) return;
        if (this.takeSignOutAfterAcceptanceRequest()) {
          void this.finishLogout(
            undefined,
            undefined,
            controller,
            generation,
          );
          return;
        }
        if (this.takeAcceptanceCancellationRequest()) {
          this.retryAction = undefined;
          this.updateIdle();
          return;
        }
        this.handleSubmissionFailure(error);
      },
    );
  }

  public startUpload(
    request: UploadImportSubmission,
    body: Blob,
  ): void {
    this.assertReadyForSubmission();
    if (!(body instanceof Blob) || body.size !== request.source.sizeBytes) {
      throw new TypeError(
        "Upload bytes must match the declared import size.",
      );
    }
    this.activeJob = undefined;
    this.cancellationRequestedJobId = undefined;
    this.retryAction = () => this.startUpload(request, body);
    const { controller, generation } = this.beginOperation();
    this.updateState({
      status: "preparing",
      phase: "reserving-upload",
      cancelling: false,
    });
    void this.reserveAndUpload(request, body, controller, generation);
  }

  public cancel(): void {
    this.assertUsable();
    if (
      this.currentState.status === "opening-artifact" ||
      this.currentState.status === "signing-out"
    ) {
      return;
    }
    if (this.currentState.status === "preparing") {
      this.retryAction = undefined;
      this.acceptanceCancellationRequested = true;
      if (!this.currentState.cancelling) {
        this.updateState({
          ...this.currentState,
          cancelling: true,
        });
      }
      return;
    }
    const reservation = this.reservation;
    const recoveryJobId =
      this.currentState.status === "recovering"
        ? this.currentState.jobId
        : undefined;
    const job = this.activeJob;
    const { controller, generation } = this.beginOperation();
    this.retryAction = undefined;
    if (reservation !== undefined && job === undefined) {
      this.reservation = undefined;
      this.updateIdle();
      const cleanup = new AbortController();
      void this.api
        .abandonUpload(reservation, cleanup.signal)
        .catch(() => undefined);
      return;
    }
    const cancellableJobId =
      job !== undefined &&
      (job.state === "queued" || job.state === "running")
        ? job.id
        : recoveryJobId;
    if (cancellableJobId !== undefined) {
      this.cancellationRequestedJobId = cancellableJobId;
      const displayedJob =
        job !== undefined &&
        (job.state === "queued" || job.state === "running")
          ? job
          : undefined;
      if (displayedJob === undefined) {
        this.updateState({
          status: "recovering",
          jobId: cancellableJobId,
          message: "Cancelling the saved import job…",
          retryAt: this.now(),
          persistenceAvailable: this.persistenceAvailable,
        });
      } else {
        this.updateState({
          status: "job",
          job: displayedJob,
          cancelling: true,
          persistenceAvailable: this.persistenceAvailable,
        });
      }
      void this.api.cancelJob(cancellableJobId, controller.signal).then(
        (cancelled) => {
          if (!this.isCurrent(controller, generation)) return;
          this.acceptJob(cancelled, controller, generation);
        },
        (error: unknown) => {
          if (!this.isCurrent(controller, generation)) return;
          if (isAuthorizationFailure(error)) {
            this.enterAuthorizationRequired(messageOf(error));
            return;
          }
          this.enterRecovery(
            cancellableJobId,
            error,
            controller,
            generation,
          );
        },
      );
      return;
    }
    this.cancellationRequestedJobId = undefined;
    this.updateIdle();
  }

  public retry(): void {
    this.assertUsable();
    const action = this.retryAction;
    if (action !== undefined) {
      action();
      return;
    }
    if (
      this.currentState.status === "artifact-failed" &&
      this.activeJob !== undefined &&
      isCompletedJob(this.activeJob)
    ) {
      const { controller, generation } = this.beginOperation();
      this.beginArtifactOpen(this.activeJob, controller, generation);
      return;
    }
    if (
      this.currentState.status === "recovering"
    ) {
      const jobId = this.currentState.jobId;
      const { controller, generation } = this.beginOperation();
      void this.pollJob(jobId, controller, generation);
    }
  }

  public forgetCompleted(): void {
    this.assertUsable();
    if (
      this.activeJob !== undefined &&
      (this.activeJob.state === "queued" ||
        this.activeJob.state === "running")
    ) {
      throw new Error("An active import job cannot be forgotten.");
    }
    this.beginOperation();
    this.activeJob = undefined;
    this.cancellationRequestedJobId = undefined;
    this.storage.clear();
    this.updateIdle();
  }

  public removeCompleted(): void {
    this.assertUsable();
    const job =
      this.activeJob !== undefined &&
      isCompletedJob(this.activeJob)
        ? this.activeJob
        : undefined;
    if (job === undefined) {
      throw new Error("No completed import result is available.");
    }
    const { controller, generation } = this.beginOperation();
    this.retryAction = () => this.removeCompleted();
    this.updateState({
      status: "removing-result",
      job,
      persistenceAvailable: this.persistenceAvailable,
    });
    void this.api.removeCompletedJob(job.id, controller.signal).then(
      () => {
        if (!this.isCurrent(controller, generation)) return;
        this.finishCompletedRemoval();
      },
      (error: unknown) => {
        if (!this.isCurrent(controller, generation)) return;
        if (isMissingJob(error)) {
          this.finishCompletedRemoval();
          return;
        }
        if (isAuthorizationFailure(error)) {
          this.enterAuthorizationRequired(messageOf(error), job.id);
          return;
        }
        this.updateState({
          status: "removal-failed",
          job,
          message: messageOf(error),
          persistenceAvailable: this.persistenceAvailable,
        });
      },
    );
  }

  private finishCompletedRemoval(): void {
    this.activeJob = undefined;
    this.cancellationRequestedJobId = undefined;
    this.retryAction = undefined;
    this.storage.clear();
    this.updateIdle();
  }

  public dispose(): void {
    if (this.disposed) return;
    const revokeSession =
      this.currentState.status === "signing-out" ||
      this.currentState.status === "sign-out-failed";
    this.disposed = true;
    this.generation += 1;
    this.operation?.abort();
    this.operation = undefined;
    this.clearScheduledPoll();
    this.reservation = undefined;
    this.retryAction = undefined;
    if (revokeSession) {
      void this.api.logout().catch(() => undefined);
    }
  }

  private async initializeOperation(
    controller: AbortController,
    generation: number,
  ): Promise<void> {
    try {
      const authorization = await this.api.authorizationStatus(
        controller.signal,
      );
      if (!this.isCurrent(controller, generation)) return;
      this.authorization = authorization;
      const resumeJobId = this.storage.read();
      if (authorization.required && !authorization.authenticated) {
        this.enterAuthorizationRequired(undefined, resumeJobId);
        return;
      }
      this.profiles = await this.api.capabilities(controller.signal);
      if (!this.isCurrent(controller, generation)) return;
      if (resumeJobId === undefined) {
        this.updateIdle();
        return;
      }
      await this.pollJob(resumeJobId, controller, generation);
    } catch (error) {
      if (!this.isCurrent(controller, generation)) return;
      if (isAuthorizationFailure(error)) {
        this.enterAuthorizationRequired(messageOf(error));
      } else {
        this.updateState({
          status: "unavailable",
          message: messageOf(error),
        });
      }
    }
  }

  private async finishLogout(
    reservation: ImportUploadReservation | undefined,
    cancellableJobId: string | undefined,
    controller: AbortController,
    generation: number,
  ): Promise<void> {
    try {
      await Promise.all([
        reservation === undefined
          ? Promise.resolve()
          : this.api
              .abandonUpload(reservation, controller.signal)
              .catch(() => undefined),
        cancellableJobId === undefined
          ? Promise.resolve()
          : this.api
              .cancelJob(cancellableJobId, controller.signal)
              .then(() => undefined)
              .catch(() => undefined),
      ]);
      if (!this.isCurrent(controller, generation)) return;
      await this.api.logout(controller.signal);
      if (!this.isCurrent(controller, generation)) return;
      this.signOutAfterAcceptanceRequested = false;
      this.retryAction = undefined;
      this.updateState({ status: "authorization-required" });
    } catch (error) {
      if (!this.isCurrent(controller, generation)) return;
      this.signOutAfterAcceptanceRequested = false;
      this.updateState({
        status: "sign-out-failed",
        message: messageOf(error),
      });
    }
  }

  private async reserveAndUpload(
    request: UploadImportSubmission,
    body: Blob,
    controller: AbortController,
    generation: number,
  ): Promise<void> {
    try {
      const reservation = await this.api.reserveUpload(
        request,
        controller.signal,
      );
      if (!this.isCurrent(controller, generation)) {
        void this.api.abandonUpload(reservation).catch(() => undefined);
        return;
      }
      if (this.takeSignOutAfterAcceptanceRequest()) {
        void this.finishLogout(
          reservation,
          undefined,
          controller,
          generation,
        );
        return;
      }
      if (this.takeAcceptanceCancellationRequest()) {
        this.retryAction = undefined;
        this.updateIdle();
        void this.api.abandonUpload(reservation).catch(() => undefined);
        return;
      }
      this.reservation = reservation;
      this.updateState({
        status: "preparing",
        phase: "uploading",
        cancelling: false,
      });
      const job = await this.api.upload(
        reservation,
        body,
        controller.signal,
      );
      if (!this.isCurrent(controller, generation)) return;
      this.reservation = undefined;
      if (this.takeSignOutAfterAcceptanceRequest()) {
        void this.finishLogout(
          undefined,
          job.state === "queued" || job.state === "running"
            ? job.id
            : undefined,
          controller,
          generation,
        );
        return;
      }
      this.retryAction = undefined;
      if (this.takeAcceptanceCancellationRequest()) {
        this.cancelAcceptedJob(job, controller, generation);
        return;
      }
      this.acceptJob(job, controller, generation);
    } catch (error) {
      if (!this.isCurrent(controller, generation)) return;
      const signOutRequested =
        this.takeSignOutAfterAcceptanceRequest();
      const cancellationRequested =
        this.takeAcceptanceCancellationRequest();
      const reservation = this.reservation;
      this.reservation = undefined;
      if (signOutRequested) {
        void this.finishLogout(
          reservation,
          undefined,
          controller,
          generation,
        );
        return;
      }
      if (reservation !== undefined) {
        void this.api.abandonUpload(reservation).catch(() => undefined);
      }
      if (cancellationRequested) {
        this.retryAction = undefined;
        this.updateIdle();
        return;
      }
      this.handleSubmissionFailure(error);
    }
  }

  private handleSubmissionFailure(error: unknown): void {
    if (isAuthorizationFailure(error)) {
      this.enterAuthorizationRequired(messageOf(error));
      return;
    }
    this.updateState({
      status: "request-failed",
      message: messageOf(error),
      fields: fieldErrors(error),
      retryable: retryable(error),
    });
  }

  private acceptJob(
    job: ImportJob,
    controller: AbortController,
    generation: number,
  ): void {
    this.retryAction = undefined;
    this.activeJob = job;
    this.persistenceAvailable = this.storage.write(job.id);
    this.recoveryFailures = 0;
    if (isCompletedJob(job)) {
      if (this.cancellationRequestedJobId === job.id) {
        this.cancellationRequestedJobId = undefined;
      }
      this.beginArtifactOpen(job, controller, generation);
      return;
    }
    if (isFailedJob(job)) {
      if (this.cancellationRequestedJobId === job.id) {
        this.cancellationRequestedJobId = undefined;
      }
      this.updateState({
        status: "terminal",
        job,
        persistenceAvailable: this.persistenceAvailable,
      });
      return;
    }
    this.updateState({
      status: "job",
      job,
      cancelling: this.cancellationRequestedJobId === job.id,
      persistenceAvailable: this.persistenceAvailable,
    });
    this.scheduleNextPoll(job.id, controller, generation, this.pollIntervalMs);
  }

  private cancelAcceptedJob(
    job: ImportJob,
    controller: AbortController,
    generation: number,
  ): void {
    this.cancellationRequestedJobId = job.id;
    this.activeJob = job;
    this.persistenceAvailable = this.storage.write(job.id);
    this.recoveryFailures = 0;
    if (isCompletedJob(job) || isFailedJob(job)) {
      this.acceptJob(job, controller, generation);
      return;
    }
    this.updateState({
      status: "job",
      job,
      cancelling: true,
      persistenceAvailable: this.persistenceAvailable,
    });
    void this.api.cancelJob(job.id, controller.signal).then(
      (cancelled) => {
        if (!this.isCurrent(controller, generation)) return;
        this.acceptJob(cancelled, controller, generation);
      },
      (error: unknown) => {
        if (!this.isCurrent(controller, generation)) return;
        if (isAuthorizationFailure(error)) {
          this.enterAuthorizationRequired(messageOf(error));
          return;
        }
        this.enterRecovery(
          job.id,
          error,
          controller,
          generation,
        );
      },
    );
  }

  private async pollJob(
    id: string,
    controller: AbortController,
    generation: number,
  ): Promise<void> {
    try {
      const job = await this.api.getJob(id, controller.signal);
      if (!this.isCurrent(controller, generation)) return;
      if (
        this.cancellationRequestedJobId === job.id &&
        (job.state === "queued" || job.state === "running")
      ) {
        this.cancelAcceptedJob(job, controller, generation);
        return;
      }
      this.acceptJob(job, controller, generation);
    } catch (error) {
      if (!this.isCurrent(controller, generation)) return;
      if (isAuthorizationFailure(error)) {
        this.enterAuthorizationRequired(messageOf(error), id);
        return;
      }
      if (isMissingJob(error)) {
        if (this.cancellationRequestedJobId === id) {
          this.cancellationRequestedJobId = undefined;
        }
        this.activeJob = undefined;
        this.storage.clear();
        this.updateState({
          status: "request-failed",
          message: "The saved import job no longer exists.",
          fields: Object.freeze([]),
          retryable: false,
        });
        return;
      }
      this.enterRecovery(id, error, controller, generation);
    }
  }

  private enterRecovery(
    id: string,
    error: unknown,
    controller: AbortController,
    generation: number,
  ): void {
    this.recoveryFailures += 1;
    const serverDelay =
      error instanceof ImportApiError
        ? error.details.retryAfterMs
        : undefined;
    const delay =
      serverDelay ??
      Math.min(
        this.pollIntervalMs * 2 ** Math.min(this.recoveryFailures, 5),
        IMPORT_JOB_MAXIMUM_RETRY_MS,
      );
    this.updateState({
      status: "recovering",
      jobId: id,
      ...(this.activeJob === undefined ? {} : { job: this.activeJob }),
      message: messageOf(error),
      retryAt: this.now() + delay,
      persistenceAvailable: this.persistenceAvailable,
    });
    this.scheduleNextPoll(id, controller, generation, delay);
  }

  private scheduleNextPoll(
    id: string,
    controller: AbortController,
    generation: number,
    delay: number,
  ): void {
    this.clearScheduledPoll();
    this.pollHandle = this.schedulePoll(() => {
      this.pollHandle = undefined;
      if (!this.isCurrent(controller, generation)) return;
      void this.pollJob(id, controller, generation);
    }, delay);
  }

  private beginArtifactOpen(
    job: ImportJob & { readonly state: "completed" },
    controller: AbortController,
    generation: number,
  ): void {
    this.updateState({
      status: "opening-artifact",
      job,
      persistenceAvailable: this.persistenceAvailable,
    });
    void this.openArtifact(job, controller, generation);
  }

  private async openArtifact(
    job: ImportJob & { readonly state: "completed" },
    controller: AbortController,
    generation: number,
  ): Promise<void> {
    const expectedPath = `/api/v1/artifacts/${job.id}/city-model.json`;
    if (
      job.result?.artifactToken !== job.id ||
      job.result.artifactUrl !== expectedPath
    ) {
      this.updateState({
        status: "artifact-failed",
        job,
        message: "The completed import did not contain a valid city model.",
        persistenceAvailable: this.persistenceAvailable,
      });
      return;
    }
    try {
      const loaded = await this.loadGateway.loadSameOriginModel(
        new URL(expectedPath, this.viewerUrl.origin),
        this.viewerUrl,
        controller.signal,
      );
      if (!this.isCurrent(controller, generation)) return;
      const model = validateCityModel(loaded.model);
      await this.onModelReady(model, {
        label: "Imported project",
        responseUrl: loaded.responseUrl,
        assetRoot: assetRootFromResponseUrl(loaded.responseUrl.href),
        jobId: job.id,
      });
      if (!this.isCurrent(controller, generation)) return;
      this.updateState({
        status: "completed",
        job,
        persistenceAvailable: this.persistenceAvailable,
      });
    } catch (error) {
      if (!this.isCurrent(controller, generation)) return;
      if (error instanceof ViewerLoadError && error.status === 401) {
        this.enterAuthorizationRequired(messageOf(error), job.id);
        return;
      }
      this.updateState({
        status: "artifact-failed",
        job,
        message: messageOf(error),
        persistenceAvailable: this.persistenceAvailable,
      });
    }
  }

  private enterAuthorizationRequired(
    message?: string,
    resumeJobId = this.activeJob?.id ?? this.storage.read(),
  ): void {
    this.updateState({
      status: "authorization-required",
      ...(resumeJobId === undefined ? {} : { resumeJobId }),
      ...(message === undefined ? {} : { message }),
    });
  }

  private updateIdle(): void {
    if (this.authorization === undefined) {
      this.updateState(INITIAL_STATE);
      return;
    }
    this.updateState({
      status: "idle",
      authorization: this.authorization,
      profiles: this.profiles,
      persistenceAvailable: this.persistenceAvailable,
    });
  }

  private updateState(state: ImportControllerState): void {
    if (this.disposed) return;
    this.currentState = Object.freeze(state);
    this.onStateChange?.(this.currentState);
  }

  private beginOperation(): {
    readonly controller: AbortController;
    readonly generation: number;
  } {
    this.generation += 1;
    this.acceptanceCancellationRequested = false;
    this.signOutAfterAcceptanceRequested = false;
    this.operation?.abort();
    this.clearScheduledPoll();
    const controller = new AbortController();
    this.operation = controller;
    return { controller, generation: this.generation };
  }

  private takeAcceptanceCancellationRequest(): boolean {
    const requested = this.acceptanceCancellationRequested;
    this.acceptanceCancellationRequested = false;
    return requested;
  }

  private takeSignOutAfterAcceptanceRequest(): boolean {
    const requested = this.signOutAfterAcceptanceRequested;
    this.signOutAfterAcceptanceRequested = false;
    return requested;
  }

  private clearScheduledPoll(): void {
    if (this.pollHandle === undefined) return;
    this.clearPoll(this.pollHandle);
    this.pollHandle = undefined;
  }

  private isCurrent(
    controller: AbortController,
    generation: number,
  ): boolean {
    return (
      !this.disposed &&
      this.operation === controller &&
      this.generation === generation &&
      !controller.signal.aborted
    );
  }

  private assertUsable(): void {
    if (this.disposed) {
      throw new Error("The import controller has been disposed.");
    }
  }

  private assertReadyForSubmission(): void {
    this.assertUsable();
    if (
      this.authorization === undefined ||
      (this.authorization.required &&
        !this.authorization.authenticated)
    ) {
      throw new Error("The import API is not authorized.");
    }
    if (
      this.activeJob !== undefined &&
      (this.activeJob.state === "queued" ||
        this.activeJob.state === "running")
    ) {
      throw new Error("An import job is already active.");
    }
  }
}
