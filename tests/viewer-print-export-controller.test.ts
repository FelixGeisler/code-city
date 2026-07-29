import { describe, expect, it } from "vitest";

import {
  PrintExportController,
  type PrintExportControllerState,
  type PrintExportWorkerLike,
} from "../apps/viewer/src/print-export-controller.js";
import type {
  PrintExportGenerateRequest,
  PrintExportWorkerResponse,
} from "../apps/viewer/src/print-export-protocol.js";
import type { ThreeMfExportPreflight } from "../packages/exporter/src/three-mf-export.js";

class FakeWorker implements PrintExportWorkerLike {
  public onmessage:
    | ((event: MessageEvent<unknown>) => unknown)
    | null = null;
  public onerror:
    | ((event: ErrorEvent) => unknown)
    | null = null;
  public onmessageerror:
    | ((event: MessageEvent<unknown>) => unknown)
    | null = null;
  public readonly messages: PrintExportGenerateRequest[] = [];
  public terminationCount = 0;

  public postMessage(message: PrintExportGenerateRequest): void {
    this.messages.push(message);
  }

  public terminate(): void {
    this.terminationCount += 1;
  }

  public emit(message: PrintExportWorkerResponse): void {
    this.onmessage?.({ data: message } as MessageEvent<unknown>);
  }

  public emitRaw(message: unknown): void {
    this.onmessage?.({ data: message } as MessageEvent<unknown>);
  }

  public emitError(message: string): boolean {
    let prevented = false;
    this.onerror?.({
      message,
      preventDefault: () => {
        prevented = true;
      },
    } as ErrorEvent);
    return prevented;
  }
}

function preflight(): ThreeMfExportPreflight {
  return {
    title: "Code City",
    profileId: "printer",
    profileName: "Printer",
    dimensions: { x: 10, y: 20, z: 30 },
    partCount: 1,
    channels: [],
    warnings: [],
    labels: {
      printedBuildings: 0,
      skippedBuildings: 0,
      printedDistricts: 0,
      skippedDistricts: 0,
    },
    routes: {
      policy: "off",
      totalCount: 0,
      printedCount: 0,
      omittedCount: 0,
      totalWeight: 0,
      printedWeight: 0,
      omittedWeight: 0,
    },
    legendIncluded: false,
  };
}

const START_REQUEST = {
  model: { schemaVersion: "1.0" },
  profile: { id: "printer" },
  options: {
    scale: 3,
    labelPolicy: "auto",
    routePolicy: "off",
    includeLegend: false,
  },
} as const;

describe("viewer print export controller", () => {
  it("reports progress and preflight before exposing a completed result", () => {
    const worker = new FakeWorker();
    const states: PrintExportControllerState[] = [];
    const controller = new PrintExportController(() => worker, {
      onStateChange: (state) => states.push(state),
    });

    const jobId = controller.start(START_REQUEST);
    expect(jobId).toBe(1);
    expect(worker.messages).toEqual([
      { type: "generate", jobId, ...START_REQUEST },
    ]);
    expect(controller.state).toEqual({ status: "busy", jobId });

    worker.emit({
      type: "progress",
      jobId,
      phase: "geometry",
      completed: 0.35,
      message: "Building printable geometry",
    });
    worker.emit({ type: "preflight", jobId, preflight: preflight() });
    expect(controller.state).toMatchObject({
      status: "busy",
      jobId,
      progress: { phase: "geometry", completed: 0.35 },
      preflight: { title: "Code City" },
    });

    const threeMfBytes = new ArrayBuffer(8);
    worker.emit({
      type: "result",
      jobId,
      preflight: preflight(),
      threeMfBytes,
    });
    expect(controller.state).toMatchObject({
      status: "ready",
      jobId,
      threeMfBytes,
    });
    expect(worker.terminationCount).toBe(1);
    expect(worker.onmessage).toBeNull();
    expect(states.at(-1)?.status).toBe("ready");
  });

  it("terminates on cancel, returns to idle, and ignores stale jobs", () => {
    const workers = [new FakeWorker(), new FakeWorker()];
    let index = 0;
    const controller = new PrintExportController(
      () => workers[index++]!,
    );

    const firstJob = controller.start(START_REQUEST);
    const staleListener = workers[0]!.onmessage!;
    const secondJob = controller.start(START_REQUEST);

    expect(firstJob).toBe(1);
    expect(secondJob).toBe(2);
    expect(workers[0]!.terminationCount).toBe(1);
    staleListener({
      data: {
        type: "result",
        jobId: firstJob,
        preflight: preflight(),
        threeMfBytes: new ArrayBuffer(1),
      },
    } as MessageEvent<unknown>);
    expect(controller.state).toEqual({
      status: "busy",
      jobId: secondJob,
    });

    workers[1]!.emit({
      type: "progress",
      jobId: 999,
      phase: "geometry",
      completed: 0.5,
      message: "Wrong job",
    });
    expect(controller.state).toEqual({
      status: "busy",
      jobId: secondJob,
    });

    controller.cancel();
    expect(workers[1]!.terminationCount).toBe(1);
    expect(controller.state).toEqual({ status: "idle" });
  });

  it("restores a non-busy failure state and preserves preflight details", () => {
    const worker = new FakeWorker();
    const controller = new PrintExportController(() => worker);
    const jobId = controller.start(START_REQUEST);
    worker.emit({ type: "preflight", jobId, preflight: preflight() });
    worker.emit({
      type: "failure",
      jobId,
      error: {
        kind: "validation",
        name: "PrintPlanValidationError",
        message: "Invalid print plan.",
        issues: ["City bound X exceeds build volume."],
      },
    });

    expect(controller.state).toMatchObject({
      status: "failed",
      jobId,
      preflight: { title: "Code City" },
      error: {
        kind: "validation",
        issues: ["City bound X exceeds build volume."],
      },
    });
    expect(worker.terminationCount).toBe(1);

    controller.reset();
    expect(controller.state).toEqual({ status: "idle" });
  });

  it("turns worker and protocol errors into recoverable failures", () => {
    const workers = [new FakeWorker(), new FakeWorker()];
    let index = 0;
    const controller = new PrintExportController(
      () => workers[index++]!,
    );

    const firstJob = controller.start(START_REQUEST);
    expect(workers[0]!.emitError("Out of memory")).toBe(true);
    expect(controller.state).toMatchObject({
      status: "failed",
      jobId: firstJob,
      error: { message: "Out of memory" },
    });

    const secondJob = controller.start(START_REQUEST);
    workers[1]!.emitRaw({ type: "surprise", jobId: secondJob });
    expect(controller.state).toMatchObject({
      status: "failed",
      jobId: secondJob,
      error: { kind: "protocol" },
    });
    expect(workers[1]!.terminationCount).toBe(1);
  });

  it("fails cleanly when a worker cannot be created", () => {
    const controller = new PrintExportController(() => {
      throw new Error("Workers are unavailable.");
    });

    expect(controller.start(START_REQUEST)).toBe(1);
    expect(controller.state).toMatchObject({
      status: "failed",
      jobId: 1,
      error: { message: "Workers are unavailable." },
    });
  });
});
