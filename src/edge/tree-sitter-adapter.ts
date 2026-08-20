import type {
  ByteSpan,
  DecisionKind,
  ExplicitUnitForm,
  GrammarFamily,
  SyntaxObservation,
  SyntaxObservationStream,
  TypeOnlyKind,
  ValueAnchorKind,
} from "../domain/base-metrics";

export type ParserAssetUrls = Readonly<{
  runtimeJavaScript: string;
  runtimeWasm: string;
  grammarJavaScript: string;
  grammarTypeScript: string;
  grammarTsx: string;
}>;

export type ParserResourceEvent =
  | "parser-created" | "parser-deleted"
  | "tree-created" | "tree-deleted"
  | "cursor-created" | "cursor-deleted"
  | "observation-stream-created" | "observation-stream-released";

export type ParserAdapterOptions = Readonly<{
  importRuntime?: (url: string) => Promise<unknown>;
  loadBytes?: (url: string) => Promise<Uint8Array>;
  observeResource?: (event: ParserResourceEvent) => void;
}>;

export type StaticSyntaxParser = Readonly<{
  initialize(): Promise<void>;
  project(grammarFamily: GrammarFamily, normalizedSource: string): Promise<SyntaxObservationStream>;
}>;

type CursorHandle = Readonly<{
  nodeType: string;
  nodeIsNamed: boolean;
  nodeIsMissing: boolean;
  currentFieldName: string | null;
  startIndex: number;
  endIndex: number;
  gotoFirstChild(): boolean;
  gotoNextSibling(): boolean;
  gotoParent(): boolean;
  delete(): void;
}>;

type RootHandle = Readonly<{
  hasError: boolean;
  walk(): CursorHandle;
}>;

type TreeHandle = Readonly<{
  rootNode: RootHandle;
  delete(): void;
}>;

type LanguageHandle = Readonly<Record<string, never>>;

type ParserHandle = Readonly<{
  setLanguage(language: LanguageHandle): void;
  parse(source: string): TreeHandle | null;
  delete(): void;
}>;

type ParserConstructor = {
  new(): ParserHandle;
  init(options: Readonly<{
    locateFile(path: string, scriptDirectory: string): string;
    print(...values: unknown[]): void;
    printErr(...values: unknown[]): void;
  }>): Promise<void>;
};

type RuntimeModule = Readonly<{
  Parser: ParserConstructor;
  Language: Readonly<{ load(bytes: Uint8Array): Promise<LanguageHandle> }>;
}>;

type Utf16Span = Readonly<{ start: number; end: number }>;
type TemporaryObservation =
  | Readonly<{ kind: "lexical-exclusion"; start: number; end: number }>
  | Readonly<{ kind: "explicit-unit"; form: ExplicitUnitForm; start: number; end: number; ownedRegions: readonly Utf16Span[] }>
  | Readonly<{ kind: "value-anchor"; valueKind: ValueAnchorKind; start: number; end: number }>
  | Readonly<{ kind: "type-only"; typeKind: TypeOnlyKind; start: number; end: number }>
  | Readonly<{ kind: "decision"; decisionKind: DecisionKind; start: number; end: number }>;

type TemporaryUnit = {
  form: ExplicitUnitForm;
  start: number;
  end: number;
  firstNonDecoratorStart?: number;
  name?: Utf16Span;
  ownedRegions: Utf16Span[];
  directTokens: string[];
};

type ProjectionFrame = {
  unit?: TemporaryUnit;
  operator?: { start: number; end: number; directTokens: string[] };
};

