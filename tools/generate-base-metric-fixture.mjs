import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(/^\.\.?\//.test(specifier) && !/(?:\.[a-z]+|\?.*)$/i.test(specifier) ? `${specifier}.ts` : specifier, context);
  },
});

const projectRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const { createTreeSitterAdapter } = await import("../src/edge/tree-sitter-adapter.ts");
const { processAdmittedBaseMetrics } = await import("../src/application/base-metric-processing.ts");

const assetPath = (relativePath) => pathToFileURL(path.join(projectRoot, ...relativePath.split("/"))).href;
const assets = {
  runtimeJavaScript: assetPath("node_modules/web-tree-sitter/web-tree-sitter.js"),
  runtimeWasm: assetPath("node_modules/web-tree-sitter/web-tree-sitter.wasm"),
  grammarJavaScript: assetPath("node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-javascript.wasm"),
  grammarTypeScript: assetPath("node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-typescript.wasm"),
  grammarTsx: assetPath("node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-tsx.wasm"),
};
const parser = createTreeSitterAdapter(assets, {
  loadBytes: async (url) => new Uint8Array(await readFile(fileURLToPath(url))),
});

const definitions = [
  ["node-js-function", "a.js", "function f(){ return 1; }", "javascript-no-jsx"],
  ["node-jsx-comment", "a.jsx", "const x = <A>{/* c */}</A>;", "javascript-jsx"],
  ["node-ts-type-only", "a.ts", "interface X { value: string }", "typescript"],
  ["node-tsx-value", "a.tsx", "const x = <A />;", "tsx"],
  ["suffix-mjs", "a.mjs", "export const x = 1;", "javascript-no-jsx"],
  ["suffix-cjs", "a.cjs", "module.exports = 1;", "javascript-no-jsx"],
  ["suffix-mts", "a.mts", "export type X = string;", "typescript"],
  ["suffix-cts", "a.cts", "enum X { A }", "typescript"],
  ["suffix-ascii-case", "A.JS", ";", "javascript-no-jsx"],
  ["all-explicit-forms", "forms.js", "function f(){}; const a=(x)=>x; class C { constructor(){} get x(){return 1} set x(v){} m(){} static { ; } }", "javascript-no-jsx"],
  ["nested-unit-order", "nested.js", "function outer(){ return function inner(){ return ()=>1; }; }", "javascript-no-jsx"],
  ["sloc-comments-and-literals", "sloc.js", "// only\nconst a='/* source */'; // tail\nconst r=/\\/\\*/;\n`\nvalue`;\n/* block\nonly */\n", "javascript-no-jsx"],
  ["zero-empty", "empty.ts", "", "typescript"],
  ["zero-comment", "comment.js", "// x\n/* y */\n", "javascript-no-jsx"],
  ["zero-types", "types.d.ts", "interface T {}\nexport type U = T;\nexport {};", "typescript"],
  ["top-level-empty-statement", "empty-statement.js", ";", "javascript-no-jsx"],
  ["astral-offsets", "astral.js", "const s='😀'; function f(a='🚀'){ return a; }", "javascript-no-jsx"],
  ["decisions", "decisions.ts", "if(a&&b) for(;;) { x ??= y; } switch(x){case 1:break;default:break} try{}catch{} const z=a?b:c;", "typescript"],
  ["jsx-comment-wrapper", "comment.jsx", "<A>\n  {/* only */}\n  text\n</A>;", "javascript-jsx"],
  ["jsx-empty-wrapper-source", "empty-wrapper.jsx", "<A>{}</A>;", "javascript-jsx"],
  ["top-return-contextual", "return.js", "return 1;", "javascript-no-jsx"],
  ["top-break-contextual", "break.js", "break;", "javascript-no-jsx"],
  ["typescript-contextual", "context.ts", "const x = <number>1; namespace N { export const y=1 }", "typescript"],
  ["malformed-javascript", "bad.js", "function {", "javascript-no-jsx"],
  ["malformed-jsx", "bad.jsx", "const x=<A>", "javascript-jsx"],
  ["malformed-typescript", "bad.ts", "interface {", "typescript"],
  ["malformed-tsx", "bad.tsx", "const x=<A>", "tsx"],
  ["missing-recovery", "missing.ts", "const x =", "typescript"],
  ["forbidden-jsx-js", "forbidden.js", "const x=<A/>;", "javascript-no-jsx"],
];

const cases = [];
for (const [id, canonicalPath, source, grammarFamily] of definitions) {
  const result = await processAdmittedBaseMetrics([{ canonicalPath, normalizedSource: source }], parser);
  if (result.kind === "failure") {
    cases.push({ id, canonicalPath, source, grammarFamily, expectedOutcome: { kind: "failure", category: result.category, code: result.code } });
    continue;
  }
  const analysis = result.analyses[0];
  const expected = {
    S: analysis.S,
    U: analysis.U,
    units: analysis.units,
    observations: analysis.observations,
  };
  const digest = createHash("sha256").update(JSON.stringify(expected)).digest("hex");
  cases.push({ id, canonicalPath, source, grammarFamily, expectedOutcome: { kind: "processed", ...expected, digest } });
}

const fixture = { schemaVersion: 1, cases };
const output = path.join(projectRoot, "test", "fixtures", "base-metric-cases.json");
await writeFile(output, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
console.log(`Wrote ${cases.length} complete base metric cases to ${path.relative(projectRoot, output)}.`);
