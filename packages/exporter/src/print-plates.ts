import {
  EXTERNAL_DEPENDENCY_APRON_MARGIN,
  EXTERNAL_DEPENDENCY_BOX_SIZE,
  assignBuildingPrintCodes,
  assignDistrictPrintCodes,
  assignSemanticGroups,
  parsePrinterProfile,
  planPrintLayout,
  PrintLayoutError,
  resolvePrinterGeometryLimits,
  normalizeExternalDependencyTarget,
  selectExternalDependencies,
  serializePrintLegend,
  validateCityModel,
  type AssignedPrintCode,
  type CityBase,
  type CityBuilding,
  type CityDependency,
  type CityDistrict,
  type CityIdentityPanel,
  type CityModel,
  type ExternalDependencyLayout,
  type ExternalDependencySelection,
  type PrintFitPolicy,
  type PrintFeatureViolation,
  type PrintFormat,
  type PrintLabelPolicy,
  type PrintLayoutBounds,
  type PrintLayoutDistrictPlacement,
  type PrintLayoutFeatureMeasurements,
  type PrintLayoutPlan,
  type PrintLayoutPlate,
  type PrinterProfile,
  type PrintRoutePolicy,
  type SemanticGroupAssignment,
  type Vector3,
} from "../../core/src/index.js";

import {
  buildPrintableCityArtifacts,
  type PrintableCity,
  type PrintableCityArtifacts,
  type PrintLabelReport,
  type PrintRouteOmissionReason,
  type PrintRouteReport,
} from "./geometry.js";
import {
  serializePrintBundle,
  type PrintBundleEndpointIdentity,
  type PrintBundleExternalDependency,
  type PrintBundlePlateRequest,
  type PrintBundleRequest,
  type PrintBundleResult,
  type PrintBundleRouteOmission,
  type PrintBundleUnplacedObject,
} from "./print-bundle.js";
import {
  printableTextWidth,
  validatePrintableText,
} from "./printable-font.js";
import { minimumPositiveHorizontalGap } from "./spatial.js";
import { serializeBinaryStl } from "./stl.js";
import { serializeThreeMf } from "./three-mf.js";
import type { PrintExportArtifact } from "./print-export.js";

const EPSILON = 1e-8;
const DEFAULT_MAXIMUM_PLATE_COUNT = 99;
const IDENTITY_MINIMUM_FEATURE = 0.8;
const STL_INFORMATION_LOSS_WARNING =
  "STL is a single multi-shell mesh; colors, tool assignments, and 3MF metadata are not preserved.";
export const PRINT_EXPORT_MANIFEST_SCHEMA =
  "https://felixgeisler.github.io/code-city/schemas/print-export-v1.json" as const;

export interface PrintPlateExportOptions {
  readonly scale: number;
  readonly fitPolicy: PrintFitPolicy;
  readonly acknowledgeBelowProfileScale?: boolean;
  readonly labelPolicy: PrintLabelPolicy;
  readonly routePolicy: PrintRoutePolicy;
  readonly includeLegend: boolean;
  readonly maximumPlateCount?: number;
}

export interface PrintPlateExportRequest {
  readonly format: PrintFormat;
  readonly model: unknown;
  readonly profile: unknown;
  readonly options: PrintPlateExportOptions;
}

export interface PrintPlateExportProgress {
  readonly phase:
    | "validating"
    | "layout"
    | "geometry"
    | "serializing"
    | "complete";
  readonly completed: number;
  readonly message: string;
  readonly plateNumber?: number;
  readonly plateCount?: number;
}

export type PrintPlateExportProgressListener = (
  progress: PrintPlateExportProgress,
) => void;

export interface PreparedPrintPlate {
  readonly layout: PrintLayoutPlate;
  readonly model: CityModel;
  readonly artifacts: PrintableCityArtifacts;
  readonly bundlePlate: PrintBundlePlateRequest;
}

export interface PrintPlateBundlePreflight {
  readonly format: PrintFormat;
  readonly title: string;
  readonly profileId: string;
  readonly profileName: string;
  readonly fitPolicy: PrintFitPolicy;
  readonly requestedScale: number;
  readonly appliedScale: number;
  readonly minimumSafeScale: number;
  readonly belowProfileScaleAcknowledged: boolean;
  readonly featureViolations: readonly PrintFeatureViolation[];
  readonly plateCount: number;
  readonly plates: readonly {
    readonly number: number;
    readonly id: string;
    readonly fileName: string;
    readonly dimensions: {
      readonly width: number;
      readonly depth: number;
      readonly height: number;
    };
    readonly utilization: number;
    readonly channelIds: readonly string[];
    readonly warnings: readonly string[];
    readonly labels: PrintLabelReport;
    readonly routes: PrintRouteReport;
  }[];
  readonly labels: PrintLabelReport;
  readonly routes: PrintRouteReport;
  readonly warnings: readonly string[];
  readonly unplacedObjects: readonly PrintBundleUnplacedObject[];
  readonly routeOmissions: readonly PrintBundleRouteOmission[];
  readonly legendIncluded: boolean;
}

export interface PrintPlatePreviewSource {
  readonly fitPolicy: PrintFitPolicy;
  readonly appliedPolicy: PrintFitPolicy;
  readonly requestedScale: number;
  readonly appliedScale: number;
  readonly minimumSafeScale: number;
  readonly belowProfileScaleAcknowledged: boolean;
  readonly featureViolations: readonly PrintFeatureViolation[];
  readonly sourceBounds: {
    readonly minimum: Vector3;
    readonly maximum: Vector3;
    readonly size: Vector3;
  };
  readonly printableBounds: {
    readonly minimum: Vector3;
    readonly maximum: Vector3;
    readonly size: Vector3;
  };
  readonly warnings: readonly string[];
  readonly unplacedObjects: readonly { readonly id: string }[];
  readonly plates: readonly {
    readonly number: number;
    readonly id: string;
    readonly fileName: string;
    readonly utilization: number;
    readonly bounds: PrintableCity["bounds"];
    readonly warnings: readonly string[];
    readonly parts: PrintableCity["parts"];
  }[];
}

export interface PreparedPrintPlateBundle {
  readonly format: PrintFormat;
  readonly model: CityModel;
  readonly profile: PrinterProfile;
  readonly options: PrintPlateExportOptions;
  readonly layout: PrintLayoutPlan;
  readonly plates: readonly PreparedPrintPlate[];
  readonly bundleRequest: PrintBundleRequest;
  readonly preflight: PrintPlateBundlePreflight;
  readonly preview: PrintPlatePreviewSource;
}

export interface PrintPlateBundleExportResult extends PrintBundleResult {
  readonly layout: PrintLayoutPlan;
  readonly preflight: PrintPlateBundlePreflight;
  readonly preview: PrintPlatePreviewSource;
  readonly legendBytes?: Uint8Array;
}

