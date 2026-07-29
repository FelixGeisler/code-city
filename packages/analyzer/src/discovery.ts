import path from "node:path";
import ts from "typescript";

import type {
  CityDependency,
  CityIdentity,
  CityModule,
  CityRepository,
  CitySolution,
  IdentityLogo,
  SourceLanguage,
  SourceMetrics,
} from "../../core/src/model.js";
import { normalizeCityIdentity } from "../../core/src/identity.js";
import { classifyRisk } from "../../core/src/metrics.js";
import { normalizePath, stableId } from "../../core/src/path.js";
import { semanticGroupForRisk } from "../../core/src/semantics.js";
import { analyzeCSharpLexically } from "./csharp-lexical.js";
import {
  compareStable,
  isSourceFile,
} from "./filesystem.js";
import { materializeLocalRepositorySnapshots } from "./local-snapshot.js";
import type {
  RepositorySnapshot,
  SnapshotDiagnosticCode,
} from "./snapshot.js";
import {
  assertRepositorySnapshots,
  DEFAULT_SNAPSHOT_LIMITS,
  SnapshotDeadlineError,
} from "./snapshot.js";
import type {
  LocalAnalysisFacts,
  LocalAnalysisOptions,
  SourceFileFact,
  StaticImportFact,
} from "./types.js";
import { analyzeTypeScriptSource } from "./typescript-metrics.js";

interface RootContext {
  readonly virtualRoot: string;
  readonly repository: CityRepository;
  readonly files: readonly string[];
  readonly textByPath: ReadonlyMap<string, string>;
}

interface ProjectReference {
  readonly include: string;
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
}

const VIRTUAL_WORKSPACE_ROOT = "/code-city";

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
    throw new Error(`Snapshot path escapes its repository: ${candidate}`);
  }
  return path.posix.relative(virtualPath(root), virtualPath(candidate)) || ".";
}

function snapshotText(context: RootContext, filePath: string): string {
  const text = context.textByPath.get(virtualKey(filePath));
  if (text === undefined) {
    throw new Error(
      `Snapshot file was not admitted: ${virtualRelative(context.virtualRoot, filePath)}`,
    );
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
  };
}

