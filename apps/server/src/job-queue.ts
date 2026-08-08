import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { EVOLUTION_BUNDLE_LIMITS } from "../../../packages/core/src/evolution.js";

export const JOB_STATES = [
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
] as const;

export type JobState = (typeof JOB_STATES)[number];

export interface JobProgress {
  readonly phase: string;
  readonly current?: number;
  readonly total?: number;
}

export interface JobError {
  readonly code:
    | "analysis-failed"
    | "cancelled"
    | "city-model-invalid"
    | "deadline-exceeded"
    | "failed"
    | "history-capability-unavailable"
    | "history-incomplete"
    | "history-limit-exceeded"
    | "history-too-long"
    | "import-limit-exceeded"
    | "interrupted"
    | "repository-content-rejected"
    | "repository-unavailable"
    | "revision-unavailable";
  readonly message: string;
}

export type JobTaskFailureCode =
  | "analysis-failed"
  | "city-model-invalid"
  | "deadline-exceeded"
  | "history-capability-unavailable"
  | "history-incomplete"
  | "history-limit-exceeded"
  | "history-too-long"
  | "import-limit-exceeded"
  | "repository-content-rejected"
  | "repository-unavailable"
  | "revision-unavailable";

const JOB_TASK_FAILURE_MESSAGES: Readonly<
  Record<JobTaskFailureCode, string>
> = Object.freeze({
  "analysis-failed": "Repository analysis failed.",
  "city-model-invalid": "The uploaded city model is invalid.",
  "deadline-exceeded":
    "The repository import exceeded its time limit.",
  "history-capability-unavailable":
    "Complete mainline history requires a Git server with filtered history fetch support. Choose a bounded custom history range.",
  "history-incomplete":
    "The selected history cannot be proven complete because the Git server supplied a shallow boundary. Choose an available bounded range or use a complete remote.",
  "history-limit-exceeded":
    "This repository is too detailed for the selected history. Reduce the maximum animation frames or choose a custom range.",
  "history-too-long":
    "This mainline has more than 100,000 commits. Choose a bounded custom history range.",
  "import-limit-exceeded":
    "The repository import exceeded a configured limit.",
  "repository-content-rejected":
    "Repository content violates the import safety policy.",
  "repository-unavailable":
    "The repository is unavailable to the server identity.",
  "revision-unavailable":
    "The requested repository revision is unavailable.",
});

function isJobTaskFailureCode(
  value: unknown,
): value is JobTaskFailureCode {
  return (
    value === "analysis-failed" ||
    value === "city-model-invalid" ||
    value === "deadline-exceeded" ||
    value === "history-capability-unavailable" ||
    value === "history-incomplete" ||
    value === "history-limit-exceeded" ||
    value === "history-too-long" ||
    value === "import-limit-exceeded" ||
    value === "repository-content-rejected" ||
    value === "repository-unavailable" ||
    value === "revision-unavailable"
  );
}

function jobTaskFailureMessage(code: JobTaskFailureCode): string {
  if (!isJobTaskFailureCode(code)) {
    throw new Error("Job task failure code is invalid.");
  }
  return JOB_TASK_FAILURE_MESSAGES[code];
}

export class JobTaskFailure extends Error {
  public override readonly name = "JobTaskFailure";
  public readonly code: JobTaskFailureCode;

  public constructor(code: JobTaskFailureCode) {
    super(jobTaskFailureMessage(code));
    this.code = code;
  }
}

export interface JobResult {
  readonly kind: "city-model";
  readonly artifactToken: string;
  readonly artifactUrl: string;
  readonly evolution?: {
    readonly artifactUrl: string;
    readonly size: number;
    readonly sha256: string;
  };
  readonly source?:
    | {
        readonly availability: "disabled";
      }
    | {
        readonly availability: "not-captured";
      }
    | {
        readonly availability: "retained";
        readonly artifactUrl: string;
        readonly size: number;
        readonly sha256: string;
        readonly indexSha256: string;
      };
}

export interface JobRecord {
  readonly id: string;
  readonly kind: string;
  readonly state: JobState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly progress?: JobProgress;
  readonly error?: JobError;
  readonly result?: JobResult;
}

export interface JobTaskContext {
  readonly id: string;
  readonly signal: AbortSignal;
  report(progress: JobProgress): Promise<void>;
}

export type JobTask = (
  context: JobTaskContext,
) => Promise<JobResult | undefined | void>;

export type JobFinalizer = (record: JobRecord) => Promise<void>;
export type JobRollback = (record: JobRecord) => Promise<void>;

export interface JobEnqueueOptions {
  readonly finalize?: JobFinalizer;
  readonly rollback?: JobRollback;
}

export interface PersistentJobQueueOptions {
  readonly dataDirectory: string;
  readonly concurrency?: number;
  readonly now?: () => Date;
}

interface PendingJob {
  readonly id: string;
  readonly task: JobTask;
  readonly controller: AbortController;
  readonly finalize?: JobFinalizer;
  readonly rollback?: JobRollback;
  readonly settlement: Promise<JobRecord>;
  readonly resolveSettlement: (record: JobRecord) => void;
  settlementOperation?: Promise<JobRecord>;
  rollbackOperation?: Promise<boolean>;
  settling: boolean;
}

