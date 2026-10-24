import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createTreeSitterAdapter, type ParserAdapterOptions } from "../tree-sitter-adapter";

export const NODE_PARSER_ASSET_URLS = Object.freeze({
  runtimeJavaScript: import.meta.resolve("web-tree-sitter"),
  runtimeWasm: import.meta.resolve("web-tree-sitter/web-tree-sitter.wasm"),
  grammarJavaScript: import.meta.resolve("@vscode/tree-sitter-wasm/wasm/tree-sitter-javascript.wasm"),
  grammarTypeScript: new URL("../../../vendor/tree-sitter-typescript/wasm/tree-sitter-typescript.wasm", import.meta.url).href,
  grammarTsx: new URL("../../../vendor/tree-sitter-typescript/wasm/tree-sitter-tsx.wasm", import.meta.url).href,
  grammarCSharp: import.meta.resolve("@vscode/tree-sitter-wasm/wasm/tree-sitter-c-sharp.wasm"),
});

export function createNodeTreeSitterAdapter(options: ParserAdapterOptions = {}) {
  return createTreeSitterAdapter(NODE_PARSER_ASSET_URLS, {
    importRuntime: options.importRuntime,
    loadBytes: options.loadBytes ?? (async (url) => new Uint8Array(await readFile(fileURLToPath(url)))),
    observeResource: options.observeResource,
  });
}
