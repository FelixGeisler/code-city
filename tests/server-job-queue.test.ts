import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { EVOLUTION_BUNDLE_LIMITS } from "../packages/core/src/evolution.js";
import {
  JobTaskFailure,
  PersistentJobQueue,
  type JobRecord,
  type JobResult,
} from "../apps/server/src/job-queue.js";

const temporaryDirectories: string[] = [];
const queues: PersistentJobQueue[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "code-city-server-jobs-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

async function waitFor(
  queue: PersistentJobQueue,
  id: string,
  predicate: (record: JobRecord) => boolean,
  timeoutMilliseconds = 3_000,
): Promise<JobRecord> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const record = queue.get(id);
    if (record && predicate(record)) return record;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Job '${id}' did not reach the expected state.`);
}

function cityModelResult(token: string = randomUUID()): JobResult {
  return Object.freeze({
    kind: "city-model",
    artifactToken: token,
    artifactUrl: `/api/v1/artifacts/${token}/city-model.json`,
  });
}

function historyResult(token: string = randomUUID()): JobResult {
  return Object.freeze({
    ...cityModelResult(token),
    evolution: Object.freeze({
      artifactUrl: `/api/v1/artifacts/${token}/evolution.json`,
      size: 123,
      sha256: "a".repeat(64),
    }),
  });
}

it("validates, persists, and reloads structured task failures", async () => {
  expect(
    () =>
      new JobTaskFailure(
        "not-a-failure-code" as unknown as ConstructorParameters<
          typeof JobTaskFailure
        >[0],
      ),
  ).toThrow("Job task failure code is invalid.");

  const dataDirectory = await temporaryDirectory();
  const queue = await PersistentJobQueue.open({ dataDirectory });
  queues.push(queue);
  const queued = await queue.enqueue("analysis", async () => {
    throw new JobTaskFailure("repository-unavailable");
  });
  const failed = await waitFor(
    queue,
    queued.id,
    ({ state }) => state === "failed",
  );
  expect(failed.error).toEqual({
    code: "repository-unavailable",
    message: "The repository is unavailable to the server identity.",
  });
  await queue.close();

  const reopened = await PersistentJobQueue.open({ dataDirectory });
  queues.push(reopened);
  expect(reopened.get(queued.id)).toEqual(failed);
  await reopened.close();

  const persistedPath = path.join(
    dataDirectory,
    "jobs",
    `${queued.id}.json`,
  );
  const malformed = {
    ...failed,
    error: {
      code: "repository-unavailable",
      message: "untrusted remote diagnostics",
    },
  };
  await fs.writeFile(
    persistedPath,
    `${JSON.stringify(malformed)}\n`,
    "utf8",
  );
  const wordingUpgrade = await PersistentJobQueue.open({ dataDirectory });
  queues.push(wordingUpgrade);
  expect(wordingUpgrade.get(queued.id)?.error).toEqual({
    code: "repository-unavailable",
    message: "The repository is unavailable to the server identity.",
  });
  await wordingUpgrade.close();

  await fs.writeFile(
    persistedPath,
    `${JSON.stringify({
      ...failed,
      error: {
        ...failed.error,
        credential: "never-load-this-secret",
      },
    })}\n`,
    "utf8",
  );
  await expect(
    PersistentJobQueue.open({ dataDirectory }),
  ).rejects.toThrow("Invalid persisted job error.");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.allSettled(queues.splice(0).map((queue) => queue.close()));
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

it("awaits durable terminal settlement without wall-clock polling", async () => {
  const queue = await PersistentJobQueue.open({
    dataDirectory: await temporaryDirectory(),
  });
  queues.push(queue);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = await queue.enqueue("analysis", async () => {
    await gate;
  });

  const settlement = queue.waitForTerminal(queued.id);
  release();
  const terminal = await settlement;

  expect(terminal?.state).toBe("completed");
  await expect(queue.waitForTerminal(queued.id)).resolves.toBe(
    terminal,
  );
  await expect(queue.waitForTerminal(randomUUID())).resolves.toBeUndefined();
});

it("does not expose a job whose initial record could not be persisted", async () => {
  const queue = await PersistentJobQueue.open({
    dataDirectory: await temporaryDirectory(),
  });
  queues.push(queue);
  vi.spyOn(fs, "open").mockRejectedValueOnce(
    new Error("Simulated storage failure."),
  );

  await expect(
    queue.enqueue("analysis", async () => undefined),
  ).rejects.toThrow("Simulated storage failure.");
  expect(queue.list()).toEqual([]);
});

it("durably tombstones completed records and preserves live jobs", async () => {
  const dataDirectory = await temporaryDirectory();
  const queue = await PersistentJobQueue.open({ dataDirectory });
  queues.push(queue);
  const completedJob = await queue.enqueue(
    "analysis",
    async () => undefined,
  );
  const completed = await waitFor(
    queue,
    completedJob.id,
    ({ state }) => state === "completed",
  );

  await expect(queue.removeCompleted(completed.id)).resolves.toEqual(
    completed,
  );
  expect(queue.get(completed.id)).toBeUndefined();
  await expect(queue.removeCompleted(completed.id)).resolves.toEqual(
    completed,
  );
  const tombstonePath = path.join(
    dataDirectory,
    "jobs",
    `${completed.id}.json.delete`,
  );
  await expect(fs.lstat(tombstonePath)).resolves.toMatchObject({
    size: expect.any(Number),
  });
  await expect(
    fs.lstat(
      path.join(dataDirectory, "jobs", `${completed.id}.json`),
    ),
  ).rejects.toMatchObject({ code: "ENOENT" });

  const live = await queue.enqueue(
    "analysis",
    ({ signal }) =>
      new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), {
          once: true,
        });
      }),
  );
  const running = await waitFor(
    queue,
    live.id,
    ({ state }) => state === "running",
  );
  await expect(queue.removeCompleted(live.id)).resolves.toEqual(
    running,
  );
  expect(queue.get(live.id)?.state).toBe("running");
  await queue.cancel(live.id);
  await queue.finishRemoval(completed.id);
  await queue.finishRemoval(completed.id);
  await expect(fs.lstat(tombstonePath)).rejects.toMatchObject({
    code: "ENOENT",
  });
  await queue.close();

  const reopened = await PersistentJobQueue.open({ dataDirectory });
  queues.push(reopened);
  expect(reopened.get(completed.id)).toBeUndefined();
  expect(reopened.get(live.id)?.state).toBe("cancelled");
});

it("finishes a committed record deletion tombstone on restart", async () => {
  const dataDirectory = await temporaryDirectory();
  const queue = await PersistentJobQueue.open({ dataDirectory });
  queues.push(queue);
  const queued = await queue.enqueue("analysis", async () => undefined);
  const completed = await waitFor(
    queue,
    queued.id,
    ({ state }) => state === "completed",
  );
  await queue.close();

  const recordPath = path.join(
    dataDirectory,
    "jobs",
    `${completed.id}.json`,
  );
  const tombstonePath = `${recordPath}.delete`;
  await fs.rename(recordPath, tombstonePath);
  await fs.copyFile(tombstonePath, recordPath);
  await fs.copyFile(tombstonePath, `${recordPath}.bak`);

  const reopened = await PersistentJobQueue.open({ dataDirectory });
  queues.push(reopened);
  expect(reopened.get(completed.id)).toBeUndefined();
  await expect(fs.lstat(recordPath)).rejects.toMatchObject({
    code: "ENOENT",
  });
  await expect(fs.lstat(`${recordPath}.bak`)).rejects.toMatchObject({
    code: "ENOENT",
  });
  await expect(fs.lstat(tombstonePath)).resolves.toBeDefined();
  await reopened.finishPendingRemovals();
  await expect(fs.lstat(tombstonePath)).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("validates a deletion tombstone before suppressing record shadows", async () => {
  const dataDirectory = await temporaryDirectory();
  const queue = await PersistentJobQueue.open({ dataDirectory });
  queues.push(queue);
  const queued = await queue.enqueue("analysis", async () => undefined);
  const completed = await waitFor(
    queue,
    queued.id,
    ({ state }) => state === "completed",
  );
  await queue.close();

  const recordPath = path.join(
    dataDirectory,
    "jobs",
    `${completed.id}.json`,
  );
  const backupPath = `${recordPath}.bak`;
  await fs.copyFile(recordPath, backupPath);
  await fs.writeFile(`${recordPath}.delete`, "{}\n", "utf8");

  await expect(
    PersistentJobQueue.open({ dataDirectory }),
  ).rejects.toThrow(/deletion tombstone/iu);
  await expect(fs.lstat(recordPath)).resolves.toBeDefined();
  await expect(fs.lstat(backupPath)).resolves.toBeDefined();
});

it("restores a live record when its persisted bytes changed before deletion", async () => {
  const dataDirectory = await temporaryDirectory();
  const queue = await PersistentJobQueue.open({ dataDirectory });
  queues.push(queue);
  const queued = await queue.enqueue("analysis", async () => undefined);
  const completed = await waitFor(
    queue,
    queued.id,
    ({ state }) => state === "completed",
  );
  const recordPath = path.join(
    dataDirectory,
    "jobs",
    `${completed.id}.json`,
  );
  await fs.writeFile(
    recordPath,
    `${JSON.stringify({ ...completed, kind: "replaced" })}\n`,
    "utf8",
  );

  await expect(queue.removeCompleted(completed.id)).rejects.toThrow(
    /changed before deletion/u,
  );
  expect(queue.get(completed.id)).toEqual(completed);
  await expect(fs.lstat(recordPath)).resolves.toBeDefined();
  await expect(
    fs.lstat(`${recordPath}.delete`),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

it("retries finalization after the tombstone was unlinked but completion failed", async () => {
  const dataDirectory = await temporaryDirectory();
  const queue = await PersistentJobQueue.open({ dataDirectory });
  queues.push(queue);
  const queued = await queue.enqueue("analysis", async () => undefined);
  const completed = await waitFor(
    queue,
    queued.id,
    ({ state }) => state === "completed",
  );
  await queue.removeCompleted(completed.id);
  const tombstone = path.join(
    dataDirectory,
    "jobs",
    `${completed.id}.json.delete`,
  );
  vi.spyOn(fs, "rm").mockImplementationOnce(async (file) => {
    await fs.unlink(file);
    throw new Error("Simulated post-unlink completion failure.");
  });

  await expect(queue.finishRemoval(completed.id)).rejects.toThrow(
    /post-unlink/u,
  );
  await expect(fs.lstat(tombstone)).rejects.toMatchObject({
    code: "ENOENT",
  });
  await expect(queue.removeCompleted(completed.id)).resolves.toEqual(
    completed,
  );
  await expect(queue.finishRemoval(completed.id)).resolves.toBeUndefined();
  await expect(queue.removeCompleted(completed.id)).resolves.toBeUndefined();
});

it("waits for an in-flight enqueue before closing the queue", async () => {
  const queue = await PersistentJobQueue.open({
    dataDirectory: await temporaryDirectory(),
  });
  queues.push(queue);
  const openFile = fs.open.bind(fs);
  let signalWriteStarted: (() => void) | undefined;
  let releaseWrite: (() => void) | undefined;
  const writeStarted = new Promise<void>((resolve) => {
    signalWriteStarted = resolve;
  });
  const writeReleased = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  vi.spyOn(fs, "open").mockImplementationOnce(
    async (file, flags, mode) => {
      signalWriteStarted?.();
      await writeReleased;
      return openFile(file, flags, mode);
    },
  );

  const enqueue = queue.enqueue("analysis", async () => undefined);
  await writeStarted;
  const close = queue.close();
  let closeFinished = false;
  void close.then(() => {
    closeFinished = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(closeFinished).toBe(false);

  releaseWrite?.();
  const record = await enqueue;
  await close;

  expect(queue.get(record.id)?.state).toBe("cancelled");
  expect(queue.list().some(({ state }) => state === "queued")).toBe(false);
});

it("waits for an in-flight queued cancellation before closing", async () => {
  const queue = await PersistentJobQueue.open({
    dataDirectory: await temporaryDirectory(),
  });
  queues.push(queue);
  const first = await queue.enqueue(
    "analysis",
    ({ signal }) =>
      new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      }),
  );
  const second = await queue.enqueue(
    "analysis",
    async () => undefined,
  );
  await waitFor(queue, first.id, ({ state }) => state === "running");
  expect(queue.get(second.id)?.state).toBe("queued");

  const openFile = fs.open.bind(fs);
  let signalWriteStarted: (() => void) | undefined;
  let releaseWrite: (() => void) | undefined;
  const writeStarted = new Promise<void>((resolve) => {
    signalWriteStarted = resolve;
  });
  const writeReleased = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  vi.spyOn(fs, "open").mockImplementationOnce(
    async (file, flags, mode) => {
      signalWriteStarted?.();
      await writeReleased;
      return openFile(file, flags, mode);
    },
  );

  const cancellation = queue.cancel(second.id);
  await writeStarted;
  const close = queue.close();
  let closeFinished = false;
  void close.then(() => {
    closeFinished = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(closeFinished).toBe(false);

  releaseWrite?.();
  expect((await cancellation)?.state).toBe("cancelled");
  await close;

  expect(queue.get(second.id)?.state).toBe("cancelled");
});

it("persists bounded job progress and completion", async () => {
  const dataDirectory = await temporaryDirectory();
  const queue = await PersistentJobQueue.open({ dataDirectory });
  queues.push(queue);

  const queued = await queue.enqueue("analysis", async ({ report }) => {
    await report({ phase: "Analyzing files", current: 2, total: 4 });
  });
  expect(queued.state).toBe("queued");

  const completed = await waitFor(
    queue,
    queued.id,
    ({ state }) => state === "completed",
  );
  expect(completed.progress).toEqual({
    phase: "Analyzing files",
    current: 2,
    total: 4,
  });

  const persisted = JSON.parse(
    await fs.readFile(
      path.join(dataDirectory, "jobs", `${queued.id}.json`),
      "utf8",
    ),
  ) as JobRecord;
  expect(persisted).toEqual(completed);
});

it("captures progress primitives once before persistence", async () => {
  const dataDirectory = await temporaryDirectory();
  const queue = await PersistentJobQueue.open({ dataDirectory });
  queues.push(queue);
  let phaseReads = 0;
  const changingProgress = {
    get phase(): string {
      phaseReads += 1;
      return phaseReads === 1
        ? "Analyzing files"
        : "never-persist-this-secret";
    },
    current: 1,
    total: 2,
  };

  const queued = await queue.enqueue("analysis", async ({ report }) => {
    await report(changingProgress);
  });
  const completed = await waitFor(
    queue,
    queued.id,
    ({ state }) => state === "completed",
  );

  expect(phaseReads).toBe(1);
  expect(completed.progress).toEqual({
    phase: "Analyzing files",
    current: 1,
    total: 2,
  });
  const persisted = await fs.readFile(
    path.join(dataDirectory, "jobs", `${queued.id}.json`),
    "utf8",
  );
  expect(persisted).not.toContain("never-persist-this-secret");
});

it("rejects extra progress fields without persisting credentials", async () => {
  const dataDirectory = await temporaryDirectory();
  const queue = await PersistentJobQueue.open({ dataDirectory });
  queues.push(queue);

  const queued = await queue.enqueue("analysis", async ({ report }) => {
    await report({
      phase: "Analyzing files",
      credential: "never-persist-this-secret",
    } as unknown as Parameters<typeof report>[0]);
  });
  const failed = await waitFor(
    queue,
    queued.id,
    ({ state }) => state === "failed",
  );

  expect(failed.error).toEqual({
    code: "failed",
    message: "Job progress is invalid.",
  });
  expect(failed.progress).toBeUndefined();
  const persisted = await fs.readFile(
    path.join(dataDirectory, "jobs", `${queued.id}.json`),
    "utf8",
  );
  expect(persisted).not.toContain("never-persist-this-secret");
});

it("rejects extra fields in persisted progress", async () => {
  const dataDirectory = await temporaryDirectory();
  const queue = await PersistentJobQueue.open({ dataDirectory });
  queues.push(queue);
  const queued = await queue.enqueue("analysis", async ({ report }) => {
    await report({ phase: "Analyzing files", current: 1, total: 1 });
  });
  const completed = await waitFor(
    queue,
    queued.id,
    ({ state }) => state === "completed",
  );
  await queue.close();
  const file = path.join(dataDirectory, "jobs", `${queued.id}.json`);
  await fs.writeFile(
    file,
    `${JSON.stringify({
      ...completed,
      progress: {
        ...completed.progress,
        credential: "not-allowed",
      },
    })}\n`,
    "utf8",
  );

  await expect(
    PersistentJobQueue.open({ dataDirectory }),
  ).rejects.toThrow("Invalid persisted job progress.");
});

it("settles safely when a thrown value cannot be stringified", async () => {
  const queue = await PersistentJobQueue.open({
    dataDirectory: await temporaryDirectory(),
  });
  queues.push(queue);
  const hostile = {
    toString(): string {
      throw new Error("never-persist-this-secret");
    },
  };
  const queued = await queue.enqueue("analysis", async () => {
    throw hostile;
  });

  const failed = await waitFor(
    queue,
    queued.id,
    ({ state }) => state === "failed",
  );

  expect(failed.error).toEqual({
    code: "failed",
    message: "The job failed.",
  });
  await queue.close();
});

it("provides the job id and strictly persists a city-model result", async () => {
  const dataDirectory = await temporaryDirectory();
  const queue = await PersistentJobQueue.open({ dataDirectory });
  queues.push(queue);
  let result: JobResult | undefined;
  let taskId: string | undefined;

  const queued = await queue.enqueue("analysis", async ({ id }) => {
    taskId = id;
    result = cityModelResult(id);
    return result;
  });
  const completed = await waitFor(
    queue,
    queued.id,
    ({ state }) => state === "completed",
  );

  expect(taskId).toBe(queued.id);
  expect(completed.result).toEqual(result);
  expect(Object.isFrozen(completed.result)).toBe(true);
  await queue.close();

  const reopened = await PersistentJobQueue.open({ dataDirectory });
  queues.push(reopened);
  expect(reopened.get(queued.id)?.result).toEqual(result);
  expect(Object.isFrozen(reopened.get(queued.id)?.result)).toBe(true);
});

it("persists and reloads the model-only source availability state", async () => {
  const dataDirectory = await temporaryDirectory();
  const queue = await PersistentJobQueue.open({ dataDirectory });
  queues.push(queue);
  const queued = await queue.enqueue("analysis", async ({ id }) => ({
    ...cityModelResult(id),
    source: { availability: "not-captured" as const },
  }));
  const completed = await waitFor(
    queue,
    queued.id,
    ({ state }) => state === "completed",
  );
  expect(completed.result?.source).toEqual({
    availability: "not-captured",
  });
  await queue.close();

  const reopened = await PersistentJobQueue.open({ dataDirectory });
  queues.push(reopened);
  expect(reopened.get(queued.id)?.result?.source).toEqual({
    availability: "not-captured",
  });
});

it("strictly persists and reloads optional evolution artifact metadata", async () => {
  const dataDirectory = await temporaryDirectory();
  const queue = await PersistentJobQueue.open({ dataDirectory });
  queues.push(queue);
  const queued = await queue.enqueue(
    "history-analysis",
    async ({ id }) => historyResult(id),
  );
  const completed = await waitFor(
    queue,
    queued.id,
    ({ state }) => state === "completed",
  );
  expect(completed.result).toEqual(historyResult(queued.id));
  expect(Object.isFrozen(completed.result?.evolution)).toBe(true);
  await queue.close();

  const reopened = await PersistentJobQueue.open({ dataDirectory });
  queues.push(reopened);
  expect(reopened.get(queued.id)?.result).toEqual(
    historyResult(queued.id),
  );
  expect(
    Object.isFrozen(reopened.get(queued.id)?.result?.evolution),
  ).toBe(true);
});

it("captures result primitives once before persistence", async () => {
  const dataDirectory = await temporaryDirectory();
  const queue = await PersistentJobQueue.open({ dataDirectory });
  queues.push(queue);
  let expectedUrl: string | undefined;
  let urlReads = 0;

  const queued = await queue.enqueue(
    "analysis",
    async ({ id }) => {
      expectedUrl = `/api/v1/artifacts/${id}/city-model.json`;
      const secretUrl =
        `https://user:never-persist-this-secret@example.test/${id}`;
      return {
        kind: "city-model" as const,
        artifactToken: id,
        get artifactUrl(): string {
          urlReads += 1;
          return urlReads === 1 ? expectedUrl! : secretUrl;
        },
      };
    },
  );
  const completed = await waitFor(
    queue,
    queued.id,
    ({ state }) => state === "completed",
  );

  expect(urlReads).toBe(1);
  expect(completed.result).toEqual({
    kind: "city-model",
    artifactToken: queued.id,
    artifactUrl: expectedUrl,
  });
  const persisted = await fs.readFile(
    path.join(dataDirectory, "jobs", `${queued.id}.json`),
    "utf8",
  );
  expect(persisted).not.toContain("never-persist-this-secret");
  expect((JSON.parse(persisted) as JobRecord).result).toEqual(
    completed.result,
  );
});

