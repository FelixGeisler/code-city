/** Fixed pinned github-dark foregrounds; replies select an index, never arbitrary CSS. */
export const SYNTAX_PALETTE = ["#E1E4E8", "#6A737D", "#79B8FF", "#B392F0", "#85E89D", "#F97583", "#9ECBFF", "#FFAB70", "#FDAEB7", "#24292E", "#DBEDFF", "#2F363D", "#D1D5DA"] as const;
export type SyntaxSpan = Readonly<{ color: number; start: number; end: number }>;
export type SourceColoring = (start: number, end: number) => readonly SyntaxSpan[];
export type SourceColoringProvider = (path: string, text: string) => Promise<SourceColoring>;
export const unavailableSourceColoring: SourceColoringProvider = async () => { throw new Error("Syntax coloring unavailable"); };
