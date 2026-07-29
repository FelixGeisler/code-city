import { describe, expect, it, vi } from "vitest";

import { DEMO_MODEL } from "../apps/viewer/src/demo-model.js";
import {
  installPrintExportWorker,
  isDedicatedPrintExportWorkerScope,
  runPrintExportRequest,
  type PrintExportWorkerScope,
} from "../apps/viewer/src/print-export-worker.js";
import type {
  PrintExportGenerateRequest,
  PrintExportWorkerResponse,
} from "../apps/viewer/src/print-export-protocol.js";
import { createPrusaXLProfile } from "../packages/core/src/index.js";
import { generateThreeMfExport } from "../packages/exporter/src/index.js";

function request(
  overrides: Partial<PrintExportGenerateRequest> = {},
): PrintExportGenerateRequest {
  return {
    type: "generate",
    jobId: 17,
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
  it("runs the deterministic exporter without network access and transfers results", () => {
    const workerRequest = request();
    const shared = generateThreeMfExport({
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
    expect(result.response.threeMfBytes.byteLength).toBeGreaterThan(0);
    expect(result.response.legendBytes?.byteLength).toBeGreaterThan(0);
    expect(new Uint8Array(result.response.threeMfBytes)).toEqual(
      shared.threeMfBytes,
    );
    expect(new Uint8Array(result.response.legendBytes!)).toEqual(
      shared.legendBytes,
    );
    expect(result.transfer).toEqual([
      result.response.threeMfBytes,
      result.response.legendBytes,
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
