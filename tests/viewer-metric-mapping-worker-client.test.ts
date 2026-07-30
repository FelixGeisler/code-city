import { describe, expect, it } from "vitest";

import {
  DEFAULT_VERSIONED_METRIC_MAPPING,
} from "../packages/core/src/index.js";
import {
  MetricMappingWorkerClient,
} from "../apps/viewer/src/metric-mapping-worker-client.js";
import type {
  MetricMappingProjectRequest,
} from "../apps/viewer/src/metric-mapping-protocol.js";
import { DEMO_MODEL } from "../apps/viewer/src/demo-model.js";

class FakeMetricWorker extends EventTarget {
  request: MetricMappingProjectRequest | undefined;
  terminated = false;

  postMessage(value: unknown): void {
    this.request = value as MetricMappingProjectRequest;
  }

  terminate(): void {
    this.terminated = true;
  }

  respond(value: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data: value }));
  }
}

describe("metric mapping worker client", () => {
  it("uses a fresh short-lived module worker and validates its result", async () => {
    const worker = new FakeMetricWorker();
    const client = new MetricMappingWorkerClient({
      createWorker: () => worker as unknown as Worker,
    });
    const result = client.project(
      DEMO_MODEL,
      DEFAULT_VERSIONED_METRIC_MAPPING,
    );
    expect(worker.request).toMatchObject({
      type: "project",
      jobId: 1,
      model: DEMO_MODEL,
      mapping: DEFAULT_VERSIONED_METRIC_MAPPING,
    });
    worker.respond({
      type: "result",
      jobId: 1,
      model: DEMO_MODEL,
    });
    await expect(result).resolves.toEqual(DEMO_MODEL);
    expect(worker.terminated).toBe(true);
  });

  it("terminates the previous worker when a newer projection starts", async () => {
    const workers = [new FakeMetricWorker(), new FakeMetricWorker()];
    const client = new MetricMappingWorkerClient({
      createWorker: () => workers.shift()! as unknown as Worker,
    });
    const firstWorker = workers[0]!;
    const first = client.project(
      DEMO_MODEL,
      DEFAULT_VERSIONED_METRIC_MAPPING,
    );
    const secondWorker = workers[0]!;
    const second = client.project(
      DEMO_MODEL,
      DEFAULT_VERSIONED_METRIC_MAPPING,
    );

    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect(firstWorker.terminated).toBe(true);
    secondWorker.respond({
      type: "result",
      jobId: 2,
      model: DEMO_MODEL,
    });
    await expect(second).resolves.toEqual(DEMO_MODEL);
  });

  it("fails closed on malformed or stale worker responses", async () => {
    const worker = new FakeMetricWorker();
    const client = new MetricMappingWorkerClient({
      createWorker: () => worker as unknown as Worker,
    });
    const result = client.project(
      DEMO_MODEL,
      DEFAULT_VERSIONED_METRIC_MAPPING,
    );
    worker.respond({
      type: "result",
      jobId: 99,
      model: DEMO_MODEL,
    });
    await expect(result).rejects.toThrow(/invalid response/iu);
    expect(worker.terminated).toBe(true);
  });
});
