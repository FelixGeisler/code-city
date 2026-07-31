import { describe, expect, it, vi } from "vitest";
import { SAFE_EXTENSION_PRESETS, evaluateSafeExtension } from "../packages/core/src/index.js";
import { DEMO_MODEL } from "../apps/viewer/src/demo-model.js";
import { isSafeExtensionWorkerRequest, isSafeExtensionWorkerResponse } from "../apps/viewer/src/safe-extension-protocol.js";
import { SafeExtensionWorkerClient } from "../apps/viewer/src/safe-extension-worker-client.js";

class FakeSafeExtensionWorker extends EventTarget {
  request: unknown;
  terminated = false;
  public postMessage(value: unknown): void { this.request = value; }
  public terminate(): void { this.terminated = true; }
  public respond(value: unknown): void { this.dispatchEvent(new MessageEvent("message", { data: value })); }
}

describe("safe extension worker protocol", () => {
  it("accepts only exact bounded messages", () => { expect(isSafeExtensionWorkerRequest({ type: "cancel", jobId: 1 })).toBe(true); expect(isSafeExtensionWorkerRequest({ type: "cancel", jobId: 1, script: "x" })).toBe(false); expect(isSafeExtensionWorkerResponse({ type: "failure", jobId: 1, message: "no" })).toBe(true); expect(isSafeExtensionWorkerResponse({ type: "result", jobId: 1, evaluation: {}, extra: true })).toBe(false); });
  it("returns validated worker results and terminates the worker", async () => {
    const worker = new FakeSafeExtensionWorker();
    const client = new SafeExtensionWorkerClient({ createWorker: () => worker as unknown as Worker });
    const pending = client.evaluate(DEMO_MODEL, SAFE_EXTENSION_PRESETS[0]);
    const evaluation = evaluateSafeExtension(DEMO_MODEL, SAFE_EXTENSION_PRESETS[0]);
    worker.respond({ type: "result", jobId: 1, evaluation });
    await expect(pending).resolves.toEqual(evaluation);
    expect(worker.terminated).toBe(true);
  });
  it("fails closed and terminates a worker that exceeds its time limit", async () => {
    vi.useFakeTimers();
    try {
      const worker = new FakeSafeExtensionWorker();
      const client = new SafeExtensionWorkerClient({ createWorker: () => worker as unknown as Worker, timeoutMilliseconds: 25 });
      const pending = client.evaluate(DEMO_MODEL, SAFE_EXTENSION_PRESETS[0]);
      const assertion = expect(pending).rejects.toThrow(/time limit/);
      await vi.advanceTimersByTimeAsync(25);
      await assertion;
      expect(worker.terminated).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