export interface SinglePrintPlateExportResult {
  readonly layout: PrintLayoutPlan;
  readonly preflight: PrintPlateBundlePreflight;
  readonly preview: PrintPlatePreviewSource;
  readonly artifact: PrintExportArtifact;
  readonly manifest: DirectPrintExportManifest;
  readonly manifestBytes: Uint8Array;
  readonly legendBytes?: Uint8Array;
}

export interface DirectPrintExportManifest {
  readonly schema: typeof PRINT_EXPORT_MANIFEST_SCHEMA;
  readonly title: string;
  readonly version?: string;
  readonly format: PrintFormat;
  readonly profile: {
    readonly id: string;
    readonly name: string;
  };
  readonly fit: {
    readonly policy: PrintFitPolicy;
    readonly requestedScale: number;
    readonly appliedScale: number;
    readonly minimumSafeScale: number;
    readonly belowProfileScaleAcknowledged: boolean;
    readonly featureViolations: readonly PrintFeatureViolation[];
  };
  readonly plate: PrintPlateBundlePreflight["plates"][number];
  readonly warnings: readonly string[];
  readonly legendIncluded: boolean;
}

interface Box {
  readonly minimum: Vector3;
  readonly maximum: Vector3;
}

interface PlateDependencySlice {
  readonly dependencies: readonly CityDependency[];
  readonly externalMetadata: readonly PrintBundleExternalDependency[];
}

