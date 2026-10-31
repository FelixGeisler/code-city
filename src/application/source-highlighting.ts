/** Display-only lexical coloring. No AST, metric computation, HTML or source execution. */
export const SYNTAX_KINDS = ["keyword", "type", "string", "comment", "number", "operator", "regex", "tag", "attribute"] as const;
export type SyntaxKind = typeof SYNTAX_KINDS[number];
export type SyntaxSpan = Readonly<{ kind: SyntaxKind; start: number; end: number }>;
const jsKeywords = new Set("as async await break case catch class const continue debugger declare default delete do else enum export extends finally for from function get if implements import in infer instanceof interface is keyof let namespace new of private protected public readonly return satisfies set static super switch this throw try type typeof using var void while with yield abstract accessor asserts constructor override out".split(" "));
const csKeywords = new Set("abstract as async await base break case catch checked class const continue default delegate do else enum event explicit extern false finally fixed for foreach goto if implicit in interface internal is lock namespace new null operator out override params partial private protected public readonly record ref required return sealed sizeof stackalloc static struct switch this throw true try typeof unchecked unsafe using virtual volatile when where while yield get set init add remove file global scoped with var nameof".split(" "));
const types = new Set("any bigint boolean bool byte char decimal double dynamic float int long never number object sbyte short string symbol uint ulong undefined unknown ushort void nint nuint".split(" "));
const literals = new Set(["true", "false", "null", "undefined"]);
const controls = new Set(["if", "while", "for", "with", "switch", "catch"]);
const idStart = /[$_\p{ID_Start}]/u, idPart = /[$_\u200c\u200d\p{ID_Continue}]/u;
const number = /^(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?[\d_]+)?)(?:[nNmMdDfFlLuU]{0,2})/u;
type Code = { mode: "code"; stop: number; braces: boolean[]; parens: boolean[]; regex: boolean; control: boolean; last: string };
type Quote = { mode: "quote"; quote: string; width: number; verbatim: boolean; escapes: boolean; interpolation: "dollar" | "brace" | undefined; braces: number; segment: number };
type Jsx = { mode: "jsx"; depth: number };
type Tag = { mode: "tag"; closing: boolean; name: boolean };
const code = (stop = 0): Code => ({ mode: "code", stop, braces: [], parens: [], regex: true, control: false, last: "" });

