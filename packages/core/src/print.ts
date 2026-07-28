import type {
  CityIdentity,
  CityIdentityPanel,
  SemanticGroup,
  Vector3,
} from "./model.js";
import { normalizeCityIdentity } from "./identity.js";

export type PrintFormat = "stl" | "3mf";
export type PrintChannelMechanism =
  | "single"
  | "toolchanger"
  | "filament-switcher"
  | "manual";
export type OverflowPolicy = "merge" | "monochrome" | "error";

export interface PrintChannel {
  readonly id: string;
  readonly label: string;
  readonly mechanism: PrintChannelMechanism;
  readonly color?: string;
  readonly material?: string;
}

export interface PrinterGeometryLimits {
  readonly minimumWallThickness: number;
  readonly minimumGap: number;
  readonly minimumFeatureSize: number;
  readonly minimumBaseThickness: number;
}

export interface PrinterProfile {
  readonly id: string;
  readonly name: string;
  readonly printChannels: readonly PrintChannel[];
  readonly supportedFormats: readonly PrintFormat[];
  readonly buildVolume: Vector3;
  readonly geometryLimits: PrinterGeometryLimits;
  readonly overflowPolicy: OverflowPolicy;
}

export interface PrintGeometryMeasurements {
  readonly wallThickness: number;
  readonly gap: number;
  readonly minimumFeatureSize: number;
  readonly baseThickness: number;
}

export interface PrintPlanRequest {
  readonly format: PrintFormat;
  readonly semanticGroups: readonly SemanticGroup[];
  readonly bounds: Vector3;
  readonly geometry: PrintGeometryMeasurements;
  readonly identity?: CityIdentity;
  readonly identityPanel?: CityIdentityPanel;
}

export interface SemanticGroupAssignment {
  readonly semanticGroupId: string;
  readonly channelId: string;
  readonly mergedIntoSemanticGroupId?: string;
}

export interface PrintChannelPlan {
  readonly channel: PrintChannel;
  readonly semanticGroupIds: readonly string[];
}

export interface PlannedIdentityPanel extends CityIdentityPanel {
  readonly channelId: string;
}

export interface PrintPlan {
  readonly profileId: string;
  readonly format: PrintFormat;
  readonly bounds: Vector3;
  readonly scale: 1;
  readonly assignments: readonly SemanticGroupAssignment[];
  readonly channels: readonly PrintChannelPlan[];
  readonly identity?: CityIdentity;
  readonly identityPanel?: PlannedIdentityPanel;
  readonly warnings: readonly string[];
}

export class PrintPlanValidationError extends Error {
  public readonly issues: readonly string[];

  public constructor(issues: readonly string[]) {
    super(`Invalid print plan: ${issues.join(" ")}`);
    this.name = "PrintPlanValidationError";
    this.issues = [...issues];
  }
}

const FORMATS = new Set<PrintFormat>(["stl", "3mf"]);
const MECHANISMS = new Set<PrintChannelMechanism>([
  "single",
  "toolchanger",
  "filament-switcher",
  "manual",
]);
const POLICIES = new Set<OverflowPolicy>(["merge", "monochrome", "error"]);

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function finitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function finiteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

const GEOMETRY_EPSILON = 1e-9;