const FORBIDDEN_NON_JSX = new Set([
  "jsx_attribute", "jsx_closing_element", "jsx_element", "jsx_expression", "jsx_namespace_name",
  "jsx_opening_element", "jsx_self_closing_element", "jsx_text",
]);
const LEXICAL_EXCLUSIONS = new Set(["comment", "html_comment", "hash_bang_line"]);
const FUNCTION_NODES = new Set([
  "function_declaration", "generator_function_declaration", "function_expression", "generator_function",
]);
const RUNTIME_ANCHOR_NODES = new Set([
  "break_statement", "continue_statement", "debugger_statement", "do_statement", "empty_statement",
  "expression_statement", "for_in_statement", "for_statement", "if_statement", "labeled_statement",
  "lexical_declaration", "return_statement", "switch_statement", "throw_statement", "try_statement",
  "variable_declaration", "while_statement", "with_statement", "class_declaration",
]);
const SIGNATURE_NODES = new Set([
  "function_signature", "method_signature", "abstract_method_signature", "call_signature", "construct_signature",
]);
const encoder = new TextEncoder();
const WHITE_SPACE_ONLY = /^\p{White_Space}*$/u;

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function runtimeModule(value: unknown): RuntimeModule {
  invariant(typeof value === "object" && value !== null, "Parser runtime module is invalid");
  const candidate = value as Partial<RuntimeModule>;
  invariant(typeof candidate.Parser === "function" && typeof candidate.Parser.init === "function", "Parser runtime export is invalid");
  invariant(typeof candidate.Language?.load === "function", "Parser language export is invalid");
  return candidate as RuntimeModule;
}

async function defaultLoadBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  invariant(response.ok, "Parser asset request failed");
  return new Uint8Array(await response.arrayBuffer());
}

function createCursor(root: RootHandle, observe: (event: ParserResourceEvent) => void): CursorHandle {
  const cursor = root.walk();
  observe("cursor-created");
  return cursor;
}

function deleteCursor(cursor: CursorHandle, observe: (event: ParserResourceEvent) => void): void {
  cursor.delete();
  observe("cursor-deleted");
}

function advance(cursor: CursorHandle, depth: { value: number }, onExit?: (depth: number) => void): boolean {
  if (cursor.gotoFirstChild()) {
    depth.value += 1;
    return true;
  }
  for (;;) {
    onExit?.(depth.value);
    if (cursor.gotoNextSibling()) {
      return true;
    }
    if (!cursor.gotoParent()) {
      return false;
    }
    depth.value -= 1;
  }
}

function validateTree(root: RootHandle, forbidJsx: boolean, observe: (event: ParserResourceEvent) => void): void {
  const cursor = createCursor(root, observe);
  let invalid = root.hasError;
  const depth = { value: 0 };
  try {
    for (;;) {
      invalid ||= cursor.nodeType === "ERROR" || cursor.nodeIsMissing;
      invalid ||= forbidJsx && FORBIDDEN_NON_JSX.has(cursor.nodeType);
      if (!advance(cursor, depth)) break;
    }
  } finally {
    deleteCursor(cursor, observe);
  }
  invariant(!invalid, "Syntax validation failed");
}

function unitForNode(nodeType: string, start: number, end: number): TemporaryUnit | undefined {
  if (FUNCTION_NODES.has(nodeType)) {
    return { form: "function", start, end, ownedRegions: [], directTokens: [] };
  }
  if (nodeType === "arrow_function") {
    return { form: "arrow", start, end, ownedRegions: [], directTokens: [] };
  }
  if (nodeType === "method_definition") {
    return { form: "method", start, end, ownedRegions: [], directTokens: [] };
  }
  if (nodeType === "class_static_block") {
    return { form: "static-block", start, end, ownedRegions: [], directTokens: [] };
  }
  return undefined;
}

