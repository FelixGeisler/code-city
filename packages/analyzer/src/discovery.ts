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
  type RoslynFileFact,
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
import { analyzeTypeScriptSource } from "./typescript-metrics.js";

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

interface DeferredCSharpSource {
  readonly id: string;
  readonly context: RootContext;
  readonly selected: InternalModule;
  readonly sourcePath: string;
  readonly relativePath: string;
  readonly sourceText: string;
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
  modules: InternalModule[],
  warnings: string[],
  guard: AnalysisGuard,
): Promise<{
  readonly sources: readonly PendingSource[];
  readonly unassignedModules: readonly InternalModule[];
}> {
  const pendingSources: PendingSource[] = [];
  const csharpSources: DeferredCSharpSource[] = [];
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

      const relativePath = safeRepositoryRelativePath(
        virtualRelative(context.virtualRoot, sourcePath),
      );
      const sourceText = snapshotText(context, sourcePath);
      if (language === "csharp") {
        csharpSources.push({
          id: `source-${String(csharpSources.length + 1).padStart(6, "0")}.cs`,
          context,
          selected,
          sourcePath,
          relativePath,
          sourceText,
        });
        continue;
      }

      const analysis = analyzeTypeScriptSource(sourcePath, sourceText);
      if (analysis.hasSyntaxErrors) {
        warnings.push(
          sanitizeWarningText(
            `${relativePath}: TypeScript/JavaScript syntax errors; source skipped`,
          ),
        );
        continue;
      }
      const imports = sanitizedImports(analysis.imports);
      pendingSources.push(
        pendingSource(
          context,
          selected,
          sourcePath,
          relativePath,
          sourceText,
          language,
          {
            sloc: analysis.sloc,
            decisionLoad: analysis.decisionLoad,
            maximumComplexity: analysis.maximumComplexity,
            executableUnitCount: analysis.executableUnitCount,
          },
          "typescript-compiler-api-v1",
          analysis.units,
          imports,
          analysis.sourceStructure,
        ),
      );
    }
  }

  if (csharpSources.length > 0) {
    guard.check();
    const launch = await resolveBundledRoslynLaunch();
    guard.check();
    const outcomes = await analyzeCSharpWithRoslyn(
      csharpSources.map(({ id, sourceText }) => ({ id, source: sourceText })),
      launch,
      {
        timeoutMs: Math.min(
          guard.remainingMs(),
          ROSLYN_HOST_LIMITS.timeoutMs,
        ),
        ...(guard.signal === undefined ? {} : { signal: guard.signal }),
      },
    );
    const byId = new Map(csharpSources.map((source) => [source.id, source]));
    for (const outcome of outcomes) {
      guard.check();
      const source = byId.get(outcome.id);
      if (!source) {
        throw new Error("Roslyn helper returned an unknown source identifier.");
      }
      if (outcome.status === "skipped") {
        warnings.push(
          sanitizeWarningText(
            `${source.relativePath}: C# source exceeded the Roslyn unit limit and was skipped`,
          ),
        );
        continue;
      }
      if (outcome.warnings.includes("syntax-errors-present")) {
        warnings.push(
          sanitizeWarningText(
            `${source.relativePath}: C# syntax errors; source skipped`,
          ),
        );
        continue;
      }
      const result: RoslynFileFact = outcome;
      pendingSources.push(
        pendingSource(
          source.context,
          source.selected,
          source.sourcePath,
          source.relativePath,
          source.sourceText,
          "csharp",
          result.metrics,
          result.metricMethod,
          result.units,
          [],
          result.sourceStructure,
        ),
      );
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
  const discoveredModules = (
    await Promise.all(
      contexts.map(async (context) => [
        ...(await discoverDotnetModules(context, warnings, guard)),
        ...(await discoverAngularModules(context, warnings, guard)),
      ]),
    )
  ).flat();
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
  const sourceResult = await analyzeSources(
    contexts,
    discoveredModules,
    warnings,
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
    warnings: boundedWarnings(warnings),
  };
}