it("fails without persisting invalid or credential-bearing results", async () => {
  const dataDirectory = await temporaryDirectory();
  const queue = await PersistentJobQueue.open({ dataDirectory });
  queues.push(queue);
  const invalidResults: readonly ((id: string) => unknown)[] = [
    (id) => ({
      ...cityModelResult(id),
      credential: "never-persist-this-secret",
    }),
    (id) => ({
      ...cityModelResult(id),
      artifactUrl:
        `https://user:never-persist-this-secret@example.test/${id}`,
    }),
    (id) => ({
      ...cityModelResult(id),
      artifactUrl: `/api/v1/artifacts/${randomUUID()}/city-model.json`,
    }),
    (id) => ({
      ...cityModelResult(id),
      artifactToken: "not-a-token",
    }),
    (id) => ({
      ...historyResult(id),
      evolution: {
        ...historyResult(id).evolution,
        artifactUrl:
          `/api/v1/artifacts/${randomUUID()}/evolution.json`,
      },
    }),
    (id) => ({
      ...historyResult(id),
      evolution: {
        ...historyResult(id).evolution,
        sha256: "not-a-digest",
      },
    }),
    (id) => ({
      ...historyResult(id),
      evolution: {
        ...historyResult(id).evolution,
        size: EVOLUTION_BUNDLE_LIMITS.serializedBytes + 1,
      },
    }),
    (id) => ({
      ...historyResult(id),
      evolution: {
        ...historyResult(id).evolution,
        credential: "never-persist-this-secret",
      },
    }),
    () => {
      const otherId = randomUUID();
      return cityModelResult(otherId);
    },
  ];

  for (const invalid of invalidResults) {
    const queued = await queue.enqueue(
      "analysis",
      async ({ id }) => invalid(id) as JobResult,
    );
    const failed = await waitFor(
      queue,
      queued.id,
      ({ state }) => state === "failed",
    );
    expect(failed.error).toEqual({
      code: "failed",
      message: "Job result is invalid.",
    });
    expect(failed.result).toBeUndefined();
    const persisted = await fs.readFile(
      path.join(dataDirectory, "jobs", `${queued.id}.json`),
      "utf8",
    );
    expect(persisted).not.toContain("never-persist-this-secret");
    expect((JSON.parse(persisted) as JobRecord).result).toBeUndefined();
  }
});

