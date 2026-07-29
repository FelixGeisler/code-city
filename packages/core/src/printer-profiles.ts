import type {
  OverflowPolicy,
  PrintChannel,
  PrintChannelMechanism,
  PrintFormat,
  PrinterGeometryLimits,
  PrinterProfile,
} from "./print.js";
import { validatePrinterProfile } from "./print.js";
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

type JsonObject = Record<string, unknown>;

const PROFILE_KEYS = Object.freeze([
  "id",
  "name",
  "printChannels",
  "supportedFormats",
  "buildVolume",
  "geometryLimits",
  "overflowPolicy",
] as const);
const CHANNEL_KEYS = Object.freeze([
  "id",
  "label",
  "mechanism",
  "color",
  "material",
] as const);
const VECTOR_KEYS = Object.freeze(["x", "y", "z"] as const);
const GEOMETRY_LIMIT_KEYS = Object.freeze([
  "minimumWallThickness",
  "minimumGap",
  "minimumFeatureSize",
  "minimumBaseThickness",
] as const);

export class PrinterProfileParseError extends TypeError {
  public readonly issues: readonly string[];

  public constructor(issues: readonly string[]) {
    const uniqueIssues = [...new Set(issues)];
    super(`Invalid printer profile: ${uniqueIssues.join(" ")}`);
    this.name = "PrinterProfileParseError";
    this.issues = uniqueIssues;
  }
}

/**
 * Parses untrusted profile data into a detached, exact PrinterProfile value.
 * Structural errors retain JSON-style paths; semantic rules remain centralized
 * in validatePrinterProfile.
 */
export function parsePrinterProfile(value: unknown): PrinterProfile {
  const issues: string[] = [];
  const source = readObject(value, "profile", issues);
  if (!source) throw new PrinterProfileParseError(issues);
  rejectUnsupportedKeys(source, PROFILE_KEYS, "profile", issues);

  const id = readString(source, "id", "profile", issues);
  const name = readString(source, "name", "profile", issues);
  const printChannels = readChannels(source, issues);
  const supportedFormats = readFormats(source, issues);
  const buildVolume = readVector(source, "buildVolume", issues);
  const geometryLimits = readGeometryLimits(source, issues);
  const overflowPolicy = readString(
    source,
    "overflowPolicy",
    "profile",
    issues,
  ) as OverflowPolicy;

  if (issues.length > 0) {
    throw new PrinterProfileParseError(issues);
  }
  const profile: PrinterProfile = {
    id,
    name,
    printChannels,
    supportedFormats,
    buildVolume,
    geometryLimits,
    overflowPolicy,
  };
  const semanticIssues = validatePrinterProfile(profile);
  if (semanticIssues.length > 0) {
    throw new PrinterProfileParseError(semanticIssues);
  }
  return profile;
}

export function parsePrinterProfileJson(text: string): PrinterProfile {
  if (typeof text !== "string") {
    throw new PrinterProfileParseError([
      "Printer profile JSON must be a string.",
    ]);
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new PrinterProfileParseError([
      `Printer profile JSON is invalid: ${detail}`,
    ]);
  }
  return parsePrinterProfile(value);
}

function readChannels(
  source: JsonObject,
  issues: string[],
): readonly PrintChannel[] {
  const path = "profile.printChannels";
  if (!hasOwn(source, "printChannels")) {
    issues.push(`${path} is required.`);
    return [];
  }
  const value = source["printChannels"];
  if (!Array.isArray(value)) {
    issues.push(`${path} must be an array.`);
    return [];
  }
  return value.map((item, index): PrintChannel => {
    const itemPath = `${path}[${index}]`;
    const channel = readObject(item, itemPath, issues);
    if (!channel) {
      return {
        id: "",
        label: "",
        mechanism: "" as PrintChannelMechanism,
      };
    }
    rejectUnsupportedKeys(channel, CHANNEL_KEYS, itemPath, issues);
    const color = readOptionalString(channel, "color", itemPath, issues);
    const material = readOptionalString(
      channel,
      "material",
      itemPath,
      issues,
    );
    return {
      id: readString(channel, "id", itemPath, issues),
      label: readString(channel, "label", itemPath, issues),
      mechanism: readString(
        channel,
        "mechanism",
        itemPath,
        issues,
      ) as PrintChannelMechanism,
      ...(color === undefined ? {} : { color }),
      ...(material === undefined ? {} : { material }),
    };
  });
}