function classifyTypeOrValue(nodeType: string, sourceSlice: string): Readonly<{
  kind: "value-anchor"; valueKind: ValueAnchorKind;
} | {
  kind: "type-only"; typeKind: TypeOnlyKind;
}> | undefined {
  const trimmed = sourceSlice.trim();
  if (nodeType === "interface_declaration" || nodeType === "type_alias_declaration") {
    return { kind: "type-only", typeKind: "interface/type alias" };
  }
  if (SIGNATURE_NODES.has(nodeType)) {
    return { kind: "type-only", typeKind: "signature-only" };
  }
  if (nodeType === "ambient_declaration" || /^declare\b/u.test(trimmed)) {
    return { kind: "type-only", typeKind: "ambient/declare" };
  }
  if (nodeType === "import_statement" || nodeType === "export_statement") {
    if (/^(?:import|export)\s+type\b/u.test(trimmed)) {
      return { kind: "type-only", typeKind: "import/export type" };
    }
    if (/^export\s*\{\s*\}\s*;?$/u.test(trimmed)) {
      return { kind: "type-only", typeKind: "exact export{}" };
    }
    const braces = /^(?:import|export)\s*\{([\s\S]*?)\}/u.exec(trimmed);
    if (braces && braces[1]!.split(",").every((specifier) => /^\s*type\b/u.test(specifier))) {
      return { kind: "type-only", typeKind: "import/export lists all specifiers type-only" };
    }
    return { kind: "value-anchor", valueKind: "value-or-side-effect-import-export" };
  }
  if (nodeType === "enum_declaration" || nodeType === "internal_module") {
    return { kind: "value-anchor", valueKind: "nonambient runtime TypeScript enum/namespace" };
  }
  if (RUNTIME_ANCHOR_NODES.has(nodeType)) {
    return { kind: "value-anchor", valueKind: "runtime-statement/declaration" };
  }
  if (nodeType === "jsx_element" || nodeType === "jsx_self_closing_element") {
    return { kind: "value-anchor", valueKind: "top-level JSX" };
  }
  return undefined;
}

function decisionForNode(nodeType: string): DecisionKind | undefined {
  if (nodeType === "if_statement") return "if";
  if (["do_statement", "for_in_statement", "for_statement", "while_statement"].includes(nodeType)) return "loop";
  if (nodeType === "switch_case") return "case";
  if (nodeType === "catch_clause") return "catch";
  if (nodeType === "ternary_expression") return "ternary";
  return undefined;
}

function operatorDecision(tokens: readonly string[]): DecisionKind | undefined {
  if (tokens.includes("&&=")) return "logical-and-assign";
  if (tokens.includes("||=")) return "logical-or-assign";
  if (tokens.includes("??=")) return "nullish-assign";
  if (tokens.includes("&&")) return "logical-and";
  if (tokens.includes("||")) return "logical-or";
  if (tokens.includes("??")) return "nullish";
  return undefined;
}

function translateEndpoints(source: string, endpoints: readonly number[]): Map<number, number> {
  const unique = [...new Set(endpoints)].sort((left, right) => left - right);
  invariant(unique.every((endpoint) => Number.isSafeInteger(endpoint) && endpoint >= 0 && endpoint <= source.length), "Invalid UTF-16 endpoint");
  const translated = new Map<number, number>();
  let endpointIndex = 0;
  let utf16 = 0;
  let utf8 = 0;
  while (endpointIndex < unique.length && unique[endpointIndex] === 0) {
    translated.set(0, 0);
    endpointIndex += 1;
  }
  for (const scalar of source) {
    const utf16Width = scalar.length;
    const utf8Width = encoder.encode(scalar).byteLength;
    const nextUtf16 = utf16 + utf16Width;
    while (endpointIndex < unique.length && unique[endpointIndex]! < nextUtf16) {
      throw new Error("Projected endpoint splits a surrogate pair");
    }
    utf16 = nextUtf16;
    utf8 += utf8Width;
    while (endpointIndex < unique.length && unique[endpointIndex] === utf16) {
      translated.set(utf16, utf8);
      endpointIndex += 1;
    }
  }
  invariant(endpointIndex === unique.length, "Projected endpoint is outside source");
  return translated;
}

function sourceOrdered(left: SyntaxObservation, right: SyntaxObservation): number {
  const kindOrder = new Map([["lexical-exclusion", 0], ["explicit-unit", 1], ["value-anchor", 2], ["type-only", 3], ["decision", 4]]);
  return left.startByte - right.startByte
    || right.endByte - left.endByte
    || (kindOrder.get(left.kind) ?? 9) - (kindOrder.get(right.kind) ?? 9);
}