it("rejects malformed results and results on non-completed records", async () => {
  const dataDirectory = await temporaryDirectory();
  const queue = await PersistentJobQueue.open({ dataDirectory });
  queues.push(queue);
  const queued = await queue.enqueue(
    "analysis",
    async ({ id }) => cityModelResult(id),
  );
  const completed = await waitFor(
    queue,
    queued.id,
    ({ state }) => state === "completed",
  );
  await queue.close();
  const file = path.join(dataDirectory, "jobs", `${queued.id}.json`);

  await fs.writeFile(
    file,
    `${JSON.stringify({
      ...completed,
      result: {
        ...completed.result,
        arbitrary: "not-allowed",
      },
    })}\n`,
    "utf8",
  );
  await expect(
    PersistentJobQueue.open({ dataDirectory }),
  ).rejects.toThrow("Invalid persisted job result.");

  await fs.writeFile(
    file,
    `${JSON.stringify({ ...completed, state: "running" })}\n`,
    "utf8",
  );
  await expect(
    PersistentJobQueue.open({ dataDirectory }),
  ).rejects.toThrow("Invalid persisted job result state.");

  await fs.writeFile(
    file,
    `${JSON.stringify({
      ...completed,
      result: cityModelResult(randomUUID()),
    })}\n`,
    "utf8",
  );
  await expect(
    PersistentJobQueue.open({ dataDirectory }),
  ).rejects.toThrow("Invalid persisted job result.");
});

