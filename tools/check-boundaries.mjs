import { randomUUID } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { API } from "typescript/unstable/sync";
import {
  SyntaxKind,
  isCallExpression,
  isExportDeclaration,
  isImportDeclaration,
  isStringLiteral,
} from "typescript/unstable/ast";

const SOURCE_EXTENSIONS = new Set([".cts", ".mts", ".ts", ".tsx"]);
const LAYERS = new Set(["edge", "application", "domain"]);
const WORKER_URL_SUFFIX = "?worker&url";

const ALLOWED_TARGETS = {
  edge: new Set(["edge", "application", "domain", "outside-src"]),
  application: new Set(["application", "domain"]),
  domain: new Set(["domain"]),
};

function lexicalCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function virtualKey(value) {
  const normalized = path.normalize(path.resolve(value));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function pathForClassification(value) {
  try {
    return realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

function classifyPath(rootDirectory, filePath) {
  const relativePath = toPosix(path.relative(rootDirectory, pathForClassification(filePath)));
  if (relativePath === "" || relativePath === ".." || relativePath.startsWith("../") || path.posix.isAbsolute(relativePath)) {
    return { layer: "outside-src", relativePath };
  }

  const segments = relativePath.split("/");
  if (segments[0] !== "src") {
    return { layer: "outside-src", relativePath };
  }
  if (segments.length >= 3 && LAYERS.has(segments[1])) {
    return { layer: segments[1], relativePath };
  }
  return { layer: "unclassified", relativePath };
}

async function collectSourceFiles(sourceDirectory, prefix = "") {
  const entries = await readdir(sourceDirectory, { withFileTypes: true });
  entries.sort((left, right) => lexicalCompare(left.name, right.name));
  const files = [];

  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolutePath = path.join(sourceDirectory, entry.name);
    const metadata = await lstat(absolutePath);
    if (metadata.isSymbolicLink()) {
      throw new Error(`Source tree contains a symbolic link: src/${relativePath}`);
    }
    if (metadata.isDirectory()) {
      files.push(...await collectSourceFiles(absolutePath, relativePath));
    } else if (metadata.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(absolutePath);
    }
  }
  return files;
}

function createVirtualFileSystem(files) {
  const contentByPath = new Map([...files].map(([filePath, content]) => [virtualKey(filePath), content]));
  return {
    fileExists(filePath) {
      return contentByPath.has(virtualKey(filePath)) ? true : undefined;
    },
    readFile(filePath) {
      return contentByPath.get(virtualKey(filePath));
    },
  };
}

function withCompilerProject(rootDirectory, sourceFiles, virtualFiles, callback) {
  const configPath = path.join(rootDirectory, `.code-city-boundaries-${randomUUID()}.json`);
  const compilerConfig = {
    compilerOptions: {
      allowArbitraryExtensions: true,
      allowImportingTsExtensions: true,
      allowJs: true,
      checkJs: false,
      lib: ["ES2024"],
      module: "ESNext",
      moduleResolution: "Bundler",
      noEmit: true,
      skipLibCheck: true,
      target: "ES2024",
      types: [],
    },
    files: sourceFiles,
  };
  const allVirtualFiles = new Map(virtualFiles);
  allVirtualFiles.set(configPath, `${JSON.stringify(compilerConfig)}\n`);

  const api = new API({
    cwd: rootDirectory,
    fs: createVirtualFileSystem(allVirtualFiles),
  });
  let snapshot;
  try {
    api.parseConfigFile(configPath);
    snapshot = api.updateSnapshot({ openProjects: [configPath] });
    const project = snapshot.getProject(configPath) ?? snapshot.getProjects()[0];
    if (!project) {
      throw new Error("TypeScript did not create a boundary-analysis project");
    }
    return callback(project);
  } finally {
    snapshot?.dispose();
    api.close();
  }
}

function sourcePosition(sourceFile, node) {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { line: position.line + 1, column: position.character + 1 };
}

function collectReferences(sourceFile) {
  const references = [];

  function visit(node) {
    if (isImportDeclaration(node)) {
      const position = sourcePosition(sourceFile, node);
      if (isStringLiteral(node.moduleSpecifier)) {
        references.push({
          kind: node.importClause?.phaseModifier === SyntaxKind.TypeKeyword ? "type-only import" : "ordinary import",
          node: node.moduleSpecifier,
          specifier: node.moduleSpecifier.text,
          ...position,
        });
      } else {
        references.push({ kind: "ordinary import", node: undefined, specifier: undefined, ...position });
      }
    } else if (isExportDeclaration(node) && node.moduleSpecifier) {
      const position = sourcePosition(sourceFile, node);
      if (isStringLiteral(node.moduleSpecifier)) {
        references.push({
          kind: node.isTypeOnly ? "type-only re-export" : "re-export",
          node: node.moduleSpecifier,
          specifier: node.moduleSpecifier.text,
          ...position,
        });
      } else {
        references.push({ kind: "re-export", node: undefined, specifier: undefined, ...position });
      }
    } else if (isCallExpression(node) && node.expression.kind === SyntaxKind.ImportKeyword) {
      const position = sourcePosition(sourceFile, node);
      const argument = node.arguments.length === 1 ? node.arguments[0] : undefined;
      if (argument && isStringLiteral(argument)) {
        references.push({
          kind: "string-literal dynamic import",
          node: argument,
          specifier: argument.text,
          ...position,
        });
      } else {
        references.push({ kind: "non-literal dynamic import", node: undefined, specifier: undefined, ...position });
      }
    }
    node.forEachChild((child) => {
      visit(child);
      return undefined;
    });
  }

  visit(sourceFile);
  return references;
}

function inspectQuery(specifier) {
  const queryIndex = specifier.indexOf("?");
  if (queryIndex === -1) {
    return { type: "none", resolvedSpecifier: specifier };
  }
  const suffixIndex = specifier.length - WORKER_URL_SUFFIX.length;
  if (suffixIndex > 0 && queryIndex === suffixIndex && specifier.endsWith(WORKER_URL_SUFFIX)) {
    return { type: "worker-url", resolvedSpecifier: specifier.slice(0, suffixIndex) };
  }
  return { type: "unknown", resolvedSpecifier: undefined };
}

function isLocalSpecifier(specifier) {
  return specifier.startsWith(".")
    || specifier.startsWith("/")
    || /^[A-Za-z]:[\\/]/.test(specifier)
    || specifier.startsWith("file:");
}

function resolveModulePath(checker, moduleSpecifierNode) {
  const symbol = checker.getSymbolAtLocation(moduleSpecifierNode);
  if (!symbol) {
    return undefined;
  }
  const handles = [symbol.valueDeclaration, ...symbol.declarations].filter(Boolean);
  for (const handle of handles) {
    if (handle.path) {
      return pathForClassification(String(handle.path));
    }
  }
  return undefined;
}

function displayResolvedPath(rootDirectory, resolvedPath) {
  const relativePath = toPosix(path.relative(rootDirectory, resolvedPath));
  if (relativePath !== ".." && !relativePath.startsWith("../") && !path.posix.isAbsolute(relativePath)) {
    return relativePath;
  }
  return toPosix(resolvedPath);
}

function formatSpecifier(specifier) {
  return specifier === undefined ? "<non-literal>" : JSON.stringify(specifier);
}

export class BoundaryError extends Error {
  constructor(violations) {
    const details = violations.map((violation) => (
      `- ${violation.source}:${violation.line}:${violation.column} ${violation.kind} ${formatSpecifier(violation.specifier)}: ${violation.reason}`
    ));
    super(`Boundary check failed with ${violations.length} violation(s):\n${details.join("\n")}`);
    this.name = "BoundaryError";
    this.violations = violations;
  }
}

export async function checkBoundaries(rootDirectory = process.cwd()) {
  const root = await realpath(path.resolve(rootDirectory));
  const sourceDirectory = path.join(root, "src");
  const sourceFiles = await collectSourceFiles(sourceDirectory);
  if (sourceFiles.length === 0) {
    throw new Error("Boundary check found no TypeScript source files under src");
  }

  const violations = [];
  const evidence = [];
  const sourceLayers = new Map();
  for (const sourceFile of sourceFiles) {
    const classification = classifyPath(root, sourceFile);
    sourceLayers.set(virtualKey(sourceFile), classification);
    if (!LAYERS.has(classification.layer)) {
      violations.push({
        source: classification.relativePath,
        line: 1,
        column: 1,
        kind: "source file",
        specifier: undefined,
        reason: "TypeScript source must be classified under src/edge, src/application, or src/domain",
      });
    }
  }

  const workerQueries = [];
  withCompilerProject(root, sourceFiles, new Map(), (project) => {
    const parseDiagnostics = project.program.getSyntacticDiagnostics();
    if (parseDiagnostics.length > 0) {
      throw new Error(`TypeScript parser reported ${parseDiagnostics.length} diagnostic(s) while checking boundaries`);
    }

    for (const sourcePath of sourceFiles) {
      const sourceClassification = sourceLayers.get(virtualKey(sourcePath));
      if (!LAYERS.has(sourceClassification.layer)) {
        continue;
      }
      const sourceFile = project.program.getSourceFile(sourcePath);
      if (!sourceFile) {
        throw new Error(`TypeScript did not parse ${sourceClassification.relativePath}`);
      }

      for (const reference of collectReferences(sourceFile)) {
        const common = {
          source: sourceClassification.relativePath,
          sourceLayer: sourceClassification.layer,
          line: reference.line,
          column: reference.column,
          kind: reference.kind,
          specifier: reference.specifier,
        };

        if (reference.kind === "non-literal dynamic import" || !reference.node || reference.specifier === undefined) {
          violations.push({ ...common, reason: "dynamic and module imports must use a string literal" });
          continue;
        }

        const query = inspectQuery(reference.specifier);
        if (query.type === "unknown") {
          violations.push({ ...common, reason: "unknown import query suffix is forbidden" });
          continue;
        }
        if (query.type === "worker-url") {
          if (!isLocalSpecifier(query.resolvedSpecifier)) {
            violations.push({ ...common, reason: "?worker&url must target a local module" });
          } else {
            workerQueries.push({ ...common, resolvedSpecifier: query.resolvedSpecifier });
          }
          continue;
        }

        const resolvedPath = resolveModulePath(project.checker, reference.node);
        if (!resolvedPath && isLocalSpecifier(reference.specifier)) {
          violations.push({ ...common, reason: "unresolved local target" });
          continue;
        }
        const targetClassification = resolvedPath
          ? classifyPath(root, resolvedPath)
          : { layer: "outside-src", relativePath: undefined };
        evidence.push({
          ...common,
          resolved: resolvedPath ? displayResolvedPath(root, resolvedPath) : null,
          targetLayer: targetClassification.layer,
        });
        if (!ALLOWED_TARGETS[sourceClassification.layer].has(targetClassification.layer)) {
          violations.push({
            ...common,
            reason: `${sourceClassification.layer} -> ${targetClassification.layer} is forbidden`,
          });
        }
      }
    }
  });

  if (workerQueries.length > 0) {
    const virtualFiles = new Map();
    const probeByPath = new Map();
    const allFiles = [...sourceFiles];
    for (const [index, query] of workerQueries.entries()) {
      let probePath;
      do {
        probePath = path.join(
          path.dirname(path.join(root, ...query.source.split("/"))),
          `.code-city-worker-resolution-${process.pid}-${index}-${randomUUID()}.ts`,
        );
      } while (existsSync(probePath));
      virtualFiles.set(probePath, `import ${JSON.stringify(query.resolvedSpecifier)};\n`);
      probeByPath.set(virtualKey(probePath), query);
      allFiles.push(probePath);
    }

    withCompilerProject(root, allFiles, virtualFiles, (project) => {
      for (const probePath of virtualFiles.keys()) {
        const query = probeByPath.get(virtualKey(probePath));
        const probe = project.program.getSourceFile(probePath);
        const importDeclaration = probe?.statements[0];
        if (!importDeclaration || !isImportDeclaration(importDeclaration) || !isStringLiteral(importDeclaration.moduleSpecifier)) {
          throw new Error(`TypeScript did not parse worker resolution probe for ${query.source}`);
        }
        const resolvedPath = resolveModulePath(project.checker, importDeclaration.moduleSpecifier);
        if (!resolvedPath) {
          violations.push({ ...query, reason: "unresolved local target after stripping exact ?worker&url suffix" });
          continue;
        }
        const targetClassification = classifyPath(root, resolvedPath);
        evidence.push({
          source: query.source,
          sourceLayer: query.sourceLayer,
          line: query.line,
          column: query.column,
          kind: query.kind,
          specifier: query.specifier,
          resolved: displayResolvedPath(root, resolvedPath),
          targetLayer: targetClassification.layer,
        });
        if (!ALLOWED_TARGETS[query.sourceLayer].has(targetClassification.layer)) {
          violations.push({
            source: query.source,
            sourceLayer: query.sourceLayer,
            line: query.line,
            column: query.column,
            kind: query.kind,
            specifier: query.specifier,
            reason: `${query.sourceLayer} -> ${targetClassification.layer} is forbidden after stripping exact ?worker&url suffix`,
          });
        }
      }
    });
  }

  violations.sort((left, right) => lexicalCompare(
    `${left.source}:${String(left.line).padStart(8, "0")}:${left.kind}:${left.specifier ?? ""}`,
    `${right.source}:${String(right.line).padStart(8, "0")}:${right.kind}:${right.specifier ?? ""}`,
  ));
  evidence.sort((left, right) => lexicalCompare(
    `${left.source}:${String(left.line).padStart(8, "0")}:${left.kind}:${left.specifier}`,
    `${right.source}:${String(right.line).padStart(8, "0")}:${right.kind}:${right.specifier}`,
  ));

  if (violations.length > 0) {
    throw new BoundaryError(violations);
  }
  return { filesChecked: sourceFiles.length, imports: evidence };
}

const invokedPath = process.argv[1] && path.resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  const result = await checkBoundaries(process.argv[2] ?? process.cwd());
  console.log(`Boundary check passed for ${result.filesChecked} source files and ${result.imports.length} imports.`);
}
