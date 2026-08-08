import path from "node:path";

import { parse as parseJsonc, type ParseError } from "jsonc-parser";

import type {
  CityDependency,
  CityIdentity,
  CityModule,
  CityRepository,
  CitySolution,
  ExecutableUnitDecisionEvidence,
  IdentityLogo,
  SourceLanguage,
  SourceMetrics,
  SourceStructure,
} from "../../core/src/model.js";
import { normalizeCityIdentity } from "../../core/src/identity.js";
import { classifyRisk } from "../../core/src/metrics.js";
import { CITY_MODEL_LIMITS } from "../../core/src/model-validation.js";
import { normalizePath, stableId } from "../../core/src/path.js";
import { semanticGroupForRisk } from "../../core/src/semantics.js";
import {
  compareStable,
  isSourceFile,
} from "./filesystem.js";
import { materializeLocalRepositorySnapshots } from "./local-snapshot.js";
import {
  analyzeCSharpWithRoslyn,
  resolveBundledRoslynLaunch,
  ROSLYN_HOST_LIMITS,
  type RoslynFileOutcome,
} from "./roslyn-host.js";
import {
  safeRelativeInputPath,
  safeRepositoryRelativePath,
  sanitizeDisplayText,
  sanitizeExternalReference,
  sanitizeImportSpecifier,
  sanitizeVersionText,
  sanitizeWarningText,
} from "./sanitization.js";
import type {
  RepositorySnapshot,
  SnapshotDiagnosticCode,
} from "./snapshot.js";
import {
  assertRepositorySnapshots,
  DEFAULT_SNAPSHOT_LIMITS,
  SnapshotDeadlineError,
  SnapshotLimitError,
} from "./snapshot.js";
import type {
  LocalAnalysisFacts,
  LocalAnalysisOptions,
  SourceFileFact,
  StaticImportFact,
} from "./types.js";
import {
  acquireLocalLogoPrintRelief,
} from "./local-logo-relief.js";
import { analyzeParsedTypeScriptSource } from "./typescript-metrics.js";
import {
  TypeScriptWorkspace,
  type TypeScriptWorkspaceFile,
} from "./typescript-workspace.js";
import {
  HistorySourceAnalysisCache,
  type SourceAnalysisDetailLevel,
  type SourceAnalysisLanguageMode,
  type UnboundSourceAnalysis,
} from "./source-analysis-cache.js";

interface RootContext {
  readonly virtualRoot: string;
  readonly repository: CityRepository;
  readonly files: readonly string[];
  readonly textByPath: ReadonlyMap<string, string>;
}

interface ProjectReference {
  readonly include?: string;
  readonly externalTarget: string;
}

interface PackageReference {
  readonly packageId: string;
  readonly version?: string;
}

interface InternalModule {
  module: CityModule;
  readonly rootPath: string;
  readonly projectFile?: string;
  readonly projectReferences: readonly ProjectReference[];
  readonly packageReferences: readonly PackageReference[];
}

interface PendingSource {
  readonly virtualPath: string;
  readonly repositoryRoot: string;
  readonly fact: SourceFileFact;
  readonly imports: readonly StaticImportFact[];
}

interface AnalysisGuard {
  check(): void;
  remainingMs(): number;
  readonly signal?: AbortSignal;
}

interface ModuleDiscoveryBudget {
  count: number;
}

interface ModuleRootCandidates {
  readonly dotnetProjects: InternalModule[];
  readonly angularProjects: InternalModule[];
  readonly npmPackages: InternalModule[];
}

type ModuleRootIndex = ReadonlyMap<string, ModuleRootCandidates>;

const VIRTUAL_WORKSPACE_ROOT = "/code-city";
const NPM_LOGICAL_NAME_MAX_CHARACTERS = 214;
const NPM_SCOPED_LOGICAL_NAME =
  /^(?:@([^/]+?)\/)?([^/]+?)$/u;