it("cancels an active job and keeps the terminal state stable", async () => {
  const queue = await PersistentJobQueue.open({
    dataDirectory: await temporaryDirectory(),
  });
  queues.push(queue);

  const queued = await queue.enqueue(
    "analysis",
    ({ signal }) =>
      new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      }),
  );
  await waitFor(queue, queued.id, ({ state }) => state === "running");

  const cancelled = await queue.cancel(queued.id);
  expect(cancelled?.state).toBe("cancelled");
  expect(cancelled?.error?.code).toBe("cancelled");
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(queue.get(queued.id)?.state).toBe("cancelled");
});

it("waits for active abort cleanup before close resolves", async () => {
  const queue = await PersistentJobQueue.open({
    dataDirectory: await temporaryDirectory(),
  });
  queues.push(queue);
  let cleanupFinished = false;
  const queued = await queue.enqueue(
    "analysis",
    ({ signal }) =>
      new Promise<void>((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            setTimeout(() => {
              cleanupFinished = true;
              resolve();
            }, 30);
          },
          { once: true },
        );
      }),
  );
  await waitFor(queue, queued.id, ({ state }) => state === "running");

  await queue.close();

  expect(cleanupFinished).toBe(true);
  expect(queue.get(queued.id)?.state).toBe("cancelled");
});

it("finalizes completed and failed jobs exactly once", async () => {
  for (const expectedState of ["completed", "failed"] as const) {
    const queue = await PersistentJobQueue.open({
      dataDirectory: await temporaryDirectory(),
    });
    queues.push(queue);
    const finalized: JobRecord[] = [];
    let signalFinalized: (() => void) | undefined;
    const finalization = new Promise<void>((resolve) => {
      signalFinalized = resolve;
    });
    let result: JobResult | undefined;

    const queued = await queue.enqueue(
      "analysis",
      async ({ id }) => {
        if (expectedState === "failed") {
          throw new Error("Expected task failure.");
        }
        result = cityModelResult(id);
        return result;
      },
      {
        finalize: async (record) => {
          finalized.push(record);
          signalFinalized?.();
        },
      },
    );

    await finalization;
    expect(queue.get(queued.id)?.state).toBe("running");
    expect(finalized).toHaveLength(1);
    expect(finalized[0]?.state).toBe(expectedState);
    expect(finalized[0]?.result).toEqual(
      expectedState === "completed" ? result : undefined,
    );
    await waitFor(
      queue,
      queued.id,
      ({ state }) => state === expectedState,
    );
    await queue.close();
    expect(finalized).toHaveLength(1);
  }
});

it("does not publish completion before its finalizer settles", async () => {
  const queue = await PersistentJobQueue.open({
    dataDirectory: await temporaryDirectory(),
  });
  queues.push(queue);
  let signalFinalizerStarted: (() => void) | undefined;
  let releaseFinalizer: (() => void) | undefined;
  const finalizerStarted = new Promise<void>((resolve) => {
    signalFinalizerStarted = resolve;
  });
  const finalizerReleased = new Promise<void>((resolve) => {
    releaseFinalizer = resolve;
  });
  let result: JobResult | undefined;
  const queued = await queue.enqueue(
    "analysis",
    async ({ id }) => {
      result = cityModelResult(id);
      return result;
    },
    {
      finalize: async (prospective) => {
        expect(prospective.state).toBe("completed");
        expect(prospective.result).toEqual(result);
        signalFinalizerStarted?.();
        await finalizerReleased;
      },
    },
  );

  await finalizerStarted;
  expect(queue.get(queued.id)).toMatchObject({
    id: queued.id,
    state: "running",
  });
  expect(queue.get(queued.id)?.result).toBeUndefined();
  expect(queue.list().find(({ id }) => id === queued.id)?.state).toBe(
    "running",
  );

  releaseFinalizer?.();
  const completed = await waitFor(
    queue,
    queued.id,
    ({ state }) => state === "completed",
  );
  expect(completed.result).toEqual(result);
  expect((await queue.cancel(queued.id))?.state).toBe("completed");
  expect(queue.get(queued.id)?.state).toBe("completed");
});

it("captures enqueue cleanup callbacks exactly once before persistence", async () => {
  const queue = await PersistentJobQueue.open({
    dataDirectory: await temporaryDirectory(),
  });
  queues.push(queue);
  const expected = vi.fn(async (_record: JobRecord) => undefined);
  const unexpected = vi.fn(async (_record: JobRecord) => undefined);
  const expectedRollback = vi.fn(async (_record: JobRecord) => undefined);
  const unexpectedRollback = vi.fn(async (_record: JobRecord) => undefined);
  let finalizerReads = 0;
  let rollbackReads = 0;
  const options = {
    get finalize(): (record: JobRecord) => Promise<void> {
      finalizerReads += 1;
      return finalizerReads === 1 ? expected : unexpected;
    },
    get rollback(): (record: JobRecord) => Promise<void> {
      rollbackReads += 1;
      return rollbackReads === 1 ? expectedRollback : unexpectedRollback;
    },
  };

  const queued = await queue.enqueue(
    "analysis",
    async () => undefined,
    options,
  );
  await waitFor(queue, queued.id, ({ state }) => state === "completed");
  await queue.close();

  expect(finalizerReads).toBe(1);
  expect(rollbackReads).toBe(1);
  expect(expected).toHaveBeenCalledTimes(1);
  expect(expected.mock.calls[0]?.[0]).toMatchObject({
    id: queued.id,
    state: "completed",
  });
  expect(unexpected).not.toHaveBeenCalled();
  expect(expectedRollback).not.toHaveBeenCalled();
  expect(unexpectedRollback).not.toHaveBeenCalled();
});

it("records a generic cleanup failure after completion or task failure", async () => {
  for (const taskState of ["completed", "failed"] as const) {
    const dataDirectory = await temporaryDirectory();
    const queue = await PersistentJobQueue.open({ dataDirectory });
    queues.push(queue);
    const finalize = vi.fn(async (_record: JobRecord) => {
      throw new Error(
        "never-persist-this-secret at C:\\private\\job-workspace",
      );
    });
    const queued = await queue.enqueue(
      "analysis",
      async ({ id }) => {
        if (taskState === "failed") {
          throw new Error("Expected task failure.");
        }
        return cityModelResult(id);
      },
      { finalize },
    );

    const failed = await waitFor(
      queue,
      queued.id,
      (record) =>
        record.state === "failed" &&
        record.error?.message === "The job cleanup did not complete.",
    );

    expect(failed.error).toEqual({
      code: "failed",
      message: "The job cleanup did not complete.",
    });
    expect(failed.result).toBeUndefined();
    expect(finalize).toHaveBeenCalledTimes(1);
    const persisted = await fs.readFile(
      path.join(dataDirectory, "jobs", `${queued.id}.json`),
      "utf8",
    );
    expect(persisted).not.toContain("never-persist-this-secret");
    expect(persisted).not.toContain("private");
    await queue.close();
    expect(finalize).toHaveBeenCalledTimes(1);
  }
});