function projectTree(
  root: RootHandle,
  source: string,
  observe: (event: ParserResourceEvent) => void,
): readonly SyntaxObservation[] {
  const cursor = createCursor(root, observe);
  const temporary: TemporaryObservation[] = [];
  const comments: Utf16Span[] = [];
  const jsxExpressions: Utf16Span[] = [];
  const frames: ProjectionFrame[] = [];
  const depth = { value: 0 };

  function finishFrame(frame: ProjectionFrame): void {
    if (frame.operator) {
      const decision = operatorDecision(frame.operator.directTokens);
      if (decision) {
        temporary.push({
          kind: "decision",
          decisionKind: decision,
          start: frame.operator.start,
          end: frame.operator.end,
        });
      }
    }
    const unit = frame.unit;
    if (!unit) return;
    if (unit.form === "method") {
      if (unit.directTokens.includes("get")) unit.form = "getter";
      else if (unit.directTokens.includes("set")) unit.form = "setter";
      else if (unit.name && source.slice(unit.name.start, unit.name.end) === "constructor") unit.form = "constructor";
    }
    const start = unit.firstNonDecoratorStart ?? unit.start;
    invariant(unit.ownedRegions.length > 0, "Explicit unit has no body-bearing owned region");
    temporary.push({
      kind: "explicit-unit",
      form: unit.form,
      start,
      end: unit.end,
      ownedRegions: unit.ownedRegions,
    });
    temporary.push({
      kind: "value-anchor",
      valueKind: "explicit-unit-declaration/expression",
      start,
      end: unit.end,
    });
  }

  try {
    for (;;) {
      const nodeType = cursor.nodeType;
      const start = cursor.startIndex;
      const end = cursor.endIndex;
      const field = cursor.currentFieldName;
      invariant(Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end >= start, "Invalid parser endpoint");

      const parent = frames[depth.value - 1];
      if (parent?.operator) parent.operator.directTokens.push(nodeType);
      if (parent?.unit) {
        parent.unit.directTokens.push(nodeType);
        if (nodeType !== "decorator" && parent.unit.firstNonDecoratorStart === undefined) {
          parent.unit.firstNonDecoratorStart = start;
        }
        if (field === "name") parent.unit.name = { start, end };
        if (field === "parameters" || field === "body") parent.unit.ownedRegions.push({ start, end });
      }

      const unit = unitForNode(nodeType, start, end);
      const operator = ["binary_expression", "augmented_assignment_expression"].includes(nodeType)
        ? { start, end, directTokens: [] }
        : undefined;
      frames[depth.value] = { ...(unit ? { unit } : {}), ...(operator ? { operator } : {}) };
      frames.length = depth.value + 1;

      if (LEXICAL_EXCLUSIONS.has(nodeType)) {
        comments.push({ start, end });
      }
      if (nodeType === "jsx_expression") {
        jsxExpressions.push({ start, end });
      }

      const classified = classifyTypeOrValue(nodeType, source.slice(start, end));
      if (classified) temporary.push({ ...classified, start, end });
      const decision = decisionForNode(nodeType);
      if (decision) temporary.push({ kind: "decision", decisionKind: decision, start, end });

      const advanced = advance(cursor, depth, (exitingDepth) => {
        const frame = frames[exitingDepth];
        if (frame) finishFrame(frame);
        frames.length = exitingDepth;
      });
      if (!advanced) break;
    }
  } finally {
    deleteCursor(cursor, observe);
  }

  const wrapperExclusions: Utf16Span[] = [];
  for (const expression of jsxExpressions) {
    const enclosed = comments.filter((comment) => comment.start >= expression.start && comment.end <= expression.end);
    if (enclosed.length === 0) continue;
    let remainder = source.slice(expression.start, expression.end);
    for (const comment of [...enclosed].sort((left, right) => right.start - left.start)) {
      remainder = `${remainder.slice(0, comment.start - expression.start)}${remainder.slice(comment.end - expression.start)}`;
    }
    if (remainder.startsWith("{") && remainder.endsWith("}") && WHITE_SPACE_ONLY.test(remainder.slice(1, -1))) {
      wrapperExclusions.push(expression);
    }
  }
  for (const comment of comments) {
    if (!wrapperExclusions.some((wrapper) => comment.start >= wrapper.start && comment.end <= wrapper.end)) {
      temporary.push({ kind: "lexical-exclusion", ...comment });
    }
  }
  for (const wrapper of wrapperExclusions) temporary.push({ kind: "lexical-exclusion", ...wrapper });

  const endpoints = temporary.flatMap((observation) => [
    observation.start,
    observation.end,
    ...(observation.kind === "explicit-unit"
      ? observation.ownedRegions.flatMap((region) => [region.start, region.end])
      : []),
  ]);
  const translated = translateEndpoints(source, endpoints);
  const observations: SyntaxObservation[] = temporary.map((observation) => {
    const startByte = translated.get(observation.start);
    const endByte = translated.get(observation.end);
    invariant(startByte !== undefined && endByte !== undefined && endByte > startByte, "Invalid translated range");
    if (observation.kind === "explicit-unit") {
      const ownedRegions: ByteSpan[] = observation.ownedRegions.map((region) => {
        const regionStart = translated.get(region.start);
        const regionEnd = translated.get(region.end);
        invariant(regionStart !== undefined && regionEnd !== undefined && regionEnd > regionStart, "Invalid translated owned region");
        return { startByte: regionStart, endByte: regionEnd };
      });
      const { start: _start, end: _end, ...rest } = observation;
      return { ...rest, startByte, endByte, ownedRegions } as SyntaxObservation;
    }
    const { start: _start, end: _end, ...rest } = observation;
    return { ...rest, startByte, endByte } as SyntaxObservation;
  });
  return observations.sort(sourceOrdered);
}