export function validatePrinterProfile(
  profile: PrinterProfile,
): readonly string[] {
  const issues: string[] = [];
  if (typeof profile.id !== "string" || profile.id.trim() === "") {
    issues.push("Profile id must not be empty.");
  }
  if (typeof profile.name !== "string" || profile.name.trim() === "") {
    issues.push("Profile name must not be empty.");
  }
  if (profile.printChannels.length === 0) {
    issues.push("At least one print channel is required.");
  }
  const channelIds = new Set<string>();
  for (const channel of profile.printChannels) {
    if (typeof channel.id !== "string" || channel.id.trim() === "") {
      issues.push("Channel id must not be empty.");
      continue;
    }
    if (channelIds.has(channel.id)) {
      issues.push(`Duplicate print channel '${channel.id}'.`);
    }
    channelIds.add(channel.id);
    if (typeof channel.label !== "string" || channel.label.trim() === "") {
      issues.push(`Print channel '${channel.id}' must have a label.`);
    }
    if (!MECHANISMS.has(channel.mechanism)) {
      issues.push(`Unsupported channel mechanism '${String(channel.mechanism)}'.`);
    }
  }
  if (profile.supportedFormats.length === 0) {
    issues.push("At least one supported format is required.");
  }
  const formats = new Set<string>();
  for (const format of profile.supportedFormats) {
    if (!FORMATS.has(format)) {
      issues.push(`Unsupported print format '${String(format)}'.`);
    }
    if (formats.has(format)) {
      issues.push(`Duplicate supported format '${format}'.`);
    }
    formats.add(format);
  }
  for (const axis of ["x", "y", "z"] as const) {
    if (!finitePositive(profile.buildVolume[axis])) {
      issues.push(`Build volume ${axis.toUpperCase()} must be positive.`);
    }
  }
  const geometryLimits = [
    ["minimumWallThickness", profile.geometryLimits.minimumWallThickness],
    ["minimumGap", profile.geometryLimits.minimumGap],
    ["minimumFeatureSize", profile.geometryLimits.minimumFeatureSize],
    ["minimumBaseThickness", profile.geometryLimits.minimumBaseThickness],
  ] as const;
  for (const [field, value] of geometryLimits) {
    if (!finitePositive(value)) {
      issues.push(`Geometry limit '${field}' must be positive.`);
    }
  }
  if (!POLICIES.has(profile.overflowPolicy)) {
    issues.push(`Unsupported overflow policy '${String(profile.overflowPolicy)}'.`);
  }
  return issues;
}

function validateSemanticGroups(
  semanticGroups: readonly SemanticGroup[],
): readonly string[] {
  const issues: string[] = [];
  const byId = new Map<string, SemanticGroup>();
  for (const group of semanticGroups) {
    if (group.id.trim() === "") issues.push("Semantic group id must not be empty.");
    if (byId.has(group.id)) {
      issues.push(`Duplicate semantic group '${group.id}'.`);
    }
    byId.set(group.id, group);
    if (!Number.isFinite(group.priority)) {
      issues.push(`Semantic group '${group.id}' has an invalid priority.`);
    }
  }
  for (const group of semanticGroups) {
    if (group.mergeInto !== undefined && !byId.has(group.mergeInto)) {
      issues.push(
        `Semantic group '${group.id}' merges into unknown group '${group.mergeInto}'.`,
      );
    }
    const visited = new Set<string>([group.id]);
    let current = group;
    while (current.mergeInto !== undefined) {
      if (visited.has(current.mergeInto)) {
        issues.push(`Semantic group merge cycle contains '${current.mergeInto}'.`);
        break;
      }
      visited.add(current.mergeInto);
      const next = byId.get(current.mergeInto);
      if (!next) break;
      current = next;
    }
  }
  return [...new Set(issues)];
}

