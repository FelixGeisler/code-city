import { PrintGeometryValidationError } from "./validate.js";

const THREE_BY_FIVE_FONT: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    "?": Object.freeze(["111", "001", "011", "000", "010"]),
    "-": Object.freeze(["000", "000", "111", "000", "000"]),
    ".": Object.freeze(["000", "000", "000", "000", "010"]),
    _: Object.freeze(["000", "000", "000", "000", "111"]),
    "0": Object.freeze(["111", "101", "101", "101", "111"]),
    "1": Object.freeze(["010", "110", "010", "010", "111"]),
    "2": Object.freeze(["111", "001", "111", "100", "111"]),
    "3": Object.freeze(["111", "001", "111", "001", "111"]),
    "4": Object.freeze(["101", "101", "111", "001", "001"]),
    "5": Object.freeze(["111", "100", "111", "001", "111"]),
    "6": Object.freeze(["111", "100", "111", "101", "111"]),
    "7": Object.freeze(["111", "001", "010", "010", "010"]),
    "8": Object.freeze(["111", "101", "111", "101", "111"]),
    "9": Object.freeze(["111", "101", "111", "001", "111"]),
    A: Object.freeze(["010", "101", "111", "101", "101"]),
    B: Object.freeze(["110", "101", "110", "101", "110"]),
    C: Object.freeze(["111", "100", "100", "100", "111"]),
    D: Object.freeze(["110", "101", "101", "101", "110"]),
    E: Object.freeze(["111", "100", "110", "100", "111"]),
    F: Object.freeze(["111", "100", "110", "100", "100"]),
    G: Object.freeze(["111", "100", "101", "101", "111"]),
    H: Object.freeze(["101", "101", "111", "101", "101"]),
    I: Object.freeze(["111", "010", "010", "010", "111"]),
    J: Object.freeze(["001", "001", "001", "101", "111"]),
    K: Object.freeze(["101", "101", "110", "101", "101"]),
    L: Object.freeze(["100", "100", "100", "100", "111"]),
    M: Object.freeze(["101", "111", "111", "101", "101"]),
    N: Object.freeze(["101", "111", "111", "111", "101"]),
    O: Object.freeze(["111", "101", "101", "101", "111"]),
    P: Object.freeze(["110", "101", "110", "100", "100"]),
    Q: Object.freeze(["111", "101", "101", "111", "001"]),
    R: Object.freeze(["110", "101", "110", "101", "101"]),
    S: Object.freeze(["111", "100", "111", "001", "111"]),
    T: Object.freeze(["111", "010", "010", "010", "010"]),
    U: Object.freeze(["101", "101", "101", "101", "111"]),
    V: Object.freeze(["101", "101", "101", "101", "010"]),
    W: Object.freeze(["101", "101", "111", "111", "101"]),
    X: Object.freeze(["101", "101", "010", "101", "101"]),
    Y: Object.freeze(["101", "101", "010", "010", "010"]),
    Z: Object.freeze(["111", "001", "010", "100", "111"]),
  });

export interface PrintableGlyphCell {
  readonly characterIndex: number;
  readonly row: number;
  readonly column: number;
  /** Horizontal offset from the text origin. */
  readonly u: number;
  /** Vertical offset from the text origin. */
  readonly v: number;
}

export function printableGlyphPattern(
  character: string,
): readonly string[] | undefined {
  if (character === " ") return undefined;
  const pattern = THREE_BY_FIVE_FONT[character];
  if (!pattern) {
    throw new PrintGeometryValidationError([
      `Printable text contains unsupported character '${character}'. Use A-Z, 0-9, space, '.', '-', '_', or '?'.`,
    ]);
  }
  return pattern;
}

export function validatePrintableText(text: string): void {
  for (const character of text) {
    printableGlyphPattern(character);
  }
}

export function printableTextSupported(text: string): boolean {
  try {
    validatePrintableText(text);
    return true;
  } catch {
    return false;
  }
}

export function printableTextWidth(
  text: string,
  featureSize: number,
): number {
  let width = 0;
  const characters = [...text];
  characters.forEach((character, index) => {
    width += character === " " ? featureSize * 2 : featureSize * 3;
    if (index < characters.length - 1 && character !== " ") {
      width += featureSize;
    }
  });
  return width;
}

export function printableTextCells(
  text: string,
  featureSize: number,
): readonly PrintableGlyphCell[] {
  const cells: PrintableGlyphCell[] = [];
  let cursor = 0;
  [...text].forEach((character, characterIndex) => {
    const pattern = printableGlyphPattern(character);
    if (!pattern) {
      cursor += featureSize * 2;
      return;
    }
    pattern.forEach((row, rowIndex) => {
      [...row].forEach((value, columnIndex) => {
        if (value !== "1") return;
        cells.push({
          characterIndex,
          row: rowIndex,
          column: columnIndex,
          u: cursor + columnIndex * featureSize,
          v: (4 - rowIndex) * featureSize,
        });
      });
    });
    cursor += featureSize * 4;
  });
  return cells;
}