const NPM_SPECIAL_PACKAGE_SEGMENT_CHARACTER = /[~'!()*]/u;
const NPM_BUILTIN_LOGICAL_NAMES = new Set([
  "_http_agent",
  "_http_client",
  "_http_common",
  "_http_incoming",
  "_http_outgoing",
  "_http_server",
  "_stream_duplex",
  "_stream_passthrough",
  "_stream_readable",
  "_stream_transform",
  "_stream_wrap",
  "_stream_writable",
  "_tls_common",
  "_tls_wrap",
  "assert",
  "assert/strict",
  "async_hooks",
  "buffer",
  "child_process",
  "cluster",
  "console",
  "constants",
  "crypto",
  "dgram",
  "diagnostics_channel",
  "dns",
  "dns/promises",
  "domain",
  "events",
  "fs",
  "fs/promises",
  "http",
  "http2",
  "https",
  "inspector",
  "inspector/promises",
  "module",
  "net",
  "node:sea",
  "node:sqlite",
  "node:test",
  "node:test/reporters",
  "os",
  "path",
  "path/posix",
  "path/win32",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "readline",
  "readline/promises",
  "repl",
  "stream",
  "stream/consumers",
  "stream/promises",
  "stream/web",
  "string_decoder",
  "sys",
  "timers",
  "timers/promises",
  "tls",
  "trace_events",
  "tty",
  "url",
  "util",
  "util/types",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
  "zlib",
]);
const DECISION_EVIDENCE_TRUNCATED_REASON =
  "Decision-site evidence was truncated by analyzer retention limits.";
const DECISION_EVIDENCE_OMITTED_WARNING =
  "Executable-unit decision evidence was omitted after serialized evidence limits were reached.";

function consumeModuleDiscoveryBudget(budget: ModuleDiscoveryBudget): void {
  const actual = budget.count + 1;
  if (actual > CITY_MODEL_LIMITS.modules) {
    throw new SnapshotLimitError(
      "modules",
      CITY_MODEL_LIMITS.modules,
      actual,
    );
  }
  budget.count = actual;
}

function retainedDecisionEvidence(
  evidence: ExecutableUnitDecisionEvidence,
  retainedSiteCount: number,
): ExecutableUnitDecisionEvidence {
  if (
    evidence.status === "unavailable" ||
    retainedSiteCount >= evidence.sites.length
  ) {
    return evidence;
  }
  const sites = Object.freeze(evidence.sites.slice(0, retainedSiteCount));
  const retainedContribution = sites.reduce(
    (total, site) => total + site.contribution,
    0,
  );
  return Object.freeze({
    version: evidence.version,
    unitId: evidence.unitId,
    scope: evidence.scope,
    ...(evidence.callableId === undefined
      ? {}
      : { callableId: evidence.callableId }),
    status: "truncated" as const,
    totalContribution: evidence.totalContribution,
    omittedContribution:
      evidence.totalContribution - retainedContribution,
    reason: DECISION_EVIDENCE_TRUNCATED_REASON,
    sites,
  });
}

function serializedEvidenceBytes(
  evidence: ExecutableUnitDecisionEvidence,
): number {
  return new TextEncoder().encode(JSON.stringify(evidence)).byteLength;
}

function fitDecisionEvidence(
  evidence: ExecutableUnitDecisionEvidence,
  retainedSiteLimit: number,
  serializedByteLimit: number,
): {
  readonly evidence?: ExecutableUnitDecisionEvidence;
  readonly bytes: number;
} {
  const maximumSites = Math.min(evidence.sites.length, retainedSiteLimit);
  let candidate = retainedDecisionEvidence(evidence, maximumSites);
  let bytes = serializedEvidenceBytes(candidate);
  if (bytes <= serializedByteLimit) return { evidence: candidate, bytes };
  if (evidence.status === "unavailable") return { bytes: 0 };

  let lower = 0;
  let upper = maximumSites - 1;
  let retained: ExecutableUnitDecisionEvidence | undefined;
  let retainedBytes = 0;
  while (lower <= upper) {
    const middle = Math.floor((lower + upper) / 2);
    candidate = retainedDecisionEvidence(evidence, middle);
    bytes = serializedEvidenceBytes(candidate);
    if (bytes <= serializedByteLimit) {
      retained = candidate;
      retainedBytes = bytes;
      lower = middle + 1;
    } else {
      upper = middle - 1;
    }
  }
  return retained === undefined
    ? { bytes: 0 }
    : { evidence: retained, bytes: retainedBytes };
}

function boundProjectDecisionEvidence(
  sources: readonly PendingSource[],
  warnings: string[],
): readonly PendingSource[] {
  let remainingSites = CITY_MODEL_LIMITS.decisionSitesPerModel;
  let remainingBytes = CITY_MODEL_LIMITS.decisionEvidenceBytesPerModel;
  let omittedUnits = 0;
  const bounded = sources.map((source) => {
    let remainingBuildingSites =
      CITY_MODEL_LIMITS.decisionSitesPerBuilding;
    let remainingBuildingBytes =
      CITY_MODEL_LIMITS.decisionEvidenceBytesPerBuilding;
    return {
      ...source,
      fact: {
        ...source.fact,
        units: source.fact.units.map((unit) => {
          const evidence = unit.decisionEvidence;
          if (evidence === undefined) return unit;
          const retainedSiteLimit = Math.min(
            remainingSites,
            remainingBuildingSites,
          );
          const serializedByteLimit = Math.min(
            CITY_MODEL_LIMITS.decisionEvidenceBytesPerUnit,
            remainingBytes,
            remainingBuildingBytes,
          );
          const fitted = fitDecisionEvidence(
            evidence,
            retainedSiteLimit,
            serializedByteLimit,
          );
          if (fitted.evidence === undefined) {
            omittedUnits += 1;
            const { decisionEvidence: _omitted, ...aggregateOnly } = unit;
            return aggregateOnly;
          }
          remainingSites -= fitted.evidence.sites.length;
          remainingBuildingSites -= fitted.evidence.sites.length;
          remainingBytes -= fitted.bytes;
          remainingBuildingBytes -= fitted.bytes;
          if (fitted.evidence === evidence) return unit;
          return {
            ...unit,
            decisionEvidence: fitted.evidence,
          };
        }),
      },
    };
  });
  if (omittedUnits > 0) {
    warnings.push(
      sanitizeWarningText(
        `${DECISION_EVIDENCE_OMITTED_WARNING} Omitted units: ${omittedUnits}.`,
      ),
    );
  }
  return bounded;
}

function portableSegment(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  const leaf = normalized.split("/").filter(Boolean).at(-1) ?? "repository";
  return leaf === "." || leaf === ".." ? `repository-${leaf.length}` : leaf;
}

function virtualPath(...parts: readonly string[]): string {
  return path.posix.resolve(
    ...parts.map((part) => part.replaceAll("\\", "/")),
  );
}

function virtualKey(value: string): string {
  return virtualPath(value);
}

function virtualIsWithin(parent: string, candidate: string): boolean {
  const relative = path.posix.relative(
    virtualPath(parent),
    virtualPath(candidate),
  );
  return (
    relative === "" ||
    (!relative.startsWith("../") &&
      relative !== ".." &&
      !path.posix.isAbsolute(relative))
  );
}

function virtualRelative(root: string, candidate: string): string {
  if (!virtualIsWithin(root, candidate)) {
    throw new Error("Snapshot path escapes its repository.");
  }
  return path.posix.relative(virtualPath(root), virtualPath(candidate)) || ".";
}

function snapshotText(context: RootContext, filePath: string): string {
  const text = context.textByPath.get(virtualKey(filePath));
  if (text === undefined) {
    throw new Error("Snapshot file was not admitted.");
  }
  return text;
}

function snapshotOrderKey(snapshot: RepositorySnapshot): string {
  return snapshot.files
    .map((file) => `${file.path}\u0000${file.byteLength}`)
    .join("\u0001");
}

const SNAPSHOT_WARNING_TEXT: Readonly<Record<SnapshotDiagnosticCode, string>> = {
  binary: "Binary or invalid UTF-8 source skipped.",
  "diagnostics-omitted": "Additional snapshot diagnostics were omitted.",
  "invalid-size": "Source with invalid declared size skipped.",
  oversized: "Source exceeding the per-file limit skipped.",
  "symlink-skipped": "Symbolic link skipped.",
  unreadable: "Unreadable source skipped.",
};

function orderedSnapshots(
  snapshots: readonly RepositorySnapshot[],
): readonly RepositorySnapshot[] {
  return [...snapshots].sort(
    (left, right) =>
      compareStable(left.name, right.name) ||
      compareStable(snapshotOrderKey(left), snapshotOrderKey(right)),
  );
}

function createAnalysisGuard(options: LocalAnalysisOptions): AnalysisGuard {
  const deadline =
    Date.now() + (options.timeoutMs ?? DEFAULT_SNAPSHOT_LIMITS.timeoutMs);
  return {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    check(): void {
      if (options.signal?.aborted) {
        throw new SnapshotDeadlineError(
          "Repository snapshot analysis was aborted.",
        );
      }
      if (Date.now() >= deadline) {
        throw new SnapshotDeadlineError(
          "Repository snapshot analysis exceeded its deadline.",
        );
      }
    },
    remainingMs(): number {
      this.check();
      return Math.max(1, deadline - Date.now());
    },
  };
}

function boundedWarnings(warnings: readonly string[]): readonly string[] {
  const ordered = [...new Set(warnings)].sort(compareStable);
  if (ordered.length <= CITY_MODEL_LIMITS.warnings) return ordered;
  return [
    ...ordered.slice(0, CITY_MODEL_LIMITS.warnings - 1),
    "Additional analyzer warnings were omitted.",
  ];
}

function decodeXml(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function withoutXmlMetadataText(xml: string): string {
  return xml
    .replace(/<!--[\s\S]*?-->/gu, "")
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/gu, "");
}

function xmlTagEnd(xml: string, start: number): number {
  let quote: "'" | '"' | undefined;
  for (let index = start; index < xml.length; index += 1) {
    const character = xml[index];
    if (quote) {
      if (character === quote) quote = undefined;
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (character === ">") {
      return index;
    }
  }
  return -1;
}

function validXmlAttributes(value: string): boolean {
  const names = new Set<string>();
  let cursor = 0;
  while (cursor < value.length) {
    while (/\s/u.test(value[cursor] ?? "")) cursor += 1;
    if (cursor >= value.length) return true;
    const nameMatch = /^[A-Za-z_][A-Za-z0-9_.:-]*/u.exec(
      value.slice(cursor),
    );
    if (!nameMatch || names.has(nameMatch[0])) return false;
    names.add(nameMatch[0]);
    cursor += nameMatch[0].length;
    while (/\s/u.test(value[cursor] ?? "")) cursor += 1;
    if (value[cursor] !== "=") return false;
    cursor += 1;
    while (/\s/u.test(value[cursor] ?? "")) cursor += 1;
    const quote = value[cursor];
    if (quote !== "'" && quote !== '"') return false;
    cursor += 1;
    const end = value.indexOf(quote, cursor);
    if (end < 0 || value.slice(cursor, end).includes("<")) return false;
    cursor = end + 1;
  }
  return true;
}

/**
 * Conservative XML structure check for static project metadata. It performs no
 * entity expansion, schema evaluation, imports, or filesystem access.
 */
function wellFormedXmlDocument(xml: string, expectedRoot: string): boolean {
  const text = xml.replace(/^\uFEFF/u, "");
  const stack: string[] = [];
  let rootSeen = false;
  let rootClosed = false;
  let cursor = 0;

  while (cursor < text.length) {
    const opening = text.indexOf("<", cursor);
    if (opening < 0) {
      return stack.length === 0 && text.slice(cursor).trim() === "" && rootSeen;
    }
    if (
      stack.length === 0 &&
      (rootClosed || !rootSeen) &&
      text.slice(cursor, opening).trim() !== ""
    ) {
      return false;
    }
    if (text.startsWith("<!--", opening)) {
      const end = text.indexOf("-->", opening + 4);
      if (end < 0) return false;
      cursor = end + 3;
      continue;
    }
    if (text.startsWith("<?", opening)) {
      const end = text.indexOf("?>", opening + 2);
      if (end < 0 || rootClosed) return false;
      cursor = end + 2;
      continue;
    }
    if (text.startsWith("<![CDATA[", opening)) {
      const end = text.indexOf("]]>", opening + 9);
      if (end < 0 || stack.length === 0) return false;
      cursor = end + 3;
      continue;
    }
    if (text.startsWith("<!", opening)) return false;

    const end = xmlTagEnd(text, opening + 1);
    if (end < 0) return false;
    let tag = text.slice(opening + 1, end).trim();
    const closing = tag.startsWith("/");
    if (closing) tag = tag.slice(1).trim();
    const selfClosing = !closing && tag.endsWith("/");
    if (selfClosing) tag = tag.slice(0, -1).trim();
    const match = /^([A-Za-z_][A-Za-z0-9_.:-]*)([\s\S]*)$/u.exec(tag);
    if (!match || match[2]!.includes("<")) return false;
    const name = match[1]!;

    if (closing) {
      if (match[2]!.trim() !== "" || stack.pop() !== name) return false;
      if (stack.length === 0) rootClosed = true;
    } else {
      if (!validXmlAttributes(match[2]!)) return false;
      if (stack.length === 0) {
        if (rootSeen || rootClosed || name !== expectedRoot) return false;
        rootSeen = true;
      }
      if (!selfClosing) stack.push(name);
      else if (stack.length === 0) rootClosed = true;
    }
    cursor = end + 1;
  }
  return rootSeen && rootClosed && stack.length === 0;
}

function firstElement(xml: string, element: string): string | undefined {
  const match = new RegExp(
    `<${element}\\b[^>]*>([\\s\\S]*?)<\\/${element}>`,
    "iu",
  ).exec(xml);
  const value = match?.[1]?.trim();
  return value ? decodeXml(value) : undefined;
}

function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(
    `\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`,
    "iu",
  ).exec(tag);
  const value = match?.[1] ?? match?.[2];
  return value === undefined ? undefined : decodeXml(value);
}

function parseProjectReferences(xml: string): readonly ProjectReference[] {
  const references: ProjectReference[] = [];
  for (const match of xml.matchAll(/<ProjectReference\b[^>]*>/giu)) {
    const rawInclude = attribute(match[0], "Include");
    if (rawInclude) {
      let include: string | undefined;
      try {
        include = safeRelativeInputPath(rawInclude);
      } catch {
        // Absolute, URI, control-bearing, and oversized references are display
        // data only. They are never used for virtual path resolution.
      }
      references.push({
        ...(include === undefined ? {} : { include }),
        externalTarget: sanitizeExternalReference(
          rawInclude,
          "unresolved-project",
        ),
      });
    }
  }
  return references.sort((left, right) =>
    compareStable(left.externalTarget, right.externalTarget),
  );
}

function parsePackageReferences(xml: string): readonly PackageReference[] {
  const references: PackageReference[] = [];
  const expression =
    /<PackageReference\b([^>]*?)(?:\/>|>([\s\S]*?)<\/PackageReference>)/giu;
  for (const match of xml.matchAll(expression)) {
    const opening = match[1] ?? "";
    const packageId =
      attribute(opening, "Include") ?? attribute(opening, "Update");
    if (!packageId) continue;
    const version =
      attribute(opening, "Version") ??
      (match[2] ? firstElement(match[2], "Version") : undefined);
    references.push({
      packageId: sanitizeExternalReference(packageId, "external-package"),
      ...(version === undefined
        ? {}
        : { version: sanitizeVersionText(version) }),
    });
  }
  return references.sort(
    (left, right) =>
      compareStable(left.packageId, right.packageId) ||
      compareStable(left.version ?? "", right.version ?? ""),
  );
}

function targetFrameworks(xml: string): readonly string[] {
  const frameworks =
    firstElement(xml, "TargetFrameworks") ?? firstElement(xml, "TargetFramework");
  return frameworks
    ? frameworks
        .split(";")
        .map((framework) =>
          sanitizeExternalReference(framework, "unknown-framework"),
        )
        .filter(Boolean)
        .sort(compareStable)
    : [];
}

function createRepositories(
  snapshots: readonly RepositorySnapshot[],
): readonly CityRepository[] {
  const occurrences = new Map<string, number>();
  return snapshots.map((snapshot) => {
    const name = sanitizeDisplayText(snapshot.name, "Repository");
    const nameKey = name.toLocaleLowerCase("en-US");
    const occurrence = (occurrences.get(nameKey) ?? 0) + 1;
    occurrences.set(nameKey, occurrence);
    return {
      id: stableId("repository", name, String(occurrence)),
      name,
    };
  });
}

async function discoverDotnetModules(
  context: RootContext,
  warnings: string[],
  guard: AnalysisGuard,
  budget: ModuleDiscoveryBudget,
): Promise<readonly InternalModule[]> {
  const projectFiles = context.files.filter(
    (file) =>
      path.posix.extname(file).toLocaleLowerCase("en-US") === ".csproj",
  );
  const modules: InternalModule[] = [];
  for (const projectFile of projectFiles) {
    guard.check();
    const rawXml = snapshotText(context, projectFile);
    const relativeProject = safeRepositoryRelativePath(
      virtualRelative(context.virtualRoot, projectFile),
    );
    if (!wellFormedXmlDocument(rawXml, "Project")) {
      warnings.push(
        sanitizeWarningText(
          `${relativeProject}: malformed .csproj file skipped`,
        ),
      );
      continue;
    }
    const xml = withoutXmlMetadataText(rawXml);
    const frameworks = targetFrameworks(xml);
    const moduleName = sanitizeDisplayText(
      firstElement(xml, "AssemblyName") ??
        path.posix.basename(
          projectFile,
          path.posix.extname(projectFile),
        ),
      "Unnamed project",
    );
    // NuGet defaults PackageId to AssemblyName/project name. Retaining the
    // effective id lets separately supplied roots reconnect package bridges.
    const packageId = sanitizeExternalReference(
      firstElement(xml, "PackageId") ?? moduleName,
      moduleName,
    );
    const module: CityModule = {
      id: stableId(
        "module",
        context.repository.id,
        "dotnet-project",
        relativeProject,
      ),
      repositoryId: context.repository.id,
      kind: "dotnet-project",
      name: moduleName,
      path: relativeProject,
      solutionIds: [],
      ...(frameworks.length === 0 ? {} : { targetFrameworks: frameworks }),
      ...(packageId === undefined ? {} : { packageId }),
    };
    consumeModuleDiscoveryBudget(budget);
    modules.push({
      module,
      rootPath: path.posix.dirname(projectFile),
      projectFile,
      projectReferences: parseProjectReferences(xml),
      packageReferences: parsePackageReferences(xml),
    });
  }
  return modules;
}

function parseJsonFile(
  text: string,
): Record<string, unknown> | undefined {
  const errors: ParseError[] = [];
  const result: unknown = parseJsonc(text, errors, {
    allowEmptyContent: false,
    allowTrailingComma: true,
    disallowComments: false,
  });
  return errors.length === 0 && jsonObject(result)
    ? result
    : undefined;
}

function jsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyJsonString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function urlComponentIsStable(value: string): boolean {
  try {
    return encodeURIComponent(value) === value;
  } catch {
    return false;
  }
}

function npmLogicalName(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.startsWith(".") ||
    value.startsWith("-") ||
    value.startsWith("_") ||
    value.length > NPM_LOGICAL_NAME_MAX_CHARACTERS ||
    value !== value.trim() ||
    value.toLowerCase() !== value
  ) {
    return undefined;
  }
  const folded = value.toLowerCase();
  if (
    folded === "node_modules" ||
    folded === "favicon.ico" ||
    NPM_BUILTIN_LOGICAL_NAMES.has(folded)
  ) {
    return undefined;
  }
  const packageSegment = value.split("/").at(-1)!;
  if (NPM_SPECIAL_PACKAGE_SEGMENT_CHARACTER.test(packageSegment)) {
    return undefined;
  }
  if (urlComponentIsStable(value)) return value;

  const scoped = NPM_SCOPED_LOGICAL_NAME.exec(value);
  const scope = scoped?.[1];
  const scopedPackage = scoped?.[2];
  if (
    scope === undefined ||
    scopedPackage === undefined ||
    scopedPackage.startsWith(".") ||
    !urlComponentIsStable(scope) ||
    !urlComponentIsStable(scopedPackage)
  ) {
    return undefined;
  }
  return value;
}