function progress(
  listener: PrintPlateExportProgressListener | undefined,
  value: PrintPlateExportProgress,
): void {
  listener?.(value);
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function saturatingWeightAdd(left: number, right: number): number {
  return right > Number.MAX_VALUE - left
    ? Number.MAX_VALUE
    : left + right;
}

function box(position: Vector3, size: Vector3): Box {
  return {
    minimum: {
      x: position.x - size.x / 2,
      y: position.y - size.y / 2,
      z: position.z - size.z / 2,
    },
    maximum: {
      x: position.x + size.x / 2,
      y: position.y + size.y / 2,
      z: position.z + size.z / 2,
    },
  };
}

function sizeOf(bounds: PrintLayoutBounds): Vector3 {
  return {
    x: bounds.maximum.x - bounds.minimum.x,
    y: bounds.maximum.y - bounds.minimum.y,
    z: bounds.maximum.z - bounds.minimum.z,
  };
}

function sizedBounds(
  minimum: Vector3,
  maximum: Vector3,
): {
  readonly minimum: Vector3;
  readonly maximum: Vector3;
  readonly size: Vector3;
} {
  return {
    minimum: { ...minimum },
    maximum: { ...maximum },
    size: {
      x: maximum.x - minimum.x,
      y: maximum.y - minimum.y,
      z: maximum.z - minimum.z,
    },
  };
}

function requiredBase(model: CityModel): CityBase {
  if (model.base === undefined) {
    throw new TypeError(
      "Multi-plate export requires explicit shared-base geometry.",
    );
  }
  return model.base;
}

function channelMap(
  assignments: readonly SemanticGroupAssignment[],
): ReadonlyMap<string, string> {
  return new Map(
    assignments.map(({ semanticGroupId, channelId }) => [
      semanticGroupId,
      channelId,
    ]),
  );
}

function requiredChannel(
  channels: ReadonlyMap<string, string>,
  semanticGroupId: string,
): string {
  const channel = channels.get(semanticGroupId);
  if (channel === undefined) {
    throw new TypeError(
      `No print channel is assigned to semantic group '${semanticGroupId}'.`,
    );
  }
  return channel;
}

function sourceDistrictBounds(
  district: CityDistrict,
  buildings: readonly CityBuilding[],
  baseTop: number,
): PrintLayoutBounds {
  const districtBox = box(district.position, district.size);
  const districtBuildings = buildings.filter(
    ({ districtId }) => districtId === district.id,
  );
  const maximumY = Math.max(
    districtBox.maximum.y,
    ...districtBuildings.map(
      (building) => box(building.position, building.size).maximum.y,
    ),
  );
  return {
    minimum: {
      x: districtBox.minimum.x,
      y: baseTop,
      z: districtBox.minimum.z,
    },
    maximum: {
      x: districtBox.maximum.x,
      y: maximumY,
      z: districtBox.maximum.z,
    },
  };
}

function sourceDistrictFoundationThickness(
  district: CityDistrict,
  baseTop: number,
): number {
  const districtBox = box(district.position, district.size);
  return (
    districtBox.maximum.y -
    Math.max(districtBox.minimum.y, baseTop)
  );
}

function sourceBuildingPrimitiveBounds(
  building: CityBuilding,
): {
  readonly id: string;
  readonly bounds: PrintableCity["bounds"];
} {
  const value = box(building.position, building.size);
  return {
    id: building.id,
    bounds: {
      minimum: {
        x: value.minimum.x,
        y: value.minimum.z,
        z: value.minimum.y,
      },
      maximum: {
        x: value.maximum.x,
        y: value.maximum.z,
        z: value.maximum.y,
      },
      size: {
        x: building.size.x,
        y: building.size.z,
        z: building.size.y,
      },
    },
  };
}

function sourcePrimitiveBounds(model: CityModel): readonly {
  readonly id: string;
  readonly bounds: PrintableCity["bounds"];
}[] {
  const base = requiredBase(model);
  const baseBox = box(base.position, base.size);
  const items: Array<{
    readonly id: string;
    readonly bounds: PrintableCity["bounds"];
  }> = [
    {
      id: base.id,
      bounds: {
        minimum: {
          x: baseBox.minimum.x,
          y: baseBox.minimum.z,
          z: baseBox.minimum.y,
        },
        maximum: {
          x: baseBox.maximum.x,
          y: baseBox.maximum.z,
          z: baseBox.maximum.y,
        },
        size: {
          x: base.size.x,
          y: base.size.z,
          z: base.size.y,
        },
      },
    },
  ];
  for (const district of model.districts) {
    const value = box(district.position, district.size);
    const minimumY = Math.max(value.minimum.y, baseBox.maximum.y);
    items.push({
      id: district.id,
      bounds: {
        minimum: { x: value.minimum.x, y: value.minimum.z, z: minimumY },
        maximum: {
          x: value.maximum.x,
          y: value.maximum.z,
          z: value.maximum.y,
        },
        size: {
          x: value.maximum.x - value.minimum.x,
          y: value.maximum.z - value.minimum.z,
          z: value.maximum.y - minimumY,
        },
      },
    });
  }
  for (const building of model.buildings) {
    items.push(sourceBuildingPrimitiveBounds(building));
  }
  return items.filter(
    ({ bounds }) =>
      bounds.size.x > EPSILON &&
      bounds.size.y > EPSILON &&
      bounds.size.z > EPSILON,
  );
}

function sourceFeatures(
  model: CityModel,
  requestedScale: number,
): PrintLayoutFeatureMeasurements {
  const base = requiredBase(model);
  const primitives = model.buildings.map(sourceBuildingPrimitiveBounds);
  const primitiveById = new Map(
    primitives.map((item) => [item.id, item]),
  );
  const smallest =
    primitives.length === 0
      // The core contract requires positive finite detail measurements even
      // when the city has no scalable building detail. Keep that absence
      // effectively constraint-neutral without overflowing when the planner
      // evaluates the requested physical scale.
      ? Number.MAX_VALUE / Math.max(1, requestedScale) / 4
      : Math.min(
          ...primitives.flatMap(({ bounds }) => [
            bounds.size.x,
            bounds.size.y,
            bounds.size.z,
          ]),
        );
  const districtGaps = model.districts.flatMap(({ id }) => {
    const gap = minimumPositiveHorizontalGap(
      model.buildings
        .filter(({ districtId }) => districtId === id)
        .map(({ id: buildingId }) => primitiveById.get(buildingId)!),
      EPSILON,
    );
    return gap === null ? [] : [gap];
  });
  return {
    wallThickness: smallest,
    gap: districtGaps.length === 0 ? null : Math.min(...districtGaps),
    minimumFeatureSize: smallest,
    baseThickness: base.size.y,
    labelStrokeWidth: null,
    raisedFeatureHeight: null,
    recessedFeatureDepth: null,
    routeWidth: null,
    connectorWidth: null,
  };
}

function identitySourceBounds(
  model: CityModel,
  profile: PrinterProfile,
): PrintLayoutBounds {
  const limits = resolvePrinterGeometryLimits(profile);
  const feature = Math.max(
    IDENTITY_MINIMUM_FEATURE,
    limits.minimumFeatureSize,
    limits.minimumLabelStrokeWidth,
  );
  const title = (
    model.identity?.title ??
    model.repositories[0]?.name ??
    "Code City"
  )
    .normalize("NFC")
    .toUpperCase();
  const version = (model.identity?.version ?? "")
    .normalize("NFC")
    .toUpperCase();
  validatePrintableText(title);
  validatePrintableText(version);
  const margin = feature * 2;
  const contentGap = feature * 2;
  const iconWidth = feature * 8;
  const lineGap = feature * 2;
  const requiredWidth =
    margin * 2 +
    iconWidth +
    contentGap +
    Math.max(
      printableTextWidth(title, feature),
      printableTextWidth(version, feature),
    );
  const widthWithClearance = requiredWidth + feature * 2;
  const requiredHeight =
    margin * 2 + feature * 5 * 2 + lineGap;
  const relief = Math.max(
    feature,
    limits.minimumRaisedFeatureHeight,
  );
  const panelDepth = Math.max(
    feature,
    limits.minimumWallThickness,
  );
  return {
    minimum: { x: 0, y: 0, z: 0 },
    maximum: {
      x: widthWithClearance,
      y: requiredHeight,
      z: relief + panelDepth,
    },
  };
}

function transformPoint(
  point: Vector3,
  placement: PrintLayoutDistrictPlacement,
): Vector3 {
  const { scale, rotation, translation } = placement.transform;
  if (rotation === 0) {
    return {
      x: point.x * scale + translation.x,
      y: point.y * scale + translation.y,
      z: point.z * scale + translation.z,
    };
  }
  return {
    x: -point.z * scale + translation.x,
    y: point.y * scale + translation.y,
    z: point.x * scale + translation.z,
  };
}

function transformSize(
  size: Vector3,
  placement: PrintLayoutDistrictPlacement,
): Vector3 {
  const scale = placement.transform.scale;
  return placement.transform.rotation === 0
    ? { x: size.x * scale, y: size.y * scale, z: size.z * scale }
    : { x: size.z * scale, y: size.y * scale, z: size.x * scale };
}

function transformDistrict(
  district: CityDistrict,
  placement: PrintLayoutDistrictPlacement,
): CityDistrict {
  const transformedPosition = transformPoint(
    district.position,
    placement,
  );
  const transformedSize = transformSize(district.size, placement);
  const scaledExposedFoundation =
    placement.foundationThickness - placement.foundationLift;
  const scaledBaseOverlap = Math.max(
    0,
    transformedSize.y - scaledExposedFoundation,
  );
  const minimumY =
    placement.bounds.minimum.y - scaledBaseOverlap;
  const maximumY =
    placement.bounds.minimum.y + placement.foundationThickness;
  return {
    ...district,
    position: {
      ...transformedPosition,
      y: (minimumY + maximumY) / 2,
    },
    size: {
      ...transformedSize,
      y: maximumY - minimumY,
    },
  };
}

function transformBuilding(
  building: CityBuilding,
  placement: PrintLayoutDistrictPlacement,
): CityBuilding {
  return {
    ...building,
    position: transformPoint(building.position, placement),
    size: transformSize(building.size, placement),
  };
}

function nodeDistricts(model: CityModel): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  for (const district of model.districts) {
    result.set(district.id, district.id);
    result.set(district.moduleId, district.id);
  }
  for (const building of model.buildings) {
    result.set(building.id, building.districtId);
  }
  return result;
}

function endpointIdentity(
  model: CityModel,
  nodeId: string,
  districtId: string,
  plateNumber: number | undefined,
): PrintBundleEndpointIdentity {
  const building = model.buildings.find(({ id }) => id === nodeId);
  const district = model.districts.find(({ id }) => id === districtId)!;
  return building === undefined
    ? {
        kind: "district",
        id: district.id,
        label: district.name,
        ...(plateNumber === undefined ? {} : { plateNumber }),
      }
    : {
        kind: "building",
        id: building.id,
        label: building.name,
        ...(plateNumber === undefined ? {} : { plateNumber }),
      };
}