it("compensates partial finalization when the finalizer rejects", async () => {
  const dataDirectory = await temporaryDirectory();
  const queue = await PersistentJobQueue.open({ dataDirectory });
  queues.push(queue);
  const retained = new Set<string>();
  const finalize = vi.fn(async (prospective: JobRecord) => {
    expect(prospective.state).toBe("completed");
    retained.add(prospective.result!.artifactToken);
    throw new Error("never-persist-this-secret from finalization");
  });
  const rollback = vi.fn(async (prospective: JobRecord) => {
    expect(prospective.state).toBe("completed");
    retained.delete(prospective.result!.artifactToken);
  });
  const queued = await queue.enqueue(
    "analysis",
    async ({ id }) => cityModelResult(id),
    { finalize, rollback },
  );

  const failed = await waitFor(
    queue,
    queued.id,
    (record) =>
      record.state === "failed" &&
      record.error?.message === "The job cleanup did not complete.",
  );

  expect(failed.result).toBeUndefined();
  expect(retained).toEqual(new Set());
  expect(finalize).toHaveBeenCalledTimes(1);
  expect(rollback).toHaveBeenCalledTimes(1);
  const persisted = await fs.readFile(
    path.join(dataDirectory, "jobs", `${queued.id}.json`),
    "utf8",
  );
  expect(persisted).not.toContain("never-persist-this-secret");
  expect(JSON.parse(persisted)).toEqual(failed);
  await queue.close();
  expect(finalize).toHaveBeenCalledTimes(1);
  expect(rollback).toHaveBeenCalledTimes(1);
});

it("finalizes a queued cancellation once without starting its task", async () => {
  const queue = await PersistentJobQueue.open({
    dataDirectory: await temporaryDirectory(),
  });
  queues.push(queue);
  let signalBlockerStarted: (() => void) | undefined;
  const blockerStarted = new Promise<void>((resolve) => {
    signalBlockerStarted = resolve;
  });
  const blocker = await queue.enqueue(
    "analysis",
    ({ signal }) =>
      new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
        signalBlockerStarted?.();
      }),
  );
  const task = vi.fn(async ({ id }: { id: string }) => cityModelResult(id));
  let signalFinalizerStarted: (() => void) | undefined;
  let releaseFinalizer: (() => void) | undefined;
  const finalizerStarted = new Promise<void>((resolve) => {
    signalFinalizerStarted = resolve;
  });
  const finalizerReleased = new Promise<void>((resolve) => {
    releaseFinalizer = resolve;
  });
  const finalize = vi.fn(async (_record: JobRecord) => {
    signalFinalizerStarted?.();
    await finalizerReleased;
  });
  const queued = await queue.enqueue("analysis", task, { finalize });
  await waitFor(queue, blocker.id, ({ state }) => state === "running");
  await blockerStarted;
  expect(queue.get(queued.id)?.state).toBe("queued");

  const firstCancellation = queue.cancel(queued.id);
  const secondCancellation = queue.cancel(queued.id);
  expect(secondCancellation).toBe(firstCancellation);
  await finalizerStarted;
  expect(queue.get(queued.id)?.state).toBe("queued");
  expect(queue.list().find(({ id }) => id === queued.id)?.state).toBe(
    "queued",
  );
  expect(task).not.toHaveBeenCalled();

  releaseFinalizer?.();
  const [first, second] = await Promise.all([
    firstCancellation,
    secondCancellation,
  ]);

  expect(first?.state).toBe("cancelled");
  expect(second?.state).toBe("cancelled");
  expect(first?.result).toBeUndefined();
  expect(task).not.toHaveBeenCalled();
  expect(finalize).toHaveBeenCalledTimes(1);
  expect(finalize.mock.calls[0]?.[0]).toMatchObject({
    id: queued.id,
    state: "cancelled",
    error: { code: "cancelled" },
  });
  await queue.close();
  expect(finalize).toHaveBeenCalledTimes(1);
});

it("records a generic cleanup failure for a queued cancellation", async () => {
  const dataDirectory = await temporaryDirectory();
  const queue = await PersistentJobQueue.open({ dataDirectory });
  queues.push(queue);
  let signalBlockerStarted: (() => void) | undefined;
  const blockerStarted = new Promise<void>((resolve) => {
    signalBlockerStarted = resolve;
  });
  const blocker = await queue.enqueue(
    "analysis",
    ({ signal }) =>
      new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
        signalBlockerStarted?.();
      }),
  );
  const task = vi.fn(async ({ id }: { id: string }) => cityModelResult(id));
  const finalize = vi.fn(async (_record: JobRecord) => {
    throw new Error("never-persist-this-secret in queued workspace");
  });
  const queued = await queue.enqueue("analysis", task, { finalize });
  await waitFor(queue, blocker.id, ({ state }) => state === "running");
  await blockerStarted;

  const failed = await queue.cancel(queued.id);

  expect(failed).toMatchObject({
    id: queued.id,
    state: "failed",
    error: {
      code: "failed",
      message: "The job cleanup did not complete.",
    },
  });
  expect(failed?.result).toBeUndefined();
  expect(task).not.toHaveBeenCalled();
  expect(finalize).toHaveBeenCalledTimes(1);
  const persisted = await fs.readFile(
    path.join(dataDirectory, "jobs", `${queued.id}.json`),
    "utf8",
  );
  expect(persisted).not.toContain("never-persist-this-secret");
  await queue.close();
  expect(finalize).toHaveBeenCalledTimes(1);
});

it("finalizes an active cancellation once and close awaits it", async () => {
  const queue = await PersistentJobQueue.open({
    dataDirectory: await temporaryDirectory(),
  });
  queues.push(queue);
  let signalTaskAborted: (() => void) | undefined;
  let signalTaskStarted: (() => void) | undefined;
  let releaseTask: (() => void) | undefined;
  const taskStarted = new Promise<void>((resolve) => {
    signalTaskStarted = resolve;
  });
  const taskAborted = new Promise<void>((resolve) => {
    signalTaskAborted = resolve;
  });
  const taskReleased = new Promise<void>((resolve) => {
    releaseTask = resolve;
  });
  let signalFinalizerStarted: (() => void) | undefined;
  let releaseFinalizer: (() => void) | undefined;
  const finalizerStarted = new Promise<void>((resolve) => {
    signalFinalizerStarted = resolve;
  });
  const finalizerReleased = new Promise<void>((resolve) => {
    releaseFinalizer = resolve;
  });
  const finalized: JobRecord[] = [];
  const queued = await queue.enqueue(
    "analysis",
    async ({ id, signal }) => {
      await new Promise<void>((resolve) => {
        const onAbort = (): void => {
          signalTaskAborted?.();
          resolve();
        };
        signal.addEventListener("abort", onAbort, { once: true });
        signalTaskStarted?.();
        if (signal.aborted) onAbort();
      });
      await taskReleased;
      return cityModelResult(id);
    },
    {
      finalize: async (record) => {
        finalized.push(record);
        signalFinalizerStarted?.();
        await finalizerReleased;
      },
    },
  );
  await waitFor(queue, queued.id, ({ state }) => state === "running");
  await taskStarted;

  const cancellation = queue.cancel(queued.id);
  const duplicateCancellation = queue.cancel(queued.id);
  expect(duplicateCancellation).toBe(cancellation);
  await taskAborted;
  const close = queue.close();
  let cancellationFinished = false;
  void cancellation.then(() => {
    cancellationFinished = true;
  });
  let closeFinished = false;
  void close.then(() => {
    closeFinished = true;
  });
  releaseTask?.();
  await finalizerStarted;
  await new Promise((resolve) => setTimeout(resolve, 10));

  expect(closeFinished).toBe(false);
  expect(cancellationFinished).toBe(false);
  expect(queue.get(queued.id)?.state).toBe("running");
  expect(queue.get(queued.id)?.result).toBeUndefined();
  expect(finalized).toHaveLength(1);
  expect(finalized[0]).toMatchObject({
    id: queued.id,
    state: "cancelled",
  });
  expect(finalized[0]?.result).toBeUndefined();

  releaseFinalizer?.();
  expect((await cancellation)?.state).toBe("cancelled");
  expect((await duplicateCancellation)?.state).toBe("cancelled");
  await close;
  expect(closeFinished).toBe(true);
  expect(cancellationFinished).toBe(true);
  expect(queue.get(queued.id)?.state).toBe("cancelled");
  expect(finalized).toHaveLength(1);
});

