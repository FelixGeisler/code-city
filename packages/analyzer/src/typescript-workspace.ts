import path from "node:path";

import { API, type Project, type Snapshot } from "typescript/unstable/sync";
import {
  createVirtualFileSystem,
  type FileSystem,
} from "typescript/unstable/fs";
import * as ast from "typescript/unstable/ast";

const VIRTUAL_WORKSPACE_ROOT = "/code-city";

export interface TypeScriptWorkspaceFile {
  readonly path: string;
  readonly text: string;
}

function workspaceFileSystem(
  files: Readonly<Record<string, string>>,
): FileSystem {
  const virtual = createVirtualFileSystem({ ...files });
  const isWorkspacePath = (candidate: string): boolean =>
    candidate === VIRTUAL_WORKSPACE_ROOT ||
    candidate.startsWith(`${VIRTUAL_WORKSPACE_ROOT}/`);
  return {
    ...virtual,
    directoryExists: (directoryName) =>
      isWorkspacePath(directoryName)
        ? (virtual.directoryExists?.(directoryName) ?? false)
        : false,
    fileExists: (fileName) =>
      isWorkspacePath(fileName)
        ? (virtual.fileExists?.(fileName) ?? false)
        : false,
    getAccessibleEntries: (directoryName) =>
      isWorkspacePath(directoryName)
        ? (virtual.getAccessibleEntries?.(directoryName) ?? {
            files: [],
            directories: [],
          })
        : { files: [], directories: [] },
    readFile: (fileName) =>
      isWorkspacePath(fileName)
        ? (virtual.readFile?.(fileName) ?? null)
        : null,
  };
}

function projectForFile(
  snapshot: Snapshot,
  filePath: string,
): Project | undefined {
  const preferred = snapshot.getDefaultProjectForFile(filePath);
  if (preferred?.program.getSourceFile(filePath) !== undefined) return preferred;
  return snapshot
    .getProjects()
    .find((project) => project.program.getSourceFile(filePath) !== undefined);
}

function resolvedWorkspaceFile(
  candidate: string,
  workspaceFiles: ReadonlySet<string>,
): string | undefined {
  const normalized = path.posix.normalize(candidate);
  const extension = path.posix.extname(normalized);
  const stem = extension === ".js" || extension === ".jsx" ||
      extension === ".mjs" || extension === ".cjs"
    ? normalized.slice(0, -extension.length)
    : normalized;
  const candidates = [
    normalized,
    stem,
    `${stem}.ts`,
    `${stem}.tsx`,
    `${stem}.d.ts`,
    `${stem}.mts`,
    `${stem}.cts`,
    `${stem}.js`,
    `${stem}.jsx`,
    `${stem}/index.ts`,
    `${stem}/index.tsx`,
    `${stem}/index.d.ts`,
    `${stem}/index.js`,
    `${stem}/index.jsx`,
  ];
  return candidates.find((filePath) => workspaceFiles.has(filePath));
}

function pathPatternMatch(
  pattern: string,
  specifier: string,
): string | undefined {
  const wildcard = pattern.indexOf("*");
  if (wildcard === -1) return pattern === specifier ? "" : undefined;
  const prefix = pattern.slice(0, wildcard);
  const suffix = pattern.slice(wildcard + 1);
  return specifier.startsWith(prefix) && specifier.endsWith(suffix)
    ? specifier.slice(prefix.length, specifier.length - suffix.length)
    : undefined;
}

function isModuleSpecifier(node: ast.Node, specifier: string): boolean {
  if (!ast.isStringLiteralLikeNode(node) || node.text !== specifier) {
    return false;
  }
  const parent = node.parent;
  if (
    (ast.isImportDeclaration(parent) || ast.isExportDeclaration(parent)) &&
    parent.moduleSpecifier === node
  ) {
    return true;
  }
  if (
    ast.isExternalModuleReference(parent) &&
    parent.expression === node
  ) {
    return true;
  }
  return (
    ast.isCallExpression(parent) &&
    parent.arguments.length === 1 &&
    parent.arguments[0] === node &&
    (parent.expression.kind === ast.SyntaxKind.ImportKeyword ||
      (ast.isIdentifier(parent.expression) &&
        parent.expression.text === "require"))
  );
}

export class TypeScriptWorkspace implements Disposable {
  readonly #api: API;
  readonly #snapshot: Snapshot;
  readonly #workspaceFiles: ReadonlySet<string>;
  #disposed = false;

