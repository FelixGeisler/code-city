import {
  assignSemanticGroups,
  parsePrinterProfile,
  planPrint,
  PrintPlanValidationError,
  serializePrintLegend,
  validateCityModel,
  type CityModel,
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
import { serializeThreeMf } from "./three-mf.js";

export interface ThreeMfExportOptions {
  readonly scale: number;
  readonly labelPolicy: PrintLabelPolicy;
  readonly routePolicy: PrintRoutePolicy;
  readonly includeLegend: boolean;
}

export type ThreeMfExportPhase =
  | "validating"
  | "geometry"
  | "serializing"
  | "complete";

export interface ThreeMfExportProgress {
  readonly phase: ThreeMfExportPhase;
  readonly completed: number;
  readonly message: string;
}

export type ThreeMfExportProgressListener = (
  progress: ThreeMfExportProgress,
) => void;

export interface ThreeMfExportChannelSummary {
  readonly id: string;
  readonly label: string;
  readonly partIds: readonly string[];
  readonly semanticGroupIds: readonly string[];
  readonly primitiveCount: number;
}

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

function progress(
  listener: ThreeMfExportProgressListener | undefined,
  phase: ThreeMfExportPhase,
  completed: number,
  message: string,
): void {
  listener?.({ phase, completed, message });
}

function validateOptions(options: ThreeMfExportOptions): void {
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
  artifacts: PrintableCityArtifacts,
  assignments: readonly SemanticGroupAssignment[],
  planWarnings: readonly string[],
  includeLegend: boolean,
): readonly string[] {
  const warnings = [...planWarnings];
  const merged = mergedGroupWarning(assignments);
  if (merged !== undefined) warnings.push(merged);

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
): readonly ThreeMfExportChannelSummary[] {
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

export function prepareThreeMfExport(
  request: ThreeMfExportRequest,
  onProgress?: ThreeMfExportProgressListener,
): PreparedThreeMfExport {
  progress(onProgress, "validating", 0.1, "Validating model and printer profile");
  validateOptions(request.options);
  const model = validateCityModel(request.model);
  const profile = parsePrinterProfile(request.profile);
  if (!profile.supportedFormats.includes("3mf")) {
    throw new PrintPlanValidationError([
      `Format '3mf' is not supported by profile '${profile.id}'.`,
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
    format: "3mf",
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
  const preflight: ThreeMfExportPreflight = {
    title: artifacts.city.title,
    profileId: profile.id,
    profileName: profile.name,
    dimensions: { x: size.x, y: size.y, z: size.z },
    partCount: artifacts.city.parts.length,
    channels: channelSummaries(artifacts, profile),
    warnings: exportWarnings(
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
    model,
    profile,
    options: { ...request.options },
    artifacts,
    preflight,
  };
}

export function serializePreparedThreeMfExport(
  prepared: PreparedThreeMfExport,
  onProgress?: ThreeMfExportProgressListener,
): ThreeMfExportResult {
  progress(onProgress, "serializing", 0.75, "Serializing deterministic 3MF");
  const threeMfBytes = serializeThreeMf(prepared.artifacts.city);
  const legendBytes = prepared.options.includeLegend
    ? serializePrintLegend(prepared.artifacts.legend)
    : undefined;
  progress(onProgress, "complete", 1, "3MF export ready");
  return {
    preflight: prepared.preflight,
    threeMfBytes,
    ...(legendBytes === undefined ? {} : { legendBytes }),
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
