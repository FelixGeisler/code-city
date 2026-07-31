import path from "node:path";
import ts from "typescript";

import type {
  ExecutableUnitMetric,
  StaticImportFact,
} from "./types.js";
import type {
  SourceCallableFact,
  SourceStructure,
  SourceTypeFact,
} from "../../core/src/model.js";
import { stableId } from "../../core/src/path.js";

export interface TypeScriptMetricsResult {
  readonly sloc: number;
  readonly decisionLoad: number;
  readonly maximumComplexity: number;
  readonly executableUnitCount: number;
  readonly units: readonly ExecutableUnitMetric[];
  readonly imports: readonly StaticImportFact[];
  readonly hasSyntaxErrors: boolean;
  readonly sourceStructure: SourceStructure;
}

function sourceRange(node: ts.Node, source: ts.SourceFile) {
  const start = source.getLineAndCharacterOfPosition(node.getStart(source));
  const end = source.getLineAndCharacterOfPosition(
    Math.max(node.getStart(source), node.getEnd() - 1),
  );
  return Object.freeze({
    startLine: start.line + 1,
    startColumn: start.character + 1,
    endLine: end.line + 1,
    endColumn: end.character + 1,
  });
}

function sourceTypeKind(node: ts.Node): SourceTypeFact["kind"] | undefined {
  if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) return "class";
  if (ts.isInterfaceDeclaration(node)) return "interface";
  if (ts.isEnumDeclaration(node)) return "enum";
  if (ts.isTypeAliasDeclaration(node)) return "type";
  return undefined;
}

function sourceCallableKind(node: ts.Node): SourceCallableFact["kind"] {
  if (ts.isConstructorDeclaration(node)) return "constructor";
  if (ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) return "accessor";
  if (ts.isArrowFunction(node)) return "lambda";
  if (
    ts.isFunctionDeclaration(node) &&
    !ts.isSourceFile(node.parent) &&
    !ts.isModuleBlock(node.parent)
  ) {
    return "local-function";
  }
  return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) ? "function" : "method";
}

function executableComplexity(node: ts.FunctionLikeDeclaration): number {
  if (node.body === undefined) return 1;
  let decisions = 0;
  function visit(current: ts.Node): void {
    if (
      current !== node.body &&
      isExecutableUnit(current) &&
      current.body !== undefined
    ) {
      return;
    }
    decisions += decisionIncrement(current);
    ts.forEachChild(current, visit);
  }
  visit(node.body);
  return 1 + decisions;
}

function declarationPath(node: ts.Node, source: ts.SourceFile): string {
  const parts: string[] = [];
  for (let parent = node.parent; parent !== undefined; parent = parent.parent) {
    const kind = sourceTypeKind(parent);
    if (kind !== undefined) {
      const named = (parent as ts.Declaration & {
        name?: ts.DeclarationName;
      }).name;
      parts.push(`${kind}:${named?.getText(source) || "<anonymous>"}`);
    } else if (isExecutableUnit(parent)) {
      parts.push(
        `callable:${sourceCallableKind(parent)}:${unitName(parent, source)}(${callableSignature(parent, source)})`,
      );
    }
  }
  return parts.reverse().join("/");
}

function callableSignature(
  node: ts.FunctionLikeDeclaration,
  source: ts.SourceFile,
): string {
  return node.parameters
    .map((parameter) => parameter.type?.getText(source) ?? "_")
    .join(",");
}

function stableLocalIds(
  scope: "source-type" | "source-callable",
  keys: readonly string[],
): readonly string[] {
  const occurrences = new Map<string, number>();
  return keys.map((key) => {
    const occurrence = (occurrences.get(key) ?? 0) + 1;
    occurrences.set(key, occurrence);
    return stableId(scope, key, String(occurrence));
  });
}

/**
 * Collects declarations directly from the parsed syntax tree. It intentionally
 * does not resolve names across files or invent call edges: program/type-checker
 * context is not reliably available for arbitrary snapshots.
 */
