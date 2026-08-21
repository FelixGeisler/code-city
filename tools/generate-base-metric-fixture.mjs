import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

registerHooks({ resolve(specifier, context, nextResolve) { return nextResolve(/^\.\.?\//.test(specifier) && !/(?:\.[a-z]+|\?.*)$/i.test(specifier) ? `${specifier}.ts` : specifier, context); } });
const projectRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const { createTreeSitterAdapter } = await import("../src/edge/tree-sitter-adapter.ts");
const { processAdmittedBaseMetrics } = await import("../src/application/base-metric-processing.ts");
const assetPath = (relativePath) => pathToFileURL(path.join(projectRoot, ...relativePath.split("/"))).href;
const assets = { runtimeJavaScript: assetPath("node_modules/web-tree-sitter/web-tree-sitter.js"), runtimeWasm: assetPath("node_modules/web-tree-sitter/web-tree-sitter.wasm"), grammarJavaScript: assetPath("node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-javascript.wasm"), grammarTypeScript: assetPath("node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-typescript.wasm"), grammarTsx: assetPath("node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-tsx.wasm") };
const parser = createTreeSitterAdapter(assets, { loadBytes: async (url) => new Uint8Array(await readFile(fileURLToPath(url))) });

const definitions = [
  ["node-js-function", "a.js", "function f(){ return 1; }", "javascript-no-jsx"],
  ["node-jsx-comment", "a.jsx", "const x = <A>{/* c */}</A>;", "javascript-jsx"],
  ["node-ts-type-only", "a.ts", "interface X { value: string }", "typescript"],
  ["node-tsx-value", "a.tsx", "const x = <A />;", "tsx"],
  ["suffix-js", "a.js", ";", "javascript-no-jsx"], ["suffix-mjs", "a.mjs", ";", "javascript-no-jsx"], ["suffix-cjs", "a.cjs", ";", "javascript-no-jsx"],
  ["suffix-jsx", "a.jsx", "<A/>;", "javascript-jsx"], ["suffix-ts", "a.ts", "type X=string;", "typescript"], ["suffix-mts", "a.mts", "type X=string;", "typescript"], ["suffix-cts", "a.cts", "type X=string;", "typescript"], ["suffix-tsx", "a.tsx", "<A/>;", "tsx"],
  ["suffix-case-js", "A.JS", ";", "javascript-no-jsx"], ["suffix-case-mjs", "A.MJS", ";", "javascript-no-jsx"], ["suffix-case-cjs", "A.CJS", ";", "javascript-no-jsx"], ["suffix-case-jsx", "A.JSX", "<A/>;", "javascript-jsx"],
  ["suffix-case-ts", "A.TS", "type X=string;", "typescript"], ["suffix-case-mts", "A.MTS", "type X=string;", "typescript"], ["suffix-case-cts", "A.CTS", "type X=string;", "typescript"], ["suffix-case-tsx", "A.TSX", "<A/>;", "tsx"],

  ["sloc-empty", "s.js", "", "javascript-no-jsx"], ["sloc-whitespace", "s.js", " \t\n\n", "javascript-no-jsx"], ["sloc-line-comment", "s.js", "// only\n", "javascript-no-jsx"], ["sloc-block-comment", "s.js", "/* only\n * still */\n", "javascript-no-jsx"],
  ["sloc-jsdoc", "s.js", "/** docs */\n", "javascript-no-jsx"], ["sloc-triple-slash", "s.ts", "/// <reference path=\"./x.d.ts\" />\n", "typescript"], ["sloc-hashbang", "s.js", "#!/usr/bin/env node\n", "javascript-no-jsx"],
  ["sloc-leading-comment", "s.js", "/*c*/ const x=1;", "javascript-no-jsx"], ["sloc-trailing-comment", "s.js", "const x=1; //c", "javascript-no-jsx"], ["sloc-embedded-comment", "s.js", "const /*c*/ x=1;", "javascript-no-jsx"],
  ["sloc-string-comment-text", "s.js", "const x='/* source */';", "javascript-no-jsx"], ["sloc-template-comment-text", "s.js", "const x=`// source`;", "javascript-no-jsx"], ["sloc-regex-comment-text", "s.js", "const x=/\\/\\*/;", "javascript-no-jsx"],
  ["sloc-template-blank-lines", "s.js", "const x=`\n\nvalue\n`;", "javascript-no-jsx"], ["sloc-jsx-text-comment-looking", "s.jsx", "<A>/* source */</A>;", "javascript-jsx"], ["sloc-jsx-blank-lines", "s.jsx", "<>\n\n text\n</>;", "javascript-jsx"],
  ["sloc-jsx-comment-wrapper", "s.jsx", "<A>\n {/* only */}\n</A>;", "javascript-jsx"], ["sloc-typescript-source", "s.ts", "interface T {\n x: string;\n}", "typescript"],

  ["unit-function-declaration", "u.js", "function f(){}", "javascript-no-jsx"], ["unit-function-expression", "u.js", "const f=function(){};", "javascript-no-jsx"], ["unit-generator-function", "u.js", "function* f(){}", "javascript-no-jsx"], ["unit-async-function", "u.js", "async function f(){}", "javascript-no-jsx"], ["unit-exported-function", "u.js", "export default function f(){}", "javascript-no-jsx"],
  ["unit-arrow-concise-unparenthesized", "u.js", "const f = x => x;", "javascript-no-jsx"], ["unit-arrow-block", "u.js", "const f=(x)=>{};", "javascript-no-jsx"], ["unit-async-arrow", "u.js", "const f=async x=>x;", "javascript-no-jsx"],
  ["unit-object-method", "u.js", "const x={m(){}};", "javascript-no-jsx"], ["unit-class-method", "u.js", "class C { m(){} }", "javascript-no-jsx"], ["unit-constructor", "u.js", "class C { constructor(){} }", "javascript-no-jsx"], ["unit-getter", "u.js", "class C { get x(){return 1} }", "javascript-no-jsx"], ["unit-setter", "u.js", "class C { set x(v){} }", "javascript-no-jsx"], ["unit-static-block", "u.js", "class C { static { ; } }", "javascript-no-jsx"],
  ["unit-modifiers", "u.ts", "export abstract class C { static #m(){} protected async *n(){} }", "typescript"], ["unit-decorator-span", "u.ts", "class C { @d m(){} }", "typescript"], ["unit-computed-name", "u.js", "class C { [x&&y](){} }", "javascript-no-jsx"], ["unit-field-arrow", "u.js", "class C { x=()=>1; }", "javascript-no-jsx"], ["unit-field-function", "u.js", "class C { x=function(){}; }", "javascript-no-jsx"],
  ["unit-nested-order", "u.js", "function outer(a=()=>0){ return function inner(){ return ()=>1; }; }", "javascript-no-jsx"],

  ["bodyless-overload", "z.ts", "function f(x:string):void; function f(x:number):void;", "typescript"], ["bodyless-declare-function", "z.ts", "declare function f():void;", "typescript"], ["bodyless-ambient-class", "z.ts", "declare class C { m():void; get x():number; }", "typescript"],
  ["bodyless-abstract-method", "z.ts", "abstract class C { abstract m():void; }", "typescript"], ["bodyless-interface-method", "z.ts", "interface C { m():void; ():void; new():C; }", "typescript"], ["bodyless-implicit-constructor", "z.ts", "class C {}", "typescript"],
  ["ambient-enum", "z.ts", "declare enum E { A }", "typescript"], ["ambient-namespace", "z.ts", "declare namespace N { interface X {} }", "typescript"], ["ambient-nested-runtime-shapes", "z.ts", "declare namespace N { enum E { A } class C { m():void } const x:number; }", "typescript"],

  ["top-level-empty-statement", "t.js", ";", "javascript-no-jsx"], ["top-level-function", "t.js", "function f(){}", "javascript-no-jsx"], ["top-level-value", "t.js", "const x=1;", "javascript-no-jsx"], ["top-level-type-only", "t.ts", "interface X{} type Y=X;", "typescript"],
  ["top-level-import-type", "t.ts", "import type {A} from 'm';", "typescript"], ["top-level-export-type", "t.ts", "export type {A};", "typescript"],
  ["top-level-import-all-type-trivia", "t.ts", "import { type A, /*x*/ type B, } from 'm';", "typescript"], ["top-level-export-all-type-trivia", "t.ts", "export { type A, /*x*/ type B, };", "typescript"],
  ["top-level-import-mixed", "t.ts", "import { type A, B } from 'm';", "typescript"], ["top-level-export-mixed", "t.ts", "export { type A, B };", "typescript"], ["top-level-side-effect-import", "t.ts", "import 'm';", "typescript"],
  ["top-level-export-empty", "t.ts", "export {};", "typescript"], ["top-level-export-empty-trivia", "t.ts", "export { /* empty */ }; // trailing\n", "typescript"],
  ["top-level-export-local-value", "t.ts", "export { value };", "typescript"], ["top-level-export-empty-reexport", "t.ts", "export {} from 'm';", "typescript"], ["top-level-export-value-reexport", "t.ts", "export { value } from 'm';", "typescript"],
  ["top-level-runtime-enum", "t.ts", "enum E { A }", "typescript"], ["top-level-runtime-namespace", "t.ts", "namespace N { export const x=1 }", "typescript"], ["top-level-ambient", "t.ts", "declare const x:number;", "typescript"], ["top-level-jsx", "t.tsx", "<A/>;", "tsx"], ["top-level-type-and-value-mixed", "t.ts", "interface X{} const x=1;", "typescript"],

  ["decisions-all", "d.ts", "function f(){if(a){}else if(b){} for(;;){} for(x in y){} for(x of y){} for await(x of y){} while(a){} do{}while(a); switch(x){case 1:break;default:break} try{}catch{} a?b:c; a&&b; a||b; a??b; a&&=b; a||=b; a??=b;}", "typescript"],
  ["decisions-exclusions", "d.ts", "function f(a=x){ if(a){}else{} switch(a){default:break} try{}finally{} obj?.x; !a; a===b; a&b; return; throw a; break; continue; g(); await g(); yield a; const x=a!; }", "typescript"],
  ["canonical-src-a", "src/a.js", "function f(a = x && y) {\n  if (a) return () => a ?? y;\n  return a;\n}", "javascript-no-jsx"],
  ["ownership-parameter-and-nested", "d.js", "function f(a=x&&y){ if(a) return ()=>a??y; }", "javascript-no-jsx"], ["ownership-field-and-computed", "d.js", "class C extends (a?B:C) { [x&&y](){return ()=>z||q} field=p??q; }", "javascript-no-jsx"],
  ["identity-order-astral", "i.js", "const s='😀'; function f(a='🚀'){ return ()=>a; }", "javascript-no-jsx"], ["identity-order-same-start-nesting", "i.js", "const f=(function(){return ()=>1});", "javascript-no-jsx"],

  ["contextual-top-return", "c.js", "return 1;", "javascript-no-jsx"], ["contextual-top-break", "c.js", "break;", "javascript-no-jsx"], ["contextual-top-continue", "c.js", "continue;", "javascript-no-jsx"], ["contextual-import-defer-rejected", "c.ts", "import defer * as x from 'm';", "typescript"],
  ["malformed-javascript", "bad.js", "function {", "javascript-no-jsx"], ["malformed-jsx", "bad.jsx", "const x=<A>", "javascript-jsx"], ["malformed-typescript", "bad.ts", "interface {", "typescript"], ["malformed-tsx", "bad.tsx", "const x=<A>", "tsx"], ["missing-recovery", "missing.ts", "const x =", "typescript"], ["forbidden-jsx-js", "forbidden.js", "const x=<A/>;", "javascript-no-jsx"], ["typescript-in-javascript", "bad.js", "interface X{}", "javascript-no-jsx"],
  ["nonfailure-type-diagnostic", "ok.ts", "const x: Missing = value;", "typescript"], ["nonfailure-unresolved-import", "ok.ts", "import x from 'not-resolved';", "typescript"],
  ["nonexecution-sentinel", "sentinel.js", "globalThis.__codeCitySentinel=(globalThis.__codeCitySentinel??0)+1; throw new Error('executed');", "javascript-no-jsx"],
];

const cases = [];
for (const [id, canonicalPath, source, grammarFamily] of definitions) {
  const result = await processAdmittedBaseMetrics([{ canonicalPath, normalizedSource: source }], parser);
  if (result.kind === "failure") { cases.push({ id, canonicalPath, source, grammarFamily, expectedOutcome: { kind: "failure", category: result.category, code: result.code } }); continue; }
  const analysis = result.analyses[0];
  const expected = { S: analysis.S, U: analysis.U, units: [...analysis.units], observations: [...analysis.observations] };
  const digest = createHash("sha256").update(JSON.stringify(expected)).digest("hex");
  cases.push({ id, canonicalPath, source, grammarFamily, expectedOutcome: { kind: "processed", ...expected, digest } });
}
const fixture = { schemaVersion: 1, cases };
const output = path.join(projectRoot, "test", "fixtures", "base-metric-cases.json");
await writeFile(output, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
console.log(`Wrote ${cases.length} complete base metric cases to ${path.relative(projectRoot, output)}.`);
