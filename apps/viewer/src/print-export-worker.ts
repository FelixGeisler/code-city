import {
  type PrintExportArtifact,
} from "../../../packages/exporter/src/print-export.js";
import {
  generateCalibrationPrintExport,
} from "../../../packages/exporter/src/calibration.js";
import {
  preparePrintPlateBundle,
  serializePreparedPrintPlateBundle,
  serializePreparedSinglePrintPlateExport,
  type PreparedPrintPlateBundle,
} from "../../../packages/exporter/src/print-plates.js";
import type { PrintFitPolicy } from "../../../packages/core/src/print-layout.js";
import {
  isPrintExportWorkerRequest,
  serializePrintExportError,
  type PrintExportGenerateRequest,
  type PrintExportPreviewSource,
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

function preparedPreview(
  prepared: PreparedPrintPlateBundle,
  requestedPolicy: NonNullable<
    PrintExportGenerateRequest["options"]["fitPolicy"]
  >,
): PrintExportPreviewSource {
  return {
    ...prepared.preview,
    fitPolicy: requestedPolicy,
    appliedPolicy: prepared.layout.fitPolicy,
  };
}

function rejectIncompletePreparedBundle(
  prepared: PreparedPrintPlateBundle,
): void {
  if (
    prepared.layout.unplaced.length === 0 &&
    prepared.preflight.unplacedObjects.length === 0 &&
    prepared.preview.unplacedObjects.length === 0
  ) {
    return;
  }
  const identifiers = [
    ...prepared.layout.unplaced.map(({ id }) => id),
    ...prepared.preflight.unplacedObjects.map(({ id }) => id),
    ...prepared.preview.unplacedObjects.map(({ id }) => id),
  ];
  const error = Object.assign(
    new Error(
      "The print layout is incomplete; every object must be placed before export.",
    ),
    {
      name: "PrintLayoutError",
      issues: [
        {
          code: "city-does-not-fit" as const,
          message:
            `The print layout left ${new Set(identifiers).size.toLocaleString("en-US")} ` +
            "objects unplaced; no partial print file was created.",
        },
      ],
    },
  );
  throw error;
}

function prepareConcretePrintExport(
  request: PrintExportGenerateRequest,
  fitPolicy: PrintFitPolicy,
  acknowledgeBelowProfileScale: boolean,
  emit: PrintExportWorkerEmitter,
): PreparedPrintPlateBundle {
  const prepared = preparePrintPlateBundle(
    {
      format: request.format,
      model: request.model,
      profile: request.profile,
      options: {
        scale: request.options.scale,
        fitPolicy,
        ...(acknowledgeBelowProfileScale
          ? { acknowledgeBelowProfileScale: true }
          : {}),
        labelPolicy: request.options.labelPolicy,
        routePolicy: request.options.routePolicy,
        includeLegend: request.options.includeLegend,
        ...(request.options.wipeTowerReserveDepth === undefined
          ? {}
          : {
              wipeTowerReserveDepth:
                request.options.wipeTowerReserveDepth,
            }),
        ...(fitPolicy !== "tile" ||
        request.options.maximumPlateCount === undefined
          ? {}
          : {
              maximumPlateCount:
                request.options.maximumPlateCount,
            }),
      },
    },
    (value) => {
      emit({
        type: "progress",
        jobId: request.jobId,
        phase: value.phase,
        completed: value.completed,
        message: value.message,
      });
    },
  );
  rejectIncompletePreparedBundle(prepared);
  return prepared;
}

function serializePreparedOutput(
  request: PrintExportGenerateRequest,
  requestedPolicy: NonNullable<
    PrintExportGenerateRequest["options"]["fitPolicy"]
  >,
  prepared: PreparedPrintPlateBundle,
  emit: PrintExportWorkerEmitter,
): void {
  rejectIncompletePreparedBundle(prepared);
  const preview = preparedPreview(prepared, requestedPolicy);
  if (prepared.preflight.plateCount === 1) {
    emit({
      type: "preflight",
      jobId: request.jobId,
      preflight: prepared.preflight,
      preview,
    });
    const result = serializePreparedSinglePrintPlateExport(
      prepared,
      (value) => {
        emit({
          type: "progress",
          jobId: request.jobId,
          phase: value.phase,
          completed: value.completed,
          message: value.message,
        });
      },
    );
    const artifact = transferableArtifact(result.artifact);
    const manifestBytes = transferableBuffer(result.manifestBytes);
    const legendBytes =
      result.legendBytes === undefined
        ? undefined
        : transferableBuffer(result.legendBytes);
    emit(
      {
        type: "result",
        jobId: request.jobId,
        artifact,
        manifestBytes,
        ...(legendBytes === undefined ? {} : { legendBytes }),
      },
      legendBytes === undefined
        ? [artifact.bytes, manifestBytes]
        : [artifact.bytes, manifestBytes, legendBytes],
    );
    return;
  }

  emit({
    type: "bundle-preflight",
    jobId: request.jobId,
    preflight: prepared.preflight,
    preview,
  });
  const result = serializePreparedPrintPlateBundle(
    prepared,
    (value) => {
      emit({
        type: "progress",
        jobId: request.jobId,
        phase: value.phase,
        completed: value.completed,
        message: value.message,
      });
    },
  );
  const bundleBytes = transferableBuffer(result.bytes);
  const manifestBytes = transferableBuffer(result.manifestBytes);
  const legendBytes =
    result.legendBytes === undefined
      ? undefined
      : transferableBuffer(result.legendBytes);
  emit(
    {
      type: "bundle-result",
      jobId: request.jobId,
      artifact: {
        format: "zip",
        mimeType: "application/zip",
        fileExtension: ".zip",
        bytes: bundleBytes,
      },
      manifestBytes,
      ...(legendBytes === undefined ? {} : { legendBytes }),
    },
    legendBytes === undefined
      ? [bundleBytes, manifestBytes]
      : [bundleBytes, manifestBytes, legendBytes],
  );
}

function prepareAutoPrintExport(
  request: PrintExportGenerateRequest,
  emit: PrintExportWorkerEmitter,
): PreparedPrintPlateBundle | undefined {
  let lastError: unknown;
  for (const fitPolicy of ["error", "scale", "tile"] as const) {
    try {
      return prepareConcretePrintExport(request, fitPolicy, false, emit);
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        (error as { readonly name?: unknown }).name !== "PrintLayoutError"
      ) {
        throw error;
      }
      lastError = error;
    }
  }

  let compact: PreparedPrintPlateBundle;
  try {
    compact = prepareConcretePrintExport(request, "scale", true, emit);
  } catch (error) {
    throw error ?? lastError;
  }
  if (compact.preflight.featureViolations.length === 0) {
    return compact;
  }
  if (request.options.confirmCompactFit === true) {
    return compact;
  }
  emit({
    type: "progress",
    jobId: request.jobId,
    phase: "layout",
    completed: 0.8,
    message: "Compact one-plate fit is ready for confirmation",
  });
  emit({
    type: "confirmation-required",
    jobId: request.jobId,
    preflight: compact.preflight,
    preview: preparedPreview(compact, "auto"),
  });
  return undefined;
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

    const requestedPolicy = request.options.fitPolicy ?? "auto";
    if (requestedPolicy === "auto") {
      const prepared = prepareAutoPrintExport(request, emit);
      if (prepared !== undefined) {
        serializePreparedOutput(request, "auto", prepared, emit);
      }
      return;
    }

    const prepared = prepareConcretePrintExport(
      request,
      requestedPolicy,
      false,
      emit,
    );
    serializePreparedOutput(
      request,
      requestedPolicy,
      prepared,
      emit,
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
