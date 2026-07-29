import { describe, expect, it, vi } from "vitest";

import { DEMO_MODEL } from "../apps/viewer/src/demo-model.js";
import {
  installPrintExportWorker,
  isDedicatedPrintExportWorkerScope,
  runPrintExportRequest,
  type PrintExportWorkerScope,
} from "../apps/viewer/src/print-export-worker.js";
import type {
  PrintCalibrationGenerateRequest,
  PrintExportGenerateRequest,
  PrintExportWorkerResponse,
} from "../apps/viewer/src/print-export-protocol.js";
import {
  createPrusaXLProfile,
  createSingleChannelProfile,
} from "../packages/core/src/index.js";
import {
  generateCalibrationPrintExport,
} from "../packages/exporter/src/calibration.js";
import { generatePrintExport } from "../packages/exporter/src/print-export.js";

function request(
  overrides: Partial<PrintExportGenerateRequest> = {},
): PrintExportGenerateRequest {
  return {
    type: "generate",
    jobId: 17,
    format: "3mf",
    model: DEMO_MODEL,
    profile: createPrusaXLProfile([1, 2, 3, 4, 5]),
    options: {
      scale: 3,
      labelPolicy: "off",
      routePolicy: "off",
      includeLegend: true,
    },
    ...overrides,
  };
}

describe("viewer print export worker", () => {
  it.each(["3mf", "stl"] as const)(
    "runs the deterministic %s exporter without network access and transfers exact bytes",
    (format) => {
    const workerRequest = request({ format });
    const shared = generatePrintExport({
      format,
      model: workerRequest.model,
      profile: workerRequest.profile,
      options: workerRequest.options,
    });
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() => {
        throw new Error("The export worker must not access the network.");
      });
    const emitted: Array<{
      response: PrintExportWorkerResponse;
      transfer: readonly ArrayBuffer[];
    }> = [];

    try {
      runPrintExportRequest(workerRequest, (response, transfer = []) => {
        emitted.push({ response, transfer });
      });
    } finally {
      fetch.mockRestore();
    }

    expect(fetch).not.toHaveBeenCalled();
    expect(
      emitted
        .filter(({ response }) => response.type === "progress")
        .map(({ response }) =>
          response.type === "progress" ? response.phase : "",
        ),
    ).toEqual(["validating", "geometry", "serializing", "complete"]);
    const preflightIndex = emitted.findIndex(
      ({ response }) => response.type === "preflight",
    );
    const resultIndex = emitted.findIndex(
      ({ response }) => response.type === "result",
    );
    expect(preflightIndex).toBeGreaterThan(0);
    expect(resultIndex).toBeGreaterThan(preflightIndex);

    const result = emitted[resultIndex]!;
    expect(result.response.type).toBe("result");
    if (result.response.type !== "result") {
      throw new Error("Expected a result response.");
    }
    expect(result.response.artifact).toMatchObject({
      format,
      mimeType:
        format === "3mf"
          ? "model/3mf"
          : "model/stl",
      fileExtension: format === "3mf" ? ".3mf" : ".stl",
    });
    expect(result.response.artifact.bytes.byteLength).toBeGreaterThan(0);
    expect(result.response.legendBytes?.byteLength).toBeGreaterThan(0);
    expect(new Uint8Array(result.response.artifact.bytes)).toEqual(
      shared.artifact.bytes,
    );
    expect(new Uint8Array(result.response.legendBytes!)).toEqual(
      shared.legendBytes,
    );
    expect(result.transfer).toEqual([
      result.response.artifact.bytes,
      result.response.legendBytes,
    ]);
    },
  );

  it("returns structured failures instead of throwing out of the worker", () => {
    const responses: PrintExportWorkerResponse[] = [];

    expect(() =>
      runPrintExportRequest(request({ model: {} }), (response) => {
        responses.push(response);
      }),
    ).not.toThrow();
    expect(responses).toHaveLength(2);
    expect(responses[0]).toMatchObject({
      type: "progress",
      phase: "validating",
    });
    expect(responses[1]).toMatchObject({
      type: "failure",
      jobId: 17,
      error: {
        message: expect.stringMatching(/schemaVersion/iu),
      },
    });
  });

  it.each(["3mf", "stl"] as const)(
    "generates profile-only %s calibration files without network access",
    (format) => {
    const calibrationRequest: PrintCalibrationGenerateRequest = {
      type: "calibrate",
      jobId: 18,
      format,
      profile: createSingleChannelProfile(),
    };
    const shared = generateCalibrationPrintExport({
      profile: calibrationRequest.profile,
      format,
    });
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() => {
        throw new Error("The calibration worker must not access the network.");
      });
    const emitted: Array<{
      response: PrintExportWorkerResponse;
      transfer: readonly ArrayBuffer[];
    }> = [];

    try {
      runPrintExportRequest(
        calibrationRequest,
        (response, transfer = []) => {
          emitted.push({ response, transfer });
        },
      );
    } finally {
      fetch.mockRestore();
    }

    expect(fetch).not.toHaveBeenCalled();
    expect(
      emitted
        .filter(({ response }) => response.type === "progress")
        .map(({ response }) =>
          response.type === "progress" ? response.phase : "",
        ),
    ).toEqual(["validating", "complete"]);
    const result = emitted.at(-1)!;
    expect(result.response.type).toBe("calibration-result");
    if (result.response.type !== "calibration-result") {
      throw new Error("Expected a calibration result response.");
    }
    expect(result.response.artifact).toMatchObject({
      format,
      mimeType:
        format === "3mf"
          ? "model/3mf"
          : "model/stl",
      fileExtension: format === "3mf" ? ".3mf" : ".stl",
    });
    expect(new Uint8Array(result.response.artifact.bytes)).toEqual(
      shared.artifact.bytes,
    );
    expect(new Uint8Array(result.response.manifestBytes)).toEqual(
      shared.manifestBytes,
    );
    expect(result.transfer).toEqual([
      result.response.artifact.bytes,
      result.response.manifestBytes,
    ]);
    },
  );

  it("installs only in a dedicated worker-like scope and ignores other messages", () => {
    let listener:
      | ((event: { readonly data: unknown }) => void)
      | undefined;
    const posted: PrintExportWorkerResponse[] = [];
    const scope: PrintExportWorkerScope = {
      importScripts: () => undefined,
      postMessage: (message) => posted.push(message),
      addEventListener: (_type, value) => {
        listener = value;
      },
      removeEventListener: (_type, value) => {
        if (listener === value) listener = undefined;
      },
    };

    expect(isDedicatedPrintExportWorkerScope(scope)).toBe(true);
    expect(
      isDedicatedPrintExportWorkerScope({
        ...scope,
        document: {},
      }),
    ).toBe(false);

    const uninstall = installPrintExportWorker(scope);
    listener?.({ data: { type: "not-an-export" } });
    expect(posted).toEqual([]);
    uninstall();
    expect(listener).toBeUndefined();
  });
});