interface JobRecordChange {
  readonly progress?: JobProgress;
  readonly error?: JobError;
  readonly result?: JobResult;
}

interface JobTerminalIntent {
  readonly state: "completed" | "failed" | "cancelled";
  readonly change: JobRecordChange;
}

const MAXIMUM_JOB_RECORDS = 10_000;
const MAXIMUM_JOB_DIRECTORY_ENTRIES = MAXIMUM_JOB_RECORDS * 4;
const MAXIMUM_JOB_FILE_BYTES = 64 * 1024;
const JOB_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const JOB_DELETION_TOMBSTONE_PATTERN =
  /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json\.delete$/u;
const JOB_KIND_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;
const MAXIMUM_PHASE_CHARACTERS = 160;
const FINALIZATION_FAILURE_MESSAGE = "The job cleanup did not complete.";
const TERMINAL_PERSISTENCE_FAILURE_MESSAGE =
  "The job terminal state could not be persisted.";
const JOB_PROGRESS_KEYS = ["current", "phase", "total"] as const;
const EVOLUTION_ARTIFACT_KEYS = [
  "artifactUrl",
  "sha256",
  "size",
] as const;
const DISABLED_SOURCE_KEYS = ["availability"] as const;
const RETAINED_SOURCE_KEYS = [
  "artifactUrl",
  "availability",
  "indexSha256",
  "sha256",
  "size",
] as const;
const EVOLUTION_ARTIFACT_MAX_BYTES =
  EVOLUTION_BUNDLE_LIMITS.serializedBytes;
const SOURCE_ARTIFACT_MAX_BYTES = 128 * 1024 * 1024;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isTerminal(record: JobRecord): boolean {
  return (
    record.state === "completed" ||
    record.state === "failed" ||
    record.state === "cancelled"
  );
}

function validIsoDate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 40 &&
    !Number.isNaN(Date.parse(value))
  );
}

function readProgress(value: unknown): JobProgress | undefined {
  try {
    if (typeof value !== "object" || value === null) return undefined;
    const candidate = value as Record<string, unknown>;
    const keys = Object.keys(candidate).sort(compareText);
    const phase = candidate["phase"];
    const current = candidate["current"];
    const total = candidate["total"];
    const expectedKeys = [
      ...(current === undefined ? [] : ["current"]),
      "phase",
      ...(total === undefined ? [] : ["total"]),
    ];
    if (
      keys.length !== expectedKeys.length ||
      !keys.every((key, index) => key === expectedKeys[index]) ||
      !keys.every((key) =>
        JOB_PROGRESS_KEYS.some((allowed) => allowed === key),
      ) ||
      typeof phase !== "string" ||
      phase.length === 0 ||
      phase.length > MAXIMUM_PHASE_CHARACTERS ||
      (current !== undefined &&
        (!Number.isSafeInteger(current) || (current as number) < 0)) ||
      (total !== undefined &&
        (!Number.isSafeInteger(total) || (total as number) < 0)) ||
      (current !== undefined &&
        total !== undefined &&
        (current as number) > (total as number))
    ) {
      return undefined;
    }
    return Object.freeze({
      phase,
      ...(current === undefined ? {} : { current: current as number }),
      ...(total === undefined ? {} : { total: total as number }),
    });
  } catch {
    return undefined;
  }
}

function validError(value: unknown): value is JobError {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate).sort(compareText);
  const code = candidate["code"];
  const message = candidate["message"];
  const recognizedCode =
    isJobTaskFailureCode(code) ||
    code === "cancelled" ||
    code === "failed" ||
    code === "interrupted";
  return (
    keys.length === 2 &&
    keys[0] === "code" &&
    keys[1] === "message" &&
    recognizedCode &&
    typeof message === "string" &&
    message.length > 0 &&
    message.length <= 1_024 &&
    (!isJobTaskFailureCode(code) ||
      message === JOB_TASK_FAILURE_MESSAGES[code])
  );
}