function decodeXml(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function withoutXmlComments(xml: string): string {
  return xml.replace(/<!--[\s\S]*?-->/gu, "");
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
    const include = attribute(match[0], "Include");
    if (include) references.push({ include });
  }
  return references.sort((left, right) =>
    compareStable(left.include, right.include),
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
      packageId: redactAbsoluteReference(packageId),
      ...(version === undefined ? {} : { version }),
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
        .map((framework) => framework.trim())
        .filter(Boolean)
        .sort(compareStable)
    : [];
}

function redactAbsoluteReference(value: string): string {
  return path.isAbsolute(value) ||
    /^[A-Za-z]:[\\/]/u.test(value) ||
    value.startsWith("\\\\")
    ? path.posix.basename(value.replaceAll("\\", "/"))
    : value;
}

function createRepositories(
  snapshots: readonly RepositorySnapshot[],
): readonly CityRepository[] {
  const occurrences = new Map<string, number>();
  return snapshots.map((snapshot) => {
    const name = snapshot.name || "Repository";
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
  guard: AnalysisGuard,
): Promise<readonly InternalModule[]> {
  const projectFiles = context.files.filter(
    (file) =>
      path.posix.extname(file).toLocaleLowerCase("en-US") === ".csproj",
  );
  return Promise.all(
    projectFiles.map(async (projectFile) => {
      guard.check();
      const xml = withoutXmlComments(snapshotText(context, projectFile));
      const relativeProject = virtualRelative(
        context.virtualRoot,
        projectFile,
      );
      const frameworks = targetFrameworks(xml);
      const moduleName = redactAbsoluteReference(
        firstElement(xml, "AssemblyName") ??
          path.posix.basename(
            projectFile,
            path.posix.extname(projectFile),
          ),
      );
      // NuGet defaults PackageId to AssemblyName/project name. Retaining the
      // effective id lets separately supplied roots reconnect package bridges.
      const packageId = redactAbsoluteReference(
        firstElement(xml, "PackageId") ?? moduleName,
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
        path: normalizePath(relativeProject),
        solutionIds: [],
        ...(frameworks.length === 0 ? {} : { targetFrameworks: frameworks }),
        ...(packageId === undefined ? {} : { packageId }),
      };
      return {
        module,
        rootPath: path.posix.dirname(projectFile),
        projectFile,
        projectReferences: parseProjectReferences(xml),
        packageReferences: parsePackageReferences(xml),
      };
    }),
  );
}

function parseJsonFile(
  filePath: string,
  text: string,
): Record<string, unknown> | undefined {
  const result = ts.parseConfigFileTextToJson(filePath, text);
  return result.error
    ? undefined
    : (result.config as Record<string, unknown> | undefined);
}

async function discoverAngularModules(
  context: RootContext,
  warnings: string[],
  guard: AnalysisGuard,
): Promise<readonly InternalModule[]> {
  const workspaceFiles = context.files.filter(
    (file) =>
      path.posix.basename(file).toLocaleLowerCase("en-US") === "angular.json",
  );
  const modules: InternalModule[] = [];

  for (const workspaceFile of workspaceFiles) {
    guard.check();
    const text = snapshotText(context, workspaceFile);
    const config = parseJsonFile(workspaceFile, text);
    const projects =
      config?.["projects"] && typeof config["projects"] === "object"
        ? (config["projects"] as Record<string, unknown>)
        : undefined;
    if (!projects) {
      warnings.push(
        `${virtualRelative(context.virtualRoot, workspaceFile)}: invalid angular.json or missing projects`,
      );
      continue;
    }

    for (const projectName of Object.keys(projects).sort(compareStable)) {
      guard.check();
      const project = projects[projectName];
      if (!project || typeof project !== "object") continue;
      const rootValue = (project as Record<string, unknown>)["root"];
      const configuredRoot = typeof rootValue === "string" ? rootValue : "";
      const projectRoot = virtualPath(
        path.posix.dirname(workspaceFile),
        configuredRoot,
      );
      if (!virtualIsWithin(context.virtualRoot, projectRoot)) {
        warnings.push(
          `${virtualRelative(context.virtualRoot, workspaceFile)}: Angular project '${projectName}' escapes the repository root`,
        );
        continue;
      }
      const relativeRoot = virtualRelative(context.virtualRoot, projectRoot);
      const workspacePath = virtualRelative(
        context.virtualRoot,
        workspaceFile,
      );
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
          name: projectName,
          path: normalizePath(relativeRoot),
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
): readonly string[] {
  const paths: string[] = [];
  const expression =
    /^\s*Project\("[^"]+"\)\s*=\s*"[^"]*",\s*"([^"]+\.csproj)"\s*,/gimu;
  for (const match of solutionText.matchAll(expression)) {
    const relative = match[1];
    if (relative) {
      paths.push(virtualPath(solutionDirectory, decodeXml(relative)));
    }
  }
  return paths.sort(compareStable);
}

async function discoverSolutions(
  contexts: readonly RootContext[],
  modules: readonly InternalModule[],
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
      (file) =>
        path.posix.extname(file).toLocaleLowerCase("en-US") === ".sln",
    )) {
      guard.check();
      const relativePath = virtualRelative(
        context.virtualRoot,
        solutionFile,
      );
      const id = stableId(
        "solution",
        context.repository.id,
        normalizePath(relativePath),
      );
      const text = snapshotText(context, solutionFile);
      const moduleIds = [
        ...new Set(
          solutionProjectPaths(text, path.posix.dirname(solutionFile))
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
        name: path.posix.basename(
          solutionFile,
          path.posix.extname(solutionFile),
        ),
        path: normalizePath(relativePath),
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

function chooseModule(
  sourcePath: string,
  language: SourceLanguage,
  candidates: readonly InternalModule[],
): InternalModule | undefined {
  const expectedKind =
    language === "csharp" ? "dotnet-project" : "angular-project";
  return candidates
    .filter(
      (candidate) =>
        candidate.module.kind === expectedKind &&
        virtualIsWithin(candidate.rootPath, sourcePath),
    )
    .sort(
      (left, right) =>
        right.rootPath.length - left.rootPath.length ||
        compareStable(left.module.id, right.module.id),
    )[0];
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

async function analyzeSources(
  contexts: readonly RootContext[],
  modules: InternalModule[],
  guard: AnalysisGuard,
): Promise<{
  readonly sources: readonly PendingSource[];
  readonly unassignedModules: readonly InternalModule[];
}> {
  const pendingSources: PendingSource[] = [];
  const unassignedByRepository = new Map<string, InternalModule>();

  for (const context of contexts) {
    const repositoryModules = modules.filter(
      (candidate) =>
        candidate.module.repositoryId === context.repository.id &&
        candidate.module.kind !== "unassigned",
    );
    for (const sourcePath of context.files.filter(isSourceFile)) {
      guard.check();
      const language = languageOf(sourcePath);
      let selected = chooseModule(sourcePath, language, repositoryModules);
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

      const relativePath = normalizePath(
        virtualRelative(context.virtualRoot, sourcePath),
      );
      const directory = normalizePath(path.posix.dirname(relativePath));
      const districtId = stableId(
        "district",
        context.repository.id,
        selected.module.id,
      );
      const sourceText = snapshotText(context, sourcePath);
      const analysis =
        language === "csharp"
          ? analyzeCSharpLexically(sourceText)
          : analyzeTypeScriptSource(sourcePath, sourceText);
      const metrics: SourceMetrics = {
        sloc: analysis.sloc,
        decisionLoad: analysis.decisionLoad,
        maximumComplexity: analysis.maximumComplexity,
        executableUnitCount: analysis.executableUnitCount,
      };
      const risk = classifyRisk(metrics.maximumComplexity);
      const imports =
        language === "csharp"
          ? []
          : (analysis as ReturnType<typeof analyzeTypeScriptSource>).imports;
      const fact: SourceFileFact = {
        id: stableId(
          "building",
          context.repository.id,
          selected.module.id,
          relativePath,
        ),
        repositoryId: context.repository.id,
        moduleId: selected.module.id,
        districtId,
        districtName:
          directory === "."
            ? selected.module.name
            : path.posix.basename(directory),
        districtPath: directory,
        name: path.posix.basename(relativePath),
        path: relativePath,
        language,
        metrics,
        metricMethod:
          language === "csharp"
            ? "csharp-lexical-v1"
            : "typescript-compiler-api-v1",
        units: analysis.units,
        risk,
        semanticGroupId: semanticGroupForRisk(risk),
        imports,
      };
      pendingSources.push({
        virtualPath: sourcePath,
        repositoryRoot: context.virtualRoot,
        fact,
        imports,
      });
    }
  }
  return {
    sources: pendingSources.sort((left, right) =>
      compareStable(left.fact.id, right.fact.id),
    ),
    unassignedModules: [...unassignedByRepository.values()].sort(
      (left, right) => compareStable(left.module.id, right.module.id),
    ),
  };
}

type RestrictedTypeScriptHost = ts.ParseConfigHost & ts.ModuleResolutionHost;

function snapshotTypeScriptHost(
  contexts: readonly RootContext[],
): RestrictedTypeScriptHost {
  const files = new Map<string, string>();
  const directories = new Set<string>();
  for (const context of contexts) {
    directories.add(virtualKey(context.virtualRoot));
    for (const file of context.files) {
      const key = virtualKey(file);
      const text = context.textByPath.get(key);
      if (text !== undefined) files.set(key, text);
      let directory = path.posix.dirname(key);
      while (virtualIsWithin(context.virtualRoot, directory)) {
        directories.add(directory);
        if (directory === context.virtualRoot) break;
        directory = path.posix.dirname(directory);
      }
    }
  }

  function admittedFile(candidate: string): string | undefined {
    return files.get(virtualKey(candidate));
  }

  return {
    useCaseSensitiveFileNames: true,
    fileExists: (fileName) => admittedFile(fileName) !== undefined,
    readFile: (fileName) => admittedFile(fileName),
    // Analysis consumes compiler options only. Config include/exclude expansion
    // is intentionally disabled so it cannot widen the immutable snapshot.
    readDirectory: () => [],
    directoryExists: (directoryName) =>
      directories.has(virtualKey(directoryName)),
    getDirectories: () => [],
    realpath: (candidate) => virtualKey(candidate),
  };
}

function parseCompilerOptions(
  configPath: string,
  host: RestrictedTypeScriptHost,
): ts.CompilerOptions {
  const read = ts.readConfigFile(configPath, host.readFile);
  if (read.error) return {};
  return ts.parseJsonConfigFileContent(
    read.config,
    host,
    path.posix.dirname(configPath),
    undefined,
    configPath,
  ).options;
}

function compilerOptionsFor(
  sourcePath: string,
  repositoryRoot: string,
  configFiles: readonly string[],
  cache: Map<string, ts.CompilerOptions>,
  host: RestrictedTypeScriptHost,
): ts.CompilerOptions {
  function directoryDepth(configPath: string): number {
    const relative = path.posix.relative(
      repositoryRoot,
      path.posix.dirname(configPath),
    );
    if (relative === "") return 0;
    return relative.split("/").filter(Boolean).length;
  }

  const selected = configFiles
    .filter((config) =>
      virtualIsWithin(path.posix.dirname(config), sourcePath),
    )
    .sort(
      (left, right) =>
        directoryDepth(right) - directoryDepth(left) ||
        compareStable(left, right),
    )[0];
  if (!selected) {
    return {
      allowJs: true,
      moduleResolution: ts.ModuleResolutionKind.Node10,
    };
  }
  const cached = cache.get(selected);
  if (cached) return cached;
  const parsed = parseCompilerOptions(selected, host);
  cache.set(selected, parsed);
  return parsed;
}

function packageGateway(specifier: string): string {
  const redacted = redactAbsoluteReference(specifier);
  if (redacted !== specifier) return redacted;
  if (specifier.startsWith(".")) return normalizePath(specifier);
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

function buildDependencies(
  contexts: readonly RootContext[],
  modules: readonly InternalModule[],
  sources: readonly PendingSource[],
  guard: AnalysisGuard,
): readonly CityDependency[] {
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
  const producerByPackage = new Map<string, CityModule>();
  for (const candidate of [...modules].sort((left, right) =>
    compareStable(left.module.id, right.module.id),
  )) {
    if (candidate.module.packageId) {
      producerByPackage.set(
        candidate.module.packageId.toLocaleLowerCase("en-US"),
        candidate.module,
      );
    }
  }

  for (const candidate of modules) {
    guard.check();
    if (!candidate.projectFile) continue;
    for (const reference of candidate.projectReferences) {
      guard.check();
      const target = moduleByProjectPath.get(
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
        const redacted = redactAbsoluteReference(reference.include);
        const externalReference =
          redacted === reference.include
            ? normalizePath(reference.include)
            : redacted;
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
    for (const reference of candidate.packageReferences) {
      guard.check();
      const target = producerByPackage.get(
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
  const configsByRoot = new Map<string, readonly string[]>();
  for (const context of contexts) {
    configsByRoot.set(
      context.virtualRoot,
      context.files.filter((file) =>
        /^tsconfig(?:\..+)?\.json$/iu.test(path.posix.basename(file)),
      ),
    );
  }
  const compilerOptionsCache = new Map<string, ts.CompilerOptions>();
  const resolutionHost = snapshotTypeScriptHost(contexts);

  for (const source of sources) {
    guard.check();
    if (source.fact.language === "csharp") continue;
    const configs = configsByRoot.get(source.repositoryRoot) ?? [];
    const options = compilerOptionsFor(
      source.virtualPath,
      source.repositoryRoot,
      configs,
      compilerOptionsCache,
      resolutionHost,
    );
    for (const imported of source.imports) {
      guard.check();
      const resolved = ts.resolveModuleName(
        imported.specifier,
        source.virtualPath,
        options,
        resolutionHost,
      ).resolvedModule?.resolvedFileName;
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
  const snapshots = await materializeLocalRepositorySnapshots(
    requestedRoots,
    options,
  );
  const elapsed = Date.now() - startedAt;
  const totalTimeout =
    options.timeoutMs ?? DEFAULT_SNAPSHOT_LIMITS.timeoutMs;
  const remainingTimeout = totalTimeout - elapsed;
  if (remainingTimeout <= 0) {
    throw new SnapshotDeadlineError();
  }
  return analyzeRepositorySnapshotFacts(snapshots, {
    ...options,
    timeoutMs: remainingTimeout,
  });
}

export async function analyzeRepositorySnapshotFacts(
  requestedSnapshots: readonly RepositorySnapshot[],
  options: LocalAnalysisOptions = {},
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
    const segment = portableSegment(snapshot.name);
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
        throw new Error(`Invalid snapshot path: ${file.path}`);
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
      [
        diagnostic.code,
        snapshot.name,
        diagnostic.path,
        SNAPSHOT_WARNING_TEXT[diagnostic.code],
      ]
        .filter((part) => part !== undefined && part !== "")
        .join(": "),
    ),
  );
  const discoveredModules = (
    await Promise.all(
      contexts.map(async (context) => [
        ...(await discoverDotnetModules(context, guard)),
        ...(await discoverAngularModules(context, warnings, guard)),
      ]),
    )
  ).flat();
  const { solutions, solutionIdsByModule } = await discoverSolutions(
    contexts,
    discoveredModules,
    guard,
  );
  for (const candidate of discoveredModules) {
    guard.check();
    const solutionIds = solutionIdsByModule.get(candidate.module.id) ?? [];
    candidate.module = { ...candidate.module, solutionIds };
  }
  const sourceResult = await analyzeSources(
    contexts,
    discoveredModules,
    guard,
  );
  const allModules = [
    ...discoveredModules,
    ...sourceResult.unassignedModules,
  ].sort((left, right) => compareStable(left.module.id, right.module.id));
  const dependencies = buildDependencies(
    contexts,
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
    warnings: warnings.sort(compareStable),
  };
}