function readFormats(
  source: JsonObject,
  issues: string[],
): readonly PrintFormat[] {
  const path = "profile.supportedFormats";
  if (!hasOwn(source, "supportedFormats")) {
    issues.push(`${path} is required.`);
    return [];
  }
  const value = source["supportedFormats"];
  if (!Array.isArray(value)) {
    issues.push(`${path} must be an array.`);
    return [];
  }
  return value.map((format, index) => {
    if (typeof format !== "string") {
      issues.push(`${path}[${index}] must be a string.`);
      return "" as PrintFormat;
    }
    return format as PrintFormat;
  });
}

function readVector(
  source: JsonObject,
  key: "buildVolume",
  issues: string[],
): Vector3 {
  const path = `profile.${key}`;
  if (!hasOwn(source, key)) {
    issues.push(`${path} is required.`);
    return { x: 0, y: 0, z: 0 };
  }
  const value = readObject(source[key], path, issues);
  if (!value) return { x: 0, y: 0, z: 0 };
  rejectUnsupportedKeys(value, VECTOR_KEYS, path, issues);
  return {
    x: readNumber(value, "x", path, issues),
    y: readNumber(value, "y", path, issues),
    z: readNumber(value, "z", path, issues),
  };
}

function readGeometryLimits(
  source: JsonObject,
  issues: string[],
): PrinterGeometryLimits {
  const path = "profile.geometryLimits";
  if (!hasOwn(source, "geometryLimits")) {
    issues.push(`${path} is required.`);
    return {
      minimumWallThickness: 0,
      minimumGap: 0,
      minimumFeatureSize: 0,
      minimumBaseThickness: 0,
    };
  }
  const value = readObject(source["geometryLimits"], path, issues);
  if (!value) {
    return {
      minimumWallThickness: 0,
      minimumGap: 0,
      minimumFeatureSize: 0,
      minimumBaseThickness: 0,
    };
  }
  rejectUnsupportedKeys(value, GEOMETRY_LIMIT_KEYS, path, issues);
  return {
    minimumWallThickness: readNumber(
      value,
      "minimumWallThickness",
      path,
      issues,
    ),
    minimumGap: readNumber(value, "minimumGap", path, issues),
    minimumFeatureSize: readNumber(
      value,
      "minimumFeatureSize",
      path,
      issues,
    ),
    minimumBaseThickness: readNumber(
      value,
      "minimumBaseThickness",
      path,
      issues,
    ),
  };
}

function readObject(
  value: unknown,
  path: string,
  issues: string[],
): JsonObject | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    issues.push(`${path} must be an object.`);
    return undefined;
  }
  return value as JsonObject;
}

function readString(
  source: JsonObject,
  key: string,
  parentPath: string,
  issues: string[],
): string {
  const path = propertyPath(parentPath, key);
  if (!hasOwn(source, key)) {
    issues.push(`${path} is required.`);
    return "";
  }
  const value = source[key];
  if (typeof value !== "string") {
    issues.push(`${path} must be a string.`);
    return "";
  }
  return value;
}

function readOptionalString(
  source: JsonObject,
  key: string,
  parentPath: string,
  issues: string[],
): string | undefined {
  if (!hasOwn(source, key)) return undefined;
  const path = propertyPath(parentPath, key);
  const value = source[key];
  if (typeof value !== "string") {
    issues.push(`${path} must be a string when supplied.`);
    return undefined;
  }
  return value;
}

function readNumber(
  source: JsonObject,
  key: string,
  parentPath: string,
  issues: string[],
): number {
  const path = propertyPath(parentPath, key);
  if (!hasOwn(source, key)) {
    issues.push(`${path} is required.`);
    return 0;
  }
  const value = source[key];
  if (typeof value !== "number") {
    issues.push(`${path} must be a number.`);
    return 0;
  }
  return value;
}

function rejectUnsupportedKeys(
  source: JsonObject,
  supported: readonly string[],
  parentPath: string,
  issues: string[],
): void {
  const supportedKeys = new Set(supported);
  for (const key of Object.keys(source).sort(compareText)) {
    if (!supportedKeys.has(key)) {
      issues.push(`${propertyPath(parentPath, key)} is not supported.`);
    }
  }
}

function propertyPath(parent: string, key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(key)
    ? `${parent}.${key}`
    : `${parent}[${JSON.stringify(key)}]`;
}

function hasOwn(source: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(source, key);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
