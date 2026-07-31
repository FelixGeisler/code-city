import type { ExecutableUnitMetric } from "./types.js";

interface Token {
  readonly value: string;
  readonly line: number;
  readonly index: number;
}

interface UnitRange {
  readonly name: string;
  readonly line: number;
  readonly start: number;
  readonly end: number;
}

export interface CSharpLexicalResult {
  readonly sloc: number;
  readonly decisionLoad: number;
  readonly maximumComplexity: number;
  readonly executableUnitCount: number;
  readonly units: readonly ExecutableUnitMetric[];
}

const CONTROL_PARENTS = new Set([
  "if",
  "for",
  "foreach",
  "while",
  "switch",
  "catch",
  "using",
  "lock",
  "fixed",
  "base",
  "this",
]);

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/u;

function tokenize(source: string): readonly Token[] {
  const tokens: Token[] = [];
  let offset = 0;
  let line = 1;

  function advance(count = 1): void {
    for (let index = 0; index < count; index += 1) {
      if (source[offset] === "\n") line += 1;
      offset += 1;
    }
  }

  function skipQuoted(quote: "'" | '"', verbatim: boolean): void {
    advance();
    while (offset < source.length) {
      const current = source[offset];
      if (current === quote) {
        if (verbatim && source[offset + 1] === quote) {
          advance(2);
          continue;
        }
        advance();
        return;
      }
      if (!verbatim && current === "\\") {
        advance(Math.min(2, source.length - offset));
      } else {
        advance();
      }
    }
  }

  while (offset < source.length) {
    const current = source[offset]!;
    const next = source[offset + 1];
    if (/\s/u.test(current)) {
      advance();
      continue;
    }
    if (current === "/" && next === "/") {
      while (offset < source.length && source[offset] !== "\n") advance();
      continue;
    }
    if (current === "/" && next === "*") {
      advance(2);
      while (
        offset < source.length &&
        !(source[offset] === "*" && source[offset + 1] === "/")
      ) {
        advance();
      }
      if (offset < source.length) advance(2);
      continue;
    }

    // Raw string literals. Counting quote length precisely is unnecessary for
    // lexical metrics; terminate at the next triple quote.
    if (source.startsWith('"""', offset)) {
      advance(3);
      while (offset < source.length && !source.startsWith('"""', offset)) {
        advance();
      }
      if (offset < source.length) advance(3);
      continue;
    }
    if (
      current === '"' ||
      current === "'" ||
      (current === "@" && next === '"')
    ) {
      if (current === "@") advance();
      skipQuoted(current === "'" ? "'" : '"', current === "@");
      continue;
    }

    const tokenLine = line;
    const tokenIndex = tokens.length;
    if (/[A-Za-z_]/u.test(current)) {
      const start = offset;
      advance();
      while (offset < source.length && /[A-Za-z0-9_]/u.test(source[offset]!)) {
        advance();
      }
      tokens.push({ value: source.slice(start, offset), line: tokenLine, index: tokenIndex });
      continue;
    }
    if (/[0-9]/u.test(current)) {
      const start = offset;
      advance();
      while (offset < source.length && /[A-Za-z0-9_.]/u.test(source[offset]!)) {
        advance();
      }
      tokens.push({ value: source.slice(start, offset), line: tokenLine, index: tokenIndex });
      continue;
    }

    const compound = [
      "??=",
      "=>",
      "&&",
      "||",
      "??",
      "?.",
      "::",
      "==",
      "!=",
      "<=",
      ">=",
      "++",
      "--",
    ].find((candidate) => source.startsWith(candidate, offset));
    if (compound) {
      tokens.push({ value: compound, line: tokenLine, index: tokenIndex });
      advance(compound.length);
    } else {
      tokens.push({ value: current, line: tokenLine, index: tokenIndex });
      advance();
    }
  }
  return tokens;
}

