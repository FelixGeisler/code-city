import path from "node:path";
import ts from "typescript";

import type {
  ExecutableUnitMetric,
  StaticImportFact,
} from "./types.js";

export interface TypeScriptMetricsResult {
  readonly sloc: number;
  readonly decisionLoad: number;
  readonly maximumComplexity: number;
  readonly executableUnitCount: number;
  readonly units: readonly ExecutableUnitMetric[];
  readonly imports: readonly StaticImportFact[];
  readonly hasSyntaxErrors: boolean;
}

function unitName(node: ts.FunctionLikeDeclaration, source: ts.SourceFile): string {
  const explicitName = node.name?.getText(source);
  if (explicitName) return explicitName;

  const parent = node.parent;
  if (
    (ts.isVariableDeclaration(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isPropertyAssignment(parent)) &&
    parent.name
  ) {
    return parent.name.getText(source);
  }
  if (ts.isCallExpression(parent)) return "<callback>";
  return ts.isArrowFunction(node) ? "<arrow>" : "<anonymous>";
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
  };
}
