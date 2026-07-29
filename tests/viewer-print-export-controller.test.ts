import { describe, expect, it } from "vitest";

import {
  PRINT_EXPORT_WATCHDOG_MS,
  PrintExportController,
  type PrintExportControllerState,
  type PrintExportWorkerLike,
} from "../apps/viewer/src/print-export-controller.js";
import { runPrintExportRequest } from "../apps/viewer/src/print-export-worker.js";
import type {
  PrintExportTransferArtifact,
  PrintExportWorkerRequest,
  PrintExportWorkerResponse,
} from "../apps/viewer/src/print-export-protocol.js";
import { createSingleChannelProfile } from "../packages/core/src/index.js";
import type { PrintExportPreflight } from "../packages/exporter/src/print-export.js";

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
  public readonly messages: PrintExportWorkerRequest[] = [];
  public terminationCount = 0;

  public postMessage(message: PrintExportWorkerRequest): void {
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

function preflight(
  format: "3mf" | "stl" = "3mf",
): PrintExportPreflight {
  return {
    format,
    title: "Code City",
    profileId: "printer",
    profileName: "Printer",
    dimensions: { x: 10, y: 20, z: 30 },
    partCount: 1,
    triangleCount: 12,
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

function artifact(
  format: "3mf" | "stl" = "3mf",
): PrintExportTransferArtifact {
  return format === "3mf"
    ? {
        format,
        mimeType: "model/3mf",
        fileExtension: ".3mf",
        bytes: new ArrayBuffer(8),
      }
    : {
        format,
        mimeType: "model/stl",
        fileExtension: ".stl",
        bytes: new ArrayBuffer(8),
      };
}

const START_REQUEST = {
  format: "3mf",
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
  it("uses a stable one-minute watchdog", () => {
    expect(PRINT_EXPORT_WATCHDOG_MS).toBe(60_000);
  });

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

    const exported = artifact();
    worker.emit({
      type: "result",
      jobId,
      preflight: preflight(),
      artifact: exported,
    });
    expect(controller.state).toMatchObject({
      status: "ready",
      jobId,
      artifact: exported,
    });
    expect(worker.terminationCount).toBe(1);
    expect(worker.onmessage).toBeNull();
    expect(states.at(-1)?.status).toBe("ready");
  });

  it("accepts a real calibration worker result and terminates the job", () => {
    const worker = new FakeWorker();
    const controller = new PrintExportController(() => worker);
    const profile = createSingleChannelProfile();

    const jobId = controller.startCalibration({
      profile,
      format: "stl",
    });
    expect(worker.messages).toEqual([
      { type: "calibrate", jobId, format: "stl", profile },
    ]);
    const responses: PrintExportWorkerResponse[] = [];
    runPrintExportRequest(worker.messages[0]!, (response) => {
      responses.push(response);
    });
    for (const response of responses) worker.emit(response);

    expect(controller.state).toMatchObject({
      status: "calibration-ready",
      jobId,
      preflight: {
        profileId: profile.id,
        format: "stl",
        channelCount: 1,
        triangleCount: expect.any(Number),
      },
      artifact: {
        format: "stl",
        mimeType: "model/stl",
        fileExtension: ".stl",
        bytes: expect.any(ArrayBuffer),
      },
      manifestBytes: expect.any(ArrayBuffer),
    });
    expect(worker.terminationCount).toBe(1);
    expect(worker.onmessage).toBeNull();
  });

  it("rejects a valid artifact for a format other than the requested one", () => {
    const worker = new FakeWorker();
    const controller = new PrintExportController(() => worker);
    const jobId = controller.start({
      ...START_REQUEST,
      format: "stl",
    });

    worker.emit({
      type: "result",
      jobId,
      preflight: preflight(),
      artifact: artifact(),
    });

    expect(controller.state).toMatchObject({
      status: "failed",
      jobId,
      error: {
        kind: "protocol",
        message: expect.stringMatching(/unexpected artifact format/iu),
      },
    });
    expect(worker.terminationCount).toBe(1);
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
        artifact: artifact(),
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

  it("terminates a timed-out worker and clears its watchdog handle", () => {
    const worker = new FakeWorker();
    let expire: (() => void) | undefined;
    const cleared: unknown[] = [];
    const controller = new PrintExportController(() => worker, {
      watchdogMs: 25,
      scheduleWatchdog: (callback, milliseconds) => {
        expect(milliseconds).toBe(25);
        expire = callback;
        return "print-watchdog";
      },
      clearWatchdog: (handle) => {
        cleared.push(handle);
      },
    });

    const jobId = controller.start(START_REQUEST);
    expire?.();

    expect(controller.state).toMatchObject({
      status: "failed",
      jobId,
      error: {
        name: "PrintExportTimeoutError",
        message: expect.stringMatching(/25 ms browser limit/u),
      },
    });
    expect(worker.terminationCount).toBe(1);
    expect(worker.onmessage).toBeNull();
    expect(cleared).toEqual(["print-watchdog"]);
  });
});
