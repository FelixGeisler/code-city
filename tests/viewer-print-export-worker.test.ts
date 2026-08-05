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
import {
  generatePrintPlateBundle,
  preparePrintPlateBundle,
  serializePreparedSinglePrintPlateExport,
} from "../packages/exporter/src/print-plates.js";

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
    const shared = serializePreparedSinglePrintPlateExport(
      preparePrintPlateBundle({
        format,
        model: workerRequest.model,
        profile: workerRequest.profile,
        options: {
          ...workerRequest.options,
          fitPolicy: "error",
        },
      }),
    );
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
    ).toEqual([
      "validating",
      "layout",
      "geometry",
      "serializing",
      "complete",
    ]);
    const preflightIndex = emitted.findIndex(
      ({ response }) => response.type === "preflight",
    );
    const resultIndex = emitted.findIndex(
      ({ response }) => response.type === "result",
    );
    expect(preflightIndex).toBeGreaterThan(0);
    expect(resultIndex).toBeGreaterThan(preflightIndex);
    const preflight = emitted[preflightIndex]!.response;
    expect(preflight.type).toBe("preflight");
    if (preflight.type !== "preflight") {
      throw new Error("Expected a preflight response.");
    }
    expect(preflight.preview).toMatchObject({
      fitPolicy: "error",
      appliedPolicy: "error",
      plates: [
        {
          number: 1,
          id: "plate-01",
          fileName: `plate-01.${format}`,
        },
      ],
    });
    const previewPrimitives = preflight.preview.plates[0]?.parts.flatMap(
      ({ primitives }) => primitives,
    );
    expect(previewPrimitives?.length).toBeGreaterThan(0);
    expect(
      previewPrimitives?.every(
        ({ mesh }) =>
          mesh.vertices.length > 0 && mesh.triangles.length > 0,
      ),
    ).toBe(true);

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
    expect(new Uint8Array(result.response.manifestBytes)).toEqual(
      shared.manifestBytes,
    );
    expect(result.transfer).toEqual([
      result.response.artifact.bytes,
      result.response.manifestBytes,
      result.response.legendBytes,
    ]);
    },
  );

  it("fails an oversized default export before publishing a preview", () => {
    const responses: PrintExportWorkerResponse[] = [];

    runPrintExportRequest(
      request({
        options: {
          scale: 100,
          labelPolicy: "off",
          routePolicy: "off",
          includeLegend: false,
        },
      }),
      (response) => responses.push(response),
    );

    expect(
      responses.some(
        ({ type }) => type === "preflight" || type === "result",
      ),
    ).toBe(false);
    expect(responses.at(-1)).toMatchObject({
      type: "failure",
      error: {
        message: expect.stringMatching(/requires.*packing span/iu),
      },
    });
  });

  it("transfers acknowledged below-profile preflight and direct manifest exactly", () => {
    const workerRequest = request({
      profile: createSingleChannelProfile(),
      options: {
        scale: 0.5,
        fitPolicy: "error",
        acknowledgeBelowProfileScale: true,
        labelPolicy: "off",
        routePolicy: "off",
        includeLegend: false,
      },
    });
    const emitted: Array<{
      response: PrintExportWorkerResponse;
      transfer: readonly ArrayBuffer[];
    }> = [];

    runPrintExportRequest(workerRequest, (response, transfer = []) => {
      emitted.push({ response, transfer });
    });

    const preflight = emitted.find(
      ({ response }) => response.type === "preflight",
    )?.response;
    expect(preflight).toMatchObject({
      type: "preflight",
      preflight: {
        requestedScale: 0.5,
        appliedScale: 0.5,
        minimumSafeScale: 1.6,
        belowProfileScaleAcknowledged: true,
        featureViolations: expect.arrayContaining([
          expect.objectContaining({ category: "wall-thickness" }),
        ]),
      },
      preview: {
        requestedScale: 0.5,
        appliedScale: 0.5,
        minimumSafeScale: 1.6,
        belowProfileScaleAcknowledged: true,
      },
    });
    const result = emitted.at(-1)!;
    expect(result.response.type).toBe("result");
    if (result.response.type !== "result") {
      throw new Error("Expected a direct export result.");
    }
    const manifest = JSON.parse(
      new TextDecoder().decode(result.response.manifestBytes),
    );
    expect(manifest.fit).toMatchObject({
      requestedScale: 0.5,
      appliedScale: 0.5,
      minimumSafeScale: 1.6,
      belowProfileScaleAcknowledged: true,
    });
    expect(result.transfer).toEqual([
      result.response.artifact.bytes,
      result.response.manifestBytes,
    ]);
  });

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

  it("returns an exact deterministic ZIP and preview for fitted plate bundles", () => {
    const workerRequest = request({
      options: {
        scale: 3,
        fitPolicy: "scale",
        maximumPlateCount: 12,
        labelPolicy: "auto",
        routePolicy: "auto",
        includeLegend: true,
      },
    });
    const shared = generatePrintPlateBundle({
      format: workerRequest.format,
      model: workerRequest.model,
      profile: workerRequest.profile,
      options: {
        ...workerRequest.options,
        fitPolicy: "scale",
      },
    });
    const emitted: Array<{
      response: PrintExportWorkerResponse;
      transfer: readonly ArrayBuffer[];
    }> = [];

    runPrintExportRequest(workerRequest, (response, transfer = []) => {
      emitted.push({ response, transfer });
    });

    expect(
      emitted
        .filter(({ response }) => response.type === "progress")
        .map(({ response }) =>
          response.type === "progress" ? response.phase : "",
        ),
    ).toEqual([
      "validating",
      "layout",
      "geometry",
      "serializing",
      "complete",
    ]);
    const preflight = emitted.find(
      ({ response }) => response.type === "bundle-preflight",
    )?.response;
    expect(preflight).toMatchObject({
      type: "bundle-preflight",
      preflight: {
        plateCount: shared.preflight.plateCount,
        appliedScale: shared.preflight.appliedScale,
      },
    });
    if (preflight?.type !== "bundle-preflight") {
      throw new Error("Expected a bundle preflight response.");
    }
    expect(preflight.preview.plates).toHaveLength(
      shared.manifest.plateCount,
    );
    const result = emitted.at(-1)!;
    expect(result.response.type).toBe("bundle-result");
    if (result.response.type !== "bundle-result") {
      throw new Error("Expected a bundle result response.");
    }
    expect(new Uint8Array(result.response.artifact.bytes)).toEqual(
      shared.bytes,
    );
    expect(new Uint8Array(result.response.manifestBytes)).toEqual(
      shared.manifestBytes,
    );
    expect(new Uint8Array(result.response.legendBytes!)).toEqual(
      shared.legendBytes,
    );
    expect(result.transfer).toEqual([
      result.response.artifact.bytes,
      result.response.manifestBytes,
      result.response.legendBytes,
    ]);
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
