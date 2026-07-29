import {
  assignSemanticGroups,
  parsePrinterProfile,
  planPrint,
  PrintPlanValidationError,
  serializePrintLegend,
  validateCityModel,
  type CityModel,
  type PrintFormat,
  type PrintFitPolicy,
  type PrintLabelPolicy,
  type PrinterProfile,
  type PrintRoutePolicy,
  type SemanticGroupAssignment,
} from "../../core/src/index.js";

import {
  buildPrintableCityArtifacts,
  printablePlanGeometry,
  type PrintableCityArtifacts,
  type PrintLabelReport,
  type PrintRouteReport,
} from "./geometry.js";
import { serializeBinaryStl } from "./stl.js";
import { serializeThreeMf } from "./three-mf.js";

export interface PrintExportOptions {
  readonly scale: number;
  readonly labelPolicy: PrintLabelPolicy;
  readonly routePolicy: PrintRoutePolicy;
  readonly includeLegend: boolean;
  /** Oversize handling. The single-artifact generator supports `error` only. */
  readonly fitPolicy?: PrintFitPolicy;
  readonly maximumPlateCount?: number;
}

export type PrintExportPhase =
  | "validating"
  | "geometry"
  | "serializing"
  | "complete";

export interface PrintExportProgress {
  readonly phase: PrintExportPhase;
  readonly completed: number;
  readonly message: string;
}

export type PrintExportProgressListener = (
  progress: PrintExportProgress,
) => void;

export interface PrintExportChannelSummary {
  readonly id: string;
  readonly label: string;
  readonly partIds: readonly string[];
  readonly semanticGroupIds: readonly string[];
  readonly primitiveCount: number;
}

export interface PrintExportPreflight {
  readonly format: PrintFormat;
  readonly title: string;
  readonly profileId: string;
  readonly profileName: string;
  readonly dimensions: {
    readonly x: number;
    readonly y: number;
    readonly z: number;
  };
  /** Number of serialized artifact parts; STL always collapses to one. */
  readonly partCount: number;
  readonly triangleCount: number;
  readonly channels: readonly PrintExportChannelSummary[];
  readonly warnings: readonly string[];
  readonly labels: PrintLabelReport;
  readonly routes: PrintRouteReport;
  readonly legendIncluded: boolean;
}

export interface PrintExportRequest {
  readonly format: PrintFormat;
  readonly model: unknown;
  readonly profile: unknown;
  readonly options: PrintExportOptions;
}

export interface PreparedPrintExport {
  readonly format: PrintFormat;
  readonly model: CityModel;
  readonly profile: PrinterProfile;
  readonly options: PrintExportOptions;
  readonly artifacts: PrintableCityArtifacts;
  readonly preflight: PrintExportPreflight;
}

export type PrintExportArtifact =
  | {
      readonly format: "3mf";
      readonly mimeType: "model/3mf";
      readonly fileExtension: ".3mf";
      readonly bytes: Uint8Array;
    }
  | {
      readonly format: "stl";
      readonly mimeType: "model/stl";
      readonly fileExtension: ".stl";
      readonly bytes: Uint8Array;
    };

export interface PrintExportResult {
  readonly preflight: PrintExportPreflight;
  readonly artifact: PrintExportArtifact;
  readonly legendBytes?: Uint8Array;
}

export const STL_INFORMATION_LOSS_WARNING =
  "STL is a single multi-shell mesh; colors, tool assignments, and 3MF metadata are not preserved.";

function progress(
  listener: PrintExportProgressListener | undefined,
  phase: PrintExportPhase,
  completed: number,
  message: string,
): void {
  listener?.({ phase, completed, message });
}