function parseNpmPackageReferences(
  manifest: Readonly<Record<string, unknown>>,
): readonly PackageReference[] {
  const references = new Map<string, PackageReference>();
  const sections = [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
  ] as const;
  for (const section of sections) {
    const entries = manifest[section];
    if (!jsonObject(entries)) continue;
    for (const rawPackageId of Object.keys(entries).sort(compareStable)) {
      const rawVersion = entries[rawPackageId];
      const packageId = npmLogicalName(rawPackageId);
      if (packageId === undefined || !nonEmptyJsonString(rawVersion)) continue;
      const version = sanitizeVersionText(rawVersion);
      const key = `${packageId.toLocaleLowerCase("en-US")}\u0000${version}`;
      if (!references.has(key)) {
        references.set(key, { packageId, version });
      }
    }
  }
  return [...references.values()].sort(
    (left, right) =>
      compareStable(left.packageId, right.packageId) ||
      compareStable(left.version ?? "", right.version ?? ""),
  );
}

function parsePackageManifest(
  text: string,
): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text.replace(/^\uFEFF/u, ""));
    return jsonObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function discoverNpmModules(
  context: RootContext,
  warnings: string[],
  guard: AnalysisGuard,
  budget: ModuleDiscoveryBudget,
): Promise<readonly InternalModule[]> {
  const manifestFiles = context.files
    .filter(
      (file) =>
        path.posix.basename(file).toLocaleLowerCase("en-US") ===
        "package.json",
    )
    .sort(compareStable);
  const modules: InternalModule[] = [];

  for (const manifestFile of manifestFiles) {
    guard.check();
    const relativeManifest = safeRepositoryRelativePath(
      virtualRelative(context.virtualRoot, manifestFile),
    );
    const manifest = parsePackageManifest(snapshotText(context, manifestFile));
    if (!manifest) {
      warnings.push(
        sanitizeWarningText(
          `${relativeManifest}: malformed or non-object package.json skipped`,
        ),
      );
      continue;
    }

    const moduleRoot = path.posix.dirname(manifestFile);
    const packageId = npmLogicalName(manifest["name"]);
    const fallbackName =
      moduleRoot === context.virtualRoot
        ? context.repository.name
        : path.posix.basename(moduleRoot);
    const module: CityModule = {
      id: stableId(
        "module",
        context.repository.id,
        "npm-package",
        relativeManifest,
      ),
      repositoryId: context.repository.id,
      kind: "npm-package",
      name: sanitizeDisplayText(
        packageId ?? fallbackName,
        "Unnamed npm package",
      ),
      path: relativeManifest,
      solutionIds: [],
      ...(packageId === undefined ? {} : { packageId }),
    };
    consumeModuleDiscoveryBudget(budget);
    modules.push({
      module,
      rootPath: moduleRoot,
      projectReferences: [],
      packageReferences: parseNpmPackageReferences(manifest),
    });
  }

  const moduleByRoot = new Map(
    modules.map((candidate) => [virtualKey(candidate.rootPath), candidate]),
  );
  for (const candidate of modules) {
    guard.check();
    let ancestorRoot = path.posix.dirname(candidate.rootPath);
    let parent: InternalModule | undefined;
    while (virtualIsWithin(context.virtualRoot, ancestorRoot)) {
      parent = moduleByRoot.get(virtualKey(ancestorRoot));
      if (parent) break;
      if (ancestorRoot === context.virtualRoot) break;
      ancestorRoot = path.posix.dirname(ancestorRoot);
    }
    if (parent) {
      candidate.module = {
        ...candidate.module,
        parentModuleId: parent.module.id,
      };
    }
  }
  return modules;
}

