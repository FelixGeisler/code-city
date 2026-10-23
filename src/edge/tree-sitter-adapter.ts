import {
  DECISION_KINDS,
  EXPLICIT_UNIT_FORMS,
  TYPE_ONLY_KINDS,
  VALUE_ANCHOR_KINDS,
  createSyntaxObservationWriter,
  type DecisionKind,
  type ExplicitUnitForm,
  type GrammarFamily,
  type SyntaxObservationStream,
  type TypeOnlyKind,
  type ValueAnchorKind,
} from "../domain/base-metrics";

export type ParserAssetUrls = Readonly<{ runtimeJavaScript: string; runtimeWasm: string; grammarJavaScript: string; grammarTypeScript: string; grammarTsx: string; grammarCSharp?: string }>;
export type ParserResourceEvent =
  | "parser-created" | "parser-deleted" | "tree-created" | "tree-deleted" | "cursor-created" | "cursor-deleted"
  | "observation-stream-created" | "observation-stream-released";
export type ParserAdapterOptions = Readonly<{ importRuntime?: (url: string) => Promise<unknown>; loadBytes?: (url: string) => Promise<Uint8Array>; observeResource?: (event: ParserResourceEvent) => void }>;
export type StaticSyntaxParser = Readonly<{ initialize(): Promise<void>; project(grammarFamily: GrammarFamily, normalizedSource: string): Promise<SyntaxObservationStream> }>;

type CursorHandle = Readonly<{ nodeType: string; nodeIsNamed: boolean; nodeIsMissing: boolean; currentFieldName: string | null; startIndex: number; endIndex: number; gotoFirstChild(): boolean; gotoNextSibling(): boolean; gotoParent(): boolean; delete(): void }>;
type RootHandle = Readonly<{ hasError: boolean; walk(): CursorHandle }>;
type TreeHandle = Readonly<{ rootNode: RootHandle; delete(): void }>;
type LanguageHandle = Readonly<Record<string, never>>;
type ParserHandle = Readonly<{ setLanguage(language: LanguageHandle): void; parse(source: string): TreeHandle | null; delete(): void }>;
type ParserConstructor = { new(): ParserHandle; init(options: Readonly<{ locateFile(path: string, scriptDirectory: string): string; print(...values: unknown[]): void; printErr(...values: unknown[]): void }>): Promise<void> };
type RuntimeModule = Readonly<{ Parser: ParserConstructor; Language: Readonly<{ load(bytes: Uint8Array): Promise<LanguageHandle> }> }>;
type Utf16Span = Readonly<{ start: number; end: number }>;

type UnitFrame = { row: number; form: ExplicitUnitForm; start: number; end: number; firstNonDecoratorStart?: number; name?: Utf16Span; ownedStarts: number[]; ownedEnds: number[]; sawGet: boolean; sawSet: boolean };
type OperatorFrame = { row: number; and: boolean; or: boolean; nullish: boolean; andAssign: boolean; orAssign: boolean; nullishAssign: boolean };
type StatementFrame = { row: number; wholeType: boolean; clause: boolean; source: boolean; specifiers: number; typeSpecifiers: number; directTypeDeclaration: boolean; exportStatement: boolean };
type SpecifierFrame = { statementDepth: number; typeToken: boolean };
type JsxFrame = { commentRows: number[]; hasNonCommentContent: boolean; start: number; end: number };
type ProjectionFrame = { ambient: boolean; unit?: UnitFrame; operator?: OperatorFrame; statement?: StatementFrame; specifier?: SpecifierFrame; jsx?: JsxFrame };

const FORBIDDEN_NON_JSX = new Set(["jsx_attribute", "jsx_closing_element", "jsx_element", "jsx_expression", "jsx_namespace_name", "jsx_opening_element", "jsx_self_closing_element", "jsx_text"]);
const LEXICAL_EXCLUSIONS = new Set(["comment", "html_comment", "hash_bang_line"]);
const FUNCTION_NODES = new Set(["function_declaration", "generator_function_declaration", "function_expression", "generator_function"]);
const RUNTIME_ANCHOR_NODES = new Set(["break_statement", "continue_statement", "debugger_statement", "do_statement", "empty_statement", "expression_statement", "for_in_statement", "for_statement", "if_statement", "labeled_statement", "lexical_declaration", "return_statement", "switch_statement", "throw_statement", "try_statement", "variable_declaration", "while_statement", "with_statement", "class_declaration"]);
const SIGNATURE_NODES = new Set(["function_signature", "method_signature", "abstract_method_signature", "call_signature", "construct_signature"]);
const TYPE_DECLARATION_NODES = new Set(["interface_declaration", "type_alias_declaration", ...SIGNATURE_NODES, "ambient_declaration"]);

