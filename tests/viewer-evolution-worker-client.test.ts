import { describe, expect, it } from "vitest";

import { DEMO_MODEL } from "../apps/viewer/src/demo-model.js";
import { EvolutionTimelineWorkerClient } from "../apps/viewer/src/evolution-timeline-worker-client.js";
import type { EvolutionWorkerRequest } from "../apps/viewer/src/evolution-timeline-protocol.js";

class FakeEvolutionWorker extends EventTarget {
  readonly requests: EvolutionWorkerRequest[] = [];
  readonly transfers: Transferable[][] = [];
  terminated = false;

  postMessage(value: unknown, transfer: Transferable[] = []): void {
    this.requests.push(value as EvolutionWorkerRequest);
    this.transfers.push(transfer);
  }

  terminate(): void {
    this.terminated = true;
  }

  respond(value: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data: value }));
  }
}

const frame = {
  index: 0,
  sha: "a".repeat(40),
  committedAt: "2026-01-01T00:00:00.000Z",
};
const analysis = {
  ageByBuildingId: [],
  churnByBuildingId: [],
};

describe("evolution timeline worker client", () => {
  it("loads once, keeps the worker, and validates returned models", async () => {
    const worker = new FakeEvolutionWorker();
    const client = new EvolutionTimelineWorkerClient({
      createWorker: () => worker as unknown as Worker,
    });
    const bytes = new ArrayBuffer(8);
    const loaded = client.load(bytes, {
      size: 8,
      sha256: "a".repeat(64),
    });
    const request = worker.requests[0]!;
    worker.respond({
      type: "loaded",
      requestId: request.requestId,
      frames: [frame],
      histories: [],
      model: DEMO_MODEL,
      analysis,
    });

    await expect(loaded).resolves.toMatchObject({ frames: [frame] });
    expect(request).toMatchObject({ bytes });
    expect(worker.transfers[0]).toEqual([bytes]);
    expect(worker.terminated).toBe(false);
  });

  it("rejects a superseded seek and ignores its stale response", async () => {
    const worker = new FakeEvolutionWorker();
    const client = new EvolutionTimelineWorkerClient({
      createWorker: () => worker as unknown as Worker,
    });
    const loading = client.load(new ArrayBuffer(1), {
      size: 1,
      sha256: "b".repeat(64),
    });
    worker.respond({
      type: "loaded",
      requestId: worker.requests[0]!.requestId,
      frames: [frame, { ...frame, index: 1 }],
      histories: [],
      model: DEMO_MODEL,
      analysis,
    });
    await loading;

    const first = client.seek(0, 1);
    const firstRequest = worker.requests.at(-1)!;
    const second = client.seek(0, 0);
    const secondRequest = worker.requests.at(-1)!;
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    worker.respond({
      type: "frame",
      requestId: firstRequest.requestId,
      frame,
      model: DEMO_MODEL,
      analysis,
      transition: {
        fromIndex: 0,
        toIndex: 1,
        addedBuildingIds: [],
        removedBuildings: [],
        renamedBuildingIds: [],
        resizedBuildingIds: [],
        changedBuildingIds: [],
        interpolatedBuildings: [],
      },
    });
    worker.respond({
      type: "frame",
      requestId: secondRequest.requestId,
      frame,
      model: DEMO_MODEL,
      analysis,
      transition: {
        fromIndex: 0,
        toIndex: 0,
        addedBuildingIds: [],
        removedBuildings: [],
        renamedBuildingIds: [],
        resizedBuildingIds: [],
        changedBuildingIds: [],
        interpolatedBuildings: [],
      },
    });
    await expect(second).resolves.toMatchObject({
      requestId: secondRequest.requestId,
    });
  });

  it("sends cooperative cancellation and recovers with a later seek", async () => {
    const worker = new FakeEvolutionWorker();
    const client = new EvolutionTimelineWorkerClient({
      createWorker: () => worker as unknown as Worker,
    });
    const loading = client.load(new ArrayBuffer(1), {
      size: 1,
      sha256: "c".repeat(64),
    });
    worker.respond({
      type: "loaded",
      requestId: worker.requests[0]!.requestId,
      frames: [frame, { ...frame, index: 1 }],
      histories: [],
      model: DEMO_MODEL,
      analysis,
    });
    await loading;

    const cancelled = client.seek(0, 1);
    const cancelledRequest = worker.requests.at(-1)!;
    client.cancel();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    expect(worker.requests.at(-1)).toMatchObject({
      type: "cancel",
      requestId: cancelledRequest.requestId + 1,
    });

    const recovered = client.seek(0, 1);
    const recoveredRequest = worker.requests.at(-1)!;
    worker.respond({
      type: "frame",
      requestId: cancelledRequest.requestId,
      frame,
      model: DEMO_MODEL,
      analysis,
      transition: {
        fromIndex: 0,
        toIndex: 1,
        addedBuildingIds: [],
        removedBuildings: [],
        renamedBuildingIds: [],
        resizedBuildingIds: [],
        changedBuildingIds: [],
        interpolatedBuildings: [],
      },
    });
    worker.respond({
      type: "frame",
      requestId: recoveredRequest.requestId,
      frame: { ...frame, index: 1 },
      model: DEMO_MODEL,
      analysis,
      transition: {
        fromIndex: 0,
        toIndex: 1,
        addedBuildingIds: [],
        removedBuildings: [],
        renamedBuildingIds: [],
        resizedBuildingIds: [],
        changedBuildingIds: [],
        interpolatedBuildings: [],
      },
    });
    await expect(recovered).resolves.toMatchObject({
      requestId: recoveredRequest.requestId,
    });
  });
});
