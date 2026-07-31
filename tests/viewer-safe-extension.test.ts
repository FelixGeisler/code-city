import { describe, expect, it, vi } from "vitest";
import {
  EXTENSION_LIMITS,
  SAFE_EXTENSION_PRESETS,
  applySafeExtensionEvaluation,
  createSafeExtensionModelSnapshot,
  evaluateSafeExtension,
  type CityModel,
} from "../packages/core/src/index.js";
import { DEMO_MODEL } from "../apps/viewer/src/demo-model.js";
import {
  isSafeExtensionWorkerRequest,
  isSafeExtensionWorkerResponse,
  safeExtensionFailureMessage,
  validateSafeExtensionWorkerResponse,
} from "../apps/viewer/src/safe-extension-protocol.js";
import { SafeExtensionWorkerClient } from "../apps/viewer/src/safe-extension-worker-client.js";

class FakeSafeExtensionWorker extends EventTarget {
  request: unknown;
  terminated = false;

  public postMessage(value: unknown): void {
    this.request = value;
  }

  public terminate(): void {
    this.terminated = true;
  }

  public respond(value: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data: value }));
  }
}

describe("safe extension worker protocol", () => {
  it("accepts only exact, deeply valid request and response messages", () => {
    const model = createSafeExtensionModelSnapshot(DEMO_MODEL);
    const configuration = SAFE_EXTENSION_PRESETS[0]!;
    const evaluation = evaluateSafeExtension(model, configuration);
    expect(isSafeExtensionWorkerRequest({ type: "cancel", jobId: 1 })).toBe(
      true,
    );
    expect(
      isSafeExtensionWorkerRequest({
        type: "cancel",
        jobId: 1,
        script: "x",
      }),
    ).toBe(false);
    expect(
      isSafeExtensionWorkerRequest({
        type: "evaluate",
        jobId: 1,
        model,
        configuration,
      }),
    ).toBe(true);
    expect(
      isSafeExtensionWorkerRequest({
        type: "evaluate",
        jobId: 1,
        model: DEMO_MODEL,
        configuration,
      }),
    ).toBe(false);
    expect(
      isSafeExtensionWorkerResponse({
        type: "failure",
        jobId: 1,
        message: "no",
      }),
    ).toBe(true);
    expect(
      isSafeExtensionWorkerResponse({
        type: "failure",
        jobId: 1,
        message: "bad\nmessage",
      }),
    ).toBe(false);
    expect(
      isSafeExtensionWorkerResponse({
        type: "result",
        jobId: 1,
        evaluation,
      }),
    ).toBe(true);
  });

  it("rejects accessors, cycles, non-finite values, and digest mismatches", () => {
    let called = false;
    const accessor = { type: "cancel", jobId: 1 } as Record<string, unknown>;
    Object.defineProperty(accessor, "type", {
      enumerable: true,
      get: () => {
        called = true;
        return "cancel";
      },
    });
    expect(isSafeExtensionWorkerRequest(accessor)).toBe(false);
    expect(called).toBe(false);

    const model = createSafeExtensionModelSnapshot(DEMO_MODEL);
    const configuration = SAFE_EXTENSION_PRESETS[0]!;
    const evaluation = structuredClone(
      evaluateSafeExtension(model, configuration),
    );
    (evaluation.application.buildings[0]!.size as { x: number }).x = Number.NaN;
    expect(() =>
      validateSafeExtensionWorkerResponse(
        { type: "result", jobId: 1, evaluation },
        { model, configuration },
      ),
    ).toThrow(/finite JSON numbers/);

    const cyclic = structuredClone(
      evaluateSafeExtension(model, configuration),
    ) as unknown as Record<string, unknown>;
    cyclic["cycle"] = cyclic;
    expect(
      isSafeExtensionWorkerResponse({
        type: "result",
        jobId: 1,
        evaluation: cyclic,
      }),
    ).toBe(false);

    const mismatch = structuredClone(
      evaluateSafeExtension(model, configuration),
    );
    (mismatch.binding as { modelSha256: string }).modelSha256 =
      `sha256:${"0".repeat(64)}`;
    expect(() =>
      validateSafeExtensionWorkerResponse(
        { type: "result", jobId: 1, evaluation: mismatch },
        { model, configuration },
      ),
    ).toThrow(/different project model/);
  });

  it("sends only a minimal bounded snapshot and accepts a bound result", async () => {
    const worker = new FakeSafeExtensionWorker();
    const client = new SafeExtensionWorkerClient({
      createWorker: () => worker as unknown as Worker,
    });
    const pending = client.evaluate(DEMO_MODEL, SAFE_EXTENSION_PRESETS[0]);
    expect(worker.request).toMatchObject({ type: "evaluate", jobId: 1 });
    const request = worker.request as {
      readonly model: { readonly buildings: readonly Record<string, unknown>[] };
    };
    expect(Object.keys(request.model.buildings[0]!).sort()).toEqual([
      "districtId",
      "id",
      "metrics",
      "moduleId",
      "position",
      "size",
    ]);
    const evaluation = evaluateSafeExtension(
      DEMO_MODEL,
      SAFE_EXTENSION_PRESETS[0],
    );
    worker.respond({ type: "result", jobId: 1, evaluation });
    const review = await pending;
    expect(review.evaluation).toEqual(evaluation);
    expect(
      applySafeExtensionEvaluation(
        DEMO_MODEL,
        review.evaluation,
        review.application,
      ),
    ).toBe(DEMO_MODEL);
    expect(worker.terminated).toBe(true);
  });

  it("rejects invalid input before creating or cloning into a worker", async () => {
    let workers = 0;
    const client = new SafeExtensionWorkerClient({
      createWorker: () => {
        workers += 1;
        return new FakeSafeExtensionWorker() as unknown as Worker;
      },
    });
    await expect(
      client.evaluate(DEMO_MODEL, {
        ...SAFE_EXTENSION_PRESETS[0],
        script: "fetch('/secret')",
      }),
    ).rejects.toThrow(/Unsupported extension|unsupported properties/);
    expect(workers).toBe(0);

    const oversized = {
      ...DEMO_MODEL,
      buildings: Array.from(
        { length: EXTENSION_LIMITS.modelBuildings + 1 },
        () => DEMO_MODEL.buildings[0]!,
      ),
    } as CityModel;
    await expect(
      client.evaluate(oversized, SAFE_EXTENSION_PRESETS[0]),
    ).rejects.toThrow(/unsupported array|bounded array/);
    expect(workers).toBe(0);
  });

  it("fails closed on a worker response bound to another request", async () => {
    const worker = new FakeSafeExtensionWorker();
    const client = new SafeExtensionWorkerClient({
      createWorker: () => worker as unknown as Worker,
    });
    const pending = client.evaluate(DEMO_MODEL, SAFE_EXTENSION_PRESETS[0]);
    const evaluation = structuredClone(
      evaluateSafeExtension(DEMO_MODEL, SAFE_EXTENSION_PRESETS[0]),
    );
    (evaluation.binding as { configurationSha256: string }).configurationSha256 =
      `sha256:${"0".repeat(64)}`;
    worker.respond({ type: "result", jobId: 1, evaluation });
    await expect(pending).rejects.toThrow(/invalid response/);
    expect(worker.terminated).toBe(true);
  });

  it("interrupts active work by terminating its dedicated worker", async () => {
    const worker = new FakeSafeExtensionWorker();
    const client = new SafeExtensionWorkerClient({
      createWorker: () => worker as unknown as Worker,
    });
    const pending = client.evaluate(DEMO_MODEL, SAFE_EXTENSION_PRESETS[0]);
    client.cancel();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(worker.terminated).toBe(true);
  });

  it("fails closed and terminates a worker that exceeds its time limit", async () => {
    vi.useFakeTimers();
    try {
      const worker = new FakeSafeExtensionWorker();
      const client = new SafeExtensionWorkerClient({
        createWorker: () => worker as unknown as Worker,
        timeoutMilliseconds: 25,
      });
      const pending = client.evaluate(DEMO_MODEL, SAFE_EXTENSION_PRESETS[0]);
      const assertion = expect(pending).rejects.toThrow(/time limit/);
      await vi.advanceTimersByTimeAsync(25);
      await assertion;
      expect(worker.terminated).toBe(true);
    } finally {
      vi.useRealTimers();
    }
    expect(
      () => new SafeExtensionWorkerClient({ timeoutMilliseconds: 30_001 }),
    ).toThrow(/1 to 30,000/);
  });

  it("sanitizes failure text before it crosses the protocol", () => {
    expect(safeExtensionFailureMessage(new Error("bad\n\u0000message"))).toBe(
      "bad  message",
    );
    expect(safeExtensionFailureMessage(undefined)).toBe(
      "The extension could not be evaluated.",
    );
  });
});
