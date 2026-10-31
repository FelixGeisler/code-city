import { createHighlighterCore } from "shiki/core";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";
import getWasm from "shiki/wasm";
import javascript from "shiki/langs/javascript.mjs";
import jsx from "shiki/langs/jsx.mjs";
import typescript from "shiki/langs/typescript.mjs";
import tsx from "shiki/langs/tsx.mjs";
import csharp from "shiki/langs/csharp.mjs";
import githubDark from "shiki/themes/github-dark.mjs";

import { SYNTAX_PALETTE, type SourceColoring, type SyntaxSpan } from "../application/source-highlighting";
export { SYNTAX_PALETTE } from "../application/source-highlighting";
let highlighter: ReturnType<typeof createHighlighterCore> | undefined;
function initialize() {
  // These five grammars are self-contained in 4.5.0 (no external embedded grammars).
  // Cache rejection too: a coloring failure must not cause automatic initialization retries.
  return highlighter ??= createHighlighterCore({
    langs: [javascript, jsx, typescript, tsx, csharp], themes: [githubDark],
    engine: createOnigurumaEngine(getWasm),
  });
}
function language(path: string): string {
  const suffix = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (["js", "mjs", "cjs"].includes(suffix)) return "javascript";
  if (["ts", "mts", "cts"].includes(suffix)) return "typescript";
  if (suffix === "jsx" || suffix === "tsx") return suffix;
  if (suffix === "cs") return "csharp";
  throw new Error("Unsupported source coloring language");
}
const scalarBoundary = (text: string, offset: number) => !(offset > 0 && /[\uD800-\uDBFF]/u.test(text[offset - 1]!) && /[\uDC00-\uDFFF]/u.test(text[offset] ?? ""));

/** Grammar-backed presentation of a complete normalized file, never parsing or execution. */
export async function createSourceColoring(path: string, text: string): Promise<SourceColoring> {
  const lang = language(path);
  if (!text.isWellFormed() || text.includes("\r")) throw new Error("Invalid normalized source");
  const shiki = await initialize();
  // Do not silently skip long lines or truncate grammar context at a time budget.
  const lines = shiki.codeToTokensBase(text, { lang, theme: "github-dark", tokenizeMaxLineLength: 0, tokenizeTimeLimit: 0 });
  const starts: number[] = [], ends: number[] = [], colors: number[] = [];
  let offset = 0;
  for (let line = 0; line < lines.length; line++) {
    for (const token of lines[line]!) {
      const start = offset, end = start + token.content.length;
      const color = (SYNTAX_PALETTE as readonly string[]).indexOf(token.color?.toUpperCase() ?? "");
      if (color < 0 || text.slice(start, end) !== token.content || !scalarBoundary(text, start) || !scalarBoundary(text, end)) throw new Error("Invalid syntax token");
      offset = end;
      if (start === end) continue;
      const prior = starts.length - 1;
      if (prior >= 0 && ends[prior] === start && colors[prior] === color) ends[prior] = end;
      else { starts.push(start); ends.push(end); colors.push(color); }
    }
    if (line + 1 < lines.length) { if (text[offset] !== "\n") throw new Error("Invalid syntax lines"); offset++; }
  }
  if (offset !== text.length) throw new Error("Incomplete syntax tokens");
  const packedStarts = Uint32Array.from(starts), packedEnds = Uint32Array.from(ends), packedColors = Uint8Array.from(colors);
  return (start, end) => {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > text.length || !scalarBoundary(text, start) || !scalarBoundary(text, end)) throw new Error("Invalid syntax window");
    if (start === end) return [];
    const result: SyntaxSpan[] = []; let low = 0, high = packedStarts.length;
    while (low < high) { const middle = (low + high) >>> 1; if (packedEnds[middle]! <= start) low = middle + 1; else high = middle; }
    for (let index = low; index < packedStarts.length && packedStarts[index]! < end; index++) result.push({ color: packedColors[index]!, start: Math.max(start, packedStarts[index]!) - start, end: Math.min(end, packedEnds[index]!) - start });
    return result;
  };
}