function plateDependencies(
  model: CityModel,
  externalSelection: ExternalDependencySelection,
  plateNumber: number,
  districtIds: ReadonlySet<string>,
  districtByNode: ReadonlyMap<string, string>,
  plateByDistrict: ReadonlyMap<string, number>,
): PlateDependencySlice {
  const dependencies: CityDependency[] = [];
  const external = new Map<
    string,
    {
      readonly target: string;
      readonly physicalNodeId: string;
      readonly consumer: PrintBundleEndpointIdentity;
      weight: number;
    }
  >();
  for (const dependency of model.dependencies) {
    const sourceDistrictId = districtByNode.get(dependency.sourceId);
    if (
      sourceDistrictId === undefined ||
      !districtIds.has(sourceDistrictId)
    ) {
      continue;
    }
    if (dependency.externalTarget !== undefined) {
      dependencies.push(dependency);
      const normalizedTarget = normalizeExternalDependencyTarget(
        dependency.externalTarget,
      );
      const physicalNodeId = externalSelection.assignments.get(
        normalizedTarget,
      );
      if (physicalNodeId === undefined) {
        continue;
      }
      const consumer = endpointIdentity(
        model,
        dependency.sourceId,
        sourceDistrictId,
        plateNumber,
      );
      const key = `${normalizedTarget}\0${physicalNodeId}\0${consumer.kind}\0${consumer.id}`;
      const current = external.get(key);
      if (current === undefined) {
        external.set(key, {
          target: normalizedTarget,
          physicalNodeId,
          consumer,
          weight: dependency.weight,
        });
      } else {
        current.weight = saturatingWeightAdd(
          current.weight,
          dependency.weight,
        );
      }
      continue;
    }
    const targetDistrictId =
      dependency.targetId === undefined
        ? undefined
        : districtByNode.get(dependency.targetId);
    if (
      targetDistrictId !== undefined &&
      plateByDistrict.get(targetDistrictId) === plateNumber
    ) {
      dependencies.push(dependency);
    }
  }
  const firstPlateByPhysicalNode = new Map<string, number>();
  for (const dependency of model.dependencies) {
    if (dependency.externalTarget === undefined) continue;
    const districtId = districtByNode.get(dependency.sourceId);
    const candidate =
      districtId === undefined ? undefined : plateByDistrict.get(districtId);
    if (candidate === undefined) continue;
    const physicalNodeId = externalSelection.assignments.get(
      normalizeExternalDependencyTarget(dependency.externalTarget),
    );
    if (physicalNodeId === undefined) continue;
    const current = firstPlateByPhysicalNode.get(physicalNodeId);
    if (current === undefined || candidate < current) {
      firstPlateByPhysicalNode.set(physicalNodeId, candidate);
    }
  }
  return {
    dependencies,
    externalMetadata: [...external.values()]
      .sort(
        (left, right) =>
          compare(left.target, right.target) ||
          compare(left.consumer.id, right.consumer.id),
      )
      .map(({ target, physicalNodeId, weight, consumer }) => ({
        target,
        weight,
        role:
          firstPlateByPhysicalNode.get(physicalNodeId) === plateNumber
            ? "original"
            : "replica",
        consumer,
      })),
  };
}

function routeOmissions(
  model: CityModel,
  routePolicy: PrintRoutePolicy,
  districtByNode: ReadonlyMap<string, string>,
  plateByDistrict: ReadonlyMap<string, number>,
  routingReasons: ReadonlyMap<string, PrintRouteOmissionReason>,
): readonly PrintBundleRouteOmission[] {
  const omissions: PrintBundleRouteOmission[] = [];
  for (const dependency of [...model.dependencies].sort((left, right) =>
    compare(left.id, right.id),
  )) {
    const sourceDistrict = districtByNode.get(dependency.sourceId);
    const targetDistrict =
      dependency.externalTarget !== undefined ||
      dependency.targetId === undefined
        ? undefined
        : districtByNode.get(dependency.targetId);
    if (
      sourceDistrict !== undefined &&
      targetDistrict === sourceDistrict
    ) {
      continue;
    }
    const sourcePlate =
      sourceDistrict === undefined
        ? undefined
        : plateByDistrict.get(sourceDistrict);
    let provider: PrintBundleEndpointIdentity;
    let providerPlate: number | undefined;
    if (dependency.externalTarget !== undefined) {
      provider = {
        kind: "external",
        id: dependency.externalTarget,
        label: dependency.externalTarget,
        ...(sourcePlate === undefined ? {} : { plateNumber: sourcePlate }),
      };
      providerPlate = sourcePlate;
    } else {
      providerPlate =
        targetDistrict === undefined
          ? undefined
          : plateByDistrict.get(targetDistrict);
      provider =
        dependency.targetId === undefined || targetDistrict === undefined
          ? {
              kind: "district",
              id: "unplaced-provider",
              label: "Unplaced provider",
            }
          : endpointIdentity(
              model,
              dependency.targetId,
              targetDistrict,
              providerPlate,
            );
    }
    const consumer =
      sourceDistrict === undefined
        ? {
            kind: "district" as const,
            id: "unplaced-consumer",
            label: "Unplaced consumer",
          }
        : endpointIdentity(
            model,
            dependency.sourceId,
            sourceDistrict,
            sourcePlate,
          );
    const reason =
      sourcePlate === undefined || providerPlate === undefined
        ? "unplaced-endpoint"
        : routePolicy === "off"
          ? "policy"
          : sourcePlate !== providerPlate
            ? "cross-plate"
            : routingReasons.get(dependency.id);
    if (reason !== undefined) {
      omissions.push({
        routeId: dependency.id,
        weight: dependency.weight,
        reason,
        consumer,
        provider,
      });
    }
  }
  return omissions;
}

function layoutExternalNodes(
  selection: ExternalDependencySelection,
  dependencies: readonly CityDependency[],
  base: CityBase,
  reservations: PrintLayoutPlate["reservations"],
): ExternalDependencyLayout {
  const relevantNodeIds = new Set(
    dependencies.flatMap(({ externalTarget }) => {
      if (externalTarget === undefined) return [];
      const nodeId = selection.assignments.get(
        normalizeExternalDependencyTarget(externalTarget),
      );
      return nodeId === undefined ? [] : [nodeId];
    }),
  );
  if (relevantNodeIds.size === 0) {
    return {
      nodes: [],
      assignments: selection.assignments,
      ignoredDependencyCount: selection.ignoredDependencyCount,
      base,
    };
  }
  const slots = new Map(
    reservations
      .filter(({ kind }) => kind === "external-box")
      .map((reservation) => [reservation.id, reservation]),
  );
  const nodes = selection.nodes
    .filter(({ id }) => relevantNodeIds.has(id))
    .map((node) => {
    const slot = slots.get(node.id);
    if (slot === undefined) {
      throw new RangeError(
        `External dependency '${node.label}' has no reserved print slot.`,
      );
    }
    const slotSize = sizeOf(slot.bounds);
    const position = {
      x: (slot.bounds.minimum.x + slot.bounds.maximum.x) / 2,
      y: (slot.bounds.minimum.y + slot.bounds.maximum.y) / 2,
      z: (slot.bounds.minimum.z + slot.bounds.maximum.z) / 2,
    };
    if (
      Math.abs(slotSize.x - EXTERNAL_DEPENDENCY_BOX_SIZE.x) > EPSILON ||
      Math.abs(slotSize.y - EXTERNAL_DEPENDENCY_BOX_SIZE.y) > EPSILON ||
      Math.abs(slotSize.z - EXTERNAL_DEPENDENCY_BOX_SIZE.z) > EPSILON
    ) {
      throw new RangeError(
        `External dependency '${node.label}' has an invalid reserved print slot.`,
      );
    }
    return {
      ...node,
      semanticGroupId: "external" as const,
      position,
      size: { ...EXTERNAL_DEPENDENCY_BOX_SIZE },
    };
  });
  return {
    nodes,
    assignments: selection.assignments,
    ignoredDependencyCount: selection.ignoredDependencyCount,
    base,
  };
}