it("records a generic cleanup failure for an active cancellation", async () => {
  const dataDirectory = await temporaryDirectory();
  const queue = await PersistentJobQueue.open({ dataDirectory });
  queues.push(queue);
  let signalTaskStarted: (() => void) | undefined;
  const taskStarted = new Promise<void>((resolve) => {
    signalTaskStarted = resolve;
  });
  const finalize = vi.fn(async (_record: JobRecord) => {
    throw new Error("never-persist-this-secret in active workspace");
  });
  const queued = await queue.enqueue(
    "analysis",
    ({ signal }) =>
      new Promise<void>((resolve) => {
        const onAbort = (): void => resolve();
        signal.addEventListener("abort", onAbort, { once: true });
        signalTaskStarted?.();
        if (signal.aborted) onAbort();
      }),
    { finalize },
  );
  await taskStarted;
  await waitFor(queue, queued.id, ({ state }) => state === "running");

  const failed = await queue.cancel(queued.id);

  expect(failed).toMatchObject({
    state: "failed",
    error: {
      code: "failed",
      message: "The job cleanup did not complete.",
    },
  });
  expect(failed?.result).toBeUndefined();
  expect(finalize).toHaveBeenCalledTimes(1);
  const persisted = await fs.readFile(
    path.join(dataDirectory, "jobs", `${queued.id}.json`),
    "utf8",
  );
  expect(persisted).not.toContain("never-persist-this-secret");
  await queue.close();
  expect(finalize).toHaveBeenCalledTimes(1);
});

it("finalizes active and queued jobs during shutdown", async () => {
  const queue = await PersistentJobQueue.open({
    dataDirectory: await temporaryDirectory(),
  });
  queues.push(queue);
  const finalized: JobRecord[] = [];
  const finalize = async (record: JobRecord): Promise<void> => {
    finalized.push(record);
  };
  let signalActiveStarted: (() => void) | undefined;
  const activeStarted = new Promise<void>((resolve) => {
    signalActiveStarted = resolve;
  });
  const active = await queue.enqueue(
    "analysis",
    ({ signal }) =>
      new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
        signalActiveStarted?.();
      }),
    { finalize },
  );
  const queuedTask = vi.fn(async ({ id }: { id: string }) =>
    cityModelResult(id),
  );
  const queued = await queue.enqueue("analysis", queuedTask, { finalize });
  await waitFor(queue, active.id, ({ state }) => state === "running");
  await activeStarted;

  await queue.close();

  expect(queuedTask).not.toHaveBeenCalled();
  expect(finalized).toHaveLength(2);
  expect(finalized.map(({ id }) => id).sort()).toEqual(
    [active.id, queued.id].sort(),
  );
  expect(finalized.every(({ state }) => state === "cancelled")).toBe(true);
  expect(finalized.every(({ result }) => result === undefined)).toBe(true);
});

it("rolls back a retained result before exposing terminal persistence failure", async () => {
  const dataDirectory = await temporaryDirectory();
  const queue = await PersistentJobQueue.open({ dataDirectory });
  queues.push(queue);
  const retained = new Set<string>();
  let signalFinalizerStarted: (() => void) | undefined;
  let releaseFinalizer: (() => void) | undefined;
  const finalizerStarted = new Promise<void>((resolve) => {
    signalFinalizerStarted = resolve;
  });
  const finalizerReleased = new Promise<void>((resolve) => {
    releaseFinalizer = resolve;
  });
  let signalRollbackStarted: (() => void) | undefined;
  let releaseRollback: (() => void) | undefined;
  const rollbackStarted = new Promise<void>((resolve) => {
    signalRollbackStarted = resolve;
  });
  const rollbackReleased = new Promise<void>((resolve) => {
    releaseRollback = resolve;
  });
  let result: JobResult | undefined;
  const rollback = vi.fn(async (prospective: JobRecord) => {
    expect(prospective.state).toBe("completed");
    expect(prospective.result).toEqual(result);
    retained.delete(prospective.result!.artifactToken);
    signalRollbackStarted?.();
    await rollbackReleased;
  });
  const queued = await queue.enqueue(
    "analysis",
    async ({ id }) => {
      result = cityModelResult(id);
      return result;
    },
    {
      finalize: async (prospective) => {
        expect(prospective.state).toBe("completed");
        expect(prospective.result).toEqual(result);
        retained.add(prospective.result!.artifactToken);
        signalFinalizerStarted?.();
        await finalizerReleased;
      },
      rollback,
    },
  );
  await finalizerStarted;
  expect(queue.get(queued.id)?.state).toBe("running");
  expect(queue.get(queued.id)?.result).toBeUndefined();
  expect(retained).toEqual(new Set([queued.id]));
  vi.spyOn(fs, "open").mockRejectedValueOnce(
    new Error("Simulated terminal storage failure."),
  );

  releaseFinalizer?.();
  await rollbackStarted;
  const close = queue.close();
  let closeFinished = false;
  void close.then(() => {
    closeFinished = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));

  expect(closeFinished).toBe(false);
  expect(queue.get(queued.id)?.state).toBe("running");
  expect(queue.get(queued.id)?.result).toBeUndefined();
  expect(retained).toEqual(new Set());
  expect(rollback).toHaveBeenCalledTimes(1);

  releaseRollback?.();
  await close;
  const failed = queue.get(queued.id)!;
  expect(failed).toMatchObject({
    state: "failed",
    error: {
      code: "failed",
      message: "The job terminal state could not be persisted.",
    },
  });
  expect(failed.result).toBeUndefined();
  const persisted = JSON.parse(
    await fs.readFile(
      path.join(dataDirectory, "jobs", `${queued.id}.json`),
      "utf8",
    ),
  ) as JobRecord;
  expect(persisted).toEqual(failed);
  expect(queue.get(queued.id)).toEqual(failed);
  expect(rollback).toHaveBeenCalledTimes(1);
});

it("does not expose rollback failures or a completed result", async () => {
  const dataDirectory = await temporaryDirectory();
  const queue = await PersistentJobQueue.open({ dataDirectory });
  queues.push(queue);
  const retained = new Set<string>();
  let signalFinalizerStarted: (() => void) | undefined;
  let releaseFinalizer: (() => void) | undefined;
  const finalizerStarted = new Promise<void>((resolve) => {
    signalFinalizerStarted = resolve;
  });
  const finalizerReleased = new Promise<void>((resolve) => {
    releaseFinalizer = resolve;
  });
  const rollback = vi.fn(async (_prospective: JobRecord) => {
    throw new Error("never-persist-this-secret from rollback");
  });
  const queued = await queue.enqueue(
    "analysis",
    async ({ id }) => cityModelResult(id),
    {
      finalize: async (prospective) => {
        retained.add(prospective.result!.artifactToken);
        signalFinalizerStarted?.();
        await finalizerReleased;
      },
      rollback,
    },
  );
  await finalizerStarted;
  vi.spyOn(fs, "open").mockRejectedValueOnce(
    new Error("Simulated terminal storage failure."),
  );

  releaseFinalizer?.();
  const failed = await waitFor(
    queue,
    queued.id,
    (record) =>
      record.state === "failed" &&
      record.error?.message === "The job cleanup did not complete.",
  );

  expect(failed.result).toBeUndefined();
  expect(retained).toEqual(new Set([queued.id]));
  expect(rollback).toHaveBeenCalledTimes(1);
  const persisted = await fs.readFile(
    path.join(dataDirectory, "jobs", `${queued.id}.json`),
    "utf8",
  );
  expect(persisted).not.toContain("never-persist-this-secret");
  expect(JSON.parse(persisted)).toEqual(failed);
  await queue.close();
  expect(rollback).toHaveBeenCalledTimes(1);
});