function validateRequest(
  profile: PrinterProfile,
  request: PrintPlanRequest,
): readonly string[] {
  const issues = [
    ...validatePrinterProfile(profile),
    ...validateSemanticGroups(request.semanticGroups),
  ];
  if (!profile.supportedFormats.includes(request.format)) {
    issues.push(
      `Format '${request.format}' is not supported by profile '${profile.id}'.`,
    );
  }
  for (const axis of ["x", "y", "z"] as const) {
    const value = request.bounds[axis];
    if (!finiteNonNegative(value)) {
      issues.push(`City bound ${axis.toUpperCase()} must be non-negative.`);
    } else if (
      finitePositive(profile.buildVolume[axis]) &&
      value > profile.buildVolume[axis]
    ) {
      issues.push(
        `City bound ${axis.toUpperCase()} (${value}) exceeds build volume (${profile.buildVolume[axis]}).`,
      );
    }
  }
  const geometryChecks = [
    [
      "wall thickness",
      request.geometry.wallThickness,
      profile.geometryLimits.minimumWallThickness,
    ],
    ["gap", request.geometry.gap, profile.geometryLimits.minimumGap],
    [
      "minimum feature size",
      request.geometry.minimumFeatureSize,
      profile.geometryLimits.minimumFeatureSize,
    ],
    [
      "base thickness",
      request.geometry.baseThickness,
      profile.geometryLimits.minimumBaseThickness,
    ],
  ] as const;
  for (const [label, actual, minimum] of geometryChecks) {
    if (!finitePositive(actual)) {
      issues.push(`Print ${label} must be positive.`);
    } else if (actual < minimum) {
      issues.push(`Print ${label} (${actual}) is below profile minimum (${minimum}).`);
    }
  }
  if (request.identityPanel !== undefined) {
    const panel = request.identityPanel;
    if (request.identity === undefined) {
      issues.push("An identity panel requires identity content.");
    }
    if (!request.semanticGroups.some(({ id }) => id === "identity")) {
      issues.push("An identity panel requires the 'identity' semantic group.");
    }
    if (panel.semanticGroupId !== "identity") {
      issues.push("Identity panel must use the 'identity' semantic group.");
    }
    if (panel.reliefDepth > panel.size.z) {
      issues.push("Identity relief depth must not exceed panel depth.");
    }
    if (!finitePositive(panel.reliefDepth)) {
      issues.push("Identity relief depth must be positive.");
    }
    for (const axis of ["x", "y", "z"] as const) {
      if (!finitePositive(panel.size[axis])) {
        issues.push(
          `Identity panel size ${axis.toUpperCase()} must be positive.`,
        );
      }
      if (!Number.isFinite(panel.position[axis])) {
        issues.push(
          `Identity panel position ${axis.toUpperCase()} must be finite.`,
        );
      }
    }
    if (
      finitePositive(panel.size.z) &&
      finitePositive(panel.reliefDepth) &&
      Number.isFinite(panel.position.z) &&
      Math.abs(
        panel.position.z -
          panel.size.z / 2 -
          panel.reliefDepth,
      ) > GEOMETRY_EPSILON
    ) {
      issues.push(
        "Identity panel relief must terminate at the front edge.",
      );
    }

    const hasValidPanelGeometry =
      finitePositive(panel.reliefDepth) &&
      (["x", "y", "z"] as const).every(
        (axis) =>
          finitePositive(panel.size[axis]) &&
          Number.isFinite(panel.position[axis]),
      );
    if (hasValidPanelGeometry) {
      const minimum = {
        x: panel.position.x - panel.size.x / 2,
        y: panel.position.y - panel.size.y / 2,
        z:
          panel.position.z -
          panel.size.z / 2 -
          panel.reliefDepth,
      };
      const maximum = {
        x: panel.position.x + panel.size.x / 2,
        y: panel.position.y + panel.size.y / 2,
        z: panel.position.z + panel.size.z / 2,
      };
      for (const axis of ["x", "y", "z"] as const) {
        const axisLabel = axis.toUpperCase();
        const cityBound = request.bounds[axis];
        if (
          finiteNonNegative(cityBound) &&
          (minimum[axis] < -GEOMETRY_EPSILON ||
            maximum[axis] > cityBound + GEOMETRY_EPSILON)
        ) {
          issues.push(
            `Identity panel and relief AABB exceed city bound ${axisLabel}.`,
          );
        }
        const buildBound = profile.buildVolume[axis];
        if (
          finitePositive(buildBound) &&
          (minimum[axis] < -GEOMETRY_EPSILON ||
            maximum[axis] > buildBound + GEOMETRY_EPSILON)
        ) {
          issues.push(
            `Identity panel and relief AABB exceed build volume ${axisLabel}.`,
          );
        }
      }
    }
  }
  if (
    profile.overflowPolicy === "error" &&
    request.semanticGroups.length > profile.printChannels.length
  ) {
    issues.push(
      `${request.semanticGroups.length} semantic groups exceed ${profile.printChannels.length} print channels.`,
    );
  }
  return issues;
}

