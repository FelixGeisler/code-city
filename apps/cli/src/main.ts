#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { analyzeLocalRepositories } from "../../../packages/analyzer/src/index.js";
import {
  CITY_MODEL_SCHEMA_VERSION,
  planPrint,
  PrintPlanValidationError,
  validatePrinterProfile,
} from "../../../packages/core/src/index.js";
import type {
  CityModel,
  PrinterProfile,
  PrintFormat,
} from "../../../packages/core/src/index.js";

const HELP = `Code City

Usage:
  codecity analyze <root...> --output <city-model.json> [options]
  codecity plan --model <city-model.json> --profile <profile.json> \\
    --format <stl|3mf> --output <print-plan.json>

Analyze options:
  --title <text>       Printed city/repository title
  --version <text>     Optional printed version or commit label
  --logo <path>        Relative .svg or .png asset reference

General:
  -h, --help           Show this help

Analysis reads only the explicitly supplied local roots. It does not require
Git, use the network, restore/build projects, or execute repository code.
`;

export interface CliIo {
  readonly stdout: (message: string) => void;
  readonly stderr: (message: string) => void;
}

interface ParsedArguments {
  readonly positionals: readonly string[];
  readonly options: ReadonlyMap<string, string>;
}

const defaultIo: CliIo = {
  stdout: (message) => process.stdout.write(message),
  stderr: (message) => process.stderr.write(message),
};

function parseArguments(
  args: readonly string[],
  valuedOptions: ReadonlySet<string>,
): ParsedArguments {
  const positionals: string[] = [];
  const options = new Map<string, string>();
  let positionalOnly = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--") {
      positionalOnly = true;
      continue;
    }
    if (!positionalOnly && argument.startsWith("--")) {
      const equals = argument.indexOf("=");
      const name = equals < 0 ? argument.slice(2) : argument.slice(2, equals);
      if (!valuedOptions.has(name)) {
        throw new Error(`Unknown option '--${name}'.`);
      }
      const value = equals < 0 ? args[index + 1] : argument.slice(equals + 1);
      if (value === undefined || (equals < 0 && value.startsWith("--"))) {
        throw new Error(`Option '--${name}' requires a value.`);
      }
      if (options.has(name)) {
        throw new Error(`Option '--${name}' may only be supplied once.`);
      }
      options.set(name, value);
      if (equals < 0) index += 1;
    } else {
      positionals.push(argument);
    }
  }
  return { positionals, options };
}

