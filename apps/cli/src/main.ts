#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  analyzeGenericGitRepository,
  analyzeLocalRepositories,
  analyzePublicGitHubRepository,
  GENERIC_GIT_PRESECURED_CANONICAL_ANCESTRY,
  GENERIC_GIT_PRESECURED_WINDOWS_ACL,
  type LocalAnalysisOptions,
} from "../../../packages/analyzer/src/index.js";
import {
  parsePrinterProfile,
  parsePrintLabelPolicy,
  parsePrintRoutePolicy,
  PrintPlanValidationError,
  validateCityModel,
} from "../../../packages/core/src/index.js";
import type {
  CityModel,
  PrintFitPolicy,
  PrintFormat,
  PrintRoutePolicy,
} from "../../../packages/core/src/index.js";
import {
  buildDependencyConnectorComparison,
  generateCalibrationPrintExport,
  preparePrintPlateBundle,
  serializePreparedPrintPlateBundle,
  serializePreparedSinglePrintPlateExport,
  serializeThreeMf,
} from "../../../packages/exporter/src/index.js";
import { publishArtifactsAtomically } from "./artifact-publication.js";
import {
  CLI_JSON_LIMITS,
  publishPrivateJson,
  readBoundedJsonFile,
} from "./json-file.js";
import { startLocalOpenServer } from "./open-server.js";

const HELP = `Code City

Usage:
  codecity analyze <root...> --output <city-model.json> [options]
  codecity analyze-github <https://github.com/owner/repository> \\
    --output <city-model.json> [--ref <branch|tag|commit>] [options]
  codecity analyze-git <https|ssh|scp-remote> \\
    --output <city-model.json> [--ref <branch|tag|commit>] \\
    [--trusted-workspace-parent <pre-secured-directory>] [options]
  codecity open <root...> [--port <port>] [options]
  codecity plan --model <city-model.json> --profile <profile.json> \\
    --format <stl|3mf> --output <print-plan.json> [--scale <factor>] \\
    [--fit <error|scale|tile>] [--max-plates <count>] \\
    [--labels <auto|off>] [--routes <auto|off>] \\
    [--acknowledge-below-profile-scale]
  codecity export --model <city-model.json> --profile <profile.json> \\
    --format <stl|3mf> --output <model.stl|model.3mf|bundle.zip> \\
    [--scale <factor>] [--fit <error|scale|tile>] \\
    [--max-plates <count>] \\
    [--labels <auto|off>] [--routes <auto|off>] \\
    [--legend <legend.json|off>] \\
    [--acknowledge-below-profile-scale]
  codecity calibrate --profile <profile.json> --output <model.stl|model.3mf> \\
    [--format <stl|3mf>] [--manifest <manifest.json>]
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

Generic Git workspace option:
  --trusted-workspace-parent <directory>
      Trust assertion for an existing private Generic Git workspace parent.
      Parent/child ACLs protect content; ancestry protects path entries from
      untrusted rename, delete, and delete-child operations.
      Required for Generic Git on Windows.

Open options:
  --port <port>              Loopback port; 0 selects a free port (default: 0)

Print options:
  --fit <error|scale|tile>
                       Oversize policy (default: error)
  --max-plates <count> Tile artifact cap, 1-99 (default: 99)
  --labels <auto|off>  Same-channel physical labels (default: auto)
  --routes <auto|off>  Aggregated dependency traces (default: off)
  --legend <path|off>  Private companion legend (default: beside model)
  --acknowledge-below-profile-scale
                       Expert acknowledgement allowing detail below profile
                       fidelity minima; physical build limits still apply

General:
  -h, --help           Show this help

Local analysis reads only explicitly supplied roots and never uses the network.
GitHub analysis is anonymous, public-only, and resolves an immutable commit.
Generic Git uses installed credentials without storing or printing them.
No mode restores/builds projects or executes repository code.
`;

export interface CliIo {
  readonly stdout: (message: string) => void;
  readonly stderr: (message: string) => void;
}

export interface CliDependencies {
  readonly analyzeGenericGitRepository?: typeof analyzeGenericGitRepository;
  readonly analyzeLocalRepositories?: typeof analyzeLocalRepositories;
  readonly analyzePublicGitHubRepository?: typeof analyzePublicGitHubRepository;
}

interface ParsedArguments {
  readonly positionals: readonly string[];
  readonly options: ReadonlyMap<string, string>;
}