function rankGroups(
  groups: readonly SemanticGroup[],
): readonly SemanticGroup[] {
  return [...groups].sort(
    (left, right) =>
      right.priority - left.priority || compare(left.id, right.id),
  );
}

function assignGroups(
  profile: PrinterProfile,
  semanticGroups: readonly SemanticGroup[],
): readonly SemanticGroupAssignment[] {
  if (semanticGroups.length === 0) return [];
  const firstChannel = profile.printChannels[0];
  if (!firstChannel) {
    throw new PrintPlanValidationError([
      "At least one print channel is required.",
    ]);
  }
  if (profile.overflowPolicy === "monochrome") {
    const targetId = rankGroups(semanticGroups)[0]?.id;
    return [...semanticGroups]
      .sort((left, right) => compare(left.id, right.id))
      .map((group) => ({
        semanticGroupId: group.id,
        channelId: firstChannel.id,
        ...(group.id === targetId
          ? {}
          : { mergedIntoSemanticGroupId: targetId ?? group.id }),
      }));
  }

  const ranked = rankGroups(semanticGroups);
  const retained = ranked.slice(0, profile.printChannels.length);
  const retainedIds = new Set(retained.map(({ id }) => id));
  const byId = new Map(semanticGroups.map((group) => [group.id, group]));
  const channelByRetainedGroup = new Map(
    retained.map((group, index) => [
      group.id,
      profile.printChannels[index]?.id ?? firstChannel.id,
    ]),
  );
  const fallback = retained.at(-1);
  if (!fallback) return [];

  return [...semanticGroups]
    .sort((left, right) => compare(left.id, right.id))
    .map((group): SemanticGroupAssignment => {
      let target = group;
      const visited = new Set<string>();
      while (!retainedIds.has(target.id) && target.mergeInto !== undefined) {
        if (visited.has(target.id)) break;
        visited.add(target.id);
        const next = byId.get(target.mergeInto);
        if (!next) break;
        target = next;
      }
      if (!retainedIds.has(target.id)) target = fallback;
      const channelId = channelByRetainedGroup.get(target.id) ?? firstChannel.id;
      return {
        semanticGroupId: group.id,
        channelId,
        ...(target.id === group.id
          ? {}
          : { mergedIntoSemanticGroupId: target.id }),
      };
    });
}

export function planPrint(
  profile: PrinterProfile,
  request: PrintPlanRequest,
): PrintPlan {
  const issues = validateRequest(profile, request);
  if (issues.length > 0) {
    throw new PrintPlanValidationError(issues);
  }
  const assignments = assignGroups(profile, request.semanticGroups);
  const assignmentsByChannel = new Map<string, string[]>();
  for (const assignment of assignments) {
    const groupIds = assignmentsByChannel.get(assignment.channelId) ?? [];
    groupIds.push(assignment.semanticGroupId);
    assignmentsByChannel.set(assignment.channelId, groupIds);
  }
  const identityAssignment = assignments.find(
    ({ semanticGroupId }) => semanticGroupId === "identity",
  );
  const identityPanel =
    request.identityPanel === undefined || identityAssignment === undefined
      ? undefined
      : {
          ...request.identityPanel,
          channelId: identityAssignment.channelId,
        };
  const identity =
    request.identity === undefined
      ? undefined
      : normalizeCityIdentity(request.identity);
  return {
    profileId: profile.id,
    format: request.format,
    bounds: { ...request.bounds },
    scale: 1,
    assignments,
    channels: profile.printChannels
      .map((channel) => ({
        channel: { ...channel },
        semanticGroupIds: [
          ...(assignmentsByChannel.get(channel.id) ?? []),
        ].sort(compare),
      }))
      .filter(({ semanticGroupIds }) => semanticGroupIds.length > 0),
    ...(identity === undefined ? {} : { identity }),
    ...(identityPanel === undefined ? {} : { identityPanel }),
    warnings: [],
  };
}