function readResult(
  value: unknown,
  expectedToken: string,
): JobResult | undefined {
  try {
    if (typeof value !== "object" || value === null) return undefined;
    const candidate = value as Record<string, unknown>;
    const keys = Object.keys(candidate).sort(compareText);
    const kind = candidate["kind"];
    const token = candidate["artifactToken"];
    const url = candidate["artifactUrl"];
    const evolution = candidate["evolution"];
    const source = candidate["source"];
    const expectedKeys = [
      "artifactToken",
      "artifactUrl",
      ...(evolution === undefined ? [] : ["evolution"]),
      "kind",
      ...(source === undefined ? [] : ["source"]),
    ];
    if (
      keys.length !== expectedKeys.length ||
      !keys.every((key, index) => key === expectedKeys[index]) ||
      kind !== "city-model" ||
      typeof token !== "string" ||
      !JOB_ID_PATTERN.test(token) ||
      token !== expectedToken ||
      url !== `/api/v1/artifacts/${token}/city-model.json`
    ) {
      return undefined;
    }
    let normalizedEvolution:
      | NonNullable<JobResult["evolution"]>
      | undefined;
    if (evolution !== undefined) {
      if (typeof evolution !== "object" || evolution === null) {
        return undefined;
      }
      const evolutionCandidate = evolution as Record<string, unknown>;
      const evolutionKeys = Object.keys(evolutionCandidate).sort(
        compareText,
      );
      const evolutionUrl = evolutionCandidate["artifactUrl"];
      const size = evolutionCandidate["size"];
      const digest = evolutionCandidate["sha256"];
      if (
        evolutionKeys.length !== EVOLUTION_ARTIFACT_KEYS.length ||
        !evolutionKeys.every(
          (key, index) => key === EVOLUTION_ARTIFACT_KEYS[index],
        ) ||
        evolutionUrl !==
          `/api/v1/artifacts/${token}/evolution.json` ||
        !Number.isSafeInteger(size) ||
        (size as number) < 1 ||
        (size as number) > EVOLUTION_ARTIFACT_MAX_BYTES ||
        typeof digest !== "string" ||
        !/^[0-9a-f]{64}$/u.test(digest)
      ) {
        return undefined;
      }
      normalizedEvolution = Object.freeze({
        artifactUrl: evolutionUrl,
        size: size as number,
        sha256: digest,
      });
    }
    let normalizedSource: JobResult["source"];
    if (source !== undefined) {
      if (typeof source !== "object" || source === null) {
        return undefined;
      }
      const sourceCandidate = source as Record<string, unknown>;
      const sourceKeys = Object.keys(sourceCandidate).sort(compareText);
      const availability = sourceCandidate["availability"];
      if (
        availability === "disabled" ||
        availability === "not-captured"
      ) {
        if (
          sourceKeys.length !== DISABLED_SOURCE_KEYS.length ||
          !sourceKeys.every(
            (key, index) => key === DISABLED_SOURCE_KEYS[index],
          )
        ) {
          return undefined;
        }
        normalizedSource = Object.freeze({ availability });
      } else if (availability === "retained") {
        const sourceUrl = sourceCandidate["artifactUrl"];
        const size = sourceCandidate["size"];
        const digest = sourceCandidate["sha256"];
        const indexDigest = sourceCandidate["indexSha256"];
        if (
          sourceKeys.length !== RETAINED_SOURCE_KEYS.length ||
          !sourceKeys.every(
            (key, index) => key === RETAINED_SOURCE_KEYS[index],
          ) ||
          sourceUrl !== `/api/v1/artifacts/${token}/source` ||
          !Number.isSafeInteger(size) ||
          (size as number) < 1 ||
          (size as number) > SOURCE_ARTIFACT_MAX_BYTES ||
          typeof digest !== "string" ||
          !/^[0-9a-f]{64}$/u.test(digest) ||
          typeof indexDigest !== "string" ||
          !/^[0-9a-f]{64}$/u.test(indexDigest)
        ) {
          return undefined;
        }
        normalizedSource = Object.freeze({
          availability,
          artifactUrl: sourceUrl,
          size: size as number,
          sha256: digest,
          indexSha256: indexDigest,
        });
      } else {
        return undefined;
      }
    }
    return Object.freeze({
      kind,
      artifactToken: token,
      artifactUrl: url,
      ...(normalizedEvolution === undefined
        ? {}
        : { evolution: normalizedEvolution }),
      ...(normalizedSource === undefined
        ? {}
        : { source: normalizedSource }),
    });
  } catch {
    return undefined;
  }
}

function parseJobRecord(value: unknown): JobRecord {
  if (typeof value !== "object" || value === null) {
    throw new Error("Invalid persisted job record.");
  }
  const candidate = value as Record<string, unknown>;
  const id = candidate["id"];
  const kind = candidate["kind"];
  const state = candidate["state"];
  const createdAt = candidate["createdAt"];
  const updatedAt = candidate["updatedAt"];
  const progress = candidate["progress"];
  const error = candidate["error"];
  const result = candidate["result"];
  const parsedResult =
    result === undefined || typeof id !== "string"
      ? undefined
      : readResult(result, id);
  const parsedProgress =
    progress === undefined ? undefined : readProgress(progress);
  if (
    typeof id !== "string" ||
    !JOB_ID_PATTERN.test(id) ||
    typeof kind !== "string" ||
    !JOB_KIND_PATTERN.test(kind) ||
    typeof state !== "string" ||
    !JOB_STATES.some((jobState) => jobState === state) ||
    !validIsoDate(createdAt) ||
    !validIsoDate(updatedAt)
  ) {
    throw new Error("Invalid persisted job record.");
  }
  if (progress !== undefined && parsedProgress === undefined) {
    throw new Error("Invalid persisted job progress.");
  }
  if (error !== undefined && !validError(error)) {
    throw new Error("Invalid persisted job error.");
  }
  if (result !== undefined && parsedResult === undefined) {
    throw new Error("Invalid persisted job result.");
  }
  const parsedState = state as JobState;
  if (result !== undefined && parsedState !== "completed") {
    throw new Error("Invalid persisted job result state.");
  }
  return Object.freeze({
    id,
    kind,
    state: parsedState,
    createdAt,
    updatedAt,
    ...(parsedProgress === undefined
      ? {}
      : { progress: parsedProgress }),
    ...(error === undefined
      ? {}
      : { error: Object.freeze({ ...error }) }),
    ...(parsedResult === undefined
      ? {}
      : { result: parsedResult }),
  });
}

