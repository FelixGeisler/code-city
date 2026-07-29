import { describe, expect, it } from "vitest";

import {
  isPrintCalibrationGenerateRequest,
  isPrintExportGenerateRequest,
  isPrintExportWorkerResponse,
  serializePrintExportError,
  type PrintExportGenerateRequest,
  type PrintExportTransferArtifact,
} from "../apps/viewer/src/print-export-protocol.js";
import { createSingleChannelProfile } from "../packages/core/src/index.js";
import {
  generateCalibrationPrintExport,
} from "../packages/exporter/src/calibration.js";
import type { PrintExportPreflight } from "../packages/exporter/src/print-export.js";

function samplePreflight(): PrintExportPreflight {
  return {
    format: "3mf",
    title: "Code City",
    profileId: "printer",
    profileName: "Printer",
    dimensions: { x: 10, y: 20, z: 30 },
    partCount: 1,
    triangleCount: 12,
    channels: [
      {
        id: "channel-1",
        label: "Channel 1",
        partIds: ["part-1"],
        semanticGroupIds: ["base"],
        primitiveCount: 3,
      },
    ],
    warnings: [],
    labels: {
      printedBuildings: 0,
      skippedBuildings: 2,
      printedDistricts: 0,
      skippedDistricts: 1,
    },
    routes: {
      policy: "off",
      totalCount: 2,
      printedCount: 0,
      omittedCount: 2,
      totalWeight: 4,
      printedWeight: 0,
      omittedWeight: 4,
    },
    legendIncluded: true,
  };
}

function sampleArtifact(
  format: "3mf" | "stl" = "3mf",
): PrintExportTransferArtifact {
  return format === "3mf"
    ? {
        format,
        mimeType: "model/3mf",
        fileExtension: ".3mf",
        bytes: new ArrayBuffer(4),
      }
    : {
        format,
        mimeType: "model/stl",
        fileExtension: ".stl",
        bytes: new ArrayBuffer(4),
      };
}