function validateOptions(options: PrintExportOptions): void {
  const issues: string[] = [];
  if (!Number.isFinite(options.scale) || options.scale <= 0) {
    issues.push("Print scale must be a positive finite number.");
  }
  if (options.labelPolicy !== "auto" && options.labelPolicy !== "off") {
    issues.push("Label policy must be either 'auto' or 'off'.");
  }
  if (options.routePolicy !== "auto" && options.routePolicy !== "off") {
    issues.push("Print route policy must be either 'auto' or 'off'.");
  }
  if (typeof options.includeLegend !== "boolean") {
    issues.push("Legend selection must be a boolean.");
  }
  if (
    options.fitPolicy !== undefined &&
    options.fitPolicy !== "error" &&
    options.fitPolicy !== "scale" &&
    options.fitPolicy !== "tile"
  ) {
    issues.push("Print fit policy must be 'error', 'scale', or 'tile'.");
  }
  if (
    options.maximumPlateCount !== undefined &&
    (!Number.isSafeInteger(options.maximumPlateCount) ||
      options.maximumPlateCount < 1 ||
      options.maximumPlateCount > 99)
  ) {
    issues.push("Maximum plate count must be an integer from 1 to 99.");
  }
  if (
    options.fitPolicy !== undefined &&
    options.fitPolicy !== "error"
  ) {
    issues.push(
      "Single-artifact export only supports fit policy 'error'; use the print-plate bundle exporter for scale or tile.",
    );
  }
  if (issues.length > 0) {
    throw new PrintPlanValidationError(issues);
  }
}

function mergedGroupWarning(
  assignments: readonly SemanticGroupAssignment[],
): string | undefined {
  const merged = assignments.filter(
    ({ mergedIntoSemanticGroupId }) =>
      mergedIntoSemanticGroupId !== undefined,
  ).length;
  return merged === 0
    ? undefined
    : `${merged} semantic ${merged === 1 ? "group was" : "groups were"} merged into available print channels.`;
}

function exportWarnings(
  format: PrintFormat,
  artifacts: PrintableCityArtifacts,
  assignments: readonly SemanticGroupAssignment[],
  planWarnings: readonly string[],
  includeLegend: boolean,
): readonly string[] {
  const warnings = [...planWarnings];
  const merged = mergedGroupWarning(assignments);
  if (merged !== undefined) warnings.push(merged);
  if (format === "stl") warnings.push(STL_INFORMATION_LOSS_WARNING);

  const skippedLabels =
    artifacts.labels.skippedBuildings +
    artifacts.labels.skippedDistricts;
  if (skippedLabels > 0 && artifacts.legend.labelPolicy === "auto") {
    warnings.push(
      `${skippedLabels} physical ${skippedLabels === 1 ? "label was" : "labels were"} skipped; ${includeLegend ? "use" : "enable"} the companion legend for lookup.`,
    );
  }
  if (artifacts.routes.omittedCount > 0) {
    warnings.push(
      `${artifacts.routes.omittedCount} dependency ${artifacts.routes.omittedCount === 1 ? "route was" : "routes were"} omitted by routing or display limits.`,
    );
  }
  return [...new Set(warnings)];
}

function channelSummaries(
  artifacts: PrintableCityArtifacts,
  profile: PrinterProfile,
): readonly PrintExportChannelSummary[] {
  const channels = new Map(
    profile.printChannels.map((channel) => [channel.id, channel]),
  );
  return artifacts.city.parts.map((part) => ({
    id: part.channelId,
    label: channels.get(part.channelId)?.label ?? part.name,
    partIds: [part.id],
    semanticGroupIds: [...part.semanticGroupIds],
    primitiveCount: part.primitives.length,
  }));
}

