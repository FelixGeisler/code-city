import { describe, expect, it } from "vitest";

import { DEMO_MODEL } from "../apps/viewer/src/demo-model.js";
import type { DesignSmellEvaluateRequest } from "../apps/viewer/src/design-smell-protocol.js";
import { DesignSmellWorkerClient } from "../apps/viewer/src/design-smell-worker-client.js";
import {
  DEFAULT_DESIGN_SMELL_CONFIGURATION,
  evaluateDesignSmells,
} from "../packages/core/src/index.js";

class FakeDesignSmellWorker extends EventTarget {
  readonly requests: DesignSmellEvaluateRequest[] = [];
  terminated = false;

  postMessage(value: unknown): void {
    this.requests.push(value as DesignSmellEvaluateRequest);
  }

  terminate(): void {
    this.terminated = true;
  }

  respond(value: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data: value }));
  }
}

describe("design smell worker client", () => {
  it("accepts a deeply validated evaluation and terminates its worker", async () => {
    const worker = new FakeDesignSmellWorker();
    const client = new DesignSmellWorkerClient(
      () => worker as unknown as Worker,
    );
    const pending = client.evaluate(
      DEMO_MODEL,
      DEFAULT_DESIGN_SMELL_CONFIGURATION,
      [],
    );
    const request = worker.requests[0]!;

    worker.respond({
      type: "result",
      jobId: request.jobId,
      evaluation: evaluateDesignSmells(DEMO_MODEL),
    });

    await expect(pending).resolves.toMatchObject({
      protocolVersion: "codecity.design-smells/1",
    });
    expect(worker.terminated).toBe(true);
  });

  it("hard-cancels a superseded worker and rejects with AbortError", async () => {
    const first = new FakeDesignSmellWorker();
    const second = new FakeDesignSmellWorker();
    const workers = [first, second];
    const client = new DesignSmellWorkerClient(
      () => workers.shift()! as unknown as Worker,
    );
    const cancelled = client.evaluate(
      DEMO_MODEL,
      DEFAULT_DESIGN_SMELL_CONFIGURATION,
      [],
    );
    const active = client.evaluate(
      DEMO_MODEL,
      DEFAULT_DESIGN_SMELL_CONFIGURATION,
      [],
    );

    await expect(cancelled).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(first.terminated).toBe(true);
    const request = second.requests[0]!;
    second.respond({
      type: "result",
      jobId: request.jobId,
      evaluation: evaluateDesignSmells(DEMO_MODEL),
    });
    await active;
    expect(second.terminated).toBe(true);
  });

  it("rejects forged worker counts at the trust boundary", async () => {
    const worker = new FakeDesignSmellWorker();
    const client = new DesignSmellWorkerClient(
      () => worker as unknown as Worker,
    );
    const pending = client.evaluate(
      DEMO_MODEL,
      DEFAULT_DESIGN_SMELL_CONFIGURATION,
      [],
    );
    const evaluation = structuredClone(
      evaluateDesignSmells(DEMO_MODEL),
    );
    (
      evaluation.counts as Record<string, number>
    )["oversized-file"]! += 1;
    worker.respond({
      type: "result",
      jobId: worker.requests[0]!.jobId,
      evaluation,
    });

    await expect(pending).rejects.toThrow(/invalid evaluation/iu);
    expect(worker.terminated).toBe(true);
  });
});
