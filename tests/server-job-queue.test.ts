import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import {
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
): Promise<JobRecord> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const record = queue.get(id);
    if (record && predicate(record)) return record;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Job '${id}' did not reach the expected state.`);
}

function cityModelResult(token = randomUUID()): JobResult {
  return Object.freeze({
    kind: "city-model",
    artifactToken: token,
    artifactUrl: `/api/v1/artifacts/${token}/city-model.json`,
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.allSettled(queues.splice(0).map((queue) => queue.close()));
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

it("does not expose a job whose initial record could not be persisted", async () => {
  const queue = await PersistentJobQueue.open({
    dataDirectory: await temporaryDirectory(),
  });
  queues.push(queue);
  vi.spyOn(fs, "writeFile").mockRejectedValueOnce(
    new Error("Simulated storage failure."),
  );

  await expect(
    queue.enqueue("analysis", async () => undefined),
  ).rejects.toThrow("Simulated storage failure.");
  expect(queue.list()).toEqual([]);
});

it("waits for an in-flight enqueue before closing the queue", async () => {
  const queue = await PersistentJobQueue.open({
    dataDirectory: await temporaryDirectory(),
  });
  queues.push(queue);
  const writeFile = fs.writeFile.bind(fs);
  let signalWriteStarted: (() => void) | undefined;
  let releaseWrite: (() => void) | undefined;
  const writeStarted = new Promise<void>((resolve) => {
    signalWriteStarted = resolve;
  });
  const writeReleased = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  vi.spyOn(fs, "writeFile").mockImplementationOnce(
    async (file, data, options) => {
      signalWriteStarted?.();
      await writeReleased;
      await writeFile(file, data, options);
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

  const writeFile = fs.writeFile.bind(fs);
  let signalWriteStarted: (() => void) | undefined;
  let releaseWrite: (() => void) | undefined;
  const writeStarted = new Promise<void>((resolve) => {
    signalWriteStarted = resolve;
  });
  const writeReleased = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  vi.spyOn(fs, "writeFile").mockImplementationOnce(
    async (file, data, options) => {
      signalWriteStarted?.();
      await writeReleased;
      await writeFile(file, data, options);
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

it("provides the job id and strictly persists a city-model result", async () => {
  const dataDirectory = await temporaryDirectory();
  const queue = await PersistentJobQueue.open({ dataDirectory });
  queues.push(queue);
  const result = cityModelResult();
  let taskId: string | undefined;

  const queued = await queue.enqueue("analysis", async ({ id }) => {
    taskId = id;
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

it("captures result primitives once before persistence", async () => {
  const dataDirectory = await temporaryDirectory();
  const queue = await PersistentJobQueue.open({ dataDirectory });
  queues.push(queue);
  const token = randomUUID();
  const expectedUrl = `/api/v1/artifacts/${token}/city-model.json`;
  const secretUrl =
    `https://user:never-persist-this-secret@example.test/${token}`;
  let urlReads = 0;
  const changingResult = {
    kind: "city-model" as const,
    artifactToken: token,
    get artifactUrl(): string {
      urlReads += 1;
      return urlReads === 1 ? expectedUrl : secretUrl;
    },
  };

  const queued = await queue.enqueue(
    "analysis",
    async () => changingResult,
  );
  const completed = await waitFor(
    queue,
    queued.id,
    ({ state }) => state === "completed",
  );

  expect(urlReads).toBe(1);
  expect(completed.result).toEqual({
    kind: "city-model",
    artifactToken: token,
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
  const token = randomUUID();
  const invalidResults: readonly unknown[] = [
    {
      ...cityModelResult(token),
      credential: "never-persist-this-secret",
    },
    {
      ...cityModelResult(token),
      artifactUrl:
        `https://user:never-persist-this-secret@example.test/${token}`,
    },
    {
      ...cityModelResult(token),
      artifactUrl: `/api/v1/artifacts/${randomUUID()}/city-model.json`,
    },
    {
      ...cityModelResult(token),
      artifactToken: "not-a-token",
    },
  ];

  for (const invalid of invalidResults) {
    const queued = await queue.enqueue(
      "analysis",
      async () => invalid as JobResult,
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
    async () => cityModelResult(),
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
    const result = cityModelResult();

    const queued = await queue.enqueue(
      "analysis",
      async () => {
        if (expectedState === "failed") {
          throw new Error("Expected task failure.");
        }
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
    expect(queue.get(queued.id)?.state).toBe(expectedState);
    expect(finalized).toHaveLength(1);
    expect(finalized[0]?.state).toBe(expectedState);
    expect(finalized[0]?.result).toEqual(
      expectedState === "completed" ? result : undefined,
    );
    await queue.close();
    expect(finalized).toHaveLength(1);
  }
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
  const task = vi.fn(async () => cityModelResult());
  const finalize = vi.fn(async (_record: JobRecord) => undefined);
  const queued = await queue.enqueue("analysis", task, { finalize });
  await waitFor(queue, blocker.id, ({ state }) => state === "running");
  await blockerStarted;
  expect(queue.get(queued.id)?.state).toBe("queued");

  const [first, second] = await Promise.all([
    queue.cancel(queued.id),
    queue.cancel(queued.id),
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
    async ({ signal }) => {
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
      return cityModelResult();
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
  await taskAborted;
  expect((await cancellation)?.state).toBe("cancelled");
  const close = queue.close();
  let closeFinished = false;
  void close.then(() => {
    closeFinished = true;
  });
  releaseTask?.();
  await finalizerStarted;
  await new Promise((resolve) => setTimeout(resolve, 10));

  expect(closeFinished).toBe(false);
  expect(finalized).toHaveLength(1);
  expect(finalized[0]).toMatchObject({
    id: queued.id,
    state: "cancelled",
  });
  expect(finalized[0]?.result).toBeUndefined();

  releaseFinalizer?.();
  await close;
  expect(closeFinished).toBe(true);
  expect(finalized).toHaveLength(1);
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
  const queuedTask = vi.fn(async () => cityModelResult());
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
  const task = vi.fn(async () => cityModelResult());
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
  vi.spyOn(fs, "writeFile").mockRejectedValue(
    new Error("Simulated terminal storage failure."),
  );

  await expect(queue.cancel(queued.id)).rejects.toThrow(
    "Simulated terminal storage failure.",
  );

  expect(task).not.toHaveBeenCalled();
  expect(queue.get(queued.id)?.state).toBe("cancelled");
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
  vi.spyOn(fs, "writeFile").mockRejectedValueOnce(
    new Error("Simulated terminal storage failure."),
  );

  releaseTask?.();
  await finalization;

  expect(queue.get(queued.id)?.state).toBe("failed");
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
  vi.spyOn(fs, "writeFile").mockRejectedValue(
    new Error("Simulated terminal storage failure."),
  );

  await expect(queue.cancel(queued.id)).rejects.toThrow(
    "Simulated terminal storage failure.",
  );
  await finalizerStarted;
  const close = queue.close();
  let closeFinished = false;
  void close.then(() => {
    closeFinished = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));

  expect(closeFinished).toBe(false);
  expect(queue.get(queued.id)?.state).toBe("cancelled");
  expect(finalized).toHaveLength(1);
  expect(finalized[0]).toMatchObject({
    id: queued.id,
    state: "cancelled",
    error: { code: "cancelled" },
  });
  expect(finalized[0]?.result).toBeUndefined();

  releaseFinalizer?.();
  await close;
  expect(finalized).toHaveLength(1);
});

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
