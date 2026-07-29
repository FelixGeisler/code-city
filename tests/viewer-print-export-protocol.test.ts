import { describe, expect, it } from "vitest";

import {
  isPrintExportGenerateRequest,
  isPrintExportWorkerResponse,
  serializePrintExportError,
  type PrintExportGenerateRequest,
} from "../apps/viewer/src/print-export-protocol.js";
import type { ThreeMfExportPreflight } from "../packages/exporter/src/three-mf-export.js";

function samplePreflight(): ThreeMfExportPreflight {
  return {
    title: "Code City",
    profileId: "printer",
    profileName: "Printer",
    dimensions: { x: 10, y: 20, z: 30 },
    partCount: 1,
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

describe("viewer print export protocol", () => {
  it("accepts only complete generate requests with positive job ids", () => {
    const request: PrintExportGenerateRequest = {
      type: "generate",
      jobId: 7,
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
        options: { ...request.options, routePolicy: "always" },
      }),
    ).toBe(false);
    expect(
      isPrintExportGenerateRequest({
        type: "generate",
        jobId: 1,
        profile: {},
        options: request.options,
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
        threeMfBytes: archive,
      }),
    ).toBe(true);
    expect(
      isPrintExportWorkerResponse({
        type: "result",
        jobId: 1,
        preflight,
        threeMfBytes: new Uint8Array(4),
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
});