function normalizeProgress(progress: JobProgress): JobProgress {
  const normalized = readProgress(progress);
  if (!normalized) {
    throw new Error("Job progress is invalid.");
  }
  return normalized;
}

function normalizeResult(
  result: JobResult,
  expectedToken: string,
): JobResult {
  const normalized = readResult(result, expectedToken);
  if (!normalized) {
    throw new Error("Job result is invalid.");
  }
  return normalized;
}

function transitionedRecord(
  current: JobRecord,
  state: JobState,
  updatedAt: string,
  change: JobRecordChange,
): JobRecord {
  const { result: _discardedResult, ...base } = current;
  return Object.freeze({
    ...base,
    state,
    updatedAt,
    ...(change.progress === undefined
      ? current.progress === undefined
        ? {}
        : { progress: current.progress }
      : { progress: change.progress }),
    ...(change.error === undefined
      ? {}
      : { error: Object.freeze({ ...change.error }) }),
    ...(state !== "completed" || change.result === undefined
      ? {}
      : { result: Object.freeze({ ...change.result }) }),
  });
}

function safeMessage(error: unknown): string {
  try {
    const message = error instanceof Error ? error.message : String(error);
    const normalized = message
      .replace(/[\u0000-\u001F\u007F]+/gu, " ")
      .trim();
    return (normalized || "The job failed.").slice(0, 1_024);
  } catch {
    return "The job failed.";
  }
}

function safeJobError(error: unknown): JobError {
  if (
    error instanceof JobTaskFailure &&
    isJobTaskFailureCode(error.code)
  ) {
    return Object.freeze({
      code: error.code,
      message: JOB_TASK_FAILURE_MESSAGES[error.code],
    });
  }
  return Object.freeze({
    code: "failed",
    message: safeMessage(error),
  });
}

function activeCancellationIntent(): JobTerminalIntent {
  return {
    state: "cancelled",
    change: {
      error: { code: "cancelled", message: "The job was cancelled." },
    },
  };
}

async function ensurePrivateDirectory(directory: string): Promise<string> {
  const absolute = path.resolve(directory);
  await fs.mkdir(absolute, { recursive: true, mode: 0o700 });
  const status = await fs.lstat(absolute);
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new Error("Code City data directory must be a real directory.");
  }
  return fs.realpath(absolute);
}

export class PersistentJobQueue {
  readonly #jobsDirectory: string;
  readonly #concurrency: number;
  readonly #now: () => Date;
  readonly #records = new Map<string, JobRecord>();
  readonly #pending: PendingJob[] = [];
  readonly #active = new Map<string, PendingJob>();
  readonly #live = new Map<string, PendingJob>();
  readonly #enqueues = new Set<Promise<JobRecord>>();
  readonly #runs = new Set<Promise<void>>();
  readonly #transitions = new Map<string, Promise<JobRecord>>();
  readonly #writes = new Map<string, Promise<void>>();
  readonly #deletions = new Map<
    string,
    Promise<JobRecord | undefined>
  >();
  readonly #pendingRemovals = new Map<string, JobRecord>();
  #disposed = false;
  #closePromise: Promise<void> | undefined;

  private constructor(
    jobsDirectory: string,
    concurrency: number,
    now: () => Date,
  ) {
    this.#jobsDirectory = jobsDirectory;
    this.#concurrency = concurrency;
    this.#now = now;
  }

  public static async open(
    options: PersistentJobQueueOptions,
  ): Promise<PersistentJobQueue> {
    const concurrency = options.concurrency ?? 1;
    if (
      !Number.isSafeInteger(concurrency) ||
      concurrency < 1 ||
      concurrency > 16
    ) {
      throw new Error("Job concurrency must be an integer from 1 to 16.");
    }
    const dataDirectory = await ensurePrivateDirectory(options.dataDirectory);
    const jobsDirectory = await ensurePrivateDirectory(
      path.join(dataDirectory, "jobs"),
    );
    const queue = new PersistentJobQueue(
      jobsDirectory,
      concurrency,
      options.now ?? (() => new Date()),
    );
    await queue.load();
    return queue;
  }

  public list(): readonly JobRecord[] {
    return Object.freeze(
      [...this.#records.values()].sort(
        (left, right) =>
          compareText(right.createdAt, left.createdAt) ||
          compareText(left.id, right.id),
      ),
    );
  }

  public get(id: string): JobRecord | undefined {
    return this.#records.get(id);
  }

  /**
   * Resolves after a live job completes terminal-state settlement. This avoids
   * wall-clock polling for in-process consumers while preserving an immediate
   * lookup for missing and already-terminal records.
   */
  public waitForTerminal(
    id: string,
  ): Promise<JobRecord | undefined> {
    const record = this.#records.get(id);
    if (record === undefined || isTerminal(record)) {
      return Promise.resolve(record);
    }
    const live = this.#live.get(id);
    if (live === undefined) {
      return Promise.reject(
        new Error("A non-terminal job has no live settlement."),
      );
    }
    return live.settlement;
  }