function collectSourceStructure(source: ts.SourceFile): SourceStructure {
  const rawTypes: Array<Omit<SourceTypeFact, "id" | "parentTypeId" | "provenance"> & { node: ts.Node }> = [];
  const rawCallables: Array<Omit<SourceCallableFact, "id" | "enclosingTypeId" | "complexity" | "provenance"> & { node: ts.Node }> = [];
  const typeByNode = new Map<ts.Node, string>();

  function visit(node: ts.Node): void {
    const typeKind = sourceTypeKind(node);
    if (typeKind !== undefined) {
      const named = (node as ts.Declaration & { name?: ts.DeclarationName }).name;
      rawTypes.push({ node, name: sanitizeSourceName(named?.getText(source), "<anonymous>"), kind: typeKind, range: sourceRange(node, source) });
    }
    if (isExecutableUnit(node) && !ts.isSourceFile(node) && node.body) {
      rawCallables.push({ node, name: sanitizeSourceName(unitName(node, source), "<callable>"), kind: sourceCallableKind(node), range: sourceRange(node, source) });
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  const compareDeclaration = <T extends { readonly range: { readonly startLine: number; readonly startColumn: number }; readonly kind: string; readonly name: string }>(a: T, b: T) =>
    a.range.startLine - b.range.startLine || a.range.startColumn - b.range.startColumn || compareText(a.kind, b.kind) || compareText(a.name, b.name);
  rawTypes.sort(compareDeclaration);
  const uniqueId = (scope: string, item: { readonly node: ts.Node; readonly kind: string; readonly name: string }, used: Set<string>): string => {
    const base = `${scope}:${stableId(scope, declarationScope(item.node, source), item.kind, item.name, declarationIdentity(item.node, source))}`;
    let id = base; let collision = 1;
    while (used.has(id)) id = `${base}:${collision++}`;
    used.add(id); return id;
  };
  const usedIds = new Set<string>();
  rawTypes.forEach((item) => typeByNode.set(item.node, uniqueId("type", item, usedIds)));
  const types = rawTypes.map((item) => {
    let parent = item.node.parent;
    while (parent && !typeByNode.has(parent)) parent = parent.parent;
    const parentTypeId = parent === undefined ? undefined : typeByNode.get(parent);
    return Object.freeze({ id: typeByNode.get(item.node)!, name: item.name, kind: item.kind, range: item.range, provenance: "syntax" as const, ...(parentTypeId === undefined ? {} : { parentTypeId }) });
  });
  rawCallables.sort(compareDeclaration);
  const callables = rawCallables.map((item) => {
    let parent = item.node.parent;
    while (parent && !typeByNode.has(parent)) parent = parent.parent;
    const enclosingTypeId = parent === undefined ? undefined : typeByNode.get(parent);
    const complexity = callableComplexity(item.node);
    return Object.freeze({ id: uniqueId("callable", item, usedIds), name: item.name, kind: item.kind, range: item.range, provenance: "syntax" as const, complexity, ...(enclosingTypeId === undefined ? {} : { enclosingTypeId }) });
  });
  return Object.freeze({
    version: "codecity.source-structure/1",
    availability: "available",
    types: Object.freeze(types),
    callables: Object.freeze(callables),
    relations: Object.freeze([]),
    unavailable: Object.freeze([
      "TypeScript/JavaScript cross-file type references and call targets are unavailable: the snapshot parser records only unambiguous declarations and does not infer semantic bindings.",
    ]),
  });
}

function declarationScope(node: ts.Node, source: ts.SourceFile): string {
  const parts: string[] = [];
  for (let current = node.parent; current !== undefined; current = current.parent) {
    if (ts.isModuleDeclaration(current) || sourceTypeKind(current) !== undefined) {
      const name = (current as ts.Declaration & { name?: ts.DeclarationName }).name?.getText(source);
      if (name) parts.push(`${ts.SyntaxKind[current.kind]}:${sanitizeSourceName(name, "<scope>")}`);
    } else if (isExecutableUnit(current) && !ts.isSourceFile(current)) {
      parts.push(`callable:${declarationIdentity(current, source)}`);
    }
  }
  return parts.reverse().join(".");
}

function declarationIdentity(node: ts.Node, source: ts.SourceFile): string {
  const typeKind = sourceTypeKind(node);
  if (typeKind !== undefined) {
    const declaration = node as ts.Declaration & { name?: ts.DeclarationName; typeParameters?: ts.NodeArray<ts.TypeParameterDeclaration> };
    return `${typeKind}:${sanitizeSourceName(declaration.name?.getText(source), "<anonymous>")}:type-parameters:${declaration.typeParameters?.length ?? 0}`;
  }
  if (isExecutableUnit(node)) {
    const parameters = node.parameters.map((parameter) => {
      const optional = parameter.questionToken === undefined && parameter.initializer === undefined ? "required" : "optional";
      const rest = parameter.dotDotDotToken === undefined ? "single" : "rest";
      const type = canonicalTokens(parameter.type, source);
      return `${rest}:${optional}:${type}`;
    }).join(",");
    return `${sourceCallableKind(node)}:${sanitizeSourceName(unitName(node, source), "<callable>")}:type-parameters:${node.typeParameters?.length ?? 0}:parameters:${parameters}`;
  }
  return ts.SyntaxKind[node.kind] ?? "declaration";
}

function canonicalTokens(node: ts.Node | undefined, source: ts.SourceFile): string {
  if (node === undefined) return "unknown";
  const scanner = ts.createScanner(
    source.languageVersion,
    true,
    source.languageVariant,
    node.getText(source),
  );
  const tokens: string[] = [];
  for (
    let kind = scanner.scan();
    kind !== ts.SyntaxKind.EndOfFileToken;
    kind = scanner.scan()
  ) {
    const semanticToken =
      scanner.isIdentifier() ||
      (kind >= ts.SyntaxKind.FirstLiteralToken &&
        kind <= ts.SyntaxKind.LastLiteralToken);
    const text = (
      semanticToken ? scanner.getTokenValue() : scanner.getTokenText()
    ).normalize("NFC");
    tokens.push(`${kind}:${text.length}:${text}`);
  }
  return tokens.join("|");
}

function sanitizeSourceName(value: string | undefined, fallback: string): string {
  const normalized = (value ?? "").normalize("NFC");
  let result = "";
  let pendingSpace = false;
  for (const character of normalized) {
    if (/[\p{Cc}\p{Cf}\p{Cs}]/u.test(character)) continue;
    if (/\s/u.test(character)) { pendingSpace = result.length > 0; continue; }
    if (pendingSpace && result.length < 256) result += " ";
    pendingSpace = false;
    if (result.length + character.length > 256) break;
    result += character;
  }
  return result.trim() || fallback;
}

function callableComplexity(node: ts.Node): number {
  const body = (node as ts.FunctionLikeDeclarationBase).body;
  if (!body) return 1;
  let decisions = 0;
  const visit = (current: ts.Node): void => {
    if (current !== body && isExecutableUnit(current) && current.body) return;
    decisions += decisionIncrement(current);
    ts.forEachChild(current, visit);
  };
  visit(body);
  return 1 + decisions;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function unitName(node: ts.FunctionLikeDeclaration, source: ts.SourceFile): string {
  const explicitName = node.name?.getText(source);
  let name = explicitName;
  const parent = node.parent;
  if (!name && (ts.isVariableDeclaration(parent) || ts.isPropertyDeclaration(parent) || ts.isPropertyAssignment(parent)) && parent.name) {
    name = parent.name.getText(source);
  }
  if (!name && ts.isCallExpression(parent)) name = "<callback>";
  return sanitizeSourceName(name, ts.isArrowFunction(node) ? "<arrow>" : "<anonymous>");
}

function isExecutableUnit(
  node: ts.Node,
): node is ts.FunctionLikeDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

function decisionIncrement(node: ts.Node): number {
  if (
    ts.isIfStatement(node) ||
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node) ||
    ts.isCatchClause(node) ||
    ts.isConditionalExpression(node) ||
    ts.isCaseClause(node)
  ) {
    return 1;
  }

  if (ts.isBinaryExpression(node)) {
    const kind = node.operatorToken.kind;
    if (
      kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      kind === ts.SyntaxKind.BarBarToken ||
      kind === ts.SyntaxKind.QuestionQuestionToken ||
      kind === ts.SyntaxKind.AmpersandAmpersandEqualsToken ||
      kind === ts.SyntaxKind.BarBarEqualsToken ||
      kind === ts.SyntaxKind.QuestionQuestionEqualsToken
    ) {
      return 1;
    }
  }
  return 0;
}

function countSloc(
  source: string,
  scriptKind: ts.ScriptKind,
  sourceFile: ts.SourceFile,
): number {
  const languageVariant =
    scriptKind === ts.ScriptKind.JSX || scriptKind === ts.ScriptKind.TSX
      ? ts.LanguageVariant.JSX
      : ts.LanguageVariant.Standard;
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    true,
    languageVariant,
    source,
  );
  const occupied = new Set<number>();

  for (
    let token = scanner.scan();
    token !== ts.SyntaxKind.EndOfFileToken;
    token = scanner.scan()
  ) {
    const start = scanner.getTokenPos();
    const end = Math.max(start, scanner.getTextPos() - 1);
    const firstLine = sourceFile.getLineAndCharacterOfPosition(start).line;
    const lastLine = sourceFile.getLineAndCharacterOfPosition(end).line;
    for (let line = firstLine; line <= lastLine; line += 1) occupied.add(line);
  }
  return occupied.size;
}

function collectUnits(source: ts.SourceFile): readonly ExecutableUnitMetric[] {
  const units: ExecutableUnitMetric[] = [];

  function analyzeBody(
    body: ts.Node,
    name: string,
    line: number,
  ): void {
    let decisions = 0;

    function visit(node: ts.Node): void {
      if (node !== body && isExecutableUnit(node) && node.body) {
        const nestedLine =
          source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        analyzeBody(node.body, unitName(node, source), nestedLine);
        return;
      }
      decisions += decisionIncrement(node);
      ts.forEachChild(node, visit);
    }

    visit(body);
    const endLine =
      source.getLineAndCharacterOfPosition(
        Math.max(body.getStart(source), body.getEnd() - 1),
      ).line + 1;
    units.push({ name, line, endLine, complexity: 1 + decisions });
  }

  // Keeping a top-level unit for every source file makes file totals stable and
  // accounts for executable module initializers.
  analyzeBody(source, "<top-level>", 1);
  return units.sort(
    (left, right) =>
      left.line - right.line ||
      left.name.localeCompare(right.name, "en-US") ||
      left.complexity - right.complexity,
  );
}

function collectStaticImports(
  source: ts.SourceFile,
): readonly StaticImportFact[] {
  const counts = new Map<string, number>();

  function add(specifier: string): void {
    counts.set(specifier, (counts.get(specifier) ?? 0) + 1);
  }

  function visit(node: ts.Node): void {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      add(node.moduleSpecifier.text);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      add(node.moduleReference.expression.text);
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require" &&
      node.arguments.length === 1
    ) {
      const argument = node.arguments[0];
      if (argument && ts.isStringLiteralLike(argument)) add(argument.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1
    ) {
      const argument = node.arguments[0];
      if (argument && ts.isStringLiteralLike(argument)) add(argument.text);
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right, "en-US"))
    .map(([specifier, count]) => ({ specifier, count }));
}

function scriptKindFor(filePath: string): ts.ScriptKind {
  switch (path.extname(filePath).toLocaleLowerCase("en-US")) {
    case ".tsx":
      return ts.ScriptKind.TSX;
    case ".jsx":
      return ts.ScriptKind.JSX;
    case ".js":
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.TS;
  }
}

export function analyzeTypeScriptSource(
  filePath: string,
  sourceText: string,
): TypeScriptMetricsResult {
  const scriptKind = scriptKindFor(filePath);
  const source = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );
  const units = collectUnits(source);
  const parseDiagnostics =
    (
      source as ts.SourceFile & {
        readonly parseDiagnostics?: readonly ts.Diagnostic[];
      }
    ).parseDiagnostics ?? [];
  const decisionLoad = units.reduce(
    (total, unit) => total + unit.complexity - 1,
    0,
  );

  return {
    sloc: countSloc(sourceText, scriptKind, source),
    decisionLoad,
    maximumComplexity: Math.max(...units.map((unit) => unit.complexity)),
    executableUnitCount: units.length,
    units,
    imports: collectStaticImports(source),
    hasSyntaxErrors: parseDiagnostics.length > 0,
    sourceStructure: collectSourceStructure(source),
  };
}