export function createTreeSitterAdapter(
  assets: ParserAssetUrls,
  options: ParserAdapterOptions = {},
): StaticSyntaxParser {
  const importRuntime = options.importRuntime ?? ((url: string) => import(/* @vite-ignore */ url));
  const loadBytes = options.loadBytes ?? defaultLoadBytes;
  const observe = options.observeResource ?? (() => {});
  let initialization: Promise<Readonly<{
    runtime: RuntimeModule;
    javascript: LanguageHandle;
    typescript: LanguageHandle;
    tsx: LanguageHandle;
  }>> | undefined;

  async function initializeAll() {
    const runtime = runtimeModule(await importRuntime(assets.runtimeJavaScript));
    await runtime.Parser.init({
      locateFile(requestedPath, _scriptDirectory) {
        if (requestedPath === "web-tree-sitter.wasm") return assets.runtimeWasm;
        throw new Error("Unexpected parser runtime asset request");
      },
      print() {},
      printErr() {},
    });
    const javascript = await runtime.Language.load(await loadBytes(assets.grammarJavaScript));
    const typescript = await runtime.Language.load(await loadBytes(assets.grammarTypeScript));
    const tsx = await runtime.Language.load(await loadBytes(assets.grammarTsx));
    return { runtime, javascript, typescript, tsx };
  }

  return {
    async initialize() {
      initialization ??= initializeAll();
      await initialization;
    },
    async project(grammarFamily, normalizedSource) {
      initialization ??= initializeAll();
      const initialized = await initialization;
      const language = grammarFamily === "typescript"
        ? initialized.typescript
        : grammarFamily === "tsx"
          ? initialized.tsx
          : initialized.javascript;
      let parser: ParserHandle | undefined;
      let tree: TreeHandle | undefined;
      try {
        parser = new initialized.runtime.Parser();
        observe("parser-created");
        parser.setLanguage(language);
        tree = parser.parse(normalizedSource) ?? undefined;
        invariant(tree, "Parser returned no tree");
        observe("tree-created");
        validateTree(tree.rootNode, grammarFamily === "javascript-no-jsx", observe);
        const observations = projectTree(tree.rootNode, normalizedSource, observe);
        observe("observation-stream-created");
        let released = false;
        return {
          observations,
          release() {
            if (!released) {
              released = true;
              observe("observation-stream-released");
            }
          },
        };
      } finally {
        if (tree) {
          tree.delete();
          observe("tree-deleted");
        }
        if (parser) {
          parser.delete();
          observe("parser-deleted");
        }
      }
    },
  };
}