function matchingPairs(
  tokens: readonly Token[],
  open: string,
  close: string,
): ReadonlyMap<number, number> {
  const stack: number[] = [];
  const pairs = new Map<number, number>();
  for (const token of tokens) {
    if (token.value === open) stack.push(token.index);
    if (token.value === close) {
      const opening = stack.pop();
      if (opening !== undefined) {
        pairs.set(opening, token.index);
        pairs.set(token.index, opening);
      }
    }
  }
  return pairs;
}

function callableNameBeforeParenthesis(
  tokens: readonly Token[],
  leftParenthesis: number,
): Token | undefined {
  let cursor = leftParenthesis - 1;
  if (tokens[cursor]?.value === ">") {
    let depth = 0;
    for (; cursor >= 0; cursor -= 1) {
      const value = tokens[cursor]!.value;
      if (value === ">") depth += 1;
      if (value === "<") {
        depth -= 1;
        if (depth === 0) {
          cursor -= 1;
          break;
        }
      }
    }
  }

  const candidate = tokens[cursor];
  const beforeCandidate = tokens[cursor - 1];
  if (
    !candidate ||
    !IDENTIFIER.test(candidate.value) ||
    CONTROL_PARENTS.has(candidate.value) ||
    beforeCandidate?.value === "new"
  ) {
    return undefined;
  }
  return candidate;
}

function callableBeforeClosingParenthesis(
  tokens: readonly Token[],
  closingParenthesis: number,
  parentheses: ReadonlyMap<number, number>,
): Token | undefined {
  const leftParenthesis = parentheses.get(closingParenthesis);
  if (leftParenthesis === undefined) return undefined;
  const direct = callableNameBeforeParenthesis(tokens, leftParenthesis);
  if (direct) return direct;

  const initializer = tokens[leftParenthesis - 1]?.value;
  if (
    (initializer === "base" || initializer === "this") &&
    tokens[leftParenthesis - 2]?.value === ":"
  ) {
    const constructorClose = tokens[leftParenthesis - 3];
    if (constructorClose?.value === ")") {
      return callableBeforeClosingParenthesis(
        tokens,
        constructorClose.index,
        parentheses,
      );
    }
  }
  return undefined;
}

function switchExpressionArrows(
  tokens: readonly Token[],
  braces: ReadonlyMap<number, number>,
): ReadonlySet<number> {
  const arrows = new Set<number>();
  for (const token of tokens) {
    if (
      token.value !== "switch" ||
      tokens[token.index + 1]?.value !== "{"
    ) {
      continue;
    }
    const opening = token.index + 1;
    const closing = braces.get(opening);
    if (closing === undefined) continue;

    let braceDepth = 0;
    let parenthesisDepth = 0;
    let bracketDepth = 0;
    for (let cursor = opening + 1; cursor < closing; cursor += 1) {
      const value = tokens[cursor]!.value;
      if (value === "{") braceDepth += 1;
      else if (value === "}") braceDepth -= 1;
      else if (value === "(") parenthesisDepth += 1;
      else if (value === ")") parenthesisDepth -= 1;
      else if (value === "[") bracketDepth += 1;
      else if (value === "]") bracketDepth -= 1;
      else if (
        value === "=>" &&
        braceDepth === 0 &&
        parenthesisDepth === 0 &&
        bracketDepth === 0
      ) {
        // A lone discard pattern is the switch-expression equivalent of
        // `default` and therefore does not add a decision.
        if (tokens[cursor - 1]?.value !== "_") arrows.add(cursor);
      }
    }
  }
  return arrows;
}

function expressionBodyEnd(
  tokens: readonly Token[],
  arrowIndex: number,
): number {
  let parentheses = 0;
  let brackets = 0;
  let braces = 0;
  for (let cursor = arrowIndex + 1; cursor < tokens.length; cursor += 1) {
    const value = tokens[cursor]!.value;
    if (value === "(") parentheses += 1;
    else if (value === ")") {
      if (parentheses === 0 && brackets === 0 && braces === 0) return cursor;
      parentheses -= 1;
    } else if (value === "[") brackets += 1;
    else if (value === "]") brackets -= 1;
    else if (value === "{") braces += 1;
    else if (value === "}") {
      if (braces === 0 && parentheses === 0 && brackets === 0) return cursor;
      braces -= 1;
    } else if (
      (value === ";" || value === ",") &&
      parentheses === 0 &&
      brackets === 0 &&
      braces === 0
    ) {
      return cursor;
    }
  }
  return tokens.length;
}