describe("viewer print export protocol", () => {
  it("accepts only complete generate requests with positive job ids", () => {
    const request: PrintExportGenerateRequest = {
      type: "generate",
      jobId: 7,
      format: "3mf",
      model: { schemaVersion: "1.0" },
      profile: { id: "printer" },
      options: {
        scale: 3,
        labelPolicy: "auto",
        routePolicy: "off",
        includeLegend: true,
      },
    };

    expect(isPrintExportGenerateRequest(request)).toBe(true);
    expect(
      isPrintExportGenerateRequest({ ...request, jobId: 0 }),
    ).toBe(false);
    expect(
      isPrintExportGenerateRequest({
        ...request,
        format: "obj",
      }),
    ).toBe(false);
    expect(
      isPrintExportGenerateRequest({
        ...request,
        options: { ...request.options, routePolicy: "always" },
      }),
    ).toBe(false);
    expect(
      isPrintExportGenerateRequest({
        type: "generate",
        jobId: 1,
        format: "3mf",
        profile: {},
        options: request.options,
      }),
    ).toBe(false);
  });

  it("accepts only profile-only calibration requests", () => {
    const request = {
      type: "calibrate",
      jobId: 8,
      format: "stl",
      profile: createSingleChannelProfile(),
    } as const;

    expect(isPrintCalibrationGenerateRequest(request)).toBe(true);
    expect(
      isPrintCalibrationGenerateRequest({ ...request, jobId: 0 }),
    ).toBe(false);
    expect(
      isPrintCalibrationGenerateRequest({
        type: "calibrate",
        jobId: 8,
      }),
    ).toBe(false);
    expect(
      isPrintCalibrationGenerateRequest({
        ...request,
        format: "obj",
      }),
    ).toBe(false);
    expect(
      isPrintCalibrationGenerateRequest({
        ...request,
        type: "generate",
      }),
    ).toBe(false);
  });

  it("validates every worker response variant and transferable result", () => {
    const preflight = samplePreflight();
    const archive = new ArrayBuffer(4);

    expect(
      isPrintExportWorkerResponse({
        type: "progress",
        jobId: 1,
        phase: "geometry",
        completed: 0.35,
        message: "Building printable geometry",
      }),
    ).toBe(true);
    expect(
      isPrintExportWorkerResponse({
        type: "preflight",
        jobId: 1,
        preflight,
      }),
    ).toBe(true);
    expect(
      isPrintExportWorkerResponse({
        type: "result",
        jobId: 1,
        preflight,
        artifact: { ...sampleArtifact(), bytes: archive },
      }),
    ).toBe(true);
    expect(
      isPrintExportWorkerResponse({
        type: "result",
        jobId: 1,
        preflight,
        artifact: {
          ...sampleArtifact(),
          bytes: new Uint8Array(4),
        },
      }),
    ).toBe(false);
    expect(
      isPrintExportWorkerResponse({
        type: "result",
        jobId: 1,
        preflight,
        artifact: {
          ...sampleArtifact(),
          mimeType: "model/stl",
        },
      }),
    ).toBe(false);
    expect(
      isPrintExportWorkerResponse({
        type: "result",
        jobId: 1,
        preflight,
        artifact: sampleArtifact("stl"),
      }),
    ).toBe(false);
    expect(
      isPrintExportWorkerResponse({
        type: "progress",
        jobId: 1,
        phase: "geometry",
        completed: 2,
        message: "Impossible progress",
      }),
    ).toBe(false);
    expect(
      isPrintExportWorkerResponse({
        type: "preflight",
        jobId: 1,
        preflight: {
          ...preflight,
          dimensions: { x: Number.NaN, y: 20, z: 30 },
        },
      }),
    ).toBe(false);
    expect(
      isPrintExportWorkerResponse({
        type: "preflight",
        jobId: 1,
        preflight: {
          ...preflight,
          channels: [{ id: "incomplete" }],
        },
      }),
    ).toBe(false);
  });

  it("preserves structured validation issues and normalizes unknown errors", () => {
    const validation = Object.assign(new Error("Invalid print plan."), {
      name: "PrintPlanValidationError",
      issues: ["City bound X exceeds build volume."],
    });

    expect(serializePrintExportError(validation)).toEqual({
      kind: "validation",
      name: "PrintPlanValidationError",
      message: "Invalid print plan.",
      issues: ["City bound X exceeds build volume."],
    });
    expect(serializePrintExportError("worker vanished")).toEqual({
      kind: "unexpected",
      name: "Error",
      message: "worker vanished",
      issues: [],
    });
  });

  it("validates complete, internally consistent calibration results", () => {
    const generated = generateCalibrationPrintExport({
      profile: createSingleChannelProfile(),
      format: "3mf",
    });
    const preflight = generated.preflight;
    const response = {
      type: "calibration-result",
      jobId: 2,
      preflight,
      artifact: {
        format: "3mf",
        mimeType: "model/3mf",
        fileExtension: ".3mf",
        bytes: new ArrayBuffer(8),
      },
      manifestBytes: new ArrayBuffer(8),
    } as const;

    expect(isPrintExportWorkerResponse(response)).toBe(true);
    expect(
      preflight.measurements.some(
        ({ reference }) => reference === "rail-defined-groove",
      ),
    ).toBe(true);
    expect(preflight.manifest.couponCount).toBeGreaterThan(0);
    expect(
      preflight.measurements.find(
        ({ id }) => id === "build-margin-y",
      )?.axis,
    ).toEqual({
      coordinateSpace: "city",
      cityAxis: "y",
      printAxis: "z",
      meaning: "height",
    });
    expect(
      isPrintExportWorkerResponse({
        ...response,
        preflight: {
          ...preflight,
          measurements: preflight.measurements.map((measurement) => {
            if (measurement.id !== "build-margin-x") return measurement;
            const { axis: _axis, ...withoutOptionalAxis } = measurement;
            return withoutOptionalAxis;
          }),
        },
      }),
    ).toBe(true);
    expect(
      isPrintExportWorkerResponse({
        ...response,
        preflight: {
          ...preflight,
          triangleCount: 0,
        },
      }),
    ).toBe(false);
    expect(
      isPrintExportWorkerResponse({
        ...response,
        preflight: {
          ...preflight,
          measurements: preflight.measurements.map((measurement, index) =>
            index === 1
              ? { ...measurement, id: preflight.measurements[0]!.id }
              : measurement,
          ),
        },
      }),
    ).toBe(false);
    expect(
      isPrintExportWorkerResponse({
        ...response,
        preflight: {
          ...preflight,
          manifest: {
            ...preflight.manifest,
            measurementCount:
              preflight.manifest.measurementCount - 1,
          },
        },
      }),
    ).toBe(false);
    expect(
      isPrintExportWorkerResponse({
        ...response,
        preflight: {
          ...preflight,
          manifest: {
            ...preflight.manifest,
            channelMarkerCount: preflight.channelCount + 1,
          },
        },
      }),
    ).toBe(false);
    expect(
      isPrintExportWorkerResponse({
        ...response,
        preflight: {
          ...preflight,
          manifest: {
            ...preflight.manifest,
            couponCount: 0,
          },
        },
      }),
    ).toBe(false);
    expect(
      isPrintExportWorkerResponse({
        ...response,
        preflight: {
          ...preflight,
          manifest: {
            ...preflight.manifest,
            couponCount: preflight.manifest.couponCount + 1,
          },
        },
      }),
    ).toBe(false);
    expect(
      isPrintExportWorkerResponse({
        ...response,
        preflight: {
          ...preflight,
          measurements: preflight.measurements.map((measurement) =>
            measurement.id === "nozzle-diameter"
              ? { ...measurement, couponId: 42 }
              : measurement,
          ),
        },
      }),
    ).toBe(false);
    expect(
      isPrintExportWorkerResponse({
        ...response,
        preflight: {
          ...preflight,
          measurements: preflight.measurements.map((measurement) =>
            measurement.id === "build-margin-y"
              ? {
                  ...measurement,
                  axis: {
                    coordinateSpace: "city",
                    cityAxis: "y",
                    printAxis: "y",
                    meaning: "height",
                  },
                }
              : measurement,
          ),
        },
      }),
    ).toBe(false);
    expect(
      isPrintExportWorkerResponse({
        ...response,
        preflight: {
          ...preflight,
          measurements: preflight.measurements.map((measurement) =>
            measurement.id === "minimum-gap"
              ? {
                  ...measurement,
                  axis: {
                    coordinateSpace: "city",
                    cityAxis: "x",
                    printAxis: "x",
                    meaning: "width",
                  },
                }
              : measurement,
          ),
        },
      }),
    ).toBe(false);
  });
});