it("finalizes a queued cancellation when its terminal write fails", async () => {
  const queue = await PersistentJobQueue.open({
    dataDirectory: await temporaryDirectory(),
  });
  queues.push(queue);
  let signalBlockerStarted: (() => void) | undefined;
  const blockerStarted = new Promise<void>((resolve) => {
    signalBlockerStarted = resolve;
  });
  const blocker = await queue.enqueue(
    "analysis",
    ({ signal }) =>
      new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
        signalBlockerStarted?.();
      }),
  );
  const task = vi.fn(async ({ id }: { id: string }) => cityModelResult(id));
  const finalized: JobRecord[] = [];
  const queued = await queue.enqueue(
    "analysis",
    task,
    {
      finalize: async (record) => {
        finalized.push(record);
      },
    },
  );
  await waitFor(queue, blocker.id, ({ state }) => state === "running");
  await blockerStarted;
  vi.spyOn(fs, "open").mockRejectedValue(
    new Error("Simulated terminal storage failure."),
  );

  const failed = await queue.cancel(queued.id);

  expect(task).not.toHaveBeenCalled();
  expect(failed).toMatchObject({
    id: queued.id,
    state: "failed",
    error: {
      code: "failed",
      message: "The job terminal state could not be persisted.",
    },
  });
  expect(queue.get(queued.id)).toEqual(failed);
  expect(finalized).toHaveLength(1);
  expect(finalized[0]).toMatchObject({
    id: queued.id,
    state: "cancelled",
    error: {
      code: "cancelled",
      message: "The job was cancelled before it started.",
    },
  });
  expect(finalized[0]?.result).toBeUndefined();
  await queue.close();
  expect(finalized).toHaveLength(1);
});

it("finalizes a failed task when its terminal write fails", async () => {
  const queue = await PersistentJobQueue.open({
    dataDirectory: await temporaryDirectory(),
  });
  queues.push(queue);
  let signalTaskStarted: (() => void) | undefined;
  let releaseTask: (() => void) | undefined;
  const taskStarted = new Promise<void>((resolve) => {
    signalTaskStarted = resolve;
  });
  const taskReleased = new Promise<void>((resolve) => {
    releaseTask = resolve;
  });
  let signalFinalized: (() => void) | undefined;
  const finalization = new Promise<void>((resolve) => {
    signalFinalized = resolve;
  });
  const finalized: JobRecord[] = [];
  const queued = await queue.enqueue(
    "analysis",
    async () => {
      signalTaskStarted?.();
      await taskReleased;
      throw new Error("Expected task failure.");
    },
    {
      finalize: async (record) => {
        finalized.push(record);
        signalFinalized?.();
      },
    },
  );
  await taskStarted;
  await waitFor(queue, queued.id, ({ state }) => state === "running");
  vi.spyOn(fs, "open").mockRejectedValueOnce(
    new Error("Simulated terminal storage failure."),
  );

  releaseTask?.();
  await finalization;

  expect(queue.get(queued.id)?.state).toBe("running");
  expect(finalized).toHaveLength(1);
  expect(finalized[0]).toMatchObject({
    id: queued.id,
    state: "failed",
    error: {
      code: "failed",
      message: "Expected task failure.",
    },
  });
  expect(finalized[0]?.result).toBeUndefined();
  const failed = await waitFor(
    queue,
    queued.id,
    (record) =>
      record.state === "failed" &&
      record.error?.message ===
        "The job terminal state could not be persisted.",
  );
  expect(failed.result).toBeUndefined();
  await queue.close();
  expect(finalized).toHaveLength(1);
});

it("awaits active finalization when cancellation persistence fails", async () => {
  const queue = await PersistentJobQueue.open({
    dataDirectory: await temporaryDirectory(),
  });
  queues.push(queue);
  let signalTaskStarted: (() => void) | undefined;
  const taskStarted = new Promise<void>((resolve) => {
    signalTaskStarted = resolve;
  });
  let signalFinalizerStarted: (() => void) | undefined;
  let releaseFinalizer: (() => void) | undefined;
  const finalizerStarted = new Promise<void>((resolve) => {
    signalFinalizerStarted = resolve;
  });
  const finalizerReleased = new Promise<void>((resolve) => {
    releaseFinalizer = resolve;
  });
  const finalized: JobRecord[] = [];
  const queued = await queue.enqueue(
    "analysis",
    ({ signal }) =>
      new Promise<void>((resolve) => {
        const onAbort = (): void => resolve();
        signal.addEventListener("abort", onAbort, { once: true });
        signalTaskStarted?.();
        if (signal.aborted) onAbort();
      }),
    {
      finalize: async (record) => {
        finalized.push(record);
        signalFinalizerStarted?.();
        await finalizerReleased;
      },
    },
  );
  await taskStarted;
  await waitFor(queue, queued.id, ({ state }) => state === "running");
  vi.spyOn(fs, "open").mockRejectedValue(
    new Error("Simulated terminal storage failure."),
  );

  const cancellation = queue.cancel(queued.id);
  await finalizerStarted;
  const close = queue.close();
  let cancellationFinished = false;
  void cancellation.then(() => {
    cancellationFinished = true;
  });
  let closeFinished = false;
  void close.then(() => {
    closeFinished = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));

  expect(closeFinished).toBe(false);
  expect(cancellationFinished).toBe(false);
  expect(queue.get(queued.id)?.state).toBe("running");
  expect(finalized).toHaveLength(1);
  expect(finalized[0]).toMatchObject({
    id: queued.id,
    state: "cancelled",
    error: { code: "cancelled" },
  });
  expect(finalized[0]?.result).toBeUndefined();

  releaseFinalizer?.();
  const failed = await cancellation;
  expect(failed).toMatchObject({
    state: "failed",
    error: {
      code: "failed",
      message: "The job terminal state could not be persisted.",
    },
  });
  await close;
  expect(cancellationFinished).toBe(true);
  expect(queue.get(queued.id)).toEqual(failed);
  expect(finalized).toHaveLength(1);
});

it("installs a cleanup failure after persistence is exhausted", async () => {
  const dataDirectory = await temporaryDirectory();
  const queue = await PersistentJobQueue.open({ dataDirectory });
  queues.push(queue);
  let signalFinalizerStarted: (() => void) | undefined;
  let releaseFinalizer: (() => void) | undefined;
  const finalizerStarted = new Promise<void>((resolve) => {
    signalFinalizerStarted = resolve;
  });
  const finalizerReleased = new Promise<void>((resolve) => {
    releaseFinalizer = resolve;
  });
  const finalize = vi.fn(async (_record: JobRecord) => {
    signalFinalizerStarted?.();
    await finalizerReleased;
    throw new Error("never-persist-this-secret in cleanup path");
  });
  const queued = await queue.enqueue(
    "analysis",
    async ({ id }) => cityModelResult(id),
    { finalize },
  );
  await finalizerStarted;
  expect(queue.get(queued.id)?.state).toBe("running");
  expect(queue.get(queued.id)?.result).toBeUndefined();
  vi.spyOn(fs, "open").mockRejectedValue(
    new Error("Simulated cleanup-state storage failure."),
  );

  releaseFinalizer?.();
  const failed = await waitFor(
    queue,
    queued.id,
    (record) =>
      record.state === "failed" &&
      record.error?.message === "The job cleanup did not complete.",
  );

  expect(failed.result).toBeUndefined();
  expect(finalize).toHaveBeenCalledTimes(1);
  const persisted = JSON.parse(
    await fs.readFile(
      path.join(dataDirectory, "jobs", `${queued.id}.json`),
      "utf8",
    ),
  ) as JobRecord;
  expect(persisted.state).toBe("running");
  expect(persisted.result).toBeUndefined();
  await queue.close();
  expect(finalize).toHaveBeenCalledTimes(1);
});