function scanSourceColoring(path: string, text: string) {
  const csharp = /\.cs$/iu.test(path), jsx = /\.(?:jsx|tsx)$/iu.test(path), keywords = csharp ? csKeywords : jsKeywords;
  const starts: number[] = [], ends: number[] = [], kinds: number[] = [];
  const stack: Array<Code | Quote | Jsx | Tag> = [code()];
  let position = 0, failedRegexUntil = -1;
  const scalar = (offset: number) => String.fromCodePoint(text.codePointAt(offset)!);
  const run = (offset: number, value: string) => { let end = offset; while (text[end] === value) end++; return end - offset; };
  const emit = (kind: SyntaxKind, start: number, end: number) => {
    if (end <= start) return;
    const value = SYNTAX_KINDS.indexOf(kind), last = starts.length - 1;
    if (last >= 0 && ends[last] === start && kinds[last] === value) ends[last] = end;
    else { starts.push(start); ends.push(end); kinds.push(value); }
  };
  const resume = () => { const parent = stack.at(-1); if (parent?.mode === "quote") parent.segment = position; else if (parent?.mode === "code") { parent.regex = false; parent.last = "value"; } };
  function quote(): boolean {
    const start = position; let offset = position, dollars = 0, verbatim = false;
    if (csharp) {
      if (text[offset] === "@") { verbatim = true; offset++; }
      while (text[offset] === "$") { dollars++; offset++; }
      if (!verbatim && text[offset] === "@") { verbatim = true; offset++; }
    }
    const value = text[offset];
    if (value !== '"' && value !== "'" && (csharp || value !== "`")) return false;
    if (csharp && (dollars || verbatim) && value !== '"') return false;
    let width = csharp && value === '"' ? run(offset, '"') : 1;
    if (width < 3) width = 1;
    stack.push({ mode: "quote", quote: value!, width, verbatim: verbatim && width === 1, escapes: !verbatim && width === 1, interpolation: csharp ? dollars ? "brace" : undefined : value === "`" ? "dollar" : undefined, braces: Math.max(1, dollars), segment: start });
    position = offset + width; return true;
  }
  function jsxStart(offset: number): boolean {
    if (text[offset + 1] === ">" || text[offset + 1] === "/") return true;
    if (offset + 1 >= text.length || !idStart.test(scalar(offset + 1))) return false;
    let end = offset + 1;
    while (end < text.length && (idPart.test(scalar(end)) || /[.:-]/u.test(text[end]!))) end += scalar(end).length;
    return !/^\s*(?:,|extends\b(?!\s*=))/u.test(text.slice(end));
  }
  function regexEnd(start: number): number {
    let bracket = false;
    for (let offset = start + 1; offset < text.length; offset++) {
      const value = text[offset];
      if (value === "\n" || value === "\r") { failedRegexUntil = offset; return -1; }
      if (value === "\\") { offset++; continue; }
      if (value === "[") bracket = true; else if (value === "]") bracket = false;
      else if (value === "/" && !bracket) { offset++; while (offset < text.length && /[a-z]/iu.test(text[offset]!)) offset++; return offset; }
    }
    failedRegexUntil = text.length; return -1;
  }
  while (position < text.length) {
    const frame = stack.at(-1)!;
    const value = text[position]!;
    if (frame.mode === "quote") {
      if (frame.escapes && value === "\\") { position += Math.min(2, text.length - position); continue; }
      if (frame.verbatim && value === '"' && text[position + 1] === '"') { position += 2; continue; }
      if (value === frame.quote) {
        const quotes = frame.width === 1 ? 1 : run(position, value);
        if (quotes >= frame.width) { position += frame.width; emit("string", frame.segment, position); stack.pop(); resume(); }
        else position += quotes;
        continue;
      }
      if (frame.interpolation === "brace" && frame.width === 1 && ((value === "{" && text[position + 1] === "{") || (value === "}" && text[position + 1] === "}"))) { position += 2; continue; }
      let interpolation = frame.interpolation === "dollar" && value === "$" && text[position + 1] === "{" ? 2 : 0;
      if (frame.interpolation === "brace" && value === "{") { const braces = run(position, "{"); if (braces >= frame.braces) interpolation = frame.braces; else { position += braces; continue; } }
      if (interpolation) { emit("string", frame.segment, position); emit("operator", position, position + interpolation); position += interpolation; stack.push(code(frame.interpolation === "dollar" ? 1 : frame.braces)); continue; }
      position += scalar(position).length; continue;
    }
    if (frame.mode === "jsx") {
      if (value === "<") { const closing = text[position + 1] === "/"; emit("operator", position, position + (closing ? 2 : 1)); position += closing ? 2 : 1; stack.push({ mode: "tag", closing, name: true }); }
      else if (value === "{") { emit("operator", position, position + 1); position++; stack.push(code(1)); }
      else position += scalar(position).length;
      continue;
    }
    if (frame.mode === "tag") {
      const selfClosing = value === "/" && text[position + 1] === ">";
      if (value === ">" || selfClosing) {
        const parent = stack[stack.length - 2] as Jsx;
        if (frame.closing) parent.depth--; else if (!selfClosing) parent.depth++;
        emit("operator", position, position + (selfClosing ? 2 : 1)); position += selfClosing ? 2 : 1; stack.pop();
        if (parent.depth === 0) { stack.pop(); resume(); }
      } else if (value === "{") { emit("operator", position, position + 1); position++; stack.push(code(1)); }
      else if (value === '"' || value === "'") { stack.push({ mode: "quote", quote: value, width: 1, verbatim: false, escapes: false, interpolation: undefined, braces: 1, segment: position++ }); }
      else if (idPart.test(scalar(position)) || /[:-]/u.test(value)) { const start = position; position += scalar(position).length; while (position < text.length && (idPart.test(scalar(position)) || /[.:-]/u.test(text[position]!))) position += scalar(position).length; emit(frame.name ? "tag" : "attribute", start, position); frame.name = false; }
      else { if (value === "=") emit("operator", position, position + 1); position++; }
      continue;
    }
    if (/\s/u.test(value)) { position++; continue; }
    if (frame.stop && value === "}" && frame.braces.length === 0) {
      const braces = run(position, "}");
      if (braces >= frame.stop) { emit("operator", position, position + frame.stop); position += frame.stop; stack.pop(); resume(); }
      else { position += braces; frame.regex = true; frame.last = "}"; }
      continue;
    }
    if (text.startsWith("//", position)) { const start = position; const end = text.indexOf("\n", position + 2); position = end < 0 ? text.length : end; emit("comment", start, position); continue; }
    if (text.startsWith("/*", position)) { const start = position, end = text.indexOf("*/", position + 2); position = end < 0 ? text.length : end + 2; emit("comment", start, position); continue; }
    if (quote()) continue;
    if (!csharp && value === "/" && frame.regex && position >= failedRegexUntil) { const end = regexEnd(position); if (end > 0) { emit("regex", position, end); position = end; frame.regex = false; frame.last = "value"; continue; } }
    if (jsx && value === "<" && jsxStart(position)) { stack.push({ mode: "jsx", depth: 0 }); continue; }
    if (/\d/u.test(value) || (value === "." && /\d/u.test(text[position + 1] ?? ""))) { const match = number.exec(text.slice(position)); if (match) { emit("number", position, position + match[0].length); position += match[0].length; frame.regex = false; frame.last = "value"; continue; } }
    const escaped = csharp && value === "@" && position + 1 < text.length && idStart.test(scalar(position + 1));
    if (idStart.test(scalar(position)) || escaped) {
      const start = position; if (escaped) position++;
      position += scalar(position).length; while (position < text.length && idPart.test(scalar(position))) position += scalar(position).length;
      const word = text.slice(start, position);
      if (!escaped) { if (types.has(word)) emit("type", start, position); else if (keywords.has(word) || literals.has(word)) emit("keyword", start, position); }
      frame.control = controls.has(word) || (frame.control && word === "await"); frame.regex = keywords.has(word) && !["this", "super"].includes(word); frame.last = word; continue;
    }
    if (value === "(") { frame.parens.push(frame.control); frame.control = false; frame.regex = true; }
    else if (value === ")") frame.regex = frame.parens.pop() ?? false;
    else if (value === "{") { frame.braces.push(["=", ":", "(", "[", ",", "return"].includes(frame.last)); frame.regex = true; }
    else if (value === "}") frame.regex = !(frame.braces.pop() ?? false);
    else if (value === "]") frame.regex = false;
    else if (value === "[") frame.regex = true;
    else if (/[=+\-*/%&|!^~?:<>]/u.test(value)) {
      const start = position++;
      while (position < text.length && /[=+\-*/%&|!^~?:<>]/u.test(text[position]!) && !text.startsWith("//", position) && !text.startsWith("/*", position)) position++;
      const operator = text.slice(start, position); emit("operator", start, position); frame.regex = !(["++", "--"].includes(operator) && !frame.regex); frame.last = operator; continue;
    } else if (value !== ".") frame.regex = true;
    frame.last = value; position += scalar(position).length;
  }
  const unclosed = stack.at(-1);
  if (unclosed?.mode === "quote") emit("string", unclosed.segment, text.length);
  return { starts: Uint32Array.from(starts), ends: Uint32Array.from(ends), kinds: Uint8Array.from(kinds) };
}

export function createSourceColoring(path: string, text: string) {
  const { starts: packedStarts, ends: packedEnds, kinds: packedKinds } = scanSourceColoring(path, text);
  return (start: number, end: number): readonly SyntaxSpan[] => {
    const result: SyntaxSpan[] = []; let low = 0, high = packedStarts.length;
    while (low < high) { const middle = (low + high) >>> 1; if (packedEnds[middle]! <= start) low = middle + 1; else high = middle; }
    for (let index = low; index < packedStarts.length && packedStarts[index]! < end; index++) result.push({ kind: SYNTAX_KINDS[packedKinds[index]!]!, start: Math.max(start, packedStarts[index]!) - start, end: Math.min(end, packedEnds[index]!) - start });
    return result;
  };
}