function syntheticIdentityPanel(
  plate: PrintLayoutPlate,
  profile: PrinterProfile,
): CityIdentityPanel | undefined {
  const reservation = plate.reservations.find(
    ({ kind }) => kind === "identity",
  );
  if (reservation === undefined) return undefined;
  const limits = resolvePrinterGeometryLimits(profile);
  const feature = Math.max(
    IDENTITY_MINIMUM_FEATURE,
    limits.minimumFeatureSize,
    limits.minimumLabelStrokeWidth,
  );
  const reliefDepth = Math.max(
    feature,
    limits.minimumRaisedFeatureHeight,
  );
  const reservationSize = sizeOf(reservation.bounds);
  const panelDepth = reservationSize.z - reliefDepth;
  if (panelDepth <= EPSILON) {
    throw new RangeError("Identity reservation is too shallow.");
  }
  const baseTop = plate.base.bounds.maximum.y;
  const overlap = Math.min(
    plate.base.size.y / 2,
    reservationSize.y / 4,
  );
  return {
    id: reservation.id,
    edge: "front",
    semanticGroupId: "identity",
    position: {
      x:
        (reservation.bounds.minimum.x +
          reservation.bounds.maximum.x) /
        2,
      y: baseTop - overlap + reservationSize.y / 2,
      z:
        reservation.bounds.minimum.z +
        reliefDepth +
        panelDepth / 2,
    },
    size: {
      x: Math.max(feature, reservationSize.x - feature * 2),
      y: reservationSize.y,
      z: panelDepth,
    },
    relief: "embossed",
    reliefDepth,
  };
}

function retainedCodes(
  all: readonly AssignedPrintCode[],
  ids: ReadonlySet<string>,
): readonly AssignedPrintCode[] {
  return all.filter(({ id }) => ids.has(id));
}

function plateModel(
  source: CityModel,
  plate: PrintLayoutPlate,
  dependencies: readonly CityDependency[],
  profile: PrinterProfile,
): CityModel {
  const placements = new Map(
    plate.districts.map((placement) => [
      placement.districtId,
      placement,
    ]),
  );
  const districts = source.districts
    .filter(({ id }) => placements.has(id))
    .map((district) =>
      transformDistrict(district, placements.get(district.id)!),
    );
  const districtIds = new Set(districts.map(({ id }) => id));
  const buildings = source.buildings
    .filter(({ districtId }) => districtIds.has(districtId))
    .map((building) =>
      transformBuilding(
        building,
        placements.get(building.districtId)!,
      ),
    );
  const identityPanel = syntheticIdentityPanel(plate, profile);
  const title =
    source.identity?.title ??
    source.repositories[0]?.name ??
    "Code City";
  const base: CityBase = {
    id: plate.base.id,
    semanticGroupId: "base",
    position: { ...plate.base.position },
    size: { ...plate.base.size },
  };
  const {
    identityPanel: sourceIdentityPanel,
    ...sourceWithoutIdentityPanel
  } = source;
  void sourceIdentityPanel;
  const result: CityModel = {
    ...sourceWithoutIdentityPanel,
    identity: {
      title,
      ...(source.identity?.version === undefined
        ? {}
        : { version: source.identity.version }),
      ...(source.identity?.logo === undefined
        ? {}
        : { logo: source.identity.logo }),
      ...(source.identity?.repositories === undefined
        ? {}
        : { repositories: source.identity.repositories }),
    },
    ...(identityPanel === undefined ? {} : { identityPanel }),
    base,
    districts,
    buildings,
    dependencies,
    bounds: {
      x: base.size.x,
      y: plate.bounds.maximum.y - plate.base.bounds.minimum.y,
      z: base.size.z,
    },
  };
  return validateCityModel(result);
}

function plateWarnings(
  artifacts: PrintableCityArtifacts,
  fitWarnings: readonly string[],
): readonly string[] {
  const warnings = [...fitWarnings];
  if (artifacts.routes.omittedCount > 0) {
    warnings.push(
      `${artifacts.routes.omittedCount} dependency ${
        artifacts.routes.omittedCount === 1 ? "route was" : "routes were"
      } omitted by routing limits.`,
    );
  }
  return [...new Set(warnings)];
}

function assertCompleteLayout(layout: PrintLayoutPlan): void {
  if (layout.unplaced.length === 0) return;
  throw new PrintLayoutError(
    layout.unplaced.map((item) => ({
      code: "resource-limit",
      objectId: item.id,
      required: { ...item.required },
      available: { ...layout.usableBuildSpan },
      message:
        `District '${item.name}' (${item.id}) remains unplaced because the print layout reached its plate limit. ` +
        "Partial print exports are not allowed.",
    })),
  );
}

function mergedLegend(
  plates: readonly PreparedPrintPlate[],
  title: string,
  profileId: string,
  labelPolicy: PrintLabelPolicy,
): Uint8Array {
  const districts = plates
    .flatMap(({ artifacts }) => artifacts.legend.districts)
    .sort((left, right) => compare(left.code, right.code));
  const buildings = plates
    .flatMap(({ artifacts }) => artifacts.legend.buildings)
    .sort((left, right) => compare(left.code, right.code));
  return serializePrintLegend({
    schemaVersion: "1.0",
    title,
    profileId,
    labelPolicy,
    districts,
    buildings,
  });
}

function summedLabels(
  plates: readonly PreparedPrintPlate[],
): PrintLabelReport {
  return plates.reduce(
    (total, { artifacts }) => ({
      printedBuildings:
        total.printedBuildings + artifacts.labels.printedBuildings,
      skippedBuildings:
        total.skippedBuildings + artifacts.labels.skippedBuildings,
      printedDistricts:
        total.printedDistricts + artifacts.labels.printedDistricts,
      skippedDistricts:
        total.skippedDistricts + artifacts.labels.skippedDistricts,
    }),
    {
      printedBuildings: 0,
      skippedBuildings: 0,
      printedDistricts: 0,
      skippedDistricts: 0,
    },
  );
}

