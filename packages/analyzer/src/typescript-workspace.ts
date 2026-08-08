import path from "node:path";
import type { ChildProcess } from "node:child_process";

import { API, type Project, type Snapshot } from "typescript/unstable/async";
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

export interface TypeScriptWorkspaceExecution {
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  /** @internal Test seam for native lifecycle failures. */
  readonly nativeApiFactory?: () => API;
}

export class TypeScriptWorkspaceTimeoutError extends Error {
  public constructor() {
    super("TypeScript native analysis exceeded its deadline.");
    this.name = "TypeScriptWorkspaceTimeoutError";
  }
}

interface NativeProcessAccess {
  readonly client?: {
    readonly process?: ChildProcess;
  };
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

async function projectForFile(
  snapshot: Snapshot,
  filePath: string,
): Promise<Project | undefined> {
  const preferred = await snapshot.getDefaultProjectForFile(filePath);
  if (
    preferred !== undefined &&
    await preferred.program.getSourceFile(filePath) !== undefined
  ) {
    return preferred;
  }
  for (const project of snapshot.getProjects()) {
    if (await project.program.getSourceFile(filePath) !== undefined) {
      return project;
    }
  }
  return undefined;
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

export class TypeScriptWorkspace implements AsyncDisposable {
  readonly #api: API;
  readonly #workspaceFiles: ReadonlySet<string>;
  readonly #deadlineAt: number;
  readonly #signal: AbortSignal | undefined;
  #snapshot: Snapshot | undefined;
  #disposed = false;
  #interrupted = false;

  private constructor(
    files: readonly TypeScriptWorkspaceFile[],
    execution: TypeScriptWorkspaceExecution,
  ) {
    if (!Number.isFinite(execution.timeoutMs) || execution.timeoutMs <= 0) {
      throw new TypeScriptWorkspaceTimeoutError();
    }
    const textByPath = Object.fromEntries(
      files.map((file) => [file.path, file.text]),
    );
    this.#workspaceFiles = new Set(Object.keys(textByPath));
    this.#deadlineAt = Date.now() + execution.timeoutMs;
    this.#signal = execution.signal;
    this.#api = execution.nativeApiFactory?.() ?? new API({
      cwd: VIRTUAL_WORKSPACE_ROOT,
      fs: workspaceFileSystem(textByPath),
    });
  }