function findCallableRanges(
  tokens: readonly Token[],
): {
  readonly ranges: readonly UnitRange[];
  readonly switchArrows: ReadonlySet<number>;
} {
  const parentheses = matchingPairs(tokens, "(", ")");
  const braces = matchingPairs(tokens, "{", "}");
  const switchArrows = switchExpressionArrows(tokens, braces);
  const ranges: UnitRange[] = [];

  for (const opening of tokens) {
    if (opening.value !== "{") continue;
    const closing = braces.get(opening.index);
    if (closing === undefined) continue;
    const previous = tokens[opening.index - 1];
    if (!previous) continue;

    let name: string | undefined;
    let nameToken: Token | undefined;
    if (previous.value === ")") {
      nameToken = callableBeforeClosingParenthesis(
        tokens,
        previous.index,
        parentheses,
      );
      name = nameToken?.value;
    } else if (["get", "set", "init", "add", "remove"].includes(previous.value)) {
      name = previous.value;
    } else if (previous.value === "=>") {
      name = "<lambda>";
    } else if (previous.value === "delegate") {
      name = "<anonymous>";
    }

    if (name) {
      ranges.push({
        name,
        line: opening.line,
        start: opening.index,
        end: closing,
      });
    }
  }

  for (const arrow of tokens) {
    if (
      arrow.value !== "=>" ||
      switchArrows.has(arrow.index) ||
      tokens[arrow.index + 1]?.value === "{"
    ) {
      continue;
    }

    const previous = tokens[arrow.index - 1];
    if (!previous) continue;
    let name: string | undefined;
    let line = arrow.line;
    if (previous.value === ")") {
      const candidate = callableBeforeClosingParenthesis(
        tokens,
        previous.index,
        parentheses,
      );
      if (candidate) {
        name = candidate.value;
        line = candidate.line;
      }
    } else if (IDENTIFIER.test(previous.value)) {
      const before = tokens[arrow.index - 2]?.value;
      const memberLike =
        before !== undefined &&
        !["=", "(", ",", "return", "{", "}", "=>"].includes(before);
      name = memberLike ? previous.value : "<lambda>";
      line = previous.line;
    }
    if (!name) continue;

    ranges.push({
      name,
      line,
      start: arrow.index,
      end: expressionBodyEnd(tokens, arrow.index),
    });
  }

  return { ranges, switchArrows };
}

function looksLikeNullableDeclaration(
  tokens: readonly Token[],
  index: number,
): boolean {
  const next = tokens[index + 1];
  if (!next) return false;

  if (next.value === "[") {
    return tokens[index + 2]?.value === "]" &&
      IDENTIFIER.test(tokens[index + 3]?.value ?? "");
  }
  if (!IDENTIFIER.test(next.value)) return false;

  let afterNameIndex = index + 2;
  if (tokens[afterNameIndex]?.value === "<") {
    let genericDepth = 0;
    for (
      let cursor = afterNameIndex;
      cursor < tokens.length;
      cursor += 1
    ) {
      const value = tokens[cursor]!.value;
      if (value === "<") genericDepth += 1;
      if (value === ">") {
        genericDepth -= 1;
        if (genericDepth === 0) {
          afterNameIndex = cursor + 1;
          break;
        }
      }
    }
  }
  const afterName = tokens[afterNameIndex]?.value;
  if (
    afterName !== undefined &&
    ["=", ";", ",", ")", "{", "[", "]"].includes(afterName)
  ) {
    return true;
  }
  if (afterName !== "(") return false;

  let depth = 0;
  for (let cursor = afterNameIndex; cursor < tokens.length; cursor += 1) {
    const value = tokens[cursor]!.value;
    if (value === "(") depth += 1;
    if (value === ")") {
      depth -= 1;
      if (depth === 0) {
        return ["=>", "{", "where", ";"].includes(
          tokens[cursor + 1]?.value ?? "",
        );
      }
    }
  }
  return false;
}