async function discoverAngularModules(
  context: RootContext,
  warnings: string[],
  guard: AnalysisGuard,
  budget: ModuleDiscoveryBudget,
): Promise<readonly InternalModule[]> {
  const workspaceFiles = context.files.filter(
    (file) =>
      path.posix.basename(file).toLocaleLowerCase("en-US") === "angular.json",
  );
  const modules: InternalModule[] = [];

  for (const workspaceFile of workspaceFiles) {
    guard.check();
    const text = snapshotText(context, workspaceFile);
    const config = parseJsonFile(text);
    const projects =
      config?.["projects"] && typeof config["projects"] === "object"
        ? (config["projects"] as Record<string, unknown>)
        : undefined;
    if (!projects) {
      warnings.push(
        sanitizeWarningText(
          `${safeRepositoryRelativePath(virtualRelative(context.virtualRoot, workspaceFile))}: invalid angular.json or missing projects`,
        ),
      );
      continue;
    }

    for (const projectName of Object.keys(projects).sort(compareStable)) {
      guard.check();
      const project = projects[projectName];
      if (!project || typeof project !== "object") continue;
      const safeProjectName = sanitizeDisplayText(
        projectName,
        "Unnamed Angular project",
      );
      const rootValue = (project as Record<string, unknown>)["root"];
      const configuredRoot = typeof rootValue === "string" ? rootValue : "";
      let safeConfiguredRoot: string;
      try {
        safeConfiguredRoot = safeRelativeInputPath(
          configuredRoot || ".",
        );
      } catch {
        warnings.push(
          sanitizeWarningText(
            `${safeRepositoryRelativePath(virtualRelative(context.virtualRoot, workspaceFile))}: Angular project '${safeProjectName}' has an unsafe root`,
          ),
        );
        continue;
      }
      const projectRoot = virtualPath(
        path.posix.dirname(workspaceFile),
        safeConfiguredRoot,
      );
      if (!virtualIsWithin(context.virtualRoot, projectRoot)) {
        warnings.push(
          sanitizeWarningText(
            `${safeRepositoryRelativePath(virtualRelative(context.virtualRoot, workspaceFile))}: Angular project '${safeProjectName}' escapes the repository root`,
          ),
        );
        continue;
      }
      const relativeRoot = safeRepositoryRelativePath(
        virtualRelative(context.virtualRoot, projectRoot),
      );
      const workspacePath = safeRepositoryRelativePath(
        virtualRelative(context.virtualRoot, workspaceFile),
      );
      consumeModuleDiscoveryBudget(budget);
      modules.push({
        module: {
          id: stableId(
            "module",
            context.repository.id,
            "angular-project",
            workspacePath,
            projectName,
          ),
          repositoryId: context.repository.id,
          kind: "angular-project",
          name: safeProjectName,
          path: relativeRoot,
          solutionIds: [],
        },
        rootPath: projectRoot,
        projectReferences: [],
        packageReferences: [],
      });
    }
  }
  return modules;
}

function solutionProjectPaths(
  solutionText: string,
  solutionDirectory: string,
  extension: ".sln" | ".slnx",
): readonly string[] {
  const references: string[] = [];
  if (extension === ".sln") {
    const expression =
      /^\s*Project\("[^"]+"\)\s*=\s*"[^"]*",\s*"([^"]+\.csproj)"\s*,/gimu;
    for (const match of solutionText.matchAll(expression)) {
      if (match[1]) references.push(decodeXml(match[1]));
    }
  } else {
    const xml = withoutXmlMetadataText(solutionText);
    for (const match of xml.matchAll(/<Project\b[^>]*>/giu)) {
      const projectPath = attribute(match[0], "Path");
      if (
        projectPath &&
        path.posix
          .extname(projectPath.replaceAll("\\", "/"))
          .toLocaleLowerCase("en-US") === ".csproj"
      ) {
        references.push(projectPath);
      }
    }
  }

  const projectPaths = new Set<string>();
  for (const reference of references) {
    try {
      projectPaths.add(
        virtualPath(
          solutionDirectory,
          safeRelativeInputPath(reference),
        ),
      );
    } catch {
      // Unsafe source references are data only and never become host paths.
    }
  }
  return [...projectPaths].sort(compareStable);
}

function validSlnxDocument(text: string): boolean {
  return wellFormedXmlDocument(text, "Solution");
}