  public static async create(
    files: readonly TypeScriptWorkspaceFile[],
    execution: TypeScriptWorkspaceExecution,
  ): Promise<TypeScriptWorkspace> {
    const workspace = new TypeScriptWorkspace(files, execution);
    try {
      const configFiles = files
        .map((file) => file.path)
        .filter((filePath) =>
          /^tsconfig(?:\..+)?\.json$/iu.test(path.posix.basename(filePath)),
        );
      const sourceFiles = files
        .map((file) => file.path)
        .filter((filePath) => /\.[cm]?[jt]sx?$/iu.test(filePath));
      workspace.#snapshot = await workspace.#run(() =>
        workspace.#api.updateSnapshot({
          ...(configFiles.length === 0 ? {} : { openProjects: configFiles }),
          ...(sourceFiles.length === 0 ? {} : { openFiles: sourceFiles }),
        }),
      );
      return workspace;
    } catch (error) {
      await workspace.dispose();
      throw error;
    }
  }

  public async sourceFile(
    filePath: string,
  ): Promise<ast.SourceFile | undefined> {
    return this.#run(async () => {
      const snapshot = this.#requiredSnapshot();
      return (await projectForFile(snapshot, filePath))?.program.getSourceFile(
        filePath,
      );
    });
  }

  public async hasSyntacticErrors(filePath: string): Promise<boolean> {
    return this.#run(async () => {
      const snapshot = this.#requiredSnapshot();
      const project = await projectForFile(snapshot, filePath);
      return (
        project === undefined ||
        (await project.program.getSyntacticDiagnostics(filePath)).length > 0
      );
    });
  }

  public async resolveImport(
    filePath: string,
    specifier: string,
  ): Promise<string | undefined> {
    return this.#run(async () => {
      const snapshot = this.#requiredSnapshot();
      const project = await projectForFile(snapshot, filePath);
      const source = await project?.program.getSourceFile(filePath);
      if (project === undefined || source === undefined) return undefined;
      let moduleNode: ast.Node | undefined;
      const visit = (node: ast.Node): void => {
        if (moduleNode !== undefined) return;
        if (isModuleSpecifier(node, specifier)) moduleNode = node;
        else node.forEachChild(visit);
      };
      visit(source);
      if (moduleNode !== undefined) {
        const symbol = await project.checker.getSymbolAtLocation(moduleNode);
        const resolved = symbol?.declarations
          .map((declaration) => declaration.path as string)
          .find((candidate) => this.#workspaceFiles.has(candidate));
        if (resolved !== undefined) return resolved;
      }

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
      // TypeScript 7 currently omits a module symbol for some literal dynamic
      // imports using `paths`; reproduce exact/longest-prefix precedence from
      // the effective native options for that bounded fallback only.
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
    });
  }

  public async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    try {
      if (!this.#interrupted) await this.#snapshot?.dispose();
    } finally {
      await this.#api.close();
    }
  }

  public async [Symbol.asyncDispose](): Promise<void> {
    await this.dispose();
  }

  #requiredSnapshot(): Snapshot {
    if (this.#snapshot === undefined) {
      throw new Error("TypeScript workspace has not initialized.");
    }
    return this.#snapshot;
  }

  async #run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#disposed) {
      throw new Error("TypeScript workspace has been disposed.");
    }
    if (this.#interrupted) {
      throw new Error("TypeScript native analysis was interrupted.");
    }
    if (this.#signal?.aborted) {
      throw this.#signal.reason ?? new Error("TypeScript analysis was cancelled.");
    }
    const remainingMs = this.#deadlineAt - Date.now();
    if (remainingMs <= 0) {
      this.#interrupt();
      throw new TypeScriptWorkspaceTimeoutError();
    }

    let timer: NodeJS.Timeout | undefined;
    let abort: (() => void) | undefined;
    const interrupted = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        this.#interrupt();
        reject(new TypeScriptWorkspaceTimeoutError());
      }, remainingMs);
      timer.unref();
      if (this.#signal !== undefined) {
        abort = () => {
          this.#interrupt();
          reject(
            this.#signal?.reason ??
              new Error("TypeScript analysis was cancelled."),
          );
        };
        this.#signal.addEventListener("abort", abort, { once: true });
      }
    });
    try {
      return await Promise.race([operation(), interrupted]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (abort !== undefined) {
        this.#signal?.removeEventListener("abort", abort);
      }
    }
  }

  #interrupt(): void {
    if (this.#interrupted) return;
    this.#interrupted = true;
    const child = (this.#api as unknown as NativeProcessAccess).client?.process;
    if (child !== undefined && child.exitCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        // Subsequent API closure remains the authoritative cleanup fallback.
      }
    }
  }
}

export async function withTypeScriptSource<T>(
  filePath: string,
  sourceText: string,
  action: (
    sourceFile: ast.SourceFile,
    hasSyntacticErrors: boolean,
  ) => T,
  execution: TypeScriptWorkspaceExecution = { timeoutMs: 30_000 },
): Promise<T> {
  const extension = path.posix.extname(filePath) || ".ts";
  const virtualPath = `${VIRTUAL_WORKSPACE_ROOT}/standalone/source${extension}`;
  await using workspace = await TypeScriptWorkspace.create(
    [{ path: virtualPath, text: sourceText }],
    execution,
  );
  const sourceFile = await workspace.sourceFile(virtualPath);
  if (sourceFile === undefined) {
    throw new Error("TypeScript 7 did not return the requested source file.");
  }
  return action(
    sourceFile,
    await workspace.hasSyntacticErrors(virtualPath),
  );
}