function summedRoutes(
  plates: readonly PreparedPrintPlate[],
  policy: PrintRoutePolicy,
): PrintRouteReport {
  return plates.reduce(
    (total, { artifacts }) => ({
      policy,
      totalCount: total.totalCount + artifacts.routes.totalCount,
      printedCount: total.printedCount + artifacts.routes.printedCount,
      omittedCount: total.omittedCount + artifacts.routes.omittedCount,
      totalWeight: saturatingWeightAdd(
        total.totalWeight,
        artifacts.routes.totalWeight,
      ),
      printedWeight: saturatingWeightAdd(
        total.printedWeight,
        artifacts.routes.printedWeight,
      ),
      omittedWeight: saturatingWeightAdd(
        total.omittedWeight,
        artifacts.routes.omittedWeight,
      ),
    }),
    {
      policy,
      totalCount: 0,
      printedCount: 0,
      omittedCount: 0,
      totalWeight: 0,
      printedWeight: 0,
      omittedWeight: 0,
    },
  );
}

function validateRequestOptions(options: PrintPlateExportOptions): void {
  if (!Number.isFinite(options.scale) || options.scale <= 0) {
    throw new RangeError("Print scale must be a positive finite number.");
  }
  if (
    options.acknowledgeBelowProfileScale !== undefined &&
    typeof options.acknowledgeBelowProfileScale !== "boolean"
  ) {
    throw new TypeError(
      "Below-profile scale acknowledgement must be a boolean.",
    );
  }
  if (
    options.fitPolicy !== "error" &&
    options.fitPolicy !== "scale" &&
    options.fitPolicy !== "tile"
  ) {
    throw new TypeError("Print fit policy must be 'error', 'scale', or 'tile'.");
  }
  if (options.labelPolicy !== "auto" && options.labelPolicy !== "off") {
    throw new TypeError("Label policy must be 'auto' or 'off'.");
  }
  if (options.routePolicy !== "auto" && options.routePolicy !== "off") {
    throw new TypeError("Route policy must be 'auto' or 'off'.");
  }
  if (typeof options.includeLegend !== "boolean") {
    throw new TypeError("Legend selection must be a boolean.");
  }
  if (
    options.maximumPlateCount !== undefined &&
    (!Number.isSafeInteger(options.maximumPlateCount) ||
      options.maximumPlateCount <= 0 ||
      options.maximumPlateCount > DEFAULT_MAXIMUM_PLATE_COUNT)
  ) {
    throw new RangeError(
      `maximumPlateCount must be between 1 and ${DEFAULT_MAXIMUM_PLATE_COUNT}.`,
    );
  }
}

