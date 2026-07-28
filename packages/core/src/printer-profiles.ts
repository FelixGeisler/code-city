import type {
  OverflowPolicy,
  PrintChannel,
  PrintFormat,
  PrinterGeometryLimits,
  PrinterProfile,
} from "./print.js";
import type { Vector3 } from "./model.js";

export const DEFAULT_FDM_GEOMETRY_LIMITS: Readonly<PrinterGeometryLimits> =
  Object.freeze({
    minimumWallThickness: 0.45,
    minimumGap: 0.4,
    minimumFeatureSize: 0.8,
    minimumBaseThickness: 0.8,
  });

export interface PrusaXLProfileOptions {
  readonly overflowPolicy?: OverflowPolicy;
  readonly supportedFormats?: readonly PrintFormat[];
  readonly geometryLimits?: PrinterGeometryLimits;
}

function toolKey(value: string | number): string {
  const key = String(value).normalize("NFC").trim();
  if (!/^[1-5]$/u.test(key)) {
    throw new TypeError(
      "Prusa XL tool ids must be integers from 1 through 5.",
    );
  }
  return key;
}

function compareToolIds(left: string, right: string): number {
  const leftNumber = /^\d+$/u.test(left) ? Number(left) : Number.NaN;
  const rightNumber = /^\d+$/u.test(right) ? Number(right) : Number.NaN;
  if (Number.isSafeInteger(leftNumber) && Number.isSafeInteger(rightNumber)) {
    return leftNumber - rightNumber;
  }
  return left < right ? -1 : left > right ? 1 : 0;
}

export function createPrusaXLProfile(
  enabledToolIds: readonly (string | number)[],
  options: PrusaXLProfileOptions = {},
): PrinterProfile {
  const tools = enabledToolIds.map(toolKey).sort(compareToolIds);
  if (tools.length === 0) {
    throw new TypeError("The Prusa XL profile requires an enabled tool.");
  }
  if (new Set(tools).size !== tools.length) {
    throw new TypeError("Enabled Prusa XL tool ids must be unique.");
  }
  return {
    id: `prusa-xl-${tools.map((tool) => `t${tool}`).join("-")}`,
    name: `Prusa XL (${tools.length} enabled ${tools.length === 1 ? "tool" : "tools"})`,
    printChannels: tools.map(
      (toolId): PrintChannel => ({
        id: `tool-${toolId}`,
        label: `Tool ${toolId}`,
        mechanism: "toolchanger",
      }),
    ),
    supportedFormats: options.supportedFormats ?? ["3mf", "stl"],
    buildVolume: { x: 360, y: 360, z: 360 },
    geometryLimits:
      options.geometryLimits ?? DEFAULT_FDM_GEOMETRY_LIMITS,
    overflowPolicy: options.overflowPolicy ?? "merge",
  };
}

export interface SingleChannelProfileOptions {
  readonly id?: string;
  readonly name?: string;
  readonly channelId?: string;
  readonly channelLabel?: string;
  readonly mechanism?: "single" | "manual";
  readonly supportedFormats?: readonly PrintFormat[];
  readonly buildVolume?: Vector3;
  readonly geometryLimits?: PrinterGeometryLimits;
  readonly overflowPolicy?: OverflowPolicy;
}

export function createSingleChannelProfile(
  options: SingleChannelProfileOptions = {},
): PrinterProfile {
  return {
    id: options.id ?? "generic-single-channel",
    name: options.name ?? "Generic single-channel printer",
    printChannels: [
      {
        id: options.channelId ?? "channel-1",
        label: options.channelLabel ?? "Channel 1",
        mechanism: options.mechanism ?? "single",
      },
    ],
    supportedFormats: options.supportedFormats ?? ["stl", "3mf"],
    buildVolume: options.buildVolume ?? { x: 220, y: 250, z: 220 },
    geometryLimits:
      options.geometryLimits ?? DEFAULT_FDM_GEOMETRY_LIMITS,
    overflowPolicy: options.overflowPolicy ?? "monochrome",
  };
}

export const createGenericSingleChannelProfile = createSingleChannelProfile;
export const createPrusaXlProfile = createPrusaXLProfile;