const ANALYSIS_OPTIONS = Object.freeze([
  "output",
  "title",
  "version",
  "logo",
  "max-files",
  "max-file-bytes",
  "max-total-bytes",
  "timeout-ms",
]);

const defaultIo: CliIo = {
  stdout: (message) => process.stdout.write(message),
  stderr: (message) => process.stderr.write(message),
};

function parseArguments(
  args: readonly string[],
  valuedOptions: ReadonlySet<string>,
  flagOptions: ReadonlySet<string> = new Set(),
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
      if (!valuedOptions.has(name) && !flagOptions.has(name)) {
        throw new Error(`Unknown option '--${name}'.`);
      }
      if (flagOptions.has(name)) {
        if (equals >= 0) {
          throw new Error(`Flag '--${name}' does not accept a value.`);
        }
        if (options.has(name)) {
          throw new Error(`Option '--${name}' may only be supplied once.`);
        }
        options.set(name, "true");
        continue;
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

function loopbackPortOption(
  options: ReadonlyMap<string, string>,
): number | undefined {
  const value = options.get("port");
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 0 ||
    parsed > 65_535
  ) {
    throw new Error("--port must be 0 or an integer from 1 to 65535.");
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

function analysisOptions(
  options: ReadonlyMap<string, string>,
): LocalAnalysisOptions {
  const maxRetainedFiles = positiveSafeIntegerOption(options, "max-files");
  const maxFileBytes = positiveSafeIntegerOption(options, "max-file-bytes");
  const maxTotalBytes = positiveSafeIntegerOption(options, "max-total-bytes");
  const timeoutMs = positiveSafeIntegerOption(options, "timeout-ms");
  return {
    ...(options.get("title") === undefined
      ? {}
      : { title: options.get("title")! }),
    ...(options.get("version") === undefined
      ? {}
      : { version: options.get("version")! }),
    ...(options.get("logo") === undefined
      ? {}
      : { logo: options.get("logo")! }),
    ...(maxRetainedFiles === undefined ? {} : { maxRetainedFiles }),
    ...(maxFileBytes === undefined ? {} : { maxFileBytes }),
    ...(maxTotalBytes === undefined ? {} : { maxTotalBytes }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
}

async function analyzeCommand(
  args: readonly string[],
  io: CliIo,
  analyze: typeof analyzeLocalRepositories,
): Promise<void> {
  const parsed = parseArguments(args, new Set(ANALYSIS_OPTIONS));
  if (parsed.positionals.length === 0) {
    throw new Error("The analyze command requires at least one local root.");
  }
  const output = requiredOption(parsed.options, "output");
  const model = await analyze(
    parsed.positionals,
    analysisOptions(parsed.options),
  );
  await publishPrivateJson(output, model, "city model");
  io.stdout(
    `Analyzed ${model.repositories.length} root(s), ${model.modules.length} module(s), and ${model.buildings.length} source file(s).\nWrote ${path.resolve(output)}\n`,
  );
  for (const warning of model.analysis?.warnings ?? []) {
    io.stderr(`Warning: ${warning}\n`);
  }
}

async function analyzeGitHubCommand(
  args: readonly string[],
  io: CliIo,
  analyze: typeof analyzePublicGitHubRepository,
): Promise<void> {
  const parsed = parseArguments(
    args,
    new Set([...ANALYSIS_OPTIONS, "ref"]),
  );
  if (parsed.positionals.length !== 1) {
    throw new Error(
      "The analyze-github command requires exactly one public GitHub URL.",
    );
  }
  const output = requiredOption(parsed.options, "output");
  const result = await analyze(
    {
      repositoryUrl: parsed.positionals[0]!,
      ...(parsed.options.get("ref") === undefined
        ? {}
        : { ref: parsed.options.get("ref")! }),
    },
    analysisOptions(parsed.options),
  );
  await publishPrivateJson(output, result.model, "city model");
  io.stdout(
    `Analyzed ${result.canonicalRepositoryUrl} at ${result.commitSha} with ${result.model.modules.length} module(s) and ${result.model.buildings.length} source file(s).\nWrote ${path.resolve(output)}\n`,
  );
  for (const warning of result.model.analysis?.warnings ?? []) {
    io.stderr(`Warning: ${warning}\n`);
  }
}

async function analyzeGenericGitCommand(
  args: readonly string[],
  io: CliIo,
  analyze: typeof analyzeGenericGitRepository,
): Promise<void> {
  const parsed = parseArguments(
    args,
    new Set([
      ...ANALYSIS_OPTIONS,
      "ref",
      "trusted-workspace-parent",
    ]),
  );
  if (parsed.positionals.length !== 1) {
    throw new Error(
      "The analyze-git command requires exactly one Git remote.",
    );
  }
  const output = requiredOption(parsed.options, "output");
  const request = {
    repositoryUrl: parsed.positionals[0]!,
    ...(parsed.options.get("ref") === undefined
      ? {}
      : { ref: parsed.options.get("ref")! }),
  };
  const options = analysisOptions(parsed.options);
  const configuredParent = parsed.options.get(
    "trusted-workspace-parent",
  );
  if (
    configuredParent !== undefined &&
    (configuredParent.length === 0 ||
      configuredParent.includes("\0"))
  ) {
    throw new Error(
      "--trusted-workspace-parent must name an existing pre-secured private directory.",
    );
  }
  const result =
    configuredParent === undefined
      ? await analyze(request, options)
      : await analyze(request, options, {
          temporaryWorkspaceOptions: {
            trustedPrivateParent: {
              directory: path.resolve(configuredParent),
              windowsAclProtection:
                GENERIC_GIT_PRESECURED_WINDOWS_ACL,
              canonicalAncestryProtection:
                GENERIC_GIT_PRESECURED_CANONICAL_ANCESTRY,
            },
          },
        });
  await publishPrivateJson(output, result.model, "city model");
  io.stdout(
    `Analyzed remote repository ${result.repository} at ${result.commitSha} with ${result.model.modules.length} module(s) and ${result.model.buildings.length} source file(s).\nWrote ${path.resolve(output)}\n`,
  );
  for (const warning of result.model.analysis?.warnings ?? []) {
    io.stderr(`Warning: ${warning}\n`);
  }
}

async function openCommand(args: readonly string[], io: CliIo): Promise<void> {
  const parsed = parseArguments(
    args,
    new Set([
      "port",
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
    throw new Error("The open command requires at least one local root.");
  }
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
  const port = loopbackPortOption(parsed.options);
  const analysis: LocalAnalysisOptions = {
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
  const server = await startLocalOpenServer({
    roots: parsed.positionals,
    analysis,
    ...(port === undefined ? {} : { port }),
  });
  io.stdout(`Code City viewer: ${server.url.href}\n`);
  io.stdout("Press Ctrl+C to stop the local viewer.\n");
  await server.closed;
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
      "fit",
      "max-plates",
      "labels",
      "routes",
    ]),
    new Set(["acknowledge-below-profile-scale"]),
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
  const fitPolicy = cliFitPolicy(parsed.options.get("fit"));
  const plateLimit = maximumPlateCount(
    parsed.options.get("max-plates"),
    fitPolicy,
  );
  const labelPolicy = cliLabelPolicy(parsed.options.get("labels"));
  const routePolicy = cliRoutePolicy(parsed.options.get("routes"));
  const acknowledgeBelowProfileScale = parsed.options.has(
    "acknowledge-below-profile-scale",
  );
  const model = parseCityModel(await readJson(modelPath, "city model"));
  const profile = parsePrinterProfile(
    await readJson(profilePath, "printer profile"),
  );
  const prepared = preparePrintPlateBundle({
    format,
    model,
    profile,
    options: {
      scale,
      fitPolicy,
      labelPolicy,
      routePolicy,
      includeLegend: false,
      acknowledgeBelowProfileScale,
      ...(plateLimit === undefined
        ? {}
        : { maximumPlateCount: plateLimit }),
    },
  });
  const plan = {
    schemaVersion: "1.0",
    format,
    layout: prepared.layout,
    warnings: prepared.preflight.warnings,
    unplacedObjects: prepared.preflight.unplacedObjects,
    routeOmissions: prepared.preflight.routeOmissions,
    labels: prepared.preflight.labels,
    routes: prepared.preflight.routes,
    plates: prepared.preflight.plates.map((plate) => ({
      number: plate.number,
      id: plate.id,
      fileName: plate.fileName,
      dimensions: plate.dimensions,
      utilization: plate.utilization,
      channels: plate.channelIds,
      warnings: plate.warnings,
    })),
  };
  await publishPrivateJson(output, plan, "print plate plan", {
    protectedPaths: [modelPath, profilePath],
  });
  io.stdout(
    `Planned ${prepared.layout.plates.length} ${format.toUpperCase()} print ${
      prepared.layout.plates.length === 1 ? "plate" : "plates"
    } at scale ${millimeters(prepared.layout.appliedScale)}.\nWrote ${path.resolve(output)}\n`,
  );
  printFidelitySummary(io, prepared.layout);
  io.stdout(`${labelSummary(prepared.preflight.labels)}\n`);
  io.stdout(`${routeSummary(prepared.preflight.routes)}\n`);
}

function positiveScale(value: string | undefined): number {
  const scale = value === undefined ? 1 : Number(value);
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new Error("--scale must be a positive finite number.");
  }
  return scale;
}

function cliFitPolicy(value: string | undefined): PrintFitPolicy {
  if (value === undefined || value === "error") return "error";
  if (value === "scale" || value === "tile") return value;
  throw new Error("--fit must be 'error', 'scale', or 'tile'.");
}

function maximumPlateCount(
  value: string | undefined,
  fitPolicy: PrintFitPolicy,
): number | undefined {
  if (value === undefined) return undefined;
  if (fitPolicy !== "tile") {
    throw new Error("--max-plates may only be used with --fit tile.");
  }
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 1 || count > 99) {
    throw new Error("--max-plates must be an integer between 1 and 99.");
  }
  return count;
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
  return output.replace(/\.(?:3mf|stl|zip)$/iu, ".legend.json");
}

function directPrintManifestPath(output: string): string {
  return output.replace(/\.(?:3mf|stl)$/iu, ".print-manifest.json");
}

function printFidelitySummary(
  io: CliIo,
  fidelity: {
    readonly requestedScale: number;
    readonly appliedScale: number;
    readonly minimumSafeScale: number;
    readonly belowProfileScaleAcknowledged: boolean;
    readonly featureViolations: readonly {
      readonly category: string;
      readonly resultingValue: number;
      readonly minimum: number;
    }[];
  },
): void {
  io.stdout(
    `Scale: requested ${millimeters(fidelity.requestedScale)}; applied ${millimeters(fidelity.appliedScale)}; profile-safe ${millimeters(fidelity.minimumSafeScale)}; below-profile acknowledgement ${fidelity.belowProfileScaleAcknowledged ? "yes" : "no"}.\n`,
  );
  for (const violation of fidelity.featureViolations) {
    io.stderr(
      `Warning: ${violation.category} is ${millimeters(violation.resultingValue)} mm after scaling; profile minimum is ${millimeters(violation.minimum)} mm. This is a print-fidelity risk, not a printer hardware danger.\n`,
    );
  }
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
    throw new Error("Model and legend outputs must use different paths.");
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

function calibrationManifestPath(
  output: string,
  configured: string | undefined,
): string {
  const result =
    configured ?? output.replace(/\.(?:3mf|stl)$/iu, ".manifest.json");
  if (path.extname(result).toLowerCase() !== ".json") {
    throw new Error(
      "Calibration manifest output must use the '.json' file extension.",
    );
  }
  const archivePath = path.resolve(output);
  const manifestPath = path.resolve(result);
  const comparable = (value: string) =>
    process.platform === "win32" ? value.toLowerCase() : value;
  if (comparable(archivePath) === comparable(manifestPath)) {
    throw new Error(
      "Calibration model and manifest outputs must use different paths.",
    );
  }
  return result;
}

function cliPrintFormat(value: string | undefined): PrintFormat {
  if (value !== "3mf" && value !== "stl") {
    throw new Error("--format must be either 'stl' or '3mf'.");
  }
  return value;
}

function requireMatchingOutputExtension(
  output: string,
  format: PrintFormat,
  description: string,
): void {
  const expected = `.${format}`;
  if (path.extname(output).toLowerCase() !== expected) {
    throw new Error(
      `${description} ${format.toUpperCase()} output must use the '${expected}' file extension.`,
    );
  }
}

async function calibrateCommand(
  args: readonly string[],
  io: CliIo,
): Promise<void> {
  const parsed = parseArguments(
    args,
    new Set(["profile", "output", "format", "manifest"]),
  );
  if (parsed.positionals.length > 0) {
    throw new Error(
      `Unexpected calibrate argument '${parsed.positionals[0]}'. Use named options.`,
    );
  }
  const profilePath = requiredOption(parsed.options, "profile");
  const output = requiredOption(parsed.options, "output");
  const format = cliPrintFormat(parsed.options.get("format") ?? "3mf");
  requireMatchingOutputExtension(output, format, "Calibration");
  const manifestOutput = calibrationManifestPath(
    output,
    parsed.options.get("manifest"),
  );
  const exported = generateCalibrationPrintExport({
    profile: await readJson(profilePath, "printer profile"),
    format,
  });
  const published = await publishArtifactsAtomically(
    [
      { destination: output, bytes: exported.artifact.bytes },
      {
        destination: manifestOutput,
        bytes: exported.manifestBytes,
        mode: 0o600,
      },
    ],
    { protectedPaths: [profilePath] },
  );
  const size = exported.preflight.dimensions;
  io.stdout(
    `Exported calibration ${format.toUpperCase()} with ${exported.preflight.partCount} aligned part(s), ${exported.preflight.triangleCount} triangle(s), across ${exported.preflight.channelCount} channel(s) at ${millimeters(size.x)} × ${millimeters(size.y)} × ${millimeters(size.z)} mm.\n`,
  );
  io.stdout(`Wrote ${published[0]}\nWrote ${published[1]}\n`);
  for (const warning of exported.preflight.warnings) {
    io.stderr(`Warning: ${warning}\n`);
  }
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
  const publishedPaths = await publishArtifactsAtomically(
    [
      {
        destination: output,
        bytes: serializeThreeMf(comparison.printable),
      },
      {
        destination: instructionsOutput,
        bytes: new TextEncoder().encode(comparison.instructions),
      },
    ],
    { protectedPaths: [profilePath] },
  );
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
      "fit",
      "max-plates",
      "labels",
      "routes",
      "legend",
    ]),
    new Set(["acknowledge-below-profile-scale"]),
  );
  if (parsed.positionals.length > 0) {
    throw new Error(
      `Unexpected export argument '${parsed.positionals[0]}'. Use named options.`,
    );
  }
  const modelPath = requiredOption(parsed.options, "model");
  const profilePath = requiredOption(parsed.options, "profile");
  const format = cliPrintFormat(
    requiredOption(parsed.options, "format"),
  );
  const output = requiredOption(parsed.options, "output");
  const scale = positiveScale(parsed.options.get("scale"));
  const fitPolicy = cliFitPolicy(parsed.options.get("fit"));
  const plateLimit = maximumPlateCount(
    parsed.options.get("max-plates"),
    fitPolicy,
  );
  const labelPolicy = cliLabelPolicy(parsed.options.get("labels"));
  const routePolicy = cliRoutePolicy(parsed.options.get("routes"));
  const acknowledgeBelowProfileScale = parsed.options.has(
    "acknowledge-below-profile-scale",
  );
  if (fitPolicy === "error") {
    requireMatchingOutputExtension(output, format, "Export");
  } else if (path.extname(output).toLowerCase() !== ".zip") {
    throw new Error(
      `Export with --fit ${fitPolicy} writes a multi-file bundle and must use the '.zip' file extension.`,
    );
  }
  const companionOutput = legendPath(
    output,
    parsed.options.get("legend"),
  );

  const model = parseCityModel(await readJson(modelPath, "city model"));
  const profile = parsePrinterProfile(
    await readJson(profilePath, "printer profile"),
  );
  const prepared = preparePrintPlateBundle({
    format,
    model,
    profile,
    options: {
      scale,
      fitPolicy,
      labelPolicy,
      routePolicy,
      includeLegend: companionOutput !== undefined,
      acknowledgeBelowProfileScale,
      ...(plateLimit === undefined
        ? {}
        : { maximumPlateCount: plateLimit }),
    },
  });
  if (fitPolicy !== "error") {
    const exported = serializePreparedPrintPlateBundle(prepared);
    const publishedPaths = await publishArtifactsAtomically(
      [
        { destination: output, bytes: exported.bytes },
        ...(companionOutput === undefined
          ? []
          : [
              {
                destination: companionOutput,
                bytes: exported.legendBytes!,
                mode: 0o600,
              },
            ]),
      ],
      { protectedPaths: [modelPath, profilePath] },
    );
    io.stdout(
      `Exported ${exported.manifest.plateCount} ${format.toUpperCase()} print ${
        exported.manifest.plateCount === 1 ? "plate" : "plates"
      } at applied scale ${millimeters(exported.layout.appliedScale)}.\n`,
    );
    printFidelitySummary(io, exported.layout);
    for (const plate of exported.manifest.plates) {
      const size = plate.preflight.dimensions;
      io.stdout(
        `Plate ${plate.number}: ${plate.file} · ${millimeters(size.width)} × ${millimeters(size.depth)} × ${millimeters(size.height)} mm · ${Math.round(plate.layout.utilization * 100)}% used.\n`,
      );
    }
    io.stdout(`Wrote ${publishedPaths[0]}\n`);
    if (publishedPaths[1] !== undefined) {
      io.stdout(`Wrote ${publishedPaths[1]}\n`);
    } else {
      io.stdout("Legend output disabled.\n");
    }
    io.stdout(
      `Route omissions: ${exported.manifest.routeOmissionSummary.count}; unplaced objects: ${exported.manifest.unplacedObjects.length}.\n`,
    );
    for (const warning of exported.manifest.warnings) {
      io.stderr(`Warning: ${warning}\n`);
    }
    return;
  }
  const exported = serializePreparedSinglePrintPlateExport(prepared);
  const manifestOutput = directPrintManifestPath(output);
  const publishedPaths = await publishArtifactsAtomically(
    [
      { destination: output, bytes: exported.artifact.bytes },
      {
        destination: manifestOutput,
        bytes: exported.manifestBytes,
        mode: 0o600,
      },
      ...(companionOutput === undefined
        ? []
        : [
            {
              destination: companionOutput,
              bytes: exported.legendBytes!,
              mode: 0o600,
            },
          ]),
    ],
    { protectedPaths: [modelPath, profilePath] },
  );
  const absoluteOutput = publishedPaths[0]!;
  const absoluteManifest = publishedPaths[1]!;
  const absoluteLegend = publishedPaths[2];
  const plate = exported.preflight.plates[0]!;
  const bounds = plate.dimensions;
  io.stdout(
    `Exported 1 ${format.toUpperCase()} print plate at applied scale ${millimeters(exported.layout.appliedScale)}.\n`,
  );
  printFidelitySummary(io, exported.layout);
  io.stdout(
    `Plate 1: ${path.basename(output)} · ${millimeters(bounds.width)} × ${millimeters(bounds.depth)} × ${millimeters(bounds.height)} mm · ${Math.round(plate.utilization * 100)}% used.\n`,
  );
  io.stdout(`Wrote ${absoluteOutput}\nWrote ${absoluteManifest}\n`);
  if (absoluteLegend !== undefined) {
    io.stdout(`Wrote ${absoluteLegend}\n`);
  } else {
    io.stdout("Legend output disabled.\n");
  }
  io.stdout(`${labelSummary(exported.preflight.labels)}\n`);
  io.stdout(`${routeSummary(exported.preflight.routes)}\n`);
  io.stdout(
    `Route omissions: ${exported.preflight.routeOmissions.length}; unplaced objects: ${exported.preflight.unplacedObjects.length}.\n`,
  );
  for (const warning of exported.preflight.warnings) {
    io.stderr(`Warning: ${warning}\n`);
  }
}

export async function runCli(
  args: readonly string[],
  io: CliIo = defaultIo,
  dependencies: CliDependencies = {},
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
      await analyzeCommand(
        args.slice(1),
        io,
        dependencies.analyzeLocalRepositories ?? analyzeLocalRepositories,
      );
    } else if (command === "analyze-github") {
      await analyzeGitHubCommand(
        args.slice(1),
        io,
        dependencies.analyzePublicGitHubRepository ??
          analyzePublicGitHubRepository,
      );
    } else if (command === "analyze-git") {
      await analyzeGenericGitCommand(
        args.slice(1),
        io,
        dependencies.analyzeGenericGitRepository ??
          analyzeGenericGitRepository,
      );
    } else if (command === "open") {
      await openCommand(args.slice(1), io);
    } else if (command === "plan") {
      await planCommand(args.slice(1), io);
    } else if (command === "export") {
      await exportCommand(args.slice(1), io);
    } else if (command === "calibrate") {
      await calibrateCommand(args.slice(1), io);
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