it("syncs record contents before committing POSIX directory metadata", async () => {
  const dataDirectory = await temporaryDirectory();
  const queue = await PersistentJobQueue.open({ dataDirectory });
  queues.push(queue);
  let signalTaskStarted: (() => void) | undefined;
  let releaseTask: (() => void) | undefined;
  const taskStarted = new Promise<void>((resolve) => {
    signalTaskStarted = resolve;
  });
  const taskReleased = new Promise<void>((resolve) => {
    releaseTask = resolve;
  });
  const queued = await queue.enqueue("analysis", async ({ id }) => {
    signalTaskStarted?.();
    await taskReleased;
    return cityModelResult(id);
  });
  await taskStarted;
  await waitFor(queue, queued.id, ({ state }) => state === "running");

  const jobsDirectory = await fs.realpath(
    path.join(dataDirectory, "jobs"),
  );
  const openFile = fs.open.bind(fs);
  const renameFile = fs.rename.bind(fs);
  const removeFile = fs.rm.bind(fs);
  const events: string[] = [];
  const platformDescriptor = Object.getOwnPropertyDescriptor(
    process,
    "platform",
  )!;
  Object.defineProperty(process, "platform", {
    ...platformDescriptor,
    value: "linux",
  });
  const openSpy = vi.spyOn(fs, "open").mockImplementation(
    async (file, flags, mode) => {
      if (path.resolve(String(file)) === jobsDirectory) {
        events.push("open-directory");
        return {
          sync: async () => {
            events.push("sync-directory");
          },
          close: async () => {
            events.push("close-directory");
          },
        } as unknown as Awaited<ReturnType<typeof fs.open>>;
      }
      expect(flags).toBe("wx");
      expect(mode).toBe(0o600);
      events.push("open-temporary");
      const realHandle = await openFile(file, flags, mode);
      return {
        writeFile: async (
          data: string | Uint8Array,
          options?: Parameters<typeof realHandle.writeFile>[1],
        ) => {
          events.push("write-temporary");
          await realHandle.writeFile(data, options);
        },
        sync: async () => {
          events.push("sync-temporary");
          await realHandle.sync();
        },
        close: async () => {
          events.push("close-temporary");
          await realHandle.close();
        },
      } as unknown as Awaited<ReturnType<typeof fs.open>>;
    },
  );
  const renameSpy = vi.spyOn(fs, "rename").mockImplementation(
    async (source, destination) => {
      events.push("rename-record");
      try {
        await renameFile(source, destination);
      } catch {
        await removeFile(destination, { force: true });
        await renameFile(source, destination);
      }
    },
  );

  let completed: JobRecord;
  try {
    releaseTask?.();
    completed = await waitFor(
      queue,
      queued.id,
      ({ state }) => state === "completed",
      15_000,
    );
  } finally {
    Object.defineProperty(process, "platform", platformDescriptor);
    openSpy.mockRestore();
    renameSpy.mockRestore();
  }

  expect(completed!.result?.artifactToken).toBe(queued.id);
  expect(events).toEqual([
    "open-temporary",
    "write-temporary",
    "sync-temporary",
    "close-temporary",
    "rename-record",
    "open-directory",
    "sync-directory",
    "close-directory",
  ]);
}, 20_000);

it("keeps a committed terminal record when backup cleanup fails", async () => {
  const dataDirectory = await temporaryDirectory();
  const queue = await PersistentJobQueue.open({ dataDirectory });
  queues.push(queue);
  let signalTaskStarted: (() => void) | undefined;
  let releaseTask: (() => void) | undefined;
  const taskStarted = new Promise<void>((resolve) => {
    signalTaskStarted = resolve;
  });
  const taskReleased = new Promise<void>((resolve) => {
    releaseTask = resolve;
  });
  const queued = await queue.enqueue("analysis", async ({ id }) => {
    signalTaskStarted?.();
    await taskReleased;
    return cityModelResult(id);
  });
  await taskStarted;
  await waitFor(queue, queued.id, ({ state }) => state === "running");

  const jobsDirectory = await fs.realpath(
    path.join(dataDirectory, "jobs"),
  );
  const destination = path.join(jobsDirectory, `${queued.id}.json`);
  const backup = `${destination}.bak`;
  const openFile = fs.open.bind(fs);
  const renameFile = fs.rename.bind(fs);
  const removeFile = fs.rm.bind(fs);
  let renameCalls = 0;
  let backupRemovals = 0;
  let directorySyncs = 0;
  const platformDescriptor = Object.getOwnPropertyDescriptor(
    process,
    "platform",
  )!;
  Object.defineProperty(process, "platform", {
    ...platformDescriptor,
    value: "linux",
  });
  const openSpy = vi.spyOn(fs, "open").mockImplementation(
    async (file, flags, mode) => {
      if (path.resolve(String(file)) === jobsDirectory) {
        return {
          sync: async () => {
            directorySyncs += 1;
          },
          close: async () => undefined,
        } as unknown as Awaited<ReturnType<typeof fs.open>>;
      }
      return openFile(file, flags, mode);
    },
  );
  const renameSpy = vi.spyOn(fs, "rename").mockImplementation(
    async (source, target) => {
      renameCalls += 1;
      if (renameCalls === 1) {
        throw Object.assign(new Error("Simulated replacement requirement."), {
          code: "EPERM",
        });
      }
      await renameFile(source, target);
    },
  );
  const removeSpy = vi.spyOn(fs, "rm").mockImplementation(
    async (target, options) => {
      if (String(target) === backup) {
        backupRemovals += 1;
        if (backupRemovals === 2) {
          throw new Error("Simulated post-commit backup cleanup failure.");
        }
      }
      await removeFile(target, options);
    },
  );

  let completed: JobRecord;
  try {
    releaseTask?.();
    completed = await waitFor(
      queue,
      queued.id,
      ({ state }) => state === "completed",
      15_000,
    );
  } finally {
    Object.defineProperty(process, "platform", platformDescriptor);
    openSpy.mockRestore();
    renameSpy.mockRestore();
    removeSpy.mockRestore();
  }

  expect(completed!.result?.artifactToken).toBe(queued.id);
  expect(backupRemovals).toBe(2);
  expect(directorySyncs).toBe(3);
  await expect(fs.lstat(backup)).resolves.toBeDefined();
  await queue.close();

  const reopened = await PersistentJobQueue.open({ dataDirectory });
  queues.push(reopened);
  expect(reopened.get(queued.id)).toEqual(completed!);
  await expect(fs.lstat(backup)).rejects.toMatchObject({ code: "ENOENT" });
}, 20_000);

it("marks unfinished persisted work as interrupted after restart", async () => {
  const dataDirectory = await temporaryDirectory();
  const first = await PersistentJobQueue.open({ dataDirectory });
  queues.push(first);
  const queued = await first.enqueue(
    "history-analysis",
    ({ signal }) =>
      new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      }),
  );
  await waitFor(first, queued.id, ({ state }) => state === "running");

  const restarted = await PersistentJobQueue.open({ dataDirectory });
  queues.push(restarted);
  const recovered = restarted.get(queued.id);
  expect(recovered?.state).toBe("failed");
  expect(recovered?.error).toEqual({
    code: "interrupted",
    message: "The server restarted before the job completed.",
  });
  expect(recovered?.result).toBeUndefined();
  const persisted = JSON.parse(
    await fs.readFile(
      path.join(dataDirectory, "jobs", `${queued.id}.json`),
      "utf8",
    ),
  ) as JobRecord;
  expect(persisted.result).toBeUndefined();
});

it("recovers the previous record after an interrupted replacement", async () => {
  const dataDirectory = await temporaryDirectory();
  const first = await PersistentJobQueue.open({ dataDirectory });
  queues.push(first);
  const queued = await first.enqueue("analysis", async () => undefined);
  const completed = await waitFor(
    first,
    queued.id,
    ({ state }) => state === "completed",
  );
  await first.close();
  queues.splice(queues.indexOf(first), 1);

  const destination = path.join(
    dataDirectory,
    "jobs",
    `${completed.id}.json`,
  );
  const backup = `${destination}.bak`;
  await fs.rename(destination, backup);

  const restarted = await PersistentJobQueue.open({ dataDirectory });
  queues.push(restarted);
  expect(restarted.get(completed.id)).toEqual(completed);
  await expect(fs.lstat(backup)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(fs.lstat(destination)).resolves.toBeDefined();
});

it("runs only one job concurrently by default", async () => {
  const queue = await PersistentJobQueue.open({
    dataDirectory: await temporaryDirectory(),
  });
  queues.push(queue);
  let releaseFirst: (() => void) | undefined;
  let signalFirstStarted: (() => void) | undefined;
  const firstStarted = new Promise<void>((resolve) => {
    signalFirstStarted = resolve;
  });
  const first = await queue.enqueue(
    "analysis",
    () =>
      new Promise<void>((resolve) => {
        releaseFirst = resolve;
        signalFirstStarted?.();
      }),
  );
  const second = await queue.enqueue("analysis", async () => undefined);

  await firstStarted;
  await waitFor(queue, first.id, ({ state }) => state === "running");
  expect(queue.get(second.id)?.state).toBe("queued");
  releaseFirst?.();
  await waitFor(queue, second.id, ({ state }) => state === "completed");
});