export function preparePrintExport(
  request: PrintExportRequest,
  onProgress?: PrintExportProgressListener,
): PreparedPrintExport {
  progress(onProgress, "validating", 0.1, "Validating model and printer profile");
  validateOptions(request.options);
  if (request.format !== "3mf" && request.format !== "stl") {
    throw new PrintPlanValidationError([
      "Export format must be either '3mf' or 'stl'.",
    ]);
  }
  const model = validateCityModel(request.model);
  const profile = parsePrinterProfile(request.profile);
  if (!profile.supportedFormats.includes(request.format)) {
    throw new PrintPlanValidationError([
      `Format '${request.format}' is not supported by profile '${profile.id}'.`,
    ]);
  }
  const assignments = assignSemanticGroups(
    profile,
    model.semanticGroups,
  );

  progress(onProgress, "geometry", 0.35, "Building printable geometry");
  const artifacts = buildPrintableCityArtifacts(model, assignments, {
    profile,
    scale: request.options.scale,
    labelPolicy: request.options.labelPolicy,
    routePolicy: request.options.routePolicy,
  });
  const geometry = printablePlanGeometry(artifacts.city);
  const plan = planPrint(profile, {
    format: request.format,
    scale: request.options.scale,
    labelPolicy: request.options.labelPolicy,
    routePolicy: request.options.routePolicy,
    semanticGroups: model.semanticGroups,
    bounds: geometry.bounds,
    geometry: {
      wallThickness: artifacts.city.measurements.wallThickness,
      gap: artifacts.city.measurements.minimumGap,
      minimumFeatureSize: artifacts.city.measurements.minimumFeatureSize,
      baseThickness: artifacts.city.measurements.baseThickness,
    },
    ...(model.identity === undefined ? {} : { identity: model.identity }),
    ...(geometry.identityPanel === undefined
      ? {}
      : { identityPanel: geometry.identityPanel }),
  });
  const size = artifacts.city.bounds.size;
  const triangleCount = artifacts.city.parts.reduce(
    (count, part) => count + part.mesh.triangles.length,
    0,
  );
  const preflight: PrintExportPreflight = {
    format: request.format,
    title: artifacts.city.title,
    profileId: profile.id,
    profileName: profile.name,
    dimensions: { x: size.x, y: size.y, z: size.z },
    partCount:
      request.format === "stl" ? 1 : artifacts.city.parts.length,
    triangleCount,
    channels: channelSummaries(artifacts, profile),
    warnings: exportWarnings(
      request.format,
      artifacts,
      assignments,
      plan.warnings,
      request.options.includeLegend,
    ),
    labels: { ...artifacts.labels },
    routes: { ...artifacts.routes },
    legendIncluded: request.options.includeLegend,
  };
  return {
    format: request.format,
    model,
    profile,
    options: { ...request.options },
    artifacts,
    preflight,
  };
}

function serializeArtifact(prepared: PreparedPrintExport): PrintExportArtifact {
  if (prepared.format === "3mf") {
    return {
      format: "3mf",
      mimeType: "model/3mf",
      fileExtension: ".3mf",
      bytes: serializeThreeMf(prepared.artifacts.city),
    };
  }
  return {
    format: "stl",
    mimeType: "model/stl",
    fileExtension: ".stl",
    bytes: serializeBinaryStl(prepared.artifacts.city),
  };
}

export function serializePreparedPrintExport(
  prepared: PreparedPrintExport,
  onProgress?: PrintExportProgressListener,
): PrintExportResult {
  progress(
    onProgress,
    "serializing",
    0.75,
    `Serializing deterministic ${prepared.format.toUpperCase()}`,
  );
  const artifact = serializeArtifact(prepared);
  const legendBytes = prepared.options.includeLegend
    ? serializePrintLegend(prepared.artifacts.legend)
    : undefined;
  progress(
    onProgress,
    "complete",
    1,
    `${prepared.format.toUpperCase()} export ready`,
  );
  return {
    preflight: prepared.preflight,
    artifact,
    ...(legendBytes === undefined ? {} : { legendBytes }),
  };
}

export function generatePrintExport(
  request: PrintExportRequest,
  onProgress?: PrintExportProgressListener,
): PrintExportResult {
  return serializePreparedPrintExport(
    preparePrintExport(request, onProgress),
    onProgress,
  );
}
