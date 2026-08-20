// @ts-expect-error Vite resolves the accepted fixed package asset URL.
import runtimeJavaScript from "web-tree-sitter?url";
// @ts-expect-error Vite resolves the accepted fixed package asset URL.
import runtimeWasm from "web-tree-sitter/web-tree-sitter.wasm?url";
// @ts-expect-error Vite resolves the accepted fixed package asset URL.
import grammarJavaScript from "@vscode/tree-sitter-wasm/wasm/tree-sitter-javascript.wasm?url";
// @ts-expect-error Vite resolves the accepted fixed package asset URL.
import grammarTypeScript from "@vscode/tree-sitter-wasm/wasm/tree-sitter-typescript.wasm?url";
// @ts-expect-error Vite resolves the accepted fixed package asset URL.
import grammarTsx from "@vscode/tree-sitter-wasm/wasm/tree-sitter-tsx.wasm?url";
import { createTreeSitterAdapter, type ParserAdapterOptions } from "./tree-sitter-adapter";

export const CANONICAL_PARSER_ASSET_URLS = {
  runtimeJavaScript,
  runtimeWasm,
  grammarJavaScript,
  grammarTypeScript,
  grammarTsx,
} as const;

export function createProductionTreeSitterAdapter(options?: ParserAdapterOptions) {
  return createTreeSitterAdapter(CANONICAL_PARSER_ASSET_URLS, options);
}