function invariant(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function runtimeModule(value: unknown): RuntimeModule { invariant(typeof value === "object" && value !== null, "Parser runtime module is invalid"); const candidate = value as Partial<RuntimeModule>; invariant(typeof candidate.Parser === "function" && typeof candidate.Parser.init === "function", "Parser runtime export is invalid"); invariant(typeof candidate.Language?.load === "function", "Parser language export is invalid"); return candidate as RuntimeModule; }
async function defaultLoadBytes(url: string): Promise<Uint8Array> { const response = await fetch(url); invariant(response.ok, "Parser asset request failed"); return new Uint8Array(await response.arrayBuffer()); }
function createCursor(root: RootHandle, observe: (event: ParserResourceEvent) => void): CursorHandle { const cursor = root.walk(); observe("cursor-created"); return cursor; }
function deleteCursor(cursor: CursorHandle, observe: (event: ParserResourceEvent) => void): void { cursor.delete(); observe("cursor-deleted"); }
function advance(cursor: CursorHandle, depth: { value: number }, onExit?: (depth: number) => void): boolean { if (cursor.gotoFirstChild()) { depth.value += 1; return true; } for (;;) { onExit?.(depth.value); if (cursor.gotoNextSibling()) return true; if (!cursor.gotoParent()) return false; depth.value -= 1; } }
function validateTree(root: RootHandle, forbidJsx: boolean, observe: (event: ParserResourceEvent) => void): void { const cursor = createCursor(root, observe); let invalid = root.hasError; const depth = { value: 0 }; try { for (;;) { invalid ||= cursor.nodeType === "ERROR" || cursor.nodeIsMissing; invalid ||= forbidJsx && FORBIDDEN_NON_JSX.has(cursor.nodeType); if (!advance(cursor, depth)) break; } } finally { deleteCursor(cursor, observe); } invariant(!invalid, "Syntax validation failed"); }

const ROW_LEXICAL = 0, ROW_UNIT = 1, ROW_VALUE = 2, ROW_TYPE = 3, ROW_DECISION = 4, ROW_DISABLED = 255;
class ObservationRows {
  private capacity = 64;
  private size = 0;
  private codes = new Uint8Array(this.capacity);
  private payloads = new Uint8Array(this.capacity);
  private starts = new Uint32Array(this.capacity);
  private ends = new Uint32Array(this.capacity);
  private ownedOffsets = new Uint32Array(this.capacity);
  private ownedCounts = new Uint32Array(this.capacity);
  private ownedStarts: number[] = [];
  private ownedEnds: number[] = [];
  private grow(): void { const next = this.capacity * 2; const code = new Uint8Array(next), payload = new Uint8Array(next), start = new Uint32Array(next), end = new Uint32Array(next), offsets = new Uint32Array(next), counts = new Uint32Array(next); code.set(this.codes); payload.set(this.payloads); start.set(this.starts); end.set(this.ends); offsets.set(this.ownedOffsets); counts.set(this.ownedCounts); this.capacity = next; this.codes = code; this.payloads = payload; this.starts = start; this.ends = end; this.ownedOffsets = offsets; this.ownedCounts = counts; }
  append(code: number, payload: number, start: number, end: number): number { if (this.size === this.capacity) this.grow(); const row = this.size++; this.codes[row] = code; this.payloads[row] = payload; this.starts[row] = start; this.ends[row] = end; return row; }
  patch(row: number, code: number, payload: number, start?: number, end?: number): void { this.codes[row] = code; this.payloads[row] = payload; if (start !== undefined) this.starts[row] = start; if (end !== undefined) this.ends[row] = end; }
  disable(row: number): void { this.codes[row] = ROW_DISABLED; }
  setOwned(row: number, starts: readonly number[], ends: readonly number[]): void { this.ownedOffsets[row] = this.ownedStarts.length; this.ownedCounts[row] = starts.length; this.ownedStarts.push(...starts); this.ownedEnds.push(...ends); }
  finish(source: string) {
    let requiredEndpointCapacity = 0;
    for (let row = 0; row < this.size; row += 1) {
      const code = this.codes[row]!;
      if (code !== ROW_DISABLED) requiredEndpointCapacity += 2 + (code === ROW_UNIT ? this.ownedCounts[row]! * 2 : 0);
    }
    const requiredEndpoints = new Uint32Array(requiredEndpointCapacity);
    let collectedEndpointCount = 0, previousEndpoint = 0, endpointsSorted = true;
    for (let row = 0; row < this.size; row += 1) {
      const code = this.codes[row]!;
      if (code === ROW_DISABLED) continue;
      const start = this.starts[row]!, end = this.ends[row]!;
      endpointsSorted &&= collectedEndpointCount === 0 || start >= previousEndpoint;
      requiredEndpoints[collectedEndpointCount++] = start; previousEndpoint = start;
      endpointsSorted &&= end >= previousEndpoint;
      requiredEndpoints[collectedEndpointCount++] = end; previousEndpoint = end;
      if (code !== ROW_UNIT) continue;
      const offset = this.ownedOffsets[row]!, count = this.ownedCounts[row]!;
      for (let owned = 0; owned < count; owned += 1) {
        const ownedStart = this.ownedStarts[offset + owned]!, ownedEnd = this.ownedEnds[offset + owned]!;
        endpointsSorted &&= ownedStart >= previousEndpoint;
        requiredEndpoints[collectedEndpointCount++] = ownedStart; previousEndpoint = ownedStart;
        endpointsSorted &&= ownedEnd >= previousEndpoint;
        requiredEndpoints[collectedEndpointCount++] = ownedEnd; previousEndpoint = ownedEnd;
      }
    }
    invariant(collectedEndpointCount === requiredEndpointCapacity, "Missing required parser endpoint");
    if (!endpointsSorted) requiredEndpoints.sort();
    let endpointCount = 0;
    for (let index = 0; index < requiredEndpoints.length; index += 1) {
      const endpoint = requiredEndpoints[index]!;
      invariant(endpoint <= source.length, "Invalid parser endpoint");
      if (endpointCount === 0 || requiredEndpoints[endpointCount - 1] !== endpoint) requiredEndpoints[endpointCount++] = endpoint;
    }
    const endpoints = requiredEndpoints.subarray(0, endpointCount);
    let byteEndpoints: Uint32Array | undefined;
    let endpointIndex = 0, utf16Offset = 0, utf8Offset = 0;
    while (utf16Offset < source.length) {
      if (endpointIndex < endpointCount && endpoints[endpointIndex] === utf16Offset) { if (byteEndpoints) byteEndpoints[endpointIndex] = utf8Offset; endpointIndex += 1; }
      const codePoint = source.codePointAt(utf16Offset)!;
      const scalarLength = codePoint > 0xffff ? 2 : 1;
      invariant(!(scalarLength === 1 && codePoint >= 0xd800 && codePoint <= 0xdfff), "Malformed Unicode scalar");
      if (codePoint > 0x7f && !byteEndpoints) { byteEndpoints = new Uint32Array(endpointCount); for (let prior = 0; prior < endpointIndex; prior += 1) byteEndpoints[prior] = endpoints[prior]!; }
      const scalarEnd = utf16Offset + scalarLength;
      invariant(endpointIndex >= endpointCount || endpoints[endpointIndex]! >= scalarEnd, "Parser endpoint splits a surrogate pair");
      utf8Offset += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
      utf16Offset = scalarEnd;
    }
    if (endpointIndex < endpointCount && endpoints[endpointIndex] === utf16Offset) { if (byteEndpoints) byteEndpoints[endpointIndex] = utf8Offset; endpointIndex += 1; }
    invariant(endpointIndex === endpointCount, "Invalid parser endpoint");
    const translate = (endpoint: number): number => {
      if (!byteEndpoints) return endpoint;
      let low = 0, high = endpointCount;
      while (low < high) { const middle = (low + high) >>> 1; if (endpoints[middle]! < endpoint) low = middle + 1; else high = middle; }
      invariant(low < endpointCount && endpoints[low] === endpoint, "Missing parser endpoint translation");
      return byteEndpoints[low]!;
    };
    const writer = createSyntaxObservationWriter();
    for (let row = 0; row < this.size; row += 1) {
      const code = this.codes[row]!; if (code === ROW_DISABLED) continue;
      const start = translate(this.starts[row]!), end = translate(this.ends[row]!);
      if (code === ROW_LEXICAL) writer.appendLexical(start, end);
      else if (code === ROW_VALUE) writer.appendValue(VALUE_ANCHOR_KINDS[this.payloads[row]!]!, start, end);
      else if (code === ROW_TYPE) writer.appendType(TYPE_ONLY_KINDS[this.payloads[row]!]!, start, end);
      else if (code === ROW_DECISION) writer.appendDecision(DECISION_KINDS[this.payloads[row]!]!, start, end);
      else {
        const offset = this.ownedOffsets[row]!, count = this.ownedCounts[row]!; const starts = new Uint32Array(count), ends = new Uint32Array(count);
        for (let owned = 0; owned < count; owned += 1) { starts[owned] = translate(this.ownedStarts[offset + owned]!); ends[owned] = translate(this.ownedEnds[offset + owned]!); }
        writer.appendExplicit(EXPLICIT_UNIT_FORMS[this.payloads[row]!]!, start, end, starts, ends);
      }
    }
    return writer.finish();
  }
}

function payload<T extends readonly string[]>(values: T, value: T[number]): number { const index = values.indexOf(value); invariant(index >= 0, "Unknown observation payload"); return index; }
function exactAscii(source: string, span: Utf16Span, expected: string): boolean { if (span.end - span.start !== expected.length) return false; for (let index = 0; index < expected.length; index += 1) if (source.charCodeAt(span.start + index) !== expected.charCodeAt(index)) return false; return true; }
function decisionForNode(nodeType: string): DecisionKind | undefined { if (nodeType === "if_statement") return "if"; if (["do_statement", "for_in_statement", "for_statement", "while_statement"].includes(nodeType)) return "loop"; if (nodeType === "switch_case") return "case"; if (nodeType === "catch_clause") return "catch"; if (nodeType === "ternary_expression") return "ternary"; return undefined; }
function unitForNode(nodeType: string): ExplicitUnitForm | undefined { if (FUNCTION_NODES.has(nodeType)) return "function"; if (nodeType === "arrow_function") return "arrow"; if (nodeType === "method_definition") return "method"; if (nodeType === "class_static_block") return "static-block"; return undefined; }
function fixedClassification(nodeType: string): { code: number; payload: number } | undefined {
  if (nodeType === "interface_declaration" || nodeType === "type_alias_declaration") return { code: ROW_TYPE, payload: payload(TYPE_ONLY_KINDS, "interface/type alias") };
  if (SIGNATURE_NODES.has(nodeType)) return { code: ROW_TYPE, payload: payload(TYPE_ONLY_KINDS, "signature-only") };
  if (nodeType === "ambient_declaration") return { code: ROW_TYPE, payload: payload(TYPE_ONLY_KINDS, "ambient/declare") };
  if (nodeType === "enum_declaration" || nodeType === "internal_module") return { code: ROW_VALUE, payload: payload(VALUE_ANCHOR_KINDS, "nonambient runtime TypeScript enum/namespace") };
  if (RUNTIME_ANCHOR_NODES.has(nodeType)) return { code: ROW_VALUE, payload: payload(VALUE_ANCHOR_KINDS, "runtime-statement/declaration") };
  if (nodeType === "jsx_element" || nodeType === "jsx_self_closing_element") return { code: ROW_VALUE, payload: payload(VALUE_ANCHOR_KINDS, "top-level JSX") };
  return undefined;
}

function projectTree(root: RootHandle, source: string, observe: (event: ParserResourceEvent) => void) {
  const cursor = createCursor(root, observe), rows = new ObservationRows(), frames: ProjectionFrame[] = []; const depth = { value: 0 };
  function finishFrame(exitingDepth: number): void {
    const frame = frames[exitingDepth]; if (!frame) return;
    if (frame.operator) { const op = frame.operator; const kind: DecisionKind | undefined = op.andAssign ? "logical-and-assign" : op.orAssign ? "logical-or-assign" : op.nullishAssign ? "nullish-assign" : op.and ? "logical-and" : op.or ? "logical-or" : op.nullish ? "nullish" : undefined; if (kind) rows.patch(op.row, ROW_DECISION, payload(DECISION_KINDS, kind)); else rows.disable(op.row); }
    if (frame.specifier) { const statement = frames[frame.specifier.statementDepth]?.statement; invariant(statement, "Detached import/export specifier"); statement.specifiers += 1; if (frame.specifier.typeToken) statement.typeSpecifiers += 1; }
    if (frame.statement) { const item = frame.statement; const typeKind: TypeOnlyKind | undefined = item.wholeType || item.directTypeDeclaration ? "import/export type" : item.clause && item.specifiers === 0 && item.exportStatement && !item.source ? "exact export{}" : item.clause && item.specifiers > 0 && item.specifiers === item.typeSpecifiers ? "import/export lists all specifiers type-only" : undefined; if (typeKind) rows.patch(item.row, ROW_TYPE, payload(TYPE_ONLY_KINDS, typeKind)); else rows.patch(item.row, ROW_VALUE, payload(VALUE_ANCHOR_KINDS, "value-or-side-effect-import-export")); }
    if (frame.jsx && frame.jsx.commentRows.length > 0 && !frame.jsx.hasNonCommentContent) { const [first, ...rest] = frame.jsx.commentRows; rows.patch(first!, ROW_LEXICAL, 0, frame.jsx.start, frame.jsx.end); for (const row of rest) rows.disable(row); }
    if (frame.unit) { const unit = frame.unit; let form = unit.form; if (form === "method") { if (unit.sawGet) form = "getter"; else if (unit.sawSet) form = "setter"; else if (unit.name && exactAscii(source, unit.name, "constructor")) form = "constructor"; } invariant(unit.ownedStarts.length > 0, "Explicit unit has no body-bearing owned region"); rows.patch(unit.row, ROW_UNIT, payload(EXPLICIT_UNIT_FORMS, form), unit.firstNonDecoratorStart ?? unit.start, unit.end); rows.setOwned(unit.row, unit.ownedStarts, unit.ownedEnds); }
    frames.length = exitingDepth;
  }
  try {
    for (;;) {
      const nodeType = cursor.nodeType, start = cursor.startIndex, end = cursor.endIndex, field = cursor.currentFieldName; invariant(Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end >= start && end <= 0xffff_ffff, "Invalid parser endpoint");
      const parent = frames[depth.value - 1];
      if (parent?.unit) { if (nodeType !== "decorator" && parent.unit.firstNonDecoratorStart === undefined) parent.unit.firstNonDecoratorStart = start; if (field === "name") parent.unit.name = { start, end }; if (field === "parameters" || field === "parameter" || field === "body") { parent.unit.ownedStarts.push(start); parent.unit.ownedEnds.push(end); } if (nodeType === "get") parent.unit.sawGet = true; if (nodeType === "set") parent.unit.sawSet = true; }
      if (parent?.operator) { if (nodeType === "&&") parent.operator.and = true; else if (nodeType === "||") parent.operator.or = true; else if (nodeType === "??") parent.operator.nullish = true; else if (nodeType === "&&=") parent.operator.andAssign = true; else if (nodeType === "||=") parent.operator.orAssign = true; else if (nodeType === "??=") parent.operator.nullishAssign = true; }
      if (parent?.statement) { if (nodeType === "type") parent.statement.wholeType = true; if (nodeType === "export_clause" || nodeType === "named_imports") parent.statement.clause = true; if (field === "source" || nodeType === "from") parent.statement.source = true; if (TYPE_DECLARATION_NODES.has(nodeType)) parent.statement.directTypeDeclaration = true; }
      if (parent?.specifier && nodeType === "type") parent.specifier.typeToken = true;
      for (let owner = depth.value - 1; owner >= 0; owner -= 1) { const jsx = frames[owner]?.jsx; if (jsx) { if (!LEXICAL_EXCLUSIONS.has(nodeType) && nodeType !== "{" && nodeType !== "}") jsx.hasNonCommentContent = true; break; } }
      const ambient = (parent?.ambient ?? false) || nodeType === "ambient_declaration";
      let unit: UnitFrame | undefined;
      const form = !ambient ? unitForNode(nodeType) : undefined;
      if (form) { const row = rows.append(ROW_UNIT, payload(EXPLICIT_UNIT_FORMS, form), start, end); rows.append(ROW_VALUE, payload(VALUE_ANCHOR_KINDS, "explicit-unit-declaration/expression"), start, end); unit = { row, form, start, end, ownedStarts: [], ownedEnds: [], sawGet: false, sawSet: false }; }
      let operator: OperatorFrame | undefined;
      if (!ambient && (nodeType === "binary_expression" || nodeType === "augmented_assignment_expression")) operator = { row: rows.append(ROW_DECISION, 0, start, end), and: false, or: false, nullish: false, andAssign: false, orAssign: false, nullishAssign: false };
      let statement: StatementFrame | undefined;
      if (!ambient && (nodeType === "import_statement" || nodeType === "export_statement")) statement = { row: rows.append(ROW_TYPE, 0, start, end), wholeType: false, clause: false, source: false, specifiers: 0, typeSpecifiers: 0, directTypeDeclaration: false, exportStatement: nodeType === "export_statement" };
      let statementDepth = -1; for (let owner = depth.value - 1; owner >= 0; owner -= 1) if (frames[owner]?.statement) { statementDepth = owner; break; }
      if (statementDepth >= 0 && (nodeType === "export_clause" || nodeType === "named_imports")) frames[statementDepth]!.statement!.clause = true;
      const specifier = statementDepth >= 0 && (nodeType === "import_specifier" || nodeType === "export_specifier") ? { statementDepth, typeToken: false } : undefined;
      const jsx = nodeType === "jsx_expression" ? { commentRows: [], hasNonCommentContent: false, start, end } : undefined;
      frames[depth.value] = { ambient, ...(unit ? { unit } : {}), ...(operator ? { operator } : {}), ...(statement ? { statement } : {}), ...(specifier ? { specifier } : {}), ...(jsx ? { jsx } : {}) }; frames.length = depth.value + 1;
      if (LEXICAL_EXCLUSIONS.has(nodeType)) { const row = rows.append(ROW_LEXICAL, 0, start, end); for (let owner = depth.value - 1; owner >= 0; owner -= 1) if (frames[owner]?.jsx) { frames[owner]!.jsx!.commentRows.push(row); break; } }
      if (!ambient || nodeType === "ambient_declaration") { if (!statement) { const classified = fixedClassification(nodeType); if (classified && (!ambient || nodeType === "ambient_declaration")) rows.append(classified.code, classified.payload, start, end); } const decision = !ambient ? decisionForNode(nodeType) : undefined; if (decision) rows.append(ROW_DECISION, payload(DECISION_KINDS, decision), start, end); }
      if (!advance(cursor, depth, finishFrame)) break;
    }
  } finally { deleteCursor(cursor, observe); }
  return rows.finish(source);
}

type CSharpUnitFrame = { row: number; form?: ExplicitUnitForm; nodeType: string; start: number; end: number; ownedStarts: number[]; ownedEnds: number[] };
type CSharpOperatorFrame = { row: number; and: boolean; or: boolean; nullish: boolean; nullishAssign: boolean };
type CSharpFrame = {
  nodeType: string;
  excluded: boolean;
  declarationConst: boolean;
  sawPrimaryParameters: boolean;
  primaryBase: boolean;
  unit?: CSharpUnitFrame;
  operator?: CSharpOperatorFrame;
  switchArm?: { row: number; discard: boolean; guarded: boolean };
  switchSection?: { row: number; hasCase: boolean };
  variableAnchor?: { row: number; hasInitializer: boolean };
  topLevelAnchor?: { row: number; suppressed: boolean };
};

const CSHARP_CALLABLE_FORMS: Readonly<Record<string, ExplicitUnitForm>> = {
  method_declaration: "method",
  local_function_statement: "function",
  constructor_declaration: "constructor",
  destructor_declaration: "method",
  operator_declaration: "method",
  conversion_operator_declaration: "method",
  lambda_expression: "arrow",
  anonymous_method_expression: "function",
};
const CSHARP_LOOPS = new Set(["do_statement", "for_statement", "foreach_statement", "while_statement"]);
const CSHARP_DECLARATIONS_WITH_INITIALIZERS = new Set(["field_declaration", "event_field_declaration"]);
const CSHARP_CONST_DECLARATIONS = new Set(["field_declaration", "local_declaration_statement"]);
const CSHARP_EXCLUDED_ROOTS = new Set(["attribute", "attribute_list", "global_attribute", "parameter_list", "bracketed_parameter_list", "parameter", "implicit_parameter", "enum_member_declaration"]);

function isDirectTopLevelPreprocessorBody(frames: readonly (CSharpFrame | undefined)[], depth: number): boolean {
  let parent = depth - 1;
  if (parent < 0 || !frames[parent]!.nodeType.startsWith("preproc_")) return false;
  while (parent >= 0 && frames[parent]!.nodeType.startsWith("preproc_")) parent -= 1;
  return parent >= 0 && frames[parent]!.nodeType === "compilation_unit";
}

function projectCSharpTree(root: RootHandle, source: string, observe: (event: ParserResourceEvent) => void) {
  const cursor = createCursor(root, observe), rows = new ObservationRows(), frames: Array<CSharpFrame | undefined> = []; const depth = { value: 0 };
  function finishFrame(exitingDepth: number): void {
    const frame = frames[exitingDepth]; if (!frame) return;
    if (frame.operator) {
      const operator = frame.operator;
      const kind: DecisionKind | undefined = operator.nullishAssign ? "nullish-assign" : operator.and ? "logical-and" : operator.or ? "logical-or" : operator.nullish ? "nullish" : undefined;
      if (kind) rows.patch(operator.row, ROW_DECISION, payload(DECISION_KINDS, kind)); else rows.disable(operator.row);
    }
    if (frame.switchArm) {
      const arm = frame.switchArm;
      if (arm.discard && !arm.guarded) rows.disable(arm.row);
      else rows.patch(arm.row, ROW_DECISION, payload(DECISION_KINDS, "case"));
    }
    if (frame.switchSection) {
      if (frame.switchSection.hasCase) rows.patch(frame.switchSection.row, ROW_DECISION, payload(DECISION_KINDS, "case"));
      else rows.disable(frame.switchSection.row);
    }
    if (frame.variableAnchor && !frame.variableAnchor.hasInitializer) rows.disable(frame.variableAnchor.row);
    if (frame.topLevelAnchor?.suppressed) rows.disable(frame.topLevelAnchor.row);
    if (frame.unit) {
      const unit = frame.unit;
      if (!unit.form || unit.ownedStarts.length === 0) rows.disable(unit.row);
      else {
        rows.patch(unit.row, ROW_UNIT, payload(EXPLICIT_UNIT_FORMS, unit.form));
        rows.setOwned(unit.row, unit.ownedStarts, unit.ownedEnds);
      }
    }
    frames.length = exitingDepth;
  }
  try {
    for (;;) {
      const nodeType = cursor.nodeType, start = cursor.startIndex, end = cursor.endIndex, field = cursor.currentFieldName; invariant(Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end >= start && end <= 0xffff_ffff, "Invalid parser endpoint");
      const parent = frames[depth.value - 1];
      if (nodeType === "const" && parent?.nodeType === "modifier") {
        for (let owner = depth.value - 2; owner >= 0; owner -= 1) {
          const declaration = frames[owner];
          if (!declaration || !CSHARP_CONST_DECLARATIONS.has(declaration.nodeType)) continue;
          declaration.declarationConst = true;
          if (declaration.topLevelAnchor) declaration.topLevelAnchor.suppressed = true;
          const enclosing = frames[owner - 1];
          if (enclosing?.nodeType === "global_statement" && enclosing.topLevelAnchor) enclosing.topLevelAnchor.suppressed = true;
          break;
        }
      }
      if (parent?.unit) {
        const unit = parent.unit;
        if (field === "body" || (unit.nodeType === "anonymous_method_expression" && nodeType === "block") || ((unit.nodeType === "property_declaration" || unit.nodeType === "indexer_declaration") && field === "value" && nodeType === "arrow_expression_clause")) {
          unit.ownedStarts.push(start); unit.ownedEnds.push(end);
        }
        if (unit.nodeType === "constructor_declaration" && nodeType === "constructor_initializer") { unit.ownedStarts.push(start); unit.ownedEnds.push(end); }
        if (unit.nodeType === "accessor_declaration" && field === "name") {
          if (nodeType === "get") unit.form = "getter";
          else if (["set", "init", "add", "remove"].includes(nodeType)) unit.form = "setter";
        }
      }
      if (parent?.operator) {
        if (nodeType === "&&") parent.operator.and = true;
        else if (nodeType === "||") parent.operator.or = true;
        else if (nodeType === "??") parent.operator.nullish = true;
        else if (nodeType === "??=") parent.operator.nullishAssign = true;
      }
      if (parent?.switchArm) { if (nodeType === "discard") parent.switchArm.discard = true; if (nodeType === "when_clause") parent.switchArm.guarded = true; }
      if (parent?.switchSection && nodeType === "case") parent.switchSection.hasCase = true;
      if (parent?.variableAnchor && nodeType === "=") parent.variableAnchor.hasInitializer = true;
      if (parent && nodeType === "parameter_list") parent.sawPrimaryParameters = true;

      const preprocessorCondition = field === "condition" && (parent?.nodeType === "preproc_if" || parent?.nodeType === "preproc_elif");
      const excluded = (parent?.excluded ?? false) || (parent?.declarationConst ?? false) || CSHARP_EXCLUDED_ROOTS.has(nodeType) || preprocessorCondition;
      const form = CSHARP_CALLABLE_FORMS[nodeType] ?? ((nodeType === "property_declaration" || nodeType === "indexer_declaration") ? "getter" : undefined);
      let unit: CSharpUnitFrame | undefined;
      if (!excluded && (form || nodeType === "accessor_declaration")) unit = { row: rows.append(ROW_UNIT, 0, start, end), form, nodeType, start, end, ownedStarts: [], ownedEnds: [] };

      let operator: CSharpOperatorFrame | undefined;
      if (!excluded && (nodeType === "binary_expression" || nodeType === "assignment_expression")) operator = { row: rows.append(ROW_DECISION, 0, start, end), and: false, or: false, nullish: false, nullishAssign: false };
      const switchArm = !excluded && nodeType === "switch_expression_arm" ? { row: rows.append(ROW_DECISION, 0, start, end), discard: false, guarded: false } : undefined;
      const switchSection = !excluded && nodeType === "switch_section" ? { row: rows.append(ROW_DECISION, 0, start, end), hasCase: false } : undefined;

      const variableOwner = frames[depth.value - 2];
      const variableAnchor = !excluded && nodeType === "variable_declarator" && parent?.nodeType === "variable_declaration" && variableOwner && CSHARP_DECLARATIONS_WITH_INITIALIZERS.has(variableOwner.nodeType)
        ? { row: rows.append(ROW_VALUE, payload(VALUE_ANCHOR_KINDS, "runtime-statement/declaration"), start, end), hasInitializer: false }
        : undefined;
      const topLevel = !excluded && (nodeType === "global_statement" || ((nodeType.endsWith("_statement") || nodeType === "block") && isDirectTopLevelPreprocessorBody(frames, depth.value)));
      const topLevelAnchor = topLevel ? { row: rows.append(ROW_VALUE, payload(VALUE_ANCHOR_KINDS, "runtime-statement/declaration"), start, end), suppressed: false } : undefined;
      if (!excluded && parent?.nodeType === "property_declaration" && field === "value" && nodeType !== "arrow_expression_clause") rows.append(ROW_VALUE, payload(VALUE_ANCHOR_KINDS, "runtime-statement/declaration"), start, end);
      if (!excluded && parent?.nodeType === "base_list" && parent.primaryBase && nodeType === "argument_list") rows.append(ROW_VALUE, payload(VALUE_ANCHOR_KINDS, "runtime-statement/declaration"), start, end);

      const primaryBase = nodeType === "base_list" && Boolean(parent?.sawPrimaryParameters);
      frames[depth.value] = { nodeType, excluded, declarationConst: false, sawPrimaryParameters: false, primaryBase, ...(unit ? { unit } : {}), ...(operator ? { operator } : {}), ...(switchArm ? { switchArm } : {}), ...(switchSection ? { switchSection } : {}), ...(variableAnchor ? { variableAnchor } : {}), ...(topLevelAnchor ? { topLevelAnchor } : {}) };
      frames.length = depth.value + 1;
      if (nodeType === "comment") rows.append(ROW_LEXICAL, 0, start, end);
      if (!excluded) {
        let decision: DecisionKind | undefined;
        if (nodeType === "if_statement" || nodeType === "when_clause" || nodeType === "catch_filter_clause") decision = "if";
        else if (CSHARP_LOOPS.has(nodeType)) decision = "loop";
        else if (nodeType === "catch_clause") decision = "catch";
        else if (nodeType === "conditional_expression") decision = "ternary";
        if (decision) rows.append(ROW_DECISION, payload(DECISION_KINDS, decision), start, end);
      }
      if (!advance(cursor, depth, finishFrame)) break;
    }
  } finally { deleteCursor(cursor, observe); }
  return rows.finish(source);
}

export function createTreeSitterAdapter(assets: ParserAssetUrls, options: ParserAdapterOptions = {}): StaticSyntaxParser {
  const importRuntime = options.importRuntime ?? ((url: string) => import(/* @vite-ignore */ url)); const loadBytes = options.loadBytes ?? defaultLoadBytes; const observe = options.observeResource ?? (() => {});
  let initialization: Promise<Readonly<{ runtime: RuntimeModule; javascript: LanguageHandle; typescript: LanguageHandle; tsx: LanguageHandle; csharp?: LanguageHandle }>> | undefined;
  async function initializeAll() { const runtime = runtimeModule(await importRuntime(assets.runtimeJavaScript)); await runtime.Parser.init({ locateFile(requestedPath) { if (requestedPath === "web-tree-sitter.wasm") return assets.runtimeWasm; throw new Error("Unexpected parser runtime asset request"); }, print() {}, printErr() {} }); const javascript = await runtime.Language.load(await loadBytes(assets.grammarJavaScript)); const typescript = await runtime.Language.load(await loadBytes(assets.grammarTypeScript)); const tsx = await runtime.Language.load(await loadBytes(assets.grammarTsx)); const csharp = assets.grammarCSharp ? await runtime.Language.load(await loadBytes(assets.grammarCSharp)) : undefined; return { runtime, javascript, typescript, tsx, ...(csharp ? { csharp } : {}) }; }
  return { async initialize() { initialization ??= initializeAll(); await initialization; }, async project(grammarFamily, normalizedSource) { if (grammarFamily === "csharp" && !assets.grammarCSharp) throw new Error("C# parser asset is not configured"); initialization ??= initializeAll(); const initialized = await initialization; const language = grammarFamily === "csharp" ? initialized.csharp : grammarFamily === "typescript" ? initialized.typescript : grammarFamily === "tsx" ? initialized.tsx : initialized.javascript; invariant(language, "Parser language is not configured"); let parser: ParserHandle | undefined, tree: TreeHandle | undefined; try { parser = new initialized.runtime.Parser(); observe("parser-created"); parser.setLanguage(language); tree = parser.parse(normalizedSource) ?? undefined; invariant(tree, "Parser returned no tree"); observe("tree-created"); validateTree(tree.rootNode, grammarFamily === "javascript-no-jsx", observe); const observations = grammarFamily === "csharp" ? projectCSharpTree(tree.rootNode, normalizedSource, observe) : projectTree(tree.rootNode, normalizedSource, observe); observe("observation-stream-created"); let released = false; return { observations, release() { if (!released) { released = true; observe("observation-stream-released"); } } }; } finally { if (tree) { tree.delete(); observe("tree-deleted"); } if (parser) { parser.delete(); observe("parser-deleted"); } } } };
}