  public constructor(files: readonly TypeScriptWorkspaceFile[]) {
    const textByPath = Object.fromEntries(
      files.map((file) => [file.path, file.text]),
    );
    this.#workspaceFiles = new Set(Object.keys(textByPath));
    this.#api = new API({
      cwd: VIRTUAL_WORKSPACE_ROOT,
      fs: workspaceFileSystem(textByPath),
    });
    try {
      const configFiles = files
        .map((file) => file.path)
        .filter((filePath) =>
          /^tsconfig(?:\..+)?\.json$/iu.test(path.posix.basename(filePath)),
        );
      const sourceFiles = files
        .map((file) => file.path)
        .filter((filePath) => /\.[cm]?[jt]sx?$/iu.test(filePath));
      this.#snapshot = this.#api.updateSnapshot({
        ...(configFiles.length === 0 ? {} : { openProjects: configFiles }),
        ...(sourceFiles.length === 0 ? {} : { openFiles: sourceFiles }),
      });
    } catch (error) {
      this.#api.close();
      throw error;
    }
  }

  public sourceFile(filePath: string): ast.SourceFile | undefined {
    this.#assertOpen();
    return projectForFile(this.#snapshot, filePath)?.program.getSourceFile(
      filePath,
    );
  }

  public hasSyntacticErrors(filePath: string): boolean {
    this.#assertOpen();
    const project = projectForFile(this.#snapshot, filePath);
    return (
      project === undefined ||
      project.program.getSyntacticDiagnostics(filePath).length > 0
    );
  }

  public resolveImport(
    filePath: string,
    specifier: string,
  ): string | undefined {
    this.#assertOpen();
    const project = projectForFile(this.#snapshot, filePath);
    const source = project?.program.getSourceFile(filePath);
    if (project === undefined || source === undefined) return undefined;
    let resolved: string | undefined;
    const visit = (node: ast.Node): void => {
      if (resolved !== undefined) return;
      if (isModuleSpecifier(node, specifier)) {
        const symbol = project.checker.getSymbolAtLocation(node);
        resolved = symbol?.declarations
          .map((declaration) => declaration.path as string)
          .find((candidate) => this.#workspaceFiles.has(candidate));
      }
      if (resolved === undefined) node.forEachChild(visit);
    };
    visit(source);
    if (resolved !== undefined) return resolved;

    const options = project.compilerOptions as typeof project.compilerOptions & {
      readonly baseUrl?: string;
      readonly pathsBasePath?: string;
    };
    if (specifier.startsWith(".")) {
      return resolvedWorkspaceFile(
        path.posix.resolve(path.posix.dirname(filePath), specifier),
        this.#workspaceFiles,
      );
    }
    // The checker resolves ordinary static imports. TypeScript 7 currently
    // omits a module symbol for some literal dynamic imports using `paths`, so
    // reproduce its documented exact/longest-prefix path precedence from the
    // effective native compiler options for that bounded fallback only.
    const paths = options.paths;
    if (paths !== undefined) {
      const matches = Object.entries(paths)
        .map(([pattern, substitutions]) => ({
          pattern,
          substitutions,
          wildcard: pathPatternMatch(pattern, specifier),
        }))
        .filter(
          (match): match is typeof match & { readonly wildcard: string } =>
            match.wildcard !== undefined,
        )
        .sort(
          (left, right) =>
            Number(left.pattern.includes("*")) -
              Number(right.pattern.includes("*")) ||
            right.pattern.indexOf("*") - left.pattern.indexOf("*") ||
            left.pattern.localeCompare(right.pattern, "en-US"),
        );
      for (const { substitutions, wildcard } of matches) {
        for (const substitution of substitutions) {
          const candidate = substitution.replace("*", wildcard);
          const target = resolvedWorkspaceFile(
            path.posix.resolve(
              options.baseUrl ?? options.pathsBasePath ??
                path.posix.dirname(project.configFileName),
              candidate,
            ),
            this.#workspaceFiles,
          );
          if (target !== undefined) return target;
        }
      }
    }
    return options.baseUrl === undefined
      ? undefined
      : resolvedWorkspaceFile(
          path.posix.resolve(options.baseUrl, specifier),
          this.#workspaceFiles,
        );
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    try {
      this.#snapshot.dispose();
    } finally {
      this.#api.close();
    }
  }

  public [Symbol.dispose](): void {
    this.dispose();
  }

  #assertOpen(): void {
    if (this.#disposed) {
      throw new Error("TypeScript workspace has been disposed.");
    }
  }
}

export function withTypeScriptSource<T>(
  filePath: string,
  sourceText: string,
  action: (
    sourceFile: ast.SourceFile,
    hasSyntacticErrors: boolean,
  ) => T,
): T {
  const extension = path.posix.extname(filePath) || ".ts";
  const virtualPath = `${VIRTUAL_WORKSPACE_ROOT}/standalone/source${extension}`;
  using workspace = new TypeScriptWorkspace([
    { path: virtualPath, text: sourceText },
  ]);
  const sourceFile = workspace.sourceFile(virtualPath);
  if (sourceFile === undefined) {
    throw new Error("TypeScript 7 did not return the requested source file.");
  }
  return action(sourceFile, workspace.hasSyntacticErrors(virtualPath));
}
