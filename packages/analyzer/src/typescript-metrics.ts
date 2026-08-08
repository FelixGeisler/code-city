import * as ts from "typescript/unstable/ast";

import { withTypeScriptSource } from "./typescript-workspace.js";

import type {
  ExecutableUnitMetric,
  StaticImportFact,
} from "./types.js";
import type {
  ComplexityDecisionSite,
  ExecutableUnitDecisionEvidence,
  SourceCallableFact,
  SourceStructure,
  SourceTypeFact,
} from "../../core/src/model.js";
import { CITY_MODEL_LIMITS } from "../../core/src/model-validation.js";
import { stableId } from "../../core/src/path.js";

const DECISION_EVIDENCE_TRUNCATED_REASON =
  "Decision-site evidence was truncated by analyzer retention limits.";

interface CollectedSourceStructure {
  readonly structure: SourceStructure;
  readonly callableIdByNode: ReadonlyMap<ts.Node, string>;
}

interface DecisionAnalysis {
  readonly totalContribution: number;
  readonly sites: readonly ComplexityDecisionSite[];
}

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

function sourceRangeAt(
  startPosition: number,
  endPosition: number,
  source: ts.SourceFile,
) {
  const start = source.getLineAndCharacterOfPosition(startPosition);
  const end = source.getLineAndCharacterOfPosition(
    Math.max(startPosition, endPosition - 1),
  );
  return Object.freeze({
    startLine: start.line + 1,
    startColumn: start.character + 1,
    endLine: end.line + 1,
    endColumn: end.character + 1,
  });
}

