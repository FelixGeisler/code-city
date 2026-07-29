import { describe, expect, it } from "vitest";

import {
  PRINT_EXPORT_WATCHDOG_MS,
  PrintExportController,
  type PrintExportControllerState,
  type PrintExportStartRequest,
  type PrintExportWorkerLike,
} from "../apps/viewer/src/print-export-controller.js";
import { runPrintExportRequest } from "../apps/viewer/src/print-export-worker.js";
import type {
  PrintExportTransferArtifact,
  PrintExportWorkerRequest,
  PrintExportWorkerResponse,
} from "../apps/viewer/src/print-export-protocol.js";
import { createSingleChannelProfile } from "../packages/core/src/index.js";
import type {
  PrintPlateBundlePreflight,
  PrintPlatePreviewSource,
} from "../packages/exporter/src/print-plates.js";

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
): PrintPlateBundlePreflight {
  const labels = {
    printedBuildings: 0,
    skippedBuildings: 0,
    printedDistricts: 0,
    skippedDistricts: 0,
  };
  const routes = {
    policy: "off" as const,
    totalCount: 0,
    printedCount: 0,
    omittedCount: 0,
    totalWeight: 0,
    printedWeight: 0,
    omittedWeight: 0,
  };
  return {
    format,
    title: "Code City",
    profileId: "printer",
    profileName: "Printer",
    fitPolicy: "error",
    requestedScale: 3,
    appliedScale: 3,
    plateCount: 1,
    plates: [{
      number: 1,
      id: "plate-01",
      fileName: `plate-01.${format}`,
      dimensions: { width: 10, depth: 20, height: 30 },
      utilization: 0.25,
      channelIds: [],
      warnings: [],
      labels,
      routes,
    }],
    warnings: [],
    unplacedObjects: [],
    routeOmissions: [],
    labels,
    routes,
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

function cuboidMesh(bounds: {
  readonly minimum: { readonly x: number; readonly y: number; readonly z: number };
  readonly maximum: { readonly x: number; readonly y: number; readonly z: number };
}) {
  const { minimum, maximum } = bounds;
  return {
    vertices: [
      { x: minimum.x, y: minimum.y, z: minimum.z },
      { x: maximum.x, y: minimum.y, z: minimum.z },
      { x: maximum.x, y: maximum.y, z: minimum.z },
      { x: minimum.x, y: maximum.y, z: minimum.z },
      { x: minimum.x, y: minimum.y, z: maximum.z },
      { x: maximum.x, y: minimum.y, z: maximum.z },
      { x: maximum.x, y: maximum.y, z: maximum.z },
      { x: minimum.x, y: maximum.y, z: maximum.z },
    ],
    triangles: [
      { a: 0, b: 2, c: 1 },
      { a: 0, b: 3, c: 2 },
      { a: 4, b: 5, c: 6 },
      { a: 4, b: 6, c: 7 },
      { a: 0, b: 1, c: 5 },
      { a: 0, b: 5, c: 4 },
      { a: 1, b: 2, c: 6 },
      { a: 1, b: 6, c: 5 },
      { a: 2, b: 3, c: 7 },
      { a: 2, b: 7, c: 6 },
      { a: 3, b: 0, c: 4 },
      { a: 3, b: 4, c: 7 },
    ],
  };
}

function singlePreview(
  value: PrintPlateBundlePreflight = preflight(),
): PrintPlatePreviewSource {
  const dimensions = value.plates[0]!.dimensions;
  const bounds = {
    minimum: { x: 0, y: 0, z: 0 },
    maximum: {
      x: dimensions.width,
      y: dimensions.depth,
      z: dimensions.height,
    },
    size: {
      x: dimensions.width,
      y: dimensions.depth,
      z: dimensions.height,
    },
  };
  return {
    fitPolicy: "error",
    appliedPolicy: "error",
    requestedScale: 3,
    appliedScale: 3,
    sourceBounds: bounds,
    printableBounds: bounds,
    warnings: value.warnings,
    unplacedObjects: [],
    plates: [
      {
        number: 1,
        id: "plate-01",
        fileName: `plate-01.${value.format}`,
        utilization: 0.25,
        bounds,
        warnings: value.warnings,
        parts: [],
      },
    ],
  };
}

function bundlePreflight(
  format: "3mf" | "stl" = "3mf",
): PrintPlateBundlePreflight {
  return {
    format,
    title: "Code City",
    profileId: "printer",
    profileName: "Printer",
    fitPolicy: "tile",
    requestedScale: 3,
    appliedScale: 3,
    plateCount: 1,
    plates: [
      {
        number: 1,
        id: "plate-1",
        fileName: "plate-01.3mf",
        dimensions: { width: 10, depth: 20, height: 5 },
        utilization: 0.5,
        channelIds: ["base"],
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
      },
    ],
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
    warnings: [],
    unplacedObjects: [],
    routeOmissions: [],
    legendIncluded: false,
  };
}

function bundlePreview(): PrintPlatePreviewSource {
  const bounds = {
    minimum: { x: 0, y: 0, z: 0 },
    maximum: { x: 10, y: 20, z: 5 },
    size: { x: 10, y: 20, z: 5 },
  };
  const mesh = cuboidMesh(bounds);
  return {
    fitPolicy: "tile",
    appliedPolicy: "tile",
    requestedScale: 3,
    appliedScale: 3,
    sourceBounds: bounds,
    printableBounds: bounds,
    warnings: [],
    unplacedObjects: [],
    plates: [
      {
        number: 1,
        id: "plate-1",
        fileName: "plate-01.3mf",
        utilization: 0.5,
        bounds,
        warnings: [],
        parts: [
          {
            id: "part-base",
            channelId: "base",
            name: "Base",
            displayColor: "#334455",
            semanticGroupIds: ["base"],
            mesh,
            primitives: [
              {
                id: "city-base",
                kind: "base",
                semanticGroupId: "base",
                channelId: "base",
                mesh,
                bounds,
              },
            ],
          },
        ],
      },
    ],
  };
}

const START_REQUEST = {
  format: "3mf",
  model: { schemaVersion: "1.0" },
  profile: { id: "printer", name: "Printer" },
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
    worker.emit({
      type: "preflight",
      jobId,
      preflight: preflight(),
      preview: singlePreview(),
    });
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

  it("preserves bundle preflight and exposes the completed ZIP result", () => {
    const worker = new FakeWorker();
    const controller = new PrintExportController(() => worker);
    const request = {
      ...START_REQUEST,
      options: {
        ...START_REQUEST.options,
        fitPolicy: "tile",
        maximumPlateCount: 4,
      },
    } as const;
    const jobId = controller.start(request);
    const preflight = bundlePreflight();
    const preview = bundlePreview();

    worker.emit({
      type: "progress",
      jobId,
      phase: "layout",
      completed: 0.2,
      message: "Planning plates",
    });
    worker.emit({
      type: "bundle-preflight",
      jobId,
      preflight,
      preview,
    });
    expect(controller.state).toMatchObject({
      status: "busy",
      jobId,
      progress: { phase: "layout", completed: 0.2 },
      bundlePreflight: { plateCount: 1, fitPolicy: "tile" },
      bundlePreview: { plates: [{ id: "plate-1" }] },
    });

    const bytes = Uint8Array.from([80, 75, 3, 4]).buffer;
    const manifestBytes = Uint8Array.from([123, 125]).buffer;
    worker.emit({
      type: "bundle-result",
      jobId,
      artifact: {
        format: "zip",
        mimeType: "application/zip",
        fileExtension: ".zip",
        bytes,
      },
      manifestBytes,
    });

    expect(controller.state).toMatchObject({
      status: "bundle-ready",
      jobId,
      preflight: { plateCount: 1 },
      preview: { plates: [{ id: "plate-1" }] },
      artifact: { format: "zip", bytes },
      manifestBytes,
    });
    expect(worker.terminationCount).toBe(1);
    expect(worker.onmessage).toBeNull();
  });

  it("rejects a schema-valid result variant that does not match the request", () => {
    const worker = new FakeWorker();
    const controller = new PrintExportController(() => worker);
    const jobId = controller.start({
      ...START_REQUEST,
      options: {
        ...START_REQUEST.options,
        fitPolicy: "tile",
        maximumPlateCount: 4,
      },
    });

    worker.emit({
      type: "preflight",
      jobId,
      preflight: preflight(),
      preview: singlePreview(),
    });

    expect(controller.state).toMatchObject({
      status: "failed",
      jobId,
      error: { kind: "protocol" },
    });
    expect(worker.terminationCount).toBe(1);
  });

  it("requires matching preflight before a result and checks requested scale", () => {
    const earlyWorker = new FakeWorker();
    const early = new PrintExportController(() => earlyWorker);
    const earlyJob = early.start(START_REQUEST);
    earlyWorker.emit({
      type: "result",
      jobId: earlyJob,
      artifact: artifact(),
    });
    expect(early.state).toMatchObject({
      status: "failed",
      error: { kind: "protocol" },
    });

    const scaleWorker = new FakeWorker();
    const scaled = new PrintExportController(() => scaleWorker);
    const scaleJob = scaled.start(START_REQUEST);
    const wrong = {
      ...preflight(),
      requestedScale: 4,
      appliedScale: 4,
    };
    scaleWorker.emit({
      type: "preflight",
      jobId: scaleJob,
      preflight: wrong,
      preview: {
        ...singlePreview(wrong),
        requestedScale: 4,
        appliedScale: 4,
      },
    });
    expect(scaled.state).toMatchObject({
      status: "failed",
      error: { kind: "protocol" },
    });
  });

  it("rejects a second preflight instead of replacing the published plan", () => {
    const worker = new FakeWorker();
    const controller = new PrintExportController(() => worker);
    const jobId = controller.start(START_REQUEST);
    const first = preflight();
    const preview = singlePreview(first);

    worker.emit({
      type: "preflight",
      jobId,
      preflight: first,
      preview,
    });
    worker.emit({
      type: "preflight",
      jobId,
      preflight: first,
      preview,
    });

    expect(controller.state).toMatchObject({
      status: "failed",
      jobId,
      preflight: first,
      error: {
        kind: "protocol",
        message: expect.stringMatching(/another export request/iu),
      },
    });
    expect(worker.terminationCount).toBe(1);
  });

  it("correlates policy, legend, labels, and profile with the request", () => {
    const cases: readonly {
      readonly request: PrintExportStartRequest;
      readonly value: PrintPlateBundlePreflight;
    }[] = [
      {
        request: START_REQUEST,
        value: { ...preflight(), profileId: "other-printer" },
      },
      {
        request: START_REQUEST,
        value: { ...preflight(), profileName: "Other printer" },
      },
      {
        request: START_REQUEST,
        value: {
          ...preflight(),
          legendIncluded: true,
        },
      },
      {
        request: START_REQUEST,
        value: (() => {
          const routes = { ...preflight().routes, policy: "auto" as const };
          return {
            ...preflight(),
            routes,
            plates: preflight().plates.map((plate) => ({
              ...plate,
              routes,
            })),
          };
        })(),
      },
      {
        request: {
          ...START_REQUEST,
          options: {
            ...START_REQUEST.options,
            labelPolicy: "off",
          },
        },
        value: (() => {
          const labels = {
            ...preflight().labels,
            printedBuildings: 1,
          };
          return {
            ...preflight(),
            labels,
            plates: preflight().plates.map((plate) => ({
              ...plate,
              labels,
            })),
          };
        })(),
      },
    ];

    for (const candidate of cases) {
      const worker = new FakeWorker();
      const controller = new PrintExportController(() => worker);
      const jobId = controller.start(candidate.request);
      worker.emit({
        type: "preflight",
        jobId,
        preflight: candidate.value,
        preview: singlePreview(candidate.value),
      });
      expect(controller.state).toMatchObject({
        status: "failed",
        error: { kind: "protocol" },
      });
      expect(worker.terminationCount).toBe(1);
    }
  });

  it("enforces the requested plate cap and legend-result presence", () => {
    const cappedWorker = new FakeWorker();
    const capped = new PrintExportController(() => cappedWorker);
    const cappedJob = capped.start({
      ...START_REQUEST,
      options: {
        ...START_REQUEST.options,
        fitPolicy: "tile",
        maximumPlateCount: 1,
      },
    });
    const firstPreflight = bundlePreflight();
    const firstPreview = bundlePreview();
    const secondPreflightPlate = {
      ...firstPreflight.plates[0]!,
      number: 2,
      id: "plate-2",
      fileName: "plate-02.3mf",
    };
    const twoPlatePreflight = {
      ...firstPreflight,
      plateCount: 2,
      plates: [firstPreflight.plates[0]!, secondPreflightPlate],
    };
    const secondPreviewPlate = {
      ...firstPreview.plates[0]!,
      number: 2,
      id: "plate-2",
      fileName: "plate-02.3mf",
    };
    const twoPlatePreview = {
      ...firstPreview,
      plates: [firstPreview.plates[0]!, secondPreviewPlate],
    };
    cappedWorker.emit({
      type: "bundle-preflight",
      jobId: cappedJob,
      preflight: twoPlatePreflight,
      preview: twoPlatePreview,
    });
    expect(capped.state).toMatchObject({
      status: "failed",
      error: { kind: "protocol" },
    });

    const legendWorker = new FakeWorker();
    const legend = new PrintExportController(() => legendWorker);
    const legendJob = legend.start(START_REQUEST);
    legendWorker.emit({
      type: "preflight",
      jobId: legendJob,
      preflight: preflight(),
      preview: singlePreview(),
    });
    legendWorker.emit({
      type: "result",
      jobId: legendJob,
      artifact: artifact(),
      legendBytes: new ArrayBuffer(8),
    });
    expect(legend.state).toMatchObject({
      status: "failed",
      error: { kind: "protocol" },
    });
  });

  it("rejects a valid artifact for a format other than the requested one", () => {
    const worker = new FakeWorker();
    const controller = new PrintExportController(() => worker);
    const jobId = controller.start({
      ...START_REQUEST,
      format: "stl",
    });

    const stlPreflight = preflight("stl");
    worker.emit({
      type: "preflight",
      jobId,
      preflight: stlPreflight,
      preview: singlePreview(stlPreflight),
    });
    worker.emit({ type: "result", jobId, artifact: artifact() });

    expect(controller.state).toMatchObject({
      status: "failed",
      jobId,
      error: {
        kind: "protocol",
        message: expect.stringMatching(/matching preflight/iu),
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
        preview: singlePreview(),
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
    worker.emit({
      type: "preflight",
      jobId,
      preflight: preflight(),
      preview: singlePreview(),
    });
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