function isTernaryQuestion(tokens: readonly Token[], index: number): boolean {
  if (tokens[index]?.value !== "?") return false;
  const previous = tokens[index - 1]?.value;
  if (!previous || ["?", ".", ":", ","].includes(previous)) return false;
  if (looksLikeNullableDeclaration(tokens, index)) return false;

  let parentheses = 0;
  let brackets = 0;
  for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
    const value = tokens[cursor]!.value;
    if (value === "(") parentheses += 1;
    else if (value === ")") parentheses -= 1;
    else if (value === "[") brackets += 1;
    else if (value === "]") brackets -= 1;
    else if (value === ":" && parentheses === 0 && brackets === 0) return true;
    else if ([";", "{", "}"].includes(value) && parentheses === 0 && brackets === 0) {
      return false;
    }
  }
  return false;
}

function isDecision(
  tokens: readonly Token[],
  index: number,
  switchArrows: ReadonlySet<number>,
): boolean {
  const value = tokens[index]?.value;
  if (!value) return false;
  if (value === "=>" && switchArrows.has(index)) return true;
  if (
    ["if", "for", "foreach", "while", "do", "catch", "case", "when"].includes(
      value,
    )
  ) {
    return true;
  }
  if (
    value === "&&" ||
    value === "||" ||
    value === "??" ||
    value === "??="
  ) {
    return true;
  }
  if (value === "and" || value === "or") {
    // This is deliberately lexical: `and` and `or` are counted only when an
    // `is`/`case` pattern appears earlier in the same statement.
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      const earlier = tokens[cursor]!.value;
      if (earlier === "is" || earlier === "case") return true;
      if (earlier === ";" || earlier === "{" || earlier === "}") return false;
    }
  }
  return value === "?" && isTernaryQuestion(tokens, index);
}

/**
 * Safe first-slice C# metrics. This scanner never loads a project or executes
 * repository code. It is intentionally labelled lexical and can be replaced by
 * a Roslyn front end without changing the shared model.
 */
export function analyzeCSharpLexically(source: string): CSharpLexicalResult {
  const tokens = tokenize(source);
  const occupiedLines = new Set(tokens.map((token) => token.line));
  const { ranges, switchArrows } = findCallableRanges(tokens);
  const decisionCounts = new Array<number>(ranges.length + 1).fill(0);

  for (const token of tokens) {
    if (!isDecision(tokens, token.index, switchArrows)) continue;
    let selected = -1;
    let selectedWidth = Number.POSITIVE_INFINITY;
    for (let index = 0; index < ranges.length; index += 1) {
      const range = ranges[index]!;
      if (token.index > range.start && token.index < range.end) {
        const width = range.end - range.start;
        if (width < selectedWidth) {
          selected = index;
          selectedWidth = width;
        }
      }
    }
    decisionCounts[selected + 1] = (decisionCounts[selected + 1] ?? 0) + 1;
  }

  const units: ExecutableUnitMetric[] = [
    {
      name: "<top-level>",
      line: 1,
      endLine: Math.max(1, source.split(/\r\n?|\n/u).length),
      complexity: 1 + (decisionCounts[0] ?? 0),
    },
    ...ranges.map((range, index) => ({
      name: range.name,
      line: range.line,
      endLine: tokens[Math.min(range.end, tokens.length - 1)]?.line ??
        range.line,
      complexity: 1 + (decisionCounts[index + 1] ?? 0),
    })),
  ].sort(
    (left, right) =>
      left.line - right.line ||
      left.name.localeCompare(right.name, "en-US") ||
      left.complexity - right.complexity,
  );
  const decisionLoad = units.reduce(
    (total, unit) => total + unit.complexity - 1,
    0,
  );

  return {
    sloc: occupiedLines.size,
    decisionLoad,
    maximumComplexity: Math.max(...units.map((unit) => unit.complexity)),
    executableUnitCount: units.length,
    units,
  };
}