function requiredOption(
  options: ReadonlyMap<string, string>,
  name: string,
): string {
  const value = options.get(name);
  if (!value) throw new Error(`Missing required option '--${name}'.`);
  return value;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  const absolutePath = path.resolve(filePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson(filePath: string, description: string): Promise<unknown> {
  let text: string;
  try {
    text = await fs.readFile(path.resolve(filePath), "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot read ${description} '${filePath}': ${detail}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in ${description} '${filePath}': ${detail}`);
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseCityModel(value: unknown): CityModel {
  const bounds = object(value) ? value["bounds"] : undefined;
  if (
    !object(value) ||
    value["schemaVersion"] !== CITY_MODEL_SCHEMA_VERSION ||
    !Array.isArray(value["repositories"]) ||
    !Array.isArray(value["modules"]) ||
    !Array.isArray(value["buildings"]) ||
    !Array.isArray(value["semanticGroups"]) ||
    !value["semanticGroups"].every(
      (group) =>
        object(group) &&
        typeof group["id"] === "string" &&
        typeof group["label"] === "string" &&
        typeof group["color"] === "string" &&
        typeof group["priority"] === "number",
    ) ||
    !object(bounds) ||
    typeof bounds["x"] !== "number" ||
    typeof bounds["y"] !== "number" ||
    typeof bounds["z"] !== "number"
  ) {
    throw new Error(
      `Model must be a Code City ${CITY_MODEL_SCHEMA_VERSION} city model.`,
    );
  }
  return value as unknown as CityModel;
}

function parsePrinterProfile(value: unknown): PrinterProfile {
  const channels = object(value) ? value["printChannels"] : undefined;
  const formats = object(value) ? value["supportedFormats"] : undefined;
  const buildVolume = object(value) ? value["buildVolume"] : undefined;
  const geometryLimits = object(value) ? value["geometryLimits"] : undefined;
  if (
    !object(value) ||
    typeof value["id"] !== "string" ||
    typeof value["name"] !== "string" ||
    !Array.isArray(channels) ||
    !channels.every(
      (channel) =>
        object(channel) &&
        typeof channel["id"] === "string" &&
        typeof channel["label"] === "string" &&
        typeof channel["mechanism"] === "string",
    ) ||
    !Array.isArray(formats) ||
    !formats.every((format) => format === "stl" || format === "3mf") ||
    !object(buildVolume) ||
    typeof buildVolume["x"] !== "number" ||
    typeof buildVolume["y"] !== "number" ||
    typeof buildVolume["z"] !== "number" ||
    !object(geometryLimits) ||
    typeof geometryLimits["minimumWallThickness"] !== "number" ||
    typeof geometryLimits["minimumGap"] !== "number" ||
    typeof geometryLimits["minimumFeatureSize"] !== "number" ||
    typeof geometryLimits["minimumBaseThickness"] !== "number" ||
    typeof value["overflowPolicy"] !== "string"
  ) {
    throw new Error("Profile is not a valid Code City printer profile.");
  }
  const profile = value as unknown as PrinterProfile;
  const issues = validatePrinterProfile(profile);
  if (issues.length > 0) {
    throw new Error(`Invalid printer profile: ${issues.join(" ")}`);
  }
  return profile;
}

async function analyzeCommand(args: readonly string[], io: CliIo): Promise<void> {
  const parsed = parseArguments(
    args,
    new Set(["output", "title", "version", "logo"]),
  );
  if (parsed.positionals.length === 0) {
    throw new Error("The analyze command requires at least one local root.");
  }
  const output = requiredOption(parsed.options, "output");
  const model = await analyzeLocalRepositories(parsed.positionals, {
    ...(parsed.options.get("title") === undefined
      ? {}
      : { title: parsed.options.get("title")! }),
    ...(parsed.options.get("version") === undefined
      ? {}
      : { version: parsed.options.get("version")! }),
    ...(parsed.options.get("logo") === undefined
      ? {}
      : { logo: parsed.options.get("logo")! }),
  });
  await writeJson(output, model);
  io.stdout(
    `Analyzed ${model.repositories.length} root(s), ${model.modules.length} module(s), and ${model.buildings.length} source file(s).\nWrote ${path.resolve(output)}\n`,
  );
  for (const warning of model.analysis?.warnings ?? []) {
    io.stderr(`Warning: ${warning}\n`);
  }
  if (model.buildings.some((building) => building.language === "csharp")) {
    io.stderr(
      "Note: C# complexity currently uses the safe lexical-v1 first slice; TypeScript/JavaScript use the compiler API.\n",
    );
  }
}

async function planCommand(args: readonly string[], io: CliIo): Promise<void> {
  const parsed = parseArguments(
    args,
    new Set(["model", "profile", "format", "output"]),
  );
  if (parsed.positionals.length > 0) {
    throw new Error(
      `Unexpected plan argument '${parsed.positionals[0]}'. Use named options.`,
    );
  }
  const modelPath = requiredOption(parsed.options, "model");
  const profilePath = requiredOption(parsed.options, "profile");
  const formatValue = requiredOption(parsed.options, "format");
  const output = requiredOption(parsed.options, "output");
  if (formatValue !== "stl" && formatValue !== "3mf") {
    throw new Error("--format must be either 'stl' or '3mf'.");
  }
  const format: PrintFormat = formatValue;
  const model = parseCityModel(await readJson(modelPath, "city model"));
  const profile = parsePrinterProfile(
    await readJson(profilePath, "printer profile"),
  );
  const limits = profile.geometryLimits;
  const plan = planPrint(profile, {
    format,
    semanticGroups: model.semanticGroups,
    bounds: model.bounds,
    geometry: {
      wallThickness: limits.minimumWallThickness,
      gap: limits.minimumGap,
      minimumFeatureSize: limits.minimumFeatureSize,
      baseThickness: limits.minimumBaseThickness,
    },
    ...(model.identity === undefined ? {} : { identity: model.identity }),
    ...(model.identityPanel === undefined
      ? {}
      : { identityPanel: model.identityPanel }),
  });
  await writeJson(output, plan);
  io.stdout(
    `Planned ${format.toUpperCase()} output across ${plan.channels.length} print channel(s).\nWrote ${path.resolve(output)}\n`,
  );
}

export async function runCli(
  args: readonly string[],
  io: CliIo = defaultIo,
): Promise<number> {
  const command = args[0];
  if (
    command === undefined ||
    command === "--help" ||
    command === "-h" ||
    command === "help"
  ) {
    io.stdout(HELP);
    return 0;
  }
  if (args[1] === "--help" || args[1] === "-h") {
    io.stdout(HELP);
    return 0;
  }

  try {
    if (command === "analyze") {
      await analyzeCommand(args.slice(1), io);
    } else if (command === "plan") {
      await planCommand(args.slice(1), io);
    } else {
      throw new Error(`Unknown command '${command}'.`);
    }
    return 0;
  } catch (error) {
    if (error instanceof PrintPlanValidationError) {
      io.stderr(`${error.message}\n`);
    } else {
      const message = error instanceof Error ? error.message : String(error);
      io.stderr(`Error: ${message}\n`);
    }
    io.stderr("Run 'codecity --help' for usage.\n");
    return 1;
  }
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(invokedPath)).href
) {
  process.exitCode = await runCli(process.argv.slice(2));
}
