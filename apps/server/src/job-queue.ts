import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

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
  readonly code: "cancelled" | "failed" | "interrupted";
  readonly message: string;
}

export interface JobResult {
  readonly kind: "city-model";
  readonly artifactToken: string;
  readonly artifactUrl: string;
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

export interface JobEnqueueOptions {
  readonly finalize?: JobFinalizer;
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
  finalization?: Promise<void>;
}

interface JobRecordChange {
  readonly progress?: JobProgress;
  readonly error?: JobError;
  readonly result?: JobResult;
}

const MAXIMUM_JOB_RECORDS = 10_000;
const MAXIMUM_JOB_FILE_BYTES = 64 * 1024;
const JOB_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const JOB_KIND_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;
const MAXIMUM_PHASE_CHARACTERS = 160;
const CITY_MODEL_ARTIFACT_KEYS = [
  "artifactToken",
  "artifactUrl",
  "kind",
] as const;

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

function validProgress(value: unknown): value is JobProgress {
  if (
    typeof value !== "object" ||
    value === null
  ) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  const phase = candidate["phase"];
  if (
    typeof phase !== "string" ||
    phase.length === 0 ||
    phase.length > MAXIMUM_PHASE_CHARACTERS
  ) {
    return false;
  }
  for (const key of ["current", "total"] as const) {
    const count = candidate[key];
    if (
      count !== undefined &&
      (!Number.isSafeInteger(count) || (count as number) < 0)
    ) {
      return false;
    }
  }
  return (
    candidate["current"] === undefined ||
    candidate["total"] === undefined ||
    (candidate["current"] as number) <= (candidate["total"] as number)
  );
}

function validError(value: unknown): value is JobError {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const code = candidate["code"];
  const message = candidate["message"];
  return (
    (code === "cancelled" ||
      code === "failed" ||
      code === "interrupted") &&
    typeof message === "string" &&
    message.length > 0 &&
    message.length <= 1_024
  );
}

function readResult(value: unknown): JobResult | undefined {
  try {
    if (typeof value !== "object" || value === null) return undefined;
    const candidate = value as Record<string, unknown>;
    const keys = Object.keys(candidate).sort(compareText);
    const kind = candidate["kind"];
    const token = candidate["artifactToken"];
    const url = candidate["artifactUrl"];
    if (
      keys.length !== CITY_MODEL_ARTIFACT_KEYS.length ||
      !keys.every((key, index) => key === CITY_MODEL_ARTIFACT_KEYS[index]) ||
      kind !== "city-model" ||
      typeof token !== "string" ||
      !JOB_ID_PATTERN.test(token) ||
      url !== `/api/v1/artifacts/${token}/city-model.json`
    ) {
      return undefined;
    }
    return Object.freeze({
      kind,
      artifactToken: token,
      artifactUrl: url,
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
    result === undefined ? undefined : readResult(result);
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
  if (
    progress !== undefined &&
    !validProgress(progress)
  ) {
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
    ...(progress === undefined
      ? {}
      : { progress: Object.freeze({ ...progress }) }),
    ...(error === undefined
      ? {}
      : { error: Object.freeze({ ...error }) }),
    ...(parsedResult === undefined
      ? {}
      : { result: parsedResult }),
  });
}

function normalizeProgress(progress: JobProgress): JobProgress {
  if (!validProgress(progress)) {
    throw new Error("Job progress is invalid.");
  }
  return Object.freeze({ ...progress });
}

function normalizeResult(result: JobResult): JobResult {
  const normalized = readResult(result);
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
      : { progress: Object.freeze({ ...change.progress }) }),
    ...(change.error === undefined
      ? {}
      : { error: Object.freeze({ ...change.error }) }),
    ...(state !== "completed" || change.result === undefined
      ? {}
      : { result: Object.freeze({ ...change.result }) }),
  });
}

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.replace(/[\u0000-\u001F\u007F]+/gu, " ").trim();
  return (normalized || "The job failed.").slice(0, 1_024);
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
  readonly #enqueues = new Set<Promise<JobRecord>>();
  readonly #cancellations = new Set<
    Promise<JobRecord | undefined>
  >();
  readonly #runs = new Set<Promise<void>>();
  readonly #transitions = new Map<string, Promise<JobRecord>>();
  readonly #writes = new Map<string, Promise<void>>();
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
    if (!JOB_KIND_PATTERN.test(kind)) {
      throw new Error(
        "Job kind must start with a letter and contain at most 64 lowercase letters, digits, or hyphens.",
      );
    }
    if (this.#records.size >= MAXIMUM_JOB_RECORDS) {
      throw new Error("Job record limit reached.");
    }
    if (
      options.finalize !== undefined &&
      typeof options.finalize !== "function"
    ) {
      throw new Error("Job finalizer must be a function.");
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
    this.#pending.push({
      id: record.id,
      task,
      controller: new AbortController(),
      ...(options.finalize === undefined
        ? {}
        : { finalize: options.finalize }),
    });
    this.pump();
    return record;
  }

  public cancel(id: string): Promise<JobRecord | undefined> {
    if (this.#disposed) {
      return Promise.resolve(this.#records.get(id));
    }
    return this.trackCancellation(id);
  }

  private trackCancellation(
    id: string,
  ): Promise<JobRecord | undefined> {
    const operation = this.cancelJob(id);
    this.#cancellations.add(operation);
    void operation.then(
      () => this.#cancellations.delete(operation),
      () => this.#cancellations.delete(operation),
    );
    return operation;
  }

  private async cancelJob(
    id: string,
  ): Promise<JobRecord | undefined> {
    const record = this.#records.get(id);
    if (!record) return undefined;
    if (isTerminal(record)) return record;
    const queuedIndex = this.#pending.findIndex((job) => job.id === id);
    if (queuedIndex >= 0) {
      const job = this.#pending.splice(queuedIndex, 1)[0]!;
      job.controller.abort();
      const change: JobRecordChange = {
        error: {
          code: "cancelled",
          message: "The job was cancelled before it started.",
        },
      };
      try {
        const cancelled = await this.transition(id, "cancelled", change);
        await this.finalize(job, cancelled);
        return cancelled;
      } catch (error) {
        await this.#transitions.get(id)?.catch(() => undefined);
        const fallback = this.rememberTerminal(
          this.terminalFallback(id, "cancelled", change),
        );
        await this.finalize(job, fallback).catch(() => undefined);
        throw error;
      }
    }
    this.#active.get(id)?.controller.abort();
    return this.transition(id, "cancelled", {
      error: { code: "cancelled", message: "The job was cancelled." },
    });
  }

  public close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#disposed = true;
    this.#closePromise = this.closeJobs();
    return this.#closePromise;
  }

  private async closeJobs(): Promise<void> {
    await Promise.allSettled([...this.#enqueues]);
    await Promise.allSettled([...this.#cancellations]);
    const jobs = [...this.#pending, ...this.#active.values()];
    for (const job of jobs) job.controller.abort();
    await Promise.allSettled(
      jobs.map(({ id }) => this.trackCancellation(id)),
    );
    await Promise.allSettled([...this.#runs]);
    await Promise.allSettled([...this.#writes.values()]);
  }

  private async load(): Promise<void> {
    let entries = await fs.readdir(this.#jobsDirectory, {
      withFileTypes: true,
    });
    if (entries.length > MAXIMUM_JOB_RECORDS) {
      throw new Error("Persisted job record limit exceeded.");
    }
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
        try {
          await fs.lstat(destination);
          await fs.rm(candidate, { force: true });
        } catch (error) {
          if (!hasErrorCode(error, "ENOENT")) throw error;
          await fs.rename(candidate, destination);
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
    let fallback: JobRecord | undefined;
    try {
      await this.transition(job.id, "running");
      if (job.controller.signal.aborted) {
        fallback = this.terminalFallback(job.id, "cancelled", {
          error: { code: "cancelled", message: "The job was cancelled." },
        });
        return;
      }
      const result = await job.task({
        id: job.id,
        signal: job.controller.signal,
        report: async (progress) => {
          if (job.controller.signal.aborted) return;
          await this.transition(job.id, "running", {
            progress: normalizeProgress(progress),
          });
        },
      });
      if (job.controller.signal.aborted) {
        fallback = this.terminalFallback(job.id, "cancelled", {
          error: { code: "cancelled", message: "The job was cancelled." },
        });
        return;
      }
      await this.transition(job.id, "completed", {
        ...(result === undefined
          ? {}
          : { result: normalizeResult(result) }),
      });
    } catch (error) {
      if (job.controller.signal.aborted) {
        fallback = this.terminalFallback(job.id, "cancelled", {
          error: { code: "cancelled", message: "The job was cancelled." },
        });
      } else {
        const change: JobRecordChange = {
          error: { code: "failed", message: safeMessage(error) },
        };
        fallback = this.terminalFallback(job.id, "failed", change);
        try {
          fallback = await this.transition(job.id, "failed", change);
        } catch {
          // A persistence failure must not become an unhandled rejection.
        }
      }
    } finally {
      await this.#transitions.get(job.id)?.catch(() => undefined);
      const current = this.#records.get(job.id);
      const terminal =
        current && isTerminal(current)
          ? current
          : fallback ??
            this.terminalFallback(
              job.id,
              job.controller.signal.aborted ? "cancelled" : "failed",
              job.controller.signal.aborted
                ? {
                    error: {
                      code: "cancelled",
                      message: "The job was cancelled.",
                    },
                  }
                : {
                    error: {
                      code: "failed",
                      message:
                        "The job ended before its terminal state was persisted.",
                    },
                  },
            );
      const remembered = this.rememberTerminal(terminal);
      try {
        await this.finalize(job, remembered);
      } finally {
        this.#active.delete(job.id);
        this.pump();
      }
    }
  }

  private transition(
    id: string,
    state: JobState,
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
    state: JobState,
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

  private terminalFallback(
    id: string,
    state: "completed" | "failed" | "cancelled",
    change: JobRecordChange,
  ): JobRecord {
    const current = this.#records.get(id);
    if (!current) throw new Error(`Unknown job '${id}'.`);
    if (isTerminal(current)) return current;
    return transitionedRecord(
      current,
      state,
      this.#now().toISOString(),
      change,
    );
  }

  private rememberTerminal(record: JobRecord): JobRecord {
    const current = this.#records.get(record.id);
    if (!current) throw new Error(`Unknown job '${record.id}'.`);
    if (isTerminal(current)) return current;
    this.#records.set(record.id, record);
    return record;
  }

  private finalize(job: PendingJob, record: JobRecord): Promise<void> {
    if (!job.finalization) {
      job.finalization =
        job.finalize === undefined
          ? Promise.resolve()
          : Promise.resolve().then(() => job.finalize!(record));
    }
    return job.finalization;
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
    try {
      await fs.writeFile(temporary, bytes, { encoding: "utf8", mode: 0o600 });
      try {
        await fs.rename(temporary, destination);
      } catch (error) {
        if (!hasAnyErrorCode(error, ["EEXIST", "EPERM", "EACCES"])) {
          throw error;
        }
        await fs.rm(backup, { force: true });
        let movedExisting = false;
        try {
          await fs.rename(destination, backup);
          movedExisting = true;
        } catch (moveError) {
          if (!hasErrorCode(moveError, "ENOENT")) throw moveError;
        }
        try {
          await fs.rename(temporary, destination);
        } catch (replacementError) {
          if (movedExisting) {
            await fs.rename(backup, destination).catch(() => undefined);
          }
          throw replacementError;
        }
        await fs.rm(backup, { force: true });
      }
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
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