export function preparePrintPlateBundle(
  request: PrintPlateExportRequest,
  onProgress?: PrintPlateExportProgressListener,
): PreparedPrintPlateBundle {
  progress(onProgress, {
    phase: "validating",
    completed: 0.05,
    message: "Validating model and printer profile",
  });
  validateRequestOptions(request.options);
  if (request.format !== "3mf" && request.format !== "stl") {
    throw new TypeError("Export format must be either '3mf' or 'stl'.");
  }
  const model = validateCityModel(request.model);
  const profile = parsePrinterProfile(request.profile);
  if (!profile.supportedFormats.includes(request.format)) {
    throw new TypeError(
      `Format '${request.format}' is not supported by profile '${profile.id}'.`,
    );
  }
  const base = requiredBase(model);
  const baseBounds = box(base.position, base.size);
  const assignments = assignSemanticGroups(profile, model.semanticGroups);
  const channels = channelMap(assignments);
  const features = sourceFeatures(
    model,
    request.options.scale,
  );
  const allExternal = selectExternalDependencies(model.dependencies);
  const hasExternal = allExternal.nodes.length > 0;
  const externalChannel = hasExternal
    ? requiredChannel(channels, "external")
    : undefined;
  const externalApronDepth =
    EXTERNAL_DEPENDENCY_APRON_MARGIN * 2 +
    EXTERNAL_DEPENDENCY_BOX_SIZE.z;
  const layout = planPrintLayout(profile, {
    fitPolicy: request.options.fitPolicy,
    requestedScale: request.options.scale,
    acknowledgeBelowProfileScale:
      request.options.acknowledgeBelowProfileScale ?? false,
    districts: model.districts.map((district) => {
      const districtGroups = new Set([
        "base",
        ...model.buildings
          .filter(({ districtId }) => districtId === district.id)
          .map(({ semanticGroupId }) => semanticGroupId),
      ]);
      return {
        id: district.id,
        name: district.name,
        sourceBounds: sourceDistrictBounds(
          district,
          model.buildings,
          baseBounds.maximum.y,
        ),
        sourceFoundationThickness:
          sourceDistrictFoundationThickness(
            district,
            baseBounds.maximum.y,
          ),
        channelIds: [...districtGroups]
          .map((group) => requiredChannel(channels, group))
          .sort(compare),
      };
    }),
    features,
    identity: {
      id: "print-identity",
      sourceBounds: identitySourceBounds(model, profile),
      scaleMode: "physical",
      channelIds: [requiredChannel(channels, "identity")],
    },
    ...(hasExternal
      ? {
          rearReservation: {
            id: "external-apron",
            depth: externalApronDepth,
            height: EXTERNAL_DEPENDENCY_BOX_SIZE.y,
            boxes: allExternal.nodes.map(({ id }) => ({
              id,
              size: { ...EXTERNAL_DEPENDENCY_BOX_SIZE },
              channelIds: [externalChannel!],
            })),
            channelIds: [externalChannel!],
          },
        }
      : {}),
    districtGap: resolvePrinterGeometryLimits(profile).minimumGap,
    maximumPlateCount:
      request.options.maximumPlateCount ?? DEFAULT_MAXIMUM_PLATE_COUNT,
    baseChannelId: requiredChannel(channels, "base"),
  });
  assertCompleteLayout(layout);
  progress(onProgress, {
    phase: "layout",
    completed: 0.2,
    message: `Planned ${layout.plates.length} print ${
      layout.plates.length === 1 ? "plate" : "plates"
    }`,
    plateCount: layout.plates.length,
  });

  const plateByDistrict = new Map<string, number>();
  for (const plate of layout.plates) {
    for (const district of plate.districts) {
      plateByDistrict.set(district.districtId, plate.index);
    }
  }
  const districtByNode = nodeDistricts(model);
  const globalBuildingCodes = assignBuildingPrintCodes(model.buildings);
  const globalDistrictCodes = assignDistrictPrintCodes(model.districts);
  const title =
    model.identity?.title ??
    model.repositories[0]?.name ??
    "Code City";
  const preparedPlates: PreparedPrintPlate[] = [];

  for (const [plateOffset, plate] of layout.plates.entries()) {
    const districtIds = new Set(
      plate.districts.map(({ districtId }) => districtId),
    );
    const dependencySlice = plateDependencies(
      model,
      allExternal,
      plate.index,
      districtIds,
      districtByNode,
      plateByDistrict,
    );
    const derived = plateModel(
      model,
      plate,
      dependencySlice.dependencies,
      profile,
    );
    const plateBase = requiredBase(derived);
    const externalLayout = layoutExternalNodes(
      allExternal,
      dependencySlice.dependencies,
      plateBase,
      plate.reservations,
    );
    const plateNumber = plate.reservations.find(
      ({ kind }) => kind === "plate-number",
    );
    if (plateNumber === undefined || plateNumber.label === undefined) {
      throw new TypeError(`Plate '${plate.id}' has no printable number.`);
    }
    const identityReservation = plate.reservations.find(
      ({ kind }) => kind === "identity",
    );
    const artifacts = buildPrintableCityArtifacts(
      derived,
      assignments,
      {
        profile,
        scale: 1,
        scaleFidelity: {
          requestedScale: layout.requestedScale,
          appliedScale: layout.appliedScale,
          minimumSafeScale: layout.minimumSafeScale,
          belowProfileScaleAcknowledged:
            layout.belowProfileScaleAcknowledged,
          featureViolations: layout.featureViolations,
        },
        labelPolicy: request.options.labelPolicy,
        routePolicy: request.options.routePolicy,
        plateNumber: {
          id: plateNumber.id,
          label: plateNumber.label,
          bounds: plateNumber.bounds,
        },
        ...(identityReservation === undefined
          ? {}
          : { identityReservation: identityReservation.bounds }),
        externalLayout,
        buildingPrintCodes: retainedCodes(
          globalBuildingCodes,
          new Set(derived.buildings.map(({ id }) => id)),
        ),
        districtPrintCodes: retainedCodes(
          globalDistrictCodes,
          districtIds,
        ),
      },
    );
    const city: PrintableCity = {
      ...artifacts.city,
      scale: layout.appliedScale,
    };
    const normalizedArtifacts: PrintableCityArtifacts = {
      ...artifacts,
      city,
    };
    const baseMinimum = plate.base.bounds.minimum;
    const warnings = plateWarnings(normalizedArtifacts, []);
    const bundlePlate: PrintBundlePlateRequest = {
      number: plate.index,
      id: plate.id,
      city,
      utilization: plate.utilization,
      districts: plate.districts.map(({ districtId, transform }) => ({
        districtId,
        translation: {
          x: transform.translation.x - baseMinimum.x,
          y: transform.translation.z - baseMinimum.z,
        },
        rotation: transform.rotation,
      })),
      externalDependencies: dependencySlice.externalMetadata,
      warnings,
      labels: normalizedArtifacts.labels,
      routes: normalizedArtifacts.routes,
    };
    preparedPlates.push({
      layout: plate,
      model: derived,
      artifacts: normalizedArtifacts,
      bundlePlate,
    });
    progress(onProgress, {
      phase: "geometry",
      completed:
        0.2 + ((plateOffset + 1) / layout.plates.length) * 0.55,
      message: `Built geometry for plate ${plate.index} of ${layout.plates.length}`,
      plateNumber: plate.index,
      plateCount: layout.plates.length,
    });
  }

  const routingReasons = new Map<string, PrintRouteOmissionReason>();
  for (const { artifacts } of preparedPlates) {
    for (const outcome of artifacts.routeOutcomes) {
      if (outcome.status === "omitted") {
        routingReasons.set(outcome.dependencyId, outcome.reason);
      }
    }
  }
  const omissions = routeOmissions(
    model,
    request.options.routePolicy,
    districtByNode,
    plateByDistrict,
    routingReasons,
  );
  const unplaced: PrintBundleUnplacedObject[] = layout.unplaced.map(
    (item) => ({
      kind: "district",
      id: item.id,
      label: item.name,
      reason: "no-space",
      size: {
        width: item.required.x,
        depth: item.required.z,
        height: item.required.y,
      },
    }),
  );
  const warnings = [...layout.warnings];
  warnings.push(
    ...new Set(
      preparedPlates.flatMap(({ artifacts }) => artifacts.warnings),
    ),
  );
  const mergedGroups = assignments.filter(
    ({ mergedIntoSemanticGroupId }) =>
      mergedIntoSemanticGroupId !== undefined,
  ).length;
  if (mergedGroups > 0) {
    warnings.push(
      `${mergedGroups} semantic ${
        mergedGroups === 1 ? "group was" : "groups were"
      } merged into available print channels.`,
    );
  }
  if (request.format === "stl") {
    warnings.push(STL_INFORMATION_LOSS_WARNING);
  }
  const legendBytes = request.options.includeLegend
    ? mergedLegend(
        preparedPlates,
        title,
        profile.id,
        request.options.labelPolicy,
      )
    : undefined;
  const bundleRequest: PrintBundleRequest = {
    format: request.format,
    title,
    ...(model.identity?.version === undefined
      ? {}
      : { version: model.identity.version }),
    profile: { id: profile.id, name: profile.name },
    fitPolicy: layout.fitPolicy,
    requestedScale: layout.requestedScale,
    appliedScale: layout.appliedScale,
    minimumSafeScale: layout.minimumSafeScale,
    belowProfileScaleAcknowledged:
      layout.belowProfileScaleAcknowledged,
    featureViolations: layout.featureViolations,
    warnings,
    unplacedObjects: unplaced,
    routeOmissions: omissions,
    plates: preparedPlates.map(({ bundlePlate }) => bundlePlate),
    ...(legendBytes === undefined ? {} : { legendBytes }),
  };
  const source = sourcePrimitiveBounds(model);
  const sourceMinimum = {
    x: Math.min(...source.map(({ bounds }) => bounds.minimum.x)),
    y: Math.min(...source.map(({ bounds }) => bounds.minimum.y)),
    z: Math.min(...source.map(({ bounds }) => bounds.minimum.z)),
  };
  const sourceMaximum = {
    x: Math.max(...source.map(({ bounds }) => bounds.maximum.x)),
    y: Math.max(...source.map(({ bounds }) => bounds.maximum.y)),
    z: Math.max(...source.map(({ bounds }) => bounds.maximum.z)),
  };
  const preview: PrintPlatePreviewSource = {
    fitPolicy: layout.fitPolicy,
    appliedPolicy: layout.fitPolicy,
    requestedScale: layout.requestedScale,
    appliedScale: layout.appliedScale,
    minimumSafeScale: layout.minimumSafeScale,
    belowProfileScaleAcknowledged:
      layout.belowProfileScaleAcknowledged,
    featureViolations: layout.featureViolations,
    sourceBounds: sizedBounds(sourceMinimum, sourceMaximum),
    printableBounds: sizedBounds(
      { x: 0, y: 0, z: 0 },
      {
        x: Math.max(
          ...preparedPlates.map(
            ({ artifacts }) => artifacts.city.bounds.size.x,
          ),
        ),
        y: Math.max(
          ...preparedPlates.map(
            ({ artifacts }) => artifacts.city.bounds.size.y,
          ),
        ),
        z: Math.max(
          ...preparedPlates.map(
            ({ artifacts }) => artifacts.city.bounds.size.z,
          ),
        ),
      },
    ),
    warnings,
    unplacedObjects: unplaced.map(({ id }) => ({ id })),
    plates: preparedPlates.map(({ layout: plate, artifacts, bundlePlate }) => ({
      number: plate.index,
      id: plate.id,
      fileName: `plate-${String(plate.index).padStart(2, "0")}.${
        request.format
      }`,
      utilization: plate.utilization,
      bounds: artifacts.city.bounds,
      warnings: bundlePlate.warnings,
      parts: artifacts.city.parts,
    })),
  };
  const preflight: PrintPlateBundlePreflight = {
    format: request.format,
    title,
    profileId: profile.id,
    profileName: profile.name,
    fitPolicy: layout.fitPolicy,
    requestedScale: layout.requestedScale,
    appliedScale: layout.appliedScale,
    minimumSafeScale: layout.minimumSafeScale,
    belowProfileScaleAcknowledged:
      layout.belowProfileScaleAcknowledged,
    featureViolations: layout.featureViolations,
    plateCount: preparedPlates.length,
    plates: preparedPlates.map(
      ({ layout: plate, artifacts, bundlePlate }) => ({
        number: plate.index,
        id: plate.id,
        fileName: `plate-${String(plate.index).padStart(2, "0")}.${
          request.format
        }`,
        dimensions: {
          width: artifacts.city.bounds.size.x,
          depth: artifacts.city.bounds.size.y,
          height: artifacts.city.bounds.size.z,
        },
        utilization: plate.utilization,
        channelIds: artifacts.city.parts.map(({ channelId }) => channelId),
        warnings: bundlePlate.warnings,
        labels: artifacts.labels,
        routes: artifacts.routes,
      }),
    ),
    labels: summedLabels(preparedPlates),
    routes: summedRoutes(preparedPlates, request.options.routePolicy),
    warnings,
    unplacedObjects: unplaced,
    routeOmissions: omissions,
    legendIncluded: legendBytes !== undefined,
  };
  return {
    format: request.format,
    model,
    profile,
    options: { ...request.options },
    layout,
    plates: preparedPlates,
    bundleRequest,
    preflight,
    preview,
  };
}

