import { promises as fs } from "node:fs";
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
  filesystemKey,
  isSourceFile,
  isWithin,
  repositoryRelative,
  validateRoots,
  walkLocalRoot,
} from "./filesystem.js";
import type {
  LocalAnalysisFacts,
  LocalAnalysisOptions,
  SourceFileFact,
  StaticImportFact,
} from "./types.js";
import { analyzeTypeScriptSource } from "./typescript-metrics.js";

interface RootContext {
  readonly absoluteRoot: string;
  readonly repository: CityRepository;
  readonly files: readonly string[];
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
  readonly absoluteRoot: string;
  readonly projectFile?: string;
  readonly projectReferences: readonly ProjectReference[];
  readonly packageReferences: readonly PackageReference[];
}

interface PendingSource {
  readonly absolutePath: string;
  readonly repositoryRoot: string;
  readonly fact: SourceFileFact;
  readonly imports: readonly StaticImportFact[];
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
    ? path.basename(value.replaceAll("\\", "/"))
    : value;
}

function repositoryName(root: string): string {
  return path.basename(root) || "Filesystem root";
}

function createRepositories(
  roots: readonly string[],
): readonly CityRepository[] {
  const occurrences = new Map<string, number>();
  return roots.map((root) => {
    const name = repositoryName(root);
    const nameKey =
      process.platform === "win32" ? name.toLocaleLowerCase("en-US") : name;
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
): Promise<readonly InternalModule[]> {
  const projectFiles = context.files.filter(
    (file) => path.extname(file).toLocaleLowerCase("en-US") === ".csproj",
  );
  return Promise.all(
    projectFiles.map(async (projectFile) => {
      const xml = withoutXmlComments(await fs.readFile(projectFile, "utf8"));
      const relativeProject = repositoryRelative(
        context.absoluteRoot,
        projectFile,
      );
      const frameworks = targetFrameworks(xml);
      const moduleName = redactAbsoluteReference(
        firstElement(xml, "AssemblyName") ??
          path.basename(projectFile, path.extname(projectFile)),
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
        absoluteRoot: path.dirname(projectFile),
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
): Promise<readonly InternalModule[]> {
  const workspaceFiles = context.files.filter(
    (file) => path.basename(file).toLocaleLowerCase("en-US") === "angular.json",
  );
  const modules: InternalModule[] = [];

  for (const workspaceFile of workspaceFiles) {
    const text = await fs.readFile(workspaceFile, "utf8");
    const config = parseJsonFile(workspaceFile, text);
    const projects =
      config?.["projects"] && typeof config["projects"] === "object"
        ? (config["projects"] as Record<string, unknown>)
        : undefined;
    if (!projects) {
      warnings.push(
        `${repositoryRelative(context.absoluteRoot, workspaceFile)}: invalid angular.json or missing projects`,
      );
      continue;
    }

    for (const projectName of Object.keys(projects).sort(compareStable)) {
      const project = projects[projectName];
      if (!project || typeof project !== "object") continue;
      const rootValue = (project as Record<string, unknown>)["root"];
      const configuredRoot = typeof rootValue === "string" ? rootValue : "";
      const absoluteRoot = path.resolve(path.dirname(workspaceFile), configuredRoot);
      if (!isWithin(context.absoluteRoot, absoluteRoot)) {
        warnings.push(
          `${repositoryRelative(context.absoluteRoot, workspaceFile)}: Angular project '${projectName}' escapes the repository root`,
        );
        continue;
      }
      const relativeRoot = repositoryRelative(context.absoluteRoot, absoluteRoot);
      const workspacePath = repositoryRelative(
        context.absoluteRoot,
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
        absoluteRoot,
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
    if (relative) paths.push(path.resolve(solutionDirectory, decodeXml(relative)));
  }
  return paths.sort(compareStable);
}

async function discoverSolutions(
  contexts: readonly RootContext[],
  modules: readonly InternalModule[],
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
        filesystemKey(candidate.projectFile),
        candidate.module,
      ]),
  );
  const solutions: CitySolution[] = [];
  const memberships = new Map<string, Set<string>>();

  for (const context of contexts) {
    for (const solutionFile of context.files.filter(
      (file) => path.extname(file).toLocaleLowerCase("en-US") === ".sln",
    )) {
      const relativePath = repositoryRelative(
        context.absoluteRoot,
        solutionFile,
      );
      const id = stableId(
        "solution",
        context.repository.id,
        normalizePath(relativePath),
      );
      const text = await fs.readFile(solutionFile, "utf8");
      const moduleIds = [
        ...new Set(
          solutionProjectPaths(text, path.dirname(solutionFile))
            .map((projectPath) =>
              byProjectPath.get(filesystemKey(projectPath)),
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
        name: path.basename(solutionFile, path.extname(solutionFile)),
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
  const extension = path.extname(filePath).toLocaleLowerCase("en-US");
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
        isWithin(candidate.absoluteRoot, sourcePath),
    )
    .sort(
      (left, right) =>
        right.absoluteRoot.length - left.absoluteRoot.length ||
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
    const extension = path.extname(options.logo).toLocaleLowerCase("en-US");
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
    for (const absolutePath of context.files.filter(isSourceFile)) {
      const language = languageOf(absolutePath);
      let selected = chooseModule(absolutePath, language, repositoryModules);
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
            absoluteRoot: context.absoluteRoot,
            projectReferences: [],
            packageReferences: [],
          };
          unassignedByRepository.set(context.repository.id, selected);
        }
      }

      const relativePath = normalizePath(
        repositoryRelative(context.absoluteRoot, absolutePath),
      );
      const directory = normalizePath(path.posix.dirname(relativePath));
      const districtId = stableId(
        "district",
        context.repository.id,
        selected.module.id,
      );
      const sourceText = await fs.readFile(absolutePath, "utf8");
      const analysis =
        language === "csharp"
          ? analyzeCSharpLexically(sourceText)
          : analyzeTypeScriptSource(absolutePath, sourceText);
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
        absolutePath,
        repositoryRoot: context.absoluteRoot,
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

function restrictedTypeScriptHost(
  authorizedRoots: readonly string[],
): RestrictedTypeScriptHost {
  const roots = authorizedRoots.map((root) => path.resolve(root));

  function withinAuthorizedRoot(candidate: string): boolean {
    return roots.some((root) => isWithin(root, candidate));
  }

  function permitted(candidate: string): boolean {
    const resolved = path.resolve(candidate);
    if (!withinAuthorizedRoot(resolved)) return false;
    if (
      ts.sys.fileExists(resolved) ||
      (ts.sys.directoryExists?.(resolved) ?? false)
    ) {
      const real = ts.sys.realpath?.(resolved) ?? resolved;
      return withinAuthorizedRoot(path.resolve(real));
    }
    return true;
  }

  return {
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
    fileExists: (fileName) =>
      permitted(fileName) && ts.sys.fileExists(fileName),
    readFile: (fileName) =>
      permitted(fileName) ? ts.sys.readFile(fileName) : undefined,
    // Only compiler options are consumed. Delegating to ts.sys.readDirectory
    // would let config expansion traverse symlinked directories before results
    // can be filtered.
    readDirectory: () => [],
    directoryExists: (directoryName) =>
      permitted(directoryName) &&
      (ts.sys.directoryExists?.(directoryName) ?? false),
    getDirectories: () => [],
    realpath: (candidate) => {
      if (!permitted(candidate)) return candidate;
      const real = ts.sys.realpath?.(candidate) ?? candidate;
      return permitted(real) ? real : candidate;
    },
  };
}

function parseCompilerOptions(
  configPath: string,
  authorizedRoots: readonly string[],
): ts.CompilerOptions {
  const host = restrictedTypeScriptHost(authorizedRoots);
  const read = ts.readConfigFile(configPath, host.readFile);
  if (read.error) return {};
  return ts.parseJsonConfigFileContent(
    read.config,
    host,
    path.dirname(configPath),
    undefined,
    configPath,
  ).options;
}

function compilerOptionsFor(
  sourcePath: string,
  repositoryRoot: string,
  authorizedRoots: readonly string[],
  configFiles: readonly string[],
  cache: Map<string, ts.CompilerOptions>,
): ts.CompilerOptions {
  function directoryDepth(configPath: string): number {
    const relative = path.relative(repositoryRoot, path.dirname(configPath));
    if (relative === "") return 0;
    return relative.split(path.sep).filter(Boolean).length;
  }

  const selected = configFiles
    .filter((config) => isWithin(path.dirname(config), sourcePath))
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
  const parsed = parseCompilerOptions(selected, authorizedRoots);
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
): readonly CityDependency[] {
  const dependencies: CityDependency[] = [];
  const moduleByProjectPath = new Map(
    modules
      .filter(
        (candidate): candidate is InternalModule & { projectFile: string } =>
          candidate.projectFile !== undefined,
      )
      .map((candidate) => [
        filesystemKey(candidate.projectFile),
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
    if (!candidate.projectFile) continue;
    for (const reference of candidate.projectReferences) {
      const target = moduleByProjectPath.get(
        filesystemKey(
          path.resolve(path.dirname(candidate.projectFile), reference.include),
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
          kind: "project-reference",
          weight: 1,
        });
      }
    }
    for (const reference of candidate.packageReferences) {
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
      filesystemKey(source.absolutePath),
      source.fact,
    ]),
  );
  const configsByRoot = new Map<string, readonly string[]>();
  for (const context of contexts) {
    configsByRoot.set(
      context.absoluteRoot,
      context.files.filter((file) =>
        /^tsconfig(?:\..+)?\.json$/iu.test(path.basename(file)),
      ),
    );
  }
  const compilerOptionsCache = new Map<string, ts.CompilerOptions>();
  const authorizedRoots = contexts.map((context) => context.absoluteRoot);
  const resolutionHost = restrictedTypeScriptHost(authorizedRoots);

  for (const source of sources) {
    if (source.fact.language === "csharp") continue;
    const configs = configsByRoot.get(source.repositoryRoot) ?? [];
    const options = compilerOptionsFor(
      source.absolutePath,
      source.repositoryRoot,
      authorizedRoots,
      configs,
      compilerOptionsCache,
    );
    for (const imported of source.imports) {
      const resolved = ts.resolveModuleName(
        imported.specifier,
        source.absolutePath,
        options,
        resolutionHost,
      ).resolvedModule?.resolvedFileName;
      const target = resolved
        ? sourceByPath.get(
            filesystemKey(resolved),
          )
        : undefined;
      if (target?.id === source.fact.id) continue;
      dependencies.push({
        id: stableId(
          "dependency",
          "typescript-import",
          source.fact.id,
          target?.id ?? packageGateway(imported.specifier),
        ),
        repositoryId: source.fact.repositoryId,
        sourceId: source.fact.id,
        ...(target
          ? { targetId: target.id }
          : { externalTarget: packageGateway(imported.specifier) }),
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
  const roots = await validateRoots(requestedRoots);
  const repositories = createRepositories(roots);
  const contexts: RootContext[] = await Promise.all(
    roots.map(async (absoluteRoot, index) => ({
      absoluteRoot,
      repository: repositories[index]!,
      files: await walkLocalRoot(absoluteRoot),
    })),
  );
  const warnings: string[] = [];
  const discoveredModules = (
    await Promise.all(
      contexts.map(async (context) => [
        ...(await discoverDotnetModules(context)),
        ...(await discoverAngularModules(context, warnings)),
      ]),
    )
  ).flat();
  const { solutions, solutionIdsByModule } = await discoverSolutions(
    contexts,
    discoveredModules,
  );
  for (const candidate of discoveredModules) {
    const solutionIds = solutionIdsByModule.get(candidate.module.id) ?? [];
    candidate.module = { ...candidate.module, solutionIds };
  }
  const sourceResult = await analyzeSources(contexts, discoveredModules);
  const allModules = [
    ...discoveredModules,
    ...sourceResult.unassignedModules,
  ].sort((left, right) => compareStable(left.module.id, right.module.id));
  const dependencies = buildDependencies(
    contexts,
    allModules,
    sourceResult.sources,
  );

  const identity = explicitIdentity(options);
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