async function discoverSolutions(
  contexts: readonly RootContext[],
  modules: readonly InternalModule[],
  warnings: string[],
  guard: AnalysisGuard,
): Promise<{
  readonly solutions: readonly CitySolution[];
  readonly solutionIdsByModule: ReadonlyMap<string, readonly string[]>;
}> {
  const byProjectPath = new Map(
    modules
      .filter(
        (candidate): candidate is InternalModule & { projectFile: string } =>
          candidate.projectFile !== undefined,
      )
      .map((candidate) => [
        virtualKey(candidate.projectFile),
        candidate.module,
      ]),
  );
  const solutions: CitySolution[] = [];
  const memberships = new Map<string, Set<string>>();

  for (const context of contexts) {
    for (const solutionFile of context.files.filter(
      (file) => {
        const extension = path.posix
          .extname(file)
          .toLocaleLowerCase("en-US");
        return extension === ".sln" || extension === ".slnx";
      },
    )) {
      guard.check();
      const extension = path.posix
        .extname(solutionFile)
        .toLocaleLowerCase("en-US") as ".sln" | ".slnx";
      const relativePath = safeRepositoryRelativePath(
        virtualRelative(context.virtualRoot, solutionFile),
      );
      const id = stableId(
        "solution",
        context.repository.id,
        relativePath,
      );
      const text = snapshotText(context, solutionFile);
      if (extension === ".slnx" && !validSlnxDocument(text)) {
        warnings.push(
          sanitizeWarningText(
            `${relativePath}: malformed .slnx file skipped`,
          ),
        );
        continue;
      }
      const moduleIds = [
        ...new Set(
          solutionProjectPaths(
            text,
            path.posix.dirname(solutionFile),
            extension,
          )
            .map((projectPath) =>
              byProjectPath.get(virtualKey(projectPath)),
            )
            .filter(
              (module): module is CityModule =>
                module !== undefined &&
                module.repositoryId === context.repository.id,
            )
            .map((module) => module.id),
        ),
      ].sort(compareStable);
      solutions.push({
        id,
        repositoryId: context.repository.id,
        name: sanitizeDisplayText(
          path.posix.basename(
            solutionFile,
            path.posix.extname(solutionFile),
          ),
          "Unnamed solution",
        ),
        path: relativePath,
        moduleIds,
      });
      for (const moduleId of moduleIds) {
        const ids = memberships.get(moduleId) ?? new Set<string>();
        ids.add(id);
        memberships.set(moduleId, ids);
      }
    }
  }

  return {
    solutions: solutions.sort((left, right) => compareStable(left.id, right.id)),
    solutionIdsByModule: new Map(
      [...memberships.entries()].map(([moduleId, ids]) => [
        moduleId,
        [...ids].sort(compareStable),
      ]),
    ),
  };
}

function languageOf(filePath: string): SourceLanguage {
  const extension = path.posix.extname(filePath).toLocaleLowerCase("en-US");
  if (extension === ".cs") return "csharp";
  if (extension === ".js" || extension === ".jsx") return "javascript";
  return "typescript";
}

function sanitizedImports(
  imports: readonly StaticImportFact[],
): readonly StaticImportFact[] {
  const counts = new Map<string, number>();
  for (const imported of imports) {
    const specifier = sanitizeImportSpecifier(imported.specifier);
    counts.set(specifier, (counts.get(specifier) ?? 0) + imported.count);
  }
  return [...counts.entries()]
    .map(([specifier, count]) => ({ specifier, count }))
    .sort((left, right) => compareStable(left.specifier, right.specifier));
}

function moduleRootIndex(
  candidates: readonly InternalModule[],
): ModuleRootIndex {
  const index = new Map<string, ModuleRootCandidates>();
  for (const candidate of candidates) {
    const key = virtualKey(candidate.rootPath);
    let atRoot = index.get(key);
    if (!atRoot) {
      atRoot = {
        dotnetProjects: [],
        angularProjects: [],
        npmPackages: [],
      };
      index.set(key, atRoot);
    }
    if (candidate.module.kind === "dotnet-project") {
      atRoot.dotnetProjects.push(candidate);
    } else if (candidate.module.kind === "angular-project") {
      atRoot.angularProjects.push(candidate);
    } else if (candidate.module.kind === "npm-package") {
      atRoot.npmPackages.push(candidate);
    }
  }
  for (const atRoot of index.values()) {
    atRoot.dotnetProjects.sort((left, right) =>
      compareStable(left.module.id, right.module.id),
    );
    atRoot.angularProjects.sort((left, right) =>
      compareStable(left.module.id, right.module.id),
    );
    atRoot.npmPackages.sort((left, right) =>
      compareStable(left.module.id, right.module.id),
    );
  }
  return index;
}

function chooseModule(
  sourcePath: string,
  repositoryRoot: string,
  language: SourceLanguage,
  index: ModuleRootIndex,
  guard: AnalysisGuard,
): InternalModule | undefined {
  let candidateRoot = path.posix.dirname(sourcePath);
  while (virtualIsWithin(repositoryRoot, candidateRoot)) {
    guard.check();
    const atRoot = index.get(virtualKey(candidateRoot));
    const selected =
      language === "csharp"
        ? atRoot?.dotnetProjects[0]
        : atRoot?.angularProjects[0] ?? atRoot?.npmPackages[0];
    if (selected) return selected;
    if (candidateRoot === repositoryRoot) break;
    candidateRoot = path.posix.dirname(candidateRoot);
  }
  return undefined;
}

function explicitIdentity(
  options: LocalAnalysisOptions,
): CityIdentity | undefined {
  let logo: IdentityLogo | undefined;
  if (options.logo !== undefined) {
    if (path.isAbsolute(options.logo) || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(options.logo)) {
      throw new Error("Logo must be a relative .svg or .png asset reference.");
    }
    const extension = path.posix
      .extname(options.logo.replaceAll("\\", "/"))
      .toLocaleLowerCase("en-US");
    if (extension !== ".svg" && extension !== ".png") {
      throw new Error("Logo must use the .svg or .png extension.");
    }
    logo = {
      relativePath: normalizePath(options.logo),
      format: extension === ".svg" ? "svg" : "png",
    };
  }
  if (options.title === undefined) {
    if (options.version !== undefined || logo !== undefined) {
      throw new Error(
        "Identity title is required when version or logo is supplied.",
      );
    }
    return undefined;
  }
  return normalizeCityIdentity({
    title: options.title,
    ...(options.version === undefined ? {} : { version: options.version }),
    ...(logo === undefined ? {} : { logo }),
  });
}

export interface RepositorySnapshotSourceAnalysisExecution {
  readonly cache: HistorySourceAnalysisCache;
  readonly analyzerFingerprint: string;
  readonly configurationFingerprint: string;
  readonly detailLevel: SourceAnalysisDetailLevel;
}

export interface RepositorySnapshotAnalysisExecutionOptions {
  readonly sourceAnalysis?: RepositorySnapshotSourceAnalysisExecution;
}

interface DeferredCSharpSource {
  readonly id: string;
  readonly context: RootContext;
  readonly selected: InternalModule;
  readonly sourcePath: string;
  readonly relativePath: string;
  readonly sourceText: string;
  readonly cacheKey?: string;
}

function sourceAnalysisLanguageMode(
  sourcePath: string,
  language: SourceLanguage,
): SourceAnalysisLanguageMode {
  if (language === "csharp") return "csharp";
  const extension = path.posix.extname(sourcePath).toLocaleLowerCase("en-US");
  if (language === "javascript") {
    return extension === ".jsx" ? "javascript-jsx" : "javascript-js";
  }
  if (sourcePath.toLocaleLowerCase("en-US").endsWith(".d.ts")) {
    return "typescript-dts";
  }
  return extension === ".tsx" ? "typescript-tsx" : "typescript-ts";
}

function cachedSourceKey(
  execution: RepositorySnapshotSourceAnalysisExecution | undefined,
  sourcePath: string,
  sourceText: string,
  language: SourceLanguage,
  guard: AnalysisGuard,
): string | undefined {
  return execution?.cache.key(
    {
      sourceText,
      languageMode: sourceAnalysisLanguageMode(sourcePath, language),
      analyzerFingerprint: execution.analyzerFingerprint,
      configurationFingerprint: execution.configurationFingerprint,
      detailLevel: execution.detailLevel,
    },
    () => guard.check(),
  );
}

async function retainedTypeScriptAnalysis(
  workspace: TypeScriptWorkspace,
  sourcePath: string,
  sourceText: string,
  detailLevel: SourceAnalysisDetailLevel,
): Promise<UnboundSourceAnalysis> {
  const sourceFile = await workspace.sourceFile(sourcePath);
  if (sourceFile === undefined) {
    return Object.freeze({
      status: "skipped" as const,
      reason: "typescript-syntax-errors" as const,
    });
  }
  const analysis = analyzeParsedTypeScriptSource(
    sourceFile,
    await workspace.hasSyntacticErrors(sourcePath),
  );
  if (analysis.hasSyntaxErrors) {
    return Object.freeze({
      status: "skipped" as const,
      reason: "typescript-syntax-errors" as const,
    });
  }
  const imports = Object.freeze(sanitizedImports(analysis.imports));
  return Object.freeze({
    status: "valid" as const,
    metrics: Object.freeze({
      sloc: analysis.sloc,
      decisionLoad: analysis.decisionLoad,
      maximumComplexity: analysis.maximumComplexity,
      executableUnitCount: analysis.executableUnitCount,
    }),
    metricMethod: "typescript-native-api-v2" as const,
    imports,
    ...(detailLevel === "summary"
      ? {}
      : {
          units: analysis.units,
          sourceStructure: analysis.sourceStructure,
        }),
    warnings: Object.freeze([]),
  });
}

