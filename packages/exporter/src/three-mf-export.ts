import type {
  CityModel,
  PrintLabelPolicy,
  PrinterProfile,
  PrintRoutePolicy,
} from "../../core/src/index.js";

import type {
  PrintableCityArtifacts,
  PrintLabelReport,
  PrintRouteReport,
} from "./geometry.js";
import {
  preparePrintExport,
  serializePreparedPrintExport,
  type PrintExportChannelSummary,
  type PrintExportPhase,
  type PrintExportProgress,
  type PrintExportProgressListener,
} from "./print-export.js";

export interface ThreeMfExportOptions {
  readonly scale: number;
  readonly labelPolicy: PrintLabelPolicy;
  readonly routePolicy: PrintRoutePolicy;
  readonly includeLegend: boolean;
}

export type ThreeMfExportPhase = PrintExportPhase;
export type ThreeMfExportProgress = PrintExportProgress;
export type ThreeMfExportProgressListener = PrintExportProgressListener;
export type ThreeMfExportChannelSummary = PrintExportChannelSummary;

/**
 * Compatibility view of the original 3MF preflight contract. Generic callers
 * should use PrintExportPreflight, which additionally exposes format and
 * triangleCount.
 */
export interface ThreeMfExportPreflight {
  readonly title: string;
  readonly profileId: string;
  readonly profileName: string;
  readonly dimensions: {
    readonly x: number;
    readonly y: number;
    readonly z: number;
  };
  readonly partCount: number;
  readonly channels: readonly ThreeMfExportChannelSummary[];
  readonly warnings: readonly string[];
  readonly labels: PrintLabelReport;
  readonly routes: PrintRouteReport;
  readonly legendIncluded: boolean;
}

export interface ThreeMfExportRequest {
  readonly model: unknown;
  readonly profile: unknown;
  readonly options: ThreeMfExportOptions;
}

export interface PreparedThreeMfExport {
  readonly model: CityModel;
  readonly profile: PrinterProfile;
  readonly options: ThreeMfExportOptions;
  readonly artifacts: PrintableCityArtifacts;
  readonly preflight: ThreeMfExportPreflight;
}

export interface ThreeMfExportResult {
  readonly preflight: ThreeMfExportPreflight;
  readonly threeMfBytes: Uint8Array;
  readonly legendBytes?: Uint8Array;
}

function legacyPreflight(
  prepared: ReturnType<typeof preparePrintExport>,
): ThreeMfExportPreflight {
  const { format: _format, triangleCount: _triangleCount, ...preflight } =
    prepared.preflight;
  return preflight;
}

export function prepareThreeMfExport(
  request: ThreeMfExportRequest,
  onProgress?: ThreeMfExportProgressListener,
): PreparedThreeMfExport {
  const prepared = preparePrintExport(
    {
      format: "3mf",
      model: request.model,
      profile: request.profile,
      options: request.options,
    },
    onProgress,
  );
  return {
    model: prepared.model,
    profile: prepared.profile,
    options: prepared.options,
    artifacts: prepared.artifacts,
    preflight: legacyPreflight(prepared),
  };
}

export function serializePreparedThreeMfExport(
  prepared: PreparedThreeMfExport,
  onProgress?: ThreeMfExportProgressListener,
): ThreeMfExportResult {
  const triangleCount = prepared.artifacts.city.parts.reduce(
    (count, part) => count + part.mesh.triangles.length,
    0,
  );
  const result = serializePreparedPrintExport(
    {
      format: "3mf",
      model: prepared.model,
      profile: prepared.profile,
      options: prepared.options,
      artifacts: prepared.artifacts,
      preflight: {
        format: "3mf",
        triangleCount,
        ...prepared.preflight,
      },
    },
    onProgress,
  );
  return {
    preflight: prepared.preflight,
    threeMfBytes: result.artifact.bytes,
    ...(result.legendBytes === undefined
      ? {}
      : { legendBytes: result.legendBytes }),
  };
}

export function generateThreeMfExport(
  request: ThreeMfExportRequest,
  onProgress?: ThreeMfExportProgressListener,
): ThreeMfExportResult {
  return serializePreparedThreeMfExport(
    prepareThreeMfExport(request, onProgress),
    onProgress,
  );
}
