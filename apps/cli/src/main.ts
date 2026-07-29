#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  analyzeLocalRepositories,
  type LocalAnalysisOptions,
} from "../../../packages/analyzer/src/index.js";
import {
  assignSemanticGroups,
  parsePrinterProfile,
  parsePrintLabelPolicy,
  parsePrintRoutePolicy,
  planPrint,
  PrintPlanValidationError,
  validateCityModel,
} from "../../../packages/core/src/index.js";
import type {
  CityModel,
  PrintFormat,
  PrintRoutePolicy,
} from "../../../packages/core/src/index.js";
import {
  buildDependencyConnectorComparison,
  buildPrintableCityArtifacts,
  generateThreeMfExport,
  printablePlanGeometry,
  serializeThreeMf,
} from "../../../packages/exporter/src/index.js";
import { publishArtifactsAtomically } from "./artifact-publication.js";
import {
  CLI_JSON_LIMITS,
  publishPrivateJson,
  readBoundedJsonFile,
} from "./json-file.js";

const HELP = `Code City

Usage:
  codecity analyze <root...> --output <city-model.json> [options]
  codecity plan --model <city-model.json> --profile <profile.json> \\
    --format <stl|3mf> --output <print-plan.json> [--scale <factor>] \\
    [--labels <auto|off>] [--routes <auto|off>]
  codecity export --model <city-model.json> --profile <profile.json> \\
    --format 3mf --output <model.3mf> [--scale <factor>] \\
    [--labels <auto|off>] [--routes <auto|off>] \\
    [--legend <legend.json|off>]
  codecity compare-connectors --profile <profile.json> --output <model.3mf> \\
    [--instructions <instructions.txt>]

Analyze options:
  --title <text>             Printed city/repository title
  --version <text>           Optional printed version or commit label
  --logo <path>              Relative .svg or .png asset reference
  --max-files <count>        Retained input files (default: 50000)
  --max-file-bytes <bytes>   Bytes per retained file (default: 2097152)
  --max-total-bytes <bytes>  Retained content bytes (default: 268435456)
  --timeout-ms <ms>          Snapshot + analysis deadline (default: 300000)

Print options:
  --labels <auto|off>  Same-channel physical labels (default: auto)
  --routes <auto|off>  Aggregated dependency traces (default: off)
  --legend <path|off>  Private companion legend (default: beside 3MF)

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

function positiveSafeIntegerOption(
  options: ReadonlyMap<string, string>,
  name: string,
): number | undefined {
  const value = options.get(name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`--${name} must be a positive safe integer.`);
  }
  return parsed;
}

async function readJson(filePath: string, description: string): Promise<unknown> {
  const maximumBytes =
    description === "city model"
      ? CLI_JSON_LIMITS.cityModelBytes
      : CLI_JSON_LIMITS.printerProfileBytes;
  return readBoundedJsonFile(path.resolve(filePath), description, maximumBytes);
}

function parseCityModel(value: unknown): CityModel {
  return validateCityModel(value);
}

async function analyzeCommand(args: readonly string[], io: CliIo): Promise<void> {
  const parsed = parseArguments(
    args,
    new Set([
      "output",
      "title",
      "version",
      "logo",
      "max-files",
      "max-file-bytes",
      "max-total-bytes",
      "timeout-ms",
    ]),
  );
  if (parsed.positionals.length === 0) {
    throw new Error("The analyze command requires at least one local root.");
  }
  const output = requiredOption(parsed.options, "output");
  const maxRetainedFiles = positiveSafeIntegerOption(
    parsed.options,
    "max-files",
  );
  const maxFileBytes = positiveSafeIntegerOption(
    parsed.options,
    "max-file-bytes",
  );
  const maxTotalBytes = positiveSafeIntegerOption(
    parsed.options,
    "max-total-bytes",
  );
  const timeoutMs = positiveSafeIntegerOption(parsed.options, "timeout-ms");
  const analysisOptions: LocalAnalysisOptions = {
    ...(parsed.options.get("title") === undefined
      ? {}
      : { title: parsed.options.get("title")! }),
    ...(parsed.options.get("version") === undefined
      ? {}
      : { version: parsed.options.get("version")! }),
    ...(parsed.options.get("logo") === undefined
      ? {}
      : { logo: parsed.options.get("logo")! }),
    ...(maxRetainedFiles === undefined ? {} : { maxRetainedFiles }),
    ...(maxFileBytes === undefined ? {} : { maxFileBytes }),
    ...(maxTotalBytes === undefined ? {} : { maxTotalBytes }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
  const model = await analyzeLocalRepositories(
    parsed.positionals,
    analysisOptions,
  );
  await publishPrivateJson(output, model, "city model");
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
    new Set([
      "model",
      "profile",
      "format",
      "output",
      "scale",
      "labels",
      "routes",
    ]),
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
  const scale = positiveScale(parsed.options.get("scale"));
  const labelPolicy = cliLabelPolicy(parsed.options.get("labels"));
  const routePolicy = cliRoutePolicy(parsed.options.get("routes"));
  const model = parseCityModel(await readJson(modelPath, "city model"));
  const profile = parsePrinterProfile(
    await readJson(profilePath, "printer profile"),
  );
  const assignments = assignSemanticGroups(profile, model.semanticGroups);
  const artifacts = buildPrintableCityArtifacts(model, assignments, {
    profile,
    scale,
    labelPolicy,
    routePolicy,
  });
  const printable = artifacts.city;
  const planGeometry = printablePlanGeometry(printable);
  const plan = planPrint(profile, {
    format,
    scale,
    labelPolicy,
    routePolicy,
    semanticGroups: model.semanticGroups,
    bounds: planGeometry.bounds,
    geometry: {
      wallThickness: printable.measurements.wallThickness,
      gap: printable.measurements.minimumGap,
      minimumFeatureSize: printable.measurements.minimumFeatureSize,
      baseThickness: printable.measurements.baseThickness,
    },
    ...(model.identity === undefined ? {} : { identity: model.identity }),
    ...(planGeometry.identityPanel === undefined
      ? {}
      : { identityPanel: planGeometry.identityPanel }),
  });
  await publishPrivateJson(output, plan, "print plan");
  io.stdout(
    `Planned ${format.toUpperCase()} output across ${plan.channels.length} print channel(s).\nWrote ${path.resolve(output)}\n`,
  );
  io.stdout(`${labelSummary(artifacts.labels)}\n`);
  io.stdout(`${routeSummary(artifacts.routes)}\n`);
}

function positiveScale(value: string | undefined): number {
  const scale = value === undefined ? 1 : Number(value);
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new Error("--scale must be a positive finite number.");
  }
  return scale;
}

function millimeters(value: number): string {
  return String(Number(value.toFixed(3)));
}

function cliLabelPolicy(value: string | undefined): "auto" | "off" {
  try {
    return parsePrintLabelPolicy(value);
  } catch {
    throw new Error("--labels must be either 'auto' or 'off'.");
  }
}

function cliRoutePolicy(value: string | undefined): PrintRoutePolicy {
  try {
    return parsePrintRoutePolicy(value);
  } catch {
    throw new Error("--routes must be either 'auto' or 'off'.");
  }
}

function labelSummary(labels: {
  readonly printedBuildings: number;
  readonly skippedBuildings: number;
  readonly printedDistricts: number;
  readonly skippedDistricts: number;
}): string {
  return (
    `Labels: ${labels.printedBuildings} building and ` +
    `${labels.printedDistricts} district label(s) printed; ` +
    `${labels.skippedBuildings + labels.skippedDistricts} skipped.`
  );
}

function routeSummary(routes: {
  readonly policy: PrintRoutePolicy;
  readonly totalCount: number;
  readonly printedCount: number;
  readonly omittedCount: number;
  readonly totalWeight: number;
  readonly printedWeight: number;
  readonly omittedWeight: number;
}): string {
  if (routes.policy === "off") return "Routes: disabled.";
  return (
    `Routes: ${routes.printedCount} of ${routes.totalCount} aggregated ` +
    `bundle(s) printed (${routes.printedWeight} of ${routes.totalWeight} ` +
    `weight); ${routes.omittedCount} omitted ` +
    `(${routes.omittedWeight} weight).`
  );
}

function defaultLegendPath(output: string): string {
  return output.replace(/\.3mf$/iu, ".legend.json");
}

function legendPath(
  output: string,
  configured: string | undefined,
): string | undefined {
  if (configured?.toLowerCase() === "off") return undefined;
  const result = configured ?? defaultLegendPath(output);
  if (path.extname(result).toLowerCase() !== ".json") {
    throw new Error("Legend output must use the '.json' file extension.");
  }
  const binaryPath = path.resolve(output);
  const companionPath = path.resolve(result);
  const normalizeForComparison = (value: string) =>
    process.platform === "win32" ? value.toLowerCase() : value;
  if (
    normalizeForComparison(binaryPath) ===
    normalizeForComparison(companionPath)
  ) {
    throw new Error("3MF and legend outputs must use different paths.");
  }
  return result;
}

function companionInstructionsPath(
  output: string,
  configured: string | undefined,
): string {
  const result =
    configured ?? output.replace(/\.3mf$/iu, ".instructions.txt");
  if (path.extname(result).toLowerCase() !== ".txt") {
    throw new Error(
      "Connector instructions must use the '.txt' file extension.",
    );
  }
  return result;
}

async function compareConnectorsCommand(
  args: readonly string[],
  io: CliIo,
): Promise<void> {
  const parsed = parseArguments(
    args,
    new Set(["profile", "output", "instructions"]),
  );
  if (parsed.positionals.length > 0) {
    throw new Error(
      `Unexpected compare-connectors argument '${parsed.positionals[0]}'. Use named options.`,
    );
  }
  const profilePath = requiredOption(parsed.options, "profile");
  const output = requiredOption(parsed.options, "output");
  if (path.extname(output).toLowerCase() !== ".3mf") {
    throw new Error(
      "Connector comparison output must use the '.3mf' file extension.",
    );
  }
  const instructionsOutput = companionInstructionsPath(
    output,
    parsed.options.get("instructions"),
  );
  const profile = parsePrinterProfile(
    await readJson(profilePath, "printer profile"),
  );
  if (!profile.supportedFormats.includes("3mf")) {
    throw new Error(
      `Format '3mf' is not supported by profile '${profile.id}'.`,
    );
  }
  const comparison = buildDependencyConnectorComparison(profile);
  const publishedPaths = await publishArtifactsAtomically([
    {
      destination: output,
      bytes: serializeThreeMf(comparison.printable),
    },
    {
      destination: instructionsOutput,
      bytes: new TextEncoder().encode(comparison.instructions),
    },
  ]);
  const size = comparison.printable.bounds.size;
  io.stdout(
    `Exported connector comparison with ${comparison.printable.parts.length} aligned part(s) at ${millimeters(size.x)} × ${millimeters(size.y)} × ${millimeters(size.z)} mm.\n`,
  );
  io.stdout(`Decision: ${comparison.decision}\n`);
  io.stdout(`Wrote ${publishedPaths[0]}\nWrote ${publishedPaths[1]}\n`);
}

async function exportCommand(args: readonly string[], io: CliIo): Promise<void> {
  const parsed = parseArguments(
    args,
    new Set([
      "model",
      "profile",
      "format",
      "output",
      "scale",
      "labels",
      "routes",
      "legend",
    ]),
  );
  if (parsed.positionals.length > 0) {
    throw new Error(
      `Unexpected export argument '${parsed.positionals[0]}'. Use named options.`,
    );
  }
  const modelPath = requiredOption(parsed.options, "model");
  const profilePath = requiredOption(parsed.options, "profile");
  const format = requiredOption(parsed.options, "format");
  const output = requiredOption(parsed.options, "output");
  const scale = positiveScale(parsed.options.get("scale"));
  const labelPolicy = cliLabelPolicy(parsed.options.get("labels"));
  const routePolicy = cliRoutePolicy(parsed.options.get("routes"));
  if (format !== "3mf") {
    throw new Error(
      "The export command currently supports only '3mf'; STL remains planned in issue #12.",
    );
  }
  if (path.extname(output).toLowerCase() !== ".3mf") {
    throw new Error("3MF output must use the '.3mf' file extension.");
  }
  const companionOutput = legendPath(
    output,
    parsed.options.get("legend"),
  );

  const model = parseCityModel(await readJson(modelPath, "city model"));
  const profile = parsePrinterProfile(
    await readJson(profilePath, "printer profile"),
  );
  const exported = generateThreeMfExport({
    model,
    profile,
    options: {
      scale,
      labelPolicy,
      routePolicy,
      includeLegend: companionOutput !== undefined,
    },
  });
  const publishedPaths = await publishArtifactsAtomically([
    { destination: output, bytes: exported.threeMfBytes },
    ...(companionOutput === undefined
      ? []
      : [
          {
            destination: companionOutput,
            bytes: exported.legendBytes!,
            mode: 0o600,
          },
        ]),
  ]);
  const absoluteOutput = publishedPaths[0]!;
  const absoluteLegend = publishedPaths[1];
  const bounds = exported.preflight.dimensions;
  io.stdout(
    `Exported 3MF with ${exported.preflight.partCount} aligned part(s) at ${bounds.x} × ${bounds.y} × ${bounds.z} mm.\nWrote ${absoluteOutput}\n`,
  );
  if (absoluteLegend !== undefined) {
    io.stdout(`Wrote ${absoluteLegend}\n`);
  } else {
    io.stdout("Legend output disabled.\n");
  }
  io.stdout(`${labelSummary(exported.preflight.labels)}\n`);
  io.stdout(`${routeSummary(exported.preflight.routes)}\n`);
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
    } else if (command === "export") {
      await exportCommand(args.slice(1), io);
    } else if (command === "compare-connectors") {
      await compareConnectorsCommand(args.slice(1), io);
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