function retainedCSharpAnalysis(
  outcome: RoslynFileOutcome,
  detailLevel: SourceAnalysisDetailLevel,
): UnboundSourceAnalysis {
  if (outcome.status === "skipped") {
    return Object.freeze({
      status: "skipped" as const,
      reason: "csharp-unit-limit" as const,
    });
  }
  if (outcome.warnings.includes("syntax-errors-present")) {
    return Object.freeze({
      status: "skipped" as const,
      reason: "csharp-syntax-errors" as const,
    });
  }
  return Object.freeze({
    status: "valid" as const,
    metrics: outcome.metrics,
    metricMethod: outcome.metricMethod,
    imports: Object.freeze([]),
    ...(detailLevel === "summary"
      ? {}
      : {
          units: outcome.units,
          sourceStructure: outcome.sourceStructure,
        }),
    warnings: Object.freeze(
      outcome.warnings.includes("decision-evidence-byte-limit")
        ? (["csharp-decision-evidence-byte-limit"] as const)
        : [],
    ),
  });
}

function pendingSource(
  context: RootContext,
  selected: InternalModule,
  sourcePath: string,
  relativePath: string,
  sourceText: string,
  language: SourceLanguage,
  metrics: SourceMetrics,
  metricMethod: SourceFileFact["metricMethod"],
  units: SourceFileFact["units"],
  imports: readonly StaticImportFact[],
  sourceStructure?: SourceStructure,
): PendingSource {
  const directory = safeRepositoryRelativePath(path.posix.dirname(relativePath));
  const districtId = stableId(
    "district",
    context.repository.id,
    selected.module.id,
  );
  const risk = classifyRisk(metrics.maximumComplexity);
  const buildingId = stableId(
    "building",
    context.repository.id,
    selected.module.id,
    relativePath,
  );
  return {
    virtualPath: sourcePath,
    repositoryRoot: context.virtualRoot,
    fact: {
      id: buildingId,
      repositoryId: context.repository.id,
      moduleId: selected.module.id,
      districtId,
      districtName:
        directory === "."
          ? selected.module.name
          : sanitizeDisplayText(
              path.posix.basename(directory),
              "Unnamed district",
            ),
      districtPath: directory,
      name: sanitizeDisplayText(
        path.posix.basename(relativePath),
        "Unnamed source",
      ),
      path: relativePath,
      language,
      metrics,
      metricMethod,
      units: units.map((unit) => ({
        ...unit,
        name: sanitizeDisplayText(unit.name, "Unnamed unit"),
        ...(unit.decisionEvidence === undefined
          ? {}
          : {
              decisionEvidence: {
                ...unit.decisionEvidence,
                unitId: `${buildingId}:${unit.decisionEvidence.unitId}`,
                ...(unit.decisionEvidence.callableId === undefined
                  ? {}
                  : {
                      callableId: `${buildingId}:${unit.decisionEvidence.callableId}`,
                    }),
              },
            }),
      })),
      sourceLocation: {
        startLine: 1,
        endLine: Math.max(1, sourceText.split(/\r\n?|\n/u).length),
      },
      ...(sourceStructure === undefined
        ? {}
        : { sourceStructure: bindSourceStructure(buildingId, sourceStructure) }),
      risk,
      semanticGroupId: semanticGroupForRisk(risk),
      imports,
    },
    imports,
  };
}

function appendAnalyzedSource(
  pendingSources: PendingSource[],
  warnings: string[],
  context: RootContext,
  selected: InternalModule,
  sourcePath: string,
  relativePath: string,
  sourceText: string,
  language: SourceLanguage,
  analysis: UnboundSourceAnalysis,
): void {
  if (analysis.status === "skipped") {
    const message =
      analysis.reason === "typescript-syntax-errors"
        ? "TypeScript/JavaScript syntax errors; source skipped"
        : analysis.reason === "csharp-syntax-errors"
          ? "C# syntax errors; source skipped"
          : "C# source exceeded the Roslyn unit limit and was skipped";
    warnings.push(
      sanitizeWarningText(`${relativePath}: ${message}`),
    );
    return;
  }
  if (
    analysis.warnings.includes(
      "csharp-decision-evidence-byte-limit",
    )
  ) {
    warnings.push(
      sanitizeWarningText(
        `${relativePath}: C# ${DECISION_EVIDENCE_OMITTED_WARNING}`,
      ),
    );
  }
  pendingSources.push(
    pendingSource(
      context,
      selected,
      sourcePath,
      relativePath,
      sourceText,
      language,
      analysis.metrics,
      analysis.metricMethod,
      analysis.units ?? [],
      analysis.imports,
      analysis.sourceStructure,
    ),
  );
}

/** Prefix file-local analyzer keys so every persisted fine identity is global. */
function bindSourceStructure(
  buildingId: string,
  structure: SourceStructure,
): SourceStructure {
  const localToGlobal = new Map<string, string>();
  for (const item of [...structure.types, ...structure.callables]) {
    localToGlobal.set(item.id, `${buildingId}:${item.id}`);
  }
  return {
    ...structure,
    types: structure.types.map((item) => ({
      ...item,
      id: localToGlobal.get(item.id)!,
      ...(item.parentTypeId === undefined || localToGlobal.get(item.parentTypeId) === undefined
        ? {}
        : { parentTypeId: localToGlobal.get(item.parentTypeId)! }),
    })),
    callables: structure.callables.map((item) => ({
      ...item,
      id: localToGlobal.get(item.id)!,
      ...(item.enclosingTypeId === undefined || localToGlobal.get(item.enclosingTypeId) === undefined
        ? {}
        : { enclosingTypeId: localToGlobal.get(item.enclosingTypeId)! }),
    })),
    relations: structure.relations.map((item) => ({
      ...item,
      id: `${buildingId}:${item.id}`,
      sourceId: localToGlobal.get(item.sourceId)!,
      targetId: localToGlobal.get(item.targetId)!,
    })),
  };
}