export function serializePreparedPrintPlateBundle(
  prepared: PreparedPrintPlateBundle,
  onProgress?: PrintPlateExportProgressListener,
): PrintPlateBundleExportResult {
  assertCompleteLayout(prepared.layout);
  progress(onProgress, {
    phase: "serializing",
    completed: 0.85,
    message: `Serializing ${prepared.layout.plates.length} deterministic print ${
      prepared.layout.plates.length === 1 ? "plate" : "plates"
    }`,
    plateCount: prepared.layout.plates.length,
  });
  const bundle = serializePrintBundle(prepared.bundleRequest);
  progress(onProgress, {
    phase: "complete",
    completed: 1,
    message: "Print bundle ready",
    plateCount: prepared.layout.plates.length,
  });
  return {
    ...bundle,
    layout: prepared.layout,
    preflight: prepared.preflight,
    preview: prepared.preview,
    ...(prepared.bundleRequest.legendBytes === undefined
      ? {}
      : { legendBytes: prepared.bundleRequest.legendBytes }),
  };
}

/**
 * Serializes exact complete one-plate geometry without wrapping the artifact
 * in a ZIP. This preserves the compact base and physical plate number while
 * retaining the direct STL/3MF CLI contract.
 */
export function serializePreparedSinglePrintPlateExport(
  prepared: PreparedPrintPlateBundle,
  onProgress?: PrintPlateExportProgressListener,
): SinglePrintPlateExportResult {
  assertCompleteLayout(prepared.layout);
  if (
    prepared.layout.plates.length !== 1 ||
    prepared.plates.length !== 1 ||
    prepared.preflight.plates.length !== 1
  ) {
    throw new RangeError(
      "Direct single-plate export requires exactly one prepared plate.",
    );
  }
  progress(onProgress, {
    phase: "serializing",
    completed: 0.85,
    message: `Serializing direct ${prepared.format.toUpperCase()} print plate`,
    plateNumber: 1,
    plateCount: 1,
  });
  const city = prepared.plates[0]!.artifacts.city;
  const artifact: PrintExportArtifact =
    prepared.format === "3mf"
      ? {
          format: "3mf",
          mimeType: "model/3mf",
          fileExtension: ".3mf",
          bytes: serializeThreeMf(city),
        }
      : {
          format: "stl",
          mimeType: "model/stl",
          fileExtension: ".stl",
          bytes: serializeBinaryStl(city),
      };
  const manifest: DirectPrintExportManifest = {
    schema: PRINT_EXPORT_MANIFEST_SCHEMA,
    title: prepared.preflight.title,
    ...(prepared.model.identity?.version === undefined
      ? {}
      : { version: prepared.model.identity.version }),
    format: prepared.format,
    profile: {
      id: prepared.preflight.profileId,
      name: prepared.preflight.profileName,
    },
    fit: {
      policy: prepared.layout.fitPolicy,
      requestedScale: prepared.preflight.requestedScale,
      appliedScale: prepared.preflight.appliedScale,
      minimumSafeScale: prepared.preflight.minimumSafeScale,
      belowProfileScaleAcknowledged:
        prepared.preflight.belowProfileScaleAcknowledged,
      featureViolations: prepared.preflight.featureViolations,
    },
    plate: prepared.preflight.plates[0]!,
    warnings: prepared.preflight.warnings,
    legendIncluded: prepared.preflight.legendIncluded,
  };
  const manifestBytes = new TextEncoder().encode(
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  progress(onProgress, {
    phase: "complete",
    completed: 1,
    message: `${prepared.format.toUpperCase()} print plate ready`,
    plateNumber: 1,
    plateCount: 1,
  });
  return {
    layout: prepared.layout,
    preflight: prepared.preflight,
    preview: prepared.preview,
    artifact,
    manifest,
    manifestBytes,
    ...(prepared.bundleRequest.legendBytes === undefined
      ? {}
      : { legendBytes: prepared.bundleRequest.legendBytes }),
  };
}

export function generatePrintPlateBundle(
  request: PrintPlateExportRequest,
  onProgress?: PrintPlateExportProgressListener,
): PrintPlateBundleExportResult {
  return serializePreparedPrintPlateBundle(
    preparePrintPlateBundle(request, onProgress),
    onProgress,
  );
}