function sourceRange(node: ts.Node, source: ts.SourceFile) {
  return sourceRangeAt(node.getStart(source), node.getEnd(), source);
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

/**
 * Collects declarations directly from the parsed syntax tree. It intentionally
 * does not resolve names across files or invent call edges: program/type-checker
 * context is not reliably available for arbitrary snapshots.
 */
function collectSourceStructure(source: ts.SourceFile): CollectedSourceStructure {
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
    node.forEachChild(visit);
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
  const callableIdByNode = new Map<ts.Node, string>();
  rawCallables.forEach((item) =>
    callableIdByNode.set(item.node, uniqueId("callable", item, usedIds)),
  );
  const callables = rawCallables.map((item) => {
    let parent = item.node.parent;
    while (parent && !typeByNode.has(parent)) parent = parent.parent;
    const enclosingTypeId = parent === undefined ? undefined : typeByNode.get(parent);
    const complexity = callableComplexity(item.node, source);
    return Object.freeze({ id: callableIdByNode.get(item.node)!, name: item.name, kind: item.kind, range: item.range, provenance: "syntax" as const, complexity, ...(enclosingTypeId === undefined ? {} : { enclosingTypeId }) });
  });
  return Object.freeze({
    callableIdByNode,
    structure: Object.freeze({
      version: "codecity.source-structure/1",
      availability: "available",
      types: Object.freeze(types),
      callables: Object.freeze(callables),
      relations: Object.freeze([]),
      unavailable: Object.freeze([
        "TypeScript/JavaScript cross-file type references and call targets are unavailable: the snapshot parser records only unambiguous declarations and does not infer semantic bindings.",
      ]),
    }),
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
    true,
    source.languageVariant,
    node.getText(source),
  );
  const tokens: string[] = [];
  for (
    let kind = scanner.scan();
    kind !== ts.SyntaxKind.EndOfFile;
    kind = scanner.scan()
  ) {
    const semanticToken =
      scanner.isIdentifier() ||
      (kind >= ts.SyntaxKind.FirstLiteralToken &&
        kind <= ts.SyntaxKind.LastLiteralToken);
    const text = (
      semanticToken ? scanner.getTokenValue() : scanner.getTokenText()
    ).normalize("NFC");
    tokens.push(
      `${ts.SyntaxKind[kind] ?? "Unknown"}:${text.length}:${text}`,
    );
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

function callableComplexity(node: ts.Node, source: ts.SourceFile): number {
  const body = isExecutableUnit(node) ? node.body : undefined;
  if (!body) return 1;
  return 1 + collectDecisionAnalysis(body, source).totalContribution;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function unitName(node: ts.FunctionLikeDeclaration, source: ts.SourceFile): string {
  const explicitName = "name" in node
    ? node.name?.getText(source)
    : undefined;
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

function decisionSite(
  node: ts.Node,
  source: ts.SourceFile,
): ComplexityDecisionSite | undefined {
  let kind: ComplexityDecisionSite["kind"] | undefined;
  let marker: ts.Node | undefined;
  let markerRange: ReturnType<typeof sourceRangeAt> | undefined;
  if (
    ts.isIfStatement(node) ||
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node) ||
    ts.isCatchClause(node) ||
    ts.isCaseClause(node)
  ) {
    kind = ts.isIfStatement(node)
      ? "conditional-branch"
      : ts.isCatchClause(node)
        ? "catch"
        : ts.isCaseClause(node)
          ? "switch-arm"
          : "loop";
    const keywordLength = ts.isIfStatement(node) || ts.isDoStatement(node)
      ? 2
      : ts.isForStatement(node) ||
          ts.isForInStatement(node) ||
          ts.isForOfStatement(node)
        ? 3
        : ts.isCaseClause(node)
          ? 4
          : 5;
    const markerStart = node.getStart(source);
    markerRange = sourceRangeAt(
      markerStart,
      markerStart + keywordLength,
      source,
    );
  } else if (ts.isConditionalExpression(node)) {
    kind = "conditional-expression";
    marker = node.questionToken;
  } else if (ts.isBinaryExpression(node)) {
    const operator = node.operatorToken.kind;
    if (
      operator === ts.SyntaxKind.AmpersandAmpersandToken ||
      operator === ts.SyntaxKind.BarBarToken ||
      operator === ts.SyntaxKind.AmpersandAmpersandEqualsToken ||
      operator === ts.SyntaxKind.BarBarEqualsToken
    ) {
      kind = "short-circuit-operator";
      marker = node.operatorToken;
    } else if (
      operator === ts.SyntaxKind.QuestionQuestionToken ||
      operator === ts.SyntaxKind.QuestionQuestionEqualsToken
    ) {
      kind = "nullish-operator";
      marker = node.operatorToken;
    }
  }
  if (kind === undefined || (marker === undefined && markerRange === undefined)) {
    return undefined;
  }
  return Object.freeze({
    kind,
    range: markerRange ?? sourceRange(marker!, source),
    contribution: 1,
  });
}

function compareDecisionSites(
  left: ComplexityDecisionSite,
  right: ComplexityDecisionSite,
): number {
  return (
    left.range.startLine - right.range.startLine ||
    left.range.startColumn - right.range.startColumn ||
    left.range.endLine - right.range.endLine ||
    left.range.endColumn - right.range.endColumn ||
    compareText(left.kind, right.kind)
  );
}

function retainEarliestDecisionSite(
  sites: ComplexityDecisionSite[],
  site: ComplexityDecisionSite,
): void {
  let low = 0;
  let high = sites.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (compareDecisionSites(sites[middle]!, site) <= 0) low = middle + 1;
    else high = middle;
  }
  if (low >= CITY_MODEL_LIMITS.decisionSitesPerUnit) return;
  sites.splice(low, 0, site);
  if (sites.length > CITY_MODEL_LIMITS.decisionSitesPerUnit) sites.pop();
}

function collectDecisionAnalysis(
  body: ts.Node,
  source: ts.SourceFile,
): DecisionAnalysis {
  let totalContribution = 0;
  const sites: ComplexityDecisionSite[] = [];
  const visit = (node: ts.Node): void => {
    if (node !== body && isExecutableUnit(node) && node.body) return;
    const site = decisionSite(node, source);
    if (site !== undefined) {
      totalContribution += site.contribution;
      retainEarliestDecisionSite(sites, site);
    }
    node.forEachChild(visit);
  };
  visit(body);
  return Object.freeze({
    totalContribution,
    sites: Object.freeze(sites),
  });
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
    true,
    languageVariant,
    source,
  );
  const occupied = new Set<number>();

  for (
    let token = scanner.scan();
    token !== ts.SyntaxKind.EndOfFile;
    token = scanner.scan()
  ) {
    const start = scanner.getTokenStart();
    const end = Math.max(start, scanner.getTokenEnd() - 1);
    const firstLine = sourceFile.getLineAndCharacterOfPosition(start).line;
    const lastLine = sourceFile.getLineAndCharacterOfPosition(end).line;
    for (let line = firstLine; line <= lastLine; line += 1) occupied.add(line);
  }
  return occupied.size;
}

function collectUnits(
  source: ts.SourceFile,
  callableIdByNode: ReadonlyMap<ts.Node, string>,
): readonly ExecutableUnitMetric[] {
  interface RawUnit {
    readonly name: string;
    readonly line: number;
    readonly endLine: number;
    readonly analysis: DecisionAnalysis;
    readonly scope: "top-level" | "callable";
    readonly callableId?: string;
  }
  const rawUnits: RawUnit[] = [];

  function analyzeBody(
    body: ts.Node,
    name: string,
    line: number,
    callableNode?: ts.Node,
  ): void {
    function visit(node: ts.Node): void {
      if (node !== body && isExecutableUnit(node) && node.body) {
        const nestedLine =
          source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        analyzeBody(node.body, unitName(node, source), nestedLine, node);
        return;
      }
      node.forEachChild(visit);
    }

    visit(body);
    const endLine =
      source.getLineAndCharacterOfPosition(
        Math.max(body.getStart(source), body.getEnd() - 1),
      ).line + 1;
    const callableId = callableNode === undefined
      ? undefined
      : callableIdByNode.get(callableNode);
    rawUnits.push({
      name,
      line,
      endLine,
      analysis: collectDecisionAnalysis(body, source),
      scope: callableNode === undefined ? "top-level" : "callable",
      ...(callableId === undefined ? {} : { callableId }),
    });
  }

  // Keeping a top-level unit for every source file makes file totals stable and
  // accounts for executable module initializers.
  analyzeBody(source, "<top-level>", 1);
  rawUnits.sort(
    (left, right) =>
      left.line - right.line ||
      left.name.localeCompare(right.name, "en-US") ||
      left.analysis.totalContribution - right.analysis.totalContribution,
  );
  let remainingSites = CITY_MODEL_LIMITS.decisionSitesPerBuilding;
  return Object.freeze(rawUnits.map((unit) => {
    const retainedSites = Object.freeze(
      unit.analysis.sites.slice(0, remainingSites),
    );
    remainingSites -= retainedSites.length;
    const retainedContribution = retainedSites.reduce(
      (total, site) => total + site.contribution,
      0,
    );
    const omittedContribution =
      unit.analysis.totalContribution - retainedContribution;
    const identity = unit.callableId === undefined
      ? "unit:top-level"
      : `unit:${unit.callableId}`;
    const decisionEvidence: ExecutableUnitDecisionEvidence =
      omittedContribution === 0
        ? Object.freeze({
            version: "codecity.complexity-evidence/1" as const,
            unitId: identity,
            scope: unit.scope,
            ...(unit.callableId === undefined ? {} : { callableId: unit.callableId }),
            status: "complete" as const,
            totalContribution: unit.analysis.totalContribution,
            omittedContribution: 0 as const,
            sites: retainedSites,
          })
        : Object.freeze({
            version: "codecity.complexity-evidence/1" as const,
            unitId: identity,
            scope: unit.scope,
            ...(unit.callableId === undefined ? {} : { callableId: unit.callableId }),
            status: "truncated" as const,
            totalContribution: unit.analysis.totalContribution,
            omittedContribution,
            reason: DECISION_EVIDENCE_TRUNCATED_REASON,
            sites: retainedSites,
          });
    return Object.freeze({
      name: unit.name,
      line: unit.line,
      endLine: unit.endLine,
      complexity: 1 + unit.analysis.totalContribution,
      decisionEvidence,
    });
  }));
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
      ts.isStringLiteralLikeNode(node.moduleSpecifier)
    ) {
      add(node.moduleSpecifier.text);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteralLikeNode(node.moduleReference.expression)
    ) {
      add(node.moduleReference.expression.text);
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require" &&
      node.arguments.length === 1
    ) {
      const argument = node.arguments[0];
      if (argument && ts.isStringLiteralLikeNode(argument)) add(argument.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1
    ) {
      const argument = node.arguments[0];
      if (argument && ts.isStringLiteralLikeNode(argument)) add(argument.text);
    }
    node.forEachChild(visit);
  }

  visit(source);
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right, "en-US"))
    .map(([specifier, count]) => ({ specifier, count }));
}

export function analyzeParsedTypeScriptSource(
  source: ts.SourceFile,
  hasSyntaxErrors: boolean,
): TypeScriptMetricsResult {
  const scriptKind = source.scriptKind;
  const sourceText = source.text;
  const sourceStructure = collectSourceStructure(source);
  const units = collectUnits(source, sourceStructure.callableIdByNode);
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
    hasSyntaxErrors,
    sourceStructure: sourceStructure.structure,
  };
}


export async function analyzeTypeScriptSource(
  filePath: string,
  sourceText: string,
): Promise<TypeScriptMetricsResult> {
  return withTypeScriptSource(
    filePath,
    sourceText,
    (source, hasSyntaxErrors) =>
      analyzeParsedTypeScriptSource(source, hasSyntaxErrors),
  );
}