async function analyzeSources(
  contexts: readonly RootContext[],
  typeScriptWorkspace: TypeScriptWorkspace | undefined,
  modules: InternalModule[],
  warnings: string[],
  guard: AnalysisGuard,
  sourceAnalysisExecution?: RepositorySnapshotSourceAnalysisExecution,
): Promise<{
  readonly sources: readonly PendingSource[];
  readonly unassignedModules: readonly InternalModule[];
}> {
  const pendingSources: PendingSource[] = [];
  const csharpSources: DeferredCSharpSource[] = [];
  const csharpAnalysisById = new Map<string, UnboundSourceAnalysis>();
  const unassignedByRepository = new Map<string, InternalModule>();
  const modulesByRepository = new Map<string, InternalModule[]>();
  for (const candidate of modules) {
    if (candidate.module.kind === "unassigned") continue;
    const repositoryModules =
      modulesByRepository.get(candidate.module.repositoryId) ?? [];
    repositoryModules.push(candidate);
    modulesByRepository.set(candidate.module.repositoryId, repositoryModules);
  }

  for (const context of contexts) {
    const repositoryModuleIndex = moduleRootIndex(
      modulesByRepository.get(context.repository.id) ?? [],
    );
    for (const sourcePath of context.files.filter(isSourceFile)) {
      guard.check();
      const language = languageOf(sourcePath);
      let selected = chooseModule(
        sourcePath,
        context.virtualRoot,
        language,
        repositoryModuleIndex,
        guard,
      );
      if (!selected) {
        selected = unassignedByRepository.get(context.repository.id);
        if (!selected) {
          selected = {
            module: {
              id: stableId(
                "module",
                context.repository.id,
                "unassigned",
                ".",
              ),
              repositoryId: context.repository.id,
              kind: "unassigned",
              name: "Unassigned",
              path: ".",
              solutionIds: [],
            },
            rootPath: context.virtualRoot,
            projectReferences: [],
            packageReferences: [],
          };
          unassignedByRepository.set(context.repository.id, selected);
        }
      }

      const relativePath = safeRepositoryRelativePath(
        virtualRelative(context.virtualRoot, sourcePath),
      );
      const sourceText = snapshotText(context, sourcePath);
      const cacheKey = cachedSourceKey(
        sourceAnalysisExecution,
        sourcePath,
        sourceText,
        language,
        guard,
      );
      const cached =
        cacheKey === undefined
          ? undefined
          : sourceAnalysisExecution!.cache.get(cacheKey);
      if (language === "csharp") {
        const id =
          `source-${String(csharpSources.length + 1).padStart(6, "0")}.cs`;
        csharpSources.push({
          id,
          context,
          selected,
          sourcePath,
          relativePath,
          sourceText,
          ...(cacheKey === undefined ? {} : { cacheKey }),
        });
        if (cached !== undefined) csharpAnalysisById.set(id, cached);
        continue;
      }

      if (cached === undefined && typeScriptWorkspace === undefined) {
        throw new Error("TypeScript workspace is unavailable.");
      }
      const analysis =
        cached ??
        await retainedTypeScriptAnalysis(
          typeScriptWorkspace!,
          sourcePath,
          sourceText,
          sourceAnalysisExecution?.detailLevel ?? "full",
        );
      guard.check();
      if (cached === undefined && cacheKey !== undefined) {
        sourceAnalysisExecution!.cache.set(
          cacheKey,
          analysis,
          () => guard.check(),
        );
      }
      appendAnalyzedSource(
        pendingSources,
        warnings,
        context,
        selected,
        sourcePath,
        relativePath,
        sourceText,
        language,
        analysis,
      );
    }
  }

  const uncachedCSharpSources = csharpSources.filter(
    ({ id }) => !csharpAnalysisById.has(id),
  );
  if (uncachedCSharpSources.length > 0) {
    guard.check();
    const launch = await resolveBundledRoslynLaunch();
    guard.check();
    const outcomes = await analyzeCSharpWithRoslyn(
      uncachedCSharpSources.map(({ id, sourceText }) => ({
        id,
        source: sourceText,
      })),
      launch,
      {
        timeoutMs: Math.min(
          guard.remainingMs(),
          ROSLYN_HOST_LIMITS.timeoutMs,
        ),
        ...(guard.signal === undefined ? {} : { signal: guard.signal }),
      },
    );
    const uncachedById = new Map(
      uncachedCSharpSources.map((source) => [source.id, source]),
    );
    for (const outcome of outcomes) {
      guard.check();
      const source = uncachedById.get(outcome.id);
      if (!source) {
        throw new Error("Roslyn helper returned an unknown source identifier.");
      }
      const analysis = retainedCSharpAnalysis(
        outcome,
        sourceAnalysisExecution?.detailLevel ?? "full",
      );
      csharpAnalysisById.set(source.id, analysis);
      if (source.cacheKey !== undefined) {
        sourceAnalysisExecution!.cache.set(
          source.cacheKey,
          analysis,
          () => guard.check(),
        );
      }
    }
  }
  for (const source of csharpSources) {
    guard.check();
    const analysis = csharpAnalysisById.get(source.id);
    if (analysis === undefined) {
      throw new Error("Roslyn helper omitted a requested source result.");
    }
    appendAnalyzedSource(
      pendingSources,
      warnings,
      source.context,
      source.selected,
      source.sourcePath,
      source.relativePath,
      source.sourceText,
      "csharp",
      analysis,
    );
  }

  const orderedSources = pendingSources.sort((left, right) =>
    compareStable(left.fact.id, right.fact.id),
  );
  const referencedModuleIds = new Set(
    orderedSources.map((source) => source.fact.moduleId),
  );
  return {
    sources: boundProjectDecisionEvidence(orderedSources, warnings),
    unassignedModules: [...unassignedByRepository.values()]
      .filter((candidate) => referencedModuleIds.has(candidate.module.id))
      .sort((left, right) => compareStable(left.module.id, right.module.id)),
  };
}

function packageGateway(specifier: string): string {
  if (specifier.startsWith(".")) {
    return sanitizeExternalReference(specifier, "unresolved-module");
  }
  const redacted = sanitizeExternalReference(specifier, "external-module");
  if (redacted !== specifier) return redacted;
  if (specifier.startsWith("@")) {
    return specifier.split("/").slice(0, 2).join("/");
  }
  return specifier.split("/")[0] ?? specifier;
}

function dependencyKey(dependency: CityDependency): string {
  return [
    dependency.kind,
    dependency.repositoryId,
    dependency.sourceId,
    dependency.targetId ?? "",
    dependency.externalTarget ?? "",
    dependency.resolution ??
      (dependency.targetId === undefined ? "external" : "internal"),
    dependency.version ?? "",
  ].join("\u0000");
}

function mergeDependencies(
  dependencies: readonly CityDependency[],
): readonly CityDependency[] {
  const merged = new Map<string, CityDependency>();
  for (const dependency of dependencies) {
    const key = dependencyKey(dependency);
    const existing = merged.get(key);
    merged.set(
      key,
      existing
        ? { ...existing, weight: existing.weight + dependency.weight }
        : dependency,
    );
  }
  return [...merged.values()].sort((left, right) =>
    compareStable(left.id, right.id),
  );
}

async function buildDependencies(
  typeScriptWorkspace: TypeScriptWorkspace | undefined,
  modules: readonly InternalModule[],
  sources: readonly PendingSource[],
  guard: AnalysisGuard,
): Promise<readonly CityDependency[]> {
  const dependencies: CityDependency[] = [];
  const moduleByProjectPath = new Map(
    modules
      .filter(
        (candidate): candidate is InternalModule & { projectFile: string } =>
          candidate.projectFile !== undefined,
      )
      .map((candidate) => [
        virtualKey(candidate.projectFile),
        candidate.module,
      ]),
  );
  const producersByPackage = new Map<string, CityModule[]>();
  for (const candidate of [...modules].sort((left, right) =>
    compareStable(left.module.id, right.module.id),
  )) {
    if (candidate.module.packageId) {
      const key = candidate.module.packageId.toLocaleLowerCase("en-US");
      const producers = producersByPackage.get(key) ?? [];
      producers.push(candidate.module);
      producersByPackage.set(key, producers);
    }
  }
  const uniqueProducerByPackage = new Map(
    [...producersByPackage.entries()]
      .filter(([, producers]) => producers.length === 1)
      .map(([packageId, producers]) => [packageId, producers[0]!] as const),
  );

  for (const candidate of modules) {
    guard.check();
    if (candidate.projectFile) {
      for (const reference of candidate.projectReferences) {
        guard.check();
        const target =
          reference.include === undefined
            ? undefined
            : moduleByProjectPath.get(
                virtualKey(
                  virtualPath(
                    path.posix.dirname(candidate.projectFile),
                    reference.include,
                  ),
                ),
              );
        if (target && target.id !== candidate.module.id) {
          dependencies.push({
            id: stableId(
              "dependency",
              "project-reference",
              candidate.module.id,
              target.id,
            ),
            repositoryId: candidate.module.repositoryId,
            sourceId: candidate.module.id,
            targetId: target.id,
            resolution: "internal",
            kind: "project-reference",
            weight: 1,
          });
        } else {
          const externalReference = reference.externalTarget;
          dependencies.push({
            id: stableId(
              "dependency",
              "project-reference",
              candidate.module.id,
              externalReference,
            ),
            repositoryId: candidate.module.repositoryId,
            sourceId: candidate.module.id,
            externalTarget: externalReference,
            resolution: "unresolved",
            kind: "project-reference",
            weight: 1,
          });
        }
      }
    }
    for (const reference of candidate.packageReferences) {
      guard.check();
      const target = uniqueProducerByPackage.get(
        reference.packageId.toLocaleLowerCase("en-US"),
      );
      if (target?.id === candidate.module.id) continue;
      dependencies.push({
        id: stableId(
          "dependency",
          "package-reference",
          candidate.module.id,
          target?.id ?? reference.packageId,
          reference.version ?? "",
        ),
        repositoryId: candidate.module.repositoryId,
        sourceId: candidate.module.id,
        ...(target
          ? { targetId: target.id }
          : { externalTarget: reference.packageId }),
        resolution: target ? "internal" : "external",
        kind: "package-reference",
        ...(reference.version === undefined
          ? {}
          : { version: reference.version }),
        weight: 1,
      });
    }
  }

  const sourceByPath = new Map(
    sources.map((source) => [
      virtualKey(source.virtualPath),
      source.fact,
    ]),
  );
  for (const source of sources) {
    guard.check();
    if (source.fact.language === "csharp") continue;
    for (const imported of source.imports) {
      guard.check();
      const resolved = await typeScriptWorkspace?.resolveImport(
        source.virtualPath,
        imported.specifier,
      );
      const target = resolved
        ? sourceByPath.get(
            virtualKey(resolved),
          )
        : undefined;
      if (target?.id === source.fact.id) continue;
      const resolution =
        target !== undefined
          ? "internal"
          : imported.specifier.startsWith(".")
            ? "unresolved"
            : "external";
      const dependencyTarget =
        target?.id ?? packageGateway(imported.specifier);
      dependencies.push({
        id: stableId(
          "dependency",
          "typescript-import",
          source.fact.id,
          resolution,
          dependencyTarget,
        ),
        repositoryId: source.fact.repositoryId,
        sourceId: source.fact.id,
        ...(target
          ? { targetId: target.id }
          : { externalTarget: dependencyTarget }),
        resolution,
        kind: "typescript-import",
        weight: imported.count,
      });
    }
  }
  return mergeDependencies(dependencies);
}

