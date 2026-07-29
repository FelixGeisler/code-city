import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import {
  PersistentJobQueue,
  type JobRecord,
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
