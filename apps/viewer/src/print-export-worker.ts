import {
  prepareThreeMfExport,
  serializePreparedThreeMfExport,
} from "../../../packages/exporter/src/three-mf-export.js";
import {
  generateCalibrationExport,
} from "../../../packages/exporter/src/calibration.js";
import {
  isPrintExportWorkerRequest,
  serializePrintExportError,
  type PrintExportWorkerRequest,
  type PrintExportWorkerResponse,
} from "./print-export-protocol.js";

export type PrintExportWorkerEmitter = (
  response: PrintExportWorkerResponse,
  transfer?: readonly ArrayBuffer[],
) => void;

export interface PrintExportWorkerScope {
  readonly document?: unknown;
  readonly clients?: unknown;
  readonly onconnect?: unknown;
  readonly importScripts?: unknown;
  readonly postMessage: (
    message: PrintExportWorkerResponse,
    transfer?: readonly ArrayBuffer[],
  ) => void;
  readonly addEventListener: (
    type: "message",
    listener: (event: { readonly data: unknown }) => void,
  ) => void;
  readonly removeEventListener: (
    type: "message",
    listener: (event: { readonly data: unknown }) => void,
  ) => void;
}

function transferableBuffer(bytes: Uint8Array): ArrayBuffer {
  if (
    bytes.buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength
  ) {
    return bytes.buffer;
  }
  return bytes.slice().buffer;
}

export function runPrintExportRequest(
  request: PrintExportWorkerRequest,
  emit: PrintExportWorkerEmitter,
): void {
  try {
    if (request.type === "calibrate") {
      emit({
        type: "progress",
        jobId: request.jobId,
        phase: "validating",
        completed: 0,
        message: "Validating calibration profile",
      });
      const result = generateCalibrationExport(request.profile);
      const threeMfBytes = transferableBuffer(result.threeMfBytes);
      const manifestBytes = transferableBuffer(result.manifestBytes);
      emit({
        type: "progress",
        jobId: request.jobId,
        phase: "complete",
        completed: 1,
        message: "Calibration files are ready",
      });
      emit(
        {
          type: "calibration-result",
          jobId: request.jobId,
          preflight: result.preflight,
          threeMfBytes,
          manifestBytes,
        },
        [threeMfBytes, manifestBytes],
      );
      return;
    }

    const prepared = prepareThreeMfExport(
      {
        model: request.model,
        profile: request.profile,
        options: request.options,
      },
      (progress) => {
        emit({
          type: "progress",
          jobId: request.jobId,
          ...progress,
        });
      },
    );
    emit({
      type: "preflight",
      jobId: request.jobId,
      preflight: prepared.preflight,
    });

    const result = serializePreparedThreeMfExport(prepared, (progress) => {
      emit({
        type: "progress",
        jobId: request.jobId,
        ...progress,
      });
    });
    const threeMfBytes = transferableBuffer(result.threeMfBytes);
    const legendBytes =
      result.legendBytes === undefined
        ? undefined
        : transferableBuffer(result.legendBytes);
    const response: PrintExportWorkerResponse = {
      type: "result",
      jobId: request.jobId,
      preflight: result.preflight,
      threeMfBytes,
      ...(legendBytes === undefined ? {} : { legendBytes }),
    };
    emit(
      response,
      legendBytes === undefined
        ? [threeMfBytes]
        : [threeMfBytes, legendBytes],
    );
  } catch (error) {
    emit({
      type: "failure",
      jobId: request.jobId,
      error: serializePrintExportError(error),
    });
  }
}

export function isDedicatedPrintExportWorkerScope(
  value: unknown,
): value is PrintExportWorkerScope {
  if (typeof value !== "object" || value === null) return false;
  const scope = value as Record<string, unknown>;
  return (
    typeof scope["importScripts"] === "function" &&
    typeof scope["postMessage"] === "function" &&
    typeof scope["addEventListener"] === "function" &&
    typeof scope["removeEventListener"] === "function" &&
    !("document" in scope) &&
    !("clients" in scope) &&
    !("onconnect" in scope)
  );
}

export function installPrintExportWorker(
  scope: PrintExportWorkerScope,
): () => void {
  const listener = (event: { readonly data: unknown }): void => {
    if (!isPrintExportWorkerRequest(event.data)) return;
    runPrintExportRequest(event.data, (response, transfer = []) => {
      scope.postMessage(response, transfer);
    });
  };
  scope.addEventListener("message", listener);
  return () => {
    scope.removeEventListener("message", listener);
  };
}

if (isDedicatedPrintExportWorkerScope(globalThis)) {
  installPrintExportWorker(
    globalThis as unknown as PrintExportWorkerScope,
  );
}