export async function analyzeLocalFacts(
  requestedRoots: readonly string[],
  options: LocalAnalysisOptions = {},
): Promise<LocalAnalysisFacts> {
  const startedAt = Date.now();
  const totalTimeout =
    options.timeoutMs ?? DEFAULT_SNAPSHOT_LIMITS.timeoutMs;
  const logoRelief =
    options.logo === undefined
      ? undefined
      : await acquireLocalLogoPrintRelief(
          requestedRoots,
          options.logo,
          {
            timeoutMs: Math.min(
              5_000,
              Math.max(1, totalTimeout - (Date.now() - startedAt)),
            ),
            ...(options.signal === undefined
              ? {}
              : { signal: options.signal }),
          },
        );
  const snapshots = await materializeLocalRepositorySnapshots(
    requestedRoots,
    options,
  );
  const elapsed = Date.now() - startedAt;
  const remainingTimeout = totalTimeout - elapsed;
  if (remainingTimeout <= 0) {
    throw new SnapshotDeadlineError();
  }
  const facts = await analyzeRepositorySnapshotFacts(snapshots, {
    ...options,
    timeoutMs: remainingTimeout,
  });
  if (logoRelief === undefined) return facts;
  const identity =
    facts.identity?.logo === undefined
      ? facts.identity
      : {
          ...facts.identity,
          logo: {
            ...facts.identity.logo,
            ...(logoRelief.relief === undefined
              ? {}
              : { printRelief: logoRelief.relief }),
          },
        };
  return {
    ...facts,
    ...(identity === undefined ? {} : { identity }),
    warnings: boundedWarnings([
      ...facts.warnings,
      ...(logoRelief.warning === undefined
        ? []
        : [logoRelief.warning]),
    ]),
  };
}

export async function analyzeRepositorySnapshotFacts(
  requestedSnapshots: readonly RepositorySnapshot[],
  options: LocalAnalysisOptions = {},
  execution: RepositorySnapshotAnalysisExecutionOptions = {},
): Promise<LocalAnalysisFacts> {
  if (requestedSnapshots.length === 0) {
    throw new Error("At least one repository snapshot is required.");
  }
  const guard = createAnalysisGuard(options);
  guard.check();
  assertRepositorySnapshots(requestedSnapshots, options);
  guard.check();
  const snapshots = orderedSnapshots(requestedSnapshots);
  const repositories = createRepositories(snapshots);
  const rootOccurrences = new Map<string, number>();
  const contexts: RootContext[] = snapshots.map((snapshot, index) => {
    guard.check();
    const segment = portableSegment(repositories[index]!.name);
    const occurrence = (rootOccurrences.get(segment) ?? 0) + 1;
    rootOccurrences.set(segment, occurrence);
    const virtualRoot = path.posix.join(
      VIRTUAL_WORKSPACE_ROOT,
      occurrence === 1 ? segment : `${segment}~${occurrence}`,
    );
    const textByPath = new Map<string, string>();
    const files = snapshot.files.map((file) => {
      guard.check();
      const filePath = virtualPath(virtualRoot, file.path);
      if (!virtualIsWithin(virtualRoot, filePath)) {
        throw new Error("Invalid snapshot path.");
      }
      textByPath.set(virtualKey(filePath), file.text);
      return filePath;
    });
    return {
      virtualRoot,
      repository: repositories[index]!,
      files,
      textByPath,
    };
  });
  const warnings: string[] = snapshots.flatMap((snapshot) =>
    snapshot.diagnostics.map((diagnostic) =>
      sanitizeWarningText(
        [
          diagnostic.code,
          sanitizeDisplayText(snapshot.name, "Repository"),
          diagnostic.path === undefined
            ? undefined
            : sanitizeExternalReference(
                diagnostic.path,
                "unavailable-path",
              ),
          SNAPSHOT_WARNING_TEXT[diagnostic.code],
        ]
          .filter((part) => part !== undefined && part !== "")
          .join(": "),
      ),
    ),
  );
  const moduleDiscoveryBudget: ModuleDiscoveryBudget = { count: 0 };
  const discoveredModules = (
    await Promise.all(
      contexts.map(async (context) => [
        ...(await discoverDotnetModules(
          context,
          warnings,
          guard,
          moduleDiscoveryBudget,
        )),
        ...(await discoverAngularModules(
          context,
          warnings,
          guard,
          moduleDiscoveryBudget,
        )),
        ...(await discoverNpmModules(
          context,
          warnings,
          guard,
          moduleDiscoveryBudget,
        )),
      ]),
    )
  ).flat();
  const typeScriptFiles: TypeScriptWorkspaceFile[] = contexts.flatMap(
    (context) =>
      context.files
        .filter((filePath) => /\.(?:[cm]?[jt]sx?|json)$/iu.test(filePath))
        .map((filePath) => ({
          path: filePath,
          text: snapshotText(context, filePath),
        })),
  );
  const hasTypeScriptSources = contexts.some((context) =>
    context.files.some(
      (filePath) =>
        isSourceFile(filePath) && languageOf(filePath) !== "csharp",
    ),
  );
  guard.check();
  await using typeScriptWorkspace = hasTypeScriptSources
    ? await TypeScriptWorkspace.create(typeScriptFiles, {
        timeoutMs: guard.remainingMs(),
        ...(guard.signal === undefined ? {} : { signal: guard.signal }),
      })
    : undefined;
  guard.check();
  const sourceResult = await analyzeSources(
    contexts,
    typeScriptWorkspace,
    discoveredModules,
    warnings,
    guard,
    execution.sourceAnalysis,
  );
  for (
    let index = 0;
    index < sourceResult.unassignedModules.length;
    index += 1
  ) {
    guard.check();
    consumeModuleDiscoveryBudget(moduleDiscoveryBudget);
  }
  const { solutions, solutionIdsByModule } = await discoverSolutions(
    contexts,
    discoveredModules,
    warnings,
    guard,
  );
  for (const candidate of discoveredModules) {
    guard.check();
    const solutionIds = solutionIdsByModule.get(candidate.module.id) ?? [];
    candidate.module = { ...candidate.module, solutionIds };
  }
  const allModules = [
    ...discoveredModules,
    ...sourceResult.unassignedModules,
  ].sort((left, right) => compareStable(left.module.id, right.module.id));
  const dependencies = await buildDependencies(
    typeScriptWorkspace,
    allModules,
    sourceResult.sources,
    guard,
  );

  const identity = explicitIdentity(options);
  guard.check();
  return {
    ...(identity === undefined ? {} : { identity }),
    repositories,
    solutions,
    modules: allModules.map((candidate) => candidate.module),
    sources: sourceResult.sources.map((source) => source.fact),
    dependencies,
    warnings: boundedWarnings(warnings),
  };
}