  public enqueue(
    kind: string,
    task: JobTask,
    options: JobEnqueueOptions = {},
  ): Promise<JobRecord> {
    if (this.#disposed) {
      return Promise.reject(new Error("Job queue is closed."));
    }
    const operation = this.enqueueJob(kind, task, options);
    this.#enqueues.add(operation);
    void operation.then(
      () => this.#enqueues.delete(operation),
      () => this.#enqueues.delete(operation),
    );
    return operation;
  }

  private async enqueueJob(
    kind: string,
    task: JobTask,
    options: JobEnqueueOptions,
  ): Promise<JobRecord> {
    const finalize = options.finalize;
    const rollback = options.rollback;
    if (!JOB_KIND_PATTERN.test(kind)) {
      throw new Error(
        "Job kind must start with a letter and contain at most 64 lowercase letters, digits, or hyphens.",
      );
    }
    if (
      this.#records.size + this.#pendingRemovals.size >=
      MAXIMUM_JOB_RECORDS
    ) {
      throw new Error("Job record limit reached.");
    }
    if (
      finalize !== undefined &&
      typeof finalize !== "function"
    ) {
      throw new Error("Job finalizer must be a function.");
    }
    if (rollback !== undefined && typeof rollback !== "function") {
      throw new Error("Job rollback must be a function.");
    }
    const timestamp = this.#now().toISOString();
    const record: JobRecord = Object.freeze({
      id: randomUUID(),
      kind,
      state: "queued",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await this.persist(record);
    this.#records.set(record.id, record);
    let resolveSettlement: ((record: JobRecord) => void) | undefined;
    const settlement = new Promise<JobRecord>((resolve) => {
      resolveSettlement = resolve;
    });
    const job: PendingJob = {
      id: record.id,
      task,
      controller: new AbortController(),
      settlement,
      resolveSettlement: (terminal) => resolveSettlement!(terminal),
      settling: false,
      ...(finalize === undefined
        ? {}
        : { finalize }),
      ...(rollback === undefined
        ? {}
        : { rollback }),
    };
    this.#live.set(record.id, job);
    this.#pending.push(job);
    this.pump();
    return record;
  }

  public cancel(id: string): Promise<JobRecord | undefined> {
    return this.cancelJob(id);
  }

  private cancelJob(
    id: string,
  ): Promise<JobRecord | undefined> {
    const record = this.#records.get(id);
    if (!record) return Promise.resolve(undefined);
    if (isTerminal(record)) return Promise.resolve(record);
    const job = this.#live.get(id);
    if (!job) return Promise.resolve(record);
    const queuedIndex = this.#pending.findIndex((job) => job.id === id);
    if (queuedIndex >= 0) {
      this.#pending.splice(queuedIndex, 1);
      job.controller.abort();
      return this.beginSettlement(job, {
        state: "cancelled",
        change: {
          error: {
            code: "cancelled",
            message: "The job was cancelled before it started.",
          },
        },
      });
    }
    if (!job.settling) job.controller.abort();
    return job.settlement;
  }

  /**
   * Durably removes a completed record while leaving queued/running and other
   * terminal records unchanged. The deletion tombstone is the commit point:
   * after its directory sync, startup will finish the deletion even if the
   * process stops before owned artifacts are cleaned.
   */
  public removeCompleted(
    id: string,
  ): Promise<JobRecord | undefined> {
    if (!JOB_ID_PATTERN.test(id)) return Promise.resolve(undefined);
    if (this.#disposed) {
      return Promise.reject(new Error("Job queue is closed."));
    }
    const active = this.#deletions.get(id);
    if (active !== undefined) return active;
    const deletion = this.removeCompletedJob(id).finally(() => {
      if (this.#deletions.get(id) === deletion) {
        this.#deletions.delete(id);
      }
    });
    this.#deletions.set(id, deletion);
    return deletion;
  }

  private async removeCompletedJob(
    id: string,
  ): Promise<JobRecord | undefined> {
    await this.#transitions.get(id)?.catch(() => undefined);
    await this.#writes.get(id)?.catch(() => undefined);
    const record = this.#records.get(id);
    if (record === undefined) {
      return (
        this.#pendingRemovals.get(id) ??
        this.readDeletionTombstone(id)
      );
    }
    if (record.state !== "completed") {
      return record;
    }

    const destination = path.join(
      this.#jobsDirectory,
      `${record.id}.json`,
    );
    const tombstone = `${destination}.delete`;
    let renamedDestination = false;
    let retained: JobRecord | undefined;
    try {
      await fs.rename(destination, tombstone);
      renamedDestination = true;
      retained = await this.readDeletionTombstone(id);
    } catch (error) {
      if (
        !renamedDestination &&
        hasErrorCode(error, "ENOENT")
      ) {
        retained = await this.readDeletionTombstone(id);
        if (retained === undefined) throw error;
      } else {
        if (renamedDestination) {
          await this.restoreDeletionRecord(
            tombstone,
            destination,
            error,
          );
        }
        throw error;
      }
    }
    if (
      retained === undefined ||
      JSON.stringify(retained) !== JSON.stringify(record)
    ) {
      const error = new Error(
        "Persisted job changed before deletion.",
      );
      if (renamedDestination) {
        await this.restoreDeletionRecord(
          tombstone,
          destination,
          error,
        );
      }
      throw error;
    }
    await this.syncJobsDirectory();
    this.#records.delete(record.id);
    this.#pendingRemovals.set(record.id, retained);
    return retained;
  }

  /**
   * Removes the durable deletion intent only after the caller has finished
   * cleanup of every resource owned by the completed job.
   */
  public async finishRemoval(id: string): Promise<void> {
    if (!JOB_ID_PATTERN.test(id)) {
      throw new Error("Job id is invalid.");
    }
    const destination = path.join(
      this.#jobsDirectory,
      `${id}.json`,
    );
    const tombstone = `${destination}.delete`;
    const retained =
      this.#pendingRemovals.get(id) ??
      (await this.readDeletionTombstone(id));
    if (retained === undefined) return;
    await this.removeDeletionShadow(`${destination}.bak`);
    await fs.rm(tombstone).catch((error: unknown) => {
      if (!hasErrorCode(error, "ENOENT")) throw error;
    });
    await this.syncJobsDirectory();
    this.#pendingRemovals.delete(id);
  }

  public async finishPendingRemovals(): Promise<void> {
    for (const id of [...this.#pendingRemovals.keys()].sort(compareText)) {
      await this.finishRemoval(id);
    }
  }

  private async readDeletionTombstone(
    id: string,
  ): Promise<JobRecord | undefined> {
    const tombstone = path.join(
      this.#jobsDirectory,
      `${id}.json.delete`,
    );
    let status;
    try {
      status = await fs.lstat(tombstone);
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) return undefined;
      throw error;
    }
    if (
      !status.isFile() ||
      status.isSymbolicLink() ||
      status.size > MAXIMUM_JOB_FILE_BYTES
    ) {
      throw new Error("Persisted job deletion tombstone is invalid.");
    }
    let record: JobRecord;
    try {
      record = parseJobRecord(
        JSON.parse(await fs.readFile(tombstone, "utf8")) as unknown,
      );
    } catch (error) {
      throw new Error(
        "Persisted job deletion tombstone is invalid.",
        { cause: error },
      );
    }
    if (record.id !== id || record.state !== "completed") {
      throw new Error("Persisted job deletion tombstone is invalid.");
    }
    return record;
  }

  private async removeDeletionShadow(file: string): Promise<void> {
    let status;
    try {
      status = await fs.lstat(file);
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) return;
      throw error;
    }
    if (!status.isFile() || status.isSymbolicLink()) {
      throw new Error("Persisted job deletion shadow is invalid.");
    }
    await fs.rm(file);
    await this.syncJobsDirectory();
  }

  private async restoreDeletionRecord(
    tombstone: string,
    destination: string,
    cause: unknown,
  ): Promise<void> {
    try {
      await fs.rename(tombstone, destination);
      await this.syncJobsDirectory();
    } catch (restoreError) {
      throw new AggregateError(
        [cause, restoreError],
        "Persisted job deletion could not be rolled back.",
      );
    }
  }

  public close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#disposed = true;
    this.#closePromise = this.closeJobs();
    return this.#closePromise;
  }

