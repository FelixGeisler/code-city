import {
  preparePrintExport,
  serializePreparedPrintExport,
  type PrintExportArtifact,
} from "../../../packages/exporter/src/print-export.js";
import {
  generateCalibrationPrintExport,
} from "../../../packages/exporter/src/calibration.js";
import {
  isPrintExportWorkerRequest,
  serializePrintExportError,
  type PrintExportTransferArtifact,
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

function transferableArtifact(
  artifact: PrintExportArtifact,
): PrintExportTransferArtifact {
  const bytes = transferableBuffer(artifact.bytes);
  if (
    artifact.format === "3mf" &&
    artifact.mimeType === "model/3mf" &&
    artifact.fileExtension === ".3mf"
  ) {
    return {
      format: "3mf",
      mimeType: "model/3mf",
      fileExtension: ".3mf",
      bytes,
    };
  }
  if (
    artifact.format === "stl" &&
    artifact.mimeType === "model/stl" &&
    artifact.fileExtension === ".stl"
  ) {
    return {
      format: "stl",
      mimeType: "model/stl",
      fileExtension: ".stl",
      bytes,
    };
  }
  throw new Error("The print exporter returned an invalid artifact tuple.");
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
      const result = generateCalibrationPrintExport({
        profile: request.profile,
        format: request.format,
      });
      const artifact = transferableArtifact(result.artifact);
      const manifestBytes = transferableBuffer(result.manifestBytes);
      emit({
        type: "progress",
        jobId: request.jobId,
        phase: "complete",
        completed: 1,
        message: `${request.format.toUpperCase()} calibration files are ready`,
      });
      emit(
        {
          type: "calibration-result",
          jobId: request.jobId,
          preflight: result.preflight,
          artifact,
          manifestBytes,
        },
        [artifact.bytes, manifestBytes],
      );
      return;
    }

    const prepared = preparePrintExport(
      {
        format: request.format,
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

    const result = serializePreparedPrintExport(prepared, (progress) => {
      emit({
        type: "progress",
        jobId: request.jobId,
        ...progress,
      });
    });
    const artifact = transferableArtifact(result.artifact);
    const legendBytes =
      result.legendBytes === undefined
        ? undefined
        : transferableBuffer(result.legendBytes);
    const response: PrintExportWorkerResponse = {
      type: "result",
      jobId: request.jobId,
      preflight: result.preflight,
      artifact,
      ...(legendBytes === undefined ? {} : { legendBytes }),
    };
    emit(
      response,
      legendBytes === undefined
        ? [artifact.bytes]
        : [artifact.bytes, legendBytes],
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