  private async closeJobs(): Promise<void> {
    await Promise.allSettled([...this.#enqueues]);
    await Promise.allSettled(
      [...this.#live.keys()].map((id) => this.cancelJob(id)),
    );
    await Promise.allSettled([...this.#runs]);
    await Promise.allSettled([...this.#writes.values()]);
    await Promise.allSettled([...this.#deletions.values()]);
  }

  private async load(): Promise<void> {
    let entries = await fs.readdir(this.#jobsDirectory, {
      withFileTypes: true,
    });
    if (entries.length > MAXIMUM_JOB_DIRECTORY_ENTRIES) {
      throw new Error("Persisted job directory entry limit exceeded.");
    }
    for (const entry of entries) {
      const match = JOB_DELETION_TOMBSTONE_PATTERN.exec(entry.name);
      if (match === null) continue;
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new Error("Persisted job deletion tombstone is invalid.");
      }
      const retained = await this.readDeletionTombstone(match[1]!);
      if (retained === undefined) {
        throw new Error("Persisted job deletion tombstone is invalid.");
      }
      this.#pendingRemovals.set(retained.id, retained);
      const tombstone = path.join(this.#jobsDirectory, entry.name);
      const destination = path.join(
        this.#jobsDirectory,
        `${match[1]!}.json`,
      );
      await this.removeDeletionShadow(destination);
      await this.removeDeletionShadow(`${destination}.bak`);
      await fs.lstat(tombstone);
    }
    entries = await fs.readdir(this.#jobsDirectory, {
      withFileTypes: true,
    });
    for (const entry of entries) {
      const candidate = path.join(this.#jobsDirectory, entry.name);
      if (
        entry.name.endsWith(".tmp") &&
        entry.isFile() &&
        !entry.isSymbolicLink()
      ) {
        await fs.rm(candidate, { force: true });
        continue;
      }
      if (
        entry.name.endsWith(".json.bak") &&
        entry.isFile() &&
        !entry.isSymbolicLink()
      ) {
        const destination = candidate.slice(0, -".bak".length);
        let destinationExists = true;
        try {
          await fs.lstat(destination);
        } catch (error) {
          if (!hasErrorCode(error, "ENOENT")) throw error;
          destinationExists = false;
        }
        if (destinationExists) {
          await fs.rm(candidate, { force: true });
          await this.syncJobsDirectory();
        } else {
          await fs.rename(candidate, destination);
          await this.syncJobsDirectory();
        }
      }
    }
    entries = await fs.readdir(this.#jobsDirectory, {
      withFileTypes: true,
    });
    const records: JobRecord[] = [];
    for (const entry of entries.sort((left, right) =>
      compareText(left.name, right.name),
    )) {
      if (!entry.isFile() || entry.isSymbolicLink()) {
        continue;
      }
      if (!entry.name.endsWith(".json")) continue;
      const file = path.join(this.#jobsDirectory, entry.name);
      const status = await fs.lstat(file);
      if (
        !status.isFile() ||
        status.isSymbolicLink() ||
        status.size > MAXIMUM_JOB_FILE_BYTES
      ) {
        throw new Error("Persisted job record is invalid.");
      }
      const value = JSON.parse(await fs.readFile(file, "utf8")) as unknown;
      const record = parseJobRecord(value);
      if (entry.name !== `${record.id}.json`) {
        throw new Error("Persisted job filename does not match its id.");
      }
      records.push(record);
    }
    if (
      records.length + this.#pendingRemovals.size >
      MAXIMUM_JOB_RECORDS
    ) {
      throw new Error("Persisted job record limit exceeded.");
    }
    for (const record of records) {
      if (this.#records.has(record.id)) {
        throw new Error("Duplicate persisted job id.");
      }
      let recovered = record;
      if (record.state === "queued" || record.state === "running") {
        const { result: _discardedResult, ...recoverable } = record;
        recovered = Object.freeze({
          ...recoverable,
          state: "failed",
          updatedAt: this.#now().toISOString(),
          error: Object.freeze({
            code: "interrupted",
            message: "The server restarted before the job completed.",
          }),
        });
        await this.persist(recovered);
      }
      this.#records.set(recovered.id, recovered);
    }
  }

  private pump(): void {
    while (
      !this.#disposed &&
      this.#active.size < this.#concurrency &&
      this.#pending.length > 0
    ) {
      const job = this.#pending.shift()!;
      this.#active.set(job.id, job);
      const run = this.run(job);
      this.#runs.add(run);
      void run.then(
        () => this.#runs.delete(run),
        () => this.#runs.delete(run),
      );
    }
  }

  private async run(job: PendingJob): Promise<void> {
    let intent: JobTerminalIntent;
    try {
      await this.transition(job.id, "running");
      if (job.controller.signal.aborted) {
        intent = activeCancellationIntent();
      } else {
        const result = await job.task({
          id: job.id,
          signal: job.controller.signal,
          report: async (progress) => {
            if (job.controller.signal.aborted || job.settling) return;
            const normalized = normalizeProgress(progress);
            if (job.controller.signal.aborted || job.settling) return;
            await this.transition(job.id, "running", {
              progress: normalized,
            });
          },
        });
        if (job.controller.signal.aborted) {
          intent = activeCancellationIntent();
        } else {
          const normalized =
            result === undefined
              ? undefined
              : normalizeResult(result, job.id);
          intent = job.controller.signal.aborted
            ? activeCancellationIntent()
            : {
                state: "completed",
                change:
                  normalized === undefined ? {} : { result: normalized },
              };
        }
      }
    } catch (error) {
      intent = job.controller.signal.aborted
        ? activeCancellationIntent()
        : {
            state: "failed",
            change: {
              error: safeJobError(error),
            },
          };
    }
    try {
      await this.beginSettlement(job, intent);
    } finally {
      this.#active.delete(job.id);
      this.pump();
    }
  }

  private transition(
    id: string,
    state: "running",
    change: JobRecordChange = {},
  ): Promise<JobRecord> {
    const previous = this.#transitions.get(id);
    const operation = (previous ?? Promise.resolve(undefined))
      .catch(() => undefined)
      .then(() => this.applyTransition(id, state, change));
    this.#transitions.set(id, operation);
    void operation.then(
      () => {
        if (this.#transitions.get(id) === operation) {
          this.#transitions.delete(id);
        }
      },
      () => {
        if (this.#transitions.get(id) === operation) {
          this.#transitions.delete(id);
        }
      },
    );
    return operation;
  }

  private async applyTransition(
    id: string,
    state: "running",
    change: JobRecordChange,
  ): Promise<JobRecord> {
    const current = this.#records.get(id);
    if (!current) throw new Error(`Unknown job '${id}'.`);
    if (isTerminal(current)) return current;
    const record = transitionedRecord(
      current,
      state,
      this.#now().toISOString(),
      change,
    );
    await this.persist(record);
    this.#records.set(id, record);
    return record;
  }

  private beginSettlement(
    job: PendingJob,
    intent: JobTerminalIntent,
  ): Promise<JobRecord> {
    if (!job.settlementOperation) {
      job.settling = true;
      const operation = this.settleJob(job, intent);
      job.settlementOperation = operation;
      void operation.then(
        (record) => this.finishSettlement(job, record),
        () => {
          const current = this.#records.get(job.id);
          if (!current) return;
          const fallback = transitionedRecord(
            current,
            "failed",
            this.#now().toISOString(),
            {
              error: {
                code: "failed",
                message:
                  "The job ended before its terminal state was persisted.",
              },
            },
          );
          this.#records.set(job.id, fallback);
          this.finishSettlement(job, fallback);
        },
      );
    }
    return job.settlement;
  }

  private async settleJob(
    job: PendingJob,
    intent: JobTerminalIntent,
  ): Promise<JobRecord> {
    await this.#transitions.get(job.id)?.catch(() => undefined);
    const current = this.#records.get(job.id);
    if (!current) throw new Error(`Unknown job '${job.id}'.`);
    if (isTerminal(current)) return current;
    const prospective = transitionedRecord(
      current,
      intent.state,
      this.#now().toISOString(),
      intent.change,
    );
    let terminal = prospective;
    let finalizationFailed = false;
    if (job.finalize) {
      try {
        await job.finalize(prospective);
      } catch {
        finalizationFailed = true;
        await this.compensate(job, prospective);
      }
    }
    if (finalizationFailed) {
      terminal = transitionedRecord(
        current,
        "failed",
        this.#now().toISOString(),
        {
          error: {
            code: "failed",
            message: FINALIZATION_FAILURE_MESSAGE,
          },
        },
      );
      await this.persist(terminal).catch(() => undefined);
      this.#records.set(job.id, terminal);
      return terminal;
    }
    try {
      await this.persist(terminal);
    } catch {
      const compensated = await this.compensate(job, prospective);
      terminal = transitionedRecord(
        current,
        "failed",
        this.#now().toISOString(),
        {
          error: {
            code: "failed",
            message: compensated
              ? TERMINAL_PERSISTENCE_FAILURE_MESSAGE
              : FINALIZATION_FAILURE_MESSAGE,
          },
        },
      );
      await this.persist(terminal).catch(() => undefined);
    }
    this.#records.set(job.id, terminal);
    return terminal;
  }

  private compensate(
    job: PendingJob,
    record: JobRecord,
  ): Promise<boolean> {
    if (!job.rollbackOperation) {
      job.rollbackOperation =
        job.rollback === undefined
          ? Promise.resolve(true)
          : Promise.resolve()
              .then(() => job.rollback!(record))
              .then(
                () => true,
                () => false,
              );
    }
    return job.rollbackOperation;
  }

  private finishSettlement(job: PendingJob, record: JobRecord): void {
    this.#live.delete(job.id);
    job.resolveSettlement(record);
  }

  private async persist(record: JobRecord): Promise<void> {
    const previous = this.#writes.get(record.id) ?? Promise.resolve();
    const write = previous
      .catch(() => undefined)
      .then(() => this.writeRecord(record));
    this.#writes.set(record.id, write);
    try {
      await write;
    } finally {
      if (this.#writes.get(record.id) === write) {
        this.#writes.delete(record.id);
      }
    }
  }

  private async writeRecord(record: JobRecord): Promise<void> {
    const destination = path.join(this.#jobsDirectory, `${record.id}.json`);
    const backup = `${destination}.bak`;
    const temporary = path.join(
      this.#jobsDirectory,
      `${record.id}.${randomUUID()}.tmp`,
    );
    const bytes = `${JSON.stringify(record)}\n`;
    if (Buffer.byteLength(bytes, "utf8") > MAXIMUM_JOB_FILE_BYTES) {
      throw new Error("Job record exceeds the persistence limit.");
    }
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(bytes, { encoding: "utf8" });
        await handle.sync();
      } finally {
        await handle.close();
        handle = undefined;
      }
      let useReplacement = false;
      try {
        await fs.rename(temporary, destination);
      } catch (error) {
        if (!hasAnyErrorCode(error, ["EEXIST", "EPERM", "EACCES"])) {
          throw error;
        }
        useReplacement = true;
      }
      if (!useReplacement) {
        await this.syncJobsDirectory();
      } else {
        await fs.rm(backup, { force: true });
        await this.syncJobsDirectory();
        let movedExisting = false;
        try {
          await fs.rename(destination, backup);
          movedExisting = true;
        } catch (moveError) {
          if (!hasErrorCode(moveError, "ENOENT")) throw moveError;
        }
        if (movedExisting) {
          try {
            await this.syncJobsDirectory();
          } catch (syncError) {
            await this.restoreBackup(backup, destination);
            throw syncError;
          }
        }
        try {
          await fs.rename(temporary, destination);
          await this.syncJobsDirectory();
        } catch (replacementError) {
          if (movedExisting) {
            await this.restoreBackup(backup, destination);
          }
          throw replacementError;
        }
        await fs
          .rm(backup, { force: true })
          .then(() => this.syncJobsDirectory())
          .catch(() => undefined);
      }
    } finally {
      if (handle) await handle.close().catch(() => undefined);
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private async restoreBackup(
    backup: string,
    destination: string,
  ): Promise<void> {
    await fs
      .rename(backup, destination)
      .then(() => this.syncJobsDirectory())
      .catch(() => undefined);
  }

  private async syncJobsDirectory(): Promise<void> {
    // Node cannot portably open and fsync directory handles on Windows.
    if (process.platform === "win32") return;
    const handle = await fs.open(this.#jobsDirectory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === code
  );
}

function hasAnyErrorCode(
  error: unknown,
  codes: readonly string[],
): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    codes.includes(error.code)
  );
}
